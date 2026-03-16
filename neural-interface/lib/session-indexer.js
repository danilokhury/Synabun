/**
 * Session Indexer — Pipeline orchestrator for indexing Claude Code session transcripts.
 * Reads JSONL files, chunks them, embeds chunks, stores in SQLite, cross-references with memories.
 *
 * Runs in the Neural Interface server process. Uses shared SQLite database + local embeddings
 * via lib/db.js (same memory.db as MCP server, WAL mode for concurrent access).
 */

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chunkSession, parseLine } from './session-chunker.js';
import {
  getDb, getEmbedding, getEmbeddingBatch,
  encodeVector, decodeVector, cosineSimilarity,
  searchMemories, getMemoryById, updateMemoryPayload,
} from './db.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const DATA_DIR = join(PROJECT_ROOT, 'data');
const STATE_FILE = join(DATA_DIR, 'session-index-state.json');

const EMBEDDING_BATCH_SIZE = 20;
const UPSERT_BATCH_SIZE = 50;
const DEDUP_THRESHOLD = 0.92;

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

// Project detection — uses registered projects from claude-code-projects.json (dynamic, no hardcoded names)

function loadRegisteredProjects() {
  const projectsPath = join(resolve(PROJECT_ROOT, 'mcp-server', 'data'), 'claude-code-projects.json');
  try {
    if (existsSync(projectsPath)) {
      return JSON.parse(readFileSync(projectsPath, 'utf-8'));
    }
  } catch { /* ignore */ }
  return [];
}

function detectProject(cwd) {
  if (!cwd) return 'global';
  const lower = cwd.toLowerCase().replace(/\\/g, '/');
  const projects = loadRegisteredProjects();

  // Registered project match (most specific path wins)
  const sorted = projects
    .map(p => ({ path: p.path.toLowerCase().replace(/\\/g, '/'), label: p.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') }))
    .sort((a, b) => b.path.length - a.path.length);

  for (const p of sorted) {
    if (lower.startsWith(p.path + '/') || lower === p.path) return p.label;
  }
  for (const p of sorted) {
    const folder = basename(p.path).toLowerCase();
    if (lower.includes(folder)) return p.label;
  }

  // Fallback to directory basename
  const base = basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return base || 'global';
}

/** Derive project label from Claude's directory name (e.g. "j--Sites-CriticalPixel" → "criticalpixel") */
function detectProjectFromDir(dirName) {
  if (!dirName) return 'global';
  const lower = dirName.toLowerCase();
  const projects = loadRegisteredProjects();

  for (const p of projects) {
    const label = p.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (lower.includes(label)) return label;
  }

  const parts = dirName.split('-').filter(Boolean);
  return (parts[parts.length - 1] || 'global').toLowerCase();
}

// --- Embedding ---

async function embedBatch(texts) {
  if (texts.length === 0) return [];
  return getEmbeddingBatch(texts);
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

function findRelatedMemories(chunkStartTs, chunkEndTs, project) {
  const d = getDb();
  const clauses = ['trashed_at IS NULL'];
  const params = [];

  if (chunkStartTs) {
    clauses.push('created_at >= ?');
    params.push(chunkStartTs);
  }
  if (chunkEndTs) {
    clauses.push('created_at <= ?');
    params.push(chunkEndTs);
  }
  if (project && project !== 'global') {
    clauses.push('project = ?');
    params.push(project);
  }

  const where = clauses.length > 0 ? 'WHERE ' + clauses.join(' AND ') : '';
  const rows = d.prepare(`SELECT id FROM memories ${where} LIMIT 20`).all(...params);
  return rows.map(r => r.id);
}

function findDedupMemory(vector) {
  // Search all non-trashed memories and find near-duplicate by cosine similarity
  const results = searchMemories(vector, 1, { scoreThreshold: DEDUP_THRESHOLD });
  if (results.length > 0) {
    return results[0].id;
  }
  return null;
}

function backlinkMemory(memoryId, sessionId, chunkId) {
  try {
    const mem = getMemoryById(memoryId);
    if (!mem) return;

    const existing = mem.source_session_chunks || [];
    if (existing.some(e => e.chunk_id === chunkId)) return;

    updateMemoryPayload(memoryId, {
      source_session_chunks: [...existing, { session_id: sessionId, chunk_id: chunkId }],
    });
  } catch { /* ignore backlink failures */ }
}

// --- SQLite upsert helpers ---

function upsertSessionChunks(points) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const stmt = d.prepare(`INSERT OR REPLACE INTO session_chunks
      (id, vector, content, summary, session_id, project, git_branch, cwd,
       chunk_index, start_timestamp, end_timestamp, tools_used, files_modified,
       files_read, user_messages, turn_count, related_memory_ids, dedup_memory_id, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    for (const p of points) {
      const pl = p.payload;
      stmt.run(
        p.id, encodeVector(p.vector), pl.content, pl.summary || null,
        pl.session_id || null, pl.project || null, pl.git_branch || null, pl.cwd || null,
        pl.chunk_index ?? 0, pl.start_timestamp || null, pl.end_timestamp || null,
        JSON.stringify(pl.tools_used || []), JSON.stringify(pl.files_modified || []),
        JSON.stringify(pl.files_read || []), JSON.stringify(pl.user_messages || []),
        pl.turn_count ?? 0, JSON.stringify(pl.related_memory_ids || []),
        pl.dedup_memory_id || null, pl.indexed_at || new Date().toISOString()
      );
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

function upsertMemories(points) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const stmt = d.prepare(`INSERT OR REPLACE INTO memories
      (id, vector, content, category, subcategory, project, tags, importance, source,
       created_at, updated_at, accessed_at, access_count, related_files,
       related_memory_ids, source_session_chunks)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    for (const p of points) {
      const pl = p.payload;
      stmt.run(
        p.id, encodeVector(p.vector), pl.content, pl.category, pl.subcategory || null,
        pl.project || 'global', JSON.stringify(pl.tags || []), pl.importance ?? 5,
        pl.source || 'auto-saved', pl.created_at, pl.updated_at, pl.accessed_at,
        pl.access_count ?? 0, JSON.stringify(pl.related_files || []),
        JSON.stringify(pl.related_memory_ids || []),
        JSON.stringify(pl.source_session_chunks || [])
      );
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

// --- Retry helper ---

async function withRetry(fn, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const delay = Math.pow(3, attempt) * 1000;
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

      if (options.sessionIds && !options.sessionIds.includes(sessionId)) continue;

      if (!options.reindex && state.sessions[sessionId]) {
        const entry = state.sessions[sessionId];
        if (entry.status === 'complete') {
          try {
            const stat = statSync(filePath);
            if (stat.size === entry.file_size && stat.mtime.toISOString() === entry.file_mtime) {
              continue;
            }
          } catch { continue; }
        }
      }

      try {
        const stat = statSync(filePath);
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

      // Step 3: Embed chunks (local model — no API key needed)
      emit({ type: 'indexing:session-progress', sessionId: session.sessionId, phase: 'embedding' });
      const contentTexts = chunks.map(c => c.content);
      const vectors = await withRetry(() => embedBatch(contentTexts));

      // Step 4: Dedup check + cross-reference
      emit({ type: 'indexing:session-progress', sessionId: session.sessionId, phase: 'cross-referencing' });
      const chunkIds = [];
      const points = [];

      for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];
        const vector = vectors[ci];
        const chunkId = randomUUID();
        chunkIds.push(chunkId);

        const dedupMemoryId = findDedupMemory(vector);

        let relatedMemoryIds = [];
        if (chunk.startTimestamp && chunk.endTimestamp) {
          relatedMemoryIds = findRelatedMemories(
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

      // Step 5: Upsert to SQLite session_chunks
      emit({ type: 'indexing:session-progress', sessionId: session.sessionId, phase: 'upserting' });
      for (let i = 0; i < points.length; i += UPSERT_BATCH_SIZE) {
        const batch = points.slice(i, i + UPSERT_BATCH_SIZE);
        upsertSessionChunks(batch);
      }

      // Step 6: Mirror chunks to memories as conversations category
      emit({ type: 'indexing:session-progress', sessionId: session.sessionId, phase: 'mirroring' });
      const mirrorPoints = [];
      for (const point of points) {
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
        for (let i = 0; i < mirrorPoints.length; i += UPSERT_BATCH_SIZE) {
          const batch = mirrorPoints.slice(i, i + UPSERT_BATCH_SIZE);
          upsertMemories(batch);
        }
      }

      // Step 7: Backlink memories
      for (const point of points) {
        const { related_memory_ids } = point.payload;
        for (const memId of related_memory_ids) {
          backlinkMemory(memId, sessionMeta.sessionId, point.id);
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
 * One-time migration: copy existing session_chunks into memories as conversations.
 * Uses vectors already stored in SQLite — no re-embedding needed.
 * Skips chunks that already exist in memories (same UUID) or have dedup_memory_id.
 * @param {function} [onProgress] - Progress callback
 * @returns {Promise<{ mirrored: number, skipped: number, errors: number }>}
 */
export async function mirrorExistingChunks(onProgress) {
  const emit = onProgress || (() => {});
  const d = getDb();

  let mirrored = 0;
  let skipped = 0;
  let errors = 0;

  emit({ type: 'mirror:started' });

  // Get all session chunks with vectors
  const rows = d.prepare(`SELECT id, vector, content, summary, session_id, project, git_branch,
    cwd, chunk_index, start_timestamp, end_timestamp, tools_used, files_modified,
    files_read, user_messages, turn_count, related_memory_ids, dedup_memory_id, indexed_at
    FROM session_chunks`).all();

  const mirrorPoints = [];

  for (const row of rows) {
    const dedupMemoryId = row.dedup_memory_id;
    if (dedupMemoryId) {
      skipped++;
      continue;
    }

    // Check if already mirrored
    const existing = getMemoryById(row.id);
    if (existing) {
      skipped++;
      continue;
    }

    const toolsUsed = JSON.parse(row.tools_used || '[]');
    const filesModified = JSON.parse(row.files_modified || '[]');
    const relatedMemoryIds = JSON.parse(row.related_memory_ids || '[]');

    const mirrorPayload = {
      content: row.content,
      category: 'conversations',
      subcategory: 'session-chunk',
      project: row.project || 'global',
      tags: [
        'session-index',
        ...(row.git_branch ? [`branch:${row.git_branch}`] : []),
        ...toolsUsed.slice(0, 3),
      ],
      importance: 3,
      source: 'auto-saved',
      created_at: row.start_timestamp || new Date().toISOString(),
      updated_at: row.indexed_at || new Date().toISOString(),
      accessed_at: row.indexed_at || new Date().toISOString(),
      access_count: 0,
      related_files: filesModified.slice(0, 20),
      related_memory_ids: relatedMemoryIds,
      source_session_chunks: [{ session_id: row.session_id, chunk_id: row.id }],
    };

    mirrorPoints.push({
      id: row.id,
      vector: Array.from(new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4)),
      payload: mirrorPayload,
    });
  }

  // Batch upsert to memories
  if (mirrorPoints.length > 0) {
    try {
      for (let i = 0; i < mirrorPoints.length; i += UPSERT_BATCH_SIZE) {
        const batch = mirrorPoints.slice(i, i + UPSERT_BATCH_SIZE);
        upsertMemories(batch);
        mirrored += batch.length;
        emit({ type: 'mirror:progress', mirrored, skipped, errors, batch: Math.floor(i / UPSERT_BATCH_SIZE) });
      }
    } catch (err) {
      errors += mirrorPoints.length - mirrored;
      emit({ type: 'mirror:error', error: err.message });
    }
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
