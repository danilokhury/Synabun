/**
 * Local embedding generation using Transformers.js (ONNX runtime).
 * Drop-in replacement for embeddings.ts — same exported function signatures.
 * Uses all-MiniLM-L6-v2 (384 dimensions, ~23MB quantized model).
 * No API key, no internet required after first model download.
 */

import type { FeatureExtractionPipeline } from '@huggingface/transformers';

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIMENSIONS = 384;

let extractor: FeatureExtractionPipeline | null = null;
let initPromise: Promise<FeatureExtractionPipeline> | null = null;

/**
 * Lazy-loads the embedding pipeline. First call downloads the model (~23MB)
 * and caches it permanently in ~/.cache/huggingface/. Subsequent calls reuse
 * the cached model with no network access needed.
 */
async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (extractor) return extractor;

  // Prevent concurrent initialization (multiple tools calling at once)
  if (initPromise) return initPromise;

  initPromise = (async () => {
    // Dynamic import to avoid blocking module load
    const { pipeline } = await import('@huggingface/transformers');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extractor = await (pipeline as any)('feature-extraction', MODEL_NAME, {
      dtype: 'fp32',
    }) as FeatureExtractionPipeline;
    return extractor;
  })();

  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

/**
 * Generate a single embedding vector for the given text.
 * Returns a 384-dimensional normalized vector (unit length).
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const ext = await getExtractor();
  const output = await ext(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data as Float32Array);
}

/**
 * Generate embeddings for multiple texts.
 * Processes sequentially to avoid memory spikes on large batches.
 */
export async function generateEmbeddingBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length === 1) return [await generateEmbedding(texts[0])];

  const ext = await getExtractor();
  const results: number[][] = [];
  for (const text of texts) {
    const output = await ext(text, { pooling: 'mean', normalize: true });
    results.push(Array.from(output.data as Float32Array));
  }
  return results;
}

/**
 * Trigger model download/warmup without generating an actual embedding.
 * Call this at server startup for faster first-use latency.
 */
export async function warmupEmbeddings(): Promise<void> {
  await getExtractor();
}
