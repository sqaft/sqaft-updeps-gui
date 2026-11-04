// The dependency editor. Map draws every repo and link: each island of linked
// repos a band, one column per step from its sources. Tree shows the repos a
// push to one repo updates, as rows of links. Edits go to a draft that the CLI
// checks as you type and that is written to the config file only on save.
import { h, svg, mount, box, keyButton, glyph, LOOK, SPIN, typing, plural, tildify, sidePanel } from '../dom.js';
import { field } from '../fields.js';
import { ago, duration } from '/shared/status.js';
import { cascade, mapLayout, linkStates, lastPushes } from '/shared/tree.js';
import { baseName } from '/shared/graph.js';
import { describeChanges, removeLink, setDefaultsField, setLinkField, setRepoField, setRootField, sameJson } from '/shared/draft.js';

/** The settings of a link, by section: [key, label, kind]. The defaults have the same ones. */
const SECTIONS = [
  ['update', [['commands', 'commands', 'lines'], ['shell', 'shell', 'text'], ['commitMessage', 'commit msg', 'text'], ['commitPaths', 'files', 'lines']]],
  ['when', [['triggers', 'triggers', 'checks'], ['branches', 'branches', 'lines']]],
  ['after the update', [['push', 'push', 'bool'], ['squash', 'squash', 'bool'], ['coalesce', 'coalesce', 'bool']]],
  ['safety', [['dirtyPolicy', 'dirty work', 'enum'], ['commandTimeout', 'timeout (s)', 'number'], ['waitTimeoutSec', 'lock wait (s)', 'number'], ['staleLockSec', 'stale lock (s)', 'number']]]
];

const HINTS = {
  commitMessage: '{bumps} lists each source with its commit',
  commitPaths: 'globs, one per line; other files the commands change are left alone and reported',
  push: 'pushing also triggers the repos that depend on this one',
  coalesce: 'one run when several sources trigger it close together',
  dirtyPolicy: 'with uncommitted work: selective commits only the files to commit, skip leaves the repo alone',
  waitTimeoutSec: '0 waits as long as it takes'
};

/**
 * The map in px: the limits of a column's width (it fits its longest line),
 * the box height, the gaps between boxes and between columns, the room for
 * the column titles, for a band's title and between bands, and how wide a
 * character is (JetBrains Mono is 0.6em: 12px names, 11px status lines).
 */
const MAP = { minWidth: 120, maxWidth: 260, row: 46, gap: 10, columnGap: 44, head: 24, bandHead: 30, bandGap: 22, char: 7.2, subChar: 6.6 };

/** Which link line is drawn on top. */
const LINE_RANK = { '': 0, queued: 1, failed: 2, running: 3, linked: 4, selected: 5 };

/** Remembers whether the map or the tree shows. */
const MODE_KEY = 'dependencies.mode';
function storedMode() {
  try {
    return localStorage.getItem(MODE_KEY) === 'tree' ? 'tree' : 'map';
  } catch {
    return 'map';
  }
}

/**
 * @param {HTMLElement} root
 * @param {import('../app.js').App} app
 */
export function create(root, app) {
  const { api } = app;
  const cliDefaults = app.ctx.cli.defaults;
  const st = {
    fileError: null,
    exists: true,
    saved: null,
    draft: null,
    check: null,
    history: [],
    mode: storedMode(), // 'map' | 'tree'
    focus: null, // node id the tree starts from
    selection: null, // { type: 'node' | 'edge', id }; null shows the defaults
    connectFrom: null, // node id while picking its new dependent
    connectReturn: null, // the mode to go back to after picking it
    confirm: null, // 'node' | 'edge' while asking to remove it
    query: null, // search text while the search field is in use
    pick: 0, // highlighted suggestion
    safety: false,
    externalChange: false,
    saving: false,
    saveError: null,
    justSaved: false
  };
  const facts = new Map(); // node id -> inspectRepo() result

  const tabs = h('div', { class: 'tabs' });
  const search = h('input', {
    type: 'text',
    'aria-label': 'Find a repo',
    placeholder: 'repo name',
    spellcheck: false,
    onfocus: (e) => e.target.select(),
    oninput: (e) => {
      st.query = e.target.value;
      st.pick = 0;
      renderSuggestions();
    },
    onblur: () =>
      setTimeout(() => {
        st.query = null;
        renderSuggestions();
        renderToolbar();
      }, 150),
    onkeydown: onSearchKey
  });
  const suggestions = h('div', { class: 'suggestions', hidden: true, role: 'listbox' });
  const count = h('span', { class: 'count' });
  const content = h('div', { class: 'scroll' });
  const savebar = h('div', { class: 'savebar' });
  const { el: panel, body: inspector } = sidePanel({ label: 'Details' });

  root.append(
    h(
      'div',
      { class: 'screen' },
      h(
        'main',
        null,
        h(
          'div',
          { class: 'toolbar' },
          tabs,
          h('label', { class: 'prompt grow' }, h('span', { class: 'key' }, '›'), search, h('span', { class: 'hint' }, '/ search'), suggestions),
          count,
          keyButton(null, 'defaults', () => select(null), { title: 'Settings every link uses unless it sets its own' }),
          keyButton('a', 'add repo…', addRepo)
        ),
        content,
        savebar
      ),
      panel
    )
  );

  // ---- loading, checking, saving -------------------------------------------

  async function load() {
    const res = await api.readConfig();
    st.fileError = res.error;
    st.exists = res.exists;
    st.externalChange = false;
    if (res.error) {
      st.check = null;
      renderAll();
      return;
    }
    st.saved = res.raw ?? { repos: [] };
    st.draft = structuredClone(st.saved);
    await runCheck();
    renderInspector();
  }

  async function loadHistory() {
    st.history = await api.readHistory({ limit: 300 }).catch(() => []);
    renderContent();
  }

  let checkTimer = null;
  let checkSeq = 0;
  /** Checks the draft now (await it) or after a short pause while typing. */
  function runCheck({ later = false } = {}) {
    clearTimeout(checkTimer);
    if (later) {
      checkTimer = setTimeout(runCheck, 180);
      renderSavebar();
      return Promise.resolve();
    }
    const seq = ++checkSeq;
    return api.checkConfig(st.draft).then((check) => {
      if (seq !== checkSeq) return;
      st.check = check;
      if (!st.focus || !nodeById(st.focus)) st.focus = defaultFocus();
      renderToolbar();
      renderContent();
      renderSavebar();
    });
  }

  const dirty = () => st.draft !== null && !sameJson(st.draft, st.saved);
  const graph = () => st.check?.graph ?? { nodes: [], edges: [] };
  const nodeById = (id) => graph().nodes.find((n) => n.id === id) || null;
  const edgeById = (id) => graph().edges.find((e) => e.id === id) || null;
  const nameOf = (id) => nodeById(id)?.name ?? baseName(id);

  /** The source with the most dependents, so the first view shows a real cascade. */
  function defaultFocus() {
    const g = graph();
    const out = new Map();
    for (const e of g.edges) out.set(e.source, (out.get(e.source) || 0) + 1);
    return [...out].sort((a, b) => b[1] - a[1])[0]?.[0] ?? g.nodes[0]?.id ?? null;
  }

  /**
   * Applies a field edit to the draft. The inspector is not re-rendered, so
   * the field being typed in keeps its focus.
   * @param {(raw: object) => object} fn
   */
  function edit(fn) {
    st.draft = fn(st.draft);
    st.saveError = null;
    st.justSaved = false;
    runCheck({ later: true });
  }

  /** Applies a structural edit (needs the CLI's path resolution) and re-renders. */
  async function editStructure(op, args) {
    const res = await api.editConfig({ raw: st.draft, op, args });
    st.draft = res.raw;
    st.saveError = null;
    st.justSaved = false;
    await runCheck();
    return res;
  }

  async function save() {
    if (!dirty() || !st.check?.ok || st.saving) return;
    st.saving = true;
    const res = await api.writeConfig(st.draft);
    st.saving = false;
    if (res.saved) {
      st.saved = structuredClone(st.draft);
      st.exists = true;
      st.externalChange = false;
      st.saveError = null;
      st.justSaved = true;
    } else {
      st.saveError = res.error;
    }
    renderSavebar();
  }

  async function discard() {
    st.draft = structuredClone(st.saved);
    st.saveError = null;
    st.confirm = null;
    await runCheck();
    renderInspector();
  }

  // ---- selection and navigation ----------------------------------------------

  /** @param {{ type: 'node'|'edge', id: string }|null} selection */
  function select(selection) {
    st.selection = selection;
    st.confirm = null;
    renderContent();
    renderInspector();
  }

  function findSelection() {
    if (!st.selection) return null;
    return st.selection.type === 'node' ? nodeById(st.selection.id) : edgeById(st.selection.id);
  }

  /** Shows the tree of what a push to a repo updates. */
  function focusOn(id, { selectIt = true } = {}) {
    st.focus = id;
    st.query = null;
    search.value = nameOf(id);
    setMode('tree');
    if (selectIt) select({ type: 'node', id });
  }

  /**
   * A repo picked from the map or the search: connects it while adding a
   * dependent; else the map selects it and the tree focuses it.
   */
  function pickRepo(id) {
    if (st.connectFrom) {
      const target = nodeById(id);
      if (id === st.connectFrom || !target) return endConnect();
      return connectTo({ path: target.path });
    }
    if (st.mode !== 'map') return focusOn(id);
    select({ type: 'node', id });
    content.querySelector('.gnode[aria-selected="true"]')?.scrollIntoView({ block: 'center', inline: 'center' });
  }

  /** @param {'map'|'tree'} mode */
  function setMode(mode) {
    st.mode = mode;
    st.connectFrom = null;
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {}
    renderToolbar();
    renderContent();
  }

  // ---- adding and connecting ------------------------------------------------

  async function addRepo() {
    const path = await api.pickFolder('Add a repo');
    if (!path) return;
    const info = await api.inspectRepo(path);
    await editStructure('addRepo', { repo: { path, name: info.packageName } });
    focusOn(info.path);
  }

  /** Shows the map to pick the repo that depends on `fromId`. */
  function startConnect(fromId) {
    st.connectReturn = st.connectFrom ? st.connectReturn : st.mode;
    st.connectFrom = fromId;
    st.mode = 'map';
    renderToolbar();
    renderContent();
  }

  function endConnect() {
    st.connectFrom = null;
    st.mode = st.connectReturn || st.mode;
    renderToolbar();
    renderContent();
  }

  async function connectToFolder() {
    const path = await api.pickFolder('Choose the repo that depends on it');
    if (path) await connectTo({ path });
  }

  /** Links the repo being connected from to `target`. */
  async function connectTo(target) {
    const from = nodeById(st.connectFrom);
    st.connectFrom = null;
    if (!from) return endConnect();
    // A repo that only depended on others so far becomes a source; its package name comes from its manifest.
    const name = from.isSource ? undefined : (await api.inspectRepo(from.path)).packageName;
    const res = await editStructure('connect', { source: { path: from.path, name }, target });
    if (st.connectReturn === 'tree') st.focus = from.id;
    st.mode = st.connectReturn || st.mode;
    renderToolbar();
    select({ type: 'edge', id: `${res.repoIndex}:${res.packageIndex}` });
  }

  function removeSelected() {
    const sel = findSelection();
    if (!sel) return;
    if (st.selection.type === 'edge') {
      st.draft = removeLink(st.draft, sel.repoIndex, sel.packageIndex);
      st.selection = { type: 'node', id: sel.source };
      st.confirm = null;
      runCheck().then(renderInspector);
    } else {
      editStructure('removeRepo', { id: sel.id }).then(() => {
        if (st.focus === sel.id) st.focus = defaultFocus();
        select(st.focus ? { type: 'node', id: st.focus } : null);
      });
    }
  }

  function askRemove() {
    if (!findSelection()) return;
    st.confirm = st.selection.type;
    renderInspector();
  }

  // ---- what the daemon does --------------------------------------------------

  const states = () => linkStates(graph(), app.status, st.history);

  /** The link into a repo whose state its map box shows: a running, failed or queued one first, else the latest. */
  function leadInto(id, ls) {
    const into = graph().edges.filter((e) => e.target === id);
    for (const kind of ['running', 'failed', 'queued']) {
      const e = into.find((x) => ls.get(x.id)?.kind === kind);
      if (e) return e;
    }
    let lead = into[0] ?? null;
    for (const e of into) if ((ls.get(e.id)?.ts ?? -1) > (ls.get(lead.id)?.ts ?? -1)) lead = e;
    return lead;
  }

  /** The open failure on a link, if any. */
  function failureOf(edge) {
    const source = nameOf(edge.source);
    const onTarget = (app.status?.openFailures || []).filter((f) => f.targetPath === edge.target);
    return onTarget.find((f) => f.source === source) || (onTarget.length === 1 ? onTarget[0] : null);
  }

  function when(state) {
    if (!state?.ts) return '';
    return state.kind === 'running' ? duration(Date.now() - state.ts) : ago(state.ts);
  }

  // ---- effective settings ------------------------------------------------------

  function cliDefault(key) {
    return cliDefaults[key];
  }

  /** What a link inherits for a key, and from where. */
  function inheritedFor(edge, key) {
    const repo = st.draft.repos?.[edge.repoIndex];
    if ((key === 'triggers' || key === 'branches') && Array.isArray(repo?.[key])) return { value: repo[key], from: nameOf(edge.source) };
    return defaultsFor(key);
  }

  function defaultsFor(key) {
    const own = st.draft.defaults?.[key];
    return own !== undefined ? { value: own, from: 'defaults' } : { value: cliDefault(key), from: 'built-in' };
  }

  const linkOf = (edge) => st.draft.repos?.[edge.repoIndex]?.packages?.[edge.packageIndex] ?? {};

  function effective(edge, key) {
    const own = linkOf(edge)[key];
    return own !== undefined ? own : inheritedFor(edge, key).value;
  }

  function show(key) {
    if (key === 'shell') return (v) => v || `${app.ctx.platform === 'win32' ? 'cmd.exe' : 'sh'} (platform default)`;
    if (key === 'branches') return (v) => (Array.isArray(v) && v.length ? v.join('\n') : "the source's default branch");
    if (key === 'commitPaths') return (v) => (Array.isArray(v) && v.length > 4 ? `${v.slice(0, 4).join(' ')} +${v.length - 4}` : (v || []).join(' '));
    return undefined;
  }

  function options(key) {
    if (key === 'triggers') return app.ctx.cli.triggers;
    if (key === 'dirtyPolicy') return app.ctx.cli.dirtyPolicies;
    return undefined;
  }

  // ---- toolbar -------------------------------------------------------------------

  function renderToolbar() {
    const tab = (label, on, onclick, title) => h('button', { 'aria-pressed': String(on), onclick, title }, `[${label}]`);
    mount(
      tabs,
      tab('map', st.mode === 'map', () => setMode('map'), 'Every repo and its links (m)'),
      tab('tree', st.mode === 'tree', () => setMode('tree'), 'What a push to one repo updates (m)')
    );
    if (document.activeElement !== search) search.value = st.focus ? nameOf(st.focus) : '';
    const g = graph();
    count.textContent = `${plural(g.nodes.length, 'repo')} · ${plural(g.edges.length, 'link')}`;
  }

  function matches() {
    const q = (st.query ?? '').trim().toLowerCase();
    if (!q) return [];
    return graph().nodes.filter((n) => n.name.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)).slice(0, 10);
  }

  function renderSuggestions() {
    const list = matches();
    suggestions.hidden = st.query === null || !st.query.trim();
    if (suggestions.hidden) return;
    st.pick = Math.min(st.pick, Math.max(0, list.length - 1));
    mount(
      suggestions,
      list.length
        ? list.map((n, i) =>
            h(
              'button',
              {
                type: 'button',
                role: 'option',
                'aria-selected': String(i === st.pick),
                onmousedown: (e) => {
                  e.preventDefault();
                  choose(n.id);
                }
              },
              n.name
            )
          )
        : h('span', { class: 'empty' }, 'no repo matches')
    );
  }

  function choose(id) {
    search.blur();
    st.query = null;
    renderSuggestions();
    pickRepo(id);
  }

  function onSearchKey(e) {
    const list = matches();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      st.pick = Math.max(0, Math.min(list.length - 1, st.pick + (e.key === 'ArrowDown' ? 1 : -1)));
      renderSuggestions();
    } else if (e.key === 'Enter' && list[st.pick]) {
      e.preventDefault();
      choose(list[st.pick].id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      search.blur();
    }
  }

  // ---- content: map and tree ---------------------------------------------------

  function renderContent() {
    if (st.fileError) {
      mount(content, h('p', { class: 'empty' }, 'the config file cannot be read; see the details on the right.'));
      return;
    }
    const g = graph();
    if (!g.nodes.length) {
      mount(
        content,
        box(
          st.exists ? 'no repos yet' : 'no config yet',
          'placeholder',
          h('p', null, 'add the repo of a package, then the repos that depend on it.'),
          h('div', { class: 'row' }, keyButton('a', 'add repo…', addRepo, { cls: 'primary' }))
        )
      );
      return;
    }
    const scrollTop = content.scrollTop;
    // A wide map scrolls sideways in its own box and keeps its place.
    const scrollLeft = content.querySelector('.graph-scroll')?.scrollLeft ?? 0;
    mount(content, st.mode === 'map' ? mapView() : treeView());
    content.scrollTop = scrollTop;
    const wide = content.querySelector('.graph-scroll');
    if (wide) wide.scrollLeft = scrollLeft;
  }

  function treeView() {
    const g = graph();
    const focus = st.focus;
    const ls = states();
    const tree = cascade(g, focus);
    const pushes = lastPushes(app.status, st.history);

    const tally = new Map();
    for (const r of tree.rows) {
      if (r.repeat) continue;
      const kind = ls.get(r.edge.id)?.kind;
      if (kind) tally.set(kind, (tally.get(kind) || 0) + 1);
    }

    return h(
      'div',
      { class: 'stack' },
      treeParts(focus, ls, pushes, tree),
      h(
        'div',
        { class: 'tallies' },
        h(
          'span',
          null,
          tree.count
            ? `a push to ${nameOf(focus)} updates ${plural(tree.count, 'repo')} in ${plural(tree.depth, 'step')}`
            : `a push to ${nameOf(focus)} updates nothing yet`
        ),
        ['updated', 'failed', 'running', 'queued'].filter((k) => tally.get(k)).map((k) => h('span', { class: LOOK[k].cls }, `${tally.get(k)} ${k}`))
      )
    );
  }

  function treeParts(focus, ls, pushes, tree) {
    const g = graph();
    const upstream = g.edges.filter((e) => e.target === focus);
    const focusNode = nodeById(focus);
    const push = pushes.get(focusNode?.name);
    const headSelected = st.selection?.type === 'node' && st.selection.id === focus;

    const rows = tree.rows.map((r) => {
      const state = ls.get(r.edge.id);
      const look = LOOK[state?.kind || 'none'];
      const commands = effective(r.edge, 'commands') ?? [];
      const cmd = String(commands[0] ?? '').split(/\s+/).slice(0, 2).join(' ') + (commands.length > 1 ? ` +${commands.length - 1}` : '');
      const own = Object.keys(linkOf(r.edge)).some((k) => k !== 'path' && k !== 'name');
      const selected = st.selection?.type === 'edge' && st.selection.id === r.edge.id;
      return h(
        'button',
        {
          class: `table-row${r.repeat ? ' repeat' : ''}${state?.kind === 'running' ? ' running' : ''}`,
          'aria-selected': String(selected),
          title: r.repeat ? 'Listed above with its own dependents' : null,
          onclick: () => select({ type: 'edge', id: r.edge.id }),
          ondblclick: () => focusOn(r.edge.target)
        },
        h('span', { class: 'name' }, h('span', { class: 'branch' }, r.prefix), nameOf(r.edge.target), r.repeat ? ' ↑' : ''),
        h('span', { class: `status ${look.cls}` }, glyph(state?.kind || 'none'), ` ${look.word}`),
        h('span', { class: 'when' }, when(state)),
        h('span', { class: 'runs' }, `${cmd}${effective(r.edge, 'push') ? ' · push' : ''}${own ? '*' : ''}`)
      );
    });

    return [
      h(
        'div',
        { class: 'row upstream' },
        h('span', null, upstream.length ? 'depends on' : 'depends on nothing'),
        upstream.map((e) =>
          h(
            'button',
            { class: 'btn', onclick: () => focusOn(e.source), title: `Focus on ${nameOf(e.source)}` },
            nameOf(e.source),
            pushes.get(nameOf(e.source)) ? h('span', { class: 'dim' }, ago(pushes.get(nameOf(e.source)).ts).replace(' ago', '')) : null
          )
        )
      ),
      h(
        'div',
        { class: 'table', 'aria-label': `Repos a push to ${nameOf(focus)} updates` },
        h('div', { class: 'table-head' }, h('span', null, 'repo'), h('span', null, 'status'), h('span', null, 'when'), h('span', null, 'runs')),
        h(
          'button',
          { class: 'table-row head', 'aria-selected': String(headSelected), onclick: () => select({ type: 'node', id: focus }) },
          h('span', { class: 'name' }, nameOf(focus)),
          h('span', { class: 'sub' }, focusNode?.isSource ? 'pushed' : 'not a source'),
          h('span', { class: 'sub' }, push ? ago(push.ts) : ''),
          h('span', { class: 'sub' }, push?.sha ? push.sha : '')
        ),
        rows,
        rows.length ? null : h('p', { class: 'empty' }, 'no dependents yet. select the repo above and add one.')
      )
    ];
  }

  /** What j/k walk through in the map: every repo, band by band, column by column. */
  let mapOrder = [];

  function mapView() {
    const g = graph();
    const ls = states();
    const pushes = lastPushes(app.status, st.history);
    const from = st.connectFrom;
    const layout = mapLayout(g, { row: MAP.row, gap: MAP.gap, head: MAP.bandHead, bandGap: MAP.bandGap });
    const selEdge = st.selection?.type === 'edge' ? edgeById(st.selection.id) : null;
    const selNode = st.selection?.type === 'node' ? st.selection.id : null;
    const placed = g.nodes.filter((n) => layout.column.has(n.id));
    const { band, column, y } = layout;
    mapOrder = placed.map((n) => n.id).sort((a, b) => band.get(a) - band.get(b) || column.get(a) - column.get(b) || y.get(a) - y.get(b));

    // A band named after a scope leaves it out of its repos' names; the tooltip has the full name.
    const label = (id) => {
      const scope = layout.bands[band.get(id)].label;
      const prefix = scope && /^@[^/]+$/.test(scope) ? `${scope}/` : null;
      return prefix && nameOf(id).startsWith(prefix) ? nameOf(id).slice(prefix.length) : nameOf(id);
    };
    /** The second line of a box: the state of the link into it, or a source's last push. */
    const line = new Map(
      placed.map((node) => {
        const lead = leadInto(node.id, ls);
        if (!lead) {
          const push = pushes.get(node.name);
          return [node.id, { kind: null, text: push ? `pushed ${ago(push.ts)}` : 'no push seen' }];
        }
        const state = ls.get(lead.id);
        const kind = state?.kind || 'none';
        return [node.id, { kind, text: `${LOOK[kind].word}${when(state) ? ` ${when(state)}` : ''}` }];
      })
    );

    // A column is as wide as its longest name or status line, within limits.
    const need = (id) => Math.max(label(id).length * MAP.char, (line.get(id).text.length + (line.get(id).kind ? 2 : 0)) * MAP.subChar);
    const colLeft = [];
    const colWidth = [];
    let x = 0;
    layout.columns.forEach((ids, c) => {
      colLeft[c] = x;
      colWidth[c] = Math.max(MAP.minWidth, Math.min(MAP.maxWidth, Math.ceil(Math.max(0, ...ids.map(need))) + 20));
      x += colWidth[c] + MAP.columnGap;
    });
    const width = Math.max(0, x - MAP.columnGap);
    const height = MAP.head + layout.height;
    const left = (id) => colLeft[column.get(id)];
    const right = (id) => left(id) + colWidth[column.get(id)];
    const mid = (id) => MAP.head + y.get(id);

    const titles = layout.columns.map((ids, c) => {
      const linked = ids.filter((id) => layout.bands[band.get(id)].label !== null).length;
      if (!linked) return null;
      return h('span', { class: 'gtitle', style: `left: ${colLeft[c]}px; width: ${colWidth[c]}px` }, `${c ? `step ${c}` : 'sources'} · ${linked}`);
    });
    const bands = layout.bands.map((b) =>
      h('span', { class: 'gband', style: `top: ${MAP.head + b.top}px; width: ${width}px` }, `${b.label ?? 'no links'} · ${plural(b.size, 'repo')}`)
    );

    const lines = g.edges
      .filter((e) => column.has(e.source) && column.has(e.target))
      .map((e) => {
        const a = column.get(e.source);
        const b = column.get(e.target);
        const y1 = mid(e.source);
        const y2 = mid(e.target);
        let d;
        let head;
        if (b > a) {
          const x1 = right(e.source);
          const x2 = left(e.target);
          const m = (x1 + x2) / 2;
          d = `M${x1} ${y1}C${m} ${y1} ${m} ${y2} ${x2} ${y2}`;
          head = `M${x2} ${y2}l-7 -3.5v7z`;
        } else if (a === b) {
          // Within a column the line loops out on the right, further out the further it goes, so loops stay apart.
          const x1 = right(e.source);
          const out = x1 + 10 + Math.min(20, Math.abs(y2 - y1) / 12);
          d = `M${x1} ${y1}C${out} ${y1} ${out} ${y2} ${x1} ${y2}`;
          head = `M${x1} ${y2}l7 -3.5v7z`;
        } else {
          // Back to an earlier column it leaves from the left.
          const x1 = left(e.source);
          const x2 = right(e.target);
          d = `M${x1} ${y1}C${x1 - 22} ${y1} ${x2 + 22} ${y2} ${x2} ${y2}`;
          head = `M${x2} ${y2}l7 -3.5v7z`;
        }
        const kind = ls.get(e.id)?.kind;
        const state = ['running', 'failed', 'queued'].includes(kind) ? kind : '';
        // The links of the selected repo stand out; a state keeps its colour.
        const linked = selNode && (e.source === selNode || e.target === selNode) ? 'linked' : '';
        const look = e.id === selEdge?.id ? 'selected' : linked || state;
        // A negative delay keeps the running line flowing in step across re-renders.
        const path = svg('path', { class: 'line', d, style: state === 'running' ? `animation-delay: -${Date.now() % 800}ms` : null });
        return {
          rank: LINE_RANK[look],
          el: svg(
            'g',
            { class: ['gedge', state, linked, e.id === selEdge?.id ? 'selected' : ''].filter(Boolean).join(' ') },
            path,
            svg('path', { class: 'head', d: head }),
            svg(
              'path',
              { class: 'hit', d, onclick: () => !from && select({ type: 'edge', id: e.id }) },
              svg('title', null, `${nameOf(e.source)} → ${nameOf(e.target)}`)
            )
          )
        };
      })
      .sort((p, q) => p.rank - q.rank)
      .map((p) => p.el);

    const boxes = placed.map((node) => {
      const id = node.id;
      const { kind, text } = line.get(id);
      const state = ['running', 'failed', 'queued'].includes(kind) ? ` ${kind}` : '';
      const end = selEdge && (selEdge.source === id || selEdge.target === id) ? ' end' : '';
      return h(
        'button',
        {
          class: `gnode${state}${end}${id === from ? ' from' : ''}`,
          style: `left: ${left(id)}px; top: ${mid(id) - MAP.row / 2}px; width: ${colWidth[column.get(id)]}px; height: ${MAP.row}px`,
          'aria-selected': String(!from && selNode === id),
          title: from ? nameOf(id) : `${nameOf(id)}: double-click to open it in the tree`,
          onclick: () => (from ? pickRepo(id) : select({ type: 'node', id })),
          ondblclick: () => !from && focusOn(id)
        },
        h('span', { class: 'name' }, label(id)),
        kind ? h('span', { class: `status ${LOOK[kind].cls}` }, glyph(kind), ` ${text}`) : h('span', { class: 'sub' }, text)
      );
    });

    return h(
      'div',
      { class: 'stack' },
      from
        ? h(
            'div',
            { class: 'notice row' },
            h('span', { class: 'grow' }, 'pick the repo that depends on ', h('strong', null, nameOf(from)), ', or choose its folder'),
            keyButton('f', 'choose folder…', connectToFolder),
            keyButton('esc', 'cancel', endConnect)
          )
        : null,
      h(
        'div',
        { class: 'graph-scroll' },
        h(
          'div',
          { class: 'graph', style: `width: ${width}px; height: ${height}px`, role: 'group', 'aria-label': 'Every repo and its links' },
          titles,
          bands,
          svg('svg', { class: 'gedges', width, height, 'aria-hidden': 'true' }, lines),
          boxes
        )
      ),
      h(
        'div',
        { class: 'graph-legend' },
        ['updated', 'running', 'queued', 'failed'].map((k) => h('span', { class: LOOK[k].cls }, `${LOOK[k].glyph ?? SPIN[0]} ${LOOK[k].word}`)),
        h('span', { class: 'grow' }, 'click a repo or a line to edit it · double-click or enter to open a repo in the tree')
      )
    );
  }

  // ---- save bar ---------------------------------------------------------------

  function renderSavebar() {
    const check = st.check;
    const changes = st.draft && st.saved ? describeChanges(st.saved, st.draft) : [];
    const isDirty = dirty();
    const messages = [];
    if (st.externalChange) {
      messages.push(
        h('span', { class: 'warning' }, 'the config file changed on disk. ', h('button', { class: 'link', onclick: load }, 'load it'), ' (drops your changes) or keep editing and save over it.')
      );
    }
    if (st.saveError) messages.push(h('span', { class: 'error' }, st.saveError));
    for (const w of check?.warnings || []) messages.push(h('span', { class: 'warning' }, `${w} (ignored)`));
    for (const c of check?.cycles || []) messages.push(h('span', { class: 'warning' }, `loop: ${c.join(' → ')} · it repeats only if push is on along the way`));

    const title = isDirty
      ? h('span', { class: 'warning' }, `-- ${plural(changes.length || 1, 'unsaved change')} --`)
      : st.justSaved
        ? h('span', { class: 'ok' }, '-- saved --')
        : h('span', { class: 'dim' }, st.exists ? 'no unsaved changes' : 'not saved yet');
    const detail = isDirty
      ? `${changes[0] ?? 'changes'}${changes.length > 1 ? ` and ${changes.length - 1} more` : ''}`
      : st.justSaved
        ? 'the daemon picks it up right away'
        : tildify(app.ctx.cli.paths?.configFile);
    mount(
      savebar,
      title,
      h('span', { class: 'detail', title: changes.join('\n') || null }, detail),
      check && !check.ok
        ? h('span', { class: 'error' }, `config error: ${check.error.replace(/^Config error — /, '')}`)
        : check
          ? h('span', { class: 'ok' }, 'config ok')
          : null,
      keyButton(null, 'discard', discard, { disabled: !isDirty }),
      keyButton('s', 'save', save, { cls: 'primary', disabled: !isDirty || !check?.ok || st.saving }),
      messages.length ? h('div', { class: 'messages' }, messages) : null
    );
  }

  // ---- inspector ----------------------------------------------------------------

  /**
   * The setting boxes of a link or of the defaults; safety stays folded behind a summary.
   * @param {(key: string, label: string, kind: string) => HTMLElement} fieldFor
   * @param {(key: string) => unknown} valueOf  the value that applies, for the safety summary
   * @param {{ defaults?: boolean }} [opts]
   */
  function sectionBoxes(fieldFor, valueOf, { defaults = false } = {}) {
    return SECTIONS.map(([title, keys]) => {
      if (title === 'safety' && !st.safety) return null;
      const fields = keys.map(([key, label, kind]) => fieldFor(key, label, kind));
      if (defaults && title === 'when') {
        fields.push(
          field({
            label: 'debounce (ms)',
            kind: 'number',
            value: st.draft.defaults?.debounceMs,
            inherited: cliDefault('debounceMs'),
            from: 'built-in',
            hint: 'pushes within this window run once',
            onChange: (v) => edit((r) => setDefaultsField(r, 'debounceMs', v))
          })
        );
      }
      return box(title, null, fields);
    }).concat(
      h(
        'button',
        {
          class: 'btn',
          onclick: () => {
            st.safety = !st.safety;
            renderInspector();
          }
        },
        st.safety ? '[-] safety' : '[+] safety',
        st.safety
          ? null
          : h('span', { class: 'dim' }, `${valueOf('dirtyPolicy')} · timeout ${valueOf('commandTimeout')}s · lock wait ${valueOf('waitTimeoutSec')}s`)
      )
    );
  }

  function renderDefaults() {
    const g = graph();
    mount(
      inspector,
      box(
        'defaults',
        null,
        h('p', { class: 'muted' }, `every link uses these unless it sets its own. ${plural(g.nodes.length, 'repo')}, ${plural(g.edges.length, 'link')}.`),
        field({
          label: 'notifications',
          kind: 'bool',
          value: st.draft.notifications,
          inherited: true,
          from: 'built-in',
          hint: 'one desktop notification per push, when its updates finish',
          onChange: (v) => edit((r) => setRootField(r, 'notifications', v))
        })
      ),
      sectionBoxes(
        (key, label, kind) =>
          field({
            label,
            kind,
            value: st.draft.defaults?.[key],
            inherited: cliDefault(key),
            from: 'built-in',
            show: show(key),
            options: options(key),
            hint: key === 'commands' ? 'one per line, run in order. {pkgs} is the packages to update' : HINTS[key],
            onChange: (v) => edit((r) => setDefaultsField(r, key, v))
          }),
        (key) => defaultsFor(key).value,
        { defaults: true }
      )
    );
  }

  function repoFacts(node) {
    const list = h('dl', { class: 'facts' });
    const fill = (info) => {
      const rows = [];
      if (!info) rows.push(['folder', 'checking…']);
      else if (!info.exists) rows.push(['folder', h('span', { class: 'error' }, 'not found')]);
      else if (!info.isGit) rows.push(['folder', 'not a git repo']);
      else {
        rows.push(['branch', info.defaultBranch || 'unknown']);
        rows.push(['remote', info.origin || h('span', { class: 'error' }, 'no origin remote')]);
      }
      if (info?.packageName) rows.push(['package', `${info.packageName} (${info.manifest})`]);
      const push = lastPushes(app.status, st.history).get(node.name);
      if (node.isSource) rows.push(['pushed', push ? `${ago(push.ts)}${push.sha ? ` · ${push.sha}` : ''}` : 'not since the history starts']);
      mount(list, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
    };
    fill(facts.get(node.id));
    api.inspectRepo(node.path).then((info) => {
      facts.set(node.id, info);
      if (list.isConnected) fill(info);
    });
    return list;
  }

  function linkList(edges, nameFor, ls) {
    return h(
      'div',
      { class: 'links-list' },
      edges.map((e) => {
        const kind = ls.get(e.id)?.kind || 'none';
        return h(
          'button',
          { onclick: () => select({ type: 'edge', id: e.id }) },
          h('span', { class: `glyph ${LOOK[kind].cls}` }, glyph(kind)),
          nameFor(e)
        );
      })
    );
  }

  function confirmRow(text, label) {
    return h(
      'div',
      { class: 'confirm' },
      h('span', null, text),
      keyButton('y', label, removeSelected, { cls: 'danger' }),
      keyButton('n', 'keep', () => {
        st.confirm = null;
        renderInspector();
      })
    );
  }

  function renderNode(node) {
    const g = graph();
    const ls = states();
    const dependents = g.edges.filter((e) => e.source === node.id);
    const sources = g.edges.filter((e) => e.target === node.id);
    const repo = node.repoIndex !== null ? st.draft.repos[node.repoIndex] : null;
    const links = dependents.length + sources.length;

    mount(
      inspector,
      box(
        'repo',
        null,
        h('span', { class: 'title' }, node.name),
        h('span', { class: 'dim' }, node.path),
        repoFacts(node),
        node.id !== st.focus || st.mode !== 'tree' ? h('div', { class: 'row' }, keyButton('⏎', `focus ${node.name}`, () => focusOn(node.id))) : null
      ),
      repo
        ? box(
            'as a source',
            null,
            field({
              label: 'package',
              kind: 'text',
              value: repo.name,
              inherits: false,
              placeholder: baseName(node.id),
              hint: "its name in the package manager: {pkgs} in its dependents' commands",
              onChange: (v) => edit((r) => setRepoField(r, node.repoIndex, 'name', v))
            }),
            field({
              label: 'branches',
              kind: 'lines',
              value: repo.branches,
              inherited: defaultsFor('branches').value,
              from: defaultsFor('branches').from,
              show: (v) => (Array.isArray(v) && v.length ? v.join('\n') : 'its default branch'),
              hint: 'pushes to these branches trigger updates, one per line',
              onChange: (v) => edit((r) => setRepoField(r, node.repoIndex, 'branches', v))
            }),
            field({
              label: 'triggers',
              kind: 'checks',
              options: app.ctx.cli.triggers,
              value: repo.triggers,
              inherited: defaultsFor('triggers').value,
              from: defaultsFor('triggers').from,
              onChange: (v) => edit((r) => setRepoField(r, node.repoIndex, 'triggers', v))
            })
          )
        : null,
      box(
        `dependents · ${dependents.length}`,
        null,
        dependents.length ? linkList(dependents, (e) => nameOf(e.target), ls) : h('p', { class: 'empty' }, 'none yet. add one to update it after every push here.'),
        h('div', { class: 'row' }, keyButton('+', 'add dependent…', () => startConnect(node.id)))
      ),
      sources.length ? box(`depends on · ${sources.length}`, null, linkList(sources, (e) => nameOf(e.source), ls)) : null,
      st.confirm === 'node'
        ? confirmRow(
            `remove ${node.name}? ${links ? `its ${plural(links, 'link')} go too. ` : ''}nothing changes on disk until you save.`,
            'remove'
          )
        : h('button', { class: 'plain remove', onclick: askRemove }, h('span', { class: 'key' }, 'x'), ' remove repo')
    );
  }

  function renderEdge(edge) {
    const ls = states();
    const state = ls.get(edge.id);
    const failure = failureOf(edge);
    const pkg = linkOf(edge);
    const pkgs = st.check.pkgs?.[edge.target] || [];
    const commands = (effective(edge, 'commands') ?? []).map((c) => `$ ${String(c).replace('{pkgs}', pkgs.join(' '))}`).join('\n');
    const retrying = app.busy && app.busyCommand === 'retry';
    const { repoIndex, packageIndex } = edge;

    let live = null;
    if (failure) {
      live = box(
        `failed ${ago(failure.lastSeen)}${failure.count > 1 ? ` · ${failure.count}×` : ''}`,
        'failing tinted',
        h('span', null, failure.message),
        failure.errorTail ? h('pre', { class: 'output' }, failure.errorTail) : null,
        h(
          'div',
          { class: 'row' },
          keyButton('r', retrying ? 'retrying…' : 'retry', () => app.run(['retry', failure.target]), { cls: 'primary', disabled: app.busy }),
          keyButton('o', 'show run', () => app.go('history', failure.target))
        )
      );
    } else if (state?.kind === 'running') {
      live = box(['running ', duration(Date.now() - state.ts)], 'busy tinted', h('pre', { class: 'muted' }, commands), h('div', { class: 'row' }, keyButton('2', 'follow it in activity', () => app.go('activity'))));
    } else if (state?.kind === 'queued') {
      live = h('p', { class: 'notice' }, `· queued: it runs after the update in progress`);
    }

    mount(
      inspector,
      box(
        'link',
        null,
        h('span', { class: 'title' }, nameOf(edge.source), h('span', { class: 'dim' }, ' → '), nameOf(edge.target)),
        h('span', { class: 'dim' }, pkg.path),
        field({
          label: 'label',
          kind: 'text',
          value: pkg.name,
          inherits: false,
          placeholder: baseName(pkg.path || ''),
          hint: 'shown in notifications and the history',
          onChange: (v) => edit((r) => setLinkField(r, repoIndex, packageIndex, 'name', v))
        }),
        h('div', { class: 'row' }, keyButton('⏎', `focus ${nameOf(edge.target)}`, () => focusOn(edge.target)))
      ),
      live,
      sectionBoxes((key, label, kind) => {
        const inherited = inheritedFor(edge, key);
        return field({
          label,
          kind,
          value: pkg[key],
          inherited: inherited.value,
          from: inherited.from,
          show: show(key),
          options: options(key),
          hint:
            key === 'commands'
              ? `one per line, run in order. ${pkgs.length ? `{pkgs} = ${pkgs.join(' ')}` : '{pkgs} is the packages to update'}`
              : key === 'branches'
                ? 'source branches to react to, one per line'
                : HINTS[key],
          onChange: (v) => edit((r) => setLinkField(r, repoIndex, packageIndex, key, v))
        });
      }, (key) => effective(edge, key)),
      st.confirm === 'edge'
        ? confirmRow('remove this link? nothing changes on disk until you save.', 'remove')
        : h('button', { class: 'plain remove', onclick: askRemove }, h('span', { class: 'key' }, 'x'), ' remove link')
    );
  }

  function renderInspector() {
    if (st.fileError) {
      mount(
        inspector,
        box(
          'the config file cannot be read',
          'failing',
          h('p', { class: 'error' }, st.fileError),
          h('p', null, 'fix it in an editor; this view reloads when the file changes.'),
          h('div', { class: 'row' }, keyButton(null, 'show the file', () => api.reveal('config')))
        )
      );
      return;
    }
    if (!st.draft || !st.check) return;
    const sel = findSelection();
    if (!sel) return renderDefaults();
    if (st.selection.type === 'node') return renderNode(sel);
    return renderEdge(sel);
  }

  /** Re-renders the inspector unless a field in it is being edited. */
  function refreshInspector() {
    if (!inspector.contains(document.activeElement) || !typing()) renderInspector();
  }

  function renderAll() {
    renderToolbar();
    renderContent();
    renderSavebar();
    renderInspector();
  }

  // ---- keys ----------------------------------------------------------------------

  /** What j/k walk through: every repo of the map, or the focused repo and the rows of the tree. */
  function rowSelections() {
    if (st.mode === 'map') return mapOrder.map((id) => ({ type: 'node', id }));
    if (!st.focus) return [];
    return [{ type: 'node', id: st.focus }, ...cascade(graph(), st.focus).rows.map((r) => ({ type: 'edge', id: r.edge.id }))];
  }

  function onKey(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      save();
      return true;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    if (e.key === 'Escape') {
      if (st.connectFrom) {
        endConnect();
        return true;
      }
      if (st.confirm) {
        st.confirm = null;
        renderInspector();
        return true;
      }
      return false;
    }
    if (typing()) return false;
    if (st.confirm && (e.key === 'y' || e.key === 'n')) {
      if (e.key === 'y') removeSelected();
      else {
        st.confirm = null;
        renderInspector();
      }
      return true;
    }
    const sel = findSelection();
    switch (e.key) {
      case '/':
        search.focus();
        return true;
      case 'm':
        setMode(st.mode === 'map' ? 'tree' : 'map');
        return true;
      case 'a':
        addRepo();
        return true;
      case 's':
        save();
        return true;
      case 'f':
        if (st.connectFrom) connectToFolder();
        return !!st.connectFrom;
      case '+':
        if (st.selection?.type === 'node') startConnect(st.selection.id);
        return st.selection?.type === 'node';
      case 'r': {
        const failure = st.selection?.type === 'edge' && sel ? failureOf(sel) : null;
        if (failure && !app.busy) app.run(['retry', failure.target]);
        return !!failure;
      }
      case 'o': {
        const failure = st.selection?.type === 'edge' && sel ? failureOf(sel) : null;
        if (failure) app.go('history', failure.target);
        return !!failure;
      }
      case 'Delete':
      case 'Backspace':
      case 'x':
        askRemove();
        return true;
      case 'Enter':
        if (st.selection?.type === 'edge' && sel) focusOn(sel.target);
        else if (st.selection?.type === 'node' && sel && (st.mode === 'map' || sel.id !== st.focus)) focusOn(sel.id);
        return !!sel;
      case 'j':
      case 'k':
      case 'ArrowDown':
      case 'ArrowUp': {
        if (st.connectFrom) return false;
        const list = rowSelections();
        // In the map, a selected link stands for the repo it goes into.
        const into = st.mode === 'map' && st.selection?.type === 'edge' ? edgeById(st.selection.id)?.target : undefined;
        const i = list.findIndex((s) => st.selection && ((s.type === st.selection.type && s.id === st.selection.id) || (into && s.id === into)));
        const down = e.key === 'j' || e.key === 'ArrowDown';
        const next = list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + (down ? 1 : -1)))];
        if (next) select({ type: next.type, id: next.id });
        content.querySelector('.table-row[aria-selected="true"], .gnode[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        return true;
      }
      default:
        return false;
    }
  }

  load();
  loadHistory();

  return {
    hints: 'j/k move · enter focus · / search · m map or tree · s save',
    onKey,
    async onChanged(what) {
      if (what === 'journal') loadHistory();
      if (what === 'state' || what === 'tick' || what === 'busy') {
        renderContent();
        refreshInspector();
      }
      if (what !== 'config' || st.saving) return;
      const res = await api.readConfig();
      if (res.error) {
        if (!dirty()) load();
        return;
      }
      if (st.saved && sameJson(res.raw, st.saved)) return;
      if (!dirty()) return load();
      st.externalChange = true;
      renderSavebar();
    },
    navigate(selector) {
      const node = graph().nodes.find((n) => n.name === selector || n.id === selector);
      if (node) focusOn(node.id);
    },
    destroy() {
      clearTimeout(checkTimer);
    }
  };
}
