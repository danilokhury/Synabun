// What a re-attached Codex tab puts back after its history re-rendered, and
// what a new tab takes over from the tab beside it.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import {
  codexHeldServerRequests, codexNewTabAutoAccept, codexRequestIdentityKey,
  codexApprovalDecisionActions, shouldCodexAutoAcceptRequest, detachTerminalCodexAutomation,
} from '../public/shared/cdx/cdx-protocol.js';

const read = (name) => readFileSync(new URL(`../public/shared/cdx/${name}`, import.meta.url), 'utf8');
const APPROVAL = 'item/fileChange/requestApproval';
const approval = (requestId, extra = {}) => ({
  type: 'server_request', requestId, method: APPROVAL, sessionId: 'session', connectionEpoch: 'epoch-1',
  threadId: 'thread-a', turnId: 'turn-1', params: { threadId: 'thread-a', turnId: 'turn-1', itemId: `patch-${requestId}` }, ...extra,
});

test('a new tab takes AUTO from the person\'s own tab, never from an automation tab', () => {
  const automation = { automationRunId: 'run-1', autoAccept: true };
  assert.equal(codexNewTabAutoAccept({}, automation, false), false, 'the run switched that AUTO on, not the person');
  assert.equal(codexNewTabAutoAccept({}, automation, true), true, 'what the person stored as their default still applies');
  assert.equal(codexNewTabAutoAccept({}, { automationRunId: 'run-1', autoAccept: false }, true), true);
  assert.equal(codexNewTabAutoAccept({}, { autoAccept: true }, false), true, 'the person\'s own tab hands its AUTO on, as before');
  assert.equal(codexNewTabAutoAccept({}, { autoAccept: false }, true), false);
  assert.equal(codexNewTabAutoAccept({}, null, true), true);
  assert.equal(codexNewTabAutoAccept({}, null, false), false);
  // A tab restored or created with its own value keeps it: the automation tab itself, a saved tab.
  assert.equal(codexNewTabAutoAccept({ autoAccept: true }, null, false), true);
  assert.equal(codexNewTabAutoAccept({ autoAccept: false }, { autoAccept: true }, true), false);
  assert.equal(codexNewTabAutoAccept({ autoAccept: true }, automation, false), true);

  const tabs = read('cdx-tabs.js');
  assert.match(tabs, /const inheritedAutoAccept = codexNewTabAutoAccept\(saved, activeTab\(\), storedAutoAccept\(\)\);/);
  assert.match(tabs, /function storedAutoAccept\(\) \{\n\s+return storage\.getItem\(STOR\.autoAccept\) === 'true';/);
  assert.doesNotMatch(tabs, /activeTab\(\)\?\.autoAccept \?\?/);
});

test('only requests of the current connection and the shown thread are held for a history render', () => {
  const tab = { id: 'session', connectionEpoch: 'epoch-1', threadId: 'thread-a', activeTurnId: 'turn-1', ownedThreadIds: new Set(['thread-child']) };
  const held = new Map([
    ['0', approval(0)],
    ['1', approval(1, { connectionEpoch: 'epoch-0' })],
    ['2', approval(2, { threadId: 'thread-b', params: { threadId: 'thread-b' } })],
    ['3', approval(3, { threadId: 'thread-child', params: { threadId: 'thread-child' } })],
    ['4', approval(4, { turnId: 'turn-0', params: { threadId: 'thread-a', turnId: 'turn-0' } })],
    ['5', approval(5, { sessionId: 'other-session' })],
  ]);
  assert.deepEqual(codexHeldServerRequests(held, tab).map(request => request.requestId), [0, 3],
    'not one from before the re-attach, from another thread, from an earlier turn or from another tab');
  assert.deepEqual(codexHeldServerRequests(held, { ...tab, connectionEpoch: 'epoch-2' }), [],
    'a re-attach replays what the bridge still holds: anything not sent again is gone');
  assert.deepEqual(codexHeldServerRequests(held, { ...tab, activeTurnId: null }).map(request => request.requestId), [0, 3, 4],
    'a reloaded page does not know the turn yet');
  assert.deepEqual(codexHeldServerRequests(undefined, tab), []);
  assert.deepEqual(codexHeldServerRequests(new Map(), tab), []);
});

// The request module's own code, with its cards replaced by a stand-in registry entry.
function loadRequests({ autoAccept = false } = {}) {
  const source = read('cdx-requests.js');
  const tab = { id: 'session', connectionEpoch: 'epoch-1', threadId: 'thread-a', activeTurnId: 'turn-1', autoAccept, sessionLabel: 'Fixture' };
  const packets = [], rendered = [], blocking = [], systems = [], removed = [];
  const requestCards = new Map();
  let tokens = 0;
  const transcript = [];
  // Map and Object are this realm's, so what the module builds compares with what the test expects.
  const context = vm.createContext({
    Map, Object, console: { info() {} }, crypto: { randomUUID: () => `token-${++tokens}` },
    sessionStorage: { setItem() {}, getItem: () => null, removeItem() {} },
    notify() {}, NOTIF_TYPE: { ACTION: 'action', ASK: 'ask' },
    codexRequestIdentityKey, codexHeldServerRequests, codexApprovalDecisionActions, shouldCodexAutoAcceptRequest,
    isCodexMcpToolApproval: () => false,
  });
  vm.runInContext(source.slice(source.indexOf('const _pendingReplyAcks')).replaceAll('export function ', 'function '), context);
  context.renderApprovalRequest = (requestId) => {
    if (requestCards.has(String(requestId))) return;
    const entry = { card: { querySelectorAll: () => [] }, pillEl: { textContent: 'waiting' } };
    requestCards.set(String(requestId), entry);
    rendered.push(requestId);
  };
  context.setRequestsContext({
    get boundTab() { return tab; }, get connectionEpoch() { return tab.connectionEpoch; },
    requestCards, scheduleThreadSnapshotSave() {}, appendSystem: text => systems.push(text),
    messagesEl: { querySelectorAll: () => transcript.map(requestId => ({ dataset: { requestId }, remove: () => removed.push(requestId) })) },
    sendSocket: packet => { packets.push(packet); return true; },
    isBlockingServerRequest: method => method === APPROVAL,
    onBlockingServerRequestStart: requestId => blocking.push(requestId),
    onBlockingServerRequestAnswered() {},
  });
  // What the history message does to the tab: the transcript and its registry are rebuilt.
  const history = () => {
    const held = context.heldServerRequests();
    requestCards.clear();
    context.restoreServerRequests(held);
  };
  return { context, tab, packets, rendered, blocking, systems, removed, requestCards, transcript, history };
}

test('a held request is put back after a history render, once, in either order, without being answered', () => {
  const { context, tab, packets, rendered, blocking, requestCards, history } = loadRequests();
  context.handleServerRequest(approval(0));
  assert.deepEqual([rendered, [...tab.heldServerRequests.keys()], packets], [[0], ['0'], []]);
  history();
  assert.deepEqual(rendered, [0, 0], 'the replayed request came first: the history wiped its card and it is rendered again');
  assert.deepEqual(blocking, [0, 0], 'and the tab waits on it again');
  assert.equal(requestCards.size, 1);

  // The history first, then the request; then a second replay of the same request.
  history();
  context.handleServerRequest(approval(1));
  context.handleServerRequest(approval(1));
  assert.deepEqual(rendered, [0, 0, 0, 1], 'a card that is on screen is not rendered a second time');
  context.restoreServerRequests(context.heldServerRequests());
  assert.deepEqual(rendered, [0, 0, 0, 1]);
  assert.equal(requestCards.size, 2);

  // AUTO switched on while the cards wait: restoring is rendering, never answering.
  tab.autoAccept = true;
  history();
  assert.deepEqual(rendered, [0, 0, 0, 1, 0, 1]);
  assert.deepEqual(packets, [], 'nothing was sent for a request the person has not answered');
});

test('replay answers by itself only when the tab\'s AUTO is on', () => {
  const off = loadRequests({ autoAccept: false });
  off.context.handleServerRequest(approval(0, { recoveryStatus: 'pending' }));
  assert.deepEqual([off.packets, off.rendered], [[], [0]]);

  const on = loadRequests({ autoAccept: true });
  on.context.handleServerRequest(approval(0, { recoveryStatus: 'pending' }));
  assert.deepEqual(on.packets.map(packet => [packet.type, packet.requestId, packet.result.decision]), [['server_request_response', 0, 'acceptForSession']]);
  assert.deepEqual(on.rendered, []);
  // Its answer is on the way: the history that follows neither shows a card nor answers again.
  on.history();
  assert.deepEqual([on.packets.length, on.rendered, on.systems], [1, [], ['Auto-accepted: fileChange']]);
  on.context.handleServerRequestResponseResult({ responseToken: 'token-1', ok: true, status: 'answered' });
  assert.deepEqual([...on.tab.heldServerRequests.keys()], []);
});

test('a request that was answered, resolved or dropped is not held any more', () => {
  const { context, tab, packets, rendered, history } = loadRequests();
  const held = () => [...tab.heldServerRequests.keys()];
  for (const id of [0, 1, 2, 3]) context.handleServerRequest(approval(id));
  assert.deepEqual(held(), ['0', '1', '2', '3']);

  context.resolveRequestCard(0, 'resolved');
  assert.deepEqual(held(), ['1', '2', '3'], 'serverRequest/resolved');
  context.sendServerRequestReply(1, { result: { decision: 'decline' }, label: 'declined' });
  assert.deepEqual(held(), ['1', '2', '3'], 'held until the bridge acknowledges the answer');
  context.handleServerRequestResponseResult({ responseToken: 'token-1', ok: true, status: 'answered' });
  assert.deepEqual(held(), ['2', '3']);
  context.sendServerRequestReply(2, { result: { decision: 'accept' } });
  context.handleServerRequestResponseResult({ responseToken: 'token-2', ok: false, status: 'turn_canceled', error: 'This Codex request is no longer pending' });
  assert.deepEqual(held(), ['3'], 'the bridge no longer has it');
  context.sendServerRequestReply(3, { result: { decision: 'accept' } });
  context.handleServerRequestResponseResult({ responseToken: 'token-3', ok: false, status: 'delivery_failed', retryable: true });
  assert.deepEqual(held(), ['3'], 'a failed delivery leaves it to be answered again');

  const before = rendered.length;
  history();
  assert.deepEqual(rendered.slice(before), [3], 'only what is still held comes back');
  assert.equal(packets.length, 3);
});

test('an answer that never reached the bridge does not hide the replayed request; a saved copy of the card goes', () => {
  const { context, tab, packets, rendered, removed, transcript, history } = loadRequests();
  context.handleServerRequest(approval(0));
  context.sendServerRequestReply(0, { result: { decision: 'accept' } });
  history();
  assert.deepEqual(rendered, [0], 'an answer on its way on this connection: the card is not put back as waiting');

  // The socket dropped before the bridge saw the answer; it replays the request on the next one.
  tab.connectionEpoch = 'epoch-2';
  assert.deepEqual(context.heldServerRequests(), [], 'before the replay nothing is known to be held');
  context.handleServerRequest(approval(0, { connectionEpoch: 'epoch-2', recoveryStatus: 'pending' }));
  assert.deepEqual(rendered, [0, 0], 'the replay shows the card again');
  transcript.push('0', '7');
  history();
  assert.deepEqual(rendered, [0, 0, 0], 'and the history after it puts it back: the old answer is not on its way any more');
  assert.deepEqual(removed, ['0'], 'the dead copy of this card in a saved rendering is dropped, other cards stay');
  assert.equal(packets.length, 1);
});

test('the history handler reads the held requests before it renders and restores them after', () => {
  const tabs = read('cdx-tabs.js');
  const handler = tabs.slice(tabs.indexOf('    onHistory(msg) {'), tabs.indexOf('    onThreadList(msg) {'));
  const held = handler.indexOf('const heldRequests = heldServerRequests();');
  const render = handler.indexOf('renderHistory(msg.thread, msg.fallbackItems || null);');
  const owned = handler.indexOf('_boundTab.ownedThreadIds = new Set()');
  const restore = handler.indexOf('restoreServerRequests(heldRequests);');
  assert.ok(held > 0 && held < owned && owned < render && render < restore, 'held → render → restore');
  assert.ok(handler.indexOf('clearTranscript();') < restore, 'a history without a thread restores them as well');
  // The turn ending drops what was held for it; request 0 is a request like any other.
  const cleared = tabs.slice(tabs.indexOf('function clearAllBlockingServerRequests() {'), tabs.indexOf('function shouldBufferSocketMessage('));
  assert.match(cleared, /_boundTab\?\.heldServerRequests\?\.clear\(\);\n\s+if \(!_blockingServerRequests\.size/);
  assert.doesNotMatch(tabs, /function (?:rememberBlockingServerRequest|clearBlockingServerRequest)\([^)]*\) \{\n(?:\s+\/\/[^\n]*\n)?\s+if \(!requestId\) return;/);
  // Restoring renders only: the reply path is not reachable from it.
  const requests = read('cdx-requests.js');
  const restoreSource = requests.slice(requests.indexOf('export function restoreServerRequests('));
  assert.doesNotMatch(restoreSource, /sendServerRequestReply|autoAccept|handleServerRequest\(/);
});

test('Escape inside the panel is handled before the page takes it; a re-attached turn does not read Ready', () => {
  // The whiteboard takes Escape at the document unless a text field has the focus, and a
  // waiting request disables the composer: keys from inside the panel are handled at the window.
  const panel = read('cdx-panel.js');
  assert.match(panel, /function _cdxPanelEscHandler\(event\) \{\n\s+if \(_panel\?\.contains\(event\.target\)\) _cdxDocEscHandler\(event\);/);
  assert.match(panel, /window\.addEventListener\('keydown', _cdxPanelEscHandler, \{ capture: true \}\);\n\s+document\.addEventListener\('keydown', _cdxDocEscHandler, \{ capture: true \}\);/);
  assert.match(panel, /window\.removeEventListener\('keydown', _cdxPanelEscHandler, \{ capture: true \}\);/);
  const tabs = read('cdx-tabs.js');
  const ready = tabs.slice(tabs.indexOf('    onReady(msg) {'), tabs.indexOf('    onHistory(msg) {'));
  assert.match(ready, /if \(_running\) syncWorkStatus\(\);\n\s+else setStatus\('Ready', 'ready'\);/);
});

test('a released automation tab goes back to the stored AUTO default; the person\'s own tab is not touched', () => {
  const run = () => ({ automationRunId: 'run-1', automationActive: false, automationOwnerId: 'window-a', autoAccept: true });
  const released = run();
  assert.equal(detachTerminalCodexAutomation(released, false), 'run-1');
  assert.deepEqual([released.automationRunId, released.autoAccept], [null, false], 'the run switched that AUTO on: it ends with the run');
  const kept = run();
  assert.equal(detachTerminalCodexAutomation(kept, true), 'run-1');
  assert.equal(kept.autoAccept, true, 'the person stored AUTO on as their default');
  assert.equal(codexNewTabAutoAccept({}, released, false), false, 'and a new tab beside the released one does not get the run\'s AUTO either');

  const own = { automationRunId: null, autoAccept: true };
  assert.equal(detachTerminalCodexAutomation(own, false), '');
  assert.equal(own.autoAccept, true, 'a tab the person set to AUTO is not an automation tab: nothing to release');
  const running = { automationRunId: 'run-2', automationActive: true, autoAccept: true };
  assert.equal(detachTerminalCodexAutomation(running, false), '');
  assert.equal(running.autoAccept, true, 'a run that is still going keeps its tab');

  // The panel releases with the stored default, relights the toggle of the shown tab and saves the tabs;
  // the prompt that releases the tab already goes out with the person's AUTO.
  const tabs = read('cdx-tabs.js');
  const release = tabs.slice(tabs.indexOf('function releaseAutomationForManualUse('), tabs.indexOf('function captureCompletedPlanItem('));
  assert.match(release, /detachTerminalCodexAutomation\(tab, storedAutoAccept\(\)\);[\s\S]*if \(isActiveTab\(tab\)\) syncToolbarState\(\);\n\s+saveTabs\(\);/);
  assert.doesNotMatch(release, /storage\.setItem/, 'releasing never rewrites the person\'s default');
  assert.match(tabs, /autoAccept: tab\?\.automationRunId \? storedAutoAccept\(\) : !!tab\?\.autoAccept,/);
});

test('the whiteboard leaves keys pressed inside any side panel alone', () => {
  // The whiteboard file has CRLF line endings.
  const board = readFileSync(new URL('../public/shared/ui-whiteboard.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const start = board.indexOf('export function isSidepanelKeyTarget(');
  const predicate = board.slice(start, board.indexOf('\n}\n', start) + 3).replace('export function ', 'function ');
  const isSidepanelKeyTarget = vm.runInNewContext(`${predicate}; isSidepanelKeyTarget`);
  // What closest() answers for a control inside a panel root, for the root itself and for the board.
  const inside = (provider) => ({ closest: selector => (selector === '[data-sidepanel-provider]' ? { dataset: { sidepanelProvider: provider } } : null) });
  for (const provider of ['claude', 'codex', 'opencode', 'assistant']) assert.equal(isSidepanelKeyTarget(inside(provider)), true, provider);
  assert.equal(isSidepanelKeyTarget({ closest: () => null }), false, 'the board, the body, a workspace window');
  assert.equal(isSidepanelKeyTarget(null), false);
  assert.equal(isSidepanelKeyTarget({}), false);

  // It backs off before any key is looked at: Escape, Delete, Backspace and the Ctrl/Cmd combos all come later.
  const handler = board.slice(board.indexOf('function onKeyDown(e) {'), board.indexOf('// EVENT HANDLERS — PASTE'));
  const backOff = handler.indexOf('if (isSidepanelKeyTarget(e.target) || isSidepanelKeyTarget(ae)) return;');
  assert.ok(backOff > 0);
  for (const key of ["e.key === 'Escape'", "e.key === 'Delete'", 'e.ctrlKey || e.metaKey', 'stopImmediatePropagation']) {
    assert.ok(handler.indexOf(key) > backOff, `${key} is handled after the back-off`);
  }
  // Every panel root carries the attribute: registerSidepanel sets it, and all three panels register.
  const shared = name => readFileSync(new URL(`../public/shared/${name}`, import.meta.url), 'utf8');
  assert.match(shared('ui-sidepanel-windows.js'), /element\.dataset\.sidepanelProvider = provider;/);
  assert.match(shared('ui-claude-panel.js'), /registerSidepanel\(\{\s+owner: PANEL_OWNER, provider: 'claude', element: _panel,/);
  assert.match(shared('cdx/cdx-panel.js'), /registerSidepanel\(\{\s+owner: PANEL_OWNER, provider: 'codex', element: _panel,/);
  assert.match(shared('ocp-v2/ocp-v2-panel.js'), /registerSidepanel\(\{\s+owner: PANEL_OWNER, provider: 'opencode', element: panel,/);
});
