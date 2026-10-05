import { z } from 'zod';

/**
 * A boolean argument as a model sends it: true / false, "true" / "false"
 * (any case, trimmed) or 1 / 0 (number or string). z.coerce.boolean() runs
 * Boolean(value), so the string "false" became true. Anything else fails
 * validation. neural-interface/lib/assistant-plan-permissions.js booleanArg
 * reads the same forms.
 */
export function parseBooleanArg(value: unknown): unknown {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'true' || text === '1') return true;
    if (text === 'false' || text === '0') return false;
  }
  return value;
}

export function coerceBoolean() {
  return z.preprocess(parseBooleanArg, z.boolean());
}

/**
 * Zod schema that accepts an array of strings OR a string representation of one.
 *
 * Claude Code's MCP client sometimes serializes array arguments as strings
 * (e.g. `"[\"a\",\"b\"]"` or `"a, b"`) instead of real JSON arrays.
 * This preprocessor coerces both forms into a proper string array.
 */
export function coerceStringArray() {
  return z.preprocess((val) => {
    if (Array.isArray(val)) return val;
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (!trimmed) return [];
      // Try JSON array first: ["a", "b"]
      if (trimmed.startsWith('[')) {
        try { return JSON.parse(trimmed); } catch { /* fall through */ }
      }
      // Comma-separated fallback: "a, b, c"
      return trimmed.split(',').map(s => s.trim()).filter(Boolean);
    }
    return val;
  }, z.array(z.string()));
}
