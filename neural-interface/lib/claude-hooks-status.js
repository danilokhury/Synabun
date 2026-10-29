// ═══════════════════════════════════════════
// SynaBun — the real state of SynaBun's Claude Code hooks (Settings → Automations)
// ═══════════════════════════════════════════
//
// What GET /api/claude-code/integrations reports as `claudeHooks`, read from the files Claude Code itself reads:
// the user's ~/.claude/settings.json (SynaBun's handlers live there), the managed settings an organization may
// install, and the registered projects' .claude/settings.json and settings.local.json. It answers "would a Claude
// Code session the owner starts by themselves run SynaBun's hooks?", which a count of entries alone does not:
//   • Claude Code's own switches: disableAllHooks (any scope) runs no hook at all; allowManagedHooksOnly (managed
//     settings) runs none of the user's or a project's;
//   • a project whose SynaBun handlers differ from the user's: Claude Code runs one copy of identical handlers from
//     both files and both copies of different ones (every hook twice: the 2026-09-15 bug);
//   • macOS / Linux: a Claude Code started from the Dock, Finder, a desktop app or launchd has no login PATH. The
//     handlers then look for Node in the usual folders and SYNABUN_NODE (lib/claude-hooks.js); `node: null` says
//     such a launch would find none.
// Pure apart from the file reads, which are injected (tests drive it with an in-memory tree).

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hookInstallBlocker, hookInstallState, hookNodeWithoutPath, hooksSwitchedOff, managedClaudeSettingsPath, projectHooksAgree } from '../../lib/claude-hooks.js';
import { packagedRuntime } from '../../lib/packaged-runtime.js';

/** Bumped when the shape changes; the page shows the hooks' state only from a server that sends one. */
export const CLAUDE_HOOKS_STATUS_VERSION = 1;

/** A settings file: { settings } (parsed), { missing: true }, or { error } (it exists and cannot be read or parsed: why). */
export function readSettingsFile(path, { read = (p) => readFileSync(p, 'utf8'), exists = existsSync } = {}) {
  try {
    if (!path || !exists(path)) return { missing: true };
  } catch { return { missing: true }; }
  let raw;
  try { raw = read(path); } catch (error) { return { error: String(error?.code || error?.message || error) }; }
  try {
    const settings = JSON.parse(raw);
    return settings && typeof settings === 'object' && !Array.isArray(settings) ? { settings } : { error: 'not a JSON object' };
  } catch (error) { return { error: `not valid JSON: ${error?.message || error}` }; }
}

/**
 * @param {object} o
 * @param {string} o.userPath the user's ~/.claude/settings.json
 * @param {Array<{path:string,label?:string}>} [o.projects] the registered projects
 * @param {string} [o.managedPath] managed settings (managedClaudeSettingsPath)
 * @param {string} [o.platform]
 * @param {object|null} [o.runtime] lib/packaged-runtime.js packagedRuntime()
 * @param {(path:string) => string} [o.read] @param {(path:string) => boolean} [o.exists]
 * @param {(path:string) => boolean} [o.runnable] a file Node could be started from (tests)
 * @param {string} [o.home]
 */
export function claudeHooksStatus({ userPath, projects = [], managedPath = managedClaudeSettingsPath(), platform = process.platform, runtime = packagedRuntime(), read, exists, runnable, home = homedir() } = {}) {
  const io = { ...(read ? { read } : {}), ...(exists ? { exists } : {}) };
  const base = { version: CLAUDE_HOOKS_STATUS_VERSION, settingsPath: userPath || null, installBlocker: hookInstallBlocker(runtime) };
  const user = readSettingsFile(userPath, io);
  if (user.error) return { ...base, state: 'error', error: user.error, installed: 0, current: 0, duplicates: 0, total: 0, events: {}, blockedBy: null, projects: [], node: null, nodeMissing: false, needsRepair: false };
  const settings = user.settings || {};
  const install = hookInstallState(settings, { runtime, platform });
  const state = install.installed === 0 ? 'off' : install.installed === install.total ? 'on' : 'partial';

  // Claude Code's own switches. Managed settings first: nothing below them can turn hooks back on.
  let blockedBy = null;
  const managed = readSettingsFile(managedPath, io);
  const managedSwitch = hooksSwitchedOff(managed.settings, { managed: true });
  if (managedSwitch) blockedBy = { setting: managedSwitch, scope: 'managed', path: managedPath };
  else {
    const userSwitch = hooksSwitchedOff(settings);
    if (userSwitch) blockedBy = { setting: userSwitch, scope: 'user', path: userPath };
  }

  // The registered projects: hooks switched off there, or SynaBun handlers that would run next to the user's.
  const projectIssues = [];
  for (const project of Array.isArray(projects) ? projects : []) {
    if (!project?.path) continue;
    for (const name of ['settings.json', 'settings.local.json']) {
      const file = join(project.path, '.claude', name);
      const found = readSettingsFile(file, io);
      if (!found.settings) continue;
      let issue = hooksSwitchedOff(found.settings) ? 'disableAllHooks' : projectHooksAgree(settings, found.settings) === 'different' ? 'different' : null;
      // Off for the user, still on there: that project's sessions keep running them.
      if (!issue && install.installed === 0 && hookInstallState(found.settings, { targetProjectPath: project.path, runtime, platform }).installed > 0) issue = 'project-only';
      if (issue) projectIssues.push({ path: project.path, label: project.label || null, file, issue });
    }
  }

  // Asked of the packaged application too: its entry finds its own Node, so the answer is only shown for the others.
  const node = platform === 'win32' || runtime ? null : hookNodeWithoutPath({ env: settings.env || {}, home, platform, ...(runnable ? { runnable } : {}) });
  const nodeMissing = install.installed > 0 && platform !== 'win32' && !runtime && !node;
  return {
    ...base,
    state,
    installed: install.installed,
    current: install.current,
    duplicates: install.duplicates,
    total: install.total,
    events: install.events,
    blockedBy,
    projects: projectIssues,
    node,
    nodeMissing,
    // What turning the hooks on again would put right: an old command form, an extra copy, a project out of step.
    needsRepair: install.installed > 0 && (install.current < install.installed || install.duplicates > 0 || projectIssues.some((p) => p.issue === 'different') || nodeMissing),
  };
}
