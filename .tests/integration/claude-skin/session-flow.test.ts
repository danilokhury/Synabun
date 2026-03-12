import { describe, it, expect, beforeEach } from 'vitest';
import { createSpawnMock } from '../../mocks/child-process.mock';
import { createMockWs } from '../../mocks/ws.mock';

// Full session lifecycle test using the WS handler logic

function createHandler(spawnFn: any) {
  return function handle(ws: any) {
    let activeProc: any = null;
    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'query') {
          if (activeProc) { try { activeProc.kill(); } catch {} activeProc = null; }
          const { prompt, sessionId, model } = msg;
          if (!prompt) return ws.send(JSON.stringify({ type: 'error', message: 'No prompt' }));
          const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
          if (sessionId) args.push('--continue', sessionId);
          if (model) args.push('--model', model);
          const proc = spawnFn('claude', args, { cwd: '/test', env: {}, stdio: ['ignore', 'pipe', 'pipe'] });
          activeProc = proc;
          let buf = '';
          proc.stdout.on('data', (chunk: Buffer) => {
            buf += chunk.toString();
            const lines = buf.split('\n');
            buf = lines.pop()!;
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              try {
                const event = JSON.parse(trimmed);
                if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'event', event }));
              } catch {}
            }
          });
          proc.stderr.on('data', (chunk: Buffer) => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'stderr', text: chunk.toString() }));
          });
          proc.on('close', (code: number) => {
            if (buf.trim()) {
              try {
                const event = JSON.parse(buf.trim());
                if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'event', event }));
              } catch {}
            }
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'done', code }));
            activeProc = null;
          });
          proc.on('error', (err: Error) => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', message: err.message }));
            activeProc = null;
          });
        }
        if (msg.type === 'abort') {
          if (activeProc) { try { activeProc.kill(); } catch {} activeProc = null; }
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'aborted' }));
        }
      } catch {}
    });
    ws.on('close', () => {
      if (activeProc) { try { activeProc.kill(); } catch {} activeProc = null; }
    });
  };
}

describe('integration: claude skin session flow', () => {
  let mock: ReturnType<typeof createSpawnMock>;
  let ws: ReturnType<typeof createMockWs>;

  beforeEach(() => {
    mock = createSpawnMock();
    ws = createMockWs();
    createHandler(mock.spawn)(ws);
  });

  it('completes full query lifecycle: query -> init -> assistant -> result -> done', () => {
    ws.simulateMessage({ type: 'query', prompt: 'Fix the bug' });
    const proc = mock.lastProc()!;

    // Emit init
    proc.emitStdout(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-1' }) + '\n');
    // Emit assistant message
    proc.emitStdout(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'I found the bug.' }] },
    }) + '\n');
    // Emit result
    proc.emitStdout(JSON.stringify({
      type: 'result',
      total_cost_usd: 0.02,
      session_id: 'session-1',
    }) + '\n');
    // Process exits
    proc.emitClose(0);

    const msgs = ws.getSentMessages();
    const types = msgs.map(m => m.type);
    expect(types).toEqual(['event', 'event', 'event', 'done']);

    // Verify event contents
    expect(msgs[0].event.type).toBe('system');
    expect(msgs[0].event.session_id).toBe('session-1');
    expect(msgs[1].event.type).toBe('assistant');
    expect(msgs[1].event.message.content[0].text).toBe('I found the bug.');
    expect(msgs[2].event.type).toBe('result');
    expect(msgs[2].event.total_cost_usd).toBe(0.02);
    expect(msgs[3].code).toBe(0);
  });

  it('continues session with --continue flag on second query', () => {
    ws.simulateMessage({ type: 'query', prompt: 'first', sessionId: 'sid-existing' });
    const args = mock.spawn.mock.calls[0][1];
    expect(args).toContain('--continue');
    expect(args).toContain('sid-existing');
  });

  it('handles abort mid-stream', () => {
    ws.simulateMessage({ type: 'query', prompt: 'do something long' });
    const proc = mock.lastProc()!;

    // Start streaming
    proc.emitStdout(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-2' }) + '\n');

    // Abort
    ws.simulateMessage({ type: 'abort' });

    expect(proc.kill).toHaveBeenCalled();
    const msgs = ws.getSentMessages();
    expect(msgs.some(m => m.type === 'aborted')).toBe(true);
  });

  it('handles process error and allows new query', () => {
    ws.simulateMessage({ type: 'query', prompt: 'test' });
    const proc1 = mock.lastProc()!;

    proc1.emitError(new Error('ENOENT: claude not found'));

    const errorMsgs = ws.getSentMessages().filter(m => m.type === 'error');
    expect(errorMsgs).toHaveLength(1);
    expect(errorMsgs[0].message).toContain('ENOENT');

    // Can start a new query
    ws.simulateMessage({ type: 'query', prompt: 'retry' });
    expect(mock.allProcs()).toHaveLength(2);
  });

  it('kills previous process when new query arrives mid-stream', () => {
    ws.simulateMessage({ type: 'query', prompt: 'first' });
    const proc1 = mock.lastProc()!;
    proc1.emitStdout(JSON.stringify({ type: 'system', subtype: 'init' }) + '\n');

    // New query before first finishes
    ws.simulateMessage({ type: 'query', prompt: 'second' });
    expect(proc1.kill).toHaveBeenCalled();
    expect(mock.allProcs()).toHaveLength(2);
  });

  it('handles tool_use -> tool_result cycle', () => {
    ws.simulateMessage({ type: 'query', prompt: 'read file' });
    const proc = mock.lastProc()!;

    // Assistant with tool_use
    proc.emitStdout(JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me read that' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/src/app.ts' } },
        ],
      },
    }) + '\n');

    // Tool result
    proc.emitStdout(JSON.stringify({
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: [{ type: 'text', text: 'export default function app() {}' }],
      is_error: false,
    }) + '\n');

    const events = ws.getSentMessages().filter(m => m.type === 'event');
    expect(events).toHaveLength(2);
    expect(events[0].event.type).toBe('assistant');
    expect(events[1].event.type).toBe('tool_result');
    expect(events[1].event.tool_use_id).toBe('toolu_1');
  });
});
