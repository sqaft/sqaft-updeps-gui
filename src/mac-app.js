// macOS only: Electron from npm is a bundle called Electron.app, and macOS
// takes the name shown in the Dock, Cmd+Tab and the menu bar from the bundle.
// So the app runs from a copy of it, updeps.app, with its own name, bundle id
// and icon. The copy is an APFS clone (no extra disk space) and is signed
// again with an ad-hoc signature, since editing a bundle invalidates its
// signature and Apple silicon runs only signed code. It is rebuilt when
// Electron or the icon changes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const BUNDLE_ID = 'com.sqaft.updeps.app';
const ICON = fileURLToPath(new URL('../assets/icon.icns', import.meta.url));

/** Where updeps.app is kept: the app's own data folder, which an app update leaves alone. */
export const DEFAULT_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'updeps');

function run(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: 'utf8' });
  if (res.error || res.status !== 0) {
    throw new Error(`${cmd} ${args[0]} failed: ${(res.error?.message || res.stderr || '').trim()}`);
  }
}

/**
 * What a built updeps.app was made from; a different stamp means rebuild.
 * @param {string} electronApp  path of Electron.app
 */
function stampFor(electronApp) {
  const plist = fs.readFileSync(path.join(electronApp, 'Contents', 'Info.plist'));
  const hash = crypto.createHash('sha256').update(plist).update(fs.readFileSync(ICON)).digest('hex');
  return JSON.stringify({ source: electronApp, hash });
}

/**
 * Builds updeps.app from Electron.app unless an up-to-date one exists.
 * @param {string} electronBinary  `require('electron')`: …/Electron.app/Contents/MacOS/Electron
 * @param {{ dir?: string, log?: (line: string) => void }} [opts]
 * @returns {string} the binary to start, inside updeps.app
 */
export function ensureMacApp(electronBinary, { dir = DEFAULT_DIR, log = () => {} } = {}) {
  const electronApp = path.resolve(electronBinary, '..', '..', '..');
  const target = path.join(dir, 'updeps.app');
  const binary = path.join(target, 'Contents', 'MacOS', path.basename(electronBinary));
  const stampFile = path.join(dir, 'updeps.app.json');
  const stamp = stampFor(electronApp);

  try {
    if (fs.readFileSync(stampFile, 'utf8') === stamp && fs.existsSync(binary)) return binary;
  } catch {
    /* not built yet */
  }

  log('Preparing updeps.app (once per Electron version)…');
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `updeps.app.${process.pid}.tmp`);
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    // -c clones on APFS; fall back to a plain copy elsewhere
    try {
      run('cp', ['-Rc', electronApp, tmp]);
    } catch {
      fs.rmSync(tmp, { recursive: true, force: true });
      run('cp', ['-R', electronApp, tmp]);
    }
    const plist = path.join(tmp, 'Contents', 'Info.plist');
    for (const [key, value] of [
      ['CFBundleName', 'updeps'],
      ['CFBundleDisplayName', 'updeps'],
      ['CFBundleIdentifier', BUNDLE_ID]
    ]) {
      run('plutil', ['-replace', key, '-string', value, plist]);
    }
    const iconFile = spawnSync('plutil', ['-extract', 'CFBundleIconFile', 'raw', plist], { encoding: 'utf8' }).stdout.trim();
    fs.copyFileSync(ICON, path.join(tmp, 'Contents', 'Resources', iconFile || 'electron.icns'));
    run('codesign', ['--force', '--deep', '--sign', '-', tmp]);

    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(tmp, target);
    fs.writeFileSync(stampFile, stamp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return binary;
}
