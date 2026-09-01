// ═══════════════════════════════════════════
// SynaBun — CLI Update Planner
//
// Works out HOW each external CLI (Claude Code, Codex, OpenCode, Gemini) was
// installed, and therefore which command actually updates it and which
// "latest version" it should be compared against.
//
// The rule that drives everything here:
//
//   If an EXTERNAL package manager owns the binary, use that manager.
//   Only fall back to the tool's own self-updater when the tool installed
//   itself (native installer / curl script) or detection failed.
//
// A self-updater writing into its own directory cannot replace a
// Homebrew-managed binary — brew's symlink in /opt/homebrew/bin still wins
// PATH, so the update silently does nothing and the badge never clears.
// ═══════════════════════════════════════════

/** npm package name per tool key. */
export const NPM_PKGS = {
  'claude-code': '@anthropic-ai/claude-code',
  'codex': '@openai/codex',
  'gemini': '@google/gemini-cli',
  'opencode': 'opencode-ai',
};

/**
 * Homebrew token per tool, used only when the token cannot be derived from
 * the binary path (see brewTokenFromPath). Tap-installed formulae resolve
 * correctly from the path, so prefer that.
 */
export const BREW_FALLBACK_TOKENS = {
  'claude-code': 'claude-code',
  'codex': 'codex',
  'gemini': 'gemini-cli',
  'opencode': 'opencode',
};

/**
 * Whether each tool ships as a Homebrew cask or a formula. This is a property
 * of the package, not of the machine — claude-code and codex exist ONLY as
 * casks, gemini-cli and opencode ONLY as formulae. Needed when a tool is not
 * installed and there is no path to classify: guessing the wrong flavour
 * produces a command that simply errors ("Cask 'gemini-cli' is unavailable").
 */
export const BREW_KINDS = {
  'claude-code': 'cask',
  'codex': 'cask',
  'gemini': 'formula',
  'opencode': 'formula',
};

/** Tools that can update themselves when they own their own install. */
const SELF_UPDATERS = {
  'claude-code': 'claude update',
  'codex': 'codex update',
  'opencode': 'opencode upgrade',
  // gemini has no self-updater.
};

/**
 * OpenCode's `upgrade --method` accepts exactly these values. Mapping our
 * detected source onto it lets OpenCode do its own install-aware work for
 * the channels we cannot drive directly.
 */
const OPENCODE_METHODS = {
  'standalone': 'curl',
  'npm': 'npm',
  'pnpm': 'pnpm',
  'bun': 'bun',
  'brew-formula': 'brew',
  'brew-cask': 'brew',
  'choco': 'choco',
  'scoop': 'scoop',
};

/** Sources that mean "a package manager other than the tool itself owns this". */
const MANAGED_SOURCES = new Set([
  'brew-cask', 'brew-formula', 'npm', 'bun', 'pnpm', 'yarn', 'volta', 'scoop', 'choco', 'winget',
]);

export function isBrewSource(source) {
  return source === 'brew-cask' || source === 'brew-formula';
}

export function isManagedSource(source) {
  return MANAGED_SOURCES.has(source);
}

/**
 * Classify an install from the resolved (symlink-followed) binary path.
 *
 * ORDER MATTERS. Every alternative JS package manager stores its globals
 * under a `node_modules` directory, so the generic npm test has to come
 * last — otherwise a bun-global install is misreported as npm and handed
 * `npm install -g`, which writes to a prefix that does not own the binary
 * currently on PATH.
 */
export function detectInstallSource(binPath) {
  if (!binPath) return 'unknown';
  const p = String(binPath).replace(/\\/g, '/').toLowerCase();

  // Homebrew — Caskroom must be tested before the generic /opt/homebrew/
  // rule, since a cask path contains both.
  if (p.includes('/caskroom/')) return 'brew-cask';
  if (p.includes('/cellar/')) return 'brew-formula';
  if (p.includes('/opt/homebrew/') || p.includes('/linuxbrew/') || p.includes('/homebrew/')) return 'brew-formula';

  // Alternative JS package managers — all before the npm rule.
  if (p.includes('/.bun/')) return 'bun';
  if (p.includes('/pnpm/') || p.includes('/.local/share/pnpm/')) return 'pnpm';
  if (p.includes('/.yarn/') || p.includes('/yarn/global/')) return 'yarn';
  if (p.includes('/.volta/')) return 'volta';

  // Tool-owned installers.
  if (p.includes('/.opencode/')) return 'standalone';
  if (p.includes('/.claude/local/') || p.includes('/anthropicclaude/')) return 'native';

  // Windows package managers — before the Program Files native rule, since
  // scoop/choco shims can live under a user profile that also matches.
  if (p.includes('/winget/') || p.includes('/microsoft/winget/')) return 'winget';
  if (p.includes('/scoop/')) return 'scoop';
  if (p.includes('/chocolatey/')) return 'choco';

  // Native installers.
  if (/\/\.local\/bin\//.test(p)) return 'native';
  if (/\/program files( \(x86\))?\//.test(p)) return 'native';

  // Generic npm global — LAST.
  if (p.includes('/node_modules/')) return 'npm';

  return 'other';
}

/**
 * Derive the Homebrew token from a Caskroom/Cellar path, e.g.
 *   /opt/homebrew/Caskroom/claude-code/2.1.224/claude  -> claude-code
 *   /opt/homebrew/Cellar/opencode/1.18.18/bin/opencode -> opencode
 *
 * Reading it from the path rather than a hardcoded map is what makes
 * tap-installed formulae work (e.g. OpenCode ships from anomalyco/tap, whose
 * version differs from homebrew/core's).
 */
export function brewTokenFromPath(binPath) {
  if (!binPath) return null;
  const p = String(binPath).replace(/\\/g, '/');
  const m = p.match(/\/(?:Caskroom|Cellar)\/([^/]+)\//i);
  return m ? m[1] : null;
}

/** Resolve the brew token for a tool, preferring the path-derived one. */
export function resolveBrewToken(toolKey, binPath) {
  return brewTokenFromPath(binPath) || BREW_FALLBACK_TOKENS[toolKey] || toolKey;
}

/**
 * Build the command that actually updates a tool, given how it was installed.
 * Returns null when there is no safe automated path (e.g. winget with no
 * self-updater) — the caller should show a "use your installer" hint instead.
 */
export function buildUpdateCommand(toolKey, installSource, { brewToken = null } = {}) {
  const npmPkg = NPM_PKGS[toolKey];
  const selfUpdate = SELF_UPDATERS[toolKey] || null;

  // A package manager owns the binary — only that manager can replace it.
  if (isBrewSource(installSource)) {
    const token = brewToken || BREW_FALLBACK_TOKENS[toolKey] || toolKey;
    // `brew upgrade <token>` does resolve casks, but be explicit so a
    // formula/cask name collision can never pick the wrong one.
    return installSource === 'brew-cask'
      ? `brew upgrade --cask ${token}`
      : `brew upgrade ${token}`;
  }

  if (!npmPkg) return selfUpdate;

  switch (installSource) {
    case 'npm':   return `npm install -g ${npmPkg}@latest`;
    case 'yarn':  return `yarn global add ${npmPkg}@latest`;
    case 'volta': return `volta install ${npmPkg}@latest`;
    case 'bun':
    case 'pnpm':
      // OpenCode drives these itself; the others take the plain global add.
      if (toolKey === 'opencode') return `opencode upgrade --method ${OPENCODE_METHODS[installSource]}`;
      return installSource === 'bun'
        ? `bun add -g ${npmPkg}@latest`
        : `pnpm add -g ${npmPkg}@latest`;
    case 'scoop':
    case 'choco':
      if (toolKey === 'opencode') return `opencode upgrade --method ${OPENCODE_METHODS[installSource]}`;
      return null; // no safe automated path — caller shows a hint
    case 'winget':
      return null;
    case 'standalone':
      // The tool's own installer put it here, so its own updater is right.
      return toolKey === 'opencode' ? 'opencode upgrade --method curl' : selfUpdate;
    case 'native':
      return selfUpdate;
    default:
      // 'other' / 'unknown' — let the tool self-detect if it can, else
      // fall back to npm, which is how the vast majority are installed.
      return selfUpdate || `npm install -g ${npmPkg}@latest`;
  }
}

/**
 * Parse `brew outdated --json=v2` into a token -> current_version map.
 * Indexes both the bare token and any tap-qualified full name so lookups
 * work regardless of which form the caller derived from the path.
 */
export function parseBrewOutdated(raw) {
  if (raw == null) return null;
  let data = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return null;
    try { data = JSON.parse(text); } catch { return null; }
  }
  if (!data || typeof data !== 'object') return null;

  const out = new Map();
  for (const group of ['formulae', 'casks']) {
    for (const entry of Array.isArray(data[group]) ? data[group] : []) {
      const version = entry?.current_version || entry?.current_versions?.[0] || null;
      if (!version) continue;
      for (const nameField of [entry.name, entry.token, entry.full_name, entry.full_token]) {
        if (!nameField) continue;
        const name = String(nameField);
        out.set(name, version);
        const bare = name.split('/').pop();
        if (bare) out.set(bare, version);
      }
    }
  }
  return out;
}

/**
 * Decide which "latest" a tool should be compared against.
 *
 * For a brew install the npm registry is the wrong yardstick: Homebrew often
 * trails upstream by a few releases, so comparing against npm produces a
 * badge that lights up while `brew upgrade` answers "already installed" —
 * a permanently stuck badge that the post-update poll loop spins on.
 *
 * When the brew probe itself failed we fail CLOSED (latest = installed)
 * rather than falling back to npm, for the same reason.
 */
export function resolveLatest({
  installSource,
  brewToken = null,
  brewOutdated = null,
  npmLatest = null,
  installed = null,
} = {}) {
  if (!isBrewSource(installSource)) return npmLatest;
  if (!installed) return null;
  if (!brewOutdated) return installed;
  const token = brewToken || null;
  const hit = (token && brewOutdated.get(token))
    || (token && brewOutdated.get(String(token).split('/').pop()))
    || null;
  return hit || installed;
}

/**
 * Human-readable install-source label for UI copy — "update via Homebrew"
 * reads better than "update via brew-cask".
 */
export function installSourceLabel(source) {
  switch (source) {
    case 'brew-cask':
    case 'brew-formula': return 'Homebrew';
    case 'npm': return 'npm';
    case 'bun': return 'Bun';
    case 'pnpm': return 'pnpm';
    case 'yarn': return 'Yarn';
    case 'volta': return 'Volta';
    case 'standalone': return 'the official installer';
    case 'native': return 'the native installer';
    case 'winget': return 'winget';
    case 'scoop': return 'Scoop';
    case 'choco': return 'Chocolatey';
    default: return 'your installer';
  }
}

/**
 * The command that INSTALLS a tool that is missing. Mirrors the update
 * matrix so a Homebrew user is not told to `npm install -g`, which would
 * create a second, conflicting install.
 */
export function buildInstallCommand(toolKey, installSource = 'unknown') {
  const npmPkg = NPM_PKGS[toolKey];
  if (isBrewSource(installSource)) {
    const token = BREW_FALLBACK_TOKENS[toolKey] || toolKey;
    // Use the package's OWN flavour, not the one inferred from sibling tools:
    // a machine whose other CLIs are casks says nothing about whether THIS
    // package is a cask.
    return BREW_KINDS[toolKey] === 'cask'
      ? `brew install --cask ${token}`
      : `brew install ${token}`;
  }
  if (!npmPkg) return '';
  switch (installSource) {
    case 'bun':   return `bun add -g ${npmPkg}`;
    case 'pnpm':  return `pnpm add -g ${npmPkg}`;
    case 'yarn':  return `yarn global add ${npmPkg}`;
    case 'volta': return `volta install ${npmPkg}`;
    default:      return `npm install -g ${npmPkg}`;
  }
}
