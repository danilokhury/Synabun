import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, existsSync, unlinkSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  runHook,
  testSessionId,
  readFlagFile,
  cleanupFlagFile,
} from '../utils/hook-runner.js';

const DATA_DIR = resolve(__dirname, '../../data');
const PENDING_REMEMBER_DIR = join(DATA_DIR, 'pending-remember');
const PENDING_COMPACT_DIR = join(DATA_DIR, 'pending-compact');

// Track created files for cleanup
const createdFiles: string[] = [];

afterEach(() => {
  for (const f of createdFiles) {
    try { if (existsSync(f)) unlinkSync(f); } catch { /* ok */ }
  }
  createdFiles.length = 0;
});

describe('post-remember hook (PostToolUse)', () => {
  it('Edit tool increments editCount in flag file', async () => {
    const sessionId = testSessionId();

    const result = await runHook('post-remember.mjs', {
      session_id: sessionId,
      tool_name: 'Edit',
      tool_input: { file_path: 'src/auth.ts' },
      tool_response: {},
      cwd: '/tmp/test-project',
    });

    expect(result.exitCode).toBe(0);

    // Check flag file was created with editCount 1
    const flagPath = join(PENDING_REMEMBER_DIR, `${sessionId}.json`);
    createdFiles.push(flagPath);
    expect(existsSync(flagPath)).toBe(true);
    const flag = JSON.parse(readFileSync(flagPath, 'utf-8'));
    expect(flag.editCount).toBe(1);

    // Run again to verify increment
    await runHook('post-remember.mjs', {
      session_id: sessionId,
      tool_name: 'Edit',
      tool_input: { file_path: 'src/login.ts' },
      tool_response: {},
      cwd: '/tmp/test-project',
    });

    const flag2 = JSON.parse(readFileSync(flagPath, 'utf-8'));
    expect(flag2.editCount).toBe(2);
    expect(flag2.files).toContain('src/auth.ts');
    expect(flag2.files).toContain('src/login.ts');
  });

  it('remember tool with non-conversations category resets editCount to 0', async () => {
    const sessionId = testSessionId();

    // Pre-populate a flag with some edits
    const flagPath = join(PENDING_REMEMBER_DIR, `${sessionId}.json`);
    if (!existsSync(PENDING_REMEMBER_DIR)) mkdirSync(PENDING_REMEMBER_DIR, { recursive: true });
    writeFileSync(flagPath, JSON.stringify({
      editCount: 5,
      retries: 0,
      files: ['src/auth.ts', 'src/login.ts'],
      totalEdits: 5,
      rememberCount: 0,
    }));
    createdFiles.push(flagPath);

    const result = await runHook('post-remember.mjs', {
      session_id: sessionId,
      tool_name: 'mcp__SynaBun__remember',
      tool_input: { category: 'architecture', content: 'Some fix' },
      tool_response: {},
      cwd: '/tmp/test-project',
    });

    expect(result.exitCode).toBe(0);
    const flag = JSON.parse(readFileSync(flagPath, 'utf-8'));
    expect(flag.editCount).toBe(0);
    expect(flag.rememberCount).toBe(1);
  });

  it('remember with "conversations" category deletes pending-compact flag', async () => {
    const sessionId = testSessionId();

    // Pre-populate pending-compact flag
    if (!existsSync(PENDING_COMPACT_DIR)) mkdirSync(PENDING_COMPACT_DIR, { recursive: true });
    const compactFlagPath = join(PENDING_COMPACT_DIR, `${sessionId}.json`);
    writeFileSync(compactFlagPath, JSON.stringify({
      session_id: sessionId,
      created_at: new Date().toISOString(),
      retries: 0,
    }));
    createdFiles.push(compactFlagPath);

    // Also create a pending-remember flag
    const rememberFlagPath = join(PENDING_REMEMBER_DIR, `${sessionId}.json`);
    if (!existsSync(PENDING_REMEMBER_DIR)) mkdirSync(PENDING_REMEMBER_DIR, { recursive: true });
    writeFileSync(rememberFlagPath, JSON.stringify({
      editCount: 0,
      retries: 0,
      files: [],
      rememberCount: 0,
      messageCount: 3,
    }));
    createdFiles.push(rememberFlagPath);

    const result = await runHook('post-remember.mjs', {
      session_id: sessionId,
      tool_name: 'mcp__SynaBun__remember',
      tool_input: { category: 'conversations', content: 'Session log' },
      tool_response: {},
      cwd: '/tmp/test-project',
    });

    expect(result.exitCode).toBe(0);
    // Pending-compact flag should be deleted
    expect(existsSync(compactFlagPath)).toBe(false);
  });

  it('no session_id returns empty output', async () => {
    const result = await runHook('post-remember.mjs', {
      tool_name: 'Edit',
      tool_input: { file_path: 'src/auth.ts' },
      tool_response: {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.parsed).toEqual({});
  });
});
