import path from 'path';

// --- Static config (snapshot at module-load time, used as fallback) ---

export const config = {
  qdrant: {
    url: process.env.QDRANT_MEMORY_URL || `http://localhost:${process.env.QDRANT_PORT || '6333'}`,
    apiKey: process.env.QDRANT_MEMORY_API_KEY || 'claude-memory-local-key',
    collection: process.env.QDRANT_MEMORY_COLLECTION || 'claude_memory',
  },
  openai: {
    apiKey: process.env.OPENAI_EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || '',
    baseUrl: process.env.EMBEDDING_BASE_URL || 'https://api.openai.com/v1',
    model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
    dimensions: parseInt(process.env.EMBEDDING_DIMENSIONS || '1536', 10),
  },
  dataDir: process.env.MEMORY_DATA_DIR || path.resolve(import.meta.dirname || process.cwd(), '..', 'data'),
} as const;

export interface QdrantConnection {
  url: string;
  apiKey: string;
  collection: string;
  label?: string;
}

export interface EmbeddingConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  dimensions: number;
}

// --- .env path resolution (for file watching) ---

export function getEnvPath(): string {
  return process.env.DOTENV_PATH || path.resolve(import.meta.dirname || process.cwd(), '..', '..', '.env');
}

// --- Active Qdrant Connection (reads from process.env) ---

function getEnvQdrantConnection(connId: string): QdrantConnection | null {
  const port = process.env[`QDRANT__${connId}__PORT`];
  const apiKey = process.env[`QDRANT__${connId}__API_KEY`];
  const collection = process.env[`QDRANT__${connId}__COLLECTION`];
  const url = process.env[`QDRANT__${connId}__URL`];
  const label = process.env[`QDRANT__${connId}__LABEL`];

  if (!apiKey || !collection) return null;

  return {
    url: url || `http://localhost:${port || '6333'}`,
    apiKey,
    collection,
    label,
  };
}

/**
 * Gets the active Qdrant connection from process.env.
 * Reads QDRANT_ACTIVE + QDRANT__<id>__* keys (populated from .env by preload).
 * Falls back to legacy flat keys, then hardcoded defaults.
 */
export function getActiveConnection(): QdrantConnection {
  // 1. Try QDRANT_ACTIVE + namespaced keys
  const activeId = process.env.QDRANT_ACTIVE;
  if (activeId) {
    const conn = getEnvQdrantConnection(activeId);
    if (conn) return conn;
  }

  // 2. Fallback: scan for any QDRANT__*__API_KEY
  for (const key of Object.keys(process.env)) {
    const match = key.match(/^QDRANT__([a-z0-9_]+)__API_KEY$/);
    if (match) {
      const conn = getEnvQdrantConnection(match[1]);
      if (conn) return conn;
    }
  }

  // 3. Final fallback: legacy flat keys / hardcoded defaults
  return { url: config.qdrant.url, apiKey: config.qdrant.apiKey, collection: config.qdrant.collection };
}

/** Convenience: returns just the active collection name */
export function getActiveCollection(): string {
  return getActiveConnection().collection;
}

/** Returns the active connection ID from process.env.QDRANT_ACTIVE */
export function getActiveConnectionId(): string {
  return process.env.QDRANT_ACTIVE || 'default';
}

// --- Active Embedding Config (reads from process.env) ---

/**
 * Gets the active embedding provider config from process.env.
 * Reads EMBEDDING_ACTIVE + EMBEDDING__<id>__* keys first,
 * falls back to legacy flat keys (OPENAI_EMBEDDING_API_KEY etc.).
 */
export function getActiveEmbeddingConfig(): EmbeddingConfig {
  const activeId = process.env.EMBEDDING_ACTIVE;
  if (activeId) {
    const apiKey = process.env[`EMBEDDING__${activeId}__API_KEY`];
    if (apiKey) {
      return {
        apiKey,
        baseUrl: process.env[`EMBEDDING__${activeId}__BASE_URL`] || 'https://api.openai.com/v1',
        model: process.env[`EMBEDDING__${activeId}__MODEL`] || 'text-embedding-3-small',
        dimensions: parseInt(process.env[`EMBEDDING__${activeId}__DIMENSIONS`] || '1536', 10),
      };
    }
  }

  // Backward compat: flat keys
  return {
    apiKey: process.env.OPENAI_EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || '',
    baseUrl: process.env.EMBEDDING_BASE_URL || 'https://api.openai.com/v1',
    model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
    dimensions: parseInt(process.env.EMBEDDING_DIMENSIONS || '1536', 10),
  };
}

// --- Project Detection ---

const PROJECT_MAP: Record<string, string> = {
  criticalpixel: 'criticalpixel',
  ellacred: 'ellacred',
};

export function detectProject(cwd?: string): string {
  const dir = cwd || process.cwd();
  const lower = dir.toLowerCase();

  for (const [key, value] of Object.entries(PROJECT_MAP)) {
    if (lower.includes(key)) return value;
  }

  // Use the directory name as project identifier
  const base = path.basename(dir).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return base || 'global';
}
