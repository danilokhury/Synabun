// Ack-based flow control, VS Code ptyHost style: keep the bytes a VISIBLE
// client has received but not yet parsed small, so Ctrl+C and keystroke echo
// never queue behind megabytes of output. Pure — the core applies decisions.
//
// Rules:
//  - Only clients that sent hello{flow:1}, are open, not lagging and not in a
//    pending snapshot participate.
//  - Pause when any visible participant is above `flowHigh`; resume when every
//    visible participant is below `flowLow`; in between, keep the current state.
//  - Hidden participants never pause the PTY (a backgrounded web app must not
//    stall a CLI). Past `hiddenCap` they are demoted and resynced on return.
//  - Loop-owned sessions (no human watching) never pause for the UI.
//  - Stall watchdog: while paused, a visible participant above `flowHigh`
//    whose last ack is older than `flowStallMs` is demoted so a stuck tab
//    can't freeze a CLI.

export function evaluateFlow({ clients, loopOwned = false, paused = false, pausedAt = 0, now = Date.now(), cfg }) {
  const demote = [];
  const participants = [];
  for (const c of clients) {
    if (!c || !c.flow || c.lagging || c.pending || !c.open) continue;
    if (!c.visible) {
      if (c.unacked > cfg.hiddenCap) demote.push({ client: c, reason: 'hidden-cap' });
      continue;
    }
    participants.push(c);
  }

  if (loopOwned || participants.length === 0) return { pause: false, demote };

  if (paused) {
    const stalled = participants.filter(c =>
      c.unacked > cfg.flowHigh && now - Math.max(c.lastAckAt || 0, pausedAt || 0) > cfg.flowStallMs);
    for (const c of stalled) demote.push({ client: c, reason: 'stall' });
    const remaining = participants.filter(c => !stalled.includes(c));
    if (remaining.length === 0) return { pause: false, demote };
    if (remaining.some(c => c.unacked > cfg.flowHigh)) return { pause: true, demote };
    if (remaining.every(c => c.unacked < cfg.flowLow)) return { pause: false, demote };
    return { pause: true, demote };
  }

  return { pause: participants.some(c => c.unacked > cfg.flowHigh), demote };
}
