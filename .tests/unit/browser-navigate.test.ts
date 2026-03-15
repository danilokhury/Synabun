import { describe, it, expect } from 'vitest';
import { setNiState, setNiError } from '../mocks/neural-interface.mock.js';
import { handleBrowserNavigate, handleBrowserGoBack, handleBrowserGoForward, handleBrowserReload } from '@mcp/tools/browser-navigate.js';

describe('browser_navigate', () => {
  it('navigates to a URL successfully', async () => {
    const res = await handleBrowserNavigate({ url: 'https://google.com' });
    expect(res.content[0].text).toContain('Navigated to');
    expect(res.content[0].text).toContain('https://google.com');
  });

  it('forwards NI error on navigation failure', async () => {
    setNiError('DNS resolution failed');
    const res = await handleBrowserNavigate({ url: 'https://invalid.test' });
    // resolveSession errors first when shouldError is true
    expect(res.content[0].text).toContain('DNS resolution failed');
  });

  it('returns resolveSession error when no sessions and no auto-create', async () => {
    setNiState({ sessions: [] });
    // resolveSession with { url } still returns error in mock (no auto-create logic in mock)
    const res = await handleBrowserNavigate({ url: 'https://example.com' });
    expect(res.content[0].text).toContain('No browser sessions open');
  });
});

describe('browser_go_back', () => {
  it('goes back successfully', async () => {
    const res = await handleBrowserGoBack({});
    expect(res.content[0].text).toContain('Went back to');
    expect(res.content[0].text).toContain('https://prev.example.com');
  });

  it('forwards NI error on go back failure', async () => {
    setNiError('No history');
    const res = await handleBrowserGoBack({});
    expect(res.content[0].text).toContain('No history');
  });

  it('forwards resolveSession error when no sessions', async () => {
    setNiState({ sessions: [] });
    const res = await handleBrowserGoBack({});
    expect(res.content[0].text).toContain('No browser sessions open');
  });
});

describe('browser_go_forward', () => {
  it('goes forward successfully', async () => {
    const res = await handleBrowserGoForward({});
    expect(res.content[0].text).toContain('Went forward to');
    expect(res.content[0].text).toContain('https://next.example.com');
  });

  it('forwards NI error on go forward failure', async () => {
    setNiError('No forward history');
    const res = await handleBrowserGoForward({});
    expect(res.content[0].text).toContain('No forward history');
  });
});

describe('browser_reload', () => {
  it('reloads the page successfully', async () => {
    const res = await handleBrowserReload({});
    expect(res.content[0].text).toContain('Reloaded');
    expect(res.content[0].text).toContain('https://example.com');
  });

  it('forwards NI error on reload failure', async () => {
    setNiError('Page crashed');
    const res = await handleBrowserReload({});
    expect(res.content[0].text).toContain('Page crashed');
  });
});
