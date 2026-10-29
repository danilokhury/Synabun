// ── Every folder a runtime reads skills, commands, agents or prompts from ──
// One list, for the catalog (lib/skills/catalog.js), the installs (lib/skills/deploy.js), the bridge migration
// (lib/skills/migration.js) and the staging check (an import is never staged inside one of these). Each root says
// which runtimes read it, for whom (a Claude or Codex account, a project), what lives there (skill folders, or
// command / agent / prompt files), whether SynaBun may write there and why, and how its discovery was verified.
//
// Where they are (profiles in public/shared/skills/ss-profiles.js; Codex and OpenCode verified on 2026-10-22 by
// starting codex-cli 0.163.0 and opencode 2.0.32 in a temporary home):
//   Claude Code   <config dir>/skills, /commands, /agents for each account (CLAUDE_CONFIG_DIR, ~/.claude by
//                 default; an added account's own folder); <config dir>/skills/synced (account skills,
//                 read-only); plugin skills and commands under <config dir>/plugins/cache (read-only); the managed
//                 settings folder's .claude/skills (read-only); each registered project's .claude/skills,
//                 /commands, /agents.
//   Codex         $CODEX_HOME/skills for each account (~/.codex by default; the installer's default and where
//                 SynaBun installs), $CODEX_HOME/skills/.system (Codex's own, read-only), $CODEX_HOME/prompts (the
//                 old bridges), /etc/codex/skills (admin, read-only), a project's .agents/skills (Codex and
//                 OpenCode) and .codex/skills (read by Codex, not documented: read-only here).
//   OpenCode      <config>/opencode/skills (XDG_CONFIG_HOME or ~/.config; where SynaBun installs), the singular
//                 <config>/opencode/skill (read), <config>/opencode/command and ~/.opencode/command (the old
//                 bridges), <config>/opencode/commands, a project's .opencode/skills. With OPENCODE_CONFIG_DIR set,
//                 OpenCode (2.0.32, checked) reads <dir>/skills and <dir>/skill instead of the <config>/opencode
//                 ones: <dir>/skills is then where SynaBun installs (and <dir> holds the settings it reads), and the
//                 <config>/opencode skill folders stay listed as read by no runtime.
//                 OpenCode also reads ~/.claude/skills and both .agents roots (not in SynaBun's own OpenCode panel,
//                 which turns the Claude ones off).
//   Shared        ~/.agents/skills: Codex and OpenCode (and other agents) read it. SynaBun writes there only when
//                 the owner turned that on (`sharedAgentsRoot`).
//   SynaBun       PACKAGE_ROOT/skills, the bundled skills: read-only.
//
// Nothing here reads a skill; `status` is only what the folder is (there, missing, not a folder, unreadable).

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const RUNTIMES = Object.freeze(['claude', 'codex', 'opencode']);

const realFs = { lstat: lstatSync, realpath: realpathSync, readdir: readdirSync };

/** A root's id: stable for the same kind of root at the same place. */
export function rootIdOf({ family, kind, scope, accountId = '', path }) {
  return `root_${createHash('sha256').update([family, kind, scope, accountId || '', resolve(String(path))].join('\0')).digest('hex').slice(0, 20)}`;
}

/** The managed-settings folder of Claude Code on this platform (enterprise skills live in its .claude/skills). */
export function claudeManagedDir(platform = process.platform) {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode';
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode';
  return '/etc/claude-code';
}

/**
 * @param {object} o
 * @param {Record<string,string|undefined>} [o.env]
 * @param {string} [o.homeDir]
 * @param {string} [o.platform]
 * @param {() => {path: string, label?: string}[]} [o.projects] registered projects
 * @param {() => {id: string, label?: string, home: string}[]} [o.claudeAccounts] every Claude account with its config dir
 * @param {() => {id: string, label?: string, home: string}[]} [o.codexAccounts] every Codex account with its CODEX_HOME
 * @param {string} [o.bundledDir] PACKAGE_ROOT/skills
 * @param {() => { sharedAgentsRoot?: boolean }} [o.config]
 * @param {object} [o.fs] lstat / realpath / readdir (tests)
 */
export function createRootResolver({
  env = process.env, homeDir = homedir(), platform = process.platform,
  projects = () => [], claudeAccounts = null, codexAccounts = null,
  bundledDir = null, config = () => ({}), fs = realFs, managedDir = null, codexAdminDir = '/etc/codex/skills',
} = {}) {
  const home = resolve(homeDir);
  const configHome = () => resolve(env.XDG_CONFIG_HOME || join(home, '.config'));

  function statusOf(path) {
    let st;
    try { st = fs.lstat(path); } catch (err) { return { status: err?.code === 'EACCES' ? 'unreadable' : 'absent', resolvedPath: null, linked: false }; }
    let real = null;
    try { real = fs.realpath(path); } catch { return { status: 'unreadable', resolvedPath: null, linked: st.isSymbolicLink(), note: 'a link that leads nowhere' }; }
    let target = st;
    if (st.isSymbolicLink()) { try { target = fs.lstat(real); } catch { return { status: 'unreadable', resolvedPath: real, linked: true }; } }
    if (!target.isDirectory()) return { status: 'not-a-folder', resolvedPath: real, linked: st.isSymbolicLink() };
    try { fs.readdir(real); } catch { return { status: 'unreadable', resolvedPath: real, linked: st.isSymbolicLink() }; }
    return { status: 'ok', resolvedPath: real, linked: st.isSymbolicLink() };
  }

  function claudeHomes() {
    const rows = typeof claudeAccounts === 'function' ? (claudeAccounts() || []) : [];
    const list = rows.filter((r) => r && typeof r.home === 'string' && r.home).map((r) => ({ id: r.id || 'default', label: r.label || r.id || 'Default', home: resolve(r.home) }));
    if (!list.some((r) => r.id === 'default')) list.unshift({ id: 'default', label: 'Default', home: resolve(env.CLAUDE_CONFIG_DIR || join(home, '.claude')) });
    return list;
  }
  function codexHomes() {
    const rows = typeof codexAccounts === 'function' ? (codexAccounts() || []) : [];
    const list = rows.filter((r) => r && typeof r.home === 'string' && r.home).map((r) => ({ id: r.id || 'default', label: r.label || r.id || 'Default', home: resolve(r.home) }));
    if (!list.some((r) => r.id === 'default')) list.unshift({ id: 'default', label: 'Default', home: resolve(env.CODEX_HOME || join(home, '.codex')) });
    return list;
  }

  /** Every root, with what it is now. */
  function listRoots() {
    const out = [];
    const seenIds = new Set();
    const add = (spec) => {
      const rootId = rootIdOf(spec);
      if (seenIds.has(rootId)) return;
      seenIds.add(rootId);
      const state = statusOf(spec.path);
      out.push({
        rootId, family: spec.family, kind: spec.kind, layout: spec.kind === 'skills' ? 'skill-folders' : 'md-files',
        runtimes: spec.runtimes, scope: spec.scope, sourceKind: spec.sourceKind,
        accountId: spec.accountId || null, accountLabel: spec.accountLabel || null, pluginId: spec.pluginId || null,
        projectPath: spec.projectPath || null, projectLabel: spec.projectLabel || null,
        path: resolve(spec.path), resolvedPath: state.resolvedPath, linked: state.linked, status: state.status,
        policy: spec.policy, discovery: spec.discovery, anchor: spec.anchor || null, note: spec.note || state.note || '',
        installTarget: spec.installTarget || null,
      });
    };
    const owner = (reason) => ({ write: 'owner', reason });
    const never = (reason) => ({ write: 'never', reason });
    const sharedOn = !!config()?.sharedAgentsRoot;

    // Claude Code, per account.
    const claudeDefault = resolve(join(home, '.claude'));
    for (const acct of claudeHomes()) {
      const a = { accountId: acct.id, accountLabel: acct.label };
      // OpenCode reads ~/.claude/skills itself (not another config dir, and not in SynaBun's own OpenCode panel).
      const opencodeCompat = acct.home === claudeDefault;
      add({ family: 'claude', kind: 'skills', scope: 'user', sourceKind: 'native', path: join(acct.home, 'skills'), runtimes: opencodeCompat ? ['claude', 'opencode'] : ['claude'], ...a,
        policy: owner('The account\'s own skills folder.'), discovery: { contract: 'skills/<name>/SKILL.md', verified: 'docs' },
        installTarget: { runtime: 'claude', scope: 'user' },
        note: opencodeCompat ? 'A terminal OpenCode reads it too (Claude compatibility); SynaBun\'s own OpenCode serves (the panel, an Assistant brain) start with OPENCODE_DISABLE_CLAUDE_CODE=1 and do not.' : '' });
      add({ family: 'claude', kind: 'skills', scope: 'synced', sourceKind: 'synced', path: join(acct.home, 'skills', 'synced'), runtimes: ['claude'], ...a,
        policy: never('Skills the Claude account syncs down; a local change would be overwritten. Customize a copy instead.'), discovery: { contract: 'skills/synced/<name>/SKILL.md, /anthropic-skills:<name>', verified: 'docs' } });
      add({ family: 'claude', kind: 'commands', scope: 'user', sourceKind: 'native', path: join(acct.home, 'commands'), runtimes: ['claude'], ...a,
        policy: owner('The account\'s own commands.'), discovery: { contract: 'commands/<ns>/<name>.md → /ns:name', verified: 'docs' } });
      add({ family: 'claude', kind: 'agents', scope: 'user', sourceKind: 'native', path: join(acct.home, 'agents'), runtimes: ['claude'], ...a,
        policy: owner('The account\'s own agents.'), discovery: { contract: 'agents/<name>.md', verified: 'docs' } });
      // Plugins: every installed plugin's skills and commands, read-only (they belong to the plugin).
      const cache = join(acct.home, 'plugins', 'cache');
      for (const plugin of pluginFolders(cache)) {
        const p = { ...a, pluginId: `${plugin.plugin}@${plugin.marketplace}` };
        add({ family: 'claude', kind: 'skills', scope: 'plugin', sourceKind: 'plugin', path: join(plugin.path, 'skills'), runtimes: ['claude'], ...p,
          policy: never('Part of an installed plugin: updated through the plugin.'), discovery: { contract: `/${plugin.plugin}:<name>`, verified: 'docs' }, note: `Plugin ${plugin.plugin} (${plugin.marketplace}, ${plugin.version})` });
        add({ family: 'claude', kind: 'commands', scope: 'plugin', sourceKind: 'plugin', path: join(plugin.path, 'commands'), runtimes: ['claude'], ...p,
          policy: never('Part of an installed plugin.'), discovery: { contract: `/${plugin.plugin}:<name>`, verified: 'docs' }, note: `Plugin ${plugin.plugin} (${plugin.marketplace}, ${plugin.version})` });
      }
    }
    add({ family: 'claude', kind: 'skills', scope: 'managed', sourceKind: 'managed', path: join(managedDir || claudeManagedDir(platform), '.claude', 'skills'), runtimes: ['claude'],
      policy: never('Set by an administrator (managed settings).'), discovery: { contract: '<managed>/.claude/skills/<name>/SKILL.md', verified: 'docs' } });

    // Codex, per account.
    for (const acct of codexHomes()) {
      const a = { accountId: acct.id, accountLabel: acct.label };
      add({ family: 'codex', kind: 'skills', scope: 'user', sourceKind: 'native', path: join(acct.home, 'skills'), runtimes: ['codex'], ...a,
        policy: owner('The Codex home\'s skills folder (the installer\'s default).'), discovery: { contract: '$CODEX_HOME/skills/<name>/SKILL.md', verified: 'fixture codex-cli 0.163.0' },
        installTarget: { runtime: 'codex', scope: 'user' } });
      add({ family: 'codex', kind: 'skills', scope: 'system', sourceKind: 'system', path: join(acct.home, 'skills', '.system'), runtimes: ['codex'], ...a,
        policy: never('Codex\'s own skills.'), discovery: { contract: '$CODEX_HOME/skills/.system/<name>/SKILL.md', verified: 'fixture codex-cli 0.163.0' } });
      add({ family: 'codex', kind: 'prompts', scope: 'user', sourceKind: 'legacy-bridge', path: join(acct.home, 'prompts'), runtimes: ['codex'], ...a,
        policy: { write: 'migration', reason: 'Custom prompts are deprecated: SynaBun\'s old bridges move from here to native skill folders.' }, discovery: { contract: '/prompts:<name>', verified: 'docs' } });
    }
    add({ family: 'codex', kind: 'skills', scope: 'admin', sourceKind: 'admin', path: codexAdminDir, runtimes: ['codex'],
      policy: never('Set by an administrator.'), discovery: { contract: '/etc/codex/skills/<name>/SKILL.md', verified: 'docs' } });

    // OpenCode: its configuration folder is OPENCODE_CONFIG_DIR when that is set (2.0.32 then reads skills there,
    // and not in <config>/opencode), else <config>/opencode.
    const oc = join(configHome(), 'opencode');
    const ocDir = opencodeConfigDir();
    const overridden = ocDir !== oc;
    add({ family: 'opencode', kind: 'skills', scope: 'user', sourceKind: 'native', path: join(ocDir, 'skills'), runtimes: ['opencode'],
      policy: owner(overridden ? 'OpenCode\'s skills folder (OPENCODE_CONFIG_DIR).' : 'OpenCode\'s own skills folder.'),
      discovery: { contract: overridden ? '$OPENCODE_CONFIG_DIR/skills/<name>/SKILL.md' : '<config>/opencode/skills/<name>/SKILL.md', verified: 'fixture opencode 2.0.32' },
      installTarget: { runtime: 'opencode', scope: 'user' } });
    add({ family: 'opencode', kind: 'skills', scope: 'user', sourceKind: 'compat', path: join(ocDir, 'skill'), runtimes: ['opencode'],
      policy: never('The singular folder OpenCode still reads; new skills go to skills/.'),
      discovery: { contract: overridden ? '$OPENCODE_CONFIG_DIR/skill/<name>/SKILL.md' : '<config>/opencode/skill/<name>/SKILL.md', verified: 'fixture opencode 2.0.32' } });
    if (overridden) {
      for (const folder of ['skills', 'skill']) {
        add({ family: 'opencode', kind: 'skills', scope: 'user', sourceKind: 'inactive', path: join(oc, folder), runtimes: [],
          policy: never('OpenCode does not read this folder while OPENCODE_CONFIG_DIR is set.'), discovery: { contract: 'not read while OPENCODE_CONFIG_DIR is set', verified: 'fixture opencode 2.0.32' } });
      }
    }
    add({ family: 'opencode', kind: 'commands', scope: 'user', sourceKind: 'legacy-bridge', path: join(oc, 'command'), runtimes: ['opencode'],
      policy: { write: 'migration', reason: 'Where SynaBun\'s old bridges were written.' }, discovery: { contract: '<config>/opencode/command/<name>.md', verified: 'fixture opencode 2.0.32' } });
    add({ family: 'opencode', kind: 'commands', scope: 'user', sourceKind: 'native', path: join(oc, 'commands'), runtimes: ['opencode'],
      policy: never('OpenCode commands: not managed by Skills Studio yet.'), discovery: { contract: '<config>/opencode/commands/<name>.md', verified: 'fixture opencode 2.0.32' } });
    add({ family: 'opencode', kind: 'commands', scope: 'user', sourceKind: 'legacy-bridge', path: join(home, '.opencode', 'command'), runtimes: ['opencode'],
      policy: { write: 'migration', reason: 'An old place SynaBun wrote bridges to.' }, discovery: { contract: '~/.opencode/command/<name>.md', verified: 'unverified' } });

    // Shared.
    add({ family: 'shared', kind: 'skills', scope: 'shared', sourceKind: 'shared', path: join(home, '.agents', 'skills'), runtimes: ['codex', 'opencode'],
      policy: sharedOn ? owner('Shared by Codex, OpenCode and other agents; turned on by the owner.') : { write: 'owner-opt-in', reason: 'Shared by Codex, OpenCode and other agents: SynaBun writes here only when you turn it on.' },
      discovery: { contract: '~/.agents/skills/<name>/SKILL.md', verified: 'fixture codex-cli 0.163.0, opencode 2.0.32' },
      installTarget: { runtime: 'agents', scope: 'user' } });

    // Projects.
    let list = [];
    try { list = projects() || []; } catch { list = []; }
    for (const proj of list) {
      if (!proj?.path) continue;
      const p = { projectPath: resolve(proj.path), projectLabel: proj.label || proj.path, anchor: resolve(proj.path) };
      const at = (...parts) => join(proj.path, ...parts);
      add({ family: 'claude', kind: 'skills', scope: 'project', sourceKind: 'native', path: at('.claude', 'skills'), runtimes: ['claude', 'opencode'], ...p,
        policy: owner('The project\'s Claude skills (shared with the repository).'), discovery: { contract: '.claude/skills/<name>/SKILL.md', verified: 'docs; OpenCode fixture' },
        installTarget: { runtime: 'claude', scope: 'project' } });
      add({ family: 'claude', kind: 'commands', scope: 'project', sourceKind: 'native', path: at('.claude', 'commands'), runtimes: ['claude'], ...p,
        policy: owner('The project\'s commands.'), discovery: { contract: '.claude/commands/<ns>/<name>.md → /ns:name', verified: 'docs' } });
      add({ family: 'claude', kind: 'agents', scope: 'project', sourceKind: 'native', path: at('.claude', 'agents'), runtimes: ['claude'], ...p,
        policy: owner('The project\'s agents.'), discovery: { contract: '.claude/agents/<name>.md', verified: 'docs' } });
      add({ family: 'codex', kind: 'skills', scope: 'project', sourceKind: 'native', path: at('.agents', 'skills'), runtimes: ['codex', 'opencode'], ...p,
        policy: owner('The project\'s shared skills (Codex\'s repository folder; OpenCode reads it too).'), discovery: { contract: '.agents/skills/<name>/SKILL.md', verified: 'fixture codex-cli 0.163.0, opencode 2.0.32' },
        installTarget: { runtime: 'codex', scope: 'project' } });
      add({ family: 'codex', kind: 'skills', scope: 'project', sourceKind: 'compat', path: at('.codex', 'skills'), runtimes: ['codex'], ...p,
        policy: never('Read by Codex 0.163.0 but not in its guide: new skills go to .agents/skills.'), discovery: { contract: '.codex/skills/<name>/SKILL.md', verified: 'fixture codex-cli 0.163.0' } });
      add({ family: 'opencode', kind: 'skills', scope: 'project', sourceKind: 'native', path: at('.opencode', 'skills'), runtimes: ['opencode'], ...p,
        policy: owner('The project\'s OpenCode skills.'), discovery: { contract: '.opencode/skills/<name>/SKILL.md', verified: 'fixture opencode 2.0.32' },
        installTarget: { runtime: 'opencode', scope: 'project' } });
    }

    // Bundled.
    if (bundledDir) {
      add({ family: 'synabun', kind: 'skills', scope: 'bundled', sourceKind: 'bundled', path: bundledDir, runtimes: [],
        policy: never('Ships with SynaBun: install it, or customize a copy.'), discovery: { contract: 'not read by a runtime directly', verified: 'n/a' } });
    }
    return out;
  }

  /** Installed plugins under a plugin cache: <marketplace>/<plugin>/<version>, bounded. */
  function pluginFolders(cache) {
    const out = [];
    const list = (dir) => { try { return fs.readdir(dir).filter((n) => !n.startsWith('.')).sort(); } catch { return []; } };
    for (const marketplace of list(cache).slice(0, 50)) {
      for (const plugin of list(join(cache, marketplace)).slice(0, 200)) {
        for (const version of list(join(cache, marketplace, plugin)).slice(0, 20)) {
          out.push({ marketplace, plugin, version, path: join(cache, marketplace, plugin, version) });
          if (out.length >= 500) return out;
        }
      }
    }
    return out;
  }

  /** OpenCode's configuration folder: OPENCODE_CONFIG_DIR when set, else <config>/opencode (its settings and skills). */
  function opencodeConfigDir() {
    return env.OPENCODE_CONFIG_DIR ? resolve(String(env.OPENCODE_CONFIG_DIR)) : join(configHome(), 'opencode');
  }

  /** The roots that receive installs, by runtime and scope (and account / project). */
  function installRoot({ runtime, scope = 'user', accountId = 'default', projectPath = null }) {
    const roots = listRoots();
    const wanted = roots.filter((r) => r.installTarget && r.installTarget.runtime === runtime && r.installTarget.scope === scope);
    if (scope === 'project') return wanted.find((r) => projectPath && r.projectPath === resolve(projectPath)) || null;
    if (runtime === 'claude' || runtime === 'codex') return wanted.find((r) => (r.accountId || 'default') === (accountId || 'default')) || null;
    return wanted[0] || null;
  }

  /** Every folder a runtime reads skills from (the import staging is refused inside any of them). */
  function liveRootPaths() {
    return listRoots().filter((r) => r.family !== 'synabun').map((r) => r.path);
  }

  return { listRoots, installRoot, liveRootPaths, claudeHomes, codexHomes, opencodeConfigDir };
}
