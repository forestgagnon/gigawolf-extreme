import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSoundPrefs, saveSoundPrefs } from '../js/ui/soundprefs.js';

const memStorage = () => { const m = new Map(); return { get: (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), set: (k, v) => m.set(k, JSON.stringify(v)), remove: (k) => m.delete(k) }; };
const HOST = { isHost: true, roomCode: null };
const room = (roomCode) => ({ isHost: false, roomCode });

test('sound defaults: on for the host, off for players', () => {
  const s = memStorage();
  assert.deepEqual(loadSoundPrefs(s, HOST), { music: true, narrator: true });
  assert.deepEqual(loadSoundPrefs(s, room('ABCDEFGH')), { music: false, narrator: false });
});

test('host choices are kept across games', () => {
  const s = memStorage();
  saveSoundPrefs(s, HOST, { music: false, narrator: true });
  assert.deepEqual(loadSoundPrefs(s, HOST), { music: false, narrator: true });
  assert.deepEqual(loadSoundPrefs(s, room('ABCDEFGH')), { music: false, narrator: false }, 'host choice does not leak to playing');
});

test('a player choice lasts only for the room it was set in', () => {
  const s = memStorage();
  saveSoundPrefs(s, room('ABCDEFGH'), { music: true, narrator: false });
  assert.deepEqual(loadSoundPrefs(s, room('ABCDEFGH')), { music: true, narrator: false });
  assert.deepEqual(loadSoundPrefs(s, room('ZZZZYYYY')), { music: false, narrator: false });
  assert.deepEqual(loadSoundPrefs(s, HOST), { music: true, narrator: true }, 'player choice does not change host defaults');
});

test('old host music mute carries over', () => {
  const s = memStorage();
  s.set('gigawolf.music.muted', true);
  assert.deepEqual(loadSoundPrefs(s, HOST), { music: false, narrator: true });
});
