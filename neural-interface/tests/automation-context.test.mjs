import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  automationContextOptions,
  automationModelOptions,
  normalizeAutomationSelection,
  resolveAutomationOverrides,
  validAutomationContextMode,
} from '../public/shared/automation-context.js';
import { mergeCodexModelOptions, modelSelectorValue } from '../public/shared/agent-runtime-options.js';
import { createCodexNativeLoopAdapter } from '../lib/native-loop-providers.js';
import { migrateAutomationContextFiles } from '../lib/automation-storage-migration.js';

test('Codex context metadata never becomes part of the model ID', () => {
  const [luna] = mergeCodexModelOptions([{
    id: 'gpt-6-luna', contextWindow: 272000, maxContextWindow: 872000,
  }], { fallback: false });
  assert.equal(modelSelectorValue(luna), 'gpt-6-luna');
  assert.deepEqual(normalizeAutomationSelection('codex', 'gpt-6-luna:272000'), {
    model: 'gpt-6-luna', contextMode: 'default',
  });
  assert.deepEqual(normalizeAutomationSelection('codex', 'gpt-6-luna', 'default'),
    normalizeAutomationSelection('codex', 'gpt-6-luna:272000'));
  assert.deepEqual(automationContextOptions('codex', luna.id, [luna]).map((option) => option.id),
    ['default', 'extended']);
  assert.deepEqual(automationContextOptions('codex', luna.id, [{ ...luna, maxContextWindow: null, supportsExtendedContext: false }]).map((option) => option.id),
    ['default']);
});

test('Claude legacy selectors become a base model plus an explicit context choice', () => {
  assert.deepEqual(normalizeAutomationSelection('claude-code', 'opus[1m]'), { model: 'opus', contextMode: '1m' });
  assert.deepEqual(normalizeAutomationSelection('claude-code', 'claude-sonnet-4-6:200000'), { model: 'claude-sonnet-4-6', contextMode: 'default' });
  const rows = [{ id: 'opus', contextWindow: 200000 }, { id: 'opus[1m]', contextWindow: 1000000 }];
  assert.deepEqual(automationModelOptions('claude-code', rows).map((row) => row.id), ['opus']);
  assert.deepEqual(automationContextOptions('claude-code', 'opus', rows).map((option) => option.id), ['default', '1m']);
  assert.deepEqual(automationContextOptions('claude-code', 'opus', [{ id: 'opus', resolvedModel: 'claude-opus-5-5', contextWindow: 200000 }]).map((option) => option.id), ['default', '1m'], 'the CLI may omit an explicit [1m] row');
  assert.deepEqual(automationContextOptions('claude-code', 'opus', [{ id: 'opus', resolvedModel: 'claude-opus-5-5', catalogSource: 'fallback' }]).map((option) => option.id), ['default'], 'fallback rows cannot assert 1M support');
  assert.deepEqual(automationContextOptions('claude-code', 'haiku', [{ id: 'haiku', resolvedModel: 'claude-haiku-4-5' }]).map((option) => option.id), ['default']);
  assert.equal(validAutomationContextMode('codex', '1m'), false);
});

test('schedule overrides preserve an explicit default above a group Extended choice', () => {
  const template = { profile: 'claude-code', model: 'sonnet', contextMode: '1m' };
  const group = { profile: 'codex', model: 'gpt-6-sol', contextMode: 'extended', codexAccountId: 'second' };
  const schedule = { model: 'gpt-6-luna', contextMode: 'default' };
  assert.deepEqual(resolveAutomationOverrides(schedule, group, template), {
    profile: 'codex', model: 'gpt-6-luna', contextMode: 'default', codexAccountId: 'second',
  });
  assert.equal(resolveAutomationOverrides({}, group, template).contextMode, 'extended');
  assert.equal(resolveAutomationOverrides({}, {}, template).contextMode, '1m');
});

test('legacy schedule files migrate once without changing timing or history', (t) => {
  const dir = mkdtempSync(resolve(tmpdir(), 'synabun-context-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const schedulePath = resolve(dir, 'loop-schedules.json');
  const templatePath = resolve(dir, 'loop-templates-custom.json');
  writeFileSync(schedulePath, JSON.stringify({
    groups: [{ id: 'blue', profile: 'codex', model: 'gpt-6-luna:272000', color: '#4fc3f7' }],
    schedules: [{ id: 'one', profile: 'codex', model: 'gpt-6-luna:272000', cron: '0 9 * * *', runCount: 14, lastRunResult: 'error: old failure' }],
  }));
  writeFileSync(templatePath, JSON.stringify([{ id: 'template', profile: 'claude-code', model: 'sonnet[1m]', task: 'Keep me' }]));
  assert.deepEqual(migrateAutomationContextFiles(dir), { files: 2, templates: 1, groups: 1, schedules: 1 });
  const schedules = JSON.parse(readFileSync(schedulePath, 'utf8'));
  const templates = JSON.parse(readFileSync(templatePath, 'utf8'));
  assert.deepEqual([schedules.groups[0].model, schedules.groups[0].contextMode], ['gpt-6-luna', 'default']);
  assert.deepEqual([schedules.schedules[0].model, schedules.schedules[0].contextMode], ['gpt-6-luna', 'default']);
  assert.equal(schedules.schedules[0].cron, '0 9 * * *');
  assert.equal(schedules.schedules[0].runCount, 14);
  assert.equal(schedules.schedules[0].lastRunResult, 'error: old failure');
  assert.deepEqual([templates[0].model, templates[0].contextMode], ['sonnet', '1m']);
  assert.deepEqual(migrateAutomationContextFiles(dir), { files: 0, templates: 0, groups: 0, schedules: 0 });
});

test('native Codex Extended passes the base model and runtime window separately', async () => {
  const seen = {};
  class FakeCodex {
    constructor(options) { seen.config = options.config; }
    startThread(options) {
      seen.thread = options;
      return { id: 'thread', async runStreamed() { return { events: (async function* () { yield { type: 'turn.completed' }; })() }; } };
    }
  }
  const adapter = await createCodexNativeLoopAdapter({
    model: 'gpt-6-luna', contextMode: 'extended', modelContextWindow: 872000, CodexClass: FakeCodex,
  });
  assert.equal(seen.thread.model, 'gpt-6-luna');
  assert.equal(seen.config.model_context_window, 872000);
  await adapter.runTurn('safe test');
});

test('structured Codex failure survives a later SDK exit error', async () => {
  class FailingCodex {
    startThread() {
      return { id: 'thread', async runStreamed() { return { events: (async function* () {
        yield { type: 'turn.failed', error: { message: JSON.stringify({ error: { message: 'The model is not supported' } }) } };
        throw new Error('Codex Exec exited with code 1: OAuth refresh warning');
      })() }; } };
    }
  }
  const adapter = await createCodexNativeLoopAdapter({ CodexClass: FailingCodex });
  await assert.rejects(adapter.runTurn('safe test'), /The model is not supported/);
});
