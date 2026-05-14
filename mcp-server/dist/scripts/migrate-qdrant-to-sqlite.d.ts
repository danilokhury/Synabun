#!/usr/bin/env tsx
/**
 * One-time migration script: Qdrant → SQLite
 *
 * Reads all memories and session chunks from a running Qdrant instance,
 * re-embeds them using the local Transformers.js model (384 dims),
 * and inserts them into the SQLite database.
 *
 * Usage:
 *   cd mcp-server
 *   npx tsx src/scripts/migrate-qdrant-to-sqlite.ts
 *
 * Requirements:
 *   - Qdrant must still be running during migration
 *   - .env must contain the QDRANT__* and EMBEDDING__* variables
 *   - First run will download the embedding model (~23MB)
 */
export {};
//# sourceMappingURL=migrate-qdrant-to-sqlite.d.ts.map