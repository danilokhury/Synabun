#!/usr/bin/env node

/**
 * Shared test utilities for SynaBun automated tests.
 *
 * Pattern matches hooks/claude-code/test-user-learning.mjs:
 *   - assert() with colored output
 *   - runHook() spawns hook scripts as child processes
 *   - HTTP helpers for API endpoint testing
 *   - Flag file helpers for hook state management
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(__dirname, '..', '..');
export const DATA_DIR = join(PROJECT_ROOT, 'data');
export const HOOKS_DIR = join(PROJECT_ROOT, 'hooks', 'claude-code');
export const PENDING_REMEMBER_DIR = join(DATA_DIR, 'pending-remember');
export const HOOK_FEATURES_PATH = join(DATA_DIR, 'hook-features.json');

// Hook script paths
export const PROMPT_SUBMIT = join(HOOKS_DIR, 'prompt-submit.mjs');
export const STOP_HOOK = join(HOOKS_DIR, 'stop.mjs');
export const POST_REMEMBER = join(HOOKS_DIR, 'post-remember.mjs');
export const POST_PLAN = join(HOOKS_DIR, 'post-plan.mjs');
export const SESSION_START = join(HOOKS_DIR, 'session-start.mjs');

// Colors
export const G = '\x1b[32m';  // green
export const R = '\x1b[31m';  // red
export const Y = '\x1b[33m';  // yellow
export const B = '\x1b[1m';   // bold
export const D = '\x1b[2m';   // dim
export const X = '\x1b[0m';   // reset

// Server config
const NI_PORT = process.env.NI_PORT || 3344;
const NI_BASE = `http://localhost:${NI_PORT}`;

// ─── Assertions ──────────────────────────────────────────────────────

let _passed = 0;
let _failed = 0;
let _skipped = 0;

export function assert(condition, name) {
  if (condition) {
    console.log(`  ${G}✓${X} ${name}`);
    _passed++;
  } else {
    console.log(`  ${R}✗${X} ${name}`);
    _failed++;
  }
}

export function skip(name, reason) {
  console.log(`  ${Y}⊘${X} ${D}${name} — ${reason}${X}`);
  _skipped++;
}

export function section(title) {
  console.log(`\n${Y}${title}${X}`);
}

export function getCounts() {
  return { passed: _passed, failed: _failed, skipped: _skipped };
}

export function resetCounts() {
  _passed = 0;
  _failed = 0;
  _skipped = 0;
}

export function printSummary(label) {
  const total = _passed + _failed + _skipped;
  console.log(`\n${B}${label}${X}`);
  console.log(`  ${G}${_passed} passed${X}  ${_failed ? R : D}${_failed} failed${X}  ${_skipped ? Y : D}${_skipped} skipped${X}  ${D}(${total} total)${X}`);
  return _failed;
}

// ─── HTTP Helpers ────────────────────────────────────────────────────

async function httpRequest(method, path, body) {
  const url = `${NI_BASE}${path}`;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10000),
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, ok: res.ok };
}

export function httpGet(path) { return httpRequest('GET', path); }
export function httpPost(path, body) { return httpRequest('POST', path, body); }
export function httpPut(path, body) { return httpRequest('PUT', path, body); }
export function httpDelete(path) { return httpRequest('DELETE', path); }

export async function serverIsUp() {
  try {
    const res = await fetch(`${NI_BASE}/api/stats`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Hook Runner ─────────────────────────────────────────────────────

export function runHook(scriptPath, stdinData, env = {}) {
  return new Promise((resolve) => {
    const proc = spawn('node', [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      timeout: 15000,
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      let parsed = {};
      try { parsed = stdout ? JSON.parse(stdout) : {}; } catch { /* non-JSON output */ }
      resolve({ code, stdout, stderr, parsed });
    });
    proc.stdin.write(JSON.stringify(stdinData));
    proc.stdin.end();
  });
}

export function getContext(result) {
  return result.parsed?.hookSpecificOutput?.additionalContext || '';
}

export function getDecision(result) {
  return result.parsed?.decision || '';
}

// ─── Flag / Fixture Helpers ──────────────────────────────────────────

export function readFlag(path) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); }
  catch { return null; }
}

export function writeFlag(path, data) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data));
}

export function cleanup(path) {
  try { unlinkSync(path); } catch { /* ok */ }
}

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
