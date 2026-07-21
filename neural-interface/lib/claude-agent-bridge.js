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
// Wire contract is a superset of the legacy bridge: the frontend keeps receiving
// `{type:'event', event:{…stream-json…}}`, `control_request`, `done`, `aborted`,
// `reattach_result`. New outbound types: `engine`, `mode_changed`, `rewind_result`,
// `control_cancelled`. New inbound: `set_permission_mode`, `rewind`, `mcp_status`.
//
// Ownership model (inversion vs legacy): the session object owns the Query, the
// input queue, the event buffer, pending permission resolvers, cost baseline and
// watchdog. The WebSocket merely binds/unbinds to it — an "orphan" is just a
// session with no WS bound, so page-refresh reattach is the same object.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
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

let deps = null; // injected once from server.js — see configureClaudeBridge()
export function configureClaudeBridge(d) { deps = d; }

// windowId:sessionId → session (only while detached, for reattach)
const _detached = new Map();
// every live session, for shutdown + sweeps
const _allSessions = new Set();

function _orphanKey(wid, sid) { return sid ? `${wid}:${sid}` : wid; }

function log(...args) { console.log('[claude-sdk]', ...args); }

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

class ClaudeSession {
  constructor(ws) {
    this.ws = ws;
    this.windowId = null;
    this.sessionId = null;       // claude session id (from init/result events)
    this.model = null;
    this.cwd = null;
    this.effort = null;
    this.permissionMode = 'default';

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

    this.pendingPerms = new Map(); // requestId → { toolName, resolve, input, kind }
    this.alwaysAllowed = new Set();

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
    this.synabunOwnerKey = `sidepanel-${randomUUID()}`;

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
      if (this.q && this.sessionId && this.windowId) {
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

  ensureQuery() {
    if (this.q) return this.q;
    this.input = createInputQueue();
    this.abortController = new AbortController();
    this.bootComplete = false;
    this.lastEventTime = Date.now();
    this._deltaBuf.clear();

    const workDir = validateWorkDir(this.cwd) || deps.PACKAGE_ROOT;
    const options = {
      cwd: workDir,
      permissionMode: this.permissionMode || 'default',
      includePartialMessages: deps.includePartialMessages !== false,
      enableFileCheckpointing: true, // required for Query.rewindFiles()
      // CRITICAL: without these two the SDK loads neither the Claude Code system
      // prompt nor any ~/.claude settings/hooks/CLAUDE.md/MCP servers.
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      canUseTool: (name, input, opts) => this._onCanUseTool(name, input, opts || {}),
      hooks: {
        PreCompact: [{
          hooks: [async () => {
            this.sendEvent({ type: 'system', subtype: 'compact_started', message: 'Auto-compacting context…' });
            return {};
          }],
        }],
      },
      env: cleanEnv(),
      abortController: this.abortController,
      stderr: (text) => {
        const t = String(text || '').trim();
        if (t) this.send({ type: 'stderr', text: t });
      },
    };
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
          headers: { 'X-Synabun-Terminal': this.synabunOwnerKey },
        },
      };
    }
    if (this.sessionId) options.resume = this.sessionId;
    if (this.model) options.model = this.model;
    if (this.effort && ['low', 'medium', 'high', 'max'].includes(this.effort)) {
      options.extraArgs = { effort: this.effort };
    }
    // Sibling-project access, same guard as legacy --add-dir
    const parentDir = dirname(workDir);
    if (parentDir && parentDir !== workDir && dirname(parentDir) !== parentDir) {
      options.additionalDirectories = [parentDir];
    }
    // Default to the SDK's bundled CLI (version-matched). An explicit .js override
    // can be set via cli-config.json → "claude-skin": { "sdkExecutable": "…/cli.js" }.
    const sdkExec = deps.sdkExecutable;
    if (sdkExec && /\.[cm]?js$/i.test(sdkExec) && existsSync(sdkExec)) {
      options.pathToClaudeCodeExecutable = sdkExec;
    } else if (sdkExec) {
      log('ignoring non-.js sdkExecutable override:', sdkExec);
    }

    log(`session create: resume=${this.sessionId || 'none'} model=${this.model || 'default'} effort=${this.effort || 'default'} mode=${this.permissionMode} cwd=${workDir} sdk=${SDK_VERSION}`);
    this.q = query({ prompt: this.input, options });
    this.pumpPromise = this._pump(this.q);
    return this.q;
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
      const friendly = /ENOENT/.test(msg)
        ? 'Claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code'
        : msg;
      this._finishTurnWithError(friendly);
    } finally {
      if (this.q === q) this.q = null;
    }
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
    if (!q) return;
    this.q = null;
    this._denyAllPending('Session ending');
    // The dying query's in-flight turn can never deliver a result (pump guard
    // drops late ones) — reset accounting so recreation paths start clean.
    this.inTurn = false;
    this.pendingTurns = 0;
    this.swallowResults = 0;
    try { this.input?.close(); } catch {}
    if (graceful && this.pumpPromise) {
      await Promise.race([this.pumpPromise, new Promise(r => setTimeout(r, 5000))]);
    }
    try { this.abortController?.abort(); } catch {}
  }

  _recreateQuery(continuationPrompt) {
    const sid = this.sessionId;
    return this._endQuery({ graceful: false }).then(() => {
      if (this.destroyed) return;
      this.sessionId = sid;
      this.ensureQuery();
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
      if (prompt) this._pushUserText(prompt);
    });
  }

  _pushUserText(text, images) {
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
    const ok = this.input.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: this.sessionId || '',
    });
    if (ok) {
      this.inTurn = true;
      this.pendingTurns++;
      this.lastEventTime = Date.now();
      this.lastActivity = Date.now();
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
          this.sendEvent(m);
          this._announceCapabilities();
          return;
        }
        // compact_boundary and any future system subtypes pass through
        this.sendEvent(m);
        return;
      }
      case 'stream_event': {
        this._forwardStreamEvent(m);
        return;
      }
      case 'assistant': {
        this.bootComplete = true;
        this._flushDeltas();
        this._synthesizeSubagentStarts(m);
        this.sendEvent({ ...m });
        return;
      }
      case 'user': {
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

  _recordCost(m) {
    // Cost: total_cost_usd is cumulative for the process; on resumed sessions it
    // may or may not include pre-resume history. Self-calibrating baseline:
    if (typeof m.total_cost_usd === 'number' && m.total_cost_usd > 0) {
      const sid = m.session_id || this.sessionId;
      if (sid) {
        if (!this.costBySession.has(sid)) {
          const stored = (() => { try { return deps.getSessionCost(sid) || 0; } catch { return 0; } })();
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
        if (delta > 0) { try { deps.addCost(delta, sid); } catch {} }
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

    this.pendingTurns = Math.max(0, this.pendingTurns - 1);
    this.inTurn = this.pendingTurns > 0;
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
    for (const block of content) {
      if (block?.type === 'tool_result' && this._taskIds.has(block.tool_use_id)) {
        this._taskIds.delete(block.tool_use_id);
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
  }

  // ── permissions ────────────────────────────────────────────────────────────

  async _onCanUseTool(toolName, input, { signal, suggestions }) {
    this.lastActivity = Date.now();
    if (toolName === 'AskUserQuestion') return this._promptUser(toolName, input, signal, suggestions, 'ask');
    if (toolName === 'ExitPlanMode') return this._handleExitPlan(input, signal);
    if (AUTO_ALLOW.has(toolName) || this.alwaysAllowed.has(toolName)) {
      return { behavior: 'allow', updatedInput: input };
    }
    return this._promptUser(toolName, input, signal, suggestions, 'perm');
  }

  _promptUser(toolName, input, signal, suggestions, kind) {
    const requestId = `perm-${randomUUID()}`;
    const request = { tool_name: toolName, subtype: 'can_use_tool', input: input || {} };
    if (suggestions?.length) request.suggestions = suggestions;
    this.send({ type: 'control_request', request_id: requestId, request });
    log(`permission request ${requestId} tool=${toolName} kind=${kind}`);
    return new Promise((resolve) => {
      const entry = { toolName, resolve, input, kind, createdAt: Date.now() };
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

  async _handleExitPlan(input, signal) {
    // Author the plan file BEFORE the approval card (ordering contract: the
    // frontend's eager-capture path expects plan_file_written first).
    const planBody = (input?.plan || '').trim();
    if (planBody) {
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
    const targetMode = decision === 'acceptEdits' ? 'acceptEdits' : 'default';
    const q = this.q;
    setTimeout(() => {
      if (this.q !== q || !q) return;
      q.setPermissionMode(targetMode)
        .then(() => {
          this.permissionMode = targetMode;
          this.sendEvent({ type: 'mode_changed', mode: targetMode });
        })
        .catch(err => log('setPermissionMode after plan approve failed:', err.message));
    }, 50);
    return { behavior: 'allow', updatedInput: res.updatedInput || input };
  }

  // AskUserQuestion answers arrive as updatedInput {questions, answers} from the
  // existing frontend card. The CLI's AskUserQuestion tool reads ONLY the
  // top-level `answers` map, looked up by each question's exact `question` text
  // (verified against the bundled CLI: missing/empty map → "The user did not
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
    return { ...originalInput, answers };
  }

  _resolvePermission(requestId, innerResponse) {
    const entry = this.pendingPerms.get(requestId);
    if (!entry) { log('control_response for unknown/expired request:', requestId); return; }
    this.pendingPerms.delete(requestId);
    const behavior = innerResponse?.behavior;
    const latencyMs = Date.now() - entry.createdAt;
    log(`permission resolved ${requestId} tool=${entry.toolName} behavior=${behavior} latency=${latencyMs}ms`);

    if (behavior === 'allow') {
      if (innerResponse.always && entry.kind === 'perm') this.alwaysAllowed.add(entry.toolName);
      let updatedInput = innerResponse.updatedInput || entry.input;
      if (entry.kind === 'ask') updatedInput = this._normalizeAskInput(entry.input, innerResponse.updatedInput);
      const result = { behavior: 'allow', updatedInput };
      if (Array.isArray(innerResponse.updatedPermissions) && innerResponse.updatedPermissions.length) {
        result.updatedPermissions = innerResponse.updatedPermissions;
      }
      if (entry.kind === 'plan') result._planDecision = innerResponse.planDecision || 'default';
      entry.resolve(result);
    } else {
      const message = innerResponse?.message
        || (entry.kind === 'plan'
          ? 'User wants to keep planning. Revise the plan based on their feedback.'
          : `User denied permission for ${entry.toolName}`);
      entry.resolve({ behavior: 'deny', message });
    }
  }

  _denyAllPending(reason) {
    for (const [rid, entry] of this.pendingPerms) {
      entry.resolve({ behavior: 'deny', message: reason });
      this.send({ type: 'control_cancelled', request_id: rid });
    }
    this.pendingPerms.clear();
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
    const killSec = this.effort === 'max' ? 300 : this.effort === 'high' ? 120 : 90;
    if (silentSec >= STALL_WARN_SEC && silentSec < killSec) {
      log(`stall warning: silent ${silentSec}s (kill at ${killSec}s) retries=${this.stallRetries}`);
      return;
    }
    if (silentSec < killSec) return;
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
    if (Date.now() - this.lastActivity < IDLE_REAP_MS) return;
    log(`idle reap: ending query for session ${this.sessionId || '(new)'} — next prompt resumes transparently`);
    this._endQuery({ graceful: true });
  }

  // ── inbound WS messages ────────────────────────────────────────────────────

  async handleMessage(msg) {
    switch (msg.type) {
      case 'query': return this._handleQuery(msg);
      case 'control_response': {
        const rid = msg.request_id || msg.response?.request_id;
        const inner = msg.response?.response || msg.response || {};
        if (rid) this._resolvePermission(rid, inner);
        return;
      }
      case 'tool_result': {
        // Legacy AskUserQuestion text-answer path. If an ask is pending, resolve it;
        // otherwise feed the answer as a plain user message into the live session.
        const answer = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '');
        const askEntry = [...this.pendingPerms.entries()].find(([, e]) => e.kind === 'ask');
        if (askEntry) {
          // Key by the first question's exact text — the CLI looks up answers[question.question]
          const qText = askEntry[1].input?.questions?.[0]?.question || 'answer';
          this._resolvePermission(askEntry[0], { behavior: 'allow', updatedInput: { answers: { [qText]: answer } } });
        } else if (answer) {
          this.lastPrompt = answer;
          this._pushUserText(`The user answered your question:\n\n${answer}\n\nContinue based on their selection.`);
        }
        return;
      }
      case 'compact': {
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
        if (q) { try { await q.interrupt(); } catch (err) { log('interrupt failed:', err.message); } }
        this.send({ type: 'aborted' });
        return;
      }
      case 'set_permission_mode': {
        const mode = msg.mode;
        if (!['default', 'acceptEdits', 'plan', 'bypassPermissions'].includes(mode)) return;
        this.permissionMode = mode;
        if (this.q) {
          try {
            await this.q.setPermissionMode(mode);
          } catch (err) {
            log('setPermissionMode failed:', err.message);
            this.send({ type: 'error', message: `Could not switch permission mode: ${err.message}` });
            return;
          }
        }
        this.sendEvent({ type: 'mode_changed', mode });
        return;
      }
      case 'rewind': {
        const uuid = msg.userMessageUuid;
        // The idle reaper may have ended the Query — resume transparently
        if (!this.q && this.sessionId && uuid) this.ensureQuery();
        if (!uuid || !this.q) {
          this.send({ type: 'rewind_result', ok: false, error: this.q ? 'Missing userMessageUuid' : 'No active session' });
          return;
        }
        try {
          const r = await this.q.rewindFiles(uuid);
          if (r && r.canRewind === false) {
            this.send({ type: 'rewind_result', ok: false, error: r.error || 'Rewind not available for this checkpoint' });
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
      case 'heartbeat': {
        if (msg.windowId) this.windowId = msg.windowId;
        if (msg.sessionId && this.windowId) {
          try { deps.heartbeatLock(msg.sessionId, this.windowId); } catch {}
        }
        return;
      }
      default:
        // 'reattach' handled at the connection layer
        return;
    }
  }

  _handleQuery(msg) {
    let { prompt, cwd, sessionId, model, effort, images, windowId, permissionMode } = msg;
    if (windowId) this.windowId = windowId;
    if (model && model.includes(':')) model = deps.toCliModelName(model);
    if (!prompt && !images?.length) {
      this.send({ type: 'error', message: 'No prompt provided' });
      return;
    }

    // Session lock — identical to legacy
    if (sessionId && this.windowId) {
      try {
        const lockResult = deps.acquireSessionLock(sessionId, this.windowId, null);
        if (!lockResult.ok) {
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
    const effortChanged = effort && this.effort && effort !== this.effort;
    const sessionChanged = sessionId && this.sessionId && sessionId !== this.sessionId;
    const modelChanged = model && this.model && model !== this.model;

    if (sessionId) this.sessionId = sessionId;
    if (cwd) this.cwd = cwd;
    if (effort) this.effort = effort;
    if (model) this.model = model;
    if (permissionMode && ['default', 'acceptEdits', 'plan', 'bypassPermissions'].includes(permissionMode)) {
      this.permissionMode = permissionMode;
    }
    this.lastPrompt = prompt;

    if (this.q && (cwdChanged || effortChanged || sessionChanged)) {
      log(`config change (cwd=${!!cwdChanged} effort=${!!effortChanged} session=${!!sessionChanged}) — recreating query`);
      this._endQuery({ graceful: true }).then(() => {
        if (this.destroyed) return;
        this.ensureQuery();
        this._pushUserText(prompt, images);
      });
      return;
    }

    const hadQuery = !!this.q;
    this._pushUserText(prompt, images);

    if (hadQuery && modelChanged && this.q) {
      this.q.setModel(model).catch(err => log('setModel failed:', err.message));
    }
    if (hadQuery && permissionMode && this.q) {
      this.q.setPermissionMode(this.permissionMode).catch(() => {});
    }
  }

  // ── detach / reattach / destroy ───────────────────────────────────────────

  detach() {
    if (this.destroyed) return false;
    const busy = this.inTurn || this.pendingPerms.size > 0;
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
    log(`detached session ${key} (turn in flight: ${this.inTurn}, pending perms: ${this.pendingPerms.size})`);
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
    };
    if (this.orphanResynced) result.resynced = true;
    this.orphanResynced = false;
    if (ws.readyState === 1) { try { ws.send(JSON.stringify(result)); } catch {} }
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
    clearTimeout(this._watchdogStartTimer);
    clearInterval(this._watchdog);
    clearInterval(this._lockBeat);
    clearInterval(this._idleReaper);
    clearTimeout(this.orphanKillTimer);
    this._replaying = false;
    this._replayQueue = null;
    for (const slot of this._deltaBuf.values()) clearTimeout(slot.timer);
    this._deltaBuf.clear();
    this._denyAllPending('Session closed');
    try { this.input?.close(); } catch {}
    try { this.abortController?.abort(); } catch {}
    this.q = null;
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
    ws.send(JSON.stringify({ type: 'engine', engine: 'sdk', sdkVersion: SDK_VERSION }));
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
      if (msg.type === 'reattach') {
        const wid = msg.windowId;
        if (!wid) return;
        const key = _orphanKey(wid, msg.sessionId);
        const orphan = _detached.get(key);
        if (!orphan || orphan.destroyed) {
          if (orphan) _detached.delete(key);
          try { ws.send(JSON.stringify({ type: 'reattach_result', ok: false })) } catch {}
          // No orphan: fall through to a fresh session bound to this windowId
          if (!session) { session = new ClaudeSession(ws); }
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
        session = new ClaudeSession(ws);
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

export function shutdownAllBridges() {
  for (const session of [..._allSessions]) {
    try { session.destroy(); } catch {}
  }
  _detached.clear();
}

export function bridgeStats() {
  return { sessions: _allSessions.size, detached: _detached.size, sdkVersion: SDK_VERSION };
}
