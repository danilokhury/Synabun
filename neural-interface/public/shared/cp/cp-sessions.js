// ── Session actions: titles, fork, delete, conversation rewind, subagent transcripts ──
// The server side is lib/claude-session-ops.js (the Agent SDK's session
// functions). Everything here degrades on a server that predates those routes:
// a 404 is "not available yet", never an error the user has to act on.

import { fmtDuration, fmtTokens, hasCapability } from './cp-events.js';
import { escapeHtml } from './cp-markdown.js';

async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok || data?.ok === false) {
    const err = new Error(data?.error || (res.status === 404 ? 'Not available until the SynaBun server restarts.' : `Request failed (${res.status})`));
    err.status = res.status;
    throw err;
  }
  return data || {};
}
const base = (sid) => `/api/claude-code/sessions/${encodeURIComponent(sid)}`;

/** Write a title the user typed where the CLI reads it. Best effort: the panel keeps its own label either way. */
export function writeSessionTitle(sid, title, project) {
  if (!sid || !String(title || '').trim()) return Promise.resolve(false);
  return call('POST', `${base(sid)}/title`, { title: String(title).trim(), project: project || undefined }).then(() => true).catch(() => false);
}

/**
 * Fork a session. `beforeMessageId` is the prompt a "fork from here" stops
 * before: the server reads the transcript to find the entry that prompt follows
 * (it can be a tool result this page has no row for). `upToMessageId` is the
 * page's own answer, used only when the transcript cannot say.
 */
export function forkSession(sid, { upToMessageId = '', beforeMessageId = '', title = '', project = '' } = {}) {
  return call('POST', `${base(sid)}/fork`, { upToMessageId: upToMessageId || undefined, beforeMessageId: beforeMessageId || undefined, title: title || undefined, project: project || undefined });
}

export function deleteSession(sid, project) {
  return call('DELETE', base(sid), { confirm: true, project: project || undefined });
}

/** Set or clear (empty) a session's tag where the CLI reads it. */
export function tagSession(sid, tag, project) {
  return call('PUT', `${base(sid)}/tag`, { tag: String(tag || '').trim() || null, project: project || undefined });
}

/** A session's line in the menu: the name given in SynaBun, else the CLI's own title, else its first prompt. */
export function sessionListLabel(session, localLabel = '') {
  return String(localLabel || '').trim() || String(session?.title || '').trim() || String(session?.firstPrompt || '').trim();
}

// ── Searching the session menu ──
// The server searches what it has: the conversations' text, the first prompt,
// the branch, the CLI's title and tag. The name given in this panel is kept by
// the page, so the page has to look there itself: a search for a title the list
// shows must find that session.

/** Whether the title the list shows for a session contains the typed text. */
export function titleMatches(session, query, localLabel = '') {
  const q = String(query || '').trim().toLowerCase();
  return !!q && sessionListLabel(session, localLabel).toLowerCase().includes(q);
}

/** Ids of the sessions whose panel-side name contains the text. `labels`: [[sessionId, name], …]. */
export function labelledSessionIds(labels, query, max = 25) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const [id, label] of Array.isArray(labels) ? labels : []) {
    if (out.length >= max) break;
    if (id && String(label || '').toLowerCase().includes(q) && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * One result list from the three sources. Sessions whose displayed title
 * contains the text come first (newest first); then the full-text hits in their
 * own ranking; then what matched another list field (branch, id, tag).
 * @param o.ranked  full-text and semantic hits, best first
 * @param o.listed  the list route's own field matches, and the sessions looked up by name
 * @param o.labelOf (sessionId) => the name given in this panel, or ''
 */
export function mergeSessionSearch(query, { ranked = [], listed = [], labelOf = () => '' } = {}) {
  const seen = new Set();
  const titled = [];
  const rest = [];
  for (const s of [...ranked, ...listed]) {
    if (!s?.sessionId || seen.has(s.sessionId)) continue;
    seen.add(s.sessionId);
    (titleMatches(s, query, labelOf(s.sessionId)) ? titled : rest).push(s);
  }
  const when = (s) => new Date(s.modified || s.created || 0).getTime() || 0;
  titled.sort((a, b) => when(b) - when(a));
  return [...titled, ...rest];
}

// ── The session menu's markup ──
// A session's title, tag, branch and id come from its transcript and from the
// CLI's own records: a tag or a branch can hold any character. The row is a
// template in the panel, and what it interpolates is made here: every value
// escaped, for text and for the quoted attributes alike; the count is a number
// or it is not shown.

/**
 * The pieces of one row of the session menu, ready to interpolate into its
 * markup (each is already escaped: never escape them again, never add a raw
 * value next to them). `label` is the line to show (already truncated),
 * `when` the relative date.
 * @returns {{ label: string, sid: string, tagTitle: string, meta: string }}
 */
export function sessionRowParts({ label = '', sessionId = '', tag = '', branch = '', messageCount = 0, when = '' } = {}) {
  const count = Number(messageCount) || 0;
  let metaHtml = `<span>${escapeHtml(when)}</span>`;
  if (branch) metaHtml += `<span class="cp-sess-branch">${escapeHtml(branch)}</span>`;
  if (tag) metaHtml += `<span class="cp-sess-branch cp-sess-tag" title="Tag">#${escapeHtml(tag)}</span>`;
  if (count) metaHtml += `<span>${count} msgs</span>`;
  return {
    label: escapeHtml(label),
    // data-sid="…" of the row's buttons
    sid: escapeHtml(sessionId),
    // title="…" of the tag button
    tagTitle: tag ? `Tag: ${escapeHtml(tag)} (click to change or clear)` : 'Tag this session',
    // the line under the title: date, branch, tag, message count
    meta: metaHtml,
  };
}

/**
 * Replace a <select>'s options. Built as elements (`value` and `textContent`
 * are properties, so nothing in a branch or project name is parsed as markup).
 * `options` is a list of `{ value, label }`.
 */
export function fillSelectOptions(select, options, doc = globalThis.document) {
  if (!select) return;
  select.textContent = '';
  for (const o of Array.isArray(options) ? options : []) {
    const opt = doc.createElement('option');
    opt.value = String(o?.value ?? '');
    opt.textContent = String(o?.label ?? o?.value ?? '');
    select.appendChild(opt);
  }
}

/** The tags among the loaded sessions, for the filter. */
export function collectTags(sessions) {
  return [...new Set((Array.isArray(sessions) ? sessions : []).map(s => String(s?.tag || '').trim()).filter(Boolean))].sort();
}

export function fetchSubagentMessages(sid, agentId, project) {
  const q = project ? `?project=${encodeURIComponent(project)}` : '';
  return call('GET', `${base(sid)}/subagents/${encodeURIComponent(agentId)}/messages${q}`);
}

/**
 * Rename, fork, delete and subagent transcripts run through the server's own
 * Claude config directory, which is the default account's. A tab under another
 * account keeps its panel-side label and has none of these.
 */
export function sessionActionsAvailable(tab) {
  // `session_ops`: the server has the routes. A server that was not restarted
  // sends no capability list, and these stay hidden instead of failing.
  return hasCapability(tab, 'session_ops') && (!tab?.accountId || tab.accountId === 'default');
}

/** The session menu is not tied to one tab: any connected tab that advertises the routes will do. */
export function sessionOpsSupported(tabs) {
  return (Array.isArray(tabs) ? tabs : []).some(t => hasCapability(t, 'session_ops'));
}

export function forkTitle(label) {
  const text = String(label || '').trim();
  if (!text || text === 'New chat') return 'Fork';
  return /^Fork of /i.test(text) ? text : `Fork of ${text}`.slice(0, 120);
}

/**
 * The transcript entry just before a row: where a conversation rewind resumes,
 * and where a fork "up to here" ends. Assistant rows carry every uuid of their
 * message (`data-uuids`); prompt rows carry one (`data-uuid`).
 */
export function entryBefore(row) {
  for (let n = row?.previousElementSibling; n; n = n.previousElementSibling) {
    const many = (n.dataset?.uuids || '').split(' ').filter(Boolean);
    if (many.length) return many[many.length - 1];
    if (n.classList?.contains('msg-user') && n.dataset?.uuid) return n.dataset.uuid;
  }
  return '';
}

/** What a prompt row says, without its attachments. */
export function promptText(row) {
  const bubble = row?.querySelector('.msg-bubble');
  if (!bubble) return '';
  return [...bubble.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
}

/** Remove a row and everything after it (the conversation was rewound to before it). */
export function removeFrom(row) {
  let n = row;
  let count = 0;
  while (n) {
    const next = n.nextElementSibling;
    n.remove();
    count++;
    n = next;
  }
  return count;
}

/** system/cache_cost: resuming re-writes an expired prompt cache. */
export function cacheCostText(ev) {
  const usd = Number(ev?.estimated_cache_write_usd);
  if (!Number.isFinite(usd) || usd <= 0) return '';
  // A model change: the conversation is written to the new model's cache.
  if (ev.source === 'model_switch') {
    const tokens = Number(ev.context_tokens) > 0 ? ` (${fmtTokens(ev.context_tokens)} tokens)` : '';
    const lost = ev.prompt_cache_warm === true ? ' The cache of the previous model is no longer used.' : '';
    return `Model changed${ev.to_model ? ` to ${ev.to_model}` : ''}: the conversation${tokens} is cached again for it with the next reply, about $${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}.${lost}`;
  }
  const idle = Number(ev?.seconds_since_last_response) > 0 ? ` (idle for ${fmtDuration(ev.seconds_since_last_response * 1000)})` : '';
  return `The prompt cache of this session has expired${idle}: the next reply re-caches the context, about $${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}.`;
}
