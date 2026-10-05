// WhatsApp Link end to end, in one process: the REAL service and its HTTP
// router, the REAL manager in inproc mode running the REAL host core over the
// fake Baileys socket (SYNABUN_WHATSAPP_FAKE=1), the REAL bridge with the real
// format / inbound modules (the 1.5 s coalescer), and the real Assistant
// runtime with a scripted brain — an in-memory kv and a temporary data home.
// Walks: setup → link (NDJSON) → scan → confirm the owner → a message and its
// reply (to the owner's JID only) → a stranger ignored → a permission card
// answered "1" → /stop → selfTrigger 'prefix' → pause / resume → an offline
// backlog skipped with its note → unlink wiping the session.
process.env.SYNABUN_TYPESAFE = 'off';
process.env.SYNABUN_WHATSAPP_FAKE = '1';
process.env.SYNABUN_WHATSAPP_HOST = 'inproc';
delete process.env.SYNABUN_WHATSAPP_HOME;
delete process.env.SYNABUN_WHATSAPP;

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_HOME = mkdtempSync(join(tmpdir(), 'synabun-wa-e2e-'));
process.env.SYNABUN_DATA_HOME = DATA_HOME; // never the user's ~/.synabun

const { default: express } = await import('express');
const { createWhatsAppService } = await import('../lib/whatsapp/service.js');
const { createWhatsAppManager } = await import('../lib/whatsapp/manager.js');
const { createAssistantRuntime } = await import('../lib/assistant-runtime.js');
const { defaultRemotePolicyRegistry } = await import('../lib/remote-policy.js');
const { fake } = await import('../lib/whatsapp/fake-baileys.js');
const { sameAccount } = await import('../lib/whatsapp/identity.js');
const { openAuthStore } = await import('../lib/whatsapp/auth-store.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let diagnose = () => '';
async function waitFor(fn, { timeout = 10_000, step = 20, what = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`waitFor timed out: ${what} (${diagnose()})`);
    await wait(step);
  }
}

/** The scripted brain of tests/whatsapp-bridge.test.mjs: text, a result, permission asks it waits on. */
function scriptedBrainFactory(log, behave) {
  return ({ session, sink }) => {
    let busy = false;
    let token = 0;
    const waiters = new Map();
    return {
      kind: session.brain.provider,
      async start() {},
      async sendUserTurn({ text, permissionMode, planMode }) {
        log.push(['turn', text, { permissionMode, planMode }]);
        busy = true;
        const mine = ++token;
        const live = () => mine === token;
        const api = {
          text: (t) => { if (live()) sink.send({ type: 'event', event: { type: 'assistant', uuid: `u-${Math.random()}`, message: { role: 'assistant', content: [{ type: 'text', text: t }] } } }); },
          result: (t) => { if (live()) sink.send({ type: 'event', event: { type: 'result', subtype: 'success', result: t } }); },
          ask: (id, tool, input) => new Promise((resolveAsk) => { waiters.set(id, resolveAsk); sink.send({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: tool, input } }); }),
          hold: () => new Promise(() => {}),
        };
        Promise.resolve().then(() => behave(text, api)).catch(() => {}).finally(() => {
          if (!live()) return;
          busy = false;
          sink.send({ type: 'done', code: 0 });
        });
      },
      async abort() {
        log.push(['abort']);
        token += 1;
        for (const [, done] of waiters) done({ behavior: 'deny' });
        waiters.clear();
        busy = false;
        sink.send({ type: 'aborted' });
      },
      async setPermissionMode(mode, opts) { log.push(['mode', mode, opts?.planMode === true]); },
      respondControl(id, response) { log.push(['brain-control', id, response]); const done = waiters.get(id); waiters.delete(id); done?.(response); },
      isBusy: () => busy,
      identity: () => ({}),
      async dispose() { log.push(['dispose']); },
    };
  };
}

async function behave(text, api) {
  if (/delete the build folder/.test(text)) {
    const answer = await api.ask('toolu_rm_1', 'Bash', { command: 'rm -rf build' });
    api.result(answer?.behavior === 'allow' ? 'Deleted the build folder.' : 'Left it alone.');
    return;
  }
  if (/pick a database/.test(text)) {
    const answer = await api.ask('toolu_q_1', 'AskUserQuestion', { questions: [{ question: 'Which database?', header: 'DB', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] });
    api.result(`Using: ${Object.values(answer?.updatedInput?.answers || {}).join('') || 'nothing'}`);
    return;
  }
  if (/wipe the cache/.test(text)) {
    const answer = await api.ask('toolu_rm_2', 'Bash', { command: 'rm -rf .cache' });
    api.result(answer?.behavior === 'allow' ? 'Wiped the cache.' : 'OK.');
    return;
  }
  if (/think for a long time/.test(text)) { await api.hold(); return; }
  api.text(`echo: ${text}`);
  api.result(`echo: ${text}`);
}

test('WhatsApp Link end to end (fake phone, inproc host, real bridge and Assistant runtime)', { timeout: 120_000 }, async (t) => {
  t.after(() => rmSync(DATA_HOME, { recursive: true, force: true }));
  fake.reset();
  const brainLog = [];
  const factory = scriptedBrainFactory(brainLog, behave);
  const runtime = createAssistantRuntime({
    dataDir: join(DATA_HOME, 'data', 'loops'), detectProject: () => 'proj',
    buildCatalog: async () => ({ models: {} }),
    brainFactories: { 'claude-code': factory, codex: factory, opencode: factory },
    config: { mailboxBatchMs: 10 },
    registeredProjects: () => [DATA_HOME],
  });
  const stoppedRuns = [];
  const dispatcher = {
    list: ({ assistantSessionId }) => (assistantSessionId && !stoppedRuns.length ? [{ runId: 'run-wa-1', assistantSessionId }] : []),
    stop: async (runId, reason) => { stoppedRuns.push([runId, reason]); },
  };
  const kv = new Map();
  const broadcasts = [];
  let port = 0;
  const service = createWhatsAppService({
    dataHome: DATA_HOME,
    port: () => port,
    getRuntime: () => runtime,
    getDispatcher: () => dispatcher,
    getKvConfig: (key) => kv.get(key) ?? null,
    setKvConfig: (key, value) => { kv.set(key, String(value)); },
    broadcastSync: (message) => broadcasts.push(JSON.parse(JSON.stringify(message))),
    isGuestRequest: () => false,
    getDefaultBrain: () => ({ provider: 'claude-code' }),
    bridgeLimits: { onItMs: 600_000, stillFirstMs: 600_000, staleNoticeMs: 100, drainMs: 20, busyRetryMs: 200, dispatchBatchMs: 600_000 },
    limits: { broadcastDebounceMs: 0 },
    // The real manager, in process: the walk sends ~11 replies in half a minute, past the
    // 10-a-minute cap it would otherwise wait out in real time. The caps and the THROTTLED
    // re-send are covered by whatsapp-host-core.test.mjs and whatsapp-bridge.test.mjs.
    managerFactory: (opts) => createWhatsAppManager({ ...opts, mode: 'inproc', hostOptions: { sendCaps: [{ windowMs: 60_000, max: 100 }, { windowMs: 3_600_000, max: 500 }, { windowMs: 86_400_000, max: 1000 }] } }),
  });
  const app = express();
  app.use(express.json());
  app.use('/api/whatsapp', service.router);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  port = server.address().port;
  t.after(async () => {
    await service.shutdown({ timeoutMs: 1000 }).catch(() => {});
    await runtime.shutdown();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    fake.reset();
  });
  assert.equal(service._internals.manager.mode, 'inproc');
  await service.start();

  // ── HTTP, the way the Settings tab calls it ──
  const headers = (payload) => ({ Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', 'X-SynaBun-UI': '1', 'Content-Length': Buffer.byteLength(payload) });
  const call = (method, path, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: `/api/whatsapp${path}`, headers: body === undefined ? {} : headers(payload) }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(text) }); } catch { resolve({ status: res.statusCode, json: null, text }); } });
    });
    req.on('error', reject);
    req.end(payload || undefined);
  });
  const stream = (path, body) => {
    const s = { events: [], ended: false, req: null };
    const payload = JSON.stringify(body);
    s.req = http.request({ host: '127.0.0.1', port, method: 'POST', path: `/api/whatsapp${path}`, headers: headers(payload) }, (res) => {
      s.status = res.statusCode;
      s.type = res.headers['content-type'];
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) !== -1) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) s.events.push(JSON.parse(line)); }
      });
      res.on('end', () => { s.ended = true; });
    });
    s.req.on('error', () => { s.ended = true; });
    s.req.end(payload);
    s.until = (pred, what) => waitFor(() => s.events.find(pred), { what });
    return s;
  };
  const status = async () => (await call('GET', '/status')).json;
  const phone = async (body) => {
    const r = await call('POST', '/__fake', body);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json;
  };
  const sent = () => fake.state.sent.filter((row) => row.kind === 'text');
  const texts = () => sent().map((row) => row.text);
  const saidMatching = (re) => texts().filter((text) => re.test(text));
  const turns = () => brainLog.filter((row) => row[0] === 'turn').map((row) => row[1]);
  diagnose = () => `last sent: ${JSON.stringify(texts().slice(-4))}; brain: ${JSON.stringify(brainLog.slice(-3))}`;

  // 1. setup
  assert.equal((await status()).state, 'ready', 'the fake connector counts as installed');
  const setup = await call('POST', '/setup', { mode: 'self', method: 'qr' });
  assert.deepEqual([setup.status, setup.json.next], [200, 'link']);

  // 2. link: the QR only goes down this stream
  const link = stream('/link', { method: 'qr' });
  const qr = await link.until((e) => e.type === 'qr', 'the link QR');
  assert.match(link.type, /application\/x-ndjson/);
  assert.match(qr.svg, /^<svg/);
  assert.equal((await status()).state, 'linking');
  assert.ok(broadcasts.every((m) => !JSON.stringify(m).includes('svg')), 'the QR never leaves through a broadcast');

  // 3. the phone scans
  await phone({ action: 'scan' });
  await link.until((e) => e.type === 'linked', 'linked');
  await waitFor(() => link.ended, { what: 'the link stream ends' });

  // 4. confirm the owner ("This is me — start")
  const confirming = await waitFor(async () => { const s = await status(); return s.state === 'confirm_owner' ? s : null; }, { what: 'confirm_owner' });
  assert.equal(confirming.confirm.kind, 'self');
  assert.match(confirming.account.masked, /^••••\d{4}$/);
  assert.equal((await call('POST', '/owner/confirm', { accept: true })).status, 200);
  await waitFor(async () => (await status()).state === 'connected', { what: 'connected' });
  const account = fake.state.account;
  const toOwner = (jid) => sameAccount(jid, `${account.pn}@s.whatsapp.net`) || sameAccount(jid, `${account.lid}@lid`);

  // 5-6. a message from the owner → the Assistant → the reply reaches ONLY the owner's JID
  await phone({ action: 'inbound', from: 'owner', text: 'hello from the phone' });
  await waitFor(() => saidMatching(/^SynaBun: echo: hello from the phone$/).length === 1, { what: 'the reply' });
  assert.deepEqual(turns(), ['hello from the phone']);
  const sessionId = (await status()).session?.id;
  assert.match(sessionId, /^assistant-/);
  const session = runtime.getSession(sessionId, { transcript: true });
  assert.equal(session.channel, 'whatsapp');
  assert.match(session.title, /^WhatsApp · /);
  assert.ok(session.transcript.some((e) => e.packet?.event?.type === 'synabun.user_prompt' && e.packet.event.origin === 'whatsapp'), 'journaled with its origin');
  assert.equal(defaultRemotePolicyRegistry.getSessionPolicy(sessionId)?.level, 'ask', 'the shared registry holds its level');
  assert.ok(fake.state.sent.length > 0 && fake.state.sent.every((row) => toOwner(row.jid)), 'every send went to the owner');

  // 7. a stranger: ignored, no reply, never the Assistant (the ✅ on the owner's message still arrives, paced)
  const before = texts().length;
  await phone({ action: 'inbound', from: 'stranger', text: 'hi, who is this?' });
  await wait(2200);
  assert.equal(texts().length, before, 'no reply to a stranger');
  assert.deepEqual(turns(), ['hello from the phone']);
  assert.ok(fake.state.sent.some((row) => row.kind === 'react' && row.react?.text === '✅'), 'the owner\'s message got its ✅');
  assert.ok(fake.state.sent.every((row) => toOwner(row.jid)), 'nothing was ever addressed to anyone but the owner');
  assert.ok(fake.state.ignoredByJid >= 1, 'self mode: the socket drops other senders before decrypting (shouldIgnoreJid)');

  // 8. an approval: the brain asks, SynaBun asks like a person, the phone answers "yes"
  await phone({ action: 'inbound', from: 'owner', text: 'please delete the build folder' });
  await waitFor(() => saidMatching(/OK to go ahead\? \(yes \/ no\)/).length === 1, { what: 'the approval question' });
  assert.match(saidMatching(/OK to go ahead/)[0], /^SynaBun: I need your OK to run this:\nBash: `rm -rf build`\nOK to go ahead\? \(yes \/ no\)$/);
  await phone({ action: 'inbound', from: 'owner', text: 'yes' });
  await waitFor(() => saidMatching(/^SynaBun: Deleted the build folder\.$/).length === 1, { what: 'the result after "yes"' });
  const control = brainLog.find((row) => row[0] === 'brain-control' && row[1] === 'toolu_rm_1');
  assert.equal(control?.[2]?.behavior, 'allow');
  assert.ok(saidMatching(/^SynaBun: OK, going ahead\.$/).length === 1, 'the phone got the acknowledgement');

  // 8b. a question: plain text, no numbered options; whatever the owner writes is the answer
  await phone({ action: 'inbound', from: 'owner', text: 'pick a database for the app' });
  await waitFor(() => saidMatching(/Which database\?/).length === 1, { what: 'the question' });
  assert.equal(saidMatching(/Which database\?/)[0], 'SynaBun: Which database? Postgres or SQLite, or tell me something else.');
  await phone({ action: 'inbound', from: 'owner', text: 'the one that is easiest to back up' });
  await waitFor(() => saidMatching(/^SynaBun: Using: the one that is easiest to back up$/).length === 1, { what: 'the brain carried on with the answer' });
  assert.ok(!turns().includes('the one that is easiest to back up'), 'an answer, not a second prompt');

  // 8c. an approval the owner does not answer: their message denies it and is the next prompt
  await phone({ action: 'inbound', from: 'owner', text: 'wipe the cache' });
  await waitFor(() => saidMatching(/rm -rf \.cache/).length === 1, { what: 'the second approval question' });
  await phone({ action: 'inbound', from: 'owner', text: 'actually never mind, how big is it?' });
  await waitFor(() => saidMatching(/^SynaBun: echo: actually never mind, how big is it\?$/).length === 1, { what: 'the conversation carried on' });
  assert.equal(brainLog.find((row) => row[0] === 'brain-control' && row[1] === 'toolu_rm_2')?.[2]?.behavior, 'deny', 'never approved');
  assert.equal(saidMatching(/Wiped the cache|still waiting|Queued your message/).length, 0);

  // 9. /stop: the running turn and the session's runs
  await phone({ action: 'inbound', from: 'owner', text: 'think for a long time about it' });
  await waitFor(() => turns().includes('think for a long time about it'), { what: 'the long turn started' });
  await phone({ action: 'inbound', from: 'owner', text: '/stop' });
  await waitFor(() => saidMatching(/^SynaBun: Stopped\. Cancelled 1 task\.$/).length === 1, { what: 'the /stop answer' });
  assert.ok(brainLog.some((row) => row[0] === 'abort'), 'the turn was aborted');
  assert.deepEqual(stoppedRuns, [['run-wa-1', 'user']]);
  await waitFor(() => !runtime.isBusy(sessionId), { what: 'idle again' });

  // 10. selfTrigger 'prefix': "sb hello" reaches the Assistant, /status passes, a plain note is dropped
  const cfg = (await call('GET', '/config')).json;
  const put = await call('PUT', '/config', { config: { selfTrigger: 'prefix' }, expectedVersion: cfg.version });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  await phone({ action: 'inbound', from: 'owner', text: 'sb hello' });
  await waitFor(() => saidMatching(/^SynaBun: echo: hello$/).length === 1, { what: 'sb hello' });
  await phone({ action: 'inbound', from: 'owner', text: '/status' });
  await waitFor(() => saidMatching(/SynaBun status/).length === 1, { what: '/status' });
  const noteBefore = texts().length;
  await phone({ action: 'inbound', from: 'owner', text: 'buy milk tomorrow' });
  await wait(2000);
  assert.equal(texts().length, noteBefore, 'a note to self gets no answer');
  assert.ok(!turns().some((text) => /milk/.test(text)), 'and never reaches the Assistant');
  const activity = (await call('GET', '/activity?limit=200')).json;
  assert.ok(!JSON.stringify(activity).includes('milk'), 'nor the activity log');
  const back = await call('PUT', '/config', { config: { selfTrigger: 'all' }, expectedVersion: put.json.version });
  assert.equal(back.status, 200);

  // 11. pause from the computer: one notice, no turn; resume: answers again
  assert.equal((await call('POST', '/pause', {})).status, 200);
  assert.equal((await status()).state, 'paused');
  await phone({ action: 'inbound', from: 'owner', text: 'are you there?' });
  await waitFor(() => saidMatching(/paused from your computer/).length === 1, { what: 'the paused notice' });
  assert.ok(!turns().includes('are you there?'));
  assert.equal((await call('POST', '/resume', {})).status, 200);
  await waitFor(async () => (await status()).state === 'connected', { what: 'resumed' });
  await phone({ action: 'inbound', from: 'owner', text: 'back again' });
  await waitFor(() => saidMatching(/^SynaBun: echo: back again$/).length === 1, { what: 'answers after resume' });

  // 12. offline delivery: held for 30 minutes → skipped with one note; held for 3 minutes → answered
  await phone({ action: 'inbound', from: 'owner', text: 'sent while you were off', offline: true, ageMs: 30 * 60_000 });
  await waitFor(() => saidMatching(/I was offline and skipped 1 older message; resend what you still need\./).length === 1, { what: 'the skipped note' });
  assert.ok(!turns().includes('sent while you were off'), 'not acted on');
  await phone({ action: 'inbound', from: 'owner', text: 'sent a moment ago', offline: true, ageMs: 3 * 60_000 });
  await waitFor(() => saidMatching(/^SynaBun: echo: sent a moment ago$/).length === 1, { what: 'a recent held message is answered' });
  assert.ok(fake.state.sent.every((row) => toOwner(row.jid)), 'still only the owner');

  // 13. unlink: logged out on WhatsApp, the session wiped
  const authDir = service._internals.paths.authDir;
  const unlinked = await call('POST', '/unlink', {});
  assert.deepEqual([unlinked.status, unlinked.json.loggedOut], [200, true]);
  assert.equal(fake.state.logouts, 1);
  const after = await status();
  assert.equal(after.state, 'ready');
  assert.equal(after.owner, null);
  assert.equal(JSON.parse(kv.get('whatsapp_config')).sessionId, null);
  assert.ok(existsSync(authDir) && readdirSync(authDir).includes('state.db'));
  const store = openAuthStore({ authDir });
  try {
    assert.equal(store.loadCreds(), null, 'no credentials left');
  } finally {
    store.close();
  }
  // Nothing secret ever went out through a broadcast.
  const leaked = JSON.stringify(broadcasts);
  for (const secret of [account.pn, account.lid, 'hello from the phone', '<svg']) assert.ok(!leaked.includes(secret), `broadcasts never carry ${secret}`);
});
