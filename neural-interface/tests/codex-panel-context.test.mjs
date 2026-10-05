// Codex panel: the Context settings popover (header cog). What it shows is
// decided in cdx-context-model.js (no DOM); cdx-context-menu.js renders it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  NOT_REPORTED, isUnset, formatCount, contextReading, contextMenuModel,
} from '../public/shared/cdx/cdx-context-model.js';

const dir = new URL('../public/shared/cdx/', import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), 'utf8');
const model = (d = {}) => contextMenuModel({ locale: 'en-US', ...d });
const pair = ([label, value]) => [label, value];

test('the cog dot starts at 80% of the window, is stronger from 90%, and needs a reported window', () => {
  assert.equal(contextReading({ usedTokens: 316_000, contextWindow: 400_000 }).pressure, '');
  assert.equal(contextReading({ usedTokens: 320_000, contextWindow: 400_000 }).pressure, 'high');
  assert.equal(contextReading({ usedTokens: 360_000, contextWindow: 400_000 }).pressure, 'critical');
  // No modelContextWindow from Codex: no share, no dot, whatever was used.
  assert.deepEqual(contextReading({ usedTokens: 900_000, contextWindow: null }), { used: 900_000, size: 0, pct: null, pressure: '' });
  assert.deepEqual(contextReading({ usedTokens: 0, contextWindow: 400_000 }), { used: 0, size: 400_000, pct: null, pressure: '' });
  assert.deepEqual(contextReading(null), { used: 0, size: 0, pct: null, pressure: '' });
});

test('an empty tab says what is missing instead of guessing', () => {
  const m = model();
  assert.equal(m.pressure, '');
  assert.deepEqual(m.context, { pct: null, headline: NOT_REPORTED, usage: NOT_REPORTED, share: '', tip: '', rows: [['Model', '—'], ['Window', NOT_REPORTED, '']] });
  assert.equal(m.compact, null, 'no Compact without a compaction path');
  assert.deepEqual(m.tools, { servers: [], note: [NOT_REPORTED, ''], manage: false });
  assert.deepEqual(m.versions, [['Codex CLI', NOT_REPORTED], ['Codex SDK', NOT_REPORTED, '']]);
  assert.equal(m.session.id, '');
  assert.deepEqual(m.session.rows.map(pair), [['Folder', '—'], ['Effort', 'Default'], ['Approval', NOT_REPORTED], ['Sandbox', NOT_REPORTED]]);
  assert.deepEqual([m.session.account, m.session.settings], [null, false]);
  assert.equal(isUnset(NOT_REPORTED) && isUnset('—') && !isUnset('0.160.0'), true);
});

test('a thread in use: the reading, the breakdown, the servers, the versions and the session rows', () => {
  const last = { inputTokens: 120_000, cachedInputTokens: 96_000, outputTokens: 2_100, reasoningOutputTokens: 600, totalTokens: 122_100 };
  const m = model({
    gauge: { usedTokens: 120_000, contextWindow: 258_400, basis: 'last', state: 'live', model: 'gpt-5.2-codex', breakdown: last, last },
    compact: { compacting: false, hasThread: true, connected: true, busy: false },
    mcp: {
      loaded: true, error: '',
      rows: [
        { name: 'synabun', status: 'ready', toolCount: 12 },
        { name: 'linear', status: 'running', authRequired: true },
        { name: 'broken', status: 'failed', error: 'spawn ENOENT' },
        { name: 'later', status: 'starting', toolCount: null },
        { name: 'odd', status: 'warming' },
      ],
    },
    canManage: true, canSettings: true,
    runtime: { cliVersion: '0.160.0', sdkVersion: '0.161.0', protocolBaseline: '0.160.0' },
    threadId: 'thr_1', folder: '/work/app/', effort: 'high', turns: 4, cost: 0.1234,
    account: { label: 'me@example.com', tip: 'Account: me@example.com (pro) — click to switch' },
    config: { loaded: true, approvalPolicy: 'on-request', sandboxMode: '' },
  });
  // The cached input is part of the input: 120,000 in use, never 216,000.
  assert.equal(m.context.usage, '120,000 / 258,400 tokens');
  assert.equal(m.context.share, '46.4%');
  assert.equal(m.context.pct, 46.4);
  assert.equal(m.context.headline, '120,000 / 258,400 tokens (46.4%)');
  assert.equal(m.context.tip, 'Live reading\nContext in use: the input of the last request\nWindow: 258,400 tokens, as Codex reported it');
  assert.deepEqual(m.context.rows.map(pair), [
    ['Model', 'gpt-5.2-codex'], ['Input', '120,000 tokens'], ['Cached input', '96,000 tokens'],
    ['Output', '2,100 tokens'], ['Reasoning', '600 tokens'], ['Last turn', '122,100 tokens'],
  ]);
  assert.equal(m.context.rows[2][2], '80% of the input was read from cache');
  assert.equal(m.context.rows[5][2], 'Input 120,000 · cached 96,000 · output 2,100 · reasoning 600');
  assert.deepEqual(m.compact, { label: 'Compact', disabled: false, hint: 'Compact current thread context' });
  assert.deepEqual(m.tools.servers, [
    { name: 'broken', word: 'Failed', tone: 'err', tip: 'spawn ENOENT' },
    { name: 'later', word: 'Starting', tone: 'run', tip: '' },
    { name: 'linear', word: 'Needs sign-in', tone: 'warn', tip: '' },
    // A status this list does not know is shown as Codex sent it.
    { name: 'odd', word: 'warming', tone: '', tip: '' },
    { name: 'synabun', word: 'Connected · 12 tools', tone: 'ok', tip: '' },
  ]);
  assert.deepEqual([m.tools.note, m.tools.manage], [null, true]);
  assert.deepEqual(m.versions.map(pair), [['Codex CLI', '0.160.0'], ['Codex SDK', '0.161.0'], ['Protocol', '0.160.0']]);
  assert.equal(m.session.id, 'thr_1');
  assert.deepEqual(m.session.rows.map(pair), [
    ['Folder', 'app'], ['Effort', 'high'], ['Approval', 'on-request'], ['Sandbox', 'Codex default'], ['Turns', '4'], ['Cost', '~$0.12'],
  ]);
  assert.equal(m.session.rows[0][2], '/work/app/', 'the whole path is the hover text');
  assert.deepEqual(m.session.account, { label: 'me@example.com', tip: 'Account: me@example.com (pro) — click to switch' });
  assert.equal(m.session.settings, true);
});

test('Compact says why it cannot run; what was not read says so; the share is never invented', () => {
  const compact = (c) => model({ compact: c }).compact;
  assert.deepEqual(compact({ compacting: true, hasThread: true, connected: true }), { label: 'Compacting…', disabled: true, hint: 'Compacting current thread context' });
  assert.deepEqual(pair(Object.values(compact({ hasThread: false, connected: true })).slice(1)), [true, 'Compaction becomes available after the first Codex turn']);
  assert.equal(compact({ hasThread: true, connected: false }).hint, 'Connect Codex to compact this thread');
  assert.deepEqual(pair(Object.values(compact({ hasThread: true, connected: true, busy: true })).slice(1)), [true, 'Cannot compact while Codex is processing']);

  const note = (mcp) => model({ mcp }).tools.note;
  assert.deepEqual(note({ loaded: false, rows: [] }), [NOT_REPORTED, '']);
  assert.deepEqual(note({ loaded: false, rows: [], error: 'offline' }), [NOT_REPORTED, 'offline']);
  assert.deepEqual(note({ loaded: true, rows: [] }), ['None configured', 'Configure servers in ~/.codex/config.toml under [mcp_servers]']);

  // A window without usage has a row of its own; usage without a window has no share and no dot.
  const windowOnly = model({ gauge: { contextWindow: 258_400 } });
  assert.deepEqual([windowOnly.context.usage, windowOnly.context.rows[1].slice(0, 2)], [NOT_REPORTED, ['Window', '258,400 tokens']]);
  const noWindow = model({ gauge: { usedTokens: 50_000, breakdown: { inputTokens: 50_000 } } });
  assert.deepEqual([noWindow.context.usage, noWindow.context.share, noWindow.context.pct, noWindow.pressure], ['50,000 tokens used', '', null, '']);
  assert.deepEqual(noWindow.context.rows[1].slice(0, 2), ['Window', NOT_REPORTED]);
  // Over the window: the share says so, the bar stops at its end.
  const over = model({ gauge: { usedTokens: 270_000, contextWindow: 258_400 } });
  assert.deepEqual([over.context.share, over.context.pct, over.pressure], ['104.5%', 100, 'critical']);

  // The runtime answered without an SDK version; the configuration could not be read.
  assert.deepEqual(model({ runtime: { cliVersion: '0.160.0' } }).versions.map(pair), [['Codex CLI', '0.160.0'], ['Codex SDK', 'Not installed']]);
  assert.deepEqual(model({ config: { loaded: false, error: 'This conversation changed.' } }).session.rows[2], ['Approval', NOT_REPORTED, 'This conversation changed.']);
  assert.deepEqual([formatCount(999, 'en-US'), formatCount(216_431, 'en-US'), formatCount(-5, 'en-US'), formatCount('x', 'en-US')], ['999', '216,431', '0', '0']);
});

test('the popover is built from elements and text, inside the Codex panel only, and the context bar is gone', () => {
  const menu = read('cdx-context-menu.js');
  const modelSource = read('cdx-context-model.js');
  const panel = read('cdx-panel.js');
  const tabs = read('cdx-tabs.js');
  const styles = read('cdx-styles.js');
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML/.test(menu), false, 'the popover takes no markup');
  assert.equal(/\b(document|window)\./.test(modelSource), false, 'the model has no DOM');
  for (const source of [menu, modelSource]) {
    for (const m of source.matchAll(/^import [^;]+ from '([^']+)';/gm)) assert.match(m[1], /^\.\/cdx-[\w-]+\.js$/, `import ${m[1]}`);
  }
  // The popover is a child of <body>, and the cog says what it opens.
  assert.match(menu, /document\.body\.appendChild\(pop\);/);
  for (const attr of ['aria-haspopup', 'aria-expanded', 'aria-controls', 'aria-label', 'data-tooltip']) assert.ok(menu.includes(`cog.setAttribute('${attr}'`), attr);
  assert.equal(menu.includes('cog.title'), false);
  // It re-renders only when its model changed, and takes Escape ahead of the panel.
  assert.match(menu, /const next = `\$\{JSON\.stringify\(model\)\}\|\$\{copied\}`;\n\s+if \(next === sig\) return;/);
  assert.match(menu, /window\.addEventListener\('keydown', onKey, true\);/);
  assert.match(panel, /if \(_contextMenu\?\.isOpen\(\)\) return;/);
  assert.match(panel, /if \(!nextVisible\) \{\n\s+_contextMenu\?\.close\(\);/, 'a hidden, minimized or slid panel closes it');

  // The panel mounts it on the header's buttons and hands it the active tab's values.
  assert.match(panel, /mountContextMenu\(panelEl\('\.cxp-actions'\), _panel, \{/);
  assert.match(panel, /contextMenuSync: \(\) => _contextMenu\?\.sync\(\),/);
  assert.match(panel, /onCompact: \(\) => startCompaction\(\),/);
  assert.match(tabs, /export function contextMenuData\(\) \{\n\s+const tab = activeTab\(\);\n\s+if \(!tab \|\| !isActiveTab\(_boundTab\)\) return null;/);
  // The used figure is the existing computation: the input, the cached part never on top.
  const reading = tabs.slice(tabs.indexOf('function contextGaugeReading() {'), tabs.indexOf('/** The reading for the cog\'s dot'));
  assert.match(reading, /usedTokens: resolveContextInputTokens\(gaugeUsage\.breakdown\),/);
  assert.match(reading, /const contextWindow = usage\?\.modelContextWindow \|\| null;/);
  assert.equal(/cachedInputTokens|258/.test(reading), false, 'no cached tokens added, no default window');
  // The tab and its conversation are taken before the first request.
  assert.match(tabs, /export function refreshContextMenuDetails\(\) \{\n\s+const tab = activeTab\(\);[\s\S]*?const owner = \{ accountId: tab\.accountId, threadId: tab\.threadId, connectionEpoch: tab\.connectionEpoch \};[\s\S]*?requestForCodexOwner\(tab, owner, 'mcp_status'/);

  for (const name of readdirSync(dir).filter((file) => file.endsWith('.js'))) {
    assert.equal(/cxp-contextbar|cxp-gauge|cxp-ctx-fill|cxp-compact-btn|cxp-account-chip|cxp-account-btn|cxp-settings-btn|cxp-cost\b|cxp-statusbar|cxp-status-badge/.test(read(name)), false, `${name} still names the context bar`);
  }
  // The dot's two values, and the popover outside the panel carrying the tokens.
  assert.match(styles, /--cxp-pressure-high: #d4a848;\n\s+--cxp-pressure-critical: #ef7070;/);
  assert.match(styles, /\.cxp-session-pill,\n\s+\.cxp-ctxpop \{/);
  assert.match(styles, /\.cxp-cog-dot \{[^}]*width: 6px;[^}]*background: var\(--cxp-pressure-high\);/);
  assert.match(styles, /\.cxp-cog-dot-critical \{ background: var\(--cxp-pressure-critical\); \}/);
});
