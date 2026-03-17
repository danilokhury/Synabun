import { z } from 'zod';
import * as discord from '../services/discord.js';
import { coerceStringArray } from './utils.js';
import { text } from './response.js';

export const discordMessageSchema = {
  action: z.enum(['send', 'edit', 'delete', 'pin', 'unpin', 'react', 'bulk_delete', 'list'] as const)
    .describe('Action: send, edit, delete, pin, unpin, react, bulk_delete, list.'),
  guild_id: z.string().optional()
    .describe('Guild ID for channel name resolution. Defaults to DISCORD_GUILD_ID env var.'),
  channel: z.string()
    .describe('Channel name or ID (required for all actions).'),
  content: z.string().optional()
    .describe('Message text (send required, edit optional).'),
  message_id: z.string().optional()
    .describe('Message ID (required for edit/delete/pin/unpin/react).'),
  embed: z.record(z.unknown()).optional()
    .describe('Embed object: {title?, description?, color? (int), fields?: [{name, value, inline?}], footer?: {text}, image?: {url}, thumbnail?: {url}}. (send/edit)'),
  emoji: z.string().optional()
    .describe('Emoji for react action. Unicode emoji or custom format "name:id".'),
  message_ids: coerceStringArray().optional()
    .describe('Array of message IDs for bulk_delete (2-100 messages, max 14 days old).'),
  reply_to: z.string().optional()
    .describe('Message ID to reply to (send only).'),
  limit: z.number().optional()
    .describe('Max messages to fetch (list action, default 50, max 100).'),
  before: z.string().optional()
    .describe('Fetch messages before this message ID (list action).'),
  after: z.string().optional()
    .describe('Fetch messages after this message ID (list action).'),
};

export const discordMessageDescription =
  'Discord message operations. Actions: send, edit, delete, pin, unpin, react, bulk_delete, list.';

// ── Helpers ────────────────────────────────────────────────────

async function resolveChannelId(channel: string, guildId?: string): Promise<{ channelId: string } | { error: string }> {
  // If it looks like a snowflake, use directly
  if (/^\d{17,20}$/.test(channel)) return { channelId: channel };

  // Need guild_id to resolve by name
  const resolved = await discord.resolveGuildId(guildId);
  if ('error' in resolved) return resolved;

  const ch = await discord.resolveChannel(channel, resolved.guildId);
  if ('error' in ch) return ch;
  return { channelId: ch.id };
}

// ── Send ───────────────────────────────────────────────────────

async function handleSend(args: {
  channel: string; content?: string; embed?: Record<string, unknown>;
  reply_to?: string; guild_id?: string;
}) {
  if (!args.content && !args.embed) {
    return text('content or embed is required for send action.');
  }

  const ch = await resolveChannelId(args.channel, args.guild_id);
  if ('error' in ch) return text(ch.error);

  const data: Record<string, unknown> = {};
  if (args.content) data.content = args.content;
  if (args.embed) data.embeds = [args.embed];
  if (args.reply_to) {
    data.message_reference = { message_id: args.reply_to };
  }

  const res = await discord.sendMessage(ch.channelId, data);
  if (res.error) return text(res.error);

  const msg = res.data as { id: string };
  return text(`Sent message ${msg.id} in <#${ch.channelId}>.`);
}

// ── Edit ───────────────────────────────────────────────────────

async function handleEdit(args: {
  channel: string; message_id?: string; content?: string;
  embed?: Record<string, unknown>; guild_id?: string;
}) {
  if (!args.message_id) return text('message_id is required for edit action.');

  const ch = await resolveChannelId(args.channel, args.guild_id);
  if ('error' in ch) return text(ch.error);

  const data: Record<string, unknown> = {};
  if (args.content !== undefined) data.content = args.content;
  if (args.embed) data.embeds = [args.embed];

  const res = await discord.editMessage(ch.channelId, args.message_id, data);
  if (res.error) return text(res.error);

  return text(`Edited message ${args.message_id}.`);
}

// ── Delete ─────────────────────────────────────────────────────

async function handleDelete(args: { channel: string; message_id?: string; guild_id?: string }) {
  if (!args.message_id) return text('message_id is required for delete action.');

  const ch = await resolveChannelId(args.channel, args.guild_id);
  if ('error' in ch) return text(ch.error);

  const res = await discord.deleteMessage(ch.channelId, args.message_id);
  if (res.error) return text(res.error);

  return text(`Deleted message ${args.message_id}.`);
}

// ── Pin / Unpin ────────────────────────────────────────────────

async function handlePin(args: { channel: string; message_id?: string; guild_id?: string }, unpin = false) {
  if (!args.message_id) return text('message_id is required.');

  const ch = await resolveChannelId(args.channel, args.guild_id);
  if ('error' in ch) return text(ch.error);

  const res = unpin
    ? await discord.unpinMessage(ch.channelId, args.message_id)
    : await discord.pinMessage(ch.channelId, args.message_id);
  if (res.error) return text(res.error);

  return text(`${unpin ? 'Unpinned' : 'Pinned'} message ${args.message_id}.`);
}

// ── React ──────────────────────────────────────────────────────

async function handleReact(args: { channel: string; message_id?: string; emoji?: string; guild_id?: string }) {
  if (!args.message_id) return text('message_id is required for react action.');
  if (!args.emoji) return text('emoji is required for react action.');

  const ch = await resolveChannelId(args.channel, args.guild_id);
  if ('error' in ch) return text(ch.error);

  const res = await discord.addReaction(ch.channelId, args.message_id, args.emoji);
  if (res.error) return text(res.error);

  return text(`Reacted with ${args.emoji} on message ${args.message_id}.`);
}

// ── Bulk Delete ────────────────────────────────────────────────

async function handleBulkDelete(args: { channel: string; message_ids?: string[]; guild_id?: string }) {
  if (!args.message_ids || args.message_ids.length === 0) {
    return text('message_ids is required for bulk_delete action (2-100 messages).');
  }
  if (args.message_ids.length < 2 || args.message_ids.length > 100) {
    return text('bulk_delete requires 2-100 message IDs.');
  }

  const ch = await resolveChannelId(args.channel, args.guild_id);
  if ('error' in ch) return text(ch.error);

  const res = await discord.bulkDeleteMessages(ch.channelId, args.message_ids);
  if (res.error) return text(res.error);

  return text(`Bulk deleted ${args.message_ids.length} messages.`);
}

// ── List ───────────────────────────────────────────────────────

async function handleList(args: { channel: string; limit?: number; before?: string; after?: string; guild_id?: string }) {
  const ch = await resolveChannelId(args.channel, args.guild_id);
  if ('error' in ch) return text(ch.error);

  const res = await discord.getMessages(ch.channelId, {
    limit: Math.min(args.limit || 50, 100),
    before: args.before,
    after: args.after,
  });
  if (res.error) return text(res.error);

  const messages = res.data as {
    id: string;
    author: { username: string; global_name?: string; bot?: boolean };
    content: string;
    timestamp: string;
    pinned: boolean;
    embeds?: unknown[];
  }[];

  if (messages.length === 0) {
    return text('No messages found.');
  }

  const lines = messages.reverse().map(m => {
    const author = m.author.global_name || m.author.username;
    const bot = m.author.bot ? ' [BOT]' : '';
    const pinned = m.pinned ? ' [PINNED]' : '';
    const time = new Date(m.timestamp).toLocaleString();
    const content = m.content
      ? (m.content.length > 200 ? m.content.slice(0, 200) + '...' : m.content)
      : (m.embeds?.length ? '[embed]' : '[no content]');
    return `  [${m.id}] ${author}${bot}${pinned} (${time}): ${content}`;
  });

  return text(`Messages (${messages.length}):\n${lines.join('\n')}`);
}

// ── Main dispatcher ────────────────────────────────────────────

export async function handleDiscordMessage(args: {
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
}) {
  switch (args.action) {
    case 'send': return handleSend(args);
    case 'edit': return handleEdit(args);
    case 'delete': return handleDelete(args);
    case 'pin': return handlePin(args);
    case 'unpin': return handlePin(args, true);
    case 'react': return handleReact(args);
    case 'bulk_delete': return handleBulkDelete(args);
    case 'list': return handleList(args);
    default:
      return text(`Unknown action "${args.action}". Use: send, edit, delete, pin, unpin, react, bulk_delete, list.`);
  }
}
