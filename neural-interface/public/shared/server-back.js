// Waiting for SynaBun's server to come back after a restart it announced (an MCP build in the onboarding wizard, a
// restore in Settings). DOM-free: the page hands in fetch, the clock and what to do; tests run it under Node.

/**
 * "Back" is /api/health answering with another bootId than the one the restart named (or, for a server that sends
 * none, an answer after it was seen gone), never just an answer, because the old server keeps answering while it
 * shuts down. Bounded: true when it came back, false when it did not in time.
 */
export async function waitForServerBack(oldBootId, {
  timeoutMs = 90_000, everyMs = 1000,
  fetchFn = (...a) => fetch(...a), sleep = (ms) => new Promise(r => setTimeout(r, ms)), now = () => Date.now(),
} = {}) {
  const until = now() + timeoutMs;
  let seenGone = false;
  while (now() < until) {
    await sleep(everyMs);
    try {
      const res = await fetchFn('/api/health', { cache: 'no-store' });
      if (!res.ok) { seenGone = true; continue; }
      const health = await res.json();
      if (health.restarting) { seenGone = true; continue; }
      if (health.bootId ? health.bootId !== oldBootId : seenGone) return true;
    } catch {
      seenGone = true;
    }
  }
  return false;
}

/**
 * After POST /api/system/restore answered: reload the page. Without a restart, after `delayMs` as always; with one
 * (the restore built a new MCP server and the server restarts to load it), only once a new server answers, since a
 * reload during the restart lands on a server that is going away. Returns 'reloaded' or 'not-back' (then
 * `onNotBack` ran and nothing reloads: the page says so instead).
 */
export async function reloadAfterRestore(result, {
  reload, onRestarting = () => {}, onNotBack = () => {}, delayMs = 2500,
  wait = waitForServerBack, sleep = (ms) => new Promise(r => setTimeout(r, ms)),
} = {}) {
  if (!result?.restart) {
    await sleep(delayMs);
    reload();
    return 'reloaded';
  }
  onRestarting();
  const back = await wait(typeof result.bootId === 'string' ? result.bootId : '');
  if (!back) { onNotBack(); return 'not-back'; }
  reload();
  return 'reloaded';
}
