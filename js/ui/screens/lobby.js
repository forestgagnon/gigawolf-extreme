import { h, playerList } from '../dom.js';
import { MIN_PLAYERS, COUNT_KEYS, MAX_BOTS, isBotId } from '../../game/setup.js';
import { t, tr } from '../../i18n.js';
import { formatRoomCode } from '../../config.js';

function stepper(label, value, onChange, min = 0, max = 15) {
  return h('div', { class: 'row' },
    h('span', null, label),
    h('div', { class: 'stepper' },
      h('button', { class: 'btn small', 'aria-label': t('lobby.fewer', { label }), disabled: value <= min, onClick: () => onChange(value - 1) }, '−'),
      h('span', { class: 'num' }, value),
      h('button', { class: 'btn small', 'aria-label': t('lobby.more', { label }), disabled: value >= max, onClick: () => onChange(value + 1) }, '+'),
    ));
}
// Bots (host only): a number box plus -/+, 0 to MAX_BOTS. They run inside the host's page.
function botsRow(count, onChange) {
  const clamp = (v) => Math.max(0, Math.min(MAX_BOTS, Math.floor(Number(v) || 0)));
  return h('div', { class: 'row' },
    h('span', null, t('lobby.bots')),
    h('div', { class: 'stepper' },
      h('button', { class: 'btn small', 'aria-label': t('lobby.fewer', { label: t('lobby.bots') }), disabled: count <= 0, onClick: () => onChange(clamp(count - 1)) }, '−'),
      h('input', { class: 'botcount', type: 'number', inputmode: 'numeric', min: 0, max: MAX_BOTS, value: count, 'aria-label': t('lobby.bots'),
        onChange: (e) => onChange(clamp(e.target.value)) }),
      h('button', { class: 'btn small', 'aria-label': t('lobby.more', { label: t('lobby.bots') }), disabled: count >= MAX_BOTS, onClick: () => onChange(clamp(count + 1)) }, '+'),
    ));
}
// A setting with an on/off switch; the whole row is tappable.
function toggle(label, on, onChange) {
  return h('label', { class: 'row toggle' }, h('span', null, label),
    h('input', { type: 'checkbox', role: 'switch', checked: on ? true : null, onChange: (e) => onChange(e.target.checked) }));
}
// Rows in a group get alternating backgrounds.
const rows = (...kids) => h('div', { class: 'rows' }, ...kids);

export function lobbyScreen(view, ctx) {
  const s = view.settings; const n = view.players.length;
  const link = `${location.origin}${location.pathname}?join=${view.roomCode}`;
  const set = (patch) => ctx.send('settings', { patch });
  // Presets leave out roles they don't use; show those as 0.
  const c = s.counts && Object.fromEntries(COUNT_KEYS.map((k) => [k, s.counts[k] ?? 0]));
  const setCounts = (k, val) => {
    const next = { ...c, [k]: val };
    if (k !== 'villagers') next.villagers = n - COUNT_KEYS.filter((x) => x !== 'villagers').reduce((sum, x) => sum + next[x], 0);
    set({ counts: next });
  };
  const host = view.isHost;
  const bots = view.players.filter((p) => isBotId(p.id)).length;
  return h('main', { class: 'screen lobby' },
    h('p', { class: 'sub' }, t('lobby.roomCode')),
    h('div', { class: 'roomcode', 'aria-label': `${t('lobby.roomCode')} ${view.roomCode.split('').join(' ')}` }, formatRoomCode(view.roomCode)),
    h('button', { class: 'btn small', onClick: async (e) => {
      try { if (navigator.share) await navigator.share({ url: link, title: 'Gigawolf Extreme' }); else { await navigator.clipboard.writeText(link); e.target.textContent = t('lobby.copied'); } } catch { /* cancelled */ }
    } }, t('lobby.share')),
    h('h2', null, t('lobby.players', { n })),
    playerList(bots > 0 ? { ...view, players: view.players.filter((p) => !isBotId(p.id)) } : view),
    bots > 0 && h('p', { class: 'sub' }, t('lobby.botsList', { n: bots })),
    host
      ? h('section', { class: 'card settings' },
          h('h2', null, t('lobby.setup')),
          h('div', { class: 'modeswitch', role: 'group', 'aria-label': t('lobby.mode') },
            h('button', { class: `btn small${s.randomize ? '' : ' selected'}`, 'aria-pressed': String(!s.randomize), onClick: () => s.randomize && set({ counts: null }) }, t('lobby.modeManual')),
            h('button', { class: `btn small${s.randomize ? ' selected' : ''}`, 'aria-pressed': String(s.randomize), onClick: () => !s.randomize && set({ randomize: true }) }, t('lobby.modeRandom'))),
          s.randomize
            ? h('div', { class: 'randombanner' },
                h('strong', null, t('lobby.randomOn')),
                h('p', null, t('lobby.randomWhat')),
                h('p', null, t('lobby.randomHint')),
                rows(toggle(t('lobby.noVillagers'), !!s.noVillagers, (v) => set({ noVillagers: v }))),
                s.noVillagers && h('p', null, t('lobby.noVillagersHint')))
            : h('p', { class: 'sub small' }, t('lobby.manualHint')),
          c && rows(
            stepper(t('lobby.wolves'), c.wolves, (v) => setCounts('wolves', v), 0, Math.max(7, Math.ceil(n / 2))),
            stepper(t('lobby.seer'), c.seer, (v) => setCounts('seer', v), c.apprentice, 3),
            stepper(t('lobby.bodyguard'), c.bodyguard, (v) => setCounts('bodyguard', v), 0, 3),
            ['wolfcub', 'hunter', 'witch', 'prince', 'diseased', 'apprentice', 'poltergeist', 'jester'].map((k) =>
              stepper(t(`lobby.${k}`), c[k], (v) => setCounts(k, v), 0, k === 'apprentice' ? Math.min(3, c.seer) : 3)),
            h('div', { class: 'row total' }, h('span', null, t('lobby.villagers')), h('span', { class: 'num' }, c.villagers))),
          c && c.apprentice > 0 && h('p', { class: 'sub small' }, t('lobby.apprenticeHint')),
          !s.randomize && h('button', { class: 'btn small', onClick: () => set({ counts: null }) }, t('lobby.reset')),
          rows(botsRow(bots, (v) => ctx.setBots(v))),
          bots > 0 && h('p', { class: 'sub small' }, t('lobby.botsHint')),
          h('h3', null, t('lobby.options')),
          rows(
            toggle(t('lobby.revealOnDeath'), s.revealOnDeath, (v) => set({ revealOnDeath: v })),
            toggle(t('lobby.hideVotes'), !!s.hideVotes, (v) => set({ hideVotes: v })),
            toggle(t('lobby.selfProtect'), s.bodyguardSelfProtect, (v) => set({ bodyguardSelfProtect: v })),
            toggle(t('lobby.narration'), s.narration, (v) => set({ narration: v }))),
          view.setup && !view.setup.ok && h('p', { class: 'error' }, view.setup.errors.map(tr).join(' ')),
          h('button', { class: 'btn primary', disabled: !(view.setup?.ok) || n < MIN_PLAYERS, onClick: () => ctx.send('startGame') },
            n < MIN_PLAYERS ? t('lobby.needMore', { n: MIN_PLAYERS - n, s: MIN_PLAYERS - n === 1 ? '' : 's' }) : s.randomize ? t('lobby.startRandom') : t('lobby.start')))
      : h('p', { class: 'sub' }, t('lobby.waiting')),
  );
}
