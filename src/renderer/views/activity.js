// What the daemon is doing now: its service, the running job and the queue,
// open failures, and recent runs.
import { h, mount, shortTime } from '../dom.js';
import { ago, duration, summarize } from '/shared/status.js';

/**
 * @param {HTMLElement} root
 * @param {import('../app.js').App} app
 */
export function create(root, app) {
  const page = h('div', { class: 'page' });
  root.append(page);

  function daemonSection() {
    const { status, service } = app;
    const s = summarize(status, service);
    const daemon = status.daemon;
    const serviceLine = !service
      ? null
      : !service.file
        ? 'No service manager: the daemon runs as a background process and does not start at login.'
        : service.installed
          ? `Installed as a ${service.label}${service.nodeVersion ? `, runs Node.js ${service.nodeVersion}` : ''}.`
          : `Not installed as a ${service.label} yet. Start the daemon to install it.`;
    return h(
      'section',
      { class: 'section' },
      h(
        'h2',
        null,
        'Daemon',
        h(
          'span',
          { class: 'actions' },
          daemon.running
            ? [
                h('button', { onclick: () => app.run(['restart']) }, 'Restart'),
                ' ',
                h('button', { onclick: () => app.run(['stop']) }, 'Stop')
              ]
            : h('button', { class: 'primary', onclick: () => app.run(['start']) }, 'Start')
        )
      ),
      h(
        'ul',
        { class: 'rows' },
        h(
          'li',
          null,
          h('span', { class: `lamp ${daemon.running ? 'on' : 'off'}` }),
          h('span', { class: 'title' }, daemon.running ? `Running, started ${ago(daemon.startedAt)}` : 'Stopped'),
          h('span', { class: 'side' }, daemon.running ? `pid ${daemon.pid}, ${daemon.watchedRepos} source repos` : null),
          serviceLine ? h('span', { class: 'detail' }, serviceLine) : null,
          s.problem ? h('span', { class: 'detail error' }, s.problem) : null,
          daemon.stale ? h('span', { class: 'detail' }, 'The updeps code changed since it started. Restart it to load the new code.') : null
        )
      )
    );
  }

  function nowSection() {
    const { activeRun, queue } = app.status;
    const rows = [];
    if (activeRun) {
      rows.push(
        h(
          'li',
          null,
          h('span', { class: 'lamp busy' }),
          h('span', { class: 'title' }, `${activeRun.source} → ${activeRun.target}`),
          h('span', { class: 'side' }, activeRun.dryRun ? 'dry run, ' : null, duration(Date.now() - activeRun.startedAt))
        )
      );
    }
    for (const job of queue.jobs) {
      rows.push(
        h(
          'li',
          null,
          h('span', { class: 'lamp off' }),
          h('span', { class: 'title' }, job.target),
          h('span', { class: 'side' }, job.sources?.length ? `waiting, from ${job.sources.join(', ')}` : 'waiting')
        )
      );
    }
    return h(
      'section',
      { class: 'section' },
      h('h2', null, 'Now'),
      rows.length ? h('ul', { class: 'rows' }, rows) : h('p', { class: 'empty' }, 'Nothing is running. Updates start after a push to a source repo.')
    );
  }

  function failuresSection() {
    const failures = app.status.openFailures;
    return h(
      'section',
      { class: 'section' },
      h(
        'h2',
        null,
        `Open failures${failures.length ? ` (${failures.length})` : ''}`,
        failures.length
          ? h('span', { class: 'actions' }, h('button', { onclick: () => app.run(['retry', '--failed']) }, 'Retry all'))
          : null
      ),
      failures.length
        ? h(
            'ul',
            { class: 'rows' },
            failures.map((f) =>
              h(
                'li',
                null,
                h('span', { class: 'lamp danger' }),
                h('span', { class: 'title' }, `${f.source} → ${f.target}`),
                h(
                  'span',
                  { class: 'side' },
                  `${f.count > 1 ? `${f.count} times, ` : ''}last ${ago(f.lastSeen)}`,
                  h('button', { onclick: () => app.go('history', f.target) }, 'Show run'),
                  h('button', { onclick: () => app.run(['retry', f.target]) }, 'Retry')
                ),
                h('span', { class: 'detail' }, f.message),
                f.errorTail ? h('pre', { class: 'output tail' }, f.errorTail) : null
              )
            )
          )
        : h('p', { class: 'empty' }, 'None. A failed update stays here until the dependent updates successfully.')
    );
  }

  function recentSection() {
    const runs = app.status.lastRuns.slice(0, 12);
    return h(
      'section',
      { class: 'section' },
      h('h2', null, 'Recent pushes'),
      runs.length
        ? h(
            'ul',
            { class: 'rows' },
            runs.map((r) =>
              h(
                'li',
                null,
                h('span', { class: `lamp ${r.failed ? 'danger' : r.committed ? 'on' : 'off'}` }),
                h('span', { class: 'title' }, r.sourceRepo, ' ', h('code', { class: 'muted' }, `${r.trigger} ${r.sha || ''}`)),
                h('span', { class: 'side' }, shortTime(r.timestamp)),
                h(
                  'span',
                  { class: 'detail' },
                  [
                    `${r.committed} committed`,
                    `${r.unchanged} up to date`,
                    r.failed ? `${r.failed} failed` : null,
                    r.skipped ? `${r.skipped} skipped` : null
                  ]
                    .filter(Boolean)
                    .join(', ')
                )
              )
            )
          )
        : h('p', { class: 'empty' }, 'No runs yet.')
    );
  }

  function render() {
    if (!app.status) return;
    mount(
      page,
      h('header', null, h('h1', null, 'Activity')),
      daemonSection(),
      nowSection(),
      failuresSection(),
      recentSection(),
      h(
        'section',
        { class: 'section' },
        h('h2', null, 'Run data'),
        h(
          'p',
          { class: 'muted' },
          'Clearing deletes the queue, open failures, run history and logs. The config stays. ',
          h(
            'button',
            {
              class: 'link',
              onclick: async () => {
                const ok = await app.api.confirm({
                  message: 'Clear run data?',
                  detail: 'The queue, open failures, run history and logs are deleted. A running daemon is restarted.',
                  confirm: 'Clear run data'
                });
                if (ok) app.run(['reset', '--yes']);
              }
            },
            'Clear run data…'
          )
        )
      )
    );
  }

  render();
  return {
    onChanged(what) {
      if (what === 'state' || what === 'tick' || what === 'context') render();
    }
  };
}
