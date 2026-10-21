// ═══════════════════════════════════════════
// SynaBun Neural Interface — launch prefetch
// ═══════════════════════════════════════════
// What windows, menus and dropdowns wait for when they open, read once the
// page has painted: in idle time, one step after another with a pause
// between two, so the page never stutters for it and the first open of each
// window paints from the data cache (data-cache.js). Each module registers
// its own steps (registerLaunchPrefetch); the page starts the queue after its
// first paint (startLaunchPrefetch). A step that fails is the window's to ask
// again when it opens. `owner` steps read what an invite guest may not.

import { whenIdle } from './data-cache.js';

const STEP_LIMIT_MS = 15_000; // a step that hangs does not hold the ones after it
const STEP_GAP_MS = 120;

const steps = [];
let started = false;
let running = false;
let guest = () => false;

/** Add a step: `run()` reads something into a cache. Lower `order` runs first. */
export function registerLaunchPrefetch(name, run, { order = 50, owner = false } = {}) {
  if (typeof run !== 'function' || steps.some((step) => step.name === name)) return;
  steps.push({ name, run, order, owner, done: false });
  steps.sort((a, b) => a.order - b.order);
  if (started) pump();
}

/** Start the queue (once): after the first paint, `delayMs` later and in idle time. */
export function startLaunchPrefetch({ delayMs = 600, isGuest = () => false } = {}) {
  if (started) return;
  started = true;
  guest = typeof isGuest === 'function' ? isGuest : () => false;
  setTimeout(pump, delayMs);
}

function pump() {
  if (running) return;
  const next = steps.find((step) => !step.done);
  if (!next) return;
  running = true;
  whenIdle(async () => {
    next.done = true;
    let skip = false;
    try { skip = next.owner && guest(); } catch { skip = false; }
    if (!skip) {
      let timer = null;
      try {
        await Promise.race([
          Promise.resolve().then(next.run),
          new Promise((done) => { timer = setTimeout(done, STEP_LIMIT_MS); }),
        ]);
      } catch { /* the window asks again when it opens */ }
      clearTimeout(timer);
    }
    setTimeout(() => { running = false; pump(); }, STEP_GAP_MS);
  }, { timeout: 2000 });
}
