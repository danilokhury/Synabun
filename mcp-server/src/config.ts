import path from 'path';
import fs from 'fs';
import { getDataHome } from '../../lib/paths.js';
import { isHttpMode } from './services/identity.js';

const dataHome = getDataHome();

// --- Static config ---

export const config = {
  dataHome,
  dataDir: process.env.MEMORY_DATA_DIR || path.resolve(dataHome, 'mcp-data'),
  sqlite: {
    dbPath: process.env.SQLITE_DB_PATH || '',  // resolved lazily from dataDir
  },
  embedding: {
    model: 'Xenova/all-MiniLM-L6-v2',
    dimensions: 384,
  },
} as const;

// --- .env path resolution (for file watching) ---

export function getEnvPath(): string {
  return process.env.DOTENV_PATH || path.resolve(dataHome, '.env');
}

// --- Project Detection (reads from claude-code-projects.json) ---

// The project registry lives under <dataHome>/data/, NOT config.dataDir
// (<dataHome>/mcp-data/). It is written there by neural-interface/server.js and
// read from there by hooks/claude-code/shared.mjs. Pointing at dataDir meant the
// file never existed, loadRegisteredProjects() always returned [], and
// detectProject() silently fell through to a raw directory basename — ignoring
// every registered project label.
const PROJECTS_PATH = path.resolve(dataHome, 'data', 'claude-code-projects.json');

interface RegisteredProject {
  path: string;
  label: string;
}

function loadRegisteredProjects(): RegisteredProject[] {
  try {
    if (!fs.existsSync(PROJECTS_PATH)) return [];
    return JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf-8'));
  } catch { return []; }
}

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function detectProject(cwd?: string): string {
  // Over HTTP every caller shares the Neural Interface process, so process.cwd()
  // is the server's directory, not the caller's — it labeled every memory
  // "neural-interface" regardless of where the client actually was. Return a
  // neutral bucket instead of a confident wrong answer: "global" is a mislabel
  // you can find and fix, "neural-interface" is indistinguishable from a real one.
  if (!cwd && isHttpMode()) return 'global';
  const dir = cwd || process.cwd();
  const lower = dir.toLowerCase().replace(/\\/g, '/');
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
  for (const p of sorted) {
    const projFolder = path.basename(p.path).toLowerCase();
    if (lower.includes(projFolder)) return p.label;
  }

  // 3. Fallback to directory basename
  const base = path.basename(dir).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return base || 'global';
}
