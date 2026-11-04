// Builds a self-contained demo of the app from mock data and takes the README's
// screenshots of it:
//
//   npm run screenshots:demo
//
// The demo is eight small git repos under `<temp>/home/code/`, a config linking
// them in layers, and a state file, journal and log written in the shapes the
// updeps daemon writes, with every time relative to now: a history of updates,
// one open failure, one running update and two queued ones. Everything lives in
// a fresh temporary directory that is removed afterwards. `HOME` and the XDG
// variables point there, so neither the real config, state and journal nor
// Electron's real profile are read or written; the run stops if any path the
// CLI or Electron would use is outside it. The pid file holds this process's
// pid, so the daemon shows as running without one being started. macOS and
// Linux only.
//
// `buildDemo(root)` is the reusable part: it sets the environment of the
// current process to the demo and returns it for a child to run in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { locateCli } from '../src/main/cli.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(REPO_ROOT, 'docs', 'screenshots');
const MIN = 60_000;
const PNG_WIDTH = 1800;

/** The screenshots: the argument of scripts/screenshots.js and the file it is saved as. */
export const SHOTS = [
  { spec: 'dependencies:@acme/design-tokens+1440x700+dark', file: 'dependencies-dark.png' },
  { spec: 'dependencies:@acme/design-tokens+1440x700+light', file: 'dependencies-light.png' },
  { spec: 'history+1440x700+dark', file: 'history-dark.png' },
  { spec: 'settings+960x600+dark+autostart', file: 'settings-dark.png' }
];

/**
 * The repos: folder, package name and the repos it depends on. A repo with
 * dependents is a source; the `push` and `commands` of a repo apply to every
 * link into it.
 */
const REPOS = [
  { dir: 'design-tokens', pkg: '@acme/design-tokens', version: '2.3.0', deps: [] },
  { dir: 'shared-config', pkg: '@acme/shared-config', version: '1.8.1', deps: [] },
  { dir: 'ui-kit', pkg: '@acme/ui-kit', version: '4.1.0', deps: ['design-tokens', 'shared-config'], push: true },
  { dir: 'api-client', pkg: '@acme/api-client', version: '3.6.2', deps: ['shared-config'], push: true },
  { dir: 'web-app', pkg: '@acme/web-app', version: '0.0.0', deps: ['ui-kit', 'api-client'] },
  { dir: 'admin-console', pkg: '@acme/admin-console', version: '0.0.0', deps: ['ui-kit', 'api-client'] },
  { dir: 'mobile-app', pkg: '@acme/mobile-app', version: '0.0.0', deps: ['design-tokens', 'api-client'], commands: ['npm install {pkgs} --no-audit --no-fund'] },
  { dir: 'billing-service', pkg: '@acme/billing-service', version: '0.0.0', deps: ['api-client', 'shared-config'] }
];
const byDir = Object.fromEntries(REPOS.map((r) => [r.dir, r]));

/**
 * The pushes in the history, oldest first: the source, minutes ago and what
 * each dependent did (`C` committed, `U` up to date, `F` failed). A `retry` is
 * `updeps retry` run by hand on the open failure.
 */
const HISTORY = [
  { source: 'shared-config', ago: 2760, results: { 'ui-kit': 'C', 'api-client': 'C', 'billing-service': 'C' } },
  { source: 'ui-kit', ago: 2758, results: { 'web-app': 'C', 'admin-console': 'C' } },
  { source: 'api-client', ago: 2757, results: { 'web-app': 'C', 'admin-console': 'U', 'mobile-app': 'C', 'billing-service': 'U' } },
  { source: 'design-tokens', ago: 1860, results: { 'ui-kit': 'C', 'mobile-app': 'C' } },
  { source: 'ui-kit', ago: 1858, results: { 'web-app': 'C', 'admin-console': 'C' } },
  { source: 'api-client', ago: 600, results: { 'web-app': 'C', 'admin-console': 'C', 'mobile-app': 'U', 'billing-service': 'C' } },
  { source: 'shared-config', ago: 190, results: { 'ui-kit': 'C', 'api-client': 'C', 'billing-service': 'F' } },
  { source: 'ui-kit', ago: 188, results: { 'web-app': 'C', 'admin-console': 'C' } },
  { source: 'api-client', ago: 187, results: { 'web-app': 'C', 'admin-console': 'U', 'mobile-app': 'C', 'billing-service': 'C' } },
  { source: 'shared-config', ago: 125, retry: true, results: { 'billing-service': 'F' } },
  { source: 'design-tokens', ago: 52, results: { 'ui-kit': 'C', 'mobile-app': 'U' } },
  { source: 'ui-kit', ago: 51, results: { 'web-app': 'C', 'admin-console': 'C' } },
  { source: 'api-client', ago: 18, results: { 'web-app': 'C', 'admin-console': 'C', 'mobile-app': 'C', 'billing-service': 'C' } }
];

const FAILURE_TAIL = [
  'npm error code ETARGET',
  'npm error notarget No matching version found for @acme/shared-config@^1.9.0.',
  'npm error notarget In most cases you or one of your dependencies are requesting',
  "npm error notarget a package version that doesn't exist."
].join('\n');

const sha = (seed, length = 40) => crypto.createHash('sha1').update(seed).digest('hex').slice(0, length);

/** Whole number from a seed in [min, max]. */
const between = (seed, min, max) => min + (parseInt(sha(seed, 6), 16) % (max - min + 1));

const insideDir = (dir, file) => file === dir || file.startsWith(dir + path.sep);

/**
 * Stops unless every path is inside `root`.
 * @param {string} root
 * @param {Record<string, string>} paths  by what they are, for the message
 */
export function assertInside(root, paths) {
  const outside = Object.entries(paths).filter(([, p]) => !insideDir(root, path.resolve(p)));
  if (outside.length) {
    throw new Error(`refusing to continue, outside ${root}: ${outside.map(([k, p]) => `${k}=${p}`).join(', ')}`);
  }
}

function git(cwd, args, env) {
  const res = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.error}`);
  return res.stdout.trim();
}

/** Newest mtime of the CLI's own JS, the way the daemon's stale check measures it. */
function newestSourceMtime(cliRoot) {
  let newest = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  };
  for (const sub of ['src', 'bin']) if (fs.existsSync(path.join(cliRoot, sub))) walk(path.join(cliRoot, sub));
  return newest;
}

/** Creates the git repos with a manifest and one commit each. */
function createRepos(home, env) {
  for (const repo of REPOS) {
    const dir = path.join(home, 'code', repo.dir);
    fs.mkdirSync(dir, { recursive: true });
    const manifest = {
      name: repo.pkg,
      version: repo.version,
      ...(repo.version === '0.0.0' ? { private: true } : {}),
      dependencies: Object.fromEntries(repo.deps.map((d) => [byDir[d].pkg, `^${byDir[d].version}`]))
    };
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    git(dir, ['init', '-q', '-b', 'main'], env);
    git(dir, ['remote', 'add', 'origin', `https://git.example.com/acme/${repo.dir}.git`], env);
    git(dir, ['add', '.'], env);
    git(dir, ['commit', '-q', '-m', 'Initial commit'], env);
  }
}

/** The config file's content. */
function buildConfig() {
  const sources = REPOS.filter((r) => REPOS.some((o) => o.deps.includes(r.dir)));
  return {
    notifications: true,
    defaults: {
      triggers: ['push'],
      commands: ['npm update {pkgs} --no-audit --no-fund'],
      commitMessage: 'chore(deps): bump {bumps}',
      commandTimeout: 300,
      debounceMs: 3000,
      push: false
    },
    repos: sources.map((source) => ({
      path: `~/code/${source.dir}`,
      name: source.pkg,
      packages: REPOS.filter((o) => o.deps.includes(source.dir)).map((target) => ({
        path: `~/code/${target.dir}`,
        name: target.pkg,
        ...(target.commands ? { commands: target.commands } : {}),
        ...(target.push ? { push: true } : {})
      }))
    }))
  };
}

/** The command a dependent runs: its commands with `{pkgs}` filled in. */
function commandOf(target) {
  const pkgs = target.deps.map((d) => byDir[d].pkg).join(' ');
  return (target.commands?.[0] ?? 'npm update {pkgs} --no-audit --no-fund').replace('{pkgs}', pkgs);
}

/**
 * The journal, the state and the log of a daemon that has been running for a
 * while, as the daemon's own code writes them.
 * @param {{ home: string, now: number, startedAt: number, pid: number }} opts
 */
function buildRecords({ home, now, startedAt, pid }) {
  const events = []; // { ts, record }
  const lines = []; // { ts, level, text }
  const pathOf = (repo) => path.join(home, 'code', repo.dir);
  const state = {
    repos: {},
    lastRuns: [],
    openFailures: [],
    activeRun: null,
    queue: { pending: 0, jobs: [] },
    daemon: { pid, startedAt, watchedRepos: REPOS.filter((r) => REPOS.some((o) => o.deps.includes(r.dir))).length },
    autoCommits: {},
    reflogTips: {}
  };
  const emit = (ts, record) => events.push({ ts, record });
  const log = (ts, level, text) => lines.push({ ts, level, text });
  let seq = 0;
  const groupId = (prefix, ts) => `${prefix}${ts.toString(36)}${(++seq).toString(36)}`;

  /** One finished target, as recordTargetResult writes it. */
  function target(t, { group, source, sourceSha, trigger, repo, status, durationMs }) {
    const label = repo.pkg;
    const command = commandOf(repo);
    const base = { kind: 'target', group, source: source.pkg, sourceSha: sourceSha.slice(0, 12), trigger, target: label, targetPath: pathOf(repo), status, durationMs };
    log(t - durationMs, 'INFO', `[${label}] starting update (source: ${source.pkg})`);
    log(t - durationMs, 'INFO', `[${label}] $ ${command}`);
    if (status === 'committed') {
      const message = `chore(deps): bump ${source.pkg}@${sourceSha.slice(0, 7)}`;
      const commitSha = sha(`${group}${label}`, 7);
      log(t, 'INFO', `[${label}] commit ${commitSha}: "${message}" (2 files)`);
      if (repo.push) {
        log(t, 'INFO', `[${label}] git push...`);
        log(t, 'INFO', `[${label}] push done`);
      }
      emit(t, { ...base, message, commands: [command], commitSha, files: ['package.json', 'package-lock.json'], pushed: Boolean(repo.push) });
      state.repos[pathOf(repo)] = {
        ...(state.repos[pathOf(repo)] || {}),
        lastUpdatedFrom: source.pkg,
        lastUpdatedSha: sourceSha.slice(0, 12),
        lastUpdatedAt: t,
        lastCommitMessage: message
      };
    } else if (status === 'unchanged') {
      log(t, 'INFO', `[${label}] no changes (up to date)`);
      emit(t, { ...base, message: 'no changes', commands: [command] });
    } else {
      const message = `command failed (${command}): exit code 1`;
      log(t, 'ERROR', `[${label}] command failed: exit code 1\n${FAILURE_TAIL}`);
      log(t, 'ERROR', `[${label}] ${message}`);
      emit(t, { ...base, message, commands: [command], errorTail: FAILURE_TAIL });
    }
    // A clean run resolves a standing failure for the pair; a failed one opens or repeats it.
    const id = `${source.pkg}->${label}`;
    const open = state.openFailures.find((f) => f.id === id);
    if (status === 'failed') {
      if (open) Object.assign(open, { message: `command failed (${command}): exit code 1`, errorTail: FAILURE_TAIL, lastSeen: t, count: open.count + 1, group });
      else {
        state.openFailures.unshift({ id, source: source.pkg, target: label, targetPath: pathOf(repo), message: `command failed (${command}): exit code 1`, errorTail: FAILURE_TAIL, firstSeen: t, lastSeen: t, count: 1, group });
      }
    } else {
      state.openFailures = state.openFailures.filter((f) => f.id !== id);
    }
  }

  /** The tally line, the group's journal record and its place in `lastRuns`. */
  function groupDone(t, { group, name, trigger, sha12, tally, sourceRepo }) {
    emit(t, { kind: 'group_done', group, source: name, trigger, sha: sha12, ...tally });
    state.lastRuns.unshift({ timestamp: t, group, sourceRepo: name, trigger, sha: sha12.slice(0, 7), ...tally });
    if (sourceRepo && sha12) state.repos[pathOf(sourceRepo)] = { ...(state.repos[pathOf(sourceRepo)] || {}), lastProcessedSha: sha(`${group}full`), lastProcessedAt: t };
    log(t, 'INFO', `[${name}] finished: ${tally.committed} committed, ${tally.unchanged} up to date, ${tally.failed} failed, ${tally.skipped} skipped`);
  }

  for (const entry of HISTORY) {
    const source = byDir[entry.source];
    const start = now - entry.ago * MIN;
    const manual = Boolean(entry.retry);
    const trigger = manual ? 'manual' : 'push';
    const group = groupId(manual ? 'retry' : 'g', start);
    const sourceSha = sha(`${source.dir}${entry.ago}`);
    const name = manual ? 'retry' : source.pkg;
    const sha12 = manual ? '' : sourceSha.slice(0, 12);
    const targets = Object.entries(entry.results);
    if (!manual) log(start - 3000, 'INFO', `[${source.pkg}] push detected (branch: main, sha: ${sourceSha.slice(0, 7)})`);
    emit(start, { kind: 'group_start', group, source: name, trigger, ...(manual ? {} : { sha: sha12 }), targetCount: targets.length });
    let t = start + (manual ? 0 : 3000);
    const tally = { committed: 0, unchanged: 0, failed: 0, skipped: 0 };
    for (const [dir, code] of targets) {
      const status = { C: 'committed', U: 'unchanged', F: 'failed' }[code];
      const durationMs = between(`${group}${dir}`, status === 'unchanged' ? 2200 : 6500, status === 'unchanged' ? 4800 : 14800);
      t += durationMs;
      target(t, { group, source, sourceSha: manual ? sha(`head${source.dir}`) : sourceSha, trigger, repo: byDir[dir], status, durationMs });
      tally[status]++;
    }
    groupDone(t + 100, { group, name, trigger, sha12, tally, sourceRepo: manual ? null : source });
  }

  // A push to the design tokens, 55 seconds ago: the first dependent is done and
  // pushed, the second one is running, and the first one's own dependents wait.
  const tokens = byDir['design-tokens'];
  const running = byDir['mobile-app'];
  const uiKit = byDir['ui-kit'];
  const pushStart = now - 55_000;
  const pushGroup = groupId('g', pushStart);
  const pushSha = sha('design-tokens-now');
  log(pushStart - 3000, 'INFO', `[${tokens.pkg}] push detected (branch: main, sha: ${pushSha.slice(0, 7)})`);
  emit(pushStart, { kind: 'group_start', group: pushGroup, source: tokens.pkg, trigger: 'push', sha: pushSha.slice(0, 12), targetCount: 2 });
  const firstEnd = pushStart + 3000 + 12_400;
  target(firstEnd, { group: pushGroup, source: tokens, sourceSha: pushSha, trigger: 'push', repo: uiKit, status: 'committed', durationMs: 12_400 });
  const queuedGroup = groupId('g', firstEnd);
  log(firstEnd + 1000, 'INFO', `[${uiKit.pkg}] push detected (branch: main, sha: ${sha7(`${pushGroup}ui-kit`)})`);
  emit(firstEnd + 4000, { kind: 'group_start', group: queuedGroup, source: uiKit.pkg, trigger: 'push', sha: sha(`${pushGroup}ui-kit`, 12), targetCount: 2 });
  log(firstEnd, 'INFO', `[${running.pkg}] starting update (source: ${tokens.pkg})`);
  log(firstEnd, 'INFO', `[${running.pkg}] $ ${commandOf(running)}`);
  state.activeRun = { group: pushGroup, source: tokens.pkg, target: running.pkg, targetPath: pathOf(running), startedAt: firstEnd, dryRun: false };
  const waiting = ['web-app', 'admin-console'].map((dir) => ({ target: byDir[dir].pkg, targetPath: pathOf(byDir[dir]), sources: [uiKit.pkg] }));
  state.queue = { pending: waiting.length, jobs: waiting };

  // The daemon's own lines: it restarted at `startedAt`, and once before the history began.
  log(now - 2900 * MIN, 'INFO', `Daemon started (pid ${pid - 1}), ${state.daemon.watchedRepos} source repos.`);
  log(startedAt - 2000, 'INFO', 'Received SIGTERM, shutting down...');
  log(startedAt, 'INFO', `Daemon started (pid ${pid}), ${state.daemon.watchedRepos} source repos.`);
  log(startedAt, 'INFO', `Reflog watcher: ${state.daemon.watchedRepos} file(s)`);

  events.sort((a, b) => a.ts - b.ts);
  lines.sort((a, b) => a.ts - b.ts);
  state.lastRuns = state.lastRuns.slice(0, 50);
  return {
    journal: events.map(({ ts, record }) => JSON.stringify({ ts: new Date(ts).toISOString(), ...record })).join('\n') + '\n',
    log: lines.map(({ ts, level, text }) => `${new Date(ts).toISOString()} [${level}] ${text}`).join('\n') + '\n',
    state
  };
}

const sha7 = (seed) => sha(seed, 7);

/**
 * Builds the demo under `root` and points this process's environment at it
 * (`HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_DATA_HOME`, `UPDEPS_CLI`,
 * `UPDEPS_NO_NOTICES`). The CLI is found with the app's own lookup, after the
 * environment is set, because the CLI fixes its paths when it is loaded.
 * @param {string} root  an empty directory, removed by the caller
 * @param {{ now?: number }} [opts]
 * @returns {Promise<{ root: string, home: string, env: NodeJS.ProcessEnv, cli: import('../src/main/cli.js').Cli }>}
 */
export async function buildDemo(root, { now = Date.now() } = {}) {
  root = fs.realpathSync(root);
  const home = path.join(root, 'home');
  const dirs = { HOME: home, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state'), XDG_DATA_HOME: path.join(root, 'data') };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  Object.assign(process.env, dirs, { UPDEPS_NO_NOTICES: '1' });
  if (os.homedir() !== home) throw new Error(`refusing to continue: the home directory is ${os.homedir()}, not ${home}`);

  const cli = await locateCli(process.env);
  process.env.UPDEPS_CLI = cli.root;
  const { paths } = cli.api;
  const pidFile = path.join(paths.stateDir, 'daemon.pid');
  assertInside(root, { ...paths, pidFile });

  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.com' };
  createRepos(home, gitEnv);

  const raw = buildConfig();
  const check = cli.api.checkConfig(raw);
  if (!check.ok) throw new Error(`the demo config is invalid: ${check.error}`);
  if (check.warnings.length || check.cycles.length) throw new Error(`the demo config has warnings or loops: ${[...check.warnings, ...check.cycles.map((c) => c.join(' → '))].join('; ')}`);
  cli.api.writeConfigFile(raw);

  // The daemon counts as running while this process lives. Its start must not be
  // older than the CLI's newest source file, or the app offers to restart it.
  const startedAt = Math.round(Math.max(now - 6 * 60 * MIN, newestSourceMtime(cli.root) + 1500));
  const records = buildRecords({ home, now, startedAt, pid: process.pid });
  fs.mkdirSync(path.dirname(paths.logFile), { recursive: true });
  fs.writeFileSync(paths.journalFile, records.journal);
  fs.writeFileSync(paths.logFile, records.log);
  fs.writeFileSync(paths.stateFile, JSON.stringify(records.state, null, 2) + '\n');
  fs.writeFileSync(pidFile, String(process.pid));
  assertNotStale(cli);

  const env = { ...process.env, SCREENSHOTS_ISOLATE: root };
  return { root, home, env, cli };
}

/** Stops if the daemon would show the "new updeps code" chip. */
function assertNotStale(cli) {
  const { daemon } = cli.api.readStatus();
  if (!daemon.running) throw new Error('the demo daemon does not show as running');
  if (daemon.stale) throw new Error('the CLI changed after the demo daemon "started"; run it again');
}

/** Runs scripts/screenshots.js under Electron and resolves with its exit code. */
function runElectron(demo, outDir) {
  const electron = createRequire(import.meta.url)('electron');
  return new Promise((resolve) => {
    // The script finds its arguments after its own relative path, so it is started from the repo root.
    const child = spawn(electron, ['scripts/screenshots.js', outDir, ...SHOTS.map((s) => s.spec)], { cwd: REPO_ROOT, env: demo.env, stdio: 'inherit' });
    child.on('close', (code) => resolve(code));
  });
}

/** Scales a PNG to PNG_WIDTH px with sips (macOS), which keeps the files small and the text legible. */
function shrink(file) {
  if (process.platform === 'darwin') spawnSync('sips', ['--resampleWidth', String(PNG_WIDTH), file], { stdio: 'ignore' });
}

async function main() {
  // Under /tmp where there is one: the app shows the config file's path, and this keeps it short.
  const root = fs.mkdtempSync(path.join(fs.existsSync('/tmp') ? '/tmp' : os.tmpdir(), 'updeps-demo-'));
  let failed = false;
  try {
    const demo = await buildDemo(root);
    const shots = path.join(demo.root, 'shots');
    const code = await runElectron(demo, shots);
    if (code !== 0) throw new Error(`the screenshots script exited with ${code}`);
    assertNotStale(demo.cli);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const { spec, file } of SHOTS) {
      const taken = path.join(shots, `${spec.replace(/[^\w-]+/g, '_')}.png`);
      const out = path.join(OUT_DIR, file);
      fs.copyFileSync(taken, out);
      shrink(out);
      console.log(`${path.relative(REPO_ROOT, out)} ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
    }
  } catch (err) {
    failed = true;
    console.error(err.message);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
