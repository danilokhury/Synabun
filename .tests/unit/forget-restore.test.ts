import { describe, it, expect } from 'vitest';
import { getEmbeddingCalls, getQdrantCalls, getQdrantCallsByMethod, setRetrievePayload } from '../mocks/trackers.js';

const { handleForget } = await import('../../mcp-server/src/tools/forget.js');
const { handleRestore } = await import('../../mcp-server/src/tools/restore.js');

const now = new Date().toISOString();
const trashedPayload = {
  content: 'Memory that was trashed',
  category: 'architecture',
  project: 'test-project',
  tags: [],
  importance: 5,
  source: 'self-discovered',
  created_at: now,
  updated_at: now,
  accessed_at: now,
  access_count: 0,
  trashed_at: now,
};

describe('forget — zero embedding cost', () => {
  it('makes 0 OpenAI embedding calls', async () => {
    await handleForget({ memory_id: 'test-uuid' });
    expect(getEmbeddingCalls()).toHaveLength(0);
  });

  it('makes 1 retrieve + 1 setPayload = 2 Qdrant ops', async () => {
    await handleForget({ memory_id: 'test-uuid' });
    expect(getQdrantCallsByMethod('retrieve')).toHaveLength(1);
    expect(getQdrantCallsByMethod('setPayload')).toHaveLength(1);
    expect(getQdrantCalls()).toHaveLength(2);
  });

  it('skips setPayload if already trashed', async () => {
    setRetrievePayload(trashedPayload);
    const result = await handleForget({ memory_id: 'test-uuid' });
    expect(result.content[0].text).toContain('already in trash');
    // Only retrieve, no setPayload
    expect(getQdrantCallsByMethod('retrieve')).toHaveLength(1);
    expect(getQdrantCallsByMethod('setPayload')).toHaveLength(0);
  });
});

describe('restore — zero embedding cost', () => {
  it('makes 0 OpenAI embedding calls', async () => {
    setRetrievePayload(trashedPayload);
    await handleRestore({ memory_id: 'test-uuid' });
    expect(getEmbeddingCalls()).toHaveLength(0);
  });

  it('makes 1 retrieve + 1 setPayload = 2 Qdrant ops', async () => {
    setRetrievePayload(trashedPayload);
    await handleRestore({ memory_id: 'test-uuid' });
    expect(getQdrantCallsByMethod('retrieve')).toHaveLength(1);
    expect(getQdrantCallsByMethod('setPayload')).toHaveLength(1);
    expect(getQdrantCalls()).toHaveLength(2);
  });

  it('skips setPayload if not trashed (trashed_at is null)', async () => {
    // Default payload has trashed_at: null
    const result = await handleRestore({ memory_id: 'test-uuid' });
    expect(result.content[0].text).toContain('not in trash');
    expect(getQdrantCallsByMethod('retrieve')).toHaveLength(1);
    expect(getQdrantCallsByMethod('setPayload')).toHaveLength(0);
  });
});
