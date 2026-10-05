import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const CODEX_SESSION_SETTING_KEYS = Object.freeze(['model', 'effort', 'summary', 'personality', 'serviceTier', 'approvalPolicy', 'approvalsReviewer', 'disabledPluginIds']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

/** Session choices are scoped to account/thread and never written to config.toml. */
export class CodexSessionSettingsStore {
  constructor(filePath) { this.filePath = filePath; this.settings = null; }
  load() {
    if (this.settings) return;
    if (!existsSync(this.filePath)) { this.settings = {}; return; }
    const value = JSON.parse(readFileSync(this.filePath, 'utf8'));
    if (value?.version !== 1 || !value.settings || typeof value.settings !== 'object' || Array.isArray(value.settings)) {
      throw new Error('Invalid Codex session settings file.');
    }
    this.settings = value.settings;
  }
  key(accountId, threadId) {
    if (!accountId || !threadId) throw new Error('Session settings require an account and thread.');
    return JSON.stringify([String(accountId), String(threadId)]);
  }
  get(accountId, threadId) {
    if (!threadId) return {};
    this.load();
    return structuredClone(this.settings[this.key(accountId, threadId)] || {});
  }
  set(accountId, threadId, patch) {
    this.load();
    const key = this.key(accountId, threadId);
    const nextSettings = { ...this.settings[key] };
    for (const name of CODEX_SESSION_SETTING_KEYS) if (own(patch, name)) nextSettings[name] = structuredClone(patch[name]);
    const next = { ...this.settings, [key]: nextSettings };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, settings: next }), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, this.filePath);
    } finally {
      try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    this.settings = next;
    return structuredClone(nextSettings);
  }
}
