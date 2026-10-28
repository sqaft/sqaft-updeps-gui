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

/** Status of a target run -> lamp class and words. */
export const RUN_STATUS = {
  committed: { lamp: 'on', label: 'Committed' },
  unchanged: { lamp: 'off', label: 'Up to date' },
  skipped: { lamp: 'busy', label: 'Skipped' },
  failed: { lamp: 'danger', label: 'Failed' }
};
