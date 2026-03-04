/**
 * Integration test: Edit tracking → Stop enforcement → Remember clears flag
 *
 * Full flow:
 * 1. Fire post-remember.mjs 3x with Edit tool_name → editCount reaches 3
 * 2. Fire stop.mjs → blocked (pending-remember enforcement)
 * 3. Fire post-remember.mjs with remember tool_name → editCount reset
 * 4. Fire stop.mjs → allowed (no block)
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  runHook,
  testSessionId,
  readFlagFile,
  cleanupFlagFile,
  isBlocked,
} from '../utils/hook-runner.js';

describe('integration: remember enforcement', () => {
  let sessionId: string;

  afterEach(() => {
    cleanupFlagFile('pending-remember', `${sessionId}.json`);
    cleanupFlagFile('pending-compact', `${sessionId}.json`);
  });

  it('blocks after 3 edits, clears after remember', async () => {
    sessionId = testSessionId();

    // Step 1: Simulate 3 Edit tool calls via post-remember hook
    for (let i = 0; i < 3; i++) {
      await runHook('post-remember.mjs', {
        session_id: sessionId,
        tool_name: 'Edit',
        tool_input: { file_path: `/src/file${i}.ts`, old_string: 'a', new_string: 'b' },
        cwd: '/tmp/test-project',
      });
    }

    // Verify flag file has editCount >= 3
    const flag = readFlagFile('pending-remember', `${sessionId}.json`);
    expect(flag).toBeTruthy();
    expect((flag as Record<string, unknown>).editCount).toBeGreaterThanOrEqual(3);

    // Step 2: Fire stop.mjs → should block
    const stopResult1 = await runHook('stop.mjs', {
      session_id: sessionId,
      last_assistant_message: 'I fixed the bug.',
    });
    expect(isBlocked(stopResult1)).toBe(true);

    // Step 3: Fire post-remember with a remember tool call (non-conversations)
    await runHook('post-remember.mjs', {
      session_id: sessionId,
      tool_name: 'mcp__SynaBun__remember',
      tool_input: { content: 'Fixed the auth bug', category: 'bug-fixes' },
      cwd: '/tmp/test-project',
    });

    // Verify editCount was reset
    const flagAfter = readFlagFile('pending-remember', `${sessionId}.json`);
    if (flagAfter) {
      expect((flagAfter as Record<string, unknown>).editCount).toBe(0);
    }

    // Step 4: Fire stop.mjs → should NOT block
    const stopResult2 = await runHook('stop.mjs', {
      session_id: sessionId,
      last_assistant_message: 'Done.',
    });
    expect(isBlocked(stopResult2)).toBe(false);
  });
});
