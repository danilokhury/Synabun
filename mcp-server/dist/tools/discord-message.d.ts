import { z } from 'zod';
export declare const discordMessageSchema: {
    action: z.ZodEnum<["send", "edit", "delete", "pin", "unpin", "react", "bulk_delete", "list"]>;
    guild_id: z.ZodOptional<z.ZodString>;
    channel: z.ZodString;
    content: z.ZodOptional<z.ZodString>;
    message_id: z.ZodOptional<z.ZodString>;
    embed: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    emoji: z.ZodOptional<z.ZodString>;
    message_ids: z.ZodOptional<z.ZodEffects<z.ZodArray<z.ZodString, "many">, string[], unknown>>;
    reply_to: z.ZodOptional<z.ZodString>;
    limit: z.ZodOptional<z.ZodNumber>;
    before: z.ZodOptional<z.ZodString>;
    after: z.ZodOptional<z.ZodString>;
};
export declare const discordMessageDescription = "Discord message operations. Actions: send, edit, delete, pin, unpin, react, bulk_delete, list.";
export declare function handleDiscordMessage(args: {
    action: string;
    guild_id?: string;
    channel: string;
    content?: string;
    message_id?: string;
    embed?: Record<string, unknown>;
    emoji?: string;
    message_ids?: string[];
    reply_to?: string;
    limit?: number;
    before?: string;
    after?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=discord-message.d.ts.map