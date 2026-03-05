import { z } from 'zod';
export declare function buildRecallSchema(): {
    query: z.ZodString;
    category: z.ZodOptional<z.ZodString>;
    project: z.ZodOptional<z.ZodString>;
    tags: z.ZodOptional<z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], unknown>>;
    limit: z.ZodOptional<z.ZodNumber>;
    min_importance: z.ZodOptional<z.ZodNumber>;
    min_score: z.ZodOptional<z.ZodNumber>;
    include_sessions: z.ZodOptional<z.ZodBoolean>;
};
export declare const recallSchema: {
    query: z.ZodString;
    category: z.ZodOptional<z.ZodString>;
    project: z.ZodOptional<z.ZodString>;
    tags: z.ZodOptional<z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], unknown>>;
    limit: z.ZodOptional<z.ZodNumber>;
    min_importance: z.ZodOptional<z.ZodNumber>;
    min_score: z.ZodOptional<z.ZodNumber>;
    include_sessions: z.ZodOptional<z.ZodBoolean>;
};
export declare const recallDescription = "Search your persistent memory for relevant information. Use this at the start of any task to check what you already know, or when you need context about past decisions, known issues, or architectural patterns.";
export declare function handleRecall(args: {
    query: string;
    category?: string;
    project?: string;
    tags?: string[];
    limit?: number;
    min_importance?: number;
    min_score?: number;
    include_sessions?: boolean;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=recall.d.ts.map