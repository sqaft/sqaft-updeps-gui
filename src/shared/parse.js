// Parsers for CLI output the app shows in its own layout (pure): the daemon
// log and `updeps doctor`.

/**
 * @typedef {object} LogLine
 * @property {string|null} ts     ISO time; null for a line continuing the one before
 * @property {string} level      INFO, WARN, ERROR, …
 * @property {string|null} repo  the repo the line is about, if any
 * @property {string} msg
 */

const LOG_LINE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z?) \[([A-Z]+)\] (?:\[([^\]]+)\] )?(.*)$/;

/**
 * Splits the daemon log (`2026-10-29T14:31:37.102Z [INFO] [@acme/core] message`)
 * into lines. A line in another format continues the previous one.
 * @param {string} text
 * @returns {LogLine[]}
 */
export function parseLog(text) {
  const lines = [];
  for (const raw of String(text).split('\n')) {
    if (!raw.trim()) continue;
    const m = raw.match(LOG_LINE);
    if (m) {
      lines.push({ ts: m[1], level: m[2], repo: m[3] ?? null, msg: m[4] });
    } else {
      const prev = lines[lines.length - 1];
      lines.push({ ts: null, level: prev?.level ?? 'INFO', repo: prev?.repo ?? null, msg: raw });
    }
  }
  return lines;
}

/**
 * @typedef {'ok'|'bad'|'warn'|'info'} CheckKind
 * @typedef {{ kind: CheckKind, text: string }} Check
 * @typedef {{ title: string, checks: Check[], isRepo: boolean }} CheckSection
 */

const KINDS = { '✓': 'ok', '✗': 'bad', '!': 'warn', i: 'info' };

/**
 * Reads `updeps doctor` output: a bold title per section, then `  ✓ text`
 * lines (`✗` a problem, `!` a warning, `i` a note), and a closing summary.
 * Sections about a repo are those that check its folder or its targets.
 * @param {string} output  without ANSI escapes
 * @returns {{ sections: CheckSection[], summary: string|null, problems: number, warnings: number }}
 */
export function parseDoctor(output) {
  const sections = [];
  let summary = null;
  for (const raw of String(output).split('\n')) {
    if (!raw.trim()) continue;
    const item = raw.match(/^\s+(\S)\s+(.*)$/);
    if (item && sections.length) {
      sections[sections.length - 1].checks.push({ kind: KINDS[item[1]] || 'info', text: item[2] });
    } else if (!/^\s/.test(raw)) {
      sections.push({ title: raw.trim(), checks: [], isRepo: false });
    }
  }
  // The closing line ("All good." or "2 problem(s) found.") has no checks under it.
  const last = sections[sections.length - 1];
  if (last && last.checks.length === 0) summary = sections.pop().title;
  for (const s of sections) s.isRepo = s.checks.some((c) => /^(git repo|target \S+):/.test(c.text));
  const all = sections.flatMap((s) => s.checks);
  return {
    sections,
    summary,
    problems: all.filter((c) => c.kind === 'bad').length,
    warnings: all.filter((c) => c.kind === 'warn').length
  };
}
