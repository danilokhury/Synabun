/**
 * Shared utilities for SynaBun Claude Code hooks.
 *
 * Extracted to avoid duplication across session-start, prompt-submit,
 * post-remember, pre-compact, and stop hooks.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(__dirname, '..', '..', 'data');
export const MCP_DATA_DIR = join(__dirname, '..', '..', 'mcp-server', 'data');
export const ENV_PATH = join(__dirname, '..', '..', '.env');
export const HOOK_FEATURES_PATH = join(DATA_DIR, 'hook-features.json');
export const PENDING_REMEMBER_DIR = join(DATA_DIR, 'pending-remember');

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

// --- Hook features ---

export function getHookFeatures() {
  try {
    if (!existsSync(HOOK_FEATURES_PATH)) return {};
    return JSON.parse(readFileSync(HOOK_FEATURES_PATH, 'utf-8'));
  } catch { return {}; }
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
  return vars.QDRANT_ACTIVE || 'default';
}

export function getCategoriesPath() {
  const connId = getActiveConnectionId();
  return join(MCP_DATA_DIR, `custom-categories-${connId}.json`);
}

// --- Project detection (reads from claude-code-projects.json) ---

const PROJECTS_PATH = join(DATA_DIR, 'claude-code-projects.json');

function loadRegisteredProjects() {
  try {
    if (!existsSync(PROJECTS_PATH)) return [];
    return JSON.parse(readFileSync(PROJECTS_PATH, 'utf-8'));
  } catch { return []; }
}

function normalizeLabel(label) {
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
  //    e.g. "SynaBunWebsite" contains "synabun" → matches Synabun project
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
