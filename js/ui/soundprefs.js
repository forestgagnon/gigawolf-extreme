// Which sounds a phone plays. Pure (storage is passed in) so it can be tested in Node.
// Defaults: on for the host, off for everyone else, so a table full of phones in one room
// doesn't play the same track and lines over each other. Remote players can turn either on.
// The host's choice is kept across games; a player's choice only for the room they set it in.
const HOST_KEY = 'gigawolf.sound.host';
const PLAYER_KEY = 'gigawolf.sound.player';
const OLD_MUSIC_MUTE_KEY = 'gigawolf.music.muted'; // before 1.16.0: host music mute only

export function loadSoundPrefs(store, { isHost, roomCode }) {
  if (isHost) {
    const saved = store.get(HOST_KEY);
    if (saved) return { music: !!saved.music, narrator: !!saved.narrator };
    return { music: store.get(OLD_MUSIC_MUTE_KEY) !== true, narrator: true };
  }
  const saved = store.get(PLAYER_KEY);
  if (saved && saved.roomCode === roomCode) return { music: !!saved.music, narrator: !!saved.narrator };
  return { music: false, narrator: false };
}

export function saveSoundPrefs(store, { isHost, roomCode }, prefs) {
  const p = { music: !!prefs.music, narrator: !!prefs.narrator };
  if (isHost) store.set(HOST_KEY, p);
  else store.set(PLAYER_KEY, { roomCode, ...p });
}
