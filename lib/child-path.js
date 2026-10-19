/**
 * SynaBun — the PATH of everything SynaBun starts, and where npm puts global commands
 *
 * A packaged application (packaging/) brings its own Node runtime, npm and npx.
 * They are a fallback: on the PATH of every process the application starts,
 * the order is
 *
 *   1. the user's own PATH, as it came
 *   2. the bin folder of npm's global prefix, when the PATH lacks it (where
 *      `npm i -g` through SynaBun's npm puts commands: the user's own prefix
 *      when they set one, else a per-user folder of SynaBun's, never the app)
 *   3. the packaged runtime, last
 *
 * packagedPathLast() is that order, and the one implementation of it: the
 * entry points of a packaged build (lib/packaged-runtime.js packagedChildEnv:
 * the bootstrap, the hook handler, the headless MCP server) and every PATH the
 * Neural Interface builds (neural-interface/lib/augmented-path.js) use it.
 *
 * npm's global prefix is read here the way npm 10 (@npmcli/config) settles it,
 * from plain files, without starting npm:
 *
 *   1. the environment: npm_config_prefix, in any letter case, when not empty
 *   2. the user's config file: npm_config_userconfig, else ~/.npmrc
 *   3. the global config file: npm_config_globalconfig, else `globalconfig=` in
 *      the user's (or the builtin) file, else <the prefix so far>/etc/npmrc
 *   4. the builtin config of that npm (<npm>/npmrc: a packaged build writes one)
 *   5. the default: $PREFIX, else the folder of the node running npm (Windows)
 *      or the folder above it
 *
 * (The command line comes first for npm and is never known here; a project's
 * .npmrc is ignored by npm for a global install.) Every value goes through
 * npm's ${VAR} substitution; a path then has a leading `~/` (on Windows also
 * `~\`) replaced by the home folder (HOME, else the account's) and is made
 * absolute. Files are read as npm's ini reader reads them: `;` and `#`
 * comments, quotes, inline comments; a `prefix` inside a [section] is not the
 * prefix. One difference: an empty `prefix=` counts as not set (npm would use
 * the folder it happens to run in, which is no folder to put on a PATH).
 *
 * Only node: modules here: neural-interface/lib/augmented-path.js imports this
 * file, and tests copy both into scratch trees.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const MEMO_MS = 5_000;
let _memo = null; // { key, at, value }

const implFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

/** The value of an env's PATH, whatever its spelling (Windows: Path). */
export function pathEnvValue(env = process.env) {
  return env[Object.keys(env).find(key => key.toUpperCase() === 'PATH')] || '';
}

/**
 * `env` with PATH set to `value`. Windows environment names are
 * case-insensitive and JS object keys are not: the base's spelling is kept and
 * every alias removed before an env reaches Node or ConPTY.
 */
export function withPathEnv(env = process.env, value = pathEnvValue(env), platform = process.platform) {
  if (platform !== 'win32') return { ...env, PATH: value };
  const keys = Object.keys(env).filter(key => key.toUpperCase() === 'PATH');
  const key = keys[0] || 'Path';
  const out = { ...env };
  for (const alias of keys) delete out[alias];
  out[key] = value;
  return out;
}

/**
 * PATH `value` with a packaged application's folders after the user's: each
 * `extra` folder (npm's global bin) appended when the PATH does not have it
 * yet, then every `last` folder (the runtime) moved to the very end. Nothing
 * else moves; each folder stays once (Windows compares without case and
 * trailing separators).
 */
export function packagedPathLast(value, { platform = process.platform, last = [], extra = [] } = {}) {
  const delimiter = platform === 'win32' ? ';' : ':';
  const id = (entry) => (platform === 'win32' ? entry.toLowerCase().replace(/[\\/]+$/, '') : entry.replace(/\/+$/, '') || '/');
  const lastIds = new Set(last.filter(Boolean).map(id));
  const seen = new Set();
  const out = [];
  const add = (entry) => {
    if (!entry) return;
    const key = id(entry);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };
  for (const entry of String(value || '').split(delimiter)) if (entry && !lastIds.has(id(entry))) add(entry);
  for (const entry of extra) if (entry && !lastIds.has(id(entry))) add(entry);
  for (const entry of last) add(entry);
  return out.join(delimiter);
}

/** Where npm puts the commands of global packages under `prefix`: the prefix itself on Windows, its bin/ elsewhere. */
export function npmGlobalBinFor(prefix, platform = process.platform) {
  if (!prefix) return null;
  return platform === 'win32' ? prefix : implFor(platform).join(prefix, 'bin');
}

/** The builtin npmrc of the npm in a packaged runtime whose executables are in `runtimeBin`. */
export function bundledNpmrcPath(runtimeBin, platform = process.platform) {
  if (!runtimeBin) return null;
  const impl = implFor(platform);
  return platform === 'win32'
    ? impl.join(runtimeBin, 'node_modules', 'npm', 'npmrc')
    : impl.join(runtimeBin, '..', 'lib', 'node_modules', 'npm', 'npmrc');
}

function envLookup(env, name, platform) {
  if (env[name] !== undefined) return env[name];
  if (platform !== 'win32') return undefined;
  const key = Object.keys(env).find(candidate => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/**
 * npm's ${VAR} substitution (@npmcli/config env-replace.js): `${NAME}` is the
 * variable's value, a name that is not set stays as written, and a backslash
 * before `${` escapes it (an even number of them is that many halved, then the value).
 */
export function npmEnvReplace(text, env = process.env, platform = process.platform) {
  return String(text).replace(/(?<!\\)(\\*)\$\{([^${}]+)\}/g, (orig, esc, name) => {
    const found = envLookup(env, name, platform);
    const value = found !== undefined ? found : `\${${name}}`;
    if (esc.length % 2) return orig.slice((esc.length + 1) / 2);
    return esc.slice(esc.length / 2) + value;
  });
}

// The ini reader npm uses (ini 4.x unsafe()): quotes, then `;` / `#` ending the value unless escaped.
function iniValue(raw) {
  let value = String(raw || '').trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    if (value.charAt(0) === "'") value = value.slice(1, -1);
    try { value = JSON.parse(value); } catch { /* kept as it is */ }
    return value;
  }
  let escaped = false;
  let out = '';
  for (const char of value) {
    if (escaped) {
      out += '\\;#'.includes(char) ? char : `\\${char}`;
      escaped = false;
    } else if (char === ';' || char === '#') {
      break;
    } else if (char === '\\') {
      escaped = true;
    } else {
      out += char;
    }
  }
  if (escaped) out += '\\';
  return out.trim();
}

/**
 * The top-level settings of an .npmrc, as npm's ini reader gives them (a key
 * inside a [section] is the section's; `true` / `false` / `null` are those
 * values; `key[]` makes a list; the last of a repeated key wins).
 */
export function parseNpmrc(text) {
  const out = Object.create(null);
  for (const line of String(text || '').split(/[\r\n]+/g)) {
    if (!line || /^\s*[;#]/.test(line) || /^\s*$/.test(line)) continue;
    if (/^\[([^\]]*)\]\s*$/.test(line)) break;
    const match = line.match(/^([^=]+)(=(.*))?$/);
    if (!match) continue;
    const rawKey = iniValue(match[1]);
    const isList = rawKey.length > 2 && rawKey.endsWith('[]');
    const key = isList ? rawKey.slice(0, -2) : rawKey;
    if (!key || key === '__proto__') continue;
    const raw = match[2] ? iniValue(match[3]) : true;
    const value = raw === 'true' || raw === 'false' || raw === 'null' ? JSON.parse(raw) : raw;
    if (isList) {
      if (!Array.isArray(out[key])) out[key] = out[key] === undefined ? [] : [out[key]];
    }
    if (Array.isArray(out[key])) out[key].push(value);
    else out[key] = value;
  }
  return out;
}

/** The npm_config_* settings of an environment, as npm reads them (any letter case, `_` as `-`, empty ones skipped; the last spelling wins). */
export function npmEnvConfig(env = process.env) {
  const out = Object.create(null);
  for (const [name, value] of Object.entries(env)) {
    if (!/^npm_config_/i.test(name) || value === '' || value === undefined) continue;
    let key = name.slice('npm_config_'.length);
    if (!key.startsWith('//')) key = key.replace(/(?!^)_/g, '-').toLowerCase();
    out[key] = value;
  }
  return out;
}

/** A path setting as npm parses it: ${VAR}, then `~/`, then absolute. null for one that is not a usable string. */
export function npmPathValue(value, { env = process.env, platform = process.platform, home, cwd = process.cwd() } = {}) {
  if (typeof value !== 'string') return null;
  const text = npmEnvReplace(value.trim(), env, platform);
  if (!text) return null;
  const impl = implFor(platform);
  const homePattern = platform === 'win32' ? /^~(\/|\\)/ : /^~\//;
  if (homePattern.test(text) && home) return impl.resolve(home, text.slice(2));
  return impl.resolve(cwd, text);
}

/** The home folder npm uses: HOME, else the account's (os.homedir(); on Windows USERPROFILE). */
export function npmHome(env = process.env, platform = process.platform) {
  if (env.HOME) return env.HOME;
  if (env === process.env) return homedir();
  if (platform === 'win32') return envLookup(env, 'USERPROFILE', platform) || homedir();
  return homedir();
}

/**
 * npm's global prefix, as described at the top. `builtin` is the builtin npmrc
 * of the npm that will run (lib/packaged-runtime.js names the packaged one),
 * `execPath` the node it runs on (for the default); leave both out to get only
 * what the user set (`source` then never says 'builtin' or 'default').
 *
 * Returns { prefix, bin, source, from, userconfig, globalconfig }: `prefix` an
 * absolute folder or null, `source` 'env' | 'userconfig' | 'globalconfig' |
 * 'builtin' | 'default' | null, `from` what set it (the variable or the file).
 */
export function resolveNpmPrefix({
  env = process.env,
  platform = process.platform,
  home = npmHome(env, platform),
  cwd = process.cwd(),
  readFile = readFileSync,
  builtin = null,
  execPath = null,
} = {}) {
  const impl = implFor(platform);
  const parse = { env, platform, home, cwd };
  const read = (file) => {
    if (!file) return Object.create(null);
    try { return parseNpmrc(readFile(file, 'utf8')); } catch { return Object.create(null); }
  };
  const fromEnv = npmEnvConfig(env);
  const envPrefix = npmPathValue(fromEnv.prefix, parse);
  const userconfig = npmPathValue(fromEnv.userconfig, parse) || (home ? impl.resolve(home, '.npmrc') : null);
  const user = read(userconfig);
  const userPrefix = npmPathValue(user.prefix, parse);
  const builtinConfig = read(builtin);
  const builtinPrefix = npmPathValue(builtinConfig.prefix, parse);
  let defaultPrefix = null;
  if (execPath) {
    if (env.PREFIX) defaultPrefix = npmPathValue(env.PREFIX, parse);
    else if (platform === 'win32') defaultPrefix = impl.dirname(execPath);
    else defaultPrefix = env.DESTDIR ? impl.join(env.DESTDIR, impl.dirname(impl.dirname(execPath))) : impl.dirname(impl.dirname(execPath));
  }
  const soFar = envPrefix || userPrefix || builtinPrefix || defaultPrefix;
  const globalconfig = npmPathValue(fromEnv.globalconfig, parse)
    || npmPathValue(user.globalconfig, parse)
    || npmPathValue(builtinConfig.globalconfig, parse)
    || (soFar ? impl.resolve(soFar, 'etc', 'npmrc') : null);
  const globalPrefix = npmPathValue(read(globalconfig).prefix, parse);
  const levels = [
    ['env', envPrefix, 'npm_config_prefix'],
    ['userconfig', userPrefix, userconfig],
    ['globalconfig', globalPrefix, globalconfig],
    ['builtin', builtinPrefix, builtin],
    ['default', defaultPrefix, execPath],
  ];
  const found = levels.find(([, value]) => value);
  const prefix = found ? found[1] : null;
  return {
    prefix,
    bin: npmGlobalBinFor(prefix, platform),
    source: found ? found[0] : null,
    from: found ? found[2] : null,
    userconfig,
    globalconfig,
  };
}

/**
 * resolveNpmPrefix() for this process, kept for a few seconds: every PATH
 * SynaBun builds asks, and a changed ~/.npmrc counts within seconds. Options
 * other than `builtin` and `execPath` (an env that is not process.env, a
 * readFile) are not cached.
 */
export function effectiveNpmPrefix(options = {}) {
  const { builtin = null, execPath = null, ...rest } = options;
  const live = Object.keys(rest).every(key => (key === 'env' ? rest.env === process.env : key === 'platform' ? rest.platform === process.platform : false));
  if (!live) return resolveNpmPrefix(options);
  const env = process.env;
  const relevant = Object.entries(env).filter(([name]) => /^npm_config_/i.test(name) || ['HOME', 'USERPROFILE', 'APPDATA', 'PREFIX', 'DESTDIR'].includes(name.toUpperCase()));
  const key = JSON.stringify([builtin, execPath, process.cwd(), relevant]);
  if (_memo && _memo.key === key && Date.now() - _memo.at < MEMO_MS) return _memo.value;
  const value = resolveNpmPrefix({ builtin, execPath });
  _memo = { key, at: Date.now(), value };
  return value;
}

/** Forget what effectiveNpmPrefix() keeps (a test, or a settings change that must count at once). */
export function forgetNpmPrefix() {
  _memo = null;
}
