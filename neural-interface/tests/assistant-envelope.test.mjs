import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mcpResultText, codexControlResponse, codexControlRequestFromServerRequest, codexToolResultFromItem,
  opencodeControlResponse, opencodeControlRequestFromEvent, createOpenCodeEnvelopeTranslator, createCodexEnvelopeTranslator,
} from '../lib/assistant-envelope.js';

test('Codex translator consumes resolved bridge requests without creating pending approvals', () => {
  const packets = [];
  const translator = createCodexEnvelopeTranslator({ emit: packet => packets.push(packet) });
  const request = { type: 'server_request', requestId: 7, method: 'item/commandExecution/requestApproval', params: { command: 'node --test', itemId: 'exec-1' } };
  assert.equal(translator.handle({ ...request, resolved: true }), true);
  assert.equal(packets.length, 0);
  assert.equal(translator.handle({ ...request, resolved: false }), true);
  assert.equal(packets.length, 1);
  assert.equal(packets[0].type, 'control_request');
  assert.equal(translator.handle({ ...request, requestId: 8 }), true);
  assert.equal(packets.length, 2);
});

test('mcpResultText joins text blocks and replaces images with a placeholder (no base64 in transcripts)', () => {
  const result = { content: [{ type: 'text', text: 'ok · left_click (1,2) · frame=f_1 size=1280x800' }, { type: 'image', data: 'A'.repeat(50_000), mimeType: 'image/jpeg' }] };
  assert.equal(mcpResultText(result), 'ok · left_click (1,2) · frame=f_1 size=1280x800\n[image: image/jpeg]');
  assert.equal(mcpResultText('plain'), 'plain');
  assert.equal(mcpResultText({ content: [{ type: 'text', text: 'bad' }], isError: true }), 'Error: bad');
  const tool = codexToolResultFromItem({ type: 'mcpToolCall', result: result });
  assert.ok(!tool.content.includes('AAAA'), 'Codex MCP results no longer dump image data');
});

test('Codex replies: answers and content are read from result.* as well as the top level; decline is honoured', () => {
  const question = { type: 'server_request', requestId: 7, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'q1', question: 'Which?' }] } };
  const pendingQ = { type: 'control_request', ...codexControlRequestFromServerRequest(question) };
  const viaResult = codexControlResponse(pendingQ, { behavior: 'allow', result: { answers: { q1: { answers: ['A'] } } } });
  assert.deepEqual(viaResult.result.answers, { q1: { answers: ['A'] } });
  const viaTop = codexControlResponse(pendingQ, { behavior: 'allow', answers: { q1: 'B' } });
  assert.deepEqual(viaTop.result.answers, { q1: { answers: ['B'] } });
  const elicitation = { type: 'server_request', requestId: 8, method: 'mcpServer/elicitation/request', params: { message: 'pick', requestedSchema: {} } };
  const pendingE = { type: 'control_request', ...codexControlRequestFromServerRequest(elicitation) };
  assert.deepEqual(codexControlResponse(pendingE, { behavior: 'allow', result: { content: { choice: 'x' } } }).result, { action: 'accept', content: { choice: 'x' }, _meta: {} });
  assert.equal(codexControlResponse(pendingE, { behavior: 'deny', result: { action: 'decline' } }).result.action, 'decline');
  assert.equal(codexControlResponse(pendingE, { behavior: 'deny' }).result.action, 'cancel');
});

test('OpenCode permission replies honour an explicit reply (always stays always)', () => {
  const pending = { type: 'control_request', ...opencodeControlRequestFromEvent('permission.asked', { id: 'p1', permission: 'bash' }) };
  assert.equal(opencodeControlResponse(pending, { behavior: 'allow', reply: 'always' }).reply, 'always');
  assert.equal(opencodeControlResponse(pending, { behavior: 'allow' }).reply, 'once');
  assert.equal(opencodeControlResponse(pending, { behavior: 'allow', always: true }).reply, 'always');
  assert.equal(opencodeControlResponse(pending, { behavior: 'deny' }).reply, 'reject');
});

test('OpenCode translator reports a running cost total summed per assistant message', () => {
  const packets = [];
  const ends = [];
  const translator = createOpenCodeEnvelopeTranslator({ sessionId: 's1', emit: (p) => packets.push(p), onTurnEnd: (info) => ends.push(info) });
  translator.handle('message.updated', { info: { id: 'm1', role: 'assistant', sessionID: 's1', cost: 0.01 } });
  translator.handle('message.updated', { info: { id: 'm2', role: 'assistant', sessionID: 's1', cost: 0.02 } });
  translator.handle('message.updated', { info: { id: 'm2', role: 'assistant', sessionID: 's1', cost: 0.03 } });
  translator.handle('session.idle', { sessionID: 's1' });
  assert.equal(ends[0].costUsd, 0.04);
  const result = packets.find((p) => p.event?.type === 'result');
  assert.equal(result.event.total_cost_usd, 0.04);
});

test('OpenCode usage hook sees child session events before the root envelope filters them', () => {
  const seen = [];
  const packets = [];
  const translator = createOpenCodeEnvelopeTranslator({ sessionId: 'root', emit: (packet) => packets.push(packet), onUsageEvent: (type, event) => seen.push([type, event.info?.id]) });
  translator.handle('session.created', { info: { id: 'child' } });
  translator.handle('session.updated', { info: { id: 'child' } });
  translator.handle('message.updated', { info: { id: 'message', sessionID: 'child', role: 'assistant', tokens: { input: 7 } } });
  assert.deepEqual(seen, [['session.created', 'child'], ['session.updated', 'child'], ['message.updated', 'message']]);
  assert.equal(packets.length, 0);
});

test('a Codex approval reply carries the app-server id as sent (0, not "0"): Codex drops a reply whose id type differs', () => {
  const approval = { type: 'server_request', requestId: 0, method: 'item/commandExecution/requestApproval', threadId: 't1', turnId: 'u1', params: { command: 'node --test', itemId: 'exec-1' } };
  const pending = { type: 'control_request', ...codexControlRequestFromServerRequest(approval) };
  assert.equal(pending.request_id, '0', 'the card key stays a string');
  const reply = codexControlResponse(pending, { behavior: 'allow' });
  assert.equal(reply.requestId, 0);
  assert.deepEqual(reply.result, { decision: 'accept' });
  assert.equal(codexControlResponse(pending, { behavior: 'deny' }).requestId, 0);
});

test('a usage hook that throws never reaches the turn: Codex still ends it, OpenCode still reads the event', () => {
  const boom = () => { throw new Error('meter broke'); };
  const codexPackets = [];
  const codexEnds = [];
  const codex = createCodexEnvelopeTranslator({ emit: (packet) => codexPackets.push(packet), onUsage: boom, onTurnEnd: (info) => codexEnds.push(info), priceUsage: () => 0.5 });
  codex.handle({ type: 'notify', threadId: 't1', method: 'turn/started', params: { turn: { id: 'u1' } } });
  codex.handle({ type: 'notify', method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { inputTokens: 10, outputTokens: 2 } } } });
  codex.handle({ type: 'notify', method: 'turn/completed', params: { turn: { id: 'u1', status: 'completed' } } });
  assert.equal(codexEnds.length, 1, 'onTurnEnd ran: the brain is not left busy');
  assert.equal(codexEnds[0].status, 'completed');
  assert.deepEqual(codexPackets.at(-1), { type: 'done', code: 0 });
  // The dollar path still reads the usage the hook choked on.
  assert.equal(codexPackets.find((packet) => packet.event?.type === 'result').event.total_cost_usd, 0.5);

  const packets = [];
  const ends = [];
  const opencode = createOpenCodeEnvelopeTranslator({ sessionId: 's1', emit: (packet) => packets.push(packet), onUsageEvent: boom, onTurnEnd: (info) => ends.push(info) });
  assert.equal(opencode.handle('message.updated', { info: { id: 'm1', role: 'assistant', sessionID: 's1', cost: 0.02, tokens: { input: 3 } } }), true);
  assert.equal(opencode.handle('session.idle', { sessionID: 's1' }), true);
  assert.equal(ends[0].costUsd, 0.02, 'the cost of the message was still read');
  assert.deepEqual(packets.at(-1), { type: 'done', code: 0 });
});
