// ═══════════════════════════════════════════
// SynaBun — Agents: where a native export goes, and the write (phase P6)
// ═══════════════════════════════════════════
//
// The one place that turns "Claude Code, this account" or "OpenCode, that project" into a path, looks at what is
// there, and writes an export (lib/agents/native-export.js makes the text). The rules are the ones Skills Studio's
// own agent creation follows (server.js POST /api/skills-studio/create):
//
//   - two places only: the account level (Claude Code's config dir, OpenCode's configuration folder) or a project
//     SynaBun has registered. A project that is not registered is refused; no path is ever taken from a request.
//   - the file must really land in that folder (lib/path-confine.js confineToRoot): a linked `.claude/agents` in a
//     project that leads elsewhere is refused before any folder is made.
//   - a new file is created exclusively (lib/confined-fs.js). Nothing that exists is replaced unless the owner says
//     so AND names the digest of what is there now; a link, a folder or a device at the file's place is never written.
//   - OpenCode has one document for many things: only the `agents.<id>` key is set, the rest of the user's file stays
//     as it is, and a file that is not JSON is never overwritten. `opencode.jsonc` is the user's and is never written.
//
// Nothing here decides who may write: lib/agents-studio-api.js lets only the owner's page reach `write`. `inspect`
// reads and never writes, so a preview is safe for the Assistant.

import { lstatSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { entryKind, readConfinedFile, replaceFileAtomic, writeConfinedFile } from '../confined-fs.js';
import { OPENCODE_CONFIG_FILE, OPENCODE_CONFIG_SCHEMA, agentOf, parseJsonc, setAgent } from '../opencode-config.js';
import { PathConfineError, confineToRoot } from '../path-confine.js';
import { NativeExportError, entryDigest, nativeDigest } from './native-export.js';

export const NATIVE_TARGET_KINDS = Object.freeze(['account', 'project']);
/** The most an existing file is read to compare it (an agent file or an opencode.json is far smaller). */
export const NATIVE_TARGET_MAX_BYTES = 2 * 1024 * 1024;

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * @param {object} o
 * @param {() => string} o.claudeHome Claude Code's config dir (CLAUDE_CONFIG_DIR, else ~/.claude)
 * @param {() => string} o.opencodeConfigDir OpenCode's configuration folder (lib/opencode-config.js opencodeConfigDir)
 * @param {(path: string) => boolean} o.isRegisteredProject is this folder a project SynaBun has registered?
 */
export function createNativeExportTargets({ claudeHome, opencodeConfigDir, isRegisteredProject } = {}) {
  if (typeof claudeHome !== 'function' || typeof opencodeConfigDir !== 'function' || typeof isRegisteredProject !== 'function') {
    throw new Error('createNativeExportTargets needs { claudeHome, opencodeConfigDir, isRegisteredProject }');
  }

  /**
   * Where an export of `exported` would be written.
   * @param {object} exported an exportNative() result (supported)
   * @param {{ id: string, target?: 'account'|'project', projectPath?: string|null }} where
   * @returns {{ host, kind: 'account'|'project', projectPath: string|null, path: string, root: { dir: string, anchor: string } }}
   * @throws {NativeExportError} 400 `no_native_format` / `invalid_target` / `project_required`, 403 `project_not_registered`
   */
  function resolveTarget(exported, { id, target = 'account', projectPath = null } = {}) {
    if (!exported?.supported) throw new NativeExportError(400, 'no_native_format', exported?.reason || 'This host has no native agent format.', { host: exported?.host || null });
    const kind = String(target || 'account').trim().toLowerCase();
    if (!NATIVE_TARGET_KINDS.includes(kind)) throw new NativeExportError(400, 'invalid_target', 'target is "account" (the host\'s own folder) or "project" (a registered project).');
    let project = null;
    if (kind === 'project') {
      if (typeof projectPath !== 'string' || !projectPath.trim()) throw new NativeExportError(400, 'project_required', 'A project target names its project: the absolute path of a registered project.');
      let registered = false;
      try { registered = !!isRegisteredProject(projectPath); } catch { registered = false; }
      if (!registered) throw new NativeExportError(403, 'project_not_registered', 'Not a registered project: an export goes to the account level or to a project SynaBun knows.');
      project = resolve(projectPath);
    }
    let dir;
    let path;
    if (exported.host === 'claude-code') {
      dir = join(project || resolve(claudeHome()), ...(project ? ['.claude', 'agents'] : ['agents']));
      path = join(dir, `${id}.md`);
    } else {
      dir = project || resolve(opencodeConfigDir());
      path = join(dir, OPENCODE_CONFIG_FILE);
    }
    // The folder the file must really land in, and (for a folder inside a project) the project it must stay within.
    // OpenCode's project document sits in the project's own folder: there is no folder between them to check.
    const root = { dir, anchor: project && dir !== project ? project : '' };
    try { confineToRoot(root, path); } catch (error) {
      if (error instanceof PathConfineError) throw new NativeExportError(403, 'target_leaves_folder', 'That place leads out of its folder through a link: nothing is written there.');
      throw error;
    }
    return { host: exported.host, kind, projectPath: project, path, root };
  }

  /** The text of the file at a target, or what is in its place: { kind, text, stat }. Never follows a link. */
  function onDisk(resolved) {
    const kind = entryKind(resolved.path);
    if (kind !== 'file') return { kind, text: null, stat: null };
    let text;
    try { text = readConfinedFile(resolved.root.dir, resolved.path, { maxBytes: NATIVE_TARGET_MAX_BYTES, encoding: 'utf-8' }); } catch (error) {
      if (error instanceof PathConfineError) return { kind: 'unreadable', text: null, stat: null, problem: error.message };
      throw error;
    }
    let stat = null;
    try { const st = lstatSync(resolved.path); stat = { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, size: st.size, mode: st.mode & 0o777 }; } catch { stat = null; }
    return { kind, text, stat };
  }

  /** An OpenCode document's text as its object. `error` when it is not a JSON object (such a file is never written). */
  function readDocument(text) {
    try {
      const value = text.trim() ? JSON.parse(text.replace(/^﻿/, '')) : {};
      return isObject(value) ? { config: value, error: null } : { config: null, error: 'it does not hold a JSON object' };
    } catch (error) { return { config: null, error: error?.message || 'it is not JSON' }; }
  }

  /** Does the `opencode.jsonc` beside a document define this agent too? (It wins over opencode.json.) */
  function jsoncOverrides(resolved, id) {
    const path = join(resolved.root.dir, 'opencode.jsonc');
    if (entryKind(path) !== 'file') return false;
    try {
      const config = parseJsonc(readConfinedFile(resolved.root.dir, path, { maxBytes: NATIVE_TARGET_MAX_BYTES, encoding: 'utf-8' }));
      return isObject(config) && (isObject(config.agents?.[id]) || isObject(config.agent?.[id]));
    } catch { return false; }
  }

  /**
   * What is at the target now, compared with what an export would put there. Reads only.
   * @returns {{ host, kind, projectPath, path, exists: boolean, existingDigest: string|null, same: boolean,
   *   writable: boolean, problem: string|null, overriddenByJsonc?: boolean }}
   *   `exists`: the agent is there already (the file, or the entry of that id). `existingDigest`: of the file's text
   *   (Claude Code) or of the entry (OpenCode): what a replace must name.
   */
  function inspect(resolved, exported, { id } = {}) {
    return inspectDisk(resolved, exported, id, onDisk(resolved));
  }
  function inspectDisk(resolved, exported, id, disk) {
    const base = { host: resolved.host, kind: resolved.kind, projectPath: resolved.projectPath, path: resolved.path };
    if (disk.kind !== 'file' && disk.kind !== 'absent') {
      return { ...base, exists: disk.kind !== 'unreadable', existingDigest: null, same: false, writable: false, problem: disk.problem || `There is a ${disk.kind === 'dir' ? 'folder' : disk.kind === 'link' ? 'link' : 'special file'} at that place: nothing is written over it.` };
    }
    if (exported.kind === 'file') {
      if (disk.kind === 'absent') return { ...base, exists: false, existingDigest: null, same: false, writable: true, problem: null };
      const existingDigest = nativeDigest(disk.text);
      return { ...base, exists: true, existingDigest, same: existingDigest === exported.digest, writable: true, problem: null };
    }
    // An entry of a document.
    const overriddenByJsonc = jsoncOverrides(resolved, id);
    if (disk.kind === 'absent') return { ...base, exists: false, existingDigest: null, same: false, writable: true, problem: null, ...(overriddenByJsonc ? { overriddenByJsonc } : {}) };
    const doc = readDocument(disk.text);
    if (doc.error) return { ...base, exists: false, existingDigest: null, same: false, writable: false, problem: `The file could not be read (${doc.error}); SynaBun does not change it.` };
    const has = isObject(doc.config.agents?.[id]) || isObject(doc.config.agent?.[id]);
    const existingDigest = has ? entryDigest(agentOf(doc.config, id)) : null;
    // The same entry, already in OpenCode 2's own key (an OpenCode 1 `agent.<id>` of the same content is still moved).
    const unchanged = has && existingDigest === exported.entryDigest && isObject(doc.config.agents?.[id]) && !isObject(doc.config.agent?.[id]);
    return { ...base, exists: has, existingDigest, same: unchanged, writable: true, problem: null, ...(overriddenByJsonc ? { overriddenByJsonc } : {}) };
  }

  /**
   * Write an export to its target. The caller is the owner's page (lib/agents-studio-api.js): nothing else reaches this.
   * @param {object} resolved a resolveTarget() result
   * @param {object} exported an exportNative() result
   * @param {{ id: string, replace?: boolean, expectedDigest?: string|null }} options `replace` with the
   *   `existingDigest` the owner saw replaces what is there; without both, an agent that exists is left alone.
   * @returns {{ host, kind, projectPath, path, action: 'created'|'replaced'|'unchanged', digest: string }}
   * @throws {NativeExportError} 409 `export_exists` (with `existingDigest`), 409 `export_changed`, 409 `target_not_writable`
   */
  function write(resolved, exported, { id, replace = false, expectedDigest = null } = {}) {
    // One read: what is compared and what is replaced are the same bytes (`expect` refuses a file that changed since).
    const disk = onDisk(resolved);
    const before = inspectDisk(resolved, exported, id, disk);
    const base = { host: resolved.host, kind: resolved.kind, projectPath: resolved.projectPath, path: resolved.path };
    if (!before.writable) throw new NativeExportError(409, 'target_not_writable', before.problem || 'That place cannot be written.', { path: resolved.path });
    if (before.same) return { ...base, action: 'unchanged', digest: exported.kind === 'file' ? exported.digest : exported.entryDigest };
    if (before.exists) {
      if (replace !== true) throw new NativeExportError(409, 'export_exists', `${exported.kind === 'file' ? 'A file' : 'An agent'} "${id}" is already there. Look at it first: replacing it needs replace and its digest.`, { path: resolved.path, existingDigest: before.existingDigest });
      if (typeof expectedDigest !== 'string' || expectedDigest !== before.existingDigest) throw new NativeExportError(409, 'export_changed', 'What is there is not what you looked at: read it again before replacing it.', { path: resolved.path, existingDigest: before.existingDigest });
    }
    try {
      if (exported.kind === 'file') {
        if (disk.kind === 'absent') writeConfinedFile(resolved.root.dir, resolved.path, exported.content, { exclusive: true, mode: 0o644 });
        else replaceFileAtomic(resolved.path, exported.content, { mode: disk.stat?.mode || 0o644, expect: disk.stat, exactMode: true });
        return { ...base, action: disk.kind === 'absent' ? 'created' : 'replaced', digest: exported.digest };
      }
      const doc = disk.kind === 'absent' ? { config: { $schema: OPENCODE_CONFIG_SCHEMA }, error: null } : readDocument(disk.text);
      if (doc.error) throw new NativeExportError(409, 'target_not_writable', `The file could not be read (${doc.error}); SynaBun does not change it.`, { path: resolved.path });
      const next = `${JSON.stringify(setAgent(doc.config, id, exported.entry), null, 2)}\n`;
      // A new opencode.json is the user's alone (it can come to hold keys); one that exists keeps the mode it had.
      if (disk.kind === 'absent') writeConfinedFile(resolved.root.dir, resolved.path, next, { exclusive: true, mode: 0o600 });
      else replaceFileAtomic(resolved.path, next, { mode: disk.stat?.mode || 0o600, expect: disk.stat, exactMode: true });
      return { ...base, action: before.exists ? 'replaced' : 'created', digest: exported.entryDigest };
    } catch (error) {
      if (error instanceof PathConfineError) throw new NativeExportError(error.status === 409 ? 409 : 403, error.status === 409 ? 'export_changed' : 'target_leaves_folder', error.message, { path: resolved.path });
      throw error;
    }
  }

  /** Is anything at this path a regular file? (For a test and a status line.) */
  function exists(path) { try { return statSync(path).isFile(); } catch { return false; } }

  return { resolveTarget, inspect, write, exists };
}
