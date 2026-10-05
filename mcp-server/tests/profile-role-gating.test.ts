import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
// The HTTP transport warms the embedding model on first init; keep the test hermetic.
vi.mock('../src/services/local-embeddings.js', () => ({
  EMBEDDING_MODEL: 'test-model',
  EMBEDDING_DIMENSIONS: 3,
  EMBEDDING_VERSION: 'test:3',
  generateEmbedding: async () => [1, 0, 0],
  generateEmbeddingBatch: async (texts: string[]) => texts.map(() => [1, 0, 0]),
  embedPassages: async () => [],
  warmupEmbeddings: async () => {},
  installEmbeddingModel: async () => {},
  closeEmbeddings: async () => {},
}));
import { PROFILE_PRESETS, ProfileRuntime, ROLE_GATED_GROUPS, VALID_GROUPS, isRoleGatedGroup } from '../src/services/profiles.js';
import { createMcpServer, setServerRole } from '../src/index.js';
import { AGENT_ROLE_DENIED, AGENT_TOOL_NAMES } from '../src/tools/agents.js';
import { closeDatabase } from '../src/services/sqlite.js';

const fakeTool = (enabled = true) => ({ enabled } as RegisteredTool);
const allEnabled = (tools: RegisteredTool[]) => tools.every(tool => tool.enabled);
function runtimeWithGroups(profile: string, options: { catalogMode?: 'profiled' | 'deferred'; role?: 'assistant' | null } = {}) {
  const runtime = new ProfileRuntime(profile, { catalogMode: 'profiled', ...options });
  const agents = [fakeTool(), fakeTool()];
  const git = fakeTool();
  const browser = fakeTool();
  runtime.setToolGroup('agents', agents);
  runtime.setToolGroup('git', [git]);
  runtime.setToolGroup('browser', [browser]);
  return { runtime, agents, git, browser };
}
const ALWAYS_ON = 11;

const toolNames = async (client: Client) => (await client.listTools()).tools.map(tool => tool.name);
const agentNames = (names: string[]) => names.filter(name => name.startsWith('agent_'));
const firstText = (result: { content?: unknown }) => ((result.content as Array<{ text?: string }>) || [])[0]?.text ?? '';

beforeEach(() => {
  vi.stubEnv('SYNABUN_ROLE', '');
  vi.stubEnv('SYNABUN_TERMINAL_SESSION', '');
  vi.stubEnv('SYNABUN_RUNTIME_PROFILE_PATH', '');
});
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(() => closeDatabase());

describe('role-gated tool groups', () => {
  it('declares agents as a valid, role-gated group outside every preset', () => {
    expect(VALID_GROUPS.has('agents')).toBe(true);
    expect(ROLE_GATED_GROUPS).toEqual({ agents: 'assistant' });
    expect(isRoleGatedGroup('agents')).toBe(true);
    expect(isRoleGatedGroup('git')).toBe(false);
    expect(Object.values(PROFILE_PRESETS).some(groups => groups.includes('agents'))).toBe(false);
  });

  it('hides agents without a role even when the selection names it', () => {
    const { runtime, agents, git } = runtimeWithGroups('full');
    expect(runtime.getRole()).toBeNull();
    expect(runtime.getActiveGroups().has('agents')).toBe(false);
    runtime.applyProfile('full');
    expect(allEnabled(agents)).toBe(false);
    expect(git.enabled).toBe(true);

    const explicit = runtime.applyProfile('git,agents');
    expect(explicit.enabled).not.toContain('agents');
    expect(explicit.totalTools).toBe(ALWAYS_ON + 1);
    expect(allEnabled(agents)).toBe(false);
    expect(runtime.getActiveProfile()).toEqual({ profile: 'git,agents', activeGroups: ['git'] });
  });

  it('advertises agents once the assistant role is bound and keeps it across profile switches', () => {
    const { runtime, agents, git, browser } = runtimeWithGroups('full');
    runtime.applyProfile('full');
    runtime.setRole('assistant');
    const bound = runtime.applyProfile(runtime.getActiveProfileName());
    expect(bound).toMatchObject({ profile: 'full', changed: true, enabled: ['agents'], disabled: [] });
    expect(allEnabled(agents)).toBe(true);
    expect(runtime.getActiveGroups().has('agents')).toBe(true);

    const core = runtime.applyProfile('core');
    expect(core.disabled).toContain('browser');
    expect(core.disabled).not.toContain('agents');
    expect(core.totalTools).toBe(ALWAYS_ON + 1 + 2);
    expect(allEnabled(agents)).toBe(true);
    expect(browser.enabled).toBe(false);
    expect(git.enabled).toBe(true);

    runtime.applyProfile('leonardoai');
    expect(allEnabled(agents)).toBe(true);
    expect(git.enabled).toBe(false);

    runtime.setRole(null);
    const dropped = runtime.applyProfile(runtime.getActiveProfileName());
    expect(dropped).toMatchObject({ changed: true, enabled: [], disabled: ['agents'] });
    expect(allEnabled(agents)).toBe(false);
  });

  it('never leaks agents into a deferred Codex catalog without the role', () => {
    const { runtime, agents, git, browser } = runtimeWithGroups('core', { catalogMode: 'deferred' });
    const initial = runtime.applyProfile('core');
    expect(initial.totalTools).toBe(ALWAYS_ON + 1 + 1);
    expect(git.enabled).toBe(true);
    expect(browser.enabled).toBe(true);
    expect(allEnabled(agents)).toBe(false);

    runtime.setRole('assistant');
    const bound = runtime.applyProfile('core');
    expect(bound.totalTools).toBe(ALWAYS_ON + 1 + 1 + 2);
    expect(allEnabled(agents)).toBe(true);
  });

  it('reads SYNABUN_ROLE for stdio children and lets an explicit option override it', () => {
    vi.stubEnv('SYNABUN_ROLE', 'assistant');
    const { runtime, agents } = runtimeWithGroups('core');
    expect(runtime.getRole()).toBe('assistant');
    expect(runtime.getActiveGroups().has('agents')).toBe(true);
    runtime.applyProfile('core');
    expect(allEnabled(agents)).toBe(true);

    expect(new ProfileRuntime('core', { catalogMode: 'profiled', role: null }).getRole()).toBeNull();
    vi.stubEnv('SYNABUN_ROLE', 'admin');
    expect(new ProfileRuntime('core', { catalogMode: 'profiled' }).getRole()).toBeNull();
  });
});

describe('agent_* advertisement on live MCP servers', () => {
  async function connect(server: ReturnType<typeof createMcpServer>, name: string) {
    const client = new Client({ name, version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  }

  it('lists agent_* only for assistant-role servers and survives profile set', async () => {
    const plain = createMcpServer('full', { catalogMode: 'profiled' });
    const bound = createMcpServer('full', { catalogMode: 'profiled' });
    expect(setServerRole(bound, 'assistant')).toBe(true);
    const constructed = createMcpServer('core', { catalogMode: 'profiled', role: 'assistant' });
    const clients = await Promise.all([connect(plain, 'plain'), connect(bound, 'bound'), connect(constructed, 'constructed')]);
    const [plainClient, boundClient, constructedClient] = clients;
    try {
      expect(agentNames(await toolNames(plainClient))).toEqual([]);
      expect(plainClient.getInstructions()).not.toContain('- Agents:');

      expect(agentNames(await toolNames(boundClient))).toEqual([...AGENT_TOOL_NAMES]);
      expect(boundClient.getInstructions()).toContain('- Agents: agent_route');

      const switched = JSON.parse(firstText(await boundClient.callTool({ name: 'profile', arguments: { action: 'set', profile: 'core' } })));
      expect(switched.profile).toBe('core');
      expect(switched.disabled).not.toContain('agents');
      const afterSwitch = await toolNames(boundClient);
      expect(afterSwitch).not.toContain('browser_navigate');
      expect(agentNames(afterSwitch)).toEqual([...AGENT_TOOL_NAMES]);
      const inspected = JSON.parse(firstText(await boundClient.callTool({ name: 'profile', arguments: { action: 'get' } })));
      expect(inspected).toMatchObject({ currentProfile: 'core', role: 'assistant' });
      expect(inspected.activeGroups).toContain('agents');

      // Being listed is not enough: the caller of each call must hold the role
      // (this in-memory client has neither an identity header nor SYNABUN_ROLE).
      expect(firstText(await boundClient.callTool({ name: 'agent_catalog', arguments: {} }))).toBe(AGENT_ROLE_DENIED);

      const constructedNames = await toolNames(constructedClient);
      expect(agentNames(constructedNames)).toEqual([...AGENT_TOOL_NAMES]);
      expect(constructedNames).not.toContain('browser_navigate');
      expect(constructedClient.getInstructions()).toContain('- Agents: agent_route');
    } finally {
      await Promise.all(clients.map(client => client.close()));
      await Promise.all([plain, bound, constructed].map(server => server.close()));
    }
  });
});

describe('HTTP transport role binding', () => {
  it('advertises agent_* to a session whose initialize carries X-Synabun-Role: assistant', async () => {
    const { createMcpRoutes } = await import('../src/http.js');
    const app = express();
    app.use('/mcp', createMcpRoutes());
    const httpServer = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const url = new URL(`http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`);
    const connectWith = async (headers: Record<string, string>) => {
      const client = new Client({ name: 'http-role-test', version: '1.0.0' }, { capabilities: {} });
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
      return client;
    };
    const assistant = await connectWith({ 'X-Synabun-Role': 'assistant', 'X-Synabun-Terminal': 'assistant-role-test' });
    const worker = await connectWith({ 'X-Synabun-Terminal': 'run-role-test' });
    const cli = await connectWith({});
    try {
      expect(agentNames(await toolNames(assistant))).toEqual([...AGENT_TOOL_NAMES]);
      expect(assistant.getInstructions()).toContain('- Agents: agent_route');
      expect(agentNames(await toolNames(worker))).toEqual([]);
      expect(worker.getInstructions()).not.toContain('- Agents:');
      expect(agentNames(await toolNames(cli))).toEqual([]);
    } finally {
      await Promise.all([assistant, worker, cli].map(client => client.close()));
      httpServer.closeAllConnections?.();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  }, 30_000);
});
