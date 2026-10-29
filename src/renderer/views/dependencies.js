// The dependency editor. Focus lists the repos a push to one repo updates, as
// a tree whose rows are links; Map shows every repo in islands of linked
// repos, one row per step from the sources. Edits go to a draft that the CLI
// checks as you type and that is written to the config file only on save.
import { h, mount, box, keyButton, glyph, LOOK, typing, plural, tildify } from '../dom.js';
import { field } from '../fields.js';
import { ago, duration } from '/shared/status.js';
import { cascade, islands, linkStates, lastPushes } from '/shared/tree.js';
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
  commitPaths: 'globs; other files the commands change are left alone and reported',
  push: 'pushing also triggers the repos that depend on this one',
  coalesce: 'one run when several sources trigger it close together',
  dirtyPolicy: 'with uncommitted work: selective commits only the files to commit, skip leaves the repo alone',
  waitTimeoutSec: '0 waits as long as it takes'
};

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
    mode: 'focus',
    focus: null, // node id
    selection: null, // { type: 'node' | 'edge', id }; null shows the defaults
    connectFrom: null, // node id while picking its new dependent
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
    'aria-label': 'Focus on a repo',
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
  const inspector = h('aside', { class: 'side-panel', 'aria-label': 'Details' });

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
      inspector
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

  function focusOn(id, { selectIt = true } = {}) {
    st.focus = id;
    st.mode = 'focus';
    st.query = null;
    search.value = nameOf(id);
    renderToolbar();
    if (selectIt) select({ type: 'node', id });
    else renderContent();
  }

  /** A repo picked from the map or the search: connects it while adding a dependent, else focuses it. */
  function pickRepo(id) {
    if (st.connectFrom) {
      const target = nodeById(id);
      if (id === st.connectFrom || !target) return endConnect();
      return connectTo({ path: target.path });
    }
    focusOn(id);
  }

  function setMode(mode) {
    st.mode = mode;
    if (mode === 'focus') st.connectFrom = null;
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

  function startConnect(fromId) {
    st.connectFrom = fromId;
    st.mode = 'map';
    renderToolbar();
    renderContent();
  }

  function endConnect() {
    st.connectFrom = null;
    st.mode = 'focus';
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
    st.focus = from.id;
    st.mode = 'focus';
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

  /** A node's live state: what runs, waits or failed on a link into it. */
  function nodeState(id, linkState) {
    let best = null;
    for (const e of graph().edges) {
      if (e.target !== id) continue;
      const kind = linkState.get(e.id)?.kind;
      if (kind === 'running') return 'running';
      if (kind === 'failed') best = 'failed';
      else if (kind === 'queued' && best !== 'failed') best = 'queued';
    }
    return best;
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
    mount(
      tabs,
      ['map', 'focus'].map((mode) =>
        h('button', { 'aria-pressed': String(st.mode === mode), onclick: () => setMode(mode), title: mode === 'map' ? 'Every repo (m)' : 'What a push to one repo updates (m)' }, `[${mode}]`)
      )
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

  // ---- content: focus and map --------------------------------------------------

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
    mount(content, st.mode === 'map' ? mapView() : focusView());
    content.scrollTop = scrollTop;
  }

  function focusView() {
    const g = graph();
    const focus = st.focus;
    const ls = states();
    const tree = cascade(g, focus);
    const pushes = lastPushes(app.status, st.history);
    const upstream = g.edges.filter((e) => e.target === focus);
    const focusNode = nodeById(focus);
    const push = pushes.get(focusNode?.name);
    const headSelected = st.selection?.type === 'node' && st.selection.id === focus;

    const rows = tree.rows.map((r) => {
      const state = ls.get(r.edge.id);
      const look = LOOK[state?.kind || 'none'];
      const cmd = String(effective(r.edge, 'commands')?.[0] ?? '').split(/\s+/).slice(0, 2).join(' ');
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

    const tally = new Map();
    for (const r of tree.rows) {
      if (r.repeat) continue;
      const kind = ls.get(r.edge.id)?.kind;
      if (kind) tally.set(kind, (tally.get(kind) || 0) + 1);
    }

    return h(
      'div',
      { class: 'stack' },
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
      ),
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

  function mapView() {
    const ls = states();
    const from = st.connectFrom;
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
      h('p', { class: 'dim' }, 'islands of linked repos. each row is one step further from the sources; pick a repo to focus it.'),
      islands(graph()).map((island) =>
        box(
          `${island.label} · ${plural(island.ranks.flat().length, 'repo')}`,
          'island',
          island.ranks.map((nodes, n) =>
            h(
              'div',
              { class: 'rank' },
              h('span', { class: 'n' }, String(n)),
              h(
                'div',
                { class: 'chips' },
                nodes.map((node) => {
                  const kind = nodeState(node.id, ls);
                  return h(
                    'button',
                    {
                      class: `chip${kind ? ` ${LOOK[kind].cls}` : ''}${node.id === from ? ' from' : ''}`,
                      'aria-selected': String(!from && node.id === st.focus),
                      onclick: () => pickRepo(node.id)
                    },
                    kind ? glyph(kind) : null,
                    kind ? ' ' : null,
                    node.name
                  );
                })
              )
            )
          )
        )
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
            hint: key === 'commands' ? '{pkgs} is the packages to update' : HINTS[key],
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
        node.id !== st.focus || st.mode !== 'focus' ? h('div', { class: 'row' }, keyButton('⏎', `focus ${node.name}`, () => focusOn(node.id))) : null
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
              hint: 'pushes to these branches trigger updates',
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
    const command = `$ ${String(effective(edge, 'commands')?.[0] ?? '').replace('{pkgs}', pkgs.join(' '))}`;
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
      live = box(['running ', duration(Date.now() - state.ts)], 'busy tinted', h('span', { class: 'muted' }, command), h('div', { class: 'row' }, keyButton('2', 'follow it in activity', () => app.go('activity'))));
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
          hint: key === 'commands' ? (pkgs.length ? `{pkgs} = ${pkgs.join(' ')}` : '{pkgs} is the packages to update') : key === 'branches' ? 'source branches to react to' : HINTS[key],
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

  /** Rows of the focus tree in order, the focused repo first. */
  function rowSelections() {
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
        setMode(st.mode === 'map' ? 'focus' : 'map');
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
        else if (st.selection?.type === 'node' && sel && sel.id !== st.focus) focusOn(sel.id);
        return !!sel;
      case 'j':
      case 'k':
      case 'ArrowDown':
      case 'ArrowUp': {
        if (st.mode !== 'focus') return false;
        const list = rowSelections();
        const i = list.findIndex((s) => st.selection && s.type === st.selection.type && s.id === st.selection.id);
        const down = e.key === 'j' || e.key === 'ArrowDown';
        const next = list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + (down ? 1 : -1)))];
        if (next) select(next);
        content.querySelector('.table-row[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
        return true;
      }
      default:
        return false;
    }
  }

  load();
  loadHistory();

  return {
    hints: 'j/k move · enter focus · / search · m map · s save',
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
