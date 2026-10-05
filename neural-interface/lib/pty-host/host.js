// Dedicated terminal process ("pty-host"). Forked by manager.js with an IPC
// channel; owns every PTY and every terminal WebSocket, so keystroke echo and
// CLI output never wait on the main server's event loop.
//
// Lifetime: dies with the main process (IPC `disconnect`), on SIGTERM/SIGHUP,
// or after a `shutdown` op. SIGINT is ignored — a Ctrl+C in the terminal that
// launched SynaBun reaches the whole process group, and the main server owns
// the orderly shutdown.

import { createPtyHostCore } from './core.js';
import { EV, OP } from './protocol.js';

process.title = 'synabun-pty-host';

let config = {};
try { config = JSON.parse(process.env.SYNABUN_PTY_HOST_CONFIG || '{}'); } catch {}

const send = (msg) => {
  if (!process.connected) return;
  try { process.send(msg); } catch {}
};

const core = createPtyHostCore({ send, config });

let exiting = false;
function exitSoon(code = 0) {
  if (exiting) return;
  exiting = true;
  try { core.shutdownAll(); } catch {}
  // Let node-pty deliver the hangups before the process goes away.
  setTimeout(() => process.exit(code), 150);
}

process.on('disconnect', () => exitSoon(0));
process.on('SIGTERM', () => exitSoon(0));
process.on('SIGHUP', () => exitSoon(0));
process.on('SIGINT', () => {});
process.on('uncaughtException', (err) => send({ t: EV.WARN, message: `uncaught: ${err?.stack || err}` }));
process.on('unhandledRejection', (err) => send({ t: EV.WARN, message: `unhandled: ${err?.stack || err}` }));

process.on('message', (msg, handle) => {
  core.handleMessage(msg, handle);
  if (msg?.op === OP.SHUTDOWN) setTimeout(() => exitSoon(0), 100);
});

const info = await core.init();
send({ t: EV.READY, pid: process.pid, ...info, node: process.versions.node });
