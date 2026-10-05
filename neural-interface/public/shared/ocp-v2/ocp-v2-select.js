// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — <select> options from data
// Project names and branch names come from the filesystem and from git: a
// directory can be called `<img src=x onerror=…>`. They are never written into
// markup; every option is an element whose label is set as text.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replace the options of `select` with `rows` ({ value, label }), after an
 * optional placeholder option. Returns the option elements.
 */
export function setSelectOptions(select, rows, { placeholder = null } = {}) {
  if (!select) return [];
  const doc = select.ownerDocument || document;
  const make = (value, label) => {
    const option = doc.createElement('option');
    option.value = String(value ?? '');
    option.textContent = String(label ?? '');
    return option;
  };
  const options = [];
  if (placeholder != null) options.push(make('', placeholder));
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row == null) continue;
    const value = typeof row === 'object' ? row.value : row;
    const label = typeof row === 'object' ? (row.label ?? row.value) : row;
    options.push(make(value, label));
  }
  select.replaceChildren(...options);
  return options;
}

/** `{ value: path, label: basename }` rows for the project picker. */
export function projectOptionRows(projects) {
  return (Array.isArray(projects) ? projects : [])
    .map((p) => {
      const path = String((p && typeof p === 'object' ? p.path : p) || '');
      const name = path.split(/[\\/]/).filter(Boolean).pop() || path;
      return { value: path, label: name };
    })
    .filter((row) => row.value);
}
