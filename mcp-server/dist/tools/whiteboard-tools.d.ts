import { z } from 'zod';
export declare const whiteboardReadSchema: {};
export declare const whiteboardReadDescription = "Read the current whiteboard state. Returns element descriptions with IDs, positions, and properties, plus the usable viewport dimensions (width x height in pixels, excluding navbar and terminal). ALWAYS call this before placing elements \u2014 the viewport tells you the exact canvas boundaries. All elements must fit within these dimensions.";
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
        type: z.ZodEnum<["text", "list", "shape", "arrow", "pen", "image", "section"]>;
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
        sectionType: z.ZodOptional<z.ZodEnum<["navbar", "hero", "sidebar", "content", "footer", "card", "form", "image-placeholder", "button", "text-block", "grid", "modal"]>>;
        label: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: "text" | "list" | "image" | "shape" | "arrow" | "pen" | "section";
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
        sectionType?: "content" | "grid" | "navbar" | "hero" | "sidebar" | "footer" | "card" | "form" | "image-placeholder" | "button" | "text-block" | "modal" | undefined;
        label?: string | undefined;
    }, {
        type: "text" | "list" | "image" | "shape" | "arrow" | "pen" | "section";
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
        sectionType?: "content" | "grid" | "navbar" | "hero" | "sidebar" | "footer" | "card" | "form" | "image-placeholder" | "button" | "text-block" | "modal" | undefined;
        label?: string | undefined;
    }>, "many">;
};
export declare const whiteboardAddDescription = "Add elements to the whiteboard. ALWAYS call whiteboard_read first to get the usable viewport size.\n\n\u26A0\uFE0F LAYOUT RULES (MANDATORY):\n1. COMPACT DESIGN \u2014 Do NOT fill the entire viewport. Use ~70-80% of viewport width, centered horizontally. This creates a clean, contained wireframe.\n2. VERTICAL FIT \u2014 ALL elements MUST fit within the viewport height. Scale section heights proportionally if the total exceeds the available space. Leave ~20px padding from top and bottom edges.\n3. NO OVERFLOW \u2014 No element should extend beyond viewport edges. The viewport already excludes the navbar, toolbar, and terminal. Coordinates are auto-offset to the usable area.\n4. PROPORTIONAL SCALING \u2014 Section default sizes are for manual use. When building full-page wireframes via MCP, calculate heights as fractions of viewport height (e.g. navbar=6%, hero=30%, content=40%, footer=10%).\n\nCoordinate modes (coordMode): \"px\" (default) = absolute pixels. \"pct\" = percentage of usable viewport (0-100), e.g. x:10 y:5 = near top-left of usable area. Coordinates are automatically offset past the navbar and toolbar.\n\nAuto-layout (layout): overrides individual x/y. \"row\" = horizontal row centered vertically. \"column\" = vertical stack centered horizontally. \"grid\" = auto-grid (2-4 columns based on count). \"center\" = stacked in center. Layouts auto-fit within viewport.\n\nSupports: text (\\n for line breaks), list (items array), shape (rect/pill/circle/drawn-circle), arrow (points + optional anchoring), pen, image (server URL), section (wireframe blocks). Returns assigned IDs. Good defaults: text fontSize 22, list fontSize 18, shapes 160x100.\n\nWireframe sections (type \"section\"): Semantic website layout blocks. Set sectionType (navbar/hero/sidebar/content/footer/card/form/image-placeholder/button/text-block/grid/modal) and optional label. When using \"pct\" coordMode, set widths as % of viewport (e.g. 70 for 70%) and heights as % too. Center horizontally with x: 15 for a 70%-width element.";
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
        sectionType: z.ZodOptional<z.ZodEnum<["navbar", "hero", "sidebar", "content", "footer", "card", "form", "image-placeholder", "button", "text-block", "grid", "modal"]>>;
        label: z.ZodOptional<z.ZodString>;
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
        sectionType?: "content" | "grid" | "navbar" | "hero" | "sidebar" | "footer" | "card" | "form" | "image-placeholder" | "button" | "text-block" | "modal" | undefined;
        label?: string | undefined;
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
        sectionType?: "content" | "grid" | "navbar" | "hero" | "sidebar" | "footer" | "card" | "form" | "image-placeholder" | "button" | "text-block" | "modal" | undefined;
        label?: string | undefined;
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