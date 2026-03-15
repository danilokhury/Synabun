import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// The loop tool resolves LOOP_DIR relative to its own __dirname (mcp-server/src/tools/)
// via: NI_DATA_DIR = join(__dirname, '..', '..', '..', 'data')
// Which resolves to Synabun/data/
// LOOP_DIR = join(NI_DATA_DIR, 'loop') = Synabun/data/loop/
const LOOP_DIR = resolve(__dirname, '../../data/loop');

// Generate unique test session IDs to avoid collisions
function testLoopSessionId(): string {
  return `test-loop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Track created loop files for cleanup
const createdFiles: string[] = [];

function getLoopPath(sessionId: string): string {
  return join(LOOP_DIR, `${sessionId}.json`);
}

// We need to set CLAUDE_SESSION_ID before importing the tool
// since resolveSessionId checks it
let currentSessionId = '';

const { handleLoop } = await import('../../mcp-server/src/tools/loop.js');

beforeEach(() => {
  currentSessionId = testLoopSessionId();
  process.env.CLAUDE_SESSION_ID = currentSessionId;
});

afterEach(() => {
  // Clean up any test loop files
  for (const filePath of createdFiles) {
    try {
      if (existsSync(filePath)) unlinkSync(filePath);
    } catch { /* ok */ }
  }
  createdFiles.length = 0;
  delete process.env.CLAUDE_SESSION_ID;
});

// ── Start ──────────────────────────────────────────────────────

describe('loop — start', () => {
  it('missing task returns "task" is required', async () => {
    const result = await handleLoop({ action: 'start', session_id: currentSessionId });
    expect(result.content[0].text).toContain('task');
    expect(result.content[0].text).toContain('required');
  });

  it('success writes state file and response includes "Loop started"', async () => {
    const result = await handleLoop({
      action: 'start',
      task: 'Run tests',
      session_id: currentSessionId,
    });
    const loopPath = getLoopPath(currentSessionId);
    createdFiles.push(loopPath);

    expect(result.content[0].text).toContain('Loop started');
    expect(result.content[0].text).toContain('Run tests');
    expect(existsSync(loopPath)).toBe(true);

    const state = JSON.parse(readFileSync(loopPath, 'utf-8'));
    expect(state.active).toBe(true);
    expect(state.task).toBe('Run tests');
    expect(state.totalIterations).toBe(10); // DEFAULT_ITERATIONS
  });

  it('response includes task and iterations', async () => {
    const result = await handleLoop({
      action: 'start',
      task: 'Deploy changes',
      iterations: 5,
      session_id: currentSessionId,
    });
    createdFiles.push(getLoopPath(currentSessionId));

    expect(result.content[0].text).toContain('Deploy changes');
    expect(result.content[0].text).toContain('5');
  });

  it('duplicate active loop returns "already active"', async () => {
    // Start first loop
    await handleLoop({
      action: 'start',
      task: 'First task',
      session_id: currentSessionId,
    });
    createdFiles.push(getLoopPath(currentSessionId));

    // Try to start second loop
    const result = await handleLoop({
      action: 'start',
      task: 'Second task',
      session_id: currentSessionId,
    });
    expect(result.content[0].text).toContain('already active');
  });

  it('iterations are clamped to MAX_ITERATIONS (50)', async () => {
    const result = await handleLoop({
      action: 'start',
      task: 'Clamped loop',
      iterations: 100,
      session_id: currentSessionId,
    });
    const loopPath = getLoopPath(currentSessionId);
    createdFiles.push(loopPath);

    const state = JSON.parse(readFileSync(loopPath, 'utf-8'));
    expect(state.totalIterations).toBe(50); // MAX_ITERATIONS
  });
});

// ── Stop ───────────────────────────────────────────────────────

describe('loop — stop', () => {
  it('no active loop returns "No active loop"', async () => {
    const result = await handleLoop({ action: 'stop', session_id: currentSessionId });
    expect(result.content[0].text).toContain('No active loop');
  });

  it('success stops the loop and includes iteration count', async () => {
    // Start a loop first
    await handleLoop({
      action: 'start',
      task: 'Stoppable task',
      session_id: currentSessionId,
    });
    const loopPath = getLoopPath(currentSessionId);
    createdFiles.push(loopPath);

    // Stop it
    const result = await handleLoop({ action: 'stop', session_id: currentSessionId });
    expect(result.content[0].text).toContain('Loop stopped.');
    expect(result.content[0].text).toContain('0/'); // 0 completed iterations
    expect(existsSync(loopPath)).toBe(false);
  });
});

// ── Status ─────────────────────────────────────────────────────

describe('loop — status', () => {
  it('no loop returns "No active loop"', async () => {
    const result = await handleLoop({ action: 'status', session_id: currentSessionId });
    expect(result.content[0].text).toContain('No active loop');
  });

  it('active loop shows progress', async () => {
    // Start a loop first
    await handleLoop({
      action: 'start',
      task: 'Status check task',
      iterations: 15,
      session_id: currentSessionId,
    });
    const loopPath = getLoopPath(currentSessionId);
    createdFiles.push(loopPath);

    const result = await handleLoop({ action: 'status', session_id: currentSessionId });
    expect(result.content[0].text).toContain('Loop active');
    expect(result.content[0].text).toContain('Status check task');
    expect(result.content[0].text).toContain('0/15');
  });
});

// ── Unknown action ─────────────────────────────────────────────

describe('loop — unknown action', () => {
  it('returns "Unknown action"', async () => {
    const result = await handleLoop({ action: 'restart', session_id: currentSessionId });
    expect(result.content[0].text).toContain('Unknown action');
  });
});
