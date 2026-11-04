// How a start of the app presents itself (pure).

/**
 * Whether a start opens in the tray without its window. `--hidden` always
 * does; `--login`, which the login entry passes, follows the start minimized
 * setting; a plain start (command, Dock, launcher) always shows the window.
 * @param {string[]} argv
 * @param {boolean} startMinimized
 * @returns {boolean}
 */
export function startsHidden(argv, startMinimized) {
  return argv.includes('--hidden') || (argv.includes('--login') && startMinimized);
}
