// Saves a screenshot of each view, for checking the UI:
//   npm run screenshots -- <out-dir> [view[:repo-name][+folded][+bottom][+dark|+light] ...]
// `dependencies:repo-name` selects that repo on the map, a `+folded` suffix
// folds both side panels, a `+bottom` suffix docks the details panel at the
// bottom (the others dock it on the right), and `+dark` or `+light` picks the
// theme (dark by default). The suffixes combine in any order.
// It reads the real config and state through the installed CLI, but never
// writes: CLI commands other than `doctor` are not run, and the theme is not
// remembered.
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { app, nativeTheme } from 'electron';
import { registerScheme, handleProtocol, createWindow } from '../src/main/window.js';
import { registerIpc } from '../src/main/ipc.js';
import { locateCli, runCli } from '../src/main/cli.js';

registerScheme();
const [outDir = 'screenshots', ...requested] = process.argv.slice(process.argv.indexOf('scripts/screenshots.js') + 1);
const views = requested.length ? requested : ['dependencies', 'activity', 'history', 'log', 'health'];

// Keep running between windows.
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  handleProtocol();
  const cli = await locateCli(process.env);
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
    autostart: () => false,
    setAutostart: () => {}
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
    nativeTheme.themeSource = flags.includes('light') ? 'light' : 'dark';
    const win = createWindow({ view });
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
