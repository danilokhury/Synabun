import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

test('OpenCode sidepanel profiles are pinned to dedicated session serves', () => {
  const server = read('neural-interface/server.js');
  const isolation = server.slice(
    server.indexOf('const _ocpIsoServes'),
    server.indexOf('function handleOpencodeV2Ws'),
  );
  assert.match(isolation, /const _ocpSessionProfiles = new Map\(\)/);
  assert.match(isolation, /const _ocpSessionServeStarts = new Map\(\)/);
  assert.match(isolation, /const _ocpActiveSessionTurns = new Map\(\)/);
  assert.match(isolation, /buildManagedOpenCodeSynabunEntry\(existing/);
  assert.match(isolation, /SYNABUN_PROFILE: resolvedProfile/);
  assert.match(isolation, /SYNABUN_RUNTIME_PROFILE_PATH: runtimeProfilePath/);
  assert.match(isolation, /XDG_CONFIG_HOME: xdgRoot,\s+SYNABUN_PROFILE: requestedProfile/);
  assert.match(isolation, /OPENCODE_CONFIG_CONTENT: buildOpencodeRuntimeConfigOverlay/);
  assert.match(isolation, /delete isolatedEnv\.CLAUDECODE/);
  assert.match(isolation, /async function turnClientForSession\(sessionId, requestedProfile = null\)/);
  assert.match(isolation, /const pending = _ocpSessionServeStarts\.get\(sessionId\)/);
  assert.match(isolation, /const pendingEntry = await pending\.promise/);
  assert.match(isolation, /const hasActiveTurn = \[\.\.\.entry\.sessions\]\.some/);
  assert.match(isolation, /if \(startingForSession \|\| hasActiveTurn\)/);
  assert.doesNotMatch(isolation, /return opencodeV2Client;\s*\/\/.*fall/i);
  assert.doesNotMatch(isolation, /opencodePerTabIsolation/);
  assert.match(isolation, /async function restartOpenCodeSessionProfile/);
  assert.match(server, /case 'mcp:profile:set'/);
  assert.match(server, /data: \{ profile, pinned, defaultProfile:/);
  assert.match(server, /entry\?\.sessions\?\.size \? entry\.sessions : new Set\(\[msg\.sessionId\]\)/);
  assert.match(server, /sendAborts\.has\(sessionId\)/);
  assert.match(server, /_ocpActiveSessionTurns\.has\(sessionId\)/);
  assert.match(server, /_ocpSessionServeStarts\.has\(sessionId\)/);
  assert.match(server, /asyncTurnAccepted = useAsync && r\.status >= 200 && r\.status < 300/);
  assert.match(server, /_ocpActiveSessionTurns\.get\(sid\) === activeTurnToken/);
  assert.match(server, /app\.post\('\/api\/mcp\/runtime-profile'/);
  assert.match(server, /req\.get\('X-Synabun-Terminal'\)/);
  assert.match(server, /updateOpencodeRuntimeProfileConfig\(entry\.xdgRoot, profile\)/);
  assert.match(server, /_ocpSessionProfiles\.set\(sessionId, profile\)/);
  assert.match(server, /eventType: 'mcp\.profile\.changed'/);
  assert.match(server, /_ocpSessionProfiles\.set\(providerSessionId, state\.mcpProfile \|\| entry\.mcpProfile\)/);
  assert.match(server, /turnClientForSession\(msg\.sessionId, msg\.mcpProfile\)/);
  assert.doesNotMatch(server, /startMcpProfileWatchers\(\)/);
});

test('Codex sidepanel profile is a per-WebSocket app-server override', () => {
  const server = read('neural-interface/server.js');
  const handler = server.slice(
    server.indexOf('function handleCodexSkinWebSocket'),
    server.indexOf('let _codexModelListCache'),
  );
  assert.match(handler, /let activeMcpProfile = normalizeMcpProfileName\(readActiveMcpProfile\(\)\)/);
  assert.match(handler, /mcp_servers\.SynaBun\.env\.SYNABUN_PROFILE=/);
  assert.match(handler, /async function switchCodexMcpProfile/);
  assert.match(handler, /if \(activeTurnId \|\| pendingServerRequests\.size\)/);
  assert.match(handler, /msg\.type === 'mcp_profile_set'/);
  assert.match(handler, /mcpProfile: activeMcpProfile/);
});

test('sidepanel selectors keep active-session state separate from the shared default', () => {
  const opencode = read('neural-interface/public/shared/ocp-v2/ocp-v2-projectbar.js');
  assert.match(opencode, /savedSessionProfile\(sessionId\)/);
  assert.match(opencode, /api\.mcpProfileSet\(state\.sessionId, profile\)/);
  assert.match(opencode, /api\.mcpProfileGet\(sessionId\)/);
  assert.match(opencode, /if \(!remote\?\.pinned \|\| !remote\.profile\) return/);
  assert.doesNotMatch(opencode, /api\/opencode\/mcp/);
  assert.match(opencode, /getState\(\)\.sessionId \? null : _defaultProfile/);
  assert.match(opencode, /event\?\.type === 'config:mcp-profile'/);
  assert.match(opencode, /result\?\.error \|\| result\?\.ok === false/);
  const updateProfile = opencode.slice(
    opencode.indexOf('async function updateMcpProfile'),
    opencode.indexOf('// ── Recall dropdown wiring'),
  );
  assert.ok(
    updateProfile.indexOf('return;') < updateProfile.indexOf("fetch('/api/mcp/profile'"),
    'an active-session switch returns before the explicit future-default endpoint',
  );

  const opencodeWs = read('neural-interface/public/shared/ocp-v2/ocp-v2-ws.js');
  assert.match(opencodeWs, /case 'mcp\.profile\.changed':/);
  assert.match(opencodeWs, /store\.setMcpProfile\(ev\.profile \|\| null\)/);

  const codex = read('neural-interface/public/shared/cdx/cdx-panel.js');
  assert.match(codex, /requestSocketPayload\('mcp_profile_set'/);
  assert.match(codex, /activeTab\(\)\?\.mcpProfile \|\| _defaultMcpProfile/);
  assert.match(codex, /tab\.mcpProfile = effective/);
  assert.match(codex, /activeTabChanged: \(tab\) =>/);
  const codexSwitch = codex.slice(codex.indexOf('async function updateMcpProfile'), codex.indexOf('// ═══════════════════════════════════════════\n//  Recall Profile'));
  assert.doesNotMatch(codexSwitch, /fetch\('\/api\/mcp\/profile'/);
  const codexTabs = read('neural-interface/public/shared/cdx/cdx-tabs.js');
  assert.match(codexTabs, /_onActiveTabChanged\?\.\(tab\)/);

  const sessions = read('neural-interface/public/shared/ui-sessions.js');
  assert.match(sessions, /from '\.\/ui-opencode-panel-v2\.js'/);
  assert.doesNotMatch(sessions, /from '\.\/ocp\/ocp-panel\.js'/);
  const compatibilityBarrel = read('neural-interface/public/shared/ui-opencode-panel.js');
  assert.match(compatibilityBarrel, /from '\.\/ui-opencode-panel-v2\.js'/);
  assert.doesNotMatch(compatibilityBarrel, /from '\.\/ocp\/ocp-panel\.js'/);
});

test('native run descriptors persist runtime-local MCP profile changes', () => {
  const runtime = read('neural-interface/lib/native-loop-runtime.js');
  assert.match(runtime, /mcpProfile: state\.mcpProfile \|\| null/);
  assert.match(runtime, /mcpProfile: record\.mcpProfile \|\| null/);
  assert.match(runtime, /setMcpProfile\(runId, profile\)/);
  assert.match(runtime, /reason: 'mcp-profile'/);
});

test('OpenCode profile routing is permissioned with native tool ids and never mutates the default during launch', () => {
  const server = read('neural-interface/server.js');
  assert.match(server, /'mcp__SynaBun__profile'/);
  assert.match(server, /replace\(\/\^mcp__\(\[\^_\]\+\)__\/, '\$1_'\)/);
  assert.match(server, /ensureOpenCodeCoreMcpPermissions\(baseCfg\)/);
  assert.match(server, /function buildOpencodeRuntimeConfigOverlay/);
  assert.match(server, /buildManagedOpenCodeSynabunEntry/);
  assert.match(server, /mcp: \{ SynaBun: \{ \.\.\.synabun, enabled: true \} \}/);
  assert.match(server, /SYNABUN_RUNTIME_PROFILE_PATH/);
  assert.match(server, /setup FAILED — refusing global config fallback/);
  assert.doesNotMatch(server, /setup FAILED \(falling back to global config\)/);

  const automation = read('neural-interface/public/shared/ui-automation-studio.js');
  const launch = automation.slice(automation.indexOf('async function confirmLaunch'), automation.indexOf('// Loop mode — route based on destination'));
  assert.doesNotMatch(launch, /fetch\('\/api\/mcp\/profile'/);

  const legacy = read('neural-interface/public/shared/ocp/ocp-panel.js');
  const legacySwitch = legacy.slice(legacy.indexOf('async function updateMcpProfile'), legacy.indexOf('// ── Recall Profile'));
  assert.doesNotMatch(legacySwitch, /fetch\('\/api\/mcp\/profile'|fetch\('\/api\/opencode\/mcp'/);
  const upgrade = server.slice(server.indexOf("httpServer.on('upgrade'"), server.indexOf("wss.on('connection'"));
  assert.doesNotMatch(upgrade, /\/ws\/opencode-skin/);
});

test('loop and timer launches validate and capture isolated profiles before spawning', () => {
  const server = read('neural-interface/server.js');
  const manual = server.slice(server.indexOf("app.post('/api/loop/launch'"), server.indexOf("app.post('/api/loop/stop'"));
  const scheduled = server.slice(server.indexOf('async function launchScheduledLoop'), server.indexOf('// Stagger queue'));
  const timers = server.slice(server.indexOf("app.post('/api/quick-timer'"), server.indexOf('// ── Schedule Group REST API'));
  assert.match(manual, /Invalid MCP profile/);
  assert.ok(manual.indexOf('Invalid MCP profile') < manual.indexOf('acquireLoopBrowserAndTab'));
  assert.match(scheduled, /Invalid MCP profile/);
  assert.ok(scheduled.indexOf('Invalid MCP profile') < scheduled.indexOf('acquireLoopBrowserAndTab'));
  assert.match(scheduled, /pendingNativeBrowserCleanup = \{ sessionId: scheduledBrowserSessionId/);
  assert.match(manual, /pendingNativeBrowserCleanup = \{ sessionId: browserSessionId/);
  assert.match(scheduled, /cleanupOpencodeLoopConfig\(scheduledLaunchTerminalId\)/);
  assert.match(timers, /isValidMcpProfileValue\(timerMcpProfile\)/);

  const ws = read('neural-interface/public/shared/ocp-v2/ocp-v2-ws.js');
  const compactButton = read('neural-interface/public/shared/ocp-v2/ocp-v2-compact-button.js');
  const plan = read('neural-interface/public/shared/ocp-v2/ocp-v2-plan.js');
  assert.match(ws, /session:compact', sessionId, cwd, mcpProfile/);
  assert.match(compactButton, /mcpProfile: s\.mcpProfile \|\| undefined/);
  assert.match(plan, /mcpProfile: s\.mcpProfile \|\| undefined/);
});
