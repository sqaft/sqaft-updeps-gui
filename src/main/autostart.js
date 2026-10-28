// "Start at login" for the app itself. Like the updeps daemon, the macOS and
// Linux entries run `node` through the PATH saved when the option is turned
// on, instead of pinning a Node or Electron binary that an upgrade replaces.
// On Windows the entry starts Electron directly: a GUI program, so no console
// window opens at login.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const APP_BIN = fileURLToPath(new URL('../../bin/updeps-app.js', import.meta.url));
export const APP_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const AGENT_ID = 'com.sqaft.updeps.app';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${AGENT_ID}.plist`);
const DESKTOP_FILE = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'autostart',
  'sqaft-updeps-app.desktop'
);

const xml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * launchd agent that starts the app (in the tray) at login.
 * @param {{ bin: string, pathEnv: string }} opts
 * @returns {string}
 */
export function renderAppPlist({ bin, pathEnv }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AGENT_ID}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>node</string>
    <string>${xml(bin)}</string>
    <string>--hidden</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(pathEnv)}</string>
  </dict>
</dict>
</plist>
`;
}

/**
 * Quotes one argument of a desktop entry's Exec key: double-quoted with `"`,
 * `` ` ``, `$` and `\` escaped, then backslashes doubled again for the key's
 * string escaping; `%` (field codes) doubled.
 * @param {string} arg
 */
function execQuote(arg) {
  const quoted = '"' + String(arg).replace(/(["`$\\])/g, '\\$1') + '"';
  return quoted.replace(/\\/g, '\\\\').replace(/%/g, '%%');
}

/**
 * XDG autostart entry that starts the app (in the tray) at login.
 * @param {{ bin: string, pathEnv: string }} opts
 * @returns {string}
 */
export function renderDesktopEntry({ bin, pathEnv }) {
  const exec = ['/usr/bin/env', `PATH=${pathEnv}`, 'node', bin, '--hidden'].map(execQuote).join(' ');
  return `[Desktop Entry]
Type=Application
Name=updeps
Comment=Dependency update status in the system tray
Exec=${exec}
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
`;
}

/**
 * @param {import('electron').App} app
 * @returns {boolean}
 */
export function isEnabled(app) {
  if (process.platform === 'darwin') return fs.existsSync(PLIST);
  if (process.platform === 'win32') {
    return app.getLoginItemSettings({ path: process.execPath, args: [APP_ROOT, '--hidden'] }).openAtLogin;
  }
  return fs.existsSync(DESKTOP_FILE);
}

/**
 * Turns starting at login on or off.
 * @param {import('electron').App} app
 * @param {boolean} enabled
 * @param {string} pathEnv  PATH the entry runs `node` with
 */
export function setEnabled(app, enabled, pathEnv) {
  if (process.platform === 'win32') {
    app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: [APP_ROOT, '--hidden'] });
    return;
  }
  const file = process.platform === 'darwin' ? PLIST : DESKTOP_FILE;
  if (!enabled) {
    if (process.platform === 'darwin') {
      spawnSync('launchctl', ['bootout', `gui/${os.userInfo().uid}`, PLIST], { stdio: 'ignore' });
    }
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content =
    process.platform === 'darwin'
      ? renderAppPlist({ bin: APP_BIN, pathEnv })
      : renderDesktopEntry({ bin: APP_BIN, pathEnv });
  fs.writeFileSync(file, content, 'utf8');
}
