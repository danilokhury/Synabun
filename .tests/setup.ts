import { vi, beforeEach } from 'vitest';

// --- Environment variables (must be set before any source module imports) ---
process.env.OPENAI_EMBEDDING_API_KEY = 'test-key-not-real';
process.env.QDRANT_MEMORY_URL = 'http://localhost:6333';
process.env.QDRANT_MEMORY_API_KEY = 'test-qdrant-key';
process.env.QDRANT_MEMORY_COLLECTION = 'test_collection';
process.env.MEMORY_DATA_DIR = '/tmp/synabun-test-data';

// ============================================================================
// Service-level mocks (intercept at qdrant.js / embeddings.js layer)
// This is critical — the real QdrantClient creates a singleton that bypasses
// per-file package mocks. Mocking at the service level ensures all tool files
// get the mock regardless of import order.
// ============================================================================

// --- Shared call trackers (imported by test files via mock modules) ---
// These are populated by the vi.mock factories below.

const _embeddingCalls: Array<{ input: string; tokens: number; timestamp: number }> = [];
const _qdrantCalls: Array<{ method: string; params: unknown; timestamp: number }> = [];

// Expose for test files to import
(globalThis as Record<string, unknown>).__synabun_embedding_calls = _embeddingCalls;
(globalThis as Record<string, unknown>).__synabun_qdrant_calls = _qdrantCalls;

// --- Scroll pagination config (configurable per test) ---
(globalThis as Record<string, unknown>).__synabun_scroll_config = null as {
  pagesRemaining: number;
  pointsPerPage: number;
} | null;

// --- Retrieve payload config (configurable per test for forget/restore) ---
const defaultPayload = () => ({
  content: 'Test memory content for mock',
  category: 'architecture',
  project: 'test-project',
  tags: ['test'],
  importance: 5,
  source: 'self-discovered',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  accessed_at: new Date().toISOString(),
  access_count: 2,
  related_files: [],
  file_checksums: {},
  trashed_at: null,
});

(globalThis as Record<string, unknown>).__synabun_retrieve_payload = null;

// --- Mock: embeddings service ---
vi.mock('../mcp-server/src/services/embeddings.js', () => ({
  generateEmbedding: vi.fn(async (text: string) => {
    const calls = (globalThis as Record<string, unknown>).__synabun_embedding_calls as typeof _embeddingCalls;
    calls.push({
      input: text,
      tokens: Math.ceil(text.length / 4),
      timestamp: Date.now(),
    });
    return new Array(1536).fill(0.01);
  }),
}));

// --- Mock: qdrant service ---
vi.mock('../mcp-server/src/services/qdrant.js', () => {
  const now = new Date().toISOString();

  function trackCall(method: string, params: unknown) {
    const calls = (globalThis as Record<string, unknown>).__synabun_qdrant_calls as typeof _qdrantCalls;
    calls.push({ method, params, timestamp: Date.now() });
  }

  function getRetrievePayload() {
    return (globalThis as Record<string, unknown>).__synabun_retrieve_payload || defaultPayload();
  }

  function makeSearchResult(i: number) {
    return {
      id: `uuid-result-${i}`,
      score: 0.95 - i * 0.05,
      payload: {
        content: `Search result ${i} content`,
        category: 'architecture',
        project: 'test-project',
        tags: ['test'],
        importance: 5,
        source: 'self-discovered',
        created_at: now,
        updated_at: now,
        accessed_at: now,
        access_count: i,
      },
    };
  }

  return {
    CATEGORIES_POINT_ID: '00000000-0000-0000-0000-000000000000',

    ensureCollection: vi.fn().mockResolvedValue(undefined),

    getQdrantClient: vi.fn(),

    upsertMemory: vi.fn(async (_id: string, _vector: number[], _payload: unknown) => {
      trackCall('upsert', { id: _id });
    }),

    searchMemories: vi.fn(async (_vector: number[], limit: number, _filter?: unknown, _score?: number) => {
      trackCall('search', { limit });
      const count = Math.min(limit, 6);
      return Array.from({ length: count }, (_, i) => makeSearchResult(i));
    }),

    getMemory: vi.fn(async (id: string) => {
      trackCall('retrieve', { id });
      return { id, payload: getRetrievePayload() };
    }),

    updatePayload: vi.fn(async (id: string, payload: unknown) => {
      trackCall('setPayload', { id, payload });
    }),

    updateVector: vi.fn(async (id: string, _vector: number[], _payload: unknown) => {
      trackCall('upsert', { id });
    }),

    deleteMemory: vi.fn(async (id: string) => {
      trackCall('delete', { id });
    }),

    softDeleteMemory: vi.fn(async (id: string) => {
      trackCall('setPayload', { id, action: 'softDelete' });
    }),

    restoreMemory: vi.fn(async (id: string) => {
      trackCall('setPayload', { id, action: 'restore' });
    }),

    updatePayloadByFilter: vi.fn(async (_filter: unknown, _payload: unknown) => {
      trackCall('setPayloadByFilter', { filter: _filter, payload: _payload });
    }),

    scrollMemories: vi.fn(async (_filter?: unknown, limit: number = 20, _offset?: string) => {
      trackCall('scroll', { limit, offset: _offset });

      const scrollConfig = (globalThis as Record<string, unknown>).__synabun_scroll_config as {
        pagesRemaining: number;
        pointsPerPage: number;
      } | null;

      if (scrollConfig && scrollConfig.pagesRemaining > 0) {
        scrollConfig.pagesRemaining--;
        const pointCount = Math.min(limit, scrollConfig.pointsPerPage);
        return {
          points: Array.from({ length: pointCount }, (_, i) => ({
            id: `uuid-scroll-${Date.now()}-${i}`,
            payload: {
              content: `Scroll memory ${i}`,
              category: 'architecture',
              project: 'test-project',
              tags: [],
              importance: 5,
              source: 'self-discovered',
              created_at: now,
              updated_at: now,
              accessed_at: now,
              access_count: 0,
              related_files: i % 3 === 0 ? ['src/index.ts'] : [],
              file_checksums: i % 3 === 0 ? { 'src/index.ts': 'oldhash' } : {},
            },
          })),
          next_page_offset: scrollConfig.pagesRemaining > 0
            ? `page-${scrollConfig.pagesRemaining}`
            : null,
        };
      }

      return {
        points: Array.from({ length: Math.min(limit, 10) }, (_, i) => ({
          id: `uuid-scroll-${i}`,
          payload: {
            content: `Scroll memory ${i}`,
            category: 'architecture',
            project: 'test-project',
            tags: [],
            importance: 5,
            source: 'self-discovered',
            created_at: now,
            updated_at: now,
            accessed_at: now,
            access_count: 0,
            related_files: [],
            file_checksums: {},
          },
        })),
        next_page_offset: null,
      };
    }),

    countMemories: vi.fn(async (_filter?: unknown) => {
      trackCall('count', { filter: _filter });
      return 42;
    }),

    getMemoryStats: vi.fn(async () => {
      trackCall('count', { type: 'total' });
      // Simulate N category counts
      const cats = ['architecture', 'bug-fixes', 'learning', 'conversations', 'criticalpixel', 'synabun'];
      for (const cat of cats) {
        trackCall('count', { type: 'category', category: cat });
      }
      trackCall('scroll', { type: 'projectBreakdown', limit: 1000 });
      return {
        total: 42,
        by_category: { architecture: 15, 'bug-fixes': 10, learning: 8, conversations: 5, criticalpixel: 2, synabun: 2 },
        by_project: { 'test-project': 30, global: 12 },
        oldest: '2025-01-01T00:00:00.000Z',
        newest: now,
      };
    }),

    getCategoriesFromQdrant: vi.fn(async () => null),
    saveCategoriesToQdrant: vi.fn(async () => {}),
  };
});

// --- Mock: categories service (avoids fs reads and Qdrant calls) ---
vi.mock('../mcp-server/src/services/categories.js', () => {
  const MOCK_CATEGORIES = [
    { name: 'architecture', description: 'System architecture', parent: 'synabun', color: '#3b82f6' },
    { name: 'bug-fixes', description: 'Bug fixes', parent: 'criticalpixel', color: '#ef4444' },
    { name: 'learning', description: 'Learning notes', color: '#22c55e' },
    { name: 'conversations', description: 'Session logs', is_parent: true, color: '#8b5cf6' },
    { name: 'criticalpixel', description: 'CriticalPixel project', is_parent: true, color: '#f97316' },
    { name: 'synabun', description: 'SynaBun project', is_parent: true, color: '#06b6d4' },
  ];
  const NAMES = MOCK_CATEGORIES.map(c => c.name);

  return {
    getAllCategories: () => NAMES,
    getCategories: () => MOCK_CATEGORIES,
    validateCategory: (name: string) => ({
      valid: NAMES.includes(name),
      error: NAMES.includes(name) ? undefined : `Unknown category "${name}". Valid: ${NAMES.join(', ')}`,
    }),
    validateCategoryName: () => ({ valid: true }),
    categoryExists: (name: string) => NAMES.includes(name),
    buildCategoryDescription: () => 'Mock category description for testing',
    addCategory: vi.fn(),
    removeCategory: vi.fn(),
    updateCategory: vi.fn(),
    initCategoryCache: vi.fn().mockResolvedValue(undefined),
    startWatchingCategories: vi.fn(),
    stopWatchingCategories: vi.fn(),
    invalidateCategoryCache: vi.fn(),
    setOnExternalChange: vi.fn(),
    getChildCategories: vi.fn().mockReturnValue([]),
    getCategoryTree: vi.fn().mockReturnValue({}),
    getParentCategories: vi.fn().mockReturnValue([]),
    getCategoryWithMeta: vi.fn().mockReturnValue(null),
    switchCategoryConnection: vi.fn().mockResolvedValue(undefined),
    assignColor: vi.fn().mockReturnValue('#3b82f6'),
    updateCategoryColor: vi.fn(),
    getCategoryDescription: vi.fn().mockReturnValue('Mock description'),
    getCustomCategories: () => MOCK_CATEGORIES,
  };
});

// --- Mock: file-checksums (avoids real fs reads) ---
vi.mock('../mcp-server/src/services/file-checksums.js', () => ({
  computeChecksums: vi.fn().mockReturnValue({ 'src/index.ts': 'abc123hash' }),
  hashFile: vi.fn().mockReturnValue('abc123hash'),
}));

// --- Mock: config (avoid import.meta.dirname issues in test runner) ---
vi.mock('../mcp-server/src/config.js', () => ({
  config: {
    qdrant: {
      url: 'http://localhost:6333',
      apiKey: 'test-qdrant-key',
      collection: 'test_collection',
    },
    openai: {
      apiKey: 'test-key-not-real',
      baseUrl: 'https://api.openai.com/v1',
      model: 'text-embedding-3-small',
      dimensions: 1536,
    },
    dataDir: '/tmp/synabun-test-data',
  },
  getActiveConnection: () => ({
    url: 'http://localhost:6333',
    apiKey: 'test-qdrant-key',
    collection: 'test_collection',
  }),
  getActiveCollection: () => 'test_collection',
  getActiveConnectionId: () => 'test',
  getActiveEmbeddingConfig: () => ({
    apiKey: 'test-key-not-real',
    baseUrl: 'https://api.openai.com/v1',
    model: 'text-embedding-3-small',
    dimensions: 1536,
  }),
  detectProject: () => 'test-project',
  getEnvPath: () => '/tmp/.env',
}));

// --- Reset trackers between tests ---
beforeEach(() => {
  vi.clearAllMocks();
  _embeddingCalls.length = 0;
  _qdrantCalls.length = 0;
  (globalThis as Record<string, unknown>).__synabun_scroll_config = null;
  (globalThis as Record<string, unknown>).__synabun_retrieve_payload = null;
});
