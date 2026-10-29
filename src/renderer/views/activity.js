// What the daemon is doing now: the running update with its latest log lines
// and the rest of its push, the queue, open failures, the daemon itself, and
// recent pushes.
import { h, mount, box, keyButton, glyph, spinner, LOOK, shortTime, typing, plural, tildify } from '../dom.js';
import { ago, duration, summarize } from '/shared/status.js';
import { parseLog } from '/shared/parse.js';

/**
 * @param {HTMLElement} root
 * @param {import('../app.js').App} app
 */
export function create(root, app) {
  const st = { run: null, logTail: [], confirm: false };
  const scroll = h('div', { class: 'scroll' });
  root.append(h('div', { class: 'screen' }, h('main', null, scroll)));

  /** Loads the running update's push from the journal and its latest log lines. */
  async function loadRun() {
    const active = app.status?.activeRun;
    if (!active) {
      st.run = null;
      st.logTail = [];
      return;
    }
    const [run, log] = await Promise.all([
      active.group ? app.api.readRun(active.group).catch(() => null) : null,
      app.api.readLog({ lines: 400 }).catch(() => '')
    ]);
    st.run = run;
    st.logTail = parseLog(log)
      .filter((l) => l.repo === active.target)
      .slice(-4);
  }

  function nowBox() {
    const status = app.status;
    const active = status.activeRun;
    const jobs = status.queue.jobs;
    const parts = [];
    if (active) {
      const start = st.run?.start;
      const done = st.run?.targets || [];
      parts.push(
        h(
          'div',
          { class: 'row' },
          h('span', { class: 's-running' }, spinner()),
          h('span', { class: 'title' }, `${active.source} → ${active.target}`),
          h('span', { class: 's-running elapsed', style: 'margin-left: auto' }, duration(Date.now() - active.startedAt)),
          active.dryRun ? h('span', { class: 'dim' }, 'dry run') : null
        ),
        st.logTail.length
          ? h(
              'pre',
              { class: 'output' },
              st.logTail.map((l) => `${l.ts ? l.ts.slice(11, 19) : '        '}  ${l.msg}`).join('\n')
            )
          : null,
        start ? h('span', { class: 'dim' }, `push ${(start.sha || '').slice(0, 7)} to ${start.source}, ${ago(start.ts)}:`) : null,
        h(
          'div',
          { class: 'steps' },
          done.map((t) => {
            const look = LOOK[t.status] || LOOK.none;
            return h('span', { class: look.cls }, glyph(t.status), ` ${t.target}`);
          }),
          h('span', { class: 's-running' }, spinner(), ` ${active.target}`),
          jobs.map((j) => h('span', { class: 's-queued' }, `· ${j.target}`))
        )
      );
    } else {
      parts.push(
        h(
          'p',
          { class: 'empty' },
          status.daemon.running ? 'nothing is running. updates start after a push to a source repo.' : 'the daemon is stopped. pushes are not watched until it starts.'
        )
      );
    }
    if (jobs.length) {
      parts.push(
        h(
          'div',
          { class: 'queue' },
          h('span', { class: 'dim' }, `queue · ${jobs.length}`),
          jobs.map((j) =>
            h(
              'div',
              null,
              h('span', { class: 's-queued' }, '·'),
              h('span', null, j.target),
              h('span', { class: 'why' }, status.daemon.running ? (j.sources?.length ? `waiting, from ${j.sources.join(', ')}` : 'waiting') : 'waits for the daemon')
            )
          )
        )
      );
    }
    return box('now', active ? 'busy' : null, parts);
  }

  function failuresBox() {
    const failures = app.status.openFailures;
    const retrying = app.busy && app.busyCommand === 'retry';
    return box(
      `open failures · ${failures.length}`,
      failures.length ? 'failing' : null,
      failures.length
        ? [
            h(
              'div',
              { class: 'row' },
              h('span', { class: 'dim', style: 'flex: 1 1 240px' }, 'a failed update stays here until the dependent updates successfully.'),
              keyButton('a', retrying ? 'retrying…' : 'retry all', retryAll, { disabled: app.busy })
            ),
            failures.map((f) =>
              h(
                'div',
                { class: 'failure' },
                h(
                  'div',
                  { class: 'head' },
                  h('span', { class: 's-failed' }, retrying ? spinner() : '✕'),
                  h('span', { class: 'title' }, `${f.source} → ${f.target}`),
                  h('span', { class: 'meta' }, `${f.count > 1 ? `${f.count} times, last ` : ''}${ago(f.lastSeen)}`)
                ),
                h('span', null, f.message),
                f.errorTail ? h('pre', { class: 'output' }, f.errorTail) : null,
                h(
                  'div',
                  { class: 'row' },
                  keyButton(null, 'retry', () => app.run(['retry', f.target]), { cls: 'primary', disabled: app.busy }),
                  keyButton(null, 'show run', () => app.go('history', f.target)),
                  keyButton(null, 'open the link', () => app.go('dependencies', f.source))
                )
              )
            )
          ]
        : h('p', { class: 'empty' }, 'none. a failed update stays here until the dependent updates successfully.')
    );
  }

  function serviceLine(service) {
    if (!service) return 'checking…';
    if (!service.file) return 'no service manager: a background process that does not start at login';
    if (!service.installed) return `not installed as a ${service.label} yet; starting the daemon installs it`;
    return `${service.label}${service.atLogin ? ', starts at login' : ''}`;
  }

  function daemonBox() {
    const { status, service } = app;
    const daemon = status.daemon;
    const s = summarize(status, service);
    const paths = app.ctx.cli.paths;
    return box(
      'daemon',
      s.problem ? 'failing' : null,
      h(
        'div',
        { class: 'row' },
        h('span', { class: daemon.running ? 's-updated' : 's-none' }, daemon.running ? '●' : '○'),
        h('span', { class: 'title' }, daemon.running ? 'running' : 'stopped'),
        h('span', { class: 'dim', style: 'margin-left: auto' }, daemon.running ? `started ${ago(daemon.startedAt)} · pid ${daemon.pid}` : 'pushes are not watched')
      ),
      h(
        'dl',
        { class: 'facts' },
        h('dt', null, 'service'),
        h('dd', null, serviceLine(service)),
        service?.nodeVersion ? [h('dt', null, 'node'), h('dd', null, service.nodeVersion, service.node ? h('span', { class: 'dim' }, ` ${tildify(service.node)}`) : null)] : null,
        daemon.running ? [h('dt', null, 'watching'), h('dd', null, plural(daemon.watchedRepos ?? 0, 'source repo'))] : null,
        paths?.configFile ? [h('dt', null, 'config'), h('dd', null, tildify(paths.configFile))] : null
      ),
      s.problem ? h('p', { class: 'error' }, s.problem) : null,
      daemon.running && daemon.stale ? h('p', { class: 'warning' }, 'the updeps code changed since it started. restart it to load the new code.') : null,
      h(
        'div',
        { class: 'row' },
        daemon.running
          ? [
              keyButton('R', 'restart', () => app.run(['restart']), { cls: 'primary', disabled: app.busy }),
              keyButton('x', 'stop', () => app.run(['stop']), { disabled: app.busy })
            ]
          : keyButton('s', 'start', () => app.run(['start']), { cls: 'primary', disabled: app.busy })
      )
    );
  }

  function marks(run) {
    const list = [
      ...Array(run.committed || 0).fill('committed'),
      ...Array(run.unchanged || 0).fill('unchanged'),
      ...Array(run.failed || 0).fill('failed'),
      ...Array(run.skipped || 0).fill('skipped')
    ];
    const shown = list.slice(0, 10).map((s) => h('span', { class: LOOK[s].cls }, LOOK[s].glyph));
    if (list.length > 10) shown.push(h('span', { class: 'dim' }, `+${list.length - 10}`));
    return shown;
  }

  function pushesBox() {
    const runs = app.status.lastRuns.slice(0, 12);
    return box(
      'recent pushes',
      'pushes',
      runs.length
        ? runs.map((r) =>
            h(
              'button',
              { class: 'push', onclick: () => app.go('history', r.group || r.sourceRepo), title: 'Show this push in the history' },
              h('span', { class: 'dim' }, shortTime(r.timestamp)),
              h('span', null, r.sourceRepo, h('span', { class: 'dim' }, ` ${r.trigger} ${r.sha || ''}`)),
              h('span', { class: 'marks' }, marks(r)),
              h('span'),
              h(
                'span',
                { class: 'summary' },
                [
                  r.committed ? `${r.committed} committed` : null,
                  r.unchanged ? `${r.unchanged} up to date` : null,
                  r.failed ? `${r.failed} failed` : null,
                  r.skipped ? `${r.skipped} skipped` : null
                ]
                  .filter(Boolean)
                  .join(', ') || 'nothing to update'
              )
            )
          )
        : h('p', { class: 'empty', style: 'padding: 4px 0 6px' }, 'no runs yet. updates start after a push to a source repo.')
    );
  }

  function runDataBox() {
    return box(
      'run data',
      'dashed',
      h('p', { class: 'dim' }, 'clearing deletes the queue, open failures, run history and logs. the config stays.'),
      st.confirm
        ? h(
            'div',
            { class: 'confirm' },
            h('span', null, 'clear run data? a running daemon is restarted.'),
            keyButton('y', 'clear', clear, { cls: 'danger' }),
            keyButton('n', 'keep', () => {
              st.confirm = false;
              render();
            })
          )
        : h(
            'button',
            {
              class: 'plain remove',
              disabled: app.busy,
              onclick: () => {
                st.confirm = true;
                render();
              }
            },
            h('span', { class: 'key' }, 'x'),
            ' clear run data…'
          )
    );
  }

  function retryAll() {
    if (!app.busy && app.status?.openFailures.length) app.run(['retry', '--failed']);
  }

  function clear() {
    st.confirm = false;
    app.run(['reset', '--yes']);
  }

  function render() {
    if (!app.status) return;
    const top = scroll.scrollTop;
    mount(
      scroll,
      h(
        'div',
        { class: 'columns' },
        h('div', { class: 'column' }, nowBox(), failuresBox()),
        h('div', { class: 'column', style: 'flex-basis: 380px' }, daemonBox(), pushesBox(), runDataBox())
      )
    );
    scroll.scrollTop = top;
  }

  async function refresh() {
    await loadRun();
    render();
  }

  // The running update's clock.
  const clock = setInterval(() => {
    const active = app.status?.activeRun;
    const el = scroll.querySelector('.elapsed');
    if (active && el) el.textContent = duration(Date.now() - active.startedAt);
  }, 1000);

  refresh();
  return {
    hints: 'a retry all · R restart · x stop · s start',
    onKey(e) {
      if (typing() || e.metaKey || e.ctrlKey || e.altKey) return false;
      const daemon = app.status?.daemon;
      if (st.confirm && (e.key === 'y' || e.key === 'n' || e.key === 'Escape')) {
        if (e.key === 'y') clear();
        else {
          st.confirm = false;
          render();
        }
        return true;
      }
      if (e.key === 'a') {
        retryAll();
        return true;
      }
      if (e.key === 'x' && daemon?.running && !app.busy) {
        app.run(['stop']);
        return true;
      }
      if (e.key === 's' && daemon && !daemon.running && !app.busy) {
        app.run(['start']);
        return true;
      }
      return false;
    },
    onChanged(what) {
      if (what === 'state' || what === 'log') refresh();
      else if (what === 'tick' || what === 'busy' || what === 'context') render();
    },
    destroy() {
      clearInterval(clock);
    }
  };
}
