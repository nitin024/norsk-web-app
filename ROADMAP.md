# Roadmap

Where the app stands and what is left. Delete a line when it ships.

## Done

- **Reader.** Tap any word for its form, inflection table and gloss. Four modes
  per text: Les, Fyll inn (cloze), Lytt (dictation), Snakk (timed prompt).
- **Grammatikk.** 30 rules in six sections: word order, verb, nouns and
  adjectives, connectors, prepositions and small words, pronunciation. Every
  rule has a "For English speakers" note, tappable examples, and exercises
  (choice, fill, reorder). Passing one marks the rule done.
- **Vis grammatikk** in the reader: marks finite verbs, tags V2 inversion and
  subordinate clauses in real sentences.
- **Ordbok.** 1080 lemmas, list or flash-card view over the same filters,
  search across inflected forms, pronunciation hints on the tricky words.
  Cards grade into the spaced schedule.
- **Øving.** Leitner ladder (1, 3, 7, 14, 30 days). Words enter by being
  looked up while reading or graded in the dictionary.
- **Tall og klokka.** Drill over numbers, clock, prices, dates and years.
- **Prøve.** Three-part timed exam simulation with random questions, a topic
  presentation and a discussion prompt.
- **Kurs.** One ordered path per level, interleaving texts, rules, drills,
  review and the exam. Home shows the next step.
- **Progress.** Per text: opens, mode, best cloze and dictation score, whether
  the talk was completed. Badges in the lists, summary and continue link on
  home.
- **Content.** 32 texts across 10 topics and 4 levels, all validated.
- **Tooling.** `generate` (prompt or API), `import-text`, `add-entries`,
  `promote`, and a validator that checks texts, lexicon, grammar and course.
- **Offline.** Service worker, manifest, installable.
- **Render tests over CDP.** `test/render.mjs` drives one headless Chrome via
  the DevTools protocol and polls each route until it has actually rendered,
  instead of shelling out to `--dump-dom` (which fires on the load event, long
  before this app has fetched its lexicon) or `--virtual-time-budget` (under
  which the module intermittently never evaluated). Unique debug port and
  profile per run, killed hard on exit. 16 checks, ~4s, no flakes.
- **Dictionary letter rail.** A–Å down the right edge of the alphabetical
  list, the way a contact list works. Letters with no matches stay in place
  but greyed and inert, so the rail keeps its shape as a search narrows the
  list. Hidden for shuffled orders and card view.
- **Two greens, two meanings.** `--accent` (teal) means "you can act on this";
  `--done` (olive) means "you finished this" and carries every completion
  state: checkmarks, correct answers, the ring fill, done badges, a finished
  timer. ~80 degrees of hue apart in both themes, all above 4.5:1 contrast,
  and a CSS test fails if a completion state borrows `--accent`.
- **Reading chrome out of the way.** The mode chips moved from above the text
  into their own bar docked over the tab bar, and the exam note collapses to
  its label. Scrolling down in a text slides both bars away; any scroll up or
  reaching the bottom brings them back. Only the reader hides them.
- **Progress rings.** Each level on the course page carries an SVG ring that
  fills as steps complete, labelled with the level inside it and a checkmark
  when finished. Animates on arrival, respects reduced motion.
- **Swipe the word card away.** On phones the sheet follows the finger, rubber
  bands upward, and dismisses past 110px or on a fast flick; a drag starting on
  a control or on a scrolled sheet is ignored. Desktop keeps the centred dialog.
- **Phone navigation.** A five-tab bottom bar (Kurs, Tekster, Ordbok, Øving,
  Mer) with a due badge on Øving. The app opens on the course at phone width
  and on the home menu above 900px, where the bar is hidden.

## Open issue

None.

## UI improvements

Ordered by how much they change daily use.

1. **Show the review queue as a stack.** One card floating over the next two
   gives a sense of how much is left without a counter.
2. **Long-press a word to hear it** without opening the card, for reading
   aloud along with the text.
3. **Dark mode contrast pass.** The muted ink on dark backgrounds sits near the
   accessibility floor in a few places (`--ink-faint` on `--surface`).
4. **A real empty state for Egen tekst.** A short example paste and one line
    saying what it does, instead of a blank box.

## Pending features

- **Listening beyond dictation.** Play a whole text with the words highlighted
  as they are spoken.
- **More texts.** Thin pairs: fritid A1/B1, mat A1/B1, penger A1/B1,
  samfunn A1/A2, presentasjon B2, hverdag B1/B2.
- **More exercise types.** Join two clauses with a given connector; produce a
  tense from an infinitive and a time word.
- **Speaking feedback.** Record and play back, so the learner hears themselves
  against the read-aloud voice.
- **Explicitly excluded:** multi-device sync, export and import of progress.
