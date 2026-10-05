// What the Codex runtime of one tab supports. The answer belongs to the tab's
// account and connection (its epoch). An invalidation only marks it stale: the
// last answer stays readable until the re-read lands, so nothing judges support
// from an empty cache. DOM-free; the socket request is injected.
import { capabilityAvailability } from './cdx-commands.js';

// A runtime older than capabilities_read answers it with one of these.
const UNSUPPORTED_READ = /unsupported|unknown|not found|method/i;

const states = new WeakMap();

function stateOf(tab) {
  let state = states.get(tab);
  if (!state) {
    state = { stale: false, read: null };
    states.set(tab, state);
  }
  return state;
}

export function codexCapabilityEpoch(tab) {
  return `${tab?.accountId || 'default'}:${tab?.connectionEpoch || ''}`;
}

/** The last capabilities advertised for the tab's current epoch, fresh or stale. Another epoch's are never returned. */
export function knownCodexCapabilities(tab) {
  if (!tab?.codexCapabilities || tab.codexCapabilitiesEpoch !== codexCapabilityEpoch(tab)) return null;
  return tab.codexCapabilities;
}

/** An answer from the runtime (ready packet, push or read) for the tab's current epoch. */
export function storeCodexCapabilities(tab, capabilities, runtime) {
  if (!tab) return null;
  tab.codexCapabilities = capabilities || {};
  if (runtime !== undefined) tab.codexRuntime = runtime || {};
  tab.codexCapabilitiesEpoch = codexCapabilityEpoch(tab);
  stateOf(tab).stale = false;
  return tab.codexCapabilities;
}

/** The epoch changed (new connection, other account): the old answer must not be reused. */
export function dropCodexCapabilities(tab) {
  if (!tab) return;
  tab.codexCapabilities = null;
  tab.codexCapabilitiesEpoch = '';
  stateOf(tab).stale = true;
}

/** Something happened that may change support. The last answer stays usable until the next read replaces it. */
export function invalidateCodexCapabilities(tab) {
  if (!tab) return;
  if (tab.codexCapabilities && !knownCodexCapabilities(tab)) {
    dropCodexCapabilities(tab);
    return;
  }
  stateOf(tab).stale = true;
}

/**
 * The capabilities current for the tab. A fresh answer resolves at once; a
 * stale or missing one is re-read through `read()`, and every caller that
 * arrives while that read is pending shares it. The socket delivers in order,
 * so an answer that lands after an invalidation is newer than its cause: a
 * storm of invalidations during one read costs no second read.
 */
export function currentCodexCapabilities(tab, read) {
  const state = stateOf(tab);
  const epoch = codexCapabilityEpoch(tab);
  const known = knownCodexCapabilities(tab);
  if (known && !state.stale) return Promise.resolve(known);
  if (state.read?.epoch === epoch) return state.read.promise;
  const pending = { epoch, promise: null };
  pending.promise = (async () => {
    try {
      let result;
      try {
        result = await read();
      } catch (error) {
        if (codexCapabilityEpoch(tab) !== epoch) return currentCodexCapabilities(tab, read);
        // The bridge enforces support on every request, so the last answer is
        // still the best one to show while the read cannot be made.
        const last = knownCodexCapabilities(tab);
        if (last) return last;
        if (!UNSUPPORTED_READ.test(error?.message || '')) throw error;
        result = { capabilities: {} };
      }
      // The tab moved on while the read was out: this answer is another epoch's.
      if (codexCapabilityEpoch(tab) !== epoch) return currentCodexCapabilities(tab, read);
      return storeCodexCapabilities(tab, result?.capabilities, result?.runtime || {});
    } finally {
      if (state.read === pending) state.read = null;
    }
  })();
  state.read = pending;
  return pending.promise;
}

/**
 * One capability-gated request. `capabilities()` resolves the tab's current
 * capabilities, `changed()` returns why the tab is no longer the conversation
 * the caller opened (asked again after the wait), `send()` makes the request.
 */
export async function requestWithCodexCapability({ type, capabilities, changed, send }) {
  const before = changed?.();
  if (before) throw new Error(before);
  let current = null;
  try {
    current = await capabilities();
  } catch (error) {
    // Unreadable capabilities: only the actions every bridge has may go out.
    if (!capabilityAvailability(null, type).supported) throw error;
  }
  const after = changed?.();
  if (after) throw new Error(after);
  const availability = capabilityAvailability(current, type);
  if (!availability.supported) throw new Error(availability.reason || 'Unavailable in this runtime.');
  return send();
}
