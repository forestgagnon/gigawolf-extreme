// speechSynthesis wrapper. iOS only allows speech after a user tap, so call unlock() from a tap.
import { tr, speechLang } from '../i18n.js';
let unlocked = false;
let on = false;
const synth = () => (typeof speechSynthesis !== 'undefined' ? speechSynthesis : null);

export function unlock() {
  const s = synth(); if (!s || unlocked) return;
  try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; s.speak(u); unlocked = true; } catch { /* ignore */ }
}

export function setNarrator(want) {
  on = !!want;
  if (!on) { try { synth()?.cancel(); } catch { /* ignore */ } }
}

export function speak(text) {
  const s = synth(); if (!s || !unlocked || !on) return;
  try { s.cancel(); const u = new SpeechSynthesisUtterance(tr(text)); u.lang = speechLang(); u.rate = 0.95; s.speak(u); } catch { /* ignore */ }
}
