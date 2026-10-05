// Image creation / Video creation: collecting what a worker generated, from the
// Codex exec stream / rollout captured by the 2026-09-28 probe (codex-cli 0.156.1,
// fixtures/codex-exec-image-generation.jsonl + codex-rollout-image-generation.jsonl),
// OpenCode file parts, the worker's `media:` lines, and the dispatcher's copy.
process.env.SYNABUN_TYPESAFE = 'off';

import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { open as openFile } from 'node:fs/promises';
import { NativeLoopRuntime } from '../lib/native-loop-runtime.js';
import { createAssistantDispatcher } from '../lib/assistant-dispatch.js';
import { createAssistantRuntime } from '../lib/assistant-runtime.js';
import { createCodexNativeLoopAdapter, createOpenCodeNativeLoopAdapter } from '../lib/native-loop-providers.js';
import {
  base64Bytes, codexRolloutMedia, codexStreamMedia, collectCodexMedia, copyOpenFile, copyRunMedia, insideRunMedia, mediaType, mediaUrl, openCodeMediaPart, openServable,
  ownCodexImages, scanCodexGeneratedImages, servableRunMedia,
} from '../lib/assistant-media.js';
import { buildTaskPrompt, mediaBlock, parseResultContract, resultContractText } from '../lib/assistant-task-prompt.js';
import { formatMailbox } from '../lib/assistant-persona.js';
import { normalizeClaudeRows, normalizeCodexRows, parseOpenCodeProviders } from '../lib/assistant-catalog.js';
import { CLAUDE_MODELS, CODEX_MODELS, OPENCODE_MEDIA, PRICING } from './assistant-catalog.fixtures.mjs';
import { normalizeRouteRequest as normalizeCard, routeLineParts, routeOptions, routeReasonLabels } from '../public/shared/assistant/asst-route.js';

const FIXTURES = new URL('./fixtures/', import.meta.url);
const EXEC_EVENTS = readFileSync(new URL('codex-exec-image-generation.jsonl', FIXTURES), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const ROLLOUT_TEXT = readFileSync(new URL('codex-rollout-image-generation.jsonl', FIXTURES), 'utf8');
const THREAD = EXEC_EVENTS.find((event) => event.type === 'thread.started').thread_id;
const SAVED_NAME = 'exec-1193fc2f-7500-4953-ba17-3849f3c48073.png';
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex');
const CATALOG = { models: { 'claude-code': normalizeClaudeRows(CLAUDE_MODELS.models, { pricing: PRICING }), codex: normalizeCodexRows(CODEX_MODELS.models), opencode: [] } };

const waitFor = async (predicate, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  throw new Error('Timed out waiting for condition');
};
const tempDir = (t, prefix) => {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const touch = (path, ms) => utimesSync(path, new Date(ms), new Date(ms));

/** A CODEX_HOME holding the probe's saved image and (optionally) its rollout, moved to this home and to now. */
function codexHome(t, { rollout = true } = {}) {
  const home = tempDir(t, 'synabun-codex-home-');
  const savedPath = join(home, 'generated_images', THREAD, SAVED_NAME);
  mkdirSync(join(home, 'generated_images', THREAD), { recursive: true });
  writeFileSync(savedPath, PNG);
  touch(savedPath, Date.now() + 500);
  if (rollout) {
    const at = new Date(Date.now() + 500).toISOString();
    const lines = ROLLOUT_TEXT.trim().split('\n').map((line) => {
      const entry = JSON.parse(line.split('/Users/example/.codex').join(home));
      entry.timestamp = at;
      return JSON.stringify(entry);
    });
    const d = new Date();
    const dir = join(home, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    mkdirSync(dir, { recursive: true });
    const rolloutPath = join(dir, `rollout-2026-09-28T03-26-24-${THREAD}.jsonl`);
    writeFileSync(rolloutPath, `${lines.join('\n')}\n`);
    return { home, savedPath, rolloutPath };
  }
  return { home, savedPath, rolloutPath: null };
}
/** A Codex SDK stand-in replaying the probe's `codex exec --experimental-json` stream. */
function replayCodex(events = EXEC_EVENTS) {
  return class ReplayCodex {
    startThread() {
      return { id: THREAD, async runStreamed() { return { events: (async function* () { for (const event of events) yield event; })() }; } };
    }
  };
}

// ── Step 0 fixtures ─────────────────────────────────────────────────────────

test('Step 0 capture: `codex exec` streams no image item; the rollout records the saved path', () => {
  assert.deepEqual(EXEC_EVENTS.map((event) => (event.item ? `${event.type}:${event.item.type}` : event.type)), [
    'thread.started', 'turn.started', 'item.completed:agent_message',
    'item.started:command_execution', 'item.completed:command_execution', 'item.started:command_execution', 'item.completed:command_execution',
    'item.completed:agent_message', 'turn.completed',
  ], 'the image itself happened inside Codex\'s own tool call: no stream item for it');
  assert.ok(EXEC_EVENTS.every((event) => codexStreamMedia(event) === null), 'CLI 0.156.1 streams no image item');
  assert.deepEqual(codexStreamMedia({ type: 'item.completed', item: { type: 'image_generation', saved_path: '/x/a.png' } }), { path: '/x/a.png', kind: 'image', source: 'stream' }, 'a later CLI that streams one is read directly');
  const found = codexRolloutMedia(ROLLOUT_TEXT);
  assert.deepEqual(found.map((item) => [item.path, item.kind, item.source]), [[`/Users/example/.codex/generated_images/${THREAD}/${SAVED_NAME}`, 'image', 'rollout']]);
  assert.match(found[0].prompt, /blue circle/);
  assert.deepEqual(codexRolloutMedia(ROLLOUT_TEXT, { sinceMs: Date.parse('2026-09-28T06:27:00Z') }), [], 'an image from before the turn is not this turn\'s');
});

test('Codex adapter: an image creation turn returns its image from the rollout, once; other runs collect nothing', async (t) => {
  const { home, savedPath } = codexHome(t);
  const adapter = await createCodexNativeLoopAdapter({ runId: 'run-img', cwd: home, codexHome: home, CodexClass: replayCodex(), collectMedia: 'image' });
  const first = await adapter.runTurn('Use your image generation tool to make a 256x256 PNG of a blue circle.');
  assert.match(first.text, /Generated the blue circle PNG/);
  assert.deepEqual(first.media.map((item) => [item.path, item.kind, item.source]), [[savedPath, 'image', 'rollout']]);
  assert.equal((await adapter.runTurn('and again')).media, undefined, 'the same image is never returned twice');
  const loop = await createCodexNativeLoopAdapter({ runId: 'run-loop', cwd: home, codexHome: home, CodexClass: replayCodex() });
  assert.equal((await loop.runTurn('work')).media, undefined, 'loops and other classes do not collect');
});

test('Codex adapter: without a rollout, the files new in generated_images/<thread>/ since the turn began', async (t) => {
  const { home, savedPath } = codexHome(t, { rollout: false });
  const old = join(home, 'generated_images', THREAD, 'exec-earlier.png');
  writeFileSync(old, PNG);
  touch(old, Date.now() - 3_600_000);
  writeFileSync(join(home, 'generated_images', THREAD, 'notes.txt'), 'x');
  const adapter = await createCodexNativeLoopAdapter({ runId: 'run-scan', cwd: home, codexHome: home, CodexClass: replayCodex(), collectMedia: 'image' });
  const turn = await adapter.runTurn('draw');
  assert.deepEqual(turn.media.map((item) => [item.path, item.source]), [[savedPath, 'scan']]);
  assert.deepEqual(scanCodexGeneratedImages({ codexHome: home, threadId: '../x' }), [], 'a thread id is never a path');
  assert.deepEqual((await collectCodexMedia({ codexHome: home, threadId: THREAD, sinceMs: Date.now() + 60_000 })), [], 'nothing newer than the turn');
});

test('OpenCode adapter: an image creation turn returns the image file parts its model produced (best effort)', async () => {
  const listeners = new Set();
  const part = (id, messageID, extra) => ({ eventType: 'message.part.updated', event: { part: { id, messageID, sessionID: 'ses-img', ...extra } } });
  const client = {
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async waitUntilConnected() {},
    session: {
      async create() { return { data: { id: 'ses-img' } }; },
      async promptAsync() {
        setTimeout(() => {
          for (const listener of listeners) {
            for (const event of [
              { eventType: 'message.updated', event: { info: { id: 'msg-u', role: 'user', sessionID: 'ses-img' } } },
              part('p0', 'msg-u', { type: 'file', mime: 'image/png', url: 'data:image/png;base64,AAAA' }),
              { eventType: 'message.updated', event: { info: { id: 'msg-a', role: 'assistant', sessionID: 'ses-img' } } },
              part('p1', 'msg-a', { type: 'text', text: 'Here it is.' }),
              part('p2', 'msg-a', { type: 'file', mime: 'image/png', filename: 'cat.png', url: `data:image/png;base64,${PNG.toString('base64')}` }),
              part('p3', 'msg-a', { type: 'file', mime: 'text/plain', url: 'data:text/plain;base64,aGk=' }),
              { eventType: 'session.idle', event: { sessionID: 'ses-img' } },
            ]) listener(event);
          }
        }, 5);
        return { status: 204 };
      },
      async abort() {},
    },
  };
  const adapter = await createOpenCodeNativeLoopAdapter({ client, collectMedia: 'image' });
  const turn = await adapter.runTurn('draw a cat');
  assert.equal(turn.text, 'Here it is.');
  assert.deepEqual(turn.media, [{ kind: 'image', mime: 'image/png', data: PNG.toString('base64'), name: 'cat.png', source: 'opencode' }], 'the user\'s own parts and non-media files are left out');
  await adapter.dispose();
  assert.deepEqual(openCodeMediaPart({ type: 'file', mime: 'video/mp4', url: pathToFileURL('/tmp/clip.mp4').href }), { kind: 'video', mime: 'video/mp4', path: '/tmp/clip.mp4', name: 'clip.mp4', source: 'opencode' });
  assert.equal(openCodeMediaPart({ type: 'file', mime: 'image/png', url: 'https://example.com/a.png' }), null, 'a remote URL is never fetched');
});

// ── Worker prompt and result contract ───────────────────────────────────────

test('task prompt: the media block and the media: key only for image / video creation; media: lines are parsed', () => {
  const plain = buildTaskPrompt({ task: 'Fix the bug', cwd: '/tmp', runId: 'r1', provider: 'codex' });
  assert.doesNotMatch(plain, /IMAGE CREATION|VIDEO CREATION/);
  assert.doesNotMatch(plain, /^media:$/m);
  assert.equal(mediaBlock({ collectMedia: null }), '');
  const image = buildTaskPrompt({ task: 'A 1024x1024 neon bunny logo on black', cwd: '/tmp', runId: 'r2', provider: 'codex', taskClass: 'image_gen', collectMedia: 'image' });
  assert.match(image, /=== IMAGE CREATION ===/);
  assert.match(image, /Make each one with your own built-in image generation tool/);
  assert.match(image, /Do not write scripts, call external image APIs or services, draw or render it with code, or leave placeholder files/);
  assert.match(image, /Follow the requested size or aspect ratio, style and number of images/);
  assert.match(image, /list the absolute path of each image you generated under media:/);
  assert.match(image, /follow_ups:\n- <next step or risk> {10}\(or "- none"\)\nmedia:\n- <absolute path of each generated file>\nquestion:/);
  const video = buildTaskPrompt({ task: '5 s of waves', cwd: '/tmp', runId: 'r3', taskClass: 'video_gen', collectMedia: 'video' });
  assert.match(video, /=== VIDEO CREATION ===/);
  assert.match(video, /duration, size or aspect ratio/);
  assert.match(resultContractText({ media: true }), /^media:$/m);
  const parsed = parseResultContract('Done.\n\n## Result\nstatus: done\nsummary: made the logo\nchanges:\n- none\nfollow_ups:\n- none\nmedia:\n- `/Users/me/.codex/generated_images/t/exec-1.png` — the logo\n- /tmp/b.png\n- none\nquestion:\n');
  assert.deepEqual(parsed.media, ['/Users/me/.codex/generated_images/t/exec-1.png', '/tmp/b.png']);
  assert.deepEqual(parsed.changes, []);
  assert.deepEqual(parseResultContract('## Result\nstatus: done\nmedia: /tmp/one.png').media, ['/tmp/one.png'], 'an inline value');
  assert.deepEqual(parseResultContract('no block at all').media, []);
});

// ── Copy + serve guard ──────────────────────────────────────────────────────

test('copyRunMedia: numbered copies under <root>/<runId>/, bytes from a data item, only media types, nothing older than the run', async (t) => {
  const dir = tempDir(t, 'synabun-media-copy-');
  const root = join(dir, 'media');
  const src = join(dir, 'a.png');
  writeFileSync(src, PNG);
  const old = join(dir, 'old.png');
  writeFileSync(old, PNG);
  touch(old, Date.now() - 3_600_000);
  writeFileSync(join(dir, 'x.svg'), '<svg/>');
  const copied = await copyRunMedia({
    root, runId: 'run-1', start: 3, sinceMs: Date.now() - 60_000,
    items: [{ path: src, source: 'rollout' }, { path: old }, { path: join(dir, 'x.svg') }, { path: join(dir, 'missing.png') }, { data: PNG.toString('base64'), mime: 'image/png', kind: 'image', name: '../../evil' }],
  });
  assert.deepEqual(copied.map((m) => [m.kind, m.mime, m.path.slice(root.length)]), [['image', 'image/png', `${sep}run-1${sep}3-a.png`], ['image', 'image/png', `${sep}run-1${sep}4-evil.png`]]);
  assert.deepEqual(readFileSync(copied[1].path), PNG);
  assert.equal(copied[0].original, src);
  assert.deepEqual(await copyRunMedia({ root, runId: '../x', items: [{ path: src }] }), [], 'the run id is never a path');
  assert.equal(insideRunMedia(root, 'run-1', copied[0].path), true);
  assert.equal(insideRunMedia(root, 'run-1', src), false);
  assert.equal(insideRunMedia(root, 'run-1', join(root, 'run-1', '..', 'run-2', '0-a.png')), false);
  assert.equal(insideRunMedia(root, 'run-1', join(root, 'run-1', 'notes.txt')), false, 'only served types');
  assert.equal(mediaType('clip.MP4').mime, 'video/mp4');
  assert.equal(mediaType('logo.svg'), null, 'SVG is never served');
  assert.equal(mediaUrl('run-1', 2), '/api/assistant/runs/run-1/media/2');
});

// ── Dispatcher ──────────────────────────────────────────────────────────────

function mediaHarness(t, { text, media = () => [], router = null, limits = {}, catalog = CATALOG } = {}) {
  const root = tempDir(t, 'synabun-media-dispatch-');
  const states = [];
  const prompts = [];
  const makeAdapter = (state) => {
    states.push(state);
    let turns = 0;
    return {
      identity: () => ({ providerSessionId: `sess-${state.runId.slice(0, 4)}` }),
      isAlive: () => true,
      async runTurn(prompt) {
        turns += 1;
        prompts.push(prompt);
        const found = media(turns, state);
        return { text: typeof text === 'function' ? text(turns, state) : text, costUsd: 0.01, ...(found.length ? { media: found } : {}) };
      },
      async abort() {},
      async dispose() {},
    };
  };
  const runtime = new NativeLoopRuntime({
    stateDir: resolve(root, 'loop'), ledgerPath: resolve(root, 'runs.json'), buildPrompt: () => 'LOOP PROMPT', iterationDelayMs: 0,
    providerFactories: { codex: async (s) => makeAdapter(s), 'claude-code': async (s) => makeAdapter(s), opencode: async (s) => makeAdapter(s) },
  });
  const dispatcher = createAssistantDispatcher({
    getRuntime: () => runtime, dataDir: root, loopDir: resolve(root, 'loop'), PACKAGE_ROOT: root,
    getCodexAccount: () => ({ id: 'default', home: resolve(root, 'codex') }), CODEX_DEFAULT_HOME: resolve(root, 'codex'),
    detectProject: () => 'proj', limits: { minIdleTimeoutMs: 50, ...limits },
    catalog: { full: async () => catalog, peek: () => catalog }, router,
  });
  t.after(() => dispatcher.shutdown('test'));
  return { root, dispatcher, states, prompts };
}
const result = (lines) => `Done.\n\n## Result\nstatus: done\nsummary: drew a neon bunny\nchanges:\n- none\nfollow_ups:\n- none\nmedia:\n${lines.map((line) => `- ${line}`).join('\n')}`;

test('dispatch (image creation): the class reaches the worker; generated files are copied under media/<runId> and carried by the result', async (t) => {
  const gen = tempDir(t, 'synabun-media-generated-');
  const generated = join(gen, SAVED_NAME);
  writeFileSync(generated, PNG);
  const named = join(gen, 'bunny-2.png');
  writeFileSync(named, PNG);
  const stale = join(gen, 'yesterday.png');
  writeFileSync(stale, PNG);
  touch(stale, Date.now() - 86_400_000);
  const notMedia = join(gen, 'notes.txt');
  writeFileSync(notMedia, 'x');
  const { root, dispatcher, states, prompts } = mediaHarness(t, {
    media: (turn) => (turn === 1 ? [{ path: generated, kind: 'image', source: 'rollout' }] : []),
    text: () => result([generated, named, stale, notMedia]),
  });
  const out = await dispatcher.dispatch({ provider: 'codex', model: 'gpt-6-astra', task: 'Draw a neon bunny logo', cwd: root, taskClass: 'image_gen' }, { assistantSessionId: 'assistant-1' });
  const runId = out.run.runId;
  const run = await waitFor(() => { const view = dispatcher.get(runId); return view?.lastResult?.media?.length ? view : null; });
  assert.deepEqual([states[0].taskClass, states[0].collectMedia], ['image_gen', 'image']);
  assert.match(prompts[0], /=== IMAGE CREATION ===/);
  assert.equal(run.taskClass, 'image_gen');
  assert.deepEqual(run.lastResult.media.map((m) => [m.kind, m.url, m.mime, m.bytes]), [
    ['image', `/api/assistant/runs/${runId}/media/0`, 'image/png', PNG.length],
    ['image', `/api/assistant/runs/${runId}/media/1`, 'image/png', PNG.length],
  ], 'the adapter\'s image (listed again under media: → once) and the other file the worker named; the stale and non-media ones are not collected');
  for (const m of run.lastResult.media) {
    assert.ok(m.path.startsWith(resolve(root, 'media', runId) + sep), m.path);
    assert.deepEqual(readFileSync(m.path), PNG);
    assert.ok(run.lastResult.files.includes(m.path), 'files lists the copies');
  }
  assert.equal(run.media.length, 2, 'the run-level list');
  assert.ok(run.notes.some((note) => /2 generated files not collected/.test(note)));
  assert.equal(dispatcher.transcript(runId, { format: 'result' }).result.media.length, 2, 'agent_read carries media');
  assert.deepEqual(dispatcher.mediaFile(runId, 0), { path: realpathSync(run.lastResult.media[0].path), mime: 'image/png', kind: 'image', bytes: PNG.length }, 'the real path is what gets served');
  assert.equal(dispatcher.mediaFile(runId, 2), null);
  assert.equal(dispatcher.mediaFile('run-unknown', 0), null);
  assert.equal(dispatcher.mediaFile(runId, -1), null);
  // A record pointing outside media/<runId>/ (a tampered registry) is never served.
  dispatcher._internals.entries.get(runId).media[1].path = named;
  assert.equal(dispatcher.mediaFile(runId, 1), null);
});

test('dispatch (other classes): media: lines are not collected; a code run keeps its shape', async (t) => {
  const gen = tempDir(t, 'synabun-media-generated-');
  const png = join(gen, 'a.png');
  writeFileSync(png, PNG);
  const { root, dispatcher, states, prompts } = mediaHarness(t, { text: () => result([png]) });
  const out = await dispatcher.dispatch({ provider: 'codex', model: 'gpt-6-astra', task: 'Fix the bug', cwd: root, taskClass: 'code' }, { assistantSessionId: 'assistant-1' });
  const run = await waitFor(() => { const view = dispatcher.get(out.run.runId); return view?.lastResult ? view : null; });
  assert.deepEqual([states[0].taskClass, states[0].collectMedia], ['code', null]);
  assert.doesNotMatch(prompts[0], /IMAGE CREATION/);
  assert.deepEqual(run.lastResult.media, []);
  assert.equal(run.media, undefined);
  assert.equal(existsSync(resolve(root, 'media')), false);
});

test('dispatch backstop: an image / video creation run on a model that cannot make the medium is refused', async (t) => {
  const { root, dispatcher } = mediaHarness(t, { text: () => result([]) });
  await assert.rejects(
    dispatcher.dispatch({ provider: 'claude-code', model: 'opus', task: 'Draw a logo', cwd: root, taskClass: 'image_gen' }, { assistantSessionId: 'assistant-1' }),
    (error) => error.code === 'MODEL_CANNOT_GENERATE' && error.status === 400 && /Model "opus" cannot generate images; Image creation needs a model that does/.test(error.message),
  );
  await assert.rejects(
    dispatcher.dispatch({ provider: 'codex', task: '5 s of waves', cwd: root, taskClass: 'video_gen' }, { assistantSessionId: 'assistant-1' }),
    (error) => error.code === 'MODEL_CANNOT_GENERATE' && /The codex default model cannot generate videos/.test(error.message),
  );
  const ok = await dispatcher.dispatch({ provider: 'codex', task: 'Draw a logo', cwd: root, taskClass: 'image_gen' }, { assistantSessionId: 'assistant-1' });
  assert.equal(ok.run.taskClass, 'image_gen', 'the Codex default model makes images');
});

// ── Mailbox ─────────────────────────────────────────────────────────────────

test('mailbox: a result item carries the generated media and the brain sees its paths and urls', async (t) => {
  const line = formatMailbox([{
    kind: 'result', run: { runId: 'abcdef123456', provider: 'codex', model: 'gpt-6-sol', title: 'Bunny logo', outcome: 'done' }, summary: 'drew it', files: [],
    media: [{ kind: 'image', path: '/Users/me/.synabun/data/media/abcdef123456/0-bunny.png', url: '/api/assistant/runs/abcdef123456/media/0' }],
  }]);
  assert.match(line, /media: image \/Users\/me\/\.synabun\/data\/media\/abcdef123456\/0-bunny\.png \(\/api\/assistant\/runs\/abcdef123456\/media\/0\)/);
  const listeners = new Set();
  const dispatcher = { limits: {}, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, totals: () => ({ costUsd: 0 }), get: () => null, deliveryState: () => null };
  const factory = () => ({ kind: 'codex', async start() {}, async sendUserTurn() {}, isBusy: () => true, identity: () => ({}), async dispose() {} });
  const root = tempDir(t, 'synabun-media-mailbox-');
  const runtime = createAssistantRuntime({ dispatcher, dataDir: root, detectProject: () => 'proj', buildCatalog: async () => ({}), brainFactories: { 'claude-code': factory, codex: factory, opencode: factory }, config: { mailboxBatchMs: 5000 } });
  t.after(() => runtime.shutdown());
  const session = await runtime.createSession({ brain: { provider: 'codex' }, cwd: '/tmp' });
  const media = [{ kind: 'image', path: '/x/0-a.png', url: '/api/assistant/runs/run-m/media/0', mime: 'image/png', bytes: 20 }];
  for (const listener of listeners) listener({ type: 'assistant:dispatch', reason: 'turn_completed', turn: 1, run: { runId: 'run-m', assistantSessionId: session.id, provider: 'codex', title: 'Logo', outcome: 'done', memoryStored: true, lastResult: { status: 'done', summary: 'drew it', files: [], follow_ups: [], media } } });
  const [item] = runtime._internals.sessions.get(session.id).mailbox;
  assert.deepEqual(item.media, media);
});

// ── Route card / line (UI logic) ────────────────────────────────────────────

test('route UI: a creation card knows its medium; its reason, the "capable" badge and a no_capable_model line read right', () => {
  const n = normalizeCard({ request_id: 'route-1', request: {
    routeId: 'route-1', taskClass: 'image_gen', taskClassLabel: 'Image creation', requires: 'image', dispatchOnly: true, reasons: ['needs_output'], defaultOptionId: 'g1',
    options: [
      { id: 's1', kind: 'dispatch', provider: 'claude-code', model: 'opus', label: 'Claude Code · Opus 5.5', badge: 'suggested', disabled: true, disabledReason: "This model can't generate images." },
      { id: 'g1', kind: 'dispatch', provider: 'codex', model: 'gpt-6-luna', label: 'Codex · GPT-6-Luna', badge: 'capable' },
    ],
  } });
  assert.deepEqual([n.requires, n.dispatchOnly], ['image', true]);
  assert.deepEqual(routeReasonLabels(n), ['needs a model that makes images']);
  const options = routeOptions(n);
  assert.deepEqual(options.map((o) => [o.id, o.badgeText, o.selected]), [['g1', 'Makes images', true], ['s1', 'Suggested', false]]);
  assert.equal(normalizeCard({ request_id: 'r2', request: { routeId: 'r2', taskClass: 'code', requires: 'audio' } }).requires, null);
  const line = routeLineParts({ routeId: 'route-v', taskClass: 'video_gen', taskClassLabel: 'Video creation', reasonCode: 'no_capable_model', decidedBy: 'rule' }, 'declined');
  assert.deepEqual([line.taskClass, line.stateText, line.muted], ['Video creation', 'no model can make this', true]);
  assert.equal(routeLineParts({ routeId: 'route-d', taskClass: 'code' }, 'declined').stateText, 'declined');
});

// ── Review fixes (2026-09-28, Codex review run 35d06cf3) ────────────────────

test('review #1: a route approved for other work cannot carry image / video creation (ROUTE_CLASS_MISMATCH); the backstop checks a route-chosen target', async (t) => {
  const approved = (taskClass, target) => ({
    async resolveDispatch({ spec }) { return { action: 'start', spec: { ...spec, ...target }, route: { routeId: `route-${taskClass}`, status: 'approved', decidedBy: 'brain', taskClass } }; },
  });
  // The reproduction: an approved code route (on Claude) reused for an image_gen dispatch.
  const code = mediaHarness(t, { text: () => result([]), router: approved('code', { provider: 'claude-code', model: 'opus' }) });
  await assert.rejects(
    code.dispatcher.dispatch({ routeId: 'route-code', task: 'Draw a neon bunny logo', cwd: code.root, taskClass: 'image_gen' }, { assistantSessionId: 'assistant-1' }),
    (error) => error.code === 'ROUTE_CLASS_MISMATCH' && error.status === 409 && error.routeClass === 'code' && error.taskClass === 'image_gen' && /agent_route with task_class "image_gen"/.test(error.message),
  );
  assert.equal(code.dispatcher.list().length, 0, 'nothing was started');
  // A class that changes nothing once routed keeps today's behaviour: the route's class stands.
  const review = await code.dispatcher.dispatch({ routeId: 'route-code', task: 'Look it over', cwd: code.root, taskClass: 'review' }, { assistantSessionId: 'assistant-1' });
  assert.equal(review.run.taskClass, 'code');
  // An image route cannot run code work either, and without a declared class the route's own class is checked on its target.
  const image = mediaHarness(t, { text: () => result([]), router: approved('image_gen', { provider: 'claude-code', model: 'opus' }) });
  await assert.rejects(image.dispatcher.dispatch({ routeId: 'route-image_gen', task: 'Fix it', cwd: image.root, taskClass: 'code' }, { assistantSessionId: 'assistant-1' }), (error) => error.code === 'ROUTE_CLASS_MISMATCH');
  await assert.rejects(image.dispatcher.dispatch({ routeId: 'route-image_gen', task: 'Draw', cwd: image.root }, { assistantSessionId: 'assistant-1' }), (error) => error.code === 'MODEL_CANNOT_GENERATE');
});

test('review #2: a symlink planted in place of a recorded file, or of the run folder, is never served', async (t) => {
  const dir = tempDir(t, 'synabun-media-serve-');
  const root = join(dir, 'media');
  mkdirSync(join(root, 'run-1'), { recursive: true });
  const file = join(root, 'run-1', '0-a.png');
  writeFileSync(file, PNG);
  assert.equal(servableRunMedia(root, 'run-1', file), realpathSync(file));
  const secret = join(dir, 'secret.txt');
  writeFileSync(secret, 'not an image');
  const link = join(root, 'run-1', '1-b.png');
  symlinkSync(secret, link);
  assert.equal(servableRunMedia(root, 'run-1', link), null, 'a symlink in place of a recorded file');
  const elsewhere = join(dir, 'elsewhere');
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, '0-a.png'), PNG);
  symlinkSync(elsewhere, join(root, 'run-2'));
  assert.equal(servableRunMedia(root, 'run-2', join(root, 'run-2', '0-a.png')), null, 'a symlinked run folder');
  symlinkSync(root, join(dir, 'media-moved'));
  assert.equal(servableRunMedia(join(dir, 'media-moved'), 'run-1', join(dir, 'media-moved', 'run-1', '0-a.png')), realpathSync(file), 'a data dir reached through a symlink still serves');
  // Through the dispatcher: the recorded file swapped for a symlink.
  const gen = tempDir(t, 'synabun-media-generated-');
  const generated = join(gen, SAVED_NAME);
  writeFileSync(generated, PNG);
  const { root: runRoot, dispatcher } = mediaHarness(t, { media: (turn) => (turn === 1 ? [{ path: generated, kind: 'image', source: 'rollout' }] : []), text: () => result([]) });
  const out = await dispatcher.dispatch({ provider: 'codex', model: 'gpt-6-astra', task: 'Draw', cwd: runRoot, taskClass: 'image_gen' }, { assistantSessionId: 'assistant-1' });
  const run = await waitFor(() => { const view = dispatcher.get(out.run.runId); return view?.lastResult?.media?.length ? view : null; });
  assert.ok(dispatcher.mediaFile(out.run.runId, 0));
  const recorded = run.lastResult.media[0].path;
  unlinkSync(recorded);
  symlinkSync(secret, recorded);
  assert.equal(dispatcher.mediaFile(out.run.runId, 0), null);
  // Copy sources are never followed through a symlink either.
  const linkSource = join(gen, 'linked.png');
  symlinkSync(generated, linkSource);
  assert.deepEqual(await copyRunMedia({ root, runId: 'run-3', items: [{ path: linkSource }] }), []);
});

test('review #3: sizes are checked before decoding; per-file and per-run byte caps', async (t) => {
  assert.equal(base64Bytes('AAAA'), 3);
  assert.equal(base64Bytes('AAA='), 2);
  assert.equal(base64Bytes('AA=='), 1);
  assert.equal(base64Bytes(''), 0);
  const dir = tempDir(t, 'synabun-media-caps-');
  const root = join(dir, 'media');
  const inline = (bytes) => ({ data: Buffer.alloc(bytes, 7).toString('base64'), mime: 'image/png', kind: 'image' });
  assert.deepEqual(await copyRunMedia({ root, runId: 'run-a', items: [inline(150)], maxInlineBytes: 100 }), [], 'an inline file over its cap is never decoded or written');
  assert.equal(existsSync(join(root, 'run-a')), false);
  assert.equal((await copyRunMedia({ root, runId: 'run-b', items: [inline(90)], maxInlineBytes: 100 })).length, 1);
  const file = (name, bytes) => { const path = join(dir, name); writeFileSync(path, Buffer.alloc(bytes, 1)); return { path }; };
  assert.deepEqual(await copyRunMedia({ root, runId: 'run-c', items: [file('big.png', 120)], maxBytes: 100 }), [], 'a file over the per-file cap');
  const both = await copyRunMedia({ root, runId: 'run-d', items: [file('one.png', 60), file('two.png', 60), inline(30)], budgetBytes: 100 });
  assert.deepEqual(both.map((m) => m.bytes), [60, 30], 'the run budget: the second 60-byte file does not fit, the 30-byte one does');
  // Through the dispatcher: every turn of a run shares its budget.
  const gen = tempDir(t, 'synabun-media-generated-');
  const first = join(gen, 'first.png');
  const second = join(gen, 'second.png');
  writeFileSync(first, PNG);
  writeFileSync(second, PNG);
  const { root: runRoot, dispatcher } = mediaHarness(t, {
    limits: { mediaRunBytes: PNG.length + 5 },
    media: (turn) => [{ path: turn === 1 ? first : second, kind: 'image', source: 'rollout' }],
    text: () => result([]),
  });
  const out = await dispatcher.dispatch({ provider: 'codex', model: 'gpt-6-astra', task: 'Draw two', cwd: runRoot, taskClass: 'image_gen' }, { assistantSessionId: 'assistant-1' });
  const runId = out.run.runId;
  await waitFor(() => dispatcher.get(runId)?.state === 'idle');
  dispatcher.sendTurn(runId, 'one more', { origin: 'assistant' });
  const run = await waitFor(() => { const view = dispatcher.get(runId); return view?.turnCount === 2 && view.state === 'idle' ? view : null; });
  assert.equal(run.media.length, 1, 'the second turn\'s file is over what the run had left');
  assert.deepEqual(run.lastResult.media, []);
  assert.ok(run.notes.some((note) => /over the run's media budget/.test(note)));
});

test('review #4: Codex capture keeps only this thread\'s items and only its own files in generated_images/<thread>/', async (t) => {
  const { home, savedPath, rolloutPath } = codexHome(t);
  const at = new Date(Date.now() + 500).toISOString();
  const foreignPath = join(home, 'generated_images', 'thread-other', 'exec-other.png');
  mkdirSync(join(home, 'generated_images', 'thread-other'), { recursive: true });
  writeFileSync(foreignPath, PNG);
  const outside = join(tempDir(t, 'synabun-outside-'), 'stolen.png');
  writeFileSync(outside, PNG);
  const item = (threadId, path) => JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'item_completed', thread_id: threadId, item: { type: 'Extension', kind: 'image_gen.generation', id: 'exec-x', status: 'completed', savedPath: path } } });
  appendFileSync(rolloutPath, `${item('thread-other', foreignPath)}\n${item(THREAD, outside)}\n`);
  const text = readFileSync(rolloutPath, 'utf8');
  assert.equal(codexRolloutMedia(text).length, 3, 'unfiltered, the synthetic items would count');
  assert.deepEqual(codexRolloutMedia(text, { threadId: THREAD }).map((m) => m.path), [savedPath, outside], 'a foreign thread\'s item is dropped');
  assert.deepEqual((await collectCodexMedia({ codexHome: home, threadId: THREAD, sinceMs: Date.now() - 60_000 })).map((m) => m.path), [savedPath], 'and a path outside this thread\'s folder');
  // The folder scan: a symlink inside the thread's folder pointing out is not an image of this thread.
  const { home: scanHome, savedPath: scanSaved } = codexHome(t, { rollout: false });
  symlinkSync(outside, join(scanHome, 'generated_images', THREAD, 'exec-link.png'));
  assert.deepEqual((await collectCodexMedia({ codexHome: scanHome, threadId: THREAD, sinceMs: 0 })).map((m) => m.path), [scanSaved]);
  assert.deepEqual(ownCodexImages({ codexHome: home, threadId: THREAD, items: [{ path: savedPath }, { path: outside }, { path: foreignPath }] }).map((m) => m.path), [savedPath], 'stream items are held to the same rule');
});

// ── Re-review fixes (2026-09-28, Codex re-review run d01ecf10) ──────────────

test('re-review #1: the served file is opened once, O_NOFOLLOW, and must still be the file that was checked', async (t) => {
  const dir = tempDir(t, 'synabun-media-open-');
  const root = join(dir, 'media');
  mkdirSync(join(root, 'run-1'), { recursive: true });
  const file = join(root, 'run-1', '0-a.png');
  writeFileSync(file, PNG);
  const real = servableRunMedia(root, 'run-1', file);
  const ok = await openServable(real);
  assert.equal(ok.size, PNG.length);
  await ok.handle.close();
  const secret = join(dir, 'secret.txt');
  writeFileSync(secret, 'not an image');
  unlinkSync(file);
  symlinkSync(secret, file);
  assert.equal(await openServable(real), null, 'a symlink swapped in after the check is refused at open');
  mkdirSync(join(root, 'run-2'));
  writeFileSync(join(root, 'run-2', '0-a.png'), PNG);
  const real2 = servableRunMedia(root, 'run-2', join(root, 'run-2', '0-a.png'));
  const elsewhere = join(dir, 'elsewhere');
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, '0-a.png'), 'outside');
  rmSync(join(root, 'run-2'), { recursive: true });
  symlinkSync(elsewhere, join(root, 'run-2'));
  assert.equal(await openServable(real2), null, 'the run folder swapped for a symlink after the check');
});

test('re-review #3: the copy reads the handle it checked, stops at the cap while copying, and records what it copied; oversized base64 is never decoded', async (t) => {
  const dir = tempDir(t, 'synabun-media-grow-');
  const src = join(dir, 'grow.png');
  writeFileSync(src, Buffer.alloc(50, 1));
  const handle = await openFile(src, 'r');
  assert.equal((await handle.stat()).size, 50);
  appendFileSync(src, Buffer.alloc(100, 2));
  const capped = join(dir, 'capped.png');
  assert.equal(await copyOpenFile(handle, capped, 80), null, 'grew past the cap while copying');
  assert.equal(existsSync(capped), false, 'the partial copy is deleted');
  assert.equal(await copyOpenFile(handle, join(dir, 'whole.png'), 1000), 150, 'the bytes actually copied, not the size first seen');
  await handle.close();
  // The decoder is never reached for an inline item over its cap (a spy on Buffer.from).
  const oversized = Buffer.alloc(150, 7).toString('base64');
  const fitting = Buffer.alloc(60, 7).toString('base64');
  const decoded = [];
  const realFrom = Buffer.from;
  Buffer.from = function spy(value, ...rest) { if (value === oversized || value === fitting) decoded.push(value === oversized ? 'oversized' : 'fitting'); return realFrom.call(this, value, ...rest); };
  let copied;
  try {
    copied = await copyRunMedia({ root: join(dir, 'media'), runId: 'run-x', items: [{ data: oversized, mime: 'image/png', kind: 'image' }, { data: fitting, mime: 'image/png', kind: 'image' }], maxInlineBytes: 100 });
  } finally { Buffer.from = realFrom; }
  assert.deepEqual(decoded, ['fitting'], 'only the item that fits is ever decoded');
  assert.deepEqual(copied.map((m) => m.bytes), [60]);
});

test('re-review #4: a symlinked generated_images/<thread> folder (another thread\'s images) is never collected', async (t) => {
  const { home } = codexHome(t, { rollout: false });
  mkdirSync(join(home, 'generated_images', 'thread-b'), { recursive: true });
  writeFileSync(join(home, 'generated_images', 'thread-b', 'exec-b.png'), PNG);
  symlinkSync(join(home, 'generated_images', 'thread-b'), join(home, 'generated_images', 'thread-a'));
  assert.deepEqual(scanCodexGeneratedImages({ codexHome: home, threadId: 'thread-a' }), []);
  assert.deepEqual(await collectCodexMedia({ codexHome: home, threadId: 'thread-a', sinceMs: 0 }), []);
  assert.deepEqual(ownCodexImages({ codexHome: home, threadId: 'thread-a', items: [{ path: join(home, 'generated_images', 'thread-a', 'exec-b.png') }] }), []);
  assert.equal((await collectCodexMedia({ codexHome: home, threadId: 'thread-b', sinceMs: 0 })).length, 1, 'thread B keeps its own image');
  const linkedHome = join(tempDir(t, 'synabun-codex-link-'), 'home');
  symlinkSync(home, linkedHome);
  assert.equal((await collectCodexMedia({ codexHome: linkedHome, threadId: THREAD, sinceMs: 0 })).length, 1, 'a CODEX_HOME reached through a symlink still works');
});

test('re-review #2 (dispatch): nothing connected on OpenCode — a dispatch there is refused, named model or not', async (t) => {
  const empty = { ...CATALOG, models: { ...CATALOG.models, opencode: parseOpenCodeProviders({ ok: true, data: { all: OPENCODE_MEDIA.data.all, default: {}, connected: [] } }) }, known: { opencode: true } };
  const { root, dispatcher } = mediaHarness(t, { text: () => result([]), catalog: empty });
  await assert.rejects(dispatcher.dispatch({ provider: 'opencode', model: 'media-lab/text-only', task: 'Fix it', cwd: root }, { assistantSessionId: 'assistant-1' }), (error) => error.code === 'PROVIDER_NOT_CONNECTED');
  await assert.rejects(dispatcher.dispatch({ provider: 'opencode', task: 'Fix it', cwd: root }, { assistantSessionId: 'assistant-1' }), (error) => error.code === 'PROVIDER_NOT_CONNECTED');
});

test('final #3: short writes are finished, and a copy is kept only when the source still matches what was written', async (t) => {
  const dir = tempDir(t, 'synabun-media-short-');
  const src = join(dir, 'src.png');
  writeFileSync(src, Buffer.alloc(300, 5));
  const handle = await openFile(src, 'r');
  const target = (write) => async (path) => { const real = await openFile(path, 'wx'); return { write: (...args) => write(real, ...args), close: () => real.close() }; };
  const halfWrites = target((real, buf, offset, length) => real.write(buf, offset, Math.max(1, Math.floor(length / 2))));
  const out = join(dir, 'out.png');
  assert.equal(await copyOpenFile(handle, out, 1000, { openTarget: halfWrites }), 300);
  assert.deepEqual(readFileSync(out), readFileSync(src), 'every byte, despite short writes');
  assert.equal(await copyOpenFile(handle, join(dir, 'stuck.png'), 1000, { openTarget: target(async () => ({ bytesWritten: 0 })) }), null);
  assert.equal(existsSync(join(dir, 'stuck.png')), false, 'a write that makes no progress: the partial copy is deleted');
  const changed = { read: (...args) => handle.read(...args), stat: async () => ({ size: 999 }) };
  assert.equal(await copyOpenFile(changed, join(dir, 'changed.png'), 1000), null);
  assert.equal(existsSync(join(dir, 'changed.png')), false, 'the source no longer matches what was written: deleted');
  await handle.close();
});
