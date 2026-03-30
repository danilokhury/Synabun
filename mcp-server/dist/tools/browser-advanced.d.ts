import { z } from 'zod';
export declare const browserEvaluateSchema: {
    script: z.ZodOptional<z.ZodString>;
    expression: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserEvaluateDescription = "Execute JavaScript in the browser page context and return the result. Useful for reading DOM state, extracting data, or performing actions not covered by other tools.";
export declare function handleBrowserEvaluate(args: {
    script?: string;
    expression?: string;
    sessionId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserWaitSchema: {
    selector: z.ZodOptional<z.ZodString>;
    state: z.ZodOptional<z.ZodEnum<["visible", "hidden", "attached", "detached"]>>;
    loadState: z.ZodOptional<z.ZodEnum<["load", "domcontentloaded", "networkidle"]>>;
    timeout: z.ZodOptional<z.ZodNumber>;
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserWaitDescription = "Wait for an element to reach a certain state, a page load state, or a fixed timeout. Useful after navigation or clicks that trigger async content loading. Use loadState=\"networkidle\" after posting on Twitter/X or after navigation to ensure all async requests have settled.";
export declare function handleBrowserWait(args: {
    selector?: string;
    state?: string;
    loadState?: string;
    timeout?: number;
    sessionId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserSessionSchema: {
    action: z.ZodEnum<["list", "create", "close"]>;
    url: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserSessionDescription = "Manage browser sessions \u2014 list open sessions, create a new browser, or close an existing one.";
export declare function handleBrowserSession(args: {
    action: string;
    url?: string;
    sessionId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=browser-advanced.d.ts.map