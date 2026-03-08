import { z } from 'zod';
export declare const discordMemberSchema: {
    action: z.ZodEnum<["info", "kick", "ban", "unban", "timeout", "nickname"]>;
    guild_id: z.ZodOptional<z.ZodString>;
    member: z.ZodString;
    reason: z.ZodOptional<z.ZodString>;
    duration: z.ZodOptional<z.ZodNumber>;
    nickname: z.ZodOptional<z.ZodString>;
    delete_days: z.ZodOptional<z.ZodNumber>;
};
export declare const discordMemberDescription = "Discord member moderation. Actions: info, kick, ban, unban, timeout, nickname.";
export declare function handleDiscordMember(args: {
    action: string;
    guild_id?: string;
    member: string;
    reason?: string;
    duration?: number;
    nickname?: string;
    delete_days?: number;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=discord-member.d.ts.map