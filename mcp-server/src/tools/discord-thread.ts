import { z } from 'zod';
import * as discord from '../services/discord.js';

export const discordThreadSchema = {
  action: z.enum(['create', 'archive', 'unarchive', 'lock', 'delete'] as const)
    .describe('Action: create, archive, unarchive, lock, delete.'),
  guild_id: z.string().optional()
    .describe('Guild ID for channel name resolution. Defaults to DISCORD_GUILD_ID env var.'),
  channel: z.string().optional()
    .describe('Parent channel name or ID (create only).'),
  thread: z.string().optional()
    .describe('Thread ID (required for archive/unarchive/lock/delete).'),
  name: z.string().optional()
    .describe('Thread name (create required).'),
  message_id: z.string().optional()
    .describe('Create thread from this message (create only). Omit for standalone thread.'),
  auto_archive: z.number().optional()
    .describe('Auto-archive duration in minutes: 60, 1440, 4320, or 10080 (create only).'),
  private: z.boolean().optional()
    .describe('Create private thread (create only, default false).'),
};

export const discordThreadDescription =
  'Discord thread management. Actions: create (from message or standalone), archive, unarchive, lock, delete.';

// ── Create ─────────────────────────────────────────────────────

async function handleCreate(args: {
  channel?: string; name?: string; message_id?: string;
  auto_archive?: number; private?: boolean; guild_id?: string;
}) {
  if (!args.channel) return { content: [{ type: 'text' as const, text: 'channel is required for create action.' }] };
  if (!args.name) return { content: [{ type: 'text' as const, text: 'name is required for create action.' }] };

  let channelId = args.channel;
  if (!/^\d{17,20}$/.test(channelId)) {
    const resolved = await discord.resolveGuildId(args.guild_id);
    if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };
    const ch = await discord.resolveChannel(args.channel, resolved.guildId);
    if ('error' in ch) return { content: [{ type: 'text' as const, text: ch.error }] };
    channelId = ch.id;
  }

  const data: Record<string, unknown> = {
    name: args.name,
    auto_archive_duration: args.auto_archive || 1440,
  };

  let res: discord.DiscordResponse;

  if (args.message_id) {
    // Create thread from message
    res = await discord.createThreadFromMessage(channelId, args.message_id, data);
  } else {
    // Standalone thread
    data.type = args.private ? 12 : 11; // 11 = public, 12 = private
    res = await discord.createThread(channelId, data);
  }

  if (res.error) return { content: [{ type: 'text' as const, text: res.error }] };

  const thread = res.data as { id: string; name: string };
  return { content: [{ type: 'text' as const, text: `Created thread "${thread.name}" (${thread.id})${args.message_id ? ` from message ${args.message_id}` : ''}.` }] };
}

// ── Archive / Unarchive / Lock ─────────────────────────────────

async function handleModify(args: { thread?: string }, updates: Record<string, unknown>, actionName: string) {
  if (!args.thread) return { content: [{ type: 'text' as const, text: `thread ID is required for ${actionName} action.` }] };

  const res = await discord.modifyThread(args.thread, updates);
  if (res.error) return { content: [{ type: 'text' as const, text: res.error }] };

  return { content: [{ type: 'text' as const, text: `Thread ${args.thread} ${actionName}d.` }] };
}

// ── Delete ─────────────────────────────────────────────────────

async function handleDelete(args: { thread?: string }) {
  if (!args.thread) return { content: [{ type: 'text' as const, text: 'thread ID is required for delete action.' }] };

  const res = await discord.deleteThread(args.thread);
  if (res.error) return { content: [{ type: 'text' as const, text: res.error }] };

  return { content: [{ type: 'text' as const, text: `Deleted thread ${args.thread}.` }] };
}

// ── Main dispatcher ────────────────────────────────────────────

export async function handleDiscordThread(args: {
  action: string;
  guild_id?: string;
  channel?: string;
  thread?: string;
  name?: string;
  message_id?: string;
  auto_archive?: number;
  private?: boolean;
}) {
  switch (args.action) {
    case 'create': return handleCreate(args);
    case 'archive': return handleModify(args, { archived: true }, 'archive');
    case 'unarchive': return handleModify(args, { archived: false }, 'unarchive');
    case 'lock': return handleModify(args, { locked: true }, 'lock');
    case 'delete': return handleDelete(args);
    default:
      return { content: [{ type: 'text' as const, text: `Unknown action "${args.action}". Use: create, archive, unarchive, lock, delete.` }] };
  }
}
