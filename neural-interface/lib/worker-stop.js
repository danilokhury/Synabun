// Who asked a run to stop, and whether that request may end a run a server restart suspended.
// The request guards identify the caller. The page may describe its control, but neither its JSON nor a legacy reason
// string identifies a person: `reason: 'user'` is recorded only for a control a person operates (personAskedToStop).

const PERSON_PAGE_ACTIONS = new Set(['stop', 'tab_close']);

export function pageStopProvenance(action, verified) {
  return {
    actor: verified ? 'page' : 'unknown',
    action: ['stop', 'tab_close', 'tray_auto_close'].includes(action) ? action : 'unknown',
  };
}

export function assistantStopProvenance(caller, action) {
  if (caller.credentialed) {
    return { actor: 'assistant', action: 'agent_stop', assistantSessionId: caller.assistantSessionId };
  }
  return pageStopProvenance(action, caller.verifiedPage);
}

// What SynaBun itself ends a run for. A reason that is not here names no caller: it is recorded as unknown.
const SYSTEM_STOPS = Object.freeze({
  server_restart: ['server', 'shutdown'],
  server_shutdown: ['server', 'shutdown'],
  resume_failed: ['server', 'resume_failed'],
  state_removed: ['server', 'state_file'],
  state_inactive: ['server', 'state_file'],
  time_cap: ['limit', 'time_cap'],
  max_turns: ['limit', 'max_turns'],
  idle_timeout: ['limit', 'idle_timeout'],
  budget_cap: ['budget', 'budget_cap'],
  session_budget_cap: ['budget', 'session_budget_cap'],
  budget_share: ['budget', 'budget_share'],
  budget_unpriced: ['budget', 'budget_unpriced'],
  assistant: ['assistant', 'stop'],
  complete: ['assistant', 'agent_complete'],
  remote_policy: ['policy', 'remote_policy'],
  desktop_stop: ['desktop', 'stop_control'],
  team_replaced: ['team', 'replace'],
  team_discarded: ['team', 'discard'],
  cancelled: ['system', 'cancelled'],
  whatsapp_service: ['whatsapp_service', 'stop'],
});

/** The actor and action of a stop SynaBun made for `reason`, or null when the reason names no caller. */
export function systemStopProvenance(reason) {
  const known = Object.hasOwn(SYSTEM_STOPS, String(reason)) ? SYSTEM_STOPS[reason] : null;
  return known ? { actor: known[0], action: known[1] } : null;
}

/** What is recorded for a stop: the proven caller, else what `reason` says, else unknown; always with its time. */
export function stampStopProvenance(reason, provenance, at) {
  const base = provenance || systemStopProvenance(reason) || { actor: 'unknown', action: String(reason || 'unknown').slice(0, 64) };
  return { ...base, at: base.at || at };
}

/** A person operated the control: the owner's page (Stop, a tab's X) or the owner's phone. */
export function personAskedToStop(provenance) {
  if (provenance?.actor === 'whatsapp_user') return provenance.action === 'stop';
  return provenance?.actor === 'page' && PERSON_PAGE_ACTIONS.has(provenance.action);
}

/** The reason a stop through a page or by a run itself is recorded under. */
export function callerStopReason(provenance) {
  if (personAskedToStop(provenance)) return 'user';
  if (provenance?.actor === 'automation' && provenance.action === 'self_stop') return 'self_stop';
  if (provenance?.action === 'tray_auto_close') return 'tray_auto_close';
  return 'unknown';
}

/**
 * Whether this request may end a run suspended for a server restart. That run has no process, so it cannot stop
 * itself: an exit hook of its old CLI, an unidentified caller, a page that names no control, the tray's timer and the
 * shutdown itself never end it. A person, the Assistant and a limit or policy of SynaBun's do.
 */
export function mayEndSuspendedRun(provenance) {
  if (!provenance) return false;
  if (['unknown', 'automation', 'server'].includes(provenance.actor)) return false;
  if (provenance.actor === 'page') return PERSON_PAGE_ACTIONS.has(provenance.action);
  return true;
}

/** The reason a run ended by a server shutdown is recorded under, whatever the shutdown was called. */
export function shutdownStopReason(reason) {
  return reason === 'restart' || reason === 'server_restart' ? 'server_restart' : 'server_shutdown';
}
