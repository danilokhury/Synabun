import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/index.js';

async function connectedServer(name: string) {
  const server = createMcpServer('full', { catalogMode: 'profiled' });
  const client = new Client({ name, version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client };
}

describe('multiple MCP servers in one process', () => {
  it('switches only the server that handled profile.set', async () => {
    const inheritedRuntimeEnv = {
      terminal: process.env.SYNABUN_TERMINAL_SESSION,
      profilePath: process.env.SYNABUN_RUNTIME_PROFILE_PATH,
    };
    delete process.env.SYNABUN_TERMINAL_SESSION;
    delete process.env.SYNABUN_RUNTIME_PROFILE_PATH;
    const first = await connectedServer('profile-server-first');
    const second = await connectedServer('profile-server-second');
    try {
      const firstBefore = (await first.client.listTools()).tools.map((tool) => tool.name);
      const secondBefore = (await second.client.listTools()).tools.map((tool) => tool.name);
      expect(firstBefore).toContain('browser_navigate');
      expect(secondBefore).toContain('browser_navigate');

      const response = await first.client.callTool({
        name: 'profile',
        arguments: { action: 'set', profile: 'core' },
      });
      const output = JSON.parse(response.content[0]?.type === 'text' ? response.content[0].text : '{}');
      expect(output.profile).toBe('core');
      expect(output.hostRefresh).toBe('notification');
      expect(output.toolListNotification).toBe('scheduled');

      const firstAfter = (await first.client.listTools()).tools.map((tool) => tool.name);
      const secondAfter = (await second.client.listTools()).tools.map((tool) => tool.name);
      expect(firstAfter).not.toContain('browser_navigate');
      expect(secondAfter).toEqual(secondBefore);
    } finally {
      await first.client.close();
      await first.server.close();
      await second.client.close();
      await second.server.close();
      if (inheritedRuntimeEnv.terminal === undefined) delete process.env.SYNABUN_TERMINAL_SESSION;
      else process.env.SYNABUN_TERMINAL_SESSION = inheritedRuntimeEnv.terminal;
      if (inheritedRuntimeEnv.profilePath === undefined) delete process.env.SYNABUN_RUNTIME_PROFILE_PATH;
      else process.env.SYNABUN_RUNTIME_PROFILE_PATH = inheritedRuntimeEnv.profilePath;
    }
  });
});
