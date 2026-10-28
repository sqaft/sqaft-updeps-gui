import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, protocol, shell, nativeTheme } from 'electron';

const require = createRequire(import.meta.url);
const SRC = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const ASSETS = path.resolve(fileURLToPath(new URL('../../assets/', import.meta.url)));
const PRELOAD = fileURLToPath(new URL('../preload.cjs', import.meta.url));

export const APP_ORIGIN = 'app://updeps';

/**
 * Directory of an installed package (works for packages that do not export
 * their package.json).
 * @param {string} name
 */
function packageDir(name) {
  try {
    return path.dirname(require.resolve(`${name}/package.json`));
  } catch {
    let dir = path.dirname(require.resolve(name));
    while (!fs.existsSync(path.join(dir, 'package.json'))) dir = path.dirname(dir);
    return dir;
  }
}

/** URL path prefix -> directory it is served from. Nothing else is reachable. */
const ROOTS = {
  '/renderer/': path.join(SRC, 'renderer'),
  '/shared/': path.join(SRC, 'shared'),
  '/assets/': ASSETS,
  '/vendor/cytoscape/': path.join(packageDir('cytoscape'), 'dist'),
  '/vendor/cytoscape-dagre/': path.join(packageDir('cytoscape-dagre'), 'dist'),
  '/fonts/overpass/': path.join(packageDir('@fontsource-variable/overpass'), 'files'),
  '/fonts/overpass-mono/': path.join(packageDir('@fontsource/overpass-mono'), 'files')
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png'
};

/**
 * Maps an `app://updeps/...` path to a file, refusing anything outside ROOTS.
 * @param {string} urlPath
 * @returns {string|null}
 */
export function fileForUrlPath(urlPath) {
  const p = decodeURIComponent(urlPath === '/' ? '/renderer/index.html' : urlPath);
  for (const [prefix, dir] of Object.entries(ROOTS)) {
    if (!p.startsWith(prefix)) continue;
    const file = path.resolve(dir, p.slice(prefix.length));
    return file.startsWith(dir + path.sep) ? file : null;
  }
  return null;
}

/** Must run before the app is ready. */
export function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }
  ]);
}

/** Serves the renderer, its modules, fonts and vendor files over `app://updeps/`. */
export function handleProtocol() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    const file = url.host === 'updeps' ? fileForUrlPath(url.pathname) : null;
    if (!file) return new Response('Not found', { status: 404 });
    try {
      const body = await fs.promises.readFile(file);
      return new Response(body, {
        headers: { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

/**
 * Creates the main window. It cannot navigate away from the app or open new
 * windows; https links open in the browser.
 * @param {{ view?: string }} [opts]
 * @returns {BrowserWindow}
 */
export function createWindow({ view } = {}) {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: 'updeps',
    show: false,
    icon: process.platform === 'darwin' ? undefined : path.join(ASSETS, 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1A211D' : '#DDE4DC',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${APP_ORIGIN}/`)) event.preventDefault();
  });
  win.once('ready-to-show', () => win.show());
  win.loadURL(`${APP_ORIGIN}/${view ? `#${view}` : ''}`);
  return win;
}
