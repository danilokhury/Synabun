// Mock for child_process.spawn — controllable process for claude-skin WS handler tests

import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { vi } from 'vitest';

export interface MockProc extends EventEmitter {
  stdout: Readable & EventEmitter;
  stderr: Readable & EventEmitter;
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  pid: number;
  kill: ReturnType<typeof vi.fn>;
  emitStdout(text: string): void;
  emitStderr(text: string): void;
  emitClose(code: number): void;
  emitError(err: Error): void;
}

let _procCounter = 0;

export function createMockProc(pid?: number): MockProc {
  const proc = new EventEmitter() as MockProc;
  proc.stdout = new EventEmitter() as any;
  proc.stderr = new EventEmitter() as any;
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.pid = pid ?? ++_procCounter;
  proc.kill = vi.fn();

  proc.emitStdout = (text: string) => proc.stdout.emit('data', Buffer.from(text));
  proc.emitStderr = (text: string) => proc.stderr.emit('data', Buffer.from(text));
  proc.emitClose = (code: number) => proc.emit('close', code);
  proc.emitError = (err: Error) => proc.emit('error', err);

  return proc;
}

export function createSpawnMock() {
  const procs: MockProc[] = [];
  const spawn = vi.fn((_cmd: string, _args?: string[], _opts?: any) => {
    const proc = createMockProc();
    procs.push(proc);
    return proc;
  });
  return {
    spawn,
    lastProc: () => procs[procs.length - 1] || null,
    allProcs: () => [...procs],
    reset: () => { procs.length = 0; spawn.mockClear(); },
  };
}
