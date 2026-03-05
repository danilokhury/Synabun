import { z } from 'zod';
export declare const whiteboardReadSchema: {};
export declare const whiteboardReadDescription = "Read the current whiteboard state. Returns element descriptions with IDs, positions, and properties, plus the current viewport dimensions (width x height in pixels). Use this before placing elements to know the available canvas size.";
export declare function handleWhiteboardRead(): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const whiteboardAddSchema: {
    coordMode: z.ZodOptional<z.ZodEnum<["px", "pct"]>>;
    layout: z.ZodOptional<z.ZodEnum<["row", "column", "grid", "center"]>>;
    elements: z.ZodArray<z.ZodObject<{
        type: z.ZodEnum<["text", "list", "shape", "arrow", "pen", "image"]>;
        x: z.ZodOptional<z.ZodNumber>;
        y: z.ZodOptional<z.ZodNumber>;
        width: z.ZodOptional<z.ZodNumber>;
        height: z.ZodOptional<z.ZodNumber>;
        content: z.ZodOptional<z.ZodString>;
        items: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        ordered: z.ZodOptional<z.ZodBoolean>;
        fontSize: z.ZodOptional<z.ZodNumber>;
        color: z.ZodOptional<z.ZodString>;
        bold: z.ZodOptional<z.ZodBoolean>;
        italic: z.ZodOptional<z.ZodBoolean>;
        shape: z.ZodOptional<z.ZodEnum<["rect", "pill", "circle", "drawn-circle"]>>;
        points: z.ZodOptional<z.ZodArray<z.ZodArray<z.ZodNumber, "many">, "many">>;
        startAnchor: z.ZodOptional<z.ZodString>;
        endAnchor: z.ZodOptional<z.ZodString>;
        strokeWidth: z.ZodOptional<z.ZodNumber>;
        rotation: z.ZodOptional<z.ZodNumber>;
        url: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: "text" | "list" | "image" | "shape" | "arrow" | "pen";
        bold?: boolean | undefined;
        color?: string | undefined;
        content?: string | undefined;
        url?: string | undefined;
        y?: number | undefined;
        italic?: boolean | undefined;
        shape?: "rect" | "pill" | "circle" | "drawn-circle" | undefined;
        x?: number | undefined;
        width?: number | undefined;
        height?: number | undefined;
        items?: string[] | undefined;
        ordered?: boolean | undefined;
        fontSize?: number | undefined;
        points?: number[][] | undefined;
        startAnchor?: string | undefined;
        endAnchor?: string | undefined;
        strokeWidth?: number | undefined;
        rotation?: number | undefined;
    }, {
        type: "text" | "list" | "image" | "shape" | "arrow" | "pen";
        bold?: boolean | undefined;
        color?: string | undefined;
        content?: string | undefined;
        url?: string | undefined;
        y?: number | undefined;
        italic?: boolean | undefined;
        shape?: "rect" | "pill" | "circle" | "drawn-circle" | undefined;
        x?: number | undefined;
        width?: number | undefined;
        height?: number | undefined;
        items?: string[] | undefined;
        ordered?: boolean | undefined;
        fontSize?: number | undefined;
        points?: number[][] | undefined;
        startAnchor?: string | undefined;
        endAnchor?: string | undefined;
        strokeWidth?: number | undefined;
        rotation?: number | undefined;
    }>, "many">;
};
export declare const whiteboardAddDescription = "Add elements to the whiteboard. Use whiteboard_read first to see current viewport size.\n\nCoordinate modes (coordMode): \"px\" (default) = absolute pixels from top-left. \"pct\" = percentage of viewport (0-100), e.g. x:50 y:50 = center of whiteboard.\n\nAuto-layout (layout): overrides individual x/y. \"row\" = horizontal row centered vertically. \"column\" = vertical stack centered horizontally. \"grid\" = auto-grid (2-4 columns based on count). \"center\" = stacked in center.\n\nSupports: text (\\n for line breaks), list (items array), shape (rect/pill/circle/drawn-circle), arrow (points + optional anchoring), pen, image (server URL). Returns assigned IDs. Good defaults: text fontSize 22, list fontSize 18, shapes 160x100.";
export declare function handleWhiteboardAdd(args: {
    elements: Record<string, unknown>[];
    coordMode?: string;
    layout?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const whiteboardUpdateSchema: {
    coordMode: z.ZodOptional<z.ZodEnum<["px", "pct"]>>;
    id: z.ZodString;
    updates: z.ZodObject<{
        x: z.ZodOptional<z.ZodNumber>;
        y: z.ZodOptional<z.ZodNumber>;
        width: z.ZodOptional<z.ZodNumber>;
        height: z.ZodOptional<z.ZodNumber>;
        content: z.ZodOptional<z.ZodString>;
        items: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        ordered: z.ZodOptional<z.ZodBoolean>;
        fontSize: z.ZodOptional<z.ZodNumber>;
        color: z.ZodOptional<z.ZodString>;
        bold: z.ZodOptional<z.ZodBoolean>;
        italic: z.ZodOptional<z.ZodBoolean>;
        shape: z.ZodOptional<z.ZodEnum<["rect", "pill", "circle", "drawn-circle"]>>;
        points: z.ZodOptional<z.ZodArray<z.ZodArray<z.ZodNumber, "many">, "many">>;
        startAnchor: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        endAnchor: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        rotation: z.ZodOptional<z.ZodNumber>;
        strokeWidth: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        bold?: boolean | undefined;
        color?: string | undefined;
        content?: string | undefined;
        y?: number | undefined;
        italic?: boolean | undefined;
        shape?: "rect" | "pill" | "circle" | "drawn-circle" | undefined;
        x?: number | undefined;
        width?: number | undefined;
        height?: number | undefined;
        items?: string[] | undefined;
        ordered?: boolean | undefined;
        fontSize?: number | undefined;
        points?: number[][] | undefined;
        startAnchor?: string | null | undefined;
        endAnchor?: string | null | undefined;
        strokeWidth?: number | undefined;
        rotation?: number | undefined;
    }, {
        bold?: boolean | undefined;
        color?: string | undefined;
        content?: string | undefined;
        y?: number | undefined;
        italic?: boolean | undefined;
        shape?: "rect" | "pill" | "circle" | "drawn-circle" | undefined;
        x?: number | undefined;
        width?: number | undefined;
        height?: number | undefined;
        items?: string[] | undefined;
        ordered?: boolean | undefined;
        fontSize?: number | undefined;
        points?: number[][] | undefined;
        startAnchor?: string | null | undefined;
        endAnchor?: string | null | undefined;
        strokeWidth?: number | undefined;
        rotation?: number | undefined;
    }>;
};
export declare const whiteboardUpdateDescription = "Update properties of an existing whiteboard element. Use whiteboard_read first to get element IDs. Only the specified fields are changed; others remain untouched. Set coordMode to \"pct\" to use percentage-based positioning. Changes appear in real-time.";
export declare function handleWhiteboardUpdate(args: {
    id: string;
    updates: Record<string, unknown>;
    coordMode?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const whiteboardRemoveSchema: {
    id: z.ZodOptional<z.ZodString>;
};
export declare const whiteboardRemoveDescription = "Remove a specific element from the whiteboard by ID, or clear the entire whiteboard if no ID is provided. Use whiteboard_read first to see element IDs. Arrows anchored to a removed element will be detached.";
export declare function handleWhiteboardRemove(args: {
    id?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const whiteboardScreenshotSchema: {};
export declare const whiteboardScreenshotDescription = "Take a visual screenshot of the whiteboard. Returns a JPEG image showing all current elements. Requires the Neural Interface to be open in a browser with Focus mode active. After receiving the screenshot, spawn a Haiku Task agent to interpret the visual contents if needed.";
export declare function handleWhiteboardScreenshot(): Promise<{
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
//# sourceMappingURL=whiteboard-tools.d.ts.map