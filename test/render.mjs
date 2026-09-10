#!/usr/bin/env node
// Rendered-layout tests, in a real browser engine.
//
//   node test/render.mjs
//
// Skips cleanly (exit 0) if Chrome is not installed, so it never blocks CI on
// a machine without it.
//
// This suite exists because the other two structurally could not catch what
// shipped twice:
//
//   * test/run.mjs mounts app.js against a DOM shim. It proved 640 dictionary
//     rows were created — while the page showed nothing.
//   * test/css.mjs reads styles.css as text. It cannot compute layout.
//
// The bug both missed: measureChrome() measured a `height: 100vh` sidebar on
// wide screens and fed 813px into the sticky offsets, so #reader began a full
// viewport below the fold. Everything was present, visible, and off-screen.
//
// So these assertions are about geometry: is the content actually where a
// reader would see it.

import { existsSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8123;

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const chrome = CHROME_PATHS.find((p) => existsSync(p));

if (!chrome) {
  console.log('\n  skipped — no Chrome found\n');
  process.exit(0);
}

let passed = 0;
const failures = [];
const check = (name, fn) => {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push({ name, message: err.message });
  }
};

/** Load a route and return measurements taken in the page. */
function probe(hash, width, height = 900) {
  const probeScript = `
<script>
window.addEventListener('load', () => setTimeout(() => {
  const r = document.getElementById('reader');
  const root = getComputedStyle(document.documentElement);
  const rows = document.querySelectorAll('.dict-row, .para-link, .home-link, .sentence');
  const out = {
    view: document.body.dataset.view,
    innerHeight: window.innerHeight,
    topbarH: parseFloat(root.getPropertyValue('--topbar-h')) || 0,
    dictH: parseFloat(root.getPropertyValue('--dict-controls-h')) || 0,
    readerTop: Math.round(r.getBoundingClientRect().top),
    readerWidth: Math.round(r.getBoundingClientRect().width),
    items: rows.length,
  };
  if (rows.length) {
    const b = rows[0].getBoundingClientRect();
    out.firstItemTop = Math.round(b.top);
    out.firstItemHeight = Math.round(b.height);
    out.firstItemVisible = getComputedStyle(rows[0]).visibility;
  }
  document.title = 'PROBE' + JSON.stringify(out);
}, 900));
</script>`;

  const src = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const tmpName = `.probe-${Date.now()}.html`;
  writeFileSync(join(ROOT, tmpName), src.replace('</body>', probeScript + '</body>'));

  try {
    const dom = execFileSync(
      chrome,
      [
        '--headless',
        '--disable-gpu',
        '--virtual-time-budget=6000',
        `--window-size=${width},${height}`,
        '--dump-dom',
        `http://localhost:${PORT}/${tmpName}${hash}`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }
    );
    const m = /<title>PROBE(.*?)<\/title>/s.exec(dom);
    if (!m) throw new Error('probe did not report — page may have failed to load');
    return JSON.parse(m[1]);
  } finally {
    try {
      unlinkSync(join(ROOT, tmpName));
    } catch {}
  }
}

// --- serve -------------------------------------------------------------

const server = spawn('python3', ['-m', 'http.server', String(PORT)], {
  cwd: ROOT,
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 800));

try {
  // Phone and laptop. The bug only appeared at >= 900px, so both matter.
  for (const [label, width] of [
    ['phone 420px', 420],
    ['laptop 1280px', 1280],
  ]) {
    const dict = probe('#/ordbok', width);

    check(`${label}: dictionary renders rows`, () => {
      if (dict.items < 600) throw new Error(`only ${dict.items} rows`);
    });

    check(`${label}: dictionary content starts on screen (regression)`, () => {
      if (dict.firstItemTop > dict.innerHeight) {
        throw new Error(
          `first row at y=${dict.firstItemTop}, viewport is ${dict.innerHeight} — content is below the fold`
        );
      }
    });

    check(`${label}: reader is not pushed off-screen`, () => {
      if (dict.readerTop > dict.innerHeight * 0.6) {
        throw new Error(`#reader top is ${dict.readerTop} of ${dict.innerHeight}`);
      }
    });

    check(`${label}: sticky offsets are sane`, () => {
      if (dict.topbarH > 200) throw new Error(`--topbar-h is ${dict.topbarH}px`);
      if (dict.dictH > 250) throw new Error(`--dict-controls-h is ${dict.dictH}px`);
    });

    check(`${label}: reader has usable width`, () => {
      if (dict.readerWidth < 200) throw new Error(`#reader is ${dict.readerWidth}px wide`);
    });

    const home = probe('', width);
    check(`${label}: home shows its links on screen`, () => {
      if (home.items < 3) throw new Error(`${home.items} links`);
      if (home.firstItemTop > home.innerHeight) {
        throw new Error(`first link at y=${home.firstItemTop}, below the fold`);
      }
    });

    const read = probe('#/barnehagen', width);
    check(`${label}: paragraph text starts on screen`, () => {
      if (read.items < 5) throw new Error(`${read.items} sentences`);
      if (read.firstItemTop > read.innerHeight) {
        throw new Error(`first sentence at y=${read.firstItemTop}, below the fold`);
      }
    });
  }
} finally {
  server.kill();
}

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
