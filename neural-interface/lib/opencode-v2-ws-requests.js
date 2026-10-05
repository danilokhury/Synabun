// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — sidepanel WebSocket requests as pure functions
//
// server.js owns the socket, the isolated serves and the native-run guards; a
// request body lives here as `(msg, deps) => reply` so node:test can drive it
// with a fake client. `handleOpencodeV2Request` returns false for a type it
// does not own, and the caller falls through to its own switch.
//
// deps (all supplied by handleOpencodeV2Ws):
//   send(data)                     write one JSON message to this socket
//   shared                         the shared-serve client (opencode-v2-client).
//                                  SDK calls added for the panel are under
//                                  `client.extra.<group>.<method>`
//   bound(sessionId)               the serve currently hosting the session's
//                                  turn, else the shared client; never spawns
//   turn(sessionId, mcpProfile)    the session's dedicated serve; may spawn it
//   proxy(method, path, body, timeoutMs, baseUrl)   raw HTTP to a serve
//   baseUrlFor(sessionId)          base URL of the serve hosting the session
//   directoryQuery(cwd)            `?directory=…` or ''
//   isTurnActive(sessionId)        true while a turn is running or starting
//   turnScope(sessionId)           the bookkeeping message:send does around a
//                                  turn: aborts the previous prompt of this
//                                  socket, marks the session active. Returns
//                                  { signal, end() }; end() must always run
//   persistMcp(name, config)       write one MCP server into the OpenCode
//                                  config file; starts nothing. Throws on failure
//
// The panel must work against a server that predates a request type, so the
// server says what it understands: `capabilities` in init:result and one
// `capabilities` message after identify. The panel shows a feature that needs
// a type only when that type is listed.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactOrSummarize, lastModelOf } from './opencode-v2-client.js';

export { lastModelOf };

// Types answered by the switch in server.js.
export const OPENCODE_V2_WS_INLINE_TYPES = Object.freeze([
  'init', 'identify',
  'session:list', 'session:create', 'session:get', 'session:update', 'session:delete', 'session:messages',
  'mcp:profile:get', 'mcp:profile:set',
  'message:send', 'message:abort',
  'question:list', 'question:reject',
]);

const failure = (status, error, extra = {}) => ({ ok: false, status, error, ...extra });

const sessionIdOf = (msg) => (typeof msg?.sessionId === 'string' ? msg.sessionId.trim() : '');
// The id every per-session resolver gets: the canonical one, or nothing.
const sessionKeyOf = (msg) => sessionIdOf(msg) || undefined;
const directoryOf = (msg) => (typeof msg?.cwd === 'string' && msg.cwd.trim() ? msg.cwd.trim() : undefined);

// ── One session id per request ──────────────────────────────────────────────
// The native-run and history guards in server.js look a session up by id, and
// so does every SDK call. They must look up the same string: an id that is
// trimmed for the SDK but not for the guard (" ses_x ") walks past the guard.
// So the id is made canonical once, in place, before anything reads it, and an
// id that is not a plain token is refused outright.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Canonicalise `msg.sessionId` in place. Returns null when the message may go
 * on, or the failure to answer with. An absent or empty id becomes `undefined`.
 * A `body` (session:create / session:update) loses any session id of its own:
 * the one that was checked is the only one a call may use.
 */
export function canonicalizeOpencodeV2Message(msg) {
  if (!msg || typeof msg !== 'object') return failure(400, 'malformed request');
  const raw = msg.sessionId;
  if (raw === undefined || raw === null) {
    msg.sessionId = undefined;
  } else if (typeof raw !== 'string') {
    return failure(400, 'sessionId must be a string');
  } else {
    const trimmed = raw.trim();
    if (!trimmed) msg.sessionId = undefined;
    else if (!SESSION_ID_RE.test(trimmed)) return failure(400, 'sessionId is not a valid session id');
    else msg.sessionId = trimmed;
  }
  if (msg.body && typeof msg.body === 'object' && !Array.isArray(msg.body)) {
    delete msg.body.sessionID;
    delete msg.body.sessionId;
  }
  return null;
}

/**
 * Everything that must hold before a request is answered, in one place so it
 * can be tested: a canonical session id, no write while history is being
 * cleared, and the native-automation ownership rules. Returns null to let the
 * request through, or `{ status, error }`.
 *   ctx: { historyClearing, historyWriteTypes, nativeMutationTypes,
 *          protectedRunFor(sessionId), ownsRun(run) }
 */
export function guardOpencodeV2Request(msg, ctx = {}) {
  const malformed = canonicalizeOpencodeV2Message(msg);
  if (malformed) return { status: malformed.status, error: malformed.error };
  const type = msg.type;
  if (ctx.historyClearing && ctx.historyWriteTypes?.has(type)) {
    return { status: 409, error: 'OpenCode history is being cleared' };
  }
  const protectedRun = msg.sessionId ? ctx.protectedRunFor?.(msg.sessionId) : null;
  if (protectedRun && !ctx.ownsRun?.(protectedRun)) {
    return { status: 409, error: 'Native automation session is owned by another window' };
  }
  if (protectedRun && ctx.nativeMutationTypes?.has(type)) {
    return { status: 409, error: 'Stop the native automation before modifying its session' };
  }
  return null;
}

// v2.session.context answers `{ data: [...] }` since 1.18; older serves sent the
// bare array.
export function contextRows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

// session.status answers a map of the sessions that are NOT idle on that serve.
export function statusForSession(map, sessionId) {
  const entry = map && typeof map === 'object' ? map[sessionId] : null;
  return entry && typeof entry.type === 'string' ? entry : { type: 'idle' };
}

function modelOf(value) {
  const providerID = typeof value?.providerID === 'string' ? value.providerID.trim() : '';
  const modelID = typeof value?.modelID === 'string' ? value.modelID.trim() : '';
  return providerID && modelID ? { providerID, modelID } : null;
}

// session.compact with the session.summarize fallback (see compactOrSummarize).
async function compactSession(msg, deps) {
  const client = await deps.turn(sessionKeyOf(msg), msg.mcpProfile);
  try {
    return await compactOrSummarize(client, {
      sessionID: sessionIdOf(msg), directory: directoryOf(msg), model: modelOf(msg.model),
    });
  } catch (err) {
    // "Pick a model first" is an answer for the user, not a server error.
    if (err?.status === 400) return failure(400, err.message);
    throw err;
  }
}

const PERMISSION_REPLIES = new Set(['once', 'always', 'reject']);

async function permissionReply(msg, deps) {
  const requestID = String(msg.permissionId || msg.requestId || '').trim();
  const reply = String(msg.response || '');
  if (!requestID) return failure(400, 'permission id is required');
  if (!PERMISSION_REPLIES.has(reply)) return failure(400, `unknown permission reply: ${reply || '(empty)'}`);
  // The rejection reason is shown to the model; only a rejection carries one.
  const message = reply === 'reject' && typeof msg.message === 'string' && msg.message.trim()
    ? msg.message.trim().slice(0, 2000)
    : undefined;
  const client = deps.bound(sessionKeyOf(msg));
  const directory = directoryOf(msg);
  try {
    const r = await client.permission.reply({ requestID, reply, message, directory });
    return { status: r.status, data: r.data };
  } catch (err) {
    // A request raised under the serve's default scope does not match a reply
    // sent with ?directory=. One retry without it; nothing else is a real route
    // (the old /respond and bare-id fallbacks answered with the web UI's HTML).
    if (err?.status !== 404 || !directory) throw err;
    const r = await client.permission.reply({ requestID, reply, message });
    return { status: r.status, data: r.data };
  }
}

async function questionReply(msg, deps) {
  const requestID = String(msg.requestId || msg.requestID || '').trim();
  if (!requestID) return failure(400, 'question request id is required');
  const body = { answers: Array.isArray(msg.answers) ? msg.answers : [] };
  const path = `/question/${encodeURIComponent(requestID)}/reply${deps.directoryQuery(msg.cwd)}`;
  const r = await deps.proxy('POST', path, body, 10000, deps.baseUrlFor(sessionKeyOf(msg)));
  // Any unknown route on `opencode serve` answers 200 with the web UI; a reply
  // that comes back as a document did not reach the question API.
  if (typeof r.data === 'string' && /^\s*<(?:!doctype|html)/i.test(r.data)) {
    return failure(502, 'OpenCode did not accept the question reply');
  }
  return { status: r.status, data: r.data };
}

async function permissionList(msg, deps) {
  const r = await deps.bound(sessionKeyOf(msg)).extra.permission.list({ directory: directoryOf(msg) });
  return { status: r.status, data: Array.isArray(r.data) ? r.data : [] };
}

// Rules OpenCode saved from "Always allow" (v2.permission.saved). They are
// stored per project, so the shared serve answers.
async function permissionSavedList(msg, deps) {
  const projectID = typeof msg.projectID === 'string' && msg.projectID.trim() ? msg.projectID.trim() : '';
  const query = projectID ? `?projectID=${encodeURIComponent(projectID)}` : '';
  const r = await deps.proxy('GET', `/api/permission/saved${query}`, null, 10000, deps.baseUrlFor(null));
  if (r.status >= 400) return failure(r.status, proxyErrorText(r.data, 'Could not list saved approvals'));
  const rows = Array.isArray(r.data?.data) ? r.data.data : (Array.isArray(r.data) ? r.data : []);
  return { status: r.status, data: rows };
}

async function permissionSavedRemove(msg, deps) {
  const id = String(msg.savedId || '').trim();
  if (!id) return failure(400, 'saved approval id is required');
  const r = await deps.proxy('DELETE', `/api/permission/saved/${encodeURIComponent(id)}`, null, 10000, deps.baseUrlFor(null));
  if (r.status >= 400) return failure(r.status, proxyErrorText(r.data, 'Could not remove the saved approval'));
  return { status: r.status, data: true };
}

// A raw proxy answer is the parsed body: `{ name, data: { message } }`,
// `{ _tag, message }` or text.
function proxyErrorText(body, fallback) {
  if (typeof body === 'string') return /^\s*</.test(body) ? fallback : (body.trim().slice(0, 500) || fallback);
  return body?.message || body?.data?.message || body?.error || fallback;
}

// The model's todo list for the session (the todowrite tool keeps it).
async function sessionTodo(msg, deps) {
  const r = await deps.bound(sessionKeyOf(msg)).extra.session.todo({ sessionID: sessionIdOf(msg), directory: directoryOf(msg) });
  return { status: r.status, data: Array.isArray(r.data) ? r.data : [] };
}

async function sessionStatus(msg, deps) {
  const r = await deps.bound(sessionKeyOf(msg)).extra.session.status({ directory: directoryOf(msg) });
  return { status: r.status, data: { status: statusForSession(r.data, sessionIdOf(msg)) } };
}

// What the relay forwards to panels. OpenCode 1.18 mirrors every bus event as
// a `sync` envelope ({ type: 'sync', syncEvent }); the panel acts on the bus
// event itself, so the mirror is dropped. Everything else passes.
export function shouldRelayOpencodeV2Message(data) {
  return !(data?.type === 'event' && data.eventType === 'sync');
}

// Body of `POST /mcp` for a server SynaBun describes as { command, args, env }
// or { url, headers }. OpenCode takes McpLocalConfig (`type: 'local'`, the
// command as one array, `environment`) or McpRemoteConfig; `type: 'stdio'` with
// a string command is answered 400.
export function buildOpencodeRuntimeMcpConfig(config = {}) {
  if (config.type === 'local' || config.type === 'remote') return { ...config };
  if (typeof config.url === 'string' && config.url) {
    return {
      type: 'remote',
      url: config.url,
      ...(config.headers && typeof config.headers === 'object' ? { headers: config.headers } : {}),
      enabled: config.enabled !== false,
    };
  }
  // Every word goes through as it is: an argument may be empty or carry
  // spaces on purpose, and what is registered must be what was typed.
  const head = Array.isArray(config.command) ? config.command : [config.command];
  const command = [...head, ...(Array.isArray(config.args) ? config.args : [])]
    .filter((part) => typeof part === 'string');
  const environment = config.environment || config.env;
  return {
    type: 'local',
    command,
    ...(environment && typeof environment === 'object' ? { environment } : {}),
    enabled: config.enabled !== false,
  };
}

// ── Session list (read straight from OpenCode's SQLite) ─────────────────────
// The SDK's session.list only answers for the serve's own project; the panel
// lists every project, so server.js reads the `session` table. The query and
// the row mapping live here so they can be tested against a real table.
export const SESSION_LIST_MAX = 500;

/**
 * options: { search, archived, roots, limit }
 *   archived  false (default) → live sessions; true → archived ones only
 *   roots     true → no sub-agent sessions (parent_id IS NULL)
 *   search    case-insensitive match on title, slug or directory
 * Un-archiving writes time_archived = 0, so "live" is NULL or 0.
 */
export function buildSessionListQuery(options = {}) {
  const where = [];
  const params = [];
  where.push(options.archived === true
    ? '(s.time_archived IS NOT NULL AND s.time_archived != 0)'
    : '(s.time_archived IS NULL OR s.time_archived = 0)');
  if (options.roots === true) where.push('s.parent_id IS NULL');
  const search = typeof options.search === 'string' ? options.search.trim().slice(0, 200) : '';
  if (search) {
    const like = `%${search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    where.push("(s.title LIKE ? ESCAPE '\\' OR s.slug LIKE ? ESCAPE '\\' OR s.directory LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }
  const requested = Number(options.limit);
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, SESSION_LIST_MAX) : null;
  const sql = `
    SELECT s.id, s.title, s.directory, s.slug, s.project_id, s.parent_id, s.share_url,
           s.time_created, s.time_updated, s.time_archived,
           (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS message_count
    FROM session s
    WHERE ${where.join(' AND ')}
    ORDER BY s.time_updated DESC${limit ? '\n    LIMIT ?' : ''}
  `;
  if (limit) params.push(limit);
  return { sql, params };
}

const epochMs = (value) => (value ? Math.floor(new Date(value).getTime()) || 0 : 0);

export function mapSessionListRow(row) {
  const out = {
    id: row.id,
    title: row.title || '',
    slug: row.slug || '',
    directory: row.directory || '',
    projectID: row.project_id || '',
    messageCount: row.message_count || 0,
    time: { created: epochMs(row.time_created), updated: epochMs(row.time_updated) },
  };
  if (row.parent_id) out.parentID = row.parent_id;
  if (row.share_url) out.share = { url: row.share_url };
  const archived = epochMs(row.time_archived);
  if (archived) out.time.archived = archived;
  return out;
}

// ── Session lifecycle (revert, fork, share, children, delete message) ───────

const messageIdOf = (msg) => (typeof msg?.messageID === 'string' && msg.messageID.trim()
  ? msg.messageID.trim()
  : (typeof msg?.messageId === 'string' ? msg.messageId.trim() : ''));

// Reverting or deleting under a running turn would pull the transcript out
// from under the model.
function refuseWhileRunning(msg, deps, what) {
  return deps.isTurnActive?.(sessionIdOf(msg))
    ? failure(409, `Stop the running turn before you ${what}.`)
    : null;
}

async function sessionRevert(msg, deps) {
  const busy = refuseWhileRunning(msg, deps, 'revert');
  if (busy) return busy;
  const messageID = messageIdOf(msg);
  if (!messageID) return failure(400, 'messageID is required');
  const partID = typeof msg.partID === 'string' && msg.partID.trim() ? msg.partID.trim() : undefined;
  const r = await deps.bound(sessionKeyOf(msg)).extra.session.revert({
    sessionID: sessionIdOf(msg), messageID, partID, directory: directoryOf(msg),
  });
  return { status: r.status, data: r.data };
}

async function sessionUnrevert(msg, deps) {
  const busy = refuseWhileRunning(msg, deps, 'restore');
  if (busy) return busy;
  const r = await deps.bound(sessionKeyOf(msg)).extra.session.unrevert({ sessionID: sessionIdOf(msg), directory: directoryOf(msg) });
  return { status: r.status, data: r.data };
}

async function sessionFork(msg, deps) {
  const r = await deps.shared.extra.session.fork({
    sessionID: sessionIdOf(msg), messageID: messageIdOf(msg) || undefined, directory: directoryOf(msg),
  });
  return { status: r.status, data: r.data };
}

async function sessionChildren(msg, deps) {
  const r = await deps.shared.extra.session.children({ sessionID: sessionIdOf(msg), directory: directoryOf(msg) });
  return { status: r.status, data: Array.isArray(r.data) ? r.data : [] };
}

async function messageDelete(msg, deps) {
  const busy = refuseWhileRunning(msg, deps, 'delete a message');
  if (busy) return busy;
  const messageID = messageIdOf(msg);
  if (!messageID) return failure(400, 'messageID is required');
  const r = await deps.bound(sessionKeyOf(msg)).extra.session.deleteMessage({
    sessionID: sessionIdOf(msg), messageID, directory: directoryOf(msg),
  });
  return { status: r.status, data: r.data };
}

// OpenCode's `share` setting: manual (default), auto, or disabled.
export function sharePolicyOf(config) {
  const value = config?.share;
  if (value === 'disabled' || value === 'auto' || value === 'manual') return value;
  return 'manual';
}

async function readSharePolicy(msg, deps) {
  const r = await deps.shared.extra.config.get({ directory: directoryOf(msg) });
  return sharePolicyOf(r.data);
}

async function sessionSharePolicy(msg, deps) {
  return { status: 200, data: { share: await readSharePolicy(msg, deps) } };
}

// Publishes the transcript at a public opencode URL. The panel confirms with
// the user every time; the server refuses when the config forbids sharing.
async function sessionShare(msg, deps) {
  if (await readSharePolicy(msg, deps) === 'disabled') {
    return failure(403, 'Sharing is disabled in the OpenCode config.');
  }
  const r = await deps.shared.extra.session.share({ sessionID: sessionIdOf(msg), directory: directoryOf(msg) });
  return { status: r.status, data: r.data };
}

async function sessionUnshare(msg, deps) {
  const r = await deps.shared.extra.session.unshare({ sessionID: sessionIdOf(msg), directory: directoryOf(msg) });
  return { status: r.status, data: r.data };
}

// ── Composer: slash commands, shell, file search ────────────────────────────

/** What the slash menu needs of a Command; the template can be 16 KB and is not sent. */
export function commandRow(cmd) {
  if (!cmd || typeof cmd.name !== 'string' || !cmd.name) return null;
  const out = { name: cmd.name, description: typeof cmd.description === 'string' ? cmd.description : '' };
  out.source = ['command', 'mcp', 'skill'].includes(cmd.source) ? cmd.source : 'command';
  if (typeof cmd.agent === 'string' && cmd.agent) out.agent = cmd.agent;
  if (cmd.subtask === true) out.subtask = true;
  if (Array.isArray(cmd.hints) && cmd.hints.length) out.hints = cmd.hints.filter((h) => typeof h === 'string').slice(0, 8);
  return out;
}

// Commands depend on the project (.opencode/command, project skills), so the
// list is asked for the session's directory.
async function commandList(msg, deps) {
  const r = await deps.shared.extra.command.list({ directory: directoryOf(msg) });
  return { status: r.status, data: (Array.isArray(r.data) ? r.data : []).map(commandRow).filter(Boolean) };
}

// A model string for session.command / session.shell: `provider/model`.
function modelRef(value) {
  const model = modelOf(value);
  return model ? `${model.providerID}/${model.modelID}` : undefined;
}

// Run something that occupies the session like a prompt does: on the
// session's dedicated serve, inside the same turn bookkeeping as message:send.
async function withTurn(msg, deps, run) {
  const scope = deps.turnScope(sessionIdOf(msg));
  try {
    const client = await deps.turn(sessionKeyOf(msg), msg.mcpProfile);
    const r = await run(client, scope.signal ? { signal: scope.signal } : undefined);
    return { status: r.status, data: r.data };
  } finally {
    scope.end();
  }
}

// session.command: run a slash command (a command file, a skill, an MCP prompt).
async function commandRun(msg, deps) {
  const command = typeof msg.command === 'string' ? msg.command.trim().replace(/^\//, '') : '';
  if (!command) return failure(400, 'command is required');
  const parts = Array.isArray(msg.parts) && msg.parts.length ? msg.parts : undefined;
  return withTurn(msg, deps, (client, options) => client.extra.session.command({
    sessionID: sessionIdOf(msg),
    command,
    arguments: typeof msg.arguments === 'string' ? msg.arguments : '',
    agent: typeof msg.agent === 'string' && msg.agent ? msg.agent : undefined,
    model: modelRef(msg.model),
    variant: typeof msg.variant === 'string' && msg.variant ? msg.variant : undefined,
    parts,
    directory: directoryOf(msg),
  }, options));
}

// session.shell: run one shell command in the session, with no model call.
// The panel sends this only from its shell mode, which nothing but the user
// typing "!" into an empty composer can enter.
async function sessionShell(msg, deps) {
  const command = typeof msg.command === 'string' ? msg.command.trim() : '';
  if (!command) return failure(400, 'command is required');
  if (command.length > 20000) return failure(400, 'command is too long');
  return withTurn(msg, deps, (client, options) => client.extra.session.shell({
    sessionID: sessionIdOf(msg),
    command,
    agent: typeof msg.agent === 'string' && msg.agent ? msg.agent : 'build',
    model: modelOf(msg.model) || undefined,
    directory: directoryOf(msg),
  }, options));
}

export const FIND_FILES_LIMIT = 50;

// find.files: fuzzy file (and directory) search for @ mentions.
async function findFiles(msg, deps) {
  const query = typeof msg.query === 'string' ? msg.query.trim().slice(0, 200) : '';
  const r = await deps.shared.extra.find.files({
    query,
    dirs: msg.dirs === false ? 'false' : 'true',
    limit: FIND_FILES_LIMIT,
    directory: directoryOf(msg),
  });
  const rows = (Array.isArray(r.data) ? r.data : []).filter((p) => typeof p === 'string' && p);
  return { status: r.status, data: rows.slice(0, FIND_FILES_LIMIT) };
}

// A file:// URI as a filesystem path; anything else is not a project file.
function pathOfFileUri(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return '';
  try { return decodeURIComponent(new URL(uri).pathname); } catch { return ''; }
}

/** A workspace symbol as the @ picker takes it: `{ name, kind, path, range }`. */
export function symbolRow(symbol) {
  const name = typeof symbol?.name === 'string' ? symbol.name.trim() : '';
  const path = pathOfFileUri(symbol?.location?.uri);
  if (!name || !path) return null;
  const point = (p) => ({ line: Number(p?.line) || 0, character: Number(p?.character) || 0 });
  const range = symbol.location.range || {};
  return {
    name: name.slice(0, 200),
    kind: Number(symbol.kind) || 0,
    path,
    range: { start: point(range.start), end: point(range.end) },
  };
}

// find.symbols: workspace symbols from the language servers of the serve that
// runs this session (they start when the session reads a file of that language).
async function findSymbols(msg, deps) {
  const query = typeof msg.query === 'string' ? msg.query.trim().slice(0, 200) : '';
  if (!query) return { status: 200, data: [] };
  const r = await deps.bound(sessionKeyOf(msg)).extra.find.symbols({ query, directory: directoryOf(msg) });
  const rows = (Array.isArray(r.data) ? r.data : []).map(symbolRow).filter(Boolean);
  return { status: r.status, data: rows.slice(0, FIND_FILES_LIMIT) };
}

export const RESOURCE_LIST_LIMIT = 200;

/** experimental.resource.list answers `{ [key]: McpResource }`; the picker takes rows. */
export function resourceRows(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
  return Object.values(map)
    .filter((r) => r && typeof r.uri === 'string' && r.uri && typeof r.client === 'string' && r.client)
    .map((r) => ({
      name: String(r.name || r.uri).slice(0, 200),
      uri: r.uri,
      client: r.client,
      description: typeof r.description === 'string' ? r.description.slice(0, 300) : '',
      mimeType: typeof r.mimeType === 'string' ? r.mimeType : '',
    }))
    .sort((a, b) => a.client.localeCompare(b.client) || a.name.localeCompare(b.name))
    .slice(0, RESOURCE_LIST_LIMIT);
}

// Resources of the MCP servers connected to the serve hosting this session.
async function resourceList(msg, deps) {
  const r = await deps.proxy('GET', `/experimental/resource${deps.directoryQuery(msg.cwd)}`, null, 10000, deps.baseUrlFor(sessionKeyOf(msg)));
  if (r.status >= 400) return failure(r.status, proxyErrorText(r.data, 'Could not list MCP resources'));
  return { status: r.status, data: resourceRows(r.data) };
}

/** v2.reference.list answers `{ location, data: ReferenceInfo[] }`; hidden ones are left out. */
export function referenceRows(body) {
  const list = Array.isArray(body?.data) ? body.data : (Array.isArray(body) ? body : []);
  return list
    .filter((r) => r && typeof r.name === 'string' && r.name && r.hidden !== true)
    .map((r) => ({
      name: r.name,
      path: typeof r.path === 'string' ? r.path : '',
      description: typeof r.description === 'string' ? r.description : '',
    }));
}

// References live under /api and take the directory as a location.
function referencePath(directory) {
  return directory
    ? `/api/reference?directory=${encodeURIComponent(directory)}&location%5Bdirectory%5D=${encodeURIComponent(directory)}`
    : '/api/reference';
}

async function referenceList(msg, deps) {
  const r = await deps.proxy('GET', referencePath(directoryOf(msg)), null, 10000, deps.baseUrlFor(sessionKeyOf(msg)));
  if (r.status >= 400 || typeof r.data === 'string') return { status: 200, data: [] };
  return { status: r.status, data: referenceRows(r.data) };
}

/** What the agent toggle needs of an Agent; the prompt and permission ruleset stay behind. */
export function agentRow(agent) {
  if (!agent || typeof agent.name !== 'string' || !agent.name) return null;
  return {
    name: agent.name,
    mode: typeof agent.mode === 'string' ? agent.mode : '',
    description: typeof agent.description === 'string' ? agent.description : '',
    hidden: agent.hidden === true,
    color: typeof agent.color === 'string' ? agent.color : '',
  };
}

// Agents depend on the project (.opencode/agent), so they are asked per directory.
async function agentList(msg, deps) {
  const r = await deps.shared.extra.app.agents({ directory: directoryOf(msg) });
  return { status: r.status, data: (Array.isArray(r.data) ? r.data : []).map(agentRow).filter(Boolean) };
}

// ── Changes and VCS ─────────────────────────────────────────────────────────

export const FILE_DIFF_MAX_FILES = 300;
export const FILE_DIFF_MAX_PATCH_CHARS = 200_000;

/**
 * File diffs as the panel takes them: `{ file, patch, additions, deletions,
 * status }`. `file` and `patch` are optional in the SDK (SnapshotFileDiff);
 * a huge patch is cut and marked so one generated file cannot flood the socket.
 */
export function capFileDiffs(list) {
  const rows = (Array.isArray(list) ? list : []).filter((row) => row && typeof row === 'object');
  return rows.slice(0, FILE_DIFF_MAX_FILES).map((row) => {
    const patch = typeof row.patch === 'string' ? row.patch : '';
    const out = {
      file: typeof row.file === 'string' ? row.file : '',
      patch: patch.length > FILE_DIFF_MAX_PATCH_CHARS ? patch.slice(0, FILE_DIFF_MAX_PATCH_CHARS) : patch,
      additions: Number(row.additions) || 0,
      deletions: Number(row.deletions) || 0,
    };
    if (typeof row.status === 'string') out.status = row.status;
    if (patch.length > FILE_DIFF_MAX_PATCH_CHARS) out.patchTruncated = true;
    return out;
  });
}

// What the session changed (snapshot based), optionally only one message's turn.
async function sessionDiff(msg, deps) {
  const r = await deps.bound(sessionKeyOf(msg)).extra.session.diff({
    sessionID: sessionIdOf(msg), messageID: messageIdOf(msg) || undefined, directory: directoryOf(msg),
  });
  return { status: r.status, data: capFileDiffs(r.data) };
}

async function vcsGet(msg, deps) {
  const r = await deps.shared.extra.vcs.get({ directory: directoryOf(msg) });
  return { status: r.status, data: { branch: r.data?.branch || '', defaultBranch: r.data?.default_branch || '' } };
}

async function vcsStatus(msg, deps) {
  const r = await deps.shared.extra.vcs.status({ directory: directoryOf(msg) });
  return { status: r.status, data: capFileDiffs(r.data).map(({ patch, ...row }) => row) };
}

// mode 'git': the working tree against HEAD. 'branch': against the default branch.
async function vcsDiff(msg, deps) {
  const mode = msg.mode === 'branch' ? 'branch' : 'git';
  const r = await deps.shared.extra.vcs.diff({ mode, directory: directoryOf(msg) });
  return { status: r.status, data: capFileDiffs(r.data) };
}

// ── Worktrees ───────────────────────────────────────────────────────────────

// worktree.create answers a Worktree { name, branch, directory }; worktree.list
// answers the directories only (confirmed on 1.18.34).
function worktreeRow(w) {
  const directory = typeof w === 'string' ? w : (w && typeof w.directory === 'string' ? w.directory : '');
  if (!directory) return null;
  const leaf = directory.split(/[\\/]/).filter(Boolean).pop() || directory;
  return {
    name: typeof w === 'object' && w.name ? String(w.name) : leaf,
    branch: typeof w === 'object' && typeof w.branch === 'string' ? w.branch : '',
    directory,
  };
}

async function worktreeList(msg, deps) {
  if (!directoryOf(msg)) return failure(400, 'cwd is required');
  const r = await deps.shared.extra.worktree.list({ directory: directoryOf(msg) });
  return { status: r.status, data: (Array.isArray(r.data) ? r.data : []).map(worktreeRow).filter(Boolean) };
}

async function worktreeCreate(msg, deps) {
  if (!directoryOf(msg)) return failure(400, 'cwd is required');
  const name = typeof msg.name === 'string' ? msg.name.trim() : '';
  if (name && !/^[A-Za-z0-9][\w.-]{0,63}$/.test(name)) {
    return failure(400, 'A worktree name may use letters, digits, ".", "_" and "-".');
  }
  const r = await deps.shared.extra.worktree.create({
    directory: directoryOf(msg),
    worktreeCreateInput: name ? { name } : {},
  });
  const row = worktreeRow(r.data);
  if (!row) return failure(502, 'OpenCode did not return the new worktree.');
  return { status: r.status, data: row };
}

// Removing deletes a directory, so only one OpenCode itself lists as a worktree
// of this project is accepted.
async function worktreeRemove(msg, deps) {
  const cwd = directoryOf(msg);
  const target = typeof msg.directory === 'string' ? msg.directory.trim() : '';
  if (!cwd || !target) return failure(400, 'cwd and directory are required');
  const listed = await deps.shared.extra.worktree.list({ directory: cwd });
  const known = (Array.isArray(listed.data) ? listed.data : []).some((w) => worktreeRow(w)?.directory === target);
  if (!known) return failure(404, 'That directory is not a worktree of this project.');
  const r = await deps.shared.extra.worktree.remove({ directory: cwd, worktreeRemoveInput: { directory: target } });
  return { status: r.status, data: true };
}

// ── Environment: MCP servers, LSP, formatters ───────────────────────────────

// SynaBun's own MCP entry is pinned by the runtime (profile, terminal identity,
// browser ownership): the panel shows it but may not switch it.
export const MANAGED_MCP_NAMES = Object.freeze(['SynaBun']);
const isManagedMcpName = (name) => MANAGED_MCP_NAMES.some((managed) => managed.toLowerCase() === String(name).trim().toLowerCase());

const MCP_STATUSES = new Set(['connected', 'disabled', 'failed', 'needs_auth', 'needs_client_registration']);

/** mcp.status answers `{ [name]: McpStatus }`; the panel takes sorted rows. */
export function mcpRows(statusMap) {
  const map = statusMap && typeof statusMap === 'object' && !Array.isArray(statusMap) ? statusMap : {};
  return Object.entries(map)
    .map(([name, value]) => {
      const row = {
        name,
        status: MCP_STATUSES.has(value?.status) ? value.status : 'failed',
        managed: MANAGED_MCP_NAMES.includes(name),
      };
      if (typeof value?.error === 'string' && value.error) row.error = value.error.slice(0, 500);
      return row;
    })
    .sort((a, b) => Number(b.managed) - Number(a.managed) || a.name.localeCompare(b.name));
}

const mcpNameOf = (msg) => (typeof msg?.name === 'string' ? msg.name.trim() : '');

// The MCP servers of the serve that runs this session's turns.
async function mcpStatus(msg, deps) {
  const r = await deps.bound(sessionKeyOf(msg)).mcp.status({ directory: directoryOf(msg) });
  return { status: r.status, data: mcpRows(r.data) };
}

async function mcpSwitch(msg, deps, connect) {
  const name = mcpNameOf(msg);
  if (!name) return failure(400, 'MCP server name is required');
  if (isManagedMcpName(name)) return failure(403, `${name} is managed by SynaBun and cannot be switched from the panel.`);
  const client = deps.bound(sessionKeyOf(msg));
  const params = { name, directory: directoryOf(msg) };
  const r = connect ? await client.mcp.connect(params) : await client.mcp.disconnect(params);
  const after = await client.mcp.status({ directory: directoryOf(msg) }).catch(() => null);
  return { status: r.status, data: after ? mcpRows(after.data) : [] };
}

// OAuth for a remote MCP server: OpenCode opens the browser itself and waits
// for the callback, so the request can take minutes.
async function mcpAuthenticate(msg, deps) {
  const name = mcpNameOf(msg);
  if (!name) return failure(400, 'MCP server name is required');
  if (isManagedMcpName(name)) return failure(403, `${name} is managed by SynaBun.`);
  const path = `/mcp/${encodeURIComponent(name)}/auth/authenticate${deps.directoryQuery(msg.cwd)}`;
  const r = await deps.proxy('POST', path, {}, 5 * 60 * 1000, deps.baseUrlFor(sessionKeyOf(msg)));
  if (r.status >= 400 || typeof r.data === 'string') {
    return failure(r.status >= 400 ? r.status : 502, proxyErrorText(r.data, 'Authentication did not complete'));
  }
  return { status: r.status, data: r.data };
}

const MCP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const stringMap = (value) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.values(value).every((v) => typeof v === 'string');

/**
 * A server the user typed into the panel, as OpenCode's `POST /mcp` takes it.
 * `{ command, args?, env? }` → McpLocalConfig, `{ url, headers? }` → McpRemoteConfig.
 * Resolves `{ ok: true, config }` or `{ ok: false, error }`.
 *
 * This validates; it does not rewrite. The executable has to be there, and the
 * command and its arguments have to be text. Past that every word is passed on
 * exactly as it came: an empty argument stays an argument, leading and
 * trailing spaces stay. The config that is registered is also the one that is
 * saved (mcpAdd), so a later serve starts the server with the same argv.
 */
export function runtimeMcpConfigFor(input) {
  if (!input || typeof input !== 'object') return { ok: false, error: 'A command or a URL is required.' };
  const env = input.environment ?? input.env;
  if (env != null && !stringMap(env)) return { ok: false, error: 'Environment variables must be text.' };
  if (input.headers != null && !stringMap(input.headers)) return { ok: false, error: 'Headers must be text.' };
  if (typeof input.url === 'string' && input.url.trim()) {
    let url;
    try { url = new URL(input.url.trim()); } catch { return { ok: false, error: 'That is not a valid URL.' }; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: 'An MCP server URL must be http or https.' };
    return { ok: true, config: buildOpencodeRuntimeMcpConfig({ url: url.toString(), headers: input.headers || undefined }) };
  }
  if (input.args != null && !Array.isArray(input.args)) return { ok: false, error: 'Arguments must be a list.' };
  const command = [...(Array.isArray(input.command) ? input.command : [input.command]), ...(input.args || [])];
  if (command[0] === undefined || command[0] === null) return { ok: false, error: 'A command or a URL is required.' };
  if (!command.every((part) => typeof part === 'string')) return { ok: false, error: 'The command and its arguments must be text.' };
  if (!command[0].trim()) return { ok: false, error: 'A command or a URL is required.' };
  return { ok: true, config: buildOpencodeRuntimeMcpConfig({ command, env: env || undefined }) };
}

// mcp.add: register one more MCP server on the serve that runs this session.
// It lasts as long as that serve. With `persist: true` the same config is then
// written to the OpenCode config (deps.persistMcp), so later serves start with
// it. That write starts nothing: the server runs once, where it was registered.
// (The Settings route, POST /api/opencode/mcp, also registers on the shared
// serve; a panel that saved through it started a command-based server twice.)
// A server that did not start is never saved: a typo must not end up in the config.
async function mcpAdd(msg, deps) {
  const name = mcpNameOf(msg);
  if (!name) return failure(400, 'MCP server name is required');
  if (isManagedMcpName(name)) return failure(403, `${name} is managed by SynaBun and cannot be changed from the panel.`);
  if (!MCP_NAME_RE.test(name)) return failure(400, 'A server name may use letters, digits, ".", "_" and "-".');
  const built = runtimeMcpConfigFor(msg.config);
  if (!built.ok) return failure(400, built.error);
  const r = await deps.bound(sessionKeyOf(msg)).extra.mcp.add({ name, config: built.config, directory: directoryOf(msg) });
  const rows = mcpRows(r.data);
  const reply = { status: r.status, data: rows };
  if (msg.persist !== true) return reply;
  const row = rows.find((entry) => entry.name === name);
  if (r.status >= 400 || !row || row.status === 'failed') return { ...reply, saved: false };
  if (typeof deps.persistMcp !== 'function') return { ...reply, saved: false, saveError: 'This server cannot save MCP servers.' };
  try {
    await deps.persistMcp(name, built.config);
    return { ...reply, saved: true };
  } catch (err) {
    return { ...reply, saved: false, saveError: err?.message || String(err) };
  }
}

const listOr = (value) => (Array.isArray(value) ? value : []);

// Language servers and formatters of the session's serve. Each read is
// independent: one that fails is reported as an empty list.
async function envStatus(msg, deps) {
  const client = deps.bound(sessionKeyOf(msg));
  const directory = directoryOf(msg);
  const [lsp, formatter, reference] = await Promise.all([
    client.extra.lsp.status({ directory }).catch(() => null),
    client.extra.formatter.status({ directory }).catch(() => null),
    deps.proxy('GET', referencePath(directory), null, 10000, deps.baseUrlFor(sessionKeyOf(msg))).catch(() => null),
  ]);
  return {
    status: 200,
    data: {
      references: reference?.status === 200 ? referenceRows(reference.data) : [],
      lsp: listOr(lsp?.data).map((s) => ({ id: String(s?.id || ''), name: String(s?.name || s?.id || ''), root: String(s?.root || ''), status: String(s?.status || '') })),
      formatter: listOr(formatter?.data).map((f) => ({ name: String(f?.name || ''), extensions: listOr(f?.extensions).filter((e) => typeof e === 'string'), enabled: f?.enabled !== false })),
    },
  };
}

// type → { run, session? }. `session: true` rejects a request without sessionId.
const HANDLERS = {
  'session:context': {
    session: true,
    run: async (msg, deps) => {
      const r = await deps.shared.session.context({ sessionID: sessionIdOf(msg) });
      return { status: r.status, data: contextRows(r.data) };
    },
  },
  'session:compact': { session: true, run: compactSession },
  'session:status': { session: true, run: sessionStatus },
  'session:todo': { session: true, run: sessionTodo },
  'permission:reply': { run: permissionReply },
  'permission:list': { run: permissionList },
  'permission:saved:list': { run: permissionSavedList },
  'permission:saved:remove': { run: permissionSavedRemove },
  'question:reply': { run: questionReply },
  'session:revert': { session: true, mutates: true, run: sessionRevert },
  'session:unrevert': { session: true, mutates: true, run: sessionUnrevert },
  'session:fork': { session: true, mutates: true, run: sessionFork },
  'session:children': { session: true, run: sessionChildren },
  'session:share': { session: true, mutates: true, run: sessionShare },
  'session:unshare': { session: true, mutates: true, run: sessionUnshare },
  'session:share:policy': { run: sessionSharePolicy },
  'message:delete': { session: true, mutates: true, run: messageDelete },
  'command:list': { run: commandList },
  'command:run': { session: true, mutates: true, run: commandRun },
  'session:shell': { session: true, mutates: true, run: sessionShell },
  'find:files': { run: findFiles },
  'find:symbols': { run: findSymbols },
  'resource:list': { run: resourceList },
  'reference:list': { run: referenceList },
  'agent:list': { run: agentList },
  'session:diff': { session: true, run: sessionDiff },
  'vcs:get': { run: vcsGet },
  'vcs:status': { run: vcsStatus },
  'vcs:diff': { run: vcsDiff },
  'worktree:list': { run: worktreeList },
  'worktree:create': { run: worktreeCreate },
  'worktree:remove': { run: worktreeRemove },
  'mcp:status': { run: mcpStatus },
  'mcp:connect': { session: true, mutates: true, run: (msg, deps) => mcpSwitch(msg, deps, true) },
  'mcp:disconnect': { session: true, mutates: true, run: (msg, deps) => mcpSwitch(msg, deps, false) },
  'mcp:authenticate': { session: true, mutates: true, run: mcpAuthenticate },
  'mcp:add': { session: true, mutates: true, run: mcpAdd },
  'env:status': { run: envStatus },
};

// Types added here that change a session. server.js adds them to its
// native-run and history-clear guard sets, which key on the type name.
export const OPENCODE_V2_WS_MUTATION_TYPES = Object.freeze(
  Object.keys(HANDLERS).filter((type) => HANDLERS[type].mutates),
);

export const OPENCODE_V2_WS_MODULE_TYPES = Object.freeze(Object.keys(HANDLERS));

// Behaviours of an existing type that an older server lacks. Listed next to
// the types so the panel can gate on them the same way; never a request type.
export const OPENCODE_V2_WS_FEATURES = Object.freeze([
  'feature:permission-reply-message',   // permission:reply forwards a rejection reason
  'feature:compact-summarize',          // session:compact falls back to session.summarize
  'feature:session-list-filters',       // session:list takes search / archived / roots / limit, rows carry parentID
  'feature:mcp-add-persist',            // mcp:add with persist:true saves the server without starting it a second time
]);

// The version of the @opencode-ai/sdk this server talks to OpenCode through,
// for the panel's Versions rows ('' when its package.json cannot be read).
let _sdkVersion;
export function opencodeSdkVersion() {
  if (_sdkVersion !== undefined) return _sdkVersion;
  _sdkVersion = '';
  try {
    let dir = dirname(fileURLToPath(import.meta.resolve('@opencode-ai/sdk/v2')));
    for (let i = 0; i < 6 && dir !== dirname(dir); i += 1, dir = dirname(dir)) {
      let pkg = null;
      try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); } catch { /* not the package root */ }
      if (pkg?.name === '@opencode-ai/sdk') { _sdkVersion = String(pkg.version || ''); break; }
    }
  } catch { /* stays '' */ }
  return _sdkVersion;
}

// Everything this server answers, for the panel's feature gating.
export function opencodeV2WsCapabilities() {
  return [...OPENCODE_V2_WS_INLINE_TYPES, ...OPENCODE_V2_WS_MODULE_TYPES, ...OPENCODE_V2_WS_FEATURES];
}

export function ownsOpencodeV2Request(type) {
  return Object.prototype.hasOwnProperty.call(HANDLERS, type);
}

/** Answer `msg` when its type lives here. Resolves true when it was handled. */
export async function handleOpencodeV2Request(msg, deps) {
  const type = msg?.type;
  if (!ownsOpencodeV2Request(type)) return false;
  const handler = HANDLERS[type];
  const reply = (body) => deps.send({ type: `${type}:result`, id: msg.id, ...body });
  // server.js has done this already; a caller that has not gets the same id rules.
  const malformed = canonicalizeOpencodeV2Message(msg);
  if (malformed) {
    reply(malformed);
    return true;
  }
  if (handler.session && !sessionIdOf(msg)) {
    reply(failure(400, 'sessionId is required'));
    return true;
  }
  try {
    reply(await handler.run(msg, deps));
  } catch (err) {
    reply(failure(err?.status || 500, err?.message || String(err), err?.tag ? { tag: err.tag } : {}));
  }
  return true;
}
