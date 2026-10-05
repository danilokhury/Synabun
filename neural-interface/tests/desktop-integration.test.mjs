// The desktop service driving the REAL helper manager over the fake helper
// core (same protocol, guards, latch and abort semantics as the Swift helper).
// Catches contract drift between service.js and manager.js / the helper.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopService } from '../lib/desktop/service.js';
import { createDesktopConfigStore } from '../lib/desktop/config.js';
import { createDesktopHelperManager } from '../lib/desktop/manager.js';
import * as desktopRisk from '../../mcp-server/dist/services/desktop-risk.js';
import * as browserRisk from '../../mcp-server/dist/services/browser-risk.js';

// Timers on the paths these tests wait for are unref'd on purpose, so a pending
// call never holds the server open. With nothing else on the loop Node 22
// drains it before they fire, and the remaining tests of the file are cancelled
// with "Promise resolution is still pending but the event loop has already
// resolved". Hold the loop open for the length of the file.
const keepAlive = setInterval(() => {}, 60_000);
after(() => clearInterval(keepAlive));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A liveness poll for an event that crosses the helper's process boundary: it returns as soon as the
// condition holds. The cap only bounds a real failure, so it is generous (10 s), not a timing check.
async function until(fn, label, tries = 2000) {
  for (let i = 0; i < tries; i += 1) {
    if (await fn()) return;
    await wait(5);
  }
  assert.fail(`timed out waiting for ${label}`);
}

// The fake helper's front window belongs to Safari by default. Computer use
// refuses web browsers, so the everyday tests drive Preview in its place (same
// pid, windows and AX tree); the browser tests below bring their own apps.
const EVERYDAY_APPS = [
  { pid: 101, bundleId: 'com.apple.finder', name: 'Finder', hidden: false, path: '/System/Library/CoreServices/Finder.app' },
  { pid: 202, bundleId: 'com.apple.Preview', name: 'Preview', hidden: false, path: '/System/Applications/Preview.app' },
  { pid: 303, bundleId: 'com.apple.TextEdit', name: 'TextEdit', hidden: false, path: '/System/Applications/TextEdit.app' },
  { pid: 404, bundleId: 'com.1password.1password', name: '1Password', hidden: false, path: '/Applications/1Password.app' },
  { pid: 505, bundleId: 'com.apple.Terminal', name: 'Terminal', hidden: false, path: '/System/Applications/Utilities/Terminal.app' },
];

function harness(t, fakeOptions = {}) {
  let stored = null;
  const configStore = createDesktopConfigStore({ get: () => stored, set: (key, value) => { stored = value; }, ttlMs: 0 });
  // The service's clock is the test's: the user-takeover pause (10 minutes here) ends only when the test
  // advances it, never because real time went by.
  let offset = 0;
  const clock = { now: () => Date.now() + offset, advance: (ms) => { offset += ms; } };
  configStore.write({ settleMs: { default: 0, click: 0, key: 0, type: 0, scroll: 0, open: 0, drag: 0 }, userPauseMs: USER_PAUSE_MS });
  const manager = createDesktopHelperManager({ mode: 'fake', fakeOptions: { userInputIntervalMs: 0, apps: EVERYDAY_APPS, ...fakeOptions }, backoffMs: [0], idleShutdownMs: 0 });
  const runtimeCalls = [];
  const desktop = createDesktopService({
    manager, configStore, platform: 'darwin', release: '25.6.0', now: clock.now,
    build: { resolveBinary: async () => { throw new Error('fake mode must not resolve a binary'); } },
  });
  desktop.attach({
    runtime: { getComputerUse: () => true, abortTurn: async (id) => runtimeCalls.push(['abort', id]), notifySession: () => {} },
    dispatcher: { stop: async (runId, reason) => runtimeCalls.push(['stopRun', runId, reason]) },
  });
  t.after(() => desktop.shutdown());
  const fake = () => manager.request('__fake_state');
  const grant = desktop.mintGrant({ kind: 'brain', assistantSessionId: 's1', provider: 'claude-code', vision: true });
  return { desktop, manager, fake, grant, runtimeCalls, clock };
}
const USER_PAUSE_MS = 600_000;

async function ready(h) {
  await h.desktop.setup('start');
  await until(() => h.desktop.setupState() === 'ready', 'setup ready');
}

// Main fake display: 1470×956 pt at scale 2 → fitted into 1280×800 → 1230×800.
const toImage = (x, y) => [Math.floor(x * 1230 / 1470), Math.floor(y * 800 / 956)];

test('setup in fake mode skips the build and installs no input monitor before the first action', async (t) => {
  const h = harness(t);
  await ready(h);
  const state = await h.fake();
  assert.equal(state.received.some((r) => r.cmd === 'configure'), false, 'configure (monitors) is lazy');
  assert.ok(state.received.some((r) => r.cmd === 'permissions'));
});

test('screenshot, click and type round-trip through the helper; coordinates land in points', async (t) => {
  const h = harness(t);
  await ready(h);
  const shot = await h.desktop.act(h.grant, { action: 'screenshot' });
  assert.equal(shot.ok, true, shot.error);
  assert.deepEqual([shot.frame.width, shot.frame.height], [1230, 800]);
  let state = await h.fake();
  assert.equal(state.config.monitor.armed, true, 'holding the lease arms Esc / the corner');
  assert.equal(state.power, true);
  assert.ok(state.config.guard.blockedApps.some((rule) => rule.id === 'terminals'));

  const focus = await h.desktop.apps(h.grant, { action: 'focus', app: 'TextEdit' });
  assert.equal(focus.ok, true, focus.error);
  const click = await h.desktop.act(h.grant, { action: 'left_click', coordinate: toImage(1000, 450) });
  assert.equal(click.ok, true, click.error);
  assert.equal(click.app.name, 'TextEdit');
  state = await h.fake();
  const performed = state.actions.find((a) => a.cmd === 'click');
  assert.ok(Math.abs(performed.x - 1000) < 2 && Math.abs(performed.y - 450) < 2, `click at ${performed.x},${performed.y}`);

  const typed = await h.desktop.act(h.grant, { action: 'type', text: 'SynaBun desktop test' });
  assert.equal(typed.ok, true, typed.error);
  assert.equal((await h.fake()).actions.find((a) => a.cmd === 'type').text, 'SynaBun desktop test');
});

test('helper guards come back as refusals: password manager, terminal, password field', async (t) => {
  const h = harness(t);
  await ready(h);
  await h.desktop.act(h.grant, { action: 'screenshot' });
  const vault = await h.desktop.act(h.grant, { action: 'left_click', coordinate: toImage(1350, 800) });
  assert.equal(vault.code, 'BLOCKED_APP');
  await h.desktop.act(h.grant, { action: 'screenshot' });
  const shell = await h.desktop.act(h.grant, { action: 'left_click', coordinate: toImage(60, 850) });
  assert.equal(shell.code, 'BLOCKED_APP');
  assert.equal((await h.desktop.apps(h.grant, { action: 'focus', app: 'Terminal' })).code, 'BLOCKED_APP');
  assert.equal((await h.desktop.apps(h.grant, { action: 'focus', app: 'Nonexistent' })).code, 'APP_NOT_FOUND');
  await h.manager.request('__fake_set', { secureFocus: true });
  assert.equal((await h.desktop.act(h.grant, { action: 'type', text: 'hunter2' })).code, 'SECURE_FIELD');
});

test('user input pauses the agent and invalidates its evidence', async (t) => {
  const h = harness(t);
  await ready(h);
  await h.desktop.act(h.grant, { action: 'screenshot' });
  await h.manager.request('__fake_simulate', { kind: 'mouse', x: 500, y: 500 });
  await until(() => h.desktop.status().control.userActiveUntil, 'user_input event');
  assert.equal((await h.desktop.act(h.grant, { action: 'left_click', coordinate: [10, 10] })).code, 'USER_ACTIVE');
  h.clock.advance(USER_PAUSE_MS + 1); // the takeover pause runs out
  const stale = await h.desktop.act(h.grant, { action: 'left_click', coordinate: [10, 10] });
  assert.equal(stale.code, 'STALE_SCREENSHOT');
  assert.ok(stale.image?.data, 'a fresh screenshot comes with the refusal');
});

test('Esc latches until resume, and the helper accepts input again afterwards', async (t) => {
  const h = harness(t);
  await ready(h);
  await h.desktop.act(h.grant, { action: 'screenshot' });
  await h.manager.request('__fake_simulate', { kind: 'esc' });
  await until(() => h.desktop.status().control.stopped.latched, 'emergency stop');
  assert.deepEqual(h.runtimeCalls[0], ['abort', 's1'], 'the brain turn is interrupted');
  assert.equal((await h.desktop.act(h.grant, { action: 'screenshot' })).code, 'STOPPED_BY_USER');
  h.desktop.resume();
  h.clock.advance(USER_PAUSE_MS + 1); // pressing Esc was user input too: the takeover pause runs out first
  await h.desktop.act(h.grant, { action: 'screenshot' });
  const click = await h.desktop.act(h.grant, { action: 'left_click', coordinate: toImage(500, 400) });
  assert.equal(click.ok, true, click.error);
});

test('after a helper crash mid-control, Esc is still armed on the respawned helper', async (t) => {
  const h = harness(t);
  await ready(h);
  await h.desktop.act(h.grant, { action: 'screenshot' });
  const before = (await h.fake()).pid;
  await h.manager.request('__fake_crash', {}, { timeoutMs: 200 }).catch(() => {});
  await until(async () => h.manager.status().state === 'running' && h.manager.status().pid !== before, 'respawn');
  const shot = await h.desktop.act(h.grant, { action: 'screenshot' });
  assert.equal(shot.ok, true, shot.error);
  const state = await h.fake();
  assert.notEqual(state.pid, before);
  assert.equal(state.config.monitor.armed, true, 'the lease is still held, so the new helper must be armed');
  await h.manager.request('__fake_simulate', { kind: 'esc' });
  await until(() => h.desktop.status().control.stopped.latched, 'emergency stop after respawn');
});

test('ax snapshot and press go through the helper; apps open refuses URLs', async (t) => {
  const h = harness(t);
  await ready(h);
  const snapshot = await h.desktop.ax(h.grant, { action: 'snapshot' });
  assert.equal(snapshot.ok, true, snapshot.error);
  assert.match(snapshot.tree, /^snapshot s\d+ · Preview/);
  assert.match(snapshot.tree, /AXSecureTextField "Password" \[secure\]/, 'secure values are never shown');
  const ref = snapshot.tree.match(/\b(e\d+) AXButton "Back"/)?.[1];
  assert.ok(ref, snapshot.tree);
  const press = await h.desktop.ax(h.grant, { action: 'press', snapshot_id: snapshot.snapshotId, ref });
  assert.equal(press.ok, true, press.error);
  assert.equal((await h.desktop.apps(h.grant, { action: 'open', app: 'https://example.com' })).code, 'BAD_ARGS');
  const opened = await h.desktop.apps(h.grant, { action: 'open', app: 'Calculator' });
  assert.equal(opened.ok, true, opened.error);
});

test('localized guards end to end: a Portuguese System Settings pane and the SynaBun web app are refused', async (t) => {
  const webApp = 'com.apple.Safari.WebApp.7EF0F3F3-27FA-4C9A-9D7C-74020761B996';
  const h = harness(t, {
    apps: [
      { pid: 606, bundleId: 'com.apple.systempreferences', name: 'Ajustes do Sistema', lang: 'pt', path: '/System/Applications/System Settings.app' },
      { pid: 707, bundleId: webApp, name: 'SynaBun', path: '/Users/me/Applications/SynaBun.app' },
      { pid: 202, bundleId: 'com.apple.Safari', name: 'Safari', path: '/Applications/Safari.app' },
    ],
    windows: [
      // A title as macOS may hand it over: decomposed (NFD).
      { windowId: 2001, pid: 606, title: 'Privacidade e Segurança', bounds: { x: 100, y: 100, w: 600, h: 400 }, layer: 0, onScreen: true },
      { windowId: 2002, pid: 707, title: 'Restarting...', bounds: { x: 800, y: 100, w: 500, h: 400 }, layer: 0, onScreen: true },
      { windowId: 2003, pid: 606, title: 'Aparência', bounds: { x: 100, y: 600, w: 600, h: 300 }, layer: 0, onScreen: true },
      { windowId: 2004, pid: 202, title: 'Restarting...', bounds: { x: 800, y: 600, w: 500, h: 300 }, layer: 0, onScreen: true },
    ],
    frontmostPid: 606,
  });
  // The protected-window rules on their own: with the browser rule on (the default),
  // Safari and every web app are refused as browsers first (the browser test below).
  h.desktop.updateConfig({ guards: { browserApps: [], browserAppPrefixes: [] } });
  await ready(h);
  const click = async (x, y) => {
    await h.desktop.act(h.grant, { action: 'screenshot' });
    return h.desktop.act(h.grant, { action: 'left_click', coordinate: toImage(x, y) });
  };
  const pane = await click(300, 300);
  assert.equal(pane.code, 'PROTECTED_WINDOW', pane.error);
  assert.match(pane.error, /System Settings security panes/);
  const webWindow = await click(1000, 300);
  assert.equal(webWindow.code, 'PROTECTED_WINDOW', 'the web app is protected whatever its page title');
  assert.match(webWindow.error, /SynaBun \(every window\) is protected/);
  const everyday = await click(300, 700);
  assert.equal(everyday.ok, true, `Aparência stays usable: ${everyday.error}`);
  const safari = await click(1000, 700);
  assert.equal(safari.ok, true, `Safari itself is not protected by the app-name rule: ${safari.error}`);

  assert.equal((await h.desktop.apps(h.grant, { action: 'focus', app: 'SynaBun' })).code, 'PROTECTED_WINDOW');
  assert.equal((await h.desktop.apps(h.grant, { action: 'open', app: 'SynaBun' })).code, 'PROTECTED_WINDOW', 'opening the web app is refused');
  assert.equal((await h.desktop.apps(h.grant, { action: 'focus', app: 'Ajustes do Sistema' })).ok, true, 'focus alone names no protected window');

  // Keyboard and AX actions in the protected pane are refused by the helper too.
  assert.equal((await h.desktop.act(h.grant, { action: 'type', text: 'x' })).code, 'PROTECTED_WINDOW');
  const snapshot = await h.desktop.ax(h.grant, { action: 'snapshot', pid: 606 });
  assert.equal(snapshot.ok, true, snapshot.error);
  const ref = snapshot.tree.match(/\b(e\d+) AXButton "Back"/)?.[1];
  assert.ok(ref, snapshot.tree);
  assert.equal((await h.desktop.ax(h.grant, { action: 'press', snapshot_id: snapshot.snapshotId, ref })).code, 'PROTECTED_WINDOW');
  const state = await h.fake();
  assert.equal(state.actions.filter((a) => a.cmd === 'click').length, 2, 'only the two unprotected clicks happened');
  assert.equal(state.actions.some((a) => a.cmd === 'ax_action' || a.cmd === 'type'), false);
  const ui = state.config.guard.protectedWindows.find((rule) => rule.id === 'synabun-ui');
  assert.ok(ui.bundlePrefixes.includes('com.apple.Safari.WebApp.') && ui.appNameRe, 'the helper was configured with the protocol-2 fields');
});

test('web browsers end to end: clicks, keys, typing, focus by pid, open, AX snapshot and press on a browser are refused; MoreLogin\'s manager app is not a browser', async (t) => {
  const h = harness(t, {
    apps: [
      { pid: 901, bundleId: 'com.google.Chrome', name: 'Google Chrome', hidden: false, path: '/Applications/Google Chrome.app' },
      { pid: 902, bundleId: 'org.HongKongZiXun.MoreLogin', name: 'MoreLogin', hidden: false, path: '/Users/me/Library/Application Support/MoreLogin/env-kit/Core/chrome_64_150.1/MoreLogin.app' },
      { pid: 903, bundleId: 'com.zixun.MoreLoginPlus', name: 'MoreLogin', hidden: false, path: '/Applications/MoreLogin.app' },
      { pid: 303, bundleId: 'com.apple.TextEdit', name: 'TextEdit', hidden: false, path: '/System/Applications/TextEdit.app' },
      { pid: 707, bundleId: 'com.apple.Safari.WebApp.7EF0F3F3', name: 'SynaBun', hidden: false, path: '/Users/me/Applications/SynaBun.app' },
    ],
    windows: [
      { windowId: 3001, pid: 901, title: 'localhost:3344', bounds: { x: 100, y: 100, w: 600, h: 400 }, layer: 0, onScreen: true },
      { windowId: 3002, pid: 902, title: 'P-1 — Example', bounds: { x: 800, y: 100, w: 500, h: 400 }, layer: 0, onScreen: true },
      { windowId: 3003, pid: 903, title: 'MoreLogin', bounds: { x: 100, y: 600, w: 600, h: 300 }, layer: 0, onScreen: true },
      { windowId: 3004, pid: 303, title: 'Untitled', bounds: { x: 800, y: 600, w: 500, h: 300 }, layer: 0, onScreen: true },
    ],
    frontmostPid: 901,
  });
  await ready(h);
  const click = async (x, y) => {
    await h.desktop.act(h.grant, { action: 'screenshot' });
    return h.desktop.act(h.grant, { action: 'left_click', coordinate: toImage(x, y) });
  };
  const browserRefusal = (result, label) => {
    assert.equal(result.code, 'BLOCKED_APP', `${label}: ${result.error}`);
    assert.match(result.error, /is blocked(?: for computer use \(|: )a web browser: use the SynaBun browser tools .* Computer use never acts on a web browser: open and read web pages with the SynaBun browser tools/, label);
  };
  browserRefusal(await click(300, 300), 'a click in Chrome');
  browserRefusal(await click(1000, 300), 'a click in a MoreLogin profile window');
  browserRefusal(await h.desktop.act(h.grant, { action: 'type', text: 'hello' }), 'typing into the frontmost Chrome');
  browserRefusal(await h.desktop.act(h.grant, { action: 'key', text: 'cmd+l' }), 'a key into the frontmost Chrome');
  browserRefusal(await h.desktop.apps(h.grant, { action: 'focus', pid: 902 }), 'focus by pid');
  browserRefusal(await h.desktop.apps(h.grant, { action: 'focus', window_id: 3001 }), 'focus by window');
  browserRefusal(await h.desktop.apps(h.grant, { action: 'open', app: 'Google Chrome' }), 'open by name (the helper resolves it)');
  browserRefusal(await h.desktop.apps(h.grant, { action: 'open', app: 'com.google.Chrome' }), 'open by bundle id');
  const snapshot = await h.desktop.ax(h.grant, { action: 'snapshot', pid: 901 });
  browserRefusal(snapshot, 'a plain AX snapshot');
  assert.equal(snapshot.tree, undefined);
  // An installed web app (SynaBun's own included) is a browser too.
  browserRefusal(await h.desktop.apps(h.grant, { action: 'open', app: 'com.apple.Safari.WebApp.7EF0F3F3' }), 'open a web app');
  browserRefusal(await h.desktop.apps(h.grant, { action: 'focus', pid: 707 }), 'focus a web app');
  // MoreLogin's manager app shares the name "MoreLogin" and stays usable.
  const focus = await h.desktop.apps(h.grant, { action: 'focus', app: 'MoreLogin' });
  assert.equal(focus.ok, true, focus.error);
  const manager = await click(300, 700);
  assert.equal(manager.ok, true, manager.error);
  assert.equal(manager.app.bundleId, 'com.zixun.MoreLoginPlus');
  assert.equal((await click(1000, 700)).ok, true, 'TextEdit');
  const managerTree = await h.desktop.ax(h.grant, { action: 'snapshot', pid: 903 });
  assert.equal(managerTree.ok, true, managerTree.error);
  const state = await h.fake();
  assert.deepEqual(state.actions.filter((a) => a.cmd === 'click').length, 2, 'only the manager and TextEdit clicks happened');
  assert.equal(state.actions.some((a) => a.cmd === 'type' || a.cmd === 'key' || a.cmd === 'open_app'), false);
  assert.deepEqual(state.actions.filter((a) => a.cmd === 'focus_app').map((a) => a.pid), [903]);
  assert.equal(state.config.guard.blockedApps.at(-1).id, 'web-browsers');
});

// ── press by intent, end to end: service → manager → fake helper (verify) ───

// A tooltip longer than the snapshot keeps (200), decomposed (NFD), and an
// identifier longer than 120: the helper clips both, the service trims them,
// and verify must still recognise the element.
const LONG_HELP = 'Volta à página anterior nesta janela, a que estava aberta antes, como a seta para a esquerda no café. '.repeat(3);
const toolbar = (backOver = {}) => ({
  id: 'toolbar', role: 'AXToolbar', frame: { x: 700, y: 200, w: 600, h: 36 },
  children: [
    { id: 'back', role: 'AXButton', title: 'Back', help: 'Show the previous page', identifier: 'back-button', actions: ['AXPress'], frame: { x: 710, y: 206, w: 30, h: 24 }, ...backOver },
    { id: 'bold', role: 'AXButton', title: 'Bold', actions: ['AXPress'], frame: { x: 750, y: 206, w: 30, h: 24 } },
  ],
});
const body = { id: 'body', role: 'AXTextArea', title: 'Body', value: 'Dear team, VALUE-CANARY', frame: { x: 700, y: 240, w: 600, h: 400 } };
const saveSheet = {
  id: 'sheet', role: 'AXSheet', frame: { x: 800, y: 240, w: 400, h: 160 },
  children: [
    { id: 'dont-save', role: 'AXButton', title: "Don't Save", actions: ['AXPress'], frame: { x: 810, y: 360, w: 90, h: 24 } },
    { id: 'cancel', role: 'AXButton', title: 'Cancel', actions: ['AXPress'], frame: { x: 1000, y: 360, w: 80, h: 24 } },
    { id: 'save', role: 'AXButton', title: 'Save', actions: ['AXPress'], frame: { x: 1090, y: 360, w: 80, h: 24 } },
  ],
};
/** TextEdit's front window (the fake's window 1002, pid 303), optionally with the "save changes?" sheet open. */
const textEdit = ({ sheet = false, backOver = {} } = {}) => ({
  id: 'win', role: 'AXWindow', title: 'Notes.txt', subrole: 'AXStandardWindow', frame: { x: 700, y: 200, w: 600, h: 500 },
  children: [toolbar(backOver), body, ...(sheet ? [saveSheet] : [])],
});

function pressHarness(t, tree) {
  let stored = null;
  const configStore = createDesktopConfigStore({ get: () => stored, set: (key, value) => { stored = value; }, ttlMs: 0 });
  configStore.write({ settleMs: { default: 0, click: 0, key: 0, type: 0, scroll: 0, open: 0, drag: 0 }, userPauseMs: 40 });
  const manager = createDesktopHelperManager({ mode: 'fake', fakeOptions: { userInputIntervalMs: 0, frontmostPid: 303, axTrees: { 303: tree } }, backoffMs: [0], idleShutdownMs: 0 });
  const lock = { open: true };
  const desktop = createDesktopService({
    manager, configStore, platform: 'darwin', release: '25.6.0', desktopRisk, pressGate: () => lock.open,
    riskLexicon: { lexiconClass: browserRisk.lexiconClass, addressesAgent: browserRisk.addressesAgent },
    build: { resolveBinary: async () => { throw new Error('fake mode must not resolve a binary'); } },
  });
  desktop.attach({ runtime: { getComputerUse: () => true, abortTurn: async () => {}, notifySession: () => {} }, dispatcher: { stop: async () => {} } });
  t.after(() => desktop.shutdown());
  const grant = desktop.mintGrant({ kind: 'brain', assistantSessionId: 's1', provider: 'claude-code', vision: true });
  const fake = () => manager.request('__fake_state');
  const set = (args) => manager.request('__fake_set', args);
  const snapshot = (intent = 'go back') => desktop.ax(grant, { action: 'snapshot', intent, purpose: 'press' });
  const candidate = (res, name) => res.intent.candidates.find((c) => c.name === name);
  const press = (res, name = 'Back', intent = 'go back') => desktop.ax(grant, { action: 'press', press_context: res.intent.pressContext, candidate: candidate(res, name).id, intent, verdict: { choice: 0.95, match: 0.97, basis: 'test' } });
  const pressedCount = async () => (await fake()).actions.filter((a) => a.cmd === 'ax_action').length;
  return { desktop, manager, lock, grant, fake, set, snapshot, candidate, press, pressedCount };
}

test('press by intent end to end: an open sheet lists [in dialog] and allows no press; with it closed, exactly one verified ax_action', async (t) => {
  const h = pressHarness(t, textEdit({ sheet: true }));
  await ready(h);
  const withSheet = await h.snapshot("don't save");
  assert.equal(withSheet.ok, true, withSheet.error);
  assert.equal(withSheet.intent.dialogOpen, true);
  assert.equal(withSheet.intent.pressContext, null, 'nothing is pressed by intent while a sheet is open');
  assert.match(h.candidate(withSheet, "Don't Save").line, /^e\d+ AXButton "Don't Save" \(press\) \(in: sheet\) \[destructive\] \[in dialog\]$/);
  assert.equal(h.candidate(withSheet, 'Cancel').line.endsWith('(in: sheet) [in dialog]'), true);
  assert.ok(!JSON.stringify(withSheet).includes('VALUE-CANARY'), 'the document text never leaves');

  await h.set({ axTrees: { 303: textEdit() } });
  const snap = await h.snapshot();
  assert.match(snap.intent.pressContext, /^pc_/);
  assert.equal(h.candidate(snap, 'Back').pressable, true);
  assert.equal(h.candidate(snap, 'Bold').pressable, false);
  const pressed = await h.press(snap);
  assert.equal(pressed.ok, true, pressed.error);
  assert.match(pressed.summary, /^press e\d+ "Back" \(Jev\)$/);
  const state = await h.fake();
  const actions = state.actions.filter((a) => a.cmd === 'ax_action');
  assert.equal(actions.length, 1, 'exactly one ax_action');
  assert.deepEqual([actions[0].action, actions[0].verified], ['press', true]);
  const sent = state.received.filter((r) => r.cmd === 'ax_action');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].args.verify, { pid: 303, role: 'AXButton', subrole: null, title: 'Back', description: null, help: 'Show the previous page', identifier: 'back-button' });
});

test('press by intent end to end: a relabel after the snapshot is target_changed:title, a sheet that opened is target_changed:sheet; nothing is pressed', async (t) => {
  const h = pressHarness(t, textEdit());
  await ready(h);
  let snap = await h.snapshot();
  await h.set({ axPatch: [{ id: 'back', patch: { title: 'Delete All' } }] });
  const relabelled = await h.press(snap);
  assert.deepEqual([relabelled.code, relabelled.pressRejected, relabelled.actionStarted], ['PRESS_REFUSED', 'target_changed:title', false]);
  assert.equal(await h.pressedCount(), 0);

  await h.set({ axPatch: [{ id: 'back', patch: { title: 'Back' } }] });
  snap = await h.snapshot();
  assert.match(snap.intent.pressContext, /^pc_/);
  await h.set({ axPatch: [{ id: 'win', patch: { children: [toolbar(), body, saveSheet] } }] });
  const sheet = await h.press(snap);
  assert.deepEqual([sheet.code, sheet.pressRejected, sheet.actionStarted], ['PRESS_REFUSED', 'target_changed:sheet', false]);
  assert.equal(await h.pressedCount(), 0, 'the helper refused both before AXPress');
});

test('press by intent end to end: a tooltip longer than 200 characters (decomposed) and an identifier longer than 120 still verify', async (t) => {
  const h = pressHarness(t, textEdit({ backOver: { help: LONG_HELP, identifier: `id-${'x'.repeat(147)}` } }));
  await ready(h);
  assert.ok([...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(LONG_HELP)].length > 300 && LONG_HELP !== LONG_HELP.normalize('NFC'));
  const snap = await h.snapshot();
  assert.match(snap.intent.pressContext, /^pc_/, JSON.stringify(snap.intent.candidates.map((c) => [c.name, c.risk])));
  const pressed = await h.press(snap);
  assert.equal(pressed.ok, true, `no TARGET_CHANGED for a clipped label: ${pressed.error}`);
  const sent = (await h.fake()).received.find((r) => r.cmd === 'ax_action').args.verify;
  assert.equal([...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(sent.help)].length, 200, 'verify carries the snapshot\'s clipped copy');
  assert.equal(sent.identifier.length, 120);
  assert.equal(await h.pressedCount(), 1);
});

// ── The fence: a call admitted before control ended never reaches the helper after it ──

/** The helper holds `cmd` in flight until it is aborted (no clock: it ends only by an abort). */
const holdAtHelper = (h, cmd) => h.manager.request('__fake_set', { delayMs: { [cmd]: 3_600_000 } });
/** Barrier: the helper has received `cmd`, and `admitted` calls passed the gate (the rest wait in the queue). */
const reached = (h, cmd, admitted) => until(async () => (await h.fake()).received.some((r) => r.cmd === cmd) && h.desktop._internals.st.actionTimes.length >= admitted, `${cmd} in flight, ${admitted} admitted`);
const sentAfter = async (h, mark, cmds) => (await h.fake()).received.slice(mark).filter((r) => cmds.includes(r.cmd)).map((r) => r.cmd);
const MUTATIONS = ['click', 'move', 'drag', 'mouse_down', 'mouse_up', 'scroll', 'type', 'key', 'hold_key', 'open_app', 'focus_app', 'ax_action'];

const CONTROL_ENDS = [
  ['the session toggle goes off', (h) => h.desktop.onSessionToggle('s1', false), 'CONTROL_ENDED'],
  ['the owner is released (a turn ended, a brain went)', (h) => h.desktop.releaseOwner({ assistantSessionId: 's1' }), 'CONTROL_ENDED'],
  ['its grant is held again (a WhatsApp turn lost its approval)', (h) => { h.desktop.setGrantActive(h.grant, false); h.desktop.onSessionToggle('s1', false); }, 'FORBIDDEN'],
  ['its grant is revoked', (h) => { h.desktop.revokeFor({ token: h.grant }); h.desktop.releaseOwner({ assistantSessionId: 's1' }); }, 'FORBIDDEN'],
  ['Stop for this session', (h) => h.desktop.stop({ scope: 'session', assistantSessionId: 's1', reason: 'ui' }), 'CONTROL_ENDED'],
  ['Esc on the Mac', (h) => h.desktop._internals.onHelperEvent({ event: 'emergency_stop', reason: 'esc' }), 'STOPPED_BY_USER'],
  ['Stop everything', (h) => h.desktop.stop({ scope: 'all', reason: 'ui' }), 'STOPPED_BY_USER'],
];
for (const [name, end, lateCode] of CONTROL_ENDS) {
  test(`fence: ${name} → the action in flight is aborted, the queued ones never reach the helper, a later call is refused`, async (t) => {
    const h = harness(t);
    await ready(h);
    assert.equal((await h.desktop.act(h.grant, { action: 'screenshot' })).ok, true);
    await holdAtHelper(h, 'type');
    // One slow action in flight at the helper; three more admitted behind it: a key, an app and an AX operation.
    const slow = h.desktop.act(h.grant, { action: 'type', text: 'hello world' });
    const key = h.desktop.act(h.grant, { action: 'key', text: 'Return' });
    const open = h.desktop.apps(h.grant, { action: 'open', app: 'TextEdit' });
    const snap = h.desktop.ax(h.grant, { action: 'snapshot' });
    await reached(h, 'type', 5);
    const before = await h.fake();
    const mark = before.received.length;
    assert.equal(h.desktop._internals.st.inFlight?.action, 'type');

    await end(h);

    const results = await Promise.all([slow, key, open, snap]);
    for (const out of results) assert.equal(out.ok, false, JSON.stringify(out).slice(0, 200));
    assert.deepEqual(results.slice(1).map((out) => out.code), Array(3).fill(lateCode === 'FORBIDDEN' ? 'CONTROL_ENDED' : lateCode), 'the queued calls end with why');
    const after = await h.fake();
    assert.deepEqual(await sentAfter(h, mark, [...MUTATIONS, 'ax_snapshot', 'apps', 'windows', 'screenshot']), [], 'nothing of the admitted calls reached the helper after control ended');
    assert.ok(after.aborts > before.aborts, 'the command in flight was aborted');
    assert.equal(after.actions.filter((a) => a.cmd === 'key' || a.cmd === 'open_app').length, 0, 'no queued mutation was performed');
    assert.equal(h.desktop._internals.lease.current(), null, 'the lease is gone');
    assert.equal(h.desktop._internals.st.inFlight, null);
    // A call made after it is refused at the gate (a stop stays latched; a held or revoked grant is no grant).
    const late = await h.desktop.act(h.grant, { action: 'key', text: 'Tab' });
    if (lateCode === 'CONTROL_ENDED') assert.equal(late.ok, true, 'a desktop session whose control merely ended may start again: only what was admitted before is fenced');
    else assert.deepEqual([late.ok, late.code], [false, lateCode]);
  });
}

test('fence: a call still inside its gate when control ends is refused before it takes the lease', async (t) => {
  const h = harness(t);
  await ready(h);
  // The gate reads the grant, then awaits the helper; control ends in between (a held grant here).
  const real = h.manager.request.bind(h.manager);
  let release = null;
  const waiting = new Promise((done) => { release = done; });
  h.manager.request = async (cmd, ...rest) => { if (cmd === 'session_state') await waiting; return real(cmd, ...rest); };
  const call = h.desktop.act(h.grant, { action: 'key', text: 'Return' });
  await until(() => h.desktop._internals.st.permissionsAt > 0, 'the gate is past its grant check');
  h.desktop.onSessionToggle('s1', false);
  release();
  const out = await call;
  assert.deepEqual([out.ok, out.code], [false, 'CONTROL_ENDED']);
  assert.equal(h.desktop._internals.lease.current(), null, 'it never took the desktop');
  assert.equal((await h.fake()).actions.filter((a) => a.cmd === 'key').length, 0);
});

test('every operation is tracked: an app or AX operation in flight is aborted when control ends; a held button and key are released before the lease goes', async (t) => {
  for (const [label, cmd, start] of [
    ['an app operation', 'open_app', (h) => h.desktop.apps(h.grant, { action: 'open', app: 'TextEdit' })],
    ['an AX operation', 'ax_snapshot', (h) => h.desktop.ax(h.grant, { action: 'snapshot' })],
  ]) {
    const h = harness(t);
    await ready(h);
    await holdAtHelper(h, cmd);
    const op = start(h);
    await reached(h, cmd, 1);
    assert.ok(h.desktop._internals.st.inFlight, `${label} is the operation in flight`);
    const aborts = (await h.fake()).aborts;
    h.desktop.onSessionToggle('s1', false);
    const out = await op;
    assert.equal(out.ok, false, label);
    assert.equal((await h.fake()).aborts, aborts + 1, `${label}: aborted at the helper`);
    assert.equal(h.desktop._internals.lease.current(), null, label);
  }
  // Held input: nothing is in flight, the button is down. Ending control releases it (the helper's abort does), then the lease.
  for (const [label, end] of [
    ['the toggle', (h) => h.desktop.onSessionToggle('s1', false)],
    ['a released owner', (h) => h.desktop.releaseOwner({ assistantSessionId: 's1' })],
    ['a stop for the session', (h) => h.desktop.stop({ scope: 'session', assistantSessionId: 's1' })],
  ]) {
    const h = harness(t);
    await ready(h);
    const shot = await h.desktop.act(h.grant, { action: 'screenshot' });
    assert.equal(shot.ok, true);
    const down = await h.desktop.act(h.grant, { action: 'left_mouse_down', coordinate: toImage(1000, 450), return_screenshot: false });
    assert.equal(down.ok, true, down.error);
    assert.deepEqual((await h.fake()).held.buttons, ['left']);
    assert.equal(h.desktop._internals.st.inFlight, null, 'nothing is in flight');
    await end(h);
    await until(async () => (await h.fake()).held.buttons.length === 0, `${label}: the button released`);
    const state = await h.fake();
    assert.ok(state.actions.some((a) => a.cmd === 'release' && a.buttons.includes('left')), label);
    assert.equal(h.desktop._internals.lease.current(), null, label);
  }
});

test('a queued call is refused when the user became active while it waited', async (t) => {
  const h = harness(t);
  await ready(h);
  assert.equal((await h.desktop.act(h.grant, { action: 'screenshot' })).ok, true);
  await holdAtHelper(h, 'type');
  const slow = h.desktop.act(h.grant, { action: 'type', text: 'hello world' });
  const queued = h.desktop.act(h.grant, { action: 'key', text: 'Return' });
  await reached(h, 'type', 3);
  const mark = (await h.fake()).received.length;
  // The user moves the mouse while the key press waits its turn (it was admitted before that).
  await h.manager.request('__fake_simulate', { kind: 'mouse', x: 500, y: 500 });
  const [, late] = await Promise.all([slow, queued]);
  assert.deepEqual([late.ok, late.code], [false, 'USER_ACTIVE']);
  assert.ok(late.retryAfterMs > 0 && late.retryAfterMs <= USER_PAUSE_MS, `retryAfterMs ${late.retryAfterMs}`);
  assert.deepEqual(await sentAfter(h, mark, ['key']), [], 'the queued key press never reached the helper');
  assert.equal((await h.fake()).actions.filter((a) => a.cmd === 'key').length, 0);
  // Once the pause is over (the test's clock, not a sleep) the agent may act again.
  h.clock.advance(USER_PAUSE_MS + 1);
  await h.manager.request('__fake_set', { delayMs: 0 });
  assert.equal((await h.desktop.act(h.grant, { action: 'key', text: 'Return' })).ok, true);
});

test('an explicit release (computer_status release) releases held input and stops the operation in flight, for the session that holds the desktop only', async (t) => {
  // A held button: released before the lease is given up.
  let h = harness(t);
  await ready(h);
  assert.equal((await h.desktop.act(h.grant, { action: 'screenshot' })).ok, true);
  assert.equal((await h.desktop.act(h.grant, { action: 'left_mouse_down', coordinate: toImage(1000, 450), return_screenshot: false })).ok, true);
  assert.deepEqual((await h.fake()).held.buttons, ['left']);
  let out = await h.desktop.agentStatus(h.grant, { action: 'release' });
  assert.equal(out.summary, 'released the desktop');
  let state = await h.fake();
  assert.deepEqual(state.held.buttons, [], 'the button is no longer down');
  assert.ok(state.actions.some((a) => a.cmd === 'release' && a.buttons.includes('left')));
  assert.equal(h.desktop._internals.lease.current(), null);
  // An operation in flight at the release does not continue.
  h = harness(t);
  await ready(h);
  assert.equal((await h.desktop.act(h.grant, { action: 'screenshot' })).ok, true); // the helper is configured and the lease taken before the two calls race
  await holdAtHelper(h, 'type');
  const slow = h.desktop.act(h.grant, { action: 'type', text: 'hello world' });
  const queued = h.desktop.act(h.grant, { action: 'key', text: 'Return' });
  await reached(h, 'type', 3);
  const before = await h.fake();
  out = await h.desktop.agentStatus(h.grant, { action: 'release' });
  assert.equal(out.summary, 'released the desktop');
  assert.equal((await h.fake()).aborts, before.aborts + 1, 'the typing in flight was aborted by the release itself');
  const results = await Promise.all([slow, queued]);
  assert.deepEqual(results.map((r) => r.ok), [false, false], JSON.stringify(results.map((r) => [r.code, r.summary, r.error])));
  assert.deepEqual(await sentAfter(h, before.received.length, MUTATIONS), [], 'nothing more reached the helper');
  // A release by a session that does not hold the desktop touches neither the holder's operation nor its held input.
  h = harness(t);
  await ready(h);
  assert.equal((await h.desktop.act(h.grant, { action: 'screenshot' })).ok, true);
  assert.equal((await h.desktop.act(h.grant, { action: 'left_mouse_down', coordinate: toImage(1000, 450), return_screenshot: false })).ok, true);
  const other = h.desktop.mintGrant({ kind: 'brain', assistantSessionId: 's2', provider: 'claude-code', vision: true });
  const mine = await h.fake();
  out = await h.desktop.agentStatus(other, { action: 'release' });
  assert.equal(out.summary, 'you did not hold the desktop');
  state = await h.fake();
  assert.equal(state.aborts, mine.aborts, 'the holder was not aborted');
  assert.deepEqual(state.held.buttons, ['left'], 'its button is still down');
  assert.equal(h.desktop._internals.lease.current()?.owner.assistantSessionId, 's1', 'it still holds the desktop');
  const up = await h.desktop.act(h.grant, { action: 'left_mouse_up', return_screenshot: false });
  assert.equal(up.ok, true, `the holder goes on: ${up.error || ''}`);
  assert.deepEqual((await h.fake()).held.buttons, []);
});

test('an explicit release by a caller that is not the controller changes nothing for the controller: a worker that took its parent\'s lease keeps its admitted calls', async (t) => {
  const worker = (h) => h.desktop.mintGrant({ kind: 'run', runId: 'r1', assistantSessionId: 's1', provider: 'claude-code', vision: true });
  // The worker run takes its parent's lease, holds the left button and has a mouse-up admitted behind a slow operation.
  let h = harness(t);
  await ready(h);
  assert.equal((await h.desktop.act(h.grant, { action: 'screenshot' })).ok, true);
  let run = worker(h);
  assert.equal((await h.desktop.act(run, { action: 'screenshot' })).ok, true);
  assert.equal(h.desktop._internals.lease.current()?.owner.runId, 'r1', 'the worker holds the desktop now');
  assert.equal((await h.desktop.act(run, { action: 'left_mouse_down', coordinate: toImage(1000, 450), return_screenshot: false })).ok, true);
  await holdAtHelper(h, 'type');
  const slow = h.desktop.act(run, { action: 'type', text: 'hello world' });
  const up = h.desktop.act(run, { action: 'left_mouse_up', return_screenshot: false });
  await reached(h, 'type', 5);
  const before = await h.fake();
  // The parent session releases: it is not the controller.
  const out = await h.desktop.agentStatus(h.grant, { action: 'release' });
  assert.equal(out.summary, 'you did not hold the desktop');
  assert.equal((await h.fake()).aborts, before.aborts, 'the worker was not aborted');
  assert.deepEqual((await h.fake()).held.buttons, ['left']);
  assert.equal(h.desktop._internals.lease.current()?.owner.runId, 'r1', 'the lease is still the worker\'s');
  // The slow operation ends (the helper's own abort, sent here by the test: no control ended in the service).
  await h.manager.request('abort');
  const [, released] = await Promise.all([slow, up]);
  assert.equal(released.ok, true, `the worker's mouse-up was admitted before the parent's release and still runs: ${released.code || ''} ${released.error || ''}`);
  assert.deepEqual(await sentAfter(h, before.received.length, ['mouse_up']), ['mouse_up'], 'it reached the helper');
  assert.deepEqual((await h.fake()).held.buttons, []);
  assert.equal(h.desktop._internals.lease.current()?.owner.runId, 'r1', 'and the lease is consistent: still the worker\'s');

  // A release by the controller (here the worker itself) still aborts and releases.
  h = harness(t);
  await ready(h);
  assert.equal((await h.desktop.act(h.grant, { action: 'screenshot' })).ok, true);
  run = worker(h);
  assert.equal((await h.desktop.act(run, { action: 'screenshot' })).ok, true);
  assert.equal((await h.desktop.act(run, { action: 'left_mouse_down', coordinate: toImage(1000, 450), return_screenshot: false })).ok, true);
  const held = await h.fake();
  assert.deepEqual(held.held.buttons, ['left']);
  assert.equal((await h.desktop.agentStatus(run, { action: 'release' })).summary, 'released the desktop');
  const after = await h.fake();
  assert.equal(after.aborts, held.aborts + 1);
  assert.deepEqual(after.held.buttons, []);
  assert.equal(h.desktop._internals.lease.current(), null);

  // A stop for the session still fences its worker: session-wide fencing is unchanged.
  h = harness(t);
  await ready(h);
  assert.equal((await h.desktop.act(h.grant, { action: 'screenshot' })).ok, true);
  run = worker(h);
  assert.equal((await h.desktop.act(run, { action: 'screenshot' })).ok, true);
  assert.equal((await h.desktop.act(run, { action: 'left_mouse_down', coordinate: toImage(1000, 450), return_screenshot: false })).ok, true);
  await holdAtHelper(h, 'type');
  const typing = h.desktop.act(run, { action: 'type', text: 'hello world' });
  const queued = h.desktop.act(run, { action: 'key', text: 'Return' });
  await reached(h, 'type', 5);
  const mark = (await h.fake()).received.length;
  await h.desktop.stop({ scope: 'session', assistantSessionId: 's1', reason: 'ui' });
  const ended = await Promise.all([typing, queued]);
  assert.deepEqual(ended.map((r) => r.ok), [false, false]);
  assert.deepEqual(await sentAfter(h, mark, MUTATIONS), [], 'nothing of the worker\'s reached the helper after the stop');
  assert.deepEqual((await h.fake()).held.buttons, [], 'and its button was released');
});
