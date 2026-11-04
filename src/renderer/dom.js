// Small DOM helpers. Text always goes in as text nodes, never as HTML, so
// repo names, commit messages and command output cannot inject markup.

const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'hidden']);

/**
 * Creates an element.
 * @param {string} tag
 * @param {Record<string, any>|null} [props]  `class`, `on<event>` listeners, properties and attributes
 * @param {...any} children  nodes, strings, numbers, arrays; null/false are skipped
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (PROPS.has(key)) el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

/**
 * Creates an SVG element.
 * @param {string} tag
 * @param {Record<string, any>|null} [attrs]  attributes and `on<event>` listeners
 * @param {...any} children
 * @returns {SVGElement}
 */
export function svg(tag, attrs, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

/** @param {Node} el @param {any[]} children */
function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/**
 * Replaces an element's content.
 * @param {Element} el
 * @param {...any} children
 */
export function mount(el, ...children) {
  el.replaceChildren();
  append(el, children);
}

/** @param {string} text */
export const stripAnsi = (text) => String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

/**
 * Local time of an ISO date or epoch ms, without the date when it is today.
 * @param {string|number} ts
 */
export function shortTime(ts) {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * How a state reads: its glyph, its word and the class that colours it. The
 * keys are the link states of `/shared/tree.js` plus the journal's statuses.
 */
export const LOOK = {
  running: { glyph: null, word: 'running', cls: 's-running' },
  queued: { glyph: '·', word: 'queued', cls: 's-queued' },
  failed: { glyph: '✕', word: 'failed', cls: 's-failed' },
  updated: { glyph: '●', word: 'updated', cls: 's-updated' },
  committed: { glyph: '●', word: 'committed', cls: 's-updated' },
  same: { glyph: '○', word: 'up to date', cls: 's-same' },
  unchanged: { glyph: '○', word: 'up to date', cls: 's-same' },
  skipped: { glyph: '~', word: 'skipped', cls: 's-skipped' },
  none: { glyph: '–', word: 'no runs', cls: 's-none' }
};

/** Braille frames of the spinner; app.js turns every `.spin` element. */
export const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

/** A spinner glyph. */
export const spinner = () => h('span', { class: 'spin' }, SPIN[0]);

/**
 * The glyph of a state, a spinner while running.
 * @param {keyof typeof LOOK} kind
 */
export const glyph = (kind) => (kind === 'running' ? spinner() : (LOOK[kind] || LOOK.none).glyph);

/**
 * A box with its title on the border.
 * @param {string|Node|Array<any>} legend
 * @param {string|null} cls  extra classes: `failing`, `busy`, `tinted`, `dashed`
 * @param {...any} children
 */
export function box(legend, cls, ...children) {
  return h('section', { class: `box${cls ? ` ${cls}` : ''}` }, h('h3', { class: 'legend' }, legend), children);
}

/**
 * A button with its keyboard key in front: `r retry`.
 * @param {string|null} key
 * @param {string} label
 * @param {(e: Event) => void} onclick
 * @param {{ cls?: string, disabled?: boolean, title?: string }} [opts]
 */
export function keyButton(key, label, onclick, { cls = '', disabled = false, title } = {}) {
  return h('button', { class: `btn ${cls}`.trim(), onclick, disabled, title }, key ? h('span', { class: 'key' }, key) : null, label);
}

/**
 * The two side panels fold: `nav` the menu on the left (key `[`), `side` the
 * details panel on the right (key `]`). The state applies to every view, is
 * a class on the body (`nav-folded`, `side-folded`) and is remembered. Their
 * widths are dragged with `resizer`.
 */
const FOLDS = { nav: 'nav-folded', side: 'side-folded' };

/** @param {'nav'|'side'} panel */
const foldKey = (panel) => `layout.${panel}`;

/** Applies the remembered folds; app.js calls it once at start. */
export function restoreFolds() {
  for (const [panel, cls] of Object.entries(FOLDS)) {
    let folded = false;
    try {
      folded = localStorage.getItem(foldKey(panel)) === 'folded';
    } catch {}
    document.body.classList.toggle(cls, folded);
  }
}

/** @param {'nav'|'side'} panel */
export function toggleFold(panel) {
  const folded = document.body.classList.toggle(FOLDS[panel]);
  try {
    localStorage.setItem(foldKey(panel), folded ? 'folded' : 'open');
  } catch {}
}

/**
 * A handle on a panel's inner edge that drags its width, the panel's `--w`,
 * between `min` and `max()`. The width is remembered under `key`; a
 * double-click goes back to the stylesheet's width.
 * @param {HTMLElement} panel
 * @param {{ key: string, edge: 'left'|'right', min: number, max: () => number }} o
 *   `edge`: the side of the panel the handle sits on
 * @returns {HTMLElement}
 */
export function resizer(panel, { key, edge, min, max }) {
  const storageKey = `layout.${key}.width`;
  const setWidth = (w) => panel.style.setProperty('--w', `${w}px`);
  try {
    const saved = Number(localStorage.getItem(storageKey));
    if (saved > 0) setWidth(Math.max(min, saved));
  } catch {}

  const handle = h('div', {
    class: `resizer ${edge}`,
    role: 'separator',
    'aria-orientation': 'vertical',
    title: 'Drag to resize · double-click for the default width',
    ondblclick: () => {
      panel.style.removeProperty('--w');
      try {
        localStorage.removeItem(storageKey);
      } catch {}
    }
  });
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const start = panel.getBoundingClientRect().width;
    handle.classList.add('active');
    document.body.classList.add('resizing');
    const move = (ev) => {
      const dx = edge === 'right' ? ev.clientX - startX : startX - ev.clientX;
      setWidth(Math.round(Math.max(min, Math.min(max(), start + dx))));
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      handle.classList.remove('active');
      document.body.classList.remove('resizing');
      try {
        localStorage.setItem(storageKey, String(Math.round(panel.getBoundingClientRect().width)));
      } catch {}
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });
  return handle;
}

/** Room the main area keeps when a side panel is dragged wider, in px. */
const MAIN_MIN = 400;

/**
 * The details panel on the right of a view. The view mounts its content into
 * `body`; the toggle above it folds the panel into a strip that shows `label`,
 * and its left edge drags its width (remembered per panel).
 * @param {{ label: string, wide?: boolean }} o
 * @returns {{ el: HTMLElement, body: HTMLElement }}
 */
export function sidePanel({ label, wide = false }) {
  const body = h('div', { class: 'side-body' });
  const el = h(
    'aside',
    { class: `side-panel${wide ? ' wide' : ''}`, 'aria-label': label },
    h(
      'button',
      { type: 'button', class: 'fold', title: 'Fold or unfold this panel (])', onclick: () => toggleFold('side') },
      h('span', { class: 'key' }, ']'),
      h('span', { class: 'open' }, 'hide'),
      h('span', { class: 'folded' }, label.toLowerCase())
    ),
    body
  );
  el.append(
    resizer(el, {
      key: `side.${label.toLowerCase()}`,
      edge: 'left',
      min: 280,
      max: () => Math.max(280, window.innerWidth - (document.querySelector('.nav')?.offsetWidth ?? 0) - MAIN_MIN)
    })
  );
  return { el, body };
}

/** True while a text field has the keyboard, so single-letter shortcuts stay off. */
export function typing() {
  const el = document.activeElement;
  return !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
}

/**
 * A path with the home folder shortened to `~`, as the CLI prints paths.
 * @param {string} p
 */
export const tildify = (p) => String(p ?? '').replace(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[\\/]|$)/, '~');

/** "5 repos", "1 repo". */
export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
