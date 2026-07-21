/**
 * Shared utilities for SynaBun Claude Code hooks.
 *
 * Extracted to avoid duplication across session-start, prompt-submit,
 * post-remember, pre-compact, and stop hooks.
 */

import { readFileSync, existsSync, writeFileSync, readdirSync, unlinkSync, appendFileSync, mkdirSync, statSync, renameSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { dirname, join, basename, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDataHome } from '../../lib/paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_HOME = getDataHome();
export const DATA_DIR = join(DATA_HOME, 'data');
export const MCP_DATA_DIR = join(DATA_HOME, 'mcp-data');
export const ENV_PATH = join(DATA_HOME, '.env');
export const HOOK_FEATURES_PATH = join(DATA_DIR, 'hook-features.json');
export const PENDING_REMEMBER_DIR = join(DATA_DIR, 'pending-remember');
export const LOOP_LOG_DIR = join(DATA_DIR, 'logs');

// --- Loop logging (mirrors neural-interface/lib/loop-logger.js) ---
// Writes per-loop entries from inside hooks into the same logfile the server uses.

let _loopLogDirEnsured = false;
function ensureLoopLogDir() {
  if (_loopLogDirEnsured) return;
  try {
    if (!existsSync(LOOP_LOG_DIR)) mkdirSync(LOOP_LOG_DIR, { recursive: true });
    _loopLogDirEnsured = true;
  } catch { /* ok */ }
}

function safeJsonInline(obj) {
  try {
    return JSON.stringify(obj, (_k, v) => {
      if (typeof v === 'string' && v.length > 800) return v.slice(0, 800) + `…(+${v.length - 800})`;
      return v;
    });
  } catch { return '<unserializable>'; }
}

/**
 * Append a line to a logfile, rotating it once if it exceeds maxBytes.
 * Hook debug logs (compact-debug.log, user-learning-debug.log, …) were plain
 * appendFileSync with no bound and grew to tens of MB. This keeps one `.1`
 * backup and starts fresh, capping on-disk size at ~2x maxBytes.
 */
export function appendCapped(filePath, line, maxBytes = 10 * 1024 * 1024) {
  try {
    if (existsSync(filePath) && statSync(filePath).size > maxBytes) {
      try { renameSync(filePath, filePath + '.1'); } catch { /* fall through to append */ }
    }
  } catch { /* stat failed — just append */ }
  try { appendFileSync(filePath, line); } catch { /* best effort */ }
}

/**
 * Delete pending-remember flag files older than maxAgeDays. These per-session
 * flags are created on first user message and never deleted, so they pile up
 * (hundreds of stale files). Safe to sweep by mtime — a live session rewrites
 * its flag on every message, keeping mtime fresh.
 */
export function cleanupStalePendingRemember(maxAgeDays = 30) {
  let deleted = 0;
  try {
    if (!existsSync(PENDING_REMEMBER_DIR)) return { deleted };
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    for (const f of readdirSync(PENDING_REMEMBER_DIR)) {
      if (!f.endsWith('.json')) continue;
      const fp = join(PENDING_REMEMBER_DIR, f);
      try {
        if (statSync(fp).mtimeMs < cutoff) { unlinkSync(fp); deleted++; }
      } catch { /* skip racing/unreadable */ }
    }
  } catch { /* ok */ }
  return { deleted };
}

/**
 * Append one log entry to the per-loop logfile and stderr.
 * tsid may be null/undefined; will fall back to SYNABUN_TERMINAL_SESSION env.
 */
export function appendLoopLog(tsid, tag, msg, meta = undefined) {
  const sid = tsid || process.env.SYNABUN_TERMINAL_SESSION || null;
  const line = `${new Date().toISOString()} | hook:${tag} | ${msg}${meta ? ' | ' + safeJsonInline(meta) : ''}\n`;
  try { process.stderr.write(`[loop:hook:${tag}] ${msg}${meta ? ' ' + safeJsonInline(meta) : ''}\n`); } catch { /* ok */ }
  if (!sid) return;
  ensureLoopLogDir();
  try {
    appendFileSync(pathResolve(LOOP_LOG_DIR, `loop-${sid}.log`), line);
  } catch { /* ok */ }
}

// --- Stdin ---

export function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('{}');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data || '{}'), 2000);
  });
}

// --- Transcript reading (session-scoped plan storage) ---

const CLAUDE_PROJECTS_DIR = join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'projects');

/**
 * Convert a cwd to Claude Code's transcript project-dir key.
 * Claude Code replaces every non-alphanumeric char with a hyphen, so
 * /Users/foo/Apps/Synabun → -Users-foo-Apps-Synabun.
 */
function cwdToProjectKey(cwd) {
  if (!cwd) return '';
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Resolve a readable transcript path for a session. Prefers the explicit
 * transcriptPath from the hook input; falls back to deriving it from
 * sessionId + cwd, then to scanning ~/.claude/projects/ for <sessionId>.jsonl
 * (covers sessions that cd'd into a subdir after launch).
 *
 * Returns an absolute path or null. Never guesses across sessions — the
 * returned transcript belongs to exactly the requested sessionId.
 */
export function resolveTranscriptPath(transcriptPath, sessionId, cwd) {
  try {
    if (transcriptPath && existsSync(transcriptPath)) return transcriptPath;
  } catch { /* fall through */ }

  if (!sessionId) return null;

  // Fast path: derive ~/.claude/projects/<key>/<sessionId>.jsonl from cwd.
  try {
    const key = cwdToProjectKey(cwd);
    if (key) {
      const derived = join(CLAUDE_PROJECTS_DIR, key, `${sessionId}.jsonl`);
      if (existsSync(derived)) return derived;
    }
  } catch { /* fall through */ }

  // Robust path: scan every project dir for <sessionId>.jsonl.
  try {
    if (existsSync(CLAUDE_PROJECTS_DIR)) {
      for (const dir of readdirSync(CLAUDE_PROJECTS_DIR)) {
        const candidate = join(CLAUDE_PROJECTS_DIR, dir, `${sessionId}.jsonl`);
        try { if (existsSync(candidate)) return candidate; } catch { /* skip */ }
      }
    }
  } catch { /* ok */ }

  return null;
}

/**
 * Read up to maxBytes from the END of a file as UTF-8. Bounded so a multi-MB
 * transcript never blows the Stop hook's short timeout. The first line of the
 * returned slice may be truncated — callers must tolerate unparseable lines.
 */
function readFileTail(filePath, maxBytes = 512 * 1024) {
  let fd = null;
  try {
    fd = openSync(filePath, 'r');
    const size = fstatSync(fd).size;
    const readBytes = Math.min(size, maxBytes);
    if (readBytes <= 0) return '';
    const start = size - readBytes;
    const buf = Buffer.allocUnsafe(readBytes);
    readSync(fd, buf, 0, readBytes, start);
    return buf.toString('utf-8');
  } catch {
    return '';
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ok */ } }
  }
}

/**
 * Scan a session transcript for the LAST ExitPlanMode tool_use and return its
 * authoritative plan payload. Because the transcript belongs to exactly one
 * session, this is session-scoped by construction — it can never surface
 * another session's plan (the root cause of the cross-session leak).
 *
 * Returns { plan, planFilePath, slug } or null when the session has no
 * ExitPlanMode (i.e. it never exited plan mode).
 */
export function readLastExitPlanMode(transcriptPath) {
  if (!transcriptPath) return null;
  const tail = readFileTail(transcriptPath);
  if (!tail) return null;

  const lines = tail.split('\n');
  // Walk backwards: the first ExitPlanMode found = the LAST in the file,
  // which is the final approved plan when a session re-plans.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.indexOf('ExitPlanMode') === -1) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && block.type === 'tool_use' && block.name === 'ExitPlanMode') {
        const input = block.input || {};
        return {
          plan: typeof input.plan === 'string' ? input.plan : '',
          planFilePath: typeof input.planFilePath === 'string' ? input.planFilePath : '',
          slug: typeof entry.slug === 'string' ? entry.slug : '',
        };
      }
    }
  }
  return null;
}

// --- Hook features ---

export function getHookFeatures() {
  try {
    if (!existsSync(HOOK_FEATURES_PATH)) return {};
    return JSON.parse(readFileSync(HOOK_FEATURES_PATH, 'utf-8'));
  } catch { return {}; }
}

// --- Memory recall (shared by prompt-submit and subagent-start hooks) ---

function formatMemoryAge(isoDate) {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? '1 month ago' : `${months} months ago`;
}

/**
 * Fetch relevant memories from the Neural Interface server and format them
 * into the `=== SynaBun: Related Memories ===` block used for additionalContext.
 *
 * @param {object} opts
 * @param {string} opts.query    Text to search memories with.
 * @param {string} [opts.project] Resolved project label (omit/'global' searches globally).
 * @param {number} [opts.limit]  Max results (default 3).
 * @param {number} [opts.minScore] Minimum cosine score (default 0.4).
 * @param {number} [opts.timeoutMs] Fetch timeout (default 1500).
 * @returns {Promise<string>} Formatted block, or '' when nothing relevant / NI down.
 */
export async function recallMemories({ query, project, limit = 3, minScore = 0.4, timeoutMs = 1500 } = {}) {
  const trimmed = (query || '').trim();
  if (!trimmed) return '';
  try {
    const niUrl = process.env.SYNABUN_NI_URL || 'http://localhost:3344';
    const resp = await fetch(`${niUrl}/api/hook-recall`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: trimmed,
        project: project && project !== 'global' ? project : undefined,
        limit,
        min_score: minScore,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!resp.ok) return '';
    const data = await resp.json();
    if (!data.results || data.results.length === 0) return '';

    const lines = data.results.map((r, i) => {
      const score = (r.score * 100).toFixed(0);
      const age = formatMemoryAge(r.created_at);
      const tags = r.tags?.length ? r.tags.join(', ') : 'none';
      const files = r.related_files?.length ? r.related_files.slice(0, 3).join(', ') : 'none';
      return `${i + 1}. [${r.category} | importance ${r.importance}, ${age}, ${score}% match] ${r.content}\n   Tags: ${tags} | Files: ${files}`;
    });

    return [
      '=== SynaBun: Related Memories ===',
      ...lines,
      'These memories may be relevant. Use as context — call recall for deeper search if needed.',
      '=== End Memories ===',
    ].join('\n');
  } catch {
    // NI down, timeout, or error — silently skip
    return '';
  }
}

// --- Environment / connection ---

function parseEnvFile(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const vars = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
    return vars;
  } catch { return {}; }
}

export function getActiveConnectionId() {
  const vars = parseEnvFile(ENV_PATH);
  return vars.SYNABUN_ACTIVE_CONNECTION || vars.QDRANT_ACTIVE || 'default';
}

export function getCategoriesPath() {
  const connId = getActiveConnectionId();
  return join(MCP_DATA_DIR, `custom-categories-${connId}.json`);
}

/**
 * Returns the path to the MCP server's categories file (no connection suffix).
 * This is the file the MCP server watches — hooks that need the MCP server to
 * pick up changes (e.g., schema refresh) MUST write to this file.
 */
export function getMcpCategoriesPath() {
  return join(MCP_DATA_DIR, 'custom-categories.json');
}

// --- Project detection (reads from claude-code-projects.json) ---

const PROJECTS_PATH = join(DATA_DIR, 'claude-code-projects.json');

export function loadRegisteredProjects() {
  try {
    if (!existsSync(PROJECTS_PATH)) return [];
    return JSON.parse(readFileSync(PROJECTS_PATH, 'utf-8'));
  } catch { return []; }
}

export function normalizeLabel(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function detectProject(cwd) {
  if (!cwd) return 'global';
  const lower = cwd.toLowerCase().replace(/\\/g, '/');
  const projects = loadRegisteredProjects();

  // Sort by path length descending — most specific match wins
  const sorted = projects
    .map((p) => ({
      path: p.path.toLowerCase().replace(/\\/g, '/'),
      label: normalizeLabel(p.label),
    }))
    .sort((a, b) => b.path.length - a.path.length);

  // 1. Exact path prefix match (cwd is inside a registered project)
  for (const p of sorted) {
    if (lower.startsWith(p.path + '/') || lower === p.path) return p.label;
  }

  // 2. Substring match — cwd folder name contains a registered project's folder name
  //    e.g. "SynabunDocs" contains "synabun" → matches the Synabun project
  for (const p of sorted) {
    const projFolder = basename(p.path).toLowerCase();
    if (lower.includes(projFolder)) return p.label;
  }

  // 3. Fallback to directory basename
  const base = basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return base || 'global';
}

// --- Category tree ---

export function loadCategories() {
  try {
    const data = JSON.parse(readFileSync(getCategoriesPath(), 'utf-8'));
    if (data.version === 1 && Array.isArray(data.categories)) {
      return data.categories;
    }
  } catch { /* no categories available */ }
  return [];
}

export function buildCategoryTree(categories) {
  if (!categories || categories.length === 0) {
    return '(No categories defined yet. Use category_create to set up your first category.)';
  }

  const parents = categories.filter((c) => c.is_parent);
  const children = categories.filter((c) => c.parent);
  const standalone = categories.filter((c) => !c.is_parent && !c.parent);

  const lines = [];

  for (const parent of parents) {
    const kids = children.filter((c) => c.parent === parent.name);
    lines.push(`${parent.name} (PARENT) — ${parent.description}`);
    for (const kid of kids) {
      lines.push(`  └─ ${kid.name} — ${kid.description}`);
    }
    if (kids.length === 0) {
      lines.push(`  (no children yet)`);
    }
  }

  if (standalone.length > 0) {
    for (const cat of standalone) {
      lines.push(`${cat.name} — ${cat.description}`);
    }
  }

  return lines.join('\n');
}

// --- Auto-category creation ---

/**
 * Standalone categories required by hooks. Always created regardless of projects.
 */
const STANDALONE_DEFAULTS = [
  { name: 'conversations', description: 'Session summaries and conversation indexing' },
  { name: 'communication-style', description: 'User communication patterns and preferences' },
  { name: 'plans', description: 'Implementation plans stored after plan mode approval', is_parent: true, color: '#06d6a0' },
];

/**
 * Default child categories for every registered project.
 * Created under a project parent, never standalone.
 */
const PROJECT_CHILDREN = [
  { suffix: 'project', description: 'General project knowledge, decisions, and milestones' },
  { suffix: 'architecture', description: 'System design, tech stack, data flow, and component architecture' },
  { suffix: 'bugs', description: 'Bug fixes, debugging sessions, and known issues' },
  { suffix: 'config', description: 'Configuration, deployment, environment, and infrastructure' },
];

/**
 * Ensure all registered projects have a parent category with default children,
 * and that standalone hook-required categories exist.
 *
 * Writes to the MCP server's categories file (no connection suffix) so the
 * MCP server's file watcher picks up changes and refreshes tool schemas.
 *
 * Idempotent: only adds missing categories, never modifies or removes existing ones.
 *
 * @returns {{ created: string[], total: number }}
 */
export function ensureProjectCategories() {
  const projects = loadRegisteredProjects();
  const catPath = getMcpCategoriesPath();

  let data;
  try {
    data = JSON.parse(readFileSync(catPath, 'utf-8'));
  } catch {
    data = { version: 1, categories: [] };
  }

  const categories = data.categories || [];
  const existingNames = new Set(categories.map((c) => c.name));
  const created = [];
  const now = new Date().toISOString();

  // 1. Ensure standalone defaults exist
  for (const def of STANDALONE_DEFAULTS) {
    if (!existingNames.has(def.name)) {
      const cat = { name: def.name, description: def.description, created_at: now };
      if (def.is_parent) cat.is_parent = true;
      if (def.color) cat.color = def.color;
      categories.push(cat);
      existingNames.add(def.name);
      created.push(def.name);
    }
  }

  // 2. Ensure project parents + children exist
  for (const proj of projects) {
    let label = normalizeLabel(proj.label);
    // Truncate to 16 chars so children stay within 30-char limit (16 + 1 + 12 = 29)
    if (label.length > 16) label = label.slice(0, 16).replace(/-$/, '');

    // Ensure parent exists
    if (!existingNames.has(label)) {
      categories.push({
        name: label,
        description: `Knowledge and context for the ${proj.label} project`,
        is_parent: true,
        created_at: now,
      });
      existingNames.add(label);
      created.push(label);
    } else {
      // Parent exists — ensure it has is_parent flag
      const existing = categories.find((c) => c.name === label);
      if (existing && !existing.is_parent) existing.is_parent = true;
    }

    // Ensure each default child exists
    for (const child of PROJECT_CHILDREN) {
      const childName = `${label}-${child.suffix}`;
      if (!existingNames.has(childName)) {
        categories.push({
          name: childName,
          description: `${child.description} for ${proj.label}`,
          parent: label,
          created_at: now,
        });
        existingNames.add(childName);
        created.push(childName);
      }
    }
  }

  // Only write if we created something new
  if (created.length > 0) {
    data.categories = categories;
    writeFileSync(catPath, JSON.stringify(data, null, 2), 'utf-8');
  }

  return { created, total: categories.length };
}

/**
 * Build the full category reference block for lazy injection.
 * Includes tree, available names, selection rules, project scoping, and tool notes.
 */
export function buildCategoryReference(categories, project) {
  const tree = buildCategoryTree(categories);
  const names = categories.map((c) => c.name).join(', ');

  return [
    `## SynaBun Category Reference`,
    ``,
    `### Project: ${project}`,
    ``,
    tree,
    ``,
    `Available names: ${names || '(none)'}`,
    ``,
    `### Category Selection`,
    ``,
    `1. Match existing child category by description → use it.`,
    `2. No child fits but parent does → \`category_create\` new child under that parent → use it.`,
    `3. No parent fits → \`category_create\` new parent + child → use it.`,
    `4. Uncertain → \`AskUserQuestion\` with 2-3 options + "Create new category" → use what user picks.`,
    ``,
    `NEVER guess. NEVER use parent directly. NEVER skip categorization.`,
    ``,
    `### Project Scoping`,
    ``,
    `- Project-specific (bugs, architecture, config) → "${project}"`,
    `- Universal (language features, library APIs) → "global"`,
    `- Cross-project (shared infra) → "shared"`,
  ].join('\n');
}

// --- Loop staleness cleanup ---

const LOOP_STALE_INACTIVITY_MS = 45 * 60 * 1000; // 45 min — browser iterations can be long

/**
 * Scan loop directory and delete stale/inactive loop files.
 * No history keeping — ended loops are removed immediately.
 *
 * A loop is stale if:
 * 1. active + exceeded its maxMinutes + 5min grace
 * 2. active + no iteration activity for 10 minutes (session died)
 *
 * @param {string} loopDir - path to data/loop/
 * @returns {{ deactivated: string[], deleted: string[] }}
 */
export function cleanupStaleLoops(loopDir) {
  const deactivated = [];
  const deleted = [];
  if (!existsSync(loopDir)) return { deactivated, deleted };

  const now = Date.now();
  try {
    const files = readdirSync(loopDir).filter(f => f.endsWith('.json') && !f.startsWith('pending-') && f !== 'active-pointer.json');
    for (const f of files) {
      const fp = join(loopDir, f);
      try {
        const loop = JSON.parse(readFileSync(fp, 'utf-8'));

        if (loop.active) {
          const lastActivity = new Date(loop.lastIterationAt || loop.startedAt || 0).getTime();
          const noRecentActivity = (now - lastActivity) >= LOOP_STALE_INACTIVITY_MS;

          if (noRecentActivity) {
            // Stale loop (no activity for 45 min) — delete immediately
            try { unlinkSync(fp); deleted.push(f); } catch { /* ok */ }
          }
        } else {
          // Inactive loop — delete immediately (no history keeping)
          try { unlinkSync(fp); deleted.push(f); } catch { /* ok */ }
        }
      } catch { /* skip corrupt files */ }
    }
  } catch { /* ok */ }

  // Drop active-pointer.json if its target flag no longer exists
  try {
    const ptrPath = join(loopDir, 'active-pointer.json');
    if (existsSync(ptrPath)) {
      const ptr = JSON.parse(readFileSync(ptrPath, 'utf-8'));
      const targetPath = ptr?.sessionId ? join(loopDir, `${ptr.sessionId}.json`) : null;
      if (!targetPath || !existsSync(targetPath)) {
        try { unlinkSync(ptrPath); } catch { /* ok */ }
      }
    }
  } catch { /* ok */ }

  // Delete stale pending-*.json files (client never claimed them)
  try {
    const pendingFiles = readdirSync(loopDir)
      .filter(f => f.startsWith('pending-') && f.endsWith('.json'));
    for (const f of pendingFiles) {
      const fp = join(loopDir, f);
      try {
        const loop = JSON.parse(readFileSync(fp, 'utf-8'));
        const lastActivity = new Date(loop.lastIterationAt || loop.startedAt || 0).getTime();
        if ((now - lastActivity) >= LOOP_STALE_INACTIVITY_MS) {
          try { unlinkSync(fp); deleted.push(f); } catch { /* ok */ }
        }
      } catch { /* skip corrupt */ }
    }
  } catch { /* ok */ }

  return { deactivated, deleted };
}
