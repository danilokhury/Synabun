import test from 'node:test';
import assert from 'node:assert/strict';

import { installMiniDom, MiniElement } from './fixtures/mini-dom.mjs';
import { setCpCtx } from '../public/shared/cp/cp-ctx.js';
import {
  renderSdkEvent,
  noteUnhandledEvent,
  applyEngineHello,
  renderCompactBoundary,
  markToolDenied,
  markDeniedFromResult,
  endTurnRows,
  renderLocalCommandResult,
  renderAssistantExtras,
  annotateAssistantRow,
  evictMessages,
  noteToolInputStart,
  noteToolInputDelta,
  appendTurnFooter,
} from '../public/shared/cp/cp-event-rows.js';
import { splitAssistantBlocks } from '../public/shared/cp/cp-events.js';

// The rendering glue of the Claude sidepanel's event rows, executed against a
// small DOM stand-in (tests/fixtures/mini-dom.mjs). What each event means is
// covered in claude-panel-events.test.mjs; here: what lands in the transcript.

function setup() {
  const dom = installMiniDom();
  const tab = { id: 't1', messagesEl: dom.container('cp-messages'), running: true, currentActivity: null };
  const calls = { compactStarted: 0, compactEnded: 0, modes: [], commands: [], resetUsage: 0, prefill: [], toolResults: [] };
  const row = (cls) => (t, text) => {
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = text;
    t.messagesEl.appendChild(el);
    return el;
  };
  setCpCtx({
    md: (t) => `<p>${t}</p>`,
    esc: (t) => String(t),
    linkifyFilePaths: () => {},
    addCopyButtons: () => {},
    scrollEnd: () => {},
    activeTab: () => tab,
    saveTabs: () => {},
    panel: () => null, // no statusline in these tests
    appendStatus: row('msg-status'),
    appendWarn: row('msg-warn'),
    appendError: row('msg-error'),
    appendInfoCard: (t, { title, body = '', html = null }) => {
      const el = document.createElement('div');
      el.className = 'msg msg-info-card';
      el.dataset.title = title;
      const content = document.createElement('div');
      content.className = 'cp-info-content';
      if (html) content.innerHTML = html; else content.textContent = body;
      el.appendChild(content);
      t.messagesEl.appendChild(el);
      return el;
    },
    buildTool: (block) => toolCard(block.id, block.name),
    updateToolResult: (t, ev) => { calls.toolResults.push(ev); },
    compactStarted: () => { calls.compactStarted++; },
    compactEnded: () => { calls.compactEnded++; },
    applyPermissionMode: (t, mode) => { calls.modes.push(mode); },
    setSlashCommands: (t, commands) => { calls.commands.push(commands); },
    resetUsage: () => { calls.resetUsage++; },
    prefillInput: (text) => { calls.prefill.push(text); },
  });
  return { dom, tab, calls };
}

function toolCard(id, name = 'Bash', extraClass = '') {
  const card = document.createElement('div');
  card.className = `tool-card${extraClass ? ` ${extraClass}` : ''}`;
  card.dataset.toolId = id;
  card.dataset.toolName = name;
  const hdr = document.createElement('div');
  hdr.className = 'tool-hdr';
  const detail = document.createElement('span');
  detail.className = 'tool-detail';
  const chevron = document.createElement('span');
  chevron.className = 'tool-chevron';
  hdr.append(detail, chevron);
  card.appendChild(hdr);
  return card;
}

function assistantRow(tab, cards = []) {
  const row = document.createElement('div');
  row.className = 'msg msg-assistant';
  const wrap = document.createElement('div');
  wrap.className = 'msg-content';
  for (const c of cards) wrap.appendChild(c);
  row.appendChild(wrap);
  tab.messagesEl.appendChild(row);
  return { row, wrap };
}

const texts = (tab, selector) => tab.messagesEl.querySelectorAll(selector).map(n => n.textContent);

test('an unknown event leaves one transcript-only row per kind, and never throws', () => {
  const { dom, tab } = setup();
  try {
    assert.equal(renderSdkEvent(tab, tab, { type: 'system', subtype: 'brand_new' }).kind, 'unknown');
    renderSdkEvent(tab, tab, { type: 'system', subtype: 'brand_new' });
    renderSdkEvent(tab, tab, { type: 'other_new' });
    renderSdkEvent(tab, tab, { type: 'keep_alive' });
    assert.deepEqual(texts(tab, '.cp-unhandled-event'), ['Unhandled event: system/brand_new', 'Unhandled event: other_new']);
    assert.ok(tab.messagesEl.querySelector('.cp-unhandled-event').classList.contains('cp-transcript-only'));
    assert.equal(tab.messagesEl.querySelector('.msg-status'), null, 'not a status row: the empty state must not hide for it');
    assert.equal(noteUnhandledEvent(tab, 'ws:future'), true);
    assert.equal(noteUnhandledEvent(tab, 'ws:future'), false);
  } finally { dom.restore(); }
});

test('an unavailable engine shows one row with a retry, removed when the engine is back', () => {
  const { dom, tab } = setup();
  try {
    let reconnects = 0;
    const hello = applyEngineHello(tab, { type: 'engine', engine: 'unavailable', error: 'bridge failed to load' }, { reconnect: () => { reconnects++; } });
    assert.equal(hello.unavailable, true);
    applyEngineHello(tab, { type: 'engine', engine: 'unavailable', error: 'bridge failed to load' }, { reconnect: () => { reconnects++; } });
    const rows = tab.messagesEl.querySelectorAll('.cp-engine-error');
    assert.equal(rows.length, 1, 'a reconnect does not stack rows');
    assert.match(rows[0].textContent, /Claude Code is unavailable: bridge failed to load/);
    rows[0].querySelector('.cp-engine-retry').click();
    assert.equal(reconnects, 1);
    assert.equal(tab.engineError, 'bridge failed to load');

    const ok = applyEngineHello(tab, { type: 'engine', engine: 'sdk', capabilities: ['capabilities'] });
    assert.deepEqual(ok.capabilities, ['capabilities']);
    assert.equal(tab.messagesEl.querySelector('.cp-engine-error'), null);
    assert.equal(tab.engineError, '');
    assert.deepEqual(texts(tab, '.msg-status'), ['Claude Code is available again.']);
  } finally { dom.restore(); }
});

test('rows by level, and keyed rows update in place', () => {
  const { dom, tab } = setup();
  try {
    renderSdkEvent(tab, tab, { type: 'system', subtype: 'informational', level: 'warning', content: 'A hook blocked the edit' });
    renderSdkEvent(tab, tab, { type: 'system', subtype: 'informational', level: 'info', content: 'debug detail' });
    renderSdkEvent(tab, tab, { type: 'system', subtype: 'informational', level: 'suggestion', content: 'Try /compact' });
    assert.deepEqual(texts(tab, '.msg-warn'), ['A hook blocked the edit']);
    assert.deepEqual(texts(tab, '.cp-transcript-only'), ['debug detail']);
    assert.ok(tab.messagesEl.querySelector('.msg-status').classList.contains('cp-row-notice'));

    renderSdkEvent(tab, tab, { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 1000, error_status: 529, error: 'overloaded' });
    renderSdkEvent(tab, tab, { type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 2000, error_status: 529, error: 'overloaded' });
    const retries = texts(tab, '.msg-status').filter(t => t.startsWith('API request failed'));
    assert.deepEqual(retries, ['API request failed (overloaded, 529). Retry 2/10 in 2.0s.'], 'one line, updated');
    assert.equal(tab.currentActivity.verb, 'Retrying 2/10 · overloaded');

    endTurnRows(tab);
    renderSdkEvent(tab, tab, { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: null, error: 'unknown' });
    assert.equal(texts(tab, '.msg-status').filter(t => t.startsWith('API request failed')).length, 2, 'the next turn gets its own line');
  } finally { dom.restore(); }
});

test('status: compaction start, failure, and the mode the CLI switched to', () => {
  const { dom, tab, calls } = setup();
  try {
    renderSdkEvent(tab, tab, { type: 'system', subtype: 'status', status: 'compacting', permissionMode: 'plan' });
    assert.equal(calls.compactStarted, 1);
    assert.deepEqual(calls.modes, ['plan']);

    const running = document.createElement('div');
    running.className = 'msg-status msg-compact-status';
    tab.messagesEl.appendChild(running);
    renderSdkEvent(tab, tab, { type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'prompt too long' });
    assert.equal(calls.compactEnded, 1);
    assert.equal(running.textContent, 'Compaction failed');
    assert.deepEqual(texts(tab, '.msg-error'), ['Compaction failed: prompt too long']);

    tab.currentActivity = null;
    renderSdkEvent(tab, tab, { type: 'system', subtype: 'status', status: 'requesting' });
    assert.equal(tab.currentActivity.verb, 'Waiting for the model');
  } finally { dom.restore(); }
});

test('each compaction keeps its own line', () => {
  const { dom, tab } = setup();
  try {
    renderCompactBoundary(tab, { compact_metadata: { trigger: 'auto', pre_tokens: 180_000, post_tokens: 40_000 } });
    renderCompactBoundary(tab, { compact_metadata: { trigger: 'manual', pre_tokens: 90_000, post_tokens: 20_000 } });
    assert.deepEqual(texts(tab, '.msg-compact-status'), [
      'Context compacted automatically: 180k → 40k tokens',
      'Context compacted: 90k → 20k tokens',
    ]);
    // A "compacting" line that is still open is completed, not duplicated.
    const open = document.createElement('div');
    open.className = 'msg-status msg-compact-status';
    open.textContent = 'Compacting context…';
    tab.messagesEl.appendChild(open);
    renderCompactBoundary(tab, { compact_metadata: { trigger: 'auto', pre_tokens: 50_000, post_tokens: 10_000 } });
    assert.equal(tab.messagesEl.querySelectorAll('.msg-compact-status').length, 3);
    assert.equal(open.textContent, 'Context compacted automatically: 50k → 10k tokens');
  } finally { dom.restore(); }
});

test('a denied tool call is marked on its card, even when the event arrives first', () => {
  const { dom, tab } = setup();
  try {
    const { wrap } = assistantRow(tab, [toolCard('t1')]);
    renderSdkEvent(tab, tab, { type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 't1', decision_reason_type: 'rule', decision_reason: 'Bash(rm:*) is denied', message: 'no' });
    const card = wrap.querySelector('.tool-card');
    assert.ok(card.classList.contains('tool-denied'));
    assert.equal(card.querySelector('.cp-denied-badge').textContent, 'denied');
    assert.equal(card.querySelector('.cp-denied-reason').textContent, 'Denied by a permission rule: Bash(rm:*) is denied');
    renderSdkEvent(tab, tab, { type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 't1', decision_reason_type: 'rule', decision_reason: 'again', message: 'no' });
    assert.equal(card.querySelectorAll('.cp-denied-badge').length, 1);

    // Event before the card exists: applied when the assistant message renders.
    assert.equal(markToolDenied(tab, { toolUseId: 't2', reasonType: 'classifier', reason: 'looks destructive' }), false);
    const second = assistantRow(tab, [toolCard('t2')]);
    tab.currentMsgEl = second.row; tab.currentMsgId = 'm2';
    annotateAssistantRow(tab, tab, { type: 'assistant', uuid: 'u2', message: { id: 'm2', content: [] } });
    assert.equal(second.wrap.querySelector('.cp-denied-reason').textContent, 'Denied by the auto-mode classifier: looks destructive');

    // The result's list is authoritative: a call never announced is still marked.
    const third = assistantRow(tab, [toolCard('t3')]);
    markDeniedFromResult(tab, [{ tool_name: 'Edit', tool_use_id: 't3', tool_input: {} }, { tool_name: 'Bash', tool_use_id: 't1', tool_input: {} }, { tool_use_id: 'gone' }]);
    assert.ok(third.wrap.querySelector('.tool-card').classList.contains('tool-denied'));
    assert.equal(third.wrap.querySelector('.cp-denied-reason'), null);
    assert.equal(card.querySelector('.cp-denied-reason').textContent, 'Denied by a permission rule: again', 'an explained denial keeps its reason');
  } finally { dom.restore(); }
});

test('tool progress shows elapsed time on generic cards only', () => {
  const { dom, tab } = setup();
  try {
    const generic = toolCard('g1', 'mcp__x__y');
    const bash = toolCard('b1', 'Bash', 'cp-bash-card');
    const agent = toolCard('a1', 'Agent', 'cp-agent-card');
    const now = document.createElement('div');
    now.className = 'cp-agent-now';
    agent.appendChild(now);
    assistantRow(tab, [generic, bash, agent]);
    renderSdkEvent(tab, tab, { type: 'tool_progress', tool_use_id: 'g1', tool_name: 'x', elapsed_time_seconds: 75 });
    renderSdkEvent(tab, tab, { type: 'tool_progress', tool_use_id: 'b1', tool_name: 'Bash', elapsed_time_seconds: 5 });
    renderSdkEvent(tab, tab, { type: 'tool_progress', tool_use_id: 'a1', tool_name: 'Agent', elapsed_time_seconds: 9, subagent_retry: { attempt: 1, max_retries: 3, error_category: 'overloaded' } });
    renderSdkEvent(tab, tab, { type: 'tool_progress', tool_use_id: 'missing', tool_name: 'x', elapsed_time_seconds: 1 });
    assert.equal(generic.querySelector('.cp-tool-elapsed').textContent, '1m 15s');
    assert.equal(bash.querySelector('.cp-tool-elapsed'), null, 'bash cards time themselves');
    assert.equal(now.textContent, 'retrying 1/3 (overloaded)');
    generic.classList.add('tool-ok');
    renderSdkEvent(tab, tab, { type: 'tool_progress', tool_use_id: 'g1', tool_name: 'x', elapsed_time_seconds: 99 });
    assert.equal(generic.querySelector('.cp-tool-elapsed').textContent, '1m 15s', 'a finished card stops counting');
  } finally { dom.restore(); }
});

test('a tool-use summary folds the calls it covers', () => {
  const { dom, tab } = setup();
  try {
    const { wrap } = assistantRow(tab, [toolCard('a'), toolCard('b'), toolCard('c')]);
    renderSdkEvent(tab, tab, { type: 'tool_use_summary', summary: 'Read 2 files', preceding_tool_use_ids: ['a', 'b'] });
    const group = wrap.querySelector('.cp-tool-group');
    assert.equal(group.querySelector('.cp-tool-group-text').textContent, 'Read 2 files');
    assert.equal(group.querySelector('.cp-tool-group-count').textContent, '2 tools');
    assert.deepEqual(group.querySelectorAll('.tool-card').map(c => c.dataset.toolId), ['a', 'b']);
    assert.deepEqual(wrap.children.map(c => c.className), ['cp-tool-group', 'tool-card'], 'the group sits where the first call was');
    assert.ok(tab.messagesEl.querySelector('.tool-card[data-tool-id="a"]'), 'a folded card is still found by id');

    // Calls that do not sit together get a line after the last of them.
    const other = assistantRow(tab, [toolCard('x'), toolCard('y'), toolCard('z')]);
    renderSdkEvent(tab, tab, { type: 'tool_use_summary', summary: 'Checked two things', preceding_tool_use_ids: ['x', 'z'] });
    assert.equal(other.wrap.querySelector('.cp-tool-group'), null);
    assert.equal(other.wrap.children.at(-1).className, 'cp-tool-summary');
    // No card on screen: the summary is still said.
    renderSdkEvent(tab, tab, { type: 'tool_use_summary', summary: 'Searched the web', preceding_tool_use_ids: ['nope'] });
    assert.ok(texts(tab, '.msg-status').includes('Searched the web'));
  } finally { dom.restore(); }
});

test('a rate limit is announced when its state changes, not on every event', () => {
  const { dom, tab } = setup();
  try {
    const warn = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.9 } };
    renderSdkEvent(tab, tab, warn);
    renderSdkEvent(tab, tab, warn);
    assert.equal(tab.messagesEl.querySelectorAll('.cp-limit-row').length, 1);
    assert.deepEqual([tab.rateLimit.level, tab.rateLimit.pill], ['warn', '5h 90%']);
    renderSdkEvent(tab, tab, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } });
    const rows = tab.messagesEl.querySelectorAll('.cp-limit-row');
    assert.equal(rows.length, 2);
    assert.ok(rows[1].classList.contains('cp-limit-blocked'));
    renderSdkEvent(tab, tab, { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' } });
    assert.equal(tab.rateLimit, null, 'the pill clears when the limit does');
    assert.equal(tab.messagesEl.querySelectorAll('.cp-limit-row').length, 2);
  } finally { dom.restore(); }
});

test('a refusal retracts the refused partial and offers the prompt back', () => {
  const { dom, tab, calls } = setup();
  try {
    const user = document.createElement('div');
    user.className = 'msg msg-user';
    user.dataset.uuid = 'u7';
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.append('write the exploit');
    user.appendChild(bubble);
    tab.messagesEl.appendChild(user);
    const refused = assistantRow(tab);
    refused.row.dataset.uuids = 'm1 m2';
    const mixed = assistantRow(tab);
    mixed.row.dataset.uuids = 'm3 keep';
    tab.currentMsgEl = refused.row; tab.currentMsgId = 'x';

    renderSdkEvent(tab, tab, {
      type: 'system', subtype: 'model_refusal_fallback', direction: 'retry', scope: 'session',
      original_model: 'claude-fable-5-1', fallback_model: 'claude-opus-5-5', content: 'Declined.',
      retracted_message_uuids: ['m1', 'm2', 'm3'], refused_user_message_uuid: 'u7',
    });
    assert.equal(refused.row.isConnected, false, 'a fully retracted row is removed');
    assert.equal(tab.currentMsgEl, null);
    assert.ok(mixed.row.classList.contains('cp-retracted'), 'a partly retracted row is marked');
    const notice = tab.messagesEl.querySelector('.cp-refusal-row');
    assert.match(notice.textContent, /continues on claude-opus-5-5/);
    notice.querySelector('button').click();
    assert.deepEqual(calls.prefill, ['write the exploit']);
    assert.equal(evictMessages(tab, []), 0);
  } finally { dom.restore(); }
});

test('command output, memory recall, reset, auth and thinking tokens', () => {
  const { dom, tab, calls } = setup();
  try {
    renderSdkEvent(tab, tab, { type: 'system', subtype: 'local_command_output', content: '**Doctor** ok' });
    const card = tab.messagesEl.querySelector('.msg-info-card');
    assert.equal(card.dataset.title, 'Command output');
    assert.equal(card.querySelector('.cp-info-content').innerHTML, '<p>**Doctor** ok</p>');
    // The turn's result repeats the text: not printed twice.
    assert.equal(renderLocalCommandResult(tab, '**Doctor** ok'), null);
    tab._turnOutputShown = false;
    assert.ok(renderLocalCommandResult(tab, 'Total cost: $1'), 'a command that only answered through the result is shown');
    assert.equal(renderLocalCommandResult({ ...tab, _turnOutputShown: false }, ''), null);

    renderSdkEvent(tab, tab, { type: 'system', subtype: 'memory_recall', mode: 'select', memories: [{ path: '/m/a.md', scope: 'personal' }, { path: 'https://org/x', scope: 'organization', content: 'policy text' }] });
    const recall = tab.messagesEl.querySelector('.cp-memory-recall');
    assert.equal(recall.querySelector('summary').textContent, 'Recalled 2 Claude memory files');
    assert.deepEqual(recall.querySelectorAll('.cp-memory-recall-path').map(n => n.textContent), ['/m/a.md', 'https://org/x']);
    assert.equal(recall.querySelector('.cp-memory-recall-content').textContent, 'policy text');

    tab.sessionId = 's1';
    tab._modelUsagePrev = { sid: 's1', usage: { m: {} } };
    renderSdkEvent(tab, tab, { type: 'conversation_reset', new_conversation_id: 'n', trigger: 'clear' });
    assert.match(tab.messagesEl.querySelector('.cp-reset-divider').textContent, /^Conversation cleared/);
    assert.equal(calls.resetUsage, 1);
    assert.deepEqual(tab._modelUsagePrev, { sid: 's1', usage: {} }, 'the usage baseline starts over');
    assert.equal(tab._freshSessionId, 'n');

    renderSdkEvent(tab, tab, { type: 'auth_status', isAuthenticating: true, output: ['Open the browser'] });
    renderSdkEvent(tab, tab, { type: 'auth_status', isAuthenticating: false, output: ['Open the browser', 'Signed in'], error: 'token expired' });
    const auth = tab.messagesEl.querySelectorAll('.msg-info-card').filter(c => c.dataset.title === 'Sign-in');
    assert.equal(auth.length, 1, 'one card, updated');
    assert.equal(auth[0].querySelector('.cp-info-content').textContent, 'Open the browser\nSigned in');
    assert.ok(texts(tab, '.msg-error').includes('Sign-in failed: token expired'));

    tab.thinkingEl = document.createElement('div');
    renderSdkEvent(tab, tab, { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 1200, estimated_tokens_delta: 10 });
    renderSdkEvent(tab, tab, { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 2500, estimated_tokens_delta: 10 });
    assert.deepEqual(tab.thinkingEl.querySelectorAll('.think-tokens').map(n => n.textContent), ['~2.5k thinking tokens']);

    renderSdkEvent(tab, tab, { type: 'system', subtype: 'commands_changed', commands: [{ name: 'new-skill' }] });
    assert.deepEqual(calls.commands, [[{ name: 'new-skill' }]]);
    renderSdkEvent(tab, tab, { type: 'system', subtype: 'session_info', info: { account: { email: 'me@example.com' }, models: [] } });
    assert.equal(tab.accountInfo.email, 'me@example.com');
  } finally { dom.restore(); }
});

test('assistant extras: server tools, their results, citations, redacted thinking', () => {
  const { dom, tab, calls } = setup();
  try {
    const { wrap } = assistantRow(tab);
    const extras = splitAssistantBlocks([
      { type: 'redacted_thinking', data: 'x' },
      { type: 'server_tool_use', id: 'srv1', name: 'web_search', input: { query: 'q' } },
      { type: 'web_search_tool_result', tool_use_id: 'srv1', content: [{ type: 'web_search_result', title: 'Docs', url: 'https://example.com/docs' }] },
      { type: 'text', text: 'Answer', citations: [{ url: 'https://example.com/docs', title: 'Docs' }, { document_title: 'spec.pdf' }] },
    ]);
    renderAssistantExtras(tab, wrap, extras, { showThinking: true });
    renderAssistantExtras(tab, wrap, extras, { showThinking: true }); // a partial-message update repeats the blocks
    assert.equal(wrap.querySelectorAll('.cp-thinking-redacted').length, 1);
    const cards = wrap.querySelectorAll('.tool-card');
    assert.equal(cards.length, 1);
    assert.ok(cards[0].classList.contains('cp-server-tool'));
    assert.equal(calls.toolResults[0].tool_use_id, 'srv1');
    assert.equal(calls.toolResults[0].content, 'Docs\nhttps://example.com/docs');
    const cites = wrap.querySelectorAll('.cp-citation');
    assert.deepEqual(cites.map(c => [c.tagName, c.textContent, c.href || '']), [['A', 'Docs', 'https://example.com/docs'], ['SPAN', 'spec.pdf', '']]);
    assert.equal(cites[0].rel, 'noopener noreferrer');

    const hidden = assistantRow(tab);
    renderAssistantExtras(tab, hidden.wrap, splitAssistantBlocks([{ type: 'redacted_thinking', data: 'x' }]), { showThinking: false });
    assert.equal(hidden.wrap.querySelector('.cp-thinking-redacted'), null, 'thinking off hides the placeholder too');
  } finally { dom.restore(); }
});

test('the wrapper of an assistant message annotates its row', () => {
  const { dom, tab } = setup();
  try {
    const { row, wrap } = assistantRow(tab);
    tab.currentMsgEl = row; tab.currentMsgId = 'm1';
    annotateAssistantRow(tab, tab, { type: 'assistant', uuid: 'u1', timestamp: '2026-10-03T12:00:00Z', message: { id: 'm1', content: [] } });
    annotateAssistantRow(tab, tab, { type: 'assistant', uuid: 'u2', aborted: true, message: { id: 'm1', stop_reason: 'max_tokens', content: [] } });
    assert.equal(row.dataset.uuids, 'u1 u2', 'every block of the message stamps its uuid');
    assert.ok(row.title);
    assert.equal(wrap.querySelector('.cp-msg-note').textContent, 'interrupted · cut off at the output limit');

    annotateAssistantRow(tab, tab, { type: 'assistant', uuid: 'u3', error: 'authentication_failed', message: { id: 'm1', model: '<synthetic>', content: [{ type: 'text', text: 'Invalid API key' }] } });
    annotateAssistantRow(tab, tab, { type: 'assistant', uuid: 'u3', error: 'authentication_failed', message: { id: 'm1', model: '<synthetic>', content: [] } });
    assert.equal(wrap.querySelectorAll('.cp-assistant-error').length, 1);
    assert.match(wrap.querySelector('.cp-assistant-error').textContent, /^Not signed in\. The sign-in is missing or expired/);

    // No row for this message (it rendered nothing): the error still shows.
    tab.currentMsgEl = null; tab.currentMsgId = null;
    annotateAssistantRow(tab, tab, { type: 'assistant', uuid: 'u4', error: 'billing_error', message: { id: 'm9', content: [] } });
    assert.ok(texts(tab, '.msg-error').some(t => t.startsWith('Billing problem.')));

    const limit = assistantRow(tab);
    tab.currentMsgEl = limit.row; tab.currentMsgId = 'm2';
    annotateAssistantRow(tab, tab, { type: 'assistant', uuid: 'u5', message: { id: 'm2', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your 5-hour limit" }] } });
    assert.ok(limit.row.classList.contains('cp-limit-blocked'));

    // A message that supersedes earlier ones evicts them.
    annotateAssistantRow(tab, tab, { type: 'assistant', uuid: 'u6', supersedes: ['u1', 'u2', 'u3'], message: { id: 'm3', content: [] } });
    assert.equal(row.isConnected, false);
  } finally { dom.restore(); }
});

test('streaming tool input previews on the ghost card', async () => {
  const { dom, tab } = setup();
  try {
    const { row } = assistantRow(tab, [toolCard('g1', 'Bash', 'tool-streaming')]);
    const stream = { el: row };
    noteToolInputStart(stream, 1, { id: 'g1', name: 'Bash' });
    noteToolInputDelta(stream, 1, '{"comma');
    noteToolInputDelta(stream, 1, 'nd": "npm run test');
    noteToolInputDelta(stream, 7, 'ignored: no such block');
    await new Promise(r => setTimeout(r, 160));
    assert.equal(row.querySelector('.tool-detail').textContent, 'npm run test');
    assert.equal(stream.toolBlocks[1].json, '{"command": "npm run test');
  } finally { dom.restore(); }
});

test('the turn footer is one quiet row with the breakdown as its tooltip', () => {
  const { dom, tab } = setup();
  try {
    assert.equal(appendTurnFooter(tab, { text: '' }), null);
    const el = appendTurnFooter(tab, { text: '12s · 3 steps', title: 'claude-opus-5-5: 300 input' });
    assert.equal(el.className, 'cp-turn-footer');
    assert.equal(el.title, 'claude-opus-5-5: 300 input');
    assert.ok(tab.messagesEl.children.at(-1) === el);
    assert.ok(el instanceof MiniElement);
  } finally { dom.restore(); }
});
