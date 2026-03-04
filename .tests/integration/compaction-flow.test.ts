/**
 * Integration test: Compaction flow
 *
 * Full flow:
 * 1. Write synthetic transcript → fire pre-compact.mjs → cache + pending flag
 * 2. Fire stop.mjs → blocked (pending compact)
 * 3. Fire post-remember.mjs with category: 'conversations' → flag cleared
 * 4. Fire stop.mjs → no longer blocked
 * 5. Fire session-start.mjs with source: 'compact' → cached data in output
 */
import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  runHook,
  testSessionId,
  readFlagFile,
  cleanupFlagFile,
  flagFileExists,
  isBlocked,
  getAdditionalContext,
} from '../utils/hook-runner.js';

const DATA_DIR = resolve(__dirname, '../../data');

describe('integration: compaction flow', () => {
  const sessionId = testSessionId();
  const transcriptDir = join(DATA_DIR, 'test-transcripts');
  const transcriptPath = join(transcriptDir, `${sessionId}.jsonl`);

  afterEach(() => {
    cleanupFlagFile('pending-compact', `${sessionId}.json`);
    cleanupFlagFile('pending-remember', `${sessionId}.json`);
    cleanupFlagFile('precompact', `${sessionId}.json`);
  });

  afterAll(() => {
    try { unlinkSync(transcriptPath); } catch { /* ok */ }
    try { rmSync(transcriptDir, { recursive: true }); } catch { /* ok */ }
  });

  it('completes full compaction flow: precompact → stop blocks → remember clears → start loads cache', async () => {
    // Step 1: Create synthetic transcript
    mkdirSync(transcriptDir, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'human', content: [{ type: 'text', text: 'Fix the authentication bug in login.ts' }] }),
      JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: 'Let me look at the code.' }] }),
      JSON.stringify({ type: 'human', content: [{ type: 'text', text: 'Also check the session handler' }] }),
      JSON.stringify({
        type: 'assistant',
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: '/src/login.ts' } },
          { type: 'text', text: 'I fixed the bug.' },
        ],
      }),
    ];
    writeFileSync(transcriptPath, lines.join('\n'));

    // Fire pre-compact hook
    const preCompactResult = await runHook('pre-compact.mjs', {
      session_id: sessionId,
      transcript_path: transcriptPath,
      trigger: 'auto',
      cwd: '/tmp/test-project',
    });

    expect(preCompactResult.exitCode).toBe(0);

    // Verify precompact cache and pending-compact flag were written
    expect(flagFileExists('precompact', `${sessionId}.json`)).toBe(true);
    expect(flagFileExists('pending-compact', `${sessionId}.json`)).toBe(true);

    const cache = readFlagFile('precompact', `${sessionId}.json`);
    expect(cache).toBeTruthy();
    expect(cache!.session_id).toBe(sessionId);

    // Step 2: Fire stop.mjs → should block (pending compact)
    const stopResult1 = await runHook('stop.mjs', {
      session_id: sessionId,
      last_assistant_message: 'Done fixing.',
    });
    expect(isBlocked(stopResult1)).toBe(true);

    // Step 3: Fire post-remember with category: 'conversations' → clears pending-compact
    await runHook('post-remember.mjs', {
      session_id: sessionId,
      tool_name: 'mcp__SynaBun__remember',
      tool_input: { content: 'Session summary', category: 'conversations' },
      cwd: '/tmp/test-project',
    });

    // Verify pending-compact flag was cleared
    expect(flagFileExists('pending-compact', `${sessionId}.json`)).toBe(false);

    // Step 4: Fire stop.mjs → should NOT block (compact flag cleared)
    const stopResult2 = await runHook('stop.mjs', {
      session_id: sessionId,
      last_assistant_message: 'All done.',
    });
    expect(isBlocked(stopResult2)).toBe(false);

    // Step 5: Fire session-start with source='compact' → should load precompact cache
    const startResult = await runHook('session-start.mjs', {
      cwd: '/tmp/test-project',
      source: 'compact',
      session_id: sessionId,
    });

    expect(startResult.exitCode).toBe(0);
    const context = getAdditionalContext(startResult);
    // Should contain compaction recovery context with the cached data
    expect(context.length).toBeGreaterThan(0);
  });
});
