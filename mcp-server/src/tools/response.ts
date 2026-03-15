/**
 * MCP response helpers — eliminates verbose response object boilerplate.
 * Inspired by FastMCP's approach of letting tools return simple values.
 *
 * Before:  return { content: [{ type: 'text' as const, text: msg }] };
 * After:   return text(msg);
 */

/** Wrap a string in the MCP text response format. */
export function text(msg: string) {
  return { content: [{ type: 'text' as const, text: msg }] };
}

/** Wrap base64 image data in the MCP image response format. */
export function image(data: string, mimeType: string) {
  return { content: [{ type: 'image' as const, data, mimeType }] };
}
