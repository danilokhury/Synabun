// ═══════════════════════════════════════════
// SynaBun Neural Interface — one CLI's install state, for a side panel (no DOM)
// ═══════════════════════════════════════════
//
// What a panel needs to show for its CLI and to act on it: the latest answer of
// /api/system/tool-versions (cli-status.js), an install this page started or
// follows (POST /api/cli/install/:tool, or one another window started), a
// "failed to start" a session reported, Add to PATH, Re-check. One controller
// per panel; `onChange(view)` hears every change, `view()` is
// cli-install-view.js cliBannerView() plus `checking` (a Re-check is under way)
// and `nudging` (a held-back send asked for attention a moment ago).
//
// ui-cli-banner.js paints it as the Claude, Codex and OpenCode panels' banner;
// the Antigravity panel paints it as its setup card (agy/agy-setup.js).

import { subscribeCliStatus, recheckCliStatus, getCliDocUrl, getCliInstallCommand, getCliLabel, installCli, followCliInstall, getCliInstallJobs, addCliToPath } from './cli-status.js';
import { cliBannerView, cliInstallText, cliStateOf, reduceInstallJob, INSTALLABLE_CLIS } from './cli-install-view.js';

/** How long the note about where an install put the CLI stays, when it has one. */
export const DONE_NOTICE_MS = 12000;
export const NUDGE_MS = 700;

/**
 * @param {object} o
 * @param {string} o.toolKey 'claude-code' | 'codex' | 'opencode' | 'antigravity'
 * @param {(view: object) => void} [o.onChange]
 * @param {number} [o.doneNoticeMs]
 * @param {number} [o.nudgeMs]
 */
export function createCliInstallController({ toolKey, onChange = () => {}, doneNoticeMs = DONE_NOTICE_MS, nudgeMs = NUDGE_MS } = {}) {
  let info = null;        // this CLI in the latest answer of /api/system/tool-versions (null: none yet)
  let forced = null;      // { reason }: a session could not start it, and the server was not asked again yet
  let job = null;         // the install under way or just ended (cli-install-view.js reduceInstallJob)
  let installing = false;
  let addingPath = false;
  let pathError = '';
  let checking = false;
  let looked = false;     // asked whether the server is already installing it since it went missing
  let doneTimer = null;
  let nudgeTimer = null;
  let destroyed = false;

  const view = () => ({
    ...cliBannerView({
      toolKey,
      label: getCliLabel(toolKey),
      info,
      forced,
      job,
      addingPath, pathError,
      guideUrl: getCliDocUrl(toolKey),
      installCommand: getCliInstallCommand(toolKey),
    }, { t: cliInstallText }),
    checking,
    nudging: !!nudgeTimer,
    job,
    info,
  });

  const changed = () => {
    if (destroyed) return;
    try { onChange(view()); } catch (error) { console.error('[cli-install] onChange:', error); }
  };

  function clearDone() {
    clearTimeout(doneTimer);
    doneTimer = null;
    if (job?.phase === 'done') job = null;
    changed();
  }

  function apply(event) {
    if (!job && event?.type !== 'start') job = reduceInstallJob(null, { type: 'start' });
    job = reduceInstallJob(job, event);
    if (event?.type === 'done' && event.ok && event.status && typeof event.status === 'object') {
      info = event.status;
      forced = null;
    }
    changed();
  }

  function settle(final) {
    if (job?.phase === 'running' && final) job = reduceInstallJob(job, final);
    if (job?.phase === 'done') {
      clearTimeout(doneTimer);
      const where = job.path;
      if (where && (where.onPath === false || where.added === true)) doneTimer = setTimeout(clearDone, doneNoticeMs);
      else job = null;
    }
    changed();
  }

  async function install() {
    if (installing || !INSTALLABLE_CLIS.includes(toolKey)) return null;
    installing = true;
    clearTimeout(doneTimer);
    job = reduceInstallJob(null, { type: 'start' });
    changed();
    let final = null;
    try {
      final = await installCli(toolKey, { onEvent: apply });
    } catch (error) {
      final = { type: 'done', ok: false, code: 'internal', error: error?.message || null };
    } finally {
      installing = false;
      settle(final);
    }
    return final;
  }

  async function addPath() {
    if (addingPath) return;
    addingPath = true; pathError = ''; changed();
    try {
      const result = await addCliToPath(toolKey);
      info = { ...info, pathStatus: { dir: result.dir, onPath: true, canAdd: false } };
      job = reduceInstallJob(null, { type: 'done', ok: true, status: info, path: { ...result, added: true } });
      settle();
    } catch (error) { pathError = error.message; }
    finally { addingPath = false; changed(); }
  }

  // An install the server is already running (another window started it, or this page was reloaded during
  // one): followed here as if this page had started it.
  async function followRunning() {
    if (installing) return;
    const jobs = await getCliInstallJobs();
    if (destroyed || installing || jobs?.[toolKey]?.state !== 'running') return;
    installing = true;
    job = reduceInstallJob(null, { type: 'start' });
    changed();
    let final = null;
    try {
      final = await followCliInstall(toolKey, { onEvent: apply });
    } catch (error) {
      final = { type: 'done', ok: false, code: 'connection', error: error?.message || null };
    } finally {
      installing = false;
      settle(final);
    }
  }

  async function recheck() {
    if (checking) return info;
    checking = true;
    // Asking again starts over: an earlier failure is not repeated over a fresh answer.
    if (job?.phase === 'failed') job = null;
    changed();
    try {
      const next = await recheckCliStatus(toolKey);
      info = next || info;
      if (cliStateOf(info) === 'installed' || cliStateOf(info) === 'broken') forced = null;
    } catch { /* the view stays as it is */ }
    finally {
      checking = false;
      changed();
    }
    return info;
  }

  const unsubscribe = subscribeCliStatus(toolKey, (next) => {
    info = next || null;
    const state = cliStateOf(info);
    if (state === 'installed') {
      forced = null;
      if (job?.phase === 'failed') job = null;
    }
    if (state === 'missing') {
      if (!looked) { looked = true; followRunning().catch(() => {}); }
    } else {
      looked = false;
    }
    changed();
  });

  return {
    view,
    /** Tell `onChange` again (the panel was shown, or rebuilt). */
    refresh: changed,
    /** Sending is held back: the CLI is missing, broken, failed to install, or being installed. */
    blocked: () => view().blocked,
    /** A send was held back: `nudging` is true for a moment. */
    nudge() {
      if (!view().show) return;
      clearTimeout(nudgeTimer);
      nudgeTimer = setTimeout(() => { nudgeTimer = null; changed(); }, nudgeMs);
      changed();
    },
    /**
     * A session could not start the CLI ("CLI not found", a spawn error): "failed to start" with its words at
     * once, then the server is asked again; its answer decides what stays.
     */
    flagFailure(reason = null) {
      forced = { reason: reason ? String(reason).slice(0, 300) : null };
      changed();
      recheckCliStatus(toolKey)
        .then((next) => {
          info = next || info;
          const state = cliStateOf(info);
          if (state === 'installed' || state === 'broken') forced = null;
          changed();
        })
        .catch(() => {});
    },
    install,
    recheck,
    addPath,
    clearDone,
    /** Whether an install runs from this page now. */
    installing: () => installing,
    destroy() {
      destroyed = true;
      unsubscribe();
      clearTimeout(doneTimer);
      clearTimeout(nudgeTimer);
    },
  };
}
