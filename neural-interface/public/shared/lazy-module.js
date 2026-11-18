// SynaBun — a module the page loads when it is first used instead of at boot (shared/claude-panel-lazy.js and the
// side panel barrels ui-codex-panel.js, ui-opencode-panel-v2.js, ui-antigravity-panel.js, ui-maritaca-panel.js).
//
// The boot used to load every side panel (about 200 modules, 5 MB) before the first frame. They now load on first
// use, or in an idle moment after the page is shown (a launch step, launch-prefetch.js), whichever comes first, so:
//  - every module-level effect of a panel still runs in every session (the Claude, Codex and OpenCode panels prune
//    the stale window keys of closed windows at load "even if the user never opens the panel");
//  - the first open is as quick as before once the idle load has run.
//
// A facade keeps the panel's export names. An async export loads and then calls. A sync export answers from the
// loaded module, or with the answer that is true while the panel is not loaded (a panel that is not loaded is not
// open). Calls made while the load is pending are made in order, after it. An event a panel listens to at module
// level (`claude-panel:show`, `opencode-panel:show`, …) that fires before it loaded loads it and is emitted again,
// once, for the listener the load registered (forwardEvents).
//
// No imports and no DOM globals: tests/lazy-module.test.mjs runs it under node.

/**
 * @template M
 * @param {() => Promise<M>} load  `() => import('./the-module.js')`
 * @param {{ name?: string, onError?: (err: unknown) => void }} [options]
 */
export function createLazyModule(load, { name = 'module', onError } = {}) {
  /** @type {M|null} */
  let mod = null;
  /** @type {Promise<M>|null} */
  let loading = null;
  let queued = 0;
  const listeners = [];

  function ensure() {
    if (mod) return Promise.resolve(mod);
    if (!loading) {
      loading = Promise.resolve()
        .then(load)
        .then((m) => {
          mod = m;
          for (const fn of listeners.splice(0)) { try { fn(m); } catch (err) { report(err); } }
          return m;
        }, (err) => {
          // A failed load is tried again by the next use (a server restart can refuse one request).
          loading = null;
          report(err);
          throw err;
        });
    }
    return loading;
  }

  function report(err) {
    if (onError) onError(err);
    else if (globalThis.console) console.warn(`[lazy] ${name} could not load:`, err);
  }

  /** Call an export: at once when loaded (and nothing is waiting before it), else after the load, in order. */
  function call(exportName, args) {
    if (mod && !queued) return mod[exportName](...args);
    queued += 1;
    return ensure().then((m) => m[exportName](...args)).finally(() => { queued -= 1; });
  }

  return {
    name,
    /** The module, or null before it loaded. */
    get module() { return mod; },
    get loaded() { return !!mod; },
    load: ensure,
    call,
    /**
     * An async export: a promise of its result. Once loaded it runs in the caller's task, as the original async
     * function did (its body up to the first await runs at once).
     */
    asyncExport(exportName) {
      return (...args) => {
        try { return Promise.resolve(call(exportName, args)); } catch (err) { return Promise.reject(err); }
      };
    },
    /** A sync export: the module's answer once loaded, `whenUnloaded(...args)` before. */
    syncExport(exportName, whenUnloaded) {
      return (...args) => (mod ? mod[exportName](...args) : (typeof whenUnloaded === 'function' ? whenUnloaded(...args) : whenUnloaded));
    },
    /** An export that may be called before the load and must not be lost: at once when loaded, else after it. */
    deferredExport(exportName) {
      return (...args) => call(exportName, args);
    },
    /** Run `fn(module)` once it has loaded (at once when it has). */
    whenLoaded(fn) {
      if (mod) fn(mod);
      else listeners.push(fn);
    },
  };
}

/**
 * Bus events a lazy module listens to at module level: one that fires before the module loaded loads it and is
 * emitted again once, after the load, so the listener the module registered sees it.
 * @param {ReturnType<typeof createLazyModule>} lazy
 * @param {string[]} events
 * @param {{ on: (event: string, fn: (data: any) => void) => void, emit: (event: string, data: any) => void }} bus
 */
export function forwardEvents(lazy, events, bus) {
  for (const event of events) {
    bus.on(event, (data) => {
      if (lazy.loaded) return;
      lazy.load().then(() => bus.emit(event, data), () => {});
    });
  }
}
