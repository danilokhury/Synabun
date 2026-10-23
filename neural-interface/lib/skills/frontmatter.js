// ── The frontmatter of skills, commands and agents, on the server ──
// One reader for everything the server says about a SKILL.md, a command or an agent: the library, an opened
// artifact, the validation route, imports. It is the page's own module (public/shared/skills/ss-frontmatter.js)
// over the `yaml` package, so the server and the Studio's form read a file the same way, and the checks are the
// page's too (ss-lint.js).

import * as YAML from 'yaml';
import { createFrontmatter } from '../../public/shared/skills/ss-frontmatter.js';
import { LINT_PROFILE, lintArtifact } from '../../public/shared/skills/ss-lint.js';
import { fromEditing, toEditing } from '../../public/shared/skills/ss-doc.js';

export const frontmatter = createFrontmatter(YAML);

/** The metadata of a document as plain data ({} when it has none, or when it cannot be read). */
export function frontmatterData(text) {
  const parsed = frontmatter.parse(text);
  return { data: parsed.data || Object.create(null), parsed };
}

/** A value shown as text in a list: the text, or '' for anything that is not text. */
export const asText = (value) => (typeof value === 'string' ? value : '');

/**
 * The problems of a document.
 * @param {{ type: 'skill'|'command'|'agent', text: string, folderName?: string, knownNames?: string[], binary?: boolean }} o
 *   `binary`: the file is not UTF-8 text (UTF-16, or binary data). Its decoded bytes are not read as metadata:
 *   that is the one problem, and the Studio shows the file without editing it.
 */
export function lintText({ type, text, folderName = '', knownNames = [], binary = false }) {
  if (binary) {
    const parsed = frontmatter.parse('');
    const problem = { ruleId: 'file-not-text', severity: 'error', message: 'This file is not UTF-8 text (UTF-16, or binary data): a runtime may misread it, and it is not edited here. Save it as UTF-8 to edit it.', line: 1 };
    return { parsed, lint: { profile: LINT_PROFILE, errors: [problem], warnings: [], infos: [], all: [problem] } };
  }
  const parsed = frontmatter.parse(text);
  return { parsed, lint: lintArtifact({ type, parsed, folderName, knownNames }) };
}

/** What a library row shows of the problems: counts only. */
export function problemCounts(lint) {
  return { errors: lint?.errors?.length || 0, warnings: lint?.warnings?.length || 0 };
}

/**
 * A SKILL.md given another `name`: that one key changed, every other byte as it was (its line endings and
 * byte-order mark too). Null when the frontmatter cannot be patched (it does not parse).
 */
export function renameSkillDocument(text, name) {
  const editing = toEditing(text);
  const result = frontmatter.patch(editing.text, { name });
  if (!result.ok) return null;
  return fromEditing(text, result.text);
}
