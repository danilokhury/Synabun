// Playwright context.route(), even with a narrow matcher, enables Fetch("*")
// AND disables HTTP cache on every target. Keep our safety rules on a separate
// CDP client with native, selective Fetch patterns. Never change cache, Runtime,
// identity, emulation, or page scripts here. Unmatched requests stay in Chromium.
//
// Auto-attach pauses new pages, OOPIFs and workers so
// their FIRST request is guarded too. Closing this client releases its sessions;
// it never closes a user's target or browser.
//
// Faults are per target first. A target is protected once its Fetch rules are in
// place; releasing it (Runtime.runIfWaitingForDebugger) is not part of that, and its
// reply comes from the target itself once it actually runs: Chromium holds a new
// service worker until EVERY auto-attached CDP client has released it, and does not
// answer a stopped worker's Runtime commands until it runs again. A slow or silent
// reply is therefore never a fault. A paused service/shared worker whose rules cannot
// be installed stays paused and is retried; pages, frames, dedicated workers and
// targets already running still fail closed for the whole context, and a faulted
// context re-arms with a fresh attachment (recoverBrowserNetworkGuard).
import { connectGuardCdp } from './browser-guard-cdp.js';
const guards = new WeakMap();
const endpoints = new WeakMap();
const legacyRules = new WeakMap();
const FILTER = ['page', 'iframe', 'worker', 'shared_worker', 'service_worker'].map(type => ({ type }));
const AUTO = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: FILTER };
const gone = error => /closed|detached|No session|No target|Target.*not found|Session with given id not found/i.test(error?.message || '');
const expiredRequest = error => /^Fetch\.(?:continueRequest|failRequest)$/.test(error?.method || '')
  && /Invalid InterceptionId|Invalid interception id/i.test(error.message);
// Workers whose own requests only their own Fetch rules intercept. Dedicated workers
// are intercepted by their owning page or frame instead.
const OWN_FETCH_WORKERS = new Set(['service_worker', 'shared_worker']);
const TIMING = {
  quarantineRetryMs: [1000, 5000, 15000, 60000], // the last delay repeats while the worker exists
  rearmBackoffMs: [2000, 5000, 15000, 30000, 60000], // after a failed re-arm; the last repeats
  recoverTimeoutMs: 10000, // the longest a caller waits for one re-arm
};
export const NETWORK_GUARD_FAULT_EVENT = 'synabun-network-guard-fault';
export const NETWORK_GUARD_RECOVERED_EVENT = 'synabun-network-guard-recovered';

/** Register only externally owned Chromium contexts with an existing endpoint. */
export function registerBrowserNetworkEndpoint(context, endpoint, { connect = connectGuardCdp, timing } = {}) {
  endpoints.set(context, { endpoint, connect, timing: { ...TIMING, ...timing } });
}

export function usesNativeBrowserNetworkGuard(context) { return endpoints.has(context); }

/** One flattened CDP connection and every session it holds. Re-arming replaces it whole. */
class GuardLink {
  constructor(guard) {
    this.guard = guard;
    this.children = new Map();
    this.installing = new Set();
    this.timers = new Set();
    this.fault = null;
    this.closed = false;
  }
  /** A fault of this link. It is the context's fault only while this link is the current one. */
  failed(error) {
    if (this.closed) return;
    this.fault ||= error;
    if (this.guard.link === this) this.guard.fault = error;
  }
  later(delay, work) {
    if (this.closed) return;
    const timer = setTimeout(() => { this.timers.delete(timer); if (!this.closed) work(); }, delay);
    timer.unref?.();
    this.timers.add(timer);
  }
  async open() {
    const { endpoint, connect } = endpoints.get(this.guard.context);
    this.connecting = connect(endpoint);
    this.root = await this.connecting;
    if (this.closed) { await this.root.detach(); throw new Error('Network guard disposed during setup'); }
    this.root.on('event', event => this.dispatch(event.sessionId ? this.children.get(event.sessionId) : this.root, event.method, event.params));
    this.root.on('close', () => {
      if (this.closed) return;
      this.failed(new Error('Network guard CDP disconnected; reconnect the browser session'));
      // Cancel pending automation and refuse subsequent actions until a fresh
      // protected attachment exists. Never reinstate context.route on MoreLogin:
      // it would mutate unrelated native traffic and cache even during teardown.
      console.error('[browser-network-guard] CDP disconnected; browser automation refused until the guard re-arms');
    });
    // A page-target attachment can arrive after a popup's initial navigation
    // has started (another CDP client may resume it). The browser Fetch domain
    // closes that gap for selective Document requests only. Attribute each to
    // this profile before deciding; never apply rules to a foreign context.
    await this.configure(this.root);
    await this.root.send('Target.setAutoAttach', AUTO);
    while (this.installing.size) await Promise.all([...this.installing]);
    if (this.fault) throw this.fault;
  }
  async configure(child) {
    // Dedicated workers have no Fetch domain in Chromium. Their requests are
    // intercepted by the owning page/frame (also for nested workers), as in
    // Playwright's CRNetworkManager workerFrame path. Never resume a worker
    // until that parent's current selective guard is installed.
    if (child.target?.type === 'worker') {
      if (!child.parent?.guarded || child.parent.quarantined || !child.parent.configuration) {
        throw new Error(`Network guard worker ${child.target.targetId} has no protected network parent`);
      }
      await child.parent.configuration;
      return;
    }
    const patterns = this.guard.patterns().map(pattern => child === this.root ? { ...pattern, resourceType: 'Document' } : pattern);
    await child.send(patterns.length ? 'Fetch.enable' : 'Fetch.disable', patterns.length ? { patterns } : {});
  }
  /** Rules in place for the target and for what it starts next. */
  async protect(child) {
    await (child.configuration = this.configure(child));
    if (this.closed) return;
    await child.send('Target.setAutoAttach', AUTO);
    child.protected = true;
  }
  /** Release a target this client holds paused. Never awaited and never a fault: the
   * reply comes from the target once it actually runs, which another CDP client of the
   * profile, or a stopped service worker, can delay indefinitely. The target's rules are
   * already in place, so its requests are guarded whenever it runs. */
  resume(child) {
    child.send('Runtime.runIfWaitingForDebugger').catch(error => {
      if (this.closed || gone(error)) return;
      console.warn(`[browser-network-guard] ${error.message}; the target keeps its rules and runs when Chromium releases it`);
    });
  }
  /** Whether a failed command's target is gone, which is no fault. A reply can be lost
   * while its target is destroyed, so a timeout asks the browser before deciding. */
  async vanished(child, error) {
    if (this.closed || gone(error) || this.children.get(child.id) !== child) return true;
    try {
      const { targetInfo } = await this.root.send('Target.getTargetInfo', { targetId: child.target.targetId });
      return !targetInfo;
    } catch (probe) {
      return /No target with given id/i.test(probe.protocolMessage || probe.message);
    }
  }
  /** A paused service/shared worker whose rules could not be installed. Nothing else
   * intercepts its requests, so it must not run unprotected: keep holding it paused
   * (no other target is affected), retry, and release it once its rules are in place. */
  quarantine(child, error, attempt = 0) {
    child.quarantined = error;
    const delays = this.guard.timing.quarantineRetryMs;
    const delay = delays[Math.min(attempt, delays.length - 1)];
    if (!attempt) console.error(`[browser-network-guard] ${error.message}; this worker stays paused, retrying its protection`);
    this.later(delay, async () => {
      if (this.children.get(child.id) !== child) return;
      try {
        await this.protect(child);
      } catch (retryError) {
        if (await this.vanished(child, retryError)) return;
        this.quarantine(child, retryError, attempt + 1);
        return;
      }
      if (this.closed) return;
      child.quarantined = null;
      console.warn(`[browser-network-guard] worker ${child.target.targetId} protected after ${attempt + 1} retr${attempt ? 'ies' : 'y'}; releasing it`);
      this.resume(child);
    });
  }
  async ownsDocument(frameId) {
    try {
      const { targetInfo } = await this.root.send('Target.getTargetInfo', { targetId: frameId });
      return targetInfo.browserContextId === this.guard.contextId;
    } catch (error) {
      // Same-process subframes have frame IDs, but no separate Target. Find
      // their owning protected page; unrelated incognito frames stay native.
      if (!/No target with given id found/i.test(error.message)) throw error;
      const contains = tree => tree.frame.id === frameId || tree.childFrames?.some(contains);
      let uncertain = false;
      for (const child of this.children.values()) {
        if (!child.guarded || !['page', 'iframe'].includes(child.target.type)) continue;
        try {
          if (contains((await child.send('Page.getFrameTree')).frameTree)) return true;
        } catch (treeError) { if (!gone(treeError)) uncertain = true; }
      }
      // A protected page that cannot list its frames may hold this one. Decide it as
      // the profile's (the stricter answer) instead of faulting every tab.
      return uncertain;
    }
  }
  dispatch(parent, method, event) {
    if (this.closed) return;
    if (method === 'Target.attachedToTarget') {
      const child = {
        id: event.sessionId, parent, target: event.targetInfo,
        send: async (method, params) => {
          try { return await this.root.send(method, params, event.sessionId); }
          catch (error) {
            Object.assign(error, { method, targetType: child.target.type, targetId: child.target.targetId,
              parentTargetType: parent?.target?.type, parentTargetId: parent?.target?.targetId });
            error.message = `${method} [target=${child.target.type}:${child.target.targetId}, session=${child.id}, parent=${parent?.target?.type || 'browser'}:${parent?.target?.targetId || 'root'}]: ${error.protocolMessage || error.message}`;
            throw error;
          }
        },
        close: () => this.root.rejectSession(event.sessionId),
      };
      this.children.set(event.sessionId, child);
      const installing = this.attach(child, event).catch(error => {
        if (!gone(error)) {
          this.failed(error);
          // Do not resume an unguarded new target. Existing user tabs are never
          // closed. Tool operations fail until the guard re-arms.
          console.error('[browser-network-guard] target protection failed:', error.message);
        }
      }).finally(() => this.installing.delete(installing));
      this.installing.add(installing);
    } else if (method === 'Target.detachedFromTarget') {
      this.children.get(event.sessionId)?.close();
      this.children.delete(event.sessionId);
    } else if (method === 'Fetch.requestPaused') {
      if (!parent) return; // event queued before this target's detach arrived
      void this.request(parent, event).catch(error => {
        if (!gone(error)) { this.failed(error); console.error('[browser-network-guard] request refused after guard failure:', error.message); }
      });
    } else if (method === 'Inspector.targetReloadedAfterCrash') {
      // A stopped service worker that runs again keeps this session and its rules.
      // Release it as Playwright does, so this client never holds it.
      if (parent?.protected && !parent.quarantined) this.resume(parent);
    }
  }
  async attach(child, event) {
    if (this.closed) return;
    const waiting = !!event.waitingForDebugger;
    const inherited = !event.targetInfo.browserContextId && child.parent?.guarded;
    if (event.targetInfo.browserContextId !== this.guard.contextId && !inherited) {
      // A browser-level CDP connection also sees other incognito contexts. Our
      // session there intercepts nothing: releasing it is never this profile's fault.
      if (waiting) this.resume(child);
      await child.parent.send('Target.detachFromTarget', { sessionId: child.id }).catch(error => {
        if (!gone(error)) console.warn('[browser-network-guard] could not release a foreign target:', error.message);
      });
      return;
    }
    child.guarded = true;
    try {
      await this.protect(child);
    } catch (error) {
      if (await this.vanished(child, error)) return;
      if (waiting && OWN_FETCH_WORKERS.has(child.target.type)) { this.quarantine(child, error); return; }
      // Pages, frames, dedicated workers and anything already running fail closed.
      throw error;
    }
    if (this.closed) return;
    // Only a target that waits for us is released; a running or stopped one is not.
    if (waiting) this.resume(child);
  }
  async request(child, event) {
    const { requestId, request } = event;
    try {
      const fault = this.fault || this.guard.fault;
      if (fault) throw fault;
      if (child === this.root && !await this.ownsDocument(event.frameId)) {
        await child.send('Fetch.continueRequest', { requestId });
        return;
      }
      let headers;
      for (const rule of this.guard.rules.values()) {
        const decision = rule.decide(request);
        if (decision?.abort) {
          await child.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
          return;
        }
        if (decision?.headers) headers = { ...headers, ...decision.headers };
      }
      const params = { requestId };
      if (headers) {
        const replacements = new Set(Object.keys(headers).map(name => name.toLowerCase()));
        params.headers = Object.entries(request.headers).filter(([name]) => !replacements.has(name.toLowerCase()))
          .concat(Object.entries(headers)).map(([name, value]) => ({ name, value: String(value) }));
      }
      await child.send('Fetch.continueRequest', params);
    } catch (error) {
      // A navigation/closed tab can retire the request before continue/fail is
      // processed. These protocol replies do not invalidate other targets.
      if (gone(error) || expiredRequest(error)) return;
      // Never continue without a required financial/local marker decision.
      await child.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      throw error;
    }
  }
  /** Current rules onto every protected target of this link. */
  async reconfigure() {
    await this.configure(this.root);
    // A quarantined worker takes the current rules on its next retry.
    await Promise.all([...this.children.values()].filter(child => child.guarded && !child.quarantined).map(async child => {
      try { await (child.configuration = this.configure(child)); }
      catch (error) { if (!await this.vanished(child, error)) throw error; }
    }));
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    // Detaching our browser CDP session also detaches its child sessions and
    // releases paused targets. No Target.closeTarget or Browser.close.
    this.closing = (async () => {
      // Closing may race a handshake. Await and detach that late connection
      // as well; returning early would briefly leave a new client attached.
      if (!this.root && this.connecting) this.root = await this.connecting.catch(() => null);
      await this.root?.detach().catch(() => {});
      for (const child of this.children.values()) child.close();
      this.children.clear();
    })();
    return this.closing;
  }
}

class ContextGuard {
  get fault() { return this._fault; }
  set fault(error) {
    if (this.disposed) return;
    this._fault = error;
    if (error) {
      this.context.__browserNetworkGuardError = error.message;
      this.context.emit?.(NETWORK_GUARD_FAULT_EVENT, error.message);
    }
  }
  constructor(context) {
    this.context = context;
    this.timing = endpoints.get(context)?.timing || TIMING;
    this.rules = new Map();
    this.fault = null;
    this.queue = Promise.resolve();
    this.rearmFailures = 0;
    this.rearmAt = 0;
  }
  patterns() {
    return [...new Set([...this.rules.values()].flatMap(rule => rule.patterns))].map(urlPattern => ({ urlPattern, requestStage: 'Request' }));
  }
  async start() {
    this.onContextClose = () => { void this.dispose(); };
    this.onBrowserDisconnect = () => { void this.dispose(); };
    this.context.once('close', this.onContextClose);
    this.context.browser().once('disconnected', this.onBrowserDisconnect);
    const page = this.context.pages().find(page => !page.isClosed());
    if (!page) throw new Error('Network guard requires the attachment tab');
    const probe = await this.context.newCDPSession(page);
    try { this.contextId = (await probe.send('Target.getTargetInfo')).targetInfo.browserContextId; }
    finally { await probe.detach(); }
    if (this.disposed) throw new Error('Network guard disposed during setup');
    this.link = new GuardLink(this);
    await this.link.open();
  }
  async update(key, rule) {
    if (this.disposed) throw new Error('Network guard disposed');
    if (this.fault) throw this.fault;
    if (rule) this.rules.set(key, rule); else this.rules.delete(key);
    if (!this.ready) this.ready = this.start().catch(async error => { await this.dispose(); throw error; });
    await this.ready;
    await this.link.reconfigure();
  }
  /** Re-arm a faulted guard; resolves true once the context is protected again. One
   * attempt at a time, in order with rule updates, and none during the backoff that
   * follows a failed one. */
  rearm() {
    if (this.disposed || !this.link) return Promise.resolve(false);
    if (!this.fault) return Promise.resolve(true);
    if (this.rearming) return this.rearming;
    if (Date.now() < this.rearmAt) return Promise.resolve(false);
    const attempt = this.queue.then(() => this.replaceLink());
    this.queue = attempt.catch(() => {});
    this.rearming = attempt.catch(() => false).finally(() => { this.rearming = null; });
    return this.rearming;
  }
  async replaceLink() {
    if (this.disposed) return false;
    if (!this.fault) return true;
    // The faulted link stays attached (failing its own paused requests closed) until
    // the fresh one has every current target protected, so no target is ever left
    // without an attachment holding its rules.
    const fresh = this.pendingLink = new GuardLink(this);
    try {
      await fresh.open();
    } catch (error) {
      await fresh.close();
      const delays = this.timing.rearmBackoffMs;
      this.rearmAt = Date.now() + delays[Math.min(this.rearmFailures++, delays.length - 1)];
      console.error('[browser-network-guard] re-arm failed; actions stay refused:', error.message);
      return false;
    } finally { this.pendingLink = null; }
    if (this.disposed) { await fresh.close(); return false; }
    const old = this.link;
    this.link = fresh;
    this.rearmFailures = 0;
    this.rearmAt = 0;
    this._fault = null;
    delete this.context.__browserNetworkGuardError;
    this.context.emit?.(NETWORK_GUARD_RECOVERED_EVENT);
    console.warn('[browser-network-guard] re-armed with a fresh protected attachment');
    await old.close();
    return true;
  }
  dispose() {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    if (this.onContextClose) this.context.removeListener('close', this.onContextClose);
    if (this.onBrowserDisconnect) this.context.browser().removeListener('disconnected', this.onBrowserDisconnect);
    this.disposal = (async () => {
      await Promise.all([this.link?.close(), this.pendingLink?.close()]);
      if (guards.get(this.context) === this) guards.delete(this.context);
    })();
    return this.disposal;
  }
}

/** Re-arm a faulted native guard: a fresh protected attachment replaces the broken one,
 * so the context needs no server restart. Resolves true when the context is protected
 * (again), false while its actions stay refused. Never rejects. */
export async function recoverBrowserNetworkGuard(context, { timeoutMs } = {}) {
  const guard = guards.get(context);
  if (!guard) return !context?.__browserNetworkGuardError;
  let timer;
  try {
    return await Promise.race([
      guard.rearm(),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs ?? guard.timing.recoverTimeoutMs); timer.unref?.(); }),
    ]);
  } catch { return false; }
  finally { clearTimeout(timer); }
}

/** Explicitly release only this context's safety transport, including failed setup. */
export async function disposeBrowserNetworkGuard(context) {
  await guards.get(context)?.dispose();
}

/** Add/remove a named rule. Decisions compose: an abort always wins over headers. */
export function setBrowserNetworkRule(context, key, rule) {
  if (!context) return Promise.reject(new Error('Network guard needs a browser context'));
  if (rule && (!rule.patterns?.length || rule.patterns.some(pattern => pattern === '*' || pattern === '*://*/*'))) {
    return Promise.reject(new Error('Network guard requires selective URL patterns'));
  }
  // Managed browsers retain their established Playwright guards. MoreLogin is
  // registered at attachment and MUST use the native transport; a failure there
  // rejects setup rather than silently falling back to wildcard interception.
  if (!endpoints.has(context)) return setManagedBrowserRule(context, key, rule);
  let guard = guards.get(context);
  if (!guard) { guard = new ContextGuard(context); guards.set(context, guard); }
  const updated = guard.queue.then(() => guard.update(key, rule));
  guard.queue = updated.catch(error => { guard.fault = error; });
  return updated;
}

async function setManagedBrowserRule(context, key, rule) {
  let entries = legacyRules.get(context);
  if (!entries) { entries = new Map(); legacyRules.set(context, entries); }
  const old = entries.get(key);
  if (old) { await context.unroute(old); entries.delete(key); }
  if (!rule) return;
  const matches = url => !!rule.decide({ url: url.href });
  await context.route(matches, async route => {
    const decision = rule.decide({ url: route.request().url() });
    if (decision?.abort) return route.abort('blockedbyclient');
    if (decision?.headers) return route.fallback({ headers: { ...await route.request().allHeaders(), ...decision.headers } });
    return route.fallback();
  });
  entries.set(key, matches);
}

// A serve may start at any time. Inspect explicit ports only, then decide using
// the CURRENT live-port set. Default-port public HTTPS never enters Fetch.
export const SERVE_PORT_PATTERNS = ['*://*:*/*'];
// Include authority spellings (trailing dot / explicit port) the exact existing
// regex already matches. The decide predicate still determines every abort.
export const MONEY_PATTERNS = ['*://*.facebook.com*/*', '*://facebook.com*/*'];

/** Native URL patterns covering isLocalMarkerHost, with the exact check in decide. */
export function localMarkerPatterns(hostNames = []) {
  const hosts = ['localhost*', '*.localhost*', '127.*', '10.*', '0.*', '192.168.*', '169.254.*', '[*]'];
  for (let n = 16; n <= 31; n++) hosts.push(`172.${n}.*`);
  for (let n = 64; n <= 127; n++) hosts.push(`100.${n}.*`);
  for (const raw of hostNames) {
    const name = String(raw).toLowerCase().replace(/\.+$/, '').replace(/\.local$/, '');
    // DNS names only; never turn an untrusted machine name into a wildcard.
    if (/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/.test(name)) hosts.push(`${name}*`, `${name}.local*`);
  }
  return [...new Set(hosts)].flatMap(host => [`*://${host}/*`, `*://${host}:*/*`]);
}
