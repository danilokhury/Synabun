// Shared words and actions for Settings, the setup page, the notification and the Assistant.
const releaseNotes = { '1.5.0': 'notes.v1_5_0' };
const downloadErrors = {
  EXTENSION_DOWNLOAD_OFFLINE: 'offline', EXTENSION_DOWNLOAD_UNAVAILABLE: 'unavailable',
  EXTENSION_VERIFY_FAILED: 'unverified', EXTENSION_FOLDER_UNSAFE: 'unsafe',
  EXTENSION_DOWNLOAD_CANCELLED: 'cancelled',
};
export function extensionUpdateView(update, tx) {
  if (!update?.targetVersion || !['downloading', 'ready', 'reloading', 'failed', 'done'].includes(update.phase)) return null;
  const { phase, reason, recovery, code, targetVersion: version } = update;
  const from = update.runningVersion || update.fromVersion;
  const params = { from, version, percent: update.percent ?? 0 };
  const t = key => tx(`browserExtension.updateFlow.${key}`, params);
  const done = phase === 'done';
  const same = from && from === version;
  const title = done ? t('done') : from && !same ? t('versions')
    : reason === 'repair' ? t('repairTitle') : reason === 'port' ? t('portTitle') : t('target');
  const notes = !done && reason === 'version' && !same && Object.hasOwn(releaseNotes, version) ? t(releaseNotes[version]) : '';
  const guided = (phase === 'ready' && !update.canReload) || (phase === 'failed' && recovery === 'guided');
  let message = '';
  if (phase === 'downloading') message = t(update.pending ? 'pending' : update.percent === 100 ? 'verifying' : 'progress');
  if (phase === 'reloading') message = t('reloading');
  if (phase === 'ready') message = t(reason === 'repair' ? 'repaired' : reason === 'port' ? 'port' : update.canReload ? 'ready' : 'manual');
  if (phase === 'failed') message = t(guided ? (code === 'RELOAD_OLD_VERSION' ? 'oldVersion' : code === 'RELOAD_TIMEOUT' ? 'timeout' : 'reloadFailed') : downloadErrors[code] || 'downloadFailed');
  return {
    title, message, notes, due: !done, guided, updateNow: phase === 'ready' && update.canReload,
    download: phase === 'downloading' && update.pending,
    retry: phase === 'failed' && recovery === 'download',
    busy: !!(update.claimedTabs || update.runsActive || update.confirmBusy),
    confirmRepair: reason === 'repair' && (phase === 'ready' || guided),
    checkPort: reason === 'port' && (phase === 'ready' || guided),
    key: `${version}/${reason}`,
  };
}
