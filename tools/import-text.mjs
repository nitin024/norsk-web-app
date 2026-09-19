#!/usr/bin/env node
// Turn pasted JSON from a chat into draft paragraph files and validate them.
//
//   node tools/import-text.mjs paste.json
//   node tools/import-text.mjs paste.json --level A2 --topic helse
//
// Accepts one text ({ id, title, gloss, examNote, body }) or several
// ({ texts: [...] } or a bare array). A code fence around the JSON is
// tolerated. `level` and `topic` come from the JSON when present, else from
// the flags; the validator then says what the lexicon still needs.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Write each text as a .draft.json and run the validator on it. Returns an exit status. */
export function importTexts(parsed, defaults = {}) {
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.texts) ? parsed.texts : [parsed];
  const index = JSON.parse(readFileSync(join(ROOT, 'data/index.json'), 'utf8'));
  const topics = new Set(index.topics.map((t) => t.id));
  const levels = new Set(index.levels.map((l) => l.level));
  let status = 0;

  // A chat often echoes the whole prompt line back — "fritid — Fritid og
  // natur: ..." instead of "fritid" — so take the leading token and accept
  // it if it names something real.
  const firstToken = (v) => String(v ?? '').split(/[\s—:]/)[0].trim();
  const coerce = (value, allowed, fallback) => {
    if (allowed.has(value)) return value;
    const head = firstToken(value);
    if (allowed.has(head)) return head;
    return fallback;
  };

  for (const draft of list) {
    const level = coerce(draft.level, levels, defaults.level);
    const topic = coerce(draft.topic, topics, defaults.topic);
    if (!draft.title || !Array.isArray(draft.body) || draft.body.length === 0) {
      console.error(`Skipping an entry without title/body: ${JSON.stringify(draft).slice(0, 80)}`);
      status = 1;
      continue;
    }
    if (!levels.has(level) || !topics.has(topic)) {
      console.error(`"${draft.title}": level "${level}" or topic "${topic}" is not declared in data/index.json (pass --level/--topic)`);
      status = 1;
      continue;
    }

    const slug = slugify(draft.id || draft.title);
    if (existsSync(join(ROOT, 'data/paragraphs', `${slug}.json`))) {
      console.error(`"${draft.title}": data/paragraphs/${slug}.json already exists — skipped`);
      status = 1;
      continue;
    }
    const doc = {
      id: slug,
      title: draft.title,
      level,
      topic,
      gloss: draft.gloss ?? '',
      examNote: draft.examNote ?? '',
      body: draft.body,
    };
    const out = join(ROOT, 'data/paragraphs', `${slug}.draft.json`);
    writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
    console.log(`\nWrote data/paragraphs/${slug}.draft.json (${level}, ${topic})\n`);
    console.log(doc.body.join('\n'));

    const result = spawnSync('node', ['validate.js', '--draft', out], { cwd: ROOT, stdio: 'inherit' });
    if (result.status) status = result.status;
  }

  console.log(
    '\nNext: node tools/add-entries.mjs <stubs.json> for the missing words, pin ambiguities,\n' +
      'then rename each .draft.json to .json and add it to data/index.json.'
  );
  return status;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : args[i + 1];
  };
  if (!file) {
    console.error('usage: node tools/import-text.mjs <paste.json> [--level A2] [--topic helse]');
    process.exit(2);
  }
  let raw = readFileSync(file, 'utf8').trim();
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`${file} is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  process.exit(importTexts(parsed, { level: flag('level'), topic: flag('topic') }));
}
