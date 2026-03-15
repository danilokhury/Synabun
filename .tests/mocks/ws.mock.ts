// Mock WebSocket for claude-skin handler tests

import { EventEmitter } from 'node:events';
import { vi } from 'vitest';

export interface MockWs extends EventEmitter {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  simulateMessage(data: string | object): void;
  simulateClose(): void;
  getSentMessages(): object[];
  getSentRaw(): string[];
}

export function createMockWs(readyState = 1): MockWs {
  const ws = new EventEmitter() as MockWs;
  ws.readyState = readyState;
  ws.send = vi.fn();
  ws.close = vi.fn();

  ws.simulateMessage = (data) => {
    const raw = typeof data === 'string' ? data : JSON.stringify(data);
    ws.emit('message', Buffer.from(raw));
  };

  ws.simulateClose = () => {
    ws.emit('close');
  };

  ws.getSentRaw = () => ws.send.mock.calls.map((c: any[]) => c[0]);

  ws.getSentMessages = () =>
    ws.send.mock.calls.map((c: any[]) => {
      try { return JSON.parse(c[0]); }
      catch { return null; }
    }).filter(Boolean);

  return ws;
}
