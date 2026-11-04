// Views of the dependency graph for the Dependencies screen (pure): the map's
// layout, what a push to one repo updates, and what the daemon did last on
// each link.

/**
 * @typedef {import('./graph.js').GraphNode} GraphNode
 * @typedef {import('./graph.js').GraphEdge} GraphEdge
 * @typedef {{ nodes: GraphNode[], edges: GraphEdge[] }} Graph
 */

/**
 * What a push to `id` updates: every repo and link reachable from it.
 * @param {Graph} graph
 * @param {string} id
 * @returns {{ repos: Set<string>, edges: Set<string>, count: number, depth: number }}
 *   repos: `id` and the repos reachable from it; edges: every link leaving one of them;
 *   count: the repos updated, `id` not counted; depth: steps along the longest chain
 *   from `id` (a link back to a repo already on the chain is not followed)
 */
export function downstream(graph, id) {
  const out = new Map();
  for (const e of graph.edges) {
    if (!out.has(e.source)) out.set(e.source, []);
    out.get(e.source).push(e);
  }
  const repos = new Set([id]);
  const stack = [id];
  while (stack.length) {
    for (const e of out.get(stack.pop()) || []) {
      if (!repos.has(e.target)) {
        repos.add(e.target);
        stack.push(e.target);
      }
    }
  }
  const edges = new Set(graph.edges.filter((e) => repos.has(e.source)).map((e) => e.id));

  const longest = new Map();
  const onChain = new Set();
  const steps = (from) => {
    if (longest.has(from)) return longest.get(from);
    onChain.add(from);
    let best = 0;
    for (const e of out.get(from) || []) if (!onChain.has(e.target)) best = Math.max(best, 1 + steps(e.target));
    onChain.delete(from);
    longest.set(from, best);
    return best;
  };
  return { repos, edges, count: repos.size - 1, depth: steps(id) };
}

/**
 * Splits the graph into groups of linked repos, largest first, each with its
 * repos by steps from the sources.
 * @param {Graph} graph
 * @returns {string[][][]}  per group, the ids of each step: sources without a source of their own first
 */
function components(graph) {
  const order = new Map(graph.nodes.map((n, i) => [n.id, i]));
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
      return Array.from({ length: top + 1 }, (_, r) => ids.filter((id) => rank.get(id) === r));
    })
    .sort((a, b) => b.flat().length - a.flat().length);
}

/**
 * Stacks the repos of one column in the order of the heights they want,
 * `pitch` apart: repos that would overlap form a block centred on the mean of
 * what they want. Writes each centre into `center`.
 * @param {string[]} ids
 * @param {Map<string, number>} want
 * @param {number} pitch
 * @param {Map<string, number>} center
 * @returns {string[]} the column's new order, top to bottom
 */
function stack(ids, want, pitch, center) {
  const sorted = [...ids].sort((a, b) => want.get(a) - want.get(b));
  const blocks = [];
  for (const id of sorted) {
    let block = { ids: [id], sum: want.get(id) };
    while (blocks.length) {
      const prev = blocks[blocks.length - 1];
      if (prev.sum / prev.ids.length + prev.ids.length * pitch <= block.sum / block.ids.length) break;
      block = { ids: [...prev.ids, ...block.ids], sum: prev.sum + block.sum - block.ids.length * prev.ids.length * pitch };
      blocks.pop();
    }
    blocks.push(block);
  }
  for (const b of blocks) b.ids.forEach((id, i) => center.set(id, b.sum / b.ids.length + i * pitch));
  return sorted;
}

/**
 * Places the repos of one group of linked repos, a column per step, each near the repos it
 * is linked to in the columns before and after it: sweeps forward (towards
 * the repos that reach it), back (towards the repos it reaches) and forward
 * again.
 * @param {string[][]} ranks  ids by column
 * @param {GraphEdge[]} edges  the group's links
 * @param {number} pitch
 * @returns {Map<string, number>} vertical centre of each repo
 */
function placeGroup(ranks, edges, pitch) {
  const col = new Map();
  const center = new Map();
  ranks.forEach((ids, r) =>
    ids.forEach((id, i) => {
      col.set(id, r);
      center.set(id, i * pitch);
    })
  );
  const order = ranks.map((ids) => [...ids]);
  const sweep = (r, forward) => {
    const want = new Map(
      order[r].map((id) => {
        const near = forward
          ? edges.filter((e) => e.target === id && col.get(e.source) < r).map((e) => center.get(e.source))
          : edges.filter((e) => e.source === id && col.get(e.target) > r).map((e) => center.get(e.target));
        return [id, near.length ? near.reduce((a, b) => a + b, 0) / near.length : center.get(id)];
      })
    );
    order[r] = stack(order[r], want, pitch, center);
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let r = 1; r < order.length; r++) sweep(r, true);
    if (pass === 0) for (let r = order.length - 2; r >= 0; r--) sweep(r, false);
  }
  return center;
}

/**
 * @typedef {object} MapLayout
 * @property {string[][]} columns          every repo by column, top to bottom
 * @property {string[]} order              the walking order: group by group, column by column, then the repos without links
 * @property {Map<string, number>} column  steps from the sources of its group
 * @property {Map<string, number>} y       vertical centre of each repo, 0 at the top
 * @property {{ ids: string[], top: number }|null} loose  the repos without links and where their heading goes; their boxes start `title` below
 * @property {number} height
 */

/**
 * Every repo in columns, for the map. Each group of linked repos has one
 * column per step from its sources and each repo sits near the repos it is
 * linked to; groups follow one another, largest first, a box gap apart, so
 * linked repos stay adjacent. The repos without links form one block at the
 * bottom, filling the columns row by row.
 * @param {Graph} graph
 * @param {{ row: number, gap: number, title: number }} size
 *   a repo's box height, the gap between boxes, and the room for the heading of the repos without links
 * @returns {MapLayout}
 */
export function mapLayout(graph, { row, gap, title }) {
  const pitch = row + gap;
  const linkedIds = new Set(graph.edges.flatMap((e) => [e.source, e.target]));
  const groups = components(graph);
  const linked = groups.filter((ranks) => ranks.flat().some((id) => linkedIds.has(id)));
  const loose = groups.filter((ranks) => !linked.includes(ranks)).flatMap((ranks) => ranks.flat());
  const width = Math.max(1, ...linked.map((ranks) => ranks.length));

  const columns = Array.from({ length: width }, () => []);
  const column = new Map();
  const y = new Map();
  const order = [];
  let top = 0;

  for (const ranks of linked) {
    const inside = new Set(ranks.flat());
    const center = placeGroup(ranks, graph.edges.filter((e) => inside.has(e.source) && inside.has(e.target)), pitch);
    const first = Math.min(...center.values());
    const last = Math.max(...center.values());
    ranks.forEach((ids, r) => {
      const sorted = [...ids].sort((a, b) => center.get(a) - center.get(b));
      for (const id of sorted) {
        column.set(id, r);
        y.set(id, Math.round(top + row / 2 + center.get(id) - first));
      }
      columns[r].push(...sorted);
      order.push(...sorted);
    });
    top += Math.round(last - first + row + gap);
  }

  if (!loose.length) return { columns, order, column, y, loose: null, height: Math.max(0, top - gap) };

  loose.forEach((id, i) => {
    column.set(id, i % width);
    y.set(id, Math.round(top + title + row / 2 + Math.floor(i / width) * pitch));
    columns[i % width].push(id);
  });
  order.push(...loose);
  return { columns, order, column, y, loose: { ids: loose, top }, height: top + title + Math.ceil(loose.length / width) * pitch - gap };
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
