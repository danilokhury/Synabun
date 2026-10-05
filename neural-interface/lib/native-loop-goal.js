/**
 * Surface loop-goal for native loops: after an iteration, is the loop's task
 * already done, so the rest of the budget can be skipped?
 *
 * The first version judged only the journal the `loop update` tool keeps.
 * Nothing asks a native loop to write one, so the question was almost never
 * asked (one call in four days, 467 runs ending on the iteration cap and none
 * on the goal). The iteration's own final reply is the evidence now; the
 * journal and progress summary join it when they exist. Never asked after the
 * final iteration: there is nothing left for "stop early" to save.
 *
 * Returns { met, probability } or null (keep going, as before).
 */
export function createLoopGoalJudge({ judgeLoopGoal, surfaceConfig }) {
  return async (state, result, { iteration, total, runId } = {}) => {
    if (!state?.task) return null;
    let settings;
    try { settings = surfaceConfig('loop-goal'); } catch { return null; }
    if (!settings?.enabled) return null;
    if (Number(total) > 0 && Number(iteration) >= Number(total)) return null;
    const journal = Array.isArray(state.journal) ? state.journal.slice(-5) : [];
    const reply = typeof result?.text === 'string' ? result.text.trim() : '';
    const lastMessage = reply || String(journal.at(-1)?.summary || state.progressSummary || '').trim();
    if (!lastMessage) return null;
    const probability = await judgeLoopGoal({
      task: String(state.task), context: state.context ? String(state.context) : null, journal,
      progressSummary: state.progressSummary ? String(state.progressSummary) : null,
      lastMessage, iteration, total,
    }, { origin: 'loop', sessionId: runId ?? null, project: typeof state.project === 'string' && state.project ? state.project : null });
    if (probability === null) return null;
    return { met: probability >= (settings.minConfidence ?? 0.8), probability };
  };
}
