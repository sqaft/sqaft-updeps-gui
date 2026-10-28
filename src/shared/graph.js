// Pure helpers shared by the main process, the renderer and the tests: no
// Node or DOM APIs. Paths are resolved by a function the caller passes in
// (`resolvePath` from @sqaft/updeps-cli/api in the main process).

/**
 * Last path segment, for both `/` and `\` separators.
 * @param {string} p
 * @returns {string}
 */
export function baseName(p) {
  const parts = String(p).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p);
}

/**
 * @typedef {object} GraphNode
 * @property {string} id                resolved path; one node per repo
 * @property {string} path              the path as the config writes it (first occurrence)
 * @property {string} name              display name: the source's package name, else a dependent's label, else the folder name
 * @property {number|null} repoIndex    index in `repos[]` when the repo is a source
 * @property {boolean} isSource
 * @property {boolean} isTarget
 */

/**
 * @typedef {object} GraphEdge
 * @property {string} id         `<repoIndex>:<packageIndex>`
 * @property {string} source     node id
 * @property {string} target     node id
 * @property {number} repoIndex
 * @property {number} packageIndex
 * @property {string} label      the dependent's label (`packages[].name`)
 */

/**
 * Builds the dependency graph from a raw config. Tolerates an invalid config:
 * entries without a usable path are left out, so the graph stays visible
 * while a field is being fixed.
 * @param {any} raw
 * @param {(p: string) => string} resolvePath
 * @returns {{ nodes: GraphNode[], edges: GraphEdge[] }}
 */
export function buildGraph(raw, resolvePath) {
  /** @type {Map<string, GraphNode>} */
  const nodes = new Map();
  const edges = [];
  const repos = Array.isArray(raw?.repos) ? raw.repos : [];
  const usable = (p) => typeof p === 'string' && p.trim() !== '';

  const node = (rawPath) => {
    const id = resolvePath(rawPath);
    if (!nodes.has(id)) {
      nodes.set(id, { id, path: rawPath, name: baseName(id), repoIndex: null, isSource: false, isTarget: false });
    }
    return nodes.get(id);
  };

  repos.forEach((repo, repoIndex) => {
    if (!repo || !usable(repo.path)) return;
    const n = node(repo.path);
    if (n.repoIndex === null) {
      n.repoIndex = repoIndex;
      n.isSource = true;
      n.path = repo.path;
      if (usable(repo.name)) n.name = repo.name;
    }
  });

  repos.forEach((repo, repoIndex) => {
    if (!repo || !usable(repo.path) || !Array.isArray(repo.packages)) return;
    const source = resolvePath(repo.path);
    repo.packages.forEach((pkg, packageIndex) => {
      if (!pkg || !usable(pkg.path)) return;
      const t = node(pkg.path);
      t.isTarget = true;
      if (!t.isSource && usable(pkg.name) && t.name === baseName(t.id)) t.name = pkg.name;
      edges.push({
        id: `${repoIndex}:${packageIndex}`,
        source,
        target: t.id,
        repoIndex,
        packageIndex,
        label: usable(pkg.name) ? pkg.name : baseName(t.id)
      });
    });
  });

  return { nodes: [...nodes.values()], edges };
}
