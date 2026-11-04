// Saves a screenshot of each view, for checking the UI:
//   npm run screenshots -- <out-dir> [view[:repo-name][+folded][+bottom][+updates][+autostart][+<width>x<height>][+dark|+light] ...]
// `dependencies:repo-name` selects that repo on the map, a `+folded` suffix
// folds both side panels, a `+bottom` suffix docks the details panel at the
// bottom (the others dock it on the right), and `+dark` or `+light` picks the
// theme (dark by default), `+updates` shows sample updates of the app and the
// CLI, `+autostart` shows the settings with start at login on, and
// `+1440x700` sets the size of the window's content in px (1280x820 by
// default). The suffixes combine in any order.
// It reads the config and state through the installed CLI, but never writes:
// CLI commands other than `doctor` are not run, and the theme and the login
// entry are not remembered.
//
// SCREENSHOTS_ISOLATE=<dir> keeps Electron's own data (profile, caches, logs)
// in <dir>/electron, and the script refuses to run unless the CLI's config,
// state, journal and log files are all inside <dir> (point HOME and the XDG_*
// variables there, as scripts/demo.js does).
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { app, nativeTheme } from 'electron';
import { registerScheme, handleProtocol, createWindow } from '../src/main/window.js';
import { registerIpc } from '../src/main/ipc.js';
import { locateCli, runCli } from '../src/main/cli.js';

registerScheme();

// Electron's profile is not moved by HOME on every platform; the page's
// localStorage (layout choices) would otherwise land in the real one.
const isolate = process.env.SCREENSHOTS_ISOLATE ? fs.realpathSync(process.env.SCREENSHOTS_ISOLATE) : null;
const inside = (dir, file) => file === dir || file.startsWith(dir + path.sep);
if (isolate) {
  const data = path.join(isolate, 'electron');
  for (const [name, sub] of [['userData', 'user'], ['sessionData', 'session'], ['cache', 'cache'], ['logs', 'logs'], ['crashDumps', 'crashes']]) {
    fs.mkdirSync(path.join(data, sub), { recursive: true });
    app.setPath(name, path.join(data, sub));
  }
}
const [outDir = 'screenshots', ...requested] = process.argv.slice(process.argv.indexOf('scripts/screenshots.js') + 1);
const views = requested.length ? requested : ['dependencies', 'activity', 'history', 'log', 'health', 'settings'];

// Sample notices for the `+updates` suffix; the update check never runs here.
const SAMPLE_UPDATES = {
  app: { latest: '0.0.2', command: 'updeps gui' },
  cli: { latest: '0.3.0', command: 'npm install -g @sqaft/updeps-cli' }
};
let updates = { app: null, cli: null };
let autostart = false;

// Keep running between windows.
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  handleProtocol();
  const cli = await locateCli(process.env);
  if (isolate) {
    const outside = [...Object.values(cli.api.paths), app.getPath('userData'), app.getPath('sessionData')].filter((p) => !inside(isolate, p));
    if (outside.length) {
      console.error(`refusing to run: outside ${isolate}: ${outside.join(', ')}`);
      app.exit(1);
      return;
    }
  }
  registerIpc({
    cli,
    cliError: null,
    env: process.env,
    relocate: async () => {},
    runCommand: async (args) => {
      if (args[0] !== 'doctor') return { code: 0, output: '(not run while taking screenshots)' };
      let output = '';
      const { code } = await runCli(cli, args, { env: process.env, onOutput: (t) => (output += t) });
      return { code, output };
    },
    // The theme is set per shot below; the remembered choice is never written.
    theme: () => nativeTheme.themeSource,
    setTheme: (theme) => (nativeTheme.themeSource = theme),
    autostart: () => autostart,
    setAutostart: () => {},
    startMinimized: () => true,
    setStartMinimized: () => {},
    updates: () => updates
  });
  fs.mkdirSync(outDir, { recursive: true });
  const loaded = (win) =>
    new Promise((resolve) => {
      win.webContents.once('did-finish-load', resolve);
      win.webContents.once('did-fail-load', (_e, code, desc) => resolve(console.error(`load failed: ${code} ${desc}`)));
    });
  for (const spec of views) {
    const [head, ...flags] = spec.split('+');
    const [view, selector] = head.split(':');
    const folded = flags.includes('folded');
    const bottom = flags.includes('bottom');
    autostart = flags.includes('autostart');
    updates = flags.includes('updates') ? SAMPLE_UPDATES : { app: null, cli: null };
    nativeTheme.themeSource = flags.includes('light') ? 'light' : 'dark';
    const win = createWindow({ view });
    const size = flags.map((f) => /^(\d+)x(\d+)$/.exec(f)).find(Boolean);
    if (size) win.setContentSize(Number(size[1]), Number(size[2]));
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error' || event.level === 'warning') console.error(`[${spec}] ${event.message}`);
    });
    await loaded(win);
    // The page keeps these in localStorage; set them for this shot and load it again.
    const prefs = { 'layout.nav': folded ? 'folded' : 'open', 'layout.side': folded ? 'folded' : 'open', 'layout.dock': bottom ? 'bottom' : 'right' };
    await win.webContents.executeJavaScript(
      `for (const [k, v] of Object.entries(${JSON.stringify(prefs)})) localStorage.setItem(k, v); location.reload();`
    );
    await loaded(win);
    await sleep(1200);
    if (selector) {
      win.webContents.send('navigate', { view, selector });
      await sleep(600);
    }
    if (view === 'health') await sleep(4000);
    const image = await win.webContents.capturePage();
    const file = path.join(outDir, `${spec.replace(/[^\w-]+/g, '_')}.png`);
    fs.writeFileSync(file, image.toPNG());
    console.log(file);
    win.destroy();
  }
  app.quit();
});
