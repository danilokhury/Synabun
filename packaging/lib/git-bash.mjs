/**
 * Git for Windows in the Windows installer.
 *
 * Claude Code on Windows runs its Bash tool and every hook through Git Bash
 * and falls back to PowerShell without one, where the hooks an installed
 * SynaBun registers do not even parse. The Windows x64 installer therefore
 * carries a private, unchanged copy of Git for Windows, used only when the PC
 * has no Git Bash of its own (neural-interface/lib/git-bash/resolver.js). An
 * npm install on Windows downloads the same pinned file on first need
 * (lib/git-bash/manager.js); macOS and Linux get none.
 *
 * Which release, and what it has to be, is the application's own knowledge:
 * the pins (neural-interface/lib/git-bash/pins.json) and the code that reads
 * and checks the archive are taken from the application that was staged, so
 * an installer never carries a Git the application would not have fetched
 * itself. The release file is downloaded over HTTPS from Git for Windows' own
 * GitHub release and compared with its pinned SHA-256 before anything reads
 * it; it is unpacked by the application's own reader (no tar program, the
 * same on every build machine), and what was unpacked is compared with the
 * pinned tree: every file's path, size and SHA-256. It waits in the work
 * folder; the bundle step puts it beside the runtime (bundle.mjs placeGitBash),
 * where the application looks for it, and the audit checks it there again
 * (verify.mjs).
 *
 *   fetchGitBashArchive  the verified release file, kept in the build cache
 *                        (also what `node packaging/fetch-git-for-windows.mjs`
 *                        runs, in CI before the build)
 *   provisionGitBash     the stage step: the checked tree in <work>/git, for a
 *                        Windows target; nothing for any other
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BuildError, fetchVerified, FORMAT_PLATFORM, nativeFormat, note, removeTree, step } from './util.mjs';

/** The application's own Git for Windows modules and pins, from a folder that holds `neural-interface/lib/git-bash`. */
export async function gitBashModulesOf(appRoot) {
  const lib = join(appRoot, 'neural-interface', 'lib', 'git-bash');
  const pinsModule = await import(pathToFileURL(join(lib, 'pins.js')).href);
  const install = await import(pathToFileURL(join(lib, 'install.js')).href);
  const pins = pinsModule.readGitBashPins(join(lib, 'pins.json'));
  return { lib, pins, pinsModule, install };
}

/** Where a build keeps a release file it verified: `<cache>/git-for-windows/<version>/<file>`. */
export function gitBashCachePath(cache, pin) {
  return join(cache, 'git-for-windows', pin.version, pin.file);
}

/** The pinned release file for `pin`, downloaded once into the cache and checked against its SHA-256: its path. */
export function fetchGitBashArchive({ pin, cache, fetchImpl }) {
  return fetchVerified({ url: pin.url, sha256: pin.sha256, destination: gitBashCachePath(cache, pin), label: `${pin.file} (Git for Windows ${pin.version})`, fetchImpl });
}

/**
 * The stage step. For a Windows target: the pinned Git for Windows, its release file checked, unpacked by the
 * application's own reader and checked file by file against the pinned tree, with its license and source files,
 * in `<work>/git` (ctx.gitBash). For every other target nothing is staged, and the report says so.
 */
export async function provisionGitBash(ctx) {
  const { platform, arch } = ctx.target;
  if (platform !== 'win32') {
    ctx.gitBash = null;
    ctx.report.gitBash = { packaged: false, reason: `not for ${platform}: Claude Code runs the system's shell there` };
    return;
  }
  step('Git for Windows (the Git Bash Claude Code needs on Windows)');
  let found;
  try {
    found = await gitBashModulesOf(ctx.app);
  } catch (error) {
    throw new BuildError('The staged application does not say which Git for Windows it uses. Nothing was packaged.', { details: [String(error?.message || error)] });
  }
  const { pins, pinsModule, install } = found;
  const pin = pinsModule.gitBashPinFor(pins, platform, arch);
  if (!pin) {
    throw new BuildError(`No Git for Windows is pinned for ${ctx.target.id}. Nothing was packaged.`, {
      details: [`pinned: ${Object.keys(pins.platforms).join(', ') || 'none'}`, 'A Windows installer carries Git Bash for Claude Code; add this target to neural-interface/lib/git-bash/pins.json.'],
    });
  }
  const archive = await fetchGitBashArchive({ pin, cache: ctx.cache, fetchImpl: ctx.fetch });
  const folder = join(ctx.work, pinsModule.BUNDLED_FOLDER);
  removeTree(folder);
  mkdirSync(folder, { recursive: true });
  let result;
  try {
    // The tree is written in the build machine's separators; the installer holds it as Windows will.
    result = install.unpackAndCheck({ archive, destination: folder, pins, pin, source: 'bundled', onStep: (what) => note(what === 'extract' ? 'unpacking (the application\'s own bzip2 and tar reader)' : 'comparing every file with the pinned tree') });
  } catch (error) {
    removeTree(folder);
    throw new BuildError(`Git for Windows ${pin.version} for ${ctx.target.id} is not the pinned release. Nothing was packaged.`, { details: [String(error?.message || error), `from ${pin.url}`] });
  }
  for (const rel of [pin.bash, pin.git]) {
    const format = nativeFormat(pinsModule.inTree(folder, rel, process.platform));
    if (FORMAT_PLATFORM[format?.format] !== platform || !format.archs.includes(arch)) {
      removeTree(folder);
      throw new BuildError(`The pinned Git for Windows for ${ctx.target.id} has a ${rel} that is ${format ? `a ${FORMAT_PLATFORM[format.format]} ${format.archs.join('+')} program` : 'not a program'}, not one for ${platform}-${arch}. Nothing was packaged.`);
    }
  }
  ctx.gitBash = { folder, pin };
  ctx.report.gitBash = {
    packaged: true,
    version: pin.version, tag: pin.tag, file: pin.file, url: pin.url, sha256: pin.sha256,
    tree: result.digest, skipped: result.skipped,
    license: pins.license, source: pins.source, origin: pins.origin,
  };
  note(`Git for Windows ${pin.version}: release file and ${result.digest.files} files match their pins (${result.links} hard links, ${result.skipped.length} links into /proc left out)`);
}
