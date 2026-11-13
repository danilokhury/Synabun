// ═══════════════════════════════════════════
// SynaBun — Maritaca panel: the HTML (no DOM access: strings in, strings out)
// ═══════════════════════════════════════════

import { durationLabel, usageParts } from './mtc-logic.js';
import { formatBytes } from './mtc-compose.js';

export function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// The Maritaca mark (maritaca.ai favicon.svg, the bird), drawn in currentColor so the brand colour is a token.
export const ICONS = {
  mark: '<svg viewBox="0 0 12.48 13.73" fill="currentColor" aria-hidden="true"><path d="M10.11 11.01h1.9S7.21 5.97 5.72 4.4a.62.62 0 0 0-.93.04c-.48.59-.76 1.33-.81 2.1-.06 1.04.32 2.06 1.04 2.8l4.35 4.4h3.1l-2.37-2.72Z"/><path d="M5.69 11 4.52 9.82c-.86-.89-1.31-2.1-1.24-3.33s.67-2.38 1.62-3.16c.35.06.71-.02 1.01-.24-.07-.24-.16-.55-.22-.75-.02-.07.06-.13.12-.09l1.16.77c.3-.61.22-1.37-.26-1.9.1-.18.06-.44-.15-.57C6.07.26 5.36 0 4.41 0 2.76 0 0 1.5 0 5.18c0 2.12 1.36 4.57 3.86 5.47l-1.43 3.08h1.05L4.8 10.9c.29.05.58.09.89.1l-1.27 2.73h1.05l.94-2.01L5.7 11ZM4.84.67c.23 0 .42.19.42.42s-.19.42-.42.42-.42-.19-.42-.42.19-.42.42-.42"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  retry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  // The sibling panels' icons (cdx/cdx-icons.js ICON_PLAN / ICON_BRAIN, cdx-context-menu.js's cog), so the controls read the same.
  plan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 14l2 2 4-4"/></svg>',
  brain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a7 7 0 0 0-4.6 12.3L12 22l4.6-7.7A7 7 0 0 0 12 2z"/></svg>',
  cog: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  attach: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>',
};

/** One transcript row. `md(text)` renders markdown to safe HTML. */
export function rowHtml(row, { T, md, last = false, disabled = false, editable = false }) {
  if (row.kind === 'user') {
    return `<div class="mtc-msg mtc-msg-user" data-row="${esc(row.id)}"><div class="mtc-msg-card"><div class="mtc-msg-text">${esc(row.text)}</div>${attachmentsHtml(row.attachments, T, false)}<div class="mtc-turn-actions"><button type="button" class="mtc-icon-btn" data-copy-row="${esc(row.id)}" aria-label="${esc(T('copy'))}">${ICONS.copy}</button>${editable ? `<button type="button" class="mtc-icon-btn" data-edit-row="${esc(row.id)}" aria-label="${esc(T('editResend'))}" title="${esc(T('editResend'))}"${disabled ? ' disabled' : ''}>↶</button>` : ''}</div></div></div>`;
  }
  if (row.kind !== 'assistant') return '';
  const reasoning = row.reasoning
    ? `<details class="mtc-thought${row.streaming && !row.text ? ' thinking' : ''}"${row.streaming && !row.text ? ' open' : ''}><summary>${esc(row.streaming && !row.text ? T('working') : T('reasoningFor'))}</summary><div class="mtc-thought-body">${esc(row.reasoning)}</div></details>`
    : '';
  const body = row.text ? `<div class="mtc-md">${md(row.text)}</div>` : row.streaming && !row.reasoning ? `<div class="mtc-system working" role="status">${esc(T('working'))}</div>` : '';
  const notices = [];
  if (row.error) notices.push(`<div class="mtc-system error" role="alert">${esc(row.error)}</div>`);
  else if (row.finishReason === 'length') notices.push(`<div class="mtc-system warning" role="status">${esc(T('finishLength'))}</div>`);
  else if (row.finishReason === 'cancelled') notices.push(`<div class="mtc-system" role="status">${esc(T('finishCancelled'))}</div>`);
  return `<div class="mtc-msg mtc-msg-agent${row.streaming ? ' streaming' : ''}" data-row="${esc(row.id)}">${reasoning}${body}${notices.join('')}${row.streaming ? '<span class="mtc-stream-cursor" aria-hidden="true"></span>' : footerHtml(row, T, { last, disabled })}</div>`;
}

/** The line under a finished reply: tokens, cost in BRL, time, Copy and Retry. */
export function footerHtml(row, T, { last = false, disabled = false } = {}) {
  const parts = usageParts(row.usage, row.costBrl, T);
  const duration = durationLabel(row.startedAt, row.endedAt);
  const plan = row.mode === 'plan' ? `<span class="mtc-plan-chip">${esc(T('planBadge'))}</span>` : '';
  if (duration) parts.push(duration);
  if (row.model) parts.push(row.model);
  return `<div class="mtc-turn-foot" data-row="${esc(row.id)}"><span class="mtc-turn-meta">${plan}${parts.map((p) => `<span class="${p.startsWith('R$') ? 'mtc-cost-pill' : 'mtc-usage-chip'}">${esc(p)}</span>`).join('')}</span>`
    + `<span class="mtc-turn-actions">${row.text ? `<button type="button" class="mtc-icon-btn" data-copy-row="${esc(row.id)}" aria-label="${esc(T('copyAnswer'))}" title="${esc(T('copyAnswer'))}">${ICONS.copy}</button>` : ''}`
    + `${last ? `<button type="button" class="mtc-icon-btn" data-retry-row="${esc(row.id)}" aria-label="${esc(T('retry'))}" title="${esc(T('retry'))}"${disabled ? ' disabled' : ''}>${ICONS.retry}</button>` : ''}</span></div>`;
}

export function attachmentsHtml(files = [], T, removable = true) {
  return files.map((file, i) => `<span class="mtc-attachment" title="${esc(file.name)}"><span class="mtc-attachment-name">${esc(file.name)}</span><span class="mtc-attachment-size">${esc(formatBytes(file.size))}</span>${removable ? `<button type="button" class="mtc-icon-btn" data-remove-attachment="${i}" aria-label="${esc(T('attachmentRemove', { name: file.name }))}">&times;</button>` : ''}</span>`).join('');
}

/** The empty transcript: the mark, a sentence, and the key prompt when none is saved. */
export function emptyHtml({ T, configured = true, blocked = null }) {
  const body = blocked ? T(`connBlocked_${blocked.reason}`, { message: blocked.message || '' }) : configured ? T('emptyBody') : T('emptyNoKey');
  const action = !blocked && !configured
    ? `<div class="mtc-empty-actions"><button type="button" class="mtc-action mtc-btn-primary" data-open-settings="1">${esc(T('emptyKeyButton'))}</button>`
      + `<a class="mtc-link" href="https://plataforma.maritaca.ai/chaves-de-api" target="_blank" rel="noopener noreferrer">${esc(T('emptyKeyLink'))}</a></div>`
    : '';
  return `<div class="mtc-empty"><span class="mtc-empty-mark" aria-hidden="true">${ICONS.mark}</span><div class="mtc-empty-name">${esc(T('emptyTitle'))}</div><div class="mtc-empty-status">${esc(body)}</div>${action}</div>`;
}

/**
 * The settings dialog (the Codex panel's in-panel settings overlay, `.mtc-settings-*`): the key with Save / Test /
 * Forget, the defaults (model and reasoning, the app's dropdowns), the system prompt and the temperature, links.
 * `status` is GET /api/maritaca/settings; `keyLine` is keyStatusLine()'s sentence. Every value is escaped.
 */
export function settingsHtml({ T, status, keyLine, modelDropdown, effortDropdown, systemMax = 8000 }) {
  const s = status?.settings || {};
  const tone = status?.configured ? 'ok' : 'err';
  const prompt = String(s.systemPrompt || '');
  const temp = s.temperature === null || s.temperature === undefined ? '' : esc(s.temperature);
  return `<div class="mtc-settings-header"><span class="mtc-settings-title" id="mtc-settings-title">${esc(T('settingsTitle'))}</span><button type="button" class="mtc-settings-close" data-close-settings="1" aria-label="${esc(T('settingsClose'))}" title="${esc(T('settingsClose'))}">&times;</button></div>
    <div class="mtc-settings-body">
      <section class="mtc-settings-section" data-section="key">
        <h3 class="mtc-settings-section-title">${esc(T('settingsSectionKey'))}</h3>
        <div class="mtc-settings-status"><span class="mtc-ctxpop-dot mtc-ctxpop-dot-${tone} mtc-key-dot" aria-hidden="true"></span><span class="mtc-key-status">${esc(keyLine)}</span></div>
        <label class="mtc-config-stack"><span class="mtc-config-label" id="mtc-settings-key-label">${esc(T('settingsKey'))}</span>
          <input type="password" class="mtc-config-input mtc-key-input" autocomplete="off" spellcheck="false" aria-labelledby="mtc-settings-key-label" placeholder="${esc(T('settingsKeyPlaceholder'))}"></label>
        <div class="mtc-settings-actions">
          <button type="button" class="mtc-request-btn" data-save-key="1">${esc(T('settingsKeySave'))}</button>
          <button type="button" class="mtc-request-btn secondary" data-test-key="1">${esc(T('settingsKeyTest'))}</button>
          <button type="button" class="mtc-request-btn danger" data-forget-key="1"${status?.source === 'file' ? '' : ' hidden'}>${esc(T('settingsKeyForget'))}</button>
        </div>
        <div class="mtc-settings-notice" role="status" aria-live="polite"></div>
        <div class="mtc-settings-hint">${esc(T('settingsKeyHint'))} <a class="mtc-link" href="https://plataforma.maritaca.ai/chaves-de-api" target="_blank" rel="noopener noreferrer">${esc(T('settingsKeys'))}</a></div>
      </section>
      <section class="mtc-settings-section" data-section="defaults">
        <h3 class="mtc-settings-section-title">${esc(T('settingsSectionDefaults'))}</h3>
        <div class="mtc-config-row"><span class="mtc-config-label" id="mtc-settings-model-label">${esc(T('settingsModel'))}</span><div class="mtc-config-control">${modelDropdown}</div></div>
        ${effortDropdown ? `<div class="mtc-config-row"><span class="mtc-config-label" id="mtc-settings-effort-label">${esc(T('settingsEffort'))}</span><div class="mtc-config-control">${effortDropdown}</div></div>` : ''}
        <div class="mtc-settings-hint">${esc(T('settingsDefaultsHint'))}</div>
      </section>
      <section class="mtc-settings-section" data-section="instructions">
        <h3 class="mtc-settings-section-title">${esc(T('settingsSectionInstructions'))}</h3>
        <label class="mtc-config-stack"><span class="mtc-config-label">${esc(T('settingsSystem'))}</span>
          <textarea class="mtc-config-input mtc-system-input" rows="4" maxlength="${Number(systemMax) || 8000}" placeholder="${esc(T('settingsSystemPlaceholder'))}">${esc(prompt)}</textarea></label>
        <div class="mtc-settings-hint mtc-system-count">${esc(T('settingsSystemCount', { count: prompt.length, max: Number(systemMax) || 8000 }))}</div>
      </section>
      <section class="mtc-settings-section" data-section="sampling">
        <h3 class="mtc-settings-section-title">${esc(T('settingsSectionSampling'))}</h3>
        <div class="mtc-config-row"><label class="mtc-config-label" for="mtc-settings-temp">${esc(T('settingsTemperature'))}</label><div class="mtc-config-control"><input type="number" id="mtc-settings-temp" class="mtc-config-input mtc-temp-input" min="0" max="2" step="0.1" inputmode="decimal" placeholder="${esc(T('settingsTemperatureDefault'))}" value="${temp}"></div></div>
        <div class="mtc-settings-hint">${esc(T('settingsTemperatureHint'))}</div>
      </section>
      <section class="mtc-settings-section" data-section="about">
        <h3 class="mtc-settings-section-title">${esc(T('settingsSectionAbout'))}</h3>
        <div class="mtc-settings-hint">${esc(T('providerNote'))}</div>
        <div class="mtc-settings-links"><a class="mtc-link" href="https://docs.maritaca.ai" target="_blank" rel="noopener noreferrer">${esc(T('settingsDocs'))}</a></div>
      </section>
    </div>
    <div class="mtc-settings-footer"><span class="mtc-settings-result" role="status" aria-live="polite"></span><button type="button" class="mtc-request-btn secondary" data-close-settings="1">${esc(T('cancel'))}</button><button type="button" class="mtc-request-btn" data-save-settings="1">${esc(T('settingsSaveDefaults'))}</button></div>`;
}

/** The footer Effort toggle's menu: Default (and what it is now), then each level with a line on what it does. */
export function effortMenuHtml(items = [], T) {
  return items.map((item) => `<button type="button" class="mtc-effort-menu-item${item.selected ? ' selected' : ''}" role="menuitemradio" aria-checked="${item.selected ? 'true' : 'false'}" data-effort-value="${esc(item.value)}"><span class="mtc-effort-menu-label">${esc(item.label)}</span><span class="mtc-effort-menu-desc">${esc(item.desc || '')}</span></button>`).join('')
    || `<div class="mtc-effort-menu-empty">${esc(T('effortUnsupportedShort'))}</div>`;
}

/**
 * The plan review under a finished plan reply (the Codex panel's post-plan card): continue with the plan, suggest
 * changes (a new plan turn), copy, dismiss. `disabled` while a reply streams or a send is on its way.
 */
export function planCardHtml({ T, row, feedback = '', disabled = false }) {
  const off = disabled ? ' disabled' : '';
  const id = `mtc-plan-feedback-${esc(row?.turnId || row?.id || 'x')}`;
  return `<div class="mtc-plan-msg" data-plan-row="${esc(row?.id || '')}"><div class="mtc-plan-card${disabled ? ' is-busy' : ''}" role="group" aria-label="${esc(T('planReview'))}" aria-busy="${disabled ? 'true' : 'false'}">`
    + `<div class="mtc-plan-header">${esc(T('planHeader'))}</div><div class="mtc-plan-note">${esc(T('planNote'))}</div>`
    + `<div class="mtc-plan-decision"><button type="button" class="mtc-request-btn" data-plan-action="continue"${off}>${esc(T('planContinue'))}</button></div>`
    + `<div class="mtc-plan-feedback-group"><label class="mtc-plan-feedback-label" for="${id}">${esc(T('planFeedbackLabel'))}</label>`
    + `<textarea id="${id}" class="mtc-plan-feedback" rows="2" maxlength="4000" placeholder="${esc(T('planFeedbackPlaceholder'))}"${off}>${esc(feedback)}</textarea>`
    + `<div class="mtc-plan-feedback-footer"><span class="mtc-plan-feedback-hint">${esc(T('planFeedbackHint'))}</span><button type="button" class="mtc-request-btn secondary mtc-plan-update" data-plan-action="feedback"${disabled || !String(feedback).trim() ? ' disabled' : ''}>${esc(T('planUpdate'))}</button></div></div>`
    + `<div class="mtc-plan-utilities"><button type="button" class="mtc-request-btn secondary" data-plan-action="copy">${esc(T('planCopy'))}</button><button type="button" class="mtc-request-btn secondary" data-plan-action="dismiss"${off}>${esc(T('planDismiss'))}</button></div>`
    + '</div></div>';
}

/**
 * The header cog's Context settings popover (contextMenuModel() in mtc-logic.js), in the sibling panels' grammar:
 * sections with a 28px head (title, at most one action) and 28px rows (label left, value right).
 */
export function contextPopHtml(m, { T, copied = false } = {}) {
  const muted = (v) => v === T('ctxNotReported') || v === '—';
  const row = (k, v, { cls = '', tip = '' } = {}) => `<div class="mtc-ctxpop-row"><span class="mtc-ctxpop-k">${esc(k)}</span><span class="mtc-ctxpop-v${muted(v) ? ' mtc-ctxpop-muted' : ''}${cls}"${tip ? ` title="${esc(tip)}"` : ''}>${esc(v)}</span></div>`;
  const status = (k, s) => `<div class="mtc-ctxpop-row"><span class="mtc-ctxpop-k">${esc(k)}</span><span class="mtc-ctxpop-v mtc-ctxpop-status"><span class="mtc-ctxpop-dot mtc-ctxpop-dot-${esc(s.tone)}" aria-hidden="true"></span><span>${esc(s.word)}</span></span></div>`;
  const head = (title, act = '') => `<div class="mtc-ctxpop-head"><h3 class="mtc-ctxpop-title">${esc(title)}</h3>${act}</div>`;
  const pct = m.context.pct == null ? 0 : m.context.pct;
  const ctx = `<section class="mtc-ctxpop-section">${head(T('ctxSectionContext'))}`
    + `<div class="mtc-ctxpop-bar" role="progressbar" aria-label="${esc(T('ctxMeterLabel'))}" aria-valuemin="0" aria-valuemax="100"${m.context.pct != null ? ` aria-valuenow="${Math.round(pct)}"` : ''} aria-valuetext="${esc(m.context.headline)}"><div class="mtc-ctxpop-fill${m.pressure ? ` mtc-ctxpop-${esc(m.pressure)}` : ''}" style="width:${Math.max(0, Math.min(100, pct))}%"></div></div>`
    + `<div class="mtc-ctxpop-usage" title="${esc(m.context.headline)}"><span class="mtc-ctxpop-used${muted(m.context.usage) ? ' mtc-ctxpop-muted' : ''}">${esc(m.context.usage)}</span>${m.context.share ? `<span class="mtc-ctxpop-share">${esc(m.context.share)}</span>` : ''}</div>`
    + m.context.rows.map(([k, v]) => row(k, v)).join('') + '</section>';
  const settingsLink = `<button type="button" class="mtc-ctxpop-link" data-act="settings" aria-label="${esc(T('ctxSettingsName'))}">${esc(T('ctxSettings'))}</button>`;
  const idRow = m.conversation.id
    ? `<div class="mtc-ctxpop-row"><span class="mtc-ctxpop-k">${esc(T('ctxConversationId'))}</span><button type="button" class="mtc-ctxpop-v mtc-ctxpop-copy${copied ? ' mtc-ctxpop-copied' : ''}" data-act="copy-id" data-value="${esc(m.conversation.id)}" aria-label="${esc(T('ctxCopyId'))}" title="${esc(m.conversation.id)}">${esc(copied ? T('ctxCopied') : m.conversation.id)}</button></div>`
    : row(T('ctxConversationId'), T('ctxNotStarted'), { cls: ' mtc-ctxpop-muted' });
  const conv = `<section class="mtc-ctxpop-section">${head(T('ctxSectionConversation'), settingsLink)}${idRow}${m.conversation.rows.map(([k, v]) => row(k, v)).join('')}</section>`;
  const conn = `<section class="mtc-ctxpop-section">${head(T('ctxSectionConnection'))}${status(T('ctxKey'), m.connection.key)}${status(T('ctxServer'), m.connection.server)}</section>`;
  return ctx + conv + conn;
}
/** The conversations popover: a search box and the list. */
export function sessionsHtml({ T, sessions, loading = false, error = null, activeId = null, deletePending = null }) {
  const list = loading ? `<div class="mtc-pop-note">${esc(T('sessionsLoading'))}</div>`
    : error ? `<div class="mtc-pop-note error">${esc(T('sessionsFailed', { error }))}</div>`
      : !sessions.length ? `<div class="mtc-pop-note">${esc(T('sessionsEmpty'))}</div>`
        : sessions.map((s) => `<div class="mtc-session-row${s.id === activeId ? ' active' : ''}" role="option" aria-selected="${s.id === activeId}" tabindex="0" data-session="${esc(s.id)}">`
          + `<span class="mtc-session-title">${esc(s.title || T('tabTitleFallback'))}</span><span class="mtc-session-meta">${esc([s.model, s.costBrl != null ? T('costBrl', { value: Number(s.costBrl).toFixed(4).replace('.', ',') }) : '', s.messageCount ? `${s.messageCount}` : ''].filter(Boolean).join(' · '))}</span>`
          + `<button type="button" class="mtc-icon-btn mtc-session-delete" data-delete-session="${esc(s.id)}" aria-label="${esc(T('delete'))}" title="${esc(T('delete'))}">&times;</button>${deletePending === s.id ? `<span class="mtc-delete-confirm" role="alert">${esc(T('deleteConfirm', { title: s.title || T('tabTitleFallback') }))}<button type="button" class="mtc-action" data-confirm-delete="${esc(s.id)}">${esc(T('delete'))}</button><button type="button" class="mtc-action" data-cancel-delete>${esc(T('cancel'))}</button></span>` : ''}</div>`).join('');
  return `<input type="search" class="mtc-session-search" placeholder="${esc(T('sessionsSearch'))}" aria-label="${esc(T('sessionsSearch'))}"><div class="mtc-session-list" role="listbox" aria-label="${esc(T('sessions'))}">${list}</div>`;
}
