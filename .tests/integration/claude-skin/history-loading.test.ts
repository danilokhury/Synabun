import { describe, it, expect } from 'vitest';
import {
  buildUserMessage, buildAssistantMessage, buildToolResult, buildJsonlLines,
} from '../../mocks/fs-session.mock';

// ── Test JSONL -> parsed messages round-trip ──
// Replicates the server's message extraction logic

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
        const textBlocks = Array.isArray(content) ? content.filter((b: any) => b.type === 'text').map((b: any) => b.text) : [];
        const toolUseBlocks = Array.isArray(content)
          ? content.filter((b: any) => b.type === 'tool_use').map((b: any) => ({ id: b.id, name: b.name, input: b.input }))
          : [];
        const text = textBlocks.join('\n');
        if (text || toolUseBlocks.length) {
          messages.push({ role: 'assistant', text: text.slice(0, 8000) || undefined, tools: toolUseBlocks.length ? toolUseBlocks : undefined });
        }
      } else if (obj.type === 'tool_result' || obj.type === 'tool') {
        const content = obj.message?.content || obj.content;
        const toolUseId = obj.tool_use_id || obj.message?.tool_use_id;
        if (toolUseId) {
          let resultText = '';
          if (Array.isArray(content)) resultText = content.map((b: any) => b.text || '').join('\n');
          else if (typeof content === 'string') resultText = content;
          messages.push({ role: 'tool_result', toolUseId, text: resultText.slice(0, 4000) || undefined, isError: obj.is_error || false });
        }
      }
    } catch {}
  }
  return { messages: messages.slice(-limit), total: messages.length };
}

describe('integration: session history loading', () => {
  it('round-trips a complete conversation with tools', () => {
    const toolId = 'toolu_read1';
    const jsonl = buildJsonlLines([
      buildUserMessage('What does app.ts do?'),
      buildAssistantMessage({
        text: 'Let me read the file.',
        tools: [{ name: 'Read', id: toolId, input: { file_path: '/src/app.ts' } }],
      }),
      buildToolResult(toolId, 'export function main() { return "hello"; }'),
      buildAssistantMessage({ text: 'This file exports a main function that returns "hello".' }),
    ]);

    const result = parseJsonlMessages(jsonl);
    expect(result.total).toBe(4);
    expect(result.messages).toHaveLength(4);

    // User message
    expect(result.messages[0]).toEqual({ role: 'user', text: 'What does app.ts do?' });

    // Assistant with tool
    expect(result.messages[1].role).toBe('assistant');
    expect(result.messages[1].text).toBe('Let me read the file.');
    expect(result.messages[1].tools).toHaveLength(1);
    expect(result.messages[1].tools[0].name).toBe('Read');
    expect(result.messages[1].tools[0].id).toBe(toolId);
    expect(result.messages[1].tools[0].input.file_path).toBe('/src/app.ts');

    // Tool result
    expect(result.messages[2].role).toBe('tool_result');
    expect(result.messages[2].toolUseId).toBe(toolId);
    expect(result.messages[2].text).toContain('main()');
    expect(result.messages[2].isError).toBe(false);

    // Final assistant
    expect(result.messages[3].role).toBe('assistant');
    expect(result.messages[3].text).toContain('main function');
  });

  it('handles large session with 300+ messages', () => {
    const messages: object[] = [];
    for (let i = 0; i < 150; i++) {
      messages.push(buildUserMessage(`Question ${i}`));
      messages.push(buildAssistantMessage({ text: `Answer ${i}` }));
    }
    const jsonl = buildJsonlLines(messages);

    // With limit 50
    const result = parseJsonlMessages(jsonl, 50);
    expect(result.total).toBe(300);
    expect(result.messages).toHaveLength(50);
    // Should be the LAST 50 messages (alternating Q/A pairs, index 250-299)
    expect(result.messages[0].text).toBe('Question 125');
    expect(result.messages[49].text).toBe('Answer 149');
  });

  it('handles session with multiple tool uses in one assistant turn', () => {
    const jsonl = buildJsonlLines([
      buildUserMessage('Fix both files'),
      buildAssistantMessage({
        text: 'I will edit both files.',
        tools: [
          { name: 'Edit', id: 'toolu_e1', input: { file_path: 'a.ts', old_string: 'x', new_string: 'y' } },
          { name: 'Edit', id: 'toolu_e2', input: { file_path: 'b.ts', old_string: 'p', new_string: 'q' } },
        ],
      }),
      buildToolResult('toolu_e1', 'File updated'),
      buildToolResult('toolu_e2', 'File updated'),
      buildAssistantMessage({ text: 'Both files fixed.' }),
    ]);

    const result = parseJsonlMessages(jsonl);
    expect(result.total).toBe(5);
    expect(result.messages[1].tools).toHaveLength(2);
    expect(result.messages[2].toolUseId).toBe('toolu_e1');
    expect(result.messages[3].toolUseId).toBe('toolu_e2');
  });

  it('handles error tool results', () => {
    const jsonl = buildJsonlLines([
      buildUserMessage('delete everything'),
      buildAssistantMessage({
        tools: [{ name: 'Bash', id: 'toolu_b1', input: { command: 'rm -rf /' } }],
      }),
      buildToolResult('toolu_b1', 'Permission denied', true),
    ]);

    const result = parseJsonlMessages(jsonl);
    expect(result.messages[2].isError).toBe(true);
    expect(result.messages[2].text).toBe('Permission denied');
  });

  it('returns empty for missing/empty session', () => {
    const result = parseJsonlMessages('');
    expect(result.messages).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('skips corrupted lines without crashing', () => {
    const jsonl = buildJsonlLines([
      buildUserMessage('valid start'),
    ]) + 'corrupted{{{line\n' + buildJsonlLines([
      buildAssistantMessage({ text: 'valid end' }),
    ]);

    const result = parseJsonlMessages(jsonl);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[1].role).toBe('assistant');
  });
});
