// Read-only legacy conversion uses the server's one catalog, including custom saved names.
// Failed conversion leaves the old preference intact so it can be retried after a server update.
export async function migrateStoredTools(storage, key, legacyKey, { entry, fetcher = globalThis.fetch } = {}) {
  let current;
  try { current = JSON.parse(storage.getItem(key) || 'null'); } catch { current = null; }
  const value = entry == null ? current : current?.[entry];
  if (Array.isArray(value)) return value;
  let old = storage.getItem(legacyKey);
  if (entry != null) { try { old = JSON.parse(old || '{}')[entry]; } catch { old = null; } }
  if (typeof old !== 'string' || !old.trim()) return null;
  try {
    const response = await fetcher('/api/mcp/tools/convert', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: old }) });
    const result = await response.json();
    if (!response.ok || !result.ok || !Array.isArray(result.tools)) return null;
    const tools = result.tools;
    // A picker may have saved while the conversion was awaiting its reply; never overwrite it.
    let latest;
    try { latest = JSON.parse(storage.getItem(key) || 'null'); } catch { latest = null; }
    const saved = entry == null ? latest : latest?.[entry];
    if (Array.isArray(saved)) return saved;
    storage.setItem(key, JSON.stringify(entry == null ? tools : { ...latest, [entry]: tools }));
    return tools;
  } catch { return null; }
}
