// ── Real permission cards + plan approval (SDK engine) ──
//
// With the SDK bridge, control_requests arrive BEFORE the tool executes
// (canUseTool pauses the agent). These cards therefore actually gate execution:
// Allow/Deny resolves the server-side promise; Deny no longer kills anything —
// the agent sees the denial in-band and adapts.

import { cpCtx } from './cp-ctx.js';
import { keepsNothing } from './cp-temporary.js';
import { buildDiffPreviewEl } from './cp-diff.js';
import {
  ALL_PERMISSION_MODES, MODE_LABELS, DESTINATIONS, describeSuggestion, alwaysUpdates, permissionContext,
  elicitationFields, collectElicitation, elicitationUrl,
} from './cp-permission-model.js';

const ICON_CHECK = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.5 3.5 6.5-7"/></svg>';
const ICON_X = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>';

// Modes, rule suggestions and the prompt's context are decided in
// cp-permission-model.js (DOM-free, tested); this file renders them.
export const PERMISSION_MODES = ALL_PERMISSION_MODES;
export { MODE_LABELS, describeSuggestion };

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
  // Web tools: the address or the query is what is being approved; show it as
  // such, with the rest (prompt, domain filters) below.
  const webTarget = toolName === 'WebFetch' ? input?.url : (toolName === 'WebSearch' ? input?.query : '');
  const keys = Object.keys(input || {}).filter(k => !(webTarget && (k === 'url' || k === 'query')));
  if (!keys.length && !webTarget) return { el: null, bashInput: null };
  const box = document.createElement('div');
  box.className = 'cp-perm-preview';
  if (webTarget) {
    const lbl = document.createElement('div');
    lbl.className = 'cp-perm-preview-label';
    lbl.textContent = toolName === 'WebFetch' ? 'Fetch this page' : 'Search the web for';
    const target = document.createElement('div');
    target.className = 'cp-perm-target';
    target.textContent = String(webTarget);
    box.append(lbl, target);
    if (!keys.length) return { el: box, bashInput: null };
  }
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

// What a card says when its answer could not be sent (the tab's socket is closed).
const ANSWER_UNSENT = 'Not sent: this tab is not connected. Answer again once it is.';

// renderPermissionCard(tab, requestId, req, hooks)
// hooks: { sendResponse(requestId, inner), onResolved(behavior, always), toolIconSvg, autoAllow(toolName) }
export function renderPermissionCard(tab, requestId, req, hooks) {
  const { toolIconSvg, scrollEnd, activeTab } = cpCtx;
  const $msgs = tab.messagesEl;
  if (!$msgs) return;

  const toolName = req.tool_name || 'Unknown';
  const input = req.input || {};
  const ctx = permissionContext(req);

  const el = document.createElement('div');
  el.className = 'msg msg-assistant';
  const wrap = document.createElement('div');
  wrap.className = 'msg-content';

  const card = document.createElement('div');
  card.className = 'perm-card active-perm cp-perm-card';
  card.dataset.requestId = requestId;
  if (ctx.toolUseId) card.dataset.toolUseId = ctx.toolUseId;

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
  name.textContent = ctx.displayName || toolName;
  if (ctx.displayName) name.title = toolName;
  toolLine.append(icon, name);
  card.appendChild(toolLine);

  // The CLI's own sentence for this ask, and why it is asking.
  if (ctx.title) {
    const title = document.createElement('div');
    title.className = 'cp-perm-title';
    title.textContent = ctx.title;
    card.appendChild(title);
  }
  if (ctx.description) {
    const desc = document.createElement('div');
    desc.className = 'cp-perm-desc';
    desc.textContent = ctx.description;
    card.appendChild(desc);
  }
  if (ctx.rows.length) {
    const box = document.createElement('div');
    box.className = 'cp-perm-context';
    for (const [k, v] of ctx.rows) {
      const row = document.createElement('div');
      row.className = 'cp-perm-kv-row';
      const key = document.createElement('span'); key.className = 'cp-perm-kv-key'; key.textContent = k;
      const val = document.createElement('span'); val.className = 'cp-perm-kv-val'; val.textContent = v;
      row.append(key, val);
      box.appendChild(row);
    }
    card.appendChild(box);
  }

  const { el: previewEl, bashInput } = buildPreview(toolName, input);
  if (previewEl) card.appendChild(previewEl);

  // What "Always" grants: the rules the CLI suggested, and where they are saved.
  let destination = 'session';
  if (ctx.canAlways) {
    const sugBox = document.createElement('div');
    sugBox.className = 'cp-perm-suggestions';
    const label = document.createElement('div');
    label.className = 'cp-perm-preview-label';
    label.textContent = 'Always will';
    sugBox.appendChild(label);
    for (const update of alwaysUpdates(req)) {
      const row = document.createElement('div');
      row.className = 'cp-perm-suggestion';
      row.textContent = describeSuggestion(update);
      sugBox.appendChild(row);
    }
    const destRow = document.createElement('label');
    destRow.className = 'cp-perm-dest';
    const destLabel = document.createElement('span');
    destLabel.textContent = 'for';
    const select = document.createElement('select');
    select.className = 'cp-perm-dest-select';
    for (const d of DESTINATIONS) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.label;
      select.appendChild(opt);
    }
    select.value = 'session';
    select.addEventListener('change', () => { destination = select.value; });
    destRow.append(destLabel, select);
    sugBox.appendChild(destRow);
    card.appendChild(sugBox);
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
  alwaysBtn.hidden = !ctx.canAlways;
  const allowBtn = document.createElement('button');
  allowBtn.className = 'perm-btn perm-btn-allow';
  allowBtn.innerHTML = `<span class="perm-btn-icon">${ICON_CHECK}</span>Allow`;
  const denyBtn = document.createElement('button');
  denyBtn.className = 'perm-btn perm-btn-deny';
  denyBtn.innerHTML = `<span class="perm-btn-icon">${ICON_X}</span>Deny`;
  // Deny, and end the turn instead of letting the model try another way.
  const stopBtn = document.createElement('button');
  stopBtn.className = 'perm-btn perm-btn-deny cp-perm-stop';
  stopBtn.innerHTML = `<span class="perm-btn-icon">${ICON_X}</span>Deny and stop`;
  stopBtn.hidden = !hooks.canInterrupt;
  const statusBadge = document.createElement('span');
  statusBadge.className = 'perm-status';
  statusBadge.hidden = true;

  denyBtn.addEventListener('mouseenter', () => { denyMsg.hidden = false; });
  stopBtn.addEventListener('mouseenter', () => { denyMsg.hidden = false; });
  // An ask the CLI marks as not approvable by a stray click: the card opens on
  // its decline option.
  if (ctx.defaultToNo) card.classList.add('cp-perm-default-no');

  let resolved = false;
  const resolve = (behavior, { always = false, interrupt = false } = {}) => {
    if (resolved) return;
    const inner = { behavior };
    let granted = [];
    if (behavior === 'allow') {
      if (bashInput && bashInput.value.trim() && bashInput.value !== (input.command || '')) {
        inner.updatedInput = { ...input, command: bashInput.value };
      }
      if (always) {
        granted = alwaysUpdates(req, destination);
        if (granted.length) inner.updatedPermissions = granted;
      }
    } else {
      const reason = denyMsg.value.trim();
      if (reason) inner.message = reason;
      if (interrupt) inner.interrupt = true;
    }
    // An answer is shown as given only once it was sent: `sendResponse` returns
    // false when it could not be (the socket is closed). The card then stays as
    // it is and says so, to be answered when the tab is connected again.
    if (hooks.sendResponse(requestId, inner) === false) { statusBadge.textContent = ANSWER_UNSENT; statusBadge.hidden = false; return; }
    resolved = true;
    card.classList.remove('active-perm');
    card.classList.add('resolved', behavior === 'allow' ? 'resolved-allow' : 'resolved-deny');
    [alwaysBtn, allowBtn, denyBtn, stopBtn].forEach(b => { b.disabled = true; });
    card.querySelectorAll('select').forEach(n => { n.disabled = true; });
    if (bashInput) bashInput.disabled = true;
    denyMsg.disabled = true;
    statusBadge.textContent = always ? 'Always' : (behavior === 'allow' ? 'Allowed' : (interrupt ? 'Denied · stopped' : 'Denied'));
    statusBadge.hidden = false;
    hooks.onResolved?.(behavior, always, { granted, interrupt });
  };

  alwaysBtn.addEventListener('click', () => resolve('allow', { always: true }));
  allowBtn.addEventListener('click', () => resolve('allow'));
  denyBtn.addEventListener('click', () => resolve('deny'));
  stopBtn.addEventListener('click', () => resolve('deny', { interrupt: true }));

  if (ctx.defaultToNo) actions.append(denyBtn, stopBtn, allowBtn, alwaysBtn, statusBadge);
  else actions.append(alwaysBtn, allowBtn, denyBtn, stopBtn, statusBadge);
  card.appendChild(denyMsg);
  card.appendChild(actions);
  wrap.appendChild(card);
  el.appendChild(wrap);
  $msgs.appendChild(el);
  if (ctx.defaultToNo) { try { denyBtn.focus(); } catch {} }
  if (tab === activeTab()) { try { scrollEnd(); } catch {} }
  return card;
}

// MCP elicitation: a server asks the user for input (a form built from its
// schema) or sends them to a page (URL mode). Everything shown comes from a
// third-party server: text only, and a link is opened only on an explicit click.
export function renderElicitationCard(tab, requestId, req, hooks) {
  const { scrollEnd, activeTab } = cpCtx;
  const $msgs = tab.messagesEl;
  if (!$msgs) return null;

  const el = document.createElement('div');
  el.className = 'msg msg-assistant';
  const wrap = document.createElement('div');
  wrap.className = 'msg-content';
  const card = document.createElement('div');
  card.className = 'perm-card active-perm cp-perm-card cp-elicit-card';
  card.dataset.requestId = requestId;
  if (req.elicitation_id) card.dataset.elicitationId = req.elicitation_id;

  const hdr = document.createElement('div');
  hdr.className = 'perm-header';
  hdr.textContent = 'INPUT REQUESTED';
  card.appendChild(hdr);

  const from = document.createElement('div');
  from.className = 'perm-tool-line';
  const name = document.createElement('span');
  name.className = 'perm-tool-name';
  name.textContent = req.display_name || req.server_name || 'MCP server';
  from.appendChild(name);
  card.appendChild(from);

  for (const [cls, text] of [['cp-perm-title', req.title], ['cp-perm-desc', req.message], ['cp-perm-desc', req.description]]) {
    if (!text) continue;
    const row = document.createElement('div');
    row.className = cls;
    row.textContent = String(text);
    card.appendChild(row);
  }

  const statusBadge = document.createElement('span');
  statusBadge.className = 'perm-status';
  statusBadge.hidden = true;
  const actions = document.createElement('div');
  actions.className = 'perm-actions';

  let resolved = false;
  const finish = (action, content) => {
    if (resolved) return;
    // (As on the permission card: not shown as answered unless the answer was sent.)
    if (hooks.sendResponse(requestId, content ? { action, content } : { action }) === false) { statusBadge.textContent = ANSWER_UNSENT; statusBadge.hidden = false; return; }
    resolved = true;
    card.classList.remove('active-perm');
    card.classList.add('resolved', action === 'accept' ? 'resolved-allow' : 'resolved-deny');
    card.querySelectorAll('button, input, select, textarea').forEach(n => { n.disabled = true; });
    statusBadge.textContent = action === 'accept' ? 'Sent' : (action === 'decline' ? 'Declined' : 'Cancelled');
    statusBadge.hidden = false;
    hooks.onResolved?.(action);
  };
  const mkBtn = (label, cls, fn) => {
    const b = document.createElement('button');
    b.className = `perm-btn ${cls}`;
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  };

  // The server can confirm a URL-mode elicitation itself (elicitation_complete).
  card._settle = (action) => finish(action);

  if (req.mode === 'url') {
    const url = elicitationUrl(req);
    const link = document.createElement('div');
    link.className = 'cp-perm-target';
    link.textContent = url || 'The server sent an address that cannot be opened here.';
    card.appendChild(link);
    const open = mkBtn('Open page', 'perm-btn-allow', () => {
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
      open.textContent = 'Opened';
    });
    open.disabled = !url;
    actions.append(
      open,
      mkBtn('Done', 'perm-btn-always', () => finish('accept')),
      mkBtn('Decline', 'perm-btn-deny', () => finish('decline')),
      statusBadge,
    );
  } else {
    const fields = elicitationFields(req.requested_schema);
    const controls = new Map();
    const form = document.createElement('div');
    form.className = 'cp-elicit-form';
    for (const f of fields) {
      const row = document.createElement('label');
      row.className = 'cp-elicit-field';
      const label = document.createElement('span');
      label.className = 'cp-elicit-label';
      label.textContent = f.required ? `${f.label} *` : f.label;
      row.appendChild(label);
      let control;
      if (f.type === 'boolean') {
        control = document.createElement('input');
        control.type = 'checkbox';
        control.checked = f.default === true;
      } else if (f.type === 'choice') {
        control = document.createElement('select');
        if (!f.required) { const none = document.createElement('option'); none.value = ''; none.textContent = '—'; control.appendChild(none); }
        for (const o of f.options) {
          const opt = document.createElement('option');
          opt.value = String(o.value);
          opt.textContent = o.label;
          control.appendChild(opt);
        }
        if (f.default != null) control.value = String(f.default);
      } else {
        control = document.createElement('input');
        control.type = f.type === 'number' ? 'number' : (f.format === 'email' ? 'email' : (f.format === 'date' ? 'date' : 'text'));
        if (f.default != null) control.value = String(f.default);
      }
      control.className = 'cp-elicit-input';
      row.appendChild(control);
      if (f.description) {
        const hint = document.createElement('span');
        hint.className = 'cp-elicit-hint';
        hint.textContent = f.description;
        row.appendChild(hint);
      }
      const err = document.createElement('span');
      err.className = 'cp-elicit-error';
      err.hidden = true;
      row.appendChild(err);
      controls.set(f.name, { control, err, field: f });
      form.appendChild(row);
    }
    card.appendChild(form);
    actions.append(
      mkBtn('Send', 'perm-btn-allow', () => {
        const values = {};
        for (const [fieldName, c] of controls) values[fieldName] = c.field.type === 'boolean' ? c.control.checked : c.control.value;
        const result = collectElicitation(fields, values);
        for (const [fieldName, c] of controls) {
          c.err.textContent = result.errors[fieldName] || '';
          c.err.hidden = !result.errors[fieldName];
        }
        if (result.ok) finish('accept', result.content);
      }),
      mkBtn('Decline', 'perm-btn-deny', () => finish('decline')),
      statusBadge,
    );
  }

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

  // A plan the user changed in the editor is the plan that gets approved: it
  // goes back as the tool's input.
  const editedInput = () => {
    const edited = String(hooks.editedPlan?.() || '').trim();
    return edited && edited !== String(plan).trim() ? { updatedInput: { ...(req.input || {}), plan: edited } } : {};
  };

  const mkBtn = (label, cls, fn) => {
    const b = document.createElement('button');
    b.className = `post-plan-btn ${cls}`;
    b.textContent = label;
    b.addEventListener('click', () => { if (!resolved) fn(); });
    return b;
  };

  // An answer is shown as given only once it was sent: `sendResponse` returns
  // false when it could not be (the socket is closed), and the card stays as it
  // is, to be answered when the tab is connected again.
  actions.append(
    mkBtn('Approve & auto-accept edits', 'cp-plan-btn-accept-edits', () => {
      if (hooks.sendResponse(requestId, { behavior: 'allow', planDecision: 'acceptEdits', ...editedInput() }) === false) return;
      hooks.onApproved?.('acceptEdits');
      finish('Approved · auto-accept');
    }),
    mkBtn('Approve', 'cp-plan-btn-approve', () => {
      if (hooks.sendResponse(requestId, { behavior: 'allow', planDecision: 'default', ...editedInput() }) === false) return;
      hooks.onApproved?.('default');
      finish('Approved');
    }),
    // The CLI's own third way to approve, offered as there only where Bypass can be taken.
    ...(hooks.bypass?.available ? [mkBtn('Approve & bypass permissions', 'cp-plan-btn-bypass', () => {
      if (hooks.sendResponse(requestId, { behavior: 'allow', planDecision: 'bypassPermissions', ...editedInput() }) === false) return;
      hooks.onApproved?.('bypassPermissions');
      finish('Approved · bypass');
    })] : []),
    mkBtn('Keep planning', 'cp-plan-btn-keep', () => {
      const message = String(feedback.value || '').trim() || 'Keep planning — revise the plan.';
      if (hooks.sendResponse(requestId, { behavior: 'deny', message }) === false) return;
      hooks.onKeepPlanning?.(message);
      finish('Planning continues');
    }),
    // (Not in a temporary chat: no plan file is written for it.)
    ...(keepsNothing(tab) ? [] : [mkBtn('Edit plan', 'cp-plan-btn-edit', () => {
      // Opens the external editor on the authored plan file (plan_file_written
      // arrived before this card). Card stays active — approve after editing.
      if (tab.planFilePath) emit('open-plan-editor', { filePath: tab.planFilePath, tabId: tab.id });
    })]),
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

// ── AskUserQuestion: option previews and a note per answer ──

/**
 * Add to a question what the SDK's question shape carries beyond label and
 * description: a preview per option (a mockup, a code sample), shown for the
 * option under the pointer or picked, and a note field.
 * @param card            the element the question's controls live in
 * @param o.optionsEl     the question's own options container, when one card holds several questions
 * @param o.notes         add the note field (the bridge keeps annotations)
 */
export function decorateAskCard(card, question, { notes = false, optionsEl = null } = {}) {
  const text = String(question?.question || question?.text || question?.header || '');
  const scope = optionsEl || card;
  const options = Array.isArray(question?.options) ? question.options : [];
  const buttons = [...scope.querySelectorAll('.ask-option')];
  const previews = options.map(o => (o && typeof o === 'object' && typeof o.preview === 'string' ? o.preview : ''));
  let anchor = optionsEl || card.querySelector('.ask-options');
  if (previews.some(Boolean)) {
    scope.dataset.askQuestion = text;
    const pane = document.createElement('pre');
    pane.className = 'ask-preview';
    pane.hidden = true;
    const show = (value) => { pane.textContent = value; pane.hidden = !value; };
    buttons.forEach((btn, idx) => {
      const preview = previews[idx] || '';
      btn.addEventListener('mouseenter', () => { if (preview) show(preview); });
      btn.addEventListener('mouseleave', () => show(scope._selectedPreview || ''));
      btn.addEventListener('click', () => {
        // Runs after the card's own handler: the button now says whether it is picked.
        scope._selectedPreview = btn.classList.contains('selected') ? preview : '';
        show(scope._selectedPreview);
      });
    });
    if (anchor) anchor.after(pane); else card.appendChild(pane);
    anchor = pane;
  }
  if (notes) {
    const note = document.createElement('textarea');
    note.className = 'ask-notes';
    note.rows = 1;
    note.placeholder = 'Add a note to this answer (optional)';
    note.dataset.askQuestion = text;
    // Under the question's own controls when a card holds several questions.
    if (optionsEl && anchor) anchor.after(note); else card.appendChild(note);
  }
  return card;
}

/** The annotations to send with the answers: {question: {preview?, notes?}}, or null. */
export function askAnnotations(root, answers) {
  const out = {};
  for (const el of root.querySelectorAll('[data-ask-question]')) {
    const question = el.dataset.askQuestion || '';
    if (!question || answers?.[question] == null) continue;
    const entry = out[question] || (out[question] = {});
    if (el.classList.contains('ask-notes')) {
      const notes = String(el.value || '').trim();
      if (notes) entry.notes = notes;
    } else if (el._selectedPreview) {
      entry.preview = el._selectedPreview;
    }
  }
  for (const key of Object.keys(out)) if (!Object.keys(out[key]).length) delete out[key];
  return Object.keys(out).length ? out : null;
}

/** After Submit: what was answered stays readable on the card. */
export function markAskAnswered(card, answers) {
  if (!card || card.querySelector('.ask-answered')) return;
  const entries = Object.entries(answers || {}).filter(([, a]) => a != null && String(a).trim());
  if (!entries.length) return;
  for (const [question, answer] of entries) {
    const line = document.createElement('div');
    line.className = 'ask-answered';
    line.textContent = entries.length > 1 ? `${question} → ${answer}` : `Answered: ${answer}`;
    card.appendChild(line);
  }
}
