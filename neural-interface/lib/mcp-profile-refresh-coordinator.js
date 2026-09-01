import { randomUUID } from 'crypto';

/**
 * Serializes and coalesces post-tool-call MCP refreshes per managed runtime.
 * Different sidepanels remain independent; repeated selections in one panel
 * collapse to the newest pending profile and never reconnect concurrently.
 */
export class McpProfileRefreshCoordinator {
  constructor({
    delayMs = 250,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    correlationId = randomUUID,
    onError = () => {},
  } = {}) {
    this.delayMs = delayMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.correlationId = correlationId;
    this.onError = onError;
    this.states = new Map();
  }

  schedule(runtimeId, profile, runtimeKind, refresh) {
    const refreshCorrelationId = this.correlationId();
    let state = this.states.get(runtimeId);
    if (!state) {
      state = { timer: null, running: false, cancelled: false, pending: null };
      this.states.set(runtimeId, state);
    }
    state.cancelled = false;
    state.pending = { profile, runtimeKind, correlationId: refreshCorrelationId, refresh };
    if (state.timer) this.clearTimer(state.timer);
    if (!state.running) this.#arm(runtimeId, state);
    return refreshCorrelationId;
  }

  cancel(runtimeId) {
    const state = this.states.get(runtimeId);
    if (!state) return false;
    if (state.timer) this.clearTimer(state.timer);
    state.timer = null;
    state.pending = null;
    state.cancelled = true;
    if (!state.running) this.states.delete(runtimeId);
    return true;
  }

  get size() {
    return this.states.size;
  }

  #arm(runtimeId, state) {
    state.timer = this.setTimer(async () => {
      state.timer = null;
      if (state.cancelled || state.running) return;
      const task = state.pending;
      state.pending = null;
      if (!task) return;
      state.running = true;
      try {
        await task.refresh(task.correlationId);
      } catch (error) {
        try { this.onError({ runtimeId, ...task, error }); } catch {}
      } finally {
        state.running = false;
        if (state.cancelled) {
          this.states.delete(runtimeId);
        } else if (state.pending) {
          this.#arm(runtimeId, state);
        } else {
          this.states.delete(runtimeId);
        }
      }
    }, this.delayMs);
    state.timer?.unref?.();
  }
}
