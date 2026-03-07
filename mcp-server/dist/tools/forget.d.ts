import { z } from 'zod';
export declare const forgetSchema: {
    memory_id: z.ZodString;
};
export declare const forgetDescription = "Move a specific memory to trash by ID. The memory can be restored from the Neural Interface trash panel or via the restore tool. Use this to clean up outdated, incorrect, or superseded information.";
export declare function handleForget(args: {
    memory_id: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=forget.d.ts.map