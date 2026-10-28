import { h, mount, stripAnsi } from './dom.js';
import { summarize, ago } from '/shared/status.js';
import * as graphView from './views/graph.js';
import * as activityView from './views/activity.js';
import * as historyView from './views/history.js';
import * as logView from './views/log.js';
import * as healthView from './views/health.js';

const api = window.updeps;

const VIEWS = {
  graph: { label: 'Dependencies', module: graphView },
  activity: { label: 'Activity', module: activityView },
  history: { label: 'History', module: historyView },
  log: { label: 'Log', module: logView },
  health: { label: 'Health check', module: healthView }
};

/**
 * State shared with the views.
 * @typedef {object} App
 * @property {any} api
 * @property {any} ctx       from `api.context()`
 * @property {any} status    from `api.readStatus()`, null when the CLI is missing
 * @property {any} service   from `api.inspectService()`
 * @property {(args: string[]) => Promise<{ code: number|null, output: string }>} run
 * @property {(view: string, selector?: string) => void} go
 * @property {(withService?: boolean) => Promise<void>} refreshStatus
 */

/** @type {App} */
const app = {
  api,
  ctx: null,
  status: null,
  service: null,
  run: (args) => api.run(args),
  go,
  refreshStatus
};

let current = null;
let currentName = null;
let serviceCheckedAt = 0;

const strip = document.getElementById('strip');
const rail = document.getElementById('rail');
const viewRoot = document.getElementById('view');
const drawer = document.getElementById('drawer');

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
  renderStrip();
  renderRail();
}

function renderStrip() {
  const s = summarize(app.status, app.service);
  const daemon = app.status?.daemon;
  const lamp = s.problem ? 'danger' : s.state === 'stopped' || s.state === 'unavailable' ? 'off' : s.state === 'busy' ? 'busy' : 'on';

  let text = s.daemon;
  if (daemon?.running) {
    text = `Daemon running, watching ${daemon.watchedRepos ?? 0} repos, started ${ago(daemon.startedAt)}`;
  }
  const failures = app.status?.openFailures.length || 0;
  const inFlight = (app.status?.queue.jobs.length || 0) + (app.status?.activeRun ? 1 : 0);

  mount(
    strip,
    h('div', { class: 'brand' }, h('img', { src: '/assets/icon.png', alt: '' }), 'updeps'),
    h(
      'div',
      { class: 'daemon' },
      h('span', { class: `lamp ${lamp}` }),
      h('span', null, s.problem || text),
      daemon?.stale ? h('span', { class: 'muted' }, '(code updated; restart to load it)') : null
    ),
    h(
      'div',
      { class: 'counts' },
      failures ? h('a', { class: 'count danger', href: '#activity' }, `⚠ ${failures} open failure${failures === 1 ? '' : 's'}`) : null,
      inFlight ? h('span', { class: 'count' }, `⧗ ${inFlight} in progress`) : null
    ),
    app.status
      ? h(
          'div',
          { class: 'actions' },
          daemon?.running
            ? h('button', { onclick: () => app.run(['restart']) }, 'Restart daemon')
            : h('button', { class: 'primary', onclick: () => app.run(['start']) }, 'Start daemon')
        )
      : null
  );
}

function renderRail() {
  const failures = app.status?.openFailures.length || 0;
  mount(
    rail,
    Object.entries(VIEWS).map(([name, view]) =>
      h(
        'a',
        { href: `#${name}`, 'aria-current': name === currentName ? 'page' : null },
        view.label,
        name === 'activity' && failures ? h('span', { class: 'badge' }, `⚠${failures}`) : null
      )
    ),
    h('div', { class: 'foot' }, app.ctx?.cli ? `updeps ${app.ctx.cli.version}` : null)
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
      { class: 'setup' },
      h('h1', null, 'Connect the updeps CLI'),
      h('p', null, 'This app works with the updeps CLI installed on this computer, the same one the daemon runs.'),
      h('p', { class: 'notice danger' }, app.ctx?.error || 'The updeps CLI was not found.'),
      h('p', null, 'Install it, then check again:'),
      h('pre', { class: 'output' }, 'npm install -g @sqaft/updeps-cli'),
      h('p', null, h('button', { class: 'primary', onclick: () => api.relocate() }, 'Check again'))
    )
  );
}

/**
 * Shows a view, e.g. after a tray click.
 * @param {string} name
 * @param {string} [selector]
 */
function go(name, selector) {
  if (!app.ctx?.cli) return renderSetup();
  if (!VIEWS[name]) name = 'graph';
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  if (name !== currentName) {
    current?.destroy?.();
    currentName = name;
    viewRoot.replaceChildren();
    current = VIEWS[name].module.create(viewRoot, app);
    renderRail();
  }
  if (selector) current?.navigate?.(selector);
}

async function onChanged(what) {
  if (what === 'context') {
    app.ctx = await api.context();
    await refreshStatus(true);
    if (!app.ctx.cli) renderSetup();
    else go(currentName || location.hash.slice(1) || 'graph');
    return;
  }
  if (what === 'state' || what === 'tick') await refreshStatus();
  current?.onChanged?.(what);
}

/** The latest CLI command and its output, shown at the bottom. */
function onCommand(event) {
  if (event.type === 'start') {
    drawer.hidden = false;
    drawer.dataset.id = String(event.id);
    mount(
      drawer,
      h(
        'header',
        null,
        h('span', { class: 'lamp busy' }),
        h('code', null, `updeps ${event.args.join(' ')}`),
        h('span', { class: 'muted', id: 'drawer-state' }, 'Running'),
        h('div', { class: 'actions' }, h('button', { onclick: () => (drawer.hidden = true) }, 'Close'))
      ),
      h('pre', { class: 'output', id: 'drawer-output' })
    );
    return;
  }
  if (drawer.dataset.id !== String(event.id)) return;
  if (event.type === 'output') {
    const out = drawer.querySelector('#drawer-output');
    out.append(stripAnsi(event.text));
    out.scrollTop = out.scrollHeight;
  } else if (event.type === 'end') {
    const ok = event.code === 0;
    drawer.querySelector('.lamp').className = `lamp ${ok ? 'on' : 'danger'}`;
    drawer.querySelector('#drawer-state').textContent = ok ? 'Finished' : `Failed (exit code ${event.code ?? 'none'})`;
    refreshStatus(true);
  }
}

async function boot() {
  app.ctx = await api.context();
  api.on('changed', onChanged);
  api.on('navigate', ({ view, selector }) => go(view, selector));
  api.on('command', onCommand);
  window.addEventListener('hashchange', () => go(location.hash.slice(1)));
  await document.fonts.load('600 13px Overpass').catch(() => {});
  await refreshStatus(true);
  if (!app.ctx.cli) renderSetup();
  else go(location.hash.slice(1) || 'graph');
}

boot();
