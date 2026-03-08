import { z } from 'zod';
import * as discord from '../services/discord.js';
export const discordGuildSchema = {
    action: z.enum(['info', 'channels', 'members', 'roles', 'audit_log'])
        .describe('Action: info (server details), channels (list all), members (list), roles (list all), audit_log (recent actions).'),
    guild_id: z.string().optional()
        .describe('Guild ID. Defaults to DISCORD_GUILD_ID env var.'),
    limit: z.number().optional()
        .describe('Max results for members/audit_log (default 50).'),
    action_type: z.number().optional()
        .describe('Audit log action type filter (audit_log only).'),
};
export const discordGuildDescription = 'Discord server overview and listing. Actions: info, channels, members, roles, audit_log.';
// ── Info ───────────────────────────────────────────────────────
async function handleInfo(guildId) {
    const res = await discord.getGuild(guildId);
    if (res.error)
        return { content: [{ type: 'text', text: res.error }] };
    const g = res.data;
    const verificationNames = ['None', 'Low', 'Medium', 'High', 'Very High'];
    const boostTiers = ['None', 'Tier 1', 'Tier 2', 'Tier 3'];
    const lines = [
        `**${g.name}** (${g.id})`,
        g.description ? `Description: ${g.description}` : null,
        `Members: ${g.approximate_member_count || g.member_count || 'unknown'}`,
        `Owner: ${g.owner_id}`,
        `Verification: ${verificationNames[g.verification_level] || g.verification_level}`,
        `Boost Tier: ${boostTiers[g.premium_tier] || g.premium_tier}`,
        `Locale: ${g.preferred_locale}`,
        g.features.length > 0 ? `Features: ${g.features.join(', ')}` : null,
    ].filter(Boolean).join('\n');
    return { content: [{ type: 'text', text: lines }] };
}
// ── Channels ───────────────────────────────────────────────────
async function handleChannels(guildId) {
    const channels = await discord.getGuildChannels(guildId);
    if ('error' in channels)
        return { content: [{ type: 'text', text: channels.error }] };
    const list = channels;
    // Group by category
    const categories = list.filter(c => c.type === 4).sort((a, b) => a.position - b.position);
    const uncategorized = list.filter(c => c.type !== 4 && !c.parent_id).sort((a, b) => a.position - b.position);
    const lines = [];
    if (uncategorized.length > 0) {
        lines.push('**No Category:**');
        for (const ch of uncategorized) {
            const typeName = discord.CHANNEL_TYPE_NAMES[ch.type] || 'unknown';
            lines.push(`  #${ch.name} (${typeName}, ${ch.id})${ch.topic ? ` — ${ch.topic}` : ''}`);
        }
        lines.push('');
    }
    for (const cat of categories) {
        const children = list.filter(c => c.parent_id === cat.id).sort((a, b) => a.position - b.position);
        lines.push(`**${cat.name}** (category, ${cat.id})`);
        if (children.length === 0) {
            lines.push('  (empty)');
        }
        else {
            for (const ch of children) {
                const typeName = discord.CHANNEL_TYPE_NAMES[ch.type] || 'unknown';
                lines.push(`  #${ch.name} (${typeName}, ${ch.id})${ch.topic ? ` — ${ch.topic}` : ''}`);
            }
        }
        lines.push('');
    }
    return { content: [{ type: 'text', text: `Guild channels (${list.length} total):\n\n${lines.join('\n')}` }] };
}
// ── Members ────────────────────────────────────────────────────
async function handleMembers(guildId, limit) {
    const res = await discord.getGuildMembers(guildId, limit);
    if (res.error)
        return { content: [{ type: 'text', text: res.error }] };
    const members = res.data;
    const lines = members.map(m => {
        const name = m.nick || m.user.global_name || m.user.username;
        const tag = `@${m.user.username}`;
        const bot = m.user.bot ? ' [BOT]' : '';
        const roles = m.roles.length > 0 ? ` (${m.roles.length} roles)` : '';
        return `  ${name} (${tag}, ${m.user.id})${bot}${roles}`;
    });
    return { content: [{ type: 'text', text: `Guild members (${members.length}):\n${lines.join('\n')}` }] };
}
// ── Roles ──────────────────────────────────────────────────────
async function handleRoles(guildId) {
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
    return { content: [{ type: 'text', text: `Guild roles (${list.length}):\n${lines.join('\n')}` }] };
}
// ── Audit Log ──────────────────────────────────────────────────
async function handleAuditLog(guildId, limit, actionType) {
    const res = await discord.getAuditLog(guildId, { limit, action_type: actionType });
    if (res.error)
        return { content: [{ type: 'text', text: res.error }] };
    const log = res.data;
    const entries = log.audit_log_entries || [];
    if (entries.length === 0) {
        return { content: [{ type: 'text', text: 'No audit log entries found.' }] };
    }
    const lines = entries.map(e => {
        const changes = e.changes?.map(c => `${c.key}: ${JSON.stringify(c.old_value)} → ${JSON.stringify(c.new_value)}`).join(', ') || '';
        return `  [${e.action_type}] by ${e.user_id} → ${e.target_id || 'N/A'}${e.reason ? ` (${e.reason})` : ''}${changes ? `\n    ${changes}` : ''}`;
    });
    return { content: [{ type: 'text', text: `Audit log (${entries.length} entries):\n${lines.join('\n')}` }] };
}
// ── Main dispatcher ────────────────────────────────────────────
export async function handleDiscordGuild(args) {
    const resolved = await discord.resolveGuildId(args.guild_id);
    if ('error' in resolved)
        return { content: [{ type: 'text', text: resolved.error }] };
    const guildId = resolved.guildId;
    const limit = args.limit || 50;
    switch (args.action) {
        case 'info': return handleInfo(guildId);
        case 'channels': return handleChannels(guildId);
        case 'members': return handleMembers(guildId, limit);
        case 'roles': return handleRoles(guildId);
        case 'audit_log': return handleAuditLog(guildId, limit, args.action_type);
        default:
            return { content: [{ type: 'text', text: `Unknown action "${args.action}". Use: info, channels, members, roles, audit_log.` }] };
    }
}
//# sourceMappingURL=discord-guild.js.map