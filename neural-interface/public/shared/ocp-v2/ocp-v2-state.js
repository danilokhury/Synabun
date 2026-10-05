// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — Panel State (multi-instance)
// Each OCP v2 panel owns its own store created via createPanelStore(). The
// module also exports a default singleton (and the legacy named setters that
// proxy to it) so any caller not yet migrated keeps working unchanged.
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_IMAGES = 5;
// Images, PDFs and text files attached to one prompt (the strip above the input).
export const MAX_ATTACHED = 10;
export const ERRORS_MAX = 20;          // error banners kept (notices are not counted)

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

// Fields of a part that grow by message.part.delta.
const STREAMED_FIELDS = ['text'];

// True when `incoming` (from a part update) would take back text `live` already
// shows: it is absent, empty, or a shorter prefix of it.
function keepsStreamedText(live, incoming) {
  if (typeof live !== 'string' || !live) return false;
  if (typeof incoming !== 'string') return true;
  return live.length > incoming.length && live.startsWith(incoming);
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
    // The card /help shows at the end of the transcript (helpCardView in
    // ocp-v2-composer-logic.js). Local: it is not a message, nothing of it is
    // sent, and it goes when the panel is bound to another session.
    helpCard: null,

    running: false,
    // OpenCode's own run state for this session (session.status): idle, busy,
    // or retry { attempt, message, next, action? }.
    sessionStatus: { type: 'idle' },
    compacting: false,
    // Every permission request still waiting for an answer, oldest first.
    // `pendingPermission` is the head of that queue (kept for older readers).
    pendingPermissions: [],
    pendingPermission: null,
    // Answer permission requests "once" without asking. Per session, off by
    // default, never persisted: it resets whenever the bound session changes.
    autoAccept: false,
    pendingQuestions: [],
    errors: [],
    // The model's todo list for this session (session.todo / todo.updated).
    todos: [],
    // What the session changed on disk (session.diff): SnapshotFileDiff[].
    sessionDiff: [],

    mode: 'build',
    agent: 'build',
    model: null,
    variant: null,
    cwd: null,
    mcpProfile: null,
    contextGauge: createDefaultContextGauge(),

    planTurnActive: false,
    planTurnSessionId: null,
    // The identity of the plan turn the fields below belong to: a new number
    // for every plan turn, 0 when there is none (see beginPlanTurn).
    planTurnId: 0,
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
  let _errorSeq = 0;

  // One counter per slice of state that is also re-read from the server after
  // a reload or a reconnect (ocp-v2-rehydrate.js). Every local change bumps
  // its slice, so a snapshot that was requested before a live event arrived
  // can be told apart from one that is newer than everything the store holds.
  // `binding` counts how often the store moved to another session: an answer
  // that was asked for under an older binding belongs to a session the panel
  // has left (or left and came back to) and is dropped by whoever asked.
  const _rev = { status: 0, permissions: 0, questions: 0, todos: 0, binding: 0 };
  function getRevisions() { return { ..._rev }; }
  // The binding identity on its own: it changes every time the store is bound
  // to another session (a new one, a switch, a project change, no session),
  // also when it comes back to one it was on before. ocp-v2-binding.js builds
  // the guard every asynchronous flow uses on it.
  function getBinding() { return _rev.binding; }

  // The turn a composer started (a prompt, a slash command, a shell command).
  // The binding says which session the store is on; this says which of that
  // session's turns `running` belongs to. A turn's late continuation (its
  // reply, its failure, a Stop pressed during it) ends the turn only while no
  // newer one was begun: see beginTurn / endTurn in ocp-v2-send-logic.js. Run
  // state that arrives as an event (session.status) begins no turn.
  let _turn = 0;
  let _planTurnSeq = 0;
  function getTurn() { return _turn; }
  function beginTurn() {
    _turn += 1;
    const id = _turn;
    setRunning(true);
    return id;
  }

  // Live news about the run state that changes no flag (a delta while the
  // store already says running): a snapshot read before it is still older.
  function touchStatus() { _rev.status += 1; }

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

  // What session info passes through before the store keeps it. The panel
  // takes out a share link whose sharing it stopped (createStoppedShares in
  // ocp-v2-sessions-logic.js): OpenCode goes on reporting it.
  let _sessionInfoFilter = null;
  function setSessionInfoFilter(filter) {
    _sessionInfoFilter = typeof filter === 'function' ? filter : null;
  }
  const filteredInfo = (info) => {
    if (!info || !_sessionInfoFilter) return info;
    try { return _sessionInfoFilter(info) || info; } catch { return info; }
  };

  function setSession(sessionId, rawInfo = null) {
    const info = filteredInfo(rawInfo);
    const prevSessionId = _state.sessionId;
    _state.sessionId = sessionId;
    _state.sessionInfo = info;
    if (info && sessionId) _state.knownSessions.set(sessionId, info);
    if (prevSessionId === sessionId) {
      notify({ type: 'session:set', sessionId });
      return;
    }
    _state.helpCard = null;
    // A rebinding is one step: everything that belonged to the session being
    // left is gone before any listener runs, so nobody sees the new session
    // with the old one's run state or requests.
    _rev.binding += 1;
    _rev.status += 1; _rev.todos += 1; _rev.permissions += 1; _rev.questions += 1;
    const wasRunning = _state.running;
    _state.running = false;
    _state.sessionStatus = { type: 'idle' };
    _state.compacting = false;
    _state.autoAccept = false;
    _state.todos = [];
    _state.sessionDiff = [];
    _state.contextGauge = createDefaultContextGauge(sessionId ? 'pending' : 'idle');
    // A request waiting for an answer belongs to the session it was raised
    // in. One that arrived while the next session was still being created
    // must not be on screen, or answerable, in that next session.
    const hadPermissions = _state.pendingPermissions.length > 0;
    const hadQuestions = _state.pendingQuestions.length > 0;
    _state.pendingPermissions = [];
    _state.pendingPermission = null;
    _state.pendingQuestions = [];
    if (wasRunning) notify({ type: 'running:set' });
    if (hadPermissions) notify({ type: 'permission:set' });
    if (hadQuestions) notify({ type: 'questions:set' });
    notify({ type: 'session:set', sessionId });
  }

  // Fresh metadata for the bound session (session.updated). Unlike setSession
  // this never touches the transcript or the run state.
  function setSessionInfo(info) {
    if (!info || !_state.sessionId) return;
    const id = info.id || info.sessionID;
    if (id && id !== _state.sessionId) return;
    _state.sessionInfo = filteredInfo({ ...(_state.sessionInfo || {}), ...info });
    _state.knownSessions.set(_state.sessionId, _state.sessionInfo);
    const compacting = !!info.time?.compacting;
    if (compacting !== _state.compacting) {
      _state.compacting = compacting;
      notify({ type: 'compacting:set' });
    }
    notify({ type: 'session:info', sessionId: _state.sessionId });
  }

  function setParentSession(parentSessionId, parentPanelId = null) {
    _state.parentSessionId = parentSessionId || null;
    _state.parentPanelId = parentPanelId || null;
    notify({ type: 'session:parent', parentSessionId });
  }

  function clearMessages() {
    _rev.status += 1; _rev.permissions += 1; _rev.questions += 1; _rev.todos += 1;
    _state.messageOrder = [];
    _state.messages.clear();
    // A notice (`notice: true`: something of the user's was dropped) is about
    // the panel, not about the transcript being cleared: it stays until it is
    // dismissed.
    _state.errors = _state.errors.filter((err) => err?.notice);
    _state.pendingPermissions = [];
    _state.pendingPermission = null;
    _state.pendingQuestions = [];
    _state.sessionStatus = { type: 'idle' };
    _state.compacting = false;
    _state.todos = [];
    _state.sessionDiff = [];
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
    const next = { ...part, id: partId, messageID: messageId };
    // message.part.updated carries the part as OpenCode had it when the event
    // was made; deltas that arrived since (or before it, when the delta outran
    // the announcement) are already in the store. While the part is unfinished
    // such an update never takes streamed text back.
    const live = msg.parts.get(partId);
    if (live && !part.time?.end) {
      for (const field of STREAMED_FIELDS) {
        if (keepsStreamedText(live[field], part[field])) next[field] = live[field];
      }
    }
    msg.parts.set(partId, next);
    notify({ type: 'part:upsert', messageId, partId });
  }

  // One streamed chunk (message.part.delta): append `delta` to `field` of the
  // part. A delta can outrun the message.part.updated that announces its part,
  // so a missing message or part gets a stub the later update fills in.
  function appendPartDelta({ messageID, partID, field = 'text', delta } = {}) {
    if (!messageID || !partID || typeof delta !== 'string' || !delta) return;
    const key = typeof field === 'string' && field ? field : 'text';
    if (!_state.messages.has(messageID)) upsertMessage({ id: messageID, role: 'assistant' });
    const msg = _state.messages.get(messageID);
    const existing = msg.parts.get(partID);
    const base = existing || { id: partID, messageID, type: key === 'text' ? 'text' : key };
    const current = typeof base[key] === 'string' ? base[key] : '';
    msg.parts.set(partID, { ...base, [key]: current + delta });
    notify({ type: 'part:delta', messageId: messageID, partId: partID });
  }

  function removePart(messageID, partID) {
    const msg = _state.messages.get(messageID);
    if (!msg || !msg.parts.delete(partID)) return;
    notify({ type: 'part:remove', messageId: messageID, partId: partID });
  }

  // Apply a transcript snapshot (session.messages). The snapshot was read a
  // moment ago while deltas kept arriving, so a text or reasoning part that is
  // still streaming never shrinks back to an older prefix of what is shown.
  function hydrateMessages(items) {
    for (const item of Array.isArray(items) ? items : []) {
      const info = item?.info;
      if (!info?.id) continue;
      // A message that names another session is not this store's: a snapshot
      // that was read for the session the panel has left never enters here.
      const owner = info.sessionID || info.sessionId;
      if (owner && _state.sessionId && owner !== _state.sessionId) continue;
      upsertMessage(info);
      for (const part of (item.parts || [])) {
        const partId = part?.id || part?.partID || part?.partId;
        const live = partId ? _state.messages.get(info.id)?.parts.get(partId) : null;
        if (
          live && typeof live.text === 'string' && typeof part.text === 'string'
          && !part.time?.end && live.text.length > part.text.length && live.text.startsWith(part.text)
        ) continue;
        upsertPart(part);
      }
    }
  }

  function setRunning(running) {
    _rev.status += 1;
    _state.running = !!running;
    notify({ type: 'running:set' });
  }

  function setSessionStatus(status) {
    const next = status && typeof status.type === 'string' ? status : { type: 'idle' };
    _rev.status += 1;
    _state.sessionStatus = next;
    notify({ type: 'status:set' });
  }

  function setCompacting(value) {
    const next = !!value;
    if (_state.compacting === next) return;
    _state.compacting = next;
    notify({ type: 'compacting:set' });
  }

  const permissionIdOf = (req) => String(req?.id || req?.requestID || req?.permissionID || '');

  function addPendingPermission(req) {
    const id = permissionIdOf(req);
    if (!id) return false;
    _rev.permissions += 1;
    const idx = _state.pendingPermissions.findIndex((p) => permissionIdOf(p) === id);
    if (idx >= 0) _state.pendingPermissions[idx] = req;
    else _state.pendingPermissions = [..._state.pendingPermissions, req];
    _state.pendingPermission = _state.pendingPermissions[0] || null;
    notify({ type: 'permission:set' });
    return idx < 0;
  }

  function removePendingPermission(requestId) {
    const id = String(requestId || '');
    // An answer is news even when the request is not on screen: a list read
    // before the answer may still be on its way with the request in it.
    _rev.permissions += 1;
    const before = _state.pendingPermissions.length;
    _state.pendingPermissions = _state.pendingPermissions.filter((p) => permissionIdOf(p) !== id);
    if (_state.pendingPermissions.length === before) return false;
    _state.pendingPermission = _state.pendingPermissions[0] || null;
    notify({ type: 'permission:set' });
    return true;
  }

  // Replace the queue with what the server says is pending right now.
  // `listed`: the list is the server's own answer for this session (a
  // recovery read), not a local edit; listeners may drop what it no longer has.
  function setPendingPermissions(list, { listed = false } = {}) {
    _rev.permissions += 1;
    const seen = new Set();
    _state.pendingPermissions = (Array.isArray(list) ? list : []).filter((req) => {
      const id = permissionIdOf(req);
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    _state.pendingPermission = _state.pendingPermissions[0] || null;
    notify(listed ? { type: 'permission:set', listed: true } : { type: 'permission:set' });
  }

  function setTodos(todos) {
    _rev.todos += 1;
    _state.todos = Array.isArray(todos) ? todos : [];
    notify({ type: 'todos:set' });
  }

  function setSessionDiff(diff) {
    _state.sessionDiff = Array.isArray(diff) ? diff : [];
    notify({ type: 'diff:set' });
  }

  function setAutoAccept(value) {
    const next = !!value;
    if (_state.autoAccept === next) return;
    _state.autoAccept = next;
    notify({ type: 'autoaccept:set' });
  }

  // Older callers hold one request: an object joins the queue, null empties it.
  function setPendingPermission(permission) {
    if (permission) { addPendingPermission(permission); return; }
    setPendingPermissions([]);
  }

  function setPendingQuestions(questions) {
    _rev.questions += 1;
    _state.pendingQuestions = Array.isArray(questions) ? questions : [];
    notify({ type: 'questions:set' });
  }

  function addPendingQuestion(req) {
    if (!req || !req.id) return;
    const id = String(req.id || '');
    _rev.questions += 1;
    const idx = _state.pendingQuestions.findIndex((q) => String(q?.id || '') === id);
    if (idx >= 0) _state.pendingQuestions[idx] = req;
    else _state.pendingQuestions = [..._state.pendingQuestions, req];
    notify({ type: 'questions:set' });
  }

  function removePendingQuestion(requestId) {
    const id = String(requestId || '');
    _rev.questions += 1;
    _state.pendingQuestions = _state.pendingQuestions.filter((q) => String(q?.id || '') !== id);
    notify({ type: 'questions:set' });
  }

  // At most ERRORS_MAX errors are kept: past that the oldest error goes. A
  // notice is not an error and is never pushed out by one (nor by another
  // notice): it stays until the user dismisses it.
  function pushError(err) {
    _errorSeq += 1;
    _state.errors.push({ at: Date.now(), ...err, id: `err-${_errorSeq}` });
    let excess = _state.errors.filter((e) => !e?.notice).length - ERRORS_MAX;
    if (excess > 0) {
      _state.errors = _state.errors.filter((e) => {
        if (e?.notice || excess <= 0) return true;
        excess -= 1;
        return false;
      });
    }
    notify({ type: 'error:push' });
  }

  function dismissError(id) {
    const before = _state.errors.length;
    _state.errors = _state.errors.filter((err) => err.id !== id);
    if (_state.errors.length !== before) notify({ type: 'errors:clear' });
  }

  // Errors only: a notice stays until the user dismisses it. With `ids` (a
  // recovery's sweep), only those errors: one that appeared since stays.
  function clearErrors(ids) {
    const only = Array.isArray(ids) ? new Set(ids) : null;
    const goes = (err) => !err?.notice && (!only || only.has(err.id));
    if (!_state.errors.some(goes)) return;
    _state.errors = _state.errors.filter((err) => !goes(err));
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
      if (s?.id) _state.knownSessions.set(s.id, filteredInfo(s));
    }
    notify({ type: 'sessions:list' });
  }

  // The /help card: shown until it is closed or the panel moves on.
  function setHelpCard(view) {
    const next = view && typeof view === 'object' ? view : null;
    if (next === _state.helpCard) return;
    _state.helpCard = next;
    notify({ type: 'help:set' });
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
    _planTurnSeq += 1;
    _state.planTurnActive = true;
    _state.planTurnSessionId = sessionId || null;
    _state.planTurnId = _planTurnSeq;
    _state.planTurnStartedAt = Date.now();
    _state.planTurnStartMessageCount = startMessageCount;
    _state.planContent = '';
    _state.editedPlanContent = '';
    _state.planFilePath = '';
    _state.showPostPlanActions = false;
    _state.postPlanHeader = 'PLAN COMPLETE';
    notify({ type: 'plan:turn:start' });
    return _state.planTurnId;
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
    _state.planTurnId = 0;
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

  // Any agent OpenCode offers. The plan lifecycle (async turn, PLAN COMPLETE
  // card) is keyed on `mode`, which is 'plan' for the plan agent and 'build'
  // for every other one.
  function setAgent(agent) {
    const next = String(agent || '').trim() || agentForMode(_state.mode);
    const mode = next === 'plan' ? 'plan' : 'build';
    const modeChanged = mode !== _state.mode;
    _state.agent = next;
    _state.mode = mode;
    if (mode === 'build') _state.planTurnActive = false;
    notify({ type: 'config:agent' });
    if (modeChanged) notify({ type: 'config:mode', mode });
  }
  function setModel(model)     { _state.model = model;     notify({ type: 'config:model' }); }
  function setVariant(variant) { _state.variant = variant; notify({ type: 'config:variant' }); }
  function setCwd(cwd)         { _state.cwd = cwd;         notify({ type: 'config:cwd' }); }
  function setMcpProfile(profile) { _state.mcpProfile = profile || null; notify({ type: 'config:mcp-profile' }); }

  function setContextGauge(value = {}) {
    _state.contextGauge = { ...(_state.contextGauge || createDefaultContextGauge()), ...value };
    notify({ type: 'context:gauge' });
  }

  function resetContextGauge(status = _state.sessionId ? 'pending' : 'idle') {
    _state.contextGauge = createDefaultContextGauge(status);
    notify({ type: 'context:gauge' });
  }

  // `restore`: an attachment that was already in the strip and is put back (a
  // send or a command that failed). It is never refused for the limit: the
  // limit is for adding, and what the user attached is not dropped.
  function addAttachedImage(img, { restore = false } = {}) {
    if (!img || !img.dataUrl) return false;
    if (!restore && _state.attachedImages.length >= MAX_ATTACHED) return false;
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
    getState, subscribe, getRevisions, getBinding, getTurn, beginTurn, touchStatus,
    setServerStatus, setSession, setSessionInfo, setParentSession,
    clearMessages, upsertMessage, removeMessage, upsertPart,
    appendPartDelta, removePart, hydrateMessages,
    setRunning, setSessionStatus, setCompacting,
    setPendingPermission, setPendingPermissions, addPendingPermission, removePendingPermission,
    setAutoAccept, setTodos, setSessionDiff,
    setPendingQuestions, addPendingQuestion, removePendingQuestion,
    pushError, dismissError, clearErrors, setHealing, setKnownSessions,
    setSessionInfoFilter, setHelpCard,
    setMode, setAgent, setModel, setVariant, setCwd, setMcpProfile,
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
export const setSessionInfo          = (...a) => _defaultStore.setSessionInfo(...a);
export const setSessionStatus        = (...a) => _defaultStore.setSessionStatus(...a);
export const hydrateMessages         = (...a) => _defaultStore.hydrateMessages(...a);
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
export const setMcpProfile           = (...a) => _defaultStore.setMcpProfile(...a);
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
