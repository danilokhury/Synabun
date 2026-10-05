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
 * 5. Meanwhile asks the Neural Interface (kind `plan-conflict`) whether the
 *    plan contradicts stored project decisions — advisory only, never blocks
 * 6. Returns additionalContext confirming storage + plan file path, plus the
 *    advisory line when conflicts came back
 *
 * Input (stdin JSON):
 *   { session_id, tool_name, tool_input, tool_response, cwd }
 *
 * Output (stdout JSON):
 *   { hookSpecificOutput: { hookEventName, additionalContext } } on success,
 *   or {} on skip/error. See emitContext().
 */

import { readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { withStateLock, writeJsonAtomic, planMemoryKey } from './state.mjs';
import { detectProject, getMcpCategoriesPath, MCP_DATA_DIR, DATA_DIR, readStdin, hookBudget, hookJudge, clipForJudge, isTemporaryChat } from './shared.mjs';

// Cross-platform safety: catch uncaught errors and output valid hook JSON
process.on('uncaughtException', () => { try { process.stdout.write('{}'); } catch {} process.exit(0); });
process.on('unhandledRejection', () => { try { process.stdout.write('{}'); } catch {} process.exit(0); });

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Emit additionalContext in the shape PostToolUse actually reads. A bare
 * top-level { additionalContext } is accepted as valid JSON and then silently
 * discarded, so every message written that way never reaches the model.
 */
function emitContext(text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text },
  }));
}

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

// ─── Plan check against stored decisions (advisory) ───

const budget = hookBudget(15000);
let conflictCheck = null;

// Always resolves; [] when unavailable (SYNABUN_TYPESAFE=off, old server, timeout).
async function planConflicts(plan, { project, sessionId, cwd, excludeIds }) {
  const text = plan.length > 16000 ? clipForJudge(plan, 16000, 12000) : plan;
  const answer = await hookJudge('plan-conflict', {
    text, project, exclude_ids: excludeIds, session_id: sessionId || undefined, cwd: cwd || undefined,
  }, { timeoutMs: Math.min(5000, budget.callTimeout(1000)) });
  return Array.isArray(answer?.conflicts)
    ? answer.conflicts.filter((c) => c && typeof c.id === 'string' && c.id).slice(0, 3)
    : [];
}

function formatPlanConflicts(conflicts) {
  if (!Array.isArray(conflicts) || !conflicts.length) return '';
  const items = conflicts.map((c) => {
    const p = Number(c.probability);
    const meta = [
      c.probability !== undefined && c.probability !== null && Number.isFinite(p) ? `p=${p.toFixed(2)}` : '',
      typeof c.category === 'string' ? c.category : '',
      typeof c.created_at === 'string' ? c.created_at.slice(0, 10) : '',
    ].filter(Boolean).join(', ');
    const excerpt = String(c.excerpt ?? '').replace(/\s+/g, ' ').trim().slice(0, 160).replace(/"/g, "'");
    return `[${c.id}]${meta ? ` (${meta})` : ''}${excerpt ? ` "${excerpt}"` : ''}`;
  });
  return `SynaBun [Jev] plan check (advisory): this plan may contradict stored decisions — ${items.join('; ')}. Confirm with the user or state why the decision changed before implementing.`;
}

// The same transactional writer as the MCP remember tool owns plan writes.
async function storePlan(payload, options) {
  const modulePath = join(__dirname, '../../mcp-server/dist/services/memory-writer.js');
  const { writeMemory } = await import(pathToFileURL(modulePath).href);
  const { getDb } = await import(pathToFileURL(join(__dirname, '../../mcp-server/dist/services/sqlite.js')).href);
  const { closeDatabase } = await import(pathToFileURL(join(__dirname, '../../mcp-server/dist/services/sqlite.js')).href);
  const { closeEmbeddings } = await import(pathToFileURL(join(__dirname, '../../mcp-server/dist/services/local-embeddings.js')).href);
  withStateLock(() => getDb()); // Serialize cold schema/WAL initialization too.
  try { return await writeMemory(payload, options); }
  finally { await closeEmbeddings(); closeDatabase(); }
}

// ─── Dedup tracker ───

function loadStoredPlans() {
  try {
    if (!existsSync(STORED_PLANS_PATH)) return {};
    return JSON.parse(readFileSync(STORED_PLANS_PATH, 'utf-8'));
  } catch { return {}; }
}

// `key` is the content-addressed plan identity (the one stop.mjs recomputes and
// looks up); `fileNames` are convenience aliases — our own copy's basename plus
// Claude Code's, when ExitPlanMode told us about it.
function markPlanStored(fileNames, memoryId, contentHash, key, project, sourcePath) {
  withStateLock(() => {
    const stored = loadStoredPlans();
    const receipt = { memoryId, contentHash, project, sourcePath, storedAt: new Date().toISOString() };
    for (const name of new Set(fileNames.filter(Boolean))) stored[name] = receipt;
    stored[key] = receipt;
    writeJsonAtomic(STORED_PLANS_PATH, stored);
  });
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
    if (matched) return { ...matched, method: 'filename' };
  }

  // Strategy 2: Content matching — compare response text against each unstored plan file
  const responseTrimmed = toolResponse.trim();
  if (responseTrimmed.length > 50) {
    const responseFirstLine = responseTrimmed.split('\n').find((l) => l.trim())?.trim() || '';

    for (const file of files) {
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

  // A temporary chat (see isTemporaryChat): its plan is not stored as a file or
  // a memory, and it is not told where SynaBun keeps plans.
  if (isTemporaryChat()) { process.stdout.write(JSON.stringify({})); return; }

  const toolName = input.tool_name || '';

  debugLog(`Hook invoked — tool_name: "${toolName}", session: ${input.session_id || 'unknown'}, cwd: ${input.cwd || 'unknown'}`);

  // Handle EnterPlanMode — remind Claude to use AskUserQuestion + new plan path format
  if (toolName === 'EnterPlanMode') {
    debugLog('EnterPlanMode fired — injecting AskUserQuestion reminder');
    const todayDir = getTodayPlanDir();
    emitContext(`SynaBun: You are now in plan mode.\n\n**CRITICAL CONSTRAINT**: Do NOT make code changes (Edit, Write, NotebookEdit). Plan mode is RESEARCH AND PLANNING ONLY. Investigate, read files, search code — then present your plan. Do NOT implement anything until the user explicitly approves the plan and you exit plan mode.\n\nWhen you have questions or need clarification, you MUST use the \`AskUserQuestion\` tool — do NOT write questions as plain text. Load it via \`ToolSearch\` if its schema is not yet available. Use \`ExitPlanMode\` for final plan approval.\n\n**Plan file location**: Write plan files to \`${todayDir}/your-plan-slug.md\` — use a short descriptive slug derived from the plan title (e.g., \`fix-session-crosstalk.md\`, \`opencode-sidepanel.md\`). Do NOT create \`PLAN.md\` at the project root. Do NOT write to \`~/.claude/plans/\`.`);
    return;
  }

  // Only handle ExitPlanMode beyond this point
  if (toolName !== 'ExitPlanMode') {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  // Run one-time migration of legacy flat plans before discovery
  try { withStateLock(() => migrateFlatPlans()); } catch (err) {
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
  // Same tolerance for planFilePath: the old guard required tool_input to be an
  // object, so a JSON-string payload silently dropped the path.
  function readPlanFilePath(obj) {
    if (!obj) return '';
    if (typeof obj === 'string') {
      try {
        const parsed = JSON.parse(obj);
        if (parsed && typeof parsed.planFilePath === 'string') return parsed.planFilePath;
      } catch { /* not JSON — fall through */ }
      return '';
    }
    if (typeof obj === 'object' && typeof obj.planFilePath === 'string') return obj.planFilePath;
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

  let planFile = null;

  // Happy path: ExitPlanMode hands us the authoritative plan AND its file path,
  // so we mirror it under that basename instead of mtime-guessing across
  // sessions. Dedup no longer rides on the filename — planMemoryKey hashes the
  // plan text — but recording the path still lets stop.mjs's basename alias and
  // the source_ref point at the file the user actually approved.
  const planFilePathInput =
    readPlanFilePath(input.tool_input) || readPlanFilePath(input.tool_response);
  if (planFilePathInput && authoritativePlan) {
    const base = basename(planFilePathInput);
    try {
      const todayDir = getTodayPlanDir();
      mkdirSync(todayDir, { recursive: true });
      const targetPath = join(todayDir, base);
      writeFileSync(targetPath, authoritativePlan, 'utf-8');
      const stat = statSync(targetPath);
      planFile = { name: base, path: targetPath, mtime: stat.mtimeMs, method: 'planFilePath' };
      debugLog(`Authored plan from planFilePath: ${targetPath}`);
    } catch (err) {
      debugLog(`Failed to author from planFilePath (${base}): ${err.message}`);
    }
  }

  // Fallback (older Claude Code without planFilePath, or authoring failed):
  // content-match against existing files, then mtime, then author from content.
  if (!planFile) {
    planFile = findPlanByContent(authoritativePlan || toolResponse) || findLatestPlan();

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
  }

  if (!planFile) {
    emitContext('SynaBun: No plan file found and no plan content in tool_input — UI capture and hook authoring both failed.');
    return;
  }

  const planContent = authoritativePlan || readFileSync(planFile.path, 'utf-8');
  if (!planContent.trim()) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const project = detectProject(input.cwd || '');
  const planTitle = extractPlanTitle(planContent);

  // Ensure child category exists under "plans"
  const categoryName = withStateLock(() => ensureProjectCategory(project));

  const now = new Date().toISOString();
  const originalPath = planFilePathInput || planFile.path;
  // Identity is the plan text, not the path — stop.mjs recomputes this exact key
  // from the transcript's ExitPlanMode payload and finds our receipt.
  const planKey = planMemoryKey(project, planContent);
  const storedPlans = loadStoredPlans();
  const previous = storedPlans[planKey] || storedPlans[planFile.name];
  // In parallel with the write (which loads the embedding model): the plan
  // check needs the network, the write needs the CPU.
  conflictCheck = planConflicts(planContent, {
    project, sessionId: input.session_id, cwd: input.cwd || '',
    excludeIds: previous?.memoryId ? [previous.memoryId] : [],
  });
  const result = await storePlan({
    content: planContent, category: categoryName, project, importance: 7,
    tags: ['plan', 'implementation', project], source: 'auto-saved', subcategory: 'plan',
    created_at: now, updated_at: now, accessed_at: now, access_count: 0,
  }, {
    idempotencyKey: planKey,
    sourceRef: originalPath, kind: 'decision', existingId: previous?.memoryId,
  });
  const id = result.id;
  markPlanStored([planFile.name, planFilePathInput && basename(planFilePathInput)],
    id, createHash('sha256').update(planContent).digest('hex'), planKey, project, originalPath);

  // Confirm storage — include full plan file path for future NI edit wiring
  const shortTitle = planTitle.length > 60 ? planTitle.slice(0, 60) + '...' : planTitle;
  const matchInfo = planFile.method || 'unknown';
  debugLog(`Stored plan: ${planFile.path} [${matchInfo}] → memory ${id} (project: ${project})`);
  const advisory = formatPlanConflicts(await conflictCheck);
  emitContext(`SynaBun: Plan stored in memory [${id}] — "${shortTitle}" (category: ${categoryName}, project: ${project}). Plan file: ${planFile.path} [matched: ${matchInfo}]${advisory ? `\n\n${advisory}` : ''}`);
}

main().catch(async (err) => {
  // On error, still output valid JSON so Claude Code doesn't break
  let advisory = '';
  try { advisory = conflictCheck ? formatPlanConflicts(await conflictCheck) : ''; } catch { /* advisory only */ }
  emitContext(`SynaBun: Plan storage failed — ${err.message}. The plan file is still saved at ${PLANS_DIR}.${advisory ? `\n\n${advisory}` : ''}`);
});
