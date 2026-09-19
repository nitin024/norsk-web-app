# Roadmap

What is left to build. Delete a line when it ships.

For what the app already does, read the README; for how a shipped feature
works, read the code and its tests. This file is only the open list.

## Features

1. **More texts.** The thin pairs that remain: samfunn A1/A2, presentasjon B2,
   hverdag B1/B2, helse B2, bolig B2, fritid A2/B2, mat A2/B2, penger A2/B2.
   The loop is
   `npm run generate -- --plan ... --dry-run`, paste into a chat, then
   `import-text`, pin the ambiguous words, `promote`.
2. **More exercise types.** Join two clauses with a given connector; produce
   a tense from an infinitive and a time word.
3. **Speaking feedback.** Record and play back, so the learner hears
   themselves against the read-aloud voice.

## Not doing

- **Multi-device sync**, and **export/import of progress**. Ruled out: a
  static site cannot sync without a backend, and a paste-to-transfer code is
  the same thing with a worse interface.
