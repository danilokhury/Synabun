import { z } from 'zod';
export declare const loopSchema: {
    action: z.ZodEnum<["start", "stop", "status"]>;
    task: z.ZodOptional<z.ZodString>;
    iterations: z.ZodOptional<z.ZodNumber>;
    max_minutes: z.ZodOptional<z.ZodNumber>;
    context: z.ZodOptional<z.ZodString>;
    session_id: z.ZodOptional<z.ZodString>;
    template: z.ZodOptional<z.ZodString>;
};
export declare const loopDescription = "Autonomous loop control. Start a repeating task loop, check status, or stop it. The Stop hook drives iteration \u2014 each time Claude finishes, the hook blocks and injects the next iteration.";
export declare function handleLoop(args: {
    action: string;
    task?: string;
    iterations?: number;
    max_minutes?: number;
    context?: string;
    session_id?: string;
    template?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=loop.d.ts.map