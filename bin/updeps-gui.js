#!/usr/bin/env node
// Starts the desktop app with this package's Electron and returns: the app
// keeps running in the system tray. A second start shows the open window.
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const USAGE = `updeps-gui — desktop app for updeps

USAGE
  updeps-gui [--hidden] [--login] [--foreground]
  updeps-gui --prepare
  updeps-gui --quit

OPTIONS
  --hidden       start in the system tray without opening the window
  --login        started by the login entry; follows the start minimized setting
  --foreground   stay attached to the terminal and print the app's output
  --prepare      download Electron and, on macOS, build updeps.app, then exit
                 (\`updeps gui install\` runs this)
  --quit         ask a running app to quit and wait until it is gone; exits 0
                 when none is running (\`updeps gui\` runs this before an update)
  -h, --help     show this help
  -v, --version  show the version
`;

const QUIT_TIMEOUT_MS = 15_000;

const args = process.argv.slice(2);
const root = fileURLToPath(new URL('..', import.meta.url));

if (args.includes('-h') || args.includes('--help')) {
  console.log(USAGE);
  process.exit(0);
}
if (args.includes('-v') || args.includes('--version')) {
  console.log(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  process.exit(0);
}
const unknown = args.filter((a) => !['--hidden', '--login', '--foreground', '--prepare', '--quit'].includes(a));
if (unknown.length) {
  console.error(`Unknown option: ${unknown[0]}\n\n${USAGE}`);
  process.exit(1);
}

// The `electron` package exports the path of its binary, downloading it the
// first time it is required.
let electron = createRequire(import.meta.url)('electron');

if (process.platform === 'darwin') {
  const { ensureMacApp } = await import('../src/mac-app.js');
  try {
    electron = ensureMacApp(electron, { log: (line) => console.log(line) });
  } catch (err) {
    // The app still runs, only under Electron's name in the Dock.
    console.error(`Could not prepare updeps.app: ${err.message}`);
  }
}

if (args.includes('--prepare')) process.exit(0);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

if (args.includes('--quit')) {
  // Waits for the running app to go (the app itself gives up after 10 s) and exits 0
  // when none is running.
  const res = spawnSync(electron, [root, '--quit'], { stdio: 'ignore', env, timeout: QUIT_TIMEOUT_MS });
  process.exit(res.status === 0 ? 0 : 1);
}

const foreground = args.includes('--foreground');

const child = spawn(electron, [root, ...args.filter((a) => a !== '--foreground')], {
  detached: !foreground,
  stdio: foreground ? 'inherit' : 'ignore',
  env
});
if (foreground) {
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  child.unref();
}
