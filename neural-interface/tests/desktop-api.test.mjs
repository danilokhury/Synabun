import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createDesktopApi } from '../lib/desktop/api.js';

function fakeDesktop() {
  const calls = [];
  return {
    calls,
    status: () => ({ ok: true, supported: true, setup: { state: 'ready' } }),
    setup: async (step, extra) => { calls.push(['setup', step, extra]); return { ok: true, setup: { state: 'compiling' } }; },
    stop: async (opts) => { calls.push(['stop', opts]); return { owner: null, latched: true, interrupted: [] }; },
    resume: () => { calls.push(['resume']); return { ok: true }; },
    frame: (id) => (id === 'f_1' ? { bytes: Buffer.from('jpeg-bytes'), mime: 'image/jpeg' } : null),
    recentAudit: () => [{ action: 'left_click' }],
    config: () => ({ enabled: true }),
    updateConfig: (patch) => { calls.push(['config', patch]); return { enabled: true, ...patch }; },
    act: async (token, body) => { calls.push(['act', token, body]); return token === 'bad' ? { ok: false, code: 'FORBIDDEN', forbidden: true } : { ok: true, code: 'OK', action: body.action }; },
    apps: async (token, body) => ({ ok: true, action: body.action }),
    ax: async (token, body) => ({ ok: true, action: body.action }),
    agentStatus: async () => ({ ok: true, action: 'status' }),
  };
}

async function startApp(t, { isGuestRequest = () => false } = {}) {
  const desktop = fakeDesktop();
  const app = express();
  app.use(express.json());
  app.use('/api/desktop', createDesktopApi({ desktop, isGuestRequest }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}/api/desktop`;
  const call = async (method, path, body, headers = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const type = response.headers.get('content-type') || '';
    return { status: response.status, json: type.includes('json') ? await response.json() : null, text: type.includes('json') ? null : await response.text(), headers: response.headers };
  };
  return { call, desktop };
}

test('guests and tunnel requests never reach computer use', async (t) => {
  const guest = await startApp(t, { isGuestRequest: () => true });
  assert.equal((await guest.call('GET', '/status')).status, 403);
  const { call } = await startApp(t);
  assert.equal((await call('GET', '/status', null, { 'cf-connecting-ip': '1.2.3.4' })).status, 403);
  assert.equal((await call('GET', '/status')).status, 200);
});

test('UI-only routes refuse agent headers; stop is allowed to everyone', async (t) => {
  const { call, desktop } = await startApp(t);
  assert.equal((await call('POST', '/setup', { step: 'start' }, { 'X-Synabun-Terminal': 'assistant-1' })).status, 403);
  assert.equal((await call('POST', '/resume', {}, { 'X-Synabun-Desktop-Grant': 'sbd_x' })).status, 403, 'an agent cannot resume after the user stopped it');
  assert.equal((await call('PUT', '/config', { userPauseMs: 1 }, { 'X-Synabun-Role': 'assistant' })).status, 403);
  assert.equal((await call('POST', '/setup', { step: 'open_settings', pane: 'accessibility' })).status, 200);
  assert.deepEqual(desktop.calls.find(([kind]) => kind === 'setup'), ['setup', 'open_settings', { pane: 'accessibility' }]);
  const stop = await call('POST', '/stop', { scope: 'all' }, { 'X-Synabun-Terminal': 'assistant-1' });
  assert.equal(stop.status, 200);
  assert.equal(desktop.calls.find(([kind]) => kind === 'stop')[1].reason, 'agent');
  assert.equal((await call('GET', '/audit')).json.entries.length, 1);
});

test('agent routes need a grant header; forbidden grants map to 403; frames are served as JPEG without caching', async (t) => {
  const { call, desktop } = await startApp(t);
  assert.equal((await call('POST', '/act', { action: 'screenshot' })).status, 403);
  const ok = await call('POST', '/act', { action: 'screenshot' }, { 'X-Synabun-Desktop-Grant': 'sbd_good' });
  assert.equal(ok.status, 200);
  assert.equal(desktop.calls.find(([kind]) => kind === 'act')[1], 'sbd_good');
  assert.equal((await call('POST', '/act', { action: 'screenshot' }, { 'X-Synabun-Desktop-Grant': 'bad' })).status, 403);
  assert.equal((await call('POST', '/apps', { action: 'list' }, { 'X-Synabun-Desktop-Grant': 'sbd_good' })).json.action, 'list');
  assert.equal((await call('POST', '/ax', { action: 'snapshot' }, { 'X-Synabun-Desktop-Grant': 'sbd_good' })).json.action, 'snapshot');
  assert.equal((await call('POST', '/agent-status', {}, { 'X-Synabun-Desktop-Grant': 'sbd_good' })).json.action, 'status');
  const frame = await call('GET', '/frames/f_1.jpg');
  assert.equal(frame.status, 200);
  assert.equal(frame.headers.get('content-type'), 'image/jpeg');
  assert.equal(frame.headers.get('cache-control'), 'no-store');
  assert.equal((await call('GET', '/frames/f_1/thumb.jpg')).status, 200);
  assert.equal((await call('GET', '/frames/f_404.jpg')).status, 404);
});
