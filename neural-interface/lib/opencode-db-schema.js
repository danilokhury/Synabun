// ─────────────────────────────────────────────────────────────────────────────
// Which OpenCode database SynaBun is reading.
//
// SynaBun reads OpenCode's own SQLite database ($XDG_DATA_HOME/opencode/
// opencode.db) for the session lists of every registered project and for the
// Resume cache. OpenCode 1 keeps sessions in `session` / `message` / `part`;
// OpenCode 2 keeps them in `session_v2` / `session_message`, in the same file.
// An OpenCode 2 that opened an OpenCode 1 database copies its sessions into
// `session_v2` and leaves the old tables behind, frozen: read by OpenCode 1's
// queries they would show yesterday's sessions and none of today's. So the
// tables are picked by the OpenCode SynaBun talks to, and by what the file has.
// ─────────────────────────────────────────────────────────────────────────────

/** The table names of an open node:sqlite database, or an empty set. */
export function tableNamesOf(db) {
  try {
    return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row?.name || '')));
  } catch {
    return new Set();
  }
}

/**
 * 'v2' (OpenCode 2's tables), 'v1' (OpenCode 1's) or null (neither). `protocol`
 * is the major SynaBun talks to (1, 2, or null when it is not known): with 2,
 * OpenCode 2's tables are read when the file has them; with 1, OpenCode 1's;
 * not known, OpenCode 2's when there are any.
 */
export function opencodeDbFlavor(db, protocol = null) {
  if (!db) return null;
  const tables = tableNamesOf(db);
  const v2 = tables.has('session_v2') && tables.has('session_message');
  const v1 = tables.has('session') && tables.has('message');
  if (protocol === 1) return v1 ? 'v1' : null;
  if (protocol === 2) return v2 ? 'v2' : null;
  if (v2) return 'v2';
  return v1 ? 'v1' : null;
}

/** The session table and the message-count expression (`s` is the session row) of a flavor. */
export function sessionTablesFor(flavor) {
  if (flavor === 'v2') {
    return {
      session: 'session_v2',
      messageCount: "(SELECT COUNT(*) FROM session_message m WHERE m.session_id = s.id AND m.type IN ('user', 'assistant'))",
    };
  }
  return { session: 'session', messageCount: '(SELECT COUNT(*) FROM message m WHERE m.session_id = s.id)' };
}

/**
 * The visible text of one OpenCode 2 `session_message` row (its `type` and
 * JSON `data`) as `{ role, text }`, or null for a row without any (a switch, an
 * idle marker, a tool-only step).
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
