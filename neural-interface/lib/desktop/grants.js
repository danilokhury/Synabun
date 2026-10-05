// ═══════════════════════════════════════════
// SynaBun — Desktop grants (who may drive the computer)
// ═══════════════════════════════════════════
//
// MCP terminal pins cannot say which assistant session a call belongs to (a
// Codex brain pins codex-sp-<uuid>, an OpenCode brain assistant-oc-<24>), and
// hosts auto-allow every SynaBun tool. So the Neural Interface mints an
// unforgeable token per assistant brain and per computer-use worker run; the
// MCP `computer` group is advertised only to callers presenting one, and every
// /api/desktop agent route re-resolves it. Tokens live in memory only.
//
// A grant can be held: its token exists (a brain's MCP headers are fixed when
// the brain starts) but resolves to nothing until it is activated. A remote
// (WhatsApp) session's brain grant is minted held and is active only while
// lib/remote-policy.js remoteComputerUse allows the running turn.

import { randomBytes } from 'node:crypto';

export const GRANT_RE = /^sbd_[A-Za-z0-9_-]{43}$/;

export function isGrantToken(value) { return typeof value === 'string' && GRANT_RE.test(value); }

export function createGrantRegistry({ now = Date.now, random = () => randomBytes(32) } = {}) {
  const byToken = new Map();

  /**
   * meta: { kind:'brain'|'run', assistantSessionId, runId, provider, model, vision,
   *         held (minted inactive), remote: { channel, approval } (a remote session's grant) }
   */
  function mint(meta = {}) {
    const token = `sbd_${random().toString('base64url').slice(0, 43)}`;
    byToken.set(token, {
      token, kind: meta.kind === 'run' ? 'run' : 'brain',
      assistantSessionId: meta.assistantSessionId ? String(meta.assistantSessionId) : null,
      runId: meta.runId ? String(meta.runId) : null,
      provider: meta.provider || null, model: meta.model || null, vision: meta.vision ?? null,
      held: meta.held === true, remote: cleanRemote(meta.remote),
      createdAt: now(),
    });
    return token;
  }
  /** A held grant resolves to nothing: its holder is refused like a caller without one. */
  function resolve(token) {
    const grant = isGrantToken(token) ? byToken.get(token) || null : null;
    return grant && !grant.held ? grant : null;
  }
  /**
   * Activate or hold a grant (unknown token: false). `remote` says where the
   * session is driven from and how this use was allowed; it rides on the audit.
   */
  function setActive(token, active, { remote } = {}) {
    const grant = isGrantToken(token) ? byToken.get(token) : null;
    if (!grant) return false;
    grant.held = active !== true;
    if (remote !== undefined) grant.remote = cleanRemote(remote);
    return true;
  }
  function isHeld(token) { const grant = isGrantToken(token) ? byToken.get(token) : null; return !!grant && grant.held === true; }
  function revoke(token) { return byToken.delete(token); }
  /** Revoke by token, run id or session id (a session's own brain grants only). */
  function revokeFor({ token = null, runId = null, assistantSessionId = null } = {}) {
    let removed = 0;
    for (const [key, grant] of byToken) {
      if ((token && key === token) || (runId && grant.runId === String(runId)) || (assistantSessionId && grant.kind === 'brain' && grant.assistantSessionId === String(assistantSessionId))) {
        byToken.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
  function list() { return [...byToken.values()].map(({ token, ...rest }) => ({ ...rest, token: `${token.slice(0, 8)}…` })); }
  function clear() { byToken.clear(); }
  return { mint, resolve, setActive, isHeld, revoke, revokeFor, list, clear };
}

/** { channel, approval: 'unasked' | 'approved_turn', approvedBy } of a remote session's grant, else null. */
function cleanRemote(value) {
  if (!value || typeof value !== 'object') return null;
  const channel = String(value.channel || '').trim().slice(0, 40);
  if (!channel) return null;
  const approval = value.approval === 'unasked' || value.approval === 'approved_turn' ? value.approval : null;
  const approvedBy = approval === 'approved_turn' && (value.approvedBy === 'whatsapp' || value.approvedBy === 'ui') ? value.approvedBy : null;
  return { channel, approval, ...(approvedBy ? { approvedBy } : {}) };
}
