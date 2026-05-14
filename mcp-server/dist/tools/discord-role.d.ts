import { z } from 'zod';
export declare const discordRoleSchema: {
    action: z.ZodEnum<["create", "edit", "delete", "list", "assign", "remove"]>;
    guild_id: z.ZodOptional<z.ZodString>;
    role: z.ZodOptional<z.ZodString>;
    name: z.ZodOptional<z.ZodString>;
    color: z.ZodOptional<z.ZodString>;
    hoist: z.ZodOptional<z.ZodBoolean>;
    mentionable: z.ZodOptional<z.ZodBoolean>;
    permissions: z.ZodOptional<z.ZodString>;
    position: z.ZodOptional<z.ZodNumber>;
    member: z.ZodOptional<z.ZodString>;
    reason: z.ZodOptional<z.ZodString>;
};
export declare const discordRoleDescription = "Discord role management. Actions: create, edit, delete, list, assign (role to member), remove (role from member).";
export declare function handleDiscordRole(args: {
    action: string;
    guild_id?: string;
    role?: string;
    name?: string;
    color?: string;
    hoist?: boolean;
    mentionable?: boolean;
    permissions?: string;
    position?: number;
    member?: string;
    reason?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=discord-role.d.ts.map