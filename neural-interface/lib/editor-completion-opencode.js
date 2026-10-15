// ── AI autocomplete through OpenCode models: a dedicated, lean `opencode serve` ──
// A fill-in request must be short and quick. On the shared serve (port 4096) it
// carries the user's instruction files and MCP tool definitions, 4,700 to 9,300
// input tokens before a line of code, and every request would show up as a
// session in the OpenCode panel. So completions get a serve of their own:
//
//   - its own XDG_CONFIG_HOME (DATA_HOME/data/editor-complete/) whose config
//     holds what makes the user's models reachable (their `provider` blocks and
//     the provider allow / deny lists) and one agent, `synabun-complete`: the
//     completion instruction as its prompt, every tool denied. No MCP servers,
//     no instruction files, no plugins. A provider block that names a file by
//     a path relative to the user's configuration ({file:./key}) is written
//     with that path made whole: here it would be looked for in this folder;
//   - OPENCODE_DISABLE_CLAUDE_CODE and OPENCODE_DISABLE_PROJECT_CONFIG, so no
//     CLAUDE.md, AGENTS.md or opencode.json of a folder above is read either;
//   - the user's own data home, so stored provider credentials keep working.
//
// Measured on OpenCode 1.18.34 (2026-10-12): about 200 input tokens of overhead
// per request against 5,500 with the tools left on, and 810 with an AGENTS.md
// one folder up and project configuration left on.
//
// Started on the first request, stopped after ten idle minutes and at server
// shutdown. One request is one session in an empty working folder: create,
// prompt with the model and the agent, read the text parts, delete. A start is
// over, and the serve takes requests, only once the sessions a crash left in
// that folder are deleted: every request that arrives meanwhile waits for the
// same start, so no request's own session is ever taken for a leftover. A start
// that fails after its process was spawned (the serve never answers, its client
// cannot be built, a stop is asked for meanwhile) stops that process and fails
// for everybody who waited for it; stop() ends a start that is under way too.
// There is no fallback to the shared serve. Everything that touches a process,
// a port or the network is injected: tests run against a fake.

import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

export const COMPLETION_AGENT = 'synabun-complete';
/** Every session of this serve carries this title: no title is generated, and leftovers of a crash are recognisable. */
export const COMPLETION_SESSION_TITLE = 'synabun-editor-complete';
export const IDLE_STOP_MS = 10 * 60_000;
export const START_TIMEOUT_MS = 15_000;
/** How long a start waits for the sessions a crash left behind to be listed and deleted. */
export const SWEEP_TIMEOUT_MS = 5000;

// What of the user's OpenCode configuration decides which models can be reached.
const CARRIED_KEYS = ['provider', 'disabled_providers', 'enabled_providers'];
// Reasoning settings a model may offer, the lightest first: a completion wants the least.
const LIGHT_VARIANTS = ['none', 'minimal', 'low'];

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// OpenCode replaces {file:path} in a configuration with the file's text. A path that is neither absolute nor
// from the home folder (~/) is read from the folder the configuration is in.
const FILE_REFERENCE = /\{file:([^}]+)\}/g;
const isRelativeReference = (path) => !(path.startsWith('~/') || isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path));

/**
 * A value of the user's configuration with its relative {file:…} references written from `dir`.
 * @param {any} value
 * @param {string | null} dir the folder the user's configuration is in; without it the references stay as they are
 * @param {{ relative: number }} seen counts the relative references met
 */
function rebaseFileReferences(value, dir, seen) {
  if (typeof value === 'string') {
    return value.replace(FILE_REFERENCE, (whole, path) => {
      if (!isRelativeReference(path)) return whole;
      seen.relative++;
      if (!dir) return whole;
      const absolute = resolve(dir, path);
      return `{file:${sep === '/' ? absolute : absolute.split(sep).join('/')}}`;
    });
  }
  if (Array.isArray(value)) return value.map((item) => rebaseFileReferences(item, dir, seen));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebaseFileReferences(item, dir, seen)]));
  return value;
}

/**
 * The configuration of the dedicated serve.
 * @param {object | null} userConfig the user's own OpenCode configuration (~/.config/opencode/config.json)
 * @param {{ system: string, configDir?: string | null, log?: (tag: string, message: string) => void }} o `system`:
 *   the completion instruction, the agent's whole prompt; `configDir`: the folder the user's configuration is in,
 *   which a relative {file:…} reference of a provider is resolved against. Without it, a provider that holds such
 *   a reference is left out (and logged): from the serve's own folder it would name another file, or none.
 */
export function buildCompletionServeConfig(userConfig, { system, configDir = null, log = () => {} }) {
  const config = { $schema: 'https://opencode.ai/config.json', autoupdate: false, share: 'disabled', snapshot: false };
  for (const key of CARRIED_KEYS) {
    const value = isObject(userConfig) ? userConfig[key] : undefined;
    if (key !== 'provider') { if (Array.isArray(value)) config[key] = structuredClone(value); continue; }
    if (!isObject(value)) continue;
    const providers = {};
    for (const [id, definition] of Object.entries(value)) {
      const seen = { relative: 0 };
      const carried = rebaseFileReferences(structuredClone(definition), configDir, seen);
      if (seen.relative && !configDir) {
        log('editor-complete:serve', `the provider "${id}" reads a file by a path relative to the OpenCode configuration, whose folder is not known here: it is left out of the completion server`);
        continue;
      }
      providers[id] = carried;
    }
    if (Object.keys(providers).length || !Object.keys(value).length) config.provider = providers;
  }
  config.agent = {
    [COMPLETION_AGENT]: {
      description: 'SynaBun code editor autocomplete',
      mode: 'primary',
      prompt: system,
      temperature: 0.1,
      permission: { '*': 'deny' },
    },
  };
  return config;
}

/**
 * The environment of the dedicated serve: the server's own, pointed at the lean configuration and told to read
 * nothing else.
 * @param {object} base the environment to start from (process.env)
 * @param {{ configHome: string }} o the XDG_CONFIG_HOME that holds opencode/config.json
 */
export function completionServeEnvironment(base, { configHome }) {
  const env = { ...base };
  // Anything that would add configuration on top of the folder below.
  for (const key of ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_CONFIG_DIR', 'CLAUDECODE']) delete env[key];
  return {
    ...env,
    XDG_CONFIG_HOME: configHome,
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    FORCE_COLOR: '0',
  };
}

/** The lightest reasoning setting among a model's variants, or undefined when it offers none of them. */
export function lightestVariant(names) {
  const list = Array.isArray(names) ? names : [];
  return LIGHT_VARIANTS.find((name) => list.includes(name));
}

/** `{ providerID, modelID }` of a "provider/model" id; the model's own id may hold slashes. */
export function splitModelId(id) {
  const text = String(id ?? '');
  const slash = text.indexOf('/');
  if (slash <= 0 || slash >= text.length - 1) throw new Error(`Not a model id: ${text || '(empty)'}`);
  return { providerID: text.slice(0, slash), modelID: text.slice(slash + 1) };
}

/** Each connected model's variant names, from the serve's /provider answer: Map("provider/model" → string[]). */
export function variantsByModel(providers) {
  const out = new Map();
  const body = isObject(providers?.data) && (providers.data.all || providers.data.connected) ? providers.data : providers;
  const connected = Array.isArray(body?.connected) ? new Set(body.connected.map(String)) : null;
  for (const provider of Array.isArray(body?.all) ? body.all : []) {
    const pid = provider?.id;
    if (!pid || (connected && !connected.has(pid))) continue;
    for (const [mid, model] of Object.entries(isObject(provider.models) ? provider.models : {})) {
      if (isObject(model?.variants)) out.set(`${pid}/${model.id || mid}`, Object.keys(model.variants));
    }
  }
  return out;
}

/**
 * The text and the token counts of a prompt's answer (`POST /session/{id}/message`).
 * @returns {{ text: string, tokens: { input: number, output: number }, error: string | null }} `input` counts the
 *   tokens read from and written to the provider's cache too; `output` counts reasoning
 */
export function readPromptResult(data) {
  const parts = Array.isArray(data?.parts) ? data.parts : [];
  const text = parts.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('');
  const t = data?.info?.tokens || {};
  const n = (v) => Math.max(0, Math.round(Number(v) || 0));
  const failure = data?.info?.error;
  const error = failure ? String(failure.data?.message || failure.message || failure.name || 'The model call failed') : null;
  return {
    text,
    tokens: { input: n(t.input) + n(t.cache?.read) + n(t.cache?.write), output: n(t.output) + n(t.reasoning) },
    error,
  };
}

function abortError() {
  const error = new Error('The request was aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * @param {object} deps
 * @param {string} deps.dataDir DATA_HOME/data/editor-complete: holds opencode/config.json and the empty work folder
 * @param {string} deps.system the completion instruction (the agent's prompt)
 * @param {() => object | null} deps.readUserConfig the user's OpenCode configuration, read at each start
 * @param {() => string | null} [deps.userConfigDir] the folder that configuration is in (relative {file:…}
 *   references of its providers are resolved against it)
 * @param {() => number | null} deps.allocPort a free port (server.js allocOpencodeIsoPort)
 * @param {(o: { port: number, env: object, cwd: string }) => object} deps.spawnServe starts `opencode serve` on the
 *   port and returns its process (`on('exit')`, `kill()`)
 * @param {(proc: object) => void} [deps.killServe] stops that process (default: SIGTERM)
 * @param {(o: { port: number }) => object} deps.createClient lib/opencode-v2-client.js createClientInstance
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {object} [deps.env] the environment the serve starts from
 * @param {number} [deps.idleMs] the serve is stopped after this long without a request
 * @param {number} [deps.startTimeoutMs]
 * @param {number} [deps.sweepTimeoutMs] how long a start waits for the leftover sessions to be listed and deleted
 * @param {number} [deps.healthPollMs]
 */
export function createOpencodeCompletionEngine({
  dataDir, system, readUserConfig = () => null, userConfigDir = () => null, allocPort, spawnServe,
  killServe = (proc) => { try { proc.kill('SIGTERM'); } catch { /* gone */ } },
  createClient, fetchImpl = (...args) => fetch(...args), env = process.env, now = Date.now,
  idleMs = IDLE_STOP_MS, startTimeoutMs = START_TIMEOUT_MS, sweepTimeoutMs = SWEEP_TIMEOUT_MS, healthPollMs = 100, log = () => {},
} = {}) {
  if (!dataDir || !system) throw new Error('createOpencodeCompletionEngine requires dataDir and system');
  if (typeof allocPort !== 'function' || typeof spawnServe !== 'function' || typeof createClient !== 'function') {
    throw new Error('createOpencodeCompletionEngine requires allocPort, spawnServe and createClient');
  }
  const workDir = join(dataDir, 'work');
  let entry = null;      // the serve that takes requests: { port, proc, client, variants, providers, exited }
  let starting = null;   // the start under way, shared by everything that waits for it (it ends when the serve is ready)
  let spawned = null;    // the serve of that start, from its spawn until it is ready or given up: stop() ends it too
  let epoch = 0;         // moves on with every stop: a start that finishes after one is not kept
  let idleTimer = null;
  let lastUsed = 0;
  let starts = 0;
  const deleting = new Set();   // session deletions on their way: a stop waits for them (drain)

  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const serveUrl = (port, path) => `http://127.0.0.1:${port}${path}${path.includes('?') ? '&' : '?'}directory=${encodeURIComponent(workDir)}`;

  function touch() {
    lastUsed = now();
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { idleTimer = null; stop('idle'); }, idleMs);
    idleTimer.unref?.();
  }

  /** End one serve: its client's event stream, and its process when that still runs. */
  function end(serve) {
    try { serve.client?.stop?.(); } catch { /* never started its event stream */ }
    if (serve.proc && !serve.exited && !serve.killed) { serve.killed = true; killServe(serve.proc); }
  }

  function stop(reason = 'stop') {
    epoch++;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    const gone = entry;
    entry = null;
    // A start that has spawned its process and is not ready yet: the process goes now, and the start fails for
    // everybody who waits for it as soon as it looks again (start()).
    const half = spawned;
    spawned = null;
    if (half) {
      log('editor-complete:serve', `stopping the completion server that was starting on port ${half.port} (${reason})`);
      end(half);
      half.halt?.();
    }
    if (!gone) return !!half;
    log('editor-complete:serve', `stopping the completion server on port ${gone.port} (${reason})`);
    end(gone);
    return true;
  }

  async function start() {
    const mine = epoch;
    const port = allocPort();
    if (port == null) throw new Error('No free port for the completion server');
    mkdirSync(join(dataDir, 'opencode'), { recursive: true });
    mkdirSync(workDir, { recursive: true });
    let userConfig = null;
    try { userConfig = readUserConfig(); } catch (error) { log('editor-complete:serve', `could not read the OpenCode configuration: ${error?.message || error}`); }
    let configDir = null;
    try { configDir = userConfigDir() || null; } catch { configDir = null; }
    writeFileSync(join(dataDir, 'opencode', 'config.json'), `${JSON.stringify(buildCompletionServeConfig(userConfig, { system, configDir, log }), null, 2)}\n`, 'utf8');

    const started = { port, proc: null, client: null, variants: new Map(), providers: null, providersAt: 0, exited: false, killed: false, halt: null };
    // What a stop wakes: a start that waits (for the serve to answer, for the next look) goes on at once.
    const halted = new Promise((done) => { started.halt = done; });
    started.proc = spawnServe({ port, env: completionServeEnvironment(env, { configHome: dataDir }), cwd: workDir });
    starts++;
    spawned = started;
    // From here on a process runs. Whatever goes wrong before the serve is ready, it does not stay behind.
    try {
      started.proc?.on?.('exit', () => {
        started.exited = true;
        if (entry === started) { entry = null; if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } }
      });
      started.proc?.on?.('error', () => { started.exited = true; });

      // Both are checked before and after each wait: a stop may have been asked for, or the process may be gone.
      const stillWanted = () => {
        if (mine !== epoch) throw new Error('The completion server was stopped while it was starting');
        if (started.exited) throw new Error('The completion server stopped while it was starting. Is OpenCode installed?');
      };
      const deadline = now() + startTimeoutMs;
      for (;;) {
        stillWanted();
        try {
          const res = await Promise.race([fetchImpl(`http://127.0.0.1:${port}/global/health`, { signal: AbortSignal.timeout(2000) }), halted]);
          if (res?.ok) break;
        } catch { /* not up yet */ }
        stillWanted();
        if (now() >= deadline) throw new Error(`The completion server did not answer within ${Math.round(startTimeoutMs / 1000)} seconds`);
        await Promise.race([sleep(healthPollMs), halted]);
      }
      stillWanted();

      started.client = createClient({ port });
      // It answers, and takes no request yet. First the sessions a crash left behind go: a sweep that ran beside the
      // first requests would find their sessions in its listing and delete them under the model call. Meanwhile,
      // which lighter reasoning setting each model offers; worth a short wait, as without it the first completions
      // think for longer.
      await Promise.race([Promise.all([sweep(started), Promise.race([loadProviders(started).catch(() => null), sleep(1500)])]), halted]);
      stillWanted();
      entry = started;
      touch();
      log('editor-complete:serve', `completion server ready on port ${port}`);
      return started;
    } catch (error) {
      end(started);
      throw error;
    } finally {
      if (spawned === started) spawned = null;
    }
  }

  function ensure() {
    if (entry) { touch(); return Promise.resolve(entry); }
    if (!starting) starting = start().finally(() => { starting = null; });
    return starting;
  }

  async function loadProviders(serve, { signal } = {}) {
    if (serve.providers && now() - serve.providersAt < 60_000) return serve.providers;
    const res = await fetchImpl(serveUrl(serve.port, '/provider'), { signal: signal || AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`The completion server answered ${res.status} for its model list`);
    serve.providers = await res.json();
    serve.providersAt = now();
    serve.variants = variantsByModel(serve.providers);
    return serve.providers;
  }

  /**
   * Delete the sessions a crash left behind in the work folder (a request deletes its own). Part of a start: the
   * listing is asked for before the serve takes requests, so nothing in it is a request's own session. It never
   * throws, and it does not hold a start for longer than `sweepTimeoutMs`: a listing that has not answered by
   * then is given up on, and deletes nothing when it does answer (by then it may hold sessions of requests).
   */
  async function sweep(serve) {
    let phase = 'listing';
    const work = (async () => {
      const listed = await serve.client.session.list({ directory: workDir });
      if (phase !== 'listing') return;
      phase = 'deleting';
      const rows = Array.isArray(listed?.data) ? listed.data : [];
      for (const row of rows.filter((r) => r?.title === COMPLETION_SESSION_TITLE).slice(0, 200)) {
        await serve.client.session.delete({ sessionID: row.id, directory: workDir }).catch(() => {});
      }
    })().catch((error) => { log('editor-complete:serve', `could not delete the sessions a crash left behind: ${error?.message || error}`); });
    let timer = null;
    const late = await Promise.race([work.then(() => false), new Promise((done) => { timer = setTimeout(() => done(true), sweepTimeoutMs); timer.unref?.(); })]);
    clearTimeout(timer);
    if (!late) return;
    if (phase === 'listing') {
      phase = 'abandoned';
      log('editor-complete:serve', 'the sessions a crash left behind were not listed in time: none is deleted at this start');
      return;
    }
    // Listed in time, still being deleted: those are leftovers and nothing else. A stop waits for them (drain).
    deleting.add(work);
    work.finally(() => deleting.delete(work));
  }

  /**
   * One completion.
   * @param {{ model: string, user: string, signal?: AbortSignal }} o `model`: "provider/model"; `user`: the user
   *   message (the system message is the agent's prompt)
   * @returns {Promise<{ text: string, tokens: { input: number, output: number } }>}
   */
  async function complete({ model, user, signal } = {}) {
    const ref = splitModelId(model);
    if (signal?.aborted) throw abortError();
    const serve = await ensure();
    if (signal?.aborted) throw abortError();
    const created = await serve.client.session.create({ directory: workDir, title: COMPLETION_SESSION_TITLE });
    const sessionID = created?.data?.id;
    if (!sessionID) throw new Error('OpenCode did not create a session for the completion');
    // The page gave up: the model call is cancelled in the serve, not left to finish unseen.
    const onAbort = () => { Promise.resolve(serve.client.session.abort({ sessionID, directory: workDir })).catch(() => {}); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (signal?.aborted) throw abortError();
      const response = await serve.client.session.prompt({
        sessionID, directory: workDir, model: ref, agent: COMPLETION_AGENT,
        variant: lightestVariant(serve.variants.get(model)),
        parts: [{ type: 'text', text: user }], signal,
      });
      const result = readPromptResult(response?.data);
      if (result.error) throw new Error(result.error);
      return { text: result.text, tokens: result.tokens };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (entry === serve) touch();
      // Not waited for: the answer is not held back by the tidying up.
      const gone = Promise.resolve().then(() => serve.client.session.delete({ sessionID, directory: workDir })).catch(() => {});
      deleting.add(gone);
      gone.finally(() => deleting.delete(gone));
    }
  }

  /** Wait, for at most `timeoutMs`, until the sessions of finished requests are deleted (before a stop). */
  async function drain(timeoutMs = 1000) {
    if (!deleting.size) return;
    await Promise.race([Promise.allSettled([...deleting]), sleep(timeoutMs)]);
  }

  return {
    complete,
    /**
     * The serve's /provider answer (every known provider, and which are connected), or null while the serve is
     * not running and `start` is not set.
     */
    async providers({ start: startIt = false, signal } = {}) {
      const serve = startIt ? await ensure() : entry;
      return serve ? loadProviders(serve, { signal }) : null;
    },
    running: () => !!entry,
    drain,
    stop,
    status: () => ({ running: !!entry, starting: !!starting, port: entry?.port ?? null, lastUsed: lastUsed || null, starts }),
    workDir,
  };
}
