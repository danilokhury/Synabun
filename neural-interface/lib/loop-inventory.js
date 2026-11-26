// ═══════════════════════════════════════════
// SynaBun Neural Interface — Async Loop Inventory Scanner
// ═══════════════════════════════════════════
// Scans LOOP_DIR (*.json) asynchronously using fs.promises and caches parsed
// loop files keyed by (mtimeMs, ctimeMs, ino, size) so unchanged files are
// neither re-read nor re-parsed on every periodic poll, while atomic
// same-name replacements with equal size and mtime still invalidate the cache.
// Dynamic fields (elapsedMinutes, stalledMinutes, stalledMs, terminalAlive,
// state) are recomputed live from the cached JSON on every scan.

import * as fsp from 'node:fs/promises';
import { resolve } from 'node:path';

export function isInventoryLoopFile(name) {
  return typeof name === 'string'
    && name.endsWith('.json')
    && name !== '.gitkeep'
    && !name.startsWith('pending-')
    && name !== 'active-pointer.json';
}

/**
 * Create an asynchronous, stat-identity-cached loop inventory scanner.
 *
 * @param {object} options
 * @param {string | (() => string)} options.loopDir
 * @param {(data: object) => boolean} [options.isLoopRuntimeAlive]
 * @param {{ readdir: Function, stat: Function, readFile: Function }} [options.fsPromises]
 * @param {() => number} [options.now]
 */
export function createLoopInventoryScanner({
  loopDir,
  isLoopRuntimeAlive = () => false,
  fsPromises = fsp,
  now = Date.now,
} = {}) {
  const fileCache = new Map(); // filename -> { mtimeMs, ctimeMs, ino, size, data }
  let reads = 0;
  let cacheHits = 0;

  async function scan({ includeExtraFields = false, includeRaw = false } = {}) {
    const result = includeRaw
      ? { loops: [], staleCount: 0, rawEntries: [] }
      : { loops: [], staleCount: 0 };
    const dir = typeof loopDir === 'function' ? loopDir() : loopDir;
    if (!dir) {
      fileCache.clear();
      return result;
    }

    let entries;
    try {
      entries = await fsPromises.readdir(dir);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        fileCache.clear();
        return result;
      }
      throw err;
    }

    const files = entries.filter(isInventoryLoopFile);
    const seen = new Set(files);
    for (const key of fileCache.keys()) {
      if (!seen.has(key)) fileCache.delete(key);
    }

    const currentMs = now();
    for (const f of files) {
      const filePath = resolve(dir, f);
      let stat;
      try {
        stat = await fsPromises.stat(filePath);
      } catch {
        fileCache.delete(f);
        continue;
      }

      const ctimeMs = stat.ctimeMs ?? null;
      const ino = stat.ino ?? null;
      let data;
      const cached = fileCache.get(f);
      if (
        cached
        && cached.mtimeMs === stat.mtimeMs
        && cached.ctimeMs === ctimeMs
        && cached.ino === ino
        && cached.size === stat.size
      ) {
        data = cached.data;
        cacheHits++;
      } else {
        try {
          const raw = await fsPromises.readFile(filePath, 'utf-8');
          data = JSON.parse(raw);
          fileCache.set(f, { mtimeMs: stat.mtimeMs, ctimeMs, ino, size: stat.size, data });
          reads++;
        } catch {
          fileCache.delete(f);
          continue;
        }
      }

      if (!data || typeof data !== 'object') continue;
      const sessionId = f.replace('.json', '');
      if (includeRaw) {
        result.rawEntries.push({ file: f, filePath, sessionId, mtimeMs: stat.mtimeMs, stat, data });
      }
      const startedAtMs = data.startedAt ? new Date(data.startedAt).getTime() : 0;
      const lastIterAtMs = data.lastIterationAt ? new Date(data.lastIterationAt).getTime() : startedAtMs;
      const elapsedMs = startedAtMs ? currentMs - startedAtMs : 0;
      const stalledMs = lastIterAtMs ? currentMs - lastIterAtMs : 0;
      const terminalAlive = !!isLoopRuntimeAlive(data);
      const iterDone = (data.currentIteration || 0) >= (data.totalIterations || 0) && (data.totalIterations || 0) > 0;
      let state;
      if (data.active === false) {
        state = 'stale-inactive';
        result.staleCount++;
      } else if (data.terminalSessionId && !terminalAlive) {
        state = data.runtimeType === 'native' ? 'orphaned-native' : 'orphaned-pty';
      } else if (iterDone) {
        state = 'finished';
      } else {
        state = 'active';
      }

      const item = {
        sessionId,
        terminalSessionId: data.terminalSessionId || null,
        terminalAlive,
        ...(includeExtraFields ? {
          runId: data.runId || null,
          profile: data.profile || null,
          runtimeType: data.runtimeType || 'pty',
          surface: data.surface || 'terminal',
        } : {}),
        task: typeof data.task === 'string' ? data.task.slice(0, 200) : '',
        currentIteration: data.currentIteration || 0,
        totalIterations: data.totalIterations || 0,
        startedAt: data.startedAt || null,
        lastIterationAt: data.lastIterationAt || null,
        elapsedMinutes: Math.round(elapsedMs / 60000),
        stalledMinutes: Math.round(stalledMs / 60000),
        stalledMs,
        state,
        browserSessionId: data.browserSessionId || null,
        browserTabId: data.browserTabId || null,
        usesBrowser: !!data.usesBrowser,
      };
      result.loops.push(item);
    }

    result.loops.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
    return result;
  }

  return {
    scan,
    clearCache() { fileCache.clear(); },
    stats() { return { reads, cacheHits, cachedFiles: fileCache.size }; },
  };
}
