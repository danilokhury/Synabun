import { describe, it, expect } from 'vitest';

// ── Test the NDJSON line-buffering algorithm ──
// Replicates: buf += chunk; lines = buf.split('\n'); buf = lines.pop();

function createNdjsonParser() {
  let buf = '';
  const parsed: object[] = [];
  const errors: string[] = [];

  return {
    feed(chunk: string) {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop()!;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          parsed.push(JSON.parse(trimmed));
        } catch (e: any) {
          errors.push(e.message);
        }
      }
    },
    flush() {
      if (buf.trim()) {
        try {
          parsed.push(JSON.parse(buf.trim()));
        } catch (e: any) {
          errors.push(e.message);
        }
      }
      buf = '';
    },
    getParsed: () => [...parsed],
    getErrors: () => [...errors],
    getBuffer: () => buf,
    reset() {
      buf = '';
      parsed.length = 0;
      errors.length = 0;
    },
  };
}

describe('NDJSON line buffering', () => {
  let parser: ReturnType<typeof createNdjsonParser>;

  beforeEach(() => {
    parser = createNdjsonParser();
  });

  it('parses single complete line', () => {
    parser.feed('{"type":"test"}\n');
    expect(parser.getParsed()).toEqual([{ type: 'test' }]);
  });

  it('parses multiple complete lines in one chunk', () => {
    parser.feed('{"a":1}\n{"b":2}\n{"c":3}\n');
    expect(parser.getParsed()).toHaveLength(3);
    expect(parser.getParsed()[0]).toEqual({ a: 1 });
    expect(parser.getParsed()[2]).toEqual({ c: 3 });
  });

  it('buffers incomplete line across two chunks', () => {
    parser.feed('{"type":"ass');
    expect(parser.getParsed()).toHaveLength(0);
    expect(parser.getBuffer()).toBe('{"type":"ass');

    parser.feed('istant"}\n');
    expect(parser.getParsed()).toHaveLength(1);
    expect(parser.getParsed()[0]).toEqual({ type: 'assistant' });
  });

  it('handles trailing newline correctly', () => {
    parser.feed('{"x":1}\n');
    expect(parser.getParsed()).toHaveLength(1);
    expect(parser.getBuffer()).toBe('');
  });

  it('handles no trailing newline (buffered)', () => {
    parser.feed('{"x":1}');
    expect(parser.getParsed()).toHaveLength(0);
    expect(parser.getBuffer()).toBe('{"x":1}');
  });

  it('handles empty lines between JSON objects', () => {
    parser.feed('{"a":1}\n\n\n{"b":2}\n');
    expect(parser.getParsed()).toHaveLength(2);
  });

  it('flushes valid JSON from remaining buffer', () => {
    parser.feed('{"final":true}');
    expect(parser.getParsed()).toHaveLength(0);
    parser.flush();
    expect(parser.getParsed()).toHaveLength(1);
    expect(parser.getParsed()[0]).toEqual({ final: true });
  });

  it('discards invalid JSON from remaining buffer silently', () => {
    parser.feed('not json');
    parser.flush();
    expect(parser.getParsed()).toHaveLength(0);
    expect(parser.getErrors()).toHaveLength(1);
  });

  it('handles chunk that is only a newline', () => {
    parser.feed('\n');
    expect(parser.getParsed()).toHaveLength(0);
    expect(parser.getBuffer()).toBe('');
  });

  it('handles very large JSON lines', () => {
    const large = { data: 'x'.repeat(100000) };
    parser.feed(JSON.stringify(large) + '\n');
    expect(parser.getParsed()).toHaveLength(1);
    expect((parser.getParsed()[0] as any).data).toHaveLength(100000);
  });

  it('handles mixed valid and invalid lines', () => {
    parser.feed('{"ok":1}\ngarbage\n{"ok":2}\n');
    expect(parser.getParsed()).toHaveLength(2);
    expect(parser.getErrors()).toHaveLength(1);
  });

  it('handles three-chunk split of single line', () => {
    parser.feed('{"ty');
    parser.feed('pe":"');
    parser.feed('done"}\n');
    expect(parser.getParsed()).toHaveLength(1);
    expect(parser.getParsed()[0]).toEqual({ type: 'done' });
  });
});
