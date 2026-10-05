// Source contract for the terminal isolation: the Neural Interface server must
// never own a PTY or a terminal WebSocket again — those live in lib/pty-host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

test('server.js spawns no PTYs and imports no node-pty', () => {
  assert.ok(!/\bpty\.spawn\(/.test(server), 'pty.spawn( must live in lib/pty-host/core.js');
  assert.ok(!/import\(['"]node-pty['"]\)/.test(server), 'node-pty is loaded by the terminal host');
  assert.ok(server.includes("import { createPtyHostManager } from './lib/pty-host/manager.js';"));
  assert.ok(server.includes('function createTerminalSession(profile, cols, rows, cwd, opts = {}) {'),
    'createTerminalSession keeps its synchronous signature (loops and contract tests call it)');
});

test('terminal upgrades are handed to the pty-host after the auth checks and before the generic WebSocket router', () => {
  const start = server.indexOf("httpServer.on('upgrade', (req, socket, head) => {");
  assert.ok(start > 0);
  const handler = server.slice(start, server.indexOf("wss.on('connection'", start));
  const guestCheck = handler.indexOf("url.pathname.startsWith('/ws/terminal/') && !invitePermissions.terminal");
  const handoff = handler.indexOf('terminalHost.handoffUpgrade(req, socket, head, sessionId)');
  const generic = handler.indexOf('wss.handleUpgrade(req, socket, head');
  assert.ok(guestCheck > 0 && handoff > guestCheck, 'guest/invite checks run before the handoff');
  assert.ok(generic > handoff, 'terminal sockets never reach the in-process WebSocket server');
  assert.ok(!server.includes("url.pathname.replace('/ws/terminal/', '')"), 'no in-process terminal WebSocket route remains');
});

test('main-side consumers are wired through the host: tap, spawn wait, shutdown, diagnostics, gated memory timers', () => {
  assert.equal((server.match(/terminalHost\.setTap\([^)]*true\)/g) || []).length, 3, 'loop driver, exec loop driver, live link capture');
  assert.ok(server.includes('terminalHost.whenSpawned(sessionId),'), 'POST /api/terminal/sessions surfaces spawn failures');
  assert.ok(server.includes('await terminalHost.shutdown({ timeoutMs: 1500 });'), 'graceful shutdown hangs up PTYs');
  assert.ok(server.includes('terminalHost.killNow();'), 'the exit handler never leaves the host behind');
  assert.ok(server.includes("app.get('/api/diagnostics/event-loop'"));
  assert.ok(server.includes("'/api/diagnostics',"), 'diagnostics are admin-only');
  assert.ok(server.includes('startGatedMemoryMaintenance();'));
  assert.ok(!/\bstartMemoryMaintenance\(\)/.test(server), 'the ungated 2 s maintenance timer is gone');
});
