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

function defaultResolvePlatformPackage(codexPackageJsonPath, platformPackage) {
  const req = createRequire(codexPackageJsonPath);
  return req.resolve(`${platformPackage}/package.json`);
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

    const localVendorBinary = pathImpl.join(
      pathImpl.dirname(codexPackageJsonPath),
      'vendor',
      spec.targetTriple,
      'codex',
      spec.binaryName,
    );
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

    try {
      const platformPackageJsonPath = resolvePlatformPackage(
        codexPackageJsonPath,
        spec.platformPackage,
      );
      const platformBinary = pathImpl.join(
        pathImpl.dirname(platformPackageJsonPath),
        'vendor',
        spec.targetTriple,
        'codex',
        spec.binaryName,
      );
      checked.push(platformPackageJsonPath, platformBinary);
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
    } catch (error) {
      checked.push(`${codexPackageJsonPath} -> ${spec.platformPackage}: ${error.message}`);
    }
  }

  return {
    path: null,
    reason: `No spawnable ${spec.binaryName} was found in the global Codex installation`,
    ...spec,
    checked,
  };
}
