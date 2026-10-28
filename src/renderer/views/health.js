// `updeps doctor`: paths, remotes, commands on PATH, the service and its Node.js.
import { h, mount, stripAnsi } from '../dom.js';

/**
 * @param {HTMLElement} root
 * @param {import('../app.js').App} app
 */
export function create(root, app) {
  const result = h('div');
  const button = h('button', { class: 'primary', onclick: check }, 'Run health check');

  root.append(
    h(
      'div',
      { class: 'page' },
      h('header', null, h('h1', null, 'Health check'), h('div', { class: 'actions' }, button)),
      h(
        'p',
        { class: 'muted' },
        'Checks that every repo in the config exists and has an origin remote, that the commands are on PATH, ' +
          'and that the daemon can start with the Node.js it is set up with.'
      ),
      h('div', { class: 'section' }, result)
    )
  );

  async function check() {
    button.disabled = true;
    mount(result, h('p', { class: 'muted' }, 'Checking…'));
    const { code, output } = await app.run(['doctor']);
    button.disabled = false;
    mount(
      result,
      h('p', { class: code === 0 ? null : 'error' }, code === 0 ? 'No problems found.' : 'Problems found; see the lines marked ✗.'),
      h('pre', { class: 'output' }, stripAnsi(output).trim())
    );
  }

  check();
  return {};
}
