// Isolate the serve/config, not the provider's credential database. OpenCode 2
// keeps credentials and sessions together. Pin the original XDG stores so a
// restart cannot silently select another HOME/account or an empty database.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export function openCodeWorkerData(configRoot, { resume = false, env = process.env, home = homedir() } = {}) {
  const file = join(configRoot, 'worker-data.json');
  const keys = ['XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'];
  if (resume || existsSync(file)) {
    let saved;
    try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error('OpenCode durable session data descriptor is gone'); }
    if (!keys.every(key => typeof saved[key] === 'string' && isAbsolute(saved[key]))) throw new Error('OpenCode durable session data descriptor is invalid');
    if (!existsSync(join(saved.XDG_DATA_HOME, 'opencode', 'opencode.db'))) throw new Error('OpenCode durable session database is gone');
    return Object.fromEntries(keys.map(key => [key, saved[key]]));
  }
  const saved = {
    XDG_DATA_HOME: env.XDG_DATA_HOME || join(home, '.local', 'share'),
    XDG_STATE_HOME: env.XDG_STATE_HOME || join(home, '.local', 'state'),
    XDG_CACHE_HOME: env.XDG_CACHE_HOME || join(home, '.cache'),
  };
  if (!keys.every(key => isAbsolute(saved[key]))) throw new Error('OpenCode XDG directories must be absolute');
  mkdirSync(configRoot, { recursive: true });
  writeFileSync(file, JSON.stringify(saved) + '\n', { mode: 0o600 });
  return saved;
}
