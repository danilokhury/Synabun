import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The probes run no command: always the Windows sandbox that needs no administrator (lib/agent-sandbox-elevation.js).
import { CODEX_PROBE_SANDBOX_ARGS } from './agent-sandbox-elevation.js';

// The probes start Codex itself (a 300 MB binary on Windows) once per setting value: asynchronous, never
// more than two at a time, one run per binary for every caller, and kept per binary identity (path, mtime,
// size: an update is another binary) in memory and, through setCodexSettingsStore(), across restarts.
const cache = new Map();
const featureCache = new Map();
const inflight = new Map();
const latestSchema = new Map(); // codexBin → the schema of the binary as it was last read
let store = null;
const MAX_PROBES = 2;
let running = 0;
const waiting = [];

/** Where answers are kept across restarts: `{ get(key) → value | undefined, set(key, value) }` (lib/launch-cache.js). */
export function setCodexSettingsStore(next) {
  store = next && typeof next.get === 'function' && typeof next.set === 'function' ? next : null;
}

function limited(job) {
  return new Promise((resolve, reject) => {
    waiting.push({ job, resolve, reject });
    const pump = () => {
      while (running < MAX_PROBES && waiting.length) {
        const next = waiting.shift();
        running += 1;
        Promise.resolve().then(next.job).then(next.resolve, next.reject).finally(() => { running -= 1; pump(); });
      }
    };
    pump();
  });
}

// One Codex run: { status, stdout } (status null when it could not start or ran out of time).
function probe(codexBin, args, { env, timeout }) {
  return limited(() => new Promise((resolve) => {
    execFile(codexBin, args, { env, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      resolve({ status: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout: String(stdout || '') });
    });
  }));
}

// What was found for `key` before (this run, or the last one through the store), or undefined.
function known(memo, key) {
  if (memo.has(key)) return memo.get(key);
  try {
    const kept = store?.get(key);
    if (kept && typeof kept === 'object') { memo.set(key, kept); return kept; }
  } catch { /* nothing kept */ }
  return undefined;
}

function once(key, run) {
  if (inflight.has(key)) return inflight.get(key);
  const job = Promise.resolve().then(run).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}
export const CODEX_SETTINGS_KEYS = Object.freeze([
  'model', 'review_model', 'model_provider', 'approval_policy', 'sandbox_mode', 'personality',
  'service_tier', 'model_reasoning_effort', 'model_reasoning_summary', 'model_verbosity',
  'model_context_window', 'model_auto_compact_token_limit', 'web_search',
]);

export function schemaEnum(schema, definitions) {
  if (!schema) return [];
  if (schema.$ref) return schemaEnum(definitions[schema.$ref.split('/').pop()], definitions);
  return [...new Set([...(schema.enum || []).filter(v => typeof v === 'string'),
    ...['anyOf', 'oneOf', 'allOf'].flatMap(k => (schema[k] || []).flatMap(s => schemaEnum(s, definitions)))])];
}

export function settingsSchemaFromProtocol(configSchema, threadSchema) {
  const properties = configSchema.definitions?.Config?.properties || {};
  const fields = {};
  for (const key of CODEX_SETTINGS_KEYS) {
    const field = properties[key];
    if (!field || /@deprecated/.test(field.description || '')) continue;
    const values = schemaEnum(field, configSchema.definitions || {});
    fields[key] = { values, enumerated: values.length > 0,
      type: key.includes('token_limit') || key === 'model_context_window' ? 'number' : 'select' };
  }
  // Some older runtimes expose personality only on thread/turn params. Newer
  // ones explicitly retain it as a no-op: never present a no-op preference.
  const personality = threadSchema.properties?.personality;
  if (personality && !/@deprecated/.test(personality.description || '')) {
    fields.personality = { type: 'select', values: schemaEnum(personality, threadSchema.definitions || {}) };
  }
  return { fields };
}

/** Generate from the executable we actually launch; never use the global home. */
export async function readCodexSettingsSchema(codexBin) {
  const stamp = await stat(codexBin);
  const key = `schema:${codexBin}:${stamp.mtimeMs}:${stamp.size}`;
  const found = known(cache, key);
  if (found) { latestSchema.set(codexBin, found); return found; }
  return once(key, async () => {
    const home = await mkdtemp(join(tmpdir(), 'synabun-codex-schema-'));
    try {
      const env = { ...process.env, CODEX_HOME: home };
      const out = join(home, 'schema');
      const run = await probe(codexBin, ['app-server', 'generate-json-schema', '--experimental', '--out', out, ...CODEX_PROBE_SANDBOX_ARGS], { env, timeout: 15000 });
      if (run.status !== 0) throw new Error('Codex could not report its settings schema');
      const read = async name => JSON.parse(await readFile(join(out, 'v2', `${name}.json`), 'utf8'));
      const schema = settingsSchemaFromProtocol(await read('ConfigReadResponse'), await read('ThreadStartParams'));
      // Protocol enums can retain deprecated variants that the config loader
      // already rejects (0.162 still exports `untrusted`). Ask the loader too.
      // `features list` validates config locally and never runs a model or tool.
      for (const [fieldKey, field] of Object.entries(schema.fields)) {
        const checks = await Promise.all(field.values.map(value => probe(codexBin, [...CODEX_PROBE_SANDBOX_ARGS, '-c', `${fieldKey}=${JSON.stringify(value)}`, 'features', 'list'], { env, timeout: 5000 })));
        field.values = field.values.filter((_, index) => checks[index].status === 0);
      }
      cache.set(key, schema);
      latestSchema.set(codexBin, schema);
      try { store?.set(key, schema); } catch { /* kept in memory */ }
      return schema;
    } finally { await rm(home, { recursive: true, force: true }).catch(() => {}); }
  });
}

/** The schema readCodexSettingsSchema() last gave for this binary, or null: never starts Codex. */
export function cachedCodexSettingsSchema(codexBin) {
  return latestSchema.get(codexBin) || null;
}

export function validateCodexSettings(config, schema, features = []) {
  const result = {};
  for (const [key, value] of Object.entries(config || {})) {
    if (key === 'features') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid feature settings');
      Object.assign(result, validateCodexSettings(Object.fromEntries(Object.entries(value).map(([k, v]) => [`features.${k}`, v])), schema, features));
      continue;
    }
    if (key.startsWith('features.')) {
      const feature = features.find(f => `features.${f.name}` === key && ['stable', 'beta'].includes(f.stage) && f.configurable !== false);
      if (!feature || typeof value !== 'boolean') throw new Error(`Unsupported Codex feature: ${key}`);
    } else {
      const field = schema.fields?.[key];
      if (!field) throw new Error(`Unsupported Codex setting: ${key}`);
      if (value !== null) {
        if (field.type === 'number') {
          if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid token count: ${key}`);
        } else if (typeof value !== 'string' || !value || ((field.enumerated || field.values.length) && !field.values.includes(value))) {
          // Preserve granular approval policies; only the UI's string choices are editable.
          throw new Error(`Invalid Codex setting value: ${key}`);
        }
      }
    }
    result[key] = value;
  }
  return result;
}

/** Some stable flags are now mandatory and ignore false (e.g. unified_exec).
 * Check both states with the local loader instead of offering a no-op switch. */
export async function readCodexFeatureSupport(codexBin, features) {
  const names = features.filter(f => ['stable', 'beta'].includes(f.stage) && /^[A-Za-z0-9_-]+$/.test(f.name)).map(f => f.name).sort();
  const stamp = await stat(codexBin);
  const key = `features:${codexBin}:${stamp.mtimeMs}:${stamp.size}:${names.join(',')}`;
  const found = known(featureCache, key);
  if (found) return found;
  return once(key, async () => {
    const home = await mkdtemp(join(tmpdir(), 'synabun-feature-support-'));
    try {
      const env = { ...process.env, CODEX_HOME: home };
      const states = await Promise.all([false, true].map(async value => {
        const check = await probe(codexBin, [...CODEX_PROBE_SANDBOX_ARGS, '-c', `features={${names.map(name => `${name}=${value}`).join(',')}}`, 'features', 'list'], { env, timeout: 10000 });
        if (check.status !== 0) throw new Error('Codex could not validate feature switches');
        return new Map(check.stdout.split('\n').map(line => {
          const parts = line.trim().split(/\s+/); return [parts[0], parts.at(-1)];
        }));
      }));
      const supported = Object.fromEntries(names.map(name => [name, states[0].get(name) === 'false' && states[1].get(name) === 'true']));
      featureCache.set(key, supported);
      try { store?.set(key, supported); } catch { /* kept in memory */ }
      return supported;
    } finally { await rm(home, { recursive: true, force: true }).catch(() => {}); }
  });
}
