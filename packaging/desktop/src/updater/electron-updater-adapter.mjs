/**
 * The Windows and Linux adapter of the update controller: electron-updater
 * reads the feed and downloads (with its sha512 check, and a blockmap when it
 * can use one). Installing is the app's own:
 *
 *   Windows  the install watchdog (windows.mjs, win-swap.mjs) moves the
 *            installed copy aside, runs the downloaded per-user NSIS installer
 *            silently into the same folder (no administrator rights; an
 *            unsigned build works: the build writes no publisherName, so
 *            nothing checks a publisher), checks the result, opens the new
 *            version, and puts the old copy back if anything fails. The app
 *            stops its backend first: Windows cannot replace a node.exe that runs.
 *   Linux    AppImageUpdater downloads the new image; the app puts it in the
 *            place of the running one under the same path (updater/linux.mjs),
 *            so every registration that names the image keeps working, and
 *            opens it once this process has ended.
 *
 * Which version counts as newer is SynaBun's rule (feed.mjs isNewer):
 * electron-updater compares plain semver, and a date-style Dev build
 * (2026.9.8, from before 2026-10-17) would look newer than every 2.x
 * release. It is therefore told to accept any version, and isUpdateSupported
 * lets through only a newer one.
 * Downloading and installing on its own stay off: the controller decides when
 * (controller.mjs), and the app stops its server before any install.
 *
 * The autoUpdater object is handed in, so this is tested with a stand-in.
 */

import { isNewer, notesText } from './feed.mjs';

export function createElectronUpdaterAdapter({
  autoUpdater, platform = process.platform, feed, current, log = () => {}, installAppImage, installWindows, supported = true,
}) {
  if (!autoUpdater || !supported) {
    return { supported: false, testFeed: !!feed?.test, installMode: () => 'restart', check: async () => null, download: async () => ({}), install: async () => {}, moveToApplications: async () => {}, reveal: async () => {} };
  }
  autoUpdater.autoDownload = false;
  // Installing on quit is the app's decision (it stops its backend first).
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.autoRunAppAfterInstall = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = true;
  const osCheck = typeof autoUpdater.checkIfUpdateSupported === 'function' ? autoUpdater.checkIfUpdateSupported.bind(autoUpdater) : () => true;
  autoUpdater.isUpdateSupported = (info) => osCheck(info) && isNewer(current, info?.version);
  autoUpdater.logger = { info: line => log(`updater: ${line}`), warn: line => log(`updater warning: ${line}`), error: line => log(`updater error: ${line}`), debug: () => {} };
  if (feed?.test) autoUpdater.setFeedURL({ provider: 'generic', url: feed.url });
  let downloaded = null;

  return {
    supported: true,
    testFeed: !!feed?.test,
    installMode: () => 'restart',
    async check() {
      const result = await autoUpdater.checkForUpdates();
      if (!result || result.isUpdateAvailable === false) return null;
      const info = result.updateInfo || {};
      if (!isNewer(current, info.version)) return null;
      return { version: String(info.version), notes: notesText(info.releaseNotes), releaseDate: info.releaseDate || null };
    },
    async download({ onProgress }) {
      const listener = (progress) => onProgress(progress || {});
      autoUpdater.on('download-progress', listener);
      try {
        const files = await autoUpdater.downloadUpdate();
        downloaded = Array.isArray(files) ? files[0] : null;
        return { file: downloaded };
      } finally {
        autoUpdater.removeListener?.('download-progress', listener);
      }
    },
    async install({ relaunch, version, previous, installId = null }) {
      if (platform === 'win32') {
        const installer = autoUpdater.installerPath || downloaded;
        if (!installer) throw new Error('the downloaded installer is gone; download it again');
        await installWindows({ installer, relaunch, version, previous, installId });
        return;
      }
      if (!downloaded) throw new Error('the downloaded image is gone; download it again');
      await installAppImage({ downloaded, relaunch, version, previous, installId });
    },
    moveToApplications: async () => {},
    reveal: async () => {},
  };
}
