import { z } from 'zod';
export declare function buildRememberSchema(): {
    content: z.ZodString;
    category: z.ZodString;
    project: z.ZodOptional<z.ZodString>;
    tags: z.ZodOptional<z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], unknown>>;
    importance: z.ZodOptional<z.ZodNumber>;
    subcategory: z.ZodOptional<z.ZodString>;
    source: z.ZodOptional<z.ZodEnum<["user-told", "self-discovered", "auto-saved"]>>;
    related_files: z.ZodOptional<z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], unknown>>;
};
export declare const rememberSchema: {
    content: z.ZodString;
    category: z.ZodString;
    project: z.ZodOptional<z.ZodString>;
    tags: z.ZodOptional<z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], unknown>>;
    importance: z.ZodOptional<z.ZodNumber>;
    subcategory: z.ZodOptional<z.ZodString>;
    source: z.ZodOptional<z.ZodEnum<["user-told", "self-discovered", "auto-saved"]>>;
    related_files: z.ZodOptional<z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], unknown>>;
};
export declare const rememberDescription = "Store a piece of information in persistent memory. Use this when you learn something important, make a decision, discover a pattern, fix a hard bug, or want to preserve context for future sessions.";
export declare function handleRemember(args: {
    content: string;
    category: string;
    project?: string;
    tags?: string[];
    importance?: number;
    subcategory?: string;
    source?: string;
    related_files?: string[];
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=remember.d.ts.map