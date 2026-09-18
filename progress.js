// Reading progress: which texts were opened, how they went, what was done.
//
// localStorage, best-effort, keyed by paragraph id. Shape:
//
//   { [paraId]: { first: ms, last: ms, opens: n, mode: 'read'|'cloze'|'speak',
//                 cloze: { best: n, total: n } | null, spoke: bool } }
//
// "Read" means opened at least once. "Finished" means the cloze was solved
// in full and the speaking timer ran to the end: the two active exercises,
// both completed without peeking. Reading alone is not finishing.

const KEY = 'norsk:progress';

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
    /* private mode, quota — progress is a convenience, never a blocker */
  }
}

function update(paraId, fn) {
  if (!paraId) return;
  const data = read();
  const cur = data[paraId] ?? { first: 0, last: 0, opens: 0, mode: 'read', cloze: null, spoke: false };
  data[paraId] = fn({ ...cur });
  write(data);
}

export function recordOpen(paraId) {
  const now = Date.now();
  update(paraId, (r) => ({ ...r, first: r.first || now, last: now, opens: r.opens + 1 }));
}

/** Remember the mode so "continue" lands where the reader left off. */
export function recordMode(paraId, mode) {
  update(paraId, (r) => ({ ...r, mode, last: Date.now() }));
}

/** A graded cloze attempt. Revealing the answers must not call this. */
export function recordCloze(paraId, right, total) {
  if (!total) return;
  update(paraId, (r) => ({
    ...r,
    last: Date.now(),
    cloze: { best: Math.max(r.cloze?.best ?? 0, right), total },
  }));
}

export function recordSpoke(paraId) {
  update(paraId, (r) => ({ ...r, spoke: true, last: Date.now() }));
}

export function getProgress(paraId) {
  return read()[paraId] ?? null;
}

export function isRead(record) {
  return Boolean(record && record.opens > 0);
}

export function isFinished(record) {
  return Boolean(record && record.spoke && record.cloze && record.cloze.best >= record.cloze.total);
}

/** Most recently touched text, for the "continue" link. */
export function lastTouched() {
  let best = null;
  for (const [paraId, r] of Object.entries(read())) {
    if (!best || r.last > best.last) best = { paraId, ...r };
  }
  return best;
}

export function progressSummary() {
  const all = Object.values(read());
  return {
    read: all.filter(isRead).length,
    finished: all.filter(isFinished).length,
  };
}
