# @sqaft/updeps-app

The desktop app for [updeps](https://github.com/sqaft/sqaft-updeps-cli), on macOS,
Linux and Windows:

- **Dependencies**: the dependency graph as a track diagram. Add repos, link a
  package to the repos that depend on it, and edit each dependent's commands,
  triggers, branches and safety settings. Every edit is checked by updeps as you
  type (errors, unknown fields, loops) and written to the config file when you
  save; a running daemon picks it up right away.
- **System tray**: the daemon's state at a glance. The icon shows whether it is
  stopped, running a job, or has open failures; on macOS the counts (`⚠2 ⧗1`) sit
  next to it. The menu lists the running job, the queue and open failures, and
  can retry failures, start, stop or restart the daemon, and clear run data.
- **Activity**, **History**, **Log** and **Health check** views: what runs now,
  every update with its commands and output, the raw log, and `updeps doctor`.

The app works with the updeps CLI installed on the same computer, the one the
daemon runs: it reads the config, state and journal through the CLI's API
(`@sqaft/updeps-cli/api`) and runs the CLI for actions. It has no copy of
updeps of its own, so the two never disagree about the config format.

---

## Installation

```bash
npm install -g @sqaft/updeps-cli @sqaft/updeps-app
updeps-app
```

Requires Node.js 22+ and the updeps CLI (`@sqaft/updeps-cli`) with its API.
Installing the app downloads Electron (about 100 MB).

The window opens and the app stays in the system tray when you close it. To
start it at login, turn on **Start at login** in the tray menu.

On Linux the tray needs a StatusNotifier/AppIndicator host: KDE, Xfce and most
desktops have one; on GNOME install the "AppIndicator and KStatusNotifierItem
Support" extension (Ubuntu ships it).

```
updeps-app [--hidden] [--foreground]

  --hidden       start in the system tray without opening the window
  --foreground   stay attached to the terminal and print the app's output
```

### Finding the CLI

The app looks for the `updeps` command on its PATH. Started from the Dock, a
desktop launcher or at login, an app gets a minimal PATH, so the app also asks
your login shell for its PATH (macOS, Linux). To use a specific install, set
`UPDEPS_CLI` to the package directory (for example a working copy of
`sqaft-updeps-cli`). If no CLI is found, the window says how to install it.

### Start at login

| Platform | Entry |
|---|---|
| macOS | `~/Library/LaunchAgents/com.sqaft.updeps.app.plist` |
| Linux | `~/.config/autostart/sqaft-updeps-app.desktop` |
| Windows | the user's Run key (Task Manager › Startup apps) |

On macOS and Linux the entry runs `node` through the PATH saved when you turn the
option on, like the updeps daemon does, so Node.js upgrades keep working; turn it
off and on again after switching Node.js versions. On Windows it starts Electron
directly, so no console window opens at login.

---

## Security

The window's page is sandboxed with context isolation and no Node.js access. It
reaches the main process only through a fixed set of calls (`src/preload.cjs`),
and the only CLI commands the app runs are `start`, `stop`, `restart`, `retry`,
`run`, `reset`, `doctor` and `graph`. Credentials in a repo's `origin` URL are
masked before they are shown.

---

## Development

```bash
git clone https://github.com/sqaft/sqaft-updeps-app
cd sqaft-updeps-app
npm install
npm start                 # runs the app from the working copy
npm test                  # node:test, no Electron needed
npm run icons             # redraws assets/ (tray and app icons)
npm run screenshots -- <dir> [view[:repo] ...]   # PNGs of each view, light and dark
```

There is no build step: the main process and the page are plain ES modules, and
the page loads its files (and Cytoscape.js, the fonts) over the app's own
`app://updeps/` scheme.

CI runs the tests on macOS, Linux and Windows. Publishing happens from CI: when
the `version` in `package.json` is not on npm yet, the `publish` job in
`.github/workflows/test.yml` publishes it after the tests pass.

---

## License

MIT — see [LICENSE](LICENSE).
