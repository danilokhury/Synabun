// ═══════════════════════════════════════════
// SynaBun — Assistant route gate for the Codex brain (PreToolUse hook)
// ═══════════════════════════════════════════
//
// Codex (0.156+) runs command hooks before every tool call; a PreToolUse hook
// that answers permissionDecision "deny" blocks the call and hands the reason
// to the model. The assistant brain's app-server gets one such hook as a
// session flag (-c), never written to the user's config, so the Codex
// sidepanel and CLI sessions are untouched. Codex only runs a hook the user
// trusted: the session-flag hook is trusted with a session-flag
// hooks.state.<key>.trusted_hash, and the key and hash come from one probe
// app-server (temporary CODEX_HOME, `hooks/list`), cached per binary.
// No trusted hook → the runtime falls back to reactive enforcement.
// The Assistant's Codex workers (`codex exec` through the SDK) get the browser
// policy's hook the same way (codexBrowserPolicyHook), trusted by the same probe.

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CODEX_GATE_HOOK_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'assistant-brains', 'codex-route-gate-hook.mjs');
export const CODEX_BROWSER_POLICY_HOOK_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'assistant-brains', 'codex-browser-policy-hook.mjs');
/** The run note of a Codex worker whose browser-policy hook Codex would not run. */
export const CODEX_BROWSER_POLICY_UNTRUSTED_NOTE = 'browser policy: instructions only (Codex hook not trusted)';

export function codexGateHookCommand({ nodePath = process.execPath, hookPath = CODEX_GATE_HOOK_PATH } = {}) {
  return `${JSON.stringify(nodePath)} ${JSON.stringify(hookPath)}`;
}

/** The -c flags that install (and, with `trust`, trust) the hook. TOML basic strings = JSON strings here. */
export function codexGateHookFlags(command, trust = null) {
  const flags = ['-c', 'features.hooks=true', '-c', `hooks.PreToolUse=[{matcher="*", hooks=[{type="command", command=${JSON.stringify(command)}, timeout=15}]}]`];
  if (trust?.key && trust?.hash) flags.push('-c', `hooks.state={${JSON.stringify(trust.key)}={trusted_hash=${JSON.stringify(trust.hash)}}}`);
  return flags;
}

/**
 * The same trusted hook as the Codex SDK's `config` (the SDK has no raw
 * arguments): the flags of codexGateHookFlags, for `codex exec`. The SDK
 * turns `config` into dotted -c paths and Codex splits a path at every ".",
 * so the trust entry, whose key holds one
 * ("/<session-flags>/config.toml:pre_tool_use:0:0"), cannot be a path: it
 * travels as a key that is the whole override, `hooks.state={…} #`. The SDK
 * appends "=true" to it, which the trailing TOML comment swallows. Hook entries
 * render as inline tables with the same hash (tests pin the argv through the
 * real SDK). null without a trust entry: Codex would not run the hook.
 */
export function codexHookConfig(command, trust) {
  if (!command || !trust?.key || !trust?.hash) return null;
  return {
    features: { hooks: true },
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 15 }] }] },
    [`hooks.state={${JSON.stringify(trust.key)}={trusted_hash=${JSON.stringify(trust.hash)}}} #`]: true,
  };
}

/**
 * True when the codex skin would spawn this binary through a shell (a bare
 * name, or a Windows .cmd/.bat; server.js `useShell`). The shell would split
 * and glob the hook's -c values, so the gate falls back to reactive instead.
 */
export function codexNeedsShell(bin, platform = process.platform) {
  const value = String(bin || '');
  if (/\.js$/i.test(value)) return false; // run through node, never a shell
  return !value.includes(sep) || (platform === 'win32' && /\.(cmd|bat)$/i.test(value));
}

/** The hook `hooks/list` reports for our session-flag entry, or null. */
export function findGateHook(listResult, command) {
  const hooks = (listResult?.data || []).flatMap((entry) => entry?.hooks || []);
  const hook = hooks.find((h) => h?.source === 'sessionFlags' && h.command === command && /^pre_?tool_?use$/i.test(String(h.eventName || '')));
  return hook?.key && hook?.currentHash ? { key: hook.key, hash: hook.currentHash, trustStatus: hook.trustStatus || null } : null;
}

function probe({ codexBin, command, timeoutMs, spawnImpl }) {
  return new Promise((done) => {
    let bin = codexBin || 'codex';
    if (codexNeedsShell(bin)) { done(null); return; }
    const home = resolve(tmpdir(), 'synabun-codex-gate-probe');
    try { mkdirSync(home, { recursive: true }); } catch {}
    const args = [...codexGateHookFlags(command), 'app-server'];
    if (/\.js$/i.test(bin)) { args.unshift(bin); bin = process.execPath; }
    let proc;
    try {
      proc = spawnImpl(bin, args, { env: { ...process.env, CODEX_HOME: home, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'ignore'], shell: false });
    } catch { done(null); return; }
    let buf = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.kill(); } catch {}
      done(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    const send = (message) => { try { proc.stdin.write(`${JSON.stringify(message)}\n`); } catch {} };
    proc.on('error', () => finish(null));
    proc.on('exit', () => finish(null));
    proc.stdout.setEncoding?.('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let index;
      while ((index = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, index);
        buf = buf.slice(index + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) { send({ method: 'initialized' }); send({ id: 2, method: 'hooks/list', params: {} }); }
        else if (message.id === 2) { const hook = findGateHook(message.result, command); finish(hook ? { key: hook.key, hash: hook.hash } : null); }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'synabun-route-gate-probe', version: '1.0.0' } } });
  });
}

const trustCache = new Map();

/** { key, hash } for the gate hook on this Codex binary, or null (probe failed). Cached per binary + command. */
export function codexGateTrust({ codexBin = 'codex', command = codexGateHookCommand(), timeoutMs = 12_000, spawnImpl = spawn } = {}) {
  const cacheKey = `${codexBin}\n${command}`;
  if (!trustCache.has(cacheKey)) {
    trustCache.set(cacheKey, probe({ codexBin, command, timeoutMs, spawnImpl }).then((trust) => { if (!trust) trustCache.delete(cacheKey); return trust; }));
  }
  return trustCache.get(cacheKey);
}

/**
 * An Assistant task run's Codex worker: the browser policy's hook
 * (codex-browser-policy-hook.mjs, evaluated locally) as SDK `config`, trusted
 * like the brain's gate hook: { command, config }, or null when this Codex
 * cannot run it trusted (no absolute binary, the probe failed). The run then
 * has the policy as instructions only (CODEX_BROWSER_POLICY_UNTRUSTED_NOTE).
 */
export async function codexBrowserPolicyHook({ codexBin = null, trust = codexGateTrust, nodePath = process.execPath } = {}) {
  if (!codexBin || codexNeedsShell(codexBin)) return null;
  const command = codexGateHookCommand({ nodePath, hookPath: CODEX_BROWSER_POLICY_HOOK_PATH });
  let trusted = null;
  try { trusted = await trust({ codexBin, command }); } catch { trusted = null; }
  const config = codexHookConfig(command, trusted);
  return config ? { command, config } : null;
}

/**
 * Bootstrap payload for the codex skin handler (role "assistant"): the flags
 * and the env the hook reads, or null when Codex cannot run a trusted hook.
 * `remote`: a WhatsApp session — the hook denies a call it could not check.
 */
export async function codexRouteGateBootstrap({ url, session, token, codexBin = 'codex', trust = codexGateTrust, remote = false } = {}) {
  if (!url || !session || !token) return null;
  if (codexNeedsShell(codexBin)) return null;
  const command = codexGateHookCommand();
  let trusted = null;
  try { trusted = await trust({ codexBin, command }); } catch { trusted = null; }
  if (!trusted) return null;
  return {
    flags: codexGateHookFlags(command, trusted),
    env: { SYNABUN_ROUTE_GATE_URL: String(url), SYNABUN_ROUTE_GATE_SESSION: String(session), SYNABUN_ROUTE_GATE_TOKEN: String(token), ...(remote === true ? { SYNABUN_ROUTE_GATE_REMOTE: '1' } : {}) },
  };
}
