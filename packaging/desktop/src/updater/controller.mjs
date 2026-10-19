/**
 * The update state every surface shows (the interface's badge, notice and
 * dialog, the app menu, the tray), and the only place that moves it. Pure: the
 * platform work is an adapter (mac.mjs, electron-updater-adapter.mjs), the app
 * is a host; both are injected, so the whole flow is tested in
 * packaging/tests/desktop-updater.test.mjs.
 *
 *   idle → checking → not-available | available → downloading → downloaded → installing
 *                   ↘ error
 *
 * Updates install themselves. A check that finds a newer version downloads it
 * at once, and a downloaded update installs at a safe moment (`auto`):
 *
 *   waiting     something runs (host.activity(): agent runs and dispatches,
 *               side-panel replies, loops and schedules, or no answer at all):
 *               asked again every ACTIVITY_POLL_MS
 *   countdown   SynaBun is idle: the notice counts COUNTDOWN_MS down, with
 *               Later, then the app installs and opens the new version
 *   postponed   Later: no countdown for POSTPONE_MS, then waiting again
 *
 * Install now skips the countdown, never the wait: running work is not ended
 * for an update. Quitting installs a downloaded update (installOnQuit), and a
 * copy that starts with one downloaded installs it before its server
 * (installAtLaunch). An install that fails keeps the version that runs; that
 * version is tried again automatically only at a check RETRY_AFTER_MS later,
 * and MAX_ATTEMPTS times at most, so a broken update never loops.
 *
 * Only a copy that can replace itself installs on its own (install mode
 * 'restart'). A macOS copy in a temporary place or a folder it cannot write
 * (move-to-applications, manual-download) still shows the offer and waits for
 * the user.
 */

export const CHECK_DELAY_MS = 30 * 1000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** How long the notice counts down before SynaBun restarts into the update. */
export const COUNTDOWN_MS = 60 * 1000;
/** Later: how long no countdown is shown. */
export const POSTPONE_MS = 60 * 60 * 1000;
/** How often a downloaded update asks whether SynaBun is idle. */
export const ACTIVITY_POLL_MS = 5 * 1000;
/** A version whose install failed installs on its own again only at a check this much later (the 6-hourly one). */
export const RETRY_AFTER_MS = 3 * 60 * 60 * 1000;
/** Automatic installs of one version, at most. */
export const MAX_ATTEMPTS = 3;
/** Where a person downloads SynaBun by hand. */
export const RELEASES_URL = 'https://github.com/danilokhury/Synabun/releases/latest';
const PROGRESS_EVERY_MS = 250;

/** Errors that mean "the latest release has no build for this platform": no update, quietly. */
const NO_UPDATE_CODES = new Set(['ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', 'NO_DESKTOP_BUILD', 'HTTP_404']);
const NETWORK = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|net::ERR_|socket hang up|fetch failed|network/i;
/**
 * What host.activity() may name as running: the server's own kinds
 * (neural-interface/lib/system-activity.js ACTIVITY_KINDS; a test keeps them
 * equal) and `test`, the end-to-end test's switch. Anything else reads as `unknown`.
 */
export const BUSY_KINDS = Object.freeze([
  'assistant', 'claude-panel', 'codex-panel', 'opencode-panel', 'claude-cli', 'loop', 'schedule', 'backup', 'maintenance', 'unknown', 'test',
]);

/** The sentence for an error, by what kind of error it is. */
export function describeUpdateError(error, t, { stage = 'check' } = {}) {
  const code = String(error?.code || '');
  const message = String(error?.message || error || '').split('\n')[0].slice(0, 240);
  if (error?.userMessage) return String(error.userMessage);
  if (code === 'CHECKSUM' || /sha512 checksum mismatch|checksum/i.test(message)) return t('errorChecksum');
  if (code === 'FEED_INVALID' || code === 'ERR_UPDATER_INVALID_UPDATE_INFO' || code === 'ERR_UPDATER_INVALID_VERSION') return t('errorFeed');
  if (NETWORK.test(code) || NETWORK.test(message)) return t('errorNetwork');
  if (stage === 'install') return t('errorInstall', { reason: message || code || 'unknown error' });
  if (stage === 'download') return t('errorDownload', { reason: message || code || 'unknown error' });
  return t('errorFeed');
}

export function isNoUpdateError(error) {
  return NO_UPDATE_CODES.has(String(error?.code || '')) || Number(error?.statusCode) === 404;
}

/**
 * What host.activity() said, made safe: `{ idle, busy: [{ kind, count }] }`.
 * No answer, a malformed one or an error is not idle: SynaBun cannot tell, so it waits.
 */
export function readActivity(answer) {
  if (!answer || typeof answer !== 'object' || typeof answer.idle !== 'boolean') return { idle: false, busy: [{ kind: 'unknown', count: 1 }] };
  const busy = (Array.isArray(answer.busy) ? answer.busy : [])
    .filter(item => item && typeof item === 'object')
    .map(item => ({ kind: BUSY_KINDS.includes(item.kind) ? item.kind : 'unknown', count: Math.max(1, Math.floor(Number(item.count)) || 1) }))
    .slice(0, 12);
  if (answer.idle && !busy.length) return { idle: true, busy: [] };
  return { idle: false, busy: busy.length ? busy : [{ kind: 'unknown', count: 1 }] };
}

const sameBusy = (a = [], b = []) => a.length === b.length && a.every((item, index) => item.kind === b[index].kind && item.count === b[index].count);

export function createUpdateController({
  adapter, host, t, now = () => Date.now(), timers = { setTimeout, clearTimeout, setInterval, clearInterval },
}) {
  const iso = (ms) => new Date(ms).toISOString();
  let state = {
    supported: !!adapter?.supported,
    status: 'idle',
    current: String(host.current || ''),
    latest: null,
    notes: null,
    releaseDate: null,
    progress: null,
    error: null,
    checkedAt: null,
    install: adapter?.supported ? adapter.installMode() : 'restart',
    manualFile: null,
    testFeed: !!adapter?.testFeed,
    auto: null,
    updated: host.updated?.version ? { version: String(host.updated.version), previous: host.updated.previous ? String(host.updated.previous) : null } : null,
    releasesUrl: RELEASES_URL,
  };
  const listeners = new Set();
  let checking = null;
  let downloading = null;
  let installing = false;
  let lastProgressAt = 0;
  let ticking = false;
  let wantNow = false;
  // installAtLaunch() decides itself what follows its download.
  let holdAuto = false;
  const scheduled = [];
  let poll = null;
  let alarm = null;

  const set = (patch) => {
    state = { ...state, ...patch };
    for (const listener of listeners) {
      try { listener(state); } catch {}
    }
    return state;
  };

  const log = (line) => { try { host.log?.(line); } catch {} };

  // ── Failed installs: never a loop ──

  const readAttempts = () => {
    try {
      const record = host.attempts?.read?.();
      return record && typeof record === 'object' && record.version ? record : null;
    } catch { return null; }
  };
  const writeAttempts = (record) => { try { host.attempts?.write?.(record); } catch {} };

  /** True when `version` may not install by itself now: it failed lately, or too often. */
  function held(version) {
    const record = readAttempts();
    if (!record || String(record.version) !== String(version)) return false;
    const count = Number(record.count) || 0;
    if (count >= MAX_ATTEMPTS) return true;
    return count > 0 && !!record.error && now() - (Date.parse(record.lastAt) || 0) < RETRY_AFTER_MS;
  }

  /** An install of `version` starts: it counts, whatever happens next. */
  function countAttempt(version, trigger) {
    const record = readAttempts();
    const count = record && String(record.version) === String(version) ? (Number(record.count) || 0) + 1 : 1;
    writeAttempts({ version: String(version), count, lastAt: iso(now()), trigger, error: null });
  }

  function attemptFailed(version, message) {
    const record = readAttempts();
    const count = record && String(record.version) === String(version) ? Math.max(1, Number(record.count) || 0) : 1;
    writeAttempts({ version: String(version), count, lastAt: iso(now()), trigger: record?.trigger || null, error: String(message || '') });
  }

  // ── The automatic install ──

  const autoInstalls = () => adapter.installMode() === 'restart' && !state.manualFile;

  function stopAuto() {
    if (poll) { try { timers.clearInterval(poll); } catch {} poll = null; }
    if (alarm) { try { timers.clearTimeout(alarm); } catch {} alarm = null; }
  }

  function startAuto({ asked = false } = {}) {
    if (state.status !== 'downloaded' || !autoInstalls()) return;
    if (!state.auto) set({ auto: { phase: 'waiting', busy: [], installAt: null, postponedUntil: null, now: asked } });
    else if (asked && !state.auto.now) set({ auto: { ...state.auto, now: true, phase: state.auto.phase === 'postponed' ? 'waiting' : state.auto.phase, postponedUntil: null } });
    if (!poll) {
      poll = timers.setInterval(() => { tick().catch(() => {}); }, ACTIVITY_POLL_MS);
      try { poll?.unref?.(); } catch {}
    }
    tick().catch(() => {});
  }

  async function activity() {
    try { return readActivity(await host.activity?.()); } catch { return readActivity(null); }
  }

  /** One look: is SynaBun idle, and what follows from that. */
  async function tick() {
    if (ticking || installing || state.status !== 'downloaded' || !state.auto) return;
    ticking = true;
    try {
      const auto = state.auto;
      if (auto.phase === 'postponed' && now() < (Date.parse(auto.postponedUntil) || 0)) return;
      const seen = await activity();
      // The state may have moved while the host answered (an install, a quit, Later).
      if (installing || state.status !== 'downloaded' || !state.auto) return;
      const current = state.auto;
      if (current.phase === 'postponed' && now() < (Date.parse(current.postponedUntil) || 0)) return;
      if (!seen.idle) {
        if (current.phase !== 'waiting' || !sameBusy(current.busy, seen.busy)) {
          if (current.phase === 'countdown') log(`update v${state.latest}: work started during the countdown (${seen.busy.map(item => item.kind).join(', ')}): waiting`);
          set({ auto: { ...current, phase: 'waiting', busy: seen.busy, installAt: null, postponedUntil: null } });
          if (alarm) { try { timers.clearTimeout(alarm); } catch {} alarm = null; }
        }
        return;
      }
      if (current.now) {
        log(`update v${state.latest}: idle, installing as asked`);
        ticking = false;
        await install({ trigger: 'now' });
        return;
      }
      if (current.phase === 'countdown') {
        if (now() >= (Date.parse(current.installAt) || 0)) {
          log(`update v${state.latest}: the countdown ended with SynaBun idle: installing`);
          ticking = false;
          await install({ trigger: 'auto' });
        }
        return;
      }
      const installAt = now() + COUNTDOWN_MS;
      log(`update v${state.latest}: SynaBun is idle: restarting into it at ${iso(installAt)} unless Later`);
      set({ auto: { ...current, phase: 'countdown', busy: [], installAt: iso(installAt), postponedUntil: null } });
      if (alarm) { try { timers.clearTimeout(alarm); } catch {} }
      alarm = timers.setTimeout(() => { alarm = null; tick().catch(() => {}); }, COUNTDOWN_MS + 50);
      try { alarm?.unref?.(); } catch {}
    } finally {
      ticking = false;
    }
  }

  // ── Check, download, install ──

  async function check({ manual = false } = {}) {
    if (!state.supported) return state;
    if (checking) return checking;
    // An update on its way or ready is not thrown away by another look.
    if (['downloading', 'downloaded', 'installing'].includes(state.status)) return state;
    const previous = state.status;
    // An automatic look does not hide an update already on offer while it runs.
    if (manual || previous !== 'available') set({ status: 'checking', error: null, install: adapter.installMode() });
    checking = (async () => {
      try {
        const found = await adapter.check();
        if (!found) {
          log(`update check: no newer version than v${state.current}`);
          return set({ status: 'not-available', latest: null, notes: null, releaseDate: null, checkedAt: iso(now()) });
        }
        log(`update check: v${found.version} is available (installed v${state.current})`);
        const offered = {
          latest: found.version, notes: found.notes || null, releaseDate: found.releaseDate || null,
          checkedAt: iso(now()), install: adapter.installMode(), auto: null,
        };
        // A version that failed to install lately waits for a later check, unless the user asks.
        if (!manual && held(found.version)) {
          const record = readAttempts();
          log(`update v${found.version}: its last install failed; it installs by itself again at a later check (attempt ${record?.count || 0} of ${MAX_ATTEMPTS})`);
          return set({ status: 'error', ...offered, error: record?.error || t('errorInstall', { reason: 'unknown error' }) });
        }
        set({ status: 'available', ...offered });
        if (autoInstalls()) download();
        return state;
      } catch (error) {
        if (isNoUpdateError(error)) {
          log(`update check: the latest release has no build for this platform (${error?.code || error?.statusCode || 'not found'})`);
          return set({ status: 'not-available', latest: null, notes: null, checkedAt: iso(now()) });
        }
        log(`update check failed: ${error?.code || ''} ${error?.message || error}`);
        // An automatic check that failed changes nothing anyone sees.
        if (!manual) return set({ status: previous === 'checking' ? 'idle' : previous });
        // No version is on offer after a check that failed: trying again checks again.
        return set({ status: 'error', latest: null, notes: null, releaseDate: null, error: describeUpdateError(error, t, { stage: 'check' }) });
      } finally {
        checking = null;
      }
    })();
    return checking;
  }

  /** Download the version on offer; resolves when it is downloaded or failed. */
  function fetchUpdate() {
    if (!state.supported) return Promise.resolve(state);
    if (downloading) return downloading;
    if (state.status === 'downloaded') return Promise.resolve(state);
    if (state.status !== 'available' && !(state.status === 'error' && state.latest)) return Promise.resolve(state);
    const manual = state.install === 'manual-download';
    set({ status: 'downloading', error: null, auto: null, progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 } });
    downloading = (async () => {
      try {
        const result = await adapter.download({
          manual,
          onProgress: (progress) => {
            const at = now();
            if (at - lastProgressAt < PROGRESS_EVERY_MS && progress.percent < 100) return;
            lastProgressAt = at;
            set({ progress: normalizeProgress(progress) });
          },
        });
        log(`update v${state.latest} downloaded${result?.file ? `: ${result.file}` : ''}`);
        set({ status: 'downloaded', progress: { ...normalizeProgress(state.progress), percent: 100 }, manualFile: manual ? result?.file || null : null });
        if (!manual) { try { host.downloaded?.({ version: state.latest, file: result?.file || null }); } catch {} }
        const asked = wantNow;
        wantNow = false;
        if (!holdAuto) startAuto({ asked });
      } catch (error) {
        wantNow = false;
        log(`update download failed: ${error?.code || ''} ${error?.message || error}`);
        set({ status: 'error', progress: null, error: describeUpdateError(error, t, { stage: 'download' }) });
      } finally {
        downloading = null;
      }
      return state;
    })();
    return downloading;
  }

  /** Start the download; answers at once with the state (the interface's request). */
  function download() {
    fetchUpdate();
    return state;
  }

  /**
   * Install now: at once when SynaBun is idle, otherwise as soon as it is (no
   * countdown then: it was asked for). A copy that cannot replace itself does
   * what its install mode says (move to Applications, show the disk image).
   */
  async function installNow() {
    if (!state.supported) return state;
    if (installing) return state;
    const mode = adapter.installMode();
    if (mode !== 'restart' || state.manualFile) return install({ trigger: 'user' });
    // Not downloaded yet: it installs as soon as it is (and SynaBun is idle).
    if (state.status === 'available' || state.status === 'downloading' || (state.status === 'error' && state.latest)) {
      wantNow = true;
      fetchUpdate();
      return state;
    }
    if (state.status !== 'downloaded') return state;
    const seen = await activity();
    if (seen.idle) return install({ trigger: 'now' });
    log(`update v${state.latest}: Install now waits for ${seen.busy.map(item => item.kind).join(', ')}`);
    set({ auto: { phase: 'waiting', busy: seen.busy, installAt: null, postponedUntil: null, now: true } });
    startAuto({ asked: true });
    return state;
  }

  /** Later: no countdown for a while; the update still installs on quit, at the next start, or when the wait is over. */
  function later() {
    if (state.status !== 'downloaded' || !state.auto) return state;
    if (alarm) { try { timers.clearTimeout(alarm); } catch {} alarm = null; }
    const until = now() + POSTPONE_MS;
    log(`update v${state.latest}: postponed until ${iso(until)}`);
    return set({ auto: { ...state.auto, phase: 'postponed', postponedUntil: iso(until), installAt: null, busy: [], now: false } });
  }

  /** Stops the backend, installs, and quits (the new version opens itself). */
  async function install({ trigger = 'user' } = {}) {
    if (!state.supported) return state;
    if (installing) return trigger === 'user' ? set({ error: t('errorBusy') }) : state;
    const mode = adapter.installMode();
    if (mode === 'move-to-applications') {
      await adapter.moveToApplications();
      return state;
    }
    if (state.status !== 'downloaded') return state;
    if (mode === 'manual-download' || state.manualFile) {
      await adapter.reveal(state.manualFile);
      return state;
    }
    installing = true;
    stopAuto();
    const version = state.latest;
    countAttempt(version, trigger);
    set({ status: 'installing', error: null, auto: null });
    try {
      await host.beforeInstall({ version, trigger });
      await adapter.install({ relaunch: true, version, previous: state.current });
      log(`installing v${version} (${trigger}); the app quits now`);
      host.quitForUpdate();
    } catch (error) {
      installing = false;
      const message = describeUpdateError(error, t, { stage: 'install' });
      attemptFailed(version, message);
      log(`update install failed: ${error?.code || ''} ${error?.message || error}`);
      set({ status: 'error', error: message });
      try { await host.afterFailedInstall?.(); } catch {}
    }
    return state;
  }

  /** While the app quits: a downloaded update is installed, and the app is not opened again. */
  async function installOnQuit() {
    if (!state.supported || installing || state.status !== 'downloaded') return false;
    if (adapter.installMode() !== 'restart' || state.manualFile) return false;
    installing = true;
    stopAuto();
    countAttempt(state.latest, 'quit');
    try {
      await adapter.install({ relaunch: false, version: state.latest, previous: state.current });
      log(`installing v${state.latest} on quit`);
      return true;
    } catch (error) {
      attemptFailed(state.latest, describeUpdateError(error, t, { stage: 'install' }));
      log(`update install on quit failed: ${error?.message || error}`);
      installing = false;
      return false;
    }
  }

  /**
   * A copy that starts with an update downloaded in an earlier run (`version`)
   * installs it before its server starts: nothing runs yet. True when the app
   * is on its way out to install. Otherwise false, and the update goes on the
   * usual way (it installs when SynaBun is idle); so it does when the check and
   * the download from the file on disk take past `until`.
   */
  async function installAtLaunch(version, { until = Infinity } = {}) {
    if (!state.supported || !autoInstalls() || held(version)) return false;
    holdAuto = true;
    try {
      const found = await check();
      if (!['available', 'downloading', 'downloaded'].includes(found.status) || String(state.latest) !== String(version)) return false;
      await fetchUpdate();
      if (state.status !== 'downloaded' || String(state.latest) !== String(version) || now() > until) return false;
      await install({ trigger: 'launch' });
      return state.status === 'installing';
    } finally {
      holdAuto = false;
      if (state.status === 'downloaded' && !installing) startAuto();
    }
  }

  function start({ delayMs = CHECK_DELAY_MS } = {}) {
    if (!state.supported) return;
    scheduled.push(timers.setTimeout(() => { check().catch(() => {}); }, delayMs));
    scheduled.push(timers.setInterval(() => { check().catch(() => {}); }, CHECK_INTERVAL_MS));
  }

  function stop() {
    stopAuto();
    for (const handle of scheduled.splice(0)) {
      try { timers.clearTimeout(handle); } catch {}
      try { timers.clearInterval(handle); } catch {}
    }
  }

  return {
    get state() { return state; },
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    check, download, install, installNow, installOnQuit, installAtLaunch, later, start, stop, tick,
    /** The install of `version` failed after the app had quit (the swap rolled back, the installer failed): the version that runs stays. */
    failed({ version = null, error } = {}) {
      if (version) attemptFailed(version, error);
      return set({ status: 'error', error, latest: version ? String(version) : state.latest });
    },
    /** A note for the user that is not tied to a version. */
    notice(error) { return set({ status: 'error', error }); },
    /** The interface showed "updated to vX": once is enough. */
    acknowledge() { return state.updated ? set({ updated: null }) : state; },
    /** True when `version` waits for a later check after failed installs. */
    held,
  };
}

export function normalizeProgress(progress) {
  const total = Math.max(0, Number(progress?.total) || 0);
  const transferred = Math.max(0, Math.min(Number(progress?.transferred) || 0, total || Infinity));
  const percent = Math.max(0, Math.min(100, Number(progress?.percent) || (total ? (transferred / total) * 100 : 0)));
  return { percent, transferred, total, bytesPerSecond: Math.max(0, Number(progress?.bytesPerSecond) || 0) };
}
