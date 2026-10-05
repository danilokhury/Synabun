import { readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeAutomationSelection } from '../public/shared/automation-context.js';

export function normalizeAutomationRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const selection = normalizeAutomationSelection(record.profile, record.model, record.contextMode);
  let changed = false;
  if ((record.model || null) !== selection.model) {
    record.model = selection.model;
    changed = true;
  }
  if ((record.contextMode || null) !== selection.contextMode) {
    if (selection.contextMode) record.contextMode = selection.contextMode;
    else delete record.contextMode;
    changed = true;
  }
  return changed;
}

/** Upgrade only known legacy model selectors. Keeps every other field and file layout. */
export function migrateAutomationContextFiles(dataDir) {
  const result = { files: 0, templates: 0, groups: 0, schedules: 0 };
  let names = [];
  try { names = readdirSync(dataDir); } catch { return result; }
  for (const name of names.filter((value) => /^loop-(templates|schedules).*\.json$/.test(value)).sort()) {
    const path = resolve(dataDir, name);
    let raw, data;
    try { raw = readFileSync(path, 'utf8'); data = JSON.parse(raw); }
    catch { continue; }
    const isTemplates = name.startsWith('loop-templates');
    const lists = isTemplates
      ? [['templates', Array.isArray(data) ? data : data?.templates]]
      : [['schedules', Array.isArray(data) ? data : data?.schedules], ['groups', Array.isArray(data) ? [] : data?.groups]];
    let changed = false;
    for (const [kind, records] of lists) {
      for (const record of Array.isArray(records) ? records : []) {
        if (normalizeAutomationRecord(record)) { result[kind]++; changed = true; }
      }
    }
    if (!changed) continue;
    // Do not overwrite a concurrent schedule update observed during migration.
    if (readFileSync(path, 'utf8') !== raw) throw new Error(`Automation data changed during context migration: ${name}`);
    const temporary = `${path}.${process.pid}.context-migration.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', 'utf8');
      renameSync(temporary, path);
      result.files++;
    } finally {
      try { unlinkSync(temporary); } catch {}
    }
  }
  return result;
}
