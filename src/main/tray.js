import { Tray, Menu, nativeImage } from 'electron';
import { fileURLToPath } from 'node:url';
import { summarize } from '../shared/status.js';

const TRAY_DIR = fileURLToPath(new URL('../../assets/tray/', import.meta.url));
const isMac = process.platform === 'darwin';

/**
 * The tray image for a state: a template image on macOS (the counts go next to
 * it as text), a coloured plate elsewhere.
 * @param {ReturnType<typeof summarize>['state']} state
 */
function imageFor(state) {
  if (isMac) {
    const name = state === 'stopped' || state === 'unavailable' ? 'trayStoppedTemplate' : 'trayTemplate';
    const image = nativeImage.createFromPath(`${TRAY_DIR}${name}.png`);
    image.setTemplateImage(true);
    return image;
  }
  const plate = state === 'unavailable' ? 'stopped' : state;
  return nativeImage.createFromPath(`${TRAY_DIR}tray-${plate}.png`);
}

const clip = (s, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * @typedef {object} TrayActions
 * @property {(view?: string, selector?: string) => void} open  shows the window
 * @property {(args: string[]) => void} run                    runs a CLI command
 * @property {() => void} clearData                            asks, then clears run data
 * @property {() => boolean} autostart
 * @property {(enabled: boolean) => void} setAutostart
 * @property {() => void} quit
 */

/**
 * Creates the tray icon. Call `update` with fresh status whenever it changes.
 * @param {TrayActions} actions
 */
export function createTray(actions) {
  const tray = new Tray(imageFor('idle'));
  if (!isMac) tray.on('click', () => actions.open());

  let lastKey = '';
  return {
    /**
     * @param {Parameters<typeof summarize>[0]} status
     * @param {Parameters<typeof summarize>[1]} service
     */
    update(status, service) {
      const s = summarize(status, service);
      const key = JSON.stringify(s) + actions.autostart();
      if (key === lastKey) return;
      lastKey = key;

      tray.setImage(imageFor(s.state));
      if (isMac) tray.setTitle(s.badge ? ` ${s.badge}` : '', { fontType: 'monospacedDigit' });
      tray.setToolTip(s.tooltip);

      const available = s.state !== 'unavailable';
      /** @type {Electron.MenuItemConstructorOptions[]} */
      const items = [{ label: s.daemon, enabled: false }];
      if (s.problem) items.push({ label: clip(s.problem), click: () => actions.run(['restart']) });
      if (s.active) items.push({ label: `Running: ${clip(s.active)}`, enabled: false });
      if (s.queued.length) {
        items.push({
          label: `Queued (${s.queued.length})`,
          submenu: s.queued.slice(0, 15).map((q) => ({ label: clip(q), enabled: false }))
        });
      }
      if (s.last) items.push({ label: clip(s.last), enabled: false });

      if (s.failures.length) {
        items.push({ type: 'separator' }, { label: `Open failures (${s.failures.length})`, enabled: false });
        for (const f of s.failures.slice(0, 8)) {
          items.push({ label: clip(f.label), click: () => actions.open('history', f.target) });
        }
        items.push({ label: 'Retry failed updates', click: () => actions.run(['retry', '--failed']) });
      }

      items.push(
        { type: 'separator' },
        { label: 'Open updeps', click: () => actions.open('graph') },
        { label: 'Activity', click: () => actions.open('activity') },
        { label: 'History', click: () => actions.open('history') },
        { type: 'separator' },
        {
          label: 'Daemon',
          enabled: available,
          submenu: [
            { label: 'Start', enabled: status?.daemon.running === false, click: () => actions.run(['start']) },
            { label: 'Restart', click: () => actions.run(['restart']) },
            { label: 'Stop', enabled: Boolean(status?.daemon.running), click: () => actions.run(['stop']) }
          ]
        },
        { label: 'Clear run data…', enabled: available, click: () => actions.clearData() },
        {
          label: 'Start at login',
          type: 'checkbox',
          checked: actions.autostart(),
          click: (item) => actions.setAutostart(item.checked)
        },
        { type: 'separator' },
        { label: 'Quit updeps', click: () => actions.quit() }
      );
      tray.setContextMenu(Menu.buildFromTemplate(items));
    },
    destroy() {
      tray.destroy();
    }
  };
}
