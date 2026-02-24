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
