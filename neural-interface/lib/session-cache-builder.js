/**
 * Session Cache Builder — populates session_cache + session_fts for
 * Claude Code, Codex CLI, and OpenCode so the Resume surfaces can do
 * full-body keyword search via FTS5.
 *
 * Per-provider rebuilders walk the provider's session storage, extract
 * a stripped user+assistant text blob (capped), and upsert into the
 * shared memory.db. Claude also reuses the existing session_chunks
 * embeddings for semantic re-rank at query time.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import {
  getDb,
  upsertSessionCache,
  upsertSessionFts,
  getSessionCacheEntry,
  listSessionCache,
  markSessionDeleted,
} from './db.js';
import { parseLine } from './session-chunker.js';
import { listCodexSessionsFromAccounts } from './codex-session-catalog.js';

const MAX_BODY = 256 * 1024;
const MAX_MSG_CHARS = 8 * 1024;
const MAX_CLAUDE_FILE = 50 * 1024 * 1024;
const MAX_CODEX_FILE = 50 * 1024 * 1024;

const TAG_RE = /<\/?(?:ide_opened_file|ide_selection|system-reminder|antml:[a-z_]+)[^>]*>[^\n]*/gi;
const GENERIC_TAG_RE = /<\/?[a-z_-]+[^>]*>/gi;
const BLOCK_TAG_RE = /<(system-reminder|ide_opened_file|ide_selection)>[\s\S]*?<\/\1>/gi;

export function stripTags(text) {
  if (!text) return '';
  return String(text)
    .replace(BLOCK_TAG_RE, '')
    .replace(TAG_RE, '')
    .replace(GENERIC_TAG_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function appendBody(current, add) {
  if (!add) return current;
  const clean = stripTags(add);
  if (!clean) return current;
  if (current.length + clean.length + 1 > MAX_BODY) {
    const remaining = MAX_BODY - current.length - 1;
    if (remaining <= 0) return current;
    return current + '\n' + clean.slice(0, remaining);
  }
  return current ? current + '\n' + clean : clean;
}

function shouldSkipInjection(text) {
  if (!text) return true;
  return text.startsWith('<environment_context>')
    || text.startsWith('# AGENTS.md')
    || text.startsWith('<permissions')
    || text.startsWith('<INSTRUCTIONS>')
    || text.startsWith('<system-reminder>');
}

// --- Claude ---

function parseClaudeSession(filePath) {
  let body = '';
  let firstPrompt = '';
  let gitBranch = null;
  let sessionId = basename(filePath, '.jsonl');
  let cwd = null;
  let messageCount = 0;
  let earliest = null;
  let latest = null;

  let stat;
  try { stat = statSync(filePath); } catch { return null; }
  if (stat.size > MAX_CLAUDE_FILE) return null;

  let raw;
  try { raw = readFileSync(filePath, 'utf-8'); } catch { return null; }

  const lines = raw.split('\n');
  for (const rawLine of lines) {
    if (!rawLine.trim()) continue;
    const parsed = parseLine(rawLine);
    if (!parsed) continue;

    if (parsed.sessionId) sessionId = parsed.sessionId;
    if (parsed.gitBranch) gitBranch = parsed.gitBranch;
    if (parsed.cwd) cwd = parsed.cwd;
    if (parsed.timestamp) {
      if (!earliest || parsed.timestamp < earliest) earliest = parsed.timestamp;
      if (!latest || parsed.timestamp > latest) latest = parsed.timestamp;
    }

    const msg = parsed.message;
    if (!msg) continue;

    if (parsed.type === 'user' && !parsed.isMeta && !parsed.toolUseResult && !parsed.sourceToolAssistantUUID) {
      messageCount++;
      const content = msg.content;
      let text = '';
      if (Array.isArray(content)) {
        const parts = content.filter(b => b.type === 'text' && b.text).map(b => b.text);
        text = parts.join(' ');
      } else if (typeof content === 'string') {
        text = content;
      }
      const cleaned = stripTags(text);
      if (cleaned && !shouldSkipInjection(cleaned)) {
        if (!firstPrompt) firstPrompt = cleaned.slice(0, 200);
        body = appendBody(body, cleaned.slice(0, MAX_MSG_CHARS));
      }
    } else if (parsed.type === 'assistant' && msg.content && Array.isArray(msg.content)) {
      messageCount++;
      const parts = msg.content.filter(b => b.type === 'text' && b.text).map(b => b.text);
      const text = parts.join(' ');
      if (text) body = appendBody(body, text.slice(0, MAX_MSG_CHARS));
    }

    if (body.length >= MAX_BODY) break;
  }

  return {
    sessionId,
    firstPrompt,
    gitBranch,
    cwd,
    messageCount,
    body,
    earliest,
    latest,
  };
}

export function rebuildClaudeCache({ project, onProgress } = {}) {
  const emit = onProgress || (() => {});
  const homeDir = process.env.USERPROFILE || process.env.HOME;
  const projectsDir = join(homeDir, '.claude', 'projects');
  if (!existsSync(projectsDir)) return { sessions: 0, updated: 0 };

  let projDirs;
  try {
    projDirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => ({ name: d.name, path: join(projectsDir, d.name) }));
  } catch { return { sessions: 0, updated: 0 }; }

  if (project) {
    const lower = String(project).toLowerCase();
    projDirs = projDirs.filter(d => d.name.toLowerCase().includes(lower));
  }

  let total = 0;
  let updated = 0;

  for (const projDir of projDirs) {
    let files;
    try { files = readdirSync(projDir.path).filter(f => f.endsWith('.jsonl')); } catch { continue; }

    for (const file of files) {
      total++;
      const filePath = join(projDir.path, file);
      let stat;
      try { stat = statSync(filePath); } catch { continue; }
      if (stat.size > MAX_CLAUDE_FILE) continue;

      const sessionId = file.replace('.jsonl', '');
      const existing = getSessionCacheEntry(sessionId, 'claude-code');
      if (existing && existing.file_size === stat.size && existing.file_mtime === stat.mtime.toISOString()) {
        continue;
      }

      const parsed = parseClaudeSession(filePath);
      if (!parsed) continue;

      upsertSessionCache({
        session_id: parsed.sessionId,
        provider: 'claude-code',
        project: projDir.name,
        project_path: parsed.cwd,
        git_branch: parsed.gitBranch,
        first_prompt: parsed.firstPrompt,
        message_count: parsed.messageCount,
        created: parsed.earliest,
        modified: parsed.latest || stat.mtime.toISOString(),
        file_path: filePath,
        file_size: stat.size,
        file_mtime: stat.mtime.toISOString(),
        body_size: parsed.body.length,
        deleted: 0,
      });
      upsertSessionFts({
        session_id: parsed.sessionId,
        provider: 'claude-code',
        project: projDir.name,
        first_prompt: parsed.firstPrompt,
        body: parsed.body,
      });
      updated++;
      emit({ type: 'cache:session', provider: 'claude-code', sessionId: parsed.sessionId, done: updated, total });
    }
  }

  return { sessions: total, updated };
}

// --- Codex ---

function parseCodexSession(filePath) {
  let stat;
  try { stat = statSync(filePath); } catch { return null; }
  if (stat.size > MAX_CODEX_FILE) return null;

  let raw;
  try { raw = readFileSync(filePath, 'utf-8'); } catch { return null; }

  const lines = raw.split('\n');
  if (lines.length === 0) return null;

  let sessionMeta = null;
  try { sessionMeta = JSON.parse(lines[0]); } catch { return null; }
  if (sessionMeta.type !== 'session_meta' || !sessionMeta.payload) return null;

  const p = sessionMeta.payload;
  const sessionId = p.id || basename(filePath, '.jsonl');
  const cwd = p.cwd || null;
  const gitBranch = p.git?.branch || null;
  const created = p.timestamp || null;

  let firstPrompt = '';
  let body = '';
  let messageCount = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }

    const payload = msg.payload || msg;
    const isMessage = msg.type === 'message' || (msg.type === 'response_item' && payload?.type === 'message');
    if (!isMessage) continue;

    const role = payload.role;
    if (role !== 'user' && role !== 'assistant') continue;

    messageCount++;
    const content = payload.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      const parts = content
        .filter(c => c.type === 'input_text' || c.type === 'text' || c.type === 'output_text')
        .map(c => c.text || '');
      text = parts.join(' ');
    }
    if (!text) continue;

    if (role === 'user' && shouldSkipInjection(text)) continue;

    const cleaned = stripTags(text);
    if (!cleaned) continue;

    if (role === 'user' && !firstPrompt) firstPrompt = cleaned.slice(0, 200);
    body = appendBody(body, cleaned.slice(0, MAX_MSG_CHARS));
    if (body.length >= MAX_BODY) break;
  }

  return {
    sessionId,
    firstPrompt,
    gitBranch,
    cwd,
    messageCount,
    body,
    created,
    modified: stat.mtime.toISOString(),
    fileSize: stat.size,
  };
}

export function rebuildCodexCache({ project, projects, accounts, onProgress } = {}) {
  const emit = onProgress || (() => {});
  const homeDir = process.env.USERPROFILE || process.env.HOME;
  const configuredAccounts = Array.isArray(accounts) && accounts.length
    ? accounts
    : [{ id: 'default', label: 'Default', home: join(homeDir, '.codex') }];
  const catalog = listCodexSessionsFromAccounts(configuredAccounts, {
    projects,
    includeArchived: true,
    maxRows: 10000,
  });

  const projLower = project ? String(project).toLowerCase() : null;
  const d = getDb();
  const probeStmt = d.prepare(
    'SELECT session_id, file_size, file_mtime FROM session_cache WHERE file_path = ? AND provider = ?'
  );

  let total = 0;
  let updated = 0;

  const liveSessionIds = new Set();
  for (const session of catalog) {
    const filePath = session.rolloutPath;
    if (!filePath) continue;
    total++;
    let stat;
    try { stat = statSync(filePath); } catch { continue; }

    if (projLower && session.cwd && !session.cwd.toLowerCase().includes(projLower)) continue;
    liveSessionIds.add(session.sessionId);

    const probe = probeStmt.get(filePath, 'codex');
    if (probe && probe.file_size === stat.size && probe.file_mtime === stat.mtime.toISOString()) {
      const cached = getSessionCacheEntry(session.sessionId, 'codex');
      if (cached?.deleted || cached?.account_id !== session.accountId) {
        upsertSessionCache({
          ...cached,
          session_id: session.sessionId,
          provider: 'codex',
          account_id: session.accountId,
          deleted: 0,
        });
      }
      continue;
    }

    const parsed = parseCodexSession(filePath);
    if (!parsed) continue;

    upsertSessionCache({
      session_id: parsed.sessionId,
      provider: 'codex',
      project: session.projectPath ? basename(session.projectPath) : (session.cwd ? basename(session.cwd) : null),
      project_path: session.cwd || parsed.cwd,
      git_branch: session.gitBranch || parsed.gitBranch,
      first_prompt: session.firstPrompt || parsed.firstPrompt,
      message_count: parsed.messageCount,
      created: session.created || parsed.created,
      modified: session.modified || parsed.modified,
      file_path: filePath,
      file_size: parsed.fileSize,
      file_mtime: parsed.modified,
      body_size: parsed.body.length,
      deleted: 0,
      account_id: session.accountId,
    });
    upsertSessionFts({
      session_id: parsed.sessionId,
      provider: 'codex',
      project: session.projectPath ? basename(session.projectPath) : (session.cwd ? basename(session.cwd) : null),
      first_prompt: session.firstPrompt || parsed.firstPrompt,
      body: parsed.body,
    });
    updated++;
    emit({ type: 'cache:session', provider: 'codex', sessionId: parsed.sessionId, done: updated, total });
  }

  if (!project) {
    for (const cached of listSessionCache('codex', { limit: 100000 })) {
      if (!liveSessionIds.has(cached.session_id) && !cached.deleted) {
        markSessionDeleted(cached.session_id, 'codex', true);
      }
    }
  }

  return { sessions: total, updated };
}

// --- OpenCode ---

export function rebuildOpencodeCache({ getOpencodeDb, onProgress } = {}) {
  const emit = onProgress || (() => {});
  if (typeof getOpencodeDb !== 'function') return { sessions: 0, updated: 0 };

  const ocdb = getOpencodeDb();
  if (!ocdb) return { sessions: 0, updated: 0 };

  let sessions;
  try {
    sessions = ocdb.prepare(`
      SELECT s.id, s.title, s.directory, s.time_created, s.time_updated,
             p.worktree AS project_worktree,
             (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS message_count
      FROM session s
      LEFT JOIN project p ON s.project_id = p.id
      WHERE s.time_archived IS NULL
    `).all();
  } catch { return { sessions: 0, updated: 0 }; }

  let total = sessions.length;
  let updated = 0;

  // OpenCode schema: message.data (JSON w/ role+metadata) + part.data (JSON w/ type+text).
  // Pull parts per message, decode JSON, grab text where type === 'text'.
  let partStmt;
  try {
    partStmt = ocdb.prepare(`SELECT p.data AS pdata, m.data AS mdata
                             FROM part p
                             LEFT JOIN message m ON m.id = p.message_id
                             WHERE p.session_id = ?
                             ORDER BY p.time_created ASC`);
  } catch { partStmt = null; }

  for (const row of sessions) {
    const sessionId = row.id;
    const projectPath = row.project_worktree || row.directory || null;

    let body = '';
    let firstPrompt = row.title || '';
    if (partStmt) {
      try {
        const parts = partStmt.all(sessionId);
        for (const p of parts) {
          let text = '';
          let role = null;
          try {
            const pd = p.pdata ? JSON.parse(p.pdata) : null;
            if (pd && pd.type === 'text' && pd.text) text = pd.text;
          } catch { /* skip */ }
          if (!text) continue;
          try {
            const md = p.mdata ? JSON.parse(p.mdata) : null;
            role = md?.role || null;
          } catch { /* skip */ }
          const cleaned = stripTags(text);
          if (!cleaned) continue;
          if (role === 'user' && !firstPrompt) firstPrompt = cleaned.slice(0, 200);
          body = appendBody(body, cleaned.slice(0, MAX_MSG_CHARS));
          if (body.length >= MAX_BODY) break;
        }
      } catch { /* part table schema varies */ }
    }

    const modifiedIso = row.time_updated ? new Date(row.time_updated).toISOString() : null;
    const createdIso = row.time_created ? new Date(row.time_created).toISOString() : null;

    upsertSessionCache({
      session_id: sessionId,
      provider: 'opencode',
      project: projectPath ? basename(projectPath) : null,
      project_path: projectPath,
      git_branch: null,
      first_prompt: firstPrompt,
      message_count: row.message_count || 0,
      created: createdIso,
      modified: modifiedIso,
      file_path: null,
      file_size: null,
      file_mtime: modifiedIso,
      body_size: body.length,
      deleted: 0,
    });
    upsertSessionFts({
      session_id: sessionId,
      provider: 'opencode',
      project: projectPath ? basename(projectPath) : null,
      first_prompt: firstPrompt,
      body,
    });
    updated++;
    emit({ type: 'cache:session', provider: 'opencode', sessionId, done: updated, total });
  }

  return { sessions: total, updated };
}

// --- Single-session refresh (for piggyback from session-indexer) ---

export function updateSessionCacheEntry(provider, sessionId, opts = {}) {
  if (provider === 'claude-code') {
    const filePath = opts.filePath;
    if (!filePath || !existsSync(filePath)) return false;
    let stat;
    try { stat = statSync(filePath); } catch { return false; }
    const parsed = parseClaudeSession(filePath);
    if (!parsed) return false;
    upsertSessionCache({
      session_id: parsed.sessionId,
      provider: 'claude-code',
      project: opts.project || null,
      project_path: parsed.cwd,
      git_branch: parsed.gitBranch,
      first_prompt: parsed.firstPrompt,
      message_count: parsed.messageCount,
      created: parsed.earliest,
      modified: parsed.latest || stat.mtime.toISOString(),
      file_path: filePath,
      file_size: stat.size,
      file_mtime: stat.mtime.toISOString(),
      body_size: parsed.body.length,
      deleted: 0,
    });
    upsertSessionFts({
      session_id: parsed.sessionId,
      provider: 'claude-code',
      project: opts.project || null,
      first_prompt: parsed.firstPrompt,
      body: parsed.body,
    });
    return true;
  }
  return false;
}
