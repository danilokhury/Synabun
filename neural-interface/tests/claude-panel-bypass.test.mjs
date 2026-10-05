import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installMiniDom } from './fixtures/mini-dom.mjs';
import { setCpCtx } from '../public/shared/cp/cp-ctx.js';
import { ALL_PERMISSION_MODES, BYPASS_MODE, bypassOffer, isDefaultableMode, modeControl } from '../public/shared/cp/cp-permission-model.js';
import { renderPlanApprovalCard } from '../public/shared/cp/cp-permissions.js';
import { CP_STYLES } from '../public/shared/cp/cp-styles.js';

// The page side of real Bypass: what the mode control offers and says, the plan
// card's bypass choice, and that in the page, too, only what the user picks puts
// a tab in Bypass. The monolith cannot be imported in Node: its wiring is pinned
// in source, the decisions are imported from cp/.

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const panel = read('public/shared/ui-claude-panel.js');
const fnBody = (signature) => {
  const start = panel.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const rest = panel.slice(start + signature.length);
  const next = rest.search(/\n(?:async )?function /);
  return next >= 0 ? rest.slice(0, next) : rest;
};

// ── What the control offers ──

test('Bypass is offered only where it is real and not turned off', () => {
  assert.deepEqual(bypassOffer({ real: true }), { available: true, reason: '', note: '' });
  assert.deepEqual(bypassOffer({ real: true, policy: { available: true, reason: '' } }), { available: true, reason: '', note: '' });

  // A server that was not restarted: choosing it would bypass nothing.
  const old = bypassOffer({ real: false, policy: { available: true } });
  assert.equal(old.available, false);
  assert.match(old.reason, /needs the SynaBun server restart/);
  assert.equal(bypassOffer().available, false, 'nothing known: not offered');

  // The user's settings turn it off: the reason is theirs, said as text.
  const off = bypassOffer({ real: true, policy: { available: false, source: 'user', reason: 'Bypass is turned off by your Claude Code settings (permissions.disableBypassPermissionsMode in /home/me/.claude/settings.json).' } });
  assert.equal(off.available, false);
  assert.match(off.reason, /disableBypassPermissionsMode in \/home\/me/);
  assert.equal(off.note, 'off in your settings');
  assert.equal(bypassOffer({ real: true, policy: { available: false, source: 'root', reason: 'x' } }).note, 'not available as root');
  assert.match(bypassOffer({ real: true, policy: { available: false } }).reason, /turned off by your Claude Code settings/, 'a verdict without a sentence still gets one');
  assert.equal(bypassOffer({ real: true, policy: { available: false, reason: '\u001b[31mred\u001b[0m' } }).reason, 'red', 'terminal escapes do not reach the page');
});

test('Bypass is a choice for one tab: never the default for new tabs', () => {
  assert.equal(isDefaultableMode(BYPASS_MODE), false);
  assert.deepEqual(ALL_PERMISSION_MODES.filter(isDefaultableMode), ['default', 'acceptEdits']);
  // A new tab reads the stored default through the same rule, so a value an
  // older build stored (Bypass, Plan) starts it in Default, with no mode chosen.
  assert.match(panel, /permissionMode: \(\(mode\) => \(isDefaultableMode\(mode\) \? mode : 'default'\)\)\(storage\.getItem\(STOR\.permissionMode\)\),/);
  assert.match(panel, /modeChosen: isDefaultableMode\(storage\.getItem\(STOR\.permissionMode\)\),/);
  assert.match(fnBody('function setPermissionModeUI(tab, mode, { announce = true } = {}) {'), /if \(isDefaultableMode\(mode\)\) storage\.setItem\(STOR\.permissionMode, mode\);/);
  assert.equal((panel.match(/storage\.setItem\(STOR\.permissionMode/g) || []).length, 1, 'the one place a default is stored');
});

// ── What the control says ──

test('the control says when tools run without asking: a tab in Bypass, or Auto-approve on', () => {
  assert.deepEqual(modeControl({ mode: 'default' }), { text: 'Default', keep: 'Default', state: '', title: '' });
  assert.deepEqual(modeControl({ mode: 'plan' }), { text: 'Plan', keep: 'Plan', state: '', title: '' });

  const bypass = modeControl({ mode: BYPASS_MODE });
  assert.equal(bypass.text, 'Bypass');
  assert.equal(bypass.state, 'bypass');
  assert.match(bypass.title, /every tool runs without asking in this tab/);

  // The live test: the toggle was on, every tool ran, and the control said "Default".
  const auto = modeControl({ mode: 'default', autoApprove: true });
  assert.equal(auto.text, 'Default · auto-approve');
  assert.equal(auto.state, 'autoapprove');
  assert.match(auto.title, /Auto-approve is on: permission requests are answered Allow without a card, in every tab/);
  for (const mode of ['acceptEdits', 'plan', 'dontAsk', 'auto']) {
    const shown = modeControl({ mode, autoApprove: true });
    assert.equal(shown.state, 'autoapprove', mode);
    assert.ok(shown.text.endsWith(' · auto-approve'), mode);
  }
  // Bypass says Bypass, with or without the toggle, and against any server:
  // the warning is never the thing left out.
  assert.equal(modeControl({ mode: BYPASS_MODE, autoApprove: true }).state, 'bypass');
  assert.equal(modeControl({ mode: BYPASS_MODE, autoApprove: true }).text, 'Bypass');
  assert.deepEqual(modeControl(), { text: 'Default', keep: 'Default', state: '', title: '' });
});

test('the dropdown shows that state in the control\'s own warning style', () => {
  const body = fnBody('function populateModeDropdown($dd, tab) {');
  // The control is told the tab's pick, or that it follows the settings, and whether its session may still be in Bypass.
  assert.match(body, /const facts = controlFacts\(tab, \{ settingsPick: hasCapability\(tab, 'permission_modes_v2'\), \.\.\._modeBridge\(tab\) \}\);/);
  assert.match(body, /const shown = modeControl\(\{ \.\.\.facts, autoApprove: _autoAcceptAll \}\);/);
  assert.match(body, /label\.textContent = shown\.text;/);
  assert.match(body, /\$dd\.dataset\.tooltip = modeTooltip\(shown, \{ fallback: MODE_CONTROL_TOOLTIP, note: settingsModeNote\(facts, _settingsAsk\(tab\)\) \}\);/);
  assert.match(body, /\$dd\.classList\.toggle\('cp-mode-unasked', shown\.state === 'bypass' \|\| shown\.state === 'autoapprove'\);/);
  // One colour for it: the one the Bypass label already had.
  assert.match(CP_STYLES, /#cp-mode\.cp-mode-bypassPermissions \.cp-dd-label \{ color: #ef7070; \}/);
  assert.match(CP_STYLES, /#cp-mode\.cp-mode-unasked \.cp-dd-label \{ color: #ef7070; font-weight: 600; \}/);
  assert.match(CP_STYLES, /#cp-mode\.cp-mode-unasked \{ border-color: rgba\(239,112,112,0\.55\); background: rgba\(239,112,112,0\.08\); \}/);
  // Bypass that cannot be taken is listed with its reason and does nothing.
  assert.match(body, /const blocked = m === BYPASS_MODE && !bypass\.available;/);
  assert.match(body, /el\.classList\.add\('cp-dd-disabled'\);/);
  assert.match(body, /el\.title = bypass\.reason;/);
  assert.match(body, /note\.textContent = bypass\.note;/, 'set as text');
  assert.match(body, /if \(blocked\) \{ appendWarn\(t, bypass\.reason\); return; \}/);
});

// ── Only the user's choice ──

test('every way the page sets a mode: Bypass comes from the mode control, the plan card, the saved tab or the session', () => {
  const setter = fnBody('function setPermissionModeUI(tab, mode, { announce = true } = {}) {');
  // The one function the controls go through refuses a Bypass that cannot be taken.
  assert.match(setter, /if \(mode === BYPASS_MODE\) \{\n    const offer = _bypassOffer\(tab\);\n    if \(!offer\.available\) \{\n      appendWarn\(tab, offer\.reason\);/);
  assert.ok(setter.indexOf('if (!offer.available)') >= 0 && setter.indexOf('if (!offer.available)') < setter.indexOf('pickMode(tab, mode);'), 'refused before the tab changes');

  // Its callers: the dropdown (any mode), Shift+Tab (never Bypass), and Plan from the plan toggle, /plan and
  // the "re-output the plan" button. Switching plan mode off is not a pick: it goes back (_leavePlanUI).
  const calls = [...panel.matchAll(/setPermissionModeUI\(([^)]*)\)/g)].map(m => m[1]).filter(args => !args.startsWith('tab, mode, {'));
  assert.deepEqual(calls.sort(), ['t, m', "tab, next", "tab, 'plan', { announce: false }", "tab, 'plan', { announce: false }", "tab, 'plan', { announce: false }"].sort());
  assert.equal((panel.match(/if \(tab\.planMode\) _leavePlanUI\(tab, \{ announce: false \}\); else setPermissionModeUI\(tab, 'plan', \{ announce: false \}\);/g) || []).length, 2, 'the plan toggle and /plan');
  assert.match(panel, /const cycle = \['default', 'acceptEdits', 'plan'\];\n      const next = cycle\[/, 'Shift+Tab never reaches Bypass');

  // Every write of a tab's mode in the page is a function of cp-permission-model.js,
  // named for where the value comes from (tests/claude-panel-mode-ownership.test.mjs
  // pins what each may do). The monolith assigns no mode itself.
  const writes = [...panel.matchAll(/\b(pickMode|leavePlanMode|sessionMode|sessionReport|sessionEnteredPlan|restoredMode)\(([^()\n]+)\)/g)].map(m => `${m[1]}(${m[2]})`);
  assert.deepEqual(writes.sort(), [
    "restoredMode(saved, { permissionMode: t.permissionMode, modeChosen: t.modeChosen })", // a restored tab: Bypass only with the record of the user's pick
    "sessionReport(tab, numbered && typeof mode !== 'string' ? '' : mode, from, { seq: carrier?.modeSeq, numbered, mayBypass: carrier?.mayBypass, switching: carrier?.switching, failed: carrier?.failed, rev: carrier?.modeRev, revOf: carrier?.modeRevOf })", // every report of the tab's session, in one place (_sessionSaysMode)
    'sessionEnteredPlan(tab)',                        // the tab's own session called EnterPlanMode (a bridge that does not number)
    'leavePlanMode(tab)',                             // the plan toggle, /plan, the post-plan card (_leavePlanUI): back to what the tab was
    'leavePlanMode(tab)',                             // the post-plan card answering a pending approval (_approvePendingPlan)
    'pickMode(tab, mode)',                            // setPermissionModeUI
    "pickMode(tab, mode === 'acceptEdits' || mode === BYPASS_MODE ? mode : 'default')", // the plan card's choice (_planApproved)
  ].sort());
  assert.equal((panel.match(/permissionMode = /g) || []).length, 0, 'no assignment of a mode outside those functions');
  assert.doesNotMatch(panel, /bypassChosen = |modeChosen = /, 'and none of the record of a pick');
  assert.doesNotMatch(panel, /\.planMode = |planFrom = |modeSeq = |\.modeSeq\+\+|actualMode = /, 'nor of plan mode, the statement number or what the session reported');
  // The one other place a mode is written is the query that states the tab's own.
  assert.deepEqual([...panel.matchAll(/Object\.assign\(msg, (statedMode\([^\n]+\))\);/g)].map(m => m[1]), ["statedMode(tab, { settingsPick: hasCapability(tab, 'permission_modes_v2'), ..._modeBridge(tab) })"]);
  assert.doesNotMatch(panel, /msg\.permissionMode = |msg\.modeFromSettings = /);
  // Nothing derives a mode from text a model, a tool or a page wrote.
  assert.doesNotMatch(panel, /(?:pickMode|sessionMode|sessionReport)\([^;\n]*(textContent|innerHTML|innerText|dataset|\.value\b)/);
});

test('the Auto-approve toggle answers cards and switches no mode', () => {
  const start = panel.indexOf("const $auto = _panel.querySelector('#cp-auto-toggle');");
  assert.ok(start > 0);
  const block = panel.slice(start, panel.indexOf('// Permission mode lives in the project-bar dropdown', start));
  assert.doesNotMatch(block, /setPermissionModeUI|bypassPermissions|BYPASS_MODE|STOR\.permissionMode|set_permission_mode/);
  assert.match(block, /_autoAcceptAll = storage\.getItem\(STOR\.autoAccept\) === 'true';/, 'what it stores is what it stored');
  assert.match(block, /storage\.setItem\(STOR\.autoAccept, _autoAcceptAll\);/);
  assert.match(block, /populateModeDropdown\(_panel\?\.querySelector\('#cp-mode'\), tab\);/, 'the mode control follows the toggle');
  // What it does is what it did: a permission request is answered Allow on the page.
  const control = fnBody('function handleControlRequest(tab, msg) {');
  assert.match(control, /if \(_autoAcceptAll\) \{\n      sendPermissionResponse\(tab, requestId, 'allow'\);\n      return;\n    \}/);
  // Questions, plan approvals and elicitations are decided before it and still shown.
  for (const earlier of ["if (req.subtype === 'elicitation') {", "if (toolName === 'AskUserQuestion') {", "if (toolName === 'ExitPlanMode') {"]) {
    assert.ok(control.indexOf(earlier) >= 0 && control.indexOf(earlier) < control.indexOf('if (_autoAcceptAll) {'), earlier);
  }
  assert.match(fnBody('function runSlashCommand(tab, raw) {'), /if \(_autoAcceptAll\) html \+= row\('Auto-approve', /, '/permissions says so too');
});

test('a switch that was refused or undone is shown with its reason', () => {
  const start = panel.indexOf("if (ev.type === 'mode_changed') {");
  const handler = panel.slice(start, panel.indexOf("if (ev.type === 'subagent') {", start));
  // The report goes through the one place that judges it (a stale one, or a Bypass that is not the tab's, is not taken and says nothing).
  assert.match(handler, /const verdict = _sessionSaysMode\(tab, ev\.mode, 'mode_changed', ev\);\n    if \(verdict\.taken && ev\.mode\) \{/);
  assert.match(handler, /if \(ev\.reason\) appendWarn\(tab, `\$\{String\(ev\.reason\)\} This tab is in \$\{MODE_LABELS\[said\] \|\| said\}\.`\);/);
  assert.match(handler, /else if \(said === BYPASS_MODE\) appendWarn\(tab, 'Permission mode: Bypass\./);
  // The control is repainted for every report, taken or not: what the session said may be a Bypass to warn of.
  assert.match(fnBody('function _sessionSaysMode(tab, mode, from, carrier) {'), /\n  _paintMode\(tab\);\n/);
  assert.match(fnBody('function _paintMode(tab) {'), /populateModeDropdown\(_panel\?\.querySelector\('#cp-mode'\), tab\);/);
});

test('the server is asked whether Bypass is turned off, only where it answers', () => {
  const refresh = fnBody('function _refreshBypassPolicy(tab) {');
  assert.match(refresh, /if \(!tab \|\| !hasCapability\(tab, 'bypass_policy'\)\) return;/);
  assert.match(refresh, /fetch\(`\/api\/claude-code\/bypass-policy\?\$\{query\}`/);
  assert.match(refresh, /new URLSearchParams\(\)/, 'the project and the account are encoded');
  // No answer claims nothing: the option stays offered and Claude Code decides.
  assert.match(refresh, /\.catch\(\(\) => \{ _bypassPolicies\.set\(key, \{ available: true, /);
  assert.match(fnBody('function _bypassOffer(tab) {'), /bypassOffer\(\{ real: _modeBridge\(tab\)\.bypass, policy: /);
});

// ── The plan card ──

function setup() {
  const dom = installMiniDom();
  const tab = { id: 't', messagesEl: dom.container('cp-messages') };
  setCpCtx({ esc: String, md: (t) => `<p>${t}</p>`, scrollEnd: () => {}, activeTab: () => tab, toolIconSvg: () => '<svg/>', emit: () => {} });
  const sent = [];
  return { dom, tab, sent, hooks: (extra = {}) => ({ sendResponse: (rid, inner) => sent.push([rid, inner]), ...extra }) };
}
const button = (card, text) => card.querySelectorAll('button').find(b => b.textContent === text);
const REQ = { tool_name: 'ExitPlanMode', input: { plan: '1. Do it' } };

test('the plan card offers the bypass choice the CLI offers, where the tab can take it', () => {
  const { dom, tab, sent, hooks } = setup();
  try {
    const approved = [];
    const card = renderPlanApprovalCard(tab, 'plan-1', REQ, hooks({ bypass: { available: true }, onApproved: (mode) => approved.push(mode) }));
    assert.deepEqual(card.querySelectorAll('button').map(b => b.textContent).slice(0, 4), ['Approve & auto-accept edits', 'Approve', 'Approve & bypass permissions', 'Keep planning']);
    const bypass = button(card, 'Approve & bypass permissions');
    assert.ok(bypass.className.includes('cp-plan-btn-bypass'));
    bypass.click();
    assert.deepEqual(sent, [['plan-1', { behavior: 'allow', planDecision: 'bypassPermissions' }]]);
    assert.deepEqual(approved, ['bypassPermissions']);
    assert.equal(card.querySelector('.perm-status').textContent, 'Approved · bypass');
    button(card, 'Approve').click();
    assert.equal(sent.length, 1, 'a resolved card answers once');
    assert.match(CP_STYLES, /\.cp-plan-btn-bypass \{ border-color: rgba\(239,112,112,0\.45\) !important; color: #ef7070 !important; \}/);
  } finally { dom.restore(); }
});

test('the plan card has no bypass choice where Bypass cannot be taken', () => {
  const { dom, tab, sent, hooks } = setup();
  try {
    for (const bypass of [undefined, { available: false, reason: 'turned off' }, null]) {
      const card = renderPlanApprovalCard(tab, `plan-${String(bypass?.available)}`, REQ, hooks({ bypass }));
      assert.equal(button(card, 'Approve & bypass permissions'), undefined);
      assert.ok(button(card, 'Approve'));
    }
    assert.deepEqual(sent, []);
  } finally { dom.restore(); }
  const next = fnBody('function _showNextPerm(tab) {');
  assert.match(next, /bypass: _bypassOffer\(tab\),/, 'the card is given what this tab can take');
  // An approval is the pick of the mode the plan continues in, made before the answer is sent so the answer carries its number.
  assert.match(next, /return _sendControlInner\(tab, rid, inner\?\.behavior === 'allow' \? _planApproved\(tab, inner\) : inner\);/);
  assert.match(fnBody('function _planApproved(tab, inner) {'), /pickMode\(tab, mode === 'acceptEdits' \|\| mode === BYPASS_MODE \? mode : 'default'\);/);
});

// ── The legacy engine's branches are gone ──

test('the panel has one engine: what the per-turn engine needed is removed', () => {
  for (const gone of [
    'renderPermissionPrompt', '_autoAllowTools', '_exitPlanPending', '_exitPlanHandled', '_exitPlanWasPlanMode', '_exitPlanMsgId',
    '[PLAN MODE', '!tab.sdkMode && ', 'sdkMode: !!tab', 'Legacy engine', 'legacy card', 'legacy fallback',
  ]) assert.equal(panel.includes(gone), false, `${gone} is still in the panel`);
  // What is left of `sdkMode` is whether the bridge said hello on the tab's socket.
  const uses = panel.split('\n').filter(line => /\bsdkMode\b/.test(line));
  assert.deepEqual(uses.map(line => line.trim().replace(/\s*\/\/.*$/, '')), [
    'sdkMode: false,',
    'tab.sdkMode = hello.sdk;',
    'if (!tab.sdkMode) return;',
    "if (!tab.sdkMode) { appendStatus(tab, 'Rewind needs a connected Claude Code session.'); return; }",
    'tab.sdkMode = true;',
    '$dd.hidden = !tab.sdkMode || !!tab.automationActive;',
  ]);
  // Every query states the tab's configuration, whenever it is sent.
  assert.doesNotMatch(fnBody('function _applySessionOptions(tab, msg) {'), /sdkMode/);
  // One kind of permission card, and the plan approval card for every plan.
  const next = fnBody('function _showNextPerm(tab) {');
  assert.match(next, /if \(next\.kind === 'plan'\) \{/);
  assert.match(next, /renderPermissionCard\(tab, next\.requestId, next\.req, \{/);
  // The post-plan card stays: the plan editor's save and cancel still render it.
  assert.match(panel, /renderPostPlanActions\(tab, 'PLAN UPDATED'\);/);
  assert.match(panel, /function renderPostPlanActions\(tab, headerText\) \{/);
});

test('the standalone chat page is gone, and nothing in the interface points at it', () => {
  for (const file of ['public/claude-chat.html', 'public/claude-chat.js', 'public/claude-chat.css']) {
    assert.equal(existsSync(join(HERE, '..', file)), false, `${file} is still there`);
  }
  assert.doesNotMatch(read('public/shared/html-shell.js'), /claude-chat|nav-chat-link/);
  const sessions = read('public/shared/ui-sessions.js');
  assert.doesNotMatch(sessions, /mountSessionWidget|claude-chat/);
  assert.doesNotMatch(read('public/shared/styles.css'), /\.session-widget|claude-chat/);
});
