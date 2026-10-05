// ═══════════════════════════════════════════
// SynaBun — Remote sessions: what a phone may make the Assistant do
// ═══════════════════════════════════════════
//
// An Assistant session driven from outside the desktop (WhatsApp Link) runs
// under a level, enforced by the runtime, the dispatcher and the brain's hooks:
//   read-only  — plan mode at every mode write; no workers (REMOTE_READ_ONLY);
//                a plan is approved on the desktop only.
//   ask        — (default) the brain asks before anything plan mode would
//                refuse, user allow rules included; routing always asks (one
//                route card per task is the task's approval); workers get no
//                computer, no "user-authorized-full" and a registered cwd.
//   autonomous — the modes as configured, until autonomousUntil; then ask.
// Ask and Autonomous hold only on a Claude brain: its in-process PreToolUse
// hook sees every call with its arguments. A Codex or OpenCode brain runs
// ordinary commands inside its own sandbox / permissions without asking, so a
// remote session on one is read-only whatever the configured level
// (remoteBrainLimited; the registry carries the session's brain provider).
// Every level: isDeniedRemoteTool refuses commands and paths that reach
// credentials, the WhatsApp link itself, SynaBun's own state, persistence
// points (shell rc files, LaunchAgents, crontab) and browser profiles. That
// list is lexical — a speed bump, not a sandbox: a shell that builds a path at
// run time gets past it (docs/whatsapp.md, SECURITY.md).
// A call whose arguments the host did not pass is refused (argsComplete).
//
// Computer use (the Assistant's own computer tools) is off unless the owner
// turned on its switch at this computer (the policy's `computerUse`), and then
// only as remoteComputerUse says: unasked while Autonomous is active, after
// one yes per turn at Ask, never at Read-only, while paused or on a Codex /
// OpenCode brain. That function is the one place that decides; the runtime,
// the brain's hook, the desktop gate, the persona and the panel all ask it.
// A worker dispatched from a remote session never gets computer use
// (clampDispatchSpec), at any level.
//
// The registry is in memory. The runtime flags a remote session on its record,
// so after a restart a session nobody registered again reads as read-only.

import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import { resolve, relative, isAbsolute } from 'node:path';
import { isExemptTool } from './assistant-route-gate.js';
import { resolveWhatsAppPaths } from './whatsapp/paths.js';

export const LEVELS = Object.freeze(['read-only', 'ask', 'autonomous']);
export const DEFAULT_LEVEL = 'ask';
const RANK = Object.freeze({ 'read-only': 0, ask: 1, autonomous: 2 });

/** Brain providers that can hold a remote session at Ask and Autonomous (the in-process hook). */
export const REMOTE_ENFORCING_PROVIDERS = Object.freeze(['claude-code']);
const PROVIDER_LABELS = Object.freeze({ 'claude-code': 'Claude', codex: 'Codex', opencode: 'OpenCode' });
export function providerLabel(provider) { return PROVIDER_LABELS[provider] || String(provider || 'this brain'); }
/** True for a known brain other than Claude: a remote session on it is read-only. */
export function remoteBrainLimited(provider) {
  const value = String(provider || '').trim();
  return !!value && !REMOTE_ENFORCING_PROVIDERS.includes(value);
}
/** What the owner is told (once) when a remote conversation runs read-only because of its brain. */
export function remoteBrainNotice(provider) {
  return `This conversation runs read-only because its brain is ${providerLabel(provider)}; switch the WhatsApp brain to Claude for Ask/Autonomous.`;
}

/** A known level, else `fallback` (read-only: an unknown level fails closed). */
export function normalizeLevel(level, fallback = 'read-only') {
  return Object.prototype.hasOwnProperty.call(RANK, level) ? level : fallback;
}
function lowerOf(a, b) { return RANK[a] <= RANK[b] ? a : b; }
function toMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(n) ? n : null;
}

export class RemotePolicyError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'RemotePolicyError';
    this.code = code;
    this.status = status;
  }
}

/**
 * The level that applies now: null without a policy. Paused reads as
 * read-only, an expired (or never armed) autonomous as ask, a turn whose
 * prompt carried untrusted content is capped at ask, and a session whose brain
 * cannot hold Ask/Autonomous (`provider`, else the policy's brainProvider:
 * Codex, OpenCode) is read-only.
 */
export function effectiveLevel(policy, { untrusted = false, now = Date.now(), provider = null } = {}) {
  if (!policy) return null;
  let level = normalizeLevel(policy.level);
  if (policy.paused === true) level = 'read-only';
  if (level === 'autonomous') {
    const until = toMs(policy.autonomousUntil);
    if (!(until > now)) level = 'ask';
  }
  if (untrusted) level = lowerOf(level, 'ask');
  if (remoteBrainLimited(provider || policy.brainProvider)) level = 'read-only';
  return level;
}
/** The brain (not the configured level) is what makes this session read-only. */
export function brainCapsLevel(policy, { provider = null, now = Date.now() } = {}) {
  if (!policy || !remoteBrainLimited(provider || policy.brainProvider)) return false;
  return effectiveLevel({ ...policy, brainProvider: null }, { now }) !== 'read-only';
}

/**
 * The approval mode and plan flag a brain may run with. read-only forces plan
 * mode (`planApproved`: the desktop approved the plan, which may then run);
 * ask forces the approval mode to 'default' (every provider asks there);
 * autonomous keeps what was configured.
 */
export function clampBrainModes(policy, modes = {}, { untrusted = false, now = Date.now(), planApproved = false } = {}) {
  const permissionMode = modes.permissionMode && modes.permissionMode !== 'plan' ? String(modes.permissionMode) : 'default';
  const planMode = modes.planMode === true || modes.permissionMode === 'plan';
  const level = effectiveLevel(policy, { untrusted, now });
  if (!level || level === 'autonomous') return { permissionMode, planMode };
  if (level === 'ask') return { permissionMode: 'default', planMode };
  return { permissionMode: 'default', planMode: planApproved ? planMode : true };
}

// ── computer use ────────────────────────────────────────────────────────────

/** What remoteComputerUse answers: off, after one approval per turn, or unasked. */
export const COMPUTER_STATES = Object.freeze(['off', 'ask', 'allowed']);
/** Why: every `reason` remoteComputerUse can give, by state. */
export const COMPUTER_REASONS = Object.freeze({
  off: Object.freeze(['switch_off', 'brain', 'paused', 'read_only', 'unsupported', 'setup']),
  ask: Object.freeze(['ask', 'autonomous_expired', 'untrusted']),
  allowed: Object.freeze(['autonomous']),
});

/**
 * Computer use for a remote session at this moment → { state, reason, level },
 * or null without a policy (a desktop session: its own toggle decides).
 *   off      switch_off          the owner's switch (Settings → Messages → WhatsApp → Safety) is off
 *            brain               a Codex / OpenCode brain: it cannot ask before acting (read-only on this channel)
 *            paused              the channel is paused
 *            read_only           the Read-only level (or a session nobody registered since a restart)
 *            unsupported, setup  computer use is not available, or not set up, on this machine (`desktop`)
 *   ask      ask                 the Ask level: one yes per turn turns it on for that turn
 *            autonomous_expired  Autonomous is configured but its window is closed (or was never armed)
 *            untrusted           Autonomous is active, but this turn carries content the owner did not write
 *   allowed  autonomous          Autonomous is active: the computer tools run unasked
 * `desktop`: { supported, ready } of the desktop service (omitted: not checked).
 * The level is effectiveLevel's, unchanged.
 */
export function remoteComputerUse(policy, { untrusted = false, now = Date.now(), provider = null, desktop = null } = {}) {
  if (!policy) return null;
  const level = effectiveLevel(policy, { untrusted, now, provider });
  const off = (reason) => ({ state: 'off', reason, level });
  if (policy.computerUse !== true) return off('switch_off');
  if (remoteBrainLimited(provider || policy.brainProvider)) return off('brain');
  if (policy.paused === true) return off('paused');
  if (level === 'read-only') return off('read_only');
  if (desktop && desktop.supported !== true) return off('unsupported');
  if (desktop && desktop.ready !== true) return off('setup');
  if (level === 'autonomous') return { state: 'allowed', reason: 'autonomous', level };
  // Ask: say why when the owner configured Autonomous.
  let reason = 'ask';
  if (normalizeLevel(policy.level) === 'autonomous') reason = effectiveLevel(policy, { now, provider }) === 'autonomous' ? 'untrusted' : 'autonomous_expired';
  return { state: 'ask', reason, level };
}

/** Where the owner turns computer use on for this channel (the same words everywhere). */
export const COMPUTER_SWITCH_PATH = 'Settings → Messages → WhatsApp → Safety';
const COMPUTER_OFF_TEXT = Object.freeze({
  switch_off: `Computer use is off for WhatsApp conversations. The user turns it on in SynaBun on their computer: ${COMPUTER_SWITCH_PATH}.`,
  brain: 'Computer use is off in this WhatsApp conversation: its brain is not Claude, so it runs read-only.',
  paused: 'Computer use is off: WhatsApp is paused.',
  read_only: `Computer use is off at the Read-only level (the level is set in ${COMPUTER_SWITCH_PATH}).`,
  unsupported: 'Computer use is not available on this machine.',
  setup: 'Computer use is not set up on this Mac yet: the user finishes setup with the Computer switch in the Assistant panel.',
});
/** What a brain is told when a computer tool is refused (`reason`: remoteComputerUse's, or null). */
export function remoteComputerDenial(reason = null) {
  return COMPUTER_OFF_TEXT[reason] || 'Computer use is not available from WhatsApp right now.';
}

/** The route mode a remote session runs: below autonomous every task is approved on its route card. */
export function clampRouteMode(policy, mode, opts = {}) {
  const level = effectiveLevel(policy, opts);
  if (!level || level === 'autonomous') return mode;
  return 'always-ask';
}

/** Worker permission requests of this session are the user's to answer (never the brain's). */
export function requiresHumanApproval(policy, opts = {}) {
  const level = effectiveLevel(policy, opts);
  return !!level && level !== 'autonomous' && policy?.strictWorkerApprovals === true;
}

// ── registered projects ─────────────────────────────────────────────────────

/** The project paths SynaBun knows (DATA_HOME/data/claude-code-projects.json). */
export function readRegisteredProjects({ dataHome = defaultDataHome() } = {}) {
  try {
    const path = resolve(dataHome, 'data', 'claude-code-projects.json');
    if (!existsSync(path)) return [];
    const rows = JSON.parse(readFileSync(path, 'utf8'));
    return (Array.isArray(rows) ? rows : []).map((row) => (typeof row === 'string' ? row : row?.path)).filter(Boolean).map(String);
  } catch { return []; }
}
function inside(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
/** A worker cwd inside a registered project, never the home directory or anything above it. */
export function remoteCwdAllowed(cwd, registeredProjects = [], { home = homedir() } = {}) {
  const text = String(cwd || '').trim();
  if (!text || !isAbsolute(text)) return false;
  const path = resolve(text);
  if (inside(home, path)) return false; // $HOME itself, or a parent of it
  return (registeredProjects || []).some((project) => {
    const root = typeof project === 'string' ? project : project?.path;
    if (!root || !isAbsolute(String(root))) return false;
    if (inside(home, root)) return false; // a "project" at $HOME never counts
    return inside(path, root);
  });
}

/**
 * The dispatch a remote session may start: throws REMOTE_READ_ONLY (read-only)
 * or REMOTE_CWD_NOT_ALLOWED (ask, cwd outside the registered projects); else a
 * copy with computer use off, and at ask no "user-authorized-full" and, with
 * strict worker approvals, permissionPolicy 'ask' (Codex has no approval
 * channel: capability 'read-only' + policy 'restricted'). `notes` collects what changed.
 */
export function clampDispatchSpec(policy, spec = {}, { registeredProjects = [], defaultCwd = null, home = homedir(), untrusted = false, now = Date.now(), notes = null } = {}) {
  if (!policy) return spec;
  const level = effectiveLevel(policy, { untrusted, now });
  const note = (text) => { if (Array.isArray(notes) && !notes.includes(text)) notes.push(text); };
  if (level === 'read-only') {
    const fix = brainCapsLevel(policy, { now })
      ? `its brain is ${providerLabel(policy.brainProvider)}, which cannot ask before acting (switch the WhatsApp brain to Claude for Ask/Autonomous)`
      : 'raise the level in Settings → WhatsApp';
    throw new RemotePolicyError('REMOTE_READ_ONLY', `This session is driven from ${channelLabel(policy)} at the Read-only level, so it cannot start workers. Answer from what you can read, or ask the user to run it from SynaBun on their computer (${fix}).`);
  }
  const out = { ...spec };
  if (out.usesComputer === true || out.usesComputer === 'true') note(`computer use is off for ${channelLabel(policy)} sessions`);
  out.usesComputer = false;
  if (level !== 'ask') return out;
  const tags = Array.isArray(out.tags) ? out.tags.map(String) : [];
  if (tags.includes('user-authorized-full')) {
    out.tags = tags.filter((tag) => tag !== 'user-authorized-full');
    note('tag "user-authorized-full" dropped (only the desktop can authorize it)');
  }
  const cwd = String(out.cwd || out.project || defaultCwd || '').trim();
  if (!remoteCwdAllowed(cwd, registeredProjects, { home })) {
    throw new RemotePolicyError('REMOTE_CWD_NOT_ALLOWED', `A worker started from ${channelLabel(policy)} must run inside a registered project${cwd ? ` (not ${cwd})` : ''}. Use one of the registered project paths as cwd.`);
  }
  out.cwd = cwd;
  if (policy.strictWorkerApprovals === true) {
    if (String(out.provider || '').trim().toLowerCase() === 'codex') {
      out.capability = 'read-only';
      out.permissionPolicy = 'restricted';
      note('strict worker approvals: Codex runs read-only (it has no approval channel)');
    } else {
      out.permissionPolicy = 'ask';
      note('strict worker approvals: every permission request goes to the user');
    }
  }
  return out;
}

/** Whether a live run of this session goes past what the policy allows now (a lowered level stops it). */
export function runExceedsPolicy(policy, run = {}, { registeredProjects = [], home = homedir(), now = Date.now() } = {}) {
  const level = effectiveLevel(policy, { now });
  if (!level) return false;
  if (level === 'read-only') return true;
  if (run.usesComputer === true) return true;
  if (level !== 'ask') return false;
  if ((run.tags || []).includes('user-authorized-full')) return true;
  if (run.cwd && !remoteCwdAllowed(run.cwd, registeredProjects, { home })) return true;
  if (policy.strictWorkerApprovals === true) {
    if (run.provider === 'codex') return run.capability !== 'read-only';
    return run.permissionPolicy !== 'ask';
  }
  return false;
}

function channelLabel(policy) { return policy?.channel === 'whatsapp' || !policy?.channel ? 'WhatsApp' : String(policy.channel); }

// ── tools a remote session never runs ───────────────────────────────────────

function defaultDataHome(env = process.env) {
  if (env.SYNABUN_DATA_HOME) return resolve(env.SYNABUN_DATA_HOME);
  if (osPlatform() === 'win32' && env.APPDATA) return resolve(env.APPDATA, 'synabun');
  return resolve(homedir(), '.synabun');
}
/** Every place the WhatsApp Link may keep its session and connector (lib/whatsapp/paths.js), the refused override too. */
function whatsappLocations(dataHome, env, platform) {
  const out = [];
  try {
    const wa = resolveWhatsAppPaths({ dataHome, env, platform });
    out.push(wa.waHome, wa.defaultWaHome, wa.runtimeDir, wa.stagingDir);
  } catch {}
  const override = typeof env.SYNABUN_WHATSAPP_HOME === 'string' ? env.SYNABUN_WHATSAPP_HOME.trim() : '';
  if (override) out.push(resolve(override));
  if (env.LOCALAPPDATA) out.push(resolve(env.LOCALAPPDATA, 'synabun', 'whatsapp'));
  out.push(resolve(dataHome, 'whatsapp'), resolve(dataHome, 'runtime', 'whatsapp'));
  return [...new Set(out.filter(Boolean))];
}
const slash = (value) => String(value || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `a/./b` → `a/b`, `a/x/../b` → `a/b` (lexically, as a shell would hand them to the kernel). */
function dotSegments(text) {
  let out = text.replace(/\/\.(?=\/|$|[\s"'])/g, '');
  for (let i = 0; i < 32; i += 1) {
    const next = out.replace(/\/(?!\.\.(?:\/|$))[^/\s"'`;&|()]+\/\.\.(?=\/|$|[\s"'`;&|()])/, '');
    if (next === out) break;
    out = next;
  }
  return out;
}
/**
 * The spellings of one value to check: as written (Windows separators turned
 * into /), and with shell quoting and backslash escapes removed; each with ~,
 * $HOME and ${HOME} expanded and dot segments resolved.
 */
function spellings(raw, homeSlash) {
  const expand = (text) => dotSegments(text
    .replace(/\$\{home\}|\$home\b/g, homeSlash)
    .replace(/(^|[\s"'=:(])~(?=\/|$)/g, `$1${homeSlash}`));
  const written = slash(raw);
  const unquoted = slash(String(raw).replace(/\\(.)/g, '$1').replace(/["']/g, ''));
  return [...new Set([expand(written), expand(unquoted)])];
}

// A dotfile or a directory as a path segment (`~/.ssh`, `.aws/credentials`, `"$HOME/.netrc"`).
const segment = (name) => `(?:^|[^a-z0-9_.-])${escapeRe(name)}(?=$|[^a-z0-9_-])`;
// A program in command position (start, after ; & | ( ` or a wrapper such as sudo).
const program = (name) => `(?:^|[;&|(\`\\n]\\s*|\\b(?:sudo|env|xargs|nohup|exec|command|time|nice)\\s+)${escapeRe(name)}\\b`;

const DENIED_PATTERNS = [
  { re: new RegExp(segment('.ssh')), why: 'SSH keys' },
  { re: /\bid_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?\b/, why: 'SSH keys' },
  { re: /\bauthorized_keys2?\b/, why: 'SSH authorized_keys' },
  { re: new RegExp(segment('.aws')), why: 'AWS credentials' },
  { re: /(?:^|[^a-z0-9_-])\.config\/gh(?=$|[^a-z0-9_-])/, why: 'GitHub CLI credentials' },
  { re: new RegExp(segment('.npmrc')), why: 'npm credentials' },
  { re: new RegExp(segment('.netrc')), why: '.netrc credentials' },
  { re: new RegExp(segment('.git-credentials')), why: 'git credentials' },
  { re: new RegExp(segment('.gnupg')), why: 'GnuPG keys' },
  { re: /(?:^|[^a-z0-9_-])\.docker\/config\.json\b/, why: 'Docker credentials' },
  { re: /(?:^|[^a-z0-9_-])\.kube\/config\b/, why: 'Kubernetes credentials' },
  { re: /\.credentials\.json\b/, why: 'Claude credentials' },
  { re: /(?:^|[^a-z0-9_-])\.claude\/settings[^/\s"']*\.json\b/, why: 'Claude settings' },
  { re: /(?:^|[^a-z0-9_-])\.codex\/(?:auth\.json|config\.toml)\b/, why: 'Codex credentials' },
  { re: /\bmcp-api-key\.json\b/, why: 'the SynaBun MCP key' },
  { re: /\/library\/keychains\b|\.keychain(?:-db)?\b/, why: 'keychains' },
  { re: new RegExp(`${program('security')}\\s+(?:find-|dump-keychain|export|unlock-keychain|delete-|add-(?:generic|internet)-password|set-(?:generic|internet)-password|import)`), why: 'keychains' },
  { re: /library\/application support\/(?:google\/chrome|chromium|bravesoftware|microsoft edge|arc|vivaldi|firefox|opera)|\/library\/safari\b|\/library\/cookies\b|\.mozilla\/firefox|\.config\/(?:google-chrome|chromium|bravesoftware|microsoft-edge|vivaldi)\b|\bbrowser-profiles\b|\blogin data\b|\bcookies\.(?:sqlite|binarycookies)\b/, why: 'browser profiles' },
  { re: new RegExp(['.zshrc', '.zshenv', '.zprofile', '.zlogin', '.zlogout', '.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.profile', '.kshrc', '.cshrc', '.tcshrc'].map(segment).join('|')), why: 'shell startup files' },
  { re: /(?:^|[^a-z0-9_-])\.config\/fish\/(?:config\.fish|conf\.d)\b/, why: 'shell startup files' },
  { re: /\blaunch(?:agents|daemons)\b/, why: 'LaunchAgents' },
  { re: new RegExp(program('launchctl')), why: 'LaunchAgents' },
  { re: new RegExp(program('crontab')), why: 'crontab' },
  { re: /\/etc\/cron|\/var\/at\/tabs|\/usr\/lib\/cron|\/var\/spool\/cron/, why: 'crontab' },
  { re: /\/api\/whatsapp\b/, why: 'the WhatsApp link' },
  { re: /(?:^|[^a-z0-9_-])runtime\/whatsapp\b/, why: 'the WhatsApp link' },
  { re: /(?:^|[^a-z0-9_-])\.?synabun\/whatsapp\b/, why: 'the WhatsApp link' },
  // The session store by name, wherever it sits (a relative path, a moved home): state.db and its -wal/-shm/-journal.
  { re: /(?:^|[^a-z0-9_.-])state\.db(?:-(?:wal|shm|journal))?(?=$|[^a-z0-9_.-])/, why: 'the WhatsApp login (state.db)' },
  { re: /(?:^|[^a-z0-9_.-])whatsapp\/auth(?=$|[^a-z0-9_.-])/, why: 'the WhatsApp login' },
  // SynaBun's own state: the config rows (the WhatsApp level lives in kv_config) and the registered projects.
  { re: /\b(?:kv_config|whatsapp_config)\b/, why: 'SynaBun settings' },
  { re: /\bclaude-code-projects\.json\b/, why: 'SynaBun settings' },
];

// Built-in tools (Claude's, OpenCode's lower-case ones): the input keys that name a path or a command (never file contents).
const BUILTIN_KEYS = {
  bash: ['command'], powershell: ['command'], bashoutput: [],
  read: ['file_path', 'filePath', 'filepath', 'path'], write: ['file_path', 'filePath', 'filepath', 'path'],
  edit: ['file_path', 'filePath', 'filepath', 'path'], multiedit: ['file_path', 'filePath', 'filepath', 'path'],
  notebookedit: ['notebook_path', 'notebookPath', 'path'], notebookread: ['notebook_path', 'notebookPath', 'path'], ls: ['path'],
  glob: ['pattern', 'path'], grep: ['path', 'glob'],
};
// Built-ins whose check needs one of their keys: a call without any is refused (its target is unknown).
const REQUIRED_KEYS = {
  bash: ['command'], powershell: ['command'],
  read: BUILTIN_KEYS.read, write: BUILTIN_KEYS.write, edit: BUILTIN_KEYS.edit, multiedit: BUILTIN_KEYS.multiedit,
  notebookedit: BUILTIN_KEYS.notebookedit, notebookread: BUILTIN_KEYS.notebookread, ls: ['path'], glob: ['pattern', 'path'],
};
// Any tool: string values under keys that look like a path, a command or a URL (camelCase keys too: filePath, localFilePath).
const PATHISH_KEY = /(?:^|_|-)(?:path|paths|file|files|filepath|filename|dir|directory|cwd|workdir|command|commands|cmd|url|urls|uri|src|source|dest|destination|target|glob|location)$/i;
const pathishKey = (key) => PATHISH_KEY.test(String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2'));
// The longest value checked; a longer one is refused rather than checked in part.
const MAX_VALUE_CHARS = 20_000;

function collect(value, keyHint, out, depth, pathish) {
  if (depth > 5) { out.overflow = true; return; }
  if (out.length >= 64) { out.overflow = true; return; }
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (keyHint && !pathish(keyHint)) return;
    if (value.length > MAX_VALUE_CHARS) out.overflow = true;
    else out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 64) out.overflow = true;
    for (const item of value.slice(0, 64)) collect(item, keyHint, out, depth + 1, pathish);
    return;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length > 64) out.overflow = true;
    for (const [key, item] of entries.slice(0, 64)) collect(item, key, out, depth + 1, pathish);
  }
}

/** Computer-use tools under any host's name (mcp__SynaBun__computer*, SynaBun_computer*, bare). */
export function isComputerTool(name) {
  const text = String(name || '');
  return /^mcp__synabun__computer/i.test(text) || /^synabun_computer/i.test(text) || /^computer(?:_apps|_ax|_status)?$/i.test(text);
}

/**
 * Why a remote session may not run this tool call, else null. `paths`
 * overrides the locations (tests): { home, dataHome, waHome, env, platform }.
 * `argsComplete: false` says the host did not pass the call's arguments:
 * anything but SynaBun's own coordination tools is then refused (fail closed).
 * A computer tool is refused unless the caller passes `computerAllowed: true`
 * (the runtime, when remoteComputerUse allows this turn); `computerReason`
 * (remoteComputerUse's reason) words the refusal.
 */
export function remoteToolDenial(name, input = {}, { home = homedir(), dataHome = null, waHome = null, env = process.env, platform = osPlatform(), argsComplete = true, computerAllowed = false, computerReason = null } = {}) {
  const tool = String(name || '');
  if (isComputerTool(tool) && computerAllowed !== true) return remoteComputerDenial(computerReason);
  const unseen = `${tool}: SynaBun could not see this call's arguments, so a remote session does not run it.`;
  const hasArgs = input !== null && typeof input === 'object' && !Array.isArray(input);
  if ((argsComplete === false || !hasArgs) && !isExemptTool(tool)) return unseen;
  const args = hasArgs ? input : {};
  const lower = tool.toLowerCase();
  const required = REQUIRED_KEYS[lower];
  const present = (key) => { const value = args[key]; return (typeof value === 'string' && value.trim() !== '') || (Array.isArray(value) && value.length > 0); };
  if (required && !required.some(present)) return unseen;
  const values = [];
  for (const key of BUILTIN_KEYS[lower] || []) collect(args[key], null, values, 0, () => true);
  collect(args, null, values, 0, pathishKey);
  if (values.overflow) return `${tool}: the call is too long for SynaBun to check, so a remote session does not run it.`;
  if (!values.length) return null;
  const data = dataHome ? resolve(dataHome) : defaultDataHome(env);
  const homeSlash = slash(home);
  const specific = [
    ...(waHome ? [resolve(waHome)] : whatsappLocations(data, env, platform)).map((path) => ({ path: slash(path), why: 'the WhatsApp link' })),
    { path: slash(resolve(data, '.env')), why: 'SynaBun secrets (.env)' },
    { path: slash(resolve(data, 'data', 'browser-profiles')), why: 'browser profiles' },
  ];
  for (const raw of values) {
    for (const text of spellings(raw, homeSlash)) {
      for (const { path, why } of specific) if (path && text.includes(path)) return `${tool} touches ${why}, which a remote session never reaches.`;
      for (const { re, why } of DENIED_PATTERNS) if (re.test(text)) return `${tool} touches ${why}, which a remote session never reaches.`;
    }
  }
  return null;
}

/** True when a remote session must not run this tool call at any level. */
export function isDeniedRemoteTool(name, input = {}, paths = {}) {
  return remoteToolDenial(name, input, paths) !== null;
}

// ── registry ────────────────────────────────────────────────────────────────

/**
 * Per-session policies. `markRemote` records a session the runtime flagged on
 * its record: without a registered policy it reads as read-only (fail closed),
 * computer use off.
 * `setSessionBrain` records the session's brain provider (the runtime sets it
 * whenever the brain changes): it rides on every policy as `brainProvider`, so
 * effectiveLevel caps a Codex / OpenCode session at read-only for every reader.
 */
export function createRemotePolicyRegistry({ now = Date.now } = {}) {
  const policies = new Map(); // sessionId → policy
  const flagged = new Map();  // sessionId → { channel }
  const brains = new Map();   // sessionId → brain provider
  const listeners = new Set();
  const key = (id) => String(id ?? '').trim();
  function notify(sessionId, previous) {
    const policy = getSessionPolicy(sessionId);
    for (const listener of [...listeners]) { try { listener({ sessionId, policy, previous }); } catch {} }
  }
  function withBrain(sessionId, policy) {
    return Object.freeze({ ...policy, brainProvider: brains.get(sessionId) || null });
  }
  function registerSessionPolicy(id, { level = DEFAULT_LEVEL, channel = 'whatsapp', autonomousUntil = null, strictWorkerApprovals = false, paused = false, computerUse = false } = {}) {
    const sessionId = key(id);
    if (!sessionId) throw new RemotePolicyError('SESSION_REQUIRED', 'registerSessionPolicy needs a session id', 400);
    const previous = getSessionPolicy(sessionId);
    const policy = Object.freeze({
      sessionId, level: normalizeLevel(level), channel: String(channel || 'whatsapp'),
      autonomousUntil: toMs(autonomousUntil), strictWorkerApprovals: strictWorkerApprovals === true, paused: paused === true,
      // The owner's switch for computer use on this channel: only ever true when it was turned on at this computer.
      computerUse: computerUse === true,
      registeredAt: now(),
    });
    policies.set(sessionId, policy);
    flagged.set(sessionId, { channel: policy.channel });
    notify(sessionId, previous);
    return withBrain(sessionId, policy);
  }
  /** The session stays flagged: it reads as read-only until registered again. */
  function clearSessionPolicy(id) {
    const sessionId = key(id);
    const previous = policies.has(sessionId) ? getSessionPolicy(sessionId) : null;
    if (!previous) return false;
    policies.delete(sessionId);
    notify(sessionId, previous);
    return true;
  }
  function getSessionPolicy(id) {
    const sessionId = key(id);
    if (!sessionId) return null;
    const policy = policies.get(sessionId);
    if (policy) return withBrain(sessionId, policy);
    const flag = flagged.get(sessionId);
    if (!flag) return null;
    return withBrain(sessionId, { sessionId, level: 'read-only', channel: flag.channel, autonomousUntil: null, strictWorkerApprovals: true, paused: false, computerUse: false, registeredAt: null, failClosed: true });
  }
  function markRemote(id, { channel = 'whatsapp' } = {}) {
    const sessionId = key(id);
    if (!sessionId) return;
    if (!flagged.has(sessionId)) flagged.set(sessionId, { channel: String(channel || 'whatsapp') });
  }
  /** The session's brain provider changed (null clears it): a remote session's listeners hear it. */
  function setSessionBrain(id, provider) {
    const sessionId = key(id);
    if (!sessionId) return;
    const next = provider ? String(provider) : null;
    if ((brains.get(sessionId) || null) === next) return;
    const previous = getSessionPolicy(sessionId);
    if (next) brains.set(sessionId, next); else brains.delete(sessionId);
    if (previous) notify(sessionId, previous);
  }
  /** The session is gone (destroyed): forget it entirely. */
  function forgetSession(id) {
    const sessionId = key(id);
    policies.delete(sessionId);
    flagged.delete(sessionId);
    brains.delete(sessionId);
  }
  function isRemote(id) { const sessionId = key(id); return policies.has(sessionId) || flagged.has(sessionId); }
  function subscribe(listener) {
    if (typeof listener !== 'function') throw new Error('subscribe requires a function');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  function list() { return [...new Set([...policies.keys(), ...flagged.keys()])].map((id) => getSessionPolicy(id)); }
  return { registerSessionPolicy, clearSessionPolicy, getSessionPolicy, markRemote, setSessionBrain, forgetSession, isRemote, subscribe, list };
}

// The process-wide registry the runtime, the dispatcher and the WhatsApp bridge share.
export const defaultRemotePolicyRegistry = createRemotePolicyRegistry();
export function registerSessionPolicy(id, options) { return defaultRemotePolicyRegistry.registerSessionPolicy(id, options); }
export function clearSessionPolicy(id) { return defaultRemotePolicyRegistry.clearSessionPolicy(id); }
export function getSessionPolicy(id) { return defaultRemotePolicyRegistry.getSessionPolicy(id); }

/**
 * The phone's authority over computer use, as a capability instead of a string.
 *
 * `origin: 'whatsapp'` is text any caller in this process can write, so it says who is recorded in
 * the audit and nothing more. What may grant computer use from a WhatsApp conversation (the yes of
 * a turn, the Mac part of a marked route card, and a turn that counts as the owner's own plain
 * message from the phone) is the holder of the capability this returns.
 *
 * The composition root makes ONE of these and splits it: `verify` goes to the Assistant runtime,
 * `issue` / `revoke` to the WhatsApp service, which hands a fresh capability to each bridge it
 * builds. A capability is a Symbol: it cannot be guessed, rebuilt from its description, sent over a
 * socket or written to disk. Issuing a new one ends the one before, so at most one holder exists.
 *
 * @returns {{ issue: () => symbol, revoke: () => void, verify: (capability: unknown) => boolean }}
 */
export function createPhoneAuthority() {
  let current = null;
  return Object.freeze({
    issue() { current = Symbol('synabun.phone-authority'); return current; },
    revoke() { current = null; },
    verify(capability) { return typeof capability === 'symbol' && current !== null && capability === current; },
  });
}
