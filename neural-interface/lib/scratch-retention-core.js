// One scratch retention pass. Runs inside a worker thread (scratch-retention-worker.js): the walk, the measuring and
// every delete happen off the server's main thread, in small batches with a pause between them.
//
// A folder is touched only when its run is positively finished and past the retention period. What the run's visible
// output still points at stays (scratch-references.js); everything else in the folder goes. Before any delete of a
// folder: no process inside it, nothing changed, the same references, the run still terminal on disk and in the
// server's memory, and the path still the same real directory directly under data/scratch.

import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { DAY_MS, Evidence, Keep, reasonOf } from './scratch-evidence.js';
import { ancestorsOf, foldFor, isCovered, resolveKeepSet } from './scratch-references.js';
import { createProcessProbe, recoverProbes } from './scratch-process-guard.js';

const GRACE_MS = DAY_MS;
const BATCH = 128;
const PAUSE_MS = 5;
const MAX_DEPTH = 128;
const LINK_ROUNDS = 8;
const BIG = { bigint: true };
const DIRECTORY_FLAGS = constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0);
const SQLITE_BUSY = 5;

const defaultPause = () => new Promise((done) => setTimeout(done, PAUSE_MS));
const sameEntry = (a, b) => a.dev === b.dev && a.ino === b.ino;
const stampOf = (st) => `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
const changedMs = (st) => Math.max(Number(st.mtimeNs / 1_000_000n), Number(st.ctimeNs / 1_000_000n));
// The Windows process check renames the run folder aside and back, which moves that folder's own change time.
const rootStamp = (st, platform) => (platform === 'win32' ? `${st.dev}:${st.ino}:${st.mtimeNs}` : stampOf(st));
const rootChangedMs = (st, platform) => (platform === 'win32' ? Number(st.mtimeNs / 1_000_000n) : changedMs(st));

function pacer(pause) {
  let count = 0;
  return async () => {
    count += 1;
    if (count % BATCH === 0) await pause();
  };
}

function bytesOf(st, platform) {
  return platform === 'win32' ? Number(st.size) : Number(st.blocks) * 512;
}

/** Mount points below the scratch root (a Linux bind mount can share its parent's device number). */
function mountsBelow(root, platform) {
  if (platform !== 'linux') return [];
  try {
    return readFileSync('/proc/self/mountinfo', 'utf8').split('\n')
      .map((line) => line.split(' ')[4])
      .filter(Boolean)
      .map((point) => point.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))))
      .filter((point) => point.startsWith(`${root}/`));
  } catch { throw new Keep('unknown-mount'); }
}

function assertDirectory(path, info) {
  const now = lstatSync(path, BIG);
  if (!now.isDirectory() || !sameEntry(now, info) || realpathSync.native(path) !== path) throw new Keep('replaced');
}

/** Measure a folder and classify every entry as kept or removable. Reads names and metadata only. */
async function scanTree(ctx, root, info, keep) {
  const ancestors = ancestorsOf(keep);
  const digest = createHash('sha256');
  const tree = { bytes: 0, keptBytes: 0, removable: 0, keptEntries: 0, newest: rootChangedMs(info, ctx.platform), shared: new Map(), links: new Map(), linkTargets: [] };
  const named = new Map();
  const own = bytesOf(info, ctx.platform);
  tree.bytes += own;
  if (keep.size) tree.keptBytes += own;
  digest.update(`.\0${rootStamp(info, ctx.platform)}\n`);

  const visit = async (dir, rel, dirInfo, insideKept, depth) => {
    if (depth > MAX_DEPTH) throw new Keep('too-deep');
    for (const name of readdirSync(dir)) {
      await ctx.pace();
      const abs = join(dir, name);
      const child = rel ? `${rel}/${name}` : name;
      const st = lstatSync(abs, BIG);
      if (st.dev !== ctx.device) throw new Keep('mount');
      digest.update(`${child}\0${stampOf(st)}${st.isDirectory() ? '' : `:${st.nlink}`}\n`);
      tree.newest = Math.max(tree.newest, changedMs(st));
      const kept = insideKept || keep.has(child);
      const stays = kept || ancestors.has(child);
      const size = bytesOf(st, ctx.platform);
      if (!st.isDirectory() && st.nlink > 1n) {
        const key = `${st.dev}:${st.ino}`;
        const seen = named.get(key) || { size, nlink: st.nlink, names: 0n, stays: false, steady: true, known: ctx.platform !== 'win32' && st.ino !== 0n };
        seen.names += 1n;
        seen.stays ||= stays;
        seen.steady &&= seen.nlink === st.nlink;
        named.set(key, seen);
      } else {
        tree.bytes += size;
        if (stays) tree.keptBytes += size;
      }
      if (kept) tree.keptEntries += 1;
      else if (!stays) tree.removable += 1;
      if (st.isDirectory()) {
        if (ctx.mounts.includes(abs)) throw new Keep('mount');
        await visit(abs, child, st, kept, depth + 1);
      } else if (st.isSymbolicLink()) {
        if (kept) {
          // A kept link must keep working: what it points at inside this folder stays too.
          const target = readlinkSync(abs).replace(/\\/g, '/');
          if (!target.startsWith('/') && !/^[a-z]:/i.test(target)) {
            const resolved = posix.normalize(posix.join(posix.dirname(child), target));
            if (resolved !== '.' && resolved !== '..' && !resolved.startsWith('../')) tree.linkTargets.push(resolved);
          }
        }
      } else if (!st.isFile()) throw new Keep('special-file');
    }
    const after = lstatSync(dir, BIG);
    const same = dir === root ? rootStamp(after, ctx.platform) === rootStamp(dirInfo, ctx.platform) : stampOf(after) === stampOf(dirInfo);
    if (!same) throw new Keep('changing-folder');
  };
  await visit(root, '', info, false, 0);
  // A hard-linked file belongs to this folder only when the names counted here are all the names it has. Where the
  // identity of a file cannot be trusted (Windows, an inode of 0) that is never proven, so the folder stays.
  for (const [key, seen] of named) {
    if (!seen.known || !seen.steady || seen.names !== seen.nlink) { tree.shared.set(key, seen.size); continue; }
    tree.links.set(key, { total: seen.nlink, left: seen.nlink });
    tree.bytes += seen.size;
    if (seen.stays) tree.keptBytes += seen.size;
  }
  tree.digest = digest.digest('hex');
  return tree;
}

/** What stays and what goes in one folder, under the references that point into it now. */
async function planFolder(ctx, root, info, references) {
  if (references.overflow) throw new Keep('too-many-references');
  const list = (rel) => {
    try {
      return readdirSync(rel ? join(root, ...rel.split('/')) : root, { withFileTypes: true })
        .map((entry) => ({ name: entry.name, directory: entry.isDirectory() }));
    } catch { return null; }
  };
  const { keep, ambiguous } = resolveKeepSet(references.tails, list, ctx.fold);
  if (ambiguous) throw new Keep('ambiguous-reference');
  for (let round = 0; round < LINK_ROUNDS; round += 1) {
    const tree = await scanTree(ctx, root, info, keep);
    const missing = tree.linkTargets.filter((rel) => !isCovered(keep, rel));
    if (!missing.length) return { keep, tree };
    for (const rel of missing) keep.add(rel);
  }
  throw new Keep('ambiguous-reference');
}

/** Remove everything under `dir` that is not kept. Paths are checked again right before each removal. */
async function removeContents(ctx, dir, rel, dirInfo, keep, ancestors, links, credit) {
  assertDirectory(dir, dirInfo);
  for (const name of readdirSync(dir)) {
    await ctx.pace();
    const abs = join(dir, name);
    const child = rel ? `${rel}/${name}` : name;
    const st = lstatSync(abs, BIG);
    if (st.dev !== ctx.device) throw new Keep('mount');
    const link = st.isDirectory() ? undefined : links.get(`${st.dev}:${st.ino}`);
    if (link && st.nlink !== link.left) throw new Keep('hard-linked');
    // Removing a name moves the change time of the names left, so once this pass has done that only the content time
    // can speak for the file; the link count above says whether anyone else touched its names.
    const changed = link && link.left < link.total ? Number(st.mtimeNs / 1_000_000n) : changedMs(st);
    if (changed >= ctx.cutoff) throw new Keep('recent-change');
    if (keep.has(child)) continue;
    if (st.isDirectory()) {
      await removeContents(ctx, abs, child, st, keep, ancestors, links, credit);
      if (!ancestors.has(child)) {
        assertDirectory(dir, dirInfo);
        assertDirectory(abs, st);
        rmdirSync(abs);
        credit(bytesOf(st, ctx.platform));
      }
    } else if (st.isFile() || st.isSymbolicLink()) {
      if (!link && st.nlink !== 1n) throw new Keep('hard-linked');
      assertDirectory(dir, dirInfo);
      unlinkSync(abs);
      if (link) link.left -= 1n;
      // The bytes of a linked file are freed by its last name only; a kept name means they never are.
      credit(!link || link.left === 0n ? bytesOf(st, ctx.platform) : 0);
    } else throw new Keep('special-file');
  }
}

/** An OS-held lock: released however the holder ends, so a crash leaves nothing to clean up. */
async function withPassLock(path, fn) {
  const { DatabaseSync } = await import('node:sqlite');
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=0');
    try { db.exec('BEGIN IMMEDIATE'); }
    catch (error) {
      if ((Number(error?.errcode) & 0xff) === SQLITE_BUSY || /database is locked/i.test(String(error?.message))) return { busy: true };
      throw error;
    }
    try { await fn(); return { busy: false }; }
    finally { try { db.exec('ROLLBACK'); } catch { /* closing gives it back */ } }
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

/**
 * @param {object} o
 * @param {string} o.dataHome
 * @param {boolean} [o.dryRun] only say what would be removed
 * @param {(row: { check: string, task: boolean, finished: number }) => boolean|Promise<boolean>} [o.confirm] the live
 *   owners' last word, right before a delete
 * @param {(row: object) => void} [o.emit] one row per folder on a dry run
 */
export async function runPass({
  dataHome, dryRun = true, confirm = async () => false, now = Date.now, probe = null, emit = () => {},
  platform = process.platform, pause = defaultPause,
}) {
  const summary = {
    dryRun, removed: 0, pruned: 0, freedBytes: 0, wouldRemove: 0, wouldPrune: 0, wouldFreeBytes: 0,
    totalBytes: 0, kept: {}, keptBytes: {},
  };
  const held = (reason, runId, bytes = 0) => {
    summary.kept[reason] = (summary.kept[reason] || 0) + 1;
    summary.keptBytes[reason] = (summary.keptBytes[reason] || 0) + bytes;
    if (dryRun) emit({ runId, action: 'keep', reason, bytes });
  };

  let home;
  try { home = realpathSync.native(dataHome); }
  catch { summary.passReason = 'missing-directory-or-state'; return summary; }
  const data = join(home, 'data');
  const root = join(data, 'scratch');
  let rootInfo;
  try {
    if (!lstatSync(data).isDirectory()) throw new Keep('linked-root');
    rootInfo = lstatSync(root, BIG);
    if (!rootInfo.isDirectory()) throw new Keep('linked-root');
    if (realpathSync.native(root) !== root) throw new Keep('linked-root');
  } catch (error) {
    summary.passReason = error?.code === 'ENOENT' ? 'missing-directory-or-state' : reasonOf(error);
    return summary;
  }

  const pass = async () => {
    recoverProbes(root, { platform });
    const evidence = new Evidence(data, { pause });
    let settings;
    try { settings = evidence.settings(); }
    catch (error) {
      for (const name of readdirSync(root)) held(reasonOf(error), name);
      throw error;
    }
    const ctx = { device: rootInfo.dev, platform, fold: foldFor(platform), pace: pacer(pause), mounts: mountsBelow(root, platform), cutoff: 0 };
    const check = probe || createProcessProbe({ platform, pause });
    let holds = new Map();
    let holdError = null;
    try { holds = await evidence.collect(); }
    catch (error) { holdError = reasonOf(error); }

    const shared = new Map();
    const candidates = [];
    let total = 0;
    const measured = (tree) => {
      total += tree.bytes;
      for (const [key, size] of tree.shared) shared.set(key, size);
      return tree.bytes;
    };
    for (const name of readdirSync(root)) {
      const path = join(root, name);
      let bytes = 0;
      try {
        const st = lstatSync(path, BIG);
        if (!st.isDirectory()) {
          bytes = bytesOf(st, platform);
          if (st.nlink > 1n) shared.set(`${st.dev}:${st.ino}`, bytes);
          else total += bytes;
          throw new Keep('not-directory');
        }
        let verdict = null;
        let failure = holdError ? new Keep(holdError) : null;
        if (!failure) {
          try { verdict = evidence.evaluate(name, holds); } catch (error) { failure = error; }
        }
        // Measured whatever the verdict: a kept folder still counts against the disk budget.
        const references = verdict ? evidence.referencesTo(name) : { tails: new Set(), overflow: false };
        let plan;
        try { plan = await planFolder(ctx, path, st, references); }
        catch (error) {
          if (failure || !(error instanceof Keep) || !['too-many-references', 'ambiguous-reference'].includes(error.reason)) throw failure || error;
          bytes = measured((await planFolder(ctx, path, st, { tails: new Set(), overflow: false })).tree);
          throw error;
        }
        bytes = measured(plan.tree);
        if (failure) throw failure;
        if (now() - verdict.end <= settings.floorMs) throw new Keep('minimum-age');
        if (plan.keep.size && !plan.tree.removable) throw new Keep('referenced');
        if (now() - plan.tree.newest <= GRACE_MS) throw new Keep('recent-change');
        if (plan.tree.shared.size) throw new Keep('hard-linked');
        candidates.push({ run: name, end: verdict.end, task: verdict.task, st, digest: plan.tree.digest, keep: plan.keep, bytes });
      } catch (error) {
        held(reasonOf(error), name, bytes);
      }
    }
    total += [...shared.values()].reduce((sum, size) => sum + size, 0);
    summary.totalBytes = total;

    candidates.sort((a, b) => a.end - b.end || a.run.localeCompare(b.run));
    for (const candidate of candidates) {
      const { run, st } = candidate;
      const path = join(root, run);
      let fd = null;
      let freed = 0;
      let touched = false;
      try {
        const expired = now() - candidate.end > settings.ageMs;
        if (!expired && total - summary.freedBytes - summary.wouldFreeBytes <= settings.limitBytes) throw new Keep('within-budget');
        if (platform !== 'win32') {
          fd = openSync(path, DIRECTORY_FLAGS);
          if (!sameEntry(fstatSync(fd, BIG), st)) throw new Keep('replaced');
        }
        assertDirectory(path, st);
        await check(path, fd);
        assertDirectory(path, st);
        ctx.mounts = mountsBelow(root, platform);
        if (ctx.mounts.some((point) => point === path || point.startsWith(`${path}/`))) throw new Keep('mount');

        // Everything again, after the slowest step: state, settings, references, then the tree.
        const fresh = await evidence.collect();
        const final = evidence.evaluate(run, fresh);
        const settingsNow = evidence.settings();
        if (final.end !== candidate.end || final.task !== candidate.task
          || settingsNow.ageMs !== settings.ageMs || settingsNow.limitBytes !== settings.limitBytes || settingsNow.floorMs !== settings.floorMs) {
          throw new Keep('changed-state');
        }
        const current = lstatSync(path, BIG);
        if (rootStamp(current, platform) !== rootStamp(st, platform)) throw new Keep('changing-folder');
        const plan = await planFolder(ctx, path, current, evidence.referencesTo(run));
        if ([...plan.keep].sort().join('\0') !== [...candidate.keep].sort().join('\0')) throw new Keep('changed-references');
        if (now() - plan.tree.newest <= GRACE_MS || plan.tree.digest !== candidate.digest) throw new Keep('changing-folder');
        if (plan.tree.shared.size) throw new Keep('hard-linked');
        const removable = plan.tree.bytes - plan.tree.keptBytes;
        const whole = plan.keep.size === 0;

        if (dryRun) {
          if (whole) summary.wouldRemove += 1;
          else summary.wouldPrune += 1;
          summary.wouldFreeBytes += removable;
          emit({
            runId: run, action: whole ? 'remove' : 'prune', reason: expired ? 'age' : 'pressure', bytes: removable,
            entries: plan.tree.removable + (whole ? 1 : 0), keptBytes: plan.tree.keptBytes, keptEntries: plan.tree.keptEntries,
            keep: [...plan.keep].sort().slice(0, 20),
          });
          continue;
        }

        if (await confirm({ check: run, task: candidate.task, finished: candidate.end }) !== true) throw new Keep('live-owner');
        assertDirectory(path, st);
        if (fd !== null && !sameEntry(fstatSync(fd, BIG), st)) throw new Keep('replaced');
        ctx.cutoff = now() - GRACE_MS;
        const credit = (size) => { touched = true; freed += size; summary.freedBytes += size; };
        await removeContents(ctx, path, '', st, plan.keep, ancestorsOf(plan.keep), plan.tree.links, credit);
        if (whole) {
          if (fd !== null) { closeSync(fd); fd = null; }
          assertDirectory(path, st);
          rmdirSync(path);
          credit(bytesOf(st, platform));
          summary.removed += 1;
        } else summary.pruned += 1;
      } catch (error) {
        if (touched) {
          summary.pruned += 1;
          held(`stopped:${reasonOf(error)}`, run, Math.max(0, candidate.bytes - freed));
        } else held(reasonOf(error), run, candidate.bytes);
      } finally {
        if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
      }
    }
  };

  try {
    const lock = await withPassLock(join(home, 'runtime', 'scratch-retention.mutex'), pass);
    if (lock.busy) summary.passReason = 'another-pass';
  } catch (error) {
    summary.passReason = error?.code === 'ENOENT' ? 'missing-directory-or-state' : reasonOf(error);
  }
  return summary;
}
