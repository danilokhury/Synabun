// SynaBun — Codex Panel: Interactive Requests
import {
  ICON_SPARK, ICON_TOOL, ICON_FILES, ICON_TERMINAL,
} from './cdx-icons.js';
import { notify, NOTIF_TYPE } from '../ui-notifications.js';
import {
  esc, pretty, appendElement, formatPermissionProfile,
} from './cdx-render.js';
import {
  buildSynaBunChoiceContent,
  codexApprovalDecisionActions,
  codexMcpElicitationMeta,
  codexMcpToolApprovalActions,
  codexPermissionApprovalActions,
  codexRequestIdentityKey,
  isCodexMcpToolApproval,
  normalizeSynaBunChoiceElicitation,
  shouldCodexAutoAcceptRequest,
} from './cdx-protocol.js';

const _pendingReplyAcks = new Map();
const _requestMetadata = new Map();
const DRAFT_STORAGE_PREFIX = 'synabun:codex-request-draft:';

function requestMetadataKey(requestId, correlation = null) {
  const sessionId = correlation?.sessionId || _ctx.boundTab?.id || 'unknown-session';
  return codexRequestIdentityKey(sessionId, requestId);
}

function getRequestMetadata(requestId, correlation = null) {
  return _requestMetadata.get(requestMetadataKey(requestId, correlation)) || correlation || {};
}

function requestStorageKey(requestId, correlation = null) {
  return `${DRAFT_STORAGE_PREFIX}${requestMetadataKey(requestId, correlation)}`;
}

function saveRequestDraft(requestId, value, correlation = null) {
  try { globalThis.sessionStorage?.setItem(requestStorageKey(requestId, correlation), JSON.stringify(value)); } catch {}
}

function loadRequestDraft(requestId, correlation = null) {
  try { return JSON.parse(globalThis.sessionStorage?.getItem(requestStorageKey(requestId, correlation)) || 'null'); } catch { return null; }
}

function clearRequestDraft(requestId, correlation = null) {
  try { globalThis.sessionStorage?.removeItem(requestStorageKey(requestId, correlation)); } catch {}
}

function logRequestLifecycle(event, requestId, details = {}, correlation = null) {
  console.info('[codex-request-ui]', {
    event,
    at: new Date().toISOString(),
    requestId: String(requestId),
    ...getRequestMetadata(requestId, correlation),
    ...details,
  });
}

let _ctx = {
  get requestCards() { return new Map(); },
  get messagesEl() { return null; },
  get boundTab() { return null; },
  scrollEnd() {},
  sendSocket() {},
  activeTab() { return null; },
  appendSystem() {},
  isActiveTab() { return false; },
  scheduleThreadSnapshotSave() {},
  isSynaBunChoicePrompt() { return false; },
  isChangelogChoiceSet() { return false; },
  openChangelogEditorFlow() { return false; },
  restoreChangelogButtons() {},
  isBlockingServerRequest() { return false; },
  onBlockingServerRequestStart() {},
  onBlockingServerRequestAnswered() {},
};

export function setRequestsContext(ctx) { _ctx = ctx; }

export function getRequestCardEntry(requestId) {
  const stored = _ctx.requestCards.get(String(requestId));
  if (!stored) return null;
  if (stored.card) return stored;
  return {
    card: stored,
    pillEl: stored.querySelector('.cxp-status-pill'),
    bodyEl: stored.querySelector('.cxp-card-body'),
  };
}

export function rememberRequestCard(requestId, entry) {
  _ctx.requestCards.set(String(requestId), entry);
}

export function lockRequestCard(entry, label = 'submitted') {
  if (!entry?.card) return;
  entry.card.querySelectorAll('button,input,select,textarea').forEach((node) => { node.disabled = true; });
  if (entry.pillEl) entry.pillEl.textContent = label;
  _ctx.scheduleThreadSnapshotSave(_ctx.boundTab);
}

export function unlockRequestCard(entry, label = 'waiting') {
  if (!entry?.card) return;
  entry.card.querySelectorAll('button,input,select,textarea').forEach((node) => { node.disabled = false; });
  if (entry.pillEl) entry.pillEl.textContent = label;
  _ctx.scheduleThreadSnapshotSave(_ctx.boundTab);
}

export function sendServerRequestReply(requestId, {
  result,
  error,
  label = 'submitted',
  persist = null,
  correlation = null,
} = {}) {
  const responseToken = crypto.randomUUID();
  const entry = getRequestCardEntry(requestId);
  const requestCorrelation = Object.freeze({
    ...getRequestMetadata(requestId, correlation || entry?.correlation || null),
  });
  const packet = {
    type: 'server_request_response',
    requestId,
    responseToken,
    ...requestCorrelation,
  };
  if (error) packet.error = error;
  else packet.result = result || {};
  if (persist) packet.persist = persist;
  saveRequestDraft(requestId, {
    responseToken,
    result: packet.result || null,
    error: packet.error || null,
    correlation: requestCorrelation,
    state: 'submitting',
    submittedAt: Date.now(),
  }, requestCorrelation);
  logRequestLifecycle('submit_clicked', requestId, { responseToken }, requestCorrelation);
  if (!_ctx.sendSocket(packet)) {
    logRequestLifecycle('socket_send_failed', requestId, { responseToken }, requestCorrelation);
    _ctx.appendSystem('Codex is not connected', 'error');
    return false;
  }
  _pendingReplyAcks.set(responseToken, { requestId, entry, label, correlation: requestCorrelation });
  lockRequestCard(entry, 'submitting');
  return true;
}

export function handleServerRequestResponseResult(msg) {
  const responseToken = String(msg?.responseToken || '');
  const pending = _pendingReplyAcks.get(responseToken);
  if (!pending) return false;
  _pendingReplyAcks.delete(responseToken);
  if (msg.ok) {
    logRequestLifecycle('answer_acknowledged', pending.requestId, {
      responseToken,
      status: msg.status || 'answered',
    }, pending.correlation);
    clearRequestDraft(pending.requestId, pending.correlation);
    _requestMetadata.delete(requestMetadataKey(pending.requestId, pending.correlation));
    lockRequestCard(pending.entry, pending.label);
    _ctx.onBlockingServerRequestAnswered?.(pending.requestId);
    return true;
  }
  const draft = loadRequestDraft(pending.requestId, pending.correlation) || {};
  logRequestLifecycle('answer_rejected', pending.requestId, {
    responseToken,
    status: msg.status || 'delivery_failed',
  }, pending.correlation);
  if (msg.status === 'stale') {
    clearRequestDraft(pending.requestId, pending.correlation);
    _requestMetadata.delete(requestMetadataKey(pending.requestId, pending.correlation));
    lockRequestCard(pending.entry, 'stale');
    _ctx.onBlockingServerRequestAnswered?.(pending.requestId);
    _ctx.appendSystem(msg.error || 'This Codex request is no longer pending', 'error');
    return true;
  }
  saveRequestDraft(pending.requestId, {
    ...draft,
    state: msg.status || 'delivery_failed',
    lastError: msg.error || 'Could not deliver answer',
  }, pending.correlation);
  unlockRequestCard(pending.entry, msg.status === 'delivery_failed' ? 'retry' : 'waiting');
  _ctx.appendSystem(msg.error || 'Could not answer Codex request', 'error');
  return true;
}

export function createInteractiveRequestCard(requestId, {
  title = 'Codex request',
  subtitle = '',
  icon = ICON_SPARK,
  className = 'cxp-ask',
  pillText = 'waiting',
} = {}) {
  const card = document.createElement('div');
  card.className = `cxp-card ${className}`.trim();
  card.dataset.requestId = String(requestId);

  const head = document.createElement('div');
  head.className = 'cxp-card-head';
  head.innerHTML = `
    <div class="cxp-card-icon">${icon}</div>
    <div class="cxp-card-titles">
      <div class="cxp-card-title">${esc(title)}</div>
      <div class="cxp-card-subtitle">${esc(subtitle)}</div>
    </div>
    <div class="cxp-status-pill">${esc(pillText)}</div>
    <div class="cxp-card-chevron"></div>
  `;
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'cxp-card-body';
  card.appendChild(body);
  appendElement(card);

  const entry = {
    card,
    headEl: head,
    bodyEl: body,
    pillEl: head.querySelector('.cxp-status-pill'),
    titleEl: head.querySelector('.cxp-card-title'),
    subtitleEl: head.querySelector('.cxp-card-subtitle'),
    correlation: Object.freeze({ ...getRequestMetadata(requestId) }),
  };
  rememberRequestCard(requestId, entry);
  return entry;
}

export function createRequestActions() {
  const actions = document.createElement('div');
  actions.className = 'cxp-request-actions';
  return actions;
}

export function createRequestButton(label, variant = '') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `cxp-request-btn${variant ? ` ${variant}` : ''}`;
  btn.textContent = label;
  return btn;
}

export function buildContentItemsText(items) {
  return Array.isArray(items) ? items.map((item) => {
    if (item?.type === 'inputText') return item.text || '';
    if (item?.type === 'inputImage') return item.imageUrl || '[image]';
    return pretty(item);
  }).filter(Boolean).join('\n') : '';
}

export function resolveRequestCard(requestId, label = 'resolved') {
  const entry = getRequestCardEntry(requestId);
  const correlation = entry?.correlation || getRequestMetadata(requestId);
  let awaitingAck = false;
  for (const pending of _pendingReplyAcks.values()) {
    if (String(pending.requestId) === String(requestId)
      && pending.correlation?.sessionId === correlation?.sessionId) {
      pending.resolvedLabel = label;
      awaitingAck = true;
    }
  }
  if (awaitingAck) return;
  clearRequestDraft(requestId, correlation);
  _requestMetadata.delete(requestMetadataKey(requestId, correlation));
  if (!entry) return;
  const currentLabel = entry.pillEl?.textContent?.trim().toLowerCase();
  lockRequestCard(entry, currentLabel === 'waiting' || currentLabel === 'submitted' ? label : (entry.pillEl?.textContent || label));
}

export function renderUserInputRequest(requestId, params, protocol = {}) {
  if (_ctx.requestCards.has(String(requestId))) return;

  const questions = Array.isArray(params?.questions) ? params.questions : [];
  const synabunRequest = _ctx.isSynaBunChoicePrompt('', questions.flatMap((question) => {
    if (!Array.isArray(question?.options)) return [];
    return question.options.map((option) => ({
      label: option?.label || option?.value || '',
      value: option?.value || option?.label || '',
    }));
  }));
  const entry = createInteractiveRequestCard(requestId, {
    title: protocol.kind === 'mcp' ? 'SynaBun Needs Input' : 'Codex Needs Input',
    subtitle: protocol.kind === 'mcp' ? 'mcp elicitation' : 'request_user_input',
    icon: ICON_SPARK,
    className: 'cxp-ask',
  });
  const { bodyEl } = entry;
  const retainedDraft = loadRequestDraft(requestId);
  const answers = retainedDraft?.result?.answers && typeof retainedDraft.result.answers === 'object'
    ? { ...retainedDraft.result.answers }
    : {};
  const inputs = [];
  const totalQuestions = questions.length;
  const persistEditingDraft = () => saveRequestDraft(requestId, {
    state: 'editing',
    result: { answers },
    updatedAt: Date.now(),
  });

  const intro = document.createElement('div');
  intro.className = 'cxp-request-note';
  intro.textContent = totalQuestions > 1
    ? `Answer all ${totalQuestions} questions below, then click Submit.`
    : 'Answer the question below, then click Submit.';
  bodyEl.appendChild(intro);

  questions.forEach((question, index) => {
    const answerKey = question.id || question.question || question.header || `question_${index + 1}`;
    const promptText = question.question || '';
    const card = document.createElement('div');
    card.className = 'cxp-ask-question-card';

    const label = document.createElement('div');
    label.className = 'cxp-card-section-label';
    label.textContent = question.header || question.id || `Question ${index + 1}`;
    card.appendChild(label);

    if (promptText) {
      const prompt = document.createElement('div');
      prompt.className = 'cxp-ask-question';
      prompt.textContent = promptText;
      card.appendChild(prompt);
    }

    const explicitOptions = Array.isArray(question.options) ? question.options : [];
    if (explicitOptions.length) {
      const optionsEl = document.createElement('div');
      optionsEl.className = 'cxp-ask-options';
      const isChangelogAsk = _ctx.isChangelogChoiceSet(explicitOptions);
      const hasOtherOption = explicitOptions.some((option) => {
        const label = typeof option === 'string' ? option : (option?.label || option?.value || '');
        return /^other$/i.test(label);
      });
      const options = [
        ...explicitOptions,
        ...(hasOtherOption ? [] : [{ label: 'Other', description: 'Type a different answer.' }]),
      ];
      const otherWrap = document.createElement('div');
      otherWrap.className = 'cxp-ask-other';
      otherWrap.hidden = true;
      const otherInput = document.createElement('input');
      otherInput.type = question.isSecret ? 'password' : 'text';
      otherInput.className = 'cxp-ask-input';
      otherInput.placeholder = 'Type your answer…';
      otherInput.addEventListener('input', () => {
        if (!otherWrap.hidden) {
          const value = otherInput.value.trim();
          if (value) answers[answerKey] = { answers: [value] };
          else delete answers[answerKey];
          persistEditingDraft();
          syncSubmit();
        }
      });
      otherWrap.appendChild(otherInput);
      inputs.push(otherInput);

      for (const option of options) {
        const optionLabel = typeof option === 'string' ? option : (option.label || option.value || '');
        const optionDesc = typeof option === 'string' ? '' : (option.description || '');
        const isOtherOption = /^other$/i.test(optionLabel);
        const btn = document.createElement('button');
        btn.className = 'cxp-ask-option';
        btn.type = 'button';
        btn.innerHTML = `
          <span class="cxp-ask-option-label">${esc(optionLabel)}</span>
          <span class="cxp-ask-option-desc">${esc(optionDesc)}</span>
        `;
        const retainedValue = answers[answerKey]?.answers?.[0];
        if (!isOtherOption && retainedValue === optionLabel) btn.classList.add('selected');
        btn.addEventListener('click', async () => {
          if (isChangelogAsk && /edit first/i.test(optionLabel)) {
            const allButtons = Array.from(optionsEl.querySelectorAll('.cxp-ask-option'));
            allButtons.forEach((node) => { node.disabled = true; });
            btn.classList.add('selected');
            const opened = await _ctx.openChangelogEditorFlow({
              requestId,
              answerKey,
              buttons: allButtons,
              source: synabunRequest ? 'synabun-request' : 'request',
              responseKind: protocol.kind || 'native',
              responseMeta: question._synabunMcp || null,
            });
            if (!opened) _ctx.restoreChangelogButtons(allButtons);
            return;
          }
          optionsEl.querySelectorAll('.cxp-ask-option').forEach((node) => node.classList.remove('selected'));
          btn.classList.add('selected');
          if (isOtherOption) {
            otherWrap.hidden = false;
            const value = otherInput.value.trim();
            if (value) answers[answerKey] = { answers: [value] };
            else delete answers[answerKey];
            queueMicrotask(() => otherInput.focus());
          } else {
            otherWrap.hidden = true;
            answers[answerKey] = { answers: [optionLabel] };
          }
          persistEditingDraft();
          syncSubmit();
        });
        optionsEl.appendChild(btn);
      }
      card.appendChild(optionsEl);
      card.appendChild(otherWrap);
    }

    if (!explicitOptions.length) {
      const input = document.createElement('input');
      input.type = question.isSecret ? 'password' : 'text';
      input.className = 'cxp-ask-input';
      input.placeholder = 'Type your answer…';
      input.value = answers[answerKey]?.answers?.[0] || '';
      input.addEventListener('input', () => {
        const value = input.value.trim();
        if (value) answers[answerKey] = { answers: [value] };
        else delete answers[answerKey];
        persistEditingDraft();
        syncSubmit();
      });
      card.appendChild(input);
      inputs.push(input);
    }

    bodyEl.appendChild(card);
  });

  const actions = document.createElement('div');
  actions.className = 'cxp-ask-submit-bar';
  const submit = document.createElement('button');
  submit.className = 'cxp-ask-submit';
  submit.type = 'button';
  submit.disabled = true;
  submit.textContent = `Submit (0/${totalQuestions})`;
  submit.addEventListener('click', () => {
    sendServerRequestReply(requestId, {
      result: protocol.kind === 'mcp'
        ? { action: 'accept', content: buildSynaBunChoiceContent(questions, answers), _meta: {} }
        : { answers },
      label: 'submitted',
    });
  });
  actions.appendChild(submit);
  bodyEl.appendChild(actions);

  function syncSubmit() {
    const answered = questions.reduce((count, question, index) => {
      const answerKey = question.id || question.question || question.header || `question_${index + 1}`;
      return count + (answers[answerKey]?.answers?.length ? 1 : 0);
    }, 0);
    submit.textContent = `Submit (${answered}/${totalQuestions})`;
    submit.disabled = answered < totalQuestions;
  }

  if (!totalQuestions) submit.disabled = false;
  syncSubmit();
  if (_ctx.isActiveTab(_ctx.boundTab)) inputs[0]?.focus();
}

export function elicitationChoiceOptions(schema, multi = false) {
  if (!schema || typeof schema !== 'object') return [];
  if (!multi) {
    if (Array.isArray(schema.oneOf)) {
      return schema.oneOf.map((option) => ({
        value: option?.const ?? option?.title ?? '',
        label: option?.title || option?.const || '',
      }));
    }
    if (Array.isArray(schema.enum)) {
      return schema.enum.map((value, index) => ({
        value,
        label: Array.isArray(schema.enumNames) ? (schema.enumNames[index] || value) : value,
      }));
    }
    return [];
  }
  const items = schema.items || {};
  if (Array.isArray(items.anyOf)) {
    return items.anyOf.map((option) => ({
      value: option?.const ?? option?.title ?? '',
      label: option?.title || option?.const || '',
    }));
  }
  if (Array.isArray(items.enum)) {
    return items.enum.map((value) => ({ value, label: value }));
  }
  return [];
}

export function isElicitationValueSatisfied(value, schema) {
  if (schema?.type === 'boolean') return typeof value === 'boolean';
  if (Array.isArray(value)) return value.length > 0;
  if (schema?.type === 'number' || schema?.type === 'integer') return value != null && value !== '' && !Number.isNaN(value);
  return value != null && String(value).trim() !== '';
}

export function renderMcpToolApprovalRequest(requestId, params) {
  if (_ctx.requestCards.has(String(requestId))) return;
  const metadata = codexMcpElicitationMeta(params);
  const serverName = String(params?.serverName || 'MCP');
  const toolName = String(metadata.tool_name || metadata.toolName || 'unknown tool');
  const entry = createInteractiveRequestCard(requestId, {
    title: `${serverName} Tool Approval`,
    subtitle: 'mcp tool approval',
    icon: ICON_TOOL,
    className: 'cxp-ask',
  });
  const { bodyEl } = entry;

  const note = document.createElement('div');
  note.className = 'cxp-request-note';
  note.textContent = params?.message || `${serverName} wants to run ${toolName}.`;
  bodyEl.appendChild(note);

  const details = document.createElement('pre');
  details.className = 'cxp-card-pre';
  details.textContent = `Server\n${serverName}\n\nTool\n${toolName}`;
  bodyEl.appendChild(details);

  const actions = createRequestActions();
  for (const action of codexMcpToolApprovalActions(params)) {
    const button = createRequestButton(action.label, action.style);
    button.addEventListener('click', () => sendServerRequestReply(requestId, {
      result: action.result,
      persist: action.persist || null,
      label: action.resultLabel,
    }));
    actions.appendChild(button);
  }
  bodyEl.appendChild(actions);
}

export function renderMcpElicitationRequest(requestId, params) {
  if (_ctx.requestCards.has(String(requestId))) return;

  if (isCodexMcpToolApproval(params)) {
    renderMcpToolApprovalRequest(requestId, params);
    return;
  }

  const synabunChoice = normalizeSynaBunChoiceElicitation(params);
  if (synabunChoice) {
    renderUserInputRequest(requestId, synabunChoice, { kind: 'mcp' });
    return;
  }

  const entry = createInteractiveRequestCard(requestId, {
    title: `${params?.serverName || 'MCP'} Needs Input`,
    subtitle: 'mcp elicitation',
    className: 'cxp-ask',
  });
  const { bodyEl } = entry;
  const message = document.createElement('div');
  message.className = 'cxp-request-note';
  message.textContent = params?.message || 'This MCP server requested additional input.';
  bodyEl.appendChild(message);

  if (params?.mode === 'url') {
    const link = document.createElement('a');
    link.className = 'cxp-request-link';
    link.href = params.url || '#';
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = params.url || 'Open link';
    bodyEl.appendChild(link);

    const actions = createRequestActions();
    const accept = createRequestButton('Accept');
    const decline = createRequestButton('Decline', 'secondary');
    const cancel = createRequestButton('Cancel', 'danger');
    accept.addEventListener('click', () => sendServerRequestReply(requestId, {
      result: { action: 'accept', content: {}, _meta: {} },
      label: 'accepted',
    }));
    decline.addEventListener('click', () => sendServerRequestReply(requestId, {
      result: { action: 'decline', content: null, _meta: {} },
      label: 'declined',
    }));
    cancel.addEventListener('click', () => sendServerRequestReply(requestId, {
      result: { action: 'cancel', content: null, _meta: {} },
      label: 'cancelled',
    }));
    actions.append(accept, decline, cancel);
    bodyEl.appendChild(actions);
    return;
  }

  const schema = params?.requestedSchema || {};
  const fieldsEl = document.createElement('div');
  fieldsEl.className = 'cxp-request-fields';
  bodyEl.appendChild(fieldsEl);

  const values = {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const focusables = [];
  const props = Object.entries(schema.properties || {});

  for (const [fieldName, fieldSchema] of props) {
    const field = document.createElement('div');
    field.className = 'cxp-request-field';

    const head = document.createElement('div');
    head.className = 'cxp-request-fieldhead';
    const strong = document.createElement('strong');
    strong.textContent = fieldSchema?.title || fieldName;
    head.appendChild(strong);
    if (required.has(fieldName)) {
      const req = document.createElement('span');
      req.className = 'cxp-request-required';
      req.textContent = 'required';
      head.appendChild(req);
    }
    field.appendChild(head);

    if (fieldSchema?.description) {
      const help = document.createElement('div');
      help.className = 'cxp-request-help';
      help.textContent = fieldSchema.description;
      field.appendChild(help);
    }

    const type = fieldSchema?.type || 'string';
    const singleChoices = elicitationChoiceOptions(fieldSchema, false);
    const multiChoices = type === 'array' ? elicitationChoiceOptions(fieldSchema, true) : [];

    if (type === 'boolean') {
      const label = document.createElement('label');
      label.className = 'cxp-request-check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(fieldSchema?.default);
      values[fieldName] = input.checked;
      input.addEventListener('change', () => {
        values[fieldName] = input.checked;
        syncSubmit();
      });
      label.append(input, document.createTextNode(fieldSchema?.title || fieldName));
      field.appendChild(label);
      focusables.push(input);
    } else if (multiChoices.length) {
      const select = document.createElement('select');
      select.className = 'cxp-request-select';
      select.multiple = true;
      for (const option of multiChoices) {
        const el = document.createElement('option');
        el.value = option.value;
        el.textContent = option.label;
        if (Array.isArray(fieldSchema?.default) && fieldSchema.default.includes(option.value)) el.selected = true;
        select.appendChild(el);
      }
      values[fieldName] = Array.isArray(fieldSchema?.default) ? [...fieldSchema.default] : [];
      select.addEventListener('change', () => {
        values[fieldName] = Array.from(select.selectedOptions).map((option) => option.value);
        syncSubmit();
      });
      field.appendChild(select);
      focusables.push(select);
    } else if (singleChoices.length) {
      const select = document.createElement('select');
      select.className = 'cxp-request-select';
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = required.has(fieldName) ? 'Select an option' : 'Optional';
      select.appendChild(empty);
      for (const option of singleChoices) {
        const el = document.createElement('option');
        el.value = option.value;
        el.textContent = option.label;
        select.appendChild(el);
      }
      select.value = fieldSchema?.default || '';
      values[fieldName] = select.value;
      select.addEventListener('change', () => {
        values[fieldName] = select.value;
        syncSubmit();
      });
      field.appendChild(select);
      focusables.push(select);
    } else if (type === 'number' || type === 'integer') {
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'cxp-request-input';
      input.value = fieldSchema?.default ?? '';
      values[fieldName] = input.value === '' ? '' : (type === 'integer' ? parseInt(input.value, 10) : Number(input.value));
      input.addEventListener('input', () => {
        if (input.value === '') values[fieldName] = '';
        else values[fieldName] = type === 'integer' ? parseInt(input.value, 10) : Number(input.value);
        syncSubmit();
      });
      field.appendChild(input);
      focusables.push(input);
    } else {
      const multiline = (fieldSchema?.maxLength || 0) > 180 || /multiline|paragraph|description/i.test(fieldSchema?.description || '');
      const input = multiline ? document.createElement('textarea') : document.createElement('input');
      input.className = multiline ? 'cxp-request-textarea' : 'cxp-request-input';
      if (!multiline) {
        input.type = fieldSchema?.format === 'email' ? 'email'
          : fieldSchema?.format === 'uri' ? 'url'
          : fieldSchema?.format === 'date' ? 'date'
          : fieldSchema?.format === 'date-time' ? 'datetime-local'
          : 'text';
      }
      input.value = fieldSchema?.default || '';
      values[fieldName] = input.value;
      input.addEventListener('input', () => {
        values[fieldName] = input.value;
        syncSubmit();
      });
      field.appendChild(input);
      focusables.push(input);
    }

    fieldsEl.appendChild(field);
  }

  const actions = createRequestActions();
  const accept = createRequestButton('Accept');
  const decline = createRequestButton('Decline', 'secondary');
  const cancel = createRequestButton('Cancel', 'danger');
  accept.addEventListener('click', () => {
    const content = {};
    for (const [fieldName, fieldSchema] of props) {
      const value = values[fieldName];
      if (fieldSchema?.type === 'boolean' || isElicitationValueSatisfied(value, fieldSchema)) content[fieldName] = value;
    }
    sendServerRequestReply(requestId, {
      result: { action: 'accept', content, _meta: {} },
      label: 'accepted',
    });
  });
  decline.addEventListener('click', () => sendServerRequestReply(requestId, {
    result: { action: 'decline', content: null, _meta: {} },
    label: 'declined',
  }));
  cancel.addEventListener('click', () => sendServerRequestReply(requestId, {
    result: { action: 'cancel', content: null, _meta: {} },
    label: 'cancelled',
  }));
  actions.append(accept, decline, cancel);
  bodyEl.appendChild(actions);

  function syncSubmit() {
    accept.disabled = [...required].some((fieldName) => {
      const fieldSchema = schema.properties?.[fieldName];
      return !isElicitationValueSatisfied(values[fieldName], fieldSchema);
    });
  }

  syncSubmit();
  if (_ctx.isActiveTab(_ctx.boundTab)) focusables[0]?.focus();
}

export function renderApprovalRequest(requestId, method, params) {
  if (_ctx.requestCards.has(String(requestId))) return;

  const isCommand = method === 'item/commandExecution/requestApproval';
  const isFile = method === 'item/fileChange/requestApproval';
  const isPermissions = method === 'item/permissions/requestApproval';
  const title = isCommand ? 'Command Approval Required'
    : isFile ? 'File Change Approval Required'
      : 'Permission Grant Required';
  const subtitle = isCommand ? 'command approval'
    : isFile ? 'file change approval'
      : 'permissions approval';
  const entry = createInteractiveRequestCard(requestId, {
    title,
    subtitle,
    className: 'cxp-ask',
    icon: isPermissions ? ICON_TOOL : isFile ? ICON_FILES : ICON_TERMINAL,
  });
  const { bodyEl } = entry;

  if (params?.reason) {
    const note = document.createElement('div');
    note.className = 'cxp-request-note';
    note.textContent = params.reason;
    bodyEl.appendChild(note);
  }

  const details = document.createElement('pre');
  details.className = 'cxp-card-pre';
  if (isCommand) {
    details.textContent = [
      params?.command ? `Command\n${params.command}` : '',
      params?.cwd ? `Working directory\n${params.cwd}` : '',
      Array.isArray(params?.commandActions) && params.commandActions.length ? `Command actions\n${pretty(params.commandActions)}` : '',
      params?.networkApprovalContext ? `Network context\n${pretty(params.networkApprovalContext)}` : '',
    ].filter(Boolean).join('\n\n');
  } else if (isFile) {
    details.textContent = [
      params?.grantRoot ? `Grant root\n${params.grantRoot}` : '',
      params?.itemId ? `Item\n${params.itemId}` : '',
    ].filter(Boolean).join('\n\n') || 'Codex requested approval to apply pending file changes.';
  } else {
    details.textContent = formatPermissionProfile(params?.permissions);
  }
  bodyEl.appendChild(details);

  const actions = createRequestActions();
  if (isPermissions) {
    for (const action of codexPermissionApprovalActions(params)) {
      const button = createRequestButton(action.label, action.style);
      button.addEventListener('click', () => sendServerRequestReply(requestId, {
        result: action.result,
        persist: action.persist || null,
        label: action.resultLabel,
      }));
      actions.appendChild(button);
    }
  } else {
    const approval = codexApprovalDecisionActions(params);
    const decisionMap = {
      accept: { label: 'Allow', style: undefined, resultLabel: 'allowed' },
      acceptForSession: { label: 'Allow for Session', style: 'secondary', resultLabel: 'allowed' },
      acceptWithExecpolicyAmendment: { label: 'Allow + Amend Exec Policy', style: 'secondary', resultLabel: 'allowed' },
      applyNetworkPolicyAmendment: { label: 'Apply Network Policy', style: 'secondary', resultLabel: 'allowed' },
      decline: { label: 'Decline', style: 'secondary', resultLabel: 'declined' },
      cancel: { label: 'Cancel Turn', style: 'danger', resultLabel: 'cancelled' },
    };
    const always = createRequestButton('Always Allow');
    always.addEventListener('click', () => sendServerRequestReply(requestId, {
      result: { decision: approval.alwaysDecision },
      label: approval.durable ? 'always allowed' : 'allowed for session (maximum supported)',
    }));
    actions.appendChild(always);
    for (const decision of approval.decisions) {
      const info = decisionMap[decision] || { label: decision, style: 'secondary', resultLabel: decision };
      const btn = createRequestButton(info.label, info.style);
      btn.addEventListener('click', () => sendServerRequestReply(requestId, { result: { decision }, label: info.resultLabel }));
      actions.appendChild(btn);
    }
  }
  bodyEl.appendChild(actions);
}

export function renderDynamicToolCallRequest(requestId, params) {
  if (_ctx.requestCards.has(String(requestId))) return;
  const entry = createInteractiveRequestCard(requestId, {
    title: params?.tool || 'Dynamic tool call',
    subtitle: 'client tool request',
    className: 'cxp-ask',
  });
  const { bodyEl } = entry;

  const note = document.createElement('div');
  note.className = 'cxp-request-note';
  note.textContent = `Codex is requesting the client tool "${params?.tool || 'unknown'}". You can provide a return value or decline.`;
  bodyEl.appendChild(note);

  const args = document.createElement('pre');
  args.className = 'cxp-card-pre';
  args.textContent = pretty(params?.arguments) || '(none)';
  bodyEl.appendChild(args);

  const inputLabel = document.createElement('div');
  inputLabel.className = 'cxp-card-section-label';
  inputLabel.textContent = 'Return value (text)';
  bodyEl.appendChild(inputLabel);

  const returnInput = document.createElement('textarea');
  returnInput.className = 'cxp-card-textarea';
  returnInput.placeholder = 'Type the return value for this tool call…';
  returnInput.rows = 3;
  bodyEl.appendChild(returnInput);

  const actions = createRequestActions();
  const sendBtn = createRequestButton('Send Result', 'primary');
  sendBtn.addEventListener('click', () => sendServerRequestReply(requestId, {
    result: {
      success: true,
      contentItems: [{
        type: 'inputText',
        text: returnInput.value || '(empty)',
      }],
    },
    label: 'returned',
  }));
  const unavailable = createRequestButton('Decline', 'danger');
  unavailable.addEventListener('click', () => sendServerRequestReply(requestId, {
    result: {
      success: false,
      contentItems: [{
        type: 'inputText',
        text: `Client tool "${params?.tool || 'unknown'}" declined by user.`,
      }],
    },
    label: 'declined',
  }));
  actions.appendChild(sendBtn);
  actions.appendChild(unavailable);
  bodyEl.appendChild(actions);
}

export function renderGenericServerRequest(requestId, request) {
  if (_ctx.requestCards.has(String(requestId))) return;
  const entry = createInteractiveRequestCard(requestId, {
    title: request?.method || 'Codex request',
    subtitle: 'generic server request',
    className: 'cxp-ask',
  });
  const { bodyEl } = entry;

  const note = document.createElement('div');
  note.className = 'cxp-request-note';
  note.textContent = 'This request type does not have a custom renderer yet. You can inspect the payload and either send an empty result or reject it.';
  bodyEl.appendChild(note);

  const details = document.createElement('pre');
  details.className = 'cxp-card-pre';
  details.textContent = pretty({
    method: request?.method || '',
    params: request?.params || {},
  });
  bodyEl.appendChild(details);

  const actions = createRequestActions();
  const emptyResult = createRequestButton('Send Empty Result');
  emptyResult.addEventListener('click', () => sendServerRequestReply(requestId, {
    result: {},
    label: 'submitted',
  }));
  const reject = createRequestButton('Reject', 'danger');
  reject.addEventListener('click', () => sendServerRequestReply(requestId, {
    error: {
      code: -32601,
      message: `Unsupported in SynaBun Codex panel: ${request?.method || 'unknown request'}`,
    },
    label: 'rejected',
  }));
  actions.append(emptyResult, reject);
  bodyEl.appendChild(actions);
}

export function handleServerRequest(request) {
  const requestId = request.requestId;
  const correlation = Object.freeze({
    sessionId: request.sessionId || _ctx.boundTab?.id || '',
    threadId: request.threadId || request.params?.threadId || '',
    turnId: request.turnId || request.params?.turnId || '',
    toolCallId: request.params?.toolCallId || request.params?.callId || request.params?.itemId || '',
  });
  _requestMetadata.set(requestMetadataKey(requestId, correlation), correlation);
  if (_ctx.isBlockingServerRequest?.(request.method)) {
    _ctx.onBlockingServerRequestStart?.(requestId, request.method, request.params || {});
  }
  // Auto-accept: if enabled, immediately approve approval requests
  const tab = _ctx.activeTab();
  if (tab?.autoAccept) {
    if (shouldCodexAutoAcceptRequest(request.method)) {
      sendServerRequestReply(requestId, { result: { decision: 'acceptForSession' }, correlation });
      _ctx.appendSystem(`Auto-accepted: ${request.method.split('/').slice(1, -1).join('/')}`, 'muted');
      return;
    }
  }
  if (tab) {
    if (!tab._notifState) tab._notifState = { turnOutcomeKey: '', requestIds: new Set() };
    const requestKey = String(requestId);
    if (!tab._notifState.requestIds.has(requestKey)) {
      const kind = _ctx.isBlockingServerRequest?.(request.method) ? (
        (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(request.method)
          || isCodexMcpToolApproval(request.params))
          ? NOTIF_TYPE.ACTION
          : NOTIF_TYPE.ASK
      ) : null;
      if (kind) {
        tab._notifState.requestIds.add(requestKey);
        notify('panel', kind, tab.sessionLabel || 'Codex', {
          panel: 'codex',
          provider: 'codex',
          tabId: tab.id,
        });
      }
    }
  }
  switch (request.method) {
    case 'item/tool/requestUserInput':
    case 'tool/requestUserInput':
      renderUserInputRequest(requestId, request.params);
      return;
    case 'mcpServer/elicitation/request':
      renderMcpElicitationRequest(requestId, request.params);
      return;
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
    case 'item/permissions/requestApproval':
      renderApprovalRequest(requestId, request.method, request.params);
      return;
    case 'item/tool/call':
      renderDynamicToolCallRequest(requestId, request.params);
      return;
    default:
      _ctx.appendSystem(`Codex requested ${request.method}. Rendering generic request card.`, 'working');
      renderGenericServerRequest(requestId, request);
    }
}
