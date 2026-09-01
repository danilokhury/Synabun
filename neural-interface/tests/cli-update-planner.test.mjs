import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BREW_FALLBACK_TOKENS,
  NPM_PKGS,
  brewTokenFromPath,
  buildInstallCommand,
  buildUpdateCommand,
  detectInstallSource,
  isBrewSource,
  parseBrewOutdated,
  resolveBrewToken,
  resolveLatest,
} from '../lib/cli-update-planner.js';

const TOOLS = ['claude-code', 'codex', 'opencode', 'gemini'];

// ── Install-source detection ──

test('classifies the real Homebrew paths on a cask + formula machine', () => {
  // Verified against an actual brew install: claude-code and codex ship as
  // casks, opencode as a formula from a third-party tap.
  assert.equal(detectInstallSource('/opt/homebrew/Caskroom/claude-code/2.1.224/claude'), 'brew-cask');
  assert.equal(detectInstallSource('/opt/homebrew/Caskroom/codex/0.147.0/bin/codex'), 'brew-cask');
  assert.equal(detectInstallSource('/opt/homebrew/Cellar/opencode/1.18.18/bin/opencode'), 'brew-formula');
  assert.equal(detectInstallSource('/usr/local/Cellar/gemini-cli/0.46.0/bin/gemini'), 'brew-formula');
  assert.equal(detectInstallSource('/home/linuxbrew/.linuxbrew/bin/codex'), 'brew-formula');
});

test('Caskroom wins over the generic /opt/homebrew/ rule', () => {
  // A cask path contains BOTH markers. If the generic rule ran first every
  // cask would be treated as a formula and get `brew upgrade` without --cask.
  const p = '/opt/homebrew/Caskroom/codex/0.147.0/bin/codex';
  assert.ok(p.includes('/opt/homebrew/') && p.includes('/Caskroom/'));
  assert.equal(detectInstallSource(p), 'brew-cask');
});

test('REGRESSION: bun/pnpm/yarn globals are not misread as npm', () => {
  // Every alternative JS package manager stores globals under node_modules.
  // The old implementation tested /node_modules/ first, so these all came
  // back as "npm" and were handed `npm install -g`, which writes to a
  // different prefix than the binary actually on PATH.
  assert.equal(
    detectInstallSource('/Users/x/.bun/install/global/node_modules/@openai/codex/bin/codex'),
    'bun',
  );
  assert.equal(
    detectInstallSource('/Users/x/Library/pnpm/global/5/node_modules/@openai/codex/bin/codex'),
    'pnpm',
  );
  assert.equal(
    detectInstallSource('/Users/x/.local/share/pnpm/global/5/node_modules/opencode-ai/bin/opencode'),
    'pnpm',
  );
  assert.equal(
    detectInstallSource('/Users/x/.yarn/bin/codex'),
    'yarn',
  );
  assert.equal(
    detectInstallSource('/Users/x/.volta/tools/image/packages/@openai/codex/bin/codex'),
    'volta',
  );
});

test('classifies tool-owned installers and plain npm globals', () => {
  assert.equal(detectInstallSource('/Users/x/.opencode/bin/opencode'), 'standalone');
  assert.equal(detectInstallSource('/Users/x/.claude/local/claude'), 'native');
  assert.equal(detectInstallSource('/Users/x/.local/bin/claude'), 'native');
  assert.equal(detectInstallSource('/usr/local/lib/node_modules/@openai/codex/bin/codex'), 'npm');
  assert.equal(detectInstallSource('/Users/x/.npm-global/lib/node_modules/opencode-ai/bin/opencode'), 'npm');
});

test('classifies Windows package managers', () => {
  assert.equal(detectInstallSource('C:\\Users\\x\\scoop\\shims\\codex.exe'), 'scoop');
  assert.equal(detectInstallSource('C:\\ProgramData\\chocolatey\\bin\\codex.exe'), 'choco');
  assert.equal(
    detectInstallSource('C:\\Users\\x\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe'),
    'winget',
  );
  assert.equal(detectInstallSource('C:\\Program Files\\AnthropicClaude\\claude.exe'), 'native');
});

test('unknown and unclassifiable paths are distinguished', () => {
  assert.equal(detectInstallSource(null), 'unknown');
  assert.equal(detectInstallSource(''), 'unknown');
  assert.equal(detectInstallSource('/some/random/place/codex'), 'other');
});

// ── Brew token derivation ──

test('derives the brew token from the install path, not a hardcoded map', () => {
  // This is what makes tap-installed formulae work: OpenCode ships from
  // anomalyco/tap at a different version than homebrew/core's opencode.
  assert.equal(brewTokenFromPath('/opt/homebrew/Caskroom/claude-code/2.1.224/claude'), 'claude-code');
  assert.equal(brewTokenFromPath('/opt/homebrew/Cellar/opencode/1.18.18/bin/opencode'), 'opencode');
  assert.equal(brewTokenFromPath('/usr/local/Cellar/gemini-cli/0.46.0/bin/gemini'), 'gemini-cli');
  assert.equal(brewTokenFromPath('/opt/homebrew/bin/codex'), null);
  assert.equal(brewTokenFromPath(null), null);
});

test('resolveBrewToken falls back to the per-tool default off-path', () => {
  assert.equal(resolveBrewToken('codex', '/opt/homebrew/Caskroom/codex/0.147.0/bin/codex'), 'codex');
  assert.equal(resolveBrewToken('gemini', '/opt/homebrew/bin/gemini'), 'gemini-cli');
  assert.equal(resolveBrewToken('claude-code', null), 'claude-code');
});

// ── Update commands ──

test('THE BUG: a brew install never gets a self-updater or an npm command', () => {
  // `claude update` / `opencode upgrade` cannot replace a brew-managed
  // binary — brew's symlink in /opt/homebrew/bin still wins PATH, so the
  // update silently does nothing and the badge never clears.
  for (const source of ['brew-cask', 'brew-formula']) {
    for (const tool of TOOLS) {
      const cmd = buildUpdateCommand(tool, source, { brewToken: 'tok' });
      assert.ok(cmd.startsWith('brew upgrade'), `${tool}/${source} => ${cmd}`);
      assert.doesNotMatch(cmd, /npm install|claude update|codex update|opencode upgrade/);
    }
  }
});

test('casks are upgraded with --cask, formulae without', () => {
  assert.equal(
    buildUpdateCommand('claude-code', 'brew-cask', { brewToken: 'claude-code' }),
    'brew upgrade --cask claude-code',
  );
  assert.equal(
    buildUpdateCommand('codex', 'brew-cask', { brewToken: 'codex' }),
    'brew upgrade --cask codex',
  );
  assert.equal(
    buildUpdateCommand('opencode', 'brew-formula', { brewToken: 'opencode' }),
    'brew upgrade opencode',
  );
});

test('package-manager installs get that manager, not the self-updater', () => {
  assert.equal(
    buildUpdateCommand('claude-code', 'npm'),
    'npm install -g @anthropic-ai/claude-code@latest',
  );
  assert.equal(buildUpdateCommand('codex', 'bun'), 'bun add -g @openai/codex@latest');
  assert.equal(buildUpdateCommand('codex', 'pnpm'), 'pnpm add -g @openai/codex@latest');
  assert.equal(buildUpdateCommand('codex', 'yarn'), 'yarn global add @openai/codex@latest');
  assert.equal(buildUpdateCommand('codex', 'volta'), 'volta install @openai/codex@latest');
});

test('self-updaters are used only where the tool owns its own install', () => {
  assert.equal(buildUpdateCommand('claude-code', 'native'), 'claude update');
  assert.equal(buildUpdateCommand('codex', 'native'), 'codex update');
  // codex update exists and was previously never reachable.
  assert.equal(buildUpdateCommand('codex', 'unknown'), 'codex update');
  assert.equal(buildUpdateCommand('claude-code', 'unknown'), 'claude update');
});

test('OpenCode is driven through its own --method for channels we cannot run', () => {
  // `opencode upgrade --method` accepts exactly curl|npm|pnpm|bun|brew|choco|scoop.
  assert.equal(buildUpdateCommand('opencode', 'standalone'), 'opencode upgrade --method curl');
  assert.equal(buildUpdateCommand('opencode', 'bun'), 'opencode upgrade --method bun');
  assert.equal(buildUpdateCommand('opencode', 'pnpm'), 'opencode upgrade --method pnpm');
  assert.equal(buildUpdateCommand('opencode', 'scoop'), 'opencode upgrade --method scoop');
  assert.equal(buildUpdateCommand('opencode', 'choco'), 'opencode upgrade --method choco');
  assert.equal(buildUpdateCommand('opencode', 'unknown'), 'opencode upgrade');
});

test('no automated path returns null so the caller can show a hint', () => {
  assert.equal(buildUpdateCommand('claude-code', 'winget'), null);
  assert.equal(buildUpdateCommand('codex', 'winget'), null);
  assert.equal(buildUpdateCommand('claude-code', 'scoop'), null);
  assert.equal(buildUpdateCommand('gemini', 'choco'), null);
});

test('gemini has no self-updater and falls back to npm', () => {
  assert.equal(buildUpdateCommand('gemini', 'unknown'), 'npm install -g @google/gemini-cli@latest');
  assert.equal(buildUpdateCommand('gemini', 'native'), null);
});

test('every tool has an npm package and a brew fallback token', () => {
  for (const tool of TOOLS) {
    assert.ok(NPM_PKGS[tool], `${tool} npm package`);
    assert.ok(BREW_FALLBACK_TOKENS[tool], `${tool} brew token`);
  }
});

// ── brew outdated parsing ──

const OUTDATED_FIXTURE = JSON.stringify({
  formulae: [
    { name: 'opencode', installed_versions: ['1.18.10'], current_version: '1.18.18' },
  ],
  casks: [
    { name: 'claude-code', installed_versions: ['2.1.200'], current_version: '2.1.224' },
  ],
});

test('parses brew outdated v2 for both formulae and casks', () => {
  const map = parseBrewOutdated(OUTDATED_FIXTURE);
  assert.equal(map.get('opencode'), '1.18.18');
  assert.equal(map.get('claude-code'), '2.1.224');
  assert.equal(map.get('codex'), undefined);
});

test('tap-qualified names are indexed under their bare token too', () => {
  const map = parseBrewOutdated({
    formulae: [{
      name: 'anomalyco/tap/opencode',
      full_name: 'anomalyco/tap/opencode',
      current_version: '1.19.0',
    }],
    casks: [],
  });
  assert.equal(map.get('opencode'), '1.19.0');
  assert.equal(map.get('anomalyco/tap/opencode'), '1.19.0');
});

test('parseBrewOutdated tolerates junk without throwing', () => {
  assert.equal(parseBrewOutdated(null), null);
  assert.equal(parseBrewOutdated(''), null);
  assert.equal(parseBrewOutdated('not json'), null);
  assert.equal(parseBrewOutdated({}).size, 0);
});

// ── Channel-aware latest ──

test('a brew tool absent from brew outdated is already current', () => {
  // The whole point: brew's claude-code cask sits at 2.1.224 while npm is at
  // 2.1.233. Comparing against npm produced a badge that lights up while
  // `brew upgrade` answers "already installed" — a permanently stuck badge.
  const latest = resolveLatest({
    installSource: 'brew-cask',
    brewToken: 'claude-code',
    brewOutdated: parseBrewOutdated({ formulae: [], casks: [] }),
    npmLatest: '2.1.233',
    installed: '2.1.224',
  });
  assert.equal(latest, '2.1.224');
});

test('a brew tool listed as outdated reports brew current_version', () => {
  const latest = resolveLatest({
    installSource: 'brew-cask',
    brewToken: 'claude-code',
    brewOutdated: parseBrewOutdated(OUTDATED_FIXTURE),
    npmLatest: '2.1.233',
    installed: '2.1.200',
  });
  assert.equal(latest, '2.1.224');
});

test('a failed brew probe fails CLOSED, never back to npm', () => {
  // Falling back to npm here would resurrect the stuck badge.
  const latest = resolveLatest({
    installSource: 'brew-formula',
    brewToken: 'opencode',
    brewOutdated: null,
    npmLatest: '99.0.0',
    installed: '1.18.18',
  });
  assert.equal(latest, '1.18.18');
});

test('non-brew installs still compare against npm', () => {
  assert.equal(resolveLatest({
    installSource: 'npm',
    brewOutdated: null,
    npmLatest: '2.1.233',
    installed: '2.1.224',
  }), '2.1.233');
  assert.equal(resolveLatest({
    installSource: 'bun',
    npmLatest: '0.148.0',
    installed: '0.147.0',
  }), '0.148.0');
});

test('isBrewSource covers both brew flavours only', () => {
  assert.ok(isBrewSource('brew-cask'));
  assert.ok(isBrewSource('brew-formula'));
  assert.ok(!isBrewSource('npm'));
  assert.ok(!isBrewSource('unknown'));
});

// ── Install commands ──

test('install command matches the channel the machine already uses', () => {
  assert.equal(buildInstallCommand('codex', 'brew-cask'), 'brew install --cask codex');
  assert.equal(buildInstallCommand('opencode', 'brew-formula'), 'brew install opencode');
  assert.equal(buildInstallCommand('codex', 'bun'), 'bun add -g @openai/codex');
  assert.equal(buildInstallCommand('codex', 'unknown'), 'npm install -g @openai/codex');
});

test('brew install uses each package OWN cask/formula flavour', () => {
  // The source passed here is inferred from sibling tools when the target is
  // not installed, so it can disagree with reality. gemini-cli exists only as
  // a formula and claude-code only as a cask — `brew install --cask
  // gemini-cli` just errors with "Cask 'gemini-cli' is unavailable".
  assert.equal(buildInstallCommand('gemini', 'brew-cask'), 'brew install gemini-cli');
  assert.equal(buildInstallCommand('gemini', 'brew-formula'), 'brew install gemini-cli');
  assert.equal(buildInstallCommand('opencode', 'brew-cask'), 'brew install opencode');
  assert.equal(buildInstallCommand('claude-code', 'brew-formula'), 'brew install --cask claude-code');
  assert.equal(buildInstallCommand('codex', 'brew-formula'), 'brew install --cask codex');
});
