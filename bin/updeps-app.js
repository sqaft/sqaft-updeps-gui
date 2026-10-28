#!/usr/bin/env node
// Starts the desktop app with this package's Electron and returns: the app
// keeps running in the system tray. A second start shows the open window.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const USAGE = `updeps-app — desktop app for updeps

USAGE
  updeps-app [--hidden] [--foreground]

OPTIONS
  --hidden       start in the system tray without opening the window
  --foreground   stay attached to the terminal and print the app's output
  -h, --help     show this help
  -v, --version  show the version
`;

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
const unknown = args.filter((a) => !['--hidden', '--foreground'].includes(a));
if (unknown.length) {
  console.error(`Unknown option: ${unknown[0]}\n\n${USAGE}`);
  process.exit(1);
}

// The `electron` package exports the path of its binary.
const electron = createRequire(import.meta.url)('electron');
const foreground = args.includes('--foreground');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

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
