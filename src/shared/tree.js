// Views of the dependency graph for the Dependencies screen (pure): the tree
// of repos a push to one repo updates, the islands of linked repos and every
// repo in columns for the map, and what the daemon did last on each link.

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
 * Places the repos of one island, a column per step, each near the repos it
 * is linked to in the columns before and after it: sweeps forward (towards
 * the repos that reach it), back (towards the repos it reaches) and forward
 * again.
 * @param {string[][]} ranks  ids by column
 * @param {GraphEdge[]} edges  the island's links
 * @param {number} pitch
 * @returns {Map<string, number>} vertical centre of each repo
 */
function placeIsland(ranks, edges, pitch) {
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
 * @typedef {object} MapBand
 * @property {string|null} label  the island's label; null for the repos without links
 * @property {number} size         its repos
 * @property {number} top          where its title goes; its repos start `head` below
 */

/**
 * @typedef {object} MapLayout
 * @property {string[][]} columns          every repo by column, band by band, top to bottom
 * @property {Map<string, number>} column  steps from the sources of its island
 * @property {Map<string, number>} y       vertical centre of each repo, 0 at the top
 * @property {Map<string, number>} band    index in `bands` of each repo
 * @property {MapBand[]} bands             top to bottom
 * @property {number} height
 */

/**
 * Every repo in columns, for the map. Each island of linked repos is a band,
 * largest first, with one column per step from its sources (the steps of
 * `islands`) and each repo placed near the repos it is linked to. The repos
 * without links share the last band, filling its columns row by row. Columns
 * line up across bands.
 * @param {Graph} graph
 * @param {{ row: number, gap: number, head: number, bandGap: number }} size
 *   a repo's box height, the gap between boxes, the room for a band's title above its repos, and the gap between bands
 * @returns {MapLayout}
 */
export function mapLayout(graph, { row, gap, head, bandGap }) {
  const pitch = row + gap;
  const linkedIds = new Set(graph.edges.flatMap((e) => [e.source, e.target]));
  const all = islands(graph);
  const linked = all.filter((i) => i.ranks.some((r) => r.some((n) => linkedIds.has(n.id))));
  const loose = all.filter((i) => !linked.includes(i)).flatMap((i) => i.ranks.flat().map((n) => n.id));
  const width = Math.max(1, ...linked.map((i) => i.ranks.length));

  const columns = Array.from({ length: width }, () => []);
  const column = new Map();
  const y = new Map();
  const band = new Map();
  const bands = [];
  let top = 0;

  for (const island of linked) {
    const ranks = island.ranks.map((r) => r.map((n) => n.id));
    const inside = new Set(ranks.flat());
    const center = placeIsland(ranks, graph.edges.filter((e) => inside.has(e.source) && inside.has(e.target)), pitch);
    const first = Math.min(...center.values());
    const last = Math.max(...center.values());
    ranks.forEach((ids, r) => {
      const sorted = [...ids].sort((a, b) => center.get(a) - center.get(b));
      for (const id of sorted) {
        column.set(id, r);
        y.set(id, Math.round(top + head + row / 2 + center.get(id) - first));
        band.set(id, bands.length);
      }
      columns[r].push(...sorted);
    });
    bands.push({ label: island.label, size: inside.size, top });
    top += Math.round(head + last - first + row + bandGap);
  }

  if (loose.length) {
    loose.forEach((id, i) => {
      column.set(id, i % width);
      y.set(id, Math.round(top + head + row / 2 + Math.floor(i / width) * pitch));
      band.set(id, bands.length);
      columns[i % width].push(id);
    });
    bands.push({ label: null, size: loose.length, top });
    top += head + Math.ceil(loose.length / width) * pitch - gap + bandGap;
  }

  return { columns, column, y, band, bands, height: Math.max(0, Math.round(top - bandGap)) };
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
