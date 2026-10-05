import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnEvidence, recordProviderEvent, evidenceSnapshot, claimEvidenceLine } from '../lib/assistant-evidence.js';

// Provider-event payloads as the native loop adapters emit them: { provider, runId, eventType?, event }.
const claudeUse = (id, name, input, extra = {}) => ({ provider: 'claude-code', runId: 'r', event: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }, ...extra } });
const claudeResult = (id, content, { isError = false, tur } = {}) => ({
  provider: 'claude-code', runId: 'r',
  event: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }, ...(tur !== undefined ? { tool_use_result: tur } : {}) },
});
const codexItem = (item) => ({ provider: 'codex', runId: 'r', event: { type: 'item.completed', item } });
const openPart = (callID, tool, state) => ({ provider: 'opencode', runId: 'r', eventType: 'message.part.updated', event: { part: { id: `p-${callID}`, type: 'tool', callID, tool, state } } });
const feed = (payloads) => { const acc = createTurnEvidence(); for (const p of payloads) recordProviderEvent(acc, p); return acc; };

test('Claude: Bash exits follow the hooks (ok, error, interrupted, background), edits add files, quiet tools are not evidence', () => {
  const acc = feed([
    claudeUse('t1', 'Bash', { command: 'npm test' }),
    claudeResult('t1', 'Exit code 1\n2 failing', { isError: true, tur: 'Error: Exit code 1\n2 failing' }),
    claudeUse('t2', 'Bash', { command: 'sleep 100' }),
    claudeResult('t2', '', { tur: { stdout: '', stderr: '', interrupted: true } }),
    claudeUse('t3', 'Bash', { command: 'npm run dev', run_in_background: true }),
    claudeResult('t3', 'Command running in background with ID: b1.', { tur: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' } }),
    claudeUse('t4', 'Bash', { command: 'ls' }),
    claudeResult('t4', 'src', { tur: { stdout: 'src\nREADME.md', stderr: '', interrupted: false } }),
    claudeUse('e1', 'Edit', { file_path: '/repo/src/auth.ts', old_string: 'a', new_string: 'b' }),
    claudeResult('e1', 'The file has been updated'),
    claudeUse('r1', 'Read', { file_path: '/repo/src/auth.ts' }),
    claudeResult('r1', 'export function login() {}'),
    claudeUse('m1', 'mcp__SynaBun__recall', { query: 'x' }),
    claudeResult('m1', 'no memories'),
    claudeUse('b1', 'mcp__SynaBun__browser_navigate', { url: 'http://localhost:3000' }),
    claudeResult('b1', 'Navigated: title "Login"'),
    { provider: 'claude-code', event: { type: 'stream_event', event: { type: 'content_block_delta' } } },
  ]);
  const snap = evidenceSnapshot(acc);
  assert.deepEqual(snap.commands.map((c) => [c.command, c.exit]), [['npm test', 'error'], ['sleep 100', 'interrupted'], ['npm run dev', 'background'], ['ls', 'ok']]);
  assert.equal(snap.commands[3].output_tail, 'src\nREADME.md', 'stdout + stderr of the structured result');
  assert.deepEqual(snap.files, ['/repo/src/auth.ts']);
  assert.deepEqual(snap.results, [{ tool: 'mcp__SynaBun__browser_navigate', is_error: false, tail: 'Navigated: title "Login"' }]);
  assert.deepEqual(snap.checks.map((c) => c.command), ['npm test']);
  assert.equal(snap.hasEvidence, true);
  assert.equal(claimEvidenceLine(snap), 'the last `npm test` exited with an error');
});

test('Claude: a turn with only quiet tools exposes no evidence; a Bash call with no result reads as interrupted', () => {
  const quiet = feed([
    claudeUse('r1', 'Read', { file_path: '/x' }), claudeResult('r1', 'text'),
    claudeUse('g1', 'Grep', { pattern: 'x' }), claudeResult('g1', 'hit'),
    claudeUse('w1', 'Write', { file_path: '/repo/new.md', content: 'x' }), claudeResult('w1', 'ok'),
    claudeUse('m1', 'mcp__SynaBun__remember', { content: 'x' }), claudeResult('m1', 'Remembered'),
  ]);
  const snap = evidenceSnapshot(quiet);
  assert.equal(snap.hasEvidence, false);
  assert.deepEqual(snap.files, ['/repo/new.md']);
  assert.equal(claimEvidenceLine(snap), 'no test/build command ran this turn');
  const cut = evidenceSnapshot(feed([claudeUse('t1', 'Bash', { command: 'npm run build' })]));
  assert.deepEqual(cut.commands, [{ command: 'npm run build', exit: 'interrupted', output_tail: '' }]);
  assert.equal(claimEvidenceLine(cut), 'the last `npm run build` was interrupted');
});

test('Codex: command exit codes, MCP calls, file changes, failed patches and error items', () => {
  const snap = evidenceSnapshot(feed([
    { provider: 'codex', event: { type: 'item.started', item: { type: 'command_execution', command: 'pnpm test' } } },
    codexItem({ type: 'command_execution', command: 'pnpm test', aggregated_output: `${'x'.repeat(900)}\n# pass 12\n# fail 0`, exit_code: 0, status: 'completed' }),
    codexItem({ type: 'command_execution', command: 'git push', aggregated_output: 'rejected', exit_code: 1, status: 'failed' }),
    codexItem({ type: 'mcp_tool_call', server: 'SynaBun', tool: 'browser_click', status: 'failed', error: { message: 'no such element' } }),
    codexItem({ type: 'mcp_tool_call', server: 'SynaBun', tool: 'recall', status: 'completed', result: { content: [{ type: 'text', text: 'memories' }] } }),
    codexItem({ type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }], status: 'completed' }),
    codexItem({ type: 'file_change', changes: [{ path: 'src/b.ts', kind: 'add' }], status: 'failed' }),
    codexItem({ type: 'error', message: 'sandbox denied write to /etc' }),
  ]));
  assert.deepEqual(snap.commands.map((c) => [c.command, c.exit]), [['pnpm test', 'ok'], ['git push', 'error']]);
  assert.ok(snap.commands[0].output_tail.length <= 500);
  assert.match(snap.commands[0].output_tail, /# fail 0$/);
  assert.deepEqual(snap.files, ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(snap.results.map((r) => [r.tool, r.is_error]), [['SynaBun.browser_click', true], ['apply_patch', true], ['error', true]]);
  assert.equal(snap.results[0].tail, 'no such element');
  assert.equal(claimEvidenceLine(snap), 'the last command, `git push`, exited with an error');
});

test('OpenCode: tool parts by callID (last write wins, counted once completed or errored), metadata.exit read defensively', () => {
  const snap = evidenceSnapshot(feed([
    openPart('c1', 'bash', { status: 'running', input: { command: 'npm test' } }),
    openPart('c1', 'bash', { status: 'completed', input: { command: 'npm test' }, output: '1 failing', metadata: { exit: 1 } }),
    openPart('c2', 'bash', { status: 'completed', input: { command: 'echo hi' }, output: 'hi', metadata: { exit: 0 } }),
    openPart('c3', 'bash', { status: 'completed', input: { command: 'make' }, output: 'done' }),
    openPart('c4', 'bash', { status: 'error', input: { command: 'rm -rf /' }, error: 'denied' }),
    openPart('c5', 'edit', { status: 'completed', input: { filePath: '/repo/a.ts' }, output: '' }),
    openPart('c6', 'read', { status: 'completed', input: { filePath: '/repo/a.ts' }, output: 'x' }),
    openPart('c7', 'todowrite', { status: 'completed', input: {}, output: 'x' }),
    openPart('c8', 'webfetch', { status: 'completed', input: { url: 'x' }, output: 'page' }),
    openPart('c8', 'webfetch', { status: 'completed', input: { url: 'x' }, output: 'page, second write' }),
    openPart('c9', 'SynaBun_recall', { status: 'completed', input: {}, output: 'mem' }),
  ]));
  assert.deepEqual(snap.commands.map((c) => [c.command, c.exit]), [['npm test', 'error'], ['echo hi', 'ok'], ['make', 'unknown'], ['rm -rf /', 'error']]);
  assert.deepEqual(snap.files, ['/repo/a.ts']);
  assert.deepEqual(snap.results, [{ tool: 'webfetch', is_error: false, tail: 'page, second write' }]);
  assert.equal(snap.hasEvidence, true);
});

test('caps: 24 kept per turn, the snapshot shows the last 8 commands, 6 results (errors first) and 20 files', () => {
  const payloads = [];
  for (let i = 0; i < 30; i += 1) payloads.push(codexItem({ type: 'command_execution', command: `step ${i}`, aggregated_output: 'ok', exit_code: 0 }));
  for (let i = 0; i < 30; i += 1) payloads.push(codexItem({ type: 'mcp_tool_call', server: 's', tool: `t${i}`, status: i === 2 ? 'failed' : 'completed', result: { content: [] } }));
  payloads.push(codexItem({ type: 'file_change', changes: Array.from({ length: 30 }, (_, i) => ({ path: `f${i}.ts`, kind: 'update' })), status: 'completed' }));
  const acc = feed(payloads);
  assert.equal(acc.commands.length, 24);
  assert.equal(acc.results.length, 24);
  assert.ok(acc.results.some((r) => r.tool === 's.t2'), 'an early error survives the cap');
  const snap = evidenceSnapshot(acc);
  assert.deepEqual(snap.commands.map((c) => c.command), ['step 22', 'step 23', 'step 24', 'step 25', 'step 26', 'step 27', 'step 28', 'step 29']);
  assert.equal(snap.results.length, 6);
  assert.equal(snap.results[0].tool, 's.t2', 'errors first, reported in the order they happened');
  assert.deepEqual(snap.results.slice(1).map((r) => r.tool), ['s.t25', 's.t26', 's.t27', 's.t28', 's.t29']);
  assert.equal(snap.files.length, 20);
});

test('claimEvidenceLine mirrors the Stop hook wording', () => {
  assert.equal(claimEvidenceLine({ checks: [], commands: [] }), 'no test/build command ran this turn');
  assert.equal(claimEvidenceLine({ checks: [{ command: 'npm run dev', exit: 'background' }], commands: [] }), '`npm run dev` was still running in the background');
  assert.equal(claimEvidenceLine({ checks: [{ command: 'npm test', exit: 'ok' }], commands: [{ command: 'npm test', exit: 'ok' }] }), 'the last check, `npm test`, exited ok, but the message reports more than this turn\'s output shows');
  assert.equal(evidenceSnapshot(null).hasEvidence, false);
});
