import { z } from 'zod';
export declare const discordChannelSchema: {
    action: z.ZodEnum<["create", "edit", "delete", "list", "permissions"]>;
    guild_id: z.ZodOptional<z.ZodString>;
    channel: z.ZodOptional<z.ZodString>;
    name: z.ZodOptional<z.ZodString>;
    type: z.ZodOptional<z.ZodEnum<["text", "voice", "category", "announcement", "forum", "stage"]>>;
    topic: z.ZodOptional<z.ZodString>;
    parent: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodNumber>;
    nsfw: z.ZodOptional<z.ZodBoolean>;
    slowmode: z.ZodOptional<z.ZodNumber>;
    bitrate: z.ZodOptional<z.ZodNumber>;
    user_limit: z.ZodOptional<z.ZodNumber>;
    target: z.ZodOptional<z.ZodString>;
    allow: z.ZodOptional<z.ZodString>;
    deny: z.ZodOptional<z.ZodString>;
    reason: z.ZodOptional<z.ZodString>;
};
export declare const discordChannelDescription = "Discord channel management. Actions: create, edit, delete, list, permissions. Handles text, voice, categories, forums, stages.";
export declare function handleDiscordChannel(args: {
    action: string;
    guild_id?: string;
    channel?: string;
    name?: string;
    type?: string;
    topic?: string;
    parent?: string;
    position?: number;
    nsfw?: boolean;
    slowmode?: number;
    bitrate?: number;
    user_limit?: number;
    target?: string;
    allow?: string;
    deny?: string;
    reason?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=discord-channel.d.ts.map