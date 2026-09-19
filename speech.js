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
 *
 * Callbacks, all optional:
 *   onWord(charIndex, charLength)  as each word begins
 *   onEnd()                        when the utterance finishes or is cancelled
 *
 * `onWord` comes from the API's `boundary` event, which not every engine
 * fires — Safari on iOS historically does not. Callers must work without it.
 */
export function speak(text, { rate = 0.9, onWord, onEnd } = {}) {
  const s = synth();
  if (!s) return null;
  s.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'nb-NO';
  if (voice) u.voice = voice;
  u.rate = rate;
  if (onWord) {
    u.addEventListener?.('boundary', (e) => {
      if (e.name && e.name !== 'word') return;
      onWord(e.charIndex ?? 0, e.charLength ?? 0);
    });
  }
  if (onEnd) {
    u.addEventListener?.('end', () => onEnd());
    u.addEventListener?.('error', () => onEnd());
  }
  s.speak(u);
  return u;
}

export function stopSpeaking() {
  synth()?.cancel();
}

/**
 * Where to get a Norwegian voice, for the platform we appear to be on. The
 * voice is an operating-system setting, not a browser one, which is the part
 * people get stuck on.
 */
export function voiceHelp() {
  const ua = globalThis.navigator?.userAgent ?? '';
  if (/iPhone|iPad|iPod/.test(ua)) {
    return 'iPhone og iPad: Innstillinger → Tilgjengelighet → Opplest innhold → Stemmer → Norsk. Last ned en stemme, og last siden på nytt.';
  }
  if (/Android/.test(ua)) {
    return 'Android: Innstillinger → Tilgjengelighet → Tekst-til-tale → Språk → Norsk. Last ned stemmen, og last siden på nytt.';
  }
  if (/Mac OS X/.test(ua)) {
    return 'Mac: Systeminnstillinger → Tilgjengelighet → Opplest innhold → Systemstemme → Tilpass → Norsk. Last ned en stemme, og last siden på nytt.';
  }
  if (/Windows/.test(ua)) {
    return 'Windows: Innstillinger → Tid og språk → Tale → Legg til stemmer → Norsk. Last ned stemmen, og last siden på nytt.';
  }
  return 'Stemmen er en innstilling i operativsystemet, ikke i nettleseren. Søk etter «tekst til tale» i innstillingene og legg til norsk.';
}

/** Does this engine report word boundaries? Only known after speaking once. */
export function supportsBoundary() {
  return boundarySeen;
}

let boundarySeen = false;

/** Called by the reader the first time a boundary event arrives. */
export function noteBoundary() {
  boundarySeen = true;
}
