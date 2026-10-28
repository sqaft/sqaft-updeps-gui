# LEARNINGS

## 2026-10-28 — Cytoscape bounding boxes lag behind positions set in code
After a layout or `node.position(...)`, `boundingBox()` can still return the boxes from before the change until the next render. Post-layout steps (closing empty bands, packing groups) therefore compute boxes from `position()` and the known node size instead.

## 2026-10-28 — Dagre puts unconnected groups into the empty bands of another group
A long column of dependents leaves tall empty bands inside one connected group, and dagre fills them with nodes of other groups. Closing bands over the whole graph sees no gap; it has to run per connected component, before the components are packed.

## 2026-10-29 — Electron 44 downloads its binary on the first `require('electron')`, not on npm install
The `electron` package has no install script any more: `node_modules/electron/dist` is empty until something requires the package, which then downloads about 100 MB while it blocks. `updeps-app --prepare` requires it, so `updeps gui install` does the download instead of the first start.

## 2026-10-29 — macOS shows the bundle's name, not `app.setName()`
The Dock tooltip, Cmd+Tab and the menu bar take the name from the running bundle's Info.plist, so an app started from npm's Electron.app is called "Electron" whatever `app.setName()` says. The app runs from a renamed copy (`updeps.app`); editing the copy invalidates Electron's signature, and Apple silicon runs only signed code, so it is signed again ad hoc (`codesign --force --deep --sign -`).
