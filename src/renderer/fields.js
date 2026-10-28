import { h } from './dom.js';

/**
 * How an inherited value reads in a placeholder or an "Inherit" option.
 * @param {unknown} value
 * @returns {string}
 */
function describe(value) {
  if (value === undefined || value === null || value === '') return 'not set';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'none';
  return String(value);
}

/**
 * A form field bound to one config key. An unset key inherits: the inherited
 * value shows as the placeholder (or the "Inherit" option), and "Use inherited"
 * removes a value set here. Edits are reported as they happen; the field
 * keeps its own focus and state, so the caller does not re-render it.
 * @param {object} o
 * @param {string} o.label
 * @param {'text'|'number'|'lines'|'select'|'bool'|'checks'} o.kind
 * @param {unknown} o.value         the value set here; undefined when inherited
 * @param {unknown} [o.inherited]   what applies when nothing is set here
 * @param {string} [o.placeholder]  instead of the inherited value
 * @param {string} [o.hint]
 * @param {string[]} [o.options]    for `select` and `checks`
 * @param {boolean} [o.inherits=true]  false for fields without an inherited value
 * @param {(value: unknown) => void} o.onChange  undefined removes the key
 * @returns {HTMLElement}
 */
export function field(o) {
  const inherits = o.inherits !== false;
  // A group of checkboxes cannot sit inside one <label>.
  const wrap = h(o.kind === 'checks' ? 'div' : 'label', { class: 'field' });
  let value = o.value;

  const set = (next) => {
    value = next;
    wrap.classList.toggle('set', inherits && value !== undefined);
    resetLink.hidden = !inherits || value === undefined;
    o.onChange(next);
  };

  const resetLink = h(
    'button',
    {
      type: 'button',
      class: 'link reset',
      hidden: !inherits || value === undefined,
      onclick: (e) => {
        e.preventDefault();
        set(undefined);
        control.replaceWith((control = build()));
      }
    },
    'Use inherited'
  );

  const placeholder = o.placeholder ?? (inherits ? describe(o.inherited) : '');

  function build() {
    switch (o.kind) {
      case 'number':
        return h('input', {
          type: 'number',
          min: 0,
          value: value ?? '',
          placeholder,
          oninput: (e) => set(e.target.value === '' ? undefined : Number(e.target.value))
        });
      case 'lines': {
        const lines = Array.isArray(value) ? value : [];
        const shown = Array.isArray(o.inherited) && o.placeholder === undefined ? o.inherited.join('\n') : placeholder;
        return h('textarea', {
          rows: Math.max(2, Math.min(8, Math.max(lines.length, String(shown).split('\n').length))),
          value: lines.join('\n'),
          placeholder: shown,
          spellcheck: false,
          oninput: (e) => {
            const next = e.target.value
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean);
            set(next.length ? next : undefined);
          }
        });
      }
      case 'select':
        return h(
          'select',
          { onchange: (e) => set(e.target.value === '' ? undefined : e.target.value) },
          inherits ? h('option', { value: '', selected: value === undefined }, `Inherit (${describe(o.inherited)})`) : null,
          (o.options || []).map((opt) => h('option', { value: opt, selected: value === opt }, opt))
        );
      case 'bool':
        return h(
          'select',
          { onchange: (e) => set(e.target.value === '' ? undefined : e.target.value === 'on') },
          inherits ? h('option', { value: '', selected: value === undefined }, `Inherit (${describe(o.inherited)})`) : null,
          h('option', { value: 'on', selected: value === true }, 'On'),
          h('option', { value: 'off', selected: value === false }, 'Off')
        );
      case 'checks': {
        const effective = Array.isArray(value) ? value : Array.isArray(o.inherited) ? o.inherited : [];
        const box = h('span', { class: 'checks' });
        for (const opt of o.options || []) {
          box.append(
            h(
              'label',
              null,
              h('input', {
                type: 'checkbox',
                checked: effective.includes(opt),
                onchange: () => set([...box.querySelectorAll('input')].filter((i) => i.checked).map((i) => i.value))
              }),
              opt
            )
          );
          box.lastChild.querySelector('input').value = opt;
        }
        return box;
      }
      default:
        return h('input', {
          type: 'text',
          value: value ?? '',
          placeholder,
          spellcheck: false,
          oninput: (e) => set(e.target.value.trim() === '' ? undefined : e.target.value)
        });
    }
  }

  let control = build();
  wrap.classList.toggle('set', inherits && value !== undefined);
  wrap.append(h('span', { class: 'label' }, o.label, resetLink), control);
  if (o.hint) wrap.append(h('span', { class: 'hint' }, o.hint));
  return wrap;
}
