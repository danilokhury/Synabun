/**
 * What the Assistant page sees of a dispatched OpenCode worker: its tool calls.
 *
 * Claude and Codex workers reach the page through the sync socket
 * (sidepanel:provider-event); an OpenCode worker's events stay on its own
 * isolated `opencode serve`, which only its V2 panel reads, so server.js keeps
 * them off the socket. The Assistant's run stage and agents tray
 * (public/shared/assistant/asst-scenes.js activityOf) only need to know which
 * call the worker is on, so this relay forwards a copy of each tool call's
 * start (its part turns `running`) and finish (`completed` or `error`), once
 * each, in the real event shape: { provider: 'opencode', runId, eventType:
 * 'message.part.updated', event: { sessionID, part: { type: 'tool', tool,
 * callID, state: { status, input } } } }. Nothing else goes: no text,
 * reasoning or file parts, no output, title, metadata or error text, and of
 * the call's input only the short fields a step line names ("Editing
 * router.js", "Running npm test", "Opening localhost:3344"), made safe
 * (public/shared/assistant/asst-redact.js: credentials masked, a command's
 * heredoc and inline file bodies omitted, an address without its query) and
 * then clipped; a file tool's path only; never an edit's text, a written file
 * or a typed value.
 *
 * Bounded: at most one event per run every `minIntervalMs`; a call seen inside
 * the window waits for its end, the newest replacing the one before (so the
 * page always learns the latest call), and a run's state goes with its end.
 * Calls overlap (OpenCode runs tools in parallel): the end of a call older than
 * one still running is no news to the page and is never sent, so it can never
 * replace or follow the newer call's start, in the window or after it.
 */

import { redactSecrets, safeCommand, safeUrl } from '../public/shared/assistant/asst-redact.js';

export const OPENCODE_ACTIVITY_MIN_MS = 250;
const MAX_CALLS_PER_RUN = 256; // callIDs remembered per run (start / finish seen)
const MAX_RUNS = 64;           // runs tracked at once (each forgotten at its end)
const FIELD_MAX = 300;         // characters of an input field
const PLAN_ITEMS = 20;         // todowrite items forwarded
const PLAN_ITEM_MAX = 120;

const str = (v) => (v == null ? '' : String(v));
const clip = (v, max = FIELD_MAX) => {
  const s = str(v).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
};

/** Input fields a step line reads (asst-tool-kinds.js sayCall), whatever the tool. */
const STEP_FIELDS = Object.freeze([
  'command', 'cmd', // a shell command
  'filePath', 'file_path', 'path', 'notebook_path', // a file, a folder
  'pattern', 'query', 'q', 'include', 'glob', // a search
  'url', 'href', // a page
  'element', 'label', 'name', 'target', 'selector', 'ref', 'key', 'keys', // a browser control, a key, never what is typed into it
  'subagent_type', 'agent', 'action', // a sub-agent, a desktop or memory action
]);
const STEP_NUMBERS = Object.freeze(['offset', 'limit']);
/** Fields that are a step only for some tools: a click's visible text, a sub-agent's one-line description. */
const TOOL_FIELDS = Object.freeze([
  [/(^|_)browser_(click|hover)$/i, ['text']],
  [/^task$/i, ['description']],
]);
/** File tools: their step is the file, so the path is all that goes (a read keeps its line range). */
const FILE_TOOLS = /^(?:read|edit|write|patch|multiedit|notebook_?(?:read|edit))$/i;
const PATH_FIELDS = Object.freeze(['filePath', 'file_path', 'path', 'notebook_path']);
const COMMAND_FIELDS = new Set(['command', 'cmd']);
const URL_FIELDS = new Set(['url', 'href']);

/** A field as its step line may say it: a command and an address made safe, anything else masked, then clipped. */
function safeField(key, value) {
  const text = COMMAND_FIELDS.has(key) ? safeCommand(value) : URL_FIELDS.has(key) ? safeUrl(value) : redactSecrets(value);
  return clip(text);
}

/**
 * The part of a tool call's input its step line needs: a command with its credentials masked and its heredoc or
 * inline file bodies left out, an address as scheme://host/path, a file tool's path only; every field masked
 * (asst-redact.js) before it is clipped. Never an edit's text, a file's content or a typed value.
 */
export function stepInput(tool, input) {
  const i = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = {};
  const file = FILE_TOOLS.test(str(tool));
  const fields = file ? [...PATH_FIELDS] : [...STEP_FIELDS];
  if (!file) for (const [re, extra] of TOOL_FIELDS) if (re.test(str(tool))) fields.push(...extra);
  for (const key of fields) {
    const value = i[key];
    if (typeof value === 'string' && value.trim()) out[key] = safeField(key, value);
    else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      const joined = safeField(key, value.join(' '));
      if (joined) out[key] = joined;
    }
  }
  if (file && !/^read$/i.test(str(tool))) return out;
  for (const key of STEP_NUMBERS) if (Number.isFinite(i[key])) out[key] = i[key];
  if (file) return out;
  // A plan: its items' words and states (planState's current step), never more than a short list.
  if (Array.isArray(i.todos)) {
    out.todos = i.todos.filter((x) => x && typeof x === 'object').slice(0, PLAN_ITEMS)
      .map((x) => ({ content: clip(redactSecrets(x.content ?? x.text), PLAN_ITEM_MAX), status: clip(x.status, 24) }));
  }
  return out;
}

/**
 * One OpenCode provider event ({ provider, runId, eventType, event }, the
 * adapter's onEvent payload) as a tool call's start or finish, or null for
 * anything else (text, reasoning, files, a sub-agent's session, other events).
 * → { callID, phase: 'start' | 'finish', payload } with `payload` the compact
 * copy the page gets.
 */
export function openCodeToolCall(payload) {
  if (!payload || payload.provider !== 'opencode' || payload.childSession) return null;
  if (!/^message[.:]part[.:]updated$/i.test(str(payload.eventType))) return null;
  const event = payload.event && typeof payload.event === 'object' ? payload.event : {};
  const part = event.part && typeof event.part === 'object' ? event.part : null;
  if (!part || part.type !== 'tool' || !str(part.tool).trim()) return null;
  const status = str(part.state?.status);
  const phase = status === 'running' ? 'start' : status === 'completed' || status === 'error' ? 'finish' : null;
  if (!phase) return null; // pending: its input is still streaming
  const tool = clip(part.tool, 160);
  const callID = str(part.callID || part.id);
  const sessionID = str(event.sessionID || part.sessionID) || undefined;
  return {
    callID,
    phase,
    payload: {
      provider: 'opencode',
      runId: payload.runId,
      eventType: 'message.part.updated',
      event: {
        sessionID,
        part: { id: str(part.id) || undefined, sessionID, messageID: str(part.messageID) || undefined, type: 'tool', callID, tool, state: { status, input: stepInput(tool, part.state?.input) } },
      },
    },
  };
}

const TERMINAL = new Set(['sidepanel:run-completed', 'sidepanel:run-failed', 'sidepanel:run-stopped']);

/**
 * createOpenCodeActivityRelay({ send, minIntervalMs, now, setTimer, clearTimer })
 * observe(message) takes every NativeLoopRuntime message (onEvent): it returns
 * true for an OpenCode provider event, which it never passes on as it is
 * (its tool calls go to send() as compact copies, at the bounded rate), and
 * false for everything else, which the caller sends as before.
 */
export function createOpenCodeActivityRelay({
  send,
  minIntervalMs = OPENCODE_ACTIVITY_MIN_MS,
  now = () => Date.now(),
  setTimer = (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
  clearTimer = (timer) => clearTimeout(timer),
} = {}) {
  const runs = new Map(); // runId → { calls: Map(callID → { phase, seq }), seq, last, pending, timer }

  function forget(runId) {
    const state = runs.get(runId);
    if (!state) return;
    if (state.timer) clearTimer(state.timer);
    runs.delete(runId);
  }

  function stateOf(runId) {
    let state = runs.get(runId);
    if (!state) {
      while (runs.size >= MAX_RUNS) forget(runs.keys().next().value);
      state = { calls: new Map(), seq: 0, last: -Infinity, pending: null, timer: null };
      runs.set(runId, state);
    }
    return state;
  }

  /** A call that started after the one `seq` names is still running. */
  function newerRunning(state, callID, seq) {
    for (const [id, c] of state.calls) if (id !== callID && c.phase === 'start' && c.seq > seq) return true;
    return false;
  }

  function emit(state, message) {
    state.last = now();
    try { send(message); } catch { /* the socket is gone */ }
  }

  function flush(runId) {
    const state = runs.get(runId);
    if (!state) return;
    state.timer = null;
    const message = state.pending;
    state.pending = null;
    if (message) emit(state, message);
  }

  function observe(message) {
    const type = str(message?.type);
    if (TERMINAL.has(type)) {
      const runId = message.run?.runId || message.runId;
      if (runId) forget(runId);
      return false;
    }
    if (type !== 'sidepanel:provider-event' || message.event?.provider !== 'opencode') return false;
    const call = openCodeToolCall(message.event);
    const runId = str(message.run?.runId || message.event?.runId);
    if (!call || !runId) return true;
    const state = stateOf(runId);
    // Once per call and phase (OpenCode updates a running part many times); a start after its finish is old news.
    const seen = state.calls.get(call.callID);
    if (call.callID && (seen?.phase === call.phase || seen?.phase === 'finish')) return true;
    const seq = seen?.seq ?? ++state.seq; // the order calls started in (a call first seen at its end starts now)
    if (call.callID) {
      state.calls.delete(call.callID);
      state.calls.set(call.callID, { phase: call.phase, seq });
      while (state.calls.size > MAX_CALLS_PER_RUN) state.calls.delete(state.calls.keys().next().value);
    }
    // An older call's end, while a newer call runs: the page shows the newer one, and keeps it.
    if (call.phase === 'finish' && newerRunning(state, call.callID, seq)) return true;
    const out = { type: 'sidepanel:provider-event', run: message.run, event: call.payload };
    const wait = state.last + minIntervalMs - now();
    if (wait <= 0 && !state.timer) { emit(state, out); return true; }
    state.pending = out; // the newest call the window held back
    if (!state.timer) state.timer = setTimer(() => flush(runId), Math.max(0, wait));
    return true;
  }

  return {
    observe,
    /** Runs with state (tests and devtools). */
    size: () => runs.size,
    /** Drop every run's state and timer (shutdown). */
    clear() { for (const runId of [...runs.keys()]) forget(runId); },
  };
}
