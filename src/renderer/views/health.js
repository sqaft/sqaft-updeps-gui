// `updeps doctor` as a checklist: each source repo on one line (opened when
// something is wrong), then the config, commands on PATH, locks,
// notifications, the daemon, its service and loops.
import { h, mount, box, keyButton, spinner, stripAnsi, typing, plural } from '../dom.js';
import { parseDoctor } from '/shared/parse.js';

const GLYPH = { ok: '✓', bad: '✕', warn: '!', info: 'i' };

/**
 * @param {HTMLElement} root
 * @param {import('../app.js').App} app
 */
export function create(root, app) {
  const st = { checking: false, output: '', code: null, checkedAt: null, raw: false, open: new Set() };

  const runButton = keyButton('r', 'run again', check, { cls: 'primary' });
  const head = h('span', { class: 'row' });
  const rawButton = h('button', { class: 'toggle', style: 'margin-left: auto', onclick: () => toggleRaw() });
  const scroll = h('div', { class: 'scroll' });
  root.append(h('div', { class: 'screen' }, h('main', null, h('div', { class: 'toolbar' }, runButton, head, rawButton), scroll)));

  function toggleRaw() {
    st.raw = !st.raw;
    render();
  }

  async function check() {
    if (st.checking) return;
    st.checking = true;
    render();
    const { code, output } = await app.run(['doctor']);
    st.checking = false;
    st.code = code;
    st.output = stripAnsi(output).trim();
    st.checkedAt = new Date();
    // A repo with a problem opens by itself.
    for (const s of parseDoctor(st.output).sections) if (s.isRepo && s.checks.some((c) => c.kind === 'bad')) st.open.add(s.title);
    render();
  }

  const checkRow = (c) => h('span', { class: `check c-${c.kind}` }, h('span', { class: 'g' }, GLYPH[c.kind]), h('span', null, c.text));

  function repoRow(section) {
    const bad = section.checks.filter((c) => c.kind === 'bad').length;
    const warn = section.checks.filter((c) => c.kind === 'warn').length;
    const targets = section.checks.filter((c) => /^target \S+:/.test(c.text)).length;
    const open = st.open.has(section.title);
    const kind = bad ? 'bad' : warn ? 'warn' : 'ok';
    return h(
      'div',
      { class: `repo-check${bad ? ' bad' : ''}` },
      h(
        'button',
        {
          'aria-expanded': String(open),
          onclick: () => {
            if (open) st.open.delete(section.title);
            else st.open.add(section.title);
            render();
          }
        },
        h('span', { class: `c-${kind}` }, h('span', { class: 'g' }, GLYPH[kind])),
        h('span', { class: 'name' }, section.title),
        h('span', { class: 'side' }, bad ? plural(bad, 'problem') : warn ? `ok · ${plural(warn, 'warning')}` : `git · origin · reflog · ${plural(targets, 'target')}`)
      ),
      open ? h('div', { class: 'checks' }, section.checks.map(checkRow)) : null
    );
  }

  function render() {
    const report = parseDoctor(st.output);
    runButton.disabled = st.checking;
    rawButton.setAttribute('aria-pressed', String(st.raw));
    rawButton.textContent = `${st.raw ? '[x]' : '[ ]'} raw output`;

    const repos = report.sections.filter((s) => s.isRepo);
    const others = report.sections.filter((s) => !s.isRepo);
    const repoProblems = repos.reduce((n, s) => n + s.checks.filter((c) => c.kind === 'bad').length, 0);

    if (st.checking) mount(head, h('span', { class: 's-running' }, spinner(), ' checking…'), h('span', { class: 'dim' }, 'updeps doctor'));
    else if (!st.checkedAt) mount(head, h('span', { class: 'dim' }, 'not checked yet'));
    else {
      mount(
        head,
        report.problems
          ? h('span', { class: 's-failed' }, `✕ ${plural(report.problems, 'problem')} found`)
          : st.code === 0
            ? h('span', { class: 's-updated', style: 'font-weight: 700' }, '✓ no problems found')
            : h('span', { class: 's-failed' }, `✕ the check failed (exit code ${st.code ?? 'none'})`),
        h(
          'span',
          { class: 'dim' },
          [report.warnings ? plural(report.warnings, 'warning') : null, plural(repos.length, 'source repo'), `checked at ${st.checkedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`]
            .filter(Boolean)
            .join(' · ')
        )
      );
    }

    if (!st.output) {
      mount(scroll, st.checking ? null : h('p', { class: 'empty' }, 'checks that every repo in the config exists and has an origin remote, that the commands are on PATH, and that the daemon can start with the Node.js it is set up with.'));
      return;
    }
    if (st.raw || !report.sections.length) {
      mount(scroll, h('pre', { class: 'output', style: 'padding: 12px 14px; border: 1px solid var(--line-2)' }, st.output));
      return;
    }
    const top = scroll.scrollTop;
    mount(
      scroll,
      h(
        'div',
        { class: 'columns' },
        repos.length
          ? h('div', { class: 'column', style: 'flex-basis: 520px' }, box(`source repos · ${repos.length}`, `repos${repoProblems ? ' failing' : ''}`, repos.map(repoRow)))
          : null,
        h(
          'div',
          { class: 'column', style: 'flex-basis: 380px' },
          others.map((s) => box(s.title.toLowerCase(), s.checks.some((c) => c.kind === 'bad') ? 'failing' : null, s.checks.map(checkRow)))
        )
      )
    );
    scroll.scrollTop = top;
  }

  render();
  check();
  return {
    hints: 'r run again · o raw output',
    onKey(e) {
      if (typing() || e.metaKey || e.ctrlKey || e.altKey) return false;
      if (e.key === 'r') {
        check();
        return true;
      }
      if (e.key === 'o') {
        toggleRaw();
        return true;
      }
      return false;
    }
  };
}
