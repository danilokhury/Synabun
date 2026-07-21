#!/usr/bin/env node

/**
 * Preload script for HTTP transport — loads .env then starts the HTTP server.
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
    // HTTP launches use the same precedence as stdio launches: explicit
    // process-scoped MCP values win over defaults stored in the shared file.
    if (process.env[key] !== undefined) continue;
    process.env[key] = trimmed.slice(eq + 1);
  }
} catch { /* .env not found, rely on existing env vars */ }

await import('./http.js');
