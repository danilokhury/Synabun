import { z } from 'zod';
import * as discord from '../services/discord.js';
import { text } from './response.js';

export const discordOnboardingSchema = {
  action: z.enum(['get', 'set_welcome', 'set_rules', 'set_verification', 'set_onboarding'] as const)
    .describe('Action: get (current config), set_welcome (welcome screen), set_rules (rules channel), set_verification (level), set_onboarding (prompts & defaults).'),
  guild_id: z.string().optional()
    .describe('Guild ID. Defaults to DISCORD_GUILD_ID env var.'),
  description: z.string().optional()
    .describe('Welcome screen description text (set_welcome).'),
  welcome_channels: z.array(z.record(z.unknown())).optional()
    .describe('Welcome screen channels: [{channel_id, description, emoji_name?}] (set_welcome).'),
  rules_channel: z.string().optional()
    .describe('Channel name or ID for rules (set_rules).'),
  system_channel: z.string().optional()
    .describe('Channel name or ID for system messages (set_rules).'),
  verification_level: z.enum(['none', 'low', 'medium', 'high', 'very_high'] as const).optional()
    .describe('Verification level (set_verification). none=unrestricted, low=email, medium=5min, high=10min, very_high=phone.'),
  prompts: z.array(z.record(z.unknown())).optional()
    .describe('Onboarding prompts array (set_onboarding). Each: {title, options: [{title, description?, emoji_name?, channel_ids?, role_ids?}], single_select?, required?, in_onboarding?}'),
  default_channels: z.array(z.string()).optional()
    .describe('Default channel IDs for new members (set_onboarding).'),
  enabled: z.boolean().optional()
    .describe('Enable/disable onboarding (set_onboarding).'),
};

export const discordOnboardingDescription =
  'Discord server onboarding and setup. Actions: get, set_welcome, set_rules, set_verification, set_onboarding.';

// ── Get ────────────────────────────────────────────────────────

async function handleGet(guildId: string) {
  // Fetch guild info, welcome screen, and onboarding in sequence
  const guildRes = await discord.getGuild(guildId);
  const welcomeRes = await discord.getWelcomeScreen(guildId);
  const onboardingRes = await discord.getOnboarding(guildId);

  const lines: string[] = ['**Server Setup Status:**\n'];

  // Guild settings
  if (guildRes.ok && guildRes.data) {
    const g = guildRes.data as {
      verification_level: number;
      rules_channel_id?: string;
      system_channel_id?: string;
      features: string[];
    };
    const verificationNames = ['None', 'Low (email)', 'Medium (5min)', 'High (10min)', 'Very High (phone)'];
    lines.push(`Verification: ${verificationNames[g.verification_level] || g.verification_level}`);
    lines.push(`Rules channel: ${g.rules_channel_id || 'not set'}`);
    lines.push(`System channel: ${g.system_channel_id || 'not set'}`);
    const hasWelcome = g.features.includes('WELCOME_SCREEN_ENABLED');
    lines.push(`Welcome screen: ${hasWelcome ? 'enabled' : 'disabled'}`);
    const hasCommunity = g.features.includes('COMMUNITY');
    lines.push(`Community: ${hasCommunity ? 'enabled' : 'disabled'}`);
    lines.push('');
  }

  // Welcome screen
  if (welcomeRes.ok && welcomeRes.data) {
    const w = welcomeRes.data as {
      description?: string;
      welcome_channels: { channel_id: string; description: string; emoji_name?: string }[];
    };
    lines.push('**Welcome Screen:**');
    lines.push(`Description: ${w.description || '(none)'}`);
    if (w.welcome_channels.length > 0) {
      for (const ch of w.welcome_channels) {
        lines.push(`  <#${ch.channel_id}> — ${ch.description}${ch.emoji_name ? ` ${ch.emoji_name}` : ''}`);
      }
    } else {
      lines.push('  (no channels configured)');
    }
    lines.push('');
  } else {
    lines.push('**Welcome Screen:** not configured or requires Community\n');
  }

  // Onboarding
  if (onboardingRes.ok && onboardingRes.data) {
    const o = onboardingRes.data as {
      guild_id: string;
      prompts: { title: string; options: { title: string }[]; single_select: boolean; required: boolean }[];
      default_channel_ids: string[];
      enabled: boolean;
    };
    lines.push('**Onboarding:**');
    lines.push(`Enabled: ${o.enabled}`);
    lines.push(`Default channels: ${o.default_channel_ids.length > 0 ? o.default_channel_ids.map(id => `<#${id}>`).join(', ') : 'none'}`);
    if (o.prompts.length > 0) {
      lines.push(`Prompts (${o.prompts.length}):`);
      for (const p of o.prompts) {
        const opts = p.options.map(opt => opt.title).join(', ');
        lines.push(`  "${p.title}" (${p.options.length} options${p.required ? ', required' : ''}${p.single_select ? ', single' : ', multi'}): ${opts}`);
      }
    } else {
      lines.push('Prompts: none');
    }
  } else {
    lines.push('**Onboarding:** not configured');
  }

  return text(lines.join('\n'));
}

// ── Set Welcome ────────────────────────────────────────────────

async function handleSetWelcome(guildId: string, args: {
  description?: string;
  welcome_channels?: Record<string, unknown>[];
}) {
  const data: Record<string, unknown> = { enabled: true };
  if (args.description !== undefined) data.description = args.description;
  if (args.welcome_channels) data.welcome_channels = args.welcome_channels;

  const res = await discord.setWelcomeScreen(guildId, data);
  if (res.error) return text(res.error);

  return text(`Updated welcome screen.${args.description ? ` Description: "${args.description}"` : ''}${args.welcome_channels ? ` Channels: ${args.welcome_channels.length}` : ''}`);
}

// ── Set Rules ──────────────────────────────────────────────────

async function handleSetRules(guildId: string, args: {
  rules_channel?: string;
  system_channel?: string;
}) {
  if (!args.rules_channel && !args.system_channel) {
    return text('Provide rules_channel and/or system_channel.');
  }

  const data: Record<string, unknown> = {};

  if (args.rules_channel) {
    const ch = await discord.resolveChannel(args.rules_channel, guildId);
    if ('error' in ch) return text(`Rules channel: ${ch.error}`);
    data.rules_channel_id = ch.id;
  }

  if (args.system_channel) {
    const ch = await discord.resolveChannel(args.system_channel, guildId);
    if ('error' in ch) return text(`System channel: ${ch.error}`);
    data.system_channel_id = ch.id;
  }

  const res = await discord.editGuildSettings(guildId, data);
  if (res.error) return text(res.error);

  const changes = Object.entries(data).map(([k, v]) => `${k}: ${v}`).join(', ');
  return text(`Updated guild settings: ${changes}`);
}

// ── Set Verification ───────────────────────────────────────────

async function handleSetVerification(guildId: string, args: { verification_level?: string }) {
  if (!args.verification_level) {
    return text('verification_level is required.');
  }

  const level = discord.VERIFICATION_LEVELS[args.verification_level];
  if (level === undefined) {
    return text(`Unknown verification level "${args.verification_level}". Use: none, low, medium, high, very_high.`);
  }

  const res = await discord.editGuildSettings(guildId, { verification_level: level });
  if (res.error) return text(res.error);

  return text(`Set verification level to ${args.verification_level} (${level}).`);
}

// ── Set Onboarding ─────────────────────────────────────────────

async function handleSetOnboarding(guildId: string, args: {
  prompts?: Record<string, unknown>[];
  default_channels?: string[];
  enabled?: boolean;
}) {
  // GET current onboarding first, then merge
  const currentRes = await discord.getOnboarding(guildId);
  const current = (currentRes.ok && currentRes.data)
    ? currentRes.data as Record<string, unknown>
    : { prompts: [], default_channel_ids: [], enabled: false };

  const data: Record<string, unknown> = { ...current };
  if (args.prompts !== undefined) data.prompts = args.prompts;
  if (args.default_channels !== undefined) data.default_channel_ids = args.default_channels;
  if (args.enabled !== undefined) data.enabled = args.enabled;

  const res = await discord.setOnboarding(guildId, data);
  if (res.error) return text(res.error);

  const changes: string[] = [];
  if (args.enabled !== undefined) changes.push(`enabled: ${args.enabled}`);
  if (args.prompts) changes.push(`prompts: ${args.prompts.length}`);
  if (args.default_channels) changes.push(`default channels: ${args.default_channels.length}`);

  return text(`Updated onboarding: ${changes.join(', ')}`);
}

// ── Main dispatcher ────────────────────────────────────────────

export async function handleDiscordOnboarding(args: {
  action: string;
  guild_id?: string;
  description?: string;
  welcome_channels?: Record<string, unknown>[];
  rules_channel?: string;
  system_channel?: string;
  verification_level?: string;
  prompts?: Record<string, unknown>[];
  default_channels?: string[];
  enabled?: boolean;
}) {
  const resolved = await discord.resolveGuildId(args.guild_id);
  if ('error' in resolved) return text(resolved.error);
  const guildId = resolved.guildId;

  switch (args.action) {
    case 'get': return handleGet(guildId);
    case 'set_welcome': return handleSetWelcome(guildId, args);
    case 'set_rules': return handleSetRules(guildId, args);
    case 'set_verification': return handleSetVerification(guildId, args);
    case 'set_onboarding': return handleSetOnboarding(guildId, args);
    default:
      return text(`Unknown action "${args.action}". Use: get, set_welcome, set_rules, set_verification, set_onboarding.`);
  }
}
