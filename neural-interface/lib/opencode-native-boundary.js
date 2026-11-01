// Native page WebSockets are safe only behind a server boundary established at
// listen time. This is a capability allowlist, not a generic OpenCode version
// check: 2.1.4's HTTP/upgrade authentication and stdout password path were
// inspected and tested. Unknown binaries/command wrappers keep the old guard.
// 2.2.5 (Homebrew anomalyco/tap/opencode-v2) checked 2026-11-01 against throwaway
// serves on 127.0.0.1: no password variable → it prints "server password <secret>"
// on stdout; every /api route (session, config, event, pty, shell, file, mcp, and
// the new tunnel and pairing) answers 401 without it, both plain and as a
// WebSocket upgrade, and 200 with it; one listener, bound to 127.0.0.1 only.
// Non-/api paths serve the static web UI (HTML), as before.
export const NATIVE_SERVE_VERSIONS = Object.freeze(['2.1.4', '2.2.5']);

export function nativeServeCapability({ version, commandLine = false, passwordFrom } = {}) {
  const bare = String(version || '').trim().replace(/^opencode\s+/, '').replace(/^v/, '');
  return !commandLine && passwordFrom === 'stdout' && NATIVE_SERVE_VERSIONS.includes(bare);
}

export function createNativeServeBoundary() {
  const processes = new Map();
  const contexts = new Map();
  const error = () => new Error(`Native browser WebSockets require authenticated OpenCode ${NATIVE_SERVE_VERSIONS.join(' or ')} serves with private stdout credentials; wait for startup, stop unverified serves or use the verified executable path.`);
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
