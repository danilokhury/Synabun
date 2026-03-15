/**
 * Shared utilities for SynaBun Claude Code hooks.
 *
 * Extracted to avoid duplication across session-start, prompt-submit,
 * post-remember, pre-compact, and stop hooks.
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
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
