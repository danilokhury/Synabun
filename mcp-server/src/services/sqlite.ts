/**
 * SQLite storage layer.
 * Uses Node.js built-in node:sqlite (available since Node 22.5.0).
 * Vectors stored as Float32Array BLOBs, cosine similarity computed in JS.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import path from 'path';
import fs from 'fs';
import { config } from '../config.js';
import { getAllCategories } from './categories.js';
import { VectorCache } from './vector-cache.js';
import { REGION_BY_CURRENCY, resolveClassification } from './fb-regions.js';
import type { MemoryPayload, MemoryStats, SessionChunkPayload } from '../types.js';

type SQLValue = null | number | bigint | string | Uint8Array;

// Re-export for backward compat (was used by categories.ts)
export const CATEGORIES_POINT_ID = '00000000-0000-0000-0000-000000000000';

let db: DatabaseSync | null = null;

function getDbPath(): string {
  const envPath = process.env.SQLITE_DB_PATH;
  const defaultPath = path.join(config.dataDir, 'memory.db');
  if (!envPath) return defaultPath;
  // If the env path's parent directory doesn't exist (e.g. Windows path on Mac),
  // fall back to the local default so cross-OS restores work instantly
  if (!fs.existsSync(path.dirname(envPath))) return defaultPath;
  return envPath;
}

function getDb(): DatabaseSync {
  if (!db) {
    db = new DatabaseSync(getDbPath());
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
  }
  return db;
}

// --- In-memory vector caches (see vector-cache.ts for coherence model) ---

const memoryVectors = new VectorCache(
  getDb,
  'SELECT id, vector FROM memories WHERE trashed_at IS NULL',
  'SELECT vector FROM memories WHERE id = ? AND trashed_at IS NULL',
);

const chunkVectors = new VectorCache(
  getDb,
  'SELECT id, vector FROM session_chunks',
  'SELECT vector FROM session_chunks WHERE id = ?',
);

// --- Vector encoding/decoding ---

function encodeVector(vector: number[]): Uint8Array {
  const f32 = new Float32Array(vector);
  return new Uint8Array(f32.buffer);
}

// --- Filter translation ---

interface FilterCondition {
  key: string;
  match?: { value: string | number };
  range?: { gte?: number; lte?: number; gt?: number; lt?: number };
  is_empty?: { key: string };
}

interface MemoryFilter {
  must?: FilterCondition[];
  must_not?: FilterCondition[];
  should?: FilterCondition[];
}

/**
 * Translates JSON filters to SQL WHERE clauses.
 * Supports: exact match, range, tags (JSON array contains), is_empty.
 */
function translateFilter(filter?: Record<string, unknown>): { where: string; params: SQLValue[] } {
  if (!filter) return { where: '', params: [] };

  const f = filter as MemoryFilter;
  const clauses: string[] = [];
  const params: SQLValue[] = [];

  for (const cond of f.must || []) {
    if (cond.match) {
      if (cond.key === 'tags') {
        clauses.push(`EXISTS (SELECT 1 FROM json_each(tags) WHERE json_each.value = ?)`);
        params.push(cond.match.value);
      } else {
        clauses.push(`${sanitizeColumn(cond.key)} = ?`);
        params.push(cond.match.value);
      }
    } else if (cond.range) {
      const col = sanitizeColumn(cond.key);
      if (cond.range.gte !== undefined) { clauses.push(`${col} >= ?`); params.push(cond.range.gte); }
      if (cond.range.lte !== undefined) { clauses.push(`${col} <= ?`); params.push(cond.range.lte); }
      if (cond.range.gt !== undefined) { clauses.push(`${col} > ?`); params.push(cond.range.gt); }
      if (cond.range.lt !== undefined) { clauses.push(`${col} < ?`); params.push(cond.range.lt); }
    } else if (cond.is_empty) {
      clauses.push(`(${sanitizeColumn(cond.is_empty.key)} IS NULL OR ${sanitizeColumn(cond.is_empty.key)} = '')`);
    }
  }

  for (const cond of f.must_not || []) {
    if (cond.match) {
      clauses.push(`(${sanitizeColumn(cond.key)} IS NULL OR ${sanitizeColumn(cond.key)} != ?)`);
      params.push(cond.match.value);
    }
  }

  return {
    where: clauses.length > 0 ? ' AND ' + clauses.join(' AND ') : '',
    params,
  };
}

/** Allowlist of valid column names to prevent SQL injection */
const VALID_COLUMNS = new Set([
  'id', 'content', 'category', 'subcategory', 'project', 'tags', 'importance',
  'source', 'created_at', 'updated_at', 'accessed_at', 'access_count',
  'related_files', 'related_memory_ids', 'file_checksums', 'trashed_at',
  'source_session_chunks', '_type',
  // session_chunks columns
  'session_id', 'git_branch', 'cwd', 'chunk_index', 'start_timestamp',
  'end_timestamp', 'tools_used', 'files_modified', 'files_read',
  'user_messages', 'turn_count', 'dedup_memory_id', 'indexed_at', 'summary',
]);

function sanitizeColumn(name: string): string {
  if (!VALID_COLUMNS.has(name)) {
    throw new Error(`Invalid column name: ${name}`);
  }
  return name;
}

// --- Schema initialization ---

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  id              TEXT PRIMARY KEY,
  vector          BLOB NOT NULL,
  content         TEXT NOT NULL,
  category        TEXT NOT NULL,
  subcategory     TEXT,
  project         TEXT NOT NULL,
  tags            TEXT NOT NULL DEFAULT '[]',
  importance      INTEGER NOT NULL DEFAULT 5,
  source          TEXT NOT NULL DEFAULT 'self-discovered',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  accessed_at     TEXT NOT NULL,
  access_count    INTEGER NOT NULL DEFAULT 0,
  related_files   TEXT,
  related_memory_ids TEXT,
  file_checksums  TEXT,
  trashed_at      TEXT,
  source_session_chunks TEXT
);

CREATE TABLE IF NOT EXISTS session_chunks (
  id              TEXT PRIMARY KEY,
  vector          BLOB NOT NULL,
  content         TEXT NOT NULL,
  summary         TEXT,
  session_id      TEXT,
  project         TEXT,
  git_branch      TEXT,
  cwd             TEXT,
  chunk_index     INTEGER DEFAULT 0,
  start_timestamp TEXT,
  end_timestamp   TEXT,
  tools_used      TEXT DEFAULT '[]',
  files_modified  TEXT DEFAULT '[]',
  files_read      TEXT DEFAULT '[]',
  user_messages   TEXT DEFAULT '[]',
  turn_count      INTEGER DEFAULT 0,
  related_memory_ids TEXT DEFAULT '[]',
  dedup_memory_id TEXT,
  indexed_at      TEXT
);

CREATE TABLE IF NOT EXISTS categories (
  name            TEXT PRIMARY KEY,
  description     TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  parent          TEXT,
  color           TEXT,
  is_parent       INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_mem_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_mem_project ON memories(project);
CREATE INDEX IF NOT EXISTS idx_mem_importance ON memories(importance);
CREATE INDEX IF NOT EXISTS idx_mem_trashed ON memories(trashed_at);
CREATE INDEX IF NOT EXISTS idx_mem_created ON memories(created_at);
CREATE INDEX IF NOT EXISTS idx_mem_source ON memories(source);
CREATE INDEX IF NOT EXISTS idx_sc_session ON session_chunks(session_id);
CREATE INDEX IF NOT EXISTS idx_sc_project ON session_chunks(project);
CREATE INDEX IF NOT EXISTS idx_sc_branch ON session_chunks(git_branch);

CREATE TABLE IF NOT EXISTS kv_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// FTS5 created separately since CREATE VIRTUAL TABLE IF NOT EXISTS
// can fail silently on some SQLite versions
const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content, category, project, tags,
  content=memories, content_rowid=rowid,
  tokenize='porter unicode61'
);
`;

// Facebook group directory — structured single source of truth for the Critical Pixel
// group collection. One row per group (fb_groups), one append-only row per posting event
// (fb_post_log). Replaces the fragile single-text seed-queue memory whose [QUEUE] was once
// wiped by a whole-body reflect(); atomic per-row writes make that data-loss class impossible.
const FB_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS fb_groups (
  url            TEXT PRIMARY KEY,
  name           TEXT NOT NULL DEFAULT '',
  region         TEXT,
  country        TEXT,
  lang           TEXT,
  currency       TEXT,
  joined         INTEGER NOT NULL DEFAULT 1,
  allows_promo   TEXT NOT NULL DEFAULT 'unknown',
  member_count   INTEGER,
  pending_since  TEXT,
  cooldown_until TEXT,
  last_status    TEXT,
  last_error     TEXT,
  notes          TEXT,
  source         TEXT NOT NULL DEFAULT 'import',
  added_at       TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fb_post_log (
  id          TEXT PRIMARY KEY,
  group_url   TEXT NOT NULL,
  offer_slug  TEXT NOT NULL,
  currency    TEXT,
  status      TEXT NOT NULL,
  post_url    TEXT,
  session_id  TEXT,
  posted_at   TEXT NOT NULL,
  note        TEXT
);

CREATE INDEX IF NOT EXISTS idx_fbg_region   ON fb_groups(region);
CREATE INDEX IF NOT EXISTS idx_fbg_joined   ON fb_groups(joined);
CREATE INDEX IF NOT EXISTS idx_fbg_promo    ON fb_groups(allows_promo);
CREATE INDEX IF NOT EXISTS idx_fbpl_url     ON fb_post_log(group_url);
CREATE INDEX IF NOT EXISTS idx_fbpl_offer   ON fb_post_log(offer_slug);
CREATE INDEX IF NOT EXISTS idx_fbpl_posted  ON fb_post_log(posted_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fbpl_url_offer_day
  ON fb_post_log(group_url, offer_slug, substr(posted_at,1,10));
`;

// --- Public API: Collection initialization ---

export async function ensureCollection(): Promise<void> {
  const d = getDb();
  d.exec(SCHEMA_SQL);
  d.exec(FB_SCHEMA_SQL);
  try {
    d.exec(FTS_SQL);
  } catch {
    // FTS5 may already exist or not be available
  }
}

export async function ensureSessionCollection(): Promise<void> {
  // No-op: session_chunks table is created in ensureCollection()
}

/** Combined init function for cleaner startup */
export async function ensureDatabase(): Promise<void> {
  await ensureCollection();
}

// --- Public API: Memory operations ---

export async function upsertMemory(
  id: string,
  vector: number[],
  payload: MemoryPayload
): Promise<void> {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT OR REPLACE INTO memories
      (id, vector, content, category, subcategory, project, tags, importance, source,
       created_at, updated_at, accessed_at, access_count, related_files,
       related_memory_ids, file_checksums, trashed_at, source_session_chunks)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    id,
    encodeVector(vector),
    payload.content,
    payload.category,
    payload.subcategory ?? null,
    payload.project,
    JSON.stringify(payload.tags || []),
    payload.importance ?? 5,
    payload.source || 'self-discovered',
    payload.created_at,
    payload.updated_at,
    payload.accessed_at,
    payload.access_count ?? 0,
    payload.related_files ? JSON.stringify(payload.related_files) : null,
    payload.related_memory_ids ? JSON.stringify(payload.related_memory_ids) : null,
    payload.file_checksums ? JSON.stringify(payload.file_checksums) : null,
    payload.trashed_at ?? null,
    payload.source_session_chunks ? JSON.stringify(payload.source_session_chunks) : null,
  );

  if (payload.trashed_at) memoryVectors.remove(id);
  else memoryVectors.set(id, vector);

  // Update FTS index
  try {
    d.prepare(`INSERT OR REPLACE INTO memories_fts(rowid, content, category, project, tags)
      SELECT rowid, content, category, project, tags FROM memories WHERE id = ?`).run(id);
  } catch {
    // FTS update failure is non-fatal
  }
}

export async function searchMemories(
  vector: number[],
  limit: number,
  filter?: Record<string, unknown>,
  scoreThreshold?: number
) {
  const d = getDb();
  const threshold = scoreThreshold ?? 0.3;

  // When a filter is present, resolve the matching id set via the indexed
  // SQL WHERE first, then score only those rows in the vector cache.
  let allowedIds: Set<string> | undefined;
  const { where, params } = translateFilter(filter);
  if (where) {
    const idRows = d.prepare(`
      SELECT id FROM memories WHERE trashed_at IS NULL${where}
    `).all(...params) as Array<{ id: string }>;
    allowedIds = new Set(idRows.map((r) => r.id));
    if (allowedIds.size === 0) return [];
  }

  const top = memoryVectors.topK(vector, limit, threshold, allowedIds);
  if (top.length === 0) return [];

  // Hydrate payloads for just the top K rows
  const placeholders = top.map(() => '?').join(', ');
  const rows = d.prepare(`
    SELECT id, content, category, subcategory, project, tags, importance, source,
           created_at, updated_at, accessed_at, access_count, related_files,
           related_memory_ids, file_checksums, trashed_at, source_session_chunks
    FROM memories
    WHERE id IN (${placeholders})
  `).all(...top.map((t) => t.id)) as Array<Record<string, unknown>>;

  const rowById = new Map(rows.map((r) => [r.id as string, r]));
  return top
    .filter((t) => rowById.has(t.id))
    .map((t) => ({
      id: t.id,
      score: t.score,
      payload: rowToPayload(rowById.get(t.id)!),
    }));
}

export async function getMemory(id: string) {
  const d = getDb();
  const row = d.prepare(`
    SELECT id, content, category, subcategory, project, tags, importance, source,
           created_at, updated_at, accessed_at, access_count, related_files,
           related_memory_ids, file_checksums, trashed_at, source_session_chunks
    FROM memories WHERE id = ?
  `).get(id) as Record<string, unknown> | undefined;

  if (!row) return null;
  return { id: row.id as string, payload: rowToPayload(row) };
}

export async function updatePayload(
  id: string,
  payload: Partial<MemoryPayload>
): Promise<void> {
  const d = getDb();
  const sets: string[] = [];
  const params: SQLValue[] = [];

  for (const [key, value] of Object.entries(payload)) {
    if (key === 'id' || key === 'vector') continue;
    const col = sanitizeColumn(key);
    if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
      sets.push(`${col} = ?`);
      params.push(JSON.stringify(value));
    } else {
      sets.push(`${col} = ?`);
      params.push((value ?? null) as SQLValue);
    }
  }

  if (sets.length === 0) return;
  params.push(id);
  d.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  // Keep the vector cache in sync with trash-state transitions
  if ('trashed_at' in payload) {
    if (payload.trashed_at) memoryVectors.remove(id);
    else memoryVectors.setFromDb(id);
  }

  // Update FTS if content changed
  if (payload.content) {
    try {
      d.prepare(`INSERT OR REPLACE INTO memories_fts(rowid, content, category, project, tags)
        SELECT rowid, content, category, project, tags FROM memories WHERE id = ?`).run(id);
    } catch { /* non-fatal */ }
  }
}

export async function updateVector(
  id: string,
  vector: number[],
  payload: MemoryPayload
): Promise<void> {
  // Full upsert — replaces both vector and payload
  await upsertMemory(id, vector, payload);
}

export async function updatePayloadByFilter(
  filter: Record<string, unknown>,
  payload: Partial<MemoryPayload>
): Promise<void> {
  const d = getDb();
  const { where, params: filterParams } = translateFilter(filter);

  const sets: string[] = [];
  const setParams: SQLValue[] = [];

  for (const [key, value] of Object.entries(payload)) {
    if (key === 'id' || key === 'vector') continue;
    const col = sanitizeColumn(key);
    if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
      sets.push(`${col} = ?`);
      setParams.push(JSON.stringify(value));
    } else {
      sets.push(`${col} = ?`);
      setParams.push((value ?? null) as SQLValue);
    }
  }

  if (sets.length === 0) return;
  d.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE trashed_at IS NULL${where}`)
    .run(...setParams, ...filterParams);

  // Bulk path — affected ids unknown here; reload lazily on next search
  if ('trashed_at' in payload) memoryVectors.invalidate();
}

export async function deleteMemory(id: string): Promise<void> {
  const d = getDb();
  d.prepare('DELETE FROM memories WHERE id = ?').run(id);
  memoryVectors.remove(id);
  try {
    d.prepare('DELETE FROM memories_fts WHERE rowid = (SELECT rowid FROM memories WHERE id = ?)').run(id);
  } catch { /* non-fatal */ }
}

export async function softDeleteMemory(id: string): Promise<void> {
  await updatePayload(id, { trashed_at: new Date().toISOString() } as Partial<MemoryPayload>);
}

/**
 * Batch access tracking for recall results: one UPDATE instead of N.
 * Leaves vectors untouched, so no cache maintenance is needed.
 */
export async function touchMemories(ids: string[], accessedAt: string): Promise<void> {
  if (ids.length === 0) return;
  const d = getDb();
  const placeholders = ids.map(() => '?').join(', ');
  d.prepare(`
    UPDATE memories SET accessed_at = ?, access_count = access_count + 1
    WHERE id IN (${placeholders})
  `).run(accessedAt, ...ids);
}

export async function restoreMemory(id: string): Promise<void> {
  const d = getDb();
  d.prepare('UPDATE memories SET trashed_at = NULL WHERE id = ?').run(id);
  memoryVectors.setFromDb(id);
}

export async function scrollMemories(
  filter?: Record<string, unknown>,
  limit: number = 20,
  offset?: string
) {
  const d = getDb();
  const { where, params } = translateFilter(filter);
  const numericOffset = offset ? parseInt(offset, 10) : 0;

  const rows = d.prepare(`
    SELECT id, content, category, subcategory, project, tags, importance, source,
           created_at, updated_at, accessed_at, access_count, related_files,
           related_memory_ids, file_checksums, trashed_at, source_session_chunks
    FROM memories
    WHERE trashed_at IS NULL${where}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, numericOffset) as Array<Record<string, unknown>>;

  const points = rows.map((row) => ({
    id: row.id as string,
    payload: rowToPayload(row),
  }));

  // Determine next offset
  const nextOffset = rows.length === limit ? String(numericOffset + limit) : null;

  return { points, next_page_offset: nextOffset };
}

export async function countMemories(filter?: Record<string, unknown>): Promise<number> {
  const d = getDb();
  const { where, params } = translateFilter(filter);
  const result = d.prepare(`
    SELECT COUNT(*) as cnt FROM memories WHERE trashed_at IS NULL${where}
  `).get(...params) as { cnt: number };
  return result.cnt;
}

/**
 * YouTube trailer dedup ledger — return the set of canonical keys
 * (igdb:/appid:/ytid:/name:) for every trailer already posted. youtube_source
 * uses this to drop already-posted candidates before the model sees them.
 *
 * Reads structured tags first (new `youtube-videos` rows written by
 * youtube_upload) and falls back to scanning free-text content for igdbId/appid
 * (legacy `youtube-trailers` rows from before the structured ledger existed).
 * Exact-match by design — never re-post a trailer regardless of how old the
 * ledger gets. Synchronous: this is a tiny indexed read, not a vector search.
 */
const TRAILER_LEDGER_CATEGORIES = ['youtube-videos', 'youtube-trailers'];
const TRAILER_KEY_RE = /^(igdb|appid|ytid|name):.+/;
export function getPostedTrailerKeys(): Set<string> {
  const keys = new Set<string>();
  let rows: Array<{ tags: string | null; content: string | null }> = [];
  try {
    const d = getDb();
    const placeholders = TRAILER_LEDGER_CATEGORIES.map(() => '?').join(', ');
    rows = d.prepare(
      `SELECT tags, content FROM memories WHERE category IN (${placeholders}) AND trashed_at IS NULL`,
    ).all(...TRAILER_LEDGER_CATEGORIES) as Array<{ tags: string | null; content: string | null }>;
  } catch {
    return keys; // dedup is best-effort: a read failure must not break sourcing
  }
  for (const r of rows) {
    // 1) structured dedup tags (preserve case — ytid is case-sensitive).
    try {
      for (const t of JSON.parse(r.tags || '[]')) {
        const s = String(t).trim();
        if (TRAILER_KEY_RE.test(s)) keys.add(s);
      }
    } catch { /* tags not JSON — fall through to content scan */ }
    // 2) content fallback for legacy free-text rows (igdbId / appid only).
    const content = r.content || '';
    const ig = content.match(/igdb\s*id[:=\s#]*([0-9]+)/i);
    if (ig) keys.add(`igdb:${ig[1]}`);
    const ap = content.match(/\bapp\s*id[:=\s#]*([0-9]+)/i);
    if (ap) keys.add(`appid:${ap[1]}`);
  }
  return keys;
}

export async function getMemoryStats(): Promise<MemoryStats> {
  const d = getDb();

  const totalRow = d.prepare('SELECT COUNT(*) as cnt FROM memories WHERE trashed_at IS NULL').get() as { cnt: number };
  const total = totalRow.cnt;

  // Per-category counts using SQL aggregate
  const catRows = d.prepare(`
    SELECT category, COUNT(*) as cnt FROM memories WHERE trashed_at IS NULL GROUP BY category
  `).all() as Array<{ category: string; cnt: number }>;
  const by_category: Record<string, number> = {};
  // Initialize with all known categories at 0
  for (const cat of getAllCategories()) {
    by_category[cat] = 0;
  }
  for (const row of catRows) {
    by_category[row.category] = row.cnt;
  }

  // Per-project counts
  const projRows = d.prepare(`
    SELECT project, COUNT(*) as cnt FROM memories WHERE trashed_at IS NULL GROUP BY project
  `).all() as Array<{ project: string; cnt: number }>;
  const by_project: Record<string, number> = {};
  for (const row of projRows) {
    by_project[row.project || 'global'] = row.cnt;
  }

  // Oldest/newest
  const dateRow = d.prepare(`
    SELECT MIN(created_at) as oldest, MAX(created_at) as newest FROM memories WHERE trashed_at IS NULL
  `).get() as { oldest: string | null; newest: string | null };

  return {
    total,
    by_category,
    by_project,
    oldest: dateRow.oldest ?? undefined,
    newest: dateRow.newest ?? undefined,
  };
}

// --- FTS5 full-text search ---

/**
 * Search memories using FTS5 full-text search (keyword fallback).
 * Returns results scored by BM25 relevance. Used when vector similarity
 * scores are low (exact identifiers, error codes, proper nouns).
 */
export async function searchMemoriesFTS(
  query: string,
  limit: number,
  filter?: Record<string, unknown>,
  excludeIds?: Set<string>
): Promise<Array<{ id: string; score: number; payload: MemoryPayload }>> {
  const d = getDb();

  // Sanitize query for FTS5: escape double quotes, wrap terms
  const ftsQuery = query
    .replace(/"/g, '""')
    .split(/\s+/)
    .filter(t => t.length > 1)
    .map(t => `"${t}"`)
    .join(' OR ');

  if (!ftsQuery) return [];

  const { where, params } = translateFilter(filter);

  try {
    const rows = d.prepare(`
      SELECT m.id, m.content, m.category, m.subcategory, m.project, m.tags,
             m.importance, m.source, m.created_at, m.updated_at, m.accessed_at,
             m.access_count, m.related_files, m.related_memory_ids,
             m.file_checksums, m.trashed_at, m.source_session_chunks,
             rank
      FROM memories_fts fts
      JOIN memories m ON m.rowid = fts.rowid
      WHERE memories_fts MATCH ? AND m.trashed_at IS NULL${where}
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, ...params, limit) as Array<Record<string, unknown>>;

    return rows
      .filter(row => !excludeIds || !excludeIds.has(row.id as string))
      .map(row => {
        // FTS5 rank is negative (lower = better match). Normalize to 0-1 range.
        const rawRank = Math.abs(row.rank as number);
        const normalizedScore = Math.min(1, rawRank / 10);
        return {
          id: row.id as string,
          score: normalizedScore,
          payload: rowToPayload(row),
        };
      });
  } catch {
    // FTS5 not available or query error — return empty
    return [];
  }
}

// --- Session Chunks ---

export async function searchSessionChunks(
  vector: number[],
  limit: number,
  filter?: Record<string, unknown>,
  scoreThreshold = 0.3
) {
  const d = getDb();

  let allowedIds: Set<string> | undefined;
  const { where, params } = translateFilter(filter);
  if (where) {
    const idRows = d.prepare(`
      SELECT id FROM session_chunks WHERE 1=1${where}
    `).all(...params) as Array<{ id: string }>;
    allowedIds = new Set(idRows.map((r) => r.id));
    if (allowedIds.size === 0) return [];
  }

  const top = chunkVectors.topK(vector, limit, scoreThreshold, allowedIds);
  if (top.length === 0) return [];

  const placeholders = top.map(() => '?').join(', ');
  const rows = d.prepare(`
    SELECT id, content, summary, session_id, project, git_branch, cwd,
           chunk_index, start_timestamp, end_timestamp, tools_used, files_modified,
           files_read, user_messages, turn_count, related_memory_ids, dedup_memory_id, indexed_at
    FROM session_chunks
    WHERE id IN (${placeholders})
  `).all(...top.map((t) => t.id)) as Array<Record<string, unknown>>;

  const rowById = new Map(rows.map((r) => [r.id as string, r]));
  return top
    .filter((t) => rowById.has(t.id))
    .map((t) => ({
      id: t.id,
      score: t.score,
      payload: rowToSessionChunkPayload(rowById.get(t.id)!),
    }));
}

export async function upsertSessionChunks(
  points: Array<{ id: string; vector: number[]; payload: SessionChunkPayload }>
): Promise<void> {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT OR REPLACE INTO session_chunks
      (id, vector, content, summary, session_id, project, git_branch, cwd,
       chunk_index, start_timestamp, end_timestamp, tools_used, files_modified,
       files_read, user_messages, turn_count, related_memory_ids, dedup_memory_id, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Manual transaction since node:sqlite doesn't have db.transaction()
  d.exec('BEGIN');
  try {
    for (const p of points) {
      stmt.run(
        p.id,
        encodeVector(p.vector),
        p.payload.content,
        p.payload.summary || null,
        p.payload.session_id || null,
        p.payload.project || null,
        p.payload.git_branch ?? null,
        p.payload.cwd ?? null,
        p.payload.chunk_index ?? 0,
        p.payload.start_timestamp || null,
        p.payload.end_timestamp || null,
        JSON.stringify(p.payload.tools_used || []),
        JSON.stringify(p.payload.files_modified || []),
        JSON.stringify(p.payload.files_read || []),
        JSON.stringify(p.payload.user_messages || []),
        p.payload.turn_count ?? 0,
        JSON.stringify(p.payload.related_memory_ids || []),
        p.payload.dedup_memory_id ?? null,
        p.payload.indexed_at || new Date().toISOString(),
      );
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }

  for (const p of points) chunkVectors.set(p.id, p.vector);
}

export async function scrollSessionChunks(
  filter?: Record<string, unknown>,
  limit: number = 20,
  offset?: string
) {
  const d = getDb();
  const { where, params } = translateFilter(filter);
  const numericOffset = offset ? parseInt(offset, 10) : 0;

  const rows = d.prepare(`
    SELECT id, content, summary, session_id, project, git_branch, cwd,
           chunk_index, start_timestamp, end_timestamp, tools_used, files_modified,
           files_read, user_messages, turn_count, related_memory_ids, dedup_memory_id, indexed_at
    FROM session_chunks
    WHERE 1=1${where}
    ORDER BY indexed_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, numericOffset) as Array<Record<string, unknown>>;

  const points = rows.map((row) => ({
    id: row.id as string,
    payload: rowToSessionChunkPayload(row),
  }));

  const nextOffset = rows.length === limit ? String(numericOffset + limit) : null;
  return { points, next_page_offset: nextOffset };
}

export async function countSessionChunks(filter?: Record<string, unknown>): Promise<number> {
  const d = getDb();
  const { where, params } = translateFilter(filter);
  const result = d.prepare(`SELECT COUNT(*) as cnt FROM session_chunks WHERE 1=1${where}`)
    .get(...params) as { cnt: number };
  return result.cnt;
}

// --- Categories stored in SQLite ---

interface StoredCategory {
  name: string;
  description: string;
  created_at: string;
  parent?: string;
  color?: string;
  is_parent?: boolean;
}

export async function getCategories(): Promise<StoredCategory[] | null> {
  try {
    const d = getDb();
    const rows = d.prepare('SELECT name, description, created_at, parent, color, is_parent FROM categories ORDER BY name')
      .all() as Array<Record<string, unknown>>;
    if (rows.length === 0) return null;
    return rows.map((row) => ({
      name: row.name as string,
      description: row.description as string,
      created_at: row.created_at as string,
      parent: row.parent as string | undefined,
      color: row.color as string | undefined,
      is_parent: row.is_parent === 1 ? true : undefined,
    }));
  } catch {
    return null;
  }
}

export async function saveCategories(categories: StoredCategory[]): Promise<void> {
  const d = getDb();
  const insertStmt = d.prepare(`
    INSERT OR REPLACE INTO categories (name, description, created_at, parent, color, is_parent)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  // Manual transaction
  d.exec('BEGIN');
  try {
    // Get existing names to detect deletions
    const existing = new Set(
      (d.prepare('SELECT name FROM categories').all() as Array<{ name: string }>).map((r) => r.name)
    );
    const incoming = new Set(categories.map((c) => c.name));

    // Delete removed categories
    for (const name of existing) {
      if (!incoming.has(name)) {
        d.prepare('DELETE FROM categories WHERE name = ?').run(name);
      }
    }

    // Upsert all incoming
    for (const cat of categories) {
      insertStmt.run(
        cat.name,
        cat.description,
        cat.created_at,
        cat.parent ?? null,
        cat.color ?? null,
        cat.is_parent ? 1 : 0,
      );
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

// --- Facebook group directory (fb_groups + fb_post_log) ---

const FB_COOLDOWN_HOURS_DEFAULT = 48;

export interface FbGroupUpsert {
  url: string;
  name?: string;
  region?: string | null;
  country?: string | null;
  lang?: string | null;
  currency?: string | null;
  joined?: number;
  allows_promo?: 'true' | 'false' | 'unknown';
  member_count?: number | null;
  notes?: string | null;
  source?: string;
}

export interface FbPostLogEntry {
  id?: string;
  group_url: string;
  offer_slug: string;
  currency?: string | null;
  status: string;
  post_url?: string | null;
  session_id?: string | null;
  posted_at?: string;
  note?: string | null;
}

export interface FbWorklistOpts {
  region?: string | null;
  currency?: string | null;
  lang?: string | null;
  country?: string | null;
  offerSlug: string;
  limit?: number;
  includePending?: boolean;
  freshDays?: number;
  reset?: boolean;
}

export interface FbWorklistItem {
  url: string;
  name: string;
  region: string | null;
  currency: string | null;
  lang: string | null;
  member_count: number | null;
  allows_promo: string;
  lastPosted: string | null;
}

// COALESCE merge so a partial update never nulls richer prior data; name only overwrites when
// non-empty; 'false' promo is sticky (an excluded group can't be silently re-opened by an import).
const FB_GROUP_UPSERT_SQL = `
  INSERT INTO fb_groups (url, name, region, country, lang, currency, joined, allows_promo,
                         member_count, notes, source, added_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(url) DO UPDATE SET
    name = CASE WHEN excluded.name != '' THEN excluded.name ELSE fb_groups.name END,
    region = COALESCE(excluded.region, fb_groups.region),
    country = COALESCE(excluded.country, fb_groups.country),
    lang = COALESCE(excluded.lang, fb_groups.lang),
    currency = COALESCE(excluded.currency, fb_groups.currency),
    joined = excluded.joined,
    allows_promo = CASE
      WHEN fb_groups.allows_promo = 'false' THEN 'false'
      WHEN excluded.allows_promo = 'unknown' THEN fb_groups.allows_promo
      ELSE excluded.allows_promo END,
    member_count = COALESCE(excluded.member_count, fb_groups.member_count),
    notes = COALESCE(excluded.notes, fb_groups.notes),
    source = COALESCE(excluded.source, fb_groups.source),
    updated_at = excluded.updated_at
`;

const FB_POSTLOG_SQL = `
  INSERT OR REPLACE INTO fb_post_log
    (id, group_url, offer_slug, currency, status, post_url, session_id, posted_at, note)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

function runFbGroupUpsert(stmt: StatementSync, row: FbGroupUpsert, now: string): void {
  stmt.run(
    row.url,
    row.name ?? '',
    row.region ?? null,
    row.country ?? null,
    row.lang ?? null,
    row.currency ?? null,
    row.joined ?? 1,
    row.allows_promo ?? 'unknown',
    row.member_count ?? null,
    row.notes ?? null,
    row.source ?? 'import',
    now, // added_at (ignored on conflict)
    now, // updated_at
  );
}

function runFbPostLog(stmt: StatementSync, e: FbPostLogEntry, now: string): void {
  stmt.run(
    e.id ?? randomUUID(),
    e.group_url,
    e.offer_slug,
    e.currency ?? null,
    e.status,
    e.post_url ?? null,
    e.session_id ?? null,
    e.posted_at ?? now,
    e.note ?? null,
  );
}

/** Upsert one group row (idempotent, COALESCE merge). */
export function upsertFbGroup(row: FbGroupUpsert): void {
  const d = getDb();
  runFbGroupUpsert(d.prepare(FB_GROUP_UPSERT_SQL), row, new Date().toISOString());
}

/** Bulk migration write — many group upserts + post-log rows in one transaction. */
export function importFbData(groups: FbGroupUpsert[], logs: FbPostLogEntry[]): { groupsUpserted: number; postLogRows: number } {
  const d = getDb();
  const now = new Date().toISOString();
  const gStmt = d.prepare(FB_GROUP_UPSERT_SQL);
  const lStmt = d.prepare(FB_POSTLOG_SQL);
  d.exec('BEGIN');
  try {
    for (const g of groups) runFbGroupUpsert(gStmt, g, now);
    for (const l of logs) runFbPostLog(lStmt, l, now);
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
  return { groupsUpserted: groups.length, postLogRows: logs.length };
}

/**
 * The per-group checklist tick. One atomic transaction: ensure/refresh the group row, set its
 * state from the status (pending-approval engages a cooldown; visible-post clears it; failed/
 * skipped leave state untouched), and append the durable fb_post_log row. Replaces the
 * corruption-prone reflect-into-ledger entirely.
 */
export function markFbGroup(opts: {
  url: string;
  offerSlug: string;
  currency?: string | null;
  status: string;
  postUrl?: string | null;
  note?: string | null;
  sessionId?: string | null;
  name?: string;
  region?: string | null;
  lang?: string | null;
  cooldownHours?: number;
}): { url: string; status: string; pending_since: string | null; cooldown_until: string | null } {
  const d = getDb();
  const now = new Date().toISOString();
  const status = opts.status;
  const isPending = status === 'pending-approval';
  const isPosted = status === 'visible-post';
  const cooldownH = opts.cooldownHours ?? FB_COOLDOWN_HOURS_DEFAULT;
  const cooldownUntil = isPending ? new Date(Date.now() + cooldownH * 3600_000).toISOString() : null;

  d.exec('BEGIN');
  try {
    // Ensure the group row exists / refresh descriptive fields (no state touch here).
    runFbGroupUpsert(d.prepare(FB_GROUP_UPSERT_SQL), {
      url: opts.url, name: opts.name, region: opts.region, lang: opts.lang,
      currency: opts.currency ?? undefined, joined: 1, source: 'manual',
    }, now);
    // last_status / last_error / currency.
    d.prepare(`UPDATE fb_groups SET last_status = ?, last_error = ?, currency = COALESCE(?, currency), updated_at = ? WHERE url = ?`)
      .run(status, status === 'posting-failed' ? (opts.note ?? 'posting-failed') : null, opts.currency ?? null, now, opts.url);
    // Pending/cooldown state — explicit so visible-post can clear a prior wall.
    if (isPending) {
      d.prepare(`UPDATE fb_groups SET pending_since = ?, cooldown_until = ? WHERE url = ?`).run(now, cooldownUntil, opts.url);
    } else if (isPosted) {
      d.prepare(`UPDATE fb_groups SET pending_since = NULL, cooldown_until = NULL WHERE url = ?`).run(opts.url);
    }
    // Durable append-only log row (one per group/offer/day; latest status wins).
    runFbPostLog(d.prepare(FB_POSTLOG_SQL), {
      group_url: opts.url, offer_slug: opts.offerSlug, currency: opts.currency ?? null,
      status, post_url: opts.postUrl ?? null, session_id: opts.sessionId ?? null, posted_at: now, note: opts.note ?? null,
    }, now);
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }

  const row = d.prepare(`SELECT pending_since, cooldown_until FROM fb_groups WHERE url = ?`).get(opts.url) as Record<string, unknown> | undefined;
  return {
    url: opts.url, status,
    pending_since: (row?.pending_since as string) ?? null,
    cooldown_until: (row?.cooldown_until as string) ?? null,
  };
}

/**
 * The efficient region fetch + resume engine. Returns the groups still to post to for this offer:
 * joined, promo not forbidden, region/currency match, not pending/cooldown (unless includePending),
 * and not already posted for this offer within freshDays (unless reset). Never-posted first, then
 * least-recently-posted, then largest membership.
 */
export function selectFbWorklist(opts: FbWorklistOpts): FbWorklistItem[] {
  const d = getDb();
  const { region, currency, offerSlug } = opts;
  const limit = opts.limit ?? 20;
  const freshDays = opts.freshDays ?? 14;
  const includePending = opts.includePending ?? false;
  const reset = opts.reset ?? false;
  const now = new Date();
  const nowIso = now.toISOString();

  const where: string[] = ['g.joined = 1', "g.allows_promo != 'false'"];
  const params: SQLValue[] = [];

  if (currency) {
    const ccy = currency.toUpperCase();
    const regionForCcy = REGION_BY_CURRENCY[ccy] || null;
    if (regionForCcy) {
      // Authoritative seed-queue currency, plus currency-less groups in that region.
      where.push('(upper(g.currency) = ? OR (g.currency IS NULL AND g.region = ?))');
      params.push(ccy, regionForCcy);
    } else {
      where.push('upper(g.currency) = ?');
      params.push(ccy);
    }
  } else if (region) {
    where.push('lower(g.region) = lower(?)');
    params.push(region);
  }

  // Optional finer targeting (e.g. split the EU currency bucket by language for native-copy seeding).
  if (opts.lang) {
    where.push('lower(g.lang) = lower(?)');
    params.push(opts.lang);
  }
  if (opts.country) {
    where.push('lower(g.country) = lower(?)');
    params.push(opts.country);
  }

  if (!includePending) {
    where.push('g.pending_since IS NULL');
    where.push('(g.cooldown_until IS NULL OR g.cooldown_until <= ?)');
    params.push(nowIso);
  }

  if (!reset && offerSlug) {
    const cutoff = new Date(now.getTime() - freshDays * 86400_000).toISOString();
    where.push(
      `NOT EXISTS (SELECT 1 FROM fb_post_log p WHERE p.group_url = g.url AND p.offer_slug = ? ` +
      `AND p.status IN ('visible-post','pending-approval') AND p.posted_at >= ?)`
    );
    params.push(offerSlug, cutoff);
  }

  const sql = `
    SELECT g.url, g.name, g.region, g.currency, g.lang, g.member_count, g.allows_promo,
           (SELECT MAX(posted_at) FROM fb_post_log p WHERE p.group_url = g.url) AS last_any_posted
    FROM fb_groups g
    WHERE ${where.join(' AND ')}
    ORDER BY (last_any_posted IS NULL) DESC, last_any_posted ASC, g.member_count DESC
    LIMIT ?`;
  params.push(limit);

  const rows = d.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    url: r.url as string,
    name: r.name as string,
    region: (r.region as string) ?? null,
    currency: (r.currency as string) ?? null,
    lang: (r.lang as string) ?? null,
    member_count: (r.member_count as number) ?? null,
    allows_promo: r.allows_promo as string,
    lastPosted: (r.last_any_posted as string) ?? null,
  }));
}

/** Set/clear a group's promo permission (the exclude action). Overrides the sticky-'false' rule. */
export function setFbAllowsPromo(url: string, value: 'true' | 'false' | 'unknown', note?: string): void {
  const d = getDb();
  const now = new Date().toISOString();
  runFbGroupUpsert(d.prepare(FB_GROUP_UPSERT_SQL), { url, joined: 1, allows_promo: value, notes: note, source: 'manual' }, now);
  d.prepare(`UPDATE fb_groups SET allows_promo = ?, notes = COALESCE(?, notes), updated_at = ? WHERE url = ?`)
    .run(value, note ?? null, now, url);
}

/**
 * Curation write: authoritatively set specific columns on a group. Ensures the row exists, then
 * UPDATEs ONLY the provided fields (undefined = leave untouched). Unlike upsertFbGroup's COALESCE
 * merge, this overrides — so it can correct a wrong region or re-open promo. Column names come from
 * a fixed allowlist (no injection).
 */
export function setFbGroupFields(url: string, fields: {
  region?: string; lang?: string | null; currency?: string | null; country?: string | null;
  name?: string; member_count?: number | null; allows_promo?: 'true' | 'false' | 'unknown'; notes?: string | null;
}): void {
  const d = getDb();
  const now = new Date().toISOString();
  runFbGroupUpsert(d.prepare(FB_GROUP_UPSERT_SQL), { url, joined: 1, source: 'curated' }, now);
  const allow: Array<[string, unknown]> = [
    ['region', fields.region], ['lang', fields.lang], ['currency', fields.currency],
    ['country', fields.country], ['name', fields.name], ['member_count', fields.member_count],
    ['allows_promo', fields.allows_promo], ['notes', fields.notes],
  ];
  const cols: string[] = [];
  const params: SQLValue[] = [];
  for (const [col, val] of allow) {
    if (val !== undefined) { cols.push(`${col} = ?`); params.push((val as SQLValue) ?? null); }
  }
  if (cols.length === 0) return;
  cols.push('updated_at = ?');
  params.push(now, url);
  d.prepare(`UPDATE fb_groups SET ${cols.join(', ')} WHERE url = ?`).run(...params);
}

/** List group rows, optionally filtered to one region. */
export function selectFbGroups(region?: string): Array<Record<string, unknown>> {
  const d = getDb();
  const cols = `url, name, region, country, lang, currency, joined, allows_promo, member_count, pending_since, cooldown_until, last_status, source, updated_at`;
  if (region) {
    return d.prepare(`SELECT ${cols} FROM fb_groups WHERE lower(region) = lower(?) ORDER BY member_count DESC, name`).all(region) as Array<Record<string, unknown>>;
  }
  return d.prepare(`SELECT ${cols} FROM fb_groups ORDER BY region, member_count DESC, name`).all() as Array<Record<string, unknown>>;
}

/** Coverage + health aggregates for the list/stats action. */
export function fbStats(region?: string): {
  byRegion: Record<string, { total: number; joined: number; promoOk: number; promoNo: number; pending: number; cooldown: number }>;
  totals: { groups: number; joined: number; pending: number; logRows: number };
  lastPostedPerOffer: Record<string, string>;
} {
  const d = getDb();
  const now = new Date().toISOString();
  const regWhere = region ? ' WHERE lower(region) = lower(?)' : '';
  const regParams: SQLValue[] = region ? [region] : [];

  const rows = d.prepare(`
    SELECT COALESCE(region,'Unknown') AS region,
      COUNT(*) AS total,
      SUM(CASE WHEN joined=1 THEN 1 ELSE 0 END) AS joined,
      SUM(CASE WHEN allows_promo!='false' THEN 1 ELSE 0 END) AS promoOk,
      SUM(CASE WHEN allows_promo='false' THEN 1 ELSE 0 END) AS promoNo,
      SUM(CASE WHEN pending_since IS NOT NULL THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN cooldown_until IS NOT NULL AND cooldown_until > ? THEN 1 ELSE 0 END) AS cooldown
    FROM fb_groups${regWhere}
    GROUP BY COALESCE(region,'Unknown')
    ORDER BY total DESC
  `).all(now, ...regParams) as Array<Record<string, unknown>>;

  const byRegion: Record<string, { total: number; joined: number; promoOk: number; promoNo: number; pending: number; cooldown: number }> = {};
  for (const r of rows) {
    byRegion[r.region as string] = {
      total: Number(r.total), joined: Number(r.joined), promoOk: Number(r.promoOk),
      promoNo: Number(r.promoNo), pending: Number(r.pending), cooldown: Number(r.cooldown),
    };
  }

  const tot = d.prepare(`SELECT COUNT(*) AS groups, SUM(CASE WHEN joined=1 THEN 1 ELSE 0 END) AS joined, SUM(CASE WHEN pending_since IS NOT NULL THEN 1 ELSE 0 END) AS pending FROM fb_groups`).get() as Record<string, unknown> | undefined;
  const logCount = d.prepare(`SELECT COUNT(*) AS c FROM fb_post_log`).get() as Record<string, unknown> | undefined;
  const offers = d.prepare(`SELECT offer_slug, MAX(posted_at) AS last FROM fb_post_log GROUP BY offer_slug ORDER BY last DESC LIMIT 25`).all() as Array<{ offer_slug: string; last: string }>;
  const lastPostedPerOffer: Record<string, string> = {};
  for (const o of offers) lastPostedPerOffer[o.offer_slug] = o.last;

  return {
    byRegion,
    totals: {
      groups: Number(tot?.groups ?? 0), joined: Number(tot?.joined ?? 0),
      pending: Number(tot?.pending ?? 0), logRows: Number(logCount?.c ?? 0),
    },
    lastPostedPerOffer,
  };
}

/**
 * One-shot directory cleanup / re-categorization. Re-derives region/lang/currency/country for
 * EVERY group from all available signals (group name + stored fields + the dominant currency seen
 * in fb_post_log), and backfills allows_promo from history: a confirmed visible-post proves promo
 * is allowed. Fixes the Unknown-region tail and the Spanish-as-EUR mis-bucket. Idempotent — safe to
 * re-run. Returns before/after counters for verification.
 */
export function recategorizeFbGroups(): {
  scanned: number; regionChanged: number; currencyChanged: number; promoSet: number;
  stillUnknown: number; byRegion: Record<string, number>;
} {
  const d = getDb();
  const now = new Date().toISOString();
  const rows = d.prepare(`SELECT url, name, region, lang, currency, allows_promo FROM fb_groups`).all() as Array<Record<string, unknown>>;

  // Dominant non-empty currency + any-visible-post flag per group, from the durable post log.
  const sigRows = d.prepare(`
    SELECT p.group_url AS url,
      (SELECT p2.currency FROM fb_post_log p2
         WHERE p2.group_url = p.group_url AND p2.currency IS NOT NULL AND p2.currency != ''
         GROUP BY p2.currency ORDER BY COUNT(*) DESC, MAX(p2.posted_at) DESC LIMIT 1) AS topCurrency,
      MAX(CASE WHEN p.status = 'visible-post' THEN 1 ELSE 0 END) AS hadVisible
    FROM fb_post_log p GROUP BY p.group_url
  `).all() as Array<Record<string, unknown>>;
  const sig = new Map<string, { topCurrency: string | null; hadVisible: boolean }>();
  for (const s of sigRows) sig.set(s.url as string, { topCurrency: (s.topCurrency as string) || null, hadVisible: Number(s.hadVisible) === 1 });

  const upd = d.prepare(
    `UPDATE fb_groups SET region = ?, lang = COALESCE(?, lang), currency = COALESCE(?, currency), ` +
    `country = COALESCE(?, country), allows_promo = ?, updated_at = ? WHERE url = ?`
  );
  let regionChanged = 0, currencyChanged = 0, promoSet = 0, stillUnknown = 0;
  const byRegion: Record<string, number> = {};

  d.exec('BEGIN');
  try {
    for (const r of rows) {
      const url = r.url as string;
      const s = sig.get(url);
      const resolved = resolveClassification({
        name: (r.name as string) || '',
        url,
        region: (r.region as string) || null,
        lang: (r.lang as string) || null,
        currency: ((r.currency as string) || s?.topCurrency) || null,
      });
      const priorPromo = (r.allows_promo as string) || 'unknown';
      // A confirmed visible-post proves promo is allowed; an explicit 'false' exclude stays sticky.
      const promo = priorPromo === 'false' ? 'false' : (s?.hadVisible ? 'true' : priorPromo);

      if (resolved.region !== ((r.region as string) || 'Unknown')) regionChanged++;
      if (resolved.currency && resolved.currency !== ((r.currency as string) || null)) currencyChanged++;
      if (promo !== priorPromo) promoSet++;
      if (resolved.region === 'Unknown') stillUnknown++;
      byRegion[resolved.region] = (byRegion[resolved.region] || 0) + 1;

      upd.run(resolved.region, resolved.lang, resolved.currency, resolved.country, promo, now, url);
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
  return { scanned: rows.length, regionChanged, currencyChanged, promoSet, stillUnknown, byRegion };
}

// --- Helpers ---

function parseJsonOrDefault<T>(value: unknown, defaultValue: T): T {
  if (value == null || value === '') return defaultValue;
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return defaultValue; }
  }
  return value as T;
}

function rowToPayload(row: Record<string, unknown>): MemoryPayload {
  return {
    content: row.content as string,
    category: row.category as string,
    subcategory: row.subcategory as string | undefined,
    project: row.project as string,
    tags: parseJsonOrDefault<string[]>(row.tags, []),
    importance: (row.importance as number) ?? 5,
    source: (row.source as MemoryPayload['source']) || 'self-discovered',
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    accessed_at: row.accessed_at as string,
    access_count: (row.access_count as number) ?? 0,
    related_files: parseJsonOrDefault<string[] | undefined>(row.related_files, undefined),
    related_memory_ids: parseJsonOrDefault<string[] | undefined>(row.related_memory_ids, undefined),
    file_checksums: parseJsonOrDefault<Record<string, string> | undefined>(row.file_checksums, undefined),
    trashed_at: row.trashed_at as string | null | undefined,
    source_session_chunks: parseJsonOrDefault(row.source_session_chunks, undefined),
  };
}

function rowToSessionChunkPayload(row: Record<string, unknown>): SessionChunkPayload {
  return {
    content: row.content as string,
    summary: (row.summary as string) || '',
    session_id: (row.session_id as string) || '',
    project: (row.project as string) || '',
    git_branch: row.git_branch as string | null,
    cwd: row.cwd as string | null,
    chunk_index: (row.chunk_index as number) ?? 0,
    start_timestamp: (row.start_timestamp as string) || '',
    end_timestamp: (row.end_timestamp as string) || '',
    tools_used: parseJsonOrDefault<string[]>(row.tools_used, []),
    files_modified: parseJsonOrDefault<string[]>(row.files_modified, []),
    files_read: parseJsonOrDefault<string[]>(row.files_read, []),
    user_messages: parseJsonOrDefault<string[]>(row.user_messages, []),
    turn_count: (row.turn_count as number) ?? 0,
    related_memory_ids: parseJsonOrDefault<string[]>(row.related_memory_ids, []),
    dedup_memory_id: row.dedup_memory_id as string | null,
    indexed_at: (row.indexed_at as string) || '',
  };
}

/**
 * Close the database connection. Call on process exit.
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
  memoryVectors.invalidate();
  chunkVectors.invalidate();
}

/**
 * Reopen the database at the current SQLITE_DB_PATH.
 * Call after updating process.env.SQLITE_DB_PATH to switch databases.
 */
export async function reopenDatabase(): Promise<void> {
  closeDatabase();
  await ensureDatabase();
}
