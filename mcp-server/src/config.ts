import path from 'path';

export const config = {
  qdrant: {
    url: process.env.QDRANT_MEMORY_URL || 'http://localhost:6333',
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
