/**
 * Leonardo.ai Browser MCP tools.
 * 100% browser-based — all interaction happens via SynaBun's browser automation.
 * No API key required.
 *
 * Tools: leonardo_browser_navigate, leonardo_browser_generate, leonardo_browser_library, leonardo_browser_download, leonardo_browser_reference
 */
import { z } from 'zod';
export declare const browserNavigateSchema: {
    page: z.ZodEnum<["home", "library", "image", "video", "upscaler", "blueprints", "flow-state", "models"]>;
};
export declare const browserNavigateDescription = "Navigate the browser to a specific Leonardo.ai page. Always use this as the first step before any browser-based generation.";
export declare function handleBrowserNavigate(args: {
    page: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserGenerateSchema: {
    prompt: z.ZodString;
    type: z.ZodOptional<z.ZodEnum<["image", "video"]>>;
};
export declare const browserGenerateDescription = "Fill the prompt field and click Generate on the current Leonardo.ai page. Set all other settings (model, style, dimensions, motion controls) BEFORE calling this \u2014 use browser_click, browser_fill, and browser_snapshot to configure the UI first. This tool only handles: navigate to correct page if needed \u2192 clear & fill prompt \u2192 click Generate.";
export declare function handleBrowserGenerate(args: {
    prompt: string;
    type?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserLibrarySchema: {
    action: z.ZodEnum<["view", "search"]>;
    query: z.ZodOptional<z.ZodString>;
};
export declare const browserLibraryDescription = "Open or search Leonardo.ai's library to view past generations. Use browser_snapshot after to see results.";
export declare function handleBrowserLibrary(args: {
    action: string;
    query?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserDownloadSchema: {
    action: z.ZodEnum<["screenshot"]>;
};
export declare const browserDownloadDescription = "Capture a screenshot of the current Leonardo.ai page. Use to verify generation results or UI state.";
export declare function handleBrowserDownload(args: {
    action: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserReferenceSchema: {
    type: z.ZodEnum<["image_ref", "style_ref", "content_ref", "character_ref", "image_to_image", "start_frame", "end_frame"]>;
    filePaths: z.ZodArray<z.ZodString, "many">;
    autoClear: z.ZodOptional<z.ZodBoolean>;
};
export declare const browserReferenceDescription: string;
export declare function handleBrowserReference(args: {
    type: string;
    filePaths: string[];
    autoClear?: boolean;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=leonardo-browser-tools.d.ts.map