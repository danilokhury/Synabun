import { z } from 'zod';
export declare const cardListSchema: {};
export declare const cardListDescription = "List all currently open memory cards in the Neural Interface. Returns each card's memory UUID, position, size, compact/pin state, content preview, and the current viewport dimensions (width x height). Use this before placing cards to know the available screen size.";
export declare function handleCardList(): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const cardOpenSchema: {
    memoryId: z.ZodString;
    coordMode: z.ZodOptional<z.ZodEnum<["px", "pct"]>>;
    left: z.ZodOptional<z.ZodNumber>;
    top: z.ZodOptional<z.ZodNumber>;
    compact: z.ZodOptional<z.ZodBoolean>;
};
export declare const cardOpenDescription = "Open a memory as a floating card in the Neural Interface. Use card_list first to see viewport size.\n\nCoordinate modes (coordMode): \"px\" (default) = absolute pixels. \"pct\" = percentage of viewport (0-100), e.g. left:50 top:50 = center of screen.\n\nIf the card is already open, it is brought to the front. Omit left/top for auto-cascade positioning.";
export declare function handleCardOpen(args: {
    memoryId: string;
    coordMode?: string;
    left?: number;
    top?: number;
    compact?: boolean;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const cardCloseSchema: {
    memoryId: z.ZodOptional<z.ZodString>;
};
export declare const cardCloseDescription = "Close a memory card by its UUID, or close all open cards if no memoryId is provided. Use card_list first to see which cards are open.";
export declare function handleCardClose(args: {
    memoryId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const cardUpdateSchema: {
    memoryId: z.ZodString;
    coordMode: z.ZodOptional<z.ZodEnum<["px", "pct"]>>;
    left: z.ZodOptional<z.ZodNumber>;
    top: z.ZodOptional<z.ZodNumber>;
    width: z.ZodOptional<z.ZodNumber>;
    height: z.ZodOptional<z.ZodNumber>;
    compact: z.ZodOptional<z.ZodBoolean>;
    pinned: z.ZodOptional<z.ZodBoolean>;
};
export declare const cardUpdateDescription = "Update an open memory card's position, size, compact/expand state, or pin state. Set coordMode to \"pct\" to use percentage-based positioning. Only specified fields are changed; others remain untouched. Changes appear in real-time.";
export declare function handleCardUpdate(args: {
    memoryId: string;
    coordMode?: string;
    left?: number;
    top?: number;
    width?: number;
    height?: number;
    compact?: boolean;
    pinned?: boolean;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const cardScreenshotSchema: {};
export declare const cardScreenshotDescription = "Take a visual screenshot of the Neural Interface showing all open memory cards in their current positions. Returns a JPEG image. Requires the Neural Interface to be open in a browser.";
export declare function handleCardScreenshot(): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
} | {
    content: {
        type: "image";
        data: string;
        mimeType: string;
    }[];
}>;
//# sourceMappingURL=card-tools.d.ts.map