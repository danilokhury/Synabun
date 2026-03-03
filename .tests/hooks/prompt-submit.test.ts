import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  runHook,
  testSessionId,
  getAdditionalContext,
} from '../utils/hook-runner.js';

const DATA_DIR = resolve(__dirname, '../../data');
const PENDING_REMEMBER_DIR = join(DATA_DIR, 'pending-remember');

// Track created files for cleanup
const createdFiles: string[] = [];

/**
 * Pre-populate the pending-remember flag file to simulate a session that has
 * already seen its first message (greeting already delivered). Without this,
 * the hook's first-message greeting reinforcement fires and overrides any
 * tier-based context analysis.
 */
function prepopulateFlag(sessionId: string): void {
  if (!existsSync(PENDING_REMEMBER_DIR)) mkdirSync(PENDING_REMEMBER_DIR, { recursive: true });
  const flagPath = join(PENDING_REMEMBER_DIR, `${sessionId}.json`);
  writeFileSync(flagPath, JSON.stringify({
    editCount: 0,
    retries: 0,
    files: [],
    messageCount: 2,
    totalSessionMessages: 2,
    greetingDelivered: true,
    firstMessageAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
  }));
  createdFiles.push(flagPath);
}

afterEach(() => {
  // Only clean up files this test file created — do NOT use cleanupTestFlags()
  // as it deletes all test-sess-* files, including those from parallel test files.
  for (const f of createdFiles) {
    try { if (existsSync(f)) unlinkSync(f); } catch { /* ok */ }
  }
  createdFiles.length = 0;
});

describe('prompt-submit hook', () => {
  it('trivial message ("yes") returns empty output {}', async () => {
    const sessionId = testSessionId();
    prepopulateFlag(sessionId);

    const result = await runHook('prompt-submit.mjs', {
      prompt: 'yes',
      session_id: sessionId,
    });

    expect(result.exitCode).toBe(0);
    // Should be empty or contain only boot cancel (not greeting)
    const context = getAdditionalContext(result);
    // "yes" matches SKIP_PATTERNS → empty output
    expect(result.parsed).toEqual({});
  });

  it('slash command ("/help") returns empty output {}', async () => {
    const sessionId = testSessionId();
    prepopulateFlag(sessionId);

    const result = await runHook('prompt-submit.mjs', {
      prompt: '/help',
      session_id: sessionId,
    });

    expect(result.exitCode).toBe(0);
    // "/help" matches SKIP_PATTERNS → empty output
    expect(result.parsed).toEqual({});
  });

  it('Tier 1 trigger ("we decided on this approach") contains recall context', async () => {
    const sessionId = testSessionId();
    prepopulateFlag(sessionId);

    const result = await runHook('prompt-submit.mjs', {
      prompt: 'we decided on this approach for the caching layer, what was the reason again?',
      session_id: sessionId,
    });

    expect(result.exitCode).toBe(0);
    const context = getAdditionalContext(result);
    expect(context).toContain('recall');
  });

  it('Tier 2 trigger ("debug the redis error") contains recall context', async () => {
    const sessionId = testSessionId();
    prepopulateFlag(sessionId);

    const result = await runHook('prompt-submit.mjs', {
      prompt: 'debug the redis error that keeps showing up in the logs',
      session_id: sessionId,
    });

    expect(result.exitCode).toBe(0);
    const context = getAdditionalContext(result);
    expect(context).toContain('recall');
  });

  it('short message (<8 chars "hi") returns empty output {}', async () => {
    const sessionId = testSessionId();
    prepopulateFlag(sessionId);

    const result = await runHook('prompt-submit.mjs', {
      prompt: 'hi',
      session_id: sessionId,
    });

    expect(result.exitCode).toBe(0);
    // "hi" is < 8 chars → matches SKIP_PATTERNS → empty output
    expect(result.parsed).toEqual({});
  });
});
