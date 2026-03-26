import 'dotenv/config';

// Prevent Playwright internal race conditions (e.g. stale frame lifecycle events) from crashing the server
process.on('uncaughtException', (err) => {
  if (err.message?.includes('Frame has been detached')) {
    console.warn('[playwright] Ignoring stale frame error:', err.message);
    return;
  }
  console.error('Uncaught exception:', err);
  process.exit(1);
});

import express from 'express';
import { fileURLToPath, pathToFileURL } from 'url';
import { basename, dirname, extname, join, resolve, sep } from 'path';
import { config as dotenvConfig } from 'dotenv';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, rmSync, statSync, fstatSync, renameSync, cpSync, copyFileSync, appendFileSync, openSync, readSync, closeSync, chmodSync, watch as fsWatch, createWriteStream } from 'fs';
import { randomBytes, randomUUID, createHash } from 'crypto';
import { exec, execSync, spawn, spawnSync } from 'child_process';
import { promisify } from 'util';
import { Readable } from 'stream';
import { createConnection as netConnect } from 'net';
import { WebSocketServer } from 'ws';
import os from 'node:os';
let pty = null;
try { pty = (await import('node-pty')).default; }
catch (err) { console.warn('[pty] node-pty not available — terminal features disabled:', err.message); }
import archiver from 'archiver';
import AdmZip from 'adm-zip';
import { chromium } from 'playwright';
import { NodeHtmlMarkdown } from 'node-html-markdown';
import { VTermBuffer } from './public/shared/vterm-buffer.js';
import { startIndexing, getIndexingStatus, mirrorExistingChunks } from './lib/session-indexer.js';
import { ensureProjectCategories } from '../hooks/claude-code/shared.mjs';
import {
  getDb, closeDb, getDbPath, getEmbedding, getEmbeddingBatch, getEmbeddingDims, warmupEmbeddings,
  encodeVector, decodeVector, cosineSimilarity,
  searchMemories as dbSearchMemories, getAllMemories, getAllMemoriesWithVectors,
  getMemoryById, getMemoryWithVector, updateMemoryPayload,
  softDeleteMemory, hardDeleteMemory, restoreMemory as dbRestoreMemory,
  getTrashedMemories, purgeTrash, countMemories, getMemoryStats,
  getMemoriesByCategory, updateMemoriesCategory,
  getCategories as dbGetCategories, saveCategories as dbSaveCategories,
  countSessionChunks, searchSessionChunks as dbSearchSessionChunks,
  getKvConfig, setKvConfig, EMBEDDING_MODEL,
} from './lib/db.js';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Fix spawn-helper permissions on Unix (npm/cpSync don't preserve execute bit)
if (process.platform !== 'win32') {
  try {
    const ptyBase = resolve(__dirname, 'node_modules', 'node-pty');
    const spawnHelperPaths = [
      resolve(ptyBase, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
      resolve(ptyBase, 'build', 'Release', 'spawn-helper'),
    ];
    for (const p of spawnHelperPaths) {
      if (existsSync(p)) {
        const st = statSync(p);
        if (!(st.mode & 0o111)) {
          chmodSync(p, st.mode | 0o755);
          console.log(`[pty] Fixed execute permission on ${p}`);
        }
      }
    }
  } catch (err) {
    console.warn('[pty] Could not verify spawn-helper permissions:', err.message);
  }
}

// Load .env from parent directory
dotenvConfig({ path: resolve(__dirname, '..', '.env') });

const app = express();
const SERVER_BOOT_ID = randomUUID();
app.use(express.json({ limit: '5mb' }));

// Block tunnel traffic from accessing anything except /mcp and /invite
// Cloudflared adds CF-Connecting-IP header on proxied requests
const TUNNEL_ALLOWED = ['/mcp', '/invite'];

// Simple cookie parser (no dependency)
function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(part => {
    const [k, ...v] = part.trim().split('=');
    if (k) cookies[k.trim()] = decodeURIComponent(v.join('=').trim());
  });
  return cookies;
}

// Check if request has a valid invite session cookie
function isValidInviteSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies['synabun_invite'];
  if (!token) return false;
  const session = inviteSessions.get(token);
  if (!session) return false;
  // 24-hour TTL
  if (Date.now() - session.createdAt > 24 * 60 * 60 * 1000) {
    inviteSessions.delete(token);
    persistInviteSessions();
    return false;
  }
  session.lastSeen = Date.now();
  return true;
}

app.use((req, res, next) => {
  if (req.headers['cf-connecting-ip']) {
    // Allow explicitly permitted paths
    if (TUNNEL_ALLOWED.some(p => req.path.startsWith(p))) return next();
    // Allow cookie-authenticated invite sessions (full UI access)
    if (isValidInviteSession(req)) return next();
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
});

// Guest detection — works for both Cloudflare tunnel and custom proxy
function isGuestRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies['synabun_invite'];
  return !!token && inviteSessions.has(token);
}

// Admin-only protection — block guests from sensitive endpoints
const ADMIN_ONLY_PREFIXES = [
  '/api/settings', '/api/display-settings',
  '/api/connections', '/api/setup', '/api/system',
  '/api/invite/key', '/api/invite/sessions', '/api/invite/proxy', '/api/invite/permissions',
  '/api/claude-code', '/api/mcp-key',
  '/api/tunnel/start', '/api/tunnel/stop',
  '/api/bridges', '/api/keybinds',
  '/api/cli',
  '/api/file-content',
];

app.use((req, res, next) => {
  if (isGuestRequest(req) && ADMIN_ONLY_PREFIXES.some(p => req.path.startsWith(p))) {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
});

// Feature permission enforcement — block guest mutations for disabled features
const FEATURE_PERMISSION_MAP = [
  { prefix: '/api/terminal',      perm: 'terminal' },
  { prefix: '/api/whiteboard',    perm: 'whiteboard' },
  { prefix: '/api/memory',        perm: 'memories' },
  { prefix: '/api/categories',    perm: 'memories' },
  { prefix: '/api/trash',         perm: 'memories' },
  { prefix: '/api/skills-studio', perm: 'skills' },
  { prefix: '/api/browser',       perm: 'browser' },
  { prefix: '/api/cards',         perm: 'cards' },
];

app.use((req, res, next) => {
  if (req.method !== 'GET' && isGuestRequest(req)) {
    const match = FEATURE_PERMISSION_MAP.find(m => req.path.startsWith(m.prefix));
    if (match && !invitePermissions[match.perm]) {
      return res.status(403).json({ error: 'Feature not enabled' });
    }
  }
  next();
});

const PORT = process.env.NEURAL_PORT || 3344;
// SQLite database is used directly via lib/db.js
const EMBEDDING_DIMS = getEmbeddingDims();
const PROJECT_ROOT = resolve(__dirname, '..');
const IMAGES_DIR = resolve(PROJECT_ROOT, 'data', 'images');
if (!existsSync(IMAGES_DIR)) mkdirSync(IMAGES_DIR, { recursive: true });

// ── Image favorites persistence ──
const IMAGE_FAVORITES_PATH = resolve(PROJECT_ROOT, 'data', 'image-favorites.json');
function loadImageFavorites() {
  try { return JSON.parse(readFileSync(IMAGE_FAVORITES_PATH, 'utf-8')); }
  catch { return []; }
}
function saveImageFavorites(favs) {
  writeFileSync(IMAGE_FAVORITES_PATH, JSON.stringify(favs, null, 2));
}

// Sweep stale images on startup (older than 24h, skip favorites)
try {
  const MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const favSet = new Set(loadImageFavorites());
  for (const f of readdirSync(IMAGES_DIR)) {
    if (favSet.has(f)) continue;
    const fp = join(IMAGES_DIR, f);
    try {
      const st = statSync(fp);
      if (Date.now() - st.mtimeMs > MAX_AGE_MS) unlinkSync(fp);
    } catch {}
  }
} catch {}

// Reload config — close cached DB so getDb() reopens at the current SQLITE_DB_PATH
function reloadConfig() {
  closeDb();
  console.log(`  Config reloaded — SQLite: ${getDbPath()}, Embedding: local (${EMBEDDING_DIMS}d)`);
}

// --- Reindex Job State ---
let _reindexJob = null;

// --- Custom File Icons ---
const CUSTOM_ICONS_DIR = resolve(PROJECT_ROOT, 'data', 'custom-icons');
const CUSTOM_ICONS_CONFIG = resolve(PROJECT_ROOT, 'data', 'custom-icons.json');

function loadCustomIconsConfig() {
  try { return JSON.parse(readFileSync(CUSTOM_ICONS_CONFIG, 'utf-8')); }
  catch { return { extensions: {}, filenames: {} }; }
}
function saveCustomIconsConfig(cfg) {
  mkdirSync(CUSTOM_ICONS_DIR, { recursive: true });
  writeFileSync(CUSTOM_ICONS_CONFIG, JSON.stringify(cfg, null, 2));
}

// --- Category Helpers (per-connection) ---

const CATEGORIES_DATA_DIR = resolve(__dirname, '..', 'mcp-server', 'data');
const GLOBAL_CATEGORIES_PATH = resolve(CATEGORIES_DATA_DIR, 'custom-categories.json');
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const CATEGORIES_POINT_ID = '00000000-0000-0000-0000-000000000000';

// Default categories seeded on first startup (new connection)
// Must stay in sync with hooks/claude-code/shared.mjs STANDALONE_DEFAULTS
const DEFAULT_CATEGORIES = [
  {
    name: 'uncategorized',
    description: 'Fallback category for memories stored without an explicit category. Any memory whose category is null, undefined, or empty is automatically assigned here during data normalization. Ensures every memory is always categorized for filtering, sidebar visibility toggling, and graph rendering.',
    color: '#6b7280',
  },
  {
    name: 'conversations',
    description: 'Indexed conversation sessions with compacted summaries for cross-session recall. Stores session metadata (date, branch, session ID, file path) and topic summaries so users can search and retrieve past conversations naturally — e.g. "what did we work on yesterday?" or "remember that conversation about auth?"',
    color: '#a855f7',
    is_parent: true,
  },
  {
    name: 'communication-style',
    description: 'User communication patterns and preferences.',
  },
  {
    name: 'plans',
    description: 'Implementation plans stored after plan mode approval.',
    color: '#06d6a0',
    is_parent: true,
  },
  {
    name: 'ideas',
    description: 'Feature ideas, product concepts, brainstorms, and future plans. A general-purpose category for capturing forward-looking thoughts that haven\'t been implemented yet — new features to build, architectural experiments to try, UX improvements to explore, or any creative concept worth revisiting later.',
    color: '#f59e0b',
  },
];

function getCategoriesPath() {
  // Single categories file — no per-connection paths needed with SQLite
  if (!existsSync(GLOBAL_CATEGORIES_PATH)) {
    const dir = resolve(GLOBAL_CATEGORIES_PATH, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(GLOBAL_CATEGORIES_PATH, JSON.stringify({ version: 1, categories: DEFAULT_CATEGORIES }, null, 2), 'utf-8');
  }

  return GLOBAL_CATEGORIES_PATH;
}

function loadCategories() {
  try {
    const raw = readFileSync(getCategoriesPath(), 'utf-8');
    const data = JSON.parse(raw);
    if (data.version === 1 && Array.isArray(data.categories)) {
      return data.categories;
    }
    return [];
  } catch {
    return [];
  }
}

function saveCategories(categories) {
  const filePath = getCategoriesPath();
  const dir = resolve(filePath, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify({ version: 1, categories }, null, 2), 'utf-8');

  // Write-through to SQLite categories table
  try {
    dbSaveCategories(categories);
  } catch (err) {
    console.error('Failed to sync categories to SQLite:', err.message);
  }
}

// SQLite queries use direct WHERE clauses

// --- .env Helpers ---

const ENV_PATH = resolve(__dirname, '..', '.env');

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
  } catch {
    return {};
  }
}

function writeEnvFile(filePath, vars) {
  const globalVars = {};
  const bridgeVars = {};    // { bridgeId: { FIELD: value } }

  for (const [key, value] of Object.entries(vars)) {
    let match;
    // Skip legacy env vars
    if (key.match(/^QDRANT__|^EMBEDDING__|^QDRANT_ACTIVE$|^EMBEDDING_ACTIVE$|^OPENAI_EMBEDDING_API_KEY$|^OPENAI_API_KEY$/)) {
      continue;
    } else if ((match = key.match(/^BRIDGE__([a-z0-9_]+)__(.+)$/))) {
      const [, id, field] = match;
      if (!bridgeVars[id]) bridgeVars[id] = {};
      bridgeVars[id][field] = value;
    } else {
      globalVars[key] = value;
    }
  }

  const lines = [];

  // Section: Bridges
  const bridgeIds = Object.keys(bridgeVars).sort();
  for (const id of bridgeIds) {
    const fields = bridgeVars[id];
    lines.push(`# -- Bridge: ${id} --`);
    for (const field of ['ENABLED', 'WORKSPACE_PATH', 'LAST_SYNC']) {
      if (fields[field] !== undefined) lines.push(`BRIDGE__${id}__${field}=${fields[field]}`);
    }
    lines.push('');
  }

  // Section: Remaining global keys (SETUP_COMPLETE, NEURAL_PORT, etc.)
  const remaining = Object.keys(globalVars);
  if (remaining.length > 0) {
    lines.push('# -- System --');
    for (const k of remaining) lines.push(`${k}=${globalVars[k]}`);
    lines.push('');
  }

  writeFileSync(filePath, lines.join('\n'), 'utf-8');
}

// --- Connection management removed (SQLite uses a single local file) ---

// --- Bridge Helpers (read/write BRIDGE__<id>__* in .env) ---

function loadBridgeConfig(bridgeId) {
  const vars = parseEnvFile(ENV_PATH);
  const prefix = `BRIDGE__${bridgeId}__`;
  const fields = {};
  let hasAny = false;

  for (const [key, value] of Object.entries(vars)) {
    if (key.startsWith(prefix)) {
      fields[key.slice(prefix.length)] = value;
      hasAny = true;
    }
  }

  if (!hasAny) return null;

  return {
    enabled: fields.ENABLED === 'true',
    workspacePath: fields.WORKSPACE_PATH || null,
    lastSync: fields.LAST_SYNC || null,
  };
}

function saveBridgeConfig(bridgeId, config) {
  const vars = parseEnvFile(ENV_PATH);
  const prefix = `BRIDGE__${bridgeId}__`;

  vars[`${prefix}ENABLED`] = String(config.enabled ?? false);
  if (config.workspacePath) vars[`${prefix}WORKSPACE_PATH`] = config.workspacePath;
  if (config.lastSync) vars[`${prefix}LAST_SYNC`] = config.lastSync;

  writeEnvFile(ENV_PATH, vars);
}

function removeBridgeConfig(bridgeId) {
  const vars = parseEnvFile(ENV_PATH);
  const prefix = `BRIDGE__${bridgeId}__`;

  for (const key of Object.keys(vars)) {
    if (key.startsWith(prefix)) delete vars[key];
  }

  writeEnvFile(ENV_PATH, vars);
}

// migrateConnectionsJsonToEnv() removed

function maskKey(value) {
  if (!value) return '';
  if (value.length <= 4) return '****';
  return '*'.repeat(value.length - 4) + value.slice(-4);
}

// Redirect to onboarding if setup not complete
app.get('/', (req, res, next) => {
  const vars = parseEnvFile(ENV_PATH);
  if (vars.SETUP_COMPLETE === 'true') return next();
  // SQLite + local embeddings need no external config — check if DB exists
  if (existsSync(getDbPath())) return next();
  res.redirect('/onboarding.html');
});

// Serve offline.html dynamically with the real project path injected
app.get('/offline.html', (req, res) => {
  const html = readFileSync(join(__dirname, 'public', 'offline.html'), 'utf-8');
  res.type('html').send(html.replace(
    `const projectDir = localStorage.getItem('synabun-project-dir');`,
    `const projectDir = localStorage.getItem('synabun-project-dir') || ${JSON.stringify(PROJECT_ROOT)};`
  ));
});

app.use('/i18n', express.static(join(__dirname, 'i18n')));
app.use('/games', express.static(join(__dirname, 'games')));
app.use('/skins', express.static(join(__dirname, 'skins'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'),
}));
app.use('/custom-icons', express.static(CUSTOM_ICONS_DIR, {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'),
}));
app.use(express.static(join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'),
}));

// --- Helpers ---

// cosineSimilarity and getEmbedding imported from lib/db.js

// --- Link cache ---
let _linkCache = null;   // { links, pointCount, timestamp }
const _LINK_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function invalidateMemoriesCache(reason) {
  if (_linkCache) {
    _linkCache = null;
    console.log(`[cache] Link cache invalidated (${reason})`);
  }
}

/**
 * Compute links between nodes. Uses pre-computed magnitudes and inverted indexes
 * for file/tag overlap instead of O(n² × m) array intersections.
 */
function computeLinks(nodes) {
  const SIM_THRESHOLD = 0.65;
  const MAX_LINKS_PER_NODE = 8;

  // Load categories to build parent lookup
  let categoryParentMap = {};
  try {
    const catData = JSON.parse(readFileSync(getCategoriesPath(), 'utf-8'));
    for (const cat of catData.categories) {
      categoryParentMap[cat.name] = cat.parent || cat.name;
    }
  } catch (e) {
    console.warn('Could not load categories for parent lookup:', e.message);
  }
  for (const cat of _openclawCategories) {
    categoryParentMap[cat.name] = cat.parent || cat.name;
  }

  const linkMap = new Map();
  function addLink(idA, idB, str, type) {
    const key = idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
    const existing = linkMap.get(key);
    if (existing) {
      existing.strength = Math.max(existing.strength, str);
      if (!existing.types.includes(type)) existing.types.push(type);
    } else {
      linkMap.set(key, { source: idA, target: idB, strength: str, types: [type] });
    }
  }

  // Pre-compute vector magnitudes (halves cosine computation)
  const magnitudes = new Float64Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    if (!nodes[i].vector) continue;
    const v = nodes[i].vector;
    let sum = 0;
    for (let k = 0; k < v.length; k++) sum += v[k] * v[k];
    magnitudes[i] = Math.sqrt(sum);
  }

  // Build inverted indexes for shared files and tags (O(n) instead of O(n²×m))
  const fileIndex = new Map();  // filename → [nodeIndex, ...]
  const tagIndex = new Map();   // tag → [nodeIndex, ...]
  const nodeIdIndex = new Map(); // id → nodeIndex
  for (let i = 0; i < nodes.length; i++) {
    nodeIdIndex.set(nodes[i].id, i);
    const p = nodes[i].payload;
    if (p.related_files) {
      for (const f of p.related_files) {
        let arr = fileIndex.get(f);
        if (!arr) { arr = []; fileIndex.set(f, arr); }
        arr.push(i);
      }
    }
    if (p.tags) {
      for (const t of p.tags) {
        let arr = tagIndex.get(t);
        if (!arr) { arr = []; tagIndex.set(t, arr); }
        arr.push(i);
      }
    }
  }

  // Cosine similarity + same-parent-category (still O(n²) for cosine, but optimized)
  const t0 = Date.now();
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];

      // Cosine similarity with pre-computed magnitudes
      if (a.vector && b.vector && magnitudes[i] > 0 && magnitudes[j] > 0) {
        let dot = 0;
        const va = a.vector, vb = b.vector;
        for (let k = 0; k < va.length; k++) dot += va[k] * vb[k];
        const sim = dot / (magnitudes[i] * magnitudes[j]);
        if (sim > SIM_THRESHOLD) {
          addLink(a.id, b.id, (sim - SIM_THRESHOLD) / (1 - SIM_THRESHOLD), 'similarity');
        }
      }

      // Same parent category
      const parentA = categoryParentMap[a.payload.category];
      const parentB = categoryParentMap[b.payload.category];
      if (parentA && parentB && parentA === parentB) {
        const pairKey = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        const existing = linkMap.get(pairKey);
        if (!existing || existing.strength < 0.3) {
          addLink(a.id, b.id, 0.2, 'family');
        }
      }
    }

    // Explicit related_memory_ids
    if (a.payload.related_memory_ids) {
      for (const relId of a.payload.related_memory_ids) {
        if (nodeIdIndex.has(relId)) {
          addLink(a.id, relId, 0.9, 'manual');
        }
      }
    }
  }

  // Shared files via inverted index (O(pairs) not O(n²×m))
  for (const [, indices] of fileIndex) {
    if (indices.length < 2) continue;
    for (let x = 0; x < indices.length; x++) {
      for (let y = x + 1; y < indices.length; y++) {
        const a = nodes[indices[x]], b = nodes[indices[y]];
        // Count total shared files between this pair
        const aFiles = new Set(a.payload.related_files);
        const shared = b.payload.related_files.filter(f => aFiles.has(f)).length;
        if (shared > 0) addLink(a.id, b.id, 0.3 + shared * 0.15, 'files');
      }
    }
  }

  // Shared tags via inverted index
  for (const [, indices] of tagIndex) {
    if (indices.length < 2) continue;
    for (let x = 0; x < indices.length; x++) {
      for (let y = x + 1; y < indices.length; y++) {
        const a = nodes[indices[x]], b = nodes[indices[y]];
        const aTags = new Set(a.payload.tags);
        const shared = b.payload.tags.filter(t => aTags.has(t)).length;
        if (shared > 0) addLink(a.id, b.id, 0.25 + shared * 0.1, 'tags');
      }
    }
  }

  const elapsed = Date.now() - t0;
  console.log(`[links] Computed ${linkMap.size} raw links from ${nodes.length} nodes in ${elapsed}ms`);

  // Filter and cap per node
  const allCandidates = [];
  for (const link of linkMap.values()) {
    if (link.strength > 0.1) {
      allCandidates.push({ source: link.source, target: link.target, strength: Math.min(link.strength, 1), types: link.types });
    }
  }
  allCandidates.sort((a, b) => b.strength - a.strength);
  const nodeLinkCount = new Map();
  const links = [];
  for (const link of allCandidates) {
    const sc = nodeLinkCount.get(link.source) || 0;
    const tc = nodeLinkCount.get(link.target) || 0;
    const isManual = link.types.includes('manual');
    if (!isManual && sc >= MAX_LINKS_PER_NODE && tc >= MAX_LINKS_PER_NODE) continue;
    links.push(link);
    nodeLinkCount.set(link.source, sc + 1);
    nodeLinkCount.set(link.target, tc + 1);
  }

  return links;
}

// --- Routes ---

// GET /api/memories — All memories, optionally with pre-computed graph edges
// Use ?links=false to skip the expensive link computation (default for initial 3D load)
app.get('/api/memories', async (req, res) => {
  try {
    const includeLinks = req.query.links !== 'false';

    const allPoints = includeLinks ? getAllMemoriesWithVectors() : getAllMemories();

    // Build nodes
    const nodes = allPoints.map(p => ({
      id: p.id,
      payload: { content: p.content, category: p.category, subcategory: p.subcategory, project: p.project, tags: p.tags, importance: p.importance, source: p.source, created_at: p.created_at, updated_at: p.updated_at, accessed_at: p.accessed_at, access_count: p.access_count, related_files: p.related_files, related_memory_ids: p.related_memory_ids, file_checksums: p.file_checksums, trashed_at: p.trashed_at, source_session_chunks: p.source_session_chunks },
      vector: p.vector || null,
    }));

    // Merge OpenClaw bridge nodes
    const ocBridge = loadBridgeConfig('openclaw');
    if (ocBridge?.enabled && _openclawNodes.length > 0) {
      for (const ocNode of _openclawNodes) {
        nodes.push({ ...ocNode, vector: null });
      }
    }

    // Compute or skip links
    let links = [];
    if (includeLinks) {
      if (_linkCache && _linkCache.pointCount === allPoints.length && (Date.now() - _linkCache.timestamp < _LINK_CACHE_TTL)) {
        links = _linkCache.links;
        console.log(`[cache] Serving ${links.length} cached links`);
      } else {
        links = computeLinks(nodes);
        _linkCache = { links, pointCount: allPoints.length, timestamp: Date.now() };
      }
    }

    // Strip vectors from response
    const clientNodes = nodes.map(({ vector, ...rest }) => rest);

    res.json({ nodes: clientNodes, links, totalVectors: allPoints.length, openclawNodes: ocBridge?.enabled ? _openclawNodes.length : 0 });
  } catch (err) {
    console.error('GET /api/memories error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/links — Fetch only the links (lazy-loaded by client when user enables link mode)
app.get('/api/links', async (req, res) => {
  try {
    if (_linkCache && (Date.now() - _linkCache.timestamp < _LINK_CACHE_TTL)) {
      console.log(`[cache] Serving ${_linkCache.links.length} cached links (dedicated endpoint)`);
      return res.json({ links: _linkCache.links });
    }

    const allPoints = getAllMemoriesWithVectors();
    const nodes = allPoints.map(p => ({
      id: p.id,
      payload: { content: p.content, category: p.category, project: p.project, tags: p.tags, importance: p.importance, related_files: p.related_files, related_memory_ids: p.related_memory_ids },
      vector: p.vector,
    }));
    const ocBridge = loadBridgeConfig('openclaw');
    if (ocBridge?.enabled && _openclawNodes.length > 0) {
      for (const ocNode of _openclawNodes) nodes.push({ ...ocNode, vector: null });
    }

    const links = computeLinks(nodes);
    _linkCache = { links, pointCount: allPoints.length, timestamp: Date.now() };

    res.json({ links });
  } catch (err) {
    console.error('GET /api/links error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cache/invalidate — External cache invalidation (called by MCP server)
app.post('/api/cache/invalidate', (req, res) => {
  invalidateMemoriesCache(req.body?.reason || 'external');
  res.json({ ok: true });
});

// POST /api/search — Semantic vector search
app.post('/api/search', async (req, res) => {
  try {
    const { query, limit = 10 } = req.body;
    if (!query) return res.status(400).json({ error: 'query required' });

    const embedding = await getEmbedding(query);
    const results = dbSearchMemories(embedding, limit, { scoreThreshold: 0.3 });

    res.json({
      results: results.map(r => ({
        id: r.id,
        score: r.score,
        payload: { content: r.content, category: r.category, subcategory: r.subcategory, project: r.project, tags: r.tags, importance: r.importance, source: r.source, created_at: r.created_at, updated_at: r.updated_at, accessed_at: r.accessed_at, access_count: r.access_count, related_files: r.related_files, related_memory_ids: r.related_memory_ids, trashed_at: r.trashed_at },
      })),
      query,
    });
  } catch (err) {
    console.error('POST /api/search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats — Memory count including trash count
app.get('/api/stats', async (req, res) => {
  try {
    const stats = getMemoryStats();
    const sessionChunks = countSessionChunks();

    res.json({
      count: stats.total,
      vectors: stats.total + sessionChunks,
      status: 'green',
      trash_count: stats.trashedCount,
    });
  } catch (err) {
    console.error('GET /api/stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/recall-impact — Memory counts by importance threshold for recall settings UI
app.get('/api/recall-impact', (req, res) => {
  try {
    const d = getDb();
    const rows = d.prepare(`
      SELECT importance, COUNT(*) as cnt, CAST(AVG(LENGTH(content)) AS INTEGER) as avg_len
      FROM memories WHERE trashed_at IS NULL GROUP BY importance ORDER BY importance
    `).all();
    res.json({ rows });
  } catch (err) {
    console.error('GET /api/recall-impact error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/memory/:id — Single memory detail
app.get('/api/memory/:id', async (req, res) => {
  try {
    const mem = getMemoryById(req.params.id);
    if (!mem) return res.status(404).json({ error: 'Memory not found' });

    // Return in standard format for UI compatibility
    res.json({ id: mem.id, payload: { content: mem.content, category: mem.category, subcategory: mem.subcategory, project: mem.project, tags: mem.tags, importance: mem.importance, source: mem.source, created_at: mem.created_at, updated_at: mem.updated_at, accessed_at: mem.accessed_at, access_count: mem.access_count, related_files: mem.related_files, related_memory_ids: mem.related_memory_ids, file_checksums: mem.file_checksums, trashed_at: mem.trashed_at, source_session_chunks: mem.source_session_chunks } });
  } catch (err) {
    console.error('GET /api/memory/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/memory/:id — Update a memory's payload fields (category, tags, content)
app.patch('/api/memory/:id', async (req, res) => {
  try {
    const { category, tags, content } = req.body;
    if (!category && tags === undefined && content === undefined) {
      return res.status(400).json({ error: 'category, tags, or content is required' });
    }

    const payload = { updated_at: new Date().toISOString() };

    if (category) {
      const categories = loadCategories();
      if (!categories.some(c => c.name === category)) {
        return res.status(400).json({ error: `Unknown category "${category}".` });
      }
      payload.category = category;
    }

    if (tags !== undefined) {
      if (!Array.isArray(tags)) {
        return res.status(400).json({ error: 'tags must be an array of strings' });
      }
      const clean = [...new Set(tags.map(t => String(t).trim().toLowerCase()).filter(Boolean))];
      payload.tags = clean;
    }

    if (content !== undefined) {
      if (typeof content !== 'string' || !content.trim()) {
        return res.status(400).json({ error: 'content must be a non-empty string' });
      }
      payload.content = content;
    }

    updateMemoryPayload(req.params.id, payload);

    res.json({ ok: true, id: req.params.id, ...payload });
    invalidateMemoriesCache('memory:updated');
    broadcastSync({ type: 'memory:updated', id: req.params.id });
  } catch (err) {
    console.error('PATCH /api/memory/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/categories — All categories with clustering and colors
app.get('/api/categories', (req, res) => {
  try {
    const persisted = loadCategories();

    // Merge ephemeral OpenClaw bridge categories
    const bridgeCfg = loadBridgeConfig('openclaw');
    const categories = bridgeCfg?.enabled && _openclawCategories.length > 0
      ? [...persisted, ..._openclawCategories]
      : persisted;

    // Build category tree for clustering
    const parents = categories.filter(c => !c.parent);
    const tree = {};

    parents.forEach(parent => {
      tree[parent.name] = {
        ...parent,
        children: categories.filter(c => c.parent === parent.name)
      };
    });

    // Return both flat list and tree
    res.json({
      categories: categories, // Full data with parent and color
      tree: tree,
      flat: categories.map(c => ({
        name: c.name,
        description: c.description,
        parent: c.parent,
        color: c.color
      })),
    });
  } catch (err) {
    console.error('GET /api/categories error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/categories — Create a category with optional parent and color
app.post('/api/categories', (req, res) => {
  try {
    const { name, description, parent, color, is_parent } = req.body;
    if (!name || !description) {
      return res.status(400).json({ error: 'name and description are required' });
    }
    if (name.length < 2 || name.length > 30) {
      return res.status(400).json({ error: `Name must be 2-30 characters. Got ${name.length}.` });
    }
    if (!NAME_PATTERN.test(name)) {
      return res.status(400).json({ error: 'Name must be lowercase, start with a letter, only letters/digits/hyphens.' });
    }
    // Validate color format if provided
    if (color && !/^#[0-9a-f]{6}$/i.test(color)) {
      return res.status(400).json({ error: 'Invalid color format. Use hex: #rrggbb' });
    }
    const categories = loadCategories();
    if (categories.some(c => c.name === name)) {
      return res.status(400).json({ error: `Category "${name}" already exists.` });
    }

    const newCategory = {
      name,
      description,
      created_at: new Date().toISOString()
    };
    if (parent) newCategory.parent = parent;
    if (color) newCategory.color = color;
    if (is_parent) newCategory.is_parent = true;

    categories.push(newCategory);
    saveCategories(categories);
    res.json({
      categories: categories,
      message: `Created "${name}"` + (parent ? ` under "${parent}"` : '') + (color ? ` with color ${color}` : '')
    });
    invalidateMemoriesCache('category:created');
    broadcastSync({ type: 'category:created', name });
  } catch (err) {
    console.error('POST /api/categories error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/categories/:name — Update a category
app.put('/api/categories/:name', async (req, res) => {
  try {
    const oldName = req.params.name;
    const { new_name, description, parent, color, is_parent } = req.body;

    const categories = loadCategories();
    let catIndex = categories.findIndex(c => c.name === oldName);

    // Auto-create category if it exists in memories but not in the JSON file
    if (catIndex === -1) {
      categories.push({
        name: oldName,
        description: oldName,
        created_at: new Date().toISOString(),
      });
      catIndex = categories.length - 1;
    }

    // Validate new_name if provided
    if (new_name) {
      if (new_name.length < 2 || new_name.length > 30) {
        return res.status(400).json({ error: `Name must be 2-30 characters. Got ${new_name.length}.` });
      }
      if (!NAME_PATTERN.test(new_name)) {
        return res.status(400).json({ error: 'Name must be lowercase, start with a letter, only letters/digits/hyphens.' });
      }
      if (new_name !== oldName && categories.some(c => c.name === new_name)) {
        return res.status(400).json({ error: `Category "${new_name}" already exists.` });
      }
    }

    // Validate parent if provided
    if (parent !== undefined && parent !== '' && parent !== oldName) {
      if (!categories.some(c => c.name === parent)) {
        return res.status(400).json({ error: `Parent category "${parent}" does not exist.` });
      }

      // Check for circular dependency
      let currentParent = parent;
      while (currentParent) {
        if (currentParent === (new_name || oldName)) {
          return res.status(400).json({ error: `Cannot set parent to "${parent}": would create circular dependency.` });
        }
        const parentCat = categories.find(c => c.name === currentParent);
        currentParent = parentCat?.parent || '';
      }
    }

    // Validate color format if provided
    if (color !== undefined && color !== '' && !/^#[0-9a-f]{6}$/i.test(color)) {
      return res.status(400).json({ error: 'Invalid color format. Use hex: #rrggbb' });
    }

    const cat = categories[catIndex];

    // If renaming, update all children that reference this category as parent AND update memories in SQLite
    if (new_name && new_name !== oldName) {
      categories.forEach(c => {
        if (c.parent === oldName) {
          c.parent = new_name;
        }
      });
      cat.name = new_name;

      // Rename logo file if exists
      if (cat.logo) {
        const pubDir = join(__dirname, 'public');
        const oldExt = cat.logo.split('.').pop();
        const oldLogoPath = join(pubDir, `logo-${oldName}.${oldExt}`);
        const newLogoPath = join(pubDir, `logo-${new_name}.${oldExt}`);
        if (existsSync(oldLogoPath)) {
          renameSync(oldLogoPath, newLogoPath);
          cat.logo = `/logo-${new_name}.${oldExt}`;
        }
      }

      // Update all memories in SQLite that use the old category name
      try {
        const matchingMems = getMemoriesByCategory(oldName);
        if (matchingMems.length > 0) {
          updateMemoriesCategory(matchingMems.map(m => m.id), new_name);
          console.log(`✓ Updated ${matchingMems.length} memories from "${oldName}" to "${new_name}"`);
        }
      } catch (err) {
        console.error('Error updating memories during category rename:', err.message);
      }
    }

    // Update other fields
    if (description !== undefined) cat.description = description;
    if (parent !== undefined) {
      if (parent === '') {
        delete cat.parent;
      } else {
        cat.parent = parent;
      }
    }
    if (color !== undefined) {
      if (color === '') {
        delete cat.color;
      } else {
        cat.color = color;
      }
    }
    if (is_parent !== undefined) {
      if (is_parent) {
        cat.is_parent = true;
      } else {
        delete cat.is_parent;
      }
    }

    saveCategories(categories);

    const changes = [];
    if (description !== undefined) changes.push(`description updated`);
    if (parent !== undefined) changes.push(`parent: ${parent === '' ? 'none' : parent}`);
    if (color !== undefined) changes.push(`color: ${color === '' ? 'auto' : color}`);

    res.json({
      categories: categories,
      message: `Updated "${oldName}"${new_name ? ` → "${new_name}"` : ''}: ${changes.join(', ')}`
    });
    invalidateMemoriesCache('category:updated');
    broadcastSync({ type: 'category:updated', name: new_name || oldName });
  } catch (err) {
    console.error('PUT /api/categories error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/memory/:id — Soft-delete (move to trash) or permanently delete a memory
app.delete('/api/memory/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const permanent = req.query.permanent === 'true';

    if (permanent) {
      hardDeleteMemory(id);
    } else {
      softDeleteMemory(id);
    }

    res.json({ ok: true, id, permanent: !!permanent });
    invalidateMemoriesCache(permanent ? 'memory:deleted' : 'memory:trashed');
    broadcastSync({ type: permanent ? 'memory:deleted' : 'memory:trashed', id });
  } catch (err) {
    console.error('DELETE /api/memory/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════
// TRASH ENDPOINTS
// ═══════════════════════════════════════════

// GET /api/trash — List all trashed memories
app.get('/api/trash', async (req, res) => {
  try {
    const trashed = getTrashedMemories();
    const items = trashed.map(m => ({
      id: m.id,
      payload: { content: m.content, category: m.category, project: m.project, tags: m.tags, importance: m.importance, source: m.source, created_at: m.created_at, trashed_at: m.trashed_at },
    }));
    res.json({ items, count: items.length });
  } catch (err) {
    console.error('GET /api/trash error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/trash/:id/restore — Restore a trashed memory
app.post('/api/trash/:id/restore', async (req, res) => {
  try {
    const id = req.params.id;
    dbRestoreMemory(id);
    invalidateMemoriesCache('memory:restored');
    broadcastSync({ type: 'memory:restored', id });
    res.json({ ok: true, id });
  } catch (err) {
    console.error('POST /api/trash/:id/restore error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/trash/purge — Permanently delete all trashed memories
app.delete('/api/trash/purge', async (req, res) => {
  try {
    const purgedIds = purgeTrash();

    if (purgedIds.length === 0) {
      return res.json({ ok: true, purged: 0 });
    }

    invalidateMemoriesCache('trash:purged');
    broadcastSync({ type: 'trash:purged', count: purgedIds.length });
    res.json({ ok: true, purged: purgedIds.length });
  } catch (err) {
    console.error('DELETE /api/trash/purge error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Hash a file's content with SHA-256, returns null if unreadable
function hashFileContent(filePath) {
  try {
    const absPath = resolve(__dirname, '..', filePath);
    const content = readFileSync(absPath);
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

// GET /api/sync/check — Detect memories whose related files changed via content hash comparison
app.get('/api/sync/check', async (req, res) => {
  try {
    const allMems = getAllMemories();

    // Filter to memories with related_files
    const withFiles = allMems.filter(
      m => m.related_files && m.related_files.length > 0
    ).map(m => ({ id: m.id, payload: m }));

    const stale = [];
    for (const point of withFiles) {
      const storedChecksums = point.payload.file_checksums || {};
      const staleFiles = [];

      for (const filePath of point.payload.related_files) {
        const currentHash = hashFileContent(filePath);
        if (!currentHash) continue; // File not found — skip

        const storedHash = storedChecksums[filePath];
        if (!storedHash || currentHash !== storedHash) {
          staleFiles.push({ path: filePath });
        }
      }

      if (staleFiles.length > 0) {
        stale.push({
          id: point.id,
          content: point.payload.content,
          category: point.payload.category,
          importance: point.payload.importance,
          updated_at: point.payload.updated_at,
          related_files: point.payload.related_files,
          stale_files: staleFiles,
        });
      }
    }

    res.json({
      stale,
      total_checked: allMems.length,
      total_with_files: withFiles.length,
      total_stale: stale.length,
    });
  } catch (err) {
    console.error('GET /api/sync/check error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/categories/:name — Update a category's description
app.patch('/api/categories/:name', (req, res) => {
  try {
    const { name } = req.params;
    const { description } = req.body;
    if (!description || !description.trim()) {
      return res.status(400).json({ error: 'description is required' });
    }

    const categories = loadCategories();
    const cat = categories.find(c => c.name === name);
    if (!cat) {
      return res.status(404).json({ error: `Category "${name}" not found.` });
    }

    cat.description = description.trim();
    saveCategories(categories);

    invalidateMemoriesCache('category:updated');
    broadcastSync({ type: 'category:updated', name });
    res.json({
      categories: categories.map(c => ({ name: c.name, description: c.description })),
    });
  } catch (err) {
    console.error('PATCH /api/categories/:name error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/categories/:name/logo — Upload a logo image for a parent category
app.post('/api/categories/:name/logo',
  express.raw({ type: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], limit: '5mb' }),
  (req, res) => {
    try {
      const { name } = req.params;
      const categories = loadCategories();
      const cat = categories.find(c => c.name === name);
      if (!cat) return res.status(404).json({ error: `Category "${name}" not found.` });

      if (!req.body || req.body.length === 0) {
        return res.status(400).json({ error: 'No image data received.' });
      }

      const contentType = req.headers['content-type'] || 'image/png';
      const extMap = { 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
      const ext = extMap[contentType] || '.png';
      const fileName = `logo-${name}${ext}`;

      const pubDir = join(__dirname, 'public');

      // Remove any old logo files for this category
      for (const existing of readdirSync(pubDir)) {
        if (existing.startsWith(`logo-${name}.`)) unlinkSync(join(pubDir, existing));
      }

      writeFileSync(join(pubDir, fileName), req.body);
      cat.logo = `/${fileName}`;
      saveCategories(categories);

      invalidateMemoriesCache('category:updated');
    broadcastSync({ type: 'category:updated', name });
      res.json({ ok: true, logo: cat.logo, categories });
    } catch (err) {
      console.error('POST /api/categories/:name/logo error:', err.message);
      res.status(500).json({ error: err.message });
    }
  }
);

// DELETE /api/categories/:name/logo — Remove a logo from a parent category
app.delete('/api/categories/:name/logo', (req, res) => {
  try {
    const { name } = req.params;
    const categories = loadCategories();
    const cat = categories.find(c => c.name === name);
    if (!cat) return res.status(404).json({ error: `Category "${name}" not found.` });

    const pubDir = join(__dirname, 'public');
    for (const existing of readdirSync(pubDir)) {
      if (existing.startsWith(`logo-${name}.`)) unlinkSync(join(pubDir, existing));
    }

    delete cat.logo;
    saveCategories(categories);

    invalidateMemoriesCache('category:updated');
    broadcastSync({ type: 'category:updated', name });
    res.json({ ok: true, categories });
  } catch (err) {
    console.error('DELETE /api/categories/:name/logo error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/categories/:name/export — Export all memories in a category as Markdown
app.get('/api/categories/:name/export', async (req, res) => {
  try {
    const { name } = req.params;
    const memories = getMemoriesByCategory(name);

    if (memories.length === 0) {
      return res.status(404).json({ error: `No memories found in category "${name}".` });
    }

    // Build markdown
    let md = `# Memories — ${name}\n\n`;
    md += `> Exported ${memories.length} memor${memories.length === 1 ? 'y' : 'ies'} on ${new Date().toISOString().split('T')[0]}\n\n---\n\n`;

    for (const mem of memories) {
      md += `## ${(mem.content || '').split('\n')[0].substring(0, 80)}\n\n`;
      md += `| Field | Value |\n|---|---|\n`;
      md += `| **ID** | \`${mem.id}\` |\n`;
      if (mem.importance) md += `| **Importance** | ${mem.importance} |\n`;
      if (mem.project) md += `| **Project** | ${mem.project} |\n`;
      if (mem.tags && mem.tags.length) md += `| **Tags** | ${mem.tags.join(', ')} |\n`;
      if (mem.created_at) md += `| **Created** | ${mem.created_at} |\n`;
      if (mem.updated_at) md += `| **Updated** | ${mem.updated_at} |\n`;
      if (mem.related_files && mem.related_files.length) md += `| **Files** | ${mem.related_files.join(', ')} |\n`;
      md += `\n${mem.content || '(empty)'}\n\n---\n\n`;
    }

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}-memories.md"`);
    res.send(md);
  } catch (err) {
    console.error('GET /api/categories/:name/export error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/categories/:name — Delete a category (handles both child categories and memories)
app.delete('/api/categories/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const { reassign_to, reassign_children_to, delete_memories } = req.body || {};
    const reassignTo = reassign_to || req.query.reassign_to;

    const categories = loadCategories();
    const existsInConfig = categories.some(c => c.name === name);

    // Check SQLite for memories using this category
    const matchingMemories = getMemoriesByCategory(name);

    // If not in config and no memories exist, it truly doesn't exist
    if (!existsInConfig && matchingMemories.length === 0) {
      return res.status(404).json({ error: `Category "${name}" not found.` });
    }

    // Check if this is a parent category with children (only relevant for config categories)
    const children = existsInConfig ? categories.filter(c => c.parent === name) : [];
    if (children.length > 0 && reassign_children_to === undefined) {
      return res.status(400).json({
        error: `Cannot delete parent category "${name}": it has ${children.length} child categor${children.length === 1 ? 'y' : 'ies'} (${children.map(c => c.name).join(', ')}).\n\nProvide reassign_children_to in request body to specify a new parent for them, or use empty string "" to make them top-level categories.`,
        children: children.map(c => c.name)
      });
    }

    // Validate reassign_children_to if provided
    if (reassign_children_to !== undefined && reassign_children_to !== '' && !categories.some(c => c.name === reassign_children_to)) {
      return res.status(400).json({ error: `Invalid reassign_children_to: category "${reassign_children_to}" does not exist.` });
    }

    // Handle children reassignment
    let childrenMsg = '';
    if (children.length > 0) {
      children.forEach(child => {
        if (reassign_children_to === '') {
          delete child.parent;
        } else {
          child.parent = reassign_children_to;
        }
      });

      if (reassign_children_to === '') {
        childrenMsg = ` ${children.length} child categor${children.length === 1 ? 'y' : 'ies'} made top-level.`;
      } else {
        childrenMsg = ` ${children.length} child categor${children.length === 1 ? 'y' : 'ies'} reassigned to "${reassign_children_to}".`;
      }
    }

    let deletedCount = 0;
    const memIds = matchingMemories.map(m => m.id);

    if (matchingMemories.length > 0 && delete_memories) {
      // Soft-delete: move all memories to trash
      for (const id of memIds) softDeleteMemory(id);
      deletedCount = memIds.length;
    } else if (matchingMemories.length > 0 && reassignTo) {
      // Reassign memories
      const allNames = new Set(categories.map(c => c.name));
      allNames.delete(name);
      if (!allNames.has(reassignTo)) {
        return res.status(400).json({ error: `Reassign target "${reassignTo}" is not a valid category.` });
      }
      updateMemoriesCategory(memIds, reassignTo);
    } else if (matchingMemories.length > 0) {
      return res.status(409).json({
        error: `${matchingMemories.length} memories use this category. Provide reassign_to to move them or delete_memories to remove them.`,
        count: matchingMemories.length,
      });
    }

    // Remove from categories file (if it was there)
    const updated = existsInConfig ? categories.filter(c => c.name !== name) : categories;
    if (existsInConfig) saveCategories(updated);

    // Clean up logo file if exists
    const pubDir = join(__dirname, 'public');
    for (const f of readdirSync(pubDir)) {
      if (f.startsWith(`logo-${name}.`)) unlinkSync(join(pubDir, f));
    }

    let message = `Deleted "${name}".`;
    if (childrenMsg) message += childrenMsg;
    if (deletedCount > 0) message += ` ${deletedCount} memor${deletedCount === 1 ? 'y' : 'ies'} moved to trash.`;
    if (matchingMemories.length > 0 && reassignTo) message += ` ${matchingMemories.length} memor${matchingMemories.length === 1 ? 'y' : 'ies'} reassigned to "${reassignTo}".`;

    invalidateMemoriesCache('category:deleted');
    broadcastSync({ type: 'category:deleted', name });
    res.json({
      categories: updated,
      message,
      reassigned: reassignTo ? matchingMemories.length : 0,
      deleted: deletedCount,
    });
  } catch (err) {
    console.error('DELETE /api/categories/:name error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/settings — Current config (SQLite + local embeddings)
app.get('/api/settings', (req, res) => {
  try {
    // Ensure DB + schema exist at the configured path before checking
    getDb();
    const dbPath = getDbPath();
    const dbExists = existsSync(dbPath);
    let dbSizeBytes = 0;
    if (dbExists) {
      try { dbSizeBytes = statSync(dbPath).size; } catch {}
    }

    // Check embedding model mismatch
    let embeddingMismatch = false;
    try {
      const storedModel = getKvConfig('embedding_model');
      if (storedModel && storedModel !== EMBEDDING_MODEL) {
        embeddingMismatch = true;
      }
    } catch {}

    res.json({
      storage: 'sqlite',
      dbPath,
      dbExists,
      dbSizeBytes,
      embedding: 'local',
      embeddingModel: EMBEDDING_MODEL,
      embeddingDims: EMBEDDING_DIMS,
      embeddingMismatch,
    });
  } catch (err) {
    console.error('GET /api/settings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings — No external config needed with SQLite + local embeddings
app.put('/api/settings', (req, res) => {
  try {
    // Nothing to configure externally — SQLite + local embeddings are self-contained
    reloadConfig();
    res.json({ ok: true, message: 'Settings reloaded.' });
  } catch (err) {
    console.error('PUT /api/settings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/server/restart — Gracefully restart the server process
app.post('/api/server/restart', (req, res) => {
  console.log('[server] Restart requested — shutting down in 500ms...');
  res.json({ ok: true, message: 'Server restarting...' });
  setTimeout(() => {
    closeDb();
    process.exit(0);
  }, 500);
});

// POST /api/settings/move-db — Move SQLite database to a new directory
app.post('/api/settings/move-db', (req, res) => {
  try {
    const { newPath } = req.body || {};
    if (!newPath) return res.status(400).json({ error: 'newPath is required' });

    const currentDbPath = getDbPath();
    const newDir = resolve(newPath);
    const newDbPath = resolve(newDir, 'memory.db');

    // Must be a different location
    if (resolve(currentDbPath) === newDbPath) {
      return res.status(400).json({ error: 'New path is the same as the current path' });
    }

    // Validate writability
    try {
      mkdirSync(newDir, { recursive: true });
      const testFile = resolve(newDir, '.synabun-write-test');
      writeFileSync(testFile, 'test');
      unlinkSync(testFile);
    } catch (err) {
      return res.status(400).json({ error: `Cannot write to new location: ${err.message}` });
    }

    // Checkpoint WAL to flush pending writes, then close
    try {
      const d = getDb();
      d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {}
    closeDb();

    // Copy database files
    const suffixes = ['', '-wal', '-shm'];
    for (const suffix of suffixes) {
      const src = currentDbPath + suffix;
      const dst = newDbPath + suffix;
      if (existsSync(src)) cpSync(src, dst);
    }

    // Update .env and runtime
    const vars = parseEnvFile(ENV_PATH);
    vars['SQLITE_DB_PATH'] = newDbPath;
    writeEnvFile(ENV_PATH, vars);
    process.env['SQLITE_DB_PATH'] = newDbPath;

    // Reopen from new location
    getDb();
    reloadConfig();

    res.json({ ok: true, oldDbPath: currentDbPath, newDbPath, mcpRestartRequired: true });
  } catch (err) {
    console.error('POST /api/settings/move-db error:', err.message);
    // Try to reopen at original location on failure
    try { getDb(); } catch {}
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/move-db/cleanup — Delete old database files after move
app.post('/api/settings/move-db/cleanup', (req, res) => {
  try {
    const { oldPath } = req.body || {};
    if (!oldPath) return res.status(400).json({ error: 'oldPath is required' });

    const resolvedOldPath = resolve(oldPath);

    // Safety: never delete the active database
    if (resolvedOldPath === resolve(getDbPath())) {
      return res.status(400).json({ error: 'Cannot delete the currently active database' });
    }

    for (const suffix of ['', '-wal', '-shm']) {
      const f = resolvedOldPath + suffix;
      try { if (existsSync(f)) unlinkSync(f); } catch {}
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Reindex Endpoints ---

const REINDEX_BATCH_SIZE = 50;

async function runReindex(job) {
  const d = getDb();

  // Count total work
  const memCount = d.prepare('SELECT COUNT(*) as cnt FROM memories WHERE trashed_at IS NULL').get().cnt;
  const chunkCount = d.prepare('SELECT COUNT(*) as cnt FROM session_chunks').get().cnt;
  job.total = memCount;
  job.totalChunks = chunkCount;

  // Phase 1: Reindex memories
  let offset = 0;
  while (offset < memCount) {
    if (job.cancelled) { job.running = false; return; }

    const rows = d.prepare('SELECT id, content FROM memories WHERE trashed_at IS NULL LIMIT ? OFFSET ?')
                  .all(REINDEX_BATCH_SIZE, offset);
    if (rows.length === 0) break;

    try {
      const texts = rows.map(r => r.content);
      const vectors = await getEmbeddingBatch(texts);
      const updateStmt = d.prepare('UPDATE memories SET vector = ? WHERE id = ?');
      for (let i = 0; i < rows.length; i++) {
        try {
          updateStmt.run(encodeVector(vectors[i]), rows[i].id);
          job.completed++;
        } catch {
          job.errors++;
        }
      }
    } catch {
      job.errors += rows.length;
    }

    offset += REINDEX_BATCH_SIZE;
  }

  // Phase 2: Reindex session chunks
  offset = 0;
  while (offset < chunkCount) {
    if (job.cancelled) { job.running = false; return; }

    const rows = d.prepare('SELECT id, content FROM session_chunks LIMIT ? OFFSET ?')
                  .all(REINDEX_BATCH_SIZE, offset);
    if (rows.length === 0) break;

    try {
      const texts = rows.map(r => r.content || '');
      const vectors = await getEmbeddingBatch(texts);
      const updateStmt = d.prepare('UPDATE session_chunks SET vector = ? WHERE id = ?');
      for (let i = 0; i < rows.length; i++) {
        try {
          updateStmt.run(encodeVector(vectors[i]), rows[i].id);
          job.chunks++;
        } catch {
          job.errors++;
        }
      }
    } catch {
      job.errors += rows.length;
    }

    offset += REINDEX_BATCH_SIZE;
  }

  // Update stored model metadata
  try {
    setKvConfig('embedding_model', EMBEDDING_MODEL);
    setKvConfig('embedding_dims', String(EMBEDDING_DIMS));
  } catch {}

  job.running = false;

  try {
    broadcastSync({ type: 'reindex:complete', jobId: job.jobId, completed: job.completed, chunks: job.chunks, errors: job.errors });
  } catch {}
}

// POST /api/settings/reindex — Start a full embedding reindex
app.post('/api/settings/reindex', async (req, res) => {
  if (_reindexJob && _reindexJob.running) {
    return res.status(409).json({ error: 'Reindex already in progress', jobId: _reindexJob.jobId });
  }

  const jobId = `reindex-${Date.now()}`;
  _reindexJob = { jobId, running: true, cancelled: false, completed: 0, total: 0, totalChunks: 0, chunks: 0, errors: 0 };

  res.json({ ok: true, jobId });

  // Run async — don't await
  runReindex(_reindexJob).catch(err => {
    console.error('[reindex] Fatal error:', err.message);
    if (_reindexJob) { _reindexJob.running = false; _reindexJob.errors++; }
  });
});

// GET /api/settings/reindex/status — Poll reindex progress
app.get('/api/settings/reindex/status', (req, res) => {
  if (!_reindexJob) {
    return res.json({ running: false, completed: 0, total: 0, chunks: 0, totalChunks: 0, errors: 0 });
  }
  res.json({
    running: _reindexJob.running,
    cancelled: _reindexJob.cancelled || false,
    jobId: _reindexJob.jobId,
    completed: _reindexJob.completed,
    total: _reindexJob.total,
    chunks: _reindexJob.chunks,
    totalChunks: _reindexJob.totalChunks,
    errors: _reindexJob.errors,
  });
});

// POST /api/settings/reindex/cancel — Cancel in-progress reindex
app.post('/api/settings/reindex/cancel', (req, res) => {
  if (!_reindexJob || !_reindexJob.running) {
    return res.status(404).json({ error: 'No active reindex job' });
  }
  _reindexJob.cancelled = true;
  res.json({ ok: true });
});

// --- Display Settings Routes (MCP response control) ---

const DISPLAY_SETTINGS_PATH = resolve(__dirname, '..', 'mcp-server', 'data', 'display-settings.json');

function loadDisplaySettings() {
  try {
    return JSON.parse(readFileSync(DISPLAY_SETTINGS_PATH, 'utf-8'));
  } catch {
    return { recallMaxChars: 0 };
  }
}

function saveDisplaySettings(data) {
  const dir = resolve(DISPLAY_SETTINGS_PATH, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(DISPLAY_SETTINGS_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

// GET /api/display-settings — Read current display settings
app.get('/api/display-settings', (req, res) => {
  try {
    res.json(loadDisplaySettings());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/display-settings — Save display settings
app.put('/api/display-settings', (req, res) => {
  try {
    const data = req.body;
    saveDisplaySettings(data);
    res.json({ ok: true, message: 'Display settings saved. Changes take effect on next recall.' });
  } catch (err) {
    console.error('PUT /api/display-settings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════
// SKINS — Community theme system
// ═══════════════════════════════════════════

const SKINS_DIR = join(__dirname, 'skins');
const SKIN_CONFIG_PATH = resolve(PROJECT_ROOT, 'data', 'skin-config.json');
const SKIN_ID_RE = /^[a-z][a-z0-9-]*$/;

function loadSkinConfig() {
  try { return JSON.parse(readFileSync(SKIN_CONFIG_PATH, 'utf-8')); }
  catch { return { active: 'default' }; }
}

function saveSkinConfig(cfg) {
  const dir = resolve(SKIN_CONFIG_PATH, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SKIN_CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// GET /api/skins — List installed skins + active skin ID
app.get('/api/skins', (req, res) => {
  try {
    if (!existsSync(SKINS_DIR)) mkdirSync(SKINS_DIR, { recursive: true });
    const dirs = readdirSync(SKINS_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
    const skins = [];
    for (const d of dirs) {
      const manifestPath = join(SKINS_DIR, d.name, 'skin.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        skins.push({
          id: manifest.id || d.name,
          name: manifest.name || d.name,
          version: manifest.version || '0.0.0',
          author: manifest.author || '',
          description: manifest.description || '',
          css: manifest.css || 'skin.css',
          preview: manifest.preview || null,
          builtin: d.name === 'default',
        });
      } catch { /* skip malformed manifests */ }
    }
    const cfg = loadSkinConfig();
    res.json({ ok: true, skins, active: cfg.active || 'default' });
  } catch (err) {
    console.error('GET /api/skins error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/skins/:id/activate — Activate a skin
app.put('/api/skins/:id/activate', (req, res) => {
  try {
    const { id } = req.params;
    const skinDir = join(SKINS_DIR, id);
    if (!existsSync(skinDir) || !existsSync(join(skinDir, 'skin.json'))) {
      return res.status(404).json({ error: `Skin "${id}" not found` });
    }
    const cfg = loadSkinConfig();
    cfg.active = id;
    saveSkinConfig(cfg);
    // Broadcast to all connected clients
    broadcastSync({ type: 'skin:changed', id });
    res.json({ ok: true, active: id });
  } catch (err) {
    console.error('PUT /api/skins/:id/activate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/skins/upload — Install a skin from ZIP
app.post('/api/skins/upload',
  express.raw({ type: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'], limit: '20mb' }),
  (req, res) => {
  try {
    if (!req.body || req.body.length === 0) {
      return res.status(400).json({ error: 'No data received' });
    }
    const zip = new AdmZip(req.body);
    const entries = zip.getEntries();

    // Find skin.json — root level or one directory deep
    let manifestEntry = entries.find(e => e.entryName === 'skin.json');
    let prefix = '';
    if (!manifestEntry) {
      manifestEntry = entries.find(e => {
        const parts = e.entryName.split('/');
        return parts.length === 2 && parts[1] === 'skin.json';
      });
      if (manifestEntry) prefix = manifestEntry.entryName.replace('skin.json', '');
    }
    if (!manifestEntry) {
      return res.status(400).json({ error: 'skin.json not found in ZIP' });
    }

    let manifest;
    try { manifest = JSON.parse(manifestEntry.getData().toString('utf-8')); }
    catch { return res.status(400).json({ error: 'skin.json is not valid JSON' }); }

    // Validate required fields
    if (!manifest.id || !manifest.name || !manifest.version || !manifest.css) {
      return res.status(400).json({ error: 'skin.json must have id, name, version, and css fields' });
    }
    if (!SKIN_ID_RE.test(manifest.id)) {
      return res.status(400).json({ error: `Invalid skin id "${manifest.id}" — must be lowercase alphanumeric with hyphens` });
    }
    if (manifest.id === 'default') {
      return res.status(400).json({ error: 'Cannot overwrite the built-in default skin' });
    }

    // Verify CSS file exists in ZIP
    const cssPath = prefix + manifest.css;
    if (!entries.find(e => e.entryName === cssPath)) {
      return res.status(400).json({ error: `CSS file "${manifest.css}" not found in ZIP` });
    }

    // Extract to skins directory with path traversal protection
    const targetDir = join(SKINS_DIR, manifest.id);
    if (existsSync(targetDir)) rmSync(targetDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });

    for (const entry of entries) {
      if (entry.isDirectory) continue;
      // Resolve relative to prefix
      let relPath = entry.entryName;
      if (prefix && relPath.startsWith(prefix)) relPath = relPath.slice(prefix.length);
      if (!relPath) continue;

      // Path traversal protection
      const resolved = resolve(targetDir, relPath);
      if (!resolved.startsWith(targetDir + sep) && resolved !== targetDir) continue;

      // Create parent dirs and extract
      const parentDir = dirname(resolved);
      if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
      writeFileSync(resolved, entry.getData());
    }

    res.json({
      ok: true,
      skin: {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        author: manifest.author || '',
        description: manifest.description || '',
        css: manifest.css,
        preview: manifest.preview || null,
        builtin: false,
      }
    });
  } catch (err) {
    console.error('POST /api/skins/upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/skins/:id — Uninstall a skin
app.delete('/api/skins/:id', (req, res) => {
  try {
    const { id } = req.params;
    if (id === 'default') {
      return res.status(400).json({ error: 'Cannot delete the built-in default skin' });
    }
    const skinDir = join(SKINS_DIR, id);
    if (!existsSync(skinDir)) {
      return res.status(404).json({ error: `Skin "${id}" not found` });
    }
    rmSync(skinDir, { recursive: true });
    // Reset to default if the deleted skin was active
    const cfg = loadSkinConfig();
    if (cfg.active === id) {
      cfg.active = 'default';
      saveSkinConfig(cfg);
      broadcastSync({ type: 'skin:changed', id: 'default' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/skins/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════
// CUSTOM FILE ICONS
// ═══════════════════════════════════════════

const ICON_CONTENT_TYPES = ['image/png', 'image/svg+xml', 'image/jpeg', 'image/webp'];
const ICON_EXT_MAP = { 'image/png': '.png', 'image/svg+xml': '.svg', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

// GET /api/file-icons — Return custom icon overrides
app.get('/api/file-icons', (req, res) => {
  res.json({ ok: true, custom: loadCustomIconsConfig() });
});

// POST /api/file-icons/:type/:key — Upload custom icon
app.post('/api/file-icons/:type/:key',
  express.raw({ type: [...ICON_CONTENT_TYPES, 'application/octet-stream'], limit: '2mb' }),
  (req, res) => {
  try {
    const { type, key } = req.params;
    if (type !== 'ext' && type !== 'name') {
      return res.status(400).json({ error: 'type must be "ext" or "name"' });
    }
    if (!key || !/^[a-zA-Z0-9._-]+$/.test(key)) {
      return res.status(400).json({ error: 'Invalid key' });
    }
    if (!req.body || req.body.length === 0) {
      return res.status(400).json({ error: 'No data received' });
    }

    // Determine file extension from content-type
    const ct = req.headers['content-type'] || '';
    let imgExt = ICON_EXT_MAP[ct];
    if (!imgExt) {
      // Try to detect from magic bytes
      const head = req.body.slice(0, 8);
      if (head[0] === 0x89 && head[1] === 0x50) imgExt = '.png';
      else if (head[0] === 0xFF && head[1] === 0xD8) imgExt = '.jpg';
      else if (head.toString().startsWith('RIFF')) imgExt = '.webp';
      else imgExt = '.svg'; // Assume SVG for text-based content
    }

    mkdirSync(CUSTOM_ICONS_DIR, { recursive: true });

    const prefix = type === 'ext' ? 'e_' : 'f_';
    const safeKey = key.toLowerCase().replace(/[^a-z0-9._-]/g, '_');
    const filename = `${prefix}${safeKey}${imgExt}`;

    // Remove previous icons for this key
    if (existsSync(CUSTOM_ICONS_DIR)) {
      for (const f of readdirSync(CUSTOM_ICONS_DIR)) {
        if (f.startsWith(`${prefix}${safeKey}.`)) {
          unlinkSync(resolve(CUSTOM_ICONS_DIR, f));
        }
      }
    }

    writeFileSync(resolve(CUSTOM_ICONS_DIR, filename), req.body);

    // Update config
    const cfg = loadCustomIconsConfig();
    const section = type === 'ext' ? 'extensions' : 'filenames';
    cfg[section][safeKey] = {
      path: filename,
      originalName: req.headers['x-original-name'] || filename,
    };
    saveCustomIconsConfig(cfg);

    res.json({ ok: true, key: safeKey, iconUrl: `/custom-icons/${filename}` });
  } catch (err) {
    console.error('POST /api/file-icons error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/file-icons/:type/:key — Reset a single custom icon
app.delete('/api/file-icons/:type/:key', (req, res) => {
  try {
    const { type, key } = req.params;
    const section = type === 'ext' ? 'extensions' : 'filenames';
    const cfg = loadCustomIconsConfig();
    const entry = cfg[section]?.[key];
    if (entry?.path && existsSync(resolve(CUSTOM_ICONS_DIR, entry.path))) {
      unlinkSync(resolve(CUSTOM_ICONS_DIR, entry.path));
    }
    delete cfg[section][key];
    saveCustomIconsConfig(cfg);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/file-icons/:type/:key error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/file-icons — Reset all custom icons
app.delete('/api/file-icons', (req, res) => {
  try {
    if (existsSync(CUSTOM_ICONS_DIR)) {
      for (const f of readdirSync(CUSTOM_ICONS_DIR)) {
        unlinkSync(resolve(CUSTOM_ICONS_DIR, f));
      }
    }
    saveCustomIconsConfig({ extensions: {}, filenames: {} });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/file-icons error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════
// CLAUDE SKIN — WebSocket handler
// Spawns claude subprocess, streams NDJSON events to client
// ═══════════════════════════════════════════

// ── Session lock registry: prevents two windows from using the same session simultaneously ──
// Map<sessionId, { windowId, wsId, lockedAt, lastHeartbeat }>
const _sessionLocks = new Map();
const SESSION_LOCK_STALE_MS = 45_000; // 45s — locks expire if no heartbeat

function _acquireSessionLock(sessionId, windowId, wsId) {
  if (!sessionId) return { ok: true };
  const existing = _sessionLocks.get(sessionId);
  if (existing && existing.windowId !== windowId) {
    // Check if the lock is stale
    if (Date.now() - existing.lastHeartbeat > SESSION_LOCK_STALE_MS) {
      // Stale lock — take over
      console.log(`[session-lock] Stale lock for ${sessionId} (window ${existing.windowId}) — claimed by ${windowId}`);
    } else {
      return { ok: false, owner: existing.windowId, lockedAt: existing.lockedAt };
    }
  }
  _sessionLocks.set(sessionId, { windowId, wsId, lockedAt: Date.now(), lastHeartbeat: Date.now() });
  return { ok: true };
}

function _releaseSessionLock(sessionId, windowId) {
  if (!sessionId) return;
  const existing = _sessionLocks.get(sessionId);
  if (existing && existing.windowId === windowId) {
    _sessionLocks.delete(sessionId);
  }
}

function _releaseAllLocks(windowId) {
  for (const [sid, lock] of _sessionLocks) {
    if (lock.windowId === windowId) _sessionLocks.delete(sid);
  }
}

function _heartbeatLock(sessionId, windowId) {
  const existing = _sessionLocks.get(sessionId);
  if (existing && existing.windowId === windowId) {
    existing.lastHeartbeat = Date.now();
  }
}

// Cache resolved claude binary path (avoids running `where` every query)
let _claudeBinPath = null;
function getClaudeBin() {
  if (_claudeBinPath) return _claudeBinPath;
  // 0. User-configured path from cli-config.json (set via Settings > Terminal)
  try {
    const cfg = loadCliConfig();
    const userCmd = cfg['claude-code']?.command?.trim();
    if (userCmd && userCmd !== 'claude') {
      // Absolute or relative path — verify it exists
      if (existsSync(userCmd)) {
        _claudeBinPath = userCmd;
        return _claudeBinPath;
      }
      // Might be a bare command in PATH — try which/where
      try {
        const lookup = process.platform === 'win32'
          ? execSync(`where "${userCmd}"`, { encoding: 'utf-8' }).split('\n')[0].trim()
          : execSync(`which "${userCmd}"`, { encoding: 'utf-8' }).trim();
        if (lookup) { _claudeBinPath = lookup; return _claudeBinPath; }
      } catch {}
    }
  } catch {}
  // 1. Try bundled @anthropic-ai/claude-code in node_modules/.bin
  const bundledBase = resolve(__dirname, 'node_modules', '.bin', 'claude');
  // On Windows npm creates .cmd shims — check for those too
  const bundledCandidates = process.platform === 'win32'
    ? [bundledBase + '.cmd', bundledBase + '.ps1', bundledBase]
    : [bundledBase];
  for (const bundled of bundledCandidates) {
    if (!existsSync(bundled)) continue;
    const st = statSync(bundled);
    // npm sometimes creates a plain text stub instead of a symlink — resolve through to cli.js
    if (st.isFile() && st.size < 256) {
      const target = readFileSync(bundled, 'utf-8').trim();
      if (target && !target.startsWith('#')) {
        const resolved = resolve(__dirname, 'node_modules', '.bin', target);
        if (existsSync(resolved)) {
          if (process.platform !== 'win32') {
            try { const rs = statSync(resolved); if (!(rs.mode & 0o111)) chmodSync(resolved, rs.mode | 0o755); } catch {}
          }
          _claudeBinPath = resolved;
          return _claudeBinPath;
        }
      }
    }
    // Normal symlink or executable — ensure +x
    if (process.platform !== 'win32' && !(st.mode & 0o111)) {
      try { chmodSync(bundled, st.mode | 0o755); } catch {}
    }
    _claudeBinPath = bundled;
    return _claudeBinPath;
  }
  // 2. Fall back to global install via which/where
  if (process.platform === 'win32') {
    try { _claudeBinPath = execSync('where claude', { encoding: 'utf-8' }).split('\n')[0].trim(); }
    catch { _claudeBinPath = null; }
  } else {
    try { _claudeBinPath = execSync('which claude', { encoding: 'utf-8' }).trim(); }
    catch { _claudeBinPath = null; }
  }
  if (!_claudeBinPath) {
    console.warn('[claude-skin] Claude CLI not found. Install: npm install -g @anthropic-ai/claude-code');
    _claudeBinPath = 'claude'; // last resort — will fail at spawn time with a clear error
  }
  return _claudeBinPath;
}

// Convert a project path to Claude Code's directory name format.
// Claude stores sessions at ~/.claude/projects/<key>/<sessionId>.jsonl
// where <key> is the path with all separators replaced by hyphens.
function pathToClaudeKey(p) {
  return p.replace(/[/\\]/g, '-').replace(/:/g, '-');
}

// ── Orphan process registry ──
// When a WebSocket closes (page refresh), we don't kill the process immediately.
// Instead we "orphan" it: buffer events for up to 30s, allowing the reconnecting
// client to reattach via a `reattach` message with the same windowId.
const _orphanedProcs = new Map(); // windowId → { proc, state, buffer, killTimer, sendToClient, ... }
const ORPHAN_GRACE_MS = 30_000;

function handleClaudeSkinWebSocket(ws) {
  const SKIN_DEBUG = process.env.CLAUDE_SKIN_DEBUG === '1';
  let activeProc = null;
  let procSessionId = null;
  let procModel = null;
  let procCwd = null;
  let procEffort = null;
  let lastPrompt = null;     // last prompt text — used for auto-retry on session-not-found
  let inTurn = false;        // true while CLI is processing a user message
  let lastEventTime = Date.now(); // shared with stall detector
  const approvedTools = new Set(); // tools the user has approved — persists across respawns
  let lastPermissionDenials = null; // cached for retry after approval
  let awaitingPermission = false; // true when permission card shown, suppresses 'done' from close handler
  const permCardToolNames = new Map(); // requestId → toolName, for proactive permission cards
  const lastCostBySession = new Map(); // sessionId → last cumulative cost (total_cost_usd is cumulative)
  let wsWindowId = null; // set by first query message — used for lock cleanup on close
  let _orphanBuffer = null; // when non-null, sendToClient buffers here instead of sending over WS
  let prevTurnTokens = 0; // total input tokens from last turn — used to detect auto-compact (>50% drop)

  // Strip env vars that interfere with nested claude execution
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) =>
      k !== 'CLAUDECODE' &&
      !k.startsWith('VSCODE_') &&
      k !== 'TERM_PROGRAM' &&
      k !== 'TERM_PROGRAM_VERSION'
    )
  );

  // ── Auto-compact early detection via pending-compact file watcher ──
  // Pre-compact hook writes data/pending-compact/{sessionId}.json BEFORE compaction.
  // Watch for new files and send compact_started event to UI immediately.
  const _pendingCompactDir = resolve(PROJECT_ROOT, 'data', 'pending-compact');
  let _compactWatcher = null;
  const _seenCompactFiles = new Set();
  try {
    mkdirSync(_pendingCompactDir, { recursive: true });
    // Seed with existing files so we only react to NEW ones
    try { readdirSync(_pendingCompactDir).forEach(f => _seenCompactFiles.add(f)); } catch {}
    _compactWatcher = fsWatch(_pendingCompactDir, (eventType, filename) => {
      if (!filename || !filename.endsWith('.json') || _seenCompactFiles.has(filename)) return;
      _seenCompactFiles.add(filename);
      if (!activeProc || !inTurn) return;
      console.log(`[claude-skin] Pre-compact hook detected: ${filename}`);
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'event', event: { type: 'system', subtype: 'compact_started', message: 'Auto-compacting context\u2026' } }));
    });
  } catch (e) {
    console.log('[claude-skin] Could not watch pending-compact dir:', e.message);
  }

  function killProc() {
    if (!activeProc) return;
    try { activeProc.kill(); } catch {}
    activeProc = null;
    awaitingPermission = false;
    lastPermissionDenials = null;
  }

  function validateWorkDir(cwd) {
    if (!cwd) return null;
    // Reject Windows-style paths on POSIX (e.g., "J:\Sites\Apps\Synabun")
    if (process.platform !== 'win32' && /^[A-Za-z]:[\\\/]/.test(cwd)) {
      console.log('[claude-skin] Rejected Windows path on POSIX:', cwd);
      return null;
    }
    // Reject POSIX-style paths on Windows (e.g., "/Users/foo/bar")
    if (process.platform === 'win32' && cwd.startsWith('/')) {
      console.log('[claude-skin] Rejected POSIX path on Windows:', cwd);
      return null;
    }
    // Reject non-existent directories
    if (!existsSync(cwd)) {
      console.log('[claude-skin] Rejected non-existent cwd:', cwd);
      return null;
    }
    return cwd;
  }

  function spawnProc(sessionId, model, cwd, effort, prompt) {
    killProc();
    const workDir = validateWorkDir(cwd) || PROJECT_ROOT;
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'default',
      // ============================================================
      // NO --input-format stream-json: suppresses result events with open stdin.
      // NO --include-partial-messages: each partial includes FULL cumulative
      //   content → 50MB+ through pipe on long turns → backpressure stalls CLI.
      //   Live text rendering uses stream_event deltas instead (small payloads).
      // ============================================================
    ];
    // Pre-approve tools the user has already allowed this session.
    // NOTE: Do NOT add AskUserQuestion here — --allowedTools causes the CLI to EXECUTE it
    // (hanging on stdin in --print mode) instead of DENYING it (which triggers the
    // permission_denial → control_request → ask card flow we actually want).
    if (approvedTools.size > 0) {
      args.push('--allowedTools', [...approvedTools].join(','));
    }
    // Allow access to parent directory so the model can reach sibling projects
    const parentDir = dirname(workDir);
    if (parentDir && parentDir !== workDir) args.push('--add-dir', parentDir);
    if (sessionId) args.push('--resume', sessionId);
    if (model) args.push('--model', model);
    if (effort && ['low', 'medium', 'high', 'max'].includes(effort)) args.push('--effort', effort);
    const claudeBin = getClaudeBin();
    // On Windows, .cmd/.bat batch files REQUIRE shell:true (cmd.exe /c) to execute.
    // Without it, spawn() fires ENOENT because CreateProcessW can't run batch scripts directly.
    const useShell = !claudeBin.includes(sep)
      || (process.platform === 'win32' && /\.(cmd|bat)$/i.test(claudeBin));
    console.log('[claude-skin] Spawning:', claudeBin, args.join(' '), 'cwd:', workDir);

    // ── Zero-pipe spawn: temp files for stdin AND stdout ──
    // Windows named pipes deadlock when CLI writes faster than Node.js reads.
    // Even with only stdout as a pipe, the 4-64KB buffer fills during large
    // assistant events → CLI blocks on write → Node waits for data → deadlock.
    // (issues: anthropics/claude-code#771, #25629, nodejs/node#29238)
    //
    // Fix: ALL stdio goes through temp files. No pipes at all.
    // - stdin: prompt written to file, fd passed to spawn
    // - stdout: fd opened for writing, passed to spawn; polled every 50ms
    // - stderr: inherited to server terminal (TTY, never blocks)
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let promptTmpFile = null;
    let stdinFd = null;
    if (prompt) {
      promptTmpFile = join(os.tmpdir(), `claude-skin-${runId}-in.txt`);
      writeFileSync(promptTmpFile, prompt, 'utf-8');
      stdinFd = openSync(promptTmpFile, 'r');
    }
    const stdoutTmpFile = join(os.tmpdir(), `claude-skin-${runId}-out.jsonl`);
    writeFileSync(stdoutTmpFile, '', 'utf-8');
    const stdoutFd = openSync(stdoutTmpFile, 'w');

    const proc = spawn(claudeBin, args, {
      cwd: workDir,
      env: { ...cleanEnv, ENABLE_TOOL_SEARCH: 'true' },
      stdio: [stdinFd !== null ? stdinFd : 'inherit', stdoutFd, 'inherit'],
      shell: useShell,
    });

    // Close parent copies of write fds (child has its own via dup2)
    if (stdinFd !== null) { try { closeSync(stdinFd); } catch {} }
    try { closeSync(stdoutFd); } catch {}
    // Open a persistent read fd for polling (fstatSync on fd → real-time FCB size,
    // unlike statSync on path which reads lazily-updated NTFS directory entries)
    const readFd = openSync(stdoutTmpFile, 'r');
    activeProc = proc;
    procSessionId = sessionId;
    procModel = model;
    procCwd = cwd;
    procEffort = effort;
    console.log('[claude-skin] Process spawned, pid:', proc.pid);

    let buf = '';
    lastEventTime = Date.now();
    inTurn = false;
    let eventCount = 0;
    let lastLoggedType = '';

    function sendToClient(data) {
      // If orphaned, buffer events for replay on reattach
      if (_orphanBuffer) { _orphanBuffer.push(data); return; }
      if (ws.readyState === 1) ws.send(JSON.stringify(data));
    }

    // Stall detector — auto-retry when no stdout events for a while during an active turn.
    // Effort-based timeout: extended thinking with max effort can take 5+ minutes.
    // Killing during thinking causes a kill-restart loop that never lets the model finish.
    const STALL_WARN_SEC = 30;
    const STALL_KILL_SEC = effort === 'max' ? 300 : effort === 'high' ? 120 : 45;
    const MAX_RETRIES = 2;
    let stallRetries = 0;
    console.log(`[claude-skin] Stall timeout: ${STALL_KILL_SEC}s (effort: ${effort || 'default'})`);
    const stallCheck = setInterval(() => {
      if (activeProc !== proc) { clearInterval(stallCheck); return; }
      if (!inTurn) return;
      const silentSec = Math.round((Date.now() - lastEventTime) / 1000);
      if (silentSec >= STALL_WARN_SEC) {
        // Diagnostic: check actual file size vs what we've read
        let fileSize = 0;
        try { fileSize = fstatSync(readFd).size; } catch {}
        const unread = fileSize - tailOffset;
        console.log(`[claude-skin] ⚠ STALL: no events for ${silentSec}s | fileSize=${fileSize} tailOffset=${tailOffset} unread=${unread}b | events=${eventCount} | last=${lastLoggedType} | pid=${proc.pid} killed=${proc.killed} exitCode=${proc.exitCode}`);
        if (unread > 0) {
          console.log(`[claude-skin] ℹ File has ${unread}b unread data — CLI is writing, polling may be stale`);
        }
      }
      if (silentSec >= STALL_KILL_SEC && !proc.killed) {
        if (stallRetries < MAX_RETRIES) {
          stallRetries++;
          console.log(`[claude-skin] ⚡ STALL RETRY ${stallRetries}/${MAX_RETRIES} — respawning with --resume`);
          killProc();
          sendToClient({ type: 'event', event: { type: 'system', subtype: 'retry', message: `Stream stalled — retrying (${stallRetries}/${MAX_RETRIES})...` } });
          const sid = procSessionId;
          spawnProc(sid, procModel, procCwd, procEffort, 'The previous turn was interrupted by an API stream drop. Please continue from where you left off.');
          inTurn = true;
          lastEventTime = Date.now();
        } else {
          console.log(`[claude-skin] ✗ STALL TIMEOUT — max retries exhausted`);
          killProc();
          sendToClient({ type: 'error', message: `Session stalled after ${MAX_RETRIES} retries. The API stream keeps dropping. Try a simpler message or switch to a faster model.` });
          sendToClient({ type: 'done', code: -1 });
        }
      }
    }, 15000);

    // ── Process stdout events from a line of JSON ──
    function processEvent(trimmed) {
      try {
        const event = JSON.parse(trimmed);
        eventCount++;
        // Track session_id from init event
        if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
          procSessionId = event.session_id;
          console.log('[claude-skin] procSessionId updated from init:', procSessionId);
        }
        // Log non-stream events (gated behind CLAUDE_SKIN_DEBUG to avoid blocking event loop)
        if (event.type !== 'stream_event') {
          lastLoggedType = event.type + (event.subtype ? '/' + event.subtype : '');
          if (SKIN_DEBUG) {
            const contentArr = Array.isArray(event.message?.content) ? event.message.content : [];
            const toolNames = contentArr.filter(b => b.type === 'tool_use').map(b => b.name).join(',');
            if (toolNames) lastLoggedType += ':' + toolNames;
            console.log(`[claude-skin] Event #${eventCount}: ${lastLoggedType}`);
          }
        }
        // Track session_id + cost from result events
        if (event.type === 'result') {
          inTurn = false;
          // Log error details for error_during_execution results
          if (event.subtype === 'error_during_execution' || event.subtype === 'error') {
            const errMsg = (event.errors && event.errors[0]) || event.error || event.result || 'unknown';
            console.log(`[claude-skin] ✗ CLI error: ${errMsg}`);
            // Auto-retry without --resume if session was deleted
            if (typeof errMsg === 'string' && errMsg.includes('No conversation found')) {
              console.log('[claude-skin] Session not found — retrying as new conversation');
              procSessionId = null;
              sendToClient({ type: 'event', event: { type: 'system', subtype: 'session_reset', message: 'Previous session was deleted. Starting fresh conversation.' } });
              // Re-spawn without --resume, reusing the last prompt from the temp file
              killProc();
              spawnProc(null, procModel, procCwd, procEffort, lastPrompt);
              return;
            }
          }
          if (event.session_id) procSessionId = event.session_id;
          if (typeof event.total_cost_usd === 'number' && event.total_cost_usd > 0) {
            const sid = event.session_id || procSessionId;
            const prev = lastCostBySession.get(sid) || 0;
            const delta = event.total_cost_usd - prev;
            lastCostBySession.set(sid, event.total_cost_usd);
            if (delta > 0) { try { addCost(delta, sid); } catch {} }
          }
          // ── Auto-compact detection via token count drop ──
          // When context is compacted, total input tokens drop significantly.
          // Detect >50% drop between turns and inject a synthetic compact_boundary event.
          if (event.usage) {
            const u = event.usage;
            const currTotal = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
            if (prevTurnTokens > 0 && currTotal > 0 && currTotal < prevTurnTokens * 0.5) {
              console.log(`[claude-skin] Auto-compact detected: ${prevTurnTokens} → ${currTotal} tokens (${Math.round((1 - currTotal / prevTurnTokens) * 100)}% drop)`);
              sendToClient({ type: 'event', event: { type: 'system', subtype: 'compact_detected', message: `Context auto-compacted (${Math.round(prevTurnTokens / 1000)}K → ${Math.round(currTotal / 1000)}K)` } });
            }
            prevTurnTokens = currTotal;
          }
          // Force-kill if process doesn't exit within 5s after result
          // (known Claude CLI issue #25629: process hangs with open stdout after completion)
          setTimeout(() => {
            if (proc.exitCode === null && !proc.killed && activeProc === proc) {
              console.log('[claude-skin] Force-killing process after result (hung exit)');
              try { proc.kill(); } catch {}
            }
          }, 5000);
          // ── Permission denial → permission card ──
          const denials = event.permission_denials;
          if (denials?.length > 0) {
            lastPermissionDenials = denials;
            awaitingPermission = true;
            for (const denial of denials) {
              const requestId = `perm-${denial.tool_use_id}`;
              const input = denial.tool_input || {};
              console.log(`[claude-skin] ▶ Permission denied for ${denial.tool_name} → sending permission card ${requestId}`);
              sendToClient({
                type: 'control_request',
                request_id: requestId,
                request: { tool_name: denial.tool_name, subtype: 'can_use_tool', input },
              });
            }
            return; // Don't send 'done' yet — wait for user response
          }
        }
        // ── Proactive permission card ──
        if (event.type === 'assistant') {
          const GATED_TOOLS = ['Edit', 'Write', 'MultiEdit', 'Bash'];
          const toolUses = (event.message?.content || []).filter(b => b.type === 'tool_use');
          for (const tool of toolUses) {
            // AskUserQuestion: send control_request so the client renders an interactive
            // ask card instead of letting it fall through as a permission_denial later.
            // This is the primary trigger — the permission_denial path is a backup.
            if (tool.name === 'AskUserQuestion') {
              const requestId = `perm-${tool.id}`;
              const input = tool.input || {};
              permCardToolNames.set(requestId, 'AskUserQuestion');
              console.log(`[claude-skin] ▶ AskUserQuestion detected → sending control_request`);
              sendToClient({
                type: 'control_request',
                request_id: requestId,
                request: { tool_name: 'AskUserQuestion', subtype: 'can_use_tool', input },
              });
              awaitingPermission = true;
              continue;
            }
            if (GATED_TOOLS.includes(tool.name) && !approvedTools.has(tool.name)) {
              const requestId = `perm-${tool.id}`;
              const input = tool.input || {};
              permCardToolNames.set(requestId, tool.name);
              console.log(`[claude-skin] ▶ PROACTIVE permission card for ${tool.name}: ${input.file_path || input.command || ''}`);
              sendToClient({
                type: 'control_request',
                request_id: requestId,
                request: { tool_name: tool.name, subtype: 'can_use_tool', input },
              });
            }
          }
        }
        // Forward all events to client
        sendToClient({ type: 'event', event });
      } catch (e) { console.log('[claude-skin] JSON parse error:', e.message, 'line:', trimmed.substring(0, 120)); }
    }

    // ── Poll stdout temp file instead of using pipe ──
    // No pipes = no deadlock. CLI writes to file (never blocks), we poll at ~60fps.
    // Uses persistent readFd + fstatSync for real-time file size (bypasses NTFS directory cache).
    let tailOffset = 0;
    let _readBuf = Buffer.alloc(65536); // 64KB reusable buffer — avoids per-poll allocation + GC pressure
    const tailPoll = setInterval(() => {
      if (activeProc !== proc) { clearInterval(tailPoll); return; }
      try {
        const size = fstatSync(readFd).size;
        if (size <= tailOffset) return;
        const needed = size - tailOffset;
        if (needed > _readBuf.length) _readBuf = Buffer.alloc(Math.max(needed, _readBuf.length * 2));
        const bytesRead = readSync(readFd, _readBuf, 0, needed, tailOffset);
        tailOffset += bytesRead;
        lastEventTime = Date.now();
        buf += _readBuf.toString('utf-8', 0, bytesRead);
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          processEvent(trimmed);
        }
      } catch {}
    }, 16);

    proc.on('close', (code) => {
      clearInterval(stallCheck);
      clearInterval(tailPoll);
      const isStale = activeProc !== proc;
      if (!isStale) {
        // Final flush — read any remaining data from stdout file (only for active process)
        try {
          const size = fstatSync(readFd).size;
          if (size > tailOffset) {
            const needed = size - tailOffset;
            if (needed > _readBuf.length) _readBuf = Buffer.alloc(needed);
            const bytesRead = readSync(readFd, _readBuf, 0, needed, tailOffset);
            buf += _readBuf.toString('utf-8', 0, bytesRead);
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              processEvent(trimmed);
            }
          }
        } catch {}
      }
      // Always clean up temp files
      try { closeSync(readFd); } catch {}
      if (promptTmpFile) { try { unlinkSync(promptTmpFile); } catch {} }
      try { unlinkSync(stdoutTmpFile); } catch {}
      console.log(`[claude-skin] Process closed, code: ${code}, events: ${eventCount}, buf: ${buf.length}b, stale: ${isStale}, awaitingPermission: ${awaitingPermission}`);
      if (isStale) return;
      // Process any remaining partial line in buf
      if (buf.trim()) {
        console.log(`[claude-skin] Flushing final buf (${buf.length}b): ${buf.substring(0, 200)}`);
        processEvent(buf.trim());
      }
      // Don't send 'done' if we're showing a permission card — the user hasn't responded yet.
      // 'done' will be sent after the user allows (via respawn+retry) or denies.
      if (!awaitingPermission) {
        sendToClient({ type: 'done', code });
      }
      activeProc = null;
    });

    proc.on('error', (err) => {
      clearInterval(stallCheck);
      clearInterval(tailPoll);
      try { closeSync(readFd); } catch {}
      console.log('[claude-skin] Process error:', err.message);
      if (activeProc !== proc) return;
      const userMsg = err.code === 'ENOENT'
        ? 'Claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code'
        : err.message;
      sendToClient({ type: 'error', message: userMsg });
      sendToClient({ type: 'done', code: -1 });
      activeProc = null;
    });

    return proc;
  }

  // ── Skill injection for slash commands (print mode doesn't support them natively) ──
  function resolveSkillPrompt(command, args) {
    const dirs = [
      join(SKILLS_SOURCE_DIR, command),
      join(getGlobalSkillsDir(), command),
    ];
    for (const dir of dirs) {
      const file = join(dir, 'SKILL.md');
      if (existsSync(file)) {
        let content = readFileSync(file, 'utf-8');
        content = content.replace(/\$ARGUMENTS/g, args || '(none)');
        return { content, dir };
      }
    }
    return null;
  }

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'query') {
        let { prompt, cwd, sessionId, model, effort, images, windowId } = msg;
        if (windowId) wsWindowId = windowId;
        // Strip composite ":contextWindow" suffix (e.g. "claude-opus-4-6:1000000" → "claude-opus-4-6")
        if (model && model.includes(':')) model = model.split(':')[0];
        if (!prompt && !images?.length) return ws.send(JSON.stringify({ type: 'error', message: 'No prompt provided' }));

        // ── Session lock: prevent two windows from using the same session ──
        if (sessionId && wsWindowId) {
          const lockResult = _acquireSessionLock(sessionId, wsWindowId, null);
          if (!lockResult.ok) {
            ws.send(JSON.stringify({ type: 'error', message: `Session locked by another window` }));
            return;
          }
        }

        // ── Slash command → skill injection ──
        if (prompt && prompt.startsWith('/')) {
          const parts = prompt.slice(1).split(/\s+/);
          const cmd = parts[0].toLowerCase();
          const args = parts.slice(1).join(' ');
          if (cmd === 'clear') return; // client-only command
          const skill = resolveSkillPrompt(cmd, args);
          if (skill) {
            console.log('[claude-skin] Skill injection: /' + cmd, 'dir:', skill.dir);
            prompt = `<skill-instructions>\nBase directory for this skill: ${skill.dir}\n\n${skill.content}\n</skill-instructions>\n\nThe user invoked the /${cmd} command${args ? ' with arguments: ' + args : ''}. Follow the skill instructions above exactly.`;
          }
        }

        // Seed lastCostBySession from persisted data to prevent double-counting on reconnect
        if (sessionId && !lastCostBySession.has(sessionId)) {
          const stored = getSessionCost(sessionId);
          if (stored > 0) lastCostBySession.set(sessionId, stored);
        }

        // ── Image attachments → temp files + prompt injection ──
        // Claude Code CLI (--print, text stdin) can't receive multimodal content directly.
        // Save images to temp files and prepend paths so Claude uses the Read tool to view them.
        if (images?.length) {
          const imgPaths = [];
          for (let i = 0; i < images.length; i++) {
            const img = images[i];
            if (!img.base64) continue;
            const ext = (img.mediaType === 'image/png') ? 'png'
              : (img.mediaType === 'image/webp') ? 'webp'
              : (img.mediaType === 'image/gif') ? 'gif' : 'jpg';
            const tmpPath = join(IMAGES_DIR, `synabun-img-${Date.now()}-${i}.${ext}`);
            try {
              writeFileSync(tmpPath, Buffer.from(img.base64, 'base64'));
              imgPaths.push(tmpPath);
            } catch (err) {
              console.warn(`[claude-skin] Failed to save image ${i}:`, err.message);
            }
          }
          if (imgPaths.length) {
            const imgBlock = imgPaths.length === 1
              ? `The user attached an image. Use the Read tool to view it:\n${imgPaths[0]}\n\n`
              : `The user attached ${imgPaths.length} images. Use the Read tool to view them:\n${imgPaths.join('\n')}\n\n`;
            prompt = imgBlock + (prompt || '');
            console.log(`[claude-skin] Saved ${imgPaths.length} image(s) to temp files`);
          }
        }

        // Each message = fresh process. Without --input-format stream-json,
        // the CLI reads text from stdin (temp file), processes one turn, emits result, and exits.
        // Session continuity via --resume sessionId.
        console.log('[claude-skin] Sending prompt, length:', prompt.length);
        lastPrompt = prompt;
        spawnProc(sessionId || null, model || null, cwd || null, effort || null, prompt);
        inTurn = true;
        lastEventTime = Date.now();
      }

      if (msg.type === 'control_response') {
        const rid = msg.request_id || msg.response?.request_id;
        const innerResponse = msg.response?.response || msg.response;
        const behavior = innerResponse?.behavior || msg.response?.behavior;

        // ── Permission card response (proactive or from permission_denials) ──
        if (rid && rid.startsWith('perm-')) {
          // Extract tool name from proactive card map, cached denials, or response
          const toolName = permCardToolNames.get(rid) || lastPermissionDenials?.find(d => `perm-${d.tool_use_id}` === rid)?.tool_name || 'unknown';
          permCardToolNames.delete(rid);
          console.log(`[claude-skin] ▶ Permission response for ${toolName}: ${behavior}`);

          if (behavior === 'allow') {
            // ── AskUserQuestion: extract user's answer and respawn with it ──
            if (toolName === 'AskUserQuestion') {
              const answers = innerResponse?.updatedInput?.answers || msg.response?.updatedInput?.answers;
              const answerText = answers ? Object.values(answers).join(', ') : '';
              console.log(`[claude-skin] ▶ AskUserQuestion answered: "${answerText}"`);
              const sid = procSessionId;
              const answerPrompt = answerText
                ? `The user answered your question: "${answerText}"\nContinue based on their selection.`
                : 'The user did not provide an answer. Continue with your best judgement.';
              spawnProc(sid, procModel, procCwd, procEffort, answerPrompt);
              inTurn = true;
              lastEventTime = Date.now();
              lastPermissionDenials = null;
              awaitingPermission = false;
              return;
            }
            // Add tool to approved set
            approvedTools.add(toolName);
            // Check "always" flag
            if (innerResponse?.always || msg.response?.always) {
              console.log(`[claude-skin] ▶ Always-allow: ${toolName}`);
            }
            // Respawn with updated --allowedTools and retry
            console.log(`[claude-skin] ▶ Respawning with approved tools: ${[...approvedTools].join(', ')}`);
            const sid = procSessionId;
            const retryPrompt = `Permission granted for ${toolName}. Please retry your previous action.`;
            spawnProc(sid, procModel, procCwd, procEffort, retryPrompt);
            inTurn = true;
            lastEventTime = Date.now();
          } else {
            // User denied — send done to client
            console.log(`[claude-skin] ✗ Permission denied for ${toolName} by user`);
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'done', code: 0 }));
          }
          lastPermissionDenials = null;
          awaitingPermission = false;
          return;
        }

        // No stream-json input — control_responses are handled via respawn flows above
        console.log('[claude-skin] Unhandled control_response:', rid);
      }

      if (msg.type === 'tool_result') {
        // AskUserQuestion answer — process already exited (text input mode).
        // Respawn with --resume to continue the session with the user's answer.
        const answer = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        console.log('[claude-skin] Tool result (AskUserQuestion) → respawn with answer:', answer.slice(0, 200));
        const sid = procSessionId;
        const answerPrompt = `The user answered your AskUserQuestion: ${answer}\nContinue with their selection.`;
        spawnProc(sid, procModel, procCwd, procEffort, answerPrompt);
        inTurn = true;
        lastEventTime = Date.now();
      }

      if (msg.type === 'compact') {
        // Compact via respawn with /compact as the prompt
        const sid = procSessionId;
        console.log('[claude-skin] Compact requested, spawning with /compact');
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'event', event: { type: 'system', subtype: 'compact_started', message: 'Compacting context...' } }));
        spawnProc(sid, procModel, procCwd, procEffort, '/compact');
        inTurn = true;
        lastEventTime = Date.now();
      }

      if (msg.type === 'abort') {
        killProc();
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'aborted' }));
      }

      if (msg.type === 'heartbeat') {
        if (msg.windowId) wsWindowId = msg.windowId;
        if (msg.sessionId && wsWindowId) _heartbeatLock(msg.sessionId, wsWindowId);
      }
    } catch { /* ignore malformed */ }
  });

  // ── Reattach: reconnecting client reclaims orphaned process ──
  ws.on('message', function _reattachHandler(raw) {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== 'reattach') return;
      const wid = msg.windowId;
      if (!wid) return;
      wsWindowId = wid;
      const orphan = _orphanedProcs.get(wid);
      if (!orphan || !orphan.proc || orphan.proc.killed || orphan.proc.exitCode !== null) {
        // No live orphan — tell client nothing to reattach
        ws.send(JSON.stringify({ type: 'reattach_result', ok: false }));
        if (orphan) { clearTimeout(orphan.killTimer); _orphanedProcs.delete(wid); }
        return;
      }
      // Reclaim the orphaned process
      clearTimeout(orphan.killTimer);
      activeProc = orphan.proc;
      procSessionId = orphan.sessionId;
      procModel = orphan.model;
      procCwd = orphan.cwd;
      procEffort = orphan.effort;
      inTurn = orphan.inTurn;
      lastEventTime = orphan.lastEventTime;
      awaitingPermission = orphan.awaitingPermission;
      lastPrompt = orphan.lastPrompt;
      // Restore approved tools
      for (const t of orphan.approvedTools) approvedTools.add(t);
      // Swap the orphan's sendToClient to use our new WS
      orphan.swapWs(ws);
      console.log(`[claude-skin] ♻ Reattached orphan for window ${wid}, pid ${activeProc.pid}, buffered ${orphan.buffer.length} events`);
      // Replay buffered events
      for (const evt of orphan.buffer) {
        if (ws.readyState === 1) ws.send(JSON.stringify(evt));
      }
      _orphanedProcs.delete(wid);
      ws.send(JSON.stringify({ type: 'reattach_result', ok: true, sessionId: procSessionId, running: inTurn || awaitingPermission }));
    } catch {}
  });

  ws.on('close', () => {
    // If there's a running process AND we know the windowId, orphan it instead of killing
    if (activeProc && !activeProc.killed && activeProc.exitCode === null && wsWindowId) {
      console.log(`[claude-skin] 🔌 WS closed — orphaning process pid ${activeProc.pid} for window ${wsWindowId} (${ORPHAN_GRACE_MS / 1000}s grace)`);
      _orphanBuffer = []; // switch sendToClient to buffer mode
      const orphan = {
        proc: activeProc,
        sessionId: procSessionId,
        model: procModel,
        cwd: procCwd,
        effort: procEffort,
        inTurn,
        lastEventTime,
        awaitingPermission,
        lastPrompt,
        approvedTools: new Set(approvedTools),
        buffer: _orphanBuffer,
        // swapWs: called by reattach to point sendToClient at the new WS
        swapWs(newWs) {
          ws = newWs;
          _orphanBuffer = null; // stop buffering, send directly
        },
        // Kill the process from within the old closure so activeProc guard works
        kill() { killProc(); },
        killTimer: setTimeout(() => {
          console.log(`[claude-skin] ⏱ Orphan grace expired for window ${wsWindowId} — killing pid ${orphan.proc?.pid}`);
          orphan.kill();
          _orphanedProcs.delete(wsWindowId);
        }, ORPHAN_GRACE_MS),
      };
      _orphanedProcs.set(wsWindowId, orphan);
      // Keep activeProc set — polling and stall detector use `activeProc === proc` guard.
      // The old closure keeps running and buffering events until reattach or grace expiry.
      // DON'T release session locks — client is refreshing, not leaving
      return;
    }
    killProc();
    // Release all session locks held by this window
    if (wsWindowId) _releaseAllLocks(wsWindowId);
    // Clean up compact file watcher
    if (_compactWatcher) { try { _compactWatcher.close(); } catch {} _compactWatcher = null; }
  });
}

// GET /api/claude/config — config for the skin UI (cwd, model, projects, models)
app.get('/api/claude/config', (req, res) => {
  try {
    const cliCfg = (() => {
      try { return JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'data', 'cli-config.json'), 'utf-8')); }
      catch { return {}; }
    })();
    const projects = (() => {
      try { return JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'data', 'claude-code-projects.json'), 'utf-8')); }
      catch { return []; }
    })();
    const models = [
      // 1M variants first — CLI uses 1M context by default for opus/sonnet 4.6
      { id: 'claude-opus-4-6', label: 'Opus 4.6', tier: 'capable', contextWindow: 1000000 },
      { id: 'claude-opus-4-6', label: 'Opus 4.6 (200K)', tier: 'capable', contextWindow: 200000 },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', tier: 'fast', contextWindow: 1000000 },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (200K)', tier: 'fast', contextWindow: 200000 },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', tier: 'instant', contextWindow: 200000 },
    ];
    res.json({ ok: true, config: cliCfg, projects, models, bootId: SERVER_BOOT_ID });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Claude Skin Cost Tracking ---

const COST_PATH = resolve(__dirname, '..', 'data', 'cost-tracking.json');

function loadCostData() {
  try { return JSON.parse(readFileSync(COST_PATH, 'utf-8')); }
  catch { return { months: {} }; }
}

function saveCostData(data) {
  writeFileSync(COST_PATH, JSON.stringify(data, null, 2));
}

function addCost(amount, sessionId) {
  const data = loadCostData();
  const now = new Date();
  const key = now.toISOString().slice(0, 7); // "2026-03"
  if (!data.months[key]) data.months[key] = { totalUsd: 0, queries: 0, sessions: [], days: {}, lastUpdated: null };
  const month = data.months[key];
  month.totalUsd = Math.round((month.totalUsd + amount) * 1e6) / 1e6; // avoid float drift
  month.queries += 1;
  if (sessionId && !month.sessions.includes(sessionId)) month.sessions.push(sessionId);
  // Per-session cost accumulation
  if (sessionId) {
    if (!data.sessionCosts) data.sessionCosts = {};
    data.sessionCosts[sessionId] = Math.round(((data.sessionCosts[sessionId] || 0) + amount) * 1e6) / 1e6;
  }
  // Daily granularity
  if (!month.days) month.days = {};
  const day = now.getDate().toString().padStart(2, '0');
  if (!month.days[day]) month.days[day] = { totalUsd: 0, queries: 0 };
  month.days[day].totalUsd = Math.round((month.days[day].totalUsd + amount) * 1e6) / 1e6;
  month.days[day].queries += 1;
  month.lastUpdated = now.toISOString();
  saveCostData(data);
  return month;
}

function getSessionCost(sessionId) {
  const data = loadCostData();
  return data.sessionCosts?.[sessionId] || 0;
}

app.get('/api/claude-skin/cost/session/:sid', (req, res) => {
  const cost = getSessionCost(req.params.sid);
  res.json({ sessionId: req.params.sid, cost });
});

app.get('/api/claude-skin/cost', (req, res) => {
  const data = loadCostData();
  const current = new Date().toISOString().slice(0, 7);
  res.json({
    currentMonth: current,
    month: data.months[current] || { totalUsd: 0, queries: 0, sessions: [] },
    history: data.months,
  });
});

app.post('/api/claude-skin/cost', express.json(), (req, res) => {
  const { amount, sessionId } = req.body || {};
  if (typeof amount !== 'number' || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  const month = addCost(amount, sessionId);
  res.json({ ok: true, month });
});

// --- CLI Session Cost Scanner ---
// Parses JSONL session files to extract costs from direct CLI usage (not via skin)

const MODEL_PRICING = {
  // $/MTok — [input, output, cache_write, cache_read]
  'claude-opus-4-6':            [15, 75, 18.75, 1.50],
  'claude-sonnet-4-6':          [3, 15, 3.75, 0.30],
  'claude-haiku-4-5-20251001':  [0.80, 4, 1.00, 0.08],
  // Fallbacks for older model IDs
  'claude-sonnet-4-5-20250514': [3, 15, 3.75, 0.30],
  'claude-3-5-sonnet-20241022': [3, 15, 3.75, 0.30],
  'claude-3-5-haiku-20241022':  [0.80, 4, 1.00, 0.08],
};

function calcMessageCost(model, usage) {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING['claude-sonnet-4-6']; // safe fallback
  const [pIn, pOut, pCacheW, pCacheR] = pricing;
  const input = (usage.input_tokens || 0) / 1e6 * pIn;
  const output = (usage.output_tokens || 0) / 1e6 * pOut;
  const cacheWrite = (usage.cache_creation_input_tokens || 0) / 1e6 * pCacheW;
  const cacheRead = (usage.cache_read_input_tokens || 0) / 1e6 * pCacheR;
  return Math.round((input + output + cacheWrite + cacheRead) * 1e6) / 1e6;
}

function scanSessionCosts() {
  const homeDir = process.env.USERPROFILE || process.env.HOME;
  const claudeProjectsDir = join(homeDir, '.claude', 'projects');
  if (!existsSync(claudeProjectsDir)) return { scanned: 0, added: 0, totalNew: 0 };

  const data = loadCostData();
  if (!data.scannedSessions) data.scannedSessions = {};

  // Collect all session IDs already tracked by the skin
  const skinSessions = new Set();
  for (const m of Object.values(data.months)) {
    for (const sid of (m.sessions || [])) skinSessions.add(sid);
  }

  let scanned = 0, added = 0, totalNew = 0;

  const projDirs = readdirSync(claudeProjectsDir, { withFileTypes: true }).filter(d => d.isDirectory());
  for (const projDir of projDirs) {
    const projPath = join(claudeProjectsDir, projDir.name);
    let files;
    try { files = readdirSync(projPath).filter(f => f.endsWith('.jsonl')); }
    catch { continue; }

    for (const file of files) {
      const sessionId = file.replace('.jsonl', '');
      // Skip if already scanned or tracked by skin
      if (data.scannedSessions[sessionId] || skinSessions.has(sessionId)) continue;

      const filePath = join(projPath, file);

      // Skip files modified in the last 5 minutes (likely active sessions)
      // Skip tiny files (<500 bytes — no meaningful cost data)
      let fstat;
      try { fstat = statSync(filePath); } catch { continue; }
      if (Date.now() - fstat.mtimeMs < 5 * 60 * 1000) continue;
      if (fstat.size < 500) { data.scannedSessions[sessionId] = 'empty'; continue; }

      scanned++;
      let content;
      try { content = readFileSync(filePath, 'utf-8'); }
      catch { continue; }

      // Parse line by line, extract assistant messages with usage
      // IMPORTANT: Claude Code writes multiple JSONL entries per API call (streaming chunks).
      // Each requestId may appear 2-3 times with increasing token counts.
      // We must keep only the LAST entry per requestId for accurate cost.
      const lines = content.split('\n');
      const requestMap = new Map(); // requestId → { model, usage, timestamp }

      for (const line of lines) {
        if (!line.trim()) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }

        if (entry.type !== 'assistant' || !entry.message?.usage) continue;
        const { model, usage } = entry.message;
        const requestId = entry.requestId || entry.message?.id;
        if (!model || !usage || !requestId) continue;

        // Always overwrite — last entry per requestId has final token counts
        requestMap.set(requestId, { model, usage, timestamp: entry.timestamp });
      }

      let sessionCost = 0;
      let sessionQueries = 0;
      let sessionDate = null;
      const dailyCosts = {}; // { "2026-03-09": { cost, queries } }

      for (const { model, usage, timestamp } of requestMap.values()) {
        const cost = calcMessageCost(model, usage);
        if (cost <= 0) continue;

        sessionCost += cost;
        sessionQueries++;

        if (timestamp) {
          const dayStr = timestamp.slice(0, 10);
          if (!dailyCosts[dayStr]) dailyCosts[dayStr] = { cost: 0, queries: 0 };
          dailyCosts[dayStr].cost += cost;
          dailyCosts[dayStr].queries++;
          if (!sessionDate) sessionDate = dayStr;
        }
      }

      if (sessionCost > 0) {
        // Merge into months/days
        for (const [dayStr, dc] of Object.entries(dailyCosts)) {
          const monthKey = dayStr.slice(0, 7); // "2026-03"
          const dayKey = dayStr.slice(8, 10); // "09"
          if (!data.months[monthKey]) data.months[monthKey] = { totalUsd: 0, queries: 0, sessions: [], days: {}, lastUpdated: null };
          const month = data.months[monthKey];
          const rounded = Math.round(dc.cost * 1e6) / 1e6;
          month.totalUsd = Math.round((month.totalUsd + rounded) * 1e6) / 1e6;
          month.queries += dc.queries;
          if (!month.days) month.days = {};
          if (!month.days[dayKey]) month.days[dayKey] = { totalUsd: 0, queries: 0 };
          month.days[dayKey].totalUsd = Math.round((month.days[dayKey].totalUsd + rounded) * 1e6) / 1e6;
          month.days[dayKey].queries += dc.queries;
          month.lastUpdated = new Date().toISOString();
          if (!month.sessions.includes(sessionId)) month.sessions.push(sessionId);
        }
        added++;
        totalNew = Math.round((totalNew + sessionCost) * 1e6) / 1e6;
      }

      // Mark as scanned regardless (to avoid re-processing empty/no-cost sessions)
      data.scannedSessions[sessionId] = sessionDate || new Date().toISOString().slice(0, 10);
    }
  }

  // Always save if we scanned anything (even zero-cost sessions get marked)
  if (scanned > 0) saveCostData(data);
  return { scanned, added, totalNew };
}

// Scan on startup (async to not block)
setTimeout(() => {
  try {
    const result = scanSessionCosts();
    if (result.added > 0) console.log(`[cost-tracker] Imported ${result.added} CLI sessions (+$${result.totalNew.toFixed(2)})`);
  } catch (err) { console.error('[cost-tracker] Scan error:', err.message); }
}, 3000);

app.post('/api/claude-skin/cost/scan', (req, res) => {
  try {
    const result = scanSessionCosts();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Session Lock API ---

app.post('/api/claude-skin/session-lock', express.json(), (req, res) => {
  const { action, sessionId, windowId } = req.body || {};
  if (!windowId) return res.status(400).json({ error: 'windowId required' });

  if (action === 'acquire') {
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    const result = _acquireSessionLock(sessionId, windowId, null);
    return res.json(result);
  }
  if (action === 'release') {
    if (sessionId) {
      _releaseSessionLock(sessionId, windowId);
    } else {
      _releaseAllLocks(windowId);
    }
    return res.json({ ok: true });
  }
  if (action === 'heartbeat') {
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    _heartbeatLock(sessionId, windowId);
    return res.json({ ok: true });
  }
  if (action === 'force-take') {
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    _sessionLocks.set(sessionId, { windowId, wsId: null, lockedAt: Date.now(), lastHeartbeat: Date.now() });
    return res.json({ ok: true });
  }
  res.status(400).json({ error: 'Unknown action' });
});

app.get('/api/claude-skin/session-locks', (req, res) => {
  const locks = {};
  for (const [sid, lock] of _sessionLocks) {
    locks[sid] = { windowId: lock.windowId, lockedAt: lock.lockedAt, lastHeartbeat: lock.lastHeartbeat };
  }
  res.json({ locks });
});

// --- Keybinds Persistence ---

const KEYBINDS_PATH = resolve(__dirname, '..', 'data', 'keybinds.json');

function loadKeybinds() {
  try { return JSON.parse(readFileSync(KEYBINDS_PATH, 'utf-8')); }
  catch { return null; }
}

function saveKeybinds(data) {
  const dir = resolve(KEYBINDS_PATH, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  data._version = data._version || 1;
  data._updated = new Date().toISOString();
  writeFileSync(KEYBINDS_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

app.get('/api/keybinds', (req, res) => {
  try {
    res.json(loadKeybinds() || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/keybinds', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ error: 'Body must be a JSON object' });
    }
    saveKeybinds(req.body);
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/keybinds error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- UI State Persistence (replaces browser localStorage) ---

const UI_STATE_PATH = resolve(__dirname, '..', 'data', 'ui-state.json');

function loadUiState() {
  try {
    return JSON.parse(readFileSync(UI_STATE_PATH, 'utf-8'));
  } catch {
    return { _version: 1, _updated: new Date().toISOString() };
  }
}

function saveUiState(data) {
  const dir = resolve(UI_STATE_PATH, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  data._updated = new Date().toISOString();
  writeFileSync(UI_STATE_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

// Shared merge logic for PATCH and POST (sendBeacon)
function mergeUiState(updates) {
  const current = loadUiState();
  for (const [key, value] of Object.entries(updates)) {
    if (key.startsWith('_')) continue; // protect metadata keys
    if (value === null) {
      delete current[key];
    } else {
      current[key] = value;
    }
  }
  saveUiState(current);
  return current;
}

// GET /api/ui-state — Full state dump (boot hydration)
app.get('/api/ui-state', (req, res) => {
  try {
    res.json(loadUiState());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/ui-state — Partial key update (debounced writes from client)
app.patch('/api/ui-state', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ error: 'Body must be a JSON object' });
    }
    mergeUiState(req.body);
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /api/ui-state error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ui-state — Same as PATCH (needed for navigator.sendBeacon on page unload)
app.post('/api/ui-state', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ error: 'Body must be a JSON object' });
    }
    mergeUiState(req.body);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/ui-state error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ═══════════════════════════════════════════
// IMAGE GALLERY API
// ═══════════════════════════════════════════

// GET /api/images — list all images with metadata
app.get('/api/images', (req, res) => {
  try {
    const favs = new Set(loadImageFavorites());
    const files = readdirSync(IMAGES_DIR)
      .filter(f => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f))
      .map(f => {
        const fp = join(IMAGES_DIR, f);
        const st = statSync(fp);
        let type = 'other';
        if (f.startsWith('screenshot-')) type = 'screenshot';
        else if (f.startsWith('synabun-img-')) type = 'attachment';
        else if (f.startsWith('synabun-wbimg-')) type = 'whiteboard';
        else if (f.startsWith('synabun-paste-')) type = 'paste';
        return {
          filename: f,
          type,
          size: st.size,
          createdAt: st.birthtimeMs || st.ctimeMs,
          modifiedAt: st.mtimeMs,
          favorite: favs.has(f),
        };
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt);
    res.json({ images: files, total: files.length });
  } catch (err) {
    console.error('GET /api/images error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/images/file/:filename — serve an image file
app.get('/api/images/file/:filename', (req, res) => {
  const filename = basename(req.params.filename);
  const fp = join(IMAGES_DIR, filename);
  if (!existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(fp);
});

// POST /api/images/favorite — toggle favorite status
app.post('/api/images/favorite', (req, res) => {
  try {
    const { filename, favorite } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename required' });
    const favs = loadImageFavorites();
    const idx = favs.indexOf(filename);
    if (favorite && idx === -1) favs.push(filename);
    else if (!favorite && idx !== -1) favs.splice(idx, 1);
    saveImageFavorites(favs);
    res.json({ ok: true, favorite: favs.includes(filename) });
  } catch (err) {
    console.error('POST /api/images/favorite error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/images/:filename — delete an image
app.delete('/api/images/:filename', (req, res) => {
  try {
    const filename = basename(req.params.filename);
    const fp = join(IMAGES_DIR, filename);
    if (!existsSync(fp)) return res.status(404).json({ error: 'Not found' });
    unlinkSync(fp);
    // Remove from favorites too
    const favs = loadImageFavorites().filter(f => f !== filename);
    saveImageFavorites(favs);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/images error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ═══════════════════════════════════════════
// WHITEBOARD API — Claude MCP integration
// ═══════════════════════════════════════════

// Layout engine for whiteboard auto-positioning
function applyWhiteboardLayout(elements, layout, vp) {
  const gap = 40;
  const pad = 60;
  const xOff = vp.xOffset || 0;
  const yOff = vp.yOffset || 0;
  const n = elements.length;
  if (!n) return;

  if (layout === 'center') {
    const totalH = elements.reduce((s, el) => s + (el.height || 100), 0) + gap * (n - 1);
    let y = yOff + (vp.height - totalH) / 2;
    for (const el of elements) {
      el.x = Math.round(xOff + (vp.width - (el.width || 200)) / 2);
      el.y = Math.round(y);
      y += (el.height || 100) + gap;
    }
  } else if (layout === 'row') {
    const totalW = elements.reduce((s, el) => s + (el.width || 200), 0) + gap * (n - 1);
    let x = xOff + (vp.width - totalW) / 2;
    for (const el of elements) {
      el.x = Math.round(x);
      el.y = Math.round(yOff + (vp.height - (el.height || 100)) / 2);
      x += (el.width || 200) + gap;
    }
  } else if (layout === 'column') {
    const totalH = elements.reduce((s, el) => s + (el.height || 100), 0) + gap * (n - 1);
    let y = yOff + (vp.height - totalH) / 2;
    for (const el of elements) {
      el.x = Math.round(xOff + (vp.width - (el.width || 200)) / 2);
      el.y = Math.round(y);
      y += (el.height || 100) + gap;
    }
  } else if (layout === 'grid') {
    const cols = n <= 2 ? 2 : n <= 6 ? 3 : 4;
    const rows = Math.ceil(n / cols);
    const cellW = (vp.width - pad * 2 - gap * (cols - 1)) / cols;
    const cellH = (vp.height - pad * 2 - gap * (rows - 1)) / rows;
    elements.forEach((el, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      el.x = Math.round(xOff + pad + col * (cellW + gap) + (cellW - (el.width || 200)) / 2);
      el.y = Math.round(yOff + pad + row * (cellH + gap) + (cellH - (el.height || 100)) / 2);
    });
  }
}

// GET /api/whiteboard — Read current whiteboard state from ui-state storage
app.get('/api/whiteboard', (req, res) => {
  try {
    const state = loadUiState();
    const wb = state['neural-whiteboard'];
    if (!wb || !wb.elements) {
      return res.json({ ok: true, elements: [], nextZIndex: 1, viewport: whiteboardViewport });
    }
    res.json({ ok: true, elements: wb.elements, nextZIndex: wb.nextZIndex || 1, viewport: whiteboardViewport });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/whiteboard/elements — Add one or more elements
app.post('/api/whiteboard/elements', (req, res) => {
  try {
    const { elements, coordMode, layout } = req.body;
    if (!Array.isArray(elements) || elements.length === 0) {
      return res.status(400).json({ error: 'elements must be a non-empty array' });
    }

    // Auto-layout or percentage coordinate conversion
    if (layout && whiteboardViewport) {
      applyWhiteboardLayout(elements, layout, whiteboardViewport);
    } else if (coordMode === 'pct' && whiteboardViewport) {
      const xOff = whiteboardViewport.xOffset || 0;
      const yOff = whiteboardViewport.yOffset || 0;
      for (const el of elements) {
        if (el.x != null) el.x = Math.round(xOff + (el.x / 100) * whiteboardViewport.width);
        if (el.y != null) el.y = Math.round(yOff + (el.y / 100) * whiteboardViewport.height);
        if (el.width != null) el.width = Math.round((el.width / 100) * whiteboardViewport.width);
        if (el.height != null) el.height = Math.round((el.height / 100) * whiteboardViewport.height);
      }
    }

    const state = loadUiState();
    const wb = state['neural-whiteboard'] || { elements: [], nextZIndex: 1 };
    if (!Array.isArray(wb.elements)) wb.elements = [];

    const added = [];
    for (const el of elements) {
      // Resolve image URL to base64 dataUrl (for MCP image type)
      if (el.type === 'image' && el.url && !el.dataUrl) {
        try {
          const filePath = join(__dirname, el.url.replace(/^\//, ''));
          if (existsSync(filePath)) {
            const buf = readFileSync(filePath);
            const ext = extname(filePath).toLowerCase();
            const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : 'image/jpeg';
            el.dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
          }
        } catch { /* ignore — element will just have no dataUrl */ }
      }
      // Apply section defaults when not specified
      if (el.type === 'section' && el.sectionType) {
        const SEC_DEFAULTS = {
          navbar: { w: 960, h: 56, color: '#64748b', label: 'Navbar' },
          hero: { w: 960, h: 340, color: '#6366f1', label: 'Hero' },
          sidebar: { w: 260, h: 400, color: '#475569', label: 'Sidebar' },
          content: { w: 640, h: 360, color: '#737373', label: 'Content' },
          footer: { w: 960, h: 100, color: '#6b7280', label: 'Footer' },
          card: { w: 260, h: 180, color: '#14b8a6', label: 'Card' },
          form: { w: 380, h: 280, color: '#f59e0b', label: 'Form' },
          'image-placeholder': { w: 280, h: 180, color: '#a855f7', label: 'Image' },
          button: { w: 140, h: 42, color: '#22c55e', label: 'Button' },
          'text-block': { w: 380, h: 90, color: '#e2e8f0', label: 'Text Block' },
          grid: { w: 640, h: 320, color: '#06b6d4', label: 'Grid' },
          modal: { w: 440, h: 300, color: '#f43f5e', label: 'Modal' },
        };
        const def = SEC_DEFAULTS[el.sectionType];
        if (def) {
          if (!el.width) el.width = def.w;
          if (!el.height) el.height = def.h;
          if (!el.color) el.color = def.color;
          if (!el.label) el.label = def.label;
        }
      }
      // Clamp elements to stay within the usable viewport
      if (whiteboardViewport && el.x != null && el.y != null) {
        const vpW = whiteboardViewport.width;
        const vpH = whiteboardViewport.height;
        const xOff = whiteboardViewport.xOffset || 0;
        const yOff = whiteboardViewport.yOffset || 0;
        const elW = el.width || 0;
        const elH = el.height || 0;
        // Don't let elements overflow right/bottom edges
        if (el.x + elW > vpW + xOff) el.x = Math.max(xOff, vpW + xOff - elW);
        if (el.y + elH > vpH + yOff) el.y = Math.max(yOff, vpH + yOff - elH);
        // Don't let elements go under toolbar or above navbar
        if (el.x < xOff) el.x = xOff;
        if (el.y < yOff) el.y = yOff;
      }
      if (!el.id) el.id = 'wb-' + Date.now() + '-' + randomBytes(2).toString('hex').slice(0, 3);
      el.zIndex = wb.nextZIndex++;
      wb.elements.push(el);
      added.push(el);
    }

    state['neural-whiteboard'] = wb;
    saveUiState(state);
    broadcastToWhiteboard({ type: 'add', elements: added });

    res.json({ ok: true, added: added.map(e => ({ id: e.id, type: e.type, zIndex: e.zIndex })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/whiteboard/elements/:id — Update an element
app.put('/api/whiteboard/elements/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { updates, coordMode } = req.body.updates ? req.body : { updates: req.body, coordMode: req.body.coordMode };

    // Percentage coordinate conversion for updates
    if (coordMode === 'pct' && whiteboardViewport) {
      const xOff = whiteboardViewport.xOffset || 0;
      const yOff = whiteboardViewport.yOffset || 0;
      if (updates.x != null) updates.x = Math.round(xOff + (updates.x / 100) * whiteboardViewport.width);
      if (updates.y != null) updates.y = Math.round(yOff + (updates.y / 100) * whiteboardViewport.height);
      if (updates.width != null) updates.width = Math.round((updates.width / 100) * whiteboardViewport.width);
      if (updates.height != null) updates.height = Math.round((updates.height / 100) * whiteboardViewport.height);
    }

    const state = loadUiState();
    const wb = state['neural-whiteboard'];
    if (!wb || !wb.elements) return res.status(404).json({ error: 'Whiteboard is empty' });

    const idx = wb.elements.findIndex(e => e.id === id);
    if (idx === -1) return res.status(404).json({ error: `Element ${id} not found` });

    const el = wb.elements[idx];
    for (const [key, value] of Object.entries(updates)) {
      if (key === 'id' || key === 'type' || key === 'coordMode') continue;
      el[key] = value;
    }

    state['neural-whiteboard'] = wb;
    saveUiState(state);
    broadcastToWhiteboard({ type: 'update', id, updates });

    res.json({ ok: true, element: el });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/whiteboard/elements/:id — Remove an element
app.delete('/api/whiteboard/elements/:id', (req, res) => {
  try {
    const { id } = req.params;
    const state = loadUiState();
    const wb = state['neural-whiteboard'];
    if (!wb || !wb.elements) return res.status(404).json({ error: 'Whiteboard is empty' });

    const idx = wb.elements.findIndex(e => e.id === id);
    if (idx === -1) return res.status(404).json({ error: `Element ${id} not found` });

    const removed = wb.elements.splice(idx, 1)[0];

    // Detach arrows anchored to this element
    for (const a of wb.elements) {
      if (a.type !== 'arrow') continue;
      if (a.startAnchor === id) a.startAnchor = null;
      if (a.endAnchor === id) a.endAnchor = null;
    }

    state['neural-whiteboard'] = wb;
    saveUiState(state);
    broadcastToWhiteboard({ type: 'remove', id });

    res.json({ ok: true, removed: { id: removed.id, type: removed.type } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/whiteboard/clear — Clear all elements
app.post('/api/whiteboard/clear', (req, res) => {
  try {
    const state = loadUiState();
    state['neural-whiteboard'] = { elements: [], nextZIndex: 1 };
    saveUiState(state);
    broadcastToWhiteboard({ type: 'clear' });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/whiteboard/screenshot — Request screenshot from connected browser
app.get('/api/whiteboard/screenshot', async (req, res) => {
  if (whiteboardClients.size === 0) {
    return res.status(503).json({ error: 'No browser connected to whiteboard. Open the Neural Interface and enter Focus mode.' });
  }

  const requestId = randomBytes(8).toString('hex');
  try {
    const data = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        whiteboardPendingScreenshots.delete(requestId);
        reject(new Error('Screenshot timed out after 10s'));
      }, 10000);

      whiteboardPendingScreenshots.set(requestId, { resolve, reject, timer });
      broadcastToWhiteboard({ type: 'screenshot:request', requestId });
    });

    res.json({ ok: true, data }); // data is base64 JPEG
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ══════════════════════════════════════════════════
// TIC TAC TOE — REST API (dedicated game endpoints)
// ══════════════════════════════════════════════════

const TTT_BOARD_SIZE = 500;
const TTT_CELL_SIZE = Math.round(TTT_BOARD_SIZE / 3);
const TTT_PIECE_SIZE = 120;
const TTT_PIECE_OFFSET = Math.round((TTT_CELL_SIZE - TTT_PIECE_SIZE) / 2);
const TTT_NUMBER_SIZE = 60;
const TTT_NUMBER_OFFSET = Math.round((TTT_CELL_SIZE - TTT_NUMBER_SIZE) / 2);

const TTT_WIN_LINES = [
  [0,1,2], [3,4,5], [6,7,8], // rows
  [0,3,6], [1,4,7], [2,5,8], // columns
  [0,4,8], [2,4,6],          // diagonals
];

function tttCheckResult(board) {
  for (const [a,b,c] of TTT_WIN_LINES) {
    if (board[a] && board[a] === board[b] && board[b] === board[c]) return board[a];
  }
  return board.every(c => c !== null) ? 'draw' : null;
}

function tttBoardAscii(board) {
  const display = board.map((c, i) => c || String(i + 1));
  return [
    `  ${display[0]} | ${display[1]} | ${display[2]}`,
    '  ---------',
    `  ${display[3]} | ${display[4]} | ${display[5]}`,
    '  ---------',
    `  ${display[6]} | ${display[7]} | ${display[8]}`,
  ].join('\n');
}

function tttLoadAsset(name) {
  const filePath = join(__dirname, 'games', 'TicTacToe', `${name}.svg`);
  if (!existsSync(filePath)) return null;
  const buf = readFileSync(filePath);
  return `data:image/svg+xml;base64,${buf.toString('base64')}`;
}

function tttCellPosition(cellNum, boardX, boardY, size, offset) {
  const idx = cellNum - 1;
  const col = idx % 3;
  const row = Math.floor(idx / 3);
  return {
    x: boardX + col * TTT_CELL_SIZE + offset,
    y: boardY + row * TTT_CELL_SIZE + offset,
  };
}

// POST /api/games/tictactoe/start — Set up board and initialize game
app.post('/api/games/tictactoe/start', (req, res) => {
  try {
    const piece = (req.body.piece || 'X').toUpperCase();
    if (piece !== 'X' && piece !== 'O') {
      return res.status(400).json({ error: 'piece must be "X" or "O"' });
    }

    // Clear whiteboard first
    const state = loadUiState();
    state['neural-whiteboard'] = { elements: [], nextZIndex: 1 };

    // Calculate centered board position
    const vp = whiteboardViewport || { width: 1920, height: 937 };
    const boardX = Math.round((vp.width - TTT_BOARD_SIZE) / 2);
    const boardY = Math.round((vp.height - TTT_BOARD_SIZE) / 2);

    // Build board elements
    const wb = state['neural-whiteboard'];
    const elements = [];

    // Board grid
    const boardDataUrl = tttLoadAsset('Board');
    elements.push({
      id: 'ttt-board',
      type: 'image',
      x: boardX,
      y: boardY,
      width: TTT_BOARD_SIZE,
      height: TTT_BOARD_SIZE,
      dataUrl: boardDataUrl,
      zIndex: wb.nextZIndex++,
    });

    // Number markers (1-9)
    for (let i = 1; i <= 9; i++) {
      const pos = tttCellPosition(i, boardX, boardY, TTT_NUMBER_SIZE, TTT_NUMBER_OFFSET);
      const dataUrl = tttLoadAsset(String(i));
      elements.push({
        id: `ttt-cell-${i}`,
        type: 'image',
        x: pos.x,
        y: pos.y,
        width: TTT_NUMBER_SIZE,
        height: TTT_NUMBER_SIZE,
        dataUrl,
        zIndex: wb.nextZIndex++,
      });
    }

    wb.elements = elements;

    // Initialize game state
    const gameState = {
      board: [null,null,null, null,null,null, null,null,null],
      turn: 'X',
      status: 'playing',
      winner: null,
      piece,
      boardX,
      boardY,
    };
    state['tictactoe-game'] = gameState;
    saveUiState(state);

    // Broadcast to whiteboard clients
    broadcastToWhiteboard({ type: 'clear' });
    broadcastToWhiteboard({ type: 'add', elements });
    broadcastToWhiteboard({ type: 'ttt-started', boardX, boardY });

    res.json({
      ok: true,
      board: gameState.board,
      ascii: tttBoardAscii(gameState.board),
      turn: gameState.turn,
      status: gameState.status,
      piece,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/games/tictactoe/move — Make a move
app.post('/api/games/tictactoe/move', (req, res) => {
  try {
    const cell = parseInt(req.body.cell, 10);
    if (isNaN(cell) || cell < 1 || cell > 9) {
      return res.status(400).json({ error: 'cell must be a number 1-9' });
    }

    const state = loadUiState();
    const game = state['tictactoe-game'];
    if (!game) {
      return res.status(400).json({ error: 'No active TicTacToe game. Use start first.' });
    }
    if (game.status !== 'playing') {
      return res.status(400).json({ error: `Game is over: ${game.status}${game.winner ? ' — ' + game.winner + ' wins' : ''}` });
    }

    const idx = cell - 1;
    if (game.board[idx] !== null) {
      return res.status(400).json({ error: `Cell ${cell} is already taken by ${game.board[idx]}` });
    }

    // Place the piece
    const currentPiece = game.turn;
    game.board[idx] = currentPiece;

    // Update whiteboard: remove number marker, add piece
    const wb = state['neural-whiteboard'];
    if (wb && wb.elements) {
      // Remove number marker
      const markerIdx = wb.elements.findIndex(e => e.id === `ttt-cell-${cell}`);
      let removedMarker = null;
      if (markerIdx !== -1) {
        removedMarker = wb.elements.splice(markerIdx, 1)[0];
      }

      // Add piece at correct position
      const assetName = currentPiece === 'X' ? 'Cross' : 'Circle';
      const dataUrl = tttLoadAsset(assetName);
      const pos = tttCellPosition(cell, game.boardX, game.boardY, TTT_PIECE_SIZE, TTT_PIECE_OFFSET);
      const pieceEl = {
        id: `ttt-piece-${cell}`,
        type: 'image',
        x: pos.x,
        y: pos.y,
        width: TTT_PIECE_SIZE,
        height: TTT_PIECE_SIZE,
        dataUrl,
        zIndex: wb.nextZIndex++,
      };
      wb.elements.push(pieceEl);

      // Broadcast whiteboard changes
      if (removedMarker) broadcastToWhiteboard({ type: 'remove', id: `ttt-cell-${cell}` });
      broadcastToWhiteboard({ type: 'add', elements: [pieceEl] });
    }

    // Check for win/draw
    const result = tttCheckResult(game.board);
    if (result === 'draw') {
      game.status = 'draw';
    } else if (result) {
      game.status = 'won';
      game.winner = result;
    } else {
      // Toggle turn
      game.turn = game.turn === 'X' ? 'O' : 'X';
    }

    state['tictactoe-game'] = game;
    saveUiState(state);

    const response = {
      ok: true,
      board: game.board,
      ascii: tttBoardAscii(game.board),
      turn: game.turn,
      status: game.status,
    };
    if (game.winner) response.winner = game.winner;

    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/games/tictactoe/state — Get current game state
app.get('/api/games/tictactoe/state', (req, res) => {
  try {
    const state = loadUiState();
    const game = state['tictactoe-game'];
    if (!game) {
      return res.json({ ok: true, active: false, message: 'No active game' });
    }

    const response = {
      ok: true,
      active: true,
      board: game.board,
      ascii: tttBoardAscii(game.board),
      turn: game.turn,
      status: game.status,
      piece: game.piece,
    };
    if (game.winner) response.winner = game.winner;

    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/games/tictactoe/end — Tear down game
app.post('/api/games/tictactoe/end', (req, res) => {
  try {
    const state = loadUiState();
    delete state['tictactoe-game'];
    state['neural-whiteboard'] = { elements: [], nextZIndex: 1 };
    saveUiState(state);

    broadcastToWhiteboard({ type: 'clear' });
    broadcastToWhiteboard({ type: 'ttt-ended' });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ══════════════════════════════════════════════
// CARDS — REST API (Claude MCP integration)
// ══════════════════════════════════════════════

// Helper: send a WS request to the browser and await the ACK response
function requestCardOp(message, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (cardsClients.size === 0) {
      return reject(new Error('No browser connected. Open the Neural Interface.'));
    }
    const requestId = randomBytes(8).toString('hex');
    message.requestId = requestId;
    const timer = setTimeout(() => {
      cardsPendingOps.delete(requestId);
      reject(new Error('Browser did not respond within 10 seconds'));
    }, timeoutMs);
    cardsPendingOps.set(requestId, { resolve, reject, timer });
    broadcastToCards(message);
  });
}

// GET /api/cards — Read all open cards from persisted ui-state
app.get('/api/cards', (req, res) => {
  try {
    const state = loadUiState();
    const raw = state['neural-open-cards'];
    const cards = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];

    // Enrich each card with pin state
    for (const card of cards) {
      const pinKey = 'neural-pinned-' + card.panelId;
      card.isPinned = state[pinKey] === 'true' || state[pinKey] === true;
    }

    res.json({ ok: true, cards, count: cards.length, viewport: cardsViewport });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cards/open — Open a memory card (WS round-trip to browser)
app.post('/api/cards/open', async (req, res) => {
  const { memoryId, left, top, compact, coordMode } = req.body || {};
  if (!memoryId) return res.status(400).json({ error: 'memoryId is required' });

  // Percentage coordinate conversion
  let resolvedLeft = left, resolvedTop = top;
  if (coordMode === 'pct' && cardsViewport) {
    if (left != null) resolvedLeft = Math.round((left / 100) * cardsViewport.width);
    if (top != null) resolvedTop = Math.round((top / 100) * cardsViewport.height);
  }

  try {
    const result = await requestCardOp({
      type: 'card:open-request',
      memoryId,
      ...(resolvedLeft !== undefined && { left: resolvedLeft }),
      ...(resolvedTop !== undefined && { top: resolvedTop }),
      ...(compact !== undefined && { compact }),
    });
    res.json({ ok: true, result });
  } catch (err) {
    const status = err.message.includes('No browser') || err.message.includes('did not respond') ? 503 : 500;
    res.status(status).json({ error: err.message });
  }
});

// POST /api/cards/close — Close one card or all cards (WS round-trip)
app.post('/api/cards/close', async (req, res) => {
  const { memoryId } = req.body || {};

  try {
    const result = await requestCardOp({
      type: 'card:close-request',
      ...(memoryId && { memoryId }),
    });
    res.json({ ok: true, result });
  } catch (err) {
    const status = err.message.includes('No browser') || err.message.includes('did not respond') ? 503 : 500;
    res.status(status).json({ error: err.message });
  }
});

// PUT /api/cards/:memoryId — Update card state (WS round-trip)
app.put('/api/cards/:memoryId', async (req, res) => {
  const { memoryId } = req.params;
  const { coordMode, ...updates } = req.body || {};

  // Percentage coordinate conversion
  if (coordMode === 'pct' && cardsViewport) {
    if (updates.left != null) updates.left = Math.round((updates.left / 100) * cardsViewport.width);
    if (updates.top != null) updates.top = Math.round((updates.top / 100) * cardsViewport.height);
    if (updates.width != null) updates.width = Math.round((updates.width / 100) * cardsViewport.width);
    if (updates.height != null) updates.height = Math.round((updates.height / 100) * cardsViewport.height);
  }

  // Check at least one valid update field
  const validFields = ['left', 'top', 'width', 'height', 'compact', 'pinned'];
  const hasUpdate = validFields.some(f => updates[f] !== undefined);
  if (!hasUpdate) {
    return res.status(400).json({ error: 'No update fields provided. Use: left, top, width, height, compact, pinned' });
  }

  try {
    const result = await requestCardOp({
      type: 'card:update-request',
      memoryId,
      updates,
    });
    res.json({ ok: true, result });
  } catch (err) {
    const status = err.message.includes('No browser') || err.message.includes('did not respond') ? 503 : 500;
    res.status(status).json({ error: err.message });
  }
});

// GET /api/cards/screenshot — Capture viewport screenshot (WS round-trip, 15s timeout)
app.get('/api/cards/screenshot', async (req, res) => {
  try {
    const result = await requestCardOp({ type: 'screenshot:request' }, 15000);
    res.json({ ok: true, data: result });
  } catch (err) {
    const status = err.message.includes('No browser') || err.message.includes('did not respond') ? 503 : 500;
    res.status(status).json({ error: err.message });
  }
});


// --- Bridge config helpers (read/write BRIDGE__<id>__* in .env) ---
// loadBridgeConfig(), saveBridgeConfig(), removeBridgeConfig() defined above near writeEnvFile

// --- OpenClaw Bridge: Markdown Parsers ---

function parseMemoryMd(filePath) {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, 'utf-8').trim();
  if (!raw) return [];
  const stat = statSync(filePath);

  const sections = raw.split(/^## /m);
  // First element is content before the first ## header (preamble)
  const preamble = sections.shift().trim();
  const nodes = [];

  // If there's preamble content with no headers, treat as one node
  if (preamble && sections.length === 0) {
    const hash = createHash('md5').update('preamble').digest('hex').slice(0, 12);
    nodes.push({
      id: `openclaw-lt-${hash}`,
      payload: {
        content: preamble,
        category: 'openclaw-longterm',
        subcategory: 'Overview',
        importance: 6,
        source: 'openclaw',
        tags: ['openclaw', 'long-term'],
        created_at: stat.mtime.toISOString(),
        updated_at: stat.mtime.toISOString(),
        _isOpenClaw: true,
      }
    });
    return nodes;
  }

  for (const section of sections) {
    const newline = section.indexOf('\n');
    const title = (newline === -1 ? section : section.slice(0, newline)).trim();
    const body = (newline === -1 ? '' : section.slice(newline + 1)).trim();
    if (!title && !body) continue;
    const hash = createHash('md5').update(title || 'untitled').digest('hex').slice(0, 12);

    nodes.push({
      id: `openclaw-lt-${hash}`,
      payload: {
        content: body || title,
        category: 'openclaw-longterm',
        subcategory: title,
        importance: 6,
        source: 'openclaw',
        tags: ['openclaw', 'long-term'],
        created_at: stat.mtime.toISOString(),
        updated_at: stat.mtime.toISOString(),
        _isOpenClaw: true,
      }
    });
  }

  return nodes;
}

// Parse workspace config files (AGENTS.md, SOUL.md, IDENTITY.md, USER.md, TOOLS.md, HEARTBEAT.md, BOOTSTRAP.md)
const OPENCLAW_CONFIG_FILES = [
  { file: 'AGENTS.md',    label: 'Agents',    desc: 'Operating instructions and behavior rules' },
  { file: 'SOUL.md',      label: 'Soul',      desc: 'Persona, tone, and boundaries' },
  { file: 'IDENTITY.md',  label: 'Identity',  desc: 'Name, creature type, vibe, emoji' },
  { file: 'USER.md',      label: 'User',      desc: 'About the human' },
  { file: 'TOOLS.md',     label: 'Tools',     desc: 'Local environment notes' },
  { file: 'HEARTBEAT.md', label: 'Heartbeat', desc: 'Periodic check tasks' },
  { file: 'BOOTSTRAP.md', label: 'Bootstrap', desc: 'First-run ritual' },
];

function parseWorkspaceConfigs(wsPath) {
  const nodes = [];

  for (const { file, label } of OPENCLAW_CONFIG_FILES) {
    const filePath = join(wsPath, file);
    if (!existsSync(filePath)) continue;
    const raw = readFileSync(filePath, 'utf-8').trim();
    if (!raw) continue;
    // Skip files that are only comments (e.g. empty HEARTBEAT.md)
    const meaningful = raw.split('\n').filter(l => !l.startsWith('#') || l.startsWith('# ')).join('').trim();
    if (!meaningful && raw.length < 100) continue;

    const stat = statSync(filePath);
    const sections = raw.split(/^## /m);
    const preamble = sections.shift().trim();

    if (sections.length === 0) {
      // Whole file as one node
      const hash = createHash('md5').update('cfg-' + file).digest('hex').slice(0, 12);
      nodes.push({
        id: `openclaw-cfg-${hash}`,
        payload: {
          content: preamble || raw,
          category: 'openclaw-config',
          subcategory: label,
          importance: 5,
          source: 'openclaw',
          tags: ['openclaw', 'config', label.toLowerCase()],
          created_at: stat.mtime.toISOString(),
          updated_at: stat.mtime.toISOString(),
          _isOpenClaw: true,
          _openClawFile: file,
        }
      });
    } else {
      for (const section of sections) {
        const newline = section.indexOf('\n');
        const title = (newline === -1 ? section : section.slice(0, newline)).trim();
        const body = (newline === -1 ? '' : section.slice(newline + 1)).trim();
        if (!title && !body) continue;
        const hash = createHash('md5').update('cfg-' + file + '-' + (title || 'untitled')).digest('hex').slice(0, 12);

        nodes.push({
          id: `openclaw-cfg-${hash}`,
          payload: {
            content: body || title,
            category: 'openclaw-config',
            subcategory: `${label}: ${title}`,
            importance: 5,
            source: 'openclaw',
            tags: ['openclaw', 'config', label.toLowerCase()],
            created_at: stat.mtime.toISOString(),
            updated_at: stat.mtime.toISOString(),
            _isOpenClaw: true,
            _openClawFile: file,
          }
        });
      }
    }
  }

  return nodes;
}

function parseDailyLogs(memoryDir) {
  if (!existsSync(memoryDir)) return [];
  const files = readdirSync(memoryDir).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
  const nodes = [];

  for (const file of files) {
    const date = file.replace('.md', '');
    const filePath = join(memoryDir, file);
    const raw = readFileSync(filePath, 'utf-8').trim();
    if (!raw) continue;
    const stat = statSync(filePath);

    const sections = raw.split(/^## /m);
    const preamble = sections.shift().trim();

    if (sections.length === 0) {
      // No ## headers — treat whole file as one node
      const hash = createHash('md5').update(date + '-whole').digest('hex').slice(0, 12);
      nodes.push({
        id: `openclaw-day-${date}-${hash}`,
        payload: {
          content: preamble || raw,
          category: `openclaw-daily`,
          subcategory: date,
          importance: 4,
          source: 'openclaw',
          tags: ['openclaw', 'daily', date],
          created_at: `${date}T00:00:00.000Z`,
          updated_at: stat.mtime.toISOString(),
          _isOpenClaw: true,
        }
      });
      continue;
    }

    for (const section of sections) {
      const newline = section.indexOf('\n');
      const title = (newline === -1 ? section : section.slice(0, newline)).trim();
      const body = (newline === -1 ? '' : section.slice(newline + 1)).trim();
      if (!title && !body) continue;
      const hash = createHash('md5').update(date + '-' + (title || 'untitled')).digest('hex').slice(0, 12);

      nodes.push({
        id: `openclaw-day-${date}-${hash}`,
        payload: {
          content: body || title,
          category: `openclaw-daily`,
          subcategory: `${date}: ${title}`,
          importance: 4,
          source: 'openclaw',
          tags: ['openclaw', 'daily', date],
          created_at: `${date}T00:00:00.000Z`,
          updated_at: stat.mtime.toISOString(),
          _isOpenClaw: true,
        }
      });
    }
  }

  return nodes;
}

// --- OpenClaw Bridge: In-Memory Store ---

let _openclawNodes = [];
let _openclawCategories = [];
let _openclawLastSync = null;

function syncOpenClawBridge() {
  const config = loadBridgeConfig('openclaw');
  if (!config?.enabled || !config?.workspacePath) {
    _openclawNodes = [];
    _openclawCategories = [];
    return { nodes: 0, categories: 0 };
  }

  const wsPath = config.workspacePath;
  const memoryMdPath = join(wsPath, 'MEMORY.md');
  const memoryDir = join(wsPath, 'memory');

  const ltNodes = parseMemoryMd(memoryMdPath);
  const dailyNodes = parseDailyLogs(memoryDir);
  const cfgNodes = parseWorkspaceConfigs(wsPath);
  _openclawNodes = [...ltNodes, ...dailyNodes, ...cfgNodes];

  // Build ephemeral categories
  _openclawCategories = [
    {
      name: 'openclaw',
      description: 'OpenClaw workspace memories',
      is_parent: true,
      color: '#f97316',
      created_at: new Date().toISOString(),
      _ephemeral: true,
    }
  ];

  if (ltNodes.length > 0) {
    _openclawCategories.push({
      name: 'openclaw-longterm',
      description: 'Curated long-term memories from MEMORY.md',
      parent: 'openclaw',
      color: '#fb923c',
      created_at: new Date().toISOString(),
      _ephemeral: true,
    });
  }

  if (dailyNodes.length > 0) {
    _openclawCategories.push({
      name: 'openclaw-daily',
      description: 'Daily memory logs',
      parent: 'openclaw',
      color: '#fdba74',
      created_at: new Date().toISOString(),
      _ephemeral: true,
    });
  }

  if (cfgNodes.length > 0) {
    _openclawCategories.push({
      name: 'openclaw-config',
      description: 'Workspace config (Soul, Identity, Tools, etc.)',
      parent: 'openclaw',
      color: '#fed7aa',
      created_at: new Date().toISOString(),
      _ephemeral: true,
    });
  }

  _openclawLastSync = new Date().toISOString();
  config.lastSync = _openclawLastSync;
  saveBridgeConfig('openclaw', config);

  return {
    nodes: _openclawNodes.length,
    categories: _openclawCategories.length,
    longTermNodes: ltNodes.length,
    dailyNodes: dailyNodes.length,
    configNodes: cfgNodes.length,
  };
}

// GET /api/connections — Returns SQLite database info (legacy endpoint for UI compat)
app.get('/api/connections', (req, res) => {
  try {
    const dbPath = getDbPath();
    const dbExists = existsSync(dbPath);
    const memCount = dbExists ? countMemories() : 0;
    res.json({
      connections: [{
        id: 'sqlite',
        label: 'Local SQLite',
        url: dbPath,
        collection: 'memories',
        points: memCount,
        reachable: dbExists,
        active: true,
      }],
      active: 'sqlite',
    });
  } catch (err) {
    console.error('GET /api/connections error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════
// LOOP TEMPLATES
// ═══════════════════════════════════════════

const LOOP_TEMPLATES_PATH = resolve(PROJECT_ROOT, 'data', 'loop-templates.json');
const LOOP_SCHEDULES_PATH = resolve(PROJECT_ROOT, 'data', 'loop-schedules.json');
const LOOP_DIR = resolve(PROJECT_ROOT, 'data', 'loop');

function readLoopTemplates() {
  try {
    if (existsSync(LOOP_TEMPLATES_PATH)) {
      return JSON.parse(readFileSync(LOOP_TEMPLATES_PATH, 'utf-8'));
    }
  } catch { /* corrupt file */ }
  return [];
}

function writeLoopTemplates(templates) {
  writeFileSync(LOOP_TEMPLATES_PATH, JSON.stringify(templates, null, 2));
}

// GET /api/loop/templates — list all saved templates
app.get('/api/loop/templates', (req, res) => {
  res.json(readLoopTemplates());
});

// POST /api/loop/templates — create a template
app.post('/api/loop/templates', (req, res) => {
  const { name, description, task, context, iterations, maxMinutes, icon, category, usesBrowser } = req.body;
  if (!name?.trim() || !task?.trim()) {
    return res.status(400).json({ error: 'name and task are required' });
  }
  const templates = readLoopTemplates();
  const id = randomBytes(12).toString('hex');
  const template = {
    id,
    name: name.trim(),
    description: (description || '').trim(),
    task: task.trim(),
    context: (context || '').trim() || null,
    iterations: Math.min(Math.max(iterations || 10, 1), 200),
    maxMinutes: Math.min(Math.max(maxMinutes || 30, 1), 480),
    usesBrowser: usesBrowser || false,
    icon: icon || '\u{1F504}',
    category: category || 'custom',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  templates.push(template);
  writeLoopTemplates(templates);
  res.json(template);
});

// GET /api/loop/templates/export — export all templates as JSON (must be before /:id)
app.get('/api/loop/templates/export', (req, res) => {
  const templates = readLoopTemplates();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="synabun-loop-templates.json"');
  res.json({
    version: 1,
    type: 'synabun-loop-templates',
    exportedAt: new Date().toISOString(),
    templates,
  });
});

// POST /api/loop/templates/import — import templates from JSON
app.post('/api/loop/templates/import', (req, res) => {
  const { templates: incoming, template: single } = req.body;
  const toImport = incoming || (single ? [single] : null);
  if (!toImport || !Array.isArray(toImport)) {
    return res.status(400).json({ error: 'Invalid import format: expected templates array or template object' });
  }
  const existing = readLoopTemplates();
  let added = 0;
  let updated = 0;
  for (const t of toImport) {
    if (!t.name?.trim() || !t.task?.trim()) continue;
    const existingIdx = existing.findIndex(e => e.name === t.name);
    const template = {
      id: t.id || randomBytes(12).toString('hex'),
      name: t.name.trim(),
      description: (t.description || '').trim(),
      task: t.task.trim(),
      context: (t.context || '').trim() || null,
      iterations: Math.min(Math.max(t.iterations || 10, 1), 200),
      maxMinutes: Math.min(Math.max(t.maxMinutes || 30, 1), 480),
      usesBrowser: t.usesBrowser || false,
      icon: t.icon || '\u{1F504}',
      category: t.category || 'custom',
      createdAt: t.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (existingIdx >= 0) {
      template.id = existing[existingIdx].id; // keep original id
      existing[existingIdx] = template;
      updated++;
    } else {
      existing.push(template);
      added++;
    }
  }
  writeLoopTemplates(existing);
  res.json({ ok: true, added, updated, total: existing.length });
});

// PUT /api/loop/templates/:id — update a template
app.put('/api/loop/templates/:id', (req, res) => {
  const templates = readLoopTemplates();
  const idx = templates.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Template not found' });
  const { name, description, task, context, iterations, maxMinutes, icon, category, usesBrowser } = req.body;
  if (name !== undefined) templates[idx].name = name.trim();
  if (description !== undefined) templates[idx].description = description.trim();
  if (task !== undefined) templates[idx].task = task.trim();
  if (context !== undefined) templates[idx].context = context.trim() || null;
  if (iterations !== undefined) templates[idx].iterations = Math.min(Math.max(iterations, 1), 200);
  if (maxMinutes !== undefined) templates[idx].maxMinutes = Math.min(Math.max(maxMinutes, 1), 480);
  if (icon !== undefined) templates[idx].icon = icon;
  if (category !== undefined) templates[idx].category = category;
  if (usesBrowser !== undefined) templates[idx].usesBrowser = !!usesBrowser;
  templates[idx].updatedAt = new Date().toISOString();
  writeLoopTemplates(templates);
  res.json(templates[idx]);
});

// DELETE /api/loop/templates/:id — delete a template
app.delete('/api/loop/templates/:id', (req, res) => {
  const templates = readLoopTemplates();
  const idx = templates.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Template not found' });
  templates.splice(idx, 1);
  writeLoopTemplates(templates);
  res.json({ ok: true });
});

// GET /api/loop/active — scan for active loop status
app.get('/api/loop/active', (req, res) => {
  try {
    if (!existsSync(LOOP_DIR)) return res.json({ active: false, loops: [] });
    const files = readdirSync(LOOP_DIR).filter(f => f.endsWith('.json'));
    const activeLoops = [];
    for (const f of files) {
      try {
        const filePath = resolve(LOOP_DIR, f);
        const data = JSON.parse(readFileSync(filePath, 'utf-8'));
        if (data?.active) {
          const elapsed = Date.now() - new Date(data.startedAt).getTime();
          const maxMs = ((data.maxMinutes || 30) + 5) * 60 * 1000;
          // Stale loop — past time cap + grace, delete it
          if (elapsed >= maxMs) {
            try { unlinkSync(filePath); } catch { /* ok */ }
            continue;
          }
          // Dead PTY session (abrupt close) — delete after 2min grace
          if (data.terminalSessionId && !terminalSessions.has(data.terminalSessionId)) {
            const lastActivity = new Date(data.lastIterationAt || data.startedAt || 0).getTime();
            if (Date.now() - lastActivity > 2 * 60 * 1000) {
              try { unlinkSync(filePath); } catch { /* ok */ }
              continue;
            }
          }
          activeLoops.push({
            sessionId: f.replace('.json', ''),
            task: data.task,
            context: data.context,
            currentIteration: data.currentIteration || 0,
            totalIterations: data.totalIterations || 10,
            maxMinutes: data.maxMinutes || 30,
            elapsedMinutes: Math.round(elapsed / 60000),
            remainingMinutes: Math.max(0, Math.round(((data.maxMinutes || 30) * 60 * 1000 - elapsed) / 60000)),
            startedAt: data.startedAt,
            lastIterationAt: data.lastIterationAt,
            browserSessionId: data.browserSessionId || null,
            browserTabId: data.browserTabId || null,
            terminalSessionId: data.terminalSessionId || null,
          });
        } else {
          // Inactive loop file — delete it (no history keeping)
          try { unlinkSync(filePath); } catch { /* ok */ }
        }
      } catch { /* skip corrupt */ }
    }
    // Backward compat: first active loop populates top-level fields
    if (activeLoops.length > 0) {
      const first = activeLoops[0];
      return res.json({ active: true, ...first, loops: activeLoops });
    }
    return res.json({ active: false, loops: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/loop/launch — create loop state + terminal session atomically
app.post('/api/loop/launch', async (req, res) => {
  try {
    const { task, context, iterations, maxMinutes, usesBrowser, cwd, profile, model, browserSessionId: requestedBrowserSessionId } = req.body;
    if (!task?.trim()) return res.status(400).json({ error: 'task is required' });

    // Validate profile if provided
    const cliProfile = profile || 'claude-code';
    const validProfiles = Object.keys(loadCliConfig());
    if (!validProfiles.includes(cliProfile) && cliProfile !== 'shell') {
      return res.status(400).json({ error: `Invalid profile: ${cliProfile}. Valid: ${validProfiles.join(', ')}` });
    }

    // 1. Ensure loop directory exists
    if (!existsSync(LOOP_DIR)) mkdirSync(LOOP_DIR, { recursive: true });

    // 1b. Clean up stale/dead loop files — but allow multiple concurrent loops
    const existing = readdirSync(LOOP_DIR).filter(f => f.endsWith('.json') && f !== '.gitkeep');
    for (const f of existing) {
      try {
        const data = JSON.parse(readFileSync(resolve(LOOP_DIR, f), 'utf-8'));
        if (!data.active && !data.pending) continue; // already finished
        // Only kill loops whose terminal is dead (stale cleanup)
        const termAlive = data.terminalSessionId && terminalSessions.has(data.terminalSessionId);
        if (!termAlive) {
          console.log(`[loop] Cleaning up stale loop file ${f} (terminal gone)`);
          try { unlinkSync(resolve(LOOP_DIR, f)); } catch { /* ok */ }
        }
        // Active loops with live terminals are left running — multi-loop coexistence
      } catch { /* skip corrupt */ }
    }

    // 1c. Acquire a DEDICATED browser session for this loop.
    // Each automation gets its own browser session for isolation — no sharing.
    // The UI may pre-create one (passing browserSessionId), or we create server-side.
    let browserSessionId = null;
    let browserTabId = null;
    if (usesBrowser) {
      // Strategy 1: UI pre-created a dedicated session — claim it
      if (requestedBrowserSessionId && browserSessions.has(requestedBrowserSessionId)) {
        const candidate = browserSessions.get(requestedBrowserSessionId);
        try {
          await candidate.page.evaluate('1');
          browserSessionId = requestedBrowserSessionId;
          console.log(`[loop] Claimed UI-created browser session ${browserSessionId}`);
        } catch {
          console.warn(`[loop] UI-provided session ${requestedBrowserSessionId} is a zombie — destroying`);
          await destroyBrowserSession(requestedBrowserSessionId).catch(() => {});
        }
      }

      // Strategy 2: No session from UI — wait briefly for one the UI is opening
      if (!browserSessionId && !requestedBrowserSessionId) {
        const maxWait = 15000;
        const pollInterval = 500;
        let waited = 0;
        // Look for the NEWEST session (not existingIds[0]) to avoid stealing another loop's session.
        // Track which sessions existed before we started waiting.
        const preExistingIds = new Set(browserSessions.keys());
        while (waited < maxWait) {
          for (const [id, session] of browserSessions) {
            if (preExistingIds.has(id)) continue; // skip sessions that existed before launch
            try {
              await session.page.evaluate('1');
              browserSessionId = id;
              break;
            } catch {
              console.warn(`[loop] New browser session ${id} is a zombie — destroying`);
              await destroyBrowserSession(id).catch(() => {});
            }
          }
          if (browserSessionId) break;
          await new Promise(r => setTimeout(r, pollInterval));
          waited += pollInterval;
        }
        if (browserSessionId) {
          console.log(`[loop] Found new browser session ${browserSessionId} (waited ${waited}ms)`);
        }
      }

      // Strategy 3: Still nothing — create a dedicated session server-side
      if (!browserSessionId) {
        try {
          const result = await createBrowserSession({ url: 'about:blank' });
          browserSessionId = result.sessionId;
          console.log(`[loop] Created dedicated browser session ${browserSessionId}`);
          broadcastSync({
            type: 'browser:session-created',
            sessionId: browserSessionId, url: 'about:blank',
            profileMode: result.profileMode, profileSource: result.profileSource,
          });
        } catch (err) {
          console.warn(`[loop] Failed to create browser session: ${err.message} — MCP agent will auto-create`);
        }
      }

      // Claim the session: clear grace timer, create a dedicated tab
      if (browserSessionId) {
        const claimedSession = browserSessions.get(browserSessionId);
        if (claimedSession?.graceTimer) {
          clearTimeout(claimedSession.graceTimer);
          claimedSession.graceTimer = null;
          console.log(`[loop] Cleared grace timer on session ${browserSessionId}`);
        }
        if (claimedSession?.tabs && claimedSession.tabs.size > 0) {
          try {
            const newTab = await createSessionTab(claimedSession, browserSessionId, 'about:blank');
            browserTabId = newTab.tabId;
            await _switchSessionTab(claimedSession, browserSessionId, browserTabId);
            console.log(`[loop] Created new tab ${browserTabId} in session ${browserSessionId}`);
          } catch (err) {
            console.warn(`[loop] Failed to create new tab, reusing active tab:`, err.message);
            browserTabId = claimedSession.activeTabId;
          }
        } else {
          browserTabId = claimedSession?.activeTabId || null;
        }
      }
    }

    // 2. Create terminal PTY session with selected CLI profile + optional model flag
    // Default CWD to Synabun project root — it has no .mcp.json, so no auth-requiring
    // MCP servers (e.g. supabase OAuth) trigger the "needs auth" prompt that blocks loops.
    // The SynaBun MCP server is registered globally in ~/.claude.json, so it's always available.
    const loopCwd = cwd || PROJECT_ROOT;
    // Pre-generate terminal session ID so we can inject it into the PTY environment.
    // SYNABUN_TERMINAL_SESSION lets hooks correlate with the correct loop file
    // after /clear changes the Claude session ID. This is the key to multi-loop isolation.
    const terminalSessionId = randomBytes(16).toString('hex');
    const loopExtraEnv = { SYNABUN_TERMINAL_SESSION: terminalSessionId };
    if (browserSessionId) loopExtraEnv.SYNABUN_BROWSER_SESSION = browserSessionId;
    createTerminalSession(cliProfile, 120, 30, loopCwd, { model, extraEnv: loopExtraEnv, sessionId: terminalSessionId });

    // 3. Create pending loop state file (placeholder — prompt-submit hook will rename)
    const pendingId = 'pending-' + randomBytes(8).toString('hex');
    const loopState = {
      active: true,
      task: task.trim(),
      context: context?.trim() || null,
      totalIterations: Math.min(Math.max(iterations || 10, 1), 200),
      currentIteration: 0,
      maxMinutes: Math.min(Math.max(maxMinutes || 30, 1), 480),
      startedAt: new Date().toISOString(),
      lastIterationAt: null,
      retries: 0,
      pending: true,
      terminalSessionId,
      usesBrowser: !!usesBrowser,
      browserSessionId,
      browserTabId: browserTabId || null,
      profile: cliProfile,
      model: model || null,
    };
    writeFileSync(resolve(LOOP_DIR, `${pendingId}.json`), JSON.stringify(loopState, null, 2));

    // Attach loop driver to watch for iteration transitions (/clear + re-prompt)
    attachLoopDriver(terminalSessionId);

    broadcastSync({ type: 'terminal:session-created', sessionId: terminalSessionId, profile: cliProfile });

    res.json({ ok: true, pendingId, terminalSessionId, browserSessionId, browserTabId: loopState.browserTabId });
  } catch (err) {
    console.error('POST /api/loop/launch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/loop/stop — force-stop active/pending loops and clean up PTY sessions
app.post('/api/loop/stop', (req, res) => {
  try {
    if (!existsSync(LOOP_DIR)) return res.json({ ok: true, stopped: 0 });
    const files = readdirSync(LOOP_DIR).filter(f => f.endsWith('.json') && f !== '.gitkeep');
    let stopped = 0;
    for (const f of files) {
      try {
        const filePath = resolve(LOOP_DIR, f);
        const data = JSON.parse(readFileSync(filePath, 'utf-8'));
        if (data.active || data.pending) {
          // Kill PTY session if still alive
          if (data.terminalSessionId && terminalSessions.has(data.terminalSessionId)) {
            const session = terminalSessions.get(data.terminalSessionId);
            try { session.pty.kill(); } catch {}
            terminalSessions.delete(data.terminalSessionId);
          }
          // Destroy the loop's dedicated browser session
          if (data.browserSessionId && browserSessions.has(data.browserSessionId)) {
            destroyBrowserSession(data.browserSessionId).catch(err => {
              console.warn(`[loop/stop] Failed to destroy browser session ${data.browserSessionId}:`, err.message);
            });
          }
          // Delete the loop file — no history keeping
          try { unlinkSync(filePath); } catch { /* ok */ }
          stopped++;
        }
      } catch { /* skip corrupt */ }
    }
    res.json({ ok: true, stopped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/loop/history — no history keeping, always empty
app.get('/api/loop/history', (_req, res) => { res.json([]); });

// DELETE /api/loop/history/:id — no-op, files are deleted on stop
app.delete('/api/loop/history/:id', (_req, res) => { res.json({ ok: true }); });

// POST /api/loop/complete — store a completed loop as a SQLite memory
app.post('/api/loop/complete', async (req, res) => {
  try {
    const { task, context, template, iterations, duration, result, tags } = req.body;
    if (!task) return res.status(400).json({ error: 'task is required' });

    const content = [
      `Automation: ${task}`,
      context ? `Context: ${context}` : null,
      template ? `Template: ${template}` : null,
      `Iterations: ${iterations || '?'}`,
      `Duration: ${duration || '?'}`,
      result ? `Result: ${result}` : null,
    ].filter(Boolean).join('\n');

    const embedding = await getEmbedding(content);
    const id = randomUUID();
    const now = new Date().toISOString();
    const d = getDb();

    d.prepare(`INSERT OR REPLACE INTO memories (id, vector, content, category, subcategory, project, importance, tags, source, created_at, updated_at, accessed_at, access_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, encodeVector(embedding), content, 'automations', 'loop-result', 'synabun',
      6, JSON.stringify(tags || ['automation', 'loop']), 'auto-saved',
      now, now, now, 0
    );

    invalidateMemoriesCache('loop:complete');
    res.json({ ok: true, id });
  } catch (err) {
    console.error('POST /api/loop/complete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// LOOP SCHEDULES — Cron-driven social engagement scheduler
// Server-side setInterval evaluator that auto-launches loops
// at scheduled times, respecting timezones and day themes.
// ═══════════════════════════════════════════════════════════════

function loadSchedules() {
  try {
    if (existsSync(LOOP_SCHEDULES_PATH)) {
      const data = JSON.parse(readFileSync(LOOP_SCHEDULES_PATH, 'utf-8'));
      return data.schedules || [];
    }
  } catch { /* corrupt */ }
  return [];
}

function saveSchedules(schedules) {
  writeFileSync(LOOP_SCHEDULES_PATH, JSON.stringify({ schedules }, null, 2));
}

// ── Cron Parser ──

function parseCronField(field, min, max) {
  const values = new Set();
  for (const part of field.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '*') {
      for (let i = min; i <= max; i++) values.add(i);
    } else if (trimmed.includes('/')) {
      const [range, step] = trimmed.split('/');
      const stepNum = parseInt(step, 10);
      let start = min, end = max;
      if (range !== '*') {
        if (range.includes('-')) {
          const parts = range.split('-').map(Number);
          start = parts[0]; end = parts[1];
        } else {
          start = parseInt(range, 10);
        }
      }
      for (let i = start; i <= end; i += stepNum) values.add(i);
    } else if (trimmed.includes('-')) {
      const parts = trimmed.split('-').map(Number);
      for (let i = parts[0]; i <= parts[1]; i++) values.add(i);
    } else {
      const n = parseInt(trimmed, 10);
      if (!isNaN(n)) values.add(n);
    }
  }
  return values;
}

function cronMatchesDate(cronStr, date) {
  const fields = cronStr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  return parseCronField(minute, 0, 59).has(date.getMinutes()) &&
    parseCronField(hour, 0, 23).has(date.getHours()) &&
    parseCronField(dayOfMonth, 1, 31).has(date.getDate()) &&
    parseCronField(month, 1, 12).has(date.getMonth() + 1) &&
    parseCronField(dayOfWeek, 0, 6).has(date.getDay());
}

// Get the current time in a given timezone as a Date object
function getNowInTimezone(tz) {
  try {
    const str = new Date().toLocaleString('en-US', { timeZone: tz });
    return new Date(str);
  } catch {
    return new Date();
  }
}

// Compute next cron fire time (for display), up to 7 days ahead
function getNextCronRun(cronStr, tz) {
  const now = getNowInTimezone(tz);
  const candidate = new Date(now);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  const maxIterations = 7 * 24 * 60;
  for (let i = 0; i < maxIterations; i++) {
    if (cronMatchesDate(cronStr, candidate)) {
      return candidate.toISOString();
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}

// Describe a cron expression in human-readable form
function describeCron(cronStr) {
  const fields = cronStr.trim().split(/\s+/);
  if (fields.length !== 5) return cronStr;
  const [minute, hour, , , dayOfWeek] = fields;
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let dayPart = '';
  if (dayOfWeek === '*') dayPart = 'Every day';
  else if (dayOfWeek === '1-5') dayPart = 'Weekdays';
  else if (dayOfWeek === '0,6') dayPart = 'Weekends';
  else {
    const days = [...parseCronField(dayOfWeek, 0, 6)].sort().map(d => dayNames[d]);
    dayPart = days.join(', ');
  }
  const timePart = hour === '*' ? `every hour at :${minute.padStart(2, '0')}` :
    [...parseCronField(hour, 0, 23)].sort((a, b) => a - b)
      .map(h => `${String(h).padStart(2, '0')}:${minute.padStart(2, '0')}`).join(', ');
  return `${dayPart} at ${timePart}`;
}

// ── Schedule Evaluator ──

let _scheduleEvaluatorTimer = null;
const SCHEDULE_EVAL_INTERVAL = 60_000;
const _scheduleFiringLock = new Set();
const _scheduleTimers = new Map(); // scheduleId → { timeoutId, firesAt, minutes }
let _scheduleEvalCount = 0;

async function launchScheduledLoop(schedule) {
  const templates = readLoopTemplates();
  const template = templates.find(t => t.id === schedule.templateId);
  if (!template) {
    console.warn(`[schedule] Template ${schedule.templateId} not found for schedule ${schedule.id}`);
    const schedules = loadSchedules();
    const idx = schedules.findIndex(s => s.id === schedule.id);
    if (idx !== -1) {
      schedules[idx].lastRun = new Date().toISOString();
      schedules[idx].lastRunResult = 'template_missing';
      schedules[idx].nextRun = getNextCronRun(schedule.cron, schedule.timezone);
      saveSchedules(schedules);
    }
    broadcastSync({ type: 'schedule:failed', scheduleId: schedule.id, reason: 'template_missing' });
    return;
  }

  // Merge dayTheme context if available
  const now = getNowInTimezone(schedule.timezone);
  const dayOfWeek = now.getDay();
  const dayTheme = schedule.dayThemes?.[String(dayOfWeek)];
  let context = template.context || '';
  if (dayTheme?.contextOverride) {
    context = context ? `${context}\n\n--- Day Theme ---\n${dayTheme.contextOverride}` : dayTheme.contextOverride;
  }

  console.log(`[schedule] Firing schedule "${schedule.name}" (template: ${template.name}, day: ${dayOfWeek})`);
  broadcastSync({ type: 'schedule:fired', scheduleId: schedule.id, scheduleName: schedule.name, templateName: template.name, dayOfWeek });

  try {
    if (!existsSync(LOOP_DIR)) mkdirSync(LOOP_DIR, { recursive: true });

    // Clean up stale/dead loop files — but allow multiple concurrent loops
    const existing = readdirSync(LOOP_DIR).filter(f => f.endsWith('.json') && f !== '.gitkeep');
    for (const f of existing) {
      try {
        const data = JSON.parse(readFileSync(resolve(LOOP_DIR, f), 'utf-8'));
        if (!data.active && !data.pending) continue; // already finished
        // Only kill loops whose terminal is dead (stale cleanup)
        const termAlive = data.terminalSessionId && terminalSessions.has(data.terminalSessionId);
        if (!termAlive) {
          console.log(`[schedule] Cleaning up stale loop file ${f} (terminal gone)`);
          try { unlinkSync(resolve(LOOP_DIR, f)); } catch { /* ok */ }
        }
        // Active loops with live terminals are left running — multi-loop coexistence
      } catch { /* skip corrupt */ }
    }

    const cliProfile = schedule.profile || 'claude-code';
    const cliModel = schedule.model || null;
    const scheduledUsesBrowser = schedule.usesBrowser !== undefined ? !!schedule.usesBrowser : !!template.usesBrowser;

    // Create dedicated browser session for scheduled loops that need one
    let scheduledBrowserSessionId = null;
    const schedExtraEnv = {};
    if (scheduledUsesBrowser) {
      try {
        const result = await createBrowserSession({ url: 'about:blank' });
        scheduledBrowserSessionId = result.sessionId;
        schedExtraEnv.SYNABUN_BROWSER_SESSION = scheduledBrowserSessionId;
        console.log(`[schedule] Created dedicated browser session ${scheduledBrowserSessionId}`);
        broadcastSync({
          type: 'browser:session-created',
          sessionId: scheduledBrowserSessionId, url: 'about:blank',
          profileMode: result.profileMode, profileSource: result.profileSource,
        });
      } catch (err) {
        console.warn(`[schedule] Failed to create browser session: ${err.message}`);
      }
    }

    const terminalSessionId = createTerminalSession(cliProfile, 120, 30, PROJECT_ROOT, { model: cliModel, extraEnv: schedExtraEnv });

    const pendingId = 'pending-' + randomBytes(8).toString('hex');
    const loopState = {
      active: true,
      task: template.task,
      context: context || null,
      totalIterations: Math.min(Math.max(template.iterations || 10, 1), 200),
      currentIteration: 0,
      maxMinutes: Math.min(Math.max(template.maxMinutes || 30, 1), 480),
      startedAt: new Date().toISOString(),
      lastIterationAt: null,
      retries: 0,
      pending: true,
      terminalSessionId,
      usesBrowser: scheduledUsesBrowser,
      browserSessionId: scheduledBrowserSessionId,
      profile: cliProfile,
      model: cliModel,
      scheduledBy: schedule.id,
    };
    writeFileSync(resolve(LOOP_DIR, `${pendingId}.json`), JSON.stringify(loopState, null, 2));

    attachLoopDriver(terminalSessionId);
    broadcastSync({ type: 'terminal:session-created', sessionId: terminalSessionId, profile: cliProfile });

    // Update schedule metadata
    const schedules = loadSchedules();
    const idx = schedules.findIndex(s => s.id === schedule.id);
    if (idx !== -1) {
      schedules[idx].lastRun = new Date().toISOString();
      schedules[idx].lastRunResult = 'launched';
      schedules[idx].runCount = (schedules[idx].runCount || 0) + 1;
      schedules[idx].nextRun = getNextCronRun(schedule.cron, schedule.timezone);
      schedules[idx].updatedAt = new Date().toISOString();
      saveSchedules(schedules);
    }

    broadcastSync({ type: 'schedule:completed', scheduleId: schedule.id, pendingId, terminalSessionId, profile: cliProfile });
    console.log(`[schedule] Launched loop for "${schedule.name}" → terminal ${terminalSessionId} (${cliProfile}/${cliModel || 'default'})`);
  } catch (err) {
    console.error(`[schedule] Failed to launch loop for "${schedule.name}":`, err.message);
    const schedules = loadSchedules();
    const idx = schedules.findIndex(s => s.id === schedule.id);
    if (idx !== -1) {
      schedules[idx].lastRun = new Date().toISOString();
      schedules[idx].lastRunResult = `error: ${err.message}`;
      schedules[idx].nextRun = getNextCronRun(schedule.cron, schedule.timezone);
      saveSchedules(schedules);
    }
    broadcastSync({ type: 'schedule:failed', scheduleId: schedule.id, reason: err.message });
  }
}

// Stagger queue for concurrent schedules firing at the same minute
const _scheduleQueue = [];
let _scheduleQueueRunning = false;

async function processScheduleQueue() {
  if (_scheduleQueueRunning) return;
  _scheduleQueueRunning = true;
  while (_scheduleQueue.length > 0) {
    const schedule = _scheduleQueue.shift();
    await launchScheduledLoop(schedule);
    if (_scheduleQueue.length > 0) {
      await new Promise(r => setTimeout(r, 30_000)); // 30s stagger
    }
  }
  _scheduleQueueRunning = false;
}

function evaluateSchedules() {
  _scheduleEvalCount++;
  const schedules = loadSchedules();
  const enabled = schedules.filter(s => s.enabled);

  // Log every 5th eval (~5 min) or when schedules exist
  if (enabled.length > 0 || _scheduleEvalCount % 5 === 0) {
    console.log(`[schedule] Eval #${_scheduleEvalCount}: ${enabled.length} enabled / ${schedules.length} total`);
  }

  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    const tz = schedule.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = getNowInTimezone(tz);

    // Minute-level dedup key to prevent double-fires
    const fireKey = `${schedule.id}:${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    if (_scheduleFiringLock.has(fireKey)) continue;

    const matches = cronMatchesDate(schedule.cron, now);
    if (enabled.length > 0 && _scheduleEvalCount % 5 === 0) {
      console.log(`[schedule]   "${schedule.name}" cron=${schedule.cron} now=${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')} match=${matches}`);
    }

    if (matches) {
      // If dayThemes are defined and current day has no entry, skip
      if (schedule.dayThemes && Object.keys(schedule.dayThemes).length > 0) {
        if (!schedule.dayThemes[String(now.getDay())]) {
          console.log(`[schedule]   Skipped "${schedule.name}" — no dayTheme for day ${now.getDay()}`);
          continue;
        }
      }

      console.log(`[schedule] ✓ Cron match for "${schedule.name}" at ${now.toLocaleString()}`);
      _scheduleFiringLock.add(fireKey);
      setTimeout(() => _scheduleFiringLock.delete(fireKey), 120_000);

      _scheduleQueue.push(schedule);
      processScheduleQueue();
    }
  }
}

function startScheduleEvaluator() {
  stopScheduleEvaluator();
  _scheduleEvaluatorTimer = setInterval(evaluateSchedules, SCHEDULE_EVAL_INTERVAL);
  console.log('[schedule] Evaluator started (60s interval)');

  // Deferred missed-fire check (wait for terminalSessions and other globals to init)
  setTimeout(() => {
    const schedules = loadSchedules();
    for (const schedule of schedules) {
      if (!schedule.enabled || !schedule.nextRun) continue;
      const nextRun = new Date(schedule.nextRun);
      const now = new Date();
      const gracePeriodMs = 5 * 60 * 1000;
      if (nextRun < now && (now - nextRun) < gracePeriodMs) {
        console.log(`[schedule] Missed fire detected for "${schedule.name}" (was due ${schedule.nextRun})`);
        _scheduleQueue.push(schedule);
        processScheduleQueue();
      }
    }
  }, 10_000);
}

function stopScheduleEvaluator() {
  if (_scheduleEvaluatorTimer) {
    clearInterval(_scheduleEvaluatorTimer);
    _scheduleEvaluatorTimer = null;
  }
}

// Boot: start schedule evaluator
startScheduleEvaluator();

// ── Quick Timer (standalone, no schedule needed) ──

const _quickTimers = new Map(); // timerId → { timeoutId, templateId, templateName, firesAt, minutes, profile, model, usesBrowser, createdAt }

function launchQuickTimer(timerId, templateId, context) {
  const templates = readLoopTemplates();
  const template = templates.find(t => t.id === templateId);
  if (!template) {
    console.warn(`[quick-timer] Template ${templateId} not found`);
    broadcastSync({ type: 'quick-timer:failed', timerId, reason: 'template_missing' });
    return;
  }
  const timerData = _quickTimers.get(timerId) || {};
  const fakeSchedule = {
    id: `qt-${timerId}`,
    name: `Quick: ${template.name}`,
    templateId,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    dayThemes: {},
    profile: timerData.profile || undefined,
    model: timerData.model || undefined,
    usesBrowser: timerData.usesBrowser,
  };
  console.log(`[quick-timer] Firing "${template.name}" (timer ${timerId}) profile=${fakeSchedule.profile || 'default'} model=${fakeSchedule.model || 'default'}`);
  _scheduleQueue.push(fakeSchedule);
  processScheduleQueue();
  broadcastSync({ type: 'quick-timer:fired', timerId, templateName: template.name });
}

// POST /api/quick-timer — fire a template after N minutes (standalone, no schedule)
app.post('/api/quick-timer', (req, res) => {
  try {
    const { templateId, minutes, context, profile, model, usesBrowser } = req.body;
    const mins = Number(minutes);
    if (!templateId?.trim()) return res.status(400).json({ error: 'templateId is required' });
    if (!mins || mins < 1 || mins > 1440) return res.status(400).json({ error: 'minutes must be 1–1440' });

    const templates = readLoopTemplates();
    const template = templates.find(t => t.id === templateId);
    if (!template) return res.status(400).json({ error: 'Template not found' });

    const timerId = randomBytes(8).toString('hex');
    const firesAt = new Date(Date.now() + mins * 60_000).toISOString();
    const timerProfile = profile || 'claude-code';
    const timerModel = model || null;
    const timerUsesBrowser = usesBrowser !== undefined ? !!usesBrowser : !!template.usesBrowser;

    const timeoutId = setTimeout(() => {
      launchQuickTimer(timerId, templateId, context);
      _quickTimers.delete(timerId);
    }, mins * 60_000);

    _quickTimers.set(timerId, { timeoutId, templateId, templateName: template.name, firesAt, minutes: mins, profile: timerProfile, model: timerModel, usesBrowser: timerUsesBrowser, createdAt: new Date().toISOString() });
    console.log(`[quick-timer] Set: "${template.name}" fires in ${mins}m at ${firesAt} (${timerProfile}/${timerModel || 'default'})`);
    broadcastSync({ type: 'quick-timer:set', timerId, templateName: template.name, firesAt, minutes: mins, profile: timerProfile, model: timerModel, usesBrowser: timerUsesBrowser });
    res.json({ ok: true, timerId, templateName: template.name, firesAt, minutes: mins, profile: timerProfile, model: timerModel, usesBrowser: timerUsesBrowser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/quick-timers — list active quick timers
app.get('/api/quick-timers', (_req, res) => {
  const timers = [];
  for (const [id, t] of _quickTimers) {
    timers.push({ id, templateId: t.templateId, templateName: t.templateName, firesAt: t.firesAt, minutes: t.minutes, profile: t.profile, model: t.model, usesBrowser: t.usesBrowser, createdAt: t.createdAt });
  }
  res.json(timers);
});

// DELETE /api/quick-timers/:id — cancel a quick timer
app.delete('/api/quick-timers/:id', (req, res) => {
  const timer = _quickTimers.get(req.params.id);
  if (!timer) return res.status(404).json({ error: 'Timer not found' });
  clearTimeout(timer.timeoutId);
  _quickTimers.delete(req.params.id);
  console.log(`[quick-timer] Cancelled timer ${req.params.id}`);
  broadcastSync({ type: 'quick-timer:cancelled', timerId: req.params.id });
  res.json({ ok: true });
});

// POST /api/quick-timer/now — fire a template immediately (same pipeline as scheduled, for debugging)
app.post('/api/quick-timer/now', (req, res) => {
  try {
    const { templateId, profile, model, usesBrowser } = req.body;
    if (!templateId?.trim()) return res.status(400).json({ error: 'templateId is required' });

    const templates = readLoopTemplates();
    const template = templates.find(t => t.id === templateId);
    if (!template) return res.status(400).json({ error: 'Template not found' });

    const timerProfile = profile || 'claude-code';
    const timerModel = model || null;
    const timerUsesBrowser = usesBrowser !== undefined ? !!usesBrowser : !!template.usesBrowser;

    const fakeSchedule = {
      id: `qt-now-${randomBytes(4).toString('hex')}`,
      name: `Now: ${template.name}`,
      templateId,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      dayThemes: {},
      profile: timerProfile,
      model: timerModel,
      usesBrowser: timerUsesBrowser,
    };

    console.log(`[quick-timer] Firing NOW "${template.name}" profile=${timerProfile} model=${timerModel || 'default'}`);
    _scheduleQueue.push(fakeSchedule);
    processScheduleQueue();

    broadcastSync({ type: 'quick-timer:fired-now', templateName: template.name, profile: timerProfile, model: timerModel });
    res.json({ ok: true, templateName: template.name, profile: timerProfile, model: timerModel, usesBrowser: timerUsesBrowser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Schedule REST API ──

// GET /api/schedules — list all schedules
app.get('/api/schedules', (_req, res) => {
  res.json(loadSchedules());
});

// GET /api/schedules/timers — list all active timers (must be before :id routes)
app.get('/api/schedules/timers', (_req, res) => {
  const timers = {};
  for (const [id, t] of _scheduleTimers) {
    timers[id] = { firesAt: t.firesAt, minutes: t.minutes };
  }
  res.json(timers);
});

// POST /api/schedules — create a new schedule
app.post('/api/schedules', (req, res) => {
  try {
    const { name, templateId, cron, timezone, enabled, dayThemes, overrides } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    if (!templateId?.trim()) return res.status(400).json({ error: 'templateId is required' });
    if (!cron?.trim()) return res.status(400).json({ error: 'cron is required' });
    if (cron.trim().split(/\s+/).length !== 5) return res.status(400).json({ error: 'cron must be a 5-field expression' });

    const templates = readLoopTemplates();
    if (!templates.find(t => t.id === templateId)) return res.status(400).json({ error: 'Template not found' });

    const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const schedule = {
      id: randomBytes(12).toString('hex'),
      name: name.trim(),
      templateId,
      cron: cron.trim(),
      timezone: tz,
      enabled: enabled !== false,
      dayThemes: dayThemes || {},
      overrides: overrides || {},
      lastRun: null,
      lastRunResult: null,
      nextRun: getNextCronRun(cron.trim(), tz),
      runCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const schedules = loadSchedules();
    schedules.push(schedule);
    saveSchedules(schedules);

    broadcastSync({ type: 'schedule:created', schedule });
    res.json(schedule);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/schedules/:id — get a single schedule
app.get('/api/schedules/:id', (req, res) => {
  const schedules = loadSchedules();
  const schedule = schedules.find(s => s.id === req.params.id);
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
  res.json(schedule);
});

// PUT /api/schedules/:id — update a schedule
app.put('/api/schedules/:id', (req, res) => {
  try {
    const schedules = loadSchedules();
    const idx = schedules.findIndex(s => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Schedule not found' });

    const { name, templateId, cron, timezone, enabled, dayThemes, overrides } = req.body;
    if (name !== undefined) schedules[idx].name = name.trim();
    if (templateId !== undefined) {
      const templates = readLoopTemplates();
      if (!templates.find(t => t.id === templateId)) return res.status(400).json({ error: 'Template not found' });
      schedules[idx].templateId = templateId;
    }
    if (cron !== undefined) {
      if (cron.trim().split(/\s+/).length !== 5) return res.status(400).json({ error: 'cron must be a 5-field expression' });
      schedules[idx].cron = cron.trim();
    }
    if (timezone !== undefined) schedules[idx].timezone = timezone;
    if (typeof enabled === 'boolean') schedules[idx].enabled = enabled;
    if (dayThemes !== undefined) schedules[idx].dayThemes = dayThemes;
    if (overrides !== undefined) schedules[idx].overrides = overrides;

    schedules[idx].updatedAt = new Date().toISOString();
    schedules[idx].nextRun = getNextCronRun(schedules[idx].cron, schedules[idx].timezone);
    saveSchedules(schedules);

    broadcastSync({ type: 'schedule:updated', schedule: schedules[idx] });
    res.json(schedules[idx]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/schedules/:id — delete a schedule
app.delete('/api/schedules/:id', (req, res) => {
  try {
    const schedules = loadSchedules();
    const idx = schedules.findIndex(s => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Schedule not found' });
    const removed = schedules.splice(idx, 1)[0];
    saveSchedules(schedules);
    // Cancel any pending timer
    if (_scheduleTimers.has(removed.id)) {
      clearTimeout(_scheduleTimers.get(removed.id).timeoutId);
      _scheduleTimers.delete(removed.id);
    }
    broadcastSync({ type: 'schedule:deleted', scheduleId: removed.id });
    res.json({ ok: true, id: removed.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/schedules/:id/test — fire a schedule immediately for testing
app.post('/api/schedules/:id/test', async (req, res) => {
  try {
    const schedules = loadSchedules();
    const schedule = schedules.find(s => s.id === req.params.id);
    if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
    _scheduleQueue.push(schedule);
    processScheduleQueue();
    res.json({ ok: true, message: 'Schedule queued for immediate fire' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/schedules/:id/timer — fire a schedule after N minutes
app.post('/api/schedules/:id/timer', (req, res) => {
  try {
    const { minutes } = req.body;
    const mins = Number(minutes);
    if (!mins || mins < 1 || mins > 1440) return res.status(400).json({ error: 'minutes must be 1–1440' });

    const schedules = loadSchedules();
    const schedule = schedules.find(s => s.id === req.params.id);
    if (!schedule) return res.status(404).json({ error: 'Schedule not found' });

    // Cancel existing timer for this schedule if any
    if (_scheduleTimers.has(schedule.id)) {
      clearTimeout(_scheduleTimers.get(schedule.id).timeoutId);
      _scheduleTimers.delete(schedule.id);
    }

    const firesAt = new Date(Date.now() + mins * 60_000).toISOString();
    const timeoutId = setTimeout(() => {
      console.log(`[schedule] Timer fired for "${schedule.name}" after ${mins}m`);
      _scheduleTimers.delete(schedule.id);
      // Re-read schedule in case it was updated/deleted since timer was set
      const current = loadSchedules().find(s => s.id === schedule.id);
      if (current) {
        _scheduleQueue.push(current);
        processScheduleQueue();
      }
      broadcastSync({ type: 'schedule:timer-fired', scheduleId: schedule.id, scheduleName: schedule.name });
    }, mins * 60_000);

    _scheduleTimers.set(schedule.id, { timeoutId, firesAt, minutes: mins });
    console.log(`[schedule] Timer set: "${schedule.name}" fires in ${mins}m at ${firesAt}`);
    broadcastSync({ type: 'schedule:timer-set', scheduleId: schedule.id, scheduleName: schedule.name, firesAt, minutes: mins });
    res.json({ ok: true, firesAt, minutes: mins });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/schedules/:id/timer — cancel a pending timer
app.delete('/api/schedules/:id/timer', (req, res) => {
  const timer = _scheduleTimers.get(req.params.id);
  if (!timer) return res.status(404).json({ error: 'No active timer for this schedule' });
  clearTimeout(timer.timeoutId);
  _scheduleTimers.delete(req.params.id);
  console.log(`[schedule] Timer cancelled for schedule ${req.params.id}`);
  broadcastSync({ type: 'schedule:timer-cancelled', scheduleId: req.params.id });
  res.json({ ok: true });
});


// ═══════════════════════════════════════════════════════════════
// ISOLATED AGENTS — spawn Claude Code as fully isolated child processes
// Uses --print --output-format stream-json for clean JSON streaming.
// Supports both fully isolated mode and SynaBun-integrated mode.
// Loop mode: fresh process per iteration (anti-brain-rot).
// ═══════════════════════════════════════════════════════════════

const agentRegistry = new Map(); // agentId → agent object
const AGENT_IS_WIN = process.platform === 'win32';

/**
 * Build the MCP config JSON for an agent.
 * - withSynabun=false → empty config (fully isolated)
 * - withSynabun=true  → includes SynaBun MCP with optional browser session pinning
 */
function buildAgentMcpConfig(withSynabun, browserSessionId) {
  if (!withSynabun) return '{"mcpServers":{}}';
  const mcpPreload = resolve(PROJECT_ROOT, 'mcp-server', 'dist', 'preload.js');
  const dotenvPath = resolve(PROJECT_ROOT, '.env');
  const env = { DOTENV_PATH: dotenvPath };
  if (browserSessionId) env.SYNABUN_BROWSER_SESSION = browserSessionId;
  return JSON.stringify({
    mcpServers: {
      SynaBun: { type: 'stdio', command: 'node', args: [mcpPreload], env },
    },
  });
}

/**
 * Spawn a single Claude Code agent process.
 * Returns a Promise that resolves when the process exits.
 * The agent object is updated in-place with output, status, etc.
 */
function spawnAgentProcess(agent, prompt, extraEnv = {}) {
  return new Promise((resolve) => {
    const claudeBin = getClaudeBin();
    // Reuse the agent's persistent session-id for conversation continuity.
    // The controller rotates agent._activeSessionId every N iterations to avoid context overflow.
    const sessionId = agent._activeSessionId || agent.sessionId;

    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--session-id', sessionId,
      '--strict-mcp-config',
      '--mcp-config', agent._mcpConfig,
      '--permission-mode', 'bypassPermissions',
    ];
    // Resume the session when continuing an existing conversation (not the first use of this session-id)
    if (agent._resumableSessionId === sessionId) {
      args.push('--resume');
    }
    agent._resumableSessionId = sessionId; // Mark this session-id as resumable for next iteration

    if (agent.model && agent.model !== 'default') args.push('--model', agent.model);
    if (agent._maxTurns) args.push('--max-turns', String(agent._maxTurns));
    if (agent._systemPrompt) args.push('--system-prompt', agent._systemPrompt);
    if (agent._allowedTools?.length) args.push('--allowedTools', ...agent._allowedTools);
    if (agent._addDirs?.length) {
      for (const dir of agent._addDirs) args.push('--add-dir', dir);
    }
    args.push('-p', prompt);

    const cleanEnv = Object.fromEntries(
      Object.entries(process.env).filter(([k]) =>
        !k.startsWith('VSCODE_') && k !== 'TERM_PROGRAM' && k !== 'TERM_PROGRAM_VERSION'
      )
    );

    console.log(`[agent] ${agent.id} spawn: ${claudeBin} ${args.map(a => a.length > 80 ? a.slice(0, 80) + '…' : a).join(' ')}`);

    const child = spawn(claudeBin, args, {
      cwd: agent.cwd,
      env: { ...cleanEnv, FORCE_COLOR: '0', NO_COLOR: '1', TERM: 'dumb', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: AGENT_IS_WIN,
      windowsHide: true,
    });

    agent.process = child;
    agent._lineBuffer = '';
    let stderrBuf = '';

    child.stdout.on('data', (chunk) => {
      agent._lineBuffer += chunk.toString();
      const lines = agent._lineBuffer.split('\n');
      agent._lineBuffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          agent.output.push(event);
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text') agent.textOutput += block.text;
              else if (block.type === 'tool_use') {
                agent.toolUses.push({
                  tool: block.name,
                  input: typeof block.input === 'string' ? block.input.slice(0, 200) : JSON.stringify(block.input).slice(0, 200),
                });
                console.log(`[agent] ${agent.id} tool_use: ${block.name}`);
              }
            }
          }
          if (event.type === 'result') {
            if (event.cost_usd != null) agent.costUsd = (agent.costUsd || 0) + event.cost_usd;
            if (event.total_cost_usd != null) agent.costUsd = event.total_cost_usd;
          }
          broadcastSync({ type: 'agent:output', agentId: agent.id, event });
        } catch { /* partial JSON */ }
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrBuf += text;
      if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-4096);
      // Log MCP and error lines in real-time for diagnostics
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (t && (t.includes('error') || t.includes('Error') || t.includes('MCP') || t.includes('mcp') || t.includes('ENOENT') || t.includes('refused'))) {
          console.warn(`[agent] ${agent.id} stderr: ${t.slice(0, 200)}`);
        }
      }
    });

    child.on('error', (err) => {
      console.error(`[agent] ${agent.id} spawn error:`, err.message);
      resolve({ code: -1, error: err.message });
    });

    child.on('close', (code) => {
      if (agent._lineBuffer.trim()) {
        try {
          const event = JSON.parse(agent._lineBuffer);
          agent.output.push(event);
          if (event.type === 'result') {
            if (event.cost_usd != null) agent.costUsd = (agent.costUsd || 0) + event.cost_usd;
            if (event.total_cost_usd != null) agent.costUsd = event.total_cost_usd;
          }
        } catch {}
      }
      agent._lineBuffer = '';
      if (stderrBuf.trim()) {
        console.log(`[agent] ${agent.id} stderr dump (exit ${code}):\n${stderrBuf.trim().slice(-1000)}`);
      }
      console.log(`[agent] ${agent.id} close: code=${code}, tools=${agent.toolUses.length}, textLen=${agent.textOutput.length}`);
      resolve({ code, error: code !== 0 ? (stderrBuf.trim().slice(-500) || `Exit code ${code}`) : null });
    });
  });
}

/**
 * Launch an agent. Supports two modes:
 * - single: one-shot task (spawn once)
 * - loop: iterating task (spawn per iteration, inject progress)
 */
async function launchAgentController(opts) {
  const {
    task, model, cwd, allowedTools, addDirs, systemPrompt, maxTurns,
    withSynabun = false, browserSessionId = null,
    mode = 'single', iterations = 1, maxMinutes = 30, context = null,
  } = opts;

  const agentId = randomUUID();
  const mcpConfig = buildAgentMcpConfig(withSynabun, browserSessionId);
  const agentCwd = cwd || PROJECT_ROOT;

  // Build default system prompt for agents — overrides CLAUDE.md boot sequence
  // so the agent goes straight to the task instead of greeting/recalling
  const defaultAgentPrompt = withSynabun
    ? [
        'You are an autonomous agent executing a task. CRITICAL RULES:',
        '',
        '## Boot',
        '1. SKIP all CLAUDE.md boot sequences — no greeting, no recall, no communication style lookup. Go straight to the task.',
        '2. DO NOT output pleasantries, status summaries, or explanatory text. Execute using tools immediately.',
        '',
        '## Tools',
        '3. Your SynaBun MCP tools are deferred. On your FIRST response, batch-fetch ALL schemas in ONE ToolSearch call:',
        '   ToolSearch("select:browser_navigate,browser_click,browser_type,browser_fill,browser_snapshot,browser_scroll,browser_screenshot,browser_press,browser_select,browser_hover,browser_evaluate,browser_wait,browser_content,browser_extract_tweets,browser_extract_ig_feed,browser_extract_ig_profile,browser_extract_ig_post,browser_extract_ig_reels,browser_extract_ig_search,browser_extract_li_feed,browser_extract_li_profile,browser_extract_li_post,browser_extract_tiktok_videos,browser_extract_tiktok_search,browser_extract_tiktok_profile,browser_extract_fb_posts,browser_go_back,browser_go_forward,browser_reload,browser_session,browser_upload,remember,recall,reflect,forget,restore,memories,category,sync")',
        '   Then IMMEDIATELY call your first actual tool in the SAME response. A text-only response terminates the session.',
        '4. EVERY response MUST contain at least one tool_use call. Text-only responses terminate --print mode and waste the iteration.',
        '5. Chain multiple tool calls in a single response when they are independent (e.g., ToolSearch + browser_navigate).',
        '',
        '## Focus',
        '6. Stay laser-focused on the task. Do not drift into unrelated actions.',
        '7. Be autonomous. Do not ask for confirmation. Do not wait. Execute the full task using all available turns.',
        '8. If a tool call fails, try an alternative approach immediately. Do not output explanatory text without a tool call.',
        '9. If the browser shows a login wall, CAPTCHA, or 2FA — STOP and output the blocker in your handoff. Do not try to bypass it.',
        '',
        '## Iteration Handoff',
        '10. At the END of each iteration (when you have exhausted your task or turns), output a structured handoff:',
        '   ## Handoff',
        '   - Done: [concrete accomplishments this iteration]',
        '   - Next: [specific next steps for the following iteration]',
        '   - State: [current browser URL, login status, any critical state]',
        '   This handoff is injected into the next iteration for continuity. Be specific and actionable.',
        '',
        '## Memory',
        '11. SynaBun memory tools are available. Use them ONLY when the task prompt explicitly asks, or every 10 iterations when instructed.',
        '12. Do NOT call recall/remember/reflect unless directly relevant to the task. Memory operations waste turns.',
      ].join('\n')
    : null;

  const agent = {
    id: agentId,
    sessionId: randomUUID(),
    task,
    model: model || 'default',
    cwd: agentCwd,
    status: 'running',
    mode,
    process: null,
    output: [],
    textOutput: '',
    toolUses: [],
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    error: null,
    costUsd: null,
    // Loop state
    currentIteration: 0,
    totalIterations: iterations,
    maxMinutes,
    journal: [],
    browserSessionId: browserSessionId || null,
    withSynabun,
    // Internal
    _mcpConfig: mcpConfig,
    _maxTurns: maxTurns || 200,
    _systemPrompt: systemPrompt || defaultAgentPrompt,
    _allowedTools: allowedTools || null,
    _addDirs: addDirs || null,
    _lineBuffer: '',
    _stopped: false,
    _activeSessionId: null, // set per-iteration, rotated every SESSION_CONTINUITY_WINDOW iterations
    _iterOutputStart: 0, // tracks where each iteration's output starts in textOutput
    _iterToolStart: 0, // tracks where each iteration's tools start in toolUses
  };

  agentRegistry.set(agentId, agent);

  console.log(`[agent] Launching ${mode} agent ${agentId} (synabun=${withSynabun}, browser=${browserSessionId || 'none'})`);
  console.log(`[agent] Task: ${task.slice(0, 100)}${task.length > 100 ? '...' : ''}`);

  broadcastSync({
    type: 'agent:launched',
    agentId, task: agent.task, model: agent.model,
    cwd: agent.cwd, mode, iterations, browserSessionId,
    startedAt: agent.startedAt,
  });

  // Run in background — don't block the API response
  (async () => {
    for (let i = 1; i <= iterations; i++) {
      if (agent._stopped) break;

      agent.currentIteration = i;
      agent._iterOutputStart = agent.textOutput.length;
      agent._iterToolStart = agent.toolUses.length;

      // Fresh session EVERY iteration — prevents context bloat and compaction.
      // Each iteration gets a clean slate with full journal re-injection for continuity.
      // This is critical: --resume accumulates context which triggers compaction,
      // causing hangs and lost focus. Fresh sessions are predictable and fast.
      agent._activeSessionId = randomUUID();
      agent._resumableSessionId = null; // ensure --resume is never used
      if (i > 1) console.log(`[agent] ${agentId} fresh session for iteration ${i}`);

      broadcastSync({ type: 'agent:iteration', agentId, iteration: i, total: iterations });

      // Build iteration prompt — always inject full task + journal (fresh session each time)
      let prompt;
      if (mode === 'loop') {
        const parts = [];
        const elapsed = Math.floor((Date.now() - startTime) / 60000);
        const remaining = maxMinutes - elapsed;

        if (i === 1) {
          parts.push(task);
          if (context) parts.push(`\nContext: ${context}`);
        } else {
          // Every iteration after the first: re-inject full task + journal
          parts.push(`[Iteration ${i}/${iterations}] Continue the task:`);
          parts.push(task);
          if (context) parts.push(`Context: ${context}`);
          const recentJournal = agent.journal.slice(-10);
          if (recentJournal.length > 0) {
            parts.push('\n--- PREVIOUS ITERATIONS ---');
            for (const entry of recentJournal) {
              const fields = [];
              if (entry.done) fields.push(`Done: ${entry.done}`);
              if (entry.next) fields.push(`Next: ${entry.next}`);
              if (entry.state) fields.push(`State: ${entry.state}`);
              const detail = fields.length > 0 ? fields.join(' | ') : entry.summary;
              parts.push(`  Iteration ${entry.iteration}: ${detail}`);
            }
            parts.push('--- END PREVIOUS ---');
          }
        }

        parts.push(`\nIteration ${i}/${iterations}. ${remaining}min remaining. Execute this iteration now.`);
        // Memory enforcement every 10 iterations (if SynaBun enabled)
        if (withSynabun && i > 1 && i % 10 === 0) {
          parts.push('\nMANDATORY: Call `remember` to store your progress from the last 10 iterations before proceeding.');
        }
        prompt = parts.join('\n');
      } else {
        prompt = task;
      }

      console.log(`[agent] ${agentId} iteration ${i}/${iterations}`);

      // Retry logic: if the agent produces zero tool calls (wasted iteration in --print mode),
      // retry once with a more forceful prompt before advancing
      let result = await spawnAgentProcess(agent, prompt);
      const iterToolCount = agent.toolUses.length - agent._iterToolStart;

      if (mode === 'loop' && iterToolCount === 0 && result.code === 0 && !agent._stopped) {
        console.warn(`[agent] ${agentId} iteration ${i} produced 0 tool calls — retrying with forceful prompt`);
        agent._activeSessionId = randomUUID();
        agent._resumableSessionId = null;
        const retryPrompt = [
          `CRITICAL: Your previous attempt produced NO tool calls and was wasted.`,
          `You MUST call tools immediately. Do NOT output text without tool calls.`,
          `\n${prompt}`,
        ].join('\n');
        result = await spawnAgentProcess(agent, retryPrompt);
      }

      // Extract iteration summary for the journal.
      // Prefer structured ## Handoff block if the agent produced one; fall back to tail text.
      if (mode === 'loop') {
        const iterText = agent.textOutput.slice(agent._iterOutputStart);
        let summary = '';
        let done = '';
        let next = '';
        let state = '';

        // Try to parse structured handoff
        const handoffMatch = iterText.match(/## Handoff\s*\n([\s\S]*?)(?:\n##|\n---|\s*$)/i);
        if (handoffMatch) {
          const block = handoffMatch[1];
          done = (block.match(/[-*]\s*Done:\s*(.+)/i) || [])[1]?.trim() || '';
          next = (block.match(/[-*]\s*Next:\s*(.+)/i) || [])[1]?.trim() || '';
          state = (block.match(/[-*]\s*State:\s*(.+)/i) || [])[1]?.trim() || '';
          summary = [done && `Done: ${done}`, next && `Next: ${next}`].filter(Boolean).join(' | ');
        }

        // Fallback: last 300 chars of this iteration's output
        if (!summary) {
          summary = iterText.slice(-300).slice(0, 200).replace(/\n/g, ' ').trim() || 'Completed';
        }

        const journalEntry = { iteration: i, summary, timestamp: new Date().toISOString() };
        if (done) journalEntry.done = done;
        if (next) journalEntry.next = next;
        if (state) journalEntry.state = state;
        journalEntry.toolCount = agent.toolUses.length - (agent._iterToolStart || 0);

        agent.journal.push(journalEntry);
        // Keep journal bounded
        if (agent.journal.length > 30) agent.journal = agent.journal.slice(-20);

        broadcastSync({
          type: 'agent:iteration-complete', agentId, iteration: i,
          summary, done, next, state, toolCount: journalEntry.toolCount,
        });

        console.log(`[agent] ${agentId} iteration ${i} complete: ${journalEntry.toolCount} tools, exit=${result.code}`);
      }

      if (result.code !== 0 && !agent._stopped) {
        agent.error = result.error;
        if (mode !== 'loop') break;
        // For loops: log and continue — transient failures shouldn't kill the loop
        console.warn(`[agent] ${agentId} iteration ${i} exited with code ${result.code}, continuing...`);
        // Small delay before retry to let any transient issues settle
        await new Promise(r => setTimeout(r, 2000));
      }

      // Browser session health-check between loop iterations.
      // If the browser session died (closed by grace timer, crash, etc.), re-create it.
      if (mode === 'loop' && agent.browserSessionId && !agent._stopped && i < iterations) {
        if (!browserSessions.has(agent.browserSessionId)) {
          console.log(`[agent] ${agentId} browser session ${agent.browserSessionId} died, re-creating...`);
          try {
            const newBrowser = await createBrowserSession({ url: 'about:blank' });
            agent.browserSessionId = newBrowser.sessionId;
            agent._mcpConfig = buildAgentMcpConfig(agent.withSynabun, agent.browserSessionId);
            broadcastSync({
              type: 'browser:session-created',
              sessionId: agent.browserSessionId, url: 'about:blank',
              profileMode: newBrowser.profileMode, profileSource: newBrowser.profileSource,
            });
            console.log(`[agent] ${agentId} re-created browser session ${agent.browserSessionId}`);
          } catch (err) {
            console.warn(`[agent] ${agentId} browser re-create failed: ${err.message}`);
          }
        } else {
          // Cancel any grace timer on the session to keep it alive
          const bSession = browserSessions.get(agent.browserSessionId);
          if (bSession?.graceTimer) {
            clearTimeout(bSession.graceTimer);
            bSession.graceTimer = null;
          }
        }
      }

      // Small stabilization delay between iterations (let MCP server settle)
      if (mode === 'loop' && !agent._stopped && i < iterations) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    agent.endedAt = new Date().toISOString();
    agent.exitCode = agent._stopped ? null : 0;
    agent.status = agent._stopped ? 'stopped' : (agent.error && mode !== 'loop') ? 'failed' : 'completed';
    agent.process = null;

    console.log(`[agent] ${agentId} finished: status=${agent.status}, iterations=${agent.currentIteration}/${iterations}`);
    broadcastSync({ type: 'agent:status', agentId, status: agent.status, exitCode: agent.exitCode });
  })();

  return agent;
}

// POST /api/agents/launch — spawn a new agent (single or loop, isolated or with SynaBun)
app.post('/api/agents/launch', async (req, res) => {
  try {
    const {
      task, model, cwd, allowedTools, addDirs, systemPrompt, maxTurns,
      withSynabun, browserProfile,
      mode, iterations, maxMinutes, context,
    } = req.body;
    if (!task?.trim()) return res.status(400).json({ error: 'task is required' });

    // Pre-create a dedicated browser session when SynaBun is enabled
    // (agent needs browser tools via MCP — create one proactively so browser_navigate reuses it)
    let browserSessionId = null;
    if (withSynabun) {
      try {
        const result = await createBrowserSession({ url: 'about:blank' });
        browserSessionId = result.sessionId;
        broadcastSync({
          type: 'browser:session-created',
          sessionId: browserSessionId, url: 'about:blank',
          profileMode: result.profileMode, profileSource: result.profileSource,
        });
        console.log(`[agent] Pre-created browser session ${browserSessionId} for agent`);
      } catch (err) {
        console.warn(`[agent] Browser pre-create failed: ${err.message} — agent will auto-create on first browser_navigate`);
      }
    }

    // maxTurns: browser automation needs high headroom (navigate+snapshot+click+type per page).
    // Non-browser tasks need less. User-supplied value takes priority.
    const effectiveMaxTurns = maxTurns || (browserSessionId ? 200 : 100);

    const agent = await launchAgentController({
      task: task.trim(), model, cwd, allowedTools, addDirs, systemPrompt,
      maxTurns: effectiveMaxTurns,
      withSynabun: !!withSynabun,
      browserSessionId,
      mode: mode || 'single',
      iterations: Math.min(Math.max(iterations || 1, 1), 200),
      maxMinutes: Math.min(Math.max(maxMinutes || 30, 1), 480),
      context: context || null,
    });

    res.json({
      ok: true,
      agentId: agent.id,
      sessionId: agent.sessionId,
      status: agent.status,
      browserSessionId,
      mode: agent.mode,
    });
  } catch (err) {
    console.error('POST /api/agents/launch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/agents — list all agents (active + recent)
app.get('/api/agents', (req, res) => {
  const agents = [];
  for (const [id, agent] of agentRegistry) {
    agents.push({
      id,
      task: agent.task,
      model: agent.model,
      cwd: agent.cwd,
      status: agent.status,
      mode: agent.mode,
      currentIteration: agent.currentIteration,
      totalIterations: agent.totalIterations,
      startedAt: agent.startedAt,
      endedAt: agent.endedAt,
      exitCode: agent.exitCode,
      error: agent.error,
      costUsd: agent.costUsd,
      textLength: agent.textOutput.length,
      toolUseCount: agent.toolUses.length,
      eventCount: agent.output.length,
      browserSessionId: agent.browserSessionId,
      withSynabun: agent.withSynabun,
      journal: agent.journal,
      // Last 5 tool uses for live feed
      recentTools: agent.toolUses.slice(-5).map(t => t.tool),
    });
  }
  res.json({ agents });
});

// GET /api/agents/:id — get full agent details including output
app.get('/api/agents/:id', (req, res) => {
  const agent = agentRegistry.get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  res.json({
    id: agent.id,
    sessionId: agent.sessionId,
    task: agent.task,
    model: agent.model,
    cwd: agent.cwd,
    status: agent.status,
    mode: agent.mode,
    currentIteration: agent.currentIteration,
    totalIterations: agent.totalIterations,
    startedAt: agent.startedAt,
    endedAt: agent.endedAt,
    exitCode: agent.exitCode,
    error: agent.error,
    costUsd: agent.costUsd,
    textOutput: agent.textOutput,
    toolUses: agent.toolUses,
    journal: agent.journal,
    eventCount: agent.output.length,
    browserSessionId: agent.browserSessionId,
    withSynabun: agent.withSynabun,
  });
});

// POST /api/agents/:id/stop — kill a running agent
app.post('/api/agents/:id/stop', (req, res) => {
  const agent = agentRegistry.get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  if (agent.status !== 'running') return res.json({ ok: true, status: agent.status, message: 'Already finished' });

  agent._stopped = true;
  agent.status = 'stopped';
  try {
    if (agent.process) {
      if (AGENT_IS_WIN) {
        spawn('taskkill', ['/pid', String(agent.process.pid), '/T', '/F'], { shell: true, windowsHide: true });
      } else {
        try { process.kill(-agent.process.pid, 'SIGTERM'); } catch { agent.process.kill('SIGTERM'); }
      }
    }
  } catch (err) {
    console.warn(`[agent] ${agent.id} kill error:`, err.message);
  }
  res.json({ ok: true, status: 'stopped' });
});

// DELETE /api/agents/:id — remove agent from registry
app.delete('/api/agents/:id', (req, res) => {
  const agent = agentRegistry.get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  if (agent.status === 'running') {
    agent._stopped = true;
    agent.status = 'stopped';
    try { if (agent.process) agent.process.kill('SIGTERM'); } catch {}
  }

  agentRegistry.delete(req.params.id);
  broadcastSync({ type: 'agent:removed', agentId: req.params.id });
  res.json({ ok: true });
});

// POST /api/search/memories — category-filtered semantic search
app.post('/api/search/memories', async (req, res) => {
  try {
    const { query, category, limit = 15 } = req.body;
    if (!query) return res.status(400).json({ error: 'query required' });

    const embedding = await getEmbedding(query);
    const results = dbSearchMemories(embedding, Math.min(limit, 50), { category, scoreThreshold: 0.3 });

    res.json({
      results: results.map(r => ({
        id: r.id,
        score: r.score,
        payload: { content: r.content, category: r.category, subcategory: r.subcategory, project: r.project, tags: r.tags, importance: r.importance, source: r.source, created_at: r.created_at, updated_at: r.updated_at, accessed_at: r.accessed_at, access_count: r.access_count, related_files: r.related_files, related_memory_ids: r.related_memory_ids, trashed_at: r.trashed_at },
      })),
      query,
      category,
    });
  } catch (err) {
    console.error('POST /api/search/memories error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════
// FULL SYSTEM BACKUP & RESTORE
// ═══════════════════════════════════════════

// GET /api/system/backup — Download full system backup as ZIP
app.get('/api/system/backup', async (req, res) => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const prefix = `synabun-backup-${timestamp}`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${prefix}.zip"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => {
      console.error('Backup archive error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    });
    archive.pipe(res);

    const manifest = {
      version: 2,
      created: new Date().toISOString(),
      hostname: os.hostname(),
      storage: 'sqlite',
      database: null,
      files: [],
      checksums: {},
    };

    // Helper: add a file to archive + manifest
    const addFile = (archivePath, diskPath) => {
      if (existsSync(diskPath)) {
        const content = readFileSync(diskPath);
        archive.append(content, { name: `${prefix}/${archivePath}` });
        manifest.files.push(archivePath);
        manifest.checksums[archivePath] = 'sha256:' + createHash('sha256').update(content).digest('hex');
      }
    };

    // Helper: add all JSON files from a directory
    const addJsonDir = (archiveDir, diskDir) => {
      if (existsSync(diskDir)) {
        for (const f of readdirSync(diskDir)) {
          if (f.endsWith('.json')) {
            addFile(`${archiveDir}/${f}`, resolve(diskDir, f));
          }
        }
      }
    };

    // Helper: recursively add an entire directory tree
    const addDirRecursive = (archiveDir, diskDir) => {
      if (!existsSync(diskDir)) return;
      for (const entry of readdirSync(diskDir, { withFileTypes: true })) {
        const diskPath = join(diskDir, entry.name);
        const archivePath = `${archiveDir}/${entry.name}`;
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          try {
            const stat = statSync(diskPath);
            if (stat.isDirectory()) {
              addDirRecursive(archivePath, diskPath);
              continue;
            }
          } catch { continue; }
        }
        if (entry.isFile()) {
          addFile(archivePath, diskPath);
        }
      }
    };

    // 1. .env
    addFile('env.bak', ENV_PATH);

    // 2. data/ directory
    const dataDir = resolve(PROJECT_ROOT, 'data');
    for (const f of ['ui-state.json', 'greeting-config.json', 'hook-features.json',
                      'claude-code-projects.json', 'mcp-api-key.json', 'keybinds.json', 'cli-config.json',
                      'invite-key.json', 'invite-proxy.json', 'invite-permissions.json',
                      'loop-templates.json', 'loop-schedules.json', 'auto-backup-config.json']) {
      addFile(`data/${f}`, resolve(dataDir, f));
    }
    addJsonDir('data/pending-remember', resolve(dataDir, 'pending-remember'));
    addJsonDir('data/pending-compact', resolve(dataDir, 'pending-compact'));
    addJsonDir('data/loop', resolve(dataDir, 'loop'));

    // Custom file icons
    addFile('data/custom-icons.json', resolve(dataDir, 'custom-icons.json'));
    addDirRecursive('data/custom-icons', resolve(dataDir, 'custom-icons'));

    // 3. mcp-server/data/
    if (existsSync(CATEGORIES_DATA_DIR)) {
      for (const f of readdirSync(CATEGORIES_DATA_DIR)) {
        if (f.endsWith('.json')) {
          addFile(`mcp-data/${f}`, resolve(CATEGORIES_DATA_DIR, f));
        }
      }
    }

    // 4. Global skills (~/.claude/skills/) — full directory tree per skill
    const globalSkillsDir = getGlobalSkillsDir();
    if (existsSync(globalSkillsDir)) {
      for (const entry of readdirSync(globalSkillsDir, { withFileTypes: true })) {
        if (!isDirEntry(entry)) continue;
        const skillDir = join(globalSkillsDir, entry.name);
        addDirRecursive(`global-skills/${entry.name}`, skillDir);
      }
    }

    // 5. Global agents (~/.claude/agents/) — flat .md files
    const globalAgentsDir = getGlobalAgentsDir();
    if (existsSync(globalAgentsDir)) {
      for (const entry of readdirSync(globalAgentsDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        addFile(`global-agents/${entry.name}`, join(globalAgentsDir, entry.name));
      }
    }

    // 6. Bundled SynaBun skills (PROJECT_ROOT/skills/) — full directory tree
    if (existsSync(SKILLS_SOURCE_DIR)) {
      for (const entry of readdirSync(SKILLS_SOURCE_DIR, { withFileTypes: true })) {
        if (!isDirEntry(entry)) continue;
        const skillDir = join(SKILLS_SOURCE_DIR, entry.name);
        addDirRecursive(`bundled-skills/${entry.name}`, skillDir);
      }
    }

    // 7. SQLite database file
    const dbPath = getDbPath();
    if (existsSync(dbPath)) {
      try {
        const dbContent = readFileSync(dbPath);
        archive.append(dbContent, { name: `${prefix}/database/memory.db` });
        manifest.database = {
          file: 'database/memory.db',
          sizeBytes: dbContent.length,
          memoryCount: countMemories(),
        };
      } catch (err) {
        console.warn(`  Backup: failed to include database: ${err.message}`);
      }
    }

    // 8. Write manifest last (references all files)
    archive.append(JSON.stringify(manifest, null, 2), { name: `${prefix}/manifest.json` });

    await archive.finalize();
  } catch (err) {
    console.error('GET /api/system/backup error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// POST /api/system/restore/preview — Read manifest from uploaded ZIP without applying
app.post('/api/system/restore/preview',
  express.raw({ type: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'], limit: '1gb' }),
  async (req, res) => {
  try {
    if (!req.body || req.body.length === 0) {
      return res.status(400).json({ error: 'No data received' });
    }
    const zip = new AdmZip(req.body);
    const manifestEntry = zip.getEntries().find(e => e.entryName.endsWith('/manifest.json'));
    if (!manifestEntry) {
      return res.status(400).json({ error: 'Invalid backup: manifest.json not found' });
    }
    const manifest = JSON.parse(manifestEntry.getData().toString('utf-8'));
    res.json({ ok: true, manifest });
  } catch (err) {
    console.error('POST /api/system/restore/preview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/system/restore — Apply a full system backup from uploaded ZIP
app.post('/api/system/restore',
  express.raw({ type: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'], limit: '1gb' }),
  async (req, res) => {
  try {
    if (!req.body || req.body.length === 0) {
      return res.status(400).json({ error: 'No backup data received' });
    }

    const mode = req.query.mode || 'full';

    const zip = new AdmZip(req.body);
    const entries = zip.getEntries();

    // Find and validate manifest
    const manifestEntry = entries.find(e => e.entryName.endsWith('/manifest.json'));
    if (!manifestEntry) {
      return res.status(400).json({ error: 'Invalid backup: manifest.json not found' });
    }
    const manifest = JSON.parse(manifestEntry.getData().toString('utf-8'));
    if (manifest.version !== 1 && manifest.version !== 2) {
      return res.status(400).json({ error: `Unsupported backup version: ${manifest.version}` });
    }

    const prefix = manifestEntry.entryName.replace('/manifest.json', '');
    const results = { files: [], snapshots: [], errors: [] };

    // Restore config files
    if (mode === 'full' || mode === 'config-only') {
      // .env
      const envEntry = entries.find(e => e.entryName === `${prefix}/env.bak`);
      if (envEntry) {
        writeFileSync(ENV_PATH, envEntry.getData());
        results.files.push('.env');
      }

      // data/ files
      const dataDir = resolve(PROJECT_ROOT, 'data');
      mkdirSync(dataDir, { recursive: true });
      for (const subdir of ['pending-remember', 'pending-compact', 'loop']) {
        mkdirSync(resolve(dataDir, subdir), { recursive: true });
      }

      // mcp-server/data/
      mkdirSync(CATEGORIES_DATA_DIR, { recursive: true });

      for (const entry of entries) {
        if (entry.isDirectory) continue;
        const rel = entry.entryName.replace(`${prefix}/`, '');

        if (rel.startsWith('data/') && rel !== 'data/') {
          const target = resolve(PROJECT_ROOT, rel);
          const dir = dirname(target);
          mkdirSync(dir, { recursive: true });
          writeFileSync(target, entry.getData());
          results.files.push(rel);
        }

        if (rel.startsWith('mcp-data/') && rel !== 'mcp-data/') {
          const filename = rel.replace('mcp-data/', '');
          writeFileSync(resolve(CATEGORIES_DATA_DIR, filename), entry.getData());
          results.files.push(rel);
        }

        // Global skills → ~/.claude/skills/
        if (rel.startsWith('global-skills/') && rel !== 'global-skills/') {
          const subPath = rel.replace('global-skills/', '');
          const target = join(getGlobalSkillsDir(), subPath);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, entry.getData());
          results.files.push(rel);
        }

        // Global agents → ~/.claude/agents/
        if (rel.startsWith('global-agents/') && rel !== 'global-agents/') {
          const subPath = rel.replace('global-agents/', '');
          const target = join(getGlobalAgentsDir(), subPath);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, entry.getData());
          results.files.push(rel);
        }

        // Bundled SynaBun skills → PROJECT_ROOT/skills/
        if (rel.startsWith('bundled-skills/') && rel !== 'bundled-skills/') {
          const subPath = rel.replace('bundled-skills/', '');
          const target = resolve(SKILLS_SOURCE_DIR, subPath);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, entry.getData());
          results.files.push(rel);
        }
      }
    }

    // Normalize SQLITE_DB_PATH from restored .env to local default
    // (backup may contain paths from a different OS, e.g. J:\Sites\... from Windows)
    if (mode === 'full' || mode === 'config-only') {
      const localDefaultDbPath = resolve(CATEGORIES_DATA_DIR, 'memory.db');
      const vars = parseEnvFile(ENV_PATH);
      const restoredPath = vars['SQLITE_DB_PATH'] || '';
      // If the restored path doesn't exist on this OS, reset to local default
      if (restoredPath && !existsSync(dirname(restoredPath))) {
        vars['SQLITE_DB_PATH'] = localDefaultDbPath;
        writeEnvFile(ENV_PATH, vars);
        process.env['SQLITE_DB_PATH'] = localDefaultDbPath;
        results.files.push('(normalized SQLITE_DB_PATH to local default)');
      }
      reloadConfig();
    }

    // Restore SQLite database
    if (mode === 'full' || mode === 'snapshots-only') {
      const dbEntry = entries.find(e => e.entryName === `${prefix}/database/memory.db`);
      if (dbEntry) {
        try {
          // Close existing database connection before replacing
          closeDb();
          // Always restore to local default path, ignoring any cross-OS path from .env
          const dbPath = resolve(CATEGORIES_DATA_DIR, 'memory.db');
          // Update .env and runtime to point here
          const vars = parseEnvFile(ENV_PATH);
          vars['SQLITE_DB_PATH'] = dbPath;
          writeEnvFile(ENV_PATH, vars);
          process.env['SQLITE_DB_PATH'] = dbPath;
          const dbDir = dirname(dbPath);
          mkdirSync(dbDir, { recursive: true });
          writeFileSync(dbPath, dbEntry.getData());
          // Remove WAL/SHM files if they exist
          try { if (existsSync(dbPath + '-wal')) unlinkSync(dbPath + '-wal'); } catch {}
          try { if (existsSync(dbPath + '-shm')) unlinkSync(dbPath + '-shm'); } catch {}
          results.files.push('database/memory.db');
        } catch (err) {
          results.errors.push(`Failed to restore database: ${err.message}`);
        }
      } else if (manifest.connections && Object.keys(manifest.connections).length > 0) {
        // Old Qdrant-format backup detected
        results.errors.push('This backup contains Qdrant snapshots (old format). Run the migration script to convert to SQLite first.');
      }
    }

    res.json({ ok: true, message: 'Backup restored successfully', results });
  } catch (err) {
    console.error('POST /api/system/restore error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════
// AUTO-BACKUP SYSTEM
// ═══════════════════════════════════════════

const AUTO_BACKUP_CONFIG_PATH = resolve(PROJECT_ROOT, 'data', 'auto-backup-config.json');

function loadAutoBackupConfig() {
  try {
    if (existsSync(AUTO_BACKUP_CONFIG_PATH)) return JSON.parse(readFileSync(AUTO_BACKUP_CONFIG_PATH, 'utf-8'));
  } catch {}
  return { enabled: false, intervalMinutes: 360, folderPath: '', lastBackup: null, lastBackupSize: 0, lastBackupError: null };
}

function saveAutoBackupConfig(cfg) {
  writeFileSync(AUTO_BACKUP_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
}

let _autoBackupTimer = null;

function buildBackupZipToFile(destPath) {
  return new Promise((resolveP, rejectP) => {
    const output = createWriteStream(destPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', () => resolveP(archive.pointer()));
    archive.on('error', (err) => rejectP(err));
    output.on('error', (err) => rejectP(err));
    archive.pipe(output);

    const prefix = 'synabun-auto-backup';

    const manifest = {
      version: 2,
      created: new Date().toISOString(),
      hostname: os.hostname(),
      storage: 'sqlite',
      database: null,
      files: [],
      checksums: {},
      autoBackup: true,
    };

    const addFile = (archivePath, diskPath) => {
      if (existsSync(diskPath)) {
        const content = readFileSync(diskPath);
        archive.append(content, { name: `${prefix}/${archivePath}` });
        manifest.files.push(archivePath);
        manifest.checksums[archivePath] = 'sha256:' + createHash('sha256').update(content).digest('hex');
      }
    };

    const addJsonDir = (archiveDir, diskDir) => {
      if (existsSync(diskDir)) {
        for (const f of readdirSync(diskDir)) {
          if (f.endsWith('.json')) addFile(`${archiveDir}/${f}`, resolve(diskDir, f));
        }
      }
    };

    const addDirRecursive = (archiveDir, diskDir) => {
      if (!existsSync(diskDir)) return;
      for (const entry of readdirSync(diskDir, { withFileTypes: true })) {
        const diskPath = join(diskDir, entry.name);
        const archivePath = `${archiveDir}/${entry.name}`;
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          try { if (statSync(diskPath).isDirectory()) { addDirRecursive(archivePath, diskPath); continue; } } catch { continue; }
        }
        if (entry.isFile()) addFile(archivePath, diskPath);
      }
    };

    // Same content as manual backup
    addFile('env.bak', ENV_PATH);

    const dataDir = resolve(PROJECT_ROOT, 'data');
    for (const f of ['ui-state.json', 'greeting-config.json', 'hook-features.json',
                      'claude-code-projects.json', 'mcp-api-key.json', 'keybinds.json', 'cli-config.json',
                      'invite-key.json', 'invite-proxy.json', 'invite-permissions.json',
                      'loop-templates.json', 'loop-schedules.json']) {
      addFile(`data/${f}`, resolve(dataDir, f));
    }
    addJsonDir('data/pending-remember', resolve(dataDir, 'pending-remember'));
    addJsonDir('data/pending-compact', resolve(dataDir, 'pending-compact'));
    addJsonDir('data/loop', resolve(dataDir, 'loop'));
    addFile('data/custom-icons.json', resolve(dataDir, 'custom-icons.json'));
    addDirRecursive('data/custom-icons', resolve(dataDir, 'custom-icons'));

    if (existsSync(CATEGORIES_DATA_DIR)) {
      for (const f of readdirSync(CATEGORIES_DATA_DIR)) {
        if (f.endsWith('.json')) addFile(`mcp-data/${f}`, resolve(CATEGORIES_DATA_DIR, f));
      }
    }

    const globalSkillsDir = getGlobalSkillsDir();
    if (existsSync(globalSkillsDir)) {
      for (const entry of readdirSync(globalSkillsDir, { withFileTypes: true })) {
        if (!isDirEntry(entry)) continue;
        addDirRecursive(`global-skills/${entry.name}`, join(globalSkillsDir, entry.name));
      }
    }

    const globalAgentsDir = getGlobalAgentsDir();
    if (existsSync(globalAgentsDir)) {
      for (const entry of readdirSync(globalAgentsDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        addFile(`global-agents/${entry.name}`, join(globalAgentsDir, entry.name));
      }
    }

    if (existsSync(SKILLS_SOURCE_DIR)) {
      for (const entry of readdirSync(SKILLS_SOURCE_DIR, { withFileTypes: true })) {
        if (!isDirEntry(entry)) continue;
        addDirRecursive(`bundled-skills/${entry.name}`, join(SKILLS_SOURCE_DIR, entry.name));
      }
    }

    const dbPath = getDbPath();
    if (existsSync(dbPath)) {
      try {
        const dbContent = readFileSync(dbPath);
        archive.append(dbContent, { name: `${prefix}/database/memory.db` });
        manifest.database = { file: 'database/memory.db', sizeBytes: dbContent.length, memoryCount: countMemories() };
      } catch (err) {
        console.warn(`  Auto-backup: failed to include database: ${err.message}`);
      }
    }

    archive.append(JSON.stringify(manifest, null, 2), { name: `${prefix}/manifest.json` });
    archive.finalize();
  });
}

async function runAutoBackup() {
  const cfg = loadAutoBackupConfig();
  if (!cfg.enabled || !cfg.folderPath) return;

  try {
    if (!existsSync(cfg.folderPath)) mkdirSync(cfg.folderPath, { recursive: true });

    const destPath = resolve(cfg.folderPath, 'synabun-auto-backup.zip');
    const tmpPath = destPath + '.tmp';

    const sizeBytes = await buildBackupZipToFile(tmpPath);

    // Atomic replace: rename tmp over final
    renameSync(tmpPath, destPath);

    cfg.lastBackup = new Date().toISOString();
    cfg.lastBackupSize = sizeBytes;
    cfg.lastBackupError = null;
    saveAutoBackupConfig(cfg);
    console.log(`[auto-backup] Saved ${(sizeBytes / 1024 / 1024).toFixed(1)} MB → ${destPath}`);
  } catch (err) {
    cfg.lastBackupError = err.message;
    cfg.lastBackup = new Date().toISOString();
    saveAutoBackupConfig(cfg);
    console.error(`[auto-backup] Failed: ${err.message}`);
    // Clean up tmp if it exists
    try { const tmpPath = resolve(cfg.folderPath, 'synabun-auto-backup.zip.tmp'); if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch {}
  }
}

function startAutoBackupScheduler() {
  stopAutoBackupScheduler();
  const cfg = loadAutoBackupConfig();
  if (!cfg.enabled || !cfg.folderPath || !cfg.intervalMinutes) return;

  const ms = cfg.intervalMinutes * 60 * 1000;
  _autoBackupTimer = setInterval(() => runAutoBackup(), ms);
  console.log(`[auto-backup] Scheduler started: every ${cfg.intervalMinutes}min → ${cfg.folderPath}`);
}

function stopAutoBackupScheduler() {
  if (_autoBackupTimer) {
    clearInterval(_autoBackupTimer);
    _autoBackupTimer = null;
  }
}

// Boot: start scheduler if enabled
startAutoBackupScheduler();

// GET /api/system/auto-backup — Get auto-backup config
app.get('/api/system/auto-backup', (req, res) => {
  res.json(loadAutoBackupConfig());
});

// PUT /api/system/auto-backup — Update auto-backup config
app.put('/api/system/auto-backup', (req, res) => {
  try {
    const current = loadAutoBackupConfig();
    const { enabled, intervalMinutes, folderPath } = req.body;

    if (typeof enabled === 'boolean') current.enabled = enabled;
    if (typeof intervalMinutes === 'number' && intervalMinutes >= 1) current.intervalMinutes = intervalMinutes;
    if (typeof folderPath === 'string') current.folderPath = folderPath.trim();

    saveAutoBackupConfig(current);

    // Restart scheduler with new config
    if (current.enabled && current.folderPath) {
      startAutoBackupScheduler();
    } else {
      stopAutoBackupScheduler();
    }

    res.json({ ok: true, config: current });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/system/auto-backup/trigger — Run auto-backup now
app.post('/api/system/auto-backup/trigger', async (req, res) => {
  try {
    const cfg = loadAutoBackupConfig();
    if (!cfg.folderPath) return res.status(400).json({ error: 'No backup folder configured' });
    await runAutoBackup();
    res.json(loadAutoBackupConfig());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projects — List registered projects for file explorer selector
app.get('/api/projects', (req, res) => {
  const projects = loadHookProjects();
  res.json({ ok: true, projects: projects.map(p => ({ path: p.path, label: p.label || basename(p.path) })) });
});

// ── Path validation helper (reused by project-files, file-content) ──
function validateProjectPath(filePath) {
  const normalized = resolve(filePath);
  const registeredProjects = loadHookProjects();
  const allowedRoots = [resolve(PROJECT_ROOT), ...registeredProjects.map(p => resolve(p.path))];
  const matched = allowedRoots.find(r => normalized === r || normalized.startsWith(r + sep));
  return matched ? normalized : null;
}

// GET /api/file-content — Read a single file for inline editing
app.get('/api/file-content', (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'Missing path parameter' });

    const normalized = validateProjectPath(filePath);
    if (!normalized) return res.status(403).json({ error: 'Path outside registered project roots' });

    if (!existsSync(normalized) || !statSync(normalized).isFile()) {
      return res.status(400).json({ error: 'Not a valid file' });
    }

    const stat = statSync(normalized);
    if (stat.size > 1024 * 1024) {
      return res.status(413).json({ error: 'File too large' });
    }

    // Binary detection: read first 8KB and scan for null bytes
    const fd = openSync(normalized, 'r');
    const buf = Buffer.alloc(Math.min(8192, stat.size));
    const bytesRead = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0x00) {
        return res.status(415).json({ error: 'Binary file' });
      }
    }

    const content = readFileSync(normalized, 'utf-8');
    const name = basename(normalized);
    res.json({ ok: true, content, path: normalized.replace(/\\/g, '/'), name, size: stat.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/file-content — Write a file (existing, or create if `create: true`)
app.post('/api/file-content', (req, res) => {
  try {
    const { path: filePath, content, create } = req.body || {};
    if (!filePath || typeof content !== 'string') {
      return res.status(400).json({ error: 'Missing path or content' });
    }

    const normalized = validateProjectPath(filePath);
    if (!normalized) return res.status(403).json({ error: 'Path outside registered project roots' });

    if (create) {
      // Ensure parent dir exists
      const parentDir = dirname(normalized);
      if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
    } else {
      if (!existsSync(normalized) || !statSync(normalized).isFile()) {
        return res.status(400).json({ error: 'File does not exist' });
      }
    }

    writeFileSync(normalized, content, 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/file-mkdir — Create a directory
app.post('/api/file-mkdir', (req, res) => {
  try {
    const { path: dirPath } = req.body || {};
    if (!dirPath) return res.status(400).json({ error: 'Missing path' });

    const normalized = validateProjectPath(dirPath);
    if (!normalized) return res.status(403).json({ error: 'Path outside registered project roots' });

    mkdirSync(normalized, { recursive: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/file-content — Delete a file or empty directory
app.delete('/api/file-content', (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'Missing path parameter' });

    const normalized = validateProjectPath(filePath);
    if (!normalized) return res.status(403).json({ error: 'Path outside registered project roots' });

    if (!existsSync(normalized)) {
      return res.status(404).json({ error: 'Path does not exist' });
    }

    const stat = statSync(normalized);
    if (stat.isDirectory()) {
      const entries = readdirSync(normalized);
      if (entries.length > 0) return res.status(400).json({ error: 'Directory is not empty' });
      rmSync(normalized);
    } else {
      unlinkSync(normalized);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/project-files — List ALL files (incl. dotfiles) for file explorer sidebar
app.get('/api/project-files', (req, res) => {
  try {
    const root = PROJECT_ROOT;
    let dir = req.query.path ? resolve(req.query.path) : root;
    const search = (req.query.search || '').trim();

    // Security: allow paths within any registered project root
    const normalizedDir = resolve(dir);
    const registeredProjects = loadHookProjects();
    const allowedRoots = [resolve(root), ...registeredProjects.map(p => resolve(p.path))];
    const normalizedRoot = allowedRoots.find(r => normalizedDir === r || normalizedDir.startsWith(r + sep));
    if (!normalizedRoot) {
      return res.status(403).json({ error: 'Path outside registered project roots' });
    }
    if (!existsSync(normalizedDir) || !statSync(normalizedDir).isDirectory()) {
      return res.status(400).json({ error: 'Not a valid directory' });
    }

    // Git info for status badges
    const git = getGitInfo(normalizedDir);

    if (search && search.length > 2) {
      // Recursive search mode
      const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.next', 'dist', '.cache']);
      const MAX_RESULTS = 100;
      const results = [];
      const lowerSearch = search.toLowerCase();

      function walkSearch(d) {
        if (results.length >= MAX_RESULTS) return;
        let entries;
        try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (results.length >= MAX_RESULTS) break;
          if (SKIP.has(e.name)) continue;
          const full = join(d, e.name);
          if (e.name.toLowerCase().includes(lowerSearch)) {
            const rel = full.substring(normalizedRoot.length).replace(/\\/g, '/');
            const item = { name: e.name, type: e.isDirectory() ? 'dir' : 'file', path: rel };
            if (e.isFile()) {
              try {
                const s = statSync(full);
                item.size = s.size;
                item.mtime = s.mtimeMs;
              } catch {}
            }
            results.push(item);
          }
          if (e.isDirectory()) walkSearch(full);
        }
      }

      walkSearch(normalizedDir);
      return res.json({ path: normalizedDir.replace(/\\/g, '/'), items: results, search: true, branch: git?.branch || null });
    }

    // Normal directory listing
    const entries = readdirSync(normalizedDir, { withFileTypes: true });
    const items = [];
    for (const e of entries) {
      const full = join(normalizedDir, e.name);
      const item = { name: e.name, type: e.isDirectory() ? 'dir' : 'file' };
      if (e.isFile()) {
        try {
          const s = statSync(full);
          item.size = s.size;
          item.mtime = s.mtimeMs;
        } catch {}
      }
      if (git?.statuses?.has(e.name)) {
        item.git = git.statuses.get(e.name);
      }
      items.push(item);
    }

    // Sort: dirs first, then alphabetical
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    const parent = normalizedDir !== normalizedRoot
      ? resolve(normalizedDir, '..').replace(/\\/g, '/')
      : null;

    res.json({
      path: normalizedDir.replace(/\\/g, '/'),
      items,
      branch: git?.branch || null,
      parent
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/browse-directory — List directories at a given path for folder picker UI
app.get('/api/browse-directory', (req, res) => {
  try {
    let dir = req.query.path || '';
    // Default to common roots on Windows / Unix
    if (!dir) {
      const home = process.env.USERPROFILE || process.env.HOME || '/';
      dir = home;
    }
    dir = resolve(dir);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      return res.status(400).json({ error: 'Not a valid directory' });
    }
    const entries = readdirSync(dir, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    // Parent directory (unless at root)
    const parent = resolve(dir, '..');
    res.json({ ok: true, current: dir, parent: parent !== dir ? parent : null, directories: dirs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/browse-folder — Open native OS folder picker dialog
app.post('/api/browse-folder', (req, res) => {
  try {
    const { description } = req.body || {};
    const prompt = description || 'Select a folder';
    let cmd;
    if (process.platform === 'win32') {
      const escaped = prompt.replace(/'/g, "''");
      const pickerScript = resolve(__dirname, 'lib', 'folder-picker.ps1');
      cmd = `powershell -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "${pickerScript}" -Title "${escaped}"`;
    } else if (process.platform === 'darwin') {
      cmd = `osascript -e 'POSIX path of (choose folder with prompt "${prompt}")'`;
    } else {
      cmd = `zenity --file-selection --directory --title="${prompt}" 2>/dev/null`;
    }
    const result = execSync(cmd, { encoding: 'utf8', timeout: 60000, windowsHide: true }).trim();
    if (result) {
      res.json({ path: result.replace(/\\/g, '/') });
    } else {
      res.json({ path: null, cancelled: true });
    }
  } catch {
    res.json({ path: null, cancelled: true });
  }
});

// ═══════════════════════════════════════════
// BRIDGE ENDPOINTS
// ═══════════════════════════════════════════

// GET /api/bridges/openclaw — Status of the OpenClaw bridge
app.get('/api/bridges/openclaw', (req, res) => {
  const config = loadBridgeConfig('openclaw');
  if (!config?.enabled) {
    return res.json({ ok: true, enabled: false });
  }
  res.json({
    ok: true,
    enabled: true,
    workspacePath: config.workspacePath,
    lastSync: config.lastSync || _openclawLastSync,
    nodeCount: _openclawNodes.length,
    categoryCount: _openclawCategories.length,
  });
});

// POST /api/bridges/openclaw/connect — Enable the bridge with a workspace path
app.post('/api/bridges/openclaw/connect', (req, res) => {
  try {
    let { workspacePath } = req.body;

    // Auto-detect if not provided
    if (!workspacePath) {
      const homeDir = process.env.USERPROFILE || process.env.HOME;
      const defaultPath = join(homeDir, '.openclaw', 'workspace');
      if (existsSync(defaultPath)) {
        workspacePath = defaultPath;
      } else {
        return res.status(400).json({
          error: 'OpenClaw workspace not found. Provide workspacePath or install OpenClaw.'
        });
      }
    }

    // Normalize path separators for cross-platform
    workspacePath = workspacePath.replace(/\\/g, '/');

    // Validate workspace exists
    if (!existsSync(workspacePath)) {
      return res.status(400).json({ error: `Workspace path does not exist: ${workspacePath}` });
    }
    // Check for AGENTS.md as a marker that this is a valid OpenClaw workspace
    if (!existsSync(join(workspacePath, 'AGENTS.md'))) {
      return res.status(400).json({
        error: 'Not a valid OpenClaw workspace (AGENTS.md not found)'
      });
    }

    const config = {
      enabled: true,
      workspacePath,
      lastSync: null,
    };
    saveBridgeConfig('openclaw', config);

    // Perform initial sync
    const result = syncOpenClawBridge();

    res.json({
      ok: true,
      message: 'OpenClaw bridge connected',
      ...result,
    });
  } catch (err) {
    console.error('POST /api/bridges/openclaw/connect error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bridges/openclaw/sync — Re-read and parse files
app.post('/api/bridges/openclaw/sync', (req, res) => {
  try {
    const config = loadBridgeConfig('openclaw');
    if (!config?.enabled) {
      return res.status(400).json({ error: 'OpenClaw bridge is not connected' });
    }

    const result = syncOpenClawBridge();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('POST /api/bridges/openclaw/sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/bridges/openclaw — Disconnect the bridge
app.delete('/api/bridges/openclaw', (req, res) => {
  try {
    removeBridgeConfig('openclaw');
    _openclawNodes = [];
    _openclawCategories = [];
    _openclawLastSync = null;
    res.json({ ok: true, message: 'OpenClaw bridge disconnected' });
  } catch (err) {
    console.error('DELETE /api/bridges/openclaw error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Discord Configuration Routes ---

// GET /api/discord/config — Read Discord config from .env
app.get('/api/discord/config', (req, res) => {
  try {
    const vars = parseEnvFile(ENV_PATH);
    res.json({
      ok: true,
      config: {
        botToken: vars.DISCORD_BOT_TOKEN || '',
        guildId: vars.DISCORD_GUILD_ID || '',
        defaultCategory: vars.DISCORD_DEFAULT_CATEGORY || '',
        logChannel: vars.DISCORD_LOG_CHANNEL || '',
        welcomeChannel: vars.DISCORD_WELCOME_CHANNEL || '',
        rulesChannel: vars.DISCORD_RULES_CHANNEL || '',
        modRole: vars.DISCORD_MOD_ROLE || '',
        banDeleteDays: vars.DISCORD_BAN_DELETE_DAYS || '0',
        timeoutMinutes: vars.DISCORD_TIMEOUT_MINUTES || '10',
      },
    });
  } catch (err) {
    console.error('GET /api/discord/config error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/discord/config — Save Discord config to .env
app.put('/api/discord/config', (req, res) => {
  try {
    const { key, value } = req.body;
    const ENV_KEYS = {
      botToken: 'DISCORD_BOT_TOKEN',
      guildId: 'DISCORD_GUILD_ID',
      defaultCategory: 'DISCORD_DEFAULT_CATEGORY',
      logChannel: 'DISCORD_LOG_CHANNEL',
      welcomeChannel: 'DISCORD_WELCOME_CHANNEL',
      rulesChannel: 'DISCORD_RULES_CHANNEL',
      modRole: 'DISCORD_MOD_ROLE',
      banDeleteDays: 'DISCORD_BAN_DELETE_DAYS',
      timeoutMinutes: 'DISCORD_TIMEOUT_MINUTES',
    };
    const envKey = ENV_KEYS[key];
    if (!envKey) return res.status(400).json({ error: `Unknown config key: ${key}` });

    const vars = parseEnvFile(ENV_PATH);
    vars[envKey] = value || '';
    writeEnvFile(ENV_PATH, vars);

    // Also update process.env so MCP server picks it up
    process.env[envKey] = value || '';

    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/discord/config error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/discord/test — Test bot token by calling Discord API
app.post('/api/discord/test', async (req, res) => {
  try {
    const vars = parseEnvFile(ENV_PATH);
    const token = vars.DISCORD_BOT_TOKEN;
    if (!token) return res.json({ ok: false, error: 'No bot token configured.' });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    try {
      // Test bot token
      const botRes = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { 'Authorization': `Bot ${token}` },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!botRes.ok) {
        const err = await botRes.json().catch(() => ({}));
        return res.json({ ok: false, error: `Discord API ${botRes.status}: ${err.message || 'Invalid token'}` });
      }

      const bot = await botRes.json();

      // Fetch guilds
      const guildsRes = await fetch('https://discord.com/api/v10/users/@me/guilds', {
        headers: { 'Authorization': `Bot ${token}` },
      });
      const guilds = guildsRes.ok ? await guildsRes.json() : [];

      res.json({
        ok: true,
        bot: {
          id: bot.id,
          username: bot.username,
          discriminator: bot.discriminator,
          avatar: bot.avatar,
          guilds: guilds.map(g => ({ id: g.id, name: g.name, icon: g.icon })),
        },
      });
    } catch (fetchErr) {
      clearTimeout(timer);
      const msg = fetchErr.message || String(fetchErr);
      if (msg.includes('abort')) return res.json({ ok: false, error: 'Connection timed out.' });
      res.json({ ok: false, error: `Network error: ${msg}` });
    }
  } catch (err) {
    console.error('POST /api/discord/test error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Setup / Onboarding Routes ---

// GET /api/setup/check-deps — Check system dependencies
app.get('/api/setup/check-deps', async (req, res) => {
  const deps = [];

  // Node.js
  const nodeVersion = process.versions.node;
  const nodeMajor = parseInt(nodeVersion.split('.')[0], 10);
  deps.push({
    id: 'node',
    name: 'Node.js',
    ok: nodeMajor >= 18,
    version: `v${nodeVersion}`,
    detail: nodeMajor >= 18 ? `v${nodeVersion}` : `v${nodeVersion} (need 18+)`,
    url: 'https://nodejs.org/',
  });

  // npm
  try {
    const { stdout } = await execAsync('npm --version', { timeout: 5000 });
    deps.push({ id: 'npm', name: 'npm', ok: true, version: `v${stdout.trim()}`, detail: `v${stdout.trim()}`, url: 'https://nodejs.org/' });
  } catch {
    deps.push({ id: 'npm', name: 'npm', ok: false, version: null, detail: 'Not found', url: 'https://nodejs.org/' });
  }

  // Docker no longer required — SQLite is built-in

  res.json({ deps });
});

// GET /api/setup/onboarding — Check what's configured (onboarding wizard)
app.get('/api/setup/onboarding', async (req, res) => {
  try {
    const vars = parseEnvFile(ENV_PATH);
    const setupComplete = vars.SETUP_COMPLETE === 'true';
    const dbExists = existsSync(getDbPath());
    const mcpBuilt = existsSync(resolve(PROJECT_ROOT, 'mcp-server', 'dist', 'index.js'));

    res.json({
      setupComplete,
      storage: 'sqlite',
      dbExists,
      embedding: 'local',
      mcpBuilt,
      projectDir: PROJECT_ROOT,
      platform: process.platform,
      defaultDbDir: dirname(getDbPath()),
    });
  } catch (err) {
    console.error('GET /api/setup/onboarding error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/setup/save-config — Write config to .env
app.post('/api/setup/save-config', (req, res) => {
  try {
    const { dbLocationPath } = req.body || {};
    const vars = parseEnvFile(ENV_PATH);

    if (dbLocationPath) {
      const resolvedDir = resolve(dbLocationPath);
      const resolvedPath = resolve(resolvedDir, 'memory.db');
      // Validate: create directory and test writability
      try {
        mkdirSync(resolvedDir, { recursive: true });
        const testFile = resolve(resolvedDir, '.synabun-write-test');
        writeFileSync(testFile, 'test');
        unlinkSync(testFile);
      } catch (err) {
        return res.status(400).json({ ok: false, error: `Cannot write to path: ${err.message}` });
      }
      vars['SQLITE_DB_PATH'] = resolvedPath;
      process.env['SQLITE_DB_PATH'] = resolvedPath;
    }

    writeEnvFile(ENV_PATH, vars);
    reloadConfig();
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/setup/save-config error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/setup/build — Install npm deps + build MCP server (SSE streaming)
app.post('/api/setup/build', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function send(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  const dirs = [
    { name: 'Neural Interface', path: resolve(PROJECT_ROOT, 'neural-interface') },
    { name: 'MCP Server', path: resolve(PROJECT_ROOT, 'mcp-server') },
  ];

  // Phase 1: npm install for each directory
  for (const dir of dirs) {
    const hasModules = existsSync(resolve(dir.path, 'node_modules'));
    if (hasModules) {
      send('install', { dir: dir.name, status: 'skipped', output: 'node_modules already present' });
      continue;
    }

    send('install', { dir: dir.name, status: 'start' });
    try {
      const { stdout, stderr } = await execAsync('npm install', {
        cwd: dir.path,
        timeout: 180_000,
        env: { ...process.env, NODE_ENV: 'development' },
      });
      send('install', { dir: dir.name, status: 'done', output: (stdout || '').slice(-500) });
    } catch (err) {
      send('install', { dir: dir.name, status: 'error', output: (err.stderr || err.message || '').slice(-500) });
      send('complete', { ok: false, error: `npm install failed for ${dir.name}` });
      return res.end();
    }
  }

  // Phase 2: Build MCP server
  const mcpDist = resolve(PROJECT_ROOT, 'mcp-server', 'dist', 'index.js');
  const mcpSrc = resolve(PROJECT_ROOT, 'mcp-server', 'src', 'index.ts');
  let needsBuild = !existsSync(mcpDist);
  if (!needsBuild) {
    try { needsBuild = statSync(mcpSrc).mtimeMs > statSync(mcpDist).mtimeMs; } catch { needsBuild = true; }
  }

  if (!needsBuild) {
    send('build', { status: 'skipped', output: 'dist/index.js is up to date' });
  } else {
    send('build', { status: 'start' });
    try {
      const { stdout, stderr } = await execAsync('npm run build', {
        cwd: resolve(PROJECT_ROOT, 'mcp-server'),
        timeout: 60_000,
      });
      send('build', { status: 'done', output: (stdout || '').slice(-500) });
    } catch (err) {
      send('build', { status: 'error', output: (err.stderr || err.message || '').slice(-500) });
      send('complete', { ok: false, error: 'MCP server build failed' });
      return res.end();
    }
  }

  send('complete', { ok: true });
  res.end();
});

// Legacy setup stubs for UI compatibility
app.post('/api/setup/start-docker-desktop', (req, res) => { res.json({ ok: true, message: 'Docker no longer required — using local SQLite.' }); });
app.post('/api/setup/docker', (req, res) => { res.json({ ok: true, message: 'Docker no longer required — using local SQLite.' }); });
app.post('/api/setup/create-collection', (req, res) => { res.json({ ok: true, message: 'SQLite database is created automatically.' }); });
app.get('/api/setup/test-qdrant', (req, res) => { res.json({ ok: true, message: 'Using local SQLite — no Qdrant to test.' }); });
app.post('/api/setup/test-qdrant-cloud', (req, res) => { res.json({ ok: true, message: 'Using local SQLite — no Qdrant to test.' }); });

// POST /api/setup/write-mcp-json — Generate .mcp.json in target directory
app.post('/api/setup/write-mcp-json', (req, res) => {
  try {
    const { targetDir } = req.body;
    if (!targetDir) return res.status(400).json({ error: 'targetDir required' });

    const mcpIndexPath = resolve(PROJECT_ROOT, 'mcp-server', 'dist', 'preload.js').replace(/\\/g, '/');
    const envPath = resolve(PROJECT_ROOT, '.env').replace(/\\/g, '/');

    const mcpEntry = {
      command: 'node',
      args: [mcpIndexPath],
      env: { DOTENV_PATH: envPath },
    };

    const targetPath = resolve(targetDir, '.mcp.json');
    let existing = {};
    try {
      existing = JSON.parse(readFileSync(targetPath, 'utf-8'));
    } catch {}

    if (!existing.mcpServers) existing.mcpServers = {};
    existing.mcpServers.SynaBun = mcpEntry;

    writeFileSync(targetPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
    res.json({ ok: true, path: targetPath });
  } catch (err) {
    console.error('POST /api/setup/write-mcp-json error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/setup/write-instructions — Append memory instructions to markdown file
app.post('/api/setup/write-instructions', (req, res) => {
  try {
    const { targetDir, fileName, content } = req.body;
    if (!targetDir || !fileName || !content) {
      return res.status(400).json({ error: 'targetDir, fileName, and content required' });
    }

    const targetPath = resolve(targetDir, fileName);
    let existing = '';
    try { existing = readFileSync(targetPath, 'utf-8'); } catch {}

    // Check if memory instructions already exist
    if (existing.includes('## Persistent Memory System') || existing.includes('## Memory MCP')) {
      return res.json({ ok: true, path: targetPath, skipped: true, message: 'Memory instructions already present' });
    }

    const separator = existing.length > 0 ? '\n\n---\n\n' : '';
    writeFileSync(targetPath, existing + separator + content + '\n', 'utf-8');
    res.json({ ok: true, path: targetPath, skipped: false });
  } catch (err) {
    console.error('POST /api/setup/write-instructions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/setup/complete — Mark setup as done & reload runtime config
app.post('/api/setup/complete', (req, res) => {
  try {
    const vars = parseEnvFile(ENV_PATH);
    vars.SETUP_COMPLETE = 'true';
    writeEnvFile(ENV_PATH, vars);
    reloadConfig();
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/setup/complete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════
// Claude Code Hook Integration
// ═══════════════════════════════════════════

// All SynaBun hooks managed together
const HOOK_SCRIPTS = [
  { event: 'SessionStart',      script: 'session-start.mjs', timeout: 5 },
  { event: 'UserPromptSubmit',  script: 'prompt-submit.mjs', timeout: 3 },
  { event: 'PreCompact',        script: 'pre-compact.mjs',   timeout: 10 },
  { event: 'Stop',              script: 'stop.mjs',          timeout: 3 },
  { event: 'PreToolUse',        script: 'pre-websearch.mjs', timeout: 3, matcher: '^WebSearch$|^WebFetch$' },
  { event: 'PostToolUse',       script: 'post-remember.mjs', timeout: 3, matcher: '^Edit$|^Write$|^NotebookEdit$|Syna[Bb]un__remember' },
  { event: 'PostToolUse',       script: 'post-plan.mjs',     timeout: 15, matcher: '^ExitPlanMode$' },
];

function getClaudeSettingsPath(projectPath) {
  return join(projectPath, '.claude', 'settings.json');
}

function getGlobalClaudeSettingsPath() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return join(home, '.claude', 'settings.json');
}

function readClaudeSettings(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch { return null; }
}

function writeClaudeSettings(filePath, data) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function hookCommandString(scriptName) {
  const scriptPath = resolve(PROJECT_ROOT, 'hooks', 'claude-code', scriptName).replace(/\\/g, '/');
  return `node "${scriptPath}"`;
}

function isHookInstalled(settings) {
  // Installed if at least the SessionStart hook is present
  if (!settings?.hooks?.SessionStart) return false;
  const cmd = hookCommandString('session-start.mjs');
  return settings.hooks.SessionStart.some(entry =>
    entry.hooks?.some(h => h.command === cmd)
  );
}

function isSpecificHookInstalled(settings, hookEvent) {
  if (!settings?.hooks?.[hookEvent]) return false;
  const defs = HOOK_SCRIPTS.filter(d => d.event === hookEvent);
  if (defs.length === 0) return false;
  // All scripts for this event must be installed
  return defs.every(def => {
    const cmd = hookCommandString(def.script);
    return settings.hooks[hookEvent].some(entry =>
      entry.hooks?.some(h => h.command === cmd)
    );
  });
}

// Environment variables SynaBun enforces in Claude Code settings
const SYNABUN_ENV_DEFAULTS = {
  ENABLE_TOOL_SEARCH: 'true',   // Defer MCP tools not in active use — saves ~50%+ context tokens
};

function ensureSynaBunEnv(settings) {
  if (!settings.env) settings.env = {};
  for (const [key, value] of Object.entries(SYNABUN_ENV_DEFAULTS)) {
    if (!(key in settings.env)) settings.env[key] = value;
  }
  return settings;
}

// MCP tool permissions SynaBun auto-injects so tools work without per-call prompts
const SYNABUN_TOOL_PERMISSIONS = [
  'mcp__SynaBun__recall',
  'mcp__SynaBun__remember',
  'mcp__SynaBun__reflect',
  'mcp__SynaBun__forget',
  'mcp__SynaBun__memories',
  'mcp__SynaBun__restore',
  'mcp__SynaBun__loop',
  'mcp__SynaBun__category',
  'mcp__SynaBun__sync',
  'mcp__SynaBun__browser_navigate',
  'mcp__SynaBun__browser_click',
  'mcp__SynaBun__browser_fill',
  'mcp__SynaBun__browser_type',
  'mcp__SynaBun__browser_hover',
  'mcp__SynaBun__browser_select',
  'mcp__SynaBun__browser_press',
  'mcp__SynaBun__browser_evaluate',
  'mcp__SynaBun__browser_snapshot',
  'mcp__SynaBun__browser_content',
  'mcp__SynaBun__browser_screenshot',
  'mcp__SynaBun__browser_session',
  'mcp__SynaBun__browser_go_back',
  'mcp__SynaBun__browser_go_forward',
  'mcp__SynaBun__browser_reload',
  'mcp__SynaBun__browser_wait',
  'mcp__SynaBun__browser_scroll',
  'mcp__SynaBun__browser_upload',
  'mcp__SynaBun__browser_extract_tweets',
  'mcp__SynaBun__browser_extract_fb_posts',
  'mcp__SynaBun__browser_extract_tiktok_videos',
  'mcp__SynaBun__browser_extract_tiktok_search',
  'mcp__SynaBun__browser_extract_tiktok_studio',
  'mcp__SynaBun__browser_extract_tiktok_profile',
  'mcp__SynaBun__browser_extract_wa_chats',
  'mcp__SynaBun__browser_extract_wa_messages',
  'mcp__SynaBun__browser_extract_ig_feed',
  'mcp__SynaBun__browser_extract_ig_profile',
  'mcp__SynaBun__browser_extract_ig_post',
  'mcp__SynaBun__browser_extract_ig_reels',
  'mcp__SynaBun__browser_extract_ig_search',
  'mcp__SynaBun__browser_extract_li_feed',
  'mcp__SynaBun__browser_extract_li_profile',
  'mcp__SynaBun__browser_extract_li_post',
  'mcp__SynaBun__browser_extract_li_notifications',
  'mcp__SynaBun__browser_extract_li_messages',
  'mcp__SynaBun__browser_extract_li_search_people',
  'mcp__SynaBun__browser_extract_li_network',
  'mcp__SynaBun__browser_extract_li_jobs',
  'mcp__SynaBun__discord_guild',
  'mcp__SynaBun__discord_channel',
  'mcp__SynaBun__discord_role',
  'mcp__SynaBun__discord_message',
  'mcp__SynaBun__discord_member',
  'mcp__SynaBun__discord_onboarding',
  'mcp__SynaBun__discord_webhook',
  'mcp__SynaBun__discord_thread',
  'mcp__SynaBun__git',
  'mcp__SynaBun__tictactoe',
  'mcp__SynaBun__whiteboard_read',
  'mcp__SynaBun__whiteboard_add',
  'mcp__SynaBun__whiteboard_update',
  'mcp__SynaBun__whiteboard_remove',
  'mcp__SynaBun__whiteboard_screenshot',
  'mcp__SynaBun__card_list',
  'mcp__SynaBun__card_open',
  'mcp__SynaBun__card_close',
  'mcp__SynaBun__card_update',
  'mcp__SynaBun__card_screenshot',
];

// No-op — permissions are OFF by default.
// Users enable them via Settings → Permissions toggles.
function ensureSynaBunPermissions(settings) {
  if (!settings.permissions) settings.permissions = {};
  if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];
  return settings;
}

// Tool categories with human-readable labels for the Settings UI
const SYNABUN_TOOL_CATEGORIES = [
  {
    id: 'memory', label: 'Memory',
    tools: [
      { key: 'mcp__SynaBun__recall', label: 'Search memories', desc: 'Find relevant memories by meaning' },
      { key: 'mcp__SynaBun__remember', label: 'Save memory', desc: 'Store something new to remember' },
      { key: 'mcp__SynaBun__reflect', label: 'Edit memory', desc: 'Update an existing memory' },
      { key: 'mcp__SynaBun__forget', label: 'Delete memory', desc: 'Remove a memory (can be restored)' },
      { key: 'mcp__SynaBun__memories', label: 'View memory list', desc: 'Browse recent memories and stats' },
      { key: 'mcp__SynaBun__restore', label: 'Restore deleted', desc: 'Recover previously deleted memories' },
      { key: 'mcp__SynaBun__sync', label: 'Fix stale data', desc: 'Detect and repair outdated memories' },
    ],
  },
  {
    id: 'browser', label: 'Browser',
    tools: [
      { key: 'mcp__SynaBun__browser_navigate', label: 'Open URL', desc: 'Go to a web address' },
      { key: 'mcp__SynaBun__browser_click', label: 'Click', desc: 'Click on a page element' },
      { key: 'mcp__SynaBun__browser_fill', label: 'Fill input', desc: 'Type into a form field' },
      { key: 'mcp__SynaBun__browser_type', label: 'Type text', desc: 'Type character by character' },
      { key: 'mcp__SynaBun__browser_hover', label: 'Hover', desc: 'Hover over an element' },
      { key: 'mcp__SynaBun__browser_select', label: 'Select option', desc: 'Choose from a dropdown' },
      { key: 'mcp__SynaBun__browser_press', label: 'Press key', desc: 'Press a keyboard key' },
      { key: 'mcp__SynaBun__browser_evaluate', label: 'Run JavaScript', desc: 'Execute code on the page' },
      { key: 'mcp__SynaBun__browser_snapshot', label: 'Read page structure', desc: 'Get the page layout and elements' },
      { key: 'mcp__SynaBun__browser_content', label: 'Read page text', desc: 'Get the visible text content' },
      { key: 'mcp__SynaBun__browser_screenshot', label: 'Take screenshot', desc: 'Capture what the page looks like' },
      { key: 'mcp__SynaBun__browser_session', label: 'Manage sessions', desc: 'Open, close, or switch browser windows' },
      { key: 'mcp__SynaBun__browser_go_back', label: 'Go back', desc: 'Navigate to the previous page' },
      { key: 'mcp__SynaBun__browser_go_forward', label: 'Go forward', desc: 'Navigate to the next page' },
      { key: 'mcp__SynaBun__browser_reload', label: 'Reload page', desc: 'Refresh the current page' },
      { key: 'mcp__SynaBun__browser_wait', label: 'Wait for page', desc: 'Wait until an element or page finishes loading' },
      { key: 'mcp__SynaBun__browser_scroll', label: 'Scroll', desc: 'Scroll the page or a specific area' },
      { key: 'mcp__SynaBun__browser_upload', label: 'Upload file', desc: 'Upload a file through a form' },
    ],
  },
  {
    id: 'social', label: 'Social Media Automation',
    tools: [
      { key: 'mcp__SynaBun__browser_extract_tweets', label: 'Extract tweets', desc: 'Pull tweet data from the page', group: 'Twitter / X' },
      { key: 'mcp__SynaBun__browser_extract_fb_posts', label: 'Extract posts', desc: 'Pull Facebook post data from the page', group: 'Facebook' },
      { key: 'mcp__SynaBun__browser_extract_tiktok_videos', label: 'Extract videos', desc: 'Pull TikTok video data from feed', group: 'TikTok' },
      { key: 'mcp__SynaBun__browser_extract_tiktok_search', label: 'Extract search results', desc: 'Pull TikTok search results', group: 'TikTok' },
      { key: 'mcp__SynaBun__browser_extract_tiktok_studio', label: 'Extract Studio content', desc: 'Pull TikTok Studio content list', group: 'TikTok' },
      { key: 'mcp__SynaBun__browser_extract_tiktok_profile', label: 'Extract profile', desc: 'Pull TikTok creator profile info', group: 'TikTok' },
      { key: 'mcp__SynaBun__browser_extract_wa_chats', label: 'Extract chat list', desc: 'Pull WhatsApp chat list', group: 'WhatsApp' },
      { key: 'mcp__SynaBun__browser_extract_wa_messages', label: 'Extract messages', desc: 'Pull WhatsApp messages from open chat', group: 'WhatsApp' },
      { key: 'mcp__SynaBun__browser_extract_ig_feed', label: 'Extract feed', desc: 'Pull Instagram feed posts', group: 'Instagram' },
      { key: 'mcp__SynaBun__browser_extract_ig_profile', label: 'Extract profile', desc: 'Pull Instagram profile data', group: 'Instagram' },
      { key: 'mcp__SynaBun__browser_extract_ig_post', label: 'Extract post', desc: 'Pull single post with comments', group: 'Instagram' },
      { key: 'mcp__SynaBun__browser_extract_ig_reels', label: 'Extract reels', desc: 'Pull Instagram Reels data', group: 'Instagram' },
      { key: 'mcp__SynaBun__browser_extract_ig_search', label: 'Extract search', desc: 'Pull Explore page posts', group: 'Instagram' },
      { key: 'mcp__SynaBun__browser_extract_li_feed', label: 'Extract feed', desc: 'Pull LinkedIn feed posts', group: 'LinkedIn' },
      { key: 'mcp__SynaBun__browser_extract_li_profile', label: 'Extract profile', desc: 'Pull LinkedIn profile data', group: 'LinkedIn' },
      { key: 'mcp__SynaBun__browser_extract_li_post', label: 'Extract post', desc: 'Pull single post with comments', group: 'LinkedIn' },
      { key: 'mcp__SynaBun__browser_extract_li_notifications', label: 'Extract notifications', desc: 'Pull LinkedIn notifications', group: 'LinkedIn' },
      { key: 'mcp__SynaBun__browser_extract_li_messages', label: 'Extract messages', desc: 'Pull LinkedIn messaging threads', group: 'LinkedIn' },
      { key: 'mcp__SynaBun__browser_extract_li_search_people', label: 'Search people', desc: 'Pull people search results', group: 'LinkedIn' },
      { key: 'mcp__SynaBun__browser_extract_li_network', label: 'Extract network', desc: 'Pull My Network invitations & suggestions', group: 'LinkedIn' },
      { key: 'mcp__SynaBun__browser_extract_li_jobs', label: 'Extract jobs', desc: 'Pull job listings from search & recommendations', group: 'LinkedIn' },
      { key: 'mcp__SynaBun__discord_guild', label: 'Server management', desc: 'Server info, channels, members, roles, audit log', group: 'Discord' },
      { key: 'mcp__SynaBun__discord_channel', label: 'Channel management', desc: 'Create, edit, delete, list channels', group: 'Discord' },
      { key: 'mcp__SynaBun__discord_role', label: 'Role management', desc: 'Create, edit, delete, assign roles', group: 'Discord' },
      { key: 'mcp__SynaBun__discord_message', label: 'Messages', desc: 'Send, edit, delete, pin, react to messages', group: 'Discord' },
      { key: 'mcp__SynaBun__discord_member', label: 'Member moderation', desc: 'Kick, ban, timeout, nickname members', group: 'Discord' },
      { key: 'mcp__SynaBun__discord_onboarding', label: 'Onboarding', desc: 'Welcome, rules, verification, onboarding setup', group: 'Discord' },
      { key: 'mcp__SynaBun__discord_webhook', label: 'Webhooks', desc: 'Create, edit, delete, execute webhooks', group: 'Discord' },
      { key: 'mcp__SynaBun__discord_thread', label: 'Threads', desc: 'Create, archive, lock, delete threads', group: 'Discord' },
    ],
  },
  {
    id: 'whiteboard', label: 'Whiteboard',
    tools: [
      { key: 'mcp__SynaBun__whiteboard_read', label: 'Read board', desc: 'View whiteboard contents' },
      { key: 'mcp__SynaBun__whiteboard_add', label: 'Add to board', desc: 'Place new items on the whiteboard' },
      { key: 'mcp__SynaBun__whiteboard_update', label: 'Edit board items', desc: 'Modify items on the whiteboard' },
      { key: 'mcp__SynaBun__whiteboard_remove', label: 'Remove from board', desc: 'Delete items from the whiteboard' },
      { key: 'mcp__SynaBun__whiteboard_screenshot', label: 'Screenshot board', desc: 'Capture the whiteboard as an image' },
    ],
  },
  {
    id: 'cards', label: 'Cards',
    tools: [
      { key: 'mcp__SynaBun__card_list', label: 'List cards', desc: 'See all open memory cards' },
      { key: 'mcp__SynaBun__card_open', label: 'Open card', desc: 'Open a memory card on screen' },
      { key: 'mcp__SynaBun__card_close', label: 'Close card', desc: 'Dismiss open memory cards' },
      { key: 'mcp__SynaBun__card_update', label: 'Arrange cards', desc: 'Move, resize, pin, or compact cards' },
      { key: 'mcp__SynaBun__card_screenshot', label: 'Screenshot cards', desc: 'Capture open cards as an image' },
    ],
  },
  {
    id: 'automation', label: 'Automation',
    tools: [
      { key: 'mcp__SynaBun__loop', label: 'Autonomous loops', desc: 'Run, stop, or check background tasks' },
      { key: 'mcp__SynaBun__category', label: 'Manage categories', desc: 'Create, edit, or remove memory categories' },
      { key: 'mcp__SynaBun__tictactoe', label: 'Tic Tac Toe', desc: 'Play a game of tic-tac-toe with your AI' },
      { key: 'mcp__SynaBun__git', label: 'Git operations', desc: 'Status, diff, commit, log, and branches' },
    ],
  },
  {
    id: 'thirdparty', label: 'Third Party',
    tools: [
      { key: 'WebSearch', label: 'Web search', desc: 'Search the internet for information' },
    ],
  },
];

function addHookToSettings(settings, onlyEvent) {
  if (!settings) settings = {};
  if (!settings.hooks) settings.hooks = {};

  // Enforce SynaBun env defaults and tool permissions alongside hooks
  ensureSynaBunEnv(settings);
  ensureSynaBunPermissions(settings);

  const defs = onlyEvent ? HOOK_SCRIPTS.filter(d => d.event === onlyEvent) : HOOK_SCRIPTS;
  for (const def of defs) {
    if (!settings.hooks[def.event]) settings.hooks[def.event] = [];
    const cmd = hookCommandString(def.script);
    const alreadyExists = settings.hooks[def.event].some(entry =>
      entry.hooks?.some(h => h.command === cmd)
    );
    if (!alreadyExists) {
      settings.hooks[def.event].push({
        matcher: def.matcher || '',
        hooks: [{ type: 'command', command: cmd, timeout: def.timeout }],
      });
    }
  }
  return settings;
}

function removeHookFromSettings(settings, onlyEvent) {
  if (!settings?.hooks) return settings;

  const defs = onlyEvent ? HOOK_SCRIPTS.filter(d => d.event === onlyEvent) : HOOK_SCRIPTS;
  for (const def of defs) {
    if (!settings.hooks[def.event]) continue;
    const cmd = hookCommandString(def.script);
    settings.hooks[def.event] = settings.hooks[def.event].filter(entry =>
      !entry.hooks?.some(h => h.command === cmd)
    );
    if (settings.hooks[def.event].length === 0) delete settings.hooks[def.event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return settings;
}

// Persistent list of project paths the user has registered
const HOOK_PROJECTS_PATH = resolve(PROJECT_ROOT, 'data', 'claude-code-projects.json');

function loadHookProjects() {
  try {
    if (!existsSync(HOOK_PROJECTS_PATH)) return [];
    return JSON.parse(readFileSync(HOOK_PROJECTS_PATH, 'utf-8'));
  } catch { return []; }
}

function saveHookProjects(projects) {
  const dir = dirname(HOOK_PROJECTS_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(HOOK_PROJECTS_PATH, JSON.stringify(projects, null, 2), 'utf-8');
}

// ── Claude session index helpers ──

/** Extract metadata from a .jsonl session file by reading its first user message.
 *  Reads line-by-line (stops at first `type: user`) to avoid loading the whole file. */
function extractSessionMeta(filePath) {
  try {
    const fd = openSync(filePath, 'r');
    const CHUNK = 65536;      // 64KB per read
    const MAX_READ = 1048576; // 1MB max total
    const fileSize = fstatSync(fd).size;
    let pending = '';
    let offset = 0;

    while (offset < Math.min(fileSize, MAX_READ)) {
      const readSize = Math.min(CHUNK, fileSize - offset);
      const buf = Buffer.alloc(readSize);
      const bytesRead = readSync(fd, buf, 0, readSize, offset);
      if (bytesRead === 0) break;
      pending += buf.toString('utf-8', 0, bytesRead);
      offset += bytesRead;

      // Process complete lines (terminated by \n)
      let nlIdx;
      while ((nlIdx = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, nlIdx).trim();
        pending = pending.slice(nlIdx + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'user' && obj.message) {
            closeSync(fd);
            const txt = obj.message.content;
            const prompt = Array.isArray(txt)
              ? (txt.find(b => b.type === 'text')?.text || '')
              : (txt || '');
            return {
              sessionId: obj.sessionId || basename(filePath, '.jsonl'),
              firstPrompt: prompt.slice(0, 200),
              gitBranch: obj.gitBranch || null,
              isSidechain: !!obj.isSidechain,
              cwd: obj.cwd || null,
            };
          }
        } catch { /* incomplete or malformed line */ }
      }
    }

    closeSync(fd);
    return null; // no user message found
  } catch { return null; }
}

/** Count user + assistant messages in a JSONL session file.
 *  Fast string scan — no JSON parsing, reads the full file in 64KB chunks. */
function countSessionMessages(filePath) {
  try {
    const fd = openSync(filePath, 'r');
    const CHUNK = 65536;
    const fileSize = fstatSync(fd).size;
    let pending = '', offset = 0, count = 0;

    while (offset < fileSize) {
      const readSize = Math.min(CHUNK, fileSize - offset);
      const buf = Buffer.alloc(readSize);
      const bytesRead = readSync(fd, buf, 0, readSize, offset);
      if (bytesRead === 0) break;
      pending += buf.toString('utf-8', 0, bytesRead);
      offset += bytesRead;

      let nlIdx;
      while ((nlIdx = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, nlIdx);
        pending = pending.slice(nlIdx + 1);
        if (line.includes('"type":"user"') || line.includes('"type":"assistant"') ||
            line.includes('"type": "user"') || line.includes('"type": "assistant"')) {
          count++;
        }
      }
    }
    if (pending.length > 0 &&
        (pending.includes('"type":"user"') || pending.includes('"type":"assistant"') ||
         pending.includes('"type": "user"') || pending.includes('"type": "assistant"'))) {
      count++;
    }
    closeSync(fd);
    return count;
  } catch { return 0; }
}

// ── Session metadata cache ──
// Persists discovered session metadata so entries survive even after
// Claude Code deletes old JSONL files from disk.
const SESSION_CACHE_DIR = resolve(PROJECT_ROOT, 'data');
const _sessionCacheMap = new Map(); // projDir → Map(sessionId → entry)

function getSessionCachePath(projDir) {
  const key = basename(projDir).replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(SESSION_CACHE_DIR, `sessions-cache-${key}.json`);
}

function loadSessionCache(projDir) {
  if (_sessionCacheMap.has(projDir)) return _sessionCacheMap.get(projDir);
  const cache = new Map();
  try {
    const data = JSON.parse(readFileSync(getSessionCachePath(projDir), 'utf-8'));
    for (const e of data) cache.set(e.sessionId, e);
  } catch { /* no cache yet */ }
  _sessionCacheMap.set(projDir, cache);
  return cache;
}

function saveSessionCache(projDir, cache) {
  try {
    if (!existsSync(SESSION_CACHE_DIR)) mkdirSync(SESSION_CACHE_DIR, { recursive: true });
    writeFileSync(getSessionCachePath(projDir), JSON.stringify([...cache.values()]), 'utf-8');
  } catch { /* write error */ }
}

/** Build a complete session list for a project dir by scanning JSONL files,
 *  counting messages (with smart caching by fileSize), and preserving
 *  cached entries for sessions whose files have been deleted. */
function buildSessionEntries(projDir) {
  const cache = loadSessionCache(projDir);
  let cacheChanged = false;

  // 1. Scan ALL JSONL files with stat info
  let allFiles;
  try { allFiles = readdirSync(projDir); } catch { allFiles = []; }

  const jsonlFiles = allFiles.filter(f => f.endsWith('.jsonl'));
  const jsonlIds = new Set(jsonlFiles.map(f => f.replace('.jsonl', '')));

  const filesWithStat = jsonlFiles.map(f => {
    try {
      const stat = statSync(join(projDir, f));
      return { file: f, mtime: stat.mtime, size: stat.size };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.mtime - a.mtime);

  // 2. Extract metadata + count messages (smart: skip counting if fileSize unchanged)
  for (const { file, mtime, size } of filesWithStat) {
    const sid = file.replace('.jsonl', '');
    const filePath = join(projDir, file);
    const cached = cache.get(sid);

    if (cached && cached.fileSize === size && cached.fileSize !== undefined) {
      // File unchanged — update modified timestamp if needed
      if (mtime.toISOString() > cached.modified) {
        cache.set(sid, { ...cached, modified: mtime.toISOString() });
        cacheChanged = true;
      }
      continue;
    }

    // New or changed file — extract metadata and count messages
    const meta = extractSessionMeta(filePath);
    if (!meta) continue;

    const messageCount = countSessionMessages(filePath);
    const entry = {
      sessionId: meta.sessionId,
      firstPrompt: meta.firstPrompt,
      messageCount,
      fileSize: size,
      created: cached?.created || mtime.toISOString(),
      modified: mtime.toISOString(),
      gitBranch: meta.gitBranch,
      isSidechain: meta.isSidechain,
      projectPath: meta.cwd,
    };

    cache.set(sid, cached ? { ...cached, ...entry } : entry);
    cacheChanged = true;
  }

  // Mark cached entries whose files are gone (still returned, but not resumable)
  for (const [sid, entry] of cache) {
    const wasLive = jsonlIds.has(sid);
    if (!wasLive && !entry._deleted) {
      entry._deleted = true;
      cacheChanged = true;
    } else if (wasLive && entry._deleted) {
      entry._deleted = false;
      cacheChanged = true;
    }
  }

  if (cacheChanged) saveSessionCache(projDir, cache);

  return [...cache.values()];
}

// GET /api/claude-code/sessions — browse past Claude Code sessions across registered projects
app.get('/api/claude-code/sessions', (req, res) => {
  try {
    // Force full re-scan when refresh requested — nuke both in-memory and persistent cache
    if (req.query.refresh === 'true') {
      _sessionCacheMap.clear();
      try {
        const cacheFiles = readdirSync(SESSION_CACHE_DIR)
          .filter(f => f.startsWith('sessions-cache-') && f.endsWith('.json'));
        for (const f of cacheFiles) { try { unlinkSync(join(SESSION_CACHE_DIR, f)); } catch {} }
      } catch {}
    }

    const projects = loadHookProjects();
    const targetProject = req.query.project;
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const offset = parseInt(req.query.offset) || 0;
    const search = (req.query.search || '').toLowerCase().trim();

    const homeDir = process.env.USERPROFILE || process.env.HOME;
    const claudeProjectsDir = join(homeDir, '.claude', 'projects');

    const result = [];

    for (const proj of projects) {
      if (targetProject && resolve(proj.path) !== resolve(targetProject)) continue;

      // Convert project path to Claude's directory name format
      // "D:\Projects\MyApp" -> "d--Projects-MyApp"
      // Try both lowercase and uppercase drive letter (Claude is inconsistent)
      const projKeyLower = pathToClaudeKey(proj.path).replace(/^([A-Z])/, (m) => m.toLowerCase());
      const projKeyUpper = pathToClaudeKey(proj.path);

      let projDir = join(claudeProjectsDir, projKeyLower);
      if (!existsSync(projDir)) projDir = join(claudeProjectsDir, projKeyUpper);
      if (!existsSync(projDir)) {
        result.push({ path: proj.path, label: proj.label || basename(proj.path), total: 0, sessions: [] });
        continue;
      }

      // Build complete session list (index + unindexed JSONL files)
      let entries = buildSessionEntries(projDir);

      // Filter out sidechains by default, sort by modified descending
      entries = entries.filter(e => !e.isSidechain);
      entries.sort((a, b) => new Date(b.modified) - new Date(a.modified));

      // Apply text filter if search provided
      if (search) {
        entries = entries.filter(e =>
          (e.firstPrompt || '').toLowerCase().includes(search) ||
          (e.gitBranch || '').toLowerCase().includes(search) ||
          (e.sessionId || '').toLowerCase().includes(search)
        );
      }

      const total = entries.length;
      const paginated = entries.slice(offset, offset + limit);

      result.push({
        path: proj.path,
        label: proj.label || basename(proj.path),
        total,
        sessions: paginated.map(e => ({
          sessionId: e.sessionId,
          firstPrompt: (e.firstPrompt || '').slice(0, 200),
          messageCount: e.messageCount || 0,
          created: e.created,
          modified: e.modified,
          gitBranch: e.gitBranch || null,
          isSidechain: e.isSidechain || false,
          deleted: e._deleted || false,
        })),
      });
    }

    res.json({ projects: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Session Messages (read JSONL for panel history) ---

app.get('/api/claude-code/sessions/:sessionId/messages', (req, res) => {
  try {
    const { sessionId } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    const project = req.query.project;

    // Find the JSONL file for this session
    const homeDir = process.env.USERPROFILE || process.env.HOME;
    const claudeProjectsDir = join(homeDir, '.claude', 'projects');
    const projects = loadHookProjects();

    let filePath = null;

    // Search in the specified project first, then all projects
    const searchOrder = project
      ? [projects.find(p => resolve(p.path) === resolve(project)), ...projects].filter(Boolean)
      : projects;

    for (const proj of searchOrder) {
      if (filePath) break;
      const projKeyLower = pathToClaudeKey(proj.path).replace(/^([A-Z])/, m => m.toLowerCase());
      const projKeyUpper = pathToClaudeKey(proj.path);

      for (const key of [projKeyLower, projKeyUpper]) {
        const candidate = join(claudeProjectsDir, key, `${sessionId}.jsonl`);
        if (existsSync(candidate)) { filePath = candidate; break; }
      }
    }

    if (!filePath) return res.json({ messages: [] });

    const raw = readFileSync(filePath, 'utf-8');
    const lines = raw.split('\n');
    const messages = [];
    let lastUsage = null;
    let lastModel = null;
    let turns = 0;

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'user') {
          const content = obj.message?.content;
          const text = typeof content === 'string' ? content
            : Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text).join('\n')
            : '';
          if (text) { messages.push({ role: 'user', text: text.slice(0, 8000) }); turns++; }
        } else if (obj.type === 'assistant') {
          const content = obj.message?.content;
          const textBlocks = Array.isArray(content)
            ? content.filter(b => b.type === 'text').map(b => b.text)
            : [];
          const toolUseBlocks = Array.isArray(content)
            ? content.filter(b => b.type === 'tool_use').map(b => ({
                id: b.id,
                name: b.name,
                input: b.input,
              }))
            : [];
          const text = textBlocks.join('\n');
          if (text || toolUseBlocks.length) {
            messages.push({
              role: 'assistant',
              text: text.slice(0, 8000) || undefined,
              tools: toolUseBlocks.length ? toolUseBlocks : undefined,
            });
          }
          // Track latest usage and model from assistant messages
          if (obj.message?.usage) lastUsage = obj.message.usage;
          if (obj.message?.model) lastModel = obj.message.model;
        } else if (obj.type === 'result') {
          // Result events often have the most accurate final usage for a turn
          if (obj.usage) lastUsage = obj.usage;
        } else if (obj.type === 'tool_result' || obj.type === 'tool') {
          // Extract tool results for pairing with tool_use cards in history
          const content = obj.message?.content || obj.content;
          const toolUseId = obj.tool_use_id || obj.message?.tool_use_id;
          if (toolUseId) {
            let resultText = '';
            if (Array.isArray(content)) resultText = content.map(b => b.text || '').join('\n');
            else if (typeof content === 'string') resultText = content;
            messages.push({
              role: 'tool_result',
              toolUseId,
              text: resultText.slice(0, 4000) || undefined,
              isError: obj.is_error || obj.message?.is_error || false,
            });
          }
        }
      } catch {}
    }

    // Return last N messages + usage summary
    const sliced = messages.slice(-limit);
    const result = { messages: sliced, total: messages.length, turns };
    if (lastUsage) {
      result.usage = {
        input_tokens: lastUsage.input_tokens || 0,
        output_tokens: lastUsage.output_tokens || 0,
        cache_read_input_tokens: lastUsage.cache_read_input_tokens || 0,
        cache_creation_input_tokens: lastUsage.cache_creation_input_tokens || 0,
      };
    }
    // Infer actual context window from model — CLI uses 1M by default for opus/sonnet 4.6
    if (lastModel) {
      const CLI_CONTEXT_WINDOWS = {
        'claude-opus-4-6': 1000000,
        'claude-sonnet-4-6': 1000000,
        'claude-haiku-4-5-20251001': 200000,
      };
      const cw = CLI_CONTEXT_WINDOWS[lastModel];
      if (cw) result.contextWindow = cw;
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Session Indexing ---

let _indexingJob = null; // { jobId, cancelled, promise }

app.post('/api/session-indexing/start', (req, res) => {
  if (_indexingJob && !_indexingJob.done) {
    return res.status(409).json({ error: 'Indexing already in progress', jobId: _indexingJob.jobId });
  }

  const { project, reindex, sessionIds } = req.body || {};
  const jobId = `idx-${Date.now()}`;
  let cancelled = false;

  const job = {
    jobId,
    done: false,
    cancelled: false,
    progress: { completed: 0, total: 0, chunks: 0 },
  };

  job.promise = startIndexing({
    project,
    reindex: !!reindex,
    sessionIds: sessionIds || undefined,
    onProgress: (event) => {
      event.jobId = jobId;
      // Track progress
      if (event.type === 'indexing:started') {
        job.progress.total = event.totalSessions;
      } else if (event.type === 'indexing:session-complete') {
        job.progress.completed = event.sessionIndex + 1;
        job.progress.chunks += event.chunkCount;
      }
      // Broadcast to all connected WebSocket clients
      try { broadcastSync(event); } catch {}
    },
    isCancelled: () => job.cancelled,
  }).then((result) => {
    job.done = true;
    job.result = result;
  }).catch((err) => {
    job.done = true;
    job.error = err.message;
    try { broadcastSync({ type: 'indexing:error', jobId, error: err.message }); } catch {}
  });

  _indexingJob = job;
  res.json({ ok: true, jobId, message: 'Indexing started' });
});

app.post('/api/session-indexing/cancel', (req, res) => {
  if (!_indexingJob || _indexingJob.done) {
    return res.status(404).json({ error: 'No active indexing job' });
  }
  _indexingJob.cancelled = true;
  res.json({ ok: true, message: 'Cancellation requested' });
});

app.get('/api/session-indexing/status', (req, res) => {
  try {
    const status = getIndexingStatus();
    const running = _indexingJob && !_indexingJob.done;
    res.json({
      running: !!running,
      jobId: running ? _indexingJob.jobId : null,
      progress: running ? _indexingJob.progress : null,
      indexedSessions: status.indexedSessions,
      totalChunks: status.totalChunks,
      lastRun: status.lastRun,
      // Convert Set to Array for JSON serialization
      indexedSessionIds: [...(status.indexedSessionIds || [])],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/session-indexing/mirror — one-time migration of existing session_chunks to claude_memory
app.post('/api/session-indexing/mirror', async (req, res) => {
  res.json({ ok: true, message: 'Mirror started' });
  try {
    await mirrorExistingChunks((event) => {
      try { broadcastSync(event); } catch {}
    });
  } catch (err) {
    console.error('Mirror error:', err);
    try { broadcastSync({ type: 'mirror:error', error: err.message }); } catch {}
  }
});

// GET /api/claude-code/integrations — list all hook integration targets with status
app.get('/api/claude-code/integrations', (req, res) => {
  try {
    const hookExists = HOOK_SCRIPTS.every(def =>
      existsSync(resolve(PROJECT_ROOT, 'hooks', 'claude-code', def.script))
    );
    const projects = loadHookProjects();

    // Check global settings
    const globalPath = getGlobalClaudeSettingsPath();
    const globalSettings = readClaudeSettings(globalPath);
    const globalInstalled = isHookInstalled(globalSettings);
    const globalHooks = {};
    for (const def of HOOK_SCRIPTS) {
      globalHooks[def.event] = isSpecificHookInstalled(globalSettings, def.event);
    }

    // Auto-sync: ensure all registered projects have globally-enabled hooks
    const globallyEnabled = Object.entries(globalHooks).filter(([, on]) => on).map(([ev]) => ev);
    for (const p of projects) {
      const projFile = getClaudeSettingsPath(p.path);
      let projSettings = readClaudeSettings(projFile);
      let needsWrite = false;
      for (const ev of globallyEnabled) {
        if (!isSpecificHookInstalled(projSettings, ev)) {
          projSettings = addHookToSettings(projSettings || {}, ev);
          needsWrite = true;
        }
      }
      if (needsWrite) {
        try { writeClaudeSettings(projFile, projSettings); } catch {}
      }
    }

    // Check each registered project
    const projectStatuses = projects.map(p => {
      const settingsPath = getClaudeSettingsPath(p.path);
      const settings = readClaudeSettings(settingsPath);
      const hookStatus = {};
      for (const def of HOOK_SCRIPTS) {
        hookStatus[def.event] = isSpecificHookInstalled(settings, def.event);
      }
      return {
        path: p.path,
        label: p.label || basename(p.path),
        installed: isHookInstalled(settings),
        hooks: hookStatus,
        settingsExists: settings !== null,
      };
    });

    // Check MCP registration
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const claudeJsonPath = join(home, '.claude.json');
    let mcpConnected = false;
    try {
      const cj = JSON.parse(readFileSync(claudeJsonPath, 'utf-8'));
      mcpConnected = !!(cj.mcpServers && cj.mcpServers.SynaBun);
    } catch {}

    const mcpIndexPath = resolve(PROJECT_ROOT, 'mcp-server', 'dist', 'preload.js').replace(/\\/g, '/');
    const envPath = resolve(PROJECT_ROOT, '.env').replace(/\\/g, '/');
    const cliCommand = `claude mcp add SynaBun -s user -e DOTENV_PATH="${envPath}" -- node "${mcpIndexPath}"`;

    res.json({
      ok: true,
      hookScriptExists: hookExists,
      global: { installed: globalInstalled, hooks: globalHooks, path: globalPath },
      projects: projectStatuses,
      mcp: { connected: mcpConnected, cliCommand },
      hookFeatures: loadHookFeatures(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/claude-code/integrations — enable hook for a target
// Optional `hook` param: 'SessionStart' | 'UserPromptSubmit' (omit for both)
app.post('/api/claude-code/integrations', (req, res) => {
  try {
    const { target, projectPath, label, hook } = req.body;
    // target: 'global' | 'project'

    if (target === 'global') {
      const filePath = getGlobalClaudeSettingsPath();
      let settings = readClaudeSettings(filePath) || {};
      settings = addHookToSettings(settings, hook || undefined);
      writeClaudeSettings(filePath, settings);

      // Cascade to all registered projects
      const projects = loadHookProjects();
      for (const p of projects) {
        const projFile = getClaudeSettingsPath(p.path);
        let projSettings = readClaudeSettings(projFile) || {};
        projSettings = addHookToSettings(projSettings, hook || undefined);
        writeClaudeSettings(projFile, projSettings);
      }

      return res.json({ ok: true, message: hook ? `${hook} hook enabled globally.` : 'Hooks enabled globally for all Claude Code projects.' });
    }

    if (target === 'project') {
      if (!projectPath) return res.status(400).json({ error: 'projectPath is required.' });
      const normalized = resolve(projectPath);
      if (!existsSync(normalized)) return res.status(400).json({ error: `Directory not found: ${normalized}` });

      const filePath = getClaudeSettingsPath(normalized);
      let settings = readClaudeSettings(filePath) || {};
      settings = addHookToSettings(settings, hook || undefined);
      writeClaudeSettings(filePath, settings);

      // Save to registered projects list
      const projectLabel = label || basename(normalized);
      const projects = loadHookProjects();
      if (!projects.some(p => resolve(p.path) === normalized)) {
        projects.push({ path: normalized, label: projectLabel });
        saveHookProjects(projects);
      }

      // Create default category tree for the project (parent + children)
      try { ensureProjectCategories(); } catch {}

      // Auto-create greeting config entry for the new project
      try {
        const greetingKey = projectLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const gcPath = resolve(PROJECT_ROOT, 'data', 'greeting-config.json');
        let gc = { version: 1, defaults: {}, projects: {}, global: {} };
        try { if (existsSync(gcPath)) gc = JSON.parse(readFileSync(gcPath, 'utf-8')); } catch {}
        if (!gc.projects) gc.projects = {};
        if (!gc.projects[greetingKey]) {
          gc.projects[greetingKey] = {
            label: projectLabel,
            greetingTemplate: gc.defaults?.greetingTemplate || '{time_greeting}! Working on **{project_label}** (`{branch}` branch). {date}.',
            showReminders: false,
            showLastSession: true,
            reminders: [],
          };
          writeFileSync(gcPath, JSON.stringify(gc, null, 2), 'utf-8');
        }
      } catch { /* non-critical */ }

      return res.json({ ok: true, message: `Hook enabled for ${basename(normalized)}.` });
    }

    res.status(400).json({ error: 'Invalid target. Use "global" or "project".' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/claude-code/integrations — disable hook for a target
// Optional `hook` param: 'SessionStart' | 'UserPromptSubmit' (omit for both)
app.delete('/api/claude-code/integrations', (req, res) => {
  try {
    const { target, projectPath, hook } = req.body;

    if (target === 'global') {
      const filePath = getGlobalClaudeSettingsPath();
      let settings = readClaudeSettings(filePath);
      if (!settings) return res.json({ ok: true, message: 'No global settings found.' });
      settings = removeHookFromSettings(settings, hook || undefined);
      writeClaudeSettings(filePath, settings);

      // Cascade to all registered projects
      const projects = loadHookProjects();
      for (const p of projects) {
        const projFile = getClaudeSettingsPath(p.path);
        let projSettings = readClaudeSettings(projFile);
        if (projSettings) {
          projSettings = removeHookFromSettings(projSettings, hook || undefined);
          writeClaudeSettings(projFile, projSettings);
        }
      }

      return res.json({ ok: true, message: hook ? `${hook} hook removed globally.` : 'Hooks removed globally.' });
    }

    if (target === 'project') {
      if (!projectPath) return res.status(400).json({ error: 'projectPath is required.' });
      const normalized = resolve(projectPath);
      const filePath = getClaudeSettingsPath(normalized);
      let settings = readClaudeSettings(filePath);
      if (!settings) return res.json({ ok: true, message: 'No settings file found.' });
      settings = removeHookFromSettings(settings, hook || undefined);
      writeClaudeSettings(filePath, settings);
      return res.json({ ok: true, message: `Hook removed from ${basename(normalized)}.` });
    }

    res.status(400).json({ error: 'Invalid target. Use "global" or "project".' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/claude-code/projects/:index — remove a project from tracked list
app.delete('/api/claude-code/projects/:index', (req, res) => {
  try {
    const idx = parseInt(req.params.index, 10);
    const projects = loadHookProjects();
    if (idx < 0 || idx >= projects.length) return res.status(400).json({ error: 'Invalid index.' });
    projects.splice(idx, 1);
    saveHookProjects(projects);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Hook Features (feature flags read by hook scripts) ──

const HOOK_FEATURES_PATH = resolve(PROJECT_ROOT, 'data', 'hook-features.json');

function loadHookFeatures() {
  try {
    if (!existsSync(HOOK_FEATURES_PATH)) return {};
    return JSON.parse(readFileSync(HOOK_FEATURES_PATH, 'utf-8'));
  } catch { return {}; }
}

function saveHookFeatures(features) {
  const dir = dirname(HOOK_FEATURES_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(HOOK_FEATURES_PATH, JSON.stringify(features, null, 2), 'utf-8');
}

// GET /api/claude-code/hook-features — read all feature flags
app.get('/api/claude-code/hook-features', (req, res) => {
  try {
    res.json({ ok: true, features: loadHookFeatures() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/claude-code/hook-features — toggle a single feature
app.put('/api/claude-code/hook-features', (req, res) => {
  try {
    const { feature, enabled } = req.body;
    if (!feature || typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'feature (string) and enabled (boolean) are required.' });
    }
    const features = loadHookFeatures();
    features[feature] = enabled;
    saveHookFeatures(features);
    res.json({ ok: true, features });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/claude-code/hook-features/config — set any config value (number, string, boolean)
app.put('/api/claude-code/hook-features/config', (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key || typeof key !== 'string') {
      return res.status(400).json({ error: 'key (string) is required.' });
    }
    if (value === undefined) {
      return res.status(400).json({ error: 'value is required.' });
    }
    const features = loadHookFeatures();
    features[key] = value;
    saveHookFeatures(features);
    res.json({ ok: true, features });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Tool Permissions (fine-grained control over which SynaBun tools are auto-allowed) ──

// GET /api/claude-code/tool-categories — return categorized tool definitions for UI rendering
app.get('/api/claude-code/tool-categories', (req, res) => {
  res.json({ ok: true, categories: SYNABUN_TOOL_CATEGORIES });
});

// GET /api/claude-code/tool-permissions — current permission state for all SynaBun tools
app.get('/api/claude-code/tool-permissions', (req, res) => {
  try {
    const globalPath = getGlobalClaudeSettingsPath();
    const settings = readClaudeSettings(globalPath) || {};
    const allowed = new Set(settings.permissions?.allow || []);

    const tools = {};
    for (const cat of SYNABUN_TOOL_CATEGORIES) {
      for (const t of cat.tools) {
        tools[t.key] = allowed.has(t.key);
      }
    }
    res.json({ ok: true, tools });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/claude-code/tool-permissions — toggle individual tool or category group
app.put('/api/claude-code/tool-permissions', (req, res) => {
  try {
    const { tool, category, enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled (boolean) is required.' });
    }
    if (!tool && !category) {
      return res.status(400).json({ error: 'Provide tool (string) or category (string).' });
    }

    // Resolve which tool keys to toggle
    let keys = [];
    if (category) {
      const cat = SYNABUN_TOOL_CATEGORIES.find(c => c.id === category);
      if (!cat) return res.status(400).json({ error: `Unknown category: ${category}` });
      keys = cat.tools.map(t => t.key);
    } else {
      keys = [tool];
    }

    // Apply to global settings
    const globalPath = getGlobalClaudeSettingsPath();
    let settings = readClaudeSettings(globalPath) || {};
    if (!settings.permissions) settings.permissions = {};
    if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];

    const allowSet = new Set(settings.permissions.allow);
    for (const k of keys) {
      if (enabled) allowSet.add(k);
      else allowSet.delete(k);
    }
    settings.permissions.allow = [...allowSet];
    writeClaudeSettings(globalPath, settings);

    // Cascade to registered projects
    const projects = loadHookProjects();
    for (const p of projects) {
      const projPath = getClaudeSettingsPath(p.path);
      let projSettings = readClaudeSettings(projPath);
      if (!projSettings) continue;
      if (!projSettings.permissions) projSettings.permissions = {};
      if (!Array.isArray(projSettings.permissions.allow)) projSettings.permissions.allow = [];

      const projSet = new Set(projSettings.permissions.allow);
      for (const k of keys) {
        if (enabled) projSet.add(k);
        else projSet.delete(k);
      }
      projSettings.permissions.allow = [...projSet];
      writeClaudeSettings(projPath, projSettings);
    }

    // Return updated state
    const updatedAllowed = new Set(settings.permissions.allow);
    const tools = {};
    for (const cat of SYNABUN_TOOL_CATEGORIES) {
      for (const t of cat.tools) {
        tools[t.key] = updatedAllowed.has(t.key);
      }
    }
    res.json({ ok: true, tools });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Greeting Config (read/write greeting-config.json for the greeting hook) ──

const GREETING_CONFIG_PATH = resolve(PROJECT_ROOT, 'data', 'greeting-config.json');

function loadGreetingConfig() {
  try {
    if (!existsSync(GREETING_CONFIG_PATH)) return { version: 1, defaults: {}, projects: {}, global: {} };
    return JSON.parse(readFileSync(GREETING_CONFIG_PATH, 'utf-8'));
  } catch { return { version: 1, defaults: {}, projects: {}, global: {} }; }
}

// GET /api/greeting/config — read the full greeting configuration
app.get('/api/greeting/config', (req, res) => {
  try {
    res.json({ ok: true, config: loadGreetingConfig() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PUT /api/greeting/config/:project — update a project's greeting config
app.put('/api/greeting/config/:project', (req, res) => {
  try {
    const { project } = req.params;
    const { greetingTemplate, showReminders, showLastSession, reminders, label } = req.body;
    const config = loadGreetingConfig();

    const target = project === 'global'
      ? (config.global || (config.global = {}))
      : (config.projects[project] || (config.projects[project] = {}));

    if (greetingTemplate !== undefined) target.greetingTemplate = greetingTemplate;
    if (showReminders !== undefined) target.showReminders = showReminders;
    if (showLastSession !== undefined) target.showLastSession = showLastSession;
    if (reminders !== undefined) target.reminders = reminders;
    if (label !== undefined) target.label = label;

    const dir = dirname(GREETING_CONFIG_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(GREETING_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/claude-code/ruleset — Return the SynaBun CLAUDE.md memory ruleset for copy/paste
// Supports ?format=claude (default) | cursor | generic
app.get('/api/claude-code/ruleset', (req, res) => {
  try {
    const claudeMdPath = resolve(PROJECT_ROOT, 'CLAUDE.md');
    const templatePath = resolve(__dirname, 'templates', 'CLAUDE-template.md');
    const sourcePath = existsSync(claudeMdPath) ? claudeMdPath : templatePath;
    if (!existsSync(sourcePath)) {
      return res.status(404).json({ error: 'CLAUDE.md template not found' });
    }
    const content = readFileSync(sourcePath, 'utf-8');
    const format = (req.query.format || 'claude').toLowerCase();

    // Section markers in CLAUDE.md
    const MARKERS = {
      claude:       { start: '## Memory Ruleset', end: '## Condensed Rulesets' },
      cursor:       { start: '### Cursor',  end: '### Generic' },
      generic:      { start: '### Generic', end: '### Gemini' },
      gemini:       { start: '### Gemini',  end: '### Codex' },
      codex:        { start: '### Codex',   end: '\n---' },
      coexistence:  { start: '## Coexistence with Other Tools', end: '\n---\n\n## Condensed' },
    };

    const marker = MARKERS[format];
    if (!marker) {
      return res.status(400).json({ error: `Invalid format: ${format}. Use claude, cursor, generic, gemini, codex, or coexistence.` });
    }

    const startIdx = content.indexOf(marker.start);
    if (startIdx === -1) {
      return res.status(404).json({ error: `Section "${marker.start}" not found in CLAUDE.md` });
    }

    // Extract content between start marker and end marker (or EOF)
    const contentAfterStart = marker.start === '\n---'
      ? content.indexOf(marker.end, startIdx)
      : content.indexOf(marker.end, startIdx + marker.start.length);
    const ruleset = contentAfterStart !== -1
      ? content.substring(startIdx, contentAfterStart).trim()
      : content.substring(startIdx).trim();

    // Strip the section header line — leave only the content below it
    let output;
    if (format === 'claude') {
      output = ruleset;
    } else if (format === 'coexistence') {
      // Remove the ## heading, keep the body
      output = ruleset.replace(/^## Coexistence with Other Tools\s*\n?/, '').replace(/\n?---\s*$/, '').trim();
    } else {
      // Remove the marker heading line, return just the content
      output = ruleset.replace(/^### (Cursor|Generic|Gemini|Codex)\s*\n?/, '').replace(/^```\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
    }

    res.json({ ok: true, ruleset: output, format });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/claude-code/mcp — Check if SynaBun MCP is registered in Claude
app.get('/api/claude-code/mcp', (req, res) => {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const claudeJsonPath = join(home, '.claude.json');
    if (!existsSync(claudeJsonPath)) return res.json({ ok: true, connected: false });
    const data = JSON.parse(readFileSync(claudeJsonPath, 'utf-8'));
    const connected = !!(data.mcpServers && data.mcpServers.SynaBun);
    res.json({ ok: true, connected });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/claude-code/mcp — Register SynaBun MCP in Claude's ~/.claude.json
app.post('/api/claude-code/mcp', (req, res) => {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const claudeJsonPath = join(home, '.claude.json');
    const mcpIndexPath = resolve(PROJECT_ROOT, 'mcp-server', 'dist', 'preload.js').replace(/\\/g, '/');
    const envPath = resolve(PROJECT_ROOT, '.env').replace(/\\/g, '/');

    let data = {};
    try { data = JSON.parse(readFileSync(claudeJsonPath, 'utf-8')); } catch {}
    if (!data.mcpServers) data.mcpServers = {};
    data.mcpServers.SynaBun = {
      type: 'stdio',
      command: 'node',
      args: [mcpIndexPath],
      env: { DOTENV_PATH: envPath },
    };
    writeFileSync(claudeJsonPath, JSON.stringify(data, null, 2), 'utf-8');

    // Also inject tool permissions into global settings so tools work without prompts
    const globalSettingsPath = getGlobalClaudeSettingsPath();
    let globalSettings = readClaudeSettings(globalSettingsPath) || {};
    ensureSynaBunPermissions(globalSettings);
    writeClaudeSettings(globalSettingsPath, globalSettings);

    res.json({ ok: true, message: 'SynaBun MCP registered. Restart Claude Code to connect.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/claude-code/mcp — Remove SynaBun MCP from Claude's ~/.claude.json
app.delete('/api/claude-code/mcp', (req, res) => {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const claudeJsonPath = join(home, '.claude.json');
    if (!existsSync(claudeJsonPath)) return res.json({ ok: true });
    const data = JSON.parse(readFileSync(claudeJsonPath, 'utf-8'));
    if (data.mcpServers && data.mcpServers.SynaBun) {
      delete data.mcpServers.SynaBun;
      if (Object.keys(data.mcpServers).length === 0) delete data.mcpServers;
      writeFileSync(claudeJsonPath, JSON.stringify(data, null, 2), 'utf-8');
    }
    res.json({ ok: true, message: 'SynaBun MCP removed from Claude.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════
// Multi-Provider MCP Setup (Gemini, Codex)
// ═══════════════════════════════════════════

// ── Minimal TOML helpers (for Codex config.toml) ──

function tomlHasSection(content, section) {
  return new RegExp(`^\\[${section.replace(/\./g, '\\.')}\\]`, 'm').test(content);
}

function tomlUpsertSection(content, section, kvPairs) {
  const lines = Object.entries(kvPairs).map(([k, v]) => `${k} = ${JSON.stringify(v)}`);
  const block = `[${section}]\n${lines.join('\n')}`;
  const re = new RegExp(`^\\[${section.replace(/\./g, '\\.')}\\][\\s\\S]*?(?=\\n\\[|$)`, 'm');
  if (re.test(content)) return content.replace(re, block);
  return (content.trim() ? content.trim() + '\n\n' : '') + block + '\n';
}

function tomlRemoveSection(content, section) {
  const re = new RegExp(`\\n?^\\[${section.replace(/\./g, '\\.')}\\][\\s\\S]*?(?=\\n\\[|$)`, 'm');
  return content.replace(re, '').trim() + (content.trim() ? '\n' : '');
}

// ── Shared MCP path helpers ──

function getMcpPaths() {
  const mcpIndexPath = resolve(PROJECT_ROOT, 'mcp-server', 'dist', 'preload.js').replace(/\\/g, '/');
  const envPath = resolve(PROJECT_ROOT, '.env').replace(/\\/g, '/');
  return { mcpIndexPath, envPath };
}

function getHomePath() {
  return process.env.USERPROFILE || process.env.HOME || '';
}

// ── Gemini MCP endpoints ──

app.get('/api/setup/gemini/mcp', (req, res) => {
  try {
    const settingsPath = join(getHomePath(), '.gemini', 'settings.json');
    if (!existsSync(settingsPath)) return res.json({ ok: true, connected: false });
    const data = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const connected = !!(data.mcpServers && data.mcpServers.SynaBun);
    res.json({ ok: true, connected });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/setup/gemini/mcp', (req, res) => {
  try {
    const dir = join(getHomePath(), '.gemini');
    const settingsPath = join(dir, 'settings.json');
    const { mcpIndexPath, envPath } = getMcpPaths();
    mkdirSync(dir, { recursive: true });
    let data = {};
    try { data = JSON.parse(readFileSync(settingsPath, 'utf-8')); } catch {}
    if (!data.mcpServers) data.mcpServers = {};
    data.mcpServers.SynaBun = {
      command: 'node',
      args: [mcpIndexPath],
      env: { DOTENV_PATH: envPath },
    };
    writeFileSync(settingsPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    res.json({ ok: true, message: 'SynaBun MCP registered in Gemini CLI. Restart Gemini to connect.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/setup/gemini/mcp', (req, res) => {
  try {
    const settingsPath = join(getHomePath(), '.gemini', 'settings.json');
    if (!existsSync(settingsPath)) return res.json({ ok: true });
    const data = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    if (data.mcpServers && data.mcpServers.SynaBun) {
      delete data.mcpServers.SynaBun;
      if (Object.keys(data.mcpServers).length === 0) delete data.mcpServers;
      writeFileSync(settingsPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    }
    res.json({ ok: true, message: 'SynaBun MCP removed from Gemini CLI.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Codex MCP endpoints ──

app.get('/api/setup/codex/mcp', (req, res) => {
  try {
    const configPath = join(getHomePath(), '.codex', 'config.toml');
    if (!existsSync(configPath)) return res.json({ ok: true, connected: false });
    const content = readFileSync(configPath, 'utf-8');
    const connected = tomlHasSection(content, 'mcp_servers.SynaBun');
    res.json({ ok: true, connected });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/setup/codex/mcp', (req, res) => {
  try {
    const dir = join(getHomePath(), '.codex');
    const configPath = join(dir, 'config.toml');
    const { mcpIndexPath, envPath } = getMcpPaths();
    mkdirSync(dir, { recursive: true });
    let content = '';
    try { content = readFileSync(configPath, 'utf-8'); } catch {}
    content = tomlUpsertSection(content, 'mcp_servers.SynaBun', {
      command: 'node',
      args: [mcpIndexPath],
      env: { DOTENV_PATH: envPath },
    });
    writeFileSync(configPath, content, 'utf-8');
    res.json({ ok: true, message: 'SynaBun MCP registered in Codex CLI. Restart Codex to connect.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/setup/codex/mcp', (req, res) => {
  try {
    const configPath = join(getHomePath(), '.codex', 'config.toml');
    if (!existsSync(configPath)) return res.json({ ok: true });
    let content = readFileSync(configPath, 'utf-8');
    content = tomlRemoveSection(content, 'mcp_servers.SynaBun');
    writeFileSync(configPath, content, 'utf-8');
    res.json({ ok: true, message: 'SynaBun MCP removed from Codex CLI.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Combined setup status ──

app.get('/api/setup/status', (req, res) => {
  try {
    const home = getHomePath();
    const { mcpIndexPath, envPath } = getMcpPaths();

    // Claude
    let claude = { connected: false };
    try {
      const cj = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf-8'));
      claude.connected = !!(cj.mcpServers && cj.mcpServers.SynaBun);
    } catch {}
    claude.cliCommand = `claude mcp add SynaBun -s user -e DOTENV_PATH="${envPath}" -- node "${mcpIndexPath}"`;

    // Gemini
    let gemini = { connected: false };
    try {
      const gj = JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf-8'));
      gemini.connected = !!(gj.mcpServers && gj.mcpServers.SynaBun);
    } catch {}

    // Codex
    let codex = { connected: false };
    try {
      const ct = readFileSync(join(home, '.codex', 'config.toml'), 'utf-8');
      codex.connected = tomlHasSection(ct, 'mcp_servers.SynaBun');
    } catch {}
    codex.cliCommand = `codex --full-auto mcp add -- node "${mcpIndexPath}"`;

    res.json({ ok: true, claude, gemini, codex, paths: { mcpIndexPath, envPath } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════
// Claude Code Skill Installation
// ═══════════════════════════════════════════

const SKILLS_SOURCE_DIR = resolve(PROJECT_ROOT, 'skills');

/** Dirent.isDirectory() returns false for symlinks — check both */
function isDirEntry(entry) {
  return entry.isDirectory() || entry.isSymbolicLink();
}

function getGlobalSkillsDir() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return join(home, '.claude', 'skills');
}

function parseSkillFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { name: null, description: null };
  const fm = match[1];
  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const descMatch = fm.match(/^description:\s*>\s*\r?\n([\s\S]*?)(?=\r?\n\w|\r?\n---)/);
  const descSimple = fm.match(/^description:\s*(.+)$/m);
  return {
    name: nameMatch ? nameMatch[1].trim() : null,
    description: descMatch ? descMatch[1].replace(/\r?\n\s*/g, ' ').trim() : (descSimple ? descSimple[1].trim() : null),
  };
}

function listAvailableSkills() {
  const skills = [];
  const seen = new Set();

  // 1. Bundled skills (PROJECT_ROOT/skills/)
  if (existsSync(SKILLS_SOURCE_DIR)) {
    for (const entry of readdirSync(SKILLS_SOURCE_DIR, { withFileTypes: true })) {
      if (!isDirEntry(entry)) continue;
      const skillFile = join(SKILLS_SOURCE_DIR, entry.name, 'SKILL.md');
      if (!existsSync(skillFile)) continue;
      const content = readFileSync(skillFile, 'utf-8');
      const { name, description } = parseSkillFrontmatter(content);
      const installedPath = join(getGlobalSkillsDir(), entry.name, 'SKILL.md');
      skills.push({ dirName: entry.name, name: name || entry.name, description: description || '', installed: existsSync(installedPath), sourcePath: skillFile, installedPath });
      seen.add(entry.name);
    }
  }

  // 2. Global skills (~/.claude/skills/) — only those not already in bundled
  const globalDir = getGlobalSkillsDir();
  if (existsSync(globalDir)) {
    try {
      for (const entry of readdirSync(globalDir, { withFileTypes: true })) {
        if (!isDirEntry(entry) || seen.has(entry.name)) continue;
        const skillFile = join(globalDir, entry.name, 'SKILL.md');
        if (!existsSync(skillFile)) continue;
        const content = readFileSync(skillFile, 'utf-8');
        const { name, description } = parseSkillFrontmatter(content);
        skills.push({ dirName: entry.name, name: name || entry.name, description: description || '', installed: true, sourcePath: skillFile, installedPath: skillFile });
        seen.add(entry.name);
      }
    } catch {}
  }

  return skills;
}

// GET /api/claude-code/skills — list available skills and their install status
app.get('/api/claude-code/skills', (req, res) => {
  try {
    res.json({ ok: true, skills: listAvailableSkills() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/claude-code/skills — install a skill globally (copies entire directory)
app.post('/api/claude-code/skills', (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required.' });

    const sourceDir = join(SKILLS_SOURCE_DIR, name);
    const sourceFile = join(sourceDir, 'SKILL.md');
    if (!existsSync(sourceFile)) return res.status(404).json({ error: `Skill "${name}" not found in skills/.` });

    const targetDir = join(getGlobalSkillsDir(), name);
    // Remove old install if present, then copy entire directory
    if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
    cpSync(sourceDir, targetDir, { recursive: true });

    res.json({ ok: true, message: `Skill "${name}" installed. Restart Claude Code to use /${name}.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/claude-code/skills — uninstall a skill (removes entire directory)
app.delete('/api/claude-code/skills', (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required.' });

    const targetDir = join(getGlobalSkillsDir(), name);
    if (!existsSync(join(targetDir, 'SKILL.md'))) return res.json({ ok: true, message: `Skill "${name}" is not installed.` });

    rmSync(targetDir, { recursive: true, force: true });

    res.json({ ok: true, message: `Skill "${name}" uninstalled.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════
// Skills Studio API
// ═══════════════════════════════════════════

function getGlobalAgentsDir() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return join(home, '.claude', 'agents');
}

function encodeArtifactId(id) {
  return Buffer.from(id).toString('base64url');
}
function decodeArtifactId(encoded) {
  return Buffer.from(encoded, 'base64url').toString('utf-8');
}

/** Resolve the actual .md file path from a decoded artifact ID.
 *  Skills use directory IDs (skill:C:\...\ads) → need SKILL.md appended.
 *  Commands/agents already point to the .md file. */
function resolveArtifactFile(decodedId) {
  const [type, ...rest] = decodedId.split(':');
  const rawPath = rest.join(':');
  if (type === 'skill') {
    return { type, dirPath: rawPath, filePath: join(rawPath, 'SKILL.md') };
  }
  return { type, dirPath: dirname(rawPath), filePath: rawPath };
}

const ICON_EXTENSIONS = ['.png', '.svg', '.jpg', '.jpeg', '.webp'];

/** Find the icon file for an artifact, if one exists. */
function resolveArtifactIcon(decodedId) {
  const { type, dirPath, filePath } = resolveArtifactFile(decodedId);
  if (type === 'skill') {
    for (const ext of ICON_EXTENSIONS) {
      const p = join(dirPath, `icon${ext}`);
      if (existsSync(p)) return p;
    }
  } else {
    const name = basename(filePath, '.md');
    const dir = dirname(filePath);
    for (const ext of ICON_EXTENSIONS) {
      const p = join(dir, `${name}.icon${ext}`);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** Parse full YAML frontmatter from a skill/command/agent .md file */
function parseFullFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const fm = match[1];
  const result = {};
  const lines = fm.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Skip blank lines
    if (!line.trim()) { i++; continue; }
    // Key-value pair
    const kv = line.match(/^(\S[\w-]*):\s*(.*)/);
    if (!kv) { i++; continue; }
    const key = kv[1];
    let val = kv[2].trim();
    // Block scalar (description: >)
    if (val === '>' || val === '|') {
      const blockLines = [];
      i++;
      while (i < lines.length && (lines[i].startsWith('  ') || lines[i].trim() === '')) {
        blockLines.push(lines[i].replace(/^  /, ''));
        i++;
      }
      result[key] = blockLines.join('\n').trim();
      continue;
    }
    // YAML list (key with no value, followed by - items)
    if (val === '' && i + 1 < lines.length && lines[i + 1].match(/^\s+-\s/)) {
      const items = [];
      i++;
      while (i < lines.length && lines[i].match(/^\s+-\s/)) {
        items.push(lines[i].replace(/^\s+-\s*/, '').trim());
        i++;
      }
      result[key] = items;
      continue;
    }
    // Boolean
    if (val === 'true') { result[key] = true; i++; continue; }
    if (val === 'false') { result[key] = false; i++; continue; }
    // Number
    if (/^\d+$/.test(val)) { result[key] = parseInt(val, 10); i++; continue; }
    // Quoted string
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      result[key] = val.slice(1, -1);
      i++; continue;
    }
    // Plain string
    result[key] = val;
    i++;
  }
  return result;
}

/** Get the markdown body (after frontmatter) */
function getFrontmatterBody(content) {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)/);
  return match ? match[1] : content;
}

/** Build a recursive file tree for a directory */
function buildSubFileTree(dir, basePath) {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const tree = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const fullPath = join(dir, entry.name);
    const relPath = basePath ? `${basePath}/${entry.name}` : entry.name;
    if (isDirEntry(entry)) {
      tree.push({ name: entry.name, path: relPath, type: 'dir', children: buildSubFileTree(fullPath, relPath) });
    } else {
      const stat = statSync(fullPath);
      tree.push({ name: entry.name, path: relPath, type: 'file', size: stat.size });
    }
  }
  return tree.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** Discover all Claude Code artifacts from all known locations */
function discoverAllArtifacts() {
  const artifacts = [];

  // 1. Global skills (~/.claude/skills/)
  const globalSkillsDir = getGlobalSkillsDir();
  if (existsSync(globalSkillsDir)) {
    for (const entry of readdirSync(globalSkillsDir, { withFileTypes: true })) {
      if (!isDirEntry(entry)) continue;
      const skillFile = join(globalSkillsDir, entry.name, 'SKILL.md');
      if (!existsSync(skillFile)) continue;
      const content = readFileSync(skillFile, 'utf-8');
      const frontmatter = parseFullFrontmatter(content);
      const dir = join(globalSkillsDir, entry.name);
      // Check if this was installed from bundled
      const bundledSource = join(SKILLS_SOURCE_DIR, entry.name, 'SKILL.md');
      const isBundledInstall = existsSync(bundledSource);
      artifacts.push({
        id: `skill:${dir}`,
        type: 'skill',
        scope: isBundledInstall ? 'bundled' : 'global',
        name: frontmatter.name || entry.name,
        dirName: entry.name,
        filePath: skillFile,
        dirPath: dir,
        description: frontmatter.description || '',
        frontmatter,
        hasIcon: ICON_EXTENSIONS.some(ext => existsSync(join(dir, `icon${ext}`))),
        subFiles: buildSubFileTree(dir, '').filter(f => f.name !== 'SKILL.md' && !f.name.match(/^icon\.(png|svg|jpe?g|webp)$/i)),
        bundledSource: isBundledInstall ? bundledSource : null,
        installed: isBundledInstall ? true : undefined,
      });
    }
  }

  // 2. Global agents (~/.claude/agents/)
  const globalAgentsDir = getGlobalAgentsDir();
  if (existsSync(globalAgentsDir)) {
    for (const entry of readdirSync(globalAgentsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const filePath = join(globalAgentsDir, entry.name);
      const content = readFileSync(filePath, 'utf-8');
      const frontmatter = parseFullFrontmatter(content);
      artifacts.push({
        id: `agent:${filePath}`,
        type: 'agent',
        scope: 'global',
        name: frontmatter.name || entry.name.replace(/\.md$/, ''),
        dirName: entry.name.replace(/\.md$/, ''),
        filePath,
        dirPath: globalAgentsDir,
        description: frontmatter.description || '',
        frontmatter,
        hasIcon: ICON_EXTENSIONS.some(ext => existsSync(join(globalAgentsDir, `${entry.name.replace(/\.md$/, '')}.icon${ext}`))),
        subFiles: [],
      });
    }
  }

  // 3. Project-scoped commands and agents
  const projects = loadHookProjects();
  for (const proj of projects) {
    const projPath = proj.path;
    const projLabel = proj.label || basename(projPath);

    // Commands
    const cmdDir = join(projPath, '.claude', 'commands');
    if (existsSync(cmdDir)) {
      for (const entry of readdirSync(cmdDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const filePath = join(cmdDir, entry.name);
        const content = readFileSync(filePath, 'utf-8');
        const frontmatter = parseFullFrontmatter(content);
        artifacts.push({
          id: `command:${filePath}`,
          type: 'command',
          scope: 'project',
          scopeLabel: projLabel,
          scopePath: projPath,
          name: entry.name.replace(/\.md$/, ''),
          dirName: entry.name.replace(/\.md$/, ''),
          filePath,
          dirPath: cmdDir,
          description: frontmatter.description || '',
          frontmatter,
          hasIcon: ICON_EXTENSIONS.some(ext => existsSync(join(cmdDir, `${entry.name.replace(/\.md$/, '')}.icon${ext}`))),
          subFiles: [],
        });
      }
    }

    // Project agents
    const agentDir = join(projPath, '.claude', 'agents');
    if (existsSync(agentDir)) {
      for (const entry of readdirSync(agentDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const filePath = join(agentDir, entry.name);
        const content = readFileSync(filePath, 'utf-8');
        const frontmatter = parseFullFrontmatter(content);
        artifacts.push({
          id: `agent:${filePath}`,
          type: 'agent',
          scope: 'project',
          scopeLabel: projLabel,
          scopePath: projPath,
          name: frontmatter.name || entry.name.replace(/\.md$/, ''),
          dirName: entry.name.replace(/\.md$/, ''),
          filePath,
          dirPath: agentDir,
          description: frontmatter.description || '',
          frontmatter,
          hasIcon: ICON_EXTENSIONS.some(ext => existsSync(join(agentDir, `${entry.name.replace(/\.md$/, '')}.icon${ext}`))),
          subFiles: [],
        });
      }
    }

    // Project skills
    const projSkillsDir = join(projPath, '.claude', 'skills');
    if (existsSync(projSkillsDir)) {
      for (const entry of readdirSync(projSkillsDir, { withFileTypes: true })) {
        if (!isDirEntry(entry)) continue;
        const skillFile = join(projSkillsDir, entry.name, 'SKILL.md');
        if (!existsSync(skillFile)) continue;
        const content = readFileSync(skillFile, 'utf-8');
        const frontmatter = parseFullFrontmatter(content);
        const dir = join(projSkillsDir, entry.name);
        artifacts.push({
          id: `skill:${dir}`,
          type: 'skill',
          scope: 'project',
          scopeLabel: projLabel,
          scopePath: projPath,
          name: frontmatter.name || entry.name,
          dirName: entry.name,
          filePath: skillFile,
          dirPath: dir,
          description: frontmatter.description || '',
          frontmatter,
          hasIcon: ICON_EXTENSIONS.some(ext => existsSync(join(dir, `icon${ext}`))),
          subFiles: buildSubFileTree(dir, '').filter(f => f.name !== 'SKILL.md' && !f.name.match(/^icon\.(png|svg|jpe?g|webp)$/i)),
        });
      }
    }
  }

  // 4. Bundled SynaBun skills (not yet installed)
  if (existsSync(SKILLS_SOURCE_DIR)) {
    for (const entry of readdirSync(SKILLS_SOURCE_DIR, { withFileTypes: true })) {
      if (!isDirEntry(entry)) continue;
      const skillFile = join(SKILLS_SOURCE_DIR, entry.name, 'SKILL.md');
      if (!existsSync(skillFile)) continue;
      // Skip if already discovered as a global install
      const installedPath = join(globalSkillsDir, entry.name, 'SKILL.md');
      if (existsSync(installedPath)) continue; // already in global skills
      const content = readFileSync(skillFile, 'utf-8');
      const frontmatter = parseFullFrontmatter(content);
      const dir = join(SKILLS_SOURCE_DIR, entry.name);
      artifacts.push({
        id: `skill:${dir}`,
        type: 'skill',
        scope: 'bundled',
        name: frontmatter.name || entry.name,
        dirName: entry.name,
        filePath: skillFile,
        dirPath: dir,
        description: frontmatter.description || '',
        frontmatter,
        installed: false,
        hasIcon: ICON_EXTENSIONS.some(ext => existsSync(join(dir, `icon${ext}`))),
        subFiles: buildSubFileTree(dir, '').filter(f => f.name !== 'SKILL.md' && !f.name.match(/^icon\.(png|svg|jpe?g|webp)$/i)),
      });
    }
  }

  return artifacts;
}

// GET /api/skills-studio/library
app.get('/api/skills-studio/library', (req, res) => {
  try {
    const artifacts = discoverAllArtifacts();
    const projects = loadHookProjects().map(p => ({ path: p.path, label: p.label || basename(p.path) }));
    res.json({ ok: true, artifacts, projects });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/skills-studio/artifact/:id — full content + file tree
app.get('/api/skills-studio/artifact/:id', (req, res) => {
  try {
    const id = decodeArtifactId(req.params.id);
    const { type, dirPath, filePath } = resolveArtifactFile(id);
    if (!existsSync(filePath)) return res.status(404).json({ error: 'Artifact not found.' });
    const content = readFileSync(filePath, 'utf-8');
    const frontmatter = parseFullFrontmatter(content);
    const body = getFrontmatterBody(content);
    // For skills (directory-based), include sub-file tree
    let subFiles = [];
    if (type === 'skill') {
      subFiles = buildSubFileTree(dirPath, '').filter(f => f.name !== 'SKILL.md');
    }
    res.json({ ok: true, frontmatter, body, rawContent: content, subFiles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/skills-studio/artifact/:id/file — read a sub-file
app.get('/api/skills-studio/artifact/:id/file', (req, res) => {
  try {
    const id = decodeArtifactId(req.params.id);
    const { dirPath: dir } = resolveArtifactFile(id);
    const subPath = req.query.path;
    if (!subPath) return res.status(400).json({ error: 'path query param required.' });
    const fullPath = join(dir, subPath);
    // Security: ensure the path doesn't escape the directory
    if (!resolve(fullPath).startsWith(resolve(dir))) {
      return res.status(403).json({ error: 'Path traversal not allowed.' });
    }
    if (!existsSync(fullPath)) return res.status(404).json({ error: 'File not found.' });
    const content = readFileSync(fullPath, 'utf-8');
    res.json({ ok: true, content, path: subPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/skills-studio/artifact/:id/icon — serve the custom icon
app.get('/api/skills-studio/artifact/:id/icon', (req, res) => {
  try {
    const id = decodeArtifactId(req.params.id);
    const iconPath = resolveArtifactIcon(id);
    if (!iconPath) return res.status(404).json({ error: 'No icon found.' });
    const ext = extname(iconPath).toLowerCase();
    const mimeMap = { '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
    res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(readFileSync(iconPath));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/skills-studio/artifact/:id/icon — upload a custom icon
app.post('/api/skills-studio/artifact/:id/icon',
  express.raw({ type: ['image/png', 'image/svg+xml', 'image/jpeg', 'image/webp'], limit: '2mb' }),
  (req, res) => {
    try {
      const id = decodeArtifactId(req.params.id);
      const { type, dirPath, filePath } = resolveArtifactFile(id);
      if (!existsSync(filePath)) return res.status(404).json({ error: 'Artifact not found.' });
      if (!req.body || req.body.length === 0) return res.status(400).json({ error: 'No image data received.' });
      const contentType = req.headers['content-type'] || 'image/png';
      const extMap = { 'image/png': '.png', 'image/svg+xml': '.svg', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
      const ext = extMap[contentType] || '.png';
      // Remove any existing icon files first
      if (type === 'skill') {
        for (const e of ICON_EXTENSIONS) { const old = join(dirPath, `icon${e}`); if (existsSync(old)) unlinkSync(old); }
        writeFileSync(join(dirPath, `icon${ext}`), req.body);
      } else {
        const name = basename(filePath, '.md');
        const dir = dirname(filePath);
        for (const e of ICON_EXTENSIONS) { const old = join(dir, `${name}.icon${e}`); if (existsSync(old)) unlinkSync(old); }
        writeFileSync(join(dir, `${name}.icon${ext}`), req.body);
      }
      res.json({ ok: true, hasIcon: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// DELETE /api/skills-studio/artifact/:id/icon — remove custom icon
app.delete('/api/skills-studio/artifact/:id/icon', (req, res) => {
  try {
    const id = decodeArtifactId(req.params.id);
    const { type, dirPath, filePath } = resolveArtifactFile(id);
    if (!existsSync(filePath)) return res.status(404).json({ error: 'Artifact not found.' });
    if (type === 'skill') {
      for (const ext of ICON_EXTENSIONS) { const p = join(dirPath, `icon${ext}`); if (existsSync(p)) unlinkSync(p); }
    } else {
      const name = basename(filePath, '.md');
      const dir = dirname(filePath);
      for (const ext of ICON_EXTENSIONS) { const p = join(dir, `${name}.icon${ext}`); if (existsSync(p)) unlinkSync(p); }
    }
    res.json({ ok: true, hasIcon: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/skills-studio/artifact/:id — save frontmatter + body
app.put('/api/skills-studio/artifact/:id', (req, res) => {
  try {
    const id = decodeArtifactId(req.params.id);
    const { filePath } = resolveArtifactFile(id);
    if (!existsSync(filePath)) return res.status(404).json({ error: 'Artifact not found.' });
    const { rawContent } = req.body;
    if (typeof rawContent !== 'string') return res.status(400).json({ error: 'rawContent is required.' });
    writeFileSync(filePath, rawContent, 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/skills-studio/artifact/:id/file — save a sub-file
app.put('/api/skills-studio/artifact/:id/file', (req, res) => {
  try {
    const id = decodeArtifactId(req.params.id);
    const { dirPath: dir } = resolveArtifactFile(id);
    const { path: subPath, content } = req.body;
    if (!subPath || typeof content !== 'string') return res.status(400).json({ error: 'path and content required.' });
    const fullPath = join(dir, subPath);
    if (!resolve(fullPath).startsWith(resolve(dir))) {
      return res.status(403).json({ error: 'Path traversal not allowed.' });
    }
    const parentDir = dirname(fullPath);
    if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
    writeFileSync(fullPath, content, 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/skills-studio/artifact/:id/file — create new sub-file or directory
app.post('/api/skills-studio/artifact/:id/file', (req, res) => {
  try {
    const id = decodeArtifactId(req.params.id);
    const { dirPath: dir } = resolveArtifactFile(id);
    const { path: subPath, content, isDir } = req.body;
    if (!subPath) return res.status(400).json({ error: 'path required.' });
    const fullPath = join(dir, subPath);
    if (!resolve(fullPath).startsWith(resolve(dir))) {
      return res.status(403).json({ error: 'Path traversal not allowed.' });
    }
    if (existsSync(fullPath)) return res.status(409).json({ error: 'File already exists.' });
    if (isDir) {
      mkdirSync(fullPath, { recursive: true });
    } else {
      const parentDir = dirname(fullPath);
      if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
      writeFileSync(fullPath, content || '', 'utf-8');
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/skills-studio/artifact/:id/file — delete a sub-file
app.delete('/api/skills-studio/artifact/:id/file', (req, res) => {
  try {
    const id = decodeArtifactId(req.params.id);
    const { dirPath: dir } = resolveArtifactFile(id);
    const { path: subPath } = req.body;
    if (!subPath) return res.status(400).json({ error: 'path required.' });
    const fullPath = join(dir, subPath);
    if (!resolve(fullPath).startsWith(resolve(dir))) {
      return res.status(403).json({ error: 'Path traversal not allowed.' });
    }
    if (!existsSync(fullPath)) return res.status(404).json({ error: 'File not found.' });
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      rmSync(fullPath, { recursive: true, force: true });
    } else {
      unlinkSync(fullPath);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/skills-studio/create — create a new skill/command/agent
app.post('/api/skills-studio/create', (req, res) => {
  try {
    const { type, scope, projectPath, name, rawContent } = req.body;
    if (!type || !scope || !name || !rawContent) {
      return res.status(400).json({ error: 'type, scope, name, and rawContent are required.' });
    }
    if (!/^[a-z][a-z0-9-]*$/.test(name) && !/^[a-z][a-z0-9-.]*$/.test(name)) {
      return res.status(400).json({ error: 'Name must be lowercase, start with a letter, and use only letters, digits, hyphens, and dots.' });
    }
    const home = process.env.USERPROFILE || process.env.HOME || '';
    let targetPath;
    if (type === 'skill') {
      const baseDir = scope === 'global' ? join(home, '.claude', 'skills', name)
        : scope === 'project' && projectPath ? join(projectPath, '.claude', 'skills', name)
        : null;
      if (!baseDir) return res.status(400).json({ error: 'Invalid scope or missing projectPath.' });
      if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });
      targetPath = join(baseDir, 'SKILL.md');
    } else if (type === 'command') {
      const baseDir = scope === 'project' && projectPath ? join(projectPath, '.claude', 'commands')
        : scope === 'global' ? join(home, '.claude', 'commands')
        : null;
      if (!baseDir) return res.status(400).json({ error: 'Invalid scope or missing projectPath.' });
      if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });
      targetPath = join(baseDir, `${name}.md`);
    } else if (type === 'agent') {
      const baseDir = scope === 'global' ? join(home, '.claude', 'agents')
        : scope === 'project' && projectPath ? join(projectPath, '.claude', 'agents')
        : null;
      if (!baseDir) return res.status(400).json({ error: 'Invalid scope or missing projectPath.' });
      if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });
      targetPath = join(baseDir, `${name}.md`);
    } else {
      return res.status(400).json({ error: 'type must be skill, command, or agent.' });
    }
    if (existsSync(targetPath)) return res.status(409).json({ error: `Artifact "${name}" already exists at that location.` });
    writeFileSync(targetPath, rawContent, 'utf-8');
    const id = type === 'skill' ? `skill:${targetPath}` : `${type}:${targetPath}`;
    res.json({ ok: true, id: encodeArtifactId(id), filePath: targetPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/skills-studio/artifact/:id — delete an artifact
app.delete('/api/skills-studio/artifact/:id', (req, res) => {
  try {
    const id = decodeArtifactId(req.params.id);
    const { type, dirPath, filePath } = resolveArtifactFile(id);
    if (!existsSync(filePath)) return res.status(404).json({ error: 'Artifact not found.' });
    if (type === 'skill') {
      // Delete entire skill directory
      rmSync(dirPath, { recursive: true, force: true });
    } else {
      // Also remove sibling icon file if exists
      const name = basename(filePath, '.md');
      const dir = dirname(filePath);
      for (const ext of ICON_EXTENSIONS) { const p = join(dir, `${name}.icon${ext}`); if (existsSync(p)) unlinkSync(p); }
      unlinkSync(filePath);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/skills-studio/validate — validate frontmatter structure
app.post('/api/skills-studio/validate', (req, res) => {
  try {
    const { rawContent, type } = req.body;
    const errors = [];
    const warnings = [];
    if (!rawContent) { errors.push('Content is empty.'); return res.json({ ok: true, errors, warnings }); }
    const fm = parseFullFrontmatter(rawContent);
    if (type === 'skill') {
      if (!fm.name) warnings.push('Missing "name" field in frontmatter.');
      if (!fm.description) warnings.push('Missing "description" field — Claude cannot auto-detect this skill.');
    }
    if (type === 'agent') {
      if (!fm.name) warnings.push('Missing "name" field in frontmatter.');
      if (!fm.description) errors.push('Agents require a "description" field.');
    }
    if (type === 'command') {
      if (!fm.description) warnings.push('Missing "description" field.');
    }
    const body = getFrontmatterBody(rawContent);
    if (!body.trim()) warnings.push('Body is empty — the skill has no instructions.');
    res.json({ ok: true, errors, warnings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/skills-studio/install — install bundled skill globally
app.post('/api/skills-studio/install', (req, res) => {
  try {
    const { dirName } = req.body;
    if (!dirName) return res.status(400).json({ error: 'dirName is required.' });
    const sourceDir = join(SKILLS_SOURCE_DIR, dirName);
    if (!existsSync(join(sourceDir, 'SKILL.md'))) return res.status(404).json({ error: `Bundled skill "${dirName}" not found.` });
    const targetDir = join(getGlobalSkillsDir(), dirName);
    if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
    cpSync(sourceDir, targetDir, { recursive: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/skills-studio/install — uninstall a globally installed skill
app.delete('/api/skills-studio/install', (req, res) => {
  try {
    const { dirName } = req.body;
    if (!dirName) return res.status(400).json({ error: 'dirName is required.' });
    const targetDir = join(getGlobalSkillsDir(), dirName);
    if (!existsSync(targetDir)) return res.json({ ok: true });
    rmSync(targetDir, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/skills-studio/export/:id — export as downloadable file
app.get('/api/skills-studio/export/:id', (req, res) => {
  try {
    const id = decodeArtifactId(req.params.id);
    const { type, dirPath, filePath } = resolveArtifactFile(id);
    if (!existsSync(filePath)) return res.status(404).json({ error: 'Artifact not found.' });

    if (type === 'skill') {
      // Export entire directory as a simple JSON bundle (portable, no ZIP dep needed)
      const name = basename(dirPath);
      const files = {};
      function collectFiles(d, prefix) {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
          if (entry.name.startsWith('.')) continue;
          const full = join(d, entry.name);
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (isDirEntry(entry)) {
            collectFiles(full, rel);
          } else {
            if (full.match(/\.(png|jpe?g|webp)$/i)) {
              files[rel] = { base64: readFileSync(full).toString('base64') };
            } else {
              files[rel] = readFileSync(full, 'utf-8');
            }
          }
        }
      }
      collectFiles(dirPath, '');
      const bundle = { format: 'synabun-skill-bundle', version: 1, type: 'skill', name, files };
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${name}.skill.json"`);
      res.send(JSON.stringify(bundle, null, 2));
    } else {
      // Single file: export as .md
      const name = basename(filePath, '.md');
      const content = readFileSync(filePath, 'utf-8');
      const bundleFiles = { [`${name}.md`]: content };
      // Include sibling icon file if present
      const dir = dirname(filePath);
      for (const ext of ICON_EXTENSIONS) {
        const iconPath = join(dir, `${name}.icon${ext}`);
        if (existsSync(iconPath)) {
          const iconKey = `${name}.icon${ext}`;
          bundleFiles[iconKey] = ext === '.svg' ? readFileSync(iconPath, 'utf-8') : { base64: readFileSync(iconPath).toString('base64') };
          break;
        }
      }
      const bundle = { format: 'synabun-skill-bundle', version: 1, type, name, files: bundleFiles };
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${name}.${type}.json"`);
      res.send(JSON.stringify(bundle, null, 2));
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/skills-studio/import — import a skill bundle
app.post('/api/skills-studio/import', (req, res) => {
  try {
    const { bundle, scope, projectPath } = req.body;
    if (!bundle || !bundle.format || bundle.format !== 'synabun-skill-bundle') {
      return res.status(400).json({ error: 'Invalid bundle format.' });
    }
    const { type, name, files } = bundle;
    if (!type || !name || !files) return res.status(400).json({ error: 'Bundle missing required fields.' });
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const effectiveScope = scope || 'global';
    let targetDir;
    if (type === 'skill') {
      targetDir = effectiveScope === 'project' && projectPath
        ? join(projectPath, '.claude', 'skills', name)
        : join(home, '.claude', 'skills', name);
      if (existsSync(targetDir)) return res.status(409).json({ error: `Skill "${name}" already exists. Delete it first.` });
      mkdirSync(targetDir, { recursive: true });
      for (const [rel, content] of Object.entries(files)) {
        const fullPath = join(targetDir, rel);
        const dir = dirname(fullPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        if (typeof content === 'object' && content.base64) {
          writeFileSync(fullPath, Buffer.from(content.base64, 'base64'));
        } else {
          writeFileSync(fullPath, content, 'utf-8');
        }
      }
    } else if (type === 'command') {
      targetDir = effectiveScope === 'project' && projectPath
        ? join(projectPath, '.claude', 'commands')
        : join(home, '.claude', 'commands');
      if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
      const targetFile = join(targetDir, `${name}.md`);
      if (existsSync(targetFile)) return res.status(409).json({ error: `Command "${name}" already exists.` });
      // Write main .md file + any sibling icon files
      for (const [rel, content] of Object.entries(files)) {
        const fullPath = join(targetDir, rel);
        if (typeof content === 'object' && content.base64) {
          writeFileSync(fullPath, Buffer.from(content.base64, 'base64'));
        } else {
          writeFileSync(fullPath, content, 'utf-8');
        }
      }
    } else if (type === 'agent') {
      targetDir = effectiveScope === 'project' && projectPath
        ? join(projectPath, '.claude', 'agents')
        : join(home, '.claude', 'agents');
      if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
      const targetFile = join(targetDir, `${name}.md`);
      if (existsSync(targetFile)) return res.status(409).json({ error: `Agent "${name}" already exists.` });
      // Write main .md file + any sibling icon files
      for (const [rel, content] of Object.entries(files)) {
        const fullPath = join(targetDir, rel);
        if (typeof content === 'object' && content.base64) {
          writeFileSync(fullPath, Buffer.from(content.base64, 'base64'));
        } else {
          writeFileSync(fullPath, content, 'utf-8');
        }
      }
    } else {
      return res.status(400).json({ error: 'Unknown artifact type.' });
    }
    res.json({ ok: true, name, type });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/health — Check if SQLite database is accessible
app.get('/api/health', (req, res) => {
  try {
    // getDb() auto-creates the directory, file, and schema if missing
    getDb();
    const count = countMemories();
    res.json({ ok: true, storage: 'sqlite', memories: count, projectDir: PROJECT_ROOT });
  } catch (err) {
    res.json({ ok: false, reason: 'db_error', detail: err.message });
  }
});

// POST /api/health/start — No-op for SQLite (no Docker to start)
app.post('/api/health/start', (req, res) => {
  res.json({ ok: true, ready: true, message: 'SQLite is always available — no startup needed.' });
});

// --- MCP API Key Management ---
const MCP_KEY_PATH = resolve(PROJECT_ROOT, 'data', 'mcp-api-key.json');
let activeMcpKey = null;

function loadMcpKey() {
  try {
    if (existsSync(MCP_KEY_PATH)) {
      const data = JSON.parse(readFileSync(MCP_KEY_PATH, 'utf8'));
      activeMcpKey = data.key || null;
      return data;
    }
  } catch {}
  activeMcpKey = null;
  return null;
}

function saveMcpKey(key) {
  const dir = resolve(PROJECT_ROOT, 'data');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const data = { key, createdAt: new Date().toISOString() };
  writeFileSync(MCP_KEY_PATH, JSON.stringify(data, null, 2));
  activeMcpKey = key;
  return data;
}

function deleteMcpKey() {
  try {
    if (existsSync(MCP_KEY_PATH)) writeFileSync(MCP_KEY_PATH, JSON.stringify({}, null, 2));
  } catch {}
  activeMcpKey = null;
}

// Load key on startup
loadMcpKey();

app.get('/api/mcp-key', (req, res) => {
  const data = loadMcpKey();
  if (!data || !data.key) {
    return res.json({ ok: true, hasKey: false });
  }
  const masked = data.key.length > 12 ? '***' + data.key.slice(-8) : '***';
  // Full key returned for URL-embedded auth (this endpoint is local-only, tunnel middleware blocks it)
  res.json({ ok: true, hasKey: true, key: data.key, maskedKey: masked, createdAt: data.createdAt });
});

app.post('/api/mcp-key', (req, res) => {
  const key = 'synabun_sk_' + randomBytes(32).toString('hex');
  const data = saveMcpKey(key);
  res.json({ ok: true, key, createdAt: data.createdAt });
});

app.delete('/api/mcp-key', (req, res) => {
  deleteMcpKey();
  res.json({ ok: true });
});

// --- Invite Key & Session Management ---
const INVITE_KEY_PATH = resolve(PROJECT_ROOT, 'data', 'invite-key.json');
const INVITE_SESSIONS_PATH = resolve(PROJECT_ROOT, 'data', 'invite-sessions.json');
const INVITE_PROXY_PATH = resolve(PROJECT_ROOT, 'data', 'invite-proxy.json');
const INVITE_PERMISSIONS_PATH = resolve(PROJECT_ROOT, 'data', 'invite-permissions.json');

const DEFAULT_PERMISSIONS = { terminal: false, whiteboard: false, memories: true, skills: false, cards: true, browser: false };

let activeInviteKey = null;
const inviteSessions = new Map(); // token → { createdAt, lastSeen, userAgent }

function loadInviteKey() {
  try {
    if (existsSync(INVITE_KEY_PATH)) {
      const data = JSON.parse(readFileSync(INVITE_KEY_PATH, 'utf8'));
      activeInviteKey = data.key || null;
      return data;
    }
  } catch {}
  activeInviteKey = null;
  return null;
}

function saveInviteKey(key) {
  const dir = resolve(PROJECT_ROOT, 'data');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const data = { key, createdAt: new Date().toISOString() };
  writeFileSync(INVITE_KEY_PATH, JSON.stringify(data, null, 2));
  activeInviteKey = key;
  return data;
}

function deleteInviteKey() {
  try {
    if (existsSync(INVITE_KEY_PATH)) writeFileSync(INVITE_KEY_PATH, JSON.stringify({}, null, 2));
  } catch {}
  activeInviteKey = null;
}

function loadInviteSessions() {
  try {
    if (existsSync(INVITE_SESSIONS_PATH)) {
      const data = JSON.parse(readFileSync(INVITE_SESSIONS_PATH, 'utf8'));
      if (Array.isArray(data.sessions)) {
        const now = Date.now();
        for (const s of data.sessions) {
          if (s.token && s.createdAt && (now - s.createdAt) < 24 * 60 * 60 * 1000) {
            inviteSessions.set(s.token, { createdAt: s.createdAt, lastSeen: s.lastSeen || s.createdAt, userAgent: s.userAgent });
          }
        }
      }
    }
  } catch {}
}

function persistInviteSessions() {
  const dir = resolve(PROJECT_ROOT, 'data');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const sessions = [...inviteSessions.entries()].map(([token, s]) => ({
    token, createdAt: s.createdAt, lastSeen: s.lastSeen, userAgent: s.userAgent
  }));
  writeFileSync(INVITE_SESSIONS_PATH, JSON.stringify({ sessions }, null, 2));
}

function loadInviteProxy() {
  try {
    if (existsSync(INVITE_PROXY_PATH)) {
      return JSON.parse(readFileSync(INVITE_PROXY_PATH, 'utf8'));
    }
  } catch {}
  return { useProxy: false, proxyUrl: '' };
}

function saveInviteProxy(config) {
  const dir = resolve(PROJECT_ROOT, 'data');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(INVITE_PROXY_PATH, JSON.stringify(config, null, 2));
}

let invitePermissions = { ...DEFAULT_PERMISSIONS };

function loadInvitePermissions() {
  try {
    if (existsSync(INVITE_PERMISSIONS_PATH)) {
      const data = JSON.parse(readFileSync(INVITE_PERMISSIONS_PATH, 'utf8'));
      invitePermissions = { ...DEFAULT_PERMISSIONS, ...data };
      return invitePermissions;
    }
  } catch {}
  invitePermissions = { ...DEFAULT_PERMISSIONS };
  return invitePermissions;
}

function saveInvitePermissions(perms) {
  const dir = resolve(PROJECT_ROOT, 'data');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  invitePermissions = { ...DEFAULT_PERMISSIONS, ...perms };
  writeFileSync(INVITE_PERMISSIONS_PATH, JSON.stringify(invitePermissions, null, 2));
  return invitePermissions;
}

// Load on startup
loadInviteKey();
loadInviteSessions();
loadInvitePermissions();

// Invite status (local only — tunnel middleware blocks unauthenticated)
app.get('/api/invite/status', (req, res) => {
  const keyData = loadInviteKey();
  const proxy = loadInviteProxy();
  // Clean expired sessions
  const now = Date.now();
  for (const [token, session] of inviteSessions.entries()) {
    if (now - session.createdAt > 24 * 60 * 60 * 1000) inviteSessions.delete(token);
  }
  const masked = keyData?.key ? '***' + keyData.key.slice(-8) : null;
  res.json({
    ok: true,
    hasKey: !!activeInviteKey,
    maskedKey: masked,
    createdAt: keyData?.createdAt || null,
    activeSessions: inviteSessions.size,
    proxyConfig: proxy,
  });
});

// Generate or rotate invite key (clears all sessions)
app.post('/api/invite/key', (req, res) => {
  const { custom } = req.body || {};
  let key;
  if (custom && typeof custom === 'string' && custom.trim().length >= 6) {
    key = custom.trim();
  } else {
    key = 'synabun_inv_' + randomBytes(24).toString('hex');
  }
  const data = saveInviteKey(key);
  inviteSessions.clear();
  persistInviteSessions();
  res.json({ ok: true, key, createdAt: data.createdAt });
});

// Revoke invite key + all sessions
app.delete('/api/invite/key', (req, res) => {
  deleteInviteKey();
  inviteSessions.clear();
  persistInviteSessions();
  res.json({ ok: true });
});

// Revoke all sessions (keep key)
app.delete('/api/invite/sessions', (req, res) => {
  inviteSessions.clear();
  persistInviteSessions();
  res.json({ ok: true });
});

// Save custom proxy config
app.put('/api/invite/proxy', (req, res) => {
  const { useProxy, proxyUrl } = req.body || {};
  const config = {
    useProxy: !!useProxy,
    proxyUrl: typeof proxyUrl === 'string' ? proxyUrl.trim() : '',
  };
  saveInviteProxy(config);
  res.json({ ok: true });
});

// Get guest permissions
app.get('/api/invite/permissions', (req, res) => {
  res.json({ ok: true, permissions: { ...invitePermissions } });
});

// Update guest permissions (owner only — admin middleware blocks guests)
app.put('/api/invite/permissions', (req, res) => {
  const updates = req.body || {};
  const validKeys = Object.keys(DEFAULT_PERMISSIONS);
  const merged = { ...invitePermissions };
  for (const k of validKeys) {
    if (typeof updates[k] === 'boolean') merged[k] = updates[k];
  }
  const saved = saveInvitePermissions(merged);
  broadcastSync({ type: 'permissions:changed', permissions: saved });
  res.json({ ok: true, permissions: saved });
});

// Serve invite auth page (express.static won't match /invite -> invite.html)
app.get('/invite', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'invite.html'));
});

// Invite auth — validate key, create session, set cookie
app.post('/invite/auth', (req, res) => {
  if (!activeInviteKey) {
    return res.status(403).json({ error: 'Invitations are not enabled' });
  }
  const { key } = req.body || {};
  if (!key || key !== activeInviteKey) {
    return res.status(401).json({ error: 'Invalid invite key' });
  }
  const token = randomBytes(32).toString('hex');
  const session = {
    createdAt: Date.now(),
    lastSeen: Date.now(),
    userAgent: req.headers['user-agent'] || 'unknown',
  };
  inviteSessions.set(token, session);
  persistInviteSessions();

  const isSecure = !!req.headers['cf-connecting-ip'];
  const cookieParts = [
    `synabun_invite=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=None',
    isSecure ? 'Secure' : '',
    'Max-Age=86400',
  ].filter(Boolean).join('; ');
  res.setHeader('Set-Cookie', cookieParts);
  res.json({ ok: true });
});

// Invite logout
app.get('/invite/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies['synabun_invite'];
  if (token) {
    inviteSessions.delete(token);
    persistInviteSessions();
  }
  res.setHeader('Set-Cookie', 'synabun_invite=; HttpOnly; Path=/; Max-Age=0');
  res.redirect('/invite');
});

// --- Cloudflare Tunnel Management ---
let tunnelProcess = null;
let tunnelUrl = null;
let tunnelStarting = false;

function findCloudflared() {
  // Try PATH-based lookup first (cross-platform)
  try {
    const cmd = process.platform === 'win32' ? 'where cloudflared' : 'which cloudflared';
    const result = execSync(cmd, { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (result) return result.split('\n')[0].trim();
  } catch { /* not in PATH */ }

  // Windows-specific fallback paths
  if (process.platform === 'win32') {
    const paths = [
      `${process.env.LOCALAPPDATA}\\cloudflared\\cloudflared.exe`,
      `${process.env.ProgramFiles}\\cloudflared\\cloudflared.exe`,
      `${process.env['ProgramFiles(x86)']}\\cloudflared\\cloudflared.exe`,
    ];
    for (const p of paths) { if (p && existsSync(p)) return p; }
  }
  return null;
}

app.get('/api/tunnel/status', (req, res) => {
  res.json({
    ok: true,
    available: !!findCloudflared(),
    running: !!tunnelProcess,
    starting: tunnelStarting,
    url: tunnelUrl,
  });
});

app.post('/api/tunnel/start', (req, res) => {
  if (tunnelProcess) return res.json({ ok: true, url: tunnelUrl, message: 'Already running.' });
  const bin = findCloudflared();
  if (!bin) return res.status(400).json({ error: 'cloudflared not found. Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/' });

  tunnelStarting = true;
  tunnelUrl = null;

  const child = spawn(bin, ['tunnel', '--url', `http://localhost:${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  tunnelProcess = child;
  let urlFound = false;

  const parseUrl = (data) => {
    const text = data.toString();
    // cloudflared prints the URL to stderr
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match && !urlFound) {
      urlFound = true;
      tunnelUrl = match[0];
      tunnelStarting = false;
      console.log(`  Tunnel:  ${tunnelUrl}`);
    }
  };

  child.stdout.on('data', parseUrl);
  child.stderr.on('data', parseUrl);

  child.on('close', () => {
    tunnelProcess = null;
    tunnelUrl = null;
    tunnelStarting = false;
  });

  // Respond immediately, client polls /api/tunnel/status for the URL
  res.json({ ok: true, message: 'Tunnel starting...' });
});

app.post('/api/tunnel/stop', (req, res) => {
  if (!tunnelProcess) return res.json({ ok: true, message: 'Not running.' });
  tunnelProcess.kill();
  tunnelProcess = null;
  tunnelUrl = null;
  tunnelStarting = false;
  res.json({ ok: true, message: 'Tunnel stopped.' });
});

// --- MCP HTTP Transport ---
// Mount the SynaBun MCP server as an HTTP endpoint for Claude web client
// Auth via URL-embedded key: /mcp/<key> for tunnel access, /mcp for local access
try {
  const mcpPath = pathToFileURL(resolve(PROJECT_ROOT, 'mcp-server', 'dist', 'http.js')).href;
  const { createMcpRoutes } = await import(mcpPath);
  const mcpRouter = createMcpRoutes();

  // Keyed path: /mcp/<key> — validates key, then forwards to MCP router
  app.use('/mcp/:key', (req, res, next) => {
    if (req.params.key !== activeMcpKey) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  }, mcpRouter);

  // Open path: /mcp — local-only (reject tunnel traffic when key is set)
  app.use('/mcp', (req, res, next) => {
    if (req.headers['cf-connecting-ip'] && activeMcpKey) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  }, mcpRouter);

  console.log('  MCP HTTP endpoint mounted at /mcp' + (activeMcpKey ? ' (key required for tunnel)' : ' (open)'));
} catch (err) {
  console.error('  MCP HTTP mount failed (run npm run build in mcp-server):', err.message);
}

// ═══════════════════════════════════════════
// TERMINAL — PTY Session Manager
// ═══════════════════════════════════════════

const terminalSessions = new Map(); // sessionId → { pty, clients, profile, cwd, createdAt, outputBuffer, graceTimer }

const IS_WIN = process.platform === 'win32';
const DEFAULT_SHELL = IS_WIN ? (process.env.COMSPEC || 'cmd.exe') : (process.env.SHELL || '/bin/bash');
const TERMINAL_BUFFER_MAX_BYTES = 100 * 1024; // 100KB ring buffer per session
const TERMINAL_GRACE_PERIOD_MS = 30 * 60 * 1000; // 30 min before orphaned PTY is killed

// ── CLI Config (custom CLI paths for terminal profiles) ──

const CLI_CONFIG_PATH = resolve(PROJECT_ROOT, 'data', 'cli-config.json');

const CLI_DEFAULTS = {
  'claude-code': { command: 'claude' },
  'codex':       { command: 'codex' },
  'gemini':      { command: 'gemini' },
};

function loadCliConfig() {
  try {
    if (!existsSync(CLI_CONFIG_PATH)) return { ...CLI_DEFAULTS };
    const raw = JSON.parse(readFileSync(CLI_CONFIG_PATH, 'utf-8'));
    return { ...CLI_DEFAULTS, ...raw };
  } catch { return { ...CLI_DEFAULTS }; }
}

function saveCliConfig(config) {
  const dir = dirname(CLI_CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CLI_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  // Clear cached claude binary so getClaudeBin() re-resolves with new config
  _claudeBinPath = null;
}

const SHELL_PROFILE = { shell: DEFAULT_SHELL, args: [], env: {} };

/**
 * Build terminal profile config dynamically from cli-config.json.
 * Re-reads config each call so changes take effect without restart.
 * @param {string} profileId - CLI profile ID (e.g. 'claude-code', 'codex', 'gemini', 'shell')
 * @param {Object} [opts] - Optional overrides
 * @param {string} [opts.model] - Model flag for CLIs that support it (e.g. claude --model sonnet)
 */
function getTerminalProfile(profileId, opts = {}) {
  if (profileId === 'shell') return SHELL_PROFILE;

  const config = loadCliConfig();
  const entry = config[profileId];
  if (!entry || !entry.command) return SHELL_PROFILE;

  let cmd = entry.command.trim();
  if (!cmd) return SHELL_PROFILE;

  // Append resume flag for Claude Code (mutually exclusive with model)
  if (opts.resume && profileId === 'claude-code') {
    cmd = `${cmd} --resume ${opts.resume}`;
  }
  // Append model flag for CLIs that support it
  else if (opts.model) {
    // Strip composite ":contextWindow" suffix if present
    const cleanModel = opts.model.includes(':') ? opts.model.split(':')[0] : opts.model;
    const modelMap = {
      'claude-code': (m) => `${cmd} --model ${m}`,
      'codex':       (m) => `${cmd} --model ${m}`,
      'gemini':      (m) => `${cmd} --model ${m}`,
    };
    const builder = modelMap[profileId];
    if (builder) cmd = builder(cleanModel);
  }

  return {
    shell: DEFAULT_SHELL,
    args: IS_WIN ? ['/k', cmd] : ['-c', `${cmd}; exec $SHELL`],
    env: { FORCE_COLOR: '1', TERM: 'xterm-256color' },
  };
}

function createTerminalSession(profile, cols, rows, cwd, opts = {}) {
  if (!pty) throw new Error('Terminal not available: node-pty failed to load. Run: cd neural-interface && npm run postinstall');
  const sessionId = opts.sessionId || randomBytes(16).toString('hex');
  const profileCfg = getTerminalProfile(profile, opts);

  // Strip VSCode env vars so spawned CLIs (e.g. claude) don't think they're inside VSCode
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) =>
      !k.startsWith('VSCODE_') && k !== 'TERM_PROGRAM' && k !== 'TERM_PROGRAM_VERSION'
    )
  );

  const ptyProcess = pty.spawn(profileCfg.shell, profileCfg.args, {
    name: 'xterm-256color',
    cols: cols || 120,
    rows: rows || 30,
    cwd: cwd || process.env.USERPROFILE || process.env.HOME || process.cwd(),
    env: { ...cleanEnv, ...profileCfg.env, ...(opts.extraEnv || {}) },
    useConpty: IS_WIN,
  });

  const session = {
    pty: ptyProcess, clients: new Set(), profile, cwd,
    createdAt: Date.now(),
    outputBuffer: [],      // ring buffer of output strings
    outputBufferBytes: 0,  // running byte count
    graceTimer: null,      // setTimeout handle for orphan cleanup
    claudeSessionId: opts.resume || null,  // known Claude session ID (from resume or detect)
  };
  terminalSessions.set(sessionId, session);

  // Auto-detect Claude session ID for fresh sessions (not resumed — those already have it)
  if (profile === 'claude-code' && !session.claudeSessionId) {
    setTimeout(() => {
      if (!session.claudeSessionId && terminalSessions.has(sessionId)) {
        const csid = detectClaudeSessionForCwd(session.cwd, session.createdAt);
        if (csid) session.claudeSessionId = csid;
      }
    }, 5000);
  }

  // ── Output coalescing ──
  // PTY onData fires per chunk (can be many times per ms). Each separate
  // WebSocket message triggers a write() + reflow on the client. By batching
  // chunks per event-loop tick we send one larger message instead of many small
  // ones, reducing client-side write() calls from N/frame to ~1/frame.
  let _outputCoalesceBuf = '';
  let _outputCoalesceScheduled = false;
  const _flushCoalesced = () => {
    _outputCoalesceScheduled = false;
    if (!_outputCoalesceBuf) return;
    const coalesced = _outputCoalesceBuf;
    _outputCoalesceBuf = '';

    // Append to ring buffer (one entry per flush, not per chunk)
    session.outputBuffer.push(coalesced);
    session.outputBufferBytes += coalesced.length;
    while (session.outputBufferBytes > TERMINAL_BUFFER_MAX_BYTES && session.outputBuffer.length > 1) {
      session.outputBufferBytes -= session.outputBuffer.shift().length;
    }

    const msg = JSON.stringify({ type: 'output', data: coalesced });
    session.clients.forEach(ws => {
      if (ws.readyState === 1) ws.send(msg);
    });
  };

  ptyProcess.onData((data) => {
    // Accumulate into coalesce buffer
    _outputCoalesceBuf += data;

    // Live link capture hook (needs per-chunk immediacy for prompt detection)
    if (session._linkCaptureCallback) {
      session._linkCaptureCallback(data);
    }

    // Loop driver capture (needs per-chunk immediacy for prompt detection)
    if (session._loopDriverBuffer !== undefined) {
      session._loopDriverBuffer += data;
      if (session._loopDriverBuffer.length > 16384) {
        session._loopDriverBuffer = session._loopDriverBuffer.slice(-8192);
      }
    }

    // Schedule flush for end of current event-loop tick
    if (!_outputCoalesceScheduled) {
      _outputCoalesceScheduled = true;
      setImmediate(_flushCoalesced);
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    // Clear grace timer if set
    if (session.graceTimer) { clearTimeout(session.graceTimer); session.graceTimer = null; }

    const msg = JSON.stringify({ type: 'exit', exitCode });
    session.clients.forEach(ws => {
      if (ws.readyState === 1) ws.send(msg);
    });
    // Clean up loop driver interval
    if (session._loopDriverInterval) {
      clearInterval(session._loopDriverInterval);
      session._loopDriverInterval = null;
    }
    // Clean up temp files from image paste
    if (session.tempFiles) {
      session.tempFiles.forEach(f => { try { unlinkSync(f); } catch {} });
    }
    // Destroy any links involving this session
    for (const [linkId, link] of terminalLinks) {
      if (link.sessions.includes(sessionId)) {
        const sessions = [...link.sessions];
        destroyTerminalLink(linkId);
        broadcastSync({ type: 'link:deleted', linkId, sessions, reason: 'session-exited' });
      }
    }
    terminalSessions.delete(sessionId);
  });

  return sessionId;
}

// ── Loop Driver — sends /clear + next iteration prompt between loop iterations ──

// Comprehensive ANSI escape stripping: CSI sequences, OSC sequences, charset selects, cursor keys, and \r
const LOOP_ANSI_RE = /\x1b\[[\x20-\x3f]*[\x40-\x7e]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()][AB012]|\x1b[=<>78HMND]|\x1bO[A-Z]|\r/g;

/**
 * Writes text to a PTY in chunks to avoid ConPTY buffer overflow on Windows.
 * Same approach as client-side _sendOnceReady (256-byte chunks, 30ms delays).
 */
function writeToLoopPty(session, text, sendEnter = true) {
  const full = sendEnter ? text + '\r' : text;
  const CHUNK = 256;
  const DELAY = 30;
  for (let i = 0; i < full.length; i += CHUNK) {
    const chunk = full.slice(i, i + CHUNK);
    const delay = (i / CHUNK) * DELAY;
    setTimeout(() => {
      try { session.pty.write(chunk); } catch { /* pty may be dead */ }
    }, delay);
  }
  // Return total time for all chunks to be sent
  return Math.ceil(full.length / CHUNK) * DELAY;
}

/**
 * Check if the ANSI-stripped PTY output buffer contains a ready prompt (>).
 * Matches: ">" at end of buffer, ">" on its own line, ">" followed by whitespace/newlines,
 * or the box-style prompt used by newer Claude Code UI (│ > │).
 */
function loopPromptReady(buffer) {
  const stripped = buffer.replace(LOOP_ANSI_RE, '');
  // Current Claude Code prompt: "? for shortcuts" hint line
  if (/\?\s*for shortcuts/i.test(stripped)) return true;
  // End of buffer prompt
  if (/>\s*$/.test(stripped)) return true;
  // Prompt on its own line (possibly with surrounding whitespace/newlines)
  if (/^>\s*$/m.test(stripped)) return true;
  // Prompt followed by newlines then nothing meaningful (e.g. "> \n\n")
  if (/>\s*\n\s*$/.test(stripped)) return true;
  // Box-style prompt: newer Claude Code renders "│ > " inside a box — box chars survive ANSI strip
  const tail = stripped.slice(-400);
  if (/│\s*>/.test(tail)) return true;
  // Last non-empty line contains > (catches any decorated prompt variant)
  const lastLine = stripped.trimEnd().split('\n').pop() || '';
  if (lastLine.includes('>')) return true;
  return false;
}

/**
 * Attach a loop driver to a terminal session. The driver watches for the
 * `awaitingNext` flag in the loop state file. When detected, it sends /clear
 * to the PTY via fixed delays, then sends the next iteration message.
 *
 * Prompt detection (loopPromptReady) is ONLY used for the initial boot claim
 * where we need to detect when the CLI has started. For iteration transitions,
 * we use deterministic delays — the stop hook guarantees the PTY is at the prompt.
 */
function attachLoopDriver(terminalSessionId) {
  const session = terminalSessions.get(terminalSessionId);
  if (!session) return;

  // Initialize capture buffer (used only for initial boot prompt detection)
  session._loopDriverBuffer = '';
  session._loopDriverStartedAt = Date.now();
  session._pendingClaimed = false;
  session._pendingClaimedAt = null;
  let driving = false; // prevent re-entrance

  let consecutiveFailures = 0;
  const MAX_DRIVE_FAILURES = 5; // with deterministic delays, failures are real problems

  const interval = setInterval(async () => {
    if (driving) return;
    if (!terminalSessions.has(terminalSessionId)) {
      clearInterval(interval);
      console.log('[loop-driver] Terminal session gone, clearing driver interval');
      return;
    }

    // Cooldown after pending claim: don't scan for awaitingNext while the first
    // iteration is still running. Once the pending file is gone (renamed by hook)
    // AND some time has passed, resume normal scanning.
    if (session._pendingClaimedAt) {
      const sinceClaim = Date.now() - session._pendingClaimedAt;
      // Check if any pending files for this terminal still exist
      const stillPending = existsSync(LOOP_DIR) && readdirSync(LOOP_DIR)
        .filter(f => f.startsWith('pending-') && f.endsWith('.json'))
        .some(pf => {
          try {
            const ps = JSON.parse(readFileSync(resolve(LOOP_DIR, pf), 'utf-8'));
            return ps.terminalSessionId === terminalSessionId;
          } catch { return false; }
        });
      // If pending file is still there, the hook hasn't claimed yet — wait
      // If claimed but less than 60s ago, the first iteration is likely still running
      if (stillPending || sinceClaim < 60_000) return;
      // First iteration should be underway — clear cooldown and resume normal scanning
      session._pendingClaimedAt = null;
    }

    // Scan for any loop state file with awaitingNext
    try {
      if (!existsSync(LOOP_DIR)) return;
      const files = readdirSync(LOOP_DIR).filter(f => f.endsWith('.json') && !f.startsWith('pending-'));
      for (const f of files) {
        let loopState;
        try {
          loopState = JSON.parse(readFileSync(resolve(LOOP_DIR, f), 'utf-8'));
        } catch { continue; }

        if (!loopState.awaitingNext || !loopState.active) continue;
        // Only drive loops owned by THIS terminal (prevents cross-session leaking)
        if (loopState.terminalSessionId && loopState.terminalSessionId !== terminalSessionId) continue;

        // Found a loop awaiting next iteration — drive it
        driving = true;
        let success = false;
        try {
          success = await driveNextIteration(session, loopState, f);
        } catch (err) {
          console.error('[loop-driver] Error driving iteration:', err.message);
        }

        if (success) {
          consecutiveFailures = 0;
        } else {
          consecutiveFailures++;
          console.warn(`[loop-driver] Iteration drive failed (${consecutiveFailures}/${MAX_DRIVE_FAILURES})`);
          if (consecutiveFailures >= MAX_DRIVE_FAILURES) {
            console.error(`[loop-driver] ${MAX_DRIVE_FAILURES} consecutive failures — deleting loop`);
            try { unlinkSync(resolve(LOOP_DIR, f)); } catch { /* ok */ }
            consecutiveFailures = 0;
          }
        }

        driving = false;
        break;
      }

      // Claim any pending-*.json for THIS terminal session by writing the initial
      // message directly to the PTY once Claude's > prompt is detected.
      // This makes the server authoritative for the first iteration claim, bypassing
      // the client-side _sendOnceReady which can silently fail if the WS is closed.
      if (!driving && !session._pendingClaimed) {
        // Boot delay: CLI needs ~8-12s to start. Don't poll too early.
        const bootElapsed = Date.now() - (session._loopDriverStartedAt || Date.now());
        if (bootElapsed < 8000) {
          // Too early — let CLI boot
        } else {
          const pendingFiles = readdirSync(LOOP_DIR)
            .filter(f => f.startsWith('pending-') && f.endsWith('.json'));
          for (const pf of pendingFiles) {
            let pendingState;
            try { pendingState = JSON.parse(readFileSync(resolve(LOOP_DIR, pf), 'utf-8')); } catch { continue; }
            if (pendingState.terminalSessionId !== terminalSessionId) continue;
            if (!pendingState.active && !pendingState.pending) continue;

            // Check for prompt OR use fallback after 30s of waiting
            const waitedForPrompt = bootElapsed - 8000;
            const promptDetected = loopPromptReady(session._loopDriverBuffer || '');
            const fallbackFire = waitedForPrompt > 30000;

            if (promptDetected || fallbackFire) {
              console.log(`[loop-driver] Claiming pending loop ${pf} via PTY write (prompt=${promptDetected}, fallback=${fallbackFire}, waited=${Math.round(bootElapsed / 1000)}s)`);
              session._pendingClaimed = true;
              session._pendingClaimedAt = Date.now();
              session._loopDriverBuffer = '';

              // Send the initial task message
              const chunkTime = writeToLoopPty(session, '[SynaBun Loop] Begin task.', true);

              // Auto-confirm Enter after the message settles (handles Y/n prompt)
              setTimeout(() => {
                try {
                  session.pty.write('\r');
                  console.log('[loop-driver] Sent auto-confirm Enter for pending claim');
                } catch { /* pty may be dead */ }
              }, chunkTime + 4000);
            }
            break;
          }
        }
      }
    } catch { /* ok */ }
  }, 2000);

  session._loopDriverInterval = interval;
}

/**
 * Drive the next loop iteration: fixed delay → /clear → fixed delay → iteration prompt → auto-confirm.
 * Uses deterministic delays instead of fragile PTY prompt detection.
 * The stop hook only sets awaitingNext after Claude has fully stopped, so the PTY
 * IS at the > prompt — we just need a small grace period for rendering.
 */
async function driveNextIteration(session, loopState, filename) {
  const loopPath = resolve(LOOP_DIR, filename);
  const iter = loopState.currentIteration;

  console.log(`[loop-driver] Driving iteration ${iter}/${loopState.totalIterations}`);

  // Step 1: Grace delay — let PTY finish rendering after Claude stopped
  await new Promise(r => setTimeout(r, 2000));

  // Step 2: Send /clear to reset conversation context
  session._loopDriverBuffer = '';
  session.pty.write('/clear\r');
  console.log('[loop-driver] Sent /clear');

  // Step 3: Wait for /clear to process (CLI clears conversation, renders fresh prompt)
  await new Promise(r => setTimeout(r, 5000));

  // Step 4: Send the iteration message (prompt-submit hook will inject full context)
  session._loopDriverBuffer = '';
  const iterMsg = `[SynaBun Loop] Iteration ${iter}. Begin task.`;
  const chunkTime = writeToLoopPty(session, iterMsg, true);
  console.log(`[loop-driver] Sent iteration ${iter} message`);

  // Step 5: Auto-confirm (Enter after all chunks + settle time)
  setTimeout(() => {
    try { session.pty.write('\r'); } catch { /* ok */ }
    console.log('[loop-driver] Sent auto-confirm Enter');
  }, chunkTime + 3000);

  // Step 6: Clear awaitingNext flag
  try {
    const freshState = JSON.parse(readFileSync(loopPath, 'utf-8'));
    freshState.awaitingNext = false;
    delete freshState._driveRetries; // no longer needed
    writeFileSync(loopPath, JSON.stringify(freshState, null, 2));
  } catch (err) {
    console.warn('[loop-driver] Failed to clear awaitingNext:', err.message);
  }

  return true;
}

// ── Last Session (resume after server restart) ──

const LAST_SESSION_PATH = resolve(PROJECT_ROOT, 'data', 'last-session.json');

app.get('/api/last-session', (req, res) => {
  try {
    const fileExists = existsSync(LAST_SESSION_PATH);
    const activeCount = [...terminalSessions.values()].filter(s => s.profile === 'claude-code').length;
    console.log(`[last-session] Check: file=${fileExists}, activeClaude=${activeCount}`);
    if (!fileExists) return res.status(404).json({ error: 'No saved session' });
    // If there are currently active claude-code sessions, the snapshot is live — don't offer resume
    if (activeCount > 0) return res.status(404).json({ error: 'Sessions still active' });
    const raw = readFileSync(LAST_SESSION_PATH, 'utf-8').trim();
    if (!raw) {
      unlinkSync(LAST_SESSION_PATH);
      return res.status(404).json({ error: 'Empty snapshot — cleaned up' });
    }
    const data = JSON.parse(raw);
    // Enrich with labels from ui-state
    const uiState = loadUiState();
    for (const s of data.sessions || []) {
      const labelKey = `synabun-session-label:${s.claudeSessionId}`;
      if (uiState[labelKey]) s.label = uiState[labelKey];
    }
    console.log(`[last-session] Returning ${data.sessions?.length} sessions`);
    res.json(data);
  } catch (err) {
    console.error('[last-session] Error:', err);
    // Corrupt file — clean it up so it doesn't keep failing
    if (err instanceof SyntaxError) {
      try { unlinkSync(LAST_SESSION_PATH); } catch {}
      return res.status(404).json({ error: 'Corrupt snapshot — cleaned up' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/last-session', (req, res) => {
  try {
    if (existsSync(LAST_SESSION_PATH)) unlinkSync(LAST_SESSION_PATH);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════
// SESSION MONITOR — Registry + Leak Detection
// ═══════════════════════════════════════════

const sessionRegistry = new Map(); // claudeSessionId → { cwd, profile, pid, connectedAt, lastActivity, terminalType, terminalSessionId, source }
const sessionMonitorClients = new Set(); // WebSocket clients for /ws/sessions
const LEAK_SCAN_INTERVAL_MS = 10_000;
const PENDING_REMEMBER_DIR = resolve(PROJECT_ROOT, 'data', 'pending-remember');
const LOOP_DIR_MONITOR = resolve(PROJECT_ROOT, 'data', 'loop');

function broadcastSessionEvent(event) {
  const data = JSON.stringify(event);
  for (const client of sessionMonitorClients) {
    if (client.readyState === 1) client.send(data);
  }
  broadcastSync(event);
}

function registerSession(claudeSessionId, meta) {
  const existing = sessionRegistry.get(claudeSessionId);
  const entry = {
    claudeSessionId,
    cwd: meta.cwd || '',
    profile: meta.profile || 'claude-code',
    pid: meta.pid || null,
    connectedAt: existing?.connectedAt || Date.now(),
    lastActivity: Date.now(),
    terminalType: meta.terminalType || 'external',
    terminalSessionId: meta.terminalSessionId || null,
    source: meta.source || 'hook',
    project: meta.project || '',
  };
  sessionRegistry.set(claudeSessionId, entry);
  broadcastSessionEvent({ type: 'session:registered', session: entry });
  return entry;
}

function unregisterSession(claudeSessionId) {
  if (!sessionRegistry.has(claudeSessionId)) return;
  sessionRegistry.delete(claudeSessionId);
  broadcastSessionEvent({ type: 'session:unregistered', claudeSessionId });
}

function classifyTerminalType(terminalSessionId) {
  const uiState = loadUiState();
  if (uiState['neural-terminal-detached']) return 'floating';
  return 'terminal';
}

function syncRegistryFromTerminals() {
  for (const [tsId, session] of terminalSessions) {
    if (session.profile !== 'claude-code') continue;
    if (!session.claudeSessionId) continue;
    const existing = sessionRegistry.get(session.claudeSessionId);
    if (!existing || existing.terminalSessionId !== tsId) {
      registerSession(session.claudeSessionId, {
        cwd: session.cwd,
        profile: session.profile,
        terminalType: classifyTerminalType(tsId),
        terminalSessionId: tsId,
        source: 'terminal',
      });
    }
  }
  for (const [csId, entry] of sessionRegistry) {
    if (entry.terminalSessionId && !terminalSessions.has(entry.terminalSessionId)) {
      unregisterSession(csId);
    }
  }
}

// ── Leak Detection ──

function scanForLeaks() {
  const leaks = [];
  const now = Date.now();
  const activeSessionIds = new Set(sessionRegistry.keys());
  for (const [, s] of terminalSessions) {
    if (s.claudeSessionId) activeSessionIds.add(s.claudeSessionId);
  }

  // 1. Orphaned pending-remember files
  try {
    if (existsSync(PENDING_REMEMBER_DIR)) {
      const files = readdirSync(PENDING_REMEMBER_DIR).filter(f => f.endsWith('.json') && !f.startsWith('test-'));
      for (const f of files) {
        const filePath = join(PENDING_REMEMBER_DIR, f);
        try {
          const fstat = statSync(filePath);
          const ageMs = now - fstat.mtimeMs;
          if (ageMs < 5 * 60 * 1000) continue;
          const sid = f.replace('.json', '');
          if (!activeSessionIds.has(sid)) {
            leaks.push({ type: 'orphaned-state', severity: ageMs > 30 * 60 * 1000 ? 'warning' : 'info', description: `Orphaned pending-remember flag (${Math.round(ageMs / 60000)}m old)`, file: filePath, sessionId: sid, ageMs });
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* ok */ }

  // 2. Orphaned loop files
  try {
    if (existsSync(LOOP_DIR_MONITOR)) {
      const files = readdirSync(LOOP_DIR_MONITOR).filter(f => f.endsWith('.json') && !f.startsWith('pending-'));
      for (const f of files) {
        const filePath = join(LOOP_DIR_MONITOR, f);
        try {
          const data = JSON.parse(readFileSync(filePath, 'utf-8'));
          if (data.stopped || data.finishedAt) continue;
          const fstat = statSync(filePath);
          const ageMs = now - fstat.mtimeMs;
          if (ageMs < 2 * 60 * 1000) continue;
          const sid = f.replace('.json', '');
          if (!activeSessionIds.has(sid) && data.active) {
            leaks.push({ type: 'orphaned-loop', severity: 'warning', description: `Active loop with no session (${data.template || 'custom'}, ${Math.round(ageMs / 60000)}m stale)`, file: filePath, sessionId: sid, ageMs, loopData: { template: data.template, currentIteration: data.currentIteration, maxIterations: data.maxIterations } });
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* ok */ }

  // 3. Multiple sessions targeting same cwd
  const cwdMap = new Map();
  for (const [csId, entry] of sessionRegistry) {
    if (!entry.cwd) continue;
    if (!cwdMap.has(entry.cwd)) cwdMap.set(entry.cwd, []);
    cwdMap.get(entry.cwd).push(csId);
  }
  for (const [cwd, sessions] of cwdMap) {
    if (sessions.length > 1) {
      leaks.push({ type: 'multi-session-cwd', severity: 'critical', description: `${sessions.length} sessions targeting same directory`, cwd, sessions });
    }
  }

  // 4. Stale precompact flags
  const precompactDir = resolve(PROJECT_ROOT, 'data', 'precompact');
  try {
    if (existsSync(precompactDir)) {
      const files = readdirSync(precompactDir).filter(f => f.endsWith('.json'));
      for (const f of files) {
        const filePath = join(precompactDir, f);
        try {
          const fstat = statSync(filePath);
          const ageMs = now - fstat.mtimeMs;
          if (ageMs > 10 * 60 * 1000) {
            leaks.push({ type: 'stale-precompact', severity: 'info', description: `Stale precompact cache (${Math.round(ageMs / 60000)}m old)`, file: filePath, sessionId: f.replace('.json', ''), ageMs });
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* ok */ }

  return leaks;
}

let _lastLeakHash = '';
setInterval(() => {
  syncRegistryFromTerminals();
  const leaks = scanForLeaks();
  const hash = JSON.stringify(leaks);
  if (hash !== _lastLeakHash) {
    _lastLeakHash = hash;
    if (leaks.length > 0) broadcastSessionEvent({ type: 'session:leaks', leaks });
  }
}, LEAK_SCAN_INTERVAL_MS);

// ── Session Monitor API ──

app.post('/api/sessions/register', express.json(), (req, res) => {
  const { claudeSessionId, cwd, profile, pid, terminalType, source, project } = req.body || {};
  if (!claudeSessionId) return res.status(400).json({ error: 'claudeSessionId required' });
  const entry = registerSession(claudeSessionId, { cwd, profile, pid, terminalType, source, project });
  res.json({ ok: true, session: entry });
});

app.post('/api/sessions/heartbeat', express.json(), (req, res) => {
  const { claudeSessionId } = req.body || {};
  if (!claudeSessionId) return res.status(400).json({ error: 'claudeSessionId required' });
  const entry = sessionRegistry.get(claudeSessionId);
  if (entry) { entry.lastActivity = Date.now(); res.json({ ok: true }); }
  else res.status(404).json({ error: 'Session not registered' });
});

app.delete('/api/sessions/:id', (req, res) => {
  unregisterSession(req.params.id);
  res.json({ ok: true });
});

app.get('/api/sessions/active', (req, res) => {
  syncRegistryFromTerminals();
  const sessions = [...sessionRegistry.values()].map(s => ({
    ...s,
    isAlive: s.terminalSessionId ? terminalSessions.has(s.terminalSessionId) : (Date.now() - s.lastActivity < 5 * 60 * 1000),
  }));
  res.json({ sessions });
});

app.get('/api/sessions/:id/state', (req, res) => {
  const csId = req.params.id;
  const entry = sessionRegistry.get(csId);
  if (!entry) return res.status(404).json({ error: 'Session not found' });
  const ownedFiles = [];
  try {
    const prPath = join(PENDING_REMEMBER_DIR, `${csId}.json`);
    if (existsSync(prPath)) ownedFiles.push({ type: 'pending-remember', path: prPath, data: JSON.parse(readFileSync(prPath, 'utf-8')) });
  } catch { /* ok */ }
  try {
    const loopPath = join(LOOP_DIR_MONITOR, `${csId}.json`);
    if (existsSync(loopPath)) ownedFiles.push({ type: 'loop', path: loopPath, data: JSON.parse(readFileSync(loopPath, 'utf-8')) });
  } catch { /* ok */ }
  res.json({ session: entry, ownedFiles });
});

app.get('/api/sessions/leaks', (req, res) => {
  syncRegistryFromTerminals();
  res.json({ leaks: scanForLeaks(), scannedAt: Date.now() });
});

app.post('/api/sessions/cleanup', express.json(), (req, res) => {
  const { types } = req.body || {};
  const allowedTypes = new Set(types || ['orphaned-state', 'stale-precompact']);
  const leaks = scanForLeaks();
  let cleaned = 0;
  for (const leak of leaks) {
    if (!allowedTypes.has(leak.type) || !leak.file) continue;
    try { unlinkSync(leak.file); cleaned++; } catch { /* skip */ }
  }
  res.json({ ok: true, cleaned, total: leaks.length });
});

// ── Session Monitor WebSocket ──

function handleSessionMonitorWebSocket(ws) {
  sessionMonitorClients.add(ws);
  syncRegistryFromTerminals();
  const sessions = [...sessionRegistry.values()].map(s => ({
    ...s,
    isAlive: s.terminalSessionId ? terminalSessions.has(s.terminalSessionId) : (Date.now() - s.lastActivity < 5 * 60 * 1000),
  }));
  ws.send(JSON.stringify({ type: 'session:init', sessions, leaks: scanForLeaks() }));
  ws.on('close', () => sessionMonitorClients.delete(ws));
  ws.on('error', () => sessionMonitorClients.delete(ws));
}

// ── Terminal REST endpoints ──

app.get('/api/terminal/sessions', (req, res) => {
  const sessions = [...terminalSessions.entries()].map(([id, s]) => ({
    id,
    profile: s.profile,
    cwd: s.cwd,
    createdAt: s.createdAt,
    clients: s.clients.size,
  }));
  res.json({ sessions });
});

app.post('/api/terminal/sessions', (req, res) => {
  const { profile = 'shell', cols = 120, rows = 30, cwd, resume, model } = req.body;
  try {
    const sessionId = createTerminalSession(profile, cols, rows, cwd, { resume, model });
    broadcastSync({ type: 'terminal:session-created', sessionId, profile });
    if (profile === 'claude-code') setTimeout(saveSessionSnapshot, 2000); // update resume snapshot
    res.json({ sessionId, profile });
  } catch (err) {
    let msg = err.message;
    if (process.platform !== 'win32' && (msg.includes('posix_spawn') || msg.includes('EACCES'))) {
      // Attempt auto-fix: chmod spawn-helper and retry once
      try {
        const ptyBase = resolve(__dirname, 'node_modules', 'node-pty');
        const sh = resolve(ptyBase, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
        if (existsSync(sh)) {
          chmodSync(sh, 0o755);
          console.log(`[pty] Auto-fixed spawn-helper permissions, retrying...`);
          const sessionId = createTerminalSession(profile, cols, rows, cwd, { resume, model });
          broadcastSync({ type: 'terminal:session-created', sessionId, profile });
          if (profile === 'claude-code') setTimeout(saveSessionSnapshot, 2000);
          return res.json({ sessionId, profile });
        }
      } catch {}
      msg = `Terminal failed: spawn-helper lacks execute permission. Try: chmod +x neural-interface/node_modules/node-pty/prebuilds/${process.platform}-${process.arch}/spawn-helper`;
    }
    res.status(500).json({ error: msg });
  }
});

app.delete('/api/terminal/sessions/:id', (req, res) => {
  const session = terminalSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const wasClaudeCode = session.profile === 'claude-code';
  session.pty.kill();
  // Clean up temp files from image paste
  if (session.tempFiles) {
    session.tempFiles.forEach(f => { try { unlinkSync(f); } catch {} });
  }
  terminalSessions.delete(req.params.id);
  broadcastSync({ type: 'terminal:session-deleted', sessionId: req.params.id });
  if (wasClaudeCode) setTimeout(saveSessionSnapshot, 500); // update resume snapshot
  res.json({ ok: true });
});

app.get('/api/terminal/profiles', (req, res) => {
  const profileIds = ['claude-code', 'codex', 'gemini', 'shell'];
  const profiles = profileIds.map(id => {
    const p = getTerminalProfile(id);
    return { id, shell: p.shell, args: p.args };
  });
  const projects = loadHookProjects().map(p => ({ path: p.path, label: p.label || basename(p.path) }));
  res.json({ profiles, projects });
});

// Detect Claude Code session UUID for a given cwd (finds newest JSONL modified after createdAfter)
// exclude: Set of session IDs to skip (already claimed by other terminals)
function detectClaudeSessionForCwd(cwd, createdAfter = 0, exclude = null) {
  if (!cwd) return null;
  try {
    const homeDir = process.env.USERPROFILE || process.env.HOME;
    const claudeProjectsDir = join(homeDir, '.claude', 'projects');
    const projKeyLower = pathToClaudeKey(cwd).replace(/^([A-Z])/, m => m.toLowerCase());
    const projKeyUpper = pathToClaudeKey(cwd);
    let projDir = join(claudeProjectsDir, projKeyLower);
    if (!existsSync(projDir)) projDir = join(claudeProjectsDir, projKeyUpper);
    if (!existsSync(projDir)) return null;
    const files = readdirSync(projDir).filter(f => f.endsWith('.jsonl'));
    let newest = null, newestMtime = 0;
    for (const f of files) {
      const sid = f.replace('.jsonl', '');
      if (exclude && exclude.has(sid)) continue;
      try {
        const st = statSync(join(projDir, f));
        if (st.size < 1024) continue; // skip sidechains / empty snapshots
        const mtime = st.mtimeMs;
        if (mtime >= createdAfter && mtime > newestMtime) {
          newestMtime = mtime;
          newest = sid;
        }
      } catch {}
    }
    return newest;
  } catch { return null; }
}

// GET /api/terminal/sessions/:id/claude-session — detect Claude Code session UUID for a terminal
app.get('/api/terminal/sessions/:id/claude-session', (req, res) => {
  const session = terminalSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.profile !== 'claude-code') return res.json({ claudeSessionId: null });
  const csid = session.claudeSessionId || detectClaudeSessionForCwd(session.cwd, session.createdAt);
  if (csid) session.claudeSessionId = csid; // cache for snapshot
  res.json({ claudeSessionId: csid });
});

// ── Terminal file tree ──

/** Try to get git status for a directory. Returns { branch, statuses } or null. */
function getGitInfo(dir) {
  try {
    // Check if inside a git work tree
    execSync('git rev-parse --is-inside-work-tree', { cwd: dir, stdio: 'pipe', timeout: 3000 });

    // Get branch name
    let branch = '';
    try {
      branch = execSync('git branch --show-current', { cwd: dir, stdio: 'pipe', timeout: 3000 }).toString().trim();
      if (!branch) {
        // Detached HEAD — get short SHA
        branch = execSync('git rev-parse --short HEAD', { cwd: dir, stdio: 'pipe', timeout: 3000 }).toString().trim();
      }
    } catch {}

    // Get status for this directory (porcelain v1: XY <path>)
    const raw = execSync('git status --porcelain -u .', { cwd: dir, stdio: 'pipe', timeout: 5000 }).toString();
    const statuses = new Map(); // name → status code

    for (const line of raw.split('\n')) {
      if (!line || line.length < 4) continue;
      const xy = line.substring(0, 2); // index + worktree status
      let filePath = line.substring(3);
      // Handle renames: "R  old -> new"
      const arrowIdx = filePath.indexOf(' -> ');
      if (arrowIdx !== -1) filePath = filePath.substring(arrowIdx + 4);

      // Get the immediate child name relative to this directory
      const sep = filePath.indexOf('/');
      const childName = sep === -1 ? filePath : filePath.substring(0, sep);

      // Map XY to a simplified status
      let status;
      const x = xy[0], y = xy[1];
      if (xy === '??') status = 'untracked';
      else if (xy === '!!') continue; // ignored
      else if (x === 'U' || y === 'U' || xy === 'DD' || xy === 'AA') status = 'conflict';
      else if (x === 'A') status = 'added';
      else if (x === 'D' || y === 'D') status = 'deleted';
      else if (x === 'R') status = 'renamed';
      else if (x !== ' ' && y !== ' ') status = 'mixed'; // staged + unstaged changes
      else if (x !== ' ') status = 'staged';
      else if (y !== ' ') status = 'modified';
      else continue;

      // For directories: escalate priority (conflict > modified > staged > added > untracked)
      const existing = statuses.get(childName);
      if (!existing || gitStatusPriority(status) > gitStatusPriority(existing)) {
        statuses.set(childName, status);
      }
    }

    return { branch, statuses };
  } catch {
    return null;
  }
}

const GIT_STATUS_PRIORITY = { untracked: 1, added: 2, renamed: 2, staged: 3, modified: 4, mixed: 5, deleted: 5, conflict: 6 };
function gitStatusPriority(s) { return GIT_STATUS_PRIORITY[s] || 0; }

app.get('/api/terminal/files', (req, res) => {
  const dir = req.query.path;
  if (!dir || typeof dir !== 'string') return res.status(400).json({ error: 'path required' });
  const search = (req.query.search || '').trim().toLowerCase();

  // Recursive search mode — return flat list of matching files
  if (search) {
    const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.next', '.cache', 'dist', 'build', '.turbo']);
    const MAX_RESULTS = 80;
    const results = [];

    function walk(current, rel) {
      if (results.length >= MAX_RESULTS) return;
      let entries;
      try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (results.length >= MAX_RESULTS) return;
        if (e.name.startsWith('.') && SKIP.has(e.name)) continue;
        if (SKIP.has(e.name)) continue;
        const childRel = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) {
          if (e.name.toLowerCase().includes(search)) {
            results.push({ name: childRel, type: 'dir' });
          }
          walk(resolve(current, e.name), childRel);
        } else {
          if (e.name.toLowerCase().includes(search)) {
            results.push({ name: childRel, type: 'file' });
          }
        }
      }
    }

    try {
      walk(dir, '');
      res.json({ path: dir, items: results, branch: null, search: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
    return;
  }

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const items = [];
    for (const e of entries) {
      // Skip hidden/system files
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__') continue;
      items.push({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' });
    }
    // Sort: directories first, then alphabetical
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    // Try git — gracefully ignored if unavailable
    const git = getGitInfo(dir);
    if (git) {
      for (const item of items) {
        const s = git.statuses.get(item.name);
        if (s) item.git = s;
      }
    }

    res.json({ path: dir, items, branch: git?.branch || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/terminal/branches', (req, res) => {
  const dir = req.query.path;
  if (!dir || typeof dir !== 'string') return res.status(400).json({ error: 'path required' });

  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: dir, stdio: 'pipe', timeout: 3000 });
  } catch {
    return res.json({ branches: [], current: null });
  }

  try {
    // Current branch
    let current = '';
    try {
      current = execSync('git branch --show-current', { cwd: dir, stdio: 'pipe', timeout: 3000 }).toString().trim();
    } catch {}

    // All local branches
    const raw = execSync('git branch --format="%(refname:short)"', { cwd: dir, stdio: 'pipe', timeout: 5000 }).toString().trim();
    const branches = raw ? raw.split('\n').map(b => b.trim()).filter(Boolean) : [];

    res.json({ branches, current });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/terminal/checkout', (req, res) => {
  const { path: dir, branch } = req.body;
  if (!dir || !branch) return res.status(400).json({ error: 'path and branch required' });

  // Validate branch name — only allow safe characters (letters, digits, /, -, _, .)
  if (!/^[\w.\-/]+$/.test(branch)) {
    return res.status(400).json({ error: 'Invalid branch name' });
  }

  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: dir, stdio: 'pipe', timeout: 3000 });
  } catch {
    return res.status(400).json({ error: 'Not a git repository' });
  }

  // Use spawnSync to avoid shell injection — branch passed as argument, not interpolated
  // No '--' separator — that would make git treat the branch name as a file pathspec
  const result = spawnSync('git', ['checkout', branch], { cwd: dir, stdio: 'pipe', timeout: 10000 });

  if (result.status !== 0) {
    const stderr = result.stderr?.toString?.()?.trim() || 'Checkout failed';
    return res.status(500).json({ error: stderr });
  }

  // Return confirmed branch name + git's own output
  let current = '';
  try {
    current = execSync('git branch --show-current', { cwd: dir, stdio: 'pipe', timeout: 3000 }).toString().trim();
  } catch {}
  const output = result.stderr?.toString?.()?.trim() || `Switched to branch '${current}'`;
  res.json({ ok: true, branch: current, output });
});

app.get('/api/git/status', (req, res) => {
  const dir = req.query.path;
  if (!dir || typeof dir !== 'string') return res.status(400).json({ error: 'path required' });

  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: dir, stdio: 'pipe', timeout: 3000 });
  } catch {
    return res.json({ ok: true, isGit: false, branch: null, changes: [] });
  }

  try {
    let branch = '';
    try {
      branch = execSync('git branch --show-current', { cwd: dir, stdio: 'pipe', timeout: 3000 }).toString().trim();
      if (!branch) branch = execSync('git rev-parse --short HEAD', { cwd: dir, stdio: 'pipe', timeout: 3000 }).toString().trim();
    } catch {}

    const raw = execSync('git status --porcelain', { cwd: dir, stdio: 'pipe', timeout: 5000 }).toString();
    const changes = [];
    for (const line of raw.split('\n')) {
      if (!line || line.length < 4) continue;
      const xy = line.substring(0, 2);
      let filePath = line.substring(3);
      const arrowIdx = filePath.indexOf(' -> ');
      if (arrowIdx !== -1) filePath = filePath.substring(arrowIdx + 4);
      const x = xy[0], y = xy[1];
      let staged = x !== ' ' && x !== '?';
      let status;
      if (xy === '??') status = 'untracked';
      else if (xy === '!!') continue;
      else if (x === 'U' || y === 'U' || xy === 'DD' || xy === 'AA') status = 'conflict';
      else if (x === 'A') status = 'added';
      else if (x === 'D' || y === 'D') status = 'deleted';
      else if (x === 'R') status = 'renamed';
      else if (x !== ' ' && y !== ' ') status = 'mixed';
      else if (x !== ' ') status = 'staged';
      else status = 'modified';
      changes.push({ path: filePath, status, staged });
    }

    res.json({ ok: true, isGit: true, branch, changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/git/commit', (req, res) => {
  const { path: dir, message, files } = req.body;
  if (!dir || !message) return res.status(400).json({ error: 'path and message required' });
  if (typeof message !== 'string' || message.trim().length === 0) return res.status(400).json({ error: 'Commit message cannot be empty' });

  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: dir, stdio: 'pipe', timeout: 3000 });
  } catch {
    return res.status(400).json({ error: 'Not a git repository' });
  }

  try {
    // Stage: specific files or all changes
    if (Array.isArray(files) && files.length > 0) {
      // Validate file paths — no shell injection
      for (const f of files) {
        if (typeof f !== 'string' || f.includes('..')) return res.status(400).json({ error: 'Invalid file path' });
      }
      const result = spawnSync('git', ['add', '--', ...files], { cwd: dir, stdio: 'pipe', timeout: 10000 });
      if (result.status !== 0) return res.status(500).json({ error: result.stderr?.toString?.()?.trim() || 'Stage failed' });
    } else {
      // Stage all changes
      const result = spawnSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe', timeout: 10000 });
      if (result.status !== 0) return res.status(500).json({ error: result.stderr?.toString?.()?.trim() || 'Stage failed' });
    }

    // Commit
    const result = spawnSync('git', ['commit', '-m', message.trim()], { cwd: dir, stdio: 'pipe', timeout: 15000 });
    if (result.status !== 0) {
      const stderr = result.stderr?.toString?.()?.trim() || '';
      const stdout = result.stdout?.toString?.()?.trim() || '';
      return res.status(500).json({ error: stderr || stdout || 'Commit failed' });
    }

    const output = result.stdout?.toString?.()?.trim() || 'Committed';
    res.json({ ok: true, output });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/git/diff-summary', (req, res) => {
  const dir = req.query.path;
  if (!dir || typeof dir !== 'string') return res.status(400).json({ error: 'path required' });

  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: dir, stdio: 'pipe', timeout: 3000 });
  } catch {
    return res.status(400).json({ error: 'Not a git repository' });
  }

  try {
    // Get diff stat for tracked files
    const stat = execSync('git diff --stat --stat-width=120', { cwd: dir, stdio: 'pipe', timeout: 5000 }).toString().trim();

    // Get diff stat for staged files
    const stagedStat = execSync('git diff --cached --stat --stat-width=120', { cwd: dir, stdio: 'pipe', timeout: 5000 }).toString().trim();

    // Get untracked files
    const untracked = execSync('git ls-files --others --exclude-standard', { cwd: dir, stdio: 'pipe', timeout: 5000 }).toString().trim();

    // Get short diff for context (limited to avoid huge payloads)
    const diff = execSync('git diff -U1 --no-color', { cwd: dir, stdio: 'pipe', timeout: 8000, maxBuffer: 64 * 1024 }).toString().substring(0, 4000);

    const stagedDiff = execSync('git diff --cached -U1 --no-color', { cwd: dir, stdio: 'pipe', timeout: 8000, maxBuffer: 64 * 1024 }).toString().substring(0, 4000);

    // Build a commit message from the changes
    const changedFiles = [];
    const statLines = (stat + '\n' + stagedStat).split('\n').filter(l => l.includes('|'));
    for (const line of statLines) {
      const match = line.match(/^\s*(.+?)\s*\|/);
      if (match) {
        const f = match[1].trim();
        if (!changedFiles.includes(f)) changedFiles.push(f);
      }
    }

    const untrackedFiles = untracked ? untracked.split('\n').filter(Boolean) : [];

    // Analyze diff to detect what kind of changes were made
    const allDiff = diff + '\n' + stagedDiff;
    const addedLines = (allDiff.match(/^\+[^+]/gm) || []).length;
    const removedLines = (allDiff.match(/^-[^-]/gm) || []).length;

    // Generate message
    let message = '';
    const totalFiles = changedFiles.length + untrackedFiles.length;

    if (totalFiles === 0) {
      return res.json({ ok: true, message: '', summary: 'No changes to commit' });
    }

    // Detect common patterns from file paths
    const dirs = new Set();
    for (const f of [...changedFiles, ...untrackedFiles]) {
      const parts = f.split('/');
      if (parts.length > 1) dirs.add(parts[0]);
    }

    // Build descriptive message
    if (totalFiles === 1) {
      const f = changedFiles[0] || untrackedFiles[0];
      const basename = f.split('/').pop();
      if (untrackedFiles.length === 1) message = 'Add ' + basename;
      else if (removedLines > addedLines * 2) message = 'Remove code from ' + basename;
      else message = 'Update ' + basename;
    } else if (totalFiles <= 4) {
      const names = [...changedFiles, ...untrackedFiles].map(f => f.split('/').pop());
      if (untrackedFiles.length === totalFiles) message = 'Add ' + names.join(', ');
      else message = 'Update ' + names.join(', ');
    } else {
      const scope = dirs.size === 1 ? [...dirs][0] : `${totalFiles} files`;
      if (untrackedFiles.length > changedFiles.length) message = 'Add and update ' + scope;
      else message = 'Update ' + scope;
    }

    const summary = `${changedFiles.length} modified, ${untrackedFiles.length} new — +${addedLines} -${removedLines} lines`;

    res.json({ ok: true, message, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Git Diff (raw content) ──

app.get('/api/git/diff', (req, res) => {
  const dir = req.query.path;
  if (!dir || typeof dir !== 'string') return res.status(400).json({ error: 'path required' });
  const maxLines = Math.min(Math.max(parseInt(req.query.maxLines) || 500, 50), 2000);

  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: dir, stdio: 'pipe', timeout: 3000 });
  } catch {
    return res.status(400).json({ error: 'Not a git repository' });
  }

  try {
    let branch = '';
    try { branch = execSync('git branch --show-current', { cwd: dir, stdio: 'pipe', timeout: 3000 }).toString().trim(); } catch {}
    if (!branch) try { branch = execSync('git rev-parse --short HEAD', { cwd: dir, stdio: 'pipe', timeout: 3000 }).toString().trim(); } catch {}

    const rawDiff = execSync('git diff --no-color', { cwd: dir, stdio: 'pipe', timeout: 10000, maxBuffer: 2 * 1024 * 1024 }).toString();
    const rawStaged = execSync('git diff --cached --no-color', { cwd: dir, stdio: 'pipe', timeout: 10000, maxBuffer: 2 * 1024 * 1024 }).toString();
    const untracked = execSync('git ls-files --others --exclude-standard', { cwd: dir, stdio: 'pipe', timeout: 5000 }).toString().trim();

    const truncate = (text) => {
      const lines = text.split('\n');
      if (lines.length <= maxLines) return { text, truncated: false };
      return { text: lines.slice(0, maxLines).join('\n'), truncated: true };
    };

    const d = truncate(rawDiff);
    const s = truncate(rawStaged);
    const untrackedFiles = untracked ? untracked.split('\n').filter(Boolean) : [];

    res.json({
      ok: true,
      branch,
      diff: d.text,
      stagedDiff: s.text,
      untrackedFiles,
      truncated: d.truncated || s.truncated
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Git Log ──

app.get('/api/git/log', (req, res) => {
  const dir = req.query.path;
  if (!dir || typeof dir !== 'string') return res.status(400).json({ error: 'path required' });
  const count = Math.min(Math.max(parseInt(req.query.count) || 10, 1), 50);

  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: dir, stdio: 'pipe', timeout: 3000 });
  } catch {
    return res.status(400).json({ error: 'Not a git repository' });
  }

  try {
    const raw = execSync(`git log --oneline --no-decorate -n ${count}`, { cwd: dir, stdio: 'pipe', timeout: 5000 }).toString().trim();
    const commits = raw ? raw.split('\n').map(line => {
      const spaceIdx = line.indexOf(' ');
      return { hash: line.substring(0, spaceIdx), message: line.substring(spaceIdx + 1) };
    }) : [];
    res.json({ ok: true, commits });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Git Generate Commit Message (AI-powered) ──

app.post('/api/git/generate-message', async (req, res) => {
  const dir = req.body?.path;
  if (!dir || typeof dir !== 'string') return res.status(400).json({ error: 'path required' });

  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: dir, stdio: 'pipe', timeout: 3000 });
  } catch {
    return res.status(400).json({ error: 'Not a git repository' });
  }

  // Gather diff data — separate try/catch per command so one failure doesn't skip the rest
  let diffText = '', stagedText = '', untrackedList = '', recentCommits = '';
  try { diffText = execSync('git diff --no-color', { cwd: dir, stdio: 'pipe', timeout: 8000, maxBuffer: 2 * 1024 * 1024 }).toString().substring(0, 4000); } catch {}
  try { stagedText = execSync('git diff --cached --no-color', { cwd: dir, stdio: 'pipe', timeout: 8000, maxBuffer: 2 * 1024 * 1024 }).toString().substring(0, 4000); } catch {}
  try { untrackedList = execSync('git ls-files --others --exclude-standard', { cwd: dir, stdio: 'pipe', timeout: 5000 }).toString().trim(); } catch {}
  try { recentCommits = execSync('git log --oneline --no-decorate -n 5', { cwd: dir, stdio: 'pipe', timeout: 3000 }).toString().trim(); } catch {}

  const allDiff = (diffText + '\n' + stagedText).trim();
  if (!allDiff && !untrackedList) {
    return res.json({ ok: true, message: '', source: 'heuristic', summary: 'No changes to commit' });
  }

  // Try Claude CLI
  let claudeAvailable = false;
  try {
    execSync(process.platform === 'win32' ? 'where claude' : 'which claude', { stdio: 'pipe', timeout: 3000 });
    claudeAvailable = true;
  } catch {}

  if (claudeAvailable) {
    try {
      const prompt = [
        'Generate a single-line git commit message for these changes.',
        'Match the style of recent commits shown below.',
        'Be specific about what changed. Output ONLY the commit message — no quotes, no prefix, no explanation.',
        '',
        '## Recent commits (for style reference)',
        recentCommits || '(none)',
        '',
        '## Diff',
        allDiff.substring(0, 3500),
        untrackedList ? '\n## New untracked files\n' + untrackedList.split('\n').slice(0, 20).join('\n') : '',
      ].join('\n');

      const { spawnSync: spawnS } = require('child_process');
      const result = spawnS('claude', ['-p', '--model', 'sonnet'], {
        input: prompt,
        cwd: dir,
        timeout: 30000,
        maxBuffer: 64 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
      });

      const output = (result.stdout || '').toString().trim();
      if (output && !result.error && result.status === 0) {
        // Clean up: remove quotes if Claude wrapped the message
        const cleaned = output.replace(/^["']|["']$/g, '').trim();
        if (cleaned) {
          return res.json({ ok: true, message: cleaned, source: 'claude' });
        }
      }
    } catch {}
  }

  // Fallback: heuristic (same logic as /api/git/diff-summary)
  try {
    let stat = '', stagedStat = '';
    try { stat = execSync('git diff --stat --stat-width=120', { cwd: dir, stdio: 'pipe', timeout: 5000, maxBuffer: 2 * 1024 * 1024 }).toString().trim(); } catch {}
    try { stagedStat = execSync('git diff --cached --stat --stat-width=120', { cwd: dir, stdio: 'pipe', timeout: 5000, maxBuffer: 2 * 1024 * 1024 }).toString().trim(); } catch {}
    const changedFiles = [];
    for (const line of (stat + '\n' + stagedStat).split('\n').filter(l => l.includes('|'))) {
      const m = line.match(/^\s*(.+?)\s*\|/);
      if (m) { const f = m[1].trim(); if (!changedFiles.includes(f)) changedFiles.push(f); }
    }
    const untrackedFiles = untrackedList ? untrackedList.split('\n').filter(Boolean) : [];
    const addedLines = (allDiff.match(/^\+[^+]/gm) || []).length;
    const removedLines = (allDiff.match(/^-[^-]/gm) || []).length;
    const totalFiles = changedFiles.length + untrackedFiles.length;

    let message = '';
    if (totalFiles === 0) {
      return res.json({ ok: true, message: '', source: 'heuristic', summary: 'No changes to commit' });
    }
    const dirs = new Set();
    for (const f of [...changedFiles, ...untrackedFiles]) {
      const parts = f.split('/');
      if (parts.length > 1) dirs.add(parts[0]);
    }
    if (totalFiles === 1) {
      const f = changedFiles[0] || untrackedFiles[0];
      const basename = f.split('/').pop();
      if (untrackedFiles.length === 1) message = 'Add ' + basename;
      else if (removedLines > addedLines * 2) message = 'Remove code from ' + basename;
      else message = 'Update ' + basename;
    } else if (totalFiles <= 4) {
      const names = [...changedFiles, ...untrackedFiles].map(f => f.split('/').pop());
      if (untrackedFiles.length === totalFiles) message = 'Add ' + names.join(', ');
      else message = 'Update ' + names.join(', ');
    } else {
      const scope = dirs.size === 1 ? [...dirs][0] : `${totalFiles} files`;
      if (untrackedFiles.length > changedFiles.length) message = 'Add and update ' + scope;
      else message = 'Update ' + scope;
    }

    const summary = `${changedFiles.length} modified, ${untrackedFiles.length} new — +${addedLines} -${removedLines} lines`;
    res.json({ ok: true, message, source: 'heuristic', summary });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate message: ' + err.message });
  }
});

// ── CLI Config REST ──

app.get('/api/cli/config', (req, res) => {
  try {
    res.json({ ok: true, config: loadCliConfig() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put('/api/cli/config', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ ok: false, error: 'Body must be a JSON object' });
    }
    const config = loadCliConfig();
    for (const [key, val] of Object.entries(req.body)) {
      if (CLI_DEFAULTS[key] && val && typeof val === 'object') {
        const command = (val.command || '').trim();
        config[key] = { command: command || CLI_DEFAULTS[key].command };
      }
    }
    saveCliConfig(config);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/cli/detect/:profileId', (req, res) => {
  try {
    const { profileId } = req.params;
    const defaults = { 'claude-code': 'claude', 'codex': 'codex', 'gemini': 'gemini' };
    const cmdName = defaults[profileId];
    if (!cmdName) return res.status(400).json({ ok: false, error: 'Unknown profile' });

    const detectCmd = IS_WIN ? `where ${cmdName}` : `which ${cmdName}`;
    try {
      const result = execSync(detectCmd, {
        encoding: 'utf-8',
        timeout: 5000,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      const foundPath = result.split(/\r?\n/)[0].trim();
      res.json({ ok: true, found: true, path: foundPath });
    } catch {
      res.json({ ok: true, found: false, path: null });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════
// TERMINAL LINKS — Relay/Mediator between PTY sessions
// ═══════════════════════════════════════════

const terminalLinks = new Map(); // linkId → LinkState

/**
 * Strip ANSI escape sequences from raw PTY output for relay purposes.
 * Covers CSI, OSC, DCS, charset designators, and C0 control chars.
 * Keeps \n and \t for readable text.
 */
function stripAnsi(str) {
  return str
    .replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, '')              // CSI sequences
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')          // OSC sequences (BEL or ST terminated)
    .replace(/\x1b[P^_][\s\S]*?(?:\x1b\\|\x07)/g, '')           // DCS/PM/APC strings
    .replace(/\x1b[()][AB012]/g, '')                              // Charset designators
    .replace(/\x1b[=><78HMNOZcn]/g, '')                          // Simple ESC sequences
    .replace(/\x1b./g, '')                                        // Stray ESC + char
    .replace(/[^\n]*\r(?!\n)/g, '')                               // CR overwrite cleanup
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');          // Control chars (keep \n \t)
}

// ── Sidecar CLI config — non-interactive args for each profile ──
// Spawns headless CLI processes for clean text relay (sidecar mode).
//
// stdin: true  — message piped to stdin (flag is a boolean mode switch)
// stdin: false — message appended as the last CLI arg (flag takes a value)
const CLI_SIDECAR_CONFIG = {
  'claude-code': { args: ['-p', '--verbose'], stdin: true },   // -p = non-interactive mode; reads prompt from stdin
  'gemini':      { args: ['-p'],              stdin: false },   // -p <value>; PowerShell passes correctly on Windows
  'codex':       { args: ['-q'],              stdin: false },   // -q <msg>; flag takes a value
  'shell':       null,
};

// ── Live PTY config — inject messages into the actual TUI terminal ──
// User sees messages typed and agents responding in real-time.
// Response captured from PTY output stream, ANSI-stripped, then relayed.
const CLI_LIVE_CONFIG = {
  'claude-code': {
    promptPatterns: [/>\s*$/m],             // ">" at end of stripped output
    idleMs: 3000,                           // 3s of no output → check prompt
    maxIdleMs: 120000,                      // 2 min absolute max wait
    useBracketedPaste: true,
  },
  'gemini': {
    promptPatterns: [/>\s*$/m, /\u276F\s*$/m],
    idleMs: 3000,
    maxIdleMs: 120000,
    useBracketedPaste: true,
  },
  'codex': {
    promptPatterns: [/>\s*$/m],
    idleMs: 3000,
    maxIdleMs: 120000,
    useBracketedPaste: true,
  },
  'shell': null,
};

const LIVE_CAPTURE_SETTLE_MS = 500; // delay after injection before starting capture

const LINK_SIDECAR_TIMEOUT_MS = 5 * 60 * 1000; // 5 min max per sidecar process

/**
 * Create a terminal link (relay/mediator session between agents).
 * mode: 'sidecar' (headless CLI processes) or 'live' (inject into TUI PTY).
 */
function createTerminalLink(sessionIds, config = {}) {
  for (const sid of sessionIds) {
    if (!terminalSessions.has(sid)) throw new Error(`Session ${sid} not found`);
  }
  for (const sid of sessionIds) {
    for (const [, link] of terminalLinks) {
      if (link.sessions.includes(sid)) throw new Error(`Session ${sid} is already linked`);
    }
  }

  const mode = config.mode || 'sidecar';

  // Validate live mode profiles
  if (mode === 'live') {
    for (const sid of sessionIds) {
      const s = terminalSessions.get(sid);
      if (!s || !CLI_LIVE_CONFIG[s.profile]) {
        throw new Error(`Profile "${s?.profile}" does not support live mode`);
      }
    }
  }

  const linkId = randomBytes(16).toString('hex');
  const link = {
    id: linkId,
    sessions: sessionIds,
    status: 'idle',           // idle | running | paused
    activeAgent: 0,           // index into sessions[]
    history: [],              // { role, sessionId, content, timestamp }
    mode,                     // 'sidecar' | 'live'
    config: {
      autoContinue: config.autoContinue !== false,
      maxTurns: config.maxTurns || 0,
      turnCount: 0,
    },
    // Sidecar-mode state
    _sidecarProcess: null,
    _sidecarSessionId: null,
    // Live-mode state
    _captureBuffer: '',
    _captureVTerm: null,           // VTermBuffer for clean text extraction
    _captureSessionId: null,
    _idleTimer: null,
    _maxIdleTimer: null,
    _injectionEcho: '',
    createdAt: Date.now(),
  };

  terminalLinks.set(linkId, link);
  return linkId;
}

/**
 * Destroy a terminal link — kill sidecar, remove from map.
 */
function destroyTerminalLink(linkId) {
  const link = terminalLinks.get(linkId);
  if (!link) return false;

  // Clean up sidecar mode
  if (link._sidecarProcess) {
    try { link._sidecarProcess.kill('SIGTERM'); } catch {}
    link._sidecarProcess = null;
  }

  // Clean up live mode
  if (link._idleTimer) clearTimeout(link._idleTimer);
  if (link._maxIdleTimer) clearTimeout(link._maxIdleTimer);
  if (link._captureSessionId) {
    const capSession = terminalSessions.get(link._captureSessionId);
    if (capSession) capSession._linkCaptureCallback = null;
  }
  link._captureVTerm = null;

  terminalLinks.delete(linkId);
  return true;
}

/**
 * Spawn a non-interactive sidecar CLI process for a linked agent.
 * Instead of injecting into the TUI PTY, we spawn a separate headless
 * process (e.g. `claude -p "message"`) and capture its clean stdout.
 */
function spawnSidecarProcess(linkId, sessionId, message) {
  const link = terminalLinks.get(linkId);
  if (!link) throw new Error('Link not found');

  const session = terminalSessions.get(sessionId);
  if (!session) throw new Error('Session not found');

  const profile = session.profile;
  const sidecarConfig = CLI_SIDECAR_CONFIG[profile];
  if (!sidecarConfig) throw new Error(`No sidecar config for profile: ${profile}`);

  // Get the CLI command from config (e.g. 'claude', 'gemini', 'codex')
  const cliConfig = loadCliConfig();
  const command = (cliConfig[profile]?.command || '').trim();
  if (!command) throw new Error(`No CLI command configured for ${profile}`);

  let spawnCmd = command;
  let spawnArgs = [...sidecarConfig.args];
  let useShell = IS_WIN;
  let tmpFile = null;

  if (sidecarConfig.stdin) {
    // stdin-based: args are fixed, message piped after spawn (e.g. Claude Code)
  } else if (IS_WIN) {
    // Windows: cmd.exe shell quoting mangles multi-word args (splits by spaces),
    // causing CLIs like Gemini to misparse -p "hello world" as -p + positional "hello" "world".
    // Use PowerShell which correctly passes $msg as a single argument value.
    tmpFile = join(os.tmpdir(), `synabun-relay-${randomBytes(4).toString('hex')}.txt`);
    writeFileSync(tmpFile, message, 'utf-8');
    const flag = spawnArgs[0]; // e.g. '-p', '-q'
    spawnCmd = 'powershell.exe';
    spawnArgs = ['-NoProfile', '-NonInteractive', '-Command',
      `$msg = Get-Content -Raw '${tmpFile}'; & '${command}' ${flag} $msg`];
    useShell = false;
  } else {
    // Unix: pass directly as the flag's value arg (no shell quoting issues)
    spawnArgs.push(message);
  }

  console.log(`[link-sidecar] Spawning: ${spawnCmd} ${spawnArgs.join(' ').slice(0, 200)}... (${profile}, cwd: ${session.cwd || process.cwd()})`);

  const child = spawn(spawnCmd, spawnArgs, {
    cwd: session.cwd || process.cwd(),
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: useShell,
    timeout: LINK_SIDECAR_TIMEOUT_MS,
    windowsHide: true,
  });

  // Pipe message to stdin for CLIs that support it (e.g. Claude Code)
  if (sidecarConfig.stdin) {
    child.stdin.write(message);
  }
  child.stdin.end();

  // Track on link state
  link._sidecarProcess = child;
  link._sidecarSessionId = sessionId;

  let fullOutput = '';

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    fullOutput += text;

    // Broadcast streaming chunk to clients
    broadcastSync({
      type: 'link:chunk',
      linkId,
      sessionId,
      profile,
      content: text,
    });
  });

  let stderrOutput = '';
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderrOutput += text;
    console.log(`[link-sidecar] ${profile} stderr: ${text.slice(0, 500)}`);
  });

  child.on('close', (code) => {
    link._sidecarProcess = null;
    link._sidecarSessionId = null;
    if (tmpFile) { try { unlinkSync(tmpFile); } catch {} }

    const cleanOutput = fullOutput.trim();

    if (code !== 0 && code !== null) {
      console.error(`[link-sidecar] ${profile} exited with code ${code}${stderrOutput ? ': ' + stderrOutput.slice(0, 500) : ''}`);
      if (!cleanOutput) {
        const errDetail = stderrOutput.trim().slice(0, 200) || `exited with code ${code}`;
        broadcastSync({ type: 'link:error', linkId, error: `${profile}: ${errDetail}` });
        link.status = 'idle';
        return;
      }
    }

    if (cleanOutput) {
      onSidecarFinished(linkId, sessionId, cleanOutput);
    } else {
      link.status = 'idle';
      broadcastSync({ type: 'link:agent-finished', linkId, sessionId, profile });
    }
  });

  child.on('error', (err) => {
    link._sidecarProcess = null;
    link._sidecarSessionId = null;
    console.error(`[link-sidecar] ${profile} spawn error:`, err.message);
    broadcastSync({ type: 'link:error', linkId, error: `Failed to start ${profile}: ${err.message}` });
    link.status = 'idle';
  });

  return child;
}

/**
 * Called when a sidecar process finishes with output.
 * Output is already clean text — no ANSI stripping needed.
 */
function onSidecarFinished(linkId, sessionId, cleanOutput) {
  const link = terminalLinks.get(linkId);
  if (!link) return;

  const session = terminalSessions.get(sessionId);
  const profile = session?.profile || 'unknown';

  // Add to history
  const entry = { role: profile, sessionId, content: cleanOutput, timestamp: Date.now() };
  link.history.push(entry);

  broadcastSync({ type: 'link:agent-finished', linkId, sessionId, profile });
  broadcastSync({ type: 'link:message', linkId, ...entry, turnCount: link.config.turnCount });

  // Auto-continue to next agent?
  if (link.config.autoContinue && link.status === 'running') {
    link.config.turnCount++;
    if (link.config.maxTurns > 0 && link.config.turnCount >= link.config.maxTurns) {
      link.status = 'idle';
      broadcastSync({ type: 'link:paused', linkId, reason: 'max-turns' });
      return;
    }
    relayToNextAgent(linkId, cleanOutput);
  } else {
    link.status = 'idle';
  }
}

// ── Live PTY injection functions ──

/**
 * Inject a message into a live PTY terminal and capture the response.
 * The message is typed directly into the TUI CLI's input prompt.
 * Response is captured from PTY output, ANSI-stripped, and relayed.
 */
function injectIntoLivePty(linkId, sessionId, message) {
  const link = terminalLinks.get(linkId);
  if (!link) throw new Error('Link not found');
  if (link.mode !== 'live') throw new Error('Link is not in live mode');

  const session = terminalSessions.get(sessionId);
  if (!session) throw new Error('Session not found');

  const profile = session.profile;
  const liveConfig = CLI_LIVE_CONFIG[profile];
  if (!liveConfig) throw new Error(`No live config for profile: ${profile}`);

  if (session._linkCaptureCallback) {
    throw new Error(`Session ${sessionId.slice(0, 8)} already has a capture callback`);
  }

  console.log(`[link-live] Injecting into ${profile} (session ${sessionId.slice(0, 8)}), msg: ${message.slice(0, 200)}...`);

  // Set up link capture state
  link._captureBuffer = '';
  link._captureSessionId = sessionId;
  link._injectionEcho = message;

  // Create VTermBuffer matching the session's PTY dimensions for clean text extraction.
  // Unlike regex stripAnsi(), this properly handles TUI cursor positioning, spinners,
  // and screen overwrites — only the final visual state is retained.
  const ptyCols = session.pty.cols || 120;
  const ptyRows = session.pty.rows || 30;
  link._captureVTerm = new VTermBuffer(ptyCols, ptyRows);

  broadcastSync({ type: 'link:agent-started', linkId, sessionId, profile });

  // Inject message into PTY — send text first, then Enter after a short delay.
  // TUI frameworks (Ink) process input per-frame; Enter must arrive as a separate
  // keystroke or it gets swallowed when bundled with the text in one write.
  const pty = session.pty;
  const ENTER_DELAY_MS = 80;

  if (liveConfig.useBracketedPaste && message.includes('\n')) {
    pty.write('\x1b[200~' + message + '\x1b[201~');
  } else {
    pty.write(message);
  }
  // Send Enter separately after delay
  setTimeout(() => pty.write('\r'), ENTER_DELAY_MS);

  // Wait for settle delay, then start capturing output
  setTimeout(() => {
    if (!terminalLinks.has(linkId)) return;
    if (link._captureSessionId !== sessionId) return;

    session._linkCaptureCallback = (data) => {
      link._captureBuffer += data;

      // Feed raw data into VTermBuffer for proper terminal emulation
      if (link._captureVTerm) {
        try { link._captureVTerm.write(data); } catch {}
      }

      // Broadcast streaming chunk (ANSI-stripped for display)
      const cleanChunk = stripAnsi(data);
      if (cleanChunk.trim()) {
        broadcastSync({
          type: 'link:chunk',
          linkId,
          sessionId,
          profile,
          content: cleanChunk,
        });
      }

      // Reset idle timer on each output chunk
      if (link._idleTimer) clearTimeout(link._idleTimer);
      link._idleTimer = setTimeout(() => {
        _checkLiveCaptureComplete(linkId, sessionId);
      }, liveConfig.idleMs);
    };

    // Absolute max wait safety net
    link._maxIdleTimer = setTimeout(() => {
      console.log(`[link-live] Max idle timeout for ${profile}`);
      _finalizeLiveCapture(linkId, sessionId, 'max-idle-timeout');
    }, liveConfig.maxIdleMs);

  }, LIVE_CAPTURE_SETTLE_MS);
}

/**
 * Called after idle timeout — check if the CLI prompt has reappeared.
 */
function _checkLiveCaptureComplete(linkId, sessionId) {
  const link = terminalLinks.get(linkId);
  if (!link || link._captureSessionId !== sessionId) return;

  const session = terminalSessions.get(sessionId);
  if (!session) {
    _finalizeLiveCapture(linkId, sessionId, 'session-gone');
    return;
  }

  const profile = session.profile;
  const liveConfig = CLI_LIVE_CONFIG[profile];
  if (!liveConfig) {
    _finalizeLiveCapture(linkId, sessionId, 'no-config');
    return;
  }

  // Check last 5 lines of ANSI-stripped output for prompt patterns
  const stripped = stripAnsi(link._captureBuffer);
  const lastLines = stripped.split('\n').slice(-5).join('\n');
  const promptFound = liveConfig.promptPatterns.some(p => p.test(lastLines));

  if (promptFound) {
    console.log(`[link-live] Prompt detected for ${profile}, finalizing`);
    _finalizeLiveCapture(linkId, sessionId, 'prompt-detected');
  } else {
    // No prompt found — set a short follow-up timer, then force finalize.
    // The idle timeout already means no output for idleMs; if still nothing
    // after another idleMs, the response is almost certainly done.
    console.log(`[link-live] Idle but no prompt for ${profile}, will finalize in ${liveConfig.idleMs}ms`);
    link._idleTimer = setTimeout(() => {
      _finalizeLiveCapture(linkId, sessionId, 'idle-no-prompt');
    }, liveConfig.idleMs);
  }
}

/**
 * Finalize a live PTY capture — strip ANSI, clean up, and relay.
 * Reuses onSidecarFinished() for history and auto-continue logic.
 */
function _finalizeLiveCapture(linkId, sessionId, reason) {
  const link = terminalLinks.get(linkId);
  if (!link) return;

  const session = terminalSessions.get(sessionId);
  const profile = session?.profile || 'unknown';

  console.log(`[link-live] Finalizing capture for ${profile}: ${reason}`);

  // Remove capture callback
  if (session) session._linkCaptureCallback = null;

  // Clear timers
  if (link._idleTimer) { clearTimeout(link._idleTimer); link._idleTimer = null; }
  if (link._maxIdleTimer) { clearTimeout(link._maxIdleTimer); link._maxIdleTimer = null; }

  // Extract clean text from VTermBuffer (proper terminal emulation).
  // Unlike regex stripAnsi(), VTermBuffer correctly handles cursor positioning,
  // spinner overwrites, and screen repaints — only the final visual state remains.
  let cleanOutput = '';
  const vterm = link._captureVTerm;
  if (vterm) {
    const sb = vterm.scrollbackLength;
    const totalRows = sb + vterm.rows;
    // Get all text: scrollback + visible screen
    cleanOutput = vterm.getText(0, 0, totalRows - 1, vterm.cols - 1);
    // Collapse excessive blank lines (TUI apps leave lots of empty rows)
    cleanOutput = cleanOutput.replace(/\n{3,}/g, '\n\n').trim();
  }

  // Fallback to regex stripping if VTermBuffer produced nothing
  if (!cleanOutput) {
    cleanOutput = stripAnsi(link._captureBuffer).trim();
  }

  console.log(`[link-live] Extracted text (${cleanOutput.length} chars, via ${vterm ? 'vterm' : 'regex'}): ${cleanOutput.slice(0, 300)}...`);

  // Strip injected echo — TUI CLIs echo back what was typed
  if (link._injectionEcho) {
    const echoText = link._injectionEcho.trim();
    // Strategy 1: prefix match
    if (cleanOutput.startsWith(echoText)) {
      cleanOutput = cleanOutput.slice(echoText.length).trim();
    } else {
      // Strategy 2: line-by-line match
      const echoLines = echoText.split('\n');
      const outputLines = cleanOutput.split('\n');
      let matched = 0;
      while (matched < echoLines.length && matched < outputLines.length) {
        if (outputLines[matched].trim() === echoLines[matched].trim()) {
          matched++;
        } else break;
      }
      if (matched > 0) {
        cleanOutput = outputLines.slice(matched).join('\n').trim();
      }
    }
  }

  // Strip trailing prompt patterns
  const liveConfig = CLI_LIVE_CONFIG[profile];
  if (liveConfig) {
    for (const pattern of liveConfig.promptPatterns) {
      cleanOutput = cleanOutput.replace(pattern, '').trim();
    }
  }

  // Reset live capture state
  link._captureBuffer = '';
  link._captureVTerm = null;
  link._captureSessionId = null;
  link._injectionEcho = '';

  if (cleanOutput) {
    onSidecarFinished(linkId, sessionId, cleanOutput);
  } else {
    link.status = 'idle';
    broadcastSync({ type: 'link:agent-finished', linkId, sessionId, profile });
    if (reason === 'max-idle-timeout') {
      broadcastSync({ type: 'link:error', linkId, error: `${profile}: No response detected (timed out)` });
    }
  }
}

/**
 * Forward a message to the next agent in the link chain.
 * Dispatches to sidecar or live mode based on link.mode.
 */
function relayToNextAgent(linkId, message) {
  const link = terminalLinks.get(linkId);
  if (!link) return;

  // Advance to next agent (round-robin)
  link.activeAgent = (link.activeAgent + 1) % link.sessions.length;
  const nextSessionId = link.sessions[link.activeAgent];
  const session = terminalSessions.get(nextSessionId);
  if (!session) {
    link.status = 'idle';
    broadcastSync({ type: 'link:error', linkId, error: 'Target session not found' });
    return;
  }

  link.status = 'running';

  // Cap message length (16KB — more generous since it's a CLI arg, not PTY)
  const MAX_RELAY_LEN = 16 * 1024;
  let relayMsg = message;
  if (relayMsg.length > MAX_RELAY_LEN) {
    relayMsg = relayMsg.slice(0, MAX_RELAY_LEN) + '\n\n[... response truncated]';
  }

  try {
    if (link.mode === 'live') {
      injectIntoLivePty(linkId, nextSessionId, relayMsg);
    } else {
      broadcastSync({ type: 'link:agent-started', linkId, sessionId: nextSessionId, profile: session.profile });
      spawnSidecarProcess(linkId, nextSessionId, relayMsg);
    }
  } catch (err) {
    link.status = 'idle';
    broadcastSync({ type: 'link:error', linkId, error: err.message });
  }
}

/**
 * User-initiated send — spawns sidecar for the specified (or first) agent.
 */
function sendToLink(linkId, message, targetIdx) {
  const link = terminalLinks.get(linkId);
  if (!link) throw new Error('Link not found');

  // Kill any running sidecar / clean up live capture
  if (link._sidecarProcess) {
    try { link._sidecarProcess.kill('SIGTERM'); } catch {}
    link._sidecarProcess = null;
  }
  if (link._captureSessionId) {
    const capSession = terminalSessions.get(link._captureSessionId);
    if (capSession) capSession._linkCaptureCallback = null;
    if (link._idleTimer) { clearTimeout(link._idleTimer); link._idleTimer = null; }
    if (link._maxIdleTimer) { clearTimeout(link._maxIdleTimer); link._maxIdleTimer = null; }
    link._captureBuffer = '';
    link._captureVTerm = null;
    link._captureSessionId = null;
  }

  const agentIdx = (typeof targetIdx === 'number') ? targetIdx : link.activeAgent;
  const sessionId = link.sessions[agentIdx];
  const session = terminalSessions.get(sessionId);
  if (!session) throw new Error('Target session not found');

  // Record in history as user message
  const entry = { role: 'user', sessionId: null, content: message, timestamp: Date.now() };
  link.history.push(entry);
  broadcastSync({ type: 'link:message', linkId, ...entry, turnCount: link.config.turnCount });

  // Set link to running
  link.activeAgent = agentIdx;
  link.status = 'running';

  // Dispatch based on mode
  if (link.mode === 'live') {
    injectIntoLivePty(linkId, sessionId, message);
  } else {
    broadcastSync({ type: 'link:agent-started', linkId, sessionId, profile: session.profile });
    spawnSidecarProcess(linkId, sessionId, message);
  }
}

// ── Terminal Link REST endpoints ──

app.get('/api/terminal/links', (req, res) => {
  const links = [...terminalLinks.entries()].map(([id, l]) => ({
    id,
    sessions: l.sessions.map(sid => {
      const s = terminalSessions.get(sid);
      return { id: sid, profile: s?.profile || 'unknown', cwd: s?.cwd };
    }),
    status: l.status,
    activeAgent: l.activeAgent,
    historyCount: l.history.length,
    mode: l.mode,
    config: { autoContinue: l.config.autoContinue, maxTurns: l.config.maxTurns, turnCount: l.config.turnCount },
    createdAt: l.createdAt,
  }));
  res.json({ links });
});

app.get('/api/terminal/links/:id', (req, res) => {
  const link = terminalLinks.get(req.params.id);
  if (!link) return res.status(404).json({ error: 'Link not found' });
  res.json({
    id: link.id,
    sessions: link.sessions.map(sid => {
      const s = terminalSessions.get(sid);
      return { id: sid, profile: s?.profile || 'unknown', cwd: s?.cwd };
    }),
    status: link.status,
    activeAgent: link.activeAgent,
    mode: link.mode,
    history: link.history,
    config: { autoContinue: link.config.autoContinue, maxTurns: link.config.maxTurns, turnCount: link.config.turnCount },
    createdAt: link.createdAt,
  });
});

app.post('/api/terminal/links', (req, res) => {
  const { sessions, autoContinue, maxTurns, mode } = req.body;
  if (!Array.isArray(sessions) || sessions.length < 2) {
    return res.status(400).json({ error: 'At least 2 session IDs required' });
  }
  try {
    const linkId = createTerminalLink(sessions, { autoContinue, maxTurns, mode });
    broadcastSync({ type: 'link:created', linkId, sessions, mode: mode || 'sidecar' });
    res.json({ linkId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/terminal/links/:id', (req, res) => {
  const link = terminalLinks.get(req.params.id);
  if (!link) return res.status(404).json({ error: 'Link not found' });
  const sessions = [...link.sessions];
  destroyTerminalLink(req.params.id);
  broadcastSync({ type: 'link:deleted', linkId: req.params.id, sessions });
  res.json({ ok: true });
});

app.patch('/api/terminal/links/:id', (req, res) => {
  const link = terminalLinks.get(req.params.id);
  if (!link) return res.status(404).json({ error: 'Link not found' });
  const { autoContinue, maxTurns } = req.body;
  if (typeof autoContinue === 'boolean') link.config.autoContinue = autoContinue;
  if (typeof maxTurns === 'number') link.config.maxTurns = maxTurns;
  res.json({ ok: true, config: link.config });
});

app.post('/api/terminal/links/:id/send', (req, res) => {
  const { message, targetIdx } = req.body;
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required' });
  }
  try {
    sendToLink(req.params.id, message, targetIdx);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/terminal/links/:id/pause', (req, res) => {
  const link = terminalLinks.get(req.params.id);
  if (!link) return res.status(404).json({ error: 'Link not found' });
  link.status = 'idle';
  link.config.autoContinue = false;
  // Kill any running sidecar process
  if (link._sidecarProcess) {
    try { link._sidecarProcess.kill('SIGTERM'); } catch {}
    link._sidecarProcess = null;
    link._sidecarSessionId = null;
  }
  // Clean up live capture
  if (link._captureSessionId) {
    const capSession = terminalSessions.get(link._captureSessionId);
    if (capSession) capSession._linkCaptureCallback = null;
    if (link._idleTimer) { clearTimeout(link._idleTimer); link._idleTimer = null; }
    if (link._maxIdleTimer) { clearTimeout(link._maxIdleTimer); link._maxIdleTimer = null; }
    link._captureBuffer = '';
    link._captureVTerm = null;
    link._captureSessionId = null;
  }
  broadcastSync({ type: 'link:paused', linkId: req.params.id, reason: 'manual' });
  res.json({ ok: true });
});

app.post('/api/terminal/links/:id/resume', (req, res) => {
  const link = terminalLinks.get(req.params.id);
  if (!link) return res.status(404).json({ error: 'Link not found' });
  link.config.autoContinue = true;
  broadcastSync({ type: 'link:resumed', linkId: req.params.id });
  res.json({ ok: true });
});

app.post('/api/terminal/links/:id/nudge', (req, res) => {
  const link = terminalLinks.get(req.params.id);
  if (!link) return res.status(404).json({ error: 'Link not found' });

  // Kill current sidecar / clean up live capture
  if (link._sidecarProcess) {
    try { link._sidecarProcess.kill('SIGTERM'); } catch {}
    link._sidecarProcess = null;
    link._sidecarSessionId = null;
  }
  if (link._captureSessionId) {
    const capSession = terminalSessions.get(link._captureSessionId);
    if (capSession) capSession._linkCaptureCallback = null;
    if (link._idleTimer) { clearTimeout(link._idleTimer); link._idleTimer = null; }
    if (link._maxIdleTimer) { clearTimeout(link._maxIdleTimer); link._maxIdleTimer = null; }
    link._captureBuffer = '';
    link._captureVTerm = null;
    link._captureSessionId = null;
  }

  // Get last agent message from history (or a nudge placeholder)
  const lastAgentMsg = [...link.history].reverse().find(h => h.role !== 'user');
  const relayContent = lastAgentMsg?.content || '[nudge — no previous response]';

  link.status = 'running';
  link.config.autoContinue = true;
  relayToNextAgent(link.id, relayContent);
  res.json({ ok: true });
});


// ═══════════════════════════════════════════
// BROWSER — Playwright-core CDP Manager
// ═══════════════════════════════════════════
//
// Manages headless/headed Chromium instances via playwright-core.
// Streams viewport via CDP Page.screencastFrame over WebSocket.
// Exposes CDP endpoint so Claude Code's Playwright MCP can connect.

const browserSessions = new Map(); // sessionId → { browser, context, page, clients, cdpSession, screencastActive, ... }
const BROWSER_GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 min before orphaned browser is killed

/** Check if a browser session is actively used by a running automation loop or agent. */
function isSessionUsedByActiveLoop(sessionId) {
  // Check agent registry first (agents use browser sessions directly)
  for (const agent of agentRegistry.values()) {
    if (agent.status === 'running' && agent.browserSessionId === sessionId) return true;
  }
  // Check loop state files
  if (!existsSync(LOOP_DIR)) return false;
  try {
    const files = readdirSync(LOOP_DIR).filter(f => f.endsWith('.json'));
    for (const f of files) {
      try {
        const data = JSON.parse(readFileSync(resolve(LOOP_DIR, f), 'utf-8'));
        if (data.active && data.browserSessionId === sessionId) return true;
      } catch {}
    }
  } catch {}
  return false;
}

// ── Real-time sync WebSocket (multi-client state broadcast) ──
const syncClients = new Set(); // Set<WebSocket>

function broadcastSync(message, excludeWs = null) {
  const data = JSON.stringify(message);
  let sent = 0;
  for (const client of syncClients) {
    if (client !== excludeWs && client.readyState === 1) { client.send(data); sent++; }
  }
  if (syncClients.size > 0) console.log(`[sync] broadcast "${message.type}" → ${sent}/${syncClients.size} clients`);
}

// Relayable message types (client → server → other clients)
const RELAYABLE_TYPES = new Set([
  'card:opened', 'card:closed', 'card:moved', 'card:resized', 'card:compacted', 'card:expanded',
  'terminal:session-created', 'terminal:session-deleted',
  'browser:session-created', 'browser:session-deleted',
  'link:created', 'link:deleted', 'link:message', 'link:agent-started', 'link:agent-finished',
  'link:paused', 'link:resumed', 'link:error', 'link:chunk',
]);

// Permission required per relay type prefix
const RELAY_PERM_MAP = { 'card:': 'cards', 'terminal:': 'terminal', 'link:': 'terminal' };

function handleSyncWebSocket(ws, req) {
  const guest = isGuestRequest(req);
  ws._isGuest = guest;
  syncClients.add(ws);
  console.log(`[sync] Client connected (${guest ? 'guest' : 'owner'}), total: ${syncClients.size}`);

  // Send initial state with role + permissions
  ws.send(JSON.stringify({
    type: 'connected',
    clients: syncClients.size,
    isGuest: guest,
    permissions: { ...invitePermissions },
  }));
  broadcastSync({ type: 'clients', count: syncClients.size });

  // Bidirectional relay: client → server → other clients
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (!msg.type || !RELAYABLE_TYPES.has(msg.type)) return;

      // Permission check for guest senders
      if (ws._isGuest) {
        const permKey = Object.entries(RELAY_PERM_MAP).find(([prefix]) => msg.type.startsWith(prefix));
        if (permKey && !invitePermissions[permKey[1]]) return; // silently drop
      }

      broadcastSync(msg, ws); // relay to everyone except sender
    } catch { /* ignore malformed */ }
  });

  ws.on('close', () => {
    syncClients.delete(ws);
    console.log(`[sync] Client disconnected (${ws._isGuest ? 'guest' : 'owner'}), total: ${syncClients.size}`);
    broadcastSync({ type: 'clients', count: syncClients.size });
  });
}

// ── Whiteboard WebSocket clients (Claude MCP integration) ──
const whiteboardClients = new Set(); // Set<WebSocket>
const whiteboardPendingScreenshots = new Map(); // requestId → { resolve, reject, timer }
let whiteboardViewport = { width: 1920, height: 937 }; // updated by browser on WS connect + resize

function broadcastToWhiteboard(message, excludeWs = null) {
  const data = JSON.stringify(message);
  for (const client of whiteboardClients) {
    if (client !== excludeWs && client.readyState === 1) client.send(data);
  }
}

// ── Browser config ──

const BROWSER_CONFIG_PATH = resolve(PROJECT_ROOT, 'data', 'browser-config.json');

function loadBrowserConfig() {
  try {
    if (!existsSync(BROWSER_CONFIG_PATH)) return {};
    return JSON.parse(readFileSync(BROWSER_CONFIG_PATH, 'utf-8'));
  } catch { return {}; }
}

function saveBrowserConfig(config) {
  const dir = dirname(BROWSER_CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(BROWSER_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Find a usable Chromium/Chrome executable.
 * Priority: user-configured path > common system locations > playwright bundled.
 */
function findBrowserExecutable(preferredChannel) {
  const config = loadBrowserConfig();
  if (config.executablePath && existsSync(config.executablePath)) {
    return config.executablePath;
  }

  const channel = preferredChannel || config.channel || '';
  const prefersEdge = /edge/i.test(channel);

  // Common Chrome/Chromium/Edge locations per platform
  // Order: Edge-first when channel is msedge, Chrome-first otherwise
  const edgeWin = [
    join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env['ProgramFiles'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  const chromeWin = [
    join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env['ProgramFiles'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env.LOCALAPPDATA || '', 'Chromium', 'Application', 'chrome.exe'),
  ];
  const edgeMac = [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
  const chromeMac = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    join(process.env.HOME || '', 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  const edgeLinux = [
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
  ];
  const chromeLinux = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];

  const candidates = IS_WIN
    ? (prefersEdge ? [...edgeWin, ...chromeWin] : [...chromeWin, ...edgeWin])
    : process.platform === 'darwin'
    ? (prefersEdge ? [...edgeMac, ...chromeMac] : [...chromeMac, ...edgeMac])
    : (prefersEdge ? [...edgeLinux, ...chromeLinux] : [...chromeLinux, ...edgeLinux]);

  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }

  return null; // Will let playwright-core try its default
}

/**
 * Detect Chrome/Edge/Chromium profile directories on the system.
 * Scans common User Data locations and reads Preferences files to get
 * human-readable profile names.
 */
function detectChromeProfiles() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const localAppData = process.env.LOCALAPPDATA || '';

  // Browser User Data root directories by platform
  const browserRoots = IS_WIN ? [
    { browser: 'Chrome', dir: join(localAppData, 'Google', 'Chrome', 'User Data') },
    { browser: 'Edge', dir: join(localAppData, 'Microsoft', 'Edge', 'User Data') },
    { browser: 'Chromium', dir: join(localAppData, 'Chromium', 'User Data') },
  ] : process.platform === 'darwin' ? [
    { browser: 'Chrome', dir: join(home, 'Library', 'Application Support', 'Google', 'Chrome') },
    { browser: 'Edge', dir: join(home, 'Library', 'Application Support', 'Microsoft Edge') },
    { browser: 'Chromium', dir: join(home, 'Library', 'Application Support', 'Chromium') },
  ] : [
    { browser: 'Chrome', dir: join(home, '.config', 'google-chrome') },
    { browser: 'Chromium', dir: join(home, '.config', 'chromium') },
    { browser: 'Edge', dir: join(home, '.config', 'microsoft-edge') },
  ];

  const profiles = [];

  for (const { browser, dir } of browserRoots) {
    if (!existsSync(dir)) continue;

    // Read Local State for authoritative profile names (Chrome updates names here, not in per-profile Preferences)
    let localStateNames = {};
    try {
      const lsPath = join(dir, 'Local State');
      if (existsSync(lsPath)) {
        const ls = JSON.parse(readFileSync(lsPath, 'utf-8'));
        const cache = ls?.profile?.info_cache || {};
        for (const [folder, info] of Object.entries(cache)) {
          if (info.name) localStateNames[folder] = info.name;
        }
      }
    } catch { /* Local State unavailable */ }

    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const folderName = entry.name;
      // Match "Default", "Profile 1", "Profile 2", etc.
      if (folderName !== 'Default' && !/^Profile \d+$/.test(folderName)) continue;

      const profileDir = join(dir, folderName);
      const prefsPath = join(profileDir, 'Preferences');
      if (!existsSync(prefsPath)) continue;

      // Prefer Local State name (authoritative after renames), fall back to per-profile Preferences
      let displayName = localStateNames[folderName] || folderName;
      if (!localStateNames[folderName]) {
        try {
          const prefs = JSON.parse(readFileSync(prefsPath, 'utf-8'));
          if (prefs.profile?.name) displayName = prefs.profile.name;
        } catch { /* use folder name */ }
      }

      profiles.push({
        browser,
        name: displayName,
        folder: folderName,
        path: profileDir.replace(/\\/g, '/'),
        isDefault: folderName === 'Default',
      });
    }
  }

  return profiles;
}

/**
 * Launch a browser session. Returns sessionId + CDP WebSocket URL.
 * Merges saved browser-config.json with per-session overrides, clones
 * the real browser's fingerprint from Neural Interface request headers.
 */
async function createBrowserSession(options = {}) {
  const sessionId = randomBytes(16).toString('hex');
  const savedCfg = loadBrowserConfig();
  // Resolve browser selector → channel (when no explicit channel is set)
  if (!savedCfg.channel && savedCfg.browser && savedCfg.browser !== 'auto' && savedCfg.browser !== 'custom') {
    savedCfg.channel = savedCfg.browser; // chrome, msedge, chromium
  }
  const execPath = findBrowserExecutable(savedCfg.channel);

  // Merge: saved config is base, per-session options override
  const vpW = options.width || savedCfg.viewport?.width || 1280;
  const vpH = options.height || savedCfg.viewport?.height || 800;

  // Always headed — headless mode is forbidden
  const headlessVal = false;

  // ── Stealth args: strip all headless indicators ──
  const stealthArgs = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-popup-blocking',
    `--window-size=${vpW},${vpH}`,
    '--disable-blink-features=AutomationControlled',
    '--disable-features=AutomationControlled',
    '--disable-infobars',
    '--disable-dev-shm-usage',
    '--enable-webgl',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    // Prevent Chrome from throttling rendering when the window loses OS focus.
    // Without these, CDP screencast freezes when the browser isn't the foreground app.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ];

  // Note: --use-gl=swiftshader removed — Playwright's new headless mode handles GPU
  // internally, and SwiftShader crashes with real Chrome profile data (incompatible
  // GPU caches). Let Playwright/Chromium pick the appropriate GL backend.

  // Platform-specific flags
  if (IS_WIN) {
    // Windows: sandbox can cause issues in some environments, GPU sandbox prevents GPU crashes
    stealthArgs.push('--no-sandbox', '--disable-gpu-sandbox');
  } else if (process.platform === 'linux') {
    // Linux: sandbox requires unprivileged user namespaces (not always available)
    stealthArgs.push('--no-sandbox');
  }
  // macOS: no --no-sandbox needed (sandbox works natively)

  // ── Resolve userDataDir ──
  // If the user selected a Chrome profile subfolder (e.g., Chrome/Profile 1), extract the
  // profile name and use the parent Chrome User Data root as userDataDir. Playwright's
  // launchPersistentContext needs --user-data-dir (the root), plus --profile-directory for
  // the specific profile. Without this split, Chrome creates a NEW Default profile inside
  // the subfolder instead of using the actual selected profile.
  let userDataDir = savedCfg.userDataDir || null;
  // Resolve relative paths to absolute against PROJECT_ROOT (e.g. "data/chrome-profile" → full path)
  if (userDataDir && !userDataDir.startsWith('/') && !(/^[A-Z]:/i.test(userDataDir))) {
    userDataDir = resolve(PROJECT_ROOT, userDataDir);
  }
  let _profileDirectory = null; // Chrome --profile-directory flag
  let _sourceProfilePath = null; // Original Chrome profile dir (for cookie bootstrap)
  let _isInsideChromeDir = false;
  let _sourceBrowser = null; // 'chrome' | 'msedge' | 'chromium' — which browser owns this profile

  if (userDataDir) {
    const normalized = userDataDir.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();

    // Known Chrome/Edge/Chromium User Data root directories per platform
    const _home = process.env.HOME || process.env.USERPROFILE || '';
    const chromeRootDefs = IS_WIN ? [
      { root: ((process.env.LOCALAPPDATA || '') + '/Google/Chrome/User Data').replace(/\\/g, '/').toLowerCase(), browser: 'chrome' },
      { root: ((process.env['ProgramFiles'] || '') + '/Google/Chrome/User Data').replace(/\\/g, '/').toLowerCase(), browser: 'chrome' },
    ] : process.platform === 'darwin' ? [
      { root: (_home + '/Library/Application Support/Google/Chrome').toLowerCase(), browser: 'chrome' },
      { root: (_home + '/Library/Application Support/Microsoft Edge').toLowerCase(), browser: 'msedge' },
      { root: (_home + '/Library/Application Support/Chromium').toLowerCase(), browser: 'chromium' },
    ] : [
      { root: (_home + '/.config/google-chrome').toLowerCase(), browser: 'chrome' },
      { root: (_home + '/.config/chromium').toLowerCase(), browser: 'chromium' },
      { root: (_home + '/.config/microsoft-edge').toLowerCase(), browser: 'msedge' },
    ];

    // Extract profile directory if path points to a profile subfolder
    for (const { root, browser: rootBrowser } of chromeRootDefs.filter(d => d.root)) {
      if (normalized.startsWith(root + '/')) {
        const remainder = normalized.slice(root.length + 1).replace(/\/+$/, '');
        if (/^(default|profile \d+)$/.test(remainder)) {
          _sourceProfilePath = userDataDir;
          const parts = userDataDir.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
          _profileDirectory = parts.pop(); // "Profile 1", "Default", etc.
          userDataDir = parts.join('/');    // Chrome User Data root
          _isInsideChromeDir = true;
          _sourceBrowser = rootBrowser;
          console.log(`[browser] Detected ${rootBrowser} profile: --profile-directory=${_profileDirectory}`);
          console.log(`[browser] Using ${rootBrowser} User Data dir: ${userDataDir}`);
          break;
        }
      }
      if (normalized === root) {
        _isInsideChromeDir = true;
        _sourceBrowser = rootBrowser;
        break;
      }
    }
  }

  // Only disable extensions when NOT using a user profile (they'd want their extensions)
  if (!userDataDir) {
    stealthArgs.push('--disable-extensions');
  }

  // NOTE: --profile-directory is deferred until after Chrome conflict check (mirror may clear it)

  // Append user's extra launch args from config
  if (savedCfg.extraArgs) {
    const extra = savedCfg.extraArgs.split(/\s+/).filter(Boolean);
    stealthArgs.push(...extra);
  }
  const launchOpts = { headless: headlessVal, args: stealthArgs };
  // Priority: user-configured executablePath > channel > auto-detected executablePath.
  // User explicitly set executablePath = intentional override, always respect it.
  // Channel = let Playwright resolve the binary for that browser brand.
  // Auto-detected = fallback when nothing else is configured.
  const hasUserExecPath = savedCfg.executablePath && existsSync(savedCfg.executablePath);
  if (hasUserExecPath) {
    launchOpts.executablePath = savedCfg.executablePath;
  } else if (savedCfg.channel) {
    launchOpts.channel = savedCfg.channel;
  } else if (execPath) {
    launchOpts.executablePath = execPath;
  }
  if (savedCfg.slowMo) launchOpts.slowMo = savedCfg.slowMo;
  if (savedCfg.timeout) launchOpts.timeout = savedCfg.timeout;

  // Proxy at browser level
  if (savedCfg.proxy?.server) {
    launchOpts.proxy = {
      server: savedCfg.proxy.server,
      ...(savedCfg.proxy.bypass ? { bypass: savedCfg.proxy.bypass } : {}),
      ...(savedCfg.proxy.username ? { username: savedCfg.proxy.username } : {}),
      ...(savedCfg.proxy.password ? { password: savedCfg.proxy.password } : {}),
    };
  }

  // ── Browser fingerprint ──
  // Don't clone the UI browser's user-agent or sec-ch-ua into the automated browser.
  // When the Neural Interface is opened in Safari or a different Chrome version, cloning
  // creates a fingerprint mismatch (e.g., Chrome sending Safari's UA) that triggers bot
  // detection on sites like Twitter. Let the automated Chrome use its own default UA.
  const realHeaders = options._realHeaders || {};
  const userAgent = savedCfg.userAgent || undefined; // only override if explicitly configured
  const cfgAcceptLang = savedCfg.acceptLanguage || null;
  const acceptLanguage = cfgAcceptLang || realHeaders['accept-language'] || 'en-US,en;q=0.9';
  const locale = savedCfg.locale || acceptLanguage.split(',')[0].split(';')[0] || 'en-US';

  // Build context options from saved config
  const contextOpts = {
    viewport: { width: vpW, height: vpH },
    ...(userAgent ? { userAgent } : {}), // omit entirely to let Chrome use its own default
    locale,
    timezoneId: savedCfg.timezoneId || options.timezone || undefined,
    screen: savedCfg.screen || { width: options.screenWidth || 1920, height: options.screenHeight || 1080 },
    deviceScaleFactor: savedCfg.deviceScaleFactor || options.deviceScaleFactor || 1,
    isMobile: savedCfg.isMobile || false,
    hasTouch: savedCfg.hasTouch || false,
    javaScriptEnabled: savedCfg.javaScriptEnabled !== false,
    ignoreHTTPSErrors: savedCfg.ignoreHTTPSErrors || false,
    bypassCSP: savedCfg.bypassCSP || false,
    acceptDownloads: savedCfg.acceptDownloads !== false,
    strictSelectors: savedCfg.strictSelectors !== false,
    serviceWorkers: savedCfg.serviceWorkers || 'allow',
    offline: savedCfg.offline || false,
    // Extra HTTP headers: Accept-Language from config/UI + any user-configured extras
    // sec-ch-ua headers are NOT cloned — let Chrome generate its own consistent set
    extraHTTPHeaders: {
      'Accept-Language': acceptLanguage,
      ...(savedCfg.extraHTTPHeaders || {}),
    },
  };

  // Appearance
  if (savedCfg.colorScheme) contextOpts.colorScheme = savedCfg.colorScheme;
  if (savedCfg.reducedMotion) contextOpts.reducedMotion = savedCfg.reducedMotion;
  if (savedCfg.forcedColors) contextOpts.forcedColors = savedCfg.forcedColors;

  // Geolocation
  if (savedCfg.geolocation) contextOpts.geolocation = savedCfg.geolocation;

  // Permissions
  if (savedCfg.permissions?.length) contextOpts.permissions = savedCfg.permissions;

  // HTTP credentials
  if (savedCfg.httpCredentials?.username) contextOpts.httpCredentials = savedCfg.httpCredentials;

  // Navigation timeout
  if (savedCfg.navigationTimeout) contextOpts.navigationTimeout = savedCfg.navigationTimeout;

  // Recording: video
  if (savedCfg.recordVideo?.dir) contextOpts.recordVideo = savedCfg.recordVideo;

  // Recording: HAR
  if (savedCfg.recordHar?.path) contextOpts.recordHar = savedCfg.recordHar;

  // Storage state: restore for clean contexts via contextOpts (persistent contexts restored post-launch)
  const STORAGE_STATE_PATH = resolve(PROJECT_ROOT, savedCfg.storageStatePath || 'data/browser-storage.json');
  if (!userDataDir && savedCfg.persistStorage !== false && !savedCfg.clearStorageOnStart && existsSync(STORAGE_STATE_PATH)) {
    try {
      contextOpts.storageState = STORAGE_STATE_PATH;
    } catch (e) {
      console.warn('Failed to load storage state:', e.message);
    }
  }

  let browser, context, page;
  let _isPersistent = false;
  let _profileMode = userDataDir ? 'direct' : 'clean';
  let _profileSourceName = _profileDirectory || (userDataDir ? 'Default' : null);

  if (userDataDir) {
    // ── Persistent context: uses a Chrome profile directory ──
    // launchPersistentContext returns a BrowserContext directly — no separate browser.newContext()
    _isPersistent = true;

    // ── Profile mirror system ──
    // When userDataDir points inside a real Chrome/Edge/Chromium User Data directory:
    //   - If the source browser is NOT running: use the real profile directly with the
    //     system browser binary. Full cookies, extensions, sessions — best experience.
    //   - If the source browser IS running: mirror auth-critical files to an isolated dir
    //     and launch with Playwright Chromium (avoids singleton/lock conflicts).
    //     Cookies are encrypted on macOS and won't transfer, but Local Storage/IndexedDB will.
    const _browserLabel = _sourceBrowser === 'msedge' ? 'Edge' : _sourceBrowser === 'chromium' ? 'Chromium' : 'Chrome';
    if (_isInsideChromeDir) {
      // ── Always mirror: Chrome refuses remote debugging on its own User Data dir ──
      // Direct mode causes "DevTools remote debugging requires a non-default data directory"
      // and a 30s timeout. Mirror mode works reliably regardless of whether Chrome is running.
      _profileMode = 'mirror';
      console.log(`[browser] ${_browserLabel} profile detected — using mirror mode`);

      const profileHash = createHash('md5').update(_sourceProfilePath || userDataDir).digest('hex').slice(0, 12);
      const mirrorRoot = resolve(PROJECT_ROOT, 'data', 'browser-profiles', profileHash);
      // Wipe mirror dir completely on every launch. Stale GPU/shader caches from a
      // different Chromium version (e.g., Playwright Chromium vs system Chrome) crash
      // the browser. Auth files are re-synced below, so nothing is lost.
      try {
        if (existsSync(mirrorRoot)) { rmSync(mirrorRoot, { recursive: true, force: true }); }
      } catch (e) { console.warn(`[browser] Could not clean mirror dir: ${e.message}`); }
      const mirrorDefault = resolve(mirrorRoot, 'Default');
      mkdirSync(mirrorDefault, { recursive: true });
      console.log(`[browser] Mirroring ${_profileSourceName} → ${mirrorRoot} (clean)`);

      // Sync root-level files from Chrome User Data dir to mirror root.
      // Chrome CRASHES without Local State (GPU config, encryption keys, profile metadata).
      // userDataDir here is still the Chrome User Data root (before reassignment to mirrorRoot).
      const chromeRoot = userDataDir; // e.g., ~/Library/Application Support/Google/Chrome
      const rootFilesToSync = ['Local State', 'First Run', 'Last Version'];
      for (const file of rootFilesToSync) {
        const src = resolve(chromeRoot, file);
        const dst = resolve(mirrorRoot, file);
        try {
          if (existsSync(src)) copyFileSync(src, dst);
        } catch (e) {
          if (file === 'Local State') console.warn(`[browser] Could not copy ${file}: ${e.message}`);
        }
      }
      // Create First Run marker if it doesn't exist (prevents first-run wizard)
      const firstRunPath = resolve(mirrorRoot, 'First Run');
      if (!existsSync(firstRunPath)) {
        try { writeFileSync(firstRunPath, ''); } catch {}
      }

      // Full recursive copy of the source profile into mirror's Default/
      // Using the same Chrome binary means GPU/shader caches are compatible.
      if (_sourceProfilePath && existsSync(_sourceProfilePath)) {
        try {
          cpSync(_sourceProfilePath, mirrorDefault, { recursive: true, force: true });
          console.log(`[browser] Full profile copy: ${_profileSourceName} → mirror Default/`);
        } catch (e) {
          console.warn(`[browser] Full profile copy failed, falling back to partial: ${e.message}`);
        }
        // Remove ALL SQLite journals and LevelDB locks recursively.
        // Chrome profiles have 20+ SQLite databases — a hardcoded list misses many
        // (History, DIPS, Network Action Predictor, etc.) causing "error opening
        // your profile" when databases are copied mid-transaction while Chrome runs.
        const junkPatterns = /(-wal|-shm|-journal)$/;
        const junkExact = new Set(['LOCK', 'lockfile', 'LOG', 'LOG.old']);
        let cleanedCount = 0;
        try {
          const entries = readdirSync(mirrorDefault, { recursive: true });
          for (const rel of entries) {
            const name = (typeof rel === 'string' ? rel : String(rel)).split('/').pop();
            if (junkPatterns.test(name) || junkExact.has(name)) {
              const full = resolve(mirrorDefault, typeof rel === 'string' ? rel : String(rel));
              try { unlinkSync(full); cleanedCount++; } catch {}
            }
          }
        } catch {}
        if (cleanedCount) console.log(`[browser] Cleaned ${cleanedCount} lock/journal files from mirror profile`);
      }
      userDataDir = mirrorRoot;
      _profileDirectory = null; // mirror uses "Default" subfolder directly

      // Clean singleton lock files from the mirror dir
      for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
        const lf = resolve(userDataDir, lockFile);
        try { if (existsSync(lf)) { unlinkSync(lf); console.log(`[browser] Removed stale ${lockFile}`); } } catch {}
      }

      // Mirror mode: use the system browser binary for full compatibility.
      // The full profile was copied recursively, so GPU/shader caches are compatible
      // with the same Chrome version. Add GPU-safety flags to prevent crashes from
      // stale caches that may have been mid-write when copied.
      stealthArgs.push('--disable-gpu-shader-disk-cache', '--disable-gpu-program-cache');
      // Keep the system executable already set in launchOpts — do NOT override with Playwright Chromium.
      // If no system executable was found, fall back to Playwright Chromium as last resort.
      if (!launchOpts.executablePath && !launchOpts.channel) {
        try {
          const pwPath = chromium.executablePath();
          if (existsSync(pwPath)) {
            launchOpts.executablePath = pwPath;
            console.log(`[browser] Mirror: no system browser found, falling back to Playwright Chromium`);
          }
        } catch {}
      } else {
        console.log(`[browser] Mirror: using system ${_browserLabel} binary (full profile copy)`);
      }

      broadcastSync({ type: 'notification', level: 'info', message: `Using profile copy of ${_profileSourceName} for browser automation.` });
    }

    // Clean singleton lock files for ALL persistent profiles (not just mirrors)
    // Stale locks from previous crashed sessions prevent browser launch
    for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      const lf = resolve(userDataDir, lockFile);
      try { if (existsSync(lf)) { unlinkSync(lf); console.log(`[browser] Removed stale ${lockFile}`); } } catch {}
    }

    // Add --profile-directory if targeting a specific profile subfolder (e.g., "Profile 1")
    // Mirror mode clears _profileDirectory (uses "Default" directly), so this only applies to non-Chrome profiles
    if (_profileDirectory) {
      stealthArgs.push(`--profile-directory=${_profileDirectory}`);
      console.log(`[browser] Using --profile-directory=${_profileDirectory}`);
    }

    // Pre-launch: clean crash markers to prevent "didn't shut down correctly" dialog
    const _prefsFile = resolve(userDataDir, _profileDirectory || 'Default', 'Preferences');
    if (existsSync(_prefsFile)) {
      try {
        const _prefs = JSON.parse(readFileSync(_prefsFile, 'utf-8'));
        if (_prefs.profile) {
          _prefs.profile.exit_type = 'Normal';
          _prefs.profile.exited_cleanly = true;
          writeFileSync(_prefsFile, JSON.stringify(_prefs));
        }
      } catch {}
    }

    const _persistentLaunchOpts = {
      ...launchOpts,
      ...contextOpts,
      ignoreDefaultArgs: [
        '--disable-extensions',
        '--disable-component-extensions-with-background-pages',
        '--disable-default-apps',
        '--enable-automation',
        '--disable-sync',
        // Keep --password-store=basic and --use-mock-keychain (Playwright defaults).
        // These ensure cookies are stored in portable basic format, not encrypted
        // via system keychain — prevents cookie loss when browser executable changes.
      ],
    };

    console.log(`[browser] Launching persistent context at: ${userDataDir}${_profileDirectory ? ` (profile: ${_profileDirectory})` : ''}`);
    try {
      context = await chromium.launchPersistentContext(userDataDir, _persistentLaunchOpts);
    } catch (err) {
      const msg = err.message || '';
      if (msg.includes('ProcessSingleton') || msg.includes('already in use') || msg.includes('lock') || msg.includes('SingletonLock')) {
        throw new Error(`Browser profile is locked — close all ${_browserLabel || 'Chrome'} windows using this profile and try again. Original error: ${msg}`);
      }
      throw err;
    }

    // Verify the browser is still alive — singleton may cause immediate exit
    await new Promise(r => setTimeout(r, 500));
    let contextAlive = true;
    try {
      const testPages = context.pages();
      if (testPages.length === 0) contextAlive = false;
    } catch { contextAlive = false; }

    if (!contextAlive) {
      throw new Error(`Browser closed immediately after launch — ${_browserLabel || 'Chrome'} is likely already running with this profile. Close ALL ${_browserLabel || 'Chrome'} windows and background processes (check system tray), then try again.`);
    }
    browser = context; // persistent context IS the top-level object (no parent browser)

    // Close any restored tabs from previous Chrome session, then open a fresh page
    const existingPages = context.pages();
    page = await context.newPage();
    for (const p of existingPages) {
      await p.close().catch(() => {});
    }
  } else {
    // ── Standard: clean sandboxed browser ──
    browser = await chromium.launch(launchOpts);
    context = await browser.newContext(contextOpts);
    page = await context.newPage();
  }

  // ── Restore saved cookies/localStorage from storageState ──
  // For persistent/mirror contexts, Playwright doesn't support storageState as a launch option,
  // so we inject cookies after launch. For clean contexts, storageState was already set via contextOpts.
  if (_isPersistent && savedCfg.persistStorage !== false && !savedCfg.clearStorageOnStart) {
    const _storageStatePath = resolve(PROJECT_ROOT, savedCfg.storageStatePath || 'data/browser-storage.json');
    if (existsSync(_storageStatePath)) {
      try {
        const savedState = JSON.parse(readFileSync(_storageStatePath, 'utf-8'));
        if (savedState.cookies && savedState.cookies.length > 0) {
          await context.addCookies(savedState.cookies);
          console.log(`[browser] Restored ${savedState.cookies.length} cookies from ${_storageStatePath}`);
        }
        // Restore localStorage lazily via addInitScript — injects stored items
        // on first visit to each origin, before page scripts run. Avoids creating
        // extra pages/tabs and navigating to every saved origin on launch.
        if (savedState.origins && savedState.origins.length > 0) {
          const storageMap = {};
          for (const origin of savedState.origins) {
            if (origin.localStorage && origin.localStorage.length > 0) {
              storageMap[origin.origin] = origin.localStorage;
            }
          }
          if (Object.keys(storageMap).length > 0) {
            await context.addInitScript(`(function() {
              var m = ${JSON.stringify(storageMap)};
              var k = '__synabun_ls_restored_' + location.origin;
              var items = m[location.origin];
              if (items && !sessionStorage.getItem(k)) {
                for (var i = 0; i < items.length; i++) {
                  try { localStorage.setItem(items[i].name, items[i].value); } catch(e) {}
                }
                try { sessionStorage.setItem(k, '1'); } catch(e) {}
              }
            })()`);
            console.log(`[browser] Registered lazy localStorage restore for ${Object.keys(storageMap).length} origins`);
          }
        }
      } catch (e) {
        console.warn(`[browser] Failed to restore storage state: ${e.message}`);
      }
    }
  }

  // ── CDP stealth injections (if enabled) ──
  const doStealth = savedCfg.stealthFingerprint !== false;
  if (doStealth) {
    const cdpStealth = await page.context().newCDPSession(page);
    try {
      await cdpStealth.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          Object.defineProperty(navigator, 'webdriver', { get: () => false });
          Object.defineProperty(navigator, 'plugins', {
            get: () => [
              { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
              { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
              { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
            ],
          });
          Object.defineProperty(navigator, 'languages', {
            get: () => ${JSON.stringify(acceptLanguage.split(',').map(l => l.split(';')[0].trim()))},
          });
          const origQuery = window.Permissions.prototype.query;
          window.Permissions.prototype.query = function(params) {
            if (params.name === 'notifications') {
              return Promise.resolve({ state: 'default', onchange: null });
            }
            return origQuery.call(this, params);
          };
          if (!window.chrome) window.chrome = {};
          if (!window.chrome.runtime) window.chrome.runtime = { connect: () => {}, sendMessage: () => {} };
          delete window.cdc_adoQpoasnfa76pfcZLmcfl_;
          delete window.__playwright;
        `,
      });
    } catch (err) {
      console.warn('CDP stealth injection warning:', err.message);
    }
    await cdpStealth.detach().catch(() => {});
  }

  // Navigate to initial URL or blank
  const startUrl = options.url || 'about:blank';
  await page.goto(startUrl).catch((err) => {
    console.warn('Initial navigation warning:', err.message);
  });

  // Wait for page to be ready before attaching CDP
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  // Get CDP session for screencast
  console.log('[browser] Creating CDP session... persistent:', !!_isPersistent, 'page url:', page.url());
  let cdpSession;
  try {
    cdpSession = await context.newCDPSession(page);
    console.log('[browser] CDP session created successfully via context');
  } catch (err) {
    console.error('[browser] CDP session creation failed:', err.message);
    throw new Error('Cannot create CDP session for screencast: ' + err.message);
  }

  // Generate first tab ID
  const firstTabId = randomBytes(4).toString('hex');

  const session = {
    browser,
    context,
    page,              // alias → active tab's page (backward compat)
    cdpSession,        // alias → active tab's CDP session (backward compat)
    _isPersistent,
    _profileMode: _profileMode || 'clean',
    _profileSourceName: _profileSourceName || null,
    clients: new Set(),       // WebSocket connections for screencast
    screencastActive: false,
    createdAt: Date.now(),
    graceTimer: null,
    currentUrl: startUrl,
    title: await page.title().catch(() => ''),
    // ── Multi-tab support ──
    tabs: new Map(),          // tabId → { page, cdpSession, url, title }
    activeTabId: firstTabId,
  };

  // Register the first tab
  session.tabs.set(firstTabId, {
    page,
    cdpSession,
    url: startUrl,
    title: session.title,
  });

  // Wire page events for a tab (reusable for new tabs)
  function wireTabPageEvents(tabId, tabPage) {
    tabPage.on('framenavigated', async (frame) => {
      if (frame === tabPage.mainFrame()) {
        const url = tabPage.url();
        const title = await tabPage.title().catch(() => '');
        const tabEntry = session.tabs.get(tabId);
        if (tabEntry) { tabEntry.url = url; tabEntry.title = title; }
        // Only broadcast to clients if this is the active tab
        if (session.activeTabId === tabId) {
          session.currentUrl = url;
          session.title = title;
          const msg = JSON.stringify({ type: 'navigated', url, title });
          session.clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
        }
      }
    });

    tabPage.on('load', async () => {
      const title = await tabPage.title().catch(() => '');
      const tabEntry = session.tabs.get(tabId);
      if (tabEntry) { tabEntry.title = title; tabEntry.url = tabPage.url(); }
      if (session.activeTabId === tabId) {
        session.title = title;
        const msg = JSON.stringify({ type: 'loaded', url: tabPage.url(), title });
        session.clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
      }
    });

    tabPage.on('close', () => {
      console.log(`Browser tab ${tabId} page closed for session ${sessionId}`);
      session.tabs.delete(tabId);
      // If active tab closed, switch to another tab if available
      if (session.activeTabId === tabId) {
        const remaining = [...session.tabs.keys()];
        if (remaining.length > 0) {
          _switchSessionTab(session, sessionId, remaining[0]).catch(() => {});
        } else {
          // No tabs left — notify clients
          session.clients.forEach(ws => {
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'error', message: 'All tabs closed' }));
              ws.close(1000, 'All tabs closed');
            }
          });
          session.clients.clear();
        }
      }
      broadcastSync({ type: 'browser:tab-closed', sessionId, tabId, remainingTabs: session.tabs.size });
    });
  }

  // Wire events for the first tab
  wireTabPageEvents(firstTabId, page);
  // Store the wiring function on the session for creating new tabs
  session._wireTabPageEvents = wireTabPageEvents;

  // Handle context close (browser quit)
  context.on('close', () => {
    console.log(`Browser context closed for session ${sessionId}`);
    session.clients.forEach(ws => {
      if (ws.readyState === 1) ws.close(1000, 'Browser closed');
    });
    session.clients.clear();
    browserSessions.delete(sessionId);
    broadcastSync({ type: 'browser:session-deleted', sessionId });
  });

  browserSessions.set(sessionId, session);
  return {
    sessionId,
    wsEndpoint: _isPersistent ? null : (browser.wsEndpoint?.() || null),
    profileMode: _profileMode || 'clean',
    profileSource: _profileSourceName || null,
  };
}

/**
 * Start CDP screencast — streams JPEG frames to all connected WebSocket clients.
 */
async function startScreencast(session) {
  if (session.screencastActive) return;
  session.screencastActive = true;

  console.log('[screencast] Starting screencast, CDP session exists:', !!session.cdpSession, 'persistent:', !!session._isPersistent);

  let frameCount = 0;
  session.cdpSession.on('Page.screencastFrame', async (params) => {
    frameCount++;
    if (frameCount <= 3) console.log(`[screencast] Frame #${frameCount} received (${params.data?.length || 0} chars)`);
    const msg = JSON.stringify({
      type: 'frame',
      data: params.data,               // base64 JPEG
      metadata: params.metadata,        // { offsetTop, pageScaleFactor, ... }
      sessionId: params.sessionId,      // CDP ack ID
    });
    session.clients.forEach(ws => {
      // Skip clients with congested write buffers to prevent frame backlog
      if (ws.readyState === 1 && ws.bufferedAmount < 512 * 1024) ws.send(msg);
    });

    // Acknowledge frame to keep the stream going
    try {
      await session.cdpSession.send('Page.screencastFrameAck', {
        sessionId: params.sessionId,
      });
    } catch {}
  });

  const scCfg = loadBrowserConfig().screencast || {};
  try {
    await session.cdpSession.send('Page.startScreencast', {
      format: scCfg.format || 'jpeg',
      quality: scCfg.quality ?? 60,
      maxWidth: scCfg.maxWidth || 1280,
      maxHeight: scCfg.maxHeight || 800,
      everyNthFrame: scCfg.everyNthFrame || 2,
    });
    console.log('[screencast] Page.startScreencast sent successfully');
  } catch (err) {
    console.error('[screencast] Page.startScreencast FAILED:', err.message);
    session.screencastActive = false;
    throw err;
  }
}

async function stopScreencast(session) {
  if (!session.screencastActive) return;
  session.screencastActive = false;
  try {
    await session.cdpSession.send('Page.stopScreencast');
  } catch {}
}

// ── Multi-tab helpers ──

/**
 * Create a new tab (page) in an existing browser session.
 * Returns { tabId, url, title }.
 */
async function createSessionTab(session, sessionId, url = 'about:blank') {
  const tabId = randomBytes(4).toString('hex');
  const page = await session.context.newPage();
  if (url && url !== 'about:blank') {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  }
  const cdpSession = await session.context.newCDPSession(page);
  const title = await page.title().catch(() => '');

  session.tabs.set(tabId, { page, cdpSession, url: page.url(), title });
  if (session._wireTabPageEvents) session._wireTabPageEvents(tabId, page);

  console.log(`[browser] New tab ${tabId} created in session ${sessionId} (total: ${session.tabs.size})`);
  broadcastSync({ type: 'browser:tab-created', sessionId, tabId, url: page.url(), title, tabCount: session.tabs.size });
  return { tabId, url: page.url(), title };
}

/**
 * Switch the active tab — stops screencast on old tab, starts on new one.
 * Updates backward-compat aliases (session.page, session.cdpSession).
 */
async function _switchSessionTab(session, sessionId, tabId) {
  const tabEntry = session.tabs.get(tabId);
  if (!tabEntry) throw new Error(`Tab ${tabId} not found`);
  if (session.activeTabId === tabId) return; // already active

  // Stop screencast on current tab
  await stopScreencast(session);

  // Switch aliases
  session.activeTabId = tabId;
  session.page = tabEntry.page;
  session.cdpSession = tabEntry.cdpSession;
  session.currentUrl = tabEntry.url;
  session.title = tabEntry.title;

  // Start screencast on new tab
  await startScreencast(session);

  // Notify clients of the switch
  const msg = JSON.stringify({
    type: 'tab-switched',
    tabId,
    url: session.currentUrl,
    title: session.title,
    tabCount: session.tabs.size,
  });
  session.clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });

  console.log(`[browser] Switched to tab ${tabId} in session ${sessionId}`);
  broadcastSync({ type: 'browser:tab-switched', sessionId, tabId, url: session.currentUrl, title: session.title });
}

/**
 * Close a single tab in a session. If it's the last tab, destroys the whole session.
 */
async function closeSessionTab(session, sessionId, tabId) {
  const tabEntry = session.tabs.get(tabId);
  if (!tabEntry) return;

  session.tabs.delete(tabId);

  if (session.tabs.size === 0) {
    // Last tab — destroy the whole session
    await destroyBrowserSession(sessionId);
    return;
  }

  // If closing the active tab, switch to another
  if (session.activeTabId === tabId) {
    const nextTabId = [...session.tabs.keys()][0];
    await _switchSessionTab(session, sessionId, nextTabId);
  }

  // Close the page
  try { await tabEntry.page.close(); } catch {}
  console.log(`[browser] Tab ${tabId} closed in session ${sessionId} (remaining: ${session.tabs.size})`);
}

/**
 * Clean up a browser session.
 */
async function destroyBrowserSession(sessionId) {
  const session = browserSessions.get(sessionId);
  if (!session) return;

  // Remove from Map immediately to prevent races (new sessions seeing zombie entries)
  browserSessions.delete(sessionId);

  // Save storage state (cookies, localStorage) for ALL context types.
  // Mirror dirs get wiped on next launch, so storageState is the only way
  // to preserve sessions (Twitter logins, etc.) across browser restarts.
  const savedCfg = loadBrowserConfig();
  if (savedCfg.persistStorage !== false && session.context) {
    const storagePath = resolve(PROJECT_ROOT, savedCfg.storageStatePath || 'data/browser-storage.json');
    try {
      const dir = dirname(storagePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      await session.context.storageState({ path: storagePath });
      console.log(`  Storage state saved to ${storagePath}`);
    } catch (err) {
      console.warn('Failed to save storage state:', err.message);
    }
  }

  if (session.graceTimer) clearTimeout(session.graceTimer);
  try { await stopScreencast(session); } catch {}
  if (session._isPersistent) {
    // Persistent context: close the context which also kills the browser process
    try { await session.context.close(); } catch {}
    // Mark profile as cleanly exited so next launch doesn't show crash dialog
    // Check both the config's userDataDir and any mirror profile directories
    const _cfg = loadBrowserConfig();
    const dirsToClean = [];
    if (_cfg.userDataDir) {
      dirsToClean.push(_cfg.userDataDir, resolve(PROJECT_ROOT, _cfg.userDataDir));
    }
    // Also clean mirror profile dirs
    const mirrorsDir = resolve(PROJECT_ROOT, 'data', 'browser-profiles');
    if (existsSync(mirrorsDir)) {
      try {
        for (const entry of readdirSync(mirrorsDir, { withFileTypes: true })) {
          if (entry.isDirectory()) dirsToClean.push(resolve(mirrorsDir, entry.name));
        }
      } catch {}
    }
    for (const base of dirsToClean) {
      const pp = resolve(base, 'Default', 'Preferences');
      if (existsSync(pp)) {
        try {
          const prefs = JSON.parse(readFileSync(pp, 'utf-8'));
          if (prefs.profile) {
            prefs.profile.exit_type = 'Normal';
            prefs.profile.exited_cleanly = true;
          }
          writeFileSync(pp, JSON.stringify(prefs));
        } catch {}
      }
    }
  } else {
    try { await session.browser.close(); } catch {}
  }
  broadcastSync({ type: 'browser:session-deleted', sessionId });
}

// ── Browser REST endpoints ──

app.get('/api/browser/sessions', (req, res) => {
  const sessions = [...browserSessions.entries()].map(([id, s]) => ({
    id,
    url: s.currentUrl,
    title: s.title,
    createdAt: s.createdAt,
    clients: s.clients.size,
    persistent: !!s._isPersistent,
    profileMode: s._profileMode || 'clean',
    profileSource: s._profileSourceName || null,
    wsEndpoint: s._isPersistent ? null : (s.browser.wsEndpoint?.() || null),
    activeTabId: s.activeTabId || null,
    tabs: s.tabs ? [...s.tabs.entries()].map(([tid, t]) => ({
      id: tid,
      url: t.url,
      title: t.title,
      active: tid === s.activeTabId,
    })) : [],
  }));
  res.json({ sessions });
});

app.post('/api/browser/sessions', async (req, res) => {
  const { url, width, height, screenWidth, screenHeight, deviceScaleFactor, timezone } = req.body;
  try {
    // Pass accept-language from the UI browser for locale matching.
    // user-agent and sec-ch-ua are NOT cloned — the automated Chrome generates its own
    // to avoid fingerprint mismatches when the UI runs in Safari/Firefox/different Chrome.
    const _realHeaders = {
      'accept-language': req.headers['accept-language'],
    };
    const result = await createBrowserSession({
      url, width, height, screenWidth, screenHeight, deviceScaleFactor, timezone, _realHeaders,
    });
    broadcastSync({ type: 'browser:session-created', sessionId: result.sessionId, url: url || 'about:blank', profileMode: result.profileMode, profileSource: result.profileSource });
    res.json({ sessionId: result.sessionId, url: url || 'about:blank', wsEndpoint: result.wsEndpoint, profileMode: result.profileMode, profileSource: result.profileSource });
  } catch (err) {
    console.error('Browser session create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/browser/sessions/:id', async (req, res) => {
  try {
    await destroyBrowserSession(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Tab management endpoints ──

app.get('/api/browser/sessions/:id/tabs', (req, res) => {
  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const tabs = [...session.tabs.entries()].map(([tid, t]) => ({
    id: tid, url: t.url, title: t.title, active: tid === session.activeTabId,
  }));
  res.json({ tabs, activeTabId: session.activeTabId });
});

app.post('/api/browser/sessions/:id/tabs', async (req, res) => {
  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  try {
    const { url } = req.body;
    const tab = await createSessionTab(session, req.params.id, url || 'about:blank');
    res.json({ ok: true, ...tab });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/browser/sessions/:id/tabs/:tabId/activate', async (req, res) => {
  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  try {
    await _switchSessionTab(session, req.params.id, req.params.tabId);
    res.json({ ok: true, activeTabId: req.params.tabId, url: session.currentUrl, title: session.title });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/browser/sessions/:id/tabs/:tabId', async (req, res) => {
  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  try {
    await closeSessionTab(session, req.params.id, req.params.tabId);
    res.json({ ok: true, remainingTabs: session.tabs?.size ?? 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/browser/sessions/:id/navigate', async (req, res) => {
  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const { url } = req.body;
  try {
    await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    session.currentUrl = session.page.url();
    session.title = await session.page.title().catch(() => '');
    res.json({ ok: true, url: session.currentUrl, title: session.title });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/browser/sessions/:id/back', async (req, res) => {
  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  try {
    await session.page.goBack({ timeout: 10000 });
    session.currentUrl = session.page.url();
    session.title = await session.page.title().catch(() => '');
    res.json({ ok: true, url: session.currentUrl, title: session.title });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/browser/sessions/:id/forward', async (req, res) => {
  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  try {
    await session.page.goForward({ timeout: 10000 });
    session.currentUrl = session.page.url();
    session.title = await session.page.title().catch(() => '');
    res.json({ ok: true, url: session.currentUrl, title: session.title });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/browser/sessions/:id/reload', async (req, res) => {
  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  try {
    await session.page.reload({ timeout: 15000 });
    session.currentUrl = session.page.url();
    session.title = await session.page.title().catch(() => '');
    res.json({ ok: true, url: session.currentUrl, title: session.title });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Screenshot endpoint (for snapshot/debugging)
app.get('/api/browser/sessions/:id/screenshot', async (req, res) => {
  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  try {
    const buf = await session.page.screenshot({ type: 'jpeg', quality: 80 });
    res.set('Content-Type', 'image/jpeg');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CDP WebSocket endpoint info — for Claude Code's Playwright MCP to connect
app.get('/api/browser/sessions/:id/cdp', (req, res) => {
  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  try {
    const wsEndpoint = session._isPersistent ? null : (session.browser.wsEndpoint?.() || null);
    res.json({ ok: true, wsEndpoint, sessionId: req.params.id, persistent: !!session._isPersistent });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Claude Code connection helper — returns MCP config snippet for connecting to this browser
app.get('/api/browser/sessions/:id/claude-connect', (req, res) => {
  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const wsEndpoint = session._isPersistent ? null : (session.browser.wsEndpoint?.() || null);
  if (!wsEndpoint) return res.json({ ok: false, error: session._isPersistent ? 'Persistent context sessions use SynaBun MCP browser tools instead of CDP endpoint' : 'No CDP endpoint available' });
  res.json({
    ok: true,
    wsEndpoint,
    mcpConfig: {
      playwright: {
        command: 'npx',
        args: ['@playwright/mcp@latest', `--cdp-url=${wsEndpoint}`],
      },
    },
    instructions: `To connect Claude Code to this browser, add this to your .mcp.json or pass --cdp-url=${wsEndpoint} to the Playwright MCP server.`,
  });
});

// ── Selector-based browser interaction endpoints (for MCP tools) ──

/**
 * Normalize selectors from LLMs that may use invalid CSS pseudo-classes.
 * Converts common mistakes to valid Playwright selector syntax.
 */
function normalizeSelector(sel) {
  if (!sel || typeof sel !== 'string') return sel;
  // :contains("text") → :has-text("text")  (jQuery → Playwright)
  sel = sel.replace(/:contains\(/gi, ':has-text(');
  return sel;
}

async function getInteractiveHints(page) {
  try {
    return await page.evaluate(() => {
      const els = document.querySelectorAll(
        'button, [role="button"], [role="textbox"], a[href], input, textarea, ' +
        '[contenteditable="true"], [tabindex="0"]'
      );
      const visible = Array.from(els).filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.top < window.innerHeight;
      });
      return visible.slice(0, 15).map(el => {
        const role = el.getAttribute('role') || el.tagName.toLowerCase();
        const text = (el.innerText || '').trim().substring(0, 60);
        const ariaLabel = el.getAttribute('aria-label') || '';
        const placeholder = el.getAttribute('placeholder') || el.getAttribute('aria-placeholder') || '';
        return { role, text, ariaLabel, placeholder };
      });
    });
  } catch (_) {
    return [];
  }
}

app.post('/api/browser/sessions/:id/click', async (req, res) => {
  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const { selector: rawSelector, timeout, nthMatch } = req.body;
  if (!rawSelector) return res.status(400).json({ error: 'selector required' });
  const selector = normalizeSelector(rawSelector);
  try {
    const loc = session.page.locator(selector);
    // Pre-check element count for better error messages
    const count = await loc.count().catch(() => -1);
    if (count === 0) {
      const hints = await getInteractiveHints(session.page);
      return res.status(400).json({ error: `No elements match selector: ${selector}`, hints });
    }
    if (count > 1 && nthMatch === undefined) {
      return res.status(400).json({ error: `Selector matches ${count} elements (must be unique). Use a more specific selector or pass nthMatch (0-indexed). Matched: ${selector}` });
    }
    const target = (count > 1 && nthMatch !== undefined) ? loc.nth(nthMatch) : loc;
    await target.click({ timeout: timeout || 5000 });
    session.currentUrl = session.page.url();
    session.title = await session.page.title().catch(() => '');
    res.json({ ok: true, url: session.currentUrl, title: session.title });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/browser/sessions/:id/fill', async (req, res) => {
  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const { selector: rawFillSel, value, timeout } = req.body;
  if (!rawFillSel) return res.status(400).json({ error: 'selector required' });
  try {
    await session.page.locator(normalizeSelector(rawFillSel)).fill(value ?? '', { timeout: timeout || 5000 });
    session.currentUrl = session.page.url();
    session.title = await session.page.title().catch(() => '');
    res.json({ ok: true, url: session.currentUrl, title: session.title });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/browser/sessions/:id/type', async (req, res) => {
  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const { selector: rawTypeSel, text, timeout } = req.body;
  try {
    if (rawTypeSel) {
      await session.page.locator(normalizeSelector(rawTypeSel)).pressSequentially(text ?? '', { timeout: timeout || 5000 });
    } else {
      // No selector: type into the currently focused element via keyboard
      await session.page.keyboard.type(text ?? '');
    }
    session.currentUrl = session.page.url();
    session.title = await session.page.title().catch(() => '');
    res.json({ ok: true, url: session.currentUrl, title: session.title });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/browser/sessions/:id/hover', async (req, res) => {
  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const { selector: rawHoverSel, timeout } = req.body;
  if (!rawHoverSel) return res.status(400).json({ error: 'selector required' });
  try {
    await session.page.locator(normalizeSelector(rawHoverSel)).hover({ timeout: timeout || 5000 });
    session.currentUrl = session.page.url();
    session.title = await session.page.title().catch(() => '');
    res.json({ ok: true, url: session.currentUrl, title: session.title });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/browser/sessions/:id/select', async (req, res) => {
  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const { selector: rawSelSel, value, timeout } = req.body;
  if (!rawSelSel) return res.status(400).json({ error: 'selector required' });
  try {
    await session.page.locator(normalizeSelector(rawSelSel)).selectOption(value ?? '', { timeout: timeout || 5000 });
    session.currentUrl = session.page.url();
    session.title = await session.page.title().catch(() => '');
    res.json({ ok: true, url: session.currentUrl, title: session.title });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/browser/sessions/:id/press', async (req, res) => {
  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'key required' });
  try {
    await session.page.keyboard.press(key);
    session.currentUrl = session.page.url();
    session.title = await session.page.title().catch(() => '');
    res.json({ ok: true, url: session.currentUrl, title: session.title });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/browser/sessions/:id/evaluate', async (req, res) => {
  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const { script } = req.body;
  if (!script) return res.status(400).json({ error: 'script required' });
  try {
    const result = await session.page.evaluate(script);
    // Ensure result is JSON-serializable (undefined becomes null)
    res.json({ ok: true, result: result === undefined ? null : result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/browser/sessions/:id/snapshot', async (req, res) => {
  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  try {
    // page.accessibility was removed in Playwright 1.50+
    let tree = null;
    if (session.page.accessibility && typeof session.page.accessibility.snapshot === 'function') {
      tree = await session.page.accessibility.snapshot();
    } else {
      // Fallback: build a tree from ariaSnapshot text
      const ariaText = await session.page.locator('body').ariaSnapshot({ timeout: 5000 }).catch(() => null);
      if (ariaText) {
        tree = parseAriaSnapshotText(ariaText);
      }
    }
    session.currentUrl = session.page.url();
    session.title = await session.page.title().catch(() => '');
    res.json({ ok: true, url: session.currentUrl, title: session.title, snapshot: tree });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/browser/sessions/:id/snapshot', async (req, res) => {
  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const { selector: rawSel } = req.body;
  const scopeSel = rawSel ? normalizeSelector(rawSel) : null;
  try {
    let tree = null;
    if (scopeSel) {
      const ariaText = await session.page.locator(scopeSel).ariaSnapshot({ timeout: 8000 }).catch(() => null);
      if (ariaText) tree = parseAriaSnapshotText(ariaText);
    } else {
      if (session.page.accessibility && typeof session.page.accessibility.snapshot === 'function') {
        tree = await session.page.accessibility.snapshot();
      } else {
        const ariaText = await session.page.locator('body').ariaSnapshot({ timeout: 5000 }).catch(() => null);
        if (ariaText) tree = parseAriaSnapshotText(ariaText);
      }
    }
    session.currentUrl = session.page.url();
    session.title = await session.page.title().catch(() => '');
    res.json({ ok: true, url: session.currentUrl, title: session.title, snapshot: tree });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Parse Playwright's ariaSnapshot YAML-like text into a tree structure
function parseAriaSnapshotText(text) {
  if (!text) return null;
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length === 0) return null;

  const root = { role: 'document', name: '', children: [] };
  const stack = [{ node: root, indent: -1 }];

  for (const line of lines) {
    const stripped = line.replace(/^\s*- /, '');
    const indent = line.length - line.trimStart().length;

    // Parse "role "name"" or "role "name": value"
    const match = stripped.match(/^(\w+)(?:\s+"([^"]*)")?(?::\s*(.*))?$/);
    if (!match) continue;

    const node = {
      role: match[1] || 'generic',
      name: match[2] || '',
      children: [],
    };
    if (match[3]) node.value = match[3];

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    stack[stack.length - 1].node.children.push(node);
    stack.push({ node, indent });
  }

  return root.children.length === 1 ? root.children[0] : root;
}

app.post('/api/browser/sessions/:id/wait', async (req, res) => {
  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const { selector, state, loadState, timeout } = req.body;
  try {
    if (loadState) {
      const valid = ['load', 'domcontentloaded', 'networkidle'];
      if (!valid.includes(loadState)) return res.status(400).json({ error: `Invalid loadState. Use: ${valid.join(', ')}` });
      await session.page.waitForLoadState(loadState, { timeout: timeout || 15000 });
      session.currentUrl = session.page.url();
      session.title = await session.page.title().catch(() => '');
      res.json({ ok: true, loadState, url: session.currentUrl, title: session.title });
    } else if (selector) {
      await session.page.locator(selector).waitFor({
        state: state || 'visible',
        timeout: timeout || 10000,
      });
      res.json({ ok: true, selector, state: state || 'visible' });
    } else {
      await session.page.waitForTimeout(timeout || 1000);
      session.currentUrl = session.page.url();
      session.title = await session.page.title().catch(() => '');
      res.json({ ok: true, url: session.currentUrl, title: session.title });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/browser/sessions/:id/content', async (req, res) => {
  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  try {
    session.currentUrl = session.page.url();
    session.title = await session.page.title().catch(() => '');
    let text = '';
    try {
      text = await session.page.innerText('body');
      if (text.length > 50000) text = text.slice(0, 50000) + '\n... (truncated)';
    } catch { text = ''; }
    res.json({ ok: true, url: session.currentUrl, title: session.title, text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Shared NHM instance (reuse = 1.57x faster than turndown)
const nhm = new NodeHtmlMarkdown({
  preferNativeParser: false,
  codeFence: '```',
  bulletMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  strongDelimiter: '**',
  maxConsecutiveNewlines: 2,
});

app.get('/api/browser/sessions/:id/markdown', async (req, res) => {
  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  try {
    session.currentUrl = session.page.url();
    session.title = await session.page.title().catch(() => '');

    // Extract main content HTML — strip nav, header, footer, sidebar, ads
    let html = '';
    try {
      html = await session.page.evaluate(() => {
        // Remove noise elements before extraction
        const removeSelectors = [
          'nav', 'header', 'footer', 'aside',
          '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="complementary"]',
          '.sidebar', '.nav', '.footer', '.header', '.advertisement', '.ad', '.ads',
          '[class*="cookie"]', '[class*="popup"]', '[class*="modal"]', '[class*="overlay"]',
          'script', 'style', 'noscript', 'iframe',
        ];
        // Clone body so we don't mutate the live page
        const clone = document.body.cloneNode(true);
        for (const sel of removeSelectors) {
          clone.querySelectorAll(sel).forEach(el => el.remove());
        }
        // Prefer <main> or <article> if they exist
        const main = clone.querySelector('main') || clone.querySelector('article') || clone.querySelector('[role="main"]');
        return (main || clone).innerHTML;
      });
    } catch { html = ''; }

    if (!html) {
      return res.json({ ok: true, url: session.currentUrl, title: session.title, markdown: '', tokens: 0 });
    }

    let markdown = nhm.translate(html);
    const estimatedTokens = Math.ceil(markdown.length / 4); // ~4 chars per token estimate

    if (markdown.length > 80000) {
      markdown = markdown.slice(0, 80000) + '\n\n... (truncated at 80K chars)';
    }

    res.json({ ok: true, url: session.currentUrl, title: session.title, markdown, tokens: estimatedTokens });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/fetch-markdown', async (req, res) => {
  const { url, timeout } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout || 15000);

    const response = await fetch(url, {
      headers: {
        'Accept': 'text/markdown, text/html, */*',
        'User-Agent': 'SynaBun/1.0 (AI Agent; +https://synabun.ai)',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);

    const contentType = response.headers.get('content-type') || '';
    const markdownTokens = response.headers.get('x-markdown-tokens');
    const contentSignal = response.headers.get('content-signal');
    const body = await response.text();

    // If server returned markdown natively (content negotiation worked!)
    const isMarkdown = contentType.includes('text/markdown');

    let markdown;
    if (isMarkdown) {
      markdown = body;
    } else {
      // Convert HTML to markdown client-side
      markdown = nhm.translate(body);
    }

    const estimatedTokens = markdownTokens ? parseInt(markdownTokens, 10) : Math.ceil(markdown.length / 4);

    if (markdown.length > 80000) {
      markdown = markdown.slice(0, 80000) + '\n\n... (truncated at 80K chars)';
    }

    res.json({
      ok: true,
      url: response.url, // final URL after redirects
      markdown,
      tokens: estimatedTokens,
      negotiated: isMarkdown, // true = server returned markdown natively
      contentSignal: contentSignal || null,
      status: response.status,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/browser/sessions/:id/screenshot-base64', async (req, res) => {
  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  try {
    const buf = await session.page.screenshot({ type: 'jpeg', quality: 70 });
    session.currentUrl = session.page.url();
    session.title = await session.page.title().catch(() => '');
    res.json({ ok: true, url: session.currentUrl, title: session.title, data: buf.toString('base64') });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/browser/sessions/:id/scroll', async (req, res) => {
  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const { direction = 'down', distance = 500, selector: rawSel } = req.body;
  const deltaX = direction === 'right' ? distance : direction === 'left' ? -distance : 0;
  const deltaY = direction === 'down' ? distance : direction === 'up' ? -distance : 0;
  try {
    if (rawSel) {
      await session.page.locator(normalizeSelector(rawSel)).evaluate(
        (el, { dx, dy }) => el.scrollBy(dx, dy), { dx: deltaX, dy: deltaY }
      );
    } else {
      await session.page.evaluate(({ dx, dy }) => window.scrollBy(dx, dy), { dx: deltaX, dy: deltaY });
    }
    await session.page.waitForTimeout(300);
    session.currentUrl = session.page.url();
    session.title = await session.page.title().catch(() => '');
    res.json({ ok: true, url: session.currentUrl, title: session.title });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/browser/sessions/:id/upload', async (req, res) => {
  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const { selector: rawSel, filePaths } = req.body;
  if (!rawSel) return res.status(400).json({ error: 'selector required' });
  if (!Array.isArray(filePaths) || !filePaths.length) return res.status(400).json({ error: 'filePaths must be a non-empty array' });
  try {
    await session.page.locator(normalizeSelector(rawSel)).setInputFiles(filePaths);
    await session.page.waitForTimeout(500);
    session.currentUrl = session.page.url();
    session.title = await session.page.title().catch(() => '');
    res.json({ ok: true, url: session.currentUrl, title: session.title });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Browser config endpoint
app.get('/api/browser/config', (req, res) => {
  const config = loadBrowserConfig();
  const detected = findBrowserExecutable();
  // Check if Chrome is currently running (informs profile mirroring warnings)
  let chromeRunning = false;
  try {
    if (IS_WIN) {
      const tasklist = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', { encoding: 'utf8', timeout: 3000 });
      chromeRunning = tasklist.includes('chrome.exe');
    } else if (process.platform === 'darwin') {
      const pgrep = execSync('pgrep -x "Google Chrome"', { encoding: 'utf8', timeout: 3000 });
      chromeRunning = pgrep.trim().length > 0;
    } else {
      const pgrep = execSync('pgrep -x chrome || pgrep -x chromium', { encoding: 'utf8', timeout: 3000 });
      chromeRunning = pgrep.trim().length > 0;
    }
  } catch { /* not running */ }
  res.json({ config, detectedPath: detected, chromeRunning });
});

app.put('/api/browser/config', (req, res) => {
  try {
    // Full replacement — the frontend sends the complete config object
    saveBrowserConfig(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Detect Chrome/Edge/Chromium profiles on the system
app.get('/api/browser/detect-profiles', (req, res) => {
  try {
    const profiles = detectChromeProfiles();
    const synabunProfile = resolve(PROJECT_ROOT, 'data', 'chrome-profile').replace(/\\/g, '/');
    const synabunExists = existsSync(synabunProfile);
    res.json({ profiles, synabunProfile, synabunProfileExists: synabunExists });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Open native folder picker dialog (Windows: PowerShell, macOS: osascript, Linux: zenity)
app.post('/api/browser/browse-folder', async (req, res) => {
  try {
    let cmd;
    if (IS_WIN) {
      const pickerScript = resolve(__dirname, 'lib', 'folder-picker.ps1');
      cmd = `powershell -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "${pickerScript}" -Title "Select Chrome profile directory"`;
    } else if (process.platform === 'darwin') {
      cmd = "osascript -e 'POSIX path of (choose folder with prompt \"Select Chrome profile directory\")'";
    } else {
      cmd = 'zenity --file-selection --directory --title="Select Chrome profile directory" 2>/dev/null';
    }
    const result = execSync(cmd, { encoding: 'utf8', timeout: 60000, windowsHide: true }).trim();
    if (result) {
      res.json({ path: result.replace(/\\/g, '/') });
    } else {
      res.json({ path: null, cancelled: true });
    }
  } catch (err) {
    // User cancelled or dialog failed
    res.json({ path: null, cancelled: true });
  }
});

// Detect installed browser binaries on the system
app.get('/api/browser/detect-browsers', (req, res) => {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const localAppData = process.env.LOCALAPPDATA || '';

  const browserDefs = IS_WIN ? [
    { name: 'Google Chrome', channel: 'chrome', paths: [
      join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(process.env['ProgramFiles'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]},
    { name: 'Microsoft Edge', channel: 'msedge', paths: [
      join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(process.env['ProgramFiles'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ]},
    { name: 'Chromium', channel: 'chromium', paths: [
      join(localAppData, 'Chromium', 'Application', 'chrome.exe'),
    ]},
  ] : process.platform === 'darwin' ? [
    { name: 'Google Chrome', channel: 'chrome', paths: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      join(home, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
    ]},
    { name: 'Microsoft Edge', channel: 'msedge', paths: [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]},
    { name: 'Chromium', channel: 'chromium', paths: [
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]},
  ] : [
    { name: 'Google Chrome', channel: 'chrome', paths: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'] },
    { name: 'Microsoft Edge', channel: 'msedge', paths: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'] },
    { name: 'Chromium', channel: 'chromium', paths: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'] },
  ];

  const browsers = [];
  for (const def of browserDefs) {
    for (const p of def.paths) {
      if (p && existsSync(p)) {
        browsers.push({ name: def.name, channel: def.channel, path: p });
        break; // first found path per browser
      }
    }
  }
  res.json({ browsers });
});

// --- Start ---
reloadConfig();

const httpServer = app.listen(PORT, async () => {
  console.log(`\n  Neural Memory Interface`);
  console.log(`  ──────────────────────`);
  console.log(`  Server:    http://localhost:${PORT}`);
  console.log(`  MCP:       http://localhost:${PORT}/mcp`);
  console.log(`  Storage:   SQLite (${getDbPath()})`);
  console.log(`  Embedding: local (${EMBEDDING_DIMS}d)`);
  console.log(`  Terminal:  WebSocket on ws://localhost:${PORT}/ws/terminal/*`);
  console.log(`  Browser:   WebSocket on ws://localhost:${PORT}/ws/browser/*`);
  console.log(`  Whiteboard: WebSocket on ws://localhost:${PORT}/ws/whiteboard`);
  console.log(`  Cards:      WebSocket on ws://localhost:${PORT}/ws/cards`);
  console.log(`  Sessions:   WebSocket on ws://localhost:${PORT}/ws/sessions\n`);

  // Write embedding model metadata so mismatch can be detected later
  try {
    setKvConfig('embedding_model', EMBEDDING_MODEL);
    setKvConfig('embedding_dims', String(EMBEDDING_DIMS));
  } catch {}

  // SQLite indexes are created in schema — no runtime index creation needed

  // Auto-sync OpenClaw bridge if enabled
  try {
    const ocConfig = loadBridgeConfig('openclaw');
    if (ocConfig?.enabled) {
      const result = syncOpenClawBridge();
      console.log(`  OpenClaw bridge: ${result.nodes} nodes synced`);
    }
  } catch (err) {
    console.warn('  OpenClaw bridge sync warning:', err.message);
  }

  // Clean up orphaned loop state files from previous server runs.
  // After a restart, PTY sessions are gone but loop files remain with awaitingNext: true.
  // No terminal session exists to drive them, so delete them to prevent ghost loops.
  try {
    if (existsSync(LOOP_DIR)) {
      const loopFiles = readdirSync(LOOP_DIR).filter(f => f.endsWith('.json'));
      let cleaned = 0;
      for (const f of loopFiles) {
        const fp = resolve(LOOP_DIR, f);
        try {
          const data = JSON.parse(readFileSync(fp, 'utf-8'));
          if (!data.active && !data.pending) {
            // Inactive — safe to delete
            unlinkSync(fp);
            cleaned++;
          } else if (data.terminalSessionId && !terminalSessions.has(data.terminalSessionId)) {
            // Active/pending but terminal is dead (server restarted) — orphaned
            console.log(`[startup] Cleaning orphaned loop ${f} (terminal ${data.terminalSessionId} gone)`);
            unlinkSync(fp);
            cleaned++;
          }
        } catch { /* skip corrupt files */ }
      }
      if (cleaned > 0) console.log(`  Loops:     cleaned ${cleaned} orphaned loop file${cleaned !== 1 ? 's' : ''}`);
    }
  } catch { /* ok */ }
});

// ═══════════════════════════════════════════
// TERMINAL — WebSocket Server
// ═══════════════════════════════════════════

const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  // Block tunnel traffic from WebSocket upgrades, except cookie-authenticated invite sessions
  if (req.headers['cf-connecting-ip'] && !isValidInviteSession(req)) {
    socket.destroy();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Permission-based WS upgrade blocking for guests
  const guest = isGuestRequest(req);
  if (guest) {
    if (url.pathname.startsWith('/ws/terminal/') && !invitePermissions.terminal) { socket.destroy(); return; }
    if (url.pathname.startsWith('/ws/browser/') && !invitePermissions.browser) { socket.destroy(); return; }
    // Whiteboard + sync always allowed (read-only viewing; sync needed for permission delivery)
  }

  if (url.pathname.startsWith('/ws/terminal/') || url.pathname.startsWith('/ws/browser/') || url.pathname === '/ws/whiteboard' || url.pathname === '/ws/cards' || url.pathname === '/ws/sync' || url.pathname === '/ws/claude-skin' || url.pathname === '/ws/sessions') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ── Route: Real-time sync (multi-client state broadcast) ──
  if (url.pathname === '/ws/sync') {
    handleSyncWebSocket(ws, req);
    return;
  }

  // ── Route: Whiteboard (Claude MCP integration) ──
  if (url.pathname === '/ws/whiteboard') {
    handleWhiteboardWebSocket(ws);
    return;
  }

  // ── Route: Cards (Claude MCP integration) ──
  if (url.pathname === '/ws/cards') {
    handleCardsWebSocket(ws);
    return;
  }

  // ── Route: Browser session ──
  if (url.pathname.startsWith('/ws/browser/')) {
    handleBrowserWebSocket(ws, url);
    return;
  }

  // ── Route: Session monitor ──
  if (url.pathname === '/ws/sessions') {
    handleSessionMonitorWebSocket(ws);
    return;
  }

  // ── Route: Claude Skin chat ──
  if (url.pathname === '/ws/claude-skin') {
    handleClaudeSkinWebSocket(ws);
    return;
  }

  // ── Route: Terminal session ──
  const sessionId = url.pathname.replace('/ws/terminal/', '');
  const session = terminalSessions.get(sessionId);

  if (!session) {
    ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
    ws.close();
    return;
  }

  session.clients.add(ws);

  // Cancel grace timer — a client reconnected
  if (session.graceTimer) { clearTimeout(session.graceTimer); session.graceTimer = null; }

  // Replay buffered output so reconnecting clients see prior content
  if (session.outputBuffer.length > 0) {
    const replay = session.outputBuffer.join('');
    ws.send(JSON.stringify({ type: 'replay', data: replay }));
  }

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'input') {
        session.pty.write(msg.data);
      } else if (msg.type === 'resize') {
        session.pty.resize(msg.cols, msg.rows);
      } else if (msg.type === 'image_paste' && msg.data) {
        // Save pasted image to temp file
        const ext = (msg.mimeType === 'image/jpeg') ? 'jpg' : 'png';
        const tmpPath = join(IMAGES_DIR, `synabun-paste-${sessionId}-${Date.now()}.${ext}`);
        try {
          writeFileSync(tmpPath, Buffer.from(msg.data, 'base64'));
          if (!session.tempFiles) session.tempFiles = [];
          session.tempFiles.push(tmpPath);
          // Send path back to client (client decides whether to insert into PTY)
          ws.send(JSON.stringify({ type: 'image_saved', path: tmpPath }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: `Image paste failed: ${err.message}` }));
        }
      } else if (msg.type === 'image_drop' && msg.data) {
        // Save whiteboard image drag-drop to temp file, write path into PTY
        const ext = (msg.mimeType === 'image/jpeg') ? 'jpg' : 'png';
        const tmpPath = join(IMAGES_DIR, `synabun-wbimg-${sessionId}-${Date.now()}.${ext}`);
        try {
          writeFileSync(tmpPath, Buffer.from(msg.data, 'base64'));
          if (!session.tempFiles) session.tempFiles = [];
          session.tempFiles.push(tmpPath);
          ws.send(JSON.stringify({ type: 'image_dropped', path: tmpPath }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: `Image drop failed: ${err.message}` }));
        }
      } else if (msg.type === 'memory_drop' && msg.content) {
        // Save memory as .md temp file so CLI can pick it up as a file reference
        const slug = (msg.title || 'memory').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
        const tmpPath = join(IMAGES_DIR, `synabun-${slug}-${Date.now()}.md`);
        try {
          writeFileSync(tmpPath, msg.content, 'utf-8');
          if (!session.tempFiles) session.tempFiles = [];
          session.tempFiles.push(tmpPath);
          ws.send(JSON.stringify({ type: 'memory_saved', path: tmpPath }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: `Memory drop failed: ${err.message}` }));
        }
      }
    } catch { /* ignore malformed messages */ }
  });

  ws.on('close', () => {
    session.clients.delete(ws);
    // Start grace timer when no clients remain — PTY stays alive for reconnection
    if (session.clients.size === 0 && terminalSessions.has(sessionId)) {
      session.graceTimer = setTimeout(() => {
        if (session.clients.size === 0 && terminalSessions.has(sessionId)) {
          try { session.pty.kill(); } catch {}
          if (session.tempFiles) session.tempFiles.forEach(f => { try { unlinkSync(f); } catch {} });
          terminalSessions.delete(sessionId);
        }
      }, TERMINAL_GRACE_PERIOD_MS);
    }
  });
});

// ═══════════════════════════════════════════
// WHITEBOARD — WebSocket Handler (Claude MCP ↔ Browser)
// ═══════════════════════════════════════════

function handleWhiteboardWebSocket(ws) {
  whiteboardClients.add(ws);
  console.log(`[ws-whiteboard] Client connected (total: ${whiteboardClients.size})`);

  // Send init with current element count
  try {
    const state = loadUiState();
    const wb = state['neural-whiteboard'];
    const count = wb?.elements?.length || 0;
    ws.send(JSON.stringify({ type: 'init', elementCount: count }));
  } catch { /* ignore */ }

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'viewport') {
        whiteboardViewport = { width: msg.width, height: msg.height, yOffset: msg.yOffset || 0, xOffset: msg.xOffset || 0 };
        console.log(`[ws-whiteboard] Viewport: ${msg.width}x${msg.height} (xOffset: ${msg.xOffset || 0}, yOffset: ${msg.yOffset || 0})`);
      }

      if (msg.type === 'screenshot:response' && msg.requestId) {
        const pending = whiteboardPendingScreenshots.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          whiteboardPendingScreenshots.delete(msg.requestId);
          pending.resolve(msg.data);
        }
      }

      if (msg.type === 'screenshot:error' && msg.requestId) {
        const pending = whiteboardPendingScreenshots.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          whiteboardPendingScreenshots.delete(msg.requestId);
          pending.reject(new Error(msg.error || 'Screenshot failed'));
        }
      }

      // Save whiteboard image to temp file and return path for clipboard copy
      if (msg.type === 'image_save' && msg.data) {
        const ext = (msg.mimeType === 'image/jpeg') ? 'jpg' : 'png';
        const tmpPath = join(IMAGES_DIR, `synabun-wbimg-${Date.now()}.${ext}`);
        try {
          writeFileSync(tmpPath, Buffer.from(msg.data, 'base64'));
          ws.send(JSON.stringify({ type: 'image_saved', path: tmpPath }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: `Image save failed: ${err.message}` }));
        }
      }

      // Client pushes full state sync after local mutation — save and relay to other clients
      if (msg.type === 'state:sync' && msg.snapshot) {
        mergeUiState({ 'neural-whiteboard': msg.snapshot });
        broadcastToWhiteboard({ type: 'state:full', snapshot: msg.snapshot }, ws);
      }
    } catch { /* ignore malformed */ }
  });

  ws.on('close', () => {
    whiteboardClients.delete(ws);
    console.log(`[ws-whiteboard] Client disconnected (remaining: ${whiteboardClients.size})`);
  });
}

// ── Screenshot Watcher → auto-paste to whiteboard (cross-platform) ──
{
  // Resolve screenshot directory and filename pattern per platform
  let _screenshotDir = null;
  let _screenshotPattern = null;

  if (process.platform === 'darwin') {
    try {
      _screenshotDir = execSync('defaults read com.apple.screencapture location', { encoding: 'utf8' }).trim();
    } catch { /* not set — use default */ }
    if (!_screenshotDir || !existsSync(_screenshotDir)) _screenshotDir = join(os.homedir(), 'Desktop');
    // macOS screenshot filenames: "Screenshot ..." (EN), "Captura de..." (ES/PT)
    _screenshotPattern = /^(Screenshot\b|Captura de).*\.png$/i;
  } else if (process.platform === 'win32') {
    // Windows Snipping Tool / Print Screen saves to Pictures\Screenshots
    const candidates = [
      join(os.homedir(), 'Pictures', 'Screenshots'),
      join(os.homedir(), 'OneDrive', 'Pictures', 'Screenshots'),
      join(os.homedir(), 'Pictures'),
    ];
    _screenshotDir = candidates.find(d => existsSync(d)) || null;
    // Windows screenshot filenames: "Screenshot 2026-03-19 ..." or "Screenshot (123).png"
    _screenshotPattern = /^Screenshot.*\.(png|jpg|jpeg)$/i;
  } else {
    // Linux: GNOME Screenshot, Spectacle, Flameshot, etc.
    const candidates = [
      join(os.homedir(), 'Pictures', 'Screenshots'),
      join(os.homedir(), 'Pictures'),
      join(os.homedir(), 'Imagens', 'Screenshots'), // pt-BR
      join(os.homedir(), 'Imagens'),
    ];
    _screenshotDir = candidates.find(d => existsSync(d)) || null;
    // Linux screenshot filenames vary: "Screenshot from ...", "screenshot-...", etc.
    _screenshotPattern = /^(Screenshot|screenshot).*\.(png|jpg|jpeg)$/i;
  }

  if (_screenshotDir) {
    const _seenScreenshots = new Set();
    // Seed with existing files so we don't process old screenshots on startup
    try {
      for (const f of readdirSync(_screenshotDir)) {
        if (_screenshotPattern.test(f)) _seenScreenshots.add(f);
      }
    } catch { /* ignore */ }

    let _debounceTimer = null;
    try {
      fsWatch(_screenshotDir, (eventType, filename) => {
        if (!filename) return;
        if (!_screenshotPattern.test(filename)) return;
        if (_seenScreenshots.has(filename)) return;
        _seenScreenshots.add(filename);

        // Debounce — OS may fire multiple events per file
        clearTimeout(_debounceTimer);
        _debounceTimer = setTimeout(() => {
          const filePath = join(_screenshotDir, filename);
          try {
            if (!existsSync(filePath)) return;
            const stat = statSync(filePath);
            if (stat.size < 100) return; // still being written
            const buf = readFileSync(filePath);
            const ext = extname(filename).toLowerCase();
            const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
            // Save a copy to data/images/ for reliable access (avoids macOS temp/permission issues)
            const localName = `screenshot-${Date.now()}${ext}`;
            const localPath = join(IMAGES_DIR, localName);
            try { writeFileSync(localPath, buf); } catch {}
            const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
            console.log(`[screenshot-watcher] New screenshot detected: ${filename} (${(stat.size / 1024).toFixed(0)}KB) → ${localName}`);
            broadcastToWhiteboard({ type: 'screenshot:auto', dataUrl, filename, localPath });
          } catch (err) {
            console.warn(`[screenshot-watcher] Failed to process ${filename}:`, err.message);
          }
        }, 500);
      });
      console.log(`[screenshot-watcher] Watching: ${_screenshotDir}`);
    } catch (err) {
      console.warn('[screenshot-watcher] Could not watch screenshot directory:', err.message);
    }
  } else {
    console.log('[screenshot-watcher] No screenshot directory found for this platform');
  }
}

// ── Cards WebSocket clients (Claude MCP integration) ──
const cardsClients = new Set(); // Set<WebSocket>
const cardsPendingOps = new Map(); // requestId → { resolve, reject, timer }
let cardsViewport = { width: 1920, height: 1080 }; // updated by browser on WS connect + resize

function broadcastToCards(message, excludeWs = null) {
  const data = JSON.stringify(message);
  for (const client of cardsClients) {
    if (client !== excludeWs && client.readyState === 1) client.send(data);
  }
}

function handleCardsWebSocket(ws) {
  cardsClients.add(ws);
  console.log(`[ws-cards] Client connected (total: ${cardsClients.size})`);

  // Send init with current open card count
  try {
    const state = loadUiState();
    const raw = state['neural-open-cards'];
    const cards = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
    ws.send(JSON.stringify({ type: 'init', openCount: cards.length }));
  } catch { /* ignore */ }

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'viewport') {
        cardsViewport = { width: msg.width, height: msg.height };
        console.log(`[ws-cards] Viewport: ${msg.width}x${msg.height}`);
      }

      // ACK responses from browser for card operations (open/close/update)
      if (msg.type === 'ack' && msg.requestId) {
        const pending = cardsPendingOps.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          cardsPendingOps.delete(msg.requestId);
          if (msg.ok) {
            pending.resolve(msg.result || {});
          } else {
            pending.reject(new Error(msg.error || 'Operation failed'));
          }
        }
      }

      // Screenshot response from browser
      if (msg.type === 'screenshot:response' && msg.requestId) {
        const pending = cardsPendingOps.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          cardsPendingOps.delete(msg.requestId);
          pending.resolve(msg.data);
        }
      }

      if (msg.type === 'screenshot:error' && msg.requestId) {
        const pending = cardsPendingOps.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          cardsPendingOps.delete(msg.requestId);
          pending.reject(new Error(msg.error || 'Screenshot failed'));
        }
      }
    } catch { /* ignore malformed */ }
  });

  ws.on('close', () => {
    cardsClients.delete(ws);
    console.log(`[ws-cards] Client disconnected (remaining: ${cardsClients.size})`);
  });
}

// ═══════════════════════════════════════════
// BROWSER — WebSocket Handler
// ═══════════════════════════════════════════

async function handleBrowserWebSocket(ws, url) {
  const sessionId = url.pathname.replace('/ws/browser/', '');
  const session = browserSessions.get(sessionId);

  if (!session) {
    ws.send(JSON.stringify({ type: 'error', message: 'Browser session not found' }));
    ws.close();
    return;
  }

  console.log('[ws-browser] Client connected for session', sessionId, 'persistent:', !!session._isPersistent, 'clients:', session.clients.size + 1);
  session.clients.add(ws);
  if (session.graceTimer) { clearTimeout(session.graceTimer); session.graceTimer = null; }

  // Validate the browser page is still alive before reusing the session
  try {
    await session.page.evaluate('1');
  } catch {
    console.warn('[ws-browser] Page is dead for session', sessionId, '— destroying zombie');
    session.clients.delete(ws);
    await destroyBrowserSession(sessionId);
    ws.send(JSON.stringify({ type: 'error', message: 'Browser session expired' }));
    ws.close();
    return;
  }

  // Send current state including tab info
  ws.send(JSON.stringify({
    type: 'init',
    url: session.currentUrl,
    title: session.title,
    activeTabId: session.activeTabId || null,
    tabs: session.tabs ? [...session.tabs.entries()].map(([tid, t]) => ({
      id: tid, url: t.url, title: t.title, active: tid === session.activeTabId,
    })) : [],
  }));

  // Start screencast if not already running
  try { await startScreencast(session); } catch (err) {
    console.error('[ws-browser] Screencast start failed:', err.message);
    ws.send(JSON.stringify({ type: 'error', message: `Screencast start failed: ${err.message}` }));
  }

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'navigate' && msg.url) {
        try {
          await session.page.goto(msg.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
          session.currentUrl = session.page.url();
          session.title = await session.page.title().catch(() => '');
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: err.message }));
        }
      } else if (msg.type === 'back') {
        await session.page.goBack({ timeout: 10000 }).catch(() => {});
      } else if (msg.type === 'forward') {
        await session.page.goForward({ timeout: 10000 }).catch(() => {});
      } else if (msg.type === 'reload') {
        await session.page.reload({ timeout: 15000 }).catch(() => {});
      } else if (msg.type === 'click') {
        // Forward mouse click at coordinates relative to viewport
        await session.page.mouse.click(msg.x, msg.y, {
          button: msg.button || 'left',
        }).catch(() => {});
      } else if (msg.type === 'dblclick') {
        await session.page.mouse.dblclick(msg.x, msg.y).catch(() => {});
      } else if (msg.type === 'mousemove') {
        await session.page.mouse.move(msg.x, msg.y).catch(() => {});
      } else if (msg.type === 'mousedown') {
        await session.page.mouse.down({ button: msg.button || 'left' }).catch(() => {});
      } else if (msg.type === 'mouseup') {
        await session.page.mouse.up({ button: msg.button || 'left' }).catch(() => {});
      } else if (msg.type === 'wheel') {
        await session.page.mouse.wheel(msg.deltaX || 0, msg.deltaY || 0).catch(() => {});
      } else if (msg.type === 'keydown') {
        await session.page.keyboard.down(msg.key).catch(() => {});
      } else if (msg.type === 'keyup') {
        await session.page.keyboard.up(msg.key).catch(() => {});
      } else if (msg.type === 'keypress') {
        // For typing text characters
        await session.page.keyboard.type(msg.text || '').catch(() => {});
      } else if (msg.type === 'resize') {
        // Resize viewport
        const w = Math.max(320, Math.min(3840, msg.width || 1280));
        const h = Math.max(200, Math.min(2160, msg.height || 800));
        await session.page.setViewportSize({ width: w, height: h }).catch(() => {});
        // Restart screencast with new dimensions
        await stopScreencast(session);
        const scCfg2 = loadBrowserConfig().screencast || {};
        await session.cdpSession.send('Page.startScreencast', {
          format: scCfg2.format || 'jpeg',
          quality: scCfg2.quality ?? 60,
          maxWidth: w, maxHeight: h,
          everyNthFrame: scCfg2.everyNthFrame || 2,
        }).catch(() => {});
        session.screencastActive = true;
      } else if (msg.type === 'switch-tab' && msg.tabId) {
        // Client requests tab switch
        try {
          await _switchSessionTab(session, sessionId, msg.tabId);
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: `Tab switch failed: ${err.message}` }));
        }
      } else if (msg.type === 'new-tab') {
        // Client requests new tab
        try {
          const tab = await createSessionTab(session, sessionId, msg.url || 'about:blank');
          await _switchSessionTab(session, sessionId, tab.tabId);
          ws.send(JSON.stringify({ type: 'tab-created', tabId: tab.tabId, url: tab.url, title: tab.title }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: `New tab failed: ${err.message}` }));
        }
      } else if (msg.type === 'close-tab' && msg.tabId) {
        // Client requests tab close
        try {
          await closeSessionTab(session, sessionId, msg.tabId);
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: `Close tab failed: ${err.message}` }));
        }
      }
    } catch { /* ignore malformed */ }
  });

  ws.on('close', () => {
    session.clients.delete(ws);
    if (session.clients.size === 0 && browserSessions.has(sessionId)) {
      // Stop screencast when nobody is watching
      stopScreencast(session).catch(() => {});
      // Grace period before killing browser
      session.graceTimer = setTimeout(async () => {
        if (session.clients.size === 0 && browserSessions.has(sessionId)) {
          // Don't destroy if an active loop is using this browser session
          if (isSessionUsedByActiveLoop(sessionId)) {
            console.log(`[browser] Grace period: skipping destroy — active loop uses session ${sessionId}`);
            return;
          }
          await destroyBrowserSession(sessionId);
        }
      }, BROWSER_GRACE_PERIOD_MS);
    }
  });
}

// ═══════════════════════════════════════════
// SESSION SNAPSHOT — Periodic save for resume
// ═══════════════════════════════════════════
// Windows kills node hard on terminal close — no signals fire.
// Instead, heartbeat every 30s to keep last-session.json current.

const SESSION_SNAPSHOT_INTERVAL_MS = 30_000;
const SERVER_START_TIME = Date.now();
const RESUME_GRACE_PERIOD_MS = 120_000; // 2 min — don't delete snapshot before client can check

function saveSessionSnapshot() {
  const sessions = [];
  const seen = new Set(); // dedup — avoid resuming same Claude session twice

  // First pass: sessions with known claudeSessionId (from resume or detect endpoint)
  for (const [id, session] of terminalSessions) {
    if (session.profile !== 'claude-code') continue;
    if (!session.claudeSessionId) continue;
    if (seen.has(session.claudeSessionId)) continue;
    seen.add(session.claudeSessionId);
    sessions.push({ profile: 'claude-code', cwd: session.cwd, claudeSessionId: session.claudeSessionId });
  }

  // Second pass: sessions without known ID — try detection, excluding already-claimed IDs
  for (const [id, session] of terminalSessions) {
    if (session.profile !== 'claude-code') continue;
    if (session.claudeSessionId) continue; // already handled
    const csid = detectClaudeSessionForCwd(session.cwd, session.createdAt, seen);
    if (!csid) continue;
    seen.add(csid);
    session.claudeSessionId = csid; // cache it
    sessions.push({ profile: 'claude-code', cwd: session.cwd, claudeSessionId: csid });
  }

  if (sessions.length === 0) {
    // Don't delete during grace period — client may not have checked for resume yet
    if (Date.now() - SERVER_START_TIME < RESUME_GRACE_PERIOD_MS) return;
    // No Claude Code sessions — clean up stale snapshot
    try { if (existsSync(LAST_SESSION_PATH)) unlinkSync(LAST_SESSION_PATH); } catch {}
    return;
  }

  try {
    writeFileSync(LAST_SESSION_PATH, JSON.stringify({ timestamp: Date.now(), sessions }, null, 2), 'utf-8');
  } catch {}
}

// Heartbeat: snapshot active sessions every 30s
setInterval(saveSessionSnapshot, SESSION_SNAPSHOT_INTERVAL_MS);

// Also try to save on clean shutdown (works with Ctrl+C, not window close)
process.on('SIGINT', () => { saveSessionSnapshot(); process.exit(0); });
process.on('SIGTERM', () => { saveSessionSnapshot(); process.exit(0); });
process.on('exit', saveSessionSnapshot);
