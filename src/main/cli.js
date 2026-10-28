// Finds the installed updeps CLI and Node.js, loads the CLI's API and runs CLI
// commands. The app has no copy of updeps of its own: it always works with the
// install the user runs (and the daemon runs), so the two never disagree about
// the config format.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const CLI_PACKAGE = '@sqaft/updeps-cli';
/** The `@sqaft/updeps-cli/api` version this app is written against. */
export const REQUIRED_API_VERSION = 1;

/**
 * First executable called `name` on `pathEnv` (with the PATHEXT extensions on Windows).
 * @param {string} name
 * @param {string} pathEnv
 * @param {NodeJS.Platform} [platform]
 * @returns {string|null}
 */
export function findExecutable(name, pathEnv, platform = process.platform) {
  const windows = platform === 'win32';
  const delimiter = windows ? ';' : ':';
  const extensions = windows ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of (pathEnv || '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (!windows) fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/**
 * The package directory behind an `updeps` command on PATH. On macOS and Linux
 * the command is a symlink to the package's `bin/updeps.js`; on Windows npm
 * writes a `updeps.cmd` shim next to the global `node_modules`.
 * @param {string} command
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function cliRootFromCommand(command, platform = process.platform) {
  if (platform === 'win32') return path.join(path.dirname(command), 'node_modules', ...CLI_PACKAGE.split('/'));
  return path.dirname(path.dirname(fs.realpathSync(command)));
}

/**
 * Reads a candidate package directory.
 * @param {string} root
 * @returns {{ root: string, version: string, bin: string, apiFile: string } | null} null unless it is the updeps CLI with an API
 */
export function readCliPackage(root) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  const api = pkg.exports?.['./api'];
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.updeps;
  if (pkg.name !== CLI_PACKAGE || typeof api !== 'string' || typeof bin !== 'string') return null;
  return { root, version: pkg.version, bin: path.join(root, bin), apiFile: path.join(root, api) };
}

/**
 * PATH of the user's login shell. An app started from the Dock, a launcher or
 * a login item gets a minimal PATH without the directories a shell profile
 * adds (Homebrew, nvm, ~/.local/bin), where `node` and `updeps` usually are.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string|null}
 */
export function loginShellPath(env = process.env) {
  if (process.platform === 'win32') return null;
  const shell = env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
  const marker = '__updeps_path__';
  const res = spawnSync(shell, ['-ilc', `printf '${marker}%s${marker}' "$PATH"`], {
    encoding: 'utf8',
    timeout: 5000,
    env
  });
  const match = new RegExp(`${marker}(.*)${marker}`).exec(res.stdout || '');
  return match ? match[1] : null;
}

/**
 * Joins PATH lists, keeping the first occurrence of each entry.
 * @param {...(string|null|undefined)} lists
 * @returns {string}
 */
export function mergePaths(...lists) {
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const seen = [];
  for (const list of lists) {
    for (const entry of (list || '').split(delimiter)) if (entry && !seen.includes(entry)) seen.push(entry);
  }
  return seen.join(delimiter);
}

/**
 * @typedef {object} Cli
 * @property {string} root     package directory
 * @property {string} version
 * @property {string} bin      CLI entry point (run it with `node`)
 * @property {string} node     Node.js binary that runs it
 * @property {any} api         the loaded `@sqaft/updeps-cli/api` module
 */

/**
 * Finds the CLI: `UPDEPS_CLI` (a package directory) when set, otherwise the
 * `updeps` command on PATH. Also finds `node` and loads the CLI's API.
 * @param {NodeJS.ProcessEnv} env  its PATH is used for the lookups
 * @returns {Promise<Cli>}
 * @throws {Error} with a message that says what to install or fix
 */
export async function locateCli(env = process.env) {
  let root = env.UPDEPS_CLI || null;
  if (!root) {
    const command = findExecutable('updeps', env.PATH);
    if (!command) {
      throw new Error(`The updeps command was not found on PATH. Install it with: npm install -g ${CLI_PACKAGE}`);
    }
    root = cliRootFromCommand(command);
  }

  const pkg = readCliPackage(root);
  if (!pkg) {
    throw new Error(`${root} is not an install of ${CLI_PACKAGE} with an API. Update it with: npm install -g ${CLI_PACKAGE}`);
  }

  const node = findExecutable('node', env.PATH);
  if (!node) throw new Error('Node.js (node) was not found on PATH. updeps needs Node.js 22 or newer.');

  const api = await import(pathToFileURL(pkg.apiFile).href);
  if (!(api.API_VERSION >= REQUIRED_API_VERSION)) {
    throw new Error(
      `updeps ${pkg.version} is too old for this app (API ${api.API_VERSION ?? 'missing'}, needs ${REQUIRED_API_VERSION}). ` +
        `Update it with: npm install -g ${CLI_PACKAGE}`
    );
  }
  return { root, version: pkg.version, bin: pkg.bin, node, api };
}

/** CLI commands the app may run. */
const ALLOWED = new Set(['start', 'stop', 'restart', 'retry', 'run', 'reset', 'doctor', 'graph']);

/**
 * Runs `updeps <args>` with the found Node.js and streams its output.
 * @param {Cli} cli
 * @param {string[]} args
 * @param {{ env: NodeJS.ProcessEnv, onOutput?: (text: string) => void }} opts
 * @returns {Promise<{ code: number|null }>}
 */
export function runCli(cli, args, { env, onOutput = () => {} }) {
  if (!Array.isArray(args) || !ALLOWED.has(args[0]) || args.some((a) => typeof a !== 'string')) {
    return Promise.reject(new Error(`Not a command the app runs: ${JSON.stringify(args)}`));
  }
  return new Promise((resolve) => {
    const child = spawn(cli.node, [cli.bin, ...args], {
      env: { ...env, NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    child.stdout.setEncoding('utf8').on('data', onOutput);
    child.stderr.setEncoding('utf8').on('data', onOutput);
    child.on('error', (err) => {
      onOutput(`${err.message}\n`);
      resolve({ code: null });
    });
    child.on('close', (code) => resolve({ code }));
  });
}
