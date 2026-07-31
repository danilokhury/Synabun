import { beforeEach, describe, expect, it, vi } from 'vitest';

const ni = vi.hoisted(() => ({
  evaluate: vi.fn(),
  navigate: vi.fn(),
  resolveSession: vi.fn(),
}));

vi.mock('../src/services/neural-interface.js', () => ni);

import { ensureBlueskyPageTarget, registerBlueskyTools } from '../src/tools/bluesky.js';

const topLevel = (href: string, title = '') => ({
  ok: true,
  result: {
    href,
    origin: href.startsWith('https://bsky.app') ? 'https://bsky.app' : 'null',
    title,
    topLevel: true,
  },
});

describe('BlueSky assigned-tab targeting', () => {
  beforeEach(() => {
    ni.evaluate.mockReset();
    ni.navigate.mockReset();
    ni.resolveSession.mockReset();
  });

  it('keeps an existing top-level bsky.app tab unchanged', async () => {
    ni.evaluate.mockResolvedValue(topLevel('https://bsky.app/'));

    await expect(ensureBlueskyPageTarget('session-1', 'tab-1')).resolves.toMatchObject({ ok: true });
    expect(ni.navigate).not.toHaveBeenCalled();
  });

  it('initializes only an about:blank assigned tab at bsky.app', async () => {
    ni.evaluate
      .mockResolvedValueOnce(topLevel('about:blank'))
      .mockResolvedValueOnce(topLevel('https://bsky.app/', 'Bluesky'));
    ni.navigate.mockResolvedValue({ ok: true, url: 'https://bsky.app/' });

    await expect(ensureBlueskyPageTarget('session-1', 'tab-1')).resolves.toMatchObject({
      ok: true,
      target: { href: 'https://bsky.app/' },
    });
    expect(ni.navigate).toHaveBeenCalledWith(
      'session-1',
      'https://bsky.app/',
      'tab-1',
      undefined,
      'none',
    );
  });

  it('refuses to hijack a nonblank MoreLogin or management tab', async () => {
    ni.evaluate.mockResolvedValue(topLevel('https://www.morelogin.com/profile'));

    await expect(ensureBlueskyPageTarget('session-1', 'tab-1')).resolves.toEqual({
      error: expect.stringContaining('Refusing to navigate a nonblank tab automatically'),
    });
    expect(ni.navigate).not.toHaveBeenCalled();
  });

  it('rejects an iframe even when it reports a bsky.app URL', async () => {
    ni.evaluate.mockResolvedValue({
      ok: true,
      result: {
        href: 'https://bsky.app/',
        origin: 'https://bsky.app',
        title: 'Bluesky',
        topLevel: false,
      },
    });

    await expect(ensureBlueskyPageTarget('session-1', 'tab-1')).resolves.toEqual({
      error: expect.stringContaining('top-level'),
    });
    expect(ni.navigate).not.toHaveBeenCalled();
  });

  it('heals a scheduled blank tab before bluesky_session reads localStorage', async () => {
    const handlers = new Map<string, (args: unknown) => Promise<any>>();
    registerBlueskyTools({
      tool(name: string, _description: string, _schema: unknown, handler: (args: unknown) => Promise<any>) {
        handlers.set(name, handler);
        return {};
      },
    } as any);
    ni.resolveSession.mockResolvedValue({ sessionId: 'session-1', tabId: 'tab-1' });
    ni.evaluate
      .mockResolvedValueOnce(topLevel('about:blank'))
      .mockResolvedValueOnce(topLevel('https://bsky.app/', 'Bluesky'))
      .mockResolvedValueOnce({
        ok: true,
        result: {
          did: 'did:plc:criticalpixel',
          handle: 'critpixel.bsky.social',
          pdsUrl: 'https://example.host.bsky.network',
        },
      });
    ni.navigate.mockResolvedValue({ ok: true, url: 'https://bsky.app/' });

    const result = await handlers.get('bluesky_session')?.({
      sessionId: 'session-1',
      tabId: 'tab-1',
    });

    expect(result?.content?.[0]?.text).toContain('critpixel.bsky.social');
    expect(ni.navigate).toHaveBeenCalledTimes(1);
    expect(ni.evaluate).toHaveBeenCalledTimes(3);
  });
});
