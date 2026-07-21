#!/usr/bin/env node

/**
 * Preload script — loads .env into process.env BEFORE any other module evaluates.
 * This avoids the ESM hoisting issue where static imports (like config.ts) would
 * read empty env vars because import statements execute before module body code.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { getDataHome } from '../../lib/paths.js';

const envPath = process.env.DOTENV_PATH || resolve(getDataHome(), '.env');
try {
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    // Explicit host/session values (especially SYNABUN_PROFILE) must outrank
    // shared dotenv defaults so concurrent MCP processes remain isolated.
    if (process.env[key] !== undefined) continue;
    process.env[key] = trimmed.slice(eq + 1);
  }
} catch { /* .env not found, rely on existing env vars */ }

// Now that env is loaded, dynamically import the main entry point.
// Dynamic import ensures all static imports in index.ts see the populated env.
await import('./index.js');
