import { describe, it, expect } from 'vitest';
import {
  runHook,
  testSessionId,
  isBlocked,
} from '../utils/hook-runner.js';

// Force NI to be unreachable by pointing to a non-existent URL.
// The real NI at localhost:3344 may be running during tests, and if an
// active loop with usesBrowser=true exists in data/loop/, the hook would
// block. By overriding SYNABUN_NI_URL, we ensure the "NI unreachable"
// code path is exercised.
const NI_OVERRIDE_ENV = { SYNABUN_NI_URL: 'http://127.0.0.1:19999' };

describe('pre-websearch hook', () => {
  it('NI unreachable returns empty output {} (allows WebSearch)', async () => {
    const sessionId = testSessionId();
    const result = await runHook('pre-websearch.mjs', {
      session_id: sessionId,
      tool_name: 'WebSearch',
      tool_input: { query: 'vitest documentation' },
    }, NI_OVERRIDE_ENV);

    expect(result.exitCode).toBe(0);
    expect(isBlocked(result)).toBe(false);
    expect(result.parsed).toEqual({});
  });

  it('tool_name WebFetch also allowed when NI is unreachable', async () => {
    const sessionId = testSessionId();
    const result = await runHook('pre-websearch.mjs', {
      session_id: sessionId,
      tool_name: 'WebFetch',
      tool_input: { url: 'https://example.com' },
    }, NI_OVERRIDE_ENV);

    expect(result.exitCode).toBe(0);
    expect(isBlocked(result)).toBe(false);
    expect(result.parsed).toEqual({});
  });
});
