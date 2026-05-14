import { z } from 'zod';
export declare const discordWebhookSchema: {
    action: z.ZodEnum<["create", "edit", "delete", "list", "execute"]>;
    guild_id: z.ZodOptional<z.ZodString>;
    channel: z.ZodOptional<z.ZodString>;
    webhook_id: z.ZodOptional<z.ZodString>;
    webhook_token: z.ZodOptional<z.ZodString>;
    name: z.ZodOptional<z.ZodString>;
    avatar_url: z.ZodOptional<z.ZodString>;
    content: z.ZodOptional<z.ZodString>;
    username: z.ZodOptional<z.ZodString>;
    embeds: z.ZodOptional<z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>, "many">>;
};
export declare const discordWebhookDescription = "Discord webhook management. Actions: create, edit, delete, list, execute (send message as webhook).";
export declare function handleDiscordWebhook(args: {
    action: string;
    guild_id?: string;
    channel?: string;
    webhook_id?: string;
    webhook_token?: string;
    name?: string;
    avatar_url?: string;
    content?: string;
    username?: string;
    embeds?: Record<string, unknown>[];
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=discord-webhook.d.ts.map