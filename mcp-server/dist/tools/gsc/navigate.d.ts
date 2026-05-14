/**
 * GSC navigation + property management.
 * Tools: gsc_navigate, gsc_property
 */
import { z } from 'zod';
export declare const gscNavigateSchema: {
    page: z.ZodEnum<[string, ...string[]]>;
    property: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const gscNavigateDescription: string;
export declare function handleGscNavigate(args: {
    page: string;
    property?: string;
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const gscPropertySchema: {
    action: z.ZodEnum<["list", "select", "current", "add"]>;
    property: z.ZodOptional<z.ZodString>;
    type: z.ZodOptional<z.ZodEnum<["domain", "url_prefix"]>>;
    sessionId: z.ZodOptional<z.ZodString>;
    tabId: z.ZodOptional<z.ZodString>;
};
export declare const gscPropertyDescription: string;
export declare function handleGscProperty(args: {
    action: string;
    property?: string;
    type?: string;
    sessionId?: string;
    tabId?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=navigate.d.ts.map