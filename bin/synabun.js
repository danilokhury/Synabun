#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const setupPath = resolve(packageRoot, 'setup.js');
const child = spawn(process.execPath, [
  '--disable-warning=ExperimentalWarning',
  setupPath,
  ...process.argv.slice(2),
], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});

child.on('error', error => {
  console.error(`Could not start SynaBun: ${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
