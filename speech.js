// Read-aloud via the Web Speech API.
//
// No audio files, no backend: iOS, macOS and Chrome all ship a Norwegian
// voice. Quality varies, but hearing the rhythm of a sentence is what a
// muntlig candidate needs most, and it costs nothing to offer.

let voice = null;
let voicesLoaded = false;

function synth() {
  return globalThis.speechSynthesis ?? null;
}

/** True when the browser can speak at all. Voices may still be loading. */
export function canSpeak() {
  return Boolean(synth()) && typeof globalThis.SpeechSynthesisUtterance === 'function';
}

/**
 * Pick the best Norwegian voice: bokmål first, then any Norwegian, then null
 * (the utterance still carries lang="nb-NO", so the engine may fall back).
 * Chrome loads voices asynchronously; we re-pick on `voiceschanged`.
 */
function pickVoice() {
  const list = synth()?.getVoices?.() ?? [];
  if (list.length === 0) return null;
  voicesLoaded = true;
  const score = (v) => {
    const l = v.lang.toLowerCase().replace('_', '-');
    if (l === 'nb-no' || l === 'nb') return 3;
    if (l.startsWith('no')) return 2;
    if (l.startsWith('nn')) return 1;
    return 0;
  };
  return list.reduce((best, v) => (score(v) > score(best ?? { lang: '' }) ? v : best), null);
}

if (canSpeak()) {
  voice = pickVoice();
  synth().addEventListener?.('voiceschanged', () => {
    voice = pickVoice();
  });
}

/** True if a Norwegian voice is actually available (after voices load). */
export function hasNorwegianVoice() {
  if (!voicesLoaded) voice = pickVoice();
  return voice !== null;
}

/**
 * Speak one text. Any speech in progress is cut off first — tapping a second
 * sentence should not queue it behind the first. Slightly slow, for learners.
 */
export function speak(text, { rate = 0.9 } = {}) {
  const s = synth();
  if (!s) return;
  s.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'nb-NO';
  if (voice) u.voice = voice;
  u.rate = rate;
  s.speak(u);
}

export function stopSpeaking() {
  synth()?.cancel();
}
