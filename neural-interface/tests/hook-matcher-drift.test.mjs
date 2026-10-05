/**
 * Pins the matcher-drift repair in sweepSettingsHooks().
 *
 * The sweep used to short-circuit on `matching.length === 1 && hadCanonical`,
 * comparing only the command string. So changing a matcher in HOOK_SCRIPTS
 * updated fresh installs but never reached any already-installed settings.json
 * — the file kept the old matcher forever and silently ran a hook against the
 * wrong tool set. That is how post-remember.mjs ended up never seeing `reflect`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
import { HOOK_SCRIPTS, hookCommandString, isSynaBunHookCommand, sweepSettingsHooks as sweep } from '../../lib/claude-hooks.js';
const PACKAGE_ROOT = '/opt/synabun';
const deps = { HOOK_SCRIPTS };
const sweepSettingsHooks = (settings, target, stats) => sweep(settings, target, stats, PACKAGE_ROOT);

const POST_REMEMBER = deps.HOOK_SCRIPTS.find((d) => d.script === 'post-remember.mjs');
const CANONICAL_CMD = hookCommandString('post-remember.mjs', undefined);

function settingsWith(matcher) {
  return {
    env: { SYNABUN_HOOK_ROOT: PACKAGE_ROOT },
    hooks: {
      PostToolUse: [
        { matcher, hooks: [{ type: 'command', command: CANONICAL_CMD, timeout: POST_REMEMBER.timeout }] },
      ],
    },
  };
}

function freshStats() {
  return { files: 0, removed: 0, repaired: 0, matchers: 0 };
}

test('a stale matcher on an otherwise-canonical entry is repaired', () => {
  const settings = settingsWith('^Edit$|^Write$|^NotebookEdit$|Syna[Bb]un__remember');
  const stats = freshStats();

  const changed = sweepSettingsHooks(settings, undefined, stats);

  assert.equal(changed, true, 'a stale matcher should count as a change');
  assert.equal(stats.matchers, 1, 'the repair should be counted so startup can report it');
  assert.equal(stats.removed, 0, 'nothing was duplicated — only the matcher was wrong');

  const entry = settings.hooks.PostToolUse.find((e) =>
    e.hooks?.some((h) => h.command === CANONICAL_CMD));
  assert.equal(entry.matcher, POST_REMEMBER.matcher, 'matcher should now match HOOK_SCRIPTS');
});

test('the repair is idempotent — a second sweep is a no-op', () => {
  const settings = settingsWith('^Edit$|^Write$|^NotebookEdit$|Syna[Bb]un__remember');

  sweepSettingsHooks(settings, undefined, freshStats());

  const second = freshStats();
  const changed = sweepSettingsHooks(settings, undefined, second);

  assert.equal(changed, false, 'an already-canonical file must not be rewritten every boot');
  assert.equal(second.matchers, 0);
});

test('an already-correct matcher is left completely alone', () => {
  const settings = settingsWith(POST_REMEMBER.matcher);
  const stats = freshStats();

  assert.equal(sweepSettingsHooks(settings, undefined, stats), false);
  assert.deepEqual(stats, freshStats());
});

test('duplicate entries still collapse to one canonical entry', () => {
  const settings = {
    hooks: {
      PostToolUse: [
        { matcher: 'stale', hooks: [{ type: 'command', command: 'node hooks/claude-code/post-remember.mjs' }] },
        { matcher: POST_REMEMBER.matcher, hooks: [{ type: 'command', command: CANONICAL_CMD, timeout: 3 }] },
      ],
    },
  };
  const stats = freshStats();

  assert.equal(sweepSettingsHooks(settings, undefined, stats), true);
  assert.equal(stats.removed, 1, 'the relative-path duplicate should be dropped');

  const entries = settings.hooks.PostToolUse.filter((e) =>
    e.hooks?.some((h) => isSynaBunHookCommand(h.command, 'post-remember.mjs')));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].matcher, POST_REMEMBER.matcher);
});

test('hooks belonging to other tools are never touched', () => {
  const foreign = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /elsewhere/other-tool.mjs' }] };
  const settings = settingsWith('^Edit$|^Write$|^NotebookEdit$|Syna[Bb]un__remember');
  settings.hooks.PostToolUse.unshift(foreign);

  sweepSettingsHooks(settings, undefined, freshStats());

  assert.ok(
    settings.hooks.PostToolUse.some((e) => e.hooks?.[0]?.command === '/elsewhere/other-tool.mjs'
      || e.hooks?.[0]?.command === 'node /elsewhere/other-tool.mjs'),
    'a third-party hook entry must survive the sweep untouched',
  );
});
