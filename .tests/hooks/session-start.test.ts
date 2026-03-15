import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, existsSync, unlinkSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  runHook,
  testSessionId,
  getAdditionalContext,
} from '../utils/hook-runner.js';

const DATA_DIR = resolve(__dirname, '../../data');
const LOOP_DIR = join(DATA_DIR, 'loop');

// Track files created during tests
const createdFiles: string[] = [];

afterEach(() => {
  // Only clean up files this test file created — do NOT use cleanupTestFlags()
  // as it deletes all test-sess-* files, including those from parallel test files.
  for (const f of createdFiles) {
    try { if (existsSync(f)) unlinkSync(f); } catch { /* ok */ }
  }
  createdFiles.length = 0;
});

describe('session-start hook', () => {
  it('normal session output contains "Session Boot Sequence" and "recall ONCE"', async () => {
    const sessionId = testSessionId();
    const result = await runHook('session-start.mjs', {
      session_id: sessionId,
      cwd: '/tmp/test-project',
      source: 'new',
    });

    expect(result.exitCode).toBe(0);
    const context = getAdditionalContext(result);
    expect(context).toContain('Session Boot Sequence');
    expect(context).toContain('recall');
    expect(context).toMatch(/ONCE|once|1\./);
  });

  it('compact source contains compaction recovery text', async () => {
    const sessionId = testSessionId();

    // Write a precompact cache file for this session
    const precompactDir = join(DATA_DIR, 'precompact');
    if (!existsSync(precompactDir)) mkdirSync(precompactDir, { recursive: true });
    const cachePath = join(precompactDir, `${sessionId}.json`);
    writeFileSync(cachePath, JSON.stringify({
      session_id: sessionId,
      transcript_path: '/tmp/transcript.jsonl',
      trigger: 'auto',
      cwd: '/tmp/test-project',
      user_message_count: 5,
      total_turns: 10,
      user_messages: ['Fix the auth bug', 'Check the tests'],
      assistant_snippets: ['Looking at the code'],
      tools_used: ['Read', 'Edit'],
      files_modified: ['src/auth.ts'],
    }));
    createdFiles.push(cachePath);

    const result = await runHook('session-start.mjs', {
      session_id: sessionId,
      cwd: '/tmp/test-project',
      source: 'compact',
      transcript_path: '/tmp/transcript.jsonl',
    });

    expect(result.exitCode).toBe(0);
    const context = getAdditionalContext(result);
    expect(context).toContain('COMPACTION');
  });

  it('empty stdin produces valid output with exit code 0', async () => {
    const result = await runHook('session-start.mjs', {});

    expect(result.exitCode).toBe(0);
    // Should still produce valid JSON output
    expect(result.stdout.length).toBeGreaterThan(0);
    const context = getAdditionalContext(result);
    expect(typeof context).toBe('string');
  });

  it('loop session contains "autonomous loop" and NO greeting directive', async () => {
    const sessionId = testSessionId();

    // Write a pending loop file (fresh, not stale)
    if (!existsSync(LOOP_DIR)) mkdirSync(LOOP_DIR, { recursive: true });
    const pendingPath = join(LOOP_DIR, `pending-${sessionId}.json`);
    writeFileSync(pendingPath, JSON.stringify({
      active: true,
      task: 'Run automated checks',
      totalIterations: 5,
      currentIteration: 0,
      maxMinutes: 30,
      startedAt: new Date().toISOString(),
      pending: true,
    }));
    createdFiles.push(pendingPath);

    const result = await runHook('session-start.mjs', {
      session_id: sessionId,
      cwd: '/tmp/test-project',
      source: 'new',
    });

    expect(result.exitCode).toBe(0);
    const context = getAdditionalContext(result);
    expect(context).toContain('autonomous loop');
    // Should NOT contain a greeting directive
    expect(context).not.toContain('GREETING DIRECTIVE');
  });
});
