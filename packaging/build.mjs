#!/usr/bin/env node

/**
 * SynaBun — application builder
 *
 *   node packaging/build.mjs targets [--json] [--verbose] [--cross]
 *       every target, whether it can be built on this machine, and why not
 *   node packaging/build.mjs preflight --target <id> [--json] [--cross]
 *       the same question for one target; the exit code is the answer
 *   node packaging/build.mjs build --target <id> [options]
 *       build that target's application and its installable artifact
 *
 * --cross allows a Linux or Windows target to be built on macOS or Linux. Such
 * a build is checked file by file and never run; without the flag a machine
 * only builds what it can also run.
 *
 * Exit codes: 0 done / ready, 1 the build failed, 2 this machine cannot build
 * that target, 3 a dependency has no build for that target, 4 tools are
 * missing, 64 the command line is wrong.
 *
 * A refused build stops before anything is downloaded, staged or removed.
 * See packaging/README.md.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { evaluateAll, evaluateTarget, formatVerdict } from './lib/preflight.mjs';
import { getTarget, readPins, REPO_ROOT, TARGETS } from './lib/targets.mjs';
import { BuildError, EXIT, note, removeTree, sha256File, step } from './lib/util.mjs';

const USAGE = `SynaBun application builder

  node packaging/build.mjs targets [--json] [--verbose] [--cross]
  node packaging/build.mjs preflight --target <id> [--json] [--cross]
  node packaging/build.mjs build --target <id> [options]

Targets: ${Object.keys(TARGETS).join(', ')}

Build options:
  --cross                 build a Linux or Windows target on macOS or Linux (needs zig;
                          the result is checked, never run)
  --out <dir>             where the artifacts go            (default build/out)
  --work <dir>            staging folder, emptied first     (default build/stage)
  --cache <dir>           downloads and the npm cache, kept (default build/cache)
  --artifact <kinds>      comma-separated, from the target's list (default: its first)
  --no-fallback           fail when the first-choice artifact cannot be made
  --no-embedding-model    leave the local embedding model out (keyword recall only)
  --update-model-pins     record the downloaded model's checksums in packaging/pins.json
  --no-tool-downloads     never download a packaging tool, even a pinned one
  --skip-smoke            do not run the finished bundle (it is still audited)
  --keep-work             keep the staging folder afterwards
`;

function parse(argv) {
  const [command, ...rest] = argv;
  const options = { command, flags: new Set(), values: {} };
  const takesValue = new Set(['--target', '--out', '--work', '--cache', '--artifact']);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (takesValue.has(arg)) {
      const value = rest[++i];
      if (value === undefined || value.startsWith('--')) throw new BuildError(`${arg} needs a value`, { exitCode: EXIT.usage });
      options.values[arg.slice(2)] = value;
    } else if (arg.startsWith('--')) {
      options.flags.add(arg.slice(2));
    } else {
      throw new BuildError(`Unexpected argument "${arg}"`, { exitCode: EXIT.usage });
    }
  }
  return options;
}

function targetFrom(options) {
  if (!options.values.target) throw new BuildError('Name a target with --target <id>', { exitCode: EXIT.usage, details: [`Targets: ${Object.keys(TARGETS).join(', ')}`] });
  try { return getTarget(options.values.target); } catch (error) { throw new BuildError(error.message, { exitCode: EXIT.usage }); }
}

function listTargets(options) {
  const verdicts = evaluateAll({ cross: options.flags.has('cross') });
  if (options.flags.has('json')) {
    console.log(JSON.stringify(verdicts, null, 2));
    return EXIT.ok;
  }
  const host = verdicts[0].host;
  console.log(`This machine: ${host.platform}-${host.arch}${host.libc ? ` (${host.libc})` : ''}${host.rosetta ? ', Rosetta 2 available' : ''}\n`);
  console.log(verdicts.map(verdict => formatVerdict(verdict, { verbose: options.flags.has('verbose') })).join('\n\n'));
  console.log('\nEvery target is built on its own operating system. With --cross, Linux and Windows can also be built on macOS or Linux: checked, never run.');
  return EXIT.ok;
}

function preflight(options) {
  const verdict = evaluateTarget(targetFrom(options), { cross: options.flags.has('cross') });
  console.log(options.flags.has('json') ? JSON.stringify(verdict, null, 2) : formatVerdict(verdict, { verbose: true }));
  return verdict.exitCode;
}

function sourceCommit(repoRoot) {
  const head = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
  return head.status === 0 ? head.stdout.trim() : null;
}

async function build(options) {
  const target = targetFrom(options);
  const verdict = evaluateTarget(target, { cross: options.flags.has('cross') });
  if (verdict.status !== 'ready') {
    // Refused here: nothing has been downloaded, staged or removed.
    throw new BuildError(`${target.id} cannot be built: ${verdict.status}.`, { exitCode: verdict.exitCode, details: formatVerdict(verdict).split('\n') });
  }
  for (const warning of verdict.warnings) note(`warning: ${warning}`);

  // Loaded only now: a listing or a refusal needs none of it.
  const { fetchRuntime, stageApplication, installDependencies, prepareNatives, provisionEmbeddingModel } = await import('./lib/stage.mjs');
  const { assembleBundle, createArtifacts } = await import('./lib/bundle.mjs');
  const { auditBundle, smokeTest } = await import('./lib/verify.mjs');

  const version = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;
  const root = resolve(REPO_ROOT, 'build');
  const ctx = {
    repoRoot: REPO_ROOT,
    target,
    verdict,
    cross: verdict.mode === 'cross',
    version,
    pins: readPins(),
    sourceCommit: sourceCommit(REPO_ROOT),
    work: resolve(options.values.work || join(root, 'stage'), target.id),
    cache: resolve(options.values.cache || join(root, 'cache')),
    out: resolve(options.values.out || join(root, 'out')),
    options: {
      embeddingModel: !options.flags.has('no-embedding-model'),
      updateModelPins: options.flags.has('update-model-pins'),
      toolDownloads: !options.flags.has('no-tool-downloads'),
      portableFallback: !options.flags.has('no-fallback'),
      artifacts: options.values.artifact ? options.values.artifact.split(',').map(kind => kind.trim()).filter(Boolean) : null,
    },
    report: { target: target.id, version, mode: verdict.mode, startedAt: new Date().toISOString() },
  };

  step(`SynaBun ${version} for ${target.id} (${target.label})${ctx.cross ? `, cross-built on ${process.platform}-${process.arch}` : ''}`);
  note(`staging in ${ctx.work}`);
  // Only ever this target's own staging folder, and only after the checks above.
  removeTree(ctx.work);
  mkdirSync(ctx.work, { recursive: true });
  mkdirSync(ctx.cache, { recursive: true });

  await fetchRuntime(ctx);
  stageApplication(ctx);
  await installDependencies(ctx);
  await prepareNatives(ctx);
  await provisionEmbeddingModel(ctx);
  assembleBundle(ctx);
  await auditBundle(ctx);
  if (ctx.cross) {
    ctx.report.smoke = `not run: cross-built on ${process.platform}-${process.arch}, which cannot run a ${target.platform}-${target.arch} application`;
    note('The bundle was not run: this machine cannot run it. Run it on the target before relying on it.');
  } else if (options.flags.has('skip-smoke')) {
    ctx.report.smoke = 'skipped';
    note('The bundle was not run (--skip-smoke).');
  } else {
    await smokeTest(ctx);
  }

  const artifacts = await createArtifacts(ctx);
  const sums = [];
  for (const artifact of artifacts) {
    artifact.sha256 = await sha256File(artifact.path);
    sums.push(`${artifact.sha256}  ${basename(artifact.path)}`);
  }
  const base = `SynaBun-${version}-${target.id}`;
  writeFileSync(join(ctx.out, `${base}.sha256`), sums.join('\n') + '\n');
  Object.assign(ctx.report, {
    finishedAt: new Date().toISOString(),
    node: ctx.runtime.version,
    sourceCommit: ctx.sourceCommit,
    builtOn: `${process.platform}-${process.arch}`,
    artifacts: artifacts.map(artifact => ({ ...artifact, path: basename(artifact.path) })),
  });
  writeFileSync(join(ctx.out, `${base}.build-report.json`), JSON.stringify(ctx.report, null, 2) + '\n');

  if (!options.flags.has('keep-work')) removeTree(ctx.work);

  step('Done');
  for (const artifact of artifacts) {
    note(`${artifact.kind}: ${artifact.path}`);
    note(`  sha256 ${artifact.sha256}${artifact.signed ? `, signed (${artifact.signed === true ? 'yes' : artifact.signed})` : ', NOT signed'}${artifact.notarized ? ', notarized' : ''}`);
  }
  console.log(JSON.stringify({ target: target.id, version, artifacts: artifacts.map(artifact => artifact.path) }));
  return EXIT.ok;
}

async function main(argv) {
  const options = parse(argv);
  switch (options.command) {
    case 'targets': return listTargets(options);
    case 'preflight': return preflight(options);
    case 'build': return build(options);
    case undefined: case 'help': case '--help': case '-h':
      process.stdout.write(USAGE);
      return options.command === undefined ? EXIT.usage : EXIT.ok;
    default:
      throw new BuildError(`Unknown command "${options.command}"`, { exitCode: EXIT.usage, details: USAGE.split('\n') });
  }
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
  if (!(error instanceof BuildError)) {
    console.error(error?.stack || String(error));
    process.exitCode = EXIT.failed;
    return;
  }
  process.stderr.write(`\nBuild stopped: ${error.message}\n`);
  for (const line of error.details) process.stderr.write(`  ${line}\n`);
  process.exitCode = error.exitCode;
});
