#!/usr/bin/env node
// Draft a new reading text with Claude, then hand it to the validator.
//
//   node tools/generate.mjs --topic arbeid --level A2
//   node tools/generate.mjs --topic helse --level B1 --title "På apoteket"
//   node tools/generate.mjs --topic samfunn --level B2 --dry-run   # print the prompt only
//
// The model gets the topic, the level, the lexicon's lemma list and the
// annotation rules, and is asked to lean on words the app already knows. The
// result lands in data/paragraphs/<id>.draft.json (gitignored) and
// `node validate.js --draft` runs on it immediately, so the next step is the
// same as for a hand-written text: fill in stubs, pin ambiguities, rename to
// .json, add to index.json.
//
// Nothing here runs in the app. The site stays static and dependency-free;
// this is an authoring tool, and the SDK is a devDependency.
//
// Credentials: ANTHROPIC_API_KEY, or an `ant auth login` profile.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = 'claude-opus-5';

// --- args --------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1] ?? true;
};
const topicId = flag('topic');
const level = flag('level');
const title = flag('title');
const dryRun = args.includes('--dry-run');

const index = JSON.parse(readFileSync(join(ROOT, 'data/index.json'), 'utf8'));
const lexicon = JSON.parse(readFileSync(join(ROOT, 'data/lexicon.json'), 'utf8'));

const topic = index.topics.find((t) => t.id === topicId);
const levelMeta = index.levels.find((l) => l.level === level);
if (!topic || !levelMeta) {
  console.error('usage: node tools/generate.mjs --topic <id> --level <A1|A2|B1|B2> [--title "..."] [--dry-run]\n');
  console.error('topics:', index.topics.map((t) => t.id).join(', '));
  console.error('levels:', index.levels.map((l) => l.level).join(', '));
  process.exit(2);
}

// --- prompt ------------------------------------------------------------

const LEVEL_GUIDE = {
  A1: 'Very short main clauses, present tense, 6–8 sentences, 8–12 words each. First person. Concrete everyday facts.',
  A2: 'Simple past and present, some subordinate clauses with fordi/når/som, 7–9 sentences. A short personal account.',
  B1: 'Give an opinion and justify it. Weigh a fordel against an ulempe and conclude. 8–10 sentences, modal verbs, linking words (derfor, likevel, for det første).',
  B2: 'Discuss a societal question with nuance: concede a counter-argument before concluding. 9–11 sentences, passive voice, abstract nouns, varied sentence openings.',
};

const lemmas = Object.entries(lexicon.entries)
  .filter(([, e]) => !e.phrase)
  .map(([l, e]) => (e.headword ?? l))
  .sort((a, b) => a.localeCompare(b, 'nb'));
const phrases = Object.entries(lexicon.entries)
  .filter(([, e]) => e.phrase)
  .map(([l]) => l);

const existingTitles = index.paragraphs
  .filter((p) => p.topic === topic.id)
  .map((p) => `${p.title} (${p.level})`);

const system = `You write short Norwegian (bokmål) reading texts for adults preparing for Norskprøven muntlig.
The texts are loaded into a reading app whose parser resolves every bare word against a fixed lexicon.

Rules for the text body:
- Plain, natural bokmål. One sentence per array element. No bullet points, no headings.
- Prefer words from the KNOWN LEMMAS list below in any inflected form; the app teaches by re-encountering known words. Introduce at most 6–8 lemmas that are not in the list, and only when the topic needs them.
- Wrap proper nouns and foreign words in angle brackets: <Oslo>, <NAV>, <Carlos>. Never wrap ordinary nouns.
- Wrap a fixed multi-word expression from the KNOWN PHRASES list in square brackets when you use it: [bli kjent med], [i hvert fall]. Do not invent new phrases.
- No other markup. Do not pin ambiguous words; the validator handles that.
- No numerals as digits; write numbers as words (to, fem, tjue).

Also produce:
- title: short Norwegian title, in the style of the existing ones.
- gloss: English translation of the title.
- examNote: two sentences in Norwegian telling the candidate why this text matters for the oral exam and which structures to practise (see the examples).
- id: a URL-safe slug from the title, ascii only, hyphenated.

Examples of existing examNotes:
- "Del 2: en kort presentasjon om arbeid. Bruk gjerne «jeg trives med» og «det som er fint, er at ...»."
- "Klassisk B1-oppgave: vei fordeler mot ulemper og konkluder. Øv på «på den ene siden … på den andre siden»."
- "B2 krever nyansering: innrøm et motargument før du konkluderer. Øv på «selv om», «riktignok» og «likevel»."`;

const user = `Write one new text.

TOPIC: ${topic.label} — ${topic.description}
LEVEL: ${level} — ${levelMeta.description}
LEVEL STYLE: ${LEVEL_GUIDE[level]}
${title ? `TITLE (use this): ${title}\n` : ''}
Existing texts on this topic, do not repeat their angle: ${existingTitles.join('; ') || 'none'}

KNOWN PHRASES (${phrases.length}): ${phrases.join(', ')}

KNOWN LEMMAS (${lemmas.length}): ${lemmas.join(', ')}`;

const schema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    gloss: { type: 'string' },
    examNote: { type: 'string' },
    body: { type: 'array', items: { type: 'string' }, minItems: 5, maxItems: 14 },
  },
  required: ['id', 'title', 'gloss', 'examNote', 'body'],
  additionalProperties: false,
};

if (dryRun) {
  console.log('--- system ---\n' + system + '\n\n--- user ---\n' + user + '\n');
  console.log(`(${system.length + user.length} characters; model ${MODEL})`);
  process.exit(0);
}

// --- call --------------------------------------------------------------

const client = new Anthropic();

let message;
try {
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content: user }],
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'high',
      format: { type: 'json_schema', schema },
    },
  });
  message = await stream.finalMessage();
} catch (err) {
  if (err instanceof Anthropic.AuthenticationError) {
    console.error('No valid credentials. Set ANTHROPIC_API_KEY or run `ant auth login`.');
  } else if (err instanceof Anthropic.RateLimitError) {
    console.error('Rate limited — try again in a minute.');
  } else if (err instanceof Anthropic.APIError) {
    console.error(`API error ${err.status}: ${err.message}`);
  } else if (err instanceof Anthropic.AnthropicError && /authentication method/i.test(err.message)) {
    // Thrown before any request goes out when no credential source exists.
    console.error('No credentials found. Set ANTHROPIC_API_KEY or run `ant auth login`.');
  } else {
    console.error(err);
  }
  process.exit(1);
}

if (message.stop_reason === 'refusal') {
  console.error('The model declined this request:', message.stop_details?.explanation ?? '');
  process.exit(1);
}
if (message.stop_reason === 'max_tokens') {
  console.error('Output was cut off at max_tokens; try again.');
  process.exit(1);
}

const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
let draft;
try {
  draft = JSON.parse(text);
} catch {
  console.error('Model did not return valid JSON:\n' + text);
  process.exit(1);
}

// --- write + validate -------------------------------------------------

const slug = String(draft.id || draft.title)
  .toLowerCase()
  .replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const doc = {
  id: slug,
  title: draft.title,
  level,
  topic: topic.id,
  gloss: draft.gloss,
  examNote: draft.examNote,
  body: draft.body,
};

const out = join(ROOT, 'data/paragraphs', `${slug}.draft.json`);
if (existsSync(join(ROOT, 'data/paragraphs', `${slug}.json`))) {
  console.error(`data/paragraphs/${slug}.json already exists; pick another --title.`);
  process.exit(1);
}
writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');

const { usage } = message;
console.log(`\nWrote data/paragraphs/${slug}.draft.json`);
console.log(`(${usage.input_tokens} in / ${usage.output_tokens} out tokens)\n`);
console.log(doc.body.join('\n') + '\n');

// The validator says what the lexicon still needs.
const result = spawnSync('node', ['validate.js', '--draft', out], { cwd: ROOT, stdio: 'inherit' });
console.log(
  '\nNext: paste the stubs into data/lexicon.json, pin ambiguities, re-run the validator,\n' +
    `then rename to ${slug}.json and add it to data/index.json.`
);
process.exit(result.status ?? 0);
