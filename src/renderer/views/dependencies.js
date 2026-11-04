// The dependency editor. The map draws every repo and link: one column per
// step from the sources, the repos without links in a block at the bottom.
// Selecting a repo lights what a push to it updates and dims the rest. The map
// zooms (cmd/ctrl + wheel, pinch, keys) and pans (drag the background). Edits
// go to a draft that the CLI checks as you type and that is written to the
// config file only on save.
import { h, svg, mount, box, tab, keyButton, glyph, LOOK, SPIN, typing, plural, tildify, sidePanel, dockedBottom } from '../dom.js';
import { field } from '../fields.js';
import { ago, duration } from '/shared/status.js';
import { downstream, mapLayout, linkStates, lastPushes } from '/shared/map.js';
import { baseName } from '/shared/graph.js';
import { appearance } from '/shared/tabs.js';
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
 * the column titles and for the heading of the repos without links, and how
 * wide a character is (JetBrains Mono is 0.6em: 12px names, 11px status lines).
 */
const MAP = { minWidth: 120, maxWidth: 260, row: 46, gap: 10, columnGap: 44, head: 24, char: 7.2, subChar: 6.6 };

/** Which link line is drawn on top. */
const LINE_RANK = { '': 0, queued: 1, failed: 2, running: 3, lit: 4, selected: 5 };

/** The map's zoom: its limits, the factor of a key press, and where it is remembered. */
const ZOOM = { min: 0.25, max: 2, step: 1.25, key: 'dependencies.zoom' };

function storedZoom() {
  try {
    const z = Number(localStorage.getItem(ZOOM.key));
    return z >= ZOOM.min && z <= ZOOM.max ? z : 1;
  } catch {
    return 1;
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
    zoom: storedZoom(), // the map's scale, 0.25 to 2
    goTo: null, // a repo to select as soon as the graph is loaded
    selection: null, // { type: 'node' | 'edge', id }; null shows the defaults
    connectFrom: null, // node id while picking its new dependent
    confirm: null, // 'node' | 'edge' while asking to remove it
    query: null, // search text while the search field is in use
    pick: 0, // highlighted suggestion
    safety: false, // the `[+] safety` box is open (right dock; the bottom dock always has the tab)
    failedFor: null, // the selection whose `failed` tab was last shown, so it is selected once
    externalChange: false,
    saving: false,
    saveError: null,
    justSaved: false
  };
  const facts = new Map(); // node id -> inspectRepo() result

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
        search.value = '';
        renderSuggestions();
        renderToolbar();
      }, 150),
    onkeydown: onSearchKey
  });
  const suggestions = h('div', { class: 'suggestions', hidden: true, role: 'listbox' });
  const count = h('span', { class: 'count' });
  const content = h('div', { class: 'scroll' });
  const savebar = h('div', { class: 'savebar' });
  const { el: panel, body: inspector, show: showPanel, empty: emptyPanel, step: stepTab } = sidePanel({ label: 'Details' });

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
      renderToolbar();
      renderContent();
      renderSavebar();
      if (st.goTo) {
        const node = findNode(st.goTo);
        st.goTo = null;
        if (node) showRepo(node.id);
      }
    });
  }

  const dirty = () => st.draft !== null && !sameJson(st.draft, st.saved);
  const graph = () => st.check?.graph ?? { nodes: [], edges: [] };
  const nodeById = (id) => graph().nodes.find((n) => n.id === id) || null;
  const edgeById = (id) => graph().edges.find((e) => e.id === id) || null;
  const nameOf = (id) => nodeById(id)?.name ?? baseName(id);

  const findNode = (selector) => graph().nodes.find((n) => n.name === selector || n.id === selector) || null;

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
    st.failedFor = null;
    renderContent();
    renderInspector();
  }

  function findSelection() {
    if (!st.selection) return null;
    return st.selection.type === 'node' ? nodeById(st.selection.id) : edgeById(st.selection.id);
  }

  /** A repo picked from the map or the search: connects it while adding a dependent; else shows it. */
  function pickRepo(id) {
    if (st.connectFrom) {
      const target = nodeById(id);
      if (id === st.connectFrom || !target) return endConnect();
      return connectTo({ path: target.path });
    }
    showRepo(id);
  }

  /** Selects a repo on the map and scrolls it to the centre. */
  function showRepo(id) {
    st.connectFrom = null;
    select({ type: 'node', id });
    content.querySelector('.gnode[aria-selected="true"]')?.scrollIntoView({ block: 'center', inline: 'center' });
  }

  // ---- adding and connecting ------------------------------------------------

  async function addRepo() {
    const path = await api.pickFolder('Add a repo');
    if (!path) return;
    const info = await api.inspectRepo(path);
    await editStructure('addRepo', { repo: { path, name: info.packageName } });
    showRepo(info.path);
  }

  /** Lets the map pick the repo that depends on `fromId`. */
  function startConnect(fromId) {
    st.connectFrom = fromId;
    renderToolbar();
    renderContent();
  }

  function endConnect() {
    st.connectFrom = null;
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
      editStructure('removeRepo', { id: sel.id }).then(() => select(null));
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

  // ---- content: the map ---------------------------------------------------------

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
    // The map is re-created on every tick and keeps its place.
    const old = content.querySelector('.graph-scroll');
    const [left, top] = old ? [old.scrollLeft, old.scrollTop] : [0, 0];
    mount(content, mapView());
    const scroller = content.querySelector('.graph-scroll');
    scroller.scrollLeft = left;
    scroller.scrollTop = top;
  }

  /** What j/k walk through in the map. */
  let mapOrder = [];
  /** The map's size at 100%, for `fit`. */
  let mapSize = { width: 0, height: 0 };

  function mapView() {
    const g = graph();
    const ls = states();
    const pushes = lastPushes(app.status, st.history);
    const from = st.connectFrom;
    const layout = mapLayout(g, { row: MAP.row, gap: MAP.gap, title: MAP.head });
    const selEdge = st.selection?.type === 'edge' ? edgeById(st.selection.id) : null;
    const selNode = st.selection?.type === 'node' ? st.selection.id : null;
    const placed = g.nodes.filter((n) => layout.column.has(n.id));
    const { column, y } = layout;
    const loose = new Set(layout.loose?.ids);
    mapOrder = layout.order;

    // A selected repo lights what a push to it updates and the links into it; the rest dims. Not while picking a dependent.
    const push = !from && selNode ? downstream(g, selNode) : null;
    const litEdge = (e) => !!push && (push.edges.has(e.id) || e.target === selNode);

    /** The second line of a box: the state of the link into it, or a source's last push. */
    const line = new Map(
      placed.map((node) => {
        const lead = leadInto(node.id, ls);
        if (!lead) {
          const last = pushes.get(node.name);
          return [node.id, { kind: null, text: last ? `pushed ${ago(last.ts)}` : 'no push seen' }];
        }
        const state = ls.get(lead.id);
        const kind = state?.kind || 'none';
        return [node.id, { kind, text: `${LOOK[kind].word}${when(state) ? ` ${when(state)}` : ''}` }];
      })
    );

    // A column is as wide as its longest name or status line, within limits.
    const need = (id) => Math.max(nameOf(id).length * MAP.char, (line.get(id).text.length + (line.get(id).kind ? 2 : 0)) * MAP.subChar);
    const colLeft = [];
    const colWidth = [];
    let x = 0;
    layout.columns.forEach((ids, c) => {
      colLeft[c] = x;
      colWidth[c] = Math.max(MAP.minWidth, Math.min(MAP.maxWidth, Math.ceil(Math.max(0, ...ids.map(need))) + 20));
      x += colWidth[c] + MAP.columnGap;
    });
    const width = Math.max(0, x - MAP.columnGap);
    // The column titles take the top row unless every repo is without links.
    const head = loose.size === placed.length ? 0 : MAP.head;
    const height = head + layout.height;
    mapSize = { width, height };
    const left = (id) => colLeft[column.get(id)];
    const right = (id) => left(id) + colWidth[column.get(id)];
    const mid = (id) => head + y.get(id);

    const titles = layout.columns.map((ids, c) => {
      const linked = ids.filter((id) => !loose.has(id)).length;
      if (!linked) return null;
      return h('span', { class: 'gtitle', style: `left: ${colLeft[c]}px; width: ${colWidth[c]}px` }, `${c ? `step ${c}` : 'sources'} · ${linked}`);
    });
    const looseTitle = layout.loose
      ? h('span', { class: 'gtitle', style: `left: 0; top: ${head + layout.loose.top}px` }, `no links · ${layout.loose.ids.length}`)
      : null;

    const lines = g.edges
      .filter((e) => column.has(e.source) && column.has(e.target))
      .map((e) => {
        const a = column.get(e.source);
        const b = column.get(e.target);
        const y1 = mid(e.source);
        const y2 = mid(e.target);
        let d;
        let arrow;
        if (b > a) {
          const x1 = right(e.source);
          const x2 = left(e.target);
          const m = (x1 + x2) / 2;
          d = `M${x1} ${y1}C${m} ${y1} ${m} ${y2} ${x2} ${y2}`;
          arrow = `M${x2} ${y2}l-7 -3.5v7z`;
        } else if (a === b) {
          // Within a column the line loops out on the right, further out the further it goes, so loops stay apart.
          const x1 = right(e.source);
          const out = x1 + 10 + Math.min(20, Math.abs(y2 - y1) / 12);
          d = `M${x1} ${y1}C${out} ${y1} ${out} ${y2} ${x1} ${y2}`;
          arrow = `M${x1} ${y2}l7 -3.5v7z`;
        } else {
          // Back to an earlier column it leaves from the left.
          const x1 = left(e.source);
          const x2 = right(e.target);
          d = `M${x1} ${y1}C${x1 - 22} ${y1} ${x2 + 22} ${y2} ${x2} ${y2}`;
          arrow = `M${x2} ${y2}l7 -3.5v7z`;
        }
        const kind = ls.get(e.id)?.kind;
        const state = ['running', 'failed', 'queued'].includes(kind) ? kind : '';
        const lit = litEdge(e) ? 'lit' : '';
        const look = e.id === selEdge?.id ? 'selected' : lit || state;
        // A negative delay keeps the running line flowing in step across re-renders.
        const path = svg('path', { class: 'line', d, style: state === 'running' ? `animation-delay: -${Date.now() % 800}ms` : null });
        return {
          rank: LINE_RANK[look],
          el: svg(
            'g',
            { class: ['gedge', state, lit, e.id === selEdge?.id ? 'selected' : ''].filter(Boolean).join(' ') },
            path,
            svg('path', { class: 'head', d: arrow }),
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
      const lit = push?.repos.has(id) ? ' lit' : '';
      return h(
        'button',
        {
          class: `gnode${state}${end}${lit}${id === from ? ' from' : ''}`,
          style: `left: ${left(id)}px; top: ${mid(id) - MAP.row / 2}px; width: ${colWidth[column.get(id)]}px; height: ${MAP.row}px`,
          'aria-selected': String(!from && selNode === id),
          title: nameOf(id),
          onclick: () => (from ? pickRepo(id) : select({ type: 'node', id }))
        },
        h('span', { class: 'name' }, nameOf(id)),
        kind ? h('span', { class: `status ${LOOK[kind].cls}` }, glyph(kind), ` ${text}`) : h('span', { class: 'sub' }, text)
      );
    });

    return h(
      'div',
      { class: 'map-view' },
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
          {
            class: `graph${push ? ' focused' : ''}`,
            style: `width: ${width}px; height: ${height}px; zoom: ${st.zoom}`,
            role: 'group',
            'aria-label': 'Every repo and its links'
          },
          titles,
          looseTitle,
          svg('svg', { class: 'gedges', width, height, 'aria-hidden': 'true' }, lines),
          boxes
        )
      ),
      h(
        'div',
        { class: 'graph-legend' },
        ['updated', 'running', 'queued', 'failed'].map((k) => h('span', { class: LOOK[k].cls }, `${LOOK[k].glyph ?? SPIN[0]} ${LOOK[k].word}`)),
        h('span', { class: 'grow' }, 'click to edit · drag to pan'),
        h(
          'span',
          { class: 'zoom' },
          h('button', { class: 'plain', title: 'Zoom out (-)', onclick: () => zoomBy(1 / ZOOM.step) }, '−'),
          h('span', { class: 'level', title: 'Zoom with cmd or ctrl and the wheel, or pinch' }, `${Math.round(st.zoom * 100)}%`),
          h('button', { class: 'plain', title: 'Zoom in (=)', onclick: () => zoomBy(ZOOM.step) }, '+'),
          keyButton('0', 'fit', fit, { title: 'Scale the whole map to the window' })
        )
      )
    );
  }

  // ---- zoom and pan -----------------------------------------------------------------

  const scroller = () => content.querySelector('.graph-scroll');

  /**
   * Zooms the map about a point of the scroller, so the part of the map under
   * it stays put. Works on the map as it is now, so it also applies in the
   * middle of a re-render.
   * @param {number} zoom
   * @param {{ x: number, y: number }} [about]  offset from the scroller's top left; its centre by default
   */
  function setZoom(zoom, about) {
    const el = scroller();
    const next = Math.min(ZOOM.max, Math.max(ZOOM.min, zoom));
    if (!el || next === st.zoom) return;
    const at = about ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 };
    const ratio = next / st.zoom;
    const x = (el.scrollLeft + at.x) * ratio - at.x;
    const y = (el.scrollTop + at.y) * ratio - at.y;
    st.zoom = next;
    try {
      localStorage.setItem(ZOOM.key, String(next));
    } catch {}
    el.querySelector('.graph').style.zoom = String(next);
    el.parentElement.querySelector('.zoom .level').textContent = `${Math.round(next * 100)}%`;
    el.scrollLeft = x;
    el.scrollTop = y;
  }

  const zoomBy = (factor, about) => setZoom(st.zoom * factor, about);

  /** Scales the map once so that all of it shows, never larger than 100%. */
  function fit() {
    const el = scroller();
    if (!el || !mapSize.width) return;
    const z = Math.min(1, el.clientWidth / mapSize.width, el.clientHeight / mapSize.height);
    setZoom(Math.floor(z * 100) / 100);
    el.scrollLeft = 0;
    el.scrollTop = 0;
  }

  // Wheel and pointer listeners sit on `content`, which is never replaced; the map inside is.
  content.addEventListener(
    'wheel',
    (e) => {
      const el = e.target.closest?.('.graph-scroll');
      if (!el || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const delta = Math.max(-60, Math.min(60, e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY));
      zoomBy(Math.exp(-delta * 0.01), { x: e.clientX - rect.left, y: e.clientY - rect.top });
    },
    { passive: false }
  );

  /** The drag in progress: where it started and the scroll offsets then. */
  let drag = null;
  let dragged = false;

  content.addEventListener('pointerdown', (e) => {
    dragged = false;
    const el = e.target.closest?.('.graph-scroll');
    if (!el || e.button !== 0 || e.target.closest('.gnode, .hit')) return;
    const rect = el.getBoundingClientRect();
    if (e.clientX - rect.left >= el.clientWidth || e.clientY - rect.top >= el.clientHeight) return; // a scrollbar
    drag = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    content.setPointerCapture(e.pointerId);
  });
  content.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!dragged && Math.hypot(dx, dy) < 4) return;
    dragged = true;
    content.classList.add('panning');
    const el = scroller();
    if (!el) return;
    el.scrollLeft = drag.left - dx;
    el.scrollTop = drag.top - dy;
  });
  const endDrag = () => {
    drag = null;
    content.classList.remove('panning');
  };
  content.addEventListener('pointerup', endDrag);
  content.addEventListener('pointercancel', endDrag);
  // The click that ends a drag selects nothing.
  content.addEventListener(
    'click',
    (e) => {
      if (!dragged) return;
      dragged = false;
      e.stopPropagation();
      e.preventDefault();
    },
    true
  );

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
   * The setting boxes of a link or of the defaults, one tab each at the bottom. Right-docked,
   * safety stays folded behind a summary; at the bottom it is a tab like the others.
   * @param {(key: string, label: string, kind: string) => HTMLElement} fieldFor
   * @param {(key: string) => unknown} valueOf  the value that applies, for the safety summary
   * @param {{ defaults?: boolean }} [opts]
   */
  function sectionBoxes(fieldFor, valueOf, { defaults = false } = {}) {
    return SECTIONS.map(([title, keys]) => {
      if (title === 'safety' && !st.safety && !dockedBottom()) return null;
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
      return tab(box(title, null, fields), title);
    }).concat(
      dockedBottom()
        ? null
        : h(
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
    showPanel(
      [
        tab(
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
          'defaults'
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
      ],
      { key: 'defaults' }
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
    const push = downstream(g, node.id);

    showPanel(
      [
        tab(
          box(
            'repo',
            null,
            h('span', { class: 'title' }, node.name),
            h('span', { class: 'dim' }, node.path),
            repoFacts(node),
            h('p', { class: 'muted' }, push.count ? `a push updates ${plural(push.count, 'repo')} in ${plural(push.depth, 'step')}` : 'a push updates nothing yet')
          ),
          'repo'
        ),
        repo
          ? tab(
              box(
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
              ),
              'as a source'
            )
          : null,
        tab(
          box(
            `dependents · ${dependents.length}`,
            null,
            dependents.length ? linkList(dependents, (e) => nameOf(e.target), ls) : h('p', { class: 'empty' }, 'none yet. add one to update it after every push here.'),
            h('div', { class: 'row' }, keyButton('+', 'add dependent…', () => startConnect(node.id)))
          ),
          'dependents'
        ),
        sources.length ? tab(box(`depends on · ${sources.length}`, null, linkList(sources, (e) => nameOf(e.source), ls)), 'depends on') : null
      ],
      {
        key: `node:${node.id}`,
        actions:
          st.confirm === 'node'
            ? confirmRow(
                `remove ${node.name}? ${links ? `its ${plural(links, 'link')} go too. ` : ''}nothing changes on disk until you save.`,
                'remove'
              )
            : h('button', { class: 'plain remove', onclick: askRemove }, h('span', { class: 'key' }, 'x'), ' remove repo')
      }
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
      live = tab(
        box(
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
        ),
        'failed',
        { tone: 'failed' }
      );
    } else if (state?.kind === 'running') {
      live = tab(
        box(['running ', duration(Date.now() - state.ts)], 'busy tinted', h('pre', { class: 'muted' }, commands), h('div', { class: 'row' }, keyButton('2', 'follow it in activity', () => app.go('activity')))),
        'running',
        { tone: 'running' }
      );
    }
    // A failure that has just appeared for this link takes the tab, once.
    const failed = appearance(st.failedFor, edge.id, !!failure);
    st.failedFor = failed.seenFor;

    showPanel(
      [
        tab(
          box(
            'link',
            null,
            h('span', { class: 'title' }, nameOf(edge.source), h('span', { class: 'dim' }, ' → '), nameOf(edge.target)),
            h('span', { class: 'dim' }, pkg.path),
            state?.kind === 'queued' ? h('p', { class: 'notice' }, '· queued: it runs after the update in progress') : null,
            field({
              label: 'label',
              kind: 'text',
              value: pkg.name,
              inherits: false,
              placeholder: baseName(pkg.path || ''),
              hint: 'shown in notifications and the history',
              onChange: (v) => edit((r) => setLinkField(r, repoIndex, packageIndex, 'name', v))
            })
          ),
          'link'
        ),
        live,
        sectionBoxes(
          (key, label, kind) => {
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
          },
          (key) => effective(edge, key)
        )
      ],
      {
        key: `edge:${edge.id}`,
        focusTab: failed.fresh ? 'failed' : null,
        actions:
          st.confirm === 'edge'
            ? confirmRow('remove this link? nothing changes on disk until you save.', 'remove')
            : h('button', { class: 'plain remove', onclick: askRemove }, h('span', { class: 'key' }, 'x'), ' remove link')
      }
    );
  }

  function renderInspector() {
    if (st.fileError) {
      emptyPanel(
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

  /** The keys that zoom, bare or with cmd/ctrl; a bare `+` adds a dependent. */
  const ZOOM_KEYS = { '=': 1, '+': 1, '-': 1, '0': 1 };

  /** @returns {boolean} whether the map showed and took the key */
  function zoomKey(key) {
    if (!scroller()) return false;
    if (key === '0') fit();
    else zoomBy(key === '-' ? 1 / ZOOM.step : ZOOM.step);
    return true;
  }

  function onKey(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      save();
      return true;
    }
    if ((e.metaKey || e.ctrlKey) && !e.altKey && ZOOM_KEYS[e.key]) return !typing() && zoomKey(e.key);
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
      case '=':
      case '-':
      case '0':
        return zoomKey(e.key);
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
      case ',':
      case '.':
        return stepTab(e.key === '.' ? 1 : -1);
      case 'Delete':
      case 'Backspace':
      case 'x':
        askRemove();
        return true;
      case 'j':
      case 'k':
      case 'ArrowDown':
      case 'ArrowUp': {
        if (st.connectFrom) return false;
        // A selected link stands for the repo it goes into.
        const at = st.selection?.type === 'edge' ? edgeById(st.selection.id)?.target : st.selection?.id;
        const i = mapOrder.indexOf(at);
        const down = e.key === 'j' || e.key === 'ArrowDown';
        const next = mapOrder[Math.max(0, Math.min(mapOrder.length - 1, i < 0 ? 0 : i + (down ? 1 : -1)))];
        if (next) select({ type: 'node', id: next });
        content.querySelector('.gnode[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        return true;
      }
      default:
        return false;
    }
  }

  load();
  loadHistory();

  return {
    hints: 'j/k move · / search · = - 0 zoom · s save',
    onKey,
    async onChanged(what) {
      if (what === 'journal') loadHistory();
      if (what === 'layout') renderInspector();
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
      const node = findNode(selector);
      if (node) showRepo(node.id);
      else if (!st.check) st.goTo = selector;
    },
    destroy() {
      clearTimeout(checkTimer);
    }
  };
}
