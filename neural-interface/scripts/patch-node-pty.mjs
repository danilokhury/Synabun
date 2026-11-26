#!/usr/bin/env node

/**
 * Durable patch for node-pty's Windows ConPTY console-list helper
 * (lib/conpty_console_list_agent.js).
 *
 * In node-pty 1.1.0, WindowsPtyAgent.kill() forks conpty_console_list_agent.js
 * with inherited stderr. Line 13 calls getConsoleProcessList(shellPid) without
 * a try/catch; during shutdown when the shell console is already gone, Windows
 * returns AttachConsole failure, printing an uncaught exception stack trace to
 * server logs and stalling kill() for 5 seconds until the parent's timeout
 * falls back to [shellPid].
 *
 * Patching the helper makes it catch the error and immediately send [shellPid]
 * back over IPC with zero stderr noise and zero 5 s delay.
 *
 * Applied automatically by:
 *   - neural-interface/scripts/rebuild-pty.js (postinstall for dev & npm i -g)
 *   - packaging/lib/stage.mjs prepareNatives() (packaged desktop builds)
 * Verified by:
 *   - packaging/lib/verify.mjs auditBundle() (Windows bundles)
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PATCH_MARKER = '// synabun-patch: conpty-attach-console-fallback';
export const CONPTY_AGENT_REL = join('lib', 'conpty_console_list_agent.js');

// Exact SHA-256 of upstream node-pty@1.1.0 lib/conpty_console_list_agent.js (LF-normalized).
export const UPSTREAM_AGENT_SHA256 = '0d010879bb6680a0253d44363183d53e631f42972594eb6dcb1fb842c8c85e52';

const normalizeEol = (source) => String(source ?? '').replace(/\r\n/g, '\n');
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

export const PATCHED_AGENT_SOURCE = `"use strict";
${PATCH_MARKER}
/**
 * Copyright (c) 2019, Microsoft Corporation (MIT License).
 *
 * This module fetches the console process list for a particular PID. It must be
 * called from a different process (child_process.fork) as there can only be a
 * single console attached to a process.
 *
 * Patched by SynaBun: catch AttachConsole failures during shutdown and fall
 * back immediately to [shellPid] instead of crashing with stderr noise and
 * waiting for the parent's 5 s timeout.
 */
Object.defineProperty(exports, "__esModule", { value: true });
var utils_1 = require("./utils");
var shellPid = parseInt(process.argv[2], 10);
var fallbackList = Number.isInteger(shellPid) && shellPid > 0 ? [shellPid] : [];
var consoleProcessList = fallbackList;
try {
    var getConsoleProcessList = utils_1.loadNativeModule('conpty_console_list').module.getConsoleProcessList;
    var list = getConsoleProcessList(shellPid);
    if (Array.isArray(list)) {
        consoleProcessList = list;
    }
}
catch (_err) {
    consoleProcessList = fallbackList;
}
if (typeof process.send === 'function') {
    try {
        process.send({ consoleProcessList: consoleProcessList }, function () {
            process.exit(0);
        });
    }
    catch (_err) {
        process.exit(0);
    }
}
else {
    process.exit(0);
}
//# sourceMappingURL=conpty_console_list_agent.js.map
`;

export const PATCHED_AGENT_SHA256 = sha256(normalizeEol(PATCHED_AGENT_SOURCE));

/** True ONLY when `source` matches the exact patched SynaBun helper content (by SHA-256, never marker alone). */
export function isConptyConsoleListPatched(source) {
  return typeof source === 'string' && sha256(normalizeEol(source)) === PATCHED_AGENT_SHA256;
}

/**
 * Transform upstream node-pty 1.1.0 conpty_console_list_agent.js by exact SHA-256 hash.
 * Refuses any unrecognized or modified content with a clear reason.
 * Returns { status: 'patched' | 'already-patched' | 'unmatched', changed, content, reason? }.
 */
export function applyConptyConsoleListPatch(source) {
  const text = String(source ?? '');
  const hash = sha256(normalizeEol(text));
  if (hash === PATCHED_AGENT_SHA256) {
    return { status: 'already-patched', changed: false, content: text };
  }
  if (hash === UPSTREAM_AGENT_SHA256) {
    return { status: 'patched', changed: true, content: PATCHED_AGENT_SOURCE };
  }
  return {
    status: 'unmatched',
    changed: false,
    content: text,
    reason: `conpty_console_list_agent.js sha256 ${hash} matches neither known upstream node-pty 1.1.0 (${UPSTREAM_AGENT_SHA256}) nor exact SynaBun patched helper (${PATCHED_AGENT_SHA256}); refusing to overwrite`,
  };
}

/**
 * Patch `lib/conpty_console_list_agent.js` inside a single `node-pty` package directory.
 * Idempotent; refuses unknown content without overwriting.
 */
export function patchNodePtyDir(ptyDir, { log = () => {} } = {}) {
  const target = join(ptyDir, CONPTY_AGENT_REL);
  if (!existsSync(target)) {
    return { status: 'missing', path: target, reason: `missing ${target}` };
  }
  const source = readFileSync(target, 'utf8');
  const result = applyConptyConsoleListPatch(source);
  if (result.changed) {
    writeFileSync(target, result.content, 'utf8');
    log(`[patch-node-pty] patched ${target} (AttachConsole fallback)`);
  }
  return { status: result.status, path: target, ...(result.reason ? { reason: result.reason } : {}) };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const neuralRoot = resolve(__dirname, '..');
  const packageRoot = resolve(neuralRoot, '..');
  const args = process.argv.slice(2);
  const dirs = args.length
    ? args.map(dir => resolve(dir))
    : [...new Set([
      resolve(neuralRoot, 'node_modules', 'node-pty'),
      resolve(packageRoot, 'node_modules', 'node-pty'),
    ])];
  let unmatched = false;
  for (const dir of dirs) {
    const res = patchNodePtyDir(dir, { log: console.log });
    if (res.status === 'already-patched') console.log(`[patch-node-pty] already patched: ${res.path}`);
    else if (res.status === 'unmatched') {
      console.warn(`[patch-node-pty] ${res.reason || `unexpected contents, skipped: ${res.path}`}`);
      unmatched = true;
    }
  }
  if (unmatched) process.exitCode = 1;
}
