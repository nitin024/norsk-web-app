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

`body` is an array of sentences. **Write plain Norwegian.** Bare words resolve
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
