import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { obtainIdentity, runWithIdentity, sanitizeDesktopGrant, callerDesktopGrant } from '../src/services/identity.js';
import {
  COMPUTER_DENIED, COMPUTER_TOOL_NAMES, computerSchema, computerAxSchema, formatDesktopResult,
  handleComputer, handleComputerApps, handleComputerAx, handleComputerStatus, registerComputerTools,
  computerAxDescription,
} from '../src/tools/computer.js';

const GRANT = `sbd_${'a'.repeat(43)}`;
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const withGrant = <T>(run: () => Promise<T>, grant: string | null = GRANT) => {
  const identity = obtainIdentity(`assistant-${Math.random().toString(16).slice(2)}`, { source: 'header', pins: { terminalSessionId: 'assistant-1' }, role: 'assistant', desktopGrant: grant });
  return runWithIdentity(identity, run);
};
type ToolResult = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string; _meta?: Record<string, unknown> }> };

beforeEach(() => { vi.stubEnv('SYNABUN_DESKTOP_GRANT', ''); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('computer schemas', () => {
  const computer = z.object(computerSchema);
  it('accepts the Anthropic action vocabulary with length-2 coordinate arrays', () => {
    expect(computer.safeParse({ action: 'left_click', coordinate: [10, 20] }).success).toBe(true);
    expect(computer.safeParse({ action: 'left_click_drag', start_coordinate: [1, 2], coordinate: [3, 4] }).success).toBe(true);
    expect(computer.safeParse({ action: 'zoom', region: [0, 0, 100, 100] }).success).toBe(true);
    expect(computer.safeParse({ action: 'scroll', coordinate: [5, 5], scroll_direction: 'down', scroll_amount: 3 }).success).toBe(true);
  });
  it.each([
    ['an unknown action', { action: 'teleport' }],
    ['a 3-number coordinate', { action: 'left_click', coordinate: [1, 2, 3] }],
    ['a negative coordinate', { action: 'left_click', coordinate: [-1, 2] }],
    ['a float coordinate', { action: 'left_click', coordinate: [1.5, 2] }],
    ['an over-long wait', { action: 'wait', duration: 60 }],
  ])('rejects %s', (_label, input) => {
    expect(computer.safeParse(input).success).toBe(false);
  });
  it('ax actions need no snapshot id to parse (the service checks), but refs are strings', () => {
    expect(z.object(computerAxSchema).safeParse({ action: 'press', snapshot_id: 'ax1', ref: 'a3' }).success).toBe(true);
  });
});

describe('computer handlers', () => {
  it('refuse callers without a desktop grant, before any request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const result = await withGrant(() => handleComputer({ action: 'screenshot' }), null) as ToolResult;
    expect(result.content[0].text).toBe(COMPUTER_DENIED);
    expect(fetch).not.toHaveBeenCalled();
    expect(sanitizeDesktopGrant('sbd_short')).toBeNull();
    expect(sanitizeDesktopGrant(GRANT)).toBe(GRANT);
  });

  it('send the grant and terminal headers, and format text + image results the UI can parse', async () => {
    const fetch = vi.fn(async () => response({
      ok: true, code: 'OK', action: 'left_click', summary: 'left_click (640,400)', app: { name: 'TextEdit' },
      warnings: [{ kind: 'payment', label: '"Pay" looks like a payment control.' }],
      frame: { id: 'f_ab12', screenshotId: 's_cd34', width: 1280, height: 800 }, image: { data: 'QUJD', mimeType: 'image/jpeg' },
    }));
    vi.stubGlobal('fetch', fetch);
    const result = await withGrant(() => handleComputer({ action: 'left_click', coordinate: [640, 400] })) as ToolResult;
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/api/desktop/act');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Synabun-Desktop-Grant']).toBe(GRANT);
    expect(headers['X-Synabun-Terminal']).toBe('assistant-1');
    expect(JSON.parse(String(init.body))).toMatchObject({ action: 'left_click', coordinate: [640, 400] });
    expect(result.content[0].text).toBe('ok · left_click (640,400) · TextEdit · frame=f_ab12 size=1280x800 screenshot_id=s_cd34\nWARNING (payment): "Pay" looks like a payment control.');
    expect(result.content[1]).toEqual({ type: 'image', data: 'QUJD', mimeType: 'image/jpeg', _meta: { 'codex/imageDetail': 'high' } });
  });

  it('turn refusals and transport failures into data, never throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ ok: false, code: 'USER_ACTIVE', error: 'The user is using the mouse.', retryAfterMs: 1800 })));
    const refused = await withGrant(() => handleComputerApps({ action: 'open', app: 'TextEdit' })) as ToolResult;
    expect(refused.content[0].text).toBe('error USER_ACTIVE: The user is using the mouse.\nretryAfterMs: 1800');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const down = await withGrant(() => handleComputerAx({ action: 'snapshot' })) as ToolResult;
    expect(down.content[0].text).toMatch(/^error TRANSPORT_ERROR: Neural Interface unreachable/);
    vi.stubGlobal('fetch', vi.fn(async () => response({ ok: true, code: 'OK', action: 'status', summary: 'setup ready', setupState: 'ready' })));
    const status = await withGrant(() => handleComputerStatus({})) as ToolResult;
    expect(status.content[0].text).toMatch(/^ok · setup ready\n\{"setupState":"ready"\}$/);
  });

  it('formatDesktopResult keeps the AX tree and list payloads', () => {
    const tree = formatDesktopResult({ ok: true, summary: '3 elements', tree: 'snapshot ax1\na1 AXButton "Save"' });
    expect(tree.content[0].text).toBe('ok · 3 elements\nsnapshot ax1\na1 AXButton "Save"');
    const apps = formatDesktopResult({ ok: true, summary: '1 apps', apps: [{ name: 'TextEdit' }] });
    expect(apps.content[0].text).toBe('ok · 1 apps\n[{"name":"TextEdit"}]');
  });

  it('stdio children read the grant from SYNABUN_DESKTOP_GRANT', () => {
    vi.stubEnv('SYNABUN_DESKTOP_GRANT', GRANT);
    expect(callerDesktopGrant()).toBe(GRANT);
    vi.stubEnv('SYNABUN_DESKTOP_GRANT', 'junk');
    expect(callerDesktopGrant()).toBeNull();
  });

  it('registers the four tools', () => {
    const server = new McpServer({ name: 't', version: '0' });
    expect(registerComputerTools(server)).toHaveLength(COMPUTER_TOOL_NAMES.length);
  });
});

describe('computer_ax intent and cancellation', () => {
  it('accepts an intent of up to 120 characters and rejects a longer one; refs look like "e12"', () => {
    const ax = z.object(computerAxSchema);
    expect(ax.safeParse({ action: 'snapshot', intent: 'x'.repeat(120) }).success).toBe(true);
    expect(ax.safeParse({ action: 'press', intent: 'go back' }).success).toBe(true);
    expect(ax.safeParse({ action: 'snapshot', intent: 'x'.repeat(121) }).success).toBe(false);
    expect(ax.safeParse({ action: 'snapshot', intent: 7 }).success).toBe(false);
    expect(computerAxSchema.ref.description).toContain('"e12"');
    expect(computerAxSchema.intent.description).toMatch(/120/);
    for (const code of ['INTENT_PRESS_OFF', 'JEV_UNAVAILABLE', 'NO_CONFIDENT_MATCH', 'NOT_LOW_RISK', 'CANCELLED', 'PRESS_REFUSED(<reason>)']) expect(computerAxDescription).toContain(code);
  });

  it('passes the caller signal to the request: cancelling aborts it and comes back as CANCELLED', async () => {
    let seen: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      seen = init.signal as AbortSignal;
      return new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError'))));
    }));
    const controller = new AbortController();
    const pending = withGrant(() => handleComputerAx({ action: 'snapshot' }, { signal: controller.signal })) as Promise<ToolResult>;
    await vi.waitFor(() => expect(seen).toBeDefined());
    expect(seen!.aborted).toBe(false);
    controller.abort();
    const result = await pending;
    expect(seen!.aborted).toBe(true);
    expect(result.content[0].text).toMatch(/^error CANCELLED: The call was cancelled; the desktop may still finish/);
  });

  it('every handler forwards extra.signal (an already cancelled call sends nothing), through the registration too', async () => {
    const fetch = vi.fn(async () => response({ ok: true, code: 'OK', action: 'status', summary: 'x' }));
    vi.stubGlobal('fetch', fetch);
    const gone = new AbortController();
    gone.abort();
    const extra = { signal: gone.signal };
    const results = await withGrant(async () => [
      await handleComputer({ action: 'screenshot' }, extra), await handleComputerApps({ action: 'list' }, extra),
      await handleComputerAx({ action: 'snapshot' }, extra), await handleComputerStatus({}, extra),
    ]) as ToolResult[];
    for (const result of results) expect(result.content[0].text).toBe('error CANCELLED: The call was cancelled before anything was sent.');
    const server = new McpServer({ name: 't', version: '0' });
    const [, , axTool] = registerComputerTools(server);
    const viaRegistration = await withGrant(() => (axTool.handler as any)({ action: 'snapshot' }, extra)) as ToolResult;
    expect(viaRegistration.content[0].text).toBe('error CANCELLED: The call was cancelled before anything was sent.');
    expect(fetch).not.toHaveBeenCalled();
    // Without a signal (or with a live one) nothing changes.
    const live = await withGrant(() => handleComputerStatus({}, { signal: new AbortController().signal })) as ToolResult;
    expect(live.content[0].text).toMatch(/^ok · x/);
  });
});
