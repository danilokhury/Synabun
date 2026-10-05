import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { slimContextUsage, slimUsage, slimMcpStatus, slimRewind, runSessionRequest, SESSION_REQUESTS } from '../lib/claude-panel-requests.js';
import { contextCard, usageCard, mcpRows, rewindPreviewText, rewindResultText } from '../public/shared/cp/cp-usage-model.js';

// What a sidepanel tab asks its live session: context usage, plan usage, MCP
// servers (status, reconnect, enable / disable) and what a rewind would change.

const CONTEXT = {
  categories: [
    { name: 'System prompt', tokens: 4000, color: 'x', kind: 'used' },
    { name: 'MCP tools', tokens: 12_000, color: 'x', kind: 'used', isDeferred: true },
    { name: 'Messages', tokens: 60_000, color: 'x', kind: 'used' },
    { name: 'Autocompact buffer', tokens: 33_000, color: 'x', kind: 'buffer' },
    { name: 'Free space', tokens: 91_000, color: 'x', kind: 'free' },
  ],
  totalTokens: 76_000, maxTokens: 200_000, rawMaxTokens: 200_000, percentage: 38, gridRows: [[{ color: 'x' }]], model: 'claude-opus-5-5',
  memoryFiles: [{ path: '/repo/CLAUDE.md', type: 'Project', tokens: 2100 }],
  mcpTools: Array.from({ length: 40 }, (_, i) => ({ name: `tool${i}`, serverName: 'SynaBun', tokens: i * 10, isLoaded: i % 2 === 0 })),
  agents: [{ agentType: 'Explore', source: 'built-in', tokens: 300 }],
  skills: { totalSkills: 12, includedSkills: 10, tokens: 900, skillFrontmatter: [] },
  autoCompactThreshold: 167_000, isAutoCompactEnabled: true,
};

test('context usage is trimmed on the server and read into a card', () => {
  const slim = slimContextUsage(CONTEXT);
  assert.equal('gridRows' in slim, false, 'the terminal grid does not travel');
  assert.equal(slim.mcpTools.length, 15);
  assert.equal(slim.mcpTools[0].name, 'tool39', 'the largest first');
  assert.equal(slim.mcpToolCount, 40);
  assert.deepEqual(slim.autoCompact, { enabled: true, threshold: 167_000 });

  const view = contextCard(slim);
  assert.equal(view.headline, '76k of 200k tokens (38%) · claude-opus-5-5');
  assert.deepEqual(view.rows[0], ['System prompt', '4k (2%)', '']);
  assert.deepEqual(view.rows[1], ['MCP tools (deferred)', '12k (6%)', '']);
  assert.deepEqual(view.rows.at(-1), ['Free', '91k', 'ok']);
  assert.deepEqual(view.notes, ['Auto-compact at 167k tokens.']);
  assert.deepEqual(view.sections.map(s => s.label), ['Memory files', 'MCP tools (largest 15 of 40)', 'Agents', 'Skills']);
  assert.match(view.sections[1].rows[0][0], /^SynaBun: tool39 \(deferred\)$/);
  assert.equal(contextCard(slimContextUsage({ isAutoCompactEnabled: false })).notes[0], 'Auto-compact is off.');
  assert.equal(contextCard(null).headline, '0 of 0 tokens (0%)');
});

// The live CLI names its deferred categories "MCP tools (deferred)" and "System
// tools (deferred)" itself, and flags them as deferred too: said once.
test('a deferred category is labelled once, whoever said it', () => {
  const view = contextCard({
    maxTokens: 200_000, totalTokens: 50_000,
    categories: [
      { name: 'MCP tools (deferred)', tokens: 12_000, kind: '', deferred: true },
      { name: 'System tools (deferred)', tokens: 8_000, kind: '', deferred: true },
      { name: 'Custom agents', tokens: 500, kind: '', deferred: true },
      { name: 'Messages', tokens: 20_000, kind: '', deferred: false },
    ],
  });
  assert.deepEqual(view.rows.map(r => r[0]), ['MCP tools (deferred)', 'System tools (deferred)', 'Custom agents (deferred)', 'Messages']);
  for (const [label] of view.rows) assert.equal((label.match(/\(deferred\)/g) || []).length <= 1, true, label);
});

test('plan usage: session totals and the limit windows', () => {
  const now = new Date(2026, 9, 3, 10, 0).getTime();
  const slim = slimUsage({
    session: { total_cost_usd: 1.2345, total_api_duration_ms: 60_000, total_duration_ms: 600_000, total_lines_added: 120, total_lines_removed: 30,
      model_usage: { 'claude-opus-5-5': { inputTokens: 100, cacheReadInputTokens: 9000, cacheCreationInputTokens: 900, outputTokens: 2000, costUSD: 1.2 } } },
    subscription_type: 'max', rate_limits_available: true,
    rate_limits: {
      // SDKControlGetUsageResponse: utilization is a percentage, 0-100 (sdk.d.ts), or null.
      five_hour: { utilization: 92, resets_at: new Date(2026, 9, 3, 14, 30).toISOString() },
      seven_day: { utilization: 1, resets_at: null }, seven_day_opus: { utilization: null, resets_at: new Date(2026, 9, 5, 9, 0).toISOString() },
      seven_day_sonnet: { utilization: null, resets_at: null },
      model_scoped: [{ display_name: 'Fable', utilization: 0.92, resets_at: null }, { display_name: 'Haiku', utilization: 0, resets_at: null }],
      extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 12, utilization: 12, currency: 'USD' },
    },
  });
  const view = usageCard(slim, now);
  assert.deepEqual(view.session[0], ['Cost', '$1.2345', '']);
  assert.deepEqual(view.session[1], ['Duration', '10m 00s (1m 00s in API calls)', '']);
  assert.deepEqual(view.session[3], ['claude-opus-5-5', '10k in · 2k out · $1.2000', '']);
  assert.deepEqual(view.limits[0], ['5-hour limit', '92% used · resets 14:30', 'warn']);
  assert.deepEqual(view.limits[1], ['Weekly limit', '1% used', ''], '1 is one percent, not one hundred (review R11)');
  assert.equal(view.limits[2][0], 'Weekly Opus limit');
  assert.match(view.limits[2][1], /^no data · resets /, 'null utilisation is unavailable, not 0% used');
  assert.deepEqual(view.limits[3], ['Fable', '0.9% used', ''], 'a fraction of a percent stays one');
  assert.deepEqual(view.limits[4], ['Haiku', '0% used', '']);
  assert.deepEqual(view.limits[5], ['Extra usage', 'on · 12 used of 100 USD', '']);
  assert.equal(view.limits.length, 6, 'a window with neither a value nor a reset time has no row');
  assert.equal(view.plan, 'max');

  const api = usageCard(slimUsage({ session: {}, subscription_type: null, rate_limits_available: false, rate_limits: null }), now);
  assert.deepEqual([api.limits, api.limitsNote], [[], 'Plan limits do not apply to this session (API key or cloud provider).']);
});

test('MCP servers: state, detail, and what each one offers', () => {
  const rows = mcpRows(slimMcpStatus([
    { name: 'SynaBun', status: 'connected', scope: 'dynamic', serverInfo: { name: 'synabun', version: '2.0.0' }, tools: [{ name: 'recall' }, { name: 'remember' }] },
    { name: 'stripe', status: 'needs-auth', scope: 'user' },
    { name: 'broken', status: 'failed', error: 'spawn ENOENT', source: 'project' },
    { name: 'old', status: 'disabled' },
  ]));
  assert.deepEqual([rows[0].tone, rows[0].detail, rows[0].canReconnect, rows[0].canDisable, rows[0].canEnable], ['ok', 'dynamic · synabun 2.0.0 · 2 tools', false, true, false]);
  assert.equal(rows[1].canReconnect, true);
  assert.match(rows[1].error, /Needs sign-in/);
  assert.deepEqual([rows[2].tone, rows[2].error, rows[2].detail], ['err', 'spawn ENOENT', 'project · 0 tools']);
  assert.deepEqual([rows[3].canEnable, rows[3].canDisable, rows[3].canReconnect], [true, false, false]);
});

test('a rewind preview says what would change before anything does', () => {
  const r = slimRewind({ canRewind: true, filesChanged: ['/repo/src/a.ts', '/repo/src/b.ts', '/repo/c.md', '/repo/d.md', '/repo/e.md'], insertions: 12, deletions: 40, skippedLinks: 1 });
  assert.equal(rewindPreviewText(r), '5 files would be restored (+12 −40 lines): a.ts, b.ts, c.md, d.md, +1 more. 1 link would be skipped.');
  assert.equal(rewindPreviewText(slimRewind({ canRewind: true, filesChanged: [] })), 'No file would change: nothing was edited after this message.');
  assert.equal(rewindPreviewText(slimRewind({ canRewind: false, error: 'No checkpoint found' })), 'No checkpoint found');
  assert.equal(rewindResultText({ ok: true, fileCount: 2, insertions: 3, deletions: 1 }), 'Files rewound: 2 files restored (+3 −1 lines).');
  assert.equal(rewindResultText({ ok: true }), 'Files rewound to checkpoint', 'a server that sends no stats');
});

test('a request runs against the live query, and says so when it cannot', async () => {
  // The last two are answered by the bridge itself (the session's record of granted rules: gap C39).
  assert.deepEqual(SESSION_REQUESTS, ['context_usage', 'usage', 'mcp_status', 'mcp_reconnect', 'mcp_toggle', 'rewind_preview', 'permission_rules', 'forget_session_rules', 'mcp_set_servers', 'mcp_permission_mode']);
  await assert.rejects(() => runSessionRequest({}, 'permission_rules'), /Unknown request/, 'not a Query call');
  const calls = [];
  const q = {
    getContextUsage: async (o) => { calls.push(['ctx', o]); return CONTEXT; },
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async (o) => { calls.push(['usage', o]); return { session: { total_cost_usd: 2 }, rate_limits_available: false, rate_limits: null }; },
    mcpServerStatus: async () => [{ name: 'SynaBun', status: 'connected' }],
    reconnectMcpServer: async (n) => { calls.push(['reconnect', n]); },
    toggleMcpServer: async (n, e) => { calls.push(['toggle', n, e]); },
    rewindFiles: async (id, o) => { calls.push(['rewind', id, o]); return { canRewind: true, filesChanged: ['/a'], insertions: 1, deletions: 2 }; },
  };
  assert.equal((await runSessionRequest(q, 'context_usage', {})).totalTokens, 76_000);
  await runSessionRequest(q, 'context_usage', { detail: 'full' });
  assert.deepEqual(calls.slice(0, 2), [['ctx', { detail: 'summary' }], ['ctx', { detail: 'full' }]], 'the exact count only on request');
  assert.equal((await runSessionRequest(q, 'usage')).session.costUsd, 2);
  assert.deepEqual(calls[2], ['usage', { skipBehaviors: true }], 'found by its prefix, without the transcript scan');
  assert.deepEqual((await runSessionRequest(q, 'mcp_toggle', { serverName: 'stripe', enabled: false })).servers[0].name, 'SynaBun');
  await runSessionRequest(q, 'mcp_reconnect', { serverName: 'stripe' });
  assert.deepEqual(calls.slice(3, 5), [['toggle', 'stripe', false], ['reconnect', 'stripe']]);
  assert.equal((await runSessionRequest(q, 'rewind_preview', { userMessageUuid: 'u1' })).fileCount, 1);
  assert.deepEqual(calls.at(-1), ['rewind', 'u1', { dryRun: true }], 'a preview never rewinds');

  await assert.rejects(runSessionRequest(null, 'usage'), /No active session/);
  await assert.rejects(runSessionRequest({}, 'usage'), /Not supported/);
  await assert.rejects(runSessionRequest(q, 'mcp_reconnect', {}), /Missing server name/);
  await assert.rejects(runSessionRequest(q, 'delete_everything'), /Unknown request/);
});

const panel = (await readFile(new URL('../public/shared/ui-claude-panel.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
function fnBody(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const rest = src.slice(start + signature.length);
  const next = rest.search(/\n(?:async )?function /);
  return next >= 0 ? rest.slice(0, next) : rest;
}

test('panel wiring: /context, /usage and /mcp ask the session; the exact count is on demand', () => {
  const run = fnBody(panel, 'function runSlashCommand(tab, raw) {');
  // /context and /mcp are local only when the bridge answers session requests
  // (slashCommandRoute in cp-events.js; its behaviour is tested in claude-panel-review-fixes).
  assert.match(run, /slashCommandRoute\(cmd, spec, \{ has: \(name\) => hasCapability\(tab, name\) \}\) === 'cli'\) return false;/);
  assert.match(run, /case 'context': \{ clearInput\(\); _showContextUsage\(tab\); return true; \}/);
  assert.match(run, /if \(!hasCapability\(tab, 'session_requests'\)\) return false;/, 'an older server: the CLI answers /usage itself');
  const ctx = fnBody(panel, "function _showContextUsage(tab, detail = 'summary') {");
  assert.match(ctx, /_sessionRequest\(tab, 'context_usage', \{ detail \}\)/);
  assert.match(ctx, /_showContextUsage\(tab, 'full'\)/);
  assert.match(fnBody(panel, 'function _showMcp(tab, servers = null) {'), /_sessionRequest\(tab, 'mcp_toggle', \{ serverName, enabled: action === 'enable' \}\)/);
  assert.match(fnBody(panel, 'function _attachRewindButton(tab, row, uuid) {'), /_sessionRequest\(tab, 'rewind_preview', \{ userMessageUuid: uuid \}\)/);
  assert.match(fnBody(panel, 'function _processTabMsg(tab, msg) {'), /appendStatus\(tab, rewindResultText\(msg\)\)/);
});
