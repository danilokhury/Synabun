// ═══════════════════════════════════════════
// SynaBun — Antigravity: one turn's tokens out of ACP's session totals
// ═══════════════════════════════════════════
//
// ACP's `usage` block on a session/prompt answer counts the whole session
// ("total input tokens across all turns"), so a turn's own tokens are the
// difference from the previous answer. A counter that went down means the
// agent started counting again (a new process, a reloaded session): that
// answer is a turn of its own. The five-class reading of a block is
// lib/assistant-usage.js antigravityUsageTokens.

const FIELDS = Object.freeze(['inputTokens', 'outputTokens', 'thoughtTokens', 'cachedReadTokens', 'cachedWriteTokens', 'totalTokens']);
const SNAKE = Object.freeze({ inputTokens: 'input_tokens', outputTokens: 'output_tokens', thoughtTokens: 'thought_tokens', cachedReadTokens: 'cached_read_tokens', cachedWriteTokens: 'cached_write_tokens', totalTokens: 'total_tokens' });

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** An ACP usage block in camelCase with every field a count (null when there is none). */
export function normalizeAcpUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const out = {};
  let any = false;
  for (const key of FIELDS) {
    const value = usage[key] ?? usage[SNAKE[key]];
    if (value !== undefined && value !== null) any = true;
    out[key] = count(value);
  }
  return any ? out : null;
}

/** The turn's own usage: `current` minus `previous` (both session totals), or `current` after a reset. */
export function acpTurnUsage(current, previous) {
  const now = normalizeAcpUsage(current);
  if (!now) return null;
  const before = normalizeAcpUsage(previous);
  if (!before) return now;
  if (FIELDS.some((key) => now[key] < before[key])) return now;
  const out = {};
  for (const key of FIELDS) out[key] = now[key] - before[key];
  return out;
}
