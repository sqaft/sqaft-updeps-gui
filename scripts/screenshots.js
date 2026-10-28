// Saves a screenshot of each view, in light and dark, for checking the UI:
//   npm run screenshots -- <out-dir> [view[:repo-name] ...]
// It reads the real config and state through the installed CLI, but never
// writes: CLI commands other than `doctor` are not run.
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { app, nativeTheme } from 'electron';
import { registerScheme, handleProtocol, createWindow } from '../src/main/window.js';
import { registerIpc } from '../src/main/ipc.js';
import { locateCli, runCli } from '../src/main/cli.js';

registerScheme();
const [outDir = 'screenshots', ...requested] = process.argv.slice(process.argv.indexOf('scripts/screenshots.js') + 1);
const views = requested.length ? requested : ['graph', 'activity', 'history', 'log', 'health'];

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
    autostart: () => false,
    setAutostart: () => {}
  });
  fs.mkdirSync(outDir, { recursive: true });
  for (const theme of ['light', 'dark']) {
    nativeTheme.themeSource = theme;
    for (const spec of views) {
      const [view, selector] = spec.split(':');
      const win = createWindow({ view });
      win.webContents.on('console-message', (event) => {
        if (event.level === 'error' || event.level === 'warning') console.error(`[${spec}] ${event.message}`);
      });
      await new Promise((resolve) => {
        win.webContents.once('did-finish-load', resolve);
        win.webContents.once('did-fail-load', (_e, code, desc) => resolve(console.error(`load failed: ${code} ${desc}`)));
      });
      await sleep(1200);
      if (selector) {
        win.webContents.send('navigate', { view, selector });
        await sleep(600);
      }
      if (view === 'health') await sleep(4000);
      const image = await win.webContents.capturePage();
      const file = path.join(outDir, `${spec.replace(/[^\w-]+/g, '_')}-${theme}.png`);
      fs.writeFileSync(file, image.toPNG());
      console.log(file);
      win.destroy();
    }
  }
  app.quit();
});
