/**
 * Who closed a MoreLogin profile's browser under a session SynaBun did not close (2026-11-15).
 *
 * Profile P-1 was closed under running automations several times a day (MoreLogin's envkit log records each as
 * Event 'close_click': 7 on 2026-11-15), and every close cost a new start of the plan's daily quota. SynaBun never
 * reopens the profile by itself on such a close; it writes one line of evidence instead: the time, the profile, the
 * app in front at that moment (macOS: `lsappinfo front`, then `lsappinfo info -only name <asn>`) and the computer-use
 * run that held the desktop, if one did. Best effort: short timeouts, no shell, never throws, never waits on the
 * browser's own teardown.
 */
import { execFile as realExecFile } from 'node:child_process';

export const FRONT_APP_TIMEOUT_MS = 1500;

/** The ASN `lsappinfo front` prints ("ASN:0x0-0x6b06b:"), or null. */
export function parseLsappinfoFront(out) {
  const m = /ASN:0x[0-9a-f]+-0x[0-9a-f]+/i.exec(String(out || ''));
  return m ? m[0] : null;
}

/**
 * The app's name in `lsappinfo info -only name <asn>`: `"LSDisplayName"="Finder"` on most macOS versions, or the
 * quoted name that starts the full record (`"SynaBun" ASN:0x0-0x6b06b: (in front)`) where `-only` is not honoured.
 */
export function parseLsappinfoName(out) {
  const text = String(out || '');
  const keyed = /"(?:LSDisplayName|name|CFBundleName)"\s*=\s*"([^"]*)"/i.exec(text);
  if (keyed && keyed[1].trim()) return keyed[1].trim();
  const lead = /^\s*"([^"]+)"\s+ASN:/m.exec(text);
  return lead ? lead[1].trim() : null;
}

function run(execFileImpl, file, args, timeoutMs) {
  return new Promise((done) => {
    try {
      execFileImpl(file, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, stdout) => done(err ? null : String(stdout || '')));
    } catch { done(null); }
  });
}

/** The app in front now (macOS only), or null when it cannot be told. Never rejects. */
export async function frontmostApp({ platform = process.platform, execFileImpl = realExecFile, timeoutMs = FRONT_APP_TIMEOUT_MS } = {}) {
  if (platform !== 'darwin') return null;
  const asn = parseLsappinfoFront(await run(execFileImpl, 'lsappinfo', ['front'], timeoutMs));
  if (!asn) return null;
  return parseLsappinfoName(await run(execFileImpl, 'lsappinfo', ['info', '-only', 'name', asn], timeoutMs));
}

/** The computer-use run that held the desktop, from the desktop service's `status().control`, in a few words. */
export function describeComputerUse(control) {
  if (!control || !control.active) return 'none';
  const o = control.owner || {};
  const parts = [];
  if (o.runId) parts.push(`run ${o.runId}`);
  if (o.assistantSessionId) parts.push(`assistant session ${o.assistantSessionId}`);
  if (!parts.length && o.kind) parts.push(String(o.kind));
  if (control.since) parts.push(`since ${control.since}`);
  return parts.length ? parts.join(', ') : 'active (owner not named)';
}

/** The one line: `[morelogin] profile closed outside SynaBun: at=… env=… session=… front_app=… computer_use=…`. */
export function unexpectedCloseLine({ at, envId, sessionId, frontApp, computerUse }) {
  const q = (v) => JSON.stringify(v == null ? null : String(v));
  return `[morelogin] profile closed outside SynaBun: at=${new Date(at).toISOString()} env=${envId || 'unknown'} session=${sessionId || 'unknown'} front_app=${q(frontApp)} computer_use=${q(computerUse)} (not reopened by SynaBun)`;
}

/**
 * Write the evidence line for a profile closed under a session SynaBun did not close. The time is taken at once;
 * the front app is asked without blocking anything. Resolves to the line; never rejects.
 */
export async function logUnexpectedProfileClose({ envId, sessionId, desktopControl = null, log = console.log, now = Date.now, frontmost = frontmostApp } = {}) {
  const at = now();
  let computerUse = 'unknown';
  try { computerUse = describeComputerUse(typeof desktopControl === 'function' ? desktopControl() : desktopControl); } catch { /* unknown */ }
  let frontApp = null;
  try { frontApp = await frontmost(); } catch { frontApp = null; }
  const line = unexpectedCloseLine({ at, envId, sessionId, frontApp, computerUse });
  try { log(line); } catch { /* nowhere to say it */ }
  return line;
}
