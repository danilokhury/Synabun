#!/usr/bin/env node

/**
 * SynaBun PostToolUse Hook — Plan Storage
 *
 * Matches: ^ExitPlanMode$
 *
 * When Claude exits plan mode (plan approved), this hook:
 * 1. Finds the most recently modified plan file in ~/.claude/plans/
 * 2. Auto-creates a child category under "plans" for the project if needed
 * 3. Stores the full plan markdown in Qdrant with embedding
 * 4. Returns additionalContext confirming storage
 *
 * Input (stdin JSON):
 *   { session_id, tool_name, tool_input, tool_response, cwd }
 *
 * Output (stdout JSON):
 *   { additionalContext: "..." } on success, or {} on skip/error
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { detectProject, getCategoriesPath, ENV_PATH, DATA_DIR } from './shared.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Plans directory — Claude Code stores plan .md files here
const PLANS_DIR = join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'plans');

// Dedup tracker — records which plan files have already been stored
const STORED_PLANS_PATH = join(DATA_DIR, 'stored-plans.json');

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

// ─── Env config ───

function parseEnvFile() {
  try {
    const content = readFileSync(ENV_PATH, 'utf-8');
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

function loadEmbeddingConfig(vars) {
  const activeId = vars.EMBEDDING_ACTIVE;
  if (activeId && vars[`EMBEDDING__${activeId}__API_KEY`]) {
    return {
      apiKey: vars[`EMBEDDING__${activeId}__API_KEY`],
      baseUrl: vars[`EMBEDDING__${activeId}__BASE_URL`] || 'https://api.openai.com/v1',
      model: vars[`EMBEDDING__${activeId}__MODEL`] || 'text-embedding-3-small',
      dimensions: parseInt(vars[`EMBEDDING__${activeId}__DIMENSIONS`] || '1536', 10),
    };
  }
  return {
    apiKey: vars.OPENAI_EMBEDDING_API_KEY || vars.OPENAI_API_KEY || '',
    baseUrl: vars.EMBEDDING_BASE_URL || 'https://api.openai.com/v1',
    model: vars.EMBEDDING_MODEL || 'text-embedding-3-small',
    dimensions: parseInt(vars.EMBEDDING_DIMENSIONS || '1536', 10),
  };
}

function loadQdrantConfig(vars) {
  const activeId = vars.QDRANT_ACTIVE;
  if (activeId && vars[`QDRANT__${activeId}__PORT`]) {
    const port = vars[`QDRANT__${activeId}__PORT`] || '6333';
    return {
      url: vars[`QDRANT__${activeId}__URL`] || `http://localhost:${port}`,
      apiKey: vars[`QDRANT__${activeId}__API_KEY`] || '',
      collection: vars[`QDRANT__${activeId}__COLLECTION`] || 'claude_memory',
    };
  }
  return {
    url: vars.QDRANT_MEMORY_URL || `http://localhost:${vars.QDRANT_PORT || '6333'}`,
    apiKey: vars.QDRANT_MEMORY_API_KEY || 'claude-memory-local-key',
    collection: vars.QDRANT_MEMORY_COLLECTION || 'claude_memory',
  };
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

function findLatestPlan() {
  if (!existsSync(PLANS_DIR)) return null;

  const stored = loadStoredPlans();

  const files = readdirSync(PLANS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const fullPath = join(PLANS_DIR, f);
      const stat = statSync(fullPath);
      return { name: f, path: fullPath, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length === 0) return null;

  // Return the most recently modified plan that hasn't been stored yet
  const unstored = files.find((f) => !stored[f.name]);
  return unstored || null;
}

// ─── Category management ───

function ensureProjectCategory(project) {
  const categoryName = `plans-${project}`;
  const catPath = getCategoriesPath();

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

// ─── Embedding generation ───

async function generateEmbedding(text, embConfig) {
  const res = await fetch(`${embConfig.baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${embConfig.apiKey}`,
    },
    body: JSON.stringify({
      model: embConfig.model,
      input: text,
      dimensions: embConfig.dimensions,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Embedding API ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return data.data[0].embedding;
}

// ─── Qdrant storage ───

async function storeInQdrant(id, vector, payload, qdrantConfig) {
  const url = `${qdrantConfig.url}/collections/${qdrantConfig.collection}/points`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'api-key': qdrantConfig.apiKey,
    },
    body: JSON.stringify({
      points: [{
        id,
        vector,
        payload,
      }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Qdrant ${res.status}: ${errText}`);
  }

  return res.json();
}

// ─── Neural Interface cache invalidation ───

async function invalidateNeuralInterface() {
  try {
    // Trigger sync broadcast so the Neural Interface graph refreshes
    await fetch('http://localhost:3344/api/memories?invalidate=true', {
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

  // Only handle ExitPlanMode
  if (toolName !== 'ExitPlanMode') {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  // Find the most recently modified plan file that hasn't been stored yet
  const planFile = findLatestPlan();
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

  // Load config from .env
  const vars = parseEnvFile();
  const embConfig = loadEmbeddingConfig(vars);
  const qdrantConfig = loadQdrantConfig(vars);

  if (!embConfig.apiKey) {
    process.stdout.write(JSON.stringify({
      additionalContext: 'SynaBun: Plan storage skipped — no embedding API key configured.',
    }));
    return;
  }

  // Generate embedding from plan content
  const embedding = await generateEmbedding(planContent, embConfig);

  // Store in Qdrant
  const id = randomUUID();
  const now = new Date().toISOString();

  await storeInQdrant(id, embedding, {
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
    plan_file: planFile.name,
    plan_title: planTitle,
  }, qdrantConfig);

  // Mark this plan as stored (dedup for future ExitPlanMode calls)
  markPlanStored(planFile.name, id);

  // Invalidate Neural Interface cache (fire-and-forget)
  invalidateNeuralInterface();

  // Confirm storage
  const shortTitle = planTitle.length > 60 ? planTitle.slice(0, 60) + '...' : planTitle;
  process.stdout.write(JSON.stringify({
    additionalContext: `SynaBun: Plan stored in memory [${id}] — "${shortTitle}" (category: ${categoryName}, project: ${project}). Source file: ${planFile.name}`,
  }));
}

main().catch((err) => {
  // On error, still output valid JSON so Claude Code doesn't break
  process.stdout.write(JSON.stringify({
    additionalContext: `SynaBun: Plan storage failed — ${err.message}. The plan file is still saved at ${PLANS_DIR}.`,
  }));
});
