import { z } from 'zod';
export declare function buildReflectSchema(): {
    memory_id: z.ZodString;
    content: z.ZodOptional<z.ZodString>;
    importance: z.ZodOptional<z.ZodNumber>;
    tags: z.ZodOptional<z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], unknown>>;
    add_tags: z.ZodOptional<z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], unknown>>;
    subcategory: z.ZodOptional<z.ZodString>;
    category: z.ZodOptional<z.ZodString>;
    related_files: z.ZodOptional<z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], unknown>>;
    related_memory_ids: z.ZodOptional<z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], unknown>>;
    project: z.ZodOptional<z.ZodString>;
};
export declare const reflectSchema: {
    memory_id: z.ZodString;
    content: z.ZodOptional<z.ZodString>;
    importance: z.ZodOptional<z.ZodNumber>;
    tags: z.ZodOptional<z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], unknown>>;
    add_tags: z.ZodOptional<z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], unknown>>;
    subcategory: z.ZodOptional<z.ZodString>;
    category: z.ZodOptional<z.ZodString>;
    related_files: z.ZodOptional<z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], unknown>>;
    related_memory_ids: z.ZodOptional<z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], unknown>>;
    project: z.ZodOptional<z.ZodString>;
};
export declare const reflectDescription = "Update or annotate an existing memory. Use this when you discover additional context, when a decision changes, or when you want to adjust importance based on new information.";
export declare function handleReflect(args: {
    memory_id: string;
    content?: string;
    importance?: number;
    tags?: string[];
    add_tags?: string[];
    subcategory?: string;
    category?: string;
    related_files?: string[];
    related_memory_ids?: string[];
    project?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=reflect.d.ts.map