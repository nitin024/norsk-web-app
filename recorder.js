// Recording the learner's own voice, for comparison against the read-aloud
// one. MediaRecorder, no upload: the clip lives in memory as a blob URL and
// is released when a new one replaces it.
//
// Everything here is best-effort. Microphone access can be refused, absent
// (an insecure origin drops getUserMedia entirely) or unsupported, and the
// caller must stay usable in every one of those cases.

let stream = null;
let recorder = null;
let chunks = [];
let lastUrl = null;

/** Can this browser record at all? Permission is a separate question. */
export function canRecord() {
  return Boolean(
    globalThis.navigator?.mediaDevices?.getUserMedia && typeof globalThis.MediaRecorder === 'function'
  );
}

/**
 * Start recording. Resolves once the microphone is live, or rejects with a
 * reason the caller can show: 'denied', 'unsupported' or 'failed'.
 */
export async function startRecording() {
  if (!canRecord()) throw new Error('unsupported');
  try {
    stream ??= await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    // NotAllowedError covers both a refusal and a dismissed prompt.
    throw new Error(err?.name === 'NotAllowedError' ? 'denied' : 'failed');
  }
  chunks = [];
  recorder = new MediaRecorder(stream);
  recorder.addEventListener('dataavailable', (e) => {
    if (e.data?.size) chunks.push(e.data);
  });
  recorder.start();
}

/** Stop and hand back a playable URL, or null if nothing was captured. */
export function stopRecording() {
  return new Promise((resolve) => {
    if (!recorder || recorder.state === 'inactive') return resolve(null);
    recorder.addEventListener(
      'stop',
      () => {
        // One clip at a time: the previous URL would leak otherwise.
        if (lastUrl) URL.revokeObjectURL(lastUrl);
        lastUrl = chunks.length ? URL.createObjectURL(new Blob(chunks, { type: chunks[0].type })) : null;
        resolve(lastUrl);
      },
      { once: true }
    );
    recorder.stop();
  });
}

export function isRecording() {
  return Boolean(recorder && recorder.state === 'recording');
}

/**
 * Release the microphone. Browsers show a recording indicator for as long as
 * a track is live, so holding one open after the user has left the view is
 * both rude and alarming.
 */
export function releaseMicrophone() {
  for (const track of stream?.getTracks() ?? []) track.stop();
  stream = null;
  recorder = null;
}
