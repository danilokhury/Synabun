import { discordGuildSchema, discordGuildDescription, handleDiscordGuild } from './discord-guild.js';
import { discordChannelSchema, discordChannelDescription, handleDiscordChannel } from './discord-channel.js';
import { discordRoleSchema, discordRoleDescription, handleDiscordRole } from './discord-role.js';
import { discordMessageSchema, discordMessageDescription, handleDiscordMessage } from './discord-message.js';
import { discordMemberSchema, discordMemberDescription, handleDiscordMember } from './discord-member.js';
import { discordOnboardingSchema, discordOnboardingDescription, handleDiscordOnboarding } from './discord-onboarding.js';
import { discordWebhookSchema, discordWebhookDescription, handleDiscordWebhook } from './discord-webhook.js';
import { discordThreadSchema, discordThreadDescription, handleDiscordThread } from './discord-thread.js';
/**
 * Register all 8 Discord MCP tools on the given server instance.
 * Discord tools are static (no dynamic schema refresh needed).
 */
export function registerDiscordTools(server) {
    // Server overview
    server.tool('discord_guild', discordGuildDescription, discordGuildSchema, handleDiscordGuild);
    // Channel management (text, voice, categories, forums, stages)
    server.tool('discord_channel', discordChannelDescription, discordChannelSchema, handleDiscordChannel);
    // Role management + assignment
    server.tool('discord_role', discordRoleDescription, discordRoleSchema, handleDiscordRole);
    // Message operations
    server.tool('discord_message', discordMessageDescription, discordMessageSchema, handleDiscordMessage);
    // Member moderation
    server.tool('discord_member', discordMemberDescription, discordMemberSchema, handleDiscordMember);
    // Server onboarding & setup
    server.tool('discord_onboarding', discordOnboardingDescription, discordOnboardingSchema, handleDiscordOnboarding);
    // Webhook management
    server.tool('discord_webhook', discordWebhookDescription, discordWebhookSchema, handleDiscordWebhook);
    // Thread management
    server.tool('discord_thread', discordThreadDescription, discordThreadSchema, handleDiscordThread);
}
//# sourceMappingURL=discord.js.map