// node-pty's macOS helper starts a new session before exec. If its host dies
// before the helper acquires the controlling terminal, closing the master
// does not hang it up. Kill the known PTY process group as well as its leader.
// Callers must forget a PID on EXIT: these are owned children, never a sweep
// of unrelated processes or a list retained across host restarts.
export function killOwnedPty(pid, { kill = process.kill, platform = process.platform } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  if (platform !== 'win32') {
    try { kill(-pid, 'SIGKILL'); } catch {}
  }
  try { kill(pid, 'SIGKILL'); } catch {}
}
