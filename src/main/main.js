import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, dialog, nativeTheme } from 'electron';
import { locateCli, loginShellPath, mergePaths, runCli } from './cli.js';
import { registerScheme, handleProtocol, createWindow } from './window.js';
import { registerIpc } from './ipc.js';
import { createTray } from './tray.js';
import { watchFiles } from './watch.js';
import * as autostart from './autostart.js';
import { readTheme, writeTheme } from './theme.js';
import { readSettings, writeSettings } from './settings.js';
import { startsHidden } from '../shared/startup.js';
import { NO_UPDATES, computeUpdates, isInstalled } from '../shared/updates.js';

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const QUIT_WAIT_MS = 10_000;
const QUIT_POLL_MS = 200;

registerScheme();
app.setName('updeps');
// The theme choice (system, dark or light) is remembered in the user data directory and applies
// before the first window opens. It drives the page's `prefers-color-scheme` and the window's own
// parts (scrollbars, dialogs).
const themeFile = path.join(app.getPath('userData'), 'theme.json');
nativeTheme.themeSource = readTheme(themeFile);
const settingsFile = path.join(app.getPath('userData'), 'settings.json');

const isMac = process.platform === 'darwin';

if (process.argv.includes('--quit')) {
  quitRunningInstance();
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

/**
 * `--quit`: asks the running instance to quit (it does so when this start
 * reaches it as a `second-instance`) and exits 0 once it is gone, which is
 * when this process gets the single-instance lock; 1 if it is still there
 * after QUIT_WAIT_MS. With no instance running it exits 0 at once. Shows
 * nothing: no window, no tray.
 */
function quitRunningInstance() {
  app.dock?.hide();
  const deadline = Date.now() + QUIT_WAIT_MS;
  const poll = () => {
    if (app.requestSingleInstanceLock()) app.exit(0);
    else if (Date.now() >= deadline) app.exit(1);
    else setTimeout(poll, QUIT_POLL_MS);
  };
  poll();
}

function main() {
  /** @type {import('./ipc.js').Context} */
  const ctx = {
    cli: null,
    cliError: null,
    env: { ...process.env },
    relocate,
    runCommand,
    theme: () => nativeTheme.themeSource,
    setTheme(theme) {
      nativeTheme.themeSource = theme;
      try {
        writeTheme(themeFile, theme);
      } catch {
        /* not remembered; this run still uses it */
      }
    },
    autostart: () => autostart.isEnabled(app),
    setAutostart(enabled) {
      autostart.setEnabled(app, enabled, ctx.env.PATH || '');
      refreshTray();
      broadcast('changed', 'context');
    },
    startMinimized: () => settings.startMinimized,
    setStartMinimized(enabled) {
      settings = { ...settings, startMinimized: enabled };
      try {
        writeSettings(settingsFile, settings);
      } catch {
        /* not remembered; this run still uses it */
      }
      broadcast('changed', 'context');
    },
    updates: () => updates
  };

  /** @type {BrowserWindow|null} */
  let win = null;
  let tray = null;
  let stopWatching = null;
  let service = null;
  let serviceCheckedAt = 0;
  let commandSeq = 0;
  let settings = readSettings(settingsFile);
  /** @type {import('../shared/updates.js').Updates} */
  let updates = NO_UPDATES;
  // A checkout (`npm start`) never announces an update of the app.
  const installed = isInstalled(app.getAppPath());

  function broadcast(channel, payload) {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
  }

  /**
   * Shows the window (creating it if needed), optionally on a view.
   * @param {string} [view]
   * @param {string} [selector] e.g. the target whose run to show
   */
  function showWindow(view, selector) {
    // On macOS the app is in the Dock and Cmd+Tab while its window is open.
    if (isMac) app.dock?.show();
    if (!win || win.isDestroyed()) {
      win = createWindow({ view });
      win.on('closed', () => {
        win = null;
        if (isMac) app.dock?.hide();
      });
      if (selector) win.webContents.once('did-finish-load', () => win?.webContents.send('navigate', { view, selector }));
    } else {
      if (view) win.webContents.send('navigate', { view, selector });
      if (win.isMinimized()) win.restore();
      win.show();
    }
    if (isMac) app.focus({ steal: true });
    else win.focus();
  }

  /**
   * Updates the tray from the state file. The service is inspected (which
   * spawns `node --version`) at most once a minute unless `withService`.
   * @param {boolean} [withService]
   */
  function refreshTray(withService = false) {
    if (!tray) return;
    if (!ctx.cli) {
      tray.update(null, null);
      return;
    }
    let status = null;
    try {
      status = ctx.cli.api.readStatus();
    } catch {
      /* a half-written state file; the next change refreshes it */
    }
    if (withService || Date.now() - serviceCheckedAt > 60_000) {
      try {
        service = ctx.cli.api.inspectService();
      } catch {
        service = null;
      }
      serviceCheckedAt = Date.now();
    }
    tray.update(status, service);
  }

  /**
   * Asks the CLI whether the app or the CLI has an update (the CLI caches the
   * answer for a day) and, when the answer changed, refreshes the tray and
   * the windows. Never throws.
   */
  async function refreshUpdates() {
    let next = NO_UPDATES;
    if (ctx.cli) {
      try {
        const checked = await ctx.cli.api.checkUpdates();
        next = computeUpdates({ checked, appVersion: app.getVersion(), installed, isNewer: ctx.cli.api.isNewer });
      } catch {
        return;
      }
    }
    if (JSON.stringify(next) === JSON.stringify(updates)) return;
    updates = next;
    refreshTray();
    broadcast('changed', 'context');
  }

  /**
   * The CLI install to use: `updeps gui` passes its own in UPDEPS_CLI, and the
   * app remembers it, so a start at login (which has no UPDEPS_CLI) uses the
   * same install. Without either, the `updeps` command on PATH is used.
   * @returns {string|null}
   */
  function cliRoot() {
    const file = path.join(app.getPath('userData'), 'cli.json');
    if (process.env.UPDEPS_CLI) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ root: process.env.UPDEPS_CLI }) + '\n');
      } catch {
        /* not remembered; this start still uses it */
      }
      return process.env.UPDEPS_CLI;
    }
    try {
      const { root } = JSON.parse(fs.readFileSync(file, 'utf8'));
      return typeof root === 'string' && fs.existsSync(root) ? root : null;
    } catch {
      return null;
    }
  }

  /**
   * Finds the CLI. When it is not on the PATH the app was started with (as
   * from the Dock or a login item), the login shell's PATH is tried too.
   */
  async function relocate() {
    stopWatching?.();
    stopWatching = null;
    const root = cliRoot();
    const base = root ? { ...process.env, UPDEPS_CLI: root } : { ...process.env };
    ctx.env = base;
    try {
      ctx.cli = await locateCli(ctx.env);
      ctx.cliError = null;
    } catch (err) {
      // A remembered install that is gone or too old gives way to the one on PATH.
      const retry = process.env.UPDEPS_CLI ? base : { ...process.env };
      ctx.env = { ...retry, PATH: mergePaths(process.env.PATH, loginShellPath(process.env)) };
      try {
        ctx.cli = await locateCli(ctx.env);
        ctx.cliError = null;
      } catch {
        ctx.cli = null;
        ctx.cliError = err.message;
      }
    }
    if (ctx.cli) {
      stopWatching = watchFiles(ctx.cli.api.paths, (what) => {
        broadcast('changed', what);
        if (what === 'state' || what === 'tick') refreshTray();
      });
    }
    refreshTray(true);
    broadcast('changed', 'context');
    refreshUpdates();
  }

  /**
   * Runs a CLI command and streams it to every window (`command` events).
   * @param {string[]} args
   * @returns {Promise<{ code: number|null, output: string }>}
   */
  async function runCommand(args) {
    if (!ctx.cli) throw new Error(ctx.cliError || 'The updeps CLI is not available.');
    const id = ++commandSeq;
    let output = '';
    broadcast('command', { id, type: 'start', args });
    const { code } = await runCli(ctx.cli, args, {
      env: ctx.env,
      onOutput: (text) => {
        output += text;
        broadcast('command', { id, type: 'output', text });
      }
    });
    broadcast('command', { id, type: 'end', code });
    refreshTray(true);
    return { code, output };
  }

  /** Runs a command from the tray; a failure is shown in a dialog, since no window may be open. */
  async function runFromTray(args) {
    try {
      const { code, output } = await runCommand(args);
      if (code !== 0) {
        dialog.showMessageBox({
          type: 'error',
          message: `updeps ${args.join(' ')} failed`,
          detail: output.trim().split('\n').slice(-12).join('\n')
        });
      }
    } catch (err) {
      dialog.showMessageBox({ type: 'error', message: err.message });
    }
  }

  async function clearData() {
    const res = await dialog.showMessageBox({
      type: 'warning',
      message: 'Clear run data?',
      detail:
        'This deletes the queue, open failures, run history and logs. The config is kept. A running daemon is restarted.',
      buttons: ['Clear run data', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    });
    if (res.response === 0) await runFromTray(['reset', '--yes']);
  }

  app.on('second-instance', (_event, argv) => {
    if (argv.includes('--quit')) app.quit();
    else if (!startsHidden(argv, settings.startMinimized)) showWindow();
  });
  app.on('activate', () => showWindow());
  // Closing the window leaves the app running in the tray.
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => stopWatching?.());

  const hiddenStart = startsHidden(process.argv, settings.startMinimized);

  app.whenReady().then(async () => {
    if (isMac) {
      // A tray app: in the Dock only while the window is open (see showWindow).
      if (hiddenStart) app.dock?.hide();
      // Started from Electron.app rather than updeps.app (npm start): at least the icon is updeps'.
      if (!process.execPath.includes('/updeps.app/')) {
        app.dock?.setIcon(fileURLToPath(new URL('../../assets/icon.png', import.meta.url)));
      }
      // The menu keeps the edit shortcuts working in text fields.
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
      );
    } else {
      Menu.setApplicationMenu(null);
    }
    handleProtocol();
    registerIpc(ctx);
    tray = createTray({
      open: showWindow,
      run: runFromTray,
      clearData,
      autostart: ctx.autostart,
      setAutostart: ctx.setAutostart,
      updates: ctx.updates,
      quit: () => app.quit()
    });
    await relocate();
    if (!hiddenStart) showWindow();
    setInterval(refreshUpdates, UPDATE_CHECK_INTERVAL_MS);
  });
}
