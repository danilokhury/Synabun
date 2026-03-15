// JSONL builders for session file testing

export function buildUserMessage(text: string, opts: { sessionId?: string; gitBranch?: string; cwd?: string } = {}) {
  return {
    type: 'user',
    message: { content: text },
    ...(opts.sessionId && { sessionId: opts.sessionId }),
    ...(opts.gitBranch && { gitBranch: opts.gitBranch }),
    ...(opts.cwd && { cwd: opts.cwd }),
  };
}

export function buildUserMessageArray(texts: string[]) {
  return {
    type: 'user',
    message: {
      content: texts.map(t => ({ type: 'text', text: t })),
    },
  };
}

export function buildAssistantMessage(opts: {
  text?: string;
  tools?: Array<{ name: string; id?: string; input?: Record<string, any> }>;
}) {
  const content: any[] = [];
  if (opts.text) content.push({ type: 'text', text: opts.text });
  if (opts.tools) {
    for (const t of opts.tools) {
      content.push({
        type: 'tool_use',
        id: t.id || `toolu_${Math.random().toString(36).slice(2, 10)}`,
        name: t.name,
        input: t.input || {},
      });
    }
  }
  return {
    type: 'assistant',
    message: { content },
  };
}

export function buildToolResult(toolUseId: string, text: string, isError = false) {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: [{ type: 'text', text }],
    is_error: isError,
  };
}

export function buildJsonlLines(messages: object[]): string {
  return messages.map(m => JSON.stringify(m)).join('\n') + '\n';
}
