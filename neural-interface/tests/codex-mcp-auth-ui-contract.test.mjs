import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (relative) => readFileSync(resolve(root, relative), 'utf8');

test('Codex MCP OAuth returns an authorization URL through the existing response envelope', () => {
  const server = read('server.js');
  const transport = read('public/shared/cdx/cdx-ws.js');

  assert.match(server, /request\('mcpServer\/oauth\/login', \{ name: msg\.name \}, 30000\)/);
  assert.match(server, /type: 'mcp_oauth_done',[\s\S]*?authorizationUrl,/);
  assert.match(server, /Codex did not return an authorization URL/);
  assert.match(transport, /case 'mcp_oauth_done':/);
});

test('MCP auth starts from a click-owned browser tab and waits for native completion', () => {
  const tabs = read('public/shared/cdx/cdx-tabs.js');
  const start = tabs.indexOf('async function startMcpOAuthLogin');
  const end = tabs.indexOf('async function refreshMcpAfterAuthentication', start);
  const flow = tabs.slice(start, end);

  assert.ok(start >= 0 && end > start, 'OAuth helper should be present');
  assert.ok(
    flow.indexOf('openMcpAuthenticationWindow()') < flow.indexOf("requestSocketPayloadForTab(tab, 'mcp_oauth_login'"),
    'the blank authorization tab must open synchronously before awaiting the RPC',
  );
  assert.match(flow, /normalizeMcpAuthorizationUrl\(result\)/);
  assert.match(flow, /authWindow\.location\.replace\(authorizationUrl\)/);
  assert.match(flow, /setMcpAuthenticationUi\(serverName, 'waiting'/);

  assert.match(tabs, /case 'mcpServer\/oauthLogin\/completed':[\s\S]*?refreshMcpAfterAuthentication/);
  assert.match(tabs, /requestSocketPayloadForTab\(tab, 'mcp_refresh'/);
  assert.match(tabs, /requestSocketPayloadForTab\(tab, 'mcp_status'/);
});

test('startup failures use one actionable per-server notice without error-text auth heuristics', () => {
  const tabs = read('public/shared/cdx/cdx-tabs.js');
  const render = read('public/shared/cdx/cdx-render.js');
  const protocol = read('public/shared/cdx/cdx-protocol.js');

  assert.match(tabs, /case 'mcpServer\/startupStatus\/updated':[\s\S]*?upsertMcpStartupNotice\(\{/);
  assert.match(tabs, /isCodexMcpAuthenticationRequired\(params, server\)/);
  assert.match(render, /findMcpStartupNotice\(name\)/);
  assert.match(render, /node\.dataset\.mcpServer === serverName/);
  assert.match(render, /className = 'cxp-system cxp-mcp-startup-notice error'/);
  assert.match(render, /className = 'cxp-mcp-startup-auth'/);
  assert.match(render, /sanitizeStoredTranscriptDom[\s\S]*?\.cxp-mcp-startup-notice/);

  const helperStart = protocol.indexOf('export function isCodexMcpAuthenticationRequired');
  const helperEnd = protocol.indexOf('\n}', helperStart);
  const helper = protocol.slice(helperStart, helperEnd);
  assert.doesNotMatch(helper, /error|handshake|handshaking|transport/i);
});

test('system notices wrap hostile tokens and the transcript cannot scroll horizontally', () => {
  const styles = read('public/shared/cdx/cdx-styles.js');

  assert.match(styles, /\.cxp-messages \{[\s\S]*?overflow-x: hidden;[\s\S]*?overflow-y: auto;/);
  assert.match(styles, /\.cxp-system \{[\s\S]*?max-width: calc\(100% - 32px\);/);
  assert.match(styles, /\.cxp-system \{[\s\S]*?overflow-wrap: anywhere;/);
  assert.match(styles, /\.cxp-system \{[\s\S]*?word-break: break-word;/);
  assert.match(styles, /\.cxp-mcp-startup-error \{[\s\S]*?white-space: pre-wrap;/);
  assert.match(styles, /@media \(max-width: 390px\)[\s\S]*?\.cxp-mcp-startup-actions/);
});
