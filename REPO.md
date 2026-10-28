# @sqaft/updeps-app

**Durum:** Geliştirme aşamasında  
**Tür:** Bağımsız kütüphane / ürün

The Electron desktop app for updeps (macOS, Linux, Windows): a dependency graph editor and the daemon's status and failures in the system tray. Published on npm as `@sqaft/updeps-app`; public repo: github.com/sqaft/sqaft-updeps-app. Details: `README.md`.

It works with the updeps CLI installed on the machine (`sqaft-updeps-cli`, `@sqaft/updeps-cli`): it loads that install's API (`@sqaft/updeps-cli/api`, see the CLI's `src/api.js`) and runs its CLI for actions. When the API changes, update `REQUIRED_API_VERSION` in `src/main/cli.js` and the calls in `src/main/ipc.js`.

## Layout

- `bin/updeps-app.js`: the `updeps-app` command; starts Electron detached.
- `src/main/`: the Electron main process. `main.js` (app lifecycle, single instance, tray actions), `cli.js` (finding the CLI and Node.js, running CLI commands), `ipc.js` (everything the page can call), `window.js` (the window and the `app://updeps/` scheme), `tray.js`, `watch.js` (file watching), `autostart.js` (start at login).
- `src/preload.cjs`: the `window.updeps` bridge.
- `src/renderer/`: the page, plain ES modules without a framework; `views/graph.js` is the editor (Cytoscape.js with the dagre layout).
- `src/shared/`: pure modules used by both sides and the tests (graph model, config edits, status summary).
- `assets/`: tray and app icons drawn by `scripts/icons.js`.

## Commands

- `npm test` — `node --test "test/*.test.js"` (no Electron needed; CI sets `ELECTRON_SKIP_BINARY_DOWNLOAD=1`)
- `npm start` — runs the app from the working copy
- `npm run screenshots -- <dir> [view[:repo] ...]` — saves a PNG of each view (light and dark) using the real config read-only; use it to check UI changes
- `npm run icons` — redraws `assets/`

## Releases

The package is versioned with semver because npm needs a new version for each publish; there are no git tags. To release: bump `version` in `package.json` and `package-lock.json`, commit and push to `main`. The `publish` job in `.github/workflows/test.yml` publishes to npm with trusted publishing (OIDC) after the tests pass, only if that version is not on npm yet. The first version is published by hand (`npm login`, `npm publish`), then a trusted publisher is added on npmjs.com (GitHub Actions, organization `sqaft`, repository `sqaft-updeps-app`, workflow `test.yml`) right before the first version bump CI should publish.

## Notes

- All code, comments, docs, UI text and tests are in English.
- Design: a signal-box panel. Tokens are CSS custom properties in `src/renderer/styles.css` (light and dark) and mirrored in `scripts/icons.js`; amber means a job runs, red an open failure. Fonts: Overpass, Overpass Mono (bundled from `@fontsource`).
- UI text: sentence case, plain verbs, a button says what it does ("Save", "Retry", "Add dependent…").
