import test from 'node:test';
import assert from 'node:assert/strict';
import { createClientInstance } from '../lib/opencode-v2-client.js';

test('OpenCode v2 MCP wrappers pass name and directory through to the SDK', async (t) => {
  const requests = [];
  const success = (data) => Promise.resolve({ data, response: { status: 200 } });
  const clientFactory = ({ baseUrl }) => ({
    baseUrl,
    mcp: {
      disconnect(params) { requests.push(['disconnect', params]); return success(true); },
      connect(params) { requests.push(['connect', params]); return success(true); },
      status(params) { requests.push(['status', params]); return success({}); },
    },
  });
  const client = createClientInstance({ port: 12345, clientFactory });
  t.after(() => client.stop());

  await client.mcp.disconnect({ name: 'SynaBun', directory: '/tmp/project' });
  await client.mcp.connect({ name: 'SynaBun', directory: '/tmp/project' });
  await client.mcp.status();

  assert.deepEqual(requests, [
    ['disconnect', { name: 'SynaBun', directory: '/tmp/project' }],
    ['connect', { name: 'SynaBun', directory: '/tmp/project' }],
    ['status', {}],
  ]);
});
