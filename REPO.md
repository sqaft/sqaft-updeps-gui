# @sqaft/updeps-gui

**Durum:** Geliştirme aşamasında  
**Tür:** Bağımsız kütüphane / ürün

The Electron desktop app for updeps (macOS, Linux, Windows): a dependency graph editor and the daemon's status and failures in the system tray. Published on npm as `@sqaft/updeps-gui`; public repo: github.com/sqaft/sqaft-updeps-gui. Details: `README.md`.

It works with the updeps CLI installed on the machine (`sqaft-updeps-cli`, `@sqaft/updeps-cli`): it loads that install's API (`@sqaft/updeps-cli/api`, see the CLI's `src/api.js`) and runs its CLI for actions. When the API changes, update `REQUIRED_API_VERSION` in `src/main/cli.js` and the calls in `src/main/ipc.js`.

## Layout

- `bin/updeps-gui.js`: the `updeps-gui` command; starts Electron detached. `updeps gui` (the CLI's `src/commands/gui.js`) installs this package into its data directory and runs this file with `UPDEPS_CLI` set; keep the bin name and its options in step with it.
- `src/main/`: the Electron main process. `main.js` (app lifecycle, single instance, tray actions), `cli.js` (finding the CLI and Node.js, running CLI commands), `ipc.js` (everything the page can call), `window.js` (the window and the `app://updeps/` scheme), `tray.js`, `watch.js` (file watching), `autostart.js` (start at login).
- `src/mac-app.js`: on macOS, builds `updeps.app` (Electron.app cloned, renamed, re-signed ad hoc) so the Dock and Cmd+Tab show updeps; `bin/updeps-gui.js` starts that instead of Electron.app.
- `src/preload.cjs`: the `window.updeps` bridge.
- `src/renderer/`: the page, plain ES modules without a framework; `app.js` is the shell (menu, statusline, command drawer, keys), `dom.js` the DOM helpers and the side panels that fold, `views/dependencies.js` the editor (map and tree), `fields.js` the inherited-or-set form fields.
- `src/shared/`: pure modules used by both sides and the tests: graph model (`graph.js`), the focus tree, islands, the map's layout and link states (`tree.js`), config edits and their description (`draft.js`), status summary (`status.js`), log and `doctor` parsers (`parse.js`).
- `assets/`: tray and app icons drawn by `scripts/icons.js`.

## Commands

- `npm test` — `node --test "test/*.test.js"` (no Electron needed; CI sets `ELECTRON_SKIP_BINARY_DOWNLOAD=1`)
- `npm start` — runs the app from the working copy
- `npm run screenshots -- <dir> [view[@map|@tree][:repo][+folded] ...]` — saves a PNG of each view using the real config read-only (`@map`/`@tree` picks how Dependencies shows, `+folded` folds both side panels); use it to check UI changes
- `npm run icons` — redraws `assets/`

## Releases

The package is versioned with semver because npm needs a new version for each publish; there are no git tags. To release: bump `version` in `package.json` and `package-lock.json`, commit and push to `main`. The `publish` job in `.github/workflows/test.yml` publishes to npm with trusted publishing (OIDC) after the tests pass, only if that version is not on npm yet. The first version is published by hand (`npm login`, `npm publish`), then a trusted publisher is added on npmjs.com (GitHub Actions, organization `sqaft`, repository `sqaft-updeps-gui`, workflow `test.yml`) right before the first version bump CI should publish.

## Notes

- All code, comments, docs, UI text and tests are in English.
- Design: a terminal-style panel in a single dark theme. Everything is monospace, sections are boxes with their title on the border, a statusline runs along the bottom, the menu on the left and the details panel on the right fold (`[`, `]`) and resize by dragging their inner edge (`resizer` in `dom.js`, widths remembered), and the window works from the keyboard (each view lists its keys in the statusline). In the details panel a field's label sits above its value; a list field (commands, branches, files) takes one entry per line, grows with its lines and does not wrap them. Colour means state only: amber a running or queued update, red an open failure, green an update that went through; a selection is inverted text. Tokens are CSS custom properties in `src/renderer/styles.css`, mirrored in `scripts/icons.js` (run `npm run icons` after changing them) and in the window's `BACKGROUND` (`src/main/window.js`). Fonts: JetBrains Mono, and Martian Mono for the brand and box titles (bundled from `@fontsource-variable`).
- UI text: lowercase, plain verbs; a button says what it does and shows its key when it has one (`s save`, `r retry`, `+ add dependent…`). Native menus (the tray) keep sentence case.
