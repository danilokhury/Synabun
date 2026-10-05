/** Shared, short transactions for the orchestrator's per-prompt recall gate. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataHome } from '../../lib/paths.js';
import { updateJsonState, withStateLock, writeJsonAtomic } from './state.mjs';

export const TASK_TOOLS = new Set(['Task', 'Agent']);
export const RECALL_TOOL = /(?:^|__)Syna[Bb]un_+recall$/;
const LOCK_OPTIONS = { timeoutMs: 100 };

// --- Subagent dispatch stash ---
// SubagentStart carries no task text (CLI 2.1.281), so pre-task.mjs records
// every Task/Agent dispatch here, keyed by tool_use_id, and subagent-start.mjs
// finds its own through subagents/agent-<id>.meta.json → toolUseId. An
// ephemeral cache: corrupt content is replaced, entries expire after 10 min.
const DISPATCH_TTL_MS = 10 * 60 * 1000;
const DISPATCH_MAX = 50;

function dispatchPath(sessionId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(typeof sessionId === 'string' ? sessionId : '')) return null;
  return join(getDataHome(), 'data', 'subagent-dispatch', `${sessionId}.json`);
}

function readStash(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

const agentType = (value) => (typeof value === 'string' && value.trim() ? value.trim() : 'general-purpose');

/** Record one PreToolUse Task/Agent dispatch. Idempotent per tool_use_id. */
export function stashDispatch(input) {
  if (!TASK_TOOLS.has(input?.tool_name) || typeof input.tool_use_id !== 'string' || !input.tool_use_id) return;
  const file = dispatchPath(input.session_id);
  if (!file) return;
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const prompt = typeof toolInput.prompt === 'string' ? toolInput.prompt.slice(0, 16000) : '';
  const description = typeof toolInput.description === 'string' ? toolInput.description.slice(0, 500) : '';
  if (!prompt.trim() && !description.trim()) return;
  withStateLock(() => {
    const now = Date.now();
    const stash = readStash(file);
    if (stash[input.tool_use_id]) return;
    const kept = Object.entries(stash)
      .filter(([, entry]) => entry && typeof entry === 'object' && now - (Number(entry.at) || 0) < DISPATCH_TTL_MS);
    kept.push([input.tool_use_id, { prompt, description, subagent_type: agentType(toolInput.subagent_type), at: now }]);
    kept.sort((a, b) => a[1].at - b[1].at);
    writeJsonAtomic(file, Object.fromEntries(kept.slice(-DISPATCH_MAX)));
  }, LOCK_OPTIONS);
}

/**
 * Claim the dispatch a subagent was started from. With `toolUseId` (from the
 * subagent's meta.json) the lookup is exact. Without it, only an unambiguous
 * guess is made: exactly one unclaimed entry of the same agent type stashed in
 * the last `windowMs`. Returns {tool_use_id, prompt, description, subagent_type, at} or null.
 */
export function claimDispatch(input, { toolUseId, agentType: type, windowMs = 60 * 1000 } = {}) {
  const file = dispatchPath(input?.session_id);
  if (!file) return null;
  let claimed = null;
  withStateLock(() => {
    const stash = readStash(file);
    const now = Date.now();
    let id = null;
    if (typeof toolUseId === 'string' && toolUseId) {
      if (stash[toolUseId] && typeof stash[toolUseId] === 'object') id = toolUseId;
    } else if (type !== undefined) {
      const wanted = agentType(type);
      const matches = Object.entries(stash).filter(([, entry]) => entry && typeof entry === 'object' && !entry.claimed
        && agentType(entry.subagent_type) === wanted && now - (Number(entry.at) || 0) <= windowMs);
      if (matches.length === 1) id = matches[0][0];
    }
    if (!id) return;
    const entry = stash[id];
    claimed = { tool_use_id: id, prompt: String(entry.prompt || ''), description: String(entry.description || ''),
      subagent_type: agentType(entry.subagent_type), at: Number(entry.at) || 0 };
    if (!entry.claimed) {
      stash[id] = { ...entry, claimed: true, claimedBy: typeof input.agent_id === 'string' ? input.agent_id : null, claimedAt: now };
      writeJsonAtomic(file, stash);
    }
  }, LOCK_OPTIONS);
  return claimed;
}

function statePath(input) {
  if (input?.agent_id || !/^[a-zA-Z0-9_-]+$/.test(input?.session_id || '')) return null;
  return join(getDataHome(), 'data', 'task-gate', `${input.session_id}.json`);
}

export function startTaskTurn(input) {
  const file = statePath(input);
  if (!file || typeof input.prompt !== 'string') return;
  return updateJsonState(file, state => {
    // Canonical handlers are deduplicated by Claude; tolerate a duplicate
    // delivery too, without erasing the receipts from an already-started turn.
    if (input.prompt_id && state?.promptId === input.prompt_id) return;
    return {
      turn: (Number.isSafeInteger(state?.turn) ? state.turn : 0) + 1,
      promptId: input.prompt_id || null,
      prompt: input.prompt.trim().slice(0, 16000),
      completedRecalls: [],
      blockedToolUseIds: [],
    };
  }, undefined, LOCK_OPTIONS);
}

export function updateTaskTurn(input, update, expectedTurn) {
  const file = statePath(input);
  // Old hosts without prompt_id cannot safely attribute a late completion.
  // Fail open rather than releasing another user prompt's gate.
  if (!file || typeof input.prompt_id !== 'string' || !input.prompt_id) return;
  return updateJsonState(file, state => {
    if (!Number.isSafeInteger(state?.turn) || state.turn < 1
      || state.promptId !== input.prompt_id
      || (expectedTurn !== undefined && state.turn !== expectedTurn)) return;
    return update(state);
  }, undefined, LOCK_OPTIONS);
}

export function recordTaskRecall(input) {
  if (!RECALL_TOOL.test(input.tool_name || '') || !input.tool_use_id) return;
  return updateTaskTurn(input, state => {
    if (state.recalledTurn === state.turn || state.releasedTurn === state.turn) return;
    const ids = state.completedRecalls || [];
    if (ids.includes(input.tool_use_id)) return;
    state.completedRecalls = [...ids, input.tool_use_id].slice(-256);
    return state;
  });
}

export function completeTaskBatch(input) {
  if (!Array.isArray(input.tool_calls)) return;
  const ids = new Set(input.tool_calls.map(call => call?.tool_use_id).filter(Boolean));
  if (!ids.size) return;
  return updateTaskTurn(input, state => {
    const recalled = (state.completedRecalls || []).some(id => ids.has(id));
    const blocked = state.blockedTurn === state.turn
      && (state.blockedToolUseIds || []).some(id => ids.has(id));
    if (!recalled && !blocked) return;
    if (recalled) state.recalledTurn = state.turn;
    if (blocked) state.releasedTurn = state.turn;
    state.completedRecalls = (state.completedRecalls || []).filter(id => !ids.has(id));
    delete state.claim;
    delete state.brief;
    return state;
  });
}
