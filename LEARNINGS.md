# LEARNINGS

## 2026-10-29 — Electron 44 downloads its binary on the first `require('electron')`, not on npm install
The `electron` package has no install script any more: `node_modules/electron/dist` is empty until something requires the package, which then downloads about 100 MB while it blocks. `updeps-gui --prepare` requires it, so `updeps gui install` does the download instead of the first start.

## 2026-10-29 — macOS shows the bundle's name, not `app.setName()`
The Dock tooltip, Cmd+Tab and the menu bar take the name from the running bundle's Info.plist, so an app started from npm's Electron.app is called "Electron" whatever `app.setName()` says. The app runs from a renamed copy (`updeps.app`); editing the copy invalidates Electron's signature, and Apple silicon runs only signed code, so it is signed again ad hoc (`codesign --force --deep --sign -`).

## 2026-10-29 — A fixed-width box inside an `overflow: auto` one still widens the window
The page's body is a grid with an `auto` column, which grows to the min-content width of what it holds, and a scroll container still counts its content's width there. A graph wider than the main area pushed the side panel and the statusline off the window; `contain: inline-size` on the graph's scroll box keeps its width out of that sum, so the graph scrolls inside its box.
