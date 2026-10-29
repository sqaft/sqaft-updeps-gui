// Every update from the journal, grouped by the push that started it, and one
// push in full: each update's commands, commit, files and output.
import { h, mount, box, keyButton, glyph, spinner, LOOK, shortTime, typing, plural } from '../dom.js';
import { duration } from '/shared/status.js';

const SPANS = [
  ['', 'any'],
  ['1h', '1h'],
  ['1d', '1d'],
  ['1w', '1w']
];

/**
 * @param {HTMLElement} root
 * @param {import('../app.js').App} app
 */
export function create(root, app) {
  const { api } = app;
  const st = {
    failed: false,
    since: '',
    query: '',
    records: [],
    selected: null, // { group, target|null }
    open: new Set(), // `${group}|${target}` expanded in the detail
    run: null
  };

  const filters = h('div', { class: 'row', style: 'gap: 10px 18px' });
  const queryInput = h('input', {
    type: 'text',
    placeholder: 'repo name',
    'aria-label': 'Filter by repo name',
    spellcheck: false,
    oninput: (e) => {
      st.query = e.target.value.trim().toLowerCase();
      renderList();
    },
    onkeydown: (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.target.blur();
      }
    }
  });
  const count = h('span', { class: 'count' });
  const list = h('div', { class: 'groups', 'aria-label': 'Updates' });
  const scroll = h('div', { class: 'scroll' }, list);
  const detail = h('aside', { class: 'side-panel wide', 'aria-label': 'Push' });

  root.append(
    h(
      'div',
      { class: 'screen' },
      h(
        'main',
        null,
        h('div', { class: 'toolbar' }, filters, h('label', { class: 'prompt grow' }, h('span', { class: 'key' }, '›'), queryInput, h('span', { class: 'hint' }, '/ filter')), count),
        scroll
      ),
      detail
    )
  );

  function renderFilters() {
    const tab = (text, on, onclick) => h('button', { 'aria-pressed': String(on), onclick }, text);
    mount(
      filters,
      h(
        'div',
        { class: 'tabs' },
        tab('[all]', !st.failed, () => setFailed(false)),
        tab('[failures]', st.failed, () => setFailed(true))
      ),
      h(
        'div',
        { class: 'tabs' },
        SPANS.map(([value, text]) =>
          tab(`[${text}]`, st.since === value, () => {
            st.since = value;
            renderFilters();
            loadList();
          })
        )
      )
    );
  }

  function setFailed(failed) {
    st.failed = failed;
    renderFilters();
    loadList();
  }

  async function loadList() {
    st.records = await api.readHistory({ limit: 300, failed: st.failed, since: st.since || undefined }).catch(() => []);
    if (!st.selected && st.records.length) {
      // The newest update that is still an open failure, else the newest one.
      const first = st.records.find((r) => r.status === 'failed' && isOpenFailure(r.source, r.target)) || st.records[0];
      st.selected = { group: first.group, target: first.target };
      loadRun();
    }
    renderList();
  }

  /** Target records by push, newest push first, each push's updates in the order they ran. */
  function groups() {
    const byGroup = new Map();
    for (const r of st.records) {
      if (!byGroup.has(r.group)) byGroup.set(r.group, { id: r.group, source: r.source, sha: r.sourceSha, trigger: r.trigger, ts: r.ts, targets: [] });
      byGroup.get(r.group).targets.unshift({ target: r.target, status: r.status, commitSha: r.commitSha, durationMs: r.durationMs });
    }
    const active = app.status?.activeRun;
    if (active?.group && !st.failed) {
      if (!byGroup.has(active.group)) {
        byGroup.set(active.group, { id: active.group, source: active.source, sha: null, trigger: 'push', ts: new Date(active.startedAt).toISOString(), targets: [] });
      }
      const g = byGroup.get(active.group);
      if (!g.targets.some((t) => t.target === active.target)) g.targets.push({ target: active.target, status: 'running' });
    }
    const q = st.query;
    return [...byGroup.values()]
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
      .map((g) => (!q || g.source.toLowerCase().includes(q) ? g : { ...g, targets: g.targets.filter((t) => t.target.toLowerCase().includes(q)) }))
      .filter((g) => g.targets.length);
  }

  function visibleRows() {
    return groups().flatMap((g) => g.targets.map((t) => ({ group: g.id, target: t.target })));
  }

  function renderList() {
    const all = groups();
    const updates = all.reduce((n, g) => n + g.targets.length, 0);
    count.textContent = `${plural(updates, 'update')} in ${plural(all.length, 'push', 'pushes')}`;
    const top = scroll.scrollTop;
    mount(
      list,
      all.length
        ? all.map((g) => {
            const current = st.selected?.group === g.id;
            return h(
              'div',
              { class: `group${current ? ' current' : ''}` },
              h(
                'button',
                { class: 'group-head', 'aria-selected': String(current && !st.selected.target), onclick: () => choose(g.id, null) },
                h('span', { class: 'time' }, shortTime(g.ts)),
                h('span', { class: 'source' }, g.source, h('span', { class: 'sha' }, ` ${g.trigger} ${(g.sha || '').slice(0, 7)}`)),
                h('span', { class: 'marks' }, g.targets.map((t) => h('span', { class: (LOOK[t.status] || LOOK.none).cls }, glyph(t.status))))
              ),
              g.targets.map((t, i) => {
                const look = LOOK[t.status] || LOOK.none;
                return h(
                  'button',
                  {
                    class: 'table-row',
                    'aria-selected': String(current && st.selected.target === t.target),
                    onclick: () => choose(g.id, t.target)
                  },
                  h('span', { class: 'name' }, h('span', { class: 'branch' }, i === g.targets.length - 1 ? '└─ ' : '├─ '), t.target),
                  h('span', { class: `status ${look.cls}` }, glyph(t.status), ` ${look.word}`),
                  h('span', { class: 'sub' }, t.commitSha || ''),
                  h('span', { class: 'sub dur' }, t.durationMs ? duration(t.durationMs) : '')
                );
              })
            );
          })
        : h('p', { class: 'empty' }, st.records.length ? 'no updates match.' : 'no updates yet. they appear here after a push to a source repo.')
    );
    scroll.scrollTop = top;
  }

  /**
   * @param {string} group
   * @param {string|null} target
   */
  function choose(group, target) {
    const changed = st.selected?.group !== group;
    st.selected = { group, target };
    if (target) st.open.add(`${group}|${target}`);
    renderList();
    if (changed) loadRun();
    else renderDetail();
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  async function loadRun() {
    const group = st.selected?.group;
    if (!group) return renderDetail();
    const run = await api.readRun(group).catch(() => null);
    if (st.selected?.group !== group) return;
    st.run = run;
    renderDetail();
  }

  function isOpenFailure(source, target) {
    return (app.status?.openFailures || []).some((f) => f.target === target && f.source === source);
  }

  function targetBox(run, t, source) {
    const key = `${run.group}|${t.target}`;
    const selected = st.selected?.target === t.target;
    const open = selected || st.open.has(key);
    const look = LOOK[t.status] || LOOK.none;
    const body = [];
    if (t.commands?.length) body.push(h('pre', { class: 'output' }, t.commands.map((c) => `$ ${c}`).join('\n')));
    if (t.status === 'committed' && t.commitSha) {
      body.push(h('span', { class: 'commit' }, h('span', { class: 'sha' }, t.commitSha), ` ${t.message || ''}`));
    } else if (t.status === 'running') {
      body.push(h('span', { class: 's-running' }, 'running now; its output streams in activity'));
    } else {
      body.push(h('span', { class: t.status === 'failed' ? 'error' : 'muted' }, t.message || look.word));
    }
    if (t.files?.length) body.push(h('span', { class: 'dim' }, `committed: ${t.files.join(', ')}`));
    if (t.status === 'committed') body.push(h('span', { class: 'dim' }, t.pushed ? 'pushed' : 'not pushed: push is off for this link'));
    if (t.squashed?.length) body.push(h('span', { class: 'dim' }, `squashed ${t.squashed.join(', ')} into this commit`));
    for (const w of t.warnings || []) body.push(h('span', { class: 'warning' }, `! ${w}`));
    if (t.errorTail) body.push(h('pre', { class: 'output' }, t.errorTail));
    const buttons = [];
    if (t.status === 'failed' && isOpenFailure(source, t.target)) {
      buttons.push(keyButton('r', 'retry', () => app.run(['retry', t.target]), { cls: 'primary', disabled: app.busy }));
    }
    if (t.status === 'running') buttons.push(keyButton('2', 'activity', () => app.go('activity')));
    buttons.push(keyButton(null, 'open the link', () => app.go('dependencies', source)));
    body.push(h('div', { class: 'row' }, buttons));

    return h(
      'div',
      { class: `target${selected ? ' selected' : ''}${t.status === 'failed' ? ' failed' : ''}` },
      h(
        'button',
        {
          'aria-expanded': String(open),
          onclick: () => {
            if (selected && open) st.open.delete(key);
            else st.open.add(key);
            st.selected = { group: run.group, target: t.target };
            renderList();
            renderDetail();
          }
        },
        h('span', { class: look.cls }, glyph(t.status)),
        h('span', { class: 'name' }, t.target),
        h('span', { class: `status ${look.cls}` }, look.word),
        h('span', { class: 'dur' }, t.durationMs ? duration(t.durationMs) : '')
      ),
      open ? h('div', { class: 'body' }, body) : null
    );
  }

  function renderDetail() {
    const run = st.run;
    if (!st.selected) {
      mount(detail, h('p', { class: 'empty' }, 'choose an update to see its commands and output.'));
      return;
    }
    if (!run) {
      mount(detail, h('p', { class: 'empty' }, 'no run found for this update.'));
      return;
    }
    const { start, done } = run;
    const source = start?.source ?? run.targets[0]?.source ?? '';
    const targets = [...run.targets];
    const active = app.status?.activeRun;
    if (active?.group === run.group && !targets.some((t) => t.target === active.target)) {
      targets.push({ target: active.target, status: 'running', commands: [] });
    }
    mount(
      detail,
      box(
        `push to ${source}`,
        done?.failed ? 'failing' : null,
        h(
          'span',
          { class: 'muted' },
          start ? `${start.trigger}${start.sha ? ` ${start.sha.slice(0, 7)}` : ''} · ${new Date(start.ts).toLocaleString()}${start.dryRun ? ' · dry run' : ''}` : run.group
        ),
        done
          ? h('span', { class: done.failed ? 'error' : 'muted' }, `${done.committed} committed, ${done.unchanged} up to date, ${done.failed} failed, ${done.skipped} skipped`)
          : h('span', { class: 's-running' }, active?.group === run.group ? [spinner(), ' still running'] : 'still running, or the run was interrupted')
      ),
      targets.map((t) => targetBox(run, t, source))
    );
  }

  function move(step) {
    const rows = visibleRows();
    if (!rows.length) return;
    const i = rows.findIndex((r) => r.group === st.selected?.group && r.target === st.selected?.target);
    const next = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + step))];
    choose(next.group, next.target);
  }

  renderFilters();
  renderDetail();
  loadList();

  return {
    hints: 'j/k move · f failures · r retry · / filter',
    onKey(e) {
      if (typing() || e.metaKey || e.ctrlKey || e.altKey) return false;
      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          move(1);
          return true;
        case 'k':
        case 'ArrowUp':
          move(-1);
          return true;
        case '/':
          queryInput.focus();
          return true;
        case 'f':
          setFailed(!st.failed);
          return true;
        case 'r': {
          const source = st.run?.start?.source;
          const target = st.selected?.target;
          if (!target || !isOpenFailure(source, target) || app.busy) return false;
          app.run(['retry', target]);
          return true;
        }
        default:
          return false;
      }
    },
    onChanged(what) {
      if (what === 'journal') {
        loadList();
        loadRun();
      } else if (what === 'state' || what === 'busy') {
        renderList();
        renderDetail();
      }
    },
    async navigate(selector) {
      const run = await api.readRun(selector).catch(() => null);
      if (!run) return;
      const target = run.targets.find((t) => t.target === selector) || run.targets.find((t) => t.status === 'failed') || null;
      st.failed = false;
      st.since = '';
      st.query = '';
      queryInput.value = '';
      renderFilters();
      st.selected = { group: run.group, target: target?.target ?? null };
      if (target) st.open.add(`${run.group}|${target.target}`);
      st.run = run;
      await loadList();
      renderDetail();
      list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'center' });
    }
  };
}
