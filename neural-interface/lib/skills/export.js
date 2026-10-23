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

import * as YAML from 'yaml';
import { frontmatter } from './frontmatter.js';
import { folderDigest } from './library.js';
import { fromEditing, toEditing } from '../../public/shared/skills/ss-doc.js';
import { CODEX_SIDECAR, getProfile, invocationPlan, readInvocationIntent } from '../../public/shared/skills/ss-profiles.js';

const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

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
      const doc = YAML.parseDocument(sidecar.text);
      doc.setIn(t.path, t.value);
      const nextText = doc.toString();
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
  const result = { files: out.sort((a, b) => (a.path < b.path ? -1 : 1)), dirs: [...outDirs].sort() };
  return { ...result, digest: folderDigest(result), transforms: applied, diagnostics, intent };
}
