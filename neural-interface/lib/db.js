/**
 * Shared SQLite database layer for the Neural Interface.
 * Uses node:sqlite (built-in since Node 22.5.0).
 * Shares the same memory.db file as the MCP server (WAL mode for concurrent access).
 */

import { DatabaseSync } from 'node:sqlite';
import { resolve, dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { VectorCache } from './vector-cache.js';
import { getDataHome } from '../../lib/paths.js';

function getDefaultDbPath() {
  const dataDir = process.env.MEMORY_DATA_DIR || resolve(getDataHome(), 'mcp-data');
  return resolve(dataDir, 'memory.db');
}

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
      // Single-threaded ORT: run inference on the calling thread so onnxruntime-node
      // spawns NO intra/inter-op worker threads. Eliminates the macOS at-exit crash
      // (ThreadPoolTempl::WorkerLoop threads aborting in the static destructor —
      // `libc++abi: mutex lock failed`). MiniLM is tiny, so latency is unaffected.
      session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
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
  const envPath = process.env.SQLITE_DB_PATH;
  const defaultPath = getDefaultDbPath();
  if (!envPath) return defaultPath;
  // If the env path's parent directory doesn't exist (e.g. Windows path on Mac),
  // fall back to the local default so cross-OS restores work instantly
  if (!existsSync(dirname(envPath))) return defaultPath;
  return envPath;
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
    try { db.exec(SESSION_CACHE_SQL); } catch { /* session_cache migration */ }
    try {
      const sessionCacheColumns = new Set(
        db.prepare('PRAGMA table_info(session_cache)').all().map((column) => String(column?.name || '')),
      );
      if (!sessionCacheColumns.has('account_id')) db.exec('ALTER TABLE session_cache ADD COLUMN account_id TEXT');
    } catch { /* additive session_cache migration */ }
    try { db.exec(SESSION_FTS_SQL); } catch { /* FTS5 may already exist */ }
    try { db.exec(FB_SCHEMA_SQL); } catch { /* fb group directory — created by whichever process opens first */ }
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

const SESSION_CACHE_SQL = `
CREATE TABLE IF NOT EXISTS session_cache (
  session_id    TEXT NOT NULL,
  provider      TEXT NOT NULL,
  project       TEXT,
  project_path  TEXT,
  git_branch    TEXT,
  first_prompt  TEXT,
  message_count INTEGER DEFAULT 0,
  created       TEXT,
  modified      TEXT,
  file_path     TEXT,
  file_size     INTEGER,
  file_mtime    TEXT,
  body_size     INTEGER,
  deleted       INTEGER DEFAULT 0,
  account_id    TEXT,
  PRIMARY KEY (session_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_session_cache_provider_modified
  ON session_cache(provider, modified DESC);
CREATE INDEX IF NOT EXISTS idx_session_cache_project
  ON session_cache(project_path);
`;

// Facebook group directory — mirrors mcp-server/src/services/sqlite.ts FB_SCHEMA_SQL so the
// Neural Interface can read/render the directory. CREATE IF NOT EXISTS = whichever process
// opens memory.db first creates the tables; the other is a no-op.
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

const SESSION_FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
  session_id UNINDEXED,
  provider   UNINDEXED,
  project    UNINDEXED,
  first_prompt,
  body,
  tokenize = 'porter unicode61 remove_diacritics 2'
);
`;

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
  memoryVectors.invalidate();
  chunkVectors.invalidate();
}

// --- In-memory vector caches (see vector-cache.js for coherence model) ---
// Exported so same-connection writers (session-indexer, server.js bridge
// import) can patch the cache — same-connection writes do NOT bump
// PRAGMA data_version, so they must update the cache explicitly.

export const memoryVectors = new VectorCache(
  getDb,
  'SELECT id, vector FROM memories WHERE trashed_at IS NULL',
  'SELECT vector FROM memories WHERE id = ? AND trashed_at IS NULL',
);

export const chunkVectors = new VectorCache(
  getDb,
  'SELECT id, vector FROM session_chunks',
  'SELECT vector FROM session_chunks WHERE id = ?',
);

// --- X/Twitter engagement ledger (cross-schedule dedup) ---

/**
 * Read the shared engagement ledger written by the X automations and return a
 * deduped recent set of engaged handles + tweet status IDs, plus the permanent
 * blocklist (accounts that blocked us).
 *
 * Templates log every reply/quote/follow/post with tags that include "x-engaged"
 * plus "acct:<account>", "handle:<handle>" and (for replies/quotes) "status:<id>";
 * a block is logged with "action:blocked". launchScheduledLoop() reads this to
 * inject a "do not re-engage" skip-list into every run, so no post or author is
 * hit twice ACROSS schedules, and blockers are never re-attempted. Deterministic —
 * does not depend on the agent recalling memory. Account-scoped when `account` is
 * given (each X account keeps its own ledger). Never throws (a ledger lookup
 * failure must not block a scheduled launch).
 *
 * @param {{account?:string|null, days?:number, limit?:number}} opts
 * @returns {{handles:string[], statusIds:string[], blocked:string[], error?:string}}
 */
export function getRecentXEngagements({ account = null, days = 7, limit = 200 } = {}) {
  const acct = account ? String(account).trim().replace(/^@/, '').toLowerCase() : null;
  const acctLike = acct ? `%"acct:${acct}"%` : null;
  const collect = (rows, handleSet, statusSet) => {
    for (const row of rows) {
      let tags;
      try { tags = JSON.parse(row.tags || '[]'); } catch { continue; }
      if (!Array.isArray(tags)) continue;
      for (const t of tags) {
        if (typeof t !== 'string') continue;
        if (t.startsWith('handle:')) {
          const h = t.slice(7).trim().replace(/^@/, '').toLowerCase();
          if (h) handleSet.add(h);
        } else if (statusSet && t.startsWith('status:')) {
          const s = t.slice(7).trim();
          if (s) statusSet.add(s);
        }
      }
    }
  };
  try {
    const db = getDb();
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const handles = new Set();
    const statusIds = new Set();
    const blocked = new Set();

    // Recent engagements (windowed), excluding permanent blocks.
    let engSql = `SELECT tags FROM memories
         WHERE trashed_at IS NULL
           AND tags LIKE '%x-engaged%'
           AND tags NOT LIKE '%action:blocked%'
           AND created_at >= ?`;
    const engParams = [since];
    if (acctLike) { engSql += ` AND tags LIKE ?`; engParams.push(acctLike); }
    engSql += ` ORDER BY created_at DESC LIMIT ?`;
    engParams.push(limit);
    collect(db.prepare(engSql).all(...engParams), handles, statusIds);

    // Permanent blocklist (accounts that blocked us) — no time window.
    let blkSql = `SELECT tags FROM memories
         WHERE trashed_at IS NULL
           AND tags LIKE '%action:blocked%'`;
    const blkParams = [];
    if (acctLike) { blkSql += ` AND tags LIKE ?`; blkParams.push(acctLike); }
    blkSql += ` ORDER BY created_at DESC LIMIT ?`;
    blkParams.push(limit);
    collect(db.prepare(blkSql).all(...blkParams), blocked, null);

    return { handles: [...handles], statusIds: [...statusIds], blocked: [...blocked] };
  } catch (err) {
    return { handles: [], statusIds: [], blocked: [], error: err.message };
  }
}

export const X_ACTION_TYPES = ['reply', 'like', 'quote', 'follow', 'repost'];

/**
 * Count the X actions already spent by an account since `sinceIso`, bucketed by type.
 *
 * Companion to getRecentXEngagements(): that one answers "who have we already hit",
 * this one answers "how much have we already done today". The engagement templates
 * tag every mutation with "x-engaged" + "acct:<account>" + "action:<type>", so the
 * count is deterministic rather than the model's recollection of its own run. The
 * launcher turns this into a per-run budget line, which is the only thing stopping
 * six independent lanes from each spending a full day's quota.
 *
 * `action:blocked` rows are engagement *outcomes*, not actions we took, so they are
 * excluded — matching the blocklist carve-out in getRecentXEngagements().
 * Never throws (a budget lookup failure must not block a scheduled launch); on error
 * every counter reads 0 so a broken ledger fails open rather than freezing all lanes.
 *
 * @param {{account?:string|null, sinceIso?:string, limit?:number}} opts
 * @returns {{reply:number, like:number, quote:number, follow:number, repost:number, total:number, error?:string}}
 */
export function getXActionBudget({ account = null, sinceIso, limit = 500 } = {}) {
  const counts = Object.fromEntries(X_ACTION_TYPES.map(t => [t, 0]));
  const empty = { ...counts, total: 0 };
  const acct = account ? String(account).trim().replace(/^@/, '').toLowerCase() : null;
  try {
    const db = getDb();
    const since = sinceIso || new Date(Date.now() - 86400000).toISOString();
    let sql = `SELECT tags FROM memories
         WHERE trashed_at IS NULL
           AND tags LIKE '%x-engaged%'
           AND tags NOT LIKE '%action:blocked%'
           AND created_at >= ?`;
    const params = [since];
    if (acct) { sql += ` AND tags LIKE ?`; params.push(`%"acct:${acct}"%`); }
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    let total = 0;
    for (const row of db.prepare(sql).all(...params)) {
      let tags;
      try { tags = JSON.parse(row.tags || '[]'); } catch { continue; }
      if (!Array.isArray(tags)) continue;
      // One memory logs one action. Count the first recognised action tag only, so a
      // ledger entry that also mentions a sibling action does not double-charge.
      for (const t of tags) {
        if (typeof t !== 'string' || !t.startsWith('action:')) continue;
        const kind = t.slice(7).trim().toLowerCase();
        if (!Object.hasOwn(counts, kind)) continue;
        counts[kind]++;
        total++;
        break;
      }
    }
    return { ...counts, total };
  } catch (err) {
    return { ...empty, error: err.message };
  }
}

/**
 * Per-day ceilings for each engagement ramp tier, shared by every X lane of an account.
 * The tier is STATE (written by the daily metrics run after it checks the account is
 * clean); the ceilings are CODE, so a model cannot talk itself into a wider budget by
 * rewriting a memory. Tier 1 is the post-shadow-ban starting point.
 */
export const X_ENGAGEMENT_TIERS = {
  1: { reply: 12, like: 30, quote: 0, follow: 6, repost: 2 },
  2: { reply: 24, like: 45, quote: 1, follow: 8, repost: 3 },
  3: { reply: 36, like: 60, quote: 2, follow: 12, repost: 4 },
};
export const X_DEFAULT_TIER = 1;

/**
 * Read the current engagement ramp tier from the canonical `critpix-x-engagement-caps`
 * memory. Falls back to the most conservative tier whenever the memory is missing,
 * unparseable, or names a tier that does not exist — an unreadable ledger must narrow
 * the budget, never widen it.
 *
 * @param {{account?:string|null}} opts
 * @returns {{tier:number, caps:{reply:number,like:number,quote:number,follow:number,repost:number}, source:'memory'|'default', error?:string}}
 */
export function getXEngagementTier({ account = null } = {}) {
  const fallback = { tier: X_DEFAULT_TIER, caps: X_ENGAGEMENT_TIERS[X_DEFAULT_TIER], source: 'default' };
  const acct = account ? String(account).trim().replace(/^@/, '').toLowerCase() : null;
  try {
    const db = getDb();
    let sql = `SELECT content FROM memories
         WHERE trashed_at IS NULL
           AND tags LIKE '%critpix-x-engagement-caps%'`;
    const params = [];
    if (acct) { sql += ` AND (tags LIKE ? OR tags NOT LIKE '%"acct:%')`; params.push(`%"acct:${acct}"%`); }
    sql += ` ORDER BY created_at DESC LIMIT 1`;
    const row = db.prepare(sql).all(...params)[0];
    if (!row?.content) return fallback;
    const m = /\btier\s*[:=]\s*(\d+)/i.exec(row.content);
    const tier = m ? Number(m[1]) : NaN;
    if (!Object.hasOwn(X_ENGAGEMENT_TIERS, tier)) return fallback;
    return { tier, caps: X_ENGAGEMENT_TIERS[tier], source: 'memory' };
  } catch (err) {
    return { ...fallback, error: err.message };
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

  // Trash search is a rare admin path — the cache only holds live rows,
  // so fall back to a direct scan when trash must be included.
  if (includeTrash) {
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

  // Hot path: score against the in-memory matrix, hydrate only the top K
  let allowedIds;
  if (clauses.length > 0) {
    const idRows = d.prepare(
      `SELECT id FROM memories WHERE trashed_at IS NULL AND ${clauses.join(' AND ')}`
    ).all(...params);
    allowedIds = new Set(idRows.map(r => r.id));
    if (allowedIds.size === 0) return [];
  }

  const top = memoryVectors.topK(vector, limit, scoreThreshold, allowedIds);
  if (top.length === 0) return [];

  const placeholders = top.map(() => '?').join(', ');
  const rows = d.prepare(`
    SELECT id, vector, content, category, subcategory, project, tags, importance, source,
           created_at, updated_at, accessed_at, access_count, related_files,
           related_memory_ids, file_checksums, trashed_at, source_session_chunks
    FROM memories WHERE id IN (${placeholders})
  `).all(...top.map(t => t.id));

  const rowById = new Map(rows.map(r => [r.id, r]));
  return top
    .filter(t => rowById.has(t.id))
    .map(t => {
      const row = rowById.get(t.id);
      return { ...rowToPayload(row), id: t.id, score: t.score, vector: decodeVector(row.vector) };
    });
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

  if ('trashed_at' in updates) {
    if (updates.trashed_at) memoryVectors.remove(id);
    else memoryVectors.setFromDb(id);
  }
}

export function softDeleteMemory(id) {
  const d = getDb();
  d.prepare('UPDATE memories SET trashed_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  memoryVectors.remove(id);
}

export function hardDeleteMemory(id) {
  const d = getDb();
  d.prepare('DELETE FROM memories WHERE id = ?').run(id);
  memoryVectors.remove(id);
}

export function restoreMemory(id) {
  const d = getDb();
  d.prepare('UPDATE memories SET trashed_at = NULL WHERE id = ?').run(id);
  memoryVectors.setFromDb(id);
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

  let allowedIds;
  if (project) {
    const idRows = d.prepare('SELECT id FROM session_chunks WHERE project = ?').all(project);
    allowedIds = new Set(idRows.map(r => r.id));
    if (allowedIds.size === 0) return [];
  }

  const top = chunkVectors.topK(vector, limit, scoreThreshold, allowedIds);
  if (top.length === 0) return [];

  const placeholders = top.map(() => '?').join(', ');
  const rows = d.prepare(`
    SELECT id, content, summary, session_id, project, git_branch, cwd,
           chunk_index, start_timestamp, end_timestamp, tools_used, files_modified,
           files_read, user_messages, turn_count, related_memory_ids, dedup_memory_id, indexed_at
    FROM session_chunks WHERE id IN (${placeholders})
  `).all(...top.map(t => t.id));

  const rowById = new Map(rows.map(r => [r.id, r]));
  return top
    .filter(t => rowById.has(t.id))
    .map(t => ({ id: t.id, score: t.score, payload: rowToSessionPayload(rowById.get(t.id)) }));
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

// --- Session cache + FTS helpers ---

export function upsertSessionCache(entry) {
  const d = getDb();
  d.prepare(`INSERT OR REPLACE INTO session_cache
    (session_id, provider, project, project_path, git_branch, first_prompt, message_count,
     created, modified, file_path, file_size, file_mtime, body_size, deleted, account_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    entry.session_id, entry.provider, entry.project || null, entry.project_path || null,
    entry.git_branch || null, entry.first_prompt || null, entry.message_count || 0,
    entry.created || null, entry.modified || null, entry.file_path || null,
    entry.file_size || null, entry.file_mtime || null, entry.body_size || 0,
    entry.deleted ? 1 : 0, entry.account_id || null,
  );
}

export function upsertSessionFts(entry) {
  const d = getDb();
  d.prepare('DELETE FROM session_fts WHERE session_id = ? AND provider = ?')
    .run(entry.session_id, entry.provider);
  d.prepare(`INSERT INTO session_fts
    (session_id, provider, project, first_prompt, body)
    VALUES (?, ?, ?, ?, ?)`).run(
    entry.session_id, entry.provider, entry.project || null,
    entry.first_prompt || '', entry.body || '',
  );
}

export function getSessionCacheEntry(sessionId, provider) {
  const d = getDb();
  return d.prepare('SELECT * FROM session_cache WHERE session_id = ? AND provider = ?')
    .get(sessionId, provider) || null;
}

export function getSessionCacheFileMeta(filePath, provider) {
  const d = getDb();
  return d.prepare('SELECT file_size, file_mtime FROM session_cache WHERE file_path = ? AND provider = ?')
    .get(filePath, provider) || null;
}

export function markSessionDeleted(sessionId, provider, deleted = true) {
  const d = getDb();
  d.prepare('UPDATE session_cache SET deleted = ? WHERE session_id = ? AND provider = ?')
    .run(deleted ? 1 : 0, sessionId, provider);
}

export function listSessionCache(provider, { projectPath, limit = 100, offset = 0 } = {}) {
  const d = getDb();
  const clauses = ['provider = ?'];
  const params = [provider];
  if (projectPath) {
    clauses.push('project_path = ?');
    params.push(projectPath);
  }
  const sql = `SELECT * FROM session_cache WHERE ${clauses.join(' AND ')}
    ORDER BY modified DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);
  return d.prepare(sql).all(...params);
}

/** Remove only a provider's derived Resume/search cache. Source histories live
 * outside memory.db and are intentionally unaffected by this helper. */
export function clearSessionCacheProvider(provider) {
  const normalized = String(provider || '').trim();
  if (!normalized) throw new Error('Session cache provider is required');
  const d = getDb();
  const cached = Number(d.prepare('SELECT COUNT(*) AS count FROM session_cache WHERE provider = ?')
    .get(normalized)?.count || 0);
  const fts = Number(d.prepare('SELECT COUNT(*) AS count FROM session_fts WHERE provider = ?')
    .get(normalized)?.count || 0);
  d.exec('BEGIN IMMEDIATE');
  try {
    d.prepare('DELETE FROM session_fts WHERE provider = ?').run(normalized);
    d.prepare('DELETE FROM session_cache WHERE provider = ?').run(normalized);
    d.exec('COMMIT');
  } catch (error) {
    try { d.exec('ROLLBACK'); } catch {}
    throw error;
  }
  return { cached, fts };
}

/** Escape a user-provided query for safe FTS5 MATCH.
 *  Strips control chars, wraps each token in quotes, joins with AND. */
export function buildFtsQuery(raw) {
  if (!raw) return '';
  const cleaned = String(raw)
    .replace(/["'()]/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
  if (!cleaned) return '';
  const tokens = cleaned.split(/\s+/).filter(t => t.length >= 2);
  if (tokens.length === 0) return '';
  return tokens.map(t => `"${t}"*`).join(' AND ');
}

/** Run FTS5 search over session_fts. Returns array of { session_id, provider, rank, snippet }. */
export function searchSessionFts(query, { provider, project, limit = 50 } = {}) {
  const d = getDb();
  const matchQuery = buildFtsQuery(query);
  if (!matchQuery) return [];

  const clauses = ['session_fts MATCH ?'];
  const params = [matchQuery];

  if (provider) {
    clauses.push('provider = ?');
    params.push(provider);
  }
  if (project) {
    clauses.push('project = ?');
    params.push(project);
  }

  const sql = `SELECT session_id, provider, project,
                      snippet(session_fts, 4, '<mark>', '</mark>', '…', 16) AS snippet,
                      bm25(session_fts) AS rank
               FROM session_fts
               WHERE ${clauses.join(' AND ')}
               ORDER BY rank
               LIMIT ?`;
  params.push(limit);
  try {
    return d.prepare(sql).all(...params);
  } catch {
    return [];
  }
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
