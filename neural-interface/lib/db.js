/**
 * Shared SQLite database layer for the Neural Interface.
 * Uses node:sqlite (built-in since Node 22.5.0).
 * Shares the same memory.db file as the MCP server (WAL mode for concurrent access).
 */

import { DatabaseSync } from 'node:sqlite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MCP_DATA_DIR = resolve(__dirname, '..', '..', 'mcp-server', 'data');
const DEFAULT_DB_PATH = resolve(MCP_DATA_DIR, 'memory.db');

let db = null;

// --- Embedding ---

let embeddingPipeline = null;
let embeddingInitPromise = null;
export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIMS = 384;

async function getEmbeddingPipeline() {
  if (embeddingPipeline) return embeddingPipeline;
  if (embeddingInitPromise) return embeddingInitPromise;

  embeddingInitPromise = (async () => {
    const { pipeline } = await import('@huggingface/transformers');
    embeddingPipeline = await pipeline('feature-extraction', EMBEDDING_MODEL, {
      dtype: 'fp32',
    });
    return embeddingPipeline;
  })();

  try {
    return await embeddingInitPromise;
  } finally {
    embeddingInitPromise = null;
  }
}

export async function getEmbedding(text) {
  const ext = await getEmbeddingPipeline();
  const output = await ext(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

export async function getEmbeddingBatch(texts) {
  if (texts.length === 0) return [];
  if (texts.length === 1) return [await getEmbedding(texts[0])];

  const ext = await getEmbeddingPipeline();
  const results = [];
  for (const text of texts) {
    const output = await ext(text, { pooling: 'mean', normalize: true });
    results.push(Array.from(output.data));
  }
  return results;
}

export async function warmupEmbeddings() {
  await getEmbeddingPipeline();
}

export function getEmbeddingDims() {
  return EMBEDDING_DIMS;
}

// --- Database ---

export function getDbPath() {
  return process.env.SQLITE_DB_PATH || DEFAULT_DB_PATH;
}

export function getDb() {
  if (!db) {
    const dbPath = getDbPath();
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');

    // Ensure schema exists (same tables as MCP server)
    db.exec(SCHEMA_SQL);
    try { db.exec(FTS_SQL); } catch { /* FTS5 may already exist */ }
  }
  return db;
}

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

const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content, category, project, tags,
  content=memories, content_rowid=rowid,
  tokenize='porter unicode61'
);
`;

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

// --- KV Config ---

const KV_DDL = 'CREATE TABLE IF NOT EXISTS kv_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)';

export function getKvConfig(key) {
  const d = getDb();
  d.exec(KV_DDL);
  const row = d.prepare('SELECT value FROM kv_config WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setKvConfig(key, value) {
  const d = getDb();
  d.exec(KV_DDL);
  d.prepare('INSERT OR REPLACE INTO kv_config (key, value) VALUES (?, ?)').run(key, String(value));
}

// --- Vector helpers ---

export function encodeVector(vector) {
  return new Uint8Array(new Float32Array(vector).buffer);
}

export function decodeVector(blob) {
  return Array.from(new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4));
}

export function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

// --- Memory queries ---

/**
 * Search memories by vector similarity.
 * Optionally filter by category/project/tags. Excludes trashed and system_metadata.
 */
export function searchMemories(vector, limit = 10, { category, project, tags, minImportance, scoreThreshold = 0.3, includeTrash = false } = {}) {
  const d = getDb();
  const clauses = [];
  const params = [];

  if (!includeTrash) {
    clauses.push('trashed_at IS NULL');
  }

  if (category) {
    clauses.push('category = ?');
    params.push(category);
  }
  if (project) {
    clauses.push('project = ?');
    params.push(project);
  }
  if (tags && tags.length > 0) {
    for (const tag of tags) {
      clauses.push(`EXISTS (SELECT 1 FROM json_each(tags) WHERE json_each.value = ?)`);
      params.push(tag);
    }
  }
  if (minImportance) {
    clauses.push('importance >= ?');
    params.push(minImportance);
  }

  const where = clauses.length > 0 ? 'WHERE ' + clauses.join(' AND ') : '';

  const rows = d.prepare(`
    SELECT id, vector, content, category, subcategory, project, tags, importance, source,
           created_at, updated_at, accessed_at, access_count, related_files,
           related_memory_ids, file_checksums, trashed_at, source_session_chunks
    FROM memories ${where}
  `).all(...params);

  const scored = rows.map(row => {
    const rowVec = decodeVector(row.vector);
    const score = cosineSimilarity(vector, rowVec);
    return { ...rowToPayload(row), id: row.id, score, vector: rowVec };
  }).filter(r => r.score >= scoreThreshold);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Get all memories (for graph view, links computation, etc.)
 */
export function getAllMemories({ includeVectors = false, includeTrash = false } = {}) {
  const d = getDb();
  const vectorCol = includeVectors ? ', vector' : '';
  const where = includeTrash ? '' : 'WHERE trashed_at IS NULL';

  const rows = d.prepare(`
    SELECT id, content, category, subcategory, project, tags, importance, source,
           created_at, updated_at, accessed_at, access_count, related_files,
           related_memory_ids, file_checksums, trashed_at, source_session_chunks
           ${vectorCol}
    FROM memories ${where}
    ORDER BY created_at DESC
  `).all();

  return rows.map(row => {
    const payload = rowToPayload(row);
    const result = { id: row.id, ...payload };
    if (includeVectors && row.vector) {
      result.vector = decodeVector(row.vector);
    }
    return result;
  });
}

/**
 * Get all memories with vectors for link computation.
 */
export function getAllMemoriesWithVectors() {
  const d = getDb();
  const rows = d.prepare(`
    SELECT id, vector, content, category, subcategory, project, tags, importance, source,
           created_at, updated_at, accessed_at, access_count, related_files,
           related_memory_ids, file_checksums, trashed_at, source_session_chunks
    FROM memories WHERE trashed_at IS NULL
  `).all();

  return rows.map(row => ({
    id: row.id,
    vector: decodeVector(row.vector),
    ...rowToPayload(row),
  }));
}

export function getMemoryById(id) {
  const d = getDb();
  const row = d.prepare(`
    SELECT id, content, category, subcategory, project, tags, importance, source,
           created_at, updated_at, accessed_at, access_count, related_files,
           related_memory_ids, file_checksums, trashed_at, source_session_chunks
    FROM memories WHERE id = ?
  `).get(id);

  if (!row) return null;
  return { id: row.id, ...rowToPayload(row) };
}

export function getMemoryWithVector(id) {
  const d = getDb();
  const row = d.prepare(`
    SELECT id, vector, content, category, subcategory, project, tags, importance, source,
           created_at, updated_at, accessed_at, access_count, related_files,
           related_memory_ids, file_checksums, trashed_at, source_session_chunks
    FROM memories WHERE id = ?
  `).get(id);

  if (!row) return null;
  return { id: row.id, vector: decodeVector(row.vector), ...rowToPayload(row) };
}

export function updateMemoryPayload(id, updates) {
  const d = getDb();
  const sets = [];
  const params = [];

  for (const [key, value] of Object.entries(updates)) {
    if (key === 'id' || key === 'vector') continue;
    if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
      sets.push(`${key} = ?`);
      params.push(JSON.stringify(value));
    } else {
      sets.push(`${key} = ?`);
      params.push(value ?? null);
    }
  }

  if (sets.length === 0) return;
  params.push(id);
  d.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function softDeleteMemory(id) {
  const d = getDb();
  d.prepare('UPDATE memories SET trashed_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

export function hardDeleteMemory(id) {
  const d = getDb();
  d.prepare('DELETE FROM memories WHERE id = ?').run(id);
}

export function restoreMemory(id) {
  const d = getDb();
  d.prepare('UPDATE memories SET trashed_at = NULL WHERE id = ?').run(id);
}

export function getTrashedMemories() {
  const d = getDb();
  const rows = d.prepare(`
    SELECT id, content, category, subcategory, project, tags, importance, source,
           created_at, updated_at, accessed_at, access_count, related_files,
           related_memory_ids, file_checksums, trashed_at, source_session_chunks
    FROM memories WHERE trashed_at IS NOT NULL
    ORDER BY trashed_at DESC
  `).all();

  return rows.map(row => ({ id: row.id, ...rowToPayload(row) }));
}

export function purgeTrash() {
  const d = getDb();
  const rows = d.prepare('SELECT id FROM memories WHERE trashed_at IS NOT NULL').all();
  d.prepare('DELETE FROM memories WHERE trashed_at IS NOT NULL').run();
  return rows.map(r => r.id);
}

export function countMemories(filter = {}) {
  const d = getDb();
  const clauses = ['trashed_at IS NULL'];
  const params = [];

  if (filter.category) {
    clauses.push('category = ?');
    params.push(filter.category);
  }
  if (filter.project) {
    clauses.push('project = ?');
    params.push(filter.project);
  }

  const result = d.prepare(`SELECT COUNT(*) as cnt FROM memories WHERE ${clauses.join(' AND ')}`).get(...params);
  return result.cnt;
}

export function getMemoryStats() {
  const d = getDb();

  const total = d.prepare('SELECT COUNT(*) as cnt FROM memories WHERE trashed_at IS NULL').get().cnt;
  const trashedCount = d.prepare('SELECT COUNT(*) as cnt FROM memories WHERE trashed_at IS NOT NULL').get().cnt;

  const catRows = d.prepare('SELECT category, COUNT(*) as cnt FROM memories WHERE trashed_at IS NULL GROUP BY category').all();
  const by_category = {};
  for (const row of catRows) by_category[row.category] = row.cnt;

  const projRows = d.prepare('SELECT project, COUNT(*) as cnt FROM memories WHERE trashed_at IS NULL GROUP BY project').all();
  const by_project = {};
  for (const row of projRows) by_project[row.project || 'global'] = row.cnt;

  const dateRow = d.prepare('SELECT MIN(created_at) as oldest, MAX(created_at) as newest FROM memories WHERE trashed_at IS NULL').get();

  return {
    total,
    trashedCount,
    by_category,
    by_project,
    oldest: dateRow.oldest,
    newest: dateRow.newest,
  };
}

/**
 * Get memories by category for export.
 */
export function getMemoriesByCategory(category) {
  const d = getDb();
  const rows = d.prepare(`
    SELECT id, content, category, subcategory, project, tags, importance, source,
           created_at, updated_at, accessed_at, access_count, related_files,
           related_memory_ids, file_checksums, trashed_at, source_session_chunks
    FROM memories WHERE category = ? AND trashed_at IS NULL
    ORDER BY created_at DESC
  `).all(category);

  return rows.map(row => ({ id: row.id, ...rowToPayload(row) }));
}

/**
 * Batch update category for memories.
 */
export function updateMemoriesCategory(ids, newCategory) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const stmt = d.prepare('UPDATE memories SET category = ? WHERE id = ?');
    for (const id of ids) {
      stmt.run(newCategory, id);
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

// --- Categories ---

export function getCategories() {
  const d = getDb();
  return d.prepare('SELECT name, description, created_at, parent, color, is_parent FROM categories ORDER BY name').all();
}

export function saveCategories(categories) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const existing = new Set(d.prepare('SELECT name FROM categories').all().map(r => r.name));
    const incoming = new Set(categories.map(c => c.name));

    for (const name of existing) {
      if (!incoming.has(name)) {
        d.prepare('DELETE FROM categories WHERE name = ?').run(name);
      }
    }

    const stmt = d.prepare('INSERT OR REPLACE INTO categories (name, description, created_at, parent, color, is_parent) VALUES (?, ?, ?, ?, ?, ?)');
    for (const cat of categories) {
      stmt.run(cat.name, cat.description, cat.created_at, cat.parent || null, cat.color || null, cat.is_parent ? 1 : 0);
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

// --- Session Chunks ---

export function countSessionChunks() {
  const d = getDb();
  return d.prepare('SELECT COUNT(*) as cnt FROM session_chunks').get().cnt;
}

export function searchSessionChunks(vector, limit = 10, { project, scoreThreshold = 0.3 } = {}) {
  const d = getDb();
  const clauses = [];
  const params = [];

  if (project) {
    clauses.push('project = ?');
    params.push(project);
  }

  const where = clauses.length > 0 ? 'WHERE ' + clauses.join(' AND ') : '';

  const rows = d.prepare(`
    SELECT id, vector, content, summary, session_id, project, git_branch, cwd,
           chunk_index, start_timestamp, end_timestamp, tools_used, files_modified,
           files_read, user_messages, turn_count, related_memory_ids, dedup_memory_id, indexed_at
    FROM session_chunks ${where}
  `).all(...params);

  const scored = rows.map(row => {
    const rowVec = decodeVector(row.vector);
    const score = cosineSimilarity(vector, rowVec);
    return { id: row.id, score, payload: rowToSessionPayload(row) };
  }).filter(r => r.score >= scoreThreshold);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// --- Row conversion helpers ---

function parseJson(val, fallback) {
  if (val == null || val === '') return fallback;
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return fallback; }
  }
  return val;
}

function rowToPayload(row) {
  return {
    content: row.content,
    category: row.category,
    subcategory: row.subcategory || undefined,
    project: row.project,
    tags: parseJson(row.tags, []),
    importance: row.importance ?? 5,
    source: row.source || 'self-discovered',
    created_at: row.created_at,
    updated_at: row.updated_at,
    accessed_at: row.accessed_at,
    access_count: row.access_count ?? 0,
    related_files: parseJson(row.related_files, undefined),
    related_memory_ids: parseJson(row.related_memory_ids, undefined),
    file_checksums: parseJson(row.file_checksums, undefined),
    trashed_at: row.trashed_at || null,
    source_session_chunks: parseJson(row.source_session_chunks, undefined),
  };
}

function rowToSessionPayload(row) {
  return {
    content: row.content,
    summary: row.summary || '',
    session_id: row.session_id || '',
    project: row.project || '',
    git_branch: row.git_branch || null,
    cwd: row.cwd || null,
    chunk_index: row.chunk_index ?? 0,
    start_timestamp: row.start_timestamp || '',
    end_timestamp: row.end_timestamp || '',
    tools_used: parseJson(row.tools_used, []),
    files_modified: parseJson(row.files_modified, []),
    files_read: parseJson(row.files_read, []),
    user_messages: parseJson(row.user_messages, []),
    turn_count: row.turn_count ?? 0,
    related_memory_ids: parseJson(row.related_memory_ids, []),
    dedup_memory_id: row.dedup_memory_id || null,
    indexed_at: row.indexed_at || '',
  };
}
