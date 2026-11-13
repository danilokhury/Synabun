import { z } from 'zod/v3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as ni from '../services/neural-interface.js';
import { text } from './response.js';

// ═══════════════════════════════════════════
// morelogin — MoreLogin anti-detect browser MCP tool
// ═══════════════════════════════════════════

export const moreloginSchema = {
  action: z.enum(['status', 'list', 'create', 'start', 'stop', 'use', 'use_default']).describe(
    'MoreLogin action. "status" = installed/running, the default profile and the profile you work in. "list" = browser profiles (environments). "create" = new profile. "use" = work in a profile yourself: from now on YOUR browser_* tools (with or without session and tab ids) open and drive pages in that profile, in a tab of your own; nobody else moves, and it works while other automations use the default or any other profile. Pass envId or name; envId "default" goes back to the default profile. Your next browser call opens your tab there (the profile is started then) and your tab in the profile you left is closed. Only a profile the owner allowed agents to choose can be used ("list" and "status" say which; none is allowed until the owner switches one on): a refusal with MORELOGIN_PROFILE_NOT_ALLOWED means the profile is not on the owner\'s list, so tell the user to switch it on in SynaBun → Settings → Connected tools → MoreLogin → MoreLogin profiles → "Agents may choose" and stop; never use another profile or browser instead. The same list holds for "start": it is refused with MORELOGIN_PROFILE_NOT_ALLOWED for a profile that is not on it. "start"/"stop" = launch/close a profile without working in it (stop closes every tab in that browser: you may stop only a profile you started or have a tab in, and never while other automations have a tab in it). "use_default" is always refused: the default AI browser is the owner\'s choice (Settings → Browser); to work in another profile, call "use". "use" works for any session of SynaBun\'s MCP that proves its id: a run SynaBun started, a side panel, or a CLI window\'s own session of SynaBun\'s HTTP MCP. "start" is for a run SynaBun started; the owner does the rest in Settings → Browser.'
  ),
  envId: z.string().optional().describe(
    'Profile id (a MoreLogin environment id, or a local profile id that starts with "lp-"): required for start and stop; for "use" pass it or name ("default" = back to the default profile). Get ids from the "list" action.'
  ),
  name: z.string().optional().describe(
    'A profile name: the profile to work in ("use" action, as "list" shows it), or the name of a new profile ("create", default "SynaBun").'
  ),
};

export const moreloginDescription =
  'Manage MoreLogin (anti-detect, multi-account browser) profiles and pick the one you work in. Actions: "status" (is MoreLogin installed/running, the default profile, the profile you work in), "list" (profiles), "create" (new profile), "use" (work in a profile yourself: your browser_* tools drive it from then on, in your own tab, without changing the default or disturbing any other session; several sessions can work in different profiles at the same time), "start"/"stop" (launch/close a profile). "use" and "start" take only a profile the owner allowed agents to choose. "use_default" is always refused: the default AI browser is the owner\'s choice in Settings → Browser. To work in a profile other than the default, call "use" with its envId or name, then use the browser tools as usual: never tell the user you cannot control a second profile, and never change the default for that. You can choose only a profile the owner allowed agents to choose (the list is the owner\'s, in SynaBun\'s Settings; it is empty until the owner switches a profile on, and "list" / "status" show it). When "use" or "start" is refused because the profile is not on that list, nothing was opened, started or changed: tell the user which profile to switch on and where (SynaBun → Settings → Connected tools → MoreLogin → MoreLogin profiles → "Agents may choose"), and do not work in another profile or browser instead. Only Chrome-type profiles can be driven. Requires the MoreLogin desktop app to be running with its local API enabled. Profiles of two kinds are listed and used the same way, by the same ids: MoreLogin profiles, and local profiles (a Chrome SynaBun runs itself on this computer, with its own cookies, proxy, language and timezone; "list" marks them "local"; they work with MoreLogin closed or not installed). Both are on the same owner\'s list of profiles agents may choose. Local profiles are created, edited and deleted by the owner in Settings only; "create" makes a MoreLogin profile.';

interface MlEnv { id: string; name: string; status?: string; browser?: string | null; agentsMayChoose?: boolean; kind?: string }

/** Whether an id is a local profile's (neural-interface/lib/local-profiles.js: `lp-` and 12 hex characters). */
export function isLocalProfileId(id: unknown): boolean {
  return typeof id === 'string' && /^lp-[0-9a-f]{12}$/.test(id);
}
/** "local profile" for one of SynaBun's own profiles, "MoreLogin env" for every other id. */
const profileNoun = (id: unknown) => (isLocalProfileId(id) ? 'local profile' : 'MoreLogin env');
/** What "status" adds about SynaBun's local profiles (`localProfileCount`; a server from before them says nothing). */
function localProfilesNote(count: unknown): string {
  const n = Number(count);
  return Number.isFinite(n) && n > 0 ? ` SynaBun also has ${n} local profile(s) of its own, which need no MoreLogin ("list" shows them).` : '';
}

/** Where the owner edits the list of profiles agents may choose (neural-interface/lib/morelogin-agent-profiles.js). */
export const AGENT_PROFILES_WHERE = 'SynaBun → Settings → Connected tools → MoreLogin → MoreLogin profiles → "Agents may choose"';

/** The owner's list as one sentence for "status" and "list" (`agentProfiles` of the server's answer). */
export function agentProfilesLine(list: unknown): string {
  if (!Array.isArray(list)) return 'This SynaBun server does not say which profiles agents may choose (it was started before that list existed).';
  const rows = (list as Array<{ envId?: unknown; name?: unknown }>).filter(row => row && row.envId);
  if (!rows.length) return `Profiles agents may choose: none. The owner has allowed no profile, so "use", browser_session create with moreloginProfile and agent_dispatch morelogin_profile are refused for every profile; the default profile still works. The owner allows one in ${AGENT_PROFILES_WHERE}.`;
  return `Profiles agents may choose (the owner's list): ${rows.map(row => (typeof row.name === 'string' && row.name ? `${row.name} (id ${row.envId})` : `id ${row.envId}`)).join(', ')}. Any other profile is refused; the owner adds one in ${AGENT_PROFILES_WHERE}.`;
}

/** What "use_default" answers: agents never change the default AI browser (finding 1 of the re-review of 2026-11-11). */
export const USE_DEFAULT_REFUSAL = 'use_default refused: the default AI browser (the default MoreLogin profile) is the owner\'s choice, made in SynaBun → Settings → Browser, and no agent or session can change it, whatever the profile. Nothing was changed. To work in another MoreLogin profile yourself, call morelogin with action "use" and its envId or name: only your own browser tools move there. Tell the user: if every automation should use that profile by default, set it in Settings → Browser.';

export async function handleMoreLogin(args: { action: string; envId?: string; name?: string }) {
  switch (args.action) {
    case 'status': {
      const r = await ni.moreloginStatus();
      const mine = r.yourProfile as { envId?: string; name?: string | null; refused?: string } | undefined;
      const def = `${r.isDefault && r.defaultEnvId ? `default AI browser = env ${r.defaultEnvId}` : 'no MoreLogin default set'}${mine?.envId ? `; you work in ${mine.name ? `"${mine.name}" (env ${mine.envId})` : `env ${mine.envId}`} (your own choice or your run's profile, not the default)` : ''}.${mine?.refused ? ` Your browser calls are refused there: ${mine.refused}` : ''} ${agentProfilesLine(r.agentProfiles)}`.replace(/\.$/, '');
      // An API that answered with an error is running: say what it rejected, never "unreachable".
      const local = localProfilesNote(r.localProfileCount);
      if (r.running && r.apiError) return text(`MoreLogin running on port ${r.port}, API rejected: ${r.apiError}. ${r.profileCount || 0} profile(s). ${def}.${local}`);
      if (r.running) return text(`MoreLogin running on port ${r.port}. ${r.profileCount} profile(s). ${def}.${local}`);
      if (!r.installed && r.port == null && r.error) return text(`MoreLogin unreachable: ${r.error}`);
      // MoreLogin is closed or absent, and SynaBun's own local profiles work all the same: say both, with the list.
      if (local) return text(`${r.installed ? `MoreLogin is installed but its local API is not running on port ${r.port}` : 'MoreLogin is not installed'}.${local} ${def}.`);
      if (!r.installed) return text('MoreLogin is not installed (no app in a known folder and nothing answers on its port). Install it from https://www.morelogin.com, or set MORELOGIN_APP_PATH to a MoreLogin.exe in a custom folder.');
      return text(`MoreLogin is installed but its local API is not running on port ${r.port}. Open the MoreLogin app and enable Settings → API & MCP.${r.error ? ` (${r.error})` : ''}`);
    }
    case 'list': {
      const r = await ni.moreloginProfiles();
      if (r.error) return text(`MoreLogin list failed: ${r.error}`);
      const envs = (r.envs || []) as MlEnv[];
      if (!envs.length) return text('No MoreLogin profiles found. Create one with action "create" (or one is auto-created on first use).');
      // Each profile says whether the owner allowed agents to choose it, so nobody has to try to find out.
      const mark = (e: MlEnv) => (e.browser === 'firefox' ? 'Firefox-type, cannot be driven' : e.agentsMayChoose === true ? 'agents may choose it' : e.agentsMayChoose === false ? 'not allowed for agents' : null);
      // Local profiles (SynaBun's own Chrome on this computer) are listed with MoreLogin's and say their kind; the
      // same ids work for "use", "start" and "stop". With none, the list reads as it always did.
      const anyLocal = envs.some(e => e.kind === 'local');
      const kind = (e: MlEnv) => (anyLocal ? ` — ${e.kind === 'local' ? 'local' : 'MoreLogin'}` : '');
      const missing = typeof r.moreloginError === 'string' && r.moreloginError ? `\nMoreLogin's own profiles are not listed: ${r.moreloginError}` : '';
      return text(`${anyLocal ? 'Profiles (MoreLogin and local)' : 'MoreLogin profiles'}:\n` + envs.map(e => `  • ${e.name} (id ${e.id})${kind(e)}${e.status ? ` — ${e.status}` : ''}${mark(e) ? ` — ${mark(e)}` : ''}`).join('\n') + `${missing}\n${agentProfilesLine(r.agentProfiles)}`);
    }
    case 'create': {
      const r = await ni.moreloginCreate(args.name);
      // MoreLogin's plan holds no more profiles: a local profile needs no slot, and only the owner creates one.
      if (r.error) return text(`Create failed: ${r.error}${r.code === 'MORELOGIN_PLAN_LIMIT' ? '\nNothing was created. A local profile is created by the owner in SynaBun → Settings → Connected tools → MoreLogin, never by an agent: tell the user, and stop there.' : ''}`);
      const ids = (r.ids || []) as string[];
      return text(`Created MoreLogin profile${ids.length ? ` (id ${ids.join(', ')})` : ''}.`);
    }
    case 'start': {
      if (!args.envId) return text('envId is required for the "start" action. Use "list" to get ids.');
      const r = await ni.moreloginStart(args.envId);
      // A profile off the owner's list is not started for an agent (server: POST /api/morelogin/start, B1 of the 2026-11-10 re-review).
      if (r.error) return text(`Start failed: ${r.error}${r.code === 'MORELOGIN_PROFILE_NOT_ALLOWED' ? '\nNothing was started. Tell the user what to switch on, and stop there.' : ''}`);
      // The owner's page gets the profile's debugging port; an automation does not (a raw CDP connection would drive
      // the profile past every check SynaBun makes), and needs none: the browser tools drive the profile it works in.
      return text(`Started ${profileNoun(args.envId)} ${args.envId}${r.debugPort ? ` (debug port ${r.debugPort})` : ''}. Starting a profile does not move your browser tools there: to work in it, call morelogin with action "use" and this envId.`);
    }
    case 'stop': {
      if (!args.envId) return text('envId is required for the "stop" action.');
      const r = await ni.moreloginStop(args.envId);
      if (r.error) return text(`Stop failed: ${r.error}`);
      return text(`Stopped ${profileNoun(args.envId)} ${args.envId}.`);
    }
    case 'use': {
      const toDefault = (args.envId || '').trim().toLowerCase() === 'default' || (!args.envId && (args.name || '').trim().toLowerCase() === 'default');
      if (!toDefault && !args.envId && !args.name) return text('The "use" action needs envId or name (the "list" action gives both), or envId "default" to go back to the default profile.');
      const r = await ni.useSessionProfile(toDefault ? { default: true } : { ...(args.envId ? { envId: args.envId } : {}), ...(args.name ? { name: args.name } : {}) });
      if (r.error) return text(`use failed: ${r.error}\nNothing changed: you still work where you did. Never fall back to another profile or browser by yourself.${r.code === 'MORELOGIN_PROFILE_NOT_ALLOWED' ? ' Tell the user what to switch on, and stop there.' : ''}`);
      return text(useAnswer(r));
    }
    case 'use_default': {
      // Finding 1 of the re-review of 2026-11-11: the default AI browser is the owner's choice alone, for every caller
      // and every profile. The tool answers without asking the server, which refuses it too (403
      // MORELOGIN_DEFAULT_OWNER_ONLY in POST /api/morelogin/use-default) for anything that is not the owner's page.
      return text(USE_DEFAULT_REFUSAL);
    }
    default:
      return text(`Unknown action: ${args.action}`);
  }
}

/** What "use" answers: where the caller works now, what was closed, and what its next browser call does. */
export function useAnswer(r: Record<string, unknown>): string {
  const label = (envId: unknown, name: unknown) => (isLocalProfileId(envId)
    ? (typeof name === 'string' && name ? `local profile "${name}" (id ${envId})` : `local profile ${envId}`)
    : (typeof name === 'string' && name ? `MoreLogin profile "${name}" (env ${envId})` : `MoreLogin profile env ${envId}`));
  const now = r.default === true ? 'the default browser profile (Settings → Browser)' : label(r.envId, r.name);
  if (r.changed !== true) return `You already work in ${now}. Nothing changed.`;
  const released = Array.isArray(r.released) ? r.released as Array<{ sessionId?: string; tabId?: string | null }> : [];
  const closed = released.filter(x => x && x.tabId).map(x => `tab ${x.tabId} of session ${x.sessionId}`);
  const lines = [`You now work in ${now}. Only your own browser tools moved: the default AI browser and every other session are unchanged.`];
  if (closed.length) lines.push(`Your ${closed.join(', ')} in the profile you left ${closed.length === 1 ? 'was' : 'were'} released: do not pass those ids again.`);
  lines.push('Your next browser call (browser_navigate with a URL, without ids) opens a tab of your own there; the profile is started then if it is not running, which can take a minute or two. If it cannot start, that call fails and names the profile: report it, never switch to another profile or browser by yourself.');
  return lines.join('\n');
}

/**
 * Register the MoreLogin MCP tool on the given server instance.
 * Single tool with action-based dispatch: status, list, create, start, stop, use, use_default (always refused).
 */
export function registerMoreLoginTools(server: McpServer) {
  return [
    server.tool('morelogin', moreloginDescription, moreloginSchema, handleMoreLogin),
  ];
}
