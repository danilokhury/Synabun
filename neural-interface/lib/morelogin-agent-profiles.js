// ── The owner's list of MoreLogin profiles agents may choose (DOM-free, no imports) ──
//
// A MoreLogin profile is a separate logged-in account. Which account an automation acts in is the owner's choice
// (security review 972afb74 of 2026-11-05, finding 1). The per-session profile work of 2026-11-10 let a session pick a
// profile for itself (`morelogin` "use", browser_session create's moreloginProfile, agent_dispatch morelogin_profile)
// and let the launch routes take one from any caller; a review the same day (run b6631e9d) found that this handed
// every profile, and so every account, to any local process. The owner's decision: an allowlist, empty by default.
//
// What it means:
//   • It is the owner's list of the profiles an agent may put itself, or be put by another agent, into. With nothing
//     on it, no session, dispatch or agent-made launch can select a profile at all.
//   • The owner at SynaBun's page (this boot's page secret, never a guest: server.js browserOwnerPageOnly) is not
//     limited by it: a schedule, a group, a timer or a launch the owner sets up there may use any Chrome-type profile.
//   • The Browser-settings default profile is not part of it.
//   • It is checked where a profile is chosen AND where a pin is used (pinUseRefusal), so taking a profile off the
//     list stops the sessions already pinned to it at their next browser call. They are refused; they never fall back
//     to the default profile or to Chrome.
//
// Where it is kept: the `moreloginAgentProfiles` key of the owner's browser settings (DATA_HOME/data/
// browser-config.json), written only by PUT /api/morelogin/agent-profiles, a route of the owner's page alone
// (server.js moreLoginGate: not in MORELOGIN_AUTOMATION_ROUTES). PUT /api/browser/config keeps the saved list whatever
// its body says, so the Settings form cannot drop it and no other writer exists.
//
// Who chose a profile travels with the choice (`by`): 'owner' only where the server itself saw the owner's page make
// it; anything else, a record from before this rule included, is 'agent' and needs the list. scheduleProfileAuthority
// says which of the two a schedule's run is.

/** The key of the owner's browser settings that holds the list. */
export const AGENT_PROFILES_KEY = 'moreloginAgentProfiles';
/** Entries kept at most (MoreLogin accounts hold far fewer profiles). */
export const AGENT_PROFILES_MAX = 500;
/** The refusal's code, everywhere a profile off the list is chosen or used. */
export const PROFILE_NOT_ALLOWED = 'MORELOGIN_PROFILE_NOT_ALLOWED';
/** Where the owner edits the list, as the refusals and the tools name it. */
export const AGENT_PROFILES_WHERE = 'SynaBun → Settings → Connected tools → MoreLogin → MoreLogin profiles → "Agents may choose"';

const cleanId = (value) => {
  const id = value === null || value === undefined ? '' : String(value).trim();
  return id && id.length <= 128 && !/[\u0000-\u001f]/.test(id) ? id : '';
};
const cleanName = (value) => (typeof value === 'string' ? value.trim().slice(0, 200) : '');

/**
 * The list as it is kept: [{ envId, name }], one entry per profile id, in the order given. Anything that is not a
 * list, or an entry without a usable id, is nothing: an unreadable list allows no profile.
 * @param {unknown} value the saved value, or a browser config that holds it
 */
export function normalizeAgentProfiles(value) {
  const rows = Array.isArray(value) ? value : (value && typeof value === 'object' && Array.isArray(value[AGENT_PROFILES_KEY]) ? value[AGENT_PROFILES_KEY] : []);
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const envId = cleanId(row && typeof row === 'object' ? row.envId : row);
    if (!envId || seen.has(envId)) continue;
    seen.add(envId);
    out.push({ envId, name: (row && typeof row === 'object' ? cleanName(row.name) : '') || null });
    if (out.length >= AGENT_PROFILES_MAX) break;
  }
  return out;
}

/** Whether `envId` is on the list (`source`: the list, or a browser config that holds it). By id only, never by name. */
export function agentProfileAllowed(source, envId) {
  const id = cleanId(envId);
  return !!id && normalizeAgentProfiles(source).some((row) => row.envId === id);
}

/** The list with `envId` put on it (`allowed` true) or taken off it. The name is kept for display only. */
export function withAgentProfile(source, envId, name, allowed) {
  const id = cleanId(envId);
  const rows = normalizeAgentProfiles(source).filter((row) => row.envId !== id);
  if (id && allowed === true) rows.push({ envId: id, name: cleanName(name) || null });
  return rows.slice(0, AGENT_PROFILES_MAX);
}

// The id of a local profile (a Chrome SynaBun runs itself, lib/local-profiles.js LOCAL_PROFILE_ID_RE; this module has
// no imports). The list, the pins and the refusals hold both kinds of profile by id; only the words differ.
const LOCAL_PROFILE_REF_RE = /^lp-[0-9a-f]{12}$/;
/** 'local profile' for one of SynaBun's own profiles, 'MoreLogin profile' for every other id. */
export function profileKindLabel(envId) {
  return LOCAL_PROFILE_REF_RE.test(cleanId(envId)) ? 'local profile' : 'MoreLogin profile';
}
/** A profile as the refusals and the log lines name it: `MoreLogin profile "P-4" (id)`, `local profile "Shop" (id)`. */
export function describeProfile(envId, name = null) {
  const kind = profileKindLabel(envId);
  return cleanName(name) ? `${kind} "${cleanName(name)}" (${cleanId(envId)})` : `${kind} ${cleanId(envId)}`;
}
const describe = describeProfile;

/** What a refused agent is told, and what it tells the user. */
export function profileNotAllowedText(envId, name = null) {
  return `${describe(envId, name)} is not on the owner's list of profiles agents may choose, so nothing was opened: not that profile, not the default one, not Chrome. Tell the user: to let agents work in it, switch it on in ${AGENT_PROFILES_WHERE}. A schedule, group, timer or launch the user sets up in SynaBun's own page can use any profile without that. Never switch to another profile or browser by yourself.`;
}

/** The refusal as an Error (status 403, code MORELOGIN_PROFILE_NOT_ALLOWED) for the routes' catch blocks. */
export function profileNotAllowedError(envId, name = null, extra = '') {
  return Object.assign(new Error(`${profileNotAllowedText(envId, name)}${extra ? ` ${extra}` : ''}`), { status: 403, code: PROFILE_NOT_ALLOWED, envId: cleanId(envId) });
}

/**
 * Why a pin may not be used now, or null. A pin the owner's page set (`by: 'owner'`) is never limited; every other
 * pin (a session's own choice, a dispatch's, an agent-made launch's, one whose origin is not recorded) needs its
 * profile on the list at every use, not only when it was set.
 * @param {{ envId: string, name?: string|null, by?: string }|null} pin
 * @param {unknown} source the list, or a browser config that holds it
 * @returns {{ status: 403, code: string, error: string, envId: string }|null}
 */
export function pinUseRefusal(pin, source) {
  if (!pin || !pin.envId || pin.by === 'owner') return null;
  if (agentProfileAllowed(source, pin.envId)) return null;
  return {
    status: 403, code: PROFILE_NOT_ALLOWED, envId: String(pin.envId),
    error: `${profileNotAllowedText(pin.envId, pin.name)} This session is set to that profile (the owner took it off the list, or never put it there): its browser calls are refused until the profile is allowed again, or until the session goes back to the default profile itself (morelogin with action "use" and envId "default").`,
  };
}

/**
 * Whether a schedule's run in the profile of `holder` (the schedule itself, or its group) is the owner's own choice.
 * It is only when the server saw the owner's page choose that profile (`holder.moreloginEnvBy === 'owner'`) AND nothing
 * an agent wrote since decides what runs there: the schedule's task-defining fields (`schedule.taskBy`: its template,
 * its overrides, its day themes, the group it is in) and its template (`template.editedBy`). Otherwise an agent could
 * ride the owner's record into a profile off the list: change its task, or put a schedule of its own into the owner's
 * group. A record with no marker (one saved before this rule) is not proven the owner's.
 * @returns {{ by: 'owner' } | { by: 'agent', why: string, cure: string }}
 */
export function scheduleProfileAuthority({ schedule = null, holder = null, template = null, source = 'schedule' } = {}) {
  const page = 'SynaBun\'s page (Automation Studio)';
  if (!holder || holder.moreloginEnvBy !== 'owner') {
    return {
      by: 'agent',
      why: holder?.moreloginEnvBy === 'agent'
        ? `the ${source}'s profile was chosen by an agent, not by the owner in ${page}`
        : `SynaBun has no record that the owner chose the ${source}'s profile in ${page} (it was saved before that was recorded, or by an agent)`,
      cure: `or open the ${source} in ${page}, pick the profile again and save`,
    };
  }
  if (schedule && schedule.taskBy === 'agent') {
    return { by: 'agent', why: 'an agent created this schedule or last changed what it runs (its template, overrides, day themes or group)', cure: `or open the schedule in ${page}, check what it runs, pick the profile again and save` };
  }
  if (template && template.editedBy === 'agent') {
    return { by: 'agent', why: 'an agent created or last changed the template this schedule runs', cure: `or open that template in ${page}, check its task and save it` };
  }
  return { by: 'owner' };
}

/** The message of a schedule run refused for a profile off the list (scheduleProfileAuthority said 'agent'). */
export function scheduleProfileRefusalText(envId, name, authority) {
  return `${describe(envId, name)} is not on the owner's list of profiles agents may choose, and ${authority?.why || 'this run is not the owner\'s own choice'}. The run was not started: not in that profile, not in the default one, not in Chrome. To run it, switch the profile on in ${AGENT_PROFILES_WHERE}, ${authority?.cure || 'or save it again in SynaBun\'s page'}.`;
}
