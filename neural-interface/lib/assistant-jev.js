/**
 * Jev in the SynaBun Assistant: the prompt-urgency judgment of the per-turn
 * recall gate, and the worker-outcome / worker-claim judgments of dispatched
 * runs (docs/judgments.md). Everything is injected by server.js, which imports
 * it from mcp-server/dist in its own try/catch: a stale dist leaves the
 * Assistant working without Jev (this wrapper is then simply not created).
 *
 * The wrapper owns the gates judge() does not: the master switch / key /
 * kill switch (`enabled`), a 429's retry-after, and each rider's own surface
 * switch (judge() only checks the lead surface). Thresholds are read on every
 * call, so the Judgments tab changes them without a restart. Nothing here
 * throws: a method resolves to null when no judgment was asked, and every
 * caller keeps its pre-Jev behaviour for that case.
 */

const num = (value, fallback) => (value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback);

export function createAssistantJev({
  judgePrompt = null,
  judgeWorkerOutcome = null,
  surfaceConfig = () => null,
  enabled = () => true,
  retryAfterMs = () => 0,
  annotate = () => {},
} = {}) {
  const settingsOf = (name) => { try { return surfaceConfig(name) || null; } catch { return null; } };
  function waitMs() { try { return Math.max(0, num(retryAfterMs(), 0)); } catch { return 0; } }
  /** Master switch, key and kill switch on, and no retry-after pending. */
  function available() {
    try { if (!enabled()) return false; } catch { return false; }
    return waitMs() === 0;
  }

  /**
   * How much searching memory would change the reply (surface prompt-urgency),
   * the same state and question as the prompt hook, origin 'assistant'.
   * → null (not asked) | { urgency: 'must'|'should'|'consider'|'skip'|null, confidence, logId }
   */
  async function promptUrgency({ prompt, project = null, sessionId = null, timeoutMs = null } = {}) {
    const text = typeof prompt === 'string' ? prompt : '';
    if (typeof judgePrompt !== 'function' || !text.trim() || !available()) return null;
    const settings = settingsOf('prompt-urgency');
    if (!settings?.enabled) return null;
    // The caller's own budget (memory.recallBudgetMs) bounds it when given, not the
    // surface timeout: that one is tuned for the prompt hook's 3 s budget, while here
    // urgency runs beside retrieval + rerank, and live calls sit at ~1.0–1.1 s.
    const surfaceTimeout = num(settings.timeoutMs, 1200);
    const timeout = Math.max(1, Math.floor(num(timeoutMs, surfaceTimeout)));
    let logId = null;
    try {
      const verdict = await judgePrompt(text, project || undefined, {
        origin: 'assistant', sessionId: sessionId || null, project: project || null, timeoutMs: timeout,
        onLogged: (id) => { logId = id ?? null; },
      });
      if (verdict && typeof verdict.urgency === 'string') return { urgency: verdict.urgency, confidence: num(verdict.confidence, 0), logId };
    } catch { /* judge() never throws; a wrapper bug must not break recall either */ }
    return { urgency: null, confidence: 0, logId };
  }

  /**
   * One request about a worker's turn or failed run (lead worker-outcome, rider
   * worker-claim). Only the questions whose surfaces are on are asked.
   * → null (nothing asked) | { asked, logId, status, statusConfidence, cause,
   *   causeConfidence, claimProbability, claimFlagged, verdict }
   * `status` / `cause` are set only at confidence ≥ worker-outcome.minConfidence
   * (`unclear` never); `claimFlagged` at P ≥ worker-claim.minProbability.
   */
  async function workerOutcome(input = {}, ask = {}, { runId = null, assistantSessionId = null, project = null } = {}) {
    if (typeof judgeWorkerOutcome !== 'function' || !available()) return null;
    const lead = settingsOf('worker-outcome');
    const rider = settingsOf('worker-claim');
    const want = {
      status: ask.status === true && !!lead?.enabled,
      cause: ask.cause === true && !!lead?.enabled,
      claim: ask.claim === true && !!rider?.enabled,
    };
    if (!want.status && !want.cause && !want.claim) return null;
    let logId = null;
    let verdict = null;
    try {
      verdict = await judgeWorkerOutcome(input, want, {
        origin: 'assistant', sessionId: assistantSessionId || runId || null, entityId: runId || undefined,
        project: project && project !== 'global' ? project : null, onLogged: (id) => { logId = id ?? null; },
      });
    } catch { verdict = null; }
    const minConfidence = num(lead?.minConfidence, 0.7);
    const minProbability = num(rider?.minProbability, 0.9);
    const out = {
      asked: want, logId, status: null, statusConfidence: null, cause: null, causeConfidence: null,
      claimProbability: null, claimFlagged: false, verdict: verdict || null,
    };
    if (!verdict || typeof verdict !== 'object') return out;
    const statusConfidence = num(verdict.statusConfidence, 0);
    if (want.status && typeof verdict.status === 'string' && verdict.status !== 'unclear' && statusConfidence >= minConfidence) {
      out.status = verdict.status;
      out.statusConfidence = statusConfidence;
    }
    const causeConfidence = num(verdict.causeConfidence, 0);
    if (want.cause && typeof verdict.cause === 'string' && causeConfidence >= minConfidence) {
      out.cause = verdict.cause;
      out.causeConfidence = causeConfidence;
    }
    if (want.claim && num(verdict.claimProbability, null) !== null) {
      out.claimProbability = Number(verdict.claimProbability);
      out.claimFlagged = out.claimProbability >= minProbability;
    }
    return out;
  }

  /** Record what the caller did with a judgment on its log row. Never throws. */
  function annotateLog(logId, outcome) {
    if (!logId) return;
    try { annotate(logId, outcome); } catch { /* diagnostics */ }
  }

  return { available, retryAfterMs: waitMs, promptUrgency, workerOutcome, annotate: annotateLog };
}
