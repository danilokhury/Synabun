import { z } from 'zod';
import * as ni from '../services/neural-interface.js';
// ── browser_snapshot ──
export const browserSnapshotSchema = {
    selector: z.string().optional().describe('Scope snapshot to a specific element\'s subtree. Dramatically reduces output on complex pages. Twitter: [data-testid="primaryColumn"] for main feed, [data-testid="tweet"] for a single tweet card.'),
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};
export const browserSnapshotDescription = 'Get an accessibility tree snapshot of the current page. Returns a structured text representation of all visible elements with their ARIA roles, names, and values. This is the primary and most token-efficient way to "see" the page — prefer this over screenshots. ' +
    'Twitter/X: scope to [data-testid="primaryColumn"] for main feed, [data-testid="tweet"] for a single tweet card. ' +
    'Facebook: scope to [role="feed"] for group/page feed, [role="article"] for a single post, [role="dialog"] for the post composer dialog. ' +
    'TikTok: scope to article for a single video in For You feed, [data-e2e="search_top-item-list"] for search results, [data-tt="components_PostTable_Container"] for Studio content list. ' +
    'WhatsApp: scope to [aria-label="Lista de conversas"] for the chat list, [role="application"] for the open chat message view.';
// Roles that are pure structural containers with no semantic value when unnamed
const NOISE_ROLES = new Set(['none', 'presentation', 'generic']);
const MAX_DEPTH = 20;
function formatSnapshotNode(node, indent = 0) {
    if (!node || indent > MAX_DEPTH)
        return '';
    const role = node.role || 'generic';
    const children = node.children;
    const hasChildren = children && children.length > 0;
    // Skip pure noise nodes: unnamed container roles with no value and no children
    if (NOISE_ROLES.has(role) && !node.name && !node.value && !hasChildren) {
        return '';
    }
    const prefix = '  '.repeat(indent);
    const name = node.name ? ` "${node.name}"` : '';
    const value = node.value ? ` value="${node.value}"` : '';
    const desc = node.description ? ` (${node.description})` : '';
    const checked = node.checked !== undefined ? ` [${node.checked ? 'checked' : 'unchecked'}]` : '';
    const selected = node.selected ? ' [selected]' : '';
    const expanded = node.expanded !== undefined ? ` [${node.expanded ? 'expanded' : 'collapsed'}]` : '';
    const disabled = node.disabled ? ' [disabled]' : '';
    const focused = node.focused ? ' [focused]' : '';
    let line = `${prefix}${role}${name}${value}${desc}${checked}${selected}${expanded}${disabled}${focused}`;
    if (hasChildren) {
        const childLines = children
            .map(c => formatSnapshotNode(c, indent + 1))
            .filter(s => s.length > 0)
            .join('\n');
        if (childLines)
            line += '\n' + childLines;
    }
    return line;
}
export async function handleBrowserSnapshot(args) {
    const resolved = await ni.resolveSession(args.sessionId);
    if ('error' in resolved)
        return { content: [{ type: 'text', text: resolved.error }] };
    const result = await ni.snapshot(resolved.sessionId, args.selector);
    if (result.error)
        return { content: [{ type: 'text', text: `Snapshot failed: ${result.error}` }] };
    const tree = result.snapshot;
    const formatted = tree ? formatSnapshotNode(tree) : '(empty page)';
    let text = `Page: ${result.url}\nTitle: "${result.title}"\n`;
    if (args.selector)
        text += `Scope: ${args.selector}\n`;
    text += '\n' + formatted;
    // Truncate if very long
    if (text.length > 30000) {
        text = text.slice(0, 30000) + '\n... (truncated — narrow scope with selector param)';
    }
    return { content: [{ type: 'text', text }] };
}
// ── browser_content ──
export const browserContentSchema = {
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};
export const browserContentDescription = 'Get the text content of the current page along with its URL and title. Returns the visible text from the page body (up to 50K characters). Use this when you need raw text rather than the structured accessibility tree.';
export async function handleBrowserContent(args) {
    const resolved = await ni.resolveSession(args.sessionId);
    if ('error' in resolved)
        return { content: [{ type: 'text', text: resolved.error }] };
    const result = await ni.getContent(resolved.sessionId);
    if (result.error)
        return { content: [{ type: 'text', text: `Content failed: ${result.error}` }] };
    let text = `URL: ${result.url}\nTitle: "${result.title}"\n\n`;
    text += result.text || '(empty page)';
    return { content: [{ type: 'text', text }] };
}
// ── browser_screenshot ──
export const browserScreenshotSchema = {
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};
export const browserScreenshotDescription = 'Take a screenshot of the current page. Returns a base64-encoded JPEG image. Use sparingly — prefer browser_snapshot for most tasks as it is far more token-efficient.';
export async function handleBrowserScreenshot(args) {
    const resolved = await ni.resolveSession(args.sessionId);
    if ('error' in resolved)
        return { content: [{ type: 'text', text: resolved.error }] };
    const result = await ni.screenshot(resolved.sessionId);
    if (result.error)
        return { content: [{ type: 'text', text: `Screenshot failed: ${result.error}` }] };
    return {
        content: [
            { type: 'text', text: `Screenshot of ${result.url} — "${result.title}"` },
            { type: 'image', data: result.data, mimeType: 'image/jpeg' },
        ],
    };
}
// ── browser_extract_tweets ──
const TWEET_EXTRACTOR_SCRIPT = `
Array.from(document.querySelectorAll('[data-testid="tweet"]')).map(el => {
  const userNameEl = el.querySelector('[data-testid="User-Name"]');
  const lines = userNameEl ? userNameEl.innerText.split('\\n').filter(Boolean) : [];
  const statusLink = el.querySelector('a[href*="/status/"]');
  return {
    author:  lines[0] || null,
    handle:  lines.find(l => l.startsWith('@')) || null,
    text:    el.querySelector('[data-testid="tweetText"]')?.innerText || null,
    time:    el.querySelector('time')?.getAttribute('datetime') || null,
    url:     statusLink ? statusLink.href : null,
    replies: el.querySelector('[data-testid="reply"] span[data-testid="app-text-transition-container"]')?.innerText || null,
    reposts: el.querySelector('[data-testid="retweet"] span[data-testid="app-text-transition-container"]')?.innerText || null,
    likes:   el.querySelector('[data-testid="like"] span[data-testid="app-text-transition-container"]')?.innerText || null,
    views:   el.querySelector('a[href*="/analytics"] span')?.innerText || null,
  };
})
`.trim();
export const browserExtractTweetsSchema = {
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};
export const browserExtractTweetsDescription = 'Extract all currently visible tweets as structured JSON (author, handle, text, time, url, replies, reposts, likes, views). Much faster than browser_snapshot for data harvesting — use this in scraping/loop flows instead of reading the ARIA tree. Navigate to x.com/search?q=%23hashtag&f=live first for latest-first hashtag results.';
export async function handleBrowserExtractTweets(args) {
    const resolved = await ni.resolveSession(args.sessionId);
    if ('error' in resolved)
        return { content: [{ type: 'text', text: resolved.error }] };
    const result = await ni.evaluate(resolved.sessionId, TWEET_EXTRACTOR_SCRIPT);
    if (result.error)
        return { content: [{ type: 'text', text: `Extract failed: ${result.error}` }] };
    const tweets = result.result;
    if (!Array.isArray(tweets) || tweets.length === 0) {
        return { content: [{ type: 'text', text: `No tweets found. Try browser_scroll then retry.` }] };
    }
    const json = JSON.stringify(tweets, null, 2);
    return {
        content: [{ type: 'text', text: `${tweets.length} tweet(s):\n\n${json}` }],
    };
}
// ── browser_extract_fb_posts ──
const FB_POST_EXTRACTOR_SCRIPT = `
Array.from(document.querySelectorAll('[role="article"]')).map(el => {
  const h2Link = el.querySelector('h2 a, h3 a, h4 a, strong a');
  const timeLink = el.querySelector('a[href*="?__cft__"], a[href*="/posts/"], a[href*="/permalink/"]');
  const abbr = el.querySelector('abbr[title], abbr[data-utime]');
  const textEl = el.querySelector('[data-ad-comet-preview="message"], [data-ad-preview="message"]');
  const reactEl = el.querySelector('[aria-label*="reaction"], [aria-label*="reação"], [aria-label*="tepki"]');
  return {
    author: h2Link ? h2Link.textContent.trim() : null,
    authorUrl: h2Link ? h2Link.href : null,
    text: textEl ? textEl.innerText.trim() : (el.querySelector('[dir="auto"]')?.innerText?.trim() || null),
    time: abbr ? (abbr.getAttribute('title') || abbr.textContent.trim()) : (timeLink ? timeLink.textContent.trim() : null),
    postUrl: timeLink ? timeLink.href : null,
    reactions: reactEl ? reactEl.getAttribute('aria-label') : null,
  };
}).filter(p => p.author || p.text)
`.trim();
export const browserExtractFbPostsSchema = {
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};
export const browserExtractFbPostsDescription = 'Extract all currently visible Facebook posts as structured JSON (author, authorUrl, text, time, postUrl, reactions). ' +
    'Works on group feeds and Pages. Scroll down first with browser_scroll to load more posts. ' +
    'Much faster than browser_snapshot for data harvesting from Facebook.';
export async function handleBrowserExtractFbPosts(args) {
    const resolved = await ni.resolveSession(args.sessionId);
    if ('error' in resolved)
        return { content: [{ type: 'text', text: resolved.error }] };
    const result = await ni.evaluate(resolved.sessionId, FB_POST_EXTRACTOR_SCRIPT);
    if (result.error)
        return { content: [{ type: 'text', text: `Extract failed: ${result.error}` }] };
    const posts = result.result;
    if (!Array.isArray(posts) || posts.length === 0) {
        return { content: [{ type: 'text', text: 'No posts found. Try browser_scroll down then retry.' }] };
    }
    return {
        content: [{ type: 'text', text: `${posts.length} post(s):\n\n${JSON.stringify(posts, null, 2)}` }],
    };
}
// ── browser_extract_tiktok_videos ──
const TIKTOK_FEED_EXTRACTOR_SCRIPT = `
(() => {
  // Build a map of handle -> video metadata from global state (gives videoUrl, caption, music)
  const globalItems = window['__$UNIVERSAL_DATA$__']?.['__DEFAULT_SCOPE__']?.['webapp.updated-items'] || {};
  const stateMap = {};
  for (const key of Object.keys(globalItems)) {
    const item = globalItems[key];
    const h = item?.author?.uniqueId;
    if (h) stateMap[h] = { videoUrl: 'https://www.tiktok.com/@' + h + '/video/' + item.id, caption: item.desc || null, music: item.music?.title || null };
  }
  // Merge DOM counts (live) with state metadata
  return Array.from(document.querySelectorAll('article')).filter(el =>
    el.querySelector('[data-e2e="like-count"]')
  ).map(el => {
    const handle = el.querySelector('a[href^="/@"]')?.getAttribute('href')?.replace('/@','')?.split('?')[0] || null;
    const state = handle ? (stateMap[handle] || {}) : {};
    const likes = el.querySelector('[data-e2e="like-count"]')?.innerText?.trim() || null;
    const comments = el.querySelector('[data-e2e="comment-count"]')?.innerText?.trim() || null;
    const saves = el.querySelector('[data-e2e="undefined-count"]')?.innerText?.trim() || null;
    const shares = el.querySelector('[data-e2e="share-count"]')?.innerText?.trim() || null;
    const caption = state.caption || el.querySelector('[data-e2e="video-desc"]')?.innerText?.trim() || null;
    return { handle, videoUrl: state.videoUrl || null, caption, likes, comments, saves, shares, music: state.music || null };
  }).filter(v => v.handle);
})()
`.trim();
export const browserExtractTiktokVideosSchema = {
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};
export const browserExtractTiktokVideosDescription = 'Extract all currently visible TikTok videos from the For You or Following feed as structured JSON ' +
    '(handle, videoUrl, caption, likes, comments, saves, shares, music). ' +
    'Navigate to tiktok.com/ or tiktok.com/following first. Scroll with browser_scroll to load more videos. ' +
    'Much faster than browser_snapshot for data harvesting from TikTok feeds.';
export async function handleBrowserExtractTiktokVideos(args) {
    const resolved = await ni.resolveSession(args.sessionId);
    if ('error' in resolved)
        return { content: [{ type: 'text', text: resolved.error }] };
    const result = await ni.evaluate(resolved.sessionId, TIKTOK_FEED_EXTRACTOR_SCRIPT);
    if (result.error)
        return { content: [{ type: 'text', text: `Extract failed: ${result.error}` }] };
    const videos = result.result;
    if (!Array.isArray(videos) || videos.length === 0) {
        return { content: [{ type: 'text', text: 'No TikTok videos found. Make sure you are on tiktok.com/ or tiktok.com/following, then try browser_scroll down and retry.' }] };
    }
    return {
        content: [{ type: 'text', text: `${videos.length} video(s):\n\n${JSON.stringify(videos, null, 2)}` }],
    };
}
// ── browser_extract_tiktok_search ──
const TIKTOK_SEARCH_EXTRACTOR_SCRIPT = `
Array.from(document.querySelectorAll('[data-e2e="search_top-item"]')).map(el => {
  const videoLink = el.querySelector('a[href*="/video/"]');
  const userLink = el.querySelector('[data-e2e="search-card-user-link"]');
  const caption = el.querySelector('[data-e2e="search-card-video-caption"]');
  const uniqueId = el.querySelector('[data-e2e="search-card-user-unique-id"]');
  const views = el.querySelector('[data-e2e="video-views"]');
  return {
    videoUrl: videoLink ? videoLink.href : null,
    handle: uniqueId ? uniqueId.innerText.trim() : null,
    profileUrl: userLink ? userLink.href : null,
    caption: caption ? caption.innerText.trim() : null,
    views: views ? views.innerText.trim() : null,
  };
}).filter(v => v.videoUrl)
`.trim();
export const browserExtractTiktokSearchSchema = {
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};
export const browserExtractTiktokSearchDescription = 'Extract all currently visible TikTok search result videos as structured JSON ' +
    '(videoUrl, handle, profileUrl, caption, views). ' +
    'Navigate to tiktok.com/search?q=<query> first. Scroll to load more results. ' +
    'Much faster than browser_snapshot for harvesting TikTok search results.';
export async function handleBrowserExtractTiktokSearch(args) {
    const resolved = await ni.resolveSession(args.sessionId);
    if ('error' in resolved)
        return { content: [{ type: 'text', text: resolved.error }] };
    const result = await ni.evaluate(resolved.sessionId, TIKTOK_SEARCH_EXTRACTOR_SCRIPT);
    if (result.error)
        return { content: [{ type: 'text', text: `Extract failed: ${result.error}` }] };
    const videos = result.result;
    if (!Array.isArray(videos) || videos.length === 0) {
        return { content: [{ type: 'text', text: 'No search results found. Make sure you are on tiktok.com/search?q=... then retry.' }] };
    }
    return {
        content: [{ type: 'text', text: `${videos.length} result(s):\n\n${JSON.stringify(videos, null, 2)}` }],
    };
}
// ── browser_extract_tiktok_studio ──
const TIKTOK_STUDIO_EXTRACTOR_SCRIPT = `
Array.from(document.querySelectorAll('[data-tt="components_PostInfoCell_a"]')).map(link => {
  const row = link.closest('[data-tt="components_RowLayout_FlexRow"]') ||
              link.closest('[data-tt="components_ItemRow_FlexRow"]') ||
              link.parentElement?.closest('[class*="FlexRow"]');
  const dateEl = row?.querySelector('[data-tt="components_PublishStageLabel_TUXText"]');
  const privacyBtn = row?.querySelector('[data-tt="components_PrivacyCell_TUXButton"]');
  const statEls = row ? Array.from(row.querySelectorAll('[data-tt="components_ItemRow_TUXText"]')) : [];
  const stats = statEls.map(el => el.innerText.trim()).filter(Boolean);
  return {
    title: link.innerText.trim(),
    url: link.href,
    date: dateEl ? dateEl.innerText.trim() : null,
    privacy: privacyBtn ? privacyBtn.innerText.trim() : null,
    stats,
  };
}).filter(p => p.title)
`.trim();
export const browserExtractTiktokStudioSchema = {
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};
export const browserExtractTiktokStudioDescription = 'Extract all visible posts from TikTok Studio content list as structured JSON ' +
    '(title, url, date, privacy, stats[]). ' +
    'Navigate to tiktok.com/tiktokstudio/content first. Scroll to load more posts. ' +
    'Use this to audit, manage, or bulk-read your published TikTok content.';
export async function handleBrowserExtractTiktokStudio(args) {
    const resolved = await ni.resolveSession(args.sessionId);
    if ('error' in resolved)
        return { content: [{ type: 'text', text: resolved.error }] };
    const result = await ni.evaluate(resolved.sessionId, TIKTOK_STUDIO_EXTRACTOR_SCRIPT);
    if (result.error)
        return { content: [{ type: 'text', text: `Extract failed: ${result.error}` }] };
    const posts = result.result;
    if (!Array.isArray(posts) || posts.length === 0) {
        return { content: [{ type: 'text', text: 'No Studio posts found. Make sure you are on tiktok.com/tiktokstudio/content then retry.' }] };
    }
    return {
        content: [{ type: 'text', text: `${posts.length} post(s):\n\n${JSON.stringify(posts, null, 2)}` }],
    };
}
// ── browser_extract_tiktok_profile ──
const TIKTOK_PROFILE_EXTRACTOR_SCRIPT = `
(() => {
  const name = document.querySelector('[data-e2e="user-title"]')?.innerText?.trim() || null;
  const handle = document.querySelector('[data-e2e="user-subtitle"]')?.innerText?.trim() || null;
  const bio = document.querySelector('[data-e2e="user-bio"]')?.innerText?.trim() || null;
  const followers = document.querySelector('[data-e2e="followers-count"]')?.innerText?.trim() || null;
  const following = document.querySelector('[data-e2e="following-count"]')?.innerText?.trim() || null;
  const likes = document.querySelector('[data-e2e="likes-count"]')?.innerText?.trim() || null;
  const videoItems = Array.from(document.querySelectorAll('[data-e2e="user-post-item"]')).map(el => {
    const link = el.querySelector('a[href*="/video/"]');
    const views = el.querySelector('[data-e2e="video-views"]');
    return {
      videoUrl: link ? link.href : null,
      views: views ? views.innerText.trim() : null,
    };
  }).filter(v => v.videoUrl);
  return { name, handle, bio, followers, following, likes, videos: videoItems };
})()
`.trim();
export const browserExtractTiktokProfileSchema = {
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};
export const browserExtractTiktokProfileDescription = 'Extract profile info and video grid from a TikTok profile page as structured JSON ' +
    '(name, handle, bio, followers, following, likes, videos[{videoUrl, views}]). ' +
    'Navigate to tiktok.com/@username first. Scroll down to load more videos in the grid. ' +
    'Use this to audit a creator profile or collect video URLs for further processing.';
export async function handleBrowserExtractTiktokProfile(args) {
    const resolved = await ni.resolveSession(args.sessionId);
    if ('error' in resolved)
        return { content: [{ type: 'text', text: resolved.error }] };
    const result = await ni.evaluate(resolved.sessionId, TIKTOK_PROFILE_EXTRACTOR_SCRIPT);
    if (result.error)
        return { content: [{ type: 'text', text: `Extract failed: ${result.error}` }] };
    const profile = result.result;
    if (!profile || (!profile.name && !profile.handle)) {
        return { content: [{ type: 'text', text: 'No profile found. Make sure you are on tiktok.com/@username then retry.' }] };
    }
    return {
        content: [{ type: 'text', text: `Profile:\n\n${JSON.stringify(profile, null, 2)}` }],
    };
}
// ── browser_extract_wa_chats ──
const WA_CHATS_EXTRACTOR_SCRIPT = `
Array.from(document.querySelectorAll('[aria-label="Lista de conversas"] [role="row"]')).map(row => {
  const nameSpan = row.querySelector('span[title][dir="auto"]');
  const allSpans = Array.from(row.querySelectorAll('span')).filter(s => !s.children.length && s.innerText?.trim());
  const timeSpan = allSpans.find(s => /^\\d|Ontem|Hoje|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday/.test(s.innerText.trim()));
  const msgSpans = Array.from(row.querySelectorAll('span[dir="auto"]')).filter(s => !s.getAttribute('title') && s.innerText?.trim());
  const unreadEl = row.querySelector('[aria-label*="mensagem não lida"]');
  const mutedEl = row.querySelector('[aria-label="Conversa silenciada"]');
  const pinnedEl = row.querySelector('[aria-label="Conversa fixada"]');
  const lastMsg = msgSpans.map(s => s.innerText.trim()).filter(t => t && t !== nameSpan?.innerText?.trim()).join(' ').substring(0, 80) || null;
  return {
    name: nameSpan?.getAttribute('title') || nameSpan?.innerText?.trim() || null,
    lastMsg,
    time: timeSpan?.innerText?.trim() || null,
    unreadCount: unreadEl?.innerText?.trim() || null,
    muted: !!mutedEl,
    pinned: !!pinnedEl,
  };
}).filter(c => c.name)
`.trim();
export const browserExtractWaChatsSchema = {
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};
export const browserExtractWaChatsDescription = 'Extract all currently visible WhatsApp chats from the sidebar as structured JSON ' +
    '(name, lastMsg, time, unreadCount, muted, pinned). ' +
    'Must be on web.whatsapp.com with the chat list visible. Scroll the sidebar with browser_scroll to load more chats. ' +
    'Use browser_click on span[title="Chat Name"] to open a specific chat.';
export async function handleBrowserExtractWaChats(args) {
    const resolved = await ni.resolveSession(args.sessionId);
    if ('error' in resolved)
        return { content: [{ type: 'text', text: resolved.error }] };
    const result = await ni.evaluate(resolved.sessionId, WA_CHATS_EXTRACTOR_SCRIPT);
    if (result.error)
        return { content: [{ type: 'text', text: `Extract failed: ${result.error}` }] };
    const chats = result.result;
    if (!Array.isArray(chats) || chats.length === 0) {
        return { content: [{ type: 'text', text: 'No chats found. Make sure you are on web.whatsapp.com with the chat list visible.' }] };
    }
    return {
        content: [{ type: 'text', text: `${chats.length} chat(s):\n\n${JSON.stringify(chats, null, 2)}` }],
    };
}
// ── browser_extract_wa_messages ──
const WA_MESSAGES_EXTRACTOR_SCRIPT = `
Array.from(document.querySelectorAll('div.copyable-text[data-pre-plain-text]')).map(el => {
  const meta = el.getAttribute('data-pre-plain-text') || '';
  const timeMatch = meta.match(/\\[([^,]+),\\s*([^\\]]+)\\]/);
  const senderMatch = meta.match(/\\]\\s*([^:]+):/);
  const isOut = !!el.closest('.message-out');
  const dataId = el.closest('[data-id]')?.getAttribute('data-id') || null;
  const textContent = el.innerText?.trim() || null;
  return {
    sender: senderMatch ? senderMatch[1].trim() : (isOut ? 'Me' : null),
    time: timeMatch ? timeMatch[1].trim() : null,
    date: timeMatch ? timeMatch[2].trim() : null,
    direction: isOut ? 'out' : 'in',
    text: textContent,
    dataId,
  };
}).filter(m => m.text)
`.trim();
export const browserExtractWaMessagesSchema = {
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};
export const browserExtractWaMessagesDescription = 'Extract all currently visible messages from the open WhatsApp chat as structured JSON ' +
    '(sender, time, date, direction, text, dataId). ' +
    'Open a chat first by clicking span[title="Chat Name"]. Scroll up with browser_scroll to load older messages. ' +
    'direction is "in" for received and "out" for sent messages.';
export async function handleBrowserExtractWaMessages(args) {
    const resolved = await ni.resolveSession(args.sessionId);
    if ('error' in resolved)
        return { content: [{ type: 'text', text: resolved.error }] };
    const result = await ni.evaluate(resolved.sessionId, WA_MESSAGES_EXTRACTOR_SCRIPT);
    if (result.error)
        return { content: [{ type: 'text', text: `Extract failed: ${result.error}` }] };
    const messages = result.result;
    if (!Array.isArray(messages) || messages.length === 0) {
        return { content: [{ type: 'text', text: 'No messages found. Open a chat first, then retry.' }] };
    }
    return {
        content: [{ type: 'text', text: `${messages.length} message(s):\n\n${JSON.stringify(messages, null, 2)}` }],
    };
}
//# sourceMappingURL=browser-observe.js.map