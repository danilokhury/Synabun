import { z } from 'zod';
import * as discord from '../services/discord.js';

export const discordMemberSchema = {
  action: z.enum(['info', 'kick', 'ban', 'unban', 'timeout', 'nickname'] as const)
    .describe('Action: info, kick, ban, unban, timeout, nickname.'),
  guild_id: z.string().optional()
    .describe('Guild ID. Defaults to DISCORD_GUILD_ID env var.'),
  member: z.string()
    .describe('User name, tag, or ID (required for all actions).'),
  reason: z.string().optional()
    .describe('Moderation reason for audit log (kick/ban/timeout).'),
  duration: z.number().optional()
    .describe('Timeout duration in minutes (timeout action). 0 to remove timeout.'),
  nickname: z.string().optional()
    .describe('New nickname (nickname action). Empty string to reset.'),
  delete_days: z.number().optional()
    .describe('Days of messages to delete, 0-7 (ban action, default 0).'),
};

export const discordMemberDescription =
  'Discord member moderation. Actions: info, kick, ban, unban, timeout, nickname.';

// ── Info ───────────────────────────────────────────────────────

async function handleInfo(guildId: string, args: { member: string }) {
  const user = await discord.resolveUser(args.member, guildId);
  if ('error' in user) return { content: [{ type: 'text' as const, text: user.error }] };

  const res = await discord.getMember(guildId, user.id);
  if (res.error) return { content: [{ type: 'text' as const, text: res.error }] };

  const m = res.data as {
    user: { id: string; username: string; global_name?: string; bot?: boolean; avatar?: string };
    nick?: string;
    roles: string[];
    joined_at: string;
    premium_since?: string;
    communication_disabled_until?: string;
  };

  const name = m.nick || m.user.global_name || m.user.username;
  const timeout = m.communication_disabled_until
    ? `Timeout until: ${new Date(m.communication_disabled_until).toLocaleString()}`
    : null;

  const lines = [
    `**${name}** (@${m.user.username}, ${m.user.id})`,
    m.user.bot ? 'Type: Bot' : 'Type: User',
    `Joined: ${new Date(m.joined_at).toLocaleString()}`,
    m.premium_since ? `Boosting since: ${new Date(m.premium_since).toLocaleString()}` : null,
    `Roles: ${m.roles.length > 0 ? m.roles.join(', ') : 'none'}`,
    timeout,
  ].filter(Boolean).join('\n');

  return { content: [{ type: 'text' as const, text: lines }] };
}

// ── Kick ───────────────────────────────────────────────────────

async function handleKick(guildId: string, args: { member: string; reason?: string }) {
  const user = await discord.resolveUser(args.member, guildId);
  if ('error' in user) return { content: [{ type: 'text' as const, text: user.error }] };

  const res = await discord.kickMember(guildId, user.id, args.reason);
  if (res.error) return { content: [{ type: 'text' as const, text: res.error }] };

  return { content: [{ type: 'text' as const, text: `Kicked ${user.name} (${user.id}).${args.reason ? ` Reason: ${args.reason}` : ''}` }] };
}

// ── Ban ────────────────────────────────────────────────────────

async function handleBan(guildId: string, args: { member: string; reason?: string; delete_days?: number }) {
  const user = await discord.resolveUser(args.member, guildId);
  if ('error' in user) return { content: [{ type: 'text' as const, text: user.error }] };

  const deleteSeconds = (args.delete_days || 0) * 86400;
  const res = await discord.banMember(guildId, user.id, {
    delete_message_seconds: deleteSeconds,
  });
  if (res.error) return { content: [{ type: 'text' as const, text: res.error }] };

  return { content: [{ type: 'text' as const, text: `Banned ${user.name} (${user.id}).${args.reason ? ` Reason: ${args.reason}` : ''}` }] };
}

// ── Unban ──────────────────────────────────────────────────────

async function handleUnban(guildId: string, args: { member: string }) {
  // For unban, member must be a user ID since they're not in the guild
  if (!/^\d{17,20}$/.test(args.member)) {
    return { content: [{ type: 'text' as const, text: 'member must be a user ID for unban action (the user is not in the guild).' }] };
  }

  const res = await discord.unbanMember(guildId, args.member);
  if (res.error) return { content: [{ type: 'text' as const, text: res.error }] };

  return { content: [{ type: 'text' as const, text: `Unbanned user ${args.member}.` }] };
}

// ── Timeout ────────────────────────────────────────────────────

async function handleTimeout(guildId: string, args: { member: string; duration?: number; reason?: string }) {
  if (args.duration === undefined) {
    return { content: [{ type: 'text' as const, text: 'duration (minutes) is required for timeout action. Use 0 to remove timeout.' }] };
  }

  const user = await discord.resolveUser(args.member, guildId);
  if ('error' in user) return { content: [{ type: 'text' as const, text: user.error }] };

  const res = await discord.timeoutMember(guildId, user.id, args.duration);
  if (res.error) return { content: [{ type: 'text' as const, text: res.error }] };

  if (args.duration === 0) {
    return { content: [{ type: 'text' as const, text: `Removed timeout from ${user.name}.` }] };
  }
  return { content: [{ type: 'text' as const, text: `Timed out ${user.name} for ${args.duration} minutes.${args.reason ? ` Reason: ${args.reason}` : ''}` }] };
}

// ── Nickname ───────────────────────────────────────────────────

async function handleNickname(guildId: string, args: { member: string; nickname?: string }) {
  const user = await discord.resolveUser(args.member, guildId);
  if ('error' in user) return { content: [{ type: 'text' as const, text: user.error }] };

  const nick = args.nickname === '' ? null : (args.nickname || null);
  const res = await discord.setNickname(guildId, user.id, nick);
  if (res.error) return { content: [{ type: 'text' as const, text: res.error }] };

  return { content: [{ type: 'text' as const, text: nick ? `Set nickname of ${user.name} to "${nick}".` : `Reset nickname of ${user.name}.` }] };
}

// ── Main dispatcher ────────────────────────────────────────────

export async function handleDiscordMember(args: {
  action: string;
  guild_id?: string;
  member: string;
  reason?: string;
  duration?: number;
  nickname?: string;
  delete_days?: number;
}) {
  const resolved = await discord.resolveGuildId(args.guild_id);
  if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };
  const guildId = resolved.guildId;

  switch (args.action) {
    case 'info': return handleInfo(guildId, args);
    case 'kick': return handleKick(guildId, args);
    case 'ban': return handleBan(guildId, args);
    case 'unban': return handleUnban(guildId, args);
    case 'timeout': return handleTimeout(guildId, args);
    case 'nickname': return handleNickname(guildId, args);
    default:
      return { content: [{ type: 'text' as const, text: `Unknown action "${args.action}". Use: info, kick, ban, unban, timeout, nickname.` }] };
  }
}
