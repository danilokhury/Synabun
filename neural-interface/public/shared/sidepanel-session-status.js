// What a detached session window (ui-sidepanel-sessions.js) is doing, for the
// pill the main window shows for it. It is read from the window's own tray
// pills, the ones its provider panel paints from its sessions' state: Claude
// (tabWorking: a turn or background agents and shells; tabNeedsYou: a
// permission or a question waiting), Codex (a turn or a thread being made; an
// approval or a question card waiting), OpenCode (tabPillState: a turn, an
// automation's turn, a sub-agent's, one waiting on you) and the SynaBun
// Assistant (sessionStatus). The same source as the tray pills, never a second
// guess. DOM-free.

const WORKING = /^(cp|cxp|ocpv2|asp)-pill-running$/;
const NEEDS_YOU = /^((cp|cxp|asp)-pill-attention|ocpv2-pill-waiting)$/;

/** The states a detached window's pill shows: a session in it needs you > one works > none. */
export const SESSION_WINDOW_STATES = Object.freeze(['action', 'working', 'idle']);

/**
 * 'action' when a session in the window waits on you, 'working' when one works,
 * else 'idle'. `pills`: the class names of each tray pill of the window.
 */
export function sessionWindowStatus(pills) {
  let working = false;
  for (const classes of pills || []) {
    for (const cls of classes || []) {
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
export function runAwaitsAnswer(run) {
  if (run?.status !== 'starting' && run?.status !== 'running') return false;
  if (run.turnState === 'needs_input') return true;
  return run.turnState === 'idle' && (run.outcome || run.lastResult?.status) === 'needs_input';
}
