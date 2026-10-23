#!/usr/bin/env node

/**
 * `synabun`, the command an npm install puts on the PATH.
 *
 *   synabun mcp [...]   the MCP server on stdio, for an AI tool's MCP config. It
 *                       starts mcp-server/run.mjs straight from here, as
 *                       `node <package>/mcp-server/run.mjs` and a packaged build's
 *                       `<entry> mcp` do (packaging/launcher/launcher.c): same
 *                       environment, same working folder, same arguments after
 *                       `mcp`. setup.js is never loaded, so nothing reaches stdout,
 *                       the protocol channel, before the server does; the server
 *                       logs to stderr.
 *   synabun [...]       everything else: setup.js with the same arguments.
 */

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MCP_COMMAND = 'mcp';
// node:sqlite's warning: every SynaBun process starts with it off (setup.js, the packaged launcher).
const NODE_FLAG = '--disable-warning=ExperimentalWarning';

/** Node's arguments for `synabun <args>`. */
export function nodeArgs(args, { packageRoot = PACKAGE_ROOT } = {}) {
  if (args[0] === MCP_COMMAND) return [NODE_FLAG, resolve(packageRoot, 'mcp-server', 'run.mjs'), ...args.slice(1)];
  return [NODE_FLAG, resolve(packageRoot, 'setup.js'), ...args];
}

/** The signals an MCP client (or a terminal) stops the server with. */
export function forwardedSignals(platform = process.platform) {
  return platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
}

/**
 * Node on `args`, with this process's stdio, environment and working folder.
 * This process then ends the way the child ended: its exit code, or the same
 * signal. With `forwardSignals`, a SIGINT, SIGTERM or SIGHUP sent to this
 * process goes to the child while it runs: an MCP client stops the server it
 * started by signalling the process it started, which is this one.
 */
export function runNode(args, { execPath = process.execPath, env = process.env, cwd = process.cwd(), forwardSignals = false } = {}) {
  const child = spawn(execPath, args, { cwd, env, stdio: 'inherit' });
  const handlers = forwardSignals
    ? forwardedSignals().map((signal) => [signal, () => { try { child.kill(signal); } catch {} }])
    : [];
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const release = () => { for (const [signal, handler] of handlers) process.removeListener(signal, handler); };

  child.on('error', (error) => {
    release();
    console.error(`Could not start SynaBun: ${error.message}`);
    process.exitCode = 1;
  });

  child.on('exit', (code, signal) => {
    release();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
  return child;
}

const invokedDirectly = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();

if (invokedDirectly) {
  const args = process.argv.slice(2);
  runNode(nodeArgs(args), { forwardSignals: args[0] === MCP_COMMAND });
}
