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
 * Finding the task text: SubagentStart carries only the base fields on CLI
 * 2.1.281 (no prompt). pre-task.mjs stashes every Task/Agent dispatch by
 * tool_use_id, and Claude Code writes
 * <dirname(transcript_path)>/<session_id>/subagents/agent-<agent_id>.meta.json
 * = {agentType, description, toolUseId, …}. In order:
 *   1. a task field on the input (future hosts),
 *   2. meta.json → toolUseId → the stash entry,
 *   3. meta.json → toolUseId → that tool_use in the parent transcript,
 *   4. exactly one unclaimed stash entry of the same agent type (last 60 s),
 *   5. otherwise nothing: a guess could brief the worker with another's task.
 *
 * The recall is ranked (surface brief-rank) with the relevance floor. Gated by
 * the hook feature `subagentRecall` (on when absent).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readStdin, detectProject, recallMemories, getHookFeatures, hookBudget, clipQuery, transcriptEntries, isTemporaryChat } from './shared.mjs';
import { claimDispatch } from './task-gate.mjs';

// Cross-platform safety: never break a subagent launch — always emit valid JSON.
process.on('uncaughtException', () => { try { process.stdout.write('{}'); } catch {} process.exit(0); });
process.on('unhandledRejection', () => { try { process.stdout.write('{}'); } catch {} process.exit(0); });

const META_POLL_MS = 300;

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readMeta(input) {
  const { transcript_path: transcriptPath, session_id: sessionId, agent_id: agentId } = input || {};
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId || '') || !/^[a-zA-Z0-9_-]+$/.test(agentId || '')) return null;
  const path = join(dirname(transcriptPath), sessionId, 'subagents', `agent-${agentId}.meta.json`);
  const until = Date.now() + META_POLL_MS;
  for (;;) {
    if (existsSync(path)) {
      try {
        const meta = JSON.parse(readFileSync(path, 'utf8'));
        if (meta && typeof meta === 'object') return meta;
      } catch { /* written but not complete yet: retry */ }
    }
    if (Date.now() >= until) return null;
    await sleep(25);
  }
}

function promptFromTranscript(transcriptPath, toolUseId) {
  for (const entry of transcriptEntries(transcriptPath, 1024 * 1024).reverse()) {
    if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) continue;
    for (const block of entry.message.content) {
      if (block && block.type === 'tool_use' && block.id === toolUseId && typeof block.input?.prompt === 'string') {
        return block.input.prompt;
      }
    }
  }
  return '';
}

async function resolveDispatch(input) {
  const meta = await readMeta(input);
  const toolUseId = typeof meta?.toolUseId === 'string' ? meta.toolUseId : '';
  if (toolUseId) {
    let entry = null;
    try { entry = claimDispatch(input, { toolUseId }); } catch { /* lock contention: try the transcript */ }
    if (entry?.prompt?.trim()) return entry.prompt.trim();
    const fromTranscript = promptFromTranscript(input.transcript_path, toolUseId);
    if (fromTranscript.trim()) return fromTranscript.trim();
    return '';
  }
  try {
    const entry = claimDispatch(input, { agentType: input.agent_type || meta?.agentType });
    if (entry?.prompt?.trim()) return entry.prompt.trim();
  } catch { /* best effort */ }
  return '';
}

async function main() {
  const budget = hookBudget(3000);
  let input = {};
  try {
    input = JSON.parse(await readStdin());
  } catch { /* proceed with empty */ }

  // A temporary chat (see isTemporaryChat): no dispatch was stashed for its
  // workers (pre-task.mjs), so there is no task text to brief them from.
  if (isTemporaryChat()) { process.stdout.write('{}'); return; }

  // Opt-in payload discovery for verification (SYNABUN_HOOK_DEBUG=1).
  if (process.env.SYNABUN_HOOK_DEBUG) {
    try { process.stderr.write(`[SubagentStart] ${JSON.stringify(input)}\n`); } catch { /* ok */ }
  }

  if (getHookFeatures().subagentRecall === false) { process.stdout.write('{}'); return; }

  const taskText = extractTaskText(input) || await resolveDispatch(input);
  if (!taskText) { process.stdout.write('{}'); return; }

  const project = detectProject(input.cwd || '');
  const callMs = Math.min(2000, budget.callTimeout(100));
  const additionalContext = await recallMemories({
    query: clipQuery(taskText), project, limit: 3, tokenBudget: 600,
    timeoutMs: callMs, budgetMs: callMs,
    // Attribution only: the worker's context holds none of the memories its
    // parent was shown, so the parent's injection ledger must not filter them.
    logSessionId: input.session_id,
    rank: true, surface: 'brief-rank', floor: true,
  });

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
