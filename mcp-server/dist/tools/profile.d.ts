import { z } from 'zod';
export declare const profileSchema: {
    action: z.ZodEnum<["get", "set"]>;
    profile: z.ZodOptional<z.ZodString>;
};
export declare const profileDescription = "Switch MCP tool profiles at runtime without restarting. Use \"get\" to see current profile and available presets. Use \"set\" to enable/disable tool groups dynamically \u2014 the client will be notified of the tool list change.";
export declare function handleProfile(args: {
    action: string;
    profile?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=profile.d.ts.map