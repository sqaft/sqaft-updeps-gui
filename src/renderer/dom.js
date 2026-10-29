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
