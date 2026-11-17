// Boot + screen routing. The UI only ever renders the view it is sent.
import { h } from './ui/dom.js';
import { roleSprite } from './ui/pixel.js';
import { Client, peerConnector } from './net/client.js';
import { Host } from './net/host.js';
import { randomId } from './net/protocol.js';
import { t, tr, getLang, setLang } from './i18n.js';
import { storage } from './util/storage.js';
import { keepAwake, releaseAwake } from './util/wakelock.js';
import { speak } from './ui/narrator.js';
import { enterRoom, leaveRoom, refreshSoundLabels } from './ui/sound.js';
import { APP_VERSION, normalizeRoomCode } from './config.js';
import { homeScreen } from './ui/screens/home.js';
import { lobbyScreen } from './ui/screens/lobby.js';
import { revealScreen } from './ui/screens/reveal.js';
import { nightScreen } from './ui/screens/night.js';
import { dayScreen } from './ui/screens/day.js';
import { voteScreen } from './ui/screens/vote.js';
import { deadScreen } from './ui/screens/dead.js';
import { gameoverScreen } from './ui/screens/gameover.js';
import { shotScreen } from './ui/screens/shot.js';

const $app = document.getElementById('app');
const $banner = document.getElementById('banner');
const $toast = document.getElementById('toast');
const params = new URLSearchParams(location.search);

const app = { client: null, host: null, view: null, status: null, error: null, prevKey: null, connecting: false, narrSeq: undefined };
const ui = { pick: null, holding: false, key: null };

const SESSION_KEY = 'gigawolf.session';
const NAME_KEY = 'gigawolf.name';
const pidKey = (code) => `gigawolf.pid.${code}`;
const getPid = (code) => { let id = storage.get(pidKey(code)); if (!id) { id = randomId(); storage.set(pidKey(code), id); } return id; };

function toast(text, ms = 6000) {
  $toast.textContent = text; $toast.hidden = false;
  setTimeout(() => { $toast.hidden = true; }, ms);
}

// ---------- sessions ----------
function resetToHome(error = null) {
  app.client?.stop(); app.host?.close();
  app.client = null; app.host = null; app.view = null; app.status = null; app.connecting = false;
  app.error = error;
  releaseAwake();
  leaveRoom();
  render();
}

function leave() {
  storage.remove(SESSION_KEY); Host.clearSave(storage);
  resetToHome();
}

function wire(client) {
  app.client = client;
  client.onStatus = (s) => { app.status = s; render(); };
  client.onError = (e) => {
    if (e.code === 'unreachable') { storage.remove(SESSION_KEY); resetToHome(e.message); return; }
    if (['gameStarted', 'roomFull', 'badName', 'badVersion'].includes(e.code)) { storage.remove(SESSION_KEY); resetToHome(e.message); return; }
    toast(tr(e.message));
  };
  client.onView = (view) => {
    sayNarration(view);
    onViewChange(app.view, view);
    app.view = view;
    render();
  };
  client.onWelcome = () => { app.connecting = false; app.narrSeq = undefined; };
}

// Narration rides on views as { seq, text }. The first view after (re)connecting only records the
// current line, so a phone that rejoins doesn't repeat something said a while ago.
function sayNarration(view) {
  const n = view.narration ?? null;
  const seq = n?.seq ?? 0;
  if (n && app.narrSeq !== undefined && seq !== app.narrSeq) speak(n.text);
  app.narrSeq = seq;
}

function onViewChange(prev, next) {
  const key = `${next.phase}:${next.round}:${next.you.alive}`;
  if (key !== app.prevKey) {
    if (app.prevKey) { try { navigator.vibrate?.(next.phase === 'gameover' ? [200, 100, 200] : 200); } catch { /* iOS */ } }
    app.prevKey = key;
  }
  if (next.phase !== 'lobby' && next.phase !== 'gameover') {
    keepAwake(() => toast(t('main.wake')));
  }
}

async function hostGame(name, resume = null) {
  if (app.connecting) return;
  app.connecting = true; app.error = null; render();
  enterRoom({ isHost: true, roomCode: null }); // inside the tap, so music and speech are allowed to start
  storage.set(NAME_KEY, name);
  const hostId = resume?.hostId ?? randomId();
  const host = new Host({ Peer: window.Peer, hostPlayerId: hostId, storage, resume });
  try { await host.start(); }
  catch (e) {
    app.connecting = false;
    resetToHome(resume
      ? 'main.noReclaim'
      : 'main.noService');
    return;
  }
  app.host = host;
  storage.set(SESSION_KEY, { roomCode: host.roomCode, playerId: hostId, name, isHost: true });
  const hostName = resume ? (resume.state.players.find((p) => p.id === hostId)?.name ?? name) : name;
  const client = new Client({ playerId: hostId, name: hostName, visibilityReconnect: false, connector: async () => host.attachLoopback() });
  wire(client);
  client.start();
  const bots = parseInt(params.get('bots') ?? '0', 10);
  if (bots > 0 && !resume) host.setBots(bots); // same as the lobby's Bots control
}

function joinGame(code, name, retryFirst = false) {
  if (app.connecting) return;
  app.connecting = true; app.error = null; storage.set(NAME_KEY, name);
  const playerId = getPid(code);
  storage.set(SESSION_KEY, { roomCode: code, playerId, name, isHost: false });
  enterRoom({ isHost: false, roomCode: code });
  const client = new Client({ playerId, name, retryFirst, connector: peerConnector(window.Peer, code) });
  wire(client);
  client.start();
  render();
}

// ---------- rendering ----------
function chooseScreen(v, ctx) {
  const alive = v.you.alive;
  switch (v.phase) {
    case 'lobby': return lobbyScreen(v, ctx);
    case 'reveal': return revealScreen(v, ctx);
    case 'night': return alive ? nightScreen(v, ctx) : deadScreen(v, ctx);
    case 'day': return alive ? dayScreen(v, ctx) : deadScreen(v, ctx);
    case 'vote': return alive || v.voteResult || v.prompt?.kind === 'vote' ? voteScreen(v, ctx) : deadScreen(v, ctx);
    case 'shot': return shotScreen(v, ctx);
    case 'gameover': return gameoverScreen(v, ctx);
    default: return h('main', { class: 'screen' }, t('main.unknown'));
  }
}

const ctx = {
  ui,
  send: (kind, extra) => app.client?.send(kind, extra),
  rerender: () => render(),
  setBots: (n) => app.host?.setBots(n), // host only: bots run inside the host's page
  hold(on) {
    ui.holding = on;
    document.getElementById('rolecard')?.classList.toggle('shown', on);
  },
};
document.addEventListener('pointerup', () => ctx.hold(false));
document.addEventListener('pointercancel', () => ctx.hold(false));
window.addEventListener('blur', () => ctx.hold(false));

function render() {
  // Reset per-phase UI state when the phase changes.
  const v = app.view;
  const key = v ? `${v.phase}:${v.round}` : 'home';
  if (key !== ui.key) { ui.key = key; ui.pick = null; ui.picks = null; ui.mode = null; ui.confirmEnd = false; if (v?.phase !== 'reveal') ui.holding = false; }

  const scrollY = window.scrollY;
  $app.replaceChildren();
  if (!v) {
    if (app.connecting) {
      $app.append(h('main', { class: 'screen' }, h('h2', null, app.status === 'reconnecting' ? t('main.reconnecting') : t('main.connecting')),
        h('button', { class: 'btn', onClick: leave }, t('main.cancel'))));
    } else {
      const save = Host.loadSave(storage);
      $app.append(homeScreen({
        prefill: { name: storage.get(NAME_KEY) ?? '', code: normalizeRoomCode(params.get('join')) },
        error: app.error, resumeAvailable: !!save,
        onHost: (name) => { Host.clearSave(storage); hostGame(name); },
        onJoin: (code, name) => joinGame(code, name),
        onResume: () => {
          const s = Host.loadSave(storage);
          const name = storage.get(NAME_KEY) ?? 'Host';
          if (s) hostGame(name, s);
        },
      }));
    }
  } else {
    $app.append(chooseScreen(v, ctx));
    // Always show your own role while a game is on (night, day, vote, shot), alive or dead.
    if (v.you.role && ['night', 'day', 'vote', 'shot'].includes(v.phase)) {
      $app.append(h('p', { class: 'sub small yourole' }, roleSprite(v.you.role, { scale: 1.5 }), t('night.youAre', { role: t(`role.${v.you.role}`) })));
    }
    $app.append(h('button', { class: 'btn leave', onClick: () => { if (confirm(t('main.leaveConfirm'))) leave(); } }, t('main.leave')));
    // Host only, while a game is running: stop it early (red, behind a confirmation sheet at the bottom).
    if (v.isHost && v.phase !== 'lobby' && v.phase !== 'gameover') {
      $app.append(h('button', { class: 'btn danger endearly', onClick: () => { ui.confirmEnd = true; render(); } }, t('host.endEarly')));
      if (ui.confirmEnd) {
        const close = () => { ui.confirmEnd = false; render(); };
        $app.append(h('div', { class: 'sheet-backdrop', onClick: close }),
          h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sheet-title' },
            h('h3', { id: 'sheet-title' }, t('host.endEarlyTitle')),
            h('p', { class: 'sub' }, t('host.endEarlyBody')),
            h('button', { class: 'btn danger', onClick: () => { ui.confirmEnd = false; ctx.send('endEarly'); } }, t('host.endEarlyConfirm')),
            h('button', { class: 'btn', onClick: close }, t('host.endEarlyCancel'))));
      }
    }
  }
  window.scrollTo(0, scrollY);

  const down = app.status === 'reconnecting' && !!v;
  $banner.hidden = !down;
  $banner.textContent = down ? t('main.hostDown') : '';
}

// ---------- boot ----------
function boot() {
  const session = storage.get(SESSION_KEY);
  // Non-host phones that reloaded mid-game rejoin automatically.
  const wanted = normalizeRoomCode(params.get('join'));
  if (session && !session.isHost && (!wanted || wanted === session.roomCode)) {
    joinGame(session.roomCode, session.name, true);
    return;
  }
  render();
}
// Version footer. If index.html and the scripts disagree, one of them came from cache: say so.
const $ver = document.getElementById('version');
const htmlVer = $ver.dataset.htmlVersion;
$ver.textContent = htmlVer === APP_VERSION ? `v${APP_VERSION}` : `v${APP_VERSION} (page v${htmlVer}) ⚠ stale cache, reload`;

// Force refresh: GitHub Pages serves files with max-age=600, so a plain reload can reuse stale JS/CSS.
// Re-download index.html, the stylesheet and every module in the import graph with cache:'reload'
// (which overwrites the HTTP cache entries), then reload. Session storage is kept so players rejoin.
async function forceRefresh(btn) {
  if (app.host && !confirm(t('refresh.hostWarn'))) return;
  btn.disabled = true; btn.textContent = t('refresh.busy');
  try {
    const seen = new Set();
    const queue = [new URL('js/main.js', document.baseURI).href, new URL('css/style.css', document.baseURI).href, new URL('index.html', document.baseURI).href];
    while (queue.length) {
      const url = queue.pop();
      if (seen.has(url)) continue;
      seen.add(url);
      const res = await fetch(url, { cache: 'reload' });
      if (!res.ok || !url.endsWith('.js')) continue;
      const src = await res.text();
      for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) queue.push(new URL(m[1], url).href);
    }
    await fetch(location.pathname, { cache: 'reload' });
    if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
  } catch { /* offline or partial: reload anyway */ }
  location.reload();
}
const $refresh = document.createElement('button');
$refresh.type = 'button'; $refresh.id = 'refresh'; $refresh.textContent = t('refresh.button');
$refresh.addEventListener('click', () => forceRefresh($refresh));
const $tools = document.createElement('div');
$tools.id = 'tools'; $tools.append($refresh);
$ver.after($tools); // the sound panel joins this row while in a room

// Language switch (English default). Fixed button; re-renders the current screen.
const $lang = document.getElementById('lang');
function syncLang() { $refresh.textContent = t('refresh.button'); $lang.textContent = t('lang.button'); $lang.setAttribute('aria-label', getLang() === 'en' ? 'ภาษาไทย' : 'English'); document.documentElement.lang = getLang(); refreshSoundLabels(); }
$lang.addEventListener('click', () => { setLang(getLang() === 'en' ? 'th' : 'en'); syncLang(); render(); });
syncLang();
boot();
window.__app = app; // handy for debugging / tests
