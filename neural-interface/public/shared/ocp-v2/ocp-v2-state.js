// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — Panel State (multi-instance)
// Each OCP v2 panel owns its own store created via createPanelStore(). The
// module also exports a default singleton (and the legacy named setters that
// proxy to it) so any caller not yet migrated keeps working unchanged.
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_IMAGES = 5;

function createDefaultContextGauge(status = 'pending') {
  return {
    status,
    usedTokens: 0,
    contextWindow: null,
    percent: 0,
    model: null,
    providerID: null,
    basis: 'unknown',
    breakdown: null,
    messageId: '',
    updatedAt: 0,
    error: '',
  };
}

export function createPanelStore() {
  const _state = {
    attachedImages: [],
    pendingPaths: [],
    serverStatus: 'unknown',
    serverPort: null,
    serverVersion: null,
    managed: false,
    healing: false,

    sessionId: null,
    sessionInfo: null,
    parentSessionId: null,        // set on child panels (sub-agent sessions)
    parentPanelId: null,          // set on child panels — used by manager

    messageOrder: [],
    messages: new Map(),
    knownSessions: new Map(),

    running: false,
    pendingPermission: null,
    pendingQuestions: [],
    errors: [],

    mode: 'build',
    agent: 'build',
    model: null,
    variant: null,
    cwd: null,
    contextGauge: createDefaultContextGauge(),

    planTurnActive: false,
    planTurnSessionId: null,
    planTurnStartedAt: 0,
    planTurnStartMessageCount: 0,
    planContent: '',
    editedPlanContent: '',
    planFilePath: '',
    showPostPlanActions: false,
    postPlanHeader: 'PLAN COMPLETE',
    planMaterializing: false,
  };

  const _listeners = new Set();

  function getState() { return _state; }

  function subscribe(listener) {
    _listeners.add(listener);
    return () => _listeners.delete(listener);
  }

  function notify(event) {
    for (const fn of _listeners) {
      try { fn(event, _state); } catch (e) { console.warn('[ocp-v2-state] listener error', e); }
    }
  }

  function setServerStatus({ status, port, version, managed }) {
    if (status !== undefined) _state.serverStatus = status;
    if (port !== undefined) _state.serverPort = port;
    if (version !== undefined) _state.serverVersion = version;
    if (managed !== undefined) _state.managed = managed;
    notify({ type: 'server:status' });
  }

  function setSession(sessionId, info = null) {
    const prevSessionId = _state.sessionId;
    _state.sessionId = sessionId;
    _state.sessionInfo = info;
    if (info && sessionId) _state.knownSessions.set(sessionId, info);
    if (prevSessionId !== sessionId) {
      if (_state.running) setRunning(false);
      _state.contextGauge = createDefaultContextGauge(sessionId ? 'pending' : 'idle');
    }
    notify({ type: 'session:set', sessionId });
  }

  function setParentSession(parentSessionId, parentPanelId = null) {
    _state.parentSessionId = parentSessionId || null;
    _state.parentPanelId = parentPanelId || null;
    notify({ type: 'session:parent', parentSessionId });
  }

  function clearMessages() {
    _state.messageOrder = [];
    _state.messages.clear();
    _state.errors = [];
    _state.pendingPermission = null;
    _state.pendingQuestions = [];
    _state.contextGauge = createDefaultContextGauge(_state.sessionId ? 'pending' : 'idle');
    clearPlanState({ preserveMode: true, notifyChange: false });
    notify({ type: 'messages:clear' });
  }

  function upsertMessage(msgInfo) {
    if (!msgInfo || !msgInfo.id) return;
    const existing = _state.messages.get(msgInfo.id);
    if (existing) {
      existing.info = msgInfo;
      existing.role = msgInfo.role || existing.role;
    } else {
      _state.messages.set(msgInfo.id, {
        id: msgInfo.id,
        role: msgInfo.role || 'assistant',
        info: msgInfo,
        parts: new Map(),
      });
      _state.messageOrder.push(msgInfo.id);
    }
    notify({ type: 'message:upsert', messageId: msgInfo.id });
  }

  function removeMessage(messageId) {
    if (!_state.messages.has(messageId)) return;
    _state.messages.delete(messageId);
    _state.messageOrder = _state.messageOrder.filter((id) => id !== messageId);
    notify({ type: 'message:remove', messageId });
  }

  function upsertPart(part) {
    if (!part) return;
    const messageId = part.messageID || part.messageId;
    const partId = part.id || part.partID || part.partId;
    if (!messageId || !partId) return;

    if (!_state.messages.has(messageId)) {
      upsertMessage({ id: messageId, role: 'assistant' });
    }
    const msg = _state.messages.get(messageId);
    msg.parts.set(partId, { ...part, id: partId, messageID: messageId });
    notify({ type: 'part:upsert', messageId, partId });
  }

  function setRunning(running) {
    _state.running = !!running;
    notify({ type: 'running:set' });
  }

  function setPendingPermission(permission) {
    _state.pendingPermission = permission;
    notify({ type: 'permission:set' });
  }

  function setPendingQuestions(questions) {
    _state.pendingQuestions = Array.isArray(questions) ? questions : [];
    notify({ type: 'questions:set' });
  }

  function addPendingQuestion(req) {
    if (!req || !req.id) return;
    const id = String(req.id || '');
    const idx = _state.pendingQuestions.findIndex((q) => String(q?.id || '') === id);
    if (idx >= 0) _state.pendingQuestions[idx] = req;
    else _state.pendingQuestions = [..._state.pendingQuestions, req];
    notify({ type: 'questions:set' });
  }

  function removePendingQuestion(requestId) {
    const id = String(requestId || '');
    _state.pendingQuestions = _state.pendingQuestions.filter((q) => String(q?.id || '') !== id);
    notify({ type: 'questions:set' });
  }

  function pushError(err) {
    _state.errors.push({ at: Date.now(), ...err });
    if (_state.errors.length > 20) _state.errors.shift();
    notify({ type: 'error:push' });
  }

  function clearErrors() {
    if (!_state.errors.length) return;
    _state.errors = [];
    notify({ type: 'errors:clear' });
  }

  function setHealing(healing) {
    const next = !!healing;
    if (_state.healing === next) return;
    _state.healing = next;
    notify({ type: 'healing:set' });
  }

  function setKnownSessions(list) {
    _state.knownSessions.clear();
    for (const s of list || []) {
      if (s?.id) _state.knownSessions.set(s.id, s);
    }
    notify({ type: 'sessions:list' });
  }

  function setMode(mode) {
    const next = normalizeMode(mode);
    _state.mode = next;
    _state.agent = agentForMode(next);
    if (next === 'build') {
      _state.planTurnActive = false;
    }
    notify({ type: 'config:mode', mode: next });
  }

  function beginPlanTurn({ sessionId = _state.sessionId, startMessageCount = _state.messageOrder.length } = {}) {
    _state.planTurnActive = true;
    _state.planTurnSessionId = sessionId || null;
    _state.planTurnStartedAt = Date.now();
    _state.planTurnStartMessageCount = startMessageCount;
    _state.planContent = '';
    _state.editedPlanContent = '';
    _state.planFilePath = '';
    _state.showPostPlanActions = false;
    _state.postPlanHeader = 'PLAN COMPLETE';
    notify({ type: 'plan:turn:start' });
  }

  function completePlanTurn({ content = '', filePath = '', header = 'PLAN COMPLETE' } = {}) {
    _state.planTurnActive = false;
    if (content) {
      _state.planContent = content;
      _state.editedPlanContent = '';
    }
    if (filePath) _state.planFilePath = filePath;
    _state.postPlanHeader = header || 'PLAN COMPLETE';
    _state.showPostPlanActions = !!(_state.planContent || _state.editedPlanContent);
    notify({ type: 'plan:turn:complete' });
  }

  function setPlanContent(content, { edited = false, filePath, header, showActions } = {}) {
    const text = String(content || '').trim();
    if (edited) _state.editedPlanContent = text;
    else _state.planContent = text;
    if (filePath !== undefined) _state.planFilePath = filePath || '';
    if (header) _state.postPlanHeader = header;
    if (showActions !== undefined) _state.showPostPlanActions = !!showActions;
    notify({ type: 'plan:content:set' });
  }

  function setPostPlanActions(show, header = null) {
    _state.showPostPlanActions = !!show;
    if (header) _state.postPlanHeader = header;
    notify({ type: 'plan:actions:set' });
  }

  function setPlanMaterializing(value) {
    _state.planMaterializing = !!value;
    notify({ type: 'plan:materializing:set' });
  }

  function clearPlanState({ preserveMode = true, notifyChange = true } = {}) {
    _state.planTurnActive = false;
    _state.planTurnSessionId = null;
    _state.planTurnStartedAt = 0;
    _state.planTurnStartMessageCount = 0;
    _state.planContent = '';
    _state.editedPlanContent = '';
    _state.planFilePath = '';
    _state.showPostPlanActions = false;
    _state.postPlanHeader = 'PLAN COMPLETE';
    _state.planMaterializing = false;
    if (!preserveMode) {
      _state.mode = 'build';
      _state.agent = 'build';
    }
    if (notifyChange) notify({ type: 'plan:clear' });
  }

  function setAgent(agent)     { _state.agent = agent || agentForMode(_state.mode); notify({ type: 'config:agent' }); }
  function setModel(model)     { _state.model = model;     notify({ type: 'config:model' }); }
  function setVariant(variant) { _state.variant = variant; notify({ type: 'config:variant' }); }
  function setCwd(cwd)         { _state.cwd = cwd;         notify({ type: 'config:cwd' }); }

  function setContextGauge(value = {}) {
    _state.contextGauge = { ...(_state.contextGauge || createDefaultContextGauge()), ...value };
    notify({ type: 'context:gauge' });
  }

  function resetContextGauge(status = _state.sessionId ? 'pending' : 'idle') {
    _state.contextGauge = createDefaultContextGauge(status);
    notify({ type: 'context:gauge' });
  }

  function addAttachedImage(img) {
    if (!img || !img.dataUrl) return false;
    if (_state.attachedImages.length >= MAX_IMAGES) return false;
    _state.attachedImages.push({
      name: img.name || `image-${Date.now()}.png`,
      mime: img.mime || 'image/png',
      dataUrl: img.dataUrl,
    });
    notify({ type: 'attachments:set' });
    return true;
  }

  function removeAttachedImage(idx) {
    if (idx < 0 || idx >= _state.attachedImages.length) return;
    _state.attachedImages.splice(idx, 1);
    notify({ type: 'attachments:set' });
  }

  function clearAttachedImages() {
    if (!_state.attachedImages.length) return;
    _state.attachedImages = [];
    notify({ type: 'attachments:set' });
  }

  function addPendingPath(path) {
    const norm = String(path || '').trim();
    if (!norm || _state.pendingPaths.includes(norm)) return false;
    _state.pendingPaths.push(norm);
    notify({ type: 'paths:set' });
    return true;
  }

  function removePendingPath(idx) {
    if (idx < 0 || idx >= _state.pendingPaths.length) return;
    _state.pendingPaths.splice(idx, 1);
    notify({ type: 'paths:set' });
  }

  function clearPendingPaths() {
    if (!_state.pendingPaths.length) return;
    _state.pendingPaths = [];
    notify({ type: 'paths:set' });
  }

  return {
    getState, subscribe,
    setServerStatus, setSession, setParentSession,
    clearMessages, upsertMessage, removeMessage, upsertPart,
    setRunning, setPendingPermission, setPendingQuestions,
    addPendingQuestion, removePendingQuestion,
    pushError, clearErrors, setHealing, setKnownSessions,
    setMode, setAgent, setModel, setVariant, setCwd,
    setContextGauge, resetContextGauge,
    beginPlanTurn, completePlanTurn, setPlanContent,
    setPostPlanActions, setPlanMaterializing, clearPlanState,
    addAttachedImage, removeAttachedImage, clearAttachedImages,
    addPendingPath, removePendingPath, clearPendingPaths,
  };
}

// ── Mode helpers (pure, no state) ──────────────────────────────────────────
export function normalizeMode(mode) {
  return mode === 'plan' ? 'plan' : 'build';
}

export function agentForMode(mode) {
  return normalizeMode(mode) === 'plan' ? 'plan' : 'build';
}

// ── Default singleton + legacy named exports ───────────────────────────────
// The default store is the primary panel's store. The manager binds the
// primary panel to this so legacy callers (toggleOpencodePanel, etc.) keep
// working without refactor.
const _defaultStore = createPanelStore();
export function getDefaultStore() { return _defaultStore; }

export const getState                = (...a) => _defaultStore.getState(...a);
export const subscribe               = (...a) => _defaultStore.subscribe(...a);
export const setServerStatus         = (...a) => _defaultStore.setServerStatus(...a);
export const setSession              = (...a) => _defaultStore.setSession(...a);
export const setParentSession        = (...a) => _defaultStore.setParentSession(...a);
export const clearMessages           = (...a) => _defaultStore.clearMessages(...a);
export const upsertMessage           = (...a) => _defaultStore.upsertMessage(...a);
export const removeMessage           = (...a) => _defaultStore.removeMessage(...a);
export const upsertPart              = (...a) => _defaultStore.upsertPart(...a);
export const setRunning              = (...a) => _defaultStore.setRunning(...a);
export const setPendingPermission    = (...a) => _defaultStore.setPendingPermission(...a);
export const setPendingQuestions     = (...a) => _defaultStore.setPendingQuestions(...a);
export const addPendingQuestion      = (...a) => _defaultStore.addPendingQuestion(...a);
export const removePendingQuestion   = (...a) => _defaultStore.removePendingQuestion(...a);
export const pushError               = (...a) => _defaultStore.pushError(...a);
export const clearErrors             = (...a) => _defaultStore.clearErrors(...a);
export const setHealing              = (...a) => _defaultStore.setHealing(...a);
export const setKnownSessions        = (...a) => _defaultStore.setKnownSessions(...a);
export const setMode                 = (...a) => _defaultStore.setMode(...a);
export const setAgent                = (...a) => _defaultStore.setAgent(...a);
export const setModel                = (...a) => _defaultStore.setModel(...a);
export const setVariant              = (...a) => _defaultStore.setVariant(...a);
export const setCwd                  = (...a) => _defaultStore.setCwd(...a);
export const setContextGauge         = (...a) => _defaultStore.setContextGauge(...a);
export const resetContextGauge       = (...a) => _defaultStore.resetContextGauge(...a);
export const beginPlanTurn           = (...a) => _defaultStore.beginPlanTurn(...a);
export const completePlanTurn        = (...a) => _defaultStore.completePlanTurn(...a);
export const setPlanContent          = (...a) => _defaultStore.setPlanContent(...a);
export const setPostPlanActions      = (...a) => _defaultStore.setPostPlanActions(...a);
export const setPlanMaterializing    = (...a) => _defaultStore.setPlanMaterializing(...a);
export const clearPlanState          = (...a) => _defaultStore.clearPlanState(...a);
export const addAttachedImage        = (...a) => _defaultStore.addAttachedImage(...a);
export const removeAttachedImage     = (...a) => _defaultStore.removeAttachedImage(...a);
export const clearAttachedImages     = (...a) => _defaultStore.clearAttachedImages(...a);
export const addPendingPath          = (...a) => _defaultStore.addPendingPath(...a);
export const removePendingPath       = (...a) => _defaultStore.removePendingPath(...a);
export const clearPendingPaths       = (...a) => _defaultStore.clearPendingPaths(...a);
