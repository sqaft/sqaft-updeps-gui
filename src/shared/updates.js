// Which updates the app announces (pure).

/** The command that updates the app. */
export const APP_UPDATE_COMMAND = 'updeps gui';

/** @typedef {{ latest: string, command: string }} Update */
/** @typedef {{ app: Update|null, cli: Update|null }} Updates */

/** No update to announce. */
export const NO_UPDATES = Object.freeze({ app: null, cli: null });

/**
 * Whether the app runs from an npm install (its root has `node_modules` as a
 * path segment) rather than from a checkout.
 * @param {string} root  the app's root directory
 * @returns {boolean}
 */
export function isInstalled(root) {
  return String(root).split(/[\\/]+/).includes('node_modules');
}

/**
 * Turns the CLI's update check into the notices to show. The app is announced
 * only when it was installed from npm and a newer version exists; the CLI
 * only when the check says that install can update itself.
 * @param {object} input
 * @param {{ cli?: { update?: boolean, latest?: string|null, command?: string }, app?: { latest?: string|null } }|null} input.checked  result of the CLI's `checkUpdates()`
 * @param {string} input.appVersion  the running app's version
 * @param {boolean} input.installed  see `isInstalled`
 * @param {(latest: string, current: string) => boolean} input.isNewer
 * @returns {Updates}
 */
export function computeUpdates({ checked, appVersion, installed, isNewer }) {
  const appLatest = checked?.app?.latest;
  const cli = checked?.cli;
  return {
    app: installed && appLatest && isNewer(appLatest, appVersion) ? { latest: appLatest, command: APP_UPDATE_COMMAND } : null,
    cli: cli?.update && cli.latest ? { latest: cli.latest, command: cli.command } : null
  };
}
