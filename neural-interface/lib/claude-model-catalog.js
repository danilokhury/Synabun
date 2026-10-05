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
import { resolveClaudeExecutableOverride } from './native-binary-runtime.js';

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

// Ask the CLI for its model list. Resolves to [] on any failure — callers fall
// back to CLAUDE_FALLBACK_MODELS rather than surfacing an error, because a
// missing model list should degrade the picker, not break the panel.
export function queryClaudeCliModels(claudeBin, { cwd, timeoutMs = DISCOVERY_TIMEOUT_MS } = {}) {
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
      child = spawn(bin, args, {
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
  _alignFailures.clear();
}

// ── CLI version skew ──────────────────────────────────────────────────────────
// Two different Claude Code binaries are in play: this module discovers models
// from the CLI resolved for terminals/agents/loops, while sidepanel chats run on
// the one the Agent SDK bundles. Both accept the same *alias* ids ("default",
// "opus[1m]", "sonnet"), but each maps them with its own model table — so when
// the versions drift the picker labels a model from one table and the session
// silently runs whatever the other table calls "opus". That is invisible from
// the outside: the only symptom is the model naming a different version of
// itself. Compare the two, say so, and — when the installed CLI is the newer
// one — run sessions on it (see alignedClaudeExecutable below).

const _require = createRequire(import.meta.url);

// The Claude Code version the installed Agent SDK ships, from the SDK's own
// manifest (`manifest.json` → "version": "2.1.220"). Not in the package's
// exports map, so walk up from the resolved entry file. null when the SDK is
// absent — the legacy engine spawns the discovered CLI and cannot skew.
export function sdkBundledCliVersion() {
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
      child = spawn(bin, args, {
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
// endpoints ask on every request, and it now also decides which binary SDK
// sessions run — so a `claude --version` spawn happens once per installed CLI,
// not once per request. A CLI update changes the identity and re-probes. `null`
// (nothing to compare: no SDK, unreadable CLI) is cached too. Warns once per
// distinct pair so repeated checks don't spam the log.
const _warnedSkew = new Set();
let _skewCache = { key: null, result: undefined };
const _skewInflight = new Map(); // binary identity → pending probe

function warnSkewOnce(result, claudeBin, log) {
  const pair = `${result.discovered}→${result.bundled}`;
  if (_warnedSkew.has(pair)) return;
  _warnedSkew.add(pair);
  if (result.installedNewer) {
    log(
      `[claude-models] CLI version skew: the installed CLI ${result.discovered} (${claudeBin}) is newer `
      + `than the ${result.bundled} bundled with @anthropic-ai/claude-agent-sdk. Sidepanel sessions and `
      + 'native loops will run the installed CLI, so a picked model launches as the version the picker '
      + 'names. Bump @anthropic-ai/claude-agent-sdk to the release that bundles it to re-align the runtime.',
    );
    return;
  }
  log(
    `[claude-models] CLI version skew: model picker reads ${result.discovered} (${claudeBin}) `
    + `but sidepanel sessions run ${result.bundled} (bundled with @anthropic-ai/claude-agent-sdk). `
    + 'Alias ids like "opus[1m]" resolve per-binary, so a picked model can launch as a '
    + `different version. Align them: update the installed Claude CLI to ${result.bundled} or newer.`,
  );
}

export async function checkClaudeCliSkew(claudeBin, {
  log = console.warn,
  force = false,
  queryVersion = queryClaudeCliVersion,
  bundledVersion = sdkBundledCliVersion,
} = {}) {
  const key = binaryIdentity(claudeBin);
  let result;
  if (!force && _skewCache.key === key && _skewCache.result !== undefined) {
    result = _skewCache.result;
  } else {
    let probe = _skewInflight.get(key);
    if (!probe) {
      probe = (async () => {
        const bundled = bundledVersion();
        const discovered = bundled ? await queryVersion(claudeBin) : null;
        const order = compareCliVersions(discovered, bundled);
        const value = order === null ? null : {
          discovered,
          bundled,
          skewed: order !== 0,
          installedNewer: order > 0,
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

// Synchronous view of the last probe for this binary: the result, null (probed,
// nothing to compare), or undefined (not probed at this identity — typically
// because the CLI was updated since).
export function cachedClaudeCliSkew(claudeBin) {
  return _skewCache.key === binaryIdentity(claudeBin) ? _skewCache.result : undefined;
}

// ── Runtime alignment ─────────────────────────────────────────────────────────
// The picker's model table comes from the installed CLI; SDK sessions (sidepanel)
// and native loops default to the CLI the SDK bundles. When the installed one is
// newer, the same alias resolves to a newer model there — "opus[1m]" is Opus 5.5 on
// 2.1.280 but Opus 5 on 2.1.278 — so the picker would promise a model the session
// cannot launch. In that case sessions run the installed CLI instead. Everywhere
// else the bundled, version-matched binary stays the default: when the versions
// match, when the bundled one is the newer of the two, and when no usable CLI is
// installed.
const _alignFailures = new Set(); // binary identities whose aligned launch failed

// A launch failure of the aligned CLI sends every later session back to the bundled
// runtime. Keyed by identity, so the next CLI update gets a fresh chance.
export function markAlignedClaudeExecutableFailed(claudeBin) {
  const key = binaryIdentity(claudeBin);
  if (key) _alignFailures.add(key);
}

// The path SDK sessions should run instead of the bundled CLI, or null to keep the
// bundled one. Never blocks: when this binary has not been compared yet, the check
// starts in the background and this call answers null, so no session waits on a
// version probe — the next one aligns.
export function alignedClaudeExecutable(claudeBin, {
  skew = cachedClaudeCliSkew(claudeBin),
  refresh = true,
  resolveOverride = resolveClaudeExecutableOverride,
} = {}) {
  if (!claudeBin) return null;
  if (skew === undefined) {
    if (refresh) checkClaudeCliSkew(claudeBin).catch(() => {});
    return null;
  }
  if (!skew?.installedNewer) return null;
  if (_alignFailures.has(binaryIdentity(claudeBin))) return null;
  // The SDK spawns this path verbatim with shell:false; the shared override
  // contract rejects bare command names and anything that is not executable.
  const candidate = resolveOverride(claudeBin);
  return candidate?.ok && candidate.path ? candidate.path : null;
}
