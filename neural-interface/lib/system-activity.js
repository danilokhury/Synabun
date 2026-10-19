/**
 * SynaBun — is anything running that a restart would end?
 *
 * The desktop app installs an update only while this says idle
 * (packaging/desktop/src/updater/controller.mjs): a restart ends every agent
 * run, side-panel reply, loop and backup the server holds. server.js hands in
 * one counter per kind, each reading the state the server already keeps
 * (`GET /api/system/activity`); this module only adds them up. Pure, tested in
 * tests/system-activity.test.mjs.
 *
 * A counter that throws counts as `unknown`: when SynaBun cannot tell, it is
 * not idle.
 */

/** The kinds an answer may name, in the order the interface lists them. */
export const ACTIVITY_KINDS = Object.freeze([
  'assistant', 'claude-panel', 'codex-panel', 'opencode-panel', 'claude-cli', 'loop', 'schedule', 'backup', 'maintenance', 'unknown',
]);

/** A Claude Code session that took a prompt this recently may still be working on it. */
export const CLI_RECENT_MS = 10 * 60 * 1000;

/**
 * `sources` is `{ kind: () => count }`. Returns `{ idle, busy: [{ kind,
 * count }], checkedAt }`, busy in ACTIVITY_KINDS order, one entry per kind.
 */
export function collectActivity(sources = {}, { now = () => Date.now(), log = () => {} } = {}) {
  const counts = new Map();
  const add = (kind, count) => counts.set(kind, (counts.get(kind) || 0) + count);
  for (const [name, read] of Object.entries(sources || {})) {
    const kind = ACTIVITY_KINDS.includes(name) ? name : 'unknown';
    let count;
    try {
      count = Number(typeof read === 'function' ? read() : read);
    } catch (error) {
      log(`activity: ${name} could not be read: ${error?.message || error}`);
      add('unknown', 1);
      continue;
    }
    if (!Number.isFinite(count) || count < 0) { add('unknown', 1); continue; }
    if (count >= 1) add(kind, Math.floor(count));
  }
  const busy = ACTIVITY_KINDS.filter(kind => counts.get(kind) > 0).map(kind => ({ kind, count: counts.get(kind) }));
  return { idle: busy.length === 0, busy, checkedAt: new Date(now()).toISOString() };
}

/** How many of `items` satisfy `test`, for a Set, a Map's values, an array or nothing. */
export function countWhere(items, test = Boolean) {
  if (!items) return 0;
  const values = items instanceof Map ? items.values() : items;
  let count = 0;
  for (const item of values) if (test(item)) count += 1;
  return count;
}

/**
 * Claude Code sessions (a SynaBun terminal or any other) that took a prompt
 * within CLI_RECENT_MS: the hooks report a prompt, never its end, so a recent
 * one counts as working. `sessions` is the server's session registry.
 */
export function recentCliSessions(sessions, { now = Date.now(), windowMs = CLI_RECENT_MS } = {}) {
  return countWhere(sessions, (entry) => {
    const at = Number(entry?.lastActivity) || 0;
    return at > 0 && now - at >= 0 && now - at < windowMs;
  });
}
