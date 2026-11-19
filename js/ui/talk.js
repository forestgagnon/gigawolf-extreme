// Bot table talk on the day and vote screens. UI only: it reads view.chat, which every phone gets in full
// (the lines are public, like someone talking out loud at the table).
import { h } from './dom.js';
import { t } from '../i18n.js';
import { BOT_TAG } from '../game/setup.js';
import { sayChip } from './quickchat.js';

const SEER = new Set(['claimWolf', 'claimClean', 'reportWolf', 'reportClean', 'counter']);
const GUARD = new Set(['claimGuard', 'counterGuard']);
const short = (name) => (name?.endsWith(BOT_TAG) ? name.slice(0, -BOT_TAG.length) : name ?? '?');
let shown = { round: -1, seq: 0 }; // lines already on screen, so only new ones pop in
// Where the full talk sheet is scrolled. The sheet is rebuilt on every view, so it puts itself back: at the
// newest line while the reader is at the bottom, otherwise where they left it (until the next round).
let scroll = { round: -1, top: 0, stick: true, unread: false };

export function chatAuthor(view, c) { return short(view.players.find((p) => p.id === c.by)?.name); }

// The words of one line in this phone's language.
export function chatText(view, c) {
  const args = {};
  c.ids.forEach((id, i) => { args['ab'[i]] = short(view.players.find((p) => p.id === id)?.name); }); // the (bot) tag would repeat on every line
  return t(`chat.${c.key}.${c.v}`, args);
}

// Is there talk to show? Only once someone has spoken (smart bots do, dumb bots never do), in the day and
// while the vote is open. It never looks at the bot type, so an empty box can't give dumb bots away.
export function talkOn(view) {
  return (view.chat?.length ?? 0) > 0
    && (view.phase === 'day' || (view.phase === 'vote' && !view.voteResult));
}

function bubble(view, c, isNew) {
  return h('li', { class: `bubble${SEER.has(c.key) ? ' seer' : ''}${GUARD.has(c.key) ? ' guard' : ''}${isNew ? ' new' : ''}` },
    h('strong', null, chatAuthor(view, c)), ' ', chatText(view, c));
}

// On the screen: only the latest few lines, so the page stays short and nothing scrolls inside it.
// "All n" opens the whole round in a sheet (talkSheet), the only thing that scrolls while it is open.
export function talkFeed(view, ctx, { latest = 3 } = {}) {
  const chip = sayChip(view, ctx); // the small "Say…" control; null when you can't talk now (dead, night, vote over)
  if (!talkOn(view) && !chip) return null;
  const on = talkOn(view);
  const lines = on ? (view.chat ?? []).filter((c) => c.round === view.round) : [];
  if (shown.round !== view.round) shown = { round: view.round, seq: 0 };
  const seen = shown.seq;
  shown.seq = Math.max(seen, lines.at(-1)?.seq ?? 0);
  const open = () => { ctx.ui.talkOpen = true; scroll.stick = true; scroll.unread = false; ctx.rerender(); };
  return h('section', { class: 'talk', 'aria-label': t('chat.title') },
    h('div', { class: 'talk-head' },
      h('h3', null, t('chat.title')),
      h('div', { class: 'talk-btns' },
        lines.length > latest && h('button', { type: 'button', class: 'talk-all', onClick: open }, t('chat.seeAll', { n: lines.length })),
        chip)),
    lines.length
      ? h('ol', { class: 'bubbles inline', 'aria-live': 'polite' }, lines.slice(-latest).map((c) => bubble(view, c, c.seq > seen)))
      : !chip && h('p', { class: 'sub small' }, t('chat.empty'))); // with the Say chip the empty line is dropped, to save space
}

// The whole round in a bottom sheet (main.js adds it on top of the screen while ctx.ui.talkOpen).
// Returns the backdrop and the sheet, or null. The page behind does not scroll while it is open.
export function talkSheet(view, ctx) {
  const on = !!ctx.ui.talkOpen && talkOn(view);
  if (!on) ctx.ui.talkOpen = false;
  document.documentElement.classList.toggle('sheet-open', on);
  if (!on) return null;
  const lines = (view.chat ?? []).filter((c) => c.round === view.round);
  if (scroll.round !== view.round) scroll = { round: view.round, top: 0, stick: true, unread: false };
  const last = lines.at(-1)?.seq ?? 0;
  if (!scroll.stick && last > (scroll.lastSeq ?? last)) scroll.unread = true; // new lines below where the reader is
  scroll.lastSeq = last;
  const close = () => { ctx.ui.talkOpen = false; ctx.rerender(); };
  const jump = h('button', { type: 'button', class: 'talk-new', hidden: !scroll.unread, onClick: () => { scroll.stick = true; scroll.unread = false; jump.hidden = true; list.scrollTop = list.scrollHeight; } }, t('chat.newLines'));
  const list = h('ol', {
    class: 'bubbles full', tabindex: '0', 'aria-label': t('chat.title'),
    onScroll: () => {
      scroll.top = list.scrollTop;
      scroll.stick = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
      if (scroll.stick) { scroll.unread = false; jump.hidden = true; }
    },
  }, lines.map((c) => bubble(view, c, false)));
  // The sheet is attached right after it is built: put the scroll back before the frame is drawn.
  const { stick, top } = scroll;
  requestAnimationFrame(() => { list.scrollTop = stick ? list.scrollHeight : top; scroll.stick = stick; });
  return [
    h('div', { class: 'sheet-backdrop', onClick: close }),
    h('div', { class: 'sheet talk-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'talk-title' },
      h('h3', { id: 'talk-title' }, t('chat.title')),
      h('div', { class: 'talk-box' }, list, jump),
      h('button', { class: 'btn', type: 'button', onClick: close }, t('chat.close'))),
  ];
}
