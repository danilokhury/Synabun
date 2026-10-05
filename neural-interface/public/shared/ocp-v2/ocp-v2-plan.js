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
import { captureBinding } from './ocp-v2-binding.js';
import { replyFailed, replyError } from './ocp-v2-caps.js';

const PLAN_SOURCE = 'opencode';
const STOR_MODE = 'opencode-v2-mode';
const EXIT_PLAN_REGEX = /^(ExitPlanMode|plan[_-]?exit)$/i;
const TASKS_REGEX = /^(tasks?|todo[_-]?write)$/i;

const _registrations = new Map(); // store → { sendTextMessage, unsub }
let _globalInstalled = false;
// A plan file is keyed by store AND binding: one of the session the panel has
// left does not serve the session it is on now.
// A finalization is keyed by store, binding AND plan turn: the transcript read
// of an older plan turn (which will reject itself when it is back) does not
// stand in the way of the turn that is open now. While a turn's own read is
// out, a second finalizer of that same turn is turned away, but not lost: it
// is noted on the lock (`again`) and runs when the read is back, should the
// turn still be open then.
const _finalizing = new WeakMap(); // store → Map(`${binding}:${planTurnId}` → { again, saidProse })
function finalizationsOf(store) {
  let locks = _finalizing.get(store);
  if (!locks) { locks = new Map(); _finalizing.set(store, locks); }
  return locks;
}
const _planFilePromises = new WeakMap(); // store → { binding, content, promise }
// The transcript read of a finalization can fail (an error reply, a request
// that timed out). That is not an empty transcript: the read is asked again,
// this many times in all, with a pause in between.
export const PLAN_READ_ATTEMPTS = 3;
export const PLAN_READ_RETRY_MS = 800;

export function configurePlanLifecycle({ sendTextMessage, store } = {}) {
  if (!store) return () => {};
  const prev = _registrations.get(store);
  if (prev?.unsub) { try { prev.unsub(); } catch {} }

  // The timer fires a tick later: it finalizes the plan turn of the binding
  // the event was for, not of whatever the panel is on by then.
  const finalizeLater = (reason) => {
    const at = captureBinding(store);
    // ...and of the plan turn the event was about, not of one begun after it.
    const planTurn = store.getState().planTurnId;
    setTimeout(() => {
      if (!at.isCurrent()) return;
      maybeFinalizePlanTurn(reason, store, { lenient: true, planTurn }).catch(() => {});
    }, 0);
  };
  const unsub = store.subscribe((event, state) => {
    if (event?.type === 'running:set' && !state.running && state.planTurnActive) {
      finalizeLater('session.idle');
    }
    if (event?.type === 'questions:set' && !state.running && state.planTurnActive && !(state.pendingQuestions || []).length) {
      finalizeLater('questions:cleared');
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
      // The editor was opened for one session (tabId): its plan goes to the
      // panel that is on that session, and to no other. An event that names
      // no session has no owner and is applied nowhere (this panel's Edit
      // always names one).
      if (!ownsEditorEvent(s, tabId)) continue;
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
      if (!ownsEditorEvent(s, tabId)) continue;
      if (currentPlanText(store)) store.setPostPlanActions(true, s.postPlanHeader || 'PLAN COMPLETE');
    }
  });
}

// An editor event belongs to the store that is on the session it names.
const ownsEditorEvent = (state, tabId) => !!tabId && !!state.sessionId && tabId === state.sessionId;

/** Starts the plan turn of a send. Returns its identity (state.planTurnId). */
export function beginPlanTurnForSend(store) {
  const s = store.getState();
  const count = (s.messageOrder || []).filter((id) => !String(id).startsWith('local-')).length;
  store.beginPlanTurn({ sessionId: s.sessionId, startMessageCount: count });
  return store.getState().planTurnId || 0;
}

export function isPostPlanBlocked(store) {
  return !!store.getState().showPostPlanActions;
}

// `planTurn` (optional) is the identity of the plan turn the caller means (the
// send that started it): a continuation of an older turn does not finalize a
// newer plan turn of the same session. (`retryOf` is this function's own: the
// lock of the read a turned-away finalizer waited for.)
export async function maybeFinalizePlanTurn(reason = 'terminal', store, { force = false, lenient = false, planTurn, retryOf = null } = {}) {
  if (!store) return false;
  const s = store.getState();
  if (!s.planTurnActive || !s.sessionId) return false;
  if (planTurn && s.planTurnId !== planTurn) return false;
  // The plan turn being finalized: this session, under this binding, with
  // this identity. Everything below is for that turn; `s` is the live state
  // and is not read again after the await.
  const at = captureBinding(store);
  const planTurnId = s.planTurnId;
  const startCount = s.planTurnStartMessageCount || 0;
  // When pending questions are present we used to bail entirely. Now we still
  // proceed so the PLAN COMPLETE card can stack ABOVE the question card —
  // but only if a real plan body or explicit ExitPlanMode is present.
  // The flag below tightens the gate inside extraction.
  const hasPendingQuestions = !!(s.pendingQuestions || []).length;
  // One read at a time per plan turn. A read that is out for an older plan
  // turn holds another key and is not in this turn's way.
  const locks = finalizationsOf(store);
  const lockKey = `${at.binding}:${planTurnId}`;
  const held = locks.get(lockKey);
  if (held) {
    // This turn is being read right now. The transcript that read gets may be
    // older than what this finalizer was raised for, and the read may be held
    // to a stricter test: this one runs after it, unless it completed the plan.
    held.again = { reason, force: force || held.again?.force === true, lenient: lenient || held.again?.lenient === true };
    return false;
  }

  // Defer if a sub-agent of this parent is still running. Otherwise we would
  // capture the parent's pre-handoff text as the "plan" before the agent
  // returns and the parent has a chance to integrate the report. The child's
  // running:set→false subscription in ocp-v2-manager.js re-pokes us when the
  // sub-agent finishes.
  if (!force && hasRunningChildForParent(at.sessionId)) return false;

  const lock = { again: null, saidProse: retryOf?.saidProse === true };
  locks.set(lockKey, lock);
  let completed = false;
  let failure = null;
  try {
    completed = await readAndFinalize(store, at, { planTurnId, startCount, hasPendingQuestions, force, lenient, reason, lock });
  } catch (err) {
    failure = err;
  }
  // Only this read's own entry: never the lock of another plan turn.
  if (locks.get(lockKey) === lock) locks.delete(lockKey);
  const again = lock.again;
  if (again && !completed && planTurnStillOpen(store, at, planTurnId)) {
    // The finalizer that was turned away while this read was out.
    const retry = maybeFinalizePlanTurn(again.reason, store, { force: again.force, lenient: again.lenient, planTurn: planTurnId, retryOf: lock });
    if (!failure) return retry;
    retry.catch(() => {});
  }
  if (failure) throw failure;
  return completed;
}

// The transcript of the plan turn's session: `{ items }`. A read that fails is
// asked again, PLAN_READ_ATTEMPTS times in all: `{ error }` when every one
// failed. `{ over: true }` as soon as the panel moved or the plan turn is over
// (cleared, or a newer one began): nothing more is read for it then.
async function readPlanTranscript(store, at, planTurnId) {
  let error = '';
  for (let attempt = 1; attempt <= PLAN_READ_ATTEMPTS; attempt += 1) {
    let list;
    try { list = await api.sessionMessages(at.sessionId); } catch (err) { list = { ok: false, error: err?.message || String(err) }; }
    if (!planTurnStillOpen(store, at, planTurnId)) return { over: true };
    if (!replyFailed(list)) return { items: Array.isArray(list.data) ? list.data : [] };
    error = replyError(list, 'no answer');
    if (attempt < PLAN_READ_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, PLAN_READ_RETRY_MS));
      if (!planTurnStillOpen(store, at, planTurnId)) return { over: true };
    }
  }
  return { error };
}

// The read of one plan turn and what it leads to. Resolves whether the plan
// turn was completed (PLAN COMPLETE).
async function readAndFinalize(store, at, { planTurnId, startCount, hasPendingQuestions, force, lenient, reason, lock }) {
  const read = await readPlanTranscript(store, at, planTurnId);
  // The panel moved, or this plan turn is over: the transcript and the plan
  // in it are not for what is on screen.
  if (read.over) return false;
  if (!read.items) {
    // The transcript could not be read. While the turn is still running its
    // idle event reads again. Once it is idle nothing else would: the plan
    // turn would stay open, with no card, and hold the queue for ever. It is
    // ended here, and said: the queue is then held by that error like after
    // any turn that failed, and goes on Resume.
    if (store.getState().running) return false;
    // (The error first: it holds the queue before the plan turn lets go of it.)
    store.pushError({
      message: `Could not read the plan of this turn from OpenCode (${read.error}). The plan turn has ended without a plan card. Ask for the plan again to get one.`,
      reason,
    });
    store.clearPlanState({ preserveMode: true });
    return false;
  }
  const items = read.items;
  syncMessages(store, items);

  const extracted = extractPlanFromMessages(items, {
    startCount,
    force,
  });
  const plan = String(extracted.text || '').trim();
  if (!plan) return false;

  if (!force && !extracted.explicitExit && looksLikeProseQuestions(plan)) {
    // Don't surface the prose-question error when the agent already used the
    // question tool (the question card itself is the clarification UX), nor a
    // second time for the read that follows a turned-away finalizer.
    if (!hasPendingQuestions && !lock.saidProse) {
      lock.saidProse = true;
      store.pushError({
        message: 'Plan mode ended with clarification questions in prose. Reply in Plan mode, or ask OpenCode to use its question tool.',
        reason,
      });
    }
    return false;
  }

  if (!force && !lenient && !extracted.explicitExit && !isRealPlanContent(plan)) return false;

  // With pending questions, only fire PLAN COMPLETE for explicit exits or
  // unambiguously plan-shaped bodies — never for a passing mention.
  if (hasPendingQuestions && !extracted.explicitExit && !isRealPlanContent(plan)) return false;

  store.completePlanTurn({ content: plan, header: 'PLAN COMPLETE' });
  ensurePlanFile(store).catch(() => {});
  return true;
}

// Is the plan turn `planTurnId`, under binding `at`, still the one the store
// holds, and still open? Clearing the plan or starting the next plan turn
// changes the identity; leaving plan mode (Build) ends the turn without
// changing it, so `planTurnActive` is part of the answer.
function planTurnStillOpen(store, at, planTurnId) {
  const s = store.getState();
  return at.isCurrent() && s.planTurnActive === true && s.planTurnId === planTurnId;
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
    const at = captureBinding(store);
    const res = await api.compact({
      sessionId: at.sessionId,
      cwd: at.cwd || undefined,
      mcpProfile: at.mcpProfile || undefined,
      model: at.model || undefined,
    });
    // The compaction was that session's. On another binding there is no plan
    // card of it to relabel and nobody to tell about its failure.
    if (!at.isCurrent()) return false;
    if (res?.error) throw new Error(res.error);
    store.setPostPlanActions(true, 'CONTEXT COMPACTED');
    return true;
  }

  if (action === 'edit') {
    if (!plan) throw new Error('No plan content to edit');
    const at = captureBinding(store);
    const filePath = await ensurePlanFile(store);
    // The editor is opened for the session whose plan this is: once the panel
    // is on another binding there is nothing to open, and no error to show.
    if (!at.isCurrent()) return false;
    if (!filePath) throw new Error('Could not create plan file');
    store.setPostPlanActions(false);
    emit('open-plan-editor', { filePath, tabId: at.sessionId, source: PLAN_SOURCE });
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
  // A failure is reported in the session the action was started in.
  const at = captureBinding(first);
  handlePostPlanAction(action, first).catch((err) => {
    if (at.isCurrent()) first.pushError({ message: err?.message || 'Plan action failed' });
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
  const at = captureBinding(store);
  const content = normalizePlanFileContent(currentPlanText(store));
  // A file being made for this very plan is shared; one for another session's
  // plan, or for a plan that has changed since, is not.
  const existing = _planFilePromises.get(store);
  if (existing && existing.binding === at.binding && existing.content === content) return existing.promise;
  if (!content) return '';

  // Still the plan this file was made from, on the binding it was made under?
  const stillThisPlan = () => at.isCurrent() && normalizePlanFileContent(currentPlanText(store)) === content;
  const entry = { binding: at.binding, content, promise: null };
  store.setPlanMaterializing(true);
  entry.promise = fetch('/api/create-plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, cwd: at.cwd || '', projectPath: at.cwd || '' }),
  })
    .then(async (res) => {
      const result = await res.json().catch(() => ({}));
      if (!res.ok || !result?.ok || !result.path) throw new Error(result?.error || 'create-plan failed');
      // The path belongs to the plan it was written from. Another session's
      // plan (or a newer one of this session) never gets it.
      if (!stillThisPlan()) return '';
      store.setPlanContent(currentPlanText(store), { filePath: result.path });
      return result.path;
    })
    .catch((err) => {
      if (at.isCurrent()) store.pushError({ message: err?.message || 'Could not create plan file' });
      return '';
    })
    .finally(() => {
      if (_planFilePromises.get(store) === entry) _planFilePromises.delete(store);
      // The flag of the binding on screen is that binding's (the store reset
      // it when the transcript was cleared).
      if (at.isCurrent()) store.setPlanMaterializing(false);
    });
  _planFilePromises.set(store, entry);

  return entry.promise;
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
  if (hasHeading || hasList) return true;
  const paragraphs = trimmed.split(/\n\n+/).filter((p) => p.trim().length > 20);
  return paragraphs.length >= 3;
}

function looksLikeProseQuestions(content) {
  const tail = String(content || '').slice(-500);
  if (/(^|\n)\s*(quick |a couple of |before i proceed,?\s*|two\s+).*?questions?:?\s*$/im.test(tail)) return true;
  if (/(^|\n)\s*(question|q)\s*\d+\s*[:.]/im.test(tail)) return true;
  return (tail.match(/\?\s*(\n|$)/g) || []).length >= 2;
}
