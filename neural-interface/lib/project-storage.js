import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, platform as currentPlatform } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import { spawnSync } from 'node:child_process';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

export const PROJECT_STORAGE_SAFE_CONFIRMATION = 'CLEAR SELECTED CACHES';
export const PROJECT_STORAGE_DEPENDENCY_CONFIRMATION = 'DELETE DEPENDENCIES';

const DISCOVERY_ENTRY_LIMIT = 300_000;
const MEASURE_ENTRY_LIMIT = 1_000_000;
const WORKER_TIMEOUT_MS = 180_000;

const HARD_PRUNE_DIRS = new Set([
  '.claude', '.codex', '.git', '.hg', '.svn', '.idea', '.vscode',
  'data', 'mcp-data', 'storage', 'uploads',
]);
const HISTORY_DIRS = new Set(['history', 'histories', 'sessions', 'transcripts']);
const PACKAGE_MARKERS = ['package.json', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'bun.lockb', 'bun.lock'];
const PYTHON_MARKERS = ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile'];
const GRADLE_MARKERS = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradlew'];

const PROJECT_RULES = new Map([
  ['node_modules', { key: 'node-modules', category: 'dependency', risk: 'dependency', label: 'Dependencies', marker: 'package' }],
  ['.venv', { key: 'python-venv', category: 'dependency', risk: 'dependency', label: 'Python environment', marker: 'venv' }],
  ['venv', { key: 'python-venv', category: 'dependency', risk: 'dependency', label: 'Python environment', marker: 'venv' }],
  ['.next', { key: 'next-build', category: 'build', risk: 'safe', label: 'Next.js build', marker: 'package' }],
  ['.nuxt', { key: 'nuxt-build', category: 'build', risk: 'safe', label: 'Nuxt build', marker: 'package' }],
  ['.svelte-kit', { key: 'svelte-build', category: 'build', risk: 'safe', label: 'SvelteKit build', marker: 'package' }],
  ['.turbo', { key: 'turbo-cache', category: 'cache', risk: 'safe', label: 'Turborepo cache', marker: 'package' }],
  ['.vite', { key: 'vite-cache', category: 'cache', risk: 'safe', label: 'Vite cache', marker: 'package' }],
  ['.parcel-cache', { key: 'parcel-cache', category: 'cache', risk: 'safe', label: 'Parcel cache', marker: 'package' }],
  ['coverage', { key: 'test-coverage', category: 'test', risk: 'safe', label: 'Test coverage', marker: 'ecosystem' }],
  ['htmlcov', { key: 'python-coverage', category: 'test', risk: 'safe', label: 'Python coverage', marker: 'python' }],
  ['storybook-static', { key: 'storybook-build', category: 'build', risk: 'safe', label: 'Storybook build', marker: 'package' }],
  ['target', { key: 'cargo-target', category: 'build', risk: 'safe', label: 'Cargo build', marker: 'cargo' }],
  ['__pycache__', { key: 'python-bytecode', category: 'cache', risk: 'safe', label: 'Python bytecode', marker: 'python-loose' }],
  ['.pytest_cache', { key: 'pytest-cache', category: 'test', risk: 'safe', label: 'Pytest cache', marker: 'python' }],
  ['.mypy_cache', { key: 'mypy-cache', category: 'cache', risk: 'safe', label: 'Mypy cache', marker: 'python' }],
  ['.ruff_cache', { key: 'ruff-cache', category: 'cache', risk: 'safe', label: 'Ruff cache', marker: 'python' }],
  ['.tox', { key: 'tox-cache', category: 'test', risk: 'safe', label: 'Tox environments', marker: 'python' }],
  ['.gradle', { key: 'gradle-project-cache', category: 'cache', risk: 'safe', label: 'Gradle project cache', marker: 'gradle' }],
  ['.cache', { key: 'generic-cache', category: 'review', risk: 'review', label: 'Project cache', marker: 'project' }],
  ['logs', { key: 'project-logs', category: 'review', risk: 'review', label: 'Project logs', marker: 'project' }],
  ['tmp', { key: 'project-temp', category: 'review', risk: 'review', label: 'Temporary files', marker: 'project' }],
  ['.tmp', { key: 'project-temp', category: 'review', risk: 'review', label: 'Temporary files', marker: 'project' }],
  ['.playwright-mcp', { key: 'playwright-mcp-output', category: 'review', risk: 'review', label: 'Playwright MCP output', marker: 'project' }],
]);

function normalizePath(value) {
  return resolve(String(value || ''));
}

function canonicalExistingPath(value) {
  const normalized = normalizePath(value);
  try { return realpathSync.native(normalized); }
  catch { return normalized; }
}

function pathsEqual(left, right) {
  const a = normalizePath(left);
  const b = normalizePath(right);
  return currentPlatform() === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function pathIsWithin(parentPath, childPath, { allowEqual = false } = {}) {
  const parentResolved = normalizePath(parentPath);
  const childResolved = normalizePath(childPath);
  const parent = currentPlatform() === 'win32' ? parentResolved.toLowerCase() : parentResolved;
  const child = currentPlatform() === 'win32' ? childResolved.toLowerCase() : childResolved;
  const rel = relative(parent, child);
  if (!rel) return allowEqual;
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function stableId(...parts) {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24);
}

function pathExists(path) {
  try { return existsSync(path); } catch { return false; }
}

function safeLstat(path) {
  try { return lstatSync(path); } catch { return null; }
}

function hasAnyFile(directory, names) {
  return names.some((name) => pathExists(join(directory, name)));
}

function ancestorHasMarker(startDirectory, projectRoot, names, maxLevels = 3) {
  let current = normalizePath(startDirectory);
  const boundary = normalizePath(projectRoot);
  for (let level = 0; level <= maxLevels; level += 1) {
    if (!pathIsWithin(boundary, current, { allowEqual: true })) return false;
    if (hasAnyFile(current, names)) return true;
    if (current === boundary) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

function ruleMarkerMatches(rule, candidatePath, projectRoot) {
  const parent = dirname(candidatePath);
  switch (rule.marker) {
    case 'package':
      return ancestorHasMarker(parent, projectRoot, PACKAGE_MARKERS, 3);
    case 'venv':
      return pathExists(join(candidatePath, 'pyvenv.cfg'));
    case 'cargo':
      return ancestorHasMarker(parent, projectRoot, ['Cargo.toml'], 3);
    case 'gradle':
      return ancestorHasMarker(parent, projectRoot, GRADLE_MARKERS, 3);
    case 'python':
      return ancestorHasMarker(parent, projectRoot, PYTHON_MARKERS, 4);
    case 'python-loose':
      try {
        return ancestorHasMarker(parent, projectRoot, PYTHON_MARKERS, 6)
          || readdirSync(parent, { withFileTypes: true }).some((entry) => entry.isFile() && /\.py$/i.test(entry.name))
          || readdirSync(candidatePath, { withFileTypes: true }).some((entry) => entry.isFile() && /\.py[co]$/i.test(entry.name));
      } catch { return false; }
    case 'ecosystem':
      return ancestorHasMarker(parent, projectRoot, [...PACKAGE_MARKERS, ...PYTHON_MARKERS, ...GRADLE_MARKERS, 'Cargo.toml'], 4);
    case 'project':
      return true;
    default:
      return false;
  }
}

function classifyProjectCandidate(candidatePath, projectRoot, stat = safeLstat(candidatePath)) {
  if (!stat) return null;
  const name = basename(candidatePath);
  if (stat.isFile()) {
    if (name === '.eslintcache' && ancestorHasMarker(dirname(candidatePath), projectRoot, PACKAGE_MARKERS, 3)) {
      return { key: 'eslint-cache', category: 'cache', risk: 'safe', label: 'ESLint cache' };
    }
    if (name.endsWith('.tsbuildinfo') && ancestorHasMarker(dirname(candidatePath), projectRoot, PACKAGE_MARKERS, 3)) {
      return { key: 'typescript-build-info', category: 'build', risk: 'safe', label: 'TypeScript build info' };
    }
    return null;
  }
  if (!stat.isDirectory() && !stat.isSymbolicLink()) return null;

  if (name === 'dist' || name === 'out' || name === 'build') {
    const hasPackage = ancestorHasMarker(dirname(candidatePath), projectRoot, PACKAGE_MARKERS, 3);
    const hasGradle = ancestorHasMarker(dirname(candidatePath), projectRoot, GRADLE_MARKERS, 3);
    if (!hasPackage && !hasGradle) return null;
    return {
      key: hasGradle ? 'gradle-build' : `${name}-build`,
      category: 'build',
      risk: 'safe',
      label: hasGradle ? 'Gradle build' : `${name[0].toUpperCase()}${name.slice(1)} output`,
    };
  }

  const rule = PROJECT_RULES.get(name);
  if (!rule || !ruleMarkerMatches(rule, candidatePath, projectRoot)) return null;
  return rule;
}

function measurePath(rootPath, { entryLimit = MEASURE_ENTRY_LIMIT } = {}) {
  const rootStat = safeLstat(rootPath);
  if (!rootStat) return { bytes: 0, fileCount: 0, incomplete: false, containsRepository: false };
  if (rootStat.isSymbolicLink()) {
    return { bytes: rootStat.size || 0, fileCount: 1, incomplete: false, containsRepository: false };
  }
  if (!rootStat.isDirectory()) {
    return { bytes: rootStat.size || 0, fileCount: 1, incomplete: false, containsRepository: false };
  }

  let bytes = rootStat.size || 0;
  let fileCount = 0;
  let entriesSeen = 0;
  let incomplete = false;
  let containsRepository = false;
  const stack = [rootPath];
  while (stack.length && !incomplete) {
    const directory = stack.pop();
    let entries = [];
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch { incomplete = true; break; }
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > entryLimit) { incomplete = true; break; }
      const entryPath = join(directory, entry.name);
      const stat = safeLstat(entryPath);
      if (!stat) { incomplete = true; continue; }
      bytes += stat.size || 0;
      if (entry.name === '.git') containsRepository = true;
      if (stat.isSymbolicLink()) { fileCount += 1; continue; }
      if (stat.isDirectory()) stack.push(entryPath);
      else fileCount += 1;
    }
  }
  return { bytes, fileCount, incomplete, containsRepository };
}

function gitInfoForProject(projectRoot) {
  const canonicalProjectRoot = canonicalExistingPath(projectRoot);
  const probe = spawnSync('git', ['-C', projectRoot, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8', timeout: 5_000, windowsHide: true,
  });
  if (probe.status !== 0) {
    let current = canonicalProjectRoot;
    while (true) {
      if (pathExists(join(current, '.git'))) {
        return { isRepository: true, verified: false, root: current, tracked: [] };
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return { isRepository: false, verified: true, root: null, tracked: [] };
  }
  const gitRoot = canonicalExistingPath(String(probe.stdout || '').trim());
  if (!pathIsWithin(gitRoot, canonicalProjectRoot, { allowEqual: true })) {
    return { isRepository: false, verified: false, root: gitRoot, tracked: [] };
  }
  const listed = spawnSync('git', ['-C', gitRoot, 'ls-files', '-z'], {
    encoding: 'buffer', timeout: 20_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
  if (listed.status !== 0 || listed.error) {
    return { isRepository: true, verified: false, root: gitRoot, tracked: [] };
  }
  return {
    isRepository: true,
    verified: true,
    root: gitRoot,
    tracked: listed.stdout.toString('utf8').split('\0').filter(Boolean),
  };
}

function candidateContainsTrackedFile(candidatePath, gitInfo) {
  if (!gitInfo?.isRepository) return false;
  if (!gitInfo.verified) return true;
  const relativeValue = relative(gitInfo.root, canonicalExistingPath(candidatePath)).split(sep).join('/');
  const candidateRelative = currentPlatform() === 'win32' ? relativeValue.toLowerCase() : relativeValue;
  return gitInfo.tracked.some((trackedValue) => {
    const tracked = currentPlatform() === 'win32' ? trackedValue.toLowerCase() : trackedValue;
    return tracked === candidateRelative || tracked.startsWith(`${candidateRelative}/`);
  });
}

function runtimeProtectionReason(candidatePath, rule, projectRoot, packageRoot, runtimeProtectedPaths = []) {
  const normalizedCandidate = normalizePath(candidatePath);
  const normalizedPackage = packageRoot ? normalizePath(packageRoot) : null;
  if (normalizedPackage && pathsEqual(projectRoot, normalizedPackage) && rule.category === 'dependency') {
    return 'Required by the running SynaBun application.';
  }
  for (const protectedPath of runtimeProtectedPaths || []) {
    const normalizedProtected = normalizePath(protectedPath);
    if (normalizedCandidate === normalizedProtected || pathIsWithin(normalizedCandidate, normalizedProtected) || pathIsWithin(normalizedProtected, normalizedCandidate)) {
      return 'Required by the running SynaBun application.';
    }
  }
  return null;
}

function makeProjectItem({ candidatePath, project, rule, stat, gitInfo, packageRoot, runtimeProtectedPaths }) {
  const measured = measurePath(candidatePath);
  let protectionReason = null;
  if (stat.isSymbolicLink()) protectionReason = 'Symbolic links are never cleaned automatically.';
  else if (measured.incomplete) protectionReason = 'This item could not be measured completely.';
  else if (measured.containsRepository) protectionReason = 'Contains nested Git repository metadata.';
  else if (candidateContainsTrackedFile(candidatePath, gitInfo)) {
    protectionReason = gitInfo.verified
      ? 'Contains files tracked by Git.'
      : 'Git tracking status could not be verified.';
  }
  protectionReason ||= runtimeProtectionReason(candidatePath, rule, project.path, packageRoot, runtimeProtectedPaths);
  const relativePath = relative(project.path, candidatePath) || basename(candidatePath);
  return {
    id: stableId('project', project.path, candidatePath),
    scope: 'project',
    projectKey: stableId('project-root', project.path),
    projectLabel: project.label,
    projectPath: project.path,
    absolutePath: candidatePath,
    boundaryPath: project.path,
    displayPath: relativePath.split(sep).join('/'),
    name: rule.label,
    category: rule.category,
    risk: protectionReason ? 'protected' : rule.risk,
    originalRisk: rule.risk,
    bytes: measured.bytes,
    fileCount: measured.fileCount,
    incomplete: measured.incomplete,
    protected: !!protectionReason,
    protectionReason,
    defaultSelected: !protectionReason && rule.risk === 'safe',
    cleanupMode: 'remove',
    descriptor: { kind: 'project', ruleKey: rule.key },
  };
}

function addGitDiagnostic(project, gitInfo, seenPaths, items) {
  const projectRoot = canonicalExistingPath(project.path);
  const sameRoot = currentPlatform() === 'win32'
    ? gitInfo?.root?.toLowerCase() === projectRoot.toLowerCase()
    : gitInfo?.root === projectRoot;
  if (!gitInfo?.isRepository || !sameRoot) return;
  const gitPath = join(project.path, '.git');
  if (!pathExists(gitPath) || seenPaths.has(gitPath)) return;
  seenPaths.add(gitPath);
  const measured = measurePath(gitPath);
  items.push({
    id: stableId('project', project.path, gitPath),
    scope: 'project',
    projectKey: stableId('project-root', project.path),
    projectLabel: project.label,
    projectPath: project.path,
    absolutePath: gitPath,
    boundaryPath: project.path,
    displayPath: '.git',
    name: 'Git repository metadata',
    category: 'repository',
    risk: 'protected',
    originalRisk: 'protected',
    bytes: measured.bytes,
    fileCount: measured.fileCount,
    incomplete: measured.incomplete,
    protected: true,
    protectionReason: 'Repository history is diagnostic only and is never deleted.',
    defaultSelected: false,
    cleanupMode: 'none',
    descriptor: { kind: 'repository' },
  });
}

function scanProject(projectInput, options, globallySeen) {
  const projectPath = normalizePath(projectInput.path);
  const project = { path: projectPath, label: String(projectInput.label || basename(projectPath)) };
  const items = [];
  const warnings = [];
  const rootStat = safeLstat(projectPath);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    return { ...project, projectKey: stableId('project-root', projectPath), items, warnings: ['Project directory is unavailable.'] };
  }
  const gitInfo = gitInfoForProject(projectPath);
  addGitDiagnostic(project, gitInfo, globallySeen, items);

  let entriesSeen = 0;
  const stack = [{ path: projectPath, depth: 0, inOpenCode: false }];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = readdirSync(current.path, { withFileTypes: true }); }
    catch { warnings.push(`Could not read ${relative(projectPath, current.path) || '.'}.`); continue; }
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > (options.discoveryEntryLimit || DISCOVERY_ENTRY_LIMIT)) {
        warnings.push('Scan stopped after reaching the project entry limit.');
        stack.length = 0;
        break;
      }
      const candidatePath = join(current.path, entry.name);
      const stat = safeLstat(candidatePath);
      if (!stat) continue;
      const rule = classifyProjectCandidate(candidatePath, projectPath, stat);
      if (rule) {
        if (!globallySeen.has(candidatePath)) {
          globallySeen.add(candidatePath);
          items.push(makeProjectItem({
            candidatePath, project, rule, stat, gitInfo,
            packageRoot: options.packageRoot,
            runtimeProtectedPaths: options.runtimeProtectedPaths,
          }));
        }
        continue;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink() || current.depth >= (options.maxDepth || 12)) continue;
      if (HARD_PRUNE_DIRS.has(entry.name)) continue;
      if ((current.inOpenCode || entry.name === '.opencode') && HISTORY_DIRS.has(entry.name)) continue;
      stack.push({ path: candidatePath, depth: current.depth + 1, inOpenCode: current.inOpenCode || entry.name === '.opencode' });
    }
  }
  items.sort((a, b) => b.bytes - a.bytes || a.displayPath.localeCompare(b.displayPath));
  return { ...project, projectKey: stableId('project-root', projectPath), items, warnings };
}

function readNpmCacheFromRc(homePath) {
  try {
    const contents = readFileSync(join(homePath, '.npmrc'), 'utf8');
    const line = contents.split(/\r?\n/).find((entry) => /^\s*cache\s*=/.test(entry) && !/^\s*[;#]/.test(entry));
    if (!line) return null;
    const value = line.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '');
    return value ? normalizePath(value.replace(/^~(?=$|[\\/])/, homePath)) : null;
  } catch { return null; }
}

function sharedDescriptor(path, key, name, category, risk, provider, cleanupMode = 'empty') {
  return { path: normalizePath(path), key, name, category, risk, provider, cleanupMode };
}

export function discoverSharedCacheDescriptors({
  environment = process.env,
  homePath = homedir(),
  platform = currentPlatform(),
  sharedRoots = null,
} = {}) {
  if (Array.isArray(sharedRoots)) {
    return sharedRoots.map((entry) => sharedDescriptor(
      entry.path, entry.key, entry.name, entry.category || 'toolchain',
      entry.risk || 'safe', entry.provider || 'Developer tools', entry.cleanupMode || 'empty',
    ));
  }
  const env = environment || {};
  const descriptors = [];
  const add = (...args) => descriptors.push(sharedDescriptor(...args));
  const localAppData = env.LOCALAPPDATA || join(homePath, 'AppData', 'Local');
  const appData = env.APPDATA || join(homePath, 'AppData', 'Roaming');
  const xdgCache = env.XDG_CACHE_HOME || join(homePath, '.cache');
  const xdgData = env.XDG_DATA_HOME || join(homePath, '.local', 'share');

  const npmRoot = env.NPM_CONFIG_CACHE || env.npm_config_cache || readNpmCacheFromRc(homePath)
    || (platform === 'win32' ? join(localAppData, 'npm-cache') : join(homePath, '.npm'));
  add(join(npmRoot, '_cacache'), 'npm-content-cache', 'npm content cache', 'toolchain', 'safe', 'npm');
  add(join(npmRoot, '_logs'), 'npm-logs', 'npm logs', 'toolchain', 'safe', 'npm');
  add(join(npmRoot, '_npx'), 'npx-downloads', 'npx package downloads', 'dependency', 'dependency', 'npm');

  const gradleRoot = env.GRADLE_USER_HOME || join(homePath, '.gradle');
  add(join(gradleRoot, 'caches'), 'gradle-caches', 'Gradle caches', 'toolchain', 'safe', 'Gradle');
  add(join(gradleRoot, 'daemon'), 'gradle-daemon', 'Gradle daemon data', 'review', 'review', 'Gradle');
  add(join(gradleRoot, 'wrapper', 'dists'), 'gradle-wrapper-dists', 'Gradle distributions', 'dependency', 'dependency', 'Gradle');

  const pipRoot = env.PIP_CACHE_DIR || (platform === 'darwin'
    ? join(homePath, 'Library', 'Caches', 'pip')
    : platform === 'win32' ? join(localAppData, 'pip', 'Cache') : join(xdgCache, 'pip'));
  add(pipRoot, 'pip-cache', 'pip download cache', 'toolchain', 'safe', 'Python');

  const defaultPlaywrightRoots = platform === 'darwin'
    ? [join(homePath, 'Library', 'Caches', 'ms-playwright'), join(homePath, 'Library', 'Caches', 'ms-playwright-mcp')]
    : platform === 'win32'
      ? [join(localAppData, 'ms-playwright'), join(localAppData, 'ms-playwright-mcp')]
      : [join(xdgCache, 'ms-playwright'), join(xdgCache, 'ms-playwright-mcp')];
  const playwrightRoots = env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== '0'
    ? [env.PLAYWRIGHT_BROWSERS_PATH, defaultPlaywrightRoots[1]]
    : defaultPlaywrightRoots;
  playwrightRoots.forEach((root, index) => add(root, `playwright-browsers-${index}`, index ? 'Playwright MCP browsers' : 'Playwright browsers', 'dependency', 'dependency', 'Playwright'));

  const puppeteerRoot = env.PUPPETEER_CACHE_DIR || (platform === 'darwin'
    ? join(homePath, 'Library', 'Caches', 'puppeteer')
    : platform === 'win32' ? join(localAppData, 'puppeteer', 'Cache') : join(xdgCache, 'puppeteer'));
  add(puppeteerRoot, 'puppeteer-browsers', 'Puppeteer browsers', 'dependency', 'dependency', 'Puppeteer');

  const cargoRoot = env.CARGO_HOME || join(homePath, '.cargo');
  add(join(cargoRoot, 'registry', 'cache'), 'cargo-registry-cache', 'Cargo crate downloads', 'dependency', 'dependency', 'Cargo');
  add(join(cargoRoot, 'registry', 'src'), 'cargo-registry-src', 'Cargo unpacked sources', 'dependency', 'dependency', 'Cargo');
  add(join(cargoRoot, 'git', 'db'), 'cargo-git-db', 'Cargo Git downloads', 'dependency', 'dependency', 'Cargo');

  const yarnRoots = env.YARN_CACHE_FOLDER
    ? [env.YARN_CACHE_FOLDER]
    : platform === 'darwin'
      ? [join(homePath, 'Library', 'Caches', 'Yarn'), join(homePath, '.cache', 'yarn')]
      : platform === 'win32' ? [join(localAppData, 'Yarn', 'Cache')] : [join(xdgCache, 'yarn')];
  yarnRoots.forEach((root, index) => add(root, `yarn-cache-${index}`, 'Yarn package cache', 'dependency', 'dependency', 'Yarn'));
  const pnpmRoots = platform === 'win32'
    ? [join(localAppData, 'pnpm', 'store')]
    : [join(homePath, 'Library', 'pnpm', 'store'), join(xdgData, 'pnpm', 'store')];
  pnpmRoots.forEach((root, index) => add(root, `pnpm-store-${index}`, 'pnpm package store', 'dependency', 'dependency', 'pnpm'));
  const bunInstall = env.BUN_INSTALL || (platform === 'win32' ? join(localAppData, 'bun') : join(homePath, '.bun'));
  add(join(bunInstall, 'install', 'cache'), 'bun-cache', 'Bun package cache', 'dependency', 'dependency', 'Bun');
  if (platform === 'darwin') add(env.HOMEBREW_CACHE || join(homePath, 'Library', 'Caches', 'Homebrew'), 'homebrew-cache', 'Homebrew downloads', 'dependency', 'dependency', 'Homebrew');
  if (platform === 'win32') add(join(localAppData, 'Yarn', 'Berry', 'cache'), 'yarn-berry-cache', 'Yarn Berry cache', 'dependency', 'dependency', 'Yarn');

  const seen = new Set();
  const unique = descriptors.filter((entry) => {
    if (seen.has(entry.path)) return false;
    seen.add(entry.path);
    return true;
  });
  return unique.filter((entry) => !unique.some((parent) => (
    parent !== entry
    && parent.provider === entry.provider
    && parent.risk === entry.risk
    && pathIsWithin(parent.path, entry.path)
  )));
}

function isDangerouslyBroad(path, { homePath = homedir(), projectRoots = [], packageRoot = null } = {}) {
  const normalized = normalizePath(path);
  const parsed = parse(normalized);
  if (pathsEqual(normalized, parsed.root) || pathsEqual(normalized, homePath)) return true;
  if (packageRoot && pathsEqual(normalized, packageRoot)) return true;
  return projectRoots.some((root) => pathsEqual(normalized, root));
}

function makeSharedItem(descriptor, options) {
  const stat = safeLstat(descriptor.path);
  if (!stat) return null;
  const measured = measurePath(descriptor.path);
  let protectionReason = null;
  if (isDangerouslyBroad(descriptor.path, options)) protectionReason = 'The discovered path is too broad to clean safely.';
  else if (stat.isSymbolicLink()) protectionReason = 'Symbolic links are never cleaned automatically.';
  else if (!stat.isDirectory()) protectionReason = 'Only exact cache directories can be cleaned.';
  else if (measured.incomplete) protectionReason = 'This cache could not be measured completely.';
  else if (measured.containsRepository) protectionReason = 'Contains Git repository metadata.';
  return {
    id: stableId('shared', descriptor.key, descriptor.path),
    scope: 'shared',
    projectKey: null,
    projectLabel: null,
    projectPath: null,
    absolutePath: descriptor.path,
    boundaryPath: descriptor.path,
    displayPath: descriptor.path,
    name: descriptor.name,
    provider: descriptor.provider,
    category: descriptor.category,
    risk: protectionReason ? 'protected' : descriptor.risk,
    originalRisk: descriptor.risk,
    bytes: measured.bytes,
    fileCount: measured.fileCount,
    incomplete: measured.incomplete,
    protected: !!protectionReason,
    protectionReason,
    defaultSelected: !protectionReason && descriptor.risk === 'safe',
    cleanupMode: descriptor.cleanupMode,
    descriptor: { kind: 'shared', ruleKey: descriptor.key },
  };
}

function summarizeItems(items) {
  return items.reduce((totals, item) => {
    totals.bytes += item.bytes || 0;
    totals.fileCount += item.fileCount || 0;
    totals.itemCount += 1;
    if (item.defaultSelected) {
      totals.selectedBytes += item.bytes || 0;
      totals.selectedItemCount += 1;
    }
    if (item.protected) totals.protectedItemCount += 1;
    else if (item.originalRisk === 'dependency') totals.dependencyItemCount += 1;
    return totals;
  }, { bytes: 0, fileCount: 0, itemCount: 0, selectedBytes: 0, selectedItemCount: 0, protectedItemCount: 0, dependencyItemCount: 0 });
}

export function scanProjectStorage(options = {}) {
  const projectInputs = Array.isArray(options.projects) ? options.projects : [];
  const globallySeen = new Set();
  const projectGroups = [];
  const warnings = [];
  const seenRoots = new Set();
  for (const input of projectInputs) {
    if (!input?.path) continue;
    const projectPath = normalizePath(input.path);
    if (seenRoots.has(projectPath)) continue;
    seenRoots.add(projectPath);
    const group = scanProject({ ...input, path: projectPath }, options, globallySeen);
    projectGroups.push(group);
    warnings.push(...group.warnings.map((warning) => `${group.label}: ${warning}`));
  }

  const sharedDescriptors = options.includeShared === false ? [] : discoverSharedCacheDescriptors(options);
  const sharedItems = sharedDescriptors
    .filter((descriptor) => !globallySeen.has(descriptor.path))
    .map((descriptor) => makeSharedItem(descriptor, {
      ...options,
      projectRoots: projectGroups.map((group) => group.path),
    }))
    .filter(Boolean)
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  const allItems = [...projectGroups.flatMap((group) => group.items), ...sharedItems];
  return {
    scannedAt: new Date().toISOString(),
    projects: projectGroups,
    shared: { label: 'Shared developer caches', items: sharedItems },
    totals: summarizeItems(allItems),
    warnings,
    items: allItems,
  };
}

export class ProjectStorageValidationError extends Error {
  constructor(message, code = 'INVALID_SELECTION', details = []) {
    super(message);
    this.name = 'ProjectStorageValidationError';
    this.code = code;
    this.details = details;
  }
}

function containsGitMetadata(path, entryLimit = MEASURE_ENTRY_LIMIT) {
  const stat = safeLstat(path);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return false;
  const stack = [path];
  let count = 0;
  while (stack.length) {
    const directory = stack.pop();
    let entries = [];
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch { return true; }
    for (const entry of entries) {
      count += 1;
      if (count > entryLimit) return true;
      if (entry.name === '.git') return true;
      if (entry.isDirectory() && !entry.isSymbolicLink()) stack.push(join(directory, entry.name));
    }
  }
  return false;
}

function validateProjectItem(item, options) {
  const absolutePath = normalizePath(item.absolutePath);
  const projectRoot = normalizePath(item.projectPath);
  if (!pathIsWithin(projectRoot, absolutePath)) throw new ProjectStorageValidationError('Candidate escaped its project boundary.', 'PATH_BOUNDARY');
  if (!pathExists(absolutePath)) return { ...item, absolutePath, missing: true };
  const stat = safeLstat(absolutePath);
  if (!stat || stat.isSymbolicLink()) throw new ProjectStorageValidationError('Symbolic-link candidates cannot be cleaned.', 'SYMLINK');
  const rule = classifyProjectCandidate(absolutePath, projectRoot, stat);
  if (!rule || rule.key !== item.descriptor?.ruleKey) throw new ProjectStorageValidationError('Candidate no longer matches a recognized cache rule.', 'RULE_CHANGED');
  const runtimeReason = runtimeProtectionReason(absolutePath, rule, projectRoot, options.packageRoot, options.runtimeProtectedPaths);
  if (runtimeReason) throw new ProjectStorageValidationError(runtimeReason, 'RUNTIME_PROTECTED');
  if (containsGitMetadata(absolutePath)) throw new ProjectStorageValidationError('Candidate contains Git repository metadata.', 'REPOSITORY_PROTECTED');
  const gitInfo = gitInfoForProject(projectRoot);
  if (candidateContainsTrackedFile(absolutePath, gitInfo)) {
    throw new ProjectStorageValidationError('Candidate contains tracked files or Git status could not be verified.', 'GIT_PROTECTED');
  }
  return { ...item, absolutePath, missing: false };
}

function validateSharedItem(item, options) {
  const absolutePath = normalizePath(item.absolutePath);
  const descriptors = discoverSharedCacheDescriptors(options);
  const descriptor = descriptors.find((entry) => entry.path === absolutePath && entry.key === item.descriptor?.ruleKey);
  if (!descriptor) throw new ProjectStorageValidationError('Shared cache no longer matches an approved path.', 'RULE_CHANGED');
  if (isDangerouslyBroad(absolutePath, {
    ...options,
    projectRoots: (options.projects || []).map((project) => project.path),
  })) throw new ProjectStorageValidationError('Shared cache path is too broad.', 'PATH_BOUNDARY');
  if (!pathExists(absolutePath)) return { ...item, absolutePath, missing: true };
  const stat = safeLstat(absolutePath);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new ProjectStorageValidationError('Shared cache is not an exact real directory.', 'SYMLINK');
  if (containsGitMetadata(absolutePath)) throw new ProjectStorageValidationError('Shared cache contains Git repository metadata.', 'REPOSITORY_PROTECTED');
  return { ...item, absolutePath, missing: false, cleanupMode: descriptor.cleanupMode };
}

function removeCandidate(item) {
  if (item.missing) return { id: item.id, status: 'already-missing', bytesCleared: 0 };
  const currentStat = safeLstat(item.absolutePath);
  if (!currentStat) return { id: item.id, status: 'already-missing', bytesCleared: 0 };
  if (currentStat.isSymbolicLink()) throw new Error('Candidate changed into a symbolic link after validation.');
  if (item.cleanupMode === 'empty') {
    const entries = readdirSync(item.absolutePath, { withFileTypes: true });
    for (const entry of entries) rmSync(join(item.absolutePath, entry.name), { recursive: true, force: true, maxRetries: 2 });
  } else {
    rmSync(item.absolutePath, { recursive: true, force: true, maxRetries: 2 });
  }
  return { id: item.id, status: 'cleared', bytesCleared: Number(item.bytes) || 0 };
}

export function clearProjectStorage(options = {}) {
  const items = Array.isArray(options.items) ? options.items : [];
  if (!items.length) throw new ProjectStorageValidationError('Select at least one cache item.', 'EMPTY_SELECTION');
  const validated = [];
  const validationFailures = [];
  for (const item of items) {
    try {
      if (!item || item.protected || item.risk === 'protected' || item.descriptor?.kind === 'repository') {
        throw new ProjectStorageValidationError('Protected items cannot be cleaned.', 'PROTECTED');
      }
      validated.push(item.scope === 'shared' ? validateSharedItem(item, options) : validateProjectItem(item, options));
    } catch (error) {
      validationFailures.push({ id: item?.id || null, code: error.code || 'INVALID_SELECTION', error: error.message });
    }
  }
  if (validationFailures.length) {
    throw new ProjectStorageValidationError('Cleanup stopped because one or more items failed safety validation.', 'VALIDATION_FAILED', validationFailures);
  }

  const results = [];
  for (const item of validated) {
    try { results.push(removeCandidate(item)); }
    catch (error) { results.push({ id: item.id, status: 'failed', bytesCleared: 0, error: error.message }); }
  }
  const cleared = results.filter((result) => result.status === 'cleared');
  const failed = results.filter((result) => result.status === 'failed');
  return {
    ok: failed.length === 0,
    partial: failed.length > 0 && cleared.length > 0,
    results,
    clearedItemCount: cleared.length,
    failedItemCount: failed.length,
    bytesCleared: cleared.reduce((sum, result) => sum + result.bytesCleared, 0),
  };
}

function runWorker(action, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { projectStorageAction: action, options },
      // The parent can be launched by `node --test` or `node --input-type` with
      // flags that are invalid for a file-backed Worker. This task needs none.
      execArgv: [],
    });
    const timeout = setTimeout(() => {
      worker.terminate().catch(() => {});
      rejectPromise(new Error(`Project storage ${action} timed out.`));
    }, WORKER_TIMEOUT_MS);
    worker.once('message', (message) => {
      clearTimeout(timeout);
      if (message?.ok) resolvePromise(message.result);
      else {
        const error = new ProjectStorageValidationError(
          message?.error?.message || `Project storage ${action} failed.`,
          message?.error?.code || 'WORKER_FAILED',
          message?.error?.details || [],
        );
        error.stack = message?.error?.stack || error.stack;
        rejectPromise(error);
      }
    });
    worker.once('error', (error) => { clearTimeout(timeout); rejectPromise(error); });
    worker.once('exit', (code) => {
      if (code !== 0) { clearTimeout(timeout); rejectPromise(new Error(`Project storage worker exited with code ${code}.`)); }
    });
  });
}

export function scanProjectStorageInWorker(options = {}) {
  return runWorker('scan', options);
}

export function clearProjectStorageInWorker(options = {}) {
  return runWorker('clear', options);
}

if (!isMainThread && workerData?.projectStorageAction) {
  try {
    const result = workerData.projectStorageAction === 'clear'
      ? clearProjectStorage(workerData.options || {})
      : scanProjectStorage(workerData.options || {});
    parentPort?.postMessage({ ok: true, result });
  } catch (error) {
    parentPort?.postMessage({
      ok: false,
      error: {
        message: error?.message || String(error),
        code: error?.code || 'WORKER_FAILED',
        details: error?.details || [],
        stack: error?.stack || null,
      },
    });
  }
}
