// Review state: which words the reader looked up, and when to show them again.
// Feeds the "Øving" view.
//
// Storage is localStorage, best-effort, keyed by entry id (the stable key —
// never the lemma, which may be renamed). Shape:
//
//   { [entryId]: { n: taps, box: 0..5, last: ms, due: ms, para: paraId } }
//
// Scheduling is a Leitner ladder: each "Kunne det" moves a word up one box
// and pushes its next appearance out by that box's interval; "Øv mer" drops
// it back to box 0, due now. Looking a word up again in a text also drops it
// back — a lookup is evidence it was not known. A word in box 4 or higher
// counts as learnt, but it still comes back after its interval; nothing is
// ever retired for good.

const KEY = 'norsk:review';
const DAY = 24 * 60 * 60 * 1000;

// Days until the next review, by box. Box 0 is due immediately.
export const INTERVALS_DAYS = [0, 1, 3, 7, 14, 30];
export const MAX_BOX = INTERVALS_DAYS.length - 1;
export const LEARNT_BOX = 4;

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    const data = raw ? JSON.parse(raw) : {};
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function write(data) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* private mode, quota — review is a convenience, never a blocker */
  }
}

/** Records written before scheduling existed have no `due`: treat as due. */
function dueOf(r) {
  return typeof r.due === 'number' ? r.due : r.last ?? 0;
}

/** Record a lookup from the reader. Dictionary browsing does not count. */
export function recordLookup(entryId, paraId) {
  if (!entryId) return;
  const now = Date.now();
  const data = read();
  const cur = data[entryId] ?? { n: 0, box: 0, last: 0, due: now, para: null };
  data[entryId] = { ...cur, n: cur.n + 1, box: 0, last: now, due: now, para: paraId ?? cur.para };
  write(data);
}

/** Every recorded word, most recently touched first. */
export function allLookups() {
  return Object.entries(read())
    .map(([entryId, v]) => ({ entryId, ...v, due: dueOf(v) }))
    .sort((a, b) => b.last - a.last);
}

/** Words whose review is due now, longest overdue first. */
export function dueLookups(now = Date.now()) {
  return allLookups()
    .filter((r) => r.due <= now)
    .sort((a, b) => a.due - b.due);
}

export function markKnown(entryId, now = Date.now()) {
  const data = read();
  if (!data[entryId]) return;
  const box = Math.min(MAX_BOX, (data[entryId].box ?? 0) + 1);
  data[entryId] = { ...data[entryId], box, last: now, due: now + INTERVALS_DAYS[box] * DAY };
  write(data);
}

export function markAgain(entryId, now = Date.now()) {
  const data = read();
  if (!data[entryId]) return;
  data[entryId] = { ...data[entryId], box: 0, last: now, due: now };
  write(data);
}

export function forget(entryId) {
  const data = read();
  delete data[entryId];
  write(data);
}

/**
 * Deck sizes for the home page and the Øving header. `nextDue` is the
 * earliest upcoming review when nothing is due right now, else null.
 */
export function reviewCounts(now = Date.now()) {
  const all = allLookups();
  const due = all.filter((r) => r.due <= now);
  const waiting = all.filter((r) => r.due > now);
  return {
    total: all.length,
    due: due.length,
    waiting: waiting.length,
    learnt: all.filter((r) => r.box >= LEARNT_BOX).length,
    nextDue: waiting.length ? Math.min(...waiting.map((r) => r.due)) : null,
  };
}

/** "om 3 timer", "i morgen", "om 5 dager" — for the empty deck message. */
export function describeWait(untilMs, now = Date.now()) {
  const ms = Math.max(0, untilMs - now);
  const hours = Math.round(ms / (60 * 60 * 1000));
  if (hours < 1) return 'om under en time';
  if (hours < 20) return `om ${hours} ${hours === 1 ? 'time' : 'timer'}`;
  const days = Math.round(ms / DAY);
  if (days <= 1) return 'i morgen';
  return `om ${days} dager`;
}
