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
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserFillDescription = "Clear an input field and fill it with new text. Accepts Playwright selectors: CSS, text=\"...\", :has-text(\"...\"), [data-testid=\"...\"]. Twitter/X: compose box is [data-testid=\"tweetTextarea_0\"], search is [data-testid=\"SearchBox_Search_Input\"]. TikTok search: [data-e2e=\"search-user-input\"]. WhatsApp search: input[aria-label=\"Pesquisar ou come\u00E7ar uma nova conversa\"].";
export declare function handleBrowserFill(args: {
    selector: string;
    value: string;
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
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserTypeDescription: string;
export declare function handleBrowserType(args: {
    selector?: string;
    text: string;
    sessionId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const browserHoverSchema: {
    selector: z.ZodString;
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserHoverDescription = "Hover over an element. Useful for revealing dropdowns, tooltips, or hover-triggered content. Accepts Playwright selectors.";
export declare function handleBrowserHover(args: {
    selector: string;
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
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserSelectDescription = "Select an option from a <select> dropdown by CSS selector and option value.";
export declare function handleBrowserSelect(args: {
    selector: string;
    value: string;
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
export declare const browserScrollDescription = "Scroll the page or a specific element. Essential for infinite scroll feeds. Twitter/X: direction \"down\" with distance 800\u20131500 to load more tweets. Facebook: use selector \"[role=\\\"feed\\\"]\" to scroll within the post feed. TikTok feed: scroll \"down\" 800\u20131000px to advance to the next video. TikTok comment panel: use selector \"[data-e2e=\\\"comment-list\\\"]\". TikTok Studio table: use selector \"[data-tt=\\\"components_PostTable_Container\\\"]\". WhatsApp chat list: use selector \"[aria-label=\\\"Lista de conversas\\\"]\". WhatsApp message history: scroll \"up\" to load older messages.";
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
    sessionId: z.ZodOptional<z.ZodString>;
};
export declare const browserUploadDescription: string;
export declare function handleBrowserUpload(args: {
    selector: string;
    filePaths: string[];
    sessionId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=browser-interact.d.ts.map