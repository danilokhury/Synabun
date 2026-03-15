import { describe, it, expect } from 'vitest';
import {
  buildUserMessage, buildUserMessageArray, buildAssistantMessage,
  buildToolResult, buildJsonlLines,
} from '../../mocks/fs-session.mock';

// ── Test the JSONL message extraction logic ──
// We replicate the server's parsing algorithm here for unit testing.
// This avoids needing to spin up Express or mock the filesystem.

function parseJsonlMessages(raw: string, limit = 200) {
  const lines = raw.split('\n');
  const messages: any[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'user') {
        const content = obj.message?.content;
        const text = typeof content === 'string' ? content
          : Array.isArray(content) ? content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
          : '';
        if (text) messages.push({ role: 'user', text: text.slice(0, 8000) });
      } else if (obj.type === 'assistant') {
        const content = obj.message?.content;
        const textBlocks = Array.isArray(content)
          ? content.filter((b: any) => b.type === 'text').map((b: any) => b.text)
          : [];
        const toolUseBlocks = Array.isArray(content)
          ? content.filter((b: any) => b.type === 'tool_use').map((b: any) => ({
              id: b.id,
              name: b.name,
              input: b.input,
            }))
          : [];
        const text = textBlocks.join('\n');
        if (text || toolUseBlocks.length) {
          messages.push({
            role: 'assistant',
            text: text.slice(0, 8000) || undefined,
            tools: toolUseBlocks.length ? toolUseBlocks : undefined,
          });
        }
      } else if (obj.type === 'tool_result' || obj.type === 'tool') {
        const content = obj.message?.content || obj.content;
        const toolUseId = obj.tool_use_id || obj.message?.tool_use_id;
        if (toolUseId) {
          let resultText = '';
          if (Array.isArray(content)) resultText = content.map((b: any) => b.text || '').join('\n');
          else if (typeof content === 'string') resultText = content;
          messages.push({
            role: 'tool_result',
            toolUseId,
            text: resultText.slice(0, 4000) || undefined,
            isError: obj.is_error || obj.message?.is_error || false,
          });
        }
      }
    } catch {}
  }

  const sliced = messages.slice(-limit);
  return { messages: sliced, total: messages.length };
}

describe('session messages JSONL parser', () => {
  describe('user messages', () => {
    it('parses user messages with string content', () => {
      const jsonl = buildJsonlLines([buildUserMessage('hello world')]);
      const result = parseJsonlMessages(jsonl);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual({ role: 'user', text: 'hello world' });
    });

    it('parses user messages with array content (text blocks)', () => {
      const jsonl = buildJsonlLines([buildUserMessageArray(['part one', 'part two'])]);
      const result = parseJsonlMessages(jsonl);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].text).toBe('part one\npart two');
    });

    it('truncates text at 8000 chars', () => {
      const longText = 'x'.repeat(10000);
      const jsonl = buildJsonlLines([buildUserMessage(longText)]);
      const result = parseJsonlMessages(jsonl);
      expect(result.messages[0].text).toHaveLength(8000);
    });

    it('skips user messages with empty text', () => {
      const jsonl = buildJsonlLines([buildUserMessage('')]);
      const result = parseJsonlMessages(jsonl);
      expect(result.messages).toHaveLength(0);
    });
  });

  describe('assistant messages', () => {
    it('extracts text from assistant messages', () => {
      const jsonl = buildJsonlLines([
        buildAssistantMessage({ text: 'I will help you' }),
      ]);
      const result = parseJsonlMessages(jsonl);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe('assistant');
      expect(result.messages[0].text).toBe('I will help you');
    });

    it('extracts full tool_use blocks with id, name, input', () => {
      const jsonl = buildJsonlLines([
        buildAssistantMessage({
          text: 'Let me read that file',
          tools: [{ name: 'Read', id: 'toolu_abc', input: { file_path: '/src/index.ts' } }],
        }),
      ]);
      const result = parseJsonlMessages(jsonl);
      expect(result.messages[0].tools).toHaveLength(1);
      expect(result.messages[0].tools[0]).toEqual({
        id: 'toolu_abc',
        name: 'Read',
        input: { file_path: '/src/index.ts' },
      });
    });

    it('handles assistant with only tools (no text)', () => {
      const jsonl = buildJsonlLines([
        buildAssistantMessage({
          tools: [{ name: 'Bash', input: { command: 'ls' } }],
        }),
      ]);
      const result = parseJsonlMessages(jsonl);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].text).toBeUndefined();
      expect(result.messages[0].tools).toHaveLength(1);
    });

    it('skips assistant messages with no text and no tools', () => {
      const jsonl = buildJsonlLines([{ type: 'assistant', message: { content: [] } }]);
      const result = parseJsonlMessages(jsonl);
      expect(result.messages).toHaveLength(0);
    });
  });

  describe('tool results', () => {
    it('extracts tool_result with toolUseId', () => {
      const jsonl = buildJsonlLines([
        buildToolResult('toolu_abc', 'file contents here'),
      ]);
      const result = parseJsonlMessages(jsonl);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual({
        role: 'tool_result',
        toolUseId: 'toolu_abc',
        text: 'file contents here',
        isError: false,
      });
    });

    it('marks error tool results', () => {
      const jsonl = buildJsonlLines([
        buildToolResult('toolu_xyz', 'Permission denied', true),
      ]);
      const result = parseJsonlMessages(jsonl);
      expect(result.messages[0].isError).toBe(true);
    });

    it('truncates tool result text at 4000 chars', () => {
      const longResult = 'y'.repeat(5000);
      const jsonl = buildJsonlLines([buildToolResult('toolu_1', longResult)]);
      const result = parseJsonlMessages(jsonl);
      expect(result.messages[0].text).toHaveLength(4000);
    });
  });

  describe('limit and pagination', () => {
    it('returns last N messages when limit applies', () => {
      const messages = Array.from({ length: 50 }, (_, i) =>
        buildUserMessage(`Message ${i}`)
      );
      const jsonl = buildJsonlLines(messages);
      const result = parseJsonlMessages(jsonl, 10);
      expect(result.messages).toHaveLength(10);
      expect(result.total).toBe(50);
      expect(result.messages[0].text).toBe('Message 40');
      expect(result.messages[9].text).toBe('Message 49');
    });

    it('returns all messages when under limit', () => {
      const messages = [buildUserMessage('one'), buildUserMessage('two')];
      const jsonl = buildJsonlLines(messages);
      const result = parseJsonlMessages(jsonl, 100);
      expect(result.messages).toHaveLength(2);
      expect(result.total).toBe(2);
    });
  });

  describe('mixed message types', () => {
    it('preserves order across user, assistant, and tool_result', () => {
      const toolId = 'toolu_mixed';
      const jsonl = buildJsonlLines([
        buildUserMessage('fix the bug'),
        buildAssistantMessage({
          text: 'Let me look',
          tools: [{ name: 'Read', id: toolId, input: { file_path: 'bug.ts' } }],
        }),
        buildToolResult(toolId, 'function buggy() {}'),
        buildAssistantMessage({ text: 'Found it!' }),
      ]);
      const result = parseJsonlMessages(jsonl);
      expect(result.messages).toHaveLength(4);
      expect(result.messages.map((m: any) => m.role)).toEqual([
        'user', 'assistant', 'tool_result', 'assistant',
      ]);
    });
  });

  describe('error handling', () => {
    it('skips malformed JSON lines', () => {
      const jsonl = '{"type":"user","message":{"content":"ok"}}\nnot json\n{"type":"user","message":{"content":"also ok"}}\n';
      const result = parseJsonlMessages(jsonl);
      expect(result.messages).toHaveLength(2);
    });

    it('handles empty input', () => {
      const result = parseJsonlMessages('');
      expect(result.messages).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('handles JSONL with only empty lines', () => {
      const result = parseJsonlMessages('\n\n\n');
      expect(result.messages).toHaveLength(0);
    });
  });
});
