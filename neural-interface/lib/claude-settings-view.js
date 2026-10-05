// ── The Claude Code settings in effect, and where each comes from ──
// The sidepanel's /settings card. The SDK's resolveSettings() (alpha) runs the
// CLI's own merge without starting a process; this turns its answer into rows.
// A settings file can hold secrets (env values, helper commands, headers), so
// a value is shown only when it is a plain scalar of a key that cannot be one:
// everything else is summarised ("3 keys", "set").

const SENSITIVE = /key|token|secret|password|passwd|credential|helper|auth|header|env$/i;
const SOURCE_LABELS = { user: 'your settings', project: 'project settings', local: 'project settings (only you)', managed: 'managed policy', flag: 'session flags' };
const MAX_VALUE = 120;

function preview(key, value) {
  if (value === null || value === undefined) return '';
  if (SENSITIVE.test(key)) return 'set';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') return value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE - 1)}…` : value;
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (typeof value === 'object') {
    // Permissions are worth a closer look, and hold no secrets.
    if (key === 'permissions') {
      const parts = ['allow', 'ask', 'deny'].filter(k => Array.isArray(value[k]) && value[k].length).map(k => `${value[k].length} ${k}`);
      if (typeof value.defaultMode === 'string') parts.unshift(`mode ${value.defaultMode}`);
      return parts.join(', ') || 'empty';
    }
    const n = Object.keys(value).length;
    return `${n} key${n === 1 ? '' : 's'}`;
  }
  return '';
}

/**
 * @param resolved the SDK's ResolvedSettings ({ effective, provenance, sources })
 * @returns {{ rows: [{ key, value, source, path }], sources: [{ source, label, path, keys }] }}
 */
export function slimResolvedSettings(resolved) {
  const r = resolved && typeof resolved === 'object' ? resolved : {};
  const effective = r.effective && typeof r.effective === 'object' ? r.effective : {};
  const provenance = r.provenance && typeof r.provenance === 'object' ? r.provenance : {};
  const rows = Object.keys(effective).sort().slice(0, 200).map((key) => {
    const p = provenance[key] && typeof provenance[key] === 'object' ? provenance[key] : {};
    const source = typeof p.source === 'string' ? p.source : '';
    return { key, value: preview(key, effective[key]), source: SOURCE_LABELS[source] || source, path: typeof p.path === 'string' ? p.path : '' };
  });
  const sources = (Array.isArray(r.sources) ? r.sources : []).map((s) => ({
    source: typeof s?.source === 'string' ? s.source : '',
    label: SOURCE_LABELS[s?.source] || String(s?.source || ''),
    path: typeof s?.path === 'string' ? s.path : '',
    keys: s?.settings && typeof s.settings === 'object' ? Object.keys(s.settings).length : 0,
  })).filter(s => s.source);
  return { rows, sources };
}
