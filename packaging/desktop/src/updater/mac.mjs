/**
 * Updating SynaBun on macOS, signed or not.
 *
 * Squirrel.Mac (electron-updater's MacUpdater) refuses an app without a
 * Developer ID signature, and SynaBun builds are unsigned unless credentials
 * are given. So this is the one macOS path, whatever the signature:
 *
 *   1. read latest-mac.yml from the feed and take the zip for this Mac
 *   2. download it and check its size and sha512 against the feed
 *   3. unpack it beside the installed app (same folder, so the swap is a rename)
 *      and check what came out: our bundle id, the expected version, a
 *      processor this Mac runs, an intact code signature; then run its headless
 *      entry once, so macOS's first-start check is over before the swap
 *      (warmStagedCopy). A copy an earlier run unpacked is used again only when
 *      it is, file by file, byte by byte, the archive whose SHA-512 the feed
 *      gives (stage-check.mjs): an ad hoc signature proves nothing about who
 *      changed a file, since anyone can make one again
 *   4. when SynaBun is idle (controller.mjs), when the user asks, or when the
 *      app quits: a small script outside the app waits for this process to
 *      end, moves the old app aside, moves the new one in its place, and opens
 *      it; the old copy is put back when the swap fails or the new copy does
 *      not start, and removed once it has
 *
 * A copy macOS runs from a temporary location (translocated), or from its disk
 * image, cannot replace itself: the user is offered a move to Applications
 * (app.moveToApplicationsFolder). A copy in a folder it may not write to gets
 * the new disk image downloaded and shown instead.
 *
 * No Electron here: the app hands in what it needs, so this is tested under
 * plain Node (packaging/tests/desktop-updater.test.mjs).
 */

import { createHash } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import {
  accessSync, closeSync, constants, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readdirSync,
  readFileSync, readSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isOnMountedVolume, isTranslocated } from '../paths.mjs';
import { assetUrl, channelFileFor, isNewer, normalizeFeed, pickMacFile } from './feed.mjs';
import { compareFolderWithZip, signatureDifference, treeSignature } from './stage-check.mjs';
import { realFs } from './real-fs.mjs';

/** Removes an unpacked update: through Node's own fs, since Electron's would refuse the app.asar inside it. */
const removeTree = (path) => realFs.rmSync(path, { recursive: true, force: true });

export const BUNDLE_ID = 'ai.synabun.app';
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister';

/** A command, run without a shell, as a promise: { status, stdout, stderr }. Never blocks the app. */
export function runAsync(file, args, { timeoutMs = 10 * 60 * 1000, env = process.env } = {}) {
  return new Promise((done) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = nodeSpawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    } catch (error) {
      done({ status: null, stdout, stderr: String(error?.message || error) });
      return;
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); done({ status: null, stdout, stderr: stderr || String(error?.message || error) }); });
    child.on('close', (status) => { clearTimeout(timer); done({ status, stdout, stderr }); });
  });
}

/** Whether this process may create, rename and remove entries in `folder`. */
export function folderWritable(folder) {
  try { accessSync(folder, constants.W_OK | constants.X_OK); return true; } catch { return false; }
}

/**
 * How an update can be installed for the app at `appPath`:
 *   'restart'               swap it in place and open the new one
 *   'move-to-applications'  first move it out of a temporary location or a disk image
 *   'manual-download'       its folder is not writable: hand over the disk image
 */
export function macInstallMode(appPath, { writable = folderWritable } = {}) {
  if (!appPath || isTranslocated(appPath)) return 'move-to-applications';
  const parent = dirname(appPath);
  if (isOnMountedVolume(appPath) && !writable(parent)) return 'move-to-applications';
  return writable(parent) ? 'restart' : 'manual-download';
}

export function sha512File(path) {
  return new Promise((done, fail) => {
    const hash = createHash('sha512');
    createReadStream(path).on('data', chunk => hash.update(chunk)).on('error', fail).on('end', () => done(hash.digest('base64')));
  });
}

/**
 * Download `url` to `destination`, checking size and sha512 (base64) as it
 * goes. A file already there with the right sha512 is used as it is. Nothing
 * that fails a check is kept.
 */
export async function downloadVerified({ url, destination, sha512, size, fetchImpl = fetch, onProgress = () => {}, signal } = {}) {
  if (existsSync(destination)) {
    if (await sha512File(destination) === sha512) {
      onProgress({ transferred: Number(size) || 0, total: Number(size) || 0, percent: 100, bytesPerSecond: 0 });
      return destination;
    }
    rmSync(destination, { force: true });
  }
  mkdirSync(dirname(destination), { recursive: true });
  const partial = `${destination}.part`;
  rmSync(partial, { force: true });
  const response = await fetchImpl(url, { redirect: 'follow', signal });
  if (!response.ok || !response.body) {
    throw Object.assign(new Error(`the server answered ${response.status} for ${basename(new URL(url).pathname)}`), { statusCode: response.status });
  }
  const hash = createHash('sha512');
  let transferred = 0;
  const started = Date.now();
  const total = Number(size) || Number(response.headers?.get?.('content-length')) || 0;
  const counted = async function* (source) {
    for await (const chunk of source) {
      hash.update(chunk);
      transferred += chunk.length;
      const seconds = Math.max(0.001, (Date.now() - started) / 1000);
      onProgress({ transferred, total, percent: total ? Math.min(100, (transferred / total) * 100) : 0, bytesPerSecond: transferred / seconds });
      yield chunk;
    }
  };
  try {
    await pipeline(Readable.fromWeb(response.body), counted, createWriteStream(partial));
    if (size && transferred !== Number(size)) throw Object.assign(new Error(`the download has ${transferred} bytes, the feed says ${size}`), { code: 'CHECKSUM' });
    if (hash.digest('base64') !== sha512) throw Object.assign(new Error('sha512 checksum mismatch'), { code: 'CHECKSUM' });
    renameSync(partial, destination);
    return destination;
  } finally {
    rmSync(partial, { force: true });
  }
}

/**
 * Where a disk image goes in the user's downloads folder: its own name, or the
 * first "name (n)" that is free. A file there that is not this image is the
 * user's, and is never replaced; the same image already there is used as is.
 */
export async function freeDownloadPath(destination, sha512) {
  const extension = extname(destination);
  const stem = destination.slice(0, destination.length - extension.length);
  for (let n = 0; n < 100; n += 1) {
    const candidate = n ? `${stem} (${n})${extension}` : destination;
    if (!existsSync(candidate) && !existsSync(`${candidate}.part`)) return candidate;
    if (existsSync(candidate) && await sha512File(candidate) === sha512) return candidate;
  }
  throw new Error('no free name for the disk image in the downloads folder');
}

const MACHO = { 0x0100000c: 'arm64', 0x01000007: 'x64' };

/** The processors a Mach-O file runs on (a universal file lists each). */
export function machoArchs(path) {
  const head = Buffer.alloc(4096);
  let size = 0;
  let fd;
  try { fd = openSync(path, 'r'); size = readSync(fd, head, 0, head.length, 0); } catch { return []; } finally { if (fd !== undefined) closeSync(fd); }
  if (size < 8) return [];
  const magic = head.readUInt32BE(0);
  if (magic === 0xcffaedfe) return [MACHO[head.readUInt32LE(4)] || 'other'];
  if (magic === 0xcafebabe) {
    const archs = [];
    for (let i = 0; i < head.readUInt32BE(4) && 8 + i * 20 + 4 <= size; i++) archs.push(MACHO[head.readUInt32BE(8 + i * 20)] || 'other');
    return archs;
  }
  return [];
}

/** What an unpacked update that passed every check records beside itself (reusableStage). */
export const STAGED_RECORD = 'staged.json';

/**
 * An update an earlier run unpacked and checked, for this version, processor
 * and archive (its sha512, as staged.json says), used again without unpacking
 * the archive and verifying the signature once more (half a minute an install at
 * launch would otherwise spend in front of the user), and only when it is still
 * exactly that archive: compareFolderWithZip against `zipPath`, which the caller
 * has just checked against the feed (downloadVerified). staged.json is only a
 * hint: whoever could change the copy could change it too, so even the name of
 * the executable is read again from the copy's own Info.plist. Resolves the
 * stage, or null for anything else (stageMacUpdate then unpacks the archive
 * again in its place).
 */
export async function reusableStage({ appPath, version, arch, zipSha512, zipPath, compare = compareFolderWithZip, run = runAsync, log = () => {} }) {
  if (!appPath || !zipSha512 || !zipPath) return null;
  const stageDir = join(dirname(appPath), `.SynaBun-update-${version}`);
  let record;
  try { record = JSON.parse(readFileSync(join(stageDir, STAGED_RECORD), 'utf8')); } catch { return null; }
  if (!record || record.version !== String(version) || record.arch !== arch || record.zipSha512 !== zipSha512) return null;
  if (typeof record.app !== 'string' || !/^[^/\\]+\.app$/i.test(record.app) || typeof record.executable !== 'string' || !/^[^/\\]+$/.test(record.executable)) return null;
  const staged = join(stageDir, record.app);
  let compared;
  try {
    compared = await compare({ zipPath, folder: stageDir });
  } catch (error) {
    compared = { same: false, reason: error?.message || String(error) };
  }
  if (!compared.same) {
    log(`the update unpacked earlier is not used: ${compared.reason}`);
    return null;
  }
  const plist = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(staged, 'Contents', 'Info.plist')], { timeoutMs: 30000 });
  let executable = null;
  try { executable = plist.status === 0 ? String(JSON.parse(plist.stdout).CFBundleExecutable || '') : null; } catch {}
  if (!executable || !/^[^/\\]+$/.test(executable) || !existsSync(join(staged, 'Contents', 'MacOS', executable))) {
    log('the update unpacked earlier is not used: its Info.plist names no executable');
    return null;
  }
  return { stageDir, staged, executable, reused: true };
}

/**
 * Unpack the downloaded zip next to the installed app and check the result.
 * Resolves { stageDir, staged, executable }: the new .app, not yet in place.
 * `zipSha512` (the feed's) is recorded with the checks, for reusableStage().
 */
export async function stageMacUpdate({ zipPath, appPath, version, arch, zipSha512 = null, run = runAsync } = {}) {
  const stageDir = join(dirname(appPath), `.SynaBun-update-${version}`);
  removeTree(stageDir);
  mkdirSync(stageDir, { recursive: true });
  const fail = (reason) => {
    removeTree(stageDir);
    throw Object.assign(new Error(reason), { code: 'STAGED_INVALID', reason });
  };
  // ditto made the zip; it keeps the links, modes and extended attributes of the bundle.
  const unpacked = await run('/usr/bin/ditto', ['-x', '-k', zipPath, stageDir]);
  if (unpacked.status !== 0) fail(`it could not be unpacked (${String(unpacked.stderr).trim().split('\n')[0]})`);
  const apps = readdirSync(stageDir).filter(name => /\.app$/i.test(name));
  if (apps.length !== 1) fail(`it holds ${apps.length} applications`);
  const staged = join(stageDir, apps[0]);
  const plist = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(staged, 'Contents', 'Info.plist')], { timeoutMs: 30000 });
  let info = null;
  try { info = plist.status === 0 ? JSON.parse(plist.stdout) : null; } catch {}
  if (!info) fail('its Info.plist cannot be read');
  if (info.CFBundleIdentifier !== BUNDLE_ID) fail(`it is ${info.CFBundleIdentifier || 'an unknown app'}, not SynaBun`);
  if (String(info.CFBundleShortVersionString) !== String(version)) fail(`it is version ${info.CFBundleShortVersionString}, not ${version}`);
  const executable = String(info.CFBundleExecutable || '');
  const archs = machoArchs(join(staged, 'Contents', 'MacOS', executable));
  if (!archs.includes(arch)) fail(`its executable runs on ${archs.join('+') || 'nothing'}, this Mac needs ${arch}`);
  if (!existsSync(join(staged, 'Contents', 'Resources', 'synabun-package.json'))) fail('its SynaBun server is missing');
  // An intact seal (ad hoc or Developer ID): nothing in the bundle changed since it was signed.
  const verified = await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged]);
  if (verified.status !== 0) fail(`its code signature does not verify (${String(verified.stderr).trim().split('\n')[0]})`);
  if (zipSha512) {
    try { writeFileSync(join(stageDir, STAGED_RECORD), JSON.stringify({ version: String(version), arch, zipSha512, app: apps[0], executable }) + '\n'); } catch {}
  }
  return { stageDir, staged, executable };
}

/**
 * macOS checks a program the first time it runs (Gatekeeper's scan, XProtect):
 * three to four seconds for a freshly unpacked SynaBun, which an update spent
 * after the old copy had closed and before the new one could show anything.
 * Spent here instead, while the user still works: the staged copy's headless
 * entry prints its help once (no window, no Dock icon, nothing read from the
 * data home), and the check is done for the whole bundle; it stays with the
 * files through the rename into place. Started through /bin/sh, so the wait
 * holds that shell and never this process (a spawn returns only once the new
 * program's image is up). Only a copy that passed every check gets here. Never
 * fails the update: { warmed, ms }.
 */
export async function warmStagedCopy({ staged, run = runAsync, env = process.env, timeoutMs = 60000, now = Date.now }) {
  const entry = join(staged || '', 'Contents', 'MacOS', 'synabun-cli');
  if (!staged || !existsSync(entry)) return { warmed: false, ms: 0 };
  const started = now();
  const result = await run('/bin/sh', ['-c', 'exec "$0" help >/dev/null 2>&1', entry], {
    timeoutMs, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: env.HOME || '/', TMPDIR: env.TMPDIR || '/tmp' },
  });
  return { warmed: result.status === 0, ms: now() - started };
}

/**
 * Unpacked updates beside the app that no install will use any more (an
 * earlier version's, one a quit app left): removed at start. `keepVersion` is
 * the downloaded update still waiting, whose folder the next install reuses.
 */
export function cleanupStagedUpdates({ appPath, keepVersion = null } = {}) {
  if (!appPath) return [];
  const folder = dirname(appPath);
  const removed = [];
  let names = [];
  try { names = readdirSync(folder); } catch { return removed; }
  for (const name of names) {
    const match = /^\.SynaBun-update-(.+)$/.exec(name);
    if (!match || (keepVersion && match[1] === String(keepVersion))) continue;
    try { removeTree(join(folder, name)); removed.push(name); } catch {}
  }
  return removed;
}

/**
 * The script that swaps the apps once this process has ended. Arguments:
 *   1 pid to wait for  2 the installed .app  3 the staged .app  4 where the old copy waits
 *   5 the update state folder  6 "1" to open the new copy  7 the executable's name
 *   8 how long the new copy has to start, in tenths of a second (1800: three minutes; tests give less)
 * The app writes plan.json (what is installed, from which version, where the
 * old copy waits) before it starts this. The script leaves markers in the
 * state folder: swap.log, `swapped` once the new copy is in place,
 * `swap-failed` (why) or `rolled-back`. The new copy writes `started` when it
 * runs; until then the old copy is kept.
 */
export const SWAP_SCRIPT = `#!/bin/sh
pid="$1"; app="$2"; staged="$3"; backup="$4"; state="$5"; relaunch="$6"; exe="$7"; ticks="\${8:-1800}"
log="$state/swap.log"
say() { printf '%s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$log"; }
fail() { say "failed: $*"; printf '%s\\n' "$*" >"$state/swap-failed"; exit 1; }
open_app() { "$app/Contents/MacOS/$exe" "$@" >/dev/null 2>&1 & newpid=$!; }
say "waiting for $pid to quit"
n=0
while kill -0 "$pid" 2>/dev/null; do
  n=$((n + 1)); [ "$n" -gt 2400 ] && fail "SynaBun did not quit within two minutes"
  sleep 0.05
done
[ -d "$staged" ] || fail "the unpacked update is gone"
rm -rf "$backup" 2>/dev/null
if ! mv "$app" "$backup" 2>>"$log"; then
  rm -rf "$(dirname "$staged")"
  [ "$relaunch" = 1 ] && open_app
  fail "the running copy could not be moved aside"
fi
if ! mv "$staged" "$app" 2>>"$log"; then
  mv "$backup" "$app" 2>>"$log"
  rm -rf "$(dirname "$staged")"
  [ "$relaunch" = 1 ] && open_app
  fail "the new copy could not be moved into place; the old copy was put back"
fi
rm -f "$(dirname "$staged")/staged.json"
rmdir "$(dirname "$staged")" 2>/dev/null
: >"$state/swapped"
say "the new copy is in place"
# The new copy opens first (its splash is the first thing it shows); LaunchServices learns about it meanwhile.
if [ "$relaunch" = 1 ]; then
  rm -f "$state/started"
  open_app --synabun-updated
fi
"${LSREGISTER}" -f "$app" >/dev/null 2>&1 &
[ "$relaunch" = 1 ] || exit 0
n=0
while [ ! -f "$state/started" ]; do
  n=$((n + 1))
  if [ "$n" -gt "$ticks" ]; then
    say "the new copy did not start in time: putting the old one back"
    kill "$newpid" 2>/dev/null
    [ -d "$backup" ] || fail "the new copy did not start, and the old copy is gone"
    rm -rf "$app.failed-update"
    if mv "$app" "$app.failed-update" 2>>"$log" && mv "$backup" "$app" 2>>"$log"; then
      rm -rf "$app.failed-update" "$state/swapped"
      : >"$state/rolled-back"
      open_app
      exit 1
    fi
    fail "the old copy could not be put back"
  fi
  sleep 0.1
done
say "the new copy started"
rm -rf "$backup" "$state/swapped"
exit 0
`;

/** Write the plan and the swap script into the state folder and start it, detached, so it outlives this process. */
export function startSwap({ pid = process.pid, appPath, staged, stateDir, relaunch, executable, version, previous, installId = null, env = process.env, spawn = nodeSpawn, startTicks = 1800 }) {
  mkdirSync(stateDir, { recursive: true });
  for (const name of ['swap-failed', 'rolled-back', 'started', 'swapped']) rmSync(join(stateDir, name), { force: true });
  const backup = join(dirname(appPath), `.${basename(appPath)}.previous`);
  writeFileSync(join(stateDir, 'plan.json'), JSON.stringify({ platform: 'darwin', appPath, backup, version, previous, relaunch: !!relaunch, installId, at: new Date().toISOString() }, null, 2) + '\n');
  const script = join(stateDir, 'swap.sh');
  writeFileSync(script, SWAP_SCRIPT, { mode: 0o700 });
  const child = spawn('/bin/sh', [script, String(pid), appPath, staged, backup, stateDir, relaunch ? '1' : '0', executable, String(startTicks)], {
    detached: true, stdio: 'ignore', env,
  });
  child.unref();
  return { script, backup, pid: child.pid };
}

// What an earlier swap left for this run: the same on every system (state.mjs).
export { finishPendingSwap } from './state.mjs';

/**
 * The macOS adapter of the update controller. The app hands in: feed,
 * current, appPath, arch, translated, cacheDir, downloadsDir, stateDir,
 * parseYaml, fetchImpl (Electron's net.fetch), moveToApplications, reveal,
 * env, log.
 */
export function createMacAdapter(deps) {
  const {
    feed, current, appPath, arch, translated = false, cacheDir, downloadsDir = cacheDir, stateDir, parseYaml, fetchImpl = fetch,
    moveToApplications, reveal, env = process.env, run = runAsync, spawn = nodeSpawn, warm = warmStagedCopy, log = () => {},
    compare = compareFolderWithZip, signature = treeSignature,
  } = deps;
  let offer = null;

  /**
   * Right before the swap: the unpacked copy is still what was checked. Its files as the file system describes them
   * (treeSignature, taken once it was checked and warmed up) are compared first; when anything moved, the copy is
   * compared with the archive again, which is first checked against the feed once more. A copy that is no longer the
   * archive is removed and the install fails: the next attempt unpacks it again.
   */
  async function confirmStaged() {
    const { staged, stageDir } = offer.staged;
    const moved = signatureDifference(offer.signature, await signature(staged).catch(() => null));
    if (!moved) return;
    log(`the unpacked update was touched since it was checked (${moved}): comparing it with the archive again`);
    let compared = { same: false, reason: 'the archive is gone' };
    if (offer.zipPath && existsSync(offer.zipPath) && await sha512File(offer.zipPath).catch(() => null) === offer.zip.sha512) {
      compared = await compare({ zipPath: offer.zipPath, folder: stageDir }).catch((error) => ({ same: false, reason: error?.message || String(error) }));
    } else if (offer.zipPath && existsSync(offer.zipPath)) {
      compared = { same: false, reason: 'the archive no longer matches the feed' };
    }
    if (!compared.same) {
      try { removeTree(stageDir); } catch {}
      offer.staged = null;
      throw Object.assign(new Error(`the unpacked update changed after it was checked (${compared.reason}); it is unpacked again at the next try`), { code: 'STAGED_CHANGED' });
    }
    offer.signature = await signature(staged);
  }

  return {
    supported: true,
    testFeed: !!feed.test,
    installMode: () => macInstallMode(appPath),
    async check() {
      const response = await fetchImpl(`${feed.url}/${channelFileFor('darwin')}?t=${Date.now()}`, { redirect: 'follow', cache: 'no-store' });
      if (response.status === 404) throw Object.assign(new Error('the latest release has no latest-mac.yml'), { code: 'NO_DESKTOP_BUILD' });
      if (!response.ok) throw Object.assign(new Error(`the update server answered ${response.status}`), { statusCode: response.status });
      let info;
      try { info = normalizeFeed(parseYaml(await response.text())); } catch (error) { throw Object.assign(error, { code: 'FEED_INVALID' }); }
      if (!isNewer(current, info.version)) { offer = null; return null; }
      const zip = pickMacFile(info, { arch, translated, kind: 'zip' });
      if (!zip) throw Object.assign(new Error(`the latest release has no macOS ${translated ? 'arm64' : arch} archive`), { code: 'NO_DESKTOP_BUILD' });
      offer = { info, zip, dmg: pickMacFile(info, { arch, translated, kind: 'dmg' }), arch: translated ? 'arm64' : arch };
      return { version: info.version, notes: info.notes, releaseDate: info.releaseDate };
    },
    async download({ manual, onProgress }) {
      if (!offer) throw new Error('check for updates first');
      const file = manual ? offer.dmg : offer.zip;
      if (!file) throw Object.assign(new Error('the release has no disk image for this Mac'), { code: 'NO_DESKTOP_BUILD' });
      const url = assetUrl(feed.url, file.url);
      // A disk image the user opens by hand goes where downloads go; the zip the app swaps in stays its own.
      const name = basename(new URL(url).pathname);
      const destination = manual ? await freeDownloadPath(join(downloadsDir, name), file.sha512) : join(cacheDir, name);
      log(`downloading ${url}`);
      await downloadVerified({ url, destination, sha512: file.sha512, size: file.size, fetchImpl, onProgress });
      if (manual) return { file: destination };
      offer.zipPath = destination;
      // A copy unpacked earlier is used only when it is still, byte by byte, this archive (just checked against the feed).
      const compareStarted = Date.now();
      offer.staged = await reusableStage({ appPath, version: offer.info.version, arch: offer.arch, zipSha512: file.sha512, zipPath: destination, compare, run, log });
      if (offer.staged) log(`the update unpacked earlier is still exactly the archive (${Date.now() - compareStarted} ms): ${offer.staged.staged}`);
      else {
        offer.staged = await stageMacUpdate({ zipPath: destination, appPath, version: offer.info.version, arch: offer.arch, zipSha512: file.sha512, run });
        log(`unpacked and checked beside the app: ${offer.staged.staged}`);
      }
      const warmed = await warm({ staged: offer.staged.staged, run, env });
      log(warmed.warmed ? `macOS checked the new copy's first start ahead of time (${warmed.ms} ms)` : 'the new copy\'s first start could not be checked ahead of time: macOS checks it when it opens');
      // What the checked copy's files are now: the install compares them with this before the swap.
      offer.signature = await signature(offer.staged.staged).catch(() => null);
      // The archive stays until the new version runs: a start before that installs from it without a download.
      return { file: destination };
    },
    async install({ relaunch, version, previous, installId = null }) {
      if (!offer?.staged || !existsSync(offer.staged.staged)) throw new Error('the unpacked update is gone; download it again');
      await confirmStaged();
      const started = startSwap({ appPath, staged: offer.staged.staged, stateDir, relaunch, executable: offer.staged.executable, version, previous, installId, env, spawn });
      log(`swap script started (pid ${started.pid}): ${started.script}`);
    },
    moveToApplications: () => moveToApplications(),
    reveal: (file) => reveal(file),
  };
}
