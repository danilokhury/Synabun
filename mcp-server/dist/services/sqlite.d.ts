/**
 * SQLite storage layer.
 * Uses Node.js built-in node:sqlite (available since Node 22.5.0).
 * Vectors stored as Float32Array BLOBs, cosine similarity computed in JS.
 */
import type { MemoryPayload, MemoryStats, SessionChunkPayload } from '../types.js';
export declare const CATEGORIES_POINT_ID = "00000000-0000-0000-0000-000000000000";
export declare function ensureCollection(): Promise<void>;
export declare function ensureSessionCollection(): Promise<void>;
/** Combined init function for cleaner startup */
export declare function ensureDatabase(): Promise<void>;
export declare function upsertMemory(id: string, vector: number[], payload: MemoryPayload): Promise<void>;
export declare function searchMemories(vector: number[], limit: number, filter?: Record<string, unknown>, scoreThreshold?: number): Promise<{
    id: string;
    score: number;
    payload: MemoryPayload;
}[]>;
export declare function getMemory(id: string): Promise<{
    id: string;
    payload: MemoryPayload;
} | null>;
export declare function updatePayload(id: string, payload: Partial<MemoryPayload>): Promise<void>;
export declare function updateVector(id: string, vector: number[], payload: MemoryPayload): Promise<void>;
export declare function updatePayloadByFilter(filter: Record<string, unknown>, payload: Partial<MemoryPayload>): Promise<void>;
export declare function deleteMemory(id: string): Promise<void>;
export declare function softDeleteMemory(id: string): Promise<void>;
export declare function restoreMemory(id: string): Promise<void>;
export declare function scrollMemories(filter?: Record<string, unknown>, limit?: number, offset?: string): Promise<{
    points: {
        id: string;
        payload: MemoryPayload;
    }[];
    next_page_offset: string | null;
}>;
export declare function countMemories(filter?: Record<string, unknown>): Promise<number>;
export declare function getMemoryStats(): Promise<MemoryStats>;
/**
 * Search memories using FTS5 full-text search (keyword fallback).
 * Returns results scored by BM25 relevance. Used when vector similarity
 * scores are low (exact identifiers, error codes, proper nouns).
 */
export declare function searchMemoriesFTS(query: string, limit: number, filter?: Record<string, unknown>, excludeIds?: Set<string>): Promise<Array<{
    id: string;
    score: number;
    payload: MemoryPayload;
}>>;
export declare function searchSessionChunks(vector: number[], limit: number, filter?: Record<string, unknown>, scoreThreshold?: number): Promise<{
    id: string;
    score: number;
    payload: SessionChunkPayload;
}[]>;
export declare function upsertSessionChunks(points: Array<{
    id: string;
    vector: number[];
    payload: SessionChunkPayload;
}>): Promise<void>;
export declare function scrollSessionChunks(filter?: Record<string, unknown>, limit?: number, offset?: string): Promise<{
    points: {
        id: string;
        payload: SessionChunkPayload;
    }[];
    next_page_offset: string | null;
}>;
export declare function countSessionChunks(filter?: Record<string, unknown>): Promise<number>;
interface StoredCategory {
    name: string;
    description: string;
    created_at: string;
    parent?: string;
    color?: string;
    is_parent?: boolean;
}
export declare function getCategories(): Promise<StoredCategory[] | null>;
export declare function saveCategories(categories: StoredCategory[]): Promise<void>;
/**
 * Close the database connection. Call on process exit.
 */
export declare function closeDatabase(): void;
/**
 * Reopen the database at the current SQLITE_DB_PATH.
 * Call after updating process.env.SQLITE_DB_PATH to switch databases.
 */
export declare function reopenDatabase(): Promise<void>;
export {};
//# sourceMappingURL=sqlite.d.ts.map