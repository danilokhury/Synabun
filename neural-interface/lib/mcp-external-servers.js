import { buildClaudeMcpEntry } from './mcp-client-config.js';
// External definitions stay at the launch boundary. Public views contain names and availability only.
import { existsSync, realpathSync, readFileSync, mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseJsonc, mcpServersOf, mergedOpencodeConfig, readOpencodeConfigDocuments } from './opencode-config.js';
import { agentAccessFrom } from './mcp-agent-servers.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const canonical = path => { try { return realpathSync(path); } catch { return resolve(path); } };
const claudeProject = (user, cwd) => user.projects?.[canonical(cwd)] || user.projects?.[resolve(cwd)] || {};
const external = name => name !== 'SynaBun';
export const EXTERNAL_SERVER_LIMITATIONS = Object.freeze({ codex: 'Plugin-provided MCP servers cannot be enumerated from config.toml', 'claude-code': 'claude.ai connectors are unavailable under strict MCP configuration' });
export const externalServerName = name => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(name) && external(name);
function read(path, fallback = null) {
  try { return readFileSync(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw Object.assign(new Error('Could not read an MCP configuration source'), { code: 'MCP_DISCOVERY_FAILED' }); }
}
function document(path) {
  const text = read(path);
  if (text === null) return {};
  try { return object(parseJsonc(text)); }
  catch { throw Object.assign(new Error('Could not parse an MCP configuration source'), { code: 'MCP_DISCOVERY_FAILED' }); }
}
/** Names/kinds/enabled only: Codex keeps definitions and secrets in its own TOML. Quoted dotted names stay whole. */
export function parseCodexMcpServers(text = '') {
  // Structural TOML reader: supports tables, dotted/quoted keys and inline maps without copying definitions.
  const tokens = []; let at = 0;
  const input = String(text);
  const fail = () => Object.assign(new Error('Could not parse Codex MCP configuration'), { code: 'MCP_DISCOVERY_FAILED' });
  while (at < input.length) {
    const ch = input[at];
    if (ch === '#') { while (at < input.length && input[at] !== '\n') at++; continue; }
    if (ch === '\n') { tokens.push({ type: 'nl', value: ch }); at++; continue; }
    if (/\s/.test(ch)) { at++; continue; }
    if ('[]{}=.,'.includes(ch)) { tokens.push({ type: 'punct', value: ch }); at++; continue; }
    if (ch === '"' || ch === "'") {
      const start = at, triple = input.slice(at, at + 3) === ch.repeat(3); at += triple ? 3 : 1;
      let closed = false;
      while (at < input.length) {
        if (ch === '"' && input[at] === '\\') { at += 2; continue; }
        if (input.slice(at, at + (triple ? 3 : 1)) === ch.repeat(triple ? 3 : 1)) { at += triple ? 3 : 1; closed = true; break; }
        at++;
      }
      if (!closed) throw fail();
      const raw = input.slice(start, at); let value;
      if (triple) value = raw.slice(3, -3);
      else if (ch === "'") value = raw.slice(1, -1);
      else {
        try { value = JSON.parse(raw.replace(/\\U([0-9a-fA-F]{8})/g, (_, code) => String.fromCodePoint(parseInt(code, 16)))); }
        catch { throw fail(); }
      }
      tokens.push({ type: 'string', value }); continue;
    }
    const start = at;
    while (at < input.length && !/[\s\[\]{}=.,#"']/.test(input[at])) at++;
    if (at === start) throw fail();
    tokens.push({ type: 'word', value: input.slice(start, at) });
  }
  let index = 0;
  const peek = () => tokens[index]?.value;
  const skipLines = () => { while (tokens[index]?.type === 'nl') index++; };
  function keys() {
    const out = [];
    while (tokens[index] && ['word', 'string'].includes(tokens[index].type)) {
      const token = tokens[index++];
      if (token.type === 'word' && !/^[A-Za-z0-9_-]+$/.test(token.value)) throw fail();
      out.push(token.value); if (peek() !== '.') break; index++;
    }
    return out;
  }
  function put(root, path, value) {
    let target = root;
    for (const key of path.slice(0, -1)) { if (!target[key] || typeof target[key] !== 'object') target[key] = Object.create(null); target = target[key]; }
    target[path.at(-1)] = value;
  }
  function value() {
    if (peek() === '{') {
      index++; const out = Object.create(null); skipLines();
      while (peek() !== '}') {
        const path = keys(); if (!path.length || peek() !== '=') throw fail(); index++;
        put(out, path, value()); skipLines();
        if (peek() === ',') { index++; skipLines(); } else if (peek() !== '}') throw fail();
      }
      index++; return out;
    }
    if (peek() === '[') {
      index++; const out = []; skipLines();
      while (peek() !== ']') {
        if (!tokens[index]) throw fail(); out.push(value()); skipLines();
        if (peek() === ',') { index++; skipLines(); } else if (peek() !== ']') throw fail();
      }
      index++; return out;
    }
    const first = tokens[index++]; if (!first) throw fail();
    if (first.type === 'string') return first.value;
    let raw = first.value;
    while (tokens[index] && tokens[index].type !== 'nl' && ![',', '}', ']'].includes(peek())) raw += tokens[index++].value;
    return raw === 'false' ? false : raw === 'true' ? true : raw;
  }
  const rows = new Map(); let table = [];
  function observe(path, item) {
    if (path[0] !== 'mcp_servers') return;
    if (path.length === 1 && item && typeof item === 'object') { for (const [name, entry] of Object.entries(item)) observe(['mcp_servers', name], entry); return; }
    const name = path[1]; if (name === undefined) return;
    if (!rows.has(name)) rows.set(name, { kind: 'stdio', enabled: true });
    const info = rows.get(name);
    if (path.length === 2 && item && typeof item === 'object') { if (typeof item.url === 'string') info.kind = 'http'; if (item.enabled === false) info.enabled = false; }
    if (path.length === 3 && path[2] === 'url') info.kind = 'http';
    if (path.length === 3 && path[2] === 'enabled') info.enabled = item !== false;
  }
  while (index < tokens.length) {
    skipLines(); if (!tokens[index]) break;
    if (peek() === '[') {
      index++; const arrayTable = peek() === '['; if (arrayTable) index++;
      table = keys(); if (peek() !== ']') throw fail(); index++;
      if (arrayTable) { if (peek() !== ']') throw fail(); index++; }
      observe(table); continue;
    }
    const path = keys(); if (!path.length || peek() !== '=') throw fail(); index++;
    observe([...table, ...path], value());
    while (tokens[index] && tokens[index].type !== 'nl') index++;
  }
  return rows;
}
export function codexMcpServerNames(codexHome) { if (!codexHome) return []; return [...parseCodexMcpServers(read(join(codexHome, 'config.toml'), '')).keys()]; }
export function projectOpenCodeConfigs(cwd) {
  const dirs = []; let dir = canonical(cwd);
  while (true) { dirs.unshift(dir); const parent = dirname(dir); if (parent === dir) break; dir = parent; }
  // Every direct file, then every .opencode directory, farthest ancestor first (OpenCode 2 discovery).
  return [...dirs, ...dirs.map(path => join(path, '.opencode'))].flatMap(path => ['opencode.json', 'opencode.jsonc'].map(name => join(path, name)));
}
export function claudePluginDefinitions(pluginRoot, manifest = document(join(pluginRoot, '.claude-plugin', 'plugin.json'))) {
  const out = {};
  const expand = value => typeof value === 'string' ? value.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot) : Array.isArray(value) ? value.map(expand) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)])) : value;
  const add = data => Object.assign(out, object(data.mcpServers || data));
  add(document(join(pluginRoot, '.mcp.json')));
  const declared = manifest.mcpServers;
  if (typeof declared === 'string') add(document(resolve(pluginRoot, declared)));
  else if (Array.isArray(declared)) { for (const path of declared) if (typeof path === 'string') add(document(resolve(pluginRoot, path))); }
  else Object.assign(out, object(declared));
  return expand(out);
}
function claudeEntry(entry) { return structuredClone(entry); }

/** This is the only filesystem discovery boundary; definitions never escape through servers/catalogView. */
export function externalServerInventory({ provider, cwd = process.cwd(), codexHome, home = homedir(), dataHome, registry, opencodeConfig, readProject = true, env = process.env } = {}) {
  const reg = registry || (dataHome ? document(join(dataHome, 'data', 'mcp-registry.json')) : {});
  const access = agentAccessFrom(reg), definitions = new Map(), rows = new Map();
  function add(name, entry, source, deliverable = true, reason = null, kind = null) {
    if (!external(name)) return;
    const enabled = entry.enabled !== false && entry.disabled !== true;
    const transport = provider === 'codex' || (entry.url ? typeof entry.url === 'string' : Array.isArray(entry.command) ? entry.command.length > 0 : typeof entry.command === 'string' && !!entry.command);
    const supported = provider !== 'claude-code' || (entry.url ? ['http', 'streamable-http', 'sse', 'ws'].includes(entry.type) : entry.type === undefined || entry.type === 'stdio');
    const reserved = provider === 'claude-code' && Object.hasOwn(Object.prototype, name);
    const available = deliverable && enabled && transport && supported && !reserved;
    rows.set(name, { name, provider, source, kind: kind || (entry.url ? entry.type === 'ws' ? 'ws' : entry.type === 'sse' ? 'sse' : 'http' : 'stdio'), deliverable: available, selectable: externalServerName(name), ...(available ? {} : { reason: reason || (!enabled ? 'disabled-in-provider' : 'unsupported-definition') }), blocked: access[name] === false });
    definitions.set(name, entry);
  }
  if (provider === 'codex') {
    for (const [path, source] of [[join(codexHome || env.CODEX_HOME || join(home, '.codex'), 'config.toml'), 'user'], [join(cwd, '.codex', 'config.toml'), 'project']]) {
      for (const [name, info] of parseCodexMcpServers(read(path, ''))) add(name, info, source, true, null, info.kind);
    }
  } else if (provider === 'opencode') {
    const configDir = env.OPENCODE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode');
    let base = opencodeConfig;
    if (base == null) {
      const docs = readOpencodeConfigDocuments(configDir);
      if (docs.some(row => row.error)) throw Object.assign(new Error('Could not parse an MCP configuration source'), { code: 'MCP_DISCOVERY_FAILED' });
      base = mergedOpencodeConfig(docs);
    }
    for (const [name, entry] of Object.entries(mcpServersOf(base))) add(name, entry, 'user');
    if (env.OPENCODE_CONFIG) for (const [name, entry] of Object.entries(mcpServersOf(document(resolve(env.OPENCODE_CONFIG))))) add(name, entry, 'user-override');
    if (readProject) for (const path of projectOpenCodeConfigs(cwd)) for (const [name, entry] of Object.entries(mcpServersOf(document(path)))) add(name, entry, 'project');
  } else if (provider === 'claude-code') {
    const configDir = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
    const settings = { ...document(join(configDir, 'settings.json')), ...document(join(cwd, '.claude', 'settings.json')), ...document(join(cwd, '.claude', 'settings.local.json')) };
    // Registry entries are a compatibility fallback for FleetView's pre-Phase-2 registry-only servers.
    for (const [name, entry] of Object.entries(object(reg.servers))) if (!entry.builtin) {
      add(name, buildClaudeMcpEntry(entry), 'registry');
    }
    const user = document(env.CLAUDE_CONFIG_DIR ? join(configDir, '.claude.json') : join(home, '.claude.json'));
    for (const [name, entry] of Object.entries(object(user.mcpServers))) add(name, claudeEntry(entry), 'user');
    const disabled = new Set([...(settings.disabledMcpjsonServers || []), ...(claudeProject(user, cwd)?.disabledMcpjsonServers || [])]);
    for (const [name, entry] of Object.entries(object(document(join(cwd, '.mcp.json')).mcpServers))) {
      const approved = !disabled.has(name) && (settings.enableAllProjectMcpServers === true || claudeProject(user, cwd)?.enableAllProjectMcpServers === true || settings.enabledMcpjsonServers?.includes(name) || claudeProject(user, cwd)?.enabledMcpjsonServers?.includes(name));
      add(name, claudeEntry(entry), 'project', !!approved, 'project-not-approved');
    }
    for (const [name, entry] of Object.entries(object(claudeProject(user, cwd)?.mcpServers))) add(name, claudeEntry(entry), 'local');
    const installed = document(join(configDir, 'plugins', 'installed_plugins.json'));
    for (const [key, installs] of Object.entries(object(installed.plugins))) {
      if (settings.enabledPlugins?.[key] === false) continue;
      const install = (Array.isArray(installs) ? installs : [installs]).filter(row => row?.installPath && (!row.projectPath || canonical(row.projectPath) === canonical(cwd))).at(-1);
      if (!install) continue;
      const manifest = document(join(install.installPath, '.claude-plugin', 'plugin.json'));
      if (!manifest.name) continue;
      for (const [name, entry] of Object.entries(claudePluginDefinitions(install.installPath, manifest))) add(`plugin:${manifest.name}:${name}`, claudeEntry(entry), 'plugin');
    }
  }
  if (provider === 'claude-code') {
    const configDir = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
    const user = document(env.CLAUDE_CONFIG_DIR ? join(configDir, '.claude.json') : join(home, '.claude.json'));
    const disabled = new Set([...(user.disabledMcpServers || []), ...(claudeProject(user, cwd)?.disabledMcpServers || [])]);
    for (const name of disabled) if (rows.has(name)) Object.assign(rows.get(name), { deliverable: false, reason: 'disabled-in-provider' });
  }
  const servers = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { provider, servers, definitionFor(name) {
    const definition = definitions.get(name);
    if (!definition) return undefined;
    const entry = structuredClone(definition);
    if (provider === 'claude-code' && dataHome && object(reg.servers)[name] && !entry.url) entry.env = { ...object(entry.env), ...document(join(dataHome, 'data', 'mcp', name, 'env.json')) };
    return entry;
  }, isBlocked(name) { return access[name] === false; } };
}
export function discoverExternalServers(options) { return externalServerInventory(options).servers; }

/** Codex CLI splits paths on literal dots; quoted TOML key syntax is not supported. */
export function codexMcpEnabledOverride(name) {
  if (!name || /[.=\x00-\x1f\x7f]/.test(name)) throw Object.assign(new Error(`Codex cannot disable MCP server ${JSON.stringify(name)} for this run: its CLI override paths do not support dots, equals signs or control characters in server names. Rename the server in Codex configuration before retrying.`), { code: 'MCP_SCOPE_UNENFORCED', status: 400 });
  return `mcp_servers.${name}.enabled`;
}

export function selectExternalServers(tools, inventory) {
  const requested = [...new Set((tools || []).filter(item => item.startsWith('mcp:')))];
  const selected = new Set(), problems = [];
  for (const ref of requested) {
    if (ref === 'mcp:*') { for (const row of inventory.servers) if (row.deliverable && !row.blocked) selected.add(row.name); continue; }
    const name = ref.slice(4), row = inventory.servers.find(row => row.name === name);
    // A names-only cross-provider catalog distinguishes a typo from a server
    // configured on a different provider. Resolve it only for a missing name.
    const known = !row ? (typeof inventory.catalog === 'function' ? inventory.catalog() : inventory.catalog || []).find(item => item.ref === ref) : null;
    const provider = inventory.provider || row?.provider;
    const context = provider ? ` for ${provider}` : '';
    const reason = row?.blocked || known?.blocked || inventory.isBlocked?.(name) === true ? 'blocked'
      : row?.selectable === false || !externalServerName(name) ? 'non-selectable'
        : !row ? known ? 'absent-for-provider' : 'unknown-server' : !row.deliverable ? 'unavailable' : null;
    const hint = reason === 'blocked' ? `${ref} is blocked for workers by the owner's MCP access setting${context}.`
      : reason === 'non-selectable' ? `${ref} cannot be selected by name; external names must start with a letter or digit and contain only letters, digits, dots, underscores, colons or hyphens (at most 64 characters).`
        : reason === 'absent-for-provider' ? `${ref} is not configured${context}. Configure it there or choose a provider where it is available.`
          : reason === 'unknown-server' ? `Unknown external MCP server ${ref}${context}; use an exact, case-sensitive name from tools.servers.`
            : reason === 'unavailable' ? `${ref} is configured${context} but unavailable (${row.reason || 'disabled or unsupported definition'}).` : null;
    if (reason) problems.push({ item: ref, reason, provider: provider || null, hint, suggestions: inventory.servers.filter(row => row.deliverable && !row.blocked && row.selectable !== false && externalServerName(row.name) && row.name.toLowerCase().includes(name.toLowerCase())).map(row => `mcp:${row.name}`).slice(0, 3) });
    else selected.add(name);
  }
  if (problems.length) throw Object.assign(new Error(problems.map(problem => problem.hint).join(' ')), { code: 'TOOLS_INVALID', status: 400, problems });
  return { names: [...selected].sort(), disabled: inventory.servers.filter(row => !selected.has(row.name)).map(row => row.name) };
}
export function externalCatalog(options = {}) {
  const rows = new Map();
  for (const provider of ['codex', 'opencode', 'claude-code']) for (const row of discoverExternalServers({ ...options, provider })) {
    if (!rows.has(row.name)) rows.set(row.name, { ref: `mcp:${row.name}`, label: row.name, selectable: row.selectable, providers: { codex: 'absent', opencode: 'absent', 'claude-code': 'absent' }, blocked: row.blocked });
    rows.get(row.name).providers[provider] = row.blocked ? 'blocked' : row.deliverable ? 'deliverable' : 'unavailable';
  }
  return [...rows.values()].sort((a, b) => a.ref.localeCompare(b.ref));
}
/** Complete validated disabled entries, proved on 2.1.4. No owner env/header/URL payload in the disabled copy. */
export function scopeOpenCodeServers(config, tools, inventory, { node = process.execPath } = {}) {
  const scope = selectExternalServers(tools, inventory);
  const servers = new Map(Object.entries(mcpServersOf(config)));
  for (const row of inventory.servers) servers.set(row.name, scope.names.includes(row.name) ? inventory.definitionFor(row.name) : { type: 'local', command: [node, '-e', 'process.exit(0)'], disabled: true });
  return { scope, config: { ...config, mcp: { ...object(config.mcp), servers: Object.fromEntries(servers) } }, overlay: { mcp: { servers: Object.fromEntries(inventory.servers.filter(row => !scope.names.includes(row.name)).map(row => [row.name, servers.get(row.name)])) } } };
}
/** Secret values go only into the CLI environment; the SDK serializes reference strings into argv. */
export function referenceClaudeMap(mcpServers, baseEnv = {}) {
  const env = {}; let n = 0;
  const reference = value => {
    // Existing references must be expanded by the CLI, which applies its own credential/managed-policy rules.
    if (String(value).includes('${')) return String(value);
    const key = `SYNABUN_MCP_${++n}`;
    env[key] = String(value);
    return '${' + key + '}';
  };
  const map = {};
  for (const [name, definition] of Object.entries(mcpServers)) {
    const entry = structuredClone(definition);
    for (const field of ['env', 'headers']) if (entry[field]) entry[field] = Object.fromEntries(Object.entries(entry[field]).map(([key, value]) => [key, reference(value)]));
    if (entry.headersHelper) entry.headersHelper = reference(entry.headersHelper);
    if (entry.oauth) entry.oauth = Object.fromEntries(Object.entries(entry.oauth).map(([key, value]) => [key, typeof value === 'string' ? reference(value) : value]));
    if (entry.url) entry.url = reference(entry.url);
    if (Array.isArray(entry.args)) entry.args = entry.args.map(reference);
    Object.defineProperty(map, name, { value: entry, enumerable: true, configurable: true, writable: true });
  }
  return { mcpServers: map, env };
}
export function assertClaudeMcpScope(status, names) {
  if (!Array.isArray(status) || status.some(row => !names.includes(row.name)) || names.some(name => !status.some(row => row.name === name))) throw Object.assign(new Error('Claude MCP scope could not be enforced before the first turn'), { code: 'MCP_SCOPE_UNENFORCED' });
}
export function writePrivateMcpConfig(path, mcpServers) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ mcpServers }) + '\n', { mode: 0o600 }); chmodSync(temporary, 0o600); renameSync(temporary, path); chmodSync(path, 0o600);
  return path;
}

/** Keep external grants fixed when an MCP child reports only SynaBun group changes. */
export function retainExternalRefs(groups, previous) {
  return [...new Set([...(groups || []).filter(item => !item.startsWith('mcp:')), ...(previous || []).filter(item => item.startsWith('mcp:'))])];
}
export async function waitForClaudeMcpScope(q, names, { timeoutMs = 30000 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (typeof q.mcpServerStatus !== 'function') break;
    const remaining = end - Date.now(); let timer;
    let rows;
    try { rows = await Promise.race([q.mcpServerStatus(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MCP scope check timed out')), remaining); })]); }
    finally { clearTimeout(timer); }
    if (!Array.isArray(rows) || rows.some(row => !names.includes(row.name))) break;
    if (names.every(name => rows.some(row => row.name === name))) return;
    await new Promise(done => setTimeout(done, Math.min(100, Math.max(0, end - Date.now()))));
  }
  throw Object.assign(new Error('Claude MCP scope could not be enforced before the first turn'), { code: 'MCP_SCOPE_UNENFORCED' });
}
export function redactMcpValues(value, values) {
  if (typeof value === 'string') { for (const secret of [...new Set(values)].filter(Boolean).sort((a, b) => b.length - a.length)) value = value.split(secret).join('[MCP value]'); return value; }
  if (Array.isArray(value)) return value.map(item => redactMcpValues(item, values));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactMcpValues(item, values)]));
  return value;
}

export function mcpDefinitionValues(servers) {
  const strings = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
  return [...new Set(Object.values(servers || {}).flatMap(entry => ['command', 'args', 'cwd', 'env', 'environment', 'headers', 'url', 'oauth', 'headersHelper', 'authToken'].flatMap(field => strings(entry[field]))))].filter(Boolean);
}
