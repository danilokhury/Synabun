import { retainExternalRefs } from './mcp-external-servers.js';
import { storedToolList, toolListRecord, readStoredToolListRecord } from './tool-lists.js';
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
    contextMode: record.contextMode || null,
    modelContextWindow: record.modelContextWindow || null,
    effort: record.effort || null,
    tools: storedToolList(record),
    externalMcpVersion: 2,
    ...(record.toolListError ? { toolListError: record.toolListError } : {}),
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
    // Task-mode (assistant dispatch) fields. Absent/null for classic loops so
    // existing consumers (router, sidepanels, schedules) are unaffected.
    runMode: record.runMode || 'loop',
    turnState: record.turnState || null,
    // What the last turn's result said (task mode: done, blocked or needs_input; the dispatcher's
    // lastResult.status): an idle warm worker whose turn ended asking waits on the user.
    outcome: record.outcome || null,
    assistantSessionId: record.assistantSessionId || null,
    // A dispatched worker a server restart cut off (status 'suspended') waits for its resume on the next start;
    // `resumes` counts how often it was resumed (assistant-dispatch.js resumeRun).
    suspendedAt: record.suspendedAt || null,
    suspendReason: record.suspendReason || null,
    resumes: Number(record.resumes) || 0,
    resumedAt: record.resumedAt || null,
  };
}

/** Run statuses that hold a run in the ledger as live: it runs, or waits for its resume after a restart. */
const LIVE_STATUSES = new Set(['starting', 'running', 'suspended']);

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
    toolListOptions = () => ({}),
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
    // Optional (state, result, {iteration,total}) => {met, probability} | null.
    // A truthy `met` ends the run early with stoppedReason 'goal_met'; the
    // iteration and time caps stay the fallback.
    judgeGoal = null,
    // How long a dispatched worker the restart cut off waits, from this start, for its dispatcher to resume it
    // (or end it) before it ends as interrupted by itself.
    resumeHoldMs = 60_000,
  } = {}) {
    if (!stateDir) throw new Error('NativeLoopRuntime requires stateDir');
    if (typeof buildPrompt !== 'function') throw new Error('NativeLoopRuntime requires buildPrompt');
    this.stateDir = stateDir;
    this.toolListOptions = toolListOptions;
    this.judgeGoal = typeof judgeGoal === 'function' ? judgeGoal : null;
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
    this.resumeHoldMs = Math.max(1000, Number(resumeHoldMs) || 60_000);
    this._holdTimers = new Map();
    this.records = new Map();
    this._pendingPersist = false;
    this._persistTimer = null;
    this._alwaysPersist = false;
    this._listeners = new Set();
    this._loadLedger();
  }

  registerProvider(profile, factory) {
    if (typeof factory !== 'function') throw new Error(`Provider factory for ${profile} must be a function`);
    this.providerFactories[profile] = factory;
  }

  /**
   * In-process fan-out of every run event and provider event. Unlike the
   * onEvent → broadcastSync path (which may drop high-volume provider events
   * for slow WebSocket clients), subscribers always receive every message.
   * Returns an unsubscribe function.
   */
  subscribe(listener) {
    if (typeof listener !== 'function') throw new Error('NativeLoopRuntime.subscribe requires a function');
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  }

  _notifyListeners(message) {
    for (const listener of this._listeners) {
      try { listener(message); } catch {}
    }
  }

  _emitProviderEvent(record, event) {
    const message = { type: 'sidepanel:provider-event', run: cleanDescriptor(record), event };
    try { this.onEvent(message); } catch {}
    this._notifyListeners(message);
  }

  /**
   * Task-mode helper: records the wrapper's turn phase ('starting' | 'running' |
   * 'idle' | 'awaiting_permission' | 'terminal') and broadcasts it so panels and
   * the assistant dock can render it. No-op for unknown runs.
   */
  setTurnState(runId, turnState) {
    const record = this.records.get(runId);
    if (!record) return null;
    const next = turnState ? String(turnState) : null;
    if (record.turnState === next) return cleanDescriptor(record);
    record.turnState = next;
    return this._emit('sidepanel:run-updated', record, { reason: 'turn-state' });
  }

  /**
   * Task-mode helper: records what the wrapper's last turn reported ('done' |
   * 'blocked' | 'needs_input', the dispatcher's lastResult.status) and
   * broadcasts it, so a panel can tell a warm worker that rests from one whose
   * turn ended asking the user. No-op for unknown runs.
   */
  setOutcome(runId, outcome) {
    const record = this.records.get(runId);
    if (!record) return null;
    const next = outcome ? String(outcome) : null;
    if ((record.outcome || null) === next) return cleanDescriptor(record);
    record.outcome = next;
    return this._emit('sidepanel:run-updated', record, { reason: 'outcome' });
  }

  _loadLedger() {
    const rows = readJson(this.ledgerPath, []);
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!row?.runId) continue;
      let stored;
      try { stored = readStoredToolListRecord(row, this.toolListOptions()); }
      catch (error) {
        // A historical run may name a custom preset the owner has since deleted. Refuse that
        // run, preserve the original selection for diagnosis, and keep the rest of the server up.
        stored = { ...row, tools: [], status: 'failed', stoppedReason: 'tools_invalid',
          error: error.message, toolListError: { code: error.code, message: error.message,
            original: row.tools ?? row.mcpProfile ?? null } };
        delete stored.mcpProfile;
      }
      const record = { ...stored, adapter: null, timer: null, execution: null };
      const cutOff = record.status === 'starting' || record.status === 'running' || record.status === 'suspended';
      if (cutOff && record.runMode === 'task' && isNativeLoopProfile(record.provider)) {
        // A dispatched Claude Code worker the restart cut off (suspended by the last shutdown, or left running by a
        // crash): held for its dispatcher, which resumes it (assistant-dispatch.js resumeRun) or ends it. Its state file
        // stays as it is. Nobody takes it within resumeHoldMs: it ends as interrupted, as every cut-off run did before.
        record.status = 'suspended';
        record.suspendedAt = record.suspendedAt || iso(this.now());
        record.suspendReason = record.suspendReason || 'server_restart';
        record.turnState = 'suspended';
        record.stopping = false;
        this.records.set(record.runId, record);
        this._hold(record);
        continue;
      }
      if (cutOff) {
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
    const active = records.filter((record) => LIVE_STATUSES.has(record.status));
    const terminal = records
      .filter((record) => !LIVE_STATUSES.has(record.status))
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
      .map(record => toolListRecord(cleanDescriptor(record)))
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
    const state = existsSync(path) ? readJson(path, null) : null;
    return state ? readStoredToolListRecord(state, this.toolListOptions()) : null;
  }

  _writeState(runId, state) {
    writeJsonAtomic(this._statePath(runId), toolListRecord(state, this.toolListOptions()));
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
    // would otherwise leave the run listed as running after a restart), and on
    // a suspension (the next start resumes the run from this ledger).
    const terminal = ['completed', 'failed', 'stopped', 'interrupted', 'suspended'].includes(record.status);
    this._persistLedger({ force: terminal });
    const descriptor = cleanDescriptor(record);
    const message = { type, run: descriptor, ...extra };
    try { this.onEvent(message); } catch {}
    this._notifyListeners(message);
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

  async launch({
    runId, state, source = 'manual', focus = source === 'manual', title, scheduleId = null, claimedBy = null,
    // Task-mode overrides (assistant dispatch): a per-run prompt builder and an
    // adapter wrapper that can drive follow-up turns inside a single iteration.
    buildPrompt = null, wrapAdapter = null,
  } = {}) {
    if (!runId) throw new Error('Native loop runId is required');
    if (buildPrompt !== null && typeof buildPrompt !== 'function') throw new Error('Native loop buildPrompt override must be a function');
    if (wrapAdapter !== null && typeof wrapAdapter !== 'function') throw new Error('Native loop wrapAdapter override must be a function');
    if (!state?.profile || !isNativeLoopProfile(state.profile)) {
      throw new Error(`Unsupported native loop profile: ${state?.profile || 'unknown'}`);
    }
    if (this.isAlive(runId)) throw new Error(`Native loop ${runId} is already running`);
    const factory = this.providerFactories[state.profile];
    if (!factory) throw new Error(`Native provider unavailable: ${state.profile}`);

    mkdirSync(this.stateDir, { recursive: true });
    const startedAt = state.startedAt || iso(this.now());
    const nativeState = {
      ...toolListRecord(state, this.toolListOptions()),
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
      contextMode: state.contextMode || null,
      modelContextWindow: state.modelContextWindow || null,
      effort: state.effort || null,
      tools: storedToolList(state, this.toolListOptions()),
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
      runMode: state.runMode === 'task' ? 'task' : 'loop',
      turnState: null,
      assistantSessionId: state.assistantSessionId || null,
      buildPrompt,
      wrapAdapter,
    };
    record.identityPromise = new Promise((resolveIdentity) => { record._resolveIdentity = resolveIdentity; });
    record.startupCancelPromise = new Promise((resolveCancel) => { record._cancelStartup = resolveCancel; });
    this.records.set(runId, record);
    this._emit('sidepanel:run-created', record);
    // A task run's (assistant dispatch) maxMinutes is work time, which its dispatcher counts and
    // enforces (assistant-dispatch.js, the work clock): idle time between its turns does not count,
    // so it gets no wall-clock cap here. A loop's maxMinutes stays the wall clock.
    if (record.runMode !== 'task') {
      const maxMs = Math.max(1, Number(nativeState.maxMinutes) || 30) * 60_000;
      record.timer = setTimeout(() => { this.stop(runId, 'time_cap').catch(() => {}); }, maxMs);
      record.timer.unref?.();
    }

    this._bootstrap(record, factory, nativeState, { source, profile: state.profile });

    // For back-compat: callers that awaited launch() to know whether the run was
    // accepted can observe the descriptor. The failure (if any) is delivered via
    // sidepanel:run-failed and via record.bootstrap rejecting with the original
    // startup error. The descriptor itself resolves immediately with the
    // 'starting' state so the HTTP caller is never gated on provider boot.
    return cleanDescriptor(record);
  }

  /**
   * Start the provider of a run whose record is in place (launch, resume) and drive it. Sets record.bootstrap: it
   * resolves once the provider started and rejects with the startup error. A provider that cannot start ends the
   * run as failed, or (`failAs: 'interrupted'`, a resume) as interrupted with the reason resume_failed.
   */
  _bootstrap(record, factory, nativeState, { source = record.source, profile = record.provider, failAs = 'failed' } = {}) {
    const runId = record.runId;
    const state = { profile };
    const startupSignal = record.startupAbortController.signal;
    const factoryPromise = Promise.resolve().then(() => factory({
        ...nativeState,
        runId,
        source,
        title: record.title,
        signal: startupSignal,
        onIdentity: (identity) => this._setIdentity(record, identity),
        onEvent: (event) => this._emitProviderEvent(record, event),
      }));
    let startupTimer = null;
    let candidate = null;
    let candidateAccepted = false;
    let candidateCleaned = false;
    const cleanupCandidate = async (adapter, reason) => {
      if (!adapter || candidateCleaned) return;
      candidateCleaned = true;
      try { await adapter.abort?.(reason); } catch {}
      // Suspended for a server shutdown while it started (suspend): its process is ended now, as a started one's is.
      try { await adapter.dispose?.({ preserveSession: true, ...(record.status === 'suspended' ? { terminate: true } : {}) }); } catch {}
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
        candidateAccepted = true;
        record.adapter = record.wrapAdapter
          ? record.wrapAdapter(adapter, {
              runId,
              emit: (event) => this._emitProviderEvent(record, event),
              setTurnState: (turnState) => this.setTurnState(runId, turnState),
              setOutcome: (outcome) => this.setOutcome(runId, outcome),
              readState: () => this._readState(runId),
            })
          : adapter;
        if (!record.adapter || typeof record.adapter.runTurn !== 'function') {
          await cleanupCandidate(adapter, 'invalid_wrapped_adapter');
          throw new Error(`${state.profile} native provider wrapper did not return a runnable adapter`);
        }
        this._setIdentity(record, record.adapter.identity?.() || adapter.identity?.() || record.adapter);
        record.status = 'running';
        this._emit('sidepanel:run-updated', record, { reason: 'started' });
        record.execution = this._drive(record).catch((error) => this._fail(record, error));
      } catch (error) {
        startupError = error;
        if (!candidateAccepted) {
          if (candidate) await cleanupCandidate(candidate, error?.code || 'startup_failed');
          else factoryPromise.then((adapter) => cleanupCandidate(adapter, error?.code || 'startup_failed')).catch(() => {});
        }
        if (failAs === 'interrupted') {
          await this._fail(record, error, 'resume_failed', { status: 'interrupted' });
        } else {
          await this._fail(
            record,
            error,
            error?.code === 'NATIVE_LOOP_PROVIDER_START_TIMEOUT' ? 'provider_startup_timeout' : 'provider_error',
          );
        }
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
    return bootstrap;
  }

  /**
   * Continue a suspended run (a dispatched worker a server restart cut off; assistant-dispatch.js resumeRun) as the
   * same record: its runId, tab, claim, title and startedAt stay, its version keeps growing. The state file is written
   * again at iteration 0 of 1, so the drive runs the run's one task iteration again (the dispatcher's wrapper decides
   * what that turn sends), and the provider factory gets what `state` carries to continue the provider session
   * (resumeSessionId, costBaseUsd). Resolves with the descriptor once the provider started; a provider that cannot
   * start ends the run as interrupted (resume_failed) and the promise rejects with why.
   */
  async resume({ runId, state, buildPrompt = null, wrapAdapter = null } = {}) {
    const record = this.records.get(runId);
    if (!record) throw new Error(`Native loop ${runId} is not known`);
    if (record.status !== 'suspended') throw new Error(`Native loop ${runId} is ${record.status}, not suspended`);
    if (buildPrompt !== null && typeof buildPrompt !== 'function') throw new Error('Native loop buildPrompt override must be a function');
    if (wrapAdapter !== null && typeof wrapAdapter !== 'function') throw new Error('Native loop wrapAdapter override must be a function');
    if (!state?.profile || !isNativeLoopProfile(state.profile)) throw new Error(`Unsupported native loop profile: ${state?.profile || 'unknown'}`);
    const factory = this.providerFactories[state.profile];
    if (!factory) throw new Error(`Native provider unavailable: ${state.profile}`);
    this._clearHold(record);
    mkdirSync(this.stateDir, { recursive: true });
    const totalIterations = Number(state.totalIterations) || 1;
    const nativeState = {
      ...toolListRecord(state, this.toolListOptions()),
      runId,
      terminalSessionId: runId,
      active: true,
      pending: false,
      driverType: 'native',
      runtimeType: 'native',
      surface: 'sidepanel',
      startedAt: record.startedAt || state.startedAt || iso(this.now()),
      currentIteration: 0,
      totalIterations,
    };
    this._writeState(runId, nativeState);
    Object.assign(record, {
      status: 'starting',
      stoppedReason: null,
      completedAt: null,
      error: null,
      adapter: null,
      timer: null,
      execution: null,
      stopping: false,
      startupAbortController: new AbortController(),
      turnState: 'starting',
      currentIteration: 0,
      totalIterations,
      browserSessionId: state.browserSessionId || null,
      browserTabId: state.browserTabId || null,
      suspendedAt: null,
      suspendReason: null,
      resumes: (Number(record.resumes) || 0) + 1,
      resumedAt: iso(this.now()),
      buildPrompt,
      wrapAdapter,
    });
    record.identityPromise = new Promise((resolveIdentity) => { record._resolveIdentity = resolveIdentity; });
    record.startupCancelPromise = new Promise((resolveCancel) => { record._cancelStartup = resolveCancel; });
    this._emit('sidepanel:run-updated', record, { reason: 'resuming' });
    await this._bootstrap(record, factory, nativeState, { profile: state.profile, failAs: 'interrupted' });
    return cleanDescriptor(record);
  }

  /** The hold of a run the restart cut off: it ends as interrupted when nobody resumes it in time. */
  _hold(record) {
    this._clearHold(record);
    const timer = setTimeout(() => {
      this._holdTimers.delete(record.runId);
      this.endSuspended(record.runId, record.suspendReason || 'server_restart').catch(() => {});
    }, this.resumeHoldMs);
    timer.unref?.();
    this._holdTimers.set(record.runId, timer);
  }

  _clearHold(record) {
    const timer = this._holdTimers.get(record?.runId);
    if (timer) { clearTimeout(timer); this._holdTimers.delete(record.runId); }
  }

  /** Whether a run waits for its resume after a restart (suspended). */
  isSuspended(runId) {
    return this.records.get(runId)?.status === 'suspended';
  }

  /**
   * The dispatcher takes a suspended run over (it resumes it or ends it itself): its hold no longer ends it.
   * Returns whether the run is suspended.
   */
  keepSuspended(runId) {
    const record = this.records.get(runId);
    if (!record || record.status !== 'suspended') return false;
    this._clearHold(record);
    return true;
  }

  /**
   * A suspended run that will not be resumed ends as interrupted (`reason`, by default why it was suspended), with an
   * event, so a tab that waited for its resume shows how it ended. `error`: why it was not resumed.
   */
  async endSuspended(runId, reason = null, { error = null } = {}) {
    const record = this.records.get(runId);
    if (!record || record.status !== 'suspended') return false;
    this._clearHold(record);
    record.status = 'interrupted';
    record.stoppedReason = reason || record.suspendReason || 'server_restart';
    record.completedAt = iso(this.now());
    if (error) record.error = String(error);
    this._writeTerminalState(record, { active: false, pending: false, completedAt: record.completedAt, stoppedReason: record.stoppedReason, ...(error ? { error: record.error } : {}) });
    this._releaseRuntimeRefs(record);
    this._emit('sidepanel:run-stopped', record);
    try { await this.onFinish(cleanDescriptor(record)); } catch {}
    return true;
  }

  /**
   * Suspend a running dispatched worker for a server shutdown (shutdown's `keep`): its CLI is ended (the adapter's
   * dispose with terminate), its state file stays active, and the record waits as suspended for the next start to
   * resume it. No run-stopped event and no end: a run-updated with the reason 'suspended'.
   */
  async suspend(runId, reason = 'server_shutdown') {
    const record = this.records.get(runId);
    if (!record || !['starting', 'running'].includes(record.status) || record.stopping) return false;
    record.stopping = true;
    clearTimeout(record.timer);
    record.status = 'suspended';
    record.suspendedAt = iso(this.now());
    record.suspendReason = reason;
    if (record._resolveIdentity) { record._resolveIdentity(null); record._resolveIdentity = null; }
    try { record.startupAbortController?.abort(reason); } catch {}
    if (record._cancelStartup) { record._cancelStartup(reason); record._cancelStartup = null; }
    try { await record.adapter?.dispose?.({ preserveSession: true, terminate: true }); } catch {}
    this._releaseRuntimeRefs(record, { turnState: 'suspended' });
    record.stopping = false;
    this._emit('sidepanel:run-updated', record, { reason: 'suspended' });
    return true;
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
      if (record.runMode !== 'task' && elapsed >= Math.max(1, Number(state.maxMinutes) || 30) * 60_000) {
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
        const prompt = (record.buildPrompt || this.buildPrompt)(nextState, iteration);
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
        // Not after the final iteration: the run ends anyway, so a judgment could save nothing.
        if (this.judgeGoal && !(total > 0 && iteration >= total)) {
          let verdict = null;
          try { verdict = await this.judgeGoal(fresh, result, { iteration, total, runId: record.runId }); } catch { verdict = null; }
          if (verdict?.met) {
            this.log(record.runId, 'native:goal-met', 'loop ended early: task judged complete', { iteration, total, probability: verdict.probability });
            await this._complete(record, 'goal_met');
            return;
          }
        }
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

  _releaseRuntimeRefs(record, { turnState = 'terminal' } = {}) {
    if (!record) return;
    record.adapter = null;
    record.timer = null;
    record.execution = null;
    record.identityPromise = null;
    record._resolveIdentity = null;
    record.startupCancelPromise = null;
    record._cancelStartup = null;
    record.startupAbortController = null;
    record.buildPrompt = null;
    record.wrapAdapter = null;
    if (turnState === 'suspended') record.turnState = 'suspended';
    else if (record.turnState && record.turnState !== 'terminal') record.turnState = 'terminal';
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

  /** `status`: 'failed', or 'interrupted' for a resume that could not start (reason resume_failed). */
  async _fail(record, error, reason = 'provider_error', { status = 'failed' } = {}) {
    if (!record || ['completed', 'failed', 'stopped', 'interrupted', 'suspended'].includes(record.status)) return;
    clearTimeout(record.timer);
    record.status = status === 'interrupted' ? 'interrupted' : 'failed';
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
    this._emit(record.status === 'interrupted' ? 'sidepanel:run-stopped' : 'sidepanel:run-failed', record);
    try { await this.onFinish(cleanDescriptor(record)); } catch {}
  }

  /**
   * `terminate` (a server shutdown): the provider's process is ended at once (the Claude adapter's dispose), never
   * left to finish its tool call after the server is gone. A suspended run (waiting for its resume) ends as stopped.
   */
  async stop(runId, reason = 'user', { terminate = false } = {}) {
    const record = this.records.get(runId);
    if (record?.status === 'suspended' && !record.stopping) {
      this._clearHold(record);
      record.status = 'stopped';
      record.stoppedReason = reason;
      record.completedAt = iso(this.now());
      this._writeTerminalState(record, { active: false, pending: false, completedAt: record.completedAt, stoppedReason: reason });
      this._releaseRuntimeRefs(record);
      this._emit('sidepanel:run-stopped', record);
      try { await this.onFinish(cleanDescriptor(record)); } catch {}
      return true;
    }
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
    try { await record.adapter?.dispose?.({ preserveSession: true, ...(terminate ? { terminate: true } : {}) }); } catch {}
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

  setTools(runId, tools) {
    const record = this.records.get(runId);
    if (!record) return null;
    if (!Array.isArray(tools)) throw Object.assign(new Error('tools must be an array'), { code: 'TOOLS_INVALID', status: 400 });
    const normalized = storedToolList({ tools: retainExternalRefs(tools, record.tools) });
    if (JSON.stringify(record.tools) === JSON.stringify(normalized)) return cleanDescriptor(record);
    record.tools = normalized;
    delete record.mcpProfile;
    try {
      const state = this._readState(record.runId);
      if (state) this._writeState(record.runId, { ...state, tools: normalized });
    } catch (error) {
      this.log(record.runId, 'native:state-write-error', error?.message || String(error));
    }
    return this._emit('sidepanel:run-updated', record, { reason: 'mcp-tools' });
  }

  get(runId) {
    const record = this.records.get(runId);
    return record ? cleanDescriptor(record) : null;
  }

  list({ activeOnly = false } = {}) {
    return [...this.records.values()]
      .filter((record) => !activeOnly || LIVE_STATUSES.has(record.status))
      .map(cleanDescriptor)
      .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  }

  /**
   * The server is going down. `keep`: the runs its dispatcher suspends to resume on the next start
   * (assistant-dispatch.js suspendForShutdown); every other running run is stopped. Either way each provider process
   * is ended now (terminate), so nothing outlives the server. A run still waiting for its resume stays suspended.
   */
  async shutdown(reason = 'server_shutdown', { keep = [] } = {}) {
    const kept = new Set((Array.isArray(keep) ? keep : []).map(String));
    await Promise.allSettled([...this.records.values()]
      .filter((record) => ['starting', 'running'].includes(record.status))
      .map((record) => (kept.has(record.runId) ? this.suspend(record.runId, reason) : this.stop(record.runId, reason, { terminate: true }))));
    for (const timer of this._holdTimers.values()) clearTimeout(timer);
    this._holdTimers.clear();
    this._persistLedger({ force: true });
  }
}
