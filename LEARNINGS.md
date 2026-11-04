# LEARNINGS

## 2026-10-29 — Electron 44 downloads its binary on the first `require('electron')`, not on npm install
The `electron` package has no install script any more: `node_modules/electron/dist` is empty until something requires the package, which then downloads about 100 MB while it blocks. `updeps-gui --prepare` requires it, so `updeps gui install` does the download instead of the first start.

## 2026-10-29 — macOS shows the bundle's name, not `app.setName()`
The Dock tooltip, Cmd+Tab and the menu bar take the name from the running bundle's Info.plist, so an app started from npm's Electron.app is called "Electron" whatever `app.setName()` says. The app runs from a renamed copy (`updeps.app`); editing the copy invalidates Electron's signature, and Apple silicon runs only signed code, so it is signed again ad hoc (`codesign --force --deep --sign -`).

## 2026-10-29 — A fixed-width box inside an `overflow: auto` one still widens the window
The page's body is a grid with an `auto` column, which grows to the min-content width of what it holds, and a scroll container still counts its content's width there. A graph wider than the main area pushed the side panel and the statusline off the window; `contain: inline-size` on the graph's scroll box keeps its width out of that sum, so the graph scrolls inside its box.

## 2026-11-04 — A view's `navigate` can arrive before its data has loaded
`app.go(view, selector)` creates the view and calls `navigate` in the same tick, so for History and Activity's `open the link` the Dependencies graph is still empty and a lookup by name finds nothing. The view keeps the selector (`st.goTo`) and selects the repo when the first check of the config finishes; the screenshot script hides this because it navigates over a second after the view loaded.

## 2026-11-04 — The map is re-created on every tick, so gesture listeners live on the stable `content` box
`renderContent()` replaces the whole map on each status tick. Pointer capture on a box inside the map, or a drag that remembers its scroller, is lost mid-gesture. Wheel and pointer listeners sit on `content`, the drag keeps its start position and scroll offsets and writes to whichever `.graph-scroll` exists at the moment, and zoom lives in `st` and is applied to the current map in place.

## 2026-11-04 — `[`, `]` and `\` need Option or AltGr on some layouts, and `e.key` is already the character
On the Turkish Q layout these keys are typed with Option (macOS) or AltGr (Windows, which reports `ctrlKey` and `altKey` together), so a handler that drops every key press with Alt never sees them. `e.key` already holds the typed character, so `symbolKey` in `src/shared/keys.js` accepts Alt (and Ctrl+Alt off macOS) for these three symbols only and still rejects Cmd.

## 2026-11-04 — Dimming with `opacity` is far weaker for text on a pale background
The same `opacity: 0.3` leaves dark text on a light page at 1.9:1 but light text on a dark page at 2.5:1, because the eye and WCAG weigh the two ends of the scale differently. The map's dimmed share is a token (`--dimmed`, 0.55 dark and 0.65 light) chosen so the dimmed repo names stay at 4.5:1 and the sub lines at 3:1 in both themes.

## 2026-11-04 — `requestSingleInstanceLock()` can be polled after a first failure, and Chromium kills a hung holder
In Electron 44 on macOS a second call succeeds as soon as the first instance has exited, so `--quit` can wait by polling it (checked with a frozen first instance resumed after 2.5 s: exit 0 after 2.5 s). A first instance that never answers is not waited for forever: Chromium's process singleton kills a hung holder after its own timeout (about 10 s per call), so `--quit` then exits 0 after roughly 20 s with the holder gone.

## 2026-11-04 — The dependencies view overflows a 1280px window by about 100px with the details panel open
The toolbar in the main area needs about 843px, and the nav (176px) plus the 360px panel leave 744px at the default 1280px window, so the panel runs past the window's right edge. The demo screenshots use a 1440px content width (`+1440x700` in `scripts/screenshots.js`).

## 2026-11-04 — The CLI fixes its paths when it is imported, and the stale check compares file mtimes with `daemon.startedAt`
`scripts/demo.js` therefore sets `HOME` and the XDG variables before `locateCli()` loads the API, and sets `daemon.startedAt` after the newest `.js` file in the CLI's `src/` and `bin/`; an older start shows the "new updeps code" chip.

