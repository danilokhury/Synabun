import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { prepareStagedLocks, publicPackageSelection, stageApplication } from '../lib/stage.mjs';
import { isolatedEnv } from '../lib/util.mjs';

test('a native build excludes local instructions without editing or deleting the development source', t => {
  const root = mkdtempSync(join(tmpdir(), 'synabun-stage-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repoRoot = join(root, 'source');
  const work = join(root, 'stage');
  mkdirSync(repoRoot);
  mkdirSync(work);
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'stage-source-test', version: '1.0.0', files: ['setup.js', 'CLAUDE.md'] }));
  writeFileSync(join(repoRoot, 'setup.js'), 'export const ready = true;\n');
  const instructions = 'Private development instructions retained in the source.\n';
  writeFileSync(join(repoRoot, 'CLAUDE.md'), instructions);
  const nodeRoot = dirname(process.execPath);
  const npmCli = process.platform === 'win32' ? join(nodeRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js') : join(nodeRoot, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const ctx = { repoRoot, work, version: '1.0.0', report: {}, tool: { node: process.execPath, npmCli }, env: isolatedEnv({ home: join(root, 'home'), tmp: join(root, 'tmp'), npmCache: join(root, 'cache'), pathEntries: [nodeRoot] }) };
  stageApplication(ctx);
  assert.equal(readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8'), instructions);
  assert.equal(readFileSync(join(ctx.app, 'setup.js'), 'utf8'), 'export const ready = true;\n');
  assert.equal(existsSync(join(ctx.app, 'CLAUDE.md')), false);
  assert.deepEqual(ctx.report.sourceExclusions, [{ path: 'CLAUDE.md', reason: 'local agent instructions' }]);
});

test('unexpected private material still blocks staging and exclusions refuse the source itself', () => {
  const selection = publicPackageSelection(['setup.js', 'AGENTS.md', '.env.secret', 'data/private.db', 'id_ed25519']);
  assert.deepEqual(selection.excluded.map(item => item.path), ['AGENTS.md']);
  assert.deepEqual(selection.blocked.map(item => item.path), ['.env.secret', 'data/private.db', 'id_ed25519']);
  assert.throws(() => prepareStagedLocks({ repoRoot: '/source', work: '/stage', app: '/source', report: {} }), /never the source checkout/);
});
