/**
 * Streaming bridge between SDK events and the live-text-node renderer
 * in ocp-render.js. Owns per-tab finalization tracking so the three
 * terminal events (message.completed / session.status:idle / abort) feed
 * into a single markFinalized() funnel.
 *
 * Key fix: markFinalized waits for an EXPLICIT terminal signal — never
 * triggers on first ExitPlanMode tool detection. The old
 * `_renderedAssistantMsgIds` Set in ocp-tabs.js was set as soon as a
 * message was rendered, which combined with overzealous finalize calls
 * caused subsequent text from the same message to drop. Hence the
 * "anemic plan output" symptom.
 *
 * Throttle: a single coalesced setTimeout(16ms)-based chrome refresh
 * (replaces the old rAF path that browsers throttle on backgrounded
 * tabs). Token append remains O(1) — driven by ocp-render.js text-node
 * append.
 */

import {
  appendStreamChunk,
  appendThinkChunk,
  setStreamRawText,
  setStreamThinkText,
  finalizeStreamingMessage,
} from './ocp-render.js';
import { attachStateFields, recordEvent } from './ocp-state.js';
import { trace } from './ocp-trace.js';

// Per-tab Map<messageId, { rendered: bool, finalized: bool }>.
function ensureRenderState(tab) {
  attachStateFields(tab);
  if (!tab._renderState) tab._renderState = new Map();
  return tab._renderState;
}

export function markRendered(tab, messageId) {
  if (!tab || !messageId) return;
  const m = ensureRenderState(tab);
  const entry = m.get(messageId) || { rendered: false, finalized: false };
  entry.rendered = true;
  m.set(messageId, entry);
}

export function isRendered(tab, messageId) {
  if (!tab || !messageId) return false;
  return !!tab._renderState?.get(messageId)?.rendered;
}

/**
 * Mark a message finalized. Idempotent — repeated calls are no-ops.
 * Returns true on the first finalization, false on subsequent calls.
 *
 * Callers should ONLY pass `reason` of 'message.completed', 'idle',
 * 'abort', or 'error'. Never call from a tool-detection path — that's
 * the bug that ate the back half of plan-mode responses.
 */
export function markFinalized(tab, messageId, reason = '') {
  if (!tab || !messageId) return false;
  const m = ensureRenderState(tab);
  const entry = m.get(messageId) || { rendered: false, finalized: false };
  if (entry.finalized) return false;
  entry.finalized = true;
  entry.finalizeReason = reason || '';
  m.set(messageId, entry);
  trace('stream:finalize', { sid: tab.sessionId, messageId, reason });
  return true;
}

export function isFinalized(tab, messageId) {
  if (!tab || !messageId) return false;
  return !!tab._renderState?.get(messageId)?.finalized;
}

export function clearRenderState(tab, messageId) {
  if (!tab || !tab._renderState) return;
  if (messageId) tab._renderState.delete(messageId);
  else tab._renderState.clear();
}

// --- Render helpers (thin pass-through to ocp-render.js) ---

export function streamAppendText(container, text) {
  return appendStreamChunk(container, text);
}

export function streamAppendThink(container, text) {
  return appendThinkChunk(container, text);
}

export function streamSetRawText(container, text) {
  return setStreamRawText(container, text);
}

export function streamSetThinkText(container, text) {
  return setStreamThinkText(container, text);
}

export function streamFinalize(container) {
  return finalizeStreamingMessage(container);
}

// --- Coalesced chrome update timer ---
//
// Replaces the bare _streamUpdateTimer in ocp-tabs.js. Single shared timer
// per tab — coalesces N delta-driven chrome refreshes into one ~5Hz tick.

export function scheduleChromeUpdate(tab, fn) {
  if (!tab || typeof fn !== 'function') return;
  attachStateFields(tab);
  if (tab._streamUpdateTimer) return;
  tab._streamUpdateTimer = setTimeout(() => {
    tab._streamUpdateTimer = null;
    try { fn(); } catch (e) { console.error('[ocp-stream] chrome update:', e); }
  }, 200);
}

export function flushChromeUpdate(tab) {
  if (!tab) return;
  if (tab._streamUpdateTimer) {
    clearTimeout(tab._streamUpdateTimer);
    tab._streamUpdateTimer = null;
  }
}

// --- Event-driven entry points (called by ocp-events.js) ---

/**
 * Handle message.part.delta — text/reasoning chunks. The renderer's
 * O(1) text-node append is preserved verbatim; we only do bookkeeping.
 */
export function onPartDelta(tab, container, event) {
  if (!tab || !container || !event) return;
  attachStateFields(tab);
  recordEvent(tab, 'message.part.delta');
  const field = event.field || event.partField || '';
  const delta = event.delta || '';
  if (!delta) return;
  if (field === 'reasoning' || field === 'thinking') {
    streamAppendThink(container, delta);
  } else {
    streamAppendText(container, delta);
  }
}

/**
 * Handle message.part.updated — full-snapshot updates (OpenCode 1.14+).
 * Length-gated adoption inside ocp-render.js prevents snap-back flicker
 * when an out-of-order shorter snapshot arrives.
 */
export function onPartUpdated(tab, container, event) {
  if (!tab || !container || !event) return;
  attachStateFields(tab);
  recordEvent(tab, 'message.part.updated');
  const part = event.part || event;
  if (!part || typeof part !== 'object') return;
  const partType = part.type || '';
  if (partType === 'text' && typeof part.text === 'string') {
    streamSetRawText(container, part.text);
  } else if ((partType === 'reasoning' || partType === 'thinking') && typeof part.text === 'string') {
    streamSetThinkText(container, part.text);
  }
}

export function onMessageUpdated(tab, container, event) {
  if (!tab || !container) return;
  attachStateFields(tab);
  recordEvent(tab, 'message.updated');
  // Note: we deliberately do NOT finalize here — message.updated fires
  // mid-turn for non-terminal reasons (token-counter ticks, etc.) and
  // finalizing here was the bug that truncated plan-mode output.
  // Finalization happens only via onMessageCompleted or onSessionIdle.
}

export function onMessageCompleted(tab, container, event) {
  if (!tab || !container) return;
  attachStateFields(tab);
  recordEvent(tab, 'message.completed');
  const messageId = event?.info?.id || event?.messageID || event?.id || '';
  if (markFinalized(tab, messageId, 'message.completed')) {
    streamFinalize(container);
    flushChromeUpdate(tab);
  }
}

export function onSessionIdle(tab, container, event) {
  if (!tab || !container) return;
  attachStateFields(tab);
  recordEvent(tab, 'session.idle');
  // Finalize whatever streaming bubble exists; if nothing's open this is a
  // no-op inside ocp-render. Use a synthetic id so we don't gate-check.
  const synthId = `_idle:${tab._turnId || 0}`;
  if (markFinalized(tab, synthId, 'idle')) {
    streamFinalize(container);
    flushChromeUpdate(tab);
  }
}

export function onAbort(tab, container, reason = 'abort') {
  if (!tab || !container) return;
  attachStateFields(tab);
  recordEvent(tab, reason);
  const synthId = `_abort:${tab._turnId || 0}`;
  if (markFinalized(tab, synthId, reason)) {
    streamFinalize(container);
    flushChromeUpdate(tab);
  }
}
