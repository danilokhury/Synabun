// ═══════════════════════════════════════════
// SynaBun — Antigravity panel: the transcript and its cards as HTML (no DOM)
// ═══════════════════════════════════════════
//
// Every builder returns a string; every value in it goes through esc() (text or a
// quoted attribute), Markdown through the caller's `md` (cp/cp-markdown.js
// renderMarkdown: marked + the allowlist sanitiser). The look is the Codex
// panel's (docs/codex-sidepanel.md → Visual language): one card anatomy (head:
// icon, title, subtitle, status, chevron; then a body), one container treatment
// per level, colour only for a status. `T(key, params)` is agyText.
//
// Output detail levels (the panel's `detail` setting): compact hides thoughts and
// keeps every card closed, standard folds thoughts and opens file changes,
// verbose opens everything and adds each tool call's raw input and output.

import { diffView, DIFF_LIMITS } from './agy-diff.js';
import { durationLabel, toolSummary, usageParts, compactNumber } from './agy-events.js';
import { relativeToProject } from './agy-commands.js';
import { elicitationFields, elicitationUrl } from './agy-options.js';
import { synabunToolKey, synabunToolLabel, synabunToolSummary } from '../synabun-tools.js';

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
export const esc = (value) => String(value ?? '').replace(/[&<>"'`]/g, (c) => HTML_ESCAPES[c]);

// ── Icons (stroke, currentColor) ──
const svg = (body, { size = 14, fill = 'none', width = 2 } = {}) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="${fill}" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const ICONS = Object.freeze({
  mark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 20 12 4l7.5 16"/><path d="M8.2 20a3.8 3.8 0 0 1 7.6 0"/></svg>',
  read: svg('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  delete: svg('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>'),
  move: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  execute: svg('<path d="m4 17 6-5-6-5M12 19h8"/>'),
  think: svg('<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V16h8v-1.3A7 7 0 0 0 12 2z"/>'),
  fetch: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
  switch_mode: svg('<rect x="2" y="7" width="20" height="10" rx="5"/><circle cx="16" cy="12" r="3"/>'),
  other: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  plan: svg('<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3 6 1 1 2-2M3 12l1 1 2-2M3 18l1 1 2-2"/>'),
  compaction: svg('<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>'),
  subagent: svg('<circle cx="12" cy="7" r="3"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>'),
  permission: svg('<path d="M12 3 4 6v6c0 5 3.4 8.5 8 9 4.6-.5 8-4 8-9V6z"/>'),
  question: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.3 2.4c-.5.2-.8.7-.8 1.2V14M12 17.5v.01"/>'),
  copy: svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', { size: 12 }),
  retry: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>', { size: 12 }),
  check: svg('<path d="m5 12 5 5L20 7"/>', { size: 12, width: 2.5 }),
  cross: svg('<path d="M6 6l12 12M18 6 6 18"/>', { size: 12, width: 2.5 }),
});

// SynaBun's own tools wear its logo, as in every other panel.
export const SYNABUN_LOGO = '<img class="agy-synabun-logo" src="logoHD.png" alt="" aria-hidden="true">';

/**
 * A SynaBun MCP call of a tool row: { key, args } ('bluesky_post' and the call's own arguments), else null.
 * Antigravity calls an MCP tool through call_mcp_tool { ServerName, ToolName, Arguments }; a name in
 * the prefixed spelling (mcp__SynaBun__x, SynaBun_x) counts too.
 */
export function synabunCallOf(row) {
  const input = row?.rawInput && typeof row.rawInput === 'object' && !Array.isArray(row.rawInput) ? row.rawInput : {};
  const server = typeof (input.ServerName ?? input.serverName ?? input.server) === 'string' ? (input.ServerName ?? input.serverName ?? input.server) : '';
  const tool = typeof (input.ToolName ?? input.toolName ?? input.tool) === 'string' ? (input.ToolName ?? input.toolName ?? input.tool) : '';
  if (server.trim() && tool.trim()) {
    const key = synabunToolKey(tool, server);
    if (key == null) return null;
    let args = input.Arguments ?? input.arguments ?? {};
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    return { key, args: args && typeof args === 'object' && !Array.isArray(args) ? args : {} };
  }
  const named = synabunToolKey(row?.name) ?? (/^mcp__/i.test(String(row?.title || '')) ? synabunToolKey(row.title) : null);
  return named != null ? { key: named, args: input } : null;
}

const KIND_ICON = { read: 'read', edit: 'edit', delete: 'delete', move: 'move', search: 'search', execute: 'execute', think: 'think', fetch: 'fetch', switch_mode: 'switch_mode' };

const STATUS_TONE = { pending: 'running', in_progress: 'running', completed: 'success', failed: 'error' };
const NOTICE_KEYS = { cancelled: 'stopped', refusal: 'refusal', max_tokens: 'maxTokens', max_turn_requests: 'maxTurns' };

// ── Pieces ──

function statusPill(text, tone = '') {
  return `<span class="agy-status-pill"${tone ? ` data-tone="${esc(tone)}"` : ''}>${esc(text)}</span>`;
}

/** One card: head (icon, title, subtitle, status, chevron) and an optional body. */
export function cardHtml({ cls = '', icon = '', title = '', subtitle = '', status = '', body = '', open = false, attrs = '', titleAttr = '' }) {
  const expandable = !!body;
  const head = `<div class="agy-card-head"${expandable ? ` role="button" tabindex="0" aria-expanded="${open ? 'true' : 'false'}"` : ''}>`
    + `<span class="agy-card-icon">${icon}</span>`
    + `<span class="agy-card-titles"><span class="agy-card-title"${titleAttr ? ` title="${esc(titleAttr)}"` : ''}>${title}</span>${subtitle ? `<span class="agy-card-subtitle">${subtitle}</span>` : ''}</span>`
    + status
    + (expandable ? '<span class="agy-card-chevron" aria-hidden="true"></span>' : '')
    + '</div>';
  return `<div class="agy-card ${cls}${expandable && !open ? ' agy-collapsed' : ''}"${attrs}>${head}${expandable ? `<div class="agy-card-body">${body}</div>` : ''}</div>`;
}

function preBlock(text, { cls = '', max = 20000, label = '' } = {}) {
  const value = String(text ?? '');
  const clipped = value.length > max;
  return `<div class="agy-pre-wrap"><button type="button" class="agy-copy-btn" data-copy-pre="1" aria-label="${esc(label)}" title="${esc(label)}">${ICONS.copy}</button><pre class="agy-pre ${cls}">${esc(clipped ? value.slice(0, max) : value)}</pre>${clipped ? '<div class="agy-pre-note">…</div>' : ''}</div>`;
}

function jsonBlock(value, T) {
  let text;
  try { text = JSON.stringify(value, null, 2); } catch { text = String(value); }
  return preBlock(text, { cls: 'agy-pre-json', max: 12000, label: T('copy') });
}

/** A unified diff of one ACP diff item: path header with counts, numbered rows, "Show the whole diff" past the preview. */
export function diffHtml(item, { T, cwd = '', full = false } = {}) {
  const view = diffView(item);
  const shown = full ? view.rows : view.rows.slice(0, DIFF_LIMITS.previewRows);
  const more = view.rows.length - shown.length;
  const rel = relativeToProject(cwd, view.path);
  const status = view.status === 'added' ? T('diffAdded') : view.status === 'deleted' ? T('diffDeleted') : T('diffModified');
  const rows = shown.map((row) => {
    if (row.kind === 'hunk') return `<div class="agy-diff-line" data-kind="hunk"><span class="agy-diff-old"></span><span class="agy-diff-new"></span><span class="agy-diff-sign"></span><span class="agy-diff-text">${esc(row.text)}</span></div>`;
    if (row.kind === 'note') return `<div class="agy-diff-line" data-kind="note"><span class="agy-diff-old"></span><span class="agy-diff-new"></span><span class="agy-diff-sign"></span><span class="agy-diff-text">${esc(T('diffTruncated'))}</span></div>`;
    const sign = row.kind === 'add' ? '+' : row.kind === 'delete' ? '−' : ' ';
    return `<div class="agy-diff-line" data-kind="${row.kind}"><span class="agy-diff-old">${row.old ?? ''}</span><span class="agy-diff-new">${row.new ?? ''}</span><span class="agy-diff-sign">${sign}</span><span class="agy-diff-text">${esc(row.text)}</span></div>`;
  }).join('');
  const note = view.identical ? `<div class="agy-diff-empty">${esc(T('diffIdentical'))}</div>` : view.fallback ? `<div class="agy-diff-empty">${esc(T('diffTooLarge'))}</div>` : '';
  return `<div class="agy-diff" data-path="${esc(view.path)}" aria-label="${esc(T('diffFor', { path: rel }))}">`
    + `<div class="agy-diff-header"><a class="agy-diff-path" href="${esc(view.path)}" data-file-target="${esc(view.path)}" title="${esc(view.path)}">${esc(rel)}</a>`
    + `<span class="agy-diff-status">${esc(status)}</span><span class="agy-diff-stats"><span class="add">+${view.added}</span> <span class="del">−${view.removed}</span></span>`
    + `<button type="button" class="agy-copy-btn" data-copy-diff="${esc(view.path)}" aria-label="${esc(T('copyPatch'))}" title="${esc(T('copyPatch'))}">${ICONS.copy}</button></div>`
    + `${note}<div class="agy-diff-lines">${rows}</div>`
    + (more > 0 ? `<button type="button" class="agy-link-btn" data-diff-full="${esc(view.path)}">${esc(T('diffShowAll', { count: view.rows.length }))}</button>` : '')
    + '</div>';
}

/** The output of a terminal SynaBun runs for the agent, live while it runs. */
export function terminalHtml(terminal, { T }) {
  if (!terminal) return `<div class="agy-terminal agy-terminal--waiting">${esc(T('terminalWaiting'))}</div>`;
  const exit = terminal.exitStatus;
  const state = !exit ? `<span class="agy-terminal-state" data-tone="running">${esc(T('terminalRunning'))}</span>`
    : exit.signal ? `<span class="agy-terminal-state" data-tone="error">${esc(T('terminalSignal', { signal: exit.signal }))}</span>`
      : `<span class="agy-terminal-state" data-tone="${exit.exitCode === 0 ? 'success' : 'error'}">${esc(T('terminalExit', { code: exit.exitCode ?? '?' }))}</span>`;
  return `<div class="agy-terminal">${preBlock(terminal.output || '', { cls: 'agy-pre-terminal', max: 64000, label: T('copy') })}<div class="agy-terminal-foot">${terminal.truncated ? `<span>${esc(T('terminalTruncated'))}</span>` : ''}${state}</div></div>`;
}

function locationsHtml(locations, cwd) {
  if (!Array.isArray(locations) || !locations.length) return '';
  return `<div class="agy-locations">${locations.slice(0, 20).map((l) => {
    const target = l.line ? `${l.path}:${l.line}` : l.path;
    const shown = l.line ? `${relativeToProject(cwd, l.path)}:${l.line}` : relativeToProject(cwd, l.path);
    return `<a class="agy-file-link" href="${esc(l.path)}" data-file-target="${esc(target)}" title="${esc(target)}">${esc(shown)}</a>`;
  }).join('')}</div>`;
}

// ── Rows ──

/** Whether a tool card starts open: the user's choice first, else the detail level and what it holds. */
export function toolOpen(row, { detail = 'standard', opened = new Set(), closed = new Set() } = {}) {
  if (opened.has(row.toolCallId)) return true;
  if (closed.has(row.toolCallId)) return false;
  if (detail === 'verbose') return true;
  if (detail === 'compact') return false;
  // Standard: file changes open; a command's live output while it runs; a failure with something to say.
  const live = (row.status === 'pending' || row.status === 'in_progress') && row.content.some((item) => item.type === 'terminal');
  return live || row.content.some((item) => item.type === 'diff') || (row.status === 'failed' && row.content.length > 0);
}

export function toolHtml(row, { T, cwd = '', detail = 'standard', opened, closed, terminals = new Map(), fullDiffs = new Set() } = {}) {
  const parts = [];
  for (const item of row.content || []) {
    if (item.type === 'diff') parts.push(diffHtml(item, { T, cwd, full: fullDiffs.has(item.path) }));
    else if (item.type === 'terminal') parts.push(terminalHtml(terminals.get(item.terminalId), { T }));
    else if (item.type === 'content' && item.text) parts.push(preBlock(item.text, { label: T('copy') }));
    else if (item.type === 'content' && item.attachment?.kind === 'image' && /^[A-Za-z0-9+/=]+$/.test(item.attachment.data || '')) {
      parts.push(`<img class="agy-tool-image" src="data:${esc(item.attachment.mimeType)};base64,${item.attachment.data}" alt="">`);
    }
  }
  parts.push(locationsHtml(row.locations, cwd));
  if (detail === 'verbose') {
    if (row.rawInput !== null && row.rawInput !== undefined) parts.push(`<div class="agy-raw"><div class="agy-raw-label">${esc(T('rawInput'))}</div>${jsonBlock(row.rawInput, T)}</div>`);
    if (row.rawOutput !== null && row.rawOutput !== undefined) parts.push(`<div class="agy-raw"><div class="agy-raw-label">${esc(T('rawOutput'))}</div>${jsonBlock(row.rawOutput, T)}</div>`);
  }
  const body = parts.filter(Boolean).join('');
  const duration = durationLabel(row.startedAt, row.endedAt);
  const statusWordOf = () => (row.status === 'completed' ? T('toolDone') : row.status === 'failed' ? T('toolFailed') : row.status === 'in_progress' ? T('toolRunning') : T('toolPending'));
  // A SynaBun tool: the logo, its friendly name ('Bluesky · Post') and what the call is about.
  const sb = synabunCallOf(row);
  if (sb) {
    return cardHtml({
      cls: `agy-tool agy-tool-synabun status-${esc(row.status)}`,
      icon: SYNABUN_LOGO,
      title: esc(synabunToolLabel(sb.key)),
      titleAttr: `SynaBun · ${sb.key}`,
      subtitle: esc([synabunToolSummary(sb.key, sb.args), duration].filter(Boolean).join(' · ')),
      status: statusPill(statusWordOf(), STATUS_TONE[row.status] === 'success' ? '' : STATUS_TONE[row.status] || ''),
      body,
      open: toolOpen(row, { detail, opened, closed }),
      attrs: ` data-tool="${esc(row.toolCallId)}"`,
    });
  }
  const summary = toolSummary(row);
  const shown = row.toolKind === 'execute' ? summary : relativeToProject(cwd, summary);
  const kindWord = T(`kind_${KIND_ICON[row.toolKind] ? row.toolKind : 'other'}`);
  const subtitle = esc([kindWord, row.name && row.name !== kindWord ? row.name : '', duration].filter(Boolean).join(' · '));
  const statusWord = row.status === 'completed' ? T('toolDone') : row.status === 'failed' ? T('toolFailed') : row.status === 'in_progress' ? T('toolRunning') : T('toolPending');
  return cardHtml({
    cls: `agy-tool status-${esc(row.status)}`,
    icon: ICONS[KIND_ICON[row.toolKind] || 'other'],
    title: `<span class="agy-mono">${esc(shown)}</span>`,
    titleAttr: summary,
    subtitle,
    status: statusPill(statusWord, STATUS_TONE[row.status] === 'success' ? '' : STATUS_TONE[row.status] || ''),
    body,
    open: toolOpen(row, { detail, opened, closed }),
    attrs: ` data-tool="${esc(row.toolCallId)}"`,
  });
}

function planHtml(row, { T, md, cwd }) {
  if (row.format === 'markdown') {
    return cardHtml({ cls: 'agy-plan', icon: ICONS.plan, title: esc(T('plan')), body: `<div class="agy-md">${md(row.content || '')}</div>`, open: true, attrs: row.planId ? ` data-plan="${esc(row.planId)}"` : '' });
  }
  if (row.format === 'file') {
    const path = String(row.uri || '').replace(/^file:\/\//, '');
    return cardHtml({ cls: 'agy-plan', icon: ICONS.plan, title: esc(T('plan')), subtitle: `<a class="agy-file-link" href="${esc(path)}" data-file-target="${esc(path)}">${esc(relativeToProject(cwd, path))}</a>`, attrs: row.planId ? ` data-plan="${esc(row.planId)}"` : '' });
  }
  const entries = row.entries || [];
  const done = entries.filter((e) => e.status === 'completed').length;
  const list = `<ol class="agy-plan-list">${entries.map((e) => `<li class="agy-plan-item" data-status="${esc(e.status)}"><span class="agy-plan-mark" aria-hidden="true"></span><span class="agy-plan-text">${esc(e.content)}</span>${e.priority === 'high' ? `<span class="agy-plan-priority">${esc(T('priorityHigh'))}</span>` : ''}</li>`).join('')}</ol>`;
  const running = entries.some((e) => e.status === 'in_progress');
  return cardHtml({
    cls: 'agy-plan', icon: ICONS.plan, title: esc(T('plan')), subtitle: esc(T('planProgress', { done, total: entries.length })),
    status: statusPill(done === entries.length && entries.length ? T('planDone') : running ? T('toolRunning') : T('toolPending'), done === entries.length && entries.length ? '' : running ? 'running' : ''),
    body: list, open: true, attrs: row.planId ? ` data-plan="${esc(row.planId)}"` : '',
  });
}

function thoughtHtml(row, { T, detail, running, folds = new Map() }) {
  if (detail === 'compact') {
    return running && !row.closed ? `<div class="agy-system working">${esc(T('thinkingNow'))}</div>` : '';
  }
  const duration = durationLabel(row.startedAt, row.endedAt);
  const label = !row.closed && running ? T('thinkingNow') : duration ? T('thoughtFor', { duration }) : T('thought');
  // The user's own open or close of this fold wins over the detail level, through every redraw.
  const open = folds.has(row.id) ? folds.get(row.id) : detail === 'verbose';
  return `<details class="agy-thought"${open ? ' open' : ''} data-row="${esc(row.id)}"><summary>${esc(label)}</summary><div class="agy-thought-body">${esc(row.text)}</div></details>`;
}

function attachmentsHtml(list) {
  if (!Array.isArray(list) || !list.length) return '';
  return `<div class="agy-attach-list">${list.map((a) => {
    if (a.kind === 'image' && typeof a.data === 'string' && /^data:image\/(png|jpeg|gif|webp);base64,/.test(a.data)) return `<img class="agy-msg-image" src="${esc(a.data)}" alt="${esc(a.name || '')}">`;
    if (a.kind === 'image' && a.data && a.mimeType && /^image\/(png|jpeg|gif|webp)$/.test(a.mimeType) && /^[A-Za-z0-9+/=]+$/.test(a.data)) return `<img class="agy-msg-image" src="data:${esc(a.mimeType)};base64,${a.data}" alt="">`;
    return `<span class="agy-chip"><span>${esc(a.name || a.uri || 'file')}</span></span>`;
  }).join('')}</div>`;
}

function subagentHtml(row, { T }) {
  const tone = row.state === 'running' ? 'running' : row.state === 'requires_action' ? 'warning' : '';
  const word = row.state === 'running' ? T('subagentRunning') : row.state === 'idle' ? T('subagentIdle') : row.state === 'requires_action' ? T('subagentNeedsYou') : T('subagentUnknown');
  return cardHtml({
    cls: 'agy-subagent', icon: ICONS.subagent, title: esc(row.title || T('subagent')), subtitle: esc(row.description || ''),
    status: statusPill(word, tone), attrs: ` data-subagent="${esc(row.sessionId)}"`,
  });
}

function compactionHtml(row, { T, md }) {
  const status = row.status === 'completed' ? T('compactionDone') : row.status === 'failed' ? T('compactionFailed') : row.status === 'cancelled' ? T('compactionCancelled') : T('compactionRunning');
  const tone = row.status === 'in_progress' ? 'running' : row.status === 'failed' ? 'error' : row.status === 'cancelled' ? 'warning' : '';
  const body = [row.summary ? `<div class="agy-md">${md(row.summary)}</div>` : '', row.error ? `<div class="agy-card-error">${esc(row.error)}</div>` : ''].join('');
  return cardHtml({ cls: 'agy-compaction', icon: ICONS.compaction, title: esc(T('compaction')), status: statusPill(status, tone), body, open: false, attrs: ` data-compaction="${esc(row.compactionId)}"` });
}

/** One transcript row. `ctx`: { T, md, cwd, detail, running, opened, closed, terminals, fullDiffs }. */
export function rowHtml(row, ctx) {
  const { T, md } = ctx;
  switch (row.kind) {
    case 'user':
      return `<div class="agy-msg agy-msg-user" data-row="${esc(row.id)}"><div class="agy-msg-card"><div class="agy-msg-text">${esc(row.text)}</div>${attachmentsHtml(row.attachments)}</div></div>`;
    case 'agent':
      if (!row.text && !(row.attachments || []).length) return '';
      return `<div class="agy-msg agy-msg-agent" data-row="${esc(row.id)}"><div class="agy-md">${md(row.text)}</div>${attachmentsHtml(row.attachments)}</div>`;
    case 'thought':
      return thoughtHtml(row, ctx);
    case 'tool':
      return toolHtml(row, ctx);
    case 'plan':
      return planHtml(row, ctx);
    case 'notice': {
      const tone = row.severity === 'error' ? ' error' : row.severity === 'warning' ? ' warning' : '';
      // A turn's own ending (agy-events.js endTurn) is said in the page's language.
      const key = NOTICE_KEYS[row.code];
      return `<div class="agy-system${tone}" role="${row.severity === 'error' ? 'alert' : 'status'}">${esc(key ? T(key) : row.text)}</div>`;
    }
    case 'compaction':
      return compactionHtml(row, ctx);
    case 'subagent':
      return subagentHtml(row, ctx);
    case 'message':
      return `<div class="agy-msg agy-msg-relay" data-row="${esc(row.id)}"><div class="agy-msg-relay-label">${esc(T('relayedMessage'))}</div><div class="agy-md">${md(row.text)}</div></div>`;
    default:
      return '';
  }
}

/** The line under a finished turn: its usage and time, Copy, and Retry on the last one. */
export function turnFooterHtml(turn, { T, last = false, answer = '' } = {}) {
  const usage = usageParts(turn.usage).map((part) => `<span>${esc(T(`usage_${part.key}`, { value: part.value }))}</span>`).join('<span aria-hidden="true">·</span>');
  const duration = durationLabel(turn.startedAt, turn.endedAt);
  return `<div class="agy-turn-foot" data-turn="${esc(turn.id)}">`
    + `<span class="agy-turn-meta">${usage}${usage && duration ? '<span aria-hidden="true">·</span>' : ''}${duration ? `<span>${esc(duration)}</span>` : ''}</span>`
    + `<span class="agy-turn-actions">${answer ? `<button type="button" class="agy-icon-btn" data-copy-turn="${esc(turn.id)}" aria-label="${esc(T('copyAnswer'))}" title="${esc(T('copyAnswer'))}">${ICONS.copy}</button>` : ''}`
    + `${last ? `<button type="button" class="agy-icon-btn" data-retry="${esc(turn.id)}" aria-label="${esc(T('retry'))}" title="${esc(T('retry'))}">${ICONS.retry}</button>` : ''}</span></div>`;
}

// ── Requests the agent waits on ──

export function permissionHtml(requestId, entry, { T, cwd = '' } = {}) {
  const { card } = entry;
  const done = entry.state !== 'open';
  const buttons = card.options.map((option) => {
    const cls = option.tone === 'deny' ? 'agy-btn-deny' : option.kind === 'allow_once' ? 'agy-btn-primary' : '';
    return `<button type="button" class="agy-action ${cls}" data-permission="${esc(requestId)}" data-option="${esc(option.optionId)}"${done ? ' disabled' : ''}>${esc(option.label)}</button>`;
  }).join('') || `<button type="button" class="agy-action agy-btn-deny" data-permission="${esc(requestId)}" data-option=""${done ? ' disabled' : ''}>${esc(T('permissionDeny'))}</button>`;
  const stateWord = entry.state === 'answered' ? T('permissionAnswered') : entry.state === 'cancelled' ? T('permissionCancelled') : entry.state === 'answering' ? T('permissionSending') : '';
  const diffs = (card.diffs || []).map((item) => diffHtml(item, { T, cwd })).join('');
  const title = T('permissionTitle', { verb: T(`verb_${card.kind}`) });
  const body = `${card.title ? `<p class="agy-card-text">${esc(card.title)}</p>` : ''}${diffs || (card.detail ? preBlock(card.detail, { label: T('copy') }) : '')}`
    + `<div class="agy-card-actions">${done ? `<span class="agy-card-state">${esc(stateWord)}</span>` : buttons}</div>`
    + (!done ? `<div class="agy-card-hint">${esc(T('permissionKeys'))}</div>` : '');
  return `<div class="agy-card agy-request${done ? ' agy-request-done' : ''}" role="group" aria-label="${esc(title)}" data-request="${esc(requestId)}">`
    + `<div class="agy-card-head"><span class="agy-card-icon">${ICONS.permission}</span><span class="agy-card-titles"><span class="agy-card-title">${esc(title)}</span></span>${done ? '' : statusPill(T('needsYou'), 'warning')}</div>`
    + `<div class="agy-card-body">${body}</div></div>`;
}

function fieldHtml(requestId, field, { T, error = '' }) {
  const id = `agy-el-${esc(requestId)}-${esc(field.name)}`;
  const label = `<label class="agy-field-label" for="${id}">${esc(field.title)}${field.required ? ' <span aria-hidden="true">*</span>' : ''}</label>`;
  const help = field.description ? `<div class="agy-field-help">${esc(field.description)}</div>` : '';
  const err = error ? `<div class="agy-field-error" role="alert">${esc(T(error))}</div>` : '';
  if (field.type === 'unsupported') return `<div class="agy-field">${label}<div class="agy-field-help">${esc(T('elicitUnsupported'))}</div></div>`;
  if (field.type === 'boolean') {
    return `<div class="agy-field agy-field-check"><label class="agy-check"><input type="checkbox" id="${id}" data-field="${esc(field.name)}"${field.defaultValue === true ? ' checked' : ''}><span>${esc(field.title)}</span></label>${help}${err}</div>`;
  }
  if (field.choices.length) {
    const type = field.multiple ? 'checkbox' : 'radio';
    const defaults = new Set(Array.isArray(field.defaultValue) ? field.defaultValue : field.defaultValue != null ? [String(field.defaultValue)] : []);
    return `<fieldset class="agy-field" role="${field.multiple ? 'group' : 'radiogroup'}"><legend class="agy-field-label">${esc(field.title)}${field.required ? ' <span aria-hidden="true">*</span>' : ''}</legend><div class="agy-choices">${field.choices.map((choice) => `<label class="agy-choice"><input type="${type}" name="${id}" value="${esc(choice.value)}" data-field="${esc(field.name)}"${defaults.has(choice.value) ? ' checked' : ''}><span>${esc(choice.label)}</span></label>`).join('')}</div>${help}${err}</fieldset>`;
  }
  const inputType = field.type === 'number' || field.type === 'integer' ? 'number' : field.format === 'email' ? 'email' : field.format === 'uri' ? 'url' : field.format === 'date' ? 'date' : 'text';
  const attrs = [
    field.min !== null && inputType === 'number' ? ` min="${field.min}"` : '',
    field.max !== null && inputType === 'number' ? ` max="${field.max}"` : '',
    field.type === 'integer' ? ' step="1"' : '',
    field.maxLength !== null ? ` maxlength="${field.maxLength}"` : '',
    field.defaultValue != null && typeof field.defaultValue !== 'object' ? ` value="${esc(field.defaultValue)}"` : '',
  ].join('');
  return `<div class="agy-field">${label}<input class="agy-field-input" type="${inputType}" id="${id}" data-field="${esc(field.name)}"${attrs}>${help}${err}</div>`;
}

/** The agent asks for input (ACP elicitation): a form, or a link to open. */
export function elicitationHtml(requestId, entry, { T } = {}) {
  const done = entry.state !== 'open';
  const head = `<div class="agy-card-head"><span class="agy-card-icon">${ICONS.question}</span><span class="agy-card-titles"><span class="agy-card-title">${esc(T('elicitTitle'))}</span></span>${done ? '' : statusPill(T('needsYou'), 'warning')}</div>`;
  const message = `<p class="agy-card-text">${esc(entry.message || '')}</p>`;
  let body;
  if (done) {
    const word = entry.state === 'answered' ? T('elicitAnswered') : entry.state === 'declined' ? T('elicitDeclined') : T('permissionCancelled');
    body = `${message}<div class="agy-card-actions"><span class="agy-card-state">${esc(word)}</span></div>`;
  } else if (entry.mode === 'url') {
    const url = elicitationUrl(entry);
    body = `${message}${url ? `<div class="agy-url-box"><code>${esc(url)}</code></div>` : `<div class="agy-card-error">${esc(T('elicitBadUrl'))}</div>`}`
      + `<div class="agy-card-actions">${url ? `<a class="agy-action agy-btn-primary" href="${esc(url)}" target="_blank" rel="noopener noreferrer" data-elicit-open="${esc(requestId)}">${esc(T('elicitOpen'))}</a><button type="button" class="agy-action" data-elicit="${esc(requestId)}" data-action="accept">${esc(T('elicitDone'))}</button>` : ''}`
      + `<button type="button" class="agy-action agy-btn-deny" data-elicit="${esc(requestId)}" data-action="decline">${esc(T('elicitDecline'))}</button></div>`;
  } else if (entry.mode === 'form') {
    const fields = elicitationFields(entry.requestedSchema);
    const errors = entry.errors || {};
    body = `${message}<form class="agy-elicit-form" data-elicit-form="${esc(requestId)}" novalidate>${fields.map((field) => fieldHtml(requestId, field, { T, error: errors[field.name] || '' })).join('')}`
      + `<div class="agy-card-actions"><button type="submit" class="agy-action agy-btn-primary">${esc(T('elicitSubmit'))}</button>`
      + `<button type="button" class="agy-action" data-elicit="${esc(requestId)}" data-action="decline">${esc(T('elicitDecline'))}</button>`
      + `<button type="button" class="agy-action agy-btn-deny" data-elicit="${esc(requestId)}" data-action="cancel">${esc(T('elicitCancel'))}</button></div></form>`;
  } else {
    body = `${message}<div class="agy-card-text">${esc(T('elicitUnsupportedMode'))}</div><div class="agy-card-actions"><button type="button" class="agy-action agy-btn-deny" data-elicit="${esc(requestId)}" data-action="decline">${esc(T('elicitDecline'))}</button></div>`;
  }
  return `<div class="agy-card agy-request${done ? ' agy-request-done' : ''}" role="group" aria-label="${esc(T('elicitTitle'))}" data-elicit-card="${esc(requestId)}">${head}<div class="agy-card-body">${body}</div></div>`;
}

// ── Getting started ──

/** The setup card (agy-setup.js setupView). `centered`: it stands alone in an empty transcript. */
export function setupHtml(view, { T, centered = false } = {}) {
  if (!view?.show) return '';
  const steps = Array.isArray(view.steps) ? `<ol class="agy-steps" aria-label="${esc(T('setupStepsLabel'))}">${view.steps.map((step) => `<li class="agy-step" data-state="${esc(step.state)}"><span class="agy-step-dot" aria-hidden="true">${step.state === 'done' ? ICONS.check : step.state === 'failed' ? ICONS.cross : ''}</span><span class="agy-step-label">${esc(T(`step_${step.id}`))}</span><span class="agy-visually-hidden">${esc(T(`stepState_${step.state}`))}</span></li>`).join('')}</ol>` : '';
  const body = view.text ? esc(view.text) : view.bodyKey ? esc(T(view.bodyKey, view.params || {})) : '';
  const command = view.command ? `<div class="agy-command"><code>${esc(view.command)}</code><button type="button" class="agy-command-copy" data-setup="copy" aria-label="${esc(T('copyCommand'))}">${ICONS.copy}<span>${esc(T('copy'))}</span></button></div>` : '';
  const progress = view.progress ? `<div class="agy-setup-progress"><div class="agy-setup-step-text">${esc(view.progressKey ? T(view.progressKey) : view.progress.text || '')}</div>${typeof view.progress.percent === 'number' ? `<div class="agy-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${view.progress.percent}"><span style="width:${Math.max(0, Math.min(100, view.progress.percent))}%"></span></div>` : '<div class="agy-bar agy-bar--busy" aria-hidden="true"><span></span></div>'}</div>` : '';
  const error = view.error ? `<div class="agy-setup-error"><code>${esc(view.error)}</code></div>` : '';
  const note = view.note ? `<div class="agy-setup-note">${esc(view.note)}</div>` : '';
  const log = (view.log || []).length ? `<details class="agy-setup-log"${view.stage === 'failed' || view.logOpen ? ' open' : ''}><summary>${esc(T('setupLog'))}</summary><pre aria-label="${esc(T('setupLog'))}">${esc(view.log.join('\n'))}</pre></details>` : '';
  const signIn = Array.isArray(view.signIn) ? view.signIn.map((m, i) => `<button type="button" class="agy-action${i === 0 ? ' agy-btn-primary' : ''}" data-auth="${esc(m.id)}"${m.terminal ? ' data-auth-kind="terminal"' : ''} title="${esc(m.description)}"${view.waiting ? ' disabled' : ''}>${esc(m.name)}</button>`).join('') : '';
  const actions = [
    view.install ? `<button type="button" class="agy-action agy-btn-primary" data-setup="install"${view.install.disabled ? ' disabled' : ''}>${esc(T('setupInstall'))}</button>` : '',
    view.retry ? `<button type="button" class="agy-action agy-btn-primary" data-setup="install">${esc(T('setupRetry'))}</button>` : '',
    signIn,
    view.terminal ? `<button type="button" class="agy-action" data-auth-terminal="1">${esc(T('signInTerminal'))}</button>` : '',
    view.checkSignIn ? `<button type="button" class="agy-action" data-setup="signin-check">${esc(T('signInCheck'))}</button>` : '',
    view.addPath ? `<button type="button" class="agy-action" data-setup="path"${view.addPath.disabled ? ' disabled' : ''}>${esc(view.addPath.label || T('addToPath'))}</button>` : '',
    view.recheck ? `<button type="button" class="agy-action" data-setup="recheck"${view.checking ? ' disabled' : ''}>${esc(T(view.checking ? 'setupChecking' : 'setupRecheck'))}</button>` : '',
    view.dismiss ? `<button type="button" class="agy-action" data-setup="dismiss">${esc(T('setupDismiss'))}</button>` : '',
  ].join('');
  const guide = view.guide ? `<a class="agy-setup-guide" href="${esc(view.guide)}" target="_blank" rel="noopener noreferrer">${esc(T('installGuide'))}</a>` : '';
  return `<section class="agy-setup agy-setup--${esc(view.stage || 'x')}${centered ? ' agy-setup--centered' : ''}" data-tone="${esc(view.tone || '')}" role="${view.live === 'assertive' ? 'alert' : 'status'}" aria-live="${esc(view.live || 'polite')}">`
    + `<span class="agy-setup-mark" aria-hidden="true">${ICONS.mark}</span>`
    + `<h3 class="agy-setup-title">${esc(T(view.titleKey || 'setupMissingTitle'))}</h3>`
    + (body ? `<p class="agy-setup-body">${body}</p>` : '')
    + steps + progress + command + error + note + log
    + (actions ? `<div class="agy-setup-actions">${actions}</div>` : '')
    + guide
    + '</section>';
}

/** The empty transcript: the mark, the name, what to do, and the two keys that help. */
export function emptyHtml({ T, project = '' } = {}) {
  return `<div class="agy-empty"><span class="agy-empty-mark" aria-hidden="true">${ICONS.mark}</span><div class="agy-empty-name">${esc(T('emptyTitle'))}</div>`
    + `<div class="agy-empty-status">${esc(project ? T('emptyBody') : T('noProject'))}</div>`
    + (project ? `<div class="agy-empty-keys"><span><kbd>/</kbd> ${esc(T('emptyKeyCommands'))}</span><span><kbd>@</kbd> ${esc(T('emptyKeyFiles'))}</span></div>` : '')
    + '</div>';
}

/** The context gauge in words: "50k / 1M · 5%" and the cost when the agent reports one. */
export function contextWords(gauge, T) {
  if (!gauge) return T('contextUnknown');
  const cost = gauge.cost ? ` · ${gauge.cost.currency} ${Number(gauge.cost.amount).toFixed(2)}` : '';
  return `${gauge.label} · ${gauge.percent}%${cost}`;
}

export { compactNumber };
