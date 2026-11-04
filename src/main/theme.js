import fs from 'node:fs';
import path from 'node:path';
import { isTheme } from '../shared/theme.js';

/**
 * The remembered theme choice; a missing or unreadable file means `system`.
 * @param {string} file
 * @returns {'system'|'dark'|'light'}
 */
export function readTheme(file) {
  try {
    const { theme } = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isTheme(theme) ? theme : 'system';
  } catch {
    return 'system';
  }
}

/**
 * Remembers the theme choice for the next start.
 * @param {string} file
 * @param {string} theme
 */
export function writeTheme(file, theme) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ theme }) + '\n');
}
