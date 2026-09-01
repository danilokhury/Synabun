import { existsSync, statSync } from 'node:fs';
import { resolve, sep, win32 as pathWin32 } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const CODEX_RESUME_SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer'];

function comparablePath(value) {
  const normalized = resolve(String(value || ''));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function samePath(left, right, { platform = process.platform } = {}) {
  if (!left || !right) return false;
  const normalize = (value) => {
    const normalized = platform === 'win32'
      ? pathWin32.resolve(String(value || ''))
      : resolve(String(value || ''));
    return platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

export function pathIsWithin(candidate, root) {
  if (!candidate || !root) return false;
  const child = comparablePath(candidate);
  const parent = comparablePath(root);
  return child === parent || child.startsWith(parent + sep);
}

function timestampMs(primaryMs, fallbackSeconds) {
  const ms = Number(primaryMs);
  if (Number.isFinite(ms) && ms > 0) return ms;
  if (typeof primaryMs === 'string') {
    const parsed = Date.parse(primaryMs);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const seconds = Number(fallbackSeconds);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  if (typeof fallbackSeconds === 'string') {
    const parsed = Date.parse(fallbackSeconds);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function accountLabel(account) {
  return account?.label || account?.email || (account?.id === 'default' ? 'Default' : 'Account');
}

function selectColumn(columns, name, fallback = "''") {
  return `${columns.has(name) ? `\"${name}\"` : fallback} AS \"${name}\"`;
}

function existingRollout(path) {
  if (!path || !existsSync(path)) return null;
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

function projectForCwd(cwd, projects) {
  if (!cwd) return null;
  return [...projects]
    .filter((project) => project?.path && pathIsWithin(cwd, project.path))
    .sort((a, b) => comparablePath(b.path).length - comparablePath(a.path).length)[0] || null;
}

function rowToSession(row, account, projects, rolloutStat) {
  if (!row?.id) return null;
  const createdAt = timestampMs(row.created_at_ms, row.created_at);
  const updatedAt = timestampMs(
    row.recency_at_ms || row.updated_at_ms,
    row.recency_at || row.updated_at,
  ) || createdAt;
  const firstPrompt = String(row.title || row.preview || row.first_user_message || '').trim();
  const preview = String(row.preview || row.first_user_message || row.title || '').trim();
  const project = projectForCwd(row.cwd, projects);
  return {
    id: String(row.id),
    sessionId: String(row.id),
    name: firstPrompt,
    title: firstPrompt,
    firstPrompt,
    preview,
    source: row.source || row.thread_source || 'unknown',
    cwd: row.cwd || '',
    projectPath: project?.path || null,
    projectLabel: project?.label || (project?.path ? String(project.path).split(/[\\/]/).pop() : null),
    createdAt,
    updatedAt,
    created: createdAt ? new Date(createdAt).toISOString() : null,
    modified: updatedAt ? new Date(updatedAt).toISOString() : null,
    accountId: account.id,
    accountLabel: accountLabel(account),
    model: row.model || '',
    reasoningEffort: row.reasoning_effort || '',
    tokensUsed: Number(row.tokens_used) || 0,
    gitBranch: row.git_branch || null,
    messageCount: 0,
    archived: !!row.archived,
    resumable: !!rolloutStat,
    rolloutPath: row.rollout_path || '',
    fileSize: rolloutStat?.size || 0,
    fileMtime: rolloutStat?.mtime?.toISOString?.() || null,
  };
}

export function listCodexSessionsFromAccount(account, options = {}) {
  if (!account?.id || !account?.home) return [];
  const dbPath = resolve(account.home, 'state_5.sqlite');
  if (!existsSync(dbPath)) return [];

  const projects = Array.isArray(options.projects) ? options.projects : [];
  const sourceKinds = Array.isArray(options.sourceKinds)
    ? options.sourceKinds.map((value) => String(value || '').trim()).filter(Boolean)
    : CODEX_RESUME_SOURCE_KINDS;
  const includeArchived = !!options.includeArchived;
  const includeMissingRollouts = !!options.includeMissingRollouts;
  const cwd = options.cwd ? resolve(String(options.cwd)) : null;
  const maxRows = Math.max(1, Number(options.maxRows) || 10000);

  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const columns = new Set(
      db.prepare('PRAGMA table_info(threads)').all().map((column) => String(column?.name || '')),
    );
    if (!columns.has('id') || !columns.has('rollout_path')) return [];

    const where = [];
    const params = [];
    if (!includeArchived && columns.has('archived')) where.push('archived = 0');
    const sourceColumn = columns.has('source') ? 'source' : (columns.has('thread_source') ? 'thread_source' : '');
    if (sourceKinds.length && sourceColumn) {
      where.push(`\"${sourceColumn}\" IN (${sourceKinds.map(() => '?').join(', ')})`);
      params.push(...sourceKinds);
    }

    const rows = db.prepare(`
      SELECT ${[
        selectColumn(columns, 'id'),
        selectColumn(columns, 'rollout_path'),
        selectColumn(columns, 'title'),
        selectColumn(columns, 'preview'),
        selectColumn(columns, 'first_user_message'),
        selectColumn(columns, 'source'),
        selectColumn(columns, 'thread_source'),
        selectColumn(columns, 'cwd'),
        selectColumn(columns, 'created_at', '0'),
        selectColumn(columns, 'created_at_ms', '0'),
        selectColumn(columns, 'updated_at', '0'),
        selectColumn(columns, 'updated_at_ms', '0'),
        selectColumn(columns, 'recency_at', '0'),
        selectColumn(columns, 'recency_at_ms', '0'),
        selectColumn(columns, 'model'),
        selectColumn(columns, 'reasoning_effort'),
        selectColumn(columns, 'tokens_used', '0'),
        selectColumn(columns, 'git_branch'),
        selectColumn(columns, 'archived', '0'),
        selectColumn(columns, 'agent_path'),
      ].join(', ')}
      FROM threads
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      LIMIT ?
    `).all(...params, maxRows);

    const sessions = [];
    for (const row of rows) {
      if (row.agent_path) continue;
      if (cwd && !pathIsWithin(row.cwd, cwd)) continue;
      const rolloutStat = existingRollout(row.rollout_path);
      if (!rolloutStat && !includeMissingRollouts) continue;
      const session = rowToSession(row, account, projects, rolloutStat);
      if (session) sessions.push(session);
    }
    return sortCodexSessionSummaries(sessions);
  } finally {
    try { db?.close(); } catch {}
  }
}

export function listCodexSessionsFromAccounts(accounts, options = {}) {
  const sessions = [];
  for (const account of (Array.isArray(accounts) ? accounts : [])) {
    try {
      sessions.push(...listCodexSessionsFromAccount(account, options));
    } catch (err) {
      options.onError?.(account, err);
    }
  }
  return mergeCodexSessionSummaries(sessions);
}

export function sortCodexSessionSummaries(sessions) {
  return sessions.sort((a, b) => {
    const bt = timestampMs(b?.updatedAt, 0) || timestampMs(b?.createdAt, 0);
    const at = timestampMs(a?.updatedAt, 0) || timestampMs(a?.createdAt, 0);
    if (bt !== at) return bt - at;
    return String(b?.id || b?.sessionId || '').localeCompare(String(a?.id || a?.sessionId || ''));
  });
}

export function mergeCodexSessionSummaries(...groups) {
  const byKey = new Map();
  for (const group of groups) {
    for (const raw of (Array.isArray(group) ? group : [])) {
      const id = raw?.id || raw?.sessionId;
      if (!id) continue;
      const accountId = raw.accountId || 'default';
      const session = { ...raw, id, sessionId: raw.sessionId || id, accountId };
      const key = `${accountId}:${id}`;
      const previous = byKey.get(key);
      byKey.set(key, previous ? {
        ...previous,
        ...session,
        name: session.name || previous.name,
        title: session.title || previous.title,
        firstPrompt: session.firstPrompt || previous.firstPrompt,
        preview: session.preview || previous.preview,
        cwd: session.cwd || previous.cwd,
        accountLabel: session.accountLabel || previous.accountLabel,
        rolloutPath: session.rolloutPath || previous.rolloutPath,
        resumable: session.resumable ?? previous.resumable,
      } : session);
    }
  }
  return sortCodexSessionSummaries([...byKey.values()]);
}
