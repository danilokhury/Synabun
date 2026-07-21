// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — Multi-panel manager
// Tracks the primary OCP v2 panel + the (single) active sub-agent child panel.
// Sub-agent rules (per user spec):
//   • At most ONE child panel at a time. A new sub-agent REPLACES any
//     existing one (the old child is destroyed).
//   • Spawned MINIMIZED — the child appears as a tray pill, not auto-visible.
//   • Mutually exclusive with the primary panel — only one is visible.
// ─────────────────────────────────────────────────────────────────────────────

import {
  subscribeSessionCreated, subscribeSession, onEvent, api,
} from './ocp-v2-ws.js';
import { createPanelStore } from './ocp-v2-state.js';
import { createChildPanel } from './ocp-v2-childpanel.js';
import { inheritChildPanelMcpProfile } from './ocp-v2-profile-inheritance.js';
import { notify as uiNotify, NOTIF_TYPE } from '../ui-notifications.js';
import {
  isAutomationSession, onAutomationSessionRegistered, shouldMaterializeChildPanel,
} from './ocp-v2-automation-ownership.js';

const AGENT_TOOL_NAMES = new Set([
  'task', 'agent', 'Task', 'Agent',
  // OpenCode SDK variants observed in the wild — the spawn tool name has
  // drifted across SDK versions. Keep the set permissive so a renamed tool
  // still spawns the child pill.
  'invoke', 'Invoke', 'subagent', 'Subagent', 'sub_agent', 'spawn', 'Spawn',
  'explore', 'Explore', 'plan', 'Plan',
]);

function readParentID(info) {
  if (!info) return '';
  return (
    info.parentID || info.parentId || info.parent_id ||
    info.session?.parentID || info.session?.parentId ||
    info.properties?.info?.parentID || info.properties?.info?.parentId ||
    ''
  );
}

let _primary = null;            // { panelId, store, getSessionId }
let _activeChild = null;        // { panelId, sessionId, parentSessionId, store, instance, wsUnsub }
let _started = false;
let _primaryWsUnsub = null;

export function registerPrimaryPanel({ panelId, store, getSessionId }) {
  _primary = { panelId, store, getSessionId };
  startManager();
  // Retroactive scan: a sub-agent session may already exist server-side
  // (created before this panel registered, or surviving a page reload).
  // Without this, the tray pill never appears until the user manually
  // resumes it from the resume header.
  scanForOrphanChildren().catch((err) => {
    console.warn('[ocp-v2-manager] initial orphan scan failed', err);
  });
}

export function bindPrimarySession(store, sessionId) {
  if (_primaryWsUnsub) { try { _primaryWsUnsub(); } catch {} _primaryWsUnsub = null; }
  if (sessionId) _primaryWsUnsub = subscribeSession(sessionId, store);
  // Whenever the primary's active session changes, re-scan: the new active
  // session may already have a sub-agent attached server-side.
  if (sessionId) {
    scanForOrphanChildren().catch((err) => {
      console.warn('[ocp-v2-manager] bind-time orphan scan failed', err);
    });
  }
}

async function scanForOrphanChildren() {
  if (!_primary) return;
  const parentSid = _primary.getSessionId?.();
  if (!parentSid || isAutomationSession(parentSid)) return;
  let sessions = [];
  try {
    const res = await api.sessionList();
    sessions = Array.isArray(res?.data) ? res.data : (res?.data?.sessions || []);
  } catch (err) {
    console.warn('[ocp-v2-manager] sessionList for orphan scan failed', err);
    return;
  }
  // Ownership can arrive from the native event socket while session:list is
  // in flight. Recheck before materializing anything from the response.
  if (isAutomationSession(parentSid)) return;
  // Prefer the most-recently-created child if multiple exist (manager only
  // tracks one active child at a time, matching the existing single-child rule).
  const children = sessions
    .filter((s) => readParentID(s) === parentSid)
    .sort((a, b) => {
      const ta = a?.time?.created || a?.time?.updated || 0;
      const tb = b?.time?.created || b?.time?.updated || 0;
      return tb - ta;
    });
  if (!children.length) return;
  const target = children[0];
  const childSid = target?.id || target?.sessionID;
  if (!childSid) return;
  if (_activeChild?.sessionId === childSid) return;
  console.log('[ocp-v2-manager] orphan scan found child', { parentSid, childSid });
  ensureChildSpawn(parentSid, childSid, target, null, lookupParentTaskInfo(childSid));
}

function startManager() {
  if (_started) return;
  _started = true;
  onAutomationSessionRegistered(({ sessionId }) => {
    if (_activeChild?.parentSessionId === sessionId) destroyActiveChild();
  });
  subscribeSessionCreated((event) => {
    const info = event?.info || event?.properties?.info || event;
    const childId = info?.id || event?.id || event?.sessionID || event?.sessionId;
    const parentID = readParentID(info) || readParentID(event);
    console.log('[ocp-v2-manager] session.created', { childId, parentID, primarySid: _primary?.getSessionId?.() });
    if (!childId || !parentID) return;
    ensureChildSpawn(parentID, childId, info, null, lookupParentTaskInfo(childId));
  });

  // Some OpenCode SDK builds emit `session.created` WITHOUT parentID first,
  // then a `session.updated` enriches the info object. Catch the linkage on
  // updates too — without this, a sub-agent whose parentID arrives late is
  // never paired with its parent and the pill never spawns.
  onEvent((eventType, ev) => {
    if (eventType !== 'session.updated') return;
    if (!_primary) return;
    const info = ev?.info || ev?.session || ev;
    const childId = info?.id || ev?.sessionID || ev?.sessionId;
    const parentID = readParentID(info) || readParentID(ev);
    if (!childId || !parentID) return;
    if (childId === _primary.getSessionId?.()) return;
    if (_activeChild?.sessionId === childId) return;
    console.log('[ocp-v2-manager] session.updated linked child', { childId, parentID });
    ensureChildSpawn(parentID, childId, info, null, lookupParentTaskInfo(childId));
  });

  // Fallback: many OpenCode SDK builds emit `session.created` for sub-agents
  // either late or without `parentID`. Mirror the OCP v1 strategy and also
  // detect child-session ids from agent tool metadata on `tool.start` and
  // `message.part.updated` events. Without this fallback, a Task tool can run
  // to completion while the child panel never spawns.
  onEvent((eventType, ev) => {
    if (!_primary) return;
    if (eventType !== 'message.part.updated' && eventType !== 'tool.start') return;
    const parentSid = ev?.sessionID || ev?.sessionId;
    // Allow the fallback to fire even if the active session has just switched —
    // the spawn must still be tied to the originating parent, not the
    // currently-selected one. Without this relaxation, switching tabs between
    // sending a plan and the agent firing loses the child pill.
    if (!parentSid) return;
    const isKnownPrimary = parentSid === _primary.getSessionId();

    let toolName = '';
    let childSid = '';
    let replayPart = null;
    if (eventType === 'message.part.updated') {
      const part = ev.part || {};
      if (part.type !== 'tool') return;
      toolName = part.tool || part.name || '';
      childSid = part?.state?.metadata?.sessionId
        || part?.state?.metadata?.sessionID
        || part?.metadata?.sessionId
        || part?.metadata?.sessionID
        || part?.state?.input?.sessionId
        || part?.state?.input?.sessionID
        || '';
      replayPart = part;
    } else {
      toolName = ev.tool || ev.name || '';
      childSid = ev?.metadata?.sessionId
        || ev?.metadata?.sessionID
        || ev?.state?.metadata?.sessionId
        || ev?.state?.metadata?.sessionID
        || '';
    }
    if (!childSid) return;
    // If the tool name isn't a known agent tool, only continue when the
    // session id metadata is present AND it differs from the parent (which
    // means it really is a child session id, not noise).
    const isKnownAgent = AGENT_TOOL_NAMES.has(toolName);
    if (!isKnownAgent && (childSid === parentSid)) return;
    if (!isKnownPrimary) {
      // Only spawn on the OTHER primary session if no child is currently
      // attached — avoids hijacking the tray when the user is mid-switch.
      if (_activeChild) return;
    }
    console.log('[ocp-v2-manager] subagent detected via', eventType, 'tool', toolName, 'child', childSid);
    // The triggering event was already dispatched by the WS layer BEFORE the
    // child store was registered, so per-session fanout dropped it. Replay
    // into the child store after spawn so the agent-tool input/output isn't
    // lost from the child transcript.
    const replay = replayPart ? (store) => store.upsertPart(replayPart) : null;
    // Pull the task brief from the parent's tool input so the child header can
    // show "explore · do X" instead of an opaque "idle".
    const taskInfo = describeAgentTask(replayPart, ev, toolName);
    ensureChildSpawn(parentSid, childSid, null, replay, taskInfo);
  });
}

function describeAgentTask(part, ev, toolName) {
  const input = part?.state?.input || part?.input || ev?.state?.input || ev?.input || {};
  const description = String(input.description || '').trim();
  const prompt = String(input.prompt || '').trim();
  const subagentType = String(input.subagent_type || input.agent || input.agentType || '').trim();
  const summary = description || (prompt ? prompt.split(/\r?\n/, 1)[0] : '');
  return {
    subagentType: subagentType || toolName || '',
    summary: summary || '',
  };
}

// When a child arrives via session.created (no tool part attached), scan the
// parent's recent message parts for the agent-tool call whose metadata points
// to this child's sessionId. Lets the header show "explore · do X" even when
// the spawn was reported through the SDK's session events rather than the
// tool-call replay path.
function lookupParentTaskInfo(childSid) {
  if (!_primary?.store || !childSid) return null;
  const s = _primary.store.getState();
  const order = s.messageOrder || [];
  for (let i = order.length - 1; i >= 0; i--) {
    const msg = s.messages?.get?.(order[i]);
    if (!msg?.parts) continue;
    for (const part of msg.parts.values()) {
      if (part?.type !== 'tool') continue;
      const toolName = part.tool || part.name || '';
      const metaSid =
        part?.state?.metadata?.sessionId ||
        part?.state?.metadata?.sessionID ||
        part?.metadata?.sessionId ||
        part?.metadata?.sessionID ||
        part?.state?.input?.sessionId ||
        part?.state?.input?.sessionID ||
        '';
      if (metaSid !== childSid) continue;
      return describeAgentTask(part, null, toolName);
    }
  }
  return null;
}

function ensureChildSpawn(parentSid, childSid, childInfo, replay, taskInfo) {
  if (!_primary) return;
  if (!shouldMaterializeChildPanel(parentSid, childSid)) {
    if (_activeChild?.parentSessionId === parentSid) destroyActiveChild();
    return;
  }
  // Only spawn when the parent matches our current primary session OR there's
  // no active child yet (handles tab-switching during a sub-agent spawn).
  const primarySid = _primary.getSessionId?.();
  if (parentSid !== primarySid && _activeChild) return;
  if (_activeChild && _activeChild.sessionId === childSid) {
    if (typeof replay === 'function') {
      try { replay(_activeChild.store); } catch (err) {
        console.warn('[ocp-v2-manager] child event replay failed', err);
      }
    }
    if (taskInfo && _activeChild.instance?.setTaskInfo) {
      try { _activeChild.instance.setTaskInfo(taskInfo); } catch {}
    }
    return;
  }
  if (_activeChild) destroyActiveChild();
  spawnChildPanel({
    childSessionId: childSid,
    childInfo,
    parentPanelId: _primary.panelId,
    parentSessionId: parentSid,
    parentTitle: parentTitleFor(_primary),
    replay,
    taskInfo,
  });
}

function parentTitleFor(reg) {
  try {
    const s = reg.store?.getState?.();
    return String(s?.sessionInfo?.title || s?.sessionInfo?.slug || (reg.getSessionId?.() || '').slice(0, 8) || 'parent').trim() || 'parent';
  } catch { return 'parent'; }
}

function spawnChildPanel({ childSessionId, childInfo, parentPanelId, parentSessionId, parentTitle, replay, taskInfo }) {
  const panelId = `ocp-v2-child-${childSessionId.slice(0, 8)}-${Date.now().toString(36)}`;
  const store = createPanelStore();
  store.setSession(childSessionId, childInfo || null);
  store.setParentSession(parentSessionId, parentPanelId);
  inheritChildPanelMcpProfile(store, _primary?.store, childInfo);

  const wsUnsub = subscribeSession(childSessionId, store);

  // Replay must run AFTER subscribe so the part lands in the child store; the
  // store de-dupes by id, so a later WS event for the same part is harmless.
  if (typeof replay === 'function') {
    try { replay(store); } catch (err) {
      console.warn('[ocp-v2-manager] initial child event replay failed', err);
    }
  }

  // Mark the parent pill so it visibly reflects "a sub-agent is attached" and
  // "the sub-agent is currently running". Without this, when the child pill
  // collapses into the tray a user can't tell the parent has work happening
  // downstream.
  markParentPillChildAttached(parentSessionId, true);
  updateParentPillChildRunning(parentSessionId, !!store.getState().running);

  // Surface a toast so the user gets immediate visual feedback that a
  // sub-agent spawned — the tray pill alone is easy to miss when the user
  // is looking at the panel content.
  try {
    uiNotify('panel', NOTIF_TYPE.ACTION, `↳ Sub-agent of ${parentTitle}`, {
      panel: 'opencode',
      provider: 'opencode',
    });
  } catch (err) {
    console.warn('[ocp-v2-manager] spawn notification failed', err);
  }

  // On running:set, mirror the child's running state onto the parent pill, and
  // — when the child has just become idle — re-poke the parent's plan
  // lifecycle so a PLAN COMPLETE deferred by an in-flight sub-agent finalizes
  // now. Lazy import avoids a static cycle (plan.js → manager.js → plan.js).
  const childRunSub = store.subscribe((event, state) => {
    if (event?.type === 'running:set') {
      updateParentPillChildRunning(parentSessionId, !!state.running);
    }
    if (event?.type !== 'running:set' || state.running) return;
    if (!_primary?.store) return;
    if (!_primary.store.getState().planTurnActive) return;
    import('./ocp-v2-plan.js').then(({ maybeFinalizePlanTurn }) => {
      maybeFinalizePlanTurn('child:idle', _primary.store, { lenient: true }).catch(() => {});
    }).catch(() => {});
  });

  const instance = createChildPanel({
    panelId,
    sessionId: childSessionId,
    store,
    parentPanelId,
    parentSessionId,
    parentTitle,
    taskInfo,
    onClose: (id) => {
      if (_activeChild?.panelId === id) {
        if (_activeChild.wsUnsub) try { _activeChild.wsUnsub(); } catch {}
        try { _activeChild.runSub?.(); } catch {}
        clearParentChildIndicator(parentSessionId);
        _activeChild = null;
      }
    },
  });

  _activeChild = {
    panelId, sessionId: childSessionId, parentSessionId, store, instance, wsUnsub, runSub: childRunSub,
  };

  hydrateChildPanel(store, childSessionId).catch((err) => {
    console.warn('[ocp-v2-manager] hydrate child panel failed', err);
  });
}

function destroyActiveChild() {
  if (!_activeChild) return;
  const parentSid = _activeChild.parentSessionId || _primary?.getSessionId?.() || '';
  try { _activeChild.instance?.unmount?.(); } catch {}
  if (_activeChild.wsUnsub) try { _activeChild.wsUnsub(); } catch {}
  try { _activeChild.runSub?.(); } catch {}
  clearParentChildIndicator(parentSid);
  _activeChild = null;
}

function parentPillFor(parentSid) {
  if (!parentSid) return null;
  const tray = document.getElementById('term-minimized-tray');
  if (!tray) return null;
  const safe = String(parentSid).replace(/(["\\])/g, '\\$1');
  return tray.querySelector(`.ocpv2-session-pill[data-session-id="${safe}"]:not(.ocpv2-session-pill-child)`);
}

function markParentPillChildAttached(parentSid, attached) {
  const pill = parentPillFor(parentSid);
  if (!pill) return;
  pill.classList.toggle('ocpv2-pill-has-child', !!attached);
}

function updateParentPillChildRunning(parentSid, running) {
  const pill = parentPillFor(parentSid);
  if (!pill) return;
  pill.classList.toggle('ocpv2-pill-child-running', !!running);
}

function clearParentChildIndicator(parentSid) {
  const pill = parentPillFor(parentSid);
  if (!pill) return;
  pill.classList.remove('ocpv2-pill-has-child', 'ocpv2-pill-child-running');
}

async function hydrateChildPanel(store, sessionId) {
  try {
    const res = await api.sessionGet(sessionId);
    if (res?.data) store.setSession(sessionId, res.data);
  } catch {}
  try {
    const list = await api.sessionMessages(sessionId);
    const items = list?.data || [];
    let inFlight = false;
    for (const { info, parts } of items) {
      if (!info?.id) continue;
      store.upsertMessage(info);
      for (const part of (parts || [])) store.upsertPart(part);
      if (info?.role === 'assistant') {
        const completed = info?.time?.completed;
        if (completed == null || completed === 0) inFlight = true;
      }
      for (const part of (parts || [])) {
        const status = part?.state?.status || part?.status;
        if (status === 'running' || status === 'pending') inFlight = true;
      }
    }
    if (inFlight && !store.getState().running) store.setRunning(true);
  } catch {}
}

export function getActiveChild() {
  return _activeChild ? { panelId: _activeChild.panelId, sessionId: _activeChild.sessionId } : null;
}

// True when a sub-agent for `parentSessionId` is currently spawned AND its
// session is still running. Used by the plan lifecycle to defer PLAN COMPLETE
// finalization until the sub-agent has reported back.
export function hasRunningChildForParent(parentSessionId) {
  if (!_activeChild || !parentSessionId) return false;
  if (!_primary || _primary.getSessionId?.() !== parentSessionId) return false;
  try { return !!_activeChild.store?.getState?.().running; } catch { return false; }
}

export function isActiveChildPanelOpen() {
  return !!_activeChild?.instance?.isVisible?.();
}

export function hideActiveChildPanel() {
  if (!_activeChild?.instance?.isVisible?.()) return false;
  try {
    _activeChild.instance.hide?.();
    return true;
  } catch (err) {
    console.warn('[ocp-v2-manager] hide active child panel failed', err);
    return false;
  }
}

export function destroyChildPanelById(panelId) {
  if (_activeChild?.panelId === panelId) destroyActiveChild();
}
