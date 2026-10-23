// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio 2.0: a difference, drawn
// ═══════════════════════════════════════════
//
// The rows of sx-diff.js as a unified diff: one block per file (its status, lines added and removed, a note when
// it is binary or too large to compare line by line), each hunk with both line numbers. Added and removed lines are
// marked by a sign and a word for screen readers, not by colour alone. Every line is text.

import { html, ICONS, plural } from './sx-dom.js';

const SIGN = { '+': '+', '-': '−', ' ': ' ' };

function rowsHTML(t, rows) {
  return rows.map((r) => html`<tr class="sx-diff-row sx-diff-row--${r.t === '+' ? 'add' : r.t === '-' ? 'del' : 'ctx'}">
    <td class="sx-diff-num">${r.a ?? ''}</td><td class="sx-diff-num">${r.b ?? ''}</td>
    <td class="sx-diff-sign"><span aria-hidden="true">${SIGN[r.t]}</span><span class="sx-sr">${r.t === '+' ? t('skillsStudio.diff.added') : r.t === '-' ? t('skillsStudio.diff.removed') : ''}</span></td>
    <td class="sx-diff-text">${r.text}</td></tr>`);
}

/**
 * @param {Function} t
 * @param {{ files: { path, status, hunks: { header, rows }[], added, removed, note }[], same?: boolean, unchanged?: number }} model
 * @param {{ open?: number }} [o] how many files start expanded
 */
export function diffHTML(t, model, { open = 3 } = {}) {
  if (!model || model.same || !model.files?.length) return html`<p class="sx-help">${t('skillsStudio.diff.same')}</p>`;
  return html`<div class="sx-diff">${model.files.map((f, i) => html`<details class="sx-diff-file"${i < open ? ' open' : ''}>
    <summary><span class="sx-diff-status sx-diff-status--${f.status}">${t(`skillsStudio.diff.status.${f.status}`)}</span><span class="sx-diff-path">${f.path}</span>
      ${f.added || f.removed ? html`<span class="sx-diff-counts"><span class="sx-diff-plus">+${f.added}</span> <span class="sx-diff-minus">−${f.removed}</span></span>` : ''}</summary>
    ${f.eol ? html`<p class="sx-help">${t('skillsStudio.diff.eol', { from: f.eol.from.toUpperCase(), to: f.eol.to.toUpperCase() })}</p>` : ''}
    ${f.note ? html`<p class="sx-help">${t(`skillsStudio.diff.note.${f.note === 'binary' ? 'binary' : f.note.startsWith('too large') ? 'large' : 'far'}`)}</p>` : ''}
    ${(f.hunks || []).map((h) => html`<table class="sx-diff-hunk"><caption class="sx-diff-head">${h.header}</caption><tbody>${rowsHTML(t, h.rows)}</tbody></table>`)}
  </details>`)}
  ${model.unchanged ? html`<p class="sx-help">${plural(t, 'skillsStudio.diff.unchanged', model.unchanged)}</p>` : ''}</div>`;
}

/** A text's diff (lineDiff) as a one-file model for diffHTML. */
export function textDiffModel(path, diff) {
  if (diff.same) return { same: true, files: [] };
  return { files: [{ path, status: 'modified', hunks: diff.hunks, added: diff.added, removed: diff.removed, note: diff.tooFar ? 'too different to compare line by line' : null }] };
}

export const DIFF_ICON = ICONS.code;
