import { z } from 'zod';
export declare const restoreSchema: {
    memory_id: z.ZodString;
};
export declare const restoreDescription = "Restore a trashed memory by ID. Use this to undo a forget operation.";
export declare function handleRestore(args: {
    memory_id: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=restore.d.ts.map