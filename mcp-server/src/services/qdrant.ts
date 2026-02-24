import { QdrantClient } from '@qdrant/js-client-rest';
import { config, getActiveConnection, getActiveCollection } from '../config.js';
import { getAllCategories } from './categories.js';
import type { MemoryPayload, MemoryStats } from '../types.js';

let client: QdrantClient | null = null;
let currentUrl: string = '';
let currentApiKey: string = '';

// Well-known UUID for the system metadata point (categories, etc.)
export const CATEGORIES_POINT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Returns a QdrantClient for the currently active connection.
 * Recreates the client if the URL or API key has changed (i.e., user switched instances).
 */
export function getQdrantClient(): QdrantClient {
  const conn = getActiveConnection();
  if (!client || conn.url !== currentUrl || conn.apiKey !== currentApiKey) {
    client = new QdrantClient({
      url: conn.url,
      apiKey: conn.apiKey,
    });
    currentUrl = conn.url;
    currentApiKey = conn.apiKey;
  }
  return client;
}

/**
 * Merges filters to exclude system metadata and trashed memories from query results.
 * Applied to scroll, count, and search operations.
 * Uses is_empty (matches missing, null, and empty) since existing memories lack the trashed_at field.
 */
function excludeSystemMetadata(filter?: Record<string, unknown>): Record<string, unknown> {
  const systemExclusion = { key: '_type', match: { value: 'system_metadata' } };
  const notTrashed = { is_empty: { key: 'trashed_at' } };
  if (!filter) {
    return { must_not: [systemExclusion], must: [notTrashed] };
  }
  const mustNot = (filter.must_not as unknown[] || []).slice();
  mustNot.push(systemExclusion);
  const must = (filter.must as unknown[] || []).slice();
  must.push(notTrashed);
  return { ...filter, must_not: mustNot, must };
}

export async function ensureCollection(): Promise<void> {
  const qdrant = getQdrantClient();
  const collectionName = getActiveCollection();

  try {
    const exists = await qdrant.collectionExists(collectionName);
    if (exists.exists) return;
  } catch {
    // Collection doesn't exist, create it
  }

  await qdrant.createCollection(collectionName, {
    vectors: {
      size: config.openai.dimensions,
      distance: 'Cosine',
    },
    optimizers_config: {
      indexing_threshold: 100,
    },
  });

  // Create payload indexes for efficient filtering
  const keywordFields = ['category', 'project', 'tags', 'subcategory', 'source', 'created_at', '_type', 'trashed_at'];
  const integerFields = ['importance', 'access_count'];
  const textFields = ['content'];

  for (const field of keywordFields) {
    await qdrant.createPayloadIndex(collectionName, {
      field_name: field,
      field_schema: 'keyword',
    });
  }

  for (const field of integerFields) {
    await qdrant.createPayloadIndex(collectionName, {
      field_name: field,
      field_schema: 'integer',
    });
  }

  for (const field of textFields) {
    await qdrant.createPayloadIndex(collectionName, {
      field_name: field,
      field_schema: 'text',
    });
  }
}

export async function upsertMemory(
  id: string,
  vector: number[],
  payload: MemoryPayload
): Promise<void> {
  const qdrant = getQdrantClient();
  await qdrant.upsert(getActiveCollection(), {
    points: [{ id, vector, payload: payload as unknown as Record<string, unknown> }],
  });
}

export async function searchMemories(
  vector: number[],
  limit: number,
  filter?: Record<string, unknown>,
  scoreThreshold?: number
) {
  const qdrant = getQdrantClient();
  return qdrant.search(getActiveCollection(), {
    vector,
    limit,
    with_payload: true,
    score_threshold: scoreThreshold ?? 0.3,
    filter: excludeSystemMetadata(filter) as never,
  });
}

export async function deleteMemory(id: string): Promise<void> {
  const qdrant = getQdrantClient();
  await qdrant.delete(getActiveCollection(), {
    points: [id],
  });
}

export async function softDeleteMemory(id: string): Promise<void> {
  await updatePayload(id, { trashed_at: new Date().toISOString() } as Partial<MemoryPayload>);
}

export async function restoreMemory(id: string): Promise<void> {
  const qdrant = getQdrantClient();
  await qdrant.setPayload(getActiveCollection(), {
    points: [id],
    payload: { trashed_at: null },
  });
}

export async function getMemory(id: string) {
  const qdrant = getQdrantClient();
  const results = await qdrant.retrieve(getActiveCollection(), {
    ids: [id],
    with_payload: true,
    with_vector: false,
  });
  return results[0] ?? null;
}

export async function updatePayload(
  id: string,
  payload: Partial<MemoryPayload>
): Promise<void> {
  const qdrant = getQdrantClient();
  await qdrant.setPayload(getActiveCollection(), {
    points: [id],
    payload,
  });
}

export async function updateVector(
  id: string,
  vector: number[],
  payload: MemoryPayload
): Promise<void> {
  const qdrant = getQdrantClient();
  await qdrant.upsert(getActiveCollection(), {
    points: [{ id, vector, payload: payload as unknown as Record<string, unknown> }],
  });
}

export async function updatePayloadByFilter(
  filter: Record<string, unknown>,
  payload: Partial<MemoryPayload>
): Promise<void> {
  const qdrant = getQdrantClient();
  await qdrant.setPayload(getActiveCollection(), {
    filter: filter as never,
    payload,
  });
}

export async function scrollMemories(
  filter?: Record<string, unknown>,
  limit: number = 20,
  offset?: string
) {
  const qdrant = getQdrantClient();
  return qdrant.scroll(getActiveCollection(), {
    filter: excludeSystemMetadata(filter) as never,
    limit,
    with_payload: true,
    offset: offset ?? undefined,
  });
}

export async function countMemories(filter?: Record<string, unknown>): Promise<number> {
  const qdrant = getQdrantClient();
  const result = await qdrant.count(getActiveCollection(), {
    filter: excludeSystemMetadata(filter) as never,
    exact: true,
  });
  return result.count;
}

export async function getMemoryStats(): Promise<MemoryStats> {
  const total = await countMemories();

  const categories = getAllCategories();
  const by_category: Record<string, number> = {};
  for (const cat of categories) {
    by_category[cat] = await countMemories({
      must: [{ key: 'category', match: { value: cat } }],
    });
  }

  // Get unique projects by scrolling
  const by_project: Record<string, number> = {};
  const allPoints = await scrollMemories(undefined, 1000);
  let oldest: string | undefined;
  let newest: string | undefined;

  for (const point of allPoints.points) {
    const payload = point.payload as unknown as MemoryPayload;
    const proj = payload.project || 'global';
    by_project[proj] = (by_project[proj] || 0) + 1;

    if (!oldest || payload.created_at < oldest) oldest = payload.created_at;
    if (!newest || payload.created_at > newest) newest = payload.created_at;
  }

  return { total, by_category, by_project, oldest, newest };
}

// --- System metadata (categories stored in Qdrant) ---

interface StoredCategory {
  name: string;
  description: string;
  created_at: string;
  parent?: string;
  color?: string;
  is_parent?: boolean;
}

export async function getCategoriesFromQdrant(): Promise<StoredCategory[] | null> {
  try {
    const qdrant = getQdrantClient();
    const results = await qdrant.retrieve(getActiveCollection(), {
      ids: [CATEGORIES_POINT_ID],
      with_payload: true,
      with_vector: false,
    });
    if (results.length > 0) {
      const payload = results[0].payload as Record<string, unknown>;
      if (payload?._type === 'system_metadata' && Array.isArray(payload.categories)) {
        return payload.categories as StoredCategory[];
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveCategoriesToQdrant(categories: StoredCategory[]): Promise<void> {
  const qdrant = getQdrantClient();
  const zeroVector = new Array(config.openai.dimensions).fill(0);
  await qdrant.upsert(getActiveCollection(), {
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
  });
}
