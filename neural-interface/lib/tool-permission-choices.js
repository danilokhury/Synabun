// ═══════════════════════════════════════════
// SynaBun — Tool permissions: the owner's choices, kept by SynaBun
// ═══════════════════════════════════════════
//
// Settings → Tool permissions switches SynaBun's tools on and off. What a switch
// changes is Claude Code's own allow list (permissions.allow of the user's
// ~/.claude/settings.json), which is also what the switches are drawn from. That
// file belongs to another program: it is rewritten by Claude Code, replaced by a
// restore or a dotfiles sync, lost with a profile. Until this module the list in
// it was the only record of what the owner chose, so whatever replaced the file
// took every choice with it and Settings showed all of them off.
//
// DATA_HOME/data/tool-permissions.json is SynaBun's own record of those choices
// ({ choices: { <tool key>: true | false } }). The data home is never touched by
// an install or an update (and is part of every backup and pre-update snapshot).
//
//   on    the owner switched the tool on here, or the allow list has it (a rule
//         granted in Claude Code is a choice too: it is adopted)
//   off   the owner switched it off here (or removed its rule in the side
//         panel's /permissions). SynaBun never allows such a tool by itself
//   none  never chosen: the product's default applies (a tool is off until it is
//         switched on; the memory tools are allowed when the MCP server is
//         registered). A tool that is new in an update has no choice
//
// The allow list stays what is true (Claude Code reads nothing else). The record
// is what brings it back:
//
//   at every start   every tool whose choice is `on` and whose rule is missing is
//                    put back (planStart). An update is a start
//   at a read        only when every saved `on` tool is missing at once
//                    (lostWholesale): that is a replaced file, never one rule the
//                    owner took out in Claude Code, which waits for the next start
//
// Nothing here ever removes a rule. No DOM, no server: the file is the only
// state, read on every call (its writers are this process's routes).

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const TOOL_CHOICES_FILE = 'tool-permissions.json';
export const TOOL_CHOICES_VERSION = 1;
/** A replaced file is told from a rule taken out by hand by this many saved tools missing together. */
export const WHOLESALE_MIN = 3;
/** How many restores the record remembers (what was put back, when, by which version). */
export const RESTORE_HISTORY = 10;

const isKey = (value) => typeof value === 'string' && value.length > 0 && value.length <= 300;
const keyList = (value) => [...new Set((Array.isArray(value) ? value : []).filter(isKey))];

/** A record as it is used: unknown shapes are an empty record, never an exception. */
export function normalizeChoices(data) {
  const out = { version: TOOL_CHOICES_VERSION, choices: {}, restores: [] };
  if (!data || typeof data !== 'object' || Array.isArray(data)) return out;
  const choices = data.choices && typeof data.choices === 'object' && !Array.isArray(data.choices) ? data.choices : {};
  for (const [key, value] of Object.entries(choices)) if (isKey(key) && typeof value === 'boolean') out.choices[key] = value;
  for (const entry of Array.isArray(data.restores) ? data.restores : []) {
    if (!entry || typeof entry !== 'object') continue;
    const keys = keyList(entry.keys);
    if (!keys.length) continue;
    out.restores.push({
      at: typeof entry.at === 'string' ? entry.at : null,
      reason: entry.reason === 'read' ? 'read' : 'start',
      appVersion: typeof entry.appVersion === 'string' ? entry.appVersion : null,
      keys,
    });
  }
  out.restores = out.restores.slice(-RESTORE_HISTORY);
  if (typeof data.updatedAt === 'string') out.updatedAt = data.updatedAt;
  return out;
}

/** The tools of `known` whose saved choice is on. */
export function savedOn(choices, known) {
  const set = known instanceof Set ? known : new Set(known || []);
  return Object.keys(choices || {}).filter((key) => choices[key] === true && set.has(key));
}

/**
 * What a start does to an allow list: the saved `on` tools that are missing are put back (`restored`, appended in
 * the order of `known`), and the tools the list allows without a saved `on` are adopted as such (`adopted`).
 * `allow` is returned as it was when nothing is missing: the caller writes only when `restored` is not empty.
 * Rules that are not SynaBun's tools (Bash(...), another server's) are never looked at.
 */
export function planStart({ allow, choices, known }) {
  const list = Array.isArray(allow) ? allow.filter((rule) => typeof rule === 'string') : [];
  const present = new Set(list);
  const order = [...(known instanceof Set ? known : new Set(known || []))];
  const restored = order.filter((key) => choices?.[key] === true && !present.has(key));
  const adopted = order.filter((key) => present.has(key) && choices?.[key] !== true);
  return { allow: restored.length ? [...list, ...restored] : list, restored, adopted };
}

/**
 * True when the allow list lost every saved `on` tool at once: the file was replaced (or emptied), which no owner
 * does one rule at a time. Fewer than WHOLESALE_MIN saved tools never count: one or two missing rules can be a
 * removal by hand.
 */
export function lostWholesale({ allow, choices, known }) {
  const saved = savedOn(choices, known);
  if (saved.length < WHOLESALE_MIN) return false;
  const present = new Set(Array.isArray(allow) ? allow : []);
  return saved.every((key) => !present.has(key));
}

/**
 * The record over one file.
 * @param {object} o
 * @param {string} o.path          DATA_HOME/data/tool-permissions.json
 * @param {() => Date} [o.now]
 * @param {(line: string) => void} [o.log]
 * @param {string} [o.appVersion]  written with every restore (which version put the tools back)
 */
export function createToolPermissionChoices({ path, now = () => new Date(), log = () => {}, appVersion = '' } = {}) {
  if (!path) throw new Error('createToolPermissionChoices requires a path');
  let warned = false;

  /** The record. A file that cannot be read is kept aside (`.damaged`) and counts as an empty one. */
  function read() {
    let raw;
    try {
      if (!existsSync(path)) return normalizeChoices(null);
      raw = readFileSync(path, 'utf8');
    } catch (error) {
      if (!warned) { warned = true; log(`[tool-permissions] ${path} could not be read (${error?.message || error}); the saved choices are not used.`); }
      return normalizeChoices(null);
    }
    try {
      return normalizeChoices(JSON.parse(raw.replace(/^﻿/, '')));
    } catch (error) {
      try { renameSync(path, `${path}.damaged`); } catch { /* it stays where it is; the next write replaces it */ }
      log(`[tool-permissions] ${path} was not valid JSON (${error?.message || error}); it is kept as ${path}.damaged and the choices start again from the allow list.`);
      return normalizeChoices(null);
    }
  }

  /** Never throws: a record that cannot be written must not stop a switch from working. */
  function write(record) {
    const next = { ...normalizeChoices(record), updatedAt: now().toISOString() };
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      renameSync(tmp, path);
      return true;
    } catch (error) {
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* nothing to clean */ }
      log(`[tool-permissions] the saved choices could not be written to ${path}: ${error?.message || error}`);
      return false;
    }
  }

  /** The owner switched these tools on or off (Settings, or a rule removed in the side panel). */
  function note(keys, enabled) {
    const list = keyList(keys);
    if (!list.length || typeof enabled !== 'boolean') return false;
    const record = read();
    let changed = false;
    for (const key of list) if (record.choices[key] !== enabled) { record.choices[key] = enabled; changed = true; }
    return changed ? write(record) : false;
  }

  /** The tools the allow list has are `on` choices from now on (a grant made in Claude Code, the memory tools' default). */
  function adopt(allow, known) {
    const record = read();
    const { adopted } = planStart({ allow, choices: record.choices, known });
    if (!adopted.length) return [];
    for (const key of adopted) record.choices[key] = true;
    write(record);
    return adopted;
  }

  /** These tools were put back into the allow list (what, when, why, by which version). */
  function noteRestore(keys, reason) {
    const list = keyList(keys);
    if (!list.length) return;
    const record = read();
    record.restores = [...record.restores, { at: now().toISOString(), reason: reason === 'read' ? 'read' : 'start', appVersion: appVersion || null, keys: list }].slice(-RESTORE_HISTORY);
    write(record);
  }

  /** True when the owner switched this tool off: SynaBun then never allows it by itself. */
  function isOff(key) { return read().choices[key] === false; }

  return { path, read, note, adopt, noteRestore, isOff, choices: () => read().choices };
}

/**
 * Bring an allow list in line with the saved choices, through the caller's own reading and writing of the settings
 * file (server.js readClaudeSettingsForWrite / writeClaudeSettings: a file that is not JSON is never written over).
 *
 * @param {object} o
 * @param {ReturnType<typeof createToolPermissionChoices>} o.store
 * @param {string} o.settingsPath                 ~/.claude/settings.json
 * @param {(path: string) => object} o.read       {} when the file does not exist; throws when it is not JSON
 * @param {(path: string, settings: object) => void} o.write
 * @param {Iterable<string>} o.known              every tool key the running version has
 * @param {'start' | 'read'} [o.reason]           `read` restores only a wholesale loss
 * @returns {{ state: 'unchanged' | 'restored' | 'error', restored: string[], adopted: string[], allow: string[], message?: string }}
 */
export function reconcileToolPermissions({ store, settingsPath, read, write, known, reason = 'start', log = () => {} }) {
  const knownSet = known instanceof Set ? known : new Set(known || []);
  let settings;
  try { settings = read(settingsPath); } catch (error) {
    return { state: 'error', restored: [], adopted: [], allow: [], message: String(error?.message || error) };
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return { state: 'error', restored: [], adopted: [], allow: [], message: `${settingsPath} does not hold a settings object.` };
  }
  const allow = Array.isArray(settings.permissions?.allow) ? settings.permissions.allow : [];
  const choices = store.choices();
  const plan = planStart({ allow, choices, known: knownSet });
  const due = plan.restored.length > 0 && (reason !== 'read' || lostWholesale({ allow, choices, known: knownSet }));
  if (!due) {
    const adopted = plan.adopted.length ? store.adopt(allow, knownSet) : [];
    return { state: 'unchanged', restored: [], adopted, allow: allow.filter((rule) => typeof rule === 'string') };
  }
  const permissions = settings.permissions && typeof settings.permissions === 'object' && !Array.isArray(settings.permissions) ? settings.permissions : {};
  settings.permissions = { ...permissions, allow: plan.allow };
  try { write(settingsPath, settings); } catch (error) {
    return { state: 'error', restored: [], adopted: [], allow: allow.filter((rule) => typeof rule === 'string'), message: String(error?.message || error) };
  }
  store.noteRestore(plan.restored, reason);
  const adopted = plan.adopted.length ? store.adopt(plan.allow, knownSet) : [];
  log(`[tool-permissions] ${plan.restored.length} saved tool permission${plan.restored.length === 1 ? ' was' : 's were'} missing from ${settingsPath} and ${plan.restored.length === 1 ? 'was' : 'were'} put back (${reason === 'read' ? 'Settings was opened' : 'server start'}).`);
  return { state: 'restored', restored: plan.restored, adopted, allow: plan.allow };
}
