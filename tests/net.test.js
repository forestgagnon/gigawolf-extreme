import test from 'node:test';
import assert from 'node:assert/strict';
import { Host } from '../js/net/host.js';
import { Client, peerConnector } from '../js/net/client.js';
import { addBots } from '../js/dev/bots.js';
import { createFakeNetwork } from '../js/dev/fakepeer.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if (fn()) return; await sleep(5); }
  throw new Error('timeout waiting for condition');
};
const memStorage = () => { const m = new Map(); return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, JSON.parse(JSON.stringify(v))), remove: (k) => m.delete(k), m }; };

function mkClient(net, code, id, name, extra = {}) {
  const c = { view: null, errors: [], statuses: [] };
  c.client = new Client({
    playerId: id, name, visibilityReconnect: false, delays: [20, 20, 40], pingMs: 50, deadMs: 300,
    connector: peerConnector(net.Peer, code, {}),
    onView: (v) => { c.view = v; }, onError: (e) => c.errors.push(e), onStatus: (s) => c.statuses.push(s),
    ...extra,
  });
  return c;
}
async function mkHost(net, extra = {}) {
  const host = new Host({ Peer: net.Peer, hostPlayerId: 'hostplayer', peerOptions: {}, ...extra });
  await host.start();
  const h = { host, view: null };
  h.client = new Client({ playerId: 'hostplayer', name: 'Hosty', visibilityReconnect: false, connector: async () => host.attachLoopback(), onView: (v) => { h.view = v; } });
  h.client.start();
  await until(() => h.view);
  return h;
}

test('room code is 4 valid letters; join by code shows same live lobby', async () => {
  const net = createFakeNetwork();
  const h = await mkHost(net);
  assert.match(h.host.roomCode, /^[ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
  const a = mkClient(net, h.host.roomCode, 'player-aaaa', 'Ann'); a.client.start();
  const b = mkClient(net, h.host.roomCode, 'player-bbbb', 'Bob'); b.client.start();
  await until(() => h.view.players.length === 3 && a.view?.players.length === 3 && b.view?.players.length === 3);
  for (const v of [h.view, a.view, b.view]) assert.deepEqual(v.players.map((p) => p.name), ['Hosty', 'Ann', 'Bob']);
  assert.equal(h.view.isHost, true); assert.equal(a.view.isHost, false);
  assert.equal(a.client.status, 'connected');
  b.client.stop();
  await until(() => h.view.players[2].connected === false);
  assert.equal(a.view.players[2].connected, false);
  h.host.close();
});

test('unknown room / blocked network gives the connection error, not a hang', async () => {
  const net = createFakeNetwork();
  const c = mkClient(net, 'ZZZZ', 'player-cccc', 'Cat'); c.client.start();
  await until(() => c.errors.length);
  assert.equal(c.errors[0].code, 'unreachable');
  assert.match(c.errors[0].message, /Can't reach the host/);
  assert.equal(c.client.status, 'failed');
});

test('room code collision picks another code', async () => {
  const net = createFakeNetwork();
  const h1 = await mkHost(net, { seed: 1 });
  const h2 = new Host({ Peer: net.Peer, hostPlayerId: 'x-host-2', peerOptions: {} });
  await h2.start();
  assert.notEqual(h1.host.roomCode, h2.roomCode);
  h1.host.close(); h2.close();
});

test('clients cannot spoof: unknown kinds rejected, host-only actions refused, no state in views', async () => {
  const net = createFakeNetwork();
  const h = await mkHost(net);
  const a = mkClient(net, h.host.roomCode, 'player-aaaa', 'Ann'); a.client.start();
  await until(() => a.view);
  a.client.conn.send({ v: 1, type: 'action', kind: 'tick' });
  a.client.send('startGame');
  a.client.send('settings', { patch: { narration: false } });
  await until(() => a.errors.length >= 3);
  assert.equal(h.host.state.phase, 'lobby');
  assert.equal(h.host.state.settings.narration, true);
  assert.ok(!('nonces' in a.view) && !('hostId' in a.view && a.view.night));
  h.host.close();
});

// Start a game and get everyone through the role reveal into the first night ("Night falls…" is narrated).
async function toFirstNight(h, a) {
  h.client.send('startGame');
  await until(() => h.view.phase === 'reveal' && a.view.phase === 'reveal');
  h.client.send('ready'); a.client.send('ready');
  await until(() => h.view.progress && h.view.progress.done === h.view.progress.total);
  h.client.send('nextPhase');
  await until(() => h.view.phase === 'night' && a.view.phase === 'night');
}

test('narration goes to every phone with each view, numbered so each line is spoken once', async () => {
  const net = createFakeNetwork();
  const said = [];
  const h = await mkHost(net, { onNarrate: (t) => said.push(t) });
  const a = mkClient(net, h.host.roomCode, 'player-aaaa', 'Ann'); a.client.start();
  await until(() => a.view);
  assert.equal(a.view.narration, undefined, 'nothing said yet');
  addBots(h.host, 4, { minDelay: 1, maxDelay: 5 });
  await until(() => h.view.players.length === 6);
  await toFirstNight(h, a);
  const first = h.host.narration;
  assert.ok(first, 'night falls is narrated');
  await until(() => a.view.narration?.seq === first.seq && h.view.narration?.seq === first.seq);
  assert.equal(a.view.narration.text, first.text);
  assert.ok(said.length >= 1);
  h.host.close();
});

test('narration setting off: no lines are sent', async () => {
  const net = createFakeNetwork();
  const h = await mkHost(net);
  const a = mkClient(net, h.host.roomCode, 'player-aaaa', 'Ann'); a.client.start();
  await until(() => a.view);
  h.client.send('settings', { patch: { narration: false } });
  addBots(h.host, 4, { minDelay: 1, maxDelay: 5 });
  await until(() => h.view.players.length === 6);
  await toFirstNight(h, a);
  assert.equal(h.host.narration, null);
  assert.equal(a.view.narration, undefined);
  h.host.close();
});

async function fullGame(net, h, n) {
  // host + bots; start; wait for gameover
  addBots(h.host, n - 1, { minDelay: 1, maxDelay: 15 });
  await until(() => h.view.players.length === n);
  h.client.send('settings', { patch: { revealOnDeath: false } });
  h.client.send('startGame');
  // host UI plays too, with the same logic as a bot
  let guard = 0;
  const hostPlay = setInterval(() => {
    const v = h.view; if (!v) return;
    if (v.phase === 'reveal' && !v.players.find((p) => p.id === 'hostplayer').ready) h.client.send('ready');
    // the host advances reveal/night once everyone is in
    if ((v.phase === 'reveal' || v.phase === 'night') && v.progress && v.progress.done === v.progress.total) h.client.send('nextPhase');
    const p = v.prompt;
    if (p && !p.done && v.you.alive) {
      if (v.phase === 'night') h.client.send('nightPick', { targetId: p.required ? p.targets[0] : null });
      if (v.phase === 'vote') h.client.send('vote', { targetId: 'skip' });
    }
    if (v.phase === 'day') h.client.send('startVote');
    if (v.phase === 'vote' && v.voteResult) h.client.send('nextPhase');
  }, 5);
  try { await until(() => h.view.phase === 'gameover', 60000); } finally { clearInterval(hostPlay); }
}

test('a 5-player game (host + 4 bots) plays lobby -> game over -> play again', async () => {
  const net = createFakeNetwork();
  const h = await mkHost(net);
  await fullGame(net, h, 5);
  assert.ok(h.view.winner);
  assert.equal(h.view.roles.length, 5);
  h.client.send('playAgain');
  await until(() => h.view.phase === 'lobby');
  assert.equal(h.view.players.length, 5);
  assert.ok(h.view.players.every((p) => p.alive));
  // and again
  h.client.send('startGame');
  await until(() => h.view.phase === 'reveal');
  h.host.close();
});

test('a real remote player plus bots, and everyone only ever sees their own role', async () => {
  const net = createFakeNetwork();
  const h = await mkHost(net);
  const a = mkClient(net, h.host.roomCode, 'player-aaaa', 'Ann'); a.client.start();
  addBots(h.host, 3, { minDelay: 1, maxDelay: 10 });
  await until(() => h.view.players.length === 5);
  h.client.send('startGame');
  await until(() => a.view.phase === 'reveal');
  assert.ok(a.view.you.role);
  assert.equal(a.view.players.filter((p) => p.role).length, 1);
  a.client.send('ready');
  h.host.close();
});

test('host can advance past a player who never acts', async () => {
  const net = createFakeNetwork();
  const h = await mkHost(net);
  addBots(h.host, 3, { minDelay: 1, maxDelay: 10 });
  const idle = mkClient(net, h.host.roomCode, 'player-idle', 'Idle'); idle.client.start();
  await until(() => h.view.players.length === 5);
  h.client.send('startGame');
  await until(() => h.view.phase === 'reveal');
  // the idle player never readies; the host moves on anyway
  h.client.send('nextPhase');
  await until(() => h.view.phase === 'night');
  h.client.send('nextPhase'); // ...and ends the night without the idle player's pick
  await until(() => h.view.phase !== 'night');
  h.host.close();
});

test('client rejoin: dropped connection reconnects with same id, role and phase', async () => {
  const net = createFakeNetwork();
  const h = await mkHost(net);
  const a = mkClient(net, h.host.roomCode, 'player-aaaa', 'Ann'); a.client.start();
  addBots(h.host, 3, { minDelay: 1, maxDelay: 10 });
  await until(() => h.view.players.length === 5);
  h.client.send('startGame');
  await until(() => a.view?.phase === 'reveal');
  const role = a.view.you.role;
  a.client.conn.close(); // network blip
  await until(() => a.statuses.includes('reconnecting'));
  await until(() => a.client.status === 'connected');
  await until(() => a.view.players.find((p) => p.id === 'player-aaaa').connected);
  assert.equal(a.view.you.role, role);
  assert.equal(a.view.phase, 'reveal');
  assert.equal(h.view.players.length, 5, 'no duplicate player');
  h.host.close();
});

test('client with a frozen socket (no pongs) is detected and rejoins', async () => {
  const net = createFakeNetwork();
  const h = await mkHost(net);
  const a = mkClient(net, h.host.roomCode, 'player-aaaa', 'Ann'); a.client.start();
  await until(() => a.view);
  const old = a.client.conn;
  old.send = () => {}; // frozen: nothing gets out
  const origOn = old.on;
  a.client.lastSeen = Date.now() - 10_000;
  await until(() => a.client.conn !== old && a.client.status === 'connected');
  h.host.close();
});

test('host resume: reload mid-game restores roles/phase and players rejoin the same ids', async () => {
  const net = createFakeNetwork();
  const storage = memStorage();
  const h = await mkHost(net, { storage });
  const a = mkClient(net, h.host.roomCode, 'player-aaaa', 'Ann', { retryFirst: true }); a.client.start();
  addBots(h.host, 3, { minDelay: 1, maxDelay: 10 });
  await until(() => h.view.players.length === 5);
  h.client.send('startGame');
  await until(() => a.view?.phase === 'reveal');
  const roleBefore = a.view.you.role;
  const code = h.host.roomCode;
  // "reload": host page dies (peer destroyed, no clean state), then comes back from storage
  h.client.stop(); h.host.peer.destroy(); h.host.closed = true; clearTimeout(h.host.timer);
  const save = Host.loadSave(storage);
  assert.ok(save);
  const host2 = new Host({ Peer: net.Peer, hostPlayerId: 'hostplayer', peerOptions: {}, resume: save, storage });
  assert.equal(await host2.start(), code);
  const hv = {};
  const c2 = new Client({ playerId: 'hostplayer', name: 'Hosty', visibilityReconnect: false, connector: async () => host2.attachLoopback(), onView: (v) => { hv.v = v; } });
  c2.start();
  await until(() => hv.v);
  assert.equal(hv.v.phase, 'reveal');
  await until(() => a.client.status === 'connected' && a.view.players.find((p) => p.id === 'player-aaaa').connected);
  assert.equal(a.view.you.role, roleBefore);
  assert.equal(hv.v.players.length, 5);
  host2.close();
});

test('host resume retries while the broker still holds the old ID', async () => {
  const net = createFakeNetwork();
  const storage = memStorage();
  const h = await mkHost(net, { storage });
  addBots(h.host, 3, { minDelay: 1, maxDelay: 10 });
  await until(() => h.view.players.length === 4);
  const save = Host.loadSave(storage);
  // old peer still registered (broker holds the id); release it after ~300ms
  setTimeout(() => h.host.peer.destroy(), 300);
  const host2 = new Host({ Peer: net.Peer, hostPlayerId: 'hostplayer', peerOptions: {}, resume: save });
  const t = Date.now();
  assert.equal(await host2.start(), h.host.roomCode);
  assert.ok(Date.now() - t >= 250);
  host2.close(); h.host.close();
});

test('stale saves (over 2h) are not offered', () => {
  const storage = memStorage();
  storage.set('gigawolf.hostSave', { roomCode: 'ABCD', state: { phase: 'night', players: [1, 2] }, rngState: 1, savedAt: 1000 });
  assert.equal(Host.loadSave(storage, 1000 + 2 * 3600e3 + 1), null);
  assert.ok(Host.loadSave(storage, 1000 + 3600e3));
});

test('host recovers when its broker link drops (phone slept): new players can still join', async () => {
  const net = createFakeNetwork();
  const h = await mkHost(net);
  const code = h.host.roomCode;
  h.host.peer.dropBroker();
  await sleep(30);
  assert.equal(h.host.peer.disconnected, false, 'host re-registered itself');
  const a = mkClient(net, code, 'player-aaaa', 'Ann'); a.client.start();
  await until(() => a.view && a.view.players.length === 2);
  h.host.close();
});

test('host.recover() re-registers a destroyed peer under the same room code', async () => {
  const net = createFakeNetwork();
  const h = await mkHost(net);
  const code = h.host.roomCode;
  h.host.peer.destroy(); // simulates the OS killing the sockets; 'close' is not emitted by the fake
  h.host.recover();
  await sleep(30);
  assert.ok(h.host.peer && !h.host.peer.destroyed);
  const a = mkClient(net, code, 'player-bbbb', 'Bo'); a.client.start();
  await until(() => a.view && a.view.players.length >= 2);
  h.host.close();
});
