// ═══════════════════════════════════════════
// SynaBun — Antigravity tool policy: what the PreToolUse hook of a SynaBun home asks
// ═══════════════════════════════════════════
//
// Every Antigravity brain and run SynaBun starts has a hook (lib/antigravity/policy-hook.mjs) that
// Antigravity runs before each tool call. The hook sends the call to this process
// (POST /api/antigravity/policy, loopback only) with its home's token; the token names the brain or
// run that registered a checker here, and the checker answers:
//   { decision: 'deny', reason }   refused: the model reads the reason ("tool call denied by pre-tool
//                                   hook: …") and its turn goes on
//   { decision: 'ask' }             allowed by policy, approval by the usual permission request
//                                   (session/request_permission: the brain's card, the run's broker)
//   { decision: 'allow' }           allowed by policy, no approval needed
// A token nobody registered (a run that ended, a restarted server) is refused: a home is never used
// without the process that wrote it watching. A checker that throws refuses too (fail closed).

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { acpCall } from './tool-call.js';

export const POLICY_TOKEN_RE = /^agp_[A-Za-z0-9_-]{32,64}$/;
const DECISIONS = new Set(['deny', 'ask', 'allow']);
const MAX_REASON = 2000;

function sameToken(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A checker's answer as the hook prints it ({ decision, reason? }); anything else is a refusal. */
export function normalizePolicyAnswer(answer) {
  const decision = DECISIONS.has(answer?.decision) ? answer.decision : 'deny';
  if (decision !== 'deny') return { decision };
  const reason = String(answer?.reason || 'SynaBun refused this call.').replace(/\s+/g, ' ').trim().slice(0, MAX_REASON);
  return { decision, reason };
}

export function createAntigravityPolicyRegistry({ log = () => {} } = {}) {
  const entries = new Map(); // token → { check, label }

  /** Register a checker ((call, payload) → answer | Promise<answer>) → { token, dispose() }. */
  function register(check, { label = 'antigravity' } = {}) {
    if (typeof check !== 'function') throw new Error('An Antigravity policy needs a checker');
    const token = `agp_${randomBytes(32).toString('base64url')}`;
    entries.set(token, { check, label });
    return { token, dispose: () => { entries.delete(token); } };
  }

  /** The answer for one hook payload ({ toolCall: { name, args }, conversationId, … }) under `token`. */
  async function decide(token, payload = {}) {
    const raw = String(token || '');
    let entry = null;
    if (POLICY_TOKEN_RE.test(raw)) {
      for (const [known, value] of entries) if (sameToken(known, raw)) { entry = value; break; }
    }
    if (!entry) return { decision: 'deny', reason: 'SynaBun no longer runs this Antigravity session (its run ended or the server restarted), so nothing it does is allowed. End the turn.' };
    const toolCall = payload?.toolCall;
    if (!toolCall || typeof toolCall !== 'object' || Array.isArray(toolCall) || typeof toolCall.name !== 'string' || !toolCall.name.trim()) {
      return { decision: 'deny', reason: 'SynaBun received no valid tool call, so it is refused.' };
    }
    try {
      const call = acpCall(payload);
      return normalizePolicyAnswer(await entry.check(call, payload));
    } catch (error) {
      log(`antigravity policy ${entry.label}: ${error?.message || error}`);
      return { decision: 'deny', reason: `SynaBun could not check this call (${String(error?.message || error).slice(0, 200)}), so it is refused.` };
    }
  }

  return { register, decide, get size() { return entries.size; } };
}

/** The one registry of this process (server.js mounts its route; brains and runs register here). */
export const defaultAntigravityPolicy = createAntigravityPolicyRegistry();
