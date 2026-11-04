// Small DOM helpers. Text always goes in as text nodes, never as HTML, so
// repo names, commit messages and command output cannot inject markup.

import { shownTab, stepTab } from '/shared/tabs.js';

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
 * keys are the link states of `/shared/map.js` plus the journal's statuses.
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
 * details panel (key `]`). The state applies to every view, is a class on the
 * body (`nav-folded`, `side-folded`) and is remembered. The details panel is
 * docked on the right or at the bottom (key `\`, class `dock-bottom`, also
 * remembered). Their sizes are dragged with `resizer`.
 */
const FOLDS = { nav: 'nav-folded', side: 'side-folded' };

/** @param {'nav'|'side'} panel */
const foldKey = (panel) => `layout.${panel}`;

const DOCK_KEY = 'layout.dock';

/** Applies the remembered folds and dock; app.js calls it once at start. */
export function restoreLayout() {
  for (const [panel, cls] of Object.entries(FOLDS)) {
    let folded = false;
    try {
      folded = localStorage.getItem(foldKey(panel)) === 'folded';
    } catch {}
    document.body.classList.toggle(cls, folded);
  }
  let bottom = false;
  try {
    bottom = localStorage.getItem(DOCK_KEY) === 'bottom';
  } catch {}
  document.body.classList.toggle('dock-bottom', bottom);
}

/** @param {'nav'|'side'} panel */
export function toggleFold(panel) {
  const folded = document.body.classList.toggle(FOLDS[panel]);
  try {
    localStorage.setItem(foldKey(panel), folded ? 'folded' : 'open');
  } catch {}
}

/** Whether the details panel is docked at the bottom. */
export const dockedBottom = () => document.body.classList.contains('dock-bottom');

/** Docks the details panel at the bottom or on the right; the `layoutchange` event on the document tells app.js. */
export function toggleDock() {
  const bottom = document.body.classList.toggle('dock-bottom');
  try {
    localStorage.setItem(DOCK_KEY, bottom ? 'bottom' : 'right');
  } catch {}
  document.dispatchEvent(new Event('layoutchange'));
}

/**
 * A handle on a panel's inner edge that drags its size: the width (the panel's
 * `--w`) for a `left` or `right` edge, the height (`--h`) for the `top` edge,
 * between `min` and `max()`. The size is remembered under `key`; a
 * double-click goes back to the stylesheet's size.
 * @param {HTMLElement} panel
 * @param {{ key: string, edge: 'left'|'right'|'top', min: number, max: () => number }} o
 *   `edge`: the side of the panel the handle sits on
 * @returns {HTMLElement}
 */
export function resizer(panel, { key, edge, min, max }) {
  const vertical = edge === 'top';
  const prop = vertical ? '--h' : '--w';
  const noun = vertical ? 'height' : 'width';
  const storageKey = `layout.${key}.${noun}`;
  const setSize = (px) => panel.style.setProperty(prop, `${px}px`);
  const size = () => {
    const rect = panel.getBoundingClientRect();
    return vertical ? rect.height : rect.width;
  };
  try {
    const saved = Number(localStorage.getItem(storageKey));
    if (saved > 0) setSize(Math.max(min, saved));
  } catch {}

  const handle = h('div', {
    class: `resizer ${edge}`,
    role: 'separator',
    'aria-orientation': vertical ? 'horizontal' : 'vertical',
    title: `Drag to resize · double-click for the default ${noun}`,
    ondblclick: () => {
      panel.style.removeProperty(prop);
      try {
        localStorage.removeItem(storageKey);
      } catch {}
    }
  });
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startAt = vertical ? e.clientY : e.clientX;
    const start = size();
    handle.classList.add('active');
    document.body.classList.add('resizing');
    document.body.classList.toggle('resizing-y', vertical);
    const move = (ev) => {
      const at = vertical ? ev.clientY : ev.clientX;
      const grow = edge === 'right' ? at - startAt : startAt - at;
      setSize(Math.round(Math.max(min, Math.min(max(), start + grow))));
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      handle.classList.remove('active');
      document.body.classList.remove('resizing', 'resizing-y');
      try {
        localStorage.setItem(storageKey, String(Math.round(size())));
      } catch {}
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });
  return handle;
}

/** Room the main area keeps when the details panel is dragged wider, in px. */
const MAIN_MIN_WIDTH = 400;
/** The details panel's least height at the bottom, and the height the main area keeps above it, in px. */
const PANEL_MIN_HEIGHT = 160;
const MAIN_MIN_HEIGHT = 260;

/**
 * Marks a section of the details panel as a tab. When the panel is docked at
 * the bottom it shows one tab at a time, named by `label`; the section's own
 * legend is hidden there and becomes the tab's tooltip. `id` must stay the
 * same while the section's legend changes (counts, times), as the panel keeps
 * its active tab by it. Right-docked, the section just stacks with the rest.
 * @param {HTMLElement} section  usually a `box`
 * @param {string} id
 * @param {{ label?: string, tone?: 'failed'|'running'|null }} [o]  `label` defaults to the id
 * @returns {HTMLElement}
 */
export function tab(section, id, { label = id, tone = null } = {}) {
  section.dataset.tab = id;
  section.dataset.label = label;
  if (tone) section.dataset.tone = tone;
  else delete section.dataset.tone;
  const legend = section.querySelector(':scope > .legend')?.textContent;
  if (legend) section.dataset.title = legend;
  return section;
}

/** The active tab of each panel, by panel label; it outlives the view that drew the panel. */
const activeTabs = new Map();
let panelSeq = 0;

/**
 * The details panel of a view, docked on the right or at the bottom. The view
 * hands its content to `show` (or `empty`); on the right the sections stack,
 * at the bottom those marked with `tab` become tabs. The head holds the tab
 * strip, the `actions` and the buttons that dock and fold the panel; the
 * fold button turns the panel into a strip showing `label`. Its inner edge
 * drags its width (right) or height (bottom), remembered per panel.
 * @param {{ label: string, wide?: boolean }} o
 * @returns {{
 *   el: HTMLElement,
 *   body: HTMLElement,
 *   show: (sections: any[], o?: { actions?: any, focusTab?: string|null, key?: string }) => void,
 *   empty: (...content: any[]) => void,
 *   step: (step: number) => boolean
 * }}
 *   `show`: `sections` are elements and arrays of them; `actions` (remove, with
 *   its confirmation) end the stack on the right and sit in the head at the
 *   bottom; `focusTab` selects that tab if there is one; `key` names what the
 *   panel shows (the selected repo), the scroll position goes back to the top
 *   when it changes. `empty` shows a message with no tabs. `step` selects the
 *   previous or next tab and returns whether it did.
 */
export function sidePanel({ label, wide = false }) {
  const uid = `panel${++panelSeq}`;
  const body = h('div', { class: 'side-body' });
  const tablist = h('div', {
    class: 'tablist',
    role: 'tablist',
    'aria-label': `${label} sections`,
    onkeydown: (e) => {
      const to = { ArrowLeft: (ids, at) => stepTab(ids, at, -1), ArrowRight: (ids, at) => stepTab(ids, at, 1), Home: (ids) => ids[0], End: (ids) => ids.at(-1) }[e.key];
      if (!to || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      activate(to(tabIds(), shown), { focus: true });
    }
  });
  // A vertical wheel scrolls a strip that overflows sideways.
  tablist.addEventListener(
    'wheel',
    (e) => {
      if (tablist.scrollWidth <= tablist.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      tablist.scrollLeft += e.deltaY;
    },
    { passive: false }
  );
  const actionsSlot = h('div', { class: 'side-actions' });
  const dock = h(
    'button',
    { type: 'button', class: 'dock', title: 'Dock the panel at the bottom or on the right (\\)', onclick: toggleDock },
    h('span', { class: 'key' }, '\\'),
    h('span', { class: 'to-bottom' }, 'dock bottom'),
    h('span', { class: 'to-right' }, 'dock right')
  );
  const fold = h(
    'button',
    { type: 'button', class: 'fold', title: 'Fold or unfold this panel (])', onclick: () => toggleFold('side') },
    h('span', { class: 'key' }, ']'),
    h('span', { class: 'open' }, 'hide'),
    h('span', { class: 'folded' }, label.toLowerCase())
  );
  const el = h('aside', { class: `side-panel${wide ? ' wide' : ''}`, 'aria-label': label }, h('div', { class: 'side-head' }, tablist, actionsSlot, dock, fold), body);
  el.append(
    resizer(el, {
      key: `side.${label.toLowerCase()}`,
      edge: 'left',
      min: 280,
      max: () => Math.max(280, window.innerWidth - (document.querySelector('.nav')?.offsetWidth ?? 0) - MAIN_MIN_WIDTH)
    }),
    resizer(el, {
      key: `side.${label.toLowerCase()}`,
      edge: 'top',
      min: PANEL_MIN_HEIGHT,
      max: () => Math.max(PANEL_MIN_HEIGHT, (el.parentElement?.clientHeight ?? 0) - MAIN_MIN_HEIGHT)
    })
  );

  /** What the view last handed over. */
  let content = { sections: [], tabs: [], actions: null, key: '' };
  /** The tab that shows at the bottom, and the key it was drawn for; `shown` is null while no tabs show. */
  let shown = null;
  let shownKey = null;
  const buttons = new Map(); // tab id -> button, kept between renders so the strip keeps its scroll

  const tabIds = () => content.tabs.map((t) => t.dataset.tab);

  function syncTabs() {
    const stale = new Set(buttons.keys());
    content.tabs.forEach((section, i) => {
      const id = section.dataset.tab;
      stale.delete(id);
      let button = buttons.get(id);
      if (!button) {
        button = h('button', { type: 'button', role: 'tab', class: 'tab', id: `${uid}-tab${++panelSeq}`, onclick: () => activate(id) });
        button.dataset.tab = id;
        buttons.set(id, button);
      }
      if (tablist.children[i] !== button) tablist.insertBefore(button, tablist.children[i] ?? null);
      if (button.textContent !== section.dataset.label) button.textContent = section.dataset.label;
      button.title = section.dataset.title || '';
      if (section.dataset.tone) button.dataset.tone = section.dataset.tone;
      else delete button.dataset.tone;
      button.setAttribute('aria-selected', String(id === shown));
      button.tabIndex = id === shown ? 0 : -1;
    });
    for (const id of stale) {
      buttons.get(id).remove();
      buttons.delete(id);
    }
  }

  function paint() {
    const tabbed = dockedBottom() && content.tabs.length > 0;
    el.classList.toggle('tabbed', tabbed);
    if (!tabbed) {
      shown = null;
      shownKey = null;
      buttons.clear();
      tablist.replaceChildren();
      mount(actionsSlot);
      body.removeAttribute('role');
      body.removeAttribute('aria-labelledby');
      mount(body, content.sections, content.actions);
      return;
    }
    const before = shown;
    const top = body.scrollTop;
    shown = shownTab(tabIds(), activeTabs.get(label) ?? null);
    syncTabs();
    body.setAttribute('role', 'tabpanel');
    body.setAttribute('aria-labelledby', buttons.get(shown).id);
    mount(body, content.tabs.find((t) => t.dataset.tab === shown));
    mount(actionsSlot, content.actions);
    body.scrollTop = before === shown && shownKey === content.key ? top : 0;
    shownKey = content.key;
  }

  /** @param {string|null} id */
  function activate(id, { focus = false } = {}) {
    if (id === null) return;
    activeTabs.set(label, id);
    paint();
    const button = buttons.get(shown);
    button?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (focus) button?.focus();
  }

  function show(sections, { actions = null, focusTab = null, key = '' } = {}) {
    const flat = sections.flat(Infinity).filter((s) => s);
    content = { sections: flat, tabs: flat.filter((s) => s.dataset?.tab !== undefined), actions, key };
    if (focusTab !== null && tabIds().includes(focusTab)) return activate(focusTab);
    paint();
  }

  return {
    el,
    body,
    show,
    empty: (...children) => show([children]),
    step(step) {
      if (shown === null) return false;
      activate(stepTab(tabIds(), shown, step));
      return true;
    }
  };
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
