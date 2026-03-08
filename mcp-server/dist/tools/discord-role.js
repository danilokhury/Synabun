import { z } from 'zod';
import * as discord from '../services/discord.js';
export const discordRoleSchema = {
    action: z.enum(['create', 'edit', 'delete', 'list', 'assign', 'remove'])
        .describe('Action: create, edit, delete, list, assign (to member), remove (from member).'),
    guild_id: z.string().optional()
        .describe('Guild ID. Defaults to DISCORD_GUILD_ID env var.'),
    role: z.string().optional()
        .describe('Role name or ID (required for edit/delete/assign/remove).'),
    name: z.string().optional()
        .describe('Role name (create required, edit optional).'),
    color: z.string().optional()
        .describe('Hex color e.g. "#ff0000" (create/edit).'),
    hoist: z.boolean().optional()
        .describe('Display separately in sidebar (create/edit).'),
    mentionable: z.boolean().optional()
        .describe('Allow @mention by anyone (create/edit).'),
    permissions: z.string().optional()
        .describe('Permission flags, comma-separated (create/edit). E.g. "SEND_MESSAGES,MANAGE_CHANNELS".'),
    position: z.number().optional()
        .describe('Sort position (edit only).'),
    member: z.string().optional()
        .describe('User name or ID (assign/remove actions).'),
    reason: z.string().optional()
        .describe('Audit log reason.'),
};
export const discordRoleDescription = 'Discord role management. Actions: create, edit, delete, list, assign (role to member), remove (role from member).';
// ── Create ─────────────────────────────────────────────────────
async function handleCreate(guildId, args) {
    if (!args.name) {
        return { content: [{ type: 'text', text: 'name is required for create action.' }] };
    }
    const data = { name: args.name };
    if (args.color) {
        const hex = args.color.replace('#', '');
        data.color = parseInt(hex, 16);
    }
    if (args.hoist !== undefined)
        data.hoist = args.hoist;
    if (args.mentionable !== undefined)
        data.mentionable = args.mentionable;
    if (args.permissions) {
        try {
            data.permissions = discord.resolvePermissions(args.permissions);
        }
        catch (err) {
            return { content: [{ type: 'text', text: err.message }] };
        }
    }
    const res = await discord.createRole(guildId, data);
    if (res.error)
        return { content: [{ type: 'text', text: res.error }] };
    const role = res.data;
    const colorStr = role.color ? ` #${role.color.toString(16).padStart(6, '0')}` : '';
    return { content: [{ type: 'text', text: `Created role @${role.name} (${role.id})${colorStr}` }] };
}
// ── Edit ───────────────────────────────────────────────────────
async function handleEdit(guildId, args) {
    if (!args.role) {
        return { content: [{ type: 'text', text: 'role is required for edit action.' }] };
    }
    const resolved = await discord.resolveRole(args.role, guildId);
    if ('error' in resolved)
        return { content: [{ type: 'text', text: resolved.error }] };
    const data = {};
    if (args.name !== undefined)
        data.name = args.name;
    if (args.color !== undefined) {
        const hex = args.color.replace('#', '');
        data.color = parseInt(hex, 16);
    }
    if (args.hoist !== undefined)
        data.hoist = args.hoist;
    if (args.mentionable !== undefined)
        data.mentionable = args.mentionable;
    if (args.permissions) {
        try {
            data.permissions = discord.resolvePermissions(args.permissions);
        }
        catch (err) {
            return { content: [{ type: 'text', text: err.message }] };
        }
    }
    if (Object.keys(data).length === 0 && args.position === undefined) {
        return { content: [{ type: 'text', text: 'No changes specified.' }] };
    }
    const res = await discord.editRole(guildId, resolved.id, data);
    if (res.error)
        return { content: [{ type: 'text', text: res.error }] };
    return { content: [{ type: 'text', text: `Updated role @${resolved.name} (${resolved.id}).` }] };
}
// ── Delete ─────────────────────────────────────────────────────
async function handleDelete(guildId, args) {
    if (!args.role) {
        return { content: [{ type: 'text', text: 'role is required for delete action.' }] };
    }
    const resolved = await discord.resolveRole(args.role, guildId);
    if ('error' in resolved)
        return { content: [{ type: 'text', text: resolved.error }] };
    const res = await discord.deleteRole(guildId, resolved.id);
    if (res.error)
        return { content: [{ type: 'text', text: res.error }] };
    return { content: [{ type: 'text', text: `Deleted role @${resolved.name} (${resolved.id}).` }] };
}
// ── List ───────────────────────────────────────────────────────
async function handleList(guildId) {
    const roles = await discord.getGuildRoles(guildId);
    if ('error' in roles)
        return { content: [{ type: 'text', text: roles.error }] };
    const list = roles
        .sort((a, b) => b.position - a.position);
    const lines = list.map(r => {
        const color = r.color ? ` #${r.color.toString(16).padStart(6, '0')}` : '';
        const flags = [];
        if (r.hoist)
            flags.push('hoisted');
        if (r.mentionable)
            flags.push('mentionable');
        if (r.managed)
            flags.push('managed');
        const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
        return `  @${r.name} (${r.id})${color}${flagStr}`;
    });
    return { content: [{ type: 'text', text: `Roles (${list.length}):\n${lines.join('\n')}` }] };
}
// ── Assign ─────────────────────────────────────────────────────
async function handleAssign(guildId, args) {
    if (!args.role)
        return { content: [{ type: 'text', text: 'role is required for assign action.' }] };
    if (!args.member)
        return { content: [{ type: 'text', text: 'member is required for assign action.' }] };
    const roleResolved = await discord.resolveRole(args.role, guildId);
    if ('error' in roleResolved)
        return { content: [{ type: 'text', text: roleResolved.error }] };
    const userResolved = await discord.resolveUser(args.member, guildId);
    if ('error' in userResolved)
        return { content: [{ type: 'text', text: userResolved.error }] };
    const res = await discord.addMemberRole(guildId, userResolved.id, roleResolved.id);
    if (res.error)
        return { content: [{ type: 'text', text: res.error }] };
    return { content: [{ type: 'text', text: `Assigned @${roleResolved.name} to ${userResolved.name}.` }] };
}
// ── Remove ─────────────────────────────────────────────────────
async function handleRemove(guildId, args) {
    if (!args.role)
        return { content: [{ type: 'text', text: 'role is required for remove action.' }] };
    if (!args.member)
        return { content: [{ type: 'text', text: 'member is required for remove action.' }] };
    const roleResolved = await discord.resolveRole(args.role, guildId);
    if ('error' in roleResolved)
        return { content: [{ type: 'text', text: roleResolved.error }] };
    const userResolved = await discord.resolveUser(args.member, guildId);
    if ('error' in userResolved)
        return { content: [{ type: 'text', text: userResolved.error }] };
    const res = await discord.removeMemberRole(guildId, userResolved.id, roleResolved.id);
    if (res.error)
        return { content: [{ type: 'text', text: res.error }] };
    return { content: [{ type: 'text', text: `Removed @${roleResolved.name} from ${userResolved.name}.` }] };
}
// ── Main dispatcher ────────────────────────────────────────────
export async function handleDiscordRole(args) {
    const resolved = await discord.resolveGuildId(args.guild_id);
    if ('error' in resolved)
        return { content: [{ type: 'text', text: resolved.error }] };
    const guildId = resolved.guildId;
    switch (args.action) {
        case 'create': return handleCreate(guildId, args);
        case 'edit': return handleEdit(guildId, args);
        case 'delete': return handleDelete(guildId, args);
        case 'list': return handleList(guildId);
        case 'assign': return handleAssign(guildId, args);
        case 'remove': return handleRemove(guildId, args);
        default:
            return { content: [{ type: 'text', text: `Unknown action "${args.action}". Use: create, edit, delete, list, assign, remove.` }] };
    }
}
//# sourceMappingURL=discord-role.js.map