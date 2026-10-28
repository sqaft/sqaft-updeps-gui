import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, Menu, dialog } from 'electron';
import { locateCli, loginShellPath, mergePaths, runCli } from './cli.js';
import { registerScheme, handleProtocol, createWindow } from './window.js';
import { registerIpc } from './ipc.js';
import { createTray } from './tray.js';
import { watchFiles } from './watch.js';
import * as autostart from './autostart.js';

registerScheme();
app.setName('updeps');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

function main() {
  /** @type {import('./ipc.js').Context} */
  const ctx = {
    cli: null,
    cliError: null,
    env: { ...process.env },
    relocate,
    runCommand,
    autostart: () => autostart.isEnabled(app),
    setAutostart(enabled) {
      autostart.setEnabled(app, enabled, ctx.env.PATH || '');
      refreshTray();
      broadcast('changed', 'context');
    }
  };

  /** @type {BrowserWindow|null} */
  let win = null;
  let tray = null;
  let stopWatching = null;
  let service = null;
  let serviceCheckedAt = 0;
  let commandSeq = 0;

  function broadcast(channel, payload) {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
  }

  /**
   * Shows the window (creating it if needed), optionally on a view.
   * @param {string} [view]
   * @param {string} [selector] e.g. the target whose run to show
   */
  function showWindow(view, selector) {
    if (!win || win.isDestroyed()) {
      win = createWindow({ view });
      win.on('closed', () => {
        win = null;
      });
      if (selector) win.webContents.once('did-finish-load', () => win?.webContents.send('navigate', { view, selector }));
    } else {
      if (view) win.webContents.send('navigate', { view, selector });
      if (win.isMinimized()) win.restore();
      win.show();
    }
    if (process.platform === 'darwin') app.focus({ steal: true });
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
    if (!argv.includes('--hidden')) showWindow();
  });
  app.on('activate', () => showWindow());
  // Closing the window leaves the app running in the tray.
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => stopWatching?.());

  app.whenReady().then(async () => {
    if (process.platform === 'darwin') {
      // A tray app: no Dock icon. The menu keeps the edit shortcuts working in text fields.
      app.dock?.hide();
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
      quit: () => app.quit()
    });
    await relocate();
    if (!process.argv.includes('--hidden')) showWindow();
  });
}
