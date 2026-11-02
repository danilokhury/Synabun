/**
 * Git for Windows across an update, without unpacking it again.
 *
 * A Windows installer no longer carries Git for Windows as a tree of ~9,600
 * files (resources\git): it carries the pinned release file once
 * (resources\git-archive\<file>), and the application unpacks it into the data
 * home on first need (neural-interface/lib/git-bash/manager.js), where it stays
 * across updates. That keeps ~40% of the files out of every install.
 *
 * An update from a version that still carried the tree would throw a complete,
 * checked copy away and then unpack the same release again. So the new copy,
 * as its first act and before it says it runs (the watchdog removes the old
 * copy only after that), moves the old copy's tree to where the application
 * looks for its own: DATA_HOME\runtime\git\<version>. One rename on the same
 * disk; nothing is copied. Only when:
 *   - this is Windows, and this copy carries the archive and no tree
 *   - the swap's plan names the old copy (<install>.previous), and it is there
 *   - its tree's marker names exactly the release this copy pins (version,
 *     release SHA-256, tree SHA-256); the application checks the files SynaBun
 *     starts again before it uses them (install.js checkInstalled)
 *   - nothing is in the data home's place yet
 * Anything else, or a rename that fails (another disk, a file held), leaves
 * everything as it is: the application unpacks the archive instead.
 *
 * Plain Node (tested in packaging/tests/desktop-install-window.test.mjs).
 */

import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const VERSION_FOLDER = /^\d+\.\d+\.\d+\.\d+$/;

const readJson = (file, read) => { try { return JSON.parse(read(file)); } catch { return null; } };

/**
 * What to move, or why nothing moves: { from, to, version } or { skip: reason }.
 * `resources` is this copy's resources folder; `dataHome` SynaBun's data home.
 */
export function gitAdoptionPlan({ platform = process.platform, stateDir, dataHome, resources, arch = 'x64', exists = existsSync, read = (file) => readFileSync(file, 'utf8') }) {
  if (platform !== 'win32') return { skip: 'not Windows' };
  if (!exists(join(resources, 'git-archive'))) return { skip: 'this copy carries no Git for Windows archive' };
  if (exists(join(resources, 'git'))) return { skip: 'this copy carries its own tree' };
  const plan = readJson(join(stateDir, 'plan.json'), read);
  if (!plan || plan.platform !== 'win32' || typeof plan.backup !== 'string' || !plan.backup) return { skip: 'no update to take it from' };
  const from = join(plan.backup, 'resources', 'git');
  if (!exists(from)) return { skip: 'the earlier copy carries no tree' };
  const marker = readJson(join(from, 'synabun-git.json'), read);
  const pins = readJson(join(resources, 'app', 'neural-interface', 'lib', 'git-bash', 'pins.json'), read);
  const pin = pins?.platforms?.[`win32-${arch}`];
  if (!pins || !pin) return { skip: 'this copy pins no Git for Windows' };
  if (!marker || marker.synabunGit !== 1 || !VERSION_FOLDER.test(String(marker.version))) return { skip: 'the earlier tree has no marker' };
  if (marker.version !== pins.version || marker.sha256 !== pin.sha256 || marker.tree?.sha256 !== pin.tree?.sha256) {
    return { skip: `the earlier tree is Git for Windows ${marker.version}, this copy pins ${pins.version}` };
  }
  const to = join(dataHome, 'runtime', 'git', String(marker.version));
  if (exists(to)) return { skip: 'the data home already has it' };
  return { from, to, version: String(marker.version) };
}

/** Moves the earlier copy's Git for Windows into the data home (gitAdoptionPlan). { adopted, reason }; never throws. */
export function adoptPreviousGit(options = {}) {
  const { rename = renameSync, mkdir = (path) => mkdirSync(path, { recursive: true }) } = options;
  let plan;
  try { plan = gitAdoptionPlan(options); } catch (error) { return { adopted: false, reason: String(error?.message || error) }; }
  if (plan.skip) return { adopted: false, reason: plan.skip };
  try {
    mkdir(join(plan.to, '..'));
    rename(plan.from, plan.to);
    return { adopted: true, reason: null, from: plan.from, to: plan.to, version: plan.version };
  } catch (error) {
    return { adopted: false, reason: `it could not be moved (${error?.code || error?.message || error}); the archive is unpacked instead` };
  }
}
