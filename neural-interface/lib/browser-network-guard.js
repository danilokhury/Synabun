// Playwright context.route(), even with a narrow matcher, enables Fetch("*")
// AND disables HTTP cache on every target. Keep our safety rules on a separate
// CDP client with native, selective Fetch patterns. Never change cache, Runtime,
// identity, emulation, or page scripts here. Unmatched requests stay in Chromium.
//
// Auto-attach pauses new pages, OOPIFs and workers so
// their FIRST request is guarded too. Closing this client releases its sessions;
// it never closes a user's target or browser.
import { connectGuardCdp } from './browser-guard-cdp.js';
const guards = new WeakMap();
const endpoints = new WeakMap();
const legacyRules = new WeakMap();
const FILTER = ['page', 'iframe', 'worker', 'shared_worker', 'service_worker'].map(type => ({ type }));
const AUTO = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: FILTER };
const gone = error => /closed|detached|No session|No target|Target.*not found|Session with given id not found/i.test(error?.message || '');
const expiredRequest = error => /^Fetch\.(?:continueRequest|failRequest)$/.test(error?.method || '')
  && /Invalid InterceptionId|Invalid interception id/i.test(error.message);
export const NETWORK_GUARD_FAULT_EVENT = 'synabun-network-guard-fault';

/** Register only externally owned Chromium contexts with an existing endpoint. */
export function registerBrowserNetworkEndpoint(context, endpoint, { connect = connectGuardCdp } = {}) {
  endpoints.set(context, { endpoint, connect });
}

export function usesNativeBrowserNetworkGuard(context) { return endpoints.has(context); }

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
    this.rules = new Map();
    this.children = new Map();
    this.installing = new Set();
    this.fault = null;
    this.queue = Promise.resolve();
  }
  patterns() {
    return [...new Set([...this.rules.values()].flatMap(rule => rule.patterns))].map(urlPattern => ({ urlPattern, requestStage: 'Request' }));
  }
  async configure(child) {
    // Dedicated workers have no Fetch domain in Chromium. Their requests are
    // intercepted by the owning page/frame (also for nested workers), as in
    // Playwright's CRNetworkManager workerFrame path. Never resume a worker
    // until that parent's current selective guard is installed.
    if (child.target?.type === 'worker') {
      if (!child.parent?.guarded || !child.parent.configuration) {
        throw new Error(`Network guard worker ${child.target.targetId} has no protected network parent`);
      }
      await child.parent.configuration;
      return;
    }
    const patterns = this.patterns().map(pattern => child === this.root ? { ...pattern, resourceType: 'Document' } : pattern);
    await child.send(patterns.length ? 'Fetch.enable' : 'Fetch.disable', patterns.length ? { patterns } : {});
  }
  async ownsDocument(frameId) {
    try {
      const { targetInfo } = await this.root.send('Target.getTargetInfo', { targetId: frameId });
      return targetInfo.browserContextId === this.contextId;
    } catch (error) {
      // Same-process subframes have frame IDs, but no separate Target. Find
      // their owning protected page; unrelated incognito frames stay native.
      if (!/No target with given id found/i.test(error.message)) throw error;
      const contains = tree => tree.frame.id === frameId || tree.childFrames?.some(contains);
      for (const child of this.children.values()) {
        if (!child.guarded || !['page', 'iframe'].includes(child.target.type)) continue;
        try {
          if (contains((await child.send('Page.getFrameTree')).frameTree)) return true;
        } catch (error) { if (!gone(error)) throw error; }
      }
      return false;
    }
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
    const { endpoint, connect } = endpoints.get(this.context);
    this.connecting = connect(endpoint);
    this.root = await this.connecting;
    if (this.disposed) { await this.root.detach(); throw new Error('Network guard disposed during setup'); }
    this.root.on('event', event => this.dispatch(event.sessionId ? this.children.get(event.sessionId) : this.root, event.method, event.params));
    this.root.on('close', () => {
      if (this.disposed) return;
      this.fault = new Error('Network guard CDP disconnected; reconnect the browser session');
      // Cancel pending automation and refuse subsequent actions until a fresh
      // protected attachment exists. Never reinstate context.route on MoreLogin:
      // it would mutate unrelated native traffic and cache even during teardown.
      console.error('[browser-network-guard] CDP disconnected; browser automation disabled until reconnection');
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
  dispatch(parent, method, event) {
    if (this.disposed) return;
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
          this.fault = error;
          // Do not resume an unguarded new target. Existing user tabs are never
          // closed. Future tool operations fail until a clean reconnect.
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
        if (!gone(error)) { this.fault = error; console.error('[browser-network-guard] request refused after guard failure:', error.message); }
      });
    }
  }
  async attach(child, event) {
    if (this.disposed) return;
    const inherited = !event.targetInfo.browserContextId && child.parent?.guarded;
    if (event.targetInfo.browserContextId !== this.contextId && !inherited) {
      // A browser-level CDP connection also sees other incognito contexts.
      if (event.waitingForDebugger) await child.send('Runtime.runIfWaitingForDebugger');
      await child.parent.send('Target.detachFromTarget', { sessionId: child.id });
      return;
    }
    child.guarded = true;
    await (child.configuration = this.configure(child));
    if (this.disposed) return;
    await child.send('Target.setAutoAttach', AUTO);
    await child.send('Runtime.runIfWaitingForDebugger');
  }
  async request(child, event) {
    const { requestId, request } = event;
    try {
      if (this.fault) throw this.fault;
      if (child === this.root && !await this.ownsDocument(event.frameId)) {
        await child.send('Fetch.continueRequest', { requestId });
        return;
      }
      let headers;
      for (const rule of this.rules.values()) {
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
  async update(key, rule) {
    if (this.disposed) throw new Error('Network guard disposed');
    if (this.fault) throw this.fault;
    if (rule) this.rules.set(key, rule); else this.rules.delete(key);
    if (!this.ready) this.ready = this.start().catch(async error => { await this.dispose(); throw error; });
    await this.ready;
    await this.configure(this.root);
    await Promise.all([...this.children.values()].filter(child => child.guarded).map(child =>
      (child.configuration = this.configure(child)).catch(error => { if (!gone(error)) throw error; })));
  }
  dispose() {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    if (this.onContextClose) this.context.removeListener('close', this.onContextClose);
    if (this.onBrowserDisconnect) this.context.browser().removeListener('disconnected', this.onBrowserDisconnect);
    // Detaching our browser CDP session also detaches its child sessions and
    // releases paused targets. No Target.closeTarget or Browser.close.
    this.disposal = (async () => {
      // Disposal may race a handshake. Await and detach that late connection
      // as well; returning early would briefly leave a new client attached.
      if (!this.root && this.connecting) this.root = await this.connecting.catch(() => null);
      await this.root?.detach().catch(() => {});
      for (const child of this.children.values()) child.close();
      this.children.clear();
      if (guards.get(this.context) === this) guards.delete(this.context);
    })();
    return this.disposal;
  }
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
