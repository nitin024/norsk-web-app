// Lexicon stub generator, shared by the validator's draft mode and the
// scratch card in the app. One source, so a stub pasted from either place
// passes `node validate.js` — in particular, every stub carries the `id` the
// lexicon-id check requires.

// Id suffix per part of speech, matching the convention already in the data.
const ID_SUFFIX = {
  noun: 'n',
  verb: 'v',
  adjective: 'adj',
  adverb: 'adv',
  pronoun: 'pron',
  determiner: 'det',
  preposition: 'prep',
  conjunction: 'conj',
  numeral: 'num',
  particle: 'part',
  phrase: 'phr',
};

/** "henge opp" -> "henge-opp-phr", "barnehage" -> "barnehage-n". */
export function entryId(lemma, pos) {
  return `${lemma.trim().toLowerCase().replace(/\s+/g, '-')}-${ID_SUFFIX[pos] ?? pos}`;
}

/**
 * A paste-ready, single-line JSON fragment for one lexicon entry. Regular
 * inflections are filled in; the caller fixes gloss and any irregular forms.
 */
export function lexiconStub(lemma, pos = 'noun') {
  const id = entryId(lemma, pos);
  const l = lemma;
  switch (pos) {
    case 'noun':
      return `"${l}": { "id": "${id}", "pos": "noun", "gender": "en", "gloss": "", "forms": { "indefinite_sg": "${l}", "definite_sg": "${l}en", "indefinite_pl": "${l}er", "definite_pl": "${l}ene" } }`;
    case 'verb':
      return `"${l}": { "id": "${id}", "pos": "verb", "gloss": "", "forms": { "infinitive": "${l}", "present": "${l}r", "preterite": "${l}te", "perfect": "${l}t" } }`;
    case 'adjective':
      return `"${l}": { "id": "${id}", "pos": "adjective", "gloss": "", "forms": { "positive": "${l}", "neuter": "${l}t", "plural": "${l}e" } }`;
    case 'phrase':
      return `"${l}": { "id": "${id}", "pos": "phrase", "phrase": true, "gloss": "" }`;
    default:
      return `"${l}": { "id": "${id}", "pos": "${pos}", "gloss": "" }`;
  }
}

/**
 * Strip a likely definite/plural ending so the stub proposes a base form
 * rather than an inflected one. "statsråden" -> "statsråd", not a lemma
 * "statsråden" whose definite would come out "statsrådenen".
 *
 * A heuristic, and it will sometimes be wrong — the card says so.
 */
export function guessLemma(word) {
  // Longest endings first, so "kritikerne" loses "erne" rather than "e".
  const SUFFIXES = ['erne', 'ene', 'ane', 'er', 'en', 'et', 'ne', 'a'];
  for (const suffix of SUFFIXES) {
    if (word.length > suffix.length + 2 && word.endsWith(suffix)) {
      let stem = word.slice(0, -suffix.length);
      // Nouns in -e keep it in the base form: "kroner" -> "krone", not "kron".
      if (suffix === 'er' && !/[aeiouyæøå]$/.test(stem)) stem += 'e';
      return { lemma: stem, guessed: true };
    }
  }
  return { lemma: word, guessed: false };
}
