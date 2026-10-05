import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installMiniDom } from './fixtures/mini-dom.mjs';
import { setCpCtx } from '../public/shared/cp/cp-ctx.js';
import {
  ALL_PERMISSION_MODES, MODE_LABELS, permissionModesFor, isDefaultableMode, autoModeSupported,
  describeSuggestion, alwaysUpdates, grantedRuleLine, permissionContext,
  elicitationFields, collectElicitation, elicitationUrl, toolPolicyId, statedMode, pickMode,
} from '../public/shared/cp/cp-permission-model.js';
import { renderPermissionCard, renderPlanApprovalCard, renderElicitationCard, decorateAskCard, askAnnotations, markAskAnswered } from '../public/shared/cp/cp-permissions.js';
import { readPermissionRules } from '../lib/claude-permission-rules.js';

// Permission prompts of the Claude sidepanel: the modes on offer, what a card
// says, what "Always" grants, MCP elicitation, and the /permissions view.

// ── Modes ──

test('the six SDK modes exist; the two newer ones are offered only when they can work', () => {
  assert.deepEqual(ALL_PERMISSION_MODES, ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto']);
  assert.equal(MODE_LABELS.dontAsk, "Don't Ask");
  assert.deepEqual(permissionModesFor({}), ['default', 'acceptEdits', 'plan', 'bypassPermissions'], 'a server that was not restarted: the classic four');
  assert.deepEqual(permissionModesFor({ extended: true }), ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk']);
  assert.deepEqual(permissionModesFor({ extended: true, autoSupported: true }).slice(-2), ['dontAsk', 'auto']);
  assert.ok(permissionModesFor({ current: 'auto' }).includes('auto'), 'the mode a tab is in is always shown');
});

test('neither Auto nor Don\'t Ask (nor Plan, nor Bypass) becomes the default for new tabs', () => {
  // Bypass is chosen for one tab, in its mode control: a new tab starts in it
  // only when the user's own Claude Code settings say so (permissions.defaultMode).
  assert.deepEqual(ALL_PERMISSION_MODES.filter(isDefaultableMode), ['default', 'acceptEdits']);
});

test('auto mode is offered from the session\'s own model list', () => {
  const models = [{ value: 'opus', supportsAutoMode: true }, { value: 'haiku', supportsAutoMode: false }];
  assert.equal(autoModeSupported(models, 'opus'), true);
  assert.equal(autoModeSupported(models, 'HAIKU'), false);
  assert.equal(autoModeSupported(models, 'claude-opus-5-5[1m]'), true, 'no exact row: offered if any model has it');
  assert.equal(autoModeSupported([], 'opus'), false);
  assert.equal(autoModeSupported(null, 'opus'), false, 'before a session reported its models: not offered');
});

// ── Suggestions and "Always" ──

const RULES = [{ toolName: 'Bash', ruleContent: 'npm run test:*' }];

test('every kind of rule suggestion reads with the verb its behavior implies', () => {
  assert.equal(describeSuggestion({ type: 'addRules', rules: RULES, behavior: 'allow', destination: 'session' }), 'Allow Bash(npm run test:*)');
  assert.equal(describeSuggestion({ type: 'addRules', rules: [{ toolName: 'WebFetch' }], behavior: 'deny', destination: 'session' }), 'Deny WebFetch');
  assert.equal(describeSuggestion({ type: 'addRules', rules: RULES, behavior: 'ask', destination: 'session' }), 'Ask before Bash(npm run test:*)');
  assert.equal(describeSuggestion({ type: 'replaceRules', rules: RULES, behavior: 'allow', destination: 'session' }), 'Replace the allow rules with Bash(npm run test:*)');
  assert.equal(describeSuggestion({ type: 'removeRules', rules: RULES, behavior: 'deny', destination: 'session' }), 'Remove the deny rule Bash(npm run test:*)');
  assert.equal(describeSuggestion({ type: 'setMode', mode: 'acceptEdits', destination: 'session' }), 'Switch to Accept Edits mode');
  assert.equal(describeSuggestion({ type: 'addDirectories', directories: ['/tmp/a'], destination: 'session' }), 'Allow access to /tmp/a');
  assert.equal(describeSuggestion({ type: 'removeDirectories', directories: ['/tmp/a'], destination: 'session' }), 'Remove access to /tmp/a');
  assert.equal(describeSuggestion(null), '');
});

test('"Always" grants what the CLI suggested, for the destination picked, never the whole tool', () => {
  const req = { tool_name: 'Bash', suggestions: [{ type: 'addRules', rules: RULES, behavior: 'allow', destination: 'localSettings' }, { type: 'setMode', mode: 'acceptEdits', destination: 'session' }] };
  assert.deepEqual(alwaysUpdates(req), [
    { type: 'addRules', rules: RULES, behavior: 'allow', destination: 'session' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
  ], 'the session, unless the user picks otherwise');
  assert.equal(alwaysUpdates(req, 'userSettings')[0].destination, 'userSettings');
  assert.equal(alwaysUpdates(req, 'cliArg')[0].destination, 'session', 'an unknown destination falls back to the session');
  // No suggestion: nothing narrow to grant for a built-in tool.
  assert.deepEqual(alwaysUpdates({ tool_name: 'Bash' }), []);
  // An MCP tool's exact name is a rule of its own.
  assert.deepEqual(alwaysUpdates({ tool_name: 'mcp__github__create_issue' }), [{ type: 'addRules', rules: [{ toolName: 'mcp__github__create_issue' }], behavior: 'allow', destination: 'session' }]);
  // The CLI said no persistent rule may be offered.
  assert.deepEqual(alwaysUpdates({ ...req, suppress_always: true }), []);
  assert.equal(grantedRuleLine({ type: 'addRules', rules: RULES, behavior: 'allow', destination: 'projectSettings' }), 'Allow Bash(npm run test:*) · this project (shared settings)');
});

test('the card shows the CLI\'s own context, as plain text', () => {
  const ctx = permissionContext({
    tool_name: 'mcp__gh__x', title: 'Claude wants to create an issue', display_name: 'Create issue', description: 'In repo o/r',
    decision_reason: '\u001b[31mNo matching allow rule\u001b[0m', blocked_path: '/etc/hosts',
    mcp_server: { name: 'gh', source: 'user' }, matched_ask_rule: { source: 'userSettings', toolName: 'Bash', ruleContent: 'git push:*' },
    agent_id: 'agent-7', tool_use_id: 'toolu_1', default_to_no: true, suggestions: [],
  });
  assert.equal(ctx.title, 'Claude wants to create an issue');
  assert.deepEqual(ctx.rows, [
    ['Why', 'No matching allow rule'],
    ['Path', '/etc/hosts'],
    ['MCP server', 'gh (user)'],
    ['Asked because', 'your ask rule Bash(git push:*) in userSettings'],
    ['From', 'subagent agent-7'],
  ]);
  assert.deepEqual([ctx.defaultToNo, ctx.canAlways, ctx.toolUseId], [true, true, 'toolu_1']);
  const bare = permissionContext({ tool_name: 'Bash', input: {} });
  assert.deepEqual([bare.title, bare.rows, bare.defaultToNo, bare.canAlways], ['', [], false, false]);
});

// ── Elicitation ──

const SCHEMA = {
  type: 'object',
  required: ['repo', 'count'],
  properties: {
    repo: { type: 'string', title: 'Repository', description: 'owner/name', minLength: 3 },
    count: { type: 'integer', minimum: 1, maximum: 10 },
    email: { type: 'string', format: 'email' },
    visibility: { type: 'string', enum: ['public', 'private'], enumNames: ['Public', 'Private'], default: 'private' },
    confirm: { type: 'boolean', default: true },
  },
};

test('an elicitation form is built from the server\'s schema and validated before it is sent', () => {
  const fields = elicitationFields(SCHEMA);
  assert.deepEqual(fields.map(f => [f.name, f.type, f.required]), [['repo', 'text', true], ['count', 'number', true], ['email', 'text', false], ['visibility', 'choice', false], ['confirm', 'boolean', false]]);
  assert.deepEqual(fields[3].options, [{ value: 'public', label: 'Public' }, { value: 'private', label: 'Private' }]);

  const bad = collectElicitation(fields, { repo: 'ab', count: '2.5', email: 'nope', visibility: 'secret', confirm: false });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors, { repo: 'At least 3 characters', count: 'Enter a whole number', email: 'Enter an email address', visibility: 'Pick one of the options' });
  assert.deepEqual(collectElicitation(fields, { count: '11' }).errors, { repo: 'Required', count: 'At most 10' });

  const good = collectElicitation(fields, { repo: ' o/r ', count: '3', email: '', visibility: 'public', confirm: true });
  assert.deepEqual(good, { ok: true, content: { repo: 'o/r', count: 3, visibility: 'public', confirm: true }, errors: {} });
  assert.deepEqual(elicitationFields(null), []);
  assert.equal(elicitationUrl({ url: 'https://auth.example/x' }), 'https://auth.example/x');
  assert.equal(elicitationUrl({ url: 'javascript:alert(1)' }), '', 'only http(s) addresses are opened');
});

test('tool policy names', () => {
  assert.equal(toolPolicyId('Read Only'), 'read-only');
  assert.equal(toolPolicyId('readonly'), 'read-only');
  assert.equal(toolPolicyId('no-web'), 'no-web');
  assert.equal(toolPolicyId('full'), 'full');
  assert.equal(toolPolicyId('everything'), '');
});

// ── Cards on the mini DOM ──

function setup() {
  const dom = installMiniDom();
  const tab = { id: 't', messagesEl: dom.container('cp-messages') };
  setCpCtx({ esc: String, md: (t) => `<p>${t}</p>`, scrollEnd: () => {}, activeTab: () => tab, toolIconSvg: () => '<svg/>', emit: () => {} });
  const sent = [];
  return { dom, tab, sent, hooks: (extra = {}) => ({ sendResponse: (rid, inner) => sent.push([rid, inner]), ...extra }) };
}
const button = (card, text) => card.querySelectorAll('button').find(b => b.textContent === text || b.innerHTML.endsWith(text));

test('Always sends the suggested rules to the picked destination; Allow sends none', () => {
  const { dom, tab, sent, hooks } = setup();
  try {
    const req = { tool_name: 'Bash', input: { command: 'npm run test' }, title: 'Claude wants to run npm run test', suggestions: [{ type: 'addRules', rules: RULES, behavior: 'allow', destination: 'localSettings' }] };
    const resolved = [];
    const card = renderPermissionCard(tab, 'perm-1', req, hooks({ canInterrupt: true, onResolved: (...a) => resolved.push(a) }));
    assert.equal(card.querySelector('.cp-perm-title').textContent, 'Claude wants to run npm run test');
    assert.equal(card.querySelector('.cp-perm-suggestion').textContent, 'Allow Bash(npm run test:*)');
    const select = card.querySelector('.cp-perm-dest-select');
    select.value = 'projectSettings';
    select.fire('change');
    button(card, 'Always').click();
    assert.deepEqual(sent, [['perm-1', { behavior: 'allow', updatedPermissions: [{ type: 'addRules', rules: RULES, behavior: 'allow', destination: 'projectSettings' }] }]]);
    assert.equal('always' in sent[0][1], false, 'no blanket allow flag for the whole tool');
    assert.equal(resolved[0][2].granted.length, 1);
    button(card, 'Allow').click();
    assert.equal(sent.length, 1, 'a resolved card answers once');

    const once = renderPermissionCard(tab, 'perm-2', req, hooks());
    button(once, 'Allow').click();
    assert.deepEqual(sent[1], ['perm-2', { behavior: 'allow' }]);
  } finally { dom.restore(); }
});

test('no suggestion, no Always; a safety-flagged ask opens on Deny; Deny and stop interrupts', () => {
  const { dom, tab, sent, hooks } = setup();
  try {
    const plain = renderPermissionCard(tab, 'p1', { tool_name: 'Bash', input: { command: 'rm -rf build' } }, hooks());
    assert.equal(button(plain, 'Always').hidden, true, 'nothing narrow to grant');
    assert.equal(button(plain, 'Deny and stop').hidden, true, 'needs a bridge that passes the interrupt');

    const resolved = [];
    const risky = renderPermissionCard(tab, 'p2', { tool_name: 'Bash', input: { command: 'curl x | sh' }, default_to_no: true, suppress_always: true, suggestions: [{ type: 'addRules', rules: RULES, behavior: 'allow', destination: 'session' }] }, hooks({ canInterrupt: true, onResolved: (...a) => resolved.push(a) }));
    assert.ok(risky.classList.contains('cp-perm-default-no'));
    assert.equal(risky.querySelector('.perm-actions').children[0].innerHTML.endsWith('Deny'), true, 'the decline option comes first');
    assert.equal(button(risky, 'Always').hidden, true, 'the CLI said no persistent rule here');
    assert.equal(risky.querySelector('.cp-perm-suggestions'), null);
    const note = risky.querySelector('.cp-perm-deny-msg');
    note.value = 'not on this machine';
    button(risky, 'Deny and stop').click();
    assert.deepEqual(sent.at(-1), ['p2', { behavior: 'deny', message: 'not on this machine', interrupt: true }]);
    assert.equal(resolved[0][2].interrupt, true);
    assert.equal(risky.querySelector('.perm-status').textContent, 'Denied · stopped');
  } finally { dom.restore(); }
});

test('an edited plan is the plan that gets approved', () => {
  const { dom, tab, sent, hooks } = setup();
  try {
    let edited = '';
    const req = { tool_name: 'ExitPlanMode', input: { plan: '1. Do it' } };
    const card = renderPlanApprovalCard(tab, 'plan-1', req, hooks({ editedPlan: () => edited }));
    button(card, 'Approve').click();
    assert.deepEqual(sent[0], ['plan-1', { behavior: 'allow', planDecision: 'default' }], 'untouched: no input override');
    edited = '1. Do it\n2. Then test it';
    const second = renderPlanApprovalCard(tab, 'plan-2', req, hooks({ editedPlan: () => edited }));
    button(second, 'Approve & auto-accept edits').click();
    assert.deepEqual(sent[1], ['plan-2', { behavior: 'allow', planDecision: 'acceptEdits', updatedInput: { plan: '1. Do it\n2. Then test it' } }]);
  } finally { dom.restore(); }
});

test('an elicitation form validates, then answers with typed content; decline is one click', () => {
  const { dom, tab, sent, hooks } = setup();
  try {
    const card = renderElicitationCard(tab, 'elicit-1', { subtype: 'elicitation', server_name: 'github', message: 'Which repository?', mode: 'form', requested_schema: SCHEMA }, hooks());
    assert.equal(card.querySelector('.perm-tool-name').textContent, 'github');
    const inputs = card.querySelectorAll('.cp-elicit-input');
    assert.equal(inputs.length, 5);
    button(card, 'Send').click();
    assert.equal(sent.length, 0, 'required fields are missing');
    assert.deepEqual(card.querySelectorAll('.cp-elicit-error').filter(e => !e.hidden).map(e => e.textContent), ['Required', 'Required']);
    inputs[0].value = 'o/r';
    inputs[1].value = '2';
    button(card, 'Send').click();
    assert.deepEqual(sent[0], ['elicit-1', { action: 'accept', content: { repo: 'o/r', count: 2, visibility: 'private', confirm: true } }]);
    assert.equal(card.querySelector('.perm-status').textContent, 'Sent');

    const declined = renderElicitationCard(tab, 'elicit-2', { subtype: 'elicitation', server_name: 'x', message: 'm', mode: 'form', requested_schema: SCHEMA }, hooks());
    button(declined, 'Decline').click();
    assert.deepEqual(sent[1], ['elicit-2', { action: 'decline' }]);
  } finally { dom.restore(); }
});

test('a URL elicitation opens nothing by itself and settles when the server confirms', () => {
  const { dom, tab, sent, hooks } = setup();
  try {
    const card = renderElicitationCard(tab, 'elicit-3', { subtype: 'elicitation', server_name: 'stripe', message: 'Sign in', mode: 'url', url: 'https://auth.example/start', elicitation_id: 'e-9' }, hooks());
    assert.equal(card.dataset.elicitationId, 'e-9');
    assert.equal(card.querySelector('.cp-perm-target').textContent, 'https://auth.example/start');
    assert.equal(sent.length, 0);
    card._settle('accept'); // elicitation_complete
    assert.deepEqual(sent[0], ['elicit-3', { action: 'accept' }]);
    const unsafe = renderElicitationCard(tab, 'elicit-4', { subtype: 'elicitation', server_name: 'x', message: 'm', mode: 'url', url: 'javascript:alert(1)' }, hooks());
    assert.equal(button(unsafe, 'Open page').disabled, true);
  } finally { dom.restore(); }
});

test('F3: a permission card answered while the socket is closed is not shown as answered: it stays usable and says the answer was not sent', () => {
  // "A permission or elicitation card is visible when the socket closes. The owner clicks Allow, Send, or
  // Decline. Sending returns false, but the card locks and its resolution callback runs."
  const { dom, tab } = setup();
  try {
    let open = false;
    const sent = [];
    const resolved = [];
    const req = { tool_name: 'Bash', input: { command: 'npm run test' }, suggestions: [{ type: 'addRules', rules: RULES, behavior: 'allow', destination: 'session' }] };
    const card = renderPermissionCard(tab, 'perm-off', req, { sendResponse: (rid, inner) => { if (!open) return false; sent.push([rid, inner]); return true; }, canInterrupt: true, onResolved: (...a) => resolved.push(a) });
    const note = card.querySelector('.cp-perm-deny-msg');
    note.value = ''; // (the mini DOM's textarea has no value until one is set)
    for (const label of ['Allow', 'Always', 'Deny', 'Deny and stop']) {
      button(card, label).click();
      assert.deepEqual([sent, resolved], [[], []], `${label}: nothing was sent, so nothing is answered`);
      assert.equal(card.classList.contains('resolved'), false, label);
      assert.equal(card.classList.contains('active-perm'), true, label);
      assert.equal(card.querySelectorAll('button').some(b => b.disabled), false, `${label}: the buttons stay usable`);
      assert.equal(card.querySelectorAll('select').some(n => n.disabled) || note.disabled, false, label);
      assert.match(card.querySelector('.perm-status').textContent, /^Not sent/, `${label}: the card says so`);
      assert.equal(card.querySelector('.perm-status').hidden, false);
    }
    // The socket is back: the same card answers, once, and only then shows the answer.
    open = true;
    note.value = 'not now';
    button(card, 'Deny').click();
    assert.deepEqual(sent, [['perm-off', { behavior: 'deny', message: 'not now' }]]);
    assert.deepEqual(resolved.map(r => r[0]), ['deny']);
    assert.equal(card.querySelector('.perm-status').textContent, 'Denied');
    assert.equal(card.classList.contains('resolved'), true);
    assert.equal(card.querySelectorAll('button').every(b => b.disabled), true);
    button(card, 'Allow').click();
    assert.equal(sent.length, 1, 'a resolved card answers once');
  } finally { dom.restore(); }
});

test('F3: an elicitation card answered while the socket is closed is not shown as answered either', () => {
  const { dom, tab } = setup();
  try {
    let open = false;
    const sent = [];
    const resolved = [];
    const hooks = { sendResponse: (rid, inner) => { if (!open) return false; sent.push([rid, inner]); return true; }, onResolved: (a) => resolved.push(a) };
    const form = renderElicitationCard(tab, 'elicit-off', { subtype: 'elicitation', server_name: 'github', message: 'Which repository?', mode: 'form', requested_schema: SCHEMA }, hooks);
    const inputs = form.querySelectorAll('.cp-elicit-input');
    inputs[0].value = 'o/r';
    inputs[1].value = '2';
    for (const label of ['Send', 'Decline']) {
      button(form, label).click();
      assert.deepEqual([sent, resolved], [[], []], label);
      assert.equal(form.classList.contains('resolved'), false, label);
      assert.equal(form.querySelectorAll('button').some(b => b.disabled) || inputs.some(i => i.disabled), false, `${label}: the form stays usable`);
      assert.match(form.querySelector('.perm-status').textContent, /^Not sent/, label);
    }
    const url = renderElicitationCard(tab, 'elicit-off-url', { subtype: 'elicitation', server_name: 'stripe', message: 'Sign in', mode: 'url', url: 'https://auth.example/start' }, hooks);
    button(url, 'Done').click();
    url._settle('accept'); // the server's own confirmation, when the answer cannot be sent
    assert.deepEqual([sent, resolved, url.classList.contains('resolved')], [[], [], false]);
    open = true;
    button(form, 'Send').click();
    button(url, 'Decline').click();
    assert.deepEqual(sent, [['elicit-off', { action: 'accept', content: { repo: 'o/r', count: 2, visibility: 'private', confirm: true } }], ['elicit-off-url', { action: 'decline' }]]);
    assert.deepEqual(resolved, ['accept', 'decline']);
    assert.deepEqual([form.querySelector('.perm-status').textContent, url.querySelector('.perm-status').textContent], ['Sent', 'Declined']);
  } finally { dom.restore(); }
});

test('F3: both question cards send first and show the answer as given only when it was sent', async () => {
  const panel = (await readFile(new URL('../public/shared/ui-claude-panel.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  // sendAskAnswer() says whether the answer left: false while the socket is closed.
  const send = panel.slice(panel.indexOf('function sendAskAnswer(tab, questions, answers, annotations = null) {'));
  assert.match(send.slice(0, 200), /if \(!tab\.ws \|\| tab\.ws\.readyState !== WebSocket\.OPEN\) return false;/);
  assert.match(send.slice(0, send.indexOf('\nfunction isPlanFile')), /\n  setRunning\(tab, true\);\n  return true;\n\}/);
  // Each Submit handler asks before it locks anything, and says so when the answer could not be sent.
  const handlers = panel.split("submitBtn.addEventListener('click', () => {").slice(1).map(h => h.slice(0, h.indexOf('\n  });')));
  assert.equal(handlers.length, 2, 'the card built from the tool call and the card of the control request');
  for (const h of handlers) {
    const guard = h.indexOf('if (tab.ws?.readyState !== WebSocket.OPEN) { appendStatus(tab, ASK_ANSWER_UNSENT); return; }');
    assert.ok(guard >= 0, 'an answer that cannot be sent is not shown as given');
    for (const lock of ['.disabled = true', "submitBtn.textContent = 'Submitted'", 'markAskAnswered(', 'sendAskAnswer(']) assert.ok(h.indexOf(lock) > guard, `${lock} comes after the check`);
  }
  assert.match(panel, /const ASK_ANSWER_UNSENT = 'Not connected: your answer was not sent\. Submit it again once this tab is connected\.';/);
});

test('question cards: an option preview and a note travel as annotations', () => {
  const { dom } = setup();
  try {
    const mkOptions = (n) => {
      const opts = document.createElement('div'); opts.className = 'ask-options';
      const buttons = Array.from({ length: n }, () => { const b = document.createElement('button'); b.className = 'ask-option'; opts.appendChild(b); return b; });
      return { opts, buttons };
    };
    // One card per question (the control-request path).
    const wrap = document.createElement('div');
    const card = document.createElement('div');
    card.className = 'ask-card';
    const { opts, buttons: [a] } = mkOptions(2);
    card.appendChild(opts);
    wrap.appendChild(card);
    decorateAskCard(card, { question: 'Which layout?', options: [{ label: 'Grid', preview: '[ ][ ]\n[ ][ ]' }, { label: 'List' }] }, { notes: true });
    const pane = card.querySelector('.ask-preview');
    assert.equal(pane.hidden, true);
    a.fire('mouseenter');
    assert.equal(pane.textContent, '[ ][ ]\n[ ][ ]');
    a.fire('mouseleave');
    assert.equal(pane.hidden, true, 'nothing picked yet');
    a.classList.add('selected'); // the card's own click handler does this first
    a.click();
    assert.equal(pane.hidden, false);
    card.querySelector('.ask-notes').value = ' keep it dense ';
    assert.deepEqual(askAnnotations(wrap, { 'Which layout?': 'Grid' }), { 'Which layout?': { preview: '[ ][ ]\n[ ][ ]', notes: 'keep it dense' } });
    assert.equal(askAnnotations(wrap, {}), null, 'an unanswered question carries no annotation');

    const plainCard = document.createElement('div');
    plainCard.className = 'ask-card';
    decorateAskCard(plainCard, { question: 'Q', options: [{ label: 'A' }] }, { notes: false });
    assert.equal(plainCard.querySelector('.ask-preview'), null);
    assert.equal(plainCard.querySelector('.ask-notes'), null, 'notes only with a bridge that keeps them');

    // One card holding several questions (the card built from the tool call).
    const multi = document.createElement('div');
    multi.className = 'ask-card';
    const q1 = mkOptions(1);
    const q2 = mkOptions(1);
    multi.append(q1.opts, q2.opts);
    decorateAskCard(multi, { question: 'First?', options: [{ label: 'A', preview: 'preview A' }] }, { notes: true, optionsEl: q1.opts });
    decorateAskCard(multi, { question: 'Second?', options: [{ label: 'B' }] }, { notes: true, optionsEl: q2.opts });
    assert.deepEqual(multi.children.map(c => c.className), ['ask-options', 'ask-preview', 'ask-notes', 'ask-options', 'ask-notes'], 'each question keeps its own preview and note');
    q1.buttons[0].classList.add('selected');
    q1.buttons[0].click();
    multi.querySelectorAll('.ask-notes')[1].value = 'second note';
    assert.deepEqual(askAnnotations(multi, { 'First?': 'A', 'Second?': 'B' }), { 'First?': { preview: 'preview A' }, 'Second?': { notes: 'second note' } });

    markAskAnswered(multi, { 'First?': 'A', 'Second?': 'B' });
    markAskAnswered(multi, { 'First?': 'A', 'Second?': 'B' });
    assert.deepEqual(multi.querySelectorAll('.ask-answered').map(n => n.textContent), ['First? → A', 'Second? → B']);
    markAskAnswered(card, { 'Which layout?': 'Grid' });
    assert.equal(card.querySelector('.ask-answered').textContent, 'Answered: Grid');
  } finally { dom.restore(); }
});

// ── The /permissions view's server half ──

test('permission rules are read per settings scope; a broken file is reported, not hidden', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cp-rules-'));
  try {
    const home = join(root, 'home');
    const project = join(root, 'proj');
    await mkdir(join(home, '.claude'), { recursive: true });
    await mkdir(join(project, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'acceptEdits', allow: ['Bash(npm run:*)', 7], deny: ['WebFetch'], additionalDirectories: ['/tmp/x'] } }));
    await writeFile(join(project, '.claude', 'settings.local.json'), '{ not json');
    const rules = readPermissionRules({ home, project });
    assert.deepEqual([rules.user.exists, rules.user.defaultMode, rules.user.allow, rules.user.deny, rules.user.additionalDirectories], [true, 'acceptEdits', ['Bash(npm run:*)'], ['WebFetch'], ['/tmp/x']]);
    assert.equal(rules.project.exists, false);
    assert.equal(rules.local.exists, true);
    assert.match(rules.local.error, /could not be read/);
    assert.deepEqual(readPermissionRules({ home }).project, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ── Panel and server wiring (source contracts) ──

const panel = (await readFile(new URL('../public/shared/ui-claude-panel.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
function fnBody(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const rest = src.slice(start + signature.length);
  const next = rest.search(/\n(?:async )?function /);
  return next >= 0 ? rest.slice(0, next) : rest;
}

test('a tab that never picked a mode lets the user\'s settings decide; every query goes through one helper', () => {
  const body = fnBody(panel, 'function _applySessionOptions(tab, msg) {');
  // What is stated is statedMode()'s answer (cp-permission-model.js): plan mode and
  // a mode the tab picked are stated; a tab that never picked one leaves it to
  // the settings, where the bridge can. (With a bridge that numbers statements,
  // the statement carries its number.)
  assert.match(body, /Object\.assign\(msg, statedMode\(tab, \{ settingsPick: hasCapability\(tab, 'permission_modes_v2'\), \.\.\._modeBridge\(tab\) \}\)\);/);
  const never = { permissionMode: 'default', planMode: false, modeChosen: false };
  assert.deepEqual(statedMode(never, { settingsPick: true }), { modeFromSettings: true });
  assert.deepEqual(statedMode(never, { settingsPick: false }), { permissionMode: 'default' }, 'an older server still gets an explicit mode');
  // Plan mode is one fact (the mode is 'plan'), stated whether or not the tab has a pick.
  assert.deepEqual(statedMode({ ...never, permissionMode: 'plan', planMode: true }, { settingsPick: true }), { permissionMode: 'plan' });
  assert.deepEqual(statedMode({ ...never, modeChosen: true }, { settingsPick: true }), { permissionMode: 'default' });
  assert.deepEqual(statedMode({ ...never, permissionMode: 'acceptEdits', modeChosen: true }, { settingsPick: true }), { permissionMode: 'acceptEdits' });
  // A mode the tab only shows (its session reported it from the settings) is not its own: it is not stated.
  assert.deepEqual(statedMode({ ...never, permissionMode: 'auto' }, { settingsPick: true }), { modeFromSettings: true });
  assert.deepEqual(statedMode({ ...never, modeSeq: 4 }, { settingsPick: true, numbered: true }), { modeFromSettings: true, modeSeq: 4 });
  assert.match(body, /msg\.features = \['elicitation', 'task_stop'\]/, 'what this panel can render: elicitation cards, a stop control per task');
  // (Review 3, T01: the shell shortcut, the ask-answer fallback and the configuration sent with a control go through it too.)
  assert.equal(panel.match(/_applySessionOptions\(tab, (?:msg|btwMsg)\);/g).length, 5, 'send, queue, /btw, the warm start that precedes a message, and the shell shortcut');
  assert.equal(panel.match(/_applySessionOptions\(tab, (?:fallbackMsg|config)\);/g).length, 2, 'the ask-answer fallback, and what a control that can start the session carries');
  assert.doesNotMatch(panel, /msg\.permissionMode = tab\.planMode \? 'plan' : \(tab\.permissionMode \|\| 'default'\);\n  (?!\})/);
  const setMode = fnBody(panel, 'function setPermissionModeUI(tab, mode, { announce = true } = {}) {');
  assert.match(setMode, /if \(isDefaultableMode\(mode\)\) storage\.setItem\(STOR\.permissionMode, mode\)/);
  assert.match(setMode, /\n  pickMode\(tab, mode\);\n/);
  const picked = { ...never };
  pickMode(picked, 'default');
  assert.equal(picked.modeChosen, true, 'a pick is what makes a mode the tab\'s own');
  assert.match(fnBody(panel, 'function populateModeDropdown($dd, tab) {'), /permissionModesFor\(\{/);
});

test('permission cards no longer remember a whole tool; elicitation has its own card', () => {
  const show = fnBody(panel, 'function _showNextPerm(tab) {');
  assert.doesNotMatch(show, /_autoAllowTools\.add/, '"Always" goes through the CLI\'s rules');
  assert.match(show, /canInterrupt: hasCapability\(tab, 'deny_interrupt'\)/);
  assert.match(show, /if \(extra\.interrupt\) tab\._abortedAt = Date\.now\(\)/);
  assert.match(show, /renderElicitationCard\(tab, next\.requestId, next\.req, \{/);
  assert.match(show, /editedPlan: \(\) => tab\._editedPlanContent \|\| ''/);
  assert.match(fnBody(panel, 'function handleControlRequest(tab, msg) {'), /req\.subtype === 'elicitation'/);
  assert.doesNotMatch(panel, /SDK_NATIVE_COMMANDS = new Set\(\[[^\]]*'permissions'/);
  assert.match(server, /app\.get\('\/api\/claude-code\/permission-rules'/);
  assert.match(server, /loadHookProjects\(\)\.some\(p => resolve\(p\.path\) === resolve\(requested\)\)/, 'only a registered project is read');
});

test('both question cards carry previews, notes and the answered state', () => {
  // The SDK path shows the card built from the tool call first; the control
  // request then only supplies the request id. Both builders use the same helpers.
  for (const signature of ['function buildAskFromToolUse(tab, block) {', 'function renderAskUserQuestion(tab, requestId, input) {']) {
    const body = fnBody(panel, signature);
    assert.match(body, /decorateAskCard\(/, signature);
    assert.match(body, /askAnnotations\(/, signature);
    assert.match(body, /markAskAnswered\(/, signature);
    assert.match(body, /sendAskAnswer\(tab, allQuestions, pendingAnswers, annotations\)/, signature);
  }
  assert.match(fnBody(panel, 'function sendAskAnswer(tab, questions, answers, annotations = null) {'), /updatedInput: annotations \? \{ questions, answers, annotations \} : \{ questions, answers \}/);
});

// ── C39: rules can be removed, and the session's own record survives a reload ──

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync as exists } from 'node:fs';
import { removePermissionRule, PermissionRuleError } from '../lib/claude-permission-rules.js';
import { permissionRuleSections, hasSessionRules } from '../public/shared/cp/cp-permission-model.js';

test('C39: removing a rule takes one string out of one list and leaves the file alone otherwise', () => {
  const root = mkdtempSync(join(tmpdir(), 'synabun-rules-'));
  try {
    const home = join(root, 'home');
    const project = join(root, 'proj');
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(project, '.claude'), { recursive: true });
    const userFile = join(home, '.claude', 'settings.json');
    writeFileSync(userFile, JSON.stringify({ model: 'opus', hooks: { Stop: [] }, permissions: { defaultMode: 'acceptEdits', allow: ['Bash(npm test:*)', 'Read(//tmp/**)'], deny: ['Bash(rm -rf:*)'] } }, null, 2));
    assert.deepEqual(removePermissionRule({ home, scope: 'user', list: 'allow', rule: 'Bash(npm test:*)' }), { removed: true, path: userFile });
    const after = JSON.parse(readFileSync(userFile, 'utf-8'));
    assert.deepEqual(after, { model: 'opus', hooks: { Stop: [] }, permissions: { defaultMode: 'acceptEdits', allow: ['Read(//tmp/**)'], deny: ['Bash(rm -rf:*)'] } });
    assert.equal(exists(`${userFile}.synabun-tmp`), false);
    // Not there (any more), a missing file, another list: nothing is written.
    assert.equal(removePermissionRule({ home, scope: 'user', list: 'allow', rule: 'Bash(npm test:*)' }).removed, false);
    assert.equal(removePermissionRule({ home, scope: 'user', list: 'ask', rule: 'Read(//tmp/**)' }).removed, false);
    assert.equal(removePermissionRule({ home, project, scope: 'local', list: 'allow', rule: 'x' }).removed, false);
    assert.equal(exists(join(project, '.claude', 'settings.local.json')), false, 'no file is created');
    // A file that does not parse is never rewritten.
    const broken = join(project, '.claude', 'settings.json');
    writeFileSync(broken, '{ not json');
    assert.throws(() => removePermissionRule({ home, project, scope: 'project', list: 'allow', rule: 'x' }), (e) => e instanceof PermissionRuleError && e.status === 409);
    assert.equal(readFileSync(broken, 'utf-8'), '{ not json');
    for (const bad of [{ scope: 'managed', list: 'allow', rule: 'x' }, { scope: 'user', list: 'hooks', rule: 'x' }, { scope: 'user', list: 'allow', rule: '' }, { scope: 'project', list: 'allow', rule: 'x', project: '' }]) {
      assert.throws(() => removePermissionRule({ home, project, ...bad }), (e) => e.status === 400, JSON.stringify(bad));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('C39: the rules view lists one rule per row, per scope', () => {
  const sections = permissionRuleSections({
    user: { exists: true, defaultMode: 'acceptEdits', allow: ['Bash(npm test:*)'], deny: ['Bash(rm -rf:*)'], ask: [], additionalDirectories: ['/data'] },
    project: { exists: true, error: 'could not be read (Unexpected token)' },
    local: { exists: false },
  });
  assert.deepEqual(sections.map(s => [s.scope, s.title]), [['user', 'All my projects'], ['project', 'This project, shared']]);
  assert.equal(sections[0].defaultMode, 'acceptEdits');
  assert.deepEqual(sections[0].items, [
    { list: 'allow', label: 'Allow', rule: 'Bash(npm test:*)' },
    { list: 'deny', label: 'Deny', rule: 'Bash(rm -rf:*)' },
    { list: 'additionalDirectories', label: 'Directory', rule: '/data' },
  ]);
  assert.equal(sections[1].error, 'could not be read (Unexpected token)');
  const many = permissionRuleSections({ user: { exists: true, allow: Array.from({ length: 150 }, (_, i) => `Bash(cmd${i}:*)`) } });
  assert.equal(many[0].items.length, 80);
  assert.equal(many[0].more, 70);
  assert.deepEqual(permissionRuleSections(null), []);
  assert.equal(hasSessionRules([{ type: 'addRules', destination: 'session', rules: [{ toolName: 'Bash' }] }]), true);
  assert.equal(hasSessionRules([{ type: 'addRules', destination: 'localSettings', rules: [{ toolName: 'Bash' }] }]), false);
  assert.equal(hasSessionRules([{ type: 'addRules', rules: [{ toolName: 'Bash' }] }]), true, 'no destination means this session');
  assert.equal(hasSessionRules(null), false);
});

test('C39: the card asks the bridge for its record and removes through the server, both capability-gated', async () => {
  const panel = (await readFile(new URL('../public/shared/ui-claude-panel.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(panel, /hasCapability\(tab, 'permission_rules'\)\n\s+\? _sessionRequest\(tab, 'permission_rules'\)/);
  const card = panel.slice(panel.indexOf('function _renderPermissionsCard('), panel.indexOf('// ── Slash command router ──'));
  assert.match(card, /const canEdit = hasCapability\(tab, 'permission_rules_edit'\);/);
  assert.match(card, /if \(btn\.dataset\.armed !== '1'\) \{/, 'a removal is armed first');
  assert.match(card, /method: 'DELETE'/);
  assert.match(card, /_sessionRequest\(tab, 'forget_session_rules'\)/);
  const route = server.slice(server.indexOf("app.delete('/api/claude-code/permission-rules'"), server.indexOf('// PUT /api/claude-code/tool-permissions'));
  assert.match(route, /loadHookProjects\(\)\.some\(p => resolve\(p\.path\) === resolve\(requested\)\)/, 'only a registered project');
  assert.match(route, /removePermissionRule\(\{ home: /);
});
