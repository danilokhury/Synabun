import { externalCatalog, selectExternalServers } from '../neural-interface/lib/mcp-external-servers.js';
// Loaded only by `synabun tools`; setup can still run before MCP dist exists.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { toolCatalogView } from '../mcp-server/dist/services/tool-catalog.js';
import { parseToolList, resolveToolList } from '../mcp-server/dist/services/tool-list.js';
import { readDefaultTools, requireToolList, writeDefaultTools } from '../neural-interface/lib/tool-lists.js';

export function runToolsCommand(args = [], { dataHome, externalContext = {}, log = console.log, error = console.error } = {}) {
  const [action = 'list', ...values] = args;
  try {
    if (action === 'list' && !values.length) {
      const catalog = toolCatalogView();
      log(`Always on: ${catalog.alwaysOnTools.join(', ')} (${catalog.alwaysOn})`);
      for (const group of catalog.groups) log(`${group.id.padEnd(20)} ${String(group.count).padStart(2)}  ${group.purpose}`);
      log(`Host effect: ${Object.entries(catalog.effect).map(([host, effect]) => `${host} ${effect}`).join('; ')}.`);
      log('Usage: synabun tools [list | get | set <ids>]. Use comma-separated ids, all, or [] for always-on only.');
      return 0;
    }
    if (action === 'get' && !values.length) {
      let customPresets = null;
      try { customPresets = JSON.parse(readFileSync(resolve(dataHome, 'data/mcp-registry.json'), 'utf8')).profiles; } catch {}
      const tools = readDefaultTools(dataHome, { customPresets });
      const selected = requireToolList(resolveToolList(tools, { source: 'runtime' }));
      log(JSON.stringify({ tools, groups: selected.groups, count: selected.count, effect: toolCatalogView().effect }));
      return 0;
    }
    if (action === 'set' && values.length) {
      const raw = values.join(',');
      const items = requireToolList(parseToolList(raw === '[]' ? [] : raw)).items;
      requireToolList(resolveToolList(items, { source: 'runtime' }));
      if (items.some(item => item.startsWith('mcp:') && item !== 'mcp:*')) {
        const servers = externalCatalog({ dataHome, ...externalContext }).map(row => ({ name: row.ref.slice(4), blocked: row.blocked, deliverable: Object.values(row.providers).includes('deliverable') }));
        selectExternalServers(items, { servers });
      }
      const tools = writeDefaultTools(dataHome, items);
      log(`Default tools: ${JSON.stringify(tools)}. Applies to future runtimes; running sessions keep their own list.`);
      return 0;
    }
    throw new Error('Usage: synabun tools [list | get | set <ids>]');
  } catch (err) {
    error(`${err.code ? `${err.code}: ` : ''}${err.message}`);
    return 1;
  }
}
