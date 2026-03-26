/**
 * Global test setup — runs before all test files.
 * Points SQLite at an in-memory database and stubs heavy services.
 */
import { vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

// --- Temp directory for test data ---
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synabun-test-'));

// --- Environment ---
process.env.SQLITE_DB_PATH = path.join(testDataDir, 'test-memory.db');
process.env.MEMORY_DATA_DIR = testDataDir;

// --- Mock: local-embeddings (expensive, downloads model) ---
vi.mock('../src/services/local-embeddings.js', () => ({
  generateEmbedding: vi.fn(async (text: string) => {
    // Deterministic 384-dim vector derived from text hash
    const hash = Array.from(text).reduce((acc, c) => acc + c.charCodeAt(0), 0);
    const vector = new Array(384).fill(0).map((_, i) => {
      const val = Math.sin(hash * (i + 1) * 0.01);
      return val;
    });
    // Normalize to unit length
    const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
    return vector.map(v => v / norm);
  }),
}));

// --- Mock: neural-interface (HTTP calls to Neural Interface server) ---
vi.mock('../src/services/neural-interface.js', () => ({
  invalidateCache: vi.fn(async () => {}),
}));

// --- Mock: file-checksums (filesystem reads) ---
vi.mock('../src/services/file-checksums.js', () => ({
  computeChecksums: vi.fn((paths: string[]) => {
    const result: Record<string, string> = {};
    for (const p of paths) {
      result[p] = `sha256-mock-${p.replace(/[^a-z0-9]/gi, '-')}`;
    }
    return result;
  }),
  hashFile: vi.fn((filePath: string) => {
    return `sha256-mock-${filePath.replace(/[^a-z0-9]/gi, '-')}`;
  }),
}));

// --- Mock: index.js (refreshCategorySchemas) ---
vi.mock('../src/index.js', () => ({
  refreshCategorySchemas: vi.fn(),
}));

// --- Cleanup after all tests ---
afterAll(() => {
  try {
    fs.rmSync(testDataDir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup
  }
});
