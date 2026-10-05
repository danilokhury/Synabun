// WhatsApp Link host — the child process that owns Baileys and the WhatsApp
// credentials. Forked by manager.js with an allowlisted environment and an IPC
// channel; nothing else in SynaBun ever loads the runtime (the GPL-3.0
// libsignal it pulls in stays in this process, and so do its crashes).
//
//   node host.js                      run (config in SYNABUN_WHATSAPP_HOST_CONFIG)
//   node host.js --probe --runtime D  import D/entry.mjs, print {ok, version}, exit
//
// Lifetime: exits when the main process goes away (IPC disconnect), on
// SIGTERM/SIGHUP, or after a `shutdown` op. SIGINT is ignored — the main
// server owns the orderly shutdown. Shutdown ends the socket (never a logout)
// and closes the database.
//
// Console output is not trusted: libsignal prints whole Signal sessions (key
// material) with console.info. console.log/info/debug/trace are dropped and
// warn/error keep only their string arguments, redacted.

import { PROTOCOL_VERSION, EV, OP } from './protocol.js';
import { redactWa } from './redact.js';

process.umask(0o077);
process.title = 'synabun-whatsapp';

function safeFormat(args) {
  return args
    .map((a) => (typeof a === 'string' ? a
      : a instanceof Error ? `${a.name}: ${a.message}`
        : typeof a === 'number' || typeof a === 'boolean' ? String(a) : '[object]'))
    .join(' ')
    .slice(0, 2000);
}

function guardConsole(sink) {
  const quiet = () => {};
  console.log = quiet;
  console.info = quiet;
  console.debug = quiet;
  console.trace = quiet;
  console.dir = quiet;
  console.warn = (...args) => sink('warn', safeFormat(args));
  console.error = (...args) => sink('error', safeFormat(args));
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

async function probe(argv) {
  guardConsole(() => {});
  // Pipes are asynchronous on macOS: exit only once the line is flushed.
  const finish = (obj, code) => process.stdout.write(`${JSON.stringify(obj)}\n`, () => process.exit(code));
  const runtimeDir = argValue(argv, '--runtime');
  if (!runtimeDir) {
    finish({ ok: false, error: 'missing --runtime <dir>' }, 2);
    return;
  }
  try {
    const { loadRuntime } = await import('./baileys-adapter.js');
    const rt = await loadRuntime({ runtimeDir, env: {} });
    const ok = typeof rt.mod.makeWASocket === 'function';
    finish({ ok, version: rt.version }, ok ? 0 : 1);
  } catch (err) {
    finish({ ok: false, code: err?.code || 'RUNTIME_ERROR', error: redactWa(err?.message || String(err)).slice(0, 300) }, 1);
  }
}

async function run() {
  const send = (msg) => {
    if (!process.connected) return;
    try { process.send(msg); } catch {}
  };
  const log = (level, message) => send({ t: EV.LOG, level, message: redactWa(message).slice(0, 4000) });
  guardConsole(log);

  let config = {};
  try { config = JSON.parse(process.env.SYNABUN_WHATSAPP_HOST_CONFIG || '{}'); } catch {}
  if (!config?.paths?.authDir) {
    send({ t: EV.FATAL, code: 'BAD_CONFIG', message: 'the WhatsApp host was started without its paths' });
    setTimeout(() => process.exit(1), 50); // let the IPC message flush
    return;
  }

  const { createHostCore } = await import('./host-core.js');
  const core = createHostCore({ send, paths: config.paths, env: process.env, platform: process.platform });

  let exiting = false;
  const exitSoon = (code = 0) => {
    if (exiting) return;
    exiting = true;
    const hard = setTimeout(() => process.exit(code), 1500);
    hard.unref?.();
    core.shutdown().catch(() => {}).finally(() => setTimeout(() => process.exit(code), 20));
  };

  process.on('disconnect', () => exitSoon(0));
  process.on('SIGTERM', () => exitSoon(0));
  process.on('SIGHUP', () => exitSoon(0));
  process.on('SIGINT', () => {});
  process.on('unhandledRejection', (err) => log('warn', `unhandled rejection: ${err?.message || err}`));
  process.on('uncaughtException', (err) => {
    send({ t: EV.FATAL, code: 'CRASH', message: redactWa(err?.message || String(err)).slice(0, 300) });
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 50);
  });

  process.on('message', (msg) => {
    core.handleMessage(msg).then(() => {
      if (msg?.op === OP.SHUTDOWN) exitSoon(0);
    }, () => {});
  });

  const info = await core.init();
  send({ t: EV.READY, protocol: PROTOCOL_VERSION, pid: process.pid, ...info });
}

const argv = process.argv.slice(2);
if (argv.includes('--probe')) await probe(argv);
else await run();
