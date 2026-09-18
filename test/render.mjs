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

import { existsSync, writeFileSync, unlinkSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

/**
 * A Chrome driven over the DevTools protocol, one browser for the whole run.
 *
 * The earlier version shelled out to `--dump-dom` per route. That dumps on
 * the load event, which for this app fires long before the lexicon has been
 * fetched and the view rendered, so it reported phantom "0 rows" failures.
 * `--virtual-time-budget` was worse: under it the module intermittently never
 * evaluated at all. CDP lets us poll the page until it is genuinely ready,
 * which is what the assertions actually need.
 */
// A fresh port and a fresh profile per run. Sharing either means a stale
// browser from an earlier run answers instead of this one's, and the suite
// silently measures the wrong pages.
const DEBUG_PORT = 9300 + (process.pid % 200);
const PROFILE = join(tmpdir(), `norsk-render-${process.pid}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let browser = null;
let wsSeq = 0;

async function startBrowser() {
  const proc = spawn(
    chrome,
    [
      '--headless',
      '--disable-gpu',
      '--no-first-run',
      '--disable-extensions',
      `--user-data-dir=${PROFILE}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (res.ok) return proc;
    } catch {
      /* not up yet */
    }
    await wait(150);
  }
  proc.kill();
  throw new Error('Chrome did not open a debugging port');
}

/** Open a tab, run `fn` against a send() helper, then close the tab. */
async function withTab(url, fn) {
  const target = await (
    await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  ).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++wsSeq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  try {
    return await fn(send);
  } finally {
    ws.close();
    await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${target.id}`).catch(() => {});
  }
}

/** The measurement, evaluated inside the page. */
const MEASURE = `(() => {
  const r = document.getElementById('reader');
  const root = getComputedStyle(document.documentElement);
  const rows = document.querySelectorAll('.dict-row, .para-link, .home-link, .sentence, .course-link');
  const out = {
    view: document.body.dataset.view || null,
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
  return JSON.stringify(out);
})()`;

/** Load a route, wait until it has actually rendered, and measure it. */
async function probe(hash, width, height = 900) {
  const url = `http://localhost:${PORT}/index.html${hash}`;
  return withTab(url, async (send) => {
    // The tab is opened at this size, so the app measures the viewport the
    // assertions are about. Overriding metrics without re-navigating keeps
    // the media queries honest without racing the app's own startup.
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 900,
    });

    const deadline = Date.now() + 15000;
    let last = null;
    while (Date.now() < deadline) {
      const { result } = await send('Runtime.evaluate', { expression: MEASURE, returnByValue: true });
      last = result.value ? JSON.parse(result.value) : null;
      if (last && last.view && last.items > 0) {
        // One more frame, so sticky offsets are measured after layout settles.
        await wait(150);
        const settled = await send('Runtime.evaluate', { expression: MEASURE, returnByValue: true });
        return JSON.parse(settled.result.value);
      }
      await wait(100);
    }
    throw new Error(`"${hash || '/'}" at ${width}px never rendered (view=${last && last.view}, items=${last && last.items})`);
  });
}

// --- serve -------------------------------------------------------------

const server = spawn('python3', ['-m', 'http.server', String(PORT)], {
  cwd: ROOT,
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 800));
browser = await startBrowser();

try {
  // Phone and laptop. The bug only appeared at >= 900px, so both matter.
  for (const [label, width] of [
    ['phone 420px', 420],
    ['laptop 1280px', 1280],
  ]) {
    const dict = await probe('#/ordbok', width);

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

    // The empty hash lands on the course at phone width and on the home menu
    // above it, so ask for the menu explicitly and check the landing view
    // separately.
    const home = await probe('#/mer', width);
    check(`${label}: the menu shows its links on screen`, () => {
      if (home.items < 3) throw new Error(`${home.items} links`);
      if (home.firstItemTop > home.innerHeight) {
        throw new Error(`first link at y=${home.firstItemTop}, below the fold`);
      }
    });

    const landing = await probe('', width);
    check(`${label}: opening the app lands somewhere with content`, () => {
      const expected = width < 900 ? 'course' : 'home';
      if (landing.view !== expected) {
        throw new Error(`landed on "${landing.view}", expected "${expected}"`);
      }
      if (landing.items < 1) throw new Error(`${landing.items} items on the landing view`);
    });

    const read = await probe('#/barnehagen', width);
    check(`${label}: paragraph text starts on screen`, () => {
      if (read.items < 5) throw new Error(`${read.items} sentences`);
      if (read.firstItemTop > read.innerHeight) {
        throw new Error(`first sentence at y=${read.firstItemTop}, below the fold`);
      }
    });
  }
} finally {
  server.kill();
  // SIGKILL: a headless Chrome that survives the run holds the debug port and
  // poisons the next one.
  browser?.kill('SIGKILL');
  try {
    rmSync(PROFILE, { recursive: true, force: true });
  } catch {
    /* a leftover profile directory is harmless */
  }
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
