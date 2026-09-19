#!/usr/bin/env node
// Layout invariants in styles.css.
//
//   node test/css.mjs
//
// The view tests in run.mjs mount app.js against a DOM shim, so they prove the
// right elements are created — but they cannot see a stylesheet. Every bug
// below shipped despite those tests passing:
//
//   * the whole dictionary rendered underneath the sidebar, because
//     `display: contents` let auto-placement drop .reader into the rail column
//   * the back arrow stayed visible on home, because a class setting `display`
//     outranks the UA rule for [hidden]
//
// These are static checks on the CSS text. Crude, but they catch the exact
// class of regression that the DOM tests structurally cannot.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(ROOT, 'styles.css'), 'utf8');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const app = readFileSync(join(ROOT, 'app.js'), 'utf8');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push({ name, message: err.message });
  }
}

const fail = (msg) => {
  throw new Error(msg);
};

/** The body of an @media block, by its condition. */
function mediaBlock(condition) {
  const start = css.indexOf(`@media ${condition}`);
  if (start === -1) return '';
  let depth = 0;
  let i = css.indexOf('{', start);
  const from = i;
  for (; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(from + 1, i);
    }
  }
  return '';
}

/** The declaration block for a selector, within some scope. */
function rule(scope, selector) {
  const re = new RegExp(
    `(^|[},])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
    'm'
  );
  const m = re.exec(scope);
  return m ? m[2] : null;
}

// --- the two bugs that actually shipped --------------------------------

check('[hidden] is enforced against classes that set display', () => {
  const r = rule(css, '[hidden]');
  if (!r) fail('no [hidden] rule — an element with display set will ignore el.hidden');
  if (!/display:\s*none\s*!important/.test(r)) {
    fail('[hidden] must use display:none !important to outrank class rules');
  }
});

check('every element toggled via el.hidden can actually be hidden', () => {
  const toggled = [...app.matchAll(/getElementById\('([^']+)'\)\.hidden/g)].map((m) => m[1]);
  const unique = [...new Set(toggled)];
  if (unique.length === 0) fail('expected to find elements toggled via .hidden');
  // The [hidden] guard covers them all; assert it exists and is global.
  const guard = rule(css, '[hidden]');
  if (!guard) fail(`no [hidden] guard, but ${unique.length} elements rely on it`);
});

check('wide layout: no sidebar grid', () => {
  const wide = mediaBlock('(min-width: 900px)');
  if (!wide) return; // no wide block at all is fine — one layout everywhere

  // The sidebar was removed deliberately: `display: contents` promoted the
  // topbar, controls bars and reader into a body grid, and a full-height rail
  // then stretched its row and pushed the whole dictionary below the fold.
  // Twice. If it comes back, it needs explicit grid-row AND grid-column on
  // every promoted child — so make reintroducing it a conscious act.
  if (/#page\s*\{[^}]*display:\s*contents/.test(wide)) {
    for (const sel of ['.reader', '.dict-controls', '.scratch-controls', '.topbar']) {
      const r = rule(wide, sel) ?? '';
      if (!/grid-column/.test(r) || !/grid-row/.test(r)) {
        fail(
          `${sel} is in a display:contents grid without both grid-column and grid-row — ` +
            'auto-placement will push content off-screen'
        );
      }
    }
  }

  if (/height:\s*100vh/.test(rule(wide, '.topbar') ?? '')) {
    fail('.topbar is full-height on wide screens — that is the sidebar that was removed');
  }
});

check('dictionary glosses are hidden until revealed', () => {
  const gloss = rule(css, '.dict-gloss');
  if (!gloss) fail('.dict-gloss has no rule');
  if (!/display:\s*none/.test(gloss)) {
    fail('.dict-gloss should default to display:none — the list doubles as self-testing');
  }
  if (!/\.show-gloss \.dict-gloss/.test(css)) {
    fail('no .show-gloss reveal rule — the toggle would have no effect');
  }
});

check('the word card gloss is never hidden by the list toggle', () => {
  // .card-gloss must not be caught by the same display:none rule, or tapping
  // a word would show a card with no answer on it.
  const cardGloss = rule(css, '.card-gloss');
  if (!cardGloss) fail('.card-gloss has no rule');
  if (/display:\s*none/.test(cardGloss)) fail('.card-gloss must not be hidden');
});

check('controls bars do not overflow a narrow viewport', () => {
  // A max-width on the bar itself overflows when the viewport is narrower than
  // the measure; the bar should span, and only its contents be constrained.
  for (const sel of ['.dict-controls', '.scratch-controls']) {
    const r = rule(css, sel) ?? '';
    if (/max-width:\s*var\(--measure\)/.test(r)) {
      fail(`${sel} caps its own width; constrain its children instead`);
    }
  }
});

// --- structural invariants ---------------------------------------------

check('every id used by app.js exists in index.html', () => {
  const used = [...new Set([...app.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]))];
  const have = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const missing = used.filter((id) => !have.has(id));
  if (missing.length) fail(`missing from index.html: ${missing.join(', ')}`);
});

check('every class app.js sets has a rule in styles.css', () => {
  const set = new Set();
  for (const m of app.matchAll(/className\s*=\s*'([^']+)'/g)) {
    m[1].split(/\s+/).filter(Boolean).forEach((c) => set.add(c));
  }
  for (const m of app.matchAll(/classList\.add\('([^']+)'\)/g)) set.add(m[1]);
  const missing = [...set].filter((c) => !new RegExp(`\\.${c}\\b`).test(css));
  if (missing.length) fail(`no rule for: ${missing.join(', ')}`);
});

check('sticky layers do not all pin to the same offset', () => {
  const tops = [...css.matchAll(/position:\s*sticky;[^}]*?top:\s*([^;]+);/gs)].map((m) =>
    m[1].trim()
  );
  const zeroes = tops.filter((t) => t === '0');
  if (zeroes.length > 2) {
    fail(`${zeroes.length} sticky elements pin to top: 0 — they will overlap`);
  }
});

check('inputs are at least 16px so iOS does not zoom on focus', () => {
  for (const sel of ['.dict-search', '.scratch-input']) {
    const r = rule(css, sel);
    if (!r) fail(`${sel} has no rule`);
    const m = /font-size:\s*(\d+(?:\.\d+)?)px/.exec(r);
    if (!m) fail(`${sel} has no explicit px font-size`);
    if (Number(m[1]) < 16) fail(`${sel} is ${m[1]}px; iOS Safari zooms below 16px`);
  }
});

check('tap targets meet the 44px minimum', () => {
  for (const sel of ['.back', '.card-close']) {
    const r = rule(css, sel);
    if (!r) fail(`${sel} has no rule`);
    if (!/(min-height|height):\s*var\(--tap-min\)/.test(r)) {
      fail(`${sel} should size from --tap-min`);
    }
  }
});

// --- contrast ----------------------------------------------------------

/** Relative luminance, per WCAG 2.x. */
function luminance(hex) {
  const v = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
  const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The custom properties declared in one `:root`-ish block. */
function palette(block) {
  const out = {};
  for (const m of block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/gi)) out[m[1]] = m[2];
  return out;
}

check('every ink tone is readable on every surface it lands on', () => {
  // Light is the first :root block; dark is the prefers-color-scheme one.
  const light = palette(css.slice(css.indexOf(':root {'), css.indexOf('color-scheme: light dark')));
  const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
  const dark = palette(css.slice(darkStart, css.indexOf('}', css.indexOf('}', darkStart) + 1)));

  for (const [name, p] of [['light', light], ['dark', dark]]) {
    for (const fg of ['ink', 'ink-soft', 'ink-faint', 'accent', 'done']) {
      for (const bg of ['bg', 'surface', 'accent-soft', 'done-soft']) {
        if (!p[fg] || !p[bg]) fail(`${name}: missing --${fg} or --${bg}`);
        const r = contrast(p[fg], p[bg]);
        // 4.5:1 is the WCAG AA floor for body text.
        if (r < 4.5) fail(`${name}: --${fg} on --${bg} is ${r.toFixed(2)}:1, below 4.5`);
      }
    }
    // A control's outline and a wrong-answer marker are non-text UI: 3:1.
    for (const fg of ['edge', 'danger']) {
      for (const bg of ['bg', 'surface']) {
        const r = contrast(p[fg], p[bg]);
        if (r < 3) fail(`${name}: --${fg} on --${bg} is ${r.toFixed(2)}:1, below 3`);
      }
    }
  }
});

check('controls are outlined with --edge, not the decorative --rule', () => {
  // --rule separates rows and may stay faint; a border that defines where a
  // control begins may not.
  for (const sel of ['.btn-quiet', '.dict-search', '.scratch-input', '.dictation-input', '.word-chip', '.scramble-chip']) {
    const blocks = [...css.matchAll(new RegExp(`\\n${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'g'))];
    if (blocks.length === 0) fail(`${sel} has no rule`);
    const bordered = blocks.find((b) => /border(-bottom)?:[^;]*solid/.test(b[1]));
    if (!bordered) fail(`${sel} has no solid border to check`);
    if (/border(-bottom)?:[^;]*var\(--rule\)/.test(bordered[1])) {
      fail(`${sel} outlines itself with --rule; use --edge`);
    }
  }
});

check('grouped lists keep their heading while you scroll the group', () => {
  // A long grouped list loses its heading the moment you scroll into the
  // group. These three views group by something you can be inside: levels
  // on the course and the text list, sections in the grammar.
  const r = rule(css, '.level-title.is-sticky,\n.level-head.is-sticky');
  if (!r) fail('no sticky rule for section headings');
  if (!/position:\s*sticky/.test(r)) fail('section headings should be sticky');
  if (!/top:\s*var\(--topbar-h\)/.test(r)) fail('they should pin below the topbar');
  // Transparent headings let the rows scroll visibly through them.
  if (!/background:\s*var\(--bg\)/.test(r)) fail('a sticky heading must be opaque');
  if (!/z-index/.test(r)) fail('a sticky heading needs a stacking order');
});

check('completion and interaction use different colours', () => {
  // Green means two things in this app: "you can act on this" (--accent) and
  // "you finished this" (--done). If a completion state borrows --accent,
  // a checkmark reads as a button.
  for (const sel of [
    '.badge-done',
    '.exercise.is-right',
    '.dictation-input.is-right',
    '.cloze-input.is-right',
    '.ring-fill',
    '.course-mark',
    '.rule.is-passed .rule-title::after',
  ]) {
    const r = rule(css, sel);
    if (!r) fail(`${sel} has no rule`);
    if (/var\(--accent[^-]/.test(r) || /var\(--accent\)/.test(r)) {
      fail(`${sel} uses --accent; completion states belong on --done`);
    }
    if (!/var\(--done/.test(r)) fail(`${sel} should use --done`);
  }
});

check('both themes define the done colour', () => {
  for (const block of [css, css.slice(css.indexOf('prefers-color-scheme: dark'))]) {
    if (!/--done:\s*#[0-9a-f]{6}/i.test(block)) fail('no --done in one of the themes');
    if (!/--done-soft:\s*#[0-9a-f]{6}/i.test(block)) fail('no --done-soft in one of the themes');
  }
});

check('dark theme redefines the palette', () => {
  if (!/@media \(prefers-color-scheme: dark\)/.test(css)) fail('no dark-mode block');
  for (const token of ['--bg', '--ink', '--accent']) {
    const dark = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
    if (!new RegExp(`${token}:`).test(dark.slice(0, 600))) {
      fail(`${token} is not redefined for dark mode`);
    }
  }
});

// --- report ------------------------------------------------------------

console.log();
if (failures.length === 0) {
  console.log(`  ${passed} passed`);
} else {
  console.log(`  ${passed} passed, ${failures.length} failed\n`);
  for (const f of failures) {
    console.log(`  FAIL  ${f.name}`);
    console.log(`        ${f.message}`);
  }
}
console.log();
process.exit(failures.length > 0 ? 1 : 0);
