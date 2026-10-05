import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real in-page scripts run against a simulated bsky.app tab: a localStorage
// session, a PDS that rejects expired or revoked tokens, and an app that renews
// its token when it boots — which is what fixed the "token expired" first check
// by hand (browser_reload, 2026-08-27 and 2026-09-23).
const ni = vi.hoisted(() => ({
  evaluate: vi.fn(),
  navigate: vi.fn(),
  reload: vi.fn(),
  resolveSession: vi.fn(),
  uploadBlueskyBlob: vi.fn(),
}));

vi.mock('../src/services/neural-interface.js', () => ni);

import { registerBlueskyTools } from '../src/tools/bluesky.js';

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (label: string, expMs: number) =>
  `${b64url({ alg: 'ES256K', typ: 'at+jwt' })}.${b64url({ sub: 'did:plc:acmeaccount', exp: Math.floor(expMs / 1000), label })}.sig`;
const expOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp * 1000;

const HOUR = 3_600_000;
const EXPIRED = jwt('expired', Date.now() - HOUR);
const FRESH = jwt('fresh', Date.now() + 2 * HOUR);
const FRESH_AGAIN = jwt('fresh-again', Date.now() + 2 * HOUR + 10 * 60_000); // renewed later → later exp

type Tab = ReturnType<typeof bskyTab>;

/** A bsky.app tab: page scripts see its localStorage; its PDS sees the bearer token. */
function bskyTab(opts: {
  href?: string;
  accessJwt: string | null;
  pageAgeMs?: number;
  /** What the app stores when it boots again (reload): a renewed token, or null (signed out). */
  onReload?: string | null;
  revoked?: string[];
}) {
  const tab = {
    href: opts.href ?? 'https://bsky.app/',
    accessJwt: opts.accessJwt,
    pageAgeMs: opts.pageAgeMs ?? 45 * 60_000,
    revoked: new Set(opts.revoked || []),
    xrpc: [] as Array<{ method: string; token: string }>,
    writes: [] as string[],
    reloads: 0,
  };
  const storage = () => JSON.stringify({
    session: tab.accessJwt
      ? { accounts: [{ did: 'did:plc:acmeaccount', handle: 'acme.bsky.social', accessJwt: tab.accessJwt, refreshJwt: 'refresh', pdsUrl: 'https://pds.test', active: true }],
          currentAccount: { did: 'did:plc:acmeaccount', handle: 'acme.bsky.social', accessJwt: tab.accessJwt, refreshJwt: 'refresh', pdsUrl: 'https://pds.test' } }
      // A signed-out app keeps the account row but drops its tokens.
      : { accounts: [{ did: 'did:plc:acmeaccount', handle: 'acme.bsky.social' }], currentAccount: undefined },
  });
  const reply = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: () => null },
  });
  const pds = async (url: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
    const method = new URL(url).pathname.replace('/xrpc/', '');
    const token = String(init.headers?.Authorization || '').replace(/^Bearer /, '');
    tab.xrpc.push({ method, token });
    if (!token || tab.revoked.has(token) || expOf(token) <= Date.now()) {
      return reply(400, { error: 'ExpiredToken', message: 'Token has expired' });
    }
    if ((init.method || 'GET') === 'POST') tab.writes.push(method);
    switch (method) {
      case 'com.atproto.server.getSession': return reply(200, { did: 'did:plc:acmeaccount', handle: 'acme.bsky.social', active: true });
      case 'app.bsky.actor.getProfile': return reply(200, { did: 'did:plc:target', handle: 'target.bsky.social', followersCount: 3, followsCount: 4, postsCount: 5 });
      case 'app.bsky.feed.getPosts': return reply(200, { posts: [{ uri: 'at://did:plc:target/app.bsky.feed.post/abc', cid: 'cid-abc', viewer: {} }] });
      case 'com.atproto.repo.createRecord': return reply(200, { uri: `at://did:plc:acmeaccount/app.bsky.feed.like/${tab.writes.length}`, cid: 'cid-like' });
      default: return reply(200, {});
    }
  };
  const win: Record<string, unknown> = {};
  win.top = win;
  win.self = win;
  Object.defineProperty(win, 'location', { get: () => ({ href: tab.href, origin: tab.href.startsWith('https://') ? new URL(tab.href).origin : 'null' }) });
  const page = vm.createContext({
    window: win,
    document: { get title() { return tab.href.startsWith('https://bsky.app') ? 'Bluesky' : ''; } },
    localStorage: { getItem: (key: string) => (key === 'BSKY_STORAGE' && tab.href.startsWith('https://bsky.app') ? storage() : null) },
    performance: { now: () => tab.pageAgeMs },
    atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
    fetch: pds,
    URLSearchParams,
    TextEncoder,
  });
  return { tab, page };
}

function wire({ tab, page }: { tab: Tab['tab']; page: vm.Context }, onNavigate?: () => void) {
  ni.resolveSession.mockResolvedValue({ sessionId: 'morelogin-1', tabId: 'bsky-tab' });
  ni.evaluate.mockImplementation(async (_sessionId: string, script: string) => {
    try {
      const value = await vm.runInContext(script, page);
      return { ok: true, result: value === undefined ? null : JSON.parse(JSON.stringify(value)) };
    } catch (error) {
      return { error: (error as Error).message };
    }
  });
  ni.navigate.mockImplementation(async (_sessionId: string, url: string) => {
    tab.href = url;
    tab.pageAgeMs = 300;
    onNavigate?.();
    return { ok: true, url };
  });
  ni.reload.mockImplementation(async () => {
    tab.reloads += 1;
    tab.pageAgeMs = 250;
    return { ok: true, url: tab.href };
  });
}

function handlers() {
  const map = new Map<string, (args: any) => Promise<any>>();
  registerBlueskyTools({
    tool(name: string, _description: string, _schema: unknown, handler: (args: any) => Promise<any>) {
      map.set(name, handler);
      return {};
    },
  } as any);
  return map;
}

/** Run a tool under fake timers so the tool's own waits don't slow the suite. */
async function call(name: string, args: Record<string, unknown> = {}) {
  const pending = handlers().get(name)!(args);
  await vi.advanceTimersByTimeAsync(60_000);
  const result = await pending;
  return String(result?.content?.[0]?.text || '');
}

describe('BlueSky expired-token recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    for (const fn of Object.values(ni)) fn.mockReset();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('waits for bsky.app to renew the token while a freshly initialized tab boots — no reload', async () => {
    const sim = bskyTab({ href: 'about:blank', accessJwt: EXPIRED });
    // The app renews its stored token about a second after the scheduler's blank tab loads bsky.app.
    wire(sim, () => { setTimeout(() => { sim.tab.accessJwt = FRESH; }, 1_200); });

    const text = await call('bluesky_session', { validate: true });

    expect(text).toContain('acme.bsky.social');
    expect(text).toContain('"active":true');
    expect(ni.reload).not.toHaveBeenCalled();
    // The server never saw the expired token: the check waited for the renewal.
    expect(sim.tab.xrpc).toEqual([{ method: 'com.atproto.server.getSession', token: FRESH }]);
  });

  it('reloads a long-open bsky.app tab once when its token stays expired, then succeeds', async () => {
    const sim = bskyTab({ accessJwt: EXPIRED, pageAgeMs: 3 * HOUR });
    wire(sim);
    ni.reload.mockImplementation(async () => {
      sim.tab.reloads += 1;
      sim.tab.pageAgeMs = 250;
      setTimeout(() => { sim.tab.accessJwt = FRESH; }, 900); // the app renews during its boot
      return { ok: true, url: sim.tab.href };
    });

    const text = await call('bluesky_session', { validate: true });

    expect(text).toContain('acme.bsky.social');
    expect(sim.tab.reloads).toBe(1);
    expect(sim.tab.xrpc.map(r => r.token)).toEqual([FRESH]);
  });

  it('reports "not logged in" only when the page holds no session, without reloading it', async () => {
    const sim = bskyTab({ accessJwt: null });
    wire(sim);

    const text = await call('bluesky_session', { validate: true });

    expect(text).toMatch(/^Not logged in to BlueSky/);
    expect(ni.reload).not.toHaveBeenCalled();
    expect(sim.tab.xrpc).toEqual([]);
  });

  it('says the session could not be renewed — not "not logged in" — when a reload does not help', async () => {
    const sim = bskyTab({ accessJwt: EXPIRED, pageAgeMs: 3 * HOUR });
    wire(sim); // reload leaves the expired token in place

    const text = await call('bluesky_session', { validate: true });

    expect(text).toContain('still expired');
    expect(text).not.toMatch(/Not logged in/);
    expect(sim.tab.reloads).toBe(1);
    expect(sim.tab.xrpc).toEqual([]); // the expired token was never sent
  });

  it('a signed-out app after the reload is reported as not logged in', async () => {
    const sim = bskyTab({ accessJwt: EXPIRED, pageAgeMs: 3 * HOUR });
    wire(sim);
    ni.reload.mockImplementation(async () => {
      sim.tab.reloads += 1;
      sim.tab.pageAgeMs = 250;
      sim.tab.accessJwt = null; // refresh token rejected: bsky.app signs the account out
      return { ok: true, url: sim.tab.href };
    });

    const text = await call('bluesky_session', { validate: true });

    expect(text).toMatch(/^Not logged in to BlueSky: after reloading/);
    expect(sim.tab.reloads).toBe(1);
  });

  it('renews and re-runs a read once when the server rejects a token the page believed fresh', async () => {
    const sim = bskyTab({ accessJwt: FRESH, revoked: [FRESH] });
    wire(sim);
    ni.reload.mockImplementation(async () => {
      sim.tab.reloads += 1;
      sim.tab.pageAgeMs = 250;
      setTimeout(() => { sim.tab.accessJwt = FRESH_AGAIN; }, 600);
      return { ok: true, url: sim.tab.href };
    });

    const text = await call('bluesky_profile', { actor: 'target.bsky.social' });

    expect(text).toContain('target.bsky.social');
    expect(sim.tab.reloads).toBe(1);
    expect(sim.tab.xrpc.map(r => r.token)).toEqual([FRESH, FRESH_AGAIN]);
  });

  it('a like rejected as expired is written exactly once after the renewal', async () => {
    const sim = bskyTab({ accessJwt: FRESH, revoked: [FRESH] });
    wire(sim);
    ni.reload.mockImplementation(async () => {
      sim.tab.reloads += 1;
      setTimeout(() => { sim.tab.accessJwt = FRESH_AGAIN; }, 600);
      return { ok: true, url: sim.tab.href };
    });

    const text = await call('bluesky_action', { action: 'like', target: 'at://did:plc:target/app.bsky.feed.post/abc' });

    expect(text).toContain('"action":"like"');
    expect(sim.tab.writes).toEqual(['com.atproto.repo.createRecord']);
    expect(sim.tab.reloads).toBe(1);
  });

  it('F5: a slow blank-tab first check ends within one 48 s deadline with a clear error', async () => {
    const sim = bskyTab({ href: 'about:blank', accessJwt: EXPIRED });
    wire(sim);
    // Worst case from the review: slow navigation, no renewal while booting, slow reload.
    ni.navigate.mockImplementation((_s: string, url: string) => new Promise((done) => setTimeout(() => {
      sim.tab.href = url; sim.tab.pageAgeMs = 300; done({ ok: true, url });
    }, 15_000)));
    ni.reload.mockImplementation(() => new Promise((done) => setTimeout(() => { sim.tab.reloads += 1; done({ ok: true }); }, 15_000)));
    const started = Date.now();
    let finishedAt = 0;
    const pending = handlers().get('bluesky_session')!({ validate: true }).then((r: any) => { finishedAt = Date.now(); return r; });
    await vi.advanceTimersByTimeAsync(90_000);
    const text = String((await pending).content[0].text);
    expect(finishedAt - started).toBeLessThanOrEqual(50_000);
    expect(text).toMatch(/time limit/);
    expect(sim.tab.xrpc).toEqual([]); // the expired token was never sent
  });

  it('F5: a BlueSky request that never answers is cut at the deadline, reported as uncertain, never retried', async () => {
    const sim = bskyTab({ accessJwt: FRESH });
    wire(sim);
    const evaluatePage = ni.evaluate.getMockImplementation()!;
    ni.evaluate.mockImplementation((sessionId: string, script: string, tabId?: string) => (script.includes('__bskyXrpc')
      ? new Promise(() => {}) // the page never answers
      : evaluatePage(sessionId, script, tabId)));
    const started = Date.now();
    let finishedAt = 0;
    const pending = handlers().get('bluesky_action')!({ action: 'like', target: 'at://did:plc:target/app.bsky.feed.post/abc' })
      .then((r: any) => { finishedAt = Date.now(); return r; });
    await vi.advanceTimersByTimeAsync(90_000);
    const text = String((await pending).content[0].text);
    expect(finishedAt - started).toBeLessThanOrEqual(50_000);
    expect(text).toContain('time limit');
    expect(text).toContain('check the account before repeating');
    const bodyRuns = ni.evaluate.mock.calls.filter(([, script]) => String(script).includes('__bskyXrpc'));
    expect(bodyRuns).toHaveLength(1);
    expect(ni.reload).not.toHaveBeenCalled();
  });

  it('stops after one renewal: a second rejection is reported and the tab is not reloaded again', async () => {
    const sim = bskyTab({ accessJwt: FRESH, revoked: [FRESH, FRESH_AGAIN] });
    wire(sim);
    ni.reload.mockImplementation(async () => {
      sim.tab.reloads += 1;
      setTimeout(() => { sim.tab.accessJwt = FRESH_AGAIN; }, 600);
      return { ok: true, url: sim.tab.href };
    });

    const text = await call('bluesky_action', { action: 'like', target: 'at://did:plc:target/app.bsky.feed.post/abc' });

    expect(text).toContain('still rejected after the bsky.app tab renewed its session');
    expect(sim.tab.writes).toEqual([]);
    expect(sim.tab.reloads).toBe(1);
  });
});
