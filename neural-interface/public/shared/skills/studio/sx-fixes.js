// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio 2.0: what can be done about each health problem
// ═══════════════════════════════════════════
//
// Every health item the Library shows (sx-library.js healthOf), and the few problems only this module finds (two
// library records of one skill, an installation older than the skill's latest version, folders the catalog could not
// read), get a resolution path here:
//   - `auto`: one press, no choice to make, and nothing lost (frontmatter added to a SKILL.md that has none, a
//     description taken from its own first paragraph, a second library record archived: Restore brings it back);
//   - `guided`: a choice the owner makes (which copy to keep, rename or leave, update or keep mine): the panel says
//     what each choice does and opens the place where it is made;
//   - `dismiss`: the owner has seen it and it is fine as it is; kept per item and per problem (its fingerprint), so a
//     problem that changes (another count, another runtime) is said again.
// Writes are never made here: the view (sx-fixes-view.js) sends them through the Studio's API (X-SynaBun-UI), and an
// install location is changed only through the existing install / remove flows. No DOM and no imports but the lint's
// name rule.

import { NAME_MAX } from '../ss-lint.js';

export const DISMISSED_KEY = 'skills-studio-dismissed-issues';

/** Every issue kind, with its default resolution mode (a kind may still be guided for one row: see issuesOf). */
export const ISSUE_KINDS = Object.freeze({
  'not-text': 'guided',
  invalid: 'guided',
  warnings: 'guided',
  update: 'guided',
  shadowed: 'guided',
  twice: 'guided',
  'same-description': 'guided',
  bridge: 'guided',
  'duplicate-record': 'auto',
  'stale-install': 'guided',
  unreadable: 'guided',
});

/** The text rules a safe fix knows how to repair (sx-fixes-view reads the artifact's diagnostics to find them). */
export const TEXT_FIX_RULES = Object.freeze(['fm-missing', 'description-missing']);

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const lower = (v) => (typeof v === 'string' ? v.toLowerCase() : '');

/** What makes one problem of one row itself: a different count or runtime is a different problem. */
export function fingerprintOf(rowKey, h) {
  const detail = h.code === 'invalid' || h.code === 'warnings' ? String(h.count ?? '')
    : h.code === 'shadowed' || h.code === 'twice' ? String(h.runtime || '')
    : h.code === 'same-description' ? (h.names || []).map(lower).sort().join(',')
    : h.code === 'bridge' ? (h.runtimes || []).slice().sort().join(',')
    : h.code === 'duplicate-record' ? String(h.of || '')
    : h.code === 'stale-install' ? String(h.latest || '')
    : h.code === 'unreadable' ? String(h.count ?? '')
    : '';
  return `${rowKey}|${h.code}|${detail}`;
}

/** The dismissed problems, as a set of fingerprints, from what storage kept (anything unreadable is nothing). */
export function readDismissed(raw) {
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return new Set(o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o) : []);
  } catch { return new Set(); }
}

/** Storage text with these fingerprints added (each with when), at most 500 kept (the oldest go first). */
export function addDismissed(raw, fingerprints, now = new Date().toISOString()) {
  let o = {};
  try { const p = typeof raw === 'string' ? JSON.parse(raw) : raw; if (p && typeof p === 'object' && !Array.isArray(p)) o = p; } catch { o = {}; }
  for (const f of fingerprints) o[f] = now;
  const kept = Object.entries(o).sort((a, b) => String(b[1]).localeCompare(String(a[1]))).slice(0, 500);
  return JSON.stringify(Object.fromEntries(kept));
}

/** Storage text without these fingerprints (Show again). */
export function removeDismissed(raw, fingerprints) {
  let o = {};
  try { const p = typeof raw === 'string' ? JSON.parse(raw) : raw; if (p && typeof p === 'object' && !Array.isArray(p)) o = p; } catch { o = {}; }
  for (const f of fingerprints) delete o[f];
  return JSON.stringify(o);
}

const SEVERITY_RANK = { err: 0, warn: 1, info: 2, off: 3, ok: 4 };
const DUP_WEIGHT = 250;
const STALE_WEIGHT = 60;

/** Who keeps the name when two library records hold one skill: installed, adopted, more versions, then the oldest. */
function originalFirst(a, b) {
  const ia = (a.skill.installations || []).length; const ib = (b.skill.installations || []).length;
  if (!!ia !== !!ib) return ib - ia;
  const oa = a.skill.origin?.kind === 'adopted' ? 0 : 1; const ob = b.skill.origin?.kind === 'adopted' ? 0 : 1;
  if (oa !== ob) return oa - ob;
  if ((b.skill.revisions || 0) !== (a.skill.revisions || 0)) return (b.skill.revisions || 0) - (a.skill.revisions || 0);
  return String(a.skill.createdAt || '').localeCompare(String(b.skill.createdAt || '')) || a.key.localeCompare(b.key);
}

/**
 * Library records that are one skill twice (the same name, neither shipped by SynaBun): every record but the one that
 * keeps the name, with `safe` when archiving it loses nothing (not installed, no open review, and no version or the
 * very content of the original's latest). Archived, a record comes back with Restore.
 * @returns {{ row: object, original: object, safe: boolean, why: string }[]}
 */
export function duplicateRecords(rows) {
  const groups = new Map();
  for (const row of rows) {
    const s = row.skill;
    if (!s?.skillId || s.origin?.kind === 'bundled' || !s.name) continue;
    const k = lower(s.name);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(row);
  }
  const out = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const sorted = list.slice().sort(originalFirst);
    const original = sorted[0];
    for (const row of sorted.slice(1)) {
      const s = row.skill;
      const why = (s.installations || []).length ? 'installed'
        : row.review ? 'review'
        : s.revisions && !(s.latest?.contentDigest && s.latest.contentDigest === original.skill.latest?.contentDigest) ? 'different'
        : '';
      out.push({ row, original, safe: !why, why });
    }
  }
  return out;
}

/**
 * The rows with what only this module finds added to their health (a duplicate record, an installation older than the
 * latest version), the dismissed problems taken out, and attention counted again. Returns the same rows (changed).
 * @param {object[]} rows built by sx-library.js buildRows
 * @param {Set<string>} [dismissed] fingerprints
 */
export function applyFixState(rows, dismissed = new Set()) {
  for (const d of duplicateRecords(rows)) {
    if (!d.row.health.some((h) => h.code === 'duplicate-record')) d.row.health.push({ code: 'duplicate-record', sev: 'warn', of: d.original.key, name: d.original.label || d.original.name || '', safe: d.safe, why: d.why });
  }
  for (const row of rows) {
    const s = row.skill;
    const latest = s?.pointers?.latest || s?.latest?.revisionId || null;
    if (latest && s.origin?.kind !== 'bundled' && !row.health.some((h) => h.code === 'stale-install')) {
      const older = (s.installations || []).filter((i) => i.sourceRevisionId && i.sourceRevisionId !== latest);
      if (older.length) row.health.push({ code: 'stale-install', sev: 'info', latest, count: older.length });
    }
    if (dismissed.size) row.health = row.health.filter((h) => h.sev === 'ok' || h.sev === 'off' || !dismissed.has(fingerprintOf(row.key, h)));
    row.health = row.health.filter((h) => h.code !== 'ok');
    if (!row.health.some((h) => h.sev === 'err' || h.sev === 'warn' || h.sev === 'info')) row.health.push({ code: 'ok', sev: 'ok' });
    row.health.sort((a, b) => SEVERITY_RANK[a.sev] - SEVERITY_RANK[b.sev]);
    const extra = row.health.reduce((n, h) => n + (h.code === 'duplicate-record' ? DUP_WEIGHT : h.code === 'stale-install' ? STALE_WEIGHT : 0), 0);
    const base = dismissed.size ? recount(row) : row.attention || 0;
    row.attention = base + extra;
    row.needsAttention = row.attention > 0;
  }
  return rows;
}

// sx-library.js ATTENTION, for a row whose health lost dismissed items.
const ATTENTION = { 'not-text': 1000, invalid: 1000, update: 400, shadowed: 300, twice: 300, 'same-description': 200, bridge: 150, warnings: 100, review: 80, draft: 50 };
function recount(row) {
  return row.health.reduce((n, h) => n + (ATTENTION[h.code] || 0) * (h.code === 'invalid' || h.code === 'warnings' ? Math.max(1, Math.min(9, Number(h.count) || 0)) : 1), 0);
}

/**
 * The issues of one row: each health item that is a problem, with what can be done about it.
 * `can` says what the row allows: `edit` (its text can be changed here), `open` (it has a workspace), `archive` (the
 * duplicate's record can leave the library), `dismiss` (not a guest).
 * Actions: 'auto-text' (repair the text: which rules is learnt from the artifact's diagnostics), 'archive-duplicate',
 * 'choose-copy', 'open-edit', 'open-publish', 'open-update', 'keep-mine', 'open-review', 'move-bridges',
 * 'rescan', 'delete', 'dismiss'.
 * @returns {{ code: string, sev: string, mode: 'auto'|'guided', fingerprint: string, health: object, actions: string[] }[]}
 */
export function issuesOf(row, can = {}) {
  const out = [];
  for (const h of row.health || []) {
    if (!(h.code in ISSUE_KINDS)) continue;
    const actions = [];
    let mode = ISSUE_KINDS[h.code];
    switch (h.code) {
      case 'not-text':
        if (can.open) actions.push('open-edit');
        if (can.delete) actions.push('delete');
        break;
      case 'invalid':
      case 'warnings':
        // Whether a repair is safe is known once the text is read (the panel asks): until then it is guided.
        if (can.edit) actions.push('auto-text');
        if (can.open) actions.push('open-edit');
        break;
      case 'update':
        if (can.open) actions.push('open-update', 'keep-mine');
        break;
      case 'shadowed':
      case 'twice':
      case 'same-description':
        if (can.open) actions.push('open-edit');
        break;
      case 'bridge':
        if (can.dismiss) actions.push('move-bridges');
        break;
      case 'duplicate-record':
        if (!h.safe) mode = 'guided';
        if (can.archive) actions.push(h.safe ? 'archive-duplicate' : 'choose-copy');
        if (can.open) actions.push('open-edit');
        break;
      case 'stale-install':
        if (can.open) actions.push('open-publish');
        break;
      default: break;
    }
    if (can.dismiss) actions.push('dismiss');
    out.push({ code: h.code, sev: h.sev, mode, fingerprint: fingerprintOf(row.key, h), health: h, actions });
  }
  return out;
}

// ── Text repairs ──

const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f­؜᠎​-‏‪-‮⁠-⁤⁦-⁯﻿]/g;

/**
 * A description taken from a body's first paragraph of prose (not a heading, a list, a table, a quote or code),
 * markdown marks removed, on one line, at most 280 characters cut at a word; null when there is none of 20 or more.
 */
export function descriptionFromBody(body) {
  const lines = String(body || '').replace(/\r\n?/g, '\n').split('\n');
  let inCode = false;
  let para = [];
  for (const line of lines) {
    const tr = line.trim();
    if (/^(```|~~~)/.test(tr)) { inCode = !inCode; if (para.length) break; continue; }
    if (inCode) continue;
    if (!tr) { if (para.length) break; continue; }
    if (/^(#|[-*+]\s|\d+[.)]\s|\||>|<|---|===)/.test(tr)) { if (para.length) break; continue; }
    para.push(tr);
  }
  let text = para.join(' ')
    .replace(INVISIBLE, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|`)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < 20) return null;
  if (text.length > 280) {
    const cut = text.slice(0, 280);
    const sentence = cut.lastIndexOf('. ');
    text = sentence >= 120 ? cut.slice(0, sentence + 1) : `${cut.slice(0, cut.lastIndexOf(' ') > 200 ? cut.lastIndexOf(' ') : 280).trimEnd()}…`;
  }
  return text;
}

/** A YAML scalar that reads back as exactly this text (a JSON string is a YAML double-quoted scalar). */
const yamlString = (s) => JSON.stringify(String(s));

/**
 * The safe repair of a skill's or an agent's head file, from the problems its check found: frontmatter added to a file
 * that has none (name from the folder when it is a valid name, description from its first paragraph), or a description
 * added to frontmatter that lacks one. Line endings and a BOM are kept; nothing else changes. null when there is
 * nothing safe to do (an agent needs both a name and a description; a description that cannot be taken from the text).
 * @param {object} o
 * @param {string} o.raw the file as read
 * @param {{ ruleId: string }[]} o.diagnostics what the server's check said (GET artifact `diagnostics`)
 * @param {'skill'|'agent'|'command'} o.type
 * @param {string} [o.folderName]
 * @returns {{ text: string, changes: { ruleId: string, added: string }[] } | null}
 */
export function planTextFix({ raw, diagnostics = [], type, folderName = '' }) {
  if (typeof raw !== 'string' || type === 'command') return null;
  const rules = new Set((diagnostics || []).map((d) => d?.ruleId));
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const bom = raw.startsWith('﻿') ? '﻿' : '';
  const text = bom ? raw.slice(1) : raw;
  if (rules.has('fm-missing')) {
    if (/^---[ \t]*\r?\n/.test(text)) return null;   // an unterminated block is the owner's to read
    const name = NAME_RE.test(folderName) && folderName.length <= NAME_MAX ? folderName : '';
    const description = descriptionFromBody(text);
    if (type === 'agent' && (!name || !description)) return null;
    if (!name && !description) return null;
    const lines = ['---', ...(name ? [`name: ${name}`] : []), ...(description ? [`description: ${yamlString(description)}`] : []), '---', ''];
    const changes = [];
    if (name) changes.push({ ruleId: 'fm-missing', added: `name: ${name}` });
    if (description) changes.push({ ruleId: 'fm-missing', added: `description: ${yamlString(description)}` });
    return { text: `${bom}${lines.join(eol)}${text}`, changes };
  }
  if (rules.has('description-missing') && type === 'skill') {
    const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
    if (!m) return null;
    const head = m[1];
    if (/^description\s*:/m.test(head)) return null;   // present but empty or of another type: the owner's to word
    const body = text.slice(m[0].length);
    const description = descriptionFromBody(body);
    if (!description) return null;
    const line = `description: ${yamlString(description)}`;
    const headLines = head.split(/\r?\n/);
    const at = headLines.findIndex((l) => /^name\s*:/.test(l));
    headLines.splice(at >= 0 ? at + 1 : 0, 0, line);
    const start = m[0].slice(0, m[0].indexOf('\n') + 1);
    const close = m[0].slice(m[0].lastIndexOf(head) + head.length);
    return { text: `${bom}${start}${headLines.join(eol)}${close}${body}`, changes: [{ ruleId: 'description-missing', added: line }] };
  }
  return null;
}

/**
 * What "Fix all safe issues" would do, before it is done: one step per change, with the rows it skips and why.
 * Text repairs are candidates until their file is read (`needsRead`), so the preview reads them first.
 * @param {object[]} rows
 * @param {(row: object) => object} canOf what each row allows (as for issuesOf)
 * @returns {{ steps: { kind: 'text'|'archive', row: object, issue: object }[] }}
 */
export function safeFixCandidates(rows, canOf) {
  const steps = [];
  for (const row of rows) {
    const can = canOf(row);
    for (const issue of issuesOf(row, can)) {
      if (issue.actions.includes('archive-duplicate')) steps.push({ kind: 'archive', row, issue });
      else if (issue.actions.includes('auto-text') && !steps.some((s) => s.kind === 'text' && s.row === row)) steps.push({ kind: 'text', row, issue, needsRead: true });
    }
  }
  return { steps };
}

/** How many issues the Library shows now, and how many of them have a one-press fix (text repairs not yet known). */
export function issueCounts(rows, canOf) {
  let total = 0; let auto = 0;
  for (const row of rows) for (const issue of issuesOf(row, canOf(row))) { total++; if (issue.actions.includes('archive-duplicate')) auto++; }
  return { total, auto };
}
