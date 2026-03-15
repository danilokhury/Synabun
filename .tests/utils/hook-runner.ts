/**
 * Spawns SynaBun hook scripts as child processes for testing.
 * Hooks wire process.stdin at import time and can't be imported as modules.
 */
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readdirSync, readFileSync } from 'node:fs';

const HOOKS_DIR = resolve(__dirname, '../../hooks/claude-code');
const DATA_DIR = resolve(__dirname, '../../data');

export interface HookResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  parsed: Record<string, unknown>;
}

/**
 * Run a hook script by piping stdinPayload as JSON to its stdin.
 * Returns the parsed stdout JSON and metadata.
 */
export async function runHook(
  hookName: string,
  stdinPayload: Record<string, unknown>,
  env?: Record<string, string>,
  timeoutMs = 8000
): Promise<HookResult> {
  const hookPath = resolve(HOOKS_DIR, hookName);

  return new Promise((res, reject) => {
    const child = spawn('node', [hookPath], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Hook ${hookName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(stdout);
      } catch {
        // Empty or non-JSON output is valid for some hooks
      }
      res({ stdout, stderr, exitCode: code ?? 0, parsed });
    });

    child.stdin.write(JSON.stringify(stdinPayload));
    child.stdin.end();
  });
}

/** Generate a unique test session ID to avoid collision between tests */
export function testSessionId(): string {
  return `test-sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Ensure a data subdirectory exists */
export function ensureDataDir(subdir: string): string {
  const dir = join(DATA_DIR, subdir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write a JSON flag file into a data subdirectory */
export function writeFlagFile(subdir: string, filename: string, data: Record<string, unknown>): string {
  const dir = ensureDataDir(subdir);
  const filePath = join(dir, filename);
  writeFileSync(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

/** Read a JSON flag file from a data subdirectory */
export function readFlagFile(subdir: string, filename: string): Record<string, unknown> | null {
  const filePath = join(DATA_DIR, subdir, filename);
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/** Check if a flag file exists */
export function flagFileExists(subdir: string, filename: string): boolean {
  return existsSync(join(DATA_DIR, subdir, filename));
}

/** Clean up a specific flag file */
export function cleanupFlagFile(subdir: string, filename: string): void {
  const filePath = join(DATA_DIR, subdir, filename);
  try { unlinkSync(filePath); } catch { /* ok */ }
}

/** Clean up all test flag files in a subdirectory (files starting with 'test-sess-') */
export function cleanupTestFlags(subdir: string): void {
  const dir = join(DATA_DIR, subdir);
  try {
    const files = readdirSync(dir).filter(f => f.startsWith('test-sess-'));
    for (const f of files) {
      try { unlinkSync(join(dir, f)); } catch { /* ok */ }
    }
  } catch { /* dir doesn't exist, ok */ }
}

/** Get the context from a hook result's additionalContext field */
export function getAdditionalContext(result: HookResult): string {
  const output = result.parsed?.hookSpecificOutput as Record<string, unknown> | undefined;
  return (output?.additionalContext as string) || '';
}

/** Check if a hook result contains a block decision */
export function isBlocked(result: HookResult): boolean {
  return result.parsed?.decision === 'block';
}

/** Get the block reason from a hook result */
export function getBlockReason(result: HookResult): string {
  return (result.parsed?.reason as string) || '';
}
