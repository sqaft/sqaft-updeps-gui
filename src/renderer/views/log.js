// The daemon's raw log, following new lines.
import { h } from '../dom.js';

/**
 * @param {HTMLElement} root
 * @param {import('../app.js').App} app
 */
export function create(root, app) {
  const { api } = app;
  const out = h('pre', { class: 'output', tabindex: 0 });
  let follow = true;

  root.append(
    h(
      'div',
      { class: 'page log-page' },
      h(
        'header',
        null,
        h('h1', null, 'Log'),
        h(
          'div',
          { class: 'actions' },
          h(
            'label',
            { class: 'checks' },
            h('input', { type: 'checkbox', checked: true, onchange: (e) => (follow = e.target.checked) }),
            'Follow new lines'
          ),
          h('button', { onclick: () => api.reveal('log') }, 'Show the file')
        )
      ),
      out
    )
  );

  async function load() {
    const text = await api.readLog({ lines: 1000 });
    out.textContent = text || 'The log is empty. The daemon writes here once it starts.';
    if (follow) out.scrollTop = out.scrollHeight;
  }

  load();
  return {
    onChanged(what) {
      if (what === 'log' && follow) load();
    }
  };
}
