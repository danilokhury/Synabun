import { describe, it, expect, vi } from 'vitest';
import { setNiError } from '../mocks/neural-interface.mock.js';
import * as ni from '../../mcp-server/src/services/neural-interface.js';
import { handleBrowserEvaluate, handleBrowserWait } from '@mcp/tools/browser-advanced.js';

describe('browser_evaluate', () => {
  it('returns numeric result as string', async () => {
    // Default mock returns { result: 42 }
    const res = await handleBrowserEvaluate({ script: 'return 1 + 1' });
    expect(res.content[0].text).toBe('42');
  });

  it('returns string result as-is', async () => {
    vi.mocked(ni.evaluate).mockResolvedValueOnce({ result: 'hello string' });
    const res = await handleBrowserEvaluate({ script: 'return "hello string"' });
    expect(res.content[0].text).toBe('hello string');
  });

  it('returns "null" for undefined result', async () => {
    vi.mocked(ni.evaluate).mockResolvedValueOnce({ result: undefined });
    const res = await handleBrowserEvaluate({ script: 'void 0' });
    expect(res.content[0].text).toBe('null');
  });

  it('forwards NI error on evaluate failure', async () => {
    setNiError('Script threw an exception');
    const res = await handleBrowserEvaluate({ script: 'throw new Error()' });
    // resolveSession errors first
    expect(res.content[0].text).toContain('Script threw an exception');
  });
});

describe('browser_wait', () => {
  it('waits for loadState and reports page state', async () => {
    const res = await handleBrowserWait({ loadState: 'networkidle' });
    expect(res.content[0].text).toContain('Page reached "networkidle"');
    expect(res.content[0].text).toContain('https://example.com');
  });

  it('waits for selector and reports visibility', async () => {
    const res = await handleBrowserWait({ selector: '.modal' });
    expect(res.content[0].text).toContain('".modal" is now');
    expect(res.content[0].text).toContain('visible');
  });

  it('waits for timeout when no selector or loadState', async () => {
    const res = await handleBrowserWait({ timeout: 2000 });
    expect(res.content[0].text).toContain('Waited 2000ms');
  });

  it('uses default 1000ms when no timeout specified', async () => {
    const res = await handleBrowserWait({});
    expect(res.content[0].text).toContain('Waited 1000ms');
  });

  it('forwards NI error on wait failure', async () => {
    setNiError('Timeout waiting for element');
    const res = await handleBrowserWait({ selector: '.slow-element' });
    expect(res.content[0].text).toContain('Timeout waiting for element');
  });
});
