import { z } from 'zod';
export declare function buildMemoriesSchema(): {
    action: z.ZodEnum<["recent", "stats", "by-category", "by-project"]>;
    category: z.ZodOptional<z.ZodString>;
    project: z.ZodOptional<z.ZodString>;
    limit: z.ZodOptional<z.ZodNumber>;
};
export declare const memoriesSchema: {
    action: z.ZodEnum<["recent", "stats", "by-category", "by-project"]>;
    category: z.ZodOptional<z.ZodString>;
    project: z.ZodOptional<z.ZodString>;
    limit: z.ZodOptional<z.ZodNumber>;
};
export declare const memoriesDescription = "Browse recent memories or get statistics. Use this to see what you remember about a project, review recent learnings, or check memory health.";
export declare function handleMemories(args: {
    action: string;
    category?: string;
    project?: string;
    limit?: number;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=memories.d.ts.map