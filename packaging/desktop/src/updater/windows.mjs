/**
 * The app's half of a Windows update: it hands the downloaded installer to
 * the install watchdog (win-swap.mjs) and quits. The watchdog runs under a copy
 * of SynaBun's own node.exe in the update state folder, because nothing may
 * run from the install folder it moves aside, and it outlives the app. Plain
 * Node (tested in packaging/tests/desktop-updater.test.mjs).
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SWAP_ENV } from './win-swap.mjs';

/**
 * Prepare and start the watchdog, detached. Resolves once it runs (its pid);
 * rejects when it could not start, and then nothing has changed.
 *   instDir      the installed copy's folder (SynaBun.exe is in it)
 *   installer    the downloaded installer, checked by electron-updater (sha512)
 *   runtimeNode  SynaBun's node.exe (resources/runtime/node.exe)
 *   scriptSource the text of win-swap.mjs (read from the app's own files)
 */
export function startWindowsSwap({
  pid = process.pid, instDir, installer, version, previous, stateDir, relaunch, runtimeNode, scriptSource,
  env = process.env, spawn = nodeSpawn, exe = 'SynaBun.exe', now = () => new Date(),
}) {
  return new Promise((done, fail) => {
    try {
      if (!installer || !existsSync(installer)) throw new Error('the downloaded installer is gone; download it again');
      if (!runtimeNode || !existsSync(runtimeNode)) throw new Error('SynaBun\'s own Node runtime is missing from this copy');
      const swapDir = join(stateDir, 'swap');
      mkdirSync(swapDir, { recursive: true });
      for (const name of ['swap-failed', 'rolled-back', 'started', 'swapped']) rmSync(join(stateDir, name), { force: true });
      writeFileSync(join(stateDir, 'plan.json'), JSON.stringify({
        platform: 'win32', appPath: instDir, backup: `${instDir}.previous`, version, previous, relaunch: !!relaunch, installer, at: now().toISOString(),
      }, null, 2) + '\n');
      // A copy of the runtime: the one in the install folder is about to be moved away.
      const node = join(swapDir, 'node.exe');
      let same = false;
      try { same = statSync(node).size === statSync(runtimeNode).size; } catch {}
      if (!same) copyFileSync(runtimeNode, node);
      const script = join(swapDir, 'win-swap.mjs');
      writeFileSync(script, scriptSource);
      const child = spawn(node, [script], {
        detached: true, stdio: 'ignore', windowsHide: true, cwd: swapDir,
        env: {
          ...env,
          [SWAP_ENV.pid]: String(pid), [SWAP_ENV.instDir]: instDir, [SWAP_ENV.installer]: installer, [SWAP_ENV.version]: String(version),
          [SWAP_ENV.previous]: previous ? String(previous) : '', [SWAP_ENV.stateDir]: stateDir, [SWAP_ENV.relaunch]: relaunch ? '1' : '0', [SWAP_ENV.exe]: exe,
        },
      });
      let settled = false;
      child.once('error', (error) => { if (!settled) { settled = true; fail(Object.assign(new Error(`the update could not start: ${error.message}`), { code: error.code })); } });
      child.once('spawn', () => { if (!settled) { settled = true; child.unref(); done({ pid: child.pid, node, script }); } });
    } catch (error) {
      fail(error);
    }
  });
}

/** What a finished update leaves in the state folder: the watchdog's runtime copy, once nothing runs it. */
export function cleanupWindowsSwap(stateDir) {
  try { rmSync(join(stateDir, 'swap'), { recursive: true, force: true }); } catch {}
}
