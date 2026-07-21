#!/usr/bin/env node

/**
 * Build a validated recovery staging tree from a SynaBun backup.
 *
 * The current .env, memory database, blobs, whiteboard, images, and transient
 * runtime state are preserved. Only allow-listed user configuration is merged
 * from the backup, with backup values winning conflicts and current-only object
 * keys retained.
 */

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const requireFromNeuralInterface = createRequire(resolve(PACKAGE_ROOT, 'neural-interface', 'package.json'));
const AdmZip = requireFromNeuralInterface('adm-zip');

export const RECOVERABLE_CONFIG_FILES = new Set([
  'ui-state.json',
  'greeting-config.json',
  'codex-greeting-config.json',
  'opencode-greeting-config.json',
  'hook-features.json',
  'claude-code-projects.json',
  'keybinds.json',
  'cli-config.json',
  'loop-folders.json',
  'auto-backup-config.json',
  'cost-tracking.json',
  'image-favorites.json',
  'browser-config.json',
  'browser-storage.json',
  'stored-plans.json',
  'synabun-plugins.json',
  'mcp-registry.json',
  'active-profile.json',
]);

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Backup values win conflicts; current-only nested object keys survive. */
export function mergeBackupBaseline(backup, current) {
  if (!isPlainObject(backup) || !isPlainObject(current)) return structuredClone(backup);
  const result = structuredClone(backup);
  for (const [key, currentValue] of Object.entries(current)) {
    if (!(key in backup)) {
      result[key] = structuredClone(currentValue);
      continue;
    }
    if (isPlainObject(backup[key]) && isPlainObject(currentValue)) {
      result[key] = mergeBackupBaseline(backup[key], currentValue);
    }
  }
  return result;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function parseJsonBuffer(buffer, label) {
  try {
    return JSON.parse(buffer.toString('utf-8'));
  } catch (error) {
    throw new Error(`Invalid JSON in ${label}: ${error.message}`);
  }
}

function scheduleArray(value) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.schedules) ? value.schedules : [];
}

function templateArray(value) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.templates) ? value.templates : [];
}

function validateAutomationData(dataDir) {
  const schedules = [];
  const templates = [];
  const groups = [];
  const files = [];

  for (const file of readdirSync(dataDir).sort()) {
    if (!/^loop-(schedules|templates).*\.json$/.test(file)) continue;
    const parsed = JSON.parse(readFileSync(resolve(dataDir, file), 'utf-8'));
    files.push(file);
    if (file.startsWith('loop-schedules')) {
      schedules.push(...scheduleArray(parsed));
      if (file === 'loop-schedules.json' && Array.isArray(parsed?.groups)) groups.push(...parsed.groups);
    } else {
      templates.push(...templateArray(parsed));
    }
  }

  const duplicateIds = (items) => {
    const seen = new Set();
    const duplicates = new Set();
    for (const item of items) {
      if (!item?.id) continue;
      if (seen.has(String(item.id))) duplicates.add(String(item.id));
      seen.add(String(item.id));
    }
    return [...duplicates];
  };

  const duplicateSchedules = duplicateIds(schedules);
  const duplicateTemplates = duplicateIds(templates);
  const duplicateGroups = duplicateIds(groups);
  if (duplicateSchedules.length || duplicateTemplates.length || duplicateGroups.length) {
    throw new Error(`Duplicate automation IDs: schedules=${duplicateSchedules.join(',') || 'none'}, templates=${duplicateTemplates.join(',') || 'none'}, groups=${duplicateGroups.join(',') || 'none'}`);
  }

  const templateIds = new Set(templates.map(item => String(item.id)));
  const groupIds = new Set(groups.map(item => String(item.id)));
  const missingTemplates = schedules.filter(item => item.templateId && !templateIds.has(String(item.templateId)));
  const missingGroups = schedules.filter(item => item.groupId && !groupIds.has(String(item.groupId)));
  if (missingTemplates.length || missingGroups.length) {
    throw new Error(
      `Broken automation references: templates=${missingTemplates.map(item => item.name || item.id).join(',') || 'none'}, ` +
      `groups=${missingGroups.map(item => item.name || item.id).join(',') || 'none'}`
    );
  }

  return {
    scheduleCount: schedules.length,
    templateCount: templates.length,
    groupCount: groups.length,
    automationFiles: files,
  };
}

function backupEntryName(prefix, file) {
  return `${prefix}/data/${file}`;
}

function recoverableBackupFiles(zip, prefix) {
  return zip.getEntries()
    .map(entry => entry.entryName)
    .filter(name => name.startsWith(`${prefix}/data/`))
    .map(name => name.slice(`${prefix}/data/`.length))
    .filter(file => !file.includes('/'))
    .filter(file => RECOVERABLE_CONFIG_FILES.has(file) || /^loop-(schedules|templates).*\.json$/.test(file))
    .sort();
}

export function buildRecovery({ backupPath, currentRoot, outputRoot, now = () => new Date() }) {
  if (!backupPath || !currentRoot || !outputRoot) throw new Error('backupPath, currentRoot, and outputRoot are required');
  const current = resolve(currentRoot);
  const output = resolve(outputRoot);
  if (!existsSync(backupPath)) throw new Error(`Backup not found: ${backupPath}`);
  if (!existsSync(resolve(current, 'mcp-data', 'memory.db'))) throw new Error(`Current memory database not found in ${current}`);

  const zip = new AdmZip(backupPath);
  const manifestEntry = zip.getEntries().find(entry => entry.entryName.endsWith('/manifest.json'));
  if (!manifestEntry) throw new Error('Backup manifest.json not found');
  const prefix = manifestEntry.entryName.slice(0, -'/manifest.json'.length);
  const manifest = parseJsonBuffer(manifestEntry.getData(), manifestEntry.entryName);
  if (manifest.version !== 2) throw new Error(`Unsupported backup version: ${manifest.version}`);

  const files = recoverableBackupFiles(zip, prefix);
  if (!files.some(file => file.startsWith('loop-schedules'))) throw new Error('Backup contains no schedule files');

  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  for (const item of ['.env', 'data', 'mcp-data']) {
    const source = resolve(current, item);
    if (existsSync(source)) cpSync(source, resolve(output, item), { recursive: true, force: true, dereference: false });
  }
  mkdirSync(resolve(output, 'data'), { recursive: true });

  const restored = [];
  const merged = [];
  for (const file of files) {
    const entryName = backupEntryName(prefix, file);
    const entry = zip.getEntry(entryName);
    if (!entry) throw new Error(`Backup entry disappeared: ${entryName}`);
    const buffer = entry.getData();
    const expected = manifest.checksums?.[`data/${file}`]?.replace(/^sha256:/, '');
    if (expected && sha256(buffer) !== expected) throw new Error(`Checksum mismatch for data/${file}`);

    const backupValue = parseJsonBuffer(buffer, entryName);
    const currentPath = resolve(current, 'data', file);
    let outputValue = backupValue;
    if (existsSync(currentPath)) {
      const currentValue = JSON.parse(readFileSync(currentPath, 'utf-8'));
      outputValue = mergeBackupBaseline(backupValue, currentValue);
      merged.push(file);
    } else {
      restored.push(file);
    }

    if (file === 'ui-state.json' && isPlainObject(outputValue)) {
      const currentValue = existsSync(currentPath) ? JSON.parse(readFileSync(currentPath, 'utf-8')) : {};
      if (currentValue._version !== undefined) outputValue._version = currentValue._version;
      outputValue._updated = now().toISOString();
    }
    writeFileSync(resolve(output, 'data', file), JSON.stringify(outputValue, null, 2) + '\n', 'utf-8');
  }

  const automation = validateAutomationData(resolve(output, 'data'));
  const report = {
    version: 1,
    builtAt: now().toISOString(),
    backupPath: resolve(backupPath),
    backupCreatedAt: manifest.created,
    currentRoot: current,
    outputRoot: output,
    restored,
    merged,
    excluded: ['env.bak', 'database/memory.db', 'mcp-data/', 'global-skills/', 'global-agents/', 'skins/', 'transient runtime files'],
    ...automation,
  };
  writeFileSync(resolve(output, '.recovery-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf-8');
  return report;
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const backupPath = option('--backup');
    const currentRoot = option('--current') || PACKAGE_ROOT;
    const outputRoot = option('--output');
    if (!backupPath || !outputRoot) {
      console.error('Usage: node scripts/recover-user-config.mjs --backup <zip> --output <staging-root> [--current <data-root>]');
      process.exit(1);
    }
    const report = buildRecovery({ backupPath, currentRoot, outputRoot });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exit(1);
  }
}
