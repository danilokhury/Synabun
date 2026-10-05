// pty-host protocol — shared by the main-side manager and the host core.
//
// Browser ↔ host (WebSocket /ws/terminal/:id, handed off by the main server):
//   host→browser  binary frame                      raw PTY bytes
//   host→browser  {type:'snapshot', data, plain, reset:true, cols, rows}
//                                                   first frame of every (re)connect
//                                                   and every lag resync
//   host→browser  {type:'exit'|'error'|'image_saved'|'image_dropped'|'memory_saved', …}
//   browser→host  {type:'input'|'resize'|'image_paste'|'image_drop'|'memory_drop', …}
//   browser→host  {type:'hello', flow:1}             first message; opts into flow control
//   browser→host  {type:'ack', bytes}                binary bytes the client has PARSED
//   browser→host  {type:'visibility', visible}
//
// Main ↔ host (child_process IPC, serialization:'advanced'):
//   main→host  {op:'spawn'|'write'|'resize'|'kill'|'tap'|'upgrade'|'stats'|'shutdown'|'ping', …}
//   host→main  {t:'ready'|'spawned'|'spawn-error'|'tap'|'resized'|'clients'|'exit'|'reply'|'warn', …}

export const OP = Object.freeze({
  SPAWN: 'spawn',
  WRITE: 'write',
  RESIZE: 'resize',
  KILL: 'kill',
  TAP: 'tap',
  UPGRADE: 'upgrade',
  STATS: 'stats',
  SHUTDOWN: 'shutdown',
  PING: 'ping',
});

export const EV = Object.freeze({
  READY: 'ready',
  SPAWNED: 'spawned',
  SPAWN_ERROR: 'spawn-error',
  TAP: 'tap',
  RESIZED: 'resized',
  CLIENTS: 'clients',
  EXIT: 'exit',
  REPLY: 'reply',
  WARN: 'warn',
});

export const HOST_DEFAULTS = Object.freeze({
  // Output coalescing: one frame per event-loop turn, flushed early past this.
  coalesceBurstBytes: 64 * 1024,
  // Socket-level safety net (clients without flow control, or stuck sockets).
  wsHighWater: 1024 * 1024,
  wsLowWater: 128 * 1024,
  drainFallbackMs: 1000,
  // Ack flow control (visible flow clients only).
  flowHigh: 256 * 1024,
  flowLow: 64 * 1024,
  // A hidden client past this many unacked bytes stops receiving output and is
  // resynced from a snapshot when it becomes visible (bounds return-to-app work).
  hiddenCap: 2 * 1024 * 1024,
  // Paused this long with no ack progress → the client is demoted to lagging.
  flowStallMs: 3000,
  // While paused, check the child is still alive so an exiting process can drain.
  pausedWatchMs: 100,
  // Headless model parser backpressure.
  modelPauseBytes: 8 * 1024 * 1024,
  modelResumeBytes: 1024 * 1024,
  // Snapshots.
  snapshotScrollback: 1000,
  pendingSnapshotCap: 4 * 1024 * 1024,
  // Resize: leading edge, then at most one per window.
  resizeThrottleMs: 50,
  // Orphaned session (last client gone) lifetime.
  graceMs: 30 * 60 * 1000,
  // WebSocket keepalive.
  pingMs: 30000,
  // Output tap to the main process (loop drivers, live links).
  tapBatchMs: 25,
  tapBatchBytes: 64 * 1024,
});

// Headers the host needs to complete a WebSocket upgrade. Auth/cookie checks
// happen in the main server before the handoff.
export const UPGRADE_HEADER_WHITELIST = Object.freeze([
  'host', 'origin', 'upgrade', 'connection', 'user-agent',
  'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol',
]);
