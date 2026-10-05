// Smoke run of the OpenCode panel's glue code under a DOM stand-in. Run by
// opencode-panel-smoke.test.mjs in a child process (the panel keeps timers
// alive, so it must not share a process with the test runner).
// Prints one line per step and ends with "no problems" or the list of them.
import { installDom, makeNode } from './opencode-panel-dom.fixtures.mjs';
const { doc, FakeWS } = installDom();
const base = new URL('../public/shared/ocp-v2/', import.meta.url).href;
const problems = [];
process.on('unhandledRejection', (err) => problems.push(`unhandledRejection: ${err?.stack?.split('\n').slice(0, 3).join(' | ') || err}`));
const step = async (name, fn) => { try { await fn(); console.log('ok  ', name); } catch (err) { problems.push(`${name}: ${err?.stack?.split('\n').slice(0, 4).join(' | ')}`); console.log('FAIL', name, '-', err?.message); } };
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

let state, render, send, ws, widgets, changes, status, tools, autoaccept, mention;
await step('import state', async () => { state = await import(base + 'ocp-v2-state.js'); });
await step('import ws', async () => { ws = await import(base + 'ocp-v2-ws.js'); });
await step('import render', async () => { render = await import(base + 'ocp-v2-render.js'); });
await step('import send', async () => { send = await import(base + 'ocp-v2-send.js'); });
await step('import widgets', async () => { widgets = await import(base + 'ocp-v2-session-widgets.js'); });
await step('import changes', async () => { changes = await import(base + 'ocp-v2-changes.js'); });
await step('import status', async () => { status = await import(base + 'ocp-v2-status.js'); });
await step('import autoaccept', async () => { autoaccept = await import(base + 'ocp-v2-autoaccept-button.js'); });
await step('import panel barrel', async () => { await import(base + '../ui-opencode-panel-v2.js'); });

const store = state.createPanelStore();
store.setSession('ses_1', { id: 'ses_1', title: 'Smoke', directory: '/work/app', cost: 0.12, summary: { files: 2, additions: 3, deletions: 1 } });
const panel = makeNode('div'); doc.body.appendChild(panel);
const messages = makeNode('div'); panel.appendChild(messages);
let renderer, composer, envCtl;
await step('mountRenderer', async () => {
  renderer = render.mountRenderer(messages, store, { onOpenSession() {}, onComposeText() {}, onSendText: async () => true, onOpenChild() {} });
});
await step('mount widgets', async () => {
  widgets.mountTodoWidget(panel, store);
  changes.mountChangesBar(panel, store); envCtl = status.mountEnvironmentPopover(panel, store, { onAttachPath: (path) => composer.appendPath(path) }); autoaccept.createAutoAcceptControl(store);
});
await step('mountCompose', async () => {
  const compose = makeNode('div'); panel.appendChild(compose);
  composer = send.mountCompose(compose, store, { pickers: false, slashActions: { new() {}, sessions() {} } });
});

// OCP_SMOKE_SERVER=old: a server that predates the capability list advertises
// nothing, and the panel has to mount, render and take input all the same.
const reqMod = await import(new URL('../lib/opencode-v2-ws-requests.js', import.meta.url).href);
const OLD_SERVER = process.env.OCP_SMOKE_SERVER === 'old';
const advertised = OLD_SERVER ? [] : reqMod.opencodeV2WsCapabilities();
ws.capabilities.set(advertised);
console.log('    ', OLD_SERVER ? 'old server: no capabilities' : `capabilities: ${advertised.length}`);

await step('render a full transcript', async () => {
  store.upsertMessage({ id: 'u1', role: 'user', time: { created: 1 } });
  store.upsertPart({ id: 'u1p', messageID: 'u1', type: 'text', text: 'fix the bug' });
  store.upsertPart({ id: 'u1f', messageID: 'u1', type: 'file', mime: 'text/plain', filename: 'a.js', url: 'file:///work/app/a.js' });
  store.upsertPart({ id: 'u1s', messageID: 'u1', type: 'text', text: 'synthetic', synthetic: true });
  store.upsertMessage({ id: 'a1', role: 'assistant', parentID: 'u1', modelID: 'm', providerID: 'p', agent: 'build', cost: 0.01, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, completed: 2000 } });
  const parts = [
    { type: 'step-start' }, { type: 'reasoning', text: 'thinking about it', time: { start: 1 } },
    { type: 'reasoning', text: 'done thinking', time: { start: 1, end: 2 } },
    { type: 'text', text: '# Title\n\n```js\nconst a = 1;\n```\n<img src=x onerror=alert(1)>' },
    { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed', input: { command: 'ls' }, output: 'a\nb', metadata: { output: 'a\nb' }, time: { start: 1, end: 5 } } },
    { type: 'tool', tool: 'edit', callID: 'c2', state: { status: 'completed', input: { filePath: '/work/app/a.js', oldString: 'a', newString: 'b' }, metadata: { diff: '@@ -1 +1 @@\n-a\n+b' } } },
    { type: 'tool', tool: 'task', callID: 'c3', state: { status: 'running', input: { description: 'explore', prompt: 'look', subagent_type: 'explore' }, metadata: { sessionId: 'ses_child' } } },
    { type: 'tool', tool: 'todowrite', callID: 'c4', state: { status: 'completed', input: { todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'pending' }] } } },
    { type: 'tool', tool: 'mcp__SynaBun__recall', callID: 'c5', state: { status: 'completed', input: { query: 'x' }, output: 'memories' } },
    { type: 'tool', tool: 'github_search', callID: 'c6', state: { status: 'error', input: { q: 'x' }, error: 'boom' } },
    { type: 'tool', tool: 'read', callID: 'c7', state: { status: 'completed', input: { filePath: '/work/app/a.js' }, output: 'x', attachments: [{ mime: 'image/png', url: 'data:image/png;base64,AA', filename: 's.png' }] } },
    { type: 'file', mime: 'image/png', filename: 'i.png', url: 'data:image/png;base64,AA' },
    { type: 'subtask', agent: 'explore', description: 'Find', prompt: 'p' }, { type: 'agent', name: 'plan' },
    { type: 'patch', hash: 'h', files: ['/a/b.js'] }, { type: 'retry', attempt: 2, error: { name: 'APIError', data: { message: 'Overloaded', isRetryable: true } } },
    { type: 'snapshot', snapshot: 's' }, { type: 'weird-new-part' }, { type: 'step-finish' },
  ];
  parts.forEach((part, i) => store.upsertPart({ id: `a1p${i}`, messageID: 'a1', index: i, ...part }));
  store.upsertMessage({ id: 'u2', role: 'user', time: { created: 3 } });
  store.upsertPart({ id: 'u2c', messageID: 'u2', type: 'compaction', auto: true });
  store.upsertMessage({ id: 'a2', role: 'assistant', summary: true, parentID: 'u2', time: { created: 3, completed: 4 }, error: { name: 'ContextOverflowError', data: { message: 'too long' } } });
  store.upsertPart({ id: 'a2p', messageID: 'a2', type: 'text', text: 'summary' });
  store.upsertMessage({ id: 'a3', role: 'assistant', time: { created: 5, completed: 6 }, error: { name: 'ProviderAuthError', data: { providerID: 'p', message: 'no key' } } });
  store.upsertMessage({ id: 'a4', role: 'assistant', time: { created: 5, completed: 6 }, error: { name: 'MessageAbortedError', data: { message: 'x' } } });
  renderer.render();
});
await step('cards, banners, queue', async () => {
  store.addPendingPermission({ id: 'per_1', sessionID: 'ses_1', permission: 'bash', patterns: ['git status'], metadata: {}, always: ['git *'], tool: { messageID: 'a1', callID: 'c1' } });
  store.addPendingPermission({ id: 'per_2', sessionID: 'ses_child', permission: 'edit', patterns: ['a.js', 'b.js'], metadata: { diff: 'x', filepath: 'a.js' }, always: [] });
  store.addPendingPermission({ id: 'per_3', sessionID: 'ses_1', permission: 'webfetch', patterns: ['https://x'], metadata: {}, _auto: true });
  store.addPendingQuestion({ id: 'que_1', sessionID: 'ses_1', questions: [{ question: 'Which?', header: 'Pick', options: [{ label: 'A', description: 'a' }], multiple: true, custom: true }] });
  store.setSessionStatus({ type: 'retry', attempt: 2, message: 'Overloaded', next: Date.now() + 5000, action: { label: 'Top up', link: 'https://opencode.ai', message: 'Add credits' } });
  store.pushError({ message: 'something failed' });
  store.setSessionInfo({ id: 'ses_1', revert: { messageID: 'u2', diff: 'd' }, share: { url: 'https://opncd.ai/s/x' } });
  store.setTodos([{ content: 'One', status: 'in_progress' }, { content: 'Two', status: 'pending' }]);
  store.setSessionDiff([{ file: 'a.js', patch: '@@ -1 +1 @@\n-a\n+b', additions: 1, deletions: 1, status: 'modified' }]);
  store.setPostPlanActions(true, 'PLAN COMPLETE'); store.setPlanContent('# plan');
  store.setCompacting(true); store.setAutoAccept(true);
  renderer.render();
  await tick();
});
const walk = (n, fn) => { fn(n); for (const c of n.children || []) walk(c, fn); };
await step('click everything clickable in the transcript and widgets', async () => {
  const clicked = [];
  walk(panel, (n) => { if (n.tagName === 'BUTTON' || n.tagName === 'SUMMARY' || String(n.className).includes('ocpv2-tool-head')) clicked.push(n); });
  for (const n of clicked) {
    const cls = String(n.className);
    // Not the ones that send real decisions through the (fake) socket and await forever.
    try { n._fire('click'); n._fire('mousedown'); } catch (err) { throw new Error(`click on ${n.tagName}.${cls} "${String(n.textContent).slice(0, 30)}": ${err.stack.split('\n').slice(0, 3).join(' | ')}`); }
  }
  await tick(60);
  renderer.render();
  console.log('     clicked', clicked.length, 'elements');
});
await step('composer: keys, shell mode, slash, queue, history, files', async () => {
  let input = null; walk(panel, (n) => { if (n.tagName === 'TEXTAREA') input = n; });
  if (!input) throw new Error('no textarea');
  const key = (k, extra = {}) => input._fire('keydown', { key: k, isTrusted: true, isComposing: false, shiftKey: false, ...extra });
  const type = (text) => { input.value = text; input.selectionStart = input.selectionEnd = text.length; input._fire('input', { isTrusted: true }); };
  key('!');                                  // enter shell mode
  type('git status'); key('Escape');          // leave
  type('/'); key('ArrowDown'); key('Escape');
  type('@sr'); await tick(200); key('Escape');
  type('/help'); key('Enter'); await tick();
  // /help is a card of the panel's own under the transcript: the box is not
  // refilled with "/", and nothing is queued or sent for it.
  if (!store.getState().helpCard?.sections?.length) throw new Error('/help showed no card');
  if (input.value !== '') throw new Error(`/help put "${input.value}" into the box`);
  type(''); key('ArrowUp'); key('ArrowDown');
  key('Tab', { shiftKey: true });
  store.setRunning(true);
  type('queued prompt'); key('Enter'); await tick();
  key('Escape'); key('Escape'); await tick();
  store.setRunning(false);
  input._fire('paste', { clipboardData: { files: [{ name: 'a.png', type: 'image/png', size: 10 }] } });
  await tick(50);
  composer.setText('programmatic'); composer.appendPath('/work/app/x.js');
  type('hello'); key('Enter'); await tick(50);
  store.setRunning(false);
  renderer.render();
});
await step('events through the socket layer', async () => {
  const sock = FakeWS.last;
  if (!sock) throw new Error('no socket was opened');
  sock.readyState = 1; sock._emit('open');
  const emit = (eventType, event) => sock._emit('message', { data: JSON.stringify({ type: 'event', eventType, event }) });
  if (!OLD_SERVER) sock._emit('message', { data: JSON.stringify({ type: 'capabilities', capabilities: advertised }) });
  ws.subscribeSession('ses_1', store);
  emit('message.part.delta', { sessionID: 'ses_1', messageID: 'a9', partID: 'p9', field: 'text', delta: 'hi' });
  emit('session.status', { sessionID: 'ses_1', status: { type: 'busy' } });
  emit('permission.asked', { id: 'per_9', sessionID: 'ses_1', permission: 'bash', patterns: ['ls'], metadata: {}, always: [] });
  emit('permission.replied', { sessionID: 'ses_1', requestID: 'per_9', reply: 'once' });
  emit('todo.updated', { sessionID: 'ses_1', todos: [] });
  emit('session.diff', { sessionID: 'ses_1', diff: [] });
  emit('session.compacted', { sessionID: 'ses_1' });
  emit('session.error', { error: { name: 'UnknownError', data: { message: 'x' } } });
  emit('session.error', { sessionID: 'ses_1', error: { name: 'MessageAbortedError', data: { message: 'x' } } });
  emit('installation.update-available', { version: '9.9.9' });
  emit('vcs.branch.updated', { branch: 'main' });
  emit('catalog.updated', {});
  emit('mcp.browser.open.failed', { mcpName: 'gh', url: 'https://x' });
  emit('session.idle', { sessionID: 'ses_1' });
  emit('sync', { type: 'sync', syncEvent: {} });
  await tick(400);
  renderer.render();
  // Nothing the old server does not know may have been sent to it.
  const known = new Set(reqMod.OPENCODE_V2_WS_INLINE_TYPES.concat(['session:context', 'session:compact', 'permission:reply', 'question:reply']));
  const sentTypes = (sock.sent || []).map((raw) => { try { return JSON.parse(raw).type; } catch { return '?'; } });
  if (OLD_SERVER) {
    const unknown = sentTypes.filter((type) => !known.has(type));
    if (unknown.length) throw new Error(`sent to a server that does not know them: ${[...new Set(unknown)].join(', ')}`);
  }
  console.log('     request types sent:', [...new Set(sentTypes)].join(', ') || '(none)');
});
// Run 2: the glue that only runs once the server answers. The stand-in socket
// now replies to the request types the (new) server advertises.
const CANNED = {
  'mcp:status': [{ name: 'SynaBun', status: 'connected', managed: true }, { name: 'gh', status: 'needs_auth', managed: false }],
  'mcp:add': [{ name: 'SynaBun', status: 'connected', managed: true }, { name: 'docs', status: 'connected', managed: false }],
  'env:status': { lsp: [], formatter: [], references: [{ name: 'styleguide', path: '/refs/styleguide', description: 'House style' }] },
  'find:files': ['src/run.js'],
  'find:symbols': [{ name: 'runPipeline', kind: 12, path: '/work/app2/src/run.js', range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } } }],
  'resource:list': [{ name: 'runbook', uri: 'docs://runbook', client: 'docs', description: '', mimeType: 'text/markdown' }],
  'reference:list': [{ name: 'run-rules', path: '/refs/run-rules', description: 'Rules' }],
  'agent:list': [{ name: 'build', mode: 'primary' }, { name: 'plan', mode: 'primary' }, { name: 'reviewer', mode: 'all', description: 'Reviews' }],
  'command:list': [{ name: 'review', description: 'Review', source: 'command' }],
  'session:share:policy': { share: 'manual' },
  'session:status': { status: { type: 'idle' } },
  'permission:list': [{ id: 'per_child', sessionID: 'ses_child', permission: 'bash', patterns: ['ls'], metadata: {}, always: [] }],
  'question:list': [],
  'session:todo': [],
  'session:get': { id: 'ses_child', parentID: 'ses_1', title: 'explore', directory: '/work/app', version: '1.18.34', time: { created: 1, updated: 2 } },
  'session:messages': [],
};
await step('with a server that answers: env popover, add a server, attach a reference, the @ picker, a child re-read', async () => {
  const sock = FakeWS.last;
  const answered = [];
  sock.send = function send(raw) {
    (this.sent ||= []).push(raw);
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id == null || !(msg.type in CANNED)) return;
    answered.push(msg.type);
    // mcp:add answers what the server does for `persist: true`: saved in the same request.
    const extra = msg.type === 'mcp:add' && msg.persist === true ? { saved: true } : {};
    setTimeout(() => this._emit('message', { data: JSON.stringify({ type: `${msg.type}:result`, id: msg.id, status: 200, data: CANNED[msg.type], ...extra }) }), 1);
  };
  const find = (pred) => { let hit = null; walk(panel, (n) => { if (!hit && pred(n)) hit = n; }); return hit; };
  const byText = (text) => find((n) => n.tagName === 'BUTTON' && String(n.textContent) === text);
  const posted = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { if (init?.method === 'POST') posted.push([String(url), JSON.parse(init.body)]); return realFetch(url, init); };

  // The env popover: MCP rows, the add-server form, a reference with Attach.
  // (It has no button of its own: it opens through its controller, as "Manage" does.)
  const envBtn = { _fire: () => envCtl.toggle() };
  const pop = find((n) => String(n.className).includes('ocpv2-env-popover'));
  if (!pop.hidden) envBtn._fire('click');     // an earlier step may have left it open
  envBtn._fire('click');
  await tick(80);
  if (OLD_SERVER) {
    if (byText('Add a server…')) throw new Error('the add form is offered to a server without mcp:add');
  } else {
    const addLink = byText('Add a server…');
    if (!addLink) throw new Error('no "Add a server…" link');
    addLink._fire('click');
    await tick(80);
    const inputs = [];
    walk(pop, (n) => { if (n.tagName === 'INPUT') inputs.push(n); });
    if (inputs.length !== 2) throw new Error(`the add form has ${inputs.length} inputs`);
    // The managed name is refused before anything is sent.
    inputs[0].value = 'SynaBun'; inputs[0]._fire('input'); inputs[1].value = 'node evil.js'; inputs[1]._fire('input');
    byText('Add')._fire('click');
    await tick(80);
    if (answered.includes('mcp:add') || posted.length) throw new Error('a managed server name reached the server');
    walk(pop, (n) => { if (n.tagName === 'INPUT') inputs.push(n); });
    const [name, command] = inputs.slice(-2);
    name.value = 'docs'; name._fire('input'); command.value = 'TOKEN=x node /srv/docs.js "" " two words "'; command._fire('input');
    // A command-based server is confirmed first, in the popover, with the
    // exact command and arguments: Add only puts the question up, and its
    // button starts the server. Never a native dialog (this one would agree).
    let nativeDialogs = 0;
    const realConfirm = globalThis.window.confirm;
    globalThis.window.confirm = () => { nativeDialogs += 1; return true; };
    const hasClass = (n, cls) => String(n.className || '').split(/\s+/).includes(cls);
    const question = () => { let hit = null; walk(pop, (n) => { if (!hit && hasClass(n, 'ocpv2-confirm')) hit = n; }); return hit; };
    const part = (cls) => { let hit = null; walk(question(), (n) => { if (!hit && hasClass(n, cls)) hit = n; }); return hit; };
    byText('Add')._fire('click');
    await tick(120);
    if (!question()) throw new Error('the start was not asked in the popover');
    const asked = String(part('ocpv2-confirm-text').textContent);
    for (const line of ['Command: "node"', '  1. "/srv/docs.js"', '  2. ""', '  3. " two words "', 'Environment variables set: TOKEN']) {
      if (!asked.includes(line)) throw new Error(`the confirm does not show ${line}: ${asked}`);
    }
    if (answered.includes('mcp:add')) throw new Error('one click on Add started the server');
    part('ocpv2-confirm-no')._fire('click');
    await tick(80);
    if (question()) throw new Error('the declined question stayed');
    if (answered.includes('mcp:add')) throw new Error('a declined server was sent to the server');
    walk(pop, (n) => { if (n.tagName === 'INPUT') inputs.push(n); });
    byText('Add')._fire('click');
    await tick(400);                        // (a second click counts from CONFIRM_MIN_DELAY_MS on)
    if (answered.includes('mcp:add')) throw new Error('the server started before the second click');
    part('ocpv2-confirm-yes')._fire('click');
    await tick(120);
    globalThis.window.confirm = realConfirm;
    if (nativeDialogs) throw new Error('a native dialog was used for the start');
    if (!answered.includes('mcp:add')) throw new Error('mcp:add was not sent');
    // One request registers and saves; the Settings route (which registers on
    // the shared serve as well) is not called.
    if (posted.some(([url]) => url === '/api/opencode/mcp')) throw new Error('the panel saved through the Settings route: the server starts twice');
    const adds = (sock.sent || []).map((raw) => JSON.parse(raw)).filter((m) => m.type === 'mcp:add');
    const add = adds[adds.length - 1];
    if (adds.length !== 1 || add.name !== 'docs' || add.persist !== true || add.config.command !== 'node'
      || JSON.stringify(add.config.args) !== JSON.stringify(['/srv/docs.js', '', ' two words ']) || add.config.env.TOKEN !== 'x') {
      throw new Error(`the server was not sent as typed: ${JSON.stringify(adds)}`);
    }
    const attach = byText('Attach');
    if (!attach) throw new Error('a reference has no Attach link');
    attach._fire('click');
    if (!store.getState().pendingPaths.includes('/refs/styleguide')) throw new Error('Attach did not add the reference to the prompt');
    if (!pop.hidden) throw new Error('the popover stayed open after Attach');
    store.clearPendingPaths();
  }
  globalThis.fetch = realFetch;

  // The @ picker with every source. (Another directory: the lists asked for
  // while the stand-in socket was still closed are waiting for their timeout.)
  store.setCwd('/work/app2');
  await tick(20);
  let input = null; walk(panel, (n) => { if (n.tagName === 'TEXTAREA') input = n; });
  input.value = '@ru'; input.selectionStart = input.selectionEnd = 3; input._fire('input', { isTrusted: true });
  await tick(260);
  const groupTitles = [];
  walk(panel, (n) => { if (String(n.className) === 'ocpv2-slash-group-header') groupTitles.push(String(n.textContent)); });
  if (OLD_SERVER) {
    if (groupTitles.includes('Files')) throw new Error('the @ picker opened against a server without find:files');
  } else {
    for (const title of ['Files', 'Symbols', 'MCP resources', 'References']) {
      if (!groupTitles.includes(title)) throw new Error(`the @ picker has no "${title}" group (has: ${groupTitles.join(', ')})`);
    }
    input._fire('keydown', { key: 'ArrowDown', isTrusted: true });   // the symbol row
    input._fire('keydown', { key: 'Enter', isTrusted: true });
    if (!/^@src\/run\.js#runPipeline /.test(input.value)) throw new Error(`the pick was not inserted: ${input.value}`);
    input._fire('keydown', { key: 'Enter', isTrusted: true });
    await tick(60);
    const sentPrompt = (sock.sent || []).map((raw) => JSON.parse(raw)).filter((m) => m.type === 'message:send').pop();
    const symbolPart = sentPrompt?.parts?.find((part) => part.source?.type === 'symbol');
    if (!symbolPart || symbolPart.url !== 'file:///work/app2/src/run.js?start=1&end=3') throw new Error(`no symbol part went out: ${JSON.stringify(sentPrompt?.parts)}`);
  }
  input.value = ''; input._fire('input', { isTrusted: true });
  store.setRunning(false);

  // A sub-agent panel store is re-read (what the manager does after a reconnect).
  const rehydrate = await import(base + 'ocp-v2-rehydrate.js');
  const child = state.createPanelStore();
  child.setSession('ses_child', { id: 'ses_child' });
  child.setRunning(true);
  ws.subscribeSession('ses_child', child);
  const out = await Promise.race([
    rehydrate.rehydratePanelSession(child, ws.api, { sessionId: 'ses_child', hasPanel: ws.hasSessionStore, isDescendant: ws.isDescendantSession }),
    tick(2000).then(() => 'timeout'),
  ]);
  if (out === 'timeout') throw new Error('the child re-read never finished');
  if (child.getState().running) throw new Error('the child is still "running" after the re-read');
  if (!OLD_SERVER && child.getState().pendingPermissions.length !== 1) throw new Error('the child did not get its pending request back');
  if (await ws.isDescendantSession('ses_child', 'ses_1') !== true) throw new Error('ancestry of the child was not verified');
  if (await ws.isDescendantSession('ses_1', 'ses_child') !== false) throw new Error('ancestry has no direction');
  console.log('     answered:', [...new Set(answered)].join(', ') || '(none)');
  if (OLD_SERVER) {
    const sentTypes = (sock.sent || []).map((raw) => { try { return JSON.parse(raw).type; } catch { return '?'; } });
    const known = new Set(reqMod.OPENCODE_V2_WS_INLINE_TYPES.concat(['session:context', 'session:compact', 'permission:reply', 'question:reply']));
    const unknown = sentTypes.filter((type) => !known.has(type));
    if (unknown.length) throw new Error(`sent to a server that does not know them: ${[...new Set(unknown)].join(', ')}`);
  }
});
console.log(problems.length ? `\nPROBLEMS (${problems.length}):\n` + problems.join('\n') : '\nno problems');
process.exit(0);
