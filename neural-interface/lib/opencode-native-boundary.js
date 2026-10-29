// Native page WebSockets are safe only behind a server boundary established at
// listen time. This is a capability allowlist, not a generic OpenCode version
// check: 2.1.4's HTTP/upgrade authentication and stdout password path were
// inspected and tested. Unknown binaries/command wrappers keep the old guard.
export function nativeServeCapability({ version, commandLine = false, passwordFrom } = {}) {
  return !commandLine && passwordFrom === 'stdout' && /^(?:opencode\s+)?v?2\.1\.4$/.test(String(version || '').trim());
}

export function createNativeServeBoundary() {
  const processes = new Map();
  const contexts = new Map();
  const error = () => new Error('Native browser WebSockets require authenticated OpenCode 2.1.4 serves with private stdout credentials; wait for startup, stop unverified serves or use the verified executable path.');
  return {
    assertLaunch(safe) { if (!safe && contexts.size) throw error(); },
    track(proc, { port, safe = false }) {
      if (!proc || proc.exitCode != null || proc.signalCode != null) return;
      processes.set(proc, { port: Number(port), safe, ready: false });
      const release = () => processes.delete(proc);
      proc.once('exit', release);
      proc.once('error', () => { if (!proc.pid) release(); });
    },
    ready(proc) { const entry = processes.get(proc); if (entry) entry.ready = true; },
    protect(context, { ports, unverifiedRecords = [] }) {
      if (contexts.has(context)) return contexts.get(context);
      const verified = new Set();
      for (const { port, safe, ready } of processes.values()) {
        if (!safe || !ready) throw error();
        verified.add(port);
      }
      if ([...ports].some(port => !verified.has(Number(port))) || unverifiedRecords.length) throw error();
      const browser = context.browser();
      const release = () => {
        if (contexts.get(context) !== release) return;
        contexts.delete(context);
        context.removeListener('close', release);
        browser.removeListener('disconnected', release);
      };
      contexts.set(context, release);
      context.once('close', release);
      browser.once('disconnected', release);
      return release;
    },
  };
}
