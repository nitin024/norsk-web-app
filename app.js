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
  if (id) {
    const meta = index.paragraphs.find((p) => p.id === id);
    if (meta) return showParagraph(meta);
  }
  showList();
}

function showList() {
  document.body.dataset.view = 'list';
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

async function showParagraph(meta) {
  document.body.dataset.view = 'reader';
  document.getElementById('back').hidden = false;

  const res = await fetch(PARAGRAPH_DIR + meta.file);
  if (!res.ok) {
    showError(`Kunne ikke laste «${meta.title}».`);
    console.error('[norsk] fetch failed', meta.file, res.status);
    return;
  }
  const doc = await res.json();

  const { sentences, diagnostics } = parseParagraph(doc, lexicon);
  reportDiagnostics(diagnostics, doc.id);

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
  if (entry.pos === 'verb' || entry.phrase) return `${formLabel} of å ${lemma}`;
  return `${formLabel} of ${lemma}`;
}

function headword(lemma, entry) {
  return entry.pos === 'verb' || entry.phrase ? `å ${lemma}` : lemma;
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
