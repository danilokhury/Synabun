// ── Real permission cards + plan approval (SDK engine) ──
//
// With the SDK bridge, control_requests arrive BEFORE the tool executes
// (canUseTool pauses the agent). These cards therefore actually gate execution:
// Allow/Deny resolves the server-side promise; Deny no longer kills anything —
// the agent sees the denial in-band and adapts.

import { cpCtx } from './cp-ctx.js';
import { buildDiffPreviewEl } from './cp-diff.js';

const ICON_CHECK = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.5 3.5 6.5-7"/></svg>';
const ICON_X = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>';

export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
export const MODE_LABELS = {
  default: 'Default',
  acceptEdits: 'Accept Edits',
  plan: 'Plan',
  bypassPermissions: 'Bypass',
};

// Human-readable rule for a PermissionUpdate suggestion object.
export function describeSuggestion(s) {
  if (!s || typeof s !== 'object') return '';
  try {
    if (s.type === 'addRules' && Array.isArray(s.rules)) {
      const rules = s.rules.map(r => r?.toolName ? `${r.toolName}${r.ruleContent ? `(${r.ruleContent})` : ''}` : '').filter(Boolean).join(', ');
      return `Always allow ${rules}${s.destination ? ` — ${s.destination}` : ''}`;
    }
    if (s.type === 'setMode' && s.mode) return `Switch permission mode to ${MODE_LABELS[s.mode] || s.mode}`;
    if (s.type === 'addDirectories' && Array.isArray(s.directories)) return `Allow access to ${s.directories.join(', ')}`;
    return JSON.stringify(s).slice(0, 120);
  } catch { return ''; }
}

function buildPreview(toolName, input) {
  const { esc } = cpCtx;
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
    try { return { el: buildDiffPreviewEl(input, toolName), bashInput: null }; } catch { /* fall through */ }
  }
  if (toolName === 'Bash') {
    const box = document.createElement('div');
    box.className = 'cp-perm-preview';
    const lbl = document.createElement('div');
    lbl.className = 'cp-perm-preview-label';
    lbl.textContent = 'Command (editable)';
    const ta = document.createElement('textarea');
    ta.className = 'cp-perm-cmd-edit';
    ta.value = input?.command || '';
    ta.rows = Math.min(6, Math.max(2, (input?.command || '').split('\n').length));
    ta.spellcheck = false;
    box.append(lbl, ta);
    if (input?.description) {
      const d = document.createElement('div');
      d.className = 'cp-bash-desc';
      d.textContent = input.description;
      box.appendChild(d);
    }
    return { el: box, bashInput: ta };
  }
  const keys = Object.keys(input || {});
  if (!keys.length) return { el: null, bashInput: null };
  const box = document.createElement('div');
  box.className = 'cp-perm-preview';
  const kv = document.createElement('div');
  kv.className = 'cp-perm-kv';
  for (const k of keys.slice(0, 8)) {
    let v = input[k];
    if (typeof v === 'object') { try { v = JSON.stringify(v); } catch { v = String(v); } }
    v = String(v ?? '');
    const row = document.createElement('div');
    row.className = 'cp-perm-kv-row';
    row.innerHTML = `<span class="cp-perm-kv-key">${esc(k)}</span><span class="cp-perm-kv-val">${esc(v.length > 200 ? v.slice(0, 200) + '…' : v)}</span>`;
    kv.appendChild(row);
  }
  box.appendChild(kv);
  return { el: box, bashInput: null };
}

// renderPermissionCard(tab, requestId, req, hooks)
// hooks: { sendResponse(requestId, inner), onResolved(behavior, always), toolIconSvg, autoAllow(toolName) }
export function renderPermissionCard(tab, requestId, req, hooks) {
  const { toolIconSvg, scrollEnd, activeTab } = cpCtx;
  const $msgs = tab.messagesEl;
  if (!$msgs) return;

  const toolName = req.tool_name || 'Unknown';
  const input = req.input || {};
  const suggestions = Array.isArray(req.suggestions) ? req.suggestions : [];

  const el = document.createElement('div');
  el.className = 'msg msg-assistant';
  const wrap = document.createElement('div');
  wrap.className = 'msg-content';

  const card = document.createElement('div');
  card.className = 'perm-card active-perm cp-perm-card';
  card.dataset.requestId = requestId;

  const hdr = document.createElement('div');
  hdr.className = 'perm-header';
  hdr.textContent = 'PERMISSION REQUIRED';
  card.appendChild(hdr);

  const toolLine = document.createElement('div');
  toolLine.className = 'perm-tool-line';
  const icon = document.createElement('span');
  icon.className = 'perm-tool-icon';
  icon.innerHTML = toolIconSvg(toolName);
  const name = document.createElement('span');
  name.className = 'perm-tool-name';
  name.textContent = toolName;
  toolLine.append(icon, name);
  card.appendChild(toolLine);

  const { el: previewEl, bashInput } = buildPreview(toolName, input);
  if (previewEl) card.appendChild(previewEl);

  // Suggestion checkboxes (PermissionUpdate rules offered by the CLI)
  const checkedSuggestions = new Set();
  if (suggestions.length) {
    const sugBox = document.createElement('div');
    sugBox.className = 'cp-perm-suggestions';
    suggestions.forEach((s, idx) => {
      const text = describeSuggestion(s);
      if (!text) return;
      const row = document.createElement('label');
      row.className = 'cp-perm-suggestion';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.addEventListener('change', () => { cb.checked ? checkedSuggestions.add(idx) : checkedSuggestions.delete(idx); });
      const span = document.createElement('span');
      span.textContent = text;
      row.append(cb, span);
      sugBox.appendChild(row);
    });
    if (sugBox.children.length) card.appendChild(sugBox);
  }

  // Deny reason (collapsed until first Deny hover)
  const denyMsg = document.createElement('textarea');
  denyMsg.className = 'cp-perm-deny-msg';
  denyMsg.placeholder = 'Tell Claude why (optional)…';
  denyMsg.rows = 1;
  denyMsg.hidden = true;

  const actions = document.createElement('div');
  actions.className = 'perm-actions';
  const alwaysBtn = document.createElement('button');
  alwaysBtn.className = 'perm-btn perm-btn-always';
  alwaysBtn.innerHTML = `<span class="perm-btn-icon">${ICON_CHECK}</span>Always`;
  const allowBtn = document.createElement('button');
  allowBtn.className = 'perm-btn perm-btn-allow';
  allowBtn.innerHTML = `<span class="perm-btn-icon">${ICON_CHECK}</span>Allow`;
  const denyBtn = document.createElement('button');
  denyBtn.className = 'perm-btn perm-btn-deny';
  denyBtn.innerHTML = `<span class="perm-btn-icon">${ICON_X}</span>Deny`;
  const statusBadge = document.createElement('span');
  statusBadge.className = 'perm-status';
  statusBadge.hidden = true;

  denyBtn.addEventListener('mouseenter', () => { denyMsg.hidden = false; });

  let resolved = false;
  const resolve = (behavior, always = false) => {
    if (resolved) return;
    resolved = true;
    card.classList.remove('active-perm');
    card.classList.add('resolved', behavior === 'allow' ? 'resolved-allow' : 'resolved-deny');
    [alwaysBtn, allowBtn, denyBtn].forEach(b => { b.disabled = true; });
    if (bashInput) bashInput.disabled = true;
    denyMsg.disabled = true;
    statusBadge.textContent = always ? 'Always' : (behavior === 'allow' ? 'Allowed' : 'Denied');
    statusBadge.hidden = false;

    const inner = { behavior, always };
    if (behavior === 'allow') {
      if (always) hooks.autoAllow?.(toolName);
      if (bashInput && bashInput.value.trim() && bashInput.value !== (input.command || '')) {
        inner.updatedInput = { ...input, command: bashInput.value };
      }
      if (checkedSuggestions.size) {
        inner.updatedPermissions = [...checkedSuggestions].map(idx => suggestions[idx]);
      }
    } else {
      const reason = denyMsg.value.trim();
      if (reason) inner.message = reason;
    }
    hooks.sendResponse(requestId, inner);
    hooks.onResolved?.(behavior, always);
  };

  alwaysBtn.addEventListener('click', () => resolve('allow', true));
  allowBtn.addEventListener('click', () => resolve('allow'));
  denyBtn.addEventListener('click', () => resolve('deny'));

  actions.append(alwaysBtn, allowBtn, denyBtn, statusBadge);
  card.appendChild(denyMsg);
  card.appendChild(actions);
  wrap.appendChild(card);
  el.appendChild(wrap);
  $msgs.appendChild(el);
  if (tab === activeTab()) { try { scrollEnd(); } catch {} }
  return card;
}

// Plan approval card on ExitPlanMode control_request — maps the CLI's three
// choices. The same turn continues after approval (no respawn).
export function renderPlanApprovalCard(tab, requestId, req, hooks) {
  const { md, scrollEnd, activeTab, emit } = cpCtx;
  const $msgs = tab.messagesEl;
  if (!$msgs) return;

  // This SDK "PLAN READY" card is the sole plan container. Remove any stale legacy
  // "PLAN COMPLETE" card (.post-plan-card) that a reattach/engine-hello race may have
  // rendered, plus any prior unresolved approval card, so only this one ever shows.
  $msgs.querySelectorAll('.post-plan-card').forEach(el => {
    const msg = el.closest('.msg'); (msg || el).remove();
  });
  $msgs.querySelectorAll('.cp-plan-approval-card.active-perm').forEach(el => {
    const msg = el.closest('.msg'); (msg || el).remove();
  });

  const plan = req.input?.plan || '';

  const el = document.createElement('div');
  el.className = 'msg msg-assistant';
  const wrap = document.createElement('div');
  wrap.className = 'msg-content';
  const card = document.createElement('div');
  card.className = 'cp-plan-approval-card active-perm';
  card.dataset.requestId = requestId;

  const hdr = document.createElement('div');
  hdr.className = 'post-plan-header cp-plan-approval-header';
  hdr.textContent = 'PLAN READY';
  card.appendChild(hdr);

  if (plan) {
    const body = document.createElement('div');
    body.className = 'cp-plan-approval-body';
    body.innerHTML = md(plan);
    card.appendChild(body);
  }

  const feedback = document.createElement('textarea');
  feedback.className = 'cp-plan-feedback';
  feedback.placeholder = 'Request changes… (sent with "Keep planning")';
  feedback.rows = 1;

  const actions = document.createElement('div');
  actions.className = 'post-plan-actions cp-plan-approval-actions';

  const statusBadge = document.createElement('span');
  statusBadge.className = 'perm-status';
  statusBadge.hidden = true;

  let resolved = false;
  const finish = (label) => {
    resolved = true;
    card.classList.remove('active-perm');
    card.classList.add('resolved');
    actions.querySelectorAll('button').forEach(b => { b.disabled = true; });
    feedback.disabled = true;
    statusBadge.textContent = label;
    statusBadge.hidden = false;
  };

  const mkBtn = (label, cls, fn) => {
    const b = document.createElement('button');
    b.className = `post-plan-btn ${cls}`;
    b.textContent = label;
    b.addEventListener('click', () => { if (!resolved) fn(); });
    return b;
  };

  actions.append(
    mkBtn('Approve & auto-accept edits', 'cp-plan-btn-accept-edits', () => {
      hooks.sendResponse(requestId, { behavior: 'allow', planDecision: 'acceptEdits' });
      hooks.onApproved?.('acceptEdits');
      finish('Approved · auto-accept');
    }),
    mkBtn('Approve', 'cp-plan-btn-approve', () => {
      hooks.sendResponse(requestId, { behavior: 'allow', planDecision: 'default' });
      hooks.onApproved?.('default');
      finish('Approved');
    }),
    mkBtn('Keep planning', 'cp-plan-btn-keep', () => {
      const message = feedback.value.trim() || 'Keep planning — revise the plan.';
      hooks.sendResponse(requestId, { behavior: 'deny', message });
      hooks.onKeepPlanning?.(message);
      finish('Planning continues');
    }),
    mkBtn('Edit plan', 'cp-plan-btn-edit', () => {
      // Opens the external editor on the authored plan file (plan_file_written
      // arrived before this card). Card stays active — approve after editing.
      if (tab.planFilePath) emit('open-plan-editor', { filePath: tab.planFilePath, tabId: tab.id });
    }),
    statusBadge,
  );

  card.appendChild(feedback);
  card.appendChild(actions);
  wrap.appendChild(card);
  el.appendChild(wrap);
  $msgs.appendChild(el);
  if (tab === activeTab()) { try { scrollEnd(); } catch {} }
  return card;
}
