#!/usr/bin/env node

/**
 * SynaBun SubagentStart Hook for Claude Code
 *
 * Fires when a subagent (Task / AgentTool worker) begins. Mirrors the main
 * session's UserPromptSubmit auto-recall: it searches SynaBun memory with the
 * subagent's task text and injects the results into the subagent's context via
 * `hookSpecificOutput.additionalContext`.
 *
 * Subagents never emit UserPromptSubmit, so without this hook they start with
 * zero memory context. This works for ALL agent types — it only adds context
 * and requires no tool access from the subagent.
 *
 * Lightweight: reads stdin, recalls (1.5s timeout, best-effort), emits, exits.
 */

import { readStdin, detectProject, recallMemories } from './shared.mjs';

// Cross-platform safety: never break a subagent launch — always emit valid JSON.
process.on('uncaughtException', () => { try { process.stdout.write('{}'); } catch {} process.exit(0); });
process.on('unhandledRejection', () => { try { process.stdout.write('{}'); } catch {} process.exit(0); });

// The exact field carrying the subagent's task text isn't documented in the CC
// binary, so probe the known candidates in priority order.
function extractTaskText(input) {
  const candidates = [
    input?.prompt,
    input?.task_prompt,
    input?.agent_prompt,
    input?.description,
    input?.tool_input?.prompt,
    input?.tool_input?.description,
    input?.task?.prompt,
    input?.task?.description,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return '';
}

async function main() {
  let input = {};
  try {
    input = JSON.parse(await readStdin());
  } catch { /* proceed with empty */ }

  // Opt-in payload discovery for verification (SYNABUN_HOOK_DEBUG=1).
  if (process.env.SYNABUN_HOOK_DEBUG) {
    try { process.stderr.write(`[SubagentStart] ${JSON.stringify(input)}\n`); } catch { /* ok */ }
  }

  const taskText = extractTaskText(input);
  if (!taskText) { process.stdout.write('{}'); return; }

  const project = detectProject(input.cwd || '');
  const additionalContext = await recallMemories({ query: taskText, project });

  if (additionalContext) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SubagentStart',
        additionalContext,
      },
    }));
  } else {
    process.stdout.write('{}');
  }
}

main().catch(() => { try { process.stdout.write('{}'); } catch {} process.exit(0); });
