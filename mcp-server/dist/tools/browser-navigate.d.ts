import { z } from 'zod';
export declare const browserNavigateSchema: {
    url: z.ZodString;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const browserNavigateDescription = "Navigate the browser to a URL. If no browser session exists, one is created automatically.";
export declare function handleBrowserNavigate(args: {
    url: string;
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