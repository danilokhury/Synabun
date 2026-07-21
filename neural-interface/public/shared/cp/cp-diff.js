// ── Diff cards for Edit / MultiEdit / Write / NotebookEdit ──
// Renders CLI-style unified diffs with +/− stats. buildDiffPreviewEl is shared
// with the permission cards (cp-permissions.js) so the approval prompt shows
// the exact change before it executes.

import { cpCtx } from './cp-ctx.js';

const MAX_DIFF_LINES = 400;   // per side, beyond this fall back to stacked view
const MAX_WRITE_PREVIEW = 200;

// Simple line-level LCS diff. Returns [{kind:'ctx'|'add'|'del', text}].
export function cpLineDiff(oldStr, newStr) {
  const a = String(oldStr ?? '').split('\n');
  const b = String(newStr ?? '').split('\n');
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    // Stacked fallback, capped — a full LCS on huge inputs is wasted DOM anyway
    const CAP = 120;
    const out = a.slice(0, CAP).map(text => ({ kind: 'del', text }));
    if (a.length > CAP) out.push({ kind: 'gap', text: `… ${a.length - CAP} more removed lines` });
    out.push(...b.slice(0, CAP).map(text => ({ kind: 'add', text })));
    if (b.length > CAP) out.push({ kind: 'gap', text: `… ${b.length - CAP} more added lines` });
    return out;
  }
  // LCS table
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: 'ctx', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ kind: 'del', text: a[i] }); i++; }
    else { out.push({ kind: 'add', text: b[j] }); j++; }
  }
  while (i < n) { out.push({ kind: 'del', text: a[i] }); i++; }
  while (j < m) { out.push({ kind: 'add', text: b[j] }); j++; }
  return out;
}

// Collapse long ctx runs to 2 lines of context around changes (CLI-style).
function condenseDiff(lines) {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, idx) => {
    if (l.kind !== 'ctx') {
      for (let k = Math.max(0, idx - 2); k <= Math.min(lines.length - 1, idx + 2); k++) keep[k] = true;
    }
  });
  const out = [];
  let skipped = 0;
  lines.forEach((l, idx) => {
    if (keep[idx]) {
      if (skipped > 0) { out.push({ kind: 'gap', text: `… ${skipped} unchanged line${skipped === 1 ? '' : 's'}` }); skipped = 0; }
      out.push(l);
    } else skipped++;
  });
  if (skipped > 0) out.push({ kind: 'gap', text: `… ${skipped} unchanged line${skipped === 1 ? '' : 's'}` });
  return out;
}

export function cpDiffStats(lines) {
  let add = 0, del = 0;
  for (const l of lines) {
    if (l.kind === 'add') add++;
    else if (l.kind === 'del') del++;
  }
  return { add, del };
}

function renderDiffLines(lines) {
  const wrap = document.createElement('div');
  wrap.className = 'cp-diff';
  for (const l of lines) {
    const row = document.createElement('div');
    row.className = `cp-diff-line cp-diff-${l.kind}`;
    const gutter = document.createElement('span');
    gutter.className = 'cp-diff-gutter';
    gutter.textContent = l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ';
    const text = document.createElement('span');
    text.className = 'cp-diff-text';
    text.textContent = l.text;
    row.append(gutter, text);
    wrap.appendChild(row);
  }
  return wrap;
}

function statsEl({ add, del }) {
  const el = document.createElement('span');
  el.className = 'cp-diff-stats';
  el.innerHTML = `${add ? `<span class="cp-diff-stat-add">+${add}</span>` : ''}${del ? `<span class="cp-diff-stat-del">−${del}</span>` : ''}`;
  return el;
}

// Compute the diff content + stats for a tool input. Used by both the tool
// card and the permission preview.
function diffForInput(input, toolName) {
  const i = input || {};
  if (toolName === 'Write') {
    const lines = String(i.content ?? '').split('\n');
    const shown = lines.slice(0, MAX_WRITE_PREVIEW).map(text => ({ kind: 'add', text }));
    if (lines.length > MAX_WRITE_PREVIEW) shown.push({ kind: 'gap', text: `… ${lines.length - MAX_WRITE_PREVIEW} more lines` });
    return { sections: [{ lines: shown, label: null }], stats: { add: lines.length, del: 0 }, badge: 'new file' };
  }
  if (toolName === 'MultiEdit' && Array.isArray(i.edits)) {
    const sections = i.edits.map((e, idx) => {
      const lines = condenseDiff(cpLineDiff(e.old_string, e.new_string));
      return { lines, label: i.edits.length > 1 ? `edit ${idx + 1}/${i.edits.length}` : null };
    });
    const total = { add: 0, del: 0 };
    for (const s of sections) { const st = cpDiffStats(s.lines); total.add += st.add; total.del += st.del; }
    return { sections, stats: total, badge: null };
  }
  if (toolName === 'NotebookEdit') {
    const lines = String(i.new_source ?? '').split('\n').map(text => ({ kind: 'add', text }));
    return { sections: [{ lines, label: `cell ${i.cell_id ?? ''}` }], stats: { add: lines.length, del: 0 }, badge: i.edit_mode || null };
  }
  // Edit
  const lines = condenseDiff(cpLineDiff(i.old_string, i.new_string));
  return { sections: [{ lines, label: null }], stats: cpDiffStats(lines), badge: null };
}

// Bare diff preview (no tool-card chrome) — embedded inside permission cards.
export function buildDiffPreviewEl(input, toolName) {
  const { sections, stats, badge } = diffForInput(input, toolName);
  const box = document.createElement('div');
  box.className = 'cp-diff-preview';
  const head = document.createElement('div');
  head.className = 'cp-diff-preview-head';
  const path = document.createElement('span');
  path.className = 'cp-diff-path';
  path.textContent = input?.file_path || input?.notebook_path || '';
  head.appendChild(path);
  if (badge) {
    const b = document.createElement('span');
    b.className = 'cp-diff-badge';
    b.textContent = badge;
    head.appendChild(b);
  }
  head.appendChild(statsEl(stats));
  box.appendChild(head);
  for (const s of sections) {
    if (s.label) {
      const lbl = document.createElement('div');
      lbl.className = 'cp-diff-section-label';
      lbl.textContent = s.label;
      box.appendChild(lbl);
    }
    box.appendChild(renderDiffLines(s.lines));
  }
  return box;
}

// Full tool card with diff body. Mirrors the generic tool-card DOM contract
// (.tool-card with data-tool-id / data-tool-name, .tool-hdr toggles .open,
// hidden RESULT section that updateToolResult() can populate on error).
export function buildDiffCard(block, tab) {
  const { toolIconSvg, linkifyFilePaths } = cpCtx;
  const i = block.input || {};
  const { sections, stats, badge } = diffForInput(i, block.name);

  const card = document.createElement('div');
  card.className = 'tool-card cp-diff-card open'; // open while running — CLI shows diffs inline
  card.dataset.toolId = block.id || '';
  card.dataset.toolName = block.name;

  const hdr = document.createElement('div');
  hdr.className = 'tool-hdr';
  const icon = document.createElement('span'); icon.className = 'tool-icon';
  icon.innerHTML = toolIconSvg(block.name);
  const name = document.createElement('span'); name.className = 'tool-name'; name.textContent = block.name;
  const detail = document.createElement('span'); detail.className = 'tool-detail';
  detail.textContent = (i.file_path || i.notebook_path || '').split(/[/\\]/).pop() || '';
  hdr.append(icon, name, detail);
  if (badge) {
    const b = document.createElement('span');
    b.className = 'cp-diff-badge';
    b.textContent = badge;
    hdr.appendChild(b);
  }
  hdr.appendChild(statsEl(stats));
  const chevron = document.createElement('span'); chevron.className = 'tool-chevron'; chevron.innerHTML = '&#x203A;';
  hdr.appendChild(chevron);
  hdr.addEventListener('click', () => card.classList.toggle('open'));

  const body = document.createElement('div');
  body.className = 'tool-body';
  const pathEl = document.createElement('div');
  pathEl.className = 'cp-diff-path';
  pathEl.textContent = i.file_path || i.notebook_path || '';
  body.appendChild(pathEl);
  try { linkifyFilePaths(pathEl); } catch {}
  for (const s of sections) {
    if (s.label) {
      const lbl = document.createElement('div');
      lbl.className = 'cp-diff-section-label';
      lbl.textContent = s.label;
      body.appendChild(lbl);
    }
    body.appendChild(renderDiffLines(s.lines));
  }
  // Hidden RESULT section — updateToolResult() populates it (errors mostly)
  const rLbl = document.createElement('div'); rLbl.className = 'tool-section-label tool-result-label'; rLbl.textContent = 'RESULT'; rLbl.hidden = true;
  const rSec = document.createElement('div'); rSec.className = 'tool-section tool-result-content'; rSec.hidden = true;
  body.append(rLbl, rSec);
  card.append(hdr, body);
  return card;
}

// Called from updateToolResult for cp-diff-card: collapse on success, keep
// open + error styling on failure.
export function finalizeDiffCard(card, ev) {
  if (ev.is_error) {
    card.classList.add('tool-error');
    card.classList.add('open');
  } else {
    card.classList.add('tool-ok');
    card.classList.remove('open');
  }
}
