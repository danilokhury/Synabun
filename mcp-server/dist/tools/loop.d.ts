import { z } from 'zod';
export declare const loopSchema: {
    action: z.ZodEnum<["start", "stop", "status", "update"]>;
    task: z.ZodOptional<z.ZodString>;
    iterations: z.ZodOptional<z.ZodNumber>;
    max_minutes: z.ZodOptional<z.ZodNumber>;
    context: z.ZodOptional<z.ZodString>;
    session_id: z.ZodOptional<z.ZodString>;
    template: z.ZodOptional<z.ZodString>;
    summary: z.ZodOptional<z.ZodString>;
    progress: z.ZodOptional<z.ZodString>;
};
export declare const loopDescription = "Autonomous loop control. Start a repeating task loop, check status, update progress journal, or stop it. The Stop hook drives iteration. Call \"update\" after each iteration with a brief summary to maintain context across compactions.";
export declare function handleLoop(args: {
    action: string;
    task?: string;
    iterations?: number;
    max_minutes?: number;
    context?: string;
    session_id?: string;
    template?: string;
    summary?: string;
    progress?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=loop.d.ts.map