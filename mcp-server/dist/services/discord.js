/**
 * Discord REST API v10 client for MCP tools.
 * Follows the neural-interface.ts pattern: typed HTTP client with
 * timeout handling, rate limit retry, and name resolution helpers.
 */
const API_BASE = 'https://discord.com/api/v10';
const DEFAULT_TIMEOUT = 10_000;
const LONG_TIMEOUT = 30_000;
const MAX_RETRIES = 3;
// ── Permission flags ───────────────────────────────────────────
export const PERMISSION_FLAGS = {
    CREATE_INSTANT_INVITE: 1n << 0n,
    KICK_MEMBERS: 1n << 1n,
    BAN_MEMBERS: 1n << 2n,
    ADMINISTRATOR: 1n << 3n,
    MANAGE_CHANNELS: 1n << 4n,
    MANAGE_GUILD: 1n << 5n,
    ADD_REACTIONS: 1n << 6n,
    VIEW_AUDIT_LOG: 1n << 7n,
    PRIORITY_SPEAKER: 1n << 8n,
    STREAM: 1n << 9n,
    VIEW_CHANNEL: 1n << 10n,
    SEND_MESSAGES: 1n << 11n,
    SEND_TTS_MESSAGES: 1n << 12n,
    MANAGE_MESSAGES: 1n << 13n,
    EMBED_LINKS: 1n << 14n,
    ATTACH_FILES: 1n << 15n,
    READ_MESSAGE_HISTORY: 1n << 16n,
    MENTION_EVERYONE: 1n << 17n,
    USE_EXTERNAL_EMOJIS: 1n << 18n,
    VIEW_GUILD_INSIGHTS: 1n << 19n,
    CONNECT: 1n << 20n,
    SPEAK: 1n << 21n,
    MUTE_MEMBERS: 1n << 22n,
    DEAFEN_MEMBERS: 1n << 23n,
    MOVE_MEMBERS: 1n << 24n,
    USE_VAD: 1n << 25n,
    CHANGE_NICKNAME: 1n << 26n,
    MANAGE_NICKNAMES: 1n << 27n,
    MANAGE_ROLES: 1n << 28n,
    MANAGE_WEBHOOKS: 1n << 29n,
    MANAGE_GUILD_EXPRESSIONS: 1n << 30n,
    USE_APPLICATION_COMMANDS: 1n << 31n,
    REQUEST_TO_SPEAK: 1n << 32n,
    MANAGE_EVENTS: 1n << 33n,
    MANAGE_THREADS: 1n << 34n,
    CREATE_PUBLIC_THREADS: 1n << 35n,
    CREATE_PRIVATE_THREADS: 1n << 36n,
    USE_EXTERNAL_STICKERS: 1n << 37n,
    SEND_MESSAGES_IN_THREADS: 1n << 38n,
    USE_EMBEDDED_ACTIVITIES: 1n << 39n,
    MODERATE_MEMBERS: 1n << 40n,
    VIEW_CREATOR_MONETIZATION_ANALYTICS: 1n << 41n,
    USE_SOUNDBOARD: 1n << 42n,
    CREATE_GUILD_EXPRESSIONS: 1n << 43n,
    CREATE_EVENTS: 1n << 44n,
    USE_EXTERNAL_SOUNDS: 1n << 45n,
    SEND_VOICE_MESSAGES: 1n << 46n,
    SEND_POLLS: 1n << 49n,
    USE_EXTERNAL_APPS: 1n << 50n,
};
/** Convert comma-separated permission flag names to a bitfield string. */
export function resolvePermissions(flags) {
    let bits = 0n;
    for (const flag of flags.split(',').map(f => f.trim().toUpperCase())) {
        const val = PERMISSION_FLAGS[flag];
        if (!val) {
            const available = Object.keys(PERMISSION_FLAGS).join(', ');
            throw new Error(`Unknown permission flag: "${flag}". Available: ${available}`);
        }
        bits |= val;
    }
    return bits.toString();
}
// ── Channel type mapping ───────────────────────────────────────
export const CHANNEL_TYPES = {
    text: 0,
    voice: 2,
    category: 4,
    announcement: 5,
    stage: 13,
    forum: 15,
};
export const CHANNEL_TYPE_NAMES = {
    0: 'text',
    2: 'voice',
    4: 'category',
    5: 'announcement',
    10: 'announcement-thread',
    11: 'public-thread',
    12: 'private-thread',
    13: 'stage',
    15: 'forum',
};
// ── Verification levels ────────────────────────────────────────
export const VERIFICATION_LEVELS = {
    none: 0,
    low: 1,
    medium: 2,
    high: 3,
    very_high: 4,
};
// ── Cache ──────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
function getCached(key) {
    const entry = cache.get(key);
    if (!entry || Date.now() > entry.expiresAt) {
        cache.delete(key);
        return null;
    }
    return entry.data;
}
function setCache(key, data) {
    cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL });
}
export function invalidateCache(pattern) {
    if (!pattern) {
        cache.clear();
        return;
    }
    for (const key of cache.keys()) {
        if (key.includes(pattern))
            cache.delete(key);
    }
}
// ── Token validation ───────────────────────────────────────────
function getToken() {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
        throw new Error('DISCORD_BOT_TOKEN not set. Add it to your .env file:\n' +
            'DISCORD_BOT_TOKEN=your_bot_token_here\n\n' +
            'Create a bot at https://discord.com/developers/applications');
    }
    return token;
}
// ── Core HTTP request ──────────────────────────────────────────
export async function discordRequest(method, path, body, timeout = DEFAULT_TIMEOUT, retryCount = 0) {
    let token;
    try {
        token = getToken();
    }
    catch (err) {
        return { error: err.message };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const opts = {
            method,
            headers: {
                'Authorization': `Bot ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'SynaBun-MCP (https://github.com/synabun, 1.0.0)',
            },
            signal: controller.signal,
        };
        if (body && method !== 'GET') {
            opts.body = JSON.stringify(body);
        }
        const res = await fetch(`${API_BASE}${path}`, opts);
        // Rate limited — retry with Retry-After
        if (res.status === 429 && retryCount < MAX_RETRIES) {
            const retryData = await res.json();
            const retryAfter = retryData.retry_after || 1;
            await new Promise(r => setTimeout(r, retryAfter * 1000));
            return discordRequest(method, path, body, timeout, retryCount + 1);
        }
        // No content (successful delete, etc.)
        if (res.status === 204) {
            return { ok: true };
        }
        const data = await res.json();
        if (!res.ok) {
            // Discord error response
            const message = data.message || `HTTP ${res.status}`;
            const code = data.code;
            return { error: `Discord API error ${code || res.status}: ${message}` };
        }
        return { ok: true, data };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('abort')) {
            return { error: `Request timed out after ${timeout}ms` };
        }
        return { error: `Discord API unreachable: ${msg}` };
    }
    finally {
        clearTimeout(timer);
    }
}
// ── Guild resolution ───────────────────────────────────────────
export async function resolveGuildId(guildId) {
    if (guildId)
        return { guildId };
    const envGuild = process.env.DISCORD_GUILD_ID;
    if (envGuild)
        return { guildId: envGuild };
    // Auto-detect: if bot is in exactly 1 guild, use it
    const res = await discordRequest('GET', '/users/@me/guilds');
    if (res.error)
        return { error: res.error };
    const guilds = res.data;
    if (guilds.length === 1)
        return { guildId: guilds[0].id };
    if (guilds.length === 0)
        return { error: 'Bot is not in any guilds. Invite it to a server first.' };
    const list = guilds.map(g => `  ${g.id} — ${g.name}`).join('\n');
    return { error: `Bot is in multiple guilds. Specify guild_id:\n${list}\n\nOr set DISCORD_GUILD_ID in your .env file.` };
}
// ── Name resolution helpers ────────────────────────────────────
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
function isSnowflake(value) {
    return SNOWFLAKE_PATTERN.test(value);
}
export async function resolveChannel(nameOrId, guildId) {
    if (isSnowflake(nameOrId)) {
        return { id: nameOrId, name: nameOrId, type: -1 };
    }
    const channels = await getGuildChannels(guildId);
    if (!Array.isArray(channels))
        return { error: channels.error || 'Failed to fetch channels' };
    const normalized = nameOrId.toLowerCase().replace(/^#/, '');
    const matches = channels
        .filter(c => c.name.toLowerCase() === normalized);
    if (matches.length === 0) {
        return { error: `Channel "${nameOrId}" not found in guild.` };
    }
    if (matches.length > 1) {
        const list = matches.map(c => `  ${c.id} — #${c.name} (${CHANNEL_TYPE_NAMES[c.type] || 'unknown'})`).join('\n');
        return { error: `Multiple channels named "${nameOrId}". Specify by ID:\n${list}` };
    }
    return matches[0];
}
export async function resolveRole(nameOrId, guildId) {
    if (isSnowflake(nameOrId)) {
        return { id: nameOrId, name: nameOrId };
    }
    const roles = await getGuildRoles(guildId);
    if (!Array.isArray(roles))
        return { error: roles.error || 'Failed to fetch roles' };
    const normalized = nameOrId.toLowerCase().replace(/^@/, '');
    const matches = roles
        .filter(r => r.name.toLowerCase() === normalized);
    if (matches.length === 0) {
        return { error: `Role "${nameOrId}" not found in guild.` };
    }
    if (matches.length > 1) {
        const list = matches.map(r => `  ${r.id} — @${r.name}`).join('\n');
        return { error: `Multiple roles named "${nameOrId}". Specify by ID:\n${list}` };
    }
    return matches[0];
}
export async function resolveUser(nameOrTag, guildId) {
    if (isSnowflake(nameOrTag)) {
        return { id: nameOrTag, name: nameOrTag };
    }
    // Search guild members by query
    const res = await discordRequest('GET', `/guilds/${guildId}/members/search?query=${encodeURIComponent(nameOrTag)}&limit=10`);
    if (res.error)
        return { error: res.error };
    const members = res.data;
    if (members.length === 0) {
        return { error: `User "${nameOrTag}" not found in guild.` };
    }
    if (members.length === 1) {
        return { id: members[0].user.id, name: members[0].user.global_name || members[0].user.username };
    }
    const list = members.map(m => `  ${m.user.id} — ${m.user.global_name || m.user.username} (@${m.user.username})`).join('\n');
    return { error: `Multiple users match "${nameOrTag}". Specify by ID:\n${list}` };
}
// ── Guild operations ───────────────────────────────────────────
export async function getGuild(guildId) {
    return discordRequest('GET', `/guilds/${guildId}?with_counts=true`);
}
export async function getGuildChannels(guildId) {
    const cacheKey = `channels:${guildId}`;
    const cached = getCached(cacheKey);
    if (cached)
        return cached;
    const res = await discordRequest('GET', `/guilds/${guildId}/channels`);
    if (res.error)
        return { error: res.error };
    const channels = res.data;
    setCache(cacheKey, channels);
    return channels;
}
export async function getGuildMembers(guildId, limit = 100, after) {
    let path = `/guilds/${guildId}/members?limit=${limit}`;
    if (after)
        path += `&after=${after}`;
    return discordRequest('GET', path);
}
export async function getGuildRoles(guildId) {
    const cacheKey = `roles:${guildId}`;
    const cached = getCached(cacheKey);
    if (cached)
        return cached;
    const res = await discordRequest('GET', `/guilds/${guildId}/roles`);
    if (res.error)
        return { error: res.error };
    const roles = res.data;
    setCache(cacheKey, roles);
    return roles;
}
export async function getAuditLog(guildId, opts) {
    let path = `/guilds/${guildId}/audit-logs?limit=${opts?.limit || 50}`;
    if (opts?.action_type !== undefined)
        path += `&action_type=${opts.action_type}`;
    return discordRequest('GET', path);
}
export async function editGuildSettings(guildId, settings) {
    return discordRequest('PATCH', `/guilds/${guildId}`, settings);
}
// ── Channel operations ─────────────────────────────────────────
export async function createChannel(guildId, data) {
    invalidateCache(`channels:${guildId}`);
    return discordRequest('POST', `/guilds/${guildId}/channels`, data);
}
export async function editChannel(channelId, data) {
    invalidateCache('channels:');
    return discordRequest('PATCH', `/channels/${channelId}`, data);
}
export async function deleteChannel(channelId) {
    invalidateCache('channels:');
    return discordRequest('DELETE', `/channels/${channelId}`);
}
export async function setChannelPermissions(channelId, overwriteId, data) {
    return discordRequest('PUT', `/channels/${channelId}/permissions/${overwriteId}`, data);
}
// ── Role operations ────────────────────────────────────────────
export async function createRole(guildId, data) {
    invalidateCache(`roles:${guildId}`);
    return discordRequest('POST', `/guilds/${guildId}/roles`, data);
}
export async function editRole(guildId, roleId, data) {
    invalidateCache(`roles:${guildId}`);
    return discordRequest('PATCH', `/guilds/${guildId}/roles/${roleId}`, data);
}
export async function deleteRole(guildId, roleId) {
    invalidateCache(`roles:${guildId}`);
    return discordRequest('DELETE', `/guilds/${guildId}/roles/${roleId}`);
}
export async function addMemberRole(guildId, userId, roleId) {
    return discordRequest('PUT', `/guilds/${guildId}/members/${userId}/roles/${roleId}`, {});
}
export async function removeMemberRole(guildId, userId, roleId) {
    return discordRequest('DELETE', `/guilds/${guildId}/members/${userId}/roles/${roleId}`);
}
// ── Message operations ─────────────────────────────────────────
export async function sendMessage(channelId, data) {
    return discordRequest('POST', `/channels/${channelId}/messages`, data);
}
export async function editMessage(channelId, messageId, data) {
    return discordRequest('PATCH', `/channels/${channelId}/messages/${messageId}`, data);
}
export async function deleteMessage(channelId, messageId) {
    return discordRequest('DELETE', `/channels/${channelId}/messages/${messageId}`);
}
export async function pinMessage(channelId, messageId) {
    return discordRequest('PUT', `/channels/${channelId}/pins/${messageId}`, {});
}
export async function unpinMessage(channelId, messageId) {
    return discordRequest('DELETE', `/channels/${channelId}/pins/${messageId}`);
}
export async function addReaction(channelId, messageId, emoji) {
    const encoded = encodeURIComponent(emoji);
    return discordRequest('PUT', `/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`, {});
}
export async function getMessages(channelId, opts) {
    let path = `/channels/${channelId}/messages?limit=${opts?.limit || 50}`;
    if (opts?.before)
        path += `&before=${opts.before}`;
    if (opts?.after)
        path += `&after=${opts.after}`;
    return discordRequest('GET', path);
}
export async function bulkDeleteMessages(channelId, messageIds) {
    return discordRequest('POST', `/channels/${channelId}/messages/bulk-delete`, { messages: messageIds });
}
// ── Member operations ──────────────────────────────────────────
export async function getMember(guildId, userId) {
    return discordRequest('GET', `/guilds/${guildId}/members/${userId}`);
}
export async function kickMember(guildId, userId, reason) {
    const headers = reason ? { 'X-Audit-Log-Reason': encodeURIComponent(reason) } : undefined;
    // Can't pass custom headers through discordRequest — use reason in query if needed
    return discordRequest('DELETE', `/guilds/${guildId}/members/${userId}`);
}
export async function banMember(guildId, userId, data) {
    return discordRequest('PUT', `/guilds/${guildId}/bans/${userId}`, data || {});
}
export async function unbanMember(guildId, userId) {
    return discordRequest('DELETE', `/guilds/${guildId}/bans/${userId}`);
}
export async function timeoutMember(guildId, userId, durationMinutes) {
    const until = durationMinutes > 0
        ? new Date(Date.now() + durationMinutes * 60_000).toISOString()
        : null;
    return discordRequest('PATCH', `/guilds/${guildId}/members/${userId}`, {
        communication_disabled_until: until,
    });
}
export async function setNickname(guildId, userId, nick) {
    return discordRequest('PATCH', `/guilds/${guildId}/members/${userId}`, { nick });
}
// ── Onboarding operations ──────────────────────────────────────
export async function getWelcomeScreen(guildId) {
    return discordRequest('GET', `/guilds/${guildId}/welcome-screen`);
}
export async function setWelcomeScreen(guildId, data) {
    return discordRequest('PATCH', `/guilds/${guildId}/welcome-screen`, data);
}
export async function getOnboarding(guildId) {
    return discordRequest('GET', `/guilds/${guildId}/onboarding`);
}
export async function setOnboarding(guildId, data) {
    return discordRequest('PUT', `/guilds/${guildId}/onboarding`, data);
}
// ── Webhook operations ─────────────────────────────────────────
export async function createWebhook(channelId, data) {
    return discordRequest('POST', `/channels/${channelId}/webhooks`, data);
}
export async function editWebhook(webhookId, data) {
    return discordRequest('PATCH', `/webhooks/${webhookId}`, data);
}
export async function deleteWebhook(webhookId) {
    return discordRequest('DELETE', `/webhooks/${webhookId}`);
}
export async function listChannelWebhooks(channelId) {
    return discordRequest('GET', `/channels/${channelId}/webhooks`);
}
export async function listGuildWebhooks(guildId) {
    return discordRequest('GET', `/guilds/${guildId}/webhooks`);
}
export async function executeWebhook(webhookId, webhookToken, data) {
    // Webhook execution uses token auth, not bot auth — make direct fetch call
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
    try {
        const res = await fetch(`${API_BASE}/webhooks/${webhookId}/${webhookToken}?wait=true`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify(data),
        });
        if (res.status === 204)
            return { ok: true };
        const result = await res.json();
        if (!res.ok) {
            return { error: `Webhook error ${res.status}: ${result.message || 'Unknown error'}` };
        }
        return { ok: true, data: result };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `Webhook execution failed: ${msg}` };
    }
    finally {
        clearTimeout(timer);
    }
}
// ── Thread operations ──────────────────────────────────────────
export async function createThread(channelId, data) {
    return discordRequest('POST', `/channels/${channelId}/threads`, data);
}
export async function createThreadFromMessage(channelId, messageId, data) {
    return discordRequest('POST', `/channels/${channelId}/messages/${messageId}/threads`, data);
}
export async function modifyThread(threadId, data) {
    return discordRequest('PATCH', `/channels/${threadId}`, data);
}
export async function deleteThread(threadId) {
    return discordRequest('DELETE', `/channels/${threadId}`);
}
//# sourceMappingURL=discord.js.map