export interface ToolInvocationStats {
  tool: string;
  callCount: number;
  embeddingCalls: number;
  totalEmbeddingTokens: number;
  dbCalls: Record<string, number>;
  totalDbOps: number;
  estimatedCostUSD: number;
}

export interface SessionStats {
  sessionId: string;
  description: string;
  invocations: ToolInvocationStats[];
  totals: {
    embeddingCallCount: number;
    embeddingTokens: number;
    dbOps: number;
    costUSD: number;
  };
}

export function createToolStats(
  tool: string,
  callCount: number,
  embeddingCallCount: number,
  tokens: number,
  db: Record<string, number>,
  costUSD: number,
): ToolInvocationStats {
  return {
    tool,
    callCount,
    embeddingCalls: embeddingCallCount,
    totalEmbeddingTokens: tokens,
    dbCalls: db,
    totalDbOps: Object.values(db).reduce((s, v) => s + v, 0),
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
      embeddingCallCount: invocations.reduce((s, i) => s + i.embeddingCalls, 0),
      embeddingTokens: invocations.reduce((s, i) => s + i.totalEmbeddingTokens, 0),
      dbOps: invocations.reduce((s, i) => s + i.totalDbOps, 0),
      costUSD: invocations.reduce((s, i) => s + i.estimatedCostUSD, 0),
    },
  };
}
