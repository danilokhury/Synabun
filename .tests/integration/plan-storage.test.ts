/**
 * Integration test: Plan storage flow
 *
 * Tests:
 * 1. post-plan with non-ExitPlanMode tool → empty output
 * 2. post-plan with ExitPlanMode but no API key → storage skipped
 */
import { describe, it, expect } from 'vitest';
import { runHook } from '../utils/hook-runner.js';

describe('integration: plan storage', () => {
  it('ignores non-ExitPlanMode tool calls', async () => {
    const result = await runHook('post-plan.mjs', {
      session_id: 'test-plan-int-1',
      tool_name: 'Edit',
      tool_input: {},
      cwd: '/tmp/test-project',
    });

    expect(result.exitCode).toBe(0);
    // Should output empty or minimal JSON (not blocked, no context)
    expect(result.stdout.trim()).toMatch(/^\{?\}?$/);
  });

  it('handles ExitPlanMode with no matching plan file gracefully', async () => {
    const result = await runHook('post-plan.mjs', {
      session_id: 'test-plan-int-2',
      tool_name: 'ExitPlanMode',
      tool_input: {},
      cwd: '/tmp/test-project',
    });

    expect(result.exitCode).toBe(0);
    // Should either find no unstored plan or report the storage result
    // Won't crash regardless of plan directory state
  });
});
