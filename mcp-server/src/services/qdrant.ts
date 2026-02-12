import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '../config.js';
import { getAllCategories } from './categories.js';
import type { MemoryPayload, MemoryStats } from '../types.js';

let client: QdrantClient | null = null;

export function getQdrantClient(): QdrantClient {
  if (!client) {
    client = new QdrantClient({
      url: config.qdrant.url,
      apiKey: config.qdrant.apiKey,
    });
  }
  return client;
}

export async function ensureCollection(): Promise<void> {
  const qdrant = getQdrantClient();
  const collectionName = config.qdrant.collection;

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
  const keywordFields = ['category', 'project', 'tags', 'subcategory', 'source', 'created_at'];
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
  await qdrant.upsert(config.qdrant.collection, {
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
  return qdrant.search(config.qdrant.collection, {
    vector,
    limit,
    with_payload: true,
    score_threshold: scoreThreshold ?? 0.3,
    filter: filter as never,
  });
}

export async function deleteMemory(id: string): Promise<void> {
  const qdrant = getQdrantClient();
  await qdrant.delete(config.qdrant.collection, {
    points: [id],
  });
}

export async function getMemory(id: string) {
  const qdrant = getQdrantClient();
  const results = await qdrant.retrieve(config.qdrant.collection, {
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
  await qdrant.setPayload(config.qdrant.collection, {
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
  await qdrant.upsert(config.qdrant.collection, {
    points: [{ id, vector, payload: payload as unknown as Record<string, unknown> }],
  });
}

export async function updatePayloadByFilter(
  filter: Record<string, unknown>,
  payload: Partial<MemoryPayload>
): Promise<void> {
  const qdrant = getQdrantClient();
  await qdrant.setPayload(config.qdrant.collection, {
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
  return qdrant.scroll(config.qdrant.collection, {
    filter: filter as never,
    limit,
    with_payload: true,
    offset: offset ?? undefined,
  });
}

export async function countMemories(filter?: Record<string, unknown>): Promise<number> {
  const qdrant = getQdrantClient();
  const result = await qdrant.count(config.qdrant.collection, {
    filter: filter as never,
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
