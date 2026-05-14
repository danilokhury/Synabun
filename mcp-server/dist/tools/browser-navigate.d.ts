import { z } from 'zod';
export declare const browserNavigateSchema: {
    url: z.ZodString;
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
export declare const browserNavigateDescription = "Navigate the browser to a URL. If no browser session exists, one is created automatically. Pass returnSnapshot to fold a browser_snapshot into the same call.";
export declare function handleBrowserNavigate(args: {
    url: string;
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
export declare const browserGoBackSchema: {
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const browserGoBackDescription = "Go back to the previous page in browser history.";
export declare function handleBrowserGoBack(args: {
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserGoForwardSchema: {
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const browserGoForwardDescription = "Go forward to the next page in browser history.";
export declare function handleBrowserGoForward(args: {
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserReloadSchema: {
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const browserReloadDescription = "Reload the current page. Useful after making changes or when content is stale.";
export declare function handleBrowserReload(args: {
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=browser-navigate.d.ts.map