import { z } from 'zod';
/**
 * Zod schema that accepts an array of strings OR a string representation of one.
 *
 * Claude Code's MCP client sometimes serializes array arguments as strings
 * (e.g. `"[\"a\",\"b\"]"` or `"a, b"`) instead of real JSON arrays.
 * This preprocessor coerces both forms into a proper string array.
 */
export function coerceStringArray() {
    return z.preprocess((val) => {
        if (Array.isArray(val))
            return val;
        if (typeof val === 'string') {
            const trimmed = val.trim();
            if (!trimmed)
                return [];
            // Try JSON array first: ["a", "b"]
            if (trimmed.startsWith('[')) {
                try {
                    return JSON.parse(trimmed);
                }
                catch { /* fall through */ }
            }
            // Comma-separated fallback: "a, b, c"
            return trimmed.split(',').map(s => s.trim()).filter(Boolean);
        }
        return val;
    }, z.array(z.string()));
}
//# sourceMappingURL=utils.js.map