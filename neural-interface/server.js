import 'dotenv/config';
import express from 'express';
import { fileURLToPath, pathToFileURL } from 'url';
import { basename, dirname, extname, join, resolve } from 'path';
import { config as dotenvConfig } from 'dotenv';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, rmSync, statSync, renameSync, cpSync, appendFileSync } from 'fs';
import { randomBytes, createHash } from 'crypto';
import { exec, execSync, spawn } from 'child_process';
import { promisify } from 'util';
import { Readable } from 'stream';
import { createConnection as netConnect } from 'net';
import { WebSocketServer } from 'ws';
import os from 'node:os';
import pty from 'node-pty';
import archiver from 'archiver';
import AdmZip from 'adm-zip';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from parent directory
dotenvConfig({ path: resolve(__dirname, '..', '.env') });

const app = express();
app.use(express.json());

// Block tunnel traffic from accessing anything except /mcp
// Cloudflared adds CF-Connecting-IP header on proxied requests
const TUNNEL_ALLOWED = ['/mcp'];
app.use((req, res, next) => {
  if (req.headers['cf-connecting-ip'] && !TUNNEL_ALLOWED.some(p => req.path.startsWith(p))) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
});

const PORT = process.env.NEURAL_PORT || 3344;
let QDRANT_URL = process.env.QDRANT_MEMORY_URL || `http://localhost:${process.env.QDRANT_PORT || '6333'}`;
let QDRANT_KEY = process.env.QDRANT_MEMORY_API_KEY || 'claude-memory-local-key';
let COLLECTION = process.env.QDRANT_MEMORY_COLLECTION || 'claude_memory';
let OPENAI_KEY = process.env.OPENAI_EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || '';
let EMBEDDING_BASE_URL = process.env.EMBEDDING_BASE_URL || 'https://api.openai.com/v1';
let EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
let EMBEDDING_DIMS = parseInt(process.env.EMBEDDING_DIMENSIONS || '1536', 10);
const PROJECT_ROOT = resolve(__dirname, '..');

// Reload config vars from .env (single source of truth for everything)
function reloadConfig() {
  const vars = parseEnvFile(ENV_PATH); // Returns {} if .env doesn't exist yet

  // Embedding config: prefer namespaced, fall back to flat keys
  const embActiveId = vars.EMBEDDING_ACTIVE;
  if (embActiveId && vars[`EMBEDDING__${embActiveId}__API_KEY`]) {
    OPENAI_KEY = vars[`EMBEDDING__${embActiveId}__API_KEY`];
    EMBEDDING_BASE_URL = vars[`EMBEDDING__${embActiveId}__BASE_URL`] || 'https://api.openai.com/v1';
    EMBEDDING_MODEL = vars[`EMBEDDING__${embActiveId}__MODEL`] || 'text-embedding-3-small';
    EMBEDDING_DIMS = parseInt(vars[`EMBEDDING__${embActiveId}__DIMENSIONS`] || '1536', 10);
  } else {
    // Backward compat with flat keys
    OPENAI_KEY = vars.OPENAI_EMBEDDING_API_KEY || vars.OPENAI_API_KEY || '';
    EMBEDDING_BASE_URL = vars.EMBEDDING_BASE_URL || 'https://api.openai.com/v1';
    EMBEDDING_MODEL = vars.EMBEDDING_MODEL || 'text-embedding-3-small';
    EMBEDDING_DIMS = parseInt(vars.EMBEDDING_DIMENSIONS || '1536', 10);
  }

  // Qdrant config: from QDRANT_ACTIVE + QDRANT__<id>__* entries in .env
  const connData = loadQdrantConnections();
  const activeConn = connData.active ? connData.connections[connData.active] : null;
  if (activeConn?.url && activeConn?.apiKey && activeConn?.collection) {
    QDRANT_URL = activeConn.url;
    QDRANT_KEY = activeConn.apiKey;
    COLLECTION = activeConn.collection;
  } else {
    // Final fallback to legacy flat keys
    const port = vars.QDRANT_PORT || '6333';
    QDRANT_URL = vars.QDRANT_MEMORY_URL || `http://localhost:${port}`;
    QDRANT_KEY = vars.QDRANT_MEMORY_API_KEY || 'claude-memory-local-key';
    COLLECTION = vars.QDRANT_MEMORY_COLLECTION || 'claude_memory';
  }

  console.log(`  Config reloaded — Qdrant: ${QDRANT_URL}, Collection: ${COLLECTION}`);
}

// --- Category Helpers (per-connection) ---

const CATEGORIES_DATA_DIR = resolve(__dirname, '..', 'mcp-server', 'data');
const GLOBAL_CATEGORIES_PATH = resolve(CATEGORIES_DATA_DIR, 'custom-categories.json');
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const CATEGORIES_POINT_ID = '00000000-0000-0000-0000-000000000000';

// Default categories seeded on first startup (new connection)
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
    name: 'ideas',
    description: 'Feature ideas, product concepts, brainstorms, and future plans. A general-purpose category for capturing forward-looking thoughts that haven\'t been implemented yet — new features to build, architectural experiments to try, UX improvements to explore, or any creative concept worth revisiting later.',
    color: '#f59e0b',
  },
];

function getCategoriesPath() {
  const activeId = getActiveConnectionIdFromEnv() || 'default';
  const perConnPath = resolve(CATEGORIES_DATA_DIR, `custom-categories-${activeId}.json`);

  // If per-connection file doesn't exist, seed with defaults (Qdrant is source of truth)
  if (!existsSync(perConnPath)) {
    const dir = resolve(perConnPath, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(perConnPath, JSON.stringify({ version: 1, categories: DEFAULT_CATEGORIES }, null, 2), 'utf-8');
  }

  return perConnPath;
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

  // Fire-and-forget write-through to Qdrant (source of truth)
  saveCategoriesToQdrant(categories).catch(err => {
    console.error('Failed to sync categories to Qdrant:', err.message);
  });
}

async function saveCategoriesToQdrant(categories) {
  const zeroVector = new Array(EMBEDDING_DIMS).fill(0);
  await qdrantFetch('/points', {
    method: 'PUT',
    body: JSON.stringify({
      points: [{
        id: CATEGORIES_POINT_ID,
        vector: zeroVector,
        payload: {
          _type: 'system_metadata',
          metadata_key: 'categories',
          categories,
          updated_at: new Date().toISOString(),
        },
      }],
    }),
  });
}

// System metadata + trash exclusion filter for Qdrant queries
// Uses is_empty (matches missing, null, and empty) since existing memories lack the trashed_at field
const SYSTEM_METADATA_FILTER = {
  must_not: [{ key: '_type', match: { value: 'system_metadata' } }],
  must: [{ is_empty: { key: 'trashed_at' } }],
};

// Filter for viewing ONLY trashed items (inverted: must_not is_empty = field must be present and non-null)
const TRASH_FILTER = {
  must_not: [
    { key: '_type', match: { value: 'system_metadata' } },
    { is_empty: { key: 'trashed_at' } },
  ],
};

function mergeExclusionFilter(existingFilter) {
  if (!existingFilter) return { ...SYSTEM_METADATA_FILTER };
  const mustNot = [...(existingFilter.must_not || []), ...SYSTEM_METADATA_FILTER.must_not];
  const must = [...(existingFilter.must || []), ...SYSTEM_METADATA_FILTER.must];
  return { ...existingFilter, must_not: mustNot, must };
}

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
  const qdrantVars = {};    // { connectionId: { FIELD: value } }
  const embeddingVars = {}; // { providerId: { FIELD: value } }
  const bridgeVars = {};    // { bridgeId: { FIELD: value } }

  for (const [key, value] of Object.entries(vars)) {
    let match;
    if ((match = key.match(/^QDRANT__([a-z0-9_]+)__(.+)$/))) {
      const [, id, field] = match;
      if (!qdrantVars[id]) qdrantVars[id] = {};
      qdrantVars[id][field] = value;
    } else if ((match = key.match(/^EMBEDDING__([a-z0-9_]+)__(.+)$/))) {
      const [, id, field] = match;
      if (!embeddingVars[id]) embeddingVars[id] = {};
      embeddingVars[id][field] = value;
    } else if ((match = key.match(/^BRIDGE__([a-z0-9_]+)__(.+)$/))) {
      const [, id, field] = match;
      if (!bridgeVars[id]) bridgeVars[id] = {};
      bridgeVars[id][field] = value;
    } else {
      globalVars[key] = value;
    }
  }

  const lines = [];

  // Section: Embedding providers (namespaced)
  const embIds = Object.keys(embeddingVars).sort();
  if (embIds.length > 0) {
    for (const id of embIds) {
      const fields = embeddingVars[id];
      const label = fields.LABEL || id.replace(/_/g, ' ');
      lines.push(`# -- Embedding: ${id} (${label}) --`);
      for (const field of ['API_KEY', 'BASE_URL', 'MODEL', 'DIMENSIONS', 'LABEL']) {
        if (fields[field] !== undefined) lines.push(`EMBEDDING__${id}__${field}=${fields[field]}`);
      }
      lines.push('');
    }
  }

  // EMBEDDING_ACTIVE selector
  if (globalVars.EMBEDDING_ACTIVE) {
    lines.push(`EMBEDDING_ACTIVE=${globalVars.EMBEDDING_ACTIVE}`);
    lines.push('');
    delete globalVars.EMBEDDING_ACTIVE;
  }

  // Legacy flat embedding keys (backward compat)
  const legacyEmbeddingKeys = ['OPENAI_EMBEDDING_API_KEY', 'OPENAI_API_KEY', 'EMBEDDING_BASE_URL', 'EMBEDDING_MODEL', 'EMBEDDING_DIMENSIONS'];
  const hasLegacy = legacyEmbeddingKeys.some(k => globalVars[k] !== undefined);
  if (hasLegacy) {
    for (const k of legacyEmbeddingKeys) {
      if (globalVars[k] !== undefined) { lines.push(`${k}=${globalVars[k]}`); delete globalVars[k]; }
    }
    lines.push('');
  }

  // QDRANT_ACTIVE selector
  if (globalVars.QDRANT_ACTIVE) {
    lines.push(`QDRANT_ACTIVE=${globalVars.QDRANT_ACTIVE}`);
    lines.push('');
    delete globalVars.QDRANT_ACTIVE;
  }

  // Section: Per-connection Qdrant entries
  const connIds = Object.keys(qdrantVars).sort();
  for (const connId of connIds) {
    const fields = qdrantVars[connId];
    const label = fields.LABEL || connId.replace(/_/g, '-');
    lines.push(`# -- Qdrant: ${connId} (${label}) --`);
    for (const field of ['URL', 'PORT', 'GRPC_PORT', 'API_KEY', 'COLLECTION', 'LABEL']) {
      if (fields[field] !== undefined) lines.push(`QDRANT__${connId}__${field}=${fields[field]}`);
    }
    lines.push('');
  }

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

function extractPort(url) {
  try {
    const parsed = new URL(url);
    return parseInt(parsed.port, 10) || 6333;
  } catch {
    const m = (url || '').match(/:(\d+)\/?$/);
    return m ? parseInt(m[1], 10) : 6333;
  }
}

// --- .env-based Config Layer (replaces connections.json) ---

/**
 * Parse all QDRANT__<id>__<FIELD> entries from .env into a connections structure.
 */
function loadQdrantConnections() {
  const vars = parseEnvFile(ENV_PATH);
  const active = vars.QDRANT_ACTIVE || null;
  const connections = {};

  for (const [key, value] of Object.entries(vars)) {
    const match = key.match(/^QDRANT__([a-z0-9_]+)__(.+)$/);
    if (!match) continue;
    const connId = match[1];
    const field = match[2];
    if (!connections[connId]) connections[connId] = {};
    connections[connId][field] = value;
  }

  const result = {};
  for (const [id, fields] of Object.entries(connections)) {
    const port = parseInt(fields.PORT || '6333', 10);
    result[id] = {
      label: fields.LABEL || id.replace(/_/g, ' '),
      url: fields.URL || `http://localhost:${port}`,
      apiKey: fields.API_KEY || '',
      collection: fields.COLLECTION || 'claude_memory',
      port,
      grpcPort: parseInt(fields.GRPC_PORT || String(port + 1), 10),
    };
  }

  return { active, connections: result };
}

/**
 * Save a Qdrant connection to .env by writing/updating QDRANT__<id>__* entries.
 */
function saveQdrantConnection(id, conn, setActive = false) {
  const vars = parseEnvFile(ENV_PATH);
  const envId = id.replace(/-/g, '_');
  const port = conn.port || extractPort(conn.url);

  vars[`QDRANT__${envId}__PORT`] = String(port);
  vars[`QDRANT__${envId}__GRPC_PORT`] = String(conn.grpcPort || port + 1);
  vars[`QDRANT__${envId}__API_KEY`] = conn.apiKey;
  vars[`QDRANT__${envId}__COLLECTION`] = conn.collection;
  vars[`QDRANT__${envId}__LABEL`] = conn.label || id;
  // Store explicit URL for remote instances (not just localhost)
  if (conn.url && !conn.url.match(/^https?:\/\/localhost:\d+\/?$/)) {
    vars[`QDRANT__${envId}__URL`] = conn.url;
  }

  if (setActive) {
    vars.QDRANT_ACTIVE = envId;
  }

  writeEnvFile(ENV_PATH, vars);
}

/**
 * Remove a Qdrant connection from .env.
 */
function removeQdrantConnection(id) {
  const vars = parseEnvFile(ENV_PATH);
  const envId = id.replace(/-/g, '_');
  const prefix = `QDRANT__${envId}__`;

  for (const key of Object.keys(vars)) {
    if (key.startsWith(prefix)) delete vars[key];
  }

  writeEnvFile(ENV_PATH, vars);
}

/**
 * Set the active Qdrant connection ID in .env.
 */
function setActiveQdrantConnection(id) {
  const vars = parseEnvFile(ENV_PATH);
  vars.QDRANT_ACTIVE = id.replace(/-/g, '_');
  writeEnvFile(ENV_PATH, vars);
}

/**
 * Get the active connection ID from .env.
 */
function getActiveConnectionIdFromEnv() {
  const vars = parseEnvFile(ENV_PATH);
  return vars.QDRANT_ACTIVE || null;
}

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

// --- Migration: connections.json → .env ---

function migrateConnectionsJsonToEnv() {
  const connectionsPath = resolve(__dirname, '..', 'connections.json');
  if (!existsSync(connectionsPath)) return;

  console.log('  Migrating connections.json → .env ...');

  try {
    const data = JSON.parse(readFileSync(connectionsPath, 'utf-8'));
    const vars = parseEnvFile(ENV_PATH);

    // 1. Migrate Qdrant connections
    if (data.connections) {
      for (const [id, conn] of Object.entries(data.connections)) {
        const envId = id.replace(/-/g, '_');
        const port = extractPort(conn.url);
        vars[`QDRANT__${envId}__PORT`] = String(port);
        vars[`QDRANT__${envId}__GRPC_PORT`] = String(port + 1);
        vars[`QDRANT__${envId}__API_KEY`] = conn.apiKey;
        vars[`QDRANT__${envId}__COLLECTION`] = conn.collection;
        vars[`QDRANT__${envId}__LABEL`] = conn.label || id;
        if (conn.url && !conn.url.match(/^https?:\/\/localhost:\d+\/?$/)) {
          vars[`QDRANT__${envId}__URL`] = conn.url;
        }
      }
    }

    // 2. Migrate active connection
    if (data.active) {
      vars.QDRANT_ACTIVE = data.active.replace(/-/g, '_');
    }

    // 3. Migrate bridges
    if (data.bridges) {
      for (const [bridgeId, bridge] of Object.entries(data.bridges)) {
        vars[`BRIDGE__${bridgeId}__ENABLED`] = String(bridge.enabled ?? false);
        if (bridge.workspacePath) vars[`BRIDGE__${bridgeId}__WORKSPACE_PATH`] = bridge.workspacePath;
        if (bridge.lastSync) vars[`BRIDGE__${bridgeId}__LAST_SYNC`] = bridge.lastSync;
      }
    }

    // 4. Migrate flat embedding keys to namespaced format
    if (vars.OPENAI_EMBEDDING_API_KEY && !Object.keys(vars).some(k => k.startsWith('EMBEDDING__'))) {
      const embId = 'openai_main';
      vars.EMBEDDING_ACTIVE = embId;
      vars[`EMBEDDING__${embId}__API_KEY`] = vars.OPENAI_EMBEDDING_API_KEY;
      if (vars.EMBEDDING_BASE_URL) vars[`EMBEDDING__${embId}__BASE_URL`] = vars.EMBEDDING_BASE_URL;
      if (vars.EMBEDDING_MODEL) vars[`EMBEDDING__${embId}__MODEL`] = vars.EMBEDDING_MODEL;
      if (vars.EMBEDDING_DIMENSIONS) vars[`EMBEDDING__${embId}__DIMENSIONS`] = vars.EMBEDDING_DIMENSIONS;
      vars[`EMBEDDING__${embId}__LABEL`] = 'OpenAI Main';
    }

    // 5. Clean up legacy flat Qdrant keys
    delete vars.QDRANT_PORT;
    delete vars.QDRANT_GRPC_PORT;
    delete vars.QDRANT_MEMORY_API_KEY;
    delete vars.QDRANT_MEMORY_URL;
    delete vars.QDRANT_MEMORY_COLLECTION;

    writeEnvFile(ENV_PATH, vars);

    // 6. Rename connections.json to connections.json.bak
    renameSync(connectionsPath, connectionsPath + '.bak');
    console.log(`  Migration complete — ${Object.keys(data.connections || {}).length} connections migrated. connections.json renamed to .bak`);
  } catch (err) {
    console.error('  Migration failed:', err.message);
  }
}

function maskKey(value) {
  if (!value) return '';
  if (value.length <= 4) return '****';
  return '*'.repeat(value.length - 4) + value.slice(-4);
}

// Redirect to onboarding if setup not complete
app.get('/', (req, res, next) => {
  const vars = parseEnvFile(ENV_PATH);
  if (vars.SETUP_COMPLETE === 'true') return next();
  // Also allow through if .env has an active connection + embedding key
  const connData = loadQdrantConnections();
  const activeConn = connData.active ? connData.connections[connData.active] : null;
  const hasConnection = !!(activeConn?.apiKey);
  const hasEmbed = !!(vars.OPENAI_EMBEDDING_API_KEY || vars.EMBEDDING_ACTIVE);
  if (hasConnection && hasEmbed) return next();
  res.redirect('/onboarding.html');
});

app.use('/i18n', express.static(join(__dirname, 'i18n')));
app.use(express.static(join(__dirname, 'public')));

// --- Helpers ---

function qdrantHeaders() {
  return {
    'Content-Type': 'application/json',
    'api-key': QDRANT_KEY,
  };
}

async function qdrantFetch(path, options = {}) {
  const url = `${QDRANT_URL}/collections/${COLLECTION}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: { ...qdrantHeaders(), ...(options.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Qdrant ${res.status}: ${text}`);
  }
  return res.json();
}

function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

async function getEmbedding(text) {
  const res = await fetch(`${EMBEDDING_BASE_URL}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
      dimensions: EMBEDDING_DIMS,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Embedding API ${res.status}: ${errText}`);
  }
  const data = await res.json();
  return data.data[0].embedding;
}

// --- Routes ---

// GET /api/memories — All memories with pre-computed graph edges
app.get('/api/memories', async (req, res) => {
  try {
    const allPoints = [];
    let offset = null;

    // Paginated scroll to get all points
    do {
      const body = {
        limit: 100,
        with_payload: true,
        with_vector: true,
        filter: SYSTEM_METADATA_FILTER,
      };
      if (offset) body.offset = offset;

      const result = await qdrantFetch('/points/scroll', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      allPoints.push(...result.result.points);
      offset = result.result.next_page_offset ?? null;
    } while (offset);

    // Build nodes
    const nodes = allPoints.map(p => ({
      id: p.id,
      payload: p.payload,
      vector: p.vector,
    }));

    // --- Merge OpenClaw bridge nodes (no vectors, no cosine links) ---
    const ocBridge = loadBridgeConfig('openclaw');
    if (ocBridge?.enabled && _openclawNodes.length > 0) {
      for (const ocNode of _openclawNodes) {
        nodes.push({ ...ocNode, vector: null });
      }
    }

    // Build links via cosine similarity + shared related files + parent category + shared tags + manual links
    const SIM_THRESHOLD = 0.65;

    // Load categories to build parent lookup
    let categoryParentMap = {};
    try {
      const catData = JSON.parse(readFileSync(getCategoriesPath(), 'utf-8'));
      for (const cat of catData.categories) {
        // Map each category to its parent (or itself if it's a top-level parent)
        categoryParentMap[cat.name] = cat.parent || cat.name;
      }
    } catch (e) {
      console.warn('Could not load categories for parent lookup:', e.message);
    }
    // Add ephemeral OpenClaw categories to parent map
    for (const cat of _openclawCategories) {
      categoryParentMap[cat.name] = cat.parent || cat.name;
    }

    // Track link pairs to merge types when multiple methods connect the same pair
    const linkMap = new Map(); // "idA|idB" → { source, target, strength, types[] }
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

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];

        // Cosine similarity — "Similar Content"
        if (a.vector && b.vector) {
          const sim = cosineSimilarity(a.vector, b.vector);
          if (sim > SIM_THRESHOLD) {
            const str = (sim - SIM_THRESHOLD) / (1 - SIM_THRESHOLD);
            addLink(a.id, b.id, str, 'similarity');
          }
        }

        // Shared related files — "Shared Files"
        if (a.payload.related_files && b.payload.related_files) {
          const shared = a.payload.related_files.filter(f => b.payload.related_files.includes(f));
          if (shared.length > 0) {
            addLink(a.id, b.id, 0.3 + shared.length * 0.15, 'files');
          }
        }

        // Same parent category — "Same Family"
        const parentA = categoryParentMap[a.payload.category];
        const parentB = categoryParentMap[b.payload.category];
        if (parentA && parentB && parentA === parentB) {
          addLink(a.id, b.id, 0.2, 'family');
        }

        // Shared tags — "Shared Tags"
        if (a.payload.tags && b.payload.tags) {
          const sharedTags = a.payload.tags.filter(t => b.payload.tags.includes(t));
          if (sharedTags.length > 0) {
            addLink(a.id, b.id, 0.25 + sharedTags.length * 0.1, 'tags');
          }
        }
      }

      // Explicit related_memory_ids — "Manually Linked"
      if (nodes[i].payload.related_memory_ids) {
        for (const relId of nodes[i].payload.related_memory_ids) {
          if (nodes.some(n => n.id === relId)) {
            addLink(nodes[i].id, relId, 0.9, 'manual');
          }
        }
      }
    }

    // Filter to only links above threshold
    const links = [];
    for (const link of linkMap.values()) {
      if (link.strength > 0.1) {
        links.push({ source: link.source, target: link.target, strength: Math.min(link.strength, 1), types: link.types });
      }
    }

    // Strip vectors from response (too large for client)
    const clientNodes = nodes.map(({ vector, ...rest }) => rest);

    res.json({ nodes: clientNodes, links, totalVectors: allPoints.length, openclawNodes: ocBridge?.enabled ? _openclawNodes.length : 0 });
  } catch (err) {
    console.error('GET /api/memories error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/search — Semantic vector search
app.post('/api/search', async (req, res) => {
  try {
    const { query, limit = 10 } = req.body;
    if (!query) return res.status(400).json({ error: 'query required' });

    const embedding = await getEmbedding(query);

    const result = await qdrantFetch('/points/search', {
      method: 'POST',
      body: JSON.stringify({
        vector: embedding,
        limit,
        with_payload: true,
        score_threshold: 0.3,
        filter: SYSTEM_METADATA_FILTER,
      }),
    });

    res.json({
      results: result.result.map(r => ({
        id: r.id,
        score: r.score,
        payload: r.payload,
      })),
      query,
    });
  } catch (err) {
    console.error('POST /api/search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats — Collection count including trash count
app.get('/api/stats', async (req, res) => {
  try {
    const result = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`, {
      headers: qdrantHeaders(),
    });
    const data = await result.json();

    // Count trashed items
    let trash_count = 0;
    try {
      const trashResult = await qdrantFetch('/points/count', {
        method: 'POST',
        body: JSON.stringify({ filter: TRASH_FILTER, exact: true }),
      });
      trash_count = trashResult.result.count;
    } catch {}

    res.json({
      count: data.result.points_count,
      vectors: data.result.vectors_count,
      status: data.result.status,
      trash_count,
    });
  } catch (err) {
    console.error('GET /api/stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/memory/:id — Single memory detail
app.get('/api/memory/:id', async (req, res) => {
  try {
    const result = await qdrantFetch('/points', {
      method: 'POST',
      body: JSON.stringify({
        ids: [req.params.id],
        with_payload: true,
      }),
    });

    if (!result.result || result.result.length === 0) {
      return res.status(404).json({ error: 'Memory not found' });
    }

    res.json(result.result[0]);
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
      // Sanitize: lowercase, trim, deduplicate, remove empties
      const clean = [...new Set(tags.map(t => String(t).trim().toLowerCase()).filter(Boolean))];
      payload.tags = clean;
    }

    if (content !== undefined) {
      if (typeof content !== 'string' || !content.trim()) {
        return res.status(400).json({ error: 'content must be a non-empty string' });
      }
      payload.content = content;
    }

    await qdrantFetch('/points/payload', {
      method: 'POST',
      body: JSON.stringify({
        payload,
        points: [req.params.id],
      }),
    });

    res.json({ ok: true, id: req.params.id, ...payload });
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

    // If renaming, update all children that reference this category as parent AND update memories in Qdrant
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

      // Update all memories in Qdrant that use the old category name
      try {
        // First, find all points with the old category
        const scrollBody = {
          limit: 100,
          with_payload: true,
          filter: mergeExclusionFilter({ must: [{ key: 'category', match: { value: oldName } }] })
        };

        const scrollResult = await qdrantFetch('/points/scroll', {
          method: 'POST',
          body: JSON.stringify(scrollBody),
        });

        const matchingPoints = scrollResult.result.points || [];
        if (matchingPoints.length > 0) {
          const pointIds = matchingPoints.map(p => p.id);
          // Update all matching points with the new category name
          await qdrantFetch('/points/payload', {
            method: 'POST',
            body: JSON.stringify({
              payload: { category: new_name, updated_at: new Date().toISOString() },
              points: pointIds,
            }),
          });
          console.log(`✓ Updated ${matchingPoints.length} memories from "${oldName}" to "${new_name}"`);
        }
      } catch (err) {
        console.error('Error updating memories during category rename:', err.message);
        // Don't fail the request, just log the error
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
      // Hard delete — permanently remove from Qdrant (used by trash purge)
      await qdrantFetch('/points/delete', {
        method: 'POST',
        body: JSON.stringify({ points: [id] }),
      });
    } else {
      // Soft delete — set trashed_at timestamp
      await qdrantFetch('/points/payload', {
        method: 'POST',
        body: JSON.stringify({
          payload: { trashed_at: new Date().toISOString() },
          points: [id],
        }),
      });
    }

    res.json({ ok: true, id, permanent: !!permanent });
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
    reloadConfig();
    const allPoints = [];
    let offset = null;

    do {
      const body = {
        limit: 100,
        with_payload: true,
        with_vector: false,
        filter: TRASH_FILTER,
      };
      if (offset) body.offset = offset;

      const result = await qdrantFetch('/points/scroll', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      allPoints.push(...result.result.points);
      offset = result.result.next_page_offset ?? null;
    } while (offset);

    // Sort by trashed_at descending (most recently trashed first)
    allPoints.sort((a, b) => (b.payload.trashed_at || '').localeCompare(a.payload.trashed_at || ''));

    res.json({ items: allPoints, count: allPoints.length });
  } catch (err) {
    console.error('GET /api/trash error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/trash/:id/restore — Restore a trashed memory
app.post('/api/trash/:id/restore', async (req, res) => {
  try {
    reloadConfig();
    const id = req.params.id;
    await qdrantFetch('/points/payload', {
      method: 'POST',
      body: JSON.stringify({
        payload: { trashed_at: null },
        points: [id],
      }),
    });
    res.json({ ok: true, id });
  } catch (err) {
    console.error('POST /api/trash/:id/restore error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/trash/purge — Permanently delete all trashed memories
app.delete('/api/trash/purge', async (req, res) => {
  try {
    reloadConfig();

    // Scroll all trashed points
    const allTrashed = [];
    let offset = null;
    do {
      const body = {
        limit: 100,
        with_payload: true,
        with_vector: false,
        filter: TRASH_FILTER,
      };
      if (offset) body.offset = offset;
      const result = await qdrantFetch('/points/scroll', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      allTrashed.push(...result.result.points);
      offset = result.result.next_page_offset ?? null;
    } while (offset);

    if (allTrashed.length === 0) {
      return res.json({ ok: true, purged: 0 });
    }

    const pointIds = allTrashed.map(p => p.id);
    await qdrantFetch('/points/delete', {
      method: 'POST',
      body: JSON.stringify({ points: pointIds }),
    });

    res.json({ ok: true, purged: pointIds.length });
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
    const allPoints = [];
    let offset = null;

    // Scroll all memories
    do {
      const body = { limit: 100, with_payload: true, with_vector: false, filter: SYSTEM_METADATA_FILTER };
      if (offset) body.offset = offset;
      const result = await qdrantFetch('/points/scroll', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      allPoints.push(...result.result.points);
      offset = result.result.next_page_offset ?? null;
    } while (offset);

    // Filter to memories with related_files
    const withFiles = allPoints.filter(
      p => p.payload.related_files && p.payload.related_files.length > 0
    );

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
      total_checked: allPoints.length,
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

    res.json({ ok: true, categories });
  } catch (err) {
    console.error('DELETE /api/categories/:name/logo error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/categories/:name/export — Export all memories in a category as Markdown
app.get('/api/categories/:name/export', async (req, res) => {
  try {
    reloadConfig();
    const { name } = req.params;

    // Scroll all memories in this category (paginated to handle large categories)
    let allPoints = [];
    let offset = null;
    do {
      const scrollBody = {
        limit: 100,
        with_payload: true,
        filter: mergeExclusionFilter({ must: [{ key: 'category', match: { value: name } }] }),
      };
      if (offset) scrollBody.offset = offset;
      const scrollResult = await qdrantFetch('/points/scroll', { method: 'POST', body: JSON.stringify(scrollBody) });
      const points = scrollResult.result.points || [];
      allPoints.push(...points);
      offset = scrollResult.result.next_page_offset || null;
    } while (offset);

    if (allPoints.length === 0) {
      return res.status(404).json({ error: `No memories found in category "${name}".` });
    }

    // Sort by created_at descending (newest first)
    allPoints.sort((a, b) => {
      const da = a.payload.created_at || '';
      const db = b.payload.created_at || '';
      return db.localeCompare(da);
    });

    // Build markdown
    let md = `# Memories — ${name}\n\n`;
    md += `> Exported ${allPoints.length} memor${allPoints.length === 1 ? 'y' : 'ies'} on ${new Date().toISOString().split('T')[0]}\n\n---\n\n`;

    for (const point of allPoints) {
      const p = point.payload;
      md += `## ${(p.content || '').split('\n')[0].substring(0, 80)}\n\n`;
      md += `| Field | Value |\n|---|---|\n`;
      md += `| **ID** | \`${point.id}\` |\n`;
      if (p.importance) md += `| **Importance** | ${p.importance} |\n`;
      if (p.project) md += `| **Project** | ${p.project} |\n`;
      if (p.tags && p.tags.length) md += `| **Tags** | ${p.tags.join(', ')} |\n`;
      if (p.created_at) md += `| **Created** | ${p.created_at} |\n`;
      if (p.updated_at) md += `| **Updated** | ${p.updated_at} |\n`;
      if (p.related_files && p.related_files.length) md += `| **Files** | ${p.related_files.join(', ')} |\n`;
      md += `\n${p.content || '(empty)'}\n\n---\n\n`;
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

    // Check Qdrant for memories using this category (needed for both config and orphan categories)
    const scrollBody = { limit: 100, with_payload: true, filter: mergeExclusionFilter({ must: [{ key: 'category', match: { value: name } }] }) };
    const scrollResult = await qdrantFetch('/points/scroll', { method: 'POST', body: JSON.stringify(scrollBody) });
    const matchingPoints = scrollResult.result.points || [];

    // If not in config and no memories exist, it truly doesn't exist
    if (!existsInConfig && matchingPoints.length === 0) {
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

    if (matchingPoints.length > 0 && delete_memories) {
      // Soft-delete: move all memories to trash
      const pointIds = matchingPoints.map(p => p.id);
      await qdrantFetch('/points/payload', {
        method: 'POST',
        body: JSON.stringify({
          payload: { trashed_at: new Date().toISOString() },
          points: pointIds,
        }),
      });
      deletedCount = pointIds.length;
    } else if (matchingPoints.length > 0 && reassignTo) {
      // Reassign memories
      const allNames = new Set(categories.map(c => c.name));
      allNames.delete(name);
      if (!allNames.has(reassignTo)) {
        return res.status(400).json({ error: `Reassign target "${reassignTo}" is not a valid category.` });
      }

      const pointIds = matchingPoints.map(p => p.id);
      await qdrantFetch('/points/payload', {
        method: 'POST',
        body: JSON.stringify({
          payload: { category: reassignTo },
          points: pointIds,
        }),
      });
    } else if (matchingPoints.length > 0) {
      return res.status(409).json({
        error: `${matchingPoints.length} memories use this category. Provide reassign_to to move them or delete_memories to remove them.`,
        count: matchingPoints.length,
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
    if (matchingPoints.length > 0 && reassignTo) message += ` ${matchingPoints.length} memor${matchingPoints.length === 1 ? 'y' : 'ies'} reassigned to "${reassignTo}".`;

    res.json({
      categories: updated,
      message,
      reassigned: reassignTo ? matchingPoints.length : 0,
      deleted: deletedCount,
    });
  } catch (err) {
    console.error('DELETE /api/categories/:name error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/settings — Current config with masked keys
app.get('/api/settings', (req, res) => {
  try {
    const vars = parseEnvFile(ENV_PATH);

    // Qdrant config from .env
    const connData = loadQdrantConnections();
    const activeConn = connData.active ? connData.connections[connData.active] : null;
    const qdrantUrl = activeConn?.url || `http://localhost:${vars.QDRANT_PORT || '6333'}`;
    const qdrantApiKey = activeConn?.apiKey || '';
    const collection = activeConn?.collection || 'claude_memory';
    const openaiApiKey = vars.OPENAI_EMBEDDING_API_KEY || '';

    res.json({
      qdrantUrl,
      qdrantApiKey: maskKey(qdrantApiKey),
      qdrantApiKeySet: !!qdrantApiKey,
      collection,
      openaiApiKey: maskKey(openaiApiKey),
      openaiApiKeySet: !!openaiApiKey,
      qdrantPort: activeConn?.port ? String(activeConn.port) : '6333',
      qdrantGrpcPort: activeConn?.grpcPort ? String(activeConn.grpcPort) : '6334',
    });
  } catch (err) {
    console.error('GET /api/settings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings — Save settings to .env
app.put('/api/settings', (req, res) => {
  try {
    const { qdrantUrl, qdrantApiKey, collection, openaiApiKey, qdrantPort, qdrantGrpcPort } = req.body;

    // Embedding config
    const vars = parseEnvFile(ENV_PATH);
    if (openaiApiKey) {
      vars.OPENAI_EMBEDDING_API_KEY = openaiApiKey;
      // Also update namespaced embedding if it exists
      const embId = vars.EMBEDDING_ACTIVE;
      if (embId) vars[`EMBEDDING__${embId}__API_KEY`] = openaiApiKey;
    }
    writeEnvFile(ENV_PATH, vars);

    // Update active Qdrant connection in .env
    const connData = loadQdrantConnections();
    if (connData.active && connData.connections[connData.active]) {
      const conn = connData.connections[connData.active];
      if (qdrantUrl) conn.url = qdrantUrl;
      if (qdrantApiKey) conn.apiKey = qdrantApiKey;
      if (collection) conn.collection = collection;
      if (qdrantPort) conn.port = parseInt(qdrantPort, 10);
      if (qdrantGrpcPort) conn.grpcPort = parseInt(qdrantGrpcPort, 10);
      saveQdrantConnection(connData.active, conn);
    }

    reloadConfig();
    res.json({ ok: true, message: 'Settings saved. Neural Interface reloaded — restart your AI tool for MCP changes.' });
  } catch (err) {
    console.error('PUT /api/settings error:', err.message);
    res.status(500).json({ error: err.message });
  }
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


// --- Connection Management Routes (multi-instance Qdrant) ---
// All connection/bridge config is stored in .env (single source of truth).
// Functions: loadQdrantConnections(), saveQdrantConnection(), removeQdrantConnection(),
//            setActiveQdrantConnection(), getActiveConnectionIdFromEnv()
//            loadBridgeConfig(), saveBridgeConfig(), removeBridgeConfig()
// (Defined above near writeEnvFile)

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

// GET /api/connections — List all configured connections with live point counts
app.get('/api/connections', async (req, res) => {
  try {
    const data = loadQdrantConnections();
    const entries = [];

    for (const [id, conn] of Object.entries(data.connections)) {
      let points = 0;
      let reachable = false;
      try {
        const infoRes = await fetch(`${conn.url}/collections/${conn.collection}`, {
          headers: { 'Content-Type': 'application/json', 'api-key': conn.apiKey },
          signal: AbortSignal.timeout(3000),
        });
        if (infoRes.ok) {
          const info = await infoRes.json();
          points = info.result?.points_count ?? 0;
          reachable = true;
        }
      } catch {}
      entries.push({
        id,
        label: conn.label || id,
        url: conn.url,
        collection: conn.collection,
        points,
        reachable,
        active: id === data.active,
      });
    }

    res.json({ connections: entries, active: data.active });
  } catch (err) {
    console.error('GET /api/connections error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/connections/suggest-port — Suggest the next available port based on existing connections
app.get('/api/connections/suggest-port', (req, res) => {
  try {
    const data = loadQdrantConnections();
    let maxPort = 6333;
    for (const conn of Object.values(data.connections)) {
      const port = conn.port || extractPort(conn.url);
      maxPort = Math.max(maxPort, port);
    }
    // Round up to next 10 boundary, then add 10 for clean spacing
    const suggested = maxPort + 10 - (maxPort % 10) + (maxPort % 10 === 0 ? 0 : 10);
    res.json({ port: suggested, grpcPort: suggested + 1 });
  } catch (err) {
    res.json({ port: 6333, grpcPort: 6334 });
  }
});

// POST /api/connections — Add a new connection
app.post('/api/connections', async (req, res) => {
  try {
    const { id, label, url, apiKey, collection } = req.body;
    if (!id || !url || !apiKey || !collection) {
      return res.status(400).json({ error: 'id, url, apiKey, and collection are required' });
    }

    const envId = id.replace(/-/g, '_');
    const data = loadQdrantConnections();
    if (data.connections[envId]) {
      return res.status(409).json({ error: `Connection "${id}" already exists` });
    }

    // Verify we can reach Qdrant
    try {
      const pingRes = await fetch(`${url}/collections`, {
        headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
        signal: AbortSignal.timeout(5000),
      });
      if (!pingRes.ok) {
        return res.status(400).json({ error: `Cannot reach Qdrant at ${url} (HTTP ${pingRes.status})` });
      }
    } catch (err) {
      return res.status(400).json({ error: `Cannot reach Qdrant at ${url}: ${err.message}` });
    }

    saveQdrantConnection(id, { label: label || id, url, apiKey, collection });

    res.json({ ok: true, message: `Connection "${label || id}" added` });
  } catch (err) {
    console.error('POST /api/connections error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/connections/active — Switch active connection
app.put('/api/connections/active', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'Connection id is required' });
    }

    const data = loadQdrantConnections();
    const conn = data.connections[id];
    if (!conn) {
      return res.status(404).json({ error: `Connection "${id}" not found` });
    }

    // Verify we can reach it before switching
    try {
      const checkRes = await fetch(`${conn.url}/collections/${conn.collection}`, {
        headers: { 'Content-Type': 'application/json', 'api-key': conn.apiKey },
        signal: AbortSignal.timeout(5000),
      });
      if (!checkRes.ok) {
        return res.status(400).json({ error: `Cannot reach collection "${conn.collection}" at ${conn.url}` });
      }
    } catch (err) {
      return res.status(400).json({ error: `Cannot reach Qdrant at ${conn.url}: ${err.message}` });
    }

    setActiveQdrantConnection(id);

    // Also update the runtime variables so the neural interface uses the new connection
    QDRANT_URL = conn.url;
    QDRANT_KEY = conn.apiKey;
    COLLECTION = conn.collection;
    console.log(`  Connection switched — ${conn.label || id}: ${conn.url}/collections/${conn.collection}`);

    res.json({ ok: true, message: `Switched to "${conn.label || id}"`, active: id });
  } catch (err) {
    console.error('PUT /api/connections/active error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/connections/:id — Remove a connection
app.delete('/api/connections/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const data = loadQdrantConnections();
    if (!data.connections[id]) {
      return res.status(404).json({ error: `Connection "${id}" not found` });
    }
    if (id === data.active) {
      return res.status(400).json({ error: 'Cannot delete the active connection. Switch to another first.' });
    }

    removeQdrantConnection(id);

    res.json({ ok: true, message: `Connection "${id}" removed` });
  } catch (err) {
    console.error('DELETE /api/connections/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/connections/sync-env — DEPRECATED: .env is now the single source of truth
app.post('/api/connections/sync-env', (req, res) => {
  const data = loadQdrantConnections();
  const count = Object.keys(data.connections).length;
  res.json({ ok: true, message: `.env is the single source of truth. ${count} connections configured.` });
});

// POST /api/connections/start-container — Start a stopped Docker container for a connection
app.post('/api/connections/start-container', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Connection id is required' });

    const data = loadQdrantConnections();
    const conn = data.connections[id];
    if (!conn) return res.status(404).json({ error: `Connection "${id}" not found` });

    const port = conn.port || extractPort(conn.url);
    const containerName = 'synabun-qdrant-' + id.replace(/[^a-z0-9]/g, '-');

    // Try to start by exact container name first
    let started = false;
    try {
      await execAsync(`docker start ${containerName}`, { timeout: 15000 });
      started = true;
    } catch {
      // Fall back: search by port binding
      try {
        const { stdout } = await execAsync(
          `docker ps -a --filter "publish=${port}" --format "{{.Names}}"`,
          { timeout: 5000 }
        );
        const name = stdout.trim().split('\n')[0];
        if (name) {
          await execAsync(`docker start ${name}`, { timeout: 15000 });
          started = true;
        }
      } catch {}
    }

    if (!started) {
      return res.status(404).json({ error: `No Docker container found for "${id}" (port ${port}). Create a new one from the wizard.` });
    }

    // Wait for Qdrant to be ready (up to 15s)
    let ready = false;
    for (let i = 0; i < 15; i++) {
      try {
        const ping = await fetch(`${conn.url}/collections`, {
          headers: { 'api-key': conn.apiKey },
          signal: AbortSignal.timeout(2000),
        });
        if (ping.ok) { ready = true; break; }
      } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }

    res.json({ ok: ready, message: ready ? 'Container started' : 'Container started but Qdrant not responding yet' });
  } catch (err) {
    console.error('POST /api/connections/start-container error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/connections/:id/backup — Create and download a Qdrant snapshot
app.post('/api/connections/:id/backup', async (req, res) => {
  try {
    const { id } = req.params;
    const data = loadQdrantConnections();
    const conn = data.connections[id];
    if (!conn) return res.status(404).json({ error: `Connection "${id}" not found` });

    const { url, apiKey, collection } = conn;
    const headers = { 'api-key': apiKey };

    // 1. Create snapshot
    const snapRes = await fetch(`${url}/collections/${collection}/snapshots`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(120000),
    });
    if (!snapRes.ok) {
      const text = await snapRes.text();
      throw new Error(`Snapshot creation failed: ${text}`);
    }
    const snapData = await snapRes.json();
    const snapName = snapData.result?.name;
    if (!snapName) throw new Error('Snapshot created but no name returned');

    // 2. Download snapshot binary
    const dlRes = await fetch(`${url}/collections/${collection}/snapshots/${snapName}`, {
      headers,
      signal: AbortSignal.timeout(300000),
    });
    if (!dlRes.ok) {
      const text = await dlRes.text();
      throw new Error(`Snapshot download failed: ${text}`);
    }

    // 3. Stream to client
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${collection}-${timestamp}.snapshot"`);
    if (dlRes.headers.get('content-length')) {
      res.setHeader('Content-Length', dlRes.headers.get('content-length'));
    }

    const nodeStream = Readable.fromWeb(dlRes.body);
    nodeStream.pipe(res);

    nodeStream.on('end', () => {
      // 4. Cleanup: delete the snapshot from Qdrant (fire-and-forget)
      fetch(`${url}/collections/${collection}/snapshots/${snapName}`, {
        method: 'DELETE',
        headers,
        signal: AbortSignal.timeout(10000),
      }).catch(() => {});
    });

    nodeStream.on('error', (err) => {
      console.error('Snapshot stream error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    });
  } catch (err) {
    console.error('POST /api/connections/:id/backup error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// POST /api/connections/:id/restore — Upload a .snapshot file to restore a collection
app.post('/api/connections/:id/restore', express.raw({ type: 'application/octet-stream', limit: '500mb' }), async (req, res) => {
  try {
    const { id } = req.params;
    const data = loadQdrantConnections();
    const conn = data.connections[id];
    if (!conn) return res.status(404).json({ error: `Connection "${id}" not found` });

    if (!req.body || req.body.length === 0) {
      return res.status(400).json({ error: 'No snapshot data received' });
    }

    const { url, apiKey, collection } = conn;

    // Build multipart form data with the snapshot buffer
    const form = new FormData();
    form.append('snapshot', new Blob([req.body]), 'restore.snapshot');

    const uploadRes = await fetch(`${url}/collections/${collection}/snapshots/upload?priority=snapshot`, {
      method: 'POST',
      headers: { 'api-key': apiKey },
      body: form,
      signal: AbortSignal.timeout(300000),
    });

    if (!uploadRes.ok) {
      const text = await uploadRes.text();
      throw new Error(`Restore failed: ${text}`);
    }

    res.json({ ok: true, message: `Collection "${collection}" restored successfully` });
  } catch (err) {
    console.error('POST /api/connections/:id/restore error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/connections/restore-standalone — Restore a snapshot to any Qdrant instance (not necessarily in connections.json)
// Expects URL query params: ?url=...&apiKey=...&collection=...&label=...
// Body: raw snapshot bytes (application/octet-stream)
app.post('/api/connections/restore-standalone', express.raw({ type: 'application/octet-stream', limit: '500mb' }), async (req, res) => {
  try {
    const { url, apiKey, collection, label } = req.query;
    if (!url || !apiKey || !collection) {
      return res.status(400).json({ error: 'url, apiKey, and collection query params are required' });
    }
    if (!req.body || req.body.length === 0) {
      return res.status(400).json({ error: 'No snapshot data received' });
    }

    // Upload snapshot to Qdrant (creates collection if it doesn't exist)
    const form = new FormData();
    form.append('snapshot', new Blob([req.body]), 'restore.snapshot');

    const uploadRes = await fetch(`${url}/collections/${collection}/snapshots/upload?priority=snapshot`, {
      method: 'POST',
      headers: { 'api-key': apiKey },
      body: form,
      signal: AbortSignal.timeout(300000),
    });

    if (!uploadRes.ok) {
      const text = await uploadRes.text();
      throw new Error(`Restore failed: ${text}`);
    }

    // Add to .env if not already there
    const envId = (label || collection).toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'restored';
    const data = loadQdrantConnections();
    if (!data.connections[envId]) {
      saveQdrantConnection(envId, { label: label || collection, url, apiKey, collection });
    }

    res.json({ ok: true, message: `Collection "${collection}" restored successfully`, connectionId: id });
  } catch (err) {
    console.error('POST /api/connections/restore-standalone error:', err.message);
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
      version: 1,
      created: new Date().toISOString(),
      hostname: os.hostname(),
      connections: {},
      unreachableConnections: [],
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
                      'claude-code-projects.json', 'mcp-api-key.json', 'keybinds.json', 'cli-config.json']) {
      addFile(`data/${f}`, resolve(dataDir, f));
    }
    addJsonDir('data/pending-remember', resolve(dataDir, 'pending-remember'));
    addJsonDir('data/pending-compact', resolve(dataDir, 'pending-compact'));

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

    // 7. Qdrant snapshots — one per reachable connection
    const connData = loadQdrantConnections();
    for (const [id, conn] of Object.entries(connData.connections)) {
      try {
        const baseUrl = conn.url || `http://localhost:${conn.port || 6333}`;
        const headers = { 'api-key': conn.apiKey };

        // Health check
        const healthRes = await fetch(`${baseUrl}/healthz`, {
          headers, signal: AbortSignal.timeout(5000),
        });
        if (!healthRes.ok) throw new Error('unreachable');

        // Get point count
        let pointCount = 0;
        try {
          const infoRes = await fetch(`${baseUrl}/collections/${conn.collection}`, {
            headers, signal: AbortSignal.timeout(5000),
          });
          if (infoRes.ok) {
            const info = await infoRes.json();
            pointCount = info?.result?.points_count ?? 0;
          }
        } catch { /* non-critical */ }

        // Create snapshot
        const snapRes = await fetch(`${baseUrl}/collections/${conn.collection}/snapshots`, {
          method: 'POST', headers, signal: AbortSignal.timeout(120000),
        });
        if (!snapRes.ok) throw new Error('snapshot creation failed');
        const snapData = await snapRes.json();
        const snapName = snapData.result?.name;
        if (!snapName) throw new Error('no snapshot name returned');

        // Download snapshot
        const dlRes = await fetch(`${baseUrl}/collections/${conn.collection}/snapshots/${snapName}`, {
          headers, signal: AbortSignal.timeout(300000),
        });
        if (!dlRes.ok) throw new Error('snapshot download failed');

        const snapBuffer = Buffer.from(await dlRes.arrayBuffer());
        const archiveName = `snapshots/${id}.snapshot`;
        archive.append(snapBuffer, { name: `${prefix}/${archiveName}` });

        manifest.connections[id] = {
          collection: conn.collection,
          label: conn.label,
          snapshotFile: archiveName,
          snapshotSizeBytes: snapBuffer.length,
          pointCount,
        };

        // Cleanup: delete snapshot from Qdrant (fire-and-forget)
        fetch(`${baseUrl}/collections/${conn.collection}/snapshots/${snapName}`, {
          method: 'DELETE', headers, signal: AbortSignal.timeout(10000),
        }).catch(() => {});

      } catch (err) {
        console.warn(`  Backup: skipping connection "${id}": ${err.message}`);
        manifest.unreachableConnections.push(id);
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
    if (manifest.version !== 1) {
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
      for (const subdir of ['pending-remember', 'pending-compact']) {
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

    // Reload server config after config files are restored (so globals like QDRANT_URL are fresh)
    if (mode === 'full' || mode === 'config-only') {
      reloadConfig();
    }

    // Restore Qdrant snapshots
    if (mode === 'full' || mode === 'snapshots-only') {
      // Reload connections (may have changed from .env restore above)
      reloadConfig();
      const connData = loadQdrantConnections();

      for (const [connId, snapInfo] of Object.entries(manifest.connections || {})) {
        const snapshotEntry = entries.find(e =>
          e.entryName === `${prefix}/${snapInfo.snapshotFile}`
        );
        if (!snapshotEntry) {
          results.errors.push(`Snapshot for "${connId}" not found in ZIP`);
          continue;
        }

        const conn = connData.connections[connId];
        if (!conn) {
          results.errors.push(`Connection "${connId}" (${snapInfo.collection}) not found in current config — skipped`);
          continue;
        }

        try {
          const baseUrl = conn.url || `http://localhost:${conn.port || 6333}`;
          const form = new FormData();
          form.append('snapshot', new Blob([snapshotEntry.getData()]), 'restore.snapshot');

          const uploadRes = await fetch(
            `${baseUrl}/collections/${conn.collection}/snapshots/upload?priority=snapshot`,
            {
              method: 'POST',
              headers: { 'api-key': conn.apiKey },
              body: form,
              signal: AbortSignal.timeout(300000),
            }
          );

          if (!uploadRes.ok) {
            const text = await uploadRes.text();
            throw new Error(text);
          }

          results.snapshots.push({
            id: connId,
            collection: snapInfo.collection,
            pointCount: snapInfo.pointCount,
          });
        } catch (err) {
          results.errors.push(`Failed to restore "${connId}": ${err.message}`);
        }
      }
    }

    res.json({ ok: true, message: 'Backup restored successfully', results });
  } catch (err) {
    console.error('POST /api/system/restore error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
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

  // Docker
  try {
    const { stdout } = await execAsync('docker --version', { timeout: 5000 });
    const ver = stdout.trim().match(/Docker version ([\d.]+)/)?.[1] || stdout.trim();
    // CLI exists — now check if daemon is running
    try {
      await execAsync('docker info', { timeout: 8000 });
      deps.push({ id: 'docker', name: 'Docker', ok: true, version: ver, detail: `v${ver} (running)`, url: 'https://docs.docker.com/get-docker/' });
    } catch {
      deps.push({ id: 'docker', name: 'Docker', ok: false, warn: true, version: ver, detail: `v${ver} (not running)`, url: 'https://docs.docker.com/get-docker/' });
    }
  } catch {
    deps.push({ id: 'docker', name: 'Docker', ok: false, warn: true, version: null, detail: 'Not found (optional if using Qdrant Cloud)', url: 'https://docs.docker.com/get-docker/' });
  }

  // Git
  try {
    const { stdout } = await execAsync('git --version', { timeout: 5000 });
    const ver = stdout.trim().match(/git version ([\d.]+)/)?.[1] || stdout.trim();
    deps.push({ id: 'git', name: 'Git', ok: true, version: ver, detail: `v${ver}`, url: 'https://git-scm.com/downloads' });
  } catch {
    deps.push({ id: 'git', name: 'Git', ok: false, warn: true, version: null, detail: 'Not found (optional)', url: 'https://git-scm.com/downloads' });
  }

  res.json({ deps });
});

// GET /api/setup/onboarding — Check what's configured (onboarding wizard)
app.get('/api/setup/onboarding', async (req, res) => {
  try {
    const vars = parseEnvFile(ENV_PATH);
    const setupComplete = vars.SETUP_COMPLETE === 'true';
    const hasEmbeddingKey = !!vars.OPENAI_EMBEDDING_API_KEY;

    // Check .env for Qdrant config
    const connData = loadQdrantConnections();
    const activeConn = connData.active ? connData.connections[connData.active] : null;
    const hasQdrantKey = !!(activeConn?.apiKey) ||
      Object.keys(vars).some(k => k.match(/^QDRANT__[a-z0-9_]+__API_KEY$/));

    let dockerRunning = false;
    try {
      const qdrantRes = await fetch(`${QDRANT_URL}/collections`, {
        headers: { 'api-key': QDRANT_KEY },
        signal: AbortSignal.timeout(3000),
      });
      dockerRunning = qdrantRes.ok;
    } catch {}

    const mcpBuilt = existsSync(resolve(PROJECT_ROOT, 'mcp-server', 'dist', 'index.js'));

    res.json({
      setupComplete,
      hasQdrantKey,
      hasEmbeddingKey,
      dockerRunning,
      mcpBuilt,
      projectDir: PROJECT_ROOT,
      platform: process.platform,
    });
  } catch (err) {
    console.error('GET /api/setup/onboarding error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/setup/save-config — Write all config to .env (single source of truth)
app.post('/api/setup/save-config', (req, res) => {
  try {
    const { qdrantApiKey, qdrantUrl, collectionName, collectionDisplayName, embeddingApiKey, embeddingBaseUrl, embeddingModel, embeddingDimensions, qdrantPort, qdrantGrpcPort } = req.body;

    const vars = parseEnvFile(ENV_PATH); // Returns {} on fresh install

    // --- Embedding config ---
    const embId = vars.EMBEDDING_ACTIVE || 'openai_main';
    if (embeddingApiKey) {
      vars.EMBEDDING_ACTIVE = embId;
      vars[`EMBEDDING__${embId}__API_KEY`] = embeddingApiKey;
      vars[`EMBEDDING__${embId}__LABEL`] = 'OpenAI Main';
      // Also keep legacy key for backward compat
      vars.OPENAI_EMBEDDING_API_KEY = embeddingApiKey;
    }
    if (embeddingBaseUrl && embeddingBaseUrl !== 'https://api.openai.com/v1') {
      vars[`EMBEDDING__${embId}__BASE_URL`] = embeddingBaseUrl;
    }
    if (embeddingModel && embeddingModel !== 'text-embedding-3-small') {
      vars[`EMBEDDING__${embId}__MODEL`] = embeddingModel;
    }
    if (embeddingDimensions && String(embeddingDimensions) !== '1536') {
      vars[`EMBEDDING__${embId}__DIMENSIONS`] = String(embeddingDimensions);
    }

    // Remove legacy flat Qdrant keys
    delete vars.QDRANT_PORT;
    delete vars.QDRANT_GRPC_PORT;
    delete vars.QDRANT_MEMORY_API_KEY;

    // --- Qdrant connection ---
    if (qdrantUrl && qdrantApiKey && collectionName) {
      const connId = collectionName.replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'default';
      const connLabel = collectionDisplayName || collectionName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const port = qdrantPort || extractPort(qdrantUrl);
      const grpc = qdrantGrpcPort || (parseInt(port, 10) + 1);

      vars[`QDRANT__${connId}__PORT`] = String(port);
      vars[`QDRANT__${connId}__GRPC_PORT`] = String(grpc);
      vars[`QDRANT__${connId}__API_KEY`] = qdrantApiKey;
      vars[`QDRANT__${connId}__COLLECTION`] = collectionName;
      vars[`QDRANT__${connId}__LABEL`] = connLabel;
      if (qdrantUrl && !qdrantUrl.match(/^https?:\/\/localhost:\d+\/?$/)) {
        vars[`QDRANT__${connId}__URL`] = qdrantUrl;
      }

      if (!vars.QDRANT_ACTIVE) vars.QDRANT_ACTIVE = connId;
    }

    writeEnvFile(ENV_PATH, vars);
    reloadConfig();
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/setup/save-config error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/setup/start-docker-desktop — Launch Docker Desktop and wait for daemon (does NOT start containers)
app.post('/api/setup/start-docker-desktop', async (req, res) => {
  try {
    // Try to launch Docker Desktop (Windows)
    const dockerDesktopPaths = [
      'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe',
      `${process.env.LOCALAPPDATA}\\Docker\\Docker Desktop.exe`,
    ];

    let launched = false;
    for (const p of dockerDesktopPaths) {
      try {
        if (existsSync(p)) {
          await execAsync(`start "" "${p}"`, { timeout: 5000, shell: true });
          launched = true;
          break;
        }
      } catch {}
    }

    if (!launched) {
      try {
        await execAsync('start "" "Docker Desktop"', { timeout: 5000, shell: true });
        launched = true;
      } catch {}
    }

    if (!launched) {
      return res.status(400).json({ error: 'Could not find Docker Desktop. Please start it manually.' });
    }

    // Wait for Docker daemon to be ready (up to 45s)
    let daemonReady = false;
    for (let i = 0; i < 45; i++) {
      try {
        await execAsync('docker info', { timeout: 3000 });
        daemonReady = true;
        break;
      } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }

    if (!daemonReady) {
      return res.json({ ok: false, error: 'Docker Desktop launched but daemon not ready after 45s. Try again.' });
    }

    res.json({ ok: true, daemonReady: true });
  } catch (err) {
    console.error('POST /api/setup/start-docker-desktop error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/setup/docker — Start a Qdrant Docker container (plug-and-play, unique per collection)
app.post('/api/setup/docker', async (req, res) => {
  try {
    // Derive unique container/volume names from the collection name
    const collSafe = COLLECTION.replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const containerName = 'synabun-qdrant-' + collSafe;
    const volumeName = containerName + '-data';
    let port = parseInt(new URL(QDRANT_URL).port, 10) || 6333;
    let grpcPort = port + 1;

    // Helper: check if a port is free by attempting a TCP connection
    async function isPortFree(p) {
      return new Promise(resolve => {
        const sock = netConnect({ port: p, host: '127.0.0.1' }, () => {
          sock.destroy();
          resolve(false); // something is listening — port is taken
        });
        sock.on('error', () => resolve(true)); // nothing listening — port is free
        sock.setTimeout(1000, () => { sock.destroy(); resolve(true); });
      });
    }

    // Helper: find the next free port starting from a given port
    async function findFreePort(startPort) {
      let p = startPort;
      for (let i = 0; i < 20; i++) {
        const httpFree = await isPortFree(p);
        const grpcFree = await isPortFree(p + 1);
        if (httpFree && grpcFree) return p;
        p += 10; // jump in increments of 10 for clean spacing
      }
      return null;
    }

    // ── Helper: get the real host port a container is mapped to ──
    async function getContainerPort(name) {
      try {
        const result = await execAsync(`docker port ${name} 6333`, { timeout: 5000 });
        // Output like "0.0.0.0:6333" or ":::6333"
        const m = (result.stdout || '').match(/:(\d+)\s*$/m);
        return m ? parseInt(m[1], 10) : null;
      } catch { return null; }
    }

    // ── Check if our container already exists (running or stopped) ──
    let containerExists = false;
    let containerRunning = false;
    try {
      const inspect = await execAsync(
        `docker inspect --format={{.State.Running}} ${containerName}`,
        { timeout: 5000 }
      );
      containerExists = true;
      containerRunning = (inspect.stdout || '').trim() === 'true';
    } catch {} // container doesn't exist — will create fresh

    let stdout = '', stderr = '';

    if (containerExists) {
      // Container exists — get its REAL port mapping (can't be changed after creation)
      const realPort = containerRunning ? await getContainerPort(containerName) : null;

      if (containerRunning && realPort) {
        // Already running — use its actual port
        port = realPort;
        grpcPort = realPort + 1;
        stdout = `Container "${containerName}" is already running on port ${port}.`;
      } else if (containerRunning) {
        // Running but can't determine port — trust configured port
        stdout = `Container "${containerName}" is already running.`;
      } else {
        // Stopped — need to check if its port mapping matches what we want
        // Get the port from the container's config (works even when stopped)
        let mappedPort = null;
        try {
          const inspectPorts = await execAsync(
            `docker inspect --format={{json .HostConfig.PortBindings}} ${containerName}`,
            { timeout: 5000 }
          );
          const bindings = JSON.parse((inspectPorts.stdout || '').trim());
          const httpBinding = bindings['6333/tcp'];
          if (httpBinding && httpBinding[0]) {
            mappedPort = parseInt(httpBinding[0].HostPort, 10);
          }
        } catch {}

        if (mappedPort && mappedPort !== port) {
          // Container was created with a different port — check if that port is free
          if (await isPortFree(mappedPort) && await isPortFree(mappedPort + 1)) {
            // Original port is free — start on it and update our port var
            port = mappedPort;
            grpcPort = mappedPort + 1;
          } else {
            // Original port is taken — remove old container and recreate with new port
            await execAsync(`docker rm ${containerName}`, { timeout: 10000 });
            containerExists = false; // fall through to fresh creation below
          }
        }

        if (containerExists) {
          // Start the existing container on its original port
          const startResult = await execAsync(`docker start ${containerName}`, { timeout: 15000 });
          stdout = `Starting container "${containerName}" on port ${port}...\n` + (startResult.stdout || '');
          stderr = startResult.stderr || '';
        }
      }
    }

    if (!containerExists) {
      // Container doesn't exist — check ports and create fresh
      if (!(await isPortFree(port)) || !(await isPortFree(grpcPort))) {
        const freePort = await findFreePort(port + 10);
        if (!freePort) {
          return res.status(409).json({
            error: `Port ${port} is in use and no free port found in range ${port + 10}-${port + 210}. Change the port above and try again.`,
            portConflict: true,
            port: String(port),
            output: `Scanned ports ${port + 10} to ${port + 210}, all busy.`,
          });
        }
        port = freePort;
        grpcPort = freePort + 1;
      }

      const cmd = [
        'docker run -d',
        `--name ${containerName}`,
        '--restart unless-stopped',
        `-p ${port}:6333`,
        `-p ${grpcPort}:6334`,
        `-v ${volumeName}:/qdrant/storage`,
        `-e QDRANT__SERVICE__API_KEY=${QDRANT_KEY}`,
        `-e QDRANT__LOG_LEVEL=WARN`,
        'qdrant/qdrant:latest',
      ].join(' ');

      const result = await execAsync(cmd, { timeout: 30000 });
      stdout = result.stdout || '';
      stderr = result.stderr || '';
    }

    // Wait for Qdrant to be ready on the ACTUAL port (up to 30s)
    const resolvedUrl = `http://localhost:${port}`;
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const ping = await fetch(`${resolvedUrl}/collections`, {
          headers: { 'api-key': QDRANT_KEY },
          signal: AbortSignal.timeout(2000),
        });
        if (ping.ok) { ready = true; break; }
      } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }

    res.json({ ok: true, output: stdout + (stderr || ''), ready, port, grpcPort });
  } catch (err) {
    console.error('POST /api/setup/docker error:', err.message);
    res.status(500).json({ error: err.message, output: err.stderr || '' });
  }
});

// POST /api/setup/create-collection — Create Qdrant collection
app.post('/api/setup/create-collection', async (req, res) => {
  try {
    // Use runtime vars (already set by reloadConfig after save-config)
    const apiKey = QDRANT_KEY;
    const qdrantUrl = QDRANT_URL;
    const collection = COLLECTION;
    const dims = EMBEDDING_DIMS;

    // Check if collection already exists
    const checkRes = await fetch(`${qdrantUrl}/collections/${collection}`, {
      headers: { 'api-key': apiKey },
      signal: AbortSignal.timeout(5000),
    });
    if (checkRes.ok) {
      return res.json({ ok: true, message: 'Collection already exists', existed: true });
    }

    // Create collection
    const createRes = await fetch(`${qdrantUrl}/collections/${collection}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({
        vectors: { size: dims, distance: 'Cosine' },
      }),
    });

    if (!createRes.ok) {
      const text = await createRes.text();
      throw new Error(`Qdrant ${createRes.status}: ${text}`);
    }

    res.json({ ok: true, message: `Collection "${collection}" created (${dims}d vectors)`, existed: false });
  } catch (err) {
    console.error('POST /api/setup/create-collection error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/connections/docker-new — Spin up a new Qdrant Docker container on a specified port
app.post('/api/connections/docker-new', async (req, res) => {
  try {
    const { port, grpcPort, apiKey, containerName, volumeName } = req.body;
    if (!port || !apiKey || !containerName || !volumeName) {
      return res.status(400).json({ error: 'port, apiKey, containerName, and volumeName are required' });
    }

    const httpPort = parseInt(port, 10);
    const grpc = parseInt(grpcPort || (httpPort + 1), 10);

    const cmd = [
      'docker run -d',
      `--name ${containerName}`,
      '--restart unless-stopped',
      `-p ${httpPort}:6333`,
      `-p ${grpc}:6334`,
      `-v ${volumeName}:/qdrant/storage`,
      `-e QDRANT__SERVICE__API_KEY=${apiKey}`,
      `-e QDRANT__LOG_LEVEL=WARN`,
      'qdrant/qdrant:latest',
    ].join(' ');

    let stdout = '', stderr = '';
    try {
      const result = await execAsync(cmd, { timeout: 30000 });
      stdout = result.stdout || '';
      stderr = result.stderr || '';
    } catch (err) {
      const combined = (err.stderr || '') + (err.message || '');
      if (combined.includes('port is already allocated') || combined.includes('address already in use')) {
        return res.status(409).json({ error: `Port ${httpPort} is already in use`, portConflict: true, output: combined });
      }
      if (combined.includes('Conflict') || combined.includes('already in use by container')) {
        return res.status(409).json({ error: `Container name "${containerName}" already exists`, nameConflict: true, output: combined });
      }
      throw err;
    }

    // Poll until Qdrant is ready (up to 30s)
    const qdrantUrl = `http://localhost:${httpPort}`;
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const ping = await fetch(`${qdrantUrl}/collections`, {
          headers: { 'api-key': apiKey },
          signal: AbortSignal.timeout(2000),
        });
        if (ping.ok) { ready = true; break; }
      } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }

    res.json({ ok: true, url: qdrantUrl, ready, output: stdout + stderr });
  } catch (err) {
    console.error('POST /api/connections/docker-new error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/connections/create-collection — Create a Qdrant collection on any instance
app.post('/api/connections/create-collection', async (req, res) => {
  try {
    const { url, apiKey, collection } = req.body;
    if (!url || !apiKey || !collection) {
      return res.status(400).json({ error: 'url, apiKey, and collection are required' });
    }
    const dims = EMBEDDING_DIMS;

    // Check if collection already exists
    const checkRes = await fetch(`${url}/collections/${collection}`, {
      headers: { 'api-key': apiKey },
      signal: AbortSignal.timeout(5000),
    });
    if (checkRes.ok) {
      return res.json({ ok: true, message: 'Collection already exists', existed: true });
    }

    // Create collection
    const createRes = await fetch(`${url}/collections/${collection}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({ vectors: { size: dims, distance: 'Cosine' } }),
    });
    if (!createRes.ok) {
      const text = await createRes.text();
      throw new Error(`Qdrant ${createRes.status}: ${text}`);
    }

    res.json({ ok: true, message: `Collection "${collection}" created (${dims}d vectors)`, existed: false });
  } catch (err) {
    console.error('POST /api/connections/create-collection error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/setup/build — Build the MCP server
app.post('/api/setup/build', async (req, res) => {
  try {
    const mcpDir = resolve(PROJECT_ROOT, 'mcp-server');
    const { stdout, stderr } = await execAsync('npm install && npm run build', {
      cwd: mcpDir,
      timeout: 120000,
    });
    res.json({ ok: true, output: stdout + (stderr || '') });
  } catch (err) {
    console.error('POST /api/setup/build error:', err.message);
    res.status(500).json({ error: err.message, output: err.stdout || '' });
  }
});

// GET /api/setup/test-qdrant — Ping Qdrant (accepts ?port= to test a specific port)
app.get('/api/setup/test-qdrant', async (req, res) => {
  try {
    const port = req.query.port ? parseInt(req.query.port, 10) : null;
    const url = port ? `http://localhost:${port}` : QDRANT_URL;
    const ping = await fetch(`${url}/collections`, {
      headers: { 'api-key': QDRANT_KEY },
      signal: AbortSignal.timeout(3000),
    });
    res.json({ ok: ping.ok });
  } catch {
    res.json({ ok: false });
  }
});

// POST /api/setup/test-qdrant-cloud — Test connection to a remote Qdrant instance
app.post('/api/setup/test-qdrant-cloud', async (req, res) => {
  try {
    const { url, apiKey } = req.body;
    if (!url || !apiKey) return res.status(400).json({ error: 'url and apiKey required' });

    const ping = await fetch(`${url.replace(/\/+$/, '')}/collections`, {
      headers: { 'api-key': apiKey },
    });
    if (!ping.ok) {
      const text = await ping.text();
      return res.json({ ok: false, error: `Qdrant responded ${ping.status}: ${text.slice(0, 200)}` });
    }
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

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
  { event: 'PostToolUse',       script: 'post-remember.mjs', timeout: 3, matcher: '^Edit$|^Write$|^NotebookEdit$|Syna[Bb]un__remember' },
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
  const def = HOOK_SCRIPTS.find(d => d.event === hookEvent);
  if (!def) return false;
  const cmd = hookCommandString(def.script);
  return settings.hooks[hookEvent].some(entry =>
    entry.hooks?.some(h => h.command === cmd)
  );
}

function addHookToSettings(settings, onlyEvent) {
  if (!settings) settings = {};
  if (!settings.hooks) settings.hooks = {};

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
        let projSettings = readClaudeSettings(projFile);
        if (projSettings) {
          projSettings = addHookToSettings(projSettings, hook || undefined);
          writeClaudeSettings(projFile, projSettings);
        }
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
      const projects = loadHookProjects();
      if (!projects.some(p => resolve(p.path) === normalized)) {
        projects.push({ path: normalized, label: label || basename(normalized) });
        saveHookProjects(projects);
      }

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
    if (!existsSync(claudeMdPath)) {
      return res.status(404).json({ error: 'CLAUDE.md not found' });
    }
    const content = readFileSync(claudeMdPath, 'utf-8');
    const format = (req.query.format || 'claude').toLowerCase();

    // Section markers in CLAUDE.md
    const MARKERS = {
      claude:  { start: '## Memory Ruleset', end: '## Condensed Rulesets' },
      cursor:  { start: '### Cursor',  end: '### Generic' },
      generic: { start: '### Generic', end: '### Gemini' },
      gemini:  { start: '### Gemini',  end: '### Codex' },
      codex:   { start: '### Codex',   end: '\n---' },
    };

    const marker = MARKERS[format];
    if (!marker) {
      return res.status(400).json({ error: `Invalid format: ${format}. Use claude, cursor, generic, gemini, or codex.` });
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
  if (!existsSync(SKILLS_SOURCE_DIR)) return [];
  const entries = readdirSync(SKILLS_SOURCE_DIR, { withFileTypes: true });
  const skills = [];
  for (const entry of entries) {
    if (!isDirEntry(entry)) continue;
    const skillFile = join(SKILLS_SOURCE_DIR, entry.name, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    const content = readFileSync(skillFile, 'utf-8');
    const { name, description } = parseSkillFrontmatter(content);
    const installedPath = join(getGlobalSkillsDir(), entry.name, 'SKILL.md');
    skills.push({
      dirName: entry.name,
      name: name || entry.name,
      description: description || '',
      installed: existsSync(installedPath),
      sourcePath: skillFile,
      installedPath,
    });
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

// Helper: detect if Docker Desktop is installed on Windows
function detectDockerDesktop() {
  const paths = [
    'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe',
    `${process.env.LOCALAPPDATA}\\Docker\\Docker Desktop.exe`,
  ];
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}

// GET /api/health — Pre-flight check: is Qdrant reachable? Is Docker running?
app.get('/api/health', async (req, res) => {
  const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(QDRANT_URL);

  // 1. Try reaching Qdrant directly
  try {
    const ping = await fetch(`${QDRANT_URL}/collections`, {
      headers: { 'api-key': QDRANT_KEY },
      signal: AbortSignal.timeout(3000),
    });
    if (ping.ok) {
      return res.json({ ok: true });
    }
    return res.json({ ok: false, reason: 'auth_error', detail: `Qdrant responded with HTTP ${ping.status}` });
  } catch {
    // Qdrant unreachable
  }

  // If remote Qdrant, Docker doesn't matter
  if (!isLocal) {
    return res.json({ ok: false, reason: 'remote_unreachable', detail: `Cannot reach ${QDRANT_URL}` });
  }

  // 2. Check Docker daemon
  let dockerRunning = false;
  try {
    await execAsync('docker info', { timeout: 5000 });
    dockerRunning = true;
  } catch {}

  if (!dockerRunning) {
    const desktopPath = detectDockerDesktop();
    return res.json({
      ok: false,
      reason: 'docker_not_running',
      canAutoStart: !!desktopPath,
    });
  }

  // 3. Docker running — check container state
  try {
    const { stdout } = await execAsync('docker ps -a --filter "name=claude-memory" --format "{{.Status}}"', { timeout: 5000 });
    const status = stdout.trim().toLowerCase();
    if (status && !status.startsWith('up')) {
      return res.json({ ok: false, reason: 'container_stopped', canAutoStart: true });
    }
  } catch {}

  return res.json({ ok: false, reason: 'qdrant_unreachable', canAutoStart: true });
});

// POST /api/health/start — One-button fix: start Docker + containers + wait for Qdrant
app.post('/api/health/start', async (req, res) => {
  try {
    // 1. If Docker daemon isn't running, try to launch Docker Desktop
    let dockerRunning = false;
    try {
      await execAsync('docker info', { timeout: 3000 });
      dockerRunning = true;
    } catch {}

    if (!dockerRunning) {
      const desktopPath = detectDockerDesktop();
      if (!desktopPath) {
        return res.json({ ok: false, error: 'Docker is not installed. Install Docker Desktop or configure a remote Qdrant instance.' });
      }

      // Launch Docker Desktop
      try {
        await execAsync(`start "" "${desktopPath}"`, { timeout: 5000, shell: true });
      } catch {}

      // Wait for daemon (up to 60s — Docker Desktop can be slow on first launch)
      for (let i = 0; i < 60; i++) {
        try {
          await execAsync('docker info', { timeout: 3000 });
          dockerRunning = true;
          break;
        } catch {}
        await new Promise(r => setTimeout(r, 1000));
      }

      if (!dockerRunning) {
        return res.json({ ok: false, error: 'Docker Desktop was launched but the engine did not start in time. Try again.' });
      }
    }

    // 2. Start containers — build env vars from active connection
    const connData = loadQdrantConnections();
    const activeConn = connData.active ? connData.connections[connData.active] : null;
    const dcPort = activeConn ? (activeConn.port || extractPort(activeConn.url)) : 6333;
    const dcApiKey = activeConn ? activeConn.apiKey : QDRANT_KEY;

    await execAsync('docker compose up -d', {
      cwd: PROJECT_ROOT,
      timeout: 60000,
      env: {
        ...process.env,
        QDRANT_PORT: String(dcPort),
        QDRANT_GRPC_PORT: String(dcPort + 1),
        QDRANT_MEMORY_API_KEY: dcApiKey,
      },
    });

    // 3. Wait for Qdrant to respond (up to 30s)
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const ping = await fetch(`${QDRANT_URL}/collections`, {
          headers: { 'api-key': QDRANT_KEY },
          signal: AbortSignal.timeout(2000),
        });
        if (ping.ok) { ready = true; break; }
      } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }

    res.json({ ok: true, ready });
  } catch (err) {
    console.error('POST /api/health/start error:', err.message);
    res.json({ ok: false, error: err.message });
  }
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

// --- Cloudflare Tunnel Management ---
let tunnelProcess = null;
let tunnelUrl = null;
let tunnelStarting = false;

function findCloudflared() {
  const paths = [
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    `${process.env.LOCALAPPDATA}\\cloudflared\\cloudflared.exe`,
  ];
  for (const p of paths) { if (existsSync(p)) return p; }
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
}

const SHELL_PROFILE = { shell: DEFAULT_SHELL, args: [], env: {} };

/**
 * Build terminal profile config dynamically from cli-config.json.
 * Re-reads config each call so changes take effect without restart.
 */
function getTerminalProfile(profileId) {
  if (profileId === 'shell') return SHELL_PROFILE;

  const config = loadCliConfig();
  const entry = config[profileId];
  if (!entry || !entry.command) return SHELL_PROFILE;

  const cmd = entry.command.trim();
  if (!cmd) return SHELL_PROFILE;

  return {
    shell: DEFAULT_SHELL,
    args: IS_WIN ? ['/k', cmd] : ['-c', `${cmd}; exec $SHELL`],
    env: { FORCE_COLOR: '1', TERM: 'xterm-256color' },
  };
}

function createTerminalSession(profile, cols, rows, cwd) {
  const sessionId = randomBytes(16).toString('hex');
  const profileCfg = getTerminalProfile(profile);

  const ptyProcess = pty.spawn(profileCfg.shell, profileCfg.args, {
    name: 'xterm-256color',
    cols: cols || 120,
    rows: rows || 30,
    cwd: cwd || process.env.USERPROFILE || process.env.HOME || process.cwd(),
    env: { ...process.env, ...profileCfg.env },
    useConpty: IS_WIN,
  });

  const session = {
    pty: ptyProcess, clients: new Set(), profile, cwd,
    createdAt: Date.now(),
    outputBuffer: [],      // ring buffer of output strings
    outputBufferBytes: 0,  // running byte count
    graceTimer: null,      // setTimeout handle for orphan cleanup
  };
  terminalSessions.set(sessionId, session);

  ptyProcess.onData((data) => {
    // Append to ring buffer for replay on reconnect
    session.outputBuffer.push(data);
    session.outputBufferBytes += data.length;
    while (session.outputBufferBytes > TERMINAL_BUFFER_MAX_BYTES && session.outputBuffer.length > 1) {
      session.outputBufferBytes -= session.outputBuffer.shift().length;
    }

    const msg = JSON.stringify({ type: 'output', data });
    session.clients.forEach(ws => {
      if (ws.readyState === 1) ws.send(msg);
    });
  });

  ptyProcess.onExit(({ exitCode }) => {
    // Clear grace timer if set
    if (session.graceTimer) { clearTimeout(session.graceTimer); session.graceTimer = null; }

    const msg = JSON.stringify({ type: 'exit', exitCode });
    session.clients.forEach(ws => {
      if (ws.readyState === 1) ws.send(msg);
    });
    // Clean up temp files from image paste
    if (session.tempFiles) {
      session.tempFiles.forEach(f => { try { unlinkSync(f); } catch {} });
    }
    terminalSessions.delete(sessionId);
  });

  return sessionId;
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
  const { profile = 'shell', cols = 120, rows = 30, cwd } = req.body;
  try {
    const sessionId = createTerminalSession(profile, cols, rows, cwd);
    res.json({ sessionId, profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/terminal/sessions/:id', (req, res) => {
  const session = terminalSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  session.pty.kill();
  // Clean up temp files from image paste
  if (session.tempFiles) {
    session.tempFiles.forEach(f => { try { unlinkSync(f); } catch {} });
  }
  terminalSessions.delete(req.params.id);
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

// --- Start ---
// Migrate connections.json → .env if it still exists (one-time)
migrateConnectionsJsonToEnv();
// Load active connection from .env
reloadConfig();

const httpServer = app.listen(PORT, async () => {
  console.log(`\n  Neural Memory Interface`);
  console.log(`  ──────────────────────`);
  console.log(`  Server:  http://localhost:${PORT}`);
  console.log(`  MCP:     http://localhost:${PORT}/mcp`);
  console.log(`  Qdrant:  ${QDRANT_URL}`);
  console.log(`  Collection: ${COLLECTION}`);
  console.log(`  OpenAI:  ${OPENAI_KEY ? 'configured' : 'MISSING'}`);
  console.log(`  Terminal: WebSocket on ws://localhost:${PORT}/ws/terminal/*\n`);

  // Ensure trashed_at index exists for soft-delete filtering on existing collections
  try {
    await qdrantFetch('/index', {
      method: 'PUT',
      body: JSON.stringify({ field_name: 'trashed_at', field_schema: 'keyword' }),
    });
    console.log('  trashed_at index ensured');
  } catch (err) {
    // Index may already exist or Qdrant not yet reachable — non-fatal
    if (!err.message?.includes('already exists')) {
      console.warn('  trashed_at index warning:', err.message);
    }
  }

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
});

// ═══════════════════════════════════════════
// TERMINAL — WebSocket Server
// ═══════════════════════════════════════════

const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  // Block tunnel traffic from WebSocket upgrades
  if (req.headers['cf-connecting-ip']) {
    socket.destroy();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (!url.pathname.startsWith('/ws/terminal/')) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
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
        const tmpPath = join(os.tmpdir(), `synabun-paste-${sessionId}-${Date.now()}.${ext}`);
        try {
          writeFileSync(tmpPath, Buffer.from(msg.data, 'base64'));
          if (!session.tempFiles) session.tempFiles = [];
          session.tempFiles.push(tmpPath);
          // Send path back to client (client decides whether to insert into PTY)
          ws.send(JSON.stringify({ type: 'image_saved', path: tmpPath }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: `Image paste failed: ${err.message}` }));
        }
      } else if (msg.type === 'memory_drop' && msg.content) {
        // Save memory as .md temp file so CLI can pick it up as a file reference
        const slug = (msg.title || 'memory').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
        const tmpPath = join(os.tmpdir(), `synabun-${slug}-${Date.now()}.md`);
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
