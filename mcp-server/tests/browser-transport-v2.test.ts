import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { obtainIdentity, runWithIdentity, type CallerIdentity } from '../src/services/identity.js';
import * as ni from '../src/services/neural-interface.js';
import { handleBrowserBatch } from '../src/tools/browser-batch.js';
import { registerBrowserCoreTools, registerBrowserTwitterTools, withBrowserCancellation } from '../src/tools/browser.js';

const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const identity = (pins = true) => obtainIdentity(`browser-test-${randomUUID()}`, {
  source: 'header', pins: pins ? { browserSessionId: 'session-1', browserTabId: 'tab-1' } : undefined,
});
const sessions = (id: CallerIdentity, sessionId = 'session-1', tabId = 'tab-1') => ({
  sessions: [{ id: sessionId, tabs: [{ id: tabId }], tabOwners: { [id.clientId]: tabId } }],
});
const pathOf = (input: unknown) => new URL(String(input)).pathname;

beforeEach(() => { vi.stubEnv('SYNABUN_BROWSER_V2', '1'); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('browser transport v2', () => {
  it('resolves a pinned caller once and lets actions validate its cached route', async () => {
    const id = identity();
    const fetch = vi.fn(async (input: unknown) => response(pathOf(input).endsWith('/sessions') ? sessions(id) : { ok: true }));
    vi.stubGlobal('fetch', fetch);
    await runWithIdentity(id, async () => {
      for (let i = 0; i < 3; i++) {
        const route = await ni.resolveSession('session-1', undefined, 'tab-1');
        if ('error' in route) throw new Error(route.error);
        await ni.click(route.sessionId, undefined, undefined, route.tabId, undefined, undefined, 'e1', 'none');
      }
    });
    expect(fetch.mock.calls.map(([url]) => pathOf(url))).toEqual([
      '/api/browser/sessions', ...Array(3).fill('/api/browser/sessions/session-1/click'),
    ]);
  });

  it('keeps the old preflight behavior when v2 is disabled', async () => {
    vi.stubEnv('SYNABUN_BROWSER_V2', '0');
    const id = identity();
    const fetch = vi.fn(async () => response(sessions(id)));
    vi.stubGlobal('fetch', fetch);
    await runWithIdentity(id, async () => { await ni.resolveSession(); await ni.resolveSession(); });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('isolates concurrent caller route caches and terminal headers', async () => {
    const a = identity(), b = identity();
    b.pins.browserSessionId = 'session-2'; b.pins.browserTabId = 'tab-2';
    const fetch = vi.fn(async (input: unknown, opts: RequestInit) => {
      const caller = (opts.headers as Record<string, string>)['X-Synabun-Terminal'];
      if (pathOf(input).endsWith('/sessions')) return response(caller === a.clientId ? sessions(a) : sessions(b, 'session-2', 'tab-2'));
      return response({ ok: true });
    });
    vi.stubGlobal('fetch', fetch);
    await Promise.all([a, b].map(id => runWithIdentity(id, async () => {
      await ni.resolveSession();
      const route = await ni.resolveSession();
      if ('error' in route) throw Error(route.error);
      await ni.fill(route.sessionId, '#input', id.clientId, undefined, route.tabId);
    })));
    const calls = fetch.mock.calls.filter(([url]) => pathOf(url).endsWith('/fill'));
    expect(calls).toHaveLength(2);
    for (const [url, opts] of calls) {
      const terminal = (opts.headers as Record<string, string>)['X-Synabun-Terminal'];
      expect(pathOf(url)).toContain(terminal === a.clientId ? '/session-1/' : '/session-2/');
      expect(JSON.parse(opts.body as string).tabId).toBe(terminal === a.clientId ? 'tab-1' : 'tab-2');
    }
  });

  it('recovers once only after the server confirms a missing route never started', async () => {
    const id = identity();
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(sessions(id)))
      .mockResolvedValueOnce(response({ error: 'Tab closed', code: 'TAB_NOT_FOUND', actionStarted: false }, 404))
      .mockResolvedValueOnce(response({ sessions: [] }))
      .mockResolvedValueOnce(response({ sessionId: 'session-2', tabId: 'tab-2' }))
      .mockResolvedValueOnce(response({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    await runWithIdentity(id, async () => {
      await ni.resolveSession();
      expect(await ni.click('session-1', undefined, undefined, 'tab-1', undefined, undefined, 'e2', 'none')).toMatchObject({ ok: true });
      expect(await ni.resolveSession()).toEqual({ sessionId: 'session-2', tabId: 'tab-2' });
    });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(pathOf(fetch.mock.calls[4][0])).toBe('/api/browser/sessions/session-2/click');
    expect(JSON.parse(fetch.mock.calls[4][1].body).tabId).toBe('tab-2');
  });

  it('does not retry a second confirmed route failure', async () => {
    const id = identity();
    const missing = { error: 'Missing', code: 'SESSION_NOT_FOUND', actionStarted: false };
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(sessions(id)))
      .mockResolvedValueOnce(response(missing, 404))
      .mockResolvedValueOnce(response({ sessions: [] }))
      .mockResolvedValueOnce(response({ sessionId: 'session-2', tabId: 'tab-2' }))
      .mockResolvedValueOnce(response(missing, 404));
    vi.stubGlobal('fetch', fetch);
    await runWithIdentity(id, async () => {
      await ni.resolveSession();
      expect(await ni.click('session-1', '#submit')).toMatchObject(missing);
    });
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it.each([
    { error: 'Network outcome unknown', code: 'TRANSPORT_ERROR', outcome: 'uncertain' },
    { error: 'Failed after click', code: 'TAB_NOT_FOUND', actionStarted: true },
    { error: 'Session not found' },
  ])('does not replay ambiguous errors: %j', async failure => {
    const id = identity();
    const fetch = vi.fn().mockResolvedValueOnce(response(sessions(id))).mockResolvedValueOnce(response(failure, 500));
    vi.stubGlobal('fetch', fetch);
    await runWithIdentity(id, async () => {
      await ni.resolveSession();
      expect(await ni.click('session-1', '#submit')).toMatchObject(failure);
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('lets paced clicks wait 120 seconds and forwards budgets, baselines, and request IDs', async () => {
    const fetch = vi.fn(async () => response({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    const started = Date.now();
    await runWithIdentity(identity(), () => ni.click('session-1', undefined, undefined, 'tab-1', undefined, undefined, 'e1', 'diff', { baselineId: 'snapshot-1' }));
    const opts = fetch.mock.calls[0][1] as RequestInit;
    const headers = opts.headers as Record<string, string>;
    expect(Number(headers['X-Synabun-Deadline']) - started).toBeGreaterThanOrEqual(120000);
    expect(headers['X-Synabun-Request-Id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(opts.body as string)).toMatchObject({ ref: 'e1', snapshotMaxChars: 6000, baselineId: 'snapshot-1' });
  });

  it('aborts at its deadline without replaying an uncertain action', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_url: unknown, opts: RequestInit) => new Promise((_resolve, reject) => {
      opts.signal?.addEventListener('abort', () => reject(new Error('AbortError')));
    }));
    vi.stubGlobal('fetch', fetch);
    const pending = runWithIdentity(identity(), () => ni.click('session-1', '#submit'));
    await vi.advanceTimersByTimeAsync(120001);
    expect(await pending).toMatchObject({ code: 'REQUEST_TIMEOUT', outcome: 'uncertain' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('metrics contain metadata without page content, form values, or query strings', async () => {
    vi.stubEnv('SYNABUN_BROWSER_METRICS', '1');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => response({ content: 'SECRET PAGE CONTENT', url: 'https://private.example/?secret=yes' })));
    await runWithIdentity(identity(), () => ni.fill('session-1', '#secret', 'SECRET FORM VALUE'));
    expect(log).toHaveBeenCalledOnce();
    const recorded = log.mock.calls[0][0];
    expect(recorded).toContain('responseBytes');
    expect(recorded).toContain('estimatedTextTokens');
    expect(recorded).not.toMatch(/SECRET|private\.example|secret=yes/);
  });
});

describe('browser_batch using real tool handlers', () => {
  function mockBrowser(id: CallerIdentity, overrides?: (path: string, body: Record<string, unknown>) => Response | undefined) {
    const fetch = vi.fn(async (input: unknown, opts: RequestInit) => {
      const path = pathOf(input);
      if (path.endsWith('/sessions')) return response(sessions(id));
      const body = opts.body ? JSON.parse(opts.body as string) : {};
      return overrides?.(path, body) || response({ ok: true, url: 'https://example.test', title: 'Fixture', snapshotText: '- button "Save" [ref=e1]' });
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }

  it('runs guarded handlers sequentially on one tab with only one final observation', async () => {
    const id = identity();
    const fetch = mockBrowser(id);
    const result = await runWithIdentity(id, () => handleBrowserBatch({ steps: [
      { tool: 'browser_fill', args: { ref: 'e1', value: 'hello' } },
      { tool: 'browser_click', args: { ref: 'e2' } },
    ] }));
    const value = JSON.parse(result.content[0].text);
    expect(value.completedSteps).toBe(2);
    expect(value.observation).toBeDefined();
    const actionCalls = fetch.mock.calls.filter(([url]) => !pathOf(url).endsWith('/sessions'));
    expect(actionCalls.map(([url]) => pathOf(url).split('/').at(-1))).toEqual(['fill', 'click', 'snapshot']);
    expect(JSON.parse(actionCalls[1][1].body as string)).toMatchObject({ tabId: 'tab-1', snapshot: 'none' });
    expect(fetch.mock.calls.filter(([url]) => pathOf(url).endsWith('/sessions'))).toHaveLength(2);
  });

  it('validates every step before executing the first action', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const result = await handleBrowserBatch({ steps: [
      { tool: 'browser_press', args: { key: 'Enter' } },
      { tool: 'browser_click', args: { tabId: 'someone-else' } },
    ] });
    expect(result).toHaveProperty('isError', true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('stops on a stale ref without retrying any completed step or resolving a new tab', async () => {
    const id = identity();
    const fetch = mockBrowser(id, path => path.endsWith('/click') ? response({ error: 'Stale ref', code: 'TAB_NOT_FOUND', actionStarted: false }, 404) : undefined);
    const result = await runWithIdentity(id, () => handleBrowserBatch({ steps: [
      { tool: 'browser_press', args: { key: 'Tab' } },
      { tool: 'browser_click', args: { ref: 'e404' } },
      { tool: 'browser_fill', args: { ref: 'e3', value: 'must not run' } },
    ] }));
    expect(result).toHaveProperty('isError', true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ completedSteps: 1, failedStep: 2 });
    const paths = fetch.mock.calls.map(([url]) => pathOf(url));
    expect(paths.filter(path => path.endsWith('/press'))).toHaveLength(1);
    expect(paths.filter(path => path.endsWith('/click'))).toHaveLength(1);
    expect(paths.some(path => /fill|snapshot|recover/.test(path))).toBe(false);
  });

  it('includes requested intermediate observations and skips a duplicate final observation', async () => {
    const id = identity();
    const fetch = mockBrowser(id);
    const result = await runWithIdentity(id, () => handleBrowserBatch({ steps: [
      { tool: 'browser_press', args: { key: 'Tab' }, observe: true },
      { tool: 'browser_press', args: { key: 'Tab' }, observe: true },
    ] }));
    expect(JSON.parse(result.content[0].text).results.every((step: any) => step.observation)).toBe(true);
    expect(fetch.mock.calls.filter(([url]) => pathOf(url).endsWith('/snapshot'))).toHaveLength(2);
  });

  it('refuses a foreign-owned tab', async () => {
    const id = identity();
    vi.stubGlobal('fetch', vi.fn(async () => response({ sessions: [{ id: 'session-1', tabs: [{ id: 'tab-1' }], tabOwners: { other: 'tab-1' } }] })));
    const result = await runWithIdentity(id, () => handleBrowserBatch({ steps: [{ tool: 'browser_press', args: { key: 'Enter' } }] }));
    expect(result).toHaveProperty('isError', true);
    expect(result.content[0].text).toContain('owned');
  });

  it('runs a localhost batch on the same tab like any other page', async () => {
    const id = identity();
    const fetch = mockBrowser(id, path => path.endsWith('/navigate') ? response({ ok: true, url: 'http://localhost:3000', title: 'Local' }) : undefined);
    const result = await runWithIdentity(id, () => handleBrowserBatch({ steps: [
      { tool: 'browser_navigate', args: { url: 'http://localhost:3000' } },
      { tool: 'browser_press', args: { key: 'Enter' } },
    ] }));
    expect(result).not.toHaveProperty('isError', true);
    const paths = fetch.mock.calls.map(([url]) => pathOf(url));
    expect(paths).toContain('/api/browser/sessions/session-1/navigate');
    expect(paths).toContain('/api/browser/sessions/session-1/press');
  });

  it('uses the structured extraction handler from the fixed allowlist', async () => {
    const id = identity();
    const fetch = mockBrowser(id, path => path.endsWith('/extract') ? response({
      ok: true, items: [{ url: 'https://example.test/post', text: 'Hello' }], raw: 1,
      scrollsUsed: 0, truncated: false, partial: false, stopReason: 'max-items',
    }) : undefined);
    const result = await runWithIdentity(id, () => handleBrowserBatch({ snapshot: 'none', steps: [
      { tool: 'browser_extract_tweets', args: { maxItems: 1, fields: ['url', 'text'] } },
    ] }));
    expect(JSON.parse(result.content[0].text).completedSteps).toBe(1);
    expect(fetch.mock.calls.some(([url]) => pathOf(url).endsWith('/extract'))).toBe(true);
    expect(fetch.mock.calls.some(([url]) => pathOf(url).endsWith('/snapshot'))).toBe(false);
  });

  it('reports a final observation failure while retaining completed actions', async () => {
    const id = identity();
    mockBrowser(id, path => path.endsWith('/snapshot') ? response({ ok: true, snapshotError: 'Page closed' }) : undefined);
    const result = await runWithIdentity(id, () => handleBrowserBatch({ steps: [
      { tool: 'browser_press', args: { key: 'Tab' } },
    ] }));
    expect(result).toHaveProperty('isError', true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ completedSteps: 1, failure: { code: 'SNAPSHOT_FAILED' } });
  });

  it('is disabled by the explicit rollback flag', async () => {
    vi.stubEnv('SYNABUN_BROWSER_V2', '0');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const result = await handleBrowserBatch({ steps: [{ tool: 'browser_press', args: { key: 'Tab' } }] });
    expect(result).toHaveProperty('isError', true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not issue HTTP requests for an already cancelled MCP call', async () => {
    const controller = new AbortController(); controller.abort();
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const result = await handleBrowserBatch({ steps: [{ tool: 'browser_press', args: { key: 'Tab' } }] }, { signal: controller.signal });
    expect(result).toHaveProperty('isError', true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ completedSteps: 0, failure: { code: 'BATCH_CANCELLED', actionStarted: false } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retains a completed step and stops before the next HTTP call after cancellation', async () => {
    const id = identity();
    const controller = new AbortController();
    const fetch = mockBrowser(id, path => {
      if (path.endsWith('/press')) controller.abort();
      return undefined;
    });
    const result = await runWithIdentity(id, () => handleBrowserBatch({ steps: [
      { tool: 'browser_press', args: { key: 'Tab' } },
      { tool: 'browser_click', args: { ref: 'e2' } },
    ] }, { signal: controller.signal }));
    expect(result).toHaveProperty('isError', true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ completedSteps: 1, stoppedBeforeStep: 2, failure: { code: 'BATCH_CANCELLED' } });
    expect(fetch.mock.calls.some(([url]) => /click|snapshot/.test(pathOf(url)))).toBe(false);
  });

  it('aborts an in-flight action when the MCP call is cancelled and never replays it', async () => {
    const id = identity();
    const controller = new AbortController();
    const fetch = vi.fn(async (input: unknown, opts: RequestInit) => {
      const path = pathOf(input);
      if (path.endsWith('/sessions')) return response(sessions(id));
      if (path.endsWith('/click')) return new Promise<Response>((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(new Error('AbortError')));
        queueMicrotask(() => controller.abort());
      });
      return response({ ok: true });
    });
    vi.stubGlobal('fetch', fetch);
    const result = await runWithIdentity(id, () => handleBrowserBatch({ steps: [
      { tool: 'browser_press', args: { key: 'Tab' } },
      { tool: 'browser_click', args: { ref: 'e1' } },
      { tool: 'browser_press', args: { key: 'Enter' } },
    ] }, { signal: controller.signal }));
    expect(result).toHaveProperty('isError', true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ completedSteps: 1, failedStep: 2, failure: { code: 'BATCH_CANCELLED', outcome: 'uncertain' } });
    expect(fetch.mock.calls.filter(([url]) => pathOf(url).endsWith('/click'))).toHaveLength(1);
    expect(fetch.mock.calls.filter(([url]) => pathOf(url).endsWith('/press'))).toHaveLength(1);
    expect(fetch.mock.calls.some(([url]) => pathOf(url).endsWith('/snapshot'))).toBe(false);
  });

  it('cancels initial route inspection before an action can start', async () => {
    const id = identity();
    const controller = new AbortController();
    const fetch = vi.fn((_input: unknown, opts: RequestInit) => new Promise<Response>((_resolve, reject) => {
      opts.signal?.addEventListener('abort', () => reject(new Error('AbortError')));
      queueMicrotask(() => controller.abort());
    }));
    vi.stubGlobal('fetch', fetch);
    const result = await runWithIdentity(id, () => handleBrowserBatch({ steps: [
      { tool: 'browser_click', args: { ref: 'e1' } },
    ] }, { signal: controller.signal }));
    expect(JSON.parse(result.content[0].text)).toMatchObject({ completedSteps: 0, failure: { code: 'BATCH_CANCELLED' } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects more than ten steps and arbitrary tool dispatch', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const oversized = await handleBrowserBatch({ steps: Array.from({ length: 11 }, () => ({ tool: 'browser_press' as const, args: { key: 'Tab' } })) });
    expect(oversized).toHaveProperty('isError', true);
    const arbitrary = await handleBrowserBatch({ steps: [{ tool: 'browser_evaluate', args: { script: 'danger()' } }] } as any);
    expect(arbitrary).toHaveProperty('isError', true);
    expect(fetch).not.toHaveBeenCalled();
  });
});


describe('registered browser tool cancellation', () => {
  it('uses generic browser cancellation codes outside batches', async () => {
    const controller = new AbortController(); controller.abort();
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const handler = withBrowserCancellation(() => ni.click('session-1', '#submit'));
    const result = await handler({}, { signal: controller.signal });
    expect(result).toMatchObject({ code: 'BROWSER_CANCELLED', actionStarted: false });
    expect(result.error).toContain('Browser request cancelled');
    expect(result.error).not.toContain('batch');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { tool: 'browser_click', args: { ref: 'e1' }, operation: '/click', register: registerBrowserCoreTools },
    { tool: 'browser_extract_tweets', args: { maxItems: 1 }, operation: '/extract', register: registerBrowserTwitterTools },
  ])('forwards MCP cancellation from the registered $tool handler to HTTP', async ({ tool, args, operation, register }) => {
    const handlers = new Map<string, (args: any, extra?: { signal?: AbortSignal }) => Promise<any>>();
    register({ tool(name: string, _description: string, _schema: unknown, handler: any) {
      handlers.set(name, handler);
      return {};
    } } as any);
    const id = identity();
    const controller = new AbortController();
    const fetch = vi.fn(async (input: unknown, opts: RequestInit) => {
      if (pathOf(input).endsWith('/sessions')) return response(sessions(id));
      expect(pathOf(input)).toContain(operation);
      return new Promise<Response>((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(new Error('AbortError')));
        queueMicrotask(() => controller.abort());
      });
    });
    vi.stubGlobal('fetch', fetch);
    const result = await runWithIdentity(id, () => handlers.get(tool)!(args, { signal: controller.signal }));
    expect(result.content[0].text).toContain('Browser request cancelled');
    expect(fetch.mock.calls.filter(([url]) => pathOf(url).endsWith(operation))).toHaveLength(1);
    const lastSignal = fetch.mock.calls.at(-1)![1].signal;
    expect(lastSignal?.aborted).toBe(true);
  });
});
