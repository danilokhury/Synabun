// The detached host pill follows the state signals painted by the window's own tray pills.

const WORKING = /-pill-running$/;
const NEEDS_YOU = /-pill-(attention|waiting)$/;

/** The states a detached window's pill shows: a session in it needs you > one works > none. */
export const SESSION_WINDOW_STATES = Object.freeze(['action', 'working', 'idle']);

/**
 * 'action' when a session in the window waits on you, 'working' when one works,
 * else 'idle'. Each pill supplies its classes and optional pill and badge statuses.
 */
export function sessionWindowStatus(pills) {
  let working = false;
  for (const pill of pills || []) {
    if (pill?.status === 'action' || pill?.badgeStatus === 'action') return 'action';
    if (pill?.status === 'working' || pill?.badgeStatus === 'working') working = true;
    for (const cls of (Array.isArray(pill) ? pill : pill?.classes) || []) {
      if (NEEDS_YOU.test(cls)) return 'action';
      if (WORKING.test(cls)) working = true;
    }
  }
  return working ? 'working' : 'idle';
}

/** A status a window reported, or 'idle' for anything else. */
export function normalizeSessionWindowStatus(status) {
  return SESSION_WINDOW_STATES.includes(status) ? status : 'idle';
}

/**
 * A dispatched worker's run (its descriptor) waits on your answer with no card
 * in its tab: its turn ended asking you something (the run's outcome is
 * needs_input while the warm worker rests between turns). Claude's and Codex's
 * tabs say "needs you" for it, as OpenCode's do (automationTurnPhase); a card
 * of their own (a permission, a question) says it already. A run that ended
 * waits on nobody.
 */
/**
 * A turn of a dispatched worker's run is in progress, so its tab works: the
 * run is alive (starting or running) and its turn state says neither idle (a
 * warm worker between turns: alive, not working) nor terminal. A classic loop
 * reports no turn state and works for as long as it runs. A run a restart
 * suspended, or one that ended, works no more: a tab that still shows a turn
 * ends it on this answer, whether or not the turn's own result event reached
 * the window (every provider panel's attach reads it).
 */
export function runTurnLive(run) {
  if (run?.status !== 'starting' && run?.status !== 'running') return false;
  return run.turnState !== 'idle' && run.turnState !== 'terminal';
}

export function runAwaitsAnswer(run) {
  if (run?.status !== 'starting' && run?.status !== 'running') return false;
  if (run.turnState === 'needs_input' || run.turnState === 'awaiting_permission' || run.pending?.some((p) => p.kind === 'question')) return true;
  return run.turnState === 'idle' && (run.outcome || run.lastResult?.status) === 'needs_input';
}
