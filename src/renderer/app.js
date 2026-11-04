import { h, mount, stripAnsi, SPIN, spinner, typing, plural, keyButton, restoreLayout, toggleFold, toggleDock, dockedBottom, resizer } from './dom.js';
import { summarize, ago } from '/shared/status.js';
import { nextTheme } from '/shared/theme.js';
import { symbolKey } from '/shared/keys.js';
import * as dependenciesView from './views/dependencies.js';
import * as activityView from './views/activity.js';
import * as historyView from './views/history.js';
import * as logView from './views/log.js';
import * as healthView from './views/health.js';

const api = window.updeps;

/** The views, in the order of the menu; the number in front is their key. */
const VIEWS = {
  dependencies: { label: 'dependencies', module: dependenciesView },
  activity: { label: 'activity', module: activityView },
  history: { label: 'history', module: historyView },
  log: { label: 'log', module: logView },
  health: { label: 'health', module: healthView }
};
const NAMES = Object.keys(VIEWS);

/** CLI commands that start or stop the daemon, and how the statusline says they run. */
const DAEMON_COMMANDS = { start: 'starting', stop: 'stopping', restart: 'restarting', reset: 'resetting' };

/**
 * State shared with the views.
 * @typedef {object} App
 * @property {any} api
 * @property {any} ctx       from `api.context()`
 * @property {any} status    from `api.readStatus()`, null when the CLI is missing
 * @property {any} service   from `api.inspectService()`
 * @property {'system'|'dark'|'light'} theme  the window's theme choice
 * @property {boolean} busy  a CLI command started from the app is running
 * @property {string|null} busyCommand  its name (`retry`, `restart`, …)
 * @property {(args: string[]) => Promise<{ code: number|null, output: string }>} run
 * @property {(view: string, selector?: string) => void} go
 * @property {(withService?: boolean) => Promise<void>} refreshStatus
 */

/**
 * What a view's `create(root, app)` returns.
 * @typedef {object} View
 * @property {(what: string) => void} [onChanged]
 * @property {(selector: string) => void} [navigate]
 * @property {(e: KeyboardEvent) => boolean|void} [onKey]  true when it handled the key
 * @property {string} [hints]   key hints for the statusline
 * @property {() => void} [destroy]
 */

/** @type {App} */
const app = {
  api,
  ctx: null,
  status: null,
  service: null,
  theme: 'system',
  busy: false,
  busyCommand: null,
  run: (args) => api.run(args),
  go,
  refreshStatus
};

/** @type {View|null} */
let current = null;
let currentName = null;
let serviceCheckedAt = 0;

// The menu is drawn into its body; the handle that drags its width stays outside it.
const nav = h('div', { class: 'nav-body' });
document.getElementById('nav').append(nav, resizer(document.getElementById('nav'), { key: 'nav', edge: 'right', min: 150, max: () => 320 }));
const viewRoot = document.getElementById('view');
const drawer = document.getElementById('drawer');
const statusline = document.getElementById('statusline');

async function refreshStatus(withService = false) {
  if (!app.ctx?.cli) {
    app.status = null;
    app.service = null;
  } else {
    try {
      app.status = await api.readStatus();
    } catch {
      /* a half-written state file; the next change refreshes it */
    }
    if (withService || Date.now() - serviceCheckedAt > 60_000) {
      serviceCheckedAt = Date.now();
      app.service = await api.inspectService().catch(() => null);
    }
  }
  renderNav();
  renderStatusline();
}

function counts() {
  const failures = app.status?.openFailures.length || 0;
  const running = app.status?.activeRun ? 1 : 0;
  const queued = app.status?.queue.jobs.length || 0;
  return { failures, running, queued };
}

function renderNav() {
  const { failures, running, queued } = counts();
  mount(
    nav,
    h('div', { class: 'brand' }, h('span', { class: 'word' }, 'updeps'), h('span', { class: 'cursor', 'aria-hidden': 'true' })),
    h(
      'div',
      { class: 'links' },
      NAMES.map((name, i) => {
        const activity = name === 'activity';
        // A folded menu shows only the numbers; activity's then takes the colour of its badges.
        const tone = activity && failures ? ' fail' : activity && (running || queued) ? ' busy' : '';
        return h(
          'a',
          { href: `#${name}`, 'aria-current': name === currentName ? 'page' : null, title: VIEWS[name].label },
          h('span', { class: `num${tone}` }, String(i + 1)),
          h('span', { class: 'label' }, VIEWS[name].label),
          activity && (failures || running || queued)
            ? h(
                'span',
                { class: 'badges' },
                failures ? h('span', { class: 'fail', title: plural(failures, 'open failure') }, `✕${failures}`) : null,
                running || queued ? h('span', { class: 'busy', title: `${running} running, ${queued} queued` }, `◐${running + queued}`) : null
              )
            : null
        );
      })
    ),
    h(
      'div',
      { class: 'nav-foot' },
      h(
        'button',
        { type: 'button', class: 'theme', title: 'Cycle the theme: system, dark, light (t)', onclick: cycleTheme },
        h('span', { class: 'key' }, 't'),
        h('span', { class: 'label' }, `theme: ${app.theme}`)
      ),
      h(
        'button',
        { type: 'button', class: 'fold', title: 'Fold or unfold the menu ([)', onclick: () => toggleFold('nav') },
        h('span', { class: 'key' }, '['),
        h('span', { class: 'open' }, 'hide menu')
      )
    )
  );
}

async function cycleTheme() {
  app.theme = await api.setTheme(nextTheme(app.theme));
  renderNav();
}

function renderStatusline() {
  const s = summarize(app.status, app.service);
  const daemon = app.status?.daemon;
  const { failures, running, queued } = counts();
  let state;
  if (!app.status) state = h('span', { class: 'state stopped' }, '○ cli not found');
  else if (app.busy && DAEMON_COMMANDS[app.busyCommand]) state = h('span', { class: 'state busy' }, spinner(), ` ${DAEMON_COMMANDS[app.busyCommand]}`);
  else if (daemon?.running) state = h('span', { class: 'state running' }, `● running ${ago(daemon.startedAt).replace(' ago', '')}`);
  else state = h('span', { class: 'state stopped' }, '○ stopped');

  mount(
    statusline,
    state,
    daemon?.running ? h('span', null, plural(daemon.watchedRepos ?? 0, 'source')) : null,
    s.problem ? h('span', { class: 'fail' }, s.problem) : null,
    app.status ? h('span', { class: failures ? 'fail' : null }, failures ? `✕ ${plural(failures, 'failure')}` : '✓ no failures') : null,
    app.status && (running || queued) ? h('span', { class: 'busy' }, `◐ ${running} running · ${queued} queued`) : null,
    daemon?.running && daemon.stale
      ? h(
          'span',
          { class: 'stale' },
          'new updeps code',
          h('button', { onclick: () => app.run(['restart']), disabled: app.busy, title: 'Restart the daemon to load it' }, 'R restart')
        )
      : null,
    h('span', { class: 'hints' }, [current?.hints || '1–5 switch views', '[ ] panels', '\\ dock', 't theme', dockedBottom() && viewRoot.querySelector('.side-panel') ? ', . tabs' : null].filter(Boolean).join(' · ')),
    h('span', { class: 'version' }, app.ctx?.cli ? `updeps ${app.ctx.cli.version}` : 'updeps')
  );
}

function renderSetup() {
  current?.destroy?.();
  current = null;
  currentName = null;
  mount(
    viewRoot,
    h(
      'div',
      { class: 'setup stack' },
      h(
        'section',
        { class: 'box failing' },
        h('h3', { class: 'legend' }, 'connect the updeps cli'),
        h('p', null, 'this app works with the updeps cli installed on this computer, the same one the daemon runs.'),
        h('p', { class: 'error' }, app.ctx?.error || 'the updeps cli was not found.'),
        h('p', { class: 'dim' }, 'install it, then check again:'),
        h('pre', { class: 'output' }, 'npm install -g @sqaft/updeps-cli'),
        h('div', { class: 'row' }, keyButton(null, 'check again', () => api.relocate(), { cls: 'primary' }))
      )
    )
  );
  renderNav();
  renderStatusline();
}

/**
 * Shows a view, e.g. after a tray click.
 * @param {string} name
 * @param {string} [selector]
 */
function go(name, selector) {
  if (!app.ctx?.cli) return renderSetup();
  if (!VIEWS[name]) name = 'dependencies';
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  if (name !== currentName) {
    current?.destroy?.();
    currentName = name;
    viewRoot.replaceChildren();
    current = VIEWS[name].module.create(viewRoot, app);
    renderNav();
    renderStatusline();
  }
  if (selector) current?.navigate?.(selector);
}

async function onChanged(what) {
  if (what === 'context') {
    app.ctx = await api.context();
    await refreshStatus(true);
    if (!app.ctx.cli) renderSetup();
    else go(currentName || location.hash.slice(1) || 'dependencies');
    return;
  }
  if (what === 'state' || what === 'tick') await refreshStatus();
  current?.onChanged?.(what);
}

/** The latest CLI command and its output, at the bottom. The health view shows `doctor` itself. */
function onCommand(event) {
  if (event.type === 'start') {
    if (event.args[0] === 'doctor') return;
    app.busy = true;
    app.busyCommand = event.args[0];
    drawer.hidden = false;
    drawer.dataset.id = String(event.id);
    mount(
      drawer,
      h(
        'header',
        null,
        h('span', { class: 's-running', id: 'drawer-glyph' }, spinner()),
        h('span', { class: 'title' }, `$ updeps ${event.args.join(' ')}`),
        h('span', { class: 's-running', id: 'drawer-state' }, 'running'),
        keyButton('esc', 'close', closeDrawer, { cls: 'small' })
      ),
      h('pre', { id: 'drawer-output' })
    );
    renderStatusline();
    current?.onChanged?.('busy');
    return;
  }
  if (drawer.dataset.id !== String(event.id)) return;
  if (event.type === 'output') {
    const out = drawer.querySelector('#drawer-output');
    out.append(stripAnsi(event.text));
    out.scrollTop = out.scrollHeight;
  } else if (event.type === 'end') {
    app.busy = false;
    app.busyCommand = null;
    const ok = event.code === 0;
    const cls = ok ? 's-updated' : 's-failed';
    mount(drawer.querySelector('#drawer-glyph'), ok ? '✓' : '✕');
    drawer.querySelector('#drawer-glyph').className = cls;
    const state = drawer.querySelector('#drawer-state');
    state.className = cls;
    state.textContent = ok ? 'finished' : `failed (exit code ${event.code ?? 'none'})`;
    refreshStatus(true);
    current?.onChanged?.('busy');
  }
}

function closeDrawer() {
  drawer.hidden = true;
}

function onKey(e) {
  // `[`, `]` and `\` may need Option or AltGr to type; Alt does not make them another shortcut.
  const symbol = symbolKey(e, app.ctx?.platform);
  if (!symbol && (e.metaKey || e.ctrlKey || e.altKey)) {
    if (current?.onKey?.(e)) e.preventDefault();
    return;
  }
  if (current?.onKey?.(e)) {
    e.preventDefault();
    return;
  }
  if (e.key === 'Escape' && !drawer.hidden) {
    closeDrawer();
    return;
  }
  if (typing()) return;
  const index = Number(e.key) - 1;
  if (Number.isInteger(index) && NAMES[index]) {
    e.preventDefault();
    go(NAMES[index]);
  } else if (symbol === '[' || symbol === ']') {
    e.preventDefault();
    toggleFold(symbol === '[' ? 'nav' : 'side');
  } else if (symbol === '\\') {
    e.preventDefault();
    toggleDock();
  } else if (e.key === 't') {
    e.preventDefault();
    cycleTheme();
  } else if (e.key === 'R' && app.status?.daemon.running && !app.busy) {
    e.preventDefault();
    app.run(['restart']);
  }
}

// Turns every spinner on the page.
let frame = 0;
setInterval(() => {
  const spins = document.getElementsByClassName('spin');
  if (!spins.length) return;
  frame = (frame + 1) % SPIN.length;
  for (const el of spins) el.textContent = SPIN[frame];
}, 100);

async function boot() {
  restoreLayout();
  document.addEventListener('layoutchange', () => {
    current?.onChanged?.('layout');
    renderStatusline();
  });
  app.ctx = await api.context();
  app.theme = await api.readTheme();
  api.on('changed', onChanged);
  api.on('navigate', ({ view, selector }) => go(view, selector));
  api.on('command', onCommand);
  window.addEventListener('hashchange', () => go(location.hash.slice(1)));
  document.addEventListener('keydown', onKey);
  await Promise.all([document.fonts.load('500 12.5px "JetBrains Mono"'), document.fonts.load('700 13px "Martian Mono"')]).catch(() => {});
  await refreshStatus(true);
  if (!app.ctx.cli) renderSetup();
  else go(location.hash.slice(1) || 'dependencies');
}

boot();
