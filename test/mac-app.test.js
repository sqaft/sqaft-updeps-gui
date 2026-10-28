import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ensureMacApp, BUNDLE_ID } from '../src/mac-app.js';

/** Electron's binary when it has been downloaded (CI skips the download). */
function electronBinary() {
  if (process.platform !== 'darwin') return null;
  const dist = path.join(path.dirname(createRequire(import.meta.url).resolve('electron/package.json')), 'dist');
  const binary = path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  return fs.existsSync(binary) ? binary : null;
}

const electron = electronBinary();

test('ensureMacApp builds a signed updeps.app once and reuses it', { skip: !electron && 'needs macOS and a downloaded Electron' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updeps-mac-app-'));
  try {
    const lines = [];
    const binary = ensureMacApp(electron, { dir, log: (l) => lines.push(l) });
    const bundle = path.join(dir, 'updeps.app');
    assert.equal(binary, path.join(bundle, 'Contents', 'MacOS', 'Electron'));
    assert.equal(lines.length, 1);

    const read = (key) =>
      spawnSync('plutil', ['-extract', key, 'raw', path.join(bundle, 'Contents', 'Info.plist')], { encoding: 'utf8' }).stdout.trim();
    assert.equal(read('CFBundleName'), 'updeps');
    assert.equal(read('CFBundleDisplayName'), 'updeps');
    assert.equal(read('CFBundleIdentifier'), BUNDLE_ID);
    assert.equal(spawnSync('codesign', ['--verify', '--deep', bundle]).status, 0, 'the bundle is validly signed');

    // up to date: no rebuild
    assert.equal(ensureMacApp(electron, { dir, log: (l) => lines.push(l) }), binary);
    assert.equal(lines.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
