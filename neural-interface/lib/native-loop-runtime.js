import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const NATIVE_LOOP_PROFILES = new Set(['claude-code', 'codex', 'opencode']);

export function isNativeLoopProfile(profile) {
  return NATIVE_LOOP_PROFILES.has(String(profile || ''));
}

function iso(now = Date.now()) {
  return new Date(now).toISOString();
}

function cleanDescriptor(record) {
  return {
    runId: record.runId,
    terminalSessionId: record.runId,
    surface: 'sidepanel',
    runtimeType: 'native',
    provider: record.provider,
    providerSessionId: record.providerSessionId || null,
    providerThreadId: record.providerThreadId || null,
    source: record.source,
    focus: !!record.focus,
    status: record.status,
    title: record.title,
    task: record.task,
    cwd: record.cwd,
    model: record.model || null,
    effort: record.effort || null,
    mcpProfile: record.mcpProfile || null,
    accountId: record.accountId || null,
    currentIteration: record.currentIteration || 0,
    totalIterations: record.totalIterations || 0,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt || null,
    stoppedReason: record.stoppedReason || null,
    browserSessionId: record.browserSessionId || null,
    browserTabId: record.browserTabId || null,
    scheduleId: record.scheduleId || null,
    claimedBy: record.claimedBy || null,
    claimedAt: record.claimedAt || null,
    error: record.error || null,
    version: Number(record.version) || 0,
  };
}

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return fallback; }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}

/**
 * Drives unattended native provider conversations while keeping the provider
 * transcript durable and attachable by a sidepanel at any point in the run.
 */
export class NativeLoopRuntime {
  constructor({
    stateDir,
    ledgerPath,
    providerFactories = {},
    buildPrompt,
    onEvent = () => {},
    onFinish = () => {},
    log = () => {},
    now = Date.now,
    sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
    iterationDelayMs = 1000,
    // Deprecated: the 20s identity wait used to block the launch HTTP response.
    // Identity is now delivered via the sidepanel:run-updated WebSocket event after
    // launch() returns. Kept for back-compat (test fixtures) but no longer used.
    identityWaitMs = 0,
    providerStartupTimeoutMs = 30_000,
    claimTtlMs = 90_000,
    ledgerFlushMs = 200,
  } = {}) {
    if (!stateDir) throw new Error('NativeLoopRuntime requires stateDir');
    if (typeof buildPrompt !== 'function') throw new Error('NativeLoopRuntime requires buildPrompt');
    this.stateDir = stateDir;
    this.ledgerPath = ledgerPath || resolve(dirname(stateDir), 'native-loop-runs.json');
    this.providerFactories = { ...providerFactories };
    this.buildPrompt = buildPrompt;
    this.onEvent = onEvent;
    this.onFinish = onFinish;
    this.log = log;
    this.now = now;
    this.sleep = sleep;
    this.iterationDelayMs = iterationDelayMs;
    this.identityWaitMs = identityWaitMs;
    this.providerStartupTimeoutMs = providerStartupTimeoutMs;
    this.claimTtlMs = claimTtlMs;
    this.ledgerFlushMs = Math.max(50, Number(ledgerFlushMs) || 200);
    this.records = new Map();
    this._pendingPersist = false;
    this._persistTimer = null;
    this._alwaysPersist = false;
    this._loadLedger();
  }

  registerProvider(profile, factory) {
    if (typeof factory !== 'function') throw new Error(`Provider factory for ${profile} must be a function`);
    this.providerFactories[profile] = factory;
  }

  _loadLedger() {
    const rows = readJson(this.ledgerPath, []);
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!row?.runId) continue;
      const record = { ...row, adapter: null, timer: null, execution: null };
      if (record.status === 'starting' || record.status === 'running') {
        record.status = 'interrupted';
        record.stoppedReason = 'server_restart';
        record.completedAt = record.completedAt || iso(this.now());
        record.updatedAt = iso(this.now());
        const state = this._readState(record.runId);
        if (state) {
          this._writeState(record.runId, {
            ...state,
            active: false,
            pending: false,
            completedAt: record.completedAt,
            stoppedReason: 'server_restart',
          });
        }
      }
      this.records.set(record.runId, record);
    }
    this._persistLedger({ force: true });
  }

  _writeLedgerNow() {
    const records = [...this.records.values()];
    const active = records.filter((record) => ['starting', 'running'].includes(record.status));
    const terminal = records
      .filter((record) => !['starting', 'running'].includes(record.status))
      .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
    const retained = [...active, ...terminal.slice(0, Math.max(0, 500 - active.length))];
    const retainedIds = new Set(retained.map((record) => record.runId));
    for (const record of terminal) {
      if (!retainedIds.has(record.runId)) {
        this.records.delete(record.runId);
        try { unlinkSync(this._statePath(record.runId)); } catch {}
      }
    }
    const rows = retained
      .map(cleanDescriptor)
      .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
    try { writeJsonAtomic(this.ledgerPath, rows); }
    catch (error) { this.log(null, 'ledger:error', error.message); }
  }

  // Coalesce ledger writes. Each provider event would otherwise trigger a full
  // O(N) rewrite of the ledger file; with a 200-iteration loop streaming ~50
  // events/sec that's 10k fsyncs. The throttle collapses a burst to one write
  // per ledgerFlushMs (default 200ms) while always flushing synchronously on
  // status transitions and on shutdown so a crash never loses terminal state.
  _persistLedger({ force = false } = {}) {
    if (force) {
      if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
      this._pendingPersist = false;
      this._writeLedgerNow();
      return;
    }
    if (this._persistTimer) { this._pendingPersist = true; return; }
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this._writeLedgerNow();
      if (this._pendingPersist) {
        this._pendingPersist = false;
        this._persistTimer = setTimeout(() => {
          this._persistTimer = null;
          this._writeLedgerNow();
        }, this.ledgerFlushMs);
      }
    }, this.ledgerFlushMs);
    this._persistTimer.unref?.();
  }

  // Back-compat shim — older callers (and tests) invoke _persistLedger() expecting
  // a synchronous write. The throttled path now defers most writes; force-flush
  // remains the explicit escape hatch.
  _persistLedgerSync() { this._writeLedgerNow(); }

  _statePath(runId) {
    return resolve(this.stateDir, `${runId}.json`);
  }

  _readState(runId) {
    const path = this._statePath(runId);
    return existsSync(path) ? readJson(path, null) : null;
  }

  _writeState(runId, state) {
    writeJsonAtomic(this._statePath(runId), state);
  }

  _writeTerminalState(record, patch) {
    try {
      const state = this._readState(record.runId);
      if (state) this._writeState(record.runId, { ...state, ...patch });
    } catch (error) {
      this.log(record.runId, 'native:state-write-error', error?.message || String(error));
    }
  }

  _emit(type, record, extra = {}) {
    record.version = (Number(record.version) || 0) + 1;
    record.updatedAt = iso(this.now());
    // Force-flush on terminal transitions (a crash between throttled flushes
    // would otherwise leave the run listed as running after a restart).
    const terminal = ['completed', 'failed', 'stopped', 'interrupted'].includes(record.status);
    this._persistLedger({ force: terminal });
    const descriptor = cleanDescriptor(record);
    try { this.onEvent({ type, run: descriptor, ...extra }); } catch {}
    return descriptor;
  }

  _setIdentity(record, identity = {}) {
    const providerSessionId = identity.providerSessionId || identity.sessionId || null;
    const providerThreadId = identity.providerThreadId || identity.threadId || null;
    let changed = false;
    if (providerSessionId && providerSessionId !== record.providerSessionId) {
      record.providerSessionId = providerSessionId;
      changed = true;
    }
    if (providerThreadId && providerThreadId !== record.providerThreadId) {
      record.providerThreadId = providerThreadId;
      changed = true;
    }
    if (changed) this._emit('sidepanel:run-updated', record, { reason: 'identity' });
    if ((record.providerSessionId || record.providerThreadId) && record._resolveIdentity) {
      record._resolveIdentity(cleanDescriptor(record));
      record._resolveIdentity = null;
    }
  }

  async launch({ runId, state, source = 'manual', focus = source === 'manual', title, scheduleId = null, claimedBy = null } = {}) {
    if (!runId) throw new Error('Native loop runId is required');
    if (!state?.profile || !isNativeLoopProfile(state.profile)) {
      throw new Error(`Unsupported native loop profile: ${state?.profile || 'unknown'}`);
    }
    if (this.isAlive(runId)) throw new Error(`Native loop ${runId} is already running`);
    const factory = this.providerFactories[state.profile];
    if (!factory) throw new Error(`Native provider unavailable: ${state.profile}`);

    mkdirSync(this.stateDir, { recursive: true });
    const startedAt = state.startedAt || iso(this.now());
    const nativeState = {
      ...state,
      runId,
      terminalSessionId: runId,
      active: true,
      pending: false,
      driverType: 'native',
      runtimeType: 'native',
      surface: 'sidepanel',
      startedAt,
    };
    this._writeState(runId, nativeState);
    const initialClaim = String(claimedBy || '').trim().slice(0, 128);

    const record = {
      runId,
      provider: state.profile,
      providerSessionId: null,
      providerThreadId: null,
      source,
      focus,
      status: 'starting',
      title: title || String(state.task || 'Automation').slice(0, 80),
      task: String(state.task || '').slice(0, 240),
      cwd: state.cwd || process.cwd(),
      model: state.model || null,
      effort: state.effort || null,
      mcpProfile: state.mcpProfile || null,
      accountId: state.codexAccountId || null,
      currentIteration: Number(state.currentIteration) || 0,
      totalIterations: Number(state.totalIterations) || 1,
      startedAt,
      updatedAt: startedAt,
      completedAt: null,
      stoppedReason: null,
      browserSessionId: state.browserSessionId || null,
      browserTabId: state.browserTabId || null,
      scheduleId,
      claimedBy: initialClaim || null,
      claimedAt: initialClaim ? iso(this.now()) : null,
      error: null,
      version: 0,
      adapter: null,
      timer: null,
      execution: null,
      stopping: false,
      startupAbortController: new AbortController(),
    };
    record.identityPromise = new Promise((resolveIdentity) => { record._resolveIdentity = resolveIdentity; });
    record.startupCancelPromise = new Promise((resolveCancel) => { record._cancelStartup = resolveCancel; });
    this.records.set(runId, record);
    this._emit('sidepanel:run-created', record);
    const maxMs = Math.max(1, Number(nativeState.maxMinutes) || 30) * 60_000;
    record.timer = setTimeout(() => { this.stop(runId, 'time_cap').catch(() => {}); }, maxMs);
    record.timer.unref?.();

    const startupSignal = record.startupAbortController.signal;
    const factoryPromise = Promise.resolve().then(() => factory({
        ...nativeState,
        runId,
        source,
        title: record.title,
        signal: startupSignal,
        onIdentity: (identity) => this._setIdentity(record, identity),
        onEvent: (event) => {
          try { this.onEvent({ type: 'sidepanel:provider-event', run: cleanDescriptor(record), event }); } catch {}
        },
      }));
    let startupTimer = null;
    let candidate = null;
    let candidateAccepted = false;
    let candidateCleaned = false;
    const cleanupCandidate = async (adapter, reason) => {
      if (!adapter || candidateCleaned) return;
      candidateCleaned = true;
      try { await adapter.abort?.(reason); } catch {}
      try { await adapter.dispose?.({ preserveSession: true }); } catch {}
    };
    const finishBootstrap = async () => {
      clearTimeout(startupTimer);
      // Drain any pending ledger writes so the descriptor's status is durable
      // before we resolve — the HTTP caller is going to publish this descriptor.
      this._persistLedger({ force: true });
    };

    // The provider factory bootstrap is now decoupled from the launch() return.
    //
    // Why: the OpenCode factory awaits `ensureIsolatedServe` (12s cold) and the
    // Claude factory constructs an SDK query that can take seconds. The legacy
    // 20s identityWaitMs that used to follow the factory was the dominant
    // "the loop looks frozen" complaint on Mac.
    //
    // New contract:
    //   * launch() returns as soon as the run is registered (status: 'starting',
    //     no provider identity yet). The HTTP caller is unblocked immediately.
    //   * The bootstrap continues in the background; identity and state changes
    //     arrive via sidepanel:run-updated WebSocket events.
    //   * If the bootstrap fails, record.bootstrap is a rejected promise. The
    //     record's status moves to 'failed' and a sidepanel:run-failed event is
    //     emitted so the client can react.
    //   * record.identityPromise resolves the first time the provider reports an
    //     identity — same shape as before.
    const bootstrap = (async () => {
      let startupError = null;
      try {
        const startupTimeout = new Promise((_resolve, reject) => {
          startupTimer = setTimeout(() => {
            const error = new Error(`${state.profile} native provider startup timed out`);
            error.code = 'NATIVE_LOOP_PROVIDER_START_TIMEOUT';
            reject(error);
          }, Math.max(1, Number(this.providerStartupTimeoutMs) || 30_000));
          startupTimer.unref?.();
        });
        const startupCancelled = record.startupCancelPromise.then((reason) => {
          const error = new Error(`${state.profile} native loop was stopped during provider startup`);
          error.code = 'NATIVE_LOOP_START_CANCELLED';
          error.reason = reason;
          throw error;
        });
        candidate = await Promise.race([factoryPromise, startupTimeout, startupCancelled]);
        const adapter = candidate;
        if (!adapter || typeof adapter.runTurn !== 'function') {
          await cleanupCandidate(adapter, 'invalid_adapter');
          throw new Error(`${state.profile} native provider did not return a runnable adapter`);
        }
        if (record.status !== 'starting' || record.stopping) {
          await cleanupCandidate(adapter, record.stoppedReason || 'startup_cancelled');
          const cancelled = new Error(`${state.profile} native loop was stopped during provider startup`);
          cancelled.code = 'NATIVE_LOOP_START_CANCELLED';
          throw cancelled;
        }
        record.adapter = adapter;
        candidateAccepted = true;
        this._setIdentity(record, record.adapter.identity?.() || record.adapter);
        record.status = 'running';
        this._emit('sidepanel:run-updated', record, { reason: 'started' });
        record.execution = this._drive(record).catch((error) => this._fail(record, error));
      } catch (error) {
        startupError = error;
        if (!candidateAccepted) {
          if (candidate) await cleanupCandidate(candidate, error?.code || 'startup_failed');
          else factoryPromise.then((adapter) => cleanupCandidate(adapter, error?.code || 'startup_failed')).catch(() => {});
        }
        await this._fail(
          record,
          error,
          error?.code === 'NATIVE_LOOP_PROVIDER_START_TIMEOUT' ? 'provider_startup_timeout' : 'provider_error',
        );
      } finally {
        await finishBootstrap();
        // Re-throw so record.bootstrap rejects with the original startup error.
        // The status / onEvent side effects have already been driven; this is
        // purely for callers that awaited record.bootstrap to know the outcome.
        if (startupError) throw startupError;
      }
    })();
    record.bootstrap = bootstrap;

    // Don't keep the Node event loop alive on a stuck bootstrap — the time_cap
    // timer holds the process until cleanup. Swallow the unhandled rejection
    // here because callers that care must await record.bootstrap explicitly.
    bootstrap.catch(() => {});

    // For back-compat: callers that awaited launch() to know whether the run was
    // accepted can observe the descriptor. The failure (if any) is delivered via
    // sidepanel:run-failed and via record.bootstrap rejecting with the original
    // startup error. The descriptor itself resolves immediately with the
    // 'starting' state so the HTTP caller is never gated on provider boot.
    return cleanDescriptor(record);
  }

  async _drive(record) {
    let failures = 0;
    while (this.isAlive(record.runId)) {
      const state = this._readState(record.runId);
      if (!state || state.active === false) {
        await this.stop(record.runId, state ? 'state_inactive' : 'state_removed');
        return;
      }
      const elapsed = this.now() - new Date(state.startedAt || record.startedAt).getTime();
      if (elapsed >= Math.max(1, Number(state.maxMinutes) || 30) * 60_000) {
        await this.stop(record.runId, 'time_cap');
        return;
      }
      const current = Number(state.currentIteration) || 0;
      const total = Math.max(1, Number(state.totalIterations) || 1);
      if (current >= total) {
        await this._complete(record, 'iteration_cap');
        return;
      }

      const iteration = current + 1;
      const nextState = {
        ...state,
        currentIteration: iteration,
        runningIteration: iteration,
        lastIterationAt: iso(this.now()),
        pending: false,
      };
      this._writeState(record.runId, nextState);
      record.currentIteration = iteration;
      record.totalIterations = total;
      this._emit('sidepanel:run-updated', record, { reason: 'iteration-started' });

      try {
        const prompt = this.buildPrompt(nextState, iteration);
        const result = await record.adapter.runTurn(prompt, { iteration, total });
        failures = 0;
        this._setIdentity(record, result || record.adapter.identity?.() || {});
        const fresh = this._readState(record.runId);
        if (!fresh || fresh.active === false) {
          await this.stop(record.runId, fresh ? 'state_inactive' : 'state_removed');
          return;
        }
        fresh.lastIterationAt = iso(this.now());
        fresh.lastResultAt = fresh.lastIterationAt;
        delete fresh.runningIteration;
        delete fresh.lastIterationError;
        this._writeState(record.runId, fresh);
        this._emit('sidepanel:run-updated', record, { reason: 'iteration-completed' });
      } catch (error) {
        if (!['starting', 'running'].includes(record.status)) return;
        if (record.adapter?.isAlive && !record.adapter.isAlive()) {
          await this._fail(record, error, 'provider_ended');
          return;
        }
        failures++;
        const failedState = this._readState(record.runId);
        if (failedState) {
          failedState.currentIteration = current;
          delete failedState.runningIteration;
          failedState.lastIterationError = error?.message || String(error);
          failedState.lastIterationAt = iso(this.now());
          this._writeState(record.runId, failedState);
        }
        record.currentIteration = current;
        this._emit('sidepanel:run-updated', record, { reason: 'iteration-failed', failures });
        this.log(record.runId, 'native:iteration-error', error?.message || String(error), { iteration, failures });
        if (failures >= 3) {
          await this._fail(record, error, 'provider_failures');
          return;
        }
      }
      if (this.iterationDelayMs > 0 && this.isAlive(record.runId)) await this.sleep(this.iterationDelayMs);
    }
    if (['starting', 'running'].includes(record.status)) {
      await this._fail(
        record,
        new Error(`${record.provider} native provider ended unexpectedly`),
        'provider_ended',
      );
    }
  }

  _releaseRuntimeRefs(record) {
    if (!record) return;
    record.adapter = null;
    record.timer = null;
    record.execution = null;
    record.identityPromise = null;
    record._resolveIdentity = null;
    record.startupCancelPromise = null;
    record._cancelStartup = null;
    record.startupAbortController = null;
  }

  async _complete(record, reason = 'completed') {
    if (!record || !['starting', 'running'].includes(record.status)) return;
    clearTimeout(record.timer);
    record.status = 'completed';
    record.completedAt = iso(this.now());
    record.stoppedReason = reason;
    this._writeTerminalState(record, { active: false, pending: false, completedAt: record.completedAt, stoppedReason: reason });
    try { await record.adapter?.dispose?.({ preserveSession: true }); } catch {}
    this._releaseRuntimeRefs(record);
    this._emit('sidepanel:run-completed', record);
    try { await this.onFinish(cleanDescriptor(record)); } catch {}
  }

  async _fail(record, error, reason = 'provider_error') {
    if (!record || ['completed', 'failed', 'stopped', 'interrupted'].includes(record.status)) return;
    clearTimeout(record.timer);
    record.status = 'failed';
    record.error = error?.message || String(error);
    record.stoppedReason = reason;
    record.completedAt = iso(this.now());
    if (record._resolveIdentity) { record._resolveIdentity(null); record._resolveIdentity = null; }
    try { record.startupAbortController?.abort(reason); } catch {}
    if (record._cancelStartup) { record._cancelStartup(reason); record._cancelStartup = null; }
    this._writeTerminalState(record, { active: false, pending: false, completedAt: record.completedAt, stoppedReason: reason, error: record.error });
    try { await record.adapter?.abort?.(reason); } catch {}
    try { await record.adapter?.dispose?.({ preserveSession: true }); } catch {}
    this._releaseRuntimeRefs(record);
    this._emit('sidepanel:run-failed', record);
    try { await this.onFinish(cleanDescriptor(record)); } catch {}
  }

  async stop(runId, reason = 'user') {
    const record = this.records.get(runId);
    if (!record || !['starting', 'running'].includes(record.status) || record.stopping) return false;
    record.stopping = true;
    clearTimeout(record.timer);
    record.status = 'stopped';
    record.stoppedReason = reason;
    record.completedAt = iso(this.now());
    if (record._resolveIdentity) { record._resolveIdentity(null); record._resolveIdentity = null; }
    try { record.startupAbortController?.abort(reason); } catch {}
    if (record._cancelStartup) { record._cancelStartup(reason); record._cancelStartup = null; }
    this._writeTerminalState(record, { active: false, pending: false, completedAt: record.completedAt, stoppedReason: reason });
    try { await record.adapter?.abort?.(reason); } catch {}
    try { await record.adapter?.dispose?.({ preserveSession: true }); } catch {}
    this._releaseRuntimeRefs(record);
    this._emit('sidepanel:run-stopped', record);
    try { await this.onFinish(cleanDescriptor(record)); } catch {}
    return true;
  }

  isAlive(runId) {
    const record = this.records.get(runId);
    if (!record || !['starting', 'running'].includes(record.status)) return false;
    if (record.adapter?.isAlive && !record.adapter.isAlive()) return false;
    return true;
  }

  claim(runId, windowId) {
    const record = this.records.get(runId);
    if (!record) return { ok: false, reason: 'not_found' };
    const claimant = String(windowId || '').trim().slice(0, 128);
    if (!claimant) return { ok: false, reason: 'window_id_required' };
    const claimAge = record.claimedAt ? this.now() - new Date(record.claimedAt).getTime() : Infinity;
    if (record.claimedBy && record.claimedBy !== claimant && claimAge <= this.claimTtlMs) {
      return { ok: false, reason: 'already_claimed', run: cleanDescriptor(record) };
    }
    const changedOwner = record.claimedBy !== claimant;
    record.claimedBy = claimant;
    record.claimedAt = iso(this.now());
    if (changedOwner) this._emit('sidepanel:run-claimed', record);
    else {
      record.updatedAt = iso(this.now());
      this._persistLedger();
    }
    return { ok: true, run: cleanDescriptor(record) };
  }

  releaseClaim(runId, windowId) {
    const record = this.records.get(runId);
    const claimant = String(windowId || '').trim().slice(0, 128);
    if (!record || !claimant || record.claimedBy !== claimant) return false;
    record.claimedBy = null;
    record.claimedAt = null;
    this._emit('sidepanel:run-updated', record, { reason: 'claim-released' });
    return true;
  }

  releaseClaimsByWindow(windowId) {
    const claimant = String(windowId || '').trim().slice(0, 128);
    if (!claimant) return 0;
    let released = 0;
    for (const record of this.records.values()) {
      if (record.claimedBy !== claimant) continue;
      record.claimedBy = null;
      record.claimedAt = null;
      this._emit('sidepanel:run-updated', record, { reason: 'claim-released' });
      released++;
    }
    return released;
  }

  setMcpProfile(runId, profile) {
    const record = this.records.get(runId);
    const normalized = String(profile || '').toLowerCase().trim();
    if (!record || !normalized) return null;
    if (record.mcpProfile === normalized) return cleanDescriptor(record);
    record.mcpProfile = normalized;
    try {
      const state = this._readState(record.runId);
      if (state) this._writeState(record.runId, { ...state, mcpProfile: normalized });
    } catch (error) {
      this.log(record.runId, 'native:state-write-error', error?.message || String(error));
    }
    return this._emit('sidepanel:run-updated', record, { reason: 'mcp-profile' });
  }

  get(runId) {
    const record = this.records.get(runId);
    return record ? cleanDescriptor(record) : null;
  }

  list({ activeOnly = false } = {}) {
    return [...this.records.values()]
      .filter((record) => !activeOnly || ['starting', 'running'].includes(record.status))
      .map(cleanDescriptor)
      .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  }

  async shutdown(reason = 'server_shutdown') {
    await Promise.allSettled([...this.records.values()]
      .filter((record) => ['starting', 'running'].includes(record.status))
      .map((record) => this.stop(record.runId, reason)));
    this._persistLedger({ force: true });
  }
}
