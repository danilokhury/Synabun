// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — Renderer
// Pure render functions. Subscribes to state changes and rebuilds the
// messages container. Handles the full set of CLI part types:
//   text, reasoning, tool, file, step-start, step-finish, permission, error.
// Minimal Markdown (paragraphs / fences / inline code / **bold** / *italic* /
// lists / links) — no external deps, no syntax highlighting in step 1.
// ─────────────────────────────────────────────────────────────────────────────

import { getDefaultStore } from './ocp-v2-state.js';
import { api } from './ocp-v2-ws.js';
import { handlePostPlanAction } from './ocp-v2-plan.js';
import { TOOL_ICONS } from '../ocp/ocp-icons.js';
import { createStickyScrollController } from '../ui-scroll-follow.js';

const _expandedReasoningIds = new Set();
const _activeRenderers = new Set();

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
export function mountRenderer(containerEl, store = getDefaultStore()) {
  let _container = containerEl;
  let _renderScheduled = false;
  const scrollController = createStickyScrollController(_container);

  const doRender = () => {
    render(_container, store);
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

  const unsubscribe = store.subscribe(() => scheduleRender());

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

// Per-part signature — captures all visible state so reconcile() can detect
// when an existing DOM node is still up to date and avoid rebuilding it.
function _partSig(part) {
  if (!part) return '';
  const t = part.type || '';
  if (t === 'text' || t === 'reasoning') {
    const text = String(part.text || '');
    const tail = text.length > 80 ? text.slice(-80) : text;
    return `${t}:${text.length}:${tail}:${part?.time?.end ? '1' : '0'}`;
  }
  if (t === 'tool') {
    const state = part.state || {};
    const status = state.status || part.status || '';
    const input = state.input ?? part.input;
    const output = state.output ?? part.output;
    const error = state.error ?? part.error;
    const inp = input ? JSON.stringify(input).length : 0;
    const out = output == null
      ? 0
      : typeof output === 'string'
        ? output.length
        : JSON.stringify(output).length;
    return `tool:${status}:${part.tool || part.name || ''}:${inp}:${out}:${error ? 'e' : ''}`;
  }
  if (t === 'file') {
    return `file:${part.url || part.path || ''}:${String(part.text || '').length}`;
  }
  return `${t}:${part.id || ''}`;
}

function _msgSig(msg) {
  let sig = `m:${msg.role || 'assistant'}`;
  for (const part of msg.parts.values()) sig += '|' + _partSig(part);
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

function render(_container, store) {
  if (!_container) return;
  const s = store.getState();

  const hasInteractiveCards = !!s.pendingPermission || (s.pendingQuestions && s.pendingQuestions.length > 0) || !!s.showPostPlanActions;
  if (s.messageOrder.length === 0 && !hasInteractiveCards) {
    _reconcile(_container, [{ key: '__empty__', sig: 'empty', build: _buildEmpty }]);
    return;
  }

  const desired = [];

  s.errors.forEach((err, i) => {
    desired.push({
      key: `err:${i}`,
      sig: `err:${String(err?.message || err || '')}`,
      build: () => renderErrorBanner(err),
    });
  });

  let prevAssistantId = null;
  for (const messageId of s.messageOrder) {
    const msg = s.messages.get(messageId);
    if (!msg) continue;
    if ((msg.role || 'assistant') === 'user') {
      desired.push({
        key: `u:${msg.id}`,
        sig: _msgSig(msg),
        build: () => renderMessage(msg, store),
      });
      prevAssistantId = null;
    } else {
      const parts = Array.from(msg.parts.values()).sort((a, b) => {
        const ai = a.index ?? Number.POSITIVE_INFINITY;
        const bi = b.index ?? Number.POSITIVE_INFINITY;
        return ai - bi;
      });
      for (const part of parts) {
        if (part.type === 'step-start' || part.type === 'step-finish') continue;
        const isContinuation = prevAssistantId === msg.id;
        const partKey = part.id || `${part.type}:${part.index ?? ''}`;
        desired.push({
          key: `a:${msg.id}:${partKey}`,
          sig: `${isContinuation ? 'c' : 'h'}|${_partSig(part)}`,
          build: () => renderAssistantPartBubble(msg, part, isContinuation, store),
        });
        prevAssistantId = msg.id;
      }
    }
  }

  if (s.pendingPermission) {
    const p = s.pendingPermission;
    desired.push({
      key: `perm:${p.id || p.requestId || 'pending'}`,
      sig: `perm:${p.id || ''}:${p.state || ''}`,
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

  for (const q of (s.pendingQuestions || [])) {
    desired.push({
      key: `q:${q.id || q.requestId || ''}`,
      sig: `q:${q.id || ''}:${(q.questions?.length || 0)}:${q.answered ? '1' : '0'}`,
      build: () => renderQuestionCard(q, store),
    });
  }

  _reconcile(_container, desired);
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
      handlePostPlanAction(action, store).catch((err) => {
        store.pushError({ message: err?.message || 'Plan action failed' });
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

function renderMessage(msg, store) {
  const wrap = document.createElement('div');
  wrap.className = `ocpv2-msg ocpv2-msg-${msg.role || 'assistant'}`;
  wrap.dataset.messageId = msg.id;

  const role = document.createElement('div');
  role.className = 'ocpv2-msg-role';
  role.textContent = msg.role === 'user' ? 'You' : 'OpenCode';
  wrap.appendChild(role);

  // Sort parts by their `index` if present, else insertion order from the Map
  const parts = Array.from(msg.parts.values()).sort((a, b) => {
    const ai = a.index ?? Number.POSITIVE_INFINITY;
    const bi = b.index ?? Number.POSITIVE_INFINITY;
    return ai - bi;
  });
  for (const part of parts) {
    const el = renderPart(part, store);
    if (el) wrap.appendChild(el);
  }
  return wrap;
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
    role.textContent = 'OpenCode';
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
    default:             return renderUnknownPart(part);
  }
}

// ── Part renderers ───────────────────────────────────────────────────────────

function renderTextPart(part) {
  const el = document.createElement('div');
  el.className = 'ocpv2-part ocpv2-part-text';
  el.innerHTML = renderMarkdown(part.text || '');
  return el;
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
    return row;
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
  browser_navigate: 'Browser · Navigate', browser_screenshot: 'Browser · Screenshot',
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
    const synthetic = {
      id: partCallId || `tool-${part.messageID || 'q'}`,
      sessionID: part.sessionID || store.getState().sessionId,
      questions,
      _viaToolPart: true,
    };
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

  const wrap = document.createElement('div');
  wrap.className = 'ocpv2-part ocpv2-part-tool';

  const head = document.createElement('div');
  head.className = 'ocpv2-tool-head';
  const name = document.createElement('span');
  name.className = 'ocpv2-tool-name';
  name.textContent = toolName || 'tool';
  head.appendChild(name);

  const status = document.createElement('span');
  status.className = `ocpv2-tool-status ocpv2-tool-${stateStatus}`;
  status.textContent = stateStatus;
  head.appendChild(status);
  wrap.appendChild(head);

  // Input
  const input = part.state?.input ?? part.input;
  if (input !== undefined) {
    const inp = document.createElement('div');
    inp.className = 'ocpv2-tool-input';
    inp.textContent = formatJson(input);
    wrap.appendChild(inp);
  }

  // Output / error
  const output = part.state?.output ?? part.output;
  const error = part.state?.error ?? part.error;
  if (error) {
    const errEl = document.createElement('div');
    errEl.className = 'ocpv2-tool-output ocpv2-tool-output-error';
    errEl.textContent = typeof error === 'string' ? error : formatJson(error);
    wrap.appendChild(errEl);
  } else if (output !== undefined && output !== null) {
    appendToolOutput(wrap, output);
  }

  return wrap;
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

function renderUnknownPart(part) {
  const el = document.createElement('div');
  el.className = 'ocpv2-part ocpv2-part-text';
  el.style.opacity = '0.55';
  el.style.fontFamily = 'ui-monospace, SFMono-Regular, monospace';
  el.style.fontSize = '11px';
  el.textContent = `[${part.type || 'unknown'} part]`;
  return el;
}

// ── Permission card ──────────────────────────────────────────────────────────

function renderPermissionCard(perm, store) {
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
  const respond = async (response) => {
    lock();
    const ok = await safeReply(perm, response, store);
    if (!ok) unlock();
  };

  const allowOnce = button('Allow once', 'ocpv2-perm-allow', () => respond('once'));
  const allowAlways = button('Always allow', 'ocpv2-perm-allow', () => respond('always'));
  const reject = button('Reject', 'ocpv2-perm-reject', () => respond('reject'));
  actions.appendChild(allowOnce);
  actions.appendChild(allowAlways);
  actions.appendChild(reject);
  body.appendChild(actions);

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
      if (req._viaToolPart) {
        // No QuestionRequest exists server-side — abort the in-flight turn so
        // the user can take over.
        await api.abort(req.sessionID || store.getState().sessionId);
      } else {
        await api.questionReject({ requestId: req.id, sessionId: req.sessionID || store.getState().sessionId });
      }
      clearQuestionSelection(req.id);
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
  const req = (typeof requestOrId === 'object' && requestOrId !== null) ? requestOrId : null;
  const requestId = req ? req.id : requestOrId;
  const card = document.querySelector(`.ocpv2-question[data-request-id="${CSS.escape(String(requestId || ''))}"]`);
  if (card) card.classList.add('ocpv2-question-locked');
  markQuestionRequestSubmitting(req);
  markQuestionSubmitting(requestId);
  try {
    const replyRequestId = await resolveQuestionReplyRequestId(req, requestId, store);
    if (req?._viaToolPart && !replyRequestId) {
      throw new Error('OpenCode did not expose a pending question request for this card. Answer was not queued.');
    }
    const replyResp = await api.questionReply({ requestId: replyRequestId, answers, cwd: getQuestionDirectory(store), sessionId: store.getState().sessionId });
    assertWsOk(replyResp, 'Question reply');
    markQuestionSubmitted(replyRequestId);
    markQuestionRequestSubmitted(req);
    markQuestionSubmitted(requestId);
    store.removePendingQuestion(replyRequestId);
    store.removePendingQuestion(requestId);
    clearQuestionRequestSubmitting(req);
    clearQuestionSubmitting(requestId);
    clearQuestionSelection(requestId);
  } catch (err) {
    console.warn('[ocp-v2-render] question reply failed', err);
    clearQuestionRequestSubmitting(req);
    clearQuestionSubmitting(requestId);
    if (card) card.classList.remove('ocpv2-question-locked');
    store.pushError({ message: err?.message || 'Question reply failed', raw: err });
  }
}

async function resolveQuestionReplyRequestId(req, fallbackRequestId, store) {
  if (!req?._viaToolPart) return fallbackRequestId;
  const s = store.getState();
  const listResp = await api.questionList({ cwd: getQuestionDirectory(store), sessionId: s.sessionId });
  assertWsOk(listResp, 'Question list');
  const list = normalizeQuestionListResponse(listResp);
  const partCallId = String(req.id || '');
  const match = list.find((q) => {
    if (!q) return false;
    const qSessionId = q.sessionID || q.sessionId || q.session?.id || '';
    if (qSessionId && s.sessionId && qSessionId !== s.sessionId) return false;
    const qCallId = q.tool?.callID || q.tool?.callId || q.tool?.id || '';
    return partCallId && qCallId ? qCallId === partCallId : true;
  });
  if (match?.id) return match.id;
  console.warn('[ocp-v2-render] question request lookup missed; refusing queued prompt fallback', {
    sessionId: s.sessionId,
    partCallId,
    listCount: list.length,
  });
  return null;
}

function getQuestionDirectory(store) {
  const s = store.getState();
  return s.cwd || s.sessionInfo?.directory || s.sessionInfo?.info?.directory || undefined;
}

function assertWsOk(resp, label) {
  if (!resp) throw new Error(`${label} failed: empty response`);
  if (resp.ok === false) throw new Error(`${label} failed: ${formatErrorDetail(resp.error || 'request rejected')}`);
  if (resp.status && resp.status >= 400) {
    const detail = formatErrorDetail(resp.error || resp.data?.error || resp.data?.message || `HTTP ${resp.status}`);
    throw new Error(`${label} failed: ${detail}`);
  }
  if (resp.error) throw new Error(`${label} failed: ${formatErrorDetail(resp.error)}`);
  return resp;
}

function formatErrorDetail(value) {
  if (value == null) return 'request rejected';
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message || String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
}

function normalizeQuestionListResponse(resp) {
  const data = resp?.data ?? resp;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.questions)) return data.questions;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

async function safeReply(perm, response, store) {
  try {
    const res = await api.permissionReply({
      sessionId: perm.sessionID || perm.sessionId || store.getState().sessionId,
      permissionId: perm.id || perm.permissionID,
      response,
      cwd: getQuestionDirectory(store),
    });
    // The WS round-trip resolves even on a server-side failure (ok:false or an
    // HTTP >= 400 status). Treat those as failures so the caller can re-enable
    // the card rather than leaving it greyed on a no-op reply.
    if (res && (res.ok === false || (typeof res.status === 'number' && res.status >= 400))) {
      console.warn('[ocp-v2-render] permission reply rejected', res);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[ocp-v2-render] permission reply failed', e);
    return false;
  }
}

function button(label, extraClass, onClick) {
  const b = document.createElement('button');
  b.className = `ocpv2-permission-btn ${extraClass}`;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

// ── Error banner ─────────────────────────────────────────────────────────────

function renderErrorBanner(err) {
  const el = document.createElement('div');
  el.className = 'ocpv2-error-banner';
  el.textContent = err.message || 'Error';
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
// blockquotes, headings, hr, lists, code, links). If still loading → escaped
// text with <br>, and we re-render once marked finishes.
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
    try { html = _marked.parse(text); } catch { html = escapeHtml(text).replace(/\n/g, '<br>'); }
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
