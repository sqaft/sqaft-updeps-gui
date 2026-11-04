import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildGraph, baseName } from '../src/shared/graph.js';
import * as draft from '../src/shared/draft.js';
import { summarize, ago, duration } from '../src/shared/status.js';
import { cascade, mapLayout, islands, linkStates, lastPushes } from '../src/shared/tree.js';
import { parseLog, parseDoctor } from '../src/shared/parse.js';

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

test('describeChanges names each change by repo and link', () => {
  const after = draft.setLinkField(draft.connect(raw, { path: '~/w/web' }, { path: '~/w/docs' }, resolvePath).raw, 0, 0, 'push', true);
  assert.deepEqual(draft.describeChanges(raw, draft.setDefaultsField(after, 'push', true)), [
    'push of the defaults',
    'push of @acme/lib → app',
    'new link web → docs'
  ]);
  assert.deepEqual(draft.describeChanges(raw, draft.removeRepo(raw, '/home/me/w/web', resolvePath)), ['removed link @acme/lib → Web', 'removed repo web']);
  assert.deepEqual(draft.describeChanges(raw, raw), []);
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

// lib → core → (api, worker); core → billing → api; ui → web; a lone repo.
const tree = buildGraph(
  {
    repos: [
      { path: '/w/lib', name: '@acme/lib', packages: [{ path: '/w/core' }] },
      { path: '/w/core', name: '@acme/core', packages: [{ path: '/w/api' }, { path: '/w/worker' }, { path: '/w/billing' }] },
      { path: '/w/billing', name: '@acme/billing', packages: [{ path: '/w/api' }] },
      { path: '/w/ui', name: 'ui', packages: [{ path: '/w/web' }] },
      { path: '/w/alone' }
    ]
  },
  resolvePath
);

test('cascade: tree rows from the focused repo, a repo reached twice is not expanded again', () => {
  const c = cascade(tree, '/w/lib');
  assert.deepEqual(
    c.rows.map((r) => [r.prefix + baseName(r.edge.target), r.repeat, r.depth]),
    [
      ['└─ core', false, 0],
      ['   ├─ api', false, 1],
      ['   ├─ worker', false, 1],
      ['   └─ billing', false, 1],
      ['      └─ api', true, 2]
    ]
  );
  assert.equal(c.count, 4);
  assert.equal(c.depth, 2);
  assert.deepEqual(cascade(tree, '/w/api'), { rows: [], count: 0, depth: 0 });
});

test('mapLayout: a band per island, columns by steps from the sources, the repos without links last', () => {
  const size = { row: 40, gap: 10, head: 20, bandGap: 30 };
  const names = (ids) => ids.map((id) => baseName(id));
  const map = mapLayout(tree, size);
  assert.deepEqual(map.columns.map(names), [['lib', 'ui', 'alone'], ['core', 'web'], ['billing', 'worker'], ['api']]);
  assert.deepEqual(['/w/lib', '/w/billing', '/w/api', '/w/web', '/w/alone'].map((id) => map.column.get(id)), [0, 2, 3, 1, 0]);
  assert.deepEqual(map.bands, [
    { label: '@acme', size: 5, top: 0 },
    { label: 'ui', size: 2, top: 140 },
    { label: null, size: 1, top: 230 }
  ]);
  assert.deepEqual(['/w/ui', '/w/web', '/w/alone'].map((id) => map.band.get(id)), [1, 1, 2]);
  // billing and worker share core's centre; api sits between core and billing, the two repos it is linked to.
  assert.deepEqual(
    ['/w/lib', '/w/core', '/w/billing', '/w/worker', '/w/api', '/w/ui', '/w/web', '/w/alone'].map((id) => map.y.get(id)),
    [65, 65, 40, 90, 53, 180, 180, 270]
  );
  assert.equal(map.height, 290);
  assert.deepEqual(mapLayout({ nodes: [], edges: [] }, size), { columns: [[]], column: new Map(), y: new Map(), band: new Map(), bands: [], height: 0 });
});

test('mapLayout: a repo sits beside the repos it is linked to, without overlapping', () => {
  const g = buildGraph(
    {
      repos: [
        { path: '/w/root', packages: [{ path: '/w/a' }, { path: '/w/b' }, { path: '/w/c' }] },
        { path: '/w/c', packages: [{ path: '/w/d' }, { path: '/w/e' }] }
      ]
    },
    resolvePath
  );
  const map = mapLayout(g, { row: 40, gap: 10, head: 20, bandGap: 30 });
  // root sits level with the middle of a, b and c (c first: a source comes first in the config's order); d and e share c's centre as a block of two.
  assert.deepEqual(
    ['/w/root', '/w/c', '/w/a', '/w/b', '/w/d', '/w/e'].map((id) => map.y.get(id)),
    [115, 65, 115, 165, 40, 90]
  );
  assert.equal(map.height, 185);
});

test('islands: linked repos by steps from their sources, largest first, named by their scope', () => {
  const list = islands(tree);
  assert.deepEqual(
    list.map((i) => [i.label, i.ranks.map((rank) => rank.map((n) => baseName(n.id)))]),
    [
      ['@acme', [['lib'], ['core'], ['billing', 'worker'], ['api']]],
      ['ui', [['ui'], ['web']]],
      ['alone', [['alone']]]
    ]
  );
});

test('linkStates: running, queued and open failures over the latest journal result', () => {
  const states = linkStates(
    tree,
    status({
      activeRun: { source: '@acme/core', targetPath: '/w/worker', startedAt: 5 },
      queue: { pending: 1, jobs: [{ target: 'api', targetPath: '/w/api', sources: ['@acme/billing'] }] },
      openFailures: [{ source: '@acme/lib', targetPath: '/w/core', lastSeen: '2026-01-01T00:00:00Z', count: 2 }]
    }),
    [
      { source: '@acme/core', targetPath: '/w/api', status: 'committed', ts: '2026-01-02T00:00:00Z' },
      { source: '@acme/core', targetPath: '/w/api', status: 'failed', ts: '2026-01-01T00:00:00Z' },
      { source: '@acme/lib', targetPath: '/w/core', status: 'failed', ts: '2026-01-01T00:00:00Z' },
      { source: 'ui', targetPath: '/w/web', status: 'unchanged', ts: '2026-01-01T00:00:00Z' }
    ]
  );
  const kinds = Object.fromEntries([...states].map(([id, s]) => [id, s.kind]));
  assert.deepEqual(kinds, { '1:1': 'running', '2:0': 'queued', '0:0': 'failed', '1:0': 'updated', '3:0': 'same' });
  assert.equal(states.get('0:0').count, 2);

  const pushes = lastPushes(status({ lastRuns: [{ sourceRepo: '@acme/core', timestamp: 9, sha: 'abc1234' }] }), [
    { source: 'ui', ts: '1970-01-01T00:00:01Z', sourceSha: 'def5678aaaa' }
  ]);
  assert.deepEqual(Object.fromEntries(pushes), { '@acme/core': { ts: 9, sha: 'abc1234' }, ui: { ts: 1000, sha: 'def5678' } });
});

test('parseLog: time, level and repo; other lines continue the one before', () => {
  const lines = parseLog(
    [
      '2026-10-29T14:31:37.102Z [INFO] [@acme/core] push detected (branch: main)',
      '2026-10-29T14:31:38.000Z [ERROR] [@acme/api] npm update exited with code 1',
      'npm ERR! code ERESOLVE',
      '',
      '2026-10-29T14:31:39.000Z [INFO] Daemon started (pid 1), 3 source repos.'
    ].join('\n')
  );
  assert.deepEqual(lines, [
    { ts: '2026-10-29T14:31:37.102Z', level: 'INFO', repo: '@acme/core', msg: 'push detected (branch: main)' },
    { ts: '2026-10-29T14:31:38.000Z', level: 'ERROR', repo: '@acme/api', msg: 'npm update exited with code 1' },
    { ts: null, level: 'ERROR', repo: '@acme/api', msg: 'npm ERR! code ERESOLVE' },
    { ts: '2026-10-29T14:31:39.000Z', level: 'INFO', repo: null, msg: 'Daemon started (pid 1), 3 source repos.' }
  ]);
});

test('parseDoctor: sections, repo sections, problems and the summary', () => {
  const report = parseDoctor(
    [
      'Configuration',
      '  ✓ valid (2 source repos)',
      '',
      '@acme/core',
      '  ✓ git repo: ~/w/core',
      '  ✗ no origin remote configured',
      '  ! no reflog (no events yet, possibly): logs/refs/remotes/origin/main',
      '  ✓ target api: ~/w/api',
      '',
      '@acme/gone',
      '  ✗ folder not found',
      '  ✓ target web: ~/w/web',
      '',
      'Service',
      '  i the daemon resolves "node" from the PATH saved at "updeps start"',
      '',
      '2 problem(s) found.'
    ].join('\n')
  );
  assert.deepEqual(
    report.sections.map((s) => [s.title, s.isRepo, s.checks.map((c) => c.kind).join(' ')]),
    [
      ['Configuration', false, 'ok'],
      ['@acme/core', true, 'ok bad warn ok'],
      ['@acme/gone', true, 'bad ok'],
      ['Service', false, 'info']
    ]
  );
  assert.equal(report.summary, '2 problem(s) found.');
  assert.equal(report.problems, 2);
  assert.equal(report.warnings, 1);
});
