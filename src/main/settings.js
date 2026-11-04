import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {object} Settings
 * @property {boolean} startMinimized  a start at login opens in the tray without the window
 */

/** @type {Settings} */
export const DEFAULT_SETTINGS = { startMinimized: true };

/**
 * The remembered settings; a missing or unreadable file, or a value of the
 * wrong type, gives the default.
 * @param {string} file
 * @returns {Settings}
 */
export function readSettings(file) {
  try {
    const { startMinimized } = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { startMinimized: typeof startMinimized === 'boolean' ? startMinimized : DEFAULT_SETTINGS.startMinimized };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Remembers the settings for the next start.
 * @param {string} file
 * @param {Settings} settings
 */
export function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ startMinimized: settings.startMinimized }) + '\n');
}
