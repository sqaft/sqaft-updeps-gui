// The daemon's log in columns (time, level, repo, message), filtered by level
// and text, following new lines.
import { h, mount, keyButton, typing, plural, tildify } from '../dom.js';
import { parseLog } from '/shared/parse.js';

const LEVELS = ['all', 'info', 'warn', 'error'];

/**
 * Splits a message into parts to colour: a command, commit hashes, and the
 * words of a run that went through.
 * @param {string} msg
 */
function messageParts(msg) {
  if (msg.startsWith('$ ')) return [h('span', { class: 'cmd' }, msg)];
  const cls = /^(pushed|finished: .* 0 failed)/.test(msg) ? 'good' : null;
  return msg.split(/\b([0-9a-f]{7,12})\b/).map((part, i) => (i % 2 ? h('span', { class: 'sha' }, part) : cls ? h('span', { class: cls }, part) : part));
}

/**
 * @param {HTMLElement} root
 * @param {import('../app.js').App} app
 */
export function create(root, app) {
  const { api } = app;
  const st = { level: 'all', query: '', follow: true, lines: [], paused: 0 };

  const levels = h('div', { class: 'tabs' });
  const queryInput = h('input', {
    type: 'text',
    placeholder: 'text or repo',
    'aria-label': 'Filter lines',
    spellcheck: false,
    oninput: (e) => {
      st.query = e.target.value;
      render();
    },
    onkeydown: (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.target.blur();
      }
    }
  });
  const followButton = h('button', { class: 'toggle', onclick: () => setFollow(!st.follow) });
  const out = h('div', { class: 'log', tabindex: 0, 'aria-label': 'Log' });
  const bar = h('div', { class: 'logbar' });

  root.append(
    h(
      'div',
      { class: 'screen' },
      h(
        'main',
        null,
        h(
          'div',
          { class: 'toolbar' },
          levels,
          h('label', { class: 'prompt grow' }, h('span', { class: 'key' }, 'grep'), queryInput),
          followButton,
          keyButton(null, 'show the file', () => api.reveal('log'))
        ),
        out,
        bar
      )
    )
  );

  function setFollow(follow) {
    st.follow = follow;
    if (follow) load();
    else renderControls();
  }

  function renderControls() {
    mount(
      levels,
      LEVELS.map((l) =>
        h(
          'button',
          {
            'aria-pressed': String(st.level === l),
            onclick: () => {
              st.level = l;
              render();
            }
          },
          `[${l}]`
        )
      )
    );
    followButton.setAttribute('aria-pressed', String(st.follow));
    followButton.textContent = `${st.follow ? '[x]' : '[ ]'} follow new lines`;
  }

  function render() {
    renderControls();
    const q = st.query.trim().toLowerCase();
    const shown = st.lines.filter(
      (l) => (st.level === 'all' || l.level.toLowerCase() === st.level) && (!q || `${l.repo ?? ''} ${l.msg}`.toLowerCase().includes(q))
    );
    const atBottom = out.scrollTop + out.clientHeight >= out.scrollHeight - 4;
    mount(
      out,
      shown.length
        ? shown.map((l) =>
            h(
              'div',
              { class: `log-line l-${l.level.toLowerCase()}${l.ts ? '' : ' cont'}` },
              h('span', { class: 'time', title: l.ts ? new Date(l.ts).toLocaleString() : null }, l.ts ? new Date(l.ts).toLocaleTimeString([], { hour12: false }) : ''),
              h('span', { class: 'level' }, l.level),
              h(
                'span',
                { class: 'msg' },
                l.repo
                  ? [
                      h(
                        'button',
                        {
                          class: 'plain repo',
                          title: 'Show only this repo',
                          onclick: () => {
                            queryInput.value = l.repo;
                            st.query = l.repo;
                            render();
                          }
                        },
                        `[${l.repo}]`
                      ),
                      ' '
                    ]
                  : null,
                messageParts(l.msg)
              )
            )
          )
        : h('p', { class: 'empty', style: 'padding: 4px 20px' }, st.lines.length ? 'no lines match.' : 'the log is empty. the daemon writes here once it starts.')
    );
    if (st.follow || atBottom) out.scrollTop = out.scrollHeight;
    mount(
      bar,
      h('span', null, `${shown.length} of ${plural(st.lines.length, 'line')}`),
      st.paused ? h('span', { class: 'warning' }, `${plural(st.paused, 'new line')} paused; follow shows them`) : null,
      h('span', { class: 'path' }, tildify(app.ctx.cli.paths?.logFile))
    );
  }

  async function load() {
    const text = await api.readLog({ lines: 1000 }).catch(() => '');
    st.lines = parseLog(text);
    st.paused = 0;
    render();
  }

  load();
  return {
    hints: 'F follow · / grep · click a repo to filter',
    onKey(e) {
      if (typing() || e.metaKey || e.ctrlKey || e.altKey) return false;
      if (e.key === '/') {
        queryInput.focus();
        return true;
      }
      if (e.key === 'F') {
        setFollow(!st.follow);
        return true;
      }
      return false;
    },
    async onChanged(what) {
      if (what !== 'log') return;
      if (st.follow) return load();
      const text = await api.readLog({ lines: 1000 }).catch(() => '');
      const last = st.lines.findLast((l) => l.ts)?.ts;
      st.paused = parseLog(text).filter((l) => l.ts && (!last || l.ts > last)).length;
      render();
    }
  };
}
