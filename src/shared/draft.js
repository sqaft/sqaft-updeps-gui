// Edits to a raw config (the shape of the config file). Every function returns
// a new object and leaves fields it does not touch — including unknown and
// `_`-prefixed ones — exactly as they were.
import { baseName } from './graph.js';

const clone = (v) => structuredClone(v);

/**
 * Sets `obj[key]`, or removes the key when `value` is undefined, so the field
 * falls back to its inherited value.
 * @param {object} obj
 * @param {string} key
 * @param {unknown} value
 */
function assign(obj, key, value) {
  if (value === undefined) delete obj[key];
  else obj[key] = value;
}

/** @param {any} raw */
function withRepos(raw) {
  const next = clone(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {});
  if (!Array.isArray(next.repos)) next.repos = [];
  return next;
}

/**
 * @param {any} raw
 * @param {string} id resolved path
 * @param {(p: string) => string} resolvePath
 * @returns {number} index in `repos[]`, or -1
 */
export function sourceIndexOf(raw, id, resolvePath) {
  const repos = Array.isArray(raw?.repos) ? raw.repos : [];
  return repos.findIndex((r) => typeof r?.path === 'string' && r.path.trim() !== '' && resolvePath(r.path) === id);
}

/**
 * Adds a repo as a source with no dependents yet. Its package `name` is only
 * written when it differs from the folder name (the default).
 * @param {any} raw
 * @param {{ path: string, name?: string|null }} repo
 * @param {(p: string) => string} resolvePath
 * @returns {{ raw: object, index: number, added: boolean }}
 */
export function addRepo(raw, { path, name }, resolvePath) {
  const next = withRepos(raw);
  const existing = sourceIndexOf(next, resolvePath(path), resolvePath);
  if (existing !== -1) return { raw: next, index: existing, added: false };
  const entry = { path };
  if (name && name !== baseName(resolvePath(path))) entry.name = name;
  next.repos.push(entry);
  return { raw: next, index: next.repos.length - 1, added: true };
}

/**
 * Links a source to a dependent: the dependent's commands run after every push
 * of the source. A source that is not in `repos[]` yet is added.
 * @param {any} raw
 * @param {{ path: string, name?: string|null }} source
 * @param {{ path: string, name?: string|null }} target
 * @param {(p: string) => string} resolvePath
 * @returns {{ raw: object, repoIndex: number, packageIndex: number, added: boolean }}
 */
export function connect(raw, source, target, resolvePath) {
  const { raw: next, index: repoIndex } = addRepo(raw, source, resolvePath);
  const repo = next.repos[repoIndex];
  if (!Array.isArray(repo.packages)) repo.packages = [];
  const targetId = resolvePath(target.path);
  const existing = repo.packages.findIndex((p) => typeof p?.path === 'string' && resolvePath(p.path) === targetId);
  if (existing !== -1) return { raw: next, repoIndex, packageIndex: existing, added: false };
  const entry = { path: target.path };
  if (target.name && target.name !== baseName(targetId)) entry.name = target.name;
  repo.packages.push(entry);
  return { raw: next, repoIndex, packageIndex: repo.packages.length - 1, added: true };
}

/**
 * Removes one source → dependent link.
 * @param {any} raw
 * @param {number} repoIndex
 * @param {number} packageIndex
 * @returns {object}
 */
export function removeLink(raw, repoIndex, packageIndex) {
  const next = withRepos(raw);
  next.repos[repoIndex]?.packages?.splice(packageIndex, 1);
  return next;
}

/**
 * Removes a repo everywhere: its source entry and every link to it.
 * @param {any} raw
 * @param {string} id resolved path
 * @param {(p: string) => string} resolvePath
 * @returns {object}
 */
export function removeRepo(raw, id, resolvePath) {
  const next = withRepos(raw);
  const matches = (p) => typeof p === 'string' && p.trim() !== '' && resolvePath(p) === id;
  next.repos = next.repos.filter((r) => !matches(r?.path));
  for (const repo of next.repos) {
    if (Array.isArray(repo?.packages)) repo.packages = repo.packages.filter((p) => !matches(p?.path));
  }
  return next;
}

/**
 * @param {any} raw
 * @param {number} repoIndex
 * @param {string} key
 * @param {unknown} value undefined removes the field
 * @returns {object}
 */
export function setRepoField(raw, repoIndex, key, value) {
  const next = withRepos(raw);
  if (next.repos[repoIndex]) assign(next.repos[repoIndex], key, value);
  return next;
}

/**
 * @param {any} raw
 * @param {number} repoIndex
 * @param {number} packageIndex
 * @param {string} key
 * @param {unknown} value undefined removes the field (the dependent inherits it)
 * @returns {object}
 */
export function setLinkField(raw, repoIndex, packageIndex, key, value) {
  const next = withRepos(raw);
  const pkg = next.repos[repoIndex]?.packages?.[packageIndex];
  if (pkg) assign(pkg, key, value);
  return next;
}

/**
 * @param {any} raw
 * @param {string} key
 * @param {unknown} value undefined removes the field (the built-in default applies)
 * @returns {object}
 */
export function setDefaultsField(raw, key, value) {
  const next = withRepos(raw);
  next.defaults = next.defaults && typeof next.defaults === 'object' ? next.defaults : {};
  assign(next.defaults, key, value);
  if (Object.keys(next.defaults).length === 0) delete next.defaults;
  return next;
}

/**
 * @param {any} raw
 * @param {string} key  a root field such as `notifications`
 * @param {unknown} value
 * @returns {object}
 */
export function setRootField(raw, key, value) {
  const next = withRepos(raw);
  assign(next, key, value);
  return next;
}

/**
 * Deep equality for JSON values (key order ignored).
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function sameJson(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && sameJson(a[k], b[k]));
}
