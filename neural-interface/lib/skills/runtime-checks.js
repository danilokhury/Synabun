// ── What a runtime says about an installed skill ──
// An install writes bytes; whether a runtime offers the skill is another question, asked two ways:
//
//   eligibility  read from the runtime's own settings, without starting it: Codex's config.toml
//                ([[skills.config]] path = …, enabled = false), Claude Code's settings.json (skillOverrides
//                "off", a deny rule on Skill(name)), OpenCode's opencode.json (permission.skill, last matching
//                rule). 'enabled', 'disabled', or 'unknown' when the settings cannot be read.
//   probe        asked of the runtime itself, only when the owner asks (Verify in the Studio): Codex lists its
//                skills through `codex app-server` (skills/list, forceReload); OpenCode through SynaBun's own
//                running serve. Claude Code has no listing to ask: it says null with the reason. A probe reads; it
//                changes no setting.
//
// Nothing here writes a file.

import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

/** OpenCode's permission.skill: the action the last matching pattern gives a name ('allow' | 'ask' | 'deny' | null). */
export function opencodeSkillPermission(config, name) {
  const perm = config?.permission?.skill;
  if (typeof perm === 'string') return perm;
  if (!perm || typeof perm !== 'object') return null;
  let result = null;
  for (const [pattern, action] of Object.entries(perm)) {
    const re = new RegExp(`^${String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    if (re.test(name) && typeof action === 'string') result = action;
  }
  return result;
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
export function createSkillsRuntimeChecks({ codexHome, claudeHome, opencodeConfigDir, codexBin = () => null, codexEnv = () => process.env, opencodeClient = () => null, spawnImpl = spawn, timeoutMs = 20000 } = {}) {
  function eligibility({ runtime, name, skillMd, accountId = 'default', projectPath = null }) {
    if (runtime === 'codex') {
      const read = readSettingsFile(join(codexHome(accountId), 'config.toml'));
      if (read.state === 'absent') return 'enabled';   // no config.toml: nothing turns a skill off
      if (read.state !== 'ok') return 'unknown';       // there, but not read whole: it may turn it off
      const tables = codexSkillConfigs(read.text);
      const hit = tables.filter((t) => (t.path && resolve(t.path) === resolve(skillMd)) || (t.name && t.name === name));
      if (!hit.length) return 'enabled';
      return hit[hit.length - 1].enabled === false ? 'disabled' : 'enabled';
    }
    if (runtime === 'claude') {
      const files = [join(claudeHome(accountId), 'settings.json')];
      if (projectPath) files.push(join(projectPath, '.claude', 'settings.json'), join(projectPath, '.claude', 'settings.local.json'));
      let unknown = false;
      for (const file of files) {
        const read = readSettingsFile(file);
        if (read.state === 'absent') continue;
        if (read.state !== 'ok') { unknown = true; continue; }
        let data;
        try { data = JSON.parse(read.text); } catch { unknown = true; continue; }
        if (data?.skillOverrides && data.skillOverrides[name] === 'off') return 'disabled';
        const deny = Array.isArray(data?.permissions?.deny) ? data.permissions.deny : [];
        if (deny.some((rule) => rule === 'Skill' || rule === `Skill(${name})` || rule === `Skill(${name} *)`)) return 'disabled';
      }
      return unknown ? 'unknown' : 'enabled';
    }
    if (runtime === 'opencode') {
      for (const file of ['opencode.json', 'opencode.jsonc', 'config.json']) {
        const read = readSettingsFile(join(opencodeConfigDir(), file));
        if (read.state === 'absent') continue;
        if (read.state !== 'ok') return 'unknown';
        let data;
        try { data = JSON.parse(file.endsWith('c') ? read.text.replace(/^\s*\/\/.*$/gm, '') : read.text); } catch { return 'unknown'; }
        const action = opencodeSkillPermission(data, name);
        return action === 'deny' ? 'disabled' : 'enabled';
      }
      return 'enabled';
    }
    return 'unknown';
  }

  /** Ask Codex itself: `codex app-server`, initialize, skills/list. */
  function probeCodex({ skillMd, accountId, projectPath }) {
    const bin = codexBin();
    if (!bin) return Promise.resolve({ discovered: null, method: 'codex app-server', reason: 'Codex is not installed.' });
    return new Promise((resolveProbe) => {
      let done = false;
      const env = { ...codexEnv(accountId) };
      const child = spawnImpl(bin, ['app-server'], { cwd: projectPath || codexHome(accountId), env, stdio: ['pipe', 'pipe', 'pipe'] });
      const finish = (result) => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch {} resolveProbe({ method: 'codex app-server skills/list', ...result }); };
      const timer = setTimeout(() => finish({ discovered: null, reason: 'Codex did not answer in time.' }), timeoutMs);
      let buf = '';
      child.on?.('error', (err) => finish({ discovered: null, reason: `Codex could not be started (${err?.code || err?.message}).` }));
      child.on?.('exit', () => finish({ discovered: null, reason: 'Codex stopped before it answered.' }));
      child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          let m; try { m = JSON.parse(line); } catch { continue; }
          if (m.id === 1) {
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'skills/list', params: { cwds: [projectPath || codexHome(accountId)], forceReload: true } })}\n`);
          } else if (m.id === 2) {
            const skills = (m.result?.data || []).flatMap((e) => e.skills || []);
            const hit = skills.find((s) => typeof s.path === 'string' && resolve(s.path) === resolve(skillMd));
            finish(hit ? { discovered: true, enabled: hit.enabled !== false, scope: hit.scope || null } : { discovered: false, listed: skills.length });
          }
        }
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'synabun-skills-verify', version: '1' }, capabilities: { experimentalApi: true } } })}\n`);
    });
  }

  async function probe({ runtime, name, skillMd, accountId = 'default', projectPath = null }) {
    if (runtime === 'codex') return probeCodex({ skillMd, accountId, projectPath });
    if (runtime === 'opencode') {
      const client = opencodeClient();
      if (!client?.app?.skills) return { discovered: null, method: 'opencode serve', reason: 'SynaBun\'s OpenCode is not running: start a new OpenCode session to check.' };
      try {
        const res = await client.app.skills(projectPath ? { directory: projectPath } : {});
        const list = Array.isArray(res?.data) ? res.data : [];
        const hit = list.find((s) => (s.location && resolve(s.location) === resolve(skillMd)) || s.name === name);
        return { method: 'opencode serve /api/skill', discovered: !!hit, ...(hit ? {} : { listed: list.length }) };
      } catch (err) { return { discovered: null, method: 'opencode serve', reason: err?.message || String(err) }; }
    }
    if (runtime === 'claude') return { discovered: null, method: 'none', reason: 'Claude Code has no list to ask; its folder rules were checked instead.' };
    return { discovered: null, method: 'none', reason: 'Unknown runtime.' };
  }

  return { eligibility, probe };
}
