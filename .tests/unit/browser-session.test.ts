import { describe, it, expect } from 'vitest';
import { setNiState, setNiError } from '../mocks/neural-interface.mock.js';
import { handleBrowserSession } from '@mcp/tools/browser-advanced.js';

describe('browser_session', () => {
  // ── list ──

  describe('list', () => {
    it('returns empty message when no sessions open', async () => {
      setNiState({ sessions: [] });
      const res = await handleBrowserSession({ action: 'list' });
      expect(res.content[0].text).toBe('No browser sessions open.');
    });

    it('shows session count and IDs when sessions present', async () => {
      // Default state has 1 session: test-session-1
      const res = await handleBrowserSession({ action: 'list' });
      expect(res.content[0].text).toContain('1 session(s)');
      expect(res.content[0].text).toContain('test-session-1');
    });

    it('forwards NI error on list failure', async () => {
      setNiError('Connection refused');
      const res = await handleBrowserSession({ action: 'list' });
      expect(res.content[0].text).toBe('List failed: Connection refused');
    });
  });

  // ── create ──

  describe('create', () => {
    it('creates a session successfully', async () => {
      const res = await handleBrowserSession({ action: 'create', url: 'https://google.com' });
      expect(res.content[0].text).toContain('Created session');
      expect(res.content[0].text).toContain('https://google.com');
    });

    it('creates with about:blank when no url provided', async () => {
      const res = await handleBrowserSession({ action: 'create' });
      expect(res.content[0].text).toContain('about:blank');
    });

    it('forwards NI error on create failure', async () => {
      setNiError('Browser launch failed');
      const res = await handleBrowserSession({ action: 'create' });
      expect(res.content[0].text).toBe('Create failed: Browser launch failed');
    });
  });

  // ── close ──

  describe('close', () => {
    it('closes a session successfully', async () => {
      const res = await handleBrowserSession({ action: 'close' });
      expect(res.content[0].text).toContain('Closed session');
      expect(res.content[0].text).toContain('test-session-1');
    });

    it('forwards resolveSession error when no sessions', async () => {
      setNiState({ sessions: [] });
      const res = await handleBrowserSession({ action: 'close' });
      expect(res.content[0].text).toContain('No browser sessions open');
    });

    it('forwards NI error on close failure', async () => {
      setNiError('Timeout closing session');
      const res = await handleBrowserSession({ action: 'close' });
      // resolveSession itself errors first
      expect(res.content[0].text).toContain('Timeout closing session');
    });
  });

  // ── unknown action ──

  it('returns error for unknown action', async () => {
    const res = await handleBrowserSession({ action: 'restart' });
    expect(res.content[0].text).toContain('Unknown action "restart"');
  });
});
