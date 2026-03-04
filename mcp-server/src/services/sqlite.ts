/**
 * SQLite storage layer.
 * Uses Node.js built-in node:sqlite (available since Node 22.5.0).
 * Vectors stored as Float32Array BLOBs, cosine similarity computed in JS.
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { config } from '../config.js';
import { getAllCategories } from './categories.js';
import type { MemoryPayload, MemoryStats, SessionChunkPayload } from '../types.js';

type SQLValue = null | number | bigint | string | Uint8Array;

// Re-export for backward compat (was used by categories.ts)
export const CATEGORIES_POINT_ID = '00000000-0000-0000-0000-000000000000';

let db: DatabaseSync | null = null;

function getDbPath(): string {
  return process.env.SQLITE_DB_PATH || path.join(config.dataDir, 'memory.db');
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

// --- Vector encoding/decoding ---

function encodeVector(vector: number[]): Uint8Array {
  const f32 = new Float32Array(vector);
  return new Uint8Array(f32.buffer);
}

function decodeVector(blob: Uint8Array): number[] {
  const f32 = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  return Array.from(f32);
}

/**
 * Cosine similarity for normalized vectors (equals dot product).
 * Vectors from Transformers.js with normalize:true are unit-length.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
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

// --- Public API: Collection initialization ---

export async function ensureCollection(): Promise<void> {
  const d = getDb();
  d.exec(SCHEMA_SQL);
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

  // Build WHERE clause from filter
  const { where, params } = translateFilter(filter);

  // Fetch all candidate rows (non-trashed) with their vectors
  const rows = d.prepare(`
    SELECT id, vector, content, category, subcategory, project, tags, importance, source,
           created_at, updated_at, accessed_at, access_count, related_files,
           related_memory_ids, file_checksums, trashed_at, source_session_chunks
    FROM memories
    WHERE trashed_at IS NULL${where}
  `).all(...params) as Array<Record<string, unknown>>;

  // Compute cosine similarity and rank
  const scored = rows.map((row) => {
    const rowVector = decodeVector(row.vector as Uint8Array);
    const score = cosineSimilarity(vector, rowVector);
    return { row, score };
  }).filter((r) => r.score >= threshold);

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((r) => ({
    id: r.row.id as string,
    score: r.score,
    payload: rowToPayload(r.row),
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
}

export async function deleteMemory(id: string): Promise<void> {
  const d = getDb();
  d.prepare('DELETE FROM memories WHERE id = ?').run(id);
  try {
    d.prepare('DELETE FROM memories_fts WHERE rowid = (SELECT rowid FROM memories WHERE id = ?)').run(id);
  } catch { /* non-fatal */ }
}

export async function softDeleteMemory(id: string): Promise<void> {
  await updatePayload(id, { trashed_at: new Date().toISOString() } as Partial<MemoryPayload>);
}

export async function restoreMemory(id: string): Promise<void> {
  const d = getDb();
  d.prepare('UPDATE memories SET trashed_at = NULL WHERE id = ?').run(id);
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

// --- Session Chunks ---

export async function searchSessionChunks(
  vector: number[],
  limit: number,
  filter?: Record<string, unknown>,
  scoreThreshold = 0.3
) {
  const d = getDb();
  const { where, params } = translateFilter(filter);

  const rows = d.prepare(`
    SELECT id, vector, content, summary, session_id, project, git_branch, cwd,
           chunk_index, start_timestamp, end_timestamp, tools_used, files_modified,
           files_read, user_messages, turn_count, related_memory_ids, dedup_memory_id, indexed_at
    FROM session_chunks
    WHERE 1=1${where}
  `).all(...params) as Array<Record<string, unknown>>;

  const scored = rows.map((row) => {
    const rowVector = decodeVector(row.vector as Uint8Array);
    const score = cosineSimilarity(vector, rowVector);
    return { row, score };
  }).filter((r) => r.score >= scoreThreshold);

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((r) => ({
    id: r.row.id as string,
    score: r.score,
    payload: rowToSessionChunkPayload(r.row),
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
}
