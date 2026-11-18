// Refresh only the sources a sync event invalidated. Serialize overlapping reads so an older snapshot
// cannot clear a newer decision, and discard reads belonging to a previous owner session.
const SOURCES = ['drafts', 'teams', 'skills', 'automations', 'schedules', 'workers', 'runs'];

export function watchStudioAttention({ read, paint }) {
  let owner = false;
  let session = 0;
  let state = {};
  let reading = false;
  let timer, overdue, retry;
  let retried = false;
  const dirty = new Set();

  function render() {
    paint(state.drafts || 0, {
      agents: Boolean(state.drafts || state.teams || state.workers),
      skills: Boolean(state.skills),
      automations: Boolean(state.automations || state.runs?.automations),
      schedules: Boolean(state.schedules?.waiting || state.runs?.schedules),
    });
  }

  function refresh(...sources) {
    if (!owner) return;
    for (const key of sources.length ? sources : SOURCES) dirty.add(key);
    if (!reading && timer == null) timer = setTimeout(flush, 250);
  }

  async function flush() {
    timer = null;
    const keys = [...dirty];
    dirty.clear();
    const generation = session;
    reading = true;
    let incomplete = false;
    try {
      const next = await read(keys);
      if (generation !== session) return;
      for (const key of keys) {
        if (next[key] == null) { incomplete = true; continue; }
        state[key] = next[key];
        if (key === 'schedules') {
          clearTimeout(overdue);
          const delay = next.schedules.recheckInMs;
          if (delay != null) overdue = setTimeout(() => refresh('schedules'), Math.min(2 ** 31 - 1, delay));
        }
      }
      render();
    } catch {
      incomplete = true;
    } finally {
      if (generation === session) {
        reading = false;
        // Keep successful flags through a failure. Retry once, then let focus or reconnect resync.
        if (incomplete && !retried && retry == null) {
          retried = true;
          retry = setTimeout(() => { retry = null; refresh(); }, 3000);
        } else if (!incomplete) {
          retried = false;
        }
        if (dirty.size) refresh(...dirty);
      }
    }
  }

  function setOwner(value) {
    owner = value;
    session++;
    reading = false;
    clearTimeout(timer);
    clearTimeout(overdue);
    clearTimeout(retry);
    timer = retry = null;
    retried = false;
    dirty.clear();
    if (owner) refresh();
    else {
      state = {};
      render();
    }
  }
  return { refresh, setOwner };
}
