/**
 * Discord REST API v10 client for MCP tools.
 * Follows the neural-interface.ts pattern: typed HTTP client with
 * timeout handling, rate limit retry, and name resolution helpers.
 */
export interface DiscordResponse {
    ok?: boolean;
    error?: string;
    data?: unknown;
    [key: string]: unknown;
}
export declare const PERMISSION_FLAGS: Record<string, bigint>;
/** Convert comma-separated permission flag names to a bitfield string. */
export declare function resolvePermissions(flags: string): string;
export declare const CHANNEL_TYPES: Record<string, number>;
export declare const CHANNEL_TYPE_NAMES: Record<number, string>;
export declare const VERIFICATION_LEVELS: Record<string, number>;
export declare function invalidateCache(pattern?: string): void;
export declare function discordRequest(method: string, path: string, body?: Record<string, unknown>, timeout?: number, retryCount?: number): Promise<DiscordResponse>;
export declare function resolveGuildId(guildId?: string): Promise<{
    guildId: string;
} | {
    error: string;
}>;
export declare function resolveChannel(nameOrId: string, guildId: string): Promise<{
    id: string;
    name: string;
    type: number;
} | {
    error: string;
}>;
export declare function resolveRole(nameOrId: string, guildId: string): Promise<{
    id: string;
    name: string;
} | {
    error: string;
}>;
export declare function resolveUser(nameOrTag: string, guildId: string): Promise<{
    id: string;
    name: string;
} | {
    error: string;
}>;
export declare function getGuild(guildId: string): Promise<DiscordResponse>;
export declare function getGuildChannels(guildId: string): Promise<DiscordResponse | {
    id: string;
    name: string;
    type: number;
}[]>;
export declare function getGuildMembers(guildId: string, limit?: number, after?: string): Promise<DiscordResponse>;
export declare function getGuildRoles(guildId: string): Promise<DiscordResponse | {
    id: string;
    name: string;
    color: number;
    position: number;
}[]>;
export declare function getAuditLog(guildId: string, opts?: {
    action_type?: number;
    limit?: number;
}): Promise<DiscordResponse>;
export declare function editGuildSettings(guildId: string, settings: Record<string, unknown>): Promise<DiscordResponse>;
export declare function createChannel(guildId: string, data: Record<string, unknown>): Promise<DiscordResponse>;
export declare function editChannel(channelId: string, data: Record<string, unknown>): Promise<DiscordResponse>;
export declare function deleteChannel(channelId: string): Promise<DiscordResponse>;
export declare function setChannelPermissions(channelId: string, overwriteId: string, data: {
    type: number;
    allow: string;
    deny: string;
}): Promise<DiscordResponse>;
export declare function createRole(guildId: string, data: Record<string, unknown>): Promise<DiscordResponse>;
export declare function editRole(guildId: string, roleId: string, data: Record<string, unknown>): Promise<DiscordResponse>;
export declare function deleteRole(guildId: string, roleId: string): Promise<DiscordResponse>;
export declare function addMemberRole(guildId: string, userId: string, roleId: string): Promise<DiscordResponse>;
export declare function removeMemberRole(guildId: string, userId: string, roleId: string): Promise<DiscordResponse>;
export declare function sendMessage(channelId: string, data: Record<string, unknown>): Promise<DiscordResponse>;
export declare function editMessage(channelId: string, messageId: string, data: Record<string, unknown>): Promise<DiscordResponse>;
export declare function deleteMessage(channelId: string, messageId: string): Promise<DiscordResponse>;
export declare function pinMessage(channelId: string, messageId: string): Promise<DiscordResponse>;
export declare function unpinMessage(channelId: string, messageId: string): Promise<DiscordResponse>;
export declare function addReaction(channelId: string, messageId: string, emoji: string): Promise<DiscordResponse>;
export declare function getMessages(channelId: string, opts?: {
    limit?: number;
    before?: string;
    after?: string;
}): Promise<DiscordResponse>;
export declare function bulkDeleteMessages(channelId: string, messageIds: string[]): Promise<DiscordResponse>;
export declare function getMember(guildId: string, userId: string): Promise<DiscordResponse>;
export declare function kickMember(guildId: string, userId: string, reason?: string): Promise<DiscordResponse>;
export declare function banMember(guildId: string, userId: string, data?: {
    delete_message_seconds?: number;
}): Promise<DiscordResponse>;
export declare function unbanMember(guildId: string, userId: string): Promise<DiscordResponse>;
export declare function timeoutMember(guildId: string, userId: string, durationMinutes: number): Promise<DiscordResponse>;
export declare function setNickname(guildId: string, userId: string, nick: string | null): Promise<DiscordResponse>;
export declare function getWelcomeScreen(guildId: string): Promise<DiscordResponse>;
export declare function setWelcomeScreen(guildId: string, data: Record<string, unknown>): Promise<DiscordResponse>;
export declare function getOnboarding(guildId: string): Promise<DiscordResponse>;
export declare function setOnboarding(guildId: string, data: Record<string, unknown>): Promise<DiscordResponse>;
export declare function createWebhook(channelId: string, data: {
    name: string;
    avatar?: string;
}): Promise<DiscordResponse>;
export declare function editWebhook(webhookId: string, data: Record<string, unknown>): Promise<DiscordResponse>;
export declare function deleteWebhook(webhookId: string): Promise<DiscordResponse>;
export declare function listChannelWebhooks(channelId: string): Promise<DiscordResponse>;
export declare function listGuildWebhooks(guildId: string): Promise<DiscordResponse>;
export declare function executeWebhook(webhookId: string, webhookToken: string, data: Record<string, unknown>): Promise<DiscordResponse>;
export declare function createThread(channelId: string, data: Record<string, unknown>): Promise<DiscordResponse>;
export declare function createThreadFromMessage(channelId: string, messageId: string, data: Record<string, unknown>): Promise<DiscordResponse>;
export declare function modifyThread(threadId: string, data: Record<string, unknown>): Promise<DiscordResponse>;
export declare function deleteThread(threadId: string): Promise<DiscordResponse>;
//# sourceMappingURL=discord.d.ts.map