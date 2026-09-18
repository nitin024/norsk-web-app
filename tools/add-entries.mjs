#!/usr/bin/env node
// Merge lexicon entries from a JSON file into data/lexicon.json.
//
//   node tools/add-entries.mjs new-entries.json
//
// Input is { "<lemma>": { entry }, ... } — the same shape as `entries` in the
// lexicon. Entries whose lemma or id already exist are skipped and listed, so
// re-running with the same file is harmless. The file is edited textually so
// the existing formatting and key order are untouched.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEXICON = join(ROOT, 'data/lexicon.json');

const src = process.argv[2];
if (!src) {
  console.error('usage: node tools/add-entries.mjs <entries.json>');
  process.exit(2);
}

export function mergeEntries(raw, incoming) {
  const lexicon = JSON.parse(raw);
  const ids = new Map(Object.entries(lexicon.entries).map(([lemma, e]) => [e.id, lemma]));
  const added = [];
  const skipped = [];

  for (const [lemma, entry] of Object.entries(incoming)) {
    if (lexicon.entries[lemma]) skipped.push(`${lemma} (lemma exists)`);
    else if (entry.id && ids.has(entry.id)) skipped.push(`${lemma} (id "${entry.id}" used by "${ids.get(entry.id)}")`);
    else {
      added.push([lemma, entry]);
      if (entry.id) ids.set(entry.id, lemma);
    }
  }
  if (added.length === 0) return { raw, added, skipped };

  // The entries object closes at the first "\n  }" after its last entry;
  // everything after that (trailing comment fields) is kept as is.
  const close = raw.indexOf('\n  }', raw.lastIndexOf('"forms"'));
  if (close === -1) throw new Error('could not find the end of "entries"');

  const chunks = added.map(([lemma, entry]) => {
    const body = JSON.stringify(entry, null, 2)
      .split('\n')
      .map((line, i) => (i === 0 ? line : '    ' + line))
      .join('\n');
    return `    ${JSON.stringify(lemma)}: ${body}`;
  });
  const out = raw.slice(0, close) + ',\n' + chunks.join(',\n') + raw.slice(close);
  JSON.parse(out); // never write something the app cannot read
  return { raw: out, added, skipped };
}

const incoming = JSON.parse(readFileSync(src, 'utf8'));
const { raw, added, skipped } = mergeEntries(readFileSync(LEXICON, 'utf8'), incoming.entries ?? incoming);
if (added.length) writeFileSync(LEXICON, raw);
console.log(`${added.length} added, ${skipped.length} skipped`);
for (const s of skipped) console.log(`  skip  ${s}`);
