import { z } from 'zod';
export declare const discordGuildSchema: {
    action: z.ZodEnum<["info", "channels", "members", "roles", "audit_log"]>;
    guild_id: z.ZodOptional<z.ZodString>;
    limit: z.ZodOptional<z.ZodNumber>;
    action_type: z.ZodOptional<z.ZodNumber>;
};
export declare const discordGuildDescription = "Discord server overview and listing. Actions: info, channels, members, roles, audit_log.";
export declare function handleDiscordGuild(args: {
    action: string;
    guild_id?: string;
    limit?: number;
    action_type?: number;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=discord-guild.d.ts.map