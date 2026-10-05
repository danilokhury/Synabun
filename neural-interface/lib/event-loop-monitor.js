// Event-loop health for latency-sensitive processes (the Neural Interface
// server and the pty-host). Terminal keystroke echo and PTY output ride the
// event loop, so any synchronous work shows up here first.
//
// Node's monitorEventLoopDelay reports the sampling timer's own period on top
// of the real delay (an idle loop at resolution 10 reads p50 ≈ 11 ms), so every
// figure is reported as `raw − resolution`. The histogram also misses a stall
// that straddles a reset, so a small timestamped sampler keeps the last stalls.

import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const round = (n, digits = 2) => Number.isFinite(n) ? Number(n.toFixed(digits)) : 0;

export function createEventLoopMonitor({ resolutionMs = 10, stallMs = 50, sampleMs = 100, keepStalls = 50 } = {}) {
  const histogram = monitorEventLoopDelay({ resolution: resolutionMs });
  histogram.enable();

  let windowStart = Date.now();
  let eluStart = performance.eventLoopUtilization();
  const stalls = [];

  let expected = performance.now() + sampleMs;
  const sampler = setInterval(() => {
    const now = performance.now();
    const late = now - expected;
    expected = now + sampleMs;
    if (late >= stallMs) {
      stalls.push({ at: Date.now() - Math.round(late), ms: Math.round(late) });
      if (stalls.length > keepStalls) stalls.shift();
    }
  }, sampleMs);
  sampler.unref?.();

  const delayMs = (ns) => Math.max(0, ns / 1e6 - resolutionMs);

  function snapshot({ reset = false } = {}) {
    const count = histogram.count || 0;
    const pct = (p) => count ? round(delayMs(histogram.percentile(p))) : 0;
    const elu = performance.eventLoopUtilization(eluStart);
    const out = {
      windowMs: Date.now() - windowStart,
      count,
      p50: pct(50),
      p90: pct(90),
      p99: pct(99),
      p999: pct(99.9),
      max: count ? round(delayMs(histogram.max)) : 0,
      mean: count ? round(delayMs(histogram.mean)) : 0,
      elu: round(elu.utilization, 3),
      stalls: stalls.slice(),
    };
    if (reset) {
      histogram.reset();
      windowStart = Date.now();
      eluStart = performance.eventLoopUtilization();
      stalls.length = 0;
    }
    return out;
  }

  function stop() {
    clearInterval(sampler);
    histogram.disable();
  }

  return { snapshot, stop };
}
