import { spawnSync } from 'child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync,
  lstatSync, renameSync, rmSync,
} from 'fs';
import { join, resolve, dirname } from 'path';
import os from 'node:os';

const PLUGINS_ROOT = () => join(os.homedir(), '.claude', 'plugins');
const INSTALLED_PLUGINS_FILE = () => join(PLUGINS_ROOT(), 'installed_plugins.json');
const KNOWN_MARKETPLACES_FILE = () => join(PLUGINS_ROOT(), 'known_marketplaces.json');

let trackerPath = null;
export function setTrackerPath(p) { trackerPath = p; }
const trackerFile = () => trackerPath || join(process.cwd(), 'data', 'synabun-plugins.json');

function ensureDir(p) { if (!existsSync(p)) mkdirSync(p, { recursive: true }); }

function readJson(p, fallback) {
  try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : fallback; }
  catch { return fallback; }
}

function writeJsonAtomic(p, obj) {
  ensureDir(dirname(p));
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
  try { renameSync(tmp, p); }
  catch { writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf-8'); try { unlinkSync(tmp); } catch {} }
}

function runClaude(args, { timeoutMs = 180000 } = {}) {
  const r = spawnSync('claude', args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  });
  const stdout = (r.stdout || '').toString();
  const stderr = (r.stderr || '').toString();
  const combined = `${stdout}${stderr ? '\n' + stderr : ''}`.trim();
  if (r.error && r.error.code === 'ENOENT') {
    return { ok: false, code: -1, stdout, stderr, combined, notFound: true };
  }
  return { ok: r.status === 0, code: r.status ?? -1, stdout, stderr, combined };
}

function claudeNotFoundErr() {
  return { ok: false, error: 'Claude Code CLI not found on PATH. Install `claude` to manage plugins.' };
}

function gitHeadSha(repoPath) {
  if (!repoPath || !existsSync(repoPath)) return 'unknown';
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8' });
  const out = (r.stdout || '').trim();
  return out || 'unknown';
}

function readTracker() { return readJson(trackerFile(), { version: 1, plugins: {} }); }
function writeTracker(obj) { writeJsonAtomic(trackerFile(), obj); }

function isSynabunSymlinkMarketplace(entry) {
  return entry && entry.source && entry.source.source === 'synabun-symlink';
}

// Purge legacy "synabun-symlink" entries that break CC's marketplace loader,
// plus orphaned installed_plugins rows whose cache path no longer exists.
function cleanLegacyState() {
  try {
    const known = readJson(KNOWN_MARKETPLACES_FILE(), null);
    if (known && typeof known === 'object') {
      let changed = false;
      for (const [name, entry] of Object.entries(known)) {
        if (isSynabunSymlinkMarketplace(entry)) {
          delete known[name];
          changed = true;
          const mkLink = join(PLUGINS_ROOT(), 'marketplaces', name);
          try { if (lstatSync(mkLink).isSymbolicLink()) unlinkSync(mkLink); } catch {}
          try { rmSync(join(PLUGINS_ROOT(), 'cache', name), { recursive: true, force: true }); } catch {}
        }
      }
      if (changed) writeJsonAtomic(KNOWN_MARKETPLACES_FILE(), known);
    }

    const installed = readJson(INSTALLED_PLUGINS_FILE(), null);
    if (installed && installed.plugins && typeof installed.plugins === 'object') {
      let changed2 = false;
      for (const key of Object.keys(installed.plugins)) {
        const list = installed.plugins[key] || [];
        const filtered = list.filter(e => e && e.installPath && existsSync(e.installPath));
        if (filtered.length !== list.length) {
          if (filtered.length) installed.plugins[key] = filtered;
          else delete installed.plugins[key];
          changed2 = true;
        }
      }
      if (changed2) writeJsonAtomic(INSTALLED_PLUGINS_FILE(), installed);
    }
  } catch {}
}

function parsePluginManifest(repoPath) {
  const pluginJson = readJson(join(repoPath, '.claude-plugin', 'plugin.json'), null);
  if (!pluginJson || !pluginJson.name) return { ok: false, error: `Missing .claude-plugin/plugin.json at ${repoPath}` };
  const marketplaceJson = readJson(join(repoPath, '.claude-plugin', 'marketplace.json'), null);
  const pluginName = String(pluginJson.name).trim();
  const marketplaceName = (marketplaceJson && marketplaceJson.name) || pluginName;
  const hooks = pluginJson.hooks && typeof pluginJson.hooks === 'object' ? Object.keys(pluginJson.hooks) : [];
  return { ok: true, pluginName, marketplaceName, hooks, manifest: pluginJson };
}

// Install via `claude plugin marketplace add` + `claude plugin install`.
// Prefers githubUrl (CC manages its own clone); falls back to local repoPath.
export function installClaudePlugin({ repoPath, githubUrl } = {}) {
  cleanLegacyState();

  if (!repoPath || !existsSync(repoPath)) {
    return { ok: false, error: `Repo path required to read plugin manifest: ${repoPath}` };
  }
  const meta = parsePluginManifest(repoPath);
  if (!meta.ok) return meta;
  const { pluginName, marketplaceName, hooks } = meta;

  const source = githubUrl || resolve(repoPath);

  const addRes = runClaude(['plugin', 'marketplace', 'add', source, '--scope', 'user']);
  if (addRes.notFound) return claudeNotFoundErr();
  const alreadyAdded = /already (added|exists|configured|registered)/i.test(addRes.combined);
  if (!addRes.ok && !alreadyAdded) {
    return { ok: false, error: `claude plugin marketplace add failed: ${addRes.combined || `exit ${addRes.code}`}` };
  }

  const installRes = runClaude(['plugin', 'install', `${pluginName}@${marketplaceName}`, '--scope', 'user']);
  if (installRes.notFound) return claudeNotFoundErr();
  const alreadyInstalled = /already installed/i.test(installRes.combined);
  if (!installRes.ok && !alreadyInstalled) {
    return { ok: false, error: `claude plugin install failed: ${installRes.combined || `exit ${installRes.code}`}` };
  }

  const installed = readJson(INSTALLED_PLUGINS_FILE(), { plugins: {} });
  const key = `${pluginName}@${marketplaceName}`;
  const ccList = installed.plugins?.[key] || [];
  const ccEntry = ccList.find(e => e && e.scope === 'user') || ccList[0] || null;
  const installPath = ccEntry?.installPath || null;
  const gitCommitSha = ccEntry?.gitCommitSha || gitHeadSha(repoPath);

  const tracker = readTracker();
  if (!tracker.plugins || typeof tracker.plugins !== 'object') tracker.plugins = {};
  tracker.plugins[key] = {
    pluginName,
    marketplaceName,
    source,
    githubUrl: githubUrl || null,
    repoPath: resolve(repoPath),
    gitCommitSha,
    installedAt: tracker.plugins[key]?.installedAt || new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
  };
  writeTracker(tracker);

  return {
    ok: true,
    pluginName,
    marketplaceName,
    installPath,
    marketplacePath: join(PLUGINS_ROOT(), 'marketplaces', marketplaceName),
    key,
    hooks,
    gitCommitSha,
    alreadyInstalled,
  };
}

export function uninstallClaudePlugin({ marketplaceName, pluginName } = {}) {
  cleanLegacyState();
  if (!marketplaceName) return { ok: false, error: 'marketplaceName required' };

  const tracker = readTracker();
  const managedKeys = Object.keys(tracker.plugins || {}).filter(k => {
    const [pName, mName] = k.split('@');
    if (mName !== marketplaceName) return false;
    if (pluginName && pName !== pluginName) return false;
    return true;
  });
  if (!managedKeys.length) return { ok: false, error: `No SynaBun-managed plugin found for ${marketplaceName}${pluginName ? '/' + pluginName : ''}` };

  const removedPlugins = [];
  for (const key of managedKeys) {
    const [pName] = key.split('@');
    const r = runClaude(['plugin', 'uninstall', key]);
    if (r.notFound) return claudeNotFoundErr();
    const notFound = /not (installed|found)/i.test(r.combined);
    if (!r.ok && !notFound) {
      return { ok: false, error: `claude plugin uninstall failed: ${r.combined || `exit ${r.code}`}` };
    }
    delete tracker.plugins[key];
    removedPlugins.push(pName);
  }

  const remaining = Object.keys(tracker.plugins || {}).some(k => k.endsWith(`@${marketplaceName}`));
  if (!remaining) {
    runClaude(['plugin', 'marketplace', 'remove', marketplaceName]);
  }
  writeTracker(tracker);
  return { ok: true, removedPlugins };
}

export function listSynabunPlugins() {
  const tracker = readTracker();
  const installed = readJson(INSTALLED_PLUGINS_FILE(), { plugins: {} });
  const out = [];
  for (const [key, meta] of Object.entries(tracker.plugins || {})) {
    const ccList = installed.plugins?.[key] || [];
    const ccEntry = ccList.find(e => e && e.scope === 'user') || ccList[0] || null;
    const installPath = ccEntry?.installPath || null;
    const installPresent = installPath ? existsSync(installPath) : false;
    const repoExists = meta.repoPath ? existsSync(meta.repoPath) : true;
    out.push({
      key,
      pluginName: meta.pluginName,
      marketplaceName: meta.marketplaceName,
      scope: ccEntry?.scope || 'user',
      installPath,
      installedAt: meta.installedAt,
      lastUpdated: meta.lastUpdated,
      gitCommitSha: ccEntry?.gitCommitSha || meta.gitCommitSha,
      repoPath: meta.repoPath || null,
      githubUrl: meta.githubUrl || null,
      broken: !ccEntry || !installPresent || !repoExists,
    });
  }
  return out;
}

// Migration: purge legacy synabun-symlink state + reinstall via CLI for any
// entries whose original repo path still exists.
export function repairSynabunPlugins() {
  const before = readJson(KNOWN_MARKETPLACES_FILE(), {}) || {};
  const legacy = Object.entries(before)
    .filter(([, v]) => isSynabunSymlinkMarketplace(v))
    .map(([name, v]) => ({ name, path: v.source?.path || null }));

  cleanLegacyState();

  const repaired = [];
  const failed = [];
  for (const { name, path } of legacy) {
    if (!path || !existsSync(path)) {
      failed.push({ marketplaceName: name, error: 'Original repo path missing — cannot reinstall automatically' });
      continue;
    }
    const meta = parsePluginManifest(path);
    if (!meta.ok) { failed.push({ marketplaceName: name, error: meta.error }); continue; }
    let githubUrl = null;
    try {
      const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: path, encoding: 'utf-8' });
      const u = (r.stdout || '').trim();
      if (/^https?:\/\//.test(u)) githubUrl = u.replace(/\.git$/, '');
    } catch {}
    const res = installClaudePlugin({ repoPath: path, githubUrl });
    if (res.ok) repaired.push({ marketplaceName: name, pluginName: res.pluginName });
    else failed.push({ marketplaceName: name, error: res.error });
  }
  return { repaired, failed };
}
