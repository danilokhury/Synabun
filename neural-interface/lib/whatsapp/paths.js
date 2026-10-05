// Where the WhatsApp Link keeps its files.
//
//   waHome      credentials (auth/state.db) and the host's cwd. Never inside a
//               folder a backup copies (BACKUP_DATA_DIRS of backup-service.js:
//               DATA_HOME/data and DATA_HOME/mcp-data, plus the caller's extra
//               backup roots): a SYNABUN_WHATSAPP_HOME there is refused with a
//               warning and the default is used. On Windows it is
//               %LOCALAPPDATA% so a roaming profile never copies a live
//               session to a second machine (that ends in connectionReplaced).
//   runtimeDir  the Baileys runtime, installed on demand from the pinned
//               lockfile in ./connector (never in a SynaBun package.json).
//   stagingDir  where the installer builds the next runtime before swapping.
//   logsDir     SynaBun's shared log folder.
//
// Pure: no filesystem access, so callers and tests can resolve any platform.

import path from 'node:path';
import { BACKUP_DATA_DIRS } from '../backup-service.js';

function pathApi(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** True when `candidate` is `parent` or inside it (same platform semantics). */
export function isInside(candidate, parent, platform = process.platform) {
  const p = pathApi(platform);
  const rel = p.relative(p.resolve(parent), p.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
}

/**
 * @param {{dataHome: string, env?: Record<string,string|undefined>, platform?: string, extraBackupRoots?: string[]}} opts
 *   `extraBackupRoots`: folders a backup copies besides BACKUP_DATA_DIRS (server.js' additional entries).
 * @returns {{waHome:string, defaultWaHome:string, authDir:string, runtimeDir:string, stagingDir:string, logsDir:string,
 *   installLogPath:string, installLockPath:string, npmCacheDir:string, backupRoots:string[], warnings:string[]}}
 */
export function resolveWhatsAppPaths({ dataHome, env = process.env, platform = process.platform, extraBackupRoots = [] } = {}) {
  if (typeof dataHome !== 'string' || !dataHome) throw new TypeError('resolveWhatsAppPaths: dataHome is required');
  const p = pathApi(platform);
  const home = p.resolve(dataHome);
  const dataDir = p.join(home, 'data');
  const warnings = [];
  const backupRoots = [...new Set([
    ...BACKUP_DATA_DIRS.map((dir) => p.join(home, dir)),
    ...(Array.isArray(extraBackupRoots) ? extraBackupRoots : []).filter((root) => typeof root === 'string' && root).map((root) => p.resolve(root)),
  ])];

  let defaultWaHome = p.join(home, 'whatsapp');
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || (env.USERPROFILE ? p.join(env.USERPROFILE, 'AppData', 'Local') : '');
    if (local) defaultWaHome = p.join(p.resolve(local), 'synabun', 'whatsapp');
  }

  let waHome = defaultWaHome;
  const override = typeof env.SYNABUN_WHATSAPP_HOME === 'string' ? env.SYNABUN_WHATSAPP_HOME.trim() : '';
  if (override) {
    const resolved = p.resolve(override);
    // Inside a backed-up folder: a backup would copy the live session.
    const clash = backupRoots.find((root) => isInside(resolved, root, platform));
    if (clash) {
      warnings.push(`SYNABUN_WHATSAPP_HOME points inside a backed-up folder (${clash}); using the default location instead`);
    } else {
      waHome = resolved;
    }
  }

  const runtimeRoot = p.join(home, 'runtime');
  return {
    waHome,
    defaultWaHome,
    authDir: p.join(waHome, 'auth'),
    runtimeDir: p.join(runtimeRoot, 'whatsapp'),
    stagingDir: p.join(runtimeRoot, 'whatsapp.staging'),
    logsDir: p.join(dataDir, 'logs'),
    installLogPath: p.join(dataDir, 'whatsapp', 'install.log'),
    installLockPath: p.join(runtimeRoot, 'whatsapp.install.lock'),
    npmCacheDir: p.join(home, 'cache', 'npm'),
    backupRoots,
    warnings,
  };
}
