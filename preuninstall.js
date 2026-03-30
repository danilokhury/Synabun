#!/usr/bin/env node

/**
 * SynaBun — NPM preuninstall script
 *
 * Runs before `npm uninstall synabun`.
 * Removes nested node_modules that cause EPERM/deep-path errors on Windows.
 * Graceful — if cleanup fails, don't block the uninstall.
 */

import { rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const dirs = [
  resolve(__dirname, 'neural-interface', 'node_modules'),
  resolve(__dirname, 'mcp-server', 'node_modules'),
];

for (const dir of dirs) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Non-fatal — npm will handle remaining cleanup
  }
}
