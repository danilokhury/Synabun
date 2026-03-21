// ═══════════════════════════════════════════
// SynaBun Neural Interface — API Client
// ═══════════════════════════════════════════
// Single source of truth for all REST API calls.
// Every fetch('/api/...') in the UI should route through here.

// ─── Helpers ─────────────────────────────

async function jsonFetch(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    let errMsg = `HTTP ${res.status}`;
    try { const body = await res.json(); errMsg = body.error || errMsg; } catch {}
    if (res.status === 403) {
      console.warn(`[api] 403 Forbidden: ${url}`);
      // Trigger global toast for guest feedback
      window.dispatchEvent(new CustomEvent('synabun:forbidden', { detail: errMsg }));
      const err = new Error(errMsg);
      err.forbidden = true;
      throw err;
    }
    throw new Error(errMsg);
  }
  return res.json();
}

function jsonBody(data) {
  return {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  };
}

// ─── Health ──────────────────────────────

export async function fetchHealth() {
  const res = await fetch('/api/health', { signal: AbortSignal.timeout(3000) });
  return res.json();
}

export async function startHealth() {
  const res = await fetch('/api/health/start', { method: 'POST' });
  return res.json();
}

// ─── Memories ────────────────────────────

export async function fetchMemories(includeLinks = true) {
  const url = includeLinks ? '/api/memories' : '/api/memories?links=false';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchLinks() {
  return jsonFetch('/api/links');
}

export async function fetchMemory(id) {
  return jsonFetch(`/api/memory/${encodeURIComponent(id)}`);
}

export async function updateMemory(id, payload) {
  return jsonFetch(`/api/memory/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    ...jsonBody(payload),
  });
}

export async function deleteMemory(id) {
  return jsonFetch(`/api/memory/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function deleteMemoryPermanent(id) {
  return jsonFetch(`/api/memory/${encodeURIComponent(id)}?permanent=true`, {
    method: 'DELETE',
  });
}

// ─── Search ──────────────────────────────

export async function searchMemories(query, limit = 15) {
  return jsonFetch('/api/search', {
    method: 'POST',
    ...jsonBody({ query, limit }),
  });
}

// ─── Stats ───────────────────────────────

export async function fetchStats() {
  return jsonFetch('/api/stats');
}

// ─── Categories ──────────────────────────

export async function fetchCategories() {
  return jsonFetch('/api/categories');
}

export async function createCategory(payload) {
  // payload: { name, description, color?, parent?, is_parent? }
  return jsonFetch('/api/categories', {
    method: 'POST',
    ...jsonBody(payload),
  });
}

export async function updateCategory(name, updates) {
  // updates: { new_name?, description?, parent?, color?, is_parent? }
  return jsonFetch(`/api/categories/${encodeURIComponent(name)}`, {
    method: 'PUT',
    ...jsonBody(updates),
  });
}

export async function patchCategory(name, updates) {
  // updates: { description? }
  return jsonFetch(`/api/categories/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    ...jsonBody(updates),
  });
}

export async function deleteCategory(name, body = {}) {
  // body: { reassign_to?, reassign_children_to?, delete_memories? }
  return jsonFetch(`/api/categories/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    ...jsonBody(body),
  });
}

export async function exportCategory(name) {
  const res = await fetch(`/api/categories/${encodeURIComponent(name)}/export`);
  if (!res.ok) {
    let errMsg = 'Export failed';
    try { const body = await res.json(); errMsg = body.error || errMsg; } catch {}
    throw new Error(errMsg);
  }
  return res.blob();
}

export async function uploadCategoryLogo(name, fileBuffer, contentType) {
  return jsonFetch(`/api/categories/${encodeURIComponent(name)}/logo`, {
    method: 'POST',
    headers: { 'Content-Type': contentType || 'image/png' },
    body: fileBuffer,
  });
}

export async function deleteCategoryLogo(name) {
  return jsonFetch(`/api/categories/${encodeURIComponent(name)}/logo`, {
    method: 'DELETE',
  });
}

// ─── Trash ───────────────────────────────

export async function fetchTrash() {
  return jsonFetch('/api/trash');
}

export async function restoreFromTrash(id) {
  return jsonFetch(`/api/trash/${encodeURIComponent(id)}/restore`, {
    method: 'POST',
  });
}

export async function purgeTrash() {
  return jsonFetch('/api/trash/purge', {
    method: 'DELETE',
    ...jsonBody({}),
  });
}

// ─── Settings ────────────────────────────

export async function fetchSettings() {
  return jsonFetch('/api/settings');
}

export async function saveSettings(payload) {
  // payload: { databasePath? }
  return jsonFetch('/api/settings', {
    method: 'PUT',
    ...jsonBody(payload),
  });
}

// ─── Display Settings ────────────────────

export async function fetchDisplaySettings() {
  return jsonFetch('/api/display-settings');
}

export async function saveDisplaySettings(payload) {
  // payload: { recallMaxChars? }
  return jsonFetch('/api/display-settings', {
    method: 'PUT',
    ...jsonBody(payload),
  });
}

// ─── Keybinds ────────────────────────────

export async function fetchKeybinds() {
  return jsonFetch('/api/keybinds');
}

export async function saveKeybindsToServer(payload) {
  return jsonFetch('/api/keybinds', {
    method: 'PUT',
    ...jsonBody(payload),
  });
}

// ─── Connections ─────────────────────────

export async function fetchConnections() {
  return jsonFetch('/api/connections');
}

export async function suggestPort() {
  return jsonFetch('/api/connections/suggest-port');
}

export async function createConnection(payload) {
  // payload: { id, label, url, apiKey, collection }
  return jsonFetch('/api/connections', {
    method: 'POST',
    ...jsonBody(payload),
  });
}

export async function setActiveConnection(id) {
  return jsonFetch('/api/connections/active', {
    method: 'PUT',
    ...jsonBody({ id }),
  });
}

export async function deleteConnection(id) {
  return jsonFetch(`/api/connections/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function syncConnectionEnv() {
  return jsonFetch('/api/connections/sync-env', { method: 'POST' });
}

export async function startConnectionContainer(id) {
  return jsonFetch('/api/connections/start-container', {
    method: 'POST',
    ...jsonBody({ id }),
  });
}

export async function backupConnection(id) {
  const res = await fetch(`/api/connections/${encodeURIComponent(id)}/backup`, {
    method: 'POST',
  });
  if (!res.ok) {
    let errMsg = 'Backup failed';
    try { const body = await res.json(); errMsg = body.error || errMsg; } catch {}
    throw new Error(errMsg);
  }
  // Returns a blob (snapshot file) with content-disposition header
  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') || '';
  const filenameMatch = disposition.match(/filename="?([^"]+)"?/);
  const filename = filenameMatch ? filenameMatch[1] : `backup-${id}.snapshot`;
  return { blob, filename };
}

export async function restoreConnection(id, snapshotBuffer) {
  return jsonFetch(`/api/connections/${encodeURIComponent(id)}/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: snapshotBuffer,
  });
}

export async function restoreStandalone(params, snapshotBuffer) {
  // params: { url, apiKey, collection, label? }
  const qs = new URLSearchParams(params).toString();
  return jsonFetch(`/api/connections/restore-standalone?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: snapshotBuffer,
  });
}

// ─── Full System Backup & Restore ────────

export async function systemBackup() {
  const res = await fetch('/api/system/backup');
  if (!res.ok) {
    let errMsg = 'Backup failed';
    try { const body = await res.json(); errMsg = body.error || errMsg; } catch {}
    throw new Error(errMsg);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') || '';
  const filenameMatch = disposition.match(/filename="?([^"]+)"?/);
  const filename = filenameMatch ? filenameMatch[1] : 'synabun-backup.zip';
  return { blob, filename };
}

export async function systemRestorePreview(zipBuffer) {
  const res = await fetch('/api/system/restore/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: zipBuffer,
  });
  if (!res.ok) {
    let errMsg = 'Preview failed';
    try { const body = await res.json(); errMsg = body.error || errMsg; } catch {}
    throw new Error(errMsg);
  }
  return res.json();
}

export async function systemRestore(zipBuffer, mode = 'full') {
  const res = await fetch(`/api/system/restore?mode=${encodeURIComponent(mode)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: zipBuffer,
  });
  if (!res.ok) {
    let errMsg = 'Restore failed';
    try { const body = await res.json(); errMsg = body.error || errMsg; } catch {}
    throw new Error(errMsg);
  }
  return res.json();
}

export async function createCollection(payload) {
  // payload: { url, apiKey, collection }
  return jsonFetch('/api/connections/create-collection', {
    method: 'POST',
    ...jsonBody(payload),
  });
}

// ─── OpenClaw Bridge ─────────────────────

export async function fetchOpenClawBridge() {
  return jsonFetch('/api/bridges/openclaw');
}

export async function connectOpenClawBridge() {
  return jsonFetch('/api/bridges/openclaw/connect', {
    method: 'POST',
    ...jsonBody({}),
  });
}

export async function syncOpenClawBridge() {
  return jsonFetch('/api/bridges/openclaw/sync', { method: 'POST' });
}

export async function disconnectOpenClawBridge() {
  return jsonFetch('/api/bridges/openclaw', { method: 'DELETE' });
}

// ─── Memory Sync ─────────────────────────

export async function checkSync() {
  return jsonFetch('/api/sync/check');
}

// ─── Claude Code Integrations ────────────

export async function fetchClaudeCodeIntegrations() {
  return jsonFetch('/api/claude-code/integrations');
}

export async function toggleClaudeCodeIntegration(method, payload) {
  // method: 'POST' | 'DELETE'
  // payload: { target, projectPath?, hook? }
  return jsonFetch('/api/claude-code/integrations', {
    method,
    ...jsonBody(payload),
  });
}

export async function removeClaudeCodeProject(index) {
  return jsonFetch(`/api/claude-code/projects/${index}`, {
    method: 'DELETE',
  });
}

export async function fetchClaudeCodeHookFeatures() {
  return jsonFetch('/api/claude-code/hook-features');
}

export async function updateClaudeCodeHookFeature(feature, enabled) {
  return jsonFetch('/api/claude-code/hook-features', {
    method: 'PUT',
    ...jsonBody({ feature, enabled }),
  });
}

export async function fetchClaudeCodeRuleset() {
  return jsonFetch('/api/claude-code/ruleset');
}

// ─── Claude Code MCP ─────────────────────

export async function fetchClaudeCodeMcp() {
  return jsonFetch('/api/claude-code/mcp');
}

export async function toggleClaudeCodeMcp(method) {
  // method: 'POST' to register, 'DELETE' to unregister
  return jsonFetch('/api/claude-code/mcp', { method });
}

// ─── Claude Code Skills ──────────────────

export async function fetchClaudeCodeSkills() {
  return jsonFetch('/api/claude-code/skills');
}

export async function toggleClaudeCodeSkill(method, skillName) {
  // method: 'POST' to install, 'DELETE' to uninstall
  return jsonFetch('/api/claude-code/skills', {
    method,
    ...jsonBody({ name: skillName }),
  });
}

// ─── Skills Studio ───────────────────────

export async function fetchSkillsLibrary() {
  return jsonFetch('/api/skills-studio/library');
}

export async function fetchSkillsArtifact(encodedId) {
  return jsonFetch(`/api/skills-studio/artifact/${encodedId}`);
}

export async function saveSkillsArtifact(encodedId, rawContent) {
  return jsonFetch(`/api/skills-studio/artifact/${encodedId}`, {
    method: 'PUT',
    ...jsonBody({ rawContent }),
  });
}

export async function fetchSkillsSubFile(encodedId, path) {
  return jsonFetch(`/api/skills-studio/artifact/${encodedId}/file?path=${encodeURIComponent(path)}`);
}

export async function saveSkillsSubFile(encodedId, path, content) {
  return jsonFetch(`/api/skills-studio/artifact/${encodedId}/file`, {
    method: 'PUT',
    ...jsonBody({ path, content }),
  });
}

export async function createSkillsSubFile(encodedId, path, content, isDir) {
  return jsonFetch(`/api/skills-studio/artifact/${encodedId}/file`, {
    method: 'POST',
    ...jsonBody({ path, content, isDir }),
  });
}

export async function deleteSkillsSubFile(encodedId, path) {
  return jsonFetch(`/api/skills-studio/artifact/${encodedId}/file`, {
    method: 'DELETE',
    ...jsonBody({ path }),
  });
}

export async function createSkillsArtifact(payload) {
  return jsonFetch('/api/skills-studio/create', {
    method: 'POST',
    ...jsonBody(payload),
  });
}

export async function deleteSkillsArtifact(encodedId) {
  return jsonFetch(`/api/skills-studio/artifact/${encodedId}`, {
    method: 'DELETE',
  });
}

export async function validateSkillsArtifact(rawContent, type) {
  return jsonFetch('/api/skills-studio/validate', {
    method: 'POST',
    ...jsonBody({ rawContent, type }),
  });
}

export async function installSkillsBundled(dirName) {
  return jsonFetch('/api/skills-studio/install', {
    method: 'POST',
    ...jsonBody({ dirName }),
  });
}

export async function uninstallSkillsBundled(dirName) {
  return jsonFetch('/api/skills-studio/install', {
    method: 'DELETE',
    ...jsonBody({ dirName }),
  });
}

export async function importSkillsBundle(bundle, scope, projectPath) {
  return jsonFetch('/api/skills-studio/import', {
    method: 'POST',
    ...jsonBody({ bundle, scope, projectPath }),
  });
}

export function getSkillsExportUrl(encodedId) {
  return `/api/skills-studio/export/${encodedId}`;
}

export function getSkillsIconUrl(encodedId) {
  return `/api/skills-studio/artifact/${encodedId}/icon`;
}

export async function uploadSkillsIcon(encodedId, fileBuffer, contentType) {
  return jsonFetch(`/api/skills-studio/artifact/${encodedId}/icon`, {
    method: 'POST',
    headers: { 'Content-Type': contentType || 'image/png' },
    body: fileBuffer,
  });
}

export async function deleteSkillsIcon(encodedId) {
  return jsonFetch(`/api/skills-studio/artifact/${encodedId}/icon`, { method: 'DELETE' });
}

// ─── MCP Key ─────────────────────────────

export async function fetchMcpKey() {
  return jsonFetch('/api/mcp-key');
}

export async function generateMcpKey() {
  return jsonFetch('/api/mcp-key', { method: 'POST' });
}

export async function revokeMcpKey() {
  return jsonFetch('/api/mcp-key', { method: 'DELETE' });
}

// ─── Tunnel ──────────────────────────────

export async function fetchTunnelStatus() {
  return jsonFetch('/api/tunnel/status');
}

export async function startTunnel() {
  return jsonFetch('/api/tunnel/start', { method: 'POST' });
}

export async function stopTunnel() {
  return jsonFetch('/api/tunnel/stop', { method: 'POST' });
}

// ─── Last Session (resume after restart) ──

export async function fetchLastSession() {
  const r = await fetch('/api/last-session');
  if (!r.ok) return null;
  return r.json();
}

export async function dismissLastSession() {
  return fetch('/api/last-session', { method: 'DELETE' });
}

// ─── Terminal ────────────────────────────

export async function fetchTerminalSessions() {
  return jsonFetch('/api/terminal/sessions');
}

export async function createTerminalSession(profile, cols, rows, cwd, opts = {}) {
  return jsonFetch('/api/terminal/sessions', {
    method: 'POST',
    ...jsonBody({ profile, cols, rows, cwd, ...opts }),
  });
}

// ─── Claude Code Sessions (Resume) ─────

export async function fetchClaudeSessions({ project, limit, offset, search, refresh } = {}) {
  const params = new URLSearchParams();
  if (project) params.set('project', project);
  if (limit) params.set('limit', String(limit));
  if (offset) params.set('offset', String(offset));
  if (search) params.set('search', search);
  if (refresh) params.set('refresh', 'true');
  return jsonFetch(`/api/claude-code/sessions?${params}`);
}

// ─── Session Indexing ─────

export async function startSessionIndexing({ project, reindex, sessionIds } = {}) {
  return jsonFetch('/api/session-indexing/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, reindex, sessionIds }),
  });
}

export async function cancelSessionIndexing() {
  return jsonFetch('/api/session-indexing/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

export async function fetchIndexingStatus() {
  return jsonFetch('/api/session-indexing/status');
}

export async function deleteTerminalSession(sessionId) {
  return jsonFetch(`/api/terminal/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
}

export async function fetchTerminalFiles(dirPath, search) {
  let url = `/api/terminal/files?path=${encodeURIComponent(dirPath)}`;
  if (search) url += `&search=${encodeURIComponent(search)}`;
  return jsonFetch(url);
}

export async function fetchTerminalBranches(dirPath) {
  return jsonFetch(`/api/terminal/branches?path=${encodeURIComponent(dirPath)}`);
}

export async function checkoutTerminalBranch(dirPath, branch) {
  return jsonFetch('/api/terminal/checkout', {
    method: 'POST',
    ...jsonBody({ path: dirPath, branch }),
  });
}

// ─── Terminal Links ──────────────────────

export async function fetchTerminalLinks() {
  return jsonFetch('/api/terminal/links');
}

export async function fetchTerminalLink(linkId) {
  return jsonFetch(`/api/terminal/links/${encodeURIComponent(linkId)}`);
}

export async function createTerminalLink(sessions, config = {}) {
  return jsonFetch('/api/terminal/links', {
    method: 'POST',
    ...jsonBody({ sessions, ...config }),
  });
}

export async function deleteTerminalLink(linkId) {
  return jsonFetch(`/api/terminal/links/${encodeURIComponent(linkId)}`, {
    method: 'DELETE',
  });
}

export async function detectClaudeSession(terminalSessionId) {
  return jsonFetch(`/api/terminal/sessions/${encodeURIComponent(terminalSessionId)}/claude-session`);
}

export async function updateTerminalLink(linkId, config) {
  return jsonFetch(`/api/terminal/links/${encodeURIComponent(linkId)}`, {
    method: 'PATCH',
    ...jsonBody(config),
  });
}

export async function sendLinkMessage(linkId, message, targetIdx) {
  return jsonFetch(`/api/terminal/links/${encodeURIComponent(linkId)}/send`, {
    method: 'POST',
    ...jsonBody({ message, targetIdx }),
  });
}

export async function pauseLink(linkId) {
  return jsonFetch(`/api/terminal/links/${encodeURIComponent(linkId)}/pause`, {
    method: 'POST',
  });
}

export async function resumeLink(linkId) {
  return jsonFetch(`/api/terminal/links/${encodeURIComponent(linkId)}/resume`, {
    method: 'POST',
  });
}

export async function nudgeLink(linkId) {
  return jsonFetch(`/api/terminal/links/${encodeURIComponent(linkId)}/nudge`, {
    method: 'POST',
  });
}

// ─── Browser Sessions ────────────────────

export async function fetchBrowserSessions() {
  return jsonFetch('/api/browser/sessions');
}

export async function createBrowserSession(url, width, height, fingerprint, opts = {}) {
  return jsonFetch('/api/browser/sessions', {
    method: 'POST',
    ...jsonBody({ url, width, height, ...fingerprint, ...opts }),
  });
}

export async function deleteBrowserSession(sessionId) {
  return jsonFetch(`/api/browser/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
}

export async function navigateBrowser(sessionId, url) {
  return jsonFetch(`/api/browser/sessions/${encodeURIComponent(sessionId)}/navigate`, {
    method: 'POST',
    ...jsonBody({ url }),
  });
}

export async function browserBack(sessionId) {
  return jsonFetch(`/api/browser/sessions/${encodeURIComponent(sessionId)}/back`, {
    method: 'POST',
    ...jsonBody({}),
  });
}

export async function browserForward(sessionId) {
  return jsonFetch(`/api/browser/sessions/${encodeURIComponent(sessionId)}/forward`, {
    method: 'POST',
    ...jsonBody({}),
  });
}

export async function browserReload(sessionId) {
  return jsonFetch(`/api/browser/sessions/${encodeURIComponent(sessionId)}/reload`, {
    method: 'POST',
    ...jsonBody({}),
  });
}

export async function fetchBrowserCdp(sessionId) {
  return jsonFetch(`/api/browser/sessions/${encodeURIComponent(sessionId)}/cdp`);
}

// ─── Setup (Onboarding) ─────────────────

export async function checkSetupDeps() {
  return jsonFetch('/api/setup/check-deps');
}

export async function fetchSetupStatus() {
  return jsonFetch('/api/setup/onboarding');
}

export async function saveSetupConfig(payload) {
  return jsonFetch('/api/setup/save-config', {
    method: 'POST',
    ...jsonBody(payload),
  });
}

export async function setupCreateCollection(payload) {
  return jsonFetch('/api/setup/create-collection', {
    method: 'POST',
    ...jsonBody(payload),
  });
}

export async function setupBuild() {
  return jsonFetch('/api/setup/build', { method: 'POST' });
}

export async function testDatabase() {
  return jsonFetch('/api/setup/test-qdrant');
}

export async function testDatabaseRemote(payload) {
  return jsonFetch('/api/setup/test-qdrant-cloud', {
    method: 'POST',
    ...jsonBody(payload),
  });
}

export async function writeMcpJson(payload) {
  return jsonFetch('/api/setup/write-mcp-json', {
    method: 'POST',
    ...jsonBody(payload),
  });
}

export async function writeInstructions(payload) {
  return jsonFetch('/api/setup/write-instructions', {
    method: 'POST',
    ...jsonBody(payload),
  });
}

export async function completeSetup() {
  return jsonFetch('/api/setup/complete', { method: 'POST' });
}

// ─── Invite / Session Sharing ─────────────

export async function fetchInviteStatus() {
  return jsonFetch('/api/invite/status');
}

export async function generateInviteKey(custom) {
  const body = custom ? { custom } : {};
  return jsonFetch('/api/invite/key', {
    method: 'POST',
    ...jsonBody(body),
  });
}

export async function revokeInviteKey() {
  return jsonFetch('/api/invite/key', { method: 'DELETE' });
}

export async function revokeAllInviteSessions() {
  return jsonFetch('/api/invite/sessions', { method: 'DELETE' });
}

export async function saveInviteProxy(config) {
  return jsonFetch('/api/invite/proxy', {
    method: 'PUT',
    ...jsonBody(config),
  });
}

export async function fetchInvitePermissions() {
  return jsonFetch('/api/invite/permissions');
}

export async function saveInvitePermissions(perms) {
  return jsonFetch('/api/invite/permissions', {
    method: 'PUT',
    ...jsonBody(perms),
  });
}

// ── Loop Templates ──

export async function fetchLoopTemplates() {
  return jsonFetch('/api/loop/templates');
}

export async function createLoopTemplate(payload) {
  return jsonFetch('/api/loop/templates', {
    method: 'POST',
    ...jsonBody(payload),
  });
}

export async function updateLoopTemplate(id, payload) {
  return jsonFetch(`/api/loop/templates/${id}`, {
    method: 'PUT',
    ...jsonBody(payload),
  });
}

export async function deleteLoopTemplate(id) {
  return jsonFetch(`/api/loop/templates/${id}`, { method: 'DELETE' });
}

export async function importLoopTemplates(data) {
  return jsonFetch('/api/loop/templates/import', {
    method: 'POST',
    ...jsonBody(data),
  });
}

export async function fetchActiveLoop() {
  return jsonFetch('/api/loop/active');
}

export async function launchLoop(params) {
  return jsonFetch('/api/loop/launch', {
    method: 'POST',
    ...jsonBody(params),
  });
}

export async function stopLoop() {
  return jsonFetch('/api/loop/stop', { method: 'POST' });
}

export async function fetchLoopHistory(limit = 50) {
  return jsonFetch(`/api/loop/history?limit=${limit}`);
}

export async function deleteLoopHistory(id) {
  return jsonFetch(`/api/loop/history/${id}`, { method: 'DELETE' });
}

export async function storeLoopCompletion(data) {
  return jsonFetch('/api/loop/complete', {
    method: 'POST',
    ...jsonBody(data),
  });
}

export async function searchMemoriesByCategory(query, category, limit = 15) {
  return jsonFetch('/api/search/memories', {
    method: 'POST',
    ...jsonBody({ query, category, limit }),
  });
}

// ── Loop Schedules ──

export async function fetchSchedules() {
  return jsonFetch('/api/schedules');
}

export async function createSchedule(params) {
  return jsonFetch('/api/schedules', {
    method: 'POST',
    ...jsonBody(params),
  });
}

export async function fetchSchedule(id) {
  return jsonFetch(`/api/schedules/${encodeURIComponent(id)}`);
}

export async function updateSchedule(id, params) {
  return jsonFetch(`/api/schedules/${encodeURIComponent(id)}`, {
    method: 'PUT',
    ...jsonBody(params),
  });
}

export async function deleteSchedule(id) {
  return jsonFetch(`/api/schedules/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function testSchedule(id) {
  return jsonFetch(`/api/schedules/${encodeURIComponent(id)}/test`, {
    method: 'POST',
  });
}

export async function startScheduleTimer(id, minutes) {
  return jsonFetch(`/api/schedules/${encodeURIComponent(id)}/timer`, {
    method: 'POST',
    ...jsonBody({ minutes }),
  });
}

export async function cancelScheduleTimer(id) {
  return jsonFetch(`/api/schedules/${encodeURIComponent(id)}/timer`, {
    method: 'DELETE',
  });
}

export async function fetchScheduleTimers() {
  return jsonFetch('/api/schedules/timers');
}

// ── Quick Timers ──

export async function createQuickTimer(templateId, minutes, { profile, model, usesBrowser } = {}) {
  return jsonFetch('/api/quick-timer', {
    method: 'POST',
    ...jsonBody({ templateId, minutes, profile, model, usesBrowser }),
  });
}

export async function fetchQuickTimers() {
  return jsonFetch('/api/quick-timers');
}

export async function cancelQuickTimer(id) {
  return jsonFetch(`/api/quick-timers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

// ── Isolated Agents ──

export async function launchAgent(params) {
  return jsonFetch('/api/agents/launch', {
    method: 'POST',
    ...jsonBody(params),
  });
}

export async function fetchAgents() {
  return jsonFetch('/api/agents');
}

export async function fetchAgent(id) {
  return jsonFetch(`/api/agents/${id}`);
}

export async function stopAgent(id) {
  return jsonFetch(`/api/agents/${id}/stop`, { method: 'POST' });
}

export async function removeAgent(id) {
  return jsonFetch(`/api/agents/${id}`, { method: 'DELETE' });
}

// ─── Image Gallery ──────────────────────

export async function fetchImages() {
  return jsonFetch('/api/images');
}

export async function toggleImageFavorite(filename, favorite) {
  return jsonFetch('/api/images/favorite', {
    method: 'POST',
    ...jsonBody({ filename, favorite }),
  });
}

export async function deleteImage(filename) {
  return jsonFetch(`/api/images/${encodeURIComponent(filename)}`, { method: 'DELETE' });
}
