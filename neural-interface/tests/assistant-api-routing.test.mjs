import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import express from 'express';
import { createAssistantApi } from '../lib/assistant-api.js';
import { createAssistantConfigStore } from '../lib/assistant-config.js';
import { TASK_CLASS_META } from '../lib/assistant-router.js';
import { normalizeClaudeRows, normalizeCodexRows, parseOpenCodeProviders } from '../lib/assistant-catalog.js';
import { CLAUDE_MODELS, CODEX_MODELS, OPENCODE_FULL, PRICING } from './assistant-catalog.fixtures.mjs';

function fakeDispatcher() {
  const calls = [];
  return {
    calls, limits: {},
    async dispatch(spec, ctx) { calls.push(['dispatch', spec, ctx]); return { ok: true, queued: false, run: { runId: 'run-1', assistantSessionId: ctx.assistantSessionId } }; },
    get: () => null, list: () => [], totals: () => ({}),
    async killAll(args) { calls.push(['killAll', args]); return { ok: true, stopped: [] }; },
    async escalate(runId, opts) { calls.push(['escalate', runId, opts]); return { ok: true, queued: false, run: { runId: 'run-2', assistantSessionId: 'assistant-1' } }; },
  };
}

async function startApp(t, { router = null, configStore = null, runtime = null, catalog = null, dispatcherExtra = {}, isGuestRequest = () => false } = {}) {
  const dispatcher = Object.assign(fakeDispatcher(), dispatcherExtra);
  const broadcasts = [];
  const app = express();
  app.use(express.json());
  app.use('/api/assistant', createAssistantApi({ dispatcher, runtime, assistantRouter: router, configStore, catalog, taskClasses: TASK_CLASS_META, broadcastSync: (m) => broadcasts.push(m), isGuestRequest }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}/api/assistant`;
  const call = async (method, path, body, headers = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, json: await response.json() };
  };
  return { call, dispatcher, broadcasts, base };
}

test('an OpenCode brain pin (assistant-oc-*) never becomes the session id: the body names it', async (t) => {
  const runtime = { resolveTerminal: () => null, listSessions: () => [] };
  const { call, dispatcher } = await startApp(t, { runtime });
  const res = await call('POST', '/dispatch', { provider: 'codex', task: 'x', assistant_session_id: 'assistant-real', route_id: 'route-1', task_class: 'code', confidence: 0.8, uses_computer: true }, { 'X-Synabun-Terminal': 'assistant-oc-0123456789abcdef01234567' });
  assert.equal(res.status, 200);
  const [, spec, ctx] = dispatcher.calls[0];
  assert.equal(ctx.assistantSessionId, 'assistant-real');
  assert.equal(ctx.origin, 'assistant');
  assert.equal(spec.routeId, 'route-1');
  assert.equal(spec.taskClass, 'code');
  assert.equal(spec.confidence, 0.8);
  assert.equal(spec.usesComputer, true);
});

test('kill-all from an agent needs a scope; the UI may stop everything', async (t) => {
  const runtime = { resolveTerminal: () => null, listSessions: () => [] };
  const { call, dispatcher } = await startApp(t, { runtime });
  const refused = await call('POST', '/kill-all', {}, { 'X-Synabun-Terminal': 'codex-sp-abc' });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.code, 'SCOPE_REQUIRED');
  const scoped = await call('POST', '/kill-all', { assistant_session_id: 'assistant-1' }, { 'X-Synabun-Terminal': 'codex-sp-abc' });
  assert.equal(scoped.status, 200);
  const ui = await call('POST', '/kill-all', {});
  assert.equal(ui.status, 200);
  assert.deepEqual(dispatcher.calls.map(([kind, args]) => [kind, args.assistantSessionId]), [['killAll', 'assistant-1'], ['killAll', null]]);
});

test('routing settings: GET, UI-only PUT with version conflicts, preference delete, broadcast', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-api-routing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configStore = createAssistantConfigStore({ path: resolve(root, 'assistant-config.json') });
  const router = { routing: () => configStore.routing() };
  const { call, broadcasts } = await startApp(t, { router, configStore });
  const got = await call('GET', '/routing');
  assert.equal(got.status, 200);
  assert.equal(got.json.routing.defaultMode, 'ask-unsure');
  assert.equal(got.json.version, 0);
  assert.ok(got.json.taskClasses.some((row) => row.id === 'computer' && row.defaultKind === 'direct'));
  const agent = await call('PUT', '/routing', { routing: { defaultMode: 'never' } }, { 'X-Synabun-Terminal': 'assistant-x' });
  assert.equal(agent.status, 403);
  const put = await call('PUT', '/routing', { version: 0, routing: { defaultMode: 'never', preferences: { code: { kind: 'dispatch', provider: 'claude-code', model: 'sonnet' } } } });
  assert.equal(put.status, 200);
  assert.equal(put.json.routing.defaultMode, 'never');
  assert.equal(put.json.version, 1);
  assert.equal(broadcasts.at(-1).type, 'assistant:routing-changed');
  const stale = await call('PUT', '/routing', { version: 0, routing: { askBelow: 0.5 } });
  assert.equal(stale.status, 409);
  const invalid = await call('PUT', '/routing', { routing: { preferences: { bogus: null } } });
  assert.equal(invalid.status, 400);
  const deleted = await call('DELETE', '/routing/preferences/code');
  assert.equal(deleted.json.routing.preferences.code, undefined);
});

test('POST /route: approved → 200, pending → 202, the caller deadline caps the wait, session required', async (t) => {
  const seen = [];
  const router = {
    async propose(args) { seen.push(args); return args.body.summary === 'wait' ? { ok: true, status: 'pending', routeId: 'route-p' } : { ok: true, status: 'approved', routeId: 'route-a' }; },
    status: (id) => (id === 'route-a' ? { routeId: id, status: 'approved' } : null),
    async answer(id, response) { return { ok: true, status: 'approved', routeId: id, response }; },
    pendingCards: () => [{ request_id: 'route-p' }],
  };
  const runtime = { resolveTerminal: (pin) => (pin === 'assistant-1' ? 'assistant-1' : null), listSessions: () => [] };
  const { call } = await startApp(t, { router, runtime });
  const deadline = String(Date.now() + 30_000);
  const approved = await call('POST', '/route', { task_class: 'code', summary: 'go', confidence: 0.9, proposals: [{ kind: 'direct' }] }, { 'X-Synabun-Terminal': 'assistant-1', 'X-Synabun-Deadline': deadline });
  assert.equal(approved.status, 200);
  assert.equal(seen[0].sessionId, 'assistant-1');
  assert.ok(seen[0].waitMs <= 25_000 && seen[0].waitMs > 20_000, 'waits at most deadline − 5 s');
  const pending = await call('POST', '/route', { task_class: 'code', summary: 'wait', confidence: 0.2, proposals: [] }, { 'X-Synabun-Terminal': 'assistant-1' });
  assert.equal(pending.status, 202);
  const missing = await call('POST', '/route', { summary: 'x' }, { 'X-Synabun-Terminal': 'codex-sp-1' });
  assert.equal(missing.status, 400);
  assert.equal((await call('GET', '/routes/route-a')).json.route.status, 'approved');
  assert.equal((await call('GET', '/routes/nope')).status, 404);
  assert.equal((await call('POST', '/routes/route-p/answer', { optionId: 's1' }, { 'X-Synabun-Terminal': 'assistant-1' })).status, 403, 'only the user answers cards');
  assert.equal((await call('POST', '/routes/route-p/answer', { optionId: 's1' })).json.routeId, 'route-p');
  assert.deepEqual((await call('GET', '/sessions/assistant-1/routes')).json.cards, [{ request_id: 'route-p' }]);
});

test('escalate and brain-view catalog routes', async (t) => {
  const catalog = { get: async (opts) => ({ models: { opencode: [{ id: 'a/b' }] }, view: 'brain', opts }) };
  const { call, dispatcher } = await startApp(t, { catalog, runtime: { resolveTerminal: () => null, listSessions: () => [], noteDispatch() {} } });
  const brief = await call('GET', '/catalog?view=brain&provider=opencode&q=deep');
  assert.equal(brief.json.view, 'brain');
  assert.deepEqual(brief.json.opts.provider, 'opencode');
  assert.deepEqual(brief.json.opts.q, 'deep');
  const escalated = await call('POST', '/runs/run-1/escalate', { target: { provider: 'claude-code', model: 'opus' } });
  assert.equal(escalated.status, 200);
  assert.deepEqual(dispatcher.calls.at(-1), ['escalate', 'run-1', { target: { provider: 'claude-code', model: 'opus' } }]);
});

test('brain guard: a session cannot be created on, or switched to, a hidden model; unchanged fields still save', async (t) => {
  const { createAssistantRuntime } = await import('../lib/assistant-runtime.js');
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-api-brain-guard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hidden = { 'claude-code': ['claude-opus-5'], codex: ['gpt-5.5'] };
  const catalog = {
    hiddenId: (provider, model) => (hidden[provider] || []).find((id) => id === String(model).toLowerCase().replace(/\[1m\]$/, '')) || null,
    brainInfo: () => null, peek: () => null,
  };
  const runtime = createAssistantRuntime({
    dataDir: root, detectProject: () => 'proj', buildCatalog: async () => ({ models: {} }), catalog,
    brainFactories: { 'claude-code': () => ({}), codex: () => ({}), opencode: () => ({}) },
  });
  t.after(() => runtime.shutdown());
  const { call } = await startApp(t, { runtime });
  const refused = await call('POST', '/sessions', { brain: { provider: 'claude-code', model: 'claude-opus-5[1m]' } });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.code, 'MODEL_DISABLED');
  const created = await call('POST', '/sessions', { brain: { provider: 'claude-code', model: 'sonnet' } });
  assert.equal(created.status, 201);
  const id = created.json.session.id;
  const toCodex = await call('PATCH', `/sessions/${id}`, { brain: { provider: 'codex', model: 'gpt-5.5' } });
  assert.equal(toCodex.status, 400);
  assert.equal(toCodex.json.code, 'MODEL_DISABLED');
  assert.equal(runtime.getSession(id, { transcript: false }).brain.model, 'sonnet', 'the refused switch changed nothing');
  // A brain already on a model hidden later keeps it: other fields still save.
  hidden['claude-code'].push('sonnet');
  const effort = await call('PATCH', `/sessions/${id}`, { brain: { effort: 'high' } });
  assert.equal(effort.status, 200);
  assert.equal(effort.json.session.brain.model, 'sonnet');
  assert.equal(effort.json.session.brain.effort, 'high');
});

test('start fallback: a disabled model starts on its enabled stand-in; a null model or a provider switch never lands on a disabled default', async (t) => {
  const { createAssistantRuntime } = await import('../lib/assistant-runtime.js');
  const { createAssistantCatalog } = await import('../lib/assistant-catalog.js');
  const { CODEX_MODELS, PRICING, fakeFetch } = await import('./assistant-catalog.fixtures.mjs');
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-api-brain-fallback-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The live shape that locked the Assistant out: the base GPT-6 row (Codex's default) off, its extended window on.
  const codex = { ...CODEX_MODELS, models: CODEX_MODELS.models.map((m) => (m.id === 'gpt-6-astra' ? { ...m, maxContextWindow: 872000 } : m)) };
  const hidden = { 'claude-code': [], codex: ['gpt-6-astra'] };
  const catalog = createAssistantCatalog({ fetchJson: fakeFetch({ '/api/codex/models': codex }), claudePricing: PRICING, readHidden: () => hidden });
  const runtime = createAssistantRuntime({
    dataDir: root, detectProject: () => 'proj', buildCatalog: async () => ({ models: {} }), catalog,
    brainFactories: { 'claude-code': () => ({}), codex: () => ({}), opencode: () => ({}) },
  });
  t.after(() => runtime.shutdown());
  const { call } = await startApp(t, { runtime });

  const strict = await call('POST', '/sessions', { brain: { provider: 'codex', model: 'gpt-6-astra' } });
  assert.equal(strict.status, 400, 'API and agent callers stay strict');
  assert.equal(strict.json.code, 'MODEL_DISABLED');

  const started = await call('POST', '/sessions', { brain: { provider: 'codex', model: 'gpt-6-astra', effort: 'high' }, fallback: true });
  assert.equal(started.status, 201);
  assert.equal(started.json.session.brain.model, 'gpt-6-astra[extended]', 'the same model at its extended window');
  assert.equal(started.json.session.brain.effort, 'high');
  assert.deepEqual(started.json.session.fallback, { reason: 'model', from: 'gpt-6-astra', fromProvider: 'codex', to: 'gpt-6-astra[extended]', provider: 'codex', label: 'GPT-6-Astra (extended)' });
  assert.equal(runtime.getSession(started.json.session.id, { transcript: false }).fallback, undefined, 'the note is not stored');

  const enabled = await call('POST', '/sessions', { brain: { provider: 'codex', model: 'gpt-5.6-luna' }, fallback: true });
  assert.equal(enabled.json.session.brain.model, 'gpt-5.6-luna');
  assert.equal(enabled.json.session.fallback, undefined, 'an enabled model is left alone');

  const bare = await call('POST', '/sessions', { brain: { provider: 'codex' } });
  assert.equal(bare.json.session.brain.model, 'gpt-6-astra[extended]', "a null model would run Codex's disabled default");
  assert.equal(bare.json.session.fallback, undefined);

  const claude = await call('POST', '/sessions', { brain: { provider: 'claude-code', model: 'sonnet' } });
  const switched = await call('PATCH', `/sessions/${claude.json.session.id}`, { brain: { provider: 'codex' } });
  assert.equal(switched.status, 200);
  assert.equal(switched.json.session.brain.provider, 'codex');
  assert.equal(switched.json.session.brain.model, 'gpt-6-astra[extended]', "a switch never carries Claude's model id to Codex");

  // Every Codex model off: the start path moves to Claude, a strict model-less create is refused.
  hidden.codex = ['gpt-6-astra', 'gpt-6-astra[extended]', 'gpt-5.6-luna'];
  catalog.invalidate();
  const moved = await call('POST', '/sessions', { brain: { provider: 'codex', model: 'gpt-6-astra' }, fallback: true });
  assert.equal(moved.status, 201);
  assert.equal(moved.json.session.brain.provider, 'claude-code');
  assert.equal(moved.json.session.brain.model, 'default');
  assert.equal(moved.json.session.fallback.provider, 'claude-code');
  const none = await call('POST', '/sessions', { brain: { provider: 'codex' } });
  assert.equal(none.status, 400);
  assert.match(none.json.error, /^Every codex model is disabled/);
  const providerMoved = await call('POST', '/sessions', { brain: { provider: 'codex' }, fallback: true });
  assert.equal(providerMoved.json.session.brain.provider, 'claude-code');
  assert.equal(providerMoved.json.session.fallback.reason, 'provider');
});

// ── Image creation / Video creation ─────────────────────────────────────────
const CATALOG_VALUE = { models: { 'claude-code': normalizeClaudeRows(CLAUDE_MODELS.models, { pricing: PRICING }), codex: normalizeCodexRows(CODEX_MODELS.models), opencode: [] } };

test('routing settings: both creation classes are listed; a route whose model cannot make the medium is refused', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-api-routing-media-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configStore = createAssistantConfigStore({ path: resolve(root, 'assistant-config.json') });
  const router = { routing: () => configStore.routing() };
  const catalog = { full: async () => CATALOG_VALUE, peek: () => CATALOG_VALUE };
  const { call } = await startApp(t, { router, configStore, catalog });
  const got = await call('GET', '/routing');
  const ids = got.json.taskClasses.map((row) => row.id);
  assert.deepEqual(ids.slice(ids.indexOf('automation')), ['automation', 'design', 'image_gen', 'video_gen'], 'right after Automation and Design');
  assert.deepEqual(got.json.taskClasses.find((row) => row.id === 'image_gen'), { id: 'image_gen', label: 'Image creation', description: 'Create images with a model that generates them', defaultKind: 'dispatch', requires: 'image', dispatchOnly: true });
  assert.equal(got.json.taskClasses.find((row) => row.id === 'video_gen').requires, 'video');
  assert.equal(got.json.taskClasses.find((row) => row.id === 'code').requires, null);
  const refused = await call('PUT', '/routing', { routing: { preferences: { image_gen: { kind: 'dispatch', provider: 'claude-code', model: 'opus', label: 'Opus 5.5' } } } });
  assert.equal(refused.status, 400);
  assert.deepEqual([refused.json.code, refused.json.field], ['ROUTING_INVALID', 'preferences.image_gen']);
  assert.equal(refused.json.error, "Opus 5.5 can't generate images; Image creation needs a model that does.");
  const video = await call('PUT', '/routing', { routing: { preferences: { video_gen: { kind: 'dispatch', provider: 'codex', model: 'gpt-6-astra' } } } });
  assert.equal(video.status, 400, 'Codex makes no video');
  const saved = await call('PUT', '/routing', { routing: { preferences: { image_gen: { kind: 'direct', provider: 'codex', model: 'gpt-6-astra', effort: 'high' } } } });
  assert.equal(saved.status, 200);
  assert.deepEqual([saved.json.routing.preferences.image_gen.kind, saved.json.routing.preferences.image_gen.model], ['dispatch', 'gpt-6-astra'], 'always a worker');
  assert.equal((await call('PUT', '/routing', { routing: { preferences: { image_gen: null } } })).status, 200, 'clearing is always allowed');
});

test('routing settings: Design is listed (only models that can see, always a worker); a "here" or blind route is refused', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-api-routing-design-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configStore = createAssistantConfigStore({ path: resolve(root, 'assistant-config.json') });
  const router = { routing: () => configStore.routing() };
  // OpenCode's ollama-cloud/deepseek-v4-pro cannot see; Claude, Codex and deepseek-v4.1-flash can.
  const value = { models: { ...CATALOG_VALUE.models, opencode: parseOpenCodeProviders(OPENCODE_FULL) } };
  const catalog = { full: async () => value, peek: () => value };
  const { call, broadcasts } = await startApp(t, { router, configStore, catalog });
  const got = await call('GET', '/routing');
  assert.deepEqual(got.json.taskClasses.find((row) => row.id === 'design'), { id: 'design', label: 'Design', description: 'UI/UX research, design systems, mockups and prototypes', defaultKind: 'dispatch', requires: null, vision: true, dispatchOnly: true });
  assert.equal('vision' in got.json.taskClasses.find((row) => row.id === 'computer'), false, 'computer keeps its row shape');
  const here = await call('PUT', '/routing', { routing: { preferences: { design: { kind: 'direct', provider: 'claude-code', model: 'opus' } } } });
  assert.equal(here.status, 400);
  assert.deepEqual([here.json.code, here.json.field, here.json.error], ['ROUTING_INVALID', 'preferences.design', 'Design always runs on a worker: pick a model, not "here".']);
  const blind = await call('PUT', '/routing', { routing: { preferences: { design: { kind: 'dispatch', provider: 'opencode', model: 'ollama-cloud/deepseek-v4-pro', label: 'DeepSeek V4 Pro' } } } });
  assert.equal(blind.status, 400);
  assert.deepEqual([blind.json.code, blind.json.field, blind.json.error], ['ROUTING_INVALID', 'preferences.design', "DeepSeek V4 Pro can't see images; Design needs a model that can."]);
  assert.equal(configStore.routing().preferences.design, undefined, 'nothing was saved');
  assert.equal(broadcasts.length, 0);
  const saved = await call('PUT', '/routing', { routing: { preferences: { design: { kind: 'dispatch', provider: 'opencode', model: 'ollama-cloud/deepseek-v4.1-flash' } } } });
  assert.equal(saved.status, 200);
  assert.deepEqual([saved.json.routing.preferences.design.kind, saved.json.routing.preferences.design.model], ['dispatch', 'ollama-cloud/deepseek-v4.1-flash']);
  const opus = await call('PUT', '/routing', { routing: { preferences: { design: { kind: 'dispatch', provider: 'claude-code', model: 'opus', effort: 'high' } } } });
  assert.equal(opus.status, 200);
  assert.equal((await call('PUT', '/routing', { routing: { preferences: { design: null } } })).status, 200, 'clearing is always allowed');
  // Computer use keeps its lenient save: a blind route is not refused here (agent_route corrects it).
  assert.equal((await call('PUT', '/routing', { routing: { preferences: { computer: { kind: 'dispatch', provider: 'opencode', model: 'ollama-cloud/deepseek-v4-pro' } } } })).status, 200);
});

test('design review #3: PUT /routing needs confirmed sight for a new Design route (unknown sight is refused)', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-api-routing-design-sight-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // mystery/eye-1 declares no input capabilities: its sight is unknown.
  const unknown = parseOpenCodeProviders({ ok: true, data: { all: [{ id: 'mystery', models: { 'eye-1': { id: 'eye-1', name: 'Eye 1', capabilities: { toolcall: true }, cost: { input: 0.05, output: 0.2 } } } }], connected: ['mystery'] } });
  const value = { models: { ...CATALOG_VALUE.models, opencode: [...parseOpenCodeProviders(OPENCODE_FULL), ...unknown] } };
  const configStore = createAssistantConfigStore({ path: resolve(root, 'assistant-config.json') });
  const { call } = await startApp(t, { router: { routing: () => configStore.routing() }, configStore, catalog: { full: async () => value, peek: () => value } });
  const refused = await call('PUT', '/routing', { routing: { preferences: { design: { kind: 'dispatch', provider: 'opencode', model: 'mystery/eye-1', label: 'Eye 1' } } } });
  assert.equal(refused.status, 400, 'the reproduction saved it');
  assert.deepEqual([refused.json.code, refused.json.field, refused.json.error], ['ROUTING_INVALID', 'preferences.design', "Eye 1 isn't known to see images; Design needs a model that can."]);
  assert.equal(configStore.routing().preferences.design, undefined);
});

test('GET /runs/:runId/media/:n serves only recorded files, with Range; unknown and traversal → 404; guests → 403', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-api-media-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Under a dot directory, like ~/.synabun/data/media/<runId>/.
  const dir = resolve(root, '.synabun', 'data', 'media', 'run-1');
  mkdirSync(dir, { recursive: true });
  const bytes = Buffer.from('\x89PNG\r\n\x1a\nfake-image-bytes', 'latin1');
  writeFileSync(resolve(dir, '0-circle.png'), bytes);
  const asked = [];
  let swapped = null;
  const dispatcherExtra = {
    mediaFile(runId, n) {
      asked.push([runId, n]);
      if (runId === 'run-1' && n === 2 && swapped) return { path: swapped, mime: 'image/png' };
      return runId === 'run-1' && n === 0 ? { path: realpathSync(resolve(dir, '0-circle.png')), mime: 'image/png' } : null;
    },
  };
  const { base } = await startApp(t, { dispatcherExtra, isGuestRequest: (req) => req.get('x-guest') === '1' });
  const ok = await fetch(`${base}/runs/run-1/media/0`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/png');
  assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(ok.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(Buffer.from(await ok.arrayBuffer()), bytes);
  const part = await fetch(`${base}/runs/run-1/media/0`, { headers: { Range: 'bytes=0-3' } });
  assert.equal(part.status, 206, 'Range: a video seeks');
  assert.equal(part.headers.get('content-range'), `bytes 0-3/${bytes.length}`);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(0, 4));
  const unknown = await fetch(`${base}/runs/run-1/media/1`);
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).code, 'MEDIA_NOT_FOUND');
  assert.equal((await fetch(`${base}/runs/run-1/media/..%2F..%2Fsecret`)).status, 404, 'n is an index, never a path');
  assert.equal((await fetch(`${base}/runs/run-1/media/-1`)).status, 404);
  assert.equal((await fetch(`${base}/runs/..%2F..%2Fetc/media/0`)).status, 404, 'the run id only names a recorded run');
  assert.deepEqual(asked, [['run-1', 0], ['run-1', 0], ['run-1', 1], ['../../etc', 0]], 'bad indexes never reach the dispatcher');
  // Re-review #1: a path that was checked and then swapped for a symlink is refused when the route opens it.
  const outside = resolve(root, 'outside.txt');
  writeFileSync(outside, 'not an image');
  symlinkSync(outside, resolve(dir, '2-swapped.png'));
  swapped = resolve(dir, '2-swapped.png');
  assert.equal((await fetch(`${base}/runs/run-1/media/2`)).status, 404);
  const head = await fetch(`${base}/runs/run-1/media/0`, { method: 'HEAD' });
  assert.deepEqual([head.status, head.headers.get('content-length'), (await head.arrayBuffer()).byteLength], [200, String(bytes.length), 0]);
  const tail = await fetch(`${base}/runs/run-1/media/0`, { headers: { Range: 'bytes=-4' } });
  assert.deepEqual([tail.status, tail.headers.get('content-range')], [206, `bytes ${bytes.length - 4}-${bytes.length - 1}/${bytes.length}`]);
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), bytes.subarray(bytes.length - 4));
  const multi = await fetch(`${base}/runs/run-1/media/0`, { headers: { Range: 'bytes=0-1,3-4' } });
  assert.deepEqual([multi.status, multi.headers.get('content-range')], [200, null], 'final #2: several ranges are ignored (RFC 9110): the whole file');
  assert.deepEqual(Buffer.from(await multi.arrayBuffer()), bytes);
  const beyond = await fetch(`${base}/runs/run-1/media/0`, { headers: { Range: `bytes=${bytes.length + 10}-` } });
  assert.deepEqual([beyond.status, beyond.headers.get('content-range')], [416, `bytes */${bytes.length}`]);
  const guest = await fetch(`${base}/runs/run-1/media/0`, { headers: { 'x-guest': '1' } });
  assert.equal(guest.status, 403);
  assert.equal((await guest.json()).code, 'GUEST_FORBIDDEN');
});

test('design re-review B: PUT /routing fails closed for a new or changed Design route when sight cannot be confirmed; clearing and an unchanged route still save; image creation is unchanged', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-api-routing-design-closed-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configStore = createAssistantConfigStore({ path: resolve(root, 'assistant-config.json') });
  const router = { routing: () => configStore.routing() };
  // A Claude model the CLI cannot run (cliReady false → status unavailable; Claude rows can see).
  const claude = normalizeClaudeRows([...CLAUDE_MODELS.models, { id: 'claude-legacy-4', label: 'Claude Legacy 4', cliReady: false }], { pricing: PRICING });
  const value = { models: { ...CATALOG_VALUE.models, 'claude-code': claude } };
  assert.deepEqual([claude.at(-1).status, claude.at(-1).vision], ['unavailable', true], 'fixture: an unavailable row that sees');
  const up = await startApp(t, { router, configStore, catalog: { full: async () => value, peek: () => value } });
  const legacy = await up.call('PUT', '/routing', { routing: { preferences: { design: { kind: 'dispatch', provider: 'claude-code', model: 'claude-legacy-4', label: 'Claude Legacy 4' } } } });
  assert.deepEqual([legacy.status, legacy.json.field, legacy.json.error], [400, 'preferences.design', "Claude Legacy 4 isn't available right now; Design needs a model that can."]);
  assert.equal((await up.call('PUT', '/routing', { routing: { preferences: { design: { kind: 'dispatch', provider: 'claude-code', model: 'opus', effort: 'high' } } } })).status, 200, 'saved while the catalog answers');
  // The catalog is down (it throws and nothing is cached), then not wired at all.
  for (const [label, catalog] of [['catalog down', { full: async () => { throw new Error('catalog down'); }, peek: () => null }], ['no catalog', null]]) {
    const down = await startApp(t, { router, configStore, catalog });
    const changed = await down.call('PUT', '/routing', { routing: { preferences: { design: { kind: 'dispatch', provider: 'claude-code', model: 'sonnet' } } } });
    assert.deepEqual([changed.status, changed.json.field], [400, 'preferences.design'], `${label}: the reproduction saved it`);
    assert.equal(changed.json.error, "Can't confirm that sonnet can see images right now: the model catalog is unavailable. Try again shortly, or clear the Design row.");
    assert.equal(configStore.routing().preferences.design.model, 'opus', `${label}: the saved route is untouched`);
    const same = await down.call('PUT', '/routing', { routing: { preferences: { design: { kind: 'dispatch', provider: 'claude-code', model: 'opus', effort: 'high', label: 'Opus 5.5' } } } });
    assert.equal(same.status, 200, `${label}: re-sending the route the user has is not a new one`);
    assert.equal((await down.call('PUT', '/routing', { routing: { preferences: { code: { kind: 'dispatch', provider: 'claude-code', model: 'sonnet' } } } })).status, 200, `${label}: other rows save`);
  }
  // Clearing ("Let the brain decide") needs no catalog.
  const cleared = await (await startApp(t, { router, configStore, catalog: { full: async () => { throw new Error('catalog down'); }, peek: () => null } })).call('PUT', '/routing', { routing: { preferences: { design: null } } });
  assert.equal(cleared.status, 200);
  assert.equal(configStore.routing().preferences.design, undefined);
  // Image creation keeps its lenient save without a catalog value.
  const imageRoot = mkdtempSync(resolve(tmpdir(), 'synabun-api-routing-image-off-'));
  t.after(() => rmSync(imageRoot, { recursive: true, force: true }));
  const imageStore = createAssistantConfigStore({ path: resolve(imageRoot, 'assistant-config.json') });
  const image = await startApp(t, { router: { routing: () => imageStore.routing() }, configStore: imageStore, catalog: { full: async () => { throw new Error('catalog down'); }, peek: () => null } });
  assert.equal((await image.call('PUT', '/routing', { routing: { preferences: { image_gen: { kind: 'dispatch', provider: 'claude-code', model: 'opus' } } } })).status, 200, 'image creation: unchanged');
});

test('design round 3 #2 (routes): PUT /routing refuses a Design route on a claude-* id the catalog does not list; a full id it resolves saves; other rows still take it', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-api-routing-design-unlisted-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configStore = createAssistantConfigStore({ path: resolve(root, 'assistant-config.json') });
  const { call } = await startApp(t, { router: { routing: () => configStore.routing() }, configStore, catalog: { full: async () => CATALOG_VALUE, peek: () => CATALOG_VALUE } });
  const made = await call('PUT', '/routing', { routing: { preferences: { design: { kind: 'dispatch', provider: 'claude-code', model: 'claude-made-up-9' } } } });
  assert.deepEqual([made.status, made.json.code, made.json.field, made.json.error], [400, 'ROUTING_INVALID', 'preferences.design', "claude-made-up-9 isn't known to see images; Design needs a model that can."], 'the reproduction saved it');
  assert.equal(configStore.routing().preferences.design, undefined);
  const resolved = await call('PUT', '/routing', { routing: { preferences: { design: { kind: 'dispatch', provider: 'claude-code', model: 'claude-opus-5-5' } } } });
  assert.equal(resolved.status, 200, 'claude-opus-5-5 is what the opus row runs');
  assert.equal(configStore.routing().preferences.design.model, 'claude-opus-5-5');
  assert.equal((await call('PUT', '/routing', { routing: { preferences: { code: { kind: 'dispatch', provider: 'claude-code', model: 'claude-made-up-9' } } } })).status, 200, 'a code route is not checked');
});
