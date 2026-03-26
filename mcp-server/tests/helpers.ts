/**
 * Test helpers — factories and utilities for memory tests.
 */
import fs from 'fs';
import { ensureDatabase, upsertMemory, closeDatabase } from '../src/services/sqlite.js';
import { generateEmbedding } from '../src/services/local-embeddings.js';
import type { MemoryPayload } from '../src/types.js';
import { v4 as uuidv4 } from 'uuid';

/** Initialize a fresh test database. Call in beforeEach. */
export async function setupTestDb(): Promise<void> {
  // Close any existing connection first
  closeDatabase();
  // Delete old DB files so each test starts with a clean slate
  const dbPath = process.env.SQLITE_DB_PATH!;
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  await ensureDatabase();
}

/** Close the database. Call in afterEach. */
export function teardownTestDb(): void {
  closeDatabase();
}

/** Default payload for test memories. Override fields as needed. */
export function makePayload(overrides: Partial<MemoryPayload> = {}): MemoryPayload {
  const now = new Date().toISOString();
  return {
    content: 'Test memory content',
    category: 'test-category',
    project: 'test-project',
    tags: ['test'],
    importance: 5,
    source: 'self-discovered',
    created_at: now,
    updated_at: now,
    accessed_at: now,
    access_count: 0,
    ...overrides,
  };
}

/** Insert a memory with auto-generated embedding. Returns the ID. */
export async function insertMemory(
  overrides: Partial<MemoryPayload> = {},
  id?: string
): Promise<string> {
  const memoryId = id || uuidv4();
  const payload = makePayload(overrides);
  const vector = await generateEmbedding(payload.content);
  await upsertMemory(memoryId, vector, payload);
  return memoryId;
}

/** Insert multiple memories with different content for search testing. */
export async function insertMemories(
  items: Array<{ content: string; overrides?: Partial<MemoryPayload> }>
): Promise<string[]> {
  const ids: string[] = [];
  for (const item of items) {
    const id = await insertMemory({ content: item.content, ...item.overrides });
    ids.push(id);
  }
  return ids;
}

/** Extract text from MCP tool response. */
export function extractText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0].text;
}
