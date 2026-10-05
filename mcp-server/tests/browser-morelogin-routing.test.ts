import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { obtainIdentity, runWithIdentity, type CallerIdentity } from '../src/services/identity.js';
import * as ni from '../src/services/neural-interface.js';
import { handleBrowserNavigate } from '../src/tools/browser-navigate.js';
import { registerBlueskyTools, registerBrowserTwitterTools } from '../src/tools/browser.js';

// While MoreLogin is the default browser every page opens in it, localhost
// included (MoreLogin allows a local port once it is listed in the profile's
// Port scan protection). Nothing reroutes a localhost page to another browser,
// and platform tools, navigations and pinned runs only use the default browser.
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const pathOf = (input: unknown) => new URL(String(input)).pathname;
const bodyOf = (init?: RequestInit) => (init?.body ? JSON.parse(String(init.body)) : {});

const pinned = () => obtainIdentity(`morelogin-routing-${randomUUID()}`, {
  source: 'header', pins: { browserSessionId: 'morelogin-1', browserTabId: 'loop-tab' },
});
const unpinned = () => obtainIdentity(`morelogin-routing-${randomUUID()}`, { source: 'header' });

const moreLoginSession = (id: CallerIdentity) => ({
  id: 'morelogin-1', profileMode: 'morelogin', servesDefault: true, tabs: [{ id: 'loop-tab' }], tabOwners: { [id.clientId]: 'loop-tab' }, loopOwned: true,
});
// A managed-Chrome session left over from before MoreLogin became the default.
const managedSession = { id: 'managed-1', profileMode: 'managed', servesDefault: false, tabs: [{ id: 'm-tab' }], tabOwners: {} };

type Route = { path: string; body: any };

function stubNeuralInterface(id: CallerIdentity, handle: (path: string, body: any) => Response | undefined) {
  const calls: Route[] = [];
  const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const path = pathOf(input);
    const body = bodyOf(init);
    calls.push({ path, body });
    const handled = handle(path, body);
    if (handled) return handled;
    if (path === '/api/browser/sessions') return response({ sessions: [moreLoginSession(id), managedSession], defaultBrowser: { connectMode: 'morelogin', moreloginEnvId: 'ENV-1' } });
    if (path.endsWith('/navigate')) return response({ ok: true, url: body.url, title: 'Page' });
    return response({ ok: true });
  });
  vi.stubGlobal('fetch', fetch);
  return calls;
}

/** Answer the BlueSky tool's in-page scripts for a logged-in bsky.app tab. */
function bskyEvaluate(body: any): Response {
  const script = String(body.script || '');
  if (script.includes('topLevel')) return response({ ok: true, result: { href: 'https://bsky.app/', origin: 'https://bsky.app', title: 'Bluesky', topLevel: true } });
  if (script.includes('__bskyTokenState')) return response({ ok: true, result: { state: 'fresh', expiresAt: Date.now() + 3_600_000, pageAgeMs: 60_000 } });
  return response({ ok: true, result: { did: 'did:plc:acmeaccount', handle: 'acme.bsky.social', pdsUrl: 'https://pds.test' } });
}

function tools() {
  const map = new Map<string, (args: any, extra?: any) => Promise<any>>();
  const server = { tool(name: string, _d: string, _s: unknown, handler: any) { map.set(name, handler); return {}; } } as any;
  registerBlueskyTools(server);
  registerBrowserTwitterTools(server);
  return map;
}

beforeEach(() => { vi.stubEnv('SYNABUN_BROWSER_V2', '1'); vi.stubEnv('SYNABUN_TYPESAFE', 'off'); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('localhost in the MoreLogin browser', () => {
  it('a localhost navigation opens in the pinned MoreLogin tab, and every later call stays there', async () => {
    const id = pinned();
    const calls = stubNeuralInterface(id, (path, body) => (path.endsWith('/evaluate') ? bskyEvaluate(body) : undefined));
    const handlers = tools();
    const { text, route } = await runWithIdentity(id, async () => {
      await handleBrowserNavigate({ url: 'http://localhost:9003/deals/new-releases', snapshot: 'none' });
      const route = await ni.resolveSession();
      const result = await handlers.get('bluesky_session')!({});
      return { text: String(result.content[0].text), route };
    });
    const navigate = calls.find(c => c.path.endsWith('/navigate'))!;
    expect(navigate.path).toBe('/api/browser/sessions/morelogin-1/navigate');
    expect(navigate.body).toMatchObject({ url: 'http://localhost:9003/deals/new-releases', tabId: 'loop-tab' });
    expect(route).toEqual({ sessionId: 'morelogin-1', tabId: 'loop-tab' });
    expect(text).toContain('acme.bsky.social');
    expect(calls.filter(c => c.path.endsWith('/evaluate')).every(c => c.path === '/api/browser/sessions/morelogin-1/evaluate')).toBe(true);
    expect(calls.some(c => c.path === '/api/browser/sessions' && c.body.url)).toBe(false);
  });

  it('a localhost navigation that names a managed-Chrome session opens in MoreLogin instead', async () => {
    const id = pinned();
    const calls = stubNeuralInterface(id, () => undefined);
    await runWithIdentity(id, () => handleBrowserNavigate({ url: 'http://127.0.0.1:3344/', sessionId: 'managed-1', tabId: 'm-tab', snapshot: 'none' }));
    expect(calls.some(c => c.path.includes('/sessions/managed-1/'))).toBe(false);
    expect(calls.find(c => c.path.endsWith('/navigate'))?.path).toBe('/api/browser/sessions/morelogin-1/navigate');
  });

  it('a port MoreLogin blocks comes back as the Port scan protection message', async () => {
    const id = pinned();
    const message = 'MoreLogin blocked localhost:3999: add 3999 to the profile\'s Advanced settings → Port scan protection allowed ports in MoreLogin, then restart the profile.';
    stubNeuralInterface(id, (path) => (path.endsWith('/navigate')
      ? response({ error: message, moreLoginBlocked: true, landedUrl: 'https://getip.morelogin.com/black_whiteList_stop_page_v2.html?blockedUrl=http%3A%2F%2Flocalhost%3A3999%2F' }, 502)
      : undefined));
    const result = await runWithIdentity(id, () => handleBrowserNavigate({ url: 'http://localhost:3999/', snapshot: 'none' }));
    expect(String(result.content[0].text)).toBe(`Navigation failed: ${message}`);
  });

  it('fast mode: a session created at a localhost URL is the caller\'s browser from then on', async () => {
    vi.stubEnv('SYNABUN_BROWSER_FAST', '1');
    const id = unpinned();
    const created: string[] = [];
    const calls = stubNeuralInterface(id, (path, body) => {
      if (path === '/api/browser/sessions' && body.url) {
        created.push(body.url);
        return response({ sessionId: 'morelogin-2', profileMode: 'morelogin' });
      }
      return undefined;
    });
    await runWithIdentity(id, async () => {
      await handleBrowserNavigate({ url: 'http://localhost:9003/deals', snapshot: 'none' });
      await handleBrowserNavigate({ url: 'https://bsky.app/', snapshot: 'none' });
    });
    expect(created).toEqual(['http://localhost:9003/deals']);
    expect(calls.filter(c => c.path.endsWith('/navigate')).map(c => c.path)).toEqual([
      '/api/browser/sessions/morelogin-2/navigate',
      '/api/browser/sessions/morelogin-2/navigate',
    ]);
    expect(id.state.affinitySessionId).toBe('morelogin-2');
  });

  it('an explicit id that is not the default browser is refused for every other page tool, and dropped for platform tools', async () => {
    const id = unpinned();
    stubNeuralInterface(id, (path) => (path === '/api/browser/sessions'
      ? response({ sessions: [managedSession, { id: 'morelogin-1', profileMode: 'morelogin', servesDefault: true, tabs: [{ id: 't1' }], tabOwners: {} }], defaultBrowser: { connectMode: 'morelogin', moreloginEnvId: 'ENV-1' } })
      : undefined));
    const [plain, platform] = await runWithIdentity(id, async () => [
      await ni.resolveSession('managed-1', undefined, 'm-tab'),
      await ni.withPlatformRoute(() => ni.resolveSession('managed-1', undefined, 'm-tab')),
    ]);
    expect(plain).toEqual({ error: 'Browser session managed-1 is not the default browser (managed mode; the default is MoreLogin env ENV-1), so SynaBun\'s browser tools do not act on it. Leave sessionId out: browser_navigate opens the page in the default browser.' });
    expect(platform).toEqual({ sessionId: 'morelogin-1', tabId: undefined });
  });

  it('screenshot, snapshot, content, console, click and batch never reach a managed-Chrome session named by id', async () => {
    const id = unpinned();
    const calls = stubNeuralInterface(id, () => undefined);
    const { handleBrowserScreenshot, handleBrowserSnapshot, handleBrowserContent, handleBrowserConsole } = await import('../src/tools/browser-observe.js');
    const { handleBrowserClick } = await import('../src/tools/browser-interact.js');
    const texts = await runWithIdentity(id, async () => [
      await handleBrowserScreenshot({ sessionId: 'managed-1', tabId: 'm-tab' }),
      await handleBrowserSnapshot({ sessionId: 'managed-1', tabId: 'm-tab' }),
      await handleBrowserContent({ sessionId: 'managed-1', tabId: 'm-tab' }),
      await handleBrowserConsole({ sessionId: 'managed-1', tabId: 'm-tab' }),
      await handleBrowserClick({ sessionId: 'managed-1', tabId: 'm-tab', selector: '#go' } as any),
    ].map((result: any) => String(result.content[0].text)));
    for (const text of texts) expect(text).toContain('Browser session managed-1 is not the default browser (managed mode; the default is MoreLogin env ENV-1)');
    expect(await runWithIdentity(id, () => ni.resolveBatchRoute('managed-1', 'm-tab'))).toMatchObject({ error: expect.stringContaining('is not the default browser') });
    expect(calls.some(c => c.path.includes('/sessions/managed-1/'))).toBe(false);
  });

  it('a change of browser settings drops the cached routes: the server\'s X-Synabun-Browser-Default header is part of the route key', async () => {
    const id = unpinned();
    let signature = 'managed:mirror';
    let listed = 0;
    const withHeader = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'X-Synabun-Browser-Default': signature } });
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const path = pathOf(input);
      if (path === '/api/browser/sessions') {
        listed += 1;
        return signature === 'managed:mirror'
          ? withHeader({ sessions: [{ id: 'mirror-1', profileMode: 'mirror', servesDefault: true, tabs: [{ id: 't1' }], tabOwners: {} }], defaultBrowser: { connectMode: 'mirror' } })
          : withHeader({ sessions: [{ id: 'mirror-1', profileMode: 'mirror', servesDefault: false, tabs: [{ id: 't1' }], tabOwners: {} }], defaultBrowser: { connectMode: 'morelogin', moreloginEnvId: 'ENV-1' } });
      }
      return withHeader({ ok: true });
    }));
    await runWithIdentity(id, async () => {
      expect(await ni.resolveSession('mirror-1', undefined, 't1')).toEqual({ sessionId: 'mirror-1', tabId: 't1' });
      expect(await ni.resolveSession('mirror-1', undefined, 't1')).toEqual({ sessionId: 'mirror-1', tabId: 't1' });
      expect(listed).toBe(1, 'stored under the default the check itself learned: the next call is cached');
      signature = 'morelogin:ENV-1';
      await ni.screenshot('mirror-1', 't1'); // any response carries the new default
      expect(await ni.resolveSession('mirror-1', undefined, 't1')).toMatchObject({ error: expect.stringContaining('is not the default browser') });
    });
    // In process, the Neural Interface says so the moment the settings are saved.
    ni.noteBrowserDefault('managed:mirror');
  });

  it('the server\'s NOT_DEFAULT_BROWSER refusal forgets the cached route and the caller\'s tab, so the next call resolves the default browser', async () => {
    const id = unpinned();
    let moreLoginDefault = false;
    stubNeuralInterface(id, (path) => {
      if (path === '/api/browser/sessions') {
        return moreLoginDefault
          ? response({ sessions: [{ ...managedSession, id: 'mirror-1' }, { id: 'morelogin-9', profileMode: 'morelogin', servesDefault: true, tabs: [{ id: 't9' }], tabOwners: {} }], defaultBrowser: { connectMode: 'morelogin', moreloginEnvId: 'ENV-1' } })
          : response({ sessions: [{ id: 'mirror-1', profileMode: 'mirror', servesDefault: true, tabs: [{ id: 't1' }], tabOwners: {} }], defaultBrowser: { connectMode: 'mirror' } });
      }
      if (path === '/api/browser/sessions/mirror-1/click') return response({ error: 'Session mirror-1 is not the default browser', code: 'NOT_DEFAULT_BROWSER', actionStarted: false }, 409);
      return undefined;
    });
    await runWithIdentity(id, async () => {
      const first = await ni.resolveSession();
      expect(first).toEqual({ sessionId: 'mirror-1', tabId: undefined });
      expect(id.state.affinitySessionId).toBe('mirror-1');
      moreLoginDefault = true;
      const refused = await ni.click('mirror-1', '#go');
      expect(refused).toMatchObject({ code: 'NOT_DEFAULT_BROWSER', actionStarted: false });
      expect(id.state.affinitySessionId).toBe(null);
      expect(await ni.resolveSession()).toEqual({ sessionId: 'morelogin-9', tabId: undefined });
    });
  });
});

describe('the default browser for platform tools, navigations and pinned runs', () => {
  it('a vanished pinned session hard-fails with the server\'s reason instead of creating a browser', async () => {
    const id = pinned();
    const reason = 'Could not start the shared browser session: MoreLogin connect failed: MoreLogin app is not reachable (timeout). Open the MoreLogin app — sessions will not fall back to Chrome while MoreLogin is the default browser.';
    const calls = stubNeuralInterface(id, (path) => {
      if (path === '/api/browser/sessions') return response({ sessions: [managedSession] });
      if (path === '/api/loop/recover-browser') return response({ error: reason }, 500);
      return undefined;
    });
    const route = await runWithIdentity(id, () => ni.withPlatformRoute(() => ni.resolveSession()));
    expect(route).toEqual({ error: `Pinned browser session morelogin-1 is no longer available and recovery failed: ${reason}` });
    expect(calls.map(c => c.path)).toEqual(['/api/browser/sessions', '/api/loop/recover-browser']);
  });

  it('F1: platform tools never adopt a lone managed-Chrome or wrong-env MoreLogin session', async () => {
    for (const lone of [
      { id: 'managed-1', profileMode: 'managed', persistent: true, servesDefault: false, tabs: [{ id: 't1' }], tabOwners: {} },
      { id: 'morelogin-other', profileMode: 'morelogin', moreloginEnvId: '999', servesDefault: false, tabs: [{ id: 't2' }], tabOwners: {} },
    ]) {
      const id = unpinned();
      const calls = stubNeuralInterface(id, (path) => {
        if (path === '/api/browser/sessions') return response({ sessions: [lone], defaultBrowser: { connectMode: 'morelogin', moreloginEnvId: 'ENV-1' } });
        if (path === '/api/browser/acquire') return response({ ok: true, sessionId: 'morelogin-3', tabId: 'own-tab' });
        return undefined;
      });
      const route = await runWithIdentity(id, () => ni.withPlatformRoute(() => ni.resolveSession()));
      expect(route, lone.id).toEqual({ sessionId: 'morelogin-3', tabId: 'own-tab' });
      expect(calls.some(c => c.path === '/api/browser/acquire')).toBe(true);
    }
  });

  it('F1: a pinned session that is not the default browser hard-fails instead of running there', async () => {
    const id = pinned();
    const calls = stubNeuralInterface(id, (path, body) => {
      if (path === '/api/browser/sessions') {
        return response({ sessions: [{ ...moreLoginSession(id), moreloginEnvId: '999', servesDefault: false }], defaultBrowser: { connectMode: 'morelogin', moreloginEnvId: 'ENV-1' } });
      }
      return path.endsWith('/evaluate') ? bskyEvaluate(body) : undefined;
    });
    const text = await runWithIdentity(id, async () => String((await tools().get('bluesky_session')!({})).content[0].text));
    expect(text).toContain('Pinned browser session morelogin-1 is not the default browser (morelogin mode, MoreLogin env 999; the default is MoreLogin env ENV-1)');
    expect(calls.some(c => c.path.endsWith('/evaluate') || c.path.endsWith('/navigate'))).toBe(false);
    const nav = await runWithIdentity(id, () => handleBrowserNavigate({ url: 'http://localhost:3344/', snapshot: 'none' }));
    expect(String(nav.content[0].text)).toContain('is not the default browser');
  });

  it('F1: a wrong explicit id is dropped for platform tools and navigations', async () => {
    const id = pinned();
    const calls = stubNeuralInterface(id, (path, body) => (path.endsWith('/evaluate') ? bskyEvaluate(body) : undefined));
    await runWithIdentity(id, async () => {
      await tools().get('bluesky_session')!({ sessionId: 'managed-1', tabId: 'm-tab' });
      await handleBrowserNavigate({ url: 'https://bsky.app/', sessionId: 'managed-1', tabId: 'm-tab', snapshot: 'none' });
    });
    expect(calls.some(c => c.path.includes('/sessions/managed-1/'))).toBe(false);
    expect(calls.filter(c => c.path.endsWith('/evaluate')).every(c => c.path === '/api/browser/sessions/morelogin-1/evaluate')).toBe(true);
    expect(calls.find(c => c.path.endsWith('/navigate'))?.path).toBe('/api/browser/sessions/morelogin-1/navigate');
  });

  it('F1: managed and real-Chrome setups keep adopting their lone session as before', async () => {
    const id = unpinned();
    stubNeuralInterface(id, (path) => (path === '/api/browser/sessions'
      ? response({ sessions: [{ id: 'mirror-1', profileMode: 'mirror', servesDefault: true, tabs: [{ id: 't1' }], tabOwners: {} }], defaultBrowser: { connectMode: 'mirror' } })
      : undefined));
    const route = await runWithIdentity(id, () => ni.withPlatformRoute(() => ni.resolveSession()));
    expect(route).toEqual({ sessionId: 'mirror-1', tabId: undefined });
  });

  it('F4: a cached route whose recovery fails reports the recovery reason, not "Session not found"', async () => {
    const id = pinned();
    const reason = 'Could not start the shared browser session: MoreLogin connect failed: MoreLogin API unreachable on :40000 (timeout).';
    let listed = 0;
    stubNeuralInterface(id, (path) => {
      if (path === '/api/browser/sessions') {
        listed += 1;
        return response({ sessions: listed === 1 ? [moreLoginSession(id)] : [] });
      }
      if (path === '/api/browser/sessions/morelogin-1/click') return response({ error: 'Session not found', code: 'SESSION_NOT_FOUND', actionStarted: false }, 404);
      if (path === '/api/loop/recover-browser') return response({ error: reason }, 500);
      return undefined;
    });
    const result = await runWithIdentity(id, async () => {
      const route = await ni.resolveSession();
      if ('error' in route) throw new Error(route.error);
      return ni.click(route.sessionId, '#go', undefined, route.tabId);
    });
    expect(result.error).toBe(`Pinned browser session morelogin-1 is no longer available and recovery failed: ${reason}`);
    expect(result).toMatchObject({ code: 'SESSION_NOT_FOUND', actionStarted: false, recoveryFailed: true });
  });
});

// :3344 keeps running the previous server.js until it is restarted, while Codex /
// OpenCode runs already load the new dist. A server without servesDefault or
// defaultBrowser must see exactly the pre-F1 behavior.
describe('old Neural Interface server (no servesDefault / defaultBrowser)', () => {
  const oldPinnedList = (id: CallerIdentity) => ({ sessions: [{ id: 'morelogin-1', tabs: [{ id: 'loop-tab' }], tabOwners: { [id.clientId]: 'loop-tab' }, loopOwned: true }] });

  it('(a) a pinned session keeps working — no hard-fail', async () => {
    const id = pinned();
    const calls = stubNeuralInterface(id, (path, body) => {
      if (path === '/api/browser/sessions') return response(oldPinnedList(id));
      return path.endsWith('/evaluate') ? bskyEvaluate(body) : undefined;
    });
    const text = await runWithIdentity(id, async () => String((await tools().get('bluesky_session')!({})).content[0].text));
    expect(text).toContain('acme.bsky.social');
    expect(calls.filter(c => c.path.endsWith('/evaluate')).every(c => c.path === '/api/browser/sessions/morelogin-1/evaluate')).toBe(true);
    expect(await runWithIdentity(id, () => ni.resolveSession('morelogin-1', { url: 'https://x.com/home' }, 'loop-tab'))).toEqual({ sessionId: 'morelogin-1', tabId: 'loop-tab' });
  });

  it('(b) adoption, auto-selection and affinity behave as before', async () => {
    const id = unpinned();
    stubNeuralInterface(id, (path) => (path === '/api/browser/sessions'
      ? response({ sessions: [{ id: 'lone-1', tabs: [{ id: 't1' }], tabOwners: {} }] })
      : undefined));
    const adopted = await runWithIdentity(id, () => ni.withPlatformRoute(() => ni.resolveSession()));
    expect(adopted).toEqual({ sessionId: 'lone-1', tabId: undefined });
    expect(id.state.affinitySessionId).toBe('lone-1');

    vi.stubEnv('SYNABUN_BROWSER_FAST', '1');
    const fresh = unpinned();
    stubNeuralInterface(fresh, (path, body) => (path === '/api/browser/sessions' && body.url ? response({ sessionId: 'created-1', profileMode: 'morelogin' }) : undefined));
    const created = await runWithIdentity(fresh, () => ni.resolveSession(undefined, { url: 'https://bsky.app/' }));
    expect(created).toEqual({ sessionId: 'created-1', tabId: undefined });
    expect(fresh.state.affinitySessionId).toBe('created-1');
  });

  it('(c) an explicit session id is used as given', async () => {
    const id = unpinned();
    stubNeuralInterface(id, (path) => (path === '/api/browser/sessions'
      ? response({ sessions: [{ id: 'explicit-1', tabs: [{ id: 'x-tab' }], tabOwners: {} }] })
      : undefined));
    const platform = await runWithIdentity(id, () => ni.withPlatformRoute(() => ni.resolveSession('explicit-1', undefined, 'x-tab')));
    expect(platform).toEqual({ sessionId: 'explicit-1', tabId: 'x-tab' });
    const navigation = await runWithIdentity(id, () => ni.resolveSession('explicit-1', { url: 'http://localhost:3344/' }, 'x-tab'));
    expect(navigation).toEqual({ sessionId: 'explicit-1', tabId: 'x-tab' });
  });
});
