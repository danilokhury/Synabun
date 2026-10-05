import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
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
import { CAPABILITY_GATED_GROUPS, PROFILE_PRESETS, ProfileRuntime, ROLE_GATED_GROUPS, VALID_GROUPS, isGatedGroup } from '../src/services/profiles.js';
import { createMcpServer, setServerCapabilities } from '../src/index.js';
import { COMPUTER_TOOL_NAMES } from '../src/tools/computer.js';
import { closeDatabase } from '../src/services/sqlite.js';

const GRANT = `sbd_${'b'.repeat(43)}`;
const fakeTool = (enabled = true) => ({ enabled } as RegisteredTool);
function runtimeWith(options: ConstructorParameters<typeof ProfileRuntime>[1] = {}, profile = 'full') {
  const runtime = new ProfileRuntime(profile, { catalogMode: 'profiled', ...options });
  const computer = [fakeTool(), fakeTool(), fakeTool(), fakeTool()];
  runtime.setToolGroup('computer', computer);
  runtime.setToolGroup('git', [fakeTool()]);
  runtime.applyProfile(profile);
  return { runtime, computer };
}
const advertised = (tools: RegisteredTool[]) => tools.every((tool) => tool.enabled);
const hidden = (tools: RegisteredTool[]) => tools.every((tool) => !tool.enabled);

beforeEach(() => { vi.stubEnv('SYNABUN_DESKTOP_GRANT', ''); vi.stubEnv('SYNABUN_ROLE', ''); vi.stubEnv('SYNABUN_TERMINAL_SESSION', ''); vi.stubEnv('SYNABUN_RUNTIME_PROFILE_PATH', ''); });
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(() => closeDatabase());

describe('computer capability gate', () => {
  it('is a valid group, gated by capability (not role), outside every preset', () => {
    expect(VALID_GROUPS.has('computer')).toBe(true);
    expect(CAPABILITY_GATED_GROUPS).toEqual({ computer: 'computer' });
    expect(ROLE_GATED_GROUPS).toEqual({ agents: 'assistant' });
    expect(isGatedGroup('computer')).toBe(true);
    expect(Object.values(PROFILE_PRESETS).some((groups) => groups.includes('computer'))).toBe(false);
  });

  it('hides computer without a grant, even when a selection names it or the catalog is deferred', () => {
    expect(hidden(runtimeWith().computer)).toBe(true);
    expect(hidden(runtimeWith({}, 'computer,git').computer)).toBe(true);
    expect(hidden(runtimeWith({ catalogMode: 'deferred' }).computer)).toBe(true);
  });

  it('advertises computer to grant holders on macOS only, and survives profile switches', () => {
    const mac = runtimeWith({ capabilities: ['computer'], platform: 'darwin' });
    expect(advertised(mac.computer)).toBe(true);
    mac.runtime.applyProfile('core');
    // profile set cannot drop a capability group
    expect(advertised(mac.computer)).toBe(true);
    expect(hidden(runtimeWith({ capabilities: ['computer'], platform: 'linux' }).computer)).toBe(true);
  });

  it('stdio runtimes read the grant from their launch env', () => {
    vi.stubEnv('SYNABUN_DESKTOP_GRANT', GRANT);
    const runtime = new ProfileRuntime('full', { catalogMode: 'profiled', platform: 'darwin' });
    expect(runtime.getCapabilities()).toEqual(['computer']);
    vi.stubEnv('SYNABUN_DESKTOP_GRANT', 'junk');
    expect(new ProfileRuntime('full', { catalogMode: 'profiled', platform: 'darwin' }).getCapabilities()).toEqual([]);
  });

  it.runIf(process.platform === 'darwin')('a live server lists the computer tools only after setServerCapabilities', async () => {
    const server = createMcpServer('full');
    const client = new Client({ name: 'test', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const before = (await client.listTools()).tools.map((tool) => tool.name);
      expect(before.filter((name) => COMPUTER_TOOL_NAMES.includes(name as typeof COMPUTER_TOOL_NAMES[number]))).toEqual([]);
      expect(setServerCapabilities(server, { computer: true })).toBe(true);
      const after = (await client.listTools()).tools.map((tool) => tool.name);
      expect(after.filter((name) => COMPUTER_TOOL_NAMES.includes(name as typeof COMPUTER_TOOL_NAMES[number])).sort()).toEqual([...COMPUTER_TOOL_NAMES].sort());
      // Instructions are fixed at initialize (the HTTP transport binds capabilities before it).
      expect(client.getInstructions() || '').not.toContain('- Computer (macOS)');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
