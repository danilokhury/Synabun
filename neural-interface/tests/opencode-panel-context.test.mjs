// OpenCode panel: the Context settings popover (header cog). What it shows is
// decided in ocp-v2-context-model.js (no DOM); ocp-v2-context-menu.js renders it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  NOT_REPORTED, isUnset, fmtTokens, contextReading, contextMenuModel,
} from '../public/shared/ocp-v2/ocp-v2-context-model.js';

const dir = new URL('../public/shared/ocp-v2/', import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), 'utf8');

test('the cog dot starts at 80% of the window, is stronger from 90%, and needs a window', () => {
  assert.equal(contextReading({ usedTokens: 316_000, contextWindow: 400_000 }).pressure, '');
  assert.equal(contextReading({ usedTokens: 320_000, contextWindow: 400_000 }).pressure, 'high');
  assert.equal(contextReading({ usedTokens: 360_000, contextWindow: 400_000 }).pressure, 'critical');
  // No window from the provider's model list: no share, no dot, whatever was used.
  assert.deepEqual(contextReading({ usedTokens: 900_000, contextWindow: null }), { used: 900_000, size: 0, pct: null, pressure: '' });
  assert.deepEqual(contextReading(null), { used: 0, size: 0, pct: null, pressure: '' });
});

test('an empty panel says what is missing instead of guessing', () => {
  const m = contextMenuModel({});
  assert.equal(m.pressure, '');
  assert.deepEqual(m.context, { pct: null, headline: NOT_REPORTED, usage: NOT_REPORTED, share: '', tip: '', rows: [['Model', '—'], ['Window', NOT_REPORTED, '']] });
  assert.equal(m.compact, null, 'no Compact without a compaction path');
  assert.deepEqual(m.tools, { servers: [], note: [NOT_REPORTED, 'Restart SynaBun to see MCP servers here.'], manage: false });
  assert.deepEqual(m.versions, [['OpenCode', NOT_REPORTED], ['OpenCode SDK', NOT_REPORTED, '']]);
  assert.deepEqual(m.session, { id: '', rows: [['Folder', '—'], ['Agent', '—']], autoAccept: null });
  assert.equal(isUnset(NOT_REPORTED) && isUnset('—') && !isUnset('1.18.34'), true);
});

test('a session in use: the reading, the breakdown, the servers, the versions and the session rows', () => {
  const m = contextMenuModel({
    gauge: {
      status: 'ready', usedTokens: 108_000, contextWindow: 400_000, model: 'gpt-5', providerID: 'openai',
      breakdown: { inputTokens: 8_000, cacheReadTokens: 90_000, cacheWriteTokens: 10_000, outputTokens: 2_100, reasoningTokens: 600 },
    },
    compact: { hasSession: true, running: false, compacting: false },
    mcp: {
      supported: true, loaded: true, error: '',
      rows: [
        { name: 'SynaBun', status: 'connected', managed: true },
        { name: 'linear', status: 'needs_auth' },
        { name: 'broken', status: 'failed', error: 'spawn ENOENT' },
        { name: 'later', status: 'starting' },
      ],
    },
    canManage: true,
    serverVersion: '1.18.34', sdkVersion: '1.18.34', updateAvailable: '1.18.35',
    sessionId: 'ses_1', folder: '/work/app/', agent: 'plan', turns: 4, cost: 0.1234,
    autoAccept: { on: true },
  });
  assert.equal(m.context.usage, '108k / 400k tokens');
  assert.equal(m.context.share, '27%');
  assert.equal(m.context.headline, '108k / 400k tokens (27%)');
  assert.deepEqual(m.context.rows.map(([label, value]) => [label, value]), [
    ['Model', 'openai/gpt-5'], ['Input', '8k tokens'], ['Cache', '90k read · 10k written'], ['Output', '2k tokens'], ['Reasoning', '600 tokens'],
  ]);
  assert.deepEqual(m.compact, { label: 'Compact', disabled: false, hint: 'Summarises the conversation to free up context.' });
  assert.deepEqual(m.tools.servers, [
    { name: 'SynaBun', word: 'Connected', tone: 'ok', tip: 'Managed by SynaBun' },
    { name: 'linear', word: 'Needs sign-in', tone: 'warn', tip: '' },
    { name: 'broken', word: 'Failed', tone: 'err', tip: 'spawn ENOENT' },
    // A status this list does not know is shown as OpenCode sent it.
    { name: 'later', word: 'starting', tone: '', tip: '' },
  ]);
  assert.equal(m.tools.note, null);
  assert.equal(m.tools.manage, true);
  assert.deepEqual(m.versions.map(([label, value]) => [label, value]), [['OpenCode', '1.18.34'], ['Update', '1.18.35 available'], ['OpenCode SDK', '1.18.34']]);
  assert.equal(m.session.id, 'ses_1');
  assert.deepEqual(m.session.rows.map(([label, value]) => [label, value]), [['Folder', 'app'], ['Agent', 'plan'], ['Turns', '4'], ['Cost', '$0.123']]);
  assert.equal(m.session.rows[0][2], '/work/app/', 'the whole path is the hover text');
  assert.deepEqual([m.session.autoAccept.on, m.session.autoAccept.word, m.session.autoAccept.disabled], [true, 'On', false]);
});

test('Compact says why it cannot run; the servers say when they were not read', () => {
  const compact = (c) => contextMenuModel({ compact: c }).compact;
  assert.deepEqual([compact({ hasSession: false }).disabled, compact({ hasSession: false }).hint], [true, 'No active session.']);
  assert.equal(compact({ hasSession: true, running: true }).hint, 'Available when the current turn finishes.');
  assert.deepEqual(compact({ hasSession: true, compacting: true }), { label: 'Compacting…', disabled: true, hint: 'Summarising the conversation.' });
  const note = (mcp) => contextMenuModel({ mcp }).tools.note;
  assert.deepEqual(note({ supported: true, loaded: false, rows: [] }), [NOT_REPORTED, '']);
  assert.deepEqual(note({ supported: true, loaded: true, rows: [], error: 'offline' }), [NOT_REPORTED, 'offline']);
  assert.deepEqual(note({ supported: true, loaded: true, rows: [] }), ['None configured', '']);
  // A window without usage has a row of its own; usage without a window has no share.
  assert.deepEqual(contextMenuModel({ gauge: { contextWindow: 200_000 } }).context.rows[1].slice(0, 2), ['Window', '200k tokens']);
  const noWindow = contextMenuModel({ gauge: { usedTokens: 50_000 } }).context;
  assert.deepEqual([noWindow.usage, noWindow.share, noWindow.pct], ['50k tokens used', '', null]);
  assert.deepEqual([fmtTokens(999), fmtTokens(216_431), fmtTokens(1_000_000), fmtTokens(1_250_000)], ['999', '216k', '1M', '1.3M']);
});

test('the popover is built from elements and text, inside the OpenCode panel only, and the context row is gone', () => {
  const menu = read('ocp-v2-context-menu.js');
  const model = read('ocp-v2-context-model.js');
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML/.test(menu), false, 'the popover takes no markup');
  assert.equal(/\b(document|window)\./.test(model), false, 'the model has no DOM');
  for (const source of [menu, model]) {
    for (const m of source.matchAll(/^import [^;]+ from '([^']+)';/gm)) assert.match(m[1], /^\.\/ocp-v2-[\w-]+\.js$/, `import ${m[1]}`);
  }
  // The popover is a child of <body>, and the cog says what it opens.
  assert.match(menu, /document\.body\.appendChild\(pop\);/);
  for (const attr of ['aria-haspopup', 'aria-expanded', 'aria-controls', 'aria-label', 'data-tooltip']) assert.ok(menu.includes(`cog.setAttribute('${attr}'`), attr);
  assert.equal(menu.includes('cog.title'), false);
  // The session is read before the request (boundReader takes the binding).
  assert.match(menu, /readMcp\(\s*\(at\) => api\.mcpStatus\(\{ sessionId: at\.sessionId/);
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.js'))) {
    assert.equal(/ocpv2-contextbar|ocpv2-context-gauge|ocpv2-compact-btn|ocpv2-cost-label|ocpv2-env-btn/.test(read(name)), false, `${name} still names the context row`);
  }
  for (const name of ['ocp-v2-panel.js', 'ocp-v2-childpanel.js']) assert.match(read(name), /mountContextMenu\(actions, panel, /, name);
});
