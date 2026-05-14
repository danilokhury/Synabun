// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — Plan/Build lifecycle (multi-instance)
// Native OpenCode plan agent support plus the sidepanel approval flow:
// plan turn → PLAN COMPLETE card → edit/compact/continue decisions.
// Each compose registers via configurePlanLifecycle({ store, sendTextMessage });
// the post-plan card buttons call handlePostPlanAction(action, store) directly.
// ─────────────────────────────────────────────────────────────────────────────

import { emit, on } from '../state.js';
import { storage } from '../storage.js';
import { api } from './ocp-v2-ws.js';
import { hasRunningChildForParent } from './ocp-v2-manager.js';

const PLAN_SOURCE = 'opencode';
const STOR_MODE = 'opencode-v2-mode';
const EXIT_PLAN_REGEX = /^(ExitPlanMode|plan[_-]?exit)$/i;
const TASKS_REGEX = /^(tasks?|todo[_-]?write)$/i;

const _registrations = new Map(); // store → { sendTextMessage, unsub }
let _globalInstalled = false;
const _finalizing = new WeakSet(); // stores currently finalizing
const _planFilePromises = new WeakMap(); // store → Promise<string>

export function configurePlanLifecycle({ sendTextMessage, store } = {}) {
  if (!store) return () => {};
  const prev = _registrations.get(store);
  if (prev?.unsub) { try { prev.unsub(); } catch {} }

  const unsub = store.subscribe((event, state) => {
    if (event?.type === 'running:set' && !state.running && state.planTurnActive) {
      setTimeout(() => { maybeFinalizePlanTurn('session.idle', store).catch(() => {}); }, 0);
    }
    if (event?.type === 'questions:set' && !state.running && state.planTurnActive && !(state.pendingQuestions || []).length) {
      setTimeout(() => { maybeFinalizePlanTurn('questions:cleared', store).catch(() => {}); }, 0);
    }
  });

  _registrations.set(store, { sendTextMessage, unsub });
  installGlobalLifecycle();

  return () => {
    const reg = _registrations.get(store);
    if (reg?.unsub) { try { reg.unsub(); } catch {} }
    _registrations.delete(store);
  };
}

function installGlobalLifecycle() {
  if (_globalInstalled) return;
  _globalInstalled = true;

  on('plan-saved', ({ filePath, content, source, tabId } = {}) => {
    if (source && source !== PLAN_SOURCE) return;
    const text = String(content || '').trim();
    if (!text) return;
    for (const [store] of _registrations) {
      const s = store.getState();
      if (tabId && s.sessionId && tabId !== s.sessionId) continue;
      store.setPlanContent(text, {
        edited: true,
        filePath: filePath || s.planFilePath || '',
        header: 'PLAN UPDATED',
        showActions: true,
      });
      appendAssistantPlanMessage(store, text);
    }
  });

  on('plan-edit-cancelled', ({ source, tabId } = {}) => {
    if (source && source !== PLAN_SOURCE) return;
    for (const [store] of _registrations) {
      const s = store.getState();
      if (tabId && s.sessionId && tabId !== s.sessionId) continue;
      if (currentPlanText(store)) store.setPostPlanActions(true, s.postPlanHeader || 'PLAN COMPLETE');
    }
  });
}

export function beginPlanTurnForSend(store) {
  const s = store.getState();
  const count = (s.messageOrder || []).filter((id) => !String(id).startsWith('local-')).length;
  store.beginPlanTurn({ sessionId: s.sessionId, startMessageCount: count });
}

export function isPostPlanBlocked(store) {
  return !!store.getState().showPostPlanActions;
}

export async function maybeFinalizePlanTurn(reason = 'terminal', store, { force = false } = {}) {
  if (!store) return false;
  const s = store.getState();
  if (!s.planTurnActive || !s.sessionId) return false;
  // When pending questions are present we used to bail entirely. Now we still
  // proceed so the PLAN COMPLETE card can stack ABOVE the question card —
  // but only if a real plan body or explicit ExitPlanMode is present.
  // The flag below tightens the gate inside extraction.
  const hasPendingQuestions = !!(s.pendingQuestions || []).length;
  if (_finalizing.has(store)) return false;

  // Defer if a sub-agent of this parent is still running. Otherwise we would
  // capture the parent's pre-handoff text as the "plan" before the agent
  // returns and the parent has a chance to integrate the report. The child's
  // running:set→false subscription in ocp-v2-manager.js re-pokes us when the
  // sub-agent finishes.
  if (!force && hasRunningChildForParent(s.sessionId)) return false;

  _finalizing.add(store);
  try {
    const list = await api.sessionMessages(s.sessionId);
    const items = Array.isArray(list?.data) ? list.data : [];
    syncMessages(store, items);

    const extracted = extractPlanFromMessages(items, {
      startCount: s.planTurnStartMessageCount || 0,
      force,
    });
    const plan = String(extracted.text || '').trim();
    if (!plan) return false;

    if (!force && !extracted.explicitExit && looksLikeProseQuestions(plan)) {
      // Don't surface the prose-question error when the agent already used the
      // question tool (the question card itself is the clarification UX).
      if (!hasPendingQuestions) {
        store.pushError({
          message: 'Plan mode ended with clarification questions in prose. Reply in Plan mode, or ask OpenCode to use its question tool.',
          reason,
        });
      }
      return false;
    }

    if (!force && !extracted.explicitExit && !isRealPlanContent(plan)) return false;

    // With pending questions, only fire PLAN COMPLETE for explicit exits or
    // unambiguously plan-shaped bodies — never for a passing mention.
    if (hasPendingQuestions && !extracted.explicitExit && !isRealPlanContent(plan)) return false;

    store.completePlanTurn({ content: plan, header: 'PLAN COMPLETE' });
    ensurePlanFile(store).catch(() => {});
    return true;
  } finally {
    _finalizing.delete(store);
  }
}

export async function handlePostPlanAction(action, store) {
  if (!store) return false;
  const s = store.getState();
  const plan = currentPlanText(store);

  if (action === 'continue') {
    store.setPostPlanActions(false);
    store.setMode('build');
    storage.setItem(STOR_MODE, 'build');
    const reg = _registrations.get(store);
    const sendTextMessage = reg?.sendTextMessage;
    if (typeof sendTextMessage !== 'function') throw new Error('OpenCode send handler is not ready');
    const prompt = plan
      ? `Implement the following approved plan:\n\n${plan}`
      : 'The plan has been approved. Please proceed with implementation.';
    return sendTextMessage(prompt, { ignorePostPlanBlock: true });
  }

  if (action === 'continue-planning') {
    store.setPostPlanActions(false);
    store.setMode('plan');
    storage.setItem(STOR_MODE, 'plan');
    return true;
  }

  if (action === 'compact') {
    if (!s.sessionId) return false;
    const res = await api.compact({ sessionId: s.sessionId, cwd: s.cwd || undefined });
    if (res?.error) throw new Error(res.error);
    store.setPostPlanActions(true, 'CONTEXT COMPACTED');
    return true;
  }

  if (action === 'edit') {
    if (!plan) throw new Error('No plan content to edit');
    const filePath = await ensurePlanFile(store);
    if (!filePath) throw new Error('Could not create plan file');
    store.setPostPlanActions(false);
    emit('open-plan-editor', { filePath, tabId: s.sessionId, source: PLAN_SOURCE });
    return true;
  }

  return false;
}

// Legacy shim — render.js's post-plan buttons now call handlePostPlanAction
// directly with their captured store. This stub keeps any older bindings
// working by routing to the first registered store.
export function dispatchPostPlanAction(action) {
  const first = _registrations.keys().next().value;
  if (!first) return;
  handlePostPlanAction(action, first).catch((err) => {
    first.pushError({ message: err?.message || 'Plan action failed' });
  });
}

function syncMessages(store, items) {
  for (const { info, parts } of items || []) {
    if (!info?.id) continue;
    store.upsertMessage(info);
    for (const part of (parts || [])) store.upsertPart(part);
  }
}

function currentPlanText(store) {
  const s = store.getState();
  return String(s.editedPlanContent || s.planContent || '').trim();
}

async function ensurePlanFile(store) {
  const s = store.getState();
  if (s.planFilePath) return s.planFilePath;
  const existing = _planFilePromises.get(store);
  if (existing) return existing;

  const content = normalizePlanFileContent(currentPlanText(store));
  if (!content) return '';

  store.setPlanMaterializing(true);
  const promise = fetch('/api/create-plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, cwd: s.cwd || '', projectPath: s.cwd || '' }),
  })
    .then(async (res) => {
      const result = await res.json().catch(() => ({}));
      if (!res.ok || !result?.ok || !result.path) throw new Error(result?.error || 'create-plan failed');
      store.setPlanContent(currentPlanText(store), { filePath: result.path });
      return result.path;
    })
    .catch((err) => {
      store.pushError({ message: err?.message || 'Could not create plan file' });
      return '';
    })
    .finally(() => {
      _planFilePromises.delete(store);
      store.setPlanMaterializing(false);
    });
  _planFilePromises.set(store, promise);

  return promise;
}

function normalizePlanFileContent(content) {
  const text = String(content || '').trim();
  if (!text) return '';
  return /^#\s+\S/m.test(text) ? text : `# Plan\n\n${text}`;
}

function appendAssistantPlanMessage(store, content) {
  const id = `local-plan-${Date.now()}`;
  store.upsertMessage({ id, role: 'assistant' });
  store.upsertPart({
    id: `${id}-text`,
    messageID: id,
    type: 'text',
    text: content,
    index: 0,
  });
}

function extractPlanFromMessages(items, { startCount = 0, force = false } = {}) {
  const all = Array.isArray(items) ? items : [];
  const tail = all.slice(Math.max(0, startCount));
  let scoped = tail.some((item) => isAssistantInfo(item?.info)) ? tail : all;
  scoped = scoped.filter((item) => isAssistantInfo(item?.info));
  if (!scoped.length) return { text: '', explicitExit: false };

  for (let i = scoped.length - 1; i >= 0; i--) {
    for (const part of reverseParts(scoped[i])) {
      const name = toolName(part);
      if (!EXIT_PLAN_REGEX.test(name)) continue;
      const text = planTextFromInput(toolInput(part)) || planTextFromInput(toolOutput(part)) || outputToText(toolOutput(part));
      if (text) return { text, explicitExit: true };
    }
  }

  for (let i = scoped.length - 1; i >= 0; i--) {
    for (const part of reverseParts(scoped[i])) {
      const name = toolName(part);
      if (!TASKS_REGEX.test(name)) continue;
      const text = todosToMarkdown(toolInput(part)?.todos || toolOutput(part)?.todos);
      if (text) return { text, explicitExit: false };
    }
  }

  const text = collectLatestParts(scoped, 'text', { preferPlanLike: true });
  if (text) return { text, explicitExit: false };

  if (force) {
    const reasoning = collectLatestParts(scoped, 'reasoning', { preferPlanLike: true });
    if (reasoning) return { text: reasoning, explicitExit: false };
    // Last-resort fallback: a sub-agent's tool-result text. Only used when the
    // user explicitly forces finalization — otherwise it would surface the
    // sub-agent's report as the parent's plan, which is wrong. The parent is
    // expected to integrate the report and emit its own plan body.
    const toolResultText = collectToolResultText(scoped);
    if (toolResultText) return { text: toolResultText, explicitExit: false };
  } else {
    const reasoning = collectLatestParts(scoped, 'reasoning', { preferPlanLike: true });
    if (isRealPlanContent(reasoning)) return { text: reasoning, explicitExit: false };
  }

  return { text: '', explicitExit: false };
}

function isAssistantInfo(info) {
  if (!info) return false;
  const role = String(info?.role || '').toLowerCase();
  return role !== 'user';
}

function reverseParts(item) {
  return [...(item?.parts || [])].sort((a, b) => {
    const ai = a?.index ?? Number.POSITIVE_INFINITY;
    const bi = b?.index ?? Number.POSITIVE_INFINITY;
    return bi - ai;
  });
}

function collectLatestParts(items, type, { preferPlanLike = false } = {}) {
  for (let i = items.length - 1; i >= 0; i--) {
    const chunks = [];
    const item = items[i];
    const parts = [...(item?.parts || [])].sort((a, b) => {
      const ai = a?.index ?? Number.POSITIVE_INFINITY;
      const bi = b?.index ?? Number.POSITIVE_INFINITY;
      return ai - bi;
    });
    for (const part of parts) {
      if (part?.type !== type) continue;
      const text = String(part.text || part.content || '').trim();
      if (text) chunks.push(text);
    }
    if (!chunks.length) continue;
    if (preferPlanLike) {
      for (let j = chunks.length - 1; j >= 0; j--) {
        if (isRealPlanContent(chunks[j])) return chunks[j];
      }
    }
    return chunks.join('\n\n').trim();
  }
  return '';
}

function collectToolResultText(items) {
  for (let i = items.length - 1; i >= 0; i--) {
    for (const part of reverseParts(items[i])) {
      const name = toolName(part).toLowerCase();
      if (!(name === 'agent' || name === 'task' || name.includes('agent'))) continue;
      const text = outputToText(toolOutput(part)).trim();
      if (isRealPlanContent(text)) return text;
    }
  }
  return '';
}

function toolName(part) {
  return String(part?.tool || part?.name || part?.toolName || '').trim();
}

function toolInput(part) {
  return parseMaybeJson(part?.state?.input ?? part?.input ?? part?.args ?? part?.parameters ?? {});
}

function toolOutput(part) {
  return parseMaybeJson(part?.state?.output ?? part?.output ?? part?.result ?? null);
}

function planTextFromInput(input) {
  if (!input) return '';
  if (typeof input === 'string') return input.trim();
  return String(input.plan || input.markdown || input.content || input.text || '').trim();
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return text;
  if (!text.startsWith('{') && !text.startsWith('[')) return text;
  try { return JSON.parse(text); } catch { return value; }
}

function outputToText(output) {
  if (!output) return '';
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output.map(outputToText).filter(Boolean).join('\n\n');
  }
  if (Array.isArray(output.content)) {
    return output.content.map(outputToText).filter(Boolean).join('\n\n');
  }
  if (typeof output.text === 'string') return output.text;
  if (typeof output.content === 'string') return output.content;
  if (typeof output.result === 'string') return output.result;
  return '';
}

function todosToMarkdown(todos) {
  if (!Array.isArray(todos) || !todos.length) return '';
  const lines = ['# Plan'];
  for (const todo of todos) {
    const text = String(todo?.content || todo?.text || todo?.title || '').trim();
    if (!text) continue;
    const status = String(todo?.status || '').toLowerCase();
    const mark = status === 'completed' || status === 'done' ? 'x' : ' ';
    lines.push(`- [${mark}] ${text}`);
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

function isRealPlanContent(text) {
  const trimmed = String(text || '').trim();
  if (trimmed.length < 80) return false;
  const lower = trimmed.toLowerCase();
  const head = lower.slice(0, 220);
  const narrationMarkers = [
    "i'm in plan mode",
    'im in plan mode',
    'the user is in plan mode',
    'let me ask',
    'let me think',
    'let me plan',
    'before i ',
    'i need more',
  ];
  if (narrationMarkers.some((marker) => head.includes(marker))) return false;
  const hasHeading = /(^|\n)#{1,3}\s+\S/.test(trimmed);
  const hasList = /(^|\n)(?:[-*]|\d+\.)\s+\S/.test(trimmed);
  return hasHeading || hasList;
}

function looksLikeProseQuestions(content) {
  const tail = String(content || '').slice(-500);
  if (/(^|\n)\s*(quick |a couple of |before i proceed,?\s*|two\s+).*?questions?:?\s*$/im.test(tail)) return true;
  if (/(^|\n)\s*(question|q)\s*\d+\s*[:.]/im.test(tail)) return true;
  return (tail.match(/\?\s*(\n|$)/g) || []).length >= 2;
}
