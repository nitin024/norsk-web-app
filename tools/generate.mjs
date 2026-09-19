#!/usr/bin/env node
// Draft a new reading text with Claude, then hand it to the validator.
//
//   node tools/generate.mjs --topic arbeid --level A2
//   node tools/generate.mjs --topic helse --level B1 --title "På apoteket"
//   node tools/generate.mjs --topic samfunn --level B2 --count 3   # several at once
//   node tools/generate.mjs --plan presentasjon:A2,arbeid:A1,samfunn:B1   # one per pair
//   node tools/generate.mjs --topic samfunn --level B2 --dry-run   # print the prompt only
//
// No API key? `--dry-run` prints a prompt you can paste into claude.ai. Save
// the JSON it answers with and run `node tools/import-text.mjs paste.json`,
// which does what this script does after the API call.
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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { importTexts } from './import-text.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = 'claude-opus-5';

// --- args --------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1] ?? true;
};
const title = flag('title');
const dryRun = args.includes('--dry-run');
const count = Math.max(1, Math.min(5, Number(flag('count')) || 1));

const index = JSON.parse(readFileSync(join(ROOT, 'data/index.json'), 'utf8'));
const lexicon = JSON.parse(readFileSync(join(ROOT, 'data/lexicon.json'), 'utf8'));

// What to write: either N texts on one topic/level, or a plan of pairs.
// Every job carries its own topic and level so a batch can span the corpus.
const printUsage = () => {
  console.error('usage: node tools/generate.mjs --topic <id> --level <A1|A2|B1|B2> [--count N] [--title "..."] [--dry-run]');
  console.error('       node tools/generate.mjs --plan <topic>:<level>,<topic>:<level>,... [--dry-run]\n');
  console.error('topics:', index.topics.map((t) => t.id).join(', '));
  console.error('levels:', index.levels.map((l) => l.level).join(', '));
  process.exit(2);
};
const resolveJob = (topicId, level) => {
  const topic = index.topics.find((t) => t.id === topicId);
  const levelMeta = index.levels.find((l) => l.level === level);
  if (!topic || !levelMeta) {
    console.error(`unknown pair "${topicId}:${level}"`);
    printUsage();
  }
  return { topic, levelMeta, level };
};
const jobs = flag('plan')
  ? String(flag('plan')).split(',').map((pair) => resolveJob(...pair.trim().split(':')))
  : Array.from({ length: count }, () => resolveJob(flag('topic'), flag('level')));
if (jobs.length === 0 || jobs.length > 8) printUsage();
// The single-job fields keep the rest of the script simple.
const { topic, levelMeta, level } = jobs[0];

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

const existingTitlesFor = (topicId) =>
  index.paragraphs.filter((p) => p.topic === topicId).map((p) => `${p.title} (${p.level})`);

const system = `You write short Norwegian (bokmål) reading texts for adults preparing for Norskprøven muntlig.
The texts are loaded into a reading app whose parser resolves every bare word against a fixed lexicon.

The narrator is always the same person, so the texts form one consistent story:
Shakira, a woman in her thirties from Spain who speaks Spanish and English and is learning Norwegian.
She trained as a nurse in Spain, lives in Drammen with her husband Alex (who works at a hospital)
and their two children (a daughter of seven, a son of three). Her parents still live in Spain.
Do not contradict these facts; you may add everyday details that fit them.

Rules for the text body:
- Plain, natural bokmål. One sentence per array element. No bullet points, no headings.
- Prefer words from the KNOWN LEMMAS list below in any inflected form; the app teaches by re-encountering known words. Introduce at most 6–8 lemmas that are not in the list, and only when the topic needs them.
- Wrap proper nouns and foreign words in angle brackets: <Oslo>, <NAV>, <Alex>. Never wrap ordinary nouns.
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

const jobBlock = (job, i) =>
  `TEXT ${i + 1}
TOPIC: ${job.topic.id} — ${job.topic.label}: ${job.topic.description}
LEVEL: ${job.level} — ${job.levelMeta.description}
LEVEL STYLE: ${LEVEL_GUIDE[job.level]}
Existing texts on this topic, do not repeat their angle: ${existingTitlesFor(job.topic.id).join('; ') || 'none'}`;

const user = `Write ${jobs.length === 1 ? 'one new text' : `${jobs.length} new texts`}${
  !flag('plan') && jobs.length > 1 ? ', each with a different angle on the topic' : ''
}.
${title ? `TITLE (use this): ${title}\n` : ''}
${jobs.map(jobBlock).join('\n\n')}

Every text object must carry its "topic" and "level" exactly as given above.

KNOWN PHRASES (${phrases.length}): ${phrases.join(', ')}

KNOWN LEMMAS (${lemmas.length}): ${lemmas.join(', ')}`;

const textSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    gloss: { type: 'string' },
    examNote: { type: 'string' },
    topic: { type: 'string', enum: index.topics.map((t) => t.id) },
    level: { type: 'string', enum: index.levels.map((l) => l.level) },
    body: { type: 'array', items: { type: 'string' }, minItems: 5, maxItems: 14 },
  },
  required: ['id', 'title', 'gloss', 'examNote', 'topic', 'level', 'body'],
  additionalProperties: false,
};
const schema = {
  type: 'object',
  properties: { texts: { type: 'array', items: textSchema, minItems: jobs.length, maxItems: jobs.length } },
  required: ['texts'],
  additionalProperties: false,
};

if (dryRun) {
  // One block, ready to paste into a chat. The JSON shape is spelled out
  // because a chat has no output_config to enforce it.
  const shape =
    '{ "texts": [ { "id": "...", "title": "...", "gloss": "...", "examNote": "...", "topic": "...", "level": "...", "body": ["...", "..."] }, ... ] }';
  console.log(
    system +
      '\n\n' +
      user +
      '\n\nAnswer with JSON only, no prose and no code fence, exactly this shape:\n' +
      shape +
      '\n'
  );
  console.error(`\n(prompt for ${jobs.length} text(s): ${jobs.map((j) => `${j.topic.id}:${j.level}`).join(', ')}; save the answer as paste.json and run: node tools/import-text.mjs paste.json)`);
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
let parsed;
try {
  parsed = JSON.parse(text);
} catch {
  console.error('Model did not return valid JSON:\n' + text);
  process.exit(1);
}

const { usage } = message;
console.log(`(${usage.input_tokens} in / ${usage.output_tokens} out tokens)`);
const status = importTexts(parsed, { level, topic: topic.id });
process.exit(status);
