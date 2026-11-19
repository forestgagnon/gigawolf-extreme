// Bot table talk: the lines a host-run bot can post during the day and the vote.
// A line is stored as { key, v, ids }: which kind of line, which wording (variant), and the players it names.
// Phones render it with t(`chat.<key>.<v>`, { a, b }), so every phone shows the same words in its own language.
// The text lives in js/i18n.js (English and Thai). `ids` is how many players the line names.
export const CHAT = Object.freeze({
  rip:        { ids: 1, variants: 4 }, // a night death
  accuse:     { ids: 1, variants: 4 }, // "I don't trust A"
  agree:      { ids: 1, variants: 3 }, // echoing someone else's accusation
  vouch:      { ids: 1, variants: 3 }, // "A is fine"
  defend:     { ids: 0, variants: 4 }, // when accused or most suspected
  bait:       { ids: 0, variants: 3 }, // "go on, vote me" (any role may say it; Jesters say it more)
  claimWolf:  { ids: 1, variants: 2 }, // "I'm the Seer, A is a wolf" (real Seer, or a wolf lying)
  claimClean: { ids: 1, variants: 2 }, // "I'm the Seer, A is not a wolf"
  reportWolf: { ids: 1, variants: 2 }, // a claimed Seer's later checks
  reportClean: { ids: 1, variants: 2 },
  counter:    { ids: 1, variants: 2 }, // "A is lying, I'm the real Seer"
  claimGuard: { ids: 1, variants: 2 }, // "I'm the Bodyguard, I guarded A last night" (people only; bots never claim it)
  counterGuard: { ids: 1, variants: 2 }, // "A is lying, I'm the real Bodyguard" (people only)
  protectMe:  { ids: 0, variants: 3 }, // "please protect me" (asks whoever can protect someone; names no role)
  protectThem: { ids: 1, variants: 3 }, // "please protect A"
  detective:  { ids: 2, variants: 2 }, // "A voted for B, and B was a villager"
  voteFor:    { ids: 1, variants: 3 }, // said just before voting
  voteSkip:   { ids: 0, variants: 2 },
  filler:     { ids: 0, variants: 5 },
  gotOne:     { ids: 1, variants: 2 }, // a revealed wolf died
  oops:       { ids: 1, variants: 2 }, // a revealed villager was voted out
});
export const CHAT_KEYS = Object.keys(CHAT);
export const CHAT_MAX = 60;          // lines kept in state (and sent in views); older ones drop off
export const CHAT_PER_ROUND = 4;     // most lines one bot may post in one round
// The lines a human can post from the Say sheet (js/ui/quickchat.js), in menu order. Only lines a person can
// stand behind on their own: no news reactions (rip, gotOne, oops), no Detective facts (a human has no
// verified record to quote). The engine checks key, wording and names but never the sender's role, so any
// role can post any of them, a lie included, just like a bot's claim. A human line has exactly the weight a
// bot's has: bots read chat by kind, never by who wrote it.
export const HUMAN_KEYS = Object.freeze([
  'accuse', 'agree', 'vouch', 'defend', 'protectMe', 'protectThem', 'bait', 'claimWolf', 'claimClean', 'counter', 'claimGuard', 'counterGuard', 'voteFor', 'voteSkip',
]);
// Day 0 ("The Day Before") has no deaths, no vote and no night behind it, so a line that leans on any of those
// makes no sense there. Audit of every kind of line:
//   allowed  accuse, agree, vouch, defend, protectMe, protectThem, filler
//            (a hunch, a reaction, a reply to being accused, a plea for tonight's protection, small talk)
//   refused  rip, gotOne, oops          nobody has died or been voted out
//            detective                  no vote to quote
//            claimWolf, claimClean, reportWolf, reportClean, counter
//                                       nobody can have a Seer result before night 1
//            claimGuard, counterGuard   nobody can have guarded anyone before night 1
//            bait, voteFor, voteSkip    there is no vote ("vote me", "I'm skipping this one")
// The engine refuses the refused kinds on round 0 for bots and people alike, the bot mind never picks them there,
// and the Say sheet does not list them.
export const DAY_BEFORE_KEYS = Object.freeze(['accuse', 'agree', 'vouch', 'defend', 'protectMe', 'protectThem', 'filler']);
export const validOnRound = (key, round) => round !== 0 || DAY_BEFORE_KEYS.includes(key);
// The Say sheet's menu for a round.
export const humanKeys = (round) => HUMAN_KEYS.filter((k) => validOnRound(k, round));

export const PERSONALITIES = Object.freeze(['sheep', 'hothead', 'quiet', 'detective']);

export function validChatLine(key, v, ids) {
  const c = CHAT[key];
  return !!c && Number.isInteger(v) && v >= 0 && v < c.variants && Array.isArray(ids) && ids.length === c.ids;
}
