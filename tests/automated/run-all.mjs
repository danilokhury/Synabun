#!/usr/bin/env node

/**
 * SynaBun Test Suite Runner
 *
 * Runs all automated test files sequentially and prints an aggregate summary.
 *
 * Usage:
 *   node tests/automated/run-all.mjs           # Run all tests
 *   node tests/automated/run-all.mjs cron      # Run only cron tests
 *   node tests/automated/run-all.mjs api       # Run only API tests
 *   node tests/automated/run-all.mjs hooks     # Run only hook tests
 *
 * Prerequisites:
 *   - Neural Interface server for API tests: node neural-interface/server.js
 *   - Hook tests and cron tests run standalone (no server needed)
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const B = '\x1b[1m';
const G = '\x1b[32m';
const R = '\x1b[31m';
const Y = '\x1b[33m';
const D = '\x1b[2m';
const X = '\x1b[0m';

const TEST_FILES = [
  { name: 'Cron Parser', file: 'cron-parser.test.mjs', key: 'cron' },
  { name: 'API Endpoints', file: 'api-endpoints.test.mjs', key: 'api' },
  { name: 'Hook Logic', file: 'hook-tests.test.mjs', key: 'hooks' },
  { name: 'Permission System', file: 'permission-system.test.mjs', key: 'permissions' },
];

function runFile(filePath) {
  return new Promise((resolve) => {
    const proc = spawn('node', [filePath], {
      stdio: 'inherit',
      env: process.env,
    });
    proc.on('close', code => resolve(code));
    proc.on('error', () => resolve(1));
  });
}

async function main() {
  console.log(`\n${B}╔═══════════════════════════════════════╗${X}`);
  console.log(`${B}║   SynaBun Automated Test Suite        ║${X}`);
  console.log(`${B}╚═══════════════════════════════════════╝${X}\n`);

  const filter = process.argv[2]?.toLowerCase();
  const filesToRun = filter
    ? TEST_FILES.filter(t => t.key === filter || t.name.toLowerCase().includes(filter))
    : TEST_FILES;

  if (filesToRun.length === 0) {
    console.log(`${R}No test files match filter: "${filter}"${X}`);
    console.log(`Available: ${TEST_FILES.map(t => t.key).join(', ')}`);
    process.exit(1);
  }

  const results = [];

  for (const test of filesToRun) {
    const filePath = join(__dirname, test.file);
    console.log(`\n${B}${'─'.repeat(50)}${X}`);
    console.log(`${B}Running: ${test.name}${X}`);
    console.log(`${B}${'─'.repeat(50)}${X}`);

    const code = await runFile(filePath);
    results.push({ name: test.name, code });
  }

  // ─── Aggregate Summary ─────────────────────────────────────────
  console.log(`\n${B}${'═'.repeat(50)}${X}`);
  console.log(`${B}  Aggregate Results${X}`);
  console.log(`${B}${'═'.repeat(50)}${X}\n`);

  let totalFailed = 0;
  for (const r of results) {
    const icon = r.code === 0 ? `${G}✓${X}` : `${R}✗${X}`;
    const status = r.code === 0 ? `${G}PASS${X}` : `${R}FAIL${X}`;
    console.log(`  ${icon} ${r.name} — ${status}`);
    if (r.code !== 0) totalFailed++;
  }

  console.log();
  if (totalFailed === 0) {
    console.log(`  ${G}${B}All ${results.length} test suites passed!${X}\n`);
  } else {
    console.log(`  ${R}${B}${totalFailed} of ${results.length} test suites failed.${X}\n`);
  }

  process.exit(totalFailed ? 1 : 0);
}

main();
