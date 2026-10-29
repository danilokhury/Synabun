// OpenCode history maintenance.
//
// OpenCode 2 keeps its sessions in its own database (opencode.db: session_v2,
// session_message, its event log, its instruction and inbox tables). SynaBun
// reads how many there are, read-only, and clears them through OpenCode's own
// API (DELETE /api/session/:id, which takes a session's child sessions and its
// rows with it); it never writes OpenCode's database or deletes its folders.
// Provider credentials, account state, projects, configuration and user files
// are never touched.

import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';
import { basename, dirname, parse, resolve } from 'node:path';

export const OPENCODE_HISTORY_CONFIRMATION = 'DELETE OPENCODE HISTORY';

function fileBytes(path) {
  try {
    return statSync(path).size || 0;
  } catch {
    return 0;
  }
}

function databaseBytes(dbPath) {
  return fileBytes(dbPath) + fileBytes(`${dbPath}-wal`) + fileBytes(`${dbPath}-shm`);
}

function assertSafePaths(dbPath, dataRoot) {
  const root = resolve(dataRoot);
  const database = resolve(dbPath);
  if (root === parse(root).root) throw new Error('Refusing to read an unsafe OpenCode data root');
  if (basename(root).toLowerCase() !== 'opencode') {
    throw new Error('Refusing to read a data root that is not the OpenCode directory');
  }
  if (database !== resolve(root, 'opencode.db')) {
    throw new Error('OpenCode database must be the opencode.db file inside its data root');
  }
  return { database, root };
}

/** `{ sessions, databaseBytes }`: OpenCode's sessions (session_v2 rows, child sessions included) and its database's size. */
export function getOpenCodeHistoryStats({ dbPath, dataRoot = dirname(dbPath) }) {
  const { database } = assertSafePaths(dbPath, dataRoot);
  const stats = { sessions: 0, databaseBytes: databaseBytes(database) };
  if (!existsSync(database)) return stats;
  let db;
  try {
    db = new DatabaseSync(database, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row?.name || '')));
    if (tables.has('session_v2')) {
      const row = db.prepare('SELECT COUNT(*) AS count FROM "session_v2"').get();
      stats.sessions = Number(row?.count || 0);
    }
  } finally {
    try { db?.close(); } catch {}
  }
  return stats;
}

const errorText = (error) => (typeof error === 'string' ? error : error?.message || error?.data?.message || error?._tag || 'unknown error');

/**
 * Delete every OpenCode session through `client` (lib/opencode2-client.js: `session.list` and `session.delete`,
 * answering `{ data, error, response }`): a page of root sessions at a time, newest first, live ones and then
 * archived ones; a root takes its child sessions with it. A session already gone (404) counts as deleted. Stops on
 * a page where nothing could be deleted; what failed is in `failed`. Resolves
 * `{ sessionsDeleted, failed: [{ id, error }], warnings }`; throws when the list itself cannot be read.
 */
export async function clearOpenCodeHistory(client, { pageSize = 100, maxPages = 1000 } = {}) {
  const result = { sessionsDeleted: 0, failed: [], warnings: [] };
  const failedIds = new Set();
  for (const archived of [false, true]) {
    for (let page = 0; page < maxPages; page++) {
      const listed = await client.session.list({ roots: true, limit: pageSize, ...(archived ? { archived: true } : {}) });
      if (listed?.error) throw new Error(`OpenCode did not list its sessions: ${errorText(listed.error)}`);
      const ids = (Array.isArray(listed?.data) ? listed.data : []).map((session) => session?.id).filter((id) => id && !failedIds.has(id));
      if (!ids.length) break;
      let deleted = 0;
      for (const id of ids) {
        const removed = await client.session.delete({ sessionID: id });
        if (removed?.error && Number(removed.response?.status) !== 404) {
          failedIds.add(id);
          result.failed.push({ id, error: errorText(removed.error) });
        } else {
          result.sessionsDeleted += 1;
          deleted += 1;
        }
      }
      if (!deleted) break;
    }
  }
  if (result.failed.length) {
    result.warnings.push(`${result.failed.length} OpenCode session(s) could not be deleted (${result.failed[0].error}).`);
  }
  return result;
}
