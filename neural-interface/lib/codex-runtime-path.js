import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const CODEX_TARGETS = {
  'win32:x64': {
    targetTriple: 'x86_64-pc-windows-msvc',
    platformPackage: '@openai/codex-win32-x64',
    binaryName: 'codex.exe',
  },
  'win32:arm64': {
    targetTriple: 'aarch64-pc-windows-msvc',
    platformPackage: '@openai/codex-win32-arm64',
    binaryName: 'codex.exe',
  },
};

const CODEX_VENDOR_BINARY_DIRS = ['bin', 'codex'];

export function codexPlatformTarget(platform = process.platform, arch = process.arch) {
  return CODEX_TARGETS[`${platform}:${arch}`] || null;
}

function uniquePaths(values, pathImpl) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (!value) continue;
    const normalized = pathImpl.normalize(String(value).trim());
    const key = normalized.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }
  return result;
}

/**
 * Pick a Windows launcher suitable for the sidepanel's shell-aware spawn path.
 * npm lists its extensionless sh shim before the native Windows launcher, so
 * prefer a PATHEXT-style launcher while retaining the first result as a last
 * resort for non-npm installations.
 */
export function selectWindowsCodexLauncher(launchers = [], acceptLauncher = () => true) {
  const accepted = uniquePaths(launchers, path.win32).filter(acceptLauncher);
  return accepted.find((launcher) => /\.(cmd|exe|bat|ps1)$/i.test(launcher))
    || accepted[0]
    || null;
}

function packageJsonCandidatesForLauncher(launcher, pathImpl) {
  const binDir = pathImpl.dirname(launcher);
  const candidates = [
    pathImpl.join(binDir, 'node_modules', '@openai', 'codex', 'package.json'),
  ];
  if (pathImpl.basename(binDir).toLowerCase() === '.bin') {
    candidates.push(pathImpl.join(pathImpl.dirname(binDir), '@openai', 'codex', 'package.json'));
  }
  return candidates;
}

export function windowsCodexPackageJsonCandidates({
  npmRoots = [],
  appData = '',
  npmConfigPrefix = '',
  synabunPackageRoot = '',
  nodeExecutable = '',
} = {}) {
  const pathImpl = path.win32;
  const nodeModulesRoots = [...npmRoots];
  if (appData) nodeModulesRoots.push(pathImpl.join(appData, 'npm', 'node_modules'));
  if (npmConfigPrefix) {
    nodeModulesRoots.push(
      pathImpl.basename(npmConfigPrefix).toLowerCase() === 'node_modules'
        ? npmConfigPrefix
        : pathImpl.join(npmConfigPrefix, 'node_modules'),
    );
  }
  if (
    synabunPackageRoot
    && pathImpl.basename(synabunPackageRoot).toLowerCase() === 'synabun'
    && pathImpl.basename(pathImpl.dirname(synabunPackageRoot)).toLowerCase() === 'node_modules'
  ) {
    nodeModulesRoots.push(pathImpl.dirname(synabunPackageRoot));
  }
  if (nodeExecutable) {
    nodeModulesRoots.push(pathImpl.join(pathImpl.dirname(nodeExecutable), 'node_modules'));
  }
  return uniquePaths(
    nodeModulesRoots.map((root) => pathImpl.join(root, '@openai', 'codex', 'package.json')),
    pathImpl,
  );
}

function defaultResolvePlatformPackage(codexPackageJsonPath, platformPackage) {
  const req = createRequire(codexPackageJsonPath);
  return req.resolve(`${platformPackage}/package.json`);
}

function vendorBinaryCandidates(packageJsonPath, spec, pathImpl) {
  const packageDir = pathImpl.dirname(packageJsonPath);
  return CODEX_VENDOR_BINARY_DIRS.map((binaryDir) => pathImpl.join(
    packageDir,
    'vendor',
    spec.targetTriple,
    binaryDir,
    spec.binaryName,
  ));
}

/**
 * Resolve the spawnable native Codex executable from a trusted global npm
 * installation on Windows. `@openai/codex-sdk` uses child_process.spawn with
 * shell:false, so npm's extensionless/.cmd launchers are not valid overrides.
 *
 * Dependencies are injectable so Windows path behavior can be tested on Unix.
 */
export function resolveTrustedWindowsCodexBinary({
  launchers = [],
  codexPackageJsonPaths = [],
  arch = process.arch,
  exists = existsSync,
  resolvePlatformPackage = defaultResolvePlatformPackage,
  acceptBinary = () => true,
} = {}) {
  const spec = codexPlatformTarget('win32', arch);
  if (!spec) {
    return { path: null, reason: `Unsupported Windows architecture: ${arch}`, checked: [] };
  }

  const pathImpl = path.win32;
  const launcherPaths = uniquePaths(launchers, pathImpl);
  const checked = [];

  // A direct native executable on PATH is already suitable for SDK spawn.
  for (const launcher of launcherPaths) {
    checked.push(launcher);
    if (/\.exe$/i.test(launcher) && exists(launcher) && acceptBinary(launcher)) {
      return { path: launcher, source: 'path-exe', launcher, ...spec, checked };
    }
  }

  const packageJsonPaths = uniquePaths([
    ...codexPackageJsonPaths,
    ...launcherPaths.flatMap((launcher) => packageJsonCandidatesForLauncher(launcher, pathImpl)),
  ], pathImpl);

  for (const codexPackageJsonPath of packageJsonPaths) {
    checked.push(codexPackageJsonPath);
    if (!exists(codexPackageJsonPath)) continue;

    for (const localVendorBinary of vendorBinaryCandidates(codexPackageJsonPath, spec, pathImpl)) {
      checked.push(localVendorBinary);
      if (exists(localVendorBinary) && acceptBinary(localVendorBinary)) {
        return {
          path: localVendorBinary,
          source: 'global-package-vendor',
          packageJsonPath: codexPackageJsonPath,
          ...spec,
          checked,
        };
      }
    }

    let resolvedPlatformPackageJsonPath = null;
    try {
      resolvedPlatformPackageJsonPath = resolvePlatformPackage(
        codexPackageJsonPath,
        spec.platformPackage,
      );
    } catch (error) {
      checked.push(`${codexPackageJsonPath} -> ${spec.platformPackage}: ${error.message}`);
    }

    // npm usually hoists the aliased platform package beside @openai/codex,
    // but some npm versions keep it inside that package's node_modules. Check
    // both layouts directly so package exports/hoisting do not block discovery.
    const platformSegments = spec.platformPackage.split('/');
    const codexPackageDir = pathImpl.dirname(codexPackageJsonPath);
    const globalNodeModules = pathImpl.dirname(pathImpl.dirname(codexPackageDir));
    const platformPackageJsonPaths = uniquePaths([
      resolvedPlatformPackageJsonPath,
      pathImpl.join(globalNodeModules, ...platformSegments, 'package.json'),
      pathImpl.join(codexPackageDir, 'node_modules', ...platformSegments, 'package.json'),
    ], pathImpl);

    for (const platformPackageJsonPath of platformPackageJsonPaths) {
      checked.push(platformPackageJsonPath);
      if (!exists(platformPackageJsonPath)) continue;
      for (const platformBinary of vendorBinaryCandidates(platformPackageJsonPath, spec, pathImpl)) {
        checked.push(platformBinary);
        if (exists(platformBinary) && acceptBinary(platformBinary)) {
          return {
            path: platformBinary,
            source: 'global-platform-package',
            packageJsonPath: codexPackageJsonPath,
            platformPackageJsonPath,
            ...spec,
            checked,
          };
        }
      }
    }
  }

  return {
    path: null,
    reason: `No spawnable ${spec.binaryName} was found in the global Codex installation`,
    ...spec,
    checked,
  };
}
