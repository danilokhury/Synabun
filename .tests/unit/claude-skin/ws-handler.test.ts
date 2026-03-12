import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockProc, createSpawnMock } from '../../mocks/child-process.mock';
import { createMockWs } from '../../mocks/ws.mock';

// ── Simulate the handleClaudeSkinWebSocket logic for testing ──
// Since the function is embedded in server.js, we replicate its core logic here.
// This tests the algorithm, not the Express integration.

function createHandler(spawnFn: any, env: Record<string, string> = {}) {
  return function handleClaudeSkinWebSocket(ws: any) {
    let activeProc: any = null;

    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === 'query') {
          if (activeProc) { try { activeProc.kill(); } catch {} activeProc = null; }

          const { prompt, cwd, sessionId, model, allowedTools } = msg;
          if (!prompt) return ws.send(JSON.stringify({ type: 'error', message: 'No prompt provided' }));

          const args = [
            '-p', prompt,
            '--output-format', 'stream-json',
            '--verbose',
            '--include-partial-messages',
          ];
          if (sessionId) args.push('--continue', sessionId);
          if (model) args.push('--model', model);
          if (allowedTools) args.push('--allowedTools', allowedTools);

          const workDir = cwd || '/default/path';
          const filteredEnv = Object.fromEntries(
            Object.entries(env).filter(([k]) =>
              k !== 'CLAUDECODE' &&
              !k.startsWith('VSCODE_') &&
              k !== 'TERM_PROGRAM' &&
              k !== 'TERM_PROGRAM_VERSION'
            )
          );

          const proc = spawnFn('claude', args, {
            cwd: workDir,
            env: filteredEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: process.platform === 'win32',
          });
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
            const text = chunk.toString();
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'stderr', text }));
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

describe('handleClaudeSkinWebSocket', () => {
  let spawnMock: ReturnType<typeof createSpawnMock>;
  let ws: ReturnType<typeof createMockWs>;
  let handler: ReturnType<typeof createHandler>;

  beforeEach(() => {
    spawnMock = createSpawnMock();
    ws = createMockWs();
    handler = createHandler(spawnMock.spawn, {
      PATH: '/usr/bin',
      HOME: '/home/test',
      CLAUDECODE: '1',
      VSCODE_PID: '12345',
      VSCODE_IPC_HOOK: '/tmp/vscode',
      TERM_PROGRAM: 'vscode',
      TERM_PROGRAM_VERSION: '1.0',
      NORMAL_VAR: 'keep',
    });
    handler(ws);
  });

  describe('query message — spawn args', () => {
    it('spawns claude with correct base args', () => {
      ws.simulateMessage({ type: 'query', prompt: 'hello' });
      expect(spawnMock.spawn).toHaveBeenCalledOnce();
      const [cmd, args] = spawnMock.spawn.mock.calls[0];
      expect(cmd).toBe('claude');
      expect(args).toContain('-p');
      expect(args).toContain('hello');
      expect(args).toContain('--output-format');
      expect(args).toContain('stream-json');
      expect(args).toContain('--verbose');
      expect(args).toContain('--include-partial-messages');
    });

    it('does NOT include --strict-mcp-config', () => {
      ws.simulateMessage({ type: 'query', prompt: 'test' });
      const args = spawnMock.spawn.mock.calls[0][1];
      expect(args).not.toContain('--strict-mcp-config');
    });

    it('includes --continue when sessionId provided', () => {
      ws.simulateMessage({ type: 'query', prompt: 'test', sessionId: 'abc-123' });
      const args = spawnMock.spawn.mock.calls[0][1];
      expect(args).toContain('--continue');
      expect(args).toContain('abc-123');
    });

    it('does not include --continue when no sessionId', () => {
      ws.simulateMessage({ type: 'query', prompt: 'test' });
      const args = spawnMock.spawn.mock.calls[0][1];
      expect(args).not.toContain('--continue');
    });

    it('includes --model when model provided', () => {
      ws.simulateMessage({ type: 'query', prompt: 'test', model: 'claude-opus-4-6' });
      const args = spawnMock.spawn.mock.calls[0][1];
      expect(args).toContain('--model');
      expect(args).toContain('claude-opus-4-6');
    });

    it('includes --allowedTools when provided', () => {
      ws.simulateMessage({ type: 'query', prompt: 'test', allowedTools: 'Read,Edit' });
      const args = spawnMock.spawn.mock.calls[0][1];
      expect(args).toContain('--allowedTools');
      expect(args).toContain('Read,Edit');
    });

    it('uses msg.cwd as working directory', () => {
      ws.simulateMessage({ type: 'query', prompt: 'test', cwd: '/my/project' });
      const opts = spawnMock.spawn.mock.calls[0][2];
      expect(opts.cwd).toBe('/my/project');
    });

    it('falls back to default path when no cwd', () => {
      ws.simulateMessage({ type: 'query', prompt: 'test' });
      const opts = spawnMock.spawn.mock.calls[0][2];
      expect(opts.cwd).toBe('/default/path');
    });

    it('returns error when prompt is empty', () => {
      ws.simulateMessage({ type: 'query', prompt: '' });
      expect(spawnMock.spawn).not.toHaveBeenCalled();
      const msgs = ws.getSentMessages();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe('error');
      expect(msgs[0].message).toContain('No prompt');
    });
  });

  describe('environment variable filtering', () => {
    it('strips CLAUDECODE from env', () => {
      ws.simulateMessage({ type: 'query', prompt: 'test' });
      const env = spawnMock.spawn.mock.calls[0][2].env;
      expect(env).not.toHaveProperty('CLAUDECODE');
    });

    it('strips VSCODE_* vars from env', () => {
      ws.simulateMessage({ type: 'query', prompt: 'test' });
      const env = spawnMock.spawn.mock.calls[0][2].env;
      expect(env).not.toHaveProperty('VSCODE_PID');
      expect(env).not.toHaveProperty('VSCODE_IPC_HOOK');
    });

    it('strips TERM_PROGRAM and TERM_PROGRAM_VERSION', () => {
      ws.simulateMessage({ type: 'query', prompt: 'test' });
      const env = spawnMock.spawn.mock.calls[0][2].env;
      expect(env).not.toHaveProperty('TERM_PROGRAM');
      expect(env).not.toHaveProperty('TERM_PROGRAM_VERSION');
    });

    it('preserves normal env vars', () => {
      ws.simulateMessage({ type: 'query', prompt: 'test' });
      const env = spawnMock.spawn.mock.calls[0][2].env;
      expect(env.PATH).toBe('/usr/bin');
      expect(env.HOME).toBe('/home/test');
      expect(env.NORMAL_VAR).toBe('keep');
    });
  });

  describe('NDJSON stdout parsing', () => {
    it('parses complete JSON line and sends as event', () => {
      ws.simulateMessage({ type: 'query', prompt: 'test' });
      const proc = spawnMock.lastProc()!;
      const event = { type: 'system', subtype: 'init', session_id: 'sid-1' };
      proc.emitStdout(JSON.stringify(event) + '\n');
      const msgs = ws.getSentMessages();
      const eventMsgs = msgs.filter(m => m.type === 'event');
      expect(eventMsgs).toHaveLength(1);
      expect(eventMsgs[0].event).toEqual(event);
    });

    it('handles multiple JSON objects in a single chunk', () => {
      ws.simulateMessage({ type: 'query', prompt: 'test' });
      const proc = spawnMock.lastProc()!;
      const e1 = { type: 'system', subtype: 'init' };
      const e2 = { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } };
      proc.emitStdout(JSON.stringify(e1) + '\n' + JSON.stringify(e2) + '\n');
      const eventMsgs = ws.getSentMessages().filter(m => m.type === 'event');
      expect(eventMsgs).toHaveLength(2);
    });

    it('buffers incomplete JSON lines across chunks', () => {
      ws.simulateMessage({ type: 'query', prompt: 'test' });
      const proc = spawnMock.lastProc()!;
      const full = JSON.stringify({ type: 'assistant', message: { content: [] } });
      const mid = Math.floor(full.length / 2);
      proc.emitStdout(full.slice(0, mid)); // incomplete — no newline
      expect(ws.getSentMessages().filter(m => m.type === 'event')).toHaveLength(0);
      proc.emitStdout(full.slice(mid) + '\n');
      expect(ws.getSentMessages().filter(m => m.type === 'event')).toHaveLength(1);
    });

    it('ignores empty lines', () => {
      ws.simulateMessage({ type: 'query', prompt: 'test' });
      const proc = spawnMock.lastProc()!;
      proc.emitStdout('\n\n\n');
      expect(ws.getSentMessages().filter(m => m.type === 'event')).toHaveLength(0);
    });

    it('flushes remaining buffer on process close', () => {
      ws.simulateMessage({ type: 'query', prompt: 'test' });
      const proc = spawnMock.lastProc()!;
      const event = { type: 'result', total_cost_usd: 0.01 };
      proc.emitStdout(JSON.stringify(event)); // no trailing newline
      expect(ws.getSentMessages().filter(m => m.type === 'event')).toHaveLength(0);
      proc.emitClose(0);
      const eventMsgs = ws.getSentMessages().filter(m => m.type === 'event');
      expect(eventMsgs).toHaveLength(1);
      expect(eventMsgs[0].event.total_cost_usd).toBe(0.01);
    });

    it('silently handles invalid JSON lines', () => {
      ws.simulateMessage({ type: 'query', prompt: 'test' });
      const proc = spawnMock.lastProc()!;
      proc.emitStdout('not json at all\n');
      expect(ws.getSentMessages().filter(m => m.type === 'event')).toHaveLength(0);
      // No crash
    });
  });

  describe('stderr forwarding', () => {
    it('forwards stderr as type:stderr message', () => {
      ws.simulateMessage({ type: 'query', prompt: 'test' });
      const proc = spawnMock.lastProc()!;
      proc.emitStderr('Warning: something happened');
      const msgs = ws.getSentMessages().filter(m => m.type === 'stderr');
      expect(msgs).toHaveLength(1);
      expect(msgs[0].text).toContain('Warning');
    });

    it('does not send stderr when WS is not OPEN', () => {
      ws.simulateMessage({ type: 'query', prompt: 'test' });
      ws.readyState = 3; // CLOSED
      const proc = spawnMock.lastProc()!;
      proc.emitStderr('Warning');
      expect(ws.send).not.toHaveBeenCalledWith(expect.stringContaining('stderr'));
    });
  });

  describe('process lifecycle', () => {
    it('sends type:done with exit code on close', () => {
      ws.simulateMessage({ type: 'query', prompt: 'test' });
      const proc = spawnMock.lastProc()!;
      proc.emitClose(0);
      const msgs = ws.getSentMessages().filter(m => m.type === 'done');
      expect(msgs).toHaveLength(1);
      expect(msgs[0].code).toBe(0);
    });

    it('sends type:error when process emits error', () => {
      ws.simulateMessage({ type: 'query', prompt: 'test' });
      const proc = spawnMock.lastProc()!;
      proc.emitError(new Error('ENOENT'));
      const msgs = ws.getSentMessages().filter(m => m.type === 'error');
      expect(msgs).toHaveLength(1);
      expect(msgs[0].message).toBe('ENOENT');
    });

    it('kills previous process when new query arrives', () => {
      ws.simulateMessage({ type: 'query', prompt: 'first' });
      const proc1 = spawnMock.lastProc()!;
      ws.simulateMessage({ type: 'query', prompt: 'second' });
      expect(proc1.kill).toHaveBeenCalled();
      expect(spawnMock.allProcs()).toHaveLength(2);
    });
  });

  describe('abort handling', () => {
    it('kills active process on abort', () => {
      ws.simulateMessage({ type: 'query', prompt: 'test' });
      const proc = spawnMock.lastProc()!;
      ws.simulateMessage({ type: 'abort' });
      expect(proc.kill).toHaveBeenCalled();
    });

    it('sends type:aborted confirmation', () => {
      ws.simulateMessage({ type: 'query', prompt: 'test' });
      ws.simulateMessage({ type: 'abort' });
      const msgs = ws.getSentMessages().filter(m => m.type === 'aborted');
      expect(msgs).toHaveLength(1);
    });

    it('handles abort when no process is active', () => {
      ws.simulateMessage({ type: 'abort' });
      const msgs = ws.getSentMessages().filter(m => m.type === 'aborted');
      expect(msgs).toHaveLength(1);
    });
  });

  describe('WS close cleanup', () => {
    it('kills active process when WS closes', () => {
      ws.simulateMessage({ type: 'query', prompt: 'test' });
      const proc = spawnMock.lastProc()!;
      ws.simulateClose();
      expect(proc.kill).toHaveBeenCalled();
    });

    it('handles WS close with no active process', () => {
      ws.simulateClose();
      // No crash
    });
  });

  describe('malformed input', () => {
    it('ignores non-JSON messages', () => {
      ws.emit('message', Buffer.from('not json'));
      // No crash, no response
    });

    it('ignores messages without a type', () => {
      ws.simulateMessage({ foo: 'bar' });
      expect(spawnMock.spawn).not.toHaveBeenCalled();
    });
  });
});
