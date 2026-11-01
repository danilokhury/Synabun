import { assertSafeAntigravityProject } from './home.js';
// ═══════════════════════════════════════════
// SynaBun — the Antigravity side panel's server end (/ws/antigravity)
// ═══════════════════════════════════════════
//
// One socket per panel window, one `agy acp` process per socket (started on the
// socket's `hello`, again after it ended or on `agent:restart`), one ACP session per
// tab. The page asks with `{ type, reqId, ... }` and gets
// `{ type: 'result', reqId, ok, data | error, authRequired }` (an error carries a string
// `code`); what the agent says on its own comes as events:
//
//   session:update       { sessionId, update, replay }    an ACP session/update, as sent
//   permission:request   { requestId, sessionId, toolCall, options }
//   permission:resolved  { requestId, outcome }           answered, or cancelled by a turn's end
//   elicitation:request  { requestId, sessionId, toolCallId, message, mode, requestedSchema?, url?, elicitationId? }
//                        the agent asks the owner for input: a form (`requestedSchema`), a page to open
//                        (`url`: https, or http on this computer; any other is declined and never shown),
//                        or a mode the page may not know (it can still decline or cancel it)
//   elicitation:resolved { requestId, sessionId, action }  answered (accept / decline / cancel); 'complete' when
//                        the agent says an accepted page is done (elicitation/complete); 'cancel' when the turn
//                        that asked ends, after 30 minutes, when the session closes or the agent ends
//   terminal:output      { sessionId, terminalId, output, truncated, exitStatus }  a terminal the agent runs
//                        through SynaBun: its whole current output (bounded) at most every 250 ms while it grows,
//                        and once when it ends (`exitStatus` { exitCode, signal }, null while it runs); a tool
//                        call whose content is { type: 'terminal', terminalId } shows it
//   turn:end             { sessionId, stopReason, usage }  after every prompt, also failed ones
//   agent:exit           { code, signal, error, stderr }   the process ended (not after agent:restart)
//
// Requests: hello, agent:restart, session:new, session:load, session:resume, session:fork,
// session:delete, session:list, session:close, prompt, cancel, config:set, mode:set, model:set,
// permission:answer, elicitation:answer, auth:start, auth:logout, session:bypass (a tab's Bypass: lib/antigravity/bypass.js;
// every request of that session is answered allow-once and reported as permission:auto { requestId, sessionId,
// toolCall, decision: 'allowed' | 'refused', rule?, reason? }; the hard rails still refuse). `capabilities` in the hello
// answer lists what this server does; the page offers a feature only while it is listed (public/
// reloads at any time, lib/ only with a restart), and resume, fork, delete, other folders and
// sign-out only while the agent's own `agentCapabilities` say it does them too (otherwise they
// answer UNSUPPORTED, and other folders are left out of what the agent is sent).
//
// What the agent is offered (ACP clientCapabilities): forms and pages to open (elicitation),
// sign-in methods that run in a terminal, compaction, boolean settings, notices, plan updates and
// subagent sessions always; the owner's files and terminals only when the page's hello (or
// agent:restart) asks for them with `clientCapabilities: { fs, terminal }` (both off by default),
// answered by lib/antigravity/acp-client-host.js. The socket keeps those switches; a running agent
// keeps what it was started with until agent:restart.
//
// What the page sends is never trusted: a cwd must be an absolute folder that exists
// (`validateCwd` may narrow it further), and so must every other folder of a session (at most 8);
// attachments are bounded in number, size and type, a path to attach must be an absolute regular
// file, a permission answer must name one of the options the agent offered for that very request,
// and an elicitation answer is a flat object of bounded strings, numbers, booleans and string lists.
//
// A prompt is also a person's message (`onHumanPrompt`: the greeting notes the activity), may be `/synabun …`
// (`expandPrompt` turns it into the bundled skill's instructions, as the Codex panel does: capability
// 'synabun-command') and may carry `greetingId`, the greeting the tab opened with (capability 'greeting'):
// `greetingNote` gives its note once, sent before the typed words between the markers of
// public/shared/agy/agy-greeting.js.

import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAcpClientHost } from './acp-client-host.js';
import { acpErrorInfo, createAcpConnection, isAuthRequired } from './acp-connection.js';
import { allowOnceOption, bypassRail, rejectOnceOption } from './bypass.js';
import { greetingNoteBlock } from '../../public/shared/agy/agy-greeting.js';

export const ANTIGRAVITY_WS_PATH = '/ws/antigravity';
export const ANTIGRAVITY_PANEL_CAPABILITIES = Object.freeze([
  'session-new', 'session-load', 'session-list', 'session-close', 'prompt', 'cancel',
  'config-options', 'modes', 'model-set', 'permissions', 'attachments', 'attach-paths', 'auth', 'usage',
  'session-resume', 'session-fork', 'session-delete', 'additional-directories', 'agent-restart',
  'client-fs', 'client-terminal', 'elicitation', 'audio', 'logout', 'bypass', 'greeting', 'synabun-command', 'run-homes',
]);
export const ANTIGRAVITY_LIMITS = Object.freeze({
  maxAttachments: 8,
  maxAttachmentBytes: 15 * 1024 * 1024,
  maxPromptChars: 200_000,
  maxPaths: 20,
  maxAdditionalDirectories: 8,
  permissionTimeoutMs: 30 * 60_000,
  elicitationTimeoutMs: 30 * 60_000,
  authTimeoutMs: 10 * 60_000,
  maxElicitationFields: 50,
  maxElicitationText: 10_000,
  maxElicitationItems: 50,
  maxElicitationMessage: 20_000,
});
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const ATTACHABLE_TYPES = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/[a-z0-9.+-]+|application\/(json|xml|x-yaml|yaml)|audio\/(wav|x-wav|mpeg|mp4|aac|flac|ogg|opus|webm))$/;
const ID_RE = /^[A-Za-z0-9._:@-]{1,200}$/;
const CAPABILITY_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const ELICITATION_ACTIONS = new Set(['accept', 'decline', 'cancel']);

/** A safe file name for an attachment: no folders, no control characters, an extension kept. */
export function safeAttachmentName(name, mimeType = '') {
  const raw = basename(String(name || '').replace(/\\/g, '/')).replace(/[\u0000-\u001f<>:"|?*]/g, '').trim();
  const fallbackExt = mimeType === 'image/jpeg' ? '.jpg' : mimeType.startsWith('image/') ? `.${mimeType.slice(6)}` : '';
  const cleaned = raw.replace(/^\.+/, '').slice(-120) || `attachment${fallbackExt || '.bin'}`;
  return extname(cleaned) ? cleaned : `${cleaned}${fallbackExt}`;
}

/** Turns the page's prompt (text, pasted files, paths) into ACP content blocks. Throws on what it refuses. */
export function buildPromptBlocks({ text = '', attachments = [], paths = [] } = {}, {
  promptCapabilities = {},
  saveAttachment,
  limits = ANTIGRAVITY_LIMITS,
  statImpl = statSync,
} = {}) {
  const blocks = [];
  const body = typeof text === 'string' ? text : '';
  if (body.length > limits.maxPromptChars) throw Object.assign(new Error(`The message is longer than ${limits.maxPromptChars} characters.`), { code: 'PROMPT_TOO_LONG' });
  if (body.trim()) blocks.push({ type: 'text', text: body });
  const files = Array.isArray(attachments) ? attachments : [];
  const links = Array.isArray(paths) ? paths : [];
  if (files.length > limits.maxAttachments) throw Object.assign(new Error(`At most ${limits.maxAttachments} attachments per message.`), { code: 'TOO_MANY_ATTACHMENTS' });
  if (links.length > limits.maxPaths) throw Object.assign(new Error(`At most ${limits.maxPaths} files per message.`), { code: 'TOO_MANY_PATHS' });
  for (const file of files) {
    const mimeType = String(file?.mimeType || '').toLowerCase();
    if (!ATTACHABLE_TYPES.test(mimeType)) throw Object.assign(new Error(`Antigravity cannot take a ${mimeType || 'file of unknown type'} attachment.`), { code: 'ATTACHMENT_TYPE' });
    const data = typeof file?.data === 'string' ? file.data : '';
    if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw Object.assign(new Error('An attachment arrived empty or damaged.'), { code: 'ATTACHMENT_DATA' });
    const size = Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
    if (size > limits.maxAttachmentBytes) throw Object.assign(new Error(`An attachment is larger than ${Math.round(limits.maxAttachmentBytes / 1048576)} MB.`), { code: 'ATTACHMENT_SIZE' });
    const name = safeAttachmentName(file?.name, mimeType);
    if (IMAGE_TYPES.has(mimeType) && promptCapabilities?.image) {
      blocks.push({ type: 'image', mimeType, data });
      continue;
    }
    if (mimeType.startsWith('audio/') && promptCapabilities?.audio) {
      blocks.push({ type: 'audio', mimeType, data });
      continue;
    }
    if (typeof saveAttachment !== 'function') throw Object.assign(new Error('Attachments are not available.'), { code: 'ATTACHMENT_UNAVAILABLE' });
    const saved = saveAttachment(name, Buffer.from(data, 'base64'));
    blocks.push({ type: 'resource_link', uri: pathToFileURL(saved).href, name, mimeType, size });
  }
  for (const entry of links) {
    const path = typeof entry === 'string' ? entry : '';
    if (!path || !isAbsolute(path)) throw Object.assign(new Error('A file to attach must be an absolute path.'), { code: 'PATH_INVALID' });
    let stat;
    try { stat = statImpl(path); } catch { throw Object.assign(new Error(`No such file: ${path}`), { code: 'PATH_MISSING' }); }
    if (!stat.isFile() && !stat.isDirectory()) throw Object.assign(new Error(`Not a file or folder: ${path}`), { code: 'PATH_INVALID' });
    blocks.push({ type: 'resource_link', uri: pathToFileURL(path).href, name: basename(path) || path, ...(stat.isFile() ? { size: stat.size } : {}) });
  }
  if (!blocks.length) throw Object.assign(new Error('Nothing to send.'), { code: 'EMPTY_PROMPT' });
  return blocks;
}

/** The absolute, existing folder a session may run in, by its real path. */
export function defaultValidateCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd || !isAbsolute(cwd)) throw Object.assign(new Error('Choose a project folder first.'), { code: 'CWD_INVALID' });
  let real;
  try { real = realpathSync(cwd); } catch { throw Object.assign(new Error(`The folder ${cwd} does not exist.`), { code: 'CWD_MISSING' }); }
  if (!statSync(real).isDirectory()) throw Object.assign(new Error(`${cwd} is not a folder.`), { code: 'CWD_INVALID' });
  return real;
}

const RUN_HOME_NAME_RE = /^run-[A-Za-z0-9_-]+$/;
export const RUN_HOME_PRUNED_MESSAGE = 'This dispatched run\x27s conversation folder was already cleaned up, so the conversation can no longer be continued here. Start a new tab instead.';

/**
 * Validates a `geminiDir` sent by the page for a continued dispatched-run tab: null for an ordinary tab
 * (default ~/.gemini), else the real path of an existing SynaBun per-run home directly under `homesRoot`.
 * Never touches paths outside `homesRoot`; throws HOME_INVALID on any path outside it or a symlink, and
 * HOME_PRUNED when a valid run home folder was already cleaned up.
 */
export function validateRunHome(geminiDir, homesRoot) {
  if (geminiDir === undefined || geminiDir === null || geminiDir === '') return null;
  const invalid = () => Object.assign(new Error('That Antigravity conversation folder is outside SynaBun\x27s run homes.'), { code: 'HOME_INVALID' });
  if (typeof geminiDir !== 'string' || !isAbsolute(geminiDir)) throw invalid();
  const rawRoot = typeof homesRoot === 'function' ? homesRoot() : homesRoot;
  if (typeof rawRoot !== 'string' || !rawRoot || !isAbsolute(rawRoot)) throw invalid();
  const resolvedRoot = resolve(rawRoot);
  let canonRoot = resolvedRoot;
  try { canonRoot = realpathSync(resolvedRoot); } catch {
    const rootParent = dirname(resolvedRoot);
    if (rootParent && rootParent !== resolvedRoot) {
      try { canonRoot = join(realpathSync(rootParent), basename(resolvedRoot)); } catch { /* keep resolvedRoot */ }
    }
  }
  const candidate = resolve(geminiDir);
  const name = basename(candidate);
  if (!RUN_HOME_NAME_RE.test(name)) throw invalid();
  const allowedParents = new Set([resolvedRoot, canonRoot]);
  if (canonRoot.startsWith('/private/')) allowedParents.add(canonRoot.slice('/private'.length));
  if (!allowedParents.has(dirname(candidate))) throw invalid();
  const target = join(canonRoot, name);
  let stat;
  try {
    stat = lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') throw Object.assign(new Error(RUN_HOME_PRUNED_MESSAGE), { code: 'HOME_PRUNED' });
    throw invalid();
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw invalid();
  let realTarget;
  let realRoot;
  try {
    realTarget = realpathSync(target);
    realRoot = realpathSync(canonRoot);
  } catch {
    throw invalid();
  }
  if (dirname(realTarget) !== realRoot || basename(realTarget) !== name) throw invalid();
  return realTarget;
}

/** The page's switches ({ fs, terminal }), read strictly: only `true` turns one on. */
export function clientSwitches(value) {
  return { fs: value?.fs === true, terminal: value?.terminal === true };
}

/** What the panel offers the agent at `initialize` (ACP clientCapabilities), for the page's switches. */
export function acpClientCapabilities(switches = {}) {
  const { fs, terminal } = clientSwitches(switches);
  return {
    fs: { readTextFile: fs, writeTextFile: fs },
    terminal,
    auth: { terminal: true },
    elicitation: { form: {}, url: {} },
    session: { compaction: {}, configOptions: { boolean: {} }, notices: {} },
    plan: {},
    subagents: {},
  };
}

// The names of what an agent advertises in one capability object ({} or true), each as true.
function advertised(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, entry] of Object.entries(value).slice(0, 64)) {
    if (key === '_meta' || !CAPABILITY_KEY_RE.test(key)) continue;
    if (entry === true || (entry && typeof entry === 'object')) out[key] = true;
  }
  return out;
}

/** A plain copy of the agent's capabilities for the page: flags only, nothing else it sent. */
export function agentCapabilitiesView(capabilities) {
  const caps = capabilities && typeof capabilities === 'object' ? capabilities : {};
  const flags = (value, keys) => Object.fromEntries(keys.map((key) => [key, value?.[key] === true]));
  return {
    loadSession: caps.loadSession === true,
    promptCapabilities: flags(caps.promptCapabilities, ['image', 'audio', 'embeddedContext']),
    mcpCapabilities: flags(caps.mcpCapabilities, ['http', 'sse', 'acp']),
    auth: advertised(caps.auth),
    sessionCapabilities: advertised(caps.sessionCapabilities || caps.session_capabilities),
    providers: !!(caps.providers && typeof caps.providers === 'object'),
  };
}

/**
 * The agent's sign-in methods for the page: id, name, description, type ('agent' when it names
 * none), and for a method that runs in a terminal its `args` and the names of its `env` (never
 * their values).
 */
export function authMethodsView(methods) {
  const out = [];
  for (const method of Array.isArray(methods) ? methods.slice(0, 32) : []) {
    if (!method || typeof method !== 'object' || typeof method.id !== 'string' || !method.id) continue;
    const view = {
      id: method.id,
      name: typeof method.name === 'string' && method.name ? method.name : method.id,
      description: typeof method.description === 'string' ? method.description : null,
      type: typeof method.type === 'string' && method.type ? method.type : 'agent',
    };
    if (Array.isArray(method.args)) view.args = method.args.filter((arg) => typeof arg === 'string').slice(0, 50).map((arg) => arg.slice(0, 1000));
    if (method.env && typeof method.env === 'object' && !Array.isArray(method.env)) view.env = Object.keys(method.env).slice(0, 50);
    out.push(view);
  }
  return out;
}

/** A page the agent asks the owner to open: https anywhere, http on this computer only; null otherwise. */
export function safeElicitationUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 8192) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) return url.href;
  return null;
}

/**
 * What the page answers an elicitation with (`accept` only): a plain object of at most 50 fields,
 * each a string (≤ 10,000 characters), a number, a boolean or a list of at most 50 such strings.
 * Undefined when there is none; throws ELICITATION_CONTENT_INVALID on anything else.
 */
export function elicitationContent(content, limits = ANTIGRAVITY_LIMITS) {
  if (content === undefined || content === null) return undefined;
  const refuse = (why) => Object.assign(new Error(`The answer cannot be sent: ${why}.`), { code: 'ELICITATION_CONTENT_INVALID' });
  if (typeof content !== 'object' || Array.isArray(content)) throw refuse('it is not a set of fields');
  const proto = Object.getPrototypeOf(content);
  if (proto !== Object.prototype && proto !== null) throw refuse('it is not a set of fields');
  const keys = Object.keys(content);
  if (keys.length > limits.maxElicitationFields) throw refuse(`more than ${limits.maxElicitationFields} fields`);
  const entries = [];
  for (const key of keys) {
    if (!key || key.length > 200) throw refuse('a field name is empty or too long');
    const value = content[key];
    if (typeof value === 'string') {
      if (value.length > limits.maxElicitationText) throw refuse(`${key} is longer than ${limits.maxElicitationText} characters`);
      entries.push([key, value]);
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw refuse(`${key} is not a number`);
      entries.push([key, value]);
    } else if (typeof value === 'boolean') {
      entries.push([key, value]);
    } else if (Array.isArray(value)) {
      if (value.length > limits.maxElicitationItems) throw refuse(`${key} has more than ${limits.maxElicitationItems} choices`);
      if (value.some((item) => typeof item !== 'string' || item.length > limits.maxElicitationText)) throw refuse(`${key} is not a list of choices`);
      entries.push([key, [...value]]);
    } else {
      throw refuse(`${key} is not text, a number, a yes / no or a list of choices`);
    }
  }
  // Built from its entries: a field named __proto__ stays a field.
  return Object.fromEntries(entries);
}

/**
 * `resolveLaunch()`: { command, args, version? } for `agy`, or null when it is not installed.
 * `childEnv()`: the agent process's environment (and the base of every command it runs through the
 * panel). `attachmentsRoot`: a folder of SynaBun's own (under the data home) where attachments are
 * written for the agent to read. `connect` and `createClientHost` are there for tests.
 */
// What a process that ended before (or while) it answered `initialize` said, as one error the page can show:
// the last lines of its stderr (already redacted by the connection), and ACP_UNSUPPORTED for an agy without
// the `acp` subcommand (1.4.6 answers 'Error: unexpected argument "acp".' and exits 2).
const STDERR_LINES = 4;
const STDERR_CHARS = 600;
export function stderrSummary(stderr) {
  const lines = String(stderr || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const tail = lines.slice(-STDERR_LINES).join('\n');
  return tail.length > STDERR_CHARS ? `…${tail.slice(-STDERR_CHARS)}` : tail;
}
export function agentStartError(error, exit) {
  const stderr = stderrSummary(exit?.stderr || error?.stderr);
  if (/unexpected argument\W+acp\b|unknown (sub)?command\W+acp\b/i.test(stderr)) {
    return Object.assign(new Error('This Antigravity CLI has no ACP server (`agy acp`), which the panel needs. Update it (`agy update`, or `brew upgrade --cask antigravity-cli`), then try again.'), { code: 'ACP_UNSUPPORTED', stderr });
  }
  if (!stderr) return error;
  const base = exit && (exit.code !== null || exit.signal) && !exit.error ? `Antigravity exited (${exit.signal || exit.code})` : (error?.message || 'Antigravity failed to start');
  return Object.assign(new Error(`${base}: ${stderr}`), { code: error?.code, stderr });
}

export function createAntigravityPanelBridge({
  resolveLaunch,
  childEnv = () => process.env,
  connect = createAcpConnection,
  createClientHost = createAcpClientHost,
  attachmentsRoot,
  homesRoot = null,
  isRunHomeActive = null,
  validateCwd = defaultValidateCwd,
  clientInfo = { name: 'synabun', title: 'SynaBun', version: '0' },
  limits = ANTIGRAVITY_LIMITS,
  log = () => {},
  policyRoots = () => [],
  onSessionActivity = null,
  onHumanPrompt = null,     // ({ cwd, words }): a person sent a message (lib/greeting noteActivity)
  greetingNote = null,      // (greetingId, { skip }) => the note to tell the model once, or ''
  expandPrompt = null,      // (text) => the text sent (`/synabun …` → the bundled skill), or the same text
  onTurnEnd = null,         // ({ sessionId, cwd }): a prompt ended (its transcript may have changed)
} = {}) {
  const live = new Set();
  const stopping = new Set();
  const attachmentName = (id) => {
    const safe = id.replace(/[^A-Za-z0-9._-]/g, '_');
    return safe && safe !== '.' && safe !== '..' && safe === id ? safe : `session-${createHash('sha256').update(id).digest('hex')}`;
  };
  function removeAttachments(id) {
    if (!attachmentsRoot) return;
    try { rmSync(join(attachmentsRoot, attachmentName(id)), { recursive: true, force: true }); } catch { /* next prune retries */ }
  }
  function pruneAttachments() {
    if (!attachmentsRoot) return;
    const keep = new Set();
    for (const state of live) for (const id of state.sessionIds()) keep.add(attachmentName(id));
    try {
      for (const item of readdirSync(attachmentsRoot, { withFileTypes: true })) {
        if (!item.isDirectory() || keep.has(item.name)) continue;
        const dir = join(attachmentsRoot, item.name);
        if (Date.now() - lstatSync(dir).mtimeMs > 7 * 86400000) rmSync(dir, { recursive: true, force: true });
      }
    } catch { /* a missing or busy attachments folder is retried on the next save */ }
  }
  pruneAttachments();

  function handleSocket(ws) {
    let closed = false;
    let wanted = clientSwitches(null);  // the page's switches: what the next agent is offered
    let restarts = Promise.resolve();
    const agents = new Map();        // homeKey ('' default, realHome for run tabs) -> { key, home, conn, starting, init, offered }
    const slotOf = (home = null) => {
      const key = home || '';
      let slot = agents.get(key);
      if (!slot) {
        slot = { key, home: home || null, conn: null, starting: null, init: null, offered: null };
        agents.set(key, slot);
      }
      return slot;
    };
    const defaultSlot = slotOf(null);
    const sessions = new Map();      // sessionId -> { cwd, home, tabId, turn: null | { id }, additionalDirectories }
    const permissions = new Map();   // requestId -> { sessionId, options, resolve, timer }
    const elicitations = new Map();  // requestId -> { sessionId, mode, elicitationId, resolve, timer, done }
    const completions = new Map();   // elicitationId -> { requestId, sessionId }: an accepted page, until it is done
    const subagents = new Map();     // child sessionId -> { parent, cwd }: what subagent_update said
    const send = (message) => {
      if (closed || ws.readyState !== 1) return;
      try { ws.send(JSON.stringify(message)); } catch { /* the close handler cleans up */ }
    };
    const clientHost = createClientHost({
      childEnv,
      // A command run for the agent is SynaBun's child, not the agent's: this says whose it is.
      terminalEnv: { SYNABUN_AGENT_TERMINAL: 'antigravity' },
      sessionCwd: (id) => sessionCwd(id),
      onOutput: (snapshot) => send({ type: 'terminal:output', ...snapshot }),
      log: (line) => log(`[antigravity] ${line}`),
    });
    let shutdownPromise = null;
    const state = {
      conn: () => defaultSlot.conn,
      sessionIds: () => sessions.keys(),
      homes: () => {
        const names = new Set();
        for (const slot of agents.values()) if (slot.home && (slot.conn?.running || slot.starting)) names.add(basename(slot.home));
        for (const session of sessions.values()) if (session.home) names.add(basename(session.home));
        return names;
      },
      // Turns that are running on this socket's agents (the desktop updater waits for them: GET /api/system/activity).
      turns: () => { let count = 0; for (const session of sessions.values()) if (session.turn) count += 1; return count; },
      shutdown: () => {
        if (shutdownPromise) return shutdownPromise;
        closed = true;
        live.delete(state);
        shutdownPromise = stopAgent().finally(() => stopping.delete(shutdownPromise));
        stopping.add(shutdownPromise);
        return shutdownPromise;
      },
    };
    live.add(state);

    function settlePermission(requestId, outcome) {
      const entry = permissions.get(requestId);
      if (!entry) return false;
      permissions.delete(requestId);
      clearTimeout(entry.timer);
      entry.resolve({ outcome });
      send({ type: 'permission:resolved', requestId, sessionId: entry.sessionId, outcome });
      return true;
    }
    function cancelPermissions(sessionId = null) {
      for (const [requestId, entry] of [...permissions]) {
        if (sessionId === null || entry.sessionId === sessionId) settlePermission(requestId, { outcome: 'cancelled' });
      }
    }

    // `shown`: what the page is told, when it differs from what the agent is answered.
    function settleElicitation(requestId, answer, shown = answer.action) {
      const entry = elicitations.get(requestId);
      if (!entry) return false;
      elicitations.delete(requestId);
      clearTimeout(entry.timer);
      entry.done?.();
      if (answer.action === 'accept' && entry.mode === 'url' && entry.elicitationId) {
        completions.delete(entry.elicitationId);
        completions.set(entry.elicitationId, { requestId, sessionId: entry.sessionId });
        if (completions.size > 64) completions.delete(completions.keys().next().value);
      }
      entry.resolve(answer);
      send({ type: 'elicitation:resolved', requestId, sessionId: entry.sessionId, action: shown });
      return true;
    }
    function cancelElicitations(sessionId = null) {
      for (const [requestId, entry] of [...elicitations]) {
        if (sessionId === null || entry.sessionId === sessionId) settleElicitation(requestId, { action: 'cancel' });
      }
      for (const [elicitationId, entry] of [...completions]) {
        if (sessionId === null || entry.sessionId === sessionId) completions.delete(elicitationId);
      }
    }
    function askElicitation(params, { signal } = {}) {
      if (signal?.aborted) return { action: 'cancel' };
      const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : null;
      const mode = typeof params?.mode === 'string' ? params.mode.slice(0, 100) : '';
      const url = mode === 'url' ? safeElicitationUrl(params?.url) : null;
      // A page that is not https (or http on this computer) is never put in front of the owner.
      if (mode === 'url' && !url) return { action: 'decline' };
      const elicitationId = typeof params?.elicitationId === 'string' && params.elicitationId ? params.elicitationId.slice(0, 500) : null;
      return new Promise((resolve) => {
        const requestId = randomBytes(8).toString('hex');
        const timer = setTimeout(() => settleElicitation(requestId, { action: 'cancel' }), limits.elicitationTimeoutMs);
        timer.unref?.();
        const onAbort = () => settleElicitation(requestId, { action: 'cancel' });
        signal?.addEventListener?.('abort', onAbort, { once: true });
        elicitations.set(requestId, { sessionId, mode, elicitationId, resolve, timer, done: () => signal?.removeEventListener?.('abort', onAbort) });
        send({
          type: 'elicitation:request',
          requestId,
          sessionId,
          toolCallId: typeof params?.toolCallId === 'string' ? params.toolCallId : null,
          message: typeof params?.message === 'string' ? params.message.slice(0, limits.maxElicitationMessage) : '',
          mode,
          ...(params?.requestedSchema && typeof params.requestedSchema === 'object' ? { requestedSchema: params.requestedSchema } : {}),
          ...(url ? { url } : {}),
          ...(elicitationId ? { elicitationId } : {}),
        });
      });
    }
    // elicitation/complete: the page the owner was sent to is done. A question still open is
    // dismissed (the agent is answered `cancel`: nobody chose here); the page hears 'complete'.
    function completeElicitation(params) {
      const elicitationId = typeof params?.elicitationId === 'string' ? params.elicitationId : '';
      if (!elicitationId) return;
      for (const [requestId, entry] of elicitations) {
        if (entry.elicitationId === elicitationId) { settleElicitation(requestId, { action: 'cancel' }, 'complete'); return; }
      }
      const accepted = completions.get(elicitationId);
      if (!accepted) return;
      completions.delete(elicitationId);
      send({ type: 'elicitation:resolved', requestId: accepted.requestId, sessionId: accepted.sessionId, action: 'complete' });
    }

    // A subagent session the agent exposed (subagent_update): where its commands run by default.
    function noteSubagent(parentId, update) {
      if (update?.sessionUpdate !== 'subagent_update') return;
      const id = update.sessionId;
      if (typeof id !== 'string' || !id || id.length > 500 || id === parentId) return;
      const known = subagents.get(id);
      subagents.delete(id);
      subagents.set(id, { parent: parentId, cwd: typeof update.cwd === 'string' && isAbsolute(update.cwd) ? update.cwd : known?.cwd || null });
      if (subagents.size > 256) subagents.delete(subagents.keys().next().value);
    }
    // Bypass is the tab's: a subagent's session follows the session that started it.
    function sessionBypass(id) {
      let at = id;
      for (let depth = 0; depth < 8 && at; depth++) {
        const own = sessions.get(at);
        if (own) return own.bypass === true;
        const child = subagents.get(at);
        if (!child) return false;
        at = child.parent;
      }
      return false;
    }
    // Bypass answers an open request itself (lib/antigravity/bypass.js): allow once, unless a hard rail refuses it.
    // False when it cannot (no allow-once option): the owner's card decides.
    function autoAnswer(requestId) {
      const entry = permissions.get(requestId);
      if (!entry) return false;
      const rail = bypassRail(entry.toolCall, { cwd: sessionCwd(entry.sessionId), roots: safeRoots() });
      const base = { type: 'permission:auto', requestId, sessionId: entry.sessionId, toolCall: entry.toolCall };
      if (rail) {
        const reject = rejectOnceOption(entry.options);
        send({ ...base, decision: 'refused', rule: rail.rule, reason: rail.reason });
        settlePermission(requestId, reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' });
        log(`[antigravity] bypass refused (${rail.rule}): ${rail.reason.slice(0, 200)}`);
        return true;
      }
      const allow = allowOnceOption(entry.options);
      if (!allow) return false;
      send({ ...base, decision: 'allowed', optionId: allow.optionId });
      settlePermission(requestId, { outcome: 'selected', optionId: allow.optionId });
      return true;
    }
    function safeRoots() {
      try { const roots = policyRoots(); return Array.isArray(roots) ? roots : []; } catch { return []; }
    }

    function sessionCwd(id) {
      let at = id;
      for (let depth = 0; depth < 8 && at; depth++) {
        const own = sessions.get(at);
        if (own) return own.cwd;
        const child = subagents.get(at);
        if (!child) return null;
        if (child.cwd) return child.cwd;
        at = child.parent;
      }
      return null;
    }
    // What a closed or deleted session leaves: its open questions and its terminals, and its subagents'.
    function endSession(id) {
      const ids = [id];
      for (let i = 0; i < ids.length && ids.length < 300; i++) {
        for (const [child, info] of subagents) if (info.parent === ids[i] && !ids.includes(child)) ids.push(child);
      }
      for (const each of ids) {
        cancelPermissions(each);
        cancelElicitations(each);
        clientHost.releaseSession(each);
        removeAttachments(each);
        subagents.delete(each);
      }
    }

    async function ensureSlot(home = null) {
      if (closed) throw new Error('The Antigravity panel closed.');
      const slot = slotOf(home);
      if (slot.conn?.running && slot.init) return slot;
      if (slot.starting) return slot.starting;
      slot.starting = (async () => {
        if (slot.home && typeof isRunHomeActive === 'function' && isRunHomeActive(slot.home)) {
          throw Object.assign(new Error('This dispatched run is still running in this folder.'), { code: 'HOME_BUSY' });
        }
        const launch = await resolveLaunch();
        if (closed) throw new Error('The Antigravity panel closed.');
        if (!launch?.command) throw Object.assign(new Error('The Antigravity CLI (agy) is not installed.'), { code: 'CLI_MISSING' });
        if (slot.home) assertSafeAntigravityProject(launch.cwd || process.cwd());
        if (slot.home) {
          // Launch resolution is async: a worker may have acquired this home while we waited.
          if (typeof isRunHomeActive === 'function' && isRunHomeActive(slot.home)) throw Object.assign(new Error('This dispatched run is still running in this folder.'), { code: 'HOME_BUSY' });
          // The worker run's PreToolUse hook checked its per-run policy token, which ended with the run;
          // once the panel takes over, permissions run through session/request_permission and Bypass like ordinary tabs.
          try { rmSync(join(slot.home, 'config', 'hooks.json'), { force: true }); } catch { /* already gone */ }
        }
        const switches = { ...wanted };
        const next = connect({
          command: launch.command,
          args: launch.args || [],
          ...(slot.home ? { acpArgs: ['--gemini-dir', slot.home] } : {}),
          cwd: launch.cwd || undefined,
          env: childEnv(),
          clientInfo,
          onLog: (line) => log(`[antigravity] ${line}`),
          onUpdate: (params) => {
            if (!params || typeof params.sessionId !== 'string') return;
            const session = sessions.get(params.sessionId);
            noteSubagent(params.sessionId, params.update);
            send({ type: 'session:update', sessionId: params.sessionId, update: params.update, replay: !!session?.replaying });
          },
          onPermission: (params) => new Promise((resolve) => {
            const requestId = randomBytes(8).toString('hex');
            const options = Array.isArray(params?.options) ? params.options.filter((o) => o && typeof o.optionId === 'string') : [];
            const timer = setTimeout(() => settlePermission(requestId, { outcome: 'cancelled' }), limits.permissionTimeoutMs);
            timer.unref?.();
            permissions.set(requestId, { sessionId: params?.sessionId, options, toolCall: params?.toolCall || null, resolve, timer });
            if (sessionBypass(params?.sessionId) && autoAnswer(requestId)) return;
            send({ type: 'permission:request', requestId, sessionId: params?.sessionId, toolCall: params?.toolCall || null, options });
          }),
          onElicitation: (params, context) => (slot.conn === next ? askElicitation(params, context) : { action: 'cancel' }),
          // Only what this agent was offered, and nothing for an agent that is being replaced.
          onClientRequest: (method, params, context) => clientHost.handle(method, params, { signal: context?.signal, allow: slot.conn === next ? switches : {} }),
          onNotification: (method, params) => {
            if (method === 'elicitation/complete' && slot.conn === next) completeElicitation(params);
          },
          onExit: (info) => {
            if (slot.conn !== next) return;
            if (slot.home === null) {
              for (const [requestId, entry] of [...permissions]) if (!entry.sessionId) settlePermission(requestId, { outcome: 'cancelled' });
              for (const [requestId, entry] of [...elicitations]) if (!entry.sessionId) settleElicitation(requestId, { action: 'cancel' });
            }
            for (const [id, session] of [...sessions.entries()]) {
              if ((session.home || null) !== slot.home) continue;
              endSession(id);
              session.turn = null;
            }
            slot.init = null;
            slot.offered = null;
            send({
              type: 'agent:exit',
              code: info.code,
              signal: info.signal,
              error: info.error || null,
              stderr: info.stderr ? info.stderr.slice(-2000) : '',
              ...(slot.home ? { geminiDir: slot.home } : {}),
            });
          },
        });
        slot.conn = next;
        try {
          slot.init = await next.initialize({ clientCapabilities: acpClientCapabilities(switches) });
          slot.offered = switches;
        } catch (error) {
          next.close();
          if (slot.conn === next) slot.conn = null;
          // The exit (and its stderr) is known at once for a process that is gone; a live one gets a moment.
          const exit = await Promise.race([next.exited, new Promise((resolve) => { setTimeout(resolve, 1000).unref?.(); })]);
          throw agentStartError(error, exit);
        }
        return slot;
      })();
      try { return await slot.starting; } finally { slot.starting = null; }
    }
    async function ensureAgent(home = null) {
      return (await ensureSlot(home)).conn;
    }

    // agent:restart: the running agents end (what they asked is cancelled, their terminals killed, their sessions
    // forgotten: the page opens them again) without an agent:exit; the next ensureAgent() starts a new one.
    async function stopAgent() {
      // Closing an initializing connection rejects initialize; waiting for initialize first would deadlock.
      const closing = [...agents.values()].map((slot) => slot.conn?.close()).filter(Boolean);
      let startTimer;
      try {
        await Promise.race([Promise.allSettled([...agents.values()].map((slot) => slot.starting).filter(Boolean)), new Promise((resolve) => { startTimer = setTimeout(resolve, 5000); })]);
      } finally { clearTimeout(startTimer); }
      const running = [];
      for (const slot of agents.values()) {
        if (slot.conn) running.push(slot.conn);
        slot.conn = null;
        slot.init = null;
        slot.offered = null;
      }
      agents.clear();
      agents.set('', defaultSlot);
      cancelPermissions();
      cancelElicitations();
      clientHost.releaseAll();
      sessions.clear();
      subagents.clear();
      let closeTimer;
      try {
        await Promise.race([Promise.allSettled([...closing, ...running.map((agent) => agent.close())]), new Promise((resolve) => { closeTimer = setTimeout(resolve, 5000); })]);
      } finally { clearTimeout(closeTimer); }
    }

    function sessionId(msg) {
      const id = typeof msg?.sessionId === 'string' ? msg.sessionId : '';
      if (!ID_RE.test(id)) throw Object.assign(new Error('Unknown session.'), { code: 'SESSION_INVALID' });
      return id;
    }

    function agentView(slot = defaultSlot) {
      return agentCapabilitiesView(slot?.init?.agentCapabilities);
    }
    function requireSessionCapability(key, what, slot = defaultSlot) {
      if (!agentView(slot).sessionCapabilities[key]) throw Object.assign(new Error(`This version of Antigravity cannot ${what}.`), { code: 'UNSUPPORTED' });
    }

    // The other folders of a session (ACP additionalDirectories): only for an agent that takes them,
    // each an existing absolute folder by its real path, the session's own folder and repeats left out.
    function additionalDirectoriesOf(value, cwd, slot = defaultSlot) {
      if (!agentView(slot).sessionCapabilities.additionalDirectories || value === undefined || value === null) return [];
      const refuse = (message) => Object.assign(new Error(message), { code: 'ADDITIONAL_DIRECTORIES_INVALID' });
      if (!Array.isArray(value)) throw refuse('Other folders must be a list of folders.');
      if (value.length > limits.maxAdditionalDirectories) throw refuse(`At most ${limits.maxAdditionalDirectories} other folders per session.`);
      const list = [];
      for (const entry of value) {
        if (typeof entry !== 'string' || !entry || !isAbsolute(entry)) throw refuse(`Another folder must be an absolute path: ${String(entry).slice(0, 200)}`);
        let real;
        try { real = validateCwd(entry); } catch (error) { throw refuse(error?.message || `${entry} is not a folder.`); }
        if (real === cwd || list.includes(real)) continue;
        list.push(real);
      }
      return list;
    }
    const directoriesParam = (list) => (list.length ? { additionalDirectories: list } : {});

    function helloAnswer() {
      const init = defaultSlot.init;
      return {
        capabilities: [...ANTIGRAVITY_PANEL_CAPABILITIES],
        agent: init?.agentInfo || null,
        authMethods: authMethodsView(init?.authMethods),
        promptCapabilities: init?.agentCapabilities?.promptCapabilities || {},
        sessionCapabilities: init?.agentCapabilities?.sessionCapabilities || init?.agentCapabilities?.session_capabilities || {},
        loadSession: !!init?.agentCapabilities?.loadSession,
        agentCapabilities: agentView(defaultSlot),
        // What the running agent was offered; with none running, what the next one will be.
        clientCapabilities: { ...(defaultSlot.conn?.running && defaultSlot.offered ? defaultSlot.offered : wanted) },
        limits: { maxAttachments: limits.maxAttachments, maxAttachmentBytes: limits.maxAttachmentBytes, maxPaths: limits.maxPaths, maxAdditionalDirectories: limits.maxAdditionalDirectories },
      };
    }
    async function agentStatus() {
      try {
        await ensureAgent();
        return { ...helloAnswer(), running: true };
      } catch (error) {
        const info = acpErrorInfo(error);
        if (error?.stderr) info.stderr = String(error.stderr).slice(-2000);
        return { ...helloAnswer(), running: false, error: info, cliMissing: error?.code === 'CLI_MISSING', acpUnsupported: error?.code === 'ACP_UNSUPPORTED' };
      }
    }

    function saveAttachmentFor(id) {
      return (name, buffer) => {
        if (!attachmentsRoot) throw Object.assign(new Error('Attachments are not available.'), { code: 'ATTACHMENT_UNAVAILABLE' });
        pruneAttachments();
        const dir = join(attachmentsRoot, attachmentName(id));
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const file = join(dir, `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}-${name}`);
        writeFileSync(file, buffer, { mode: 0o600, flag: 'wx' });
        return file;
      };
    }

    const handlers = {
      async hello(msg) {
        if (Object.hasOwn(msg, 'clientCapabilities')) wanted = clientSwitches(msg.clientCapabilities);
        return agentStatus();
      },
      'agent:restart'(msg) {
        const run = restarts.then(async () => {
          if ([...sessions.values()].some((session) => session.turn)) throw Object.assign(new Error('A turn is running. Stop it before Antigravity restarts.'), { code: 'TURN_RUNNING' });
          if (Object.hasOwn(msg, 'clientCapabilities')) wanted = clientSwitches(msg.clientCapabilities);
          await stopAgent();
          return agentStatus();
        });
        restarts = run.catch(() => {});
        return run;
      },
      async 'session:new'(msg) {
        // Ordinary tabs always open in the user's default ~/.gemini store; a geminiDir sent here is refused unless empty.
        if (msg.geminiDir !== undefined && msg.geminiDir !== null && msg.geminiDir !== '') {
          throw Object.assign(new Error('New conversations open in the default Antigravity store.'), { code: 'HOME_INVALID' });
        }
        const cwd = validateCwd(msg.cwd);
        const slot = await ensureSlot(null);
        const directories = additionalDirectoriesOf(msg.additionalDirectories, cwd, slot);
        const answer = await slot.conn.request('session/new', { cwd, mcpServers: [], ...directoriesParam(directories) });
        sessions.set(answer.sessionId, { cwd, home: null, tabId: msg.tabId || null, bypass: msg.bypass === true, turn: null, additionalDirectories: directories });
        try { onSessionActivity?.({ kind: 'new', sessionId: answer.sessionId, cwd }); } catch { /* informational */ }
        // `models`: the older ACP model state ({ currentModelId, availableModels }) `agy acp` also answers with.
        return { sessionId: answer.sessionId, cwd, modes: answer.modes || null, models: answer.models || null, configOptions: answer.configOptions || [], additionalDirectories: directories };
      },
      async 'session:load'(msg) {
        const id = sessionId(msg);
        const cwd = validateCwd(msg.cwd);
        const home = validateRunHome(msg.geminiDir, homesRoot);
        if (home) assertSafeAntigravityProject(cwd);
        const slot = await ensureSlot(home);
        const directories = additionalDirectoriesOf(msg.additionalDirectories, cwd, slot);
        const entry = { cwd, home, tabId: msg.tabId || null, bypass: msg.bypass === true, turn: null, replaying: true, additionalDirectories: directories };
        sessions.set(id, entry);
        try {
          const answer = await slot.conn.request('session/load', { sessionId: id, cwd, mcpServers: [], ...directoriesParam(directories) });
          return { sessionId: id, cwd, modes: answer?.modes || null, models: answer?.models || null, configOptions: answer?.configOptions || [], additionalDirectories: directories };
        } catch (error) {
          sessions.delete(id);
          throw error;
        } finally {
          entry.replaying = false;
        }
      },
      // session/resume: the conversation goes on in this process without its history being replayed.
      async 'session:resume'(msg) {
        const id = sessionId(msg);
        const cwd = validateCwd(msg.cwd);
        const home = validateRunHome(msg.geminiDir ?? sessions.get(id)?.home ?? null, homesRoot);
        if (home) assertSafeAntigravityProject(cwd);
        const slot = await ensureSlot(home);
        requireSessionCapability('resume', 'resume a conversation', slot);
        if (sessions.get(id)?.turn) throw Object.assign(new Error('A turn is already running in this session.'), { code: 'TURN_RUNNING' });
        const directories = additionalDirectoriesOf(msg.additionalDirectories, cwd, slot);
        const answer = await slot.conn.request('session/resume', { sessionId: id, cwd, mcpServers: [], ...directoriesParam(directories) });
        sessions.set(id, { cwd, home, tabId: msg.tabId || null, bypass: msg.bypass === true, turn: null, additionalDirectories: directories });
        return { sessionId: id, cwd, modes: answer?.modes || null, models: answer?.models || null, configOptions: answer?.configOptions || [], additionalDirectories: directories };
      },
      // session/fork: a new session that starts from this one's context; the original is left as it is.
      async 'session:fork'(msg) {
        const id = sessionId(msg);
        const cwd = validateCwd(msg.cwd);
        const home = validateRunHome(msg.geminiDir ?? sessions.get(id)?.home ?? null, homesRoot);
        if (home) assertSafeAntigravityProject(cwd);
        const slot = await ensureSlot(home);
        requireSessionCapability('fork', 'fork a conversation', slot);
        const directories = additionalDirectoriesOf(msg.additionalDirectories, cwd, slot);
        const answer = await slot.conn.request('session/fork', { sessionId: id, cwd, mcpServers: [], ...directoriesParam(directories) });
        const forked = typeof answer?.sessionId === 'string' && answer.sessionId ? answer.sessionId : '';
        if (!forked) throw Object.assign(new Error('Antigravity did not name the new conversation.'), { code: 'FORK_FAILED' });
        sessions.set(forked, { cwd, home, tabId: msg.tabId || null, bypass: msg.bypass === true, turn: null, additionalDirectories: directories });
        try { onSessionActivity?.({ kind: 'new', sessionId: forked, cwd }); } catch { /* informational */ }
        return { sessionId: forked, cwd, modes: answer?.modes || null, models: answer?.models || null, configOptions: answer?.configOptions || [], additionalDirectories: directories };
      },
      // session/delete: gone from the agent's list too. What it asked is cancelled and its terminals killed first.
      async 'session:delete'(msg) {
        const id = sessionId(msg);
        const home = validateRunHome(msg.geminiDir ?? sessions.get(id)?.home ?? null, homesRoot);
        const slot = await ensureSlot(home);
        requireSessionCapability('delete', 'delete a conversation', slot);
        const running = !!sessions.get(id)?.turn;
        endSession(id);
        sessions.delete(id);
        if (running) await slot.conn.notify('session/cancel', { sessionId: id }).catch(() => {});
        await slot.conn.request('session/delete', { sessionId: id }, { timeoutMs: 30_000 });
        return { deleted: true };
      },
      async 'session:list'(msg) {
        const agent = await ensureAgent();
        const params = {};
        if (typeof msg.cwd === 'string' && msg.cwd) params.cwd = validateCwd(msg.cwd);
        if (typeof msg.cursor === 'string' && msg.cursor) params.cursor = msg.cursor;
        const answer = await agent.request('session/list', params);
        return { sessions: Array.isArray(answer?.sessions) ? answer.sessions : [], nextCursor: answer?.nextCursor || null };
      },
      async 'session:close'(msg) {
        const id = sessionId(msg);
        const session = sessions.get(id);
        endSession(id);
        sessions.delete(id);
        const conn = agents.get(session?.home || '')?.conn;
        if (!conn?.running) return { closed: true };
        try { await conn.request('session/close', { sessionId: id }, { timeoutMs: 10_000 }); } catch { /* closing is best effort */ }
        return { closed: true };
      },
      async prompt(msg) {
        const id = sessionId(msg);
        const session = sessions.get(id);
        if (!session) throw Object.assign(new Error('This session is not open. Reload it first.'), { code: 'SESSION_NOT_OPEN' });
        if (session.turn) throw Object.assign(new Error('A turn is already running in this session.'), { code: 'TURN_RUNNING' });
        // The turn is claimed before anything is awaited: two prompts that arrive together must not both reach
        // agy, which folds a second prompt into the running turn (both echoed, one reply).
        const turn = { id: randomBytes(6).toString('hex') };
        session.turn = turn;
        let agent;
        let blocks;
        const typed = typeof msg.text === 'string' ? msg.text : '';
        try {
          const slot = await ensureSlot(session.home || null);
          agent = slot.conn;
          let text = typed;
          if (typeof expandPrompt === 'function') { try { text = String(expandPrompt(typed) ?? typed); } catch { text = typed; } }
          blocks = buildPromptBlocks({ ...msg, text }, { promptCapabilities: slot.init?.agentCapabilities?.promptCapabilities || {}, saveAttachment: saveAttachmentFor(id), limits });
        } catch (error) {
          if (session.turn === turn) session.turn = null;
          throw error;
        }
        try { onHumanPrompt?.({ cwd: session.cwd, words: typed }); } catch { /* informational */ }
        // The greeting is told once, with the prompt that carries its id; a slash command gets none (its own flow
        // comes first), and the greeting is not owed to it later either.
        if (typeof msg.greetingId === 'string' && msg.greetingId && typeof greetingNote === 'function') {
          let note = '';
          try { note = greetingNoteBlock(greetingNote(msg.greetingId, { skip: /^\s*\//.test(typed) })); } catch { note = ''; }
          if (note) blocks = [{ type: 'text', text: note }, ...blocks];
        }
        try { onSessionActivity?.({ kind: 'prompt', sessionId: id, cwd: session.cwd }); } catch { /* informational */ }
        try {
          const answer = await agent.request('session/prompt', { sessionId: id, prompt: blocks }, { timeoutMs: 0 });
          const result = { stopReason: answer?.stopReason || 'end_turn', usage: answer?.usage || null };
          send({ type: 'turn:end', sessionId: id, turnId: turn.id, ...result });
          return { turnId: turn.id, ...result };
        } catch (error) {
          send({ type: 'turn:end', sessionId: id, turnId: turn.id, stopReason: 'error', error: acpErrorInfo(error) });
          throw error;
        } finally {
          if (session.turn === turn) session.turn = null;
          cancelPermissions(id);
          cancelElicitations(id);
          try { onTurnEnd?.({ sessionId: id, cwd: session.cwd }); } catch { /* informational */ }
        }
      },
      async cancel(msg) {
        const id = sessionId(msg);
        cancelPermissions(id);
        cancelElicitations(id);
        const conn = agents.get(sessions.get(id)?.home || '')?.conn;
        if (conn?.running) await conn.notify('session/cancel', { sessionId: id });
        return { cancelled: true };
      },
      async 'config:set'(msg) {
        const id = sessionId(msg);
        if (typeof msg.configId !== 'string' || !msg.configId) throw Object.assign(new Error('Unknown setting.'), { code: 'CONFIG_INVALID' });
        const value = typeof msg.value === 'boolean' ? msg.value : String(msg.value ?? '');
        const agent = await ensureAgent(sessions.get(id)?.home || null);
        const answer = await agent.request('session/set_config_option', { sessionId: id, configId: msg.configId, value });
        return { configOptions: answer?.configOptions || [] };
      },
      async 'mode:set'(msg) {
        const id = sessionId(msg);
        if (typeof msg.modeId !== 'string' || !msg.modeId) throw Object.assign(new Error('Unknown mode.'), { code: 'MODE_INVALID' });
        const agent = await ensureAgent(sessions.get(id)?.home || null);
        await agent.request('session/set_mode', { sessionId: id, modeId: msg.modeId });
        return { modeId: msg.modeId };
      },
      // For an agent whose model is not a config option: `agy acp` still answers session/set_model.
      async 'model:set'(msg) {
        const id = sessionId(msg);
        if (typeof msg.modelId !== 'string' || !msg.modelId) throw Object.assign(new Error('Unknown model.'), { code: 'MODEL_INVALID' });
        const agent = await ensureAgent(sessions.get(id)?.home || null);
        await agent.request('session/set_model', { sessionId: id, modelId: msg.modelId });
        return { modelId: msg.modelId };
      },
      // Bypass for one tab's session: on, every permission request is answered allow-once (and what is open now is);
      // the hard rails of lib/antigravity/bypass.js still refuse. Only the owner's socket gets here.
      async 'session:bypass'(msg) {
        const id = sessionId(msg);
        const entry = sessions.get(id);
        if (!entry) throw Object.assign(new Error('That conversation is not open.'), { code: 'SESSION_UNKNOWN' });
        if (typeof msg.on !== 'boolean') throw Object.assign(new Error('Bypass is on or off.'), { code: 'BYPASS_INVALID' });
        entry.bypass = msg.on;
        let answered = 0;
        if (msg.on) {
          for (const [requestId, open] of [...permissions]) {
            if (sessionBypass(open.sessionId) && autoAnswer(requestId)) answered++;
          }
        }
        return { sessionId: id, bypass: entry.bypass, answered };
      },
      async 'permission:answer'(msg) {
        const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
        const entry = permissions.get(requestId);
        if (!entry) return { answered: false, stale: true };
        if (msg.optionId === null || msg.optionId === undefined) return { answered: settlePermission(requestId, { outcome: 'cancelled' }) };
        if (!entry.options.some((option) => option.optionId === msg.optionId)) throw Object.assign(new Error('That answer was not one of the choices.'), { code: 'PERMISSION_OPTION_INVALID' });
        return { answered: settlePermission(requestId, { outcome: 'selected', optionId: msg.optionId }) };
      },
      async 'elicitation:answer'(msg) {
        const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
        if (!elicitations.has(requestId)) return { answered: false, stale: true };
        if (!ELICITATION_ACTIONS.has(msg.action)) throw Object.assign(new Error('An answer is accept, decline or cancel.'), { code: 'ELICITATION_ACTION_INVALID' });
        // Content goes with an accept only; a decline or a cancel says nothing more.
        const content = msg.action === 'accept' ? elicitationContent(msg.content, limits) : undefined;
        return { answered: settleElicitation(requestId, content === undefined ? { action: msg.action } : { action: msg.action, content }) };
      },
      async 'auth:start'(msg) {
        const slot = await ensureSlot(null);
        const method = (Array.isArray(slot.init?.authMethods) ? slot.init.authMethods : []).find((m) => m && m.id === msg.methodId);
        if (!method) throw Object.assign(new Error('Unknown sign-in method.'), { code: 'AUTH_METHOD_INVALID' });
        // ACP: a terminal sign-in runs `agy` in a terminal and is never sent to authenticate.
        if (method.type === 'terminal') throw Object.assign(new Error('This sign-in runs in a terminal: run `agy` there to sign in.'), { code: 'AUTH_METHOD_TERMINAL' });
        await slot.conn.request('authenticate', { methodId: msg.methodId }, { timeoutMs: limits.authTimeoutMs });
        return { signedIn: true };
      },
      async 'auth:logout'() {
        const slot = await ensureSlot(null);
        if (!agentView(slot).auth.logout) throw Object.assign(new Error('This version of Antigravity cannot sign out from here.'), { code: 'UNSUPPORTED' });
        await slot.conn.request('logout', {});
        return { signedIn: false };
      },
    };

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'ping') { send({ type: 'pong' }); return; }
      const handler = Object.hasOwn(handlers, msg.type) ? handlers[msg.type] : null;
      const reqId = typeof msg.reqId === 'string' || Number.isInteger(msg.reqId) ? msg.reqId : null;
      if (!handler) { send({ type: 'result', reqId, ok: false, error: { message: `Unknown request: ${msg.type}`, code: 'UNKNOWN_REQUEST' } }); return; }
      try {
        const data = await handler(msg);
        send({ type: 'result', reqId, ok: true, data });
      } catch (error) {
        const info = acpErrorInfo(error);
        if (typeof error?.code === 'string') info.code = error.code;
        send({ type: 'result', reqId, ok: false, error: info, authRequired: isAuthRequired(error) });
      }
    });

    ws.on('close', () => { void state.shutdown(); });
  }

  return {
    handleSocket,
    liveCount: () => live.size,
    /** Folder names of SynaBun run homes open in any panel socket (pruneAntigravityHomes leaves them alone). */
    activeHomes: () => { const names = new Set(); for (const state of live) for (const name of state.homes()) names.add(name); return names; },
    /** Prompts that are running in any panel socket (a restart would end them). */
    turnsRunning: () => { let count = 0; for (const state of live) count += state.turns(); return count; },
    closeAll: async () => {
      const closing = [...live].map((state) => state.shutdown());
      await Promise.allSettled([...closing, ...stopping]);
    },
  };
}
