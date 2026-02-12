import OpenAI from 'openai';
import { config } from '../config.js';

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    if (!config.openai.apiKey) {
      throw new Error(
        'OPENAI_EMBEDDING_API_KEY or OPENAI_API_KEY environment variable is required'
      );
    }
    client = new OpenAI({ apiKey: config.openai.apiKey, baseURL: config.openai.baseUrl });
  }
  return client;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const openai = getClient();

  const response = await openai.embeddings.create({
    model: config.openai.model,
    input: text,
    dimensions: config.openai.dimensions,
  });

  return response.data[0].embedding;
}
