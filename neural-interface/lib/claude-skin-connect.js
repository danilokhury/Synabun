// ── Attaching one /ws/claude-skin connection to its engine (fail closed) ──
//
// The sidepanel runs on the SDK bridge (lib/claude-agent-bridge.js), the only
// engine there is. This is the one place that decides what a new socket gets:
//   - the bridge, once its import has settled (a connection that arrives during
//     server boot waits for it);
//   - otherwise a visible refusal. A bridge that failed to load, or that throws
//     while attaching, never takes the server down with it, and the tab is told
//     why it has no engine.
//
// Messages the client sends before the engine is attached (the panel sends
// `reattach` on open) are held and handed to the engine in order.

export const ENGINE_UNAVAILABLE = 'engine_unavailable';
const BRIDGE_READY_TIMEOUT_MS = 20_000;

function sendJson(ws, data) {
  if (ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(data)); } catch {}
}

/** Tell the client why no engine is attached, now and for every prompt it still sends. */
function refuse(ws, reason) {
  const message = `Claude Code is unavailable: ${reason}`;
  sendJson(ws, { type: 'engine', engine: 'unavailable', error: reason });
  sendJson(ws, { type: 'error', code: ENGINE_UNAVAILABLE, message });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg?.type === 'query' || msg?.type === 'compact') {
      sendJson(ws, { type: 'error', code: ENGINE_UNAVAILABLE, message });
    }
  });
  return 'unavailable';
}

/**
 * @param ws                 the accepted WebSocket
 * @param o.bridgeReady      promise that settles when the bridge import finished (never rejects)
 * @param o.getBridge        () => the bridge module, or null when it failed to load
 * @param o.getBridgeError   () => why it failed to load
 * @param o.readyTimeoutMs   how long a connection waits for the bridge import
 * @returns 'sdk' | 'unavailable' | 'closed'
 */
export async function connectClaudeSkin(ws, o = {}) {
  const log = typeof o.log === 'function' ? o.log : () => {};
  const early = [];
  const holdEarly = (raw, isBinary) => { early.push([raw, isBinary]); };
  ws.on('message', holdEarly);
  // The engine's own listener is attached by now: give it what arrived before.
  const release = () => {
    ws.off('message', holdEarly);
    for (const [raw, isBinary] of early) ws.emit('message', raw, isBinary);
    early.length = 0;
  };
  const fail = (reason) => {
    ws.off('message', holdEarly);
    early.length = 0;
    log(`connection refused: ${reason}`);
    return refuse(ws, reason);
  };

  if (!o.getBridge?.()) {
    let timer = null;
    const timeout = new Promise((resolve) => { timer = setTimeout(resolve, o.readyTimeoutMs ?? BRIDGE_READY_TIMEOUT_MS); timer.unref?.(); });
    try { await Promise.race([Promise.resolve(o.bridgeReady).catch(() => {}), timeout]); } finally { clearTimeout(timer); }
  }
  if (ws.readyState !== 1) { ws.off('message', holdEarly); early.length = 0; return 'closed'; }

  const bridge = o.getBridge?.();
  if (!bridge) {
    return fail(o.getBridgeError?.() || 'the Claude Agent SDK bridge is still starting. Try again in a moment.');
  }
  try { bridge.createClaudeBridge(ws); } catch (err) {
    return fail(err?.message || String(err));
  }
  release();
  return 'sdk';
}
