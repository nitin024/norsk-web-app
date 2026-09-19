# norsk-web-app

A static Norwegian (bokmål) reading app. Tap any word to see its dictionary
form, inflection table, and English gloss.

No build step, no backend, no dependencies. Vanilla ES modules and plain JSON.

## Running locally

ES modules and `fetch` need a real origin — opening `index.html` from the
filesystem will not work.

    ./serve.sh            # start and open a browser tab
    ./serve.sh stop       # stop the server this script started
    ./serve.sh kill       # free the port, whoever is holding it
    ./serve.sh restart
    ./serve.sh status

Defaults to port 8000; override with `PORT=8081 ./serve.sh`. The PID is kept in
`.serve.pid` so `stop` is reliable, and the script waits for the server to
accept connections before opening the tab.

`stop` only touches the server this script started. If the port is held by
something else — a `python3 -m http.server` you launched by hand, say — use
`kill`, which names the process before terminating it. `restart` does whichever
applies.

To read it on your phone over the same wifi:

    PORT=8080 python3 -m http.server 8080 --bind 0.0.0.0
    # then visit http://<your-mac-ip>:8080

## Tests and validation

    npm test              # validator + all three test suites
    node validate.js      # content checks only; exits 1 on any error
    node validate.js --unused   # also list every lexicon entry no text uses

The same command runs in GitHub Actions on every push and pull request.

## What the app does

- **Lesetekster** — 19 texts, grouped by level or by topic. Each text opens with
  the examiner's note and a link to its topic page.
- **Tema** — one theme across levels: its texts, the vocabulary they share, and
  every speaking prompt.
- **Les / Fyll inn / Snakk** — read with tap-to-look-up, fill in the blanked
  inflections with the base form as hint, or hide the text and talk for two
  minutes with the key words and a timer.
- **Les høyt** — sentence and word playback through the browser's Norwegian
  voice, where one is installed. Hold a word to hear it without opening its
  card, for reading along.
- **Øving** — every word you looked up while reading becomes a flip card on a
  spaced schedule: "Kunne det" moves it up a box and pushes the next review out
  by 1, 3, 7, 14 then 30 days; "Øv mer" drops it back to today. Box 4 and up
  count as learnt, but nothing is retired for good, and looking a word up again
  in a text resets it. When nothing is due the page says when the next word is.
- **Grammatikk** — a rule book in `data/grammar.json`: word order (verb second,
  questions, «ikke» in main and subordinate clauses, «å»), which tense when,
  nouns and adjectives (gender, the definite suffix, plurals, agreement,
  possessives), and connecting words grouped by the word order they trigger.
  Every rule carries a "For English speakers" note on what the English
  instinct gets wrong, every example is tappable, and rules have scrambled
  sentences to put back in order.
- **Snakk** — a two-minute timer with key words, plus record-and-compare:
  record yourself, play it back, then hear the same text in the app's voice.
  Nothing is uploaded; the clip dies with the page.
- **Progress** — each text remembers when it was opened, the mode it was left
  in, the best cloze score and whether the speaking timer ran out. The list
  shows "lest" and "✓ ferdig" badges; home shows a count and a "Fortsett" link
  back into the last text. A text is finished when the cloze is solved in full
  and the two-minute talk was completed.

Everything above lives in the browser's localStorage, so progress is per
device and never leaves it.

## Offline use

A service worker caches the app shell and every text you open, so the site
keeps working without a connection afterwards. It uses network-first, so a
local `./serve.sh` never serves stale files. Add the page to your phone's home
screen for a standalone window.

## Generating a new text with Claude

    npm run generate -- --topic arbeid --level A2
    npm run generate -- --topic helse --level B1 --title "På apoteket"
    npm run generate -- --topic hverdag --level A2 --count 3

**Without an API key**, use a chat instead:

    npm run generate -- --topic hverdag --level A2 --count 3 --dry-run > prompt.txt

Paste `prompt.txt` into claude.ai, save the JSON it answers with as
`paste.json`, then:

    node tools/import-text.mjs paste.json --topic hverdag --level A2

That writes one `.draft.json` per text, runs the validator on each and leaves a
`.stubs.json` next to it with the missing words. Fill in the glosses and run
`node tools/add-entries.mjs <file>.stubs.json`, pin the ambiguous words, then:

    node tools/promote.mjs

which renames every ready draft to `.json`, adds it to `data/index.json`, and
holds back any draft the validator still complains about.

The script (`tools/generate.mjs`) sends Claude the topic, the level, the
annotation rules and the list of words the lexicon already knows, and asks
for a text that leans on them. The draft lands in
`data/paragraphs/<id>.draft.json` and the validator runs on it at once, so the
follow-up is the same as for a hand-written text: paste the stubs, pin the
ambiguous words, rename to `.json`, add to `data/index.json`.

It needs `ANTHROPIC_API_KEY` (or an `ant auth login` profile) and the SDK,
which is a devDependency: `npm install`. The simplest place for the key is a
`.env` file in the project root (`ANTHROPIC_API_KEY=sk-ant-...`); it is
gitignored and `npm run generate` reads it automatically. The app itself stays dependency-free.
Add `--dry-run` to print the prompt without calling the API.

## Content format

Content is split so each word is annotated once and reused everywhere.

### Lexicon — `data/lexicon.json`

One entry per lemma, keyed by lemma. `pos` selects which inflection fields
are meaningful; `forms` maps form names to surface strings and is what the
parser searches when auto-resolving unannotated words.

    "gå": {
      "pos": "verb",
      "gloss": "to go, to walk",
      "forms": {
        "infinitive": "gå", "present": "går",
        "preterite": "gikk", "perfect": "gått"
      }
    }

Function words (prepositions, conjunctions, pronouns) carry a `gloss` and no
`forms` — they render without a table. An optional `note` shows below the
gloss, for things the table cannot express.

### Paragraphs — `data/paragraphs/*.json`

`body` is an array of sentences. `topic` must name an id from `topics` in
`data/index.json`; `examNote` is shown above the text and on the topic page.
**Write plain Norwegian.** Bare words resolve
against every inflected form in the lexicon, so `Mannen min heter Carlos` needs
no annotation at all. Only three things are ever marked by hand:

**Phrases** — `[ ... ]` wraps a multi-word expression:

    Det er vanskelig å [bli kjent med] nye kollegaer.

When the phrase is discontinuous, name the lemma after the bracket. Only the
phrase's own words join it; anything in between keeps its own card:

    Først [henger vi regntøyet opp](henge opp) i garderoben.

Here `henger` and `opp` are one token for *å henge opp*, and `regntøyet`
stays a separate word with its own entry.

**Ambiguity pins** — `{surface:lemma}` where one form maps to several lemmas.
`så` is both *se* in the preterite and the adverb *så*, so it must be pinned:

    {Så:så} går vi til skolen.

The validator names every ambiguous word in a draft, so you do not have to
remember which ones they are.

**Proper nouns** — `<Norge>`, `<Carlos>`, `<tv>` render as plain, non-tappable
text: never looked up, never reported as a gap. Without this every name in the
corpus becomes a permanent `unresolved` warning.

### Adding lexicon entries in bulk

    node tools/add-entries.mjs new-entries.json

Merges `{ "<lemma>": { entry }, ... }` into `data/lexicon.json`, skipping any
lemma or id that already exists and leaving the file's formatting untouched.
Re-running with the same file is harmless.

### Writing a new paragraph

Write the Norwegian first, plainly, then ask the validator what it needs:

    node validate.js --draft data/paragraphs/ny.json

It prints paste-ready lexicon stubs for unknown words and lists any bare word
that is ambiguous. Fill in the glosses and irregular forms, pin the ambiguous
ones, and re-run until it says `Ready`. Then add the file to `data/index.json`
and run the full `node validate.js`.

    Først [{henger:henge opp} vi {regntøyet:regntøy} {opp:henge opp}] i {garderoben:garderobe}.

Here `henger` and `opp` form one token for *å henge opp*; tapping either opens
the phrase card. `regntøyet` is inside the bracket but opens *regntøy*.

Phrase entries in the lexicon are marked `"phrase": true` and are reachable
only through explicit annotation — never through auto-resolution.

### Diagnostics

Unresolvable tokens render as plain, non-tappable text and are grouped in the
console by kind, so gaps in the lexicon are easy to scan after adding content:

- `missing-lemma` — annotation points at a lemma with no lexicon entry
- `unresolved` — a bare word matched nothing
- `form-not-in-table` — annotated lemma exists, but the surface form is not
  among its listed forms
- `ambiguous` — matched several lemmas; first was used
- `unbalanced-bracket` — `[` without `]`

## Version and feedback

`APP_VERSION` in `app.js` is the single source of truth — there is no build
step to inject one. Bump it by hand when deploying; it is shown on the home
page and stamped into the subject and body of every feedback mail, so a report
always says which build it came from.

The feedback link is a plain `mailto:`. **The address is visible in the served
HTML**, which is the trade for having no third-party form service and no
backend. If scraping becomes a problem, a Formspree/Formspark endpoint or
GitHub Issues would both hide it.

## Tests

    node test/run.mjs      # view tests — what each route renders
    node test/css.mjs      # layout invariants in styles.css
    node validate.js       # content: lexicon + paragraphs

`test/run.mjs` mounts `app.js` against a small dependency-free DOM shim
(`test/dom.mjs`) and asserts what each route actually renders — that the
dictionary is not empty, that the back arrow is hidden on home, that each view
hides the other views' controls. It exists because reading the source kept
missing real breakage.

It cannot see CSS. `test/css.mjs` covers the layout invariants that a JS
harness structurally cannot — notably that every content element is pinned to
the right grid column on wide screens, which is what once rendered the entire
dictionary underneath the sidebar.

## Validating content

There is no build step, so nothing otherwise stands between a bad annotation
and the page. Run the validator after editing content:

    node validate.js

It exits nonzero on any error, so it drops into CI unchanged. It checks form
names against a per-POS schema, required forms and fields, orphaned
annotations, unbalanced brackets, and — the one that matters most as the
lexicon grows — **ambiguity**: any surface form resolving to more than one
lemma without an explicit annotation is an error, not a console note, because
first-match resolution depends on JSON key order and fails silently.

Warnings (unused lexicon entries, latent collisions no paragraph has hit yet)
never fail the run.

## Layout

    index.html      shell
    app.js          load, render, word card
    parser.js       annotation format -> tokens
    validate.js     content checks, run by hand or in CI
    styles.css      mobile-first
    data/           lexicon + paragraphs

## Deploying

GitHub Pages, serving from the repository root. All asset paths are relative,
since the site lives at `username.github.io/<repo>/`.
