import { ipcMain, dialog, shell, BrowserWindow } from 'electron';
import { buildGraph } from '../shared/graph.js';
import * as draft from '../shared/draft.js';

/**
 * @typedef {object} Context  shared state of the main process
 * @property {import('./cli.js').Cli|null} cli
 * @property {string|null} cliError     why the CLI could not be used
 * @property {NodeJS.ProcessEnv} env     environment for CLI commands (login-shell PATH merged in)
 * @property {() => Promise<void>} relocate             looks for the CLI again
 * @property {(args: string[]) => Promise<{ code: number|null }>} runCommand  runs and broadcasts a CLI command
 * @property {() => boolean} autostart
 * @property {(enabled: boolean) => void} setAutostart
 */

/**
 * Checks a raw config and builds its graph in one call, for the editor.
 * @param {import('./cli.js').Cli} cli
 * @param {unknown} raw
 */
function check(cli, raw) {
  const result = cli.api.checkConfig(raw);
  return {
    ok: result.ok,
    error: result.error,
    warnings: result.warnings,
    cycles: result.cycles,
    pkgs: result.pkgs,
    resolved: result.config,
    graph: buildGraph(raw, cli.api.resolvePath)
  };
}

/**
 * Registers the handlers behind `window.updeps` (src/preload.cjs).
 * @param {Context} ctx
 */
export function registerIpc(ctx) {
  const needCli = () => {
    if (!ctx.cli) throw new Error(ctx.cliError || 'The updeps CLI is not available.');
    return ctx.cli;
  };
  // Every channel takes at most one argument; the handler gets it, then the event.
  const handle = (channel, fn) => ipcMain.handle(channel, (event, arg) => fn(arg, event));

  handle('app:context', () => {
    const cli = ctx.cli;
    return {
      platform: process.platform,
      error: ctx.cliError,
      autostart: ctx.autostart(),
      cli: cli
        ? {
            root: cli.root,
            version: cli.version,
            node: cli.node,
            paths: cli.api.paths,
            defaults: cli.api.DEFAULT_VALUES,
            triggers: cli.api.VALID_TRIGGERS,
            dirtyPolicies: cli.api.VALID_DIRTY_POLICIES
          }
        : null
    };
  });
  handle('app:relocate', () => ctx.relocate());

  handle('config:read', () => needCli().api.readConfigFile());
  handle('config:check', (raw) => check(needCli(), raw));
  handle('config:write', (raw) => {
    const cli = needCli();
    try {
      cli.api.writeConfigFile(raw);
    } catch (err) {
      return { saved: false, error: err.message };
    }
    return { saved: true, error: null };
  });

  // Structural edits need the CLI's path resolution, so they run here.
  handle('config:edit', ({ raw, op, args }) => {
    const resolvePath = needCli().api.resolvePath;
    if (op === 'addRepo') return draft.addRepo(raw, args.repo, resolvePath);
    if (op === 'connect') return draft.connect(raw, args.source, args.target, resolvePath);
    if (op === 'removeRepo') return { raw: draft.removeRepo(raw, args.id, resolvePath) };
    throw new Error(`Unknown edit: ${op}`);
  });
  handle('repo:inspect', (dir) => needCli().api.inspectRepo(String(dir)));
  handle('dialog:folder', async (title, event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showOpenDialog(win, { title: String(title || 'Choose a repo'), properties: ['openDirectory'] });
    if (res.canceled || !res.filePaths[0]) return null;
    return needCli().api.displayPath(res.filePaths[0]);
  });
  handle('dialog:confirm', async ({ message, detail, confirm }, event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showMessageBox(win, {
      type: 'question',
      message: String(message),
      detail: detail ? String(detail) : undefined,
      buttons: [String(confirm || 'OK'), 'Cancel'],
      defaultId: 0,
      cancelId: 1
    });
    return res.response === 0;
  });

  handle('status:read', () => needCli().api.readStatus());
  handle('service:inspect', () => needCli().api.inspectService());
  handle('history:read', (opts) => needCli().api.readHistory(opts || {}));
  handle('run:read', (selector) => needCli().api.readRun(String(selector)));
  handle('log:read', (opts) => needCli().api.readLog(opts || {}));

  handle('cli:run', (args) => ctx.runCommand(args));
  handle('autostart:set', (enabled) => ctx.setAutostart(Boolean(enabled)));
  handle('shell:reveal', (what) => {
    const paths = needCli().api.paths;
    const file = { config: paths.configFile, log: paths.logFile, state: paths.stateFile }[what];
    if (file) shell.showItemInFolder(file);
  });
}
