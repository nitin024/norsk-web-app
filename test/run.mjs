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
/** The reading-mode chips live in their own bar, not inside #reader. */
const modeChips = () => $('mode-bar').querySelectorAll('.chip');
const pickMode = (label) => {
  const chip = modeChips().find((c) => c.textContent === label);
  if (!chip) throw new Error(`no mode chip "${label}" (have: ${modeChips().map((c) => c.textContent).join(',')})`);
  chip.click();
};

/** Drive the router the way a hash change would. */
async function go(hash) {
  globalThis.location.hash = hash;
  doc.dispatch('hashchange');
  await new Promise((r) => setImmediate(r));
}

// --- home --------------------------------------------------------------

await go('');

check('home: renders eight destinations, course first', () => {
  const links = reader().querySelectorAll('.home-link');
  assert.equal(links.length, 8);
});

check('home: destinations point at the right routes', () => {
  const hrefs = reader().querySelectorAll('.home-link').map((a) => a.getAttribute('href'));
  assert.equal(hrefs.join(','), '#/kurs,#/tekster,#/ordbok,#/ov,#/grammatikk,#/tall,#/prove,#/skriv');
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
  assert.atLeast(reader().querySelectorAll('.para-link').length, 3);
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

check('dict: cards view shows one flash card over the filtered set', () => {
  const search = $('dict-search');
  search.value = 'barnehage';
  search.dispatch('input');
  const listCount = reader().querySelectorAll('.dict-row').length;
  const toggle = $('dict-view-toggle');
  assert.equal(toggle.textContent, 'Kort');
  toggle.click();
  assert.equal(toggle.textContent, 'Liste');
  assert.equal(reader().querySelectorAll('.dict-row').length, 0, 'list hidden in card view');
  assert.ok(reader().querySelector('.flip-word'), 'a card should show');
  assert.includes(reader().querySelector('.review-progress').textContent, `av ${listCount}`);
});

check('dict: card flips, and grading feeds the spaced schedule', () => {
  globalThis.localStorage.removeItem('norsk:review');
  assert.equal(reader().querySelector('.flip-back').hidden, true);
  reader().querySelectorAll('.btn-primary').find((b) => b.textContent === 'Vis').click();
  assert.equal(reader().querySelector('.flip-back').hidden, false);
  // "Kunne det" on a word never seen: lands in box 1, due tomorrow, not reset.
  reader().querySelectorAll('.btn-primary').find((b) => b.textContent === 'Kunne det').click();
  let store = JSON.parse(globalThis.localStorage.getItem('norsk:review'));
  const [id, rec] = Object.entries(store)[0];
  assert.ok(id, 'entry should be in the review store');
  assert.equal(rec.box, 1);
  assert.ok(rec.due > Date.now() + 23 * 60 * 60 * 1000, 'due about a day out');
  assert.ok(reader().querySelector('.flip-word'), 'next card should show');
  assert.equal(reader().querySelector('.flip-back').hidden, true, 'next card starts face down');
  // "Øv mer" on the next card: box 0, due now.
  reader().querySelectorAll('.btn-primary').find((b) => b.textContent === 'Vis').click();
  reader().querySelectorAll('.btn-quiet').find((b) => b.textContent === 'Øv mer').click();
  store = JSON.parse(globalThis.localStorage.getItem('norsk:review'));
  const again = Object.values(store).find((r) => r.box === 0);
  assert.ok(again && again.due <= Date.now(), 'Øv mer should be due now');
  globalThis.localStorage.removeItem('norsk:review');
  $('dict-view-toggle').click(); // back to list for the later tests
  $('dict-search').value = '';
  $('dict-search').dispatch('input');
  assert.equal(globalThis.localStorage.getItem('norsk:dictView'), 'list');
});
check('dict: the letter rail covers the Norwegian alphabet', () => {
  const rail = $('letter-rail');
  assert.equal(rail.hidden, false, 'rail should show in the alphabetical list');
  const letters = rail.querySelectorAll('.rail-letter').map((b) => b.textContent);
  assert.equal(letters.length, 29, 'A–Å is 29 letters');
  assert.equal(letters.slice(-3).join(''), 'ÆØÅ', 'æ ø å sort after z');
});

check('dict: every rail letter points at a heading that exists', () => {
  const live = $('letter-rail')
    .querySelectorAll('.rail-letter')
    .filter((b) => !b.classList.contains('is-empty'));
  assert.atLeast(live.length, 20, 'most letters should have entries');
  for (const btn of live) {
    const heading = $(`letter-${btn.textContent}`);
    if (!heading) throw new Error(`rail offers ${btn.textContent} but there is no heading`);
  }
});

check('dict: a search greys out the letters it removes', () => {
  $('dict-search').value = 'barn';
  $('dict-search').dispatch('input');
  const rail = $('letter-rail');
  const letters = rail.querySelectorAll('.rail-letter');
  assert.equal(letters.length, 29, 'the rail keeps its shape as the list narrows');
  const empty = letters.filter((b) => b.classList.contains('is-empty'));
  assert.atLeast(empty.length, 20, 'most letters have no match for "barn"');
  // An inert letter must not be reachable by keyboard or screen reader.
  assert.equal(empty[0].disabled, true);
  assert.equal(empty[0].getAttribute('aria-hidden'), 'true');
  $('dict-search').value = '';
  $('dict-search').dispatch('input');
});

check('dict: the rail is hidden when the order is not alphabetical', () => {
  reader().querySelectorAll('.chip').find((c) => c.textContent === 'Tilfeldig').click();
  assert.equal($('letter-rail').hidden, true, 'a shuffled list has no letters to jump to');
  reader().querySelectorAll('.chip').find((c) => c.textContent === 'A–Å').click();
  assert.equal($('letter-rail').hidden, false);
});

check('dict: the rail does not follow you out of the dictionary', () => {
  globalThis.location.hash = '#/tekster';
  doc.dispatch('hashchange');
  assert.equal($('letter-rail').hidden, true);
  globalThis.location.hash = '#/ordbok';
  doc.dispatch('hashchange');
  assert.equal($('letter-rail').hidden, false);
});

check('dict cards: order chips offer fixed, random and alphabetical', () => {
  $('dict-search').value = 'barn';
  $('dict-search').dispatch('input');
  $('dict-view-toggle').click(); // to cards
  const chips = reader().querySelectorAll('.chip').map((c) => c.textContent);
  assert.equal(chips.join(','), 'A–Å,Fast,Tilfeldig');

  // Alphabetical is the default: the first card is the first match in the list.
  const alpha = reader().querySelector('.flip-word').textContent;
  $('dict-view-toggle').click(); // list
  const listFirst = reader().querySelector('.dict-head').textContent;
  assert.equal(alpha, listFirst, 'A–Å should follow the list order');

  // The order chip governs the list too, and shuffling drops letter headings.
  reader().querySelectorAll('.chip').find((c) => c.textContent === 'Fast').click();
  assert.equal(globalThis.localStorage.getItem('norsk:dictOrder'), 'fast');
  assert.equal(reader().querySelectorAll('.dict-letter').length, 0, 'no headings when shuffled');
  assert.atLeast(reader().querySelectorAll('.dict-row').length, 3, 'rows still render');

  // Fixed: leaving and returning gives the same first row.
  const firstRow = reader().querySelector('.dict-head').textContent;
  $('dict-view-toggle').click();
  $('dict-view-toggle').click();
  assert.equal(reader().querySelector('.dict-head').textContent, firstRow, 'fixed order must be stable');

  reader().querySelectorAll('.chip').find((c) => c.textContent === 'A–Å').click();
  assert.atLeast(reader().querySelectorAll('.dict-letter').length, 1, 'headings return in A–Å')
  $('dict-search').value = '';
  $('dict-search').dispatch('input');
});

check('dict cards: the gloss toggle turns the deck around for beginners', () => {
  $('dict-search').value = 'barnehage';
  $('dict-search').dispatch('input');
  $('dict-view-toggle').click(); // to cards
  const norskFirst = reader().querySelector('.flip-word').textContent;
  assert.equal($('dict-gloss-toggle').textContent, 'Norsk først');

  $('dict-gloss-toggle').click(); // English first
  assert.equal($('dict-gloss-toggle').textContent, 'Engelsk først');
  const front = reader().querySelector('.flip-word').textContent;
  assert.ok(front !== norskFirst, 'front should now be the English gloss');
  assert.equal(reader().querySelectorAll('.flip-answer').length, 1, 'answer side holds the Norwegian');
  assert.equal(reader().querySelector('.flip-back').hidden, true, 'answer stays hidden until Vis');

  reader().querySelectorAll('.btn-primary').find((b) => b.textContent === 'Vis').click();
  assert.equal(reader().querySelector('.flip-answer').textContent, norskFirst);

  $('dict-gloss-toggle').click(); // back to Norwegian first
  $('dict-view-toggle').click(); // back to list
  $('dict-search').value = '';
  $('dict-search').dispatch('input');
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

check('reader: the mode bar shows only while a text is open', () => {
  assert.equal($('mode-bar').hidden, false, 'bar should show in the reader');
  assert.equal(reader().querySelectorAll('.chip').length, 0, 'chips are not inside the text');
  globalThis.location.hash = '#/ordbok';
  doc.dispatch('hashchange');
  assert.equal($('mode-bar').hidden, true, 'bar must not linger on other views');
  globalThis.location.hash = '#/barnehagen';
  doc.dispatch('hashchange');
});

await new Promise((r) => setImmediate(r));

check('reader: a text without an exam note gets no toggle', () => {
  // barnehagen has no examNote, so the box is just the topic link.
  const note = reader().querySelector('.exam-note');
  assert.ok(note, 'box should still carry the topic link');
  assert.equal(note.querySelectorAll('.exam-note-toggle').length, 0);
  assert.equal(note.querySelectorAll('.exam-note-text').length, 0);
});

await go('#/jobben');

check('reader: the exam note collapses and the choice persists', () => {
  const note = reader().querySelector('.exam-note');
  const text = note.querySelector('.exam-note-text');
  const toggle = note.querySelector('.exam-note-toggle');
  assert.ok(toggle, 'toggle missing');
  assert.equal(text.hidden, false, 'open by default');
  assert.equal(toggle.textContent, 'Skjul');
  toggle.click();
  assert.equal(text.hidden, true);
  assert.equal(toggle.textContent, 'Til muntlig');
  assert.equal(globalThis.localStorage.getItem('norsk:examNoteOpen'), '0');
  toggle.click();
  assert.equal(text.hidden, false);
});

await go('#/barnehagen');

check('reader: exam note box links to the topic', () => {
  const link = reader().querySelector('.exam-note-topic');
  assert.ok(link, 'topic link missing');
  assert.equal(link.getAttribute('href'), '#/tema/hverdag');
});

check('reader: mode chips offer read, cloze, listen and speak', () => {
  const chips = modeChips().map((c) => c.textContent);
  assert.equal(chips.join(','), 'Les,Fyll inn,Lytt,Snakk');
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
  pickMode('Fyll inn');
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

check('cloze: reveal shows the key beside each blank without touching the answers', () => {
  const inputs = reader().querySelectorAll('.cloze-input');
  const typed = inputs.map((i) => i.value);
  const reveal = reader().querySelectorAll('.btn-quiet').find((b) => b.textContent === 'Vis fasit');
  reveal.click();
  const keys = reader().querySelectorAll('.cloze-key');
  assert.equal(keys.length, inputs.length);
  assert.ok(keys.every((k) => k.hidden === false), 'keys should be visible');
  assert.ok(inputs.every((i, n) => i.value === typed[n]), 'inputs must keep what was typed');
  assert.ok(inputs[1].classList.contains('is-wrong'), 'a wrong answer stays marked wrong next to the key');
  assert.equal(reveal.textContent, 'Skjul fasit');
});

check('cloze: reveal can be undone', () => {
  reader().querySelectorAll('.btn-quiet').find((b) => b.textContent === 'Skjul fasit').click();
  assert.ok(reader().querySelectorAll('.cloze-key').every((k) => k.hidden === true));
});

check('cloze: hints can be hidden and the choice persists', () => {
  const toggle = reader().querySelector('.cloze-hint-toggle');
  assert.equal(toggle.textContent, 'Skjul hint');
  toggle.click();
  assert.ok(reader().classList.contains('hide-hints'));
  assert.equal(toggle.textContent, 'Vis hint');
  assert.equal(globalThis.localStorage.getItem('norsk:clozeHints'), '0');
  toggle.click();
  assert.ok(!reader().classList.contains('hide-hints'));
});

// --- speaking practice -------------------------------------------------

check('speak: shows key words and a two-minute timer', () => {
  pickMode('Snakk');
  assert.atLeast(reader().querySelectorAll('.word-chip').length, 5);
  assert.equal(reader().querySelector('.timer-clock').textContent, '2:00');
  assert.equal(reader().querySelectorAll('.sentence').length, 0, 'text is hidden while speaking');
});

check('speak: switching back to read restores the text', () => {
  pickMode('Les');
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
  pickMode('Fyll inn');
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
  const on = modeChips().find((c) => c.getAttribute('aria-pressed') === 'true');
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

// --- grammar -----------------------------------------------------------

await go('#/grammatikk');
await new Promise((r) => setTimeout(r, 20));

check('grammar: renders every section and rule from grammar.json', () => {
  assert.equal(doc.body.dataset.view, 'grammar');
  const sections = reader().querySelectorAll('.level');
  assert.atLeast(sections.length, 3);
  assert.atLeast(reader().querySelectorAll('.rule').length, 10);
});

check('grammar: every rule carries a note for English speakers', () => {
  const rules = reader().querySelectorAll('.rule');
  const notes = reader().querySelectorAll('.rule-english');
  assert.equal(notes.length, rules.length, 'each rule needs an english note');
  assert.includes(notes[0].textContent, 'For English speakers');
});

check('grammar: the nouns-and-adjectives section is present', () => {
  const titles = reader().querySelectorAll('.level-title').map((h) => h.textContent);
  assert.ok(titles.some((t) => t.includes('Substantiv')), `sections: ${titles.join(' | ')}`);
});

check('grammar: examples are tappable and open the word card', () => {
  const words = reader().querySelectorAll('.rule-examples').flatMap((e) => e.querySelectorAll('.w'));
  assert.atLeast(words.length, 40, 'examples should be parsed into tappable words');
  words[0].click();
  assert.equal($('card').hidden, false);
  $('card-close').click();
});

check('grammar: scrambled sentence is not in order and has all its words', () => {
  const ex = reader().querySelector('.scramble');
  const chips = ex.querySelector('.scramble-pool').querySelectorAll('.scramble-chip').map((c) => c.textContent);
  assert.atLeast(chips.length, 3);
  assert.ok(chips.join(' ') !== 'I morgen skal jeg jobbe.', 'must be shuffled');
  assert.equal([...chips].sort().join(' '), ['I', 'morgen', 'skal', 'jeg', 'jobbe.'].sort().join(' '));
});

check('grammar: placing the words in the right order passes the check', () => {
  const ex = reader().querySelector('.scramble');
  const pick = (text) => ex.querySelector('.scramble-pool').querySelectorAll('.scramble-chip').find((c) => c.textContent === text).click();
  for (const w of ['I', 'morgen', 'skal', 'jeg', 'jobbe.']) pick(w);
  ex.querySelectorAll('.btn-primary').find((b) => b.textContent === 'Sjekk').click();
  assert.ok(ex.classList.contains('is-right'));
  assert.includes(ex.querySelector('.scratch-stats').textContent, 'Riktig');
});

check('grammar: a wrong order is marked wrong and a placed chip can be taken back', () => {
  const ex = reader().querySelectorAll('.scramble')[1];
  const pool = () => ex.querySelector('.scramble-pool').querySelectorAll('.scramble-chip');
  const all = pool().map((c) => c.textContent);
  pool().find((c) => c.textContent === all[0]).click();
  pool().find((c) => c.textContent === all[1]).click();
  ex.querySelectorAll('.btn-primary').find((b) => b.textContent === 'Sjekk').click();
  assert.ok(ex.classList.contains('is-wrong'));
  ex.querySelector('.scramble-answer').querySelector('.scramble-chip').click();
  assert.equal(ex.querySelector('.scramble-answer').querySelectorAll('.scramble-chip').length, 1);
  assert.ok(!ex.classList.contains('is-wrong'), 'changing the answer clears the verdict');
});

check('grammar: "Vis" lays out the correct sentence', () => {
  const ex = reader().querySelectorAll('.scramble')[2];
  ex.querySelectorAll('.btn-quiet').find((b) => b.textContent === 'Vis').click();
  const built = ex.querySelector('.scramble-answer').querySelectorAll('.scramble-chip').map((c) => c.textContent).join(' ');
  assert.equal(built, 'Nå bor vi i Drammen.');
});

// --- exercises, pronunciation ------------------------------------------

check('grammar: a choice exercise marks the rule passed', () => {
  globalThis.localStorage.removeItem('norsk:rules');
  const rule = $('rule-v2');
  assert.ok(rule, 'rule-v2 missing');
  const ex = rule.querySelector('.exercise');
  assert.ok(ex, 'v2 should have an exercise');
  const wrong = ex.querySelectorAll('.scramble-chip').find((c) => c.textContent === 'vi reiser');
  wrong.click();
  assert.ok(ex.classList.contains('is-wrong'));
  assert.includes(ex.querySelector('.scratch-stats').textContent, 'reiser vi');
  ex.querySelectorAll('.scramble-chip').find((c) => c.textContent === 'reiser vi').click();
  assert.ok(ex.classList.contains('is-right'));
  assert.ok(JSON.parse(globalThis.localStorage.getItem('norsk:rules')).v2.passed);
  assert.ok(rule.classList.contains('is-passed'));
});

check('grammar: a fill exercise grades loosely on case and punctuation', () => {
  const rule = $('rule-preteritum');
  const ex = rule.querySelector('.exercise');
  const input = ex.querySelector('.dictation-input');
  input.value = ' VAR ';
  ex.querySelectorAll('.btn-primary').find((b) => b.textContent === 'Sjekk').click();
  assert.ok(ex.classList.contains('is-right'));
});

check('grammar: pronunciation section exists', () => {
  const titles = reader().querySelectorAll('.level-title').map((h) => h.textContent);
  assert.ok(titles.some((t) => t.startsWith('Uttale')));
});

await go('#/ordbok');

check('card: shows a pronunciation hint where the lexicon has one', () => {
  $('dict-search').value = 'kjøpe';
  $('dict-search').dispatch('input');
  reader().querySelectorAll('.dict-row').find((r) => r.querySelector('.dict-head').textContent === 'å kjøpe').click();
  const pron = $('card-body').querySelector('.card-pron');
  assert.ok(pron, 'card-pron missing');
  assert.includes(pron.textContent, 'Uttale');
  $('card-close').click();
  $('dict-search').value = '';
  $('dict-search').dispatch('input');
});

// --- grammar in the text, listening ------------------------------------

await go('#/barnehagen');

check('reader: grammar toggle marks finite verbs and tags inversion', () => {
  pickMode('Les');
  const toggle = reader().querySelector('.grammar-toggle');
  assert.ok(toggle, 'toggle missing');
  toggle.click();
  assert.ok(reader().classList.contains('show-grammar'));
  assert.atLeast(reader().querySelectorAll('.is-finite').length, 5, 'finite verbs should be marked');
  assert.atLeast(reader().querySelectorAll('.gram-tag').length, 1, 'expected at least one V2 or leddsetning tag');
  toggle.click();
  assert.ok(!reader().classList.contains('show-grammar'));
});

check('reader: listening mode explains itself when no voice is available', () => {
  pickMode('Lytt');
  assert.includes(reader().querySelector('.level-desc').textContent, 'ingen norsk stemme');
  pickMode('Les');
});

// --- drill -------------------------------------------------------------

await go('#/tall');

check('drill: shows a prompt and grades an answer', () => {
  assert.equal(doc.body.dataset.view, 'drill');
  reader().querySelectorAll('.chip').find((c) => c.textContent === 'Klokka').click();
  const prompt = reader().querySelector('.drill-prompt').textContent;
  assert.ok(/^\d\d:\d\d$/.test(prompt), `clock prompt expected, got ${prompt}`);
  const input = reader().querySelector('.dictation-input');
  input.value = 'helt feil';
  reader().querySelectorAll('.btn-primary').find((b) => b.textContent === 'Sjekk').click();
  assert.ok(input.classList.contains('is-wrong'));
  assert.equal(reader().querySelector('.dictation-key').hidden, false, 'key shown after a wrong answer');
  const stats = JSON.parse(globalThis.localStorage.getItem('norsk:drill'));
  assert.equal(stats.klokka.answered, 1);
});

check('drill: a right answer counts, with "klokka" prefix tolerated', () => {
  reader().querySelectorAll('.btn-primary').find((b) => b.textContent === 'Neste').click();
  const key = reader().querySelector('.dictation-key').textContent;
  const input = reader().querySelector('.dictation-input');
  input.value = `Klokka ${key}.`;
  reader().querySelectorAll('.btn-primary').find((b) => b.textContent === 'Sjekk').click();
  assert.ok(input.classList.contains('is-right'));
  assert.equal(JSON.parse(globalThis.localStorage.getItem('norsk:drill')).klokka.right, 1);
});

// --- exam --------------------------------------------------------------

await go('#/prove');
await new Promise((r) => setTimeout(r, 30));

check('exam: three parts in sequence, then a finish screen', () => {
  assert.equal(doc.body.dataset.view, 'exam');
  assert.equal(reader().querySelectorAll('.exam-questions').length, 1);
  assert.equal(reader().querySelector('.exam-questions').querySelectorAll('li').length, 6);
  assert.ok(reader().querySelector('.timer-clock'));
  reader().querySelectorAll('.btn-primary').find((b) => b.textContent === 'Neste del').click();
  assert.includes(reader().querySelector('.level-title').textContent, 'Del 2');
  assert.atLeast(reader().querySelectorAll('.word-chip').length, 5, 'key words for the topic');
  reader().querySelectorAll('.btn-primary').find((b) => b.textContent === 'Neste del').click();
});

await new Promise((r) => setTimeout(r, 20));

check('exam: part 3 has a discussion prompt and finishing records the run', () => {
  assert.includes(reader().querySelector('.level-title').textContent, 'Del 3');
  assert.ok(reader().querySelector('.exam-note'));
  reader().querySelectorAll('.btn-primary').find((b) => b.textContent === 'Avslutt').click();
  assert.includes(reader().querySelector('.level-title').textContent, 'Ferdig');
  assert.equal(JSON.parse(globalThis.localStorage.getItem('norsk:drill'))['prøve'].answered, 1);
});

// --- course ------------------------------------------------------------

await go('#/kurs');
await new Promise((r) => setTimeout(r, 30));

check('course: each level carries a progress ring that matches its steps', () => {
  const rings = reader().querySelectorAll('.ring');
  assert.equal(rings.length, 4, 'one ring per level');
  const label = rings[0].getAttribute('aria-label');
  assert.includes(label, 'A1');
  assert.includes(label, 'steg gjort');

  // The ring's arc must agree with the count beside it.
  const counts = reader().querySelectorAll('.level-count').map((p) => p.textContent);
  const m = /^(\d+) av (\d+) steg$/.exec(counts[0]);
  assert.ok(m, `unexpected count text: ${counts[0]}`);
  assert.includes(label, `${m[1]} av ${m[2]}`);

  // The arc is proportional: offset = circumference × (1 − done/total).
  for (let n = 0; n < rings.length; n++) {
    const parts = /^(\d+) av (\d+) steg$|^(Ferdig)$/.exec(counts[n]);
    const [done, total] = parts[3] ? [1, 1] : [Number(parts[1]), Number(parts[2])];
    const fill = rings[n].querySelectorAll('.ring-fill')[0];
    const circumference = Number(fill.getAttribute('stroke-dasharray'));
    const expected = circumference * (1 - done / total);
    const actual = Number(fill.getAttribute('stroke-dashoffset'));
    if (Math.abs(actual - expected) > 0.01) {
      throw new Error(`ring ${n}: offset ${actual}, expected ${expected} for ${counts[n]}`);
    }
  }
});

check('course: lists every level with steps and marks done ones', () => {
  assert.equal(doc.body.dataset.view, 'course');
  const levels = reader().querySelectorAll('.level');
  assert.equal(levels.length, 4);
  const steps = reader().querySelectorAll('.course-step');
  assert.atLeast(steps.length, 40);
  const done = reader().querySelectorAll('.course-step').filter((li) => li.classList.contains('is-done'));
  assert.atLeast(done.length, 2, 'read texts and passed rules should be done');
  assert.equal(reader().querySelectorAll('.course-step').filter((li) => li.classList.contains('is-next')).length, 1, 'exactly one next step');
});

await go('');
await new Promise((r) => setTimeout(r, 30));

check('home: shows the next course step', () => {
  const next = reader().querySelector('.home-next');
  assert.ok(next, 'home-next missing');
  assert.includes(next.textContent, 'Neste i kurset');
});

// --- dragging the card away --------------------------------------------

await go('#/barnehagen');

check('card drag: a long pull dismisses the sheet', () => {
  // The drag only applies to the phone layout, which the shim reports by
  // answering matchMedia.
  globalThis.matchMedia = (q) => ({ matches: /max-width/.test(q) });
  reader().querySelectorAll('.w')[0].click();
  assert.equal($('card').hidden, false, 'card should be open');

  const card = $('card');
  card.scrollTop = 0;
  card.dispatch('pointerdown', { isPrimary: true, pointerId: 1, clientY: 100, timeStamp: 0, target: card });
  card.dispatch('pointermove', { pointerId: 1, clientY: 180, timeStamp: 80, preventDefault() {} });
  assert.includes(card.style.transform ?? '', 'translateY', 'sheet should follow the finger');
  card.dispatch('pointerup', { pointerId: 1, clientY: 260, timeStamp: 160 });
  // The card is still on screen here: it falls away first, then closes.
  assert.equal($('card').hidden, false, 'dismissal animates before it closes');
});

await new Promise((r) => setTimeout(r, 220));

check('card drag: (continued) the card is closed afterwards', () => {
  assert.equal($('card').hidden, true, 'card should have closed');
  assert.equal($('card-scrim').hidden, true);
});

check('card drag: a short pull springs back and keeps the card open', () => {
  reader().querySelectorAll('.w')[0].click();
  const card = $('card');
  card.scrollTop = 0;
  card.dispatch('pointerdown', { isPrimary: true, pointerId: 2, clientY: 100, timeStamp: 0, target: card });
  card.dispatch('pointermove', { pointerId: 2, clientY: 130, timeStamp: 300, preventDefault() {} });
  card.dispatch('pointerup', { pointerId: 2, clientY: 130, timeStamp: 600 });
  assert.equal($('card').hidden, false, 'a 30px drag must not dismiss');
  assert.equal(card.style.transform, '', 'sheet should spring back');
  $('card-close').click();
});

check('card drag: a pull starting on a button does not drag', () => {
  reader().querySelectorAll('.w')[0].click();
  const card = $('card');
  const button = $('card-close');
  card.dispatch('pointerdown', { isPrimary: true, pointerId: 3, clientY: 100, timeStamp: 0, target: button });
  card.dispatch('pointermove', { pointerId: 3, clientY: 250, timeStamp: 80, preventDefault() {} });
  assert.equal(card.style.transform ?? '', '', 'a drag from a control must be ignored');
  $('card-close').click();
  delete globalThis.matchMedia;
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
