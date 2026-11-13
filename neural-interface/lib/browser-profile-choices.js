// ── A session's own MoreLogin profile: what it resolves to, and where the choice is kept (DOM-free) ──
//
// A run can be launched with a MoreLogin profile (a schedule's, a group's, a timer's, a launch's, a dispatch's:
// server.js pinRunMoreLoginProfile). A session can also choose one for itself while it runs (the `morelogin` tool's
// "use" action, POST /api/morelogin/use): the same pin, set for the caller's own owner key and for nobody else. The
// default of Settings → Browser and every other session stay as they are.
//
// The pin map lives in memory, and a run's launch pin is read back from its loop file after a restart. A choice a
// session made itself has no such file (a side panel, the Assistant's brain, a CLI window), and losing it would send
// that session's next browser call to the default profile without a word: another account. So choices are kept in one
// small file (DATA_HOME/data/browser-profile-choices.json) and put back into the pin map when the server starts.
// `envId: null` is a choice too: "the Browser settings default", made by a run that was launched with a profile.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Choices kept at most (the oldest go first). */
export const PROFILE_CHOICES_MAX = 500;
/** A choice older than this is not put back after a restart: no session lives that long. */
export const PROFILE_CHOICE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const OWNER_RE = /^[A-Za-z0-9_:-]{1,128}$/;
const cleanId = (value) => {
  const id = value === null || value === undefined ? '' : String(value).trim();
  return id && id.length <= 128 && !/[\u0000-\u001f]/.test(id) ? id : '';
};
const cleanName = (value) => (typeof value === 'string' ? value.trim().slice(0, 200) : '');

function refusal(status, code, message, extra = {}) {
  return Object.assign(new Error(message), { status, code, ...extra });
}

/**
 * The profile a reference names among MoreLogin's listed profiles.
 * @param {{ envId?: unknown, name?: unknown, profile?: unknown }} ref  `envId`: an id; `name`: a name; `profile`:
 *   either (an id first, then a name). Names match whole, without regard to case.
 * @param {Array<{ id: unknown, name?: unknown }>} envs  what MoreLogin lists
 * @returns {{ envId: string, name: string|null }}
 * @throws 400 PROFILE_REQUIRED (nothing named), 404 ENV_NOT_FOUND, 409 PROFILE_AMBIGUOUS (a name several profiles have)
 */
export function resolveProfileRef(ref, envs) {
  const rows = (Array.isArray(envs) ? envs : []).filter((env) => env && cleanId(env.id));
  const byId = (id) => rows.find((env) => String(env.id) === id) || null;
  const byName = (name) => rows.filter((env) => cleanName(env.name).toLowerCase() === name.toLowerCase());
  const found = (env) => ({ envId: String(env.id), name: cleanName(env.name) || null });
  const listed = () => (rows.length
    ? ` MoreLogin lists: ${rows.slice(0, 20).map((env) => `${cleanName(env.name) || '(no name)'} (id ${env.id})`).join(', ')}${rows.length > 20 ? ', …' : ''}.`
    : ' MoreLogin lists no profile.');
  const envId = cleanId(ref?.envId);
  const name = cleanName(ref?.name);
  const either = cleanName(ref?.profile);
  if (!envId && !name && !either) throw refusal(400, 'PROFILE_REQUIRED', 'Name the MoreLogin profile: its id (envId) or its name. The "list" action of the morelogin tool gives both.');
  if (envId) {
    const env = byId(envId);
    if (env) return found(env);
    if (!name && !either) throw refusal(404, 'ENV_NOT_FOUND', `MoreLogin has no profile with id ${envId.slice(0, 64)}.${listed()}`);
  }
  const wanted = name || either;
  if (!envId && either) {
    const env = byId(either);
    if (env) return found(env);
  }
  const matches = byName(wanted);
  if (matches.length === 1) return found(matches[0]);
  if (matches.length > 1) {
    throw refusal(409, 'PROFILE_AMBIGUOUS', `${matches.length} MoreLogin profiles are named "${wanted}" (ids ${matches.map((env) => env.id).join(', ')}): name the one you mean by its id.`,
      { ids: matches.map((env) => String(env.id)) });
  }
  throw refusal(404, 'ENV_NOT_FOUND', `MoreLogin has no profile named "${wanted.slice(0, 64)}"${envId ? ` and none with id ${envId.slice(0, 64)}` : ''}.${listed()}`);
}

/**
 * The choices file. Every method is synchronous and never throws: a file that cannot be read is no choices, and a
 * write that fails is logged and leaves the in-memory pin (the session's choice still holds until a restart).
 * @param {{ file: string, now?: () => number, log?: (line: string) => void, max?: number, maxAgeMs?: number }} opts
 */
export function createProfileChoiceStore({ file, now = Date.now, log = () => {}, max = PROFILE_CHOICES_MAX, maxAgeMs = PROFILE_CHOICE_MAX_AGE_MS } = {}) {
  /** ownerKey → { envId: string|null, name: string|null, at: number }, oldest first. */
  let choices = null;

  function read() {
    const out = new Map();
    try {
      if (!file || !existsSync(file)) return out;
      const data = JSON.parse(readFileSync(file, 'utf-8'));
      const rows = data && typeof data === 'object' && data.choices && typeof data.choices === 'object' ? Object.entries(data.choices) : [];
      const fresh = rows
        .filter(([owner, row]) => OWNER_RE.test(owner) && row && typeof row === 'object' && Number.isFinite(Number(row.at)) && now() - Number(row.at) <= maxAgeMs)
        .sort((a, b) => Number(a[1].at) - Number(b[1].at));
      for (const [owner, row] of fresh) {
        const envId = cleanId(row.envId);
        out.set(owner, { envId: envId || null, name: envId ? (cleanName(row.name) || null) : null, at: Number(row.at) });
      }
    } catch (error) {
      log(`the sessions' MoreLogin profile choices could not be read (${error?.message || error}): none is put back`);
    }
    return out;
  }

  function write() {
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ version: 1, choices: Object.fromEntries(choices) }, null, 2));
      renameSync(temp, file);
    } catch (error) {
      log(`a session's MoreLogin profile choice was not saved (${error?.message || error}): it holds until the server restarts`);
    }
  }

  const loaded = () => (choices ||= read());

  return {
    /** Every kept choice: [ownerKey, { envId, name }], oldest first. */
    entries() {
      return [...loaded()].map(([owner, row]) => [owner, { envId: row.envId, name: row.name }]);
    },
    /** The choice of one owner ({ envId, name }; envId null = the default), or undefined when it made none. */
    get(ownerKey) {
      const row = loaded().get(ownerKey);
      return row ? { envId: row.envId, name: row.name } : undefined;
    },
    /** Keep `ownerKey`'s choice: a profile, or null for "the Browser settings default". */
    set(ownerKey, choice) {
      if (!OWNER_RE.test(String(ownerKey || ''))) return false;
      const envId = cleanId(choice?.envId);
      const map = loaded();
      map.delete(ownerKey);
      map.set(ownerKey, { envId: envId || null, name: envId ? (cleanName(choice?.name) || null) : null, at: now() });
      while (map.size > max) map.delete(map.keys().next().value);
      write();
      return true;
    },
    /** Forget `ownerKey`'s choice (it never made one). */
    delete(ownerKey) {
      const map = loaded();
      if (!map.delete(ownerKey)) return false;
      write();
      return true;
    },
  };
}
