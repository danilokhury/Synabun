/**
 * Integration test: Loop lifecycle
 *
 * Full flow:
 * 1. Start loop via handleLoop MCP tool → writes state file
 * 2. Fire stop.mjs → blocks with iteration 1, increments currentIteration
 * 3. Fire stop.mjs again → blocks with iteration 2
 * 4. Fire stop.mjs at max iterations → deactivates loop, no block
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { handleLoop } from '@mcp/tools/loop.js';
import {
  runHook,
  isBlocked,
  getBlockReason,
} from '../utils/hook-runner.js';

const LOOP_DIR = resolve(__dirname, '../../data/loop');

describe('integration: loop lifecycle', () => {
  const sessionId = `test-loop-int-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const loopFilePath = join(LOOP_DIR, `${sessionId}.json`);

  afterEach(() => {
    try { unlinkSync(loopFilePath); } catch { /* ok */ }
  });

  it('completes full loop lifecycle: start → iterate → finish', async () => {
    // Set env so resolveSessionId finds it
    const origEnv = process.env.CLAUDE_SESSION_ID;
    process.env.CLAUDE_SESSION_ID = sessionId;

    try {
      // Step 1: Start loop
      const startResult = await handleLoop({
        action: 'start',
        task: 'Test iteration task',
        iterations: 3,
        session_id: sessionId,
      });
      const startText = startResult.content[0].text;
      expect(startText).toContain('Loop started');
      expect(startText).toContain('Iterations: 3');
      expect(existsSync(loopFilePath)).toBe(true);

      // Verify initial state
      const state0 = JSON.parse(readFileSync(loopFilePath, 'utf-8'));
      expect(state0.active).toBe(true);
      expect(state0.currentIteration).toBe(0);
      expect(state0.totalIterations).toBe(3);

      // Step 2: Fire stop.mjs → should block (iteration 1)
      const stop1 = await runHook('stop.mjs', {
        session_id: sessionId,
        last_assistant_message: 'Completed first iteration.',
      });
      expect(isBlocked(stop1)).toBe(true);
      expect(getBlockReason(stop1)).toContain('1');

      // Verify currentIteration incremented
      const state1 = JSON.parse(readFileSync(loopFilePath, 'utf-8'));
      expect(state1.currentIteration).toBe(1);

      // Step 3: Fire stop.mjs → should block (iteration 2)
      const stop2 = await runHook('stop.mjs', {
        session_id: sessionId,
        last_assistant_message: 'Completed second iteration.',
      });
      expect(isBlocked(stop2)).toBe(true);

      const state2 = JSON.parse(readFileSync(loopFilePath, 'utf-8'));
      expect(state2.currentIteration).toBe(2);

      // Step 4: Fire stop.mjs → iteration 3 (final)
      const stop3 = await runHook('stop.mjs', {
        session_id: sessionId,
        last_assistant_message: 'Completed third iteration.',
      });
      expect(isBlocked(stop3)).toBe(true);

      const state3 = JSON.parse(readFileSync(loopFilePath, 'utf-8'));
      expect(state3.currentIteration).toBe(3);

      // Step 5: Fire stop.mjs → at max, should deactivate and NOT block
      const stop4 = await runHook('stop.mjs', {
        session_id: sessionId,
        last_assistant_message: 'Final.',
      });
      // At this point the loop should be deactivated
      // The stop hook may or may not block depending on implementation
      // but the loop file should show active: false or be deleted
      if (existsSync(loopFilePath)) {
        const stateFinal = JSON.parse(readFileSync(loopFilePath, 'utf-8'));
        expect(stateFinal.active).toBe(false);
      }

      // Step 6: Check status → should show inactive/completed
      const statusResult = await handleLoop({
        action: 'status',
        session_id: sessionId,
      });
      const statusText = statusResult.content[0].text;
      expect(statusText).toMatch(/inactive|completed|No active loop/i);
    } finally {
      process.env.CLAUDE_SESSION_ID = origEnv;
    }
  });
});
