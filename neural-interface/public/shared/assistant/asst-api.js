// ═══════════════════════════════════════════
// SynaBun Assistant — REST client (/api/assistant/*)
// ═══════════════════════════════════════════
// Mirrors api.js's jsonFetch: 403s raise `synabun:forbidden` so the guest
// toast fires, every other failure throws an Error with the server message.

async function jsonFetch(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    let errMsg = `HTTP ${res.status}`;
    let code = null;
    let field = null;
    try {
      const body = await res.json();
      errMsg = body.error || body.message || errMsg;
      code = body.code || body.reason || null;
      field = body.field || null;
    } catch { /* non-JSON body */ }
    const err = new Error(errMsg);
    err.status = res.status;
    err.code = code;
    if (field) err.field = field;
    if (res.status === 403) {
      err.forbidden = true;
      window.dispatchEvent(new CustomEvent('synabun:forbidden', { detail: errMsg }));
    }
    throw err;
  }
  if (res.status === 204) return {};
  return res.json();
}

function jsonBody(data, method = 'POST') {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data ?? {}),
  };
}

const enc = encodeURIComponent;

// ── Catalog ──────────────────────────────────

export function fetchAssistantCatalog({ force = false } = {}) {
  return jsonFetch(`/api/assistant/catalog${force ? '?refresh=1' : ''}`);
}

// ── Hidden models (Assistant → Models) ───────

/** → { ok, providers: { 'claude-code': [], codex: [], opencode: [] } } */
export function getHiddenModelLists() {
  return jsonFetch('/api/assistant/hidden-models');
}

/** PATCH { provider?, hide?: [], show?: [] } → { ok, providers, changed, applied }. 400 MODEL_UNKNOWN / MODEL_AMBIGUOUS throw with err.code. */
export function patchHiddenModels(body) {
  return jsonFetch('/api/assistant/hidden-models', jsonBody(body, 'PATCH'));
}

/** Every catalog row, hidden ones included, with hidden: true|false (the Models manager). */
export function fetchManageCatalog({ force = false } = {}) {
  return jsonFetch(`/api/assistant/catalog?view=manage${force ? '&refresh=1' : ''}`);
}

// ── Routing (model routes) ───────────────────

/** → { ok, version, routing:{ defaultMode, askBelow, waitSeconds, cardTimeoutMinutes, preferences, ladders, catalogFilter }, taskClasses, modes } */
export function getRouting() {
  return jsonFetch('/api/assistant/routing');
}

/** PUT a partial routing object; `preferences: { key: null }` deletes. 409 VERSION_CONFLICT / 400 ROUTING_INVALID throw with err.code. */
export function putRouting(patch, version) {
  return jsonFetch('/api/assistant/routing', jsonBody({ version, routing: patch || {} }, 'PUT'));
}

// ── Budget (money caps) ─────────────────────

/** → { ok, version, budget, defaults, sources, repairs, bounds, session|null, pricing, enforcement } */
export function getBudget(sessionId = null) {
  return jsonFetch(`/api/assistant/budget${sessionId ? `?sessionId=${enc(sessionId)}` : ''}`);
}

/** PUT the caps (USD). 409 VERSION_CONFLICT / 400 BUDGET_INVALID (err.field) throw with err.code. */
export function putBudget(budget, version, sessionId = null) {
  return jsonFetch('/api/assistant/budget', jsonBody({ version, budget: budget || {}, sessionId }, 'PUT'));
}

export function deleteRoutingPreference(key) {
  return jsonFetch(`/api/assistant/routing/preferences/${enc(key)}`, { method: 'DELETE' });
}

/** Start the escalated child run of a failed/blocked run (optional explicit target). */
export function escalateAssistantRun(runId, target) {
  return jsonFetch(`/api/assistant/runs/${enc(runId)}/escalate`, jsonBody(target ? { target } : {}));
}

// ── Desktop (computer use) ───────────────────

export function getDesktopStatus() {
  return jsonFetch('/api/desktop/status');
}

/** step: 'start'|'recheck'|'install_toolchain'|'request_screen'|'request_accessibility'|'open_settings' (+ { pane }). */
export function desktopSetup(step, extra = {}) {
  return jsonFetch('/api/desktop/setup', jsonBody({ ...(extra || {}), step }));
}

/** body: { scope:'all'|'session'|'run', assistantSessionId?, runId? } */
export function stopDesktop(body = { scope: 'all' }) {
  return jsonFetch('/api/desktop/stop', jsonBody(body || { scope: 'all' }));
}

export function resumeDesktop() {
  return jsonFetch('/api/desktop/resume', jsonBody({}));
}

export async function fetchProjects() {
  const data = await jsonFetch('/api/projects');
  return Array.isArray(data?.projects) ? data.projects : [];
}

// ── Sessions ─────────────────────────────────

/** `fallback`: a model disabled in Assistant → Models starts on its enabled stand-in (session.fallback says which) instead of a 400. */
export function createAssistantSession({ brain, label, fallback = false } = {}) {
  return jsonFetch('/api/assistant/sessions', jsonBody({ brain, label, fallback: fallback === true || undefined }));
}

export async function listAssistantSessions() {
  const data = await jsonFetch('/api/assistant/sessions');
  return Array.isArray(data?.sessions) ? data.sessions : [];
}

export function getAssistantSession(id) {
  return jsonFetch(`/api/assistant/sessions/${enc(id)}`);
}

export function getAssistantSessionUsage(id) {
  return jsonFetch(`/api/assistant/sessions/${enc(id)}/usage?task=current`);
}

export function patchAssistantSession(id, patch) {
  return jsonFetch(`/api/assistant/sessions/${enc(id)}`, jsonBody(patch, 'PATCH'));
}

export function closeAssistantSession(id) {
  return jsonFetch(`/api/assistant/sessions/${enc(id)}/close`, jsonBody({}));
}

// ── Attachments ──────────────────────────────

/**
 * Stream one file to the server's attachments folder (XHR: fetch reports no
 * upload progress). Resolves { path, name, size, mime } — `path` is absolute.
 * onProgress(0…1) while it sends; aborting `signal` cancels it.
 */
export function uploadAssistantAttachment(file, { sessionId = null, onProgress = null, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    const fail = (message, extra = {}) => reject(Object.assign(new Error(message), extra));
    if (signal?.aborted) { fail('Upload cancelled', { code: 'ABORTED' }); return; }
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/assistant/attachments${sessionId ? `?assistantSessionId=${enc(sessionId)}` : ''}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Synabun-Filename', enc(file?.name || 'attachment'));
    if (file?.type) xhr.setRequestHeader('X-Synabun-Mime', file.type);
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      const body = xhr.response && typeof xhr.response === 'object' ? xhr.response : {};
      if (xhr.status >= 200 && xhr.status < 300 && body.attachment?.path) { resolve(body.attachment); return; }
      if (xhr.status === 403) window.dispatchEvent(new CustomEvent('synabun:forbidden', { detail: body.error || 'Forbidden' }));
      fail(body.error || body.message || `HTTP ${xhr.status}`, { status: xhr.status, code: body.code || null, forbidden: xhr.status === 403 });
    };
    xhr.onerror = () => fail('Upload failed', { code: 'NETWORK' });
    xhr.onabort = () => fail('Upload cancelled', { code: 'ABORTED' });
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

// ── Runs ─────────────────────────────────────

export function dispatchAssistantRun(spec) {
  return jsonFetch('/api/assistant/dispatch', jsonBody(spec));
}

export async function listAssistantRuns({ assistantSessionId, active = false, status = null, limit = null } = {}) {
  const params = new URLSearchParams();
  if (assistantSessionId) params.set('assistantSessionId', assistantSessionId);
  if (active) params.set('active', '1');
  if (status) params.set('status', status);
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  const data = await jsonFetch(`/api/assistant/runs${qs ? `?${qs}` : ''}`);
  return Array.isArray(data?.runs) ? data.runs : [];
}

export function getAssistantRun(runId) {
  return jsonFetch(`/api/assistant/runs/${enc(runId)}`);
}

export function getAssistantRunResult(runId) {
  return jsonFetch(`/api/assistant/runs/${enc(runId)}/result`);
}

export function sendAssistantRun(runId, text, { origin = 'user' } = {}) {
  return jsonFetch(`/api/assistant/runs/${enc(runId)}/send`, jsonBody({ text, origin }));
}

export function stopAssistantRun(runId, reason) {
  return jsonFetch(`/api/assistant/runs/${enc(runId)}/stop`, jsonBody(reason ? { reason } : {}));
}

/** Remove one finished run from the agents tray (409 RUN_ACTIVE while it still runs). */
export function removeAssistantRun(runId, assistantSessionId) {
  const qs = assistantSessionId ? `?assistantSessionId=${enc(assistantSessionId)}` : '';
  return jsonFetch(`/api/assistant/runs/${enc(runId)}${qs}`, { method: 'DELETE' });
}

/** Remove every finished run of an assistant session → { removed: [runId], skipped: [runId] }. */
export function clearFinishedAssistantRuns(assistantSessionId) {
  return jsonFetch('/api/assistant/runs/clear-finished', jsonBody({ assistantSessionId }));
}

export function focusAssistantRun(runId) {
  return jsonFetch(`/api/assistant/runs/${enc(runId)}/focus`, jsonBody({}));
}

export function killAllAssistantRuns(assistantSessionId) {
  return jsonFetch('/api/assistant/kill-all', jsonBody({ assistantSessionId }));
}

// ── Claude accounts ──────────────────────────

export async function listClaudeAccounts() {
  const data = await jsonFetch('/api/assistant/claude/accounts');
  return Array.isArray(data?.accounts) ? data.accounts : [];
}

export function createClaudeAccount(label) {
  return jsonFetch('/api/assistant/claude/accounts', jsonBody({ label }));
}

export function patchClaudeAccount(id, patch) {
  return jsonFetch(`/api/assistant/claude/accounts/${enc(id)}`, jsonBody(patch, 'PATCH'));
}

export function deleteClaudeAccount(id) {
  return jsonFetch(`/api/assistant/claude/accounts/${enc(id)}`, { method: 'DELETE' });
}

export function loginClaudeAccount(id) {
  return jsonFetch(`/api/assistant/claude/accounts/${enc(id)}/login`, jsonBody({}));
}

// ── Codex accounts ───────────────────────────

export function startCodexAccountAdd(label) {
  return jsonFetch('/api/assistant/codex/accounts/add-start', jsonBody({ label }));
}

export function patchCodexAccount(id, patch) {
  return jsonFetch(`/api/assistant/codex/accounts/${enc(id)}`, jsonBody(patch, 'PATCH'));
}

export function deleteCodexAccount(id) {
  return jsonFetch(`/api/assistant/codex/accounts/${enc(id)}`, { method: 'DELETE' });
}
