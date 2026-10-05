// The SIGTERM / SIGINT listeners services/neural-interface.ts installs at import.
//
// The Neural Interface (neural-interface/server.js) runs mcp-server/dist in
// process. Its static imports load neural-interface.js (through
// tools/reflect.js) long before createMcpRoutes() calls markHttpMode(), and it
// owns SIGINT / SIGTERM itself: gracefulShutdown awaits the WhatsApp Link and
// the terminal host before the database closes. This module's listener is
// registered first, so a process.exit() from it ended the process before any
// of that ran. A stdio server has no such host: it still releases its tab and
// exits 0.
import { afterEach, describe, expect, it, vi } from 'vitest';

type TerminationSignal = 'SIGTERM' | 'SIGINT';
type Listener = (...args: any[]) => void;

class Exited extends Error {
  constructor(readonly code: unknown) { super(`process.exit(${String(code)})`); }
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.unstubAllGlobals();
});

/** Listeners registered for `event`, `once` wrappers unwrapped. */
const listenersOf = (event: string): Listener[] => process.listeners(event as TerminationSignal) as Listener[];

/**
 * Fresh module instances, loaded in the Neural Interface's order: the import
 * first, HTTP mode (createMcpRoutes → markHttpMode) afterwards.
 */
async function load(mode: 'stdio' | 'http') {
  vi.resetModules();
  const events = ['SIGTERM', 'SIGINT', 'exit'];
  const before = new Map(events.map((event) => [event, new Set(listenersOf(event))]));
  await import('../src/services/neural-interface.js');
  const identity = await import('../src/services/identity.js');
  const added = new Map(events.map((event) => [event, listenersOf(event).filter((listener) => !before.get(event)!.has(listener))]));
  cleanups.push(() => {
    for (const [event, listeners] of added) for (const listener of listeners) process.removeListener(event, listener);
  });
  if (mode === 'http') identity.markHttpMode();
  return { identity, added };
}

/**
 * Deliver `signal` the way Node does (process.emit, listeners in registration
 * order) with a process.exit that, like the real one, ends the dispatch.
 * Listeners the test runner registered before the import sit out the
 * synchronous emit. Returns the exit code, or null when nothing exited.
 */
function deliver(signal: TerminationSignal, moduleListeners: Listener[], host?: Listener): { exitCode: unknown } | null {
  const foreign = (process.rawListeners(signal) as Listener[])
    .filter((raw) => !moduleListeners.includes((raw as { listener?: Listener }).listener ?? raw));
  for (const raw of foreign) process.removeListener(signal, raw);
  if (host) process.on(signal, host);
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Exited(code); }) as never);
  try {
    process.emit(signal, signal);
    return null;
  } catch (error) {
    if (error instanceof Exited) return { exitCode: error.code };
    throw error;
  } finally {
    exit.mockRestore();
    if (host) process.removeListener(signal, host);
    for (const raw of foreign) process.on(signal, raw);
  }
}

describe('neural-interface.ts termination signals', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)(
    'inside the Neural Interface (HTTP mode set after the import) %s reaches the host listener and never exits',
    async (signal) => {
      const { added } = await load('http');
      const host = vi.fn(); // server.js: gracefulShutdown, then its own process.exit
      const exited = deliver(signal, added.get(signal)!, host);
      expect(exited).toBeNull();
      expect(host).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['SIGTERM', 'SIGINT'] as const)('a stdio server releases its tab and exits 0 on %s', async (signal) => {
    const { identity, added } = await load('stdio');
    const stdio = identity.getIdentity();
    stdio.state.interactiveSessionId = 'session-1';
    const fetch = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    expect(deliver(signal, added.get(signal)!)).toEqual({ exitCode: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/browser\/release$/),
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ clientId: stdio.clientId }) }),
    );
  });

  it('a standalone HTTP server (dist/http.js, no signal listener of its own) still exits 0 on SIGTERM', async () => {
    const { added } = await load('http');
    expect(deliver('SIGTERM', added.get('SIGTERM')!)).toEqual({ exitCode: 0 });
  });
});
