import fs from 'node:fs';
import path from 'node:path';

/**
 * Reports changes to updeps' files. The directories are watched rather than
 * the files: the CLI and the daemon replace `state.json` and `config.json`
 * with an atomic rename, which a watch on the file itself would stop seeing.
 * A directory that does not exist yet (nothing ran so far) is retried on the
 * next tick. A tick also fires every few seconds, since a daemon that dies
 * changes no file.
 * @param {{ configFile: string, stateFile: string, journalFile: string, logFile: string }} paths
 * @param {(what: 'config'|'state'|'journal'|'log'|'tick') => void} onChange
 * @param {{ tickMs?: number, debounceMs?: number }} [opts]
 * @returns {() => void} stops watching
 */
export function watchFiles(paths, onChange, { tickMs = 3000, debounceMs = 150 } = {}) {
  const targets = [
    ['config', paths.configFile],
    ['state', paths.stateFile],
    ['journal', paths.journalFile],
    ['log', paths.logFile]
  ];
  const byDir = new Map();
  for (const [what, file] of targets) {
    const dir = path.dirname(file);
    if (!byDir.has(dir)) byDir.set(dir, new Map());
    byDir.get(dir).set(path.basename(file), what);
  }

  const watchers = new Map();
  const timers = new Map();
  const emit = (what) => {
    clearTimeout(timers.get(what));
    timers.set(
      what,
      setTimeout(() => {
        timers.delete(what);
        onChange(what);
      }, debounceMs)
    );
  };

  const ensureWatchers = () => {
    for (const [dir, files] of byDir) {
      if (watchers.has(dir)) continue;
      try {
        const watcher = fs.watch(dir, (_event, filename) => {
          const what = filename && files.get(String(filename));
          if (what) emit(what);
        });
        watcher.on('error', () => {
          watcher.close();
          watchers.delete(dir);
        });
        watchers.set(dir, watcher);
      } catch {
        /* not created yet */
      }
    }
  };

  ensureWatchers();
  const interval = setInterval(() => {
    ensureWatchers();
    onChange('tick');
  }, tickMs);

  return () => {
    clearInterval(interval);
    for (const t of timers.values()) clearTimeout(t);
    for (const w of watchers.values()) w.close();
    watchers.clear();
  };
}
