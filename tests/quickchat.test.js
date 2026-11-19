// Human quick chat (the Say sheet): the `say` action, its protocol checks, and the rule that a person's line
// has exactly the weight a bot's line has.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reduce, PHASE } from '../js/game/engine.js';
import { viewFor } from '../js/game/views.js';
import { CHAT, CHAT_PER_ROUND, DAY_BEFORE_KEYS, HUMAN_KEYS, PERSONALITIES, humanKeys, validOnRound } from '../js/game/chat.js';
import { BotMind, DAY_BEFORE_ACCUSE } from '../js/bots/mind.js';
import { CLIENT_ACTION_KINDS, validate } from '../js/net/protocol.js';
import { PROTOCOL_VERSION } from '../js/config.js';
import { Host } from '../js/net/host.js';
import { HUMAN_REPLIES } from '../js/net/hostbots.js';
import { Client } from '../js/net/client.js';
import { createFakeNetwork } from '../js/dev/fakepeer.js';
import { createRng } from '../js/util/rng.js';
import { setLang, t } from '../js/i18n.js';
import { lobby, T0 } from './helpers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Host p0 (a human) plus bots bot-1.., roles forced by seat. Day 1 by default, after The Day Before (day 0) and
// night 1; with { dayZero: true } it stops at The Day Before.
function day(roles, settings = {}, { dayZero = false } = {}) {
  const rng = createRng(5);
  let s = lobby(1, rng);
  const step = (a) => { const r = reduce(s, { now: T0, ...a }, rng); if (r.error) throw new Error(r.error.message); s = r.state; return r; };
  step({ kind: 'setBots', by: 'p0', count: roles.length - 1 });
  step({ kind: 'settings', by: 'p0', patch: { randomEvents: false, ...settings } });
  step({ kind: 'startGame', by: 'p0' });
  s.players.forEach((p, i) => { p.role = roles[i]; p.potions = p.role === 'witch' ? { heal: true, poison: true } : null; });
  step({ kind: 'nextPhase', by: 'p0' }); // reveal -> The Day Before
  if (!dayZero) {
    step({ kind: 'nextPhase', by: 'p0' }); // -> night 1
    step({ kind: 'nextPhase', by: 'p0' }); // dawn: nobody picked, nobody died
  }
  assert.equal(s.phase, PHASE.DAY);
  assert.equal(s.round, dayZero ? 0 : 1);
  const g = { get s() { return s; }, set s(v) { s = v; }, rng };
  g.say = (by, key, v, ids) => reduce(s, { kind: 'say', by, key, v, ids, now: T0 }, rng);
  g.botSay = (by, key, v, ids) => reduce(s, { kind: 'botSay', by, key, v, ids, now: T0 }, rng);
  return g;
}
const ROLES = ['villager', 'werewolf', 'seer', 'villager', 'villager', 'villager'];
const NAMES = { accuse: ['bot-2'], agree: ['bot-2'], vouch: ['bot-2'], defend: [], bait: [], claimWolf: ['bot-2'], claimClean: ['bot-2'], counter: ['bot-2'], claimGuard: ['bot-2'], counterGuard: ['bot-2'], protectMe: [], protectThem: ['bot-2'], voteFor: ['bot-2'], voteSkip: [] };

test('say: every human line is accepted, stored like a bot line and public to every phone', () => {
  for (const key of HUMAN_KEYS) {
    const g = day(ROLES);
    const r = g.say('p0', key, 0, NAMES[key]);
    assert.ok(!r.error, `${key}: ${r.error?.message}`);
    g.s = r.state;
    assert.deepEqual(g.s.chat.map(({ by, key: k, v, ids, round }) => ({ by, k, v, ids, round })), [{ by: 'p0', k: key, v: 0, ids: NAMES[key], round: 1 }]);
    for (const id of ['p0', 'bot-2', 'bot-5']) assert.equal(viewFor(g.s, id).chat[0].by, 'p0');
  }
});

test('say: only the human line set, valid wording, valid names, and never yourself or a dead player', () => {
  const g = day(ROLES);
  for (const key of Object.keys(CHAT).filter((k) => !HUMAN_KEYS.includes(k))) {
    assert.equal(g.say('p0', key, 0, Array(CHAT[key].ids).fill('bot-2')).error?.code, 'badLine', `${key} is bot-only`);
  }
  assert.equal(g.say('p0', 'nope', 0, []).error?.code, 'badLine');
  assert.equal(g.say('p0', 'accuse', 0, []).error?.code, 'badLine', 'accuse names one player');
  assert.equal(g.say('p0', 'defend', 0, ['bot-2']).error?.code, 'badLine', 'defend names nobody');
  assert.equal(g.say('p0', 'accuse', 99, ['bot-2']).error?.code, 'badLine', 'unknown wording');
  assert.equal(g.say('p0', 'accuse', 0, ['ghost']).error?.code, 'badLine', 'unknown player');
  assert.equal(g.say('p0', 'accuse', 0, ['p0']).error?.code, 'badLine', 'not yourself');
  assert.equal(g.say('p0', 'accuse', 0, ['bot-2', 'bot-3']).error?.code, 'badLine', 'one name only');
  g.s.players.find((p) => p.id === 'bot-3').alive = false;
  assert.equal(g.say('p0', 'accuse', 0, ['bot-3']).error?.code, 'badLine', 'not a dead player');
  assert.equal(g.say('bot-1', 'accuse', 0, ['bot-2']).error?.code, 'forbidden', 'bots use botSay, not say');
  assert.equal(g.botSay('p0', 'accuse', 0, ['bot-2']).error?.code, 'forbidden', 'humans cannot use botSay');
  assert.equal(g.say('nobody', 'filler', 0, []).error?.code, 'forbidden');
});

test('say: only while alive, in the day or an open vote, and four lines a round', () => {
  const g = day(ROLES);
  for (let i = 0; i < CHAT_PER_ROUND; i++) g.s = g.say('p0', 'defend', 0, []).state;
  assert.equal(g.say('p0', 'defend', 0, []).error?.code, 'tooChatty');
  assert.equal(g.s.chat.length, CHAT_PER_ROUND);
  // The cap is per person: a bot's lines do not use up yours.
  const b = day(ROLES);
  for (let i = 0; i < CHAT_PER_ROUND; i++) b.s = b.botSay('bot-1', 'filler', 0, []).state;
  assert.ok(!b.say('p0', 'defend', 0, []).error);
  // Vote: open while voting, closed on the result screen.
  g.s = reduce(g.s, { kind: 'startVote', by: 'p0', now: T0 }, g.rng).state;
  assert.equal(g.s.vote.stage, 'voting');
  assert.equal(g.say('p0', 'voteSkip', 0, []).error?.code, 'tooChatty', 'the cap holds across the day and the vote');
  const h = day(ROLES);
  h.s = reduce(h.s, { kind: 'startVote', by: 'p0', now: T0 }, h.rng).state;
  assert.ok(!h.say('p0', 'voteFor', 0, ['bot-2']).error);
  h.s = reduce(h.s, { kind: 'nextPhase', by: 'p0', now: T0 }, h.rng).state;
  assert.equal(h.s.vote.stage, 'result');
  assert.equal(h.say('p0', 'defend', 0, []).error?.code, 'badPhase');
  // Night and a dead player.
  const n = day(ROLES);
  n.s.players.find((p) => p.id === 'p0').alive = false;
  assert.equal(n.say('p0', 'defend', 0, []).error?.code, 'dead');
  const night = day(ROLES);
  night.s = reduce(reduce(night.s, { kind: 'startVote', by: 'p0', now: T0 }, night.rng).state, { kind: 'nextPhase', by: 'p0', now: T0 }, night.rng).state;
  night.s = reduce(night.s, { kind: 'nextPhase', by: 'p0', now: T0 }, night.rng).state;
  if (night.s.phase === PHASE.NIGHT) assert.equal(night.say('p0', 'defend', 0, []).error?.code, 'badPhase');
  // A new round starts with a clean allowance.
  const r2 = day(ROLES);
  for (let i = 0; i < CHAT_PER_ROUND; i++) r2.s = r2.say('p0', 'defend', 0, []).state;
  r2.s.round += 1;
  assert.ok(!r2.say('p0', 'defend', 0, []).error);
});

// Leak check: the answer to a line never depends on the sender's role or on the bot setting, so the Say
// sheet cannot show who has a power or whether the bots are smart or dumb.
test('say gives the same answer for every role and for smart and dumb bots', () => {
  const roles = ['villager', 'werewolf', 'seer', 'bodyguard', 'witch', 'hunter', 'prince', 'diseased', 'apprentice', 'poltergeist', 'jester'];
  for (const key of HUMAN_KEYS) {
    const outs = new Set();
    for (const role of roles) {
      for (const dumbBots of [false, true]) {
        const g = day([role, 'villager', 'villager', 'werewolf', 'villager', 'villager', 'villager'], { dumbBots });
        const r = g.say('p0', key, 0, NAMES[key].map((id) => (id === 'bot-2' ? 'bot-2' : id)));
        outs.add(JSON.stringify([r.error ?? null, r.state.chat.map(({ by, key: k, v, ids }) => [by, k, v, ids])]));
      }
    }
    assert.equal(outs.size, 1, `${key} differs by role or bot type`);
  }
});

test('the protocol carries say lines and rejects malformed ones', () => {
  assert.ok(CLIENT_ACTION_KINDS.includes('say'));
  const msg = (extra) => ({ v: PROTOCOL_VERSION, type: 'action', kind: 'say', ...extra });
  assert.equal(validate(msg({ key: 'accuse', variant: 0, ids: ['bot-2'] })), null);
  assert.equal(validate(msg({ key: 'defend', variant: 2, ids: [] })), null);
  for (const bad of [{}, { key: 'accuse', ids: ['a'] }, { key: 'accuse', variant: 'x', ids: ['a'] }, { key: 'accuse', variant: 0 }, { key: 'accuse', variant: 0, ids: 'a' },
    { key: 'accuse', variant: 0, ids: [1] }, { key: 'accuse', variant: 0, ids: ['a', 'b', 'c'] }, { key: 5, variant: 0, ids: [] }, { key: 'x'.repeat(40), variant: 0, ids: [] }]) {
    assert.equal(validate(msg(bad)), 'bad line', JSON.stringify(bad));
  }
  // The wording must not ride on `v`: that field is the protocol version and a client that sent it would be refused.
  assert.equal(validate(msg({ key: 'accuse', v: 0, ids: ['a'] })), 'badVersion');
});

test('a person\'s line moves a bot\'s mind exactly like the same line from a bot', () => {
  // Seat 5 is a villager in both runs. In one it is a bot (botSay); in the other the same seat is a person
  // (say). Everything else is identical, so every other bot must think, say and vote the same.
  const sets = [
    [['accuse', 0, ['bot-2']]],
    [['accuse', 1, ['bot-3']], ['agree', 0, ['bot-3']]],
    [['vouch', 0, ['bot-2']], ['claimWolf', 0, ['bot-4']]],
    [['claimClean', 1, ['bot-4']], ['counter', 0, ['bot-1']]],
    [['claimWolf', 0, ['bot-1']], ['defend', 0, []], ['bait', 1, []], ['voteFor', 0, ['bot-3']]],
  ];
  const asPerson = (s) => JSON.parse(JSON.stringify(s).replaceAll('"bot-5"', '"zz5"'));
  for (const set of sets) {
    for (const persona of PERSONALITIES) {
      for (const viewer of ['bot-1', 'bot-2', 'bot-3', 'bot-4']) {
        for (let seed = 1; seed <= 12; seed++) {
          const runs = [false, true].map((person) => {
            const g = day(ROLES);
            const me = person ? 'zz5' : 'bot-5';
            if (person) g.s = asPerson(g.s);
            for (const [key, v, ids] of set) {
              const r = reduce(g.s, { kind: person ? 'say' : 'botSay', by: me, key, v, ids, now: T0 }, g.rng);
              assert.ok(!r.error, `${me} ${key}: ${r.error?.message}`);
              g.s = r.state;
            }
            const m = new BotMind(viewer, persona, createRng(seed));
            const out = [m.talk(viewFor(g.s, viewer), 'day'), m.talk(viewFor(g.s, viewer), 'reply')];
            const scores = g.s.players.map((p) => m.score(p.id)).map((x) => (Number.isFinite(x) ? x : 'self'));
            g.s = reduce(g.s, { kind: 'startVote', by: 'p0', now: T0 }, g.rng).state;
            const v = viewFor(g.s, viewer);
            const a = m.act(v);
            return JSON.stringify({ out, scores, vote: a, said: m.voteLine(v, a?.extra?.targetId) }).replaceAll('zz5', 'bot-5');
          });
          assert.equal(runs[0], runs[1], `${persona} ${viewer} seed ${seed} ${JSON.stringify(set)}`);
        }
      }
    }
  }
});

test('a person\'s lines do not use up the bots\' share of the table talk', async () => {
  const net = createFakeNetwork();
  const host = new Host({ Peer: net.Peer, hostPlayerId: 'hostplayer', peerOptions: {}, botDelays: { minDelay: 1, maxDelay: 6, rand: () => 0 } });
  await host.start();
  const h = { view: null };
  const client = new Client({ playerId: 'hostplayer', name: 'Hosty', visibilityReconnect: false, connector: async () => host.attachLoopback(), onView: (v) => { h.view = v; } });
  client.start();
  while (!h.view) await sleep(2);
  host.setBots(6);
  while (h.view.players.length < 7) await sleep(2);
  client.send('startGame');
  while (h.view.phase !== 'reveal') await sleep(2);
  host.bots.stop();
  // Force day 1 with a full table of talk already on the screen, written by people.
  const crowd = (by) => Array.from({ length: 14 }, (_, i) => ({ seq: 1000 + i, round: 1, by, key: 'filler', v: 0, ids: [] }));
  const talkAfter = (by) => {
    host.state.phase = 'day'; host.state.round = 1; host.state.chat = crowd(by); host.state.chatSeq = 2000;
    host.state.players.forEach((p) => { p.alive = true; });
    host.bots.key = `day:1:${by}`;
    const before = host.state.chat.length;
    host.bots._talk('bot-3', 'day');
    return host.state.chat.length - before;
  };
  assert.equal(talkAfter('bot-1'), 0, 'a table full of bot talk is capped');
  assert.ok(talkAfter('hostplayer') >= 1, 'the same amount of human talk leaves the bots free to answer');
  host.close();
});

test('the Say sheet texts exist in English and Thai', () => {
  try {
    for (const k of ['chat.say', 'chat.sayTitle', 'chat.sayLeft', 'chat.sayWho', 'chat.sayBack']) {
      setLang('en'); const en = t(k, { n: 3 });
      setLang('th'); const th = t(k, { n: 3 });
      assert.notEqual(en, k, `en ${k}`);
      assert.notEqual(th, k, `th ${k}`);
      assert.notEqual(en, th, `${k} not translated`);
      assert.ok(!/\{n\}/.test(en + th), `${k} has an unfilled count`);
    }
  } finally { setLang('en'); }
});

test('whole games with a person posting lines every day finish with no rejected line', async () => {
  for (let i = 0; i < 4; i++) {
    const net = createFakeNetwork();
    const host = new Host({ Peer: net.Peer, hostPlayerId: 'hostplayer', peerOptions: {}, botDelays: { minDelay: 1, maxDelay: 12 } });
    await host.start();
    const h = { view: null, errors: [] };
    const client = new Client({ playerId: 'hostplayer', name: 'Hosty', visibilityReconnect: false, connector: async () => host.attachLoopback(), onView: (v) => { h.view = v; }, onError: (e) => h.errors.push(e) });
    client.start();
    while (!h.view) await sleep(2);
    host.setBots(5 + i);
    host.apply({ kind: 'settings', by: 'hostplayer', patch: i % 2 ? { dumbBots: true } : {} });
    while (h.view.players.length < 6 + i) await sleep(2);
    client.send('startGame');
    while (h.view.phase !== 'reveal') await sleep(2);
    let dayAt = 0; let said = 0; const all = new Map(); const mine = new Set(); // the host's own lines, collected as they appear (old lines drop off the feed)
    const deadline = Date.now() + 60000;
    while (h.view.phase !== 'gameover') {
      if (Date.now() > deadline) throw new Error(`stuck in ${h.view.phase}`);
      for (const c of host.state.chat ?? []) { all.set(c.seq, c); if (c.by === 'hostplayer') mine.add(c.seq); }
      const v = h.view; const p = v.prompt;
      if (v.phase === 'reveal') { if (!v.players.find((x) => x.id === v.you.id).ready) client.send('ready'); if (v.progress.done === v.progress.total) client.send('nextPhase'); }
      else if (v.phase === 'night') {
        if (p && !p.done && v.you.alive) client.send('nightPick', { targetId: p.kind === 'witch' ? 'pass' : p.required ? p.targets[0] : null, ...(p.picks === 2 ? { targetId2: p.targets[1] } : {}) });
        else if (v.progress.done >= v.progress.total) client.send('nextPhase');
      } else if (v.phase === 'day') {
        if (!dayAt) dayAt = Date.now();
        if (v.you.alive && said < 40) {
          const others = v.players.filter((x) => x.alive && x.id !== v.you.id);
          const key = HUMAN_KEYS[said % HUMAN_KEYS.length];
          if (others.length) { client.send('say', { key, variant: 0, ids: CHAT[key].ids ? [others[said % others.length].id] : [] }); said++; }
        }
        if (Date.now() - dayAt > 150) { dayAt = 0; client.send(v.round === 0 ? 'nextPhase' : 'startVote'); } // day 0 has no vote: the host starts night 1
      } else if (v.phase === 'vote') { if (v.voteResult) client.send('nextPhase'); else if (p?.kind === 'vote' && !p.done) client.send('vote', { targetId: 'skip' }); else if (v.progress && v.progress.done >= v.progress.total) client.send('nextPhase'); }
      else if (v.phase === 'shot') { if (p?.kind === 'shoot') client.send('shoot', { targetId: p.targets[0] }); else if (v.isHost) client.send('nextPhase'); }
      await sleep(6);
    }
    assert.ok(h.view.winner);
    if (said > 0) await sleep(20);
    for (const c of host.state.chat ?? []) if (c.by === 'hostplayer') mine.add(c.seq);
    for (const c of host.state.chat ?? []) all.set(c.seq, c);
    const day0 = [...all.values()].filter((c) => c.round === 0);
    assert.ok(day0.every((c) => DAY_BEFORE_KEYS.includes(c.key)), `day 0 lines: ${day0.map((c) => c.key)}`);
    // The host may die in the first night and never get a day to talk in: then there is nothing to check.
    assert.ok(said === 0 || mine.size > 0, 'the human lines are in the feed');
    // Only tooChatty (the human spamming past the cap) and phase races (a line sent as the day ends) are allowed.
    const bad = h.errors.filter((e) => !['tooChatty', 'badPhase', 'dead', 'badLine'].includes(e.code));
    assert.deepEqual(bad, []);
    host.close();
  }
});

// A person types slowly. When the bots have already used the table's share of talk, a late line from a person
// still gets answers, up to HUMAN_REPLIES, and those answers start no chain of their own.
test('a late line from a person gets a few answers after the table cap, and then the room goes quiet', async () => {
  for (const named of ['bot-3', null]) {
    const net = createFakeNetwork();
    const host = new Host({ Peer: net.Peer, hostPlayerId: 'hostplayer', peerOptions: {}, botDelays: { minDelay: 1, maxDelay: 6, rand: () => 0 } });
    await host.start();
    const h = { view: null };
    const client = new Client({ playerId: 'hostplayer', name: 'Hosty', visibilityReconnect: false, connector: async () => host.attachLoopback(), onView: (v) => { h.view = v; } });
    client.start();
    while (!h.view) await sleep(2);
    host.setBots(8);
    while (h.view.players.length < 9) await sleep(2);
    client.send('startGame');
    while (h.view.phase !== 'reveal') await sleep(2);
    host.bots.stop();
    // Day 1, and four bots have already filled the table's cap (and their own per-bot limit) with their talk.
    host.state.phase = 'day'; host.state.round = 1; host.state.vote = null;
    host.state.players.forEach((p) => { p.alive = true; });
    host.state.chat = Array.from({ length: 16 }, (_, i) => ({ seq: 1000 + i, round: 1, by: `bot-${5 + (i % 4)}`, key: 'filler', v: 0, ids: [] }));
    host.state.chatSeq = 1015;
    host.bots.key = host.bots._key(host.state);
    host.bots.chatSeq = 1015;
    const botLines = () => host.state.chat.filter((c) => c.seq > 1015 && c.by.startsWith('bot-'));
    // The person speaks at last.
    const r = host.apply({ kind: 'say', by: 'hostplayer', key: 'accuse', v: 0, ids: [named ?? 'bot-6'] });
    assert.ok(!r.error, r.error?.message);
    await sleep(250);
    const first = botLines().length;
    assert.ok(first >= 1, 'the late line got no answer');
    assert.ok(first <= HUMAN_REPLIES, `${first} answers to one line`);
    await sleep(500);
    assert.equal(botLines().length, first, 'the answers set off more talk');
    host.close();
  }
});

test('an answer to a person may use a bot\'s spare line, ordinary talk may not', () => {
  const g = day(ROLES);
  g.s = reduce(g.s, { kind: 'say', by: 'p0', key: 'accuse', v: 0, ids: ['bot-3'], now: T0 }, g.rng).state;
  let ordinary = 0; let spare = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const a = new BotMind('bot-3', 'hothead', createRng(seed)); a.observe(viewFor(g.s, 'bot-3')); a.day.said = 3;
    if (a.talk(viewFor(g.s, 'bot-3'), 'reply')) ordinary++;
    const b = new BotMind('bot-3', 'hothead', createRng(seed)); b.observe(viewFor(g.s, 'bot-3')); b.day.said = 3;
    if (b.talk(viewFor(g.s, 'bot-3'), 'reply', true)) spare++;
    const c = new BotMind('bot-3', 'hothead', createRng(seed)); c.observe(viewFor(g.s, 'bot-3')); c.day.said = 4;
    assert.equal(c.talk(viewFor(g.s, 'bot-3'), 'reply', true), null, 'the engine allows four lines in all');
  }
  assert.equal(ordinary, 0);
  assert.ok(spare >= 20, `a named bot answered ${spare}/40`);
});

// The Day Before (day 0): people can talk, and bots start far fewer accusations from nothing.
test('quick chat works on day 0, which has its own line allowance', () => {
  const g = day(ROLES, {}, { dayZero: true });
  for (let i = 0; i < CHAT_PER_ROUND; i++) g.s = g.say('p0', 'vouch', 0, ['bot-2']).state;
  assert.equal(g.say('p0', 'vouch', 0, ['bot-2']).error?.code, 'tooChatty');
  assert.deepEqual([...new Set(g.s.chat.map((c) => c.round))], [0]);
  assert.equal(viewFor(g.s, 'bot-3').chat.length, CHAT_PER_ROUND, 'the bots see them');
  // Day 1 starts a clean allowance.
  g.s = reduce(g.s, { kind: 'nextPhase', by: 'p0', now: T0 }, g.rng).state;
  g.s = reduce(g.s, { kind: 'nextPhase', by: 'p0', now: T0 }, g.rng).state;
  assert.equal(g.s.round, 1);
  assert.ok(!g.say('p0', 'vouch', 0, ['bot-2']).error);
});

test('on day 0 bots start about a quarter of the accusations they start on day 1', () => {
  const rate = (g) => {
    let accuse = 0; let total = 0;
    for (const persona of PERSONALITIES) {
      for (const viewer of ['bot-1', 'bot-2', 'bot-3', 'bot-4']) {
        for (let seed = 1; seed <= 150; seed++) {
          const l = new BotMind(viewer, persona, createRng(seed * 7 + 3)).talk(viewFor(g.s, viewer), 'day');
          total++;
          if (l?.key === 'accuse') accuse++;
        }
      }
    }
    return accuse / total;
  };
  const d0 = rate(day(ROLES, {}, { dayZero: true }));
  const d1 = rate(day(ROLES));
  assert.ok(d1 > 0.1, `day 1 accusation rate ${d1}`);
  assert.ok(d0 < d1 * 0.5, `day 0 ${d0} vs day 1 ${d1}`);
  assert.ok(d0 > 0, 'day 0 still has some, since people do open with a hunch');
  assert.equal(DAY_BEFORE_ACCUSE, 0.25);
});

// Leak check: the day 0 rate is the same for every role, so it says nothing about who has a power.
test('the day 0 accusation rate is the same for every non-wolf role', () => {
  const roles = ['villager', 'seer', 'bodyguard', 'witch', 'hunter', 'prince', 'diseased', 'apprentice', 'poltergeist'];
  for (const persona of PERSONALITIES) {
    for (let seed = 1; seed <= 60; seed++) {
      const said = roles.map((role) => {
        const g = day(['villager', 'werewolf', 'villager', role, 'villager', 'villager', 'villager'], {}, { dayZero: true });
        const m = new BotMind('bot-3', persona, createRng(seed));
        return JSON.stringify([m.talk(viewFor(g.s, 'bot-3'), 'day'), m.talk(viewFor(g.s, 'bot-3'), 'day')]);
      });
      assert.equal(new Set(said).size, 1, `${persona} seed ${seed}: ${said.join(' | ')}`);
    }
  }
});

// Audit: every line that makes no sense before the first night is refused there, and never offered or chosen.
test('day 0: lines that lean on a death, a vote or a Seer result are refused for bots and people', () => {
  const refused = Object.keys(CHAT).filter((k) => !DAY_BEFORE_KEYS.includes(k));
  assert.deepEqual(refused.sort(), ['bait', 'claimClean', 'claimGuard', 'claimWolf', 'counter', 'counterGuard', 'detective', 'gotOne', 'oops', 'reportClean', 'reportWolf', 'rip', 'voteFor', 'voteSkip']);
  const ids = (key) => Array.from({ length: CHAT[key].ids }, (_, i) => ['bot-2', 'bot-3'][i]);
  for (const key of Object.keys(CHAT)) {
    const g = day(ROLES, {}, { dayZero: true });
    const want = DAY_BEFORE_KEYS.includes(key) ? null : 'badLine';
    assert.equal(g.botSay('bot-1', key, 0, ids(key)).error?.code ?? null, want, `botSay ${key} on day 0`);
    if (HUMAN_KEYS.includes(key)) assert.equal(g.say('p0', key, 0, ids(key)).error?.code ?? null, want, `say ${key} on day 0`);
    // From day 1 on, the same lines are fine again (the day phase is open).
    const d1 = day(ROLES);
    assert.equal(d1.botSay('bot-1', key, 0, ids(key)).error ?? null, null, `botSay ${key} on day 1`);
  }
  assert.deepEqual(humanKeys(0), ['accuse', 'agree', 'vouch', 'defend', 'protectMe', 'protectThem']);
  assert.deepEqual(humanKeys(1), [...HUMAN_KEYS]);
  assert.ok(validOnRound('voteSkip', 3) && !validOnRound('voteSkip', 0));
});

test('day 0: a bot of any role and personality only says lines that make sense there', () => {
  const roles = ['villager', 'werewolf', 'seer', 'jester', 'witch', 'hunter', 'bodyguard'];
  const seen = new Set();
  for (const role of roles) {
    for (const persona of PERSONALITIES) {
      for (let seed = 1; seed <= 60; seed++) {
        const g = day(['villager', 'werewolf', 'villager', role, 'villager', 'villager', 'villager'], {}, { dayZero: true });
        // Table talk to react to, and the bot under fire, so defend and agree paths run too.
        g.s = g.say('p0', 'accuse', 0, ['bot-3']).state;
        g.s = g.botSay('bot-1', 'accuse', 1, ['bot-4']).state;
        const m = new BotMind('bot-3', persona, createRng(seed));
        for (const moment of ['day', 'reply', 'day', 'reply', 'day']) {
          const l = m.talk(viewFor(g.s, 'bot-3'), moment);
          if (!l) continue;
          seen.add(l.key);
          assert.ok(DAY_BEFORE_KEYS.includes(l.key), `${role} ${persona} seed ${seed} said ${l.key} on day 0`);
        }
        const m2 = new BotMind('bot-4', persona, createRng(seed));
        const l2 = m2.talk(viewFor(g.s, 'bot-4'), 'day');
        if (l2) assert.ok(DAY_BEFORE_KEYS.includes(l2.key), `${l2.key} on day 0`);
      }
    }
  }
  for (const k of ['accuse', 'defend']) assert.ok(seen.has(k), `bots never said ${k} on day 0`);
});

// Bodyguard and protection lines (v1.33.0).
test('every line has English and Thai text for every wording', () => {
  try {
    for (const [key, c] of Object.entries(CHAT)) {
      for (let v = 0; v < c.variants; v++) {
        const k = `chat.${key}.${v}`;
        setLang('en'); const en = t(k, { a: 'A', b: 'B' });
        setLang('th'); const th = t(k, { a: 'A', b: 'B' });
        assert.notEqual(en, k, `en ${k}`);
        assert.notEqual(th, k, `th ${k}`);
        assert.notEqual(en, th, `${k} not translated`);
      }
    }
  } finally { setLang('en'); }
});

test('Bodyguard lines: refused on day 0, protection pleas allowed there', () => {
  for (const key of ['claimGuard', 'counterGuard']) assert.ok(!validOnRound(key, 0) && validOnRound(key, 1), key);
  for (const key of ['protectMe', 'protectThem']) assert.ok(validOnRound(key, 0) && validOnRound(key, 1), key);
  const g = day(ROLES, {}, { dayZero: true });
  assert.ok(!g.say('p0', 'protectMe', 0, []).error);
  assert.ok(!g.say('p0', 'protectThem', 2, ['bot-2']).error);
  assert.equal(g.say('p0', 'claimGuard', 0, ['bot-2']).error?.code, 'badLine');
  assert.equal(g.say('p0', 'protectThem', 0, []).error?.code, 'badLine', 'protectThem names one player');
  assert.equal(g.say('p0', 'protectMe', 0, ['bot-2']).error?.code, 'badLine', 'protectMe names nobody');
  assert.equal(g.say('p0', 'protectThem', 3, ['bot-2']).error?.code, 'badLine', 'only three wordings');
});

test('a Bodyguard claim is a soft signal: rivals and a repeated target look worse, nobody is cleared', () => {
  const mind = (g, viewer = 'bot-3') => { const m = new BotMind(viewer, 'sheep', createRng(1)); m.observe(viewFor(g.s, viewer)); return m; };
  const g = day(ROLES);
  const before = mind(g).score('bot-2');
  g.s = g.botSay('bot-4', 'claimGuard', 0, ['bot-2']).state;
  const one = mind(g);
  assert.equal(one.score('bot-2'), before, 'a guard claim does not clear its target');
  assert.equal(one.score('bot-4'), mind(day(ROLES)).score('bot-4'), 'one claimant alone is not marked');
  g.s = g.botSay('bot-5', 'claimGuard', 1, ['bot-1']).state;
  const two = mind(g);
  assert.ok(two.score('bot-4') > one.score('bot-4') && two.score('bot-5') > 0, 'two claimants cannot both be the Bodyguard');
  const rep = mind(g); rep.observe(viewFor(g.s, 'bot-3'));
  assert.equal(rep.score('bot-4'), two.score('bot-4'), 'reading the same feed twice marks nobody twice');
  // The same target two nights running is against the rules.
  const h = day(ROLES);
  h.s = h.botSay('bot-4', 'claimGuard', 0, ['bot-2']).state;
  h.s.round = 2;
  h.s = h.botSay('bot-4', 'claimGuard', 0, ['bot-2']).state;
  const flat = day(ROLES); flat.s = flat.botSay('bot-4', 'claimGuard', 0, ['bot-2']).state; flat.s.round = 2; flat.s = flat.botSay('bot-4', 'claimGuard', 0, ['bot-1']).state;
  assert.ok(mind(h).score('bot-4') > mind(flat).score('bot-4'), 'the same guard two nights running looks worse');
  // A counter calls the named player a liar and makes the named bot defend itself.
  const c = day(ROLES);
  c.s = c.say('p0', 'counterGuard', 0, ['bot-3']).state;
  const named = new BotMind('bot-3', 'sheep', createRng(1));
  named.observe(viewFor(c.s, 'bot-3'));
  assert.ok(named.underFire(), 'the named bot is under fire');
  assert.ok(mind(c, 'bot-4').score('bot-3') > mind(day(ROLES), 'bot-4').score('bot-3'));
});

test('a Bodyguard bot leans toward a player who asked for protection and is not suspected', () => {
  const picks = (asked) => {
    let hits = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const g = day(['villager', 'werewolf', 'bodyguard', 'villager', 'villager', 'villager']);
      if (asked) g.s = g.say('p0', 'protectThem', 0, ['bot-4']).state;
      const m = new BotMind('bot-2', 'sheep', createRng(seed));
      m.observe(viewFor(g.s, 'bot-2'));
      m.view = { ...m.view, round: 2 }; // the night after day 1
      const targets = g.s.players.filter((p) => p.alive).map((p) => p.id);
      if (m.night({ kind: 'bodyguard', required: true, targets, picks: 1 }).extra.targetId === 'bot-4') hits++;
    }
    return hits;
  };
  assert.ok(picks(true) >= picks(false) + 10, `${picks(true)} vs ${picks(false)}`);
});

test('whether a bot asks for protection depends on public facts, never on its role', () => {
  const roles = ['villager', 'werewolf', 'seer', 'bodyguard', 'witch', 'hunter', 'prince', 'diseased', 'apprentice', 'poltergeist', 'jester'];
  for (let seed = 1; seed <= 80; seed++) {
    const outs = new Set();
    for (const role of roles) {
      const g = day(['villager', 'werewolf', 'villager', role, 'villager', 'villager', 'villager']);
      g.s = g.say('p0', 'accuse', 0, ['bot-3']).state;
      const m = new BotMind('bot-3', 'hothead', createRng(seed));
      m.observe(viewFor(g.s, 'bot-3'));
      outs.add(JSON.stringify(m.pleaLine(g.s.players.filter((p) => p.alive && p.id !== 'bot-3').map((p) => p.id))));
    }
    assert.equal(outs.size, 1, `seed ${seed}: ${[...outs].join(' | ')}`);
  }
});

test('bots ask for protection now and then, and on day 0 too', () => {
  const seen = new Set();
  for (const dayZero of [false, true]) {
    for (let seed = 1; seed <= 400; seed++) {
      const g = day(ROLES, {}, { dayZero });
      g.s = g.say('p0', 'accuse', 0, ['bot-3']).state;
      const m = new BotMind('bot-3', 'hothead', createRng(seed));
      m.observe(viewFor(g.s, 'bot-3'));
      const l = m.pleaLine(['p0', 'bot-1', 'bot-2', 'bot-4', 'bot-5'].filter((id) => g.s.players.some((p) => p.id === id)));
      if (l) { seen.add(`${dayZero}:${l.key}`); assert.ok(!dayZero || DAY_BEFORE_KEYS.includes(l.key)); assert.ok(!g.botSay('bot-3', l.key, l.v, l.ids).error); }
    }
  }
  assert.ok(seen.has('false:protectMe') && seen.has('true:protectMe'), [...seen].join());
});
