// ═══════════════════════════════════════════
// SynaBun Neural Interface — Start Server bridge (page side)
// A page cannot ask a server that is down to start itself. It hands the
// operating system a synabun://start link instead; the launcher registered
// for that link (lib/start-launcher.js) starts the server, and the page
// watches for it. DOM-free and dependency-free.
//
// The page also cannot ask a stopped server how its start is going. The
// launcher says so itself, on a loopback beacon (port + 10000) that lives only
// while a launch does. Everything the page shows about a start comes from one
// of three things: its own clock, what that beacon reported (each step with
// the time it happened), and its own probe of the server. Nothing is guessed:
// no percentages, and no step is named before the launch reported it.
//
// offline.html is shown when nothing can be fetched, so the server pastes this
// file into it (lib/offline-page.js drops the `export` keywords). Keep every
// export a plain `export function` / `export const` at the start of a line,
// and never import anything here.
// ═══════════════════════════════════════════

export const START_LINK = 'synabun://start';

// What the page remembers from the last time the server answered.
export const START_STORAGE = {
  projectDir: 'synabun-project-dir',
  install: 'synabun-install-kind',       // 'npm' | 'git'
  launcher: 'synabun-start-launcher',    // 'registered' | 'stale' | 'missing' | 'skipped'
};

export const START_LIMITS = {
  pollMs: 300,           // while a start is under way: is the server up, what does the launch say
  idlePollMs: 3000,      // while nothing was asked for
  hintAfterMs: 4000,     // nothing from the launcher yet: say what to look for
  stallAfterMs: 60000,   // still nothing from anyone: offer the button and the command again
  quietAfterMs: 15000,   // the launch has reported nothing new for this long: say so
  lostAfterMs: 3000,     // a launch that was reporting went silent: stop repeating what it said
  idleBeaconChecks: 2,   // on load, look for a start already under way (a reload in the middle of one)
  reloadDelayMs: 150,    // the "it is up" frame before the page reloads
  beaconTimeoutMs: 1200,
};

export const START_BEACON_PATH = '/synabun-start-status';
export const START_BEACON_VERSION = 1;

export function isWindowsPlatform(nav) {
  const platform = String(nav?.userAgentData?.platform || nav?.platform || '');
  return /win/i.test(platform) || /Windows/i.test(String(nav?.userAgent || ''));
}

export function isMacPlatform(nav) {
  const platform = String(nav?.userAgentData?.platform || nav?.platform || '');
  return /mac/i.test(platform);
}

/**
 * How to hand the link to the OS. Firefox replaces the page with an error when
 * a top-level navigation has no handler, so it gets a hidden frame; every
 * other engine asks the user from the top frame and ignores an unknown link.
 */
export function startLinkMode(userAgent) {
  return /\bFirefox\//.test(String(userAgent || '')) ? 'frame' : 'top';
}

/**
 * Hand START_LINK to the OS. Call it from the click itself: browsers only ask
 * "open SynaBun?" for a navigation the user started.
 */
export function openStartLink({ document: doc, location: loc, userAgent } = {}) {
  if (startLinkMode(userAgent) === 'frame') {
    const frame = doc.createElement('iframe');
    frame.style.display = 'none';
    frame.src = START_LINK;
    doc.body.appendChild(frame);
    const tidy = setTimeout(() => { try { frame.remove(); } catch {} }, 5000);
    if (typeof tidy === 'object') tidy?.unref?.(); // only outside a browser
    return 'frame';
  }
  loc.href = START_LINK;
  return 'top';
}

/** A path as one argument, in whatever shell the platform's terminal runs. */
export function quoteShellPath(path, windows) {
  const value = String(path || '');
  // cmd.exe and PowerShell both take a double-quoted path; a Windows path cannot contain a quote.
  if (windows) return `"${value}"`;
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The commands a person can type instead. One line each, no `cd`, no `;` or
 * `&` between commands: `npm --prefix <dir> start` reads the same in cmd.exe,
 * PowerShell, bash, zsh and fish.
 * Returns [{ id: 'npm' | 'git', command }] — the one that matches the install
 * when it is known, both when it is not.
 */
export function manualStartCommands({ projectDir, install, windows } = {}) {
  const npm = { id: 'npm', command: 'synabun' };
  const git = projectDir ? { id: 'git', command: `npm --prefix ${quoteShellPath(projectDir, windows)} start` } : null;
  if (install === 'npm') return [npm];
  if (install === 'git' && git) return [git];
  return git ? [npm, git] : [npm];
}

/** Whether the button can work: only a registration known to be absent rules it out. */
export function startButtonUsable(launcherState) {
  return launcherState !== 'missing';
}

// ═══════════════════════════════════════════
// The launch's own report (the beacon)
// ═══════════════════════════════════════════

/** The beacon's port for a server port: + 10000, − 10000 past the last port. As lib/start-launcher.js `startBeaconPort`. */
export function startBeaconPort(port) {
  const n = Number(port);
  const p = Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 3344;
  return p + 10000 <= 65535 ? p + 10000 : p - 10000;
}

/**
 * Where this page reads the beacon, or null when it cannot: the launcher runs
 * on the machine the server runs on, so only a page opened from that machine's
 * own loopback address (and over plain http, like the beacon) has one to read.
 * Returns { url, port } with `port` the server's.
 */
export function startBeaconTarget(loc) {
  const host = String(loc?.hostname || '').toLowerCase();
  if (String(loc?.protocol || '') !== 'http:') return null;
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]' && host !== '::1') return null;
  const port = Number(loc?.port) || 80;
  return { port, url: `http://127.0.0.1:${startBeaconPort(port)}${START_BEACON_PATH}` };
}

const START_LAUNCH_STATES = ['starting', 'started', 'failed', 'gave-up'];
const START_LAUNCH_STEPS = ['received', 'locked', 'terminal', 'spawned'];
const START_SUPERVISOR_PHASES = ['checking', 'dependencies', 'browser', 'build', 'snapshot', 'server', 'listening', 'failed'];

function startCleanError(error) {
  if (!error || typeof error !== 'object') return null;
  const exitCode = Number(error.exitCode);
  return {
    code: String(error.code || '').slice(0, 40),
    message: String(error.message || '').slice(0, 300),
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
  };
}

/**
 * Read one beacon answer. Returns the launch as this page may show it, or
 * null: not a beacon, another server's, or the end of a launch this page has
 * nothing to do with (a failure still being reported from before the click).
 * A launch that is still under way is this server's start whoever asked.
 *   askedAt — when this page handed the link over (null: it did not)
 *   following — the launch id this page is already showing
 *   past — launch ids this page has moved on from (a retry was clicked)
 */
export function readStartBeacon(data, { port, askedAt = null, following = null, past = [] } = {}) {
  if (!data || typeof data !== 'object' || data.synabun !== 'start-beacon' || data.v !== START_BEACON_VERSION) return null;
  if (Number(data.port) !== Number(port)) return null;
  if (!START_LAUNCH_STATES.includes(data.state)) return null;
  const id = String(data.launchId || '');
  const startedAt = Number(data.startedAt) || 0;
  if (!id || !startedAt) return null;
  if (data.state !== 'starting') {
    if (past.includes(id)) return null;
    const mine = id === following || (askedAt !== null && startedAt >= askedAt - 2000);
    if (!mine) return null;
  }

  const steps = [];
  for (const step of Array.isArray(data.steps) ? data.steps : []) {
    const at = Number(step?.at);
    if (START_LAUNCH_STEPS.includes(step?.id) && Number.isFinite(at)) steps.push({ id: step.id, at });
  }
  let supervisor = null;
  const sup = data.supervisor;
  if (sup && typeof sup === 'object' && START_SUPERVISOR_PHASES.includes(sup.phase)) {
    const detail = sup.detail && typeof sup.detail === 'object' ? sup.detail : {};
    const number = (value) => (Number.isFinite(Number(value)) && value !== null ? Number(value) : null);
    supervisor = {
      phase: sup.phase,
      at: Number(sup.at) || 0,
      startedAt: Number(sup.startedAt) || 0,
      phases: (Array.isArray(sup.phases) ? sup.phases : [])
        .filter(p => START_SUPERVISOR_PHASES.includes(p?.phase) && Number.isFinite(Number(p?.at)))
        .map(p => ({ phase: p.phase, at: Number(p.at) })),
      detail: {
        name: typeof detail.name === 'string' ? detail.name.slice(0, 80) : '',
        step: typeof detail.step === 'string' ? detail.step.slice(0, 40) : '',
        files: number(detail.files),
        bytes: number(detail.bytes),
      },
      error: startCleanError(sup.error),
    };
  }
  const last = steps[steps.length - 1] || { id: 'received', at: startedAt };
  const newest = Math.max(last.at, supervisor ? supervisor.at : 0, startedAt);
  return {
    id,
    state: data.state,
    startedAt,
    step: last.id,
    steps,
    supervisor,
    error: startCleanError(data.error) || (supervisor && supervisor.error) || null,
    log: typeof data.log === 'string' ? data.log.slice(0, 400) : '',
    // On the launcher's own clock: how long since it last saw something happen.
    quietMs: Math.max(0, (Number(data.now) || newest) - newest),
  };
}

/** Fetch the beacon once: its JSON, or null when nothing is there to answer. */
export function fetchStartBeacon(target, { fetchImpl, timeoutMs = START_LIMITS.beaconTimeoutMs } = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!target || !doFetch) return Promise.resolve(null);
  const options = { cache: 'no-store', credentials: 'omit', mode: 'cors' };
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') options.signal = AbortSignal.timeout(timeoutMs);
  } catch {}
  return Promise.resolve()
    .then(() => doFetch(target.url, options))
    .then(res => (res && res.ok ? res.json() : null))
    .catch(() => null);
}

// ═══════════════════════════════════════════
// The button's life
// ═══════════════════════════════════════════

/**
 * idle → launching → starting | waiting → stalled | failed, or online at any
 * point. The page keeps probing in every state, so a server started by hand is
 * noticed just the same.
 *   probe()    → Promise<boolean>   is the server answering?
 *   launch()   → hand START_LINK to the OS
 *   beacon()   → Promise<object|null>  the launch's raw report (optional)
 *   port       → the server's port (what a beacon must be about)
 *   onState(state, detail)   on every change of state
 *   onUpdate(snapshot)       whenever what there is to show changed: the
 *                            state, what the launch reported, or the second
 *
 * States:
 *   'idle'       nothing asked
 *   'launching'  the link was handed to the OS; nothing has confirmed it
 *   'starting'   the launcher itself reports a start under way (evidence)
 *   'waiting'    hintAfterMs with no word from the launcher
 *   'stalled'    stallAfterMs with no word, or the launcher gave up waiting
 *   'failed'     the launcher reports that the start failed, and why
 *   'online'     the server answers this page
 */
export function createStartBridge({
  probe,
  launch,
  beacon = null,
  port = 0,
  onState = () => {},
  onUpdate = () => {},
  limits = START_LIMITS,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  const lim = { ...START_LIMITS, ...limits };
  let state = 'idle';
  let askedAt = null;   // when this page handed the link over (null: it has not)
  let since = null;     // what the elapsed time counts from
  let clicks = 0;
  let timer = null;
  let stopped = false;
  let probing = false;
  let launchInfo = null; // the launch as last reported
  let launchSeenAt = 0;
  let idleChecks = 0;
  let shown = '';
  const past = [];

  const busy = () => state === 'launching' || state === 'starting' || state === 'waiting';

  function snapshot() {
    return {
      state,
      clicks,
      askedAt,
      since,
      elapsedMs: since === null ? 0 : Math.max(0, now() - since),
      launch: launchInfo,
    };
  }

  function update() {
    const snap = snapshot();
    const l = snap.launch;
    const key = [
      snap.state, snap.clicks, busy() ? Math.floor(snap.elapsedMs / 1000) : '',
      l ? [l.id, l.state, l.step, l.supervisor?.phase, l.supervisor?.detail?.step, l.supervisor?.detail?.files, l.quietMs >= lim.quietAfterMs, l.error?.message].join('|') : '',
    ].join('/');
    if (key === shown) return;
    shown = key;
    try { onUpdate(snap); } catch {}
  }

  function set(next, detail = {}) {
    if (state === next) return;
    state = next;
    try { onState(state, { clicks, ...detail }); } catch {}
  }

  function schedule(delay) {
    if (stopped || state === 'online') return;
    if (timer) clearTimer(timer);
    timer = setTimer(tick, delay ?? (busy() ? lim.pollMs : lim.idlePollMs));
  }

  /** What the launch says, when there is one to listen to right now. */
  async function listen() {
    if (!beacon) return;
    // Idle: only just after load, for a start that was already under way.
    if (state === 'idle' && idleChecks >= lim.idleBeaconChecks) return;
    if (state === 'idle') idleChecks++;
    // Failed: the launcher said how it ended, there is no more to hear. Stalled
    // keeps listening: a prompt answered a minute late still starts a launch.
    if (state === 'failed') return;
    let raw = null;
    try { raw = await beacon(); } catch {}
    if (stopped || state === 'online') return;
    const read = readStartBeacon(raw, { port, askedAt, following: launchInfo?.id || null, past });
    if (read) {
      launchInfo = read;
      launchSeenAt = now();
      if (since === null) since = read.startedAt; // a start this page did not ask for: count from its own beginning
      if (read.state === 'failed') set('failed');
      else if (read.state === 'gave-up') set('stalled');
      else set('starting');
      return;
    }
    // It was reporting and stopped: a launcher that ended without this page
    // reading how. What it said last is no longer known to be true.
    if (state === 'starting' && now() - launchSeenAt >= lim.lostAfterMs) {
      launchInfo = null;
      if (askedAt === null) { since = null; set('idle'); } // a start this page never asked for: back to watching
      else set(now() - askedAt >= lim.hintAfterMs ? 'waiting' : 'launching');
    }
  }

  async function tick() {
    timer = null;
    if (stopped || probing) return;
    probing = true;
    let up = false;
    try { up = (await probe()) === true; } catch {}
    if (!up && !stopped) await listen();
    probing = false;
    if (stopped) return;
    if (up) { set('online'); update(); return; }
    if (state === 'launching' || state === 'waiting') {
      const waited = now() - askedAt;
      if (waited >= lim.stallAfterMs) set('stalled');
      else if (waited >= lim.hintAfterMs) set('waiting');
    }
    update();
    schedule();
  }

  return {
    get state() { return state; },
    snapshot,
    /** Begin watching for the server (call once the page is up). */
    watch() { schedule(0); },
    /** The click. Ignored while a start is already under way. */
    start() {
      if (stopped || state === 'online' || busy()) return false;
      clicks++;
      askedAt = now();
      since = askedAt;
      // What the last try reported is over: a launcher still saying so is not this one.
      if (launchInfo && !past.includes(launchInfo.id)) past.push(launchInfo.id);
      launchInfo = null;
      state = 'idle'; // a second try after 'stalled' announces 'launching' again
      set('launching');
      update();
      try { launch(); } catch {}
      schedule();
      return true;
    },
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}

// ═══════════════════════════════════════════
// What to show
// ═══════════════════════════════════════════

// The sentences, in English. The offline page uses them as they are; the app
// reads the same keys from its dictionary (`loading.start.<key>` in
// i18n/*.json, kept equal to these by tests/start-bridge.test.mjs).
export const START_COPY = {
  asked: 'Asked your system to start SynaBun. If your browser shows a prompt, choose Open.',
  unconfirmedMac: 'No word from the launcher yet. If your browser is asking for permission, choose Open: a Terminal window then opens with the server.',
  unconfirmedWindows: 'No word from the launcher yet. If your browser is asking for permission, choose Open: a console window then opens with the server.',
  unconfirmedLinux: 'No word from the launcher yet. If your browser is asking for permission, choose Open: the server then starts in the background.',
  stalled: 'Nothing has answered. If no prompt or window appeared, run the command below once: it also repairs this button.',
  launcherRunning: 'The launcher is running.',
  terminalOpened: 'A Terminal window was opened for the server.',
  terminalQuiet: 'A Terminal window was opened {seconds} s ago, but the server has not started in it. Look at that window.',
  processStarted: 'The server\'s supervisor was started.',
  checking: 'Checking the install.',
  dependencies: 'Installing dependencies with npm. A first start, or the first after an update, takes a few minutes.',
  browser: 'Downloading the automation browser. This happens once.',
  build: 'Building the MCP server.',
  snapshot: 'Backing up your data before the first start of this version.',
  snapshotSized: 'Backing up your data before the first start of this version: {files} files, {megabytes} MB.',
  server: 'The server process is running. Waiting for it to answer.',
  listening: 'The server is listening. Connecting.',
  answered: 'The server answered the launcher. Connecting.',
  quiet: 'Nothing new from the start for {seconds} s.',
  failed: 'The start failed: {reason}',
  failedHint: 'Run the command below to see the full output, or try again.',
  failedLog: 'Launcher log: {path}',
  gaveUp: 'The server was started but has not answered. Check its window, or run the command below.',
  online: 'The server is up. Loading SynaBun.',
  trailLauncher: 'Launcher started',
  trailTerminal: 'Terminal opened',
  trailProcess: 'Supervisor started',
  trailSupervisor: 'Supervisor running',
  trailServer: 'Server process started',
  trailListening: 'Server listening',
  elapsedLabel: 'Time since Start was pressed',
  headingStarting: 'Starting the server',
  headingReady: 'Server is up',
  headingFailed: 'The server did not start',
};

/** `{name}` placeholders, like the app's t(). */
export function formatStartText(template, params) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (all, key) => (params && params[key] != null ? String(params[key]) : all));
}

/** 7 s · 1 min 05 s. Whole seconds: the page's own clock, nothing finer is claimed. */
export function formatStartElapsed(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (total < 60) return `${total} s`;
  return `${Math.floor(total / 60)} min ${String(total % 60).padStart(2, '0')} s`;
}

/** 0.4 s for a step's own time: these come with milliseconds. */
function startStepSeconds(ms) {
  const value = Math.max(0, Number(ms) || 0) / 1000;
  return value < 10 ? `${value.toFixed(1)} s` : `${Math.round(value)} s`;
}

/**
 * Everything a surface renders for one snapshot, as data:
 *   mascot    'asleep' | 'waking' | 'working' | 'ready' | 'failed' | 'stalled'
 *   busy      the button is disabled (a start is under way)
 *   button    'start' | 'starting' | 'retry'
 *   headline  { key, params } | null   the status sentence (the live region)
 *   hint      { key, params } | null   a second, quieter sentence
 *   elapsed   '12 s' | ''              the page's clock since the click
 *   trail     [{ key, time }]          what was reported, with when
 *   error     { message, log } | null
 * A headline names a step only when the snapshot holds the report of it.
 */
export function startStatusView(snap, { platform = 'linux', limits = START_LIMITS } = {}) {
  const state = snap?.state || 'idle';
  const launchOf = snap?.launch || null;
  const sup = launchOf?.supervisor || null;
  const view = {
    state,
    mascot: 'asleep',
    busy: state === 'launching' || state === 'starting' || state === 'waiting',
    button: 'start',
    headline: null,
    hint: null,
    elapsed: '',
    trail: [],
    error: null,
  };
  if (view.busy) {
    view.button = 'starting';
    view.elapsed = formatStartElapsed(snap.elapsedMs);
  }

  // The reported steps, each at the time it was reported for, counted from the
  // click (or from the launch's own start when another page asked for it).
  if (launchOf) {
    const asked = snap.askedAt !== null && snap.askedAt !== undefined && launchOf.startedAt >= snap.askedAt - 2000;
    const zero = asked ? snap.askedAt : launchOf.startedAt;
    const add = (key, at) => { if (at) view.trail.push({ key, time: startStepSeconds(at - zero) }); };
    add('trailLauncher', launchOf.startedAt);
    for (const step of launchOf.steps) {
      if (step.id === 'terminal') add('trailTerminal', step.at);
      if (step.id === 'spawned') add('trailProcess', step.at);
    }
    if (sup) {
      add('trailSupervisor', sup.startedAt);
      const first = (phase) => sup.phases.find(p => p.phase === phase)?.at || (sup.phase === phase ? sup.at : 0);
      add('trailServer', first('server'));
      add('trailListening', first('listening'));
    }
  }

  if (state === 'online') {
    view.mascot = 'ready';
    view.headline = { key: 'online', params: {} };
    return view;
  }
  if (state === 'launching') {
    view.mascot = 'waking';
    view.headline = { key: 'asked', params: {} };
    return view;
  }
  if (state === 'waiting') {
    view.mascot = 'waking';
    view.headline = { key: platform === 'mac' ? 'unconfirmedMac' : platform === 'windows' ? 'unconfirmedWindows' : 'unconfirmedLinux', params: {} };
    return view;
  }
  if (state === 'stalled') {
    view.mascot = 'stalled';
    view.headline = launchOf?.state === 'gave-up' ? { key: 'gaveUp', params: {} } : { key: 'stalled', params: {} };
    return view;
  }
  if (state === 'failed') {
    view.mascot = 'failed';
    view.button = 'retry';
    const reason = launchOf?.error?.message || '';
    view.headline = { key: 'failed', params: { reason } };
    view.hint = { key: 'failedHint', params: {} };
    view.error = { message: reason, log: launchOf?.log || '' };
    return view;
  }
  if (state === 'starting' && launchOf) {
    view.mascot = 'working';
    const quiet = Math.floor(launchOf.quietMs / 1000);
    const isQuiet = launchOf.quietMs >= limits.quietAfterMs;
    if (launchOf.state === 'started') {
      view.headline = { key: 'answered', params: {} };
    } else if (sup && sup.phase !== 'failed') {
      const megabytes = sup.detail.bytes !== null ? Math.round(sup.detail.bytes / 1048576) : null;
      if (sup.phase === 'snapshot' && sup.detail.files !== null && megabytes !== null) {
        view.headline = { key: 'snapshotSized', params: { files: sup.detail.files, megabytes } };
      } else {
        view.headline = { key: sup.phase, params: {} };
      }
      // Slow on purpose (an install, a download, a backup): silence there is expected.
      const slow = ['dependencies', 'browser', 'build', 'snapshot'].includes(sup.phase);
      if (isQuiet && !slow) view.hint = { key: 'quiet', params: { seconds: quiet } };
    } else if (launchOf.step === 'terminal') {
      view.headline = isQuiet ? { key: 'terminalQuiet', params: { seconds: quiet } } : { key: 'terminalOpened', params: {} };
    } else if (launchOf.step === 'spawned') {
      view.headline = { key: 'processStarted', params: {} };
      if (isQuiet) view.hint = { key: 'quiet', params: { seconds: quiet } };
    } else {
      view.headline = { key: 'launcherRunning', params: {} };
      if (isQuiet) view.hint = { key: 'quiet', params: { seconds: quiet } };
    }
    return view;
  }
  return view;
}
