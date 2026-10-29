import { h, mount } from './dom.js';

/**
 * How a value reads in an inherited field.
 * @param {unknown} value
 * @returns {string}
 */
function describe(value) {
  if (value === undefined || value === null || value === '') return 'not set';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (Array.isArray(value)) return value.length ? value.join('\n') : 'none';
  return String(value);
}

const copy = (v) => (Array.isArray(v) ? [...v] : v);
const empty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

let seq = 0;

/**
 * A form field bound to one config key, as a `label  value` row. An unset key
 * inherits: its inherited value shows dimmed in a dashed box with where it
 * comes from, and clicking it sets a value here, starting from the inherited
 * one. A value set here is marked `*` and has "reset to inherited". On, off
 * and lists of options are buttons that set the value directly. Edits are
 * reported as they happen; the field keeps its own state and focus, so the
 * caller does not re-render it.
 * @param {object} o
 * @param {string} o.label
 * @param {'text'|'number'|'lines'|'bool'|'checks'|'enum'} o.kind
 * @param {unknown} o.value          the value set here; undefined when inherited
 * @param {unknown} [o.inherited]    what applies when nothing is set here
 * @param {string} [o.from]          where the inherited value comes from (`defaults`, a source repo)
 * @param {(value: unknown) => string} [o.show]  how the inherited value reads, instead of the plain value
 * @param {string} [o.placeholder]   for fields that do not inherit
 * @param {string} [o.hint]
 * @param {string[]} [o.options]     for `checks` and `enum`
 * @param {boolean} [o.inherits=true]  false for fields without an inherited value
 * @param {(value: unknown) => void} o.onChange  undefined removes the key
 * @returns {HTMLElement}
 */
export function field(o) {
  const inherits = o.inherits !== false;
  const id = `field-${++seq}`;
  const wrap = h('div', { class: 'field' });
  let value = o.value;
  // A text field stays open while it has the focus, even when it is emptied.
  let editing = false;

  const isSet = () => inherits && value !== undefined;
  const change = (next) => {
    value = next;
    o.onChange(next);
  };

  function label() {
    wrap.classList.toggle('set', isSet() || !inherits);
    return h('label', { class: 'label', for: id }, h('span', { class: 'star' }, isSet() ? '*' : ' '), ` ${o.label}`);
  }

  function parse(text) {
    if (o.kind === 'number') return text.trim() === '' ? undefined : Number(text);
    if (o.kind === 'lines') {
      const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      return lines.length ? lines : undefined;
    }
    return text.trim() === '' ? undefined : text;
  }

  function input() {
    const attrs = {
      id,
      spellcheck: false,
      placeholder: inherits ? '' : o.placeholder || '',
      onfocus: () => (editing = true),
      onblur: () => {
        editing = false;
        if (inherits && value === undefined) render();
      },
      oninput: (e) => {
        change(parse(e.target.value));
        wrap.firstChild.replaceWith(label());
      }
    };
    if (o.kind === 'lines') {
      const lines = Array.isArray(value) ? value : [];
      return h('textarea', { ...attrs, rows: Math.max(1, Math.min(6, lines.length || 1)), value: lines.join('\n') });
    }
    return h('input', { ...attrs, type: o.kind === 'number' ? 'number' : 'text', min: o.kind === 'number' ? 0 : null, value: value ?? '' });
  }

  function options() {
    const effective = value !== undefined ? value : o.inherited;
    const choices = o.kind === 'bool' ? [true, false] : o.options || [];
    return h(
      'div',
      { class: 'options', role: 'group', 'aria-label': o.label },
      choices.map((choice) => {
        const list = Array.isArray(effective) ? effective : [];
        const on = o.kind === 'checks' ? list.includes(choice) : effective === choice;
        const word = o.kind === 'bool' ? (choice ? 'on' : 'off') : String(choice);
        const text = o.kind === 'checks' ? `${on ? '[x]' : '[ ]'} ${word}` : on ? `[${word}]` : ` ${word} `;
        return h(
          'button',
          {
            type: 'button',
            id: choice === choices[0] ? id : null,
            'aria-pressed': String(on),
            onclick: () => {
              change(o.kind === 'checks' ? (on ? list.filter((x) => x !== choice) : [...list, choice]) : choice);
              render();
            }
          },
          text
        );
      })
    );
  }

  function control() {
    const parts = [];
    const from = h('span', { class: 'from' }, `← ${o.from || 'defaults'}`);
    if (o.kind === 'bool' || o.kind === 'checks' || o.kind === 'enum') {
      parts.push(options());
      if (inherits && value === undefined) parts.push(from);
    } else if (inherits && value === undefined && !editing) {
      parts.push(
        h(
          'button',
          {
            type: 'button',
            class: 'inherited',
            id,
            title: 'Set a value here, starting from this one',
            onclick: () => {
              editing = true;
              if (!empty(o.inherited)) change(copy(o.inherited));
              render();
              wrap.querySelector('input, textarea')?.focus();
            }
          },
          (o.show || describe)(o.inherited)
        ),
        from
      );
    } else {
      parts.push(input());
    }
    if (o.hint) parts.push(h('span', { class: 'hint' }, o.hint));
    if (isSet()) {
      parts.push(
        h(
          'button',
          {
            type: 'button',
            class: 'link',
            onclick: () => {
              editing = false;
              change(undefined);
              render();
            }
          },
          'reset to inherited'
        )
      );
    }
    return h('div', { class: 'control' }, parts);
  }

  function render() {
    mount(wrap, label(), control());
  }

  render();
  return wrap;
}
