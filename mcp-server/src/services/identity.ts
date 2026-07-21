/**
 * Per-caller identity for browser session/tab isolation.
 *
 * Over the HTTP transport, every MCP request runs inside the ONE Neural
 * Interface process — module-level state in neural-interface.ts would be
 * shared by every connected Claude Code instance (CLI windows, sidepanel
 * chats, loops), which is exactly how separately-launched automations ended
 * up competing for the same browser tab. This module gives each caller its
 * own identity object, derived per-request from:
 *
 *   1. X-Synabun-Terminal / X-Synabun-Browser-Session / X-Synabun-Browser-Tab
 *      headers (loops, scheduled loops, sidepanel — injected at launch), or
 *   2. the stateful Mcp-Session-Id (plain CLI windows — unique per Claude
 *      Code process with zero client configuration), or
 *   3. a per-process stdio singleton whose pins read live process.env —
 *      bit-identical to the historical behavior for stdio MCP children
 *      (codex/opencode loops, automation-window agents).
 *
 * The HTTP transport enters the AsyncLocalStorage context around every
 * transport.handleRequest call; stdio never enters it, so getIdentity()
 * falling back to the stdio singleton IS the backward-compat switch.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface PinSet {
  terminalSessionId: string | null;
  browserSessionId: string | null;
  browserTabId: string | null;
}

export interface IdentityState {
  affinitySessionId: string | null;
  interactiveSessionId: string | null;
  interactiveTabId: string | null;
  recoveredSessionId: string | null;
  recoveredTabId: string | null;
  ancestorPinnedSession: string | null;
  ancestorPinnedTab: string | null;
  ancestorPinnedTerminal: string | null;
  ancestorAttempts: number;
}

export interface CallerIdentity {
  key: string;
  source: 'header' | 'mcp-session' | 'stdio';
  /** ownerKey for /api/browser/acquire|release AND the X-Synabun-Terminal
   *  fallback — one field so the routing key and the acquire key can never
   *  drift apart. */
  clientId: string;
  pins: PinSet;
  state: IdentityState;
  lastSeen: number;
}

const emptyState = (): IdentityState => ({
  affinitySessionId: null,
  interactiveSessionId: null,
  interactiveTabId: null,
  recoveredSessionId: null,
  recoveredTabId: null,
  ancestorPinnedSession: null,
  ancestorPinnedTab: null,
  ancestorPinnedTerminal: null,
  ancestorAttempts: 0,
});

const als = new AsyncLocalStorage<CallerIdentity>();
const identities = new Map<string, CallerIdentity>();

// Set by the HTTP transport at mount. Once true, a missing ALS store inside a
// tool handler is a context-propagation bug: degrade to an EPHEMERAL identity
// (costs an extra tab) rather than the shared stdio singleton (cross-talk).
let httpMode = false;
export function markHttpMode(): void { httpMode = true; }

// Lazy stdio singleton — the per-process identity for stdio transports.
// clientId is minted once per process (the old INTERACTIVE_CLIENT_ID); pins
// are read live from process.env by effectivePins(), preserving the exact
// historical env-pin semantics.
let _stdioIdentity: CallerIdentity | null = null;
function stdioIdentity(): CallerIdentity {
  if (!_stdioIdentity) {
    _stdioIdentity = {
      key: 'stdio',
      source: 'stdio',
      clientId: randomUUID(),
      pins: { terminalSessionId: null, browserSessionId: null, browserTabId: null },
      state: emptyState(),
      lastSeen: Date.now(),
    };
  }
  return _stdioIdentity;
}

/** The stdio identity if it was ever created (for exit-hook tab release). */
export function peekStdioIdentity(): CallerIdentity | null {
  return _stdioIdentity;
}

export function isHttpMode(): boolean { return httpMode; }

export function runWithIdentity<T>(identity: CallerIdentity, fn: () => T): T {
  return als.run(identity, fn);
}

export function getIdentity(): CallerIdentity {
  const store = als.getStore();
  if (store) return store;
  if (httpMode) {
    // Propagation bug guard: never hand the shared stdio identity to an HTTP
    // caller. An ephemeral identity wastes a tab at worst — never cross-talk.
    console.error('[identity] missing ALS context in HTTP mode — using ephemeral identity (propagation bug?)');
    const key = `ephemeral-${randomUUID()}`;
    return {
      key,
      source: 'mcp-session',
      clientId: key,
      pins: { terminalSessionId: null, browserSessionId: null, browserTabId: null },
      state: emptyState(),
      lastSeen: Date.now(),
    };
  }
  return stdioIdentity();
}

/** Pins must look like the ids we mint (hex/uuid-ish). Rejects empty strings
 *  and unexpanded template junk like "${SYNABUN_TERMINAL_SESSION}". */
export function sanitizePin(v: string | undefined | null): string | null {
  if (!v) return null;
  return /^[A-Za-z0-9_-]{1,128}$/.test(v) ? v : null;
}

/** Create-or-touch the identity for an HTTP caller. */
export function obtainIdentity(
  key: string,
  opts: { source: 'header' | 'mcp-session'; pins?: Partial<PinSet> }
): CallerIdentity {
  let id = identities.get(key);
  if (!id) {
    id = {
      key,
      source: opts.source,
      clientId: key,
      pins: {
        terminalSessionId: opts.pins?.terminalSessionId ?? null,
        browserSessionId: opts.pins?.browserSessionId ?? null,
        browserTabId: opts.pins?.browserTabId ?? null,
      },
      state: emptyState(),
      lastSeen: Date.now(),
    };
    identities.set(key, id);
  } else {
    // Refresh pins on every request — a loop relaunch may rebind its headers.
    if (opts.pins?.terminalSessionId !== undefined) id.pins.terminalSessionId = opts.pins.terminalSessionId;
    if (opts.pins?.browserSessionId !== undefined) id.pins.browserSessionId = opts.pins.browserSessionId;
    if (opts.pins?.browserTabId !== undefined) id.pins.browserTabId = opts.pins.browserTabId;
    id.lastSeen = Date.now();
  }
  return id;
}

/** Pin resolution: stdio reads live env (historical behavior); HTTP identities
 *  carry pins parsed from their launch headers. */
export function effectivePins(id: CallerIdentity): PinSet {
  if (id.source === 'stdio') {
    return {
      terminalSessionId: process.env.SYNABUN_TERMINAL_SESSION || null,
      browserSessionId: process.env.SYNABUN_BROWSER_SESSION || null,
      browserTabId: process.env.SYNABUN_BROWSER_TAB || null,
    };
  }
  return id.pins;
}

/** The X-Synabun-Terminal value for Neural Interface requests — the server
 *  routes this caller's tab-less browser calls via _tabOwners[terminalId].
 *  Analogue of the old currentTerminalId(): env/header pin → resolved
 *  ancestor terminal → this identity's own client id. */
export function terminalIdFor(id: CallerIdentity): string {
  return effectivePins(id).terminalSessionId || id.state.ancestorPinnedTerminal || id.clientId;
}

// Release hook — registered by neural-interface.ts (which owns the HTTP
// client) to avoid a circular import. Receives the identity whose acquired
// tab should be released server-side.
type ReleaseHook = (id: CallerIdentity) => void;
let releaseHook: ReleaseHook | null = null;
export function setReleaseHook(fn: ReleaseHook): void { releaseHook = fn; }

/**
 * Drop an HTTP identity, releasing its acquired tab if it ever called
 * /api/browser/acquire. Loop tabs are NEVER released here: a loop identity's
 * tab is owned server-side under its terminalSessionId and reaped by
 * /api/loop/stop — interactiveSessionId is only set by acquireInteractive.
 */
export function releaseIdentity(key: string): void {
  const id = identities.get(key);
  if (!id) return;
  if (id.state.interactiveSessionId && releaseHook) {
    try { releaseHook(id); } catch { /* best-effort */ }
  }
  identities.delete(key);
}

export function identityCount(): number { return identities.size; }

const IDENTITY_TTL_MS = parseInt(process.env.SYNABUN_IDENTITY_TTL_MS || '', 10) || 2 * 60 * 60 * 1000;

let sweeperStarted = false;
export function startIdentitySweeper(): void {
  if (sweeperStarted) return;
  sweeperStarted = true;
  const interval = setInterval(() => {
    const now = Date.now();
    let evicted = 0;
    for (const [key, id] of identities) {
      if (now - id.lastSeen > IDENTITY_TTL_MS) {
        releaseIdentity(key);
        evicted++;
      }
    }
    if (evicted > 0) {
      console.error(`[identity] evicted ${evicted} idle identities (${identities.size} remain)`);
    }
  }, 60_000);
  interval.unref();
}
