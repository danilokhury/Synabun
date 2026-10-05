// ── Transcript rows for SDK events (DOM glue over cp-events.js) ──
// What each event means is decided in cp-events.js (DOM-free, unit-tested).
// This file only puts the result on screen.

import { cpCtx } from './cp-ctx.js';
import { renderStatusline, setActivity } from './cp-statusline.js';
import { reduceTaskEvent, taskProgressLine, isTaskRunning, hookEntry } from './cp-tasks-model.js';
import { cacheCostText } from './cp-sessions.js';
import {
  describeEvent,
  readEngineHello,
  describeRateLimit,
  describeCompactBoundary,
  describeAssistantState,
  previewPartialToolInput,
  fmtTokens,
} from './cp-events.js';

const sel = (id) => CSS.escape(String(id || ''));

function findToolCard(tab, toolUseId) {
  if (!toolUseId) return null;
  return tab.messagesEl?.querySelector(`.tool-card[data-tool-id="${sel(toolUseId)}"]`) || null;
}

// ── Plain rows ──

function transcriptOnlyRow(tab, text, cls = '') {
  const $msgs = tab.messagesEl;
  if (!$msgs) return null;
  const el = document.createElement('div');
  el.className = `cp-transcript-only${cls ? ` ${cls}` : ''}`;
  el.textContent = text;
  $msgs.appendChild(el);
  return el;
}

function appendRow(tab, level, text) {
  if (level === 'transcript') return transcriptOnlyRow(tab, text);
  if (level === 'error') return cpCtx.appendError(tab, text);
  if (level === 'warn') return cpCtx.appendWarn(tab, text);
  const el = cpCtx.appendStatus(tab, text);
  if (el && level === 'notice') el.classList.add('cp-row-notice');
  return el;
}

// A row that updates in place: progress lines for one tool call, a notification
// the CLI re-issues under the same key, the retry counter of the current turn.
function upsertRow(tab, key, level, text) {
  if (!key) return appendRow(tab, level, text);
  tab._eventRows = tab._eventRows || new Map();
  const existing = tab._eventRows.get(key);
  if (existing?.isConnected) {
    existing.textContent = text;
    return existing;
  }
  const el = appendRow(tab, level, text);
  if (el) tab._eventRows.set(key, el);
  return el;
}

/** A finished turn: its transient rows stay as history, the next turn gets new ones. */
export function endTurnRows(tab) {
  tab._eventRows?.delete('api_retry');
  tab._thinkTokens = 0;
}

// An event type this panel has no renderer for. The SDK's set grows over time:
// say so once per tab, in the console and as a row only the transcript view
// shows, instead of dropping it without a trace.
export function noteUnhandledEvent(tab, label) {
  tab._unhandledEvents = tab._unhandledEvents || new Set();
  if (tab._unhandledEvents.has(label)) return false;
  tab._unhandledEvents.add(label);
  console.debug('[claude-panel] no renderer for event', label);
  transcriptOnlyRow(tab, `Unhandled event: ${label}`, 'cp-unhandled-event');
  return true;
}

// ── Engine hello ──

// The server refused this connection (no engine could be attached). One row per
// tab, with a retry that opens a fresh socket; the next hello from a working
// engine removes it.
export function applyEngineHello(tab, msg, { reconnect } = {}) {
  const hello = readEngineHello(msg);
  const $msgs = tab.messagesEl;
  const existing = $msgs?.querySelector('.cp-engine-error');
  if (!hello.unavailable) {
    if (existing) existing.remove();
    if (tab.engineError) cpCtx.appendStatus(tab, 'Claude Code is available again.');
    tab.engineError = '';
    return hello;
  }
  tab.engineError = hello.error;
  if (!$msgs) return hello;
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = 'msg-error cp-engine-error';
  const text = document.createElement('span');
  text.textContent = `Claude Code is unavailable: ${hello.error}`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cp-engine-retry';
  btn.textContent = 'Retry';
  btn.addEventListener('click', () => {
    btn.disabled = true;
    try { reconnect?.(); } catch {}
  });
  el.append(text, btn);
  $msgs.appendChild(el);
  if (tab === cpCtx.activeTab()) cpCtx.scrollEnd();
  return hello;
}

// ── Compaction ──

/** compact_boundary: the compaction is done; say what it did. */
export function renderCompactBoundary(tab, ev) {
  const $msgs = tab.messagesEl;
  if (!$msgs) return;
  let el = $msgs.querySelector('.msg-compact-status:not(.cp-compact-done)');
  if (!el) {
    el = document.createElement('div');
    el.className = 'msg-status msg-compact-status';
    $msgs.appendChild(el);
  }
  el.textContent = describeCompactBoundary(ev);
  // Each compaction keeps its own line: the next one starts a new row.
  el.classList.add('cp-compact-done');
}

function renderStatus(tab, view, ev) {
  if (view.status === 'compacting') cpCtx.compactStarted(tab);
  else if (view.status === 'requesting' && tab.running && !tab.currentActivity) setActivity(tab, 'Waiting for the model');
  if (view.compactResult === 'failed') {
    const row = tab.messagesEl?.querySelector('.msg-compact-status:not(.cp-compact-done)');
    if (row) { row.textContent = 'Compaction failed'; row.classList.add('cp-compact-done'); }
    cpCtx.compactEnded(tab);
    cpCtx.appendError(tab, `Compaction failed${view.compactError ? `: ${view.compactError}` : '.'}`);
  }
  // (With the number of the statement the bridge had applied, when it numbers them.)
  if (view.permissionMode) cpCtx.applyPermissionMode(tab, view.permissionMode, ev?.modeSeq, ev);
}

// ── Tool cards ──

const DENIED_BY = {
  classifier: 'the auto-mode classifier',
  mode: 'the permission mode',
  rule: 'a permission rule',
  asyncAgent: 'the background-agent policy',
  hook: 'a hook',
  permissionPromptTool: 'the permission prompt tool',
};

/** Mark a tool card as refused before it ran (a rule, the mode, the classifier). */
export function markToolDenied(tab, view) {
  const card = findToolCard(tab, view.toolUseId);
  if (!card) {
    // The event can outrun the assistant message that carries the call.
    tab._pendingDenials = tab._pendingDenials || new Map();
    if (view.toolUseId) tab._pendingDenials.set(view.toolUseId, view);
    return false;
  }
  const hdr = card.querySelector('.tool-hdr');
  if (hdr && !hdr.querySelector('.cp-denied-badge')) {
    const badge = document.createElement('span');
    badge.className = 'cp-denied-badge';
    badge.textContent = 'denied';
    const chevron = hdr.querySelector('.tool-chevron');
    if (chevron) hdr.insertBefore(badge, chevron); else hdr.appendChild(badge);
  }
  card.classList.add('tool-denied');
  card.classList.remove('tool-streaming');
  if (view.reason || view.reasonType) {
    let note = card.querySelector('.cp-denied-reason');
    if (!note) {
      note = document.createElement('div');
      note.className = 'cp-denied-reason';
      card.appendChild(note);
    }
    const by = DENIED_BY[view.reasonType] || (view.reasonType ? view.reasonType : '');
    note.textContent = `Denied${by ? ` by ${by}` : ''}${view.reason ? `: ${view.reason}` : '.'}`;
  }
  return true;
}

function applyPendingDenials(tab) {
  if (!tab._pendingDenials?.size) return;
  for (const [id, view] of [...tab._pendingDenials]) {
    if (findToolCard(tab, id)) { tab._pendingDenials.delete(id); markToolDenied(tab, view); }
  }
}

/** result.permission_denials is the authoritative list for the turn. */
export function markDeniedFromResult(tab, denials) {
  for (const d of Array.isArray(denials) ? denials : []) {
    const card = findToolCard(tab, d?.tool_use_id);
    if (card && !card.classList.contains('tool-denied')) markToolDenied(tab, { toolUseId: d.tool_use_id, reason: '', reasonType: '' });
  }
  tab._pendingDenials?.clear();
}

function fmtElapsed(seconds) {
  const s = Math.floor(seconds);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function applyToolProgress(tab, view) {
  const card = findToolCard(tab, view.toolUseId);
  if (!card) return;
  if (card.classList.contains('cp-agent-card')) {
    // Agent cards time themselves; a retry of the subagent's request is news.
    const now = card.querySelector('.cp-agent-now');
    if (now && view.retry) now.textContent = view.retry;
    return;
  }
  if (card.classList.contains('cp-bash-card')) return; // has its own timer
  if (card.classList.contains('tool-ok') || card.classList.contains('tool-error')) return;
  const hdr = card.querySelector('.tool-hdr');
  if (!hdr) return;
  let el = hdr.querySelector('.cp-tool-elapsed');
  if (!el) {
    el = document.createElement('span');
    el.className = 'cp-tool-elapsed';
    const chevron = hdr.querySelector('.tool-chevron');
    if (chevron) hdr.insertBefore(el, chevron); else hdr.appendChild(el);
  }
  el.textContent = fmtElapsed(view.elapsed) + (view.retry ? ` · ${view.retry}` : '');
}

// tool_use_summary: fold the calls it covers under one line when they sit
// together; otherwise leave the line after the last of them.
function renderToolSummary(tab, view) {
  const cards = view.toolUseIds.map(id => findToolCard(tab, id)).filter(Boolean);
  if (!cards.length) { cpCtx.appendStatus(tab, view.text); return; }
  const parent = cards[0].parentElement;
  const contiguous = parent && !parent.classList.contains('cp-tool-group-body')
    && cards.every((c, i) => c.parentElement === parent && (i === 0 || cards[i - 1].nextElementSibling === c));
  if (contiguous && cards.length > 1) {
    const group = document.createElement('details');
    group.className = 'cp-tool-group';
    const summary = document.createElement('summary');
    const label = document.createElement('span');
    label.className = 'cp-tool-group-text';
    label.textContent = view.text;
    const count = document.createElement('span');
    count.className = 'cp-tool-group-count';
    count.textContent = `${cards.length} tools`;
    summary.append(label, count);
    const body = document.createElement('div');
    body.className = 'cp-tool-group-body';
    group.append(summary, body);
    parent.insertBefore(group, cards[0]);
    for (const c of cards) body.appendChild(c);
    return;
  }
  const line = document.createElement('div');
  line.className = 'cp-tool-summary';
  line.textContent = view.text;
  cards[cards.length - 1].after(line);
}

// ── Rate limits ──

function applyRateLimit(tab, view) {
  const r = describeRateLimit(view.info);
  tab.rateLimit = r.level === 'ok' ? null : { level: r.level, pill: r.pill, text: r.text };
  if (tab === cpCtx.activeTab()) renderStatusline(tab);
  // The event repeats while the state holds; a line only when the state changes.
  if (r.text && tab._rateLimitKey !== r.key) {
    const el = cpCtx.appendWarn(tab, r.text);
    if (el) el.classList.add('cp-limit-row', `cp-limit-${r.level}`);
  }
  tab._rateLimitKey = r.key;
}

// ── Refusals and retractions ──

/** Remove messages the CLI retracted (a refused partial replaced by a fallback's answer). */
export function evictMessages(tab, uuids) {
  const gone = new Set((Array.isArray(uuids) ? uuids : []).filter(Boolean));
  if (!gone.size || !tab.messagesEl) return 0;
  let n = 0;
  for (const row of tab.messagesEl.querySelectorAll('[data-uuids]')) {
    const mine = row.dataset.uuids.split(' ').filter(Boolean);
    const hit = mine.filter(u => gone.has(u));
    if (!hit.length) continue;
    n++;
    if (hit.length === mine.length) {
      if (tab.currentMsgEl === row) { tab.currentMsgEl = null; tab.currentMsgId = null; }
      row.remove();
    } else {
      row.classList.add('cp-retracted');
    }
  }
  return n;
}

function renderRefusal(tab, view) {
  evictMessages(tab, view.retracted);
  const el = cpCtx.appendWarn(tab, view.text);
  if (!el) return;
  el.classList.add('cp-refusal-row');
  const userRow = view.refusedUserUuid
    ? tab.messagesEl?.querySelector(`.msg-user[data-uuid="${sel(view.refusedUserUuid)}"]`)
    : null;
  const bubble = userRow?.querySelector('.msg-bubble');
  const prompt = bubble ? [...bubble.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim() : '';
  if (!prompt) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cp-engine-retry';
  btn.textContent = 'Edit and retry';
  btn.addEventListener('click', () => cpCtx.prefillInput(prompt));
  el.append(' ', btn);
}

// ── Cards ──

function renderCommandOutput(tab, text) {
  tab._turnOutputShown = true;
  const el = cpCtx.appendInfoCard(tab, { title: 'Command output', kind: 'info', html: cpCtx.md(text) });
  const body = el?.querySelector('.cp-info-content');
  if (body) {
    body.classList.add('cp-command-output');
    try { cpCtx.linkifyFilePaths(body); cpCtx.addCopyButtons(body); } catch {}
  }
  return el;
}

/** Output a pass-through slash command delivered only as the result's text. */
export function renderLocalCommandResult(tab, text) {
  if (!text || tab._turnOutputShown) return null;
  return renderCommandOutput(tab, text);
}

function renderMemoryRecall(tab, view) {
  const $msgs = tab.messagesEl;
  if (!$msgs) return;
  const el = document.createElement('details');
  el.className = 'cp-memory-recall';
  const summary = document.createElement('summary');
  summary.textContent = view.text;
  el.appendChild(summary);
  for (const m of view.memories) {
    const row = document.createElement('div');
    row.className = 'cp-memory-recall-row';
    const scope = document.createElement('span');
    scope.className = 'cp-memory-recall-scope';
    scope.textContent = m.scope;
    const path = document.createElement('span');
    path.className = 'cp-memory-recall-path';
    path.textContent = m.path;
    row.append(scope, path);
    el.appendChild(row);
    if (m.content) {
      const pre = document.createElement('pre');
      pre.className = 'cp-memory-recall-content';
      pre.textContent = m.content;
      el.appendChild(pre);
    }
  }
  $msgs.appendChild(el);
  if (tab === cpCtx.activeTab()) cpCtx.scrollEnd();
}

function renderReset(tab, view) {
  const $msgs = tab.messagesEl;
  if (!$msgs) return;
  const el = document.createElement('div');
  el.className = 'cp-reset-divider';
  const when = view.timestamp && !Number.isNaN(Date.parse(view.timestamp))
    ? new Date(view.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
  el.textContent = when ? `${view.text} · ${when}` : view.text;
  $msgs.appendChild(el);
  // The CLI discarded the conversation: the gauge and the turn usage start over.
  tab._modelUsagePrev = { sid: tab.sessionId || '', usage: {} };
  if (view.newConversationId) tab._freshSessionId = view.newConversationId;
  cpCtx.resetUsage(tab);
  if (tab === cpCtx.activeTab()) cpCtx.scrollEnd();
}

function renderAuth(tab, view) {
  if (view.text) {
    let card = tab._authCard?.isConnected ? tab._authCard : null;
    if (!card) {
      card = cpCtx.appendInfoCard(tab, { title: 'Sign-in', kind: 'info', body: view.text });
      tab._authCard = card;
    } else {
      const body = card.querySelector('.cp-info-content');
      if (body) body.textContent = view.text;
    }
  }
  if (view.error) cpCtx.appendError(tab, `Sign-in failed: ${view.error}`);
  if (!view.authenticating) tab._authCard = null;
}

function renderThinkingTokens(tab, view) {
  tab._thinkTokens = view.tokens;
  const el = tab.thinkingEl;
  if (!el || !view.tokens) return;
  let span = el.querySelector('.think-tokens');
  if (!span) {
    span = document.createElement('span');
    span.className = 'think-tokens';
    el.appendChild(span);
  }
  span.textContent = `~${fmtTokens(view.tokens)} thinking tokens`;
}

// ── Dispatcher ──

/**
 * Render an event the monolith's handleTabEvent did not consume.
 * @param tab    the root tab
 * @param scope  the tab, or the agent scope the event belongs to
 */
export function renderSdkEvent(tab, scope, ev) {
  const view = describeEvent(ev);
  switch (view.kind) {
    case 'ignore': break;
    case 'row':
      upsertRow(tab, view.key, view.level, view.text);
      // The MCP server confirmed a URL-mode elicitation: its card is done.
      if (view.elicitationId) {
        const card = tab.messagesEl?.querySelector(`.cp-elicit-card.active-perm[data-elicitation-id="${sel(view.elicitationId)}"]`);
        try { card?._settle?.('accept'); } catch {}
      }
      break;
    case 'retry':
      upsertRow(tab, view.key, 'status', view.text);
      if (tab.running) setActivity(tab, view.verb);
      break;
    case 'status': renderStatus(tab, view, ev); break;
    case 'command_output': renderCommandOutput(tab, view.text); break;
    case 'denied': markToolDenied(tab, view); break;
    case 'rate_limit': applyRateLimit(tab, view); break;
    case 'refusal': renderRefusal(tab, view); break;
    case 'commands': cpCtx.setSlashCommands(tab, view.commands); break;
    case 'hook': {
      // Real hook lifecycle: the strip shows what ran and how it ended.
      tab._hookStarts = tab._hookStarts || new Map();
      if (view.phase === 'started') { if (view.id) tab._hookStarts.set(view.id, Date.now()); break; }
      const startedAt = tab._hookStarts.get(view.id) || 0;
      tab._hookStarts.delete(view.id);
      cpCtx.recordRealHook(tab, hookEntry(view.ev, startedAt));
      break;
    }
    case 'task': {
      tab.tasks = tab.tasks instanceof Map ? tab.tasks : new Map();
      const task = reduceTaskEvent(tab.tasks, view.ev);
      if (!task) break;
      // A subagent's card says what it is doing right now.
      const card = task.toolUseId ? findToolCard(tab, task.toolUseId) : null;
      const now = card?.classList.contains('cp-agent-card') ? card.querySelector('.cp-agent-now') : null;
      if (now && isTaskRunning(task)) {
        const line = taskProgressLine(task);
        if (line) now.textContent = line;
      }
      // An open tasks card follows along.
      if (tab.messagesEl?.querySelector('.cp-tasks-card')) { try { cpCtx.openTasks(tab, { refresh: true }); } catch {} }
      break;
    }
    case 'cache_cost': {
      const text = cacheCostText(view.ev);
      if (text) cpCtx.appendWarn(tab, text);
      break;
    }
    case 'session_state':
      tab.sessionState = view.state;
      cpCtx.sessionStateChanged?.(tab, view.state);
      break;
    case 'crons':
      tab.sessionCrons = view.crons;
      if (tab === cpCtx.activeTab()) renderStatusline(tab);
      break;
    case 'suggestion':
      cpCtx.showSuggestion(tab, view.text);
      break;
    case 'plugins':
      // After /reload-plugins: what is loaded now.
      if (tab.init) tab.init.plugins = view.plugins;
      if (view.agents && tab.sessionInfo) tab.sessionInfo.agents = view.agents;
      break;
    case 'session_info':
      tab.sessionInfo = view.info;
      tab.accountInfo = view.info.account || null;
      try { cpCtx.sessionInfoChanged?.(tab); } catch {}
      break;
    case 'tool_progress': applyToolProgress(tab, view); break;
    case 'thinking_tokens': renderThinkingTokens(tab, view); break;
    case 'summary': renderToolSummary(tab, view); break;
    case 'memory_recall': renderMemoryRecall(tab, view); break;
    case 'reset': renderReset(tab, view); break;
    case 'auth': renderAuth(tab, view); break;
    default: noteUnhandledEvent(tab, view.label);
  }
  return view;
}

// ── Assistant messages: what the three classic block kinds do not cover ──

/**
 * Server-side tool calls and their results, citations, redacted thinking.
 * @param wrap    the row's .msg-content
 * @param extras  splitAssistantBlocks() output
 */
export function renderAssistantExtras(tab, wrap, extras, { showThinking = true } = {}) {
  if (!wrap || !extras?.any) return;
  if (extras.redacted && showThinking && !wrap.querySelector('.cp-thinking-redacted')) {
    const el = document.createElement('div');
    el.className = 'msg-thinking cp-thinking-redacted';
    el.textContent = 'Thinking (redacted by the API)';
    wrap.insertBefore(el, wrap.firstChild);
  }
  for (const t of extras.serverTools) {
    if (wrap.querySelector(`.tool-card[data-tool-id="${sel(t.id)}"]`)) continue;
    const card = cpCtx.buildTool({ type: 'tool_use', id: t.id, name: t.name, input: t.input }, tab);
    card.classList.add('cp-server-tool');
    wrap.appendChild(card);
  }
  for (const r of extras.serverResults) {
    const lines = r.links.map(l => `${l.title}\n${l.url}`);
    if (r.text) lines.push(r.text);
    cpCtx.updateToolResult(tab, { type: 'tool_result', tool_use_id: r.toolUseId, content: lines.join('\n\n') || '(no content)', is_error: r.isError });
  }
  if (extras.citations.length) {
    let box = wrap.querySelector('.cp-citations');
    if (!box) {
      box = document.createElement('div');
      box.className = 'cp-citations';
      const label = document.createElement('span');
      label.className = 'cp-citations-label';
      label.textContent = 'Sources';
      box.appendChild(label);
      wrap.appendChild(box);
    }
    const have = new Set([...box.querySelectorAll('[data-cite]')].map(n => n.dataset.cite));
    for (const c of extras.citations) {
      const key = c.url || c.title;
      if (have.has(key)) continue;
      have.add(key);
      const item = document.createElement(c.url ? 'a' : 'span');
      item.className = 'cp-citation';
      item.dataset.cite = key;
      item.textContent = c.title;
      if (c.url) { item.href = c.url; item.target = '_blank'; item.rel = 'noopener noreferrer'; item.title = c.url; }
      box.appendChild(item);
    }
  }
}

/**
 * After an assistant message rendered: stamp its wire uuid on the row (so a
 * later retraction can find it), and show what the wrapper says about it: a
 * typed API error, an interrupted or cut-off reply, a limit sentence.
 */
export function annotateAssistantRow(tab, scope, ev) {
  const state = describeAssistantState(ev);
  if (state.supersedes.length) evictMessages(tab, state.supersedes);
  applyPendingDenials(tab);
  const row = scope.currentMsgEl && ev.message?.id && scope.currentMsgId === ev.message.id && scope.currentMsgEl.isConnected
    ? scope.currentMsgEl : null;
  if (row) {
    if (state.uuid) {
      const have = (row.dataset.uuids || '').split(' ').filter(Boolean);
      if (!have.includes(state.uuid)) row.dataset.uuids = [...have, state.uuid].join(' ');
    }
    if (state.timestamp) row.title = new Date(state.timestamp).toLocaleString();
    if (state.limit) row.classList.add('cp-limit-msg', `cp-limit-${state.limit}`);
  }
  const notes = [];
  if (state.aborted) notes.push('interrupted');
  if (state.truncated && !state.error) notes.push('cut off at the output limit');
  const wrap = row?.querySelector('.msg-content');
  if (wrap && notes.length && !wrap.querySelector('.cp-msg-note')) {
    const note = document.createElement('div');
    note.className = 'cp-msg-note';
    note.textContent = notes.join(' · ');
    wrap.appendChild(note);
  }
  if (state.error && (state.error.hint || state.error.kind !== 'unknown')) {
    const text = state.error.hint ? `${state.error.title}. ${state.error.hint}` : `${state.error.title}.`;
    if (wrap) {
      if (!wrap.querySelector('.cp-assistant-error')) {
        const box = document.createElement('div');
        box.className = 'cp-assistant-error';
        box.textContent = text;
        wrap.appendChild(box);
      }
    } else if (scope === tab) {
      cpCtx.appendError(tab, text);
    }
  }
  return state;
}

// ── Streaming tool input ──

/** A tool_use block opened in the stream: remember which ghost card it feeds. */
export function noteToolInputStart(stream, index, block) {
  if (!stream || !block?.id) return;
  stream.toolBlocks = stream.toolBlocks || {};
  stream.toolBlocks[index] = { id: block.id, name: block.name || '', json: '', timer: null };
}

/** input_json_delta: show what the call is about while the model still types it. */
export function noteToolInputDelta(stream, index, partialJson) {
  const slot = stream?.toolBlocks?.[index];
  if (!slot || typeof partialJson !== 'string') return;
  slot.json += partialJson;
  if (slot.timer) return;
  slot.timer = setTimeout(() => {
    slot.timer = null;
    const ghost = stream.el?.querySelector(`.tool-card.tool-streaming[data-tool-id="${sel(slot.id)}"]`);
    const detail = ghost?.querySelector('.tool-detail');
    if (!detail) return;
    const preview = previewPartialToolInput(slot.json);
    if (preview) detail.textContent = preview.value;
  }, 120);
}

// ── Turn footer ──

export function appendTurnFooter(tab, footer) {
  const $msgs = tab.messagesEl;
  if (!$msgs || !footer?.text) return null;
  const el = document.createElement('div');
  el.className = 'cp-turn-footer';
  el.textContent = footer.text;
  if (footer.title) el.title = footer.title;
  $msgs.appendChild(el);
  return el;
}
