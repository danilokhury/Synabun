// ═══════════════════════════════════════════
// SynaBun Neural Interface — Agents Studio: what changed, and what an agent may do
// ═══════════════════════════════════════════
//
// The registry compares two revisions (GET /agents/:id/diff): `changes` field by field, the instructions also line
// by line, and `privileges` (what the newer one may do that the older may not). This module turns that answer into
// what the Review queue, the Revisions tab and the approval's summary draw: rows with both values as text, the
// instructions as hunks (the unchanged middle folded), and the privilege summary of a definition with what differs
// from the last approved revision marked. Whether a change widens what the agent may do is the server's word
// (`escalates`); the page never decides it.
// No DOM and no imports.

/** The privilege fields, in the order a review reads them. */
export const PRIVILEGE_FIELDS = Object.freeze(['capability', 'permissionPolicy', 'tools', 'mcpServers', 'usesBrowser', 'moreloginProfile', 'usesComputer', 'skills', 'scope']);

const isList = (value) => Array.isArray(value);

/**
 * A field's value as text. `words` gives the page's words: `{ yes, no, none, defaultTools, allTools, allServers,
 * global, capability(level), policy(id), taskClass(id), provider(id) }`; without it, plain values.
 */
export function valueText(field, value, words = {}) {
  const none = words.none ?? '—';
  if (field === 'tools') {
    if (value === null || value === undefined) return words.defaultTools ?? 'default';
    if (!value.length) return words.alwaysOn ?? none;
    return value.includes('all') ? (words.allTools ?? 'all') : value.join(', ');
  }
  if (field === 'mcpServers') {
    if (!isList(value) || !value.length) return none;
    return value.includes('*') ? (words.allServers ?? '*') : value.join(', ');
  }
  if (field === 'scope') {
    const kind = typeof value === 'string' ? value : value?.kind;
    if (kind === 'project') return typeof value === 'object' && value?.path ? value.path : (words.project ?? 'project');
    return kind ? (words.global ?? 'global') : none;
  }
  if (value === true) return words.yes ?? 'yes';
  if (value === false) return words.no ?? 'no';
  if (value === null || value === undefined || value === '') return none;
  if (isList(value)) {
    if (!value.length) return none;
    return (field === 'taskClasses' && words.taskClass ? value.map(words.taskClass) : value).join(', ');
  }
  if (field === 'capability' && words.capability) return words.capability(value);
  if (field === 'permissionPolicy' && words.policy) return words.policy(value);
  if (field === 'provider' && words.provider) return words.provider(value);
  return String(value);
}

/** For a list field: what was added and what was taken out (`null` lists count as empty). */
export function listDelta(from, to) {
  const a = isList(from) ? from : [];
  const b = isList(to) ? to : [];
  return { added: b.filter((item) => !a.includes(item)), removed: a.filter((item) => !b.includes(item)) };
}

/**
 * The rows of a diff: `{ field, kind, from, to, added, removed }` with `kind` one of `instructions` (drawn as
 * hunks), `list` (added / removed items), `value`. The instructions come last: they are the long part.
 */
export function diffRows(diff, words = {}) {
  const changes = Array.isArray(diff?.changes) ? diff.changes : [];
  const rows = changes.map((change) => {
    if (change.field === 'instructions') {
      return { field: 'instructions', kind: 'instructions', lines: Array.isArray(change.lines) ? change.lines : null, added: change.added ?? null, removed: change.removed ?? null, from: change.from ?? '', to: change.to ?? '' };
    }
    const lists = isList(change.from) || isList(change.to);
    const delta = lists && change.field !== 'tools' ? listDelta(change.from, change.to) : null;
    return { field: change.field, kind: delta ? 'list' : 'value', from: valueText(change.field, change.from, words), to: valueText(change.field, change.to, words), added: delta?.added || [], removed: delta?.removed || [] };
  });
  return [...rows.filter((row) => row.kind !== 'instructions'), ...rows.filter((row) => row.kind === 'instructions')];
}

/**
 * A line diff (`[{ op: ' ' | '+' | '-', line }]`) as what is drawn: changed lines with `context` unchanged lines
 * around them, the rest folded into `{ gap: n }`. Lines carry their numbers on each side.
 */
export function hunksOf(lines, context = 2) {
  const rows = Array.isArray(lines) ? lines : [];
  let oldNo = 0;
  let newNo = 0;
  const numbered = rows.map((row) => {
    const op = row?.op === '+' || row?.op === '-' ? row.op : ' ';
    if (op !== '+') oldNo += 1;
    if (op !== '-') newNo += 1;
    return { op, line: String(row?.line ?? ''), oldNo: op === '+' ? null : oldNo, newNo: op === '-' ? null : newNo };
  });
  const keep = new Array(numbered.length).fill(false);
  numbered.forEach((row, i) => {
    if (row.op === ' ') return;
    for (let k = Math.max(0, i - context); k <= Math.min(numbered.length - 1, i + context); k += 1) keep[k] = true;
  });
  const out = [];
  let gap = 0;
  numbered.forEach((row, i) => {
    if (keep[i]) { if (gap) { out.push({ gap }); gap = 0; } out.push(row); } else gap += 1;
  });
  if (gap) out.push({ gap });
  return out;
}

/** What a definition lets its worker do, as rows (the contract's privilegesOf, read from the definition itself). */
export function privilegeRows(definition, words = {}) {
  const d = definition && typeof definition === 'object' ? definition : {};
  return PRIVILEGE_FIELDS.map((field) => {
    const value = field === 'scope' ? d.scope : d[field];
    return { field, value: value ?? null, text: valueText(field, value, words) };
  });
}

/**
 * The privilege summary before an approval: every row of `definition`, with `changed` where it differs from
 * `approved` (the last approved revision; null for a first revision, where every row that grants something is new)
 * and `escalates` where the server's privilege delta says the change widens what the agent may do.
 * @param {object} definition the revision being approved
 * @param {object|null} approved
 * @param {{ changes?: { field: string, escalates: boolean }[] }|null} [delta] the diff's `privileges`
 */
export function privilegeSummary(definition, approved = null, delta = null, words = {}) {
  const now = privilegeRows(definition, words);
  const before = approved ? privilegeRows(approved, words) : null;
  const wider = new Map((Array.isArray(delta?.changes) ? delta.changes : []).map((change) => [change.field, change.escalates === true]));
  return now.map((row, i) => {
    const was = before ? before[i] : null;
    const changed = before ? JSON.stringify(was.value ?? null) !== JSON.stringify(row.value ?? null) : false;
    return { ...row, changed, was: changed ? was.text : null, escalates: wider.get(row.field) === true, first: !before };
  });
}

/** The server's privilege delta as rows: `{ field, from, to, escalates }` with both values as text. */
export function privilegeChanges(delta, words = {}) {
  return (Array.isArray(delta?.changes) ? delta.changes : []).map((change) => ({
    field: change.field, from: valueText(change.field, change.from, words), to: valueText(change.field, change.to, words), escalates: change.escalates === true,
  }));
}

/** One line for a diff's size: `{ fields, added, removed }`. */
export function diffSize(diff) {
  const changes = Array.isArray(diff?.changes) ? diff.changes : [];
  const text = changes.find((change) => change.field === 'instructions');
  return { fields: changes.length, added: text?.added ?? 0, removed: text?.removed ?? 0 };
}
