/**
 * Accessor helpers for the global mock call trackers.
 * These are populated by the vi.mock() factories in setup.ts via globalThis.
 */

export interface EmbeddingCall {
  input: string;
  tokens: number;
  timestamp: number;
}

export interface QdrantCall {
  method: string;
  params: unknown;
  timestamp: number;
}

export function getEmbeddingCalls(): EmbeddingCall[] {
  return (globalThis as Record<string, unknown>).__synabun_embedding_calls as EmbeddingCall[];
}

export function getQdrantCalls(): QdrantCall[] {
  return (globalThis as Record<string, unknown>).__synabun_qdrant_calls as QdrantCall[];
}

export function getQdrantCallsByMethod(method: string): QdrantCall[] {
  return getQdrantCalls().filter(c => c.method === method);
}

export function setScrollConfig(totalPoints: number, pointsPerPage: number = 100) {
  (globalThis as Record<string, unknown>).__synabun_scroll_config = {
    pagesRemaining: Math.ceil(totalPoints / pointsPerPage),
    pointsPerPage,
  };
}

export function resetScrollConfig() {
  (globalThis as Record<string, unknown>).__synabun_scroll_config = null;
}

export function setRetrievePayload(payload: Record<string, unknown>) {
  (globalThis as Record<string, unknown>).__synabun_retrieve_payload = payload;
}

export function resetRetrievePayload() {
  (globalThis as Record<string, unknown>).__synabun_retrieve_payload = null;
}
