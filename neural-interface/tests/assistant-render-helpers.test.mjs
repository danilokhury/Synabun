// Pure helpers behind the assistant transcript: the per-SDK-message dedupe key,
// the result error line, SynaBun tool names, the rack stylesheet the renderer
// injects and the idle page's character. What a call says lives in
// asst-tool-kinds.js (tests/assistant-tool-kinds.test.mjs); the DOM side runs
// in tests/assistant-render-events.browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';

const { assistantEventKey } = await import('../public/shared/assistant/asst-state.js');
const render = await import('../public/shared/assistant/asst-render.js');
const { resultErrorText, synabunToolName } = render;
const { formatRunTokens } = await import('../public/shared/assistant/asst-usage.js');

test('run-card token labels expose compact text and exact accessible count', () => {
  assert.deepEqual(formatRunTokens({ total: 1500000 }, 'live'), { text: '≈1.5M tok', label: '1,500,000 tokens, Live' });
  assert.deepEqual(formatRunTokens({ total: 0 }, 'exact'), { text: '0 tok', label: '0 tokens, Exact' });
  assert.equal(formatRunTokens(null, 'partial'), null);
});
const { RACK_CSS, RACK_STYLE_ID, injectRackStyles } = await import('../public/shared/assistant/asst-rack-styles.js');
const { blinkAmount, mascotSvg, poseMascot } = await import('../public/shared/synabun-mascot.js');

test('assistantEventKey: one key per SDK message, not per API message id', () => {
  const block = (uuid, content) => ({ type: 'assistant', uuid, message: { id: 'msg_1', content } });
  const thinking = block('u1', [{ type: 'thinking', thinking: 'plan' }]);
  const text = block('u2', [{ type: 'text', text: 'Checking memory.' }]);
  const tool = block('u3', [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__SynaBun__recall', input: {} }]);
  const keys = [thinking, text, tool].map(assistantEventKey);
  assert.equal(new Set(keys).size, 3, 'the blocks of one API message are three messages');
  assert.equal(assistantEventKey({ ...text }), keys[1], 'a replayed message keeps its key');
  // Codex/OpenCode carry no uuid: id + block signature.
  const codexTool = { type: 'assistant', message: { id: 'codex-item-c1', content: [{ type: 'tool_use', id: 'c1', name: 'Bash' }] } };
  const codexFinal = { type: 'assistant', message: { id: 'codex-final-t1', content: [{ type: 'text', text: 'All tests pass.' }] } };
  assert.equal(assistantEventKey(codexTool), 'codex-item-c1|tool_use:c1');
  assert.equal(assistantEventKey(codexFinal), 'codex-final-t1|text:15');
  assert.notEqual(assistantEventKey(codexTool), assistantEventKey(codexFinal));
});

test('resultErrorText: failures get a line, successes and stopped turns none', () => {
  assert.equal(resultErrorText({ type: 'result', subtype: 'success', is_error: false, result: 'Done.' }), '');
  assert.equal(resultErrorText({ type: 'result', subtype: 'success', is_error: true, result: ' API Error: 529 Overloaded ' }), 'API Error: 529 Overloaded');
  assert.equal(resultErrorText({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: [] }), 'Stopped: the turn limit was reached.');
  assert.equal(resultErrorText({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, errors: [] }), 'Stopped: the budget cap was reached.');
  assert.equal(resultErrorText({ type: 'result', subtype: 'error_something_new', is_error: true }), 'The turn failed.', 'an unknown subtype reads as a failed turn');
  assert.equal(resultErrorText({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['a', 'b', 'c', 'd'] }), 'a\nb\nc');
  // The user's stop is not a failure.
  assert.equal(resultErrorText({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'], terminal_reason: 'aborted_tools' }), '');
  assert.equal(resultErrorText({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['[Request interrupted by user]', 'Request was aborted.'] }), '');
  assert.equal(resultErrorText({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Request was aborted.', 'Hook failed'] }), 'Request was aborted.\nHook failed', 'a real error among them still shows');
  // Localized through the caller's t(key, fallback).
  const seen = [];
  const t = (key, fallback) => { seen.push(key); return `«${fallback}»`; };
  assert.equal(resultErrorText({ type: 'result', subtype: 'error_max_turns', is_error: true }, t), '«Stopped: the turn limit was reached.»');
  assert.deepEqual(seen, ['assistant.result.error_max_turns']);
});

test('SynaBun tool names: both prefixes, nothing else', () => {
  assert.equal(synabunToolName('mcp__SynaBun__recall'), 'recall');
  assert.equal(synabunToolName('SynaBun_browser_navigate'), 'browser_navigate', 'OpenCode prefix');
  assert.equal(synabunToolName('mcp__synabun__remember'), 'remember');
  assert.equal(synabunToolName('mcp__github__search'), null);
  assert.equal(synabunToolName('Bash'), null);
  // The pill helpers went with the pills: every call is a step of a rack now.
  assert.equal(render.toolDetail, undefined);
  assert.equal(render.synabunToolTitle, undefined);
});

test('the rack stylesheet goes in once, right after the main assistant styles', () => {
  const nodes = [];
  const head = { appendChild: (n) => { nodes.push(n); n.parentNode = head; } };
  const main = { id: 'assistant-panel-styles', parentNode: head, after: (n) => { nodes.splice(nodes.indexOf(main) + 1, 0, n); n.parentNode = head; } };
  nodes.push(main);
  const doc = {
    head,
    getElementById: (id) => nodes.find(n => n.id === id) || null,
    createElement: (tag) => ({ tag, id: '', textContent: '' }),
  };
  injectRackStyles(doc);
  injectRackStyles(doc);
  assert.deepEqual(nodes.map(n => n.id), ['assistant-panel-styles', RACK_STYLE_ID], 'one <style>, after the main one');
  assert.equal(nodes[1].tag, 'style');
  assert.equal(nodes[1].textContent, RACK_CSS);
  // Without the main styles in the page it still lands in <head>.
  const alone = [];
  injectRackStyles({ head: { appendChild: (n) => alone.push(n) }, getElementById: () => null, createElement: (tag) => ({ tag, id: '' }) });
  assert.equal(alone.length, 1);
});

test('mascot: onboarding geometry, blink curve and pose', () => {
  const svg = mascotSvg({ width: 120, height: 60 });
  assert.match(svg, /viewBox="0 0 280 140"/);
  assert.match(svg, /width="120" height="60"/);
  assert.equal((svg.match(/class="syna-lid"/g) || []).length, 2);
  assert.match(svg, /aria-hidden="true"/);
  assert.deepEqual([blinkAmount(-1), blinkAmount(45), blinkAmount(100), blinkAmount(215), blinkAmount(400)], [0, 0.5, 1, 0.5, 0]);
  const set = [];
  const node = { setAttribute: (_, v) => set.push(v) };
  poseMascot({ lids: [node, node], mouth: node }, 1, -1, 1, 0, { rangeX: 8, rangeY: 6 });
  const [, x, y, scale] = /^translate\(([-\d.]+),([-\d.]+)\) translate\(0,60\) scale\(1,([\d.e-]+)\) translate\(0,-60\)$/.exec(set[0]) || [];
  assert.deepEqual([Number(x), Number(y)], [8, -6], 'the eyes travel toward the look direction');
  assert.ok(Math.abs(Number(scale) - 0.06) < 1e-9, `shut lids squash to 6 % (${set[0]})`);
  assert.equal(set[2], 'translate(4,-2.2)', 'the mouth follows at half the travel, plus its wobble');
});
