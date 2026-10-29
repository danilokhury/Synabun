// ── What a runtime says about an installed skill ──
// An install writes bytes; whether a runtime offers the skill is another question, asked two ways:
//
//   eligibility  read from the runtime's own settings, without starting it: Codex's config.toml
//                ([[skills.config]] path = …, enabled = false), Claude Code's settings.json (skillOverrides
//                "off", a deny rule on Skill(name)), OpenCode's opencode.json and opencode.jsonc (the last rule of
//                action `skill` whose resource matches the name: OpenCode 2's `permissions`, an OpenCode 1
//                `permission.skill` read as OpenCode reads it). 'enabled', 'disabled', or 'unknown' when the
//                settings cannot be read.
//   probe        asked of the runtime itself, only when the owner asks (Verify in the Studio): Codex lists its
//                skills through `codex app-server` (skills/list, forceReload); OpenCode through SynaBun's own
//                running serve. Claude Code has no listing to ask: it says null with the reason. A probe reads; it
//                changes no setting.
//   enable       the one write here, on the owner's click only (POST /api/skills-studio/v2/eligibility/enable):
//                the setting that turns the skill off is changed to let it through, the file is backed up first
//                (DATA_HOME/data/skills/backups/settings/), and the answer names the file, the backup and the lines
//                that changed. Codex: that [[skills.config]] table's `enabled = false` line becomes `enabled = true`
//                (the rest of config.toml byte for byte). OpenCode: `{ "action": "skill", "resource": "<name>",
//                "effect": "allow" }` is added as the last rule of opencode.json's `permissions` (a deny in a .jsonc
//                file is left to the owner, with the rule to add; a deny of every skill is refused unless the owner
//                confirmed loosening it, `confirmDenyAll`).
//                Claude Code: the skillOverrides entry or the Skill(name) deny rule is removed (a deny of every skill
//                is never loosened). A JSON file is changed in one value only, byte for byte otherwise
//                (lib/skills/json-edit.js): never reformatted. Nothing is changed silently.

import { spawn } from 'node:child_process';
import { closeSync, constants, copyFileSync, fstatSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { replaceFileAtomic } from '../confined-fs.js';
import { parseJsonWithOffsets, nodeAt, appendMember, appendElement, removeMember, removeElement } from './json-edit.js';
import { OPENCODE_CONFIG_FILES, parseJsonc, permissionRulesOf } from '../opencode-config.js';

const MAX_SETTINGS_BYTES = 1024 * 1024;

/**
 * A settings file, read bounded: `{ state: 'absent' }` when there is none, `{ state: 'ok', text }`, or
 * `{ state: 'unreadable' }` when it is there but cannot be read whole (over the bound, not a regular file, no
 * permission). The size is known before a byte is read; a FIFO or a device is never opened for reading
 * (O_NONBLOCK, and the open file is checked again before the read).
 */
export function readSettingsFile(path, { maxBytes = MAX_SETTINGS_BYTES } = {}) {
  let st;
  try { st = statSync(path); } catch (err) { return err?.code === 'ENOENT' || err?.code === 'ENOTDIR' ? { state: 'absent' } : { state: 'unreadable' }; }
  if (!st.isFile() || st.size > maxBytes) return { state: 'unreadable' };
  let fd = null;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK || 0));
    const open = fstatSync(fd);
    if (!open.isFile() || open.size > maxBytes) return { state: 'unreadable' };
    const buf = Buffer.alloc(open.size);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, got);
      if (n <= 0) break;
      got += n;
    }
    return { state: 'ok', text: buf.subarray(0, got).toString('utf-8') };
  } catch { return { state: 'unreadable' }; }
  finally { if (fd !== null) { try { closeSync(fd); } catch { /* closed */ } } }
}

/** The [[skills.config]] tables of a Codex config.toml: `{ path, name, enabled }` each (a reading of those lines only). */
export function codexSkillConfigs(toml) {
  const out = [];
  let current = null;
  for (const raw of String(toml || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line) continue;
    if (/^\[\[\s*skills\.config\s*\]\]$/.test(line)) { current = { path: null, name: null, enabled: null }; out.push(current); continue; }
    if (/^\[/.test(line)) { current = null; continue; }
    if (!current) continue;
    const kv = /^([A-Za-z_]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    const str = /^"((?:[^"\\]|\\.)*)"$/.exec(value)?.[1]?.replace(/\\(["\\])/g, '$1') ?? /^'([^']*)'$/.exec(value)?.[1] ?? null;
    if (key === 'path' && str !== null) current.path = str;
    else if (key === 'name' && str !== null) current.name = str;
    else if (key === 'enabled' && /^(true|false)$/.test(value)) current.enabled = value === 'true';
  }
  return out;
}

const skillPatternMatches = (pattern, name) => new RegExp(`^${String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(name);

/**
 * The last rule of a config that decides skill `name`: `{ effect: 'allow' | 'ask' | 'deny', resource }` of the last
 * rule of action `skill` whose resource matches it (OpenCode 2's `permissions`, after an OpenCode 1
 * `permission.skill` converted), or null when none does.
 */
export function opencodeSkillRule(config, name) {
  let found = null;
  for (const rule of permissionRulesOf(config)) {
    if (rule.action === 'skill' && skillPatternMatches(rule.resource, name)) found = { effect: rule.effect, resource: rule.resource };
  }
  return found;
}

/** What a config decides for skill `name` ('allow' | 'ask' | 'deny' | null): opencodeSkillRule's effect. */
export function opencodeSkillPermission(config, name) {
  return opencodeSkillRule(config, name)?.effect ?? null;
}

/**
 * @param {object} o
 * @param {(accountId: string) => string} o.codexHome
 * @param {(accountId: string) => string} o.claudeHome
 * @param {() => string} o.opencodeConfigDir <config>/opencode
 * @param {() => string|null} [o.codexBin]
 * @param {(accountId: string) => object} [o.codexEnv] the environment Codex runs under for that account
 * @param {() => object|null} [o.opencodeClient] SynaBun's running OpenCode serve client, when there is one
 */
export function createSkillsRuntimeChecks({ codexHome, claudeHome, opencodeConfigDir, codexBin = () => null, codexEnv = () => process.env, opencodeClient = () => null, spawnImpl = spawn, timeoutMs = 20000, backupDir = null } = {}) {
  /**
   * Whether the runtime's settings let the skill through, with the setting that does not: `{ state, reason }`.
   * `state` is 'enabled', 'disabled' or 'unknown'; `reason` names the file and the rule only when it is 'disabled'
   * (`kind`: codex-config, claude-override, claude-deny, opencode-permission), or why nothing could be read.
   */
  function eligibilityDetail({ runtime, name, skillMd, accountId = 'default', projectPath = null }) {
    if (runtime === 'codex') {
      const file = join(codexHome(accountId), 'config.toml');
      const read = readSettingsFile(file);
      if (read.state === 'absent') return { state: 'enabled', reason: null };   // no config.toml: nothing turns a skill off
      if (read.state !== 'ok') return { state: 'unknown', reason: { kind: 'unreadable', file } };       // there, but not read whole: it may turn it off
      const tables = codexSkillConfigs(read.text);
      const hit = tables.filter((t) => (t.path && resolve(t.path) === resolve(skillMd)) || (t.name && t.name === name));
      if (!hit.length) return { state: 'enabled', reason: null };
      const last = hit[hit.length - 1];
      return last.enabled === false ? { state: 'disabled', reason: { kind: 'codex-config', file, table: { path: last.path, name: last.name } } } : { state: 'enabled', reason: null };
    }
    if (runtime === 'claude') {
      const files = [join(claudeHome(accountId), 'settings.json')];
      if (projectPath) files.push(join(projectPath, '.claude', 'settings.json'), join(projectPath, '.claude', 'settings.local.json'));
      let unknown = null;
      for (const file of files) {
        const read = readSettingsFile(file);
        if (read.state === 'absent') continue;
        if (read.state !== 'ok') { unknown = { kind: 'unreadable', file }; continue; }
        let data;
        try { data = JSON.parse(read.text); } catch { unknown = { kind: 'invalid-json', file }; continue; }
        if (data?.skillOverrides && data.skillOverrides[name] === 'off') return { state: 'disabled', reason: { kind: 'claude-override', file, key: name } };
        const deny = Array.isArray(data?.permissions?.deny) ? data.permissions.deny : [];
        const rule = deny.find((r) => r === 'Skill' || r === `Skill(${name})` || r === `Skill(${name} *)`);
        if (rule) return { state: 'disabled', reason: { kind: 'claude-deny', file, rule } };
      }
      return unknown ? { state: 'unknown', reason: unknown } : { state: 'enabled', reason: null };
    }
    if (runtime === 'opencode') {
      // OpenCode 2 reads opencode.json, then opencode.jsonc over it: the last matching rule of both decides.
      let decided = null;
      for (const file of OPENCODE_CONFIG_FILES) {
        const full = join(opencodeConfigDir(), file);
        const read = readSettingsFile(full);
        if (read.state === 'absent') continue;
        if (read.state !== 'ok') return { state: 'unknown', reason: { kind: 'unreadable', file: full } };
        let data;
        try { data = file.endsWith('.jsonc') ? parseJsonc(read.text) : JSON.parse(read.text); } catch { return { state: 'unknown', reason: { kind: 'invalid-json', file: full } }; }
        const rule = opencodeSkillRule(data, name);
        if (rule) decided = { ...rule, file: full };
      }
      if (decided?.effect !== 'deny') return { state: 'enabled', reason: null };
      return { state: 'disabled', reason: { kind: 'opencode-permission', file: decided.file, pattern: decided.resource, action: 'deny' } };
    }
    return { state: 'unknown', reason: { kind: 'unknown-runtime' } };
  }

  /** 'enabled' | 'disabled' | 'unknown' (eligibilityDetail's state). */
  function eligibility(o) { return eligibilityDetail(o).state; }

  /**
   * Let the skill through the setting that turns it off (the owner pressed "Enable for …"). Reads the detail
   * again first; a skill that is not turned off changes nothing (`changed: false`). The file is copied into
   * `backupDir` before it is written; the answer carries the file, the backup and the lines that changed, so the
   * page can show exactly what was done. Throws an EnableError (status, code) when the file cannot be changed
   * safely: then the answer says what to change by hand.
   */
  function enable({ runtime, name, skillMd, accountId = 'default', projectPath = null, confirmDenyAll = false }) {
    const detail = eligibilityDetail({ runtime, name, skillMd, accountId, projectPath });
    if (detail.state !== 'disabled') return { ok: true, changed: false, state: detail.state, file: detail.reason?.file || null };
    const { file } = detail.reason;
    const read = readSettingsFile(file);
    if (read.state !== 'ok') throw new EnableError(409, `${file} could not be read whole: change it yourself.`, 'settings_unreadable', { file });
    let next;
    let changed = [];
    if (detail.reason.kind === 'codex-config') {
      const out = enableCodexTable(read.text, { skillMd, name });
      if (!out) throw new EnableError(409, `The [[skills.config]] table that turns /${name} off in ${file} could not be changed in place: set its "enabled = true" yourself.`, 'settings_unchanged', { file });
      next = out.text; changed = out.changed;
    } else if (detail.reason.kind === 'opencode-permission') {
      const allowRule = { action: 'skill', resource: name, effect: 'allow' };
      if (/\.jsonc$/i.test(file)) throw new EnableError(409, `${file} has comments, which SynaBun does not rewrite: add ${JSON.stringify(allowRule)} as the last rule of its "permissions" yourself.`, 'jsonc_unsupported', { file, rule: allowRule });
      const out = enableOpencodeRule(read.text, { name, confirmDenyAll, everySkill: detail.reason.pattern === '*' });
      if (out.error) throw new EnableError(409, out.error.message, out.error.code, { file, rule: allowRule });
      next = out.text; changed = out.changed;
    } else if (detail.reason.kind === 'claude-override') {
      const root = parseJsonWithOffsets(read.text);
      const overrides = nodeAt(root, ['skillOverrides']);
      next = overrides?.members?.length === 1 ? removeMember(read.text, root, 'skillOverrides') : removeMember(read.text, overrides, name);
      changed = [`skillOverrides["${name}"] removed`];
    } else if (detail.reason.kind === 'claude-deny') {
      if (detail.reason.rule === 'Skill') throw new EnableError(409, `${file} denies every skill ("Skill" in permissions.deny): SynaBun does not loosen that rule; change it yourself.`, 'deny_all', { file, rule: 'Skill' });
      const root = parseJsonWithOffsets(read.text);
      const deny = nodeAt(root, ['permissions', 'deny']);
      const at = deny?.elements?.findIndex((e) => e.value === detail.reason.rule) ?? -1;
      if (at < 0) throw new EnableError(409, 'The rule moved while it was being changed: nothing was written.', 'settings_unchanged', { file });
      next = removeElement(read.text, deny, at);
      changed = [`permissions.deny: "${detail.reason.rule}" removed`];
    } else throw new EnableError(409, 'Nothing SynaBun can change.', 'settings_unchanged', { file });
    JSON.parse(/\.toml$/i.test(file) ? '{}' : next);   // a JSON edit that does not parse is never written
    const backup = backupSettings(file);
    const mode = (() => { try { return statSync(file).mode & 0o777; } catch { return 0o600; } })();
    replaceFileAtomic(file, next, { mode });
    const after = eligibilityDetail({ runtime, name, skillMd, accountId, projectPath });
    return { ok: after.state === 'enabled', changed: true, state: after.state, file, backup, lines: changed };
  }

  function backupSettings(file) {
    if (!backupDir) return null;
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = join(backupDir, `${stamp}-${basename(file)}`);
    copyFileSync(file, target, constants.COPYFILE_EXCL);
    return target;
  }

  /** Ask Codex itself: `codex app-server`, initialize, skills/list. */
  function probeCodex({ skillMd, accountId, projectPath }) {
    const bin = codexBin();
    if (!bin) return Promise.resolve({ discovered: null, code: 'not-installed', method: 'codex app-server', reason: 'Codex is not installed.' });
    return new Promise((resolveProbe) => {
      let done = false;
      const env = { ...codexEnv(accountId) };
      const child = spawnImpl(bin, ['app-server'], { cwd: projectPath || codexHome(accountId), env, stdio: ['pipe', 'pipe', 'pipe'] });
      const finish = (result) => { if (done) return; done = true; clearTimeout(timer); try { child.stdin?.end?.(); } catch {} try { child.kill(); } catch {} resolveProbe({ method: 'codex app-server skills/list', ...result }); };
      const timer = setTimeout(() => finish({ discovered: null, code: 'no-answer', reason: 'Codex did not answer in time.' }), timeoutMs);
      // Nothing is written once the probe is settled: Codex exited, could not be started, answered or ran out of time.
      const send = (message) => { if (done || !child.stdin?.writable) return; try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch {} };
      // A Codex that exits or fails to start as a request is written fails the pipe after write() returned (EPIPE, a
      // write after end): unhandled, that error would end the server. A probe whose Codex died early has failed.
      child.stdin?.on?.('error', () => finish({ discovered: null, code: 'no-answer', reason: 'Codex stopped before it answered.' }));
      let buf = '';
      child.on?.('error', (err) => finish({ discovered: null, code: err?.code === 'ENOENT' ? 'not-installed' : 'no-answer', reason: `Codex could not be started (${err?.code || err?.message}).` }));
      child.on?.('exit', () => finish({ discovered: null, code: 'no-answer', reason: 'Codex stopped before it answered.' }));
      child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          let m; try { m = JSON.parse(line); } catch { continue; }
          if (m.id === 1) {
            send({ jsonrpc: '2.0', method: 'initialized', params: {} });
            send({ jsonrpc: '2.0', id: 2, method: 'skills/list', params: { cwds: [projectPath || codexHome(accountId)], forceReload: true } });
          } else if (m.id === 2) {
            const skills = (m.result?.data || []).flatMap((e) => e.skills || []);
            const hit = skills.find((s) => typeof s.path === 'string' && resolve(s.path) === resolve(skillMd));
            finish(hit ? { discovered: true, enabled: hit.enabled !== false, scope: hit.scope || null } : { discovered: false, listed: skills.length });
          }
        }
      });
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'synabun-skills-verify', version: '1' }, capabilities: { experimentalApi: true } } });
    });
  }

  async function probe({ runtime, name, skillMd, accountId = 'default', projectPath = null }) {
    if (runtime === 'codex') return probeCodex({ skillMd, accountId, projectPath });
    if (runtime === 'opencode') {
      const client = opencodeClient();
      if (!client?.app?.skills) return { discovered: null, code: 'not-running', method: 'opencode serve', reason: 'SynaBun\'s OpenCode is not running: start a new OpenCode session to check.' };
      try {
        const res = await client.app.skills(projectPath ? { directory: projectPath } : {});
        const list = Array.isArray(res?.data) ? res.data : [];
        const hit = list.find((s) => (s.location && resolve(s.location) === resolve(skillMd)) || s.name === name);
        return { method: 'opencode serve /api/skill', discovered: !!hit, ...(hit ? {} : { listed: list.length }) };
      } catch (err) { return { discovered: null, code: 'no-answer', method: 'opencode serve', reason: err?.message || String(err) }; }
    }
    if (runtime === 'claude') return { discovered: null, code: 'no-list', method: 'none', reason: 'Claude Code has no list to ask; its folder rules were checked instead.' };
    return { discovered: null, method: 'none', reason: 'Unknown runtime.' };
  }

  return { eligibility, eligibilityDetail, enable, probe };
}

/**
 * opencode.json with `{ "action": "skill", "resource": "<name>", "effect": "allow" }` as the last rule of its
 * `permissions` (the list made when there is none), the rest of the text byte for byte: OpenCode 2 applies the last
 * rule that matches, after the rules of an OpenCode 1 `permission` object, which stays as it was. `everySkill`: the
 * rule that turns the skill off denies every skill, which SynaBun loosens only when the owner confirmed it
 * (`confirmDenyAll`).
 * @returns {{ text?: string, changed?: string[], error?: { code: string, message: string } }}
 */
export function enableOpencodeRule(text, { name, confirmDenyAll = false, everySkill = false }) {
  const root = parseJsonWithOffsets(text);
  if (root.type !== 'object') return { error: { code: 'settings_unchanged', message: 'The settings file is not a JSON object.' } };
  if (everySkill && !confirmDenyAll) {
    return { error: { code: 'deny_all', message: `The OpenCode configuration denies every skill: SynaBun does not loosen that rule by itself. Allow "${name}" yourself, or confirm loosening it.` } };
  }
  const rule = `{ "action": "skill", "resource": ${JSON.stringify(name)}, "effect": "allow" }`;
  const changed = [`permissions: ${rule} added`];
  const permissions = nodeAt(root, ['permissions']);
  if (!permissions) return { text: appendMember(text, root, 'permissions', `[${rule}]`), changed };
  if (permissions.type !== 'array') return { error: { code: 'settings_unchanged', message: '"permissions" is not a list: change it yourself.' } };
  return { text: appendElement(text, permissions, rule), changed };
}

export class EnableError extends Error {
  constructor(status, message, code, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * The text of a Codex config.toml with the `enabled = false` line of the [[skills.config]] table(s) that name this
 * skill turned to `enabled = true`; every other byte stays (comments and spacing included). Null when no such
 * line is there to change.
 */
export function enableCodexTable(toml, { skillMd, name }) {
  const lines = String(toml || '').split(/(\r?\n)/);   // text and its separators, kept
  const out = [];
  const changed = [];
  let current = null;   // the table being read: { path, name, enabledAt }
  const flush = () => {
    if (!current) return;
    const hit = (current.path && resolve(current.path) === resolve(skillMd)) || (current.name && current.name === name);
    if (hit && current.enabledAt !== null) {
      const raw = out[current.enabledAt];
      out[current.enabledAt] = raw.replace(/^(\s*enabled\s*=\s*)false(\s*(#.*)?)$/, '$1true$2');
      changed.push({ line: current.lineNo, before: raw, after: out[current.enabledAt] });
    }
    current = null;
  };
  let lineNo = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    out.push(raw);
    if (i % 2 === 1) continue;   // a separator
    lineNo++;
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line) continue;
    if (/^\[\[\s*skills\.config\s*\]\]$/.test(line)) { flush(); current = { path: null, name: null, enabledAt: null, lineNo: null }; continue; }
    if (/^\[/.test(line)) { flush(); continue; }
    if (!current) continue;
    const kv = /^([A-Za-z_]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    const str = /^"((?:[^"\\]|\\.)*)"$/.exec(value)?.[1]?.replace(/\\(["\\])/g, '$1') ?? /^'([^']*)'$/.exec(value)?.[1] ?? null;
    if (key === 'path' && str !== null) current.path = str;
    else if (key === 'name' && str !== null) current.name = str;
    else if (key === 'enabled' && value === 'false') { current.enabledAt = out.length - 1; current.lineNo = lineNo; }
    else if (key === 'enabled' && value === 'true') { current.enabledAt = null; current.lineNo = null; }
  }
  flush();
  return changed.length ? { text: out.join(''), changed } : null;
}
