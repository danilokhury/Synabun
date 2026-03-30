import { z } from 'zod';
export declare const browserClickSchema: {
    selector: z.ZodString;
    nthMatch: z.ZodOptional<z.ZodNumber>;
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserClickDescription: string;
export declare function handleBrowserClick(args: {
    selector: string;
    nthMatch?: number;
    sessionId?: string;
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
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserFillDescription: string;
export declare function handleBrowserFill(args: {
    selector: string;
    value: string;
    nthMatch?: number;
    sessionId?: string;
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
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserTypeDescription: string;
export declare function handleBrowserType(args: {
    selector?: string;
    text: string;
    nthMatch?: number;
    sessionId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserHoverSchema: {
    selector: z.ZodString;
    nthMatch: z.ZodOptional<z.ZodNumber>;
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserHoverDescription = "Hover over an element. Useful for revealing dropdowns, tooltips, or hover-triggered content. Accepts Playwright selectors.";
export declare function handleBrowserHover(args: {
    selector: string;
    nthMatch?: number;
    sessionId?: string;
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
};
export declare const browserSelectDescription = "Select an option from a <select> dropdown by CSS selector and option value.";
export declare function handleBrowserSelect(args: {
    selector: string;
    value: string;
    nthMatch?: number;
    sessionId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserPressSchema: {
    key: z.ZodString;
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserPressDescription = "Press a keyboard key or key combination. Supports modifiers like Control+A, Shift+Enter, etc.";
export declare function handleBrowserPress(args: {
    key: string;
    sessionId?: string;
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
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserScrollDescription: string;
export declare function handleBrowserScroll(args: {
    direction: string;
    distance?: number;
    selector?: string;
    sessionId?: string;
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
};
export declare const browserUploadDescription: string;
export declare function handleBrowserUpload(args: {
    selector: string;
    filePaths: string[];
    nthMatch?: number;
    sessionId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=browser-interact.d.ts.map