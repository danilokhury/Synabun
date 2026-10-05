// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — what the transcript shows (no DOM; the renderer builds nodes
// from these answers and node:test checks them directly)
// ─────────────────────────────────────────────────────────────────────────────

import { describeError } from './ocp-v2-events.js';

// Bookkeeping parts with nothing to read: step boundaries and the snapshot
// hash OpenCode records for undo.
const HIDDEN_PART_TYPES = new Set(['step-start', 'step-finish', 'snapshot']);

/** True for a part the transcript shows. */
export function isVisiblePart(part) {
  if (!part || HIDDEN_PART_TYPES.has(part.type)) return false;
  // `ignored` text never reached the model; `synthetic` text was written by
  // OpenCode on the user's behalf (file contents, "the user ran this tool").
  if (part.type === 'text' && (part.ignored || part.synthetic)) return false;
  return true;
}

/** A message's parts in display order, hidden ones removed. */
export function visibleParts(msg) {
  const parts = msg?.parts instanceof Map ? [...msg.parts.values()] : (Array.isArray(msg?.parts) ? msg.parts : []);
  return parts
    .filter(isVisiblePart)
    .sort((a, b) => (a.index ?? Number.POSITIVE_INFINITY) - (b.index ?? Number.POSITIVE_INFINITY));
}

// Captures everything visible about a part, so the reconciler can tell an
// up-to-date DOM node from a stale one without rebuilding it.
export function partSignature(part) {
  if (!part) return '';
  const t = part.type || '';
  if (t === 'text' || t === 'reasoning') {
    const text = String(part.text || '');
    const tail = text.length > 80 ? text.slice(-80) : text;
    return `${t}:${text.length}:${tail}:${part?.time?.end ? '1' : '0'}`;
  }
  if (t === 'tool') {
    const state = part.state || {};
    const status = state.status || part.status || '';
    const input = state.input ?? part.input;
    const output = state.output ?? part.output;
    const error = state.error ?? part.error;
    const inp = input ? JSON.stringify(input).length : 0;
    const out = output == null
      ? 0
      : typeof output === 'string'
        ? output.length
        : JSON.stringify(output).length;
    const meta = state.metadata ? JSON.stringify(state.metadata).length : 0;
    return `tool:${status}:${part.tool || part.name || ''}:${inp}:${out}:${error ? 'e' : ''}:${state.title || ''}:${meta}:${state.time?.end || ''}`;
  }
  if (t === 'file') return `file:${part.url || part.path || ''}:${String(part.text || '').length}`;
  if (t === 'retry') return `retry:${part.attempt || 0}:${describeError(part.error).message.length}`;
  if (t === 'compaction') return `compaction:${part.auto ? 'a' : 'm'}:${part.overflow ? 'o' : ''}`;
  if (t === 'patch') return `patch:${part.hash || ''}:${(part.files || []).length}`;
  return `${t}:${part.id || ''}`;
}

/** The error row under an assistant message, or null when it ended cleanly. */
export function messageErrorView(info) {
  if (!info || info.role !== 'assistant' || !info.error) return null;
  const d = describeError(info.error);
  const view = { kind: d.kind, name: d.name, text: d.message, action: null };
  if (d.statusCode) view.text = `${d.message} (HTTP ${d.statusCode})`;
  if (d.kind === 'overflow') view.action = 'compact';
  else if (d.kind === 'auth') view.action = 'settings';
  return view;
}

/** The banner shown while OpenCode waits to retry a failed provider call. */
export function retryBannerView(status) {
  if (!status || status.type !== 'retry') return null;
  const attempt = Number(status.attempt) || 0;
  const action = status.action && typeof status.action === 'object' ? status.action : null;
  const link = typeof action?.link === 'string' && /^https?:\/\//i.test(action.link) ? action.link : '';
  return {
    title: attempt ? `Retrying (attempt ${attempt})` : 'Retrying',
    message: String(action?.message || status.message || '').trim(),
    nextAt: Number(status.next) > 0 ? Number(status.next) : 0,
    actionLabel: link ? String(action.label || action.title || 'Open').trim() : '',
    actionLink: link,
  };
}

/** One line for a retry part left in the transcript. */
export function retryPartText(part) {
  const attempt = Number(part?.attempt) || 0;
  const reason = describeError(part?.error).message;
  return `Retry${attempt ? ` ${attempt}` : ''}: ${reason}`;
}

/** The divider label for a compaction marker. */
export function compactionLabel(part) {
  if (part?.overflow) return 'Context compacted automatically: the conversation outgrew the model';
  return part?.auto ? 'Context compacted automatically' : 'Context compacted';
}

/** Short lines for the part types that are neither prose nor a tool call. */
export function inlinePartText(part) {
  switch (part?.type) {
    case 'subtask': {
      const agent = String(part.agent || '').trim();
      const what = String(part.description || part.prompt || '').trim().split(/\r?\n/, 1)[0];
      return `Subtask${agent ? ` · ${agent}` : ''}${what ? `: ${what}` : ''}`;
    }
    case 'agent':
      return `@${String(part.name || 'agent')}`;
    case 'patch': {
      const files = Array.isArray(part.files) ? part.files.filter(Boolean) : [];
      if (!files.length) return 'Files changed';
      const names = files.slice(0, 3).map((f) => String(f).split(/[\\/]/).filter(Boolean).pop() || String(f));
      const more = files.length > names.length ? ` +${files.length - names.length} more` : '';
      return `Changed ${files.length} file${files.length === 1 ? '' : 's'}: ${names.join(', ')}${more}`;
    }
    default:
      return '';
  }
}

/** The last lines of reasoning that is still streaming. */
export function reasoningPreview(text, maxChars = 240) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > maxChars ? `…${clean.slice(-maxChars)}` : clean;
}

/** The header status word, most urgent first. */
export function headerStatus(s) {
  if (s.healing) return { cls: 'healing', text: 'healing' };
  const permissions = (s.pendingPermissions || []).length || (s.pendingPermission ? 1 : 0);
  if (permissions) {
    return { cls: 'awaiting', text: permissions > 1 ? `awaiting ${permissions} permissions` : 'awaiting permission' };
  }
  if ((s.pendingQuestions || []).length) return { cls: 'awaiting', text: 'awaiting answer' };
  if (s.compacting) return { cls: 'running', text: 'compacting' };
  if (s.sessionStatus?.type === 'retry') return { cls: 'reconnecting', text: 'retrying' };
  if (s.running) return { cls: 'running', text: 'running' };
  if (s.serverStatus === 'reconnecting') return { cls: 'reconnecting', text: 'reconnecting' };
  if (s.serverStatus === 'error' || (s.errors || []).length) return { cls: 'error', text: 'error' };
  if (s.serverStatus === 'offline') return { cls: '', text: 'offline' };
  return { cls: 'ready', text: 'idle' };
}

/**
 * Text the user typed into a card that is rebuilt (on every state event, and
 * when the panel comes back to the session): kept by request id for as long
 * as the request is open. Nothing is evicted to keep the store small: a draft
 * goes only when its request does.
 *   set(id, text, { sessionId })  the draft; `sessionId` is the session the
 *                                 request belongs to. `set(id, '')` forgets.
 *   clear(id)                     the request was answered, by whoever
 *                                 (this card, another window, auto-accept).
 *   forgetSession(sessionId)      the session is gone, and its requests with it.
 *   settle(sessionId, openIds)    the server's own list of the session's open
 *                                 requests: a draft of that session whose
 *                                 request is not in it was answered while
 *                                 nobody was listening (a socket outage).
 */
export function createCardDrafts() {
  const drafts = new Map();         // request id → { text, sessionId }
  return {
    get: (id) => drafts.get(String(id || ''))?.text || '',
    set(id, text, { sessionId = '' } = {}) {
      const key = String(id || '');
      if (!key) return;
      const value = String(text || '');
      if (!value) { drafts.delete(key); return; }
      drafts.set(key, { text: value, sessionId: String(sessionId || drafts.get(key)?.sessionId || '') });
    },
    clear(id) { return drafts.delete(String(id || '')); },
    forgetSession(sessionId) {
      const sid = String(sessionId || '');
      if (!sid) return 0;
      let gone = 0;
      for (const [key, draft] of [...drafts]) { if (draft.sessionId === sid) { drafts.delete(key); gone += 1; } }
      return gone;
    },
    settle(sessionId, openIds) {
      const sid = String(sessionId || '');
      if (!sid) return 0;
      const open = new Set((Array.isArray(openIds) ? openIds : []).map((id) => String(id || '')));
      let gone = 0;
      for (const [key, draft] of [...drafts]) { if (draft.sessionId === sid && !open.has(key)) { drafts.delete(key); gone += 1; } }
      return gone;
    },
    size: () => drafts.size,
  };
}
