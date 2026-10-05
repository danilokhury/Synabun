import { afterEach, expect, it, vi } from 'vitest';
import { proposeStyleGuideChange } from '../src/services/neural-interface.js';
import { getIdentity, runWithIdentity } from '../src/services/identity.js';

afterEach(() => vi.unstubAllGlobals());

it('uses the request caller run id and preserves explicit proposal metadata', async () => {
  const requests: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ ok: true, id: 'prop-c1' }), { status: 200 });
  }));
  const caller = { ...getIdentity(), source: 'header' as const, pins: { terminalSessionId: 'run-c1', browserSessionId: null, browserTabId: null } };
  const body = { projectPath: '/project', changes: { brand: { name: 'Next' } }, reason: 'Name' };
  await runWithIdentity(caller, () => proposeStyleGuideChange(body));
  await runWithIdentity(caller, () => proposeStyleGuideChange({ ...body, runId: 'explicit', provider: 'codex', model: 'gpt-6' }));
  expect(requests).toEqual([{ runId: 'run-c1', ...body }, { ...body, runId: 'explicit', provider: 'codex', model: 'gpt-6' }]);
});
