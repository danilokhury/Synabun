// Live model discovery for Claude Code.
//
// The CLI is the only authoritative source for which models an account can
// actually run — the list reflects entitlements and org restrictions, and it
// changes whenever the CLI updates. Hardcoding it guarantees drift, so we ask
// the CLI instead: spawn it with stream-json I/O, send one `initialize`
// control request, read `models[]` out of the control_response, kill the child.
// No user message is sent and no tokens are spent; the handshake is ~300ms.
//
// Mirrors queryCodexAppServerModels() in server.js — same cache/fallback shape,
// different wire protocol (Codex speaks JSON-RPC `model/list`).

import { spawn } from 'node:child_process';
import { dirname, join, sep } from 'node:path';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { getAugmentedPath } from './augmented-path.js';

// Effort ladder the Claude Code CLI accepts for --effort. Models advertise their
// own subset via supportedEffortLevels; this is the superset used as a fallback
// and as the server-side allowlist at every spawn site.
export const CLAUDE_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

// Used only when discovery fails (CLI missing, spawn error, timeout). Kept
// deliberately short — a stale fallback is less harmful than a stale primary,
// because `source: 'fallback'` tells the UI the list is unverified.
export const CLAUDE_FALLBACK_MODELS = Object.freeze([
  { id: 'default', label: 'Default (recommended)', desc: 'CLI default model', tier: 'default' },
  { id: 'opus', label: 'Opus', desc: 'Most capable' },
  { id: 'sonnet', label: 'Sonnet', desc: 'Balanced' },
  { id: 'haiku', label: 'Haiku', desc: 'Fastest' },
].map(m => Object.freeze({
  ...m,
  resolvedModel: '',
  contextWindow: 200000,
  effortLevels: m.id === 'haiku' ? [] : [...CLAUDE_EFFORT_LEVELS],
  supportsEffort: m.id !== 'haiku',
  supportsFastMode: false,
  cliReady: true,
})));

const DISCOVERY_TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 10 * 60 * 1000;

let _cache = { at: 0, key: '', models: [] };
let _inflight = null;

// What a cache keyed on "the CLI" has to key on. An update never changes the
// configured path: the native installer and Homebrew re-point a symlink at a new
// version directory, and npm rewrites the entrypoint in place. The resolved target
// plus its mtime and size changes with every one of those, so a cache keyed on this
// sees the update on the next request instead of serving the previous model table
// until the TTL runs out or the server restarts. A bare command name has nothing to
// resolve and keys on itself.
export function binaryIdentity(bin) {
  const value = String(bin || '');
  if (!value) return '';
  try {
    const real = realpathSync(value);
    const { mtimeMs, size } = statSync(real);
    return `${real}|${mtimeMs}|${size}`;
  } catch {
    return value;
  }
}

// The CLI marks a 1M-context variant with a `[1m]` suffix on the selector value.
// `resolvedModel` carries it too for aliases (opus[1m] → claude-opus-5[1m]), but
// not always (claude-fable-5[1m] → claude-fable-5), so check both.
function contextWindowFor(model) {
  const marked = [model?.value, model?.resolvedModel]
    .some(v => /\[1m\]$/.test(String(v || '')));
  return marked ? 1000000 : 200000;
}

// CLI descriptions read "Opus 5 with 1M context · Best for everyday, complex tasks".
// The lead-in restates the display name, so chips and dropdowns want only the tagline.
function shortDescription(description) {
  const text = String(description || '').trim();
  const parts = text.split('·');
  return (parts.length > 1 ? parts.slice(1).join('·') : text).trim();
}

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The versioned family name, taken from the description lead-in:
// "Opus 5 with 1M context · …" → "Opus 5"; "Haiku 4.5 · …" → "Haiku 4.5".
// Returns '' when the lead-in carries no version, so callers keep the CLI wording.
function versionedFamily(description) {
  const leadIn = String(description || '').split('·')[0].trim();
  const family = leadIn.replace(/\s+with\s+.*$/i, '').trim();
  return /\d/.test(family) ? family : '';
}

// The CLI's displayName is version-less ("Opus", "Fable", "Sonnet") while the
// version appears only in `description`. The picker renders the label alone, so a
// bare "Opus" is indistinguishable from any earlier Opus — fold the version back
// in. Derived from CLI output rather than hardcoded, so it tracks CLI updates.
export function versionedLabel(displayName, description) {
  const label = String(displayName || '').trim();
  const family = versionedFamily(description);
  if (!family || !label) return label;
  const base = family.replace(/\s+[\d.]+$/, '').trim(); // "Opus 5" → "Opus"
  if (!base) return label;
  // Already versioned by the CLI ("Opus 4.8") — leave its wording alone. Anchored
  // to the family name on purpose: "Opus (1M context)" has digits but no version.
  if (new RegExp(`^${escapeRe(base)}\\s*\\d`, 'i').test(label)) return label;
  if (new RegExp(`^${escapeRe(base)}\\b`, 'i').test(label)) {
    // "Opus (1M context)" → "Opus 5 (1M context)"; "Fable" → "Fable 5".
    return label.replace(new RegExp(`^${escapeRe(base)}`, 'i'), family);
  }
  // "Default (recommended)" names no family — say which model it resolves to.
  return `${label} — ${family}`;
}

// ModelInfo (from the SDK's SDKControlInitializeResponse) → SynaBun option shape.
// `value` is already CLI-ready, so it becomes the selector id verbatim — no
// ":<contextWindow>" composite, which is what `cliReady` signals downstream.
export function normalizeClaudeModel(model) {
  const id = String(model?.value || '').trim();
  if (!id) return null;
  const effortLevels = Array.isArray(model?.supportedEffortLevels)
    ? model.supportedEffortLevels.map(String).filter(Boolean)
    : [];
  return {
    id,
    label: versionedLabel(model?.displayName || id, model?.description),
    desc: shortDescription(model?.description),
    description: String(model?.description || ''),
    resolvedModel: String(model?.resolvedModel || ''),
    contextWindow: contextWindowFor(model),
    effortLevels,
    supportsEffort: model?.supportsEffort === true && effortLevels.length > 0,
    supportsFastMode: model?.supportsFastMode === true,
    // Which controls the sidepanel may offer for this model (Auto mode, thinking).
    supportsAutoMode: model?.supportsAutoMode === true,
    supportsAdaptiveThinking: model?.supportsAdaptiveThinking === true,
    cliReady: true,
    ...(id === 'default' ? { tier: 'default' } : {}),
  };
}

export function normalizeClaudeModels(models = []) {
  const out = [];
  const seen = new Set();
  for (const model of Array.isArray(models) ? models : []) {
    const option = normalizeClaudeModel(model);
    if (!option || seen.has(option.id)) continue;
    seen.add(option.id);
    out.push(option);
  }
  return out;
}

// With a shell, Node joins the command and its arguments into one line and
// quotes nothing. An installation under a folder with a space in its name
// (C:\Users\Jane Doe\AppData\Roaming\npm\claude.cmd) would be cut at the
// space, so the command is quoted here whenever a shell runs it. Where the
// value may also be a command line the user configured ("wsl codex"), pass
// `isFile`: only what is a file on disk is then treated as one word.
export function shellCommand(bin, useShell, { isFile = null } = {}) {
  const value = String(bin);
  if (!useShell || !/\s/.test(value) || /^".*"$/.test(value)) return value;
  if (isFile && !isFile(value)) return value;
  return `"${value}"`;
}

// Ask the CLI for its model list. Resolves to [] on any failure — callers fall
// back to CLAUDE_FALLBACK_MODELS rather than surfacing an error, because a
// missing model list should degrade the picker, not break the panel.
export function queryClaudeCliModels(claudeBin, { cwd, timeoutMs = DISCOVERY_TIMEOUT_MS, spawnImpl = spawn } = {}) {
  return new Promise((resolveResult) => {
    let bin = claudeBin;
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      // Load no settings files. Without this the user's own SessionStart hooks
      // fire on every discovery — slow, and with visible side effects.
      //
      // Written as one `=` token, not a `'--setting-sources', ''` pair: the spawn
      // below falls back to a shell whenever `bin` is a bare command name, and a
      // shell concatenates argv instead of passing it through. The empty string
      // vanishes in that concatenation, leaving a dangling flag, and the CLI exits
      // with "option '--setting-sources <sources>' argument missing" — which this
      // function reports as an empty model list, silently degrading the whole
      // picker to CLAUDE_FALLBACK_MODELS. The `=` form survives either path.
      '--setting-sources=',
    ];
    // Same spawn quirks as the main session path: Windows can't exec a .js
    // directly, and .cmd/.bat need a shell.
    if (process.platform === 'win32' && /\.js$/i.test(bin)) {
      args.unshift(bin);
      bin = process.execPath;
    }
    const useShell = !String(bin).includes(sep)
      || (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin));

    let child;
    let settled = false;
    const finish = (models) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.kill(); } catch {}
      resolveResult(models);
    };
    const timer = setTimeout(() => finish([]), timeoutMs);
    timer.unref?.();

    try {
      child = spawnImpl(shellCommand(bin, useShell), args, {
        cwd: cwd || process.cwd(),
        env: { ...process.env, PATH: getAugmentedPath(), CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' },
        stdio: ['pipe', 'pipe', 'ignore'],
        shell: useShell,
      });
    } catch {
      return finish([]);
    }

    child.on('error', () => finish([]));
    child.on('exit', () => finish([]));
    // A CLI that is not installed is a shell that exits at once, sometimes
    // before the request below is written. The write then fails on the stream
    // (EPIPE), not in the try around it, and an unhandled stream error ends the
    // whole server. Seen on Linux, where `sh` is fast.
    child.stdin.on('error', () => finish([]));

    let buf = '';
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg?.type !== 'control_response') continue;
        const payload = msg.response?.response;
        finish(Array.isArray(payload?.models) ? payload.models : []);
        return;
      }
    });

    try {
      child.stdin.write(JSON.stringify({
        type: 'control_request',
        request_id: 'synabun-models',
        request: { subtype: 'initialize' },
      }) + '\n');
    } catch {
      finish([]);
    }
  });
}

// Cached discovery. `source` lets the UI distinguish a verified list from the
// baked-in fallback. Cache is keyed on the binary's identity, so switching the
// configured CLI (Settings > Terminal) or updating it re-discovers.
export async function discoverClaudeModels(claudeBin, { force = false, cwd } = {}) {
  const bin = String(claudeBin || '');
  const key = binaryIdentity(bin);
  const fresh = _cache.models.length
    && _cache.key === key
    && Date.now() - _cache.at < CACHE_TTL_MS;
  if (!force && fresh) return { source: 'cache', models: _cache.models };
  if (_inflight) return _inflight;

  _inflight = (async () => {
    try {
      const raw = await queryClaudeCliModels(bin, { cwd });
      const models = normalizeClaudeModels(raw);
      if (models.length) {
        _cache = { at: Date.now(), key, models };
        return { source: 'cli', models };
      }
      return { source: 'fallback', models: [...CLAUDE_FALLBACK_MODELS] };
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

export function clearClaudeModelCache() {
  _cache = { at: 0, key: '', models: [] };
  _skewCache = { key: null, result: undefined };
  _skewInflight.clear();
}

// ── CLI version skew ──────────────────────────────────────────────────────────
// One Claude Code is in play: the user's own installation. This module asks it
// for its models, and the Agent SDK starts that same executable for sidepanel
// chats, the Assistant and native loops (lib/claude-executable.js), so an alias
// such as "opus[1m]" means in a session what it meant in the picker.
//
// What can still drift is the SDK itself: each release is built against one
// Claude Code version (its manifest names it) and may send options an older
// installation does not know. That is worth one line in the log, never a
// refusal: the installed Claude Code is the only one there is to run.

const _require = createRequire(import.meta.url);

// The Claude Code version the installed Agent SDK was built against, from the
// SDK's own manifest (`manifest.json` → "version": "2.1.220"). Not in the
// package's exports map, so walk up from the resolved entry file. null when the
// SDK is absent.
export function sdkReferenceCliVersion() {
  try {
    let dir = dirname(_require.resolve('@anthropic-ai/claude-agent-sdk'));
    for (let i = 0; i < 5; i++) {
      const manifest = join(dir, 'manifest.json');
      if (existsSync(manifest)) {
        const v = JSON.parse(readFileSync(manifest, 'utf-8'))?.version;
        return v ? String(v) : null;
      }
      dir = dirname(dir);
    }
  } catch {}
  return null;
}

// `claude --version` prints "2.1.220 (Claude Code)".
export function parseCliVersion(text) {
  const m = /(\d+\.\d+\.\d+)/.exec(String(text || ''));
  return m ? m[1] : null;
}

// Numeric x.y.z comparison — a string compare would put 2.1.99 above 2.1.100.
// 1 when `a` is newer, -1 when older, 0 when equal, null when either side is not
// a version.
export function compareCliVersions(a, b) {
  const va = parseCliVersion(a);
  const vb = parseCliVersion(b);
  if (!va || !vb) return null;
  const pa = va.split('.').map(Number);
  const pb = vb.split('.').map(Number);
  for (let i = 0; i < pa.length; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

export function queryClaudeCliVersion(claudeBin, { timeoutMs = 10000 } = {}) {
  return new Promise((resolveResult) => {
    let bin = claudeBin;
    const args = ['--version'];
    if (process.platform === 'win32' && /\.js$/i.test(bin)) {
      args.unshift(bin);
      bin = process.execPath;
    }
    const useShell = !String(bin).includes(sep)
      || (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin));

    let child;
    let settled = false;
    let out = '';
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.kill(); } catch {}
      resolveResult(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();

    try {
      child = spawn(shellCommand(bin, useShell), args, {
        env: { ...process.env, PATH: getAugmentedPath() },
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: useShell,
      });
    } catch {
      return finish(null);
    }
    child.on('error', () => finish(null));
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('close', () => finish(parseCliVersion(out)));
  });
}

// Never blocks discovery. The result is cached per binary identity — the model
// endpoints ask on every request — so a `claude --version` spawn happens once
// per installed CLI, not once per request. A CLI update changes the identity and
// re-probes. `null` (nothing to compare: no SDK, no CLI, unreadable version) is
// cached too. Warns once per distinct pair so repeated checks don't spam the log.
const _warnedSkew = new Set();
let _skewCache = { key: null, result: undefined };
const _skewInflight = new Map(); // binary identity → pending probe

function warnSkewOnce(result, claudeBin, log) {
  // A newer installation than the SDK was built against is the ordinary state
  // between two SynaBun releases, and nothing to report.
  if (!result.installedOlder) return;
  const pair = `${result.discovered}→${result.reference}`;
  if (_warnedSkew.has(pair)) return;
  _warnedSkew.add(pair);
  log(
    `[claude-models] The installed Claude Code is ${result.discovered} (${claudeBin}); `
    + `@anthropic-ai/claude-agent-sdk was built against ${result.reference}. Sessions run the `
    + `installed one. If a session misbehaves, update Claude Code to ${result.reference} or newer.`,
  );
}

export async function checkClaudeCliSkew(claudeBin, {
  log = console.warn,
  force = false,
  queryVersion = queryClaudeCliVersion,
  referenceVersion = sdkReferenceCliVersion,
} = {}) {
  const key = binaryIdentity(claudeBin);
  let result;
  if (!force && _skewCache.key === key && _skewCache.result !== undefined) {
    result = _skewCache.result;
  } else {
    let probe = _skewInflight.get(key);
    if (!probe) {
      probe = (async () => {
        const reference = referenceVersion();
        const discovered = reference ? await queryVersion(claudeBin) : null;
        const order = compareCliVersions(discovered, reference);
        const value = order === null ? null : {
          discovered,
          reference,
          skewed: order !== 0,
          installedOlder: order < 0,
        };
        _skewCache = { key, result: value };
        return value;
      })().finally(() => _skewInflight.delete(key));
      _skewInflight.set(key, probe);
    }
    result = await probe;
  }
  if (result?.skewed) warnSkewOnce(result, claudeBin, log);
  return result;
}
