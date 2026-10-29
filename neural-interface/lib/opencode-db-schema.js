// ─────────────────────────────────────────────────────────────────────────────
// The tables of OpenCode's database SynaBun reads.
//
// SynaBun reads OpenCode's own SQLite database ($XDG_DATA_HOME/opencode/
// opencode.db) for the session lists of every registered project and for the
// Resume cache. OpenCode 2 keeps its sessions in `session_v2` and their
// messages in `session_message`. A file OpenCode 2 migrated from OpenCode 1
// also holds OpenCode 1's `session` / `message` / `part` tables, frozen: they
// are never read (they would show yesterday's sessions and none of today's).
// ─────────────────────────────────────────────────────────────────────────────

/** The table names of an open node:sqlite database, or an empty set. */
export function tableNamesOf(db) {
  try {
    return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row?.name || '')));
  } catch {
    return new Set();
  }
}

/** Whether a database holds OpenCode 2's session tables (false for none, or for OpenCode 1's alone). */
export function hasOpencodeSessionTables(db) {
  if (!db) return false;
  const tables = tableNamesOf(db);
  return tables.has('session_v2') && tables.has('session_message');
}

/** The session table and the message-count expression (`s` is the session row). */
export const OPENCODE_SESSION_TABLES = Object.freeze({
  session: 'session_v2',
  messageCount: "(SELECT COUNT(*) FROM session_message m WHERE m.session_id = s.id AND m.type IN ('user', 'assistant'))",
});

/**
 * The visible text of one `session_message` row (its `type` and JSON `data`)
 * as `{ role, text }`, or null for a row without any (a switch, an idle
 * marker, a tool-only step).
 */
export function v2MessageText(type, data) {
  let body = data;
  if (typeof data === 'string') {
    try { body = JSON.parse(data); } catch { return null; }
  }
  if (!body || typeof body !== 'object') return null;
  if (type === 'user') {
    const text = typeof body.text === 'string' ? body.text : '';
    return text ? { role: 'user', text } : null;
  }
  if (type === 'assistant') {
    const text = (Array.isArray(body.content) ? body.content : [])
      .filter((item) => item?.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n')
      .trim();
    return text ? { role: 'assistant', text } : null;
  }
  return null;
}
