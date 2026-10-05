import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../src/services/neural-interface.js', () => ({
  isBrowserV2Enabled: () => process.env.SYNABUN_BROWSER_V2 !== '0',
  resolveSession: vi.fn(), extract: vi.fn(), evaluate: vi.fn(),
}));
vi.mock('../src/services/sqlite.js', () => ({ getMemory: vi.fn(async () => null) }));
import * as ni from '../src/services/neural-interface.js';
import { handleBrowserExtractFbGroups, handleBrowserExtractTweets } from '../src/tools/browser-observe.js';

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

function mockGroups() {
  vi.stubEnv('SYNABUN_BROWSER_V2', '1');
  vi.mocked(ni.resolveSession).mockResolvedValue({ sessionId: 'session', tabId: 'owned-tab' });
  vi.mocked(ni.extract).mockResolvedValue({
    ok: true,
    items: [
      { name: 'Brazil Games', url: 'https://www.facebook.com/groups/brazil-games', subtitle: '100 members' },
      { name: 'UK Games', url: 'https://www.facebook.com/groups/uk-games', subtitle: '200 members' },
    ], raw: 3, scrollsUsed: 1, truncated: false, partial: true, stopReason: 'deadline', failureReason: 'Extraction deadline reached',
  });
}

it('uses server extraction without requiring an opt-in environment override', async () => {
  mockGroups();
  vi.stubEnv('SYNABUN_BROWSER_V2', undefined);
  const response = await handleBrowserExtractTweets({ maxItems: 1 });
  expect(response.content[0].text).not.toContain('Error:');
  expect(ni.extract).toHaveBeenCalledOnce();
  expect(ni.evaluate).not.toHaveBeenCalled();
});

it('retains legacy evaluation when explicitly opted out', async () => {
  mockGroups();
  vi.stubEnv('SYNABUN_BROWSER_V2', '0');
  vi.mocked(ni.evaluate).mockResolvedValue({ result: [{ url: 'https://example.test/1', text: 'Legacy result' }] });
  const response = await handleBrowserExtractTweets({ maxItems: 1 });
  expect(response.content[0].text).toContain('Legacy result');
  expect(ni.evaluate).toHaveBeenCalledOnce();
  expect(ni.extract).not.toHaveBeenCalled();
});

it('projects grouped results only after classification and retains partial-result evidence', async () => {
  mockGroups();
  const response = await handleBrowserExtractFbGroups({ fields: ['name'], timeoutMs: 5000 });
  const payload = JSON.parse(response.content[0].text);
  expect(payload.counts.total).toBe(2);
  expect(payload.counts.byRegion.Brazil).toBe(1);
  expect(payload.counts.byRegion.UK).toBe(1);
  expect(payload.byRegion.Brazil[0]).toEqual({ name: 'Brazil Games' });
  expect(payload.extraction.partial).toBe(true);
  expect(payload.extraction.failureReason).toContain('deadline');
  expect(ni.extract).toHaveBeenCalledWith('session', expect.any(String), 'owned-tab', expect.objectContaining({ timeoutMs: 5000 }));
  expect(vi.mocked(ni.extract).mock.calls[0][3]).not.toHaveProperty('fields');
});

it('caps complete grouped JSON without discarding classification or hiding truncation', async () => {
  mockGroups();
  const response = await handleBrowserExtractFbGroups({ maxChars: 450 });
  const body = response.content[0].text;
  const payload = JSON.parse(body);
  expect(body.length).toBeLessThanOrEqual(450);
  expect(payload.extraction.truncated).toBe(true);
  expect(payload.extraction.stopReason).toBe('max_chars');
  expect(payload.counts.total).toBe(2);
  expect(payload.counts.shown).toBe(Object.values(payload.byRegion).flat().length);
});

it('a zero-item budget result gives an actionable budget error, not a missing-feed message', async () => {
  mockGroups();
  vi.mocked(ni.extract).mockResolvedValue({ ok: true, items: [], raw: 2, scrollsUsed: 0, truncated: true, budgetReason: 'max_chars', partial: false, stopReason: 'max_chars' });
  const response = await handleBrowserExtractTweets({ maxChars: 2 });
  expect(response.content[0].text).toContain('maxChars is too small');
  expect(response.content[0].text).not.toContain('No tweets');
});
