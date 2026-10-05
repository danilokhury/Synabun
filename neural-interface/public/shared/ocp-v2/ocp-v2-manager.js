// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — Multi-panel manager
// Tracks the primary OCP v2 panel and the sub-agent panels of its sessions.
// Sub-agent rules (ocp-v2-subagents-logic.js has them without the DOM):
//   • One panel and one pill per sub-agent session, at any depth (a sub-agent
//     of a sub-agent too). A new sub-agent never destroys or reuses another
//     one's panel, and there is no cap.
//   • All of them stay live: a panel that is off screen follows its session.
//   • Spawned MINIMIZED — a sub-agent appears as a tray pill; nothing opens
//     by itself. An automation's sub-agents get neither pill nor panel.
//   • The pills and panels belong to their parent session: the tray shows the
//     set of the session the main panel is on, and keeps the others.
//   • Which OpenCode panel is on screen is decided in one function
//     (decideVisibility), applied here by requestOpencodeView().
//   • A sub-agent costs what its pill needs (its run state and the requests
//     that wait for the user) until its panel is first shown: then its
//     session is read whole.
// ─────────────────────────────────────────────────────────────────────────────

import {
  subscribeSessionCreated, subscribeSession, onEvent, api, hasSessionStore, supports,
  onReconnect, isDescendantSession, rememberSessionParent, handOverRequests,
} from './ocp-v2-ws.js';
import { rehydratePanelSession, rehydrateSessionState } from './ocp-v2-rehydrate.js';
import { captureBinding, latestOnly } from './ocp-v2-binding.js';
import { storage } from '../storage.js';
import { on } from '../state.js';
import { setSidepanelVisible } from '../ui-sidepanel-windows.js';
import { createPanelStore } from './ocp-v2-state.js';
import { createChildPanel } from './ocp-v2-childpanel.js';
import { inheritChildPanelMcpProfile } from './ocp-v2-profile-inheritance.js';
import { notify as uiNotify, NOTIF_TYPE } from '../ui-notifications.js';
import {
  isAutomationSession, onAutomationSessionRegistered, shouldMaterializeChildPanel,
} from './ocp-v2-automation-ownership.js';
import {
  MAIN_VIEW, decideVisibility, createSubagentRegistry, placeSubagent, descendantsOf, trayPills,
  createClosedSubagents, createShownSubagent, createLimiter, trayGroupHeight, trayGroupScrolls,
  lineageOf, entriesUnder, createUnsentPrompts, unsentSubagentNotice,
} from './ocp-v2-subagents-logic.js';

export { MAIN_VIEW };

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

let _primary = null;            // { panelId, store, getSessionId, ownsSession, keepPrompts }
let _mainView = null;           // { owner, isVisible }: the main panel in the shared slot
let _started = false;
let _primaryWsUnsub = null;
// Every sub-agent panel: sessionId → { panelId, sessionId, parentSessionId,
// rootSessionId, depth, startedAt, store, instance, wsUnsub, runSub }.
const _panels = createSubagentRegistry();
// child session → parent session, learned from session events and from the
// children the server listed: how a sub-agent of a sub-agent finds its set.
const _parentOf = new Map();
// One orphan scan at a time counts: a newer one (the next binding, a rescan)
// takes over from the one still waiting for its answer.
const _orphanScans = latestOnly();
// Transcripts of sub-agent panels are read a few at a time.
const _hydrations = createLimiter(4);
// Prompts that were on their way to a sub-agent when its panel went away, and
// whose send then failed: kept for that sub-agent until its panel is opened again.
const _unsent = createUnsentPrompts();
// Sub-agents that were announced before the chain of their parents reached a
// tab (a parent whose own parent link arrives later, with session.updated):
// child → { parentSid, childInfo, taskInfo }, the newest UNPLACED_MAX. Each is
// placed when its parent gets its panel (placeWaitingChildren).
const UNPLACED_MAX = 256;
const _unplaced = new Map();
// The sub-agents whose panel the user closed (one list for every window, kept
// across reloads): nothing but "Open sub-agent" brings one back.
const STOR_CLOSED = 'opencode-v2-subagents-closed';
const _closed = createClosedSubagents({
  load: () => JSON.parse(storage.getItem(STOR_CLOSED) || '{}'),
  save: (entries) => {
    if (Object.keys(entries).length) storage.setItem(STOR_CLOSED, JSON.stringify(entries));
    else storage.removeItem(STOR_CLOSED);
  },
});
// The sub-agent panel that is on screen, for this window, across a reload.
const STOR_SHOWN = 'ocp-v2-subagent-shown';
const _shown = createShownSubagent({
  load: () => JSON.parse(sessionStorage.getItem(STOR_SHOWN) || 'null'),
  save: (view) => {
    if (view) sessionStorage.setItem(STOR_SHOWN, JSON.stringify(view));
    else sessionStorage.removeItem(STOR_SHOWN);
  },
});

// The main panel says where it is in the shared slot (before it boots: it can
// be shown before it is registered as the primary).
export function registerMainView({ owner, isVisible }) {
  _mainView = { owner, isVisible };
}

//   ownsSession(id)       is this session a tab of the main panel? (its
//                         sub-agents get panels here; another window's do not)
//   keepPrompts(items, label)
//                         prompts that were waiting in a sub-agent panel that
//                         went away by itself: kept for the user on notices
export function registerPrimaryPanel({ panelId, store, getSessionId, ownsSession, keepPrompts }) {
  _primary = { panelId, store, getSessionId, ownsSession, keepPrompts };
  startManager();
  syncSubagentTray();
  // Retroactive scan: sub-agent sessions may already exist server-side
  // (created before this panel registered, or surviving a page reload).
  // Without this, their tray pills never appear.
  scanForOrphanChildren().catch((err) => {
    console.warn('[ocp-v2-manager] initial orphan scan failed', err);
  });
}

export function bindPrimarySession(store, sessionId) {
  if (_primaryWsUnsub) { try { _primaryWsUnsub(); } catch {} _primaryWsUnsub = null; }
  if (sessionId) _primaryWsUnsub = subscribeSession(sessionId, store);
  // The pills in the tray are those of the session the main panel is on. A
  // sub-agent panel of another session does not stay on screen over it.
  const shown = visibleEntry();
  if (shown && shown.rootSessionId !== (sessionId || '')) requestOpencodeView({ hide: shown.panelId });
  syncSubagentTray();
  // Whenever the primary's active session changes, re-scan: the new active
  // session may already have sub-agents server-side.
  if (sessionId) {
    scanForOrphanChildren().catch((err) => {
      console.warn('[ocp-v2-manager] bind-time orphan scan failed', err);
    });
  }
}

const listOf = (res) => (Array.isArray(res?.data) ? res.data : (res?.data?.sessions || []));

async function scanForOrphanChildren() {
  if (!_primary) return;
  const parentSid = _primary.getSessionId?.();
  if (!parentSid || isAutomationSession(parentSid)) return;
  // The scan is for the session the primary panel is on now. Its answer may
  // spawn child panels only while the panel is still on that binding and no
  // newer scan was started.
  const at = captureBinding(_primary.store, { sessionId: parentSid });
  const latest = _orphanScans.begin();
  let sessions = [];
  try {
    // session.children is the direct question, asked for the session and then
    // for every child it lists (sub-agents of sub-agents); a server without it
    // lists every session and descendantsOf picks the tree out.
    if (supports('session:children')) sessions = await readChildTree(parentSid, () => latest() && at.isCurrent());
    else sessions = descendantsOf(listOf(await api.sessionList()), parentSid);
  } catch (err) {
    console.warn('[ocp-v2-manager] child session lookup for orphan scan failed', err);
    return;
  }
  // Ownership can arrive from the native event socket while session:list is
  // in flight. Recheck before materializing anything from the response.
  if (isAutomationSession(parentSid)) return;
  // So can a session switch: a child of the session the panel has left is not
  // materialized under the one it is on now.
  if (!latest() || !at.isCurrent()) return;
  // Every sub-agent of the session gets its panel and its pill back, in the
  // order they were started (the user's closes excepted). Nothing is shown,
  // and nothing is announced: these did not just start.
  for (const session of sessions) {
    const childSid = session?.id || session?.sessionID;
    if (!childSid || !readParentID(session)) continue;
    _parentOf.set(childSid, readParentID(session));
    // The server listed this link: requests are routed and auto-accept is
    // inherited along it, as along one that a session event carried.
    rememberSessionParent(childSid, readParentID(session));
  }
  for (const session of sessions) {
    const childSid = session?.id || session?.sessionID;
    const parent = readParentID(session);
    if (!childSid || !parent) continue;
    ensureChildSpawn(parent, childSid, session, null, lookupParentTaskInfo(childSid, parent), { announce: false });
  }
  _scanned.add(parentSid);
  restoreShown();
  noteShown();
}

// After a reload: the sub-agent panel that was on screen is on screen again.
// Once, when the user has the main panel on screen on the session it belonged
// to and that session's children were read (nothing opens by itself: a panel
// an automation booted waits for the user to open OpenCode).
const _scanned = new Set();        // sessions whose children were read since the page loaded
function restoreShown() {
  const root = _primary?.getSessionId?.() || '';
  if (!root) return;
  const was = _shown.restoreFor(root, { mainVisible: !!_mainView?.isVisible?.(), ready: _scanned.has(root) });
  const entry = was ? _panels.get(was) : null;
  if (entry && entry.rootSessionId === root) requestOpencodeView({ show: entry.panelId });
}

function startManager() {
  if (_started) return;
  _started = true;
  // The primary panel heals itself on a reconnect; the sub-agent panels are
  // re-read here, or they would come back without their cards or stay "running".
  onReconnect(() => {
    for (const entry of _panels.all()) {
      // (A few at a time, like the first read: there can be many of them.)
      _hydrations(() => hydrateChildPanel(entry.store, entry.sessionId))
        .then((out) => {
          // Its header said "reconnecting" since the socket closed.
          // (A panel that was never shown had what its pill needs read, and no transcript.)
          if ((out.transcript || out.pill) && _panels.get(entry.sessionId)?.store === entry.store) entry.store.setServerStatus({ status: 'ready' });
        })
        .catch((err) => console.warn('[ocp-v2-manager] child rehydrate after reconnect failed', err));
    }
  });
  onAutomationSessionRegistered(({ sessionId }) => {
    destroyPanelsOf(sessionId);
  });
  // The main panel went on or off screen: the pills dock to its pill or stand alone.
  // (The restore after a reload is tried once the main panel's own show is over.)
  on('opencode-panel:visibility', (visible) => {
    syncSubagentTray();
    noteShown();
    if (visible) setTimeout(() => { restoreShown(); noteShown(); }, 0);
  });
  // The room under the group changes with the window.
  if (typeof window !== 'undefined') window.addEventListener('resize', () => { _groupLayoutKey = ''; scheduleTraySync(); });
  subscribeSessionCreated((event) => {
    const info = event?.info || event?.properties?.info || event;
    const childId = info?.id || event?.id || event?.sessionID || event?.sessionId;
    const parentID = readParentID(info) || readParentID(event);
    if (!childId || !parentID) return;
    ensureChildSpawn(parentID, childId, info, null, lookupParentTaskInfo(childId, parentID));
  });

  onEvent((eventType, ev) => {
    if (!_primary) return;
    // Some OpenCode SDK builds emit `session.created` WITHOUT parentID first,
    // then a `session.updated` enriches the info object. Catch the linkage on
    // updates too — without this, a sub-agent whose parentID arrives late is
    // never paired with its parent and the pill never spawns.
    if (eventType === 'session.updated') {
      const info = ev?.info || ev?.session || ev;
      const childId = info?.id || ev?.sessionID || ev?.sessionId;
      const parentID = readParentID(info) || readParentID(ev);
      if (!childId || !parentID) return;
      if (childId === _primary.getSessionId?.()) return;
      if (_panels.has(childId)) return;
      // (The sub-agents that named this session as their parent before its own
      // parent was known are placed with it: placeWaitingChildren.)
      ensureChildSpawn(parentID, childId, info, null, lookupParentTaskInfo(childId, parentID));
      return;
    }
    // A sub-agent session OpenCode deleted takes its panel with it. (The
    // session in the main panel is the main panel's to close: releaseSubagentPanels.)
    if (eventType === 'session.deleted') {
      const gone = ev?.info?.id || ev?.sessionID || ev?.sessionId;
      if (!gone) return;
      _parentOf.delete(gone);
      _unplaced.delete(gone);
      _closed.forget(gone);
      const entry = _panels.get(gone);
      // (Its requests went with the session: none is handed to a parent's panel.)
      if (entry) destroyPanel(entry, { lost: true, requests: false });
    }
  });

  // Fallback: many OpenCode SDK builds emit `session.created` for sub-agents
  // either late or without `parentID`. Also detect child-session ids from the
  // agent tool's metadata on `message.part.updated`. Without this fallback, a
  // Task tool can run to completion while the child panel never spawns.
  onEvent((eventType, ev) => {
    if (!_primary) return;
    if (eventType !== 'message.part.updated') return;
    // The spawn is tied to the session the tool ran in (the session in the
    // main panel, another tab, or a sub-agent), not to the one on screen.
    const parentSid = ev?.sessionID || ev?.sessionId;
    if (!parentSid) return;

    const part = ev.part || {};
    if (part.type !== 'tool') return;
    const toolName = part.tool || part.name || '';
    const childSid = part?.state?.metadata?.sessionId
      || part?.state?.metadata?.sessionID
      || part?.metadata?.sessionId
      || part?.metadata?.sessionID
      || part?.state?.input?.sessionId
      || part?.state?.input?.sessionID
      || '';
    const replayPart = part;
    if (!childSid) return;
    // If the tool name isn't a known agent tool, only continue when the
    // session id metadata is present AND it differs from the parent (which
    // means it really is a child session id, not noise).
    const isKnownAgent = AGENT_TOOL_NAMES.has(toolName);
    if (!isKnownAgent && (childSid === parentSid)) return;
    // The triggering event was already dispatched by the WS layer BEFORE the
    // child store was registered, so per-session fanout dropped it. Replay
    // into the child store after spawn so the agent-tool input/output isn't
    // lost from the child transcript.
    const replay = replayPart ? (store) => store.upsertPart(replayPart) : null;
    // Pull the task brief from the parent's tool input so the child header can
    // show "explore · do X" instead of an opaque "idle".
    const taskInfo = describeAgentTask(replayPart, ev, toolName);
    ensureChildSpawn(parentSid, childSid, null, replay, taskInfo, { inferred: true });
  });
}

// The descendants of `rootSid` as the server lists them: its children, then
// the children of each of those. `wanted()` turns false once the scan was
// overtaken; nothing more is asked then.
async function readChildTree(rootSid, wanted) {
  const out = [];
  const seen = new Set([rootSid]);
  let level = [rootSid];
  for (let depth = 0; depth < 12 && level.length; depth += 1) {
    const next = [];
    for (const parent of level) {
      if (!wanted()) return out;
      const children = listOf(await api.sessionChildren({ sessionId: parent }))
        .filter((s) => readParentID(s) === parent);
      for (const child of children) {
        const id = child?.id || child?.sessionID;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(child);
        next.push(id);
      }
    }
    level = next;
  }
  return descendantsOf([{ id: rootSid }, ...out], rootSid);
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
// The task card is in the transcript of the session that started the
// sub-agent: the main panel's for a sub-agent of the session it is on, the
// parent's own panel for a sub-agent of a sub-agent.
function lookupParentTaskInfo(childSid, parentSid = _parentOf.get(childSid)) {
  if (!childSid) return null;
  for (const store of [_panels.get(parentSid)?.store, _primary?.store]) {
    const found = store ? taskInfoIn(store.getState(), childSid) : null;
    if (found) return found;
  }
  return null;
}

function taskInfoIn(s, childSid) {
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

// A session whose sub-agents get their panels here: the one the main panel is
// on, or another of its tabs.
function isRootSession(sessionId) {
  if (!_primary || !sessionId) return false;
  if (sessionId === _primary.getSessionId?.()) return true;
  try { return _primary.ownsSession?.(sessionId) === true; } catch { return false; }
}

// The automation's session that `sessionId` is, or is below, at any depth
// ('' when there is none).
//   chain   the parents its panel was made with, should a link be forgotten
function automationOver(sessionId, chain = []) {
  return [...lineageOf(sessionId, _parentOf), ...chain].find((id) => isAutomationSession(id)) || '';
}

// A sub-agent whose chain of parents does not reach a tab (yet).
function waitForParent(childSid, { parentSid, childInfo, taskInfo }) {
  const was = _unplaced.get(childSid);
  _unplaced.delete(childSid);
  _unplaced.set(childSid, { parentSid, childInfo: childInfo || was?.childInfo || null, taskInfo: taskInfo || was?.taskInfo || null });
  while (_unplaced.size > UNPLACED_MAX) _unplaced.delete(_unplaced.keys().next().value);
}

// A sub-agent got its panel: the sub-agents that named it as their parent
// before its own parent link was known are placed now, and theirs after them.
function placeWaitingChildren(parentSid, { announce }) {
  for (const [childSid, was] of [..._unplaced]) {
    if (was.parentSid !== parentSid || !_unplaced.has(childSid)) continue;
    _unplaced.delete(childSid);
    ensureChildSpawn(parentSid, childSid, was.childInfo, null, was.taskInfo || lookupParentTaskInfo(childSid, parentSid), { announce });
  }
}

// The panel of `childSid`, made when it has none. Returns its entry, or null
// when the sub-agent gets no panel: its lineage does not lead to a tab of this
// panel, an automation owns it, or the user closed it (`reopen` lifts that).
//   announce   a sub-agent that just started (a toast, the pill's entrance)
//   inferred   the parent is what a task tool's part, a task card or a crumb
//              says, not what the server reported for the session
function ensureChildSpawn(parentSid, childSid, childInfo, replay, taskInfo, { announce = true, reopen = false, inferred = false } = {}) {
  if (!_primary || !parentSid || !childSid || parentSid === childSid) return null;
  // A link that is only inferred never replaces a known one: a sub-agent
  // stays where its session says it is, and an automation's sub-agent stays
  // an automation's, whatever names it as its own.
  const known = _parentOf.get(childSid);
  if (inferred && known && known !== parentSid) parentSid = known;
  _parentOf.set(childSid, parentSid);
  if (!shouldMaterializeChildPanel(parentSid, childSid)) {
    destroyPanelsOf(parentSid);
    return null;
  }
  // A session an automation owns has no pill and no panel here, and neither
  // has anything below it, at any depth. Checked on the whole chain of
  // parents, whatever announced the sub-agent, and for one that has a panel
  // as for a new one: a session can become an automation's at any moment.
  const existing = _panels.get(childSid);
  const owner = automationOver(childSid, existing?.chain);
  if (owner) {
    destroyPanelsOf(owner);
    return null;
  }
  if (existing) {
    if (typeof replay === 'function') {
      try { replay(existing.store); } catch (err) {
        console.warn('[ocp-v2-manager] child event replay failed', err);
      }
    }
    if (taskInfo && existing.instance?.setTaskInfo) {
      try {
        existing.instance.setTaskInfo(taskInfo);
        if (taskInfo.subagentType || taskInfo.summary) existing.briefed = true;
      } catch {}
    }
    return existing;
  }
  const placed = placeSubagent({ parentSessionId: parentSid, childSessionId: childSid, parentOf: _parentOf, isRoot: isRootSession });
  if (!placed) {
    // The chain of its parents does not reach a tab (yet). When the link that
    // is missing arrives, the sub-agent is placed with its parent.
    waitForParent(childSid, { parentSid, childInfo, taskInfo });
    return null;
  }
  // An automation's sub-agents stay inside its one tab, at every depth.
  if (placed.chain.some((sessionId) => isAutomationSession(sessionId))) return null;
  // The user closed this sub-agent's panel: no event and no scan brings it back.
  if (!reopen && _closed.isClosed(childSid)) return null;
  _closed.reopen(childSid);
  return spawnChildPanel({
    childSessionId: childSid,
    childInfo,
    parentPanelId: _primary.panelId,
    parentSessionId: parentSid,
    rootSessionId: placed.rootSessionId,
    chain: placed.chain,
    parentTitle: parentTitleFor(_primary, parentSid),
    replay,
    taskInfo,
    announce,
  });
}

// The title of the session that spawned the sub-agent. A sub-agent that has
// sub-agents itself is known by its own panel. Else the primary panel's store
// knows it while it is bound to that session; a child of a session the
// panel is not on (a spawn that arrives after a tab switch) gets that
// session's own title from what the store has seen of it, never the title of
// the session on screen.
function parentTitleFor(reg, parentSid) {
  try {
    const own = _panels.get(parentSid);
    if (own) return own.instance.title();
    const s = reg.store?.getState?.();
    const bound = reg.getSessionId?.() || '';
    const info = !parentSid || parentSid === bound ? s?.sessionInfo : s?.knownSessions?.get?.(parentSid);
    return String(info?.title || info?.slug || (parentSid || bound).slice(0, 8) || 'parent').trim() || 'parent';
  } catch { return 'parent'; }
}

// The tool profile the user chose for a session (the project bar saves it
// under this key): what a sub-agent of a session that is not on screen inherits.
const MCP_SESSION_PROFILE_KEY = 'synabun-opencode-session-mcp-profiles';
function savedSessionProfile(sessionId) {
  try {
    const parsed = JSON.parse(storage.getItem(MCP_SESSION_PROFILE_KEY) || '{}');
    return (parsed && typeof parsed === 'object' && parsed[sessionId]) || null;
  } catch { return null; }
}

function spawnChildPanel({ childSessionId, childInfo, parentPanelId, parentSessionId, rootSessionId, chain, parentTitle, replay, taskInfo, announce }) {
  const panelId = `ocp-v2-child-${childSessionId.slice(0, 8)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const store = createPanelStore();
  store.setSession(childSessionId, childInfo || null);
  store.setParentSession(parentSessionId, parentPanelId);
  // The parent's profile: the primary store's only while it is bound to that
  // parent (see inheritChildPanelMcpProfile).
  inheritChildPanelMcpProfile(store, _primary?.store, childInfo, { parentSessionId, savedProfile: savedSessionProfile });

  const wsUnsub = subscribeSession(childSessionId, store);

  // Replay must run AFTER subscribe so the part lands in the child store; the
  // store de-dupes by id, so a later WS event for the same part is harmless.
  if (typeof replay === 'function') {
    try { replay(store); } catch (err) {
      console.warn('[ocp-v2-manager] initial child event replay failed', err);
    }
  }

  // Surface a toast so the user gets immediate visual feedback that a
  // sub-agent spawned — the tray pill alone is easy to miss when the user
  // is looking at the panel content. (Not for the pills a reload rebuilds.)
  if (announce) {
    try {
      uiNotify('panel', NOTIF_TYPE.ACTION, `↳ Sub-agent of ${parentTitle}`, {
        panel: 'opencode',
        provider: 'opencode',
      });
    } catch (err) {
      console.warn('[ocp-v2-manager] spawn notification failed', err);
    }
  }

  // When this sub-agent has just become idle, re-poke the parent's plan
  // lifecycle so a PLAN COMPLETE deferred by an in-flight sub-agent finalizes
  // now. Lazy import avoids a static cycle (plan.js → manager.js → plan.js).
  const childRunSub = store.subscribe((event, state) => {
    if (event?.type !== 'running:set' || state.running) return;
    if (!_primary?.store) return;
    // The plan turn this sub-agent was part of is its parent's: when the
    // primary panel is on another session, that session's plan is not poked.
    if (_primary.getSessionId?.() !== parentSessionId) return;
    if (!_primary.store.getState().planTurnActive) return;
    const at = captureBinding(_primary.store);
    // ...and it is that plan turn that is poked, not one begun after it.
    const planTurn = _primary.store.getState().planTurnId;
    import('./ocp-v2-plan.js').then(({ maybeFinalizePlanTurn }) => {
      if (!at.isCurrent()) return;
      maybeFinalizePlanTurn('child:idle', _primary.store, { lenient: true, planTurn }).catch(() => {});
    }).catch(() => {});
  });

  const entry = {
    panelId,
    sessionId: childSessionId,
    parentSessionId,
    rootSessionId,
    chain,
    depth: Math.max(0, chain.length - 1),
    startedAt: Number(childInfo?.time?.created) || Date.now(),
    // Its session was read whole (the panel was shown once); its brief is known.
    hydrated: false,
    hydration: null,
    briefed: !!(taskInfo && (taskInfo.subagentType || taskInfo.summary)),
    store,
    instance: null,
    wsUnsub,
    runSub: childRunSub,
  };
  entry.instance = createChildPanel({
    panelId,
    sessionId: childSessionId,
    store,
    parentPanelId,
    parentSessionId,
    rootSessionId,
    parentTitle,
    depth: entry.depth,
    getChain: () => chain.map((sessionId) => ({ sessionId, title: parentTitleFor(_primary, sessionId) })),
    taskInfo,
    announce,
    // Rebuilt from the server's list, not just started: it ran before.
    started: !announce,
    onUndelivered: (item, detail) => keepUnsent(entry, item, detail),
    takeUnsent: () => _unsent.take(childSessionId),
    onRequestView: (request) => requestOpencodeView(request),
    onVisibility: (visible) => onChildVisibility(entry, visible),
    onOpenAncestor: (sessionId) => openChildSession(_parentOf.get(sessionId) || rootSessionId, sessionId),
    onOpenChild: (grandchildSid) => openChildSession(childSessionId, grandchildSid),
    onStateChange: scheduleTraySync,
    onClose: (id, detail) => onChildClosed(entry, detail),
  });
  _panels.add(entry);
  _unplaced.delete(childSessionId);
  syncSubagentTray();

  // What its pill needs is read now; its transcript when its panel is first
  // shown (showsFirstTime).
  readPillState(entry);
  // Sub-agents of this one that were announced before it could be placed.
  placeWaitingChildren(childSessionId, { announce });
  return entry;
}

// A prompt was on its way to a sub-agent when its panel went away (the user
// closed it, its parent's tab was closed, its session was deleted somewhere
// else), and the send then failed. It is kept for that sub-agent: back in its
// compose box when its panel is opened again, or now, when it already is
// open again. The main panel says so, once.
function keepUnsent(entry, item, { error = '' } = {}) {
  if (!_unsent.keep(entry.sessionId, item)) return;
  let label = '';
  try { label = entry.instance?.title?.() || ''; } catch { label = ''; }
  const { sessionId, parentSessionId } = entry;
  try {
    _primary?.store?.pushError({
      message: unsentSubagentNotice({ item, label, error }),
      notice: true,
      // The way to it, whatever became of its task card. (A notice that
      // offers something goes when that is chosen.)
      actions: [{
        label: 'Open sub-agent',
        run: (err) => { if (openWithUnsent({ sessionId, parentSessionId, label })) _primary?.store?.dismissError?.(err.id); },
      }],
    });
  } catch (err) { console.warn('[ocp-v2-manager] reporting an unsent sub-agent prompt failed', err); }
  const now = _panels.get(entry.sessionId);
  if (now && now !== entry) { try { now.instance?.restoreUnsent?.(); } catch {} }
}

// "Open sub-agent" on that notice: its panel, with the prompt back in its
// compose box. A sub-agent that cannot have a panel any more (its parent is
// no tab of this window now, or an automation owns it) has what was kept for
// it moved to notices of the main panel (Put back / Discard): nothing stays
// where nobody can get at it. False when neither could be done.
function openWithUnsent({ sessionId, parentSessionId, label }) {
  if (openChildSession(parentSessionId, sessionId) || _panels.has(sessionId)) return true;
  const items = _unsent.peek(sessionId);
  if (!items.length) return true;
  if (typeof _primary?.keepPrompts !== 'function') return false;
  try { _primary.keepPrompts(items, label); } catch (err) {
    console.warn('[ocp-v2-manager] keeping an unsent sub-agent prompt failed', err);
    return false;
  }
  _unsent.take(sessionId);
  return true;
}

// The panel is gone (the user closed it, or destroyPanel took it down).
function onChildClosed(entry, { byUser = false, waiting = [], label = '' } = {}) {
  if (_panels.get(entry.sessionId) !== entry) return;
  _panels.remove(entry.sessionId);
  try { entry.wsUnsub?.(); } catch {}
  try { entry.runSub?.(); } catch {}
  // A request that was waiting for the user in this panel still waits in
  // OpenCode: it shows in the nearest parent that has a panel, at once.
  if (entry.handRequestsOver !== false) {
    try { handOverRequests(entry.store, { within: entry.rootSessionId }); } catch (err) { console.warn('[ocp-v2-manager] handing over a closed panel\'s requests failed', err); }
  }
  // Closed by the user: it stays closed. Gone with its session or its parent's
  // tab (`released`): nothing to remember.
  if (byUser && !entry.released) _closed.close(entry.sessionId, entry.rootSessionId);
  // Nobody was asked about what was still unsent in its compose box: kept for the user.
  if (!byUser && waiting.length) {
    try { _primary?.keepPrompts?.(waiting, label); } catch (err) { console.warn('[ocp-v2-manager] keeping a closed sub-agent panel\'s prompts failed', err); }
  }
  requestOpencodeView({ removed: entry.panelId });
}

// Takes a sub-agent panel down because its session, or its parent's, went.
//   lost      nobody closed it by hand: what was waiting in it is kept (onChildClosed)
//   requests  false when the sessions themselves are gone (deleted, or their
//             tab was closed): no request of theirs is handed to a parent
function destroyPanel(entry, { lost = true, requests = true } = {}) {
  if (!entry || _panels.get(entry.sessionId) !== entry) return;
  entry.released = true;
  if (!requests) entry.handRequestsOver = false;
  try { entry.instance?.unmount?.({ byUser: !lost }); } catch (err) { console.warn('[ocp-v2-manager] closing a sub-agent panel failed', err); }
  // (unmount reports through onClose; this is for a panel that threw on the way.)
  if (_panels.get(entry.sessionId) === entry) onChildClosed(entry, { byUser: !lost });
}

// The panel of `sessionId` and every panel below it go, at any depth: the
// session became an automation's (or is one).
function destroyPanelsOf(sessionId) {
  if (!sessionId) return;
  for (const entry of entriesUnder(_panels.all(), sessionId, _parentOf)) destroyPanel(entry, { lost: true });
}

/**
 * The parent session left the main panel for good: its tab was closed or its
 * session is gone. Its sub-agents' panels and pills go with it.
 *   lost   it went by itself (deleted somewhere else, lost by OpenCode): the
 *          user could not be asked, so what was still unsent in those panels
 *          is kept on notices. A tab the user closed was asked about it
 *          (subagentPromptsWaiting is part of that question).
 */
export function releaseSubagentPanels(rootSessionId, { lost = false } = {}) {
  if (!rootSessionId) return;
  for (const entry of _panels.ofRoot(rootSessionId)) destroyPanel(entry, { lost, requests: false });
  _closed.forgetRoot(rootSessionId);
  syncSubagentTray();
}

/** What is still unsent in the sub-agent panels of `rootSessionId` (their queues and drafts). */
export function subagentPromptsWaiting(rootSessionId) {
  const waiting = [];
  for (const entry of _panels.ofRoot(rootSessionId)) {
    try { waiting.push(...(entry.instance?.waiting?.() || [])); } catch { /* a panel that cannot say holds nothing */ }
  }
  return waiting;
}

// ── Which panel is on screen ────────────────────────────────────────────────

function visibleEntry() {
  return _panels.all().find((entry) => entry.instance?.isVisible?.()) || null;
}

// True while requestOpencodeView applies its own decision: a panel that goes
// off screen then was told to, and is not reported as yielded.
let _applying = false;

/**
 * The one way an OpenCode panel goes on or off screen: the main panel, every
 * sub-agent panel, the pills, the breadcrumbs, the task cards and the navbar
 * button ask here, and decideVisibility (ocp-v2-subagents-logic.js) answers.
 * Showing a panel goes through the shared side panel controller, which takes
 * the slot from whatever other provider (Claude, Codex) had it.
 */
export function requestOpencodeView(request) {
  const entries = _panels.all();
  const views = [MAIN_VIEW, ...entries.map((entry) => entry.panelId)];
  const visible = [
    ...(_mainView?.isVisible?.() ? [MAIN_VIEW] : []),
    ...entries.filter((entry) => entry.instance?.isVisible?.()).map((entry) => entry.panelId),
  ];
  const plan = decideVisibility({ views, visible, request });
  const apply = (id, next) => {
    if (id === MAIN_VIEW) { if (_mainView?.owner) setSidepanelVisible(_mainView.owner, next); return; }
    try { _panels.byPanelId(id)?.instance?.applyRequested?.(next); } catch (err) { console.warn('[ocp-v2-manager] sub-agent panel visibility failed', err); }
  };
  const was = _applying;
  _applying = true;
  try {
    for (const id of plan.hide) apply(id, false);
    for (const id of plan.show) apply(id, true);
  } finally { _applying = was; }
  syncSubagentTray();
  noteShown();
  return plan;
}

// The shared controller put a sub-agent panel on or off screen. Off, and not
// by a decision made here: another provider's panel has the slot now.
function onChildVisibility(entry, visible) {
  if (visible) showsFirstTime(entry);
  if (!visible && !_applying && _panels.get(entry.sessionId) === entry) requestOpencodeView({ yielded: entry.panelId });
  else scheduleTraySync();
}

// The session of a sub-agent's panel, read whole (info, transcript, run
// state, requests, todos): once, the first time the panel is on screen. From
// then on the panel follows its session as the main panel does, also across
// a reconnect. Until then the sub-agent costs what its pill needs (readPillState).
function hydrateEntry(entry) {
  if (!entry.hydration) {
    entry.hydrated = true;
    entry.hydration = _hydrations(() => hydrateChildPanel(entry.store, entry.sessionId)).catch((err) => {
      console.warn('[ocp-v2-manager] hydrate child panel failed', err);
      return null;
    });
  }
  return entry.hydration;
}

function showsFirstTime(entry) {
  if (_panels.get(entry.sessionId) !== entry) return;
  hydrateEntry(entry);
  resolveTaskInfo(entry).catch((err) => console.warn('[ocp-v2-manager] looking up a sub-agent\'s brief failed', err));
}

// The brief of a sub-agent is on the task card in its parent's transcript. A
// parent that is a sub-agent itself has its transcript read when its own
// panel is first shown, so the brief of a sub-agent below it may not be known
// when its pill is made: it is looked up when its own panel is shown, after
// the parent's transcript was read for it.
async function resolveTaskInfo(entry) {
  if (entry.briefed) return;
  const lookup = () => lookupParentTaskInfo(entry.sessionId, entry.parentSessionId);
  let info = lookup();
  const parent = _panels.get(entry.parentSessionId);
  if (!info && parent) {
    await hydrateEntry(parent);
    info = lookup();
  }
  // (The panel may have been closed, or told its brief by an event, meanwhile.)
  if (!info || entry.briefed || _panels.get(entry.sessionId) !== entry) return;
  entry.briefed = true;
  try { entry.instance?.setTaskInfo?.(info); } catch {}
}

// Remembers the sub-agent panel that is on screen, for the reload.
function noteShown() {
  const entry = visibleEntry();
  _shown.note(entry ? { rootSessionId: entry.rootSessionId, sessionId: entry.sessionId } : null);
}

// ── The tray ────────────────────────────────────────────────────────────────

let _groupEl = null;                // the pills of the session the main panel is on
let _summaryEl = null;
let _traySyncQueued = false;
let _groupLayoutKey = '';           // what the group's height was last measured for
let _groupHeight;                   // the height the group may take (trayGroupHeight), once measured

// Store events come in bursts (every streamed token): one tray pass per tick.
function scheduleTraySync() {
  if (_traySyncQueued) return;
  _traySyncQueued = true;
  setTimeout(() => { _traySyncQueued = false; syncSubagentTray(); }, 0);
}

function tabPillOf(tray, sessionId) {
  for (const node of tray.children || []) {
    if (node?.dataset?.sessionId !== sessionId) continue;
    if (String(node.dataset.owner || '').startsWith('ocp-v2-child-')) continue;
    if (node.classList?.contains('ocpv2-session-pill')) return node;
  }
  return null;
}

/**
 * Brings the tray in line with the sub-agent panels: the pills of the session
 * the main panel is on, in the order the sub-agents were started, in one
 * bounded group under that session's pill; a count once the group scrolls; and
 * on every parent session's pill whether its sub-agents run or wait. The pills
 * of other sessions' sub-agents are kept out of the tray, as they are.
 */
export function syncSubagentTray() {
  const tray = typeof document !== 'undefined' ? document.getElementById('term-minimized-tray') : null;
  if (!tray) return;
  const shownRoot = _primary?.getSessionId?.() || '';
  const entries = _panels.all();
  const byId = new Map(entries.map((entry) => [entry.sessionId, entry]));
  const plan = trayPills({
    entries,
    shownRoot,
    visiblePanelId: visibleEntry()?.panelId || '',
    stateOf: (entry) => entry.instance?.pillState?.() || { state: 'idle' },
  });

  if (!_groupEl) {
    _groupEl = document.createElement('div');
    _groupEl.classList.add('ocpv2-subagent-pills');
    _summaryEl = document.createElement('div');
    _summaryEl.classList.add('ocpv2-subagent-summary');
    _summaryEl.hidden = true;
    _groupEl.appendChild(_summaryEl);
  }

  // The pills of this session, in order; every other pill leaves the group.
  const wanted = plan.pills.map((pill) => byId.get(pill.sessionId)?.instance?.pill).filter(Boolean);
  for (const node of [...(_groupEl.children || [])]) {
    if (node !== _summaryEl && !wanted.includes(node)) node.remove();
  }
  wanted.forEach((pill, index) => {
    if (_groupEl.children[index + 1] !== pill) _groupEl.insertBefore(pill, _groupEl.children[index + 1] || null);
  });

  if (_summaryEl.textContent !== plan.summary.text) _summaryEl.textContent = plan.summary.text;
  _summaryEl.classList.toggle('ocpv2-summary-waiting', plan.summary.waiting > 0);

  // The group sits right under its parent session's pill (or stands alone
  // while that pill is hidden because the main panel is on screen).
  const parentPill = shownRoot ? tabPillOf(tray, shownRoot) : null;
  if (!wanted.length) {
    if (_groupEl.parentNode) _groupEl.remove();
  } else if (parentPill) {
    if (parentPill.nextSibling !== _groupEl) tray.insertBefore(_groupEl, parentPill.nextSibling);
  } else if (_groupEl.parentNode !== tray) {
    tray.appendChild(_groupEl);
  }
  const docked = !!wanted.length && !!parentPill && parentPill.style?.display !== 'none';
  _groupEl.classList.toggle('ocpv2-pills-docked', docked);
  // The tray ends inside the window: the group takes the room the other pills
  // leave (trayGroupHeight), however little that is, and scrolls inside it.
  // Measured when the pills or their place changed, not on every state change
  // of a sub-agent.
  const layoutKey = `${wanted.length}|${shownRoot}|${docked}|${tray.children.length}`;
  if (wanted.length && layoutKey !== _groupLayoutKey) {
    _groupLayoutKey = layoutKey;
    try {
      const trayBox = tray.getBoundingClientRect();
      _groupHeight = trayGroupHeight({ trayTop: trayBox.top, othersHeight: trayBox.height - _groupEl.getBoundingClientRect().height, viewportHeight: window.innerHeight });
      _groupEl.style.maxHeight = `${_groupHeight}px`;
    } catch { /* the stylesheet's bound holds */ }
  }
  // More pills than the group shows at once (its rows, or the room it got):
  // it scrolls, and the count line says how many there are and how many wait.
  const scrolls = plan.scrolls || trayGroupScrolls({ count: wanted.length, height: _groupHeight });
  _summaryEl.hidden = !scrolls;
  wanted.forEach((pill, index) => pill.classList.toggle('ocpv2-pill-docked', docked && index === 0 && !scrolls));

  // What each parent session's own pill says about its sub-agents.
  for (const node of tray.children || []) {
    const sessionId = node?.dataset?.sessionId;
    if (!sessionId || node === _groupEl || String(node.dataset.owner || '').startsWith('ocp-v2-child-')) continue;
    if (!node.classList?.contains('ocpv2-session-pill')) continue;
    const flags = plan.parents.get(sessionId) || { hasChild: false, running: false, waiting: false };
    node.classList.toggle('ocpv2-pill-has-child', flags.hasChild);
    node.classList.toggle('ocpv2-pill-child-running', flags.running && !flags.waiting);
    node.classList.toggle('ocpv2-pill-child-waiting', flags.waiting);
    node.classList.toggle('ocpv2-pill-parent-docked', docked && sessionId === shownRoot && !scrolls);
  }

  // A sub-agent that waits for an answer is brought into view inside the group.
  const waitingPill = plan.firstWaiting ? byId.get(plan.firstWaiting)?.instance?.pill : null;
  if (waitingPill && waitingPill !== _lastWaitingPill && scrolls) {
    try {
      const top = waitingPill.offsetTop - (_summaryEl.offsetHeight || 0) - 4;
      if (top < _groupEl.scrollTop || top + waitingPill.offsetHeight > _groupEl.scrollTop + _groupEl.clientHeight) _groupEl.scrollTop = Math.max(0, top);
    } catch { /* no layout */ }
  }
  _lastWaitingPill = waitingPill || null;
}
let _lastWaitingPill = null;

// What a pill needs of its session: is it running, and which requests wait
// for the user (the events before the pill was made reached no store). Read
// when the pill is made and again after the socket came back. Not its
// transcript, its session info or its todos: those are the panel's, read
// when it is first shown.
const PILL_API = {
  sessionStatus: (args) => api.sessionStatus(args),
  permissionList: (args) => api.permissionList(args),
  questionList: (args) => api.questionList(args),
};

// The directory a sub-agent's session runs in: its own, else its parent session's.
function directoryOf(entry) {
  const s = entry.store.getState();
  if (s.cwd || s.sessionInfo?.directory) return s.cwd || s.sessionInfo.directory;
  const main = _primary?.store?.getState?.();
  if (!main) return undefined;
  if (_primary.getSessionId?.() === entry.rootSessionId) return main.cwd || main.sessionInfo?.directory || undefined;
  return main.knownSessions?.get?.(entry.rootSessionId)?.directory || undefined;
}

function pillRead(entry) {
  return rehydrateSessionState(entry.store, PILL_API, {
    sessionId: entry.sessionId,
    cwd: directoryOf(entry),
    hasPanel: hasSessionStore,
    isDescendant: isDescendantSession,
    isCurrent: () => _panels.get(entry.sessionId)?.store === entry.store,
  });
}

function readPillState(entry) {
  return _hydrations(() => {
    // Closed meanwhile, or shown: then the panel's own read covers it.
    if (_panels.get(entry.sessionId) !== entry || entry.hydrated) return null;
    return pillRead(entry);
  }).catch((err) => {
    console.warn('[ocp-v2-manager] reading what a sub-agent\'s pill needs failed', err);
    return null;
  });
}

// Session info, transcript, run state and the sub-agent's own pending approvals,
// read from the server (for a panel that was never shown: what its pill
// needs, see above). Runs when the panel is first shown and again after
// the socket came back: a permission request or the end of the turn that
// happened during the outage reached no panel. Answers that arrive after the
// panel was closed are dropped (`isCurrent`).
function hydrateChildPanel(store, sessionId, { refreshInfo = true } = {}) {
  const entry = _panels.get(sessionId);
  if (entry && entry.store === store && !entry.hydrated) {
    return pillRead(entry).then((live) => ({ info: false, transcript: false, pill: true, live, moved: false, unavailable: false, error: '' }));
  }
  return rehydratePanelSession(store, api, {
    sessionId,
    refreshInfo,
    hasPanel: hasSessionStore,
    isDescendant: isDescendantSession,
    isCurrent: () => _panels.get(sessionId)?.store === store,
  });
}

// A task card's "Open sub-agent", or a crumb: show the child session's panel,
// making it when it has none (also one the user had closed). Returns true when
// a panel was shown.
export function openChildSession(parentSessionId, childSessionId) {
  if (!parentSessionId || !childSessionId) return false;
  const entry = ensureChildSpawn(parentSessionId, childSessionId, null, null, lookupParentTaskInfo(childSessionId, parentSessionId), { announce: false, reopen: true, inferred: true });
  if (!entry) return false;
  requestOpencodeView({ show: entry.panelId });
  return !!entry.instance?.isVisible?.();
}

/** Every sub-agent panel, in the order the sub-agents were started. */
export function getChildPanels() {
  return _panels.all().map((entry) => ({
    panelId: entry.panelId,
    sessionId: entry.sessionId,
    parentSessionId: entry.parentSessionId,
    rootSessionId: entry.rootSessionId,
    visible: !!entry.instance?.isVisible?.(),
  }));
}

/** The panel of one sub-agent session, or null. */
export function getChildPanel(sessionId) {
  return _panels.get(sessionId)?.instance || null;
}

// True when a sub-agent of `parentSessionId` (the session in the main panel)
// is still running. Used by the plan lifecycle to defer PLAN COMPLETE
// finalization until the sub-agents have reported back.
export function hasRunningChildForParent(parentSessionId) {
  if (!parentSessionId) return false;
  if (!_primary || _primary.getSessionId?.() !== parentSessionId) return false;
  return _panels.ofRoot(parentSessionId).some((entry) => {
    try { return !!entry.store?.getState?.().running; } catch { return false; }
  });
}

export function isChildPanelOpen() {
  return !!visibleEntry();
}

export function getVisibleChildPanel() {
  return visibleEntry()?.instance || null;
}

export function destroyChildPanelById(panelId) {
  const entry = _panels.byPanelId(panelId);
  if (entry) destroyPanel(entry, { lost: true });
}
