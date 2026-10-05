import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
// Imported before any test defines a document: its dependencies wire page listeners only when one exists at load.
import { CONTROL_KINDS, normalizeControlRequest, renderControlCard } from '../public/shared/assistant/asst-control.js';
import {
  COMPUTER_ACTION_VERBS,
  COMPUTER_SETUP_STATES,
  computerRemoteView,
  computerSetupState,
  computerToolName,
  createComputerToggle,
  normalizeComputerRemote,
  describeComputerAction,
  frameUrls,
  isComputerTool,
  markerPercent,
  parseComputerResult,
} from '../public/shared/assistant/asst-computer.js';

test('computer tools are detected bare and with SynaBun prefixes', () => {
  for (const name of ['computer', 'computer_apps', 'computer_ax', 'computer_status']) {
    assert.equal(isComputerTool(name), true, name);
    assert.equal(isComputerTool(`mcp__SynaBun__${name}`), true, `mcp__SynaBun__${name}`);
    assert.equal(isComputerTool(`SynaBun_${name}`), true, `SynaBun_${name}`);
    assert.equal(isComputerTool(`synabun_${name}`), true, `synabun_${name}`);
    assert.equal(computerToolName(`mcp__synabun__${name}`), name);
  }
  for (const name of ['computers', 'computer_use', 'mcp__other__computer', 'Bash', '', null, 'mcp__SynaBun__browser_click']) {
    assert.equal(isComputerTool(name), false, String(name));
  }
});

test('every computer action has a verb and a readable description', () => {
  const at = [640, 412];
  const expected = {
    screenshot: 'Screenshot',
    left_click: 'Click (640, 412)',
    right_click: 'Right-click (640, 412)',
    middle_click: 'Middle-click (640, 412)',
    double_click: 'Double-click (640, 412)',
    triple_click: 'Triple-click (640, 412)',
    mouse_move: 'Move pointer (640, 412)',
    left_mouse_down: 'Mouse down (640, 412)',
    left_mouse_up: 'Mouse up (640, 412)',
    cursor_position: 'Pointer position',
  };
  for (const [action, text] of Object.entries(expected)) {
    assert.equal(describeComputerAction({ action, coordinate: at }), text, action);
  }
  assert.equal(describeComputerAction({ action: 'left_click_drag', start_coordinate: [10, 20], coordinate: [300, 400.4] }), 'Drag (10, 20) → (300, 400)');
  assert.equal(describeComputerAction({ action: 'type', text: 'hello world' }), 'Type “hello world”');
  assert.equal(describeComputerAction({ action: 'type', text: 'x'.repeat(80) }).length <= 48, true, 'typed text is clipped');
  assert.equal(describeComputerAction({ action: 'key', text: 'cmd+c' }), 'Press cmd+c');
  assert.equal(describeComputerAction({ action: 'hold_key', text: 'shift', duration: 2 }), 'Hold shift for 2s');
  assert.equal(describeComputerAction({ action: 'scroll', coordinate: at, scroll_direction: 'down', scroll_amount: 3 }), 'Scroll down ×3 at (640, 412)');
  assert.equal(describeComputerAction({ action: 'wait', duration: 2 }), 'Wait 2s');
  assert.equal(describeComputerAction({ action: 'wait' }), 'Wait 1s');
  assert.equal(describeComputerAction({ action: 'zoom', region: [0, 0, 640, 400] }), 'Zoom (0, 0)–(640, 400)');
  assert.equal(describeComputerAction({ action: 'some_new_action' }), 'Some new action');
  assert.equal(describeComputerAction({}), 'Computer');
  assert.equal(describeComputerAction({ action: 'open', name: 'TextEdit' }, 'computer_apps'), 'Open TextEdit');
  assert.equal(describeComputerAction({}, 'mcp__SynaBun__computer_apps'), 'List apps');
  assert.equal(describeComputerAction({ action: 'find', query: 'Save' }, 'computer_ax'), 'Find “Save”');
  assert.equal(describeComputerAction({ action: 'press', intent: 'go back' }, 'computer_ax'), 'Press “go back”');
  assert.equal(describeComputerAction({ action: 'snapshot', intent: 'open the downloads folder' }, 'mcp__SynaBun__computer_ax'), 'Snapshot “open the downloads folder”');
  assert.equal(describeComputerAction({ action: 'press', intent: 'go back', query: 'ignored' }, 'computer_ax'), 'Press “go back”', 'the intent names the target first');
  assert.equal(describeComputerAction({}, 'computer_status'), 'Status');
  // Every documented verb is covered by the table.
  for (const action of Object.keys(expected)) assert.ok(COMPUTER_ACTION_VERBS[action], action);
  for (const action of ['left_click_drag', 'type', 'key', 'hold_key', 'scroll', 'wait', 'zoom']) assert.ok(COMPUTER_ACTION_VERBS[action], action);
});

test('result lines: ok with frame/size/screenshot id, and error codes', () => {
  const ok = parseComputerResult('ok · left_click (640,412) · TextEdit · frame=f_ab12cd size=1280x800 screenshot_id=s_9f8e\nmore text');
  assert.equal(ok.ok, true);
  assert.equal(ok.action, 'left_click');
  assert.equal(ok.app, 'TextEdit');
  assert.equal(ok.summary, 'left_click (640,412) · TextEdit');
  assert.equal(ok.frameId, 'f_ab12cd');
  assert.equal(ok.width, 1280);
  assert.equal(ok.height, 800);
  assert.equal(ok.screenshotId, 's_9f8e');

  const err = parseComputerResult('error ACCESSIBILITY_DENIED: Grant Accessibility access to Terminal');
  assert.equal(err.ok, false);
  assert.equal(err.code, 'ACCESSIBILITY_DENIED');
  assert.equal(err.message, 'Grant Accessibility access to Terminal');
  assert.equal(err.frameId, null);

  const refused = parseComputerResult('error PRESS_REFUSED(target_changed:title): The control changed before it could be pressed.');
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'PRESS_REFUSED');
  assert.equal(refused.message, 'target_changed:title — The control changed before it could be pressed.');

  const bare = parseComputerResult('\n\nok · screenshot · frame=f-1');
  assert.equal(bare.ok, true);
  assert.equal(bare.frameId, 'f-1');
  assert.equal(bare.width, null);
  assert.deepEqual(parseComputerResult(null), { ok: null, code: null, message: '', summary: '', action: '', app: '', frameId: null, width: null, height: null, screenshotId: null });
  assert.equal(parseComputerResult('something else').ok, null);
  assert.deepEqual(frameUrls('f_ab12cd'), { thumb: '/api/desktop/frames/f_ab12cd/thumb.jpg', full: '/api/desktop/frames/f_ab12cd.jpg' });
});

test('click markers are percentages of the screenshot size', () => {
  assert.deepEqual(markerPercent([640, 412], { width: 1280, height: 800 }), { x: 50, y: 51.5 });
  assert.deepEqual(markerPercent([0, 0], [1280, 800]), { x: 0, y: 0 });
  assert.deepEqual(markerPercent({ x: 1280, y: 800 }, '1280x800'), { x: 100, y: 100 });
  assert.deepEqual(markerPercent([2000, -5], { w: 1000, h: 500 }), { x: 100, y: 0 }, 'clamped');
  assert.deepEqual(markerPercent([333, 111], { width: 1000, height: 1000 }), { x: 33.3, y: 11.1 });
  assert.equal(markerPercent(null, { width: 10, height: 10 }), null);
  assert.equal(markerPercent([1, 2], null), null);
  assert.equal(markerPercent([1, 2], { width: 0, height: 10 }), null);
});

test('setup state machine', () => {
  const base = (setup, permissions = {}, extra = {}) => ({ ok: true, platform: 'darwin', supported: true, setup, permissions, ...extra });
  assert.equal(computerSetupState(null).state, 'loading');
  assert.equal(computerSetupState({ supported: false, setup: { state: 'unsupported_platform' } }).state, 'unsupported');
  assert.equal(computerSetupState({ supported: false, setup: { state: 'ready' } }).supported, false);
  assert.equal(computerSetupState(base({ state: 'not_started' })).state, 'not_started');
  assert.equal(computerSetupState(base({ state: 'needs_toolchain' })).state, 'needs_toolchain');
  const compiling = computerSetupState(base({ state: 'compiling' }));
  assert.equal(compiling.state, 'compiling');
  assert.equal(compiling.busy, true);
  const failed = computerSetupState(base({ state: 'compile_failed', build: { logTail: 'error: no such module' } }));
  assert.equal(failed.state, 'compile_failed');
  assert.equal(failed.logTail, 'error: no such module');
  const perms = computerSetupState(base({ state: 'needs_permissions' }, {
    screenRecording: { granted: true, deepLink: 'x-apple.systempreferences:screen' },
    accessibility: { granted: false, deepLink: 'x-apple.systempreferences:ax' },
    responsibleApp: { name: 'Terminal', bundleId: 'com.apple.Terminal' },
  }));
  assert.equal(perms.state, 'needs_permissions');
  assert.deepEqual(perms.screen, { granted: true, deepLink: 'x-apple.systempreferences:screen' });
  assert.equal(perms.accessibility.granted, false);
  assert.equal(perms.appName, 'Terminal');
  assert.equal(perms.needsSetup, true);
  assert.equal(computerSetupState(base({ state: 'starting' }, { needsRelaunch: true })).state, 'needs_relaunch');
  assert.equal(computerSetupState(base({ state: 'needs_relaunch' })).state, 'needs_relaunch');
  const ready = computerSetupState(base({ state: 'ready' }, { screenRecording: { granted: true }, accessibility: { granted: true } }));
  assert.equal(ready.state, 'ready');
  assert.equal(ready.ready, true);
  assert.equal(ready.needsSetup, false);
  assert.equal(computerSetupState(base({ state: 'ready' }, { screenRecording: { granted: false }, accessibility: { granted: true } })).state, 'needs_permissions', 'a revoked permission reopens setup');
  assert.equal(computerSetupState(base({ state: 'disabled' })).needsSetup, false);
  assert.equal(computerSetupState(base({ state: 'weird' })).state, 'not_started');
  assert.equal(computerSetupState(base({ state: 'compile_failed' }, {}, { setup: { state: 'compile_failed', helper: { lastError: 'boom' } } })).error, 'boom');
  for (const s of ['unsupported', 'not_started', 'needs_toolchain', 'compiling', 'compile_failed', 'starting', 'needs_permissions', 'needs_relaunch', 'ready', 'disabled']) {
    assert.ok(COMPUTER_SETUP_STATES.includes(s), s);
  }
});

// ── The Computer switch in a WhatsApp conversation: what is in effect, and why ──

/** Just enough DOM for createComputerToggle and renderControlCard (node has none). */
class FakeNode {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.dataset = {}; this.attrs = {}; this.listeners = {}; this.classes = new Set(); this.textContent = ''; this.innerHTML = ''; this.value = ''; this.hidden = false; this.disabled = false; }
  set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get classList() { const c = this.classes; return { add: (...n) => n.forEach((x) => c.add(x)), remove: (...n) => n.forEach((x) => c.delete(x)), contains: (x) => c.has(x) }; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; }
  removeAttribute(name) { delete this.attrs[name]; }
  appendChild(node) { this.children.push(node); return node; }
  remove() {}
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn({ stopPropagation() {} }); }
  *walk() { for (const child of this.children) { yield child; yield* child.walk(); } }
  querySelectorAll(selector) { const tags = selector.split(',').map((s) => s.trim().toUpperCase()); return [...this.walk()].filter((n) => tags.includes(n.tagName)); }
  querySelector(selector) { return [...this.walk()].find((n) => n.classes.has(selector.replace(/^\./, ''))) || null; }
}
function withDom(t) {
  const saved = globalThis.document;
  globalThis.document = { createElement: (tag) => new FakeNode(tag) };
  t.after(() => { globalThis.document = saved; });
}

test('computerRemoteView: every reason in plain words; nothing for a desktop conversation', () => {
  const tip = (state, reason, approved = false) => computerRemoteView({ state, reason, approved })?.tip;
  assert.equal(tip('off', 'switch_off'), 'Off for WhatsApp. Turn it on in Settings → Messages → WhatsApp → Safety');
  assert.equal(tip('allowed', 'autonomous'), 'On while Autonomous is active');
  assert.equal(tip('ask', 'ask'), 'Asks on your phone once per task');
  assert.equal(tip('off', 'paused'), 'Off: WhatsApp is paused');
  assert.equal(tip('off', 'read_only'), 'Off at the Read-only level (Settings → Messages → WhatsApp → Safety)');
  assert.equal(tip('off', 'brain'), 'Off: this WhatsApp conversation does not run on Claude');
  assert.equal(tip('off', 'setup'), 'Off: computer use is not set up on this Mac yet');
  assert.equal(tip('off', 'unsupported'), 'Computer use needs macOS');
  assert.equal(tip('ask', 'autonomous_expired'), 'Autonomous ended: asks on your phone once per task');
  assert.equal(tip('ask', 'untrusted'), 'Asks on your phone once: this task was not started by a plain message from your phone');
  assert.equal(tip('ask', 'ask', true), 'On for this task: you approved it');
  // A reason this panel does not know yet (a newer server) still reads sensibly, by its state.
  assert.equal(tip('off', 'something_new'), 'Off for this WhatsApp conversation');
  assert.equal(tip('ask', 'something_new'), 'Asks on your phone once per task');
  assert.equal(tip('allowed', 'something_new'), 'On while Autonomous is active');
  assert.equal(tip('off', 'switch_off', true), 'Off for WhatsApp. Turn it on in Settings → Messages → WhatsApp → Safety', '"approved" never makes an off switch read as on');
  // On = it can be used in this conversation (unasked, or after a yes); off = it cannot.
  assert.deepEqual(['off', 'ask', 'allowed'].map((state) => computerRemoteView({ state, reason: 'x' }).on), [false, true, true]);
  // The translator: (key) → text, or the key itself when the locale has none.
  assert.equal(computerRemoteView({ state: 'ask', reason: 'ask' }, (key) => (key === 'assistant.computer.remote.ask' ? 'Pergunta no seu celular uma vez por tarefa' : key)).tip, 'Pergunta no seu celular uma vez por tarefa');
  assert.equal(computerRemoteView({ state: 'ask', reason: 'ask' }, (key) => key).tip, 'Asks on your phone once per task');
  // A desktop conversation (null), an older server (no field) and junk: no remote view at all.
  for (const value of [null, undefined, {}, { state: 'on' }, 'ask', 7]) {
    assert.equal(normalizeComputerRemote(value), null, JSON.stringify(value));
    assert.equal(computerRemoteView(value), null, JSON.stringify(value));
  }
  assert.deepEqual(normalizeComputerRemote({ state: 'ask', reason: 'ask', level: 'ask', approved: 1 }), { state: 'ask', reason: 'ask', approved: false }, 'approved is true only when it is true');
  // Every tip has its key in both locale files.
  for (const file of ['en.json', 'pt-BR.json']) {
    const remote = JSON.parse(readFileSync(new URL(`../i18n/${file}`, import.meta.url), 'utf8')).assistant.computer.remote;
    assert.deepEqual(Object.keys(remote).sort(), ['approved', 'ask', 'autonomous', 'autonomousExpired', 'brain', 'off', 'paused', 'readOnly', 'setup', 'switchOff', 'unsupported', 'untrusted'], file);
  }
  const en = JSON.parse(readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8')).assistant.computer.remote;
  for (const [state, reason, key] of [['off', 'switch_off', 'switchOff'], ['off', 'paused', 'paused'], ['off', 'read_only', 'readOnly'], ['off', 'brain', 'brain'], ['off', 'setup', 'setup'], ['off', 'unsupported', 'unsupported'], ['allowed', 'autonomous', 'autonomous'], ['ask', 'ask', 'ask'], ['ask', 'autonomous_expired', 'autonomousExpired'], ['ask', 'untrusted', 'untrusted'], ['off', 'x', 'off']]) {
    assert.equal(en[key], tip(state, reason), `${reason}: en.json says what the code falls back to`);
  }
  assert.equal(en.approved, tip('ask', 'ask', true));
});

test('the Computer switch in a WhatsApp conversation shows the effective state, says why, and never toggles (it cannot bounce)', (t) => {
  withDom(t);
  const host = new FakeNode('div');
  const calls = [];
  const toggle = createComputerToggle(host, { onToggle: (enabled) => calls.push(['toggle', enabled]), onRemoteInfo: (view) => calls.push(['info', view.reason, view.tip]) });
  const btn = toggle.el;
  const look = () => [btn.getAttribute('aria-checked'), btn.dataset.state, btn.getAttribute('data-tooltip')];
  // Off for WhatsApp: off, with where it is turned on; a click explains and changes nothing.
  toggle.set({ visible: true, supported: true, setupState: 'ready', enabled: false, remote: { state: 'off', reason: 'switch_off' } });
  assert.deepEqual(look(), ['false', 'off', 'Off for WhatsApp. Turn it on in Settings → Messages → WhatsApp → Safety']);
  assert.equal(btn.getAttribute('aria-readonly'), 'true');
  assert.equal(btn.disabled, false, 'still focusable: its tooltip is the explanation');
  btn.click();
  assert.deepEqual(calls, [['info', 'switch_off', 'Off for WhatsApp. Turn it on in Settings → Messages → WhatsApp → Safety']]);
  assert.deepEqual(look(), ['false', 'off', 'Off for WhatsApp. Turn it on in Settings → Messages → WhatsApp → Safety'], 'nothing flipped');
  // Autonomous: on, and a click still does not turn it off.
  toggle.set({ enabled: true, remote: { state: 'allowed', reason: 'autonomous' } });
  assert.deepEqual(look(), ['true', 'ready', 'On while Autonomous is active']);
  btn.click();
  assert.deepEqual(look(), ['true', 'ready', 'On while Autonomous is active']);
  // Ask, then the task the owner approved, then paused.
  toggle.set({ remote: { state: 'ask', reason: 'ask' } });
  assert.deepEqual(look(), ['true', 'ready', 'Asks on your phone once per task']);
  toggle.set({ remote: { state: 'ask', reason: 'ask', approved: true } });
  assert.deepEqual(look(), ['true', 'ready', 'On for this task: you approved it']);
  toggle.set({ active: true });
  assert.equal(btn.dataset.state, 'active', 'while the Mac is being controlled the switch shows it');
  toggle.set({ active: false, enabled: false, remote: { state: 'off', reason: 'paused' } });
  assert.deepEqual(look(), ['false', 'off', 'Off: WhatsApp is paused']);
  assert.equal(calls.filter((row) => row[0] === 'toggle').length, 0, 'onToggle is never called for a WhatsApp conversation');
  assert.match(btn.getAttribute('aria-label'), /^Computer — Off: WhatsApp is paused$/);
  // A desktop conversation behaves exactly as before: a real switch.
  toggle.set({ remote: null, enabled: false });
  assert.deepEqual(look(), ['false', 'off', 'Let the assistant use your Mac']);
  assert.equal(btn.getAttribute('aria-readonly'), null);
  assert.equal(btn.dataset.remote, undefined);
  btn.click();
  assert.deepEqual(calls.at(-1), ['toggle', true]);
  toggle.set({ enabled: true });
  assert.deepEqual(look(), ['true', 'ready', 'Computer use is on']);
  btn.click();
  assert.deepEqual(calls.at(-1), ['toggle', false]);
  toggle.set({ setupState: 'needs_permissions' });
  assert.deepEqual(look(), ['true', 'setup', 'Computer use is on — finish setup']);
});

test('the panel never sends set_computer_use for a WhatsApp conversation: the switch, the menu item and /computer explain instead', () => {
  const panel = readFileSync(new URL('../public/shared/assistant/asst-panel.js', import.meta.url), 'utf8');
  // The meta's computerRemote is kept (null for a desktop conversation; absent on an older server: unchanged).
  assert.match(panel, /if \('computerRemote' in meta\) st\.computerRemote = normalizeComputerRemote\(meta\.computerRemote\);/);
  assert.match(panel, /remote: st\.computerRemote \|\| null,/, 'the switch is given the remote state');
  // setComputerUse returns before the optimistic change and before anything is sent.
  const fn = /function setComputerUse\(enabled\) \{([\s\S]*?)\n  \}/.exec(panel)[1];
  const guard = fn.indexOf('if (st.computerRemote) { explainRemoteComputer(); return; }');
  assert.ok(guard >= 0, 'the guard is there');
  for (const later of ['st.computerUse = next', 'st.computerEffective = next', "sock.send({ type: 'set_computer_use'", 'persist()']) {
    assert.ok(fn.indexOf(later) > guard, `${later} comes after the guard`);
  }
  // The toggle's click goes to the explanation; so do the settings-menu item (through setComputerUse) and the slash command.
  assert.match(panel, /onRemoteInfo: \(\) => explainRemoteComputer\(\),/);
  assert.match(panel, /if \(st\.computerRemote\) \{ explainRemoteComputer\(\); return true; \}\s*\n\s*setComputerUse\(parsed\.mode \? parsed\.mode === 'on' : !st\.computerEffective\);/);
  assert.match(panel, /\.\.\.\(st\.computerRemote \? \{ desc: computerRemoteView\(st\.computerRemote, t\)\?\.tip \|\| '' \} : \{\}\),/);
  assert.match(panel, /checked: st\.computerRemote \? computerRemoteView\(st\.computerRemote, t\)\?\.on === true : st\.computerEffective,/);
  assert.match(panel, /function explainRemoteComputer\(\) \{[\s\S]{0,300}renderer\.appendStatus\(tt\('assistant\.status\.computerRemote', 'Computer use in this WhatsApp conversation: \{why\}\.', \{ why: view\.tip \}\)\);/);
  for (const file of ['en.json', 'pt-BR.json']) {
    const locale = JSON.parse(readFileSync(new URL(`../i18n/${file}`, import.meta.url), 'utf8')).assistant;
    assert.match(locale.status.computerRemote, /\{why\}/, file);
    assert.ok(locale.control.computer && locale.control.computerBody, file);
    assert.equal('allow-task' in locale.control.action, false, `${file}: the desktop has no button that allows it`);
  }
});

test('the "control your Mac?" request is a card of its own kind on the desktop, where it can be denied but never allowed', async (t) => {
  withDom(t);
  const n = normalizeControlRequest({ type: 'control_request', request_id: 'perm-9', request: { subtype: 'computer_use', kind: 'computer_use', tool_name: 'computer_use', channel: 'whatsapp', level: 'ask', reason: 'ask' } });
  assert.deepEqual([n.kind, n.title, n.provider], [CONTROL_KINDS.COMPUTER, 'Control your Mac?', 'synabun']);
  const answers = [];
  const card = renderControlCard(null, n, { onRespond: (_n, decision) => answers.push(decision) });
  assert.equal(card.el.dataset.kind, 'computer');
  const buttons = [...card.el.walk()].filter((node) => node.tagName === 'BUTTON');
  assert.deepEqual(buttons.map((node) => node.dataset.action), ['deny'], 'no Allow, no Always: only the owner\'s phone grants it');
  assert.ok([...card.el.walk()].some((node) => /Only a yes from that phone lets the assistant use the mouse and keyboard, until this task ends\. You can deny it here\./.test(node.textContent)));
  assert.equal([...card.el.walk()].filter((node) => node.tagName === 'PRE').length, 0, 'no tool arguments: it is not a tool card');
  buttons[0].click();
  assert.deepEqual(answers, [{ behavior: 'deny' }]);
  assert.equal(card.el.querySelector('.asst-control-status').textContent, 'Denied');
});

test('the desktop route card says which option also lets the assistant control the Mac (asked from WhatsApp)', async () => {
  const { normalizeRouteRequest } = await import('../public/shared/assistant/asst-route.js');
  const packet = (computer) => ({ type: 'control_request', request_id: 'route-1', request: { subtype: 'route', routeId: 'route-1', taskClass: 'computer', summary: 'Tidy the desktop', options: [{ id: 's1', kind: 'direct', provider: 'claude-code', model: 'sonnet', label: 'Do it here with Sonnet 5' }], defaultOptionId: 's1', ...(computer === undefined ? {} : { computer }) } });
  assert.deepEqual(normalizeRouteRequest(packet({ optionId: 's1' })).computer, { optionId: 's1' });
  for (const none of [undefined, null, {}, { optionId: '' }, 'yes', true, []]) assert.equal(normalizeRouteRequest(packet(none)).computer, null, JSON.stringify(none));
  const source = readFileSync(new URL('../public/shared/assistant/asst-route.js', import.meta.url), 'utf8');
  // The note is shown for that option only, in words, and only while the option can be picked.
  assert.match(source, /const macOption = n\.computer \? options\.find\(o => o\.id === n\.computer\.optionId && !o\.disabled\) : null;/);
  assert.match(source, /if \(macOption\) \{\s*const note = el\('div', 'asst-route-reasons', tr\('assistant\.routes\.computerNote', 'Asked from WhatsApp: on the phone, a yes to “\{option\}” also lets the assistant control this Mac for the task\. Approved here, it only decides where the task runs; the phone is then asked about the Mac\.', \{ option: macOption\.title \}\)\);/);
  for (const file of ['en.json', 'pt-BR.json']) {
    const text = JSON.parse(readFileSync(new URL(`../i18n/${file}`, import.meta.url), 'utf8')).assistant.routes.computerNote;
    assert.match(text, /\{option\}/, file);
  }
});
