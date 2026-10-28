// The dependency graph editor. Repos are stations and links are tracks: a
// push to the station on the left runs the commands of the stations its
// tracks lead to. Edits go to a draft that is checked by the CLI as you type
// and written to the config file only on Save.
import cytoscape from '/vendor/cytoscape/cytoscape.esm.mjs';
import dagre from '/vendor/cytoscape-dagre/cytoscape-dagre.mjs';
import { h, mount } from '../dom.js';
import { field } from '../fields.js';
import { removeLink, setDefaultsField, setLinkField, setRepoField, setRootField, sameJson } from '/shared/draft.js';

cytoscape.use(dagre);

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const LABEL_FONT = '600 13px Overpass';
const measure = document.createElement('canvas').getContext('2d');
/** Width of a station: its label plus padding. */
function labelWidth(label) {
  measure.font = LABEL_FONT;
  return Math.ceil(measure.measureText(label).width) + 22;
}

/** Cytoscape styles from the CSS tokens (re-read when the theme changes). */
function graphStyle() {
  const ink = css('--ink');
  const amber = css('--amber');
  const signal = css('--signal');
  return [
    {
      selector: 'node',
      style: {
        shape: 'round-rectangle',
        'background-color': css('--raised'),
        'border-width': 2,
        'border-color': ink,
        label: 'data(label)',
        color: ink,
        'font-family': 'Overpass',
        'font-size': 13,
        'font-weight': 600,
        'text-valign': 'center',
        'text-halign': 'center',
        width: (node) => labelWidth(node.data('label')),
        height: 30,
        'overlay-color': ink,
        'overlay-opacity': 0
      }
    },
    { selector: 'node.dependent', style: { 'border-color': css('--ink-muted'), 'border-width': 1.5, color: css('--ink-muted') } },
    {
      selector: 'edge',
      style: {
        'curve-style': 'taxi',
        'taxi-direction': 'rightward',
        'taxi-turn': '40%',
        'taxi-turn-min-distance': 14,
        width: 3,
        'line-color': ink,
        'target-arrow-shape': 'triangle',
        'target-arrow-color': ink,
        'arrow-scale': 0.75,
        'overlay-opacity': 0
      }
    },
    { selector: 'node.queued', style: { 'border-color': amber, 'border-style': 'dashed', 'border-width': 3 } },
    { selector: 'node.failed', style: { 'border-color': signal, 'border-width': 3, color: signal, 'background-color': css('--signal-wash') } },
    { selector: 'edge.failed', style: { 'line-color': signal, 'target-arrow-color': signal, 'z-index': 8 } },
    { selector: 'node.running', style: { 'border-color': amber, 'border-width': 3, 'background-color': css('--amber-wash') } },
    { selector: 'edge.running', style: { 'line-color': amber, 'target-arrow-color': amber, width: 5, 'z-index': 9 } },
    { selector: 'node.chosen', style: { 'background-color': ink, color: css('--panel'), 'border-color': ink } },
    {
      selector: 'edge.chosen',
      style: { width: 5, 'z-index': 10, 'underlay-color': amber, 'underlay-opacity': 0.55, 'underlay-padding': 4 }
    },
    { selector: 'node.connect-from', style: { 'border-color': amber, 'border-width': 4 } }
  ];
}

/**
 * @param {HTMLElement} root
 * @param {import('../app.js').App} app
 */
export function create(root, app) {
  const { api } = app;
  const defaults = app.ctx.cli.defaults;
  const st = {
    fileError: null,
    exists: true,
    saved: null,
    draft: null,
    check: null,
    selection: null, // { type: 'node' | 'edge', id }
    connectFrom: null,
    externalChange: false,
    saving: false,
    saveError: null,
    graphKey: ''
  };

  const banner = h('div', { class: 'banner', hidden: true });
  const placeholder = h('div', { class: 'placeholder', hidden: true });
  const cyEl = h('div', { class: 'cy' });
  const savebar = h('div', { class: 'savebar' });
  const inspector = h('aside', { class: 'inspector', 'aria-label': 'Details' });
  const tools = h(
    'div',
    { class: 'graph-tools' },
    h('button', { onclick: addRepo }, 'Add repo…'),
    h('button', { onclick: () => fitView() }, 'Fit to view'),
    h('span', { class: 'hint' }, 'A push to a repo updates the repos its lines lead to.')
  );
  root.append(
    h('div', { class: 'graph-view' }, tools, h('div', { class: 'graph-canvas' }, cyEl, banner, placeholder), savebar, inspector)
  );

  const cy = cytoscape({
    container: cyEl,
    style: graphStyle(),
    minZoom: 0.2,
    maxZoom: 2.5,
    boxSelectionEnabled: false
  });
  cy.on('tap', 'node', (e) => onNodeTap(e.target.id()));
  cy.on('tap', 'edge', (e) => {
    if (!st.connectFrom) select({ type: 'edge', id: e.target.id() });
  });
  cy.on('tap', (e) => {
    if (e.target === cy && !st.connectFrom) select(null);
  });

  const scheme = matchMedia('(prefers-color-scheme: dark)');
  const onScheme = () => cy.style(graphStyle());
  scheme.addEventListener('change', onScheme);

  const onKey = (e) => {
    if (e.key === 'Escape' && st.connectFrom) return endConnect();
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && st.selection) {
      e.preventDefault();
      if (st.selection.type === 'edge') removeSelectedLink();
      else removeSelectedRepo();
    }
  };
  document.addEventListener('keydown', onKey);

  // ---- loading, checking, saving ------------------------------------------

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
      updateGraph();
      renderSavebar();
    });
  }

  const dirty = () => st.draft !== null && !sameJson(st.draft, st.saved);

  /**
   * Applies a field edit to the draft. The inspector is not re-rendered, so
   * the field being typed in keeps its focus.
   * @param {(raw: object) => object} fn
   */
  function edit(fn) {
    st.draft = fn(st.draft);
    st.saveError = null;
    runCheck({ later: true });
  }

  /** Applies a structural edit (needs the CLI's path resolution) and re-renders. */
  async function editStructure(op, args) {
    const res = await api.editConfig({ raw: st.draft, op, args });
    st.draft = res.raw;
    st.saveError = null;
    await runCheck();
    return res;
  }

  async function save() {
    st.saving = true;
    const res = await api.writeConfig(st.draft);
    st.saving = false;
    if (res.saved) {
      st.saved = structuredClone(st.draft);
      st.exists = true;
      st.externalChange = false;
      st.saveError = null;
    } else {
      st.saveError = res.error;
    }
    renderSavebar();
  }

  async function discard() {
    st.draft = structuredClone(st.saved);
    st.saveError = null;
    await runCheck();
    if (st.selection && !findSelection()) st.selection = null;
    renderInspector();
  }

  // ---- graph --------------------------------------------------------------

  function updateGraph() {
    const graph = st.check?.graph ?? { nodes: [], edges: [] };
    const key = JSON.stringify([
      graph.nodes.map((n) => [n.id, n.name, n.isSource]),
      graph.edges.map((e) => [e.id, e.source, e.target])
    ]);
    if (key !== st.graphKey) {
      st.graphKey = key;
      cy.elements().remove();
      cy.add([
        ...graph.nodes.map((n) => ({
          group: 'nodes',
          data: { id: n.id, label: n.name },
          classes: n.isSource ? 'source' : 'dependent'
        })),
        ...graph.edges.map((e) => ({ group: 'edges', data: { id: e.id, source: e.source, target: e.target } }))
      ]);
      const layout = cy.layout({ name: 'dagre', rankDir: 'LR', nodeSep: 16, rankSep: 110, edgeSep: 12, fit: false });
      // The positions are applied after run() returns.
      layout.one('layoutstop', () => {
        packComponents();
        fitView();
      });
      layout.run();
      if (st.selection && !findSelection()) st.selection = null;
    }
    placeholder.hidden = graph.nodes.length > 0;
    if (!placeholder.hidden) {
      mount(
        placeholder,
        h('h2', null, st.exists ? 'No repos yet' : 'No config yet'),
        h('p', null, 'Add the repo of a package, then the repos that depend on it.'),
        h('button', { class: 'primary', onclick: addRepo }, 'Add repo…')
      );
    }
    markSelection();
    applyStatus();
  }

  /** Fits the graph in the canvas, without blowing a small graph up past 1.2×. */
  function fitView() {
    cy.fit(undefined, 40);
    if (cy.zoom() > 1.2) {
      cy.zoom(1.2);
      cy.center();
    }
  }

  /**
   * A station's box from its position and size. Cytoscape's own bounding
   * boxes lag behind positions set in code until the next render.
   */
  function nodeBox(n) {
    const { x, y } = n.position();
    const w = labelWidth(n.data('label')) / 2;
    return { x1: x - w, x2: x + w, y1: y - 15, y2: y + 15 };
  }

  function boxOf(nodes) {
    const boxes = nodes.map(nodeBox);
    const x1 = Math.min(...boxes.map((b) => b.x1));
    const y1 = Math.min(...boxes.map((b) => b.y1));
    const x2 = Math.max(...boxes.map((b) => b.x2));
    const y2 = Math.max(...boxes.map((b) => b.y2));
    return { x1, y1, w: x2 - x1, h: y2 - y1 };
  }

  /**
   * Dagre can leave tall empty bands between the rows of one group, where a
   * long column of dependents sets the spacing. Closes every band taller than
   * `maxGap` while keeping the order of the rows, so no lines cross anew.
   * @param {import('cytoscape').NodeCollection} nodes  one connected group
   */
  function closeGaps(nodes, maxGap = 30) {
    const rows = nodes
      .map((n) => ({ n, box: nodeBox(n) }))
      .sort((a, b) => a.box.y1 - b.box.y1);
    let bottom = -Infinity;
    let shift = 0;
    for (const row of rows) {
      if (bottom !== -Infinity && row.box.y1 - bottom > maxGap) shift += row.box.y1 - bottom - maxGap;
      bottom = Math.max(bottom, row.box.y2);
      row.shift = shift;
    }
    for (const { n, shift: dy } of rows) if (dy) n.position('y', n.position('y') - dy);
  }

  /**
   * Dagre stacks unconnected groups of repos in one tall column, and fills the
   * empty bands of one group with others. Closes each group's bands, then lays
   * the groups out in rows, as wide as the canvas is relative to its height,
   * so a fitted graph is readable.
   */
  function packComponents() {
    const gap = 60;
    const components = cy.elements().components();
    for (const c of components) closeGaps(c.nodes());
    const parts = components
      .map((c) => ({ c, box: boxOf(c.nodes()) }))
      .sort((a, b) => b.box.h - a.box.h);
    if (parts.length < 2) return;
    const area = parts.reduce((sum, p) => sum + (p.box.w + gap) * (p.box.h + gap), 0);
    const aspect = cyEl.clientWidth / Math.max(1, cyEl.clientHeight) || 1.6;
    const rowWidth = Math.max(Math.sqrt(area * aspect), ...parts.map((p) => p.box.w));
    let x = 0;
    let y = 0;
    let rowHeight = 0;
    for (const { c, box } of parts) {
      if (x > 0 && x + box.w > rowWidth) {
        x = 0;
        y += rowHeight + gap;
        rowHeight = 0;
      }
      const dx = x - box.x1;
      const dy = y - box.y1;
      c.nodes().positions((n) => ({ x: n.position('x') + dx, y: n.position('y') + dy }));
      x += box.w + gap;
      rowHeight = Math.max(rowHeight, box.h);
    }
  }

  function markSelection() {
    cy.elements().removeClass('chosen');
    if (st.selection) cy.getElementById(st.selection.id).addClass('chosen');
  }

  /** Lights up what the daemon is doing: the running link, queued and failed dependents. */
  function applyStatus() {
    const status = app.status;
    const graph = st.check?.graph;
    cy.elements().removeClass('running queued failed');
    if (!status || !graph) return;
    const sourceIdsByName = new Map(graph.nodes.filter((n) => n.isSource).map((n) => [n.name, n.id]));
    const light = (cls, sourceName, targetPath) => {
      cy.getElementById(targetPath).addClass(cls);
      const sourceId = sourceIdsByName.get(sourceName);
      if (sourceId) cy.edges().filter((e) => e.data('source') === sourceId && e.data('target') === targetPath).addClass(cls);
    };
    for (const f of status.openFailures) light('failed', f.source, f.targetPath);
    for (const j of status.queue.jobs) if (j.targetPath) cy.getElementById(j.targetPath).addClass('queued');
    if (status.activeRun) light('running', status.activeRun.source, status.activeRun.targetPath);
  }

  function findSelection() {
    const graph = st.check?.graph;
    if (!graph || !st.selection) return null;
    const list = st.selection.type === 'node' ? graph.nodes : graph.edges;
    return list.find((x) => x.id === st.selection.id) || null;
  }

  function select(selection) {
    st.selection = selection;
    markSelection();
    renderInspector();
  }

  // ---- adding and connecting ------------------------------------------------

  async function addRepo() {
    const path = await api.pickFolder('Add a repo');
    if (!path) return;
    const info = await api.inspectRepo(path);
    const res = await editStructure('addRepo', { repo: { path, name: info.packageName } });
    select({ type: 'node', id: info.path });
    if (!res.added) cy.getElementById(info.path).flashClass?.('chosen', 400);
  }

  function startConnect(fromId) {
    st.connectFrom = fromId;
    cy.getElementById(fromId).addClass('connect-from');
    const from = st.check.graph.nodes.find((n) => n.id === fromId);
    banner.hidden = false;
    mount(
      banner,
      h('span', null, `Click the repo that depends on ${from?.name}, or choose its folder.`),
      h('button', { onclick: connectToFolder }, 'Choose folder…'),
      h('button', { onclick: endConnect }, 'Cancel')
    );
  }

  function endConnect() {
    if (st.connectFrom) cy.getElementById(st.connectFrom).removeClass('connect-from');
    st.connectFrom = null;
    banner.hidden = true;
  }

  async function onNodeTap(id) {
    if (!st.connectFrom) return select({ type: 'node', id });
    if (id === st.connectFrom) return;
    const target = st.check.graph.nodes.find((n) => n.id === id);
    await connectTo({ path: target.path });
  }

  async function connectToFolder() {
    const path = await api.pickFolder('Choose the repo that depends on it');
    if (path) await connectTo({ path });
  }

  /** Links the repo being connected from to `target`. */
  async function connectTo(target) {
    const from = st.check.graph.nodes.find((n) => n.id === st.connectFrom);
    endConnect();
    if (!from) return;
    // A repo that only depended on others so far becomes a source; its package name comes from its manifest.
    const name = from.isSource ? undefined : (await api.inspectRepo(from.path)).packageName;
    const res = await editStructure('connect', { source: { path: from.path, name }, target });
    select({ type: 'edge', id: `${res.repoIndex}:${res.packageIndex}` });
  }

  async function removeSelectedLink() {
    const edge = findSelection();
    if (!edge) return;
    st.draft = removeLink(st.draft, edge.repoIndex, edge.packageIndex);
    st.selection = null;
    await runCheck();
    renderInspector();
  }

  async function removeSelectedRepo() {
    const node = findSelection();
    if (!node) return;
    const links = st.check.graph.edges.filter((e) => e.source === node.id || e.target === node.id).length;
    const ok = await api.confirm({
      message: `Remove ${node.name}?`,
      detail: links
        ? `Its ${links} link${links === 1 ? '' : 's'} go too. Nothing changes on disk until you save.`
        : 'Nothing changes on disk until you save.',
      confirm: 'Remove repo'
    });
    if (!ok) return;
    await editStructure('removeRepo', { id: node.id });
    st.selection = null;
    renderInspector();
  }

  // ---- save bar -------------------------------------------------------------

  function renderSavebar() {
    const check = st.check;
    const messages = [];
    if (st.externalChange) {
      messages.push(
        h(
          'span',
          { class: 'warning' },
          'The config file changed on disk. ',
          h('button', { class: 'link', onclick: load }, 'Load it'),
          ' (drops your changes) or keep editing and save over it.'
        )
      );
    }
    if (st.saveError) messages.push(h('span', { class: 'error' }, st.saveError));
    else if (check && !check.ok) messages.push(h('span', { class: 'error' }, check.error.replace(/^Config error — /, '')));
    for (const w of check?.warnings || []) messages.push(h('span', { class: 'warning' }, `${w[0].toUpperCase()}${w.slice(1)} (ignored)`));
    for (const c of check?.cycles || []) {
      messages.push(h('span', { class: 'warning' }, `Loop: ${c.join(' → ')}. It repeats only if push is on along the way.`));
    }

    const isDirty = dirty();
    mount(
      savebar,
      h('div', { class: 'messages' }, messages),
      isDirty ? h('span', { class: 'muted' }, 'Unsaved changes') : h('span', { class: 'muted' }, st.exists ? 'Saved' : 'Not saved yet'),
      h('button', { disabled: !isDirty, onclick: discard }, 'Discard'),
      h('button', { class: 'primary', disabled: !isDirty || !check?.ok || st.saving, onclick: save }, 'Save')
    );
  }

  // ---- inspector ------------------------------------------------------------

  /** Values a dependent inherits for a key: its source's (triggers, branches) or the defaults. */
  function inheritedFor(repoIndex, key) {
    const effectiveDefaults = st.check?.resolved?.defaults ?? { ...defaults, ...(st.draft.defaults || {}) };
    const repo = st.draft.repos?.[repoIndex];
    if (key === 'triggers' && Array.isArray(repo?.triggers)) return repo.triggers;
    if (key === 'branches' && Array.isArray(repo?.branches)) return repo.branches;
    return effectiveDefaults[key];
  }

  /** Fields every dependent has, also used by the defaults. */
  function linkFields({ value, inherited, onChange, defaultsOnly = false }) {
    const f = (key, label, kind, extra = {}) =>
      field({ label, kind, value: value(key), inherited: inherited(key), onChange: (v) => onChange(key, v), ...extra });
    return [
      h(
        'div',
        { class: 'group' },
        h('h3', null, 'Update'),
        f('commands', 'Commands', 'lines', { hint: 'One per line, run in the repo. {pkgs} is the packages to update.' }),
        f('shell', 'Shell', 'text', {
          placeholder: inherited('shell') || 'sh, or cmd.exe on Windows',
          hint: 'For example bash or pwsh. {pkgs} is quoted for it.'
        }),
        f('commitMessage', 'Commit message', 'text', { hint: '{bumps} lists each source with its commit.' }),
        f('commitPaths', 'Files to commit', 'lines', { hint: 'Globs. Other files the commands change are left alone and reported.' })
      ),
      h(
        'div',
        { class: 'group' },
        h('h3', null, 'When'),
        f('triggers', 'Triggers', 'checks', { options: app.ctx.cli.triggers }),
        f('branches', 'Branches', 'lines', {
          placeholder: (inherited('branches') || []).join('\n') || "The source's default branch",
          hint: 'Source branches to react to.'
        }),
        defaultsOnly ? f('debounceMs', 'Wait after a push (ms)', 'number', { hint: 'Pushes within this window run once.' }) : null
      ),
      h(
        'div',
        { class: 'group' },
        h('h3', null, 'After the update'),
        f('push', 'Push the commit', 'bool', { hint: 'Pushing also triggers repos that depend on this one.' }),
        f('squash', 'Squash unpushed update commits', 'bool'),
        f('coalesce', 'Merge queued runs', 'bool', { hint: 'One run when several sources trigger it close together.' })
      ),
      h(
        'div',
        { class: 'group' },
        h('h3', null, 'Safety'),
        f('dirtyPolicy', 'With uncommitted work', 'select', {
          options: app.ctx.cli.dirtyPolicies,
          hint: 'selective commits only the files to commit; skip leaves the repo alone.'
        }),
        f('commandTimeout', 'Command timeout (s)', 'number'),
        f('waitTimeoutSec', 'Wait for the repo lock (s)', 'number', { hint: '0 waits as long as it takes.' }),
        f('staleLockSec', 'Treat a lock as stale after (s)', 'number')
      )
    ];
  }

  function renderDefaults() {
    const raw = st.draft;
    const graph = st.check?.graph ?? { nodes: [], edges: [] };
    mount(
      inspector,
      h(
        'header',
        null,
        h('h2', null, 'Defaults'),
        h('p', { class: 'muted' }, `Every dependent uses these unless it sets its own. ${graph.nodes.length} repos, ${graph.edges.length} links.`)
      ),
      field({
        label: 'Notifications',
        kind: 'bool',
        value: raw.notifications,
        inherited: true,
        onChange: (v) => edit((r) => setRootField(r, 'notifications', v)),
        hint: 'One desktop notification per push, when its updates finish.'
      }),
      linkFields({
        defaultsOnly: true,
        value: (key) => st.draft.defaults?.[key],
        inherited: (key) => defaults[key],
        onChange: (key, v) => edit((r) => setDefaultsField(r, key, v))
      })
    );
  }

  function repoFacts(node) {
    const facts = h('dl', { class: 'facts' }, h('dt', null, 'Checking'), h('dd', null, '…'));
    api.inspectRepo(node.path).then((info) => {
      const rows = [];
      if (!info.exists) rows.push(['Folder', h('span', { class: 'error' }, 'not found')]);
      else if (!info.isGit) rows.push(['Folder', 'not a git repo']);
      else {
        rows.push(['Branch', info.defaultBranch || 'unknown']);
        rows.push(['Remote', info.origin || 'no origin remote']);
      }
      if (info.packageName) rows.push(['Package', `${info.packageName} (${info.manifest})`]);
      mount(facts, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
    });
    return facts;
  }

  function renderNode(node) {
    const graph = st.check.graph;
    const dependents = graph.edges.filter((e) => e.source === node.id);
    const sources = graph.edges.filter((e) => e.target === node.id);
    const nameOf = (id) => graph.nodes.find((n) => n.id === id)?.name ?? id;
    const repo = node.repoIndex !== null ? st.draft.repos[node.repoIndex] : null;
    const linkItem = (edge, text) =>
      h('li', null, h('button', { class: 'link', onclick: () => select({ type: 'edge', id: edge.id }) }, text));

    mount(
      inspector,
      h('header', null, h('h2', null, node.name), h('code', { class: 'path' }, node.path)),
      repoFacts(node),
      repo
        ? h(
            'div',
            { class: 'group' },
            h('h3', null, 'As a source'),
            field({
              label: 'Package name',
              kind: 'text',
              value: repo.name,
              inherits: false,
              placeholder: node.id.split(/[\\/]/).pop(),
              hint: "Its name in the package manager: {pkgs} in its dependents' commands.",
              onChange: (v) => edit((r) => setRepoField(r, node.repoIndex, 'name', v))
            }),
            field({
              label: 'Branches',
              kind: 'lines',
              value: repo.branches,
              inherited: defaults.branches,
              placeholder: (st.draft.defaults?.branches || []).join('\n') || 'Its default branch',
              hint: 'Pushes to these branches trigger updates.',
              onChange: (v) => edit((r) => setRepoField(r, node.repoIndex, 'branches', v))
            }),
            field({
              label: 'Triggers',
              kind: 'checks',
              options: app.ctx.cli.triggers,
              value: repo.triggers,
              inherited: st.draft.defaults?.triggers ?? defaults.triggers,
              onChange: (v) => edit((r) => setRepoField(r, node.repoIndex, 'triggers', v))
            })
          )
        : null,
      h(
        'div',
        { class: 'group' },
        h('h3', null, 'Dependents'),
        dependents.length
          ? h('ul', { class: 'links' }, dependents.map((e) => linkItem(e, nameOf(e.target))))
          : h('p', { class: 'muted' }, 'None yet. Add one to update it after every push here.')
      ),
      sources.length
        ? h('div', { class: 'group' }, h('h3', null, 'Depends on'), h('ul', { class: 'links' }, sources.map((e) => linkItem(e, nameOf(e.source)))))
        : null,
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'primary', onclick: () => startConnect(node.id) }, 'Add dependent…'),
        h('button', { class: 'danger', onclick: removeSelectedRepo }, 'Remove repo')
      )
    );
  }

  function renderEdge(edge) {
    const graph = st.check.graph;
    const source = graph.nodes.find((n) => n.id === edge.source);
    const target = graph.nodes.find((n) => n.id === edge.target);
    const pkg = st.draft.repos[edge.repoIndex].packages[edge.packageIndex];
    const pkgs = st.check.pkgs?.[edge.target] || [];
    const { repoIndex, packageIndex } = edge;

    mount(
      inspector,
      h('header', null, h('h2', null, `${source?.name} → ${target?.name}`), h('code', { class: 'path' }, pkg.path)),
      h(
        'p',
        { class: 'muted' },
        `After a push to ${source?.name}, these commands run in ${target?.name}. `,
        pkgs.length ? ['{pkgs} here: ', h('code', null, pkgs.join(' '))] : null
      ),
      h(
        'div',
        { class: 'group' },
        field({
          label: 'Label',
          kind: 'text',
          value: pkg.name,
          inherits: false,
          placeholder: pkg.path.split(/[\\/]/).pop(),
          hint: 'Shown in notifications and the history.',
          onChange: (v) => edit((r) => setLinkField(r, repoIndex, packageIndex, 'name', v))
        })
      ),
      linkFields({
        value: (key) => pkg[key],
        inherited: (key) => inheritedFor(repoIndex, key),
        onChange: (key, v) => edit((r) => setLinkField(r, repoIndex, packageIndex, key, v))
      }),
      h('div', { class: 'actions' }, h('button', { class: 'danger', onclick: removeSelectedLink }, 'Remove link'))
    );
  }

  function renderInspector() {
    if (st.fileError) {
      mount(
        inspector,
        h('header', null, h('h2', null, 'The config file cannot be read')),
        h('p', { class: 'notice danger' }, st.fileError),
        h('p', null, 'Fix it in an editor; this view reloads when the file changes.'),
        h('div', { class: 'actions' }, h('button', { onclick: () => api.reveal('config') }, 'Show the file'))
      );
      return;
    }
    if (!st.draft) return;
    const sel = findSelection();
    if (!sel) return renderDefaults();
    if (st.selection.type === 'node') return renderNode(sel);
    return renderEdge(sel);
  }

  function renderAll() {
    updateGraph();
    renderSavebar();
    renderInspector();
  }

  load();

  return {
    async onChanged(what) {
      if (what === 'state' || what === 'tick') applyStatus();
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
      const node = st.check?.graph.nodes.find((n) => n.name === selector);
      if (node) select({ type: 'node', id: node.id });
    },
    destroy() {
      clearTimeout(checkTimer);
      document.removeEventListener('keydown', onKey);
      scheme.removeEventListener('change', onScheme);
      cy.destroy();
    }
  };
}
