import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function resolveConfig({ root, projectDir, profile }) {
  const xdgRoot = resolve(root, `xdg-${profile}`);
  const configDir = resolve(xdgRoot, 'opencode');
  const runtimeProfilePath = resolve(xdgRoot, 'synabun-runtime-profile.json');
  mkdirSync(configDir, { recursive: true });
  const entry = {
    type: 'local',
    command: ['node', 'server.js'],
    enabled: true,
    environment: {
      SYNABUN_PROFILE: profile,
      SYNABUN_RUNTIME_PROFILE_PATH: runtimeProfilePath,
      SYNABUN_TERMINAL_SESSION: `runtime-${profile}`,
    },
  };
  entry.env = { ...entry.environment };
  writeFileSync(resolve(configDir, 'config.json'), JSON.stringify({
    mcp: { SynaBun: { ...entry, environment: { ...entry.environment, SYNABUN_PROFILE: 'core' } } },
    permission: { SynaBun_profile: 'allow' },
  }), 'utf8');
  const overlay = {
    mcp: { SynaBun: entry },
    permission: { SynaBun_profile: 'allow' },
  };
  const { stdout } = await execFileAsync('opencode', ['--pure', 'debug', 'config'], {
    cwd: projectDir,
    env: {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: xdgRoot,
      XDG_DATA_HOME: resolve(root, `data-${profile}`),
      XDG_CACHE_HOME: resolve(root, `cache-${profile}`),
      XDG_STATE_HOME: resolve(root, `state-${profile}`),
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_CONFIG_CONTENT: JSON.stringify(overlay),
    },
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

test('final OpenCode overlays keep concurrent runtime profiles ahead of project config', async (t) => {
  try {
    await execFileAsync('opencode', ['--version']);
  } catch {
    t.skip('OpenCode CLI is not installed');
    return;
  }

  const root = mkdtempSync(resolve(tmpdir(), 'synabun-opencode-overlay-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectDir = resolve(root, 'project');
  mkdirSync(projectDir, { recursive: true });
  // Project config is intentionally hostile to the managed fields. The final
  // per-runtime overlay must win without disabling project config globally.
  writeFileSync(resolve(projectDir, 'opencode.json'), JSON.stringify({
    mcp: {
      SynaBun: {
        type: 'local',
        command: ['node', 'wrong-server.js'],
        environment: {
          SYNABUN_PROFILE: 'full',
          SYNABUN_TERMINAL_SESSION: 'project-global',
        },
      },
    },
    permission: { SynaBun_profile: 'deny' },
  }), 'utf8');

  const [twitter, facebook] = await Promise.all([
    resolveConfig({ root, projectDir, profile: 'twitter' }),
    resolveConfig({ root, projectDir, profile: 'facebook' }),
  ]);
  for (const [profile, config] of [['twitter', twitter], ['facebook', facebook]]) {
    const entry = config?.mcp?.SynaBun;
    const env = entry?.environment || entry?.env || {};
    assert.equal(env.SYNABUN_PROFILE, profile);
    assert.equal(env.SYNABUN_TERMINAL_SESSION, `runtime-${profile}`);
    assert.match(env.SYNABUN_RUNTIME_PROFILE_PATH, new RegExp(`xdg-${profile}`));
    assert.deepEqual(entry.command, ['node', 'server.js']);
    assert.equal(config?.permission?.SynaBun_profile, 'allow');
  }
});
