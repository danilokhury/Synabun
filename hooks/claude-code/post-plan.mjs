#!/usr/bin/env node

/**
 * SynaBun PostToolUse Hook — Plan Storage
 *
 * Matches: ^ExitPlanMode$
 *
 * When Claude exits plan mode (plan approved), this hook:
 * 1. Finds the most recently modified plan file in ~/.claude/plans/
 * 2. Auto-creates a child category under "plans" for the project if needed
 * 3. Generates a local embedding and stores the plan in SQLite
 * 4. Returns additionalContext confirming storage
 *
 * Input (stdin JSON):
 *   { session_id, tool_name, tool_input, tool_response, cwd }
 *
 * Output (stdout JSON):
 *   { additionalContext: "..." } on success, or {} on skip/error
 */

import { readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { detectProject, getMcpCategoriesPath, MCP_DATA_DIR, DATA_DIR } from './shared.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Debug log (append-only, survives across invocations)
const DEBUG_LOG_PATH = join(DATA_DIR, 'plan-debug.log');
function debugLog(msg) {
  try {
    const ts = new Date().toISOString();
    appendFileSync(DEBUG_LOG_PATH, `[${ts}] ${msg}\n`, 'utf-8');
  } catch { /* best-effort */ }
}

// Plans directory — Claude Code stores plan .md files here
const PLANS_DIR = join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'plans');

// Dedup tracker — records which plan files have already been stored
const STORED_PLANS_PATH = join(DATA_DIR, 'stored-plans.json');

// SQLite database path
const DB_PATH = process.env.SQLITE_DB_PATH || join(MCP_DATA_DIR, 'memory.db');

// ─── Stdin ───

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('{}');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data || '{}'), 3000);
  });
}

// ─── Local embedding generation ───

async function generateEmbedding(text) {
  const embPath = join(__dirname, '..', '..', 'mcp-server', 'dist', 'services', 'local-embeddings.js');
  if (!existsSync(embPath)) {
    throw new Error('MCP server not built. Run: cd mcp-server && npm run build');
  }
  const { generateEmbedding: embed } = await import(pathToFileURL(embPath).href);
  return embed(text);
}

// ─── Vector encoding ───

function encodeVector(vector) {
  const f32 = new Float32Array(vector);
  return new Uint8Array(f32.buffer);
}

// ─── Database storage ───

function storeInSQLite(id, vector, payload) {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');

  try {
    db.prepare(`
      INSERT OR REPLACE INTO memories
        (id, vector, content, category, subcategory, project, tags, importance, source,
         created_at, updated_at, accessed_at, access_count, related_files,
         related_memory_ids, file_checksums, trashed_at, source_session_chunks)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      encodeVector(vector),
      payload.content,
      payload.category,
      payload.subcategory || null,
      payload.project,
      JSON.stringify(payload.tags || []),
      payload.importance || 5,
      payload.source || 'auto-saved',
      payload.created_at,
      payload.updated_at,
      payload.accessed_at,
      payload.access_count || 0,
      null, // related_files
      null, // related_memory_ids
      null, // file_checksums
      null, // trashed_at
      null, // source_session_chunks
    );
  } finally {
    db.close();
  }
}

// ─── Dedup tracker ───

function loadStoredPlans() {
  try {
    if (!existsSync(STORED_PLANS_PATH)) return {};
    return JSON.parse(readFileSync(STORED_PLANS_PATH, 'utf-8'));
  } catch { return {}; }
}

function markPlanStored(fileName, memoryId) {
  const stored = loadStoredPlans();
  stored[fileName] = { memoryId, storedAt: new Date().toISOString() };
  try {
    if (!existsSync(dirname(STORED_PLANS_PATH))) mkdirSync(dirname(STORED_PLANS_PATH), { recursive: true });
    writeFileSync(STORED_PLANS_PATH, JSON.stringify(stored, null, 2), 'utf-8');
  } catch { /* best-effort */ }
}

// ─── Plan file discovery ───

/**
 * List all plan .md files, sorted by mtime descending.
 * Each entry: { name, path, mtime }
 */
function listPlanFiles() {
  if (!existsSync(PLANS_DIR)) return [];
  return readdirSync(PLANS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const fullPath = join(PLANS_DIR, f);
      const stat = statSync(fullPath);
      return { name: f, path: fullPath, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/**
 * Match the correct plan file using tool_response content from ExitPlanMode.
 * Strategies (in order):
 *   1. Filename extraction — tool_response may reference the plan filename
 *   2. Content matching — tool_response may contain the plan text; find the file whose content matches
 * Returns null if no match or if the matched file is already stored.
 */
function findPlanByContent(toolResponse) {
  if (!toolResponse || typeof toolResponse !== 'string') return null;

  const stored = loadStoredPlans();
  const files = listPlanFiles();
  if (files.length === 0) return null;

  // Strategy 1: Extract filename pattern (word-word-word.md) from response
  const fnameMatch = toolResponse.match(/([a-z]+-[a-z]+-[a-z]+\.md)/);
  if (fnameMatch) {
    const matched = files.find((f) => f.name === fnameMatch[1]);
    if (matched && !stored[matched.name]) return { ...matched, method: 'filename' };
  }

  // Strategy 2: Content matching — compare response text against each unstored plan file
  // tool_response from ExitPlanMode likely contains the plan content itself
  const responseTrimmed = toolResponse.trim();
  if (responseTrimmed.length > 50) {
    // Extract first meaningful line (H1 heading or first paragraph) for fast pre-filter
    const responseFirstLine = responseTrimmed.split('\n').find((l) => l.trim())?.trim() || '';

    for (const file of files) {
      if (stored[file.name]) continue;
      try {
        const content = readFileSync(file.path, 'utf-8').trim();
        // Exact match
        if (content === responseTrimmed) return { ...file, method: 'exact-content' };
        // Response contains the file content (response may have extra wrapper text)
        if (responseTrimmed.includes(content)) return { ...file, method: 'content-in-response' };
        // File content contains the response (file is the full plan, response is a subset)
        if (content.includes(responseTrimmed)) return { ...file, method: 'response-in-content' };
        // First-line match as fallback (H1 heading match)
        if (responseFirstLine.length > 10) {
          const fileFirstLine = content.split('\n').find((l) => l.trim())?.trim() || '';
          if (fileFirstLine === responseFirstLine) return { ...file, method: 'heading-match' };
        }
      } catch { /* skip unreadable files */ }
    }
  }

  return null;
}

/**
 * Fallback: return the most recently modified unstored plan file.
 * Used only when content matching fails (no tool_response or no match).
 */
function findLatestPlan() {
  const stored = loadStoredPlans();
  const files = listPlanFiles();
  if (files.length === 0) return null;
  const unstored = files.find((f) => !stored[f.name]);
  return unstored ? { ...unstored, method: 'mtime-fallback' } : null;
}

// ─── Category management ───

function ensureProjectCategory(project) {
  const categoryName = `plans-${project}`;
  const catPath = getMcpCategoriesPath();

  try {
    const data = JSON.parse(readFileSync(catPath, 'utf-8'));
    const categories = data.categories || [];

    // Check if child category already exists
    if (categories.some((c) => c.name === categoryName)) {
      return categoryName;
    }

    // Check if "plans" parent exists
    if (!categories.some((c) => c.name === 'plans')) {
      // Create parent if missing (shouldn't happen, but safety net)
      categories.push({
        name: 'plans',
        description: 'Implementation plans stored after plan mode approval. Sub-categorized by project name.',
        is_parent: true,
        color: '#06d6a0',
        created_at: new Date().toISOString(),
      });
    }

    // Create child category for this project
    categories.push({
      name: categoryName,
      description: `Implementation plans for ${project} project`,
      parent: 'plans',
      created_at: new Date().toISOString(),
    });

    data.categories = categories;
    writeFileSync(catPath, JSON.stringify(data, null, 2), 'utf-8');

    return categoryName;
  } catch {
    // If categories file can't be read/written, fall back to parent
    return 'plans';
  }
}

// ─── Neural Interface cache invalidation ───

async function invalidateNeuralInterface() {
  try {
    // Trigger sync broadcast so the Neural Interface graph refreshes
    const niUrl = process.env.SYNABUN_NI_URL || 'http://localhost:3344';
    await fetch(`${niUrl}/api/memories?invalidate=true`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    });
  } catch { /* fire-and-forget */ }
}

// ─── Extract plan title from markdown ───

function extractPlanTitle(content) {
  // Look for first H1 heading
  const h1Match = content.match(/^#\s+(.+)$/m);
  if (h1Match) return h1Match[1].trim();

  // Fall back to first non-empty line
  const firstLine = content.split('\n').find((l) => l.trim());
  return firstLine?.trim().slice(0, 100) || 'Untitled plan';
}

// ─── Main ───

async function main() {
  let input = {};
  try {
    const raw = await readStdin();
    input = JSON.parse(raw);
  } catch { /* proceed */ }

  const toolName = input.tool_name || '';

  debugLog(`Hook invoked — tool_name: "${toolName}", session: ${input.session_id || 'unknown'}, cwd: ${input.cwd || 'unknown'}`);

  // Only handle ExitPlanMode
  if (toolName !== 'ExitPlanMode') {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  // Match plan file: content-match first (session-accurate), mtime fallback
  const toolResponse = typeof input.tool_response === 'string'
    ? input.tool_response
    : (input.tool_response != null ? JSON.stringify(input.tool_response) : '');

  debugLog(`ExitPlanMode fired — tool_response length: ${toolResponse.length}, first 200 chars: ${toolResponse.slice(0, 200).replace(/\n/g, '\\n')}`);

  const planFile = findPlanByContent(toolResponse) || findLatestPlan();
  if (!planFile) {
    process.stdout.write(JSON.stringify({
      additionalContext: 'SynaBun: No unstored plan file found (all plans already in memory).',
    }));
    return;
  }

  const planContent = readFileSync(planFile.path, 'utf-8');
  if (!planContent.trim()) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const project = detectProject(input.cwd || '');
  const planTitle = extractPlanTitle(planContent);

  // Ensure child category exists under "plans"
  const categoryName = ensureProjectCategory(project);

  // Generate local embedding (Transformers.js, no API key needed)
  const embedding = await generateEmbedding(planContent);

  // Store in SQLite
  const id = randomUUID();
  const now = new Date().toISOString();

  storeInSQLite(id, embedding, {
    content: planContent,
    category: categoryName,
    project,
    importance: 7,
    tags: ['plan', 'implementation', project],
    source: 'auto-saved',
    subcategory: 'plan',
    created_at: now,
    updated_at: now,
    accessed_at: now,
    access_count: 0,
  });

  // Mark this plan as stored (dedup for future ExitPlanMode calls)
  markPlanStored(planFile.name, id);

  // Invalidate Neural Interface cache (fire-and-forget)
  invalidateNeuralInterface();

  // Confirm storage — include match method for diagnostics
  const shortTitle = planTitle.length > 60 ? planTitle.slice(0, 60) + '...' : planTitle;
  const matchInfo = planFile.method || 'unknown';
  debugLog(`Stored plan: ${planFile.name} [${matchInfo}] → memory ${id} (project: ${project})`);
  process.stdout.write(JSON.stringify({
    additionalContext: `SynaBun: Plan stored in memory [${id}] — "${shortTitle}" (category: ${categoryName}, project: ${project}). Source file: ${planFile.name} [matched: ${matchInfo}]`,
  }));
}

main().catch((err) => {
  // On error, still output valid JSON so Claude Code doesn't break
  process.stdout.write(JSON.stringify({
    additionalContext: `SynaBun: Plan storage failed — ${err.message}. The plan file is still saved at ${PLANS_DIR}.`,
  }));
});
