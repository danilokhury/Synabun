import { vi } from 'vitest';

export interface QdrantCall {
  method: string;
  collection: string;
  params: unknown;
  timestamp: number;
}

// Shared registry
export const qdrantCalls: QdrantCall[] = [];

export function resetQdrantCalls(): void {
  qdrantCalls.length = 0;
}

function trackCall(method: string, collection: string, params: unknown) {
  qdrantCalls.push({ method, collection, params, timestamp: Date.now() });
}

const now = new Date().toISOString();

function makePayload(index: number = 0) {
  return {
    content: `Test memory content number ${index} with reasonable text length for testing`,
    category: 'architecture',
    project: 'test-project',
    tags: ['test'],
    importance: 5,
    source: 'self-discovered',
    created_at: now,
    updated_at: now,
    accessed_at: now,
    access_count: index,
    related_files: [],
    trashed_at: null,
  };
}

// Configurable scroll behavior for sync pagination tests
let scrollPageConfig: { pagesRemaining: number; pointsPerPage: number } | null = null;

export function configureScrollPages(totalPoints: number, pointsPerPage: number = 100) {
  scrollPageConfig = {
    pagesRemaining: Math.ceil(totalPoints / pointsPerPage),
    pointsPerPage,
  };
}

export function resetScrollConfig() {
  scrollPageConfig = null;
}

export function createMockQdrantClient() {
  return vi.fn().mockImplementation(() => ({
    search: vi.fn(async (collection: string, params: unknown) => {
      trackCall('search', collection, params);
      const limit = (params as Record<string, unknown>).limit as number ?? 5;
      const count = Math.min(limit, 5);
      return Array.from({ length: count }, (_, i) => ({
        id: `uuid-result-${i}`,
        score: 0.95 - i * 0.05,
        payload: makePayload(i),
      }));
    }),

    upsert: vi.fn(async (collection: string, params: unknown) => {
      trackCall('upsert', collection, params);
      return { status: 'ok', result: { operation_id: 1, status: 'completed' } };
    }),

    retrieve: vi.fn(async (collection: string, params: unknown) => {
      trackCall('retrieve', collection, params);
      const ids = ((params as Record<string, unknown>).ids as string[]) ?? ['test-id'];
      return ids.map((id: string) => ({
        id,
        payload: makePayload(0),
      }));
    }),

    setPayload: vi.fn(async (collection: string, params: unknown) => {
      trackCall('setPayload', collection, params);
      return { status: 'ok' };
    }),

    scroll: vi.fn(async (collection: string, params: unknown) => {
      trackCall('scroll', collection, params);
      const limit = (params as Record<string, unknown>).limit as number ?? 20;

      if (scrollPageConfig && scrollPageConfig.pagesRemaining > 0) {
        scrollPageConfig.pagesRemaining--;
        const pointCount = Math.min(limit, scrollPageConfig.pointsPerPage);
        return {
          points: Array.from({ length: pointCount }, (_, i) => ({
            id: `uuid-scroll-${Date.now()}-${i}`,
            payload: makePayload(i),
          })),
          next_page_offset: scrollPageConfig.pagesRemaining > 0
            ? `page-${scrollPageConfig.pagesRemaining}`
            : null,
        };
      }

      return {
        points: Array.from({ length: Math.min(limit, 10) }, (_, i) => ({
          id: `uuid-scroll-${i}`,
          payload: makePayload(i),
        })),
        next_page_offset: null,
      };
    }),

    count: vi.fn(async (collection: string, params: unknown) => {
      trackCall('count', collection, params);
      return { count: 42 };
    }),

    delete: vi.fn(async (collection: string, params: unknown) => {
      trackCall('delete', collection, params);
      return { status: 'ok' };
    }),

    collectionExists: vi.fn(async () => ({ exists: true })),
    createCollection: vi.fn(async () => ({ result: true })),
    createPayloadIndex: vi.fn(async () => ({ result: { operation_id: 1 } })),
  }));
}
