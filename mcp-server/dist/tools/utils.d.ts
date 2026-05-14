import { z } from 'zod';
/**
 * Zod schema that accepts an array of strings OR a string representation of one.
 *
 * Claude Code's MCP client sometimes serializes array arguments as strings
 * (e.g. `"[\"a\",\"b\"]"` or `"a, b"`) instead of real JSON arrays.
 * This preprocessor coerces both forms into a proper string array.
 */
export declare function coerceStringArray(): z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], unknown>;
//# sourceMappingURL=utils.d.ts.map