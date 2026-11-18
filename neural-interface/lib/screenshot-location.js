// Where macOS saves screenshots, for the screenshot watcher (server.js: a new screenshot is pasted on the whiteboard).
//
// The folder chosen in the Screenshot app is `defaults read com.apple.screencapture location`. When none was ever
// chosen (the usual case), `defaults` exits 1 and writes "Could not find key 'location' in domain
// 'com.apple.screencapture'" to stderr: that is the default (~/Desktop), not an error, so its stderr is never passed
// through to SynaBun's own output (it used to show up in the boot log as a bare "Error: …" line).

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULTS = '/usr/bin/defaults';
export const SCREENCAPTURE_LOCATION_ARGS = Object.freeze(['read', 'com.apple.screencapture', 'location']);
const READ_TIMEOUT_MS = 5000;

/**
 * The folder macOS saves screenshots in: the one set in the Screenshot app when it exists, else ~/Desktop.
 * Never throws and never writes to the console.
 * @param {{ run?: typeof execFileSync, exists?: (path: string) => boolean, home?: string }} [o] tests inject these.
 * @returns {string}
 */
export function macScreenshotDir({ run = execFileSync, exists = existsSync, home = homedir() } = {}) {
  let dir = '';
  try {
    dir = String(run(DEFAULTS, [...SCREENCAPTURE_LOCATION_ARGS], {
      encoding: 'utf8', timeout: READ_TIMEOUT_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    }) ?? '').trim();
  } catch { dir = ''; } // never set (exit 1), or `defaults` could not run: the default
  let found = false;
  try { found = !!dir && exists(dir) === true; } catch { found = false; }
  return found ? dir : join(home, 'Desktop');
}
