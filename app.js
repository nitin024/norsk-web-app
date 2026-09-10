import { parseParagraph, reportDiagnostics, lookupEntry } from './parser.js';

// All paths relative — the site is served from username.github.io/<repo>/.
const LEXICON_URL = 'data/lexicon.json';
const INDEX_URL = 'data/index.json';
const PARAGRAPH_DIR = 'data/paragraphs/';

const POS_LABEL = {
  noun: 'substantiv',
  verb: 'verb',
  adjective: 'adjektiv',
  pronoun: 'pronomen',
  determiner: 'determinativ',
  preposition: 'preposisjon',
  conjunction: 'konjunksjon',
  adverb: 'adverb',
  numeral: 'tallord',
  particle: 'infinitivsmerke',
  phrase: 'uttrykk',
};

// How a form is *named* to the learner. This is the headline of the card.
const FORM_LABEL = {
  lemma: null,
  infinitive: 'infinitive',
  present: 'present tense',
  preterite: 'preterite',
  perfect: 'perfect',
  indefinite_sg: 'indefinite singular',
  definite_sg: 'definite singular',
  definite_sg_fem: 'definite singular (feminine)',
  indefinite_pl: 'indefinite plural',
  definite_pl: 'definite plural',
  positive: 'positive',
  neuter: 'neuter',
  plural: 'plural',
  comparative: 'comparative',
  superlative: 'superlative',
  superlative_definite: 'definite superlative',
  masculine: 'masculine',
  feminine: 'feminine',
  phrase: 'part of a fixed phrase',
};

const ROW_LABEL = { ...FORM_LABEL, lemma: 'base form' };

const LAST_READ_KEY = 'norsk:lastRead';

let lexicon = null;
let index = null;
let activeGroupEls = [];
let cardOpener = null;

// entryId -> [{ paraId, title, key, text }] for every sentence in the corpus
// that uses the entry. Built once, lazily, the first time a card is opened.
let occurrences = null;
let occurrencesPromise = null;

// Which sentence the reader is currently looking at, so the card never offers
// the sentence you are already reading as an "example".
let currentParaId = null;

async function main() {
  const [lexRes, idxRes] = await Promise.all([fetch(LEXICON_URL), fetch(INDEX_URL)]);
  if (!lexRes.ok || !idxRes.ok) {
    showError('Kunne ikke laste innholdet.');
    console.error('[norsk] fetch failed', lexRes.status, idxRes.status);
    return;
  }
  lexicon = await lexRes.json();
  index = await idxRes.json();

  window.addEventListener('hashchange', route);
  route();
}

// --- routing ----------------------------------------------------------
// Hash-based so GitHub Pages needs no server rewrites.

function route() {
  closeCard();
  const id = location.hash.replace(/^#\/?/, '');
  if (id === 'ordbok') return showDictionary();
  if (id) {
    const meta = index.paragraphs.find((p) => p.id === id);
    if (meta) return showParagraph(meta);
  }
  showList();
}

function showList() {
  document.body.dataset.view = 'list';
  currentParaId = null;
  document.getElementById('dict-controls').hidden = true;
  setHeader('Norsk', 'Muntlig — lesetekster');

  // Move focus off the back button before hiding it, or focus falls to <body>
  // and keyboard users lose their place.
  const back = document.getElementById('back');
  if (document.activeElement === back) document.getElementById('doc-title').focus();
  back.hidden = true;

  const main = document.getElementById('reader');
  main.replaceChildren();

  const lastRead = readLastRead();
  announce('Alle tekster');

  const dictLink = document.createElement('a');
  dictLink.className = 'dict-entry-link';
  dictLink.href = '#/ordbok';
  dictLink.textContent = `Ordbok — ${Object.keys(lexicon.entries).length} ord`;
  main.append(dictLink);

  for (const level of index.levels) {
    const items = index.paragraphs.filter((p) => p.level === level.level);
    if (items.length === 0) continue;

    const section = document.createElement('section');
    section.className = 'level';

    const h = document.createElement('h2');
    h.className = 'level-title';
    h.textContent = level.label;
    section.append(h);

    if (level.description) {
      const d = document.createElement('p');
      d.className = 'level-desc';
      d.textContent = level.description;
      section.append(d);
    }

    const ul = document.createElement('ul');
    ul.className = 'para-list';
    for (const item of items) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.className = 'para-link';
      a.href = `#/${item.id}`;
      a.textContent = item.title;
      if (lastRead === item.id) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = 'sist lest';
        a.append(badge);
      }
      li.append(a);
      ul.append(li);
    }
    section.append(ul);
    main.append(section);
  }
}

// --- dictionary -------------------------------------------------------

// Norwegian alphabetical order: æ ø å sort after z, not as a/o. Intl handles
// this; the fallback keeps things sane in the rare engine without 'nb'.
const collator = new Intl.Collator('nb', { sensitivity: 'base' });

const POS_FILTERS = [
  ['', 'Alle'],
  ['noun', 'Subst.'],
  ['verb', 'Verb'],
  ['adjective', 'Adj.'],
  ['phrase', 'Uttrykk'],
  ['other', 'Andre'],
];
// Everything not given its own chip is grouped behind "Andre".
const CHIPPED = new Set(['noun', 'verb', 'adjective', 'phrase']);

let dictQuery = '';
let dictPos = '';

/** All entries as a sorted array, built once. */
let dictEntries = null;
function allEntries() {
  dictEntries ??= Object.entries(lexicon.entries)
    .map(([lemma, entry]) => ({ lemma, entry }))
    .sort((a, b) => collator.compare(a.lemma, b.lemma));
  return dictEntries;
}

/** Does this entry match the current search and part-of-speech filter? */
function dictMatches({ lemma, entry }) {
  if (dictPos === 'other' ? CHIPPED.has(entry.pos) : dictPos && entry.pos !== dictPos) {
    return false;
  }
  if (!dictQuery) return true;

  const q = dictQuery.toLowerCase();
  if (lemma.toLowerCase().includes(q)) return true;
  if (entry.gloss?.toLowerCase().includes(q)) return true;
  // Search inflected forms too, so looking up "gikk" finds "gå".
  return Object.values(entry.forms ?? {}).some((f) => f.toLowerCase().includes(q));
}

function showDictionary() {
  document.body.dataset.view = 'dict';
  currentParaId = null; // examples may come from anywhere
  document.getElementById('back').hidden = false;
  document.getElementById('dict-controls').hidden = false;

  setHeader('Ordbok', `${Object.keys(lexicon.entries).length} oppslagsord`);

  const search = document.getElementById('dict-search');
  search.value = dictQuery;
  search.oninput = () => {
    dictQuery = search.value.trim();
    renderDictList();
  };

  renderFilters();
  renderDictList();
  window.scrollTo(0, 0);
  announce('Ordbok');
}

function renderFilters() {
  const wrap = document.getElementById('dict-filters');
  wrap.replaceChildren();
  for (const [value, label] of POS_FILTERS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip' + (dictPos === value ? ' is-on' : '');
    btn.textContent = label;
    btn.setAttribute('aria-pressed', String(dictPos === value));
    btn.addEventListener('click', () => {
      dictPos = value;
      renderFilters();
      renderDictList();
    });
    wrap.append(btn);
  }
}

function renderDictList() {
  const reader = document.getElementById('reader');
  reader.replaceChildren();

  const matches = allEntries().filter(dictMatches);

  if (matches.length === 0) {
    const p = document.createElement('p');
    p.className = 'dict-empty';
    p.textContent = `Ingen treff på «${dictQuery}».`;
    reader.append(p);
    announce('Ingen treff');
    return;
  }

  // Group by initial letter, honouring Norwegian collation.
  let letter = null;
  let list = null;
  for (const item of matches) {
    const initial = item.lemma[0].toUpperCase();
    if (initial !== letter) {
      letter = initial;
      const h = document.createElement('h2');
      h.className = 'dict-letter';
      h.textContent = letter;
      reader.append(h);
      list = document.createElement('ul');
      list.className = 'dict-list';
      reader.append(list);
    }
    list.append(dictRow(item));
  }

  announce(`${matches.length} ord`);
}

function dictRow({ lemma, entry }) {
  const li = document.createElement('li');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dict-row';
  btn.setAttribute('aria-expanded', 'false');
  if (entry.id) btn.dataset.entryId = entry.id;

  const head = document.createElement('span');
  head.className = 'dict-head';
  head.lang = 'nb';
  head.textContent = headword(lemma, entry);

  const pos = document.createElement('span');
  pos.className = 'dict-pos';
  pos.textContent = [POS_LABEL[entry.pos] || entry.pos, entry.gender].filter(Boolean).join(' · ');

  const gloss = document.createElement('span');
  gloss.className = 'dict-gloss';
  gloss.textContent = entry.gloss;

  btn.append(head, pos, gloss);
  // Reuse the reader's card. A synthetic node stands in for a parsed token:
  // the dictionary shows the base form, so there is no inflection to name.
  btn.addEventListener('click', () =>
    openCard({ surface: lemma, lemma, entryId: entry.id, formName: null, groupId: null }, btn)
  );

  li.append(btn);
  return li;
}

async function showParagraph(meta) {
  document.body.dataset.view = 'reader';
  document.getElementById('back').hidden = false;
  document.getElementById('dict-controls').hidden = true;

  const res = await fetch(PARAGRAPH_DIR + meta.file);
  if (!res.ok) {
    showError(`Kunne ikke laste «${meta.title}».`);
    console.error('[norsk] fetch failed', meta.file, res.status);
    return;
  }
  const doc = await res.json();

  const { sentences, diagnostics } = parseParagraph(doc, lexicon);
  reportDiagnostics(diagnostics, doc.id);

  currentParaId = meta.id;
  setHeader(doc.title, [doc.level, doc.gloss].filter(Boolean).join(' · '));
  writeLastRead(meta.id);
  render(sentences);
  window.scrollTo(0, 0);
  // Move focus to the heading so keyboard and screen-reader users land in the
  // new view instead of staying on the link they activated.
  document.getElementById('doc-title').focus();
  announce(`${doc.title}, ${doc.level}`);
}

function setHeader(title, meta) {
  document.getElementById('doc-title').textContent = title;
  document.getElementById('doc-meta').textContent = meta || '';
  document.title = title === 'Norsk' ? 'Norsk — lesing' : `${title} — Norsk`;
}

function showError(message) {
  const main = document.getElementById('reader');
  main.replaceChildren();
  const p = document.createElement('p');
  p.className = 'error';
  p.textContent = message;
  main.append(p);
}

// localStorage is best-effort; private mode and cleared storage must not break
// rendering. The SRS module will want a richer store than this.
function readLastRead() {
  try {
    return localStorage.getItem(LAST_READ_KEY);
  } catch {
    return null;
  }
}

function writeLastRead(id) {
  try {
    localStorage.setItem(LAST_READ_KEY, id);
  } catch {
    /* ignore */
  }
}

// --- rendering --------------------------------------------------------

function render(sentences) {
  const reader = document.getElementById('reader');
  reader.replaceChildren();

  for (const nodes of sentences) {
    const p = document.createElement('p');
    p.className = 'sentence';

    nodes.forEach((node, i) => {
      if (node.kind === 'punct') {
        const span = document.createElement('span');
        span.className = 'punct';
        span.textContent = node.surface;
        p.append(span);
        return;
      }

      const prev = nodes[i - 1];
      if (i > 0 && prev.kind === 'word') p.append(' ');

      if (!node.lemma) {
        const span = document.createElement('span');
        span.className = 'w-plain';
        span.textContent = node.surface;
        p.append(span);
        return;
      }

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'w' + (node.groupId ? ' is-phrase' : '');
      btn.textContent = node.surface;
      btn.lang = 'nb';
      btn.setAttribute('aria-expanded', 'false');
      btn.dataset.lemma = node.lemma;
      // The stable key. SRS review state should hang off this, never the lemma.
      if (node.entryId) btn.dataset.entryId = node.entryId;
      if (node.formName) btn.dataset.formName = node.formName;
      if (node.groupId) btn.dataset.groupId = node.groupId;
      btn.addEventListener('click', () => openCard(node, btn));
      p.append(btn);
    });

    reader.append(p);
  }
}

// --- corpus occurrences ------------------------------------------------

/**
 * Reconstruct plain Norwegian from parsed nodes. The source carries annotation
 * syntax ({x:y}, [phrase](lemma), <Name>), so the sentence has to be rebuilt
 * from tokens rather than read off the raw string.
 */
function sentenceText(nodes) {
  let out = '';
  nodes.forEach((node, i) => {
    const prev = nodes[i - 1];
    if (i > 0 && node.kind === 'word' && prev?.kind === 'word') out += ' ';
    out += node.surface;
  });
  return out.trim();
}

/**
 * Fetch every paragraph once and index which sentences use which entry.
 *
 * The reader loads paragraphs lazily, so at the moment a card opens the app
 * has usually seen only the current text. The whole corpus is ~16KB, so
 * pulling it in full is cheaper than maintaining a precomputed index file —
 * and it stays correct automatically as paragraphs are added.
 */
async function buildOccurrences() {
  const map = new Map();

  const docs = await Promise.all(
    index.paragraphs.map(async (meta) => {
      try {
        const res = await fetch(PARAGRAPH_DIR + meta.file);
        return res.ok ? { meta, doc: await res.json() } : null;
      } catch {
        return null;
      }
    })
  );

  for (const entry of docs) {
    if (!entry) continue;
    const { meta, doc } = entry;
    const { sentences } = parseParagraph(doc, lexicon);

    sentences.forEach((nodes, si) => {
      const text = sentenceText(nodes);
      // One record per entry per sentence, even if the word repeats in it.
      const ids = new Set(
        nodes.filter((n) => n.kind === 'word' && n.entryId).map((n) => n.entryId)
      );
      for (const id of ids) {
        if (!map.has(id)) map.set(id, []);
        map.get(id).push({ paraId: meta.id, title: doc.title, key: `${meta.id}:${si}`, text });
      }
    });
  }
  return map;
}

function ensureOccurrences() {
  if (occurrences) return Promise.resolve(occurrences);
  occurrencesPromise ??= buildOccurrences().then((m) => (occurrences = m));
  return occurrencesPromise;
}

/**
 * Pick an example sentence for an entry, never one from the paragraph being
 * read. Returns null when the corpus has no other occurrence — better to show
 * nothing than to echo the sentence already on screen.
 */
function pickExample(entryId) {
  const all = occurrences?.get(entryId);
  if (!all) return null;
  const elsewhere = all.filter((o) => o.paraId !== currentParaId);
  if (elsewhere.length === 0) return null;
  // Prefer the shortest: least surrounding vocabulary to trip over.
  return elsewhere.reduce((a, b) => (b.text.length < a.text.length ? b : a));
}

/**
 * Locate the entry in an example sentence. The example usually carries a
 * different inflection than the one tapped ("er" here, "var" there), so match
 * any of the entry's forms — seeing the other form highlighted is the point.
 * Returns [start, length] or null.
 */
function findFormIn(text, surface, entry) {
  const candidates = [surface, ...Object.values(entry?.forms ?? {})]
    // Longest first, so "gått" wins over "gå" inside it.
    .sort((a, b) => b.length - a.length);

  const lower = text.toLowerCase();
  for (const form of candidates) {
    for (const word of form.toLowerCase().split(/\s+/)) {
      // Whole words only: "min" must not match inside "minutter".
      const re = new RegExp(`(?<!\\p{L})${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\p{L})`, 'u');
      const m = re.exec(lower);
      if (m) return [m.index, word.length];
    }
  }
  return null;
}

/** Render the example into an already-open card, if one is available. */
function renderExample(entryId, surface) {
  const body = document.getElementById('card-body');
  if (!body || body.dataset.entryId !== entryId) return; // card moved on
  body.querySelector('.card-example')?.remove();

  const example = pickExample(entryId);
  if (!example) return;

  const wrap = document.createElement('div');
  wrap.className = 'card-example';

  const label = document.createElement('a');
  label.className = 'card-example-src';
  label.href = `#/${example.paraId}`;
  label.textContent = `Også i «${example.title}»`;
  label.addEventListener('click', closeCard);
  wrap.append(label);

  const quote = document.createElement('p');
  quote.className = 'card-example-text';
  quote.lang = 'nb';
  // Bold whichever form of the entry this sentence uses.
  const hit = findFormIn(example.text, surface, lookupEntry(lexicon, entryId)?.entry);
  if (!hit) {
    quote.textContent = example.text;
  } else {
    const [at, len] = hit;
    quote.append(
      document.createTextNode(example.text.slice(0, at)),
      Object.assign(document.createElement('strong'), {
        textContent: example.text.slice(at, at + len),
      }),
      document.createTextNode(example.text.slice(at + len))
    );
  }
  wrap.append(quote);
  body.append(wrap);
}

// --- word card --------------------------------------------------------

function openCard(node, el) {
  // Prefer the stable id; fall back to the lemma for content not yet migrated.
  const hit = lookupEntry(lexicon, node.entryId ?? node.lemma);
  const entry = hit?.entry;
  if (!entry) return;

  // Remember where focus came from so Escape and Lukk can put it back.
  cardOpener = el;
  highlightGroup(node, el);

  const body = document.getElementById('card-body');
  body.replaceChildren();
  body.dataset.entryId = entry.id ?? '';

  // 1. What the form IS.
  const formLabel = FORM_LABEL[node.formName];
  if (formLabel) {
    const h = document.createElement('p');
    h.className = 'card-form';
    h.textContent = describeForm(formLabel, node.lemma, entry);
    body.append(h);
  }

  // 2. The dictionary headword.
  const head = document.createElement('h2');
  head.className = 'card-headword';
  head.id = 'card-headword';
  head.textContent = headword(node.lemma, entry);
  body.append(head);

  const pos = document.createElement('p');
  pos.className = 'card-pos';
  pos.textContent = [POS_LABEL[entry.pos] || entry.pos, entry.gender]
    .filter(Boolean)
    .join(' · ');
  body.append(pos);

  // 3. The table, as reference.
  if (entry.forms) body.append(buildTable(entry, node.formName));

  // 4. English gloss last.
  const gloss = document.createElement('p');
  gloss.className = 'card-gloss';
  gloss.textContent = entry.gloss;
  body.append(gloss);

  if (entry.note) {
    const note = document.createElement('p');
    note.className = 'card-note';
    note.textContent = entry.note;
    body.append(note);
  }

  // 5. An example from elsewhere in the corpus. Appended when the index is
  // ready so the card never waits on a fetch to open.
  if (entry.id) {
    ensureOccurrences().then(() => renderExample(entry.id, node.surface));
  }

  document.getElementById('card').hidden = false;
  document.getElementById('card-scrim').hidden = false;

  // The card is aria-modal, but that alone does not stop a virtual cursor or
  // Tab from reaching the page behind it. `inert` does both.
  setBackgroundInert(true);
  el.setAttribute('aria-expanded', 'true');
  document.getElementById('card-close').focus();
}

/**
 * Focusable descendants of the card, in DOM order.
 *
 * Visibility is tested with getClientRects() rather than offsetParent: the
 * card is position:fixed, and WebKit reports a null offsetParent for fixed
 * elements, which would filter out every button on iOS and freeze the trap.
 */
function cardFocusables() {
  return [
    ...document
      .getElementById('card')
      .querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
  ].filter((el) => !el.hasAttribute('disabled') && el.getClientRects().length > 0);
}

/** Keep Tab inside the open card, wrapping at both ends. */
function trapFocus(e) {
  if (e.key !== 'Tab') return;
  const items = cardFocusables();
  // Nothing focusable found: leave Tab alone rather than trapping the user in
  // a card they cannot move within or out of.
  if (items.length === 0) return;

  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;

  if (e.shiftKey && (active === first || !document.getElementById('card').contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

function setBackgroundInert(on) {
  const page = document.getElementById('page');
  if (!page) return;
  if (on) page.setAttribute('inert', '');
  else page.removeAttribute('inert');
}

function describeForm(formLabel, lemma, entry) {
  const name = displayLemma(lemma, entry);
  if (entry.pos === 'verb' || entry.phrase) return `${formLabel} of å ${name}`;
  return `${formLabel} of ${name}`;
}

/**
 * Display name for an entry. Multi-sense entries are keyed "tre (substantiv)"
 * to keep two senses of one lemma apart; that suffix disambiguates the key and
 * must never reach the screen, so those entries carry an explicit `headword`.
 */
function displayLemma(lemma, entry) {
  return entry.headword ?? lemma;
}

function headword(lemma, entry) {
  const name = displayLemma(lemma, entry);
  return entry.pos === 'verb' || entry.phrase ? `å ${name}` : name;
}

function buildTable(entry, currentForm) {
  const table = document.createElement('table');
  table.className = 'table';
  const tbody = document.createElement('tbody');

  for (const [formName, surface] of Object.entries(entry.forms)) {
    const tr = document.createElement('tr');
    if (formName === currentForm) tr.className = 'is-current';
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = ROW_LABEL[formName] || formName;
    const td = document.createElement('td');
    td.textContent = surface;
    tr.append(th, td);
    tbody.append(tr);
  }

  table.append(tbody);
  return table;
}

function highlightGroup(node, el) {
  clearHighlight();
  activeGroupEls = node.groupId
    ? [...document.querySelectorAll(`[data-group-id="${node.groupId}"]`)]
    : [el];
  activeGroupEls.forEach((n) => n.classList.add('is-active'));
}

function clearHighlight() {
  activeGroupEls.forEach((n) => n.classList.remove('is-active'));
  activeGroupEls = [];
}

function closeCard() {
  const card = document.getElementById('card');
  if (card.hidden) return;
  card.hidden = true;
  document.getElementById('card-scrim').hidden = true;
  setBackgroundInert(false);
  clearHighlight();

  // Return focus to the word that opened the card, so keyboard reading
  // continues from where it left off rather than at the top of the document.
  if (cardOpener?.isConnected) {
    cardOpener.setAttribute('aria-expanded', 'false');
    cardOpener.focus();
  }
  cardOpener = null;
}

function wireChrome() {
  document.getElementById('card-scrim').addEventListener('click', closeCard);
  document.getElementById('card-close').addEventListener('click', closeCard);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return closeCard();
    if (!document.getElementById('card').hidden) trapFocus(e);
  });
  document.getElementById('back').addEventListener('click', () => {
    location.hash = '';
  });
}

/** Announce a view change to assistive tech without re-reading the text. */
function announce(message) {
  const el = document.getElementById('announcer');
  if (el) el.textContent = message;
}

wireChrome();
main();
