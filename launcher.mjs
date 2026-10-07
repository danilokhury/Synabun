#!/usr/bin/env node

/**
 * SynaBun — start launcher
 *
 * What the operating system runs for a synabun://start link (the Start Server
 * button on the offline page). Starts the server through the normal supervisor
 * (setup.js) unless it already answers or a start is under way, then exits.
 *
 * Registered by lib/start-launcher.js; can also be run by hand:
 *   node launcher.mjs
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BEACON_LINGER_MS, runLauncher } from './lib/start-launcher.js';

const packageRoot = dirname(fileURLToPath(import.meta.url));

try {
  // The page that asked is offline and cannot ask a server how the start is
  // going: the launch reports itself on its beacon, and keeps a failure
  // readable there for a moment.
  const result = await runLauncher({ argv: process.argv.slice(2), packageRoot, beacon: true, lingerMs: BEACON_LINGER_MS });
  if (process.stdout.isTTY) {
    const said = {
      ignored: 'Nothing to do for that link.',
      'already-running': `SynaBun is already running on port ${result.port}.`,
      'already-starting': 'SynaBun is already starting.',
      started: `SynaBun is running on port ${result.port}.`,
      spawned: 'SynaBun is starting; it has not answered yet.',
      failed: 'SynaBun could not be started. Run "npm start" in its folder to see why.',
    }[result.outcome];
    if (said) console.log(said);
  }
  process.exit(result.code);
} catch (error) {
  console.error(`SynaBun launcher: ${error.message}`);
  process.exit(1);
}
