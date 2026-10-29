// Views of the dependency graph for the Dependencies screen (pure): the tree
// of repos a push to one repo updates, the islands of linked repos, and what
// the daemon did last on each link.

/**
 * @typedef {import('./graph.js').GraphNode} GraphNode
 * @typedef {import('./graph.js').GraphEdge} GraphEdge
 * @typedef {{ nodes: GraphNode[], edges: GraphEdge[] }} Graph
 */

/**
 * @typedef {object} CascadeRow
 * @property {GraphEdge} edge
 * @property {string} prefix   tree drawing before the name, e.g. `│  └─ `
 * @property {boolean} repeat  the target is already listed above; its own dependents are not repeated
 * @property {number} depth    0 for the focused repo's direct dependents
 */

/**
 * The repos a push to `focusId` updates, as tree rows in config order. A repo
 * reached a second time is listed again (the link is real) but not expanded.
 * @param {Graph} graph
 * @param {string} focusId
 * @param {number} [maxDepth]
 * @returns {{ rows: CascadeRow[], count: number, depth: number }}
 *   count: distinct repos updated; depth: steps from the focused repo
 */
export function cascade(graph, focusId, maxDepth = 8) {
  const out = new Map();
  for (const e of graph.edges) {
    if (!out.has(e.source)) out.set(e.source, []);
    out.get(e.source).push(e);
  }
  const rows = [];
  const seen = new Set([focusId]);
  let depth = 0;
  const walk = (id, prefix, d) => {
    const list = out.get(id) || [];
    list.forEach((edge, i) => {
      const last = i === list.length - 1;
      const repeat = seen.has(edge.target);
      rows.push({ edge, prefix: prefix + (last ? '└─ ' : '├─ '), repeat, depth: d });
      if (repeat) return;
      seen.add(edge.target);
      depth = Math.max(depth, d + 1);
      if (d + 1 < maxDepth) walk(edge.target, prefix + (last ? '   ' : '│  '), d + 1);
    });
  };
  walk(focusId, '', 0);
  return { rows, count: seen.size - 1, depth };
}

/**
 * @typedef {object} Island
 * @property {string} label      the scope most of its repos share (`@acme`), else its first source's name
 * @property {GraphNode[][]} ranks  repos by steps from the sources: sources without a source of their own first
 */

/**
 * Splits the graph into groups of linked repos, largest first.
 * @param {Graph} graph
 * @returns {Island[]}
 */
export function islands(graph) {
  const order = new Map(graph.nodes.map((n, i) => [n.id, i]));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const near = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const e of graph.edges) {
    near.get(e.source)?.push(e.target);
    near.get(e.target)?.push(e.source);
  }
  const seen = new Set();
  const groups = [];
  for (const n of graph.nodes) {
    if (seen.has(n.id)) continue;
    const ids = [];
    const stack = [n.id];
    seen.add(n.id);
    while (stack.length) {
      const id = stack.pop();
      ids.push(id);
      for (const m of near.get(id)) {
        if (!seen.has(m)) {
          seen.add(m);
          stack.push(m);
        }
      }
    }
    groups.push(ids.sort((a, b) => order.get(a) - order.get(b)));
  }

  return groups
    .map((ids) => {
      const inside = new Set(ids);
      const edges = graph.edges.filter((e) => inside.has(e.source));
      // Longest path from a source; a loop stops growing after one pass per repo.
      const rank = new Map(ids.map((id) => [id, 0]));
      for (let pass = 0; pass < ids.length; pass++) {
        let changed = false;
        for (const e of edges) {
          if (rank.get(e.target) < rank.get(e.source) + 1) {
            rank.set(e.target, rank.get(e.source) + 1);
            changed = true;
          }
        }
        if (!changed) break;
      }
      const top = Math.max(...ids.map((id) => rank.get(id)));
      const ranks = Array.from({ length: top + 1 }, (_, r) => ids.filter((id) => rank.get(id) === r).map((id) => byId.get(id)));

      const scopes = new Map();
      for (const id of ids) {
        const scope = byId.get(id).name.match(/^@[^/]+/)?.[0];
        if (scope) scopes.set(scope, (scopes.get(scope) || 0) + 1);
      }
      const [scope, count] = [...scopes].sort((a, b) => b[1] - a[1])[0] || [null, 0];
      return { label: scope && count * 2 >= ids.length ? scope : ranks[0][0].name, ranks, size: ids.length };
    })
    .sort((a, b) => b.size - a.size)
    .map(({ label, ranks }) => ({ label, ranks }));
}

/**
 * @typedef {'running'|'queued'|'failed'|'updated'|'same'|'skipped'} LinkKind
 * @typedef {{ kind: LinkKind, ts: number|null, count?: number }} LinkState
 */

const KIND_OF_STATUS = { committed: 'updated', unchanged: 'same', skipped: 'skipped', failed: 'failed' };

/**
 * What the daemon is doing on each link, or did last: a running update, a
 * queued one and an open failure win over the latest journal record.
 * @param {Graph} graph
 * @param {any} status   `readStatus()` of the CLI API, or null
 * @param {any[]} history  target records from `readHistory()`, newest first
 * @returns {Map<string, LinkState>} by edge id
 */
export function linkStates(graph, status, history = []) {
  const nameOf = new Map(graph.nodes.map((n) => [n.id, n.name]));
  const states = new Map();
  // A record names its source by name and its target by path.
  const edgesFor = (sourceName, targetPath) => {
    const toTarget = graph.edges.filter((e) => e.target === targetPath);
    const named = toTarget.filter((e) => nameOf.get(e.source) === sourceName);
    return named.length ? named : toTarget.length === 1 ? toTarget : [];
  };
  const set = (edges, state) => {
    for (const e of edges) if (!states.has(e.id)) states.set(e.id, state);
  };

  if (status?.activeRun) {
    const r = status.activeRun;
    set(edgesFor(r.source, r.targetPath), { kind: 'running', ts: r.startedAt ?? null });
  }
  for (const job of status?.queue?.jobs || []) {
    const sources = job.sources?.length ? job.sources : [null];
    for (const s of sources) set(s ? edgesFor(s, job.targetPath) : edgesFor('', job.targetPath), { kind: 'queued', ts: null });
  }
  for (const f of status?.openFailures || []) {
    set(edgesFor(f.source, f.targetPath), { kind: 'failed', ts: Date.parse(f.lastSeen) || f.lastSeen || null, count: f.count });
  }
  for (const r of history) {
    const kind = KIND_OF_STATUS[r.status];
    if (kind) set(edgesFor(r.source, r.targetPath), { kind, ts: Date.parse(r.ts) || null });
  }
  return states;
}

/**
 * The latest push each source repo reacted to, by source name.
 * @param {any} status    `readStatus()`, or null
 * @param {any[]} history target records, newest first
 * @returns {Map<string, { ts: number, sha: string|null }>}
 */
export function lastPushes(status, history = []) {
  const pushes = new Map();
  for (const run of status?.lastRuns || []) {
    if (!pushes.has(run.sourceRepo)) pushes.set(run.sourceRepo, { ts: run.timestamp, sha: run.sha || null });
  }
  for (const r of history) {
    if (!pushes.has(r.source)) pushes.set(r.source, { ts: Date.parse(r.ts), sha: r.sourceSha ? r.sourceSha.slice(0, 7) : null });
  }
  return pushes;
}
