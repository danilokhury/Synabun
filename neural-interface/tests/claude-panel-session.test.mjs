import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { installMiniDom } from './fixtures/mini-dom.mjs';
import { setCpCtx } from '../public/shared/cp/cp-ctx.js';
import { normalizePanelSession, startSignature, applyPanelSessionOptions, liveSettingsPatch } from '../lib/claude-panel-session.js';
import {
  SESSION_DEFAULTS, normalizeSession, parseList, changedStartSettings, sessionFlags, sessionRows, fastModeSupported, fastModeReason,
} from '../public/shared/cp/cp-session-model.js';
import { renderSessionSettingsCard } from '../public/shared/cp/cp-session-settings.js';

// A tab's session settings: fast mode, thinking, output style, agent, fallback
// model, limits, directories, plugins, MCP strictness, instructions, sandbox.
// The panel keeps one object per tab and sends it with every query; the bridge
// validates it again and turns it into query options (panel sessions only).

// ── Panel side ──

test('defaults: nothing is switched on, the parent directory stays readable', () => {
  assert.deepEqual(normalizeSession(null), {
    fastMode: false, thinking: 'default', outputStyle: '', agent: '', fallbackModel: '', maxBudgetUsd: 0, maxTurns: 0,
    additionalDirectories: [], includeParentDir: true, plugins: [], strictMcp: false, systemPromptAppend: '',
    sandbox: { enabled: false, autoAllowBash: false },
    hookEvents: true, promptSuggestions: true, subagentText: true, agentSummaries: false,
    // Run 2: the advanced fields, all empty or off.
    allowedTools: [], disallowedTools: [], tools: [], planModeInstructions: '', mcpServers: [], synabunAlwaysLoad: false,
    agents: [], skills: [], debug: false, overlay: { language: '', autoCompact: 'default', promptCacheTtl: '', advisorModel: '' },
  });
  assert.deepEqual(normalizeSession(null), normalizeSession(SESSION_DEFAULTS), 'the defaults are a normal session');
  assert.equal(SESSION_DEFAULTS.fastMode, false, 'fast mode is off by default');
  assert.equal(SESSION_DEFAULTS.agentSummaries, false, 'agent progress summaries are opt-in');
  assert.equal(normalizeSession(null).sandbox.enabled, false, 'the sandbox is opt-in');
});

test('normalising a session object: bounds, lists, a sandbox option that needs the sandbox', () => {
  const s = normalizeSession({
    fastMode: 'yes', thinking: 'off', maxBudgetUsd: '5.5', maxTurns: 3.7, additionalDirectories: ' /a \n/b,/a\n', includeParentDir: false,
    plugins: ['/p', '', '/p'], sandbox: { enabled: false, autoAllowBash: true }, outputStyle: '  Explanatory ',
  });
  assert.deepEqual([s.fastMode, s.thinking, s.maxBudgetUsd, s.maxTurns], [false, 'off', 5.5, 0]);
  assert.deepEqual(s.additionalDirectories, ['/a', '/b']);
  assert.deepEqual(s.plugins, ['/p']);
  assert.equal(s.includeParentDir, false);
  assert.deepEqual(s.sandbox, { enabled: false, autoAllowBash: false });
  assert.equal(s.outputStyle, 'Explanatory');
  assert.deepEqual(parseList('a\n\nb, c'), ['a', 'b', 'c']);
  assert.equal(parseList(Array.from({ length: 30 }, (_, i) => `/d${i}`)).length, 10);
});

test('the user is told which changes restart the session', () => {
  const base = normalizeSession(null);
  assert.deepEqual(changedStartSettings(base, { ...base, fastMode: true, outputStyle: 'Learning', agent: 'Plan' }), [], 'live settings switch on the running session');
  assert.deepEqual(changedStartSettings(base, { ...base, thinking: 'off', maxBudgetUsd: 5, sandbox: { enabled: true } }), ['thinking', 'spend limit', 'sandbox']);
  assert.deepEqual(changedStartSettings(base, { ...base, additionalDirectories: ['/x'], includeParentDir: false }), ['directories', 'parent directory access']);
});

test('statusline flags and status rows describe what is on', () => {
  const s = { fastMode: true, thinking: 'off', sandbox: { enabled: true, autoAllowBash: true }, strictMcp: true, agent: 'Plan', maxBudgetUsd: 5, additionalDirectories: ['/x'] };
  assert.deepEqual(sessionFlags(s, { toolPolicy: 'read-only', fastModeState: 'cooldown' }), ['fast (cooldown)', 'no thinking', 'sandbox', 'read-only', 'SynaBun MCP only', 'agent Plan', '$5 cap']);
  assert.deepEqual(sessionFlags(null), []);
  const rows = Object.fromEntries(sessionRows(s));
  assert.equal(rows.Directories, 'the project folder and its parent, plus /x');
  assert.equal(rows.Sandbox, 'on, sandboxed commands run without asking');
  assert.equal(Object.fromEntries(sessionRows({ includeParentDir: false })).Directories, 'the project folder only', 'the implicit parent grant is visible, and removable');
});

test('fast mode is offered from the session\'s model list; its off reason is readable', () => {
  const models = [{ value: 'opus', supportsFastMode: true }, { value: 'haiku' }];
  assert.equal(fastModeSupported(models, 'opus'), true);
  assert.equal(fastModeSupported(models, 'haiku'), false);
  assert.equal(fastModeSupported([], 'opus'), false);
  assert.equal(fastModeReason('sdk_opt_in_required'), 'needs an opt-in for SDK sessions');
  assert.equal(fastModeReason('model_not_allowed'), 'model not allowed');
  assert.equal(fastModeReason(''), '');
});

test('the session card collects every field into one normalised object', () => {
  const dom = installMiniDom();
  try {
    const tab = { messagesEl: dom.container('cp-messages') };
    setCpCtx({ activeTab: () => tab, scrollEnd: () => {} });
    const saved = [];
    const card = renderSessionSettingsCard(tab, {
      session: { additionalDirectories: ['/old'], maxBudgetUsd: 2 },
      models: [{ value: 'opus', displayName: 'Opus' }, { value: 'haiku', displayName: 'Haiku' }],
      agents: [{ name: 'Plan', description: 'Plans' }],
      outputStyles: ['default', 'Explanatory'],
      fastSupported: true,
      onSave: (s) => saved.push(s),
    });
    const controls = card.querySelectorAll('.cp-session-field').map(f => f.children[1]);
    const [fast, thinking, style, agent, fallback, budget, turns, dirs, parent, plugins, strict, append, sandbox, sandboxAuto, suggestions, hookEvents, subagentText, summaries] = controls;
    assert.deepEqual([suggestions.checked, hookEvents.checked, subagentText.checked, summaries.checked], [true, true, true, false]);
    suggestions.checked = false; summaries.checked = true;
    assert.equal(budget.value, '2');
    assert.equal(dirs.value, '/old');
    assert.equal(parent.checked, true);
    fast.checked = true; thinking.value = 'off'; style.value = 'Explanatory'; agent.value = 'Plan'; fallback.value = 'haiku';
    budget.value = '7.5'; turns.value = '40'; dirs.value = '/old\n/new'; parent.checked = false; plugins.value = '/plug';
    strict.checked = true; append.value = ' Always answer in Portuguese. '; sandbox.checked = true; sandboxAuto.checked = true;
    card.querySelectorAll('button').find(b => b.textContent === 'Save').click();
    assert.deepEqual(saved[0], {
      ...normalizeSession(null), // the advanced fields: untouched by a card that does not show them
      fastMode: true, thinking: 'off', outputStyle: 'Explanatory', agent: 'Plan', fallbackModel: 'haiku', maxBudgetUsd: 7.5, maxTurns: 40,
      additionalDirectories: ['/old', '/new'], includeParentDir: false, plugins: ['/plug'], strictMcp: true,
      systemPromptAppend: 'Always answer in Portuguese.', sandbox: { enabled: true, autoAllowBash: true },
      hookEvents: true, promptSuggestions: false, subagentText: true, agentSummaries: true,
    });
    assert.equal(card.classList.contains('active-perm'), false, 'a saved card is closed');
    // Without a model that supports it, fast mode cannot be switched on.
    const second = renderSessionSettingsCard(tab, { session: null, fastSupported: false });
    assert.equal(second.querySelectorAll('.cp-session-field')[0].children[1].disabled, true);
  } finally { dom.restore(); }
});

// ── Bridge side ──

test('the bridge validates the settings again and splits start from live', () => {
  const cfg = normalizePanelSession({
    fallbackModel: 'haiku', maxBudgetUsd: 5, maxTurns: 40, additionalDirectories: ['/a', '/a', 7], includeParentDir: false,
    plugins: ['/p'], strictMcp: true, systemPromptAppend: 'x'.repeat(9000), sandbox: { enabled: true, autoAllowBash: true },
    thinking: 'off', fastMode: true, outputStyle: 'Explanatory', agent: 'Plan', hooks: { evil: true }, env: { X: 1 },
  });
  // (Run 2 added the tool lists, plan instructions, tab MCP servers, agents, skills and the debug switch.)
  assert.deepEqual(Object.keys(cfg.start).sort(), ['additionalDirectories', 'agentSummaries', 'agents', 'allowedTools', 'debug', 'disallowedTools', 'fallbackModel', 'hookEvents', 'includeParentDir', 'maxBudgetUsd', 'maxTurns', 'mcpServers', 'planModeInstructions', 'plugins', 'promptSuggestions', 'sandbox', 'skills', 'strictMcp', 'subagentText', 'synabunAlwaysLoad', 'systemPromptAppend', 'thinkingOff', 'tools']);
  // Message streams: hook events, prompt suggestions and subagent text are on unless switched off; summaries are opt-in.
  assert.deepEqual([cfg.start.hookEvents, cfg.start.promptSuggestions, cfg.start.subagentText, cfg.start.agentSummaries], [true, true, true, false]);
  const quiet = normalizePanelSession({ hookEvents: false, promptSuggestions: false, subagentText: false, agentSummaries: true }).start;
  assert.deepEqual([quiet.hookEvents, quiet.promptSuggestions, quiet.subagentText, quiet.agentSummaries], [false, false, false, true]);
  assert.deepEqual(cfg.live, { fastMode: true, outputStyle: 'Explanatory', agent: 'Plan', overlay: { language: '', autoCompact: 'default', promptCacheTtl: '', advisorModel: '' } });
  assert.deepEqual(cfg.start.additionalDirectories, ['/a']);
  assert.equal(cfg.start.systemPromptAppend.length, 8000);
  assert.deepEqual(normalizePanelSession({ maxBudgetUsd: -1, maxTurns: 1.5, sandbox: { autoAllowBash: true } }).start, normalizePanelSession(null).start, 'out-of-range values are dropped');
  assert.equal(startSignature(normalizePanelSession({ fastMode: true })), startSignature(normalizePanelSession(null)), 'a live setting does not change the start signature');
  assert.notEqual(startSignature(normalizePanelSession({ maxTurns: 5 })), startSignature(normalizePanelSession(null)));
});

test('session settings become query options; a missing directory is reported, not passed', () => {
  const options = { additionalDirectories: ['/parent'], systemPrompt: { type: 'preset', preset: 'claude_code' } };
  const cfg = normalizePanelSession({
    fallbackModel: 'haiku', maxBudgetUsd: 5, maxTurns: 40, additionalDirectories: ['/extra', '/missing'], plugins: ['/plug', '/gone'],
    strictMcp: true, systemPromptAppend: 'Be brief.', sandbox: { enabled: true, autoAllowBash: true }, thinking: 'off',
    fastMode: true, outputStyle: 'Explanatory', agent: 'Plan',
  });
  const notes = applyPanelSessionOptions(options, cfg, { model: 'opus', validateDir: (p) => (p.includes('missing') || p.includes('gone') ? null : p) });
  assert.deepEqual(notes, ['Directory not found, not added: /missing', 'Plugin directory not found, not loaded: /gone']);
  assert.deepEqual(options.additionalDirectories, ['/parent', '/extra']);
  assert.equal(options.fallbackModel, 'haiku');
  assert.deepEqual([options.maxBudgetUsd, options.maxTurns, options.strictMcpConfig], [5, 40, true]);
  assert.deepEqual(options.plugins, [{ type: 'local', path: '/plug' }]);
  assert.deepEqual(options.systemPrompt, { type: 'preset', preset: 'claude_code', append: 'Be brief.' });
  assert.equal(options.sandbox.enabled, true);
  assert.equal(options.sandbox.autoAllowBashIfSandboxed, true);
  assert.deepEqual(options.thinking, { type: 'disabled' });
  assert.deepEqual(options.settings, { fastMode: true, outputStyle: 'Explanatory' });
  assert.equal(options.agent, 'Plan');

  // Removing the parent directory grant; a fallback equal to the model is pointless.
  const bare = { additionalDirectories: ['/parent'] };
  applyPanelSessionOptions(bare, normalizePanelSession({ includeParentDir: false, fallbackModel: 'opus' }), { model: 'opus' });
  assert.equal('additionalDirectories' in bare, false);
  assert.equal('fallbackModel' in bare, false);
  // Defaults add only the message streams the panel renders; summaries stay off.
  const untouched = { additionalDirectories: ['/parent'] };
  applyPanelSessionOptions(untouched, normalizePanelSession(null), {});
  // Fast mode Off is stated as `false` (review R12): an absent key would let a
  // `fastMode: true` in the user's settings win while the panel shows Off.
  assert.deepEqual(untouched, { additionalDirectories: ['/parent'], includeHookEvents: true, promptSuggestions: true, forwardSubagentText: true, settings: { fastMode: false } });
  const allOff = { additionalDirectories: ['/parent'] };
  applyPanelSessionOptions(allOff, normalizePanelSession({ hookEvents: false, promptSuggestions: false, subagentText: false }), {});
  assert.deepEqual(allOff, { additionalDirectories: ['/parent'], settings: { fastMode: false } });
  const summaries = {};
  applyPanelSessionOptions(summaries, normalizePanelSession({ agentSummaries: true, includeParentDir: false }), {});
  assert.equal(summaries.agentProgressSummaries, true);
});

test('live settings move with one applyFlagSettings patch; null clears a style or an agent, fast mode Off is false', () => {
  const off = { fastMode: false, outputStyle: '', agent: '' };
  assert.equal(liveSettingsPatch(off, off), null);
  assert.deepEqual(liveSettingsPatch(off, { fastMode: true, outputStyle: 'Learning', agent: '' }), { fastMode: true, outputStyle: 'Learning' });
  assert.deepEqual(liveSettingsPatch({ fastMode: true, outputStyle: 'Learning', agent: 'Plan' }, off), { fastMode: false, outputStyle: null, agent: null });
  assert.deepEqual(liveSettingsPatch(undefined, { fastMode: false, outputStyle: '', agent: 'Plan' }), { agent: 'Plan' });
});

// ── Panel wiring (source contracts) ──

const panel = (await readFile(new URL('../public/shared/ui-claude-panel.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
function fnBody(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const rest = src.slice(start + signature.length);
  const next = rest.search(/\n(?:async )?function /);
  return next >= 0 ? rest.slice(0, next) : rest;
}

test('the tab sends its session settings with every query, only to a bridge that reads them', () => {
  assert.match(fnBody(panel, 'function _applySessionOptions(tab, msg) {'), /if \(hasCapability\(tab, 'session_settings'\)\) msg\.session = normalizeSession\(tab\.session\)/);
  const patch = fnBody(panel, 'function _patchSession(tab, patch, note = \'\') {');
  assert.match(patch, /changedStartSettings\(before, tab\.session\)/);
  assert.match(patch, /the session restarts with the new/);
  assert.match(panel, /session: normalizeSession\(t\.session\)/, 'saved with the tab');
  assert.match(panel, /if \(t && saved\.session\) t\.session = normalizeSession\(saved\.session\)/);
});

test('/add-dir, /agents and /plugin are answered from the session, not guessed or passed through', () => {
  const run = fnBody(panel, 'function runSlashCommand(tab, raw) {');
  assert.match(run, /_patchSession\(tab, \{ additionalDirectories: \[\.\.\.current, dir\.trim\(\)\] \}/);
  assert.doesNotMatch(run, /tab\._addedDirs/, 'the directory used to be stored where nothing read it');
  assert.doesNotMatch(run, /claude-code-guide/, 'no hardcoded agent list');
  assert.match(run, /init\.plugins\.length/);
  assert.match(run, /renderSessionSettingsCard\(tab, \{/);
  // Who answers a typed command is decided in cp-events.js (slashCommandRoute):
  // /add-dir is local only on a server that advertises session settings.
  assert.match(panel, /slashCommandRoute\(cmd, spec, \{ has: /);
  for (const name of ['session', 'fast', 'output-style', 'budget', 'reload-plugins']) {
    assert.match(panel, new RegExp(`name: '${name}'[^\\n]*needs: '(session_settings|reload_plugins)'`), `/${name} is capability-gated`);
  }
});

// ── Accounts (K9) ──

import { sessionActionsAvailable } from '../public/shared/cp/cp-sessions.js';

test('a tab under another account says so, and leaves the default account\'s session files alone', () => {
  assert.deepEqual(sessionFlags(null, { account: 'work' }), ['account work']);
  assert.deepEqual(sessionFlags(null, { account: 'default' }), []);
  // The actions also need a server that advertises its session routes (review R03).
  const ops = new Set(['session_ops']);
  assert.equal(sessionActionsAvailable({ accountId: '', capabilities: ops }), true);
  assert.equal(sessionActionsAvailable({ accountId: 'default', capabilities: ops }), true);
  assert.equal(sessionActionsAvailable({ accountId: 'work', capabilities: ops }), false, 'rename, fork, delete and subagent transcripts read the default config directory');
  assert.equal(sessionActionsAvailable({ accountId: '' }), false, 'a server that was not restarted has none of them');
  assert.match(fnBody(panel, 'function _applySessionOptions(tab, msg) {'), /if \(hasCapability\(tab, 'accounts'\)\) msg\.accountId = tab\.accountId \|\| 'default';/);
  const accounts = fnBody(panel, "function _showAccounts(tab, wanted = '') {");
  assert.match(accounts, /if \(tab\.sessionId\) \{ appendStatus\(tab, 'This conversation belongs to the account it started under/);
  assert.match(accounts, /if \(!account\.loggedIn\)/);
  assert.match(panel, /if \(accountTab\?\.accountId\) params\.set\('account', accountTab\.accountId\)/);
});

// ── The model picker and the session's own model list (C03) ──

import { mergeSessionModels } from '../public/shared/cp/cp-session-model.js';
import { normalizeClaudeModel } from '../lib/claude-model-catalog.js';
import { autoModeSupported as autoSupported } from '../public/shared/cp/cp-permission-model.js';

test('the picker takes capability flags and missing models from the running session', () => {
  const catalog = [
    { id: 'opus', label: 'Opus 5.5', supportsFastMode: false, cliReady: true },
    { id: 'haiku', label: 'Haiku 4.5', cliReady: true },
  ];
  const session = [
    { value: 'opus', displayName: 'Opus', supportsAutoMode: true, supportsFastMode: true },
    { value: 'haiku', displayName: 'Haiku' },
    { value: 'fable[1m]', displayName: 'Fable 5.1 (1M)', description: 'Most capable', supportedEffortLevels: ['low', 'high'], supportsEffort: true, supportsAutoMode: true },
  ];
  const merged = mergeSessionModels(catalog, session);
  assert.equal(merged.changed, true);
  assert.deepEqual(merged.models.map(m => m.id), ['opus', 'haiku', 'fable[1m]']);
  assert.deepEqual([merged.models[0].supportsAutoMode, merged.models[0].supportsFastMode, merged.models[0].label], [true, true, 'Opus 5.5'], 'flags from the session, the label stays the catalog\'s');
  const added = merged.models[2];
  assert.deepEqual([added.label, added.contextWindow, added.effortLevels, added.supportsEffort, added.fromSession, added.cliReady], ['Fable 5.1 (1M)', 1_000_000, ['low', 'high'], true, true, true]);
  // Merging the same list again changes nothing; no session list changes nothing.
  assert.equal(mergeSessionModels(merged.models, session).changed, false);
  assert.deepEqual(mergeSessionModels(catalog, []), { models: catalog, changed: false });
  // Auto mode can be offered from catalog rows too (they carry `id`, not `value`).
  assert.equal(autoSupported(merged.models, 'opus'), true);
  assert.equal(autoSupported(merged.models, 'haiku'), false);
});

test('the catalog keeps the two capability flags it used to drop', () => {
  const row = normalizeClaudeModel({ value: 'opus', displayName: 'Opus', description: 'x', supportsAutoMode: true, supportsAdaptiveThinking: true });
  assert.deepEqual([row.supportsAutoMode, row.supportsAdaptiveThinking], [true, true]);
  const plain = normalizeClaudeModel({ value: 'haiku', displayName: 'Haiku' });
  assert.deepEqual([plain.supportsAutoMode, plain.supportsAdaptiveThinking], [false, false]);
});

// ═══ Run 2: C13 (tools), C14 (MCP servers), C11 (agents), C12 (skills), C19 (overlay, debug) ═══

import { overlaySettings } from '../lib/claude-panel-session.js';

test('C13: tool lists and plan-mode instructions become options; an empty tool list is never passed', () => {
  const cfg = normalizePanelSession({
    allowedTools: ['Bash(npm test:*)', 'Bash(npm test:*)', ''], disallowedTools: ['WebFetch'], tools: ['Read', 'Grep', 'not a tool!', 'Bash'],
    planModeInstructions: '  Always list risks first.  ',
  });
  assert.deepEqual(cfg.start.allowedTools, ['Bash(npm test:*)']);
  assert.deepEqual(cfg.start.tools, ['Read', 'Grep', 'Bash']);
  const options = { disallowedTools: ['Edit'] }; // what the tab's tool policy already removed
  applyPanelSessionOptions(options, cfg, {});
  assert.deepEqual(options.allowedTools, ['Bash(npm test:*)']);
  assert.deepEqual(options.disallowedTools, ['Edit', 'WebFetch'], 'added to the policy, not instead of it');
  assert.deepEqual(options.tools, ['Read', 'Grep', 'Bash']);
  assert.equal(options.planModeInstructions, 'Always list risks first.');
  const bare = {};
  applyPanelSessionOptions(bare, normalizePanelSession({ tools: [], allowedTools: [] }), {});
  for (const key of ['tools', 'allowedTools', 'disallowedTools', 'planModeInstructions', 'agents', 'skills', 'mcpServers', 'debug', 'debugFile']) assert.equal(key in bare, false, `${key} is absent by default`);
  assert.notEqual(startSignature(cfg), startSignature(normalizePanelSession(null)), 'a tool change restarts the session');
});

test('C14: a tab adds remote MCP servers; SynaBun\'s entry is never replaced', () => {
  const cfg = normalizePanelSession({
    synabunAlwaysLoad: true,
    mcpServers: [
      { name: 'docs', url: 'https://mcp.example.com/mcp', alwaysLoad: true, timeoutMs: 60000 },
      { name: 'events', type: 'sse', url: 'http://localhost:9000/sse' },
      { name: 'SynaBun', url: 'https://evil.example/mcp' },
      { name: 'shell', type: 'stdio', command: 'rm', args: ['-rf', '/'], url: 'file:///etc/passwd' },
      { name: 'bad name', url: 'https://x.example/' },
      { name: 'docs', url: 'https://dup.example/' },
      { name: 'hdr', url: 'https://h.example/mcp', headers: { Authorization: 'Bearer secret' }, timeoutMs: 5 },
      null,
    ],
  });
  assert.deepEqual(cfg.start.mcpServers, [
    { name: 'docs', type: 'http', url: 'https://mcp.example.com/mcp', alwaysLoad: true, timeoutMs: 60000 },
    { name: 'events', type: 'sse', url: 'http://localhost:9000/sse', alwaysLoad: false, timeoutMs: 0 },
    { name: 'hdr', type: 'http', url: 'https://h.example/mcp', alwaysLoad: false, timeoutMs: 0 },
  ]);
  const options = { mcpServers: { SynaBun: { type: 'http', url: 'http://localhost:3344/mcp', headers: { 'X-Synabun-Terminal': 't' } }, events: { type: 'http', url: 'http://host/brain' } } };
  const notes = applyPanelSessionOptions(options, cfg, {});
  assert.deepEqual(options.mcpServers.SynaBun, { type: 'http', url: 'http://localhost:3344/mcp', headers: { 'X-Synabun-Terminal': 't' }, alwaysLoad: true });
  assert.deepEqual(options.mcpServers.docs, { type: 'http', url: 'https://mcp.example.com/mcp', alwaysLoad: true, timeout: 60000 });
  assert.deepEqual(options.mcpServers.events, { type: 'http', url: 'http://host/brain' }, 'a server the host defined wins');
  assert.equal('headers' in options.mcpServers.hdr, false, 'headers are not accepted from a tab');
  assert.deepEqual(notes, ['MCP server "events" is already defined for this session: the tab\'s entry was not added.']);
});

test('C11 / C12: agents defined for a tab and the skills it may see', () => {
  const cfg = normalizePanelSession({
    agents: {
      reviewer: { description: 'Reviews a diff', prompt: 'You review diffs.', tools: ['Read', 'Grep', 'mcp__SynaBun__recall', 'rm -rf'], model: 'haiku', hooks: { x: 1 }, permissionMode: 'bypassPermissions' },
      'bad name': { description: 'x', prompt: 'y' },
      empty: { description: '', prompt: 'y' },
    },
    skills: ['pdf', 'docx', 'pdf'],
  });
  assert.deepEqual(cfg.start.agents, [{ name: 'reviewer', description: 'Reviews a diff', prompt: 'You review diffs.', tools: ['Read', 'Grep', 'mcp__SynaBun__recall'], model: 'haiku' }]);
  const options = {};
  applyPanelSessionOptions(options, cfg, {});
  assert.deepEqual(options.agents, { reviewer: { description: 'Reviews a diff', prompt: 'You review diffs.', tools: ['Read', 'Grep', 'mcp__SynaBun__recall'], model: 'haiku' } }, 'only the four known fields: no hooks, no permission mode');
  assert.deepEqual(options.skills, ['pdf', 'docx']);
  // The array form the panel sends.
  assert.deepEqual(normalizePanelSession({ agents: [{ name: 'a', description: 'd', prompt: 'p' }] }).start.agents, [{ name: 'a', description: 'd', prompt: 'p' }]);
});

test('C19: the settings overlay is an allowlist, live; the debug log needs a host that names the file', () => {
  const cfg = normalizePanelSession({ overlay: { language: 'Portuguese', autoCompact: 'off', promptCacheTtl: '1h', advisorModel: 'opus', hooks: { Stop: [] }, env: { A: 1 }, permissions: { allow: ['Bash'] }, apiKeyHelper: 'x' }, debug: true });
  assert.deepEqual(cfg.live.overlay, { language: 'Portuguese', autoCompact: 'off', promptCacheTtl: '1h', advisorModel: 'opus' });
  assert.deepEqual(overlaySettings(cfg.live.overlay), { language: 'Portuguese', autoCompactEnabled: false, promptCacheTtl: '1h', advisorModel: 'opus' });
  assert.deepEqual(overlaySettings(null), {}, 'nothing set, nothing overridden');
  const options = {};
  assert.deepEqual(applyPanelSessionOptions(options, cfg, { debugFile: '/data/logs/claude-s1.log' }), []);
  assert.deepEqual(options.settings, { fastMode: false, language: 'Portuguese', autoCompactEnabled: false, promptCacheTtl: '1h', advisorModel: 'opus' });
  assert.deepEqual([options.debug, options.debugFile], [true, '/data/logs/claude-s1.log']);
  const noFile = {};
  assert.deepEqual(applyPanelSessionOptions(noFile, cfg, {}), ['The debug log is not available on this server: the session starts without it.']);
  assert.equal('debug' in noFile, false, 'never a debug stream without a file to hold it');
  // Live: set, change, and clear back to what the settings files say.
  const base = { fastMode: false, outputStyle: '', agent: '' };
  assert.deepEqual(liveSettingsPatch(base, { ...base, overlay: { language: 'French', autoCompact: 'on' } }), { language: 'French', autoCompactEnabled: true });
  assert.deepEqual(liveSettingsPatch({ ...base, overlay: { language: 'French', autoCompact: 'on', promptCacheTtl: '1h' } }, { ...base, overlay: { language: 'French' } }), { autoCompactEnabled: null, promptCacheTtl: null });
  assert.equal(liveSettingsPatch({ ...base, overlay: { language: 'French' } }, { ...base, overlay: { language: 'French' } }), null);
  assert.equal(startSignature(cfg), startSignature(normalizePanelSession({ debug: true })), 'the overlay does not restart the session');
});

test('C11 / C14: the card\'s text for MCP servers and agents parses, reports what is wrong, and round-trips', async () => {
  const { parseMcpServerLines, formatMcpServerLines, parseAgentsJson, formatAgentsJson } = await import('../public/shared/cp/cp-session-model.js');
  const parsed = parseMcpServerLines('docs https://mcp.example.com/mcp always timeout=60\n\nevents http://localhost:9000/sse sse\nSynaBun https://x.example/\nshell rm -rf /\ndocs https://dup.example/');
  assert.deepEqual(parsed.servers, [
    { name: 'docs', type: 'http', url: 'https://mcp.example.com/mcp', alwaysLoad: true, timeoutMs: 60000 },
    { name: 'events', type: 'sse', url: 'http://localhost:9000/sse', alwaysLoad: false, timeoutMs: 0 },
  ]);
  assert.equal(parsed.errors.length, 3);
  assert.match(parsed.errors[0], /SynaBun/);
  assert.match(parsed.errors[2], /listed twice/);
  assert.equal(formatMcpServerLines(parsed.servers), 'docs https://mcp.example.com/mcp always timeout=60\nevents http://localhost:9000/sse sse');
  assert.deepEqual(parseMcpServerLines(formatMcpServerLines(parsed.servers)).servers, parsed.servers);
  assert.deepEqual(parseMcpServerLines(''), { servers: [], errors: [] });

  const json = '{ "reviewer": { "description": "Reviews a diff", "prompt": "You review diffs.", "tools": ["Read", "Grep"], "model": "haiku" } }';
  const agents = parseAgentsJson(json);
  assert.deepEqual(agents, { agents: [{ name: 'reviewer', description: 'Reviews a diff', prompt: 'You review diffs.', tools: ['Read', 'Grep'], model: 'haiku' }], error: '' });
  assert.deepEqual(parseAgentsJson(formatAgentsJson(agents.agents)), agents);
  assert.match(parseAgentsJson('{ nope').error, /Not valid JSON/);
  assert.match(parseAgentsJson('{ "a b": { "description": "d", "prompt": "p" }, "ok": { "description": "d" } }').error, /not a usable agent name.*ok needs a description and a prompt/);
  assert.deepEqual(parseAgentsJson(''), { agents: [], error: '' });
  assert.equal(formatAgentsJson([]), '');
  // The session object keeps them, and says so in /status.
  const s = normalizeSession({ mcpServers: parsed.servers, agents: agents.agents, skills: 'pdf, docx', tools: ['Read'], debug: true, overlay: { language: 'French', autoCompact: 'off' } });
  const rows = Object.fromEntries(sessionRows(s));
  assert.equal(rows['MCP servers of this tab'], 'docs (https://mcp.example.com/mcp), events (http://localhost:9000/sse)');
  assert.equal(rows['Custom agents'], 'reviewer');
  assert.equal(rows.Skills, 'only pdf, docx');
  assert.equal(rows['Built-in tools'], 'only Read');
  assert.equal(rows['Settings for this tab'], 'language French, auto-compact off');
  assert.equal(rows['Debug log'], 'on');
  assert.deepEqual(changedStartSettings(null, s).sort(), ['MCP servers', 'custom agents', 'debug log', 'skills', 'tool list']);
  assert.deepEqual(changedStartSettings(null, { overlay: { language: 'French' } }), [], 'the overlay applies live');
});

test('the advanced section shows with the capability, keeps what the tab had, and refuses a field it cannot read', () => {
  const dom = installMiniDom();
  try {
    const tab = { messagesEl: dom.container('cp-messages') };
    setCpCtx({ activeTab: () => tab, scrollEnd: () => {} });
    const saved = [];
    const session = { tools: ['Read'], mcpServers: [{ name: 'docs', url: 'https://mcp.example.com/mcp' }], overlay: { language: 'French' } };
    // A server that does not read them: no section, and a save keeps the stored values.
    const basic = renderSessionSettingsCard(tab, { session, onSave: (s) => saved.push(s) });
    assert.equal(basic.querySelector('.cp-session-advanced'), null);
    basic.querySelectorAll('button').find(b => b.textContent === 'Save').click();
    assert.deepEqual([saved[0].tools, saved[0].mcpServers.map(m => m.name), saved[0].overlay.language], [['Read'], ['docs'], 'French']);

    const card = renderSessionSettingsCard(tab, { session, advanced: true, onSave: (s) => saved.push(s) });
    const fields = card.querySelector('.cp-session-advanced').querySelectorAll('.cp-session-field').map(f => f.children[1]);
    const [allowed, disallowed, tools, plan, mcp, synabunAlways, agents, skills, language, autoCompact, cacheTtl, advisor, debug] = fields;
    assert.equal(tools.value, 'Read');
    assert.equal(mcp.value, 'docs https://mcp.example.com/mcp');
    assert.equal(language.value, 'French');
    allowed.value = 'Bash(npm test:*)'; disallowed.value = 'WebFetch'; plan.value = 'List risks first.'; synabunAlways.checked = true;
    skills.value = 'pdf\ndocx'; autoCompact.value = 'off'; cacheTtl.value = '1h'; advisor.value = 'opus'; debug.checked = true;
    mcp.value = 'docs https://mcp.example.com/mcp\nshell rm -rf /';
    agents.value = '{ broken';
    const saveBtn = card.querySelectorAll('button').find(b => b.textContent === 'Save');
    saveBtn.click();
    assert.equal(saved.length, 1, 'nothing is saved while a field cannot be read');
    const problems = card.querySelector('.cp-elicit-error');
    assert.equal(problems.hidden, false);
    assert.match(problems.textContent, /MCP servers: .*shell/);
    assert.match(problems.textContent, /Custom agents: Not valid JSON/);
    mcp.value = 'docs https://mcp.example.com/mcp always';
    agents.value = '{ "reviewer": { "description": "Reviews", "prompt": "Review the diff." } }';
    saveBtn.click();
    const s = saved[1];
    assert.deepEqual([s.allowedTools, s.disallowedTools, s.tools, s.planModeInstructions, s.synabunAlwaysLoad, s.skills, s.debug],
      [['Bash(npm test:*)'], ['WebFetch'], ['Read'], 'List risks first.', true, ['pdf', 'docx'], true]);
    assert.deepEqual(s.mcpServers, [{ name: 'docs', type: 'http', url: 'https://mcp.example.com/mcp', alwaysLoad: true, timeoutMs: 0 }]);
    assert.deepEqual(s.agents, [{ name: 'reviewer', description: 'Reviews', prompt: 'Review the diff.' }]);
    assert.deepEqual(s.overlay, { language: 'French', autoCompact: 'off', promptCacheTtl: '1h', advisorModel: 'opus' });
  } finally { dom.restore(); }
});
