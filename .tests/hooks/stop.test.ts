import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, existsSync, unlinkSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  runHook,
  testSessionId,
  writeFlagFile,
  cleanupFlagFile,
  isBlocked,
  getBlockReason,
} from '../utils/hook-runner.js';

const DATA_DIR = resolve(__dirname, '../../data');
const PENDING_COMPACT_DIR = join(DATA_DIR, 'pending-compact');
const PENDING_REMEMBER_DIR = join(DATA_DIR, 'pending-remember');
const LOOP_DIR = join(DATA_DIR, 'loop');

// Track created files for cleanup
const createdFiles: string[] = [];

afterEach(() => {
  for (const f of createdFiles) {
    try { if (existsSync(f)) unlinkSync(f); } catch { /* ok */ }
  }
  createdFiles.length = 0;
});

describe('stop hook', () => {
  it('no flags returns empty output {}', async () => {
    const sessionId = testSessionId();
    const result = await runHook('stop.mjs', {
      session_id: sessionId,
      cwd: '/tmp/test-project',
    });

    expect(result.exitCode).toBe(0);
    expect(isBlocked(result)).toBe(false);
  });

  it('pending-compact flag triggers block decision', async () => {
    const sessionId = testSessionId();

    // Write pending-compact flag
    const flagPath = join(PENDING_COMPACT_DIR, `${sessionId}.json`);
    if (!existsSync(PENDING_COMPACT_DIR)) mkdirSync(PENDING_COMPACT_DIR, { recursive: true });
    writeFileSync(flagPath, JSON.stringify({
      session_id: sessionId,
      created_at: new Date().toISOString(),
      retries: 0,
    }));
    createdFiles.push(flagPath);

    const result = await runHook('stop.mjs', {
      session_id: sessionId,
      cwd: '/tmp/test-project',
    });

    expect(result.exitCode).toBe(0);
    expect(isBlocked(result)).toBe(true);
    expect(getBlockReason(result)).toContain('compacted');
  });

  it('pending-compact at retries=3 deletes flag and returns empty output', async () => {
    const sessionId = testSessionId();

    // Write pending-compact flag with retries at max
    const flagPath = join(PENDING_COMPACT_DIR, `${sessionId}.json`);
    if (!existsSync(PENDING_COMPACT_DIR)) mkdirSync(PENDING_COMPACT_DIR, { recursive: true });
    writeFileSync(flagPath, JSON.stringify({
      session_id: sessionId,
      created_at: new Date().toISOString(),
      retries: 3,
    }));
    createdFiles.push(flagPath);

    const result = await runHook('stop.mjs', {
      session_id: sessionId,
      cwd: '/tmp/test-project',
    });

    expect(result.exitCode).toBe(0);
    expect(isBlocked(result)).toBe(false);
    // Flag should be deleted
    expect(existsSync(flagPath)).toBe(false);
  });

  it('active loop file allows stop and sets awaitingNext for server driver', async () => {
    const sessionId = testSessionId();

    // Write an active loop file
    const loopPath = join(LOOP_DIR, `${sessionId}.json`);
    if (!existsSync(LOOP_DIR)) mkdirSync(LOOP_DIR, { recursive: true });
    writeFileSync(loopPath, JSON.stringify({
      active: true,
      task: 'Automated testing',
      totalIterations: 10,
      currentIteration: 2,
      maxMinutes: 30,
      startedAt: new Date().toISOString(),
      lastIterationAt: null,
      retries: 0,
    }));
    createdFiles.push(loopPath);

    const result = await runHook('stop.mjs', {
      session_id: sessionId,
      cwd: '/tmp/test-project',
    });

    expect(result.exitCode).toBe(0);
    // Fresh-context model: stop hook allows stop (no block)
    // Server loop driver handles /clear + next iteration
    expect(isBlocked(result)).toBe(false);

    // Verify state file updated with awaitingNext
    const state = JSON.parse(readFileSync(loopPath, 'utf-8'));
    expect(state.currentIteration).toBe(3);
    expect(state.awaitingNext).toBe(true);
  });

  it('pending-remember with editCount >= 3 triggers block', async () => {
    const sessionId = testSessionId();

    // Write pending-remember flag with enough edits
    const flagPath = join(PENDING_REMEMBER_DIR, `${sessionId}.json`);
    if (!existsSync(PENDING_REMEMBER_DIR)) mkdirSync(PENDING_REMEMBER_DIR, { recursive: true });
    writeFileSync(flagPath, JSON.stringify({
      editCount: 5,
      retries: 0,
      files: ['src/auth.ts', 'src/login.ts', 'src/utils.ts'],
      totalEdits: 5,
    }));
    createdFiles.push(flagPath);

    const result = await runHook('stop.mjs', {
      session_id: sessionId,
      cwd: '/tmp/test-project',
    });

    expect(result.exitCode).toBe(0);
    expect(isBlocked(result)).toBe(true);
    const reason = getBlockReason(result);
    expect(reason).toContain('edits');
    expect(reason).toContain('memory');
  });

  it('no session_id returns empty output', async () => {
    const result = await runHook('stop.mjs', {
      cwd: '/tmp/test-project',
    });

    expect(result.exitCode).toBe(0);
    expect(isBlocked(result)).toBe(false);
  });
});
