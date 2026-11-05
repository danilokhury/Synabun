// ── Claude Code tool heartbeats (DOM-free, no imports) ──
// A tool call that runs past 30 s gets a heartbeat from the CLI every 30 s:
//
//   { type: 'tool_progress', tool_use_id: '<call id>-heartbeat-0',
//     parent_tool_use_id: '<call id>', heartbeat: true, elapsed_time_seconds: 30 }
//
// Its parent_tool_use_id is the call itself, not a subagent that made it, so it
// must not be routed the way a subagent's messages are (by parent_tool_use_id):
// the Claude panel drew a fallback subagent card for it at the root of the
// transcript (a purple bar between two tool rows, which also split one run of
// calls into rows), and the Assistant opened a subagent feed inside the call.
// Both panels read a heartbeat as progress of the call it names instead.
// (Seen live with Claude Code 2.1.316: Bash and MCP calls alike.)

const HEARTBEAT_SUFFIX = /-heartbeat-\d+$/;

/**
 * The id of the tool call a heartbeat is about, or null when the event is not a
 * heartbeat. The CLI's `heartbeat: true` decides; an id of the `-heartbeat-N`
 * form counts too (a producer that leaves the flag out).
 */
export function heartbeatToolId(ev) {
  if (!ev || ev.type !== 'tool_progress') return null;
  const own = typeof ev.tool_use_id === 'string' ? ev.tool_use_id : '';
  const flagged = ev.heartbeat === true;
  if (!flagged && !HEARTBEAT_SUFFIX.test(own)) return null;
  const parent = typeof ev.parent_tool_use_id === 'string' ? ev.parent_tool_use_id : '';
  // The call named in the heartbeat's own id; else its parent.
  const named = own.replace(HEARTBEAT_SUFFIX, '');
  if (named && named !== own) return named;
  return parent || own || null;
}

/**
 * A heartbeat as the progress of its call, at the level the call was made: the
 * same event with `tool_use_id` set to the call and no parent. Any other event is
 * returned unchanged (the same object).
 */
export function normalizeToolHeartbeat(ev) {
  const id = heartbeatToolId(ev);
  if (!id) return ev;
  return { ...ev, tool_use_id: id, parent_tool_use_id: null, heartbeat_of: id };
}
