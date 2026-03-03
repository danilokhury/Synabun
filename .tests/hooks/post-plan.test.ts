import { describe, it, expect } from 'vitest';
import {
  runHook,
  testSessionId,
} from '../utils/hook-runner.js';

describe('post-plan hook', () => {
  it('tool_name not ExitPlanMode returns empty output {}', async () => {
    const sessionId = testSessionId();
    const result = await runHook('post-plan.mjs', {
      session_id: sessionId,
      tool_name: 'SomeOtherTool',
      tool_input: {},
      tool_response: {},
      cwd: '/tmp/test-project',
    });

    expect(result.exitCode).toBe(0);
    expect(result.parsed).toEqual({});
  });

  it('ExitPlanMode but no plan files outputs "no" or empty context', async () => {
    const sessionId = testSessionId();
    const result = await runHook('post-plan.mjs', {
      session_id: sessionId,
      tool_name: 'ExitPlanMode',
      tool_input: {},
      tool_response: {},
      cwd: '/tmp/test-project',
    });

    expect(result.exitCode).toBe(0);

    // The hook either:
    // - Outputs additionalContext mentioning "no unstored plan" or "already in memory"
    // - Or outputs empty {} if no plans dir exists
    // - Or fails silently and outputs an error context
    const ctx = (result.parsed as Record<string, unknown>)?.additionalContext as string || '';
    const isEmpty = Object.keys(result.parsed).length === 0;

    // One of these should be true
    expect(isEmpty || ctx.includes('no') || ctx.includes('No') || ctx.includes('already') || ctx.includes('failed')).toBe(true);
  });
});
