// Claude Code, Codex, OpenCode and Gemini CLI are installed by the user and are
// never part of SynaBun: not in a lockfile, not in an installed tree, not in a
// packaged application. These tests hold that line at each of the three places
// (lib/external-tools.js), with the real lockfiles and with trees made here.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import {
  EXTERNAL_TOOLS, externalToolOf, externalToolPayloadReason, externalToolsInLock, externalToolsInstalledIn,
  packageNameOfLockPath, pruneExternalTools, stripExternalToolsFromLock,
} from '../../lib/external-tools.js';
import { evaluateTarget, nativeRequirements, readLocks } from '../lib/preflight.mjs';
import { excludeExternalTools, prepareStagedLocks } from '../lib/stage.mjs';
import { REPO_ROOT, TARGETS } from '../lib/targets.mjs';
import { BuildError } from '../lib/util.mjs';
import { auditBundle, smokeEnv } from '../lib/verify.mjs';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'synabun-external-')));
after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }));

const put = (file, text = '') => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); return file; };
const pkg = (root, name, extra = {}) => put(join(root, ...name.split('/'), 'package.json'), JSON.stringify({ name, version: '1.0.0', ...extra }));
// The header of a Mach-O arm64 executable: enough for the builder to read the file as native.
const MACHO_ARM64 = Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01, 0, 0, 0, 0, 2, 0, 0, 0]), Buffer.alloc(112)]);

test('the tools are told from the SDKs that talk to them', () => {
  const tool = (name) => externalToolOf(name)?.id || null;
  // The programs themselves, and the per-platform packages that carry their executables.
  assert.equal(tool('@anthropic-ai/claude-code'), 'claude-code');
  assert.equal(tool('@anthropic-ai/claude-code-darwin-arm64'), 'claude-code');
  for (const platform of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-x64-musl', 'linux-arm64', 'win32-x64', 'win32-arm64']) {
    assert.equal(tool(`@anthropic-ai/claude-agent-sdk-${platform}`), 'claude-code', platform);
  }
  assert.equal(tool('@openai/codex'), 'codex');
  for (const platform of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64']) assert.equal(tool(`@openai/codex-${platform}`), 'codex', platform);
  assert.equal(tool('opencode-ai'), 'opencode');
  assert.equal(tool('opencode-darwin-arm64'), 'opencode');
  assert.equal(tool('opencode-windows-x64-baseline'), 'opencode');
  assert.equal(tool('@google/gemini-cli'), 'gemini');
  // The JavaScript clients, and everything else, stay.
  for (const name of ['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/sdk', '@openai/codex-sdk', '@opencode-ai/sdk', 'node-pty', 'onnxruntime-node', 'playwright', 'opencode', 'codex', '']) {
    assert.equal(tool(name), null, name);
  }
  assert.deepEqual(EXTERNAL_TOOLS.map(item => item.command), ['claude', 'codex', 'opencode', 'gemini']);
  assert.equal(packageNameOfLockPath('node_modules/a/node_modules/@openai/codex'), '@openai/codex');
  assert.equal(packageNameOfLockPath(''), '');
});

test('staged application lockfiles exclude tools while source locks remain unchanged', () => {
  const app = join(scratch, 'actual-stage-locks');
  const original = new Map();
  for (const folder of ['neural-interface', 'mcp-server']) {
    const source = join(REPO_ROOT, folder, 'package-lock.json');
    original.set(source, readFileSync(source, 'utf8'));
    put(join(app, folder, 'package-lock.json'), original.get(source));
  }
  prepareStagedLocks({ app, report: {} });
  for (const [file, bytes] of original) assert.equal(readFileSync(file, 'utf8'), bytes);
  for (const folder of ['neural-interface', 'mcp-server']) {
    const lock = JSON.parse(readFileSync(join(app, folder, 'package-lock.json'), 'utf8'));
    const found = externalToolsInLock(lock);
    assert.deepEqual(found.packages.map(item => item.path), [], `${folder}/package-lock.json names an external tool: run node scripts/strip-external-tools.mjs`);
    assert.deepEqual(found.edges.map(edge => `${edge.from} -> ${edge.name}`), [], `${folder}/package-lock.json would make npm fetch one: run node scripts/strip-external-tools.mjs`);
  }
  // What talks to them is still installed, at the versions the manifest names.
  const neural = JSON.parse(readFileSync(join(REPO_ROOT, 'neural-interface', 'package-lock.json'), 'utf8')).packages;
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'neural-interface', 'package.json'), 'utf8'));
  for (const sdk of ['@anthropic-ai/claude-agent-sdk', '@openai/codex-sdk', '@opencode-ai/sdk']) {
    assert.ok(manifest.dependencies[sdk], `${sdk} is a dependency`);
    assert.ok(neural[`node_modules/${sdk}`]?.version, `${sdk} is locked`);
  }
  // And neither manifest asks for a tool itself.
  for (const folder of ['.', 'neural-interface', 'mcp-server']) {
    const file = JSON.parse(readFileSync(join(REPO_ROOT, folder, 'package.json'), 'utf8'));
    for (const field of ['dependencies', 'optionalDependencies', 'devDependencies', 'peerDependencies']) {
      for (const name of Object.keys(file[field] || {})) assert.equal(externalToolOf(name), null, `${folder}/package.json ${field} names ${name}`);
    }
  }
  // The module the installed application reads the rule from is part of the npm package.
  assert.ok(JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).files.includes('lib/external-tools.js'));
});

test('a lockfile npm resolved again is stripped of the tools and of nothing else', () => {
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { name: 'app', dependencies: { '@anthropic-ai/claude-agent-sdk': '0.3.288', '@openai/codex-sdk': '^0.160.0' } },
      'node_modules/@anthropic-ai/claude-agent-sdk': {
        version: '0.3.288',
        optionalDependencies: { '@anthropic-ai/claude-agent-sdk-darwin-arm64': '0.3.288', '@anthropic-ai/claude-agent-sdk-win32-x64': '0.3.288' },
        peerDependencies: { zod: '^4.0.0' },
      },
      'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64': { version: '0.3.288', optional: true, os: ['darwin'], cpu: ['arm64'] },
      'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64': { version: '0.3.288', optional: true, os: ['win32'], cpu: ['x64'] },
      'node_modules/@openai/codex-sdk': { version: '0.160.0', dependencies: { '@openai/codex': '0.160.0' } },
      'node_modules/@openai/codex': { version: '0.160.0', bin: { codex: 'bin/codex.js' }, optionalDependencies: { '@openai/codex-linux-x64': 'npm:@openai/codex@0.160.0-linux-x64' } },
      'node_modules/@openai/codex-linux-x64': { name: '@openai/codex', version: '0.160.0-linux-x64', optional: true, os: ['linux'], cpu: ['x64'] },
      'node_modules/sharp': { version: '0.34.5', optionalDependencies: { '@img/sharp-linux-x64': '0.34.5' } },
      'node_modules/@img/sharp-linux-x64': { version: '0.34.5', optional: true, os: ['linux'], cpu: ['x64'] },
    },
  };
  const removed = stripExternalToolsFromLock(lock);
  assert.equal(removed.packages.length, 4);
  assert.deepEqual(removed.edges.map(edge => edge.name).sort(), ['@anthropic-ai/claude-agent-sdk-darwin-arm64', '@anthropic-ai/claude-agent-sdk-win32-x64', '@openai/codex']);
  assert.deepEqual(Object.keys(lock.packages), ['', 'node_modules/@anthropic-ai/claude-agent-sdk', 'node_modules/@openai/codex-sdk', 'node_modules/sharp', 'node_modules/@img/sharp-linux-x64']);
  // An emptied edge list is gone, a peer and another package's platform builds are untouched.
  assert.equal(lock.packages['node_modules/@anthropic-ai/claude-agent-sdk'].optionalDependencies, undefined);
  assert.deepEqual(lock.packages['node_modules/@anthropic-ai/claude-agent-sdk'].peerDependencies, { zod: '^4.0.0' });
  assert.equal(lock.packages['node_modules/@openai/codex-sdk'].dependencies, undefined);
  assert.deepEqual(lock.packages['node_modules/sharp'].optionalDependencies, { '@img/sharp-linux-x64': '0.34.5' });
  assert.deepEqual(stripExternalToolsFromLock(lock), { packages: [], edges: [] }, 'a second pass finds nothing');
});

function installedTree(name) {
  const modules = join(scratch, name, 'node_modules');
  pkg(modules, '@anthropic-ai/claude-agent-sdk');
  put(join(modules, '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs'), 'export {};');
  pkg(modules, '@anthropic-ai/claude-agent-sdk-darwin-arm64');
  put(join(modules, '@anthropic-ai', 'claude-agent-sdk-darwin-arm64', 'claude'), MACHO_ARM64);
  pkg(modules, '@openai/codex-sdk');
  pkg(modules, '@openai/codex', { bin: { codex: 'bin/codex.js' } });
  put(join(modules, '@openai', 'codex', 'bin', 'codex.js'), '#!/usr/bin/env node\n');
  pkg(modules, '@openai/codex-darwin-arm64');
  put(join(modules, '@openai', 'codex-darwin-arm64', 'vendor', 'aarch64-apple-darwin', 'bin', 'codex'), MACHO_ARM64);
  put(join(modules, '@openai', 'codex-darwin-arm64', 'vendor', 'aarch64-apple-darwin', 'codex-path', 'rg'), MACHO_ARM64);
  pkg(modules, '@opencode-ai/sdk');
  pkg(modules, 'node-pty');
  // A tool nested under another package, and one an older SynaBun depended on.
  pkg(join(modules, 'node-pty', 'node_modules'), 'opencode-ai');
  pkg(modules, '@anthropic-ai/claude-code');
  mkdirSync(join(modules, '.bin'), { recursive: true });
  symlinkSync('../@openai/codex/bin/codex.js', join(modules, '.bin', 'codex'));
  put(join(modules, '.bin', 'claude.cmd'), '@echo off\n');
  put(join(modules, '.bin', 'playwright'), '#!/usr/bin/env node\n');
  put(join(modules, '.package-lock.json'), JSON.stringify({
    packages: {
      'node_modules/@anthropic-ai/claude-agent-sdk': { version: '1.0.0', optionalDependencies: { '@anthropic-ai/claude-agent-sdk-darwin-arm64': '1.0.0' } },
      'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64': { version: '1.0.0' },
      'node_modules/@openai/codex-sdk': { version: '1.0.0', dependencies: { '@openai/codex': '1.0.0' } },
      'node_modules/@openai/codex': { version: '1.0.0' },
      'node_modules/node-pty': { version: '1.0.0' },
    },
  }, null, 2) + '\n');
  return modules;
}

test('an installed tree is cleared of the tools: packages, nested ones, commands, and npm\'s own record', () => {
  const modules = installedTree('prune');
  const before = externalToolsInstalledIn(modules);
  assert.deepEqual(before.map(item => `${item.kind} ${item.name}`).sort(), [
    'command claude.cmd', 'command codex',
    'package @anthropic-ai/claude-agent-sdk-darwin-arm64', 'package @anthropic-ai/claude-code',
    'package @openai/codex', 'package @openai/codex-darwin-arm64', 'package opencode-ai',
  ]);

  const logged = [];
  const result = pruneExternalTools(modules, { log: line => logged.push(line) });
  assert.equal(result.removed.length, 7);
  assert.deepEqual(result.failed, []);
  assert.equal(logged.length, 7);
  assert.deepEqual(externalToolsInstalledIn(modules), []);
  for (const gone of ['@anthropic-ai/claude-agent-sdk-darwin-arm64', '@anthropic-ai/claude-code', '@openai/codex', '@openai/codex-darwin-arm64', 'node-pty/node_modules/opencode-ai', '.bin/codex', '.bin/claude.cmd']) {
    assert.equal(existsSync(join(modules, ...gone.split('/'))), false, gone);
  }
  // The SDKs, SynaBun's own modules and other packages' commands are as they were.
  for (const kept of ['@anthropic-ai/claude-agent-sdk/sdk.mjs', '@openai/codex-sdk/package.json', '@opencode-ai/sdk/package.json', 'node-pty/package.json', '.bin/playwright']) {
    assert.equal(existsSync(join(modules, ...kept.split('/'))), true, kept);
  }
  const hidden = JSON.parse(readFileSync(join(modules, '.package-lock.json'), 'utf8'));
  assert.deepEqual(Object.keys(hidden.packages), ['node_modules/@anthropic-ai/claude-agent-sdk', 'node_modules/@openai/codex-sdk', 'node_modules/node-pty']);
  assert.deepEqual(externalToolsInLock(hidden), { packages: [], edges: [] });

  // A tree with nothing to remove is not written to: a packaged application is read-only.
  const mark = statSync(join(modules, '.package-lock.json')).mtimeMs;
  assert.deepEqual(pruneExternalTools(modules), { removed: [], failed: [] });
  assert.equal(statSync(join(modules, '.package-lock.json')).mtimeMs, mark);
  assert.deepEqual(pruneExternalTools(join(scratch, 'no such folder', 'node_modules')), { removed: [], failed: [] });
});

test('a file of a bundle is recognised as a tool\'s by where it is, or by what it is', () => {
  const reason = externalToolPayloadReason;
  assert.match(reason('SynaBun.app/Contents/Resources/app/neural-interface/node_modules/@openai/codex/bin/codex.js'), /package @openai\/codex \(Codex\)/);
  assert.match(reason('resources\\app\\neural-interface\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe'), /claude-agent-sdk-win32-x64 \(Claude Code\)/);
  assert.match(reason('usr/lib/synabun/app/neural-interface/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex-path/rg'), /codex-linux-x64 \(Codex\)/);
  assert.match(reason('app/neural-interface/node_modules/a/node_modules/opencode-linux-x64/bin/opencode'), /opencode-linux-x64 \(OpenCode\)/);
  assert.match(reason('app/neural-interface/node_modules/.bin/codex'), /Codex command \(codex\)/);
  assert.match(reason('app/neural-interface/node_modules/.bin/claude.cmd'), /Claude Code command \(claude\.cmd\)/);
  // The SDKs and the application's own files are not.
  for (const path of [
    'app/neural-interface/node_modules/@openai/codex-sdk/dist/index.js',
    'app/neural-interface/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
    'app/neural-interface/node_modules/@opencode-ai/sdk/dist/index.js',
    'app/neural-interface/node_modules/.bin/playwright',
    'app/hooks/claude-code/stop.mjs',
    'app/neural-interface/lib/codex-runtime-path.js',
    'runtime/bin/node',
  ]) assert.equal(reason(path), null, path);
  // Outside node_modules only a native executable by the tool's own name counts.
  assert.equal(reason('app/skills/codex'), null);
  assert.match(reason('app/vendor/codex', { native: true }), /the Codex executable/);
  assert.match(reason('app/tools/claude.exe', { native: true }), /the Claude Code executable/);
  assert.equal(reason('runtime/bin/node', { native: true }), null);
});

test('no target waits for, or is given, a build of Claude Code or Codex', () => {
  const locks = readLocks();
  for (const target of Object.values(TARGETS)) {
    const natives = nativeRequirements(target, { locks });
    for (const native of natives) {
      assert.equal(externalToolOf(native.package), null, `${target.id}: ${native.package}`);
      assert.equal(externalToolOf(native.provides || ''), null, `${target.id}: ${native.provides}`);
      assert.doesNotMatch(native.package, /claude|codex/);
    }
    assert.ok(natives.some(native => native.package === 'node-pty') && natives.some(native => native.package === 'onnxruntime-node'), 'SynaBun\'s own native modules are still required');
  }
  const mac = { platform: 'darwin', arch: 'arm64', libc: null, rosetta: true };
  for (const id of ['macos-arm64', 'macos-x64']) assert.equal(evaluateTarget(TARGETS[id], { host: mac, tools: [] }).status, 'ready');
  for (const id of ['linux-x64', 'windows-x64']) assert.equal(evaluateTarget(TARGETS[id], { host: mac, tools: [], cross: true }).status, 'ready');
});

test('staging removes a tool npm installed anyway and says so in the build report', () => {
  const app = join(scratch, 'stage', 'app');
  for (const folder of ['mcp-server', 'neural-interface']) {
    put(join(app, folder, 'package-lock.json'), JSON.stringify({ packages: { '': {} } }));
    mkdirSync(join(app, folder, 'node_modules'), { recursive: true });
  }
  // A lockfile somebody regenerated, and what npm made of it.
  put(join(app, 'neural-interface', 'package-lock.json'), JSON.stringify({ packages: { '': {}, 'node_modules/@openai/codex': { version: '0.160.0' } } }));
  const modules = join(app, 'neural-interface', 'node_modules');
  pkg(modules, '@openai/codex');
  pkg(modules, '@openai/codex-sdk');
  put(join(modules, '.bin', 'codex'), '#!/usr/bin/env node\n');
  const ctx = { app, report: {} };
  excludeExternalTools(ctx);
  assert.deepEqual(ctx.report.externalTools.lockfileEntries, ['neural-interface/node_modules/@openai/codex']);
  assert.deepEqual(ctx.report.externalTools.removed.sort(), ['neural-interface/node_modules/.bin/codex', 'neural-interface/node_modules/@openai/codex']);
  assert.equal(existsSync(join(modules, '@openai', 'codex')), false);
  assert.equal(existsSync(join(modules, '@openai', 'codex-sdk', 'package.json')), true);

  // The ordinary case: nothing to remove, and the report says exactly that.
  const clean = { app, report: {} };
  put(join(app, 'neural-interface', 'package-lock.json'), JSON.stringify({ packages: { '': {} } }));
  excludeExternalTools(clean);
  assert.deepEqual(clean.report.externalTools, { lockfileEntries: [], removed: [] });
});

test('the audit refuses a bundle that carries a tool, in any of the forms one arrives in', async () => {
  const root = join(scratch, 'audit', 'SynaBun.app');
  const resources = join(root, 'Contents', 'Resources');
  const app = join(resources, 'app');
  const entry = join(root, 'Contents', 'MacOS', 'SynaBun');
  // The audit loads the application's own sweep from the bundle it reads.
  mkdirSync(join(app, 'neural-interface', 'lib'), { recursive: true });
  copyFileSync(join(REPO_ROOT, 'neural-interface', 'lib', 'native-binary-runtime.js'), join(app, 'neural-interface', 'lib', 'native-binary-runtime.js'));
  const modules = join(app, 'neural-interface', 'node_modules');
  pkg(modules, '@openai/codex-sdk');
  const ctx = () => ({ target: TARGETS['macos-arm64'], cross: false, verdict: { natives: [] }, bundle: { root, resources, entry }, report: {} });
  const problems = async () => {
    try { await auditBundle(ctx()); } catch (error) {
      assert.ok(error instanceof BuildError, error?.stack);
      return error.details.filter(line => /external tool/.test(line));
    }
    return assert.fail('this stand-in has none of the files a start needs: the audit must fail');
  };

  // Nothing of a tool: the audit fails for the files this stand-in lacks, and for nothing else.
  assert.deepEqual(await problems(), []);

  // 1. The package of a tool. 2. The Agent SDK's copy of the Claude Code executable.
  // 3. A command. 4. An executable outside any package. 5. What npm recorded.
  pkg(modules, '@openai/codex');
  put(join(modules, '@anthropic-ai', 'claude-agent-sdk-darwin-arm64', 'claude'), MACHO_ARM64);
  put(join(modules, '.bin', 'codex'), '#!/usr/bin/env node\n');
  put(join(app, 'vendor', 'opencode'), MACHO_ARM64);
  put(join(modules, '.package-lock.json'), JSON.stringify({ packages: {
    'node_modules/@openai/codex-sdk': { version: '1.0.0', dependencies: { '@openai/codex': '1.0.0' } },
    'node_modules/@openai/codex': { version: '1.0.0' },
  } }));
  const found = (await problems()).join('\n');
  assert.match(found, /external tool in the bundle: the package @openai\/codex \(Codex\)/);
  assert.match(found, /external tool in the bundle: the package @anthropic-ai\/claude-agent-sdk-darwin-arm64 \(Claude Code\)/);
  assert.match(found, /external tool in the bundle: the Codex command \(codex\)/);
  assert.match(found, /external tool in the bundle: the OpenCode executable \(.*app\/vendor\/opencode\)/);
  assert.match(found, /lockfile of the bundle: neural-interface\/node_modules\/\.package-lock\.json names node_modules\/@openai\/codex/);
  assert.match(found, /lockfile of the bundle: .* has node_modules\/@openai\/codex-sdk depend on @openai\/codex/);
  assert.doesNotMatch(found, /codex-sdk \(/, 'the SDK itself is not a tool');
});

test('a smoke run looks for the tools on the PATH it is given and nowhere else', async () => {
  const env = await smokeEnv(join(scratch, 'smoke-home'));
  assert.equal(env.SYNABUN_TOOL_DISCOVERY, 'path');
  assert.doesNotMatch(env.PATH, /homebrew|\.local|npm/i);
});
