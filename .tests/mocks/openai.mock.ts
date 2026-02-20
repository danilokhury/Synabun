import { vi } from 'vitest';

export interface EmbeddingCall {
  input: string;
  model: string;
  dimensions: number;
  estimatedTokens: number;
  timestamp: number;
}

// Shared registry — accumulated across a test's lifetime
export const embeddingCalls: EmbeddingCall[] = [];

export function resetEmbeddingCalls(): void {
  embeddingCalls.length = 0;
}

function fakeVector(dims: number = 1536): number[] {
  return new Array(dims).fill(0.01);
}

export const mockEmbeddingsCreate = vi.fn(async (params: {
  model: string;
  input: string;
  dimensions: number;
}) => {
  const tokenEstimate = Math.ceil(params.input.length / 4);
  embeddingCalls.push({
    input: params.input,
    model: params.model,
    dimensions: params.dimensions,
    estimatedTokens: tokenEstimate,
    timestamp: Date.now(),
  });
  return {
    data: [{ embedding: fakeVector(params.dimensions) }],
    usage: { prompt_tokens: tokenEstimate, total_tokens: tokenEstimate },
  };
});

// Factory that creates the mock OpenAI class
export function createMockOpenAI() {
  return vi.fn().mockImplementation(() => ({
    embeddings: {
      create: mockEmbeddingsCreate,
    },
  }));
}
