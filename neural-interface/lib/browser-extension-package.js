// Where the extension's files come from: the one package this app release pins (lib/browser-extension-pin.js),
// downloaded from synabun.ai (docs/browser-extension-bridge.md → Where the extension comes from). The extension has
// broad permissions in the owner's browser, so a download is hostile until it is proven to be that exact file:
//
//   transfer   HTTPS only, the one host only (a redirect anywhere else, or to plain http, is not followed), the body
//              as sent (no Content-Encoding: the pinned size bounds the bytes on the wire), nothing larger than the
//              pinned size, a wait for the first byte and between bytes (stallMs) and for the whole transfer
//              (totalMs). It is the hardened transfer of lib/cli-install.js (downloadFile), which aborts the request
//              of every answer it refuses.
//   verify     the size and the SHA-256 must be the pin's, checked over the bytes that are then read, before anything
//              looks inside the file; then SynaBun's one zip form, the pinned version and key, and exactly the files
//              the pin lists (lib/browser-extension-folder.js verifiedPackageFiles).
//   place      lib/browser-extension-folder.js prepareExtensionFolder: under the data home's lock, a staged folder,
//              then two renames (the live folder aside, the new one into its place), recorded so that a stopped
//              process is finished or taken back at the next start.
//
// The folder is held to the pin, never to its marker (inspectExtensionFolder): a folder that is not exactly the
// pinned extension for this port is repaired, from the verified package this data home keeps when it has one (no
// network), else by downloading it again. The port is set from the folder's own files only once they verified.
//
// When it downloads (createExtensionPackage): with no folder yet, only when the owner starts "Connect your browser"
// (`ensure`); with a folder that is not the pinned extension, by itself after start-up (`refreshInBackground`), keeping
// the old folder on any failure. One transfer at a time. Nothing is logged with a path, and the download's working
// file lives beside the folder, never in it.
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { downloadFile } from './cli-install.js';
import { cachedExtensionPackage, confirmExtensionReload, confirmExtensionRepairReload, downloadWorkName, extensionFolderState, extensionWorkDir, inspectExtensionFolder, prepareExtensionFolder, retargetExtensionFolder, verifiedPackageFiles } from './browser-extension-folder.js';
import { EXTENSION_PACKAGE_HOST, EXTENSION_PIN, pinProblems } from './browser-extension-pin.js';

/** What a failed download or check is called (the setup's error codes; lib/browser-extension-setup.js has the words). */
export const PACKAGE_ERROR_CODES = Object.freeze(['EXTENSION_DOWNLOAD_OFFLINE', 'EXTENSION_DOWNLOAD_UNAVAILABLE', 'EXTENSION_VERIFY_FAILED', 'EXTENSION_FOLDER_FAILED', 'EXTENSION_FOLDER_UNSAFE', 'EXTENSION_DOWNLOAD_CANCELLED']);
export const PACKAGE_STALL_MS = 20_000;
export const PACKAGE_TOTAL_MS = 120_000;

const packageError = (code, message, detail) => Object.assign(new Error(message), { code, ...(detail ? { detail } : {}) });
// The transfer's own failure kinds (lib/cli-install.js CLI_INSTALL_ERROR_CODES) as the setup's codes.
const TRANSFER_CODES = Object.freeze({
  offline: 'EXTENSION_DOWNLOAD_OFFLINE', timeout: 'EXTENSION_DOWNLOAD_OFFLINE', interrupted: 'EXTENSION_DOWNLOAD_OFFLINE',
  http: 'EXTENSION_DOWNLOAD_UNAVAILABLE', checksum: 'EXTENSION_VERIFY_FAILED', disk: 'EXTENSION_FOLDER_FAILED', cancelled: 'EXTENSION_DOWNLOAD_CANCELLED',
});

/** Only the pinned host, on the default HTTPS port, with no credentials in the address. */
export function allowedPackageHost(url) {
  return url.protocol === 'https:' && url.hostname === EXTENSION_PACKAGE_HOST && (url.port === '' || url.port === '443') && !url.username && !url.password;
}

// The pinned package's bytes and verified files: { zip, files }. `workDir` holds the transfer's working file, removed
// whatever happens. Throws one of PACKAGE_ERROR_CODES; never writes anything else.
async function downloadPackage({ pin = EXTENSION_PIN, workDir, fetchImpl = fetch, signal, onProgress = () => {}, stallMs = PACKAGE_STALL_MS, totalMs = PACKAGE_TOTAL_MS }) {
  if (pinProblems(pin).length) throw packageError('EXTENSION_VERIFY_FAILED', 'This SynaBun has no valid extension pin.');
  const file = join(workDir, downloadWorkName());
  const stop = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stop.abort(); }, totalMs); timer.unref?.();
  const onAbort = () => stop.abort();
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let zip;
    try {
      await downloadFile({ url: pin.url, allow: allowedPackageHost, destination: file, maxBytes: pin.size, expectedSize: pin.size, sha256: pin.sha256, fetchImpl, signal: stop.signal, onProgress, stallMs,
        accept: 'application/zip, application/octet-stream', identityOnly: true });
    } catch (error) {
      if (timedOut) throw packageError('EXTENSION_DOWNLOAD_OFFLINE', 'The download took too long.', 'timeout');
      throw packageError(TRANSFER_CODES[error?.code] || 'EXTENSION_FOLDER_FAILED', error?.message || 'The download failed.', error?.code === 'http' ? error.detail : error?.code);
    }
    try { zip = readFileSync(file); } catch { throw packageError('EXTENSION_FOLDER_FAILED', 'The download could not be read back.'); }
    // The bytes that are read are the bytes that were checked: size and SHA-256 once more, over what is in memory.
    let files;
    try { files = verifiedPackageFiles(zip, pin); } catch (error) { throw packageError('EXTENSION_VERIFY_FAILED', error?.message || 'The package cannot be read.'); }
    return { zip, files };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    rmSync(file, { force: true });
  }
}

/**
 * The verified files of the pinned package: [{ rel, bytes }]. `workDir` holds the transfer's working file, which is
 * removed whatever happens. Throws one of PACKAGE_ERROR_CODES; never writes anything else.
 */
export async function fetchExtensionPackage(options) { return (await downloadPackage(options)).files; }

/**
 * The owner's extension folder and the package it comes from. `home`: the data home; `appPort`: () => this server's
 * port; `pin`: the release's pin. Returns { status, needs, ensure, refreshInBackground, retarget, confirmReload, confirmRepairReload }.
 */
export function createExtensionPackage({ home, appPort, pin = EXTENSION_PIN, fetchImpl = fetch, now = Date.now, log = () => {}, stallMs = PACKAGE_STALL_MS, totalMs = PACKAGE_TOTAL_MS, io }) {
  const port = () => Number(typeof appPort === 'function' ? appPort() : appPort);
  let job = null;   // the transfer under way: { promise, reason, received, total, stop }
  let last = null;  // how the last one ended: { ok, code, reason, at }

  const look = () => inspectExtensionFolder({ home, appPort: port(), pin });
  /**
   * What the folder needs: 'install' (no folder), 'update' (a folder that is not exactly the pinned extension: another
   * version, or a file changed, added or deleted), 'unsafe' (its root is a link, another user's or writable by others:
   * nothing is done there), or null (the pinned extension; at most its port is set, with no download).
   */
  function needs() {
    const state = look().state;
    return state === 'missing' ? 'install' : state === 'other' ? 'update' : state === 'unsafe' ? 'unsafe' : null;
  }
  function status() {
    const state = extensionFolderState(home), need = needs(), shown = state.present ? state : null;
    const failed = need === 'unsafe' ? { code: 'EXTENSION_FOLDER_UNSAFE', reason: 'check', at: null } : !job && last && !last.ok && need ? last : null;
    return {
      pinnedVersion: pin.version, folderVersion: shown ? shown.version : null, folder: shown ? shown.folder : null, needs: need,
      phase: job ? 'downloading' : failed ? 'failed' : 'idle',
      ...(job ? { received: job.received, total: job.total, reason: job.reason } : {}),
      ...(!job && failed ? { code: failed.code, reason: failed.reason, at: failed.at } : {}),
      // A Reload the folder's marker asks for (a port change, or a repair: lib/browser-extension-folder.js), until the
      // setup page sees the extension running again (confirmReload), or for a repair until the owner confirms it in
      // Settings (confirmRepairReload).
      ...(state.reloadPending ? { reloadPending: true, reloadReason: state.reloadReason } : {}),
    };
  }
  const settle = () => retargetExtensionFolder({ home, appPort: port(), pin, now, io });
  async function run(reason, stop) {
    const workDir = extensionWorkDir(home);
    // A folder this data home can repair or place by itself: the verified package it keeps, with no network.
    const kept = cachedExtensionPackage({ home, pin });
    if (kept) return prepareExtensionFolder({ files: kept, home, appPort: port(), pin, now, io });
    const { zip, files } = await downloadPackage({ pin, workDir, fetchImpl, signal: stop.signal, stallMs, totalMs,
      onProgress: ({ received, total }) => { if (job) { job.received = received; job.total = total || pin.size; } } });
    // A setup the owner cancelled while the last bytes arrived installs nothing.
    if (stop.signal.aborted) throw packageError('EXTENSION_DOWNLOAD_CANCELLED', 'The download was stopped.');
    return prepareExtensionFolder({ files, zip, home, appPort: port(), pin, now, io });
  }
  /**
   * The folder, ready to load: when it is the pinned extension, as it is (its setup port set and verified, no network);
   * else after the pinned package was verified and placed. Resolves what prepareExtensionFolder returns; rejects with
   * one of PACKAGE_ERROR_CODES, leaving the folder that was there in place. `signal` stops the transfer.
   */
  function ensure({ reason = 'setup', signal } = {}) {
    // A transfer that was told to stop is over for whoever asks now (a setup started again): it gets its own, after it.
    if (job?.stop.signal.aborted) {
      const ending = job.promise;
      return ending.then(() => {}, () => {}).then(() => ensure({ reason, signal }));
    }
    if (!job) {
      const need = needs();
      // Its message says why (no path): a link, another user's, others can write it, or a Linux group not proven private.
      if (need === 'unsafe') { const why = look().reason; return Promise.reject(packageError('EXTENSION_FOLDER_UNSAFE', `The extension folder in the data folder is not safe to use${why ? `: ${why}` : ''}.`)); }
      if (!need) {
        // The pinned extension: its port set and the result verified (lib/browser-extension-folder.js), or a failure.
        try {
          const done = settle();
          if (done.state !== 'current') throw packageError('EXTENSION_FOLDER_FAILED', 'The extension folder is not the pinned extension.');
          return Promise.resolve({ folder: done.folder, version: done.version, changed: done.changed, previousVersion: done.version, appPort: port(), stale: false });
        } catch (error) {
          log({ event: 'package', outcome: 'failed', reason: 'port', code: error?.code || 'EXTENSION_FOLDER_FAILED' });
          return Promise.reject(packageError(PACKAGE_ERROR_CODES.includes(error?.code) ? error.code : 'EXTENSION_FOLDER_FAILED', error?.message || 'The extension folder could not be set.'));
        }
      }
      const stop = new AbortController();
      const mine = { reason, received: 0, total: pin.size, stop, promise: null };
      mine.promise = run(reason, stop).then(
        result => { last = { ok: true, reason, at: now() }; log({ event: 'package', outcome: 'installed', reason, version: result.version, changed: result.changed }); return result; },
        error => {
          const code = PACKAGE_ERROR_CODES.includes(error?.code) ? error.code : 'EXTENSION_FOLDER_FAILED';
          // The owner stopped it: nothing failed, and there is nothing to report. A folder that is still not the pinned
          // extension is the exception: its update did not happen, nothing is running, and Settings has to offer Try again.
          const cancelled = code === 'EXTENSION_DOWNLOAD_CANCELLED';
          last = cancelled && needs() !== 'update' ? null : { ok: false, code, reason, at: now() };
          log({ event: 'package', outcome: cancelled ? 'cancelled' : 'failed', reason, code, ...(typeof error?.detail === 'string' ? { detail: error.detail.slice(0, 40) } : {}) });
          throw packageError(code, error?.message || code);
        },
      ).finally(() => { if (job === mine) job = null; });
      job = mine;
    }
    const current = job;
    // A setup stops only a transfer made for a setup: one that joined the background update leaves it running.
    if (signal && current.reason === 'setup') {
      const onAbort = () => current.stop.abort();
      if (signal.aborted) onAbort(); else { signal.addEventListener('abort', onAbort, { once: true }); current.promise.then(() => {}, () => {}).finally(() => signal.removeEventListener('abort', onAbort)); }
    }
    return current.promise;
  }
  return {
    pin, needs, status, ensure,
    /** After start-up: bring a folder that is not the pinned extension up to date. Never downloads for a folder that is not there. */
    refreshInBackground() {
      if (job || needs() !== 'update') return null;
      const promise = ensure({ reason: 'update' });
      promise.catch(() => {});
      return promise;
    },
    /**
     * At start-up (no network): a stopped replacement settled, leftovers removed, the pinned extension's setup port set
     * to this server's, and a changed folder repaired from the verified package this data home keeps. Throws
     * EXTENSION_FOLDER_FAILED / EXTENSION_FOLDER_UNSAFE.
     */
    retarget: settle,
    /** The setup page saw the extension on this port: a Reload a port change asked for is done (never a repair's). */
    confirmReload: () => confirmExtensionReload({ home, appPort: port() }),
    /** The owner confirmed in Settings that they reloaded the extension after a repair: that Reload is done. */
    confirmRepairReload: () => confirmExtensionRepairReload({ home }),
  };
}
