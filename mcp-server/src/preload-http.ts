#!/usr/bin/env node

/**
 * Preload script for HTTP transport — loads .env then starts the HTTP server.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = process.env.DOTENV_PATH || resolve(__dirname, '..', '..', '.env');
try {
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1);
    process.env[key] = val;
  }
} catch { /* .env not found, rely on existing env vars */ }

await import('./http.js');
