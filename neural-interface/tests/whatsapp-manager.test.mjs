// WhatsApp Link manager: the forked host (real host.js over IPC with the fake
// runtime, plus tiny stub hosts for failure modes), the allowlisted child
// environment, respawn + crash breaker, protocol mismatch, stdout redaction,
// request timeouts, stop escalation and the in-process mode.
process.env.SYNABUN_TYPESAFE = 'off';

import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHostEnv, createWhatsAppManager, hostExecArgv } from '../lib/whatsapp/manager.js';
import { loadRuntime } from '../lib/whatsapp/baileys-adapter.js';
import { CONN, ERR, PROTOCOL_VERSION } from '../lib/whatsapp/protocol.js';

const EVENTS = ['state', 'qr', 'pairing_code', 'linked', 'owner_bound', 'inbound', 'ignored', 'throttled', 'fatal'];
const SECRETS = {
  ANTHROPIC_API_KEY: 'sk-ant-api03-secretsecretsecretsecret',
  OPENAI_API_KEY: 'sk-proj-secretsecretsecretsecret',
  TYPESAFE_API_KEY: 'ts-secret-value-123',
  DISCORD_BOT_TOKEN: 'discord.bot.token.value',
  GITHUB_TOKEN: 'ghp_secretsecretsecretsecretsecret',
  NODE_OPTIONS: '--require /tmp/evil.js',
};

async function waitFor(pred, label = 'condition', timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function tempHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'synabun-wa-mgr-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function harness(t, opts = {}) {
  const dataHome = opts.dataHome || tempHome(t);
  const logs = [];
  const events = [];
  const forks = [];
  const m = createWhatsAppManager({
    dataHome,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, SYNABUN_WHATSAPP_FAKE: '1', ...SECRETS, ...(opts.env || {}) },
    forkImpl: (path, args, options) => {
      forks.push({ path, args, options });
      return fork(opts.hostPath || path, args, options);
    },
    log: (msg, level) => logs.push({ msg, level }),
    respawnBackoffMs: [60, 120, 240],
    readyTimeoutMs: 8000,
    requestTimeoutMs: 4000,
    sendTimeoutMs: 8000,
    ...opts,
    ...(opts.hostPath ? { hostPath: opts.hostPath } : {}),
  });
  for (const name of EVENTS) m.on(name, (payload) => events.push({ name, payload }));
  t.after(() => m.stop({ timeoutMs: 1500 }));
  return { m, logs, events, forks, dataHome };
}

/** A minimal host that speaks just enough of the protocol. */
function stubHost(t, body) {
  const dir = mkdtempSync(join(tmpdir(), 'synabun-wa-stub-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'stub-host.mjs');
  writeFileSync(file, `
const conn = { state: 'unlinked', mode: null, registered: false, me: null, owner: null, lastDisconnect: null, retryInMs: null,
  counters: {}, paused: false, awaitingConfirmUntil: null, claim: null, lastError: null };
const runtime = { loaded: true, version: 'stub', fake: true, error: null };
const ready = (protocol = ${PROTOCOL_VERSION}) => process.send({ t: 'ready', protocol, pid: process.pid, runtime, conn });
process.on('disconnect', () => process.exit(0));
${body}
`);
  return file;
}

test('buildHostEnv: allowlist plus SYNABUN_WHATSAPP_*, case-insensitive on Windows', () => {
  const env = buildHostEnv({
    PATH: '/bin', HOME: '/h', LANG: 'en_US.UTF-8', HTTPS_PROXY: 'http://proxy', NODE_EXTRA_CA_CERTS: '/ca.pem',
    SYNABUN_WHATSAPP_FAKE: '1', SYNABUN_WHATSAPP_HOST_CONFIG: '{"evil":true}', SYNABUN_DATA_HOME: '/d', ...SECRETS,
  }, { platform: 'darwin', extra: { SYNABUN_WHATSAPP_HOST_CONFIG: '{"paths":{}}' } });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'HTTPS_PROXY', 'LANG', 'NODE_EXTRA_CA_CERTS', 'PATH', 'SYNABUN_WHATSAPP_FAKE', 'SYNABUN_WHATSAPP_HOST_CONFIG']);
  assert.equal(env.SYNABUN_WHATSAPP_HOST_CONFIG, '{"paths":{}}', 'the config comes from the manager, never from the parent env');
  const win = buildHostEnv({ Path: 'C:\\x', SystemRoot: 'C:\\Windows', comspec: 'cmd.exe', UserProfile: 'C:\\u', ANTHROPIC_API_KEY: 'x' }, { platform: 'win32' });
  assert.deepEqual(Object.keys(win).sort(), ['Path', 'SystemRoot', 'UserProfile', 'comspec']);
  const posix = buildHostEnv({ Path: '/x', path: '/y' }, { platform: 'linux' });
  assert.deepEqual(posix, {}, 'names are exact on POSIX');
});

test('hostExecArgv strips debugger, profiler, report, preload and env-file flags', () => {
  const out = hostExecArgv([
    '--inspect=9229', '--inspect-brk', '--heapsnapshot-signal', 'SIGUSR2', '--report-on-signal', '--report-dir', '/r', '--cpu-prof',
    '--require', 'dotenv/config', '-r', 'x', '--import', 'y', '--env-file=.env', '--max-old-space-size=8192', '--experimental-sqlite',
    '--stack-size=900', '--trace-warnings',
  ], { nodeVersion: '24.1.0' });
  assert.deepEqual(out, ['--experimental-sqlite', '--stack-size=900', '--disable-warning=ExperimentalWarning', '--max-old-space-size=512']);
  assert.ok(hostExecArgv([], { nodeVersion: '22.5.1' }).includes('--experimental-sqlite'), 'node:sqlite needs the flag before 22.13');
  assert.ok(!hostExecArgv([], { nodeVersion: '22.13.0' }).includes('--experimental-sqlite'));
});

test('fork: allowlisted env (no API keys or tokens), advanced IPC, piped stdio, cwd = waHome 0700', async (t) => {
  const h = harness(t);
  const r = await h.m.start({ mode: 'self', token: 'ignored' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const { options } = h.forks[0];
  for (const key of Object.keys(SECRETS)) assert.equal(options.env[key], undefined, `${key} never reaches the host`);
  assert.equal(options.env.SYNABUN_WHATSAPP_FAKE, '1');
  assert.ok(options.env.PATH);
  const config = JSON.parse(options.env.SYNABUN_WHATSAPP_HOST_CONFIG);
  assert.equal(config.paths.waHome, join(h.dataHome, 'whatsapp'));
  assert.equal(options.serialization, 'advanced');
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe', 'ipc']);
  assert.equal(options.cwd, join(h.dataHome, 'whatsapp'));
  assert.equal(options.windowsHide, true);
  assert.ok(!options.execArgv.some((a) => /^--inspect/.test(a)));
  if (process.platform !== 'win32') assert.equal(statSync(options.cwd).mode & 0o777, 0o700);
  const st = h.m.status();
  assert.equal(st.host.state, 'running');
  assert.equal(st.conn.state, CONN.UNLINKED);
  assert.deepEqual(st.runtime, { loaded: true, version: 'fake', fake: true, error: null });
});

test('end to end over IPC: link, confirm, inbound without JIDs, reply to the owner only', async (t) => {
  const h = harness(t);
  await h.m.start({ mode: 'self' });
  const link = await h.m.connect({ purpose: 'link', mode: 'self', link: { method: 'qr' } });
  assert.equal(link.ok, true, JSON.stringify(link));
  await waitFor(() => h.events.some((e) => e.name === 'qr'), 'qr');
  await h.m.fake('scan', {});
  await waitFor(() => h.m.status().conn.state === CONN.AWAITING_CONFIRM, 'awaiting_confirm');
  assert.equal((await h.m.confirmOwner(true)).ok, true);
  await h.m.fake('inbound', { from: 'self', text: 'hello over ipc' });
  await waitFor(() => h.events.some((e) => e.name === 'inbound'), 'inbound');
  const inbound = h.events.find((e) => e.name === 'inbound').payload;
  assert.deepEqual(Object.keys(inbound).sort(), ['chat', 'forwarded', 'id', 'images', 'owner', 'quoted', 'text', 'ts', 'unsupported'], 'listeners get the InboundMessage itself');
  assert.equal(inbound.text, 'hello over ipc');
  const sent = await h.m.send('hi back', { replyTo: inbound.id });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.match(sent.id, /^FAKEOUT/);
  assert.equal((await h.m.react(inbound.id, 'done')).ok, true);
  const bad = await h.m.react(inbound.id, 'love');
  assert.deepEqual([bad.ok, bad.code], [false, ERR.BAD_REQUEST]);
  const snap = await h.m.fake('snapshot');
  assert.ok(snap.sent.length >= 2);
  for (const s of snap.sent) assert.equal(s.jid, '15550001111@s.whatsapp.net');
  const serialized = JSON.stringify(h.events.filter((e) => e.name !== 'qr'));
  assert.doesNotMatch(serialized, /@s\.whatsapp\.net|@lid|15550001111/);
  assert.equal(h.m.status().conn.me.masked, '••••1111');
});

test('respawn after a crash: backoff, configure + connect replayed, the link comes back', async (t) => {
  const h = harness(t);
  await h.m.start({ mode: 'self', selfTrigger: 'all' });
  await h.m.connect({ purpose: 'link', mode: 'self' });
  await waitFor(() => h.events.some((e) => e.name === 'qr'), 'qr');
  await h.m.fake('scan', {});
  await waitFor(() => h.m.status().conn.state === CONN.AWAITING_CONFIRM, 'awaiting_confirm');
  await h.m.confirmOwner(true);
  const firstPid = h.m.status().host.pid;
  await h.m.fake('crash');
  await waitFor(() => h.events.some((e) => e.name === 'fatal' && e.payload.code === 'CRASH'), 'fatal CRASH');
  await waitFor(() => h.m.status().host.restarts === 1 && h.m.status().host.state === 'running', 'respawned');
  assert.notEqual(h.m.status().host.pid, firstPid);
  await waitFor(() => h.m.status().conn.state === CONN.OPEN, 'the link reconnected by itself');
  await h.m.fake('inbound', { from: 'self', text: 'after the crash' });
  await waitFor(() => h.events.some((e) => e.name === 'inbound' && e.payload.text === 'after the crash'), 'inbound after respawn');
  assert.equal(h.forks.length, 2);
});

test('crash breaker: 3 exits inside the window → held until start() again', async (t) => {
  const hostPath = stubHost(t, 'setTimeout(() => process.exit(3), 30);');
  const h = harness(t, { hostPath, crashLimit: 3 });
  const r = await h.m.start();
  assert.equal(r.ok, false);
  await waitFor(() => h.m.status().host.state === 'held', 'held');
  const st = h.m.status();
  assert.equal(st.conn.state, CONN.HELD);
  assert.match(st.host.lastError, /crashed 3 times/);
  assert.ok(h.events.some((e) => e.name === 'fatal' && e.payload.code === 'HOST_HELD'));
  const req = await h.m.send('x');
  assert.deepEqual([req.ok, req.code], [false, ERR.HELD]);
  const forks = h.forks.length;
  await new Promise((r2) => setTimeout(r2, 400));
  assert.equal(h.forks.length, forks, 'no respawn while held');
  h.m.start().catch(() => {});
  await waitFor(() => h.forks.length > forks, 'start() clears the breaker');
});

test('a host speaking another protocol version is killed and held', async (t) => {
  const hostPath = stubHost(t, 'ready(999); setInterval(() => {}, 1000);');
  const h = harness(t, { hostPath });
  const r = await h.m.start();
  assert.deepEqual([r.ok, r.code], [false, ERR.HELD]);
  assert.match(h.m.status().host.lastError, /protocol mismatch \(host speaks 999, expected 1\)/);
  await waitFor(() => h.m.status().host.pid === null, 'killed');
});

test('stdout and stderr are redacted before they reach the log', async (t) => {
  const hostPath = stubHost(t, `
console.log('dialing +55 11 99999-8888 for 15551234567@s.whatsapp.net');
console.error('key sk-ant-api03-abcdefghijklmnopqrstuvwxyz code SB-123456 qr https://wa.me/settings/linked_devices#2@abcdefghijklmnopqrstuv,AAAA');
ready();
setInterval(() => {}, 1000);`);
  const h = harness(t, { hostPath });
  await h.m.start();
  await waitFor(() => h.logs.filter((l) => l.msg.startsWith('[whatsapp-host]')).length >= 2, 'host lines');
  const lines = h.logs.filter((l) => l.msg.startsWith('[whatsapp-host]')).map((l) => l.msg).join('\n');
  assert.doesNotMatch(lines, /99999|15551234567|whatsapp\.net|sk-ant|SB-123456|linked_devices/);
  assert.match(lines, /\[number\]/);
  assert.match(lines, /other#[0-9a-f]{8}/);
  assert.match(lines, /\[redacted:api-key\]/);
  assert.match(lines, /\[code\]/);
  assert.match(lines, /\[qr\]/);
  assert.ok(h.logs.some((l) => l.level === 'warn' && l.msg.includes('[redacted:api-key]')), 'stderr logs at warn');
});

test('requests time out; stop() escalates shutdown → SIGTERM → SIGKILL', async (t) => {
  // This host never answers, ignores the shutdown op and ignores SIGTERM.
  const hostPath = stubHost(t, `
process.on('SIGTERM', () => {});
ready();
setInterval(() => {}, 1000);`);
  const h = harness(t, { hostPath, requestTimeoutMs: 300, sendTimeoutMs: 300 });
  await h.m.start();
  const res = await h.m.connect({ purpose: 'run' });
  assert.deepEqual([res.ok, res.code], [false, ERR.TIMEOUT]);
  const send = await h.m.send('x');
  assert.deepEqual([send.ok, send.code], [false, ERR.TIMEOUT], 'every method resolves, none rejects');
  const started = Date.now();
  const pid = h.m.status().host.pid;
  await h.m.stop({ timeoutMs: 600 });
  assert.ok(Date.now() - started < 3000);
  assert.throws(() => process.kill(pid, 0), 'the stubborn host is gone');
  assert.equal(h.m.status().host.state, 'stopped');
});

test('an event with a JID field never reaches listeners', async (t) => {
  const hostPath = stubHost(t, `
ready();
setTimeout(() => {
  process.send({ t: 'inbound', message: { id: 'X1', ts: 1, chat: '15551234567@s.whatsapp.net', text: 'x', images: [], unsupported: null, forwarded: false, quoted: null, owner: true } });
  process.send({ t: 'owner_bound', masked: '••••1234', via: 'claim', pn: '15551231234@s.whatsapp.net' });
  process.send({ t: 'owner_bound', masked: '••••1234', via: 'claim' });
}, 50);
setInterval(() => {}, 1000);`);
  const h = harness(t, { hostPath });
  await h.m.start();
  await waitFor(() => h.events.some((e) => e.name === 'owner_bound'), 'the valid event');
  assert.equal(h.events.filter((e) => e.name === 'inbound').length, 0);
  assert.equal(h.events.filter((e) => e.name === 'owner_bound').length, 1);
  assert.ok(h.logs.filter((l) => /dropped an invalid message/.test(l.msg)).length >= 2);
});

test('stop() sends shutdown and the host exits cleanly; killNow() terminates', async (t) => {
  const h = harness(t);
  await h.m.start();
  const pid = h.m.status().host.pid;
  await h.m.stop();
  assert.equal(h.m.status().host.state, 'stopped');
  await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 'host exited');
  const again = await h.m.send('x');
  assert.deepEqual([again.ok, again.code], [false, ERR.HOST_UNAVAILABLE]);

  const k = harness(t);
  await k.m.start();
  const kpid = k.m.status().host.pid;
  k.m.killNow();
  await waitFor(() => { try { process.kill(kpid, 0); return false; } catch { return true; } }, 'killed');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(k.forks.length, 1, 'no respawn after killNow');
});

test('a second host on the same data home reports locked (one WhatsApp session per machine)', async (t) => {
  const first = harness(t);
  await first.m.start();
  assert.equal(first.m.status().conn.state, CONN.UNLINKED);
  const second = harness(t, { dataHome: first.dataHome });
  const r = await second.m.start();
  assert.equal(r.ok, true, 'the host runs, the session store does not open');
  assert.equal(second.m.status().conn.state, CONN.LOCKED);
  assert.ok(second.events.some((e) => e.name === 'fatal' && e.payload.code === 'LOCKED'));
  const link = await second.m.connect({ purpose: 'link', mode: 'self' });
  assert.deepEqual([link.ok, link.code], [false, ERR.LOCKED]);
  await second.m.stop();
  assert.equal(second.m.status().conn.state, CONN.IDLE, 'a stopped host knows nothing about the lock');
  await first.m.stop();
  const third = harness(t, { dataHome: first.dataHome });
  await third.m.start();
  assert.equal(third.m.status().conn.state, CONN.UNLINKED, 'free again once the first host is gone');
});

test('inproc mode runs the same core in this process', async (t) => {
  const dataHome = tempHome(t);
  const events = [];
  const m = createWhatsAppManager({
    dataHome,
    mode: 'inproc',
    env: {},
    loadRuntime: () => loadRuntime({ env: { SYNABUN_WHATSAPP_FAKE: '1' } }),
    forkImpl: () => { throw new Error('inproc must not fork'); },
  });
  t.after(() => m.stop());
  for (const name of EVENTS) m.on(name, (p) => events.push({ name, p }));
  const r = await m.start({ mode: 'dedicated' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(m.status().host.pid, process.pid);
  await m.connect({ purpose: 'link', mode: 'dedicated' });
  await waitFor(() => events.some((e) => e.name === 'qr'), 'qr');
  await m.fake('scan', {});
  await waitFor(() => m.status().conn.state === CONN.OPEN, 'open');
  const claim = await m.claimStart();
  assert.equal(claim.ok, true);
  assert.match(claim.code, /^SB-\d{6}$/);
  await m.fake('inbound', { from: 'owner', text: claim.code });
  await waitFor(() => events.some((e) => e.name === 'owner_bound'), 'owner_bound');
  assert.throws(() => m.on('nope', () => {}), /unknown WhatsApp manager event/);
});
