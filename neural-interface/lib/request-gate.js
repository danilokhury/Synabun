// ═══════════════════════════════════════════
// SynaBun — who may ask: the checks in front of every route
// ═══════════════════════════════════════════
//
// Four middlewares that server.js mounts before any route (createRequestGates):
//
//   host       A request for the owner's data, or one that acts for them, must
//              name this server: 403 { ok: false, code: 'BAD_HOST' } otherwise.
//              A web page whose own name was re-pointed at this machine (DNS
//              rebinding) is same-origin with the server and sends that name as
//              its Host. The rule is lib/http-guards.js isAllowedHost: loopback,
//              an IP address, this computer's names, the tunnel and the invite
//              proxy in use, and what SYNABUN_ALLOWED_HOSTS adds. It covers
//              everything under HOST_CHECKED_PREFIXES and the images the owner
//              uploaded for their categories; the app's own static files stay
//              open.
//   remote     A request that comes in from outside is nobody's until it shows
//              an invite session: 403 { error: 'Forbidden' } for everything but
//              the MCP endpoint and the invite sign-in. From outside is what
//              Cloudflare's tunnel marks (cf-connecting-ip) and what arrives
//              under a public name, the tunnel's or the invite proxy's,
//              whatever headers it carries (isRemote). With a session it is a
//              guest; it is never the owner. This computer's own names and
//              addresses are not public names, whatever the invite address is
//              set to.
//   adminOnly  An invite guest never reaches an admin-only route.
//   features   An invite guest changes nothing of a feature the owner has not
//              opened to guests, and without the terminal reads neither of
//              its lists of a folder's files and branches.
//
// And one for the plain /mcp mount (mcpWithoutKey): what comes in from outside
// needs the key (/mcp/<key>), and is refused while none is set. So does what
// comes from another machine on the network (fromAnotherMachine: the socket's
// peer is neither loopback nor one of this computer's own addresses), which
// server.js also asks before the tunnel is started or stopped. Those two only:
// what else a machine on the network may do is the owner's decision.
//
// A WebSocket upgrade passes no middleware: server.js asks ownHost(req) for the
// Host rule (every upgrade is under it, whatever its path) and isRemote(req)
// for where it comes from, before anything else looks at the request. A name
// that is not known while this computer's names are being read waits for
// them, as a route's request does (ownHostAfterNames).
//
// The two guest checks decide on the path as the router will match it, not on
// the path as it was written. Express matches a route whatever the case of its
// letters, takes one more slash after the path a router is mounted at, and
// decodes the parameters of a route (a handler may decode one again). So
// `/API/system/backup`, `/api//hook-recall` and `/api/ui-blobs/editor%2Dbackups`
// reach routes that a comparison of the raw path with a list of prefixes does
// not see. routedForms() gives every form a path can be read as; a prefix that
// matches any of them decides. A path that has no safe reading (a "." or ".."
// segment, a control character, more layers of escapes than anybody's own page
// writes) is refused outright: for a guest, and for a Host that is not ours.
//
// The owner's own requests are not read this way at all: with a Host of ours
// and no invite session, none of this looks at the path.

import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { parse as parseDotenv } from 'dotenv';
import { hostNameOf, isAllowedHost, isLoopbackAddress, sendGuardError, thisMachineAddresses } from './http-guards.js';
import { machineNames as thisMachine } from './machine-names.js';

/** Routes an invite guest never reaches: the path, in any spelling, starts with one of these. */
export const ADMIN_ONLY_PREFIXES = Object.freeze([
  '/api/settings', '/api/display-settings',
  '/api/connections', '/api/setup', '/api/system',
  '/api/invite/key', '/api/invite/sessions', '/api/invite/proxy', '/api/invite/permissions',
  '/api/claude-code', '/api/mcp-key', '/api/mcp/runtime-tools',
  // MCP servers and plugins as the owner set them up: their credentials (GET /api/mcp/env/<name>?reveal=1
  // answers with them), the registry of the commands that are started, installs, what is written into the
  // CLIs' own configuration, and tool lists. Everything under /api/mcp, the two entries above included.
  '/api/mcp',
  '/api/plugins',
  // Installing a skill into one of the owner's runtimes, or removing it (Settings; its older address is under
  // /api/claude-code above). The "Skills Studio" permission opens /api/skills-studio, not this.
  '/api/skills/install',
  // The Skills Service's installs, rollbacks and removals, the move of the old bridges, and its settings: the
  // owner's, from the app's own page (lib/skills/api-v2.js refuses guests and agents on its own too).
  '/api/skills-studio/v2/installations', '/api/skills-studio/v2/migrations', '/api/skills-studio/v2/config',
  '/api/tunnel/start', '/api/tunnel/stop',
  '/api/bridges', '/api/keybinds',
  '/api/cli',
  // The code editor: reading, writing and creating files, their versions, and its preferences.
  '/api/file-content',
  '/api/file-mkdir',
  '/api/file-stat',
  '/api/file-head',
  '/api/editor',
  // The editor's copies of unsaved buffers hold file content: their place in the UI blob store is the owner's.
  '/api/ui-blobs/editor-backups',
  // The File Explorer: its own routes (lib/file-explorer-api.js), the older listing of a project's files it
  // falls back to, and the folder picker of "Add project", which opens a dialog on the owner's machine.
  '/api/explorer',
  '/api/project-files',
  '/api/browse-folder',
  '/api/codex/plans',
  '/api/sidepanel',
  '/api/sidepanel-runs',
  '/api/loop',
  '/api/schedules',
  '/api/schedule-groups',
  '/api/quick-timer',
  '/api/diagnostics',
  '/api/desktop',
  // WhatsApp Link: linking, the owner and the permission level (its router
  // refuses guests and remote callers on its own too: lib/http-guards.js).
  '/api/whatsapp',
  // TypeSafe key/config/backfill, and the hook routes: /hook-recall returns
  // memory content and /hook-judge spends the host's judgment budget.
  '/api/typesafe',
  '/api/hook-',
  '/api/map/rebuild',
]);

/** A guest's request that is not a GET, under one of these, needs the owner to have opened that feature to guests. */
export const FEATURE_PERMISSION_MAP = Object.freeze([
  { prefix: '/api/terminal',      perm: 'terminal' },
  { prefix: '/api/whiteboard',    perm: 'whiteboard' },
  { prefix: '/api/memory',        perm: 'memories' },
  { prefix: '/api/categories',    perm: 'memories' },
  { prefix: '/api/trash',         perm: 'memories' },
  { prefix: '/api/skills-studio', perm: 'skills' },
  { prefix: '/api/browser',       perm: 'browser' },
  { prefix: '/api/cards',         perm: 'cards' },
  { prefix: '/api/style-guide',   perm: 'styleGuide' },
].map(Object.freeze));

/**
 * What an invite guest only reads, whatever the owner opened to guests: the "Skills Studio" permission shows the
 * skills, and every change (save, create, delete, files, icons, install, customize, import, the Skills Service's
 * drafts and reviews) is the owner's, as lib/skills/api-v2.js and each legacy Studio route say on their own too.
 */
export const GUEST_READ_ONLY_PREFIXES = Object.freeze(['/api/skills-studio']);

/**
 * The GETs a guest does not get for the asking. The terminal's lists of a folder's files and of its branches take
 * any folder of the disk from the request, so they are the terminal's: a guest reads them with the permission
 * that gives a guest the terminal, and is refused without it. A whole segment each.
 */
export const FEATURE_READ_PATHS = Object.freeze([
  { path: '/api/terminal/files',    perm: 'terminal' },
  { path: '/api/terminal/branches', perm: 'terminal' },
].map(Object.freeze));

/**
 * What the Host rule covers: every route that returns the owner's data or acts for them. Everything under /api;
 * the MCP endpoint (memory, the browser, every tool); the invite sign-in (the way in for a guest); the offline
 * page as the server renders it (it carries the install path and the launcher's state); the owner's uploaded file
 * icons. A whole segment each: /api and /api/…, never /apix.
 */
export const HOST_CHECKED_PREFIXES = Object.freeze(['/api', '/mcp', '/invite/auth', '/offline.html', '/custom-icons']);

/**
 * The Host rule also covers the images the owner uploaded for their categories. They are written beside the
 * app's own files (server.js: public/logo-<category>.<png|jpg|webp|gif>) and served with them, so they are known
 * by their name: a file of that family at the root. The app's own files of the family (BUNDLED_LOGO_FILES) stay
 * open, unless a category has taken one of those names for its upload (`claimed`).
 */
export const UPLOADED_IMAGE_PATH = /^\/logo-[^/]+\.(?:png|jpe?g|webp|gif)$/;
export const BUNDLED_LOGO_FILES = Object.freeze(['/logo-synabun.png']);

/**
 * What a request from outside reaches without an invite session: the MCP endpoint (it has its key) and the invite
 * sign-in. As the tunnel block of server.js always read it: the path as written starts with one of these.
 */
export const REMOTE_OPEN_PREFIXES = Object.freeze(['/mcp', '/invite']);

/**
 * Headers that speak for an agent of this computer (the Assistant's brain, a computer-use grant). From outside
 * they count for nothing: they are taken off a remote request before anything reads them.
 */
export const REMOTE_STRIPPED_HEADERS = Object.freeze(['x-synabun-role', 'x-synabun-desktop-grant']);

/** The environment variable that adds names this server answers to (docs/api-reference.md → Who may call the server). */
export const ALLOWED_HOSTS_VARIABLE = 'SYNABUN_ALLOWED_HOSTS';

const MAX_DECODE_ROUNDS = 3;
const ESCAPE_RUNS = /(?:%[0-9a-f]{2})+/gi;
const ASCII_ESCAPE = /%[0-7][0-9a-f]/gi;
const CONTROL = /[\u0000-\u001f\u007f]/;
const DOTS_ONLY = /^[. ]+$/;
const MAX_REFUSED_NAMES = 100;

/** One layer of percent-escapes taken off. A run that is not UTF-8 keeps its bytes above 0x7F as they are written. */
function decodeOnce(path) {
  return path.replace(ESCAPE_RUNS, (run) => {
    try { return decodeURIComponent(run); }
    catch { return run.replace(ASCII_ESCAPE, (one) => String.fromCharCode(parseInt(one.slice(1), 16))); }
  });
}

/**
 * One reading of a path, in the form the prefixes are written in: lower-case, "\" as "/", a segment without its
 * `;parameters` and without dots or spaces at its end, one slash between segments. null when a segment is "." or
 * ".." (or dots and spaces only): the router does not resolve those, and nothing that sends them is a page of ours.
 */
function canonical(path) {
  const segments = [];
  for (const written of path.toLowerCase().replace(/\\/g, '/').split('/')) {
    const semicolon = written.indexOf(';');
    const segment = semicolon === -1 ? written : written.slice(0, semicolon);
    if (DOTS_ONLY.test(segment)) return null;
    const trimmed = segment.replace(/[. ]+$/, '');
    if (trimmed) segments.push(trimmed);
  }
  return `/${segments.join('/')}`;
}

/**
 * Every form a request path can be read as by the router or by a handler behind it: as written, and with one, two
 * and three layers of percent-escapes taken off, each made canonical. A check that compares prefixes takes a match
 * in any of them.
 * @param {string} path the path as the router takes it (req.path: no query, no fragment)
 * @returns {string[] | null} null: the path has no safe reading
 */
export function routedForms(path) {
  if (typeof path !== 'string' || path[0] !== '/') return null;
  const forms = [];
  let current = path;
  for (let round = 0; ; round++) {
    if (CONTROL.test(current)) return null;
    const form = canonical(current);
    if (form === null) return null;
    if (!forms.includes(form)) forms.push(form);
    const next = decodeOnce(current);
    if (next === current) return forms;
    if (round === MAX_DECODE_ROUNDS) return null;
    current = next;
  }
}

const startsWithSegment = (form, prefix) => form === prefix || form.startsWith(`${prefix}/`);

/** Is this path, in any of its forms, one the Host rule covers? Also true for a path without a safe reading. */
export function isHostCheckedPath(path) {
  const forms = routedForms(path);
  return !forms || forms.some((form) => HOST_CHECKED_PREFIXES.some((prefix) => startsWithSegment(form, prefix)));
}

/**
 * Is this path, in any of its forms, an image the owner uploaded for a category (UPLOADED_IMAGE_PATH)? One of the
 * app's own files of that family is not, unless `claimed` says a category's upload now has that name.
 * @param {string} path the path as the router takes it
 * @param {(form: string) => boolean} [claimed] is this path (lower-case, as a category records its image) an upload?
 */
export function isUploadedImagePath(path, claimed = () => false) {
  const forms = routedForms(path);
  if (!forms) return false;   // no safe reading: isHostCheckedPath has that case
  return forms.some((form) => {
    if (!UPLOADED_IMAGE_PATH.test(form)) return false;
    if (!BUNDLED_LOGO_FILES.includes(form)) return true;
    try { return !!claimed(form); } catch { return true; }
  });
}

/**
 * The names a value of SYNABUN_ALLOWED_HOSTS adds: separated by commas or blanks, each a host name, host:port or
 * an http(s) URL (isAllowedHost reads the host name of each; anything else counts for nothing). A value counts
 * up to its first "#": no host is written with one, so what follows it is a comment, and a comment adds no name.
 * @param {...(string | undefined | null)} values the variable as the environment has it, as the .env file has it
 */
export function extraHostNames(...values) {
  const names = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    for (const each of value.split('#', 1)[0].replace(/^\s*(['"])(.*)\1\s*$/, '$2').split(/[\s,]+/)) {
      if (each && !names.includes(each)) names.push(each);
    }
  }
  return names;
}

/**
 * SYNABUN_ALLOWED_HOSTS as the data home's .env has it now, read the way the server read that file when it
 * started: with dotenv's own parser. What counts is what dotenv gives the line (`export NAME=…`, blanks around
 * the "=", a quoted value, a comment after it), so a line means the same before and after a restart. Read when a
 * request asks: a name added to the file is answered at the next request, one taken out is refused at the next.
 * @param {string} path the .env file
 * @param {string} [variable]
 * @returns {string | undefined} undefined: the file has no such line, or there is no file
 */
export function savedValueOf(path, variable = ALLOWED_HOSTS_VARIABLE) {
  try {
    const value = parseDotenv(readFileSync(path, 'utf8'))[variable];
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * SYNABUN_ALLOWED_HOSTS as the process was started with it, kept apart from what the data home's .env says.
 * Loading that file into the environment copies the file's value into it, and there it stays when the line is
 * taken out of the file again: a name could be added without a restart and never removed. So the value the
 * environment has by itself is noted before the file is loaded (`value`), and put back afterwards (`restore`);
 * the file's own value is read from the file when a request asks. Nothing the server starts inherits the file's.
 * @param {object} [env] process.env
 * @param {string} [variable]
 * @returns {{ value: string | undefined, restore: () => void }}
 */
export function startedValueOf(env = process.env, variable = ALLOWED_HOSTS_VARIABLE) {
  const had = Object.prototype.hasOwnProperty.call(env, variable);
  const value = had ? env[variable] : undefined;
  return {
    value,
    restore() {
      if (had) env[variable] = value;
      else delete env[variable];
    },
  };
}

/** The host names and addresses of a list of http(s) URLs, host names or host:port entries, as hostNameOf writes them. */
export function hostsOf(list) {
  let entries;
  try { entries = typeof list === 'function' ? list() : list; } catch { return []; }
  const names = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry) continue;
    let host = String(entry);
    if (host.includes('://')) {
      try {
        const url = new URL(host);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
        host = url.host;
      } catch { continue; }
    }
    const name = hostNameOf(host);
    if (name) names.push(name);
  }
  return names;
}

/**
 * A socket's peer address as this computer's own addresses are written (thisMachineAddresses): IPv4 without the
 * "::ffff:" of a dual-stack socket, IPv6 in brackets without its zone. null when there is none.
 */
function peerName(address) {
  if (typeof address !== 'string' || !address) return null;
  const bare = address.replace(/%.*$/, '');
  const v4 = /^::ffff:/i.test(bare) && isIP(bare.slice(7)) === 4 ? bare.slice(7) : bare;
  if (isIP(v4) === 4) return v4;
  return isIP(v4) === 6 ? hostNameOf(`[${v4}]`) : null;
}

function sameText(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

/** `/mcp/<key>` with the key that is set: the caller's proof is in the path, whatever name it used to get here. */
function carriesMcpKey(path, key) {
  if (!key || typeof key !== 'string' || typeof path !== 'string' || !path.startsWith('/mcp/')) return false;
  const end = path.indexOf('/', 5);
  return sameText(end === -1 ? path.slice(5) : path.slice(5, end), key);
}

/**
 * The checks in front of the routes.
 * @param {object} deps
 * @param {(req: object) => boolean} deps.isGuestRequest an invite guest's request?
 * @param {() => object} [deps.permissions] what the owner opened to guests ({ terminal, whiteboard, memories, … })
 * @param {string[] | (() => string[])} [deps.allowedHosts] the public names of this server: the tunnel's and the
 *   invite proxy's URLs, and the names of SYNABUN_ALLOWED_HOSTS (asked only when no local rule matched)
 * @param {() => (string | null)} [deps.mcpKey] the key of /mcp/<key>, when one is set
 * @param {string[] | (() => string[])} [deps.publicHosts] the names requests from outside arrive under: the
 *   tunnel's URL and the invite proxy's when one is in use. Never the names of SYNABUN_ALLOWED_HOSTS, which are
 *   the owner's own for this computer
 * @param {(req: object) => boolean} [deps.hasInviteSession] does this request carry an invite session that is
 *   still good? (nobody has one when this is left out)
 * @param {(path: string) => boolean} [deps.uploadedImages] is this root file (lower-case: "/logo-<name>.<ext>")
 *   the image a category recorded as its upload? Asked only for the app's own files of that family
 * @param {() => string[]} [deps.localAddresses] this computer's own addresses, as a Host header names them
 *   (lib/http-guards.js thisMachineAddresses when it is left out)
 * @param {{ names: () => string[], refresh: () => Promise<any>, stale: () => boolean }} [deps.machine]
 *   lib/machine-names.js; a name that is not known is checked again after the system was asked anew
 * @param {() => string} [deps.settingsHint] where SYNABUN_ALLOWED_HOSTS is set, for the log line (the .env's path)
 * @param {(line: string) => void} [deps.log]
 * @returns {{ host: Function, remote: Function, adminOnly: Function, features: Function, mcpWithoutKey: Function,
 *   ownHost: (req: object) => boolean, ownHostAfterNames: (req: object, socket: object, again: () => void) => boolean,
 *   isRemote: (req: object) => boolean, fromAnotherMachine: (req: object) => boolean, refusedHosts: () => string[] }}
 */
export function createRequestGates({
  isGuestRequest, permissions = () => ({}), allowedHosts = [], mcpKey = () => null, machine = thisMachine,
  settingsHint = () => '', log = (line) => console.warn(line),
  publicHosts = [], hasInviteSession = () => false, uploadedImages = () => false, localAddresses = thisMachineAddresses,
} = {}) {
  if (typeof isGuestRequest !== 'function') throw new Error('createRequestGates requires isGuestRequest');
  const refused = new Set();     // names already written to the log
  const forms = new WeakMap();   // req → routedForms(req.path), read once for the two guest checks
  const formsOf = (req) => {
    if (!forms.has(req)) forms.set(req, routedForms(req.path));
    return forms.get(req);
  };
  const ours = (host) => isAllowedHost(host, { allowedHosts, machineName: machine.names });

  /** One line per name: what was refused, and what to do when the name is the owner's. */
  function note(req) {
    const written = req.headers?.host;
    const name = hostNameOf(written);
    const label = name ?? (typeof written === 'string' ? JSON.stringify(written.slice(0, 80)) : 'no Host header');
    if (refused.has(label)) return;
    if (refused.size >= MAX_REFUSED_NAMES) {
      if (!refused.has('…')) { refused.add('…'); log('[host] More names were refused; they are no longer listed one by one.'); }
      return;
    }
    refused.add(label);
    if (!name) {
      log(`[host] Refused a request whose Host header is not a name a browser sends (${label}).`);
      return;
    }
    let where = '';
    try { where = String(settingsHint() || ''); } catch { where = ''; }
    log(`[host] Refused a request for "${name}": this server does not answer to that name. It answers to localhost, `
      + 'an IP address, this computer\'s own names and the tunnel or invite proxy in use. If the name is this '
      + `computer's too, add ${ALLOWED_HOSTS_VARIABLE}=${name}${where ? ` to ${where}` : ''} (several names: `
      + 'separated by commas; it is read again without a restart). If it is not, a web page tried to reach this '
      + 'server under a name of its own and was stopped.');
  }

  function refuseHost(req, res) {
    note(req);
    return sendGuardError(res, 403, 'BAD_HOST', `This server does not answer to the name in the request's Host header. Open it at localhost or an IP address, or add the name to ${ALLOWED_HOSTS_VARIABLE}.`);
  }

  function host(req, res, next) {
    const written = req.headers?.host;
    if (ours(written)) return next();
    let key = null;
    try { key = mcpKey(); } catch { key = null; }
    if (carriesMcpKey(req.path, key)) return next();
    if (!isHostCheckedPath(req.path) && !isUploadedImagePath(req.path, uploadedImages)) return next();
    // The computer may have been renamed since its names were read: they are read again (once a minute at most)
    // before a name is refused.
    if (machine.stale()) {
      machine.refresh().then(() => (ours(written) ? next() : refuseHost(req, res)), () => refuseHost(req, res));
      return undefined;
    }
    return refuseHost(req, res);
  }

  const waited = new WeakSet();   // upgrades that have waited for this computer's names: each waits once
  const twoHosts = (req) => { const named = req?.headersDistinct?.host; return Array.isArray(named) && named.length > 1; };
  /**
   * Could a reading of this computer's names still make this upgrade's Host ours? Only a name can become one
   * (what is no name, and two Hosts, stay refused), only while the answers are old or on their way
   * (`machine.stale()`: never where the system is not asked), and only once per upgrade.
   */
  function namesDue(req) {
    if (!req || typeof req !== 'object' || waited.has(req) || twoHosts(req) || hostNameOf(req.headers?.host) === null) return false;
    try { return machine.stale() === true; } catch { return false; }
  }

  /**
   * The Host rule for a WebSocket upgrade: is its Host one of this server's names? Every upgrade is under the
   * rule, whatever its path and whether it carries an Origin or not (no file of the app is served over one, and
   * a client without an Origin passes the Origin check). It answers from what is known now, at once: a caller
   * that got `false` asks ownHostAfterNames() whether the system's names, which `host` waits for, are worth
   * waiting for here too. A refused name is logged once, when the refusal is the last word.
   * An upgrade that names two Hosts is refused whatever they are: Node reads the first, and a proxy in front may
   * have gone by the other.
   */
  function ownHost(req) {
    if (twoHosts(req)) {
      if (!refused.has('two Host headers')) { refused.add('two Host headers'); log('[host] Refused a WebSocket upgrade that names two Hosts: nothing of ours sends that.'); }
      return false;
    }
    if (ours(req?.headers?.host)) return true;
    if (!namesDue(req)) note({ headers: req?.headers || {} });
    return false;
  }

  /**
   * For an upgrade ownHost() has just said no to: the computer's names are read when the server starts and again
   * when the answers are old, and until a reading has ended the Bonjour name is not known. `host` waits for the
   * reading before it refuses a request; an upgrade does the same here, so a page left open under that name, or
   * a client that connects directly, is not answered 403 right after a start.
   *   → false: nothing to wait for (see namesDue). The caller refuses now.
   *   → true: `again()` is called when the reading has ended, and the caller asks ownHost() once more, which then
   *     gives the last word. Not called when the socket went away meanwhile.
   * The reading is the one everybody shares (`machine.refresh()`, asked only while `machine.stale()`): names that
   * are not known cannot have the system asked more often than its cache allows. Node has let go of an upgrade's
   * socket, error listener included, so one is kept on it for as long as it waits here: a connection reset in
   * that time would otherwise be an uncaught exception.
   */
  function ownHostAfterNames(req, socket, again) {
    if (typeof again !== 'function' || !namesDue(req)) return false;
    waited.add(req);
    const quiet = () => {};
    try { socket?.on?.('error', quiet); } catch { /* not a socket */ }
    const ask = () => {
      try { socket?.off?.('error', quiet); } catch { /* not a socket */ }
      if (!socket?.destroyed) again();
    };
    let read;
    try { read = Promise.resolve(machine.refresh()); } catch { read = Promise.resolve(); }
    read.catch(() => {}).then(ask);
    return true;
  }

  /** Does this Host (or forwarded Host) say the request came in under a public name: the tunnel's, the invite proxy's? */
  function underPublicName(written) {
    const name = hostNameOf(written);
    if (!name) return false;
    const address = name.startsWith('[') ? name.slice(1, -1) : (isIP(name) === 4 ? name : null);
    // This computer itself is nobody else's way in, whatever the invite address was set to: under loopback, one
    // of its own names or one of its own addresses the owner's requests arrive, as they always did. (What is
    // cheap to know is asked first: the public names are read from a file.)
    if (address ? isLoopbackAddress(address) : isAllowedHost(name, { allowedHosts: [], machineName: machine.names })) return false;
    if (!hostsOf(publicHosts).includes(name)) return false;
    if (!address) return true;
    let own = [];
    try { own = localAddresses() || []; } catch { own = []; }
    return !own.includes(name);
  }

  /**
   * Did this request come in from outside? Cloudflare's tunnel says so with a header; a request under a public
   * name (the Host it names, or the one a proxy says it was sent to) is from outside whatever it carries.
   * Reads headers only: a WebSocket upgrade is asked the same way.
   */
  function isRemote(req) {
    const headers = req?.headers || {};
    if (headers['cf-connecting-ip'] !== undefined) return true;
    if (underPublicName(headers.host)) return true;
    const forwarded = headers['x-forwarded-host'];
    return typeof forwarded === 'string' && forwarded.split(',').some((each) => underPublicName(each.trim()));
  }

  function remote(req, res, next) {
    if (!isRemote(req)) return next();
    for (const name of REMOTE_STRIPPED_HEADERS) delete req.headers[name];
    if (REMOTE_OPEN_PREFIXES.some((prefix) => req.path.startsWith(prefix))) return next();
    let session = false;
    try { session = !!hasInviteSession(req); } catch { session = false; }
    if (session) return next();
    return res.status(403).json({ error: 'Forbidden' });
  }

  /**
   * Did this request's connection come from another machine? Its socket's peer (the socket's own address, never a
   * header) is neither a loopback address nor one of this computer's own addresses; a request without one counts
   * as another machine's. Asked for two things only: the plain /mcp mount (mcpWithoutKey) and the tunnel's start
   * and stop (server.js). What else a machine on the network may do is the owner's decision, not this check's.
   * The tunnel, and a proxy on this computer, connect from loopback; a proxy on another machine is that machine.
   */
  function fromAnotherMachine(req) {
    const peer = req?.socket?.remoteAddress;
    if (isLoopbackAddress(peer)) return false;
    const name = peerName(peer);
    if (!name) return true;
    let own = [];
    try { own = localAddresses() || []; } catch { own = []; }
    return !own.includes(name);
  }

  /**
   * In front of the plain /mcp mount: from outside, and from another machine on the network, the endpoint is
   * reached with its key (/mcp/<key>) and no other way. While no key is set there is no way in from there at all:
   * the tunnel's or the invite proxy's address, or this computer's address on the network, by itself opens the
   * memory, the browser and every other tool to nobody. On this computer the plain endpoint answers as it always
   * did, key or no key. (The same answer with a key set and without: it does not say which.)
   */
  function mcpWithoutKey(req, res, next) {
    if (isRemote(req) || fromAnotherMachine(req)) return res.status(403).json({ error: 'Forbidden' });
    return next();
  }

  function adminOnly(req, res, next) {
    if (!isGuestRequest(req)) return next();
    const read = formsOf(req);
    if (!read) return res.status(400).json({ error: 'Unsupported path' });
    if (read.some((form) => ADMIN_ONLY_PREFIXES.some((prefix) => form.startsWith(prefix)))) {
      return res.status(403).json({ error: 'Admin only' });
    }
    return next();
  }

  function features(req, res, next) {
    if (!isGuestRequest(req)) return next();
    const read = formsOf(req);
    if (!read) return res.status(400).json({ error: 'Unsupported path' });
    // A guest's GET is free but for the few that are a feature's own (FEATURE_READ_PATHS); anything else a guest
    // sends under a feature needs that feature.
    const match = req.method === 'GET'
      ? FEATURE_READ_PATHS.find((entry) => read.some((form) => startsWithSegment(form, entry.path)))
      : FEATURE_PERMISSION_MAP.find((entry) => read.some((form) => form.startsWith(entry.prefix)));
    if (match && !permissions()?.[match.perm]) return res.status(403).json({ error: 'Feature not enabled' });
    // And a feature opened to guests that they only read: no change, whatever was opened.
    const reading = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
    if (!reading && GUEST_READ_ONLY_PREFIXES.some((prefix) => read.some((form) => startsWithSegment(form, prefix)))) {
      return sendGuardError(res, 403, 'GUEST_FORBIDDEN', 'Guests can read skills, not change them.');
    }
    return next();
  }

  // The names are read now, so the first request under the Bonjour name finds them known.
  try { Promise.resolve(machine.refresh()).catch(() => {}); } catch { /* a machine that cannot be asked adds no name */ }

  return { host, ownHost, ownHostAfterNames, remote, adminOnly, features, mcpWithoutKey, isRemote, fromAnotherMachine, refusedHosts: () => [...refused] };
}
