/**
 * The AppImage half of an update on Linux. The new image takes the place of
 * the running one under the same path: the operating system keeps the running
 * image (and its mount) alive until this process ends, and everything that
 * names the image (MCP registrations, Claude Code hooks, the synabun://
 * handler, a desktop shortcut) keeps working without a repair. The old image
 * stays beside it (`.<name>.previous`, a hard link where the file system has
 * them) until the new one says it runs, and comes back if it does not. Pure
 * Node and a small sh script (tested in packaging/tests/desktop-updater.test.mjs).
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { chmodSync, copyFileSync, linkSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Where the old image waits while the new one starts. */
export function previousImageFor(target) {
  return join(dirname(target), `.${basename(target)}.previous`);
}

/**
 * Put `downloaded` where `target` is, in one rename on the target's own file
 * system, keeping the old image beside it. Resolves { target, previous }.
 * A failure leaves the image as it was.
 */
export function replaceAppImage({ downloaded, target, pid = process.pid, keepPrevious = true }) {
  const temp = join(dirname(target), `.${basename(target)}.update-${pid}`);
  const previous = keepPrevious ? previousImageFor(target) : null;
  try {
    copyFileSync(downloaded, temp);
    chmodSync(temp, 0o755);
    if (previous) {
      rmSync(previous, { force: true });
      try { linkSync(target, previous); } catch { copyFileSync(target, previous); }
    }
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    if (previous) rmSync(previous, { force: true });
    throw error;
  }
  try { rmSync(downloaded, { force: true }); } catch {}
  return { target, previous };
}

/**
 * The environment to open an image with from this one: nothing that belongs
 * to the mount this process runs from, which ends with it.
 */
export function cleanAppImageEnv(env = process.env) {
  const next = { ...env };
  const mount = String(env.APPDIR || '').replace(/\/+$/, '');
  for (const key of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD', 'APPIMAGE_SILENT_INSTALL', 'APPIMAGE_EXIT_AFTER_INSTALL']) delete next[key];
  if (mount && next.PATH) next.PATH = next.PATH.split(':').filter(part => part !== mount && !part.startsWith(`${mount}/`)).join(':');
  if (mount && next.LD_LIBRARY_PATH) {
    next.LD_LIBRARY_PATH = next.LD_LIBRARY_PATH.split(':').filter(part => part !== mount && !part.startsWith(`${mount}/`)).join(':');
    if (!next.LD_LIBRARY_PATH) delete next.LD_LIBRARY_PATH;
  }
  return next;
}

/**
 * After the app quits: open the new image (--synabun-updated) and wait for it
 * to say it runs (`started` in the state folder); then the old image goes. A
 * new image that does not start within three minutes is replaced by the old
 * one, which opens instead. Arguments: 1 pid to wait for, 2 the image,
 * 3 where the old image waits ('' for none), 4 the update state folder,
 * 5 how long the new image has to start, in tenths of a second (1800: three
 * minutes; tests give less).
 */
export const RELAUNCH_SCRIPT = `#!/bin/sh
pid="$1"; image="$2"; previous="$3"; state="$4"; ticks="\${5:-1800}"
log="$state/swap.log"
say() { printf '%s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$log"; }
n=0
while kill -0 "$pid" 2>/dev/null; do
  n=$((n + 1)); [ "$n" -gt 1200 ] && { say "SynaBun did not quit within two minutes"; exit 1; }
  sleep 0.1
done
rm -f "$state/started"
"$image" --synabun-updated >/dev/null 2>&1 &
newpid=$!
say "opened the new image (pid $newpid)"
n=0
while [ ! -f "$state/started" ]; do
  n=$((n + 1))
  if [ "$n" -gt "$ticks" ]; then
    say "the new image did not start in time: putting the old one back"
    kill "$newpid" 2>/dev/null
    if [ -n "$previous" ] && [ -f "$previous" ] && mv -f "$previous" "$image" 2>>"$log"; then
      rm -f "$state/swapped"
      : >"$state/rolled-back"
      "$image" >/dev/null 2>&1 &
      exit 1
    fi
    printf '%s\\n' "the new image did not start, and the old one could not be put back" >"$state/swap-failed"
    exit 1
  fi
  sleep 0.1
done
say "the new image started"
[ -n "$previous" ] && rm -f "$previous"
rm -f "$state/swapped"
exit 0
`;

/** Open `image` once `pid` has ended, from a process that outlives this one, and keep the old image until it runs. */
export function relaunchAfterExit({ image, previous = '', stateDir, pid = process.pid, env = process.env, spawn = nodeSpawn, cwd, startTicks = 1800 }) {
  mkdirSync(stateDir, { recursive: true });
  const script = join(stateDir, 'relaunch.sh');
  writeFileSync(script, RELAUNCH_SCRIPT, { mode: 0o700 });
  const child = spawn('/bin/sh', [script, String(pid), image, previous || '', stateDir, String(startTicks)], {
    detached: true, stdio: 'ignore', env: cleanAppImageEnv(env), cwd: cwd || dirname(image),
  });
  child.unref();
  return child.pid;
}

/**
 * Open `image` again once `pid` has ended (Settings > App: a restart after a
 * setting that applies at start). Electron's own relaunch runs from the mount,
 * which ends with this process; this runs the image file itself.
 */
export function reopenAfterExit({ image, pid = process.pid, env = process.env, spawn = nodeSpawn, cwd }) {
  const child = spawn('/bin/sh', ['-c', 'while kill -0 "$1" 2>/dev/null; do sleep 0.1; done; exec "$2" >/dev/null 2>&1', 'synabun-reopen', String(pid), image], {
    detached: true, stdio: 'ignore', env: cleanAppImageEnv(env), cwd: cwd || dirname(image),
  });
  child.unref();
  return child.pid;
}

/** The plan and the marker of an AppImage that is in place, for the next start (state.mjs). */
export function recordAppImageSwap({ stateDir, image, previous, version, from, relaunch, now = () => new Date() }) {
  mkdirSync(stateDir, { recursive: true });
  for (const name of ['swap-failed', 'rolled-back', 'started']) rmSync(join(stateDir, name), { force: true });
  writeFileSync(join(stateDir, 'plan.json'), JSON.stringify({
    platform: 'linux', appPath: image, backup: previous || null, version, previous: from, relaunch: !!relaunch, at: now().toISOString(),
  }, null, 2) + '\n');
  writeFileSync(join(stateDir, 'swapped'), '');
}
