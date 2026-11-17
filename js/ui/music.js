// Background music. One <audio> element lives outside #app, so re-rendering screens never touches it
// and the track never restarts between phases or games. Turning it off only pauses it, so turning it
// back on continues where it left off. The file is only fetched once a phone first turns music on.
import { APP_VERSION } from '../config.js';

let audio = null;
let on = false;

function tryPlay() {
  if (!on || !audio.paused) return;
  audio.play().catch(() => { /* blocked until a tap: sound.js retries on the next tap */ });
}

export function setMusic(want) {
  on = !!want;
  if (!on) { audio?.pause(); return; }
  if (!audio) {
    audio = new Audio(`assets/night-loop.mp3?v=${APP_VERSION}`);
    audio.loop = true; audio.preload = 'auto';
  }
  tryPlay();
}
