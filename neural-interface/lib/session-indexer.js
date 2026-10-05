import { queueMemoryCapture, captureMemoryFileBatch } from './memory-session-capture.js';
/**
 * Session Indexer — Pipeline orchestrator for indexing Claude Code session transcripts.
 * Queues local JSONL files through the shared, incremental memory event intake.
 *
 * Runs in the Neural Interface server process. Uses shared SQLite database + local embeddings
 * via lib/db.js (same memory.db as MCP server, WAL mode for concurrent access).
 */

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync, renameSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { getDataHome } from '../../lib/paths.js';
import { getDb, getMemoryById, memoryVectors } from './db.js';
import { upsertMemory as sharedUpsert } from '../../mcp-server/dist/services/sqlite.js';

const DATA_HOME = getDataHome();
const DATA_DIR = join(DATA_HOME, 'data');
const STATE_FILE = join(DATA_DIR, 'session-index-state.json');

const UPSERT_BATCH_SIZE = 50;

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
  mkdirSync(dirname(STATE_FILE),{recursive:true});
  const temporary=STATE_FILE+'.'+process.pid+'.tmp';
  writeFileSync(temporary, JSON.stringify(state, null, 2));
  renameSync(temporary,STATE_FILE);
}

// --- Project detection ---

// Project detection — uses registered projects from claude-code-projects.json (dynamic, no hardcoded names)

function loadRegisteredProjects() {
  const projectsPath = join(DATA_HOME, 'data', 'claude-code-projects.json');
  try {
    if (existsSync(projectsPath)) {
      return JSON.parse(readFileSync(projectsPath, 'utf-8'));
    }
  } catch { /* ignore */ }
  return [];
}

/** Derive project label from Claude's directory name (e.g. "j--Sites-MyApp" → "myapp") */
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

function upsertMemories(points) {
  const d=getDb(); d.exec('BEGIN IMMEDIATE');
  try { for(const point of points) sharedUpsert(point.id,point.vector,point.payload);d.exec('COMMIT'); }
  catch(error){d.exec('ROLLBACK');memoryVectors.invalidate();throw error;}
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
  const claudeProjectsDir = options.projectsDir || join(homeDir, '.claude', 'projects');

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
        if (stat.size === 0) continue;
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
      // All providers use the same durable event intake and local embedding queue.
      // Preserve this entry point and its UI progress events for Claude hooks.
      queueMemoryCapture({host:'claude-code',sessionId:session.sessionId,filePath:session.filePath,project:detectProjectFromDir(session.projectDir)});
      let complete=false;
      while(!isCancelled?.()) {
        const before=getDb().prepare('SELECT byte_offset,status FROM memory_capture_files WHERE host=? AND session_id=?').get('claude-code',session.sessionId);
        const outcome=await captureMemoryFileBatch({host:'claude-code',sessionId:session.sessionId});
        if(outcome?.busy){await new Promise(resolve=>setTimeout(resolve,20));continue;}
        if(outcome?.paused)break;
        const after=getDb().prepare('SELECT byte_offset,status,error FROM memory_capture_files WHERE host=? AND session_id=?').get('claude-code',session.sessionId);
        if(after?.status==='failed')throw new Error(after.error);
        if(after?.status==='complete'){complete=true;break;}
        if(after?.byte_offset===before?.byte_offset)break; // incomplete JSONL tail
        emit({type:'indexing:session-progress',sessionId:session.sessionId,phase:'indexing'});
      }
      const chunks=getDb().prepare('SELECT chunk_id FROM memory_session_sources WHERE host=? AND session_id=?').all('claude-code',session.sessionId);
      totalChunks+=chunks.length;
      state.sessions[session.sessionId]={session_id:session.sessionId,file_path:session.filePath,file_size:session.fileSize,file_mtime:session.fileMtime,
        chunk_count:chunks.length,chunk_ids:chunks.map(r=>r.chunk_id),indexed_at:new Date().toISOString(),project:detectProjectFromDir(session.projectDir),
        status:complete ? 'complete' : 'partial',last_line_indexed:0};
      saveState(state);
      emit({type:'indexing:session-complete',sessionId:session.sessionId,chunkCount:chunks.length,sessionIndex:si,totalSessions});

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
