// ── SDK event → view model (DOM-free) ──
// The monolith's handleTabEvent keeps the events that drive tab state (init,
// assistant, stream deltas, tool results, result accounting). Everything else an
// SDK session can emit is read here into a plain description; cp-event-rows.js
// turns that description into DOM. Nothing in this file touches the document, so
// tests import it directly (tests/claude-panel-events.test.mjs).

const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// ── Engine hello ──

/**
 * The connection's first message: whether the SDK bridge answers, and what it
 * can do. It is the only engine: a server that answers with anything else (one
 * that was not restarted and still has the retired per-turn engine selected)
 * is a tab without an engine, and says so.
 */
export function readEngineHello(msg) {
  const engine = String(msg?.engine || '');
  const sdk = engine === 'sdk';
  return {
    engine,
    sdk,
    unavailable: !sdk,
    error: sdk ? '' : (engine === 'unavailable'
      ? String(msg?.error || 'the engine did not start')
      : `the server answered with ${engine ? `the retired "${engine}" engine` : 'no engine'}. Restart the SynaBun server.`),
    sdkVersion: msg?.sdkVersion || '',
    // A server that has not been restarted since the panel was updated sends no
    // list: every capability-gated feature stays hidden.
    capabilities: Array.isArray(msg?.capabilities) ? msg.capabilities.filter(c => typeof c === 'string') : [],
  };
}

export function hasCapability(tab, name) {
  return !!tab?.capabilities && typeof tab.capabilities.has === 'function' && tab.capabilities.has(name);
}

// ── Slash commands: the panel or the CLI ──
// A typed "/cmd" is either answered by the panel or sent on as a prompt, where
// the CLI runs its own implementation. Before the parity build the CLI ran
// every command the panel had no entry for, and the ones below; a local handler
// that needs bridge support must not take a command away from a server that
// does not have that support yet (public/ reloads before lib/ restarts).
const CLI_NATIVE = new Set(['init', 'doctor']);
const LOCAL_NEEDS = { context: 'session_requests', mcp: 'session_requests', 'add-dir': 'session_settings' };

/**
 * 'cli' (send the text through) or 'local' (the panel's handler answers).
 * @param spec the panel's own entry for the command (may carry `needs`), or null
 */
export function slashCommandRoute(cmd, spec, { has = () => false } = {}) {
  if (!spec) return 'cli';
  if (CLI_NATIVE.has(cmd)) return 'cli';
  const needs = spec.needs || LOCAL_NEEDS[cmd];
  return needs && !has(needs) ? 'cli' : 'local';
}

// ── Prompt buffering ──
// While a permission card, a question or an elicitation waits for the user,
// the tab holds every incoming message so nothing renders past the prompt.
// The messages that *resolve* a prompt must not be held, or the card waits for
// itself: a new or cancelled control request, a reattach, and the MCP server's
// confirmation that a URL elicitation was completed in the browser.
export function bypassesPromptBuffer(msg) {
  const type = msg?.type;
  if (type === 'control_request' || type === 'control_cancelled' || type === 'reattach_result') return true;
  return type === 'event' && msg.event?.type === 'system' && msg.event?.subtype === 'elicitation_complete';
}

// ── Session state ──
// `idle` is the CLI saying the turn is over. Normally the tab has finished by
// then (the result arrived). If it still shows a turn running a few seconds
// later, with nothing received since and no prompt waiting for the user, the
// message that ends it was lost: the tab is released instead of spinning on.
export function idleEndsTurn(tab, activityWhenIdle) {
  if (!tab || tab.closed || !tab.running) return false;
  if (tab.sessionState !== 'idle') return false;
  if (tab._activePerm || tab.pendingAskRequestId || tab._msgBuffer?.length) return false;
  return tab._lastWsActivity === activityWhenIdle;
}

// ── Turn results ──

const TERMINAL_REASONS = {
  blocking_limit: 'the context is full and could not be compacted',
  rapid_refill_breaker: 'the context kept refilling right after compaction',
  prompt_too_long: 'the prompt is too long for the model',
  image_error: 'an image could not be processed',
  model_error: 'the model returned an error',
  api_error: 'the API returned an error',
  malformed_tool_use_exhausted: 'the model kept sending malformed tool calls',
  stop_hook_prevented: 'a Stop hook blocked the turn from ending',
  hook_stopped: 'a hook stopped the turn',
  tool_deferred: 'a tool call was deferred',
  tool_deferred_unavailable: 'a deferred tool is no longer available',
  max_turns: 'the turn limit was reached',
  budget_exhausted: 'the spend limit was reached',
  structured_output_retry_exhausted: 'structured output could not be produced',
  turn_setup_failed: 'the turn could not be set up',
};

const STARTUP_FAILURES = {
  org_pin_api_key_conflict: 'Managed settings require an organization sign-in, but an API key is configured.',
  provider_not_allowed: 'Managed settings do not allow the API provider this session is set up for.',
  org_verify_failed: "The sign-in's organization could not be verified. Check the network, then sign in again.",
  org_pin_mismatch: 'This sign-in belongs to an organization the managed settings do not allow.',
  managed_settings_invalid: 'Managed policy settings could not be read or leave no allowed model.',
  remote_settings_required_unavailable: 'Managed settings the organization requires could not be loaded.',
  gateway_signin_required: 'The Cloud gateway ended this sign-in. Sign in again.',
  gateway_access_denied: 'The Cloud gateway refused managed settings for this account.',
  proxy_invalid: 'A proxy setting is not a complete URL.',
  temp_dir_unusable: 'The temp directory is unsafe or could not be created.',
  cwd_unavailable: 'The working directory was deleted, moved or cannot be read. Pick another project.',
  shell_tool_missing: 'No shell tool is available (Git Bash or PowerShell).',
  session_held_by_background: 'This conversation is running as a background session. Stop it there first.',
  worktree_resume_refused: "The session's worktree failed its safety checks.",
  worktree_unverified: "The session's worktree could not be verified right now. Retrying may work.",
  cli_version_too_old: 'This Claude Code version is below the minimum Anthropic requires. Update Claude Code.',
  bypass_root: 'Bypass permissions mode cannot run as root.',
};

/**
 * Why a turn ended. `text` is what the transcript shows for a failed turn
 * (empty when there is nothing to add), `notify` what the notification should be.
 * @param ev   an SDK result message
 * @param ctx  { recentlyAborted, assistantErrorShown }
 */
export function describeResult(ev, ctx = {}) {
  const subtype = String(ev?.subtype || '');
  const reason = String(ev?.terminal_reason || '');
  const errors = (Array.isArray(ev?.errors) ? ev.errors : []).map(e => String(e ?? '').trim()).filter(Boolean);
  const out = { isError: false, aborted: false, text: '', notify: 'done', subtype, reason };

  if (subtype === 'success' || subtype === '') {
    if (ev?.is_error === true) {
      // The turn ended on an API error. The CLI also delivers that text as a
      // synthetic assistant message; do not print it twice.
      out.isError = true;
      out.notify = 'error';
      if (!ctx.assistantErrorShown) out.text = clip(String(ev.result || 'The turn ended with an API error.').trim(), 1200);
    }
    return out;
  }

  // The result an interrupt produces: the tab already says "Aborted."
  if (reason.startsWith('aborted') || (ctx.recentlyAborted && !errors.length && !ev?.error && !ev?.startup_failure_reason)) {
    out.aborted = true;
    out.notify = 'none';
    return out;
  }

  out.isError = true;
  out.notify = 'error';
  let head;
  if (subtype === 'error_max_turns') {
    head = `Stopped: the turn limit was reached${Number(ev?.num_turns) > 0 ? ` (${ev.num_turns} turns)` : ''}.`;
  } else if (subtype === 'error_max_budget_usd') {
    head = `Stopped: the session's spend limit was reached${Number(ev?.total_cost_usd) > 0 ? ` ($${Number(ev.total_cost_usd).toFixed(2)} so far)` : ''}.`;
  } else if (subtype === 'error_max_structured_output_retries') {
    head = 'Stopped: structured output could not be produced after several retries.';
  } else if (ev?.startup_failure_reason) {
    head = `Claude Code did not start: ${STARTUP_FAILURES[ev.startup_failure_reason] || ev.startup_failure_reason}`;
  } else if (TERMINAL_REASONS[reason]) {
    head = `The turn stopped: ${TERMINAL_REASONS[reason]}.`;
  } else if (errors.length || ev?.error || ev?.result) {
    head = '';
  } else {
    head = `The turn ended with an error${reason ? ` (${reason})` : ''}.`;
  }
  // `error` and a string `result` are not SDK fields on an error result; the
  // bridge and older engines still send them.
  const detail = errors.length
    ? errors.slice(0, 3).map(e => clip(e, 600))
    : [ev?.error, typeof ev?.result === 'string' ? ev.result : ''].map(e => String(e || '').trim()).filter(Boolean).slice(0, 1).map(e => clip(e, 600));
  const lines = [head, ...detail.filter(d => d && d !== head)].filter(Boolean);
  if (errors.length > 3) lines.push(`(+${errors.length - 3} more)`);
  out.text = lines.join('\n');
  return out;
}

// ── Formatting ──

export function fmtTokens(n) {
  const v = Number(n) || 0;
  const trim = (x) => x.replace(/\.0$/, '');
  if (v >= 1_000_000) return `${trim((v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1))}M`;
  if (v >= 1000) return `${trim((v / 1000).toFixed(v >= 100_000 ? 0 : 1))}k`;
  return String(Math.round(v));
}

export function fmtDuration(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v < 0) return '';
  if (v < 1000) return `${Math.round(v)}ms`;
  const s = v / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(Math.floor(s % 60)).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** A reset time as the user reads it: "14:30", or "Mon 14:30" when it is another day. */
export function fmtResetTime(at, now = Date.now()) {
  let ms = Number(at);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1e12) ms *= 1000; // the API reports seconds
  const d = new Date(ms);
  const pad = (x) => String(x).padStart(2, '0');
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const today = new Date(now);
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return sameDay ? clock : `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${clock}`;
}

// CLI output meant for a terminal: drop the colour codes.
export function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s ?? '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

// ── Turn footer (duration, steps, per-model usage and cost) ──

const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'thinkingTokens', 'webSearchRequests', 'costUSD'];

/**
 * result.modelUsage is cumulative for the CLI process. The turn's own share is
 * the difference from the previous result; a counter that went down means the
 * process was replaced (or /clear reset it), and then the new value is the share.
 */
export function turnModelUsage(modelUsage, prev = {}) {
  const models = [];
  const next = {};
  for (const [model, cur] of Object.entries(modelUsage && typeof modelUsage === 'object' ? modelUsage : {})) {
    if (!cur || typeof cur !== 'object') continue;
    const before = prev?.[model] || {};
    const snapshot = {};
    const delta = {};
    let reset = false;
    for (const f of USAGE_FIELDS) {
      snapshot[f] = Number(cur[f]) || 0;
      delta[f] = snapshot[f] - (Number(before[f]) || 0);
      if (delta[f] < -1e-9) reset = true;
    }
    if (reset) for (const f of USAGE_FIELDS) delta[f] = snapshot[f];
    next[model] = snapshot;
    const input = delta.inputTokens + delta.cacheReadInputTokens + delta.cacheCreationInputTokens;
    if (input <= 0 && delta.outputTokens <= 0 && delta.costUSD <= 0) continue;
    models.push({
      model,
      input,
      uncachedInput: delta.inputTokens,
      cacheRead: delta.cacheReadInputTokens,
      cacheWrite: delta.cacheCreationInputTokens,
      output: delta.outputTokens,
      thinking: delta.thinkingTokens,
      webSearches: delta.webSearchRequests,
      cost: delta.costUSD,
      costBasis: cur.costBasis || '',
    });
  }
  models.sort((a, b) => b.cost - a.cost || b.output - a.output);
  return { models, next };
}

const shortModel = (id) => String(id || '').replace(/^claude-/, '').replace(/-\d{8}$/, '');

/**
 * The line under a finished turn. `text` is empty when the result carries
 * nothing worth a row; `next` is the usage snapshot to pass as `prev` next time.
 */
export function describeTurnFooter(ev, prev = {}, ctx = {}) {
  const usage = turnModelUsage(ev?.modelUsage, prev || {});
  const next = usage.next;
  // A resumed session's first result already carries the earlier turns, and
  // there is no previous result to subtract: say nothing about tokens or cost.
  const models = ctx.noBaseline ? [] : usage.models;
  const parts = [];
  const duration = fmtDuration(ev?.duration_ms);
  if (duration && Number(ev?.duration_ms) > 0) parts.push(duration);
  const steps = Number(ev?.num_turns) || 0;
  if (steps > 1) parts.push(`${steps} steps`);
  if (models.length === 1) {
    const m = models[0];
    parts.push(`${shortModel(m.model)} ${fmtTokens(m.input)} in · ${fmtTokens(m.output)} out`);
  } else if (models.length > 1) {
    parts.push(`${models.length} models ${fmtTokens(models.reduce((n, m) => n + m.input, 0))} in · ${fmtTokens(models.reduce((n, m) => n + m.output, 0))} out`);
  }
  const cost = models.reduce((n, m) => n + m.cost, 0);
  if (cost > 0) parts.push(`$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`);
  if (ev?.fast_mode_state === 'on') parts.push('fast mode');
  else if (ev?.fast_mode_state === 'cooldown') parts.push('fast mode cooling down');
  const stop = ev?.stop_reason || ctx.stopReason || '';
  if (stop === 'max_tokens') parts.push('cut off at the output limit');
  const title = models.map((m) => {
    const bits = [`${m.model}: ${m.uncachedInput.toLocaleString('en-US')} input`];
    if (m.cacheRead) bits.push(`${m.cacheRead.toLocaleString('en-US')} cache read`);
    if (m.cacheWrite) bits.push(`${m.cacheWrite.toLocaleString('en-US')} cache write`);
    bits.push(`${m.output.toLocaleString('en-US')} output`);
    if (m.thinking > 0) bits.push(`${m.thinking.toLocaleString('en-US')} of it thinking`);
    if (m.webSearches > 0) bits.push(`${m.webSearches} web search${m.webSearches === 1 ? '' : 'es'}`);
    if (m.cost > 0) bits.push(`$${m.cost.toFixed(4)}${m.costBasis && m.costBasis !== 'list' ? ` (${m.costBasis} pricing)` : ''}`);
    return bits.join(', ');
  }).join('\n');
  return { text: parts.join(' · '), title, models, cost, next };
}

/** A pass-through slash command that answered only through the result text. */
export function localCommandOutput(ev) {
  if (!ev || ev.subtype !== 'success' || ev.is_error) return '';
  if (typeof ev.local_command !== 'string' || !ev.local_command) return '';
  return typeof ev.result === 'string' ? stripAnsi(ev.result).trim() : '';
}

// ── Compaction ──

export function describeCompactBoundary(ev) {
  const m = ev?.compact_metadata || {};
  const pre = Number(m.pre_tokens) || 0;
  const post = Number(m.post_tokens) || 0;
  let text = `Context compacted${m.trigger === 'auto' ? ' automatically' : ''}`;
  if (pre > 0 && post > 0) text += `: ${fmtTokens(pre)} → ${fmtTokens(post)} tokens`;
  else if (pre > 0) text += `: was ${fmtTokens(pre)} tokens`;
  if (Number(m.duration_ms) > 0) text += ` in ${fmtDuration(m.duration_ms)}`;
  return text;
}

// ── Rate limits ──

const LIMIT_NAMES = {
  five_hour: '5-hour limit',
  seven_day: 'weekly limit',
  seven_day_opus: 'weekly Opus limit',
  seven_day_sonnet: 'weekly Sonnet limit',
  seven_day_overage_included: 'weekly limit',
  overage: 'extra usage limit',
};
const LIMIT_PILLS = { five_hour: '5h', seven_day: '7d', seven_day_opus: '7d Opus', seven_day_sonnet: '7d Sonnet', seven_day_overage_included: '7d', overage: 'extra' };

/** Read a rate_limit_event into a statusline pill and a transcript line. */
export function describeRateLimit(info, now = Date.now()) {
  const i = info && typeof info === 'object' ? info : {};
  const name = LIMIT_NAMES[i.rateLimitType] || 'usage limit';
  const short = LIMIT_PILLS[i.rateLimitType] || 'limit';
  const resets = fmtResetTime(i.resetsAt, now);
  let pct = Number(i.utilization);
  if (Number.isFinite(pct)) pct = Math.round(pct <= 1 ? pct * 100 : pct); else pct = null;
  const overage = i.isUsingOverage === true || i.overageInUse === true;
  const key = `${i.rateLimitType || ''}:${i.status || ''}:${overage ? 'overage' : ''}`;
  const tail = resets ? ` Resets ${resets}.` : '';

  if (i.status === 'rejected') {
    let text = `You've hit your ${name}.${tail}`;
    if (i.overageStatus === 'rejected') text += ' Extra usage is not available.';
    else if (overage) text += ' Extra usage is covering requests.';
    if (i.errorCode === 'credits_required') text += ' Usage credits are required to continue.';
    return { level: 'blocked', pill: `${short} limit${resets ? ` · ${resets}` : ''}`, text, key };
  }
  if (i.status === 'allowed_warning') {
    return {
      level: 'warn',
      pill: `${short}${pct != null ? ` ${pct}%` : ''}`,
      text: `Approaching your ${name}${pct != null ? `: ${pct}% used` : ''}.${tail}`,
      key,
    };
  }
  if (overage) {
    return { level: 'warn', pill: 'extra usage', text: `Now using extra usage: your ${name} is used up.${tail}`, key };
  }
  return { level: 'ok', pill: '', text: '', key };
}

// The CLI's own limit sentences arrive as ordinary assistant text. These are the
// prefixes the SDK exports for recognising them (sdk.d.ts USAGE_*_PREFIXES,
// ORG_POLICY_LIMIT_PREFIXES); a host cannot import the SDK into a browser page.
const USAGE_LIMIT_ERROR_PREFIXES = ["You've hit your", "You've reached your", "You're out of usage credits", 'Your org is out of usage · add funds to continue', 'Your org is out of usage · contact your admin', "Your seat type doesn't include usage credits", "Your seat type doesn't include usage", 'Your usage allocation has been disabled by your admin', "Your group's usage limit is set to $0", 'Fable 5 requires usage credits', "You're out of extra usage", "Your seat type doesn't include extra usage"];
const USAGE_TRANSITION_PREFIXES = ["You're now using usage credits", "You're now using your usage allocation", 'Now using your usage allocation', 'Now using usage credits', "You're now using extra usage", 'Now using extra usage'];
const USAGE_WARNING_PREFIXES = ["You've used", "You're close to"];
const ORG_POLICY_LIMIT_PREFIXES = ['This service is disabled for your org'];

/** `blocked` | `warn` | `notice` for a limit sentence, else ''. */
export function classifyLimitText(text) {
  const t = String(text || '').trimStart();
  if (!t) return '';
  const starts = (list) => list.some(p => t.startsWith(p));
  if (starts(USAGE_LIMIT_ERROR_PREFIXES) || starts(ORG_POLICY_LIMIT_PREFIXES)) return 'blocked';
  if (starts(USAGE_WARNING_PREFIXES)) return 'warn';
  if (starts(USAGE_TRANSITION_PREFIXES)) return 'notice';
  return '';
}

// ── Assistant message state ──

const ASSISTANT_ERRORS = {
  authentication_failed: ['Not signed in', 'The sign-in is missing or expired. Run `claude` in a terminal and use /login, then send again.'],
  oauth_org_not_allowed: ['Organization not allowed', "This sign-in's organization is not allowed to use Claude Code here."],
  account_on_hold: ['Account on hold', 'The account is on hold. Check billing on claude.ai.'],
  verification_required: ['Verification required', 'Finish the account verification on claude.ai, then send again.'],
  billing_error: ['Billing problem', 'Check the payment method or the remaining credits.'],
  rate_limit: ['Rate limited', 'Wait for the limit to reset, or switch to another model.'],
  overloaded: ['API overloaded', 'The API is overloaded. Send again in a moment.'],
  invalid_request: ['Request rejected', 'The API rejected the request as invalid.'],
  model_not_found: ['Model not available', 'This model is not available to the account. Pick another model.'],
  server_error: ['API error', 'The API had a server error. Send again in a moment.'],
  max_output_tokens: ['Output limit reached', 'The reply hit the output limit and was cut off.'],
  cloud_credential_error: ['Cloud credentials', 'The cloud provider credentials are missing or expired.'],
  unknown: ['Error', ''],
};

const blockText = (message) => (Array.isArray(message?.content) ? message.content : [])
  .filter(b => b?.type === 'text').map(b => b.text || '').join('\n');

/** What the wrapper of an assistant message says beyond its content blocks. */
export function describeAssistantState(ev) {
  const message = ev?.message || {};
  const out = { error: null, aborted: ev?.aborted === true, truncated: message.stop_reason === 'max_tokens', timestamp: '', limit: '', uuid: ev?.uuid || '', supersedes: [] };
  if (ev?.error) {
    const [title, hint] = ASSISTANT_ERRORS[ev.error] || [String(ev.error).replace(/_/g, ' '), ''];
    out.error = { kind: String(ev.error), title, hint };
    if (ev.error === 'max_output_tokens') out.truncated = true;
  }
  if (typeof ev?.timestamp === 'string' && !Number.isNaN(Date.parse(ev.timestamp))) out.timestamp = ev.timestamp;
  if (Array.isArray(ev?.supersedes)) out.supersedes = ev.supersedes.filter(u => typeof u === 'string');
  // Limit sentences come as synthetic messages (no real model behind them).
  if (ev?.error || message.model === '<synthetic>') out.limit = classifyLimitText(blockText(message));
  return out;
}

const httpUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : '');

/**
 * The blocks of an assistant message the three classic kinds (text, thinking,
 * tool_use) do not cover: server-side tool calls and their results, citations
 * on text, redacted thinking.
 */
export function splitAssistantBlocks(content) {
  const out = { serverTools: [], serverResults: [], citations: [], redacted: 0, any: false };
  const seen = new Set();
  for (const b of Array.isArray(content) ? content : []) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'redacted_thinking') { out.redacted++; continue; }
    if (b.type === 'server_tool_use' || b.type === 'mcp_tool_use') {
      if (b.id) out.serverTools.push({ id: b.id, name: b.server_name ? `${b.server_name}: ${b.name}` : String(b.name || 'server tool'), input: b.input && typeof b.input === 'object' ? b.input : {} });
      continue;
    }
    if (typeof b.type === 'string' && b.type !== 'tool_result' && b.type.endsWith('_tool_result') && b.tool_use_id) {
      const links = [];
      const texts = [];
      let isError = b.is_error === true;
      const visit = (c) => {
        if (c == null) return;
        if (typeof c === 'string') { if (c.trim()) texts.push(c.trim()); return; }
        if (Array.isArray(c)) { c.forEach(visit); return; }
        if (typeof c !== 'object') return;
        if (c.error_code) { isError = true; texts.push(`Error: ${c.error_code}`); return; }
        const url = httpUrl(c.url);
        if (url) { links.push({ title: String(c.title || url), url }); return; }
        for (const k of ['text', 'stdout', 'stderr']) if (typeof c[k] === 'string' && c[k].trim()) texts.push(c[k].trim());
        if (c.content != null) visit(c.content);
      };
      visit(b.content);
      out.serverResults.push({ toolUseId: b.tool_use_id, kind: b.type, links, text: clip(texts.join('\n'), 4000), isError });
      continue;
    }
    if (b.type === 'text' && Array.isArray(b.citations)) {
      for (const c of b.citations) {
        const url = httpUrl(c?.url);
        const title = String(c?.title || c?.document_title || url || '').trim();
        const key = url || title;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.citations.push({ title: title || url, url });
      }
    }
  }
  out.any = out.redacted > 0 || out.serverTools.length > 0 || out.serverResults.length > 0 || out.citations.length > 0;
  return out;
}

// ── Streaming tool input ──

const PREVIEW_KEYS = ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'description', 'skill', 'path', 'prompt'];

/**
 * What a tool call is about, read from the JSON the model has typed so far
 * (input_json_delta). The JSON is incomplete by definition: pull the first
 * telling string field out with a tolerant match instead of parsing it.
 */
export function previewPartialToolInput(partialJson) {
  const src = String(partialJson || '');
  for (const key of PREVIEW_KEYS) {
    const m = src.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`));
    if (!m || !m[1]) continue;
    let value = m[1];
    try { value = JSON.parse(`"${value.replace(/\\$/, '')}"`); } catch { value = value.replace(/\\n/g, ' ').replace(/\\(.)/g, '$1'); }
    value = String(value).split('\n')[0].trim();
    if (!value) continue;
    if (key === 'file_path' || key === 'notebook_path' || key === 'path') value = value.split(/[/\\]/).pop() || value;
    return { key, value: clip(value, 60) };
  }
  return null;
}

// ── Slash commands ──

/**
 * The CLI's command list as the hint menu uses it. Rows can share a name: the
 * one marked `builtin` is the one `/name` runs. Commands whose UX is bound to
 * the terminal (init.terminal_slash_commands) are left out.
 */
export function normalizeSlashCommands(list, { terminalOnly = [] } = {}) {
  const hidden = new Set((Array.isArray(terminalOnly) ? terminalOnly : []).map(n => String(n).replace(/^\//, '').toLowerCase()));
  const byName = new Map();
  for (const raw of Array.isArray(list) ? list : []) {
    const c = typeof raw === 'string' ? { name: raw } : raw;
    if (!c?.name) continue;
    const name = String(c.name).replace(/^\//, '');
    const key = name.toLowerCase();
    if (hidden.has(key)) continue;
    const row = {
      name,
      description: c.description || 'CLI command',
      argumentHint: c.argumentHint || c.argument_hint || '',
      aliases: (Array.isArray(c.aliases) ? c.aliases : []).map(a => String(a).replace(/^\//, '')).filter(Boolean),
      builtin: c.builtin === true,
    };
    const existing = byName.get(key);
    if (!existing || (row.builtin && !existing.builtin)) byName.set(key, row);
  }
  return [...byName.values()];
}

/** Commands whose name or alias starts with what was typed; `via` names the alias that matched. */
export function matchSlashCommands(list, typed) {
  const q = String(typed || '').toLowerCase();
  if (!q) return [];
  const out = [];
  for (const c of Array.isArray(list) ? list : []) {
    const name = String(c?.name || '').toLowerCase();
    if (!name) continue;
    if (name.startsWith(q)) { out.push({ ...c, via: '' }); continue; }
    const alias = (c.aliases || []).find(a => String(a).toLowerCase().startsWith(q));
    if (alias) out.push({ ...c, via: alias });
  }
  return out;
}

/** A bare "/" lists every command, as the CLI does: one row per name, in list order. */
export function listSlashCommands(list) {
  const out = [];
  const seen = new Set();
  for (const c of Array.isArray(list) ? list : []) {
    const name = String(c?.name || '').toLowerCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ ...c, via: '' });
  }
  return out;
}

/**
 * How tall the slash menu may be: `room` is the space between the top of the
 * panel and the input the menu opens above. The whole list scrolls inside that,
 * so it never leaves the panel; two rows stay visible in the shortest panel.
 */
export function slashMenuMaxHeight(room, { cap = 320, floor = 72, gap = 8 } = {}) {
  const r = Number(room);
  if (!Number.isFinite(r) || r <= 0) return cap; // not laid out (hidden panel): the stylesheet's cap
  return Math.max(floor, Math.min(cap, Math.floor(r - gap)));
}

/**
 * The panel's own commands a server can serve, and the ones that wait for its
 * restart (their `needs` capability is not advertised).
 */
export function splitCommandsByCapability(commands, has = () => false) {
  const available = [];
  const locked = [];
  for (const c of Array.isArray(commands) ? commands : []) (c?.needs && !has(c.needs) ? locked : available).push(c);
  return { available, locked };
}

// ── Session info (init) ──

/** The fields of system/init the status card and the slash menu read. */
export function readInit(ev) {
  const list = (v) => (Array.isArray(v) ? v : []);
  return {
    model: ev?.model || '',
    cliVersion: ev?.claude_code_version || '',
    cwd: ev?.cwd || '',
    apiKeySource: ev?.apiKeySource || '',
    outputStyle: ev?.output_style || '',
    permissionMode: ev?.permissionMode || '',
    effort: ev?.effort ?? null,
    fastMode: ev?.fast_mode_state || '',
    tools: list(ev?.tools).length,
    skills: list(ev?.skills),
    agents: list(ev?.agents),
    plugins: list(ev?.plugins).map(p => ({ name: p?.name || '', version: p?.version || '' })).filter(p => p.name),
    pluginErrors: list(ev?.plugin_errors).map(e => ({ plugin: e?.plugin || '', type: e?.type || '', message: e?.message || '' })).filter(e => e.plugin || e.message),
    mcpServers: list(ev?.mcp_servers).map(s => ({ name: s?.name || '', status: s?.status || '', source: s?.source || '' })).filter(s => s.name),
    terminalSlashCommands: list(ev?.terminal_slash_commands),
    capabilities: list(ev?.capabilities),
    betas: list(ev?.betas),
  };
}

const KEY_SOURCES = { none: 'claude.ai sign-in', ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY (environment)', apiKeyHelper: 'apiKeyHelper', '/login managed key': 'Console key from /login' };

/**
 * Rows of the /status card: [label, value, tone]. `init` is readInit()'s output
 * (null before the first turn), `account` the bridge's account info when it sent one.
 */
export function statusRows({ init = null, account = null, tab = {} } = {}) {
  const rows = [];
  const add = (k, v, tone = '') => { if (v !== '' && v != null) rows.push([k, String(v), tone]); };
  add('Session', tab.sessionId ? `${tab.sessionId}${tab.label ? ` · ${tab.label}` : ''}` : '(new)');
  if (!init) {
    add('Details', 'Send a message to start the session; its details appear here afterwards.', 'muted');
    return rows;
  }
  add('Model', init.model);
  add('Claude Code', init.cliVersion + (tab.sdkVersion ? ` · SDK ${tab.sdkVersion}` : ''));
  add('Working directory', init.cwd);
  if (account?.email || account?.organization) add('Account', [account.email, account.organization, account.subscriptionType].filter(Boolean).join(' · '));
  add('Credential', KEY_SOURCES[init.apiKeySource] || init.apiKeySource);
  add('Permission mode', init.permissionMode);
  if (init.effort) add('Effort', init.effort);
  if (init.fastMode && init.fastMode !== 'off') add('Fast mode', init.fastMode);
  if (init.outputStyle && init.outputStyle !== 'default') add('Output style', init.outputStyle);
  add('Tools', init.tools ? `${init.tools}` : '');
  if (init.mcpServers.length) {
    const bad = init.mcpServers.filter(s => !/connect|ok|ready|running/i.test(s.status));
    add('MCP servers', init.mcpServers.map(s => `${s.name} (${s.status || 'unknown'})`).join(', '), bad.length ? 'warn' : 'ok');
  }
  if (init.skills.length) add('Skills', `${init.skills.length}`);
  if (init.agents.length) add('Agents', init.agents.join(', '));
  if (init.plugins.length) add('Plugins', init.plugins.map(p => (p.version ? `${p.name} ${p.version}` : p.name)).join(', '));
  for (const e of init.pluginErrors) add('Plugin error', `${e.plugin || 'plugin'}: ${e.message || e.type}`, 'warn');
  if (tab.turns != null) add('Turns', `${tab.turns}`);
  if (Number(tab.sessionCost) > 0) add('Cost', `$${Number(tab.sessionCost).toFixed(4)}`);
  return rows;
}

// ── Everything else ──

/** `type/subtype`, the name an event is logged and deduplicated under. */
export function eventLabel(ev) {
  const type = String(ev?.type || 'unknown');
  return ev?.subtype ? `${type}/${ev.subtype}` : type;
}

// Liveness and bookkeeping frames with nothing to show.
const IGNORED = new Set([
  'keep_alive',
  'system/worker_shutting_down',
  'system/mirror_error',
  'system/control_request_progress',
]);

const RESET_TRIGGERS = { clear: 'Conversation cleared', plan_mode_exit: 'Conversation cleared to implement the plan', fresh_session: 'Fresh session started for the approved plan', onboarding: 'Conversation reset' };

/**
 * Describe an event the monolith's own branches did not consume. The `kind`
 * says which renderer of cp-event-rows.js takes it; `unknown` is the fallback
 * for types this panel has no renderer for.
 */
export function describeEvent(ev) {
  const label = eventLabel(ev);
  if (IGNORED.has(label)) return { kind: 'ignore', label };
  switch (label) {
    case 'system/informational': {
      const text = stripAnsi(ev.content).trim();
      if (!text) return { kind: 'ignore', label };
      const level = ev.prevent_continuation ? 'warn'
        : ev.level === 'warning' ? 'warn'
          : ev.level === 'suggestion' ? 'notice'
            : ev.level === 'info' ? 'transcript' : 'status';
      return { kind: 'row', label, level, text: clip(text, 1500), key: ev.tool_use_id ? `info:${ev.tool_use_id}` : '' };
    }
    case 'system/notification': {
      const text = stripAnsi(ev.text).trim();
      if (!text) return { kind: 'ignore', label };
      const loud = ev.priority === 'high' || ev.priority === 'immediate';
      return { kind: 'row', label, level: loud ? 'warn' : 'status', text: clip(text, 800), key: ev.key ? `notif:${ev.key}` : '' };
    }
    case 'system/api_retry': {
      const attempt = Number(ev.attempt) || 1;
      const max = Number(ev.max_retries) || 0;
      const why = ev.error && ev.error !== 'unknown' ? String(ev.error).replace(/_/g, ' ') : (ev.error_status ? `HTTP ${ev.error_status}` : (ev.no_response ? 'no response' : 'connection error'));
      const wait = Number(ev.retry_delay_ms) > 0 ? fmtDuration(ev.retry_delay_ms) : '';
      const count = max ? `${attempt}/${max}` : `${attempt}`;
      return {
        kind: 'retry', label,
        verb: `Retrying ${count} · ${why}`,
        text: `API request failed (${why}${ev.error_status ? `, ${ev.error_status}` : ''}). Retry ${count}${wait ? ` in ${wait}` : ''}.`,
        key: 'api_retry',
      };
    }
    case 'system/status':
      return {
        kind: 'status', label,
        status: ev.status ?? null,
        permissionMode: typeof ev.permissionMode === 'string' ? ev.permissionMode : '',
        compactResult: ev.compact_result || '',
        compactError: ev.compact_error ? clip(ev.compact_error, 600) : '',
      };
    case 'system/local_command_output': {
      const text = stripAnsi(ev.content).trim();
      return text ? { kind: 'command_output', label, text } : { kind: 'ignore', label };
    }
    case 'system/permission_denied':
      return {
        kind: 'denied', label,
        toolUseId: ev.tool_use_id || '',
        toolName: ev.tool_name || '',
        reasonType: ev.decision_reason_type || '',
        reason: clip(ev.decision_reason || ev.message || '', 400),
        agentId: ev.agent_id || '',
      };
    case 'rate_limit_event':
      return { kind: 'rate_limit', label, info: ev.rate_limit_info || {} };
    case 'system/model_refusal_fallback':
    case 'system/model_refusal_no_fallback': {
      const fallback = ev.subtype === 'model_refusal_fallback';
      const local = ev.scope === 'local';
      const lines = [stripAnsi(ev.content).trim()];
      if (fallback && ev.direction === 'retry') {
        lines.push(local
          ? `That response came from ${ev.fallback_model}; the session stays on ${ev.original_model}.`
          : `The session continues on ${ev.fallback_model} (was ${ev.original_model}).`);
      }
      if (ev.api_refusal_explanation) lines.push(clip(String(ev.api_refusal_explanation), 600));
      return {
        kind: 'refusal', label,
        text: lines.filter(Boolean).join('\n') || 'The model declined this request.',
        category: ev.api_refusal_category || '',
        retracted: Array.isArray(ev.retracted_message_uuids) ? ev.retracted_message_uuids : [],
        refusedUserUuid: ev.refused_user_message_uuid || '',
        fallbackModel: fallback ? (ev.fallback_model || '') : '',
        sessionModelChanged: fallback && !local && ev.direction === 'retry',
      };
    }
    case 'system/session_info':
      return { kind: 'session_info', label, info: ev.info && typeof ev.info === 'object' ? ev.info : {} };
    case 'system/hook_started':
      return { kind: 'hook', label, phase: 'started', id: ev.hook_id || '', ev };
    case 'system/hook_progress':
      return { kind: 'ignore', label }; // the response carries the whole output
    case 'system/hook_response':
      return { kind: 'hook', label, phase: 'done', id: ev.hook_id || '', ev };
    case 'system/task_started':
    case 'system/task_progress':
    case 'system/task_updated':
    case 'system/task_notification':
      return { kind: 'task', label, ev };
    case 'system/cache_cost':
      return { kind: 'cache_cost', label, ev };
    case 'system/session_crons':
      return { kind: 'crons', label, crons: Array.isArray(ev.crons) ? ev.crons : [] };
    case 'system/session_state_changed':
      // The CLI's own word: running, idle (the turn is over), requires_action
      // (it waits for an answer). The bridge reads it for its turn accounting too.
      return ['running', 'idle', 'requires_action'].includes(ev.state) ? { kind: 'session_state', label, state: ev.state } : { kind: 'ignore', label };
    case 'prompt_suggestion': {
      const text = String(ev.suggestion || '').trim();
      return text ? { kind: 'suggestion', label, text: clip(text, 400) } : { kind: 'ignore', label };
    }
    case 'system/plugins_list':
      return {
        kind: 'plugins', label,
        plugins: (Array.isArray(ev.plugins) ? ev.plugins : []).map(p => ({ name: p?.name || '', version: p?.version || '' })).filter(p => p.name),
        agents: Array.isArray(ev.agents) ? ev.agents : null,
      };
    case 'system/commands_changed':
      return { kind: 'commands', label, commands: Array.isArray(ev.commands) ? ev.commands : [] };
    case 'tool_progress':
      return {
        kind: 'tool_progress', label,
        toolUseId: ev.tool_use_id || '',
        elapsed: Number(ev.elapsed_time_seconds) || 0,
        retry: ev.subagent_retry
          ? `retrying ${ev.subagent_retry.attempt}/${ev.subagent_retry.max_retries}${ev.subagent_retry.error_category ? ` (${String(ev.subagent_retry.error_category).replace(/_/g, ' ')})` : ''}`
          : '',
      };
    case 'system/thinking_tokens':
      return { kind: 'thinking_tokens', label, tokens: Number(ev.estimated_tokens) || 0 };
    case 'tool_use_summary': {
      const text = String(ev.summary || '').trim();
      return text
        ? { kind: 'summary', label, text: clip(text, 400), toolUseIds: Array.isArray(ev.preceding_tool_use_ids) ? ev.preceding_tool_use_ids : [] }
        : { kind: 'ignore', label };
    }
    case 'system/memory_recall': {
      const memories = (Array.isArray(ev.memories) ? ev.memories : []).map(m => ({
        path: String(m?.path || ''), scope: m?.scope || 'personal', content: typeof m?.content === 'string' ? clip(m.content, 2000) : '',
      })).filter(m => m.path || m.content);
      if (!memories.length) return { kind: 'ignore', label };
      return {
        kind: 'memory_recall', label, memories,
        text: ev.mode === 'synthesize'
          ? 'Recalled from Claude memory (summary)'
          : `Recalled ${memories.length} Claude memory file${memories.length === 1 ? '' : 's'}`,
      };
    }
    case 'conversation_reset':
      return { kind: 'reset', label, text: RESET_TRIGGERS[ev.trigger] || 'Conversation reset', timestamp: ev.timestamp || '', newConversationId: ev.new_conversation_id || '' };
    case 'auth_status': {
      const output = (Array.isArray(ev.output) ? ev.output : []).map(l => stripAnsi(l)).filter(l => l.trim());
      return { kind: 'auth', label, authenticating: ev.isAuthenticating === true, text: output.join('\n'), error: ev.error ? String(ev.error) : '' };
    }
    case 'system/elicitation_complete':
      return { kind: 'row', label, level: 'status', text: `${ev.mcp_server_name || 'MCP server'}: sign-in step completed.`, key: '', elicitationId: ev.elicitation_id || '' };
    case 'system/plugin_install': {
      const name = ev.name ? ` ${ev.name}` : '';
      const text = ev.status === 'started' ? 'Installing plugins…'
        : ev.status === 'installed' ? `Plugin marketplace${name} installed.`
          : ev.status === 'failed' ? `Plugin install failed${name ? ` for${name}` : ''}${ev.error ? `: ${clip(ev.error, 300)}` : '.'}`
            : 'Plugin install finished.';
      return { kind: 'row', label, level: ev.status === 'failed' ? 'warn' : 'status', text, key: ev.status === 'failed' ? '' : 'plugin_install' };
    }
    case 'system/files_persisted': {
      const ok = Array.isArray(ev.files) ? ev.files.length : 0;
      const failed = Array.isArray(ev.failed) ? ev.failed : [];
      if (!ok && !failed.length) return { kind: 'ignore', label };
      const parts = [];
      if (ok) parts.push(`${ok} file${ok === 1 ? '' : 's'} saved`);
      if (failed.length) parts.push(`${failed.length} failed (${failed.slice(0, 3).map(f => f?.filename || '?').join(', ')})`);
      return { kind: 'row', label, level: failed.length ? 'warn' : 'status', text: `Files persisted: ${parts.join(', ')}.`, key: '' };
    }
    case 'active_goal': {
      const v = ev.value;
      if (!v) return { kind: 'row', label, level: 'status', text: 'Goal cleared.', key: 'active_goal' };
      return {
        kind: 'row', label, level: 'status', key: 'active_goal',
        text: `Goal: ${clip(v.condition, 300)}${Number(v.iterations) > 0 ? ` (iteration ${v.iterations})` : ''}${v.last_reason ? `. ${clip(v.last_reason, 200)}` : ''}`,
      };
    }
    default:
      return { kind: 'unknown', label };
  }
}
