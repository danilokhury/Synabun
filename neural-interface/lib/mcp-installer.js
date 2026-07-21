import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, chmodSync } from 'fs';
import { join, resolve, isAbsolute } from 'path';

const GITHUB_URL_RE = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i;

export function parseGithubUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let input = raw.trim();
  if (input.startsWith('git@github.com:')) {
    input = input.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '');
  }
  if (!/^https?:\/\//i.test(input)) input = `https://github.com/${input.replace(/^\/+/, '')}`;
  const m = input.match(GITHUB_URL_RE);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2].replace(/\.git$/, '');
  return { owner, repo, cloneUrl: `https://github.com/${owner}/${repo}.git` };
}

export function deriveServerName(parsed, overrideName) {
  if (overrideName && /^[\w.-]+$/.test(overrideName)) return overrideName;
  if (!parsed) return null;
  let name = parsed.repo.toLowerCase();
  name = name.replace(/^mcp[-_]/, '').replace(/[-_]mcp$/, '').replace(/^server[-_]/, '');
  name = name.replace(/[^\w-]/g, '').slice(0, 48);
  return name || parsed.repo;
}

export function mcpDataRoot(dataHome) {
  return resolve(dataHome, 'data', 'mcp');
}

export function serverDir(dataHome, name) {
  return resolve(mcpDataRoot(dataHome), name);
}

export function repoDir(dataHome, name) {
  return resolve(serverDir(dataHome, name), 'repo');
}

export function envFilePath(dataHome, name) {
  return resolve(serverDir(dataHome, name), 'env.json');
}

export function installLogPath(dataHome, name) {
  return resolve(serverDir(dataHome, name), 'install.log');
}

export function ensureServerDir(dataHome, name) {
  const dir = serverDir(dataHome, name);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function logInstall(dataHome, name, line) {
  try {
    ensureServerDir(dataHome, name);
    appendFileSync(installLogPath(dataHome, name), `[${new Date().toISOString()}] ${line}\n`, 'utf-8');
  } catch {}
}

export function readEnvFile(dataHome, name) {
  const p = envFilePath(dataHome, name);
  if (!existsSync(p)) return {};
  try {
    const data = JSON.parse(readFileSync(p, 'utf-8'));
    return data && typeof data === 'object' ? data : {};
  } catch { return {}; }
}

export function writeEnvFile(dataHome, name, env) {
  ensureServerDir(dataHome, name);
  const p = envFilePath(dataHome, name);
  writeFileSync(p, JSON.stringify(env || {}, null, 2) + '\n', 'utf-8');
  try { chmodSync(p, 0o600); } catch {}
  return p;
}

export function maskEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (typeof v !== 'string') { out[k] = v; continue; }
    if (!v) { out[k] = ''; continue; }
    out[k] = v.length <= 4 ? '****' : `****${v.slice(-2)}`;
  }
  return out;
}

async function runCommand(cmd, args, opts = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      if (opts.onLine) s.split(/\r?\n/).forEach(line => line && opts.onLine(line));
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (opts.onLine) s.split(/\r?\n/).forEach(line => line && opts.onLine(line));
    });
    let settled = false;
    const settle = (result) => { if (!settled) { settled = true; resolvePromise(result); } };
    child.on('error', (err) => settle({ code: 1, stdout, stderr: stderr + '\n' + err.message }));
    child.on('close', (code) => settle({ code: code ?? 0, stdout, stderr }));

    const timeoutMs = opts.timeoutMs || 5 * 60 * 1000;
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      settle({ code: 124, stdout, stderr: stderr + '\n[timeout]' });
    }, timeoutMs);
    child.on('close', () => clearTimeout(timer));
  });
}

export async function cloneRepo({ dataHome, name, cloneUrl, onLine }) {
  const target = repoDir(dataHome, name);
  if (existsSync(target) && existsSync(join(target, '.git'))) {
    logInstall(dataHome, name, `repo already exists at ${target}, skipping clone`);
    return { ok: true, path: target, reused: true };
  }
  ensureServerDir(dataHome, name);
  logInstall(dataHome, name, `git clone --depth=1 ${cloneUrl} ${target}`);
  const result = await runCommand('git', ['clone', '--depth=1', cloneUrl, target], {
    onLine: (line) => { logInstall(dataHome, name, line); onLine?.(line); },
  });
  if (result.code !== 0) {
    return { ok: false, error: `git clone failed (code ${result.code})`, stderr: result.stderr };
  }
  return { ok: true, path: target, reused: false };
}

function tryReadJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}

function tryReadText(p) {
  try { return readFileSync(p, 'utf-8'); } catch { return null; }
}

function extractMcpServersFromJsonBlob(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.mcpServers && typeof obj.mcpServers === 'object') {
    const entries = Object.entries(obj.mcpServers);
    if (entries.length) return { name: entries[0][0], cfg: entries[0][1] };
  }
  if (obj.command || obj.url) return { name: null, cfg: obj };
  const keys = Object.keys(obj);
  if (keys.length === 1 && typeof obj[keys[0]] === 'object') {
    const inner = obj[keys[0]];
    if (inner.command || inner.url) return { name: keys[0], cfg: inner };
    if (inner.mcpServers) return extractMcpServersFromJsonBlob(inner);
  }
  return null;
}

function detectFromManifest(repoPath) {
  for (const candidate of ['mcp.json', 'smithery.yaml', 'smithery.json', 'manifest.json', '.smithery.yaml']) {
    const p = join(repoPath, candidate);
    if (!existsSync(p)) continue;
    if (candidate.endsWith('.yaml')) {
      const txt = tryReadText(p);
      if (!txt) continue;
      const cmdMatch = txt.match(/\bcommand:\s*["']?([^\n"']+)["']?/);
      const argsMatch = txt.match(/\bargs:\s*\[([^\]]*)\]/);
      if (cmdMatch) {
        const args = argsMatch ? argsMatch[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : [];
        return { source: candidate, type: 'stdio', command: cmdMatch[1].trim(), args, env: {}, confidence: 'high' };
      }
      continue;
    }
    const obj = tryReadJson(p);
    if (!obj) continue;
    const found = extractMcpServersFromJsonBlob(obj);
    if (found && found.cfg) {
      const cfg = found.cfg;
      const env = cfg.env || cfg.environment || {};
      let command = cfg.command;
      let args = cfg.args;
      if (Array.isArray(command)) { args = command.slice(1); command = command[0]; }
      return {
        source: candidate,
        type: cfg.type === 'local' ? 'stdio' : (cfg.type || 'stdio'),
        command: command || '',
        args: Array.isArray(args) ? args : [],
        env: env && typeof env === 'object' ? env : {},
        url: cfg.url,
        confidence: 'high',
      };
    }
  }
  return null;
}

export function detectPackageManager(repoPath) {
  if (existsSync(join(repoPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(repoPath, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(repoPath, 'bun.lockb'))) return 'bun';
  if (existsSync(join(repoPath, 'package-lock.json'))) return 'npm';
  if (existsSync(join(repoPath, 'package.json'))) return 'npm';
  return null;
}

function detectFromPackageJson(repoPath) {
  const pkgPath = join(repoPath, 'package.json');
  const pkg = tryReadJson(pkgPath);
  if (!pkg) return null;
  let entry = null;
  if (pkg.bin) {
    if (typeof pkg.bin === 'string') entry = pkg.bin;
    else if (typeof pkg.bin === 'object') {
      const keys = Object.keys(pkg.bin);
      if (keys.length) entry = pkg.bin[keys[0]];
    }
  }
  if (!entry && pkg.main) entry = pkg.main;
  if (!entry && pkg.scripts?.start) {
    const startMatch = pkg.scripts.start.match(/node\s+([^\s]+)/);
    if (startMatch) entry = startMatch[1];
  }
  if (!entry) entry = 'dist/index.js';
  const abs = isAbsolute(entry) ? entry : resolve(repoPath, entry);
  return {
    source: 'package.json',
    type: 'stdio',
    command: 'node',
    args: [abs],
    env: {},
    confidence: pkg.bin ? 'high' : (pkg.main ? 'medium' : 'low'),
    packageManager: detectPackageManager(repoPath),
    needsBuild: !!pkg.scripts?.build && !existsSync(abs),
  };
}

function detectFromPython(repoPath) {
  const pyproject = tryReadText(join(repoPath, 'pyproject.toml'));
  const hasRequirements = existsSync(join(repoPath, 'requirements.txt'));
  if (!pyproject && !hasRequirements) return null;
  let module = null;
  if (pyproject) {
    const m = pyproject.match(/\[project\.scripts\][^\[]*?["']([\w-]+)["']\s*=\s*["']([\w.:]+)["']/);
    if (m) module = m[2].split(':')[0];
    if (!module) {
      const nm = pyproject.match(/^\s*name\s*=\s*["']([\w.-]+)["']/m);
      if (nm) module = nm[1].replace(/-/g, '_');
    }
  }
  const hasUv = existsSync(join(repoPath, 'uv.lock'));
  if (hasUv && module) {
    return { source: 'pyproject.toml', type: 'stdio', command: 'uv', args: ['run', '-m', module], env: {}, confidence: 'medium', packageManager: 'uv' };
  }
  if (module) {
    return { source: 'pyproject.toml', type: 'stdio', command: 'python', args: ['-m', module], env: {}, confidence: 'medium', packageManager: hasUv ? 'uv' : 'pip' };
  }
  return null;
}

function detectFromReadme(repoPath) {
  for (const candidate of ['README.md', 'README.MD', 'readme.md', 'README']) {
    const p = join(repoPath, candidate);
    if (!existsSync(p)) continue;
    const txt = tryReadText(p);
    if (!txt) continue;
    const blocks = [...txt.matchAll(/```(?:json|jsonc)?\s*\n([\s\S]+?)\n```/g)];
    for (const b of blocks) {
      const raw = b[1];
      if (!/mcpServers/.test(raw)) continue;
      const cleaned = raw.replace(/,\s*(?=[}\]])/g, '');
      try {
        const obj = JSON.parse(cleaned);
        const found = extractMcpServersFromJsonBlob(obj);
        if (found && found.cfg) {
          const cfg = found.cfg;
          const env = cfg.env || cfg.environment || {};
          let command = cfg.command;
          let args = cfg.args;
          if (Array.isArray(command)) { args = command.slice(1); command = command[0]; }
          return {
            source: `${candidate} (fenced json)`,
            type: cfg.type === 'local' ? 'stdio' : (cfg.type || 'stdio'),
            command: command || '',
            args: Array.isArray(args) ? args : [],
            env: env && typeof env === 'object' ? env : {},
            url: cfg.url,
            suggestedName: found.name || null,
            confidence: 'medium',
          };
        }
      } catch {}
    }
  }
  return null;
}

function resolveDetectedPaths(detected, repoPath) {
  if (!detected) return detected;
  const out = { ...detected };
  if (Array.isArray(out.args)) {
    out.args = out.args.map((a) => {
      if (typeof a !== 'string') return a;
      if (a.startsWith('./') || a.startsWith('../') || (!isAbsolute(a) && /\.(m?js|py|ts)$/.test(a))) {
        const abs = resolve(repoPath, a);
        if (existsSync(abs)) return abs;
      }
      return a;
    });
  }
  return out;
}

export function detectServer(repoPath) {
  if (!existsSync(repoPath)) return { ok: false, error: `Repo path does not exist: ${repoPath}` };
  const attempts = [];
  let detected = detectFromManifest(repoPath);
  if (detected) attempts.push('manifest');
  if (!detected) { detected = detectFromPackageJson(repoPath); if (detected) attempts.push('package.json'); }
  if (!detected) { detected = detectFromPython(repoPath); if (detected) attempts.push('python'); }
  if (!detected) { detected = detectFromReadme(repoPath); if (detected) attempts.push('readme'); }
  if (!detected) {
    return { ok: false, error: 'Could not auto-detect MCP server config. No manifest, package.json, pyproject.toml, or README mcpServers block found.' };
  }
  detected = resolveDetectedPaths(detected, repoPath);
  return { ok: true, detected, attempts };
}

// OS-aware install hints for self-fetching runtime binaries the detected
// command depends on. Used by the preflight check in checkSelfFetcherAvailable().
const SELF_FETCHER_INSTALL_HINTS = {
  uvx:  { mac: 'brew install uv', linux: 'curl -LsSf https://astral.sh/uv/install.sh | sh', win: 'winget install astral-sh.uv  or  powershell -c "irm https://astral.sh/uv/install.ps1 | iex"' },
  uv:   { mac: 'brew install uv', linux: 'curl -LsSf https://astral.sh/uv/install.sh | sh', win: 'winget install astral-sh.uv  or  powershell -c "irm https://astral.sh/uv/install.ps1 | iex"' },
  pipx: { mac: 'brew install pipx', linux: 'python3 -m pip install --user pipx && pipx ensurepath', win: 'python -m pip install --user pipx && pipx ensurepath' },
  npx:  { mac: 'brew install node', linux: 'install Node.js (https://nodejs.org)', win: 'winget install OpenJS.NodeJS' },
  bunx: { mac: 'brew install oven-sh/bun/bun', linux: 'curl -fsSL https://bun.sh/install | bash', win: 'powershell -c "irm bun.sh/install.ps1 | iex"' },
  bun:  { mac: 'brew install oven-sh/bun/bun', linux: 'curl -fsSL https://bun.sh/install | bash', win: 'powershell -c "irm bun.sh/install.ps1 | iex"' },
  pnpm: { mac: 'brew install pnpm', linux: 'npm install -g pnpm', win: 'npm install -g pnpm' },
  yarn: { mac: 'brew install yarn', linux: 'npm install -g yarn', win: 'npm install -g yarn' },
};

function installHintFor(cmd) {
  const h = SELF_FETCHER_INSTALL_HINTS[cmd];
  if (!h) return null;
  const platform = process.platform; // 'darwin' | 'linux' | 'win32'
  if (platform === 'darwin') return h.mac;
  if (platform === 'win32') return h.win;
  return h.linux;
}

// Probe whether a command exists on the user's PATH. OS-agnostic.
// On Windows uses `where`, elsewhere `command -v`. Handles .exe resolution on
// Windows (`where uvx` finds `uvx.exe`).
export function checkCommandOnPath(cmd) {
  if (!cmd) return false;
  const isWin = process.platform === 'win32';
  const probeCmd = isWin ? 'where' : 'sh';
  const probeArgs = isWin ? [cmd] : ['-c', `command -v ${cmd}`];
  try {
    const r = spawnSync(probeCmd, probeArgs, { stdio: 'ignore', timeout: 5000 });
    return r.status === 0;
  } catch { return false; }
}

// For self-fetching commands (uvx/npx/pipx/...) verify the runtime is available.
// Returns { available, command, installHint } so the install endpoint can warn
// the user before registering something that will fail at launch.
export function checkSelfFetcherAvailable(detected) {
  if (!detected || !detected.command) return { available: true, command: null, installHint: null };
  const cmd = String(detected.command).toLowerCase();
  const available = checkCommandOnPath(detected.command);
  return {
    available,
    command: detected.command,
    installHint: available ? null : installHintFor(cmd),
  };
}

// Returns true if the detected command fetches its package at runtime
// (uvx / uv run / npx / pipx / bunx / dlx) so local dependency install is unnecessary.
export function commandSelfFetches(detected) {
  if (!detected || !detected.command) return false;
  const cmd = String(detected.command).toLowerCase();
  const args = Array.isArray(detected.args) ? detected.args.map(a => String(a).toLowerCase()) : [];
  if (cmd === 'uvx' || cmd === 'pipx' || cmd === 'bunx') return true;
  if (cmd === 'npx') return true;
  if (cmd === 'uv' && args[0] === 'run') return true;
  if (cmd === 'pnpm' && args[0] === 'dlx') return true;
  if (cmd === 'yarn' && args[0] === 'dlx') return true;
  return false;
}

function detectClaudePlugin(repoPath) {
  const manifestPath = join(repoPath, '.claude-plugin', 'plugin.json');
  if (!existsSync(manifestPath)) return null;
  const manifest = tryReadJson(manifestPath);
  if (!manifest || !manifest.name) return null;
  const marketplacePath = join(repoPath, '.claude-plugin', 'marketplace.json');
  const marketplace = existsSync(marketplacePath) ? tryReadJson(marketplacePath) : null;
  const hooks = manifest.hooks && typeof manifest.hooks === 'object' ? Object.keys(manifest.hooks) : [];
  return { manifest, marketplace, hooks };
}

function scanHints(repoPath) {
  const hints = [];
  if (existsSync(join(repoPath, '.claude-plugin', 'plugin.json'))) hints.push('claude-plugin');
  if (existsSync(join(repoPath, '.codex'))) hints.push('codex');
  if (existsSync(join(repoPath, 'gemini-extension.json'))) hints.push('gemini');
  if (existsSync(join(repoPath, '.cursor'))) hints.push('cursor');
  if (existsSync(join(repoPath, '.windsurf'))) hints.push('windsurf');
  return hints;
}

// Classify a cloned repo. MCP wins if both present (preserves existing behavior).
export function classifyRepo(repoPath) {
  if (!existsSync(repoPath)) return { ok: false, kind: 'unknown', error: `Repo path does not exist: ${repoPath}` };
  const hints = scanHints(repoPath);
  const mcp = detectServer(repoPath);
  if (mcp.ok) {
    const out = { ok: true, kind: 'mcp', detected: mcp.detected, attempts: mcp.attempts, hints };
    const plugin = detectClaudePlugin(repoPath);
    if (plugin) out.alsoClaudePlugin = { manifest: plugin.manifest, marketplace: plugin.marketplace };
    return out;
  }
  const plugin = detectClaudePlugin(repoPath);
  if (plugin) {
    return { ok: true, kind: 'claude-plugin', plugin: { manifest: plugin.manifest, marketplace: plugin.marketplace, hooks: plugin.hooks }, hints };
  }
  return {
    ok: false,
    kind: 'unknown',
    error: "Couldn't identify the repo type. Looked for: mcp.json / smithery.*, package.json, pyproject.toml, README mcpServers block, and .claude-plugin/plugin.json.",
    hints,
    mcpError: mcp.error,
  };
}

export async function installDependencies({ dataHome, name, repoPath, onLine }) {
  const pm = detectPackageManager(repoPath);
  const hasPkg = existsSync(join(repoPath, 'package.json'));
  const hasPyproject = existsSync(join(repoPath, 'pyproject.toml'));
  const hasRequirements = existsSync(join(repoPath, 'requirements.txt'));
  const hasUvLock = existsSync(join(repoPath, 'uv.lock'));

  if (hasPkg && pm) {
    const cmd = pm === 'pnpm' ? ['pnpm', ['install', '--prod=false']]
              : pm === 'yarn' ? ['yarn', ['install']]
              : pm === 'bun' ? ['bun', ['install']]
              : ['npm', ['install']];
    logInstall(dataHome, name, `running ${cmd[0]} ${cmd[1].join(' ')}`);
    const res = await runCommand(cmd[0], cmd[1], { cwd: repoPath, onLine: (line) => { logInstall(dataHome, name, line); onLine?.(line); } });
    if (res.code !== 0) return { ok: false, error: `${cmd[0]} install failed (code ${res.code})` };
    const pkg = tryReadJson(join(repoPath, 'package.json'));
    if (pkg?.scripts?.build) {
      logInstall(dataHome, name, `running ${cmd[0]} run build`);
      const bres = await runCommand(cmd[0], ['run', 'build'], { cwd: repoPath, onLine: (line) => { logInstall(dataHome, name, line); onLine?.(line); } });
      if (bres.code !== 0) logInstall(dataHome, name, `[warn] build exited ${bres.code}`);
    }
    return { ok: true, packageManager: pm };
  }

  if (hasPyproject || hasRequirements) {
    if (hasUvLock || hasPyproject) {
      const uvExists = spawnSync('which', ['uv']).status === 0;
      if (uvExists) {
        logInstall(dataHome, name, 'running uv sync');
        const res = await runCommand('uv', ['sync'], { cwd: repoPath, onLine: (line) => { logInstall(dataHome, name, line); onLine?.(line); } });
        if (res.code === 0) return { ok: true, packageManager: 'uv' };
        logInstall(dataHome, name, `[warn] uv sync failed (code ${res.code}), falling back to pip`);
      }
    }
    if (hasRequirements) {
      logInstall(dataHome, name, 'running pip install -r requirements.txt');
      const res = await runCommand('pip', ['install', '-r', 'requirements.txt'], { cwd: repoPath, onLine: (line) => { logInstall(dataHome, name, line); onLine?.(line); } });
      if (res.code !== 0) return { ok: false, error: `pip install failed (code ${res.code})` };
      return { ok: true, packageManager: 'pip' };
    }
    return { ok: false, error: 'No package.json/requirements.txt found to install' };
  }

  return { ok: true, packageManager: null, note: 'No dependencies to install' };
}
