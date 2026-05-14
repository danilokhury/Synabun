import { z } from 'zod';
export declare const syncSchema: {
    project: z.ZodOptional<z.ZodString>;
    categories: z.ZodOptional<z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], unknown>>;
    limit: z.ZodOptional<z.ZodNumber>;
};
export declare const syncDescription = "Check for stale memories whose related files have changed. Compares stored file checksums against current hashes. Returns compact output (ID + changed files only, no content). IMPORTANT: Always pass \"categories\" to scope the scan \u2014 calling without categories scans ALL memories and may produce output too large to return inline. For large memory sets, call iteratively per category rather than globally. Default limit is 50; increase only when using a narrow category filter.";
export declare function handleSync(args: {
    project?: string;
    categories?: string[];
    limit?: number;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=sync.d.ts.map