// Host: owns the engine state, validates every action, sends per-player views.
// The host's own UI is a normal Client attached through an in-memory loopback.
import { createState, reduce, PHASE } from '../game/engine.js';
import { viewFor } from '../game/views.js';
import { createRng } from '../util/rng.js';
import { msg, validate } from './protocol.js';
import { createLoopbackPair } from './loopback.js';
import { HostBots } from './hostbots.js';
import { isBotId, MAX_BOTS } from '../game/setup.js';
import {
  PEER_ID_PREFIX, PEER_OPTIONS, ROOM_ALPHABET, ROOM_CODE_LENGTH,
  HOST_REGISTER_RETRY_MS, RESUME_MAX_AGE_MS,
} from '../config.js';

export const SAVE_KEY = 'gigawolf.hostSave';
const BIG_ROOM = 40; // above this many players, saving and view broadcasts are throttled

export function randomRoomCode(rand = Math.random) {
  let c = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) c += ROOM_ALPHABET[Math.floor(rand() * ROOM_ALPHABET.length)];
  return c;
}

export class Host {
  /**
   * @param {object} o
   * @param {Function} o.Peer          PeerJS constructor (injected for tests)
   * @param {string}   o.hostPlayerId
   * @param {object}   [o.resume]      saved { state, rngState, roomCode }
   * @param {object}   [o.storage]     { get(key), set(key, val), remove(key) }
   * @param {Function} [o.onNarrate]   (text) => void, called for each narrated line (phones speak from views)
   * @param {Function} [o.now]
   */
  constructor({ Peer, hostPlayerId, resume = null, storage = null, onNarrate = () => {}, now = Date.now, seed, peerOptions = PEER_OPTIONS, botDelays = {} }) {
    this.Peer = Peer;
    this.hostPlayerId = hostPlayerId;
    this.storage = storage;
    this.onNarrate = onNarrate;
    this.now = now;
    this.peerOptions = peerOptions;
    this.conns = new Map();   // playerId -> conn
    this.peer = null;
    this.closed = false;
    this.rng = createRng(seed);
    this.roomCode = resume?.roomCode ?? null;
    this.state = null;
    this.bots = new HostBots(this, botDelays);
    this.lazy = { save: null, broadcast: null, savedAt: 0, sentAt: 0 }; // big rooms (bots): throttle save + views
    this.narration = null; // latest line { seq, text }, sent with every view; each phone decides whether to speak it
    if (resume) {
      this.state = resume.state;
      this.rng.setState(resume.rngState);
      this.state.players.forEach((p) => { p.connected = isBotId(p.id); }); // bots live in the host: always here
    }
  }

  // Register the PeerJS ID. New games pick a fresh code if the ID is taken.
  // Resumed games keep retrying the same ID for up to 60s (broker may hold the old one).
  async start() {
    const resuming = !!this.state;
    const deadline = this.now() + HOST_REGISTER_RETRY_MS;
    for (;;) {
      if (!resuming) this.roomCode = randomRoomCode();
      try {
        this.peer = await this._register(PEER_ID_PREFIX + this.roomCode);
        break;
      } catch (e) {
        const taken = e?.type === 'unavailable-id';
        if (resuming && taken && this.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        if (!resuming && taken) continue; // pick a new code
        throw e;
      }
    }
    if (!this.state) this.state = createState({ hostId: this.hostPlayerId, roomCode: this.roomCode });
    this._attach(this.peer);
    this._watchWake();
    this.bots.onChange(); // a resumed game with bots: get them playing again
    return this.roomCode;
  }

  _attach(peer) {
    peer.on('connection', (conn) => this._onConnection(conn));
    peer.on('error', () => {}); // post-open errors: clients retry on their own
    // A sleeping phone loses its link to the broker. Established data connections may survive,
    // but nobody new (or reconnecting) can reach us until we re-register, so do it eagerly.
    peer.on('disconnected', () => { if (peer === this.peer) this._relink(); });
    peer.on('close', () => { if (peer === this.peer) this._reclaim(); });
  }

  // Re-open the broker link, keeping our ID. Retries until it sticks.
  _relink() {
    if (this.closed || !this.peer || this.peer.destroyed) return;
    clearTimeout(this.relinkTimer);
    try { this.peer.reconnect(); } catch { /* try again below */ }
    this.relinkTimer = setTimeout(() => { if (this.peer?.disconnected) this._relink(); }, 3000);
    this.relinkTimer.unref?.();
  }

  // The peer object itself is dead: register the same room code again.
  async _reclaim() {
    if (this.closed || this.reclaiming) return;
    this.reclaiming = true;
    const deadline = this.now() + HOST_REGISTER_RETRY_MS;
    try {
      while (!this.closed && this.now() < deadline) {
        try {
          const peer = await this._register(PEER_ID_PREFIX + this.roomCode);
          if (this.closed) { try { peer.destroy(); } catch {} return; }
          this.peer = peer;
          this._attach(peer);
          this._broadcast();
          return;
        } catch { await new Promise((r) => { const t = setTimeout(r, 2000); t.unref?.(); }); }
      }
    } finally { this.reclaiming = false; }
  }

  // Called when the page wakes up: repair the broker link and push fresh views to everyone.
  recover() {
    if (this.closed || !this.peer) return;
    if (this.peer.destroyed) this._reclaim();
    else if (this.peer.disconnected) this._relink();
    this._broadcast();
  }

  _watchWake() {
    if (typeof document === 'undefined' || this._wake) return;
    this._wake = () => { if (document.visibilityState === 'visible') this.recover(); };
    document.addEventListener('visibilitychange', this._wake);
    if (typeof window !== 'undefined') window.addEventListener('online', this._wake);
  }

  _register(id) {
    return new Promise((resolve, reject) => {
      const peer = new this.Peer(id, this.peerOptions);
      const to = setTimeout(() => { try { peer.destroy(); } catch {} reject({ type: 'network', message: 'timeout' }); }, 15000);
      peer.on('open', () => { clearTimeout(to); resolve(peer); });
      peer.on('error', (e) => { clearTimeout(to); try { peer.destroy(); } catch {} reject(e); });
    });
  }

  // Connection for the host's own UI. Same code path as any remote client.
  attachLoopback() {
    const [clientSide, hostSide] = createLoopbackPair();
    this._onConnection(hostSide);
    return clientSide;
  }

  _onConnection(conn) {
    conn.playerId = null;
    conn.on('data', (data) => this._onData(conn, data));
    conn.on('close', () => this._onClose(conn));
    conn.on('error', () => this._onClose(conn));
  }

  _send(conn, obj) { try { conn.send(obj); } catch { /* closed */ } }

  _onData(conn, data) {
    if (this.closed) return;
    const bad = validate(data);
    if (bad) {
      this._send(conn, msg.error(bad === 'badVersion' ? 'badVersion' : 'badMessage',
        bad === 'badVersion' ? 'Version mismatch. Reload the page.' : 'Bad message.'));
      return;
    }
    switch (data.type) {
      case 'ping': this._send(conn, msg.pong()); return;
      case 'hello': this._onHello(conn, data); return;
      case 'action': this._onAction(conn, data); return;
    }
  }

  _onHello(conn, { playerId, name }) {
    const r = reduce(this.state, { kind: 'join', by: playerId, name, now: this.now() }, this.rng);
    if (r.error) {
      this._send(conn, msg.error(r.error.code, r.error.message));
      return;
    }
    // Is this id already the host? Only the creator may claim hostId, and it is fixed at creation.
    const old = this.conns.get(playerId);
    if (old && old !== conn) { old.playerId = null; try { old.close(); } catch {} }
    conn.playerId = playerId;
    this.conns.set(playerId, conn);
    this.state = r.state;
    this._send(conn, msg.welcome(playerId, this.roomCode, playerId === this.state.hostId));
    this._afterApply(r.effects);
  }

  _onAction(conn, data) {
    if (!conn.playerId) { this._send(conn, msg.error('noHello', 'Say hello first.')); return; }
    const action = { kind: data.kind, by: conn.playerId, now: this.now(), nonce: data.nonce };
    if (data.targetId !== undefined) action.targetId = data.targetId;
    if (data.targetId2 !== undefined) action.targetId2 = data.targetId2;
    if (data.patch) action.patch = data.patch;
    this.apply(action, conn);
  }

  _onClose(conn) {
    if (!conn.playerId || this.conns.get(conn.playerId) !== conn) return;
    this.conns.delete(conn.playerId);
    if (this.closed) return;
    const r = reduce(this.state, { kind: 'setConnected', by: conn.playerId, connected: false, now: this.now() }, this.rng);
    this.state = r.state;
    this._afterApply(r.effects);
  }

  apply(action, conn = null) {
    const r = reduce(this.state, action, this.rng);
    if (r.error) {
      if (conn) this._send(conn, msg.error(r.error.code, r.error.message));
      // Also resend the current view so the client UI can recover from a stale screen.
      if (conn?.playerId) this._sendView(conn.playerId);
      return r;
    }
    this.state = r.state;
    this._afterApply(r.effects);
    return r;
  }

  _afterApply(effects) {
    const lines = [];
    for (const e of effects) {
      if (e.type === 'narrate' && this.state.settings.narration) { lines.push(e.text); this.onNarrate(e.text); }
    }
    if (lines.length) this.narration = { seq: (this.narration?.seq ?? 0) + 1, text: lines.join(' ') };
    this.bots.onChange();
    if (this.state.players.length > BIG_ROOM) { this._lazy('save', 1000, () => this._save()); this._lazy('broadcast', 150, () => this._broadcast()); return; }
    this._save();
    this._broadcast();
  }

  // Trailing throttle for big rooms: at most one run per `ms`, always reflecting the latest state.
  _lazy(name, ms, fn) {
    const l = this.lazy;
    if (l[name]) return;
    l[name] = setTimeout(() => { l[name] = null; if (!this.closed) fn(); }, ms);
    l[name].unref?.();
  }

  // Host-only: set how many bots are in the lobby (0..MAX_BOTS).
  setBots(count) {
    const n = Math.max(0, Math.min(MAX_BOTS, Math.floor(Number(count) || 0)));
    return this.apply({ kind: 'setBots', by: this.hostPlayerId, count: n, now: this.now() });
  }

  _sendView(playerId) {
    const conn = this.conns.get(playerId);
    if (!conn) return;
    const view = viewFor(this.state, playerId);
    if (view) this._send(conn, msg.view(this.narration ? { ...view, narration: this.narration } : view));
  }

  _broadcast() { for (const id of this.conns.keys()) this._sendView(id); }

  _save() {
    if (!this.storage) return;
    this.storage.set(SAVE_KEY, {
      roomCode: this.roomCode, hostId: this.hostPlayerId,
      state: this.state, rngState: this.rng.getState(), savedAt: this.now(),
    });
  }

  close() {
    this.closed = true;
    clearTimeout(this.relinkTimer);
    this.bots.stop();
    clearTimeout(this.lazy.save); clearTimeout(this.lazy.broadcast);
    if (this._wake) {
      document.removeEventListener('visibilitychange', this._wake);
      if (typeof window !== 'undefined') window.removeEventListener('online', this._wake);
    }
    for (const c of this.conns.values()) { try { c.close(); } catch {} }
    this.conns.clear();
    try { this.peer?.destroy(); } catch {}
  }

  static loadSave(storage, now = Date.now()) {
    const s = storage?.get(SAVE_KEY);
    if (!s || !s.state || now - s.savedAt > RESUME_MAX_AGE_MS) return null;
    if (s.state.phase === PHASE.LOBBY && s.state.players.length <= 1) return null;
    return s;
  }
  static clearSave(storage) { storage?.remove(SAVE_KEY); }
}
