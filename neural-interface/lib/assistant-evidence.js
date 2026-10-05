/**
 * What a dispatched worker actually ran in one turn: its commands (with an
 * exit and the end of the output), the results of tools that can show success
 * or failure, and the files it edited. The worker-claim judgment reads this
 * as the evidence behind a "tests pass" (the Stop hook reads the same shape
 * from a transcript: hooks/claude-code/shared.mjs readTurnActivity).
 *
 * Pure: fed from the dispatcher's provider-event stream (no adapter changes;
 * every provider emits its tool events before its turn resolves).
 *   Claude    SDK messages: tool_use blocks, then tool_result blocks matched by
 *             id (+ tool_use_result, the tool's structured output)
 *   Codex     item.completed: command_execution, mcp_tool_call, file_change, error
 *   OpenCode  message.part.updated tool parts, keyed by callID, last write wins,
 *             counted once completed or errored
 */

import { isTestOrBuildCommand } from '../../hooks/claude-code/shared.mjs';

const MAX_KEPT = 24;          // commands / results kept per turn
const MAX_PENDING = 200;      // Claude tool uses waiting for their result; OpenCode parts
const SNAPSHOT_COMMANDS = 8;
const SNAPSHOT_RESULTS = 6;
const SNAPSHOT_FILES = 20;
const TAIL = 500;
const COMMAND_CLIP = 300;

// Mirrors the hooks (shared.mjs): results that say nothing about whether the work succeeded.
const QUIET_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'ToolSearch', 'TodoWrite', 'NotebookRead',
  'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
// SynaBun memory tools as Claude (mcp__SynaBun__recall), OpenCode (SynaBun_recall) and Codex (SynaBun.recall) name them.
const MEMORY_TOOL = /(?:^|__)Syna[Bb]un[._]+(?:remember|reflect|recall|memories|forget|restore|sync)$/;
const CLAUDE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const OPENCODE_EDIT_TOOLS = new Set(['edit', 'write', 'patch', 'multiedit']);
const OPENCODE_QUIET = /^(?:read|grep|glob|list|ls|todo\w*)$/i;

function clipLine(value, max) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}
function tailText(value, max = TAIL) {
  const s = String(value ?? '').trim();
  return s.length > max ? `…${s.slice(s.length - (max - 1))}` : s;
}
function blockText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b && b.type === 'text' ? b.text || '' : '')).filter(Boolean).join('\n');
  return '';
}
const quietTool = (name) => QUIET_TOOLS.has(name) || MEMORY_TOOL.test(name);

export function createTurnEvidence() {
  return { seq: 0, commands: [], results: [], files: new Set(), pending: new Map(), parts: new Map() };
}

function pushCommand(acc, entry) {
  acc.commands.push({ order: ++acc.seq, ...entry });
  if (acc.commands.length > MAX_KEPT) acc.commands.shift();
}
/** Over the cap, the oldest success goes first: an error is the evidence that matters. */
function pushResult(acc, entry) {
  acc.results.push({ order: ++acc.seq, ...entry });
  if (acc.results.length > MAX_KEPT) {
    const index = acc.results.findIndex((r) => !r.is_error);
    acc.results.splice(index === -1 ? 0 : index, 1);
  }
}
function addFile(acc, path) {
  if (typeof path === 'string' && path.trim() && acc.files.size < MAX_PENDING) acc.files.add(path.trim());
}

// ── Claude ──────────────────────────────────────────────────────────────────
function bashOutput(block, tur) {
  if (tur && typeof tur === 'object') {
    const joined = [tur.stdout, tur.stderr].filter((s) => typeof s === 'string' && s).join('\n');
    if (joined) return joined;
  }
  return blockText(block?.content) || (typeof tur === 'string' ? tur : '');
}
/** The hooks' bashExit (shared.mjs), for one tool_result. */
function bashExit(input, block, tur) {
  if (tur && typeof tur === 'object') {
    if (tur.interrupted === true) return 'interrupted';
    if (tur.backgroundTaskId) return 'background';
  }
  if (block?.is_error === true) return /interrupted by user/i.test(bashOutput(block, tur)) ? 'interrupted' : 'error';
  return input?.run_in_background ? 'background' : 'ok';
}
function recordClaude(acc, event) {
  const blocks = Array.isArray(event?.message?.content) ? event.message.content : [];
  if (event.type === 'assistant') {
    for (const block of blocks) {
      if (block?.type !== 'tool_use' || !block.id) continue;
      const name = String(block.name || '');
      const input = block.input && typeof block.input === 'object' ? block.input : {};
      if (CLAUDE_EDIT_TOOLS.has(name)) addFile(acc, input.file_path || input.notebook_path);
      acc.pending.set(block.id, { name, input, order: ++acc.seq });
      if (acc.pending.size > MAX_PENDING) acc.pending.delete(acc.pending.keys().next().value);
    }
    return;
  }
  if (event.type !== 'user') return;
  const resultBlocks = blocks.filter((block) => block?.type === 'tool_result' && block.tool_use_id);
  // tool_use_result is the structured output of the message's one tool result.
  const tur = resultBlocks.length === 1 ? event.tool_use_result : undefined;
  for (const block of resultBlocks) {
    const use = acc.pending.get(block.tool_use_id);
    if (!use) continue;
    acc.pending.delete(block.tool_use_id);
    if (use.name === 'Bash') {
      pushCommand(acc, {
        command: clipLine(use.input.command, COMMAND_CLIP),
        exit: bashExit(use.input, block, tur),
        output_tail: tailText(bashOutput(block, tur)),
      });
      continue;
    }
    if (quietTool(use.name)) continue;
    pushResult(acc, { tool: use.name, is_error: block.is_error === true, tail: tailText(blockText(block.content) || (typeof tur === 'string' ? tur : '')) });
  }
}

// ── Codex ───────────────────────────────────────────────────────────────────
function mcpResultText(item) {
  if (item?.error?.message) return String(item.error.message);
  const content = Array.isArray(item?.result?.content) ? item.result.content : [];
  return content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).filter(Boolean).join('\n');
}
function recordCodex(acc, event) {
  if (event?.type !== 'item.completed' || !event.item) return;
  const item = event.item;
  if (item.type === 'command_execution') {
    const code = item.exit_code;
    const exit = typeof code === 'number' ? (code === 0 ? 'ok' : 'error')
      : (item.status === 'failed' || item.status === 'declined' ? 'error' : 'unknown');
    pushCommand(acc, { command: clipLine(item.command, COMMAND_CLIP), exit, output_tail: tailText(item.aggregated_output || '') });
  } else if (item.type === 'mcp_tool_call') {
    const tool = `${item.server || 'mcp'}.${item.tool || 'tool'}`;
    if (!quietTool(tool)) pushResult(acc, { tool, is_error: item.status === 'failed', tail: tailText(mcpResultText(item)) });
  } else if (item.type === 'file_change') {
    const paths = (Array.isArray(item.changes) ? item.changes : []).map((c) => c?.path).filter(Boolean);
    for (const path of paths) addFile(acc, path);
    if (item.status === 'failed') pushResult(acc, { tool: 'apply_patch', is_error: true, tail: tailText(`patch failed: ${paths.join(', ')}`) });
  } else if (item.type === 'error') {
    pushResult(acc, { tool: 'error', is_error: true, tail: tailText(item.message || 'error') });
  }
}

// ── OpenCode ────────────────────────────────────────────────────────────────
function recordOpenCode(acc, eventType, event) {
  if (!/^message[.:]part[.:]updated$/i.test(String(eventType || ''))) return;
  const part = event?.part;
  if (!part || part.type !== 'tool') return;
  const state = part.state && typeof part.state === 'object' ? part.state : {};
  if (state.status !== 'completed' && state.status !== 'error') return;
  const key = String(part.callID || part.id || '');
  if (!key) return;
  const tool = String(part.tool || '');
  const input = state.input && typeof state.input === 'object' ? state.input : {};
  const failed = state.status === 'error';
  const text = failed ? String(state.error || '') : String(state.output ?? '');
  let record = null;
  if (tool === 'bash') {
    // metadata.exit is not in the SDK types: read defensively.
    const exitCode = state.metadata && typeof state.metadata === 'object' ? state.metadata.exit : undefined;
    const exit = failed ? 'error' : typeof exitCode === 'number' ? (exitCode === 0 ? 'ok' : 'error') : 'unknown';
    record = { kind: 'command', entry: { command: clipLine(input.command, COMMAND_CLIP), exit, output_tail: tailText(text) } };
  } else if (OPENCODE_EDIT_TOOLS.has(tool)) {
    addFile(acc, input.filePath || input.file_path || input.path);
    if (failed) record = { kind: 'result', entry: { tool, is_error: true, tail: tailText(text) } };
  } else if (!OPENCODE_QUIET.test(tool) && !quietTool(tool)) {
    record = { kind: 'result', entry: { tool, is_error: failed, tail: tailText(text) } };
  }
  if (!record) return;
  const previous = acc.parts.get(key);
  acc.parts.set(key, { order: previous?.order ?? ++acc.seq, ...record });
  if (acc.parts.size > MAX_PENDING) acc.parts.delete(acc.parts.keys().next().value);
}

/** Fold one provider-event payload ({ provider, eventType?, event }) into the turn's evidence. */
export function recordProviderEvent(acc, payload = {}) {
  if (!acc || !payload || typeof payload !== 'object') return acc;
  const event = payload.event && typeof payload.event === 'object' ? payload.event : {};
  if (payload.provider === 'claude-code') {
    if (event.type === 'assistant' || event.type === 'user') recordClaude(acc, event);
  } else if (payload.provider === 'codex') recordCodex(acc, event);
  else if (payload.provider === 'opencode') recordOpenCode(acc, payload.eventType || event.type, event);
  return acc;
}

/**
 * The turn's evidence as the judgment reads it: the last 8 commands, ≤6 tool
 * results (errors first, then the most recent, in the order they happened),
 * ≤20 edited files, the test/build checks, and whether the turn exposed
 * anything at all (a claim is not judged without evidence).
 */
export function evidenceSnapshot(acc) {
  if (!acc) return { commands: [], results: [], files: [], checks: [], hasEvidence: false };
  const commands = [...acc.commands];
  const results = [...acc.results];
  for (const part of acc.parts.values()) (part.kind === 'command' ? commands : results).push({ order: part.order, ...part.entry });
  // A Bash call with no result by the end of the turn: interrupted, or left in the background.
  for (const use of acc.pending.values()) {
    if (use.name !== 'Bash') continue;
    commands.push({ order: use.order, command: clipLine(use.input.command, COMMAND_CLIP), exit: use.input.run_in_background ? 'background' : 'interrupted', output_tail: '' });
  }
  commands.sort((a, b) => a.order - b.order);
  results.sort((a, b) => a.order - b.order);
  const errors = results.filter((r) => r.is_error).slice(-SNAPSHOT_RESULTS);
  const rest = results.filter((r) => !r.is_error).slice(-(SNAPSHOT_RESULTS - errors.length));
  const chosen = [...errors, ...rest].sort((a, b) => a.order - b.order);
  const bare = (c) => ({ command: c.command, exit: c.exit, output_tail: c.output_tail });
  return {
    commands: commands.slice(-SNAPSHOT_COMMANDS).map(bare),
    results: chosen.map((r) => ({ tool: r.tool, is_error: r.is_error, tail: r.tail })),
    files: [...acc.files].slice(0, SNAPSHOT_FILES),
    checks: commands.filter((c) => isTestOrBuildCommand(c.command)).slice(-10).map(bare),
    hasEvidence: commands.length > 0 || results.length > 0,
  };
}

const clipCommand = (command, max = 80) => clipLine(command, max);

/** One line of deterministic evidence for an unverified claim (the Stop hook's claimEvidence). */
export function claimEvidenceLine(snapshot) {
  const checks = Array.isArray(snapshot?.checks) ? snapshot.checks : [];
  if (!checks.length) return 'no test/build command ran this turn';
  const last = checks[checks.length - 1];
  const cmd = `\`${clipCommand(last.command)}\``;
  if (last.exit === 'error') return `the last ${cmd} exited with an error`;
  if (last.exit === 'interrupted') return `the last ${cmd} was interrupted`;
  if (last.exit === 'background') return `${cmd} was still running in the background`;
  const bash = Array.isArray(snapshot?.commands) ? snapshot.commands : [];
  const lastRun = bash[bash.length - 1];
  if (lastRun && lastRun.exit === 'error') return `the last command, \`${clipCommand(lastRun.command)}\`, exited with an error`;
  return `the last check, ${cmd}, exited ok, but the message reports more than this turn's output shows`;
}
