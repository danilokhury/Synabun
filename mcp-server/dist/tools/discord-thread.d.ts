import { z } from 'zod';
export declare const discordThreadSchema: {
    action: z.ZodEnum<["create", "archive", "unarchive", "lock", "delete"]>;
    guild_id: z.ZodOptional<z.ZodString>;
    channel: z.ZodOptional<z.ZodString>;
    thread: z.ZodOptional<z.ZodString>;
    name: z.ZodOptional<z.ZodString>;
    message_id: z.ZodOptional<z.ZodString>;
    auto_archive: z.ZodOptional<z.ZodNumber>;
    private: z.ZodOptional<z.ZodBoolean>;
};
export declare const discordThreadDescription = "Discord thread management. Actions: create (from message or standalone), archive, unarchive, lock, delete.";
export declare function handleDiscordThread(args: {
    action: string;
    guild_id?: string;
    channel?: string;
    thread?: string;
    name?: string;
    message_id?: string;
    auto_archive?: number;
    private?: boolean;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=discord-thread.d.ts.map