// ═══════════════════════════════════════════
// SynaBun — Maritaca AI: the API key and the panel settings
// ═══════════════════════════════════════════
//
// The key lives in SynaBun's own file, DATA_HOME/data/maritaca/.synabun-api-key (0600, atomic
// replace, never followed as a link: the same discipline as lib/claude-profile-api-key.js), or
// comes from the environment (MARITACA_API_KEY, the name Maritaca's own library reads) when no
// file is saved. It is never returned to a page: GET answers whether a key is set and where it
// comes from, with a masked tail. The other settings (default model, reasoning effort, system
// prompt) are plain JSON next to it.

import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { MARITACA_DEFAULT_MODEL, findMaritacaModel, normalizeMaritacaEffort } from './models.js';

export const MARITACA_KEY_FILE = '.synabun-api-key';
export const MARITACA_SETTINGS_FILE = 'settings.json';
export const MARITACA_ENV_KEY = 'MARITACA_API_KEY';
const MAX_SYSTEM_PROMPT = 8000;

export function keyStoreError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

/** The key as it is saved: trimmed, one line, 16–4096 printable ASCII characters. Throws INVALID_KEY. */
export function validateMaritacaKey(key) {
  if (typeof key !== 'string' || key.length > 4096) throw keyStoreError('INVALID_KEY', "That doesn't look like a Maritaca API key.");
  const value = key.trim();
  if (value.length < 16 || !/^[\x21-\x7e]+$/.test(value)) throw keyStoreError('INVALID_KEY', "That doesn't look like a Maritaca API key.");
  return value;
}

/** What a page may see of a key: its last four characters. */
export function maskKey(key) {
  const s = String(key || '');
  return s.length >= 8 ? `…${s.slice(-4)}` : '…';
}

const DEFAULTS = Object.freeze({ model: MARITACA_DEFAULT_MODEL, reasoningEffort: null, systemPrompt: '', temperature: null });

/** Settings as saved → settings as used: an unknown model falls back, an unknown effort is dropped. */
export function normalizeMaritacaSettings(raw = {}) {
  const out = { ...DEFAULTS };
  const src = raw && typeof raw === 'object' ? raw : {};
  const model = findMaritacaModel(src.model);
  out.model = model ? model.id : typeof src.model === 'string' && src.model.trim() ? src.model.trim().slice(0, 80) : MARITACA_DEFAULT_MODEL;
  // An alias (xhigh / max / minimal, from a settings file written before 2026-11-08) is read as the level it names.
  out.reasoningEffort = normalizeMaritacaEffort(src.reasoningEffort);
  out.systemPrompt = typeof src.systemPrompt === 'string' ? src.systemPrompt.slice(0, MAX_SYSTEM_PROMPT) : '';
  const temp = Number(src.temperature);
  out.temperature = src.temperature === null || src.temperature === undefined || src.temperature === '' ? null : Number.isFinite(temp) ? Math.min(2, Math.max(0, temp)) : null;
  return out;
}

export function createMaritacaKeyStore({ dir, env = process.env } = {}) {
  if (!dir) throw new Error('createMaritacaKeyStore needs dir');
  const keyPath = join(dir, MARITACA_KEY_FILE);
  const settingsPath = join(dir, MARITACA_SETTINGS_FILE);

  function readFileKey() {
    let fd;
    try {
      fd = openSync(keyPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const stat = fstatSync(fd);
      if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw keyStoreError('UNSAFE_KEY_FILE', 'The saved key file has unsafe permissions. Save the key again.', 500);
      return validateMaritacaKey(readFileSync(fd, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error.code === 'INVALID_KEY') return null;
      throw error;
    } finally { if (fd !== undefined) closeSync(fd); }
  }

  /** The key to use: the saved file first, then the environment. null without either. */
  function readKey() {
    const file = readFileKey();
    if (file) return file;
    const fromEnv = typeof env[MARITACA_ENV_KEY] === 'string' ? env[MARITACA_ENV_KEY].trim() : '';
    try { return fromEnv ? validateMaritacaKey(fromEnv) : null; } catch { return null; }
  }

  /** Where the key in use comes from: 'file' | 'env' | null. */
  function keySource() {
    if (readFileKey()) return 'file';
    const fromEnv = typeof env[MARITACA_ENV_KEY] === 'string' ? env[MARITACA_ENV_KEY].trim() : '';
    try { return fromEnv && validateMaritacaKey(fromEnv) ? 'env' : null; } catch { return null; }
  }

  function saveKey(key) {
    const value = validateMaritacaKey(key);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = `${keyPath}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, value, { mode: 0o600, flag: 'wx' }); renameSync(temp, keyPath); }
    finally { rmSync(temp, { force: true }); }
  }

  function clearKey() { rmSync(keyPath, { force: true }); }

  function readSettings() {
    try { return normalizeMaritacaSettings(JSON.parse(readFileSync(settingsPath, 'utf8'))); }
    catch { return normalizeMaritacaSettings({}); }
  }

  function saveSettings(patch = {}) {
    const next = normalizeMaritacaSettings({ ...readSettings(), ...(patch && typeof patch === 'object' ? patch : {}) });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = `${settingsPath}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' }); renameSync(temp, settingsPath); }
    finally { rmSync(temp, { force: true }); }
    return next;
  }

  /** What a page is told: never the key. */
  function status() {
    const source = keySource();
    const key = source ? readKey() : null;
    return { configured: !!key, source, masked: key ? maskKey(key) : null, settings: readSettings() };
  }

  return { dir, readKey, keySource, saveKey, clearKey, readSettings, saveSettings, status };
}
