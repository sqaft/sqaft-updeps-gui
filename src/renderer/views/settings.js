// The app's own settings. Each change applies at once.
import { h, mount, box } from '../dom.js';

/**
 * @param {HTMLElement} root
 * @param {import('../app.js').App} app
 */
export function create(root, app) {
  const scroll = h('div', { class: 'scroll' });
  root.append(h('div', { class: 'screen' }, h('main', null, scroll)));

  /** A checkbox-style toggle: `[x] label`. */
  const toggle = (label, on, onclick, disabled = false) =>
    h('button', { class: 'toggle', style: 'align-self: flex-start; padding: 0', 'aria-pressed': String(on), disabled, onclick }, `${on ? '[x]' : '[ ]'} ${label}`);

  function render() {
    const { autostart, startMinimized } = app.ctx;
    mount(
      scroll,
      h(
        'div',
        { class: 'stack', style: 'max-width: 520px' },
        box(
          'startup',
          null,
          toggle('start at login', autostart, () => app.api.setAutostart(!autostart)),
          toggle('start minimized', startMinimized, () => app.api.setStartMinimized(!startMinimized), !autostart),
          h('p', { class: 'dim' }, 'a start at login opens the app in the tray without its window.')
        )
      )
    );
  }

  render();
  return {
    onChanged(what) {
      if (what === 'context') render();
    }
  };
}
