// ═══════════════════════════════════════════
// SynaBun Neural Interface — work for when the page is idle, one job at a time
// ═══════════════════════════════════════════
// What nobody is looking at yet (the conversation of an Assistant tab that is not on screen) waits here
// instead of running in the page's start: each job gets an idle period of its own, so ten of them are ten
// short tasks between frames, never one long one. A job that is wanted sooner (its tab is shown) is taken out
// by the function `add()` returned and run by its owner.
//
//   const queue = createIdleQueue();
//   const cancel = queue.add(() => loadIt());
//
// DOM-free: the idle callback is injected (requestIdleCallback where there is one, a timer elsewhere: Safari).
// tests/idle-queue.test.mjs.

const DEFAULT_TIMEOUT_MS = 2500; // a busy page still gets to it
const FALLBACK_DELAY_MS = 200;

function defaultRequestIdle(fn, options) {
  if (typeof globalThis.requestIdleCallback === 'function') return { idle: globalThis.requestIdleCallback(fn, options) };
  return { timer: setTimeout(fn, FALLBACK_DELAY_MS) };
}

function defaultCancelIdle(handle) {
  if (!handle) return;
  if ('idle' in handle && typeof globalThis.cancelIdleCallback === 'function') globalThis.cancelIdleCallback(handle.idle);
  if ('timer' in handle) clearTimeout(handle.timer);
}

export function createIdleQueue({
  requestIdle = defaultRequestIdle,
  cancelIdle = defaultCancelIdle,
  timeout = DEFAULT_TIMEOUT_MS,
  onError = (error) => { try { console.error('[idle-queue] a job failed', error); } catch { /* no console */ } },
} = {}) {
  const jobs = [];
  let handle = null;
  let armed = false;

  const arm = () => {
    if (armed || !jobs.length) return;
    armed = true;
    handle = requestIdle(pump, { timeout });
  };

  function pump() {
    armed = false;
    handle = null;
    const job = jobs.shift();
    if (job) {
      try { job(); } catch (error) { onError(error); }
    }
    arm(); // the next one in an idle period of its own
  }

  return {
    /** Queue `job`. Returns a function that takes it out again (true when it was still waiting). */
    add(job) {
      if (typeof job !== 'function') throw new TypeError('createIdleQueue: a job is a function');
      jobs.push(job);
      arm();
      return () => {
        const at = jobs.indexOf(job);
        if (at < 0) return false;
        jobs.splice(at, 1);
        if (!jobs.length && armed) { cancelIdle(handle); armed = false; handle = null; }
        return true;
      };
    },
    size: () => jobs.length,
  };
}

/** The page's one queue: every module that defers start-up work shares it, so their jobs take turns. */
let shared = null;
export function idleQueue() {
  if (!shared) shared = createIdleQueue();
  return shared;
}
