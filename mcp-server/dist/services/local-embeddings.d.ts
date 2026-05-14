/**
 * Local embedding generation using Transformers.js (ONNX runtime).
 * Drop-in replacement for embeddings.ts — same exported function signatures.
 * Uses all-MiniLM-L6-v2 (384 dimensions, ~23MB quantized model).
 * No API key, no internet required after first model download.
 */
export declare const EMBEDDING_DIMENSIONS = 384;
/**
 * Generate a single embedding vector for the given text.
 * Returns a 384-dimensional normalized vector (unit length).
 */
export declare function generateEmbedding(text: string): Promise<number[]>;
/**
 * Generate embeddings for multiple texts.
 * Processes sequentially to avoid memory spikes on large batches.
 */
export declare function generateEmbeddingBatch(texts: string[]): Promise<number[][]>;
/**
 * Trigger model download/warmup without generating an actual embedding.
 * Call this at server startup for faster first-use latency.
 */
export declare function warmupEmbeddings(): Promise<void>;
//# sourceMappingURL=local-embeddings.d.ts.map