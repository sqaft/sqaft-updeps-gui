import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildGraph, baseName } from '../src/shared/graph.js';
import * as draft from '../src/shared/draft.js';
import { summarize, ago, duration } from '../src/shared/status.js';

// Resolves like the CLI: `~` to a fixed home, everything else made absolute.
const resolvePath = (p) => (p.startsWith('~/') ? path.posix.join('/home/me', p.slice(2)) : path.posix.resolve('/', p));

const raw = {
  _comment: 'kept',
  defaults: { push: false },
  repos: [
    { path: '~/w/lib', name: '@acme/lib', packages: [{ path: '~/w/app' }, { path: '/home/me/w/web', name: 'Web' }] },
    { path: '/home/me/w/web', packages: [{ path: '~/w/app', extra: 1 }] }
  ]
};

test('baseName handles both separators', () => {
  assert.equal(baseName('/a/b/c'), 'c');
  assert.equal(baseName('C:\\w\\repo\\'), 'repo');
});

test('buildGraph: one node per resolved path, names from the source or the dependent label', () => {
  const g = buildGraph(raw, resolvePath);
  assert.deepEqual(
    g.nodes.map((n) => [n.id, n.name, n.isSource, n.isTarget]),
    [
      ['/home/me/w/lib', '@acme/lib', true, false],
      ['/home/me/w/web', 'web', true, true],
      ['/home/me/w/app', 'app', false, true]
    ]
  );
  assert.deepEqual(
    g.edges.map((e) => [e.id, e.source, e.target, e.label]),
    [
      ['0:0', '/home/me/w/lib', '/home/me/w/app', 'app'],
      ['0:1', '/home/me/w/lib', '/home/me/w/web', 'Web'],
      ['1:0', '/home/me/w/web', '/home/me/w/app', 'app']
    ]
  );
});

test('buildGraph tolerates an invalid config', () => {
  const g = buildGraph({ repos: [null, { path: '' }, { path: '/x', packages: [{}, { path: '/y' }] }] }, resolvePath);
  assert.deepEqual(g.nodes.map((n) => n.id), ['/x', '/y']);
  assert.deepEqual(g.edges.map((e) => e.id), ['2:1']);
  assert.deepEqual(buildGraph(null, resolvePath), { nodes: [], edges: [] });
});

test('addRepo: adds once, writes the name only when it differs from the folder', () => {
  const a = draft.addRepo(raw, { path: '~/w/new', name: 'new' }, resolvePath);
  assert.equal(a.added, true);
  assert.deepEqual(a.raw.repos[2], { path: '~/w/new' });
  const b = draft.addRepo(a.raw, { path: '/home/me/w/new', name: '@acme/new' }, resolvePath);
  assert.equal(b.added, false);
  assert.equal(b.index, 2);
  assert.deepEqual(draft.addRepo(raw, { path: '/n', name: '@x/n' }, resolvePath).raw.repos[2], { path: '/n', name: '@x/n' });
  assert.equal(raw.repos.length, 2, 'the input is not changed');
});

test('connect: makes a dependent-only repo a source, never duplicates a link', () => {
  const r = draft.connect(raw, { path: '~/w/app', name: '@acme/app' }, { path: '~/w/lib' }, resolvePath);
  assert.equal(r.added, true);
  assert.deepEqual(r.raw.repos[2], { path: '~/w/app', name: '@acme/app', packages: [{ path: '~/w/lib' }] });
  assert.deepEqual([r.repoIndex, r.packageIndex], [2, 0]);

  const again = draft.connect(r.raw, { path: '/home/me/w/app' }, { path: '/home/me/w/lib' }, resolvePath);
  assert.equal(again.added, false);
  assert.deepEqual([again.repoIndex, again.packageIndex], [2, 0]);
});

test('removeRepo removes its source entry and every link to it; removeLink one link', () => {
  const next = draft.removeRepo(raw, '/home/me/w/web', resolvePath);
  assert.deepEqual(next.repos, [{ path: '~/w/lib', name: '@acme/lib', packages: [{ path: '~/w/app' }] }]);
  assert.equal(next._comment, 'kept');
  assert.deepEqual(draft.removeLink(raw, 0, 0).repos[0].packages, [{ path: '/home/me/w/web', name: 'Web' }]);
});

test('field setters keep unknown fields and remove a key set to undefined', () => {
  let r = draft.setLinkField(raw, 1, 0, 'commands', ['yarn up {pkgs}']);
  assert.deepEqual(r.repos[1].packages[0], { path: '~/w/app', extra: 1, commands: ['yarn up {pkgs}'] });
  r = draft.setLinkField(r, 1, 0, 'commands', undefined);
  assert.deepEqual(r.repos[1].packages[0], { path: '~/w/app', extra: 1 });
  r = draft.setDefaultsField(r, 'push', undefined);
  assert.equal('defaults' in r, false, 'an empty defaults object is dropped');
  r = draft.setRootField(r, 'notifications', false);
  assert.equal(r.notifications, false);
  assert.equal(draft.setRepoField(raw, 0, 'branches', ['main']).repos[0].branches[0], 'main');
});

test('sameJson ignores key order', () => {
  assert.equal(draft.sameJson({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }), true);
  assert.equal(draft.sameJson({ a: 1 }, { a: 1, b: undefined }), false);
  assert.equal(draft.sameJson([1], { 0: 1 }), false);
});

const status = (over = {}) => ({
  daemon: { running: true, pid: 42, startedAt: 0, watchedRepos: 3, stale: false },
  activeRun: null,
  queue: { pending: 0, jobs: [] },
  openFailures: [],
  lastRuns: [],
  ...over
});

test('summarize: tray state, macOS badge and menu lines', () => {
  assert.equal(summarize(null, null).state, 'unavailable');
  assert.equal(summarize(status({ daemon: { running: false } }), null).state, 'stopped');
  assert.equal(summarize(status(), null).state, 'idle');

  const busy = summarize(
    status({
      activeRun: { source: 'lib', target: 'app' },
      queue: { pending: 1, jobs: [{ target: 'web', sources: ['lib'] }] },
      openFailures: [{ id: 'f', source: 'lib', target: 'api', message: 'exit code 1', count: 2 }]
    }),
    { problem: 'node-missing', label: 'launchd agent' }
  );
  assert.equal(busy.state, 'busy');
  assert.equal(busy.badge, '⚠1 ⧗2');
  assert.equal(busy.active, 'lib → app (+1 queued)');
  assert.deepEqual(busy.queued, ['web ← lib']);
  assert.equal(busy.failures[0].label, 'lib → api ×2: exit code 1');
  assert.match(busy.problem, /Node\.js not found/);

  assert.equal(summarize(status({ openFailures: [{ source: 'a', target: 'b', message: 'm' }] }), null).state, 'failing');
});

test('ago and duration', () => {
  assert.equal(ago(0), 'never');
  assert.equal(ago(1000, 61_000), '1m ago');
  assert.equal(ago('2026-01-01T00:00:00Z', Date.parse('2026-01-03T00:00:00Z')), '2d ago');
  assert.equal(duration(850), '850ms');
  assert.equal(duration(12_400), '12.4s');
  assert.equal(duration(185_000), '3m 05s');
});
