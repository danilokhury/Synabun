// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio: the user's own presets
// ═══════════════════════════════════════════
//
// Custom presets are kept in the server-synced UI state and can come from a file someone handed over. Nothing
// of such a file is trusted as written: every preset is checked field by field (text where text belongs, within
// bounds), its id is made here and never taken from the file, and a list read back from storage is checked the
// same way (an id that is not one of ours is replaced, so markup built from it cannot carry anything else).
// No DOM and no imports.

export const PRESET_LIMITS = Object.freeze({
  maxPresets: 500,
  maxName: 120,
  maxDescription: 500,
  maxSnippet: 64 * 1024,
  maxImportBytes: 8 * 1024 * 1024,
});

export const PRESET_FORMAT = 'synabun-presets-v1';
export const PRESET_TYPES = Object.freeze(['skill', 'command', 'agent']);

/** An id this module made: safe in an attribute, a selector or a URL as it is. */
export const PRESET_ID_RE = /^custom-[a-z0-9]{1,32}(?:-[a-z0-9]{1,16})?$/;

/** A fresh id. `random` is handed in so tests can fix it. */
export function newPresetId(now = Date.now(), random = Math.random) {
  const stamp = Math.max(0, Math.floor(Number(now) || 0)).toString(36);
  const tail = Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0').slice(0, 6);
  return `custom-${stamp}-${tail}`;
}

const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);

/**
 * One preset as it may be kept, or null when it is not one.
 * @param {any} input
 * @param {{ keepId?: boolean, idFor?: () => string }} [o] `keepId`: keep an id that is already ours (a stored
 *   preset); an imported one always gets a new id
 */
export function sanitizePreset(input, { keepId = false, idFor = () => newPresetId() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const name = text(input.name, PRESET_LIMITS.maxName);
  const snippet = typeof input.snippet === 'string' && input.snippet.length <= PRESET_LIMITS.maxSnippet ? input.snippet : null;
  if (!name || !name.trim() || !snippet || !snippet.trim()) return null;
  const description = text(input.description, PRESET_LIMITS.maxDescription) || '';
  const types = Array.isArray(input.types) ? [...new Set(input.types.filter((t) => PRESET_TYPES.includes(t)))] : [];
  const id = keepId && typeof input.id === 'string' && PRESET_ID_RE.test(input.id) ? input.id : idFor();
  const preset = { id, name: name.trim(), description, snippet, category: 'custom', types };
  if (typeof input.educationalNote === 'string') preset.educationalNote = input.educationalNote.slice(0, PRESET_LIMITS.maxDescription);
  return preset;
}

/**
 * The presets kept in storage, checked: what is not a preset is left out, an id that is not ours is replaced
 * (and two presets never share one). `changed` says the stored list should be written back.
 * @param {string | null} stored the raw value from storage
 * @returns {{ presets: object[], changed: boolean, dropped: number }}
 */
export function readStoredPresets(stored, { idFor = () => newPresetId() } = {}) {
  let parsed;
  try { parsed = stored ? JSON.parse(stored) : []; } catch { return { presets: [], changed: !!stored, dropped: 0 }; }
  if (!Array.isArray(parsed)) return { presets: [], changed: true, dropped: 0 };
  const presets = [];
  const ids = new Set();
  let changed = false;
  let dropped = 0;
  for (const item of parsed.slice(0, PRESET_LIMITS.maxPresets)) {
    let preset = sanitizePreset(item, { keepId: true, idFor });
    if (!preset) { dropped++; changed = true; continue; }
    if (ids.has(preset.id)) preset = { ...preset, id: uniqueId(ids, idFor) };
    if (preset.id !== item.id || JSON.stringify(preset) !== JSON.stringify(item)) changed = true;
    ids.add(preset.id);
    presets.push(preset);
  }
  if (parsed.length > PRESET_LIMITS.maxPresets) { changed = true; dropped += parsed.length - PRESET_LIMITS.maxPresets; }
  return { presets, changed, dropped };
}

function uniqueId(ids, idFor) {
  for (let i = 0; i < 20; i++) {
    const id = idFor();
    if (!ids.has(id) && PRESET_ID_RE.test(id)) return id;
  }
  // idFor kept answering ids in use: count up from one that is ours.
  let n = ids.size;
  while (ids.has(`custom-x-${n.toString(36)}`)) n++;
  return `custom-x-${n.toString(36)}`;
}

/**
 * Presets from an exported file, added to the user's own. Each gets a new id; one that has the name and the
 * snippet of a preset already there (or earlier in the file) is skipped.
 * @param {object[]} existing the stored presets (already checked)
 * @param {any} bundle the parsed file
 * @returns {{ ok: boolean, presets: object[], imported: number, skipped: number, error?: string }}
 */
export function importPresets(existing, bundle, { idFor = () => newPresetId() } = {}) {
  const current = Array.isArray(existing) ? existing.slice() : [];
  if (!bundle || typeof bundle !== 'object' || bundle.format !== PRESET_FORMAT || !Array.isArray(bundle.presets)) {
    return { ok: false, presets: current, imported: 0, skipped: 0, error: 'Not a SynaBun preset file.' };
  }
  const ids = new Set(current.map((p) => p.id));
  const seen = new Set(current.map((p) => `${p.name}\u0000${p.snippet}`));
  let imported = 0; let skipped = 0;
  for (const item of bundle.presets) {
    if (current.length >= PRESET_LIMITS.maxPresets) { skipped++; continue; }
    const preset = sanitizePreset(item, { keepId: false, idFor: () => uniqueId(ids, idFor) });
    if (!preset) { skipped++; continue; }
    const key = `${preset.name}\u0000${preset.snippet}`;
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    ids.add(preset.id);
    current.push(preset);
    imported++;
  }
  return { ok: true, presets: current, imported, skipped };
}
