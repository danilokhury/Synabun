/**
 * One face for the two kinds of browser profile SynaBun drives over the Chrome DevTools protocol:
 *   • MoreLogin profiles (lib/morelogin.js): the MoreLogin app's own, reached through its local API;
 *   • local profiles (lib/local-profiles.js): a Chrome SynaBun starts itself with a data folder of its own.
 *
 * Everything server.js does with a profile is keyed by the profile's id (the default AI browser, the owner's list of
 * profiles agents may choose, a run's or a session's pin, the pickers, start / stop). So this module re-exports
 * lib/morelogin.js as it is and routes the calls that take an id: a local id (`lp-` + 12 hex characters) goes to the
 * local launcher, every other id to MoreLogin. The lists hold both kinds; a local row says `kind: 'local'`.
 *
 * A local profile is never created in, listed by or started through MoreLogin, and `createProfile` stays MoreLogin's.
 */
import * as ml from './morelogin.js';
import { LOCAL_PROFILE_PORT_RANGE, createLocalProfiles, isLocalProfileId } from './local-profiles.js';

export * from './morelogin.js';
export { isLocalProfileId, LOCAL_PROFILE_PORT_RANGE };

let _local = null;

/** Sets up the local profiles of this process (server.js, once; a test, with its own root). → the instance. */
export function configureLocalProfiles(options) {
  _local = options ? createLocalProfiles(options) : null;
  return _local;
}
/** The local profiles, or null where none were set up. */
export function localProfiles() { return _local; }

function local() {
  if (!_local) throw Object.assign(new Error('Local profiles are not available in this process.'), { status: 500, code: 'LOCAL_PROFILES_UNAVAILABLE' });
  return _local;
}

/** Rows of the local profiles in the list's shape ([] where none were set up). Throws only for an unreadable store. */
export async function listLocalProfiles() { return _local ? _local.listLocalProfiles() : []; }
export async function localProfileDetails() { return local().localProfileDetails(); }
export async function createLocalProfile(input) { return local().createLocalProfile(input); }
export async function updateLocalProfile(id, input) { return local().updateLocalProfile(id, input); }
export async function deleteLocalProfile(id) { return local().deleteLocalProfile(id); }
export async function checkLocalProfileProxy(id, override) { return local().checkLocalProfileProxy(id, override); }
export async function adoptLocalProfiles() { return _local ? _local.adoptRunning() : []; }
/** How many local profiles there are (0 where none were set up; nothing is started or probed). */
export function localProfileCount() { return _local ? _local.count() : 0; }
/** A local profile's name, or null. */
export function localProfileName(id) { return _local && isLocalProfileId(id) ? _local.nameOf(id) : null; }
/** { name, timezone, language } of a local profile, or null. */
export function localProfileSettings(id) { return _local && isLocalProfileId(id) ? _local.settingsOf(id) : null; }
/**
 * The loopback ports SynaBun keeps for local profiles ({ from, to }): every proxy relay and every DevTools port of a
 * local profile is inside it. A guarded worker's sandbox denies the whole range (server.js workerBrowserControlPorts).
 */
export function localProfilePortRange() { return _local ? _local.portRange : LOCAL_PROFILE_PORT_RANGE; }
/** The loopback ports of the local profiles' proxy relays. */
export function localRelayPorts() { try { return _local ? _local.relayPorts() : []; } catch { return []; } }

/** A short reason of a failed MoreLogin call, as the lists carry it. */
function describeError(err) {
  return { message: String(err?.message || err), code: err?.code || null };
}

/**
 * Every profile: MoreLogin's, then the local ones. → { envs, moreloginError, localCount }.
 * `moreloginError` ({ message, code } or null): MoreLogin's list could not be read (the app is closed, its API
 * refused); `envs` then holds the local profiles alone. Never throws for MoreLogin; an unreadable local store does.
 */
export async function listAllProfiles(opts = {}) {
  const firstPage = (opts.pageNo || 1) === 1;
  const localRows = firstPage ? await listLocalProfiles() : [];
  let remote = [];
  let moreloginError = null;
  try { remote = await ml.listProfiles(opts); } catch (err) { moreloginError = describeError(err); moreloginError.cause = err; }
  return { envs: [...remote, ...localRows], moreloginError, localCount: localRows.length };
}

/**
 * The list server.js reads everywhere: MoreLogin's profiles and the local ones. When MoreLogin cannot be reached the
 * local ones are returned, and the array carries the reason as `moreloginError` (not enumerable). With no local
 * profile at all the answer is MoreLogin's alone, its failure included, as it was before local profiles existed.
 */
export async function listProfiles(opts = {}) {
  const all = await listAllProfiles(opts);
  if (all.moreloginError && !all.localCount) throw all.moreloginError.cause;
  const rows = all.envs;
  Object.defineProperty(rows, 'moreloginError', { value: all.moreloginError ? { message: all.moreloginError.message, code: all.moreloginError.code } : null, enumerable: false });
  return rows;
}

/**
 * Start a profile → { debugPort, webdriver, kernel }. A local id starts SynaBun's own Chrome. `opts.owner === true`
 * is the owner's own Start: only that may end a running local profile to start it again. Every other caller of a
 * local profile that has to be restarted first (its proxy changed) or that does not answer is refused with
 * LOCAL_PROFILE_RESTART_NEEDED / LOCAL_PROFILE_BUSY, and nothing here ever answers with another profile in its place.
 */
export async function startProfile(envId, opts = {}) {
  if (isLocalProfileId(String(envId))) return local().startLocalProfile(String(envId), { owner: opts?.owner === true });
  return ml.startProfile(envId, opts);
}

/** Stop a profile. */
export async function stopProfile(envId, opts = {}) {
  if (isLocalProfileId(String(envId))) return local().stopLocalProfile(String(envId));
  return ml.stopProfile(envId, opts);
}

/** One profile's status. A local one: { status: 'running' | 'stopped', debugPort }. */
export async function profileStatus(envId, opts = {}) {
  if (isLocalProfileId(String(envId))) return local().localProfileStatus(String(envId));
  return ml.profileStatus(envId, opts);
}

// A local profile is Chrome: its browser is known at once, without a lookup.
export async function profileKernelOf(envId, opts = {}) {
  if (isLocalProfileId(String(envId))) return 'chromium';
  return ml.profileKernelOf(envId, opts);
}
export function heldProfileKernel(envId, now) {
  if (isLocalProfileId(String(envId))) return { known: true, kernel: 'chromium' };
  return ml.heldProfileKernel(envId, now);
}
export function lookupProfileKernel(envId, opts = {}) {
  if (isLocalProfileId(String(envId))) return Promise.resolve('chromium');
  return ml.lookupProfileKernel(envId, opts);
}
export async function profileKernels(envIds, opts = {}) {
  const ids = [...new Set((envIds || []).map(String))];
  const remoteIds = ids.filter((id) => !isLocalProfileId(id));
  const answer = remoteIds.length ? await ml.profileKernels(remoteIds, opts) : { kernels: {}, pending: 0 };
  const kernels = { ...(answer.kernels || {}) };
  for (const id of ids) if (isLocalProfileId(id)) kernels[id] = 'chromium';
  return { kernels, pending: Number(answer.pending) || 0 };
}

// MoreLogin refuses a new profile when the account's plan holds no more. Its exact words are not documented and vary
// by language, so the match is loose: an API or HTTP refusal of the create call whose text speaks of a limit.
const PLAN_LIMIT_RE = /\b(?:limit\w*|quota|maximum|upgrade|plan|package|exceed\w*)\b|上限|套餐|超出|限制|额度/i;
/** Whether a failed `createProfile` reads as MoreLogin's plan limit. */
export function isMoreLoginPlanLimit(err) {
  if (!err || (err.code !== 'MORELOGIN_API' && err.code !== 'MORELOGIN_HTTP')) return false;
  // The hint SynaBun itself adds to an auth refusal is not MoreLogin's text.
  const text = String(err.message || '').replace(/\(set the API ID and API Key[^)]*\)/g, '');
  return PLAN_LIMIT_RE.test(text);
}
