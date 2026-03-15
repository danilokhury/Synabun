import { describe, it, expect, vi } from 'vitest';
import { setNiError } from '../mocks/neural-interface.mock.js';
import * as ni from '../../mcp-server/src/services/neural-interface.js';
import {
  handleBrowserSnapshot,
  handleBrowserContent,
  handleBrowserScreenshot,
  handleBrowserExtractTweets,
  handleBrowserExtractFbPosts,
} from '@mcp/tools/browser-observe.js';

describe('browser_snapshot', () => {
  it('returns formatted accessibility tree on success', async () => {
    const res = await handleBrowserSnapshot({});
    const text = res.content[0].text;
    expect(text).toContain('Page:');
    expect(text).toContain('Title:');
    expect(text).toContain('document');
    expect(text).toContain('button');
  });

  it('includes scope when selector is provided', async () => {
    const res = await handleBrowserSnapshot({ selector: '[data-testid="primaryColumn"]' });
    expect(res.content[0].text).toContain('Scope: [data-testid="primaryColumn"]');
  });

  it('forwards NI error on snapshot failure', async () => {
    setNiError('Page crashed during snapshot');
    const res = await handleBrowserSnapshot({});
    // resolveSession errors first, returning the raw error (no "Snapshot failed:" prefix)
    expect(res.content[0].text).toContain('Page crashed during snapshot');
  });
});

describe('browser_content', () => {
  it('returns page text content on success', async () => {
    const res = await handleBrowserContent({});
    const text = res.content[0].text;
    expect(text).toContain('URL:');
    expect(text).toContain('Title:');
    expect(text).toContain('Page content here');
  });

  it('forwards NI error on content failure', async () => {
    setNiError('Content extraction timeout');
    const res = await handleBrowserContent({});
    // resolveSession errors first, returning the raw error
    expect(res.content[0].text).toContain('Content extraction timeout');
  });
});

describe('browser_screenshot', () => {
  it('returns text and image content blocks on success', async () => {
    const res = await handleBrowserScreenshot({});
    expect(res.content).toHaveLength(2);
    expect(res.content[0].type).toBe('text');
    expect(res.content[0].text).toContain('Screenshot of');
    expect(res.content[1].type).toBe('image');
    expect((res.content[1] as { data: string }).data).toBe('base64imagedata');
  });

  it('returns text-only error on NI failure', async () => {
    setNiError('Screenshot capture failed');
    const res = await handleBrowserScreenshot({});
    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe('text');
    // resolveSession errors first, returning the raw error
    expect(res.content[0].text).toContain('Screenshot capture failed');
  });
});

describe('browser_extract_tweets', () => {
  it('extracts tweets when evaluate returns data', async () => {
    vi.mocked(ni.evaluate).mockResolvedValueOnce({
      result: [
        { author: 'TestUser', handle: '@test', text: 'Hello', time: null, url: null, replies: '0', reposts: '0', likes: '1', views: '10' },
        { author: 'User2', handle: '@user2', text: 'World', time: null, url: null, replies: '5', reposts: '2', likes: '3', views: '50' },
      ],
    });

    const res = await handleBrowserExtractTweets({});
    expect(res.content[0].text).toContain('2 tweet(s):');
    expect(res.content[0].text).toContain('TestUser');
    expect(res.content[0].text).toContain('@test');
  });

  it('returns empty message when no tweets found', async () => {
    vi.mocked(ni.evaluate).mockResolvedValueOnce({ result: [] });

    const res = await handleBrowserExtractTweets({});
    expect(res.content[0].text).toContain('No tweets found');
  });

  it('forwards NI error on extract failure', async () => {
    setNiError('JavaScript evaluation failed');
    const res = await handleBrowserExtractTweets({});
    // resolveSession errors first when shouldError is global
    expect(res.content[0].text).toContain('JavaScript evaluation failed');
  });
});

describe('browser_extract_fb_posts', () => {
  it('extracts Facebook posts when evaluate returns data', async () => {
    vi.mocked(ni.evaluate).mockResolvedValueOnce({
      result: [
        { author: 'John Doe', authorUrl: 'https://fb.com/john', text: 'Great post!', time: '2h', postUrl: null, reactions: '15 likes' },
      ],
    });

    const res = await handleBrowserExtractFbPosts({});
    expect(res.content[0].text).toContain('1 post(s):');
    expect(res.content[0].text).toContain('John Doe');
    expect(res.content[0].text).toContain('Great post!');
  });

  it('returns empty message when no posts found', async () => {
    vi.mocked(ni.evaluate).mockResolvedValueOnce({ result: [] });

    const res = await handleBrowserExtractFbPosts({});
    expect(res.content[0].text).toContain('No posts found');
  });

  it('forwards NI error on extract failure', async () => {
    setNiError('Evaluate timeout');
    const res = await handleBrowserExtractFbPosts({});
    expect(res.content[0].text).toContain('Evaluate timeout');
  });
});
