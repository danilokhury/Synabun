import { z } from 'zod';
export declare const browserClickSchema: {
    selector: z.ZodString;
    nthMatch: z.ZodOptional<z.ZodNumber>;
    textHint: z.ZodOptional<z.ZodString>;
    returnSnapshot: z.ZodOptional<z.ZodObject<{
        mode: z.ZodOptional<z.ZodEnum<["full", "interactive", "landmarks"]>>;
        selector: z.ZodOptional<z.ZodString>;
        viewport: z.ZodOptional<z.ZodBoolean>;
        maxChars: z.ZodOptional<z.ZodNumber>;
        format: z.ZodOptional<z.ZodEnum<["text", "json"]>>;
    }, "strip", z.ZodTypeAny, {
        selector?: string | undefined;
        mode?: "full" | "interactive" | "landmarks" | undefined;
        viewport?: boolean | undefined;
        maxChars?: number | undefined;
        format?: "text" | "json" | undefined;
    }, {
        selector?: string | undefined;
        mode?: "full" | "interactive" | "landmarks" | undefined;
        viewport?: boolean | undefined;
        maxChars?: number | undefined;
        format?: "text" | "json" | undefined;
    }>>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const browserClickDescription = "Click an element on the page. Accepts Playwright selectors: CSS, text=\"...\", :has-text(\"...\"), role=button[name=\"...\"], [data-testid=\"...\"]. NEVER use :contains() \u2014 use :has-text(). Run browser_snapshot first (or mode=\"interactive\") to find the element. Call browser_cheatsheet for per-platform stable selectors.";
export declare function handleBrowserClick(args: {
    selector: string;
    nthMatch?: number;
    textHint?: string;
    returnSnapshot?: {
        mode?: 'full' | 'interactive' | 'landmarks';
        selector?: string;
        viewport?: boolean;
        maxChars?: number;
        format?: 'text' | 'json';
    };
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserFillSchema: {
    selector: z.ZodString;
    value: z.ZodString;
    nthMatch: z.ZodOptional<z.ZodNumber>;
    textHint: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const browserFillDescription = "Clear an input/textarea and fill it with new text. Accepts Playwright selectors: CSS, text=\"...\", :has-text(\"...\"), [data-testid=\"...\"]. For contenteditable editors prefer browser_type. Call browser_cheatsheet for per-platform input selectors.";
export declare function handleBrowserFill(args: {
    selector: string;
    value: string;
    nthMatch?: number;
    textHint?: string;
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserTypeSchema: {
    selector: z.ZodOptional<z.ZodString>;
    text: z.ZodString;
    nthMatch: z.ZodOptional<z.ZodNumber>;
    textHint: z.ZodOptional<z.ZodString>;
    mode: z.ZodOptional<z.ZodEnum<["sequential", "insert"]>>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const browserTypeDescription = "Type text character-by-character (simulates real keystrokes; appends). Provide a selector to target, or omit to type into the focused element. Prefer over browser_fill for contenteditable/rich-text editors. Call browser_cheatsheet for per-platform compose selectors.";
export declare function handleBrowserType(args: {
    selector?: string;
    text: string;
    nthMatch?: number;
    textHint?: string;
    mode?: 'sequential' | 'insert';
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserHoverSchema: {
    selector: z.ZodString;
    nthMatch: z.ZodOptional<z.ZodNumber>;
    textHint: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const browserHoverDescription = "Hover over an element. Useful for revealing dropdowns, tooltips, or hover-triggered content. Accepts Playwright selectors.";
export declare function handleBrowserHover(args: {
    selector: string;
    nthMatch?: number;
    textHint?: string;
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserSelectSchema: {
    selector: z.ZodString;
    value: z.ZodString;
    nthMatch: z.ZodOptional<z.ZodNumber>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const browserSelectDescription = "Select an option from a <select> dropdown by CSS selector and option value.";
export declare function handleBrowserSelect(args: {
    selector: string;
    value: string;
    nthMatch?: number;
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserPressSchema: {
    key: z.ZodString;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const browserPressDescription = "Press a keyboard key or key combination. Supports modifiers like Control+A, Shift+Enter, etc.";
export declare function handleBrowserPress(args: {
    key: string;
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserScrollSchema: {
    direction: z.ZodEnum<["up", "down", "left", "right"]>;
    distance: z.ZodOptional<z.ZodNumber>;
    selector: z.ZodOptional<z.ZodString>;
    returnSnapshot: z.ZodOptional<z.ZodObject<{
        mode: z.ZodOptional<z.ZodEnum<["full", "interactive", "landmarks"]>>;
        selector: z.ZodOptional<z.ZodString>;
        viewport: z.ZodOptional<z.ZodBoolean>;
        maxChars: z.ZodOptional<z.ZodNumber>;
        format: z.ZodOptional<z.ZodEnum<["text", "json"]>>;
    }, "strip", z.ZodTypeAny, {
        selector?: string | undefined;
        mode?: "full" | "interactive" | "landmarks" | undefined;
        viewport?: boolean | undefined;
        maxChars?: number | undefined;
        format?: "text" | "json" | undefined;
    }, {
        selector?: string | undefined;
        mode?: "full" | "interactive" | "landmarks" | undefined;
        viewport?: boolean | undefined;
        maxChars?: number | undefined;
        format?: "text" | "json" | undefined;
    }>>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const browserScrollDescription = "Scroll the page or a specific scrollable element. Essential for infinite-scroll feeds. Pass a selector to scroll within a container (e.g. a feed or chat list). Default distance is 500px. Call browser_cheatsheet for per-platform scroll containers and recommended distances.";
export declare function handleBrowserScroll(args: {
    direction: string;
    distance?: number;
    selector?: string;
    returnSnapshot?: {
        mode?: 'full' | 'interactive' | 'landmarks';
        selector?: string;
        viewport?: boolean;
        maxChars?: number;
        format?: 'text' | 'json';
    };
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserUploadSchema: {
    selector: z.ZodString;
    filePaths: z.ZodArray<z.ZodString, "many">;
    nthMatch: z.ZodOptional<z.ZodNumber>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const browserUploadDescription = "Upload one or more files via a file input element. For platforms with hidden/gated inputs, click the visible upload/media button first to reveal the input, then pass its selector. Call browser_cheatsheet for per-platform upload flows.";
export declare function handleBrowserUpload(args: {
    selector: string;
    filePaths: string[];
    nthMatch?: number;
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=browser-interact.d.ts.map