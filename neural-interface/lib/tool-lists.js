// Neural Interface's storage boundary. Catalog and resolution belong to mcp-server.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseToolList, resolveToolList, serializeToolList } from '../../mcp-server/dist/services/tool-list.js';

export function requireToolList(result) {
  if (!result.ok) throw Object.assign(new Error(result.message), result, { status: 400 });
  return result;
}

// Run 1 treats a blank environment variable/header as absent. The accepted always-on id
// carries an explicit empty selection across those transports without falling back to all.
export function runtimeToolsValue(items) {
  return serializeToolList(items) || 'memory';
}

/** null is inherited; [] is an explicit selection of always-on tools only. */
export function storedToolList(record, { customPresets = null } = {}) {
  if (!record || typeof record !== 'object') return null;
  if (record.tools !== undefined && record.tools !== null) {
    if (!Array.isArray(record.tools)) throw Object.assign(new Error('tools must be an array'), { code: 'TOOLS_INVALID', status: 400 });
    return requireToolList(resolveToolList(requireToolList(parseToolList(record.tools)).items, { source: 'runtime' })).items;
  }
  const legacy = record.mcpProfile;
  if (legacy === undefined || legacy === null || legacy === '') return null;
  if (typeof legacy !== 'string') throw Object.assign(new Error('mcpProfile must be a string'), { code: 'TOOLS_INVALID', status: 400 });
  if (!legacy.trim()) return null;
  const parsed = requireToolList(parseToolList(legacy, { legacy: true, customPresets }));
  return requireToolList(resolveToolList([...parsed.items, 'mcp:*'], { source: 'runtime' })).items;
}

/** Disk records written before external scoping inherited their provider's servers, even with an empty group list. */
export function readStoredToolListRecord(record, options) {
  const tools = storedToolList(record, options);
  const migrated = tools !== null && record.externalMcpVersion !== 2 && !tools.some(item => item.startsWith('mcp:'))
    ? [...tools, 'mcp:*'] : tools;
  return toolListRecord({ ...record, ...(migrated === null ? {} : { tools: migrated }) }, options);
}

export function automationPlatform(schedule, group, template) {
  for (const record of [template, schedule, group]) if (record?.platform) return record.platform;
  for (const record of [schedule, group, template]) {
    if (typeof record?.mcpProfile !== 'string') continue;
    const parsed = parseToolList(record.mcpProfile, { legacy: true });
    if (parsed.ok && parsed.platform) return parsed.platform;
  }
  const id = String(schedule?.templateId || template?.id || schedule?.id || '');
  if (/^(cpfb_|fbdeals_)/.test(id)) return 'facebook';
  if (/^cp_/.test(id)) return 'twitter';
  return null;
}

/** A copy for persistence: never rewrite a source record just because it was read. */
export function toolListRecord(record, options) {
  const next = { ...record, externalMcpVersion: 2 };
  const tools = storedToolList(record, options);
  const platform = automationPlatform(record);
  if (tools === null) delete next.tools;
  else next.tools = tools;
  if (platform) next.platform = platform;
  delete next.mcpProfile;
  return next;
}

/** An unrelated edit must not persist a read-time external-scope migration. */
export function toolListRecordForUpdate(record, previous, options) {
  const next = toolListRecord(record, options);
  if (!previous || previous.mcpProfile != null) return next;
  const before = storedToolList(readStoredToolListRecord(previous, options), options);
  if (serializeToolList(next.tools ?? []) !== serializeToolList(before ?? [])
      || (next.tools == null) !== (before == null)) return next;
  // Keep the exact stored representation, including absent/null, legacy [] and version metadata.
  for (const key of ['tools', 'externalMcpVersion']) {
    delete next[key];
    if (Object.hasOwn(previous, key)) next[key] = Array.isArray(previous[key]) ? [...previous[key]] : previous[key];
  }
  return next;
}

/** Apply an array patch while preserving stored legacy platform hints. */
export function applyStoredToolList(record, patch, options) {
  if (patch.tools === undefined) return record;
  const source = { ...record, ...patch, platform: patch.platform || automationPlatform(record) };
  delete source.mcpProfile;
  const next = toolListRecord(source, options);
  delete record.mcpProfile;
  delete record.tools;
  if (next.tools !== undefined) record.tools = next.tools;
  if (next.platform) record.platform = next.platform;
  return record;
}

export function resolveStoredTools(record, context = {}, options) {
  const stored = storedToolList(record, options);
  return requireToolList(resolveToolList(stored ?? undefined, { source: 'launch', usesBrowser: record?.usesBrowser, taskClass: record?.taskClass, ...context }));
}

export function readDefaultTools(dataHome, options) {
  const path = resolve(dataHome, 'data', 'default-tools.json');
  if (existsSync(path)) {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(record.tools)) throw Object.assign(new Error('Default tools must be an array'), { code: 'TOOLS_INVALID', status: 400 });
    return storedToolList(readStoredToolListRecord(record, options), options);
  }
  for (const dir of ['mcp-data', 'data']) {
    const legacyPath = resolve(dataHome, dir, 'active-profile.json');
    if (!existsSync(legacyPath)) continue;
    const record = JSON.parse(readFileSync(legacyPath, 'utf8'));
    const tools = storedToolList({ mcpProfile: record.profile }, options);
    if (tools !== null) return tools;
  }
  return ['all', 'mcp:*'];
}

export function writeDefaultTools(dataHome, tools) {
  const items = storedToolList({ tools });
  if (items === null) throw Object.assign(new Error('tools must be an array'), { code: 'TOOLS_INVALID', status: 400 });
  const path = resolve(dataHome, 'data', 'default-tools.json');
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ tools: items, externalMcpVersion: 2, updatedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
  return items;
}
