import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The Claude sidepanel's side of the session-lifecycle fix: reconnects reclaim the
// server session, turns the CLI starts itself show as running, background agents
// stay visible, and closing a tab ends its session. Source contracts, in the same
// style as session-title.test.mjs — the panel is a browser module.

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const [panel, agents, statusline, assistantPanel] = await Promise.all([
  read('../public/shared/ui-claude-panel.js'),
  read('../public/shared/cp/cp-agents.js'),
  read('../public/shared/cp/cp-statusline.js'),
  read('../public/shared/assistant/asst-panel.js'),
]);

// Source of one top-level function: from its signature to the next top-level one.
function fnBody(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const rest = src.slice(start + signature.length);
  const next = rest.search(/\n(?:async )?function /);
  return next >= 0 ? rest.slice(0, next) : rest;
}

test('a reconnecting tab always tries to reclaim its server session', () => {
  const body = fnBody(panel, 'function connectTab(tab) {');
  assert.match(body, /type: 'reattach'/);
  assert.doesNotMatch(body, /tab\._wasRunning && tab\.sessionId/, 'reattach is not limited to page reloads any more');
  assert.match(body, /if \(tab\.running\) tab\._wasRunning = true;/, 'a drop mid-turn is remembered for the reattach');
  assert.match(body, /if \(tab\.ws !== ws\) return;/, 'a dead socket cannot act on its replacement');
});

test('regaining focus reconnects instead of declaring the session lost', () => {
  assert.doesNotMatch(panel, /tab running but WS dead/);
  assert.doesNotMatch(panel, /Connection lost — session recovered\./);
});

test('a failed reattach only finishes a tab that was mid-turn', () => {
  const body = fnBody(panel, 'function _processTabMsg(tab, msg) {');
  assert.match(body, /if \(expectRunning && !\(tab\.sendStartedAt > tab\._reattachSentAt\)\)/);
  assert.match(body, /_setBackgroundWork\(tab, msg\.backgroundTasks\)/);
});

test('the panel shows turns the CLI starts on its own', () => {
  assert.match(fnBody(panel, 'function _processTabMsg(tab, msg) {'), /case 'turn_started':/);
  assert.match(assistantPanel, /case 'turn_started':/);
});

test('background agents stay open until they report back', () => {
  const body = fnBody(panel, 'function handleTabEvent(tab, ev) {');
  assert.match(body, /ev\.subtype === 'background' && ev\.tool_use_id/);
  assert.match(body, /markAgentBackground\(tab, ev\.tool_use_id\)/);
  assert.match(body, /force: true/);
  assert.match(body, /ev\.subtype === 'background_tasks_changed'/);
  assert.match(agents, /export function markAgentBackground\(tab, toolUseId\)/);
  assert.match(agents, /if \(entry\.background && !force\) return true;/);
  assert.match(statusline, /id="cp-sl-bg"/);
  assert.match(statusline, /tab\.backgroundWork/);
});

test('closing a tab ends its server session', () => {
  const body = fnBody(panel, 'function closeTab(idx');
  assert.match(body, /type: 'dispose'/);
  assert.match(body, /\/api\/sidepanel\/kill-session/, 'falls back to the kill endpoint when the socket is down');
});

test('New chat opens a new tab while background work is running', () => {
  const body = fnBody(panel, 'async function selectSession(sid, label) {');
  assert.match(body, /if \(tab\.running \|\| tab\.backgroundWork\?\.length\)/);
});

test('re-sent permission requests do not duplicate an open card', () => {
  const body = fnBody(panel, 'function handleControlRequest(tab, msg) {');
  assert.match(body, /\.active-perm\[data-request-id=/);
  assert.match(body, /tab\._permQueue\.some\(p => p\.requestId === requestId\)/);
});
