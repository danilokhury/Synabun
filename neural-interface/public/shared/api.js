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

export async function fetchMemories() {
  const res = await fetch('/api/memories');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
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
  // payload: { openaiApiKey?, qdrantUrl?, qdrantApiKey? }
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

export async function dockerNewConnection(payload) {
  // payload: { port, grpcPort, apiKey, containerName, volumeName }
  return jsonFetch('/api/connections/docker-new', {
    method: 'POST',
    ...jsonBody(payload),
  });
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

// ─── Terminal ────────────────────────────

export async function fetchTerminalSessions() {
  return jsonFetch('/api/terminal/sessions');
}

export async function createTerminalSession(profile, cols, rows, cwd) {
  return jsonFetch('/api/terminal/sessions', {
    method: 'POST',
    ...jsonBody({ profile, cols, rows, cwd }),
  });
}

export async function deleteTerminalSession(sessionId) {
  return jsonFetch(`/api/terminal/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
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

export async function startDockerDesktop() {
  return jsonFetch('/api/setup/start-docker-desktop', { method: 'POST' });
}

export async function setupDocker(payload) {
  return jsonFetch('/api/setup/docker', {
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

export async function testQdrant() {
  return jsonFetch('/api/setup/test-qdrant');
}

export async function testQdrantCloud(payload) {
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
