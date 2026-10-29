// ═══════════════════════════════════════════
// SETTINGS — SynaBun's Claude Code hooks, in words
// ═══════════════════════════════════════════
//
// What `GET /api/claude-code/integrations` says in `claudeHooks` (lib/claude-hooks-status.js) about Settings →
// Automations → Automation behavior → SynaBun hooks in Claude Code: whether a Claude Code session the owner starts
// by themselves runs SynaBun's hooks, what stands in the way, and whether the switch can change it. Pure: no DOM
// and no import, so node runs it (tests/settings-claude-hooks-view.test.mjs).
//
//   readClaudeHooksResponse({ status, body, error })   what the server answered → a reading
//   describeClaudeHooks(reading, { tx })                the row as ui-settings.js draws it
//   describeClaudeHooksSaveFailure(input, { tx })       the sentence for a change that could not be made
//
// `tx(key, params)` is the caller's translate function over the settings.redesign.* strings (the kit's `tx`).
// The row never shows "off" for what it could not read: a refusal (SynaBun's automation browser), a server started
// before this, an unreadable settings file each say what they are, with the switch disabled.

const K = 'settings.redesign.hooks.claudeHooks';

/** The rows of the "Hooks for standalone Claude Code" list: one per moment, the guards over two events. */
export const CLAUDE_HOOK_ROWS = Object.freeze([
  Object.freeze({ key: 'SessionStart', events: ['SessionStart'] }),
  Object.freeze({ key: 'UserPromptSubmit', events: ['UserPromptSubmit'] }),
  Object.freeze({ key: 'PreCompact', events: ['PreCompact'] }),
  Object.freeze({ key: 'Stop', events: ['Stop'] }),
  Object.freeze({ key: 'PreToolUse', events: ['PreToolUse', 'PostToolBatch'] }),
  Object.freeze({ key: 'PostToolUse', events: ['PostToolUse'] }),
  Object.freeze({ key: 'SubagentStart', events: ['SubagentStart'] }),
  Object.freeze({ key: 'SubagentStop', events: ['SubagentStop'] }),
]);

/** The refusals of SynaBun's owner-only routes for a browser that is not the owner's (lib/owner-authority.js). */
const REFUSED_CODES = new Set(['WORKER_BROWSER', 'PEER_REFUSED']);

const clean = (value, max = 240) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const names = (list) => [...new Set((list || []).map((p) => clean(p.label || String(p.path || '').split(/[\\/]/).filter(Boolean).pop() || p.path, 60)))].join(', ');

/**
 * What the server answered.
 *
 *   ready        `hooks` is the server's claudeHooks
 *   old-server   an answer without claudeHooks: the running server was started before it (public/ is served live,
 *                lib/ only after a restart), and its own reading of the settings may be wrong
 *   refused      403 WORKER_BROWSER / PEER_REFUSED: SynaBun's automation browser, never the owner's own window
 *   forbidden    403 otherwise (a guest)
 *   unreadable   anything else (no answer, an error, a body that is not the payload)
 */
export function readClaudeHooksResponse({ status = 0, body = null, error = null } = {}) {
  const code = Number(status) || 0;
  if (code >= 200 && code < 300 && body && typeof body === 'object' && body.ok === true) {
    const hooks = body.claudeHooks;
    if (hooks && typeof hooks === 'object' && Number(hooks.version) >= 1 && typeof hooks.state === 'string') return { state: 'ready', hooks, reason: null };
    return { state: 'old-server', hooks: null, reason: null };
  }
  if (code === 403) {
    const refusal = String(body?.code || '');
    return { state: REFUSED_CODES.has(refusal) ? 'refused' : 'forbidden', hooks: null, reason: clean(body?.error) || null, code: refusal || null };
  }
  return { state: 'unreadable', hooks: null, reason: clean(error || body?.error || (code ? `HTTP ${code}` : '')) || null };
}

/** Which list rows are on: every event of the row has all of SynaBun's handlers. */
export function claudeHookRowsOn(events) {
  return Object.fromEntries(CLAUDE_HOOK_ROWS.map((row) => [row.key, row.events.every((event) => events?.[event] === true)]));
}

/**
 * The row: { state, ready, disabled, on, notes: [{ text, tone }], note: { text, tone } | null, repair, applies,
 * rows: { [rowKey]: boolean } | null (the list below; null when nothing could be read), onRows, totalRows }.
 * `note` says why nothing below can be trusted or changed; `notes` describe what is installed.
 */
export function describeClaudeHooks(reading, { tx }) {
  const r = reading || readClaudeHooksResponse({ status: 0 });
  const view = { state: r.state, ready: false, disabled: true, on: false, notes: [], note: null, repair: false, applies: tx(`${K}.applies`), rows: null, onRows: 0, totalRows: CLAUDE_HOOK_ROWS.length };
  if (r.state === 'old-server') { view.note = { text: tx(`${K}.restart`), tone: 'warn' }; return view; }
  if (r.state === 'refused') { view.note = { text: tx(`${K}.refused`), tone: 'warn' }; return view; }
  if (r.state === 'forbidden') { view.note = { text: tx(`${K}.forbidden`), tone: 'warn' }; return view; }
  if (r.state !== 'ready') {
    view.note = { text: r.reason ? tx(`${K}.unreadable`, { reason: r.reason }) : tx(`${K}.unreadableNoReason`), tone: 'warn' };
    return view;
  }
  const h = r.hooks;
  if (h.state === 'error') {
    view.note = { text: tx(`${K}.settingsUnreadable`, { path: h.settingsPath || '~/.claude/settings.json', reason: clean(h.error) || '?' }), tone: 'warn' };
    return view;
  }
  const path = h.settingsPath || '~/.claude/settings.json';
  const rows = claudeHookRowsOn(h.events);
  const onRows = Object.values(rows).filter(Boolean).length;
  const installed = h.state === 'on' || h.state === 'partial';
  const managed = h.blockedBy?.scope === 'managed';
  view.ready = true;
  view.rows = rows;
  view.onRows = onRows;
  // On means "a session the owner starts runs them": installed and not switched off by Claude Code itself.
  view.on = installed && !h.blockedBy;
  // The organization's managed settings, and a packaged app started from a temporary place, cannot be switched here.
  view.disabled = managed || !!h.installBlocker;

  if (h.installBlocker) view.notes.push({ text: clean(h.installBlocker, 400), tone: 'warn' });
  if (managed) view.notes.push({ text: tx(`${K}.blocked.managed.${h.blockedBy.setting === 'allowManagedHooksOnly' ? 'managedOnly' : 'disableAll'}`, { path: h.blockedBy.path }), tone: 'warn' });
  else if (h.blockedBy) view.notes.push({ text: tx(`${K}.blocked.user`, { path: h.blockedBy.path || path }), tone: 'warn' });
  else if (h.state === 'on') view.notes.push({ text: tx(`${K}.on`, { path }), tone: 'info' });
  else if (h.state === 'partial') view.notes.push({ text: tx(`${K}.partial`, { on: onRows, total: CLAUDE_HOOK_ROWS.length }), tone: 'info' });
  else view.notes.push({ text: tx(`${K}.off`), tone: 'info' });

  if (h.needsRepair && !managed) {
    view.repair = !h.installBlocker;
    if (h.current < h.installed) view.notes.push({ text: tx(`${K}.repair.stale`, { count: h.installed - h.current }), tone: 'warn' });
    if (h.duplicates > 0) view.notes.push({ text: tx(`${K}.repair.duplicates`, { count: h.duplicates }), tone: 'warn' });
    const different = (h.projects || []).filter((p) => p.issue === 'different');
    if (different.length) view.notes.push({ text: tx(`${K}.repair.projects`, { names: names(different) }), tone: 'warn' });
    if (h.nodeMissing) view.notes.push({ text: tx(`${K}.repair.node`), tone: 'warn' });
  }
  const off = (h.projects || []).filter((p) => p.issue === 'disableAllHooks');
  if (off.length) view.notes.push({ text: tx(`${K}.projectsOff`, { names: names(off) }), tone: 'warn' });
  const stillOn = (h.projects || []).filter((p) => p.issue === 'project-only');
  if (stillOn.length) view.notes.push({ text: tx(`${K}.projectsStillOn`, { names: names(stillOn) }), tone: 'warn' });
  return view;
}

/**
 * The sentence for a change that could not be made: { action: 'on' | 'off' | 'repair', status, body, error }.
 * An answer without claudeHooks after a change that worked is a server started before this (said as such).
 */
export function describeClaudeHooksSaveFailure({ action = 'on', status = 0, body = null, error = null } = {}, { tx }) {
  const verb = ['on', 'off', 'repair'].includes(action) ? action : 'on';
  const code = Number(status) || 0;
  if (!code) return tx(`${K}.save.noAnswer.${verb}`);
  if (code === 403 && REFUSED_CODES.has(String(body?.code || ''))) return tx(`${K}.save.refused.${verb}`);
  return tx(`${K}.save.failed.${verb}`, { reason: clean(body?.error || error) || `HTTP ${code}` });
}
