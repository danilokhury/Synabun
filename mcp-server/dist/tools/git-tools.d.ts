import { z } from 'zod';
export declare const gitSchema: {
    action: z.ZodEnum<["status", "diff", "commit", "log", "branches"]>;
    path: z.ZodString;
    message: z.ZodOptional<z.ZodString>;
    files: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    max_lines: z.ZodOptional<z.ZodNumber>;
    count: z.ZodOptional<z.ZodNumber>;
};
export declare const gitDescription = "Git repository operations. Actions: \"status\" shows branch and changed files, \"diff\" returns raw diff content for analysis, \"commit\" stages and commits with a message, \"log\" shows recent commit history, \"branches\" lists all branches. Use \"diff\" to analyze changes before generating commit messages.";
export declare function handleGit(args: {
    action: string;
    path: string;
    message?: string;
    files?: string[];
    max_lines?: number;
    count?: number;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=git-tools.d.ts.map