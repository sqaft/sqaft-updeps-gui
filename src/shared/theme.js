// The window's theme choice: `system` follows the operating system, `dark` and
// `light` fix it.

export const THEMES = ['system', 'dark', 'light'];

/** @param {unknown} value */
export const isTheme = (value) => THEMES.includes(/** @type {string} */ (value));

/**
 * The theme after `theme` when cycling with the theme button.
 * @param {string} theme
 */
export const nextTheme = (theme) => THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
