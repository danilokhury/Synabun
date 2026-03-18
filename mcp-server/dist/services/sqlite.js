/**
 * SQLite storage layer.
 * Uses Node.js built-in node:sqlite (available since Node 22.5.0).
 * Vectors stored as Float32Array BLOBs, cosine similarity computed in JS.
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { config } from '../config.js';
import { getAllCategories } from './categories.js';
// Re-export for backward compat (was used by categories.ts)
export const CATEGORIES_POINT_ID = '00000000-0000-0000-0000-000000000000';
let db = null;
function getDbPath() {
    const envPath = process.env.SQLITE_DB_PATH;
    const defaultPath = path.join(config.dataDir, 'memory.db');
    if (!envPath)
        return defaultPath;
    // If the env path's parent directory doesn't exist (e.g. Windows path on Mac),
    // fall back to the local default so cross-OS restores work instantly
    if (!fs.existsSync(path.dirname(envPath)))
        return defaultPath;
    return envPath;
}
function getDb() {
    if (!db) {
        db = new DatabaseSync(getDbPath());
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA foreign_keys = ON');
        db.exec('PRAGMA busy_timeout = 5000');
    }
    return db;
}
// --- Vector encoding/decoding ---
function encodeVector(vector) {
    const f32 = new Float32Array(vector);
    return new Uint8Array(f32.buffer);
}
function decodeVector(blob) {
    const f32 = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
    return Array.from(f32);
}
/**
 * Cosine similarity for normalized vectors (equals dot product).
 * Vectors from Transformers.js with normalize:true are unit-length.
 */
function cosineSimilarity(a, b) {
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
    }
    return dot;
}
/**
 * Translates JSON filters to SQL WHERE clauses.
 * Supports: exact match, range, tags (JSON array contains), is_empty.
 */
function translateFilter(filter) {
    if (!filter)
        return { where: '', params: [] };
    const f = filter;
    const clauses = [];
    const params = [];
    for (const cond of f.must || []) {
        if (cond.match) {
            if (cond.key === 'tags') {
                clauses.push(`EXISTS (SELECT 1 FROM json_each(tags) WHERE json_each.value = ?)`);
                params.push(cond.match.value);
            }
            else {
                clauses.push(`${sanitizeColumn(cond.key)} = ?`);
                params.push(cond.match.value);
            }
        }
        else if (cond.range) {
            const col = sanitizeColumn(cond.key);
            if (cond.range.gte !== undefined) {
                clauses.push(`${col} >= ?`);
                params.push(cond.range.gte);
            }
            if (cond.range.lte !== undefined) {
                clauses.push(`${col} <= ?`);
                params.push(cond.range.lte);
            }
            if (cond.range.gt !== undefined) {
                clauses.push(`${col} > ?`);
                params.push(cond.range.gt);
            }
            if (cond.range.lt !== undefined) {
                clauses.push(`${col} < ?`);
                params.push(cond.range.lt);
            }
        }
        else if (cond.is_empty) {
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
function sanitizeColumn(name) {
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
export async function ensureCollection() {
    const d = getDb();
    d.exec(SCHEMA_SQL);
    try {
        d.exec(FTS_SQL);
    }
    catch {
        // FTS5 may already exist or not be available
    }
}
export async function ensureSessionCollection() {
    // No-op: session_chunks table is created in ensureCollection()
}
/** Combined init function for cleaner startup */
export async function ensureDatabase() {
    await ensureCollection();
}
// --- Public API: Memory operations ---
export async function upsertMemory(id, vector, payload) {
    const d = getDb();
    const stmt = d.prepare(`
    INSERT OR REPLACE INTO memories
      (id, vector, content, category, subcategory, project, tags, importance, source,
       created_at, updated_at, accessed_at, access_count, related_files,
       related_memory_ids, file_checksums, trashed_at, source_session_chunks)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    stmt.run(id, encodeVector(vector), payload.content, payload.category, payload.subcategory ?? null, payload.project, JSON.stringify(payload.tags || []), payload.importance ?? 5, payload.source || 'self-discovered', payload.created_at, payload.updated_at, payload.accessed_at, payload.access_count ?? 0, payload.related_files ? JSON.stringify(payload.related_files) : null, payload.related_memory_ids ? JSON.stringify(payload.related_memory_ids) : null, payload.file_checksums ? JSON.stringify(payload.file_checksums) : null, payload.trashed_at ?? null, payload.source_session_chunks ? JSON.stringify(payload.source_session_chunks) : null);
    // Update FTS index
    try {
        d.prepare(`INSERT OR REPLACE INTO memories_fts(rowid, content, category, project, tags)
      SELECT rowid, content, category, project, tags FROM memories WHERE id = ?`).run(id);
    }
    catch {
        // FTS update failure is non-fatal
    }
}
export async function searchMemories(vector, limit, filter, scoreThreshold) {
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
  `).all(...params);
    // Compute cosine similarity and rank
    const scored = rows.map((row) => {
        const rowVector = decodeVector(row.vector);
        const score = cosineSimilarity(vector, rowVector);
        return { row, score };
    }).filter((r) => r.score >= threshold);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((r) => ({
        id: r.row.id,
        score: r.score,
        payload: rowToPayload(r.row),
    }));
}
export async function getMemory(id) {
    const d = getDb();
    const row = d.prepare(`
    SELECT id, content, category, subcategory, project, tags, importance, source,
           created_at, updated_at, accessed_at, access_count, related_files,
           related_memory_ids, file_checksums, trashed_at, source_session_chunks
    FROM memories WHERE id = ?
  `).get(id);
    if (!row)
        return null;
    return { id: row.id, payload: rowToPayload(row) };
}
export async function updatePayload(id, payload) {
    const d = getDb();
    const sets = [];
    const params = [];
    for (const [key, value] of Object.entries(payload)) {
        if (key === 'id' || key === 'vector')
            continue;
        const col = sanitizeColumn(key);
        if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
            sets.push(`${col} = ?`);
            params.push(JSON.stringify(value));
        }
        else {
            sets.push(`${col} = ?`);
            params.push((value ?? null));
        }
    }
    if (sets.length === 0)
        return;
    params.push(id);
    d.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    // Update FTS if content changed
    if (payload.content) {
        try {
            d.prepare(`INSERT OR REPLACE INTO memories_fts(rowid, content, category, project, tags)
        SELECT rowid, content, category, project, tags FROM memories WHERE id = ?`).run(id);
        }
        catch { /* non-fatal */ }
    }
}
export async function updateVector(id, vector, payload) {
    // Full upsert — replaces both vector and payload
    await upsertMemory(id, vector, payload);
}
export async function updatePayloadByFilter(filter, payload) {
    const d = getDb();
    const { where, params: filterParams } = translateFilter(filter);
    const sets = [];
    const setParams = [];
    for (const [key, value] of Object.entries(payload)) {
        if (key === 'id' || key === 'vector')
            continue;
        const col = sanitizeColumn(key);
        if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
            sets.push(`${col} = ?`);
            setParams.push(JSON.stringify(value));
        }
        else {
            sets.push(`${col} = ?`);
            setParams.push((value ?? null));
        }
    }
    if (sets.length === 0)
        return;
    d.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE trashed_at IS NULL${where}`)
        .run(...setParams, ...filterParams);
}
export async function deleteMemory(id) {
    const d = getDb();
    d.prepare('DELETE FROM memories WHERE id = ?').run(id);
    try {
        d.prepare('DELETE FROM memories_fts WHERE rowid = (SELECT rowid FROM memories WHERE id = ?)').run(id);
    }
    catch { /* non-fatal */ }
}
export async function softDeleteMemory(id) {
    await updatePayload(id, { trashed_at: new Date().toISOString() });
}
export async function restoreMemory(id) {
    const d = getDb();
    d.prepare('UPDATE memories SET trashed_at = NULL WHERE id = ?').run(id);
}
export async function scrollMemories(filter, limit = 20, offset) {
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
  `).all(...params, limit, numericOffset);
    const points = rows.map((row) => ({
        id: row.id,
        payload: rowToPayload(row),
    }));
    // Determine next offset
    const nextOffset = rows.length === limit ? String(numericOffset + limit) : null;
    return { points, next_page_offset: nextOffset };
}
export async function countMemories(filter) {
    const d = getDb();
    const { where, params } = translateFilter(filter);
    const result = d.prepare(`
    SELECT COUNT(*) as cnt FROM memories WHERE trashed_at IS NULL${where}
  `).get(...params);
    return result.cnt;
}
export async function getMemoryStats() {
    const d = getDb();
    const totalRow = d.prepare('SELECT COUNT(*) as cnt FROM memories WHERE trashed_at IS NULL').get();
    const total = totalRow.cnt;
    // Per-category counts using SQL aggregate
    const catRows = d.prepare(`
    SELECT category, COUNT(*) as cnt FROM memories WHERE trashed_at IS NULL GROUP BY category
  `).all();
    const by_category = {};
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
  `).all();
    const by_project = {};
    for (const row of projRows) {
        by_project[row.project || 'global'] = row.cnt;
    }
    // Oldest/newest
    const dateRow = d.prepare(`
    SELECT MIN(created_at) as oldest, MAX(created_at) as newest FROM memories WHERE trashed_at IS NULL
  `).get();
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
export async function searchMemoriesFTS(query, limit, filter, excludeIds) {
    const d = getDb();
    // Sanitize query for FTS5: escape double quotes, wrap terms
    const ftsQuery = query
        .replace(/"/g, '""')
        .split(/\s+/)
        .filter(t => t.length > 1)
        .map(t => `"${t}"`)
        .join(' OR ');
    if (!ftsQuery)
        return [];
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
    `).all(ftsQuery, ...params, limit);
        return rows
            .filter(row => !excludeIds || !excludeIds.has(row.id))
            .map(row => {
            // FTS5 rank is negative (lower = better match). Normalize to 0-1 range.
            const rawRank = Math.abs(row.rank);
            const normalizedScore = Math.min(1, rawRank / 10);
            return {
                id: row.id,
                score: normalizedScore,
                payload: rowToPayload(row),
            };
        });
    }
    catch {
        // FTS5 not available or query error — return empty
        return [];
    }
}
// --- Session Chunks ---
export async function searchSessionChunks(vector, limit, filter, scoreThreshold = 0.3) {
    const d = getDb();
    const { where, params } = translateFilter(filter);
    const rows = d.prepare(`
    SELECT id, vector, content, summary, session_id, project, git_branch, cwd,
           chunk_index, start_timestamp, end_timestamp, tools_used, files_modified,
           files_read, user_messages, turn_count, related_memory_ids, dedup_memory_id, indexed_at
    FROM session_chunks
    WHERE 1=1${where}
  `).all(...params);
    const scored = rows.map((row) => {
        const rowVector = decodeVector(row.vector);
        const score = cosineSimilarity(vector, rowVector);
        return { row, score };
    }).filter((r) => r.score >= scoreThreshold);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((r) => ({
        id: r.row.id,
        score: r.score,
        payload: rowToSessionChunkPayload(r.row),
    }));
}
export async function upsertSessionChunks(points) {
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
            stmt.run(p.id, encodeVector(p.vector), p.payload.content, p.payload.summary || null, p.payload.session_id || null, p.payload.project || null, p.payload.git_branch ?? null, p.payload.cwd ?? null, p.payload.chunk_index ?? 0, p.payload.start_timestamp || null, p.payload.end_timestamp || null, JSON.stringify(p.payload.tools_used || []), JSON.stringify(p.payload.files_modified || []), JSON.stringify(p.payload.files_read || []), JSON.stringify(p.payload.user_messages || []), p.payload.turn_count ?? 0, JSON.stringify(p.payload.related_memory_ids || []), p.payload.dedup_memory_id ?? null, p.payload.indexed_at || new Date().toISOString());
        }
        d.exec('COMMIT');
    }
    catch (err) {
        d.exec('ROLLBACK');
        throw err;
    }
}
export async function scrollSessionChunks(filter, limit = 20, offset) {
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
  `).all(...params, limit, numericOffset);
    const points = rows.map((row) => ({
        id: row.id,
        payload: rowToSessionChunkPayload(row),
    }));
    const nextOffset = rows.length === limit ? String(numericOffset + limit) : null;
    return { points, next_page_offset: nextOffset };
}
export async function countSessionChunks(filter) {
    const d = getDb();
    const { where, params } = translateFilter(filter);
    const result = d.prepare(`SELECT COUNT(*) as cnt FROM session_chunks WHERE 1=1${where}`)
        .get(...params);
    return result.cnt;
}
export async function getCategories() {
    try {
        const d = getDb();
        const rows = d.prepare('SELECT name, description, created_at, parent, color, is_parent FROM categories ORDER BY name')
            .all();
        if (rows.length === 0)
            return null;
        return rows.map((row) => ({
            name: row.name,
            description: row.description,
            created_at: row.created_at,
            parent: row.parent,
            color: row.color,
            is_parent: row.is_parent === 1 ? true : undefined,
        }));
    }
    catch {
        return null;
    }
}
export async function saveCategories(categories) {
    const d = getDb();
    const insertStmt = d.prepare(`
    INSERT OR REPLACE INTO categories (name, description, created_at, parent, color, is_parent)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
    // Manual transaction
    d.exec('BEGIN');
    try {
        // Get existing names to detect deletions
        const existing = new Set(d.prepare('SELECT name FROM categories').all().map((r) => r.name));
        const incoming = new Set(categories.map((c) => c.name));
        // Delete removed categories
        for (const name of existing) {
            if (!incoming.has(name)) {
                d.prepare('DELETE FROM categories WHERE name = ?').run(name);
            }
        }
        // Upsert all incoming
        for (const cat of categories) {
            insertStmt.run(cat.name, cat.description, cat.created_at, cat.parent ?? null, cat.color ?? null, cat.is_parent ? 1 : 0);
        }
        d.exec('COMMIT');
    }
    catch (err) {
        d.exec('ROLLBACK');
        throw err;
    }
}
// --- Helpers ---
function parseJsonOrDefault(value, defaultValue) {
    if (value == null || value === '')
        return defaultValue;
    if (typeof value === 'string') {
        try {
            return JSON.parse(value);
        }
        catch {
            return defaultValue;
        }
    }
    return value;
}
function rowToPayload(row) {
    return {
        content: row.content,
        category: row.category,
        subcategory: row.subcategory,
        project: row.project,
        tags: parseJsonOrDefault(row.tags, []),
        importance: row.importance ?? 5,
        source: row.source || 'self-discovered',
        created_at: row.created_at,
        updated_at: row.updated_at,
        accessed_at: row.accessed_at,
        access_count: row.access_count ?? 0,
        related_files: parseJsonOrDefault(row.related_files, undefined),
        related_memory_ids: parseJsonOrDefault(row.related_memory_ids, undefined),
        file_checksums: parseJsonOrDefault(row.file_checksums, undefined),
        trashed_at: row.trashed_at,
        source_session_chunks: parseJsonOrDefault(row.source_session_chunks, undefined),
    };
}
function rowToSessionChunkPayload(row) {
    return {
        content: row.content,
        summary: row.summary || '',
        session_id: row.session_id || '',
        project: row.project || '',
        git_branch: row.git_branch,
        cwd: row.cwd,
        chunk_index: row.chunk_index ?? 0,
        start_timestamp: row.start_timestamp || '',
        end_timestamp: row.end_timestamp || '',
        tools_used: parseJsonOrDefault(row.tools_used, []),
        files_modified: parseJsonOrDefault(row.files_modified, []),
        files_read: parseJsonOrDefault(row.files_read, []),
        user_messages: parseJsonOrDefault(row.user_messages, []),
        turn_count: row.turn_count ?? 0,
        related_memory_ids: parseJsonOrDefault(row.related_memory_ids, []),
        dedup_memory_id: row.dedup_memory_id,
        indexed_at: row.indexed_at || '',
    };
}
/**
 * Close the database connection. Call on process exit.
 */
export function closeDatabase() {
    if (db) {
        db.close();
        db = null;
    }
}
/**
 * Reopen the database at the current SQLITE_DB_PATH.
 * Call after updating process.env.SQLITE_DB_PATH to switch databases.
 */
export async function reopenDatabase() {
    closeDatabase();
    await ensureDatabase();
}
//# sourceMappingURL=sqlite.js.map