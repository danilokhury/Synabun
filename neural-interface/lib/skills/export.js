// ── What an install writes for one runtime ──
// The export of a revision for a target is the revision's folder, byte for byte, unless the target would let the
// skill be started more freely than its author said (public/shared/skills/ss-profiles.js invocationPlan): then the
// one setting that keeps it as meant is added to the export, and only to the export (the source revision is never
// rewritten). Each change is listed (`transforms`) and the export has its own digest: what is installed, and what
// a plan was approved for, is exactly those bytes.
//   - Claude Code: `disable-model-invocation: true` / `user-invocable: false` in SKILL.md (that key only);
//   - Codex: `policy.allow_implicit_invocation: false` in agents/openai.yaml (made when there is none; otherwise
//     that one value is set and every other value, comment and order is kept);
//   - OpenCode: metadata `opencode/autoinvoke: "false"` in SKILL.md (the metadata key only).
// A Codex export also carries the harness metadata Codex shows in its skill picker (agents/openai.yaml
// `interface`: display_name, short_description, default_prompt, from the skill's own name and description; the
// 02-standards-runtimes report, §6.3). A sidecar that is already there keeps every value it has: only the interface
// keys it lacks are added (`sidecarInterface` transform), and one that cannot be parsed is left as it is, with a
// warning. Codex 0.164.0 reads those keys back in skills/list (displayName, shortDescription, defaultPrompt).

import * as YAML from 'yaml';
import { frontmatter } from './frontmatter.js';
import { folderDigest } from './library.js';
import { fromEditing, toEditing } from '../../public/shared/skills/ss-doc.js';
import { CODEX_SIDECAR, getProfile, invocationPlan, readInvocationIntent } from '../../public/shared/skills/ss-profiles.js';

const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The Codex picker's words for a skill, from its frontmatter: `{ display_name, short_description, default_prompt }`. */
export function codexInterfaceFor(data) {
  const name = String(data?.name || '').trim();
  const description = String(data?.description || '').replace(/\s+/g, ' ').trim();
  const display = name.split(/[-_\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ').slice(0, 64).trim();
  const short = clip(description.split(/(?<=[.!?])\s/)[0] || description, 64);
  const first = description.split(/(?<=[.!?])\s/)[0] || '';
  const lead = first ? first[0].toLowerCase() + first.slice(1) : '';
  const prompt = name ? clip(`Use $${name}${lead ? `: ${lead}` : ''}`, 1024) : '';
  const out = {};
  if (display) out.display_name = display;
  if (short) out.short_description = short;
  if (prompt) out.default_prompt = prompt;
  return out;
}

/** A text cut at a word boundary to `max` characters, with an ellipsis when it was cut. */
function clip(text, max) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > max / 2 ? cut.slice(0, at) : cut).trim()}…`;
}

/**
 * The export's agents/openai.yaml with the interface keys Codex shows, added only where they are missing: the file
 * made when there is none, every present value kept, nothing else of the file touched. Returns `{ files, dirs,
 * transform, diagnostic }` (one of the last two set).
 */
export function withCodexInterface(files, dirs, data) {
  const wanted = codexInterfaceFor(data);
  if (!Object.keys(wanted).length) return { files, dirs, transform: null, diagnostic: null };
  const sidecar = readSidecar(files);
  const transform = (keys, created) => ({ file: CODEX_SIDECAR, op: 'sidecar-interface', keys, created, reason: `Gives Codex the words it shows for this skill (${keys.join(', ')}), from its name and description.` });
  if (!sidecar.present) {
    const text = YAML.stringify({ interface: wanted });
    return { files: [...files, { path: CODEX_SIDECAR, bytes: Buffer.from(text, 'utf-8'), executable: false }], dirs: [...new Set([...dirs, 'agents'])], transform: transform(Object.keys(wanted), true), diagnostic: null };
  }
  if (sidecar.error) return { files, dirs, transform: null, diagnostic: { ruleId: 'L-09-sidecar-kept', severity: 'warning', message: `${CODEX_SIDECAR} cannot be read (${sidecar.error}): kept as it is; Codex shows the skill without its picker words.`, file: CODEX_SIDECAR, line: null } };
  const kept = (why) => ({ files, dirs, transform: null, diagnostic: { ruleId: 'L-09-sidecar-kept', severity: 'warning', message: `${CODEX_SIDECAR} ${why}: kept as it is; Codex shows the skill without its picker words.`, file: CODEX_SIDECAR, line: null } });
  // Valid YAML that is not a map (a scalar, a list), or an `interface` that is not a map (null, a string, a list):
  // nothing can be added to it without changing what the author wrote.
  if (sidecar.data !== null && sidecar.data !== undefined && !isMap(sidecar.data)) return kept('is not a YAML map');
  if (sidecar.data?.interface !== undefined && !isMap(sidecar.data.interface)) return kept('has an "interface" that is not a map');
  const have = isMap(sidecar.data?.interface) ? sidecar.data.interface : {};
  const missing = Object.keys(wanted).filter((k) => have[k] === undefined || have[k] === null || have[k] === '');
  if (!missing.length) return { files, dirs, transform: null, diagnostic: null };
  let nextText;
  try {
    const doc = YAML.parseDocument(sidecar.text);
    for (const key of missing) doc.setIn(['interface', key], wanted[key]);
    nextText = doc.toString();
  } catch (err) { return kept(`could not take the interface keys (${String(err?.message || err).split('\n')[0]})`); }
  const back = YAML.parse(nextText);
  const expected = JSON.parse(JSON.stringify(sidecar.data ?? {}));
  expected.interface = { ...(isMap(expected.interface) ? expected.interface : {}), ...Object.fromEntries(missing.map((k) => [k, wanted[k]])) };
  if (JSON.stringify(back) !== JSON.stringify(expected)) return { files, dirs, transform: null, diagnostic: { ruleId: 'L-09-sidecar-kept', severity: 'warning', message: `${CODEX_SIDECAR} could not take the interface keys without changing other values: kept as it is.`, file: CODEX_SIDECAR, line: null } };
  const at = files.findIndex((f) => f.path === CODEX_SIDECAR);
  const out = files.map((f, i) => (i === at ? { ...f, bytes: Buffer.from(nextText, 'utf-8') } : f));
  return { files: out, dirs, transform: transform(missing, false), diagnostic: null };
}

/** agents/openai.yaml as Codex would read it: `{ present, data, error, text }`. */
export function readSidecar(files) {
  const file = (files || []).find((f) => f.path === CODEX_SIDECAR);
  if (!file) return { present: false, data: null, error: null, text: null };
  const text = file.bytes.toString('utf-8');
  try {
    const doc = YAML.parseDocument(text, { uniqueKeys: true, maxAliasCount: 100 });
    if (doc.errors.length) return { present: true, data: null, error: String(doc.errors[0].message).split('\n')[0], text };
    return { present: true, data: doc.toJS({ maxAliasCount: 100 }) ?? null, error: null, text };
  } catch (err) {
    return { present: true, data: null, error: String(err?.message || err).split('\n')[0], text };
  }
}

/** The SKILL.md of a folder as text and parsed frontmatter. */
export function readHeadOf(files) {
  const head = (files || []).find((f) => f.path === 'SKILL.md');
  const text = head ? head.bytes.toString('utf-8') : '';
  return { head, text, parsed: frontmatter.parse(text) };
}

function patchHead(text, changes) {
  const editing = toEditing(text);
  const result = frontmatter.patch(editing.text, changes);
  if (!result.ok) return null;
  return fromEditing(text, result.text);
}

/**
 * The files an install of these files writes for one profile.
 * @param {{ files: {path, bytes, executable}[], dirs: string[] }} folder
 * @param {string} profileId
 * @returns {{ files, dirs, digest: string, transforms: object[], diagnostics: object[], intent: object }}
 */
export function buildExport({ files, dirs = [] }, profileId) {
  const profile = getProfile(profileId);
  const { text, parsed } = readHeadOf(files);
  const sidecar = readSidecar(files);
  const intent = readInvocationIntent({ data: parsed.data, sidecar });
  const plan = invocationPlan(profileId, { intent, data: parsed.data || {}, sidecar });
  const out = files.map((f) => ({ ...f }));
  const outDirs = new Set(dirs);
  const applied = [];
  const diagnostics = [...plan.diagnostics];
  let headText = text;
  for (const t of plan.transforms) {
    if (t.op === 'frontmatter' || t.op === 'metadata') {
      let changes;
      if (t.op === 'frontmatter') changes = { [t.key]: t.value };
      else {
        const current = isMap(parsed.data?.metadata) ? parsed.data.metadata : {};
        changes = { metadata: { ...current, [t.key]: t.value } };
      }
      const next = patchHead(headText, changes);
      if (next === null) {
        diagnostics.push({ ruleId: 'L-08-adapt-failed', severity: 'error', message: `The SKILL.md frontmatter could not be changed to keep ${profile?.title || profileId} from ${t.key === 'user-invocable' ? 'showing it to the person' : 'starting it on its own'}: fix the YAML first.`, file: 'SKILL.md', line: null });
        continue;
      }
      headText = next;
      applied.push(t);
    } else if (t.op === 'sidecar') {
      if (!sidecar.present) {
        out.push({ path: CODEX_SIDECAR, bytes: Buffer.from('policy:\n  allow_implicit_invocation: false\n', 'utf-8'), executable: false });
        outDirs.add('agents');
        applied.push({ ...t, created: true });
        continue;
      }
      if (sidecar.error) {
        diagnostics.push({ ruleId: 'L-08-adapt-failed', severity: 'error', message: `${CODEX_SIDECAR} cannot be read (${sidecar.error}): Codex could start the skill on its own. Fix the file first.`, file: CODEX_SIDECAR, line: null });
        continue;
      }
      let nextText;
      try {
        const doc = YAML.parseDocument(sidecar.text);
        if (!isMap(sidecar.data)) throw new Error('not a YAML map');
        doc.setIn(t.path, t.value);
        nextText = doc.toString();
      } catch (err) {
        diagnostics.push({ ruleId: 'L-08-adapt-failed', severity: 'error', message: `${CODEX_SIDECAR} could not take policy.allow_implicit_invocation (${String(err?.message || err).split('\n')[0]}): set it yourself.`, file: CODEX_SIDECAR, line: null });
        continue;
      }
      // Read back: the one value changed, nothing else.
      const back = YAML.parse(nextText);
      const expected = JSON.parse(JSON.stringify(sidecar.data ?? {}));
      let node = expected;
      for (const key of t.path.slice(0, -1)) { if (!isMap(node[key])) node[key] = {}; node = node[key]; }
      node[t.path[t.path.length - 1]] = t.value;
      if (JSON.stringify(back) !== JSON.stringify(expected)) {
        diagnostics.push({ ruleId: 'L-08-adapt-failed', severity: 'error', message: `${CODEX_SIDECAR} could not be changed without changing other values: set policy.allow_implicit_invocation yourself.`, file: CODEX_SIDECAR, line: null });
        continue;
      }
      const at = out.findIndex((f) => f.path === CODEX_SIDECAR);
      out[at] = { ...out[at], bytes: Buffer.from(nextText, 'utf-8') };
      applied.push(t);
    }
  }
  if (headText !== text) {
    const at = out.findIndex((f) => f.path === 'SKILL.md');
    out[at] = { ...out[at], bytes: Buffer.from(headText, 'utf-8') };
  }
  for (const t of applied) diagnostics.push({ ruleId: 'L-08-invocation-adapted', severity: 'info', message: `${t.file}: ${t.reason}`, file: t.file, line: null });
  // Codex: the words its picker shows, in agents/openai.yaml (added where missing, never over what is there).
  let withDirs = [...outDirs];
  let withFiles = out;
  if (profile?.runtime === 'codex') {
    const added = withCodexInterface(out, withDirs, parsed.data || {});
    withFiles = added.files; withDirs = added.dirs;
    if (added.transform) { applied.push(added.transform); diagnostics.push({ ruleId: 'L-09-sidecar-interface', severity: 'info', message: `${CODEX_SIDECAR}: ${added.transform.reason}`, file: CODEX_SIDECAR, line: null }); }
    if (added.diagnostic) diagnostics.push(added.diagnostic);
  }
  const result = { files: withFiles.sort((a, b) => (a.path < b.path ? -1 : 1)), dirs: withDirs.sort() };
  return { ...result, digest: folderDigest(result), transforms: applied, diagnostics, intent };
}
