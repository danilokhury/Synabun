import { describe, it, expect } from 'vitest';

// ── Replicate pure functions from claude-chat.js / ui-claude-panel.js ──

function toolDetail(block: { name: string; input?: Record<string, any> }) {
  const i = block.input || {};
  if (['Read', 'Edit', 'Write'].includes(block.name)) return (i.file_path || i.path || '').split(/[/\\]/).pop() || '';
  if (block.name === 'Bash') return (i.command || '').slice(0, 50);
  if (block.name === 'Glob' || block.name === 'Grep') return i.pattern || '';
  return '';
}

function toolIcon(name: string): string {
  const map: Record<string, string> = {
    Read: 'F', Edit: 'E', Write: 'W', Bash: '$',
    Glob: '*', Grep: '?', Agent: 'A', WebSearch: 'S', WebFetch: 'U',
  };
  return map[name] || '#';
}

describe('toolDetail', () => {
  it('extracts filename from file_path for Read', () => {
    expect(toolDetail({ name: 'Read', input: { file_path: '/src/index.ts' } })).toBe('index.ts');
  });

  it('extracts filename from file_path for Edit', () => {
    expect(toolDetail({ name: 'Edit', input: { file_path: '/a/b/c.js' } })).toBe('c.js');
  });

  it('extracts filename from file_path for Write', () => {
    expect(toolDetail({ name: 'Write', input: { file_path: 'test.txt' } })).toBe('test.txt');
  });

  it('extracts command substring for Bash', () => {
    expect(toolDetail({ name: 'Bash', input: { command: 'npm run test --coverage' } })).toBe('npm run test --coverage');
  });

  it('truncates long Bash commands at 50 chars', () => {
    const long = 'a'.repeat(100);
    expect(toolDetail({ name: 'Bash', input: { command: long } })).toHaveLength(50);
  });

  it('extracts pattern for Glob', () => {
    expect(toolDetail({ name: 'Glob', input: { pattern: '**/*.ts' } })).toBe('**/*.ts');
  });

  it('extracts pattern for Grep', () => {
    expect(toolDetail({ name: 'Grep', input: { pattern: 'handleEvent' } })).toBe('handleEvent');
  });

  it('returns empty string for unknown tool', () => {
    expect(toolDetail({ name: 'SomeCustomTool', input: { data: 'test' } })).toBe('');
  });

  it('returns empty string when input is missing', () => {
    expect(toolDetail({ name: 'Read' })).toBe('');
  });

  it('handles Windows backslash paths', () => {
    expect(toolDetail({ name: 'Read', input: { file_path: 'C:\\Users\\src\\app.ts' } })).toBe('app.ts');
  });

  it('handles Unix forward-slash paths', () => {
    expect(toolDetail({ name: 'Read', input: { file_path: '/home/user/project/file.py' } })).toBe('file.py');
  });

  it('handles path with no directory', () => {
    expect(toolDetail({ name: 'Read', input: { file_path: 'standalone.js' } })).toBe('standalone.js');
  });
});

describe('toolIcon', () => {
  it('returns "F" for Read', () => expect(toolIcon('Read')).toBe('F'));
  it('returns "E" for Edit', () => expect(toolIcon('Edit')).toBe('E'));
  it('returns "W" for Write', () => expect(toolIcon('Write')).toBe('W'));
  it('returns "$" for Bash', () => expect(toolIcon('Bash')).toBe('$'));
  it('returns "*" for Glob', () => expect(toolIcon('Glob')).toBe('*'));
  it('returns "?" for Grep', () => expect(toolIcon('Grep')).toBe('?'));
  it('returns "A" for Agent', () => expect(toolIcon('Agent')).toBe('A'));
  it('returns "S" for WebSearch', () => expect(toolIcon('WebSearch')).toBe('S'));
  it('returns "U" for WebFetch', () => expect(toolIcon('WebFetch')).toBe('U'));
  it('returns "#" for unknown tool', () => expect(toolIcon('CustomTool')).toBe('#'));
  it('returns "#" for empty string', () => expect(toolIcon('')).toBe('#'));
});
