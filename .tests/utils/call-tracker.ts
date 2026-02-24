export interface ToolInvocationStats {
  tool: string;
  callCount: number;
  openaiEmbeddingCalls: number;
  totalEmbeddingTokens: number;
  qdrantCalls: Record<string, number>;
  totalQdrantOps: number;
  estimatedCostUSD: number;
}

export interface SessionStats {
  sessionId: string;
  description: string;
  invocations: ToolInvocationStats[];
  totals: {
    openaiCalls: number;
    embeddingTokens: number;
    qdrantOps: number;
    costUSD: number;
  };
}

export function createToolStats(
  tool: string,
  callCount: number,
  openaiCalls: number,
  tokens: number,
  qdrant: Record<string, number>,
  costUSD: number,
): ToolInvocationStats {
  return {
    tool,
    callCount,
    openaiEmbeddingCalls: openaiCalls,
    totalEmbeddingTokens: tokens,
    qdrantCalls: qdrant,
    totalQdrantOps: Object.values(qdrant).reduce((s, v) => s + v, 0),
    estimatedCostUSD: costUSD,
  };
}

export function aggregateSession(
  sessionId: string,
  description: string,
  invocations: ToolInvocationStats[],
): SessionStats {
  return {
    sessionId,
    description,
    invocations,
    totals: {
      openaiCalls: invocations.reduce((s, i) => s + i.openaiEmbeddingCalls, 0),
      embeddingTokens: invocations.reduce((s, i) => s + i.totalEmbeddingTokens, 0),
      qdrantOps: invocations.reduce((s, i) => s + i.totalQdrantOps, 0),
      costUSD: invocations.reduce((s, i) => s + i.estimatedCostUSD, 0),
    },
  };
}
