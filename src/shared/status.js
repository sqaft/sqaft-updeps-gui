// Summary of the daemon's state for the tray and the activity view (pure).

/**
 * "5s ago", "3m ago", "2h ago", "4d ago".
 * @param {number|string|null|undefined} ts epoch ms or ISO date
 * @param {number} [now]
 * @returns {string}
 */
export function ago(ts, now = Date.now()) {
  const t = typeof ts === 'string' ? Date.parse(ts) : ts;
  if (!t) return 'never';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/**
 * @param {number} ms
 * @returns {string} "850ms", "12.4s", "3m 05s"
 */
export function duration(ms) {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;
}

/** What a service problem means for the daemon, in a few words. */
export const SERVICE_PROBLEMS = {
  'node-missing': 'Node.js not found on its PATH',
  'node-too-old': 'its Node.js is too old',
  'bin-missing': 'the updeps CLI it runs is gone',
  'different-install': 'it runs another updeps install'
};

/**
 * @typedef {object} Summary
 * @property {'unavailable'|'stopped'|'busy'|'failing'|'idle'} state  decides the tray icon
 * @property {string} badge     counts next to the icon on macOS, e.g. "⚠2 ⧗1"
 * @property {string} tooltip
 * @property {string} daemon    one line about the daemon
 * @property {string|null} problem  why the service cannot run, with the fix
 * @property {string|null} active   the job running now
 * @property {string[]} queued      dependents waiting behind it
 * @property {string|null} last     the latest finished run
 * @property {Array<{ id: string, label: string, target: string, source: string }>} failures
 */

/**
 * @param {ReturnType<import('@sqaft/updeps-cli/api').readStatus>|null} status  null when the CLI is not available
 * @param {ReturnType<import('@sqaft/updeps-cli/api').inspectService>|null} service
 * @returns {Summary}
 */
export function summarize(status, service) {
  if (!status) {
    return {
      state: 'unavailable',
      badge: '',
      tooltip: 'updeps: the updeps CLI was not found',
      daemon: 'updeps CLI not found',
      problem: null,
      active: null,
      queued: [],
      last: null,
      failures: []
    };
  }

  const { daemon, activeRun, queue, openFailures, lastRuns } = status;
  const jobs = queue?.jobs || [];
  const inFlight = jobs.length + (activeRun ? 1 : 0);
  const state = !daemon.running ? 'stopped' : activeRun ? 'busy' : openFailures.length ? 'failing' : 'idle';

  const badge = [openFailures.length ? `⚠${openFailures.length}` : '', inFlight ? `⧗${inFlight}` : '']
    .filter(Boolean)
    .join(' ');

  const problemText = service?.problem && SERVICE_PROBLEMS[service.problem];
  const problem = problemText
    ? service.problem === 'different-install'
      ? `The ${service.label} ${problemText}; restart the daemon to use this one`
      : `The daemon cannot run: ${problemText}; restart it after fixing that`
    : null;

  const tooltipParts = [
    daemon.running ? 'running' : 'daemon stopped',
    openFailures.length ? `${openFailures.length} open failure${openFailures.length === 1 ? '' : 's'}` : null,
    inFlight ? `${inFlight} job${inFlight === 1 ? '' : 's'} in progress` : null
  ].filter(Boolean);

  const lastRun = lastRuns?.[0];
  return {
    state,
    badge,
    tooltip: `updeps: ${tooltipParts.join(', ')}`,
    daemon: daemon.running ? `Daemon running (pid ${daemon.pid})` : 'Daemon stopped',
    problem,
    active: activeRun
      ? `${activeRun.source} → ${activeRun.target}${jobs.length ? ` (+${jobs.length} queued)` : ''}`
      : null,
    queued: jobs.map((j) => `${j.target}${j.sources?.length ? ` ← ${j.sources.join(', ')}` : ''}`),
    last: lastRun
      ? `Last run: ${lastRun.sourceRepo}, ${lastRun.committed} committed, ${lastRun.failed} failed`
      : null,
    failures: openFailures.map((f) => ({
      id: f.id,
      source: f.source,
      target: f.target,
      label: `${f.source} → ${f.target}${f.count > 1 ? ` ×${f.count}` : ''}: ${f.message}`
    }))
  };
}
