/**
 * Integration test: Loop lifecycle
 *
 * Full flow (fresh-context model):
 * 1. Start loop via handleLoop MCP tool → writes state file
 * 2. Fire stop.mjs → allows stop, sets awaitingNext, increments currentIteration
 * 3. Fire stop.mjs again → allows stop, increments again
 * 4. Fire stop.mjs at max iterations → deactivates loop, no awaitingNext
 *
 * Note: In the fresh-context model, the stop hook never blocks for loop
 * continuation. Instead it sets awaitingNext=true and the server-side loop
 * driver sends /clear + re-prompt to the PTY.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { handleLoop } from '@mcp/tools/loop.js';
import {
  runHook,
  isBlocked,
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

      // Step 2: Fire stop.mjs → allows stop, sets awaitingNext (iteration 1)
      const stop1 = await runHook('stop.mjs', {
        session_id: sessionId,
        last_assistant_message: 'Completed first iteration.',
      });
      expect(isBlocked(stop1)).toBe(false);

      const state1 = JSON.parse(readFileSync(loopFilePath, 'utf-8'));
      expect(state1.currentIteration).toBe(1);
      expect(state1.awaitingNext).toBe(true);

      // Simulate server driver clearing awaitingNext (as it would after /clear)
      state1.awaitingNext = false;
      const { writeFileSync } = await import('node:fs');
      writeFileSync(loopFilePath, JSON.stringify(state1, null, 2));

      // Step 3: Fire stop.mjs → allows stop (iteration 2)
      const stop2 = await runHook('stop.mjs', {
        session_id: sessionId,
        last_assistant_message: 'Completed second iteration.',
      });
      expect(isBlocked(stop2)).toBe(false);

      const state2 = JSON.parse(readFileSync(loopFilePath, 'utf-8'));
      expect(state2.currentIteration).toBe(2);
      expect(state2.awaitingNext).toBe(true);

      // Clear awaitingNext again
      state2.awaitingNext = false;
      writeFileSync(loopFilePath, JSON.stringify(state2, null, 2));

      // Step 4: Fire stop.mjs → allows stop (iteration 3 = max)
      const stop3 = await runHook('stop.mjs', {
        session_id: sessionId,
        last_assistant_message: 'Completed third iteration.',
      });
      expect(isBlocked(stop3)).toBe(false);

      const state3 = JSON.parse(readFileSync(loopFilePath, 'utf-8'));
      expect(state3.currentIteration).toBe(3);
      expect(state3.awaitingNext).toBe(true);

      // Clear awaitingNext
      state3.awaitingNext = false;
      writeFileSync(loopFilePath, JSON.stringify(state3, null, 2));

      // Step 5: Fire stop.mjs → at max (3/3), should deactivate
      const stop4 = await runHook('stop.mjs', {
        session_id: sessionId,
        last_assistant_message: 'Final.',
      });
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
