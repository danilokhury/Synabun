// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — environment decisions (no DOM)
// MCP server rows, the update notice, what a model row adds to its name, the
// model a session should start on.
// ─────────────────────────────────────────────────────────────────────────────

const MCP_VIEW = {
  connected: { label: 'connected', tone: 'ok', action: 'disconnect', actionLabel: 'Disconnect' },
  disabled: { label: 'disabled', tone: 'muted', action: 'connect', actionLabel: 'Connect' },
  failed: { label: 'failed', tone: 'error', action: 'connect', actionLabel: 'Retry' },
  needs_auth: { label: 'needs sign-in', tone: 'warn', action: 'authenticate', actionLabel: 'Sign in' },
  needs_client_registration: { label: 'needs client registration', tone: 'warn', action: null, actionLabel: '' },
};

/** One MCP server as the popover shows it. A managed server (SynaBun) has no action. */
export function mcpRowView(row) {
  const view = MCP_VIEW[row?.status] || MCP_VIEW.failed;
  const managed = row?.managed === true;
  return {
    name: String(row?.name || ''),
    label: view.label,
    tone: view.tone,
    action: managed ? null : view.action,
    actionLabel: managed ? '' : view.actionLabel,
    note: managed ? 'managed by SynaBun' : (typeof row?.error === 'string' ? row.error : ''),
  };
}

// ── Adding an MCP server ────────────────────────────────────────────────────
// One request (mcp:add) registers the server on the serve that runs this
// session, which proves it starts, and then writes the same config to the
// OpenCode config file so later sessions start with it. The write starts
// nothing: the server runs once, where it was registered. A command-based
// server is a program on this machine, so the user confirms the exact command
// and arguments first. SynaBun's own entry is pinned by the runtime and can be
// neither added nor replaced from here; the server refuses it too.

export const MANAGED_MCP_NAMES = Object.freeze(['SynaBun']);
const MCP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** May a server be added under `name`? `rows` are the servers already listed. */
export function mcpNameVerdict(name, rows = []) {
  const value = String(name || '').trim();
  if (!value) return { ok: false, error: 'Give the server a name.' };
  if (MANAGED_MCP_NAMES.some((managed) => managed.toLowerCase() === value.toLowerCase())) {
    return { ok: false, error: `${value} is managed by SynaBun and cannot be changed from the panel.` };
  }
  if (!MCP_NAME_RE.test(value)) return { ok: false, error: 'A server name may use letters, digits, ".", "_" and "-".' };
  if ((Array.isArray(rows) ? rows : []).some((row) => row?.name === value)) {
    return { ok: false, error: `A server called ${value} is already listed.` };
  }
  return { ok: true, name: value };
}

/** A command line as words: quotes group, a backslash keeps the next character. */
export function splitCommandLine(text) {
  const words = [];
  let word = '';
  let quote = '';
  let started = false;
  const value = String(text || '');
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (ch === quote) quote = '';
      else if (ch === '\\' && quote === '"' && i + 1 < value.length) word += value[++i];
      else word += ch;
    } else if (ch === '"' || ch === "'") { quote = ch; started = true; }
    else if (ch === '\\' && i + 1 < value.length) { word += value[++i]; started = true; }
    else if (/\s/.test(ch)) { if (started || word) { words.push(word); word = ''; started = false; } }
    else { word += ch; started = true; }
  }
  if (quote) return null;                       // an unclosed quote
  if (started || word) words.push(word);
  return words;
}

/**
 * What the user typed as a server: an `http(s)://` URL is a remote server,
 * anything else a command line, where leading `KEY=value` words are its
 * environment. Resolves `{ ok, config }` with `{ url }` or
 * `{ command, args, env? }`, the shape both mcp:add and the config writer take.
 */
export function parseMcpServerInput(text) {
  const value = String(text || '').trim();
  if (!value) return { ok: false, error: 'Enter a command or a URL.' };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url;
    try { url = new URL(value); } catch { return { ok: false, error: 'That is not a valid URL.' }; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: 'An MCP server URL must be http or https.' };
    return { ok: true, config: { url: url.toString() } };
  }
  const words = splitCommandLine(value);
  if (!words) return { ok: false, error: 'A quote is not closed.' };
  const env = {};
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
    const word = words.shift();
    const eq = word.indexOf('=');
    env[word.slice(0, eq)] = word.slice(eq + 1);
  }
  if (!words.length || !words[0]) return { ok: false, error: 'Enter the command that starts the server.' };
  const config = { command: words[0], args: words.slice(1) };
  if (Object.keys(env).length) config.env = env;
  return { ok: true, config };
}

const shown = (value) => JSON.stringify(String(value));

/**
 * The confirm text for starting a command-based server: the program and every
 * argument exactly as they will be passed (quoted, so an empty argument or a
 * space is visible), the names of the environment variables, and where it is
 * saved. '' for a remote (URL) server: nothing is started on this machine.
 */
export function mcpStartConfirmText(name, config, { persist = true } = {}) {
  if (!config || typeof config.command !== 'string') return '';
  const args = Array.isArray(config.args) ? config.args : [];
  const env = config.env && typeof config.env === 'object' ? Object.keys(config.env) : [];
  return [
    `Start the MCP server "${name}"?`,
    '',
    'This runs a program on this computer, with your user\'s permissions:',
    '',
    `Command: ${shown(config.command)}`,
    args.length ? `Arguments (${args.length}):` : 'Arguments: none',
    ...args.map((arg, index) => `  ${index + 1}. ${shown(arg)}`),
    ...(env.length ? [`Environment variables set: ${env.join(', ')}`] : []),
    '',
    persist
      ? 'It starts now on this session\'s OpenCode runtime and is saved to the OpenCode config, so later sessions start it too.'
      : 'It starts now on this session\'s OpenCode runtime. It is not saved: restart SynaBun to save servers from the panel.',
  ].join('\n');
}

/**
 * Add a server.
 *   confirm(text)                      shown before a command-based server is
 *                                      started; must resolve true (see
 *                                      mcpStartConfirmText). Without it such a
 *                                      server is not started at all
 *   register({ name, config, persist }) mcp:add → the reply: `data` are the
 *                                      server rows, `saved` says whether the
 *                                      config was written (`saveError` why not)
 *   canPersist                         the server saves on mcp:add
 *                                      (feature:mcp-add-persist)
 * Resolves `{ ok, error?, cancelled?, rows?, saved, note }`. A server that does
 * not start is not saved: a typo should not end up in the config.
 */
export async function addMcpServer({ name, input, rows = [], confirm, register, canPersist = true }) {
  const named = mcpNameVerdict(name, rows);
  if (!named.ok) return { ok: false, error: named.error, saved: false };
  const parsed = parseMcpServerInput(input);
  if (!parsed.ok) return { ok: false, error: parsed.error, saved: false };
  if (typeof register !== 'function') return { ok: false, error: 'This server cannot add MCP servers.', saved: false };

  const persist = !!canPersist;
  const confirmText = mcpStartConfirmText(named.name, parsed.config, { persist });
  if (confirmText) {
    let agreed = false;
    try { agreed = typeof confirm === 'function' && (await confirm(confirmText)) === true; } catch { agreed = false; }
    if (!agreed) return { ok: false, cancelled: true, error: 'Not started.', saved: false };
  }

  let res;
  try { res = await register({ name: named.name, config: parsed.config, persist }); } catch (err) { res = { ok: false, error: err?.message || String(err) }; }
  if (!res || res.type === 'error' || res.ok === false || res.error || (typeof res.status === 'number' && res.status >= 400)) {
    return { ok: false, error: typeof res?.error === 'string' && res.error ? res.error : 'OpenCode did not accept the server.', saved: false };
  }
  const listed = Array.isArray(res.data) ? res.data : [];
  const row = listed.find((r) => r?.name === named.name);
  if (row?.status === 'failed') {
    return { ok: false, error: row.error || `${named.name} did not start.`, rows: listed, saved: false };
  }
  if (res.saved === true) {
    return { ok: true, rows: listed, saved: true, note: `${named.name} was added and saved to the OpenCode config.` };
  }
  const why = !persist
    ? 'restart SynaBun to save servers from the panel'
    : (typeof res.saveError === 'string' && res.saveError ? res.saveError : 'the OpenCode config was not written');
  return {
    ok: true, rows: listed, saved: false,
    note: `${named.name} runs in this session, but it was not saved for later ones: ${why}.`,
  };
}

// ── Update notice (D5: a notice, never an in-panel upgrade) ─────────────────

const versionParts = (v) => String(v || '').replace(/^v/i, '').split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);

/** True when `available` is a newer version than `current`. */
export function isNewerVersion(available, current) {
  if (!available) return false;
  if (!current) return true;
  const a = versionParts(available);
  const b = versionParts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

/** The notice line, or '' when there is nothing newer. */
export function updateNoticeText(available, current) {
  if (!isNewerVersion(available, current)) return '';
  return `OpenCode ${String(available).replace(/^v/i, '')} is available${current ? ` (running ${current})` : ''}. Update it from a terminal: opencode upgrade`;
}

// ── Model picker data ───────────────────────────────────────────────────────

const perMillion = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n === 0) return '0';
  return n >= 10 ? String(Math.round(n)) : String(Number(n.toFixed(2)));
};

/**
 * What a model row adds after the name: a status that is not plain "active",
 * and the list price OpenCode's catalog carries (USD per million tokens,
 * input / output). No SynaBun price list is involved.
 */
export function modelRowMeta(model) {
  if (!model || typeof model !== 'object') return { status: '', price: '' };
  const status = typeof model.status === 'string' && model.status !== 'active' ? model.status : '';
  const input = perMillion(model.cost?.input);
  const output = perMillion(model.cost?.output);
  let price = '';
  if (input !== '' && output !== '') price = input === '0' && output === '0' ? 'free' : `$${input} / $${output}`;
  return { status, price };
}

/** The model a session last ran on (Session.model), as the picker's `{ providerID, modelID }`. */
export function sessionModelOf(sessionInfo) {
  const model = sessionInfo?.model;
  const providerID = typeof model?.providerID === 'string' ? model.providerID : '';
  const modelID = typeof model?.id === 'string' ? model.id : (typeof model?.modelID === 'string' ? model.modelID : '');
  return providerID && modelID ? { providerID, modelID } : null;
}

// Catalog events after which the provider list should be read again.
export const PROVIDER_CATALOG_EVENTS = Object.freeze([
  'catalog.updated', 'models-dev.refreshed', 'integration.updated', 'integration.connection.updated',
]);

export function isProviderCatalogEvent(eventType) {
  const type = String(eventType || '');
  return PROVIDER_CATALOG_EVENTS.includes(type) || type.startsWith('integration.');
}

// ── Sign-in pages OpenCode could not open itself ────────────────────────────
// `mcp.browser.open.failed` carries a server name and a URL and nothing about
// who asked. The URL is a sign-in for one server of one session's serve, so it
// is shown only there. What identifies the attempt on this page is the request
// that is out for it: the popover opens an attempt (`expect`) before its
// request leaves and closes it (`done()`) when the request has ended. A
// failure is attributed only while exactly one session has an attempt open for
// that server name. When two sessions are signing in to a server of the same
// name at once, nothing says whose page it is, and it is shown to neither; one
// nobody on this page has open (another window, the CLI, a request that has
// already ended) has no owner here and is not shown either.
// The link is kept on the attempt it was attributed to and lives exactly as
// long: it goes when the attempt ends (`done()`), when it expires (a request
// that never ends), when its session is forgotten, and when another attempt
// for the same server name begins (the same session asks again: the earlier
// page is no longer the one to open; another session asks: nothing says any
// more whose page a link is). `onChange` is called whenever a link went that
// way, so that open popovers are painted again.
export const SIGN_IN_EXPECT_MS = 10 * 60 * 1000;

export function createSignInFailures({ now = () => Date.now(), ttlMs = SIGN_IN_EXPECT_MS, onChange = () => {} } = {}) {
  let attempts = [];                // open attempts: { id, sessionId, mcpName, at, url, timer }
  let seq = 0;
  const changed = () => { try { onChange(); } catch { /* listener's problem */ } };
  // These attempts are over. Their links go with them.
  const close = (list) => {
    const over = list.filter((e) => attempts.includes(e));
    if (!over.length) return;
    attempts = attempts.filter((e) => !over.includes(e));
    for (const e of over) clearTimeout(e.timer);
    if (over.some((e) => e.url)) changed();
  };
  const expired = (e) => now() - e.at > ttlMs;
  // A request that never ends (a socket that died under it) does not keep its
  // attempt open for ever.
  const prune = () => close(attempts.filter(expired));
  const closed = Object.freeze({ id: 0, done() {} });
  return {
    /**
     * `sessionId` is about to ask its serve to sign in to (or start) `mcpName`.
     * Returns the attempt: call `done()` when the request has ended, however
     * it ended. (Several attempts of one session for one server may be open.)
     */
    expect(sessionId, mcpName) {
      const sid = String(sessionId || '');
      const name = String(mcpName || '');
      if (!sid || !name) return closed;
      prune();
      // A new attempt for this server name: no link recorded for an earlier
      // one is offered any more, in this session or in another.
      const outdated = attempts.filter((e) => e.mcpName === name && e.url);
      for (const e of outdated) e.url = '';
      seq += 1;
      const attempt = { id: seq, sessionId: sid, mcpName: name, at: now(), url: '', timer: null };
      // It expires by itself, should nobody call anything until then.
      attempt.timer = setTimeout(prune, ttlMs + 1);
      attempt.timer?.unref?.();
      attempts.push(attempt);
      if (outdated.length) changed();
      return { id: attempt.id, done() { close([attempt]); } };
    },
    /** The event. Returns the session it was attributed to, or '' (shown nowhere). */
    record({ mcpName, url } = {}) {
      const name = String(mcpName || '');
      const link = String(url || '');
      if (!name || !link) return '';
      prune();
      const open = attempts.filter((e) => e.mcpName === name);
      const owners = new Set(open.map((e) => e.sessionId));
      // Nobody here has it open, or more than one session does: no owner.
      if (owners.size !== 1) return '';
      for (const e of open) e.url = link;
      return open[0].sessionId;
    },
    /** The pages to offer in `sessionId`'s popover: only for servers it lists. */
    forSession(sessionId, rows = []) {
      const sid = String(sessionId || '');
      if (!sid) return [];
      const out = [];
      for (const row of Array.isArray(rows) ? rows : []) {
        const name = String(row?.name || '');
        const held = attempts.filter((e) => e.sessionId === sid && e.mcpName === name && e.url && !expired(e)).pop();
        // Signed in meanwhile: nothing left to open.
        if (held && row?.status !== 'connected') out.push({ mcpName: name, url: held.url });
      }
      return out;
    },
    /** The session is gone. */
    forget(sessionId) {
      const sid = String(sessionId || '');
      close(attempts.filter((e) => e.sessionId === sid));
    },
    /** Links on offer. */
    size: () => attempts.filter((e) => e.url && !expired(e)).length,
    /** Attempts still open (their request has not ended). */
    open: () => { prune(); return attempts.length; },
  };
}
