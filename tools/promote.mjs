#!/usr/bin/env node
// Promote validated drafts into the app.
//
//   node tools/promote.mjs                 # every data/paragraphs/*.draft.json
//   node tools/promote.mjs regn-og-skog    # just that one
//
// A draft is promoted only if `node validate.js --draft` says it is ready:
// every word resolves and nothing is ambiguous. It is renamed to .json, its
// stubs file (if any) is removed, and a line is appended to data/index.json
// in the same one-line style as the existing entries. Drafts that are not
// ready are listed and left alone.

import { readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data/paragraphs');
const INDEX = join(ROOT, 'data/index.json');

const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const drafts = readdirSync(DIR)
  .filter((f) => f.endsWith('.draft.json'))
  .map((f) => f.replace(/\.draft\.json$/, ''))
  .filter((id) => only.length === 0 || only.includes(id));

if (drafts.length === 0) {
  console.log('No drafts to promote.');
  process.exit(0);
}

let raw = readFileSync(INDEX, 'utf8');
const index = JSON.parse(raw);
const known = new Set(index.paragraphs.map((p) => p.id));
const promoted = [];
const held = [];

for (const id of drafts) {
  const draftPath = join(DIR, `${id}.draft.json`);
  const check = spawnSync('node', ['validate.js', '--draft', draftPath], { cwd: ROOT, encoding: 'utf8' });
  if (!/Ready — every word resolves/.test(check.stdout)) {
    held.push([id, check.stdout.split('\n').filter((l) => /Missing|Ambiguous|Other issues/.test(l)).join('; ') || 'not ready']);
    continue;
  }
  const doc = JSON.parse(readFileSync(draftPath, 'utf8'));
  if (known.has(doc.id) || existsSync(join(DIR, `${id}.json`))) {
    held.push([id, 'already in the app']);
    continue;
  }
  renameSync(draftPath, join(DIR, `${id}.json`));
  const stubs = join(DIR, `${id}.stubs.json`);
  if (existsSync(stubs)) unlinkSync(stubs);

  const line = `    { "id": ${JSON.stringify(doc.id)}, "title": ${JSON.stringify(doc.title)}, "level": ${JSON.stringify(doc.level)}, "file": ${JSON.stringify(`${id}.json`)}, "topic": ${JSON.stringify(doc.topic)} }`;
  // Append after the last paragraph entry, keeping the file's formatting.
  const end = raw.lastIndexOf('\n  ]');
  const before = raw.slice(0, end).replace(/\s*$/, '');
  raw = `${before},\n${line}${raw.slice(end)}`;
  JSON.parse(raw);
  promoted.push(`${doc.title} (${doc.level}, ${doc.topic})`);
}

if (promoted.length) writeFileSync(INDEX, raw);
for (const p of promoted) console.log(`  promoted  ${p}`);
for (const [id, why] of held) console.log(`  held      ${id}: ${why}`);
console.log(`\n${promoted.length} promoted, ${held.length} held.`);
if (promoted.length) console.log('Now run: npm test');
process.exit(held.length ? 1 : 0);
