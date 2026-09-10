// Annotation parser.
//
// Content is written as plain Norwegian. Almost nothing needs marking: a bare
// word resolves against every inflected form in the lexicon. Only three things
// are ever written by hand:
//
//   [bli kjent med]            a multi-word phrase
//   [henger vi det opp](henge opp)   ...with an explicit lemma when the span is
//                              discontinuous, so only the phrase's own words
//                              join it and the intervening object keeps its
//                              own card
//   {så:så}                    an ambiguity pin, when one surface form maps to
//                              several lemmas
//   <Norge>                    a proper noun or foreign word: plain text, never
//                              looked up, never reported as a gap
//
// Grammar, informally:
//   text      := (phrase | marked | literal | bare | punct)*
//   phrase    := '[' (marked | literal | bare | punct)+ ']' ('(' lemma ')')?
//   marked    := '{' surface ':' lemma '}'
//   literal   := '<' text '>'
//   bare      := run of letters (incl. æøå) and internal hyphens/apostrophes
//
// A phrase span produces ONE token covering several surface positions. Every
// position in it is tappable and opens the same card. Resolution order for a
// bare word: exact lemma, then any inflected form. Ambiguous and unresolved
// hits are reported, not thrown.

const MARKED = /^\{([^:{}]+):([^{}]+)\}/;
// <Oslo> marks a proper noun or foreign word: rendered as plain text, never
// looked up, never reported as a gap. Without it every name in the corpus
// becomes a permanent 'unresolved' warning.
const LITERAL = /^<([^<>]+)>/;
// Explicit phrase lemma directly after a closing bracket: [...](henge opp)
const PHRASE_LEMMA = /^\(([^()]+)\)/;
const WORD = /^[\p{L}][\p{L}\d'’-]*/u;

/** Build surface-form -> [{lemma, id, formName}] index for auto-resolution. */
export function buildFormIndex(lexicon) {
  const index = new Map();
  const add = (surface, lemma, id, formName) => {
    const key = surface.toLowerCase();
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({ lemma, id, formName });
  };
  for (const [lemma, entry] of Object.entries(lexicon.entries)) {
    if (entry.phrase) continue; // phrases are only reachable via explicit annotation
    add(lemma, lemma, entry.id, entry.forms ? null : 'lemma');
    if (!entry.forms) continue;
    for (const [formName, surface] of Object.entries(entry.forms)) {
      if (surface !== lemma) add(surface, lemma, entry.id, formName);
    }
  }
  return index;
}

/**
 * Look an annotation reference up by stable id first, then by lemma.
 * Ids survive renames and let two parts of speech share a lemma; lemma
 * references stay valid so content need not be rewritten.
 */
export function lookupEntry(lexicon, ref) {
  const direct = lexicon.entries[ref];
  if (direct) return { lemma: ref, entry: direct };
  for (const [lemma, entry] of Object.entries(lexicon.entries)) {
    if (entry.id === ref) return { lemma, entry };
  }
  return null;
}

/**
 * Parse one annotated sentence into a flat list of nodes.
 * Node kinds: 'word' (tappable if resolved), 'punct'.
 * Words belonging to one phrase share a `groupId`.
 */
function parseSentence(text, ctx) {
  const nodes = [];
  let rest = text;
  let phraseDepth = 0;
  let currentGroup = null;
  // Words collected since '[' opened, so the closing ']' can assign the group.
  let phraseNodes = [];

  const pushWord = (surface, lemmaHint) => {
    const node = {
      kind: 'word',
      surface,
      lemma: null,
      entryId: null,
      formName: null,
      groupId: null,
    };
    resolve(node, lemmaHint, ctx);
    nodes.push(node);
    if (phraseDepth > 0) phraseNodes.push(node);
  };

  while (rest.length > 0) {
    if (rest[0] === '[') {
      phraseDepth++;
      currentGroup = `g${ctx.groupCounter++}`;
      phraseNodes = [];
      rest = rest.slice(1);
      continue;
    }

    if (rest[0] === ']') {
      phraseDepth--;
      rest = rest.slice(1);

      // An explicit lemma may follow: [henger vi det opp](henge opp)
      const tail = PHRASE_LEMMA.exec(rest);
      if (tail) rest = rest.slice(tail[0].length);

      closePhrase(phraseNodes, currentGroup, tail?.[1], text, ctx);
      phraseNodes = [];
      currentGroup = null;
      continue;
    }

    const literal = LITERAL.exec(rest);
    if (literal) {
      const node = {
        kind: 'word',
        surface: literal[1],
        lemma: null,
        formName: null,
        groupId: null,
        literal: true,
      };
      nodes.push(node);
      rest = rest.slice(literal[0].length);
      continue;
    }

    const marked = MARKED.exec(rest);
    if (marked) {
      pushWord(marked[1], marked[2]);
      rest = rest.slice(marked[0].length);
      continue;
    }

    const word = WORD.exec(rest);
    if (word) {
      pushWord(word[0], null);
      rest = rest.slice(word[0].length);
      continue;
    }

    nodes.push({ kind: 'punct', surface: rest[0] });
    rest = rest.slice(1);
  }

  if (phraseDepth !== 0) {
    ctx.diagnostics.push({
      level: 'error',
      kind: 'unbalanced-bracket',
      message: `Unbalanced [ ] in: "${text}"`,
    });
  }
  return nodes;
}

/**
 * Resolve a bracketed span to one phrase entry and attach every word that
 * belongs to it.
 *
 * With no explicit lemma the whole span must be the phrase, so its words are
 * matched against the phrase entry's own words. With an explicit lemma the
 * span may be discontinuous — only the words the phrase actually contains
 * join it, and anything else in between keeps whatever it resolved to on its
 * own ("henger vi regntøyet opp" → regntøyet keeps its own card).
 */
function closePhrase(phraseNodes, groupId, explicitLemma, text, ctx) {
  const words = phraseNodes.filter((n) => !n.literal);
  if (words.length === 0) return;

  const ref = (explicitLemma ?? words.map((n) => n.surface).join(' ')).toLowerCase();
  const hit = lookupEntry(ctx.lexicon, ref);
  const lemma = hit?.lemma ?? ref;
  const entry = hit?.entry;

  if (!entry || !entry.phrase) {
    ctx.diagnostics.push({
      level: 'error',
      kind: explicitLemma ? 'missing-lemma' : 'unknown-phrase',
      message: explicitLemma
        ? `Lexicon has no phrase entry "${lemma}" (from [...](${lemma}))`
        : `No phrase entry matches "[${words.map((n) => n.surface).join(' ')}]" in: "${text}"`,
      lemma,
    });
    return;
  }

  // Which words of the span belong to the phrase itself. Match on the phrase
  // entry's own vocabulary so a discontinuous span picks out only its parts.
  const phraseWords = new Set(
    [lemma, ...Object.values(entry.forms ?? {})]
      .flatMap((s) => s.toLowerCase().split(/\s+/))
  );

  // Reflexive phrases inflect their pronoun (legge seg -> legger meg/deg/seg),
  // so the entry's literal "seg" would not match the surface "meg". Treat the
  // whole reflexive series as belonging to the phrase.
  if (phraseWords.has('seg')) {
    for (const p of ['meg', 'deg', 'oss', 'dere', 'seg']) phraseWords.add(p);
  }

  let attached = 0;
  for (const node of words) {
    if (explicitLemma && !phraseWords.has(node.surface.toLowerCase())) continue;
    node.lemma = lemma;
    node.entryId = entry.id;
    node.formName = entry.forms ? formNameFor(entry, node.surface) ?? 'phrase' : 'phrase';
    node.groupId = groupId;
    attached++;
    // Each word was resolved on its own before the bracket closed. Words that
    // occur only inside a fixed phrase ("hvert" in "i hvert fall") are not in
    // the lexicon by themselves, so that lookup logged a gap that the phrase
    // has now filled. Retract it — the token is fully resolved.
    retractDiagnostic(ctx, node.surface);
  }

  if (attached === 0) {
    ctx.diagnostics.push({
      level: 'warn',
      kind: 'empty-phrase',
      message: `[...](${lemma}) matched none of its words in: "${text}"`,
      lemma,
    });
  }
}

function resolve(node, lemmaHint, ctx) {
  const { lexicon, formIndex } = ctx;

  if (lemmaHint) {
    const hit = lookupEntry(lexicon, lemmaHint);
    if (!hit) {
      ctx.diagnostics.push({
        level: 'error',
        kind: 'missing-lemma',
        message: `Lexicon has no entry "${lemmaHint}" (from {${node.surface}:${lemmaHint}})`,
        lemma: lemmaHint,
        surface: node.surface,
      });
      return;
    }
    node.lemma = hit.lemma;
    node.entryId = hit.entry.id;
    node.formName = formNameFor(hit.entry, node.surface);
    if (!node.formName && hit.entry.forms) {
      ctx.diagnostics.push({
        level: 'warn',
        kind: 'form-not-in-table',
        message: `"${node.surface}" is annotated as "${lemmaHint}" but is not one of its listed forms`,
        lemma: hit.lemma,
        surface: node.surface,
      });
    }
    return;
  }

  const matches = formIndex.get(node.surface.toLowerCase());
  if (!matches || matches.length === 0) {
    ctx.diagnostics.push({
      level: 'warn',
      kind: 'unresolved',
      message: `No lexicon entry matches "${node.surface}" — rendering as plain text`,
      surface: node.surface,
    });
    return;
  }
  if (matches.length > 1) {
    ctx.diagnostics.push({
      level: 'info',
      kind: 'ambiguous',
      message: `"${node.surface}" matches ${matches
        .map((m) => m.lemma)
        .join(', ')} — took "${matches[0].lemma}". Annotate to disambiguate.`,
      surface: node.surface,
      candidates: matches.map((m) => m.id ?? m.lemma),
    });
  }
  node.lemma = matches[0].lemma;
  node.entryId = matches[0].id;
  node.formName = matches[0].formName;
}

/**
 * Drop the most recent unresolved/ambiguous report for a surface form, once a
 * phrase has claimed the token. Only the last one is removed: the same word
 * may legitimately appear elsewhere in the paragraph outside any phrase, and
 * that occurrence still deserves its diagnostic.
 */
function retractDiagnostic(ctx, surface) {
  const lower = surface.toLowerCase();
  for (let i = ctx.diagnostics.length - 1; i >= 0; i--) {
    const d = ctx.diagnostics[i];
    if (
      (d.kind === 'unresolved' || d.kind === 'ambiguous') &&
      d.surface?.toLowerCase() === lower
    ) {
      ctx.diagnostics.splice(i, 1);
      return;
    }
  }
}

function formNameFor(entry, surface) {
  if (!entry.forms) return null;
  const lower = surface.toLowerCase();
  for (const [formName, value] of Object.entries(entry.forms)) {
    if (value.toLowerCase() === lower) return formName;
  }
  // A phrase token holds only one word of the span; the span as a whole is the form.
  if (entry.phrase) return 'phrase';
  return null;
}

/** Parse a whole paragraph document. Returns { sentences, diagnostics }. */
export function parseParagraph(doc, lexicon) {
  const ctx = {
    lexicon,
    formIndex: buildFormIndex(lexicon),
    diagnostics: [],
    groupCounter: 0,
  };
  const sentences = doc.body.map((line) => parseSentence(line, ctx));
  return { sentences, diagnostics: ctx.diagnostics };
}

/** Group console output so gaps in the lexicon are easy to scan. */
export function reportDiagnostics(diagnostics, label) {
  if (diagnostics.length === 0) {
    console.info(`[norsk] ${label}: all tokens resolved.`);
    return;
  }
  const byKind = diagnostics.reduce((acc, d) => {
    (acc[d.kind] ||= []).push(d);
    return acc;
  }, {});
  console.groupCollapsed(
    `[norsk] ${label}: ${diagnostics.length} annotation diagnostic(s)`
  );
  for (const [kind, items] of Object.entries(byKind)) {
    console.groupCollapsed(`${kind} (${items.length})`);
    for (const item of items) {
      const fn = item.level === 'error' ? console.error : item.level === 'warn' ? console.warn : console.info;
      fn(item.message);
    }
    console.groupEnd();
  }
  console.groupEnd();
}
