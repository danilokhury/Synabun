import { claudeStallSeconds } from './claude-stall-policy.js';
import { detectProject as memoryProject } from '../../mcp-server/dist/config.js';
// ── Claude Agent SDK bridge for the Claude sidepanel (claude-skin) ──
//
// Replaces the per-turn `claude --print` spawn architecture with one long-lived
// interactive SDK session per tab (streaming-input mode). What this buys:
//   - Real pre-execution permission prompts via canUseTool (no kill/respawn)
//   - AskUserQuestion answered in-place via updatedInput (process stays alive)
//   - ExitPlanMode → genuine plan approval; same turn continues on approve
//   - Live token streaming (includePartialMessages → stream_event deltas)
//   - Subagent visibility (parent_tool_use_id on every message)
//   - Native interrupt, permission modes, rewindFiles, supportedCommands
//
// Wire contract: the frontend receives `{type:'event', event:{…stream-json…}}`,
// `control_request`, `done`, `aborted`, `reattach_result`, `engine`,
// `mode_changed`, `rewind_result`, `control_cancelled`, `turn_started` (the CLI
// began a turn on its own — a background agent finished, a scheduled wakeup
// fired). Synthetic subagent events are `subagent` start / background / stop.
// Inbound: `query`, `control_response`, `compact`, `abort`, `set_permission_mode`,
// `rewind`, `mcp_status`, `dispose` (the tab was closed — end the session now).
//
// Ownership model: the session object owns the Query, the input queue, the
// event buffer, pending permission resolvers, cost baseline and watchdog. The
// WebSocket merely binds/unbinds to it — an "orphan" is just a session with no
// WS bound, so page-refresh reattach is the same object.

import { query, startup } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_EFFORT_LEVELS } from './claude-model-catalog.js';
import { CLAUDE_NOT_INSTALLED, resolveClaudeSdkExecutable } from './claude-executable.js';
import { diagnoseLaunchFailure, isNativeBinaryLaunchFailure } from './native-binary-runtime.js';
import { normalizePanelSession, startSignature, applyPanelSessionOptions, liveSettingsPatch, normalizeMcpServers, mergeTabMcpServers } from './claude-panel-session.js';
import { SESSION_REQUESTS, runSessionRequest, slimRewind, slimMcpStatus } from './claude-panel-requests.js';
import { applyTemporaryOptions, plansDirsOf, snapshotPlanFiles, planFileOfToolCall, removeTemporaryPlanFiles } from './claude-temporary.js';
import { rootBypassBlock } from './claude-bypass-policy.js';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
export const SDK_VERSION = (() => {
  try { return _require('@anthropic-ai/claude-agent-sdk/package.json').version; }
  catch { /* package.json not in exports map — walk up from the entry file */ }
  try {
    let dir = dirname(_require.resolve('@anthropic-ai/claude-agent-sdk'));
    for (let i = 0; i < 5; i++) {
      const pj = `${dir}/package.json`;
      if (existsSync(pj)) {
        const v = JSON.parse(readFileSync(pj, 'utf-8'));
        if (v.name === '@anthropic-ai/claude-agent-sdk') return v.version;
      }
      dir = dirname(dir);
    }
  } catch {}
  return 'unknown';
})();

// Bookkeeping tools that must never hit the user with a permission card.
// Read-only tools (Read/Glob/Grep/…) are allowed by the SDK's own default-mode
// evaluation before canUseTool is consulted, so they need no entry here.
const AUTO_ALLOW = new Set(['TodoWrite', 'TodoRead', 'Task', 'Agent', 'ToolSearch', 'AskUserQuestion', 'ExitPlanMode']);
// (AskUserQuestion/ExitPlanMode are listed because they take dedicated paths below,
//  never the generic prompt path.)

const ORPHAN_GRACE_MS = 30 * 60 * 1000;   // survive sleep / refresh / tab throttling
const IDLE_REAP_MS = 15 * 60 * 1000;      // end idle Queries to cap resident CLI processes
const ORPHAN_BUFFER_CAP = 2000;           // entries; stream_event never buffered while detached
const DELTA_FLUSH_MS = 40;                // coalescing window for text/thinking deltas
const WS_BACKPRESSURE_BYTES = 1024 * 1024;

// Stall-recovery herd control: when stalls are correlated (an MCP server or
// the API went down), every session's watchdog fires in the same window and
// each retry spawns a fresh CLI subprocess. Cap concurrent recreates; user-
// initiated prompts are never limited.
const MAX_CONCURRENT_RECREATES = 2;
let _recreatesInFlight = 0;
const _recreateWaiters = [];
function _acquireRecreateSlot() {
  if (_recreatesInFlight < MAX_CONCURRENT_RECREATES) { _recreatesInFlight++; return Promise.resolve(); }
  return new Promise(r => _recreateWaiters.push(r));
}
function _releaseRecreateSlot() {
  const next = _recreateWaiters.shift();
  if (next) next();
  else _recreatesInFlight = Math.max(0, _recreatesInFlight - 1);
}
const STALL_WARN_SEC = 30;
const BOOT_TIMEOUT_SEC = 120;
const MAX_RETRIES = 2;

// What the sidepanel may rely on from this bridge, sent in the engine hello. The
// panel is served statically and reloads at any time, while this module only
// changes when the server restarts: a panel feature that needs bridge support
// shows only when its name is listed here.
export const PANEL_CAPABILITIES = Object.freeze([
  'capabilities',
  'session_info',     // system/session_info after init: account, output styles, models, agents
  'reload_skills',    // inbound `reload_skills` → `reload_result` + a fresh commands_list
  'permission_context', // control_request carries the CLI's title, reason, path, MCP server, flags
  'permission_modes_v2', // dontAsk and auto are accepted; `modeFromSettings` leaves the mode to the user's settings
  'deny_interrupt',   // a deny response may carry `interrupt: true` (deny and stop the turn)
  'ask_annotations',  // AskUserQuestion answers keep their `annotations`
  'tool_policy',      // query `toolPolicy`: 'full' | 'read-only' | 'no-web'
  'elicitation',      // MCP elicitation as control_request subtype `elicitation` (for clients that declare the feature)
  'session_settings', // query `session`: fallback model, limits, directories, plugins, strict MCP, instructions, sandbox, thinking, fast mode, output style, agent
  'reload_plugins',   // inbound `reload_plugins` → `reload_result` + fresh commands_list / mcp_status / plugins_list
  'message_flags',    // session.hookEvents / promptSuggestions / subagentText / agentSummaries → the matching SDK options
  'task_control',     // inbound `stop_task` / `background_tasks` → `task_control_result`; system/session_crons events
  'origin_human',     // a query marked `typed: true` is sent with origin {kind:'human'}
  'session_requests', // inbound `session_request {id, what, args}` → `session_response`: context_usage, usage, mcp_status, mcp_reconnect, mcp_toggle, rewind_preview
  'rewind_stats',     // `rewind_result` carries filesChanged / insertions / deletions
  'session_title',    // query `title` names a new session where the CLI reads it
  'conversation_rewind', // inbound `rewind_conversation {messageUuid, userMessageUuid?}` → `rewind_conversation_result`
  'cache_cost',       // system/cache_cost when resuming re-caches an expired context, and (source 'model_switch') after a model change
  'warm_start',       // inbound `warm` (a query without a prompt): start the CLI process before the first message
  'permission_rules', // session_request `permission_rules` / `forget_session_rules`; reattach_result carries `grantedRules`
  'mcp_dynamic',      // session_request `mcp_set_servers {servers}` (a tab's remote servers, live) and `mcp_permission_mode {serverName, mode}`
  'session_state',    // the CLI's session_state_changed events reach the panel (running / idle / requires_action)
  'session_settings_v2', // query `session` also reads: allowedTools, disallowedTools, tools, planModeInstructions, mcpServers, synabunAlwaysLoad, agents, skills, overlay, debug
  'bypass_mode',      // Bypass is the SDK's bypassPermissions: a tab's process can take it (query `permissionMode`, `set_permission_mode`, the plan card's `planDecision`); `mode_changed` carries `reason` when it was refused or undone
  'mode_statements',  // the page numbers its statements of the tab's mode (`modeSeq`) and every mode report (init, status, mode_changed, reattach_result) returns the number applied; `set_permission_mode {fromSettings}` and a plan answer's `planExit` go back to the mode the user's settings name
  'temporary_chat',   // query / warm / `config` `temporary: true`: a conversation that leaves nothing behind (lib/claude-temporary.js); `temporary_ended` when its process is gone
]);

const WARM_TTL_MS = 3 * 60 * 1000; // an unused warm process is closed after this

const ACCOUNT_UNAVAILABLE = 'The Claude account this tab uses is no longer set up in SynaBun. Pick another one with /account, or add it again in Settings.';
// A panel session nothing configured yet was asked to start (see ensureQuery).
const CONFIG_REQUIRED = 'This tab\'s session was not started: its account and restrictions did not come with the request. Reload the page, or send a message first.';
// Panel sessions, a temporary chat (lib/claude-temporary.js): what it is told when it cannot go on, or cannot do something.
const TEMPORARY_ENDED = 'This temporary chat is over: its session is gone and nothing of it was kept. Start a new chat to go on.';
const TEMPORARY_REFUSED = 'A conversation that has started cannot be made temporary. Start a new chat and choose Temporary before its first message.';
const TEMPORARY_NO_REWIND = 'A temporary chat keeps no file checkpoints and no transcript, so there is nothing to rewind to.';
const TEMPORARY_NO_RESTART = 'In a temporary chat the session cannot be restarted: its conversation would be lost.';

// Permission modes. The two newer ones are offered to panel sessions only;
// every other caller keeps the four it had.
const CLASSIC_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
const PANEL_PERMISSION_MODES = [...CLASSIC_PERMISSION_MODES, 'dontAsk', 'auto'];

// Panel sessions and Bypass. A tab's process is launched able to take
// bypassPermissions (the SDK's allowDangerouslySkipPermissions), and only what
// the user chose puts it there: the mode a query or a starting control states
// (the mode control, a restored tab), `set_permission_mode`, the plan card's
// own choice, or the user's settings when the tab never picked a mode
// (permissions.defaultMode, which the CLI reads itself). Whether the user's
// settings or a policy turn Bypass off is the CLI's decision: it starts in
// another mode, or refuses the switch, and the tab is told.
const BYPASS = 'bypassPermissions';
const BYPASS_NOT_TAKEN = 'Claude Code did not start this session in Bypass: your Claude Code settings or a policy turn it off.';
// A Bypass the session reports that is not its mode. The sentence says whose it
// was: nobody's the user knows of, their own earlier pick or settings (the
// session was in Bypass before, by their choice), or the mode their settings
// started this process in before they picked another one.
const BYPASS_FOREIGN = 'Something other than you switched this session to Bypass. It was switched back.';
const BYPASS_LEFT = 'This session reported Bypass again after it had left it. It was switched back.';
const BYPASS_FROM_SETTINGS = 'Your Claude Code settings started this session in Bypass. It was switched to the mode this tab is in.';
const SETTINGS_MODE_UNKNOWN = 'This session did not start in the mode your Claude Code settings name, so it cannot go back to it: it runs in Default until it restarts.';
const bypassRefusalText = (why) => {
  const text = String(why || '');
  if (/disabled by settings/i.test(text)) return 'Bypass is turned off by your Claude Code settings or a policy (permissions.disableBypassPermissionsMode).';
  if (/not launched/i.test(text)) return 'Bypass is not available in this session: its process was started without it.';
  return `Claude Code refused Bypass${text ? `: ${text.slice(0, 200)}` : '.'}`;
};
// Why a process cannot be launched able to take Bypass ('' when it can). Claude
// Code exits at start when asked for it as root outside a sandbox, so there the
// option is left out and the mode is refused here instead
// (lib/claude-bypass-policy.js; `deps.bypassBlock` stands in for it in tests).
function panelBypassBlock() {
  if (typeof deps?.bypassBlock === 'function') { try { return String(deps.bypassBlock() || ''); } catch { return ''; } }
  return rootBypassBlock();
}

// Tool policies a panel tab can pick: tools removed from the session.
const TOOL_POLICY_DISALLOW = {
  'read-only': ['Edit', 'Write', 'NotebookEdit', 'Bash'],
  'no-web': ['WebFetch', 'WebSearch'],
};

// The list for this server: capabilities that depend on what the host wired in.
export function panelCapabilities() {
  const caps = [...PANEL_CAPABILITIES];
  if (typeof deps?.claudeAccountEnv === 'function') caps.push('accounts'); // query `accountId`: run the tab under another Claude account
  if (deps?.sessionOps === true) caps.push('session_ops'); // the host serves /api/claude-code/sessions/:id/{title,tag,fork,subagents} and DELETE
  if (deps?.permissionRulesEdit === true) caps.push('permission_rules_edit'); // the host serves DELETE /api/claude-code/permission-rules
  if (deps?.settingsView === true) caps.push('settings_view'); // the host serves GET /api/claude-code/settings/resolved
  if (deps?.accountSettings === true) caps.push('account_settings'); // those settings routes take `account`: a named-account tab sees its own files
  if (deps?.bypassPolicy === true) caps.push('bypass_policy'); // the host serves GET /api/claude-code/bypass-policy (is Bypass turned off, and by what)
  return caps;
}

// Per-session switch for everything the sidepanel adds on top of the shared
// session class. Only createClaudeBridge() passes it: the Assistant brain and
// every other ClaudeSession caller keep the options, events and defaults they
// had before.
const PANEL_SESSION_OPTS = Object.freeze({ panel: true });
// Panel sessions: the messages, besides a query and a warm start, that can start
// a process. Only these apply the `config` they carry (see handleMessage). Every
// other message looks at the session or needs a live one: what it carries is
// not applied, so a request that only looks (permission rules, usage, MCP
// status) binds no account, takes no lock and leaves a cold session cold.
const STARTING_CONTROLS = new Set(['compact', 'rewind', 'rewind_conversation']);
const controlCanStart = (msg) => STARTING_CONTROLS.has(msg?.type) || (msg?.type === 'session_request' && msg.what === 'rewind_preview');
// Panel sessions: the messages that wait in line while the session is between
// two processes (see _newTurn): the ones that can start a process, the one
// request that ends it, and the two whose effect depends on what came before
// them (a stop, a permission-mode switch: handled ahead of a prompt that is
// still waiting, the stop would stop nothing and the prompt would undo the
// switch). Everything else (a permission answer, a request that only looks) is
// handled when it arrives, as it always was.
const takesTurn = (msg) => msg?.type === 'query' || msg?.type === 'warm' || controlCanStart(msg)
  || (msg?.type === 'session_request' && msg.what === 'forget_session_rules')
  || msg?.type === 'abort' || msg?.type === 'set_permission_mode';

let deps = null; // injected once from server.js — see configureClaudeBridge()
export function configureClaudeBridge(d) { deps = d; }

// windowId:sessionId → session (only while detached, for reattach)
const _detached = new Map();
// every live session, for shutdown + sweeps
const _allSessions = new Set();

function _orphanKey(wid, sid) { return sid ? `${wid}:${sid}` : wid; }

function log(...args) { console.log('[claude-sdk]', ...args); }

// Panel sessions, a temporary chat (lib/claude-temporary.js): the plan files
// Claude Code wrote for one that still have to be removed. path → { plansDirs,
// since, before, ended, last }. One is removed once the pump of the process that wrote
// it has settled (`ended`), and stays owed after that removal, whether it
// removed the file or found none: the pump settles when the SDK's own cleanup
// stops waiting for the process, which can be before the process is gone, and
// a write that was slow puts the file back. The path is forgotten by the sweep
// that runs once the process can no longer be alive (`last`), when that sweep
// did not fail. A removal that fails keeps the path: every later sweep tries it
// again, and so does the shutdown, which waits for no process and forgets what
// it removed. Empty unless a temporary chat wrote a plan.
const _temporaryPlansOwed = new Map();

// How long the SDK lets a session's process live once it ends it
// (ProcessTransport.close() in sdk.mjs, SDK 0.3.288): two seconds to exit by
// itself, then SIGTERM, then five more before SIGKILL. Its cleanup, which the
// pump waits for, gives up after the first two.
const SDK_PROCESS_EXIT_MS = 2000 + 5000;
// The last sweep of a temporary chat's plan files, counted from the moment its
// pump settled (the SDK ended the process before that): a second later than
// the process can live.
const TEMPORARY_PLANS_LAST_SWEEP_MS = SDK_PROCESS_EXIT_MS + 1000;

function _removeOwedTemporaryPlans({ all = false } = {}) {
  if (!_temporaryPlansOwed.size) return;
  let removed = 0;
  let failed = 0;
  for (const [path, owed] of [..._temporaryPlansOwed]) {
    if (!all && !owed.ended) continue;
    const result = removeTemporaryPlanFiles([path], owed);
    removed += result.removed.length;
    if (result.failed.length) { failed++; continue; }
    if (all || owed.last) _temporaryPlansOwed.delete(path);
  }
  if (removed) log(`temporary chat: removed ${removed} plan file${removed === 1 ? '' : 's'} it wrote`);
  if (failed) log(`temporary chat: ${failed} plan file${failed === 1 ? '' : 's'} could not be removed and will be tried again`);
}

function cleanEnv() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) =>
      k !== 'CLAUDECODE' &&
      !k.startsWith('VSCODE_') &&
      k !== 'TERM_PROGRAM' &&
      k !== 'TERM_PROGRAM_VERSION'
    )
  );
  env.ENABLE_TOOL_SEARCH = 'true';
  return env;
}

function validateWorkDir(cwd) {
  if (!cwd) return null;
  if (process.platform !== 'win32' && /^[A-Za-z]:[\\\/]/.test(cwd)) return null;
  if (process.platform === 'win32' && cwd.startsWith('/')) return null;
  if (!existsSync(cwd)) return null;
  return cwd;
}

// Push-based AsyncIterable feeding the SDK's streaming-input mode.
function createInputQueue() {
  const buf = [];
  let wake = null;
  let closed = false;
  return {
    push(m) { if (closed) return false; buf.push(m); if (wake) { const w = wake; wake = null; w(); } return true; },
    close() { closed = true; if (wake) { const w = wake; wake = null; w(); } },
    get closed() { return closed; },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (buf.length) yield buf.shift();
        if (closed) return;
        await new Promise(r => { wake = r; });
      }
    },
  };
}

// Optional per-session overrides (used by the assistant brain; the sidepanel
// passes none): { ownerKey, systemPromptAppend, settingSources, hooks,
// mcpHeaders, extraMcpServers, maxBudgetUsd, env, disallowedTools,
// allowedTools, permissionMode, model, effort, cwd, windowId, sessionId,
// planPermission, planHook, planDenyMessage, planExitMode, planModeInstructions }.
function mergeHookMatchers(base = {}, extra = {}) {
  const merged = { ...base };
  for (const [event, matchers] of Object.entries(extra || {})) {
    if (!Array.isArray(matchers) || !matchers.length) continue;
    merged[event] = [...(merged[event] || []), ...matchers];
  }
  return merged;
}

export class ClaudeSession {
  constructor(ws, opts = {}) {
    this.ws = ws;
    this.opts = opts && typeof opts === 'object' ? opts : {};
    this.panel = this.opts.panel === true; // a sidepanel tab (see PANEL_SESSION_OPTS)
    this.windowId = this.opts.windowId || null;
    this.sessionId = this.opts.sessionId || null;       // claude session id (from init/result events)
    this.model = this.opts.model || null;
    this.cwd = this.opts.cwd || null;
    this.effort = this.opts.effort || null;
    this.permissionMode = this.opts.permissionMode || 'default';

    this.q = null;               // live Query or null
    this.input = null;           // input queue feeding the Query
    this.abortController = null;
    this.pumpPromise = null;

    this.inTurn = false;
    this.pendingTurns = 0;       // user messages pushed minus results received
    this.swallowResults = 0;     // results to swallow (produced by interrupt()) — no done, no accounting
    this.swallowDeadline = 0;    // staleness guard: swallow entries expire after 15s
    this.bootComplete = false;
    this.lastEventTime = Date.now();
    this.lastActivity = Date.now();
    this.lastPrompt = null;
    this.stallRetries = 0;

    // The Claude Code executable the current Query was started with (see
    // ensureQuery): what a launch failure is diagnosed against.
    this._claudeExecutable = null;

    this.pendingPerms = new Map(); // requestId → { toolName, resolve, input, kind, wire }
    this.alwaysAllowed = new Set();

    // Work the CLI comes back to without a new prompt, after the turn that started
    // it has ended: background tasks (agents, shells, monitors — the CLI's
    // background_tasks_changed level signal) and session crons (ScheduleWakeup,
    // CronCreate, /loop — reported to the Stop hook). Both live inside one CLI
    // process, so ending the Query kills them; _onProcessGone() resets them.
    this._bgTasks = new Map();       // task_id → { task_id, task_type, description, ambient }
    this._sessionCrons = [];
    // Panel sessions: the permission updates granted from cards ("Always"), as
    // the /permissions view lists them. Session-scoped ones live in the CLI
    // process and are dropped with it; the others are in the settings files.
    this._grantedRules = [];
    this._bgAgentIds = new Set();    // Task/Agent tool_use ids that went to the background
    this._queryGen = 0;              // per Query, so a replaced one's hook callbacks are ignored

    // Turn-accounting cross-checks (see _handleResult and _checkStall).
    this._lastPushAt = 0;            // last user message pushed into the Query
    this._lastResultAt = 0;          // last result the CLI delivered
    this._resultOwesTurn = false;    // that result said another queued turn follows
    this._outputSinceResult = false; // main-thread output since that result

    this.costBySession = new Map(); // sessionId → last cumulative total_cost_usd baseline

    this.orphanBuffer = null;    // non-null while detached
    this.orphanResynced = false;
    this.orphanKillTimer = null;
    this.destroyed = false;

    // Stable SynaBun browser-routing identity for this chat session. Sent as
    // X-Synabun-Terminal on the SynaBun MCP entry so the Neural Interface
    // routes this session's tab-less browser calls to its OWN tab — and keeps
    // the same tab across ensureQuery() re-creations (stall recovery), which
    // would otherwise mint a fresh Mcp-Session-Id and acquire a new tab.
    this.synabunOwnerKey = this.opts.ownerKey || `sidepanel-${randomUUID()}`;

    // Delta coalescing state: blockKey → { event, text, timer }
    this._deltaBuf = new Map();

    // Random start offset de-phases the 15s watchdogs of sessions created in
    // the same tick (page reload restores N tabs at once) so their stall
    // checks — and any resulting recoveries — don't align.
    this._watchdogStartTimer = setTimeout(() => {
      this._watchdogStartTimer = null;
      if (this.destroyed) return;
      this._watchdog = setInterval(() => this._checkStall(), 15_000);
      this._watchdog.unref?.();
    }, Math.floor(Math.random() * 15_000));
    this._watchdogStartTimer.unref?.();
    // Self-heartbeat the session lock while a live Query exists — covers the
    // detached window where client heartbeats stop but the CLI still writes JSONL.
    this._lockBeat = setInterval(() => {
      if (this.q && this.sessionId && this.windowId && !this.temporary) {
        try { deps.heartbeatLock(this.sessionId, this.windowId); } catch {}
      }
    }, 30_000);
    this._lockBeat.unref?.();
    this._idleReaper = setInterval(() => this._maybeReapIdle(), 60_000);
    this._idleReaper.unref?.();

    _allSessions.add(this);
  }

  // ── wire helpers ──────────────────────────────────────────────────────────

  send(data) {
    if (this.destroyed) return;
    if (this.orphanBuffer) {
      // High-volume deltas are not buffered while detached — full assistant
      // messages still arrive and carry the final content.
      if (data?.type === 'event' && data.event?.type === 'stream_event') return;
      this.orphanBuffer.push(data);
      if (this.orphanBuffer.length > ORPHAN_BUFFER_CAP) {
        this.orphanBuffer.shift();
        this.orphanResynced = true;
      }
      return;
    }
    if (this._replaying) {
      // Mid-replay: queue behind the buffered events to preserve ordering
      // (same delta-drop policy as detachment — the window is a few ticks).
      if (data?.type === 'event' && data.event?.type === 'stream_event') return;
      this._replayQueue?.push(data);
      return;
    }
    if (this.ws && this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify(data)); } catch {}
    }
  }

  sendEvent(event) { this.send({ type: 'event', event }); }

  sendDone(code) {
    this.send({ type: 'done', code });
  }

  // ── query lifecycle ──────────────────────────────────────────────────────

  // `warm: true` (panel sessions, see the `warm` message) starts the CLI process
  // without a prompt: the first real ensureQuery() adopts it if the session's
  // configuration is still the one it was started with.
  ensureQuery({ warm = false } = {}) {
    if (this.q) return this.q;
    // Panel sessions under a named Claude account: every process start checks
    // the account again (a message, a recreation after a stall, a lost-session
    // recovery, a rewind, a warm start). One that is gone refuses the start:
    // the process would otherwise run under the ambient default identity while
    // the tab says another. The environment validated here is the one used.
    this._startRefused = null;
    // Panel sessions: a process starts only for a session that was given its
    // tab's configuration, by a query or by the starting control that reached
    // it last (_establishFromControl). After a server restart, or when an idle tab's
    // socket was replaced, the session object holds nothing but the id: started
    // as it is, it would run under the default identity with every tool and
    // default permissions while the tab says otherwise. Every start comes
    // through here, so this is the one place that refuses.
    if (this.panel && !this._established) {
      this._startRefused = this._coldRefusal || { code: 'config_required', message: CONFIG_REQUIRED };
      log(`session create refused: ${this._startRefused.code} (resume=${this.sessionId || 'none'})`);
      return null;
    }
    // Panel sessions, a temporary chat whose process is gone: the conversation
    // lived in that process and nowhere else. A new one would answer without
    // it, so none is started (every start comes through here).
    if (this.temporary && this._tempOver) {
      this._closeWarm();
      this._startRefused = { code: 'temporary_ended', message: TEMPORARY_ENDED };
      log('session create refused: the temporary chat has ended');
      return null;
    }
    let accountEnv = null;
    if (this.panel && this.accountId) {
      accountEnv = this._accountEnvOf(this.accountId);
      if (!accountEnv) {
        this._closeWarm();
        this._startRefused = { code: 'account_unavailable', message: ACCOUNT_UNAVAILABLE };
        log(`session create refused: the account "${this.accountId}" is no longer set up`);
        return null;
      }
    }
    // Which Claude Code runs this session: the user's own installation, always.
    // SynaBun carries none (lib/external-tools.js at the package root) and the
    // SDK is never left to look for one. The host answers (deps.claudeExecutable,
    // lib/claude-executable.js): an explicit override from cli-config.json
    // ("claude-skin": { "sdkExecutable": "…" }), else the installed Claude Code.
    // The model picker lists that same installation's models, so an alias means
    // in the session what it meant in the picker.
    //
    // Nothing installed is an ordinary state: the start is refused with the
    // sentence the panel shows its install help on, and nothing was started.
    // The SDK itself is never called without an executable; only a host that
    // brings its own query factory and no resolver (a test) starts without one.
    let executable = null;
    if (typeof deps.claudeExecutable === 'function') {
      try { executable = deps.claudeExecutable() || null; } catch { executable = null; }
    } else if (deps.sdkExecutable) {
      executable = resolveClaudeSdkExecutable({ sdkExecutable: deps.sdkExecutable });
    }
    const ownFactory = typeof (warm ? deps.startupFactory : deps.queryFactory) === 'function';
    if (!executable?.path && (typeof deps.claudeExecutable === 'function' || !ownFactory)) {
      this._closeWarm();
      this._startRefused = { code: 'claude_not_installed', message: executable?.reason || CLAUDE_NOT_INSTALLED };
      log(`session create refused: no Claude Code to run (${executable?.reason || 'not installed'})`);
      return null;
    }
    if (this._warm) {
      const w = this._warm;
      this._warm = null;
      clearTimeout(w.timer);
      if (!warm && w.ready && !w.closed && w.sig === this._warmSignature()) {
        this.input = w.input;
        this.abortController = w.abortController;
        this.bootComplete = false;
        this.lastEventTime = Date.now();
        this._lastResultAt = 0;
        this._resultOwesTurn = false;
        this._outputSinceResult = false;
        this._deltaBuf.clear();
        log(`session create: adopted the warm process (resume=${this.sessionId || 'none'})`);
        this._startModeSeen = false;
        this.q = w.handle.query(this.input);
        if (this.panel) this._noteProcessStarted();
        this.pumpPromise = this._pump(this.q);
        return this.q;
      }
      this._closeWarm(w);
    }
    // A new CLI process starts with no background work of its own; anything the
    // previous one still reported died with it.
    this._onProcessGone();
    const gen = ++this._queryGen;
    this.input = createInputQueue();
    this.abortController = new AbortController();
    this.bootComplete = false;
    this.lastEventTime = Date.now();
    this._lastResultAt = 0;
    this._resultOwesTurn = false;
    this._outputSinceResult = false;
    this._deltaBuf.clear();

    const workDir = validateWorkDir(this.cwd) || deps.PACKAGE_ROOT;
    const sessionOpts = this.opts || {};
    const options = {
      cwd: workDir,
      permissionMode: this.permissionMode || 'default',
      // Opt-in (the assistant brain): lets plan mode or a later switch reach bypassPermissions.
      ...(sessionOpts.allowDangerouslySkipPermissions === true ? { allowDangerouslySkipPermissions: true } : {}),
      includePartialMessages: deps.includePartialMessages !== false,
      enableFileCheckpointing: true, // required for Query.rewindFiles()
      // CRITICAL: without these two the SDK loads neither the Claude Code system
      // prompt nor any ~/.claude settings/hooks/CLAUDE.md/MCP servers.
      systemPrompt: sessionOpts.systemPromptAppend
        ? { type: 'preset', preset: 'claude_code', append: String(sessionOpts.systemPromptAppend) }
        : { type: 'preset', preset: 'claude_code' },
      settingSources: Array.isArray(sessionOpts.settingSources) ? sessionOpts.settingSources : ['user', 'project', 'local'],
      canUseTool: (name, input, opts) => this._onCanUseTool(name, input, opts || {}),
      hooks: mergeHookMatchers({
        PreCompact: [{
          hooks: [async () => {
            this.sendEvent({ type: 'system', subtype: 'compact_started', message: 'Auto-compacting context…' });
            return {};
          }],
        }],
        // Stop fires at the end of every main-thread turn, and its input lists the
        // session crons (ScheduleWakeup, CronCreate, /loop) that will wake this
        // session later. The idle reaper must not end a session waiting on one.
        Stop: [{
          hooks: [async (input) => {
            if (gen === this._queryGen) {
              const before = JSON.stringify(this._sessionCrons);
              this._sessionCrons = Array.isArray(input?.session_crons) ? input.session_crons : [];
              // Panel sessions: the scheduled wakeups of this session, when they change.
              if (this.panel && JSON.stringify(this._sessionCrons) !== before) this._announceCrons();
            }
            return {};
          }],
        }],
        // Opt-in (the assistant brain): plan mode refuses before permission rules
        // run, so a user allow rule (Edit(*), mcp__fs__*) cannot turn a code
        // change back on. Subagents too.
        ...(typeof sessionOpts.planHook === 'function' ? {
          PreToolUse: [{
            hooks: [async (input) => {
              if (this.permissionMode !== 'plan' || sessionOpts.planHook(input?.tool_name, input?.tool_input || {}) !== 'deny') return {};
              this.send({ type: 'stderr', text: `Plan mode: declined ${input?.tool_name}` });
              const reason = sessionOpts.planDenyMessage?.(input?.tool_name) || `Plan mode: ${input?.tool_name} was not run.`;
              return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
            }],
          }],
        } : {}),
      }, sessionOpts.hooks),
      // `typesafe:'off'` on a query (the live skin test) keeps this CLI's hooks
      // from paying for judgments: they read the kill switch from their env.
      // (Panel sessions: the CLI reports running / idle / requires_action only when
      // asked to; `idle` is its own word that a turn is over. See _noteSessionState.)
      env: { ...cleanEnv(), ...(this.typesafeOff ? { SYNABUN_TYPESAFE: 'off' } : {}), ...(sessionOpts.env || {}), ...(accountEnv || {}), ...(this.panel ? { CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' } : {}) },
      abortController: this.abortController,
      stderr: (text) => {
        const t = String(text || '').trim();
        if (t) this.send({ type: 'stderr', text: t });
      },
    };
    if (Array.isArray(sessionOpts.disallowedTools) && sessionOpts.disallowedTools.length) options.disallowedTools = [...sessionOpts.disallowedTools];
    if (this.panel) {
      // The process is launched able to take Bypass, so the tab's mode control
      // can switch to it and back on the live session (see BYPASS above). Where
      // it cannot be (root), a tab that asks for Bypass runs in Default.
      const bypassBlock = panelBypassBlock();
      this._bypassLaunched = !bypassBlock;
      if (this._bypassLaunched) options.allowDangerouslySkipPermissions = true;
      else if (options.permissionMode === BYPASS) {
        options.permissionMode = this.permissionMode = 'default';
        this.sendEvent(this._numbered({ type: 'mode_changed', mode: 'default', reason: bypassBlock }));
      }
      // A tab that never picked a mode starts in the one the user's settings
      // name (permissions.defaultMode): omitted, the CLI decides.
      if (this._modeFromSettings) delete options.permissionMode;
      this._startModeSeen = false; // the first init of this process says which mode it started in
      this._startAskedBypass = options.permissionMode === BYPASS;
      this._startedFromSettings = !('permissionMode' in options); // the CLI chose the starting mode (permissions.defaultMode)
      this._launchMode = this._startedFromSettings ? '' : options.permissionMode; // what the process is in until it says otherwise (see _noteProcessStarted)
      if (this._startAskedBypass) this._bypassHeld = true;
      const removed = TOOL_POLICY_DISALLOW[this.toolPolicy];
      if (removed) options.disallowedTools = [...new Set([...(options.disallowedTools || []), ...removed])];
      // MCP servers asking the user for input or a sign-in. Only for a client
      // that said it can show the card: left unset, the CLI declines for us.
      if (this.clientFeatures?.has('elicitation')) {
        options.onElicitation = (request, opts) => this._promptElicitation(request || {}, opts?.signal);
      }
      // The panel has a stop control per background task, so an interrupt of the
      // turn leaves background agents and shells running.
      if (this.clientFeatures?.has('task_stop')) options.perTaskStopAffordance = true;
      // Resuming a session whose prompt cache has expired pays to write it
      // again: the CLI says how much at SessionStart.
      options.hooks = mergeHookMatchers(options.hooks, {
        SessionStart: [{
          hooks: [async (input) => {
            if (gen === this._queryGen && input?.prompt_cache_likely_expired === true && Number(input?.estimated_cache_write_usd) > 0) {
              this.sendEvent({
                type: 'system', subtype: 'cache_cost', session_id: this.sessionId,
                source: String(input.source || ''),
                seconds_since_last_response: Number(input.seconds_since_last_response) || 0,
                estimated_cache_write_usd: Number(input.estimated_cache_write_usd),
              });
            }
            return {};
          }],
        }],
        // Changing the model mid-conversation sends the whole context to the new
        // model's cache with the next reply: the CLI says what that costs once
        // the switch is done (a headless set_model fires this with source 'sdk').
        PostModelSwitch: [{
          hooks: [async (input) => {
            if (gen === this._queryGen && input?.source !== 'resume' && Number(input?.estimated_cache_write_usd) > 0) {
              this.sendEvent({
                type: 'system', subtype: 'cache_cost', session_id: this.sessionId,
                source: 'model_switch',
                from_model: String(input.from_model || ''),
                to_model: String(input.to_model || ''),
                context_tokens: Number(input.context_tokens) || 0,
                prompt_cache_warm: input.prompt_cache_warm === true,
                estimated_cache_write_usd: Number(input.estimated_cache_write_usd),
              });
            }
            return {};
          }],
        }],
      });
    }
    if (Array.isArray(sessionOpts.allowedTools) && sessionOpts.allowedTools.length) options.allowedTools = [...sessionOpts.allowedTools];
    // The plan workflow the CLI puts inside its own plan-mode reminder (it keeps its preamble and the ExitPlanMode footer).
    if (typeof sessionOpts.planModeInstructions === 'string' && sessionOpts.planModeInstructions.trim()) options.planModeInstructions = sessionOpts.planModeInstructions;
    if (Number(sessionOpts.maxBudgetUsd) > 0) options.maxBudgetUsd = Number(sessionOpts.maxBudgetUsd);
    // Per-chat-session SynaBun identity: programmatic mcpServers shadows the
    // same-named user-scope entry from settingSources, so this session's
    // browser calls carry a stable X-Synabun-Terminal and get their own tab
    // (instead of colliding with other sidepanel chats / CLI windows on the
    // shared HTTP transport identity).
    if (deps.mcpUrl) {
      options.mcpServers = {
        SynaBun: {
          type: 'http',
          url: deps.mcpUrl,
          headers: {
            'X-Synabun-Terminal': this.synabunOwnerKey,
            'X-Synabun-Project': memoryProject(workDir),
            // (A temporary chat is never named to the memory server by a conversation id.)
            'X-Synabun-Memory-Session': (this.temporary ? null : this.sessionId) || this.synabunOwnerKey,
            ...(sessionOpts.mcpHeaders || {}),
          },
        },
      };
    }
    if (sessionOpts.extraMcpServers && typeof sessionOpts.extraMcpServers === 'object') {
      options.mcpServers = { ...(options.mcpServers || {}), ...sessionOpts.extraMcpServers };
    }
    // (A temporary chat has no transcript to resume from.)
    if (this.sessionId && !this.temporary) options.resume = this.sessionId;
    if (this.panel) {
      // A new session takes the name the user gave the tab; a conversation
      // rewind resumes at the chosen entry, once.
      if (!this.sessionId && this._title) options.title = this._title;
      if (this.sessionId && this._resumeAt) { options.resumeSessionAt = this._resumeAt; this._resumeAt = null; }
    }
    if (this.model) options.model = this.model;
    if (this.effort && CLAUDE_EFFORT_LEVELS.includes(this.effort)) {
      // Panel sessions use the typed option; every other caller keeps the flag it had.
      if (this.panel) options.effort = this.effort;
      else options.extraArgs = { effort: this.effort };
    }
    // Sibling-project access, same guard as legacy --add-dir
    const parentDir = dirname(workDir);
    if (parentDir && parentDir !== workDir && dirname(parentDir) !== parentDir) {
      options.additionalDirectories = [parentDir];
    }
    // The tab's own session settings (fallback model, limits, directories,
    // plugins, instructions, sandbox, thinking, fast mode, output style, agent).
    // The host's own MCP entries, before a tab adds its servers: setMcpServers
    // replaces the whole dynamic set, so these go back in with every change.
    this._hostMcpServers = { ...(options.mcpServers || {}) };
    if (this.panel && this.panelSession) {
      // (A temporary chat writes no debug log: the log holds what the session said.)
      const wantsDebug = this.temporary && this.panelSession.start?.debug;
      const cfg = wantsDebug ? { ...this.panelSession, start: { ...this.panelSession.start, debug: false } } : this.panelSession;
      const notes = applyPanelSessionOptions(options, cfg, { model: this.model, validateDir: validateWorkDir, debugFile: this.temporary ? '' : this._debugFilePath() });
      if (wantsDebug) notes.push('A temporary chat writes no debug log.');
      for (const note of notes) this.sendEvent({ type: 'system', subtype: 'runtime_notice', level: 'warn', message: note });
      if (options.debugFile) this.sendEvent({ type: 'system', subtype: 'runtime_notice', level: 'info', message: `Debug log of this session: ${options.debugFile}` });
      this._liveApplied = { ...this.panelSession.live };
    }
    // Panel sessions, a temporary chat: nothing saved, memory readable. Applied
    // last, over everything above (lib/claude-temporary.js).
    if (this.panel && this.temporary) {
      // (Which of the session's MCP connections is SynaBun's is asked of the live process when a tool of one is called.)
      applyTemporaryOptions(options, { mcpUrl: deps.mcpUrl || '', mcpStatus: () => this.q?.mcpServerStatus?.() });
      this._tempPlansDirs = plansDirsOf(options.env, { cwd: workDir, settings: options.settings });
      if (!this._tempSince) {
        this._tempPlansBefore = snapshotPlanFiles(this._tempPlansDirs);
        this._tempSince = Date.now();
      }
    }
    // The executable resolved at the top of this call. The SDK uses
    // pathToClaudeCodeExecutable verbatim with zero validation, so it was vetted
    // there — notably a bare command name, which would ENOENT under the SDK's
    // spawn(shell:false).
    let runtimeLabel = 'unset';
    this._claudeExecutable = null;
    if (executable?.ignored) {
      log('ignoring sdkExecutable override:', executable.ignored);
      this.send({ type: 'stderr', text: `Ignoring sdkExecutable override — ${executable.ignored}` });
    }
    if (executable?.path) {
      options.pathToClaudeCodeExecutable = executable.path;
      this._claudeExecutable = executable.path;
      runtimeLabel = executable.source === 'override' ? 'override' : executable.path;
    }

    if (warm) {
      // Start the process now; hand it the input queue when the first prompt comes.
      // (`bypass`: started in Bypass, as the tab's stated mode or as the mode this session saw the user's
      // settings name. A process kept ready is a process of this session's all the same: see _mayBypass.)
      const w = { sig: this._warmSignature(), input: this.input, abortController: this.abortController, handle: null, ready: false, closed: false, timer: null, bypass: this._startAskedBypass === true || (this._startedFromSettings === true && this.permissionMode === BYPASS) };
      this._warm = w;
      log(`warm start: resume=${this.sessionId || 'none'} model=${this.model || 'default'} cwd=${workDir} cli=${runtimeLabel}`);
      const startupFactory = typeof deps.startupFactory === 'function' ? deps.startupFactory : startup;
      Promise.resolve().then(() => startupFactory({ options })).then((handle) => {
        if (w.closed) { try { handle.close(); } catch {} return; }
        w.handle = handle;
        w.ready = true;
      }).catch((err) => {
        log('warm start failed:', err?.message || err);
        if (this._warm === w) this._warm = null;
        w.closed = true;
      });
      w.timer = setTimeout(() => { if (this._warm === w) { this._warm = null; this._closeWarm(w); } }, WARM_TTL_MS);
      w.timer.unref?.();
      return null;
    }

    log(`session create: resume=${this.sessionId || 'none'} model=${this.model || 'default'} effort=${this.effort || 'default'} mode=${this.permissionMode} cwd=${workDir} sdk=${SDK_VERSION} cli=${runtimeLabel}${sessionOpts.ownerKey ? ` owner=${sessionOpts.ownerKey}` : ''}`);
    const queryFactory = typeof deps.queryFactory === 'function' ? deps.queryFactory : query;
    this.q = queryFactory({ prompt: this.input, options });
    if (this.panel) this._noteProcessStarted();
    this.pumpPromise = this._pump(this.q);
    return this.q;
  }

  // Everything a process is started with: a warm one is only adopted when
  // none of it changed between the first keystroke and the first message.
  _warmSignature() {
    return JSON.stringify([
      this.cwd || '', this.model || '', this.effort || '', this.permissionMode || '', !!this._modeFromSettings,
      this.toolPolicy || '', startSignature(this.panelSession), this.panelSession?.live || null,
      this.sessionId || '', this.accountId || '', this._title || '', [...(this.clientFeatures || [])].sort(),
      !!this.typesafeOff, this._resumeAt || '', !!this.temporary,
    ]);
  }

  _closeWarm(w = this._warm) {
    if (!w) return;
    if (this._warm === w) this._warm = null;
    clearTimeout(w.timer);
    w.closed = true;
    try { w.handle?.close(); } catch {}
    try { w.abortController?.abort(); } catch {}
    // (A process that was started in Bypass ended: the page is told when that is news, as for any other. See _mayBypass.)
    if (w.bypass) this._factsSettled();
  }

  // Panel sessions: the tab stated its mode (or its configuration) again while a
  // process is kept ready. One that was started with something else is ended
  // now, not at the next message: it would not be adopted anyway
  // (_warmSignature), so the turn starts on a process launched in the stated
  // mode, and nothing of this session's stays behind in a mode the tab left.
  _warmStillFits() {
    const w = this._warm;
    if (w && w.sig !== this._warmSignature()) this._closeWarm(w);
  }

  async _pump(q) {
    try {
      for await (const m of q) {
        if (this.destroyed) break;
        // A replaced query (stall recreate, config change) must stop feeding the
        // client — its late results would corrupt the new query's turn accounting.
        if (this.q !== q) break;
        this.lastEventTime = Date.now();
        try { this._translate(m); } catch (err) { log('translate error:', err.message); }
      }
      // Generator ended (input closed / process exit). If a turn was in flight
      // and this wasn't a deliberate teardown, surface it.
      if (!this.destroyed && this.q === q && this.inTurn) {
        log('query ended mid-turn');
        this._finishTurnWithError('Claude session ended unexpectedly.');
      }
    } catch (err) {
      if (this.destroyed || this.q !== q) return;
      const msg = err?.message || String(err);
      log('pump error:', msg);
      if (/No conversation found/i.test(msg)) { this._recoverLostSession(); return; }
      // The SDK cannot tell a permission problem from a libc mismatch: it buckets
      // every spawn error together and always blames musl/glibc. Diagnose it
      // properly, repair what we can, and fall back to the user's CLI.
      if (isNativeBinaryLaunchFailure(err)) { this._recoverNativeRuntime(err); return; }
      this._finishTurnWithError(msg);
    } finally {
      // Still current means the process went away on its own (exit, crash) rather
      // than through _endQuery, which already cleaned up.
      if (this.q === q) {
        this.q = null;
        this._onProcessGone();
      }
    }
  }

  // The CLI process behind this session is gone — ended, replaced or crashed. Its
  // background tasks and crons died with it: tell the panel, so it stops showing
  // agents that will never report back. Idempotent.
  _onProcessGone() {
    // Panel sessions, a temporary chat: its conversation lived in the process
    // that just ended and nowhere else. It is over, and the tab is told once.
    if (this.temporary && this._tempLive && !this._tempOver) {
      this._tempOver = true;
      this._removeTemporaryPlans();
      this.send({ type: 'temporary_ended' });
    }
    // Session-scoped permission rules lived in the process that just ended.
    this._grantedRules = this._grantedRules.filter(u => u.destination && u.destination !== 'session');
    const hadTasks = this._bgTasks.size > 0;
    this._bgTasks.clear();
    const hadCrons = this._sessionCrons.length > 0;
    this._sessionCrons = [];
    if (this.panel && hadCrons) this._announceCrons();
    // (Panel sessions: with the process gone nothing is in Bypass any more, and the page is told when that is news.)
    if (this.panel) this._factsSettled();
    for (const id of this._bgAgentIds) {
      this.sendEvent({
        type: 'subagent', subtype: 'stop', tool_use_id: id,
        is_error: true, status: 'stopped', session_id: this.sessionId,
      });
    }
    this._bgAgentIds.clear();
    if (hadTasks) {
      this.sendEvent({ type: 'system', subtype: 'background_tasks_changed', tasks: [], session_id: this.sessionId });
    }
  }

  // The environment of a named Claude account (its own config directory), or
  // null when that account cannot be used: an id that is not a plain name, a
  // profile removed in Settings (it resolves to no config directory), a registry
  // that throws. The one lookup behind every check: there is no fallback to an
  // empty environment, which would be the ambient default identity.
  _accountEnvOf(account) {
    if (typeof account !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(account) || typeof deps.claudeAccountEnv !== 'function') return null;
    let env = null;
    try { env = deps.claudeAccountEnv(account); } catch { env = null; }
    if (!env || typeof env.CLAUDE_CONFIG_DIR !== 'string' || !env.CLAUDE_CONFIG_DIR) return null;
    return env;
  }

  // A start ensureQuery() refused (see there): tell the tab why and close the
  // turn it is waiting on. False when the last start was not refused.
  _announceRefusedStart() {
    const refused = this._startRefused;
    if (!refused) return false;
    this._denyAllPending('Session error');
    this.inTurn = false;
    this.pendingTurns = 0;
    this.send({ type: 'error', code: refused.code, message: refused.message });
    this.sendDone(-1);
    return true;
  }

  // The account a panel query names, checked before the query touches anything.
  // Returns { account } ('' is the default account) or { code, message } when the
  // query must be refused: running it anyway would use the ambient default
  // identity while the tab says another one.
  _resolveQueryAccount(accountId, sessionId) {
    if (accountId === undefined) return { account: this.accountId || '' };
    const account = accountId === 'default' || accountId === '' || accountId === null ? '' : accountId;
    if (account && !this._accountEnvOf(account)) return { code: 'account_unavailable', message: ACCOUNT_UNAVAILABLE };
    // A conversation belongs to the account it started under: its transcript
    // lives in that account's config directory and cannot be resumed from another.
    // "Started under" is known once a message ran here (_accountBound). A session
    // object made for a cold resume (the server restarted, the page reattached
    // to nothing) only has the id: its first message says which account owns it.
    if (this._accountBound && this.sessionId && sessionId && sessionId === this.sessionId && account !== (this.accountId || '')) {
      return { code: 'account_change_refused', message: 'This conversation belongs to the account it started under. Start a new chat to use another account.' };
    }
    return { account };
  }

  // Panel sessions: a control that can start a process reached a session no
  // process has started for yet, and brings the tab's configuration (`config`:
  // the fields of a query, without a prompt). It is applied by the code a query
  // runs (_handleQuery: the account is validated, the lock taken, the tool
  // policy, permission mode and session settings set), and nothing is started
  // here: the message's own handling starts the process if it needs one.
  // Until a process has started, the latest configuration is the one that
  // counts: the tab may have changed (another account, other restrictions)
  // since an earlier control or a warm start brought one. So the earlier one is
  // dropped first, and a configuration that is refused leaves the session cold,
  // with the reason for the reply, never startable under what it replaced. A
  // control that brings none keeps what the session has.
  _establishFromControl(msg) {
    this._coldRefusal = null;
    const config = msg?.config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) return;
    this._established = false;
    this._handleQuery({ ...config, type: 'warm' }, { warmOnly: true, establishOnly: true });
  }

  // Panel sessions: a starting control whose configuration names another
  // conversation than the one this session has. New chat and the session menu
  // keep the tab's socket and tell the bridge nothing, so the tab can be on a
  // conversation the session's process was not started for. Judged exactly as
  // a prompt is (`sessionChanged` / `newChat` in _handleQuery): another session
  // id, or none where the session has one. A control without a configuration
  // says nothing about where the tab is, and changes nothing.
  _controlLeftConversation(msg) {
    const config = msg?.config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
    const sessionId = typeof config.sessionId === 'string' ? config.sessionId : '';
    return sessionId ? (!!this.sessionId && sessionId !== this.sessionId) : !!this.sessionId;
  }

  // Panel sessions: a process was started for this tab (not a warm one, which
  // is only a process kept ready). From here a control's configuration no
  // longer replaces the session's while the tab stays on this conversation,
  // and the conversation belongs to the account it started under, whether a
  // message or a control started it.
  _noteProcessStarted() {
    this._everStarted = true;
    this._accountBound = true;
    // What this process is in, and whether it may be in Bypass (see "what is" below):
    // a process launched in Bypass may be in it from its launch.
    this._cli = { q: this.q, mode: this._launchMode || '', may: this._startAskedBypass === true, at: 0, sends: 0 };
  }

  // Panel sessions: a turn at the session's process. Socket messages are
  // dispatched as they arrive and not awaited, so a message that ends the
  // process and waits for it to close (a control after New chat or a session
  // switch, a prompt that changes the conversation, a conversation rewind) used
  // to leave a window in which the next message started a replacement, which
  // the first one then took for its own. Now the message that waits on a
  // closing process holds the turn until what it does next is done, and the
  // messages of `takesTurn` that arrive meanwhile wait in line, first come
  // first served (handleMessage). While nobody holds it, nothing waits: a
  // message is handled in the tick it arrives, exactly as before there were turns.
  // `take()` returns null when the turn is the caller's at once (it was free, or
  // the caller holds it already) and a promise to wait on when it is not.
  // `release()` hands the turn to the next waiter and may be called twice.
  // A turn is held only across waits that end by themselves (a closing process
  // is given 5 s): a handler gives it up before it waits on the CLI or on the
  // disk and takes it again afterwards, so a call that never returns cannot
  // keep the tab's later messages waiting.
  _newTurn() {
    const turn = {
      held: false,
      take: () => {
        if (turn.held) return null;
        turn.held = true;
        if (!this._turnBusy) { this._turnBusy = true; return null; }
        return new Promise((resolve) => { (this._turnWaiters ||= []).push(resolve); });
      },
      release: () => {
        if (!turn.held) return;
        turn.held = false;
        const next = this._turnWaiters?.shift();
        if (next) next(); else this._turnBusy = false;
      },
    };
    return turn;
  }

  // Where a panel tab's debug log goes when it asked for one: a file in the
  // directory the host names. Without that directory there is no debug log
  // (the stream would otherwise land in stderr, which the panel prints).
  _debugFilePath() {
    if (!this.panel || !this.panelSession?.start?.debug) return '';
    const dir = typeof deps.debugDir === 'string' ? deps.debugDir : '';
    if (!dir) return '';
    try { mkdirSync(dir, { recursive: true }); } catch { return ''; }
    const key = String(this.sessionId || this.synabunOwnerKey || 'tab').replace(/[^\w-]/g, '_').slice(0, 80);
    return join(dir, `claude-${key}.log`);
  }

  // A permission update as the /permissions view needs it: its verb, where it
  // was written, the rules. Nothing else of the object is kept.
  _noteGranted(updates) {
    for (const u of Array.isArray(updates) ? updates : []) {
      if (!u || typeof u !== 'object' || typeof u.type !== 'string') continue;
      const slim = { type: u.type.slice(0, 40) };
      if (typeof u.behavior === 'string') slim.behavior = u.behavior.slice(0, 20);
      slim.destination = typeof u.destination === 'string' ? u.destination.slice(0, 40) : 'session';
      if (Array.isArray(u.rules)) slim.rules = u.rules.slice(0, 20).map(r => ({ toolName: String(r?.toolName || '').slice(0, 200), ...(r?.ruleContent != null ? { ruleContent: String(r.ruleContent).slice(0, 500) } : {}) }));
      if (typeof u.mode === 'string') slim.mode = u.mode.slice(0, 40);
      if (Array.isArray(u.directories)) slim.directories = u.directories.slice(0, 20).map(d => String(d).slice(0, 500));
      this._grantedRules.push(slim);
    }
    if (this._grantedRules.length > 100) this._grantedRules = this._grantedRules.slice(-100);
  }

  _cronList() {
    return this._sessionCrons.map(c => ({ id: String(c?.id || ''), schedule: String(c?.schedule || ''), recurring: c?.recurring === true, prompt: String(c?.prompt || '').slice(0, 400) }));
  }

  _announceCrons() {
    this.sendEvent({ type: 'system', subtype: 'session_crons', session_id: this.sessionId, crons: this._cronList() });
  }

  // ── temporary chat (panel sessions; lib/claude-temporary.js) ────────────────

  // Claude Code keeps a plan in a plans folder whatever the session's options
  // say (its own, or the one the settings name). The ones this session's tool
  // calls name are removed when the chat ends.
  _noteTemporaryPlans(m) {
    const content = m.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      const file = planFileOfToolCall(block, this._tempPlansDirs);
      if (file) (this._tempPlans ||= new Set()).add(file);
    }
  }

  // Called when the chat ends, by whichever way. The files are removed once the
  // pump of the process that wrote them has settled, not before: a write that
  // was under way would put the file back. `this.pumpPromise` is that process's
  // pump at every call (the one being ended, or the one that just ended by
  // itself). The pump settling is not the process being gone (the SDK's cleanup
  // waits two seconds for it, and the process may live five more), so the paths
  // stay owed and are swept once more when it can no longer be alive.
  _removeTemporaryPlans() {
    if (!this._tempPlans?.size) return;
    const owed = { plansDirs: this._tempPlansDirs, since: this._tempSince, before: this._tempPlansBefore, ended: false, last: false };
    for (const path of this._tempPlans) _temporaryPlansOwed.set(path, owed);
    this._tempPlans.clear();
    Promise.resolve(this.pumpPromise).catch(() => {}).then(() => {
      owed.ended = true;
      _removeOwedTemporaryPlans();
      // (Not kept alive for it: a server that shuts down meanwhile sweeps everything owed, shutdownAllBridges().)
      setTimeout(() => { owed.last = true; _removeOwedTemporaryPlans(); }, TEMPORARY_PLANS_LAST_SWEEP_MS).unref?.();
    });
  }

  // The tab left its temporary conversation (New chat): what is left of it goes,
  // and the session is an ordinary one until a temporary chat is chosen again.
  _leaveTemporary() {
    this._removeTemporaryPlans();
    this.temporary = false;
    this._tempLive = false;
    this._tempOver = false;
    this._tempSince = 0;
    this._tempPlansBefore = null;
  }

  // Whether this message makes, keeps or may not make the conversation a
  // temporary one. Chosen with the first message of a conversation (`temporary:
  // true`, and no session id: there is nothing to resume) and fixed from there.
  // Returns null, or { code, message } when the message must be refused.
  _takeTemporary(msg, sessionId) {
    const wants = msg.temporary === true;
    const leaves = sessionId ? (!!this.sessionId && sessionId !== this.sessionId) : !!this.sessionId;
    if (leaves) {
      // Another conversation. One that names a session and says it is temporary
      // is a temporary chat this session does not hold: it ended with its page.
      if (wants && sessionId) return { code: 'temporary_ended', message: TEMPORARY_ENDED };
      if (this.temporary) this._leaveTemporary();
      this.temporary = wants;
      return null;
    }
    // The same conversation. Nothing has started for it yet (at most a process
    // kept ready by a warm start): the latest word decides.
    if (!this._everStarted && !this.sessionId) {
      if (this.temporary && !wants) this._leaveTemporary();
      this.temporary = wants;
      return null;
    }
    // It has started: what it is does not change.
    if (this.temporary) return this._tempOver ? { code: 'temporary_ended', message: TEMPORARY_ENDED } : null;
    if (!wants) return null;
    if (this._everStarted) return { code: 'temporary_refused', message: TEMPORARY_REFUSED };
    // A session id this session never ran, said to be temporary: a temporary
    // chat from before the server restarted or the page came back. Over.
    return { code: 'temporary_ended', message: TEMPORARY_ENDED };
  }

  // What in this message would restart a live temporary chat's process (the
  // conditions of _handleQuery's restart, judged before anything is applied).
  _temporaryRestartReason(msg, { cwd, effort, account }) {
    if (cwd && this.cwd && cwd !== this.cwd) return 'the project folder';
    if (effort && effort !== this.effort && typeof this.q?.applyFlagSettings !== 'function') return 'the effort level';
    if (msg.typesafe !== undefined && (msg.typesafe === 'off') !== !!this.typesafeOff) return 'the judgment setting';
    if (msg.accountId !== undefined && account !== (this.accountId || '')) return 'the Claude account';
    if (msg.toolPolicy !== undefined && (TOOL_POLICY_DISALLOW[msg.toolPolicy] ? msg.toolPolicy : null) !== (this.toolPolicy || null)) return 'the tool policy';
    if (msg.session !== undefined && startSignature(normalizePanelSession(msg.session)) !== startSignature(this.panelSession || normalizePanelSession(null))) return 'the session settings';
    return '';
  }

  // A temporary chat cannot be resumed, so a stalled stream is not answered
  // with a new process: the turn is stopped and the tab is told. A process
  // that does not even take the stop is gone, and the chat with it.
  _stallTemporary() {
    log('stall in a temporary chat: stopping the turn, no restart');
    this.lastEventTime = Date.now();
    this.swallowResults++;
    this.swallowDeadline = Date.now() + 15_000;
    const q = this.q;
    let timer = null;
    const deadline = new Promise(r => { timer = setTimeout(() => r('timeout'), 10_000); timer.unref?.(); });
    Promise.race([q.interrupt().then(() => 'ok', () => 'failed'), deadline]).then((how) => {
      clearTimeout(timer);
      if (this.destroyed || this.q !== q) return;
      this.inTurn = false;
      this.pendingTurns = 0;
      this.lastActivity = Date.now();
      if (how === 'ok') {
        this.send({ type: 'error', message: 'The stream stalled, so the turn was stopped. A temporary chat cannot be restarted: send the message again.' });
      } else {
        this._endQuery({ graceful: false });
        this.send({ type: 'error', code: 'temporary_ended', message: TEMPORARY_ENDED });
      }
      this.sendDone(-1);
    });
  }

  // True while the CLI has work it will come back to without a new prompt.
  _hasPendingWork() {
    return this._bgTasks.size > 0 || this._sessionCrons.length > 0;
  }

  _finishTurnWithError(message) {
    this._denyAllPending('Session error');
    this.inTurn = false;
    this.pendingTurns = 0;
    this.send({ type: 'error', message });
    this.sendDone(-1);
  }

  async _endQuery({ graceful = true } = {}) {
    const q = this.q;
    this._closeWarm();
    if (!q) return;
    // Panel sessions: the process this call ends is the one it found, held here
    // before the wait below (its input, its pump, its abort controller). A
    // process started while this one is closing (a recovery, a prompt after an
    // idle reap) belongs to whoever started it and is never aborted from here.
    // Any other session reads its own fields at each step, as it always did.
    const own = this.panel ? { input: this.input, pumpPromise: this.pumpPromise, abortController: this.abortController } : this;
    // (Panel sessions: a process that may be in Bypass may be until it has really
    // ended, which is the end of the wait below, not this call. See _mayBypass.)
    const closing = this.panel && this._cli?.q === q && this._cli.may === true;
    if (closing) this._closingBypass = (this._closingBypass || 0) + 1;
    this.q = null;
    this._onProcessGone();
    this._denyAllPending('Session ending');
    // The dying query's in-flight turn can never deliver a result (pump guard
    // drops late ones) — reset accounting so recreation paths start clean.
    this.inTurn = false;
    this.pendingTurns = 0;
    this.swallowResults = 0;
    try { own.input?.close(); } catch {}
    if (graceful && own.pumpPromise) {
      await Promise.race([own.pumpPromise, new Promise(r => setTimeout(r, 5000))]);
    }
    try { own.abortController?.abort(); } catch {}
    if (closing) { this._closingBypass--; this._factsSettled(); }
  }

  _recreateQuery(continuationPrompt) {
    const sid = this.sessionId;
    return this._endQuery({ graceful: false }).then(() => {
      if (this.destroyed) return;
      this.sessionId = sid;
      this.ensureQuery();
      if (this._announceRefusedStart()) return;
      if (continuationPrompt) this._pushUserText(continuationPrompt);
    });
  }

  _recoverLostSession() {
    log('session not found — retrying as new conversation');
    const prompt = this.lastPrompt;
    this.sessionId = null;
    this.sendEvent({ type: 'system', subtype: 'session_reset', message: 'Previous session was deleted. Starting fresh conversation.' });
    this._endQuery({ graceful: false }).then(() => {
      if (this.destroyed) return;
      this.sessionId = null;
      this.ensureQuery();
      if (this._announceRefusedStart()) return;
      if (prompt) this._pushUserText(prompt);
    });
  }

  /**
   * The user's Claude Code would not start.
   *
   * The SDK's own message for this always blames a musl/glibc mismatch, which is
   * only ever right on Linux — elsewhere the cause is a missing execute bit, a
   * quarantined download, a build for another processor or a file that is gone.
   * There is no other runtime to move to (SynaBun carries none), so the turn
   * ends with what is wrong with that installation and how to fix it.
   */
  _recoverNativeRuntime(err) {
    const dx = diagnoseLaunchFailure({ err, executable: this._claudeExecutable });
    log(`Claude Code failed to launch: kind=${dx.kind} executable=${this._claudeExecutable || 'unset'}`);
    this._finishTurnWithError(dx.message);
  }

  _pushUserText(text, images, { human = false } = {}) {
    const content = [];
    if (images?.length) {
      for (const img of images) {
        if (!img?.base64) continue;
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType || 'image/png', data: img.base64 },
        });
      }
    }
    if (text) content.push({ type: 'text', text });
    if (!content.length) return false;
    this.ensureQuery();
    if (this._announceRefusedStart()) return false;
    const ok = this.input.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: this.sessionId || '',
      // Only a prompt the user typed in the panel is stamped as human input
      // (never a queued, replayed or generated one).
      ...(human ? { origin: { kind: 'human' } } : {}),
    });
    if (ok) {
      this.inTurn = true;
      this.pendingTurns++;
      this.lastEventTime = Date.now();
      this.lastActivity = Date.now();
      this._lastPushAt = Date.now();
    }
    return ok;
  }

  // ── translation: SDKMessage → wire events ─────────────────────────────────

  _translate(m) {
    switch (m.type) {
      case 'system': {
        if (m.subtype === 'init') {
          this.bootComplete = true;
          if (m.session_id) {
            const prev = this.sessionId;
            this.sessionId = m.session_id;
            if (prev !== this.sessionId) log('sessionId from init:', this.sessionId);
          }
          // (A temporary chat: from here its conversation exists, in this process only.)
          if (this.temporary) this._tempLive = true;
          // Panel sessions: the mode the CLI says it is in (see _reportedMode).
          const told = this.panel ? this._reportedMode(m) : null;
          this.sendEvent(told ? told.event : m);
          if (told?.then) this.sendEvent(told.then);
          this._announceCapabilities();
          return;
        }
        // Panel sessions: a mode change the CLI reports between two inits.
        if (m.subtype === 'status' && this.panel && m.permissionMode) {
          const told = this._reportedMode(m);
          this.sendEvent(told.event);
          if (told.then) this.sendEvent(told.then);
          return;
        }
        if (m.subtype === 'background_tasks_changed') this._setBackgroundTasks(m.tasks);
        else if (m.subtype === 'task_notification') this._settleBackgroundAgent(m);
        else if (m.subtype === 'session_state_changed' && this.panel) this._noteSessionState(m.state);
        // Background work reporting in is activity: without this, a reaper tick
        // between "last task finished" and the turn the CLI starts to handle it
        // would end the session under that turn.
        if (m.subtype === 'background_tasks_changed' || String(m.subtype || '').startsWith('task_')) {
          this.lastActivity = Date.now();
        }
        // compact_boundary and any future system subtypes pass through
        this.sendEvent(m);
        return;
      }
      case 'stream_event': {
        this._noteMainThreadOutput(m);
        this._forwardStreamEvent(m);
        return;
      }
      case 'assistant': {
        this.bootComplete = true;
        this._noteMainThreadOutput(m);
        this._flushDeltas();
        this._synthesizeSubagentStarts(m);
        if (this.temporary) this._noteTemporaryPlans(m);
        this.sendEvent({ ...m });
        return;
      }
      case 'user': {
        if (!m.parent_tool_use_id) this._outputSinceResult = true;
        this._flushDeltas();
        this._synthesizeSubagentStops(m);
        this.sendEvent({ ...m });
        // The frontend renders tool results from synthetic `tool_result` events
        // (it has no handler for tool_result blocks inside user messages) — emit
        // one per block so existing updateToolResult() keeps working.
        const content = m.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'tool_result') {
              this.sendEvent({
                type: 'tool_result',
                tool_use_id: block.tool_use_id,
                content: block.content,
                is_error: !!block.is_error,
                parent_tool_use_id: m.parent_tool_use_id ?? null,
                session_id: m.session_id,
              });
            }
          }
        }
        return;
      }
      case 'result': {
        this._flushDeltas();
        this._handleResult(m);
        return;
      }
      default:
        this.sendEvent(m);
    }
  }

  // Main-thread (not subagent) output means the CLI is in a turn. Most turns start
  // with a prompt we pushed; the rest the CLI starts itself — a background agent
  // finished, a scheduled wakeup fired. Those have to be opened here, or the
  // reaper, detach and the stall watchdog treat a working session as idle and the
  // panel shows nothing running.
  _noteMainThreadOutput(m) {
    if (m.parent_tool_use_id) return;
    this._outputSinceResult = true;
    this.lastActivity = Date.now();
    if (this.inTurn) return;
    // The tail of a turn we just interrupted is still draining.
    if (this.swallowResults > 0 && Date.now() < this.swallowDeadline) return;
    this.inTurn = true;
    this.pendingTurns = Math.max(this.pendingTurns, 1);
    this.lastEventTime = Date.now();
    log(`turn started by the CLI for session ${this.sessionId || '(new)'}`);
    this.send({ type: 'turn_started' });
  }

  // The CLI's own word on whether it is in a turn. `idle` comes after a turn's
  // result: if this session still counts a turn open then, its count is off (the
  // same drift the stall watchdog finds much later). Close it after a short
  // wait, under the watchdog's own conditions.
  _noteSessionState(state) {
    if (state !== 'idle' || !this.inTurn) return;
    clearTimeout(this._idleCheck);
    this._idleCheck = setTimeout(() => {
      this._idleCheck = null;
      if (this.destroyed || !this.q || !this.inTurn || this.pendingPerms.size > 0) return;
      if (this._lastResultAt > this._lastPushAt && !this._outputSinceResult && !this._resultOwesTurn) {
        log('session reported idle with a turn still counted open; closing it');
        this.inTurn = false;
        this.pendingTurns = 0;
        this.lastActivity = Date.now();
        this.sendDone(0);
      }
    }, 2000);
    this._idleCheck.unref?.();
  }

  // background_tasks_changed carries the full set (replace, never merge). Ambient
  // tasks count: a Monitor the user asked for is ambient, and ending the Query
  // would kill it. The panel leaves them out of its indicator.
  _setBackgroundTasks(tasks) {
    this._bgTasks.clear();
    for (const t of Array.isArray(tasks) ? tasks : []) {
      if (!t?.task_id) continue;
      this._bgTasks.set(t.task_id, {
        task_id: t.task_id,
        task_type: t.task_type || '',
        description: t.description || '',
        ambient: !!t.ambient,
      });
    }
  }

  // A background agent reported back: close its card with the real outcome.
  _settleBackgroundAgent(m) {
    const id = m.tool_use_id;
    if (!id || !this._bgAgentIds.delete(id)) return;
    this.sendEvent({
      type: 'subagent', subtype: 'stop', tool_use_id: id,
      is_error: m.status !== 'completed', status: m.status || '',
      summary: typeof m.summary === 'string' ? m.summary : '',
      session_id: this.sessionId,
    });
  }

  _recordCost(m) {
    // Cost: total_cost_usd is cumulative for the process; on resumed sessions it
    // may or may not include pre-resume history. Self-calibrating baseline:
    if (typeof m.total_cost_usd === 'number' && m.total_cost_usd > 0) {
      const sid = m.session_id || this.sessionId;
      if (sid) {
        if (!this.costBySession.has(sid)) {
          // (A temporary chat has no stored cost: no record names it.)
          const stored = this.temporary ? 0 : (() => { try { return deps.getSessionCost(sid) || 0; } catch { return 0; } })();
          this.costBySession.set(sid, stored);
        }
        let base = this.costBySession.get(sid) || 0;
        let delta = m.total_cost_usd - base;
        if (delta < 0) {
          // Process-lifetime semantics (doesn't include resumed history) — recalibrate.
          log(`cost-semantics=process sid=${sid} base=${base} reported=${m.total_cost_usd}`);
          base = 0;
          delta = m.total_cost_usd;
        }
        this.costBySession.set(sid, m.total_cost_usd);
        // (A temporary chat: the money is counted, the session is not named.)
        if (delta > 0) { try { deps.addCost(delta, this.temporary ? null : sid); } catch {} }
      }
    }
  }

  _handleResult(m) {
    // Interrupt-produced result (abort / stall recovery): the client already got
    // its terminal signal — forward the event + cost, but skip turn accounting.
    if (this.swallowResults > 0 && Date.now() < this.swallowDeadline) {
      this.swallowResults--;
      if (m.session_id) this.sessionId = m.session_id;
      this._recordCost(m);
      this.sendEvent({ ...m });
      return;
    }
    this.swallowResults = 0; // expired entries never linger past a real result

    // queued_turn_count is how many sends the CLI still holds. 0 means no more
    // results are coming: the CLI merges prompts sent close together into one
    // turn, so counting one result per push could leave a turn open forever.
    this.pendingTurns = m.queued_turn_count === 0 ? 0 : Math.max(0, this.pendingTurns - 1);
    this.inTurn = this.pendingTurns > 0;
    this._lastResultAt = Date.now();
    this._resultOwesTurn = m.queued_turn_count > 0;
    this._outputSinceResult = false;
    this.stallRetries = 0;
    this.lastActivity = Date.now();

    if (m.subtype === 'error_during_execution' || m.subtype === 'error') {
      const errMsg = (m.errors && m.errors[0]) || m.error || m.result || 'unknown';
      log('CLI error result:', String(errMsg).slice(0, 200));
      if (typeof errMsg === 'string' && errMsg.includes('No conversation found')) {
        this._recoverLostSession();
        return;
      }
    }
    if (m.session_id) this.sessionId = m.session_id;
    this._recordCost(m);
    this.sendEvent({ ...m });
    this.sendDone(m.subtype === 'success' ? 0 : 1);
  }

  // Coalesce text/thinking deltas per content block; everything else forwards raw.
  _forwardStreamEvent(m) {
    const ev = m.event;
    const isTextDelta = ev?.type === 'content_block_delta' &&
      (ev.delta?.type === 'text_delta' || ev.delta?.type === 'thinking_delta');
    if (!isTextDelta) {
      this._flushDeltas();
      this._sendStreamEvent(m);
      return;
    }
    const key = `${m.parent_tool_use_id || ''}:${ev.index}`;
    let slot = this._deltaBuf.get(key);
    if (!slot) {
      slot = { m, text: '', kind: ev.delta.type, timer: null };
      this._deltaBuf.set(key, slot);
      slot.timer = setTimeout(() => this._flushDelta(key), DELTA_FLUSH_MS);
    }
    slot.text += ev.delta.type === 'text_delta' ? (ev.delta.text || '') : (ev.delta.thinking || '');
  }

  _flushDelta(key) {
    const slot = this._deltaBuf.get(key);
    if (!slot) return;
    this._deltaBuf.delete(key);
    clearTimeout(slot.timer);
    if (!slot.text) return;
    const ev = slot.m.event;
    const merged = {
      ...slot.m,
      event: {
        ...ev,
        delta: slot.kind === 'text_delta'
          ? { ...ev.delta, text: slot.text }
          : { ...ev.delta, thinking: slot.text },
      },
    };
    this._sendStreamEvent(merged);
  }

  _flushDeltas() {
    for (const key of [...this._deltaBuf.keys()]) this._flushDelta(key);
  }

  _sendStreamEvent(m) {
    // Drop live deltas under WS backpressure — final assistant events carry the content.
    if (!this.orphanBuffer && this.ws && this.ws.bufferedAmount > WS_BACKPRESSURE_BYTES) return;
    this.sendEvent({ ...m });
  }

  // Synthetic subagent lifecycle events: dumb-simple signal for the frontend
  // (which also gets the full nested feed via parent_tool_use_id passthrough).
  _synthesizeSubagentStarts(m) {
    const content = m.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type === 'tool_use' && (block.name === 'Task' || block.name === 'Agent')) {
        this._taskIds = this._taskIds || new Set();
        this._taskIds.add(block.id);
        this.sendEvent({
          type: 'subagent', subtype: 'start', tool_use_id: block.id,
          description: block.input?.description || '',
          subagent_type: block.input?.subagent_type || '',
          session_id: this.sessionId,
        });
      }
    }
  }

  _synthesizeSubagentStops(m) {
    if (!this._taskIds?.size) return;
    const content = m.message?.content;
    if (!Array.isArray(content)) return;
    // A Task/Agent call that went to the background returns at once with a
    // placeholder result; the agent keeps running and reports through
    // task_notification (_settleBackgroundAgent) — or dies with the process.
    const launchStatus = m.tool_use_result?.status;
    const launched = launchStatus === 'async_launched' || launchStatus === 'remote_launched';
    for (const block of content) {
      if (block?.type === 'tool_result' && this._taskIds.has(block.tool_use_id)) {
        this._taskIds.delete(block.tool_use_id);
        if (launched && !block.is_error) {
          this._bgAgentIds.add(block.tool_use_id);
          this.sendEvent({
            type: 'subagent', subtype: 'background', tool_use_id: block.tool_use_id,
            session_id: this.sessionId,
          });
          continue;
        }
        this.sendEvent({
          type: 'subagent', subtype: 'stop', tool_use_id: block.tool_use_id,
          is_error: !!block.is_error, session_id: this.sessionId,
        });
      }
    }
  }

  async _announceCapabilities() {
    const q = this.q;
    if (!q) return;
    try {
      const commands = await q.supportedCommands();
      if (this.q === q && Array.isArray(commands)) {
        this.sendEvent({ type: 'system', subtype: 'commands_list', commands });
      }
    } catch (err) { log('supportedCommands failed:', err.message); }
    try {
      const status = await q.mcpServerStatus();
      if (this.q === q && Array.isArray(status)) {
        this.sendEvent({ type: 'system', subtype: 'mcp_status', servers: status });
      }
    } catch { /* optional */ }
    // Panel sessions: what the CLI answered at initialize (account, output styles,
    // models, agents), once per Query. init repeats every turn; this does not change.
    if (this.panel && this._infoAnnouncedFor !== q && typeof q.initializationResult === 'function') {
      this._infoAnnouncedFor = q;
      try {
        const r = await q.initializationResult();
        if (this.q === q && r && typeof r === 'object') {
          this.sendEvent({
            type: 'system', subtype: 'session_info',
            info: {
              account: r.account || null,
              outputStyle: r.output_style || '',
              availableOutputStyles: Array.isArray(r.available_output_styles) ? r.available_output_styles : [],
              models: Array.isArray(r.models) ? r.models : [],
              agents: Array.isArray(r.agents) ? r.agents : [],
              fastModeState: r.fast_mode_state || '',
            },
          });
        }
      } catch (err) { log('initializationResult failed:', err.message); }
    }
  }

  // ── the latest statement of the mode wins ────────────────────────────────────

  // The mode is stated by a `set_permission_mode`, by a query that names one (or
  // leaves it to the user's settings) and by the answer to a plan card. A switch
  // that is still on its way when the next statement is made (the plan
  // approval's own, 50 ms later; a call the CLI has not answered yet) is void:
  // it is not sent, it assigns nothing, it announces nothing and its failure
  // puts no earlier mode back. So is one whose process was ended or replaced
  // meanwhile: the next process starts in the mode the session holds then.
  // _stateMode() counts a statement and returns its number; _modeSwitchStands()
  // says whether a switch made for statement `stamp` on process `q` still holds.
  _stateMode() {
    this._modeStatements = (this._modeStatements || 0) + 1;
    return this._modeStatements;
  }

  _modeSwitchStands(q, stamp) {
    return !this.destroyed && !!q && this.q === q && this._modeStatements === stamp;
  }

  // ── numbered statements (panel sessions) ─────────────────────────────────────

  // The page owns the tab's chosen mode and this session owns the mode it is
  // really in. The page numbers every statement it makes of the tab's mode
  // (`modeSeq`, growing per tab: a pick, a message that names a mode, a plan
  // card answer, a restatement). The number of the latest one applied goes back
  // with every report of the mode (init, status, mode_changed, the answer to
  // reattach), so the page can tell a report that is older than its own latest
  // statement and ignore it. Messages are not all handled in the order sent
  // (some wait their turn, a card's answer does not): a statement older than
  // the one applied is not applied. Returns false for such a statement. A
  // message without a number (a page that was not reloaded, any other host) is
  // applied as it always was.
  _takeStatement(seq) {
    if (!this.panel || !Number.isSafeInteger(seq) || seq < 1) return true;
    if (this._pageSeq !== undefined && seq < this._pageSeq) return false;
    this._pageSeq = seq;
    return true;
  }

  /**
   * A mode report as it goes to the page, once the page numbers its statements:
   * the mode the CLI is in (not the one the event was built for, when the switch
   * to that one is still under way: then `switching` names it), the number of
   * the latest statement applied, and whether the session may be in Bypass.
   */
  _numbered(ev) {
    return this.panel && this._pageSeq !== undefined ? { ...ev, ...this._modeFacts(ev.mode) } : ev;
  }

  /** A numbered statement older than the one applied was not applied: the page is told the number this session holds, takes it and says its mode again. */
  _statementDropped() {
    if (this.panel && this._pageSeq !== undefined) this.sendEvent({ type: 'mode_behind', modeSeq: this._pageSeq });
  }

  // ── what is, and whether it may be Bypass (panel sessions) ───────────────────

  // Two records, never one for the other. `this.permissionMode` is the mode the
  // tab stated: what the next process starts in, and what a switch is sent for.
  // `this._cli` is what the current process is in: the mode the CLI last
  // acknowledged (a setPermissionMode call that resolved) or reported, never one
  // that was only asked for. Reports to the page carry the second; a switch that
  // is under way is named beside it (`switching`), and one that failed or was
  // refused leaves it where it is and is told (`failed`).
  // "May be in Bypass" is a fact of its own that errs toward warning. A process
  // may be in Bypass from the moment a switch into it is sent, or it is launched
  // in it, or it says so itself. Only three things end that:
  //   - the CLI acknowledged a switch to another mode that was sent after it
  //     (`at`: the count of switches sent when the session last entered, or may
  //     have entered, Bypass);
  //   - the process has ended;
  //   - the process says it is in another mode and this session never sent it
  //     into Bypass itself (`sends`): then whatever Bypass it was in it entered
  //     at its launch or by itself, and its own messages are in order.
  // Nothing else does: not a switch away that was asked for and not answered,
  // not one that failed, and not a report of the CLI's after a switch into
  // Bypass of this session's own, which may have been written before it landed
  // (an acknowledgement and a message do not arrive in the order written).
  _cliOf(q) {
    if (this._cli?.q !== q) this._cli = { q, mode: '', may: false, at: 0, sends: 0 };
    return this._cli;
  }

  // (Also while the mode the tab stated is Bypass: a switch into it may still be
  // to send, and the next process starts in it. And while a process kept ready
  // for the next message lives that was started in Bypass: every process this
  // session owns counts, the live one, a closing one and the warm one.)
  _mayBypass() {
    const c = this._cli;
    return (!!this.q && c?.q === this.q && c.may === true) || this._warm?.bypass === true || (this._closingBypass || 0) > 0 || this.permissionMode === BYPASS;
  }

  // The facts every numbered mode report carries. `named`: the mode the report
  // is about (the tab's stated mode by default). Whenever the CLI is not in that
  // mode the report says both: `mode` is where the CLI is, `switching` the mode
  // the session holds for the tab (the switch to it is under way, still to be
  // sent, or failed and is sent again with the next message). The page never
  // has to take the first for the second.
  // The statement number orders what the page says; these facts need an order
  // of their own, because several reports go out between two statements and a
  // report can reach the page long after it was written (it waits in the buffer
  // of a detached session and is replayed after the answer to reattach, which
  // is written later and sent first). `modeRev` only grows for this session and
  // is given when the report is created, so a buffered message keeps the one it
  // was created with; `modeRevOf` names this session object, whose count it is
  // (a session created anew, after a server restart or for a tab that had
  // none, counts from 1 again under another id). The page lets a report with a
  // lower revision of the same session set the fact and nothing else.
  _modeFacts(named = this.permissionMode || 'default') {
    const c = this._cli;
    const mode = (this.q && c?.q === this.q && c.mode) || named;
    this._modeRev = (this._modeRev || 0) + 1;
    const facts = { mode, modeSeq: this._pageSeq, mayBypass: this._mayBypass(), modeRev: this._modeRev, modeRevOf: (this._modeRevOf ||= randomUUID()) };
    if (named && mode !== named) facts.switching = named;
    this._toldFacts = `${mode}|${facts.mayBypass}|${facts.switching || ''}`;
    return facts;
  }

  // The facts changed and nothing says so by itself (an acknowledgement nobody
  // announces, a switch that failed, the process ending): the page is told with
  // a `mode_state`, which is never a line in its transcript. `extra`: `failed`.
  _tellFacts(extra) {
    if (this.destroyed || !this.panel || this._pageSeq === undefined) return;
    const told = this._toldFacts;
    const facts = this._modeFacts();
    // (A page that was told nothing yet is told nothing calm: its first report says it.)
    if (!extra && (this._toldFacts === told || (told === undefined && !facts.mayBypass && !facts.switching))) return;
    this.sendEvent({ type: 'mode_state', ...facts, ...(extra || {}) });
  }

  /** Checked once whoever is handling the change had its say (the handler that awaited the switch announces it itself). */
  _factsSettled() {
    if (!this.panel || this._factsTimer || this.destroyed) return;
    this._factsTimer = setTimeout(() => { this._factsTimer = null; this._tellFacts(); }, 0);
    this._factsTimer.unref?.();
  }

  // A switch of this session's own on the CLI, counted while the CLI has not
  // answered it. What the CLI reports in that time was written before the
  // switch landed: it is that switch's echo or older news, never a decision of
  // the CLI's that came after it (see _reportedMode). This replaces judging by
  // how recent the switch was.
  _switchMode(q, mode) {
    if (this._modeCalls?.q !== q) this._modeCalls = { q, open: 0, sent: 0 };
    const calls = this._modeCalls;
    calls.open++;
    calls.sent++;
    // From the moment a switch into Bypass is sent the process may be in it; the
    // CLI acknowledging a switch to another mode that was sent later ends that.
    const cli = this._cliOf(q);
    const n = calls.sent;
    if (mode === BYPASS) { cli.may = true; cli.at = n; cli.sends++; }
    // (The caller gets the CLI's own promise: counting adds no step to its answer.)
    const call = q.setPermissionMode(mode);
    call.then(() => {
      calls.open--;
      cli.mode = mode;
      if (mode !== BYPASS && n > cli.at) cli.may = false;
      this._factsSettled();
    }, () => { calls.open--; this._factsSettled(); });
    return call;
  }

  _modeSwitchUnderWay() {
    if (!this.q) return false;
    if (this._modeCalls?.q === this.q && this._modeCalls.open > 0) return true;
    // A plan approval's switch that waits for its 50 ms (see _handleExitPlan).
    const due = this._planSwitchDue;
    return !!due && due.q === this.q && due.stamp === this._modeStatements;
  }

  /** Whether this session switched the mode of its current process since it started. */
  _switchedSinceStart() {
    return this._modeCalls?.q === this.q && this._modeCalls.sent > 0;
  }

  // The tab goes back to following the user's settings: it never picked a mode
  // and left plan mode. The next process starts in the mode they name
  // (permissions.defaultMode, which only the CLI reads). A live one is switched
  // to that mode when this process showed it: the first init of a process that
  // started from the settings. A process that started in a stated mode never
  // said what the settings name, so it runs in Default until it is restarted,
  // and the tab is told. Returns { mode, reason } ('' when there is no process).
  _returnToSettings() {
    this._modeFromSettings = true;
    const q = this.q;
    if (!q) return { mode: '', reason: '' };
    const known = this._settingsModeOf?.q === q ? this._settingsModeOf.mode : '';
    const mode = known || 'default';
    this.permissionMode = mode;
    if (mode === BYPASS) this._bypassHeld = true;
    return { mode, reason: known ? '' : SETTINGS_MODE_UNKNOWN };
  }

  // ── permission mode (panel sessions) ─────────────────────────────────────────

  // The CLI's own word on the permission mode: every turn's init, and a status
  // message when it changes in between. `this.permissionMode` is the mode the
  // user put the tab in; the CLI reporting Bypass is accepted only when that is
  // Bypass, or when this is the first init of a process that left the choice to
  // the user's settings (permissions.defaultMode; the CLI itself drops one that a
  // repository committed) and that this session has not switched since. Any
  // other Bypass is not the session's mode: it is switched back at once, and the
  // event goes on with the tab's own mode, so the page never takes it for a
  // choice. Returns { event, then? }.
  // Once the page numbers its statements, what goes on to it is this session's
  // record of the mode with the number of the latest statement applied, and the
  // record follows the CLI where the CLI decided: a status with nothing of this
  // session's under way is the CLI changing its mode itself (the model entered
  // plan mode, a permission card's rule switched it), and that is the mode now.
  // An init that differs from a stated mode is a snapshot written before the
  // switch landed (the CLI says every change with a status): it is not taken.
  _reportedMode(m) {
    const reported = m.permissionMode;
    const init = m.subtype === 'init';
    const first = init && !this._startModeSeen;
    if (init) this._startModeSeen = true;
    if (!PANEL_PERMISSION_MODES.includes(reported)) return { event: m };
    const q = this.q;
    const numbered = this._pageSeq !== undefined;
    const underWay = this._modeSwitchUnderWay();
    const untouched = !this._switchedSinceStart(); // the process is still in the mode it started in, as far as this session goes
    const cli = this._cliOf(q);
    // (Numbered) the event as it goes on: what the CLI is in, the number, and whether it may be in Bypass (_modeFacts).
    const own = () => {
      if (!numbered) return m;
      const { mode, ...facts } = this._modeFacts();
      return { ...m, permissionMode: mode, ...facts };
    };
    if (reported !== BYPASS) {
      // (Numbered) written before a switch of this session's own landed.
      if (numbered && underWay) return { event: own() };
      // Whether this report says where the process is now. While the process may
      // be in a Bypass this session sent it into, it does not: it may have been
      // written before that switch landed. A process this session never sent
      // into Bypass says its own mode in order, and that ends a Bypass it
      // started in or entered by itself.
      const ordered = cli.sends === 0;
      const trusted = cli.may !== true || ordered;
      const taken = () => { cli.mode = reported; if (ordered) cli.may = false; };
      // The CLI picked the mode from the user's settings: that is the mode now.
      if (init && this._modeFromSettings && (!numbered || untouched)) {
        this.permissionMode = reported;
        if (trusted) taken();
        if (first && untouched) this._settingsModeOf = { q, mode: reported };
        return { event: own() };
      }
      // The process was started in Bypass for the tab and did not take it. (A
      // switch to Bypass sent before this init is not that: it is still on its way.)
      if (first && this._startAskedBypass && this.permissionMode === BYPASS) {
        this.permissionMode = reported;
        if (trusted) taken();
        return { event: own(), then: this._numbered({ type: 'mode_changed', mode: reported, reason: BYPASS_NOT_TAKEN }) };
      }
      // (Numbered) the CLI changed its mode itself: this session's record follows.
      // Not while the process may be in a Bypass of this session's own sending:
      // then the tab's Bypass stays the tab's, with one exception. Plan mode is
      // something the session enters by itself (the model's EnterPlanMode) and
      // leaves back to the tab's own mode, so it is followed; the session may
      // still be in Bypass all the same, and is said to be.
      if (numbered && !init) {
        if (trusted) { this.permissionMode = reported; taken(); }
        else if (reported === 'plan') { this.permissionMode = reported; cli.mode = reported; }
      }
      return { event: own() };
    }
    // The CLI says it is in Bypass: from here it may be, whatever was sent to it
    // before (only a switch away that is sent after this ends it).
    cli.may = true;
    cli.at = this._modeCalls?.q === q ? this._modeCalls.sent : 0;
    cli.mode = BYPASS;
    if (this.permissionMode === BYPASS) return { event: own() };
    if (first && this._modeFromSettings && untouched) {
      this.permissionMode = BYPASS;
      this._bypassHeld = true;
      this._settingsModeOf = { q, mode: BYPASS };
      return { event: own() };
    }
    const mode = this.permissionMode || 'default';
    // Its own switch can still be on its way to the CLI (the user left Bypass, a
    // plan was approved into another mode): then this report is older than that
    // switch, and the mode is only stated again.
    const echo = underWay;
    // Whose Bypass it was decides the sentence: the mode the user's settings
    // started this process in, one the session was in before by their choice,
    // or nobody's they know of.
    const reason = echo ? '' : (first && this._startedFromSettings) ? BYPASS_FROM_SETTINGS : this._bypassHeld ? BYPASS_LEFT : BYPASS_FOREIGN;
    log(`permission mode: the CLI reported ${BYPASS}, the tab is in ${mode}${echo ? ' (a switch is under way)' : ''}; switching back`);
    if (q) {
      this._switchMode(q, mode).catch((err) => {
        // A session that cannot be taken out of a Bypass that is not its mode does not go on.
        log('setPermissionMode (leaving a Bypass the tab did not choose) failed:', err?.message || err);
        if (this.q !== q || this.destroyed) return;
        this._endQuery({ graceful: false });
        this.send({ type: 'error', message: 'This session was switched to Bypass by something other than you and could not be switched back, so it was stopped. Your next message resumes the conversation.' });
        this.sendDone(-1);
      });
    }
    return { event: numbered ? own() : { ...m, permissionMode: mode }, then: this._numbered({ type: 'mode_changed', mode, ...(reason ? { reason } : {}) }) };
  }

  // The CLI refused Bypass on the live session (the user's settings or a policy
  // turn it off): the tab goes back to `fallback`, on the CLI too, and is told why.
  _bypassRefused(q, why, fallback = 'default') {
    if (this.destroyed || this.permissionMode !== BYPASS) return;
    this.permissionMode = fallback === BYPASS ? 'default' : fallback;
    if (q && this.q === q) this._switchMode(q, this.permissionMode).catch(() => {});
    this.sendEvent(this._numbered({ type: 'mode_changed', mode: this.permissionMode, reason: bypassRefusalText(why) }));
  }

  // ── permissions ────────────────────────────────────────────────────────────

  async _onCanUseTool(toolName, input, context) {
    const { signal, suggestions } = context;
    this.lastActivity = Date.now();
    if (toolName === 'AskUserQuestion') return this._promptUser(toolName, input, signal, suggestions, 'ask');
    if (toolName === 'ExitPlanMode') return this._handleExitPlan(input, signal);
    if (AUTO_ALLOW.has(toolName)) return { behavior: 'allow', updatedInput: input };
    // Opt-in (the assistant brain): the plan policy answers first — before session
    // "always allow", so an always-allowed edit is still refused. A null answer is
    // asked as outside plan mode, under the approval mode an approved plan continues in.
    if (this.permissionMode === 'plan' && typeof this.opts?.planPermission === 'function') {
      const decision = this.opts.planPermission(toolName, input, { approvalMode: this._planExitMode() });
      if (decision === 'allow') return { behavior: 'allow', updatedInput: input };
      if (decision === 'deny') {
        this.send({ type: 'stderr', text: `Plan mode: declined ${toolName}` });
        return { behavior: 'deny', message: this.opts.planDenyMessage?.(toolName) || `Plan mode: ${toolName} was not run.` };
      }
    }
    if (this.alwaysAllowed.has(toolName)) return { behavior: 'allow', updatedInput: input };
    return this._promptUser(toolName, input, signal, suggestions, 'perm', context);
  }

  /** The approval mode an approved plan continues in (opts.planExitMode; bypass only when the session allows it). */
  _planExitMode() {
    const configured = ['acceptEdits', 'bypassPermissions'].includes(this.opts?.planExitMode) ? this.opts.planExitMode : 'default';
    return configured === 'bypassPermissions' && this.opts?.allowDangerouslySkipPermissions !== true ? 'default' : configured;
  }

  _promptUser(toolName, input, signal, suggestions, kind, context = null) {
    const requestId = `perm-${randomUUID()}`;
    const request = { tool_name: toolName, subtype: 'can_use_tool', input: input || {} };
    if (suggestions?.length) request.suggestions = suggestions;
    // Panel sessions: what the CLI itself says about this ask (its sentence, the
    // reason, the path or MCP server involved) and how it wants it presented.
    if (this.panel && context) {
      const c = context;
      if (c.title) request.title = String(c.title);
      if (c.displayName) request.display_name = String(c.displayName);
      if (c.description) request.description = String(c.description);
      if (c.decisionReason) request.decision_reason = String(c.decisionReason);
      if (c.blockedPath) request.blocked_path = String(c.blockedPath);
      if (c.mcpServer?.name) request.mcp_server = { name: String(c.mcpServer.name), source: String(c.mcpServer.source || '') };
      if (c.matchedAskRule) request.matched_ask_rule = c.matchedAskRule;
      if (c.agentID) request.agent_id = String(c.agentID);
      if (c.toolUseID) request.tool_use_id = String(c.toolUseID);
      if (c.defaultToNo === true) request.default_to_no = true;
      if (c.suppressAlwaysAllowRule === true) request.suppress_always = true;
    }
    // Kept on the entry so reattach() can re-send it to a reloaded page.
    const wire = { type: 'control_request', request_id: requestId, request };
    this.send(wire);
    log(`permission request ${requestId} tool=${toolName} kind=${kind}`);
    return new Promise((resolve) => {
      const entry = { toolName, resolve, input, kind, createdAt: Date.now(), wire, toolUseId: this.panel ? (context?.toolUseID || '') : '' };
      this.pendingPerms.set(requestId, entry);
      if (signal) {
        signal.addEventListener('abort', () => {
          if (this.pendingPerms.delete(requestId)) {
            this.send({ type: 'control_cancelled', request_id: requestId });
            resolve({ behavior: 'deny', message: 'Turn was interrupted' });
          }
        }, { once: true });
      }
    });
  }

  // An MCP server asks the user for input (a form) or sends them to a URL. Same
  // pending map as permission prompts, so the card survives a page reload and a
  // closed turn cancels it. Resolves with an MCP ElicitResult.
  _promptElicitation(request, signal) {
    const requestId = `elicit-${randomUUID()}`;
    const wire = {
      type: 'control_request',
      request_id: requestId,
      request: {
        subtype: 'elicitation',
        server_name: String(request.serverName || ''),
        message: String(request.message || ''),
        mode: request.mode === 'url' ? 'url' : 'form',
        ...(request.url ? { url: String(request.url) } : {}),
        ...(request.elicitationId ? { elicitation_id: String(request.elicitationId) } : {}),
        ...(request.requestedSchema && typeof request.requestedSchema === 'object' ? { requested_schema: request.requestedSchema } : {}),
        ...(request.title ? { title: String(request.title) } : {}),
        ...(request.displayName ? { display_name: String(request.displayName) } : {}),
        ...(request.description ? { description: String(request.description) } : {}),
      },
    };
    this.send(wire);
    log(`elicitation request ${requestId} server=${request.serverName || '?'} mode=${wire.request.mode}`);
    return new Promise((resolve) => {
      this.pendingPerms.set(requestId, { toolName: 'elicitation', resolve, input: null, kind: 'elicit', createdAt: Date.now(), wire });
      if (signal) {
        signal.addEventListener('abort', () => {
          if (this.pendingPerms.delete(requestId)) {
            this.send({ type: 'control_cancelled', request_id: requestId });
            resolve({ action: 'cancel' });
          }
        }, { once: true });
      }
    });
  }

  async _handleExitPlan(input, signal) {
    // Author the plan file BEFORE the approval card (ordering contract: the
    // frontend's eager-capture path expects plan_file_written first).
    const planBody = (input?.plan || '').trim();
    // (A temporary chat: SynaBun keeps no copy of the plan; the card shows it.)
    if (planBody && !this.temporary) {
      try {
        const workDir = validateWorkDir(this.cwd) || deps.PACKAGE_ROOT;
        const result = deps.writePlanFile(planBody, { cwd: workDir, projectPath: workDir });
        if (result?.ok) {
          this.sendEvent({ type: 'system', subtype: 'plan_file_written', path: result.path, name: result.name });
          log('plan authored:', result.path);
        }
      } catch (err) { log('plan author error:', err.message); }
    }
    const res = await this._promptUser('ExitPlanMode', input, signal, null, 'plan');
    if (res.behavior !== 'allow') return res;
    // planDecision is attached by _resolvePermission from the client response.
    const decision = res._planDecision || 'default';
    // A plain approval continues in the approval mode the session was set to
    // before planning (opts.planExitMode: the assistant's plan + bypass/accept).
    // (Panel sessions: the plan card's own Bypass choice, on a process launched able to take it.)
    const bypassOk = this.opts?.allowDangerouslySkipPermissions === true || (this.panel && this._bypassLaunched === true);
    let targetMode = decision === 'acceptEdits' ? 'acceptEdits'
      : (decision === 'bypassPermissions' && bypassOk) ? 'bypassPermissions'
        : this._planExitMode();
    // (Panel sessions: the answer is a numbered statement of the tab's mode. One
    // older than the statement applied approves the plan and states no mode. A
    // page that numbers them may also name where the plan leaves to more exactly
    // than the three decisions (`planExit`: the mode the tab was in before the
    // plan, or 'settings' for a tab that never picked one). Read here only, for
    // a plan request.)
    let toSettings = null;
    if (this.panel) {
      if (!this._takeStatement(res._planSeq)) { this._statementDropped(); return { behavior: 'allow', updatedInput: res.updatedInput || input }; }
      const exit = this._pageSeq !== undefined ? res._planExit : undefined;
      if (exit === 'settings') { toSettings = this._returnToSettings(); targetMode = toSettings.mode || 'default'; }
      else if (PANEL_PERMISSION_MODES.includes(exit) && exit !== 'plan' && (exit !== BYPASS || bypassOk)) targetMode = exit;
    }
    // Approved: plan-mode permission handling ends now, not when the switch below lands.
    this.permissionMode = targetMode;
    const stamp = this._stateMode();
    const q = this.q;
    // (Panel sessions: the CLI goes back to the mode it was in before the plan
    // by itself, and may say so before the switch below lands: until then that
    // switch is under way (_modeSwitchUnderWay). And the answer to the card is
    // the tab's own pick: the user's settings no longer choose the mode of a
    // process started after it, unless the answer went back to them.)
    if (this.panel) {
      this._modeFromSettings = !!toSettings;
      if (targetMode === BYPASS) this._bypassHeld = true;
      this._planSwitchDue = { q, stamp };
    }
    setTimeout(() => {
      if (this.panel && this._planSwitchDue?.stamp === stamp) this._planSwitchDue = null;
      // Void once the mode was stated again or the process is gone (see _stateMode).
      if (!this._modeSwitchStands(q, stamp)) return;
      (this.panel ? this._switchMode(q, targetMode) : q.setPermissionMode(targetMode))
        .then(() => {
          if (!this._modeSwitchStands(q, stamp)) return;
          this.permissionMode = targetMode;
          this.sendEvent(this._numbered({ type: 'mode_changed', mode: targetMode, ...(toSettings ? { fromSettings: true, ...(toSettings.reason ? { reason: toSettings.reason } : {}) } : {}) }));
        })
        .catch(err => {
          log('setPermissionMode after plan approve failed:', err.message);
          if (this.panel && targetMode === BYPASS && this._modeSwitchStands(q, stamp)) this._bypassRefused(q, err.message);
        });
    }, 50);
    return { behavior: 'allow', updatedInput: res.updatedInput || input };
  }

  // AskUserQuestion answers arrive as updatedInput {questions, answers} from the
  // existing frontend card. The CLI's AskUserQuestion tool reads ONLY the
  // top-level `answers` map, looked up by each question's exact `question` text
  // (verified against the CLI itself: missing/empty map → "The user did not
  // answer the questions."). So: keep the original questions, pass the answers
  // map through, and re-key any answer the panel stored under a fallback key
  // (text/header) back onto the question text.
  _normalizeAskInput(originalInput, updatedInput) {
    if (!updatedInput) return originalInput;
    const rawAnswers = updatedInput.answers;
    if (!rawAnswers || typeof rawAnswers !== 'object') {
      return { ...originalInput, ...updatedInput };
    }
    const readAnswer = (v) => {
      if (v == null) return '';
      if (Array.isArray(v?.answers)) return v.answers.join(', ');
      if (typeof v === 'string') return v;
      if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
      return String(v);
    };
    const questions = Array.isArray(originalInput?.questions) ? originalInput.questions : [];
    const answerKeys = Object.keys(rawAnswers);
    // Keep every answer under its original key (the panel already keys by question text)
    const answers = {};
    for (const k of answerKeys) {
      const a = readAnswer(rawAnswers[k]);
      if (a) answers[k] = a;
    }
    // Ensure each question's EXACT text has an entry — re-key fallback-keyed answers
    questions.forEach((q, i) => {
      const qText = q?.question || '';
      if (!qText || answers[qText] != null) return;
      for (const key of [q?.text, q?.header, q?.id, String(i), answerKeys[i]].filter(Boolean)) {
        if (answers[key] != null) { answers[qText] = answers[key]; break; }
      }
    });
    // Panel sessions: what the user added to a choice (notes, the preview they
    // picked) travels with the answers.
    if (this.panel && updatedInput.annotations && typeof updatedInput.annotations === 'object') {
      return { ...originalInput, answers, annotations: updatedInput.annotations };
    }
    return { ...originalInput, answers };
  }

  _resolvePermission(requestId, innerResponse) {
    const entry = this.pendingPerms.get(requestId);
    if (!entry) { log('control_response for unknown/expired request:', requestId); return; }
    this.pendingPerms.delete(requestId);
    const behavior = innerResponse?.behavior;
    const latencyMs = Date.now() - entry.createdAt;
    if (entry.kind === 'elicit') {
      const action = ['accept', 'decline', 'cancel'].includes(innerResponse?.action) ? innerResponse.action : 'decline';
      log(`elicitation resolved ${requestId} action=${action} latency=${latencyMs}ms`);
      const content = innerResponse?.content;
      entry.resolve(action === 'accept' && content && typeof content === 'object' ? { action, content } : { action });
      return;
    }
    log(`permission resolved ${requestId} tool=${entry.toolName} behavior=${behavior} latency=${latencyMs}ms`);

    if (behavior === 'allow') {
      if (innerResponse.always && entry.kind === 'perm') this.alwaysAllowed.add(entry.toolName);
      let updatedInput = innerResponse.updatedInput || entry.input;
      if (entry.kind === 'ask') updatedInput = this._normalizeAskInput(entry.input, innerResponse.updatedInput);
      const result = { behavior: 'allow', updatedInput };
      if (Array.isArray(innerResponse.updatedPermissions) && innerResponse.updatedPermissions.length) {
        result.updatedPermissions = innerResponse.updatedPermissions;
        // Panel sessions: a permission card is not a way into Bypass (the mode
        // control and the plan card are). A mode switch to it is taken out.
        if (this.panel) {
          const kept = result.updatedPermissions.filter(u => !(u && typeof u === 'object' && u.type === 'setMode' && u.mode === BYPASS));
          if (kept.length !== result.updatedPermissions.length) log(`permission answer ${requestId}: dropped a switch to ${BYPASS}`);
          if (kept.length) result.updatedPermissions = kept; else delete result.updatedPermissions;
        }
      }
      if (entry.kind === 'plan') {
        result._planDecision = innerResponse.planDecision || 'default';
        // Panel sessions: the answer's statement number, and where the plan leaves to (see _handleExitPlan).
        if (this.panel) { result._planSeq = innerResponse.modeSeq; result._planExit = innerResponse.planExit; }
      }
      // Panel sessions tell the CLI which call this answers and whether the
      // approval was for this once or came with rules.
      if (this.panel && entry.kind === 'perm') {
        if (entry.toolUseId) result.toolUseID = entry.toolUseId;
        result.decisionClassification = result.updatedPermissions?.length ? 'user_permanent' : 'user_temporary';
        if (result.updatedPermissions?.length) this._noteGranted(result.updatedPermissions);
      }
      entry.resolve(result);
    } else {
      const message = innerResponse?.message
        || (entry.kind === 'plan'
          ? 'User wants to keep planning. Revise the plan based on their feedback.'
          : `User denied permission for ${entry.toolName}`);
      const result = { behavior: 'deny', message };
      if (this.panel && entry.kind === 'perm') {
        // "Deny and stop": the turn ends here instead of the model trying another way.
        if (innerResponse?.interrupt === true) result.interrupt = true;
        if (entry.toolUseId) result.toolUseID = entry.toolUseId;
        result.decisionClassification = 'user_reject';
      }
      entry.resolve(result);
    }
  }

  _denyAllPending(reason) {
    for (const [rid, entry] of this.pendingPerms) {
      entry.resolve(entry.kind === 'elicit' ? { action: 'cancel' } : { behavior: 'deny', message: reason });
      this.send({ type: 'control_cancelled', request_id: rid });
    }
    this.pendingPerms.clear();
  }

  // ── public API for other hosts of a session (the Assistant brain) ────────────
  // What a host may change on a session without reaching into its fields.

  /** The approval mode an approved plan continues in ('default' | 'acceptEdits' | 'bypassPermissions'). */
  setPlanExitMode(mode) {
    // A copy: the options object may be shared or frozen (panel sessions share one).
    this.opts = { ...this.opts, planExitMode: mode };
    return this._planExitMode();
  }

  /**
   * Switch the model before a turn: on the live query when there is one, and
   * for the next query either way. Never throws.
   * @returns {{ ok: boolean, changed: boolean, error?: string }}
   */
  async setModel(model) {
    const want = model || null;
    if ((this.model || null) === want) return { ok: true, changed: false };
    if (typeof this.q?.setModel === 'function') {
      try { await this.q.setModel(want || undefined); }
      catch (error) { return { ok: false, changed: false, error: error?.message || String(error) }; }
    }
    this.model = want; // ensureQuery() reads it when the next query is created
    return { ok: true, changed: true };
  }

  // ── watchdog / reapers ─────────────────────────────────────────────────────

  _checkStall() {
    if (this.destroyed || !this.q || !this.inTurn) return;
    if (this.pendingPerms.size > 0) { this.lastEventTime = Date.now(); return; }
    const silentSec = Math.round((Date.now() - this.lastEventTime) / 1000);
    if (!this.bootComplete) {
      if (silentSec >= BOOT_TIMEOUT_SEC) {
        log(`boot timeout — ${silentSec}s without init`);
        this._denyAllPending('Boot timeout');
        this._endQuery({ graceful: false });
        this.inTurn = false; this.pendingTurns = 0;
        this.send({ type: 'error', message: `Session failed to start within ${BOOT_TIMEOUT_SEC}s. MCP servers or hooks may be hanging.` });
        this.sendDone(-1);
      }
      return;
    }
    const killSec = claudeStallSeconds(this.effort, 90);
    if (silentSec >= STALL_WARN_SEC && silentSec < killSec) {
      log(`stall warning: silent ${silentSec}s (kill at ${killSec}s) retries=${this.stallRetries}`);
      return;
    }
    if (silentSec < killSec) return;
    // No main-thread output since the last result, nothing pushed since, and that
    // result said nothing was queued: the CLI is not in a turn — our count is off.
    // Close it here. A stall retry would restart the CLI, killing its background
    // work and injecting a "continue" prompt nobody sent.
    if (this._lastResultAt > this._lastPushAt && !this._outputSinceResult && !this._resultOwesTurn) {
      log('turn accounting drift — the CLI has no turn in flight; closing it');
      this.inTurn = false;
      this.pendingTurns = 0;
      this.lastActivity = Date.now();
      this.sendDone(0);
      return;
    }
    if (this.temporary) { this._stallTemporary(); return; }
    if (this.stallRetries < MAX_RETRIES) {
      this.stallRetries++;
      log(`stall retry ${this.stallRetries}/${MAX_RETRIES} — interrupt → recreate with resume`);
      this.sendEvent({ type: 'system', subtype: 'retry', message: `Stream stalled — retrying (${this.stallRetries}/${MAX_RETRIES})...` });
      // The stalled turn is in flight by definition — swallow its interrupt-result
      // so the client doesn't get a premature done mid-recovery.
      this.swallowResults++;
      this.swallowDeadline = Date.now() + 15_000;
      const q = this.q;
      const interruptDeadline = new Promise(r => setTimeout(() => r('timeout'), 10_000));
      Promise.race([q.interrupt().then(() => 'ok').catch(() => 'failed'), interruptDeadline])
        .then(async () => {
          if (this.destroyed) return;
          // Jitter + global slot: de-phase correlated stall recoveries so N
          // sessions don't respawn N CLIs in the same instant.
          await new Promise(r => setTimeout(r, Math.random() * 3000));
          if (this.destroyed) return;
          await _acquireRecreateSlot();
          try {
            if (this.destroyed) return;
            await this._recreateQuery('The previous turn was interrupted by an API stream drop. Please continue from where you left off.');
          } finally {
            _releaseRecreateSlot();
          }
        });
    } else {
      log('stall timeout — max retries exhausted');
      this._endQuery({ graceful: false });
      this.inTurn = false; this.pendingTurns = 0;
      this.send({ type: 'error', message: `Session stalled after ${MAX_RETRIES} retries. The API stream keeps dropping. Try a simpler message or switch to a faster model.` });
      this.sendDone(-1);
    }
  }

  _maybeReapIdle() {
    if (this.destroyed || !this.q || this.inTurn || this.pendingPerms.size > 0) return;
    // Background agents, shells and scheduled wakeups run inside this CLI process
    // after the turn that started them has ended. Ending the Query kills them.
    if (this._hasPendingWork()) return;
    // A temporary chat cannot be resumed: it lives as long as its tab does.
    if (this.temporary) return;
    if (Date.now() - this.lastActivity < IDLE_REAP_MS) return;
    log(`idle reap: ending query for session ${this.sessionId || '(new)'} — next prompt resumes transparently`);
    this._endQuery({ graceful: true });
  }

  // ── inbound WS messages ────────────────────────────────────────────────────

  async handleMessage(msg, turn = null) {
    // Panel sessions: while another message is between ending a process and
    // starting the next, a message that can start or end one waits in line
    // (see _newTurn). It is handled with a turn of its own, which it takes
    // before it waits on a closing process itself.
    if (this.panel && !turn && takesTurn(msg)) {
      const mine = this._newTurn();
      try {
        if (this._turnBusy) {
          await mine.take();
          // The tab went away while the message waited: there is no one left to answer.
          if (this.destroyed) { log(`${msg.type} dropped: the session was closed while it waited its turn`); return; }
        }
        return await this.handleMessage(msg, mine);
      } finally { mine.release(); }
    }
    if (this.panel && controlCanStart(msg)) {
      if (!this._everStarted) this._establishFromControl(msg);
      else if (this._controlLeftConversation(msg)) {
        // The tab is on another conversation than the one this session's
        // process was started for: that process is not what the control runs
        // on. It ends, as it does for a prompt, and the control's configuration
        // is the one of a conversation no process has started for yet.
        log(`control ${msg.type} for another conversation (was ${this.sessionId || 'none'}): ending the query`);
        // The turn is this message's from here (it is free, or already its own).
        { const waiting = turn?.take(); if (waiting) await waiting; }
        await this._endQuery({ graceful: true });
        if (this.destroyed) return;
        // No message started a process during that wait: the ones that can are
        // waiting their turn behind this one. A recovery that was already under
        // way (a stall retry) is not a message and may have: what it restarted
        // is the conversation the tab left, so it ends too, at once (nothing
        // is awaited when the end is not graceful).
        if (this.q) this._endQuery({ graceful: false });
        this._everStarted = false;
        this._accountBound = false;
        this._establishFromControl(msg);
      }
    }
    switch (msg.type) {
      case 'query': {
        // (Panel sessions: a prompt that restarts the process holds the turn until the new one exists.)
        const restarting = this._handleQuery(msg);
        if (restarting) { const waiting = turn?.take(); if (waiting) await waiting; }
        return restarting;
      }
      case 'warm':
        // Panel sessions only: the user started typing. Start the CLI process
        // now (same configuration as the message that follows), unless one is
        // already there.
        if (!this.panel || this.q || this._warm) return;
        return this._handleQuery(msg, { warmOnly: true });
      case 'control_response': {
        const rid = msg.request_id || msg.response?.request_id;
        const inner = msg.response?.response || msg.response || {};
        if (rid) this._resolvePermission(rid, inner);
        return;
      }
      case 'compact': {
        // Panel sessions: a start that is refused is said before anything is announced.
        if (this.panel && !this.q) { this.ensureQuery(); if (this._announceRefusedStart()) return; }
        this.sendEvent({ type: 'system', subtype: 'compact_started', message: 'Compacting context...' });
        this._pushUserText('/compact');
        return;
      }
      case 'abort': {
        // Swallow the result interrupt() will produce — but only when a turn is
        // actually in flight, and with an expiry so a no-result interrupt can't
        // permanently eat the next real turn's done.
        if (this.inTurn) { this.swallowResults++; this.swallowDeadline = Date.now() + 15_000; }
        this._denyAllPending('Turn was interrupted');
        this.inTurn = false;
        this.pendingTurns = 0;
        const q = this.q;
        turn?.release(); // (panel sessions: a stop that waited in line holds nothing while the CLI answers)
        if (q) { try { await q.interrupt(); } catch (err) { log('interrupt failed:', err.message); } }
        this.send({ type: 'aborted' });
        return;
      }
      case 'set_permission_mode': {
        const mode = msg.mode;
        // Panel sessions, a page that numbers its statements: back to the mode
        // the user's settings name (a tab that never picked a mode left plan mode).
        const toSettings = this.panel && msg.fromSettings === true && Number.isSafeInteger(msg.modeSeq);
        if (!toSettings && !(this.panel ? PANEL_PERMISSION_MODES : CLASSIC_PERMISSION_MODES).includes(mode)) return;
        // (Panel sessions: a numbered statement older than the one applied is not applied.)
        if (!this._takeStatement(msg.modeSeq)) { this._statementDropped(); return; }
        if (toSettings) {
          const back = this._returnToSettings();
          this._warmStillFits();
          const stamp = this._stateMode();
          turn?.release();
          const q = this.q;
          if (q) {
            try {
              await this._switchMode(q, back.mode);
            } catch (err) {
              log('setPermissionMode (back to the settings\' mode) failed:', err.message);
              if (back.mode === BYPASS) { if (this._modeSwitchStands(q, stamp)) this._bypassRefused(q, err.message); return; }
              // The session is where it was: the page is told so, with what it may still be in.
              if (this._modeSwitchStands(q, stamp)) this._tellFacts({ failed: back.mode });
              this.send({ type: 'error', message: `Could not switch permission mode: ${err.message}` });
              return;
            }
          }
          if (this._modeStatements !== stamp) return;
          this.sendEvent(this._numbered({ type: 'mode_changed', mode: back.mode, fromSettings: true, ...(back.reason ? { reason: back.reason } : {}) }));
          return;
        }
        // Panel sessions: Bypass where no process can be launched able to take
        // it (see panelBypassBlock) is refused here, and the tab keeps its mode.
        const previous = this.permissionMode;
        if (this.panel && mode === BYPASS) {
          const block = panelBypassBlock() || (this.q && !this._bypassLaunched ? bypassRefusalText('not launched') : '');
          if (block) {
            // (A numbered statement that is refused still decides the tab's mode: the one it is in instead, away from the settings.)
            const kept = previous === BYPASS ? 'default' : (previous || 'default');
            if (this._pageSeq !== undefined) { this._modeFromSettings = false; this.permissionMode = kept; this._stateMode(); this._warmStillFits(); }
            this.sendEvent(this._numbered({ type: 'mode_changed', mode: kept, reason: block }));
            return;
          }
        }
        this._modeFromSettings = false;
        this.permissionMode = mode;
        if (this.panel && mode === BYPASS) this._bypassHeld = true;
        // (Panel sessions: a process kept ready that was started in another mode is ended; see _warmStillFits.)
        if (this.panel) this._warmStillFits();
        const stamp = this._stateMode();
        turn?.release(); // (panel sessions: as for a stop)
        if (this.q) {
          const q = this.q;
          try {
            await (this.panel ? this._switchMode(q, mode) : q.setPermissionMode(mode));
          } catch (err) {
            log('setPermissionMode failed:', err.message);
            // Panel sessions: a Bypass the CLI refused leaves the tab in the mode it had
            // (not when the mode was stated again meanwhile, or the process is
            // another one: then the refusal is about neither; see _stateMode).
            if (this.panel && mode === BYPASS) { if (this._modeSwitchStands(q, stamp)) this._bypassRefused(q, err.message, previous); return; }
            // (Panel sessions: a switch that failed or was refused leaves the session
            // in the mode the CLI is in, a Bypass it could not leave included: the
            // page is told that, not only that there was an error.)
            if (this.panel && this._modeSwitchStands(q, stamp)) this._tellFacts({ failed: mode });
            this.send({ type: 'error', message: `Could not switch permission mode: ${err.message}` });
            return;
          }
        }
        // (Panel sessions: a switch the CLI answered after the mode was stated
        // again announces nothing: the tab is not in it.)
        if (this.panel && this._modeStatements !== stamp) return;
        this.sendEvent(this._numbered({ type: 'mode_changed', mode }));
        return;
      }
      case 'rewind': {
        // (A temporary chat has no checkpoints.)
        if (this.temporary) { this.send({ type: 'rewind_result', ok: false, code: 'temporary', error: TEMPORARY_NO_REWIND }); return; }
        const uuid = msg.userMessageUuid;
        // The idle reaper may have ended the Query — resume transparently
        if (!this.q && this.sessionId && uuid) this.ensureQuery();
        if (!uuid || !this.q) {
          this.send({ type: 'rewind_result', ok: false, error: this.q ? 'Missing userMessageUuid' : (this._startRefused?.message || 'No active session'), ...(!this.q && this._startRefused?.code ? { code: this._startRefused.code } : {}) });
          return;
        }
        // (Panel sessions: the turn is given up for the CLI's answer, see _newTurn.)
        turn?.release();
        try {
          const r = await this.q.rewindFiles(uuid);
          if (r && r.canRewind === false) {
            this.send({ type: 'rewind_result', ok: false, error: r.error || 'Rewind not available for this checkpoint' });
          } else if (this.panel) {
            // What the rewind changed, for the panel's result line.
            const stats = slimRewind(r);
            this.send({ type: 'rewind_result', ok: true, userMessageUuid: uuid, fileCount: stats.fileCount, insertions: stats.insertions, deletions: stats.deletions, skippedLinks: stats.skippedLinks });
          } else {
            this.send({ type: 'rewind_result', ok: true, userMessageUuid: uuid });
          }
        } catch (err) {
          this.send({ type: 'rewind_result', ok: false, error: err.message });
        }
        return;
      }
      case 'mcp_status': {
        if (!this.q) { this.sendEvent({ type: 'system', subtype: 'mcp_status', servers: [] }); return; }
        try {
          const servers = await this.q.mcpServerStatus();
          this.sendEvent({ type: 'system', subtype: 'mcp_status', servers: servers || [] });
        } catch (err) { log('mcpServerStatus failed:', err.message); }
        return;
      }
      case 'reload_skills': {
        // Panel sessions only: re-read skills from disk and refresh the slash menu.
        if (!this.panel) return;
        if (!this.q || typeof this.q.reloadSkills !== 'function') {
          this.send({ type: 'reload_result', what: 'skills', ok: false, error: 'No active session yet. Skills load fresh when the session starts.' });
          return;
        }
        const q = this.q;
        try {
          await q.reloadSkills();
          const commands = await q.supportedCommands();
          if (this.q === q && Array.isArray(commands)) {
            this.sendEvent({ type: 'system', subtype: 'commands_list', commands });
            this.send({ type: 'reload_result', what: 'skills', ok: true, count: commands.length });
          }
        } catch (err) {
          this.send({ type: 'reload_result', what: 'skills', ok: false, error: err.message });
        }
        return;
      }
      case 'rewind_conversation': {
        // Panel sessions only: drop the conversation back to one entry (the
        // model forgets what came after), optionally restoring the files to
        // the prompt that followed it. The session restarts, resumed at that entry.
        if (!this.panel) return;
        let at = typeof msg.messageUuid === 'string' ? msg.messageUuid : '';
        const fail = (error, code) => this.send({ type: 'rewind_conversation_result', ok: false, error, ...(code ? { code } : {}) });
        if (this.temporary) { fail(TEMPORARY_NO_REWIND, 'temporary'); return; }
        if (!at || !this.sessionId) { fail(at ? 'No session to rewind' : 'Missing message id'); return; }
        if (this.inTurn) { fail('Claude is still working. Stop the turn first.'); return; }
        // The turn (see _newTurn) is given up while this waits on the disk and
        // on the CLI, and other messages are handled meanwhile. One that moved
        // the tab to another conversation, or started a turn, stops the rewind:
        // going on would rewind the wrong conversation, or end that turn.
        const moves = this._conversationMoves || 0;
        const pushedAt = this._lastPushAt;
        const MOVED_ON = 'The tab moved to another conversation while this rewind was under way, so the conversation was not rewound.';
        // Where to resume is the entry the prompt follows in the transcript. The
        // panel's own answer comes from the rows it rendered, and a turn can end
        // on an entry it has no row for (a tool-result carrier, an attachment):
        // resuming before that would drop the kept turn's last output. So when
        // the host can read the transcript, only its answer is used: a lookup
        // that fails or does not find the prompt refuses the rewind before a
        // file is touched or the session restarted. The panel's value stands
        // only for a host that wired no lookup.
        if (typeof deps.transcriptParentOf === 'function') {
          if (typeof msg.userMessageUuid !== 'string' || !msg.userMessageUuid) { fail('The rewind did not say which prompt to go back to.'); return; }
          let parent = null;
          turn?.release();
          try { parent = await deps.transcriptParentOf({ sessionId: this.sessionId, uuid: msg.userMessageUuid, cwd: this.cwd, accountId: this.accountId || '' }); } catch { parent = null; }
          await turn?.take();
          if (parent === '') { fail('This is the first message of the conversation: there is nothing before it to go back to.'); return; }
          if (typeof parent !== 'string' || !parent) { fail('The transcript of this session could not be read to find what comes before that message, so nothing was rewound. Try again once the turn is written, or check that the tab\'s project is the one the session belongs to.'); return; }
          at = parent;
          if (this.inTurn || this.destroyed) { fail('Claude is still working. Stop the turn first.'); return; }
          if ((this._conversationMoves || 0) !== moves) { fail(MOVED_ON); return; }
        }
        let files = null;
        if (typeof msg.userMessageUuid === 'string' && msg.userMessageUuid) {
          if (!this.q) this.ensureQuery();
          if (!this.q) { fail(this._startRefused?.message || 'No active session', this._startRefused?.code); return; }
          turn?.release();
          try {
            const r = await this.q.rewindFiles(msg.userMessageUuid);
            if (r && r.canRewind === false) { fail(r.error || 'Files cannot be rewound to this message'); return; }
            files = slimRewind(r);
          } catch (err) { fail(err.message); return; }
          await turn?.take();
          if (this.destroyed) return;
          // The files are restored; the conversation is rewound only when
          // nothing else happened to the session meanwhile (see `moves` above).
          if ((this._conversationMoves || 0) !== moves) { fail(`${MOVED_ON} The files were restored.`); return; }
          // (A turn the CLI started by itself is ended by the restart, as it always was: only one a message started stops the rewind.)
          if (this.inTurn && this._lastPushAt !== pushedAt) { fail('Claude started working while the files were being restored, so the conversation was not rewound. The files were restored: stop the turn, then rewind again.'); return; }
        }
        { const waiting = turn?.take(); if (waiting) await waiting; }
        await this._endQuery({ graceful: true });
        if (this.destroyed) return;
        this._resumeAt = at;
        this.ensureQuery();
        if (this._startRefused) { fail(this._startRefused.message, this._startRefused.code); return; }
        this.send({ type: 'rewind_conversation_result', ok: true, messageUuid: at, userMessageUuid: msg.userMessageUuid || '', ...(files ? { fileCount: files.fileCount, insertions: files.insertions, deletions: files.deletions } : {}) });
        return;
      }
      case 'session_request': {
        // Panel sessions only: one of the Query's control calls, answered as a card's data.
        if (!this.panel) return;
        const id = typeof msg.id === 'string' ? msg.id.slice(0, 80) : '';
        const what = SESSION_REQUESTS.includes(msg.what) ? msg.what : '';
        if (!id || !what) return;
        // The session's own record of granted permission rules, and dropping the
        // session-scoped ones. The SDK has no call that removes a live rule: they
        // live in the CLI process, so forgetting them ends it (the next message
        // resumes the conversation in a new one).
        if (what === 'permission_rules') { this.send({ type: 'session_response', id, what, ok: true, data: { granted: [...this._grantedRules] } }); return; }
        // A temporary chat: forgetting the session's rules ends its process, and a rewind needs checkpoints it does not keep.
        if (this.temporary && (what === 'forget_session_rules' || what === 'rewind_preview')) {
          this.send({ type: 'session_response', id, what, ok: false, code: 'temporary', error: what === 'rewind_preview' ? TEMPORARY_NO_REWIND : `${TEMPORARY_NO_RESTART} The rules granted here end with it.` });
          return;
        }
        if (what === 'forget_session_rules') {
          if (this.inTurn || this.pendingPerms.size) { this.send({ type: 'session_response', id, what, ok: false, error: 'Claude is still working. Stop the turn first.' }); return; }
          // Ending the process also ends what runs in it without a turn:
          // background tasks and scheduled wake-ups. That is said, and done only
          // when the request confirms it.
          if (this.q && this._hasPendingWork() && msg.args?.confirm !== true) {
            const backgroundTasks = [...this._bgTasks.values()].slice(0, 50).map(t => ({ task_id: String(t?.task_id || ''), task_type: String(t?.task_type || ''), description: String(t?.description || '').slice(0, 300) }));
            const wakeups = this._cronList().slice(0, 50);
            const parts = [];
            if (backgroundTasks.length) parts.push(`${backgroundTasks.length} background task${backgroundTasks.length === 1 ? '' : 's'}`);
            if (wakeups.length) parts.push(`${wakeups.length} scheduled wake-up${wakeups.length === 1 ? '' : 's'}`);
            this.send({ type: 'session_response', id, what, ok: false, code: 'confirm_required', error: `Forgetting the rules restarts the session, which ends ${parts.join(' and ')}. Confirm to go on.`, data: { backgroundTasks, wakeups } });
            return;
          }
          const restarted = !!this.q;
          { const waiting = turn?.take(); if (waiting) await waiting; }
          if (this.q) await this._endQuery({ graceful: true });
          this._grantedRules = this._grantedRules.filter(u => u.destination && u.destination !== 'session');
          this.send({ type: 'session_response', id, what, ok: true, data: { granted: [...this._grantedRules], restarted } });
          return;
        }
        // The tab's own remote MCP servers, changed on the live session. The call
        // replaces the dynamic set, so the host's entries (SynaBun) are always
        // part of it; the tab's settings are updated to match, so the next
        // message does not restart the session over a change that is already live.
        if (what === 'mcp_set_servers') {
          const args = msg.args && typeof msg.args === 'object' ? msg.args : {};
          const q = this.q;
          try {
            if (!q) throw new Error('No active session. The servers start with the session.');
            if (typeof q.setMcpServers !== 'function') throw new Error('Not supported by this Claude Code version');
            const current = this.panelSession || normalizePanelSession(null);
            const start = { ...current.start, mcpServers: normalizeMcpServers(args.servers) };
            const merged = mergeTabMcpServers(this._hostMcpServers, start);
            const r = await q.setMcpServers(merged.servers);
            if (this.q === q) this.panelSession = { ...current, start };
            const errors = r?.errors && typeof r.errors === 'object' ? Object.fromEntries(Object.entries(r.errors).slice(0, 20).map(([k, v]) => [String(k).slice(0, 80), String(v).slice(0, 300)])) : {};
            const servers = typeof q.mcpServerStatus === 'function' ? slimMcpStatus(await q.mcpServerStatus()) : [];
            this.send({ type: 'session_response', id, what, ok: true, data: { added: Array.isArray(r?.added) ? r.added : [], removed: Array.isArray(r?.removed) ? r.removed : [], errors, notes: merged.notes, applied: start.mcpServers, servers } });
            if (servers.length && this.q === q) this.sendEvent({ type: 'system', subtype: 'mcp_status', servers });
          } catch (err) {
            this.send({ type: 'session_response', id, what, ok: false, error: err?.message || String(err) });
          }
          return;
        }
        // A rewind preview on a session the idle reaper ended: resume it, as rewind itself does.
        if (!this.q && what === 'rewind_preview' && this.sessionId) {
          this.ensureQuery();
          if (!this.q && this._startRefused) { this.send({ type: 'session_response', id, what, ok: false, code: this._startRefused.code, error: this._startRefused.message }); return; }
        }
        const q = this.q;
        // (A rewind preview holds a turn until here: given up for the CLI's answer, see _newTurn.)
        turn?.release();
        try {
          const data = await runSessionRequest(q, what, msg.args && typeof msg.args === 'object' ? msg.args : {});
          this.send({ type: 'session_response', id, what, ok: true, data });
          // The statusline's dots follow a reconnect or a toggle.
          if (data?.servers && this.q === q) this.sendEvent({ type: 'system', subtype: 'mcp_status', servers: data.servers });
        } catch (err) {
          this.send({ type: 'session_response', id, what, ok: false, error: err?.message || String(err) });
        }
        return;
      }
      case 'stop_task':
      case 'background_tasks': {
        // Panel sessions only: stop one background task, or send running
        // foreground work (one tool call, or all of it) to the background.
        if (!this.panel) return;
        const action = msg.type;
        const q = this.q;
        if (!q) { this.send({ type: 'task_control_result', action, ok: false, error: 'No active session' }); return; }
        try {
          if (action === 'stop_task') {
            const taskId = typeof msg.taskId === 'string' ? msg.taskId : '';
            if (!taskId || typeof q.stopTask !== 'function') throw new Error(taskId ? 'Not supported by this Claude Code version' : 'Missing task id');
            await q.stopTask(taskId);
            this.send({ type: 'task_control_result', action, ok: true, taskId });
          } else {
            if (typeof q.backgroundTasks !== 'function') throw new Error('Not supported by this Claude Code version');
            const toolUseId = typeof msg.toolUseId === 'string' && msg.toolUseId ? msg.toolUseId : undefined;
            const moved = await q.backgroundTasks(toolUseId);
            this.send({ type: 'task_control_result', action, ok: moved !== false, ...(moved === false ? { error: 'Nothing running in the foreground matched' } : {}) });
          }
        } catch (err) {
          this.send({ type: 'task_control_result', action, ok: false, error: err.message });
        }
        return;
      }
      case 'reload_plugins': {
        // Panel sessions only: pick up plugins installed or changed since the session started.
        if (!this.panel) return;
        if (!this.q || typeof this.q.reloadPlugins !== 'function') {
          this.send({ type: 'reload_result', what: 'plugins', ok: false, error: 'No active session yet. Plugins load fresh when the session starts.' });
          return;
        }
        const q = this.q;
        try {
          const r = await q.reloadPlugins();
          if (this.q !== q) return;
          if (Array.isArray(r?.commands)) this.sendEvent({ type: 'system', subtype: 'commands_list', commands: r.commands });
          if (Array.isArray(r?.mcpServers)) this.sendEvent({ type: 'system', subtype: 'mcp_status', servers: r.mcpServers });
          const plugins = Array.isArray(r?.plugins) ? r.plugins.map(p => ({ name: p?.name || '', version: p?.version || '', source: p?.source || '' })) : [];
          this.sendEvent({ type: 'system', subtype: 'plugins_list', plugins, agents: Array.isArray(r?.agents) ? r.agents : [], errorCount: Number(r?.error_count) || 0 });
          this.send({ type: 'reload_result', what: 'plugins', ok: true, count: plugins.length, errorCount: Number(r?.error_count) || 0 });
        } catch (err) {
          this.send({ type: 'reload_result', what: 'plugins', ok: false, error: err.message });
        }
        return;
      }
      case 'heartbeat': {
        if (msg.windowId) this.windowId = msg.windowId;
        if (msg.sessionId && this.windowId && !this.temporary) {
          try { deps.heartbeatLock(msg.sessionId, this.windowId); } catch {}
        }
        return;
      }
      default:
        // 'reattach' handled at the connection layer
        return;
    }
  }

  // `establishOnly` (with `warmOnly`; panel sessions, see _establishFromControl):
  // apply the configuration of a query that has no prompt, and start nothing.
  _handleQuery(msg, { warmOnly = false, establishOnly = false } = {}) {
    let { prompt, cwd, sessionId, model, effort, images, windowId, permissionMode } = msg;
    if (warmOnly) { prompt = ''; images = null; }
    if (windowId) this.windowId = windowId;
    if (model && model.includes(':')) model = deps.toCliModelName(model);
    if (!warmOnly && !prompt && !images?.length) {
      this.send({ type: 'error', message: 'No prompt provided' });
      return;
    }
    // Panel sessions: the account comes first. An account that is no longer set
    // up, or another account in the middle of a conversation, refuses the query
    // before a lock is taken or a process is started.
    let queryAccount = null;
    if (this.panel) {
      queryAccount = this._resolveQueryAccount(msg.accountId, sessionId);
      if (queryAccount.code) {
        if (!warmOnly) this.send({ type: 'error', code: queryAccount.code, message: queryAccount.message });
        if (establishOnly) this._coldRefusal = { code: queryAccount.code, message: queryAccount.message };
        return;
      }
    }

    // Panel sessions: a temporary chat is chosen with the first message of a
    // conversation and fixed from there (see _takeTemporary). A message that
    // cannot be answered as one is refused before anything is applied.
    if (this.panel) {
      let refused = this._takeTemporary(msg, sessionId);
      if (!refused && this.temporary && this.q && !warmOnly) {
        const why = this._temporaryRestartReason(msg, { cwd, effort, account: queryAccount.account });
        if (why) refused = { code: 'temporary_restart', message: `${TEMPORARY_NO_RESTART} So ${why} cannot change here: put it back, or start a new chat with the new setting.` };
      }
      if (refused) {
        if (!warmOnly) { this.send({ type: 'error', code: refused.code, message: refused.message }); this.sendDone(-1); }
        if (establishOnly) this._coldRefusal = refused;
        return;
      }
    }

    // Session lock — identical to legacy (a warm start takes none: nothing is sent yet)
    // (A temporary chat takes none: no other window can open it.)
    if (sessionId && this.windowId && (!warmOnly || establishOnly) && !this.temporary) {
      try {
        const lockResult = deps.acquireSessionLock(sessionId, this.windowId, null);
        if (!lockResult.ok) {
          if (establishOnly) { this._coldRefusal = { code: 'session_locked', message: 'Session locked by another window' }; return; }
          this.send({ type: 'error', message: 'Session locked by another window' });
          return;
        }
      } catch {}
    }

    // SynaBun skill injection runs FIRST; unrecognized /commands pass through to the CLI
    if (prompt && prompt.startsWith('/')) {
      try {
        const injected = deps.maybeInjectSkillPrompt(prompt);
        if (injected.command === 'clear' && !injected.skill) return; // client-only
        if (injected.skill) {
          log('skill injection: /' + injected.command);
          prompt = injected.prompt;
        }
      } catch {}
    }

    // Config changes that require a fresh process (cwd/effort map to spawn flags)
    const cwdChanged = cwd && this.cwd && cwd !== this.cwd;
    // A session that started without an effort still switches when one is picked.
    let effortChanged = !!effort && effort !== this.effort;
    const sessionChanged = sessionId && this.sessionId && sessionId !== this.sessionId;
    // No sessionId from a tab whose session has one: the tab started a new chat
    // (New chat, project switch). Continuing here would answer it with the old
    // conversation's context — or resume the old session after an idle reap.
    const newChat = !sessionId && !!this.sessionId;
    // (A panel tab that started on the default model can still pick one later.)
    const modelChanged = model && (this.model || this.panel) && model !== this.model;
    // The env is fixed at spawn, so flipping judgments on a live query needs a fresh process.
    const typesafeOff = msg.typesafe === undefined ? !!this.typesafeOff : msg.typesafe === 'off';
    const typesafeChanged = !!this.q && typesafeOff !== !!this.typesafeOff;
    this.typesafeOff = typesafeOff;
    // Panel sessions: what the client can render, and the tab's tool policy.
    // Removing tools is a start-up option, so a change needs a fresh process.
    let policyChanged = false;
    if (this.panel) {
      if (Array.isArray(msg.features)) this.clientFeatures = new Set(msg.features.filter(f => typeof f === 'string'));
      if (typeof msg.title === 'string') this._title = msg.title.trim().slice(0, 200);
      // The account is part of the process environment: a change restarts the
      // session (a conversation of one account cannot be resumed under another;
      // the lost-session recovery starts a fresh one and says so).
      // (Validated above, in _resolveQueryAccount.) Each reason to restart is
      // added to the others: a later unchanged setting must not cancel it.
      if (msg.accountId !== undefined) {
        const account = queryAccount.account;
        if (this.q && account !== (this.accountId || '')) policyChanged = true;
        this.accountId = account;
      }
      // A message (not a warm start) is what makes the conversation this account's.
      // (A control's configuration binds nothing by itself: the process it starts does, in ensureQuery.)
      if (!warmOnly) this._accountBound = true;
      // From here the session has its tab's configuration: it may start a process.
      this._established = true;
      if (msg.toolPolicy !== undefined) {
        const policy = TOOL_POLICY_DISALLOW[msg.toolPolicy] ? msg.toolPolicy : null;
        if (this.q && policy !== (this.toolPolicy || null)) policyChanged = true;
        this.toolPolicy = policy;
      }
      if (msg.session !== undefined) {
        const next = normalizePanelSession(msg.session);
        // What is fixed at start changed: the session restarts with it.
        if (this.q && startSignature(next) !== startSignature(this.panelSession || normalizePanelSession(null))) policyChanged = true;
        this.panelSession = next;
      }
    }

    // Panel sessions: counted, for a control that waits and must know the tab
    // stayed where it was (the conversation rewind).
    if (this.panel && (newChat || sessionChanged)) this._conversationMoves = (this._conversationMoves || 0) + 1;
    if (newChat) this.sessionId = null;
    if (sessionId) this.sessionId = sessionId;
    if (cwd) this.cwd = cwd;
    // A panel tab that sends no effort means "the model's default": a level that
    // was set goes back to it, live when a session exists.
    const effortCleared = this.panel && !effort && !!this.effort;
    if (effort) this.effort = effort;
    else if (effortCleared) this.effort = null;
    if (model) this.model = model;
    // Panel sessions: a tab in Bypass where no process can be launched able to
    // take it runs in Default, and is told (see panelBypassBlock).
    // (Panel sessions: the mode a message states is a numbered statement like
    // any other. One older than the statement applied states no mode; the rest
    // of the message stands.)
    const statesMode = !this.panel || this._takeStatement(msg.modeSeq);
    if (!statesMode) { permissionMode = ''; this._statementDropped(); }
    if (this.panel && permissionMode === BYPASS) {
      const block = panelBypassBlock();
      if (block) { permissionMode = 'default'; this.sendEvent(this._numbered({ type: 'mode_changed', mode: 'default', reason: block })); }
    }
    let backToSettings = null;
    if (permissionMode && (this.panel ? PANEL_PERMISSION_MODES : CLASSIC_PERMISSION_MODES).includes(permissionMode)) {
      this.permissionMode = permissionMode;
      this._modeFromSettings = false;
      if (this.panel && permissionMode === BYPASS) this._bypassHeld = true;
      this._stateMode();
    } else if (this.panel && statesMode && !permissionMode && msg.modeFromSettings === true) {
      // The tab never picked a mode: the user's settings decide (permissions.defaultMode).
      // A live process that was put in a stated mode meanwhile (the tab was in
      // plan mode and left it) goes back to the settings' mode now.
      if (this.q && !warmOnly && this._modeFromSettings !== true) backToSettings = this._returnToSettings();
      this._modeFromSettings = true;
      this._stateMode();
    }
    if (warmOnly) {
      // Configuration only: no prompt, no turn. (No live query here: see the `warm` case.)
      // (A starting control's configuration starts nothing; a process kept ready for another one is ended.)
      if (establishOnly) this._warmStillFits();
      if (!establishOnly && !this.q && !this.destroyed) this.ensureQuery({ warm: true });
      return;
    }
    this.lastPrompt = prompt;

    // Effort alone switches on the live CLI. A restart would cold-start the
    // session and kill any background agents it is running.
    if (this.q && effortChanged && !cwdChanged && !sessionChanged && !newChat
      && typeof this.q.applyFlagSettings === 'function') {
      const effortLevel = CLAUDE_EFFORT_LEVELS.includes(effort) ? effort : null;
      this.q.applyFlagSettings({ effortLevel }).catch(err => log('applyFlagSettings(effort) failed:', err.message));
      effortChanged = false;
    }
    if (this.q && this.panel && !cwdChanged && !sessionChanged && !newChat && !policyChanged
      && typeof this.q.applyFlagSettings === 'function') {
      // Fast mode, output style and the main-thread agent switch on the live
      // session; so does a return to the default effort.
      const patch = liveSettingsPatch(this._liveApplied, this.panelSession?.live) || {};
      if (effortCleared) patch.effortLevel = null;
      if (Object.keys(patch).length) {
        this._liveApplied = { ...(this.panelSession?.live || {}) };
        this.q.applyFlagSettings(patch).catch(err => {
          log('applyFlagSettings(session) failed:', err.message);
          this.send({ type: 'stderr', text: `Could not apply the session settings: ${err.message}` });
        });
      }
    }

    if (this.q && (cwdChanged || effortChanged || sessionChanged || newChat || typesafeChanged || policyChanged)) {
      log(`config change (cwd=${!!cwdChanged} effort=${!!effortChanged} session=${!!sessionChanged} newChat=${newChat} typesafe=${typesafeChanged}${policyChanged ? ' toolPolicy=true' : ''}) — recreating query`);
      const restarted = this._endQuery({ graceful: true }).then(() => {
        if (this.destroyed) return;
        this.ensureQuery();
        this._pushUserText(prompt, images, { human: this.panel && msg.typed === true });
      });
      // Panel sessions: the message holds its turn until the restart is done
      // (handleMessage waits on what this returns), so the next message meets
      // the new process and not the gap before it.
      return this.panel ? restarted : undefined;
    }

    const hadQuery = !!this.q;
    this._pushUserText(prompt, images, { human: this.panel && msg.typed === true });

    if (hadQuery && modelChanged && this.q) {
      this.q.setModel(model).catch(err => log('setModel failed:', err.message));
    }
    if (hadQuery && permissionMode && this.q) {
      const q = this.q;
      const stated = this.permissionMode;
      const stamp = this._modeStatements;
      // (Panel sessions: a Bypass the CLI refuses leaves the tab in Default, and it is told,
      // unless the mode was stated again or the process replaced meanwhile.)
      (this.panel ? this._switchMode(q, stated) : q.setPermissionMode(stated)).catch((err) => { if (this.panel && stated === BYPASS && this._modeSwitchStands(q, stamp)) this._bypassRefused(q, err?.message); });
    }
    if (hadQuery && backToSettings?.mode && this.q) {
      const q = this.q;
      const stamp = this._modeStatements;
      this._switchMode(q, backToSettings.mode).catch((err) => { if (backToSettings.mode === BYPASS && this._modeSwitchStands(q, stamp)) this._bypassRefused(q, err?.message); });
      if (backToSettings.reason) this.sendEvent(this._numbered({ type: 'mode_changed', mode: backToSettings.mode, fromSettings: true, reason: backToSettings.reason }));
    }
  }

  // ── detach / reattach / destroy ───────────────────────────────────────────

  detach() {
    if (this.destroyed) return false;
    // A temporary chat whose page is gone is over: it is never kept for a reattach.
    if (this.temporary) return false;
    // Background work counts: a page reload must not kill agents that are still
    // running after their turn ended — the reloaded tab reattaches to them.
    const busy = this.inTurn || this.pendingPerms.size > 0 || this._hasPendingWork();
    if (!this.windowId || !busy || !this.q) return false;
    this.orphanBuffer = [];
    this.orphanResynced = false;
    this.ws = null;
    const key = _orphanKey(this.windowId, this.sessionId);
    _detached.set(key, this);
    this.orphanKillTimer = setTimeout(() => {
      log(`orphan grace expired for ${key} — destroying session`);
      _detached.delete(key);
      this.destroy();
    }, ORPHAN_GRACE_MS);
    log(`detached session ${key} (turn in flight: ${this.inTurn}, pending perms: ${this.pendingPerms.size}, background tasks: ${this._bgTasks.size}, crons: ${this._sessionCrons.length})`);
    return true;
  }

  reattach(ws) {
    clearTimeout(this.orphanKillTimer);
    this.orphanKillTimer = null;
    this.ws = ws;
    const buffer = this.orphanBuffer || [];
    this.orphanBuffer = null;
    // reattach_result FIRST: the client must restore running/session state before
    // any replayed control_request re-arms its permission buffering.
    const result = {
      type: 'reattach_result',
      ok: true,
      sessionId: this.sessionId,
      running: this.inTurn || this.pendingPerms.size > 0,
      backgroundTasks: [...this._bgTasks.values()],
    };
    // A reloaded page lost its task and wakeup lists: hand both back in full
    // (backgroundTasks above; the wakeups with their schedule and prompt).
    if (this.panel) { result.sessionCrons = this._sessionCrons.length; result.sessionCronList = this._cronList(); result.grantedRules = [...this._grantedRules]; }
    // (A page that numbers its statements: the mode this session is in, and the
    // number of the latest statement it applied. The page says its own again
    // when that is behind.
    // What it is in is the mode the CLI acknowledged or reported, with a switch
    // under way named beside it and whether the session may be in Bypass.)
    if (this.panel && this._pageSeq !== undefined) { Object.assign(result, this._modeFacts()); if (this._modeFromSettings) result.fromSettings = true; }
    if (this.orphanResynced) result.resynced = true;
    this.orphanResynced = false;
    if (ws.readyState === 1) { try { ws.send(JSON.stringify(result)); } catch {} }
    // A reloaded page lost the cards for requests issued before the socket
    // dropped, and the turn would wait on them forever. Re-send every pending one;
    // the panel ignores a request_id it already shows.
    for (const entry of this.pendingPerms.values()) {
      if (entry.wire && ws.readyState === 1) { try { ws.send(JSON.stringify(entry.wire)); } catch {} }
    }
    // Chunked replay — serializing + sending up to ORPHAN_BUFFER_CAP events in
    // one tick stalls every other session on this single-threaded server.
    // ~50 events per slice, pausing while the socket buffer is saturated.
    // Live events generated mid-replay queue behind the buffered ones
    // (this._replaying in send()) so ordering is preserved.
    this._replaying = true;
    this._replayQueue = [];
    const REPLAY_SLICE = 50;
    let idx = 0;
    const pump = () => {
      if (this.destroyed || this.ws !== ws || ws.readyState !== 1) {
        this._replaying = false;
        this._replayQueue = null;
        return;
      }
      if (ws.bufferedAmount > WS_BACKPRESSURE_BYTES) {
        setTimeout(pump, 50);
        return;
      }
      let n = 0;
      while (idx < buffer.length && n++ < REPLAY_SLICE) {
        try { ws.send(JSON.stringify(buffer[idx])); } catch {}
        idx++;
      }
      if (idx < buffer.length) { setImmediate(pump); return; }
      // Flush events that arrived mid-replay, then resume direct sends
      const queued = this._replayQueue || [];
      this._replaying = false;
      this._replayQueue = null;
      for (const evt of queued) {
        if (ws.readyState === 1) { try { ws.send(JSON.stringify(evt)); } catch {} }
      }
      log(`reattached session ${_orphanKey(this.windowId, this.sessionId)}, replayed ${buffer.length} events (+${queued.length} live)`);
    };
    pump();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._closeWarm();
    clearTimeout(this._watchdogStartTimer);
    clearInterval(this._watchdog);
    clearInterval(this._lockBeat);
    clearInterval(this._idleReaper);
    clearTimeout(this.orphanKillTimer);
    clearTimeout(this._idleCheck);
    this._replaying = false;
    this._replayQueue = null;
    for (const slot of this._deltaBuf.values()) clearTimeout(slot.timer);
    this._deltaBuf.clear();
    this._denyAllPending('Session closed');
    try { this.input?.close(); } catch {}
    try { this.abortController?.abort(); } catch {}
    this.q = null;
    if (this.temporary) this._removeTemporaryPlans();
    if (this.windowId) {
      try { deps.releaseAllLocks(this.windowId); } catch {}
      const key = _orphanKey(this.windowId, this.sessionId);
      if (_detached.get(key) === this) _detached.delete(key);
    }
    // Release this chat session's owned browser tab so the shared browser can
    // grace-reap once no owners remain. Best-effort, in-process on the NI side.
    try { deps.releaseBrowserOwner?.(this.synabunOwnerKey); } catch {}
    _allSessions.delete(this);
  }
}

// ── connection layer ─────────────────────────────────────────────────────────

export function createClaudeBridge(ws) {
  if (!deps) throw new Error('claude-agent-bridge not configured — call configureClaudeBridge(deps) first');

  let session = null;

  // Engine hello — lets the frontend gate SDK-only UI
  try {
    ws.send(JSON.stringify({ type: 'engine', engine: 'sdk', sdkVersion: SDK_VERSION, capabilities: panelCapabilities() }));
  } catch {}

  // Ping/pong keepalive (same cadence as legacy)
  let alive = true;
  ws.on('pong', () => { alive = true; });
  const pingInterval = setInterval(() => {
    if (!alive) { try { ws.terminate(); } catch {} clearInterval(pingInterval); return; }
    alive = false;
    if (ws.readyState === 1) ws.ping();
  }, 30_000);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    try {
      if (msg.type === 'dispose') {
        // The tab was closed. End its session now instead of orphaning it for a
        // reattach that no tab will ever send.
        if (session) { session.destroy(); session = null; }
        return;
      }
      if (msg.type === 'reattach') {
        const wid = msg.windowId;
        if (!wid) return;
        const key = _orphanKey(wid, msg.sessionId);
        const orphan = _detached.get(key);
        if (!orphan || orphan.destroyed) {
          if (orphan) _detached.delete(key);
          try { ws.send(JSON.stringify({ type: 'reattach_result', ok: false })) } catch {}
          // No orphan: fall through to a fresh session bound to this windowId
          if (!session) { session = new ClaudeSession(ws, PANEL_SESSION_OPTS); }
          session.windowId = wid;
          if (msg.sessionId) session.sessionId = msg.sessionId;
          return;
        }
        _detached.delete(key);
        if (session && session !== orphan) session.destroy();
        session = orphan;
        session.reattach(ws);
        return;
      }
      if (!session) {
        session = new ClaudeSession(ws, PANEL_SESSION_OPTS);
      }
      session.handleMessage(msg);
    } catch (err) {
      log('message handling error:', err.message);
    }
  });

  ws.on('close', () => {
    clearInterval(pingInterval);
    if (!session) return;
    if (session.detach()) return; // turn in flight → orphaned for reattach
    session.destroy();
  });
}

// End one sidepanel session by window + Claude session id (tray ×, or a closed
// tab whose socket was already gone). Never touches a session that is still
// bound to an open socket — that one belongs to a live tab.
export function killSession(windowId, sessionId) {
  if (!windowId || !sessionId) return false;
  const target = _detached.get(_orphanKey(windowId, sessionId))
    || [..._allSessions].find(s => !s.destroyed && s.windowId === windowId
      && s.sessionId === sessionId && !(s.ws && s.ws.readyState === 1));
  if (!target) return false;
  target.destroy();
  return true;
}

// Whether a session has a live CLI process behind it (a tab is using it, or it
// is running detached). The server asks before deleting a transcript.
export function isSessionLive(sessionId) {
  if (!sessionId) return false;
  return [..._allSessions].some(s => !s.destroyed && s.sessionId === sessionId && !!s.q);
}

export function shutdownAllBridges() {
  for (const session of [..._allSessions]) {
    try { session.destroy(); } catch {}
  }
  _detached.clear();
  // (A temporary chat's plan files that are still owed: the last chance, with no process waited for.)
  _removeOwedTemporaryPlans({ all: true });
}

export function bridgeStats() {
  return { sessions: _allSessions.size, detached: _detached.size, sdkVersion: SDK_VERSION };
}
