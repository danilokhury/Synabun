// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — Renderer
// Subscribes to state changes and reconciles the messages container. Handles
// every SDK part type (text, reasoning, tool, file, subtask, agent, retry,
// compaction, patch; step and snapshot markers are hidden), per-message
// errors, the retry banner, permission and question cards.
// What to show is decided in ocp-v2-render-logic.js (no DOM, unit-tested);
// this file builds the nodes. Markdown goes through `marked` and then the
// shared allowlist sanitizer before it reaches innerHTML.
// ─────────────────────────────────────────────────────────────────────────────

import { getDefaultStore } from './ocp-v2-state.js';
import { api, supports, isDescendantSession, isKnownDescendantSession, onEvent } from './ocp-v2-ws.js';
import {
  permissionCardView, ALWAYS_ALLOW_SCOPE, replyToPermission, FOREIGN_REQUEST_MESSAGE,
  transcriptQuestionCard, answerQuestion, skipQuestion,
} from './ocp-v2-approvals.js';
import { captureBinding } from './ocp-v2-binding.js';
import { requestsVisibleIn } from './ocp-v2-rehydrate.js';
import { replyFailed, replyError } from './ocp-v2-caps.js';
import { handlePostPlanAction } from './ocp-v2-plan.js';
import { TOOL_ICONS } from './ocp-v2-icons.js';
import { renderToolCard } from './ocp-v2-tools.js';
import { messageMetaText } from './ocp-v2-tools-logic.js';
import { createStickyScrollController } from '../ui-scroll-follow.js';
import { sanitizeHtmlString } from '../assistant/asst-sanitize.js';
import { openProviderSettings } from './ocp-v2-settings-link.js';
import {
  visibleParts, partSignature, messageErrorView, retryBannerView, retryPartText,
  compactionLabel, inlinePartText, reasoningPreview, createCardDrafts,
} from './ocp-v2-render-logic.js';
import {
  visibleMessageOrder, revertBannerView, messageText, messageActionsFor, deleteMessageConfirmText,
} from './ocp-v2-sessions-logic.js';
import {
  revertToMessage, restoreReverted, retryFromMessage, forkSession, deleteMessage,
} from './ocp-v2-session-actions.js';

const _expandedReasoningIds = new Set();
const _activeRenderers = new Set();
// The callbacks each panel passed to mountRenderer, for part renderers that
// only get the store.
const _rendererOpts = new WeakMap();

// ── Markdown via marked (matches the V1 ocp panel) ──────────────────────────
let _marked = null;
let _markedLoading = false;

function ensureMarked() {
  if (_marked || _markedLoading || typeof window === 'undefined') return;
  _markedLoading = true;
  import('https://cdn.jsdelivr.net/npm/marked@14/lib/marked.esm.js')
    .then((mod) => {
      _marked = mod?.marked || mod?.default || null;
      if (_marked?.setOptions) _marked.setOptions({ breaks: true, gfm: true });
      // Re-render every active panel so messages mounted before marked loaded
      // get formatted.
      for (const r of _activeRenderers) {
        try { r.render(); } catch {}
      }
    })
    .catch(() => {})
    .finally(() => { _markedLoading = false; });
}

ensureMarked();

// Each mountRenderer call creates an independent renderer instance bound to
// its own container + store. Multiple panels can render simultaneously.
// opts (all optional; a sub-agent panel passes none and gets Copy only):
//   onOpenSession(session)   show a session this panel just created (fork)
//   onComposeText(text, { files, resources, resourceList })   put a prompt back into the compose box (undo)
//   onSendText(text, { files })      send a prompt with its own file parts (retry); resolves true when sent
//   onOpenChild(sessionId)   show the sub-agent session of a task card
//   confirm({ key, text, confirmLabel })   ask in the panel before something is
//                            destroyed; resolves true only after the second
//                            click (ocp-v2-confirm-logic.js). Without it a
//                            message is not deleted.
export function mountRenderer(containerEl, store = getDefaultStore(), opts = {}) {
  _rendererOpts.set(store, opts);
  let _container = containerEl;
  let _renderScheduled = false;
  const scrollController = createStickyScrollController(_container);

  const doRender = () => {
    render(_container, store, opts);
    scrollController?.scrollToBottom();
  };
  const scheduleRender = () => {
    if (_renderScheduled) return;
    _renderScheduled = true;
    requestAnimationFrame(() => {
      _renderScheduled = false;
      if (_container) doRender();
    });
  };

  const unsubscribe = store.subscribe((event, state) => {
    // The server listed this session's open permission requests: a reason
    // typed for one that is no longer among them has no card to come back to.
    if (event?.type === 'permission:set' && event.listed) settlePermissionReasons(state);
    scheduleRender();
  });

  const instance = {
    render: doRender,
    unmount: () => {
      try { unsubscribe(); } catch {}
      scrollController?.destroy();
      _activeRenderers.delete(instance);
      _container = null;
    },
    scrollToBottom: (options) => scrollController?.scrollToBottom(options),
    isFollowing: () => scrollController?.isFollowing() ?? false,
  };
  _activeRenderers.add(instance);
  doRender();
  return instance;
}

// Back-compat shim — primary panel callers may still expect an unmount API.
export function unmountRenderer() {
  for (const r of _activeRenderers) { try { r.unmount(); } catch {} }
}

const _partSig = partSignature;

function _msgSig(msg) {
  let sig = `m:${msg.role || 'assistant'}`;
  for (const part of visibleParts(msg)) sig += '|' + _partSig(part);
  return sig;
}

// Reconcile container children against `desired` (ordered list). Reuses DOM
// nodes whose ocpv2Sig still matches — replaces, inserts, or moves the rest.
// Replaces the previous "wipe innerHTML and rebuild" hot path that thrashed
// the transcript on every store delta.
function _reconcile(container, desired) {
  const existing = new Map();
  for (const child of [...container.children]) {
    const k = child.dataset?.ocpv2Key;
    if (k) existing.set(k, child);
    else child.remove();
  }
  const wanted = new Set(desired.map(d => d.key));
  for (const [k, el] of existing) {
    if (!wanted.has(k)) { el.remove(); existing.delete(k); }
  }
  let prev = null;
  for (const { key, sig, build } of desired) {
    let node = existing.get(key);
    if (!node || node.dataset.ocpv2Sig !== sig) {
      const fresh = build();
      if (!fresh) continue;
      fresh.dataset.ocpv2Key = key;
      fresh.dataset.ocpv2Sig = sig;
      if (node) {
        container.replaceChild(fresh, node);
      } else if (prev) {
        if (prev.nextSibling) container.insertBefore(fresh, prev.nextSibling);
        else container.appendChild(fresh);
      } else if (container.firstChild) {
        container.insertBefore(fresh, container.firstChild);
      } else {
        container.appendChild(fresh);
      }
      node = fresh;
    } else {
      const expected = prev ? prev.nextSibling : container.firstChild;
      if (node !== expected) {
        if (prev) {
          if (prev.nextSibling) container.insertBefore(node, prev.nextSibling);
          else container.appendChild(node);
        } else if (container.firstChild) {
          container.insertBefore(node, container.firstChild);
        } else {
          container.appendChild(node);
        }
      }
    }
    prev = node;
  }
}

function _buildEmpty() {
  const empty = document.createElement('div');
  empty.className = 'ocpv2-empty ocpv2-empty-brand';
  empty.innerHTML =
    '<svg class="ocpv2-empty-logo" viewBox="0 0 240 300" fill="currentColor" aria-hidden="true">'
    + '<path fill-rule="evenodd" d="M0 0h240v300H0V0zm30 30v240h180V30H30z"/>'
    + '<rect x="30" y="150" width="180" height="120" opacity=".45"/>'
    + '</svg>'
    + '<div class="ocpv2-empty-name">OpenCode</div>';
  return empty;
}

function render(_container, store, opts = {}) {
  if (!_container) return;
  const s = store.getState();
  const actionContext = {
    supports,
    canOpenSessions: typeof opts.onOpenSession === 'function',
    canCompose: typeof opts.onComposeText === 'function' && typeof opts.onSendText === 'function',
  };
  const revertBanner = revertBannerView(s.sessionInfo, s.messageOrder);

  // A card is drawn only for a request of the session on screen or of one of
  // its sub-agents: whatever else is in the queue is not this panel's to answer.
  const permissions = requestsVisibleIn(
    s.pendingPermissions?.length ? s.pendingPermissions : (s.pendingPermission ? [s.pendingPermission] : []),
    s.sessionId, isKnownDescendantSession,
  );
  const questions = requestsVisibleIn(s.pendingQuestions, s.sessionId, isKnownDescendantSession);
  const retry = retryBannerView(s.sessionStatus);
  const hasInteractiveCards = permissions.length > 0 || questions.length > 0 || !!s.showPostPlanActions;
  if (s.messageOrder.length === 0 && !hasInteractiveCards && !s.errors.length && !retry && !revertBanner) {
    _reconcile(_container, [{ key: '__empty__', sig: 'empty', build: _buildEmpty }]);
    return;
  }

  const desired = [];

  let prevAssistantId = null;
  // What was undone (session.revert) stays out of sight until it is restored.
  for (const messageId of visibleMessageOrder(s.messageOrder, s.sessionInfo?.revert)) {
    const msg = s.messages.get(messageId);
    if (!msg) continue;
    const parts = visibleParts(msg);
    if ((msg.role || 'assistant') === 'user') {
      // A user message made only of text OpenCode wrote itself (a shell run,
      // a compaction marker's context) has nothing of the user's to show.
      if (!parts.length) continue;
      prevAssistantId = null;
      // The marker OpenCode leaves where it compacted is a divider, not
      // something the user said.
      if (parts.every((part) => part.type === 'compaction')) {
        desired.push({
          key: `u:${msg.id}`,
          sig: `compaction|${_partSig(parts[0])}`,
          build: () => renderStepMarker(compactionLabel(parts[0])),
        });
        continue;
      }
      const userActions = messageActionsFor(msg, s, actionContext);
      desired.push({
        key: `u:${msg.id}`,
        sig: `${_msgSig(msg)}|${userActions.join(',')}`,
        build: () => renderMessage(msg, store, userActions, opts),
      });
    } else {
      for (const part of parts) {
        const isContinuation = prevAssistantId === msg.id;
        const partKey = part.id || `${part.type}:${part.index ?? ''}`;
        desired.push({
          key: `a:${msg.id}:${partKey}`,
          sig: `${isContinuation ? 'c' : 'h'}|${msg.info?.summary ? 's' : ''}|${_partSig(part)}`,
          build: () => renderAssistantPartBubble(msg, part, isContinuation, store),
        });
        prevAssistantId = msg.id;
      }
      // Under a finished assistant message: what OpenCode says it ran on and
      // cost, then the actions.
      const done = !!msg.info?.time?.completed;
      const assistantActions = parts.length && done ? messageActionsFor(msg, s, actionContext) : [];
      const meta = parts.length && done ? messageMetaText(msg.info) : '';
      if (assistantActions.length || meta) {
        desired.push({
          key: `a:${msg.id}:actions`,
          sig: `act:${assistantActions.join(',')}|${meta}`,
          build: () => renderAssistantActions(msg, store, assistantActions, opts, meta),
        });
      }
      const errorView = messageErrorView(msg.info);
      if (errorView) {
        desired.push({
          key: `a:${msg.id}:error`,
          sig: `e:${errorView.kind}:${errorView.text}`,
          build: () => renderMessageError(msg, errorView, store),
        });
      }
    }
  }

  if (revertBanner) {
    desired.push({
      key: 'revert',
      sig: `revert:${revertBanner.text}:${revertBanner.hasFileChanges ? 'f' : ''}:${s.running ? 'r' : ''}`,
      build: () => renderRevertBanner(revertBanner, store),
    });
  }

  // What /help shows: a card of the panel's own, under the transcript.
  if (s.helpCard) {
    desired.push({
      key: 'help',
      sig: `help:${JSON.stringify(s.helpCard)}`,
      build: () => renderHelpCard(s.helpCard, store),
    });
  }

  // Errors sit at the end of the transcript, where the reader is, and each
  // one can be dismissed.
  for (const err of s.errors) {
    desired.push({
      key: `err:${err.id || err.at}`,
      sig: `err:${String(err?.message || err || '')}`,
      build: () => renderErrorBanner(err, store),
    });
  }

  if (retry) {
    desired.push({
      key: 'retry',
      sig: `retry:${retry.title}:${retry.message}:${retry.nextAt}:${retry.actionLink}`,
      build: () => renderRetryBanner(retry),
    });
  }

  // Every pending request gets its own card, oldest first: a second request
  // (a parallel sub-agent, a second tool) no longer replaces the first.
  for (const p of permissions) {
    desired.push({
      key: `perm:${p.id || p.requestId || 'pending'}`,
      sig: `perm:${p.id || ''}:${p.sessionID || ''}:${p.state || ''}:${p._auto ? 'auto' : ''}:${supports('feature:permission-reply-message') ? 'r' : ''}${supports('permission:saved:list') ? 's' : ''}`,
      build: () => renderPermissionCard(p, store),
    });
  }

  // PLAN COMPLETE card pushes BEFORE pending questions so that when the agent
  // emits both a plan body and a follow-up AskUserQuestion they stack with
  // PLAN COMPLETE on top of the question card.
  if (s.showPostPlanActions) {
    const planLen = (s.editedPlanContent || s.planContent || '').length;
    desired.push({
      key: 'postplan',
      sig: `pp:${s.postPlanHeader || ''}:${planLen}:${s.planMaterializing ? '1' : '0'}:${s.planFilePath || ''}`,
      build: () => renderPostPlanCard(s, store),
    });
  }

  for (const q of questions) {
    desired.push({
      key: `q:${q.id || q.requestId || ''}`,
      sig: `q:${q.id || ''}:${(q.questions?.length || 0)}:${q.answered ? '1' : '0'}`,
      build: () => renderQuestionCard(q, store),
    });
  }

  _reconcile(_container, desired);
}

// The /help card (helpCardView): the plan card's frame around what the
// composer can do. Built from data with textContent; nothing of it is a
// message, and Close takes it away.
function renderHelpCard(view, store) {
  const wrap = document.createElement('div');
  wrap.className = 'ocpv2-post-plan-card ocpv2-help-card';
  const head = document.createElement('div');
  head.className = 'ocpv2-post-plan-header';
  head.textContent = view.title || 'Help';
  wrap.appendChild(head);
  if (view.note) {
    const note = document.createElement('div');
    note.className = 'ocpv2-post-plan-note';
    note.textContent = view.note;
    wrap.appendChild(note);
  }
  for (const section of Array.isArray(view.sections) ? view.sections : []) {
    const title = document.createElement('div');
    title.className = 'ocpv2-session-menu-note';
    title.textContent = section.title || '';
    wrap.appendChild(title);
    for (const row of section.rows || []) {
      const line = document.createElement('div');
      line.className = 'ocpv2-help-row';
      const name = document.createElement('code');
      name.className = 'ocpv2-help-name';
      name.textContent = row.name || '';
      const text = document.createElement('span');
      text.className = 'ocpv2-help-text';
      text.textContent = row.text || '';
      line.append(name, text);
      if (row.source) {
        const source = document.createElement('span');
        source.className = 'ocpv2-session-item-meta';
        source.textContent = row.source;
        line.appendChild(source);
      }
      wrap.appendChild(line);
    }
  }
  const actions = document.createElement('div');
  actions.className = 'ocpv2-post-plan-actions';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'ocpv2-post-plan-btn';
  close.textContent = 'Close';
  close.addEventListener('click', () => store.setHelpCard?.(null));
  actions.appendChild(close);
  wrap.appendChild(actions);
  return wrap;
}

function renderPostPlanCard(s, store) {
  const wrap = document.createElement('div');
  wrap.className = 'ocpv2-post-plan-card';

  const head = document.createElement('div');
  head.className = 'ocpv2-post-plan-header';
  head.textContent = s.postPlanHeader || 'PLAN COMPLETE';
  wrap.appendChild(head);

  const note = document.createElement('div');
  note.className = 'ocpv2-post-plan-note';
  note.textContent = 'Plan ready. Continue into implementation, keep planning, compact, or reopen the plan in the editor.';
  wrap.appendChild(note);

  const planText = String(s.editedPlanContent || s.planContent || '').trim();
  if (planText) {
    const content = document.createElement('div');
    content.className = 'ocpv2-post-plan-content';
    content.innerHTML = renderMarkdown(planText);
    wrap.appendChild(content);
  }

  if (s.planFilePath) {
    const saved = document.createElement('div');
    saved.className = 'ocpv2-post-plan-saved';
    const rel = String(s.planFilePath).replace(/^.*\/(data\/plans\/[^/]+\/[^/]+)$/, '$1');
    saved.textContent = `Saved to ${rel || s.planFilePath}`;
    wrap.appendChild(saved);
  }

  const actions = document.createElement('div');
  actions.className = 'ocpv2-post-plan-actions';
  wrap.appendChild(actions);

  const addButton = (label, action, cls = '', disabled = false) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `ocpv2-post-plan-btn ${cls}`.trim();
    btn.textContent = label;
    btn.disabled = !!disabled;
    btn.addEventListener('click', () => {
      // The plan card is this binding's: so is what its action reports.
      const at = captureBinding(store);
      handlePostPlanAction(action, store).catch((err) => {
        if (at.isCurrent()) store.pushError({ message: err?.message || 'Plan action failed' });
      });
    });
    actions.appendChild(btn);
  };

  addButton('Continue with implementation', 'continue', 'primary');
  addButton('Continue planning', 'continue-planning');
  addButton(s.planMaterializing ? 'Preparing plan...' : 'Edit plan', 'edit', '', s.planMaterializing);
  addButton('Compact context', 'compact');

  return wrap;
}

// ── Per-message render ───────────────────────────────────────────────────────

function renderMessage(msg, store, actions = [], opts = {}) {
  const wrap = document.createElement('div');
  wrap.className = `ocpv2-msg ocpv2-msg-${msg.role || 'assistant'}`;
  wrap.dataset.messageId = msg.id;

  const role = document.createElement('div');
  role.className = 'ocpv2-msg-role';
  role.textContent = msg.role === 'user' ? 'You' : 'OpenCode';
  wrap.appendChild(role);

  for (const part of visibleParts(msg)) {
    const el = renderPart(part, store);
    if (el) wrap.appendChild(el);
  }
  const bar = renderMessageActions(msg, store, actions, opts);
  if (bar) wrap.appendChild(bar);
  return wrap;
}

// ── Message actions (copy / undo / fork / delete / retry) ───────────────────

const ACTION_LABELS = {
  copy: 'Copy',
  undo: 'Undo to here',
  fork: 'Fork from here',
  delete: 'Delete',
  retry: 'Retry',
};

function renderMessageActions(msg, store, actions, opts) {
  if (!actions || !actions.length) return null;
  const bar = document.createElement('div');
  bar.className = 'ocpv2-msg-actions';
  for (const action of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ocpv2-msg-action';
    btn.dataset.action = action;
    btn.textContent = ACTION_LABELS[action] || action;
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      btn.disabled = true;
      // A failure is reported in the session the action was clicked in.
      const at = captureBinding(store);
      try { await runMessageAction(action, msg, store, opts, btn); }
      catch (err) { if (at.isCurrent()) store.pushError({ message: err?.message || `${ACTION_LABELS[action] || action} failed` }); }
      finally { btn.disabled = false; }
    });
    bar.appendChild(btn);
  }
  return bar;
}

// The actions of an assistant message hang under its last bubble.
function renderAssistantActions(msg, store, actions, opts, meta = '') {
  const wrap = document.createElement('div');
  wrap.className = 'ocpv2-msg ocpv2-msg-assistant ocpv2-msg-continuation ocpv2-msg-actions-row';
  wrap.dataset.messageId = msg.id;
  if (meta) {
    const line = document.createElement('div');
    line.className = 'ocpv2-msg-meta';
    line.textContent = meta;
    line.setAttribute('data-tooltip', 'Model, agent, tokens and cost as reported by OpenCode');
    wrap.appendChild(line);
  }
  const bar = renderMessageActions(msg, store, actions, opts);
  if (bar) wrap.appendChild(bar);
  return wrap;
}

async function copyText(text, btn, done = 'Copied') {
  await navigator.clipboard.writeText(text);
  if (!btn) return;
  const label = btn.textContent;
  btn.textContent = done;
  setTimeout(() => { if (btn.isConnected) btn.textContent = label; }, 1200);
}

async function runMessageAction(action, msg, store, opts, btn) {
  // `moved`: the panel went to another session while the action was out. Its
  // result is dropped: no banner, no prompt in the composer, nothing sent.
  const report = (result, fallback) => {
    if (result && result.ok === false && !result.cancelled && !result.moved) store.pushError({ message: result.error || fallback });
    return result;
  };
  switch (action) {
    case 'copy':
      await copyText(messageText(msg), btn);
      return;
    case 'undo': {
      const result = report(await revertToMessage(store, api, msg.id), 'Undo failed');
      if (result?.ok && (result.text || result.files?.length)) {
        opts.onComposeText?.(result.text, { files: result.files, resources: result.resources, resourceList: result.resourceList });
      }
      return;
    }
    case 'retry':
      report(await retryFromMessage(store, api, msg.id, (text, extra) => opts.onSendText(text, extra)), 'Retry failed');
      return;
    case 'fork': {
      // The click is a navigation (opts.onNavigate hands out its intent): the
      // fork takes the panel only while it is still the user's latest choice.
      const nav = opts.onNavigate?.();
      const result = report(await forkSession(store, api, msg.id), 'Fork failed');
      // A fork made while the user moved on is kept as a tab, not put on screen.
      if (result?.ok) await opts.onOpenSession?.(result.session, { activate: !result.moved, nav });
      return;
    }
    case 'delete': {
      // Two steps, both in the panel: this click only asks, naming the
      // message. A panel that cannot ask deletes nothing.
      const agreed = typeof opts.confirm === 'function' && (await opts.confirm({
        key: `message-delete:${msg.id}`, text: deleteMessageConfirmText(msg), confirmLabel: 'Delete message',
      })) === true;
      if (!agreed) return;
      report(await deleteMessage(store, api, msg.id), 'Delete failed');
      return;
    }
    default:
  }
}

// What session.revert undid, with the way back.
function renderRevertBanner(view, store) {
  const el = document.createElement('div');
  el.className = 'ocpv2-retry-banner ocpv2-revert-banner';
  const text = document.createElement('span');
  text.className = 'ocpv2-retry-message';
  text.textContent = view.hasFileChanges ? `${view.text} File changes of those turns were rolled back too.` : view.text;
  el.appendChild(text);
  if (supports('session:unrevert')) {
    const restore = inlineAction('Restore', async () => {
      const result = await restoreReverted(store, api);
      if (!result.ok && !result.moved) store.pushError({ message: result.error || 'Restore failed' });
    }, store);
    restore.disabled = !!store.getState().running;
    el.appendChild(restore);
  }
  return el;
}

// One assistant bubble per part — each tool use / text / reasoning row reads
// as its own response. Continuation bubbles (subsequent parts of the same
// message) drop the avatar + role so the column reads as one calm thread.
function renderAssistantPartBubble(msg, part, isContinuation, store) {
  if (part.type === 'step-start' || part.type === 'step-finish') return null;
  const partEl = renderPart(part, store);
  if (!partEl) return null;

  const wrap = document.createElement('div');
  const cls = ['ocpv2-msg', 'ocpv2-msg-assistant', `ocpv2-msg-part-${part.type || 'other'}`];
  if (isContinuation) cls.push('ocpv2-msg-continuation');
  wrap.className = cls.join(' ');
  wrap.dataset.messageId = msg.id;
  wrap.dataset.partId = part.id || '';

  if (!isContinuation) {
    const role = document.createElement('div');
    role.className = 'ocpv2-msg-role';
    // The assistant message that follows a compaction is its summary.
    role.textContent = msg.info?.summary ? 'OpenCode · summary' : 'OpenCode';
    wrap.appendChild(role);
  }

  wrap.appendChild(partEl);
  return wrap;
}

function renderPart(part, store) {
  switch (part.type) {
    case 'text':         return renderTextPart(part);
    case 'reasoning':    return renderReasoningPart(part);
    case 'tool':         return renderToolPart(part, store);
    case 'file':         return renderFilePart(part);
    case 'step-start':   return renderStepMarker('Step start');
    case 'step-finish':  return renderStepMarker('Step finish');
    case 'compaction':   return renderStepMarker(compactionLabel(part));
    case 'retry':        return renderNotePart(retryPartText(part), 'ocpv2-part-note-warn');
    case 'subtask':
    case 'agent':
    case 'patch':        return renderNotePart(inlinePartText(part));
    default:             return renderUnknownPart(part);
  }
}

// ── Part renderers ───────────────────────────────────────────────────────────

function renderTextPart(part) {
  const el = document.createElement('div');
  el.className = 'ocpv2-part ocpv2-part-text';
  el.innerHTML = renderMarkdown(part.text || '');
  decorateCodeBlocks(el);
  return el;
}

// A Copy button on every fenced block.
function decorateCodeBlocks(root) {
  for (const pre of root.querySelectorAll('pre')) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ocpv2-code-copy';
    btn.textContent = 'Copy';
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const code = pre.querySelector('code');
      copyText((code || pre).textContent || '', btn).catch(() => {});
    });
    pre.classList.add('ocpv2-code-block');
    pre.appendChild(btn);
  }
}

function renderReasoningPart(part) {
  const streaming = !part?.time?.end;
  // While streaming → single thin row with an animated "Thinking…" label
  // (no body, no container — matches CLI feel).
  // After streaming → click-to-expand "Thought" details for review.
  if (streaming) {
    const row = document.createElement('div');
    row.className = 'ocpv2-part ocpv2-thinking-row';
    const dot = document.createElement('span');
    dot.className = 'ocpv2-thinking-dot';
    const label = document.createElement('span');
    label.className = 'ocpv2-thinking-label';
    label.textContent = 'Thinking';
    const ellipsis = document.createElement('span');
    ellipsis.className = 'ocpv2-thinking-ellipsis';
    ellipsis.innerHTML = '<span>.</span><span>.</span><span>.</span>';
    row.appendChild(dot);
    row.appendChild(label);
    row.appendChild(ellipsis);
    // Reasoning streams in as deltas: show where the model's thinking is now.
    const preview = reasoningPreview(part.text);
    if (!preview) return row;
    const live = document.createElement('div');
    live.className = 'ocpv2-part ocpv2-thinking-live';
    live.appendChild(row);
    const text = document.createElement('div');
    text.className = 'ocpv2-thinking-preview';
    text.textContent = preview;
    live.appendChild(text);
    return live;
  }
  const wrap = document.createElement('details');
  wrap.className = 'ocpv2-part ocpv2-part-reasoning';
  const key = reasoningPartKey(part);
  if (_expandedReasoningIds.has(key)) wrap.open = true;
  const summary = document.createElement('summary');
  summary.className = 'ocpv2-reasoning-summary';
  summary.addEventListener('click', () => {
    if (wrap.open) _expandedReasoningIds.delete(key);
    else _expandedReasoningIds.add(key);
  });
  const label = document.createElement('span');
  label.textContent = 'Thought';
  summary.appendChild(label);
  wrap.appendChild(summary);
  wrap.addEventListener('toggle', () => {
    if (wrap.open) _expandedReasoningIds.add(key);
    else _expandedReasoningIds.delete(key);
  });
  const body = document.createElement('div');
  body.className = 'ocpv2-reasoning-body';
  body.innerHTML = renderMarkdown(part.text || '');
  wrap.appendChild(body);
  return wrap;
}

function reasoningPartKey(part) {
  const msgId = part?.messageID || part?.messageId || 'message';
  const partId = part?.id || part?.partID || part?.partId || '';
  if (partId) return `${msgId}:${partId}`;
  return `${msgId}:reasoning:${String(part?.text || '').slice(0, 120)}`;
}

const QUESTION_TOOL_NAMES = new Set(['question', 'askuserquestion', 'ask_user_question', 'ask_user', 'user_question']);

function isQuestionToolName(name) {
  const key = String(name || '').toLowerCase().replace(/[^a-z_]/g, '');
  return QUESTION_TOOL_NAMES.has(key);
}

function extractQuestionsFromToolInput(input) {
  if (!input || typeof input !== 'object') return [];
  if (Array.isArray(input.questions) && input.questions.length) return input.questions;
  if (input.question || Array.isArray(input.options)) return [input];
  return [];
}

// ── SynaBun MCP tool branding ────────────────────────────────────────────────
const SYNABUN_LOGO_HTML = '<img src="logoHD.png" alt="" style="width:14px;height:14px;object-fit:contain;">';

const SYNABUN_LABELS = {
  recall: 'Recall', remember: 'Remember', reflect: 'Reflect',
  forget: 'Forget', restore: 'Restore', memories: 'Memories', sync: 'Sync',
  category: 'Category', loop: 'Loop', git: 'Git', tictactoe: 'TicTacToe',
  image_staged: 'Images', profile: 'Profile',
  browser_navigate: 'Browser · Navigate', browser_screenshot: 'Browser · Screenshot', browser_console: 'Browser · Console',
  browser_snapshot: 'Browser · Snapshot', browser_content: 'Browser · Content',
  browser_click: 'Browser · Click', browser_type: 'Browser · Type',
  browser_fill: 'Browser · Fill', browser_hover: 'Browser · Hover',
  browser_select: 'Browser · Select', browser_press: 'Browser · Press',
  browser_scroll: 'Browser · Scroll', browser_wait: 'Browser · Wait',
  browser_go_back: 'Browser · Back', browser_go_forward: 'Browser · Forward',
  browser_reload: 'Browser · Reload', browser_evaluate: 'Browser · Evaluate',
  browser_upload: 'Browser · Upload', browser_session: 'Browser · Session',
  browser_cheatsheet: 'Browser · Cheatsheet',
  browser_extract_tweets: 'Extract · Tweets', browser_extract_fb_posts: 'Extract · Facebook',
  browser_fb_composer_state: 'Facebook · Composer', browser_extract_fb_groups: 'Extract · FB Groups',
  browser_extract_ig_feed: 'Extract · Instagram', browser_extract_ig_post: 'Extract · IG Post',
  browser_extract_ig_reels: 'Extract · IG Reels', browser_extract_ig_profile: 'Extract · IG Profile',
  browser_extract_ig_search: 'Extract · IG Search',
  browser_extract_tiktok_videos: 'Extract · TikTok', browser_extract_tiktok_search: 'Extract · TikTok Search',
  browser_extract_tiktok_studio: 'Extract · TikTok Studio', browser_extract_tiktok_profile: 'Extract · TikTok Profile',
  browser_extract_li_feed: 'Extract · LinkedIn', browser_extract_li_profile: 'Extract · LI Profile',
  browser_extract_li_post: 'Extract · LI Post', browser_extract_li_notifications: 'Extract · LI Notifications',
  browser_extract_li_messages: 'Extract · LI Messages', browser_extract_li_search_people: 'Extract · LI People',
  browser_extract_li_network: 'Extract · LI Network', browser_extract_li_jobs: 'Extract · LI Jobs',
  browser_extract_wa_chats: 'Extract · WhatsApp', browser_extract_wa_messages: 'Extract · WA Messages',
  bluesky_session: 'BlueSky · Session', bluesky_timeline: 'BlueSky · Timeline',
  bluesky_author_feed: 'BlueSky · Author Feed', bluesky_thread: 'BlueSky · Thread',
  bluesky_profile: 'BlueSky · Profile', bluesky_search_posts: 'BlueSky · Search Posts',
  bluesky_search_actors: 'BlueSky · Search Users', bluesky_notifications: 'BlueSky · Notifications',
  bluesky_graph: 'BlueSky · Graph', bluesky_likes: 'BlueSky · Likes', bluesky_feed: 'BlueSky · Feed',
  bluesky_post: 'BlueSky · Post', bluesky_action: 'BlueSky · Action',
  bluesky_resolve: 'BlueSky · Resolve', bluesky_dm: 'BlueSky · DM',
  whiteboard_read: 'Whiteboard · Read', whiteboard_add: 'Whiteboard · Add',
  whiteboard_update: 'Whiteboard · Update', whiteboard_remove: 'Whiteboard · Remove',
  whiteboard_screenshot: 'Whiteboard · Screenshot',
  card_list: 'Cards · List', card_open: 'Cards · Open', card_close: 'Cards · Close',
  card_update: 'Cards · Update', card_screenshot: 'Cards · Screenshot',
  discord_guild: 'Discord · Guild', discord_channel: 'Discord · Channel',
  discord_role: 'Discord · Role', discord_message: 'Discord · Message',
  discord_member: 'Discord · Member', discord_onboarding: 'Discord · Onboarding',
  discord_webhook: 'Discord · Webhook', discord_thread: 'Discord · Thread',
  leonardo_browser_navigate: 'Leonardo · Navigate', leonardo_browser_generate: 'Leonardo · Generate',
  leonardo_browser_library: 'Leonardo · Library', leonardo_browser_download: 'Leonardo · Download',
  leonardo_browser_reference: 'Leonardo · Reference',
};

function isSynaBunTool(name) {
  return typeof name === 'string' && (name.startsWith('mcp__SynaBun__') || name.startsWith('SynaBun_'));
}

function synabunToolKey(name) {
  return (name || '').replace(/^mcp__SynaBun__/, '').replace(/^SynaBun_/, '');
}

function synabunDisplayName(name) {
  const key = synabunToolKey(name);
  return SYNABUN_LABELS[key] || (key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' '));
}

function _truncate(s, n = 90) {
  const str = String(s || '').replace(/\s+/g, ' ').trim();
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function synabunSummaryText(name, input) {
  if (!input || typeof input !== 'object') return '';
  const key = synabunToolKey(name);
  const t = (s) => _truncate(s, 90);
  switch (key) {
    case 'recall':    return t(input.query);
    case 'remember':  return t(input.content);
    case 'reflect':   return t(input.content || input.memory_id);
    case 'forget':
    case 'restore':   return t(input.memory_id);
    case 'memories':  return t(input.action);
    case 'category':  return t(`${input.action || ''}${input.name ? ' · ' + input.name : ''}`);
    case 'sync':      return '';
    case 'git':       return t(input.action);
    case 'loop':      return t(`${input.action || ''}${input.prompt ? ' · ' + input.prompt : ''}`);
    case 'browser_navigate': return t(input.url);
    case 'browser_click':
    case 'browser_hover':   return t(input.selector || input.label);
    case 'browser_type':
    case 'browser_fill':    return t(input.text || input.value || input.selector);
    case 'browser_select':  return t(input.value || input.selector);
    case 'browser_press':   return t(input.key);
    case 'browser_scroll':  return t(input.direction || input.selector);
    case 'browser_evaluate': return t(input.script);
    case 'browser_session': return t(input.action);
    case 'image_staged':    return t(input.action);
    case 'discord_message': return t(input.content || input.action);
    case 'discord_channel':
    case 'discord_member':
    case 'discord_role':    return t(input.action || input.name);
    case 'whiteboard_add':
    case 'whiteboard_update': return t(input.content || input.title);
    case 'card_open':
    case 'card_update':     return t(input.title || input.id);
    case 'leonardo_browser_generate': return t(input.prompt);
    default:                return '';
  }
}

// Persist expand/collapse state across re-renders (render() rebuilds DOM).
const _expandedToolIds = new Set();
const SYNABUN_CHEVRON_SVG = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';

function renderSynaBunToolPart(part, toolName, stateStatus) {
  const callId = part.callID || part.id || part.toolCallId || part.tool_use_id || `sb-${toolName}`;
  const expanded = _expandedToolIds.has(callId);

  const wrap = document.createElement('div');
  wrap.className = 'ocpv2-part ocpv2-part-tool ocpv2-tool-synabun' + (expanded ? ' ocpv2-tool-expanded' : '');
  wrap.dataset.toolId = callId;
  wrap.dataset.status = stateStatus;

  const head = document.createElement('div');
  head.className = 'ocpv2-tool-head ocpv2-sb-head';

  const icon = document.createElement('span');
  icon.className = 'ocpv2-sb-icon';
  icon.innerHTML = SYNABUN_LOGO_HTML;
  head.appendChild(icon);

  const titles = document.createElement('span');
  titles.className = 'ocpv2-sb-titles';
  const name = document.createElement('span');
  name.className = 'ocpv2-tool-name ocpv2-sb-name';
  name.textContent = synabunDisplayName(toolName);
  titles.appendChild(name);

  const input = part.state?.input ?? part.input;
  const summary = synabunSummaryText(toolName, input || {});
  if (summary) {
    const sub = document.createElement('span');
    sub.className = 'ocpv2-sb-summary';
    sub.textContent = summary;
    titles.appendChild(sub);
  }
  head.appendChild(titles);

  const status = document.createElement('span');
  status.className = `ocpv2-tool-status ocpv2-tool-${stateStatus}`;
  status.textContent = stateStatus;
  head.appendChild(status);

  const chevron = document.createElement('span');
  chevron.className = 'ocpv2-sb-chevron';
  chevron.innerHTML = SYNABUN_CHEVRON_SVG;
  head.appendChild(chevron);

  head.addEventListener('click', () => {
    if (_expandedToolIds.has(callId)) {
      _expandedToolIds.delete(callId);
      wrap.classList.remove('ocpv2-tool-expanded');
    } else {
      _expandedToolIds.add(callId);
      wrap.classList.add('ocpv2-tool-expanded');
    }
  });
  wrap.appendChild(head);

  const body = document.createElement('div');
  body.className = 'ocpv2-sb-body';

  if (input !== undefined) {
    const inp = document.createElement('div');
    inp.className = 'ocpv2-tool-input';
    inp.textContent = formatJson(input);
    body.appendChild(inp);
  }

  const output = part.state?.output ?? part.output;
  const error = part.state?.error ?? part.error;
  if (error) {
    const errEl = document.createElement('div');
    errEl.className = 'ocpv2-tool-output ocpv2-tool-output-error';
    errEl.textContent = typeof error === 'string' ? error : formatJson(error);
    body.appendChild(errEl);
  } else if (output !== undefined && output !== null) {
    appendToolOutput(body, output);
  }

  wrap.appendChild(body);
  return wrap;
}

// Render an MCP tool result. Tools like browser_screenshot / card_screenshot /
// whiteboard_screenshot / leonardo_* return `{ content: [text, image] }`,
// which arrives here as an array (or a JSON string of one). Render image
// blocks as actual <img> elements; render text blocks as their text; fall
// back to formatJson for anything else.
function appendToolOutput(body, output) {
  const blocks = parseMcpContentBlocks(output);
  if (blocks) {
    for (const b of blocks) {
      if (b.type === 'image' && b.data) {
        const wrap = document.createElement('div');
        wrap.className = 'ocpv2-tool-output ocpv2-tool-output-image';
        const img = document.createElement('img');
        img.className = 'ocpv2-tool-screenshot';
        img.src = `data:${b.mimeType || b.media_type || 'image/jpeg'};base64,${b.data}`;
        img.alt = 'screenshot';
        img.loading = 'lazy';
        wrap.appendChild(img);
        body.appendChild(wrap);
      } else if ((b.type === 'text' || b.text) && b.text) {
        const t = document.createElement('div');
        t.className = 'ocpv2-tool-output';
        t.textContent = String(b.text);
        body.appendChild(t);
      }
    }
    return;
  }
  const out = document.createElement('div');
  out.className = 'ocpv2-tool-output';
  out.textContent = typeof output === 'string' ? output : formatJson(output);
  body.appendChild(out);
}

function parseMcpContentBlocks(output) {
  let arr = null;
  if (Array.isArray(output)) arr = output;
  else if (output && typeof output === 'object' && Array.isArray(output.content)) arr = output.content;
  else if (typeof output === 'string') {
    const trimmed = output.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) arr = parsed;
        else if (parsed && Array.isArray(parsed.content)) arr = parsed.content;
      } catch {}
    }
  }
  if (!arr || !arr.length) return null;
  // Only treat as MCP content if at least one block has a recognisable shape.
  const looksMcp = arr.some((b) => b && (b.type === 'image' || b.type === 'text' || typeof b.text === 'string'));
  return looksMcp ? arr : null;
}

function renderToolPart(part, store) {
  const toolName = part.tool || part.name || '';
  const stateStatus = part.state?.status || part.status || 'pending';

  // OpenCode's `question` tool may arrive both as a tool part and as a
  // `question.asked` request. The reply must go through `/question/{id}/reply`;
  // sending a normal prompt only queues behind the running turn.
  if (isQuestionToolName(toolName)) {
    if (stateStatus === 'completed' || stateStatus === 'error') {
      const done = document.createElement('div');
      done.className = 'ocpv2-part ocpv2-part-question-stub';
      done.textContent = 'Question answered.';
      return done;
    }
    // Dedup: if an SSE-driven QuestionRequest exists whose tool.callID matches
    // this tool part, let the pendingQuestions render handle it instead.
    const partCallId = part.callID || part.id;
    const sseMatch = (store.getState().pendingQuestions || []).find(
      (q) => q?.tool?.callID && partCallId && String(q.tool.callID) === String(partCallId)
    );
    if (sseMatch) {
      const stub = document.createElement('div');
      stub.className = 'ocpv2-part ocpv2-part-question-stub';
      stub.textContent = 'Awaiting your answer…';
      return stub;
    }
    const input = part.state?.input ?? part.input ?? {};
    const questions = extractQuestionsFromToolInput(input);
    if (!questions.length) {
      const stub = document.createElement('div');
      stub.className = 'ocpv2-part ocpv2-part-question-stub';
      stub.textContent = 'Awaiting your answer…';
      return stub;
    }
    // The card belongs to the session the part is in. A part of any other
    // session (however it reached this store) gets no card to answer from.
    const synthetic = transcriptQuestionCard(store, part, questions);
    if (!synthetic) {
      const stub = document.createElement('div');
      stub.className = 'ocpv2-part ocpv2-part-question-stub';
      stub.textContent = 'Awaiting your answer…';
      return stub;
    }
    if (isQuestionSubmitted(synthetic.id)) {
      const done = document.createElement('div');
      done.className = 'ocpv2-part ocpv2-part-question-stub';
      done.textContent = 'Question answer submitted.';
      return done;
    }
    return renderQuestionCard(synthetic, store);
  }

  if (isSynaBunTool(toolName)) {
    return renderSynaBunToolPart(part, toolName, stateStatus);
  }

  // Everything else: a collapsible card (ocp-v2-tools.js).
  return renderToolCard(part, {
    contentBlocks: (output) => {
      if (!parseMcpContentBlocks(output)) return null;
      const holder = document.createElement('div');
      appendToolOutput(holder, output);
      return holder;
    },
    onOpenChild: _rendererOpts.get(store)?.onOpenChild || null,
  });
}

function renderFilePart(part) {
  const mime = part.mime || part.media_type || part.mediaType || part.contentType || '';
  const url = part.url || part.dataUrl || '';
  const filename = part.filename || part.name || 'image';
  const isImage = (typeof mime === 'string' && mime.startsWith('image/'))
    || /^data:image\//.test(url);

  if (isImage && url) {
    const wrap = document.createElement('div');
    wrap.className = 'ocpv2-part ocpv2-part-image-wrap';
    const img = document.createElement('img');
    img.className = 'ocpv2-part-image';
    img.src = url;
    img.alt = filename;
    img.loading = 'lazy';
    wrap.appendChild(img);
    return wrap;
  }

  const el = document.createElement('div');
  el.className = 'ocpv2-part ocpv2-part-file';
  el.textContent = `📎 ${filename || part.url || 'file'}`;
  return el;
}

function renderStepMarker(label) {
  const el = document.createElement('div');
  el.className = 'ocpv2-part ocpv2-part-step';
  el.textContent = label;
  return el;
}

// A part type this panel has no dedicated view for yet.
function renderUnknownPart(part) {
  return renderNotePart(`[${part.type || 'unknown'} part]`);
}

// One muted line: subtask / agent / patch markers, retries.
function renderNotePart(text, extraClass = '') {
  if (!text) return null;
  const el = document.createElement('div');
  el.className = `ocpv2-part ocpv2-part-note ${extraClass}`.trim();
  el.textContent = text;
  return el;
}

// The error an assistant message ended with (AssistantMessage.error).
function renderMessageError(msg, view, store) {
  const wrap = document.createElement('div');
  wrap.className = `ocpv2-msg ocpv2-msg-assistant ocpv2-msg-continuation ocpv2-msg-error ocpv2-msg-error-${view.kind}`;
  wrap.dataset.messageId = msg.id;
  const row = document.createElement('div');
  row.className = view.kind === 'aborted' ? 'ocpv2-part ocpv2-part-note' : 'ocpv2-part ocpv2-message-error';
  const text = document.createElement('span');
  text.className = 'ocpv2-message-error-text';
  text.textContent = view.text;
  row.appendChild(text);
  if (view.action === 'compact') {
    row.appendChild(inlineAction('Compact context', async () => {
      const at = captureBinding(store);
      if (!at.sessionId) return;
      const res = await api.compact({
        sessionId: at.sessionId, cwd: at.cwd || undefined, mcpProfile: at.mcpProfile || undefined, model: at.model || undefined,
      });
      if (at.isCurrent() && (res?.error || res?.ok === false)) store.pushError({ message: res?.error || 'Compact failed' });
    }, store));
  } else if (view.action === 'settings') {
    row.appendChild(inlineAction('Open Settings', () => openProviderSettings(), store));
  }
  wrap.appendChild(row);
  return wrap;
}

function inlineAction(label, onClick, store) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ocpv2-inline-action';
  btn.textContent = label;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const at = store ? captureBinding(store) : null;
    try { await onClick(); }
    catch (err) { if (!at || at.isCurrent()) store?.pushError?.({ message: err?.message || `${label} failed` }); }
    finally { btn.disabled = false; }
  });
  return btn;
}

// OpenCode is waiting to retry a failed provider call (session.status retry).
function renderRetryBanner(view) {
  const el = document.createElement('div');
  el.className = 'ocpv2-retry-banner';
  const title = document.createElement('span');
  title.className = 'ocpv2-retry-title';
  title.textContent = view.nextAt
    ? `${view.title} · next try ${new Date(view.nextAt).toLocaleTimeString()}`
    : view.title;
  el.appendChild(title);
  if (view.message) {
    const msg = document.createElement('span');
    msg.className = 'ocpv2-retry-message';
    msg.textContent = view.message;
    el.appendChild(msg);
  }
  if (view.actionLink) {
    const link = document.createElement('a');
    link.className = 'ocpv2-inline-action';
    link.href = view.actionLink;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = view.actionLabel || 'Open';
    el.appendChild(link);
  }
  return el;
}

// ── Permission card ──────────────────────────────────────────────────────────

// What the user typed into "Reject with a reason", by request id (like the
// question card's selections below): kept for as long as that request is
// open, and never dropped to make room. It goes when the request does: this
// card's own reply, an answer from anywhere else (`permission.replied`
// reaches every page, whatever session is on screen), the session being
// deleted, or the server's list of open requests no longer naming it.
const _permissionReasons = createCardDrafts();
const permissionKeyOf = (perm) => String(perm?.id || perm?.requestID || perm?.permissionID || '');
onEvent((eventType, ev) => {
  if (eventType === 'permission.replied') _permissionReasons.clear(permissionKeyOf(ev));
  else if (eventType === 'session.deleted') _permissionReasons.forgetSession(ev?.info?.id || ev?.sessionID || ev?.sessionId);
});
function settlePermissionReasons(state) {
  if (!state?.sessionId) return;
  _permissionReasons.settle(state.sessionId, (state.pendingPermissions || []).map(permissionKeyOf));
}

function renderPermissionCard(perm, store) {
  const reasonKey = permissionKeyOf(perm);
  // The session the request belongs to (a sub-agent's own, when it is one).
  const reasonOwner = String(perm?.sessionID || perm?.sessionId || store.getState().sessionId || '');
  // OpenCode Permission.Request schema mirrors V1: { id, sessionID, permission, patterns[], metadata, tool?:{messageID,callID} }
  // `perm.permission` may be the type STRING (e.g. "bash") OR a nested object.
  const inner = (perm.permission && typeof perm.permission === 'object') ? perm.permission : perm;
  const permType = String(inner.permission || inner.type || perm.tool || '').toLowerCase();
  const patterns = Array.isArray(inner.patterns)
    ? inner.patterns.filter(Boolean)
    : (inner.pattern ? [inner.pattern] : []);
  const metadata = (inner.metadata && typeof inner.metadata === 'object') ? inner.metadata : {};
  const callID = inner.tool?.callID || inner.tool?.callId || perm.tool?.callID || perm.tool?.callId || '';

  const info = describePermission(permType, patterns, metadata, callID, store);
  const view = permissionCardView(perm, { sessionId: store.getState().sessionId });

  // Auto-accept is answering this one: a line, not a card.
  if (view.auto) {
    return renderNotePart(`Auto-accepting: ${info.kind}${info.target ? ` · ${_truncate(info.target, 120)}` : ''}`);
  }

  const wrap = document.createElement('div');
  wrap.className = 'ocpv2-permission';

  const head = document.createElement('div');
  head.className = 'ocpv2-permission-head';
  const icon = document.createElement('span');
  icon.className = 'ocpv2-permission-icon';
  icon.innerHTML = info.icon;
  const headText = document.createElement('span');
  headText.className = 'ocpv2-permission-head-text';
  const kindEl = document.createElement('span');
  kindEl.className = 'ocpv2-permission-kind';
  kindEl.textContent = info.kind;
  const actionEl = document.createElement('span');
  actionEl.className = 'ocpv2-permission-action';
  actionEl.textContent = info.action;
  headText.appendChild(kindEl);
  headText.appendChild(actionEl);
  head.appendChild(icon);
  head.appendChild(headText);
  if (view.fromSubagent) {
    const origin = document.createElement('span');
    origin.className = 'ocpv2-permission-origin';
    origin.textContent = 'Sub-agent';
    head.appendChild(origin);
  }
  wrap.appendChild(head);

  const body = document.createElement('div');
  body.className = 'ocpv2-permission-body';

  if (info.target) {
    const target = document.createElement('div');
    target.className = 'ocpv2-permission-target';
    const code = document.createElement('code');
    code.textContent = info.target;
    target.appendChild(code);
    body.appendChild(target);
  }

  if (info.patternsOut && info.patternsOut.length) {
    const pat = document.createElement('div');
    pat.className = 'ocpv2-permission-patterns';
    const label = document.createElement('span');
    label.className = 'ocpv2-permission-patterns-label';
    label.textContent = 'Matches';
    pat.appendChild(label);
    for (const p of info.patternsOut) {
      const c = document.createElement('code');
      c.textContent = p;
      pat.appendChild(c);
    }
    body.appendChild(pat);
  }

  if (info.diff) {
    const det = document.createElement('details');
    det.className = 'ocpv2-permission-diff';
    const sum = document.createElement('summary');
    sum.textContent = 'Show diff';
    const pre = document.createElement('pre');
    pre.textContent = info.diff;
    det.appendChild(sum);
    det.appendChild(pre);
    body.appendChild(det);
  }

  const actions = document.createElement('div');
  actions.className = 'ocpv2-permission-actions';

  const lock = () => wrap.classList.add('ocpv2-perm-locked');
  const unlock = () => wrap.classList.remove('ocpv2-perm-locked');

  // Lock optimistically, but un-grey on a genuine failure so the card stays
  // clickable for a retry instead of freezing the turn forever. On success the
  // SSE permission.replied event clears pendingPermission and removes the card.
  const respond = async (response, message) => {
    lock();
    const ok = await safeReply(perm, response, store, message);
    if (!ok) unlock();
    else _permissionReasons.clear(reasonKey);
  };

  const allowOnce = button('Allow once', 'ocpv2-perm-allow', () => respond('once'));
  const allowAlways = button('Always allow', 'ocpv2-perm-allow', () => respond('always'));
  const reject = button('Reject', 'ocpv2-perm-reject', () => respond('reject'));
  actions.appendChild(allowOnce);
  actions.appendChild(allowAlways);
  actions.appendChild(reject);
  body.appendChild(actions);

  // What "Always allow" will stop asking about.
  if (view.always.length) {
    const always = document.createElement('div');
    always.className = 'ocpv2-permission-always';
    always.appendChild(document.createTextNode('Always allow covers '));
    view.always.forEach((pattern, i) => {
      if (i) always.appendChild(document.createTextNode(', '));
      const code = document.createElement('code');
      code.textContent = pattern;
      always.appendChild(code);
    });
    // How long it lasts: OpenCode keeps the answer in the running serve, not in a saved list.
    always.appendChild(document.createTextNode(` ${ALWAYS_ALLOW_SCOPE}.`));
    body.appendChild(always);
  }

  const more = document.createElement('div');
  more.className = 'ocpv2-permission-more';

  // Reject and tell the model why (the reason reaches it as the tool error).
  if (supports('feature:permission-reply-message')) {
    const reasonRow = document.createElement('div');
    reasonRow.className = 'ocpv2-permission-reason';
    reasonRow.hidden = true;
    const reasonInput = document.createElement('input');
    reasonInput.type = 'text';
    reasonInput.className = 'ocpv2-permission-reason-input';
    reasonInput.placeholder = 'What should it do instead?';
    reasonInput.maxLength = 2000;
    // A reason that was being typed comes back with the card (the card is
    // rebuilt on every state event and when the panel returns to the session).
    const typedReason = _permissionReasons.get(reasonKey);
    if (typedReason) { reasonInput.value = typedReason; reasonRow.hidden = false; }
    reasonInput.addEventListener('input', () => _permissionReasons.set(reasonKey, reasonInput.value, { sessionId: reasonOwner }));
    const sendReason = button('Reject', 'ocpv2-perm-reject', () => respond('reject', reasonInput.value));
    reasonInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); respond('reject', reasonInput.value); }
    });
    reasonRow.appendChild(reasonInput);
    reasonRow.appendChild(sendReason);
    more.appendChild(linkButton('Reject with a reason', () => {
      reasonRow.hidden = !reasonRow.hidden;
      if (!reasonRow.hidden) reasonInput.focus();
    }));
    body.appendChild(more);
    body.appendChild(reasonRow);
  }

  wrap.appendChild(body);
  return wrap;
}

// Build display info for a permission request from OpenCode's native schema.
// Mirrors V1 ocp-tabs.js:describePermission. Bash falls back to reading the
// command from the matching tool part (by callID) when metadata is empty.
function describePermission(permType, patterns, metadata, callID, store) {
  const firstPattern = patterns[0] || '';
  const diff = typeof metadata.diff === 'string' ? metadata.diff : '';
  const fallbackIcon = '<svg viewBox="0 0 24 24"><path d="M12 2L2 7v6c0 5 4 9 10 11 6-2 10-6 10-11V7l-10-5z"/></svg>';
  const iconMap = {
    bash: TOOL_ICONS.bash,
    edit: TOOL_ICONS.edit,
    write: TOOL_ICONS.write,
    read: TOOL_ICONS.read,
    webfetch: TOOL_ICONS.fetch,
    fetch: TOOL_ICONS.fetch,
  };
  const icon = iconMap[permType] || fallbackIcon;

  if (permType === 'bash') {
    const cmd = readToolCommandFromStore(store, callID) || firstPattern || '';
    return {
      icon, kind: 'Run command', action: 'Execute shell command',
      target: cmd,
      patternsOut: patterns.length && patterns[0] !== cmd ? patterns : [],
      diff: '',
    };
  }
  if (permType === 'edit') {
    const fp = metadata.filepath || metadata.filePath || metadata.file_path || firstPattern || '';
    return {
      icon, kind: 'Edit file',
      action: patterns.length > 1 ? `Modify ${patterns.length} files` : 'Modify file',
      target: fp,
      patternsOut: patterns.length > 1 ? patterns : [],
      diff,
    };
  }
  if (permType === 'write') {
    const fp = metadata.filepath || metadata.filePath || firstPattern || '';
    return { icon, kind: 'Write file', action: 'Create or overwrite file', target: fp, patternsOut: [], diff };
  }
  if (permType === 'read') {
    const fp = metadata.filepath || metadata.filePath || firstPattern || '';
    return { icon, kind: 'Read file', action: 'Access file contents', target: fp, patternsOut: [], diff: '' };
  }
  if (permType === 'webfetch' || permType === 'fetch') {
    const url = metadata.url || firstPattern || '';
    return { icon, kind: 'Fetch URL', action: 'Make a web request', target: url, patternsOut: [], diff: '' };
  }
  const kind = permType ? permType.charAt(0).toUpperCase() + permType.slice(1) : 'Tool';
  return {
    icon, kind, action: 'Requires your approval',
    target: firstPattern,
    patternsOut: patterns.length > 1 ? patterns.slice(1) : [],
    diff: '',
  };
}

// Walk the store's messages to find the tool part whose callID matches and
// extract `command` from its input. V2 doesn't memo tool cards via DOM, so we
// read straight from state — same source the renderer uses.
function readToolCommandFromStore(store, callID) {
  if (!callID || !store) return '';
  const s = store.getState();
  for (const msg of s.messages.values()) {
    for (const part of msg.parts.values()) {
      const partCallId = part.callID || part.id || part.toolCallId || part.tool_use_id;
      if (!partCallId || String(partCallId) !== String(callID)) continue;
      const input = part.state?.input ?? part.input;
      if (input && typeof input === 'object') {
        if (input.command) return String(input.command);
      }
      if (typeof input === 'string') return input;
    }
  }
  return '';
}

// ── Question card (AskUser) ─────────────────────────────────────────────────

// Selection state survives re-renders. The renderer wipes the message list
// container on every state event (message.part.updated etc.), so the card's
// JS+DOM state would otherwise reset to "0/N" mid-answer. Keyed by req.id.
const _questionSelectionCache = new Map(); // requestId → sectionAnswers
const _submittingQuestionIds = new Set(); // requestId/toolCallId → reply in flight
const _submittedQuestionIds = new Set(); // requestId → reply accepted locally

function _getOrInitSelection(reqId, total) {
  let cached = _questionSelectionCache.get(reqId);
  if (!cached) {
    cached = Array.from({ length: total }, () => ({ selected: new Set(), custom: null }));
    _questionSelectionCache.set(reqId, cached);
  } else if (cached.length < total) {
    // v1.14.41 streams the question tool's input incrementally — first render
    // sees 1 question, next render sees 2, etc. Grow the cache instead of
    // wiping it, otherwise the user's first click on question[0] is lost as
    // soon as question[1] arrives and the cache resets.
    while (cached.length < total) cached.push({ selected: new Set(), custom: null });
  }
  // Don't shrink — keep stale slots so a transient drop in question count
  // doesn't lose user input. Cache is cleared on submit/reject.
  return cached;
}

export function clearQuestionSelection(reqId) {
  if (reqId) _questionSelectionCache.delete(reqId);
}

function markQuestionSubmitted(reqId) {
  if (reqId) _submittedQuestionIds.add(String(reqId));
}

function markQuestionSubmitting(reqId) {
  if (reqId) _submittingQuestionIds.add(String(reqId));
}

function clearQuestionSubmitting(reqId) {
  if (reqId) _submittingQuestionIds.delete(String(reqId));
}

function questionRequestIds(req) {
  return [
    req?.id,
    req?.requestID,
    req?.requestId,
    req?.tool?.callID,
    req?.tool?.callId,
  ].filter(Boolean);
}

function markQuestionRequestSubmitted(req) {
  for (const id of questionRequestIds(req)) markQuestionSubmitted(id);
}

function markQuestionRequestSubmitting(req) {
  for (const id of questionRequestIds(req)) markQuestionSubmitting(id);
}

function clearQuestionRequestSubmitting(req) {
  for (const id of questionRequestIds(req)) clearQuestionSubmitting(id);
}

function isQuestionSubmitted(reqId) {
  return reqId ? _submittedQuestionIds.has(String(reqId)) : false;
}

function isQuestionSubmitting(reqId) {
  return reqId ? _submittingQuestionIds.has(String(reqId)) : false;
}

function questionRequestStatusText(req) {
  const ids = questionRequestIds(req);
  if (ids.some(isQuestionSubmitted)) return 'Question answer submitted.';
  if (ids.some(isQuestionSubmitting)) return 'Submitting answer...';
  return '';
}

function renderQuestionCard(req, store) {
  const statusText = questionRequestStatusText(req);
  if (statusText) {
    const done = document.createElement('div');
    done.className = 'ocpv2-part ocpv2-part-question-stub';
    done.textContent = statusText;
    return done;
  }

  const wrap = document.createElement('div');
  wrap.className = 'ocpv2-question';
  wrap.dataset.requestId = req.id;

  const header = document.createElement('div');
  header.className = 'ocpv2-question-header';
  header.textContent = 'Question';
  wrap.appendChild(header);

  const questions = req.questions || [];
  const total = questions.length;
  const sectionAnswers = _getOrInitSelection(req.id, total); // persists across re-renders

  // Submit button — disabled until every question has an answer.
  const actions = document.createElement('div');
  actions.className = 'ocpv2-question-actions';
  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'ocpv2-question-submit';
  submit.disabled = true;
  submit.textContent = `Submit (0/${total})`;
  actions.appendChild(submit);

  function answeredCount() {
    let n = 0;
    for (let i = 0; i < total; i++) {
      const sa = sectionAnswers[i];
      if (sa?.custom) { n++; continue; }
      if (sa?.selected && sa.selected.size > 0) n++;
    }
    return n;
  }
  function updateSubmitState() {
    const n = answeredCount();
    submit.textContent = `Submit (${n}/${total})`;
    submit.disabled = n < total;
  }

  questions.forEach((q, qIdx) => {
    const multiple = q.multiple === true || q.multiSelect === true;
    const section = document.createElement('div');
    section.className = 'ocpv2-question-section';

    if (q.header) {
      const tag = document.createElement('div');
      tag.className = 'ocpv2-question-tag';
      tag.textContent = q.header;
      section.appendChild(tag);
    }

    const title = document.createElement('div');
    title.className = 'ocpv2-question-title';
    title.textContent = q.question || '';
    section.appendChild(title);

    if (multiple) {
      const hint = document.createElement('div');
      hint.className = 'ocpv2-question-hint';
      hint.textContent = 'Select all that apply';
      section.appendChild(hint);
    }

    const opts = document.createElement('div');
    opts.className = 'ocpv2-question-options';
    if (multiple) opts.classList.add('multi');

    let customInput = null;
    const optionButtons = [];

    (q.options || []).forEach((opt) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ocpv2-question-option';
      const lbl = document.createElement('div');
      lbl.className = 'ocpv2-question-option-label';
      lbl.textContent = opt.label;
      btn.appendChild(lbl);
      if (opt.description) {
        const desc = document.createElement('div');
        desc.className = 'ocpv2-question-option-desc';
        desc.textContent = opt.description;
        btn.appendChild(desc);
      }
      // Restore prior selection across re-renders.
      if (sectionAnswers[qIdx].selected.has(opt.label)) btn.classList.add('selected');
      btn.addEventListener('click', () => {
        // Selecting an option clears any typed custom answer for this question.
        if (customInput) customInput.value = '';
        sectionAnswers[qIdx].custom = null;

        if (multiple) {
          if (sectionAnswers[qIdx].selected.has(opt.label)) {
            sectionAnswers[qIdx].selected.delete(opt.label);
            btn.classList.remove('selected');
          } else {
            sectionAnswers[qIdx].selected.add(opt.label);
            btn.classList.add('selected');
          }
        } else {
          for (const b of optionButtons) b.classList.remove('selected');
          sectionAnswers[qIdx].selected = new Set([opt.label]);
          btn.classList.add('selected');
        }
        updateSubmitState();
      });
      opts.appendChild(btn);
      optionButtons.push(btn);
    });
    section.appendChild(opts);

    if (q.custom) {
      const customWrap = document.createElement('div');
      customWrap.className = 'ocpv2-question-custom';
      customInput = document.createElement('input');
      customInput.type = 'text';
      customInput.placeholder = 'Or type your own answer…';
      customInput.className = 'ocpv2-question-custom-input';
      // Restore typed answer across re-renders.
      if (sectionAnswers[qIdx].custom) customInput.value = sectionAnswers[qIdx].custom;
      customInput.addEventListener('input', () => {
        const value = customInput.value.trim();
        if (value) {
          // Typed answer wins — clear any option selection.
          for (const b of optionButtons) b.classList.remove('selected');
          sectionAnswers[qIdx].selected = new Set();
          sectionAnswers[qIdx].custom = value;
        } else {
          sectionAnswers[qIdx].custom = null;
        }
        updateSubmitState();
      });
      customWrap.appendChild(customInput);
      section.appendChild(customWrap);
    }

    wrap.appendChild(section);
  });

  submit.addEventListener('click', async () => {
    if (submit.disabled) return;
    await submitAnswers(req, sectionAnswers, store);
  });
  wrap.appendChild(actions);
  updateSubmitState();

  const reject = document.createElement('button');
  reject.type = 'button';
  reject.className = 'ocpv2-question-reject';
  reject.textContent = 'Skip';
  reject.addEventListener('click', async () => {
    wrap.classList.add('ocpv2-question-locked');
    try {
      // A queued request is rejected; a transcript card has no request
      // server-side, so the turn waiting on it is stopped. Either way only by
      // the panel whose session tree the card belongs to (skipQuestion).
      const result = await skipQuestion(store, api, req, { isDescendant: isDescendantSession });
      // Another session's question: not this panel's to skip.
      if (result.foreign) store.pushError({ message: FOREIGN_REQUEST_MESSAGE });
      // The server refused: the question is still open. The card is usable
      // again and keeps what was picked or typed in it.
      else if (result.ok === false && !result.moved) {
        store.pushError({ message: result.error || 'Question skip failed' });
        wrap.classList.remove('ocpv2-question-locked');
        return;
      }
      if (!result.moved) clearQuestionSelection(req.id);
    } catch (err) {
      console.warn('[ocp-v2-render] question reject failed', err);
    }
  });
  wrap.appendChild(reject);

  return wrap;
}

async function submitAnswers(requestOrId, sectionAnswers, store, instantQIdx, instantLabel) {
  // Build QuestionAnswer[] = Array<Array<string>>
  const answers = sectionAnswers.map((sa, idx) => {
    if (instantQIdx === idx && instantLabel != null) return [instantLabel];
    if (sa.custom) return [sa.custom];
    return Array.from(sa.selected);
  });
  // A bare id is looked up in the queue: only a request this store holds can
  // be checked for ownership, and nothing else is answered.
  const requestId = (typeof requestOrId === 'object' && requestOrId !== null) ? requestOrId.id : requestOrId;
  const req = (typeof requestOrId === 'object' && requestOrId !== null)
    ? requestOrId
    : (store.getState().pendingQuestions || []).find((q) => String(q?.id || '') === String(requestId || '')) || null;
  const card = document.querySelector(`.ocpv2-question[data-request-id="${CSS.escape(String(requestId || ''))}"]`);
  if (card) card.classList.add('ocpv2-question-locked');
  markQuestionRequestSubmitting(req);
  markQuestionSubmitting(requestId);
  // Ownership, the request id of a transcript card and the reply itself are
  // decided in ocp-v2-approvals.js (answerQuestion): every card, whatever
  // built it, is checked against the binding the click happened on, again
  // after the pending list was read and again right before the reply.
  let result;
  try { result = await answerQuestion(store, api, req, answers, { isDescendant: isDescendantSession }); }
  catch (err) { result = { ok: false, error: err?.message || 'Question reply failed', raw: err }; }
  if (result.ok) {
    markQuestionSubmitted(result.replyRequestId);
    markQuestionRequestSubmitted(req);
    markQuestionSubmitted(requestId);
    clearQuestionRequestSubmitting(req);
    clearQuestionSubmitting(requestId);
    clearQuestionSelection(requestId);
    return;
  }
  clearQuestionRequestSubmitting(req);
  clearQuestionSubmitting(requestId);
  if (card) card.classList.remove('ocpv2-question-locked');
  // The panel is on another session by now: its transcript gets no banner
  // about a question that is not its own.
  if (result.moved) return;
  console.warn('[ocp-v2-render] question reply failed', result.error);
  store.pushError({ message: result.error || 'Question reply failed', raw: result.raw });
}

function getQuestionDirectory(store) {
  const s = store.getState();
  return s.cwd || s.sessionInfo?.directory || s.sessionInfo?.info?.directory || undefined;
}

// The click on a permission card. replyToPermission re-checks that the request
// belongs to this panel's session tree before anything is sent.
async function safeReply(perm, response, store, message) {
  const result = await replyToPermission(store, api, perm, response, {
    cwd: getQuestionDirectory(store),
    message,
    isDescendant: isDescendantSession,
  });
  if (result.ok) return true;
  if (result.foreign) store.pushError({ message: FOREIGN_REQUEST_MESSAGE });
  // `moved`: the panel was rebound while the click was being checked. The card
  // that was clicked is gone with its binding; nothing was sent.
  else if (!result.moved) console.warn('[ocp-v2-render] permission reply failed', result.error || '');
  return false;
}

function linkButton(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ocpv2-permission-link';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function button(label, extraClass, onClick) {
  const b = document.createElement('button');
  b.className = `ocpv2-permission-btn ${extraClass}`;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

// ── Error banner ─────────────────────────────────────────────────────────────

function renderErrorBanner(err, store) {
  const el = document.createElement('div');
  el.className = 'ocpv2-error-banner';
  const text = document.createElement('span');
  text.className = 'ocpv2-error-banner-text';
  text.textContent = err.message || 'Error';
  el.appendChild(text);
  // A notice that keeps something for the user (a prompt whose session is
  // gone) says what can be done with it: `actions` is `[{ label, run(err) }]`.
  // It goes when one of them is chosen, not through an unnamed ×.
  const actions = (Array.isArray(err.actions) ? err.actions : []).filter((action) => action?.label && typeof action.run === 'function');
  for (const action of actions) {
    const act = document.createElement('button');
    act.type = 'button';
    act.className = 'ocpv2-inline-action';
    act.textContent = action.label;
    act.addEventListener('click', () => action.run(err));
    el.appendChild(act);
  }
  if (err.id && store?.dismissError && !actions.length) {
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ocpv2-error-banner-dismiss';
    close.setAttribute('aria-label', 'Dismiss');
    close.setAttribute('data-tooltip', 'Dismiss');
    close.textContent = '×';
    close.addEventListener('click', () => store.dismissError(err.id));
    el.appendChild(close);
  }
  return el;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatJson(v) {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// Markdown rendering. If marked is loaded → full GFM (tables, strikethrough,
// blockquotes, headings, hr, lists, code, links), sanitized. If still loading
// → escaped text with <br>, and we re-render once marked finishes.
// LRU-ish memoization for renderMarkdown. Each render() pass re-builds every
// part bubble; without this, marked.parse() runs once per part per state
// change — dominant CPU cost on long transcripts.
const _markdownCache = new Map();
const _markdownCacheLimit = 512;

function renderMarkdown(src) {
  const text = String(src || '');
  const cached = _markdownCache.get(text);
  if (cached !== undefined) return cached;
  let html;
  if (_marked) {
    // marked passes raw HTML in the source straight through, and the source is
    // model and tool output: only allowlisted markup may reach innerHTML.
    try { html = sanitizeHtmlString(_marked.parse(text)); } catch { html = escapeHtml(text).replace(/\n/g, '<br>'); }
  } else {
    html = escapeHtml(text).replace(/\n/g, '<br>');
  }
  if (_markdownCache.size >= _markdownCacheLimit) {
    // Evict oldest insertion (Map preserves insertion order)
    const firstKey = _markdownCache.keys().next().value;
    if (firstKey !== undefined) _markdownCache.delete(firstKey);
  }
  _markdownCache.set(text, html);
  return html;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
