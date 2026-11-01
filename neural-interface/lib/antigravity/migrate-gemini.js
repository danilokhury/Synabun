// ═══════════════════════════════════════════
// SynaBun — what was saved for Gemini CLI, read as Antigravity's
// ═══════════════════════════════════════════
//
// Google Antigravity replaced Gemini CLI as SynaBun's Google agent (provider id
// `gemini` → `antigravity`, command `gemini` → `agy`). What a user saved under
// the old id keeps working: a launch profile, a resume tab, a keybind, a loop
// template or schedule says `antigravity` from the first boot on. Gemini CLI's
// model ids (gemini-2.x) are not Antigravity's, so a saved one falls back to the
// model Antigravity picks; a command saved for `gemini` is not a command for
// `agy`, so it goes and `agy` is looked up as any new CLI is.
//
// Every function here is pure: it changes the object it is given and says
// whether it did. migrateGeminiFiles() applies them to the data files the
// server owns outright (CLI paths, keybinds, loop templates and schedules);
// the UI state goes through the server's own cache (server.js), with
// migrateUiStateValues(). The rules state has its own move
// (lib/rulesets/installer.js RENAMED_HOSTS).

import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const OLD_ID = 'gemini';
export const NEW_ID = 'antigravity';
/** Gemini CLI's own model ids, which Antigravity does not take. */
const GEMINI_CLI_MODEL_RE = /^gemini-[12](?:[.-]|$)/i;

export const isGeminiCliModel = (value) => typeof value === 'string' && GEMINI_CLI_MODEL_RE.test(value.trim());

/** data/cli-config.json: the command saved for `gemini` goes (it starts Gemini CLI, not Antigravity). */
export function migrateCliConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || !Object.hasOwn(config, OLD_ID)) return false;
  delete config[OLD_ID];
  return true;
}

/** data/keybinds.json ({ bindings: { actionId: key } }): `launch-gemini` → `launch-antigravity`, unless that is taken. */
export function migrateKeybinds(data) {
  const bindings = data?.bindings;
  if (!bindings || typeof bindings !== 'object' || !Object.hasOwn(bindings, 'launch-gemini')) return false;
  if (!Object.hasOwn(bindings, 'launch-antigravity')) bindings['launch-antigravity'] = bindings['launch-gemini'];
  delete bindings['launch-gemini'];
  return true;
}

/**
 * Loop templates and schedules (any nesting): `profile: 'gemini'` → 'antigravity' (its Gemini CLI model id dropped),
 * `icon: 'gemini'` → 'antigravity', and the same for `cliProfile` / `provider` fields that name the profile.
 */
export function migrateLoopRecords(value) {
  let changed = false;
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 12) return;
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
    let wasGemini = false;
    for (const key of ['profile', 'cliProfile', 'provider']) {
      if (node[key] === OLD_ID) { node[key] = NEW_ID; wasGemini = true; changed = true; }
    }
    if (node.icon === OLD_ID) { node.icon = NEW_ID; changed = true; }
    if (wasGemini && isGeminiCliModel(node.model)) { node.model = ''; changed = true; }
    for (const child of Object.values(node)) if (child && typeof child === 'object') walk(child, depth + 1);
  };
  walk(value);
  return changed;
}

const UI_PROFILE_KEYS = ['as-launch-profile', 'synabun-resume-provider', 'neural-onboarding-cli'];
const UI_SESSION_KEYS = ['neural-terminal-active-sessions', 'neural-terminal-active-sessions-layout'];

/**
 * The UI state (data/ui-state.json, a map of storage keys to strings): the saved launch profile and resume
 * provider, a Gemini CLI model saved with them, and terminal tabs restored with `profile: 'gemini'`.
 */
export function migrateUiStateValues(ui) {
  if (!ui || typeof ui !== 'object') return false;
  let changed = false;
  let profileWasGemini = false;
  for (const key of UI_PROFILE_KEYS) {
    if (ui[key] === OLD_ID) { ui[key] = NEW_ID; changed = true; if (key === 'as-launch-profile') profileWasGemini = true; }
    else if (ui[key] === JSON.stringify(OLD_ID)) { ui[key] = JSON.stringify(NEW_ID); changed = true; if (key === 'as-launch-profile') profileWasGemini = true; }
  }
  if ((profileWasGemini || ui['as-launch-profile'] === NEW_ID) && isGeminiCliModel(ui['as-launch-model'])) { ui['as-launch-model'] = ''; changed = true; }
  for (const key of UI_SESSION_KEYS) {
    const raw = ui[key];
    if (typeof raw !== 'string' || !raw.includes(`"${OLD_ID}"`)) continue;
    try {
      const parsed = JSON.parse(raw);
      if (migrateLoopRecords(parsed)) { ui[key] = JSON.stringify(parsed); changed = true; }
    } catch { /* not JSON: left as it is */ }
  }
  return changed;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}
function writeJsonAtomic(path, value) {
  const temp = `${path}.${process.pid}.antigravity.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/**
 * Applies the migrations to the data files under `<dataHome>/data` the server owns outright. Never throws: a file it
 * cannot read or parse is left as it is (and named in `skipped`). Returns { changed: [file], skipped: [file] }.
 */
export function migrateGeminiFiles({ dataHome, log = () => {} } = {}) {
  const dir = join(dataHome, 'data');
  const changed = [];
  const skipped = [];
  if (!existsSync(dir)) return { changed, skipped };
  const jobs = [
    ['cli-config.json', migrateCliConfig],
    ['keybinds.json', migrateKeybinds],
    // Loop folders carry an icon id (the studio shows a folder with its provider's icon).
    ['loop-folders.json', migrateLoopRecords],
  ];
  let names = [];
  try { names = readdirSync(dir); } catch { names = []; }
  for (const name of names) {
    if (/^loop-(?:templates|schedules)[^/]*\.json$/.test(name)) jobs.push([name, migrateLoopRecords]);
  }
  for (const [name, migrate] of jobs) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    const value = readJson(path);
    if (value === undefined) { skipped.push(name); continue; }
    try {
      if (!migrate(value)) continue;
      writeJsonAtomic(path, value);
      changed.push(name);
    } catch (error) {
      skipped.push(name);
      log(`[antigravity] could not migrate ${name}: ${error?.message || error}`);
    }
  }
  if (changed.length) log(`[antigravity] saved Gemini CLI settings now read as Antigravity's: ${changed.join(', ')}`);
  return { changed, skipped };
}
