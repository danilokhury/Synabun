/**
 * Can this target be built here, and would what comes out work?
 *
 * Answered before a single file is staged, from three things: the host this
 * runs on, the tools it has, and the lockfiles. The lockfiles say which
 * operating systems and processors each native dependency was published for,
 * so a target one of them does not cover is refused with the package, its
 * version and what it does cover, never built into something that only looks
 * complete.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostRuntimeFor, nodeRuntimeFor, readPins, REPO_ROOT, TARGETS } from './targets.mjs';
import { EXIT, which } from './util.mjs';

/** What this machine is. */
export function hostFacts({ platform = process.platform, arch = process.arch, report = process.report } = {}) {
  let libc = null;
  if (platform === 'linux') {
    try { libc = report.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl'; } catch { libc = 'unknown'; }
  }
  let rosetta = false;
  if (platform === 'darwin' && arch === 'arm64') {
    try { rosetta = spawnSync('/usr/bin/arch', ['-x86_64', '/usr/bin/true'], { stdio: 'ignore', timeout: 10000 }).status === 0; } catch {}
  }
  return { platform, arch, libc, rosetta };
}

export function readLocks(repoRoot = REPO_ROOT) {
  const read = (folder) => JSON.parse(readFileSync(join(repoRoot, folder, 'package-lock.json'), 'utf8')).packages || {};
  return { 'neural-interface': read('neural-interface'), 'mcp-server': read('mcp-server') };
}

const key = (target) => `${target.platform}-${target.arch}`;

function covers(entry, target) {
  if (entry.os && !entry.os.includes(target.platform)) return false;
  if (entry.cpu && !entry.cpu.includes(target.arch)) return false;
  if (entry.libc && target.libc && !entry.libc.includes(target.libc)) return false;
  return true;
}

/** The per-platform packages a dependency installs one of, as the lockfile lists them. */
function platformPackages(packages, name) {
  const parent = packages[`node_modules/${name}`];
  if (!parent) return null;
  const list = [];
  for (const optional of Object.keys(parent.optionalDependencies || {})) {
    const entry = packages[`node_modules/${optional}`];
    if (entry && (entry.os || entry.cpu)) list.push({ name: optional, os: entry.os || null, cpu: entry.cpu || null, libc: entry.libc || null });
  }
  return { version: parent.version, list };
}

const describe = (entry) => `${(entry.os || ['any']).join('/')}-${(entry.cpu || ['any']).join('/')}${entry.libc ? ` (${entry.libc.join('/')})` : ''}`;

/**
 * One line per native dependency: 'ok', 'source-build' (compiled on the build
 * host), 'unverified' (nothing here says either way) or 'blocked' (published,
 * and not for this target).
 */
export function nativeRequirements(target, { locks = readLocks(), pins = readPins() } = {}) {
  const neural = locks['neural-interface'];
  const out = [];

  const perPlatform = (name, feature, lock = neural, lockName = 'neural-interface') => {
    const found = platformPackages(lock, name);
    if (!found) return out.push({ package: name, lock: lockName, status: 'unverified', feature, note: 'not in the lockfile' });
    const match = found.list.find(entry => covers(entry, target));
    out.push({
      package: name,
      version: found.version,
      lock: lockName,
      feature,
      status: match ? 'ok' : 'blocked',
      provides: match ? match.name : null,
      supported: [...new Set(found.list.map(describe))].sort(),
      note: match ? null : `no build for ${key(target)}`,
    });
  };

  // Claude Code and Codex are not here: they are the user's own installations
  // and no target ships them (lib/external-tools.js), so none is held back by
  // what their publishers build for.
  perPlatform('sharp', 'image handling for the embedding library');

  for (const [lockName, lock] of Object.entries(locks)) {
    const entry = lock['node_modules/onnxruntime-node'];
    if (!entry) continue;
    const table = pins.nativeModules?.['onnxruntime-node']?.[entry.version];
    const archs = table?.[target.platform];
    out.push({
      package: 'onnxruntime-node',
      version: entry.version,
      lock: lockName,
      feature: 'local embeddings: vector remember and recall',
      status: !table ? 'unverified' : archs?.includes(target.arch) ? 'ok' : 'blocked',
      supported: table ? Object.entries(table).flatMap(([os, list]) => list.map(cpu => `${os}-${cpu}`)).sort() : [],
      note: !table
        ? `version ${entry.version} is not in packaging/pins.json (nativeModules); check its bin/napi-v3 folders and add it`
        : archs?.includes(target.arch) ? null : `ships no binary for ${key(target)}`,
    });
  }

  const playwright = neural['node_modules/playwright-core'];
  if (playwright) {
    const supported = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'];
    out.push({
      package: 'playwright-core',
      version: playwright.version,
      lock: 'neural-interface',
      feature: 'the managed browser (browser tools, automations)',
      status: supported.includes(key(target)) ? 'ok' : 'blocked',
      supported,
      note: supported.includes(key(target)) ? null : 'treats every Windows host as 64-bit and downloads only 64-bit browsers',
    });
  }

  const pty = neural['node_modules/node-pty'];
  if (pty) {
    const prebuilds = pins.nativeModules?.['node-pty']?.[pty.version]?.prebuilds;
    const prebuilt = prebuilds?.includes(key(target));
    out.push({
      package: 'node-pty',
      version: pty.version,
      lock: 'neural-interface',
      feature: 'terminals',
      status: prebuilt ? 'ok' : target.platform === 'win32' ? 'unverified' : 'source-build',
      supported: prebuilds || [],
      note: prebuilt ? null
        : target.platform === 'win32'
          ? `no prebuilt binary for ${key(target)}; a build from source with the 32-bit MSVC tools has never been verified`
          : 'no prebuilt binary; compiled from source during the build (python3, make and a C++ compiler)',
    });
  }

  return out;
}

function findMsvc(env = process.env) {
  const vswhere = join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!existsSync(vswhere)) return null;
  const found = spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true });
  const root = String(found.stdout || '').trim().split(/\r?\n/)[0];
  const script = root ? join(root, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat') : null;
  return script && existsSync(script) ? script : null;
}

function findMingw(target, env = process.env) {
  const prefix = target.arch === 'ia32' ? 'i686-w64-mingw32' : 'x86_64-w64-mingw32';
  for (const name of [`${prefix}-gcc`, 'gcc']) {
    const path = which(name, env);
    if (!path) continue;
    const machine = String(spawnSync(path, ['-dumpmachine'], { encoding: 'utf8', windowsHide: true }).stdout || '').trim();
    if (machine.startsWith(prefix)) return { gcc: path, windres: which(`${prefix}-windres`, env) || which('windres', env) };
  }
  return null;
}

export function findNsis(env = process.env) {
  return which('makensis', env)
    || [env['ProgramFiles(x86)'], env.ProgramFiles].filter(Boolean).map(root => join(root, 'NSIS', 'makensis.exe')).find(existsSync)
    || null;
}

/** The tools a build of this target uses on this host: { name, path, required, purpose }. */
export function toolsFor(target, { env = process.env, natives = [], cross = false } = {}) {
  const tool = (name, purpose, { required = true, path = which(name, env) } = {}) => ({ name, path: path || null, required, purpose });
  if (cross) {
    return [
      tool('zig', 'compiles the native entry and the terminal module for the target', { path: env.ZIG || which('zig', env) }),
      tool('tar', 'unpacks the Node runtimes'),
      ...(target.platform === 'linux' ? [
        tool('mksquashfs', 'creates the AppImage; without it the build is a portable archive', { required: false, path: env.MKSQUASHFS || which('mksquashfs', env) }),
      ] : [
        tool('makensis', 'creates the installer; without it the build is a zip', { required: false, path: findNsis(env) }),
        tool('sips', 'renders the icon of the executable', { required: false }),
      ]),
    ];
  }
  if (target.platform === 'darwin') {
    return [
      tool('clang', 'compiles the native entry'),
      tool('tar', 'unpacks the Node runtime'),
      tool('hdiutil', 'creates the disk image'),
      tool('ditto', 'creates the zip archive'),
      tool('sips', 'renders the application icon', { required: false }),
      tool('iconutil', 'renders the application icon', { required: false }),
      tool('codesign', 'signs the application when an identity is given', { required: false }),
    ];
  }
  if (target.platform === 'linux') {
    const compile = natives.some(native => native.status === 'source-build');
    return [
      tool('cc', 'compiles the native entry'),
      tool('tar', 'unpacks the Node runtime, creates the portable archive'),
      tool('python3', 'node-gyp, for the terminal module', { required: compile }),
      tool('make', 'node-gyp, for the terminal module', { required: compile }),
      tool('g++', 'node-gyp, for the terminal module', { required: compile }),
    ];
  }
  const msvc = findMsvc(env);
  const mingw = msvc ? null : findMingw(target, env);
  const systemTar = join(env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return [
    tool('C compiler', 'compiles the native entry (Visual Studio C++ tools, or MinGW-w64 for this processor)', { path: msvc || mingw?.gcc || null }),
    tool('tar.exe', 'unpacks the Node runtime', { path: existsSync(systemTar) ? systemTar : null }),
    tool('makensis', 'creates the installer; without it the build is a zip', { required: false, path: findNsis(env) }),
    tool('signtool', 'signs the executable and the installer when a certificate is given', { required: false }),
  ];
}

export function toolchain(target, env = process.env) {
  if (target.platform !== 'win32') return {};
  const msvc = findMsvc(env);
  return { msvc, mingw: msvc ? null : findMingw(target, env), nsis: findNsis(env) };
}

/**
 * The verdict for one target: 'ready', 'blocked' (a dependency has no build
 * for it), 'host-mismatch' (it cannot be built on this machine) or
 * 'missing-tools'. `exitCode` is what `preflight` and `build` end with.
 */
export function evaluateTarget(target, { host = hostFacts(), locks = readLocks(), pins = readPins(), env = process.env, tools, cross = false } = {}) {
  const natives = nativeRequirements(target, { locks, pins });
  const blockers = natives.filter(native => native.status === 'blocked')
    .map(native => `${native.package} ${native.version} (${native.lock}): ${native.note}. Published for: ${native.supported.join(', ')}. Needed for: ${native.feature}.`);
  // A product decision outlives the lockfiles: such a target stays refused whatever gets published.
  if (target.unsupported) blockers.unshift(`not a supported target: ${target.unsupported}.`);
  const warnings = natives.filter(native => native.status === 'unverified')
    .map(native => `${native.package}${native.version ? ` ${native.version}` : ''}: ${native.note}`);

  let runtime = null;
  try { runtime = nodeRuntimeFor(target, pins); } catch (error) { blockers.push(error.message); }

  const native = target.hosts.find(candidate => candidate.platform === host.platform && candidate.arch === host.arch
    && (!candidate.libc || candidate.libc === host.libc)
    && (candidate.needs !== 'rosetta' || host.rosetta));
  // A cross build is never chosen for a machine that can build the target for real.
  const crossRuntime = !native && cross && target.cross ? hostRuntimeFor(host, pins) : null;
  const mode = native ? 'native' : crossRuntime ? 'cross' : null;
  const hostProblem = mode ? null : (() => {
    const wanted = target.hosts.map(candidate => `${candidate.platform}-${candidate.arch}${candidate.libc ? ` (${candidate.libc})` : ''}${candidate.needs ? ` with ${candidate.needs}` : ''}`).join(' or ');
    const here = `this is ${host.platform}-${host.arch}${host.libc ? ` (${host.libc})` : ''}`;
    const other = !target.cross ? (cross ? ` ${target.id} has no cross build.` : '')
      : cross ? ` A cross build needs macOS or Linux (glibc) with a pinned Node, which this machine is not.`
        : ` Or cross-build it on macOS or Linux with --cross (checked, never run).`;
    return `${here}; ${target.id} is built on ${wanted}. In CI: the "${target.runner}" runner.${other}`;
  })();

  const toolList = mode ? (tools || toolsFor(target, { env, natives, cross: mode === 'cross' })) : [];
  const missing = toolList.filter(item => item.required && !item.path).map(item => `${item.name}: ${item.purpose}`);

  const status = blockers.length ? 'blocked' : hostProblem ? 'host-mismatch' : missing.length ? 'missing-tools' : 'ready';
  return {
    target: target.id,
    label: target.label,
    npmScript: target.npmScript,
    status,
    // 'native', 'cross', or null when this machine cannot build the target either way.
    mode,
    exitCode: { ready: EXIT.ok, blocked: EXIT.blocked, 'host-mismatch': EXIT.hostMismatch, 'missing-tools': EXIT.missingTools }[status],
    host,
    hostProblem,
    blockers,
    warnings,
    missingTools: missing,
    natives,
    tools: toolList,
    runtime,
    runner: target.runner,
    artifacts: target.artifacts,
  };
}

export function evaluateAll(options = {}) {
  const shared = { host: hostFacts(), locks: readLocks(), pins: readPins(), ...options };
  return Object.values(TARGETS).map(target => evaluateTarget(target, shared));
}

const STATUS_TEXT = {
  ready: 'ready to build here',
  blocked: 'BLOCKED: not a supported target, or a dependency has no build for it',
  'host-mismatch': 'not buildable on this machine',
  'missing-tools': 'tools missing on this machine',
};

/** The report `targets` and a refused build print. */
export function formatVerdict(verdict, { verbose = false } = {}) {
  const crossed = verdict.mode === 'cross';
  const lines = [
    `${verdict.target.padEnd(13)} ${verdict.label}`,
    `  status   ${STATUS_TEXT[verdict.status]}${crossed && verdict.status === 'ready' ? ' as a cross build (checked, never run)' : ''}`,
    `  command  npm run ${verdict.npmScript}${crossed ? ' -- --cross' : ''}`,
  ];
  lines.push(`  produces ${verdict.artifacts.join(' or ')}; CI runner ${verdict.runner}`);
  for (const blocker of verdict.blockers) lines.push(`  blocker  ${blocker}`);
  if (verdict.hostProblem) lines.push(`  host     ${verdict.hostProblem}`);
  for (const item of verdict.missingTools) lines.push(`  missing  ${item}`);
  for (const warning of verdict.warnings) lines.push(`  warning  ${warning}`);
  if (verbose) {
    for (const native of verdict.natives) lines.push(`  native   ${native.package} ${native.version || ''} [${native.lock}]: ${native.status}${native.provides ? ` (${native.provides})` : ''}`);
    for (const item of verdict.tools) lines.push(`  tool     ${item.name}: ${item.path || (item.required ? 'MISSING' : 'not found (optional)')}`);
  }
  return lines.join('\n');
}
