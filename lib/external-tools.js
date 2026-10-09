/**
 * SynaBun — external tools stay external
 *
 * Claude Code, Codex, OpenCode and Gemini CLI are programs of their own. The
 * user installs them; SynaBun finds what is installed (PATH, Homebrew, npm, the
 * native installers' folders) and talks to it, through a thin JavaScript SDK
 * where there is one. It never installs, ships or runs a copy of its own.
 *
 * npm has no way to say "this SDK, without the program it carries": the Claude
 * Agent SDK brings the Claude Code executable as a per-platform optional
 * dependency, and @openai/codex-sdk depends on the whole Codex CLI. So the rule
 * is kept in three places, all reading the one list below:
 *
 *   the lockfiles      hold none of these packages and no edge to one
 *                      (scripts/strip-external-tools.mjs), so npm never
 *                      downloads them
 *   an install         removes any that came anyway (the neural-interface
 *                      postinstall, the server at start)
 *   a packaged build   removes them from what it stages and refuses a bundle
 *                      that holds one (packaging/lib/stage.mjs, verify.mjs)
 *
 * The SDKs stay: every call hands them the user's executable
 * (pathToClaudeCodeExecutable, codexPathOverride), so the payload they would
 * otherwise look for is never needed.
 *
 * Only node:fs and node:path here: the install scripts import this on any
 * Node, before a single dependency exists.
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PLATFORMS = '(?:darwin|linux|win32|windows|android)';

/**
 * Each tool: the command the user runs, the packages that ARE the tool (never
 * a dependency of SynaBun), and how its per-platform payload packages are
 * named. A name is what a package is installed as, under node_modules.
 */
export const EXTERNAL_TOOLS = Object.freeze([
  Object.freeze({
    id: 'claude-code',
    label: 'Claude Code',
    command: 'claude',
    packages: Object.freeze(['@anthropic-ai/claude-code']),
    // The CLI's own platform packages, and the same executable as the Agent SDK carries it.
    patterns: Object.freeze([
      new RegExp(`^@anthropic-ai/claude-code-${PLATFORMS}-`),
      new RegExp(`^@anthropic-ai/claude-agent-sdk-${PLATFORMS}-`),
    ]),
  }),
  Object.freeze({
    id: 'codex',
    label: 'Codex',
    command: 'codex',
    packages: Object.freeze(['@openai/codex']),
    // (@openai/codex-sdk is the JavaScript client and is not matched.)
    patterns: Object.freeze([new RegExp(`^@openai/codex-${PLATFORMS}-`)]),
  }),
  Object.freeze({
    id: 'opencode',
    label: 'OpenCode',
    command: 'opencode',
    packages: Object.freeze(['opencode-ai']),
    // (@opencode-ai/sdk is the JavaScript client and is not matched.)
    patterns: Object.freeze([new RegExp(`^opencode-${PLATFORMS}-`)]),
  }),
  Object.freeze({
    id: 'gemini',
    label: 'Gemini CLI',
    command: 'gemini',
    packages: Object.freeze(['@google/gemini-cli', '@google/gemini-cli-core']),
    patterns: Object.freeze([]),
  }),
]);

/** The file names a tool's command can have in a `.bin` folder or on disk. */
const COMMAND_SUFFIXES = ['', '.cmd', '.ps1', '.bat', '.exe'];
const COMMAND_FILES = new Map(EXTERNAL_TOOLS.flatMap(tool => COMMAND_SUFFIXES.map(suffix => [`${tool.command}${suffix}`, tool])));

/** The tool a package name belongs to, or null: `@openai/codex` yes, `@openai/codex-sdk` no. */
export function externalToolOf(packageName) {
  const name = String(packageName || '');
  if (!name) return null;
  return EXTERNAL_TOOLS.find(tool => tool.packages.includes(name) || tool.patterns.some(pattern => pattern.test(name))) || null;
}

/** The package a lockfile path installs: what follows its last `node_modules/`. */
export function packageNameOfLockPath(path) {
  const value = String(path || '').replace(/\\/g, '/');
  const at = value.lastIndexOf('node_modules/');
  return at < 0 ? '' : value.slice(at + 'node_modules/'.length);
}

const EDGE_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'devDependencies'];

/**
 * What a lockfile (package-lock.json, or the hidden node_modules/.package-lock.json)
 * still holds of external tools: `packages` are the entries that would be
 * installed, `edges` the dependencies other entries declare on one.
 */
export function externalToolsInLock(lock) {
  const packages = [];
  const edges = [];
  for (const [path, entry] of Object.entries(lock?.packages || {})) {
    const tool = externalToolOf(packageNameOfLockPath(path));
    if (tool) { packages.push({ path, tool: tool.id, version: entry?.version || null }); continue; }
    for (const field of EDGE_FIELDS) {
      for (const name of Object.keys(entry?.[field] || {})) {
        const wanted = externalToolOf(name);
        if (wanted) edges.push({ from: path || '(root)', field, name, tool: wanted.id });
      }
    }
  }
  return { packages, edges };
}

/**
 * Take every external tool out of a lockfile object, in place: its entries, and
 * the edges that would make npm fetch them again. Returns what was removed.
 * A lockfile left this way installs the SDKs and nothing they would carry.
 */
export function stripExternalToolsFromLock(lock) {
  const found = externalToolsInLock(lock);
  for (const item of found.packages) delete lock.packages[item.path];
  for (const edge of found.edges) {
    const entry = lock.packages[edge.from === '(root)' ? '' : edge.from];
    if (!entry?.[edge.field]) continue;
    delete entry[edge.field][edge.name];
    if (!Object.keys(entry[edge.field]).length) delete entry[edge.field];
  }
  return found;
}

const list = (folder) => { try { return readdirSync(folder, { withFileTypes: true }); } catch { return []; } };

/**
 * Every external-tool package and command installed under one node_modules
 * folder, nested trees included: [{ kind: 'package' | 'command', name, tool, path }].
 */
export function externalToolsInstalledIn(nodeModules, { depth = 6 } = {}) {
  const found = [];
  const visitModules = (folder, left) => {
    for (const entry of list(folder)) {
      if (entry.name === '.bin') {
        for (const file of list(join(folder, '.bin'))) {
          const tool = COMMAND_FILES.get(file.name);
          if (tool) found.push({ kind: 'command', name: file.name, tool: tool.id, path: join(folder, '.bin', file.name) });
        }
        continue;
      }
      if (entry.name.startsWith('.') || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
      const names = entry.name.startsWith('@')
        ? list(join(folder, entry.name)).filter(scoped => scoped.isDirectory() || scoped.isSymbolicLink()).map(scoped => `${entry.name}/${scoped.name}`)
        : [entry.name];
      for (const name of names) {
        const path = join(folder, ...name.split('/'));
        const tool = externalToolOf(name);
        if (tool) { found.push({ kind: 'package', name, tool: tool.id, path }); continue; }
        if (left > 0 && existsSync(join(path, 'node_modules'))) visitModules(join(path, 'node_modules'), left - 1);
      }
    }
  };
  visitModules(nodeModules, depth);
  return found;
}

/**
 * Remove what externalToolsInstalledIn() finds, and the same entries from npm's
 * hidden lockfile, so that npm's own record matches the folder. Never throws:
 * `failed` lists what could not be removed (a read-only install, a file in use).
 * Does nothing, and writes nothing, when there is nothing to remove.
 */
export function pruneExternalTools(nodeModules, { log = null } = {}) {
  const result = { removed: [], failed: [] };
  for (const item of externalToolsInstalledIn(nodeModules)) {
    try {
      rmSync(item.path, { recursive: true, force: true });
      result.removed.push(item);
      if (log) log(`removed ${item.kind} ${item.name} (${item.tool} is installed separately): ${item.path}`);
    } catch (error) {
      result.failed.push({ ...item, error: error?.message || String(error) });
      if (log) log(`could not remove ${item.path}: ${error?.message || error}`);
    }
  }
  if (!result.removed.length) return result;
  const hidden = join(nodeModules, '.package-lock.json');
  try {
    const lock = JSON.parse(readFileSync(hidden, 'utf8'));
    const stripped = stripExternalToolsFromLock(lock);
    if (stripped.packages.length || stripped.edges.length) writeFileSync(hidden, JSON.stringify(lock, null, 2) + '\n');
  } catch { /* no hidden lockfile, or not ours to repair */ }
  return result;
}

/**
 * Why a file of a packaged application is an external tool's, or null. By path
 * alone, forward or back slashes: a package folder, or a command in a `.bin`
 * folder. `native` says the file is a native executable; then the tool's own
 * file name anywhere is one too (`claude`, `codex.exe` ...).
 */
export function externalToolPayloadReason(relativePath, { native = false } = {}) {
  const path = String(relativePath || '').replace(/\\/g, '/');
  const parts = path.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] !== 'node_modules') continue;
    if (parts[i + 1] === '.bin') {
      const tool = i + 2 === parts.length - 1 ? COMMAND_FILES.get(parts[i + 2]) : null;
      if (tool) return `the ${tool.label} command (${parts[i + 2]})`;
      continue;
    }
    const name = parts[i + 1].startsWith('@') ? `${parts[i + 1]}/${parts[i + 2] || ''}` : parts[i + 1];
    const tool = externalToolOf(name);
    if (tool) return `the package ${name} (${tool.label})`;
  }
  if (native) {
    const tool = COMMAND_FILES.get(parts[parts.length - 1]);
    if (tool) return `the ${tool.label} executable`;
  }
  return null;
}
