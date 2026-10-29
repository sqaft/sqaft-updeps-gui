# LEARNINGS

## 2026-10-29 — Electron 44 downloads its binary on the first `require('electron')`, not on npm install
The `electron` package has no install script any more: `node_modules/electron/dist` is empty until something requires the package, which then downloads about 100 MB while it blocks. `updeps-app --prepare` requires it, so `updeps gui install` does the download instead of the first start.

## 2026-10-29 — macOS shows the bundle's name, not `app.setName()`
The Dock tooltip, Cmd+Tab and the menu bar take the name from the running bundle's Info.plist, so an app started from npm's Electron.app is called "Electron" whatever `app.setName()` says. The app runs from a renamed copy (`updeps.app`); editing the copy invalidates Electron's signature, and Apple silicon runs only signed code, so it is signed again ad hoc (`codesign --force --deep --sign -`).
