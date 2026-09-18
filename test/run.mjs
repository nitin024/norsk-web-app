#!/usr/bin/env node
// View tests. No dependencies — mounts app.js against the DOM shim in dom.mjs
// and asserts what each route renders.
//
//   node test/run.mjs
//
// Exits non-zero on failure, so it drops into CI beside validate.js.
// These exist because grepping the source kept missing real breakage: an
// empty dictionary and a back arrow on the home page both shipped.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildDocument, installGlobals } from './dom.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const result = fn();
    // An async callback would resolve after the report is printed, so its
    // assertions could never fail the run. Refuse it loudly instead.
    if (result && typeof result.then === 'function') {
      throw new Error('check() callbacks must be synchronous');
    }
    passed++;
  } catch (err) {
    failures.push({ name, message: err.message });
  }
}

const assert = {
  ok(value, message) {
    if (!value) throw new Error(message ?? `expected truthy, got ${value}`);
  },
  equal(actual, expected, message) {
    if (actual !== expected) {
      throw new Error(message ?? `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  },
  atLeast(actual, min, message) {
    if (!(actual >= min)) throw new Error(message ?? `expected >= ${min}, got ${actual}`);
  },
  includes(haystack, needle, message) {
    if (!String(haystack).includes(needle)) {
      throw new Error(message ?? `expected to find ${JSON.stringify(needle)} in ${JSON.stringify(String(haystack).slice(0, 120))}`);
    }
  },
};

// --- mount -------------------------------------------------------------

const doc = buildDocument(ROOT);
installGlobals(doc, ROOT);

// app.js calls main() on import and awaits two fetches; give them a tick.
await import('../app.js');
await new Promise((r) => setImmediate(r));

const $ = (id) => doc.getElementById(id);
const reader = () => $('reader');

/** Drive the router the way a hash change would. */
async function go(hash) {
  globalThis.location.hash = hash;
  doc.dispatch('hashchange');
  await new Promise((r) => setImmediate(r));
}

// --- home --------------------------------------------------------------

await go('');

check('home: renders four destinations', () => {
  const links = reader().querySelectorAll('.home-link');
  assert.equal(links.length, 4);
});

check('home: destinations point at the right routes', () => {
  const hrefs = reader().querySelectorAll('.home-link').map((a) => a.getAttribute('href'));
  assert.equal(hrefs.join(','), '#/tekster,#/ordbok,#/ov,#/skriv');
});

check('home: back button is hidden (regression)', () => {
  assert.equal($('back').hidden, true, 'back arrow must not show on home');
});

check('home: brand is present and links home', () => {
  assert.equal($('brand').getAttribute('href'), '#');
});

check('home: view flag set for CSS', () => {
  assert.equal(doc.body.dataset.view, 'home');
});

check('home: no paragraph list leaks onto home', () => {
  assert.equal(reader().querySelectorAll('.para-link').length, 0);
});

check('home: shows the app version', () => {
  const v = $('version');
  assert.ok(v, 'no version element');
  assert.ok(/^v\d+\.\d+\.\d+$/.test(v.textContent), `unexpected version: ${v.textContent}`);
});

check('home: feedback link is a mailto to the right address', () => {
  const href = $('feedback').getAttribute('href');
  assert.includes(href, 'mailto:norsk.app.feedback@gmail.com');
});

check('feedback: mail body carries the version and browser context', () => {
  const href = $('feedback').getAttribute('href');
  const body = decodeURIComponent((href.split('&body=')[1] ?? ''));
  const subject = decodeURIComponent((href.split('?subject=')[1] ?? '').split('&')[0]);
  assert.includes(subject, 'v');
  assert.includes(body, 'Versjon:');
  assert.includes(body, 'Side:');
  assert.includes(body, 'Nettleser:');
});

check('feedback: no field is left undefined or empty', () => {
  const body = decodeURIComponent(($('feedback').getAttribute('href').split('&body=')[1] ?? ''));
  for (const line of body.split('\n').filter((l) => l.includes(':'))) {
    const [label, ...rest] = line.split(':');
    const value = rest.join(':').trim();
    if (!value) throw new Error(`${label} has no value`);
    if (/^(undefined|null|NaN)$/.test(value)) throw new Error(`${label} is "${value}"`);
  }
});

check('feedback: version in the mail matches the version shown', () => {
  const shown = $('version').textContent.replace(/^v/, '');
  const body = decodeURIComponent(($('feedback').getAttribute('href').split('&body=')[1] ?? ''));
  assert.includes(body, `Versjon: ${shown}`);
});

// --- text list ---------------------------------------------------------

await go('#/tekster');

check('texts: lists every paragraph in the index', () => {
  const links = reader().querySelectorAll('.para-link');
  assert.atLeast(links.length, 13);
});

check('texts: groups by level', () => {
  const titles = reader().querySelectorAll('.level-title').map((h) => h.textContent);
  assert.atLeast(titles.length, 4);
});

check('texts: back button is visible', () => {
  assert.equal($('back').hidden, false);
});

check('texts: grouping chips are rendered, level is default', () => {
  const chips = reader().querySelectorAll('.chip');
  assert.equal(chips.length, 2);
  assert.equal(chips[0].getAttribute('aria-pressed'), 'true');
  assert.equal(reader().querySelectorAll('.level-title-link').length, 0);
});

check('texts: switching to topics groups by declared topic with links', () => {
  reader().querySelectorAll('.chip')[1].click();
  const links = reader().querySelectorAll('.level-title-link');
  assert.atLeast(links.length, 5, 'expected one heading link per topic');
  assert.ok(links.every((a) => a.getAttribute('href').startsWith('#/tema/')));
  assert.atLeast(reader().querySelectorAll('.para-level').length, 13, 'level badges shown per text');
  reader().querySelectorAll('.chip')[0].click(); // restore default
});

// --- topic page --------------------------------------------------------

await go('#/tema/arbeid');
await new Promise((r) => setTimeout(r, 20)); // occurrence index fetches every text

check('topic: lists its texts and key vocabulary', () => {
  assert.equal(doc.body.dataset.view, 'topic');
  assert.includes($('doc-title').textContent, 'Arbeid');
  assert.equal(reader().querySelectorAll('.para-link').length, 3);
  assert.atLeast(reader().querySelectorAll('.word-chip').length, 5, 'key words missing');
});

check('topic: shows the speaking prompts of its texts', () => {
  assert.atLeast(reader().querySelectorAll('.prompt-item').length, 2);
});

check('topic: a key word opens the card', () => {
  reader().querySelector('.word-chip').click();
  assert.equal($('card').hidden, false);
  $('card-close').click();
});

check('topic: unknown topic falls back to home', () => {
  globalThis.location.hash = '#/tema/nope';
  doc.dispatch('hashchange');
  assert.equal(doc.body.dataset.view, 'home');
});

// --- dictionary --------------------------------------------------------

await go('#/ordbok');

check('dict: renders entry rows (regression: was empty)', () => {
  const rows = reader().querySelectorAll('.dict-row');
  assert.atLeast(rows.length, 600, `dictionary rendered ${rows.length} rows`);
});

check('dict: renders letter headings', () => {
  const letters = reader().querySelectorAll('.dict-letter');
  assert.atLeast(letters.length, 20);
});

check('dict: controls are visible', () => {
  assert.equal($('dict-controls').hidden, false);
});

check('dict: filter chips rendered', () => {
  assert.atLeast($('dict-filters').querySelectorAll('.chip').length, 5);
});

check('dict: rows carry a stable entry id', () => {
  const row = reader().querySelector('.dict-row');
  assert.ok(row.getAttribute('data-entry-id'), 'row should carry data-entry-id');
});

check('dict: glosses are hidden by default', () => {
  assert.equal(
    reader().classList.contains('show-gloss'),
    false,
    'list should not start with glosses revealed'
  );
  const toggle = $('dict-gloss-toggle');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.includes(toggle.textContent, 'Vis');
});

check('dict: the gloss text is still in the DOM, only hidden by CSS', () => {
  // Hidden via a container class, not by omitting content — so search over
  // glosses keeps working and revealing costs no re-render.
  const gloss = reader().querySelector('.dict-gloss');
  assert.ok(gloss, 'gloss element missing');
  assert.ok(gloss.textContent.length > 0, 'gloss element is empty');
});

check('dict: toggle reveals glosses', () => {
  const toggle = $('dict-gloss-toggle');
  toggle.click();
  assert.equal(reader().classList.contains('show-gloss'), true);
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.includes(toggle.textContent, 'Skjul');
});

check('dict: toggle hides them again', () => {
  const toggle = $('dict-gloss-toggle');
  toggle.click();
  assert.equal(reader().classList.contains('show-gloss'), false);
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
});

check('dict: the choice persists across a re-render', () => {
  const toggle = $('dict-gloss-toggle');
  toggle.click(); // on
  const search = $('dict-search');
  search.value = 'barn';
  search.dispatch('input'); // re-renders the list
  assert.equal(
    reader().classList.contains('show-gloss'),
    true,
    'revealing must survive a re-render'
  );
  search.value = '';
  search.dispatch('input');
  toggle.click(); // back off, so later tests see the default
});

check('dict: search narrows the list', () => {
  const search = $('dict-search');
  search.value = 'barnehage';
  search.dispatch('input');
  const rows = reader().querySelectorAll('.dict-row');
  assert.ok(rows.length > 0 && rows.length < 20, `search returned ${rows.length} rows`);
  search.value = '';
  search.dispatch('input');
});

check('dict: search finds a lemma by inflected form', () => {
  const search = $('dict-search');
  search.value = 'gikk';
  search.dispatch('input');
  const heads = reader().querySelectorAll('.dict-head').map((s) => s.textContent);
  assert.ok(heads.some((h) => h.includes('gå')), `expected å gå, got ${heads.slice(0, 5)}`);
  search.value = '';
  search.dispatch('input');
});

check('dict: pos filter narrows the list', () => {
  const chips = $('dict-filters').querySelectorAll('.chip');
  const verbChip = chips.find((c) => c.textContent === 'Verb');
  verbChip.click();
  const rows = reader().querySelectorAll('.dict-row');
  assert.ok(rows.length > 50 && rows.length < 300, `verb filter returned ${rows.length}`);
  chips.find((c) => c.textContent === 'Alle').click();
});

// --- reading -----------------------------------------------------------

await go('#/barnehagen');

check('reader: renders sentences', () => {
  assert.atLeast(reader().querySelectorAll('.sentence').length, 5);
});

check('reader: renders tappable words', () => {
  assert.atLeast(reader().querySelectorAll('.w').length, 50);
});

check('reader: tappable words carry lemma and entry id', () => {
  const w = reader().querySelector('.w');
  assert.ok(w.getAttribute('data-lemma'), 'missing data-lemma');
  assert.ok(w.getAttribute('data-entry-id'), 'missing data-entry-id');
});

check('reader: phrase words are grouped', () => {
  const phrases = reader().querySelectorAll('.is-phrase');
  assert.atLeast(phrases.length, 2);
});

check('reader: title is shown in the topbar', () => {
  assert.includes($('doc-title').textContent, 'barnehagen');
});

check('reader: exam note box links to the topic', () => {
  const link = reader().querySelector('.exam-note-topic');
  assert.ok(link, 'topic link missing');
  assert.equal(link.getAttribute('href'), '#/tema/hverdag');
});

check('reader: mode chips offer read, cloze and speak', () => {
  const chips = reader().querySelectorAll('.chip').map((c) => c.textContent);
  assert.equal(chips.join(','), 'Les,Fyll inn,Snakk');
});

// --- word card ---------------------------------------------------------

check('card: shows the gloss even when the list hides it', () => {
  // The toggle governs the browsing list only; the card is the answer.
  const word = reader().querySelectorAll('.w').find((w) => w.getAttribute('data-lemma') === 'gå');
  word.click();
  const gloss = $('card-body').querySelector('.card-gloss');
  assert.ok(gloss && gloss.textContent.trim().length > 0, 'card must always show the gloss');
  $('card-close').click();
});

check('card: opens with headword, table and gloss', () => {
  const word = reader().querySelectorAll('.w').find((w) => w.getAttribute('data-lemma') === 'gå');
  assert.ok(word, 'expected a word for å gå');
  word.click();

  assert.equal($('card').hidden, false, 'card should be open');
  const body = $('card-body');
  assert.includes(body.textContent, 'gå');
  assert.atLeast(body.querySelectorAll('.table').length, 1, 'inflection table missing');
  assert.atLeast(body.querySelectorAll('.card-gloss').length, 1, 'gloss missing');
});

check('card: names the form that was tapped', () => {
  const form = $('card-body').querySelector('.card-form');
  assert.ok(form && form.textContent.length > 0, 'form line missing');
});

check('card: aria-expanded set on the opener', () => {
  const open = reader().querySelectorAll('.w').find((w) => w.getAttribute('aria-expanded') === 'true');
  assert.ok(open, 'no word marked aria-expanded=true');
});

check('card: closes and restores state', () => {
  $('card-close').click();
  assert.equal($('card').hidden, true);
  assert.equal($('card-scrim').hidden, true);
});

check('reader: looked-up words are listed under the text', () => {
  const chips = reader().querySelector('.lookups').querySelectorAll('.word-chip');
  assert.atLeast(chips.length, 1, 'tapping a word should add it to the list');
  assert.ok(chips.some((c) => c.textContent.includes('gå')));
});

// --- cloze -------------------------------------------------------------

check('cloze: blanks content words with the base form as hint', () => {
  reader().querySelectorAll('.chip').find((c) => c.textContent === 'Fyll inn').click();
  const inputs = reader().querySelectorAll('.cloze-input');
  assert.atLeast(inputs.length, 5, 'expected blanks');
  assert.ok(inputs.every((i) => i.dataset.answer.length >= 4));
  assert.atLeast(reader().querySelectorAll('.cloze-hint').length, inputs.length);
  assert.equal(reader().querySelectorAll('.w').length, 0, 'no tappable words in cloze mode');
});

check('cloze: grading marks right and wrong answers', () => {
  const inputs = reader().querySelectorAll('.cloze-input');
  inputs[0].value = inputs[0].dataset.answer.toUpperCase();
  inputs[1].value = 'xxxx';
  reader().querySelectorAll('.btn-primary').find((b) => b.textContent === 'Sjekk').click();
  assert.ok(inputs[0].classList.contains('is-right'), 'case-insensitive match should pass');
  assert.ok(inputs[1].classList.contains('is-wrong'));
  assert.includes(reader().querySelector('.scratch-stats').textContent, 'riktige');
});

check('cloze: reveal fills every blank correctly', () => {
  reader().querySelectorAll('.btn-quiet').find((b) => b.textContent === 'Vis fasit').click();
  const inputs = reader().querySelectorAll('.cloze-input');
  assert.ok(inputs.every((i) => i.classList.contains('is-right')));
});

// --- speaking practice -------------------------------------------------

check('speak: shows key words and a two-minute timer', () => {
  reader().querySelectorAll('.chip').find((c) => c.textContent === 'Snakk').click();
  assert.atLeast(reader().querySelectorAll('.word-chip').length, 5);
  assert.equal(reader().querySelector('.timer-clock').textContent, '2:00');
  assert.equal(reader().querySelectorAll('.sentence').length, 0, 'text is hidden while speaking');
});

check('speak: switching back to read restores the text', () => {
  reader().querySelectorAll('.chip').find((c) => c.textContent === 'Les').click();
  assert.atLeast(reader().querySelectorAll('.sentence').length, 5);
});

// --- review ------------------------------------------------------------

await go('#/ov');

check('review: deck holds the words looked up in the reader', () => {
  assert.equal(doc.body.dataset.view, 'review');
  const word = reader().querySelector('.flip-word');
  assert.ok(word, 'no flip card');
  assert.includes(reader().querySelector('.review-progress').textContent, 'av');
});

check('review: flip reveals gloss, then grading advances', () => {
  const before = reader().querySelector('.flip-word').textContent;
  assert.equal(reader().querySelector('.flip-back').hidden, true);
  reader().querySelectorAll('.btn-primary').find((b) => b.textContent === 'Vis').click();
  assert.equal(reader().querySelector('.flip-back').hidden, false);
  assert.ok(reader().querySelector('.flip-back').querySelector('.card-gloss').textContent.length > 0);
  reader().querySelectorAll('.btn-primary').find((b) => b.textContent === 'Kunne det').click();
  const after = reader().querySelector('.flip-word')?.textContent ?? reader().querySelector('.review-empty').textContent;
  assert.ok(after !== before, 'deck should advance');
});

const reviewStore = () => JSON.parse(globalThis.localStorage.getItem('norsk:review'));
const reopenReview = () => {
  globalThis.location.hash = '';
  doc.dispatch('hashchange');
  globalThis.location.hash = '#/ov';
  doc.dispatch('hashchange');
};

check('review: "Kunne det" schedules the word for later and it leaves today\'s deck', () => {
  globalThis.localStorage.setItem('norsk:review', JSON.stringify({ 'gå-v': { n: 1, box: 0, last: 1, due: 1, para: 'barnehagen' } }));
  reopenReview();
  assert.includes($('doc-meta').textContent, '1 å øve på nå');
  reader().querySelectorAll('.btn-primary').find((b) => b.textContent === 'Vis').click();
  reader().querySelectorAll('.btn-primary').find((b) => b.textContent === 'Kunne det').click();
  const r = reviewStore()['gå-v'];
  assert.equal(r.box, 1);
  const day = 24 * 60 * 60 * 1000;
  assert.ok(r.due > Date.now() + day - 5000 && r.due <= Date.now() + day, 'box 1 is due in one day');
  reopenReview();
  assert.includes($('doc-meta').textContent, '0 å øve på nå');
  const empty = reader().querySelector('.review-empty');
  assert.ok(empty, 'empty state expected');
  assert.includes(empty.textContent, '1 ord venter');
  assert.includes(empty.textContent, 'i morgen');
});

check('review: box 4 counts as learnt but still comes back when due', () => {
  globalThis.localStorage.setItem('norsk:review', JSON.stringify({ 'gå-v': { n: 1, box: 3, last: 1, due: 1, para: 'barnehagen' } }));
  reopenReview();
  reader().querySelectorAll('.btn-primary').find((b) => b.textContent === 'Vis').click();
  reader().querySelectorAll('.btn-primary').find((b) => b.textContent === 'Kunne det').click();
  reopenReview();
  assert.includes($('doc-meta').textContent, '0 å øve på nå · 1 lært');
  // Time passes: force the due date into the past and it is back in the deck.
  const data = reviewStore();
  data['gå-v'].due = Date.now() - 1000;
  globalThis.localStorage.setItem('norsk:review', JSON.stringify(data));
  reopenReview();
  assert.includes($('doc-meta').textContent, '1 å øve på nå · 1 lært');
});

check('review: "Øv mer" drops a word back to box 0, due now', () => {
  globalThis.localStorage.setItem('norsk:review', JSON.stringify({ 'gå-v': { n: 1, box: 3, last: 1, due: 1, para: 'barnehagen' } }));
  reopenReview();
  reader().querySelectorAll('.btn-primary').find((b) => b.textContent === 'Vis').click();
  reader().querySelectorAll('.btn-quiet').find((b) => b.textContent === 'Øv mer').click();
  const r = reviewStore()['gå-v'];
  assert.equal(r.box, 0);
  assert.ok(r.due <= Date.now());
});

check('review: records saved before scheduling existed are treated as due', () => {
  globalThis.localStorage.setItem('norsk:review', JSON.stringify({ 'gå-v': { n: 1, box: 1, last: 1, para: 'barnehagen' } }));
  reopenReview();
  assert.includes($('doc-meta').textContent, '1 å øve på nå');
});

check('review: looking a scheduled word up again resets it to box 0', () => {
  globalThis.localStorage.setItem('norsk:review', JSON.stringify({ 'gå-v': { n: 1, box: 3, last: 1, due: Date.now() + 1e9, para: 'barnehagen' } }));
  globalThis.location.hash = '#/barnehagen';
  doc.dispatch('hashchange');
});

await new Promise((r) => setImmediate(r));

check('review: (continued) the reader tap is recorded as a reset', () => {
  reader().querySelectorAll('.w').find((w) => w.getAttribute('data-lemma') === 'gå').click();
  $('card-close').click();
  const r = reviewStore()['gå-v'];
  assert.equal(r.box, 0);
  assert.ok(r.due <= Date.now());
  assert.equal(r.n, 2);
});

check('review: empty store shows the onboarding text', () => {
  globalThis.localStorage.removeItem('norsk:review');
  globalThis.location.hash = '';
  doc.dispatch('hashchange');
  globalThis.location.hash = '#/ov';
  doc.dispatch('hashchange');
  assert.includes(reader().querySelector('.review-empty').textContent, 'Ingen ord');
});

// --- scratch -----------------------------------------------------------

await go('#/skriv');

check('scratch: controls visible, reader empty until text is read', () => {
  assert.equal($('scratch-controls').hidden, false);
});

check('scratch: renders known and unknown words', () => {
  $('scratch-input').value =
    'Jeg går til barnehagen. Regjeringen foreslår nye tiltak for miljøet.';
  $('scratch-read').click();

  const known = reader().querySelectorAll('.w').filter((w) => !w.classList.contains('w-unknown'));
  const unknown = reader().querySelectorAll('.w-unknown');
  assert.atLeast(known.length, 5, 'expected known words');
  assert.atLeast(unknown.length, 2, 'expected unknown words to be marked');
});

check('scratch: reports coverage', () => {
  assert.includes($('scratch-stats').textContent, 'kjent');
});

check('scratch: unknown word opens a stub card', () => {
  const unknown = reader().querySelector('.w-unknown');
  unknown.click();
  const body = $('card-body');
  assert.includes(body.textContent, 'ikke i ordboka');
  assert.atLeast(body.querySelectorAll('.card-stub').length, 1, 'stub missing');
  $('card-close').click();
});

// --- progress ----------------------------------------------------------

const progress = () => JSON.parse(globalThis.localStorage.getItem('norsk:progress') ?? '{}');

await go('#/jobben');

check('progress: opening a text records it', () => {
  const r = progress().jobben;
  assert.ok(r, 'no record for jobben');
  assert.atLeast(r.opens, 1);
  assert.ok(r.first > 0 && r.last >= r.first);
});

check('progress: a graded cloze stores the best score, reveal does not', () => {
  reader().querySelectorAll('.chip').find((c) => c.textContent === 'Fyll inn').click();
  const inputs = reader().querySelectorAll('.cloze-input');
  inputs[0].value = inputs[0].dataset.answer;
  reader().querySelectorAll('.btn-primary').find((b) => b.textContent === 'Sjekk').click();
  assert.equal(progress().jobben.cloze.best, 1);
  assert.equal(progress().jobben.cloze.total, inputs.length);
  reader().querySelectorAll('.btn-quiet').find((b) => b.textContent === 'Vis fasit').click();
  assert.equal(progress().jobben.cloze.best, 1, 'revealing must not count as an attempt');
});

check('progress: the mode is remembered and restored on reopen', () => {
  assert.equal(progress().jobben.mode, 'cloze');
  globalThis.location.hash = '#/tekster';
  doc.dispatch('hashchange');
  globalThis.location.hash = '#/jobben';
  doc.dispatch('hashchange');
});

await new Promise((r) => setImmediate(r));

check('progress: reopened text lands in the saved mode', () => {
  const on = reader().querySelectorAll('.chip').find((c) => c.getAttribute('aria-pressed') === 'true');
  assert.equal(on.textContent, 'Fyll inn');
  assert.atLeast(reader().querySelectorAll('.cloze-input').length, 1);
});

await go('#/tekster');

check('progress: list marks read texts and the last one', () => {
  const badgeFor = (id) => {
    const a = reader().querySelectorAll('.para-link').find((l) => l.getAttribute('href') === `#/${id}`);
    return a.querySelector('.badge')?.textContent ?? '';
  };
  assert.equal(badgeFor('jobben'), 'sist lest');
  assert.equal(badgeFor('barnehagen'), 'lest');
  assert.equal(badgeFor('miljo'), '', 'unopened text has no badge');
});

check('progress: finished = full cloze + speaking timer completed', () => {
  const data = progress();
  data.barnehagen = { ...data.barnehagen, spoke: true, cloze: { best: 4, total: 4 } };
  globalThis.localStorage.setItem('norsk:progress', JSON.stringify(data));
  globalThis.location.hash = '';
  doc.dispatch('hashchange');
  globalThis.location.hash = '#/tekster';
  doc.dispatch('hashchange');
  const a = reader().querySelectorAll('.para-link').find((l) => l.getAttribute('href') === '#/barnehagen');
  assert.equal(a.querySelector('.badge').textContent, '✓ ferdig');
});

await go('');

check('progress: home shows the summary and a continue link in the saved mode', () => {
  assert.includes($('reader').querySelector('.home-stats').textContent, 'tekster lest');
  assert.includes($('reader').querySelector('.home-stats').textContent, '1 ferdig');
  const cont = $('reader').querySelector('.home-continue');
  assert.ok(cont, 'continue link missing');
  assert.equal(cont.getAttribute('href'), '#/jobben');
  assert.includes(cont.textContent, 'Fyll inn');
});

check('progress: home without any history shows no status block', () => {
  globalThis.localStorage.removeItem('norsk:progress');
  globalThis.location.hash = '#/tekster';
  doc.dispatch('hashchange');
  globalThis.location.hash = '';
  doc.dispatch('hashchange');
  assert.equal($('reader').querySelector('.home-status'), null);
});

// --- chrome invariants -------------------------------------------------

check('chrome: each view hides the others’ controls', () => {
  // dictionary -> reader must not leave the search box behind
  const seen = [];
  for (const [hash, expectDict, expectScratch] of [
    ['#/ordbok', false, true],
    ['#/barnehagen', true, true],
    ['#/skriv', true, false],
    ['', true, true],
  ]) {
    globalThis.location.hash = hash;
    doc.dispatch('hashchange');
    seen.push([hash, $('dict-controls').hidden, $('scratch-controls').hidden, expectDict, expectScratch]);
  }
  for (const [hash, dictHidden, scratchHidden, expectDict, expectScratch] of seen) {
    if (dictHidden !== expectDict) throw new Error(`${hash}: dict-controls hidden=${dictHidden}, expected ${expectDict}`);
    if (scratchHidden !== expectScratch) throw new Error(`${hash}: scratch-controls hidden=${scratchHidden}, expected ${expectScratch}`);
  }
});

// --- report ------------------------------------------------------------

console.log();
if (failures.length === 0) {
  console.log(`  ${passed} passed`);
} else {
  console.log(`  ${passed} passed, ${failures.length} failed\n`);
  for (const f of failures) {
    console.log(`  FAIL  ${f.name}`);
    console.log(`        ${f.message}`);
  }
}
console.log();
process.exit(failures.length > 0 ? 1 : 0);
