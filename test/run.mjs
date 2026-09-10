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
    fn();
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

check('home: renders three destinations', () => {
  const links = reader().querySelectorAll('.home-link');
  assert.equal(links.length, 3);
});

check('home: destinations point at the right routes', () => {
  const hrefs = reader().querySelectorAll('.home-link').map((a) => a.getAttribute('href'));
  assert.equal(hrefs.join(','), '#/tekster,#/ordbok,#/skriv');
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

check('texts: lists every paragraph in the index', async () => {
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

// --- chrome invariants -------------------------------------------------

check('chrome: each view hides the others’ controls', async () => {
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
