// The logic of the details panel's tabs when it is docked at the bottom. Pure,
// so the tests cover it; `sidePanel` in `renderer/dom.js` draws the result.

/**
 * The tab that shows: the active one, else the first. The active id is kept
 * as it is, so a tab that is missing for a moment (another repo, a run that is
 * still loading) shows again when it comes back.
 * @param {string[]} ids  the tabs there are now, in order
 * @param {string|null} active
 * @returns {string|null}
 */
export function shownTab(ids, active) {
  return ids.includes(active) ? active : (ids[0] ?? null);
}

/**
 * The neighbour of the shown tab; it stops at the ends.
 * @param {string[]} ids
 * @param {string|null} shown
 * @param {number} step  -1 or 1
 * @returns {string|null}
 */
export function stepTab(ids, shown, step) {
  if (!ids.length) return null;
  const i = ids.indexOf(shown);
  return ids[Math.max(0, Math.min(ids.length - 1, i < 0 ? 0 : i + step))];
}

/**
 * Whether a tab that comes and goes (a link's `failed` one) has just appeared
 * for a selection, so it is selected once and left alone on later renders.
 * @param {string|null} seenFor  the selection it was last shown for, null while it was absent
 * @param {string} scope         the current selection
 * @param {boolean} present      whether the tab exists in this render
 * @returns {{ fresh: boolean, seenFor: string|null }}
 */
export function appearance(seenFor, scope, present) {
  return { fresh: present && seenFor !== scope, seenFor: present ? scope : null };
}
