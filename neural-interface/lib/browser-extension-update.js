// Update progress for the owner. The durable install marker survives a restart. An attempt lives only in
// the process that sent the command. An acknowledgement is never proof that the new copy is running.
import { compareVersions } from './browser-extension-folder.js';
import { SELF_RELOAD_SINCE } from './browser-extension-protocol.js';
import { extensionVersions } from './browser-extension-setup.js';

export const RECONNECT_WAIT_MS = 45_000;
export function createExtensionUpdate({ bridge, pkg, runsActive, now = Date.now }) {
  let attempt = null, observed = null;

  function status(peer = bridge.status(), disk = pkg.status()) {
    const { connected, extensionVersion: runningVersion } = peer;
    const { folderVersion, pinnedVersion } = disk;
    const targetVersion = disk.needs === 'update' ? pinnedVersion : folderVersion || pinnedVersion;
    if (attempt?.target !== targetVersion) attempt = null;
    if (observed?.target !== targetVersion) observed = null;
    // Explicit repair confirmation (or the setup page's port check) also clears the prompt while offline.
    if (attempt && attempt.reason !== 'version' && !disk.reloadPending) attempt = null;
    if (!connected && observed?.reason && observed.reason !== 'version' && !disk.reloadPending) observed = null;
    const flags = extensionVersions({ ...disk, connected, extensionVersion: runningVersion });
    const reason = disk.reloadReason || 'version';
    const view = { phase: 'idle', runningVersion, folderVersion, pinnedVersion, targetVersion, reason,
      fromVersion: runningVersion || observed?.from || disk.fromVersion || (disk.needs === 'update' ? folderVersion : null),
      canReload: false, runsActive: runsActive(), claimedTabs: peer.tabs.filter(tab => tab.owner).length };
    if (disk.needs === 'update' || flags.updateNeeded || (disk.needs === 'unsafe' && (peer.paired || folderVersion))) {
      observed = { target: targetVersion, from: runningVersion || disk.fromVersion || folderVersion };
      attempt = null;
      if (disk.phase === 'failed') return { ...view, phase: 'failed', recovery: 'download', code: disk.code };
      const percent = disk.total > 0 ? Math.min(100, Math.max(0, Math.floor(100 * disk.received / disk.total))) : 0;
      return { ...view, phase: 'downloading', pending: disk.phase === 'idle', percent };
    }
    if (disk.needs || !folderVersion) return view; // a first install belongs to setup
    if (flags.reloadNeeded && (observed?.reason !== reason || observed.done)) {
      observed = { target: targetVersion, reason, from: runningVersion || disk.fromVersion };
    }
    if (attempt && !attempt.code && now() >= attempt.until) attempt.code = 'RELOAD_TIMEOUT';
    if (attempt?.code) return { ...view, phase: 'failed', recovery: 'guided', code: attempt.code };
    if (attempt) return { ...view, phase: 'reloading' };
    if (flags.reloadNeeded || (observed && peer.paired && !connected && !observed.done)) {
      return { ...view, phase: 'ready', confirmBusy: !!observed?.confirmBusy, canReload: connected && !observed?.verify && compareVersions(runningVersion, SELF_RELOAD_SINCE) >= 0 };
    }
    if (observed && connected && runningVersion === targetVersion) {
      observed.done = true;
      return { ...view, phase: 'done' };
    }
    return view;
  }

  // Called once for the first authenticated inventory on each socket, even with no owner page open.
  function connected(version) {
    const disk = pkg.status();
    if (disk.needs || version !== disk.folderVersion) {
      if (attempt) attempt.code = 'RELOAD_OLD_VERSION';
      return;
    }
    if (disk.reloadReason === 'version' && pkg.confirmVersion(version)) {
      observed = { target: version, from: disk.fromVersion, done: true };
    } else if (attempt) {
      // A same-version repair still needs the owner's confirmation. A port change needs setup/seen.
      observed = { target: version, from: attempt.from, reason: attempt.reason, verify: !!disk.reloadPending, done: !disk.reloadPending };
    }
    attempt = null;
  }

  function reload({ targetVersion, allowBusy = false }) {
    const view = status();
    const refuse = code => ({ ok: false, code, update: view });
    if (!targetVersion || targetVersion !== view.targetVersion) return refuse('UPDATE_CHANGED');
    if (view.phase === 'reloading' || view.phase === 'done') return { ok: true, update: view };
    if (!view.canReload) return refuse('EXTENSION_RELOAD_REQUIRED');
    if (!allowBusy && (view.claimedTabs || view.runsActive)) return refuse('RELOAD_BUSY');
    const own = { target: targetVersion, reason: view.reason, from: view.runningVersion, until: now() + RECONNECT_WAIT_MS };
    attempt = own;
    const failed = code => {
      if (attempt !== own) return;
      // The old worker can close its socket just after the ack was queued. Only the new hello settles that case.
      if (code === 'NOT_CONNECTED' || code === 'EXTENSION_NOT_CONNECTED') return;
      if (code === 'RELOAD_BUSY') { observed.confirmBusy = true; attempt = null; return; }
      own.code = 'RELOAD_FAILED';
    };
    bridge.publishUpdate?.();
    bridge.request('selfReload', null, 'owner', { allowBusy }).then(result => {
      if (!result.ok) failed(result.code);
    }, error => failed(error?.code));
    return { ok: true, update: { ...view, phase: 'reloading', canReload: false } };
  }
  return { status, connected, reload };
}

// Mounted behind the bridge's owner/page-secret middleware. Even a browser granted general automation owner
// access cannot send this command. A read or a request missing the explicit click's target has no effect.
export function ownerReloadHandler({ update, isAutomationBrowser }) {
  return (req, res) => {
    const headers = req.headers;
    if (isAutomationBrowser(req) || !/^https?:\/\//i.test(headers.origin || '') || headers['x-synabun-ui'] !== '1'
      || (headers['sec-fetch-site'] !== undefined && headers['sec-fetch-site'] !== 'same-origin')) {
      return res.status(403).json({ ok: false, code: 'OWNER_ROUTE' });
    }
    const { targetVersion, allowBusy } = req.body || {};
    if (typeof targetVersion !== 'string' || typeof allowBusy !== 'boolean') return res.status(400).json({ ok: false, code: 'INVALID_MESSAGE' });
    const result = update.reload({ targetVersion, allowBusy });
    return res.status(result.ok ? 200 : 409).json(result);
  };
}
