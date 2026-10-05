import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { obtainIdentity, runWithIdentity } from '../src/services/identity.js';
import {
  browserConsoleSchema, browserScreenshotSchema, handleBrowserConsole, handleBrowserScreenshot,
} from '../src/tools/browser-observe.js';
import { registerBrowserCoreTools } from '../src/tools/browser.js';

// browser_screenshot's breakpoint / full-page / file options and browser_console
// reach the Neural Interface as query parameters; the tools only format.
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const pinned = () => obtainIdentity(`shot-console-${randomUUID()}`, {
  source: 'header', pins: { browserSessionId: 'session-1', browserTabId: 'tab-1' },
});

function stub(reply: (url: URL) => Response) {
  const calls: Array<{ url: URL; deadline: number; sentAt: number }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers || {}) as Record<string, string>;
    calls.push({ url, deadline: Number(headers['X-Synabun-Deadline']), sentAt: Date.now() });
    if (url.pathname === '/api/browser/sessions') {
      return response({ sessions: [{ id: 'session-1', servesDefault: true, tabs: [{ id: 'tab-1' }], tabOwners: {} }] });
    }
    return reply(url);
  }));
  return calls;
}

beforeEach(() => { vi.stubEnv('SYNABUN_BROWSER_V2', '1'); vi.stubEnv('SYNABUN_TYPESAFE', 'off'); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('browser_screenshot', () => {
  it('sends the breakpoint, full-page and file options and waits the long timeout', async () => {
    const calls = stub(() => response({
      ok: true, url: 'http://localhost:3000/', title: 'Local', data: 'iVBORw0KGgo=', mime: 'image/png',
      width: 375, height: 2400, imageWidth: 375, imageHeight: 2400, fullPage: true,
      viewport: { width: 375, height: 812 }, savedPath: '/Users/me/Apps/Site/.synabun/design/home/home-375.png', format: 'png',
    }));
    const result = await runWithIdentity(pinned(), () => handleBrowserScreenshot({
      width: 375, height: 812, fullPage: true, format: 'png', save: true, path: '/Users/me/Apps/Site/.synabun/design/home/home-375.png', maxWidth: 0,
    }));
    const shot = calls.find(c => c.url.pathname.endsWith('/screenshot-base64'))!;
    expect(shot.url.pathname).toBe('/api/browser/sessions/session-1/screenshot-base64');
    expect(Object.fromEntries(shot.url.searchParams)).toEqual({
      tabId: 'tab-1', maxWidth: '0', width: '375', height: '812', fullPage: '1', format: 'png', save: '1',
      path: '/Users/me/Apps/Site/.synabun/design/home/home-375.png',
    });
    expect(shot.deadline - shot.sentAt).toBeGreaterThan(20_000);
    expect(result.content[0]).toEqual({ type: 'text', text: 'Screenshot of http://localhost:3000/ — "Local" (375×2400, viewport 375×812, full page)\nSaved: /Users/me/Apps/Site/.synabun/design/home/home-375.png' });
    expect(result.content[1]).toEqual({ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' });
  });

  it('a plain call stays a JPEG of the viewport, and a refusal is reported as the failure', async () => {
    const calls = stub((url) => (url.searchParams.get('path')
      ? response({ error: '/etc/x.png is outside SynaBun\'s registered projects and /Users/me/.synabun/data/media/screenshots; save inside a project or leave path out' }, 400)
      : response({ ok: true, url: 'https://example.test/', title: 'Example', data: '/9j/4AAQ', width: 1280, height: 800 })));
    const id = pinned();
    const plain = await runWithIdentity(id, () => handleBrowserScreenshot({}));
    expect(Object.fromEntries(calls.at(-1)!.url.searchParams)).toEqual({ tabId: 'tab-1' });
    expect(plain.content[0]).toEqual({ type: 'text', text: 'Screenshot of https://example.test/ — "Example" (1280×800)' });
    expect(plain.content[1]).toEqual({ type: 'image', data: '/9j/4AAQ', mimeType: 'image/jpeg' });
    const refused = await runWithIdentity(id, () => handleBrowserScreenshot({ path: '/etc/x.png' }));
    expect(refused.content).toEqual([{ type: 'text', text: expect.stringMatching(/^Screenshot failed: \/etc\/x\.png is outside SynaBun's registered projects/) }]);
  });

  it('says so when the tab was closed because its viewport was not confirmed restored', async () => {
    const notice = 'SynaBun could not confirm the tab was back at its own viewport size after the capture, so it closed the tab; the next browser call opens a fresh one.';
    stub(() => response({ ok: true, url: 'http://localhost:3000/', title: 'Local', data: '/9j/4AAQ', width: 375, height: 800, viewport: { width: 375, height: 800 }, tabClosed: true, notice }));
    const result = await runWithIdentity(pinned(), () => handleBrowserScreenshot({ width: 375 }));
    expect(result.content[0].text).toBe(`Screenshot of http://localhost:3000/ — "Local" (375×800, viewport 375×800)\n${notice}`);
  });

  it('validates sizes and allows maxWidth 0 (native resolution)', () => {
    const schema = z.object(browserScreenshotSchema);
    expect(schema.safeParse({ width: 375, height: 812, fullPage: true, maxWidth: 0 }).success).toBe(true);
    expect(schema.safeParse({ width: 50 }).success).toBe(false);
    expect(schema.safeParse({ height: 5000 }).success).toBe(false);
    expect(schema.safeParse({ format: 'webp' }).success).toBe(false);
  });

  it('reads booleans explicitly: "false" and 0 are false, so save:"false" writes no file', async () => {
    const schema = z.object(browserScreenshotSchema);
    for (const value of [false, 'false', 'FALSE', ' false ', 0, '0']) {
      expect(schema.parse({ save: value, fullPage: value }), JSON.stringify(value)).toMatchObject({ save: false, fullPage: false });
    }
    for (const value of [true, 'true', 'True', 1, '1']) {
      expect(schema.parse({ save: value, fullPage: value }), JSON.stringify(value)).toMatchObject({ save: true, fullPage: true });
    }
    for (const value of ['yes', 'no', '', 2, {}]) expect(schema.safeParse({ save: value }).success, JSON.stringify(value)).toBe(false);
    expect(schema.parse({}).save).toBeUndefined();
    const snapshot = z.object((await import('../src/tools/browser-observe.js')).browserSnapshotSchema);
    expect(snapshot.parse({ diff: 'false', force: 'false', viewport: '0' })).toMatchObject({ diff: false, force: false, viewport: false });
    // What reaches the Neural Interface for save:"false": no save flag at all.
    const calls = stub(() => response({ ok: true, url: 'https://example.test/', title: 'Example', data: '/9j/4AAQ', width: 1280, height: 800 }));
    await runWithIdentity(pinned(), () => handleBrowserScreenshot(schema.parse({ save: 'false', fullPage: 'false' })));
    const shot = calls.find(c => c.url.pathname.endsWith('/screenshot-base64'))!;
    expect(shot.url.searchParams.has('save')).toBe(false);
    expect(shot.url.searchParams.has('fullPage')).toBe(false);
  });
});

describe('browser_console', () => {
  it('is registered with the core browser tools', () => {
    const names: string[] = [];
    registerBrowserCoreTools({ tool: (name: string) => { names.push(name); return {}; } } as any);
    expect(names).toContain('browser_console');
    expect(names.indexOf('browser_console')).toBe(names.indexOf('browser_screenshot') + 1);
  });

  it('passes level, since, limit and clear, and lists errors with their location and stack', async () => {
    const calls = stub(() => response({
      ok: true, url: 'http://localhost:3000/', title: 'Local', attached: true, matched: 2, total: 5, dropped: 0,
      latest: '2026-09-29T12:00:02.500Z', cleared: true,
      entries: [
        { kind: 'console', level: 'error', type: 'error', text: 'Failed to load resource: the server responded with a status of 404 (Not Found)', location: 'http://localhost:3000/missing.js:0', at: '2026-09-29T12:00:01.250Z' },
        { kind: 'pageerror', level: 'error', message: 'boom is not defined', stack: 'ReferenceError: boom is not defined\n    at http://localhost:3000/app.js:3:5', at: '2026-09-29T12:00:02.500Z' },
      ],
    }));
    const result = await runWithIdentity(pinned(), () => handleBrowserConsole({ level: 'error', since: '2026-09-29T12:00:00.000Z', limit: 20, clear: true }));
    const read = calls.find(c => c.url.pathname.endsWith('/console'))!;
    expect(read.url.pathname).toBe('/api/browser/sessions/session-1/console');
    expect(Object.fromEntries(read.url.searchParams)).toEqual({ tabId: 'tab-1', level: 'error', since: '2026-09-29T12:00:00.000Z', limit: '20', clear: '1' });
    expect(result.content[0].text).toBe([
      'Console of http://localhost:3000/ — "Local"',
      '2 entries at level error or above:',
      '[12:00:01.250] error  Failed to load resource: the server responded with a status of 404 (Not Found)  (http://localhost:3000/missing.js:0)',
      '[12:00:02.500] page error  boom is not defined',
      '    at http://localhost:3000/app.js:3:5',
      'latest: 2026-09-29T12:00:02.500Z',
      'The buffer was cleared.',
    ].join('\n'));
  });

  it('labels the entries of a popup the tab opened with the popup\'s URL', async () => {
    stub(() => response({
      ok: true, url: 'http://localhost:3000/', title: 'Local', attached: true, matched: 2, total: 2, dropped: 0, popups: 1,
      entries: [
        { kind: 'console', level: 'error', text: 'popup error', location: null, popup: 'http://localhost:3000/oauth', at: '2026-09-29T12:00:01.000Z' },
        { kind: 'pageerror', level: 'error', message: 'boom', stack: null, popup: 'http://localhost:3000/oauth', at: '2026-09-29T12:00:02.000Z' },
      ],
    }));
    const result = await runWithIdentity(pinned(), () => handleBrowserConsole({ level: 'error' }));
    expect(result.content[0].text).toContain('[12:00:01.000] [popup http://localhost:3000/oauth] error  popup error');
    expect(result.content[0].text).toContain('[12:00:02.000] [popup http://localhost:3000/oauth] page error  boom');
  });

  it('says so when nothing matched, when entries were dropped, and when the tab was not recorded yet', async () => {
    stub(() => response({ ok: true, url: 'http://localhost:3000/', title: 'Local', attached: true, entries: [], matched: 0, total: 0, dropped: 12, latest: null }));
    const empty = await runWithIdentity(pinned(), () => handleBrowserConsole({ level: 'warning' }));
    expect(empty.content[0].text).toBe('Console of http://localhost:3000/ — "Local"\nNo entries at level warning or above.\n(12 older entries were dropped: the buffer keeps the last 200.)');
    stub(() => response({ ok: true, url: 'http://localhost:3000/', title: 'Local', attached: false, entries: [] }));
    const fresh = await runWithIdentity(pinned(), () => handleBrowserConsole({}));
    expect(fresh.content[0].text).toContain('SynaBun was not recording this tab yet');
  });

  it('accepts only the documented levels and limits', () => {
    const schema = z.object(browserConsoleSchema);
    expect(schema.safeParse({ level: 'all', limit: 200 }).success).toBe(true);
    expect(schema.parse({ since: 1727600000000 }).since).toBe('1727600000000');
    expect(schema.parse({}).since).toBeUndefined();
    expect(schema.safeParse({ level: 'debug' }).success).toBe(false);
    expect(schema.safeParse({ limit: 0 }).success).toBe(false);
    expect(schema.parse({ clear: 'false' }).clear).toBe(false);
    expect(schema.parse({ clear: 1 }).clear).toBe(true);
    expect(schema.safeParse({ clear: 'yes' }).success).toBe(false);
  });
});
