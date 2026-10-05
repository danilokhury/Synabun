import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SLASH_COMMANDS,
  buildDispatchSpec,
  isKnownSlashCommand,
  matchSlashCommands,
  parseSlashCommand,
  slashHelpMarkdown,
  tokenize,
} from '../public/shared/assistant/asst-slash.js';

test('non-commands return null', () => {
  assert.equal(parseSlashCommand('hello'), null);
  assert.equal(parseSlashCommand(''), null);
  assert.equal(parseSlashCommand('/'), null);
  assert.equal(parseSlashCommand('//literal'), null);
  assert.equal(parseSlashCommand('/ path/to/file'), null);
  assert.equal(parseSlashCommand(null), null);
});

test('simple commands parse (case-insensitive, leading whitespace ok)', () => {
  assert.deepEqual(parseSlashCommand('/help'), { name: 'help' });
  assert.deepEqual(parseSlashCommand('  /HELP'), { name: 'help' });
  assert.deepEqual(parseSlashCommand('/compact'), { name: 'compact' });
  assert.deepEqual(parseSlashCommand('/clear'), { name: 'clear' });
  assert.deepEqual(parseSlashCommand('/agents'), { name: 'agents', all: false });
  assert.deepEqual(parseSlashCommand('/agents all'), { name: 'agents', all: true });
  assert.deepEqual(parseSlashCommand('/resume'), { name: 'resume', sessionId: null });
  assert.deepEqual(parseSlashCommand('/resume assistant-abc'), { name: 'resume', sessionId: 'assistant-abc' });
  assert.deepEqual(parseSlashCommand('/project /Users/me/app'), { name: 'project', path: '/Users/me/app' });
  assert.deepEqual(parseSlashCommand('/new oc'), { name: 'new', provider: 'opencode' });
  assert.deepEqual(parseSlashCommand('/new'), { name: 'new', provider: null });
});

test('unknown commands pass through to the brain', () => {
  const p = parseSlashCommand('/synabun brainstorm ideas');
  assert.equal(p.name, 'synabun');
  assert.equal(p.passthrough, true);
  assert.equal(p.rest, 'brainstorm ideas');
  assert.equal(p.raw, '/synabun brainstorm ideas');
  assert.equal(isKnownSlashCommand('synabun'), false);
  assert.equal(isKnownSlashCommand('DISPATCH'), true);
});

test('/stop variants', () => {
  assert.deepEqual(parseSlashCommand('/stop'), { name: 'stop', target: null, all: false });
  assert.deepEqual(parseSlashCommand('/stop all'), { name: 'stop', target: null, all: true });
  assert.deepEqual(parseSlashCommand('/stop run-123'), { name: 'stop', target: 'run-123', all: false });
});

test('/recall and /remember require text', () => {
  assert.deepEqual(parseSlashCommand('/recall'), { name: 'recall', error: 'missing_query' });
  assert.deepEqual(parseSlashCommand('/recall sqlite vectors'), { name: 'recall', query: 'sqlite vectors' });
  assert.deepEqual(parseSlashCommand('/remember'), { name: 'remember', error: 'missing_text' });
  assert.deepEqual(parseSlashCommand('/remember the db lives in data/'), { name: 'remember', text: 'the db lives in data/' });
});

test('/model parses provider/model effort combos', () => {
  assert.deepEqual(parseSlashCommand('/model claude/opus high'), { name: 'model', provider: 'claude-code', model: 'opus', effort: 'high' });
  assert.deepEqual(parseSlashCommand('/model codex'), { name: 'model', provider: 'codex', model: null, effort: null });
  assert.deepEqual(parseSlashCommand('/model gpt-5.5 xhigh'), { name: 'model', provider: null, model: 'gpt-5.5', effort: 'xhigh' });
  assert.deepEqual(parseSlashCommand('/model'), { name: 'model', provider: null, model: null, effort: null });
});

test('/dispatch with flags and a quoted task', () => {
  const p = parseSlashCommand('/dispatch codex --model gpt-5.4-mini --effort low --ask "write docs for hooks/"');
  assert.equal(p.name, 'dispatch');
  assert.equal(p.error, undefined);
  assert.equal(p.provider, 'codex');
  assert.deepEqual(p.options, { model: 'gpt-5.4-mini', effort: 'low', ask: true });
  assert.equal(p.task, 'write docs for hooks/');
  assert.equal(p.permissionPolicy, 'ask');
});

test('/dispatch with an unquoted multi-word task keeps the raw tail', () => {
  const p = parseSlashCommand('/dispatch claude fix the "quoted" bug in x.js');
  assert.equal(p.provider, 'claude-code');
  assert.equal(p.task, 'fix the "quoted" bug in x.js');
  assert.equal(p.permissionPolicy, 'auto');
  assert.deepEqual(p.options, {});
});

test('/dispatch: a single-dash token is not a flag, it starts the task', () => {
  const p = parseSlashCommand('/dispatch cx --model=gpt-5.5 -m ignored --title "Docs pass"');
  assert.equal(p.error, undefined);
  assert.deepEqual(p.options, { model: 'gpt-5.5' });
  assert.equal(p.task, '-m ignored --title "Docs pass"');
});

test('/dispatch flag aliases, --key=value and boolean flags resolve to canonical names', () => {
  const p = parseSlashCommand('/dispatch cx --m=gpt-5.5 --t "Docs pass" --p /repo --account acc-2 --focus --browser=false --budget 2.5 --minutes 30 run it');
  assert.equal(p.error, undefined);
  assert.deepEqual(p.options, { model: 'gpt-5.5', title: 'Docs pass', project: '/repo', account: 'acc-2', focus: true, browser: false, budget: '2.5', minutes: '30' });
  assert.equal(p.task, 'run it');
});

test('/dispatch error cases', () => {
  assert.deepEqual(parseSlashCommand('/dispatch'), { name: 'dispatch', error: 'missing_provider' });
  assert.equal(parseSlashCommand('/dispatch gemini do x').error, 'invalid_provider');
  assert.equal(parseSlashCommand('/dispatch gemini do x').provider, 'gemini');
  const unknown = parseSlashCommand('/dispatch codex --bogus do x');
  assert.equal(unknown.error, 'unknown_flag');
  assert.equal(unknown.flag, 'bogus');
  const missingValue = parseSlashCommand('/dispatch codex --model');
  assert.equal(missingValue.error, 'missing_flag_value');
  assert.equal(missingValue.flag, 'model');
  assert.equal(parseSlashCommand('/dispatch codex --model --ask x').error, 'missing_flag_value');
  assert.equal(parseSlashCommand('/dispatch codex --ask').error, 'missing_task');
});

test('tokenize handles quotes and escapes', () => {
  assert.deepEqual(tokenize('a "b c" d\\ e \'f g\'').map(t => t.value), ['a', 'b c', 'd e', 'f g']);
  assert.deepEqual(tokenize('  ').map(t => t.value), []);
  assert.equal(tokenize('"unterminated').at(0).value, 'unterminated');
});

test('buildDispatchSpec inherits brain project/mcp/account only when sensible', () => {
  const brain = { provider: 'codex', model: 'gpt-5.5', effort: 'high', project: '/repo', mcpProfile: 'standard', accountId: 'acc-1', permissionMode: 'default' };
  const parsed = parseSlashCommand('/dispatch codex --model gpt-5.4-mini "docs"');
  const spec = buildDispatchSpec(parsed, brain, { assistantSessionId: 'assistant-1' });
  assert.deepEqual(spec, {
    provider: 'codex',
    task: 'docs',
    permissionPolicy: 'auto',
    focus: false,
    cwd: '/repo',
    model: 'gpt-5.4-mini',
    mcpProfile: 'standard',
    codexAccountId: 'acc-1',
    assistantSessionId: 'assistant-1',
  });

  // Cross-provider dispatch does not inherit the account; explicit flags override
  const claude = buildDispatchSpec(parseSlashCommand('/dispatch claude --project /other --mcp browser --ask --budget 3 --minutes 20 --title T --browser "review"'), brain, { assistantSessionId: 'assistant-1' });
  assert.equal(claude.provider, 'claude-code');
  assert.equal(claude.cwd, '/other');
  assert.equal(claude.mcpProfile, 'browser');
  assert.equal(claude.claudeAccountId, undefined);
  assert.equal(claude.codexAccountId, undefined);
  assert.equal(claude.permissionPolicy, 'ask');
  assert.equal(claude.budgetUsd, 3);
  assert.equal(claude.maxMinutes, 20);
  assert.equal(claude.title, 'T');
  assert.equal(claude.usesBrowser, true);

  const explicitAccount = buildDispatchSpec(parseSlashCommand('/dispatch claude --account work "x"'), brain, {});
  assert.equal(explicitAccount.claudeAccountId, 'work');
  assert.equal(explicitAccount.assistantSessionId, undefined);

  assert.equal(buildDispatchSpec(parseSlashCommand('/dispatch'), brain), null);
  assert.equal(buildDispatchSpec(parseSlashCommand('/help'), brain), null);
});

test('matchSlashCommands prefix-matches and help lists every command', () => {
  assert.deepEqual(matchSlashCommands('/di').map(c => c.name), ['dispatch']);
  assert.deepEqual(matchSlashCommands('/re').map(c => c.name), ['recall', 'remember', 'resume']);
  assert.equal(matchSlashCommands('/').length, SLASH_COMMANDS.length);
  assert.equal(matchSlashCommands('/zzz').length, 0);
  const help = slashHelpMarkdown((c) => `desc:${c.name}`);
  for (const c of SLASH_COMMANDS) {
    assert.ok(help.includes(c.usage), `usage for ${c.name}`);
    assert.ok(help.includes(`desc:${c.name}`), `description for ${c.name}`);
  }
});

test('/routes sets the route mode (aliases) or opens the editor', () => {
  assert.deepEqual(parseSlashCommand('/routes'), { name: 'routes', mode: null });
  assert.deepEqual(parseSlashCommand('/routes always'), { name: 'routes', mode: 'always-ask' });
  assert.deepEqual(parseSlashCommand('/routes ask'), { name: 'routes', mode: 'always-ask' });
  assert.deepEqual(parseSlashCommand('/ROUTES unsure'), { name: 'routes', mode: 'ask-unsure' });
  assert.deepEqual(parseSlashCommand('/routes never'), { name: 'routes', mode: 'never' });
  assert.deepEqual(parseSlashCommand('/routes auto'), { name: 'routes', mode: 'never' });
  assert.deepEqual(parseSlashCommand('/routes sometimes'), { name: 'routes', mode: null, error: 'invalid_mode', value: 'sometimes' });
  assert.equal(isKnownSlashCommand('routes'), true);
});

test('/computer toggles or sets computer use', () => {
  assert.deepEqual(parseSlashCommand('/computer'), { name: 'computer', mode: null });
  assert.deepEqual(parseSlashCommand('/computer on'), { name: 'computer', mode: 'on' });
  assert.deepEqual(parseSlashCommand('/computer OFF'), { name: 'computer', mode: 'off' });
  assert.deepEqual(parseSlashCommand('/computer true'), { name: 'computer', mode: 'on' });
  assert.deepEqual(parseSlashCommand('/computer false'), { name: 'computer', mode: 'off' });
  assert.deepEqual(parseSlashCommand('/computer maybe'), { name: 'computer', mode: null, error: 'invalid_mode', value: 'maybe' });
  assert.equal(isKnownSlashCommand('computer'), true);
});

test('the new commands show up in the menu and help', () => {
  assert.deepEqual(matchSlashCommands('/ro').map(c => c.name), ['routes']);
  assert.deepEqual(matchSlashCommands('/co').map(c => c.name), ['computer', 'compact']);
  const help = slashHelpMarkdown();
  assert.ok(help.includes('/routes [always|unsure|never]'));
  assert.ok(help.includes('/computer [on|off]'));
});

test('/models opens the manager, lists, or hides / shows ids', () => {
  assert.deepEqual(parseSlashCommand('/models'), { name: 'models', action: 'open' });
  assert.deepEqual(parseSlashCommand('/models list'), { name: 'models', action: 'list' });
  assert.deepEqual(parseSlashCommand('/models hide claude-opus-4-8 claude-opus-5,gpt-5.5'), { name: 'models', action: 'hide', ids: ['claude-opus-4-8', 'claude-opus-5', 'gpt-5.5'] });
  assert.deepEqual(parseSlashCommand('/MODELS show "ollama-cloud/deepseek-v4-pro"'), { name: 'models', action: 'show', ids: ['ollama-cloud/deepseek-v4-pro'] });
  assert.deepEqual(parseSlashCommand('/models off gpt-5.5'), { name: 'models', action: 'hide', ids: ['gpt-5.5'] });
  assert.deepEqual(parseSlashCommand('/models hide'), { name: 'models', action: 'hide', error: 'missing_ids' });
  assert.deepEqual(parseSlashCommand('/models purge x'), { name: 'models', action: null, error: 'invalid_action', value: 'purge' });
  assert.equal(isKnownSlashCommand('models'), true);
});
