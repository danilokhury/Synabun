import OpenAI from 'openai';
import { getActiveEmbeddingConfig } from '../config.js';

let client: OpenAI | null = null;
let lastApiKey = '';

function getClient(): OpenAI {
  const embConfig = getActiveEmbeddingConfig();
  // Recreate client if API key changed (supports runtime provider switching)
  if (!client || embConfig.apiKey !== lastApiKey) {
    if (!embConfig.apiKey) {
      throw new Error(
        'No embedding API key configured. Set EMBEDDING__<id>__API_KEY or OPENAI_EMBEDDING_API_KEY in .env'
      );
    }
    client = new OpenAI({ apiKey: embConfig.apiKey, baseURL: embConfig.baseUrl });
    lastApiKey = embConfig.apiKey;
  }
  return client;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const openai = getClient();
  const embConfig = getActiveEmbeddingConfig();

  const response = await openai.embeddings.create({
    model: embConfig.model,
    input: text,
    dimensions: embConfig.dimensions,
  });

  return response.data[0].embedding;
}

/**
 * Generate embeddings for multiple texts in batched API calls.
 * Batches up to 20 texts per call to stay within rate limits.
 */
export async function generateEmbeddingBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length === 1) return [await generateEmbedding(texts[0])];

  const openai = getClient();
  const embConfig = getActiveEmbeddingConfig();
  const BATCH_SIZE = 20;
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const response = await openai.embeddings.create({
      model: embConfig.model,
      input: batch,
      dimensions: embConfig.dimensions,
    });
    // OpenAI returns embeddings sorted by index
    const sorted = response.data.sort((a, b) => a.index - b.index);
    for (const item of sorted) {
      results.push(item.embedding);
    }
  }

  return results;
}
