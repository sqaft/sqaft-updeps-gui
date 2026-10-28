// Main-process helpers that do not need Electron: finding the CLI and the
// login entries. (autostart.js and the rest import `electron` only lazily or
// not at all, so they load under plain Node.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findExecutable, cliRootFromCommand, readCliPackage, locateCli, mergePaths, runCli } from '../src/main/cli.js';
import { renderAppPlist, renderDesktopEntry } from '../src/main/autostart.js';
import { watchFiles } from '../src/main/watch.js';

const isWindows = process.platform === 'win32';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'updeps-app-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A fake CLI package with an API module. */
function fakeCli(dir, { name = '@sqaft/updeps-cli', apiVersion = 1 } = {}) {
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '9.9.9', type: 'module', bin: { updeps: 'bin/updeps.js' }, exports: { './api': './src/api.js' } })
  );
  fs.writeFileSync(path.join(dir, 'bin', 'updeps.js'), 'console.log(process.argv.slice(2).join(" "));\n');
  fs.writeFileSync(path.join(dir, 'src', 'api.js'), `export const API_VERSION = ${apiVersion};\n`);
  return dir;
}

test('readCliPackage accepts only the updeps CLI with an API', () => {
  const ok = readCliPackage(fakeCli(path.join(tmp, 'ok')));
  assert.equal(ok.version, '9.9.9');
  assert.equal(ok.bin, path.join(tmp, 'ok', 'bin', 'updeps.js'));
  assert.equal(readCliPackage(fakeCli(path.join(tmp, 'other'), { name: 'other' })), null);
  assert.equal(readCliPackage(path.join(tmp, 'missing')), null);
});

test('cliRootFromCommand: symlinked bin (macOS, Linux) and npm shim directory (Windows)', { skip: isWindows }, () => {
  const root = fakeCli(path.join(tmp, 'linked'));
  const binDir = path.join(tmp, 'global-bin');
  fs.mkdirSync(binDir);
  fs.symlinkSync(path.join(root, 'bin', 'updeps.js'), path.join(binDir, 'updeps'));
  assert.equal(cliRootFromCommand(path.join(binDir, 'updeps'), 'linux'), fs.realpathSync(root));
});

test('cliRootFromCommand on Windows looks next to the npm shim', () => {
  assert.equal(
    cliRootFromCommand(path.join('C:', 'npm', 'updeps.cmd'), 'win32'),
    path.join('C:', 'npm', 'node_modules', '@sqaft', 'updeps-cli')
  );
});

test('locateCli: UPDEPS_CLI, a missing CLI, and an API that is too old', async () => {
  const nodeDir = path.dirname(process.execPath);
  const cli = await locateCli({ UPDEPS_CLI: fakeCli(path.join(tmp, 'env')), PATH: nodeDir });
  assert.equal(cli.version, '9.9.9');
  assert.equal(cli.api.API_VERSION, 1);
  assert.ok(cli.node);

  await assert.rejects(locateCli({ PATH: path.join(tmp, 'empty') }), /npm install -g @sqaft\/updeps-cli/);
  await assert.rejects(
    locateCli({ UPDEPS_CLI: fakeCli(path.join(tmp, 'old'), { apiVersion: 0 }), PATH: nodeDir }),
    /too old/
  );
});

test('runCli runs only the commands the app needs, and streams their output', async () => {
  const cli = await locateCli({ UPDEPS_CLI: path.join(tmp, 'env'), PATH: path.dirname(process.execPath) });
  let out = '';
  const res = await runCli(cli, ['retry', '--failed'], { env: process.env, onOutput: (t) => (out += t) });
  assert.equal(res.code, 0);
  assert.equal(out.trim(), 'retry --failed');
  await assert.rejects(runCli(cli, ['init', '--force'], { env: process.env }), /Not a command/);
});

test('findExecutable and mergePaths', () => {
  const d = path.delimiter;
  assert.equal(mergePaths(`a${d}b`, `b${d}c`, null), `a${d}b${d}c`);
  assert.equal(findExecutable('node', path.dirname(process.execPath))?.toLowerCase().startsWith(path.dirname(process.execPath).toLowerCase()), true);
  assert.equal(findExecutable('definitely-not-here', path.join(tmp, 'empty')), null);
});

test('login entries run node through the saved PATH with --hidden, escaped', () => {
  const plist = renderAppPlist({ bin: '/a & b/bin/updeps-app.js', pathEnv: '/x:/y' });
  assert.match(plist, /<string>\/usr\/bin\/env<\/string>\s*<string>node<\/string>\s*<string>\/a &amp; b\/bin\/updeps-app\.js<\/string>\s*<string>--hidden<\/string>/);
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/x:\/y<\/string>/);

  const entry = renderDesktopEntry({ bin: '/home/me/app "x"/bin/updeps-app.js', pathEnv: '/a:/b 100%' });
  const exec = /^Exec=(.*)$/m.exec(entry)[1];
  assert.equal(
    exec,
    '"/usr/bin/env" "PATH=/a:/b 100%%" "node" "/home/me/app \\\\"x\\\\"/bin/updeps-app.js" "--hidden"'
  );
});

test('watchFiles reports a replaced file by name and ticks', async () => {
  const dir = path.join(tmp, 'watched');
  fs.mkdirSync(dir);
  const seen = [];
  const stop = watchFiles(
    {
      configFile: path.join(dir, 'config.json'),
      stateFile: path.join(dir, 'state.json'),
      journalFile: path.join(dir, 'journal.jsonl'),
      logFile: path.join(tmp, 'no-such-dir', 'updeps.log')
    },
    (what) => seen.push(what),
    { tickMs: 200, debounceMs: 20 }
  );
  try {
    await new Promise((r) => setTimeout(r, 100));
    fs.writeFileSync(path.join(dir, '.state.tmp'), '{}');
    fs.renameSync(path.join(dir, '.state.tmp'), path.join(dir, 'state.json'));
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(seen.includes('state'), `saw: ${seen.join(', ')}`);
    assert.ok(seen.includes('tick'));
    assert.ok(!seen.includes('config'));
  } finally {
    stop();
  }
});
