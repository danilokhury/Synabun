/**
 * Audit and repair only existing SynaBun MCP registrations.
 *
 * Updates never create a client registration the user did not already have,
 * and JSON/TOML writers preserve unrelated client configuration.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  mergeGeminiMcpConfig,
  mergeOpenCodeMcpConfig,
} from '../neural-interface/lib/mcp-client-config.js';
import {
  inspectCodexConfig,
  upsertCodexMcpConfig,
} from '../mcp-server/dist/services/codex-config-heal.js';

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.synabun-${process.pid}-${Date.now()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf-8');
  renameSync(temp, path);
}

function jsonChanged(before, after) {
  return JSON.stringify(before) !== JSON.stringify(after);
}

export function buildCanonicalMcpDefinition({ dataHome, packageRoot }) {
  const canonicalDataHome = resolve(dataHome);
  return {
    command: 'node',
    args: [resolve(packageRoot, 'mcp-server', 'dist', 'preload.js').replace(/\\/g, '/')],
    env: {
      DOTENV_PATH: resolve(canonicalDataHome, '.env').replace(/\\/g, '/'),
      SYNABUN_DATA_HOME: canonicalDataHome,
      MEMORY_DATA_DIR: resolve(canonicalDataHome, 'mcp-data'),
    },
  };
}

export function auditAndRepairClientConfigs({
  dataHome,
  packageRoot,
  home = process.env.USERPROFILE || process.env.HOME || homedir(),
  apply = false,
} = {}) {
  if (!dataHome || !packageRoot) throw new Error('dataHome and packageRoot are required');
  const definition = buildCanonicalMcpDefinition({ dataHome, packageRoot });
  const results = {};

  const claudePath = join(home, '.claude.json');
  const claude = readJson(claudePath);
  if (claude?.mcpServers?.SynaBun) {
    const before = claude.mcpServers.SynaBun;
    // Keep the current HTTP transport. Only legacy stdio registrations carry
    // package/data paths that need rewriting.
    if (before.command || before.args || before.env) {
      const next = {
        ...claude,
        mcpServers: {
          ...claude.mcpServers,
          SynaBun: { command: definition.command, args: definition.args, env: definition.env },
        },
      };
      const changed = jsonChanged(claude, next);
      if (apply && changed) writeJsonAtomic(claudePath, next);
      results.claude = { exists: true, connected: true, changed, path: claudePath, transport: 'stdio' };
    } else {
      results.claude = { exists: true, connected: true, changed: false, path: claudePath, transport: before.type || 'http' };
    }
  } else {
    results.claude = { exists: existsSync(claudePath), connected: false, changed: false, path: claudePath };
  }

  const geminiPath = join(home, '.gemini', 'settings.json');
  const gemini = readJson(geminiPath);
  if (gemini?.mcpServers?.SynaBun) {
    const next = mergeGeminiMcpConfig(gemini, definition);
    const changed = jsonChanged(gemini, next);
    if (apply && changed) writeJsonAtomic(geminiPath, next);
    results.gemini = { exists: true, connected: true, changed, path: geminiPath };
  } else {
    results.gemini = { exists: existsSync(geminiPath), connected: false, changed: false, path: geminiPath };
  }

  const xdgConfigHome = process.env.XDG_CONFIG_HOME || join(home, '.config');
  const openCodePath = join(xdgConfigHome, 'opencode', 'config.json');
  const openCode = readJson(openCodePath);
  if (openCode?.mcp?.SynaBun) {
    const next = mergeOpenCodeMcpConfig(openCode, 'SynaBun', definition);
    const changed = jsonChanged(openCode, next);
    if (apply && changed) writeJsonAtomic(openCodePath, next);
    results.opencode = { exists: true, connected: true, changed, path: openCodePath };
  } else {
    results.opencode = { exists: existsSync(openCodePath), connected: false, changed: false, path: openCodePath };
  }

  const codexPath = join(home, '.codex', 'config.toml');
  const codexHealth = inspectCodexConfig(codexPath);
  if (codexHealth.connected) {
    let changed = false;
    if (apply) {
      const before = readFileSync(codexPath, 'utf-8');
      upsertCodexMcpConfig(codexPath, definition);
      changed = before !== readFileSync(codexPath, 'utf-8');
    } else {
      const content = readFileSync(codexPath, 'utf-8');
      changed = !definition.args.every(value => content.includes(value))
        || !Object.values(definition.env).every(value => content.includes(value));
    }
    results.codex = { exists: true, connected: true, changed, path: codexPath, health: codexHealth };
  } else {
    results.codex = { exists: existsSync(codexPath), connected: false, changed: false, path: codexPath, health: codexHealth };
  }

  return {
    checkedAt: new Date().toISOString(),
    applied: apply,
    definition,
    changed: Object.values(results).filter(result => result.changed).map(result => result.path),
    clients: results,
  };
}
