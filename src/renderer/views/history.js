// Every update from the journal, and one run in full.
import { h, mount, shortTime, RUN_STATUS } from '../dom.js';
import { duration } from '/shared/status.js';

/**
 * @param {HTMLElement} root
 * @param {import('../app.js').App} app
 */
export function create(root, app) {
  const { api } = app;
  const st = { failed: false, repo: '', since: '', selected: null, runSelector: null };

  const list = h('ul', { class: 'rows' });
  const detail = h('div', { class: 'run-detail' });
  const repoInput = h('input', {
    type: 'search',
    placeholder: 'Repo name',
    oninput: (e) => {
      st.repo = e.target.value.trim();
      loadList();
    }
  });
  const onlyFailed = h('select', {
    onchange: (e) => {
      st.failed = e.target.value === 'failed';
      loadList();
    }
  }, h('option', { value: 'all' }, 'All updates'), h('option', { value: 'failed' }, 'Failures only'));
  const since = h('select', {
    onchange: (e) => {
      st.since = e.target.value;
      loadList();
    }
  }, [['', 'Any time'], ['1h', 'Last hour'], ['1d', 'Last day'], ['1w', 'Last week']].map(([v, l]) => h('option', { value: v }, l)));

  root.append(
    h(
      'div',
      { class: 'page history' },
      h('div', null, h('header', null, h('h1', null, 'History')), h('div', { class: 'filters' }, onlyFailed, since, repoInput), list),
      detail
    )
  );

  async function loadList() {
    const records = await api.readHistory({ limit: 200, failed: st.failed, repo: st.repo || undefined, since: st.since || undefined });
    if (!records.length) {
      mount(list, h('li', null, h('span'), h('span', { class: 'empty' }, 'No updates match.')));
      return;
    }
    mount(
      list,
      records.map((r) => {
        const status = RUN_STATUS[r.status] || { lamp: 'off', label: r.status };
        const key = `${r.group}|${r.target}`;
        return h(
          'li',
          {
            class: 'selectable',
            tabindex: 0,
            'aria-selected': st.selected === key ? 'true' : 'false',
            onclick: () => showRun(r.group, key),
            onkeydown: (e) => e.key === 'Enter' && showRun(r.group, key)
          },
          h('span', { class: `lamp ${status.lamp}` }),
          h('span', { class: 'title' }, `${r.source} → ${r.target}`),
          h('span', { class: 'side' }, shortTime(r.ts)),
          h('span', { class: 'detail' }, `${status.label}: ${r.message || ''}`)
        );
      })
    );
  }

  /**
   * @param {string} selector group id, or a target/source name (its latest run)
   * @param {string} [key] list row to mark
   */
  async function showRun(selector, key) {
    st.selected = key ?? null;
    st.runSelector = selector;
    for (const li of list.children) li.setAttribute('aria-selected', 'false');
    loadList();
    const run = await api.readRun(selector);
    if (!run) {
      mount(detail, h('p', { class: 'empty' }, `No run found for ${selector}.`));
      return;
    }
    const { start, done, targets } = run;
    mount(
      detail,
      h('h2', null, start ? `Push to ${start.source}` : run.group),
      h(
        'p',
        { class: 'muted' },
        start ? `${start.trigger}${start.sha ? ` ${start.sha.slice(0, 7)}` : ''}, ${new Date(start.ts).toLocaleString()}` : null,
        start?.dryRun ? ', dry run' : null
      ),
      done
        ? h('p', null, `${done.committed} committed, ${done.unchanged} up to date, ${done.failed} failed, ${done.skipped} skipped`)
        : h('p', { class: 'muted' }, 'Still running, or the run was interrupted.'),
      targets.map((t) => {
        const status = RUN_STATUS[t.status] || { lamp: 'off', label: t.status };
        return h(
          'div',
          { class: 'target' },
          h('h3', null, h('span', { class: `lamp ${status.lamp}` }), t.target, h('span', { class: 'muted' }, duration(t.durationMs || 0))),
          (t.commands || []).length ? h('pre', { class: 'output' }, t.commands.map((c) => `$ ${c}`).join('\n')) : null,
          h('p', { class: t.status === 'failed' ? 'error' : null }, `${t.commitSha ? `${t.commitSha} ` : ''}${t.message || status.label}`),
          t.files?.length ? h('p', { class: 'muted' }, `Committed: ${t.files.join(', ')}`) : null,
          t.squashed?.length ? h('p', { class: 'muted' }, `Squashed: ${t.squashed.join(', ')}`) : null,
          t.pushed ? h('p', { class: 'muted' }, 'Pushed') : null,
          t.errorTail ? h('pre', { class: 'output' }, t.errorTail) : null,
          (t.warnings || []).map((w) => h('p', { class: 'notice' }, w))
        );
      })
    );
  }

  mount(detail, h('p', { class: 'empty' }, 'Choose an update to see its commands and output.'));
  loadList();

  return {
    onChanged(what) {
      if (what === 'journal') {
        loadList();
        if (st.runSelector) showRun(st.runSelector, st.selected ?? undefined);
      }
    },
    navigate(selector) {
      showRun(selector);
    }
  };
}
