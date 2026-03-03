/**
 * Session Indexer — Pipeline orchestrator for indexing Claude Code session transcripts.
 * Reads JSONL files, chunks them, embeds chunks, stores in Qdrant, cross-references with memories.
 *
 * Runs in the Neural Interface server process. Uses its own OpenAI + Qdrant clients
 * (reads config from shared .env) to avoid circular dependency with MCP server.
 */

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { QdrantClient } from '@qdrant/js-client-rest';
import OpenAI from 'openai';
import { chunkSession, parseLine } from './session-chunker.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const DATA_DIR = join(PROJECT_ROOT, 'data');
const STATE_FILE = join(DATA_DIR, 'session-index-state.json');

const SESSION_COLLECTION = 'session_chunks';
const MEMORY_COLLECTION_DEFAULT = 'claude_memory';
const EMBEDDING_BATCH_SIZE = 20;
const QDRANT_UPSERT_BATCH_SIZE = 50;
const DEDUP_THRESHOLD = 0.92;

// --- Config loading from .env ---

function loadEnvConfig() {
  const env = {};
  // Check both neural-interface/.env and parent Synabun/.env
  const candidates = [join(PROJECT_ROOT, '.env'), join(PROJECT_ROOT, '..', '.env')];
  for (const envPath of candidates) {
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
      }
    }
  }
  // Also include process.env (dotenv may have loaded already)
  return { ...env, ...process.env };
}

function getQdrantConfig(env) {
  const active = env.QDRANT_ACTIVE || '';
  if (active) {
    const prefix = `QDRANT__${active}__`;
    const port = env[`${prefix}PORT`] || '6333';
    const url = env[`${prefix}URL`] || `http://localhost:${port}`;
    return {
      url,
      apiKey: env[`${prefix}API_KEY`] || '',
      collection: env[`${prefix}COLLECTION`] || MEMORY_COLLECTION_DEFAULT,
    };
  }
  return {
    url: env.QDRANT_MEMORY_URL || `http://localhost:${env.QDRANT_PORT || '6333'}`,
    apiKey: env.QDRANT_MEMORY_API_KEY || '',
    collection: env.QDRANT_MEMORY_COLLECTION || MEMORY_COLLECTION_DEFAULT,
  };
}

function getEmbeddingConfig(env) {
  const active = env.EMBEDDING_ACTIVE || '';
  if (active) {
    const prefix = `EMBEDDING__${active}__`;
    return {
      apiKey: env[`${prefix}API_KEY`] || env.OPENAI_EMBEDDING_API_KEY || '',
      baseUrl: env[`${prefix}BASE_URL`] || 'https://api.openai.com/v1',
      model: env[`${prefix}MODEL`] || 'text-embedding-3-small',
      dimensions: parseInt(env[`${prefix}DIMENSIONS`] || '1536', 10),
    };
  }
  return {
    apiKey: env.OPENAI_EMBEDDING_API_KEY || env.OPENAI_API_KEY || '',
    baseUrl: env.EMBEDDING_BASE_URL || 'https://api.openai.com/v1',
    model: env.EMBEDDING_MODEL || 'text-embedding-3-small',
    dimensions: parseInt(env.EMBEDDING_DIMENSIONS || '1536', 10),
  };
}

// --- State management ---

function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return { version: 1, sessions: {} };
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// --- Project detection ---

const PROJECT_MAP = {
  criticalpixel: 'criticalpixel',
  ellacred: 'ellacred',
  synabun: 'synabun',
};

function detectProject(cwd) {
  if (!cwd) return 'global';
  const lower = cwd.toLowerCase();
  for (const [key, value] of Object.entries(PROJECT_MAP)) {
    if (lower.includes(key)) return value;
  }
  const base = basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return base || 'global';
}

/** Derive project label from Claude's directory name (e.g. "j--Sites-CriticalPixel" → "criticalpixel") */
function detectProjectFromDir(dirName) {
  if (!dirName) return 'global';
  const lower = dirName.toLowerCase();
  for (const [key, value] of Object.entries(PROJECT_MAP)) {
    if (lower.includes(key)) return value;
  }
  // Use last segment of the dir name (after last -)
  const parts = dirName.split('-').filter(Boolean);
  return (parts[parts.length - 1] || 'global').toLowerCase();
}

// --- Embedding ---

async function embedBatch(openai, config, texts) {
  if (texts.length === 0) return [];
  const results = [];
  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
    const response = await openai.embeddings.create({
      model: config.model,
      input: batch,
      dimensions: config.dimensions,
    });
    const sorted = response.data.sort((a, b) => a.index - b.index);
    for (const item of sorted) {
      results.push(item.embedding);
    }
  }
  return results;
}

// --- Session file parsing ---

function parseSessionFile(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const rawLines = content.split('\n');
  const lines = [];
  let sessionMeta = null;

  for (let i = 0; i < rawLines.length; i++) {
    const parsed = parseLine(rawLines[i]);
    if (!parsed) continue;
    lines.push(parsed);

    // Extract session metadata from first user message
    if (!sessionMeta && parsed.type === 'user' && parsed.message && !parsed.isMeta) {
      sessionMeta = {
        sessionId: parsed.sessionId || basename(filePath, '.jsonl'),
        cwd: parsed.cwd || null,
        gitBranch: parsed.gitBranch || null,
        project: detectProject(parsed.cwd),
      };
    }
  }

  if (!sessionMeta) {
    // Fallback: try to extract from any line
    for (const line of lines) {
      if (line.sessionId) {
        sessionMeta = {
          sessionId: line.sessionId,
          cwd: line.cwd || null,
          gitBranch: line.gitBranch || null,
          project: detectProject(line.cwd),
        };
        break;
      }
    }
  }

  return { lines, sessionMeta, lineCount: rawLines.length };
}

// --- Cross-referencing ---

async function findRelatedMemories(qdrant, memoryCollection, chunkStartTs, chunkEndTs, project) {
  // Find memories created during this chunk's time window
  const filter = {
    must: [
      { key: 'created_at', range: { gte: chunkStartTs, lte: chunkEndTs } },
    ],
  };
  if (project && project !== 'global') {
    filter.must.push({ key: 'project', match: { value: project } });
  }

  try {
    const result = await qdrant.scroll(memoryCollection, {
      filter,
      limit: 20,
      with_payload: true,
    });
    return result.points.map(p => String(p.id));
  } catch {
    return [];
  }
}

async function findDedupMemory(qdrant, memoryCollection, vector) {
  try {
    // Exclude system metadata point
    const filter = {
      must_not: [{ key: '_type', match: { value: 'system_metadata' } }],
      must: [{ is_empty: { key: 'trashed_at' } }],
    };
    const results = await qdrant.search(memoryCollection, {
      vector,
      limit: 1,
      with_payload: true,
      score_threshold: DEDUP_THRESHOLD,
      filter,
    });
    if (results.length > 0) {
      return String(results[0].id);
    }
  } catch { /* ignore */ }
  return null;
}

async function backlinkMemory(qdrant, memoryCollection, memoryId, sessionId, chunkId) {
  try {
    const points = await qdrant.retrieve(memoryCollection, {
      ids: [memoryId],
      with_payload: true,
      with_vector: false,
    });
    if (points.length === 0) return;

    const payload = points[0].payload;
    const existing = payload.source_session_chunks || [];
    // Don't add duplicate links
    if (existing.some(e => e.chunk_id === chunkId)) return;

    await qdrant.setPayload(memoryCollection, {
      points: [memoryId],
      payload: {
        source_session_chunks: [...existing, { session_id: sessionId, chunk_id: chunkId }],
      },
    });
  } catch { /* ignore backlink failures */ }
}

// --- Retry helper ---

async function withRetry(fn, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const delay = Math.pow(3, attempt) * 1000; // 1s, 3s, 9s
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// --- Main indexing pipeline ---

/**
 * @typedef {Object} IndexingOptions
 * @property {string} [project] - Filter to a specific project path
 * @property {boolean} [reindex] - Re-index already-indexed sessions
 * @property {string[]} [sessionIds] - Index only specific session IDs
 * @property {function} [onProgress] - Progress callback: (event) => void
 * @property {function} [isCancelled] - Returns true if indexing should stop
 */

/**
 * Start the indexing pipeline.
 * @param {IndexingOptions} options
 * @returns {Promise<{ totalSessions: number, totalChunks: number, errors: number }>}
 */
export async function startIndexing(options = {}) {
  const { onProgress, isCancelled } = options;
  const emit = onProgress || (() => {});

  // Load config
  const env = loadEnvConfig();
  const qdrantConfig = getQdrantConfig(env);
  const embConfig = getEmbeddingConfig(env);

  if (!embConfig.apiKey) {
    throw new Error('No embedding API key configured');
  }

  // Initialize clients
  const qdrant = new QdrantClient({ url: qdrantConfig.url, apiKey: qdrantConfig.apiKey });
  const openai = new OpenAI({ apiKey: embConfig.apiKey, baseURL: embConfig.baseUrl });
  const memoryCollection = qdrantConfig.collection;

  // Ensure session_chunks collection exists
  try {
    const exists = await qdrant.collectionExists(SESSION_COLLECTION);
    if (!exists.exists) {
      await qdrant.createCollection(SESSION_COLLECTION, {
        vectors: { size: embConfig.dimensions, distance: 'Cosine' },
        optimizers_config: { indexing_threshold: 100 },
      });
      const keywordFields = ['session_id', 'project', 'git_branch', 'tools_used', 'dedup_memory_id', 'start_timestamp', 'end_timestamp'];
      const integerFields = ['chunk_index', 'turn_count'];
      const textFields = ['content'];
      for (const f of keywordFields) await qdrant.createPayloadIndex(SESSION_COLLECTION, { field_name: f, field_schema: 'keyword' });
      for (const f of integerFields) await qdrant.createPayloadIndex(SESSION_COLLECTION, { field_name: f, field_schema: 'integer' });
      for (const f of textFields) await qdrant.createPayloadIndex(SESSION_COLLECTION, { field_name: f, field_schema: 'text' });
    }
  } catch (err) {
    throw new Error(`Failed to ensure session_chunks collection: ${err.message}`);
  }

  // Load indexing state
  const state = loadState();

  // Discover sessions to index by scanning ~/.claude/projects/ directly
  const homeDir = process.env.USERPROFILE || process.env.HOME;
  const claudeProjectsDir = join(homeDir, '.claude', 'projects');

  const sessionsToIndex = [];

  let projectDirs = [];
  try {
    projectDirs = readdirSync(claudeProjectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => ({ name: d.name, path: join(claudeProjectsDir, d.name) }));
  } catch { /* no projects dir */ }

  // Filter by project if requested (match on directory name containing project keyword)
  if (options.project) {
    const projLower = options.project.toLowerCase();
    projectDirs = projectDirs.filter(d => d.name.toLowerCase().includes(projLower));
  }

  for (const projDir of projectDirs) {
    let files;
    try { files = readdirSync(projDir.path).filter(f => f.endsWith('.jsonl')); } catch { continue; }

    for (const file of files) {
      const sessionId = file.replace('.jsonl', '');
      const filePath = join(projDir.path, file);

      // Check if specific sessions requested
      if (options.sessionIds && !options.sessionIds.includes(sessionId)) continue;

      // Check if already indexed
      if (!options.reindex && state.sessions[sessionId]) {
        const entry = state.sessions[sessionId];
        if (entry.status === 'complete') {
          try {
            const stat = statSync(filePath);
            if (stat.size === entry.file_size && stat.mtime.toISOString() === entry.file_mtime) {
              continue; // Already indexed and unchanged
            }
          } catch { continue; }
        }
      }

      try {
        const stat = statSync(filePath);
        // Skip tiny sessions (< 1KB = likely empty)
        if (stat.size < 1024) continue;
        sessionsToIndex.push({
          sessionId,
          filePath,
          fileSize: stat.size,
          fileMtime: stat.mtime.toISOString(),
          projectDir: projDir.name,
        });
      } catch { continue; }
    }
  }

  // Sort by mtime desc (newest first)
  sessionsToIndex.sort((a, b) => new Date(b.fileMtime) - new Date(a.fileMtime));

  const totalSessions = sessionsToIndex.length;
  emit({ type: 'indexing:started', totalSessions, project: options.project || 'all' });

  let totalChunks = 0;
  let errors = 0;
  const startedAt = new Date().toISOString();

  for (let si = 0; si < sessionsToIndex.length; si++) {
    if (isCancelled && isCancelled()) {
      emit({ type: 'indexing:cancelled', completedSessions: si, totalSessions });
      break;
    }

    const session = sessionsToIndex[si];
    emit({ type: 'indexing:session-started', sessionId: session.sessionId, sessionIndex: si, totalSessions });

    try {
      // Step 1: Parse session file
      emit({ type: 'indexing:session-progress', sessionId: session.sessionId, phase: 'parsing' });
      const { lines, sessionMeta, lineCount } = parseSessionFile(session.filePath);

      if (!sessionMeta || lines.length < 3) {
        // Too small to chunk meaningfully
        state.sessions[session.sessionId] = {
          session_id: session.sessionId,
          file_path: session.filePath,
          file_size: session.fileSize,
          file_mtime: session.fileMtime,
          chunk_count: 0,
          chunk_ids: [],
          indexed_at: new Date().toISOString(),
          project: sessionMeta?.project || detectProjectFromDir(session.projectDir),
          status: 'complete',
          last_line_indexed: lineCount,
        };
        emit({ type: 'indexing:session-complete', sessionId: session.sessionId, chunkCount: 0, sessionIndex: si, totalSessions });
        continue;
      }

      // Step 2: Chunk
      const chunks = chunkSession(lines, sessionMeta);
      if (chunks.length === 0) {
        state.sessions[session.sessionId] = {
          session_id: session.sessionId,
          file_path: session.filePath,
          file_size: session.fileSize,
          file_mtime: session.fileMtime,
          chunk_count: 0,
          chunk_ids: [],
          indexed_at: new Date().toISOString(),
          project: sessionMeta.project,
          status: 'complete',
          last_line_indexed: lineCount,
        };
        emit({ type: 'indexing:session-complete', sessionId: session.sessionId, chunkCount: 0, sessionIndex: si, totalSessions });
        continue;
      }

      // Step 3: Embed chunks
      emit({ type: 'indexing:session-progress', sessionId: session.sessionId, phase: 'embedding' });
      const contentTexts = chunks.map(c => c.content);
      const vectors = await withRetry(() => embedBatch(openai, embConfig, contentTexts));

      // Step 4: Dedup check + cross-reference
      emit({ type: 'indexing:session-progress', sessionId: session.sessionId, phase: 'cross-referencing' });
      const chunkIds = [];
      const points = [];

      for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];
        const vector = vectors[ci];
        const chunkId = randomUUID();
        chunkIds.push(chunkId);

        // Dedup check
        const dedupMemoryId = await findDedupMemory(qdrant, memoryCollection, vector);

        // Cross-reference: find memories created during this chunk's time window
        let relatedMemoryIds = [];
        if (chunk.startTimestamp && chunk.endTimestamp) {
          relatedMemoryIds = await findRelatedMemories(
            qdrant, memoryCollection,
            chunk.startTimestamp, chunk.endTimestamp,
            sessionMeta.project
          );
        }

        const payload = {
          content: chunk.content,
          summary: chunk.summary,
          session_id: sessionMeta.sessionId,
          project: sessionMeta.project,
          git_branch: sessionMeta.gitBranch,
          cwd: sessionMeta.cwd,
          chunk_index: chunk.chunkIndex,
          start_timestamp: chunk.startTimestamp,
          end_timestamp: chunk.endTimestamp,
          tools_used: chunk.toolsUsed,
          files_modified: chunk.filesModified,
          files_read: chunk.filesRead,
          user_messages: chunk.userMessages,
          turn_count: chunk.turnCount,
          related_memory_ids: relatedMemoryIds,
          dedup_memory_id: dedupMemoryId,
          indexed_at: new Date().toISOString(),
        };

        points.push({ id: chunkId, vector, payload });
      }

      // Step 5: Upsert to Qdrant
      emit({ type: 'indexing:session-progress', sessionId: session.sessionId, phase: 'upserting' });
      for (let i = 0; i < points.length; i += QDRANT_UPSERT_BATCH_SIZE) {
        const batch = points.slice(i, i + QDRANT_UPSERT_BATCH_SIZE);
        await withRetry(() => qdrant.upsert(SESSION_COLLECTION, {
          points: batch.map(p => ({
            id: p.id,
            vector: p.vector,
            payload: p.payload,
          })),
        }));
      }

      // Step 6: Mirror chunks to claude_memory as conversations category
      emit({ type: 'indexing:session-progress', sessionId: session.sessionId, phase: 'mirroring' });
      const mirrorPoints = [];
      for (const point of points) {
        // Skip chunks that are near-duplicates of existing memories
        if (point.payload.dedup_memory_id) continue;

        const chunk = point.payload;
        const mirrorPayload = {
          content: chunk.content,
          category: 'conversations',
          subcategory: 'session-chunk',
          project: chunk.project || 'global',
          tags: [
            'session-index',
            ...(chunk.git_branch ? [`branch:${chunk.git_branch}`] : []),
            ...(chunk.tools_used || []).slice(0, 3),
          ],
          importance: 3,
          source: 'auto-saved',
          created_at: chunk.start_timestamp || new Date().toISOString(),
          updated_at: chunk.indexed_at,
          accessed_at: chunk.indexed_at,
          access_count: 0,
          related_files: (chunk.files_modified || []).slice(0, 20),
          related_memory_ids: chunk.related_memory_ids || [],
          source_session_chunks: [{ session_id: chunk.session_id, chunk_id: point.id }],
        };

        mirrorPoints.push({ id: point.id, vector: point.vector, payload: mirrorPayload });
      }

      if (mirrorPoints.length > 0) {
        for (let i = 0; i < mirrorPoints.length; i += QDRANT_UPSERT_BATCH_SIZE) {
          const batch = mirrorPoints.slice(i, i + QDRANT_UPSERT_BATCH_SIZE);
          await withRetry(() => qdrant.upsert(memoryCollection, {
            points: batch.map(p => ({
              id: p.id,
              vector: p.vector,
              payload: p.payload,
            })),
          }));
        }
      }

      // Step 7: Backlink memories (fire-and-forget style — don't block on failures)
      for (const point of points) {
        const { related_memory_ids } = point.payload;
        for (const memId of related_memory_ids) {
          backlinkMemory(qdrant, memoryCollection, memId, sessionMeta.sessionId, point.id)
            .catch(() => {}); // fire-and-forget
        }
      }

      // Step 8: Update state
      totalChunks += chunks.length;
      state.sessions[session.sessionId] = {
        session_id: session.sessionId,
        file_path: session.filePath,
        file_size: session.fileSize,
        file_mtime: session.fileMtime,
        chunk_count: chunks.length,
        chunk_ids: chunkIds,
        indexed_at: new Date().toISOString(),
        project: sessionMeta.project,
        status: 'complete',
        last_line_indexed: lineCount,
      };
      saveState(state);

      emit({ type: 'indexing:session-complete', sessionId: session.sessionId, chunkCount: chunks.length, sessionIndex: si, totalSessions });

    } catch (err) {
      errors++;
      state.sessions[session.sessionId] = {
        ...state.sessions[session.sessionId],
        session_id: session.sessionId,
        file_path: session.filePath,
        file_size: session.fileSize,
        file_mtime: session.fileMtime,
        status: 'partial',
        indexed_at: new Date().toISOString(),
        project: detectProjectFromDir(session.projectDir),
      };
      saveState(state);
      emit({ type: 'indexing:error', sessionId: session.sessionId, error: err.message });
    }
  }

  // Update last_run metadata
  state.last_run = {
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    total_sessions: totalSessions,
    total_chunks: totalChunks,
    errors,
  };
  saveState(state);

  emit({ type: 'indexing:complete', totalSessions, totalChunks, errors, durationMs: Date.now() - new Date(startedAt).getTime() });

  return { totalSessions, totalChunks, errors };
}

/**
 * One-time migration: copy existing session_chunks into claude_memory as conversations.
 * Uses vectors already stored in Qdrant — no re-embedding needed.
 * Skips chunks that already exist in claude_memory (same UUID) or have dedup_memory_id.
 * @param {function} [onProgress] - Progress callback
 * @returns {Promise<{ mirrored: number, skipped: number, errors: number }>}
 */
export async function mirrorExistingChunks(onProgress) {
  const emit = onProgress || (() => {});
  const env = loadEnvConfig();
  const qdrantConfig = getQdrantConfig(env);
  const qdrant = new QdrantClient({ url: qdrantConfig.url, apiKey: qdrantConfig.apiKey });
  const memoryCollection = qdrantConfig.collection;

  let mirrored = 0;
  let skipped = 0;
  let errors = 0;
  let offset = null;
  let batch = 0;

  emit({ type: 'mirror:started' });

  // Scroll through all session_chunks with vectors
  while (true) {
    const result = await qdrant.scroll(SESSION_COLLECTION, {
      limit: 50,
      with_payload: true,
      with_vector: true,
      offset: offset ?? undefined,
    });

    if (result.points.length === 0) break;

    const mirrorPoints = [];

    for (const point of result.points) {
      const chunk = point.payload;

      // Skip if dedup (already has a near-identical memory)
      if (chunk.dedup_memory_id) {
        skipped++;
        continue;
      }

      // Check if already mirrored (same ID exists in claude_memory)
      try {
        const existing = await qdrant.retrieve(memoryCollection, {
          ids: [String(point.id)],
          with_payload: false,
          with_vector: false,
        });
        if (existing.length > 0) {
          skipped++;
          continue;
        }
      } catch { /* doesn't exist — good, mirror it */ }

      const mirrorPayload = {
        content: chunk.content,
        category: 'conversations',
        subcategory: 'session-chunk',
        project: chunk.project || 'global',
        tags: [
          'session-index',
          ...(chunk.git_branch ? [`branch:${chunk.git_branch}`] : []),
          ...((chunk.tools_used || []).slice(0, 3)),
        ],
        importance: 3,
        source: 'auto-saved',
        created_at: chunk.start_timestamp || new Date().toISOString(),
        updated_at: chunk.indexed_at || new Date().toISOString(),
        accessed_at: chunk.indexed_at || new Date().toISOString(),
        access_count: 0,
        related_files: (chunk.files_modified || []).slice(0, 20),
        related_memory_ids: chunk.related_memory_ids || [],
        source_session_chunks: [{ session_id: chunk.session_id, chunk_id: String(point.id) }],
      };

      mirrorPoints.push({
        id: String(point.id),
        vector: point.vector,
        payload: mirrorPayload,
      });
    }

    // Batch upsert to claude_memory
    if (mirrorPoints.length > 0) {
      try {
        await withRetry(() => qdrant.upsert(memoryCollection, {
          points: mirrorPoints.map(p => ({
            id: p.id,
            vector: p.vector,
            payload: p.payload,
          })),
        }));
        mirrored += mirrorPoints.length;
      } catch (err) {
        errors += mirrorPoints.length;
        emit({ type: 'mirror:error', error: err.message, batch });
      }
    }

    batch++;
    emit({ type: 'mirror:progress', mirrored, skipped, errors, batch });

    // Next page
    offset = result.next_page_offset ?? null;
    if (offset === null) break;
  }

  emit({ type: 'mirror:complete', mirrored, skipped, errors });
  return { mirrored, skipped, errors };
}

/**
 * Get current indexing status.
 */
export function getIndexingStatus() {
  const state = loadState();
  const indexed = Object.values(state.sessions).filter(s => s.status === 'complete');
  return {
    indexedSessions: indexed.length,
    totalChunks: indexed.reduce((sum, s) => sum + (s.chunk_count || 0), 0),
    lastRun: state.last_run || null,
    indexedSessionIds: new Set(indexed.map(s => s.session_id)),
  };
}
