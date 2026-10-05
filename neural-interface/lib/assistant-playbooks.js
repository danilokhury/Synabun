// ═══════════════════════════════════════════
// SynaBun — Assistant playbooks (the rules a task class's worker follows)
// ═══════════════════════════════════════════
//
// A class with a `playbook` (TASK_CLASS_META: design) hands its worker a rules
// file. The shipped copy lives next to this module in assistant-playbooks/
// <name>.md; the user's copy at <dataDir>/playbooks/<name>.md
// (~/.synabun/data/playbooks/) wins when it is a readable, non-empty UTF-8
// file of at most 24 KB. Nothing is cached: the dispatcher reads the file when a run
// starts, so an edit applies to the next run without a restart. Any problem
// with the override falls back to the shipped copy and says why (`note`).

import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHIPPED_PLAYBOOK_DIR = join(dirname(fileURLToPath(import.meta.url)), 'assistant-playbooks');
export const MAX_PLAYBOOK_BYTES = 24 * 1024;
const NAME_RE = /^[a-z][a-z0-9-]{0,40}$/;

/** The override path for `name`: <dataDir>/playbooks/<name>.md. */
export function playbookOverridePath(dataDir, name) {
  return resolve(dataDir, 'playbooks', `${name}.md`);
}

/**
 * A file's text when it is a non-empty regular file within `maxBytes` holding valid UTF-8
 * (a UTF-8 BOM is dropped); else { error }. Malformed UTF-8, UTF-16 (a BOM that is not
 * UTF-8, or the NUL bytes of plain UTF-16 text) and binary files are refused, never read as
 * garbled rules. Throws on I/O errors.
 */
function readRules(path, maxBytes) {
  const info = statSync(path);
  if (!info.isFile()) return { error: 'is not a file' };
  if (info.size > maxBytes) return { error: `is larger than ${Math.floor(maxBytes / 1024)} KB` };
  const bytes = readFileSync(path);
  // It may have grown between the stat and the read.
  if (bytes.length > maxBytes) return { error: `is larger than ${Math.floor(maxBytes / 1024)} KB` };
  if (bytes.includes(0)) return { error: 'contains NUL bytes (UTF-16 or binary, not UTF-8 text)' };
  let text = '';
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { error: 'is not valid UTF-8' }; }
  text = text.replace(/^\uFEFF/, '').trim();
  return text ? { text } : { error: 'is empty' };
}

/**
 * The rules for `name`: { name, text, source: 'override' | 'shipped' | 'missing', path, note }.
 * `note` says why the user's override was not used (too large, empty, not UTF-8, unreadable), else null.
 * `text` is '' only when no copy could be read (source 'missing'). null for an invalid name.
 */
export function loadPlaybook(name, { dataDir = null, shippedDir = SHIPPED_PLAYBOOK_DIR, maxBytes = MAX_PLAYBOOK_BYTES } = {}) {
  const id = String(name || '');
  if (!NAME_RE.test(id)) return null;
  let note = null;
  if (dataDir) {
    const path = playbookOverridePath(dataDir, id);
    try {
      const got = readRules(path, maxBytes);
      if (got.text) return { name: id, text: got.text, source: 'override', path, note: null };
      note = `${path} ${got.error}; using the shipped ${id} rules`;
    } catch (error) {
      if (error?.code !== 'ENOENT') note = `${path} could not be read (${error?.code || error?.message || error}); using the shipped ${id} rules`;
    }
  }
  const path = join(shippedDir, `${id}.md`);
  try {
    // The shipped copy is ours: no size cap.
    const got = readRules(path, Number.POSITIVE_INFINITY);
    if (got.text) return { name: id, text: got.text, source: 'shipped', path, note };
  } catch { /* reported below */ }
  return { name: id, text: '', source: 'missing', path, note: note ? `${note}, which could not be read either` : `the shipped ${id} rules (${path}) could not be read` };
}
