// A DOM small enough to mount app.js against, with no dependencies.
//
// It is not a browser. It implements the subset the app actually uses —
// element creation, tree mutation, class/dataset/attribute handling, a simple
// selector engine, plus fetch/localStorage/location shims — which is enough to
// assert that each view renders what it should.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

class ClassList {
  constructor(el) {
    this.el = el;
  }
  get _set() {
    return new Set((this.el.getAttribute('class') || '').split(/\s+/).filter(Boolean));
  }
  _write(set) {
    this.el.setAttribute('class', [...set].join(' '));
  }
  add(...names) {
    const s = this._set;
    names.forEach((n) => s.add(n));
    this._write(s);
  }
  remove(...names) {
    const s = this._set;
    names.forEach((n) => s.delete(n));
    this._write(s);
  }
  contains(name) {
    return this._set.has(name);
  }
  toggle(name, force) {
    const on = force === undefined ? !this._set.has(name) : Boolean(force);
    if (on) this.add(name);
    else this.remove(name);
    return on;
  }
  toString() {
    return [...this._set].join(' ');
  }
}

class Element {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = { setProperty() {}, removeProperty() {} };
    this.classList = new ClassList(this);
    this.dataset = new Proxy(
      {},
      {
        get: (_, key) => this.getAttribute(`data-${kebab(key)}`) ?? undefined,
        set: (_, key, value) => (this.setAttribute(`data-${kebab(key)}`, String(value)), true),
        has: (_, key) => this.attributes.has(`data-${kebab(key)}`),
        deleteProperty: (_, key) => (this.attributes.delete(`data-${kebab(key)}`), true),
      }
    );
  }

  // --- attributes ---
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'id') this.ownerDocument._byId.set(String(value), this);
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }

  get id() {
    return this.getAttribute('id') ?? '';
  }
  set id(v) {
    this.setAttribute('id', v);
  }
  get className() {
    return this.getAttribute('class') ?? '';
  }
  set className(v) {
    this.setAttribute('class', v);
  }
  get hidden() {
    return this.hasAttribute('hidden');
  }
  set hidden(v) {
    if (v) this.setAttribute('hidden', '');
    else this.removeAttribute('hidden');
  }
  get href() {
    return this.getAttribute('href') ?? '';
  }
  set href(v) {
    this.setAttribute('href', v);
  }
  get lang() {
    return this.getAttribute('lang') ?? '';
  }
  set lang(v) {
    this.setAttribute('lang', v);
  }
  get type() {
    return this.getAttribute('type') ?? '';
  }
  set type(v) {
    this.setAttribute('type', v);
  }
  get scope() {
    return this.getAttribute('scope') ?? '';
  }
  set scope(v) {
    this.setAttribute('scope', v);
  }

  // --- tree ---
  get children() {
    return this.childNodes.filter((n) => n instanceof Element);
  }
  append(...nodes) {
    for (const node of nodes) {
      const n = typeof node === 'string' ? new TextNode(node, this.ownerDocument) : node;
      n.parentNode?.removeChild?.(n);
      n.parentNode = this;
      this.childNodes.push(n);
    }
  }
  appendChild(node) {
    this.append(node);
    return node;
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i !== -1) this.childNodes.splice(i, 1);
    node.parentNode = null;
    return node;
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  replaceWith(node) {
    const parent = this.parentNode;
    if (!parent) return;
    const i = parent.childNodes.indexOf(this);
    node.parentNode?.removeChild?.(node);
    node.parentNode = parent;
    parent.childNodes.splice(i, 1, node);
    this.parentNode = null;
  }
  replaceChildren(...nodes) {
    this.childNodes.forEach((n) => (n.parentNode = null));
    this.childNodes = [];
    this.append(...nodes);
  }
  contains(node) {
    if (node === this) return true;
    return this.children.some((c) => c.contains(node));
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === this.ownerDocument || n.tagName === 'HTML';
  }

  // --- text ---
  get textContent() {
    return this.childNodes.map((n) => n.textContent).join('');
  }
  set textContent(v) {
    this.childNodes = [];
    if (v !== '' && v != null) this.append(new TextNode(String(v), this.ownerDocument));
  }

  // --- selectors ---
  querySelectorAll(selector) {
    const out = [];
    const walk = (el) => {
      for (const child of el.children) {
        if (matches(child, selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  /** Nearest self-or-ancestor matching the selector, as the DOM does. */
  closest(selector) {
    let node = this;
    while (node && node instanceof Element) {
      if (matches(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
  setPointerCapture() {}
  releasePointerCapture() {}

  // --- events / layout stubs ---
  addEventListener(type, fn, options) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    // Capture listeners run before bubbling ones on the same element, which
    // is how a handler cancels the event for the handlers after it.
    const capture = options === true || (options && options.capture);
    if (capture) this.listeners.get(type).unshift(fn);
    else this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    const i = list.indexOf(fn);
    if (i !== -1) list.splice(i, 1);
  }
  dispatch(type, event = {}) {
    // Real events carry these; handlers call them.
    const base = {
      type,
      target: this,
      preventDefault() {},
      stopPropagation() {},
      stopImmediatePropagation() {},
    };
    let stopped = false;
    base.stopImmediatePropagation = () => {
      stopped = true;
    };
    for (const fn of [...(this.listeners.get(type) ?? [])]) {
      if (stopped) break;
      fn({ ...base, ...event });
    }
    const on = this[`on${type}`];
    if (!stopped && typeof on === 'function') on({ ...base, ...event });
  }
  click() {
    this.dispatch('click');
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  getBoundingClientRect() {
    return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  }
  getClientRects() {
    return [{ width: 10, height: 10 }];
  }
  get offsetParent() {
    return this.parentNode ?? null;
  }
}

class TextNode {
  constructor(text, ownerDocument) {
    this.nodeValue = String(text);
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
  }
  get textContent() {
    return this.nodeValue;
  }
  get children() {
    return [];
  }
  contains() {
    return false;
  }
}

const kebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Supports the selector forms app.js actually uses. */
function matches(el, selector) {
  return selector
    .split(',')
    .map((s) => s.trim())
    .some((part) => {
      if (part.startsWith('.')) return el.classList.contains(part.slice(1));
      if (part.startsWith('#')) return el.id === part.slice(1);
      if (part.startsWith('[')) {
        const m = /^\[([^\]=]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(part);
        if (!m) return false;
        const [, name, value] = m;
        if (name.startsWith('data-')) {
          return value === undefined
            ? el.hasAttribute(name)
            : el.getAttribute(name) === value;
        }
        return value === undefined ? el.hasAttribute(name) : el.getAttribute(name) === value;
      }
      // tag, optionally with :not(...) which we treat permissively
      const tag = part.split(':')[0].toUpperCase();
      return el.tagName === tag;
    });
}

class Document extends Element {
  constructor() {
    super('#document', null);
    this.ownerDocument = this;
    this._byId = new Map();
    this.activeElement = null;
    this.title = '';
    this.documentElement = this.createElement('html');
    this.body = this.createElement('body');
    this.documentElement.append(this.body);
    this.append(this.documentElement);
  }
  createElement(tag) {
    return new Element(tag, this);
  }
  /** SVG elements behave like any other here; the namespace is ignored. */
  createElementNS(_ns, tag) {
    return new Element(tag, this);
  }
  createTextNode(text) {
    return new TextNode(text, this);
  }
  createRange() {
    return { selectNodeContents() {} };
  }
  getElementById(id) {
    const el = this._byId.get(id);
    return el && el.isConnected ? el : (el ?? null);
  }
}

/**
 * Build a document from the real index.html so tests exercise the actual
 * markup, not a hand-written copy that can drift.
 */
export function buildDocument(root) {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const doc = new Document();

  // Minimal parser: enough for our flat, well-formed markup.
  const bodyHtml = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'));
  const stack = [doc.body];
  const tokens = bodyHtml.match(/<[^>]+>|[^<]+/g) ?? [];

  for (const token of tokens) {
    if (token.startsWith('<!--')) continue;
    if (token.startsWith('</')) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (token.startsWith('<')) {
      const selfClosing = token.endsWith('/>');
      const inner = token.slice(1, selfClosing ? -2 : -1).trim();
      const tag = inner.split(/\s/)[0];
      if (tag.startsWith('!')) continue;
      const el = doc.createElement(tag);
      for (const m of inner.slice(tag.length).matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)) {
        el.setAttribute(m[1], m[2] ?? '');
      }
      stack[stack.length - 1].append(el);
      const VOID = ['input', 'br', 'img', 'meta', 'link', 'path', 'rect'];
      if (!selfClosing && !VOID.includes(tag.toLowerCase())) stack.push(el);
      continue;
    }
    const text = token;
    if (text.trim()) stack[stack.length - 1].append(doc.createTextNode(text.trim()));
  }
  return doc;
}

/** Install globals so app.js can be imported and run. */
export function installGlobals(doc, root) {
  const store = new Map();

  // Node predefines some of these as getter-only, so plain assignment throws.
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });

  define('document', doc);
  define('location', { hash: '' });
  define('navigator', {
    clipboard: { writeText: async () => {} },
    // A real string, so tests catch values interpolated straight into output.
    userAgent: 'Mozilla/5.0 (test) AppleWebKit/605.1.15 Safari/605.1.15',
  });
  define('getSelection', () => ({ removeAllRanges() {}, addRange() {} }));

  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };

  // The ring schedules its fill on the next frame.
  define('requestAnimationFrame', (fn) => setTimeout(() => fn(Date.now()), 0));

  // Speech: a recorder rather than a stub, so tests can assert what the app
  // asked to have spoken. `spoken` is the transcript.
  const spoken = [];
  // Utterances carry listeners, because word-by-word highlighting is driven
  // by their `boundary` events.
  define('SpeechSynthesisUtterance', class {
    constructor(text) {
      this.text = text;
      this._on = new Map();
    }
    addEventListener(type, fn) {
      if (!this._on.has(type)) this._on.set(type, []);
      this._on.get(type).push(fn);
    }
    dispatch(type, event = {}) {
      for (const fn of this._on.get(type) ?? []) fn({ type, ...event });
    }
  });
  // Voices are a list a test can swap, so the missing-voice path is testable.
  let voices = [{ lang: 'nb-NO', name: 'Test' }];
  const voiceListeners = [];
  globalThis.__setVoices = (list) => {
    voices = list;
    for (const fn of voiceListeners) fn({ type: 'voiceschanged' });
  };
  define('speechSynthesis', {
    getVoices: () => voices,
    addEventListener(type, fn) {
      if (type === 'voiceschanged') voiceListeners.push(fn);
    },
    speak(u) {
      spoken.push(u.text);
      // The last utterance, so a test can step it word by word.
      globalThis.__utterance = u;
    },
    cancel() {},
  });
  globalThis.__spoken = spoken;

  /**
   * Replay an utterance the way a speech engine would: one `boundary` per
   * word, then `end`. Returns what was highlighted after each word.
   */
  globalThis.__speakWords = (limit = Infinity) => {
    const u = globalThis.__utterance;
    if (!u) return [];
    const seen = [];
    let n = 0;
    for (const m of u.text.matchAll(/\S+/g)) {
      if (n++ >= limit) return seen;
      u.dispatch('boundary', { name: 'word', charIndex: m.index, charLength: m[0].length });
      const lit = doc.getElementById('reader').querySelectorAll('.w').filter((w) => w.classList.contains('is-speaking'));
      seen.push(lit.length === 1 ? lit[0].textContent : `${lit.length} lit`);
    }
    u.dispatch('end');
    return seen;
  };

  globalThis.window = {
    addEventListener: (type, fn) => doc.addEventListener(type, fn),
    scrollTo() {},
    dispatch: (type) => doc.dispatch(type),
  };

  globalThis.fetch = async (url) => {
    try {
      const body = readFileSync(join(root, url), 'utf8');
      return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
    } catch {
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    }
  };

  return { store };
}

export { Document, Element };
