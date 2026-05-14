import { z } from 'zod';
export declare const discordOnboardingSchema: {
    action: z.ZodEnum<["get", "set_welcome", "set_rules", "set_verification", "set_onboarding"]>;
    guild_id: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    welcome_channels: z.ZodOptional<z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>, "many">>;
    rules_channel: z.ZodOptional<z.ZodString>;
    system_channel: z.ZodOptional<z.ZodString>;
    verification_level: z.ZodOptional<z.ZodEnum<["none", "low", "medium", "high", "very_high"]>>;
    prompts: z.ZodOptional<z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>, "many">>;
    default_channels: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    enabled: z.ZodOptional<z.ZodBoolean>;
};
export declare const discordOnboardingDescription = "Discord server onboarding and setup. Actions: get, set_welcome, set_rules, set_verification, set_onboarding.";
export declare function handleDiscordOnboarding(args: {
    action: string;
    guild_id?: string;
    description?: string;
    welcome_channels?: Record<string, unknown>[];
    rules_channel?: string;
    system_channel?: string;
    verification_level?: string;
    prompts?: Record<string, unknown>[];
    default_channels?: string[];
    enabled?: boolean;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=discord-onboarding.d.ts.map