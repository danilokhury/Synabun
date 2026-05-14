/**
 * General-purpose image staging MCP tools.
 * Browse, list, and manage images in SynaBun's data/images/ directory.
 * Images arrive via paste in the Neural Interface chat area.
 * Any skill or tool can use staged images (Leonardo references, social posts, etc.).
 */
import { z } from 'zod';
export declare const imageStagedSchema: {
    action: z.ZodEnum<["list", "clear", "remove"]>;
    filename: z.ZodOptional<z.ZodString>;
    type: z.ZodOptional<z.ZodEnum<["all", "attachment", "screenshot", "whiteboard", "paste"]>>;
};
export declare const imageStagedDescription: string;
export declare function handleImageStaged(args: {
    action: string;
    filename?: string;
    type?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=image-tools.d.ts.map