// ═══════════════════════════════════════════
// SynaBun — rules installer
// ═══════════════════════════════════════════
//
// Puts SynaBun's rules where each AI tool loads them for every project, and
// keeps an untouched copy current:
//
//   claude    owned file  ~/.claude/rules/synabun.md (and each Claude account's config dir)
//   opencode  owned file  <opencode config dir>/synabun.md + one `instructions` entry in config.json
//   codex     block       ~/.codex/AGENTS.md (account homes link to it, or get their own block)
//   gemini    block       ~/.gemini/GEMINI.md
//   cursor    none        User Rules live inside the app: copy and paste ("manual")
//
// What it will not do: create the config directory of a CLI that is not
// installed, overwrite or remove a copy someone edited (unless asked with
// force: an edited copy that is left in place is the user's from then on, and
// SynaBun stops managing it), guess at damaged or duplicate markers (force or
// not), update or remove a block stamped for another tool, delete or replace
// a symlink it did not make (or one that points somewhere else by now), delete
// a file it created once the file holds anything but what SynaBun wrote,
// rewrite JSON it cannot parse or re-serialise JSON it can, take an
// `instructions` entry it did not add out of OpenCode's config, write over a
// change made since it read a file, reinstall a copy the user deleted, or
// touch a project file on its own. Every file is copied to
// <dataHome>/backups/rulesets/<host>/ before it changes.
//
// State: <dataHome>/data/rulesets.json. `revision` goes up by one with every
// operation that saved. `managed` per host is true (SynaBun manages it), false
// (the user opted out) or null (never asked). `created` lists the files and
// directories install made, `links` the symlinks it made and where each
// pointed. OpenCode's row also holds `instructionsEntry`, the exact string
// SynaBun added to config.json. `removal` on a row is a removal that is not
// over: it is saved, with the paths it is about to take, before the first
// copy goes, and it stays when a copy was refused (damaged markers, an
// unreadable file). The next boot finishes it (reconcile), and the record is
// closed with `managed: false` once nothing is left that SynaBun could take.
//
// Two writers. Inside one process nothing interleaves: every operation is
// synchronous from its first read to its last write, and a second one started
// from inside a running one is refused (REENTRANT). Across processes there is
// one writer per data home: every operation that changes anything (install,
// install-all, remove, reconcile, the pasted-copy removal, the setting, the
// notice) runs inside the writer lock of lock.js, from before the state is
// loaded until after it is saved. The state is read from disk inside the lock,
// never from a copy kept in memory. A lock that is still held after
// `lockTimeoutMs` is BUSY (retryable) and a lock file that cannot be used is
// LOCK_UNAVAILABLE: either way nothing is changed, and nothing ever runs
// unlocked. status() only reads and takes no lock.
//
// Other programs (the user's editor, the AI tools) do not take that lock, so
// every carrier write and delete stays conditional: it goes through only while
// the file still holds the bytes that were inspected. One that changed or
// vanished in between is left as it is (CHANGED_UNDERNEATH) and is not written
// again in that call.
//
// What a crash can leave behind (the process dies inside an operation; the
// lock goes with it):
//   - install: a copy on disk that the state does not record yet. It is a
//     copy an explicit install asked for; status shows it, remove takes it,
//     and the boot neither updates nor recreates it until an install records it;
//   - remove: a `removal` record with some copies still there. The next boot
//     finishes it;
//   - a `.synabun-<pid>-*.tmp` file next to a target, and a backup of a file
//     that was not changed after all. Neither is ever read back.

import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmdirSync, statSync,
  symlinkSync, unlinkSync, copyFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { loadLegacyHashes, normalise, renderRuleset, RULESET_HOSTS } from './render.js';
import { findBlocks, findLegacy, isPristine, removeBlock, removeRange, replaceRange, upsertBlock, wrap } from './managed-text.js';
import { backupFile, findBrokenLink, readBytes, readJsonStrict, unlinkIfUnchanged, writeTextAtomic } from './fs-safe.js';
import { addToJsonList, countJsonKey, removeFromJsonList } from './json-edit.js';
import { createWriterLock, DEFAULT_LOCK_TIMEOUT_MS, LOCK_FILE_NAME } from './lock.js';

export const RULESET_STATES = Object.freeze(['not-installed', 'installed', 'newer', 'outdated', 'modified', 'conflict', 'shadowed', 'error', 'manual']);

const HOSTS = Object.freeze({
  claude: { label: 'Claude Code', carrier: 'file' },
  codex: { label: 'Codex CLI', carrier: 'block' },
  opencode: { label: 'OpenCode', carrier: 'file' },
  gemini: { label: 'Gemini CLI', carrier: 'block' },
  cursor: { label: 'Cursor', carrier: 'none' },
});
const MANAGED_HOSTS = Object.freeze(RULESET_HOSTS.filter((host) => HOSTS[host].carrier !== 'none'));
const PROJECT_FILES = Object.freeze([['CLAUDE.md', 'claude'], ['AGENTS.md', 'codex'], ['GEMINI.md', 'gemini']]);
const RANK = Object.freeze({ missing: 0, current: 1, newer: 2, outdated: 3, modified: 4, conflict: 5, error: 6 });
const MAX_SCAN_BYTES = 2 * 1024 * 1024;

function isDir(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}
function isSymlink(path) {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}
function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function unique(list) {
  return [...new Set(list.filter(Boolean))];
}
function withoutBom(text) {
  return text.replace(/^﻿/, '');
}
// semver.org, to the letter: MAJOR.MINOR.PATCH, an optional pre-release and optional build metadata, and no leading
// zero on a numeric identifier. `v2.0.0`, `2.0`, `02.0.0` and `2.0.1-01` are not versions.
const SEMVER_NUMBER = '(?:0|[1-9]\\d*)';
const SEMVER_PRE_PART = `(?:${SEMVER_NUMBER}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER_RE = new RegExp(`^(${SEMVER_NUMBER})\\.(${SEMVER_NUMBER})\\.(${SEMVER_NUMBER})(?:-(${SEMVER_PRE_PART}(?:\\.${SEMVER_PRE_PART})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
/** {core: [major, minor, patch], pre: [...]} of a semver string, or null for anything else. Build metadata does not count. */
function parseSemver(version) {
  const match = SEMVER_RE.exec(typeof version === 'string' ? version : '');
  return match ? { core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])], pre: match[4] ? match[4].split('.') : [] } : null;
}
/** True when version `a` is greater than `b` by semver precedence. A version that is not semver is never greater, and nothing is greater than one. */
function semverGreater(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] > y.core[i];
  if (!x.pre.length || !y.pre.length) return !x.pre.length && y.pre.length > 0; // a release is above its pre-releases
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return false;
    if (q === undefined) return true;
    if (p === q) continue;
    const pNumber = /^\d+$/.test(p);
    const qNumber = /^\d+$/.test(q);
    if (pNumber && qNumber) return BigInt(p) > BigInt(q);
    if (pNumber !== qNumber) return qNumber; // a number sorts below a word
    return p > q;
  }
  return false;
}
/** One identity per file however it is reached: through a symlink, a linked directory, or not created yet. */
function realKey(path, depth = 0) {
  try { return realpathSync(path); } catch { /* not there, or a dangling link */ }
  if (depth < 16) {
    try {
      if (lstatSync(path).isSymbolicLink()) return realKey(resolve(dirname(path), readlinkSync(path)), depth + 1);
    } catch { /* not a link */ }
  }
  const parent = dirname(path);
  if (parent === path) return path;
  return join(realKey(parent, depth), basename(path));
}

function emptyHostState() {
  return { managed: null, installedVersion: null, installedSha: null, path: null, paths: [], created: [], links: [], appliedAt: null, backup: null };
}
function defaultState() {
  const hosts = {};
  for (const host of MANAGED_HOSTS) hosts[host] = emptyHostState();
  return { revision: 0, autoUpdate: true, hosts, notice: null, offerAcked: [] };
}
const INTERRUPTED = 'The removal was interrupted before it finished. SynaBun finishes it the next time it starts.';
function stillChanging(path) {
  return `${path} changed while SynaBun was working on it, so it was left as it is. Try again.`;
}

export function createRulesetInstaller({
  home = process.env.USERPROFILE || process.env.HOME || homedir(),
  dataHome,
  projects = [],
  env = process.env,
  opencodeConfigPath = null,
  render = renderRuleset,
  legacyHashes = null,
  now = () => new Date(),
  log = () => {},
  hooks = {},
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
} = {}) {
  if (!dataHome) throw new Error('createRulesetInstaller requires dataHome');
  if (!home) throw new Error('createRulesetInstaller requires home');
  const statePath = join(dataHome, 'data', 'rulesets.json');
  const backupRoot = join(dataHome, 'backups', 'rulesets');
  // The writer lock of this data home. Used for nothing else, and never opened, read, copied or backed up by
  // anything else: see lock.js for why even one stray look at the file can drop the lock.
  const lockPath = join(dataHome, 'data', LOCK_FILE_NAME);
  const lock = createWriterLock(lockPath, { timeoutMs: lockTimeoutMs });
  const legacy = () => legacyHashes || loadLegacyHashes();
  const stamp = () => now().toISOString();

  // ── One operation at a time ────────────────────────────────────────────────
  // `hooks` are seams for tests, each a point where another program could act
  // (or where a test holds an operation still, inside the lock):
  // afterInspect(host, path, status) once a carrier was read and is about to be
  // written, beforeCommit(path) right before a file (a carrier, config.json,
  // the state file) is checked against what was read and replaced or deleted,
  // afterCheck(path) between that check and a delete, afterSave(revision) once
  // the state file was saved.
  let running = null;
  /** Nothing here is asynchronous, so the only way two operations could overlap in one process is one starting inside the other. */
  function exclusive(name, work) {
    if (running) {
      const error = new Error(`The rules installer is busy with "${running}", so "${name}" cannot start inside it.`);
      error.code = 'REENTRANT';
      throw error;
    }
    running = name;
    try { return work(); } finally { running = null; }
  }
  /**
   * `work()` inside the writer lock of this data home. When the lock cannot be
   * taken, nothing ran and nothing changed: the answer is `refused(why)`, with
   * why = {code: 'BUSY' | 'LOCK_UNAVAILABLE', retryable, error}, and one log line.
   */
  function locked(name, refused, work) {
    return exclusive(name, () => {
      try { lock.enter(); } catch (error) {
        if (error?.code !== 'BUSY' && error?.code !== 'LOCK_UNAVAILABLE') throw error;
        log('rulesets', `${name} skipped: ${error.message}`);
        return refused({ code: error.code, retryable: error.code === 'BUSY', error: error.message });
      }
      try { return work(); } finally { lock.leave(); }
    });
  }
  /** Delete `path` while it still holds `expect`: a file another program changed or took away is left to it. */
  function unlinkUnchanged(path, expect) {
    unlinkIfUnchanged(path, expect, { beforeUnlink: hooks.beforeCommit, afterCheck: hooks.afterCheck });
  }
  /** Replace `path` with `next`, unless it no longer holds `original` (the bytes that were read, or null for no file). */
  function commit(path, next, original) {
    return writeTextAtomic(path, next, { expect: original, beforeRename: hooks.beforeCommit });
  }
  /**
   * Copy `path` to the host's backups, then run `change`. The copy is kept (and returned) only when the change went
   * through: a write that was refused changed nothing, so it leaves no backup and nothing to record either.
   */
  function backedUp(path, host, change) {
    const backup = backupFile(path, join(backupRoot, host));
    try { change(); } catch (error) {
      if (backup) { try { unlinkSync(backup); } catch { /* a stray copy is harmless */ } }
      throw error;
    }
    return backup;
  }

  // ── State ──────────────────────────────────────────────────────────────────
  /** {state, revision, before, saved}: the state as it is on disk now, its revision, its serialised form as loaded, and whether this view was saved. */
  function readState() {
    const state = defaultState();
    const view = () => ({ state, revision: state.revision, before: serialise(state), saved: false });
    let saved;
    try {
      const bytes = readBytes(statePath);
      if (bytes === null) return view();
      saved = readJsonStrict(statePath, { text: bytes.toString('utf8') });
    } catch (error) {
      // Lost state means "never asked" for every host: nothing gets written on a guess.
      log('rulesets', `state file unreadable, starting clean: ${error?.message || error}`);
      state.corrupt = true;
      return view();
    }
    if (!isPlainObject(saved)) return view();
    if (Number.isSafeInteger(saved.revision) && saved.revision > 0) state.revision = saved.revision;
    if (typeof saved.autoUpdate === 'boolean') state.autoUpdate = saved.autoUpdate;
    if (isPlainObject(saved.notice)) state.notice = saved.notice;
    if (Array.isArray(saved.offerAcked)) state.offerAcked = saved.offerAcked.filter((host) => MANAGED_HOSTS.includes(host));
    for (const host of MANAGED_HOSTS) {
      const row = saved.hosts?.[host];
      if (!isPlainObject(row)) continue;
      state.hosts[host] = {
        ...emptyHostState(),
        ...row,
        managed: row.managed === true ? true : row.managed === false ? false : null,
        paths: Array.isArray(row.paths) ? row.paths : [],
        created: Array.isArray(row.created) ? row.created : [],
        links: Array.isArray(row.links) ? row.links.filter((link) => isPlainObject(link) && typeof link.path === 'string' && typeof link.target === 'string') : [],
      };
    }
    return view();
  }
  function serialise(state) {
    const { corrupt, ...rest } = state;
    return JSON.stringify(rest, null, 2) + '\n';
  }
  /**
   * Save the state this view was loaded from, inside the lock. Writes only when
   * something changed (a quiet reconcile leaves the disk alone), in one atomic
   * replace. The revision is the loaded one plus one, however many times one
   * operation saves (a removal saves its intent first, then its outcome).
   */
  function saveState(view) {
    const { state } = view;
    const text = () => serialise(state);
    if (!state.corrupt && text() === view.before) return false;
    state.revision = view.revision + 1;
    mkdirSync(dirname(statePath), { recursive: true });
    if (state.corrupt) { try { copyFileSync(statePath, `${statePath}.corrupt`); } catch { /* nothing to keep */ } }
    writeTextAtomic(statePath, text(), { beforeRename: hooks.beforeCommit });
    delete state.corrupt;
    view.before = text();
    view.saved = true;
    if (hooks.afterSave) hooks.afterSave(state.revision);
    return true;
  }

  // ── One operation: lock, load, work, save ──────────────────────────────────
  // What one call did, per host: what changed, the files, directories and
  // links it made, and the copies it found current.
  function newTally() {
    const tally = { changed: false, backupPath: null, legacy: [], warnings: [], created: [], paths: [], links: [] };
    tally.backup = (path) => { if (path && !tally.backupPath) tally.backupPath = path; };
    return tally;
  }
  function newCall(view) {
    const tallies = new Map();
    const tally = (host) => {
      if (!tallies.has(host)) tallies.set(host, newTally());
      return tallies.get(host);
    };
    // checkpoint(): save the state as it stands, before the operation goes on (a removal records its intent this way).
    return { tally, checkpoint: () => saveState(view) };
  }
  /** The row's own record plus what this call added to it. */
  function mergedRecord(row, tally) {
    const relinked = new Set(tally.links.map((link) => link.path));
    return {
      created: unique([...row.created, ...tally.created]),
      paths: unique([...row.paths, ...tally.paths]),
      links: [...row.links.filter((link) => !relinked.has(link.path)), ...tally.links],
    };
  }
  /**
   * One operation against the state file, inside the writer lock: the state is
   * loaded from disk, `work(state, call)` does the carrier work and changes
   * `state`, and the state is saved. Returns [result, wrote]; when the lock
   * could not be taken, [refused(why), false] and nothing ran.
   */
  function transact(name, refused, work) {
    return locked(name, (why) => [refused(why), false], () => {
      const view = readState();
      const result = work(view.state, newCall(view));
      saveState(view);
      return [result, view.saved];
    });
  }
  function uniqueNotes(notes) {
    const seen = new Set();
    return notes.filter((note) => {
      const key = [note.path, note.host, note.kind, ...(note.hosts || [])].join('\n');
      return !seen.has(key) && seen.add(key);
    });
  }

  // ── Where things live ──────────────────────────────────────────────────────
  // Resolved the way the MCP toggle routes resolve them: Claude, Codex and
  // Gemini under the home directory, OpenCode under XDG_CONFIG_HOME when set.
  function layout() {
    // The server passes the resolver its /api/opencode/mcp toggle uses, so both always edit the same file.
    const opencodeConfig = opencodeConfigPath
      ? resolve(opencodeConfigPath())
      : join(env?.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, 'opencode') : join(home, '.config', 'opencode'), 'config.json');
    return {
      claudeDir: join(home, '.claude'),
      codexHome: join(home, '.codex'),
      geminiDir: join(home, '.gemini'),
      opencodeDir: dirname(opencodeConfig),
      opencodeConfig,
    };
  }
  /** Extra account directories from SynaBun's own registries (data/claude-accounts.json, data/codex-accounts.json). */
  function accountHomes(registry, defaultHome) {
    try {
      const data = JSON.parse(readFileSync(join(dataHome, 'data', registry), 'utf8'));
      const base = realKey(defaultHome);
      return unique((data?.accounts || [])
        .filter((row) => row && row.id !== 'default' && typeof row.home === 'string' && row.home)
        .map((row) => resolve(row.home)))
        .filter((dir) => isDir(dir) && realKey(dir) !== base);
    } catch {
      return [];
    }
  }
  function codexAccounts() {
    const { codexHome } = layout();
    const primaryKey = realKey(join(codexHome, 'AGENTS.md'));
    return accountHomes('codex-accounts.json', codexHome).map((dir) => {
      const path = join(dir, 'AGENTS.md');
      let present = true;
      try { lstatSync(path); } catch { present = false; }
      const kind = !present ? 'absent' : realKey(path) === primaryKey ? 'linked' : 'file';
      return { dir, path, kind };
    });
  }
  /** Every carrier of a host, the default location first. */
  function targets(host) {
    const where = layout();
    if (host === 'claude') {
      const seen = new Set();
      const list = [];
      for (const dir of [where.claudeDir, ...accountHomes('claude-accounts.json', where.claudeDir)]) {
        const path = join(dir, 'rules', 'synabun.md');
        const key = realKey(path);
        if (seen.has(key)) continue;
        seen.add(key);
        list.push({ path, dir, legacyFile: join(dir, 'CLAUDE.md') });
      }
      return list;
    }
    if (host === 'opencode') {
      return [{ path: join(where.opencodeDir, 'synabun.md'), dir: where.opencodeDir, legacyFile: join(where.opencodeDir, 'AGENTS.md') }];
    }
    if (host === 'codex') {
      return [
        { path: join(where.codexHome, 'AGENTS.md'), dir: where.codexHome },
        ...codexAccounts().filter((account) => account.kind === 'file').map(({ path, dir }) => ({ path, dir })),
      ];
    }
    if (host === 'gemini') return [{ path: join(where.geminiDir, 'GEMINI.md'), dir: where.geminiDir }];
    return [];
  }
  function projectPaths() {
    let list = [];
    try { list = typeof projects === 'function' ? projects() : projects; } catch { list = []; }
    return unique((Array.isArray(list) ? list : []).map((entry) => (typeof entry === 'string' ? entry : entry?.path)).filter((path) => typeof path === 'string' && path));
  }
  function mcpRegistered(host) {
    const where = layout();
    try {
      if (host === 'claude') return !!JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))?.mcpServers?.SynaBun;
      if (host === 'gemini') return !!JSON.parse(readFileSync(join(where.geminiDir, 'settings.json'), 'utf8'))?.mcpServers?.SynaBun;
      if (host === 'codex') return /^\[mcp_servers\.SynaBun\]/m.test(readFileSync(join(where.codexHome, 'config.toml'), 'utf8'));
      if (host === 'opencode') return !!JSON.parse(readFileSync(where.opencodeConfig, 'utf8'))?.mcp?.SynaBun;
    } catch { /* no config, no registration */ }
    return false;
  }

  // ── Reading what is on disk ────────────────────────────────────────────────
  function expectedBlock(host) {
    const rendered = render(host);
    const block = wrap(rendered.text, { version: rendered.version, host });
    return { block, version: rendered.version, sha: findBlocks(block).blocks[0].sha };
  }
  function foreignBlock(host, block, path) {
    return `The SynaBun block in ${path} is stamped for ${HOSTS[block.host]?.label || block.host} (host=${block.host}), not for ${HOSTS[host].label}, so SynaBun leaves it alone.`;
  }
  /** The sentence for a link that leads nowhere: nothing is read through it, and nothing is ever written through it. */
  function brokenLinkDetail(path, broken) {
    const through = broken.link === path ? '' : ` (${path} leads to it)`;
    return `${broken.link}${through} is a symbolic link to ${broken.target}, which does not exist. SynaBun does not write through a broken link: fix or remove the link, then install again.`;
  }
  /** What install and reconcile say about an untouched copy stamped with a version above the one this SynaBun ships. */
  function newerDetail(path, block, expected) {
    return `${path} holds version ${block.version} of the SynaBun rules, written by a newer SynaBun than this one (${expected.version}), so it is left as it is.`;
  }
  /**
   * missing | current | newer (untouched, stamped with a greater version than this SynaBun ships) | outdated (untouched,
   * other text) | modified (edited) | conflict (damaged markers, or another tool's stamp) | error.
   * `bytes` is what the file held when it was read: the one thing a later write or delete is checked against.
   */
  function inspect(host, target, expected) {
    let bytes;
    try { bytes = readBytes(target.path); } catch (error) {
      return { status: 'error', detail: `Could not read ${target.path}: ${error?.message || error}` };
    }
    if (bytes === null) {
      let broken = null;
      try { broken = findBrokenLink(target.path); } catch (error) {
        return { status: 'error', detail: `Could not read ${target.path}: ${error?.message || error}` };
      }
      return broken ? { status: 'error', detail: brokenLinkDetail(target.path, broken) } : { status: 'missing' };
    }
    const text = bytes.toString('utf8');
    const { blocks, conflict } = findBlocks(text);
    if (conflict) {
      // Never settled by overwriting, forced or not: the message is the way out.
      const repair = HOSTS[host].carrier === 'file'
        ? 'remove the extra or damaged SynaBun marker lines, or delete the file, then install again'
        : 'remove the extra or damaged SynaBun marker lines by hand, then install again';
      return { status: 'conflict', text, bytes, detail: `${conflict.message} in ${target.path}. SynaBun will not guess which part is its own, and Replace does not apply here: ${repair}.` };
    }
    const block = blocks[0] || null;
    // A stamp for another tool is not this host's copy, however untouched it is: never updated, never removed.
    if (block && block.host !== host) return { status: 'conflict', text, bytes, detail: `${foreignBlock(host, block, target.path)} Replace does not apply here: take that block out by hand, then install again.` };
    if (HOSTS[host].carrier === 'file') {
      if (normalise(text) === expected.block) return { status: 'current', text, bytes, block };
      if (!block) return { status: 'modified', text, bytes, block, detail: `${target.path} has no SynaBun markers, so SynaBun treats it as your own file and never replaces it. Move or delete it, then install again.` };
      const untouched = isPristine(block) && withoutBom(text.slice(0, block.start) + text.slice(block.eolEnd)).trim() === '';
      if (!untouched) return { status: 'modified', text, bytes, block, detail: `${target.path} was edited, so SynaBun leaves it alone.` };
      return untouchedCopy(target, expected, { text, bytes, block });
    }
    if (!block) return { status: 'missing', text, bytes };
    if (normalise(block.text) === expected.block) return { status: 'current', text, bytes, block };
    if (isPristine(block)) return untouchedCopy(target, expected, { text, bytes, block });
    return { status: 'modified', text, bytes, block, detail: `The SynaBun block in ${target.path} was edited, so SynaBun leaves it alone.` };
  }

  /**
   * An untouched copy that is not the text this SynaBun ships. Two SynaBun versions can share one data home: a copy
   * stamped with a greater version is the newer one's and is never downgraded (`newer`); anything else is `outdated`.
   */
  function untouchedCopy(target, expected, found) {
    if (!semverGreater(found.block.version, expected.version)) return { status: 'outdated', ...found };
    return { status: 'newer', ...found, detail: newerDetail(target.path, found.block, expected) };
  }

  // ── OpenCode's `instructions` entry ────────────────────────────────────────
  function opencodeEntry() {
    return join(layout().opencodeDir, 'synabun.md').replace(/\\/g, '/');
  }
  function samePath(a, b) {
    return typeof a === 'string' && resolve(a) === resolve(b);
  }
  /**
   * The file an `instructions` entry of `configPath` names, or null when the entry is not one plain path: a URL, or
   * a pattern with glob characters. A leading `~` is the installer's home, and a relative path starts at the
   * directory of config.json (never at this process's working directory).
   */
  function entryFile(value, configPath) {
    if (typeof value !== 'string' || !value) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /[*?[\]{}]/.test(value)) return null;
    const path = value === '~' || /^~[\\/]/.test(value) ? join(home, value.slice(1)) : value;
    return resolve(dirname(configPath), path);
  }
  /**
   * True when an entry leads to SynaBun's owned file, however it is spelled: `~/...`, a relative path, or a symlink
   * to the file. Compared by real path when both exist, by the normalised string otherwise.
   */
  function entryIsOwnedFile(value, configPath) {
    const path = entryFile(value, configPath);
    if (path === null) return false;
    const owned = join(layout().opencodeDir, 'synabun.md');
    if (path === resolve(owned)) return true;
    try { return realpathSync(path) === realpathSync(owned); } catch { return false; }
  }
  function readOpencodeConfig() {
    const path = layout().opencodeConfig;
    const entry = opencodeEntry();
    const refuse = (why) => ({ path, exists: true, hasEntry: false, cfg: null, text: null, bytes: null, error: `${path} ${why}. SynaBun will not rewrite it: fix the file, or add "${entry}" to its "instructions" list by hand.` });
    let bytes;
    let text;
    let cfg;
    // Read once: the bytes that are parsed are the bytes a later write is checked against.
    try { bytes = readBytes(path); } catch (error) { return refuse(`could not be read (${error?.message || error})`); }
    if (bytes === null) {
      // A link that leads nowhere is not "no config yet": creating the file would write through it, or over it.
      let broken = null;
      try { broken = findBrokenLink(path); } catch (error) { return refuse(`could not be read (${error?.message || error})`); }
      if (broken) return refuse(`is a broken symbolic link (${broken.link} points at ${broken.target}, which does not exist)`);
      return { path, exists: false, hasEntry: false, cfg: null, text: null, bytes: null, error: null };
    }
    try { text = bytes.toString('utf8'); cfg = readJsonStrict(path, { text }); } catch (error) {
      return refuse(error?.code === 'INVALID_JSON' ? 'is not plain JSON (a syntax error, or comments)' : `could not be read (${error?.message || error})`);
    }
    if (!isPlainObject(cfg)) return refuse('does not hold a JSON object');
    if (cfg.instructions !== undefined && !Array.isArray(cfg.instructions)) return refuse('has an "instructions" value that is not a list');
    // JSON.parse keeps the last of two keys: an edit of either one would strand an entry or lose the other list.
    let lists;
    try { lists = countJsonKey(text, 'instructions'); } catch { return refuse('has a layout SynaBun cannot edit safely'); }
    if (lists > 1) return refuse('has more than one top-level "instructions" key (only the last one counts)');
    return { path, exists: true, hasEntry: (cfg.instructions || []).some((value) => entryIsOwnedFile(value, path)), cfg, text, bytes, error: null };
  }
  /**
   * The text of config.json after `edit()`, accepted only when it parses to
   * exactly `cfg`. There is no other way to write this file: when the edit
   * cannot be made on the text, SynaBun refuses rather than write the whole
   * object out again and lose what the user's file spells its own way.
   */
  function configText(path, cfg, edit) {
    try {
      const text = edit();
      if (isDeepStrictEqual(JSON.parse(withoutBom(text)), cfg)) return text;
    } catch { /* text the editor could not follow */ }
    throw new Error(`${path} could not be edited safely, so SynaBun did not write it. Change its "instructions" list by hand: the entry is "${opencodeEntry()}".`);
  }
  /** What install writes when there is no config.json yet: remove deletes the file only while it still holds exactly this. */
  function newConfigText(value) {
    return addToJsonList('{}\n', 'instructions', value);
  }
  /** The string SynaBun added to `config`, when its record is about this very file and the string is still listed. */
  function ownedEntry(row, config) {
    const owned = row.instructionsEntry;
    if (!owned || typeof owned.value !== 'string' || !config.exists || !config.cfg || !samePath(owned.config, config.path)) return null;
    return (config.cfg.instructions || []).includes(owned.value) ? owned.value : null;
  }
  /**
   * The `instructions` entries that resolve to SynaBun's owned file and that SynaBun has no record of adding: the
   * user's own lines, however they are spelled (`~/...`, relative to config.json, a symlink to the file). One listing
   * of the recorded string is SynaBun's; every other is theirs. A URL or a glob pattern is never one of them.
   */
  function userEntries(row, config) {
    if (!config.exists || !config.cfg) return [];
    const list = config.cfg.instructions || [];
    const mine = ownedEntry(row, config) === null ? -1 : list.lastIndexOf(row.instructionsEntry.value);
    return list.filter((value, index) => index !== mine && entryIsOwnedFile(value, config.path));
  }
  /**
   * One change to config.json. `plan(config)` answers null (nothing to do) or
   * {text, done?}; `text: null` deletes the file. The file is replaced only
   * while it still holds the bytes that were read: a change by another program
   * in between is CHANGED_UNDERNEATH, and config.json is left to it.
   */
  function editOpencodeConfig(tally, plan) {
    const config = readOpencodeConfig();
    if (config.error) throw new Error(config.error);
    const step = plan(config);
    if (!step) return;
    const change = () => {
      if (step.text === null) unlinkUnchanged(config.path, config.bytes);
      else writeTextAtomic(config.path, step.text, { expect: config.bytes, beforeRename: hooks.beforeCommit });
    };
    if (config.exists) tally.backup(backedUp(config.path, 'opencode', change));
    else change();
    tally.changed = true;
    if (step.done) step.done();
  }
  /** Lists synabun.md in config.json unless it is listed already, and records the string SynaBun added. */
  function addOpencodeEntry(row, tally) {
    const value = opencodeEntry();
    let listed = null;
    editOpencodeConfig(tally, (config) => {
      listed = config;
      if (config.hasEntry) return null;
      const cfg = { ...(config.cfg || {}), instructions: [...(config.cfg?.instructions || []), value] };
      return {
        text: configText(config.path, cfg, () => (config.exists ? addToJsonList(config.text, 'instructions', value) : newConfigText(value))),
        done: () => {
          if (!config.exists) tally.created.push(config.path);
          if (config.cfg?.instructions === undefined) tally.created.push(`${config.path}#instructions`);
          row.instructionsEntry = { config: config.path, value };
          listed = null;
        },
      };
    });
    // Listed already: ours from an earlier install when the recorded string is still there, otherwise the user's own.
    const owned = row.instructionsEntry;
    if (listed && owned && !(samePath(owned.config, listed.path) && (listed.cfg.instructions || []).includes(owned.value))) delete row.instructionsEntry;
  }
  /**
   * Takes out the one string SynaBun added. An entry the user wrote, however it
   * is spelled, is touched only with `theirs`: a forced remove, which takes
   * every line that points at the owned file so that none is left pointing at
   * a file that is gone. Each entry is edited out of the text on its own.
   */
  function removeOpencodeEntry(row, tally, { theirs = false } = {}) {
    editOpencodeConfig(tally, (config) => {
      if (!config.exists) return null;
      const mine = ownedEntry(row, config);
      const others = theirs ? userEntries(row, config) : [];
      if (mine === null && !others.length) return null;
      // A config.json install created goes only while its bytes are still what install wrote. Anything the user
      // added since makes it their file: the entries are edited out and the file stays.
      if (mine !== null && row.created.includes(config.path) && config.text === newConfigText(mine)) return { text: null };
      const dropKey = row.created.includes(`${config.path}#instructions`);
      const drop = [...(mine === null ? [] : [mine]), ...others];
      const list = [...(config.cfg.instructions || [])];
      for (const value of drop) list.splice(list.lastIndexOf(value), 1);
      const cfg = { ...config.cfg, instructions: list };
      if (!list.length && dropKey) delete cfg.instructions;
      return {
        text: configText(config.path, cfg, () => drop.reduce(
          (text, value, index) => removeFromJsonList(text, 'instructions', value, { dropEmptyKey: dropKey && index === drop.length - 1 }), config.text)),
      };
    });
  }

  // ── Writing ────────────────────────────────────────────────────────────────
  /**
   * The pasted copies in `text`, sorted by what install may do with them:
   * `own` are hash-exact copies of a ruleset served for this very host, the
   * only ones replaced without asking. A hash-exact copy of another tool's
   * rules and a heading-only match are `notes`: left alone, reported for review.
   */
  function sortLegacy(host, path, text) {
    const spans = findLegacy(text, legacy());
    const exact = spans.filter((span) => span.kind === 'exact');
    const own = exact.filter((span) => (span.hosts || []).includes(host));
    const others = exact.filter((span) => !own.includes(span));
    const notes = [];
    if (spans.some((span) => span.kind === 'heading')) notes.push({ path, host, kind: 'heading' });
    if (others.length) notes.push({ path, host, kind: 'other-host', hosts: unique(others.flatMap((span) => span.hosts || [])) });
    return { own, notes };
  }
  /**
   * Take this host's hash-exact pasted copies out of a file. Everything else is
   * reported, never edited. A file that changed since it was read is left as it
   * is, with a warning: the copy stays on the list of pasted copies.
   */
  function stripLegacy(host, file, tally) {
    let bytes;
    try { bytes = readBytes(file); } catch { return; }
    if (bytes === null) return;
    const text = bytes.toString('utf8');
    const { own, notes } = sortLegacy(host, file, text);
    tally.legacy.push(...notes);
    if (!own.length) return;
    let next = text;
    for (const span of [...own].reverse()) next = removeRange(next, span.start, span.end);
    try { tally.backup(backedUp(file, host, () => commit(file, next, bytes))); } catch (error) {
      if (error?.code !== 'CHANGED_UNDERNEATH') throw error;
      tally.warnings.push(`${file} changed while SynaBun was taking the pasted copy out of it, so it was left as it is.`);
      return;
    }
    tally.changed = true;
  }
  /**
   * One carrier. Returns the status it ended in; writes only when the copy is
   * missing, untouched and old, or (forced) one well-formed copy that was
   * edited or that a newer SynaBun wrote. Damaged or duplicate markers are
   * refused whatever `force` says, and so is an owned file without any marker:
   * neither is a copy SynaBun can vouch for.
   *
   * One look, one write: the file is replaced only while it still holds the
   * bytes that were inspected. When it changed or vanished in between, the
   * answer is an error with code CHANGED_UNDERNEATH and the carrier is left as
   * it is; nothing here looks again and writes after all.
   */
  function applyTarget(host, target, expected, { force = false } = {}, tally) {
    const found = inspect(host, target, expected);
    if (found.status === 'current' || found.status === 'error' || found.status === 'conflict') return found;
    if (found.status === 'modified' && !(force && found.block)) return found;
    if (found.status === 'newer' && !force) return found; // never downgraded on its own
    if (hooks.afterInspect) hooks.afterInspect(host, target.path, found.status);
    const original = found.bytes ?? null;
    const notes = [];
    let next;
    let madeDir = null;

    if (HOSTS[host].carrier === 'file') {
      next = `${expected.block}\n`;
      const dir = dirname(target.path);
      if (!isDir(dir)) {
        // The file was read a moment ago, so its directory was there: it went away with the file since.
        if (original !== null) return { status: 'error', code: 'CHANGED_UNDERNEATH', detail: stillChanging(target.path) };
        // Only the leaf (`rules/`): a missing CLI directory was refused before we got here.
        mkdirSync(dir);
        tally.created.push(dir);
        madeDir = dir;
      }
    } else {
      const text = found.text ?? '';
      if (found.block) {
        next = upsertBlock(text, expected.block);
      } else {
        const sorted = sortLegacy(host, target.path, text);
        notes.push(...sorted.notes);
        if (sorted.own.length) {
          // The pasted copy becomes the managed block where it stood; later duplicates go.
          next = text;
          for (const span of sorted.own.slice(1).reverse()) next = removeRange(next, span.start, span.end);
          next = replaceRange(next, sorted.own[0].start, sorted.own[0].end, expected.block);
        } else {
          next = upsertBlock(text, expected.block);
        }
      }
      // A block added below a code fence that never closes would be quoted text, and be added again next time.
      const check = findBlocks(next);
      if (check.conflict || check.blocks.length !== 1 || normalise(check.blocks[0].text) !== expected.block) {
        return { status: 'error', text, detail: `${target.path} has a code fence that is never closed, so a block added to it would read as part of that code. Close the fence, then install again.` };
      }
    }
    try {
      if (original === null) commit(target.path, next, original);
      else tally.backup(backedUp(target.path, host, () => commit(target.path, next, original)));
    } catch (error) {
      if (madeDir) {
        // Nothing went into the directory this call made for the file: it goes again, while it is empty.
        try { rmdirSync(madeDir); tally.created = tally.created.filter((path) => path !== madeDir); } catch { /* in use by now: it stays on record */ }
      }
      if (error?.code !== 'CHANGED_UNDERNEATH') throw error;
      return { status: 'error', code: 'CHANGED_UNDERNEATH', detail: error.message };
    }
    if (original === null) tally.created.push(target.path);
    tally.legacy.push(...notes);
    tally.changed = true;
    return { status: 'current', written: true };
  }
  /** True while `link.path` is a symlink that still points where install pointed it. */
  function isOwnLink(link) {
    try {
      return lstatSync(link.path).isSymbolicLink() && resolve(dirname(link.path), readlinkSync(link.path)) === resolve(dirname(link.path), link.target);
    } catch {
      return false;
    }
  }
  /**
   * Codex account homes without an AGENTS.md get a link to the shared one, as config.toml and prompts do.
   * Each link is recorded with where it points: that pair, not the path alone, is what remove may unlink.
   */
  function linkCodexAccounts(row, tally, { onlyNew = false } = {}) {
    const primary = join(layout().codexHome, 'AGENTS.md');
    if (!existsSync(primary)) return [];
    const added = [];
    for (const account of codexAccounts()) {
      if (account.kind !== 'absent') continue;
      if (onlyNew && row.paths.includes(account.path)) continue;
      try {
        symlinkSync(primary, account.path, 'file');
        tally.links = [...tally.links.filter((link) => link.path !== account.path), { path: account.path, target: primary }];
        tally.changed = true;
      } catch (error) {
        tally.warnings.push(`Could not link ${account.path}: ${error?.message || error}`);
        continue;
      }
      added.push(account.path);
    }
    return added;
  }
  function notInstalled(host, primary) {
    return `${HOSTS[host].label} does not seem to be installed: ${primary.dir} does not exist, and SynaBun does not create it.`;
  }
  function assertHost(host) {
    if (!RULESET_HOSTS.includes(host)) {
      const error = new Error(`Unknown host: ${host}. Use ${RULESET_HOSTS.join(', ')}.`);
      error.code = 'UNKNOWN_HOST';
      throw error;
    }
  }

  // ── Status ─────────────────────────────────────────────────────────────────
  function hostStatus(host, state) {
    const info = HOSTS[host];
    if (info.carrier === 'none') {
      return { carrier: 'none', path: null, state: 'manual', installedVersion: null, managed: null, error: null, detail: 'Cursor keeps User Rules inside the app: copy the text and paste it into Cursor Settings > Rules.' };
    }
    const row = state.hosts[host];
    const list = targets(host);
    const primary = list[0];
    const out = {
      carrier: info.carrier, path: primary.path, state: 'not-installed', installedVersion: null, managed: row.managed, error: null,
      detail: null, detected: isDir(primary.dir), mcp: mcpRegistered(host), paths: [], appliedAt: row.appliedAt || null, backup: row.backup || null,
    };
    if (!out.detected) return out;
    let expected;
    try { expected = expectedBlock(host); } catch (error) {
      return { ...out, state: 'error', error: `Could not render the ${host} rules: ${error?.message || error}` };
    }
    // A removal that could not finish: what stayed behind and why, until a remove or an install completes.
    if (isPlainObject(row.removal)) out.partialRemoval = { at: row.removal.at || null, error: row.removal.error || null, paths: Array.isArray(row.removal.paths) ? row.removal.paths : [] };
    const first = inspect(host, primary, expected);
    let worst = first;
    let replaceable = false;
    let unlisted = null;
    for (const target of list) {
      const found = target === primary ? first : inspect(host, target, expected);
      if (found.status !== 'missing') out.paths.push(target.path);
      if (found.status === 'modified' && found.block) replaceable = true;
      if (RANK[found.status] > RANK[worst.status]) worst = found;
    }
    if (first.block) out.installedVersion = first.block.version;
    if (host === 'opencode') {
      const config = readOpencodeConfig();
      const sideFiles = ['opencode.json', 'opencode.jsonc'].filter((name) => existsSync(join(primary.dir, name)));
      if (sideFiles.length) out.notes = [`OpenCode also reads ${sideFiles.join(' and ')} in ${primary.dir}; SynaBun writes config.json, the same file its MCP toggle uses.`];
      if (config.error) return { ...out, state: 'error', error: config.error, detail: config.error };
      if (first.status !== 'missing' && !config.hasEntry) {
        unlisted = `${config.path} does not list it under "instructions", so OpenCode does not load it.`;
        // An untouched file that is merely not listed is "not installed". An edited or damaged one keeps its own
        // state below, so the status never hides what an install would be refused for.
        if (first.status === 'current' || first.status === 'outdated' || first.status === 'newer') {
          return { ...out, state: 'not-installed', installedVersion: null, detail: `${primary.path} exists, but ${unlisted}` };
        }
      }
      // A line in config.json that SynaBun did not add points at the file: a remove keeps both unless it is forced.
      if (first.status !== 'missing' && userEntries(row, config).length) out.entry = 'user';
    }
    if (first.status === 'missing' && RANK[worst.status] < RANK.error) return { ...out, installedVersion: null };
    out.state = { current: 'installed', newer: 'newer', outdated: 'outdated', modified: 'modified', conflict: 'conflict', error: 'error' }[worst.status];
    out.detail = worst.detail || null;
    // An owned file without markers is the user's own: Replace (force) is refused for it.
    if (out.state === 'modified' && !replaceable) out.replaceable = false;
    if (worst.status === 'conflict' || worst.status === 'error') out.error = worst.detail || null;
    if (unlisted) {
      out.detail = [out.detail, `Also, ${unlisted}`].filter(Boolean).join(' ');
      if (out.error) out.error = out.detail;
    }
    if (host === 'codex') {
      const shadows = unique([primary.dir, ...codexAccounts().map((account) => account.dir)]).map((dir) => join(dir, 'AGENTS.override.md')).filter((path) => existsSync(path));
      if (shadows.length) {
        out.shadowedBy = shadows;
        if (out.state === 'installed') {
          out.state = 'shadowed';
          out.detail = `${shadows.join(', ')} takes precedence: Codex reads it instead of AGENTS.md in that directory, so the rules are not loaded there.`;
        }
      }
    }
    return out;
  }

  function legacyCandidates() {
    const list = [];
    const seen = new Set();
    const add = (path, host, scope) => {
      if (!path || !existsSync(path)) return;
      const key = realKey(path);
      if (seen.has(key)) return;
      seen.add(key);
      list.push({ path, host, scope });
    };
    for (const target of targets('claude')) add(target.legacyFile, 'claude', 'global');
    for (const target of targets('codex')) add(target.path, 'codex', 'global');
    for (const target of targets('gemini')) add(target.path, 'gemini', 'global');
    for (const target of targets('opencode')) add(target.legacyFile, 'opencode', 'global');
    for (const dir of projectPaths()) {
      for (const [name, host] of PROJECT_FILES) add(join(dir, name), host, 'project');
    }
    return list;
  }
  function scanLegacy() {
    const hashes = legacy();
    const found = [];
    for (const candidate of legacyCandidates()) {
      try {
        if (statSync(candidate.path).size > MAX_SCAN_BYTES) continue;
        const spans = findLegacy(readFileSync(candidate.path, 'utf8'), hashes);
        if (!spans.length) continue;
        found.push({ ...candidate, kind: spans.some((span) => span.kind === 'exact') ? 'exact' : 'heading', count: spans.length });
      } catch { /* unreadable: nothing to report */ }
    }
    return found;
  }
  function offerHosts(state) {
    return MANAGED_HOSTS.filter((host) => state.hosts[host].managed === null && !state.offerAcked.includes(host) && isDir(targets(host)[0].dir) && mcpRegistered(host));
  }

  function status() {
    const { state } = readState();
    const hosts = {};
    for (const host of RULESET_HOSTS) hosts[host] = hostStatus(host, state);
    let version = null;
    try { version = render('claude').version; } catch { /* reported per host */ }
    const offer = offerHosts(state);
    const notice = state.notice || (offer.length ? { kind: 'offer-install', hosts: offer } : null);
    return { ok: true, version, autoUpdate: state.autoUpdate, hosts, legacy: scanLegacy(), notice };
  }

  // ── Install / remove ───────────────────────────────────────────────────────
  /** The answer of install and remove when the writer lock could not be taken: nothing ran, nothing changed. */
  function lockRefusal(host, why) {
    let state = 'error';
    try { state = hostStatus(host, readState().state).state; } catch { /* the refusal is the news */ }
    return { ok: false, ...why, host, state, path: targets(host)[0]?.path || null, changed: false, backupPath: null };
  }

  function install(host, { force = false } = {}) {
    assertHost(host);
    if (HOSTS[host].carrier === 'none') return { ok: true, host, state: 'manual', path: null, changed: false, backupPath: null };
    return transact(`install ${host}`, (why) => lockRefusal(host, why), (state, call) => installHost(state, host, { force }, call))[0];
  }
  function installHost(state, host, { force }, call) {
    const row = state.hosts[host];
    const list = targets(host);
    const primary = list[0];
    const tally = call.tally(host);
    const base = { host, path: primary.path };
    const done = () => ({ changed: tally.changed, backupPath: tally.backupPath });
    if (!isDir(primary.dir)) return { ok: false, ...base, ...done(), state: 'not-installed', error: notInstalled(host, primary) };

    const expected = expectedBlock(host);
    if (host === 'opencode') {
      const config = readOpencodeConfig();
      if (config.error) return { ok: false, ...base, ...done(), state: 'error', error: config.error };
    }
    // What was already written stays recorded when the install stops halfway (a directory it made, a copy it
    // wrote), so a later remove still finds it. `managed` is not touched: nothing was agreed to yet.
    const keepRecord = () => {
      Object.assign(row, mergedRecord(row, tally));
      if (tally.backupPath) row.backup = tally.backupPath;
    };
    const fail = (found) => {
      keepRecord();
      const result = { ok: false, ...base, state: found.status === 'error' ? 'error' : found.status, ...done(), error: found.detail || `Could not install the ${host} rules.` };
      if (found.code) result.code = found.code;
      return result;
    };

    try {
      // A copy a newer SynaBun wrote counts as installed: it is left as it is (unless forced) and recorded as found.
      const first = applyTarget(host, primary, expected, { force }, tally);
      if (first.status !== 'current' && first.status !== 'newer') return fail(first);
      tally.paths.push(primary.path);
      for (const target of list.slice(1)) {
        const found = applyTarget(host, target, expected, { force }, tally);
        if (found.status === 'current' || found.status === 'newer') tally.paths.push(target.path);
        else if (found.detail) tally.warnings.push(found.detail);
      }
      if (host === 'codex') tally.paths.push(...linkCodexAccounts(row, tally));
      if (HOSTS[host].carrier === 'file') {
        const seen = new Set();
        for (const target of list) {
          const key = realKey(target.legacyFile);
          if (seen.has(key)) continue;
          seen.add(key);
          stripLegacy(host, target.legacyFile, tally);
        }
      }
      if (host === 'opencode') addOpencodeEntry(row, tally);

      Object.assign(row, {
        managed: true,
        installedVersion: first.status === 'newer' ? first.block.version : expected.version,
        installedSha: first.status === 'newer' ? first.block.sha : expected.sha,
        path: primary.path,
        ...mergedRecord(row, tally),
        appliedAt: tally.changed || !row.appliedAt ? stamp() : row.appliedAt,
        backup: tally.backupPath || row.backup || null,
      });
      delete row.removal;
      state.offerAcked = state.offerAcked.filter((name) => name !== host);
    } catch (error) {
      log('rulesets', `install ${host} failed: ${error?.message || error}`);
      keepRecord();
      const result = { ok: false, ...base, state: error?.name === 'ManagedTextConflict' ? 'conflict' : 'error', ...done(), error: error?.message || String(error) };
      if (error?.code === 'CHANGED_UNDERNEATH') result.code = error.code;
      return result;
    }
    const result = { ok: true, ...base, state: hostStatus(host, state).state, ...done() };
    const legacyNotes = uniqueNotes(tally.legacy);
    const warnings = unique(tally.warnings);
    if (legacyNotes.length) result.legacy = legacyNotes;
    if (warnings.length) result.warnings = warnings;
    return result;
  }

  /**
   * What an owned whole-file carrier is, before remove may delete it:
   *   absent, foreign  nothing of SynaBun's (foreign: skipped without a word)
   *   pristine         still exactly what SynaBun wrote: deleted
   *   edited           one well-formed copy the user changed: theirs, deleted only when asked with force
   *   no-markers       SynaBun wrote here once, the markers are gone: the user's own file, never deleted
   *   symlink, conflict, error   refused, forced or not (conflict: damaged markers, or a block stamped for another tool)
   */
  function ownedFile(host, path, recorded) {
    let info;
    try { info = lstatSync(path); } catch { return { kind: 'absent' }; }
    let text;
    try { text = readFileSync(path, 'utf8'); } catch (error) {
      if (error?.code === 'ENOENT') return { kind: 'absent' }; // a link to nothing: no rules there, and not ours to tidy
      return { kind: 'error', message: `Could not read ${path}: ${error?.message || error}` };
    }
    const { blocks, conflict } = findBlocks(text);
    // A rules/synabun.md that never held a SynaBun block is someone's own file.
    if (!blocks.length && !conflict && !recorded) return { kind: 'foreign' };
    if (info.isSymbolicLink()) return { kind: 'symlink', message: `${path} is a symbolic link, and SynaBun never deletes a link or the file behind it. Remove the link yourself if you no longer want these rules.` };
    if (conflict) return { kind: 'conflict', message: `${conflict.message} in ${path}, so SynaBun left the file in place. Delete it yourself if you no longer want these rules.` };
    const block = blocks[0];
    if (!block) return { kind: 'no-markers', message: `${path} has no SynaBun markers any more, so it is your own file: SynaBun left it in place and no longer manages it.` };
    if (block.host !== host) return { kind: 'conflict', foreign: true, message: `${foreignBlock(host, block, path)} Delete the file yourself if you no longer want these rules.` };
    const pristine = isPristine(block) && withoutBom(text.slice(0, block.start) + text.slice(block.eolEnd)).trim() === '';
    if (!pristine) return { kind: 'edited', text, message: `${path} was edited, so SynaBun left it in place and no longer manages it.` };
    return { kind: 'pristine', text };
  }

  /**
   * One rule for every carrier: an untouched copy is removed, whatever version
   * it is stamped with; a copy the user edited is theirs and stays (SynaBun
   * stops managing it) unless `force` asks for it, and then it is backed up
   * first; damaged markers, a block stamped for another tool, a symlinked owned
   * file and a file that cannot be read are refused either way.
   *
   * OpenCode: a line in config.json that points at the owned file and that
   * SynaBun did not add keeps the file too (`kept`, reason `listed-in-config`):
   * nothing is ever left pointing at a file SynaBun deleted. With `force` that
   * line goes as well, after a backup of config.json, and then the file.
   *
   * Symlinks at a block carrier (AGENTS.md, GEMINI.md): the block is taken out
   * of the file the link points at and the link stays, exactly as install wrote
   * through it. The one link remove unlinks is a link install made itself that
   * still points where install pointed it. A file install created is deleted
   * only while it is nothing but the untouched block; with anything else in
   * it, the block goes and the file stays.
   */
  function remove(host, { force = false } = {}) {
    assertHost(host);
    if (HOSTS[host].carrier === 'none') return { ok: true, host, state: 'manual', path: null, changed: false, backupPath: null };
    return transact(`remove ${host}`, (why) => lockRefusal(host, why), (state, call) => removeHost(state, host, { force: force === true }, call))[0];
  }
  /**
   * True while a copy that keeps a removal open is still on disk: one SynaBun
   * should have taken and could not. That is damaged markers, a file that
   * cannot be read, an untouched copy of this host's rules (behind a symlink,
   * or held back by another refusal), and for OpenCode a config.json that
   * cannot be edited while SynaBun's entry is on record. A copy the user
   * edited, a file without markers and a block stamped for another tool are
   * not: the keep rule leaves the first two to the user, and the third was
   * never this host's. Looks at every place a copy can be: the host's carriers,
   * the row's paths and the paths the removal recorded.
   */
  function removalOpen(host, row, extra = []) {
    const recorded = Array.isArray(row.removal?.paths) ? row.removal.paths : [];
    const paths = unique([...targets(host).map((target) => target.path), ...row.paths, ...recorded, ...extra].filter((path) => typeof path === 'string'));
    if (host === 'opencode' && row.instructionsEntry && readOpencodeConfig().error) return true;
    return paths.some((path) => {
      try { lstatSync(path); } catch { return false; } // gone
      let text;
      try { text = readFileSync(path, 'utf8'); } catch (error) {
        return error?.code !== 'ENOENT'; // a link to nothing loads no rules; anything else is a file SynaBun cannot read
      }
      const { blocks, conflict } = findBlocks(text);
      if (conflict) return true;
      const block = blocks[0];
      if (!block || block.host !== host || !isPristine(block)) return false;
      return HOSTS[host].carrier !== 'file' || withoutBom(text.slice(0, block.start) + text.slice(block.eolEnd)).trim() === '';
    });
  }
  /** Ends a removal that has nothing left to wait for: the record goes and the host is opted out. True when it did. */
  function closeRemoval(host, row) {
    if (!isPlainObject(row.removal) || removalOpen(host, row)) return false;
    delete row.removal;
    Object.assign(row, { managed: false, optedOutAt: stamp() });
    return true;
  }
  /**
   * Take a host's rules out. Every copy is looked at first; then, when at least
   * one will go, the removal is put on record (`removal`, with the paths it is
   * about to take) and saved before the first copy is touched. A process that
   * dies halfway leaves that record behind, and the next boot finishes the job
   * (reconcile) instead of reading the missing primary copy as an opt-out
   * while another account still loads the rules.
   */
  function removeHost(state, host, { force }, call) {
    const row = state.hosts[host];
    const list = targets(host);
    const primary = list[0];
    const tally = call.tally(host);
    const refused = []; // {path, reason, message}: rules SynaBun could not take out
    const left = []; //    {path, reason, message}: copies deliberately left to the user
    const refuse = (path, reason, message) => refused.push({ path, reason, message });
    const created = new Set(row.created);
    // Every place a copy can be: the host's carriers, the row's paths, and what an unfinished removal recorded.
    const recorded = Array.isArray(row.removal?.paths) ? row.removal.paths.filter((path) => typeof path === 'string') : [];
    const paths = unique([...list.map((target) => target.path), ...row.paths, ...recorded]);
    /** Intent first: the paths about to go are saved before the first of them is touched. */
    const recordIntent = (planned) => {
      row.removal = { at: stamp(), error: INTERRUPTED, paths: unique(planned) };
      call.checkpoint();
    };

    try {
      if (HOSTS[host].carrier === 'file') {
        // Look at every copy first, then act.
        const doomed = [];
        const seen = new Set();
        for (const path of paths) {
          const key = realKey(path);
          if (seen.has(key)) continue;
          seen.add(key);
          const verdict = ownedFile(host, path, row.paths.includes(path));
          if (verdict.kind === 'absent' || verdict.kind === 'foreign') continue;
          if (verdict.kind === 'pristine' || (verdict.kind === 'edited' && force)) doomed.push({ path, text: verdict.text });
          else if (verdict.kind === 'edited' || verdict.kind === 'no-markers') left.push({ path, reason: verdict.kind, message: verdict.message });
          else refuse(path, verdict.kind, verdict.message);
        }
        // OpenCode: the entry and the file go together. A file that stays keeps its entry (it is still loaded), and
        // with an entry still listed the file stays, so OpenCode never points at a file that is gone: a config we
        // may not rewrite is a refusal, and a line the user wrote themselves keeps the file unless force takes both.
        const together = host === 'opencode';
        if (together && !refused.length && !left.length) {
          const config = readOpencodeConfig();
          if (config.error) {
            if (doomed.length || row.instructionsEntry) refuse(config.path, 'error', config.error);
          } else if (doomed.length && !force && userEntries(row, config).length) {
            for (const { path } of doomed) {
              left.push({
                path, reason: 'listed-in-config',
                message: `${config.path} lists ${path} under "instructions" on a line SynaBun did not add, so that line and the file were left in place and SynaBun no longer manages them. Remove with force to take out both.`,
              });
            }
          }
        }
        const go = !(together && (refused.length || left.length));
        if (go && doomed.length) recordIntent(doomed.map((entry) => entry.path));
        if (go && together) {
          try { removeOpencodeEntry(row, tally, { theirs: force && doomed.length > 0 }); } catch (error) { refuse(layout().opencodeConfig, 'error', error?.message || String(error)); }
        }
        if (!(together && refused.length)) {
          for (const { path, text } of go ? doomed : []) {
            try { tally.backup(backedUp(path, host, () => unlinkUnchanged(path, text))); } catch (error) {
              refuse(path, 'error', error?.message || String(error));
              continue;
            }
            tally.changed = true;
            const dir = dirname(path);
            if (created.has(dir)) { try { if (!readdirSync(dir).length) rmdirSync(dir); } catch { /* still in use */ } }
          }
        }
      } else {
        // Each file once, however many paths lead to it (an account's AGENTS.md may be a link to the shared one).
        const doomed = [];
        const seen = new Set();
        for (const path of paths) {
          if (!existsSync(path)) continue; // no file, or a link to nothing
          const key = realKey(path);
          if (seen.has(key)) continue;
          seen.add(key);
          let text;
          try { text = readFileSync(path, 'utf8'); } catch (error) { refuse(path, 'error', `Could not read ${path}: ${error?.message || error}`); continue; }
          const { blocks, conflict } = findBlocks(text);
          if (conflict) { refuse(path, 'conflict', `${conflict.message} in ${path}. SynaBun will not guess: remove the SynaBun marker lines by hand, then remove again.`); continue; }
          const block = blocks[0];
          if (!block) continue;
          if (block.host !== host) { refuse(path, 'conflict', `${foreignBlock(host, block, path)} Take that block out by hand if you no longer want it.`); continue; }
          const pristine = isPristine(block);
          if (!force && !pristine) {
            left.push({ path, reason: 'edited', message: `The SynaBun block in ${path} was edited, so SynaBun left it in place and no longer manages it.` });
            continue;
          }
          doomed.push({ path, text, pristine });
        }
        if (doomed.length) recordIntent(doomed.map((entry) => entry.path));
        for (const { path, text, pristine } of doomed) {
          const next = removeBlock(text);
          try {
            // "Install created it" is not enough to delete a file: it has to be a regular file that is still nothing
            // but the untouched block. A symlink at the path (the user moved the file and linked it back) is written
            // through like any other link, and a file that holds anything else keeps everything but the block.
            tally.backup(backedUp(path, host, () => {
              if (created.has(path) && !isSymlink(path) && pristine && withoutBom(next).trim() === '') unlinkUnchanged(path, text);
              else commit(path, next, text);
            }));
          } catch (error) {
            refuse(path, 'error', error?.message || String(error));
            continue;
          }
          tally.changed = true;
        }
        if (!refused.length && !left.some((entry) => entry.path === primary.path)) {
          // The links this installer made go with the rules, each only while it still points where install pointed
          // it. A link that points elsewhere by now, and every link SynaBun did not make, is the user's and stays.
          for (const link of row.links) {
            if (!isOwnLink(link)) continue;
            try { unlinkSync(link.path); tally.changed = true; } catch { /* leave it */ }
          }
        }
      }
    } catch (error) {
      refuse(primary.path, 'error', error?.message || String(error));
    }

    const kept = [...refused, ...left].map(({ path, reason }) => ({ path, reason }));
    const error = unique(refused.map((entry) => entry.message)).join(' ');
    if (refused.length && removalOpen(host, row, refused.map((entry) => entry.path))) {
      // Rules SynaBun could not take out are still there, so nothing is called "opted out": `managed` stays as it
      // was. The row says what stayed behind until a remove or an install completes, the next boot finishes the
      // removal (a copy that was repaired meanwhile goes then), or none of it is left to take (closeRemoval).
      row.removal = { at: stamp(), error, paths: unique(refused.map((entry) => entry.path)) };
      row.backup = tally.backupPath || row.backup || null;
      return {
        ok: false, code: 'REMOVE_INCOMPLETE', host, state: hostStatus(host, state).state, path: primary.path, changed: tally.changed, backupPath: tally.backupPath,
        partial: true, managed: row.managed, kept, error,
      };
    }

    if (left.length || refused.length) {
      // A deliberate keep, not a failure: the copies that stayed are the user's now. What install made around them
      // (`created`, OpenCode's entry) stays on record, so a forced remove or a Replace can still clean up. The same
      // row for a refusal that leaves nothing to wait for (a block stamped for another tool, a copy that turned out
      // edited): the host is opted out, and no removal is kept open over a file that was never SynaBun's to take.
      // `paths` are places a copy of the rules is: config.json, which a refusal can name, is not one of them.
      const config = host === 'opencode' ? layout().opencodeConfig : null;
      Object.assign(row, {
        managed: false, installedVersion: null, installedSha: null, path: primary.path,
        paths: unique([...left, ...refused].map((entry) => entry.path).filter((path) => path !== config)),
        appliedAt: stamp(), backup: tally.backupPath || row.backup || null,
      });
    } else {
      Object.assign(row, { ...emptyHostState(), managed: false, path: primary.path, appliedAt: stamp(), backup: tally.backupPath || row.backup || null });
      delete row.instructionsEntry;
    }
    delete row.removal;
    const result = { ok: true, host, state: hostStatus(host, state).state, path: primary.path, changed: tally.changed, backupPath: tally.backupPath };
    if (refused.length) return { ...result, ok: false, code: 'REMOVE_INCOMPLETE', partial: false, managed: row.managed, kept, error };
    if (left.length) Object.assign(result, { kept, message: unique(left.map((entry) => entry.message)).join(' ') });
    return result;
  }

  /**
   * Every host the user has not opted out of whose CLI is connected to SynaBun
   * (or already managed). A host with a removal on record is not one of them:
   * the user asked for those rules to go, and putting the primary copy back
   * because another copy could not be taken would undo that. Naming the host
   * in `hosts` is the explicit way back.
   */
  function installAll({ hosts = null, force = false } = {}) {
    return transact('install-all', (why) => ({ ok: false, ...why, changed: false, results: {} }), (state, call) => {
      const explicit = Array.isArray(hosts) && hosts.length > 0;
      for (const host of MANAGED_HOSTS) {
        try { closeRemoval(host, state.hosts[host]); } catch (error) { log('rulesets', `install-all ${host}: ${error?.message || error}`); }
      }
      const wanted = (explicit ? unique(hosts) : MANAGED_HOSTS).filter((host) => MANAGED_HOSTS.includes(host)).filter((host) => {
        if (explicit) return true;
        const row = state.hosts[host];
        return row.managed !== false && !isPlainObject(row.removal) && isDir(targets(host)[0].dir) && (row.managed === true || mcpRegistered(host));
      });
      const results = {};
      for (const host of wanted) {
        // One host that cannot even be looked at must not cost the others their record: they share one save.
        try { results[host] = installHost(state, host, { force }, call); } catch (error) {
          log('rulesets', `install ${host} failed: ${error?.message || error}`);
          results[host] = { ok: false, host, path: null, state: 'error', changed: false, backupPath: null, error: error?.message || String(error) };
        }
      }
      return { ok: Object.values(results).every((result) => result.ok), changed: Object.values(results).some((result) => result.changed), results };
    })[0];
  }

  // ── Reconcile (server boot) ────────────────────────────────────────────────
  // The server calls this from its listen callback. Every check is one read; the only wait is for the writer lock,
  // and that is bounded by `lockTimeoutMs`: when another SynaBun process holds it that long, this boot skips the
  // reconcile (one log line, `ok: false`, code BUSY) and the next one does it.
  function reconcile() {
    const [result, wrote] = transact('reconcile', (why) => ({ ok: false, ...why, updated: [], optedOut: [], states: {}, notice: null }), reconcileHosts);
    return { ...result, wrote };
  }
  /** Same refusal, same paths: a removal the boot tried again and could not finish either. */
  function sameRemoval(a, b) {
    return isPlainObject(a) && isPlainObject(b) && a.error === b.error && isDeepStrictEqual(a.paths, b.paths);
  }
  function reconcileHosts(state, call) {
    const updated = [];
    const optedOut = [];
    const states = {};
    let from = null;
    let to = null;

    for (const host of MANAGED_HOSTS) {
      const row = state.hosts[host];
      try {
        if (isPlainObject(row.removal)) {
          // A removal that is not over: one a process died in the middle of, or one that was refused a copy. The
          // user asked for these rules to go, so nothing is updated or put back for the host. A removal with nothing
          // left to wait for is closed (every copy it could not take is gone, or is the user's own by now); any
          // other is finished here by the rules of a plain remove: untouched copies go, edited ones stay with the
          // user, damaged and foreign ones are refused again. Never with force.
          const wasManaged = row.managed === true;
          const pending = row.removal;
          if (!closeRemoval(host, row)) {
            removeHost(state, host, { force: false }, call);
            // Refused again for the same reason: the record stays as it was, and a quiet boot writes nothing.
            if (sameRemoval(pending, row.removal)) row.removal = pending;
          }
          if (wasManaged) {
            if (row.managed !== true) optedOut.push(host);
            states[host] = hostStatus(host, state).state;
          }
          continue;
        }
        if (row.managed !== true) continue;
        const list = targets(host);
        const primary = list[0];
        const expected = expectedBlock(host);
        const config = host === 'opencode' ? readOpencodeConfig() : null;
        if (config?.error) { states[host] = 'error'; continue; }
        const first = isDir(primary.dir) ? inspect(host, primary, expected) : { status: 'missing' };
        if (first.status === 'missing' || (config && !config.hasEntry)) {
          // The user deleted it: an opt-out, never a reason to put it back. (A copy SynaBun's own removal took is
          // not this case: that removal is on record and was dealt with above.)
          Object.assign(row, { managed: false, optedOutAt: stamp() });
          optedOut.push(host);
          states[host] = 'not-installed';
          continue;
        }
        const tally = call.tally(host);
        const known = new Set(row.paths.map((path) => realKey(path)));
        let primaryCurrent = first.status === 'current';
        for (const target of list) {
          const found = target === primary ? first : inspect(host, target, expected);
          // An account directory that appeared since the install gets the rules too; a copy the user deleted does not.
          // A copy a newer SynaBun wrote (`newer`) is neither old nor missing: it is left byte for byte, with no notice.
          const isNew = target !== primary && found.status === 'missing' && !known.has(realKey(target.path));
          if (found.status === 'outdated' ? !state.autoUpdate : !(isNew && primaryCurrent)) continue;
          const applied = applyTarget(host, target, expected, {}, tally);
          if (applied.status !== 'current') continue;
          tally.paths.push(target.path);
          if (target === primary) primaryCurrent = true;
          if (found.status === 'outdated' && tally.refreshedFrom === undefined) tally.refreshedFrom = found.block?.version || row.installedVersion || null;
        }
        if (host === 'codex' && primaryCurrent) tally.paths.push(...linkCodexAccounts(row, tally, { onlyNew: true }));
        if (tally.changed) {
          if (tally.refreshedFrom !== undefined) {
            updated.push(host);
            from = from || tally.refreshedFrom;
            to = expected.version;
            if (primaryCurrent) Object.assign(row, { installedVersion: expected.version, installedSha: expected.sha });
          }
          Object.assign(row, { ...mergedRecord(row, tally), appliedAt: stamp(), backup: tally.backupPath || row.backup || null });
        }
        states[host] = hostStatus(host, state).state;
      } catch (error) {
        states[host] = 'error';
        log('rulesets', `reconcile ${host} failed: ${error?.message || error}`);
      }
    }

    if (updated.length) {
      const pending = state.notice?.kind === 'updated' ? state.notice : null;
      state.notice = { kind: 'updated', from: pending?.from || from, to, hosts: unique([...(pending?.hosts || []), ...updated]), at: stamp() };
    }
    return { ok: true, updated, optedOut, states, notice: state.notice };
  }

  // ── Pasted copies in project files ─────────────────────────────────────────
  // The user asked for this file by name, from the list status() shows: every
  // hash-exact copy goes, whichever tool it was written for. Quoted (fenced)
  // copies and edited ones are not matches and stay. The state file is not
  // involved, but the writer lock is taken like for every other change; the
  // file is replaced only while it still holds what was read.
  function removeLegacy(path) {
    if (typeof path !== 'string' || !path) return { ok: false, code: 'PATH_REQUIRED', error: 'path is required', changed: false };
    return locked('remove-legacy', (why) => ({ ok: false, ...why, changed: false }), () => {
      const key = realKey(resolve(path));
      const candidate = legacyCandidates().find((entry) => realKey(entry.path) === key);
      if (!candidate) return { ok: false, code: 'NOT_A_CANDIDATE', error: 'SynaBun only edits the instruction files it lists as holding a pasted copy.', changed: false };
      const changed = (message) => ({ ok: false, code: 'CHANGED_UNDERNEATH', error: message, path: candidate.path, host: candidate.host, changed: false });
      const bytes = readBytes(candidate.path);
      if (bytes === null) return changed(stillChanging(candidate.path));
      const text = bytes.toString('utf8');
      const spans = findLegacy(text, legacy());
      const exact = spans.filter((span) => span.kind === 'exact');
      const remaining = spans.some((span) => span.kind === 'heading') ? 'heading' : null;
      if (!exact.length) return { ok: true, path: candidate.path, host: candidate.host, changed: false, removed: 0, backupPath: null, remaining };
      let next = text;
      for (const span of [...exact].reverse()) next = removeRange(next, span.start, span.end);
      let backupPath;
      try { backupPath = backedUp(candidate.path, candidate.host, () => commit(candidate.path, next, bytes)); } catch (error) {
        if (error?.code !== 'CHANGED_UNDERNEATH') throw error;
        return changed(error.message);
      }
      return { ok: true, path: candidate.path, host: candidate.host, changed: true, removed: exact.length, backupPath, remaining };
    });
  }

  // ── Settings ───────────────────────────────────────────────────────────────
  // Nothing beyond the lock: of two processes that set it, the one that ran last wins.
  const settingRefused = (why) => ({ ok: false, ...why });
  function setAutoUpdate(value) {
    return transact('settings', settingRefused, (state) => {
      state.autoUpdate = value === true;
      return { ok: true, autoUpdate: state.autoUpdate };
    })[0];
  }
  /** Clears the "rules were updated" notice and stops offering the hosts that were offered. */
  function ackNotice() {
    return transact('notice-ack', settingRefused, (state) => {
      state.notice = null;
      state.offerAcked = unique([...state.offerAcked, ...offerHosts(state)]);
      return { ok: true, notice: null };
    })[0];
  }
  /** Close this installer's connection to the lock file (tests; a server keeps it for its whole life). */
  function close() {
    lock.close();
  }

  return { statePath, backupRoot, lockPath, status, install, remove, installAll, reconcile, removeLegacy, setAutoUpdate, ackNotice, close };
}
