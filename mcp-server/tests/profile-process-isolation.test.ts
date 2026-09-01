import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type RpcResponse = { id?: number; method?: string; result?: any; error?: { message?: string } };

class McpProcess {
  private child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: RpcResponse) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private stderr = '';
  private notifications: string[] = [];

  constructor(
    profile: string,
    dataHome: string,
    envPath: string,
    runtimeProfilePath?: string,
    catalogMode?: 'profiled' | 'deferred',
  ) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DOTENV_PATH: envPath,
      SYNABUN_DATA_HOME: dataHome,
      MEMORY_DATA_DIR: join(dataHome, 'mcp-data'),
      SYNABUN_PROFILE: profile,
      SYNABUN_TOOL_CATALOG_MODE: catalogMode || 'profiled',
    };
    if (runtimeProfilePath) env.SYNABUN_RUNTIME_PROFILE_PATH = runtimeProfilePath;
    delete env.CLAUDECODE;
    this.child = spawn(process.execPath, [resolve(import.meta.dirname, '..', 'dist', 'preload.js')], {
      cwd: resolve(import.meta.dirname, '..'),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.consume(String(chunk)));
    this.child.stderr.on('data', (chunk) => { this.stderr += String(chunk); });
    this.child.on('error', (error) => this.rejectAll(error));
    this.child.on('exit', (code) => {
      if (this.pending.size) {
        this.rejectAll(new Error(`MCP process exited (${code}): ${this.stderr}`));
      }
    });
  }

  private consume(chunk: string) {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: RpcResponse;
      try { message = JSON.parse(line); } catch { continue; }
      if (typeof message.id !== 'number') {
        if (message.method) this.notifications.push(message.method);
        continue;
      }
      const entry = this.pending.get(message.id);
      if (!entry) continue;
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message || 'MCP request failed'));
      else entry.resolve(message);
    }
  }

  private rejectAll(error: Error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private request(method: string, params: Record<string, unknown> = {}) {
    const id = this.nextId++;
    return new Promise<RpcResponse>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`Timed out waiting for ${method}: ${this.stderr}`));
      }, 10_000);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async initialize() {
    await this.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'synabun-profile-isolation-test', version: '1.0.0' },
    });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }

  async toolNames(): Promise<string[]> {
    const response = await this.request('tools/list');
    return (response.result?.tools || []).map((tool: { name: string }) => tool.name);
  }

  async setProfile(profile: string) {
    return this.request('tools/call', { name: 'profile', arguments: { action: 'set', profile } });
  }

  notificationCount(method: string) {
    return this.notifications.filter((notification) => notification === method).length;
  }

  async waitForNotificationCount(method: string, count: number) {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      if (this.notificationCount(method) >= count) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    throw new Error(`Timed out waiting for ${count} ${method} notifications`);
  }

  async stop() {
    if (this.child.exitCode !== null) return;
    await new Promise<void>((resolveStop) => {
      const timer = setTimeout(() => {
        if (this.child.exitCode === null) this.child.kill('SIGKILL');
        resolveStop();
      }, 2_000);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolveStop();
      });
      if (!this.child.killed) this.child.kill('SIGTERM');
    });
  }
}

const running: McpProcess[] = [];

beforeAll(() => {
  const projectRoot = resolve(import.meta.dirname, '..');
  execFileSync(process.execPath, [resolve(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc')], {
    cwd: projectRoot,
    stdio: 'pipe',
  });
}, 120_000);

afterEach(async () => {
  await Promise.all(running.splice(0).map((process) => process.stop()));
});

describe('MCP profile process isolation', () => {
  it('keeps one running process unchanged when another process switches profile', async () => {
    const dataHome = mkdtempSync(join(tmpdir(), 'synabun-profile-isolation-'));
    const envPath = join(dataHome, '.env');
    mkdirSync(join(dataHome, 'mcp-data'), { recursive: true });
    const defaultProfilePath = join(dataHome, 'mcp-data', 'active-profile.json');
    writeFileSync(defaultProfilePath, JSON.stringify({ profile: 'standard' }, null, 2) + '\n', 'utf8');
    const defaultBefore = readFileSync(defaultProfilePath, 'utf8');
    // The explicit per-process values must also outrank this conflicting default.
    writeFileSync(envPath, 'SYNABUN_PROFILE=full\n', 'utf8');

    try {
      const facebookRuntimePath = join(dataHome, 'runtimes', 'facebook.json');
      const twitterRuntimePath = join(dataHome, 'runtimes', 'twitter.json');
      const facebook = new McpProcess('facebook', dataHome, envPath, facebookRuntimePath);
      const twitter = new McpProcess('twitter', dataHome, envPath, twitterRuntimePath);
      running.push(facebook, twitter);
      await Promise.all([facebook.initialize(), twitter.initialize()]);

      const [facebookBefore, twitterBefore] = await Promise.all([
        facebook.toolNames(),
        twitter.toolNames(),
      ]);
      expect(facebookBefore).toContain('fb_groups');
      expect(facebookBefore).not.toContain('browser_extract_tweets');
      expect(twitterBefore).toContain('browser_extract_tweets');
      expect(twitterBefore).not.toContain('fb_groups');

      // This changes only the Twitter runtime. The future-session default and
      // already-running Facebook process must remain untouched.
      const switchResponse = await twitter.setProfile('core');
      const switchOutput = switchResponse.result?.content?.[0]?.text || '';
      const switchResult = JSON.parse(switchOutput);
      expect(switchResult.hostRefresh).toBe('notification');
      expect(switchResult.toolListNotification).toBe('scheduled');
      // The initiating tools/call response must finish before list_changed;
      // otherwise OpenCode can abort the profile tool roundtrip itself.
      expect(twitter.notificationCount('notifications/tools/list_changed')).toBe(0);
      await twitter.waitForNotificationCount('notifications/tools/list_changed', 1);
      const [facebookAfter, twitterAfter] = await Promise.all([
        facebook.toolNames(),
        twitter.toolNames(),
      ]);
      expect(facebookAfter).toEqual(facebookBefore);
      expect(facebookAfter).toContain('fb_groups');
      expect(twitterAfter).not.toContain('browser_extract_tweets');
      expect(twitterAfter).not.toContain('fb_groups');
      expect(readFileSync(defaultProfilePath, 'utf8')).toBe(defaultBefore);
      expect(JSON.parse(readFileSync(twitterRuntimePath, 'utf8')).profile).toBe('core');
      expect(() => readFileSync(facebookRuntimePath, 'utf8')).toThrow();
      expect(twitter.notificationCount('notifications/tools/list_changed')).toBe(1);
      expect(facebook.notificationCount('notifications/tools/list_changed')).toBe(0);

      // Re-applying the effective profile is an explicit recovery request. It
      // must emit a fresh notification so a host that lost/staled the first
      // catalog update can heal without requiring a different profile first.
      await twitter.setProfile('core');
      await twitter.waitForNotificationCount('notifications/tools/list_changed', 2);
      expect(twitter.notificationCount('notifications/tools/list_changed')).toBe(2);

      // A replacement MCP child for the same isolated runtime must recover
      // the runtime-owned selection instead of its stale launch env/default.
      await twitter.stop();
      const restartedTwitter = new McpProcess('full', dataHome, envPath, twitterRuntimePath);
      running.push(restartedTwitter);
      await restartedTwitter.initialize();
      const restartedTools = await restartedTwitter.toolNames();
      expect(restartedTools).not.toContain('browser_extract_tweets');
      expect(restartedTools).not.toContain('fb_groups');
    } finally {
      await Promise.all(running.splice(0).map((process) => process.stop()));
      rmSync(dataHome, { recursive: true, force: true });
    }
  }, 20_000);

  it('keeps the profile router available under every representative preset', async () => {
    const dataHome = mkdtempSync(join(tmpdir(), 'synabun-profile-router-'));
    const envPath = join(dataHome, '.env');
    mkdirSync(join(dataHome, 'mcp-data'), { recursive: true });
    writeFileSync(envPath, '', 'utf8');
    try {
      const processes = ['core', 'standard', 'facebook', 'full']
        .map((profile) => new McpProcess(profile, dataHome, envPath));
      running.push(...processes);
      await Promise.all(processes.map((process) => process.initialize()));
      const lists = await Promise.all(processes.map((process) => process.toolNames()));
      for (const names of lists) expect(names).toContain('profile');
    } finally {
      await Promise.all(running.splice(0).map((process) => process.stop()));
      rmSync(dataHome, { recursive: true, force: true });
    }
  }, 20_000);

  it('advertises the full deferred catalog to Codex before any profile switch', async () => {
    const dataHome = mkdtempSync(join(tmpdir(), 'synabun-profile-deferred-'));
    const envPath = join(dataHome, '.env');
    mkdirSync(join(dataHome, 'mcp-data'), { recursive: true });
    writeFileSync(envPath, '', 'utf8');
    try {
      const process = new McpProcess('core', dataHome, envPath, undefined, 'deferred');
      running.push(process);
      await process.initialize();

      const before = await process.toolNames();
      expect(before).toContain('profile');
      expect(before).toContain('browser_session');
      expect(before).toContain('fb_groups');

      const response = await process.setProfile('codex-browser');
      const output = JSON.parse(response.result?.content?.[0]?.text || '{}');
      expect(output.catalogMode).toBe('deferred');
      expect(output.hostRefresh).toBe('not-needed');
      expect(output.toolListNotification).toBe('not-needed');
      expect(await process.toolNames()).toEqual(before);
      expect(process.notificationCount('notifications/tools/list_changed')).toBe(0);
    } finally {
      await Promise.all(running.splice(0).map((process) => process.stop()));
      rmSync(dataHome, { recursive: true, force: true });
    }
  }, 20_000);

  it('loads custom registry profiles and rejects invalid selections without changing tools', async () => {
    const dataHome = mkdtempSync(join(tmpdir(), 'synabun-profile-custom-'));
    const envPath = join(dataHome, '.env');
    mkdirSync(join(dataHome, 'mcp-data'), { recursive: true });
    mkdirSync(join(dataHome, 'data'), { recursive: true });
    writeFileSync(envPath, '', 'utf8');
    writeFileSync(join(dataHome, 'data', 'mcp-registry.json'), JSON.stringify({
      profiles: { 'lean-social': { groups: ['browser', 'browser_twitter'] } },
    }), 'utf8');
    try {
      const process = new McpProcess('lean-social', dataHome, envPath);
      running.push(process);
      await process.initialize();
      const before = await process.toolNames();
      expect(before).toContain('profile');
      expect(before).toContain('browser_extract_tweets');

      const response = await process.setProfile('not-a-real-profile');
      const output = response.result?.content?.[0]?.text || '';
      expect(output).toContain('Unknown MCP profile');
      expect(await process.toolNames()).toEqual(before);
      expect(process.notificationCount('notifications/tools/list_changed')).toBe(0);
    } finally {
      await Promise.all(running.splice(0).map((process) => process.stop()));
      rmSync(dataHome, { recursive: true, force: true });
    }
  }, 20_000);
});
