import { z } from 'zod';
import * as discord from '../services/discord.js';
import { text } from './response.js';

export const discordWebhookSchema = {
  action: z.enum(['create', 'edit', 'delete', 'list', 'execute'] as const)
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

export const discordWebhookDescription =
  'Discord webhook management. Actions: create, edit, delete, list, execute (send message as webhook).';

// ── Create ─────────────────────────────────────────────────────

async function handleCreate(args: { channel?: string; name?: string; avatar_url?: string; guild_id?: string }) {
  if (!args.channel) return text('channel is required for create action.');
  if (!args.name) return text('name is required for create action.');

  let channelId = args.channel;
  if (!/^\d{17,20}$/.test(channelId)) {
    const resolved = await discord.resolveGuildId(args.guild_id);
    if ('error' in resolved) return text(resolved.error);
    const ch = await discord.resolveChannel(args.channel, resolved.guildId);
    if ('error' in ch) return text(ch.error);
    channelId = ch.id;
  }

  const data: { name: string; avatar?: string } = { name: args.name };
  // Note: avatar in create expects base64 data URI, not URL. avatar_url is for execute override.

  const res = await discord.createWebhook(channelId, data);
  if (res.error) return text(res.error);

  const wh = res.data as { id: string; name: string; token: string; channel_id: string };
  return text(`Created webhook "${wh.name}" (${wh.id}) in <#${wh.channel_id}>.\nToken: ${wh.token}\nURL: https://discord.com/api/webhooks/${wh.id}/${wh.token}`);
}

// ── Edit ───────────────────────────────────────────────────────

async function handleEdit(args: { webhook_id?: string; name?: string; channel?: string; guild_id?: string }) {
  if (!args.webhook_id) return text('webhook_id is required for edit action.');

  const data: Record<string, unknown> = {};
  if (args.name) data.name = args.name;

  if (args.channel) {
    let channelId = args.channel;
    if (!/^\d{17,20}$/.test(channelId)) {
      const resolved = await discord.resolveGuildId(args.guild_id);
      if ('error' in resolved) return text(resolved.error);
      const ch = await discord.resolveChannel(args.channel, resolved.guildId);
      if ('error' in ch) return text(ch.error);
      channelId = ch.id;
    }
    data.channel_id = channelId;
  }

  const res = await discord.editWebhook(args.webhook_id, data);
  if (res.error) return text(res.error);

  return text(`Updated webhook ${args.webhook_id}.`);
}

// ── Delete ─────────────────────────────────────────────────────

async function handleDelete(args: { webhook_id?: string }) {
  if (!args.webhook_id) return text('webhook_id is required for delete action.');

  const res = await discord.deleteWebhook(args.webhook_id);
  if (res.error) return text(res.error);

  return text(`Deleted webhook ${args.webhook_id}.`);
}

// ── List ───────────────────────────────────────────────────────

async function handleList(args: { channel?: string; guild_id?: string }) {
  let res: discord.DiscordResponse;

  if (args.channel) {
    let channelId = args.channel;
    if (!/^\d{17,20}$/.test(channelId)) {
      const resolved = await discord.resolveGuildId(args.guild_id);
      if ('error' in resolved) return text(resolved.error);
      const ch = await discord.resolveChannel(args.channel, resolved.guildId);
      if ('error' in ch) return text(ch.error);
      channelId = ch.id;
    }
    res = await discord.listChannelWebhooks(channelId);
  } else {
    const resolved = await discord.resolveGuildId(args.guild_id);
    if ('error' in resolved) return text(resolved.error);
    res = await discord.listGuildWebhooks(resolved.guildId);
  }

  if (res.error) return text(res.error);

  const webhooks = res.data as { id: string; name: string; channel_id: string; token?: string; type: number }[];
  if (!webhooks || webhooks.length === 0) {
    return text('No webhooks found.');
  }

  const typeNames: Record<number, string> = { 1: 'Incoming', 2: 'Channel Follower', 3: 'Application' };
  const lines = webhooks.map(wh => {
    const type = typeNames[wh.type] || 'Unknown';
    return `  ${wh.name} (${wh.id}, ${type}) in <#${wh.channel_id}>${wh.token ? `\n    URL: https://discord.com/api/webhooks/${wh.id}/${wh.token}` : ''}`;
  });

  return text(`Webhooks (${webhooks.length}):\n${lines.join('\n')}`);
}

// ── Execute ────────────────────────────────────────────────────

async function handleExecute(args: {
  webhook_id?: string; webhook_token?: string;
  content?: string; username?: string; avatar_url?: string;
  embeds?: Record<string, unknown>[];
}) {
  if (!args.webhook_id) return text('webhook_id is required for execute action.');
  if (!args.webhook_token) return text('webhook_token is required for execute action.');
  if (!args.content && !args.embeds) return text('content or embeds is required for execute action.');

  const data: Record<string, unknown> = {};
  if (args.content) data.content = args.content;
  if (args.username) data.username = args.username;
  if (args.avatar_url) data.avatar_url = args.avatar_url;
  if (args.embeds) data.embeds = args.embeds;

  const res = await discord.executeWebhook(args.webhook_id, args.webhook_token, data);
  if (res.error) return text(res.error);

  return text(`Webhook message sent.`);
}

// ── Main dispatcher ────────────────────────────────────────────

export async function handleDiscordWebhook(args: {
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
}) {
  switch (args.action) {
    case 'create': return handleCreate(args);
    case 'edit': return handleEdit(args);
    case 'delete': return handleDelete(args);
    case 'list': return handleList(args);
    case 'execute': return handleExecute(args);
    default:
      return text(`Unknown action "${args.action}". Use: create, edit, delete, list, execute.`);
  }
}
