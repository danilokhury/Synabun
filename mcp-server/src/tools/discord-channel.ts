import { z } from 'zod';
import * as discord from '../services/discord.js';

export const discordChannelSchema = {
  action: z.enum(['create', 'edit', 'delete', 'list', 'permissions'] as const)
    .describe('Action: create, edit, delete, list, or permissions.'),
  guild_id: z.string().optional()
    .describe('Guild ID. Defaults to DISCORD_GUILD_ID env var.'),
  channel: z.string().optional()
    .describe('Channel name or ID (required for edit/delete/permissions).'),
  name: z.string().optional()
    .describe('Channel name (create required, edit optional).'),
  type: z.enum(['text', 'voice', 'category', 'announcement', 'forum', 'stage'] as const).optional()
    .describe('Channel type (create only, default: text). Use "category" for channel categories.'),
  topic: z.string().optional()
    .describe('Channel topic/description (create/edit).'),
  parent: z.string().optional()
    .describe('Parent category name or ID (create/edit). Empty string to remove.'),
  position: z.number().optional()
    .describe('Sort position (create/edit).'),
  nsfw: z.boolean().optional()
    .describe('NSFW flag (create/edit).'),
  slowmode: z.number().optional()
    .describe('Slowmode in seconds, 0-21600 (create/edit).'),
  bitrate: z.number().optional()
    .describe('Voice bitrate in bps (voice channels, create/edit).'),
  user_limit: z.number().optional()
    .describe('Voice user limit, 0=unlimited (voice channels, create/edit).'),
  target: z.string().optional()
    .describe('Role or user name/ID (permissions action). Use "type:role" or "type:user" prefix, or bare name/ID.'),
  allow: z.string().optional()
    .describe('Permission flags to allow, comma-separated (permissions). E.g. "SEND_MESSAGES,VIEW_CHANNEL".'),
  deny: z.string().optional()
    .describe('Permission flags to deny, comma-separated (permissions). E.g. "SEND_MESSAGES".'),
  reason: z.string().optional()
    .describe('Audit log reason.'),
};

export const discordChannelDescription =
  'Discord channel management. Actions: create, edit, delete, list, permissions. Handles text, voice, categories, forums, stages.';

// ── Create ─────────────────────────────────────────────────────

async function handleCreate(guildId: string, args: {
  name?: string; type?: string; topic?: string; parent?: string;
  position?: number; nsfw?: boolean; slowmode?: number;
  bitrate?: number; user_limit?: number; reason?: string;
}) {
  if (!args.name) {
    return { content: [{ type: 'text' as const, text: 'name is required for create action.' }] };
  }

  const channelType = args.type ? discord.CHANNEL_TYPES[args.type] : 0;
  if (channelType === undefined) {
    return { content: [{ type: 'text' as const, text: `Unknown channel type "${args.type}". Use: text, voice, category, announcement, forum, stage.` }] };
  }

  const data: Record<string, unknown> = {
    name: args.name,
    type: channelType,
  };

  if (args.topic !== undefined) data.topic = args.topic;
  if (args.position !== undefined) data.position = args.position;
  if (args.nsfw !== undefined) data.nsfw = args.nsfw;
  if (args.slowmode !== undefined) data.rate_limit_per_user = args.slowmode;
  if (args.bitrate !== undefined) data.bitrate = args.bitrate;
  if (args.user_limit !== undefined) data.user_limit = args.user_limit;

  // Resolve parent category
  if (args.parent) {
    const parentResolved = await discord.resolveChannel(args.parent, guildId);
    if ('error' in parentResolved) return { content: [{ type: 'text' as const, text: `Parent category: ${parentResolved.error}` }] };
    data.parent_id = parentResolved.id;
  }

  const res = await discord.createChannel(guildId, data);
  if (res.error) return { content: [{ type: 'text' as const, text: res.error }] };

  const ch = res.data as { id: string; name: string; type: number };
  const typeName = discord.CHANNEL_TYPE_NAMES[ch.type] || 'unknown';
  return { content: [{ type: 'text' as const, text: `Created ${typeName} channel #${ch.name} (${ch.id})${args.topic ? ` — "${args.topic}"` : ''}` }] };
}

// ── Edit ───────────────────────────────────────────────────────

async function handleEdit(guildId: string, args: {
  channel?: string; name?: string; topic?: string; parent?: string;
  position?: number; nsfw?: boolean; slowmode?: number;
  bitrate?: number; user_limit?: number; reason?: string;
}) {
  if (!args.channel) {
    return { content: [{ type: 'text' as const, text: 'channel is required for edit action.' }] };
  }

  const resolved = await discord.resolveChannel(args.channel, guildId);
  if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };

  const data: Record<string, unknown> = {};
  if (args.name !== undefined) data.name = args.name;
  if (args.topic !== undefined) data.topic = args.topic;
  if (args.position !== undefined) data.position = args.position;
  if (args.nsfw !== undefined) data.nsfw = args.nsfw;
  if (args.slowmode !== undefined) data.rate_limit_per_user = args.slowmode;
  if (args.bitrate !== undefined) data.bitrate = args.bitrate;
  if (args.user_limit !== undefined) data.user_limit = args.user_limit;

  if (args.parent !== undefined) {
    if (args.parent === '') {
      data.parent_id = null;
    } else {
      const parentResolved = await discord.resolveChannel(args.parent, guildId);
      if ('error' in parentResolved) return { content: [{ type: 'text' as const, text: `Parent category: ${parentResolved.error}` }] };
      data.parent_id = parentResolved.id;
    }
  }

  if (Object.keys(data).length === 0) {
    return { content: [{ type: 'text' as const, text: 'No changes specified. Provide at least one field to update.' }] };
  }

  const res = await discord.editChannel(resolved.id, data);
  if (res.error) return { content: [{ type: 'text' as const, text: res.error }] };

  const changes = Object.entries(data).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ');
  return { content: [{ type: 'text' as const, text: `Updated #${resolved.name} (${resolved.id}): ${changes}` }] };
}

// ── Delete ─────────────────────────────────────────────────────

async function handleDelete(guildId: string, args: { channel?: string; reason?: string }) {
  if (!args.channel) {
    return { content: [{ type: 'text' as const, text: 'channel is required for delete action.' }] };
  }

  const resolved = await discord.resolveChannel(args.channel, guildId);
  if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };

  const res = await discord.deleteChannel(resolved.id);
  if (res.error) return { content: [{ type: 'text' as const, text: res.error }] };

  return { content: [{ type: 'text' as const, text: `Deleted channel #${resolved.name} (${resolved.id}).` }] };
}

// ── List ───────────────────────────────────────────────────────

async function handleList(guildId: string) {
  const channels = await discord.getGuildChannels(guildId);
  if ('error' in channels) return { content: [{ type: 'text' as const, text: (channels as { error: string }).error }] };

  const list = channels as { id: string; name: string; type: number; parent_id?: string; position: number; topic?: string }[];
  const categories = list.filter(c => c.type === 4).sort((a, b) => a.position - b.position);
  const uncategorized = list.filter(c => c.type !== 4 && !c.parent_id).sort((a, b) => a.position - b.position);

  const lines: string[] = [];

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
    for (const ch of children) {
      const typeName = discord.CHANNEL_TYPE_NAMES[ch.type] || 'unknown';
      lines.push(`  #${ch.name} (${typeName}, ${ch.id})${ch.topic ? ` — ${ch.topic}` : ''}`);
    }
    if (children.length === 0) lines.push('  (empty)');
    lines.push('');
  }

  return { content: [{ type: 'text' as const, text: `Channels (${list.length}):\n\n${lines.join('\n')}` }] };
}

// ── Permissions ────────────────────────────────────────────────

async function handlePermissions(guildId: string, args: {
  channel?: string; target?: string; allow?: string; deny?: string;
}) {
  if (!args.channel) {
    return { content: [{ type: 'text' as const, text: 'channel is required for permissions action.' }] };
  }
  if (!args.target) {
    return { content: [{ type: 'text' as const, text: 'target (role or user name/ID) is required for permissions action.' }] };
  }

  const channelResolved = await discord.resolveChannel(args.channel, guildId);
  if ('error' in channelResolved) return { content: [{ type: 'text' as const, text: channelResolved.error }] };

  // Determine if target is a role (type 0) or member (type 1)
  // Try role first, then user
  let targetId: string;
  let targetType: number;
  let targetName: string;

  const roleResolved = await discord.resolveRole(args.target, guildId);
  if (!('error' in roleResolved)) {
    targetId = roleResolved.id;
    targetType = 0; // role
    targetName = `@${roleResolved.name}`;
  } else {
    const userResolved = await discord.resolveUser(args.target, guildId);
    if ('error' in userResolved) {
      return { content: [{ type: 'text' as const, text: `Could not resolve target "${args.target}" as a role or user.` }] };
    }
    targetId = userResolved.id;
    targetType = 1; // member
    targetName = userResolved.name;
  }

  let allowBits = '0';
  let denyBits = '0';

  try {
    if (args.allow) allowBits = discord.resolvePermissions(args.allow);
    if (args.deny) denyBits = discord.resolvePermissions(args.deny);
  } catch (err) {
    return { content: [{ type: 'text' as const, text: (err as Error).message }] };
  }

  const res = await discord.setChannelPermissions(channelResolved.id, targetId, {
    type: targetType,
    allow: allowBits,
    deny: denyBits,
  });
  if (res.error) return { content: [{ type: 'text' as const, text: res.error }] };

  const parts: string[] = [];
  if (args.allow) parts.push(`allow: ${args.allow}`);
  if (args.deny) parts.push(`deny: ${args.deny}`);

  return { content: [{ type: 'text' as const, text: `Set permissions on #${channelResolved.name} for ${targetName}: ${parts.join(', ')}` }] };
}

// ── Main dispatcher ────────────────────────────────────────────

export async function handleDiscordChannel(args: {
  action: string;
  guild_id?: string;
  channel?: string;
  name?: string;
  type?: string;
  topic?: string;
  parent?: string;
  position?: number;
  nsfw?: boolean;
  slowmode?: number;
  bitrate?: number;
  user_limit?: number;
  target?: string;
  allow?: string;
  deny?: string;
  reason?: string;
}) {
  const resolved = await discord.resolveGuildId(args.guild_id);
  if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };
  const guildId = resolved.guildId;

  switch (args.action) {
    case 'create': return handleCreate(guildId, args);
    case 'edit': return handleEdit(guildId, args);
    case 'delete': return handleDelete(guildId, args);
    case 'list': return handleList(guildId);
    case 'permissions': return handlePermissions(guildId, args);
    default:
      return { content: [{ type: 'text' as const, text: `Unknown action "${args.action}". Use: create, edit, delete, list, permissions.` }] };
  }
}
