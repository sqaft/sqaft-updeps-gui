import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildGraph, baseName } from '../src/shared/graph.js';
import * as draft from '../src/shared/draft.js';
import { summarize, ago, duration } from '../src/shared/status.js';
import { downstream, mapLayout, linkStates, lastPushes } from '../src/shared/map.js';
import { parseLog, parseDoctor } from '../src/shared/parse.js';
import { shownTab, stepTab, appearance } from '../src/shared/tabs.js';
import { THEMES, isTheme, nextTheme } from '../src/shared/theme.js';
import { symbolKey } from '../src/shared/keys.js';

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
const sample = buildGraph(
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

test('downstream: the repos and links a push updates, the longest chain as its depth', () => {
  const d = downstream(sample, '/w/lib');
  assert.deepEqual([...d.repos].map(baseName).sort(), ['api', 'billing', 'core', 'lib', 'worker']);
  assert.equal(d.edges.size, 5);
  assert.equal(d.count, 4);
  // lib → core → billing → api
  assert.equal(d.depth, 3);
  const leaf = downstream(sample, '/w/api');
  assert.deepEqual([[...leaf.repos], leaf.edges.size, leaf.count, leaf.depth], [['/w/api'], 0, 0, 0]);
});

test('downstream: a loop is followed once', () => {
  const g = buildGraph(
    {
      repos: [
        { path: '/w/a', packages: [{ path: '/w/b' }] },
        { path: '/w/b', packages: [{ path: '/w/c' }] },
        { path: '/w/c', packages: [{ path: '/w/a' }] }
      ]
    },
    resolvePath
  );
  const d = downstream(g, '/w/a');
  assert.deepEqual([...d.repos].map(baseName).sort(), ['a', 'b', 'c']);
  assert.equal(d.edges.size, 3);
  assert.equal(d.count, 2);
  assert.equal(d.depth, 2);
});

test('mapLayout: columns by steps from the sources, groups one after another, the repos without links last', () => {
  const size = { row: 40, gap: 10, title: 20 };
  const names = (ids) => ids.map((id) => baseName(id));
  const map = mapLayout(sample, size);
  assert.deepEqual(map.columns.map(names), [['lib', 'ui', 'alone'], ['core', 'web'], ['billing', 'worker'], ['api']]);
  assert.deepEqual(names(map.order), ['lib', 'core', 'billing', 'worker', 'api', 'ui', 'web', 'alone']);
  assert.deepEqual(['/w/lib', '/w/billing', '/w/api', '/w/web', '/w/alone'].map((id) => map.column.get(id)), [0, 2, 3, 1, 0]);
  assert.deepEqual(map.loose, { ids: ['/w/alone'], top: 150 });
  // billing and worker share core's centre; api sits between core and billing, the two repos it is linked to.
  // The groups are a box gap apart: ui starts 10 below the 90 + 20 where the first group ends.
  assert.deepEqual(
    ['/w/lib', '/w/core', '/w/billing', '/w/worker', '/w/api', '/w/ui', '/w/web', '/w/alone'].map((id) => map.y.get(id)),
    [45, 45, 20, 70, 33, 120, 120, 190]
  );
  assert.equal(map.height, 210);
  assert.deepEqual(mapLayout({ nodes: [], edges: [] }, size), { columns: [[]], order: [], column: new Map(), y: new Map(), loose: null, height: 0 });
});

test('mapLayout: the repos without links fill the columns row by row under their heading', () => {
  const g = buildGraph({ repos: [{ path: '/w/a', packages: [{ path: '/w/b' }] }, { path: '/w/c' }, { path: '/w/d' }, { path: '/w/e' }] }, resolvePath);
  const map = mapLayout(g, { row: 40, gap: 10, title: 20 });
  assert.deepEqual(map.loose, { ids: ['/w/c', '/w/d', '/w/e'], top: 50 });
  assert.deepEqual(['/w/c', '/w/d', '/w/e'].map((id) => [map.column.get(id), map.y.get(id)]), [[0, 90], [1, 90], [0, 140]]);
  assert.equal(map.height, 160);
  const none = mapLayout(buildGraph({ repos: [{ path: '/w/a' }, { path: '/w/b' }] }, resolvePath), { row: 40, gap: 10, title: 20 });
  assert.deepEqual([none.loose.top, none.height], [0, 110]);
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
  const map = mapLayout(g, { row: 40, gap: 10, title: 20 });
  // root sits level with the middle of a, b and c (c first: a source comes first in the config's order); d and e share c's centre as a block of two.
  assert.deepEqual(
    ['/w/root', '/w/c', '/w/a', '/w/b', '/w/d', '/w/e'].map((id) => map.y.get(id)),
    [95, 45, 95, 145, 20, 70]
  );
  assert.equal(map.height, 165);
});

test('linkStates: running, queued and open failures over the latest journal result', () => {
  const states = linkStates(
    sample,
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

test('tabs: the active tab shows, else the first, and the active id is not replaced', () => {
  const ids = ['link', 'update', 'when'];
  assert.equal(shownTab(ids, 'update'), 'update');
  assert.equal(shownTab(['repo', 'dependents'], 'update'), 'repo');
  assert.equal(shownTab(ids, null), 'link');
  assert.equal(shownTab([], 'update'), null);
});

test('tabs: stepping stops at the ends', () => {
  const ids = ['link', 'update', 'when'];
  assert.equal(stepTab(ids, 'update', 1), 'when');
  assert.equal(stepTab(ids, 'when', 1), 'when');
  assert.equal(stepTab(ids, 'link', -1), 'link');
  assert.equal(stepTab(ids, null, 1), 'link');
  assert.equal(stepTab([], 'link', 1), null);
});

test('tabs: a tab that appears is selected once per selection', () => {
  let seen = null;
  const next = (scope, present) => {
    const r = appearance(seen, scope, present);
    seen = r.seenFor;
    return r.fresh;
  };
  assert.equal(next('a', false), false);
  assert.equal(next('a', true), true);
  assert.equal(next('a', true), false, 'not forced again on later ticks');
  assert.equal(next('b', true), true, 'another selection that has it');
  assert.equal(next('b', false), false);
  assert.equal(next('b', true), true, 'it went away and came back');
});

test('theme: the button cycles system, dark, light and back', () => {
  assert.deepEqual(THEMES, ['system', 'dark', 'light']);
  assert.equal(nextTheme('system'), 'dark');
  assert.equal(nextTheme('dark'), 'light');
  assert.equal(nextTheme('light'), 'system');
  assert.ok(isTheme('light'));
  assert.ok(!isTheme('auto') && !isTheme(undefined) && !isTheme(null));
});

test('symbolKey: [ ] and \\ with Option (macOS) or AltGr (Windows, Linux), not with Cmd or a plain Ctrl', () => {
  const press = (key, mods = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, ...mods });
  for (const key of ['[', ']', '\\']) {
    assert.equal(symbolKey(press(key), 'darwin'), key);
    // Turkish Q on a Mac: Option (with Shift) types the symbol.
    assert.equal(symbolKey(press(key, { altKey: true }), 'darwin'), key);
    assert.equal(symbolKey(press(key, { altKey: true, shiftKey: true }), 'darwin'), key);
    // AltGr on Windows reports Ctrl and Alt together; on Linux it may report Alt alone.
    assert.equal(symbolKey(press(key, { ctrlKey: true, altKey: true }), 'win32'), key);
    assert.equal(symbolKey(press(key, { altKey: true }), 'linux'), key);
    // Cmd always gives another meaning; so does Ctrl without AltGr, and Ctrl+Option on a Mac.
    assert.equal(symbolKey(press(key, { metaKey: true }), 'darwin'), null);
    assert.equal(symbolKey(press(key, { metaKey: true, altKey: true }), 'darwin'), null);
    assert.equal(symbolKey(press(key, { ctrlKey: true }), 'win32'), null);
    assert.equal(symbolKey(press(key, { ctrlKey: true }), 'linux'), null);
    assert.equal(symbolKey(press(key, { ctrlKey: true, altKey: true }), 'darwin'), null);
  }
  // Other keys are not symbols, whatever the modifiers.
  assert.equal(symbolKey(press('t'), 'darwin'), null);
  assert.equal(symbolKey(press('1', { altKey: true }), 'darwin'), null);
});
