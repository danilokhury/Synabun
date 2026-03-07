import { z } from 'zod';
export declare const categorySchema: {
    action: z.ZodEnum<["create", "update", "delete", "list"]>;
    name: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    is_parent: z.ZodOptional<z.ZodBoolean>;
    parent: z.ZodOptional<z.ZodString>;
    color: z.ZodOptional<z.ZodString>;
    new_name: z.ZodOptional<z.ZodString>;
    reassign_to: z.ZodOptional<z.ZodString>;
    reassign_children_to: z.ZodOptional<z.ZodString>;
    format: z.ZodOptional<z.ZodEnum<["flat", "tree", "parents-only"]>>;
};
export declare const categoryDescription = "Manage memory categories. Actions: create, update, delete, list. Categories persist across sessions.";
export declare function handleCategory(args: {
    action: string;
    name?: string;
    description?: string;
    is_parent?: boolean;
    parent?: string;
    color?: string;
    new_name?: string;
    reassign_to?: string;
    reassign_children_to?: string;
    format?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=category.d.ts.map