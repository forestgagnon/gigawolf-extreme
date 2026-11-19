// A smart bot's head. One BotMind per bot per game, kept by HostBots in the host's page.
//
// Secrecy: a mind only ever reads the views HostBots hands it, which are exactly what that bot's phone would
// get (viewFor). It remembers what it has seen (public news, votes, table talk, its own Seer checks) and
// builds a suspicion score per player from that.
//
// Leak rule for table talk: what a bot says may depend on its role only where a human would make the same
// choice on purpose (claiming Seer, lying about it, not accusing a teammate). Whether it talks, when, and
// the kind of everyday line it picks come from its personality and the public situation, never its role.
import { CHAT } from '../game/chat.js';
import { isWolf } from '../game/roles.js';

// Personality knobs. talk: chance to speak at all; accuse/agree: appetite for those lines; follow: how much
// the crowd sways its vote; noise: how sloppy its reads are; skip: how readily it skips a vote; claim: how
// readily a real Seer goes public.
export const PERSONA = Object.freeze({
  sheep:     { talk: 0.5,  accuse: 0.25, agree: 0.8,  follow: 1.2, noise: 0.8, skip: 0.15, claim: 0.8, speed: 1.2 },
  hothead:   { talk: 0.95, accuse: 0.9,  agree: 0.35, follow: 0.3, noise: 1.3, skip: 0.04, claim: 0.95, speed: 0.6 },
  quiet:     { talk: 0.3,  accuse: 0.3,  agree: 0.2,  follow: 0.5, noise: 0.8, skip: 0.35, claim: 0.6, speed: 1.5 },
  detective: { talk: 0.7,  accuse: 0.6,  agree: 0.25, follow: 0.4, noise: 0.4, skip: 0.12, claim: 0.9, speed: 1 },
});
// On day 0 (The Day Before) nothing has happened yet, so an accusation has nothing behind it. Bots of every
// role and personality start those at this share of their usual rate. It depends only on the round.
export const DAY_BEFORE_ACCUSE = 0.25;
const LINES_PER_ROUND = 3; // the engine allows 4; a mind keeps one spare, for answering a person late
const CLAIM_KEYS = new Set(['claimWolf', 'claimClean', 'reportWolf', 'reportClean', 'counter']);
const POINT_KEYS = new Set(['accuse', 'agree', 'claimWolf', 'reportWolf', 'counter', 'counterGuard']);

export class BotMind {
  constructor(id, persona, rand = Math.random) {
    this.id = id;
    this.persona = PERSONA[persona] ? persona : 'sheep';
    this.k = PERSONA[this.persona];
    this.rand = rand;
    this.view = null;
    this.sus = new Map();        // id -> suspicion built from public evidence
    this.known = new Map();      // id -> isWolf, from own Seer checks
    this.claims = [];            // { by, target, wolf, round } from table talk
    this.claimants = new Set();  // everyone who has claimed Seer
    this.seenChat = 0; this.seenLog = 0;
    this.votes = new Map();      // round -> { votes, eliminatedId }
    this.settled = new Set();    // rounds whose vote was checked against revealed roles
    this.facts = [];             // detective facts { voter, victim }
    this.fakeChecked = new Set(); // proven fake claimants
    this.hunters = new Map();    // id -> lines that pointed at this bot or its pack (wolves use it at night)
    this.claimed = false;        // this bot went public as Seer (truly or not)
    this.announced = new Set();  // checks already told
    this.countered = new Set();  // claimants this bot already called liars
    this.guardClaims = [];       // { by, target, round } from "I'm the Bodyguard, I guarded A" (people only; no bot claims it)
    this.guardClaimants = new Set(); // everyone who has claimed Bodyguard, in a claim or a counter
    this.guardPairs = new Set(); // rival pairs already marked, so a repeat claim does not count twice
    this.pleas = new Map();      // id -> the round a plea to protect them was posted ("protect me", "protect A")
    this.day = { round: -1 };    // per-round memory
  }

  pick(arr) { return arr[Math.floor(this.rand() * arr.length)]; }
  chance(p) { return this.rand() < p; }
  noise() { return (this.rand() + this.rand() + this.rand() - 1.5) * this.k.noise; }
  variant(key) { return Math.floor(this.rand() * CHAT[key].variants); }
  line(key, ...ids) { return { key, v: this.variant(key), ids }; }

  get me() { return this.view.you; }
  get role() { return this.view.you.role; }
  get wolf() { return isWolf(this.role); }
  alive(id) { return !!this.view.players.find((p) => p.id === id)?.alive; }
  living() { return this.view.players.filter((p) => p.alive).map((p) => p.id); }
  teammates() { return new Set((this.me.private.teammates ?? []).map((t) => t.id)); }
  nameToId(name) { return this.view.players.find((p) => p.name === name)?.id ?? null; }
  bump(id, by) { if (id) this.sus.set(id, (this.sus.get(id) ?? 0) + by); }

  // ---------- memory ----------
  observe(view) {
    this.view = view;
    if (this.day.round !== view.round) this.day = { round: view.round, said: 0, mostSuspected: new Set(), accused: new Map(), done: new Set() };
    for (const r of view.you.private.seerLog ?? []) this.known.set(r.targetId, r.isWolf);
    // Public news (dawns, vote results).
    for (const { text } of view.log.slice(this.seenLog)) {
      const m = /^Most suspected: (.+)\.$/.exec(text);
      if (m) for (const id of m[1].split(' and ').map((n) => this.nameToId(n)).filter(Boolean)) { this.bump(id, 1); this.day.mostSuspected.add(id); }
      const pr = /^(.+?) is the Prince!/.exec(text);
      if (pr) this.bump(this.nameToId(pr[1]), -6);
    }
    this.seenLog = view.log.length;
    // Vote results (public unless the host hid them).
    if (view.voteResult && !this.votes.has(view.round)) this.votes.set(view.round, { votes: { ...view.voteResult.votes }, eliminatedId: view.voteResult.eliminatedId ?? null });
    this.settleVotes();
    // Table talk.
    for (const c of view.chat ?? []) {
      if (c.seq <= this.seenChat) continue;
      this.seenChat = c.seq;
      if (c.by === this.id) continue;
      const [a] = c.ids;
      if (c.key === 'claimGuard' || c.key === 'counterGuard') this.readGuard(c);
      if (c.key === 'protectMe') this.pleas.set(c.by, c.round);
      if (c.key === 'protectThem' && a) this.pleas.set(a, c.round);
      if (CLAIM_KEYS.has(c.key)) {
        this.claimants.add(c.by);
        if (c.key !== 'counter') this.claims.push({ by: c.by, target: a, wolf: c.key === 'claimWolf' || c.key === 'reportWolf', round: c.round });
        else if (a === this.id && this.role === 'seer') { this.fakeChecked.add(c.by); this.bump(c.by, 6); } // they call me, the Seer, a liar
        else this.bump(a, 1); // somebody is lying
      }
      if (POINT_KEYS.has(c.key) && a && (a === this.id || this.teammates().has(a))) this.hunters.set(c.by, (this.hunters.get(c.by) ?? 0) + 1);
      if (c.round === view.round && POINT_KEYS.has(c.key) && a) this.day.accused.set(a, (this.day.accused.get(a) ?? 0) + 1);
      if (c.key === 'accuse') this.bump(a, 0.3 * this.k.follow);
      if (c.key === 'agree') this.bump(a, 0.2 * this.k.follow);
      if (c.key === 'vouch') this.bump(a, -0.3);
    }
    this.checkClaims(); // after the newest talk, so a fresh lie is caught at once
  }

  // Once roles are public (role reveal on death), voters for a dead villager look worse, voters for a dead wolf better.
  settleVotes() {
    for (const [round, { votes, eliminatedId }] of this.votes) {
      if (this.settled.has(round) || !eliminatedId) continue;
      const role = this.view.players.find((p) => p.id === eliminatedId)?.role;
      if (!role) continue;
      this.settled.add(round);
      for (const [voter, target] of Object.entries(votes)) {
        if (target !== eliminatedId || voter === this.id) continue;
        this.bump(voter, isWolf(role) ? -0.6 : 0.8);
        if (!isWolf(role)) this.facts.push({ voter, victim: eliminatedId, round });
      }
    }
  }

  // Bodyguard talk. Nothing a Bodyguard says can be checked (the save looks like any quiet night), so it is only a
  // soft signal: two claimants cannot both be the one Bodyguard, the Bodyguard may not guard the same player two
  // nights running, and a counter says somebody is lying. A claim never clears its target.
  readGuard(c) {
    const [a] = c.ids;
    if (c.key === 'counterGuard') this.bump(a, 1);
    else {
      const prev = this.guardClaims.findLast((g) => g.by === c.by);
      if (prev && prev.target === a && prev.round === c.round - 1) this.bump(c.by, 2); // the same guard two nights running
      this.guardClaims.push({ by: c.by, target: a, round: c.round });
    }
    for (const other of this.guardClaimants) {
      const pair = [other, c.by].sort().join('|');
      if (other === c.by || this.guardPairs.has(pair)) continue;
      this.guardPairs.add(pair);
      this.bump(other, 1); this.bump(c.by, 1);
    }
    this.guardClaimants.add(c.by);
  }

  // A claim proven wrong by a revealed role marks the claimant as a liar.
  checkClaims() {
    for (const c of this.claims) {
      if (this.fakeChecked.has(c.by)) continue;
      const role = this.view.players.find((p) => p.id === c.target)?.role;
      const knownWolf = c.target === this.id ? this.wolf : this.known.has(c.target) ? this.known.get(c.target) : role ? isWolf(role) : null;
      if (knownWolf == null) continue;
      if (knownWolf !== c.wolf) { this.fakeChecked.add(c.by); this.bump(c.by, 6); }
    }
  }

  // ---------- reasoning ----------
  // How wolfy a player looks to this bot. Higher = more suspicious.
  score(id) {
    if (id === this.id) return -Infinity;
    if (this.known.has(id)) return this.known.get(id) ? 50 : -50;
    let s = this.sus.get(id) ?? 0;
    const claimants = [...this.claimants].filter((c) => !this.fakeChecked.has(c));
    const trust = (c) => (this.fakeChecked.has(c) || this.known.get(c) ? 0 : 1 / Math.max(1, claimants.length));
    for (const c of this.claims) if (c.target === id && c.by !== this.id) s += (c.wolf ? 3 : -2.5) * trust(c.by);
    if (this.fakeChecked.has(id)) s += 4;
    else if (claimants.length >= 2 && claimants.includes(id)) s += 1.5; // one of them is lying
    return s;
  }

  // What the table seems to think right now (public only): today's pointing in chat, the suspicion line, claims.
  crowd(id) {
    let c = (this.day.accused.get(id) ?? 0) + (this.day.mostSuspected.has(id) ? 1.5 : 0);
    for (const cl of this.claims) if (cl.target === id && cl.wolf && !this.fakeChecked.has(cl.by)) c += 2;
    return c;
  }

  best(ids, f) {
    let top = null; let v = -Infinity;
    for (const id of ids) { const x = f(id) + this.noise(); if (x > v) { v = x; top = id; } }
    return top == null ? null : { id: top, v };
  }

  // The player this bot would most like gone. Wolves aim at whoever the village is already after, never a teammate.
  target(ids) {
    const mates = this.teammates();
    if (this.wolf) {
      const others = ids.filter((id) => !mates.has(id));
      return this.best(others, (id) => this.crowd(id) * 1.2 + (this.claimants.has(id) && !mates.has(id) ? 2 : 0));
    }
    return this.best(ids, (id) => this.score(id) + this.k.follow * 0.6 * this.crowd(id));
  }

  // ---------- actions ----------
  // Same contract as botAction in js/dev/bots.js: { kind, extra }, null, or 'wait'.
  act(view) {
    this.observe(view);
    const p = view.prompt;
    if (view.phase === 'shot') return p?.kind === 'shoot' ? { kind: 'shoot', extra: { targetId: (this.target(p.targets) ?? { id: this.pick(p.targets) }).id } } : null;
    if (!view.you.alive) {
      if (view.phase === 'vote' && p?.haunt && !p.done) {
        const t = this.target(p.targets);
        return { kind: 'vote', extra: { targetId: t && t.v > 1.2 ? t.id : this.chance(0.5) ? 'pass' : 'skip' } };
      }
      return null;
    }
    if (view.phase === 'reveal') return { kind: 'ready', extra: {} };
    if (!p || p.done) return null;
    if (view.phase === 'night') return this.night(p);
    if (view.phase === 'vote') return { kind: 'vote', extra: { targetId: this.voteChoice(p.targets) } };
    return null;
  }

  night(p) {
    const r = this.view.round;
    if (p.kind === 'witch') {
      if (p.healTargets === null) return 'wait';
      const heals = p.healTargets ?? [];
      const keyClaimant = heals.find((id) => this.claimants.has(id) && this.score(id) < 1);
      const healId = heals.includes(this.id) ? this.id : keyClaimant ?? (heals.length && this.chance(r <= 2 ? 0.55 : 0.35) ? this.pick(heals) : null);
      if (healId) return { kind: 'nightPick', extra: { targetId: `heal:${healId}` } };
      const t = p.canPoison && p.targets.length ? this.best(p.targets, (id) => this.score(id)) : null;
      if (t && (t.v >= 2.5 ? this.chance(0.8) : t.v >= 1.2 && r >= 3 && this.chance(0.35))) return { kind: 'nightPick', extra: { targetId: `poison:${t.id}` } };
      return { kind: 'nightPick', extra: { targetId: 'pass' } };
    }
    if (!p.required) { // no night power (or wolves too sick to kill): tell the village who you suspect
      if (p.noKill || !p.targets.length) return { kind: 'nightPick', extra: { targetId: null } };
      const t = this.target(p.targets);
      return { kind: 'nightPick', extra: { targetId: t && (t.v > 0.3 || this.chance(0.6)) ? t.id : null } };
    }
    const t = p.targets;
    if (this.wolf) return { kind: 'nightPick', extra: this.wolfPick(t, p.picks) };
    if (this.role === 'seer') {
      const fresh = t.filter((id) => !this.known.has(id));
      const c = this.best(fresh.length ? fresh : t, (id) => this.score(id) + (this.claimants.has(id) ? 1 : 0));
      return { kind: 'nightPick', extra: { targetId: c.id } };
    }
    if (this.role === 'bodyguard') {
      const seer = t.find((id) => this.claimants.has(id) && this.score(id) < 1);
      if (seer && this.chance(0.8)) return { kind: 'nightPick', extra: { targetId: seer } };
      // Somebody asked for protection today and this bot does not suspect them. Anyone may ask, wolves included.
      const asked = t.filter((id) => this.pleas.get(id) === r - 1 && this.score(id) < 0.5);
      if (asked.length && this.chance(0.5)) return { kind: 'nightPick', extra: { targetId: this.best(asked, (id) => -this.score(id)).id } };
      if (t.includes(this.id) && this.chance(0.4)) return { kind: 'nightPick', extra: { targetId: this.id } };
      const c = this.best(t, (id) => -this.score(id));
      return { kind: 'nightPick', extra: { targetId: c.id } };
    }
    return { kind: 'nightPick', extra: { targetId: this.pick(t) } };
  }

  // Wolves follow a teammate's pick if there is one; otherwise go for a claimed Seer, then whoever is
  // hunting the pack, then a trusted (influential) villager.
  wolfPick(targets, picks) {
    const mates = this.me.private.teammates ?? [];
    const lead = mates.find((m) => m.pick && targets.includes(m.pick));
    const rank = (id) => (this.claimants.has(id) ? 6 : 0) + (this.hunters.get(id) ?? 0) * 2 - (this.sus.get(id) ?? 0) * 0.5;
    const first = lead?.pick ?? this.best(targets, rank).id;
    if (picks !== 2) return { targetId: first };
    const rest = targets.filter((x) => x !== first);
    const second = (lead?.pick2 && rest.includes(lead.pick2)) ? lead.pick2 : this.best(rest, rank).id;
    return { targetId: first, targetId2: second };
  }

  voteChoice(targets) {
    if (this.role === 'jester') return this.chance(0.2) ? 'skip' : this.pick(targets);
    const mates = this.teammates();
    const t = this.target(targets);
    if (!t) return 'skip';
    if (this.wolf) {
      const hot = this.crowd(t.id) > 0;
      // The village is after a teammate: usually save them by voting elsewhere, sometimes throw them under the bus.
      const mateUnder = targets.find((id) => mates.has(id) && this.crowd(id) >= 2);
      if (mateUnder && this.chance(0.15)) return mateUnder;
      if (!hot && this.chance(0.25)) return 'skip';
      return t.id;
    }
    const sure = t.v > 0.8;
    if (!sure && this.chance(this.k.skip * 2)) return 'skip';
    return t.id;
  }

  // ---------- table talk ----------
  // A line to say now, or null. moment: 'day' (talking while the day is on), 'reply' (reacting to a line
  // that just appeared), or 'vote' (handled by voteLine).
  // spare: an answer to a person's line may use the one line a mind keeps back (the engine allows one more).
  talk(view, moment = 'day', spare = false) {
    this.observe(view);
    if (!view.you.alive || this.day.said >= LINES_PER_ROUND + (spare ? 1 : 0)) return null;
    if (view.phase !== 'day' && !(view.phase === 'vote' && !view.voteResult)) return null;
    const l = (moment === 'reply' ? this.reply() : this.dayLine());
    if (l) this.day.said++;
    return l;
  }

  once(tag) { if (this.day.done.has(tag)) return false; this.day.done.add(tag); return true; }

  underFire() {
    return this.day.mostSuspected.has(this.id) || (this.day.accused.get(this.id) ?? 0) > 0;
  }

  // Seer business first: a real Seer goes public or reports, and calls out a fake; a wolf may fight a claim.
  seerTalk() {
    const r = this.view.round;
    if (r === 0) return null; // The Day Before: no checks, no claims, no counterclaims
    const living = new Set(this.living());
    if (this.role === 'seer') {
      const fake = [...this.fakeChecked].find((c) => living.has(c) && !this.countered.has(c));
      const results = [...this.known].filter(([id]) => !this.announced.has(id));
      const wolfFound = results.find(([id, w]) => w && living.has(id));
      if (!this.claimed) {
        if (fake && this.chance(0.85)) { this.claimed = true; this.countered.add(fake); return this.line('counter', fake); }
        const livingResults = results.filter(([id]) => living.has(id));
        const go = (wolfFound && this.chance(this.k.claim)) || (this.underFire() && livingResults.length && this.chance(0.7));
        if (!go) return null;
        this.claimed = true;
        const [id, w] = wolfFound ?? livingResults.at(-1);
        this.announced.add(id);
        return this.line(w ? 'claimWolf' : 'claimClean', id);
      }
      if (fake && this.chance(0.7)) { this.countered.add(fake); return this.line('counter', fake); }
      const next = wolfFound ?? results.filter(([id]) => living.has(id)).at(-1);
      if (!next) return null;
      this.announced.add(next[0]);
      return this.line(next[1] ? 'reportWolf' : 'reportClean', next[0]);
    }
    if (this.wolf) {
      const mates = this.teammates();
      const packClaimed = [...mates].some((m) => this.claimants.has(m)); // one fake Seer per pack is enough
      const hunter = this.claims.find((c) => c.wolf && (mates.has(c.target) || c.target === this.id) && living.has(c.by) && !this.countered.has(c.by));
      if (hunter && !this.claimed && !packClaimed && this.chance(0.55)) { this.claimed = true; this.countered.add(hunter.by); return this.line('counter', hunter.by); }
      if (this.claimed && this.once('fakeReport')) {
        const victims = this.living().filter((id) => !mates.has(id) && id !== this.id);
        const real = victims.find((id) => this.claimants.has(id));
        const pickId = real ?? (victims.length ? this.pick(victims) : null);
        return pickId && this.chance(0.7) ? this.line('reportWolf', pickId) : null;
      }
      // Rarely, a wolf opens with a fake claim when nobody has claimed yet.
      if (!this.claimed && !packClaimed && !this.claimants.size && r >= 2 && this.chance(0.05)) {
        const victims = this.living().filter((id) => !mates.has(id) && id !== this.id);
        if (!victims.length) return null;
        this.claimed = true;
        return this.line('claimWolf', this.best(victims, (id) => this.score(id) * -0.2 + (this.day.accused.get(id) ?? 0)).id);
      }
    }
    return null;
  }

  dayLine() {
    const seer = this.seerTalk();
    if (seer) return seer;
    if (!this.chance(this.day.said === 0 ? this.k.talk : this.k.talk * 0.5)) return null;
    const v = this.view; const living = this.living(); const mates = this.teammates();
    // Reactions to the news.
    const deadTonight = v.players.filter((p) => !p.alive && v.announce.some((a) => a === `${p.name} was killed in the night.` || a.startsWith(`${p.name} was killed in the night. `)));
    if (deadTonight.length && this.once('rip') && this.chance(0.35)) return this.line('rip', this.pick(deadTonight).id);
    const lastVote = this.votes.get(v.round - 1);
    const out = lastVote?.eliminatedId && v.players.find((p) => p.id === lastVote.eliminatedId);
    if (out?.role && this.once('reaction') && this.chance(0.4)) return this.line(isWolf(out.role) ? 'gotOne' : 'oops', out.id);
    const early = v.round === 0; // The Day Before has no vote, so nobody baits one (see DAY_BEFORE_KEYS)
    if (this.underFire() && this.once('defend')) return !early && this.role === 'jester' && this.chance(0.6) ? this.line('bait') : this.line('defend');
    if (!early && this.role === 'jester' && this.once('bait') && this.chance(0.35)) return this.line('bait');
    if (!early && this.persona === 'hothead' && this.once('bait') && this.chance(0.06)) return this.line('bait');
    if (this.persona === 'detective') {
      const f = this.facts.filter((x) => living.includes(x.voter) && x.voter !== this.id && !mates.has(x.voter)).at(-1);
      if (f && this.once(`fact:${f.voter}`) && this.chance(0.7)) return this.line('detective', f.voter, f.victim);
    }
    const others = living.filter((id) => id !== this.id);
    const accusedToday = [...this.day.accused.keys()].filter((id) => others.includes(id) && !mates.has(id) && (this.wolf || this.score(id) > -1));
    if (accusedToday.length && this.chance(this.k.agree) && this.once('agree')) return this.line('agree', this.pick(accusedToday));
    const t = this.target(others);
    if (t && this.chance(this.k.accuse * (v.round === 0 ? DAY_BEFORE_ACCUSE : 1)) && this.once('accuse')) return this.line('accuse', t.id);
    if (this.chance(0.12) && this.once('vouch')) {
      const pool = others.filter((id) => !mates.has(id));
      const c = this.best(pool, (id) => -this.score(id));
      if (c && c.v > 0.5) return this.line('vouch', c.id);
    }
    const plea = this.pleaLine(others);
    if (plea) return plea;
    if (this.once('filler') && this.chance(0.4)) return this.line('filler');
    return null;
  }

  // "Please protect me / A": asking whoever can protect someone, naming no role. The rule uses only public facts and
  // this bot's own reads, never its role: a public Seer claimant (real or fake) asks for itself, a bot under fire
  // sometimes does, a bot that trusts a claimed Seer asks for them, and everyone has a small base rate.
  pleaLine(others) {
    if (!this.once('plea')) return null;
    if (this.claimed && this.chance(0.6)) return this.line('protectMe');
    if (this.underFire() && this.chance(0.15)) return this.line('protectMe');
    const trusted = others.filter((id) => this.claimants.has(id) && !this.fakeChecked.has(id) && this.score(id) < 1);
    if (trusted.length && this.chance(0.2)) return this.line('protectThem', this.pick(trusted));
    return this.chance(0.03) ? this.line('protectMe') : null;
  }

  // Reacting to a line that just appeared: Seer fights, defending oneself, joining a pile-on.
  reply() {
    const seer = this.seerTalk();
    if (seer) return seer;
    if (this.underFire() && this.once('defend') && this.chance(0.75)) return this.view.round !== 0 && this.role === 'jester' && this.chance(0.6) ? this.line('bait') : this.line('defend');
    const mates = this.teammates();
    const latest = (this.view.chat ?? []).at(-1);
    const a = latest?.ids?.[0];
    if (latest && latest.by !== this.id && (latest.key === 'accuse' || latest.key === 'claimWolf') && a && a !== this.id && this.alive(a)
      && !(this.wolf && mates.has(a)) && (this.wolf || this.score(a) > -1) && this.chance(this.k.agree * 0.6) && this.once('agree')) {
      return this.line('agree', a);
    }
    return null;
  }

  // Said just before voting (bots announce their vote out loud, like people do). Never a lie.
  voteLine(view, targetId) {
    if (!view.you.alive || view.prompt?.haunt || this.day.said >= LINES_PER_ROUND || !this.chance(this.k.talk * 0.5)) return null;
    this.day.said++;
    return targetId === 'skip' ? this.line('voteSkip') : this.line('voteFor', targetId);
  }
}
