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

## Open issue

- **Flaky render test.** `test/render.mjs` fails intermittently (1 in 4 runs):
  headless Chrome under `--virtual-time-budget` sometimes never evaluates the
  app module, so the probe reports zero items. Not a bug in the app — the same
  page loads in 80 ms in a real browser and in most headless runs. Fix by
  moving the probe off the virtual clock (use `--timeout` and real time) or by
  retrying a stalled probe once before failing.

## UI improvements

Ordered by how much they change daily use.

1. **A bottom tab bar on phones.** Home now has eight destinations, which is a
   list to read rather than a place to act. Four tabs (Kurs, Tekster, Ordbok,
   Øving) with the rest behind Kurs would cut most navigation to one tap.
2. **Make the word card a bottom sheet you can swipe away.** It is already a
   sheet on phones; add drag-to-dismiss and a small grabber so it feels native.
3. **Show progress as a ring, not a sentence.** "3 av 13 tekster lest" reads as
   data. A small ring per level on the course page, filling as steps complete,
   is read at a glance.
4. **Group the reader's mode chips with the text, not above it.** They
   currently sit between the exam note and the text, pushing the Norwegian
   down. Moving them to a sticky footer bar keeps the text at the top where
   the eye starts.
5. **One accent colour for "you did this".** Right now green means active
   word, correct answer, done step and current tab. Split into two: accent for
   interactive, a muted green only for completion.
6. **Let the dictionary jump by letter.** A thin A–Å rail down the right edge
   for 1080 entries, the way a phone contact list works.
7. **Show the review queue as a stack.** One card floating over the next two
   gives a sense of how much is left without a counter.
8. **Long-press a word to hear it** without opening the card, for reading
   aloud along with the text.
9. **Dark mode contrast pass.** The muted ink on dark backgrounds sits near the
   accessibility floor in a few places (`--ink-faint` on `--surface`).
10. **A real empty state for Egen tekst.** A short example paste and one line
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
