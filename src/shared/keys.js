// Keyboard shortcuts typed as symbols.

const SYMBOLS = ['[', ']', '\\'];

/**
 * The shortcut symbol (`[`, `]` or `\`) a key press types, or null. On layouts
 * where these need Option (macOS) or AltGr (Windows reports AltGr as Ctrl and
 * Alt together; Linux as Alt or AltGraph), `key` is already that character, so
 * Alt does not matter. Cmd, and Ctrl without AltGr, give the key another
 * meaning.
 * @param {{ key: string, metaKey: boolean, ctrlKey: boolean, altKey: boolean }} e
 * @param {string} platform  `process.platform`
 * @returns {string|null}
 */
export function symbolKey(e, platform) {
  if (!SYMBOLS.includes(e.key) || e.metaKey) return null;
  const altGr = e.ctrlKey && e.altKey && platform !== 'darwin';
  if (e.ctrlKey && !altGr) return null;
  return e.key;
}
