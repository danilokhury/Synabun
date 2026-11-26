// ═══════════════════════════════════════════
// SynaBun Assistant — steer: redirect work that is under way
// ═══════════════════════════════════════════
// A steer cuts the current turn and sends new words at once, instead of
// queueing them behind it. Two targets:
//   - the Assistant's own turn (direct work in this panel): POST
//     /api/assistant/steer without a runId; the server interrupts the brain's
//     turn and sends the text as the next user message;
//   - one dispatched worker run: the same route with its runId; the server
//     interrupts that worker's turn (its session stays warm) and follows up.
// Server contract (lib/, the other slice): → { ok, target: { kind: 'run' |
// 'brain', runId? }, interruptedTurn }; 400 empty text, 404 unknown run or
// session, 409 { code: 'RUN_NOT_ACTIVE' }. A worker emits a run event of type
// 'steered' { runId, text, at, interruptedTurn }; the interrupted turn ends
// with reason 'steered' (never a failure, never a completion). The brain's
// stream carries a 'steered' notice { target: 'brain', text, at }.
//
// No DOM: `node --test` loads this file as it is
// (tests/assistant-steer-panel.test.mjs). The panel loads it on demand
// (asst-panel.js steerModule: in idle time after the page is shown or at the
// first steer); what the panel draws with from the first frame (STEER_COPY,
// steerTranslator, the composer's keys, the chip, the steering mark) is in
// asst-state.js, re-exported here.

import { STEER_CLEARED, STEER_COPY, STEER_MARK_MAX_MS, canSteerRun, composerKeyIntent, isRunOutputEvent, isSteeredEnd, isSteering, settleSteering, steerNoticeText, steerTokensOf, steerTranslator, targetChipText } from './asst-state.js';

export { STEER_CLEARED, STEER_COPY, STEER_MARK_MAX_MS, canSteerRun, composerKeyIntent, isRunOutputEvent, isSteeredEnd, isSteering, settleSteering, steerNoticeText, steerTokensOf, steerTranslator, targetChipText };

/** The body of POST /api/assistant/steer; null when there is nothing to send. */
export function steerRequestBody({ sessionId, text, runId = null } = {}) {
  const words = String(text ?? '').trim();
  if (!sessionId || !words) return null;
  const body = { assistantSessionId: String(sessionId), text: words };
  if (runId) body.runId = String(runId);
  return body;
}

/**
 * POST the steer. Never throws: → { ok: true, target, interruptedTurn } or { ok: false, status, code, error }.
 * `code` is the server's (RUN_NOT_ACTIVE…), or 'UNAVAILABLE' for a server that has no such route yet (404 without a
 * JSON code, or 405), or 'NETWORK'.
 */
export async function postSteer(body, { fetchImpl = (typeof fetch === 'function' ? fetch : null) } = {}) {
  if (!body) return { ok: false, status: 400, code: 'EMPTY', error: 'empty text' };
  if (typeof fetchImpl !== 'function') return { ok: false, status: 0, code: 'NETWORK', error: 'no fetch' };
  let res;
  try {
    res = await fetchImpl('/api/assistant/steer', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-SynaBun-UI': '1' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { ok: false, status: 0, code: 'NETWORK', error: error?.message || String(error) };
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (res.ok && data && data.ok !== false) {
    return { ok: true, target: data.target || { kind: body.runId ? 'run' : 'brain', runId: body.runId || undefined }, interruptedTurn: data.interruptedTurn === true };
  }
  const code = data?.code || data?.reason || ((res.status === 404 && !data) || res.status === 405 ? 'UNAVAILABLE' : null);
  return { ok: false, status: res.status, code, error: data?.error || data?.message || `HTTP ${res.status}` };
}

/**
 * What the panel does with a failed steer: { kind, message, offerBrain }.
 * kind: 'ended' (409 RUN_NOT_ACTIVE: offer the Assistant), 'unavailable' (an older server: queue), 'empty', 'error'.
 */
export function steerFailureView(result, t = steerTranslator()) {
  const code = String(result?.code || '');
  if (code === 'RUN_NOT_ACTIVE' || (result?.status === 409 && !code)) return { kind: 'ended', message: t('runEnded'), offerBrain: true, offerLabel: t('sendToAssistant') };
  if (code === 'UNAVAILABLE') return { kind: 'unavailable', message: t('unavailable'), offerBrain: false };
  if (code === 'EMPTY' || result?.status === 400) return { kind: 'empty', message: t('emptyText'), offerBrain: false };
  return { kind: 'error', message: t('failed', { error: result?.error || code || '?' }), offerBrain: false };
}


/**
 * A 'steered' notice or run event out of any packet that may carry one, normalized to
 * { target: 'brain' | 'run', runId, text, at, interruptedTurn }, or null.
 * Shapes: { type: 'steered', … } (a stream event, a run event), { type: 'synabun.steered', … },
 * { event: { type: 'steered', … } } and { event: 'steered', … } (a dispatch packet naming its event).
 */
export function steeredEventOf(packet) {
  if (!packet || typeof packet !== 'object') return null;
  let ev = null;
  if (packet.type === 'steered' || packet.type === 'synabun.steered') ev = packet;
  else if (packet.event && typeof packet.event === 'object' && (packet.event.type === 'steered' || packet.event.type === 'synabun.steered')) ev = { ...packet, ...packet.event };
  else if (packet.event === 'steered' || packet.kind === 'steered' || packet.reason === 'steered') ev = packet; // the dispatcher: assistant:dispatch { reason: 'steered', run, text, at }
  if (!ev) return null;
  const runId = ev.runId || ev.run?.runId || packet.runId || packet.run?.runId || null;
  const target = ev.target === 'brain' || (!runId && ev.target !== 'run') ? 'brain' : 'run';
  const at = Number.isFinite(Date.parse(ev.at)) ? new Date(ev.at).toISOString() : (Number.isFinite(Number(ev.at)) && Number(ev.at) > 0 ? new Date(Number(ev.at)).toISOString() : null);
  return { target, runId: target === 'run' ? runId : null, text: String(ev.text ?? ''), at, interruptedTurn: ev.interruptedTurn === true };
}

/** The patch that marks a run steered now (the panel's own mark until the steer's turn shows output: settleSteering). */
export function steeringPatch(run, { text = '', at = Date.now() } = {}) {
  return {
    steering: true,
    steeredAt: new Date(at).toISOString(),
    steerText: String(text || ''),
    steerIteration: Number.isFinite(Number(run?.currentIteration)) ? Number(run.currentIteration) : null,
    steerTokens: steerTokensOf(run),
    steerTurnStarted: false,
  };
}

/**
 * The panel's steer logic, with every page part injected (asst-panel.js wires it; the tests pass stand-ins):
 * deps: { sessionId() → id, isRunning() → bool, steerable() → bool, setSteerable(bool),
 *         post(body) → postSteer result, queue(payload) → 'queued', send(payload) → 'sent' | false,
 *         promptText(payload) → string, getRun(runId), runLabel(run) → "#2 title",
 *         patchRun(runId, patch), setActivity(runId, activity | null),
 *         notice(text, { kind: 'steer' | 'warn' | 'error', action?: { label, run() } }) → row,
 *         setTarget(target | null, text?), focusComposer(), t, now() }
 * Returns { submit(payload), steerRun(runId, text), targetRun(runId, text), onSteered(packet), onTurnStarted(runId) }.
 */
export function createSteerController(deps = {}) {
  const t = deps.t || steerTranslator();
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  // Notices this panel drew itself: the server's 'steered' echo of the same steer draws nothing more.
  const drawn = [];
  const remember = (key) => { drawn.push({ key, at: now() }); while (drawn.length > 20) drawn.shift(); };
  const seen = (key) => drawn.some((d) => d.key === key && now() - d.at < 120_000);
  // The server keeps at most 500 characters of a steer's text in its event.
  const keyOf = (runId, text) => JSON.stringify([runId || 'brain', String(text || '').replace(/\s+/g, ' ').trim().slice(0, 480)]);

  const setTimer = typeof deps.setTimer === 'function' ? deps.setTimer : (fn, ms) => { const id = setTimeout(fn, ms); id?.unref?.(); return id; };
  const clearTimer = typeof deps.clearTimer === 'function' ? deps.clearTimer : (id) => clearTimeout(id);
  const markTimers = new Map(); // runId → the timer that takes a mark away STEER_MARK_MAX_MS after it

  /** "Steering…" goes: the steer's turn shows output, the run ended, or the mark is too old. */
  function clearMark(runId) {
    const timer = markTimers.get(runId);
    if (timer != null) { clearTimer(timer); markTimers.delete(runId); }
    const run = deps.getRun?.(runId);
    if (!run || run.steering !== true) return false;
    deps.patchRun?.(runId, { ...STEER_CLEARED });
    deps.setActivity?.(runId, null);
    return true;
  }

  function markRunSteering(runId, text) {
    const run = deps.getRun?.(runId) || null;
    const patch = steeringPatch(run, { text, at: now() });
    deps.patchRun?.(runId, patch);
    // The stage and the tray say the steer (the run's activity line) until the steer's turn shows something of its own.
    deps.setActivity?.(runId, { kind: 'steer', name: 'steer', step: steerNoticeText(text, t), at: now() });
    // Never longer than STEER_MARK_MAX_MS: a new steer starts the wait again.
    const previous = markTimers.get(runId);
    if (previous != null) clearTimer(previous);
    markTimers.set(runId, setTimer(() => {
      markTimers.delete(runId);
      if (deps.getRun?.(runId)?.steeredAt === patch.steeredAt) clearMark(runId);
    }, STEER_MARK_MAX_MS + 50));
  }
  /** A run this panel has not marked for a steer yet (a mark seen only in a descriptor has no steeredAt). */
  const freshMark = (run) => !isSteering(run) || !run.steeredAt;

  /** A failed steer: what the panel says, and the way on ("Send it to the Assistant" after 409). */
  function failed(result, payload, runId) {
    const view = steerFailureView(result, t);
    if (view.kind === 'unavailable') {
      deps.setSteerable?.(false);
      deps.notice?.(view.message, { kind: 'warn' });
      // An older server: the Assistant's own turn queues as before; a run steer cannot be done.
      if (!runId && deps.isRunning?.()) return deps.queue?.(payload) ?? 'queued';
      return false;
    }
    if (view.kind === 'ended') {
      deps.setTarget?.(null);
      const retry = { ...payload, steerTarget: null };
      deps.notice?.(view.message, {
        kind: 'warn',
        action: {
          label: view.offerLabel,
          run: async () => {
            const outcome = await submit({ ...retry, mode: deps.isRunning?.() ? 'steer' : null });
            deps.focusComposer?.();
            return outcome;
          },
        },
      });
      return 'ended';
    }
    deps.notice?.(view.message, { kind: 'error' });
    return false; // the words stay in the composer
  }

  async function steerBrain(payload) {
    const text = deps.promptText ? deps.promptText(payload) : String(payload?.text || '');
    const body = steerRequestBody({ sessionId: deps.sessionId?.(), text });
    if (!body) return false;
    const result = await deps.post(body);
    if (!result?.ok) return failed(result, payload, null);
    // The server's 'steered' packet may have come before this answer: then it drew the notice already.
    if (seen(keyOf(null, body.text))) return 'steered';
    remember(keyOf(null, body.text));
    // The brain's reply was cut (interruptedTurn): the transcript draws a break before the notice.
    deps.notice?.(steerNoticeText(payload?.display ?? payload?.text ?? body.text, t), { kind: 'steer', cut: result.interruptedTurn !== false });
    return 'steered';
  }

  async function steerRun(runId, text, payload = null) {
    const body = steerRequestBody({ sessionId: deps.sessionId?.(), text, runId });
    if (!body) return false;
    const result = await deps.post(body);
    if (!result?.ok) return failed(result, payload || { text }, runId);
    const echoed = seen(keyOf(runId, body.text));
    remember(keyOf(runId, body.text));
    const current = deps.getRun?.(runId);
    if (!echoed || freshMark(current)) markRunSteering(runId, body.text);
    if (echoed) return 'steered';
    const run = deps.getRun?.(runId) || null;
    deps.notice?.(steerNoticeText(body.text, t, { run: deps.runLabel?.(run) || runId }), { kind: 'steer' });
    return 'steered';
  }

  /**
   * The composer's send. 'steer' while the Assistant works → its turn is cut; a target → that run;
   * 'queue' (or a server that cannot steer) → the queue; images cannot ride a steer, so they queue.
   */
  async function submit(payload = {}) {
    const target = payload.steerTarget?.runId || null;
    if (target) {
      const text = deps.promptText ? deps.promptText(payload) : String(payload.text || '');
      return steerRun(target, text, payload);
    }
    if (!deps.isRunning?.()) return deps.send?.(payload);
    const wantsSteer = payload.mode === 'steer' && deps.steerable?.() !== false && !(payload.images && payload.images.length);
    if (!wantsSteer) return deps.queue?.(payload);
    return steerBrain(payload);
  }

  /** The composer's target chip for a run, with what was typed in the run's own input carried over. */
  function targetRun(runId, text = '', { index = null } = {}) {
    const run = deps.getRun?.(runId) || { runId };
    if (!canSteerRun(run)) return false;
    deps.setTarget?.({ runId, title: run.title || run.task || runId, index }, text);
    deps.focusComposer?.();
    return true;
  }

  /** A 'steered' notice or run event from the server (this window's steer, another window's, the brain's agent_send). */
  function onSteered(packet) {
    const ev = steeredEventOf(packet);
    if (!ev) return false;
    const key = keyOf(ev.target === 'run' ? ev.runId : null, ev.text);
    // A packet that names the steer without its words (a replayed or slimmed copy) marks the run, never a notice of
    // its own: the notice is drawn once, with the text, by the packet or the answer that carries it.
    const hasText = !!ev.text.trim();
    if (ev.target === 'run' && ev.runId) {
      const run = deps.getRun?.(ev.runId);
      if (!run) return false;
      if (freshMark(run) || (hasText && !seen(key))) markRunSteering(ev.runId, ev.text);
      if (hasText && !seen(key)) { remember(key); deps.notice?.(steerNoticeText(ev.text, t, { run: deps.runLabel?.(run) || ev.runId }), { kind: 'steer' }); }
      return true;
    }
    if (hasText && !seen(key)) { remember(key); deps.notice?.(steerNoticeText(ev.text, t), { kind: 'steer', cut: ev.interruptedTurn }); }
    return true;
  }

  /**
   * The run began a turn (the steer's): "Steering…" stays until that turn shows something (onRunOutput, onRunTokens),
   * so it is seen at all. True when this was the start of the steer's turn.
   */
  function onTurnStarted(runId) {
    const run = deps.getRun?.(runId);
    if (!isSteering(run) || run.steerTurnStarted === true) return false;
    deps.patchRun?.(runId, { steerTurnStarted: true, steerTokens: steerTokensOf(run) });
    return true;
  }

  /** A provider event of the run: the steer's turn's first text, call or thinking takes "Steering…" away. */
  function onRunOutput(runId, payload = null, activity = null) {
    const run = deps.getRun?.(runId);
    if (!isSteering(run) || run.steerTurnStarted !== true) return false;
    if (payload && !isRunOutputEvent(payload, activity)) return false;
    return clearMark(runId);
  }

  /** The run's tokens as a usage packet counts them: more than at the start of the steer's turn is its output. */
  function onRunTokens(runId, total) {
    const run = deps.getRun?.(runId);
    if (!isSteering(run) || run.steerTurnStarted !== true) return false;
    const at = Number(run.steerTokens);
    if (!(Number(total) > (Number.isFinite(at) ? at : 0))) return false;
    return clearMark(runId);
  }

  return { submit, steerRun, targetRun, onSteered, onTurnStarted, onRunOutput, onRunTokens, clearMark };
}
