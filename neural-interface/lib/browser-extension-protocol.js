// Shared, dependency-free wire contract. Never send credentials or page content to a logger.
export const VERSION = 1;
export const MAX_MESSAGE = 4 * 1024 * 1024;
export const MAX_FILE = 50 * 1024 * 1024;
export const ID = /^[a-zA-Z0-9_-]{1,128}$/;
// How long the server waits for the answer to one command (COMMAND_WAIT). Every command carries what is left of that
// wait when it is sent (`deadline`, relative milliseconds, so the two clocks never have to agree; the HMAC protects it).
// The extension turns it into a local deadline the moment the message arrives, less a safety margin (localDeadline), and
// never starts or continues a command past it: queued, running, or as a content-script action already dispatched.
export const COMMAND_WAIT = 25000;
export const DEADLINE_MARGIN = 1000;
// The safety margin for a budget: 1 s, or a tenth of a shorter one.
export function reserve(deadline) { return Math.min(DEADLINE_MARGIN, Math.floor(deadline / 10)); }
// The local time (on `now`'s clock) at which a command received at `receivedAt` with `deadline` ms left must stop, one
// margin early, so the extension always stops before the server gives up. The worker's queue also never starts a command
// in the last margin before that (a command freed only by the one ahead of it reaching its own deadline gets no sliver).
export function localDeadline(receivedAt, deadline) { return receivedAt + deadline - reserve(deadline); }
// The watchdog for a browser call that never returns: once a command runs, the queue waits at most this long for it.
// It never gives a command more time than its deadline; the effective limit is the earlier of the two.
export const QUEUE_LIMIT = 30000;
// ── Long operations (1.4.0): running page JavaScript (`evaluate`) and a load-state wait (`wait` with `loadState`) ──
// They may take longer than COMMAND_WAIT, so they carry a longer deadline (up to LONG_WAIT) and never hold the worker's
// queue: the extension runs them beside the ordinary commands, each under its own deadline. The server waits
// commandWait(op, args) for one: the operation's own timeout plus LONG_MARGIN, never less than COMMAND_WAIT.
export const LONG_WAIT = 65000;
export const LONG_MARGIN = 5000;
// evaluate: the script's own timeout (args.timeout; default, most), the script source and its JSON arguments (characters),
// and the JSON text of its result (characters; a longer one is cut and flagged `truncated`).
export const EVALUATE_TIMEOUT = 30000;
export const EVALUATE_TIMEOUT_MAX = 60000;
export const EVALUATE_SCRIPT_MAX = 500000;
export const EVALUATE_PARAMS_MAX = 100000;
export const EVALUATE_RESULT_MAX = 1000000;
// 'MAIN' is the page's own JavaScript world (its globals are visible); 'USER_SCRIPT' is Chrome's separate world for
// user scripts (the DOM, none of the page's globals, exempt from the page's CSP).
export const EVALUATE_WORLDS = ['MAIN', 'USER_SCRIPT'];
// wait with loadState: 'load' (the tab finished loading), 'networkidle' (also no request of the tab in flight for
// NETWORK_IDLE_QUIET ms, as Playwright counts it) or, from READS_SINCE, 'domcontentloaded' (the document was parsed:
// its readyState is no longer 'loading'), within args.timeout (default, most).
export const LOAD_STATES = ['load', 'networkidle', 'domcontentloaded'];
export const NETWORK_IDLE_QUIET = 500;
export const NETWORK_IDLE_TIMEOUT = 15000;
export const NETWORK_IDLE_TIMEOUT_MAX = 60000;
export function longOp(op, args) { return op === 'evaluate' || op === 'wait' && args?.loadState !== undefined; }
// The operation's own time limit (ms), from args.timeout: its default when none is given, never above its most.
export function longBudget(op, args = {}) {
  const [normal, most] = op === 'evaluate' ? [EVALUATE_TIMEOUT, EVALUATE_TIMEOUT_MAX] : [NETWORK_IDLE_TIMEOUT, NETWORK_IDLE_TIMEOUT_MAX];
  return Math.max(1, Math.min(Number.isSafeInteger(args?.timeout) ? args.timeout : normal, most));
}
// How long the server waits for the answer to a command, and the most its `deadline` may say.
export function commandWait(op, args = {}) {
  return longOp(op, args) ? Math.max(COMMAND_WAIT, Math.min(LONG_WAIT, longBudget(op, args) + LONG_MARGIN)) : COMMAND_WAIT;
}
export function fail(code, message = code) { throw Object.assign(new Error(message), { code }); }
export function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) fail('INVALID_MESSAGE');
}
export function string(value, max = 128) { if (typeof value !== 'string' || value.length > max) fail('INVALID_MESSAGE'); return value; }
export function handle(value) { if (!ID.test(string(value))) fail('INVALID_MESSAGE'); return value; }
export function parse(raw, max = MAX_MESSAGE) {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > max) fail('MESSAGE_TOO_LARGE');
  try { return JSON.parse(raw); } catch { fail('INVALID_MESSAGE'); }
}
export function nonce() { return crypto.randomUUID().replaceAll('-', ''); }
const bytes = s => new TextEncoder().encode(s);
export async function mac(key, value) {
  const k = await crypto.subtle.importKey('raw', bytes(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', k, bytes(value))), b => b.toString(16).padStart(2, '0')).join('');
}
export async function equalMac(key, value, supplied) {
  if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied)) return false;
  const expected = await mac(key, value);
  let diff = 0; for (let i = 0; i < 64; i++) diff |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
  return diff === 0;
}
export async function pairingKey(code) { return mac(code.replaceAll('-', '').trim().toLowerCase(), 'synabun-extension-pair-v1'); }
export function channel(key, session, sendDirection) {
  let sent = 0, received = 0;
  return {
    // `deliver(raw)`, when given, runs synchronously right after signing; if it throws, the sequence number is not
    // used, so a message refused at the last moment (cancelled, timed out) never leaves a gap the peer would reject.
    async encode(payload, deliver) {
      const msg = { v: VERSION, session, direction: sendDirection, seq: sent + 1, payload };
      const signed = { ...msg, mac: await mac(key, JSON.stringify(msg)) };
      const raw = JSON.stringify(signed); parse(raw);
      if (signed.seq !== sent + 1) fail('REPLAY_REJECTED');
      deliver?.(raw); sent++; return raw;
    },
    async decode(raw) {
      const msg = parse(raw); object(msg, ['v', 'session', 'direction', 'seq', 'payload', 'mac']);
      if (msg.v !== VERSION || msg.session !== session || msg.direction === sendDirection || !['server', 'extension'].includes(msg.direction)
        || !Number.isSafeInteger(msg.seq) || msg.seq !== received + 1) fail('REPLAY_REJECTED');
      const { mac: signature, ...body } = msg;
      if (!await equalMac(key, JSON.stringify(body), signature)) fail('AUTH_FAILED');
      received = msg.seq; return msg.payload;
    },
  };
}
// Deliberately excludes local/private IP literals and single-label hosts, browser stores and control surfaces.
// Exact origins are approved; DNS rebinding is additionally blocked server-side at each command.
export function publicOrigin(url) {
  let u; try { u = new URL(string(url, 8192)); } catch { fail('SITE_NOT_APPROVED'); }
  const h = u.hostname.toLowerCase();
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || !h.includes('.') || h.includes(':')
    || /(^|\.)(localhost|local|internal|test|invalid)$/.test(h) || /^\d+(\.\d+){3}$/.test(h)
    || ['chromewebstore.google.com', 'chrome.google.com', 'microsoftedge.microsoft.com'].includes(h)) fail('SITE_NOT_APPROVED');
  return u.origin;
}
export function hostPattern(url) { const u = new URL(publicOrigin(url)); return `${u.protocol}//${u.hostname}/*`; }
// Pages no extension may script or capture, whatever its permissions (an API limit of Chrome and Edge, not a setting).
export const RESTRICTED_HOSTS = ['chromewebstore.google.com', 'chrome.google.com', 'microsoftedge.microsoft.com'];
// Full control: any http(s) page, or the blank start page. Returns the URL's origin ('about:blank' for that page).
// Everything else (chrome://, edge://, extension pages, file:, view-source:, the Web Store) is RESTRICTED_PAGE.
export function anyOrigin(url) {
  let u; try { u = new URL(string(url, 8192)); } catch { fail('RESTRICTED_PAGE'); }
  if (u.href === 'about:blank') return 'about:blank';
  if (!['https:', 'http:'].includes(u.protocol) || RESTRICTED_HOSTS.includes(u.hostname.toLowerCase())) fail('RESTRICTED_PAGE');
  return u.origin;
}
const bare = h => String(h || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
// A host name that is this computer by its form alone: localhost (and *.localhost), a loopback or unspecified address,
// or one of `selfHosts` (the server's names and interface addresses, sent with every command). The server also asks DNS.
export function localHost(hostname, selfHosts = []) {
  const h = bare(hostname);
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || h === '::' || h === '::1') return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(h) || /^::ffff:(127\.|0\.0\.0\.0$)/.test(h) || /^::ffff:7f[0-9a-f]{2}:/.test(h) || h === '::ffff:0:0') return true;
  return selfHosts.some(x => bare(x) === h);
}
// The port a URL reaches (its default when it names none).
export function portOf(u) { return Number(u.port || (u.protocol === 'https:' ? 443 : u.protocol === 'http:' ? 80 : 0)); }
// SynaBun's own interface and API (its ports on this computer) and its public aliases (the tunnel, the invite proxy:
// `blockedHosts`, any port) stay behind SynaBun's owner rules: an agent never reaches them through the owner's browser.
export function controlSurface(url, { blockedHosts = [], blockedPorts = [], selfHosts = [] } = {}) {
  if (!url || url === 'about:blank') return false;
  let u; try { u = new URL(url); } catch { return false; }
  if (!['https:', 'http:'].includes(u.protocol)) return false;
  const host = bare(u.hostname);
  if (blockedHosts.some(x => bare(x) === host)) return true;
  return blockedPorts.includes(portOf(u)) && localHost(host, selfHosts);
}
// How many tabs an inventory lists (the ones agents control first; in full control the owner's other tabs after).
export const MAX_TABS = 200;
// `versions[i]` is the approval version of `sites[i]`: raised only by the owner's gesture in the popup, so the server can
// tell a fresh approval of a site it revoked from an inventory that predates the revocation.
export function inventory(value) {
  object(value, ['tabs', 'sites', 'versions', 'allowNewTabs', 'uploads', 'downloads', 'fullControl', 'modeVersion']);
  if (!Array.isArray(value.tabs) || value.tabs.length > MAX_TABS || !Array.isArray(value.sites) || value.sites.length > 100) fail('INVALID_MESSAGE');
  for (const key of ['allowNewTabs', 'uploads', 'downloads']) if (typeof value[key] !== 'boolean') fail('INVALID_MESSAGE');
  // The mode (full control or restricted) and its version. Optional, so an extension from before full control still
  // connects (it is then treated as restricted, which is what it enforces); the two come together.
  if ((value.fullControl === undefined) !== (value.modeVersion === undefined)) fail('INVALID_MESSAGE');
  if (value.fullControl !== undefined && (typeof value.fullControl !== 'boolean' || !Number.isSafeInteger(value.modeVersion) || value.modeVersion < 0)) fail('INVALID_MESSAGE');
  for (const site of value.sites) if (publicOrigin(site) !== site) fail('INVALID_MESSAGE');
  if (value.versions !== undefined && (!Array.isArray(value.versions) || value.versions.length !== value.sites.length
    || value.versions.some(v => !Number.isSafeInteger(v) || v < 0))) fail('INVALID_MESSAGE');
  const seen = new Set();
  for (const t of value.tabs) {
    object(t, ['handle', 'url', 'owner', 'created', 'title']); handle(t.handle); string(t.url, 8192);
    if (t.title !== undefined) string(t.title, 300);
    if (t.owner !== null) handle(t.owner);
    if (typeof t.created !== 'boolean' || seen.has(t.handle)) fail('INVALID_MESSAGE');
    seen.add(t.handle);
  }
  return value;
}
export const COMMANDS = ['create', 'claim', 'release', 'navigate', 'back', 'forward', 'reload', 'snapshot', 'click', 'hover', 'fill', 'type', 'press', 'select', 'scroll', 'wait', 'content', 'screenshot', 'upload', 'download', 'evaluate', 'read', 'revokeTab', 'revokeSite', 'disconnect', 'revoke', 'mode', 'reset', 'selfReload'];
// The first extension version that knows `evaluate` and `wait` with `loadState`. An older one ends the connection on a
// command it does not know, so the server never sends it one (it answers EXTENSION_RELOAD_REQUIRED itself).
export const LONG_OPS_SINCE = '1.4.0';
// The first extension version that reloads itself on the owner's one click (Settings → Update now).
export const SELF_RELOAD_SINCE = '1.5.0';
// ── Readers (1.5.0): fixed, read-only page functions shipped in the extension ──
// `read` runs one of READER_IDS in the agent's tab through chrome.scripting.executeScript({ func }) in the isolated
// world: no page JavaScript, no "Allow User Scripts", no debugger. A reader is named by its id and nothing else; its
// arguments are plain data (a CSS selector for the page readers, a scroll step for the paged extractors), never code.
// The functions are browser-extension/readers.js and readers-generated.js (generated from the extractors the MCP
// server sends the Playwright backend: scripts/extension/build-browser-readers.mjs). An id not on this list is
// INVALID_MESSAGE on both sides. `snapshot` with `offset` and `wait` with loadState 'domcontentloaded' came with it.
export const READS_SINCE = '1.5.0';
export const READER_IDS = Object.freeze([
  // The page itself: its text (innerText), its main content as cleaned HTML (the server turns it into Markdown), its address.
  'page.text', 'page.html', 'page.url',
  // Paged extractors: one read of what the page shows, and a scroll of the feed between reads.
  'x.tweets', 'fb.posts', 'fb.groups', 'tiktok.feed', 'tiktok.search', 'tiktok.studio', 'wa.chats', 'wa.messages',
  'ig.feed', 'ig.reels', 'ig.search', 'li.feed', 'li.notifications', 'li.search_people', 'li.jobs',
  // One-shot readers.
  'tiktok.profile', 'tiktok.account', 'ig.profile', 'ig.post', 'li.profile', 'li.post', 'li.messages', 'li.network', 'fb.composer_state',
  'youtube.channel_id', 'youtube.channel_ready', 'youtube.channel_name', 'youtube.videos',
]);
// The readers that take a scroll step (their feed scrolls between reads); every other one only reads.
export const PAGED_READERS = Object.freeze(['x.tweets', 'fb.posts', 'fb.groups', 'tiktok.feed', 'tiktok.search', 'tiktok.studio', 'wa.chats', 'wa.messages',
  'ig.feed', 'ig.reels', 'ig.search', 'li.feed', 'li.notifications', 'li.search_people', 'li.jobs']);
export const READ_STEPS = ['read', 'scroll'];
// The most text a page reader answers with (characters): the server pages it (maxChars / offset) as it does a
// Playwright page's.
export const READ_TEXT_MAX = 1000000;
// The extension version an operation needs (null: any paired one). The server answers EXTENSION_RELOAD_REQUIRED itself
// for an older peer, which would otherwise end the connection on the command or argument it does not know.
export function requiredVersion(op, args = {}) {
  if (op === 'read' || op === 'wait' && args?.loadState === 'domcontentloaded' || op === 'snapshot' && args?.offset !== undefined) return READS_SINCE;
  if (longOp(op, args)) return LONG_OPS_SINCE;
  return null;
}
// ── Uploads: the type of a file, from its name ──
// A file input and the site behind it read a File's `type` (TikTok Studio refuses a video whose type is not a video
// one). The extension gives every file it assigns the type this fixed table names for its extension, whatever the
// transport said; an extension the table does not know is application/octet-stream.
export const UPLOAD_TYPES = Object.freeze({
  mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  mpeg: 'video/mpeg', mpg: 'video/mpeg', '3gp': 'video/3gpp',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', heic: 'image/heic',
  heif: 'image/heif', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus', flac: 'audio/flac',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', html: 'text/html', htm: 'text/html',
  json: 'application/json', xml: 'application/xml', zip: 'application/zip', srt: 'application/x-subrip', vtt: 'text/vtt',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
});
// The extension of a file name as Node's path.extname reads it: after the last dot of the last path segment, never a
// leading dot ('.mp4' has none).
export function uploadType(name) {
  const base = String(name || '').split(/[\\/]/).pop(), dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  return Object.hasOwn(UPLOAD_TYPES, ext) ? UPLOAD_TYPES[ext] : 'application/octet-stream';
}
// What the browser itself said when it refused an operation (a Chrome API's error message), carried inside the
// answer's `error` text after the code's own sentence: `… The browser said: "No current window".` Never a page's
// content: only messages of chrome.* calls are put there, on one line, cut to DETAIL_MAX characters.
export const DETAIL_MAX = 300;
export function cleanDetail(value) {
  const text = String(value?.message ?? value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/"/g, "'").trim();
  return text.slice(0, DETAIL_MAX);
}
export function errorDetail(result) {
  const match = /The browser said: "([^"]*)"\.$/.exec(typeof result?.error === 'string' ? result.error : '');
  return match ? match[1] : '';
}
export const HISTORY = ['back', 'forward'];
// The owner's control messages: revocations, the mode (full control or restricted) and `reset` (a restarted server
// hands back every tab agents of its previous process held). They overtake queued commands on both sides, are never
// cancelled themselves, and carry the owner's name only: nothing an agent sends can be one.
export const CONTROL = ['revokeTab', 'revokeSite', 'disconnect', 'revoke', 'mode', 'reset', 'selfReload'];
export function command(value) {
  object(value, ['type', 'id', 'op', 'tab', 'owner', 'args', 'blockedHosts', 'blockedPorts', 'selfHosts', 'deadline']);
  if (value.type !== 'command' || !COMMANDS.includes(value.op)) fail('UNSUPPORTED_IN_EXTENSION_MODE');
  handle(value.id); if (value.tab !== null) handle(value.tab); handle(value.owner);
  // Required on every command: whole milliseconds, 1 to COMMAND_WAIT (the server never has more left than its wait).
  // A long operation's may reach commandWait(op, args): checked below, once its arguments are known to be an object.
  if (!Number.isSafeInteger(value.deadline) || value.deadline < 1 || value.deadline > LONG_WAIT) fail('INVALID_MESSAGE');
  // SynaBun's own addresses, which no command may reach (controlSurface): its public aliases (any port), its ports,
  // and this computer's names and interface addresses.
  for (const key of ['blockedHosts', 'selfHosts']) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].length > 200 || value[key].some(h => typeof h !== 'string' || h.length > 253 || !/^[a-zA-Z0-9.:%-]+$/.test(h)))) fail('INVALID_MESSAGE');
  }
  if (value.blockedPorts !== undefined && (!Array.isArray(value.blockedPorts) || value.blockedPorts.length > 32 || value.blockedPorts.some(p => !Number.isSafeInteger(p) || p < 1 || p > 65535))) fail('INVALID_MESSAGE');
  if (value.op === 'selfReload') {
    if (value.owner !== 'owner' || value.tab !== null) fail('NOT_OWNED');
    object(value.args, ['allowBusy']);
    if (typeof value.args.allowBusy !== 'boolean' || value.deadline > COMMAND_WAIT) fail('INVALID_MESSAGE');
    return value;
  }
  const a = value.args; object(a, ['url', 'ref', 'selector', 'nthMatch', 'value', 'text', 'key', 'direction', 'distance', 'maxChars', 'offset', 'timeout', 'state', 'files', 'site', 'fullControl', 'version',
    'expression', 'body', 'params', 'world', 'frame', 'loadState', 'reader', 'step']);
  if (value.deadline > commandWait(value.op, a)) fail('INVALID_MESSAGE');
  for (const [k, v] of Object.entries(a)) {
    if (k === 'fullControl') { if (typeof v !== 'boolean') fail('INVALID_MESSAGE'); }
    else if (k === 'version') { if (!Number.isSafeInteger(v) || v < 0) fail('INVALID_MESSAGE'); }
    // A frame of the tab, by Chrome's frame id (0, the default, is the top document).
    else if (k === 'frame') { if (!Number.isSafeInteger(v) || v < 0 || v > 2147483647) fail('INVALID_MESSAGE'); }
    else if (k === 'expression' || k === 'body') string(v, EVALUATE_SCRIPT_MAX);
    else if (k === 'params') string(v, EVALUATE_PARAMS_MAX);
    // A reader is one id of a closed list, never anything that names or carries code.
    else if (k === 'reader') { if (typeof v !== 'string' || !READER_IDS.includes(v)) fail('INVALID_MESSAGE'); }
    else if (k === 'step') { if (!READ_STEPS.includes(v)) fail('INVALID_MESSAGE'); }
    else if (['nthMatch', 'distance', 'maxChars', 'offset', 'timeout'].includes(k)) {
      if (!Number.isSafeInteger(v) || v < 0 || v > 1000000) fail('INVALID_MESSAGE');
    } else if (k === 'files') {
      if (!Array.isArray(v) || v.length < 1 || v.length > 4) fail('INVALID_MESSAGE');
      if (value.op !== 'upload') fail('INVALID_MESSAGE');
      for (const name of v) {
        string(name, 255);
        if (!name || /[\\/]/.test(name)) fail('INVALID_MESSAGE');
      }
    } else string(v, k === 'text' || k === 'value' ? 100000 : 8192);
  }
  const required = { navigate: 'url', download: 'url', revokeSite: 'site', fill: 'value', type: 'text', select: 'value', press: 'key' }[value.op];
  if (required && typeof a[required] !== 'string') fail('INVALID_MESSAGE');
  // The mode travels only as the owner's `mode` message, with its version.
  if (value.op === 'mode' && (typeof a.fullControl !== 'boolean' || a.version === undefined || value.owner !== 'owner')) fail('INVALID_MESSAGE');
  if ((a.fullControl !== undefined || a.version !== undefined) && value.op !== 'mode') fail('INVALID_MESSAGE');
  if (['click', 'hover', 'fill', 'select', 'upload'].includes(value.op) && !a.ref && !a.selector) fail('INVALID_MESSAGE');
  if (value.op === 'upload' && !a.files) fail('INVALID_MESSAGE');
  // History traversal names no destination: it carries a tab and nothing else.
  if (HISTORY.includes(value.op) && (value.tab === null || Object.keys(a).length)) fail('INVALID_MESSAGE');
  if (a.direction !== undefined && !['up', 'down', 'left', 'right'].includes(a.direction)) fail('INVALID_MESSAGE');
  if (a.state !== undefined && !['visible', 'hidden', 'attached', 'detached'].includes(a.state)) fail('INVALID_MESSAGE');
  // evaluate: exactly one of `expression` (one JavaScript expression; a function it evaluates to is called with the
  // arguments) and `body` (the body of an async function whose parameter `args` is the array of arguments), with
  // `params` (the arguments: the JSON text of an array), `world`, `frame`, `timeout` and `maxChars`, and nothing else.
  const evaluate = ['expression', 'body', 'params', 'world', 'frame'];
  if (value.op === 'evaluate') {
    if (value.tab === null || (typeof a.expression === 'string') === (typeof a.body === 'string') || !(a.expression ?? a.body).trim()) fail('INVALID_MESSAGE');
    if (Object.keys(a).some(k => !evaluate.includes(k) && k !== 'timeout' && k !== 'maxChars')) fail('INVALID_MESSAGE');
    if (a.world !== undefined && !EVALUATE_WORLDS.includes(a.world)) fail('INVALID_MESSAGE');
    if (a.params !== undefined) {
      let list; try { list = JSON.parse(a.params); } catch { list = null; }
      if (!Array.isArray(list)) fail('INVALID_MESSAGE');
    }
  } else if (evaluate.some(k => a[k] !== undefined)) fail('INVALID_MESSAGE');
  // read: a reader of the agent's tab (`reader`), a page reader's scope (`selector`), a paged extractor's scroll
  // (`step` 'scroll' with `distance` and `direction`), and nothing else.
  if (value.op === 'read') {
    if (value.tab === null || typeof a.reader !== 'string') fail('INVALID_MESSAGE');
    if (Object.keys(a).some(k => !['reader', 'step', 'selector', 'distance', 'direction'].includes(k))) fail('INVALID_MESSAGE');
    if (a.step === 'scroll' ? a.selector !== undefined || !PAGED_READERS.includes(a.reader) : a.distance !== undefined || a.direction !== undefined) fail('INVALID_MESSAGE');
    if (a.selector !== undefined && !['page.text', 'page.html'].includes(a.reader)) fail('INVALID_MESSAGE');
  } else if (a.reader !== undefined || a.step !== undefined) fail('INVALID_MESSAGE');
  // A load-state wait names the state and, at most, its timeout: it waits for the tab, not for an element.
  if (a.loadState !== undefined && (value.op !== 'wait' || value.tab === null || !LOAD_STATES.includes(a.loadState)
    || Object.keys(a).some(k => k !== 'loadState' && k !== 'timeout'))) fail('INVALID_MESSAGE');
  return value;
}
// ── Capabilities (1.6.0): what this browser lets the extension do, as the extension saw it ──
// `{ type: 'capabilities', capabilities: { v, userScripts: { state, execute }, browser: { brands, major, platform } } }`,
// from the extension only, on the authenticated channel: after its first inventory of a connection and after every
// pong. It is an observation, never an action: the extension asks the user scripts API for its registered scripts
// (getScripts) and looks whether `execute` exists, and runs nothing in any tab to learn it. `state`: 'ready' (Allow User Scripts on, `execute` there),
// 'disabled' (the API is missing or refuses: the switch, before Chrome 138 Developer mode, is off), 'unsupported' (on,
// but the browser predates userScripts.execute, Chrome 135), 'error' (the check itself failed). `brands` are the
// browser's names from navigator.userAgentData without its GREASE entries, `major` its Chromium version, `platform`
// the operating system it names; any of them may be unknown ([] or null).
// The server never sends this type: an extension from before 1.6.0 ends the connection on a type it does not know, so
// a fresh observation is asked for with an ordinary ping.
export const CAPABILITIES_SINCE = '1.6.0';
export const CAPABILITIES_VERSION = 1;
export const USER_SCRIPT_STATES = Object.freeze(['ready', 'disabled', 'unsupported', 'error']);
export const BROWSER_BRANDS_MAX = 6;
export const BROWSER_NAME = /^[A-Za-z0-9 ._()-]{1,40}$/;
export const PLATFORM_NAME = /^[A-Za-z0-9 ._()-]{1,16}$/;
export function capabilityReport(value) {
  object(value, ['v', 'userScripts', 'browser']);
  if (value.v !== CAPABILITIES_VERSION) fail('INVALID_MESSAGE');
  object(value.userScripts, ['state', 'execute']);
  if (!USER_SCRIPT_STATES.includes(value.userScripts.state) || typeof value.userScripts.execute !== 'boolean') fail('INVALID_MESSAGE');
  const b = value.browser; object(b, ['brands', 'major', 'platform']);
  if (!Array.isArray(b.brands) || b.brands.length > BROWSER_BRANDS_MAX || b.brands.some(name => typeof name !== 'string' || !BROWSER_NAME.test(name))) fail('INVALID_MESSAGE');
  if (b.major !== null && (!Number.isSafeInteger(b.major) || b.major < 1 || b.major > 999)) fail('INVALID_MESSAGE');
  if (b.platform !== null && (typeof b.platform !== 'string' || !PLATFORM_NAME.test(b.platform))) fail('INVALID_MESSAGE');
  return value;
}
export function payload(value) {
  if (value?.type === 'updateStatus') {
    object(value, ['type', 'version', 'runsActive']);
    if (typeof value.runsActive !== 'boolean' || (value.version !== null && !/^\d{1,5}(\.\d{1,5}){0,3}$/.test(string(value.version, 23)))) fail('INVALID_MESSAGE');
  } else if (value?.type === 'state') { object(value, ['type', 'inventory']); inventory(value.inventory); }
  else if (value?.type === 'result') {
    object(value, ['type', 'id', 'result', 'inventory']); handle(value.id); inventory(value.inventory);
    // evaluate adds `value` (the JSON text of the script's result), `truncated` with `valueLength` (the result was
    // longer than its cap: `value` is then the beginning of that JSON text, not valid JSON) and, with code PAGE_ERROR,
    // `errorMessage` and `errorStack` (what the page's script threw). A load-state wait adds `loadState`.
    // read (1.5.0) adds `loading` (a paged extractor's feed showed a loading marker); a snapshot asked with an `offset`
    // adds `snapshotTotal` (characters of the whole snapshot) and `snapshotNext` (the offset of what did not fit).
    object(value.result, ['ok', 'code', 'error', 'url', 'title', 'snapshotText', 'mode', 'snapshotId', 'content', 'text', 'base64', 'mimeType', 'tab', 'downloadId', 'files',
      'value', 'truncated', 'valueLength', 'errorMessage', 'errorStack', 'loadState', 'loading', 'snapshotTotal', 'snapshotNext']);
    if (typeof value.result.ok !== 'boolean') fail('INVALID_MESSAGE');
    for (const [k, v] of Object.entries(value.result)) {
      if (k === 'ok') continue;
      if (k === 'files') {
        if (!Array.isArray(v) || !v.length || v.length > 4) fail('INVALID_MESSAGE');
        let total = 0;
        for (const file of v) {
          object(file, ['name', 'type', 'size']);
          if (!string(file.name, 255) || /[\\/]/.test(file.name) || !string(file.type, 255)) fail('INVALID_MESSAGE');
          if (!Number.isSafeInteger(file.size) || file.size < 0) fail('INVALID_MESSAGE');
          total += file.size;
        }
        if (total > MAX_FILE) fail('INVALID_MESSAGE');
      } else if (k === 'downloadId') { if (!Number.isSafeInteger(v)) fail('INVALID_MESSAGE'); }
      else if (['valueLength', 'snapshotTotal', 'snapshotNext'].includes(k)) { if (!Number.isSafeInteger(v) || v < 0) fail('INVALID_MESSAGE'); }
      else if (k === 'truncated' || k === 'loading') { if (typeof v !== 'boolean') fail('INVALID_MESSAGE'); }
      else string(v, k === 'base64' ? MAX_MESSAGE - 4096 : ['content', 'text', 'snapshotText', 'value'].includes(k) ? EVALUATE_RESULT_MAX : 8192);
    }
  } else if (value?.type === 'capabilities') { object(value, ['type', 'capabilities']); capabilityReport(value.capabilities); }
  else if (value?.type === 'ping' || value?.type === 'pong' || value?.type === 'unpair') object(value, ['type']);
  // The server gave up on a command (its wait ended): the extension stops it, queued or running, and never starts it.
  else if (value?.type === 'cancel') { object(value, ['type', 'id']); handle(value.id); }
  else command(value);
  return value;
}
export const ERROR_TEXT = Object.freeze({
  RELOAD_BUSY: 'Automation is active. Wait for it to finish or confirm the reload.',
  EXTENSION_NOT_CONNECTED: 'The browser extension is not connected. Open its popup and reconnect (after a SynaBun restart it reconnects by itself).',
  NOT_CONNECTED: 'The extension disconnected. Reconnect from its popup.',
  AUTH_FAILED: 'Authentication failed. Revoke pairing and pair again on both sides.',
  PAIRING_EXPIRED: 'Start a new pairing window in SynaBun Browser settings.',
  INVALID_MESSAGE: 'Invalid extension bridge message.', MESSAGE_TOO_LARGE: 'Extension bridge message exceeds its size limit.',
  REPLAY_REJECTED: 'Stale or replayed extension message rejected.',
  SITE_NOT_APPROVED: 'The owner chose "Only sites and tabs I share": this public HTTP(S) site must be shared in the extension popup first.',
  TAB_NOT_APPROVED: 'The tab changed, or an approval was withdrawn, while this command ran. Nothing more was done; observe the tab before retrying.',
  NOT_OWNED: 'This tab belongs to another agent.',
  RESTRICTED_PAGE: 'This is a browser page no extension can read or control (chrome://, edge://, extension pages, local files, the Web Store). Navigate the tab to an http(s) site.',
  SYNABUN_PAGE_BLOCKED: 'This address is SynaBun’s own interface or API. Agents cannot reach it through the owner’s browser unless the owner lets the automation browser act as owner (Settings → Browser).',
  TAB_CLOSED: 'The tab closed, or the owner took it back. Create a new session, or take over another tab (browser_session list).',
  NO_HISTORY_ENTRY: 'There is no page to go back or forward to in this tab. Nothing was done.',
  STALE_REF: 'This element reference is stale. Take a fresh snapshot; no action was performed.',
  UNSUPPORTED_IN_EXTENSION_MODE: 'This operation is unavailable with the extension backend. See docs/browser-extension-bridge.md.',
  ACTIVE_TAB_REQUIRED: 'The extension captures screenshots with chrome.tabs.captureVisibleTab, which draws only the tab a window is showing (no debugger is attached, so a tab in the background cannot be drawn), and the tab was not, or stopped being, the one shown while capturing. In full control the extension brings the agent’s own tab to the front of its window for the capture: retry. In restricted mode it never does: the owner activates the tab, or switches the extension to full control. To read the page instead, use browser_snapshot or browser_content.',
  TAB_LIMIT: 'This bridge already controls 200 tabs. Close an agent tab before opening another.',
  TAB_BUSY: 'Chrome is editing tabs (for example during a drag). Retry navigation after the tab strip settles.',
  NAVIGATION_FAILED: 'Chrome refused tabs.update for this navigation. Check the browser site-access policy and destination, then retry.',
  NAVIGATION_NOT_COMMITTED: 'The navigation did not commit before its deadline: the tab still shows its previous page (the site may still be loading, or the browser dropped the navigation). Nothing was reported as navigated; take a snapshot, then navigate again.',
  SCREENSHOT_PATH_REFUSED: 'The screenshot path is outside the allowed output locations or is protected.',
  NO_MATCH: 'No element matches the target.', AMBIGUOUS_TARGET: 'The selector must match one element or specify nthMatch.',
  UPLOAD_RELOAD_REQUIRED: 'Reload the updated SynaBun Browser Bridge extension to upload files.',
  UPLOAD_FILE_MISSING: 'File not found in the extension upload folder.',
  UPLOAD_TOO_LARGE: 'The selected files exceed the 50 MB total upload limit.',
  UPLOAD_FILE_REFUSED: 'Choose readable regular files inside the extension upload folder shown in Settings → Browser.',
  UPLOAD_MULTIPLE: 'This file input accepts only one file.',
  UPLOAD_DISABLED: 'The file input is disabled.',
  UPLOAD_ACCEPT_MISMATCH: 'The file input’s accept filter excludes one or more selected files. Check the accepted MIME types or filename extensions.',
  UPLOAD_ASSIGNMENT_FAILED: 'The file input did not receive the expected names, types and sizes.',
  UPLOAD_METADATA_UNAVAILABLE: 'Restart SynaBun and reload SynaBun Browser Bridge to enable file metadata.',
  PERMISSION_REQUIRED: 'Enable this feature in the extension popup first (downloads; in restricted mode also agent-created tabs).', OPERATION_FAILED: 'The browser refused this operation.',
  TIMEOUT: 'The operation timed out. Its outcome may be uncertain; observe before retrying.',
  CANCELLED: 'An approval was revoked or the connection ended while this command was pending. It was stopped before its next browser action; one already under way may have happened, so observe before retrying.',
  USER_SCRIPTS_DISABLED: 'Running page JavaScript is switched off for the SynaBun extension in this browser. The owner switches it on once: open chrome://extensions (edge://extensions in Edge), choose Details on "SynaBun Browser Bridge", turn on "Allow User Scripts" (Chrome or Edge 138 and later; on an older version turn on Developer mode at the top of that page instead), then press Reload on the extension. Nothing was run.',
  USER_SCRIPTS_UNSUPPORTED: 'This browser cannot run page JavaScript for an extension (chrome.userScripts.execute needs Chrome or Edge 135 or later). Update the browser. Nothing was run.',
  EXTENSION_RELOAD_REQUIRED: 'The paired browser still runs an older SynaBun Browser Bridge than this operation needs. The owner reloads it on the browser’s extensions page (chrome://extensions → SynaBun Browser Bridge → Reload). Nothing was done.',
  PAGE_ERROR: 'The page’s script threw, or did not compile (evaluate takes one expression: wrap statements in a function, (() => { …; return value; })()). errorMessage and errorStack say what the page reported; the bridge itself did not fail.',
  BLANK_PAGE: 'The tab shows the blank start page, where no script can run. Navigate it to an http(s) page first.',
  FRAME_NOT_FOUND: 'The tab has no frame with this id that a script can run in (frame 0 is the top document). Nothing was run.',
  READER_FAILED: 'The extension’s reader found nothing it could read on this page (the page changed under it, or is not the page this reader is for). Nothing was changed on the page; observe the tab, then retry.',
  INVALID_SELECTOR: 'The selector is not a valid CSS selector. Nothing was read.',
  SCROLL_TARGET_MISSING: 'The feed this extractor scrolls is not on the page (scroll container not found). Items read so far are kept.',
  NETWORK_IDLE_UNAVAILABLE:'The extension cannot watch this browser’s network requests (its webRequest permission is not in effect). The owner reloads SynaBun Browser Bridge on the browser’s extensions page; until then wait for a selector or a fixed time instead.',
});
// `error.detail`: what the browser said (cleanDetail), appended to the code's own sentence (errorDetail reads it back).
export function safeError(error) {
  const code = Object.hasOwn(ERROR_TEXT, error?.code) ? error.code : 'OPERATION_FAILED';
  const detail = cleanDetail(error?.detail);
  return { ok: false, code, error: `${code}: ${ERROR_TEXT[code]}${detail ? ` The browser said: "${detail}".` : ''}` };
}
