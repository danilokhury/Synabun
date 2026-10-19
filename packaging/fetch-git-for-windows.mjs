#!/usr/bin/env node

/**
 * SynaBun — fetch the pinned Git for Windows into the build cache
 *
 *   node packaging/fetch-git-for-windows.mjs [--cache <dir>] [--target windows-x64] [--json]
 *
 * Downloads the Git for Windows release file that neural-interface/lib/git-bash/pins.json names for the
 * target, from Git for Windows' own GitHub release over HTTPS, and keeps it in the build cache once its
 * SHA-256 matches the pin (packaging/lib/git-bash.mjs fetchGitBashArchive: the very function the build's
 * stage step uses, which then finds it there). A file that does not match is removed and the exit code is 1.
 * "Build applications" runs this before a Windows build; a local build does the same through build.mjs.
 *
 * Exit codes: 0 the file is in the cache and checked, 1 it is not, 64 the command line is wrong.
 */

import { join, resolve } from 'node:path';
import { fetchGitBashArchive, gitBashModulesOf } from './lib/git-bash.mjs';
import { getTarget, REPO_ROOT } from './lib/targets.mjs';
import { BuildError, EXIT, sha256File } from './lib/util.mjs';

function parse(argv) {
  const options = { cache: join(REPO_ROOT, 'build', 'cache'), target: 'windows-x64', json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--cache' || arg === '--target') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new BuildError(`${arg} needs a value`, { exitCode: EXIT.usage });
      options[arg.slice(2)] = value;
    } else throw new BuildError(`Unexpected argument "${arg}"`, { exitCode: EXIT.usage, details: ['node packaging/fetch-git-for-windows.mjs [--cache <dir>] [--target windows-x64] [--json]'] });
  }
  return options;
}

async function main(argv) {
  const options = parse(argv);
  let target;
  try { target = getTarget(options.target); } catch (error) { throw new BuildError(error.message, { exitCode: EXIT.usage }); }
  // The source checkout's pins: the same file the build later reads from the application it stages.
  const { pins, pinsModule } = await gitBashModulesOf(REPO_ROOT);
  const pin = pinsModule.gitBashPinFor(pins, target.platform, target.arch);
  if (!pin) throw new BuildError(`${target.id} carries no Git for Windows (only a Windows target does, for a processor neural-interface/lib/git-bash/pins.json pins).`, { exitCode: EXIT.usage });
  const cache = resolve(options.cache);
  const path = await fetchGitBashArchive({ pin, cache });
  const facts = { target: target.id, version: pin.version, tag: pin.tag, file: pin.file, url: pin.url, sha256: await sha256File(path), size: pin.size, path };
  if (facts.sha256 !== pin.sha256) throw new BuildError(`${pin.file} in the cache is not the pinned file.`);
  console.log(options.json ? JSON.stringify(facts) : `Git for Windows ${pin.version} (${pin.tag}) for ${target.id}: ${path}, SHA-256 ${facts.sha256} (pinned)`);
  return EXIT.ok;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
  if (!(error instanceof BuildError)) {
    console.error(error?.stack || String(error));
    process.exitCode = EXIT.failed;
    return;
  }
  process.stderr.write(`\nGit for Windows was not fetched: ${error.message}\n`);
  for (const line of error.details) process.stderr.write(`  ${line}\n`);
  process.exitCode = error.exitCode;
});
