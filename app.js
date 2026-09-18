import { parseParagraph, reportDiagnostics, lookupEntry } from './parser.js';
import { lexiconStub, guessLemma } from './stub.js';
import { canSpeak, speak, stopSpeaking } from './speech.js';
import {
  recordLookup, addIfMissing, allLookups, dueLookups, markKnown, markAgain, reviewCounts,
  describeWait, INTERVALS_DAYS, MAX_BOX,
} from './review.js';
import {
  recordOpen, recordMode, recordCloze, recordSpoke, recordDictation, recordDrill, drillStats,
  recordRulePassed, rulesPassed, getProgress, isRead, isFinished, lastTouched, progressSummary,
} from './progress.js';
import { toWords, clockWords, priceWords, dateWords, yearWords } from './numbers.js';

// Bump by hand on each deploy — there is no build step to inject it.
// Shown on the home page and stamped into every feedback mail.
export const APP_VERSION = '0.2.0';

// Public repo, public page: this address is visible in the served HTML, which
// is why it is a dedicated account rather than a personal one.
const FEEDBACK_TO = 'norsk.app.feedback@gmail.com';

// All paths relative — the site is served from username.github.io/<repo>/.
const LEXICON_URL = 'data/lexicon.json';
const INDEX_URL = 'data/index.json';
const PARAGRAPH_DIR = 'data/paragraphs/';
const GRAMMAR_URL = 'data/grammar.json';
const EXAM_URL = 'data/exam.json';
const COURSE_URL = 'data/course.json';

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
//
// Deliberately English while the rest of the chrome is Norwegian: the card is
// the one place the learner is *told* something rather than reading Norwegian,
// and grammatical terms ("preterite", "definite plural") are what the
// English-language textbooks and Norskprøven prep material use. Keep it so.
const FORM_LABEL = {
  lemma: null,
  infinitive: 'infinitive',
  present: 'present tense',
  preterite: 'preterite',
  perfect: 'perfect',
  imperative: 'imperative',
  passive: 'passive (-s form)',
  indefinite_sg: 'indefinite singular',
  definite_sg: 'definite singular',
  definite_sg_fem: 'definite singular (feminine)',
  definite_sg_masc: 'definite singular (masculine form)',
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

// The open text, so the reader can switch mode (read / cloze / speak) without
// refetching or reparsing.
let currentDoc = null;
let readerMode = 'read';

async function main() {
  try {
    const [lexRes, idxRes] = await Promise.all([fetch(LEXICON_URL), fetch(INDEX_URL)]);
    if (!lexRes.ok || !idxRes.ok) {
      throw new Error(`HTTP ${lexRes.status} / ${idxRes.status}`);
    }
    lexicon = await lexRes.json();
    index = await idxRes.json();
  } catch (err) {
    // Offline, or a broken deploy. Say so rather than leaving a blank page;
    // the service worker makes the first case rare after the first visit.
    showError('Kunne ikke laste innholdet. Sjekk nettforbindelsen og prøv igjen.');
    console.error('[norsk] failed to load content', err);
    return;
  }

  registerServiceWorker();

  window.addEventListener('hashchange', route);
  // Re-measure when the viewport changes: rotation, dynamic type, the URL bar
  // collapsing on iOS.
  window.addEventListener('resize', measureChrome);
  route();
}

// --- routing ----------------------------------------------------------
// Hash-based so GitHub Pages needs no server rewrites.

function route() {
  closeCard();
  // The tab bar is always on screen, so it follows the route rather than
  // each view remembering to update it.
  setTimeout(syncTabs, 0);
  const id = location.hash.replace(/^#\/?/, '');
  if (id === 'ordbok') return showDictionary();
  if (id === 'skriv') return showScratch();
  if (id === 'tekster') return showTexts();
  if (id === 'ov') return showReview();
  if (id === 'grammatikk') return showGrammar();
  if (id === 'tall') return showDrill();
  if (id === 'prove') return showExam();
  if (id === 'kurs') return showCourse();
  if (id === 'mer') return showHome();
  if (id.startsWith('tema/')) {
    const topic = (index.topics ?? []).find((t) => t.id === id.slice(5));
    if (topic) return showTopic(topic);
  }
  if (id) {
    const meta = index.paragraphs.find((p) => p.id === id);
    if (meta) return showParagraph(meta);
  }
  // On a phone the tab bar is the menu, so opening the app lands on the
  // course. On a wide screen there is no bar and the home menu is the way in.
  if (isPhone()) return showCourse();
  showHome();
}

/**
 * Phone layout, matching the CSS breakpoint that hides the tab bar. Read at
 * call time rather than cached: a window can be resized, and the DOM shim in
 * the tests has no matchMedia at all.
 */
function isPhone() {
  return globalThis.matchMedia ? globalThis.matchMedia('(max-width: 899px)').matches : false;
}

/**
 * Publish the real heights of the frozen layers as custom properties, so the
 * sticky offsets below them are correct rather than guessed. They change with
 * the safe-area inset, font scaling and the filter row wrapping, none of which
 * a hardcoded value survives.
 */
function measureChrome() {
  const root = document.documentElement;
  const set = (name, el) => {
    const h = el && !el.hidden ? Math.round(el.getBoundingClientRect().height) : 0;
    root.style.setProperty(name, `${h}px`);
  };
  set('--topbar-h', document.querySelector('.topbar'));
  set('--dict-controls-h', document.getElementById('dict-controls'));
}

/** Hide every view-specific control. Each view then re-enables its own. */
function resetChrome() {
  document.getElementById('dict-controls').hidden = true;
  document.getElementById('scratch-controls').hidden = true;
  currentParaId = null;
  stopSpeaking();
}

/**
 * Home is a launcher, not a list: a wordmark and three destinations. The text
 * list lives at #/tekster so this page stays the same size as content grows.
 */
function showHome() {
  document.body.dataset.view = 'home';
  resetChrome();

  // The brand in the topbar carries the title here.
  setHeader('', '');
  document.title = 'Norsk — lesing';

  // As «Mer» on a phone it is a destination like any other and needs a way
  // back; as home on a wide screen it is the root.
  const back = document.getElementById('back');
  const asMenu = isPhone();
  if (!asMenu && document.activeElement === back) document.getElementById('doc-title').focus();
  back.hidden = !asMenu;
  if (asMenu) setHeader('Mer', '');

  const main = document.getElementById('reader');
  main.replaceChildren();

  const nav = document.createElement('nav');
  nav.className = 'home-nav';
  nav.setAttribute('aria-label', 'Hovedmeny');

  // The four everyday destinations live in the tab bar on phones, so home
  // lists what the bar does not carry. On a wide screen there is no bar, so
  // home stays the full menu.
  const due = reviewCounts().due;
  const primary = [
    ['#/kurs', 'Kurs', ''],
    ['#/tekster', 'Lesetekster', String(index.paragraphs.length)],
    ['#/ordbok', 'Ordbok', String(Object.keys(lexicon.entries).length)],
    ['#/ov', 'Øving', due ? String(due) : ''],
  ];
  const secondary = [
    ['#/grammatikk', 'Grammatikk', ''],
    ['#/tall', 'Tall og klokka', ''],
    ['#/prove', 'Prøve', ''],
    ['#/skriv', 'Egen tekst', ''],
  ];
  const destinations = [...primary, ...secondary];

  for (const [href, label, count] of destinations) {
    const a = document.createElement('a');
    // Duplicates of the tab bar are hidden by CSS at phone width rather than
    // omitted, so the same markup serves both layouts.
    a.className = 'home-link' + (primary.some(([h]) => h === href) ? ' is-primary' : '');
    a.href = href;

    const name = document.createElement('span');
    name.className = 'home-link-name';
    name.textContent = label;
    a.append(name);

    if (count) {
      const n = document.createElement('span');
      n.className = 'home-link-count';
      n.textContent = count;
      a.append(n);
    }
    nav.append(a);
  }

  main.append(nav);

  // Where you are: how much is read, and a way straight back into the last
  // text in the mode it was left in.
  const summary = progressSummary();
  const last = lastTouched();
  const lastMeta = last && index.paragraphs.find((p) => p.id === last.paraId);
  if (summary.read > 0 || lastMeta) {
    const status = document.createElement('section');
    status.className = 'home-status';

    const stats = document.createElement('p');
    stats.className = 'home-stats';
    stats.textContent =
      `${summary.read} av ${index.paragraphs.length} tekster lest` +
      (summary.finished ? ` · ${summary.finished} ferdig` : '');
    status.append(stats);

    if (lastMeta) {
      const a = document.createElement('a');
      a.className = 'home-continue';
      a.href = `#/${lastMeta.id}`;
      const modeLabel = READER_MODES.find(([m]) => m === last.mode)?.[1] ?? 'Les';
      a.textContent = `Fortsett: ${lastMeta.title} · ${modeLabel}`;
      status.append(a);
    }
    main.append(status);
  }

  // The course's next step, filled in when the data has loaded. Always
  // shown: on a fresh install it is the first step of A1.
  const nextLine = document.createElement('a');
  nextLine.className = 'home-next';
  nextLine.href = '#/kurs';
  nextLine.textContent = 'Kurs: neste steg …';
  main.append(nextLine);
  nextCourseStep()
    .then((step) => {
      if (document.body.dataset.view !== 'home') return;
      nextLine.textContent = step ? `Neste i kurset (${step.level}): ${step.title}` : 'Kurset er fullført — gratulerer!';
      if (step) nextLine.href = step.href;
    })
    .catch(() => nextLine.remove());

  const footer = document.createElement('footer');
  footer.className = 'home-footer';

  const feedback = document.createElement('a');
  feedback.className = 'feedback-link';
  feedback.id = 'feedback';
  feedback.href = feedbackHref();
  feedback.textContent = 'Send tilbakemelding';
  footer.append(feedback);

  const version = document.createElement('span');
  version.className = 'version';
  version.id = 'version';
  version.textContent = `v${APP_VERSION}`;
  footer.append(version);

  main.append(footer);
  measureChrome();
  announce('Norsk');
}

/**
 * A mailto: with the context that makes a report actionable — version, which
 * view they were on, and the browser. Kept short: some mail clients truncate
 * long bodies, and anything longer than this the user will just delete.
 */
function feedbackHref() {
  // Never interpolate a missing value: "Nettleser: undefined" is worse than
  // omitting the line, and reads as a bug in the report itself.
  const lines = [
    '',
    '',
    '—',
    `Versjon: ${APP_VERSION}`,
    `Side: ${location.hash || '#'}`,
    `Nettleser: ${globalThis.navigator?.userAgent || 'ukjent'}`,
  ];
  const subject = `Norsk-appen — tilbakemelding (v${APP_VERSION})`;
  return (
    `mailto:${FEEDBACK_TO}` +
    `?subject=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(lines.join('\n'))}`
  );
}

// The list can be read two ways: by level (what can I manage?) or by topic
// (what will the examiner ask about?). The choice sticks.
const TEXTS_GROUP_KEY = 'norsk:textsGroup';

function readTextsGroup() {
  try {
    return localStorage.getItem(TEXTS_GROUP_KEY) === 'topic' ? 'topic' : 'level';
  } catch {
    return 'level';
  }
}

function writeTextsGroup(mode) {
  try {
    localStorage.setItem(TEXTS_GROUP_KEY, mode);
  } catch {
    /* ignore */
  }
}

function showTexts() {
  document.body.dataset.view = 'texts';
  resetChrome();
  setHeader('Lesetekster', `${index.paragraphs.length} tekster · A1–B2`);
  document.getElementById('back').hidden = false;

  const main = document.getElementById('reader');
  main.replaceChildren();
  measureChrome();
  announce('Lesetekster');

  const grouping = readTextsGroup();
  main.append(
    chipRow(
      [
        ['level', 'Etter nivå'],
        ['topic', 'Etter tema'],
      ],
      grouping,
      (mode) => {
        writeTextsGroup(mode);
        showTexts();
      },
      'Sorter tekstene'
    )
  );

  if (grouping === 'topic' && index.topics?.length) {
    for (const topic of index.topics) {
      const items = index.paragraphs.filter((p) => p.topic === topic.id);
      if (items.length === 0) continue;
      main.append(
        textSection(topic.label, topic.description, items, {
          href: `#/tema/${topic.id}`,
          showLevel: true,
        })
      );
    }
  } else {
    for (const level of index.levels) {
      const items = index.paragraphs.filter((p) => p.level === level.level);
      if (items.length === 0) continue;
      main.append(textSection(level.label, level.description, items, {}));
    }
  }
}

/** A row of mutually exclusive chips. `onPick` receives the chosen value. */
function chipRow(options, current, onPick, label) {
  const wrap = document.createElement('div');
  wrap.className = 'chip-row';
  wrap.setAttribute('role', 'group');
  if (label) wrap.setAttribute('aria-label', label);
  for (const [value, text] of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip' + (current === value ? ' is-on' : '');
    btn.textContent = text;
    btn.setAttribute('aria-pressed', String(current === value));
    btn.addEventListener('click', () => onPick(value));
    wrap.append(btn);
  }
  return wrap;
}

/** One heading + description + list of texts, as used by both groupings. */
function textSection(title, description, items, { href, showLevel }) {
  const lastRead = readLastRead();
  const section = document.createElement('section');
  section.className = 'level';

  const h = document.createElement('h2');
  h.className = 'level-title';
  if (href) {
    const a = document.createElement('a');
    a.className = 'level-title-link';
    a.href = href;
    a.textContent = title;
    h.append(a);
  } else {
    h.textContent = title;
  }
  section.append(h);

  if (description) {
    const d = document.createElement('p');
    d.className = 'level-desc';
    d.textContent = description;
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
    if (showLevel) {
      const lvl = document.createElement('span');
      lvl.className = 'para-level';
      lvl.textContent = item.level;
      a.append(lvl);
    }
    const record = getProgress(item.id);
    if (isFinished(record)) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-done';
      badge.textContent = '✓ ferdig';
      a.append(badge);
    } else if (lastRead === item.id) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'sist lest';
      a.append(badge);
    } else if (isRead(record)) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-read';
      badge.textContent = 'lest';
      a.append(badge);
    }
    li.append(a);
    ul.append(li);
  }
  section.append(ul);
  return section;
}

// --- topic page -------------------------------------------------------
//
// One theme across levels: its texts, the vocabulary they share, and the
// speaking prompts each text carries. This is the page to open the night
// before the exam.

const CONTENT_POS = new Set(['noun', 'verb', 'adjective', 'phrase']);

async function showTopic(topic) {
  document.body.dataset.view = 'topic';
  resetChrome();
  document.getElementById('back').hidden = false;

  const items = index.paragraphs.filter((p) => p.topic === topic.id);
  setHeader(topic.label, `${items.length} tekster · tema`);

  const main = document.getElementById('reader');
  main.replaceChildren();

  if (topic.description) {
    const d = document.createElement('p');
    d.className = 'topic-desc';
    d.textContent = topic.description;
    main.append(d);
  }

  main.append(textSection('Tekster', '', items, { showLevel: true }));

  // Vocabulary and prompts need every paragraph in the topic parsed.
  const vocabSection = document.createElement('section');
  vocabSection.className = 'level';
  const vh = document.createElement('h2');
  vh.className = 'level-title';
  vh.textContent = 'Nøkkelord';
  vocabSection.append(vh);
  const loading = document.createElement('p');
  loading.className = 'level-desc';
  loading.textContent = 'Henter ord …';
  vocabSection.append(loading);
  main.append(vocabSection);

  const promptSection = document.createElement('section');
  promptSection.className = 'level';
  main.append(promptSection);

  measureChrome();
  window.scrollTo(0, 0);
  announce(topic.label);

  const occ = await ensureOccurrences();
  if (document.body.dataset.view !== 'topic') return; // navigated away

  const ids = new Set(items.map((p) => p.id));
  const ranked = [];
  for (const [entryId, uses] of occ) {
    const here = uses.filter((u) => ids.has(u.paraId));
    if (here.length === 0) continue;
    const hit = lookupEntry(lexicon, entryId);
    if (!hit || !CONTENT_POS.has(hit.entry.pos)) continue;
    const texts = new Set(here.map((u) => u.paraId)).size;
    ranked.push({ entryId, lemma: hit.lemma, entry: hit.entry, texts, uses: here.length });
  }
  // Shared across texts first, then most used. Twenty is a page, not a list.
  ranked.sort((a, b) => b.texts - a.texts || b.uses - a.uses || collator.compare(a.lemma, b.lemma));
  const top = ranked.slice(0, 20);

  loading.remove();
  if (top.length === 0) {
    const none = document.createElement('p');
    none.className = 'level-desc';
    none.textContent = 'Ingen ord ennå.';
    vocabSection.append(none);
  } else {
    const desc = document.createElement('p');
    desc.className = 'level-desc';
    desc.textContent = 'Ordene som går igjen i tekstene om dette temaet. Trykk for å se bøyning.';
    vocabSection.append(desc);
    vocabSection.append(wordChips(top));
  }

  const prompts = [];
  for (const meta of items) {
    try {
      const doc = await fetchParagraph(meta);
      if (doc.examNote) prompts.push({ meta, note: doc.examNote });
    } catch {
      /* the text list already links it; a missing note is not fatal */
    }
  }
  if (prompts.length > 0 && document.body.dataset.view === 'topic') {
    const ph = document.createElement('h2');
    ph.className = 'level-title';
    ph.textContent = 'Til muntlig';
    promptSection.append(ph);
    const ul = document.createElement('ul');
    ul.className = 'prompt-list';
    for (const { meta, note } of prompts) {
      const li = document.createElement('li');
      li.className = 'prompt-item';
      const a = document.createElement('a');
      a.className = 'prompt-src';
      a.href = `#/${meta.id}`;
      a.textContent = `${meta.title} · ${meta.level}`;
      const p = document.createElement('p');
      p.className = 'prompt-text';
      p.textContent = note;
      li.append(a, p);
      ul.append(li);
    }
    promptSection.append(ul);
  }
}

/** Tappable word chips that open the ordinary card. */
function wordChips(items) {
  const wrap = document.createElement('div');
  wrap.className = 'word-chips';
  for (const { entryId, lemma, entry } of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'word-chip';
    btn.lang = 'nb';
    btn.textContent = headword(lemma, entry);
    btn.setAttribute('aria-expanded', 'false');
    btn.dataset.entryId = entryId;
    btn.addEventListener('click', () =>
      openCard({ surface: lemma, lemma, entryId, formName: null, groupId: null }, btn)
    );
    wrap.append(btn);
  }
  return wrap;
}


// --- scratch: read any pasted Norwegian -------------------------------
//
// Authored paragraphs treat an unresolved word as a bug. Here it is the whole
// point: a real newspaper paragraph runs 40-60% unknown, and those unknowns
// are the words worth learning next. So they render as visibly marked and
// tappable, and the card hands back a lexicon stub to paste.

const SCRATCH_KEY = 'norsk:scratch';

function readScratch() {
  try {
    return localStorage.getItem(SCRATCH_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeScratch(text) {
  try {
    if (text) localStorage.setItem(SCRATCH_KEY, text);
    else localStorage.removeItem(SCRATCH_KEY);
  } catch {
    /* ignore */
  }
}

function showScratch() {
  document.body.dataset.view = 'scratch';
  resetChrome();
  document.getElementById('back').hidden = false;
  document.getElementById('scratch-controls').hidden = false;

  setHeader('Egen tekst', 'Lim inn og les');

  const input = document.getElementById('scratch-input');
  input.value = readScratch();

  document.getElementById('scratch-read').onclick = () => {
    writeScratch(input.value);
    renderScratch(input.value);
  };
  document.getElementById('scratch-clear').onclick = () => {
    input.value = '';
    writeScratch('');
    document.getElementById('reader').replaceChildren();
    document.getElementById('scratch-stats').textContent = '';
    input.focus();
  };

  if (input.value.trim()) renderScratch(input.value);
  else document.getElementById('reader').replaceChildren();

  measureChrome();
  window.scrollTo(0, 0);
  announce('Egen tekst');
}

/**
 * The word-level pieces of the abbreviations above ("bl", "a", "ca", "kl"…).
 * The parser tokenises "bl.a." into separate words, so without this they show
 * up as unknown vocabulary and pollute the list of words worth learning.
 */
const ABBREVIATION_PARTS = new Set();

// Common Norwegian abbreviations whose full stop does not end a sentence.
// Without this "bl.a." splits into three fragments and pasted prose renders
// as broken lines.
const ABBREVIATIONS = [
  'bl.a.', 'f.eks.', 'dvs.', 'osv.', 'm.m.', 'o.l.', 'bl. a.', 'f. eks.',
  'ca.', 'kl.', 'nr.', 'jf.', 'pga.', 'iflg.', 'mht.', 'vha.', 'evt.', 'inkl.',
  'ekskl.', 'maks.', 'min.', 'tlf.', 'mrd.', 'mill.', 'jr.', 'sr.', 'dr.', 'st.',
];

for (const abbr of ABBREVIATIONS) {
  for (const part of abbr.split('.')) {
    const trimmed = part.trim().toLowerCase();
    if (trimmed) ABBREVIATION_PARTS.add(trimmed);
  }
}

/** Split pasted prose into sentences the parser can take one at a time. */
function splitSentences(text) {
  // Mask the full stops inside abbreviations so they do not end a sentence,
  // split, then restore. The sentinel must be a character that cannot occur
  // in pasted text: anything whitespace-like would be turned into a full stop
  // on restore, corrupting every sentence.
  const MASK = '\u0000';
  let masked = text;
  for (const abbr of ABBREVIATIONS) {
    const capitalised = abbr[0].toUpperCase() + abbr.slice(1);
    for (const form of [abbr, capitalised]) {
      masked = masked.replaceAll(form, form.replaceAll('.', MASK));
    }
  }

  return masked
    .split(/\n+/)
    .flatMap((block) => block.match(/[^.!?\u2026]+[.!?\u2026]*\s*/g) ?? [block])
    .map((s) => s.replaceAll(MASK, '.').trim())
    .filter(Boolean);
}

function renderScratch(text) {
  const reader = document.getElementById('reader');
  reader.replaceChildren();

  const body = splitSentences(text);
  if (body.length === 0) return;

  // Pasted text carries no annotation, so diagnostics are expected and are
  // shown in the UI rather than logged.
  const { sentences } = parseParagraph({ id: 'scratch', body }, lexicon);

  let known = 0;
  let unknown = 0;
  const unknownWords = new Set();

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

      // "bl.a." tokenises into "bl" and "a". Those are not vocabulary, so
      // render them as plain text and keep them out of the study list.
      if (!node.lemma && ABBREVIATION_PARTS.has(node.surface.toLowerCase())) {
        const span = document.createElement('span');
        span.className = 'w-plain';
        span.lang = 'nb';
        span.textContent = node.surface;
        p.append(span);
        return;
      }

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.lang = 'nb';
      btn.textContent = node.surface;
      btn.setAttribute('aria-expanded', 'false');

      if (node.lemma) {
        known++;
        btn.className = 'w' + (node.groupId ? ' is-phrase' : '');
        btn.dataset.lemma = node.lemma;
        if (node.entryId) btn.dataset.entryId = node.entryId;
        btn.addEventListener('click', () => openCard(node, btn));
      } else {
        unknown++;
        unknownWords.add(node.surface.toLowerCase());
        btn.className = 'w w-unknown';
        btn.setAttribute('aria-label', `${node.surface} — ikke i ordboka`);
        btn.addEventListener('click', () => openUnknownCard(node.surface, btn));
      }
      p.append(btn);
    });

    reader.append(p);
  }

  const total = known + unknown;
  const pct = total ? Math.round((100 * known) / total) : 0;
  document.getElementById('scratch-stats').textContent =
    `${known} av ${total} ord kjent (${pct} %) — ${unknownWords.size} nye ord å legge til`;
}

/**
 * Card for a word that is not in the lexicon. Instead of a dictionary entry it
 * offers a ready-made stub, so reading an article feeds the lexicon directly.
 */
function openUnknownCard(surface, el) {
  cardOpener = el;
  clearHighlight();
  activeGroupEls = [el];
  el.classList.add('is-active');

  const body = document.getElementById('card-body');
  body.replaceChildren();
  body.dataset.entryId = '';

  const kicker = document.createElement('p');
  kicker.className = 'card-form';
  kicker.textContent = 'ikke i ordboka ennå';
  body.append(kicker);

  const head = document.createElement('h2');
  head.className = 'card-headword';
  head.id = 'card-headword';
  head.lang = 'nb';
  head.textContent = surface;
  body.append(head);

  const hint = document.createElement('p');
  hint.className = 'card-gloss';
  hint.textContent =
    'Slå opp ordet, fyll inn grunnform og oversettelse, og lim inn i data/lexicon.json.';
  body.append(hint);

  const word = surface.toLowerCase();
  const { lemma, guessed } = guessLemma(word);
  const stub = lexiconStub(lemma, 'noun') + ',';

  if (guessed) {
    const guess = document.createElement('p');
    guess.className = 'card-note';
    guess.textContent = `«${surface}» ser ut som en bøyd form — malen bruker «${lemma}» som grunnform. Sjekk at det stemmer.`;
    body.append(guess);
  }

  const pre = document.createElement('pre');
  pre.className = 'card-stub';
  pre.textContent = stub;
  body.append(pre);

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn-primary';
  copy.textContent = 'Kopier mal';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(stub);
      copy.textContent = 'Kopiert ✓';
    } catch {
      // Clipboard API needs a secure context; select the text instead.
      const range = document.createRange();
      range.selectNodeContents(pre);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      copy.textContent = 'Merket — kopier selv';
    }
    setTimeout(() => (copy.textContent = 'Kopier mal'), 2000);
  });
  body.append(copy);

  const note = document.createElement('p');
  note.className = 'card-note';
  note.textContent = 'Malen antar substantiv. Endre pos og bøyning hvis ordet er verb eller adjektiv.';
  body.append(note);

  document.getElementById('card').hidden = false;
  document.getElementById('card-scrim').hidden = false;
  setBackgroundInert(true);
  el.setAttribute('aria-expanded', 'true');
  document.getElementById('card-close').focus();
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

// Glosses are hidden by default so the list works as self-testing: read the
// Norwegian, recall the meaning, then reveal. The word card always shows the
// gloss regardless — this only governs the browsing list.
const GLOSS_KEY = 'norsk:showGloss';

function readShowGloss() {
  try {
    return localStorage.getItem(GLOSS_KEY) === '1';
  } catch {
    return false;
  }
}

function writeShowGloss(on) {
  try {
    localStorage.setItem(GLOSS_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}

let showGloss = readShowGloss();

// The dictionary shows either the list or one flash card at a time over the
// same filtered set. The choice sticks.
const DICT_VIEW_KEY = 'norsk:dictView';

function readDictView() {
  try {
    return localStorage.getItem(DICT_VIEW_KEY) === 'cards' ? 'cards' : 'list';
  } catch {
    return 'list';
  }
}

function writeDictView(view) {
  try {
    localStorage.setItem(DICT_VIEW_KEY, view);
  } catch {
    /* ignore */
  }
}

let dictView = readDictView();

// Card order. «fast» keeps the same shuffle for a given search so you can
// leave and come back; «bland» reshuffles on every visit and on demand;
// «a-å» is the dictionary's own order, for working through a letter.
const DICT_ORDER_KEY = 'norsk:dictOrder';
const DICT_ORDERS = [
  ['alfabet', 'A–Å'],
  ['fast', 'Fast'],
  ['bland', 'Tilfeldig'],
];

function readDictOrder() {
  try {
    const v = localStorage.getItem(DICT_ORDER_KEY);
    return DICT_ORDERS.some(([id]) => id === v) ? v : 'alfabet';
  } catch {
    return 'alfabet';
  }
}

let dictOrder = readDictOrder();
// Bumped by «Stokk om» and by every fresh visit in «Tilfeldig», so the same
// filter gives a new order.
let dictShuffleNonce = 0;

/**
 * The filtered entries in the order the reader asked for. Shared by the list
 * and the cards so one chip governs both. «alfabet» is the collated order
 * `allEntries()` already holds; the other two shuffle it.
 */
function orderedEntries(matches) {
  if (dictOrder === 'alfabet') return matches;
  const deck = [...matches];
  // Fisher–Yates. In «fast» the seed is the search itself, so the order is
  // reproducible; in «bland» the nonce makes every visit different.
  const seed = dictQuery + dictPos + 'kort' + (dictOrder === 'bland' ? `#${dictShuffleNonce}` : '');
  let x = 0;
  for (const ch of seed) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  if (dictOrder === 'bland') x = (x ^ Date.now()) >>> 0;
  for (let i = deck.length - 1; i > 0; i--) {
    x = (x * 1103515245 + 12345) >>> 0;
    const j = x % (i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/** The order chips, above both the list and the cards. */
function dictOrderRow() {
  return chipRow(DICT_ORDERS, dictOrder, (order) => {
    dictOrder = order;
    try {
      localStorage.setItem(DICT_ORDER_KEY, order);
    } catch {
      /* ignore */
    }
    dictShuffleNonce++;
    renderDictList();
  }, 'Rekkefølge');
}

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
  resetChrome(); // examples may come from anywhere
  document.getElementById('back').hidden = false;
  document.getElementById('dict-controls').hidden = false;

  setHeader('Ordbok', `${Object.keys(lexicon.entries).length} oppslagsord`);

  const search = document.getElementById('dict-search');
  search.value = dictQuery;
  search.oninput = () => {
    dictQuery = search.value.trim();
    renderDictList();
  };

  const toggle = document.getElementById('dict-gloss-toggle');
  syncGlossToggle(toggle);
  toggle.onclick = () => {
    showGloss = !showGloss;
    writeShowGloss(showGloss);
    syncGlossToggle(toggle);
    applyGlossVisibility();
    // In card view the toggle does more than reveal: it turns the deck
    // around, so it has to re-render.
    if (dictView === 'cards') renderDictList();
    announce(showGloss ? 'Engelsk vises' : 'Engelsk skjult');
  };

  const viewToggle = document.getElementById('dict-view-toggle');
  syncViewToggle(viewToggle);
  viewToggle.onclick = () => {
    dictView = dictView === 'cards' ? 'list' : 'cards';
    writeDictView(dictView);
    syncViewToggle(viewToggle);
    // The gloss toggle means something different in each view, so its label
    // has to follow.
    syncGlossToggle(document.getElementById('dict-gloss-toggle'));
    renderDictList();
    announce(dictView === 'cards' ? 'Kort' : 'Liste');
  };

  renderFilters();
  renderDictList();
  measureChrome();
  window.scrollTo(0, 0);
  announce('Ordbok');
}

function syncViewToggle(btn) {
  const cards = dictView === 'cards';
  btn.setAttribute('aria-pressed', String(cards));
  btn.classList.toggle('is-on', cards);
  btn.textContent = cards ? 'Liste' : 'Kort';
}

function syncGlossToggle(btn) {
  btn.setAttribute('aria-pressed', String(showGloss));
  btn.classList.toggle('is-on', showGloss);
  // In the list it reveals the gloss; on the cards it decides which side you
  // are shown first. Same setting, because it answers the same question:
  // "do I still need English?"
  if (dictView === 'cards') {
    btn.textContent = showGloss ? 'Engelsk først' : 'Norsk først';
  } else {
    btn.textContent = showGloss ? 'Skjul engelsk' : 'Vis engelsk';
  }
}

/**
 * Toggling is a class on the list container rather than a re-render: with 640
 * rows, rebuilding the DOM to flip one property would be a visible stutter.
 */
function applyGlossVisibility() {
  document.getElementById('reader').classList.toggle('show-gloss', showGloss);
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
  reader.classList.toggle('show-gloss', showGloss);

  const matches = allEntries().filter(dictMatches);

  if (matches.length === 0) {
    const p = document.createElement('p');
    p.className = 'dict-empty';
    p.textContent = `Ingen treff på «${dictQuery}».`;
    reader.append(p);
    announce('Ingen treff');
    return;
  }

  const ordered = orderedEntries(matches);
  if (dictView === 'cards') return renderDictCards(reader, ordered);

  reader.append(dictOrderRow());

  if (dictOrder === 'alfabet') {
    // Group by initial letter, honouring Norwegian collation.
    let letter = null;
    let list = null;
    for (const item of ordered) {
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
  } else {
    // Shuffled: letter headings would be meaningless, so it is one flat list.
    const list = document.createElement('ul');
    list.className = 'dict-list';
    for (const item of ordered) list.append(dictRow(item));
    reader.append(list);
  }

  announce(`${matches.length} ord`);
}

/**
 * Flash cards over the filtered dictionary. Norwegian on the front, tap to
 * flip, then next. Shuffled once per render so the same search gives the
 * same run through, and «Legg i øving» puts a card into the review deck.
 */
function renderDictCards(reader, deck) {
  reader.append(dictOrderRow());

  let i = 0;
  const card = document.createElement('section');
  card.className = 'flip';
  const progress = document.createElement('p');
  progress.className = 'review-progress';
  const shuffle = document.createElement('button');
  shuffle.type = 'button';
  shuffle.className = 'btn-quiet shuffle-btn';
  shuffle.textContent = 'Stokk om';
  shuffle.addEventListener('click', () => {
    dictShuffleNonce++;
    // A manual shuffle is a one-off even in «A–Å» and «Fast».
    const keep = dictOrder;
    dictOrder = 'bland';
    renderDictList();
    dictOrder = keep;
  });
  reader.append(card, progress, shuffle);

  const show = () => {
    card.replaceChildren();
    const { lemma, entry } = deck[i];
    progress.textContent = `${i + 1} av ${deck.length}`;

    // Which way round the card is. English first (recall the Norwegian) is
    // the beginner's direction and the one that actually teaches production;
    // Norwegian first is recognition, and is what a reader wants later.
    const englishFirst = showGloss;

    const front = document.createElement('h2');
    front.className = 'flip-word';
    if (englishFirst) {
      front.textContent = entry.gloss;
    } else {
      front.lang = 'nb';
      front.textContent = headword(lemma, entry);
    }
    card.append(front);

    // No speaker on an English front: hearing the Norwegian would give the
    // answer away before you have tried to recall it.
    if (!englishFirst) {
      const sp = speakButton(displayLemma(lemma, entry));
      if (sp) card.append(sp);
    }

    const pos = document.createElement('p');
    pos.className = 'flip-box';
    pos.textContent = [POS_LABEL[entry.pos] || entry.pos, entry.gender].filter(Boolean).join(' · ');
    card.append(pos);

    const back = document.createElement('div');
    back.className = 'flip-back';
    back.hidden = true;
    if (englishFirst) {
      const word = document.createElement('p');
      word.className = 'flip-answer';
      word.lang = 'nb';
      word.textContent = headword(lemma, entry);
      back.append(word);
      const sp = speakButton(displayLemma(lemma, entry));
      if (sp) back.append(sp);
    } else {
      const gloss = document.createElement('p');
      gloss.className = 'card-gloss';
      gloss.textContent = entry.gloss;
      back.append(gloss);
    }
    if (entry.note) {
      const note = document.createElement('p');
      note.className = 'card-note';
      note.textContent = entry.note;
      back.append(note);
    }
    if (entry.forms) back.append(buildTable(entry, null));
    card.append(back);

    const actions = document.createElement('div');
    actions.className = 'flip-actions';
    const flip = document.createElement('button');
    flip.type = 'button';
    flip.className = 'btn-primary';
    flip.textContent = 'Vis';
    const advance = () => {
      i = (i + 1) % deck.length;
      show();
    };
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'btn-quiet';
    next.textContent = i + 1 < deck.length ? 'Neste' : 'Fra starten';
    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'btn-quiet';
    prev.textContent = 'Forrige';
    prev.hidden = i === 0;
    // Grading feeds the same spaced schedule as Øving. "Kunne det" moves the
    // word one box up (a new word lands in box 1, due tomorrow); "Øv mer"
    // treats it like a lookup: box 0, due now.
    //
    // Every button is live from the start: a word you already know should be
    // graded and left behind without ever turning the card over. «Vis» is for
    // the ones you are unsure about, and it only adds the answer.
    const knew = document.createElement('button');
    knew.type = 'button';
    knew.className = 'btn-primary';
    knew.textContent = 'Kunne det';
    knew.hidden = !entry.id;
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'btn-quiet';
    again.textContent = 'Øv mer';
    again.hidden = !entry.id;
    flip.addEventListener('click', () => {
      back.hidden = false;
      flip.hidden = true;
      (entry.id ? knew : next).focus();
    });
    next.addEventListener('click', advance);
    prev.addEventListener('click', () => {
      i = Math.max(0, i - 1);
      show();
    });
    knew.addEventListener('click', () => {
      addIfMissing(entry.id);
      markKnown(entry.id);
      advance();
      syncTabs();
    });
    again.addEventListener('click', () => {
      recordLookup(entry.id, null);
      advance();
      syncTabs();
    });
    actions.append(prev, flip, knew, again, next);
    card.append(actions);
  };
  show();
  announce(`${deck.length} kort`);
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

// Parsed paragraph documents, keyed by index id. Each file is fetched once:
// the reader, the "last read" badge and the occurrence index all want the
// same 13 files, and a phone on a train should not refetch them per tap.
const paragraphCache = new Map();

async function fetchParagraph(meta) {
  if (paragraphCache.has(meta.id)) return paragraphCache.get(meta.id);
  const promise = fetch(PARAGRAPH_DIR + meta.file).then(async (res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${meta.file}`);
    return res.json();
  });
  paragraphCache.set(meta.id, promise);
  // A failed fetch must not poison the cache: let the next attempt retry.
  promise.catch(() => paragraphCache.delete(meta.id));
  return promise;
}

// Monotonic token so a slow fetch cannot paint over a newer navigation.
let paragraphRequest = 0;

async function showParagraph(meta) {
  document.body.dataset.view = 'reader';
  resetChrome();
  document.getElementById('back').hidden = false;

  const request = ++paragraphRequest;
  let doc;
  try {
    doc = await fetchParagraph(meta);
  } catch (err) {
    if (request !== paragraphRequest) return;
    showError(`Kunne ikke laste «${meta.title}».`);
    console.error('[norsk] failed to load paragraph', err);
    return;
  }
  // The user has navigated on while we waited; the newer view owns the DOM.
  if (request !== paragraphRequest) return;

  const { sentences, diagnostics } = parseParagraph(doc, lexicon);
  reportDiagnostics(diagnostics, doc.id);

  currentParaId = meta.id;
  currentDoc = { meta, doc, sentences };
  setHeader(doc.title, [doc.level, doc.gloss].filter(Boolean).join(' · '));
  writeLastRead(meta.id);
  recordOpen(meta.id);
  // Reopen in the mode it was left in, so "Fortsett" means continue.
  readerMode = getProgress(meta.id)?.mode ?? 'read';
  renderReader();
  measureChrome();
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
//
// A text has three modes. Reading is the default; the other two reuse the
// same parsed sentences, so switching is instant and nothing is refetched.

const READER_MODES = [
  ['read', 'Les'],
  ['cloze', 'Fyll inn'],
  ['listen', 'Lytt'],
  ['speak', 'Snakk'],
];

function renderReader() {
  const { meta, doc, sentences } = currentDoc;
  const reader = document.getElementById('reader');
  reader.replaceChildren();
  stopSpeaking();

  reader.append(examNoteBox(meta, doc));
  reader.append(
    chipRow(READER_MODES, readerMode, (mode) => {
      readerMode = mode;
      recordMode(meta.id, mode);
      renderReader();
    }, 'Velg øvelse')
  );

  if (readerMode === 'cloze') renderCloze(reader, sentences);
  else if (readerMode === 'listen') renderListen(reader, sentences);
  else if (readerMode === 'speak') renderSpeak(reader, doc, sentences);
  else {
    render(reader, sentences);
    reader.append(lookupsSection(meta.id));
  }
}

/** The examiner's-eye note and topic link above the text. */
function examNoteBox(meta, doc) {
  const box = document.createElement('aside');
  box.className = 'exam-note';

  const topic = (index.topics ?? []).find((t) => t.id === meta.topic);
  if (topic) {
    const a = document.createElement('a');
    a.className = 'exam-note-topic';
    a.href = `#/tema/${topic.id}`;
    a.textContent = `Tema: ${topic.label}`;
    box.append(a);
  }

  if (doc.examNote) {
    const p = document.createElement('p');
    p.className = 'exam-note-text';
    p.textContent = doc.examNote;
    box.append(p);
  }
  return box;
}

/** A button that reads `text` aloud, or null when the browser cannot. */
function speakButton(text, label = 'Les høyt') {
  if (!canSpeak()) return null;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'speak';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.textContent = '🔊';
  btn.addEventListener('click', () => speak(text));
  return btn;
}

// «Vis grammatikk» marks the finite verb in every sentence and tags the
// sentences where the rules from the Grammatikk page are at work: inversion
// after a fronted element, and subordinate clauses. Seeing V2 happen in a
// real text is worth more than any example.
const SHOW_GRAMMAR_KEY = 'norsk:showGrammar';
let grammarOn = (() => {
  try {
    return localStorage.getItem(SHOW_GRAMMAR_KEY) === '1';
  } catch {
    return false;
  }
})();

const SUBJECT_PRONOUNS = new Set(['jeg', 'du', 'han', 'hun', 'den', 'det', 'vi', 'dere', 'de', 'man', 'dette']);
const SUBORDINATORS = new Set(['fordi', 'at', 'når', 'da', 'hvis', 'om', 'som', 'mens', 'før', 'siden', 'dersom', 'selv om', 'etter at']);

function render(reader, sentences) {
  const bar = document.createElement('div');
  bar.className = 'read-tools';
  const whole = speakButton(sentences.map(sentenceText).join(' '), 'Les hele teksten høyt');
  if (whole) {
    whole.classList.add('speak-all');
    whole.textContent = '🔊 Les hele teksten';
    bar.append(whole);
  }
  const gram = document.createElement('button');
  gram.type = 'button';
  gram.className = 'gloss-toggle grammar-toggle';
  const syncGram = () => {
    reader.classList.toggle('show-grammar', grammarOn);
    gram.textContent = grammarOn ? 'Skjul grammatikk' : 'Vis grammatikk';
    gram.setAttribute('aria-pressed', String(grammarOn));
  };
  gram.addEventListener('click', () => {
    grammarOn = !grammarOn;
    try {
      localStorage.setItem(SHOW_GRAMMAR_KEY, grammarOn ? '1' : '0');
    } catch {
      /* ignore */
    }
    syncGram();
  });
  bar.append(gram);
  reader.append(bar);
  syncGram();

  const legend = document.createElement('p');
  legend.className = 'grammar-legend';
  legend.textContent = 'Verb i understreket grønt. «V2» = noe annet enn subjektet står først, så verbet kommer før subjektet. «leddsetning» = etter dette ordet står «ikke» før verbet.';
  reader.append(legend);

  for (const nodes of sentences) reader.append(buildSentence(nodes, { grammar: true }));
}

/** Tag the grammar at work in one sentence. Called only for reading mode. */
function annotateGrammar(p, nodes) {
  const words = nodes.filter((n) => n.kind === 'word');
  const isFinite = (n) => n.formName === 'present' || n.formName === 'preterite';
  const buttons = [...p.querySelectorAll('.w')];
  let bi = 0;
  const byNode = new Map();
  for (const n of words) {
    if (n.lemma) byNode.set(n, buttons[bi++]);
  }
  for (const n of words) {
    if (isFinite(n)) byNode.get(n)?.classList.add('is-finite');
    const key = n.groupId ? n.lemma : n.surface.toLowerCase();
    if (SUBORDINATORS.has(key) || SUBORDINATORS.has(n.lemma)) byNode.get(n)?.classList.add('is-subordinator');
  }
  // Inversion: the finite verb is the second word and the first is not a subject pronoun.
  if (words.length >= 3 && isFinite(words[1]) && !isFinite(words[0]) && !SUBJECT_PRONOUNS.has(words[0].surface.toLowerCase())) {
    const tag = document.createElement('span');
    tag.className = 'gram-tag';
    tag.textContent = 'V2';
    tag.title = 'Inversjon: verbet står før subjektet';
    p.append(' ', tag);
  }
  if (words.some((n) => SUBORDINATORS.has(n.surface.toLowerCase()) || (n.groupId && SUBORDINATORS.has(n.lemma)))) {
    const tag = document.createElement('span');
    tag.className = 'gram-tag gram-tag-sub';
    tag.textContent = 'leddsetning';
    p.append(' ', tag);
  }
}

/** One tappable sentence: the reader's basic unit, reused by the grammar page. */
function buildSentence(nodes, { grammar = false } = {}) {
  const p = document.createElement('p');
  p.className = 'sentence';
  const sp = speakButton(sentenceText(nodes), 'Les setningen høyt');
  if (sp) p.append(sp);

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
  if (grammar) annotateGrammar(p, nodes);
  return p;
}

// --- listening ---------------------------------------------------------
//
// Dictation: hear a sentence, write it, compare. The exam is oral both
// ways, and this is the only place the app asks the learner to understand
// spoken Norwegian rather than produce it.

function normaliseLoose(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function renderListen(reader, sentences) {
  const intro = document.createElement('p');
  intro.className = 'level-desc';
  intro.textContent = canSpeak()
    ? 'Trykk på høyttaleren, lytt, og skriv setningen. Store bokstaver og tegn teller ikke.'
    : 'Nettleseren din har ingen norsk stemme, så diktat virker ikke her. Prøv på telefonen eller i Chrome.';
  reader.append(intro);
  if (!canSpeak()) return;

  const rows = sentences.map((nodes, i) => {
    const text = sentenceText(nodes);
    const row = document.createElement('div');
    row.className = 'dictation';
    const sp = speakButton(text, `Spill setning ${i + 1}`);
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'dictation-input';
    input.lang = 'nb';
    input.autocomplete = 'off';
    input.autocapitalize = 'off';
    input.spellcheck = false;
    input.placeholder = `Setning ${i + 1}`;
    input.setAttribute('aria-label', `Setning ${i + 1}`);
    const key = document.createElement('p');
    key.className = 'dictation-key';
    key.lang = 'nb';
    key.textContent = text;
    key.hidden = true;
    row.append(sp, input, key);
    reader.append(row);
    return { input, key, text };
  });

  const bar = document.createElement('div');
  bar.className = 'scratch-actions';
  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'btn-primary';
  check.textContent = 'Sjekk';
  const reveal = document.createElement('button');
  reveal.type = 'button';
  reveal.className = 'btn-quiet';
  reveal.textContent = 'Vis fasit';
  const status = document.createElement('p');
  status.className = 'scratch-stats';
  status.setAttribute('role', 'status');
  bar.append(check, reveal);
  reader.append(bar, status);

  let revealed = false;
  const grade = () => {
    let right = 0;
    for (const r of rows) {
      const ok = normaliseLoose(r.input.value) === normaliseLoose(r.text);
      r.input.classList.toggle('is-right', ok);
      r.input.classList.toggle('is-wrong', !ok && (r.input.value ?? '').trim() !== '');
      if (ok) right++;
    }
    status.textContent = `${right} av ${rows.length} riktige`;
    if (!revealed && currentDoc) recordDictation(currentDoc.meta.id, right, rows.length);
  };
  check.addEventListener('click', grade);
  reveal.addEventListener('click', () => {
    revealed = !revealed;
    for (const r of rows) r.key.hidden = !revealed;
    reveal.textContent = revealed ? 'Skjul fasit' : 'Vis fasit';
    if (revealed) grade();
  });
  reader.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList?.contains('dictation-input')) {
      e.preventDefault();
      grade();
    }
  });
}

// --- numbers, clock, prices, dates -------------------------------------
//
// Del 1 of the oral exam always touches numbers: your age, the time you get
// up, what things cost, when you came to Norway. A pure drill: see a figure,
// write it in words, hear it said.

const DRILL_KINDS = [
  ['blandet', 'Blandet'],
  ['tall', 'Tall'],
  ['klokka', 'Klokka'],
  ['pris', 'Priser'],
  ['dato', 'Datoer'],
  ['år', 'Årstall'],
];

function drillItem(kind, rnd = Math.random) {
  const pick = (n) => Math.floor(rnd() * n);
  const k = kind === 'blandet' ? ['tall', 'klokka', 'pris', 'dato', 'år'][pick(5)] : kind;
  switch (k) {
    case 'klokka': {
      const h = pick(24);
      const m = pick(12) * 5;
      return { kind: k, prompt: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`, answer: clockWords(h, m), label: 'Hva er klokka? Skriv slik man sier det.' };
    }
    case 'pris': {
      const kr = [pick(100), pick(1000), pick(10000)][pick(3)] + 1;
      return { kind: k, prompt: `${kr} kr`, answer: priceWords(kr), label: 'Hvor mye koster det?' };
    }
    case 'dato': {
      const d = pick(31) + 1;
      const m = pick(12);
      return { kind: k, prompt: `${d}. ${String(m + 1).padStart(2, '0')}.`, answer: dateWords(d, m), label: 'Hvilken dato? Skriv med ord.' };
    }
    case 'år': {
      const y = 1950 + pick(80);
      return { kind: k, prompt: String(y), answer: yearWords(y), label: 'Hvilket år?' };
    }
    default: {
      const n = [pick(20), pick(100), pick(1000), pick(10000)][pick(4)];
      return { kind: 'tall', prompt: String(n), answer: toWords(n), label: 'Skriv tallet med ord.' };
    }
  }
}

let drillKind = 'blandet';

function showDrill() {
  document.body.dataset.view = 'drill';
  resetChrome();
  document.getElementById('back').hidden = false;
  setHeader('Tall og klokka', 'skriv det du ser, slik man sier det');

  const main = document.getElementById('reader');
  main.replaceChildren();
  measureChrome();
  window.scrollTo(0, 0);
  announce('Tall og klokka');

  main.append(
    chipRow(DRILL_KINDS, drillKind, (k) => {
      drillKind = k;
      showDrill();
    }, 'Velg øvelse')
  );

  const card = document.createElement('section');
  card.className = 'drill';
  main.append(card);
  const score = document.createElement('p');
  score.className = 'review-progress';
  main.append(score);
  let right = 0;
  let total = 0;

  const next = () => {
    const item = drillItem(drillKind);
    card.replaceChildren();

    const label = document.createElement('p');
    label.className = 'level-desc';
    label.textContent = item.label;
    const prompt = document.createElement('p');
    prompt.className = 'drill-prompt';
    prompt.textContent = item.prompt;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'dictation-input';
    input.lang = 'nb';
    input.autocomplete = 'off';
    input.autocapitalize = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Svar');
    const key = document.createElement('p');
    key.className = 'dictation-key';
    key.lang = 'nb';
    key.hidden = true;
    key.textContent = item.answer;
    const sp = speakButton(item.kind === 'klokka' ? `klokka ${item.answer}` : item.answer, 'Hør svaret');

    const actions = document.createElement('div');
    actions.className = 'scratch-actions';
    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'btn-primary';
    check.textContent = 'Sjekk';
    const show = document.createElement('button');
    show.type = 'button';
    show.className = 'btn-quiet';
    show.textContent = 'Vis';
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'btn-quiet';
    skip.textContent = 'Neste';
    const status = document.createElement('p');
    status.className = 'scratch-stats';
    status.setAttribute('role', 'status');

    let graded = false;
    const accept = (v) => normaliseLoose(v).replace(/^klokka /, '').replace(/ kroner?$/, '');
    const grade = () => {
      if (graded) return next();
      graded = true;
      const ok = accept(input.value) === accept(item.answer);
      input.classList.toggle('is-right', ok);
      input.classList.toggle('is-wrong', !ok);
      key.hidden = ok;
      total++;
      if (ok) right++;
      recordDrill(item.kind, ok);
      status.textContent = ok ? 'Riktig!' : 'Ikke helt — fasit under.';
      score.textContent = `${right} av ${total} riktige i denne runden`;
      check.textContent = 'Neste';
      check.focus();
    };
    check.addEventListener('click', grade);
    show.addEventListener('click', () => {
      key.hidden = false;
    });
    skip.addEventListener('click', next);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        grade();
      }
    });
    actions.append(check, show, skip);
    if (sp) actions.append(sp);
    card.append(label, prompt, input, key, actions, status);
    input.focus();
  };
  next();
}

/**
 * Words the reader looked up in this text, so a session ends with a list of
 * what to revisit rather than a vague sense of having struggled.
 */
function lookupsSection(paraId) {
  const section = document.createElement('section');
  section.className = 'lookups';
  const mine = allLookups().filter((r) => r.para === paraId);
  if (mine.length === 0) return section;

  const h = document.createElement('h2');
  h.className = 'level-title';
  h.textContent = 'Ord du slo opp';
  section.append(h);

  const items = [];
  for (const r of mine) {
    const hit = lookupEntry(lexicon, r.entryId);
    if (hit) items.push({ entryId: r.entryId, lemma: hit.lemma, entry: hit.entry });
  }
  section.append(wordChips(items));

  const a = document.createElement('a');
  a.className = 'lookups-link';
  a.href = '#/ov';
  a.textContent = 'Øv på ordene →';
  section.append(a);
  return section;
}

function refreshLookups() {
  if (document.body.dataset.view !== 'reader' || readerMode !== 'read' || !currentDoc) return;
  const old = document.getElementById('reader').querySelector('.lookups');
  if (old) old.replaceWith(lookupsSection(currentDoc.meta.id));
}

// --- cloze -------------------------------------------------------------
//
// Every third content word becomes a blank with its base form as the hint,
// so the exercise is "produce the right inflection", which is exactly what
// the inflection tables are teaching. Phrase words and short function words
// are left alone: blanking "og" teaches nothing.

function clozeTargets(sentences) {
  const targets = new Set();
  let i = 0;
  sentences.forEach((nodes, si) => {
    for (const node of nodes) {
      if (node.kind !== 'word' || !node.lemma || node.groupId || node.surface.length < 4) continue;
      // Offset by sentence so consecutive texts do not blank the same slots.
      if ((i + si) % 3 === 0) targets.add(node);
      i++;
    }
  });
  return targets;
}

function normalise(s) {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Hints (the base form in brackets) can be hidden for a harder round. The
// choice sticks, like the dictionary gloss toggle.
const CLOZE_HINTS_KEY = 'norsk:clozeHints';

function readClozeHints() {
  try {
    return localStorage.getItem(CLOZE_HINTS_KEY) !== '0';
  } catch {
    return true;
  }
}

function writeClozeHints(on) {
  try {
    localStorage.setItem(CLOZE_HINTS_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}

function renderCloze(reader, sentences) {
  const targets = clozeTargets(sentences);
  const inputs = [];
  let hintsOn = readClozeHints();

  const intro = document.createElement('p');
  intro.className = 'level-desc';
  intro.textContent = 'Skriv riktig form av ordet. Trykk Enter eller «Sjekk» for å rette.';
  reader.append(intro);

  const hintToggle = document.createElement('button');
  hintToggle.type = 'button';
  hintToggle.className = 'gloss-toggle cloze-hint-toggle';
  const syncHints = () => {
    reader.classList.toggle('hide-hints', !hintsOn);
    hintToggle.textContent = hintsOn ? 'Skjul hint' : 'Vis hint';
    hintToggle.setAttribute('aria-pressed', String(hintsOn));
  };
  hintToggle.addEventListener('click', () => {
    hintsOn = !hintsOn;
    writeClozeHints(hintsOn);
    syncHints();
  });
  reader.append(hintToggle);

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

      if (!targets.has(node)) {
        const span = document.createElement('span');
        span.className = 'w-plain';
        span.lang = 'nb';
        span.textContent = node.surface;
        p.append(span);
        return;
      }

      const hit = lookupEntry(lexicon, node.entryId ?? node.lemma);
      const label = document.createElement('label');
      label.className = 'cloze';

      const input = document.createElement('input');
      input.className = 'cloze-input';
      input.type = 'text';
      input.lang = 'nb';
      input.autocomplete = 'off';
      input.autocapitalize = 'off';
      input.spellcheck = false;
      input.size = Math.max(4, node.surface.length);
      input.dataset.answer = node.surface;
      input.setAttribute('aria-label', `Fyll inn en form av ${node.lemma}`);
      label.append(input);

      const hint = document.createElement('span');
      hint.className = 'cloze-hint';
      hint.textContent = `(${hit ? displayLemma(hit.lemma, hit.entry) : node.lemma})`;
      label.append(hint);

      // The answer key, shown beside the attempt on «Vis fasit» and never
      // written into the input, so a learner can compare rather than lose
      // what they wrote.
      const key = document.createElement('span');
      key.className = 'cloze-key';
      key.lang = 'nb';
      key.textContent = node.surface;
      key.hidden = true;
      label.append(key);

      inputs.push(input);
      p.append(label);
    });

    reader.append(p);
  }

  const bar = document.createElement('div');
  bar.className = 'scratch-actions';
  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'btn-primary';
  check.textContent = 'Sjekk';
  const reveal = document.createElement('button');
  reveal.type = 'button';
  reveal.className = 'btn-quiet';
  reveal.textContent = 'Vis fasit';
  const status = document.createElement('p');
  status.className = 'scratch-stats';
  status.setAttribute('role', 'status');
  bar.append(check, reveal);
  reader.append(bar, status);

  let revealed = false;
  const grade = () => {
    let right = 0;
    for (const input of inputs) {
      const value = input.value ?? '';
      const ok = normalise(value) === normalise(input.dataset.answer);
      input.classList.toggle('is-right', ok);
      input.classList.toggle('is-wrong', !ok && value.trim() !== '');
      if (ok) right++;
    }
    status.textContent = `${right} av ${inputs.length} riktige`;
    // Grading with the key on screen is not an attempt.
    if (!revealed && currentDoc) recordCloze(currentDoc.meta.id, right, inputs.length);
  };
  const syncReveal = () => {
    reader.classList.toggle('show-key', revealed);
    for (const input of inputs) {
      const key = input.parentNode.querySelector('.cloze-key');
      if (key) key.hidden = !revealed;
    }
    reveal.textContent = revealed ? 'Skjul fasit' : 'Vis fasit';
    reveal.setAttribute('aria-pressed', String(revealed));
  };
  check.addEventListener('click', () => grade());
  reveal.addEventListener('click', () => {
    revealed = !revealed;
    syncReveal();
    if (revealed) grade();
  });
  syncHints();
  syncReveal();
  reader.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList?.contains('cloze-input')) {
      e.preventDefault();
      grade();
    }
  });
  inputs[0]?.focus();
}

// --- speaking practice -------------------------------------------------
//
// The exam is oral. This mode hides the text and leaves the candidate with
// what they will have in the room: the prompt, a handful of key words, and
// a clock.

function renderSpeak(reader, doc, sentences) {
  const intro = document.createElement('p');
  intro.className = 'level-desc';
  intro.textContent = doc.examNote
    ? 'Snakk i to minutter om temaet. Bruk nøkkelordene under som støtte.'
    : 'Fortell om teksten med egne ord i to minutter.';
  reader.append(intro);

  // Key words: the text's own content words, once each, in reading order.
  const seen = new Set();
  const items = [];
  for (const node of sentences.flat()) {
    if (node.kind !== 'word' || !node.entryId || seen.has(node.entryId)) continue;
    const hit = lookupEntry(lexicon, node.entryId);
    if (!hit || !CONTENT_POS.has(hit.entry.pos)) continue;
    seen.add(node.entryId);
    items.push({ entryId: node.entryId, lemma: hit.lemma, entry: hit.entry });
    if (items.length >= 14) break;
  }
  reader.append(wordChips(items));

  reader.append(
    makeTimer(120, () => {
      if (currentDoc) recordSpoke(currentDoc.meta.id);
    })
  );

  const after = document.createElement('p');
  after.className = 'level-desc';
  after.textContent = 'Etterpå: bytt til «Les» og sammenlikn med teksten.';
  reader.append(after);
}

// --- grammar -----------------------------------------------------------
//
// A rule book, not a textbook: each rule is one idea, a few tappable
// examples, and scrambled sentences to put back in order. The examples go
// through the same parser as the texts, so every word opens its card.

let grammarPromise = null;
function ensureGrammar() {
  grammarPromise ??= fetch(GRAMMAR_URL).then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status} for grammar.json`);
    return res.json();
  });
  return grammarPromise;
}

async function showGrammar() {
  document.body.dataset.view = 'grammar';
  resetChrome();
  document.getElementById('back').hidden = false;
  setHeader('Grammatikk', 'ordstilling · verb · bindeord');

  const main = document.getElementById('reader');
  main.replaceChildren();
  measureChrome();
  window.scrollTo(0, 0);
  announce('Grammatikk');

  let grammar;
  try {
    grammar = await ensureGrammar();
  } catch (err) {
    showError('Kunne ikke laste grammatikken.');
    console.error('[norsk] failed to load grammar', err);
    return;
  }
  if (document.body.dataset.view !== 'grammar') return;

  // Section jump links, so a learner can go straight to «bindeord».
  const nav = document.createElement('nav');
  nav.className = 'chip-row';
  nav.setAttribute('aria-label', 'Deler');
  for (const section of grammar.sections) {
    const a = document.createElement('a');
    a.className = 'chip';
    a.href = `#/grammatikk`;
    a.textContent = section.title.split(' — ')[0];
    a.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById(`gram-${section.id}`)?.scrollIntoView?.({ behavior: 'smooth' });
    });
    nav.append(a);
  }
  main.append(nav);

  for (const section of grammar.sections) {
    const sec = document.createElement('section');
    sec.className = 'level';
    sec.id = `gram-${section.id}`;

    const h = document.createElement('h2');
    h.className = 'level-title';
    h.textContent = section.title;
    sec.append(h);

    if (section.summary) {
      const p = document.createElement('p');
      p.className = 'level-desc';
      p.textContent = section.summary;
      sec.append(p);
    }

    for (const rule of section.rules) sec.append(ruleCard(rule));
    main.append(sec);
  }
}

function ruleCard(rule) {
  const details = document.createElement('details');
  details.className = 'rule';
  details.id = `rule-${rule.id}`;

  const summary = document.createElement('summary');
  summary.className = 'rule-title';
  summary.textContent = rule.title;
  details.append(summary);

  const body = document.createElement('div');
  body.className = 'rule-body';

  const explain = document.createElement('p');
  explain.className = 'rule-explain';
  explain.textContent = rule.explanation;
  body.append(explain);

  // The contrastive note: what an English speaker's instinct gets wrong here.
  if (rule.english) {
    const note = document.createElement('p');
    note.className = 'rule-english';
    const label = document.createElement('strong');
    label.textContent = 'For English speakers: ';
    note.append(label, rule.english);
    body.append(note);
  }

  const { sentences } = parseParagraph({ id: rule.id, body: rule.examples ?? [] }, lexicon);
  if (sentences.length > 0) {
    const ex = document.createElement('div');
    ex.className = 'rule-examples';
    for (const nodes of sentences) ex.append(buildSentence(nodes));
    body.append(ex);
  }

  if (rule.exercises?.length) {
    const h = document.createElement('h3');
    h.className = 'rule-practice-title';
    h.textContent = 'Prøv selv';
    body.append(h);
    rule.exercises.forEach((ex) => body.append(exercise(ex, rule.id)));
  }

  if (rule.practice?.length) {
    const h = document.createElement('h3');
    h.className = 'rule-practice-title';
    h.textContent = 'Sett ordene i riktig rekkefølge';
    body.append(h);
    rule.practice.forEach((sentence, i) => body.append(scramble(sentence, `${rule.id}-${i}`, rule.id)));
  }

  if (rulesPassed()[rule.id]) details.classList.add('is-passed');
  details.append(body);
  return details;
}

/** Strip annotation markup for display in an exercise prompt. */
function plainText(annotated) {
  return annotated
    .replace(/\{([^:{}]+):[^{}]+\}/g, '$1')
    .replace(/<([^<>]+)>/g, '$1')
    .replace(/\[([^\[\]]+)\](?:\([^()]*\))?/g, '$1');
}

/**
 * One small exercise: `choice` (tap the right option) or `fill` (type the
 * form). Passing either marks the rule as done for the course path.
 */
function exercise(ex, ruleId) {
  const wrap = document.createElement('div');
  wrap.className = 'exercise';
  const prompt = document.createElement('p');
  prompt.className = 'exercise-prompt';
  prompt.lang = 'nb';
  prompt.textContent = plainText(ex.prompt);
  wrap.append(prompt);
  const status = document.createElement('p');
  status.className = 'scratch-stats';
  status.setAttribute('role', 'status');

  const pass = () => {
    wrap.classList.add('is-right');
    wrap.classList.remove('is-wrong');
    status.textContent = 'Riktig!';
    recordRulePassed(ruleId);
    document.getElementById(`rule-${ruleId}`)?.classList.add('is-passed');
  };
  const fail = (answer) => {
    wrap.classList.add('is-wrong');
    wrap.classList.remove('is-right');
    status.textContent = `Ikke helt — riktig er «${plainText(answer)}».`;
  };

  if (ex.type === 'choice') {
    const opts = document.createElement('div');
    opts.className = 'exercise-options';
    for (const opt of ex.options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'scramble-chip';
      btn.lang = 'nb';
      btn.textContent = opt;
      btn.addEventListener('click', () => {
        [...opts.children].forEach((c) => c.classList.remove('is-picked'));
        btn.classList.add('is-picked');
        if (opt === ex.answer) pass();
        else fail(ex.answer);
      });
      opts.append(btn);
    }
    wrap.append(opts);
  } else {
    const row = document.createElement('div');
    row.className = 'scratch-actions';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'dictation-input';
    input.lang = 'nb';
    input.autocomplete = 'off';
    input.autocapitalize = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Svar');
    if (ex.hint) input.placeholder = ex.hint;
    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'btn-primary';
    check.textContent = 'Sjekk';
    const grade = () => {
      if (normaliseLoose(input.value) === normaliseLoose(plainText(ex.answer))) pass();
      else fail(ex.answer);
    };
    check.addEventListener('click', grade);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        grade();
      }
    });
    row.append(input, check);
    wrap.append(row);
  }
  wrap.append(status);
  return wrap;
}

/** Deterministic shuffle so a scrambled sentence looks the same on every visit. */
function seededOrder(n, seed) {
  let x = 0;
  for (const ch of seed) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  const order = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    x = (x * 1103515245 + 12345) >>> 0;
    const j = x % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  // A shuffle that leaves the sentence in order is no exercise.
  if (n > 1 && order.every((v, i) => v === i)) order.reverse();
  return order;
}

/**
 * Word-order exercise: the sentence's words as chips in scrambled order. Tap
 * to build the sentence; tap a placed word to take it back. Punctuation is
 * kept on the word it belongs to, so «ikke,» stays one chip.
 */
function scramble(annotated, seed, ruleId = null) {
  const { sentences } = parseParagraph({ id: seed, body: [annotated] }, lexicon);
  const nodes = sentences[0] ?? [];
  // Rebuild plain words with their trailing punctuation attached.
  const words = [];
  for (const node of nodes) {
    if (node.kind === 'word') words.push(node.surface);
    else if (node.surface.trim() && words.length) words[words.length - 1] += node.surface;
  }
  const answer = words.join(' ');

  const wrap = document.createElement('div');
  wrap.className = 'scramble';

  const target = document.createElement('p');
  target.className = 'scramble-answer';
  target.lang = 'nb';
  target.setAttribute('aria-label', 'Setningen din');
  wrap.append(target);

  const pool = document.createElement('div');
  pool.className = 'scramble-pool';
  wrap.append(pool);

  const status = document.createElement('p');
  status.className = 'scratch-stats';
  status.setAttribute('role', 'status');

  const placed = [];
  const chips = seededOrder(words.length, seed).map((idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'scramble-chip';
    btn.lang = 'nb';
    btn.textContent = words[idx];
    btn.addEventListener('click', () => {
      if (btn.parentNode === pool) {
        placed.push(btn);
        target.append(btn);
      } else {
        placed.splice(placed.indexOf(btn), 1);
        pool.append(btn);
      }
      wrap.classList.remove('is-right', 'is-wrong');
      status.textContent = '';
    });
    return btn;
  });
  chips.forEach((c) => pool.append(c));

  const actions = document.createElement('div');
  actions.className = 'scratch-actions';
  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'btn-primary';
  check.textContent = 'Sjekk';
  check.addEventListener('click', () => {
    const attempt = placed.map((c) => c.textContent).join(' ');
    const ok = normalise(attempt) === normalise(answer);
    wrap.classList.toggle('is-right', ok);
    wrap.classList.toggle('is-wrong', !ok);
    status.textContent = ok ? 'Riktig!' : placed.length < words.length ? 'Bruk alle ordene.' : 'Ikke helt — prøv igjen.';
    if (ok && ruleId) {
      recordRulePassed(ruleId);
      document.getElementById(`rule-${ruleId}`)?.classList.add('is-passed');
    }
  });
  const show = document.createElement('button');
  show.type = 'button';
  show.className = 'btn-quiet';
  show.textContent = 'Vis';
  show.addEventListener('click', () => {
    placed.length = 0;
    words.forEach((w, i) => {
      const chip = chips.find((c) => c.textContent === w && c.parentNode !== target) ?? chips[i];
      placed.push(chip);
      target.append(chip);
    });
    wrap.classList.add('is-right');
    wrap.classList.remove('is-wrong');
    status.textContent = answer;
  });
  actions.append(check, show);
  wrap.append(actions, status);
  return wrap;
}

/** A countdown with start/pause/reset. `onDone` fires once when it hits zero. */
function makeTimer(total, onDone) {
  const timer = document.createElement('div');
  timer.className = 'timer';
  const clock = document.createElement('p');
  clock.className = 'timer-clock';
  clock.setAttribute('role', 'timer');
  const start = document.createElement('button');
  start.type = 'button';
  start.className = 'btn-primary';
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'btn-quiet';
  reset.textContent = 'Nullstill';
  const actions = document.createElement('div');
  actions.className = 'scratch-actions';
  actions.append(start, reset);
  timer.append(clock, actions);

  let left = total;
  let handle = null;
  const show = () => {
    const m = Math.floor(left / 60);
    const sec = String(left % 60).padStart(2, '0');
    clock.textContent = `${m}:${sec}`;
    clock.classList.toggle('is-done', left === 0);
    start.textContent = handle ? 'Pause' : left === total ? 'Start' : left === 0 ? 'Ferdig' : 'Fortsett';
  };
  const stop = () => {
    clearInterval(handle);
    handle = null;
    show();
  };
  start.addEventListener('click', () => {
    if (handle) return stop();
    if (left === 0) return;
    handle = setInterval(() => {
      left--;
      if (left <= 0) {
        left = 0;
        stop();
        onDone?.();
        announce('Tiden er ute');
      } else show();
    }, 1000);
    show();
  });
  reset.addEventListener('click', () => {
    stop();
    left = total;
    show();
  });
  show();
  // Leaving the view must not leave a ticking interval behind.
  window.addEventListener('hashchange', stop, { once: true });
  timer.finish = () => {
    left = 0;
    stop();
    onDone?.();
  };
  return timer;
}

// --- exam simulation ---------------------------------------------------
//
// Three parts in a row, timed like the real thing: personal questions,
// a two-minute presentation on a random topic, and a discussion prompt.

let examPromise = null;
function ensureExam() {
  examPromise ??= fetch(EXAM_URL).then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status} for exam.json`);
    return res.json();
  });
  return examPromise;
}

function shuffled(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function showExam() {
  document.body.dataset.view = 'exam';
  resetChrome();
  document.getElementById('back').hidden = false;
  setHeader('Prøve', 'muntlig · tre deler');

  const main = document.getElementById('reader');
  main.replaceChildren();
  measureChrome();
  window.scrollTo(0, 0);
  announce('Prøve');

  let exam;
  try {
    exam = await ensureExam();
    await ensureOccurrences();
  } catch (err) {
    showError('Kunne ikke laste prøven.');
    console.error('[norsk] failed to load exam', err);
    return;
  }
  if (document.body.dataset.view !== 'exam') return;

  const questions = shuffled(exam.del1).slice(0, 6);
  const topicsWithTexts = (index.topics ?? []).filter((t) => index.paragraphs.some((p) => p.topic === t.id));
  const topic = shuffled(topicsWithTexts)[0];
  const discussion = shuffled(index.paragraphs.filter((p) => p.level === 'B1' || p.level === 'B2'))[0];

  let part = 0;
  const render = async () => {
    main.replaceChildren();
    const steps = ['Del 1', 'Del 2', 'Del 3'];
    const nav = document.createElement('p');
    nav.className = 'exam-steps';
    nav.textContent = part < 3 ? `${steps[part]} av 3` : 'Ferdig';
    main.append(nav);

    const h = document.createElement('h2');
    h.className = 'level-title';
    main.append(h);
    const intro = document.createElement('p');
    intro.className = 'level-desc';
    main.append(intro);

    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'btn-primary';
    nextBtn.textContent = part < 2 ? 'Neste del' : 'Avslutt';

    if (part === 0) {
      h.textContent = 'Del 1 — om deg selv';
      intro.textContent = 'Svar høyt på hvert spørsmål i hele setninger. Tre minutter til sammen.';
      const ul = document.createElement('ol');
      ul.className = 'exam-questions';
      for (const q of questions) {
        const li = document.createElement('li');
        li.lang = 'nb';
        li.textContent = q;
        const sp = speakButton(q, 'Hør spørsmålet');
        if (sp) li.append(' ', sp);
        ul.append(li);
      }
      main.append(ul, makeTimer(exam.del1Seconds ?? 180));
    } else if (part === 1) {
      h.textContent = `Del 2 — presentasjon: ${topic.label}`;
      intro.textContent = `${topic.description} Snakk i to minutter. Nøkkelordene under er fra tekstene om temaet.`;
      const ids = new Set(index.paragraphs.filter((p) => p.topic === topic.id).map((p) => p.id));
      const ranked = [];
      for (const [entryId, uses] of occurrences ?? []) {
        const here = uses.filter((u) => ids.has(u.paraId));
        if (!here.length) continue;
        const hit = lookupEntry(lexicon, entryId);
        if (!hit || !CONTENT_POS.has(hit.entry.pos)) continue;
        ranked.push({ entryId, lemma: hit.lemma, entry: hit.entry, n: here.length });
      }
      ranked.sort((a, b) => b.n - a.n);
      main.append(wordChips(ranked.slice(0, 12)), makeTimer(exam.del2Seconds ?? 120));
    } else if (part === 2) {
      h.textContent = 'Del 3 — samtale';
      intro.textContent = 'Sensor tar opp et samfunnstema. Argumenter, innrøm et motargument, og konkluder. Tre minutter.';
      const box = document.createElement('aside');
      box.className = 'exam-note';
      const t = document.createElement('p');
      t.className = 'exam-note-topic';
      t.textContent = `${discussion.title} · ${discussion.level}`;
      box.append(t);
      try {
        const doc = await fetchParagraph(discussion);
        const note = document.createElement('p');
        note.className = 'exam-note-text';
        note.textContent = doc.examNote || doc.title;
        box.append(note);
      } catch {
        /* the title alone is a usable prompt */
      }
      main.append(box, makeTimer(exam.del3Seconds ?? 180));
    } else {
      h.textContent = 'Ferdig';
      intro.textContent = 'Godt jobbet. Les teksten fra del 3 og sammenlikn med det du sa, eller ta prøven igjen med nye spørsmål.';
      recordDrill('prøve', true);
      const a = document.createElement('a');
      a.className = 'lookups-link';
      a.href = `#/${discussion.id}`;
      a.textContent = `Les «${discussion.title}» →`;
      const again = document.createElement('button');
      again.type = 'button';
      again.className = 'btn-quiet';
      again.textContent = 'Ny prøve';
      again.addEventListener('click', showExam);
      main.append(a, document.createElement('br'), again);
      return;
    }
    nextBtn.addEventListener('click', () => {
      part++;
      render();
    });
    main.append(nextBtn);
  };
  render();
}

// --- course path -------------------------------------------------------
//
// The parts of the app, in an order. Each step is done when its own store
// says so; nothing here is stored twice.

let coursePromise = null;
function ensureCourse() {
  coursePromise ??= fetch(COURSE_URL).then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status} for course.json`);
    return res.json();
  });
  return coursePromise;
}

function stepInfo(step, grammarRules) {
  switch (step.type) {
    case 'text': {
      const meta = index.paragraphs.find((p) => p.id === step.id);
      if (!meta) return null;
      const rec = getProgress(meta.id);
      return { href: `#/${meta.id}`, title: meta.title, kind: 'Tekst', done: isRead(rec), full: isFinished(rec) };
    }
    case 'rule': {
      const rule = grammarRules.get(step.id);
      if (!rule) return null;
      return { href: `#/grammatikk`, anchor: `rule-${step.id}`, title: rule.title, kind: 'Regel', done: Boolean(rulesPassed()[step.id]) };
    }
    case 'drill': {
      const stats = drillStats();
      const right = ['tall', 'klokka', 'pris', 'dato', 'år'].reduce((n, k) => n + (stats[k]?.right ?? 0), 0);
      return { href: '#/tall', title: step.label, kind: 'Øvelse', done: right >= 10 };
    }
    case 'review':
      return { href: '#/ov', title: step.label, kind: 'Øving', done: reviewCounts().learnt >= 5 };
    case 'exam':
      return { href: '#/prove', title: step.label, kind: 'Prøve', done: (drillStats()['prøve']?.answered ?? 0) >= 1 };
    default:
      return null;
  }
}

/**
 * A progress ring: an SVG circle whose dash gap shrinks as steps complete.
 * The level's own name sits inside it, so the ring labels itself.
 */
function progressRing(done, total, label) {
  const R = 20;
  const C = 2 * Math.PI * R;
  const fraction = total > 0 ? done / total : 0;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ring' + (fraction >= 1 ? ' is-complete' : ''));
  svg.setAttribute('viewBox', '0 0 48 48');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${label}: ${done} av ${total} steg gjort`);

  const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  track.setAttribute('class', 'ring-track');
  track.setAttribute('cx', '24');
  track.setAttribute('cy', '24');
  track.setAttribute('r', String(R));

  const fill = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  fill.setAttribute('class', 'ring-fill');
  fill.setAttribute('cx', '24');
  fill.setAttribute('cy', '24');
  fill.setAttribute('r', String(R));
  fill.setAttribute('stroke-dasharray', String(C));
  // Starts empty and animates to its value, so returning to the page shows
  // the progress arriving rather than just sitting there.
  fill.setAttribute('stroke-dashoffset', String(C));
  requestAnimationFrame(() => fill.setAttribute('stroke-dashoffset', String(C * (1 - fraction))));

  const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  text.setAttribute('class', 'ring-label');
  text.setAttribute('x', '24');
  text.setAttribute('y', '24');
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('dominant-baseline', 'central');
  text.textContent = fraction >= 1 ? '✓' : label;

  svg.append(track, fill, text);
  return svg;
}

/** The first unfinished step across the course, for the home page. */
async function nextCourseStep() {
  const [course, grammar] = await Promise.all([ensureCourse(), ensureGrammar()]);
  const rules = new Map(grammar.sections.flatMap((s) => s.rules.map((r) => [r.id, r])));
  for (const level of course.levels) {
    for (const step of level.steps) {
      const info = stepInfo(step, rules);
      if (info && !info.done) return { level: level.level, ...info };
    }
  }
  return null;
}

async function showCourse() {
  document.body.dataset.view = 'course';
  resetChrome();
  // On a phone the course is the landing view, so there is nothing to go
  // back to; reached from the menu on a wide screen there is.
  document.getElementById('back').hidden = isPhone() && !location.hash.replace(/^#\/?/, '');
  setHeader('Kurs', 'A1 → B2, steg for steg');

  const main = document.getElementById('reader');
  main.replaceChildren();
  measureChrome();
  window.scrollTo(0, 0);
  announce('Kurs');

  let course;
  let grammar;
  try {
    [course, grammar] = await Promise.all([ensureCourse(), ensureGrammar()]);
  } catch (err) {
    showError('Kunne ikke laste kurset.');
    console.error('[norsk] failed to load course', err);
    return;
  }
  if (document.body.dataset.view !== 'course') return;
  const rules = new Map(grammar.sections.flatMap((s) => s.rules.map((r) => [r.id, r])));

  const intro = document.createElement('p');
  intro.className = 'topic-desc';
  intro.textContent = 'Les teksten, gjør regelen, øv på ordene. Et steg er gjort når appen har sett deg gjøre det.';
  main.append(intro);

  let firstOpen = null;
  for (const level of course.levels) {
    const meta = index.levels.find((l) => l.level === level.level);
    const section = document.createElement('section');
    section.className = 'level';
    const infos = level.steps.map((s) => stepInfo(s, rules)).filter(Boolean);
    const done = infos.filter((i) => i.done).length;

    // The heading is a ring and a label rather than a sentence: how far
    // through the level you are should be readable without counting.
    const head = document.createElement('div');
    head.className = 'level-head';
    head.append(progressRing(done, infos.length, level.level));

    const h = document.createElement('h2');
    h.className = 'level-title';
    h.textContent = meta?.label ?? level.level;
    const count = document.createElement('p');
    count.className = 'level-count';
    count.textContent = done === infos.length ? 'Ferdig' : `${done} av ${infos.length} steg`;
    const labels = document.createElement('div');
    labels.append(h, count);
    head.append(labels);
    section.append(head);

    const ol = document.createElement('ol');
    ol.className = 'course-steps';
    for (const info of infos) {
      const li = document.createElement('li');
      li.className = 'course-step' + (info.done ? ' is-done' : '') + (info.full ? ' is-full' : '');
      const a = document.createElement('a');
      a.className = 'course-link';
      a.href = info.href;
      if (info.anchor) {
        a.addEventListener('click', () => {
          // Open the rule once the grammar page has rendered.
          setTimeout(() => {
            const el = document.getElementById(info.anchor);
            if (el) {
              el.open = true;
              el.scrollIntoView?.({ behavior: 'smooth' });
            }
          }, 150);
        });
      }
      const kind = document.createElement('span');
      kind.className = 'course-kind';
      kind.textContent = info.kind;
      const title = document.createElement('span');
      title.className = 'course-title';
      title.textContent = info.title;
      const mark = document.createElement('span');
      mark.className = 'course-mark';
      mark.textContent = info.full ? '✓✓' : info.done ? '✓' : '';
      a.append(kind, title, mark);
      li.append(a);
      ol.append(li);
      if (!firstOpen && !info.done) {
        firstOpen = li;
        li.classList.add('is-next');
      }
    }
    section.append(ol);
    main.append(section);
  }
}

// --- review ------------------------------------------------------------
//
// Flip cards over the words the reader looked up. Norwegian on the front,
// the full card on the back, two buttons. That is the whole feature.

function showReview() {
  document.body.dataset.view = 'review';
  resetChrome();
  document.getElementById('back').hidden = false;

  const counts = reviewCounts();
  setHeader('Øving', `${counts.due} å øve på nå · ${counts.learnt} lært`);

  const main = document.getElementById('reader');
  main.replaceChildren();
  measureChrome();
  window.scrollTo(0, 0);
  announce('Øving');

  const deck = dueLookups()
    .map((r) => ({ ...r, hit: lookupEntry(lexicon, r.entryId) }))
    .filter((r) => r.hit);

  if (deck.length === 0) {
    const p = document.createElement('p');
    p.className = 'review-empty';
    if (counts.total === 0) {
      p.textContent = 'Ingen ord ennå. Les en tekst og trykk på ordene du ikke kan — de havner her.';
    } else {
      // Everything is scheduled for later: say when, so the learner knows
      // that coming back tomorrow is the plan, not a bug.
      p.textContent =
        `Ingenting å øve på nå. ${counts.waiting} ord venter — neste ${describeWait(counts.nextDue)}.`;
    }
    main.append(p);
    const a = document.createElement('a');
    a.className = 'lookups-link';
    a.href = '#/tekster';
    a.textContent = 'Til tekstene →';
    main.append(a);
    return;
  }

  let i = 0;
  const card = document.createElement('section');
  card.className = 'flip';
  main.append(card);

  const progress = document.createElement('p');
  progress.className = 'review-progress';
  main.append(progress);

  const show = () => {
    card.replaceChildren();
    if (i >= deck.length) {
      const done = document.createElement('p');
      done.className = 'review-empty';
      done.textContent = 'Ferdig for nå.';
      card.append(done);
      const again = document.createElement('button');
      again.type = 'button';
      again.className = 'btn-quiet';
      again.textContent = 'Gå gjennom igjen';
      again.addEventListener('click', showReview);
      card.append(again);
      progress.textContent = '';
      return;
    }
    const item = deck[i];
    const { lemma, entry } = item.hit;
    progress.textContent = `${i + 1} av ${deck.length}`;

    const front = document.createElement('h2');
    front.className = 'flip-word';
    front.lang = 'nb';
    front.textContent = headword(lemma, entry);
    card.append(front);

    const sp = speakButton(displayLemma(lemma, entry));
    if (sp) card.append(sp);

    const box = document.createElement('p');
    box.className = 'flip-box';
    const nextBox = Math.min(MAX_BOX, item.box + 1);
    const days = INTERVALS_DAYS[nextBox];
    box.textContent =
      `boks ${item.box + 1} av ${MAX_BOX + 1} · kunne det: neste ` +
      (days === 1 ? 'i morgen' : `om ${days} dager`);
    card.append(box);

    const back = document.createElement('div');
    back.className = 'flip-back';
    back.hidden = true;
    const pos = document.createElement('p');
    pos.className = 'card-pos';
    pos.textContent = [POS_LABEL[entry.pos] || entry.pos, entry.gender].filter(Boolean).join(' · ');
    const gloss = document.createElement('p');
    gloss.className = 'card-gloss';
    gloss.textContent = entry.gloss;
    back.append(pos, gloss);
    if (entry.forms) back.append(buildTable(entry, null));
    card.append(back);

    const actions = document.createElement('div');
    actions.className = 'flip-actions';
    const flip = document.createElement('button');
    flip.type = 'button';
    flip.className = 'btn-primary';
    flip.textContent = 'Vis';
    const knew = document.createElement('button');
    knew.type = 'button';
    knew.className = 'btn-primary';
    knew.textContent = 'Kunne det';
    knew.hidden = true;
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'btn-quiet';
    again.textContent = 'Øv mer';
    again.hidden = true;
    flip.addEventListener('click', () => {
      back.hidden = false;
      flip.hidden = true;
      knew.hidden = false;
      again.hidden = false;
      knew.focus();
    });
    knew.addEventListener('click', () => {
      markKnown(item.entryId);
      i++;
      show();
      syncTabs();
    });
    again.addEventListener('click', () => {
      markAgain(item.entryId);
      i++;
      show();
      syncTabs();
    });
    actions.append(flip, knew, again);
    card.append(actions);
  };
  show();
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
        return { meta, doc: await fetchParagraph(meta) };
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

  // 2. The dictionary headword, with a speaker where the browser has one.
  const head = document.createElement('h2');
  head.className = 'card-headword';
  head.id = 'card-headword';
  head.textContent = headword(node.lemma, entry);
  const sp = speakButton(displayLemma(node.lemma, entry), 'Uttale');
  if (sp) head.append(' ', sp);
  body.append(head);

  // Only taps in a text count as "looked up". Browsing the dictionary or a
  // topic's word list is not a sign the word is unknown.
  if (currentParaId && entry.id) recordLookup(entry.id, currentParaId);

  const pos = document.createElement('p');
  pos.className = 'card-pos';
  pos.textContent = [POS_LABEL[entry.pos] || entry.pos, entry.gender]
    .filter(Boolean)
    .join(' · ');
  body.append(pos);

  // 2b. How to say it, for the words English readers get wrong.
  if (entry.pron) {
    const pron = document.createElement('p');
    pron.className = 'card-pron';
    pron.textContent = `Uttale: ${entry.pron}`;
    body.append(pron);
  }

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
  resetCardDrag(card);
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
  refreshLookups();
  syncTabs();
}

// --- dragging the card away --------------------------------------------
//
// On a phone the card is a bottom sheet, and a sheet you cannot flick away
// feels stuck. It follows the finger, resists upward (there is nothing above
// it), and dismisses past a threshold of distance or speed — whichever comes
// first, so a short fast flick works as well as a slow long drag.

const DRAG_DISMISS_PX = 110;
const DRAG_DISMISS_VELOCITY = 0.55; // px per ms

function resetCardDrag(card) {
  card.style.transform = '';
  card.style.transition = '';
  card.classList.remove('is-dragging');
}

function wireCardDrag() {
  const card = document.getElementById('card');
  if (!card) return;

  let startY = 0;
  let lastY = 0;
  let lastT = 0;
  let velocity = 0;
  let dragging = false;
  let pointerId = null;

  const onDown = (e) => {
    // Only a phone-shaped sheet drags, only with one primary pointer, and
    // never from a control: a drag starting on a button would swallow taps.
    if (!isPhone() || !e.isPrimary || card.hidden) return;
    if (e.target.closest('button, a, input, textarea, table')) return;
    // A scrolled sheet drags its content, not itself.
    if (card.scrollTop > 0) return;
    dragging = true;
    pointerId = e.pointerId;
    startY = lastY = e.clientY;
    lastT = e.timeStamp;
    velocity = 0;
    card.classList.add('is-dragging');
  };

  const onMove = (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    const dy = e.clientY - startY;
    const dt = e.timeStamp - lastT;
    if (dt > 0) velocity = (e.clientY - lastY) / dt;
    lastY = e.clientY;
    lastT = e.timeStamp;
    // Rubber-band upward rather than allowing it: the sheet is already at the
    // top of its travel.
    const offset = dy < 0 ? dy / 4 : dy;
    card.style.transform = `translateY(${offset}px)`;
    if (dy > 0) {
      // Taking over the gesture from the browser's scrolling.
      card.setPointerCapture?.(pointerId);
      e.preventDefault();
    }
  };

  const onUp = (e) => {
    if (!dragging || (pointerId !== null && e.pointerId !== pointerId)) return;
    dragging = false;
    pointerId = null;
    card.classList.remove('is-dragging');
    const dy = e.clientY - startY;
    if (dy > DRAG_DISMISS_PX || (dy > 24 && velocity > DRAG_DISMISS_VELOCITY)) {
      // Let it finish falling before it disappears, or the dismissal reads as
      // a glitch rather than a gesture.
      card.style.transition = 'transform 160ms ease-in, opacity 160ms ease-in';
      card.style.transform = `translateY(${Math.max(card.offsetHeight, 300)}px)`;
      card.style.opacity = '0';
      setTimeout(() => {
        card.style.opacity = '';
        closeCard();
      }, 150);
      return;
    }
    card.style.transition = 'transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1)';
    card.style.transform = '';
  };

  card.addEventListener('pointerdown', onDown);
  card.addEventListener('pointermove', onMove);
  card.addEventListener('pointerup', onUp);
  card.addEventListener('pointercancel', onUp);
}

function wireChrome() {
  wireCardDrag();
  // The wordmark is the way out of anywhere; on a phone that is the course.
  const brand = document.getElementById('brand');
  if (brand) {
    brand.addEventListener('click', (e) => {
      if (!isPhone()) return;
      e.preventDefault();
      location.hash = '#/kurs';
    });
  }

  document.getElementById('card-scrim').addEventListener('click', closeCard);
  document.getElementById('card-close').addEventListener('click', closeCard);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return closeCard();
    if (!document.getElementById('card').hidden) trapFocus(e);
  });
  document.getElementById('back').addEventListener('click', () => {
    // A paragraph and a topic belong to the text list; the rest hang off the
    // menu, which on a phone is «Mer» and on a wide screen is home.
    const view = document.body.dataset.view;
    if (view === 'reader' || view === 'topic') location.hash = '#/tekster';
    else location.hash = isPhone() ? '#/mer' : '';
  });
}

/**
 * Offline support. The worker caches the shell and every JSON it sees, so a
 * text read once on wifi still opens on the train. Registration is deferred to
 * load so it never competes with the first content fetch, and it is skipped
 * entirely outside a secure context (plain http on a LAN) and in the DOM shim.
 */
function registerServiceWorker() {
  const sw = globalThis.navigator?.serviceWorker;
  if (!sw || !globalThis.isSecureContext) return;
  // Installing the worker precaches the whole shell, which on a slow host
  // competes with the first view's own fetches. Wait until the page has
  // settled before starting it; offline support is for the second visit.
  const register = () =>
    setTimeout(() => {
      sw.register('sw.js').catch((err) => console.warn('[norsk] sw registration failed', err));
    }, 3000);
  // main() awaits two fetches before reaching here, so `load` has often
  // already fired; waiting for it then would wait forever.
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

/**
 * Light the tab that owns the current view, and show how many words are due.
 * A view with no tab of its own (a text, a topic) still belongs to one: a
 * paragraph is part of Tekster, the drill and the exam part of Kurs.
 */
const VIEW_TAB = {
  home: 'more',
  scratch: 'more',
  course: 'course',
  texts: 'texts',
  reader: 'texts',
  topic: 'texts',
  dict: 'dict',
  review: 'review',
  drill: 'course',
  exam: 'course',
  grammar: 'course',
};

function syncTabs() {
  const view = document.body.dataset.view;
  const active = VIEW_TAB[view] ?? null;
  for (const tab of document.querySelectorAll('.tab')) {
    const on = tab.dataset.tab === active;
    tab.classList.toggle('is-on', on);
    if (on) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  const badge = document.getElementById('tab-review-badge');
  if (badge) {
    const due = reviewCounts().due;
    badge.textContent = due > 99 ? '99+' : String(due);
    badge.hidden = due === 0;
  }
}

/** Announce a view change to assistive tech without re-reading the text. */
function announce(message) {
  const el = document.getElementById('announcer');
  if (el) el.textContent = message;
}

wireChrome();
main();
