// String caches need a size budget as well as an entry count: streaming
// revisions are different keys and may each hold a nearly complete transcript.
export function createTextCache({ maxEntries = 512, maxChars = 1_000_000, maxEntryChars = 64_000 } = {}) {
  const entries = new Map();
  let chars = 0;
  const drop = key => {
    const value = entries.get(key);
    if (value === undefined) return;
    chars -= key.length + value.length;
    entries.delete(key);
  };
  return {
    get(key) {
      const value = entries.get(key);
      if (value !== undefined) { entries.delete(key); entries.set(key, value); }
      return value;
    },
    set(key, value) {
      drop(key);
      const size = key.length + value.length;
      if (size > Math.min(maxChars, maxEntryChars) || maxEntries < 1) return;
      while (entries.size && (entries.size >= maxEntries || chars + size > maxChars)) drop(entries.keys().next().value);
      entries.set(key, value);
      chars += size;
    },
    clear() { entries.clear(); chars = 0; },
    stats: () => ({ entries: entries.size, chars }),
  };
}
