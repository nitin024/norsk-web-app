#!/usr/bin/env node
// Content validator. No dependencies. Run before committing:
//
//     node validate.js
//
// Exits 1 if any error is found, 0 otherwise, so it can drop into CI.
// Warnings never fail the run.
//
// There is no build step, so nothing else stands between a bad annotation and
// the page. This is that step.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseParagraph, buildFormIndex } from './parser.js';

// --- draft mode --------------------------------------------------------
// `node validate.js --draft data/paragraphs/ny.json` reports what a
// work-in-progress paragraph still needs: missing lexicon entries (with
// paste-ready stubs) and bare words that are ambiguous.

const STUBS = {
  noun: (l) =>
    `"${l}": { "pos": "noun", "gender": "en", "gloss": "", "forms": { "indefinite_sg": "${l}", "definite_sg": "${l}en", "indefinite_pl": "${l}er", "definite_pl": "${l}ene" } }`,
  determiner: (l) => `"${l}": { "pos": "determiner", "gloss": "" }`,
  pronoun: (l) => `"${l}": { "pos": "pronoun", "gloss": "" }`,
  verb: (l) =>
    `"${l}": { "pos": "verb", "gloss": "", "forms": { "infinitive": "${l}", "present": "${l}r", "preterite": "${l}te", "perfect": "${l}t" } }`,
  adjective: (l) =>
    `"${l}": { "pos": "adjective", "gloss": "", "forms": { "positive": "${l}", "neuter": "${l}t", "plural": "${l}e" } }`,
  phrase: (l) => `"${l}": { "pos": "phrase", "phrase": true, "gloss": "" }`,
  other: (l) => `"${l}": { "pos": "adverb", "gloss": "" }`,
};

function runDraft(target) {
  const lex = JSON.parse(readFileSync(LEXICON_PATH, 'utf8'));
  const doc = JSON.parse(readFileSync(target, 'utf8'));
  const { diagnostics } = parseParagraph(doc, lex);
  const index = buildFormIndex(lex);

  // Guess a part of speech from Norwegian morphology so the stub is closer to
  // right than a bare adverb. Wrong guesses are cheap — you edit the stub.
  const guessPos = (word) => {
    if (word.includes(' ')) return 'phrase';
    if (/(ere|ere|ne|re)$/.test(word) && /(er|re)$/.test(word)) return 'verb';
    if (/(else|ing|het|sjon|dom|skap)$/.test(word)) return 'noun';
    if (/(lig|som|full|løs|bar|isk)$/.test(word)) return 'adjective';
    if (/(er|ere|te|de)$/.test(word)) return 'verb';
    return 'noun';
  };

  const missing = new Map();
  for (const d of diagnostics) {
    if (d.kind === 'unresolved') {
      const w = d.surface.toLowerCase();
      missing.set(w, guessPos(w));
    } else if (d.kind === 'missing-lemma' || d.kind === 'unknown-phrase') {
      const w = d.lemma ?? d.surface;
      missing.set(w, d.kind === 'unknown-phrase' ? 'phrase' : guessPos(w));
    }
  }

  // Bare words in the source that resolve, but ambiguously.
  const ambiguous = new Map();
  for (const line of doc.body) {
    const bare = line.replace(/\{[^{}]*\}/g, ' ').replace(/<[^<>]*>/g, ' ');
    for (const m of bare.matchAll(/[\p{L}][\p{L}\d'’-]*/gu)) {
      const hits = index.get(m[0].toLowerCase());
      if (hits && hits.length > 1) {
        ambiguous.set(m[0].toLowerCase(), [...new Set(hits.map((h) => h.lemma))]);
      }
    }
  }

  console.log(`\n${target}\n`);

  if (missing.size > 0) {
    console.log(`Missing from the lexicon (${missing.size}) — paste into data/lexicon.json:\n`);
    for (const [word, kind] of missing) {
      console.log('    ' + (STUBS[kind] ?? STUBS.other)(word) + ',');
    }
    console.log('\n  Adjust pos, gender, gloss and the irregular forms by hand.');
  }

  if (ambiguous.size > 0) {
    console.log(`\nAmbiguous bare words (${ambiguous.size}) — pin each as {word:lemma}:\n`);
    for (const [word, lemmas] of ambiguous) {
      console.log(`    ${word.padEnd(16)} ${lemmas.join('  or  ')}`);
    }
  }

  const other = diagnostics.filter(
    (d) => !['unresolved', 'missing-lemma', 'unknown-phrase', 'ambiguous'].includes(d.kind)
  );
  if (other.length > 0) {
    console.log(`\nOther issues (${other.length}):\n`);
    for (const d of other) console.log(`    ${d.kind}: ${d.message}`);
  }

  if (missing.size === 0 && ambiguous.size === 0 && other.length === 0) {
    console.log('Ready — every word resolves and nothing is ambiguous.');
  }
  console.log();
  process.exit(missing.size > 0 || other.length > 0 ? 1 : 0);
}

const LEXICON_PATH = 'data/lexicon.json';
const PARAGRAPH_DIR = 'data/paragraphs';
const INDEX_PATH = 'data/index.json';

// Draft mode runs instead of the full corpus check, and must be dispatched
// after the paths above are initialised.
const draftFlag = process.argv.indexOf('--draft');
if (draftFlag !== -1) {
  const target = process.argv[draftFlag + 1];
  if (!target) {
    console.error('usage: node validate.js --draft <path-to-paragraph.json>');
    process.exit(2);
  }
  runDraft(target);
}

// Which form keys each POS may declare, and which it must.
// `required` is a subset of `allowed`. A POS absent from this table must not
// carry a `forms` block at all.
// `formsOptional` marks a POS where a bare gloss entry is legitimate — most
// determiners (hver, en, et) do not inflect; only possessives like `min` do.
// `pluralOnly: true` on an entry exempts it from singular requirements
// (klær, folk).
const SCHEMA = {
  noun: {
    allowed: ['indefinite_sg', 'definite_sg', 'definite_sg_fem', 'indefinite_pl', 'definite_pl'],
    required: ['definite_sg', 'definite_pl'],
    requiredIfPluralOnly: ['indefinite_pl', 'definite_pl'],
    requires: ['gender'],
  },
  verb: {
    allowed: ['infinitive', 'present', 'preterite', 'perfect'],
    required: ['infinitive', 'present', 'preterite', 'perfect'],
  },
  adjective: {
    allowed: [
      'positive',
      'neuter',
      'plural',
      'comparative',
      'superlative',
      'superlative_definite',
    ],
    required: ['positive', 'neuter', 'plural'],
  },
  determiner: {
    allowed: ['masculine', 'feminine', 'neuter', 'plural'],
    required: [],
    formsOptional: true,
  },
  phrase: {
    allowed: ['infinitive', 'present', 'preterite', 'perfect'],
    required: [],
    formsOptional: true,
  },
};

const GLOSS_ONLY = ['pronoun', 'preposition', 'conjunction', 'adverb', 'numeral', 'particle'];

const errors = [];
const warnings = [];
const err = (check, message) => errors.push({ check, message });
const warn = (check, message) => warnings.push({ check, message });

// --- load -------------------------------------------------------------

const lexicon = JSON.parse(readFileSync(LEXICON_PATH, 'utf8'));
const paragraphFiles = readdirSync(PARAGRAPH_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => join(PARAGRAPH_DIR, f));

const paragraphs = paragraphFiles.map((path) => ({
  path,
  doc: JSON.parse(readFileSync(path, 'utf8')),
}));

// --- 0. index / disk agreement ----------------------------------------
// The app reads index.json, not the directory. A file on disk that the index
// omits is invisible; an index entry with no file is a dead link.

const index = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
const onDisk = new Set(paragraphFiles.map((p) => p.split('/').pop()));
const declaredLevels = new Set(index.levels.map((l) => l.level));
const seenIds = new Set();

for (const item of index.paragraphs) {
  if (!onDisk.has(item.file)) {
    err('index', `index.json lists "${item.file}" but ${PARAGRAPH_DIR}/${item.file} does not exist`);
  }
  if (seenIds.has(item.id)) err('index', `duplicate id "${item.id}" in index.json`);
  seenIds.add(item.id);
  if (!declaredLevels.has(item.level)) {
    err('index', `"${item.id}" has level "${item.level}", which index.json does not declare`);
  }
}

const indexed = new Set(index.paragraphs.map((p) => p.file));
for (const file of onDisk) {
  if (!indexed.has(file)) {
    err('index', `${PARAGRAPH_DIR}/${file} exists but index.json does not list it — it will not appear in the app`);
  }
}

for (const { path, doc } of paragraphs) {
  const entry = index.paragraphs.find((p) => p.file === path.split('/').pop());
  if (entry && entry.id !== doc.id) {
    err('index', `${path}: doc id "${doc.id}" does not match index id "${entry.id}"`);
  }
  if (entry && entry.level !== doc.level) {
    err('index', `${path}: doc level "${doc.level}" does not match index level "${entry.level}"`);
  }
}

// --- 1. lexicon shape -------------------------------------------------

// Ids are the stable key SRS state will hang off, so they must exist and be
// unique. A duplicate silently merges two words' review history.
const seenEntryIds = new Map();
for (const [lemma, entry] of Object.entries(lexicon.entries)) {
  if (!entry.id) {
    err('lexicon-id', `"${lemma}" has no id`);
  } else if (seenEntryIds.has(entry.id)) {
    err(
      'lexicon-id',
      `id "${entry.id}" is used by both "${seenEntryIds.get(entry.id)}" and "${lemma}"`
    );
  } else {
    seenEntryIds.set(entry.id, lemma);
  }
}

// A key like "tre (substantiv)" exists only to keep two senses of one lemma
// apart. The suffix must never be displayed, so such an entry must carry an
// explicit `headword` — otherwise the card renders the disambiguator.
for (const [lemma, entry] of Object.entries(lexicon.entries)) {
  if (/\([^)]+\)\s*$/.test(lemma) && !entry.headword) {
    err(
      'display-name',
      `"${lemma}" is a disambiguated key but has no "headword" — the card would show the suffix`
    );
  }
}

for (const [lemma, entry] of Object.entries(lexicon.entries)) {
  if (!entry.pos) {
    err('lexicon-shape', `"${lemma}" has no pos`);
    continue;
  }
  if (!entry.gloss) err('lexicon-shape', `"${lemma}" has no gloss`);

  const schema = SCHEMA[entry.pos];

  if (!schema) {
    if (!GLOSS_ONLY.includes(entry.pos)) {
      err('lexicon-shape', `"${lemma}" has unknown pos "${entry.pos}"`);
    } else if (entry.forms) {
      err('lexicon-shape', `"${lemma}" is ${entry.pos} (gloss-only) but declares a forms block`);
    }
    continue;
  }

  for (const field of schema.requires ?? []) {
    if (!entry[field]) err('lexicon-shape', `"${lemma}" (${entry.pos}) is missing required field "${field}"`);
  }

  if (!entry.forms) {
    if (!schema.formsOptional) {
      err('lexicon-shape', `"${lemma}" (${entry.pos}) has no forms block`);
    }
    continue;
  }

  for (const formName of Object.keys(entry.forms)) {
    if (!schema.allowed.includes(formName)) {
      err(
        'unknown-form-name',
        `"${lemma}" (${entry.pos}) declares "${formName}" — not valid for this pos. Allowed: ${schema.allowed.join(', ')}`
      );
    }
  }
  const required = entry.pluralOnly
    ? schema.requiredIfPluralOnly ?? schema.required
    : schema.required;
  for (const formName of required) {
    if (!entry.forms[formName]) {
      err('missing-form', `"${lemma}" (${entry.pos}) is missing required form "${formName}"`);
    }
  }
  for (const [formName, surface] of Object.entries(entry.forms)) {
    if (typeof surface !== 'string' || surface.trim() === '') {
      err('lexicon-shape', `"${lemma}" form "${formName}" is empty`);
    }
  }
}

// --- 2. ambiguity ------------------------------------------------------
// A surface form that maps to several lemmas is only safe if every occurrence
// in the corpus is explicitly annotated. Collect the collisions first, then
// check what the paragraphs actually rely on.

const formIndex = buildFormIndex(lexicon);
const collisions = new Map();
for (const [surface, matches] of formIndex) {
  const lemmas = [...new Set(matches.map((m) => m.lemma))];
  if (lemmas.length > 1) collisions.set(surface, lemmas);
}

// --- 3. per-paragraph parse -------------------------------------------

const usedLemmas = new Set();

for (const { path, doc } of paragraphs) {
  if (!doc.id) err('paragraph-shape', `${path}: no id`);
  if (!Array.isArray(doc.body)) {
    err('paragraph-shape', `${path}: body is not an array`);
    continue;
  }

  const { sentences, diagnostics } = parseParagraph(doc, lexicon);

  for (const d of diagnostics) {
    const where = `${path} [${doc.id}]`;
    if (d.kind === 'missing-lemma') err('orphan-annotation', `${where}: ${d.message}`);
    else if (d.kind === 'unbalanced-bracket') err('unbalanced-bracket', `${where}: ${d.message}`);
    else if (d.kind === 'unresolved') err('unresolved', `${where}: ${d.message}`);
    else if (d.kind === 'form-not-in-table') err('form-not-in-table', `${where}: ${d.message}`);
    else if (d.kind === 'ambiguous') {
      // Parser already resolved it by first-match. That is the dangerous case:
      // silent and dependent on JSON key order.
      err(
        'ambiguous',
        `${where}: ${d.message} Annotate it as {${d.surface}:<lemma>} to pin it.`
      );
    }
  }

  for (const node of sentences.flat()) {
    if (node.kind === 'word' && node.lemma) usedLemmas.add(node.lemma);
  }
}

// A colliding surface form is only safe where it is explicitly annotated.
// Strip every {...} annotation from the line first, then look for the form
// standing bare — an annotated occurrence must not count as a safe hit.
const stripAnnotations = (line) => line.replace(/\{[^{}]*\}/g, ' ');
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

for (const [surface, lemmas] of collisions) {
  const bare = new RegExp(`(^|\\P{L})${escape(surface)}(\\P{L}|$)`, 'iu');
  const exposed = paragraphs.filter(({ doc }) =>
    doc.body.some((line) => bare.test(stripAnnotations(line)))
  );

  if (exposed.length > 0) {
    // The parser resolved these by first-match, which depends on JSON key
    // order. That is silent and order-dependent, so it is an error.
    err(
      'ambiguous',
      `"${surface}" maps to ${lemmas.join(', ')} and appears unannotated in ` +
        `${exposed.map((p) => p.path).join(', ')} — pin it as {${surface}:<lemma>}`
    );
  } else {
    warn(
      'latent-ambiguity',
      `"${surface}" maps to ${lemmas.join(', ')} — every current use is annotated; annotate future ones too`
    );
  }
}

// --- 4. unused entries -------------------------------------------------

for (const lemma of Object.keys(lexicon.entries)) {
  if (!usedLemmas.has(lemma)) {
    warn('unused-entry', `"${lemma}" is in the lexicon but no paragraph uses it`);
  }
}

// --- report ------------------------------------------------------------

const group = (items) =>
  items.reduce((acc, i) => ((acc[i.check] ??= []).push(i.message), acc), {});

const printGroup = (label, items) => {
  if (items.length === 0) return;
  console.log(`\n${label} (${items.length})`);
  for (const [check, messages] of Object.entries(group(items))) {
    console.log(`\n  ${check}`);
    for (const m of messages) console.log(`    ${m}`);
  }
};

printGroup('WARNINGS', warnings);
printGroup('ERRORS', errors);

const lemmaCount = Object.keys(lexicon.entries).length;
console.log(
  `\n${lemmaCount} lemmas, ${paragraphs.length} paragraph(s), ` +
    `${usedLemmas.size} used — ${errors.length} error(s), ${warnings.length} warning(s)`
);

process.exit(errors.length > 0 ? 1 : 0);
