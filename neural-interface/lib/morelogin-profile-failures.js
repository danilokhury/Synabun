/**
 * A run's own browser profile failed in that run: the run may not move to another profile (2026-11-15).
 *
 * Every start of a MoreLogin profile that is not running spends one of the plan's 20 daily launches. On 2026-11-15 at
 * 21:13:36 run 8d50b0303fd3aabcdab1eceb52850b90, which had chosen P-4 itself (`morelogin use`, so not pinned), could
 * not connect to P-4 ("Browser context management is not supported": MoreLogin listed P-4 running with no window); at
 * 21:13:43 it called `morelogin use` with P-1 and its next browser call started P-1 (21:13:44, one launch). A pinned
 * run is refused such a move already (PROFILE_PINNED); a run that chose its profile itself was not.
 *
 * Now a failure of the run's own profile (a start or a connection that failed in one of the run's acquisitions:
 * server.js acquireSharedBrowserTab, an automation's POST /api/browser/sessions in the default profile, its own
 * POST /api/morelogin/start of that profile) is noted for the run. While it holds, the run's `morelogin use` of any
 * other profile, or back to the default browser when that is another profile or Chrome (POST /api/morelogin/use, which
 * `browser_session create` with `moreloginProfile` calls too), and its `morelogin start` of another profile are
 * refused with 409 PROFILE_FAILED_NO_SWITCH: which profile failed, when, why, and how to go on. Asking `use` for the
 * failed profile itself is no move and stays allowed, and so does a start of it (that is how it is fixed).
 *
 * The bar lifts when:
 *   - the failed profile connects again in this run: an acquisition of the run lands in a session of that profile
 *     (the user started or fixed it, in MoreLogin or Settings → Connected tools → MoreLogin → Start, and the run's next
 *     browser call attached). A start that only reports success does not lift it: the connection must work;
 *   - the run no longer works in that profile because the owner moved it (profileSwitchDecision `lifted`): its
 *     effective profile (its pin, else the default AI browser) is not the failed one any more. The run cannot move
 *     itself while barred, so any such change is the owner's (a new default in Settings → Connected tools → MoreLogin);
 *   - the run ends (server.js forgetRunMoreLoginProfile, with its pin), or the entry is older than
 *     PROFILE_FAILURE_MAX_AGE_MS.
 * The owner's own actions are never asked: the owner's page has no session to switch (POST /api/morelogin/use answers it
 * SESSION_REQUIRED), and its Start, Stop and default change go through as before.
 *
 * State: in memory and in DATA_HOME/data/morelogin-profile-failures.json (a restart resumes runs: a barred run must stay
 * barred), like the sessions' profile choices (lib/browser-profile-choices.js). Never throws.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const PROFILE_FAILED_NO_SWITCH = 'PROFILE_FAILED_NO_SWITCH';
/** Entries kept at most (the oldest go first). */
export const PROFILE_FAILURES_MAX = 500;
/** An entry older than this no longer bars anything (its run has long ended). */
export const PROFILE_FAILURE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

const OWNER_RE = /^[A-Za-z0-9_:-]{1,128}$/;
const cleanId = (value) => {
  const id = value === null || value === undefined ? '' : String(value).trim();
  return id && id.length <= 128 && !/[\u0000-\u001f]/.test(id) ? id : '';
};
const cleanText = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max) : '');

/** "2026-11-15 21:13:36 (UTC-03:00)": the local time a failure happened, to the second. */
export function formatFailureTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} (UTC${off >= 0 ? '+' : '-'}${p(Math.floor(abs / 60))}:${p(abs % 60)})`;
}

/**
 * The reason of a failure as the refusal quotes it: the failure's first sentence (a start error carries its whole
 * advice after it), at most 240 characters, never empty.
 */
export function failureReasonOf(text) {
  const flat = cleanText(String(text ?? ''), 2000);
  if (!flat) return 'no reason was given';
  const first = flat.split(/(?<=[.!?])\s+(?=[A-Z])/)[0] || flat;
  return first.length > 240 ? `${first.slice(0, 237).trimEnd()}…` : first;
}

/**
 * What a switch of a run with this failure is: `none` (no failure held), `lifted` (the run no longer works in the
 * failed profile: the owner moved it, so the failure is over), `same` (the target is the failed profile itself: no
 * move) or `barred`. `current`: the run's effective profile now (an envId, or null for a browser that is no profile:
 * Chrome, the mirror, the extension); `sameTarget`: whether what it asks for is the failed profile.
 */
export function profileSwitchDecision({ failure = null, current = null, sameTarget = false } = {}) {
  if (!failure?.envId) return 'none';
  if ((current === null || current === undefined ? null : String(current)) !== String(failure.envId)) return 'lifted';
  return sameTarget === true ? 'same' : 'barred';
}

/**
 * Whether a `use` request's reference ({ envId, name, profile }, as POST /api/morelogin/use takes it) names the failed
 * profile itself: its id, or its name without regard to case. Then it is no move, and the request is resolved and
 * answered as usual; anything else is refused before MoreLogin is asked for its list.
 */
export function namesFailedProfile(ref, failure) {
  if (!failure?.envId || !ref || typeof ref !== 'object') return false;
  const id = String(failure.envId);
  const name = cleanText(failure.name, 200).toLowerCase();
  const same = (value) => {
    const text = value === null || value === undefined ? '' : cleanText(String(value), 200);
    return !!text && (text === id || (!!name && text.toLowerCase() === name));
  };
  return same(ref.envId) || same(ref.name) || same(ref.profile);
}

/**
 * The refusal of a run's switch after its own profile failed. `label` / `targetLabel`: how the failed profile and the
 * target are named (`MoreLogin profile "P-4" (id)`, `the default browser`); `action`: 'use' (a move) or 'start' (a
 * start of another profile). Code PROFILE_FAILED_NO_SWITCH, status 409, needsUser, with envId, failedAt, failedCode.
 */
export function profileSwitchBarError(failure, { label = null, targetLabel = null, action = 'use' } = {}) {
  const name = label || `profile ${failure?.envId}`;
  const there = targetLabel || 'another profile';
  const when = Number.isFinite(Number(failure?.at)) ? formatFailureTime(Number(failure.at)) : 'an earlier moment';
  const why = failureReasonOf(failure?.reason);
  const code = failure?.code ? `${failure.code}: ` : '';
  const starting = action === 'start';
  const e = new Error(`This run cannot ${starting ? 'start' : 'move to'} ${there}: its own profile, ${name}, failed in this run at ${when} (${code}${why}). After its own profile fails, a run does not ${starting ? 'start another profile or move to one' : 'switch to another profile or browser'}: each start of another MoreLogin profile spends one of the plan's daily launches, and the run's work belongs in its own profile. Nothing was ${starting ? 'started' : 'changed'}: the run still works in ${name}. To go on, the user starts or fixes ${name} (in MoreLogin, or SynaBun → Settings → Connected tools → MoreLogin → Start); the run's next browser call then connects to it, and from then on it may switch again. Otherwise the owner moves the run (where it is set up, or the default in Settings → Connected tools → MoreLogin (Default AI browser)). This needs the user, not a retry: report it and stop`);
  e.code = PROFILE_FAILED_NO_SWITCH;
  e.status = 409;
  e.needsUser = true;
  e.envId = String(failure?.envId ?? '');
  if (Number.isFinite(Number(failure?.at))) e.failedAt = new Date(Number(failure.at)).toISOString();
  if (failure?.code) e.failedCode = String(failure.code);
  return e;
}

/**
 * The failures file. Every method is synchronous and never throws: a file that cannot be read holds no failures, and a
 * write that fails is logged and leaves the entry in memory (it bars until a restart).
 * @param {{ file?: string|null, now?: () => number, log?: (line: string) => void, max?: number, maxAgeMs?: number }} opts
 */
export function createProfileFailureStore({ file = null, now = Date.now, log = () => {}, max = PROFILE_FAILURES_MAX, maxAgeMs = PROFILE_FAILURE_MAX_AGE_MS } = {}) {
  /** ownerKey → { envId, name, at, code, reason }, oldest first. */
  let rows = null;

  const fresh = (row) => row && Number.isFinite(Number(row.at)) && now() - Number(row.at) < maxAgeMs;

  function read() {
    const out = new Map();
    try {
      if (!file || !existsSync(file)) return out;
      const data = JSON.parse(readFileSync(file, 'utf-8'));
      const list = data && typeof data === 'object' && data.failures && typeof data.failures === 'object' ? Object.entries(data.failures) : [];
      for (const [owner, row] of list.filter(([owner, row]) => OWNER_RE.test(owner) && fresh(row)).sort((a, b) => Number(a[1].at) - Number(b[1].at))) {
        const envId = cleanId(row.envId);
        if (!envId) continue;
        out.set(owner, { envId, name: cleanText(row.name, 200) || null, at: Number(row.at), code: cleanText(row.code, 64) || null, reason: cleanText(row.reason, 600) || null });
      }
    } catch (error) {
      log(`the runs' failed browser profiles could not be read (${error?.message || error}): no run is barred from switching`);
    }
    return out;
  }

  function write() {
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ version: 1, failures: Object.fromEntries(rows) }, null, 2), { mode: 0o600 });
      renameSync(temp, file);
    } catch (error) {
      log(`a run's failed browser profile was not saved (${error?.message || error}): it bars the run until the server restarts`);
    }
  }

  const loaded = () => (rows ||= read());
  const copy = (row) => ({ ...row });

  return {
    /** The failure held for `ownerKey` ({ envId, name, at, code, reason }), or null. An expired one is dropped. */
    get(ownerKey) {
      const map = loaded();
      const row = map.get(String(ownerKey || ''));
      if (!row) return null;
      if (!fresh(row)) { map.delete(String(ownerKey)); write(); return null; }
      return copy(row);
    },
    /**
     * `ownerKey`'s own profile `envId` failed now (or at `at`). A later failure replaces an earlier one (the newest
     * profile and reason are what the refusal names). Returns the entry, or null when nothing was noted.
     */
    note(ownerKey, { envId, name = null, code = null, reason = null, at = now() } = {}) {
      const owner = String(ownerKey || '');
      const id = cleanId(envId);
      if (!OWNER_RE.test(owner) || !id) return null;
      const map = loaded();
      const row = { envId: id, name: cleanText(name, 200) || null, at: Number.isFinite(Number(at)) ? Number(at) : now(), code: cleanText(code, 64) || null, reason: cleanText(reason, 600) || null };
      map.delete(owner); // newest last
      map.set(owner, row);
      while (map.size > max) map.delete(map.keys().next().value);
      write();
      return copy(row);
    },
    /**
     * The failure of `ownerKey` is over: always, or only when it is about `envId` (a connection to another profile
     * says nothing about the failed one). Returns the entry that was dropped, or null.
     */
    clear(ownerKey, { envId = null } = {}) {
      const map = loaded();
      const owner = String(ownerKey || '');
      const row = map.get(owner);
      if (!row) return null;
      if (envId !== null && envId !== undefined && String(envId) !== row.envId) return null;
      map.delete(owner);
      write();
      return copy(row);
    },
    /** Every failure held now: [ownerKey, entry], oldest first. */
    entries() {
      return [...loaded()].filter(([, row]) => fresh(row)).map(([owner, row]) => [owner, copy(row)]);
    },
  };
}
