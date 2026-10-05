import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/index.js';
import { isBrowserV2Enabled } from '../src/services/neural-interface.js';

afterEach(() => { vi.unstubAllEnvs(); });

async function inspectCatalog(profile: string, catalogMode: 'profiled' | 'deferred') {
  const server = createMcpServer(profile, { catalogMode });
  const client = new Client({ name: 'browser-release-default-test', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return {
      tools: (await client.listTools()).tools.map(tool => tool.name),
      instructions: client.getInstructions(),
    };
  } finally {
    await client.close();
    await server.close();
  }
}

describe('browser release defaults', () => {
  it.each([
    { profile: 'browser', catalogMode: 'profiled' as const },
    { profile: 'twitter', catalogMode: 'profiled' as const },
    { profile: 'core', catalogMode: 'deferred' as const },
  ])('advertises batching without opt-in for $profile / $catalogMode', async ({ profile, catalogMode }) => {
    vi.stubEnv('SYNABUN_BROWSER_V2', undefined);
    expect(isBrowserV2Enabled()).toBe(true);
    const catalog = await inspectCatalog(profile, catalogMode);
    expect(catalog.tools).toContain('browser_batch');
    expect(catalog.tools).toContain('browser_navigate');
    if (profile !== 'core') expect(catalog.instructions).toContain('browser_batch');
  });

  it('continues to respect explicit legacy rollback', async () => {
    vi.stubEnv('SYNABUN_BROWSER_V2', '0');
    expect(isBrowserV2Enabled()).toBe(false);
    const catalog = await inspectCatalog('browser', 'profiled');
    expect(catalog.tools).toContain('browser_navigate');
    expect(catalog.tools).not.toContain('browser_batch');
    expect(catalog.instructions).not.toContain('browser_batch');
  });

  it('keeps browser tools out of a profiled core catalog', async () => {
    vi.stubEnv('SYNABUN_BROWSER_V2', undefined);
    const catalog = await inspectCatalog('core', 'profiled');
    expect(catalog.tools).not.toContain('browser_batch');
    expect(catalog.tools).not.toContain('browser_navigate');
  });
});
