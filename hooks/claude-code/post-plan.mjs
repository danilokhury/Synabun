#!/usr/bin/env node

/**
 * SynaBun PostToolUse Hook — Plan Storage
 *
 * Matches: ^(Enter|Exit)PlanMode$
 *
 * EnterPlanMode: Injects a reminder to use AskUserQuestion for
 * clarifications instead of plain-text questions.
 *
 * ExitPlanMode: When Claude exits plan mode (plan approved), this hook:
 * 1. Migrates any legacy flat plans to date-organized folders (first run only)
 * 2. Finds the most recently modified plan file in data/plans/YYYY-MM-DD/
 * 3. Auto-creates a child category under "plans" for the project if needed
 * 4. Generates a local embedding and stores the plan in SQLite
 * 5. Returns additionalContext confirming storage + plan file path
 *
 * Input (stdin JSON):
 *   { session_id, tool_name, tool_input, tool_response, cwd }
 *
 * Output (stdout JSON):
 *   { additionalContext: "..." } on success, or {} on skip/error
 */

import { readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { detectProject, getMcpCategoriesPath, MCP_DATA_DIR, DATA_DIR } from './shared.mjs';

// Cross-platform safety: catch uncaught errors and output valid hook JSON
process.on('uncaughtException', () => { try { process.stdout.write('{}'); } catch {} process.exit(0); });
process.on('unhandledRejection', () => { try { process.stdout.write('{}'); } catch {} process.exit(0); });

const __dirname = dirname(fileURLToPath(import.meta.url));

// Debug log (append-only, survives across invocations)
const DEBUG_LOG_PATH = join(DATA_DIR, 'plan-debug.log');
function debugLog(msg) {
  try {
    const ts = new Date().toISOString();
    appendFileSync(DEBUG_LOG_PATH, `[${ts}] ${msg}\n`, 'utf-8');
  } catch { /* best-effort */ }
}

// Plans directory — project-local to avoid ~/.claude/ sensitive-file permission prompts
const PLANS_DIR = join(DATA_DIR, 'plans');
// Fallback: Claude Code's ExitPlanMode may still write to ~/.claude/plans/ internally
const PLANS_DIR_FALLBACK = join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'plans');
// Migration marker — presence means flat-plan migration has already run
const MIGRATION_MARKER = join(PLANS_DIR, '.migrated');

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
  const PACKAGE_ROOT = join(__dirname, '..', '..');
  const embPath = join(PACKAGE_ROOT, 'mcp-server', 'dist', 'services', 'local-embeddings.js');
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

// ─── Date folder helpers ───

/**
 * Returns today's date folder path: data/plans/YYYY-MM-DD/
 */
function getTodayPlanDir() {
  const d = new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return join(PLANS_DIR, ymd);
}

/**
 * Returns YYYY-MM-DD string from a timestamp (ms).
 */
function dateFromMs(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Convert a plan title to a URL-safe filename slug.
 * Strips leading "Plan:" prefix, lowercases, replaces non-alphanumeric with hyphens.
 */
function slugify(title) {
  return (title || 'untitled')
    .toLowerCase()
    .replace(/^plan[:\s]+/i, '')   // strip leading "Plan: " prefix
    .replace(/[^a-z0-9]+/g, '-')  // replace non-alphanumeric runs with hyphen
    .replace(/^-+|-+$/g, '')       // trim leading/trailing hyphens
    .slice(0, 60)                  // max 60 chars
    || 'untitled';
}

/**
 * Resolve a unique filename in targetDir for slug.md.
 * If slug.md already exists, appends -2, -3, etc.
 */
function uniqueSlugPath(targetDir, slug) {
  let candidate = join(targetDir, `${slug}.md`);
  if (!existsSync(candidate)) return candidate;
  let n = 2;
  while (existsSync(join(targetDir, `${slug}-${n}.md`))) n++;
  return join(targetDir, `${slug}-${n}.md`);
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

// ─── One-time migration: flat plans → date-organized folders ───

/**
 * Migrates legacy flat .md files from data/plans/ into data/plans/YYYY-MM-DD/slug.md.
 * Runs only once (marker file data/plans/.migrated).
 * Updates stored-plans.json keys to reflect new basenames.
 */
function migrateFlatPlans() {
  if (existsSync(MIGRATION_MARKER)) return; // already done

  if (!existsSync(PLANS_DIR)) return;

  const entries = readdirSync(PLANS_DIR);
  const flatFiles = entries.filter((f) => f.endsWith('.md') && !f.startsWith('.'));
  if (flatFiles.length === 0) {
    // Nothing to migrate — just write the marker
    try { writeFileSync(MIGRATION_MARKER, '', 'utf-8'); } catch { /* ok */ }
    return;
  }

  const stored = loadStoredPlans();
  const updatedStored = { ...stored };
  let moved = 0;

  for (const fname of flatFiles) {
    const oldPath = join(PLANS_DIR, fname);
    try {
      const stat = statSync(oldPath);
      const dateStr = dateFromMs(stat.mtimeMs);
      const content = readFileSync(oldPath, 'utf-8');
      const title = extractPlanTitle(content);
      const slug = slugify(title);

      const targetDir = join(PLANS_DIR, dateStr);
      mkdirSync(targetDir, { recursive: true });

      const targetPath = uniqueSlugPath(targetDir, slug);
      const newBasename = targetPath.split('/').pop();

      renameSync(oldPath, targetPath);
      moved++;

      // Update stored-plans.json: old key → new key, preserve value
      if (updatedStored[fname]) {
        updatedStored[newBasename] = updatedStored[fname];
        delete updatedStored[fname];
      }

      debugLog(`Migrated: ${fname} → ${dateStr}/${newBasename}`);
    } catch (err) {
      debugLog(`Migration skip: ${fname} — ${err.message}`);
    }
  }

  // Persist updated stored-plans.json
  try {
    writeFileSync(STORED_PLANS_PATH, JSON.stringify(updatedStored, null, 2), 'utf-8');
  } catch { /* best-effort */ }

  // Write migration marker
  try { writeFileSync(MIGRATION_MARKER, new Date().toISOString(), 'utf-8'); } catch { /* ok */ }

  debugLog(`Migration complete: ${moved}/${flatFiles.length} files moved`);
}

// ─── Plan file discovery ───

/**
 * List all plan .md files from date-organized subdirectories and legacy flat files.
 * Sorted by mtime descending.
 * Each entry: { name, path, mtime }
 */
function listPlanFiles() {
  const results = [];

  // Primary: scan PLANS_DIR — date subdirectories (YYYY-MM-DD/) and any remaining flat files
  if (existsSync(PLANS_DIR)) {
    for (const entry of readdirSync(PLANS_DIR)) {
      if (entry.startsWith('.')) continue; // skip .migrated, .gitkeep, etc.
      const entryPath = join(PLANS_DIR, entry);
      const entryStat = statSync(entryPath);

      if (entryStat.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry)) {
        // Date folder — scan .md files inside
        for (const f of readdirSync(entryPath).filter((f) => f.endsWith('.md'))) {
          const fullPath = join(entryPath, f);
          const stat = statSync(fullPath);
          results.push({ name: f, path: fullPath, mtime: stat.mtimeMs });
        }
      } else if (entry.endsWith('.md')) {
        // Legacy flat file still in root of PLANS_DIR
        results.push({ name: entry, path: entryPath, mtime: entryStat.mtimeMs });
      }
    }
  }

  // Fallback: scan ~/.claude/plans/ (flat only)
  if (existsSync(PLANS_DIR_FALLBACK)) {
    for (const f of readdirSync(PLANS_DIR_FALLBACK).filter((f) => f.endsWith('.md'))) {
      if (results.some((r) => r.name === f)) continue; // skip duplicates
      const fullPath = join(PLANS_DIR_FALLBACK, f);
      const stat = statSync(fullPath);
      results.push({ name: f, path: fullPath, mtime: stat.mtimeMs });
    }
  }

  return results.sort((a, b) => b.mtime - a.mtime);
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

  // Strategy 1: Extract filename pattern (kebab-slug.md) from response
  const fnameMatch = toolResponse.match(/([a-z][a-z0-9-]+\.md)/);
  if (fnameMatch) {
    const matched = files.find((f) => f.name === fnameMatch[1]);
    if (matched && !stored[matched.name]) return { ...matched, method: 'filename' };
  }

  // Strategy 2: Content matching — compare response text against each unstored plan file
  const responseTrimmed = toolResponse.trim();
  if (responseTrimmed.length > 50) {
    const responseFirstLine = responseTrimmed.split('\n').find((l) => l.trim())?.trim() || '';

    for (const file of files) {
      if (stored[file.name]) continue;
      try {
        const content = readFileSync(file.path, 'utf-8').trim();
        if (content === responseTrimmed) return { ...file, method: 'exact-content' };
        if (responseTrimmed.includes(content)) return { ...file, method: 'content-in-response' };
        if (content.includes(responseTrimmed)) return { ...file, method: 'response-in-content' };
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

    if (categories.some((c) => c.name === categoryName)) {
      return categoryName;
    }

    if (!categories.some((c) => c.name === 'plans')) {
      categories.push({
        name: 'plans',
        description: 'Implementation plans stored after plan mode approval. Sub-categorized by project name.',
        is_parent: true,
        color: '#06d6a0',
        created_at: new Date().toISOString(),
      });
    }

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
    return 'plans';
  }
}

// ─── Neural Interface cache invalidation ───

async function invalidateNeuralInterface() {
  try {
    const niUrl = process.env.SYNABUN_NI_URL || 'http://localhost:3344';
    await fetch(`${niUrl}/api/memories?invalidate=true`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    });
  } catch { /* fire-and-forget */ }
}

// ─── Root PLAN.md cleanup ───

/**
 * If a PLAN.md exists at the project root and was modified within the last 60s,
 * delete it. Prevents root-level clutter when Claude Code's ExitPlanMode creates it.
 */
function cleanupRootPlanMd(cwd) {
  if (!cwd) return;
  const rootPlan = join(cwd, 'PLAN.md');
  try {
    if (!existsSync(rootPlan)) return;
    const stat = statSync(rootPlan);
    if (Date.now() - stat.mtimeMs < 60_000) {
      unlinkSync(rootPlan);
      debugLog(`Deleted root PLAN.md at ${rootPlan}`);
    }
  } catch { /* best-effort */ }
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

  // Handle EnterPlanMode — remind Claude to use AskUserQuestion + new plan path format
  if (toolName === 'EnterPlanMode') {
    debugLog('EnterPlanMode fired — injecting AskUserQuestion reminder');
    const todayDir = getTodayPlanDir();
    process.stdout.write(JSON.stringify({
      additionalContext: `SynaBun: You are now in plan mode.\n\n**CRITICAL CONSTRAINT**: Do NOT make code changes (Edit, Write, NotebookEdit). Plan mode is RESEARCH AND PLANNING ONLY. Investigate, read files, search code — then present your plan. Do NOT implement anything until the user explicitly approves the plan and you exit plan mode.\n\nWhen you have questions or need clarification, you MUST use the \`AskUserQuestion\` tool — do NOT write questions as plain text. Load it via \`ToolSearch\` if its schema is not yet available. Use \`ExitPlanMode\` for final plan approval.\n\n**Plan file location**: Write plan files to \`${todayDir}/your-plan-slug.md\` — use a short descriptive slug derived from the plan title (e.g., \`fix-session-crosstalk.md\`, \`opencode-sidepanel.md\`). Do NOT create \`PLAN.md\` at the project root. Do NOT write to \`~/.claude/plans/\`.`,
    }));
    return;
  }

  // Only handle ExitPlanMode beyond this point
  if (toolName !== 'ExitPlanMode') {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  // Run one-time migration of legacy flat plans before discovery
  try { migrateFlatPlans(); } catch (err) {
    debugLog(`Migration error (non-fatal): ${err.message}`);
  }

  // Clean up root PLAN.md if it was just created
  cleanupRootPlanMd(input.cwd || '');

  // Authoritative plan markdown lives in tool_input.plan (and is echoed in tool_response.plan).
  // Pull it directly so we can author the file ourselves if the UI capture failed.
  function readPlanField(obj) {
    if (!obj) return '';
    if (typeof obj === 'string') {
      try {
        const parsed = JSON.parse(obj);
        if (parsed && typeof parsed.plan === 'string') return parsed.plan;
      } catch { /* not JSON — fall through */ }
      return '';
    }
    if (typeof obj === 'object' && typeof obj.plan === 'string') return obj.plan;
    return '';
  }
  const authoritativePlan =
    readPlanField(input.tool_input) ||
    readPlanField(input.tool_response);

  // Match plan file: content-match first (session-accurate), mtime fallback
  const toolResponse = typeof input.tool_response === 'string'
    ? input.tool_response
    : (input.tool_response != null ? JSON.stringify(input.tool_response) : '');

  debugLog(`ExitPlanMode fired — tool_response length: ${toolResponse.length}, authoritativePlan length: ${authoritativePlan.length}, first 200 chars: ${toolResponse.slice(0, 200).replace(/\n/g, '\\n')}`);

  let planFile = findPlanByContent(authoritativePlan || toolResponse) || findLatestPlan();

  // If a match was found but its content doesn't match the authoritative plan,
  // it's stale. Drop it so we author a fresh file from tool_input.plan instead.
  if (planFile && authoritativePlan) {
    try {
      const existing = readFileSync(planFile.path, 'utf-8').trim();
      if (existing !== authoritativePlan.trim()) {
        debugLog(`Match stale (file != tool_input.plan) — discarding ${planFile.path}, will author from tool_input`);
        planFile = null;
      }
    } catch { /* unreadable — fall through to authoring */ planFile = null; }
  }

  // Author the plan file ourselves if no match and we have authoritative content.
  if (!planFile && authoritativePlan) {
    try {
      const todayDir = getTodayPlanDir();
      mkdirSync(todayDir, { recursive: true });
      const title = extractPlanTitle(authoritativePlan);
      const slug = slugify(title);
      const targetPath = uniqueSlugPath(todayDir, slug);
      writeFileSync(targetPath, authoritativePlan, 'utf-8');
      const stat = statSync(targetPath);
      planFile = {
        name: targetPath.split(/[/\\]/).pop(),
        path: targetPath,
        mtime: stat.mtimeMs,
        method: 'authored-from-tool_input',
      };
      debugLog(`Authored plan file from tool_input.plan: ${targetPath}`);
    } catch (err) {
      debugLog(`Failed to author plan file: ${err.message}`);
    }
  }

  if (!planFile) {
    process.stdout.write(JSON.stringify({
      additionalContext: 'SynaBun: No plan file found and no plan content in tool_input — UI capture and hook authoring both failed.',
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

  // Confirm storage — include full plan file path for future NI edit wiring
  const shortTitle = planTitle.length > 60 ? planTitle.slice(0, 60) + '...' : planTitle;
  const matchInfo = planFile.method || 'unknown';
  debugLog(`Stored plan: ${planFile.path} [${matchInfo}] → memory ${id} (project: ${project})`);
  process.stdout.write(JSON.stringify({
    additionalContext: `SynaBun: Plan stored in memory [${id}] — "${shortTitle}" (category: ${categoryName}, project: ${project}). Plan file: ${planFile.path} [matched: ${matchInfo}]`,
  }));
}

main().catch((err) => {
  // On error, still output valid JSON so Claude Code doesn't break
  process.stdout.write(JSON.stringify({
    additionalContext: `SynaBun: Plan storage failed — ${err.message}. The plan file is still saved at ${PLANS_DIR}.`,
  }));
});
