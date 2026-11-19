// ═══════════════════════════════════════════
// SynaBun Neural Interface — Agents Studio: the markup its views share
// ═══════════════════════════════════════════
//
// The pieces more than one view draws: an agent's mark (its icon on its colour), the status and scope labels, a
// form field with its note, the app's dropdown as a field, a diff (field rows, the instructions as hunks, the
// privilege delta), the privilege summary, the loading / empty / error states, and the words the pure modules ask
// for. Everything goes through the Studio's escaping `html` (skills/studio/sx-dom.js): a name, a description, a
// path or a server's message is text, never markup. The dropdown is the app's `.cc-dropdown`; no view writes a
// native one.

import { html, raw, ICONS, relativeTime, fullTime } from '../../skills/studio/sx-dom.js';
import { dropdownHTML } from '../../cc-dropdown.js';
import { agentIcon, toneOf, AX_ICONS } from './ax-icons.js';
import { standingOf, scopeLabel, authorKind } from './ax-library.js';
import { diffRows, hunksOf, privilegeChanges, privilegeSummary, diffSize } from './ax-diff.js';

/** The words the pure modules take (ax-diff.js valueText): the page's strings for values. */
export function wordsOf(t, { projects = [], profiles = [] } = {}) {
  const or = (key, fallback) => { const said = t(key); return said === key ? fallback : said; };
  return {
    yes: t('agentsStudio.value.yes'), no: t('agentsStudio.value.no'), none: t('agentsStudio.value.none'),
    defaultTools: t('agentsStudio.value.defaultTools'), alwaysOn: t('agentsStudio.value.alwaysOn'), allTools: t('agentsStudio.value.allTools'),
    allServers: t('agentsStudio.value.allServers'), global: t('agentsStudio.scope.global'), project: t('agentsStudio.scope.project'),
    capability: (level) => or(`agentsStudio.capability.${level}.name`, level),
    policy: (id) => or(`agentsStudio.policy.${id}.name`, id),
    taskClass: (id) => or(`agentsStudio.taskClass.${id}`, id),
    provider: (id) => or(`agentsStudio.provider.${id}`, id),
    projects, profiles,
  };
}

/** A word of a family, or the value as written when the family has no word for it (a state from a newer server). */
export function wordOr(t, family, value) {
  const key = `${family}.${value}`;
  const said = t(key);
  return said === key ? String(value ?? '') : said;
}

/** An agent's mark: its icon on its colour token's tone. */
export function agentMark(agent, size = 18) {
  return html`<span class="ax-mark ax-tone--${toneOf(agent?.color)}" aria-hidden="true">${agentIcon(agent?.icon, size)}</span>`;
}

export function statusLabel(t, status) {
  return html`<span class="sx-label ax-status ax-status--${status}">${wordOr(t, 'agentsStudio.status', status)}</span>`;
}

/** The labels of where an agent stands: its status with the revision, and a working revision on top of it. */
export function standingLabels(t, agent) {
  const s = standingOf(agent);
  return html`${agent.source === 'builtin' ? html`<span class="sx-chip ax-chip" title="${t('agentsStudio.builtinHelp')}">${t('agentsStudio.builtin')}</span>` : ''}${statusLabel(t, s.status)}${s.revision ? html`<span class="ax-rev">${t('agentsStudio.revisionShort', { n: s.revision })}</span>` : ''}${s.pending ? html`<span class="sx-label ax-status ax-status--${s.pending}">${t(`agentsStudio.pending.${s.pending}`, { n: s.draftRevision ?? '' })}</span>` : ''}${s.damaged ? html`<span class="sx-label ax-status ax-status--damaged" title="${t('agentsStudio.damagedHelp')}">${t('agentsStudio.damaged')}</span>` : ''}`;
}

export function scopeTag(t, scope, projects = []) {
  const project = scope?.kind === 'project';
  return html`<span class="sx-tag ax-scope" title="${project ? scope.path : t('agentsStudio.scope.globalHelp')}">${project ? AX_ICONS.pin : AX_ICONS.global}<span>${scopeLabel(scope, projects, t('agentsStudio.scope.global'))}</span></span>`;
}

/** "3 min ago" with the full date as its title; '' for nothing. */
export function timeTag(iso, locale) {
  const said = relativeTime(iso, locale);
  return said ? html`<time datetime="${iso}" title="${fullTime(iso, locale)}">${said}</time>` : '';
}

/** Who made a revision. */
export const authorText = (t, author) => t(`agentsStudio.author.${authorKind(author)}`);

/** A field: its label (with an optional count), its control, and the place its problems are written. */
export function field({ id, label, control, help = '', count = null, field: name = '', wide = false, required = false }) {
  return html`<div class="sx-field ax-field${wide ? ' ax-field--wide' : ''}"${name ? html` data-field="${name}"` : ''}>
    <span class="sx-field-label" id="${id}-label"><span>${label}${required ? html`<span class="ax-required" aria-hidden="true"> *</span>` : ''}</span>${count !== null ? html`<span class="sx-count" data-count-for="${name}">${count}</span>` : ''}</span>
    ${control}
    ${help ? html`<p class="sx-field-note" id="${id}-help">${help}</p>` : ''}
    ${name ? html`<div class="ax-issues" data-issues-for="${name}" id="${id}-issues" role="status"></div>` : ''}
  </div>`;
}

/** The app's dropdown as markup for `html` (the hidden input has `id`; its change event bubbles). */
export function dropdown(id, entries, { labelledBy = '', label = '', multiple = false, summary = '', disabled = false, field: name = '', classes = '' } = {}) {
  return raw(dropdownHTML(id, entries, { labelledBy, label, multiple, summary, disabled, fitTrigger: !!name, classes: `sx-dd ${classes}`.trim(), inputAttrs: name ? `data-form-field="${name}"` : '' }));
}

/** The problems of one field, as the lines under it. */
export function issuesHTML(found) {
  if (!found || (!found.errors.length && !found.warnings.length)) return '';
  return html`${found.errors.map((issue) => html`<p class="sx-field-note sx-err-text">${ICONS.err}<span>${issue.message}</span></p>`)}${found.warnings.map((issue) => html`<p class="sx-field-note sx-warn-text">${ICONS.warn}<span>${issue.message}</span></p>`)}`;
}

// ── States ──

export function loadingHTML(t, text = null) {
  return html`<div class="sx-empty ax-state" role="status" aria-busy="true"><span class="ax-spinner" aria-hidden="true"></span><p>${text || t('agentsStudio.state.loading')}</p></div>`;
}

export function errorHTML(t, error, { retry = true } = {}) {
  return html`<div class="sx-empty ax-state" role="alert">
    <span class="sx-placeholder-icon ax-state-icon ax-state-icon--err">${ICONS.err}</span>
    <h3 class="sx-empty-title" tabindex="-1" data-autofocus>${t('agentsStudio.state.failedTitle')}</h3>
    <p>${errorText(t, error)}</p>
    ${retry ? html`<button type="button" class="sx-btn" data-act="retry">${t('agentsStudio.state.retry')}</button>` : ''}
  </div>`;
}

export function emptyHTML({ icon = ICONS.info, title, lines = [], actions = '' }) {
  return html`<div class="sx-empty ax-state">
    <span class="sx-placeholder-icon ax-state-icon">${icon}</span>
    <h3 class="sx-empty-title" tabindex="-1" data-autofocus>${title}</h3>
    ${lines.map((line) => html`<p>${line}</p>`)}
    ${actions ? html`<div class="sx-row ax-state-actions">${actions}</div>` : ''}
  </div>`;
}

/** What an error says to the owner: the server's sentence, or the page's own for what it knows. */
export function errorText(t, error) {
  const code = error?.code;
  if (code === 'WORKER_BROWSER') return t('agentsStudio.error.automationBrowser');
  if (code === 'PEER_UNAVAILABLE') return t('agentsStudio.error.peerUnavailable');
  if (error?.status === 403 && (code === 'GUEST_FORBIDDEN' || code === 'UI_ONLY' || code === 'PAGE_SECRET_REQUIRED' || code === 'OWNER_ROUTE' || code === 'PEER_REFUSED')) return t('agentsStudio.error.ownerOnly');
  if (code === 'not_json' || error?.absent) return t('agentsStudio.error.olderServer');
  if (error?.name === 'TypeError' || /failed to fetch|networkerror|load failed/i.test(String(error?.message || ''))) return t('agentsStudio.error.network');
  return String(error?.message || error || t('agentsStudio.error.unknown'));
}

// ── Diff ──

/** The instructions' line diff, the unchanged middle folded. */
function hunksHTML(t, lines) {
  if (!lines) return html`<p class="sx-help">${t('agentsStudio.diff.tooLong')}</p>`;
  const hunks = hunksOf(lines, 2);
  return html`<table class="sx-diff-hunk ax-hunks"><tbody>${hunks.map((row) => (row.gap
    ? html`<tr class="ax-diff-gap"><td class="sx-diff-num" colspan="2"></td><td class="sx-diff-sign"></td><td class="sx-diff-text">${t(row.gap === 1 ? 'agentsStudio.diff.unchangedOne' : 'agentsStudio.diff.unchanged', { count: row.gap })}</td></tr>`
    : html`<tr class="${row.op === '+' ? 'sx-diff-row--add' : row.op === '-' ? 'sx-diff-row--del' : ''}"><td class="sx-diff-num">${row.oldNo ?? ''}</td><td class="sx-diff-num">${row.newNo ?? ''}</td><td class="sx-diff-sign">${row.op === ' ' ? '' : row.op}<span class="sx-sr">${row.op === '+' ? t('agentsStudio.diff.added') : row.op === '-' ? t('agentsStudio.diff.removed') : ''}</span></td><td class="sx-diff-text">${row.line}</td></tr>`))}</tbody></table>`;
}

/**
 * A diff as the registry answers it: which revisions, the privilege delta first (what the newer one may newly do),
 * then every changed field, the instructions last.
 */
export function diffHTML(t, diff, words, { open = true } = {}) {
  if (!diff) return '';
  const rows = diffRows(diff, words);
  const size = diffSize(diff);
  const delta = privilegeChanges(diff.privileges, words);
  const first = !diff.from;
  const head = first
    ? t('agentsStudio.diff.first', { to: diff.to?.revision ?? '' })
    : t('agentsStudio.diff.between', { from: diff.from.revision, to: diff.to?.revision ?? '' });
  if (!diff.changed && !first) return html`<div class="ax-diff"><p class="ax-diff-head">${head}</p><p class="sx-note">${t('agentsStudio.diff.same')}</p></div>`;
  return html`<div class="ax-diff">
    <p class="ax-diff-head">${head}<span class="ax-diff-size">${t('agentsStudio.diff.size', { fields: size.fields })}${size.added || size.removed ? html` · <span class="sx-diff-plus">+${size.added}</span> <span class="sx-diff-minus">−${size.removed}</span>` : ''}</span></p>
    ${delta.length ? html`<div class="ax-delta${diff.privileges?.escalates ? ' ax-delta--wider' : ''}" role="group" aria-label="${t('agentsStudio.privilege.deltaTitle')}">
      <p class="ax-delta-title">${diff.privileges?.escalates ? html`${AX_ICONS.wider}<span>${t('agentsStudio.privilege.wider')}</span>` : html`${ICONS.ok}<span>${t('agentsStudio.privilege.notWider')}</span>`}</p>
      <ul class="ax-delta-list">${delta.map((row) => html`<li class="${row.escalates ? 'is-wider' : ''}"><span class="ax-delta-field">${t(`agentsStudio.field.${row.field}`)}</span><span class="ax-delta-from">${row.from}</span><span aria-hidden="true">→</span><span class="ax-delta-to">${row.to}</span>${row.escalates ? html`<span class="sx-label ax-wider">${t('agentsStudio.privilege.widerTag')}</span>` : ''}</li>`)}</ul>
    </div>` : ''}
    ${rows.length ? html`<div class="ax-changes">${rows.map((row) => (row.kind === 'instructions'
    ? html`<details class="sx-diff-file ax-change"${open ? html` open` : ''}><summary><span class="sx-diff-path">${t('agentsStudio.field.instructions')}</span><span class="sx-diff-counts"><span class="sx-diff-plus">+${row.added ?? 0}</span> <span class="sx-diff-minus">−${row.removed ?? 0}</span></span></summary>${hunksHTML(t, row.lines)}</details>`
    : html`<div class="ax-change ax-change--value"><span class="ax-change-field">${t(`agentsStudio.field.${row.field}`)}</span>
        ${row.kind === 'list' ? html`<span class="ax-change-list">${row.removed.map((item) => html`<span class="ax-pill ax-pill--del">− ${item}</span>`)}${row.added.map((item) => html`<span class="ax-pill ax-pill--add">+ ${item}</span>`)}</span>`
    : html`<span class="ax-change-from">${row.from}</span><span aria-hidden="true">→</span><span class="ax-change-to">${row.to}</span>`}</div>`))}</div>` : ''}
  </div>`;
}

/** The privilege summary: what this agent may do, with what changed against the last approved revision marked. */
export function privilegeHTML(t, definition, approved, delta, words) {
  const rows = privilegeSummary(definition, approved, delta, words);
  const icon = { capability: ICONS.lock, permissionPolicy: ICONS.review, tools: ICONS.code, mcpServers: AX_ICONS.server, usesBrowser: AX_ICONS.browser, moreloginProfile: AX_ICONS.browser, usesComputer: AX_ICONS.computer, skills: ICONS.spark, scope: AX_ICONS.global };
  return html`<dl class="ax-priv">${rows.map((row) => html`<div class="ax-priv-row${row.changed ? ' is-changed' : ''}${row.escalates ? ' is-wider' : ''}">
    <dt>${icon[row.field] || ICONS.info}<span>${t(`agentsStudio.field.${row.field}`)}</span></dt>
    <dd><span class="ax-priv-value">${row.text}</span>${row.changed ? html`<span class="ax-priv-was">${t('agentsStudio.privilege.was', { value: row.was })}</span>` : ''}${row.escalates ? html`<span class="sx-label ax-wider">${t('agentsStudio.privilege.widerTag')}</span>` : row.changed ? html`<span class="sx-label ax-changed">${t('agentsStudio.privilege.changedTag')}</span>` : ''}</dd>
  </div>`)}</dl>`;
}

// ── Files ──

/** Save text as a file the browser downloads. */
export function downloadText(fileName, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** The text of a picked file (bounded: an agent file or a bundle is small). */
export async function readFileText(file, maxBytes = 2 * 1024 * 1024) {
  if (!file) throw new Error('no file');
  if (file.size > maxBytes) { const error = new Error('too large'); error.code = 'file_too_large'; throw error; }
  return file.text();
}
