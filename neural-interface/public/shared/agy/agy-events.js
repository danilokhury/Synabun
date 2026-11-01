// ═══════════════════════════════════════════
// SynaBun — Antigravity panel: what an ACP session says, as a transcript (no DOM)
// ═══════════════════════════════════════════
//
// The server forwards every ACP `session/update` of a tab's session as it came
// (lib/antigravity/panel-bridge.js). This module folds them into one state the
// renderer draws: rows in order (user, agent, thought, tool, plan, notice,
// compaction, subagent, message), the tool calls by id (a `tool_call_update`
// changes its row in place), turns (a user message and what answered it, with
// its usage, stop reason and duration), the agent's slash commands, mode, config
// options, title, context gauge and token usage, and the live output of the
// terminals SynaBun runs for the agent. Imported by the page and by `node --test`;
// it never touches the DOM.

import { stripGreetingNote } from './agy-greeting.js';

export const ROW_KINDS = Object.freeze(['user', 'agent', 'thought', 'tool', 'plan', 'notice', 'compaction', 'subagent', 'message']);
const MAX_ROWS = 2000;
const MAX_TURNS = 500;
const MAX_TEXT = 400_000;
const MAX_TERMINAL = 256 * 1024;

const now = () => Date.now();

export function createTranscript() {
  return {
    rows: [],
    tools: new Map(),           // toolCallId -> row
    plans: new Map(),           // planId -> row (plan_update); the older `plan` update has no id
    compactions: new Map(),     // compactionId -> row
    subagents: new Map(),       // child sessionId -> row
    messages: new Map(),        // messageId -> row (session_message)
    terminals: new Map(),       // terminalId -> { output, truncated, exitStatus }
    turns: [],                  // { id, userRowId, startedAt, endedAt, usage, stopReason, replay }
    turn: null,                 // the id of the turn rows are added to
    commands: [],
    modes: null,                // { currentModeId, availableModes }
    configOptions: [],
    title: null,
    context: null,              // { used, size, cost }
    usage: null,                // last turn's ACP usage block
    plan: null,
    running: false,
    seq: 0,
  };
}

export function textOf(content) {
  if (!content || typeof content !== 'object') return '';
  if (content.type === 'text') return typeof content.text === 'string' ? content.text : '';
  if (content.type === 'resource_link') return `[${content.name || content.uri || 'file'}]`;
  if (content.type === 'resource') return content.resource?.text ? String(content.resource.text) : `[${content.resource?.uri || 'resource'}]`;
  if (content.type === 'image') return '[image]';
  if (content.type === 'audio') return '[audio]';
  return '';
}

function attachmentOf(content) {
  if (!content || typeof content !== 'object') return null;
  if (content.type === 'resource_link') return { kind: 'link', name: content.name || content.uri, uri: content.uri, mimeType: content.mimeType || '' };
  if (content.type === 'image') return { kind: 'image', mimeType: content.mimeType || 'image/png', data: content.data || '', uri: content.uri || '' };
  if (content.type === 'audio') return { kind: 'audio', mimeType: content.mimeType || '', name: 'audio' };
  return null;
}

const blocksText = (blocks) => (Array.isArray(blocks) ? blocks.map(textOf).filter(Boolean).join('') : '');

function turnById(state, id) {
  if (!id) return null;
  for (let i = state.turns.length - 1; i >= 0; i -= 1) if (state.turns[i].id === id) return state.turns[i];
  return null;
}

function startTurn(state, { userRowId = null, replay = false } = {}) {
  state.seq += 1;
  const turn = { id: `t${state.seq}`, userRowId, startedAt: replay ? null : now(), endedAt: null, usage: null, stopReason: null, replay };
  state.turns.push(turn);
  if (state.turns.length > MAX_TURNS) state.turns.splice(0, state.turns.length - MAX_TURNS);
  state.turn = turn.id;
  return turn;
}

function pushRow(state, row) {
  state.seq += 1;
  const next = { id: `r${state.seq}`, turn: state.turn, ...row };
  state.rows.push(next);
  if (state.rows.length > MAX_ROWS) {
    const dropped = state.rows.splice(0, state.rows.length - MAX_ROWS);
    for (const old of dropped) {
      if (old.kind === 'tool') state.tools.delete(old.toolCallId);
      else if (old.kind === 'plan' && old.planId) state.plans.delete(old.planId);
      else if (old.kind === 'compaction') state.compactions.delete(old.compactionId);
      else if (old.kind === 'subagent') state.subagents.delete(old.sessionId);
      else if (old.kind === 'message') state.messages.delete(old.messageId);
    }
  }
  return next;
}

function closeRow(row) {
  if (!row || row.closed) return;
  row.closed = true;
  if (row.kind === 'thought' && row.startedAt && !row.endedAt) row.endedAt = now();
}

/** Appends a streamed chunk to the last row of the same kind, or starts a new one. */
// A user message as Antigravity keeps it may hold the greeting's note (agy-greeting.js): never shown.
const shownText = (kind, value) => (kind === 'user' ? stripGreetingNote(value) : value);

function appendChunk(state, kind, content, { replay = false } = {}) {
  const text = textOf(content);
  const attachment = attachmentOf(content);
  const last = state.rows[state.rows.length - 1];
  if (last && last.kind === kind && !last.closed) {
    if (text && content?.type === 'text') last.text = shownText(kind, last.text + text).slice(-MAX_TEXT);
    if (attachment) (last.attachments ||= []).push(attachment);
    last.replay = last.replay && replay;
    return last;
  }
  // agy echoes a typed prompt back as live user_message_chunk updates: the row
  // addUserMessage drew is the message, so its echo is not a second one.
  if (kind === 'user' && !replay && last?.kind === 'user' && last.typed && last.turn === state.turn) return last;
  if (last && last.kind !== kind) closeRow(last);
  if (kind === 'user') {
    // A user message the agent replays starts a turn of its own, as a typed one does.
    const turn = startTurn(state, { replay });
    const row = pushRow(state, { kind, text: content?.type === 'text' ? shownText(kind, text).slice(-MAX_TEXT) : '', attachments: attachment ? [attachment] : [], replay });
    turn.userRowId = row.id;
    return row;
  }
  return pushRow(state, {
    kind,
    text: content?.type === 'text' ? text.slice(-MAX_TEXT) : '',
    attachments: attachment ? [attachment] : [],
    replay,
    ...(kind === 'thought' && !replay ? { startedAt: now(), endedAt: null } : {}),
  });
}

/** Closes the streaming row so the next chunk starts a new bubble (a turn boundary). */
export function closeOpenRow(state) {
  const last = state.rows[state.rows.length - 1];
  if (last && (last.kind === 'agent' || last.kind === 'thought' || last.kind === 'user' || last.kind === 'message')) closeRow(last);
}

function mergeToolContent(content) {
  if (!Array.isArray(content)) return [];
  return content.map((item) => {
    if (!item || typeof item !== 'object') return null;
    if (item.type === 'diff') return { type: 'diff', path: String(item.path || ''), oldText: item.oldText ?? null, newText: String(item.newText ?? '') };
    if (item.type === 'terminal') return { type: 'terminal', terminalId: String(item.terminalId || '') };
    if (item.type === 'content') return { type: 'content', text: textOf(item.content), attachment: attachmentOf(item.content) };
    return null;
  }).filter(Boolean);
}

const FINAL_TOOL = new Set(['completed', 'failed']);

function applyTool(state, update, { replay = false } = {}) {
  const id = typeof update.toolCallId === 'string' ? update.toolCallId : '';
  if (!id) return null;
  let row = state.tools.get(id);
  if (!row) {
    closeOpenRow(state);
    row = pushRow(state, { kind: 'tool', toolCallId: id, title: '', name: '', toolKind: 'other', status: 'pending', content: [], locations: [], rawInput: null, rawOutput: null, replay, startedAt: replay ? null : now(), endedAt: null });
    state.tools.set(id, row);
  }
  if (typeof update.title === 'string' && update.title) row.title = update.title;
  if (typeof update.name === 'string' && update.name) row.name = update.name;
  if (typeof update.kind === 'string' && update.kind) row.toolKind = update.kind;
  if (typeof update.status === 'string' && update.status) {
    row.status = update.status;
    if (FINAL_TOOL.has(update.status) && row.startedAt && !row.endedAt) row.endedAt = now();
  }
  if (Array.isArray(update.content)) row.content = mergeToolContent(update.content);
  if (Array.isArray(update.locations)) row.locations = update.locations.filter((l) => l && typeof l.path === 'string').map((l) => ({ path: l.path, line: Number.isInteger(l.line) ? l.line : null }));
  if (update.rawInput !== undefined) row.rawInput = update.rawInput;
  if (update.rawOutput !== undefined) row.rawOutput = update.rawOutput;
  return row;
}

const PLAN_ENTRY = (e) => e && typeof e.content === 'string';
const planEntries = (entries) => (Array.isArray(entries) ? entries.filter(PLAN_ENTRY).map((e) => ({ content: e.content, priority: e.priority || 'medium', status: e.status || 'pending' })) : []);

function applyPlanUpdate(state, plan, { replay = false } = {}) {
  if (!plan || typeof plan !== 'object' || typeof plan.planId !== 'string' || !plan.planId) return null;
  const fields = plan.type === 'items'
    ? { format: 'items', entries: planEntries(plan.entries) }
    : plan.type === 'markdown'
      ? { format: 'markdown', content: String(plan.content ?? '').slice(0, MAX_TEXT) }
      : plan.type === 'file'
        ? { format: 'file', uri: String(plan.uri || '') }
        : null;
  if (!fields) return null;
  let row = state.plans.get(plan.planId);
  if (row) Object.assign(row, { entries: undefined, content: undefined, uri: undefined }, fields);
  else {
    closeOpenRow(state);
    row = pushRow(state, { kind: 'plan', planId: plan.planId, replay, ...fields });
    state.plans.set(plan.planId, row);
  }
  if (fields.format === 'items') state.plan = fields.entries;
  return row;
}

function removeRow(state, row) {
  const at = state.rows.indexOf(row);
  if (at >= 0) state.rows.splice(at, 1);
}

function applySubagent(state, update, { replay = false } = {}) {
  const id = typeof update.sessionId === 'string' ? update.sessionId : '';
  if (!id) return null;
  let row = state.subagents.get(id);
  if (!row) {
    closeOpenRow(state);
    row = pushRow(state, { kind: 'subagent', sessionId: id, title: '', description: '', state: 'unknown', cwd: '', replay });
    state.subagents.set(id, row);
  }
  // Omitted means unchanged; null clears.
  if (update.title !== undefined) row.title = typeof update.title === 'string' ? update.title : '';
  if (update.description !== undefined) row.description = typeof update.description === 'string' ? update.description : '';
  if (update.cwd !== undefined) row.cwd = typeof update.cwd === 'string' ? update.cwd : '';
  if (update.state !== undefined) row.state = update.state && typeof update.state.state === 'string' ? update.state.state : 'unknown';
  if (update.state?.usage && typeof update.state.usage === 'object') row.usage = update.state.usage;
  return row;
}

/**
 * Folds one ACP SessionUpdate into the transcript. Returns what changed:
 * 'rows' (draw the transcript), 'meta' (header: mode, options, title, gauge), or null.
 */
export function applyUpdate(state, update, { replay = false } = {}) {
  if (!update || typeof update !== 'object') return null;
  switch (update.sessionUpdate) {
    case 'user_message_chunk':
      appendChunk(state, 'user', update.content, { replay });
      return 'rows';
    case 'agent_message_chunk':
      appendChunk(state, 'agent', update.content, { replay });
      return 'rows';
    case 'agent_thought_chunk':
      appendChunk(state, 'thought', update.content, { replay });
      return 'rows';
    case 'tool_call':
    case 'tool_call_update':
      return applyTool(state, update, { replay }) ? 'rows' : null;
    case 'plan': {
      const entries = planEntries(update.entries);
      state.plan = entries;
      const last = state.rows[state.rows.length - 1];
      if (last?.kind === 'plan' && !last.planId) last.entries = entries;
      else { closeOpenRow(state); pushRow(state, { kind: 'plan', format: 'items', entries, replay }); }
      return 'rows';
    }
    case 'plan_update':
      return applyPlanUpdate(state, update.plan, { replay }) ? 'rows' : null;
    case 'plan_removed': {
      const row = state.plans.get(update.planId);
      if (!row) return null;
      state.plans.delete(update.planId);
      removeRow(state, row);
      return 'rows';
    }
    case 'available_commands_update':
      state.commands = Array.isArray(update.availableCommands) ? update.availableCommands.filter((c) => c && typeof c.name === 'string').map((c) => ({ name: c.name, description: c.description || '', hint: c.input?.hint || '' })) : [];
      return 'meta';
    case 'current_mode_update':
      if (typeof update.currentModeId === 'string') state.modes = { ...(state.modes || { availableModes: [] }), currentModeId: update.currentModeId };
      return 'meta';
    case 'config_option_update':
      if (Array.isArray(update.configOptions)) state.configOptions = update.configOptions;
      return 'meta';
    case 'session_info_update':
      if (typeof update.title === 'string' && update.title.trim()) state.title = update.title.trim();
      return 'meta';
    case 'usage_update':
      if (Number.isFinite(update.used) && Number.isFinite(update.size)) {
        const cost = update.cost && Number.isFinite(update.cost.amount) && typeof update.cost.currency === 'string' ? { amount: update.cost.amount, currency: update.cost.currency } : null;
        state.context = { used: update.used, size: update.size, cost };
      }
      return 'meta';
    case 'notice': {
      const text = [update.title, update.message || update.description].filter((s) => typeof s === 'string' && s).join(' — ');
      if (text) { closeOpenRow(state); pushRow(state, { kind: 'notice', text, severity: update.severity || 'info', replay }); return 'rows'; }
      return null;
    }
    case 'compaction_update': {
      const id = typeof update.compactionId === 'string' ? update.compactionId : '';
      if (!id) return null;
      let row = state.compactions.get(id);
      if (!row) {
        closeOpenRow(state);
        row = pushRow(state, { kind: 'compaction', compactionId: id, status: 'in_progress', summary: '', error: '', replay });
        state.compactions.set(id, row);
      }
      if (typeof update.status === 'string' && update.status) row.status = update.status;
      if (Array.isArray(update.summary)) row.summary = blocksText(update.summary).slice(0, MAX_TEXT);
      if (update.error !== undefined) row.error = typeof update.error === 'string' ? update.error : '';
      return 'rows';
    }
    case 'compaction_summary_chunk': {
      const row = state.compactions.get(update.compactionId);
      if (!row) return null;
      row.summary = (row.summary + textOf(update.content)).slice(-MAX_TEXT);
      return 'rows';
    }
    case 'subagent_update':
      return applySubagent(state, update, { replay }) ? 'rows' : null;
    case 'session_message':
    case 'session_message_chunk': {
      const id = typeof update.messageId === 'string' ? update.messageId : '';
      if (!id) return null;
      let row = state.messages.get(id);
      if (!row) {
        closeOpenRow(state);
        row = pushRow(state, { kind: 'message', messageId: id, sender: update.senderSessionId || null, recipient: update.recipientSessionId || null, text: '', replay });
        state.messages.set(id, row);
      }
      if (update.sessionUpdate === 'session_message') {
        if (Array.isArray(update.content)) row.text = blocksText(update.content).slice(-MAX_TEXT);
        if (update.senderSessionId !== undefined) row.sender = update.senderSessionId || null;
        if (update.recipientSessionId !== undefined) row.recipient = update.recipientSessionId || null;
      } else {
        row.text = (row.text + textOf(update.content)).slice(-MAX_TEXT);
      }
      return 'rows';
    }
    default:
      return null;
  }
}

/** The user's own message, drawn at once (agy echoes it as live user chunks, which fold into this row). Starts a turn. */
export function addUserMessage(state, text, attachments = []) {
  closeOpenRow(state);
  const turn = startTurn(state);
  const row = pushRow(state, { kind: 'user', text: String(text || ''), attachments: attachments.map((a) => ({ kind: a.kind || 'file', name: a.name || '', mimeType: a.mimeType || '', data: a.preview || '' })), replay: false, typed: true });
  row.closed = true;
  turn.userRowId = row.id;
  return row;
}

/** A turn ended: the streaming bubble closes; failures and refusals become a notice row; the turn keeps its usage. */
export function endTurn(state, { stopReason, usage, error } = {}) {
  closeOpenRow(state);
  state.running = false;
  if (usage && typeof usage === 'object') state.usage = usage;
  const turn = turnById(state, state.turn);
  if (turn && !turn.endedAt) {
    turn.endedAt = now();
    turn.stopReason = stopReason || 'end_turn';
    if (usage && typeof usage === 'object') turn.usage = usage;
  }
  if (stopReason === 'error' && error?.message) pushRow(state, { kind: 'notice', text: error.message, severity: 'error' });
  else if (stopReason === 'refusal') pushRow(state, { kind: 'notice', text: 'The model declined to continue.', severity: 'warning', code: 'refusal' });
  else if (stopReason === 'max_tokens') pushRow(state, { kind: 'notice', text: 'The reply reached the model\'s output limit.', severity: 'warning', code: 'max_tokens' });
  else if (stopReason === 'max_turn_requests') pushRow(state, { kind: 'notice', text: 'The turn reached its request limit.', severity: 'warning', code: 'max_turn_requests' });
  else if (stopReason === 'cancelled') pushRow(state, { kind: 'notice', text: 'Stopped.', severity: 'info', code: 'cancelled' });
}

/** Tool rows still pending or running when a turn ends did not finish: shown as stopped. */
export function settleOpenTools(state) {
  for (const row of state.tools.values()) {
    if (row.status === 'pending' || row.status === 'in_progress') {
      row.status = 'failed';
      if (row.startedAt && !row.endedAt) row.endedAt = now();
    }
  }
  for (const row of state.compactions.values()) if (row.status === 'in_progress') row.status = 'cancelled';
}

/** The live output of a terminal SynaBun runs for the agent (the bridge's `terminal:output`). True when a row shows it. */
export function applyTerminalOutput(state, { terminalId, output, truncated, exitStatus } = {}) {
  if (typeof terminalId !== 'string' || !terminalId) return false;
  const text = String(output ?? '');
  state.terminals.set(terminalId, {
    output: text.length > MAX_TERMINAL ? text.slice(-MAX_TERMINAL) : text,
    truncated: !!truncated || text.length > MAX_TERMINAL,
    exitStatus: exitStatus && typeof exitStatus === 'object' ? { exitCode: Number.isInteger(exitStatus.exitCode) ? exitStatus.exitCode : null, signal: exitStatus.signal || null } : null,
  });
  if (state.terminals.size > 64) state.terminals.delete(state.terminals.keys().next().value);
  for (const row of state.tools.values()) if (row.content.some((item) => item.type === 'terminal' && item.terminalId === terminalId)) return true;
  return false;
}

/** A one-line summary of a tool row for its header (command, path or title). */
export function toolSummary(row) {
  const input = row?.rawInput && typeof row.rawInput === 'object' ? row.rawInput : {};
  const command = typeof input.command === 'string' ? input.command : Array.isArray(input.command) ? input.command.join(' ') : '';
  if (row?.toolKind === 'execute' && command) return command;
  const path = row?.locations?.[0]?.path || (typeof input.path === 'string' ? input.path : '') || (typeof input.file_path === 'string' ? input.file_path : '');
  return row?.title || path || command || row?.toolKind || 'tool';
}

/** Context gauge: { percent, label, used, size, cost } from the last usage_update, or null. */
export function contextGauge(state) {
  const context = state?.context;
  if (!context || !(context.size > 0)) return null;
  const percent = Math.max(0, Math.min(100, Math.round((context.used / context.size) * 100)));
  return { percent, label: `${compactNumber(context.used)} / ${compactNumber(context.size)}`, used: context.used, size: context.size, cost: context.cost || null };
}

/** 1234 → "1.2k", 50000 → "50k", 1000000 → "1M". */
export function compactNumber(n) {
  const value = Number(n) || 0;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 ? 1 : 0)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(value));
}

/** The turn a row belongs to, or null. */
export function turnOf(state, row) {
  return turnById(state, row?.turn);
}

/** The rows of one turn, in order. */
export function rowsOfTurn(state, turnId) {
  return state.rows.filter((row) => row.turn === turnId);
}

/** The text of what the agent answered in a turn (its message rows, joined): what Copy copies. */
export function answerOfTurn(state, turnId) {
  return rowsOfTurn(state, turnId).filter((row) => row.kind === 'agent' && row.text).map((row) => row.text).join('\n\n');
}

/** The last thing the user asked: { text, turnId } (Retry sends it again), or null. */
export function lastPrompt(state) {
  for (let i = state.rows.length - 1; i >= 0; i -= 1) {
    const row = state.rows[i];
    if (row.kind === 'user' && row.text && row.text.trim()) return { text: row.text, turnId: row.turn };
  }
  return null;
}

/** The id of the last row of every finished turn: where its footer (usage, Copy, Retry) goes. */
export function turnFooters(state) {
  const last = new Map();
  for (const row of state.rows) if (row.turn) last.set(row.turn, row.id);
  const out = new Map();
  for (const turn of state.turns) {
    if (!turn.endedAt && !turn.replay) continue;
    const rowId = last.get(turn.id);
    if (rowId) out.set(rowId, turn);
  }
  return out;
}

/** "3s", "1m 05s", or '' for a missing or negative span. */
export function durationLabel(startedAt, endedAt) {
  if (!startedAt || !endedAt || endedAt < startedAt) return '';
  const seconds = Math.round((endedAt - startedAt) / 1000);
  if (seconds < 60) return `${Math.max(seconds, 1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** A turn's usage as "1.2k in · 300 out · 40 thinking · 800 cached" parts, or [] when it has none. */
export function usageParts(usage) {
  if (!usage || typeof usage !== 'object') return [];
  const parts = [];
  const add = (value, key) => { if (Number.isFinite(value) && value > 0) parts.push({ key, value: compactNumber(value) }); };
  add(usage.inputTokens, 'in');
  add(usage.outputTokens, 'out');
  add(usage.thoughtTokens, 'thinking');
  add(usage.cachedReadTokens, 'cached');
  return parts;
}
