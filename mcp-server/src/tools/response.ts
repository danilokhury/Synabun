/**
 * MCP response helpers — eliminates verbose response object boilerplate.
 * Inspired by FastMCP's approach of letting tools return simple values.
 *
 * Before:  return { content: [{ type: 'text' as const, text: msg }] };
 * After:   return text(msg);
 */

/**
 * Strip unpaired Unicode surrogates (U+D800–U+DFFF) that produce
 * invalid JSON ("no low surrogate in string" API errors).
 * Common in browser-extracted content from Facebook, WhatsApp, etc.
 */
function sanitizeSurrogates(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

/** Wrap a string in the MCP text response format. */
export function text(msg: string) {
  return { content: [{ type: 'text' as const, text: sanitizeSurrogates(msg) }] };
}

/** Wrap base64 image data in the MCP image response format. */
export function image(data: string, mimeType: string) {
  return { content: [{ type: 'image' as const, data, mimeType }] };
}
