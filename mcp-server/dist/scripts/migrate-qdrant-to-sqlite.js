#!/usr/bin/env tsx
/**
 * One-time migration script: Qdrant → SQLite
 *
 * Reads all memories and session chunks from a running Qdrant instance,
 * re-embeds them using the local Transformers.js model (384 dims),
 * and inserts them into the SQLite database.
 *
 * Usage:
 *   cd mcp-server
 *   npx tsx src/scripts/migrate-qdrant-to-sqlite.ts
 *
 * Requirements:
 *   - Qdrant must still be running during migration
 *   - .env must contain the QDRANT__* and EMBEDDING__* variables
 *   - First run will download the embedding model (~23MB)
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync, mkdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
const ENV_PATH = path.resolve(ROOT, '..', '.env');
// --- Load .env manually ---
function loadEnv() {
    if (!existsSync(ENV_PATH)) {
        console.error(`ERROR: .env not found at ${ENV_PATH}`);
        process.exit(1);
    }
    const env = {};
    const lines = readFileSync(ENV_PATH, 'utf-8').split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#'))
            continue;
        const eq = trimmed.indexOf('=');
        if (eq < 0)
            continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim();
        env[key] = val;
    }
    return env;
}
function getQdrantConfig(env) {
    const activeId = env['QDRANT_ACTIVE'];
    if (!activeId) {
        console.error('ERROR: QDRANT_ACTIVE not set in .env');
        process.exit(1);
    }
    const prefix = `QDRANT__${activeId}__`;
    const port = env[`${prefix}PORT`] || '6333';
    const apiKey = env[`${prefix}API_KEY`] || '';
    const collection = env[`${prefix}COLLECTION`] || 'claude_memory';
    return {
        url: `http://localhost:${port}`,
        apiKey,
        collection,
    };
}
async function qdrantFetch(cfg, endpoint, options = {}) {
    const url = `${cfg.url}${endpoint}`;
    const headers = {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
    };
    if (cfg.apiKey) {
        headers['api-key'] = cfg.apiKey;
    }
    const res = await fetch(url, { ...options, headers });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Qdrant ${options.method || 'GET'} ${endpoint} → ${res.status}: ${text}`);
    }
    return res.json();
}
// --- Scroll all points from Qdrant ---
const CATEGORIES_POINT_ID = '00000000-0000-0000-0000-000000000000';
async function scrollAll(cfg, collection, withVector = false) {
    const points = [];
    let offset = null;
    const limit = 100;
    while (true) {
        const body = {
            limit,
            with_payload: true,
            with_vector: withVector,
        };
        if (offset)
            body.offset = offset;
        const data = await qdrantFetch(cfg, `/collections/${collection}/points/scroll`, {
            method: 'POST',
            body: JSON.stringify(body),
        });
        const result = data.result || data;
        const batch = result.points || [];
        points.push(...batch);
        if (result.next_page_offset) {
            offset = result.next_page_offset;
        }
        else {
            break;
        }
    }
    return points;
}
// --- Local embeddings ---
let embeddingPipeline = null;
async function initEmbeddings() {
    console.log('  Loading embedding model (Xenova/all-MiniLM-L6-v2)...');
    const { pipeline } = await import('@huggingface/transformers');
    embeddingPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
        dtype: 'fp32',
    });
    console.log('  Embedding model ready (384 dimensions)');
}
async function embed(text) {
    const output = await embeddingPipeline(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
}
function encodeVector(vector) {
    return new Uint8Array(new Float32Array(vector).buffer);
}
// --- SQLite setup ---
function initSqlite() {
    if (!existsSync(DATA_DIR))
        mkdirSync(DATA_DIR, { recursive: true });
    const dbPath = path.join(DATA_DIR, 'memory.db');
    console.log(`  SQLite database: ${dbPath}`);
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    // Create schema
    db.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_sc_session ON session_chunks(session_id);
    CREATE INDEX IF NOT EXISTS idx_sc_project ON session_chunks(project);
  `);
    return db;
}
// --- JSON serialization helpers ---
function jsonStr(val) {
    if (val == null)
        return null;
    if (Array.isArray(val) || typeof val === 'object')
        return JSON.stringify(val);
    if (typeof val === 'string')
        return val;
    return String(val);
}
// --- Main migration ---
async function main() {
    console.log('\n═══════════════════════════════════════════');
    console.log(' SynaBun: Qdrant → SQLite Migration');
    console.log('═══════════════════════════════════════════\n');
    // Step 1: Load config
    console.log('[1/6] Loading configuration...');
    const env = loadEnv();
    const cfg = getQdrantConfig(env);
    console.log(`  Qdrant: ${cfg.url} (collection: ${cfg.collection})`);
    // Step 2: Test Qdrant connection
    console.log('\n[2/6] Connecting to Qdrant...');
    try {
        const info = await qdrantFetch(cfg, `/collections/${cfg.collection}`);
        const pointCount = info.result?.points_count ?? '?';
        console.log(`  Connected! Collection "${cfg.collection}" has ${pointCount} points`);
    }
    catch (err) {
        console.error(`  ERROR: Cannot connect to Qdrant at ${cfg.url}`);
        console.error(`  Make sure Qdrant is running. Error: ${err.message}`);
        process.exit(1);
    }
    // Check for session_chunks collection (try both naming conventions)
    let hasSessionChunks = false;
    let sessionChunksCollection = '';
    for (const name of ['session_chunks', `${cfg.collection}_session_chunks`]) {
        try {
            const scInfo = await qdrantFetch(cfg, `/collections/${name}`);
            const scCount = scInfo.result?.points_count ?? 0;
            if (scCount > 0) {
                hasSessionChunks = true;
                sessionChunksCollection = name;
                console.log(`  Session chunks collection "${name}": ${scCount} chunks`);
                break;
            }
        }
        catch {
            // Try next name
        }
    }
    if (!hasSessionChunks) {
        console.log('  No session chunks collection found (will skip)');
    }
    // Step 3: Initialize embedding model
    console.log('\n[3/6] Initializing local embedding model...');
    await initEmbeddings();
    // Step 4: Initialize SQLite
    console.log('\n[4/6] Initializing SQLite database...');
    const db = initSqlite();
    // Check if SQLite already has data
    const existingCount = db.prepare('SELECT COUNT(*) as cnt FROM memories').get().cnt;
    if (existingCount > 0) {
        console.log(`  WARNING: SQLite already has ${existingCount} memories!`);
        console.log('  Existing data will NOT be overwritten (INSERT OR IGNORE).');
    }
    // Step 5: Migrate memories
    console.log('\n[5/6] Migrating memories...');
    const memPoints = await scrollAll(cfg, cfg.collection);
    const memories = memPoints.filter(p => p.id !== CATEGORIES_POINT_ID);
    console.log(`  Found ${memories.length} memories (${memPoints.length - memories.length} system points skipped)`);
    // Extract categories from system metadata point
    const catPoint = memPoints.find(p => p.id === CATEGORIES_POINT_ID);
    if (catPoint?.payload?.categories) {
        const cats = catPoint.payload.categories;
        console.log(`  Found ${cats.length} categories in system metadata`);
        db.exec('BEGIN');
        try {
            const catStmt = db.prepare('INSERT OR REPLACE INTO categories (name, description, created_at, parent, color, is_parent) VALUES (?, ?, ?, ?, ?, ?)');
            for (const cat of cats) {
                catStmt.run(cat.name, cat.description || '', cat.created_at || new Date().toISOString(), cat.parent || null, cat.color || null, cat.is_parent ? 1 : 0);
            }
            db.exec('COMMIT');
            console.log(`  Migrated ${cats.length} categories`);
        }
        catch (err) {
            db.exec('ROLLBACK');
            console.error('  ERROR migrating categories:', err);
        }
    }
    // Migrate memories in batches
    const BATCH = 20;
    let migrated = 0;
    let skipped = 0;
    let errors = 0;
    const memStmt = db.prepare(`
    INSERT OR IGNORE INTO memories
    (id, vector, content, category, subcategory, project, tags, importance, source,
     created_at, updated_at, accessed_at, access_count, related_files,
     related_memory_ids, file_checksums, trashed_at, source_session_chunks)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    for (let i = 0; i < memories.length; i += BATCH) {
        const batch = memories.slice(i, i + BATCH);
        const texts = batch.map(p => (p.payload.content || '').slice(0, 2000));
        // Re-embed batch
        const vectors = [];
        for (const text of texts) {
            try {
                vectors.push(await embed(text));
            }
            catch (err) {
                vectors.push(new Array(384).fill(0));
                errors++;
            }
        }
        db.exec('BEGIN');
        try {
            for (let j = 0; j < batch.length; j++) {
                const p = batch[j].payload;
                const now = new Date().toISOString();
                memStmt.run(batch[j].id, encodeVector(vectors[j]), p.content || '', p.category || 'general', p.subcategory || null, p.project || 'global', jsonStr(p.tags) || '[]', p.importance ?? 5, p.source || 'self-discovered', p.created_at || now, p.updated_at || now, p.accessed_at || now, p.access_count ?? 0, jsonStr(p.related_files), jsonStr(p.related_memory_ids), jsonStr(p.file_checksums), p.trashed_at || null, jsonStr(p.source_session_chunks));
                migrated++;
            }
            db.exec('COMMIT');
        }
        catch (err) {
            db.exec('ROLLBACK');
            errors += batch.length;
            console.error(`  ERROR on batch ${i}-${i + batch.length}:`, err);
        }
        process.stdout.write(`\r  Migrated ${migrated}/${memories.length} memories...`);
    }
    console.log(`\r  Migrated ${migrated}/${memories.length} memories (${skipped} skipped, ${errors} errors)`);
    // Step 6: Migrate session chunks
    if (hasSessionChunks) {
        console.log('\n[6/6] Migrating session chunks...');
        const chunks = await scrollAll(cfg, sessionChunksCollection);
        console.log(`  Found ${chunks.length} session chunks`);
        let scMigrated = 0;
        let scErrors = 0;
        const scStmt = db.prepare(`
      INSERT OR IGNORE INTO session_chunks
      (id, vector, content, summary, session_id, project, git_branch, cwd,
       chunk_index, start_timestamp, end_timestamp, tools_used, files_modified,
       files_read, user_messages, turn_count, related_memory_ids, dedup_memory_id, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        for (let i = 0; i < chunks.length; i += BATCH) {
            const batch = chunks.slice(i, i + BATCH);
            const texts = batch.map(p => (p.payload.content || '').slice(0, 2000));
            const vectors = [];
            for (const text of texts) {
                try {
                    vectors.push(await embed(text));
                }
                catch {
                    vectors.push(new Array(384).fill(0));
                    scErrors++;
                }
            }
            db.exec('BEGIN');
            try {
                for (let j = 0; j < batch.length; j++) {
                    const p = batch[j].payload;
                    scStmt.run(batch[j].id, encodeVector(vectors[j]), p.content || '', p.summary || null, p.session_id || null, p.project || null, p.git_branch || null, p.cwd || null, p.chunk_index ?? 0, p.start_timestamp || null, p.end_timestamp || null, jsonStr(p.tools_used) || '[]', jsonStr(p.files_modified) || '[]', jsonStr(p.files_read) || '[]', jsonStr(p.user_messages) || '[]', p.turn_count ?? 0, jsonStr(p.related_memory_ids) || '[]', p.dedup_memory_id || null, p.indexed_at || null);
                    scMigrated++;
                }
                db.exec('COMMIT');
            }
            catch (err) {
                db.exec('ROLLBACK');
                scErrors += batch.length;
                console.error(`  ERROR on session chunk batch ${i}-${i + batch.length}:`, err);
            }
            process.stdout.write(`\r  Migrated ${scMigrated}/${chunks.length} session chunks...`);
        }
        console.log(`\r  Migrated ${scMigrated}/${chunks.length} session chunks (${scErrors} errors)`);
    }
    else {
        console.log('\n[6/6] Skipping session chunks (none found)');
    }
    // Summary
    const finalMem = db.prepare('SELECT COUNT(*) as cnt FROM memories').get().cnt;
    const finalSc = db.prepare('SELECT COUNT(*) as cnt FROM session_chunks').get().cnt;
    const finalCat = db.prepare('SELECT COUNT(*) as cnt FROM categories').get().cnt;
    const dbSize = statSync(path.join(DATA_DIR, 'memory.db')).size;
    db.close();
    console.log('\n═══════════════════════════════════════════');
    console.log(' Migration Complete!');
    console.log('═══════════════════════════════════════════');
    console.log(`  Memories:       ${finalMem}`);
    console.log(`  Session chunks: ${finalSc}`);
    console.log(`  Categories:     ${finalCat}`);
    console.log(`  Database size:  ${(dbSize / 1024).toFixed(1)} KB`);
    console.log(`  Path:           ${path.join(DATA_DIR, 'memory.db')}`);
    console.log('\nYou can now stop the Qdrant Docker container:');
    console.log('  docker stop synabun-qdrant && docker rm synabun-qdrant\n');
}
main().catch(err => {
    console.error('\nFATAL ERROR:', err);
    process.exit(1);
});
//# sourceMappingURL=migrate-qdrant-to-sqlite.js.map