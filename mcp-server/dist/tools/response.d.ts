/**
 * MCP response helpers — eliminates verbose response object boilerplate.
 * Inspired by FastMCP's approach of letting tools return simple values.
 *
 * Before:  return { content: [{ type: 'text' as const, text: msg }] };
 * After:   return text(msg);
 */
/** Wrap a string in the MCP text response format. */
export declare function text(msg: string): {
    content: {
        type: "text";
        text: string;
    }[];
};
/** Wrap base64 image data in the MCP image response format. */
export declare function image(data: string, mimeType: string): {
    content: {
        type: "image";
        data: string;
        mimeType: string;
    }[];
};
//# sourceMappingURL=response.d.ts.map