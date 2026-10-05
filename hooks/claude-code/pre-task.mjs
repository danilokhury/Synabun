#!/usr/bin/env node

/** PreToolUse denies one dispatch batch; PostToolBatch releases its retry. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readStdin, getHookFeatures, detectProject, recallMemories, DATA_DIR, isTemporaryChat } from './shared.mjs';
import { TASK_TOOLS, updateTaskTurn, completeTaskBatch, stashDispatch } from './task-gate.mjs';

let finished = false;
const deadline = Date.now() + 4500;
function finish(output = {}) {
  if (finished) return;
  finished = true;
  process.stdout.write(JSON.stringify(output), () => process.exit(0));
  setTimeout(() => process.exit(0), 100).unref();
}
const guard = setTimeout(() => finish(), 4500);
guard.unref();
process.on('uncaughtException', () => finish());
process.on('unhandledRejection', () => finish());

const INSTRUCTION = 'SynaBun memory has prior context on this task. Read the brief, then re-issue your subagent call(s) with exact file paths, prior fixes, and known constraints folded into each prompt so each agent searches narrowly. After this batch completes, this gate will not block again this turn.';

function block(state, input) {
  state.blockedTurn = state.turn;
  state.blockedToolUseIds = [...new Set([...(state.blockedToolUseIds || []), input.tool_use_id])];
  const first = !state.briefDelivered;
  state.briefDelivered = true;
  const evidence = state.brief.alreadyPresent
    ? 'The relevant SynaBun memories are already in your context. Review the existing Related Memories block; no duplicate brief is attached.'
    : first ? state.brief.context : 'Use the SynaBun memory brief supplied with the other blocked dispatch in this batch.';
  return { decision: 'block', reason: `${INSTRUCTION}\n\n${evidence}` };
}

async function gate(input) {
  if (!TASK_TOOLS.has(input.tool_name) || typeof input.tool_use_id !== 'string' || !input.tool_use_id) return {};
  while (Date.now() < deadline - 150) {
    let action = { kind: 'allow' };
    updateTaskTurn(input, state => {
      if (state.releasedTurn === state.turn || state.recalledTurn === state.turn) return;
      if (state.brief?.context || state.brief?.alreadyPresent) {
        action = { kind: 'block', output: block(state, input) };
        return state;
      }
      if (state.claim) {
        if (Date.now() >= state.claim.expiresAt) {
          state.releasedTurn = state.turn;
          delete state.claim;
          return state;
        }
        action = { kind: 'wait' };
        return;
      }
      const query = [input.tool_input?.prompt, input.tool_input?.description, state.prompt]
        .find(text => typeof text === 'string' && text.trim())?.trim().slice(0, 16000);
      if (!query || deadline - Date.now() < 250) {
        state.releasedTurn = state.turn;
        return state;
      }
      const token = randomUUID();
      state.claim = { token, expiresAt: Math.min(Date.now() + 2250, deadline - 150) };
      action = { kind: 'recall', token, turn: state.turn, query };
      return state;
    });
    if (action.kind === 'allow') return {};
    if (action.kind === 'block') return action.output;
    if (action.kind === 'wait') {
      await new Promise(resolve => setTimeout(resolve, 25));
      continue;
    }

    // The claim is persisted, but the SQLite lock is no longer held.
    let contextGeneration;
    try { contextGeneration = JSON.parse(readFileSync(join(DATA_DIR, 'memory-context', `${input.session_id}.json`), 'utf8')).generation; } catch { /* no ledger */ }
    const callMs = Math.max(1, Math.min(2000, deadline - Date.now() - 150));
    const recalled = await recallMemories({
      query: action.query, project: detectProject(input.cwd || ''),
      limit: 5, minScore: 0.45, tokenBudget: 1200,
      timeoutMs: callMs, budgetMs: callMs,
      returnMeta: true, sessionId: input.session_id, contextGeneration,
      // A worker gets five memories: rank them by judged relevance to its
      // task (surface brief-rank), drop the ones judged irrelevant, and keep
      // fusion order when the judgment is unavailable.
      rank: true, surface: 'brief-rank', floor: true,
    });
    // Only what the gate needs goes into its state file.
    const brief = { context: recalled.context, alreadyPresent: recalled.alreadyPresent };
    let output = {};
    updateTaskTurn(input, state => {
      if (state.claim?.token !== action.token || state.releasedTurn === state.turn
        || state.recalledTurn === state.turn) return;
      const expired = Date.now() >= state.claim.expiresAt;
      delete state.claim;
      if (expired || (!brief.context && !brief.alreadyPresent)) {
        state.releasedTurn = state.turn;
      } else {
        state.brief = brief;
        output = block(state, input);
      }
      return state;
    }, action.turn);
    return output;
  }
  updateTaskTurn(input, state => {
    state.releasedTurn = state.turn;
    delete state.claim;
    return state;
  });
  return {};
}

async function main() {
  const input = JSON.parse(await readStdin());
  // A temporary chat (see isTemporaryChat): the dispatch is not stashed (the
  // stash holds the task text), not gated and not briefed.
  if (isTemporaryChat()) return {};
  if (process.env.SYNABUN_HOOK_DEBUG) process.stderr.write(`[TaskRecallGate] ${JSON.stringify(input)}\n`);
  // Every dispatch, nested ones and gate-off sessions included: SubagentStart
  // has no task text of its own and finds the worker's prompt here.
  if (input.hook_event_name === 'PreToolUse' && TASK_TOOLS.has(input.tool_name)) {
    try { stashDispatch(input); } catch { /* best effort; never delays the dispatch */ }
  }
  if (getHookFeatures().taskRecallGate === false || input.agent_id) return {};
  if (input.hook_event_name === 'PostToolBatch') {
    completeTaskBatch(input);
    return {};
  }
  if (input.hook_event_name !== 'PreToolUse') return {};
  return gate(input);
}

main().then(finish, () => finish());
