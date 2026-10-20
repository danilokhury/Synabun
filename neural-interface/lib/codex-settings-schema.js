import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The probes run no command: always the Windows sandbox that needs no administrator (lib/agent-sandbox-elevation.js).
import { CODEX_PROBE_SANDBOX_ARGS } from './agent-sandbox-elevation.js';

const cache = new Map();
const featureCache = new Map();
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
export function readCodexSettingsSchema(codexBin) {
  const stamp = statSync(codexBin);
  const key = `${codexBin}:${stamp.mtimeMs}:${stamp.size}`;
  if (cache.has(key)) return cache.get(key);
  const home = mkdtempSync(join(tmpdir(), 'synabun-codex-schema-'));
  try {
    const out = join(home, 'schema');
    const run = spawnSync(codexBin, ['app-server', 'generate-json-schema', '--experimental', '--out', out, ...CODEX_PROBE_SANDBOX_ARGS], {
      env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8', timeout: 15000, windowsHide: true,
    });
    if (run.error || run.status !== 0) throw new Error('Codex could not report its settings schema');
    const read = name => JSON.parse(readFileSync(join(out, 'v2', `${name}.json`), 'utf8'));
    const schema = settingsSchemaFromProtocol(read('ConfigReadResponse'), read('ThreadStartParams'));
    // Protocol enums can retain deprecated variants that the config loader
    // already rejects (0.162 still exports `untrusted`). Ask the loader too.
    // `features list` validates config locally and never runs a model or tool.
    for (const [fieldKey, field] of Object.entries(schema.fields)) {
      field.values = field.values.filter(value => {
        const check = spawnSync(codexBin, [...CODEX_PROBE_SANDBOX_ARGS, '-c', `${fieldKey}=${JSON.stringify(value)}`, 'features', 'list'], {
          env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8', timeout: 5000, windowsHide: true,
        });
        return !check.error && check.status === 0;
      });
    }
    cache.set(key, schema);
    return schema;
  } finally { rmSync(home, { recursive: true, force: true }); }
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
export function readCodexFeatureSupport(codexBin, features) {
  const names = features.filter(f => ['stable', 'beta'].includes(f.stage) && /^[A-Za-z0-9_-]+$/.test(f.name)).map(f => f.name).sort();
  const stat = statSync(codexBin);
  const key = `${codexBin}:${stat.mtimeMs}:${stat.size}:${names.join(',')}`;
  if (featureCache.has(key)) return featureCache.get(key);
  const home = mkdtempSync(join(tmpdir(), 'synabun-feature-support-'));
  try {
    const states = [false, true].map(value => {
      const check = spawnSync(codexBin, [...CODEX_PROBE_SANDBOX_ARGS, '-c', `features={${names.map(name => `${name}=${value}`).join(',')}}`, 'features', 'list'], {
        env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8', timeout: 10000, windowsHide: true,
      });
      if (check.error || check.status !== 0) throw new Error('Codex could not validate feature switches');
      return new Map(check.stdout.split('\n').map(line => {
        const parts = line.trim().split(/\s+/); return [parts[0], parts.at(-1)];
      }));
    });
    const supported = Object.fromEntries(names.map(name => [name, states[0].get(name) === 'false' && states[1].get(name) === 'true']));
    featureCache.set(key, supported);
    return supported;
  } finally { rmSync(home, { recursive: true, force: true }); }
}
