import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  runHook,
  testSessionId,
  flagFileExists,
  readFlagFile,
  cleanupFlagFile,
} from '../utils/hook-runner.js';

const DATA_DIR = resolve(__dirname, '../../data');
const PRECOMPACT_DIR = join(DATA_DIR, 'precompact');
const PENDING_COMPACT_DIR = join(DATA_DIR, 'pending-compact');

// Track created files for cleanup
const createdFiles: string[] = [];

afterEach(() => {
  for (const f of createdFiles) {
    try { if (existsSync(f)) unlinkSync(f); } catch { /* ok */ }
  }
  createdFiles.length = 0;
});

describe('pre-compact hook', () => {
  it('valid input with synthetic transcript writes precompact cache and pending-compact files', async () => {
    const sessionId = testSessionId();

    // Create a synthetic transcript file
    const transcriptDir = join(DATA_DIR, 'test-transcripts');
    if (!existsSync(transcriptDir)) mkdirSync(transcriptDir, { recursive: true });
    const transcriptPath = join(transcriptDir, `${sessionId}.jsonl`);

    const transcriptLines = [
      JSON.stringify({
        role: 'user',
        content: [{ type: 'text', text: 'Fix the bug in auth' }],
      }),
      JSON.stringify({
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me look at the code' },
          { type: 'tool_use', name: 'Read', input: { file_path: 'src/auth.ts' } },
        ],
      }),
      JSON.stringify({
        role: 'user',
        content: [{ type: 'text', text: 'Now apply the fix to the login handler' }],
      }),
      JSON.stringify({
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will update the login handler.' },
          { type: 'tool_use', name: 'Edit', input: { file_path: 'src/login.ts' } },
        ],
      }),
    ];

    writeFileSync(transcriptPath, transcriptLines.join('\n'));
    createdFiles.push(transcriptPath);

    const result = await runHook('pre-compact.mjs', {
      session_id: sessionId,
      transcript_path: transcriptPath,
      trigger: 'auto',
      cwd: '/tmp/test-project',
    });

    // Pre-compact hook exits with code 0 and produces no stdout
    expect(result.exitCode).toBe(0);

    // Check that precompact cache file was written
    const cachePath = join(PRECOMPACT_DIR, `${sessionId}.json`);
    createdFiles.push(cachePath);
    expect(existsSync(cachePath)).toBe(true);

    // Check that pending-compact flag file was written
    const pendingPath = join(PENDING_COMPACT_DIR, `${sessionId}.json`);
    createdFiles.push(pendingPath);
    expect(existsSync(pendingPath)).toBe(true);

    // Verify cache content structure
    const cache = JSON.parse(require('node:fs').readFileSync(cachePath, 'utf-8'));
    expect(cache.session_id).toBe(sessionId);
    expect(cache.trigger).toBe('auto');
    expect(cache.user_messages.length).toBeGreaterThan(0);
    expect(cache.tools_used).toContain('Read');
  });

  it('missing session_id exits cleanly', async () => {
    const result = await runHook('pre-compact.mjs', {
      transcript_path: '/tmp/some-transcript.jsonl',
      trigger: 'manual',
    });

    expect(result.exitCode).toBe(0);
  });
});
