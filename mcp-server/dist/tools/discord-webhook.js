import { z } from 'zod';
import * as discord from '../services/discord.js';
export const discordWebhookSchema = {
    action: z.enum(['create', 'edit', 'delete', 'list', 'execute'])
        .describe('Action: create, edit, delete, list, execute.'),
    guild_id: z.string().optional()
        .describe('Guild ID for channel name resolution. Defaults to DISCORD_GUILD_ID env var.'),
    channel: z.string().optional()
        .describe('Channel name or ID (required for create/list).'),
    webhook_id: z.string().optional()
        .describe('Webhook ID (required for edit/delete/execute).'),
    webhook_token: z.string().optional()
        .describe('Webhook token (required for execute).'),
    name: z.string().optional()
        .describe('Webhook name (create required, edit optional).'),
    avatar_url: z.string().optional()
        .describe('Avatar URL (create/edit).'),
    content: z.string().optional()
        .describe('Message content (execute).'),
    username: z.string().optional()
        .describe('Override display name (execute).'),
    embeds: z.array(z.record(z.unknown())).optional()
        .describe('Embeds array (execute). Each: {title?, description?, color?, fields?: [{name, value}]}.'),
};
export const discordWebhookDescription = 'Discord webhook management. Actions: create, edit, delete, list, execute (send message as webhook).';
// ── Create ─────────────────────────────────────────────────────
async function handleCreate(args) {
    if (!args.channel)
        return { content: [{ type: 'text', text: 'channel is required for create action.' }] };
    if (!args.name)
        return { content: [{ type: 'text', text: 'name is required for create action.' }] };
    let channelId = args.channel;
    if (!/^\d{17,20}$/.test(channelId)) {
        const resolved = await discord.resolveGuildId(args.guild_id);
        if ('error' in resolved)
            return { content: [{ type: 'text', text: resolved.error }] };
        const ch = await discord.resolveChannel(args.channel, resolved.guildId);
        if ('error' in ch)
            return { content: [{ type: 'text', text: ch.error }] };
        channelId = ch.id;
    }
    const data = { name: args.name };
    // Note: avatar in create expects base64 data URI, not URL. avatar_url is for execute override.
    const res = await discord.createWebhook(channelId, data);
    if (res.error)
        return { content: [{ type: 'text', text: res.error }] };
    const wh = res.data;
    return { content: [{ type: 'text', text: `Created webhook "${wh.name}" (${wh.id}) in <#${wh.channel_id}>.\nToken: ${wh.token}\nURL: https://discord.com/api/webhooks/${wh.id}/${wh.token}` }] };
}
// ── Edit ───────────────────────────────────────────────────────
async function handleEdit(args) {
    if (!args.webhook_id)
        return { content: [{ type: 'text', text: 'webhook_id is required for edit action.' }] };
    const data = {};
    if (args.name)
        data.name = args.name;
    if (args.channel) {
        let channelId = args.channel;
        if (!/^\d{17,20}$/.test(channelId)) {
            const resolved = await discord.resolveGuildId(args.guild_id);
            if ('error' in resolved)
                return { content: [{ type: 'text', text: resolved.error }] };
            const ch = await discord.resolveChannel(args.channel, resolved.guildId);
            if ('error' in ch)
                return { content: [{ type: 'text', text: ch.error }] };
            channelId = ch.id;
        }
        data.channel_id = channelId;
    }
    const res = await discord.editWebhook(args.webhook_id, data);
    if (res.error)
        return { content: [{ type: 'text', text: res.error }] };
    return { content: [{ type: 'text', text: `Updated webhook ${args.webhook_id}.` }] };
}
// ── Delete ─────────────────────────────────────────────────────
async function handleDelete(args) {
    if (!args.webhook_id)
        return { content: [{ type: 'text', text: 'webhook_id is required for delete action.' }] };
    const res = await discord.deleteWebhook(args.webhook_id);
    if (res.error)
        return { content: [{ type: 'text', text: res.error }] };
    return { content: [{ type: 'text', text: `Deleted webhook ${args.webhook_id}.` }] };
}
// ── List ───────────────────────────────────────────────────────
async function handleList(args) {
    let res;
    if (args.channel) {
        let channelId = args.channel;
        if (!/^\d{17,20}$/.test(channelId)) {
            const resolved = await discord.resolveGuildId(args.guild_id);
            if ('error' in resolved)
                return { content: [{ type: 'text', text: resolved.error }] };
            const ch = await discord.resolveChannel(args.channel, resolved.guildId);
            if ('error' in ch)
                return { content: [{ type: 'text', text: ch.error }] };
            channelId = ch.id;
        }
        res = await discord.listChannelWebhooks(channelId);
    }
    else {
        const resolved = await discord.resolveGuildId(args.guild_id);
        if ('error' in resolved)
            return { content: [{ type: 'text', text: resolved.error }] };
        res = await discord.listGuildWebhooks(resolved.guildId);
    }
    if (res.error)
        return { content: [{ type: 'text', text: res.error }] };
    const webhooks = res.data;
    if (!webhooks || webhooks.length === 0) {
        return { content: [{ type: 'text', text: 'No webhooks found.' }] };
    }
    const typeNames = { 1: 'Incoming', 2: 'Channel Follower', 3: 'Application' };
    const lines = webhooks.map(wh => {
        const type = typeNames[wh.type] || 'Unknown';
        return `  ${wh.name} (${wh.id}, ${type}) in <#${wh.channel_id}>${wh.token ? `\n    URL: https://discord.com/api/webhooks/${wh.id}/${wh.token}` : ''}`;
    });
    return { content: [{ type: 'text', text: `Webhooks (${webhooks.length}):\n${lines.join('\n')}` }] };
}
// ── Execute ────────────────────────────────────────────────────
async function handleExecute(args) {
    if (!args.webhook_id)
        return { content: [{ type: 'text', text: 'webhook_id is required for execute action.' }] };
    if (!args.webhook_token)
        return { content: [{ type: 'text', text: 'webhook_token is required for execute action.' }] };
    if (!args.content && !args.embeds)
        return { content: [{ type: 'text', text: 'content or embeds is required for execute action.' }] };
    const data = {};
    if (args.content)
        data.content = args.content;
    if (args.username)
        data.username = args.username;
    if (args.avatar_url)
        data.avatar_url = args.avatar_url;
    if (args.embeds)
        data.embeds = args.embeds;
    const res = await discord.executeWebhook(args.webhook_id, args.webhook_token, data);
    if (res.error)
        return { content: [{ type: 'text', text: res.error }] };
    return { content: [{ type: 'text', text: `Webhook message sent.` }] };
}
// ── Main dispatcher ────────────────────────────────────────────
export async function handleDiscordWebhook(args) {
    switch (args.action) {
        case 'create': return handleCreate(args);
        case 'edit': return handleEdit(args);
        case 'delete': return handleDelete(args);
        case 'list': return handleList(args);
        case 'execute': return handleExecute(args);
        default:
            return { content: [{ type: 'text', text: `Unknown action "${args.action}". Use: create, edit, delete, list, execute.` }] };
    }
}
//# sourceMappingURL=discord-webhook.js.map