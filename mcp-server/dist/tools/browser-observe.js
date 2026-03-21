import { z } from 'zod';
import * as ni from '../services/neural-interface.js';
import { text, image } from './response.js';
// ── browser_snapshot ──
export const browserSnapshotSchema = {
    selector: z.string().optional().describe('Scope snapshot to a specific element\'s subtree. Dramatically reduces output on complex pages. Twitter: [data-testid="primaryColumn"] for main feed, [data-testid="tweet"] for a single tweet card.'),
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};
export const browserSnapshotDescription = 'Get an accessibility tree snapshot of the current page. Returns a structured text representation of all visible elements with their ARIA roles, names, and values. This is the primary and most token-efficient way to "see" the page — prefer this over screenshots. ' +
    'Twitter/X: scope to [data-testid="primaryColumn"] for main feed, [data-testid="tweet"] for a single tweet card. ' +
    'Facebook: scope to [role="feed"] for group/page feed, [role="article"] for a single post, [role="dialog"] for the post composer dialog. ' +
    'TikTok: scope to article for a single video in For You feed, [data-e2e="search_top-item-list"] for search results, [data-tt="components_PostTable_Container"] for Studio content list. ' +
    'WhatsApp: scope to [aria-label="Lista de conversas"] for the chat list, [role="application"] for the open chat message view. ' +
    'Instagram: scope to article for a single feed post, header for profile info, main for a post page with comments, form for the comment input area. ' +
    'LinkedIn: scope to .feed-shared-update-v2[data-urn] for a single feed post, .scaffold-layout__main for main content, .msg-conversation-listitem for a messaging conversation, article.nt-card for a notification, [role="dialog"] for the post composer.';
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
        return text(resolved.error);
    const result = await ni.snapshot(resolved.sessionId, args.selector);
    if (result.error)
        return text(`Snapshot failed: ${result.error}`);
    const tree = result.snapshot;
    const formatted = tree ? formatSnapshotNode(tree) : '(empty page)';
    let msg = `Page: ${result.url}\nTitle: "${result.title}"\n`;
    if (args.selector)
        msg += `Scope: ${args.selector}\n`;
    msg += '\n' + formatted;
    // Truncate if very long
    if (msg.length > 30000) {
        msg = msg.slice(0, 30000) + '\n... (truncated — narrow scope with selector param)';
    }
    return text(msg);
}
// ── browser_content ──
export const browserContentSchema = {
    format: z.enum(['text', 'markdown']).optional().default('text').describe('Output format. "text" returns raw innerText (fast, no structure). "markdown" returns clean markdown with headings, links, and lists preserved — strips nav/header/footer/ads automatically. Markdown is better for LLM consumption.'),
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};
export const browserContentDescription = 'Get the content of the current page. Set format="markdown" for clean markdown with structure preserved (headings, links, lists) — nav/header/footer/ads stripped automatically. Default format="text" returns raw visible text. Markdown is preferred for LLM consumption — up to 80% more token-efficient than raw HTML.';
export async function handleBrowserContent(args) {
    const resolved = await ni.resolveSession(args.sessionId);
    if ('error' in resolved)
        return text(resolved.error);
    if (args.format === 'markdown') {
        const result = await ni.getMarkdown(resolved.sessionId);
        if (result.error)
            return text(`Markdown extraction failed: ${result.error}`);
        let msg = `URL: ${result.url}\nTitle: "${result.title}"\nTokens: ~${result.tokens}\n\n`;
        msg += result.markdown || '(empty page)';
        return text(msg);
    }
    // Default: plain text
    const result = await ni.getContent(resolved.sessionId);
    if (result.error)
        return text(`Content failed: ${result.error}`);
    let msg = `URL: ${result.url}\nTitle: "${result.title}"\n\n`;
    msg += result.text || '(empty page)';
    return text(msg);
}
// ── browser_screenshot ──
export const browserScreenshotSchema = {
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};
export const browserScreenshotDescription = 'Take a screenshot of the current page. Returns a base64-encoded JPEG image. Use sparingly — prefer browser_snapshot for most tasks as it is far more token-efficient.';
export async function handleBrowserScreenshot(args) {
    const resolved = await ni.resolveSession(args.sessionId);
    if ('error' in resolved)
        return text(resolved.error);
    const result = await ni.screenshot(resolved.sessionId);
    if (result.error)
        return text(`Screenshot failed: ${result.error}`);
    return {
        content: [
            ...text(`Screenshot of ${result.url} — "${result.title}"`).content,
            ...image(result.data, 'image/jpeg').content,
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
        return text(resolved.error);
    const result = await ni.evaluate(resolved.sessionId, TWEET_EXTRACTOR_SCRIPT);
    if (result.error)
        return text(`Extract failed: ${result.error}`);
    const tweets = result.result;
    if (!Array.isArray(tweets) || tweets.length === 0) {
        return text(`No tweets found. Try browser_scroll then retry.`);
    }
    const json = JSON.stringify(tweets, null, 2);
    return text(`${tweets.length} tweet(s):\n\n${json}`);
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
        return text(resolved.error);
    const result = await ni.evaluate(resolved.sessionId, FB_POST_EXTRACTOR_SCRIPT);
    if (result.error)
        return text(`Extract failed: ${result.error}`);
    const posts = result.result;
    if (!Array.isArray(posts) || posts.length === 0) {
        return text('No posts found. Try browser_scroll down then retry.');
    }
    return text(`${posts.length} post(s):\n\n${JSON.stringify(posts, null, 2)}`);
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
        return text(resolved.error);
    const result = await ni.evaluate(resolved.sessionId, TIKTOK_FEED_EXTRACTOR_SCRIPT);
    if (result.error)
        return text(`Extract failed: ${result.error}`);
    const videos = result.result;
    if (!Array.isArray(videos) || videos.length === 0) {
        return text('No TikTok videos found. Make sure you are on tiktok.com/ or tiktok.com/following, then try browser_scroll down and retry.');
    }
    return text(`${videos.length} video(s):\n\n${JSON.stringify(videos, null, 2)}`);
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
        return text(resolved.error);
    const result = await ni.evaluate(resolved.sessionId, TIKTOK_SEARCH_EXTRACTOR_SCRIPT);
    if (result.error)
        return text(`Extract failed: ${result.error}`);
    const videos = result.result;
    if (!Array.isArray(videos) || videos.length === 0) {
        return text('No search results found. Make sure you are on tiktok.com/search?q=... then retry.');
    }
    return text(`${videos.length} result(s):\n\n${JSON.stringify(videos, null, 2)}`);
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
        return text(resolved.error);
    const result = await ni.evaluate(resolved.sessionId, TIKTOK_STUDIO_EXTRACTOR_SCRIPT);
    if (result.error)
        return text(`Extract failed: ${result.error}`);
    const posts = result.result;
    if (!Array.isArray(posts) || posts.length === 0) {
        return text('No Studio posts found. Make sure you are on tiktok.com/tiktokstudio/content then retry.');
    }
    return text(`${posts.length} post(s):\n\n${JSON.stringify(posts, null, 2)}`);
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
        return text(resolved.error);
    const result = await ni.evaluate(resolved.sessionId, TIKTOK_PROFILE_EXTRACTOR_SCRIPT);
    if (result.error)
        return text(`Extract failed: ${result.error}`);
    const profile = result.result;
    if (!profile || (!profile.name && !profile.handle)) {
        return text('No profile found. Make sure you are on tiktok.com/@username then retry.');
    }
    return text(`Profile:\n\n${JSON.stringify(profile, null, 2)}`);
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
        return text(resolved.error);
    const result = await ni.evaluate(resolved.sessionId, WA_CHATS_EXTRACTOR_SCRIPT);
    if (result.error)
        return text(`Extract failed: ${result.error}`);
    const chats = result.result;
    if (!Array.isArray(chats) || chats.length === 0) {
        return text('No chats found. Make sure you are on web.whatsapp.com with the chat list visible.');
    }
    return text(`${chats.length} chat(s):\n\n${JSON.stringify(chats, null, 2)}`);
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
        return text(resolved.error);
    const result = await ni.evaluate(resolved.sessionId, WA_MESSAGES_EXTRACTOR_SCRIPT);
    if (result.error)
        return text(`Extract failed: ${result.error}`);
    const messages = result.result;
    if (!Array.isArray(messages) || messages.length === 0) {
        return text('No messages found. Open a chat first, then retry.');
    }
    return text(`${messages.length} message(s):\n\n${JSON.stringify(messages, null, 2)}`);
}
// ── browser_extract_ig_feed ──
const IG_FEED_EXTRACTOR_SCRIPT = `
Array.from(document.querySelectorAll('article')).map(el => {
  const userLink = Array.from(el.querySelectorAll('a[href^="/"]')).find(a => a.getAttribute('href')?.match(/^\\/[^/]+\\/$/) && !a.getAttribute('href').includes('/p/') && !a.getAttribute('href').includes('/reel/') && !a.getAttribute('href').includes('/explore/'));
  const username = userLink?.textContent?.trim() || null;
  const profileUrl = userLink ? 'https://www.instagram.com' + userLink.getAttribute('href') : null;
  const postLink = el.querySelector('a[href*="/p/"], a[href*="/reel/"]');
  const postUrl = postLink ? 'https://www.instagram.com' + postLink.getAttribute('href') : null;
  const captionEl = el.querySelector('span._ap3a._aaco._aacu._aacx._aad7._aade');
  const caption = captionEl?.innerText?.trim() || null;
  const countSpans = Array.from(el.querySelectorAll('section span')).filter(s => s.children.length === 0 && /^[\\d.,]+\\s*(mil|M|K|B)?$/.test(s.textContent?.trim() || ''));
  const likes = countSpans[0]?.textContent?.trim() || null;
  const comments = countSpans[1]?.textContent?.trim() || null;
  const timeEl = el.querySelector('time');
  const time = timeEl?.textContent?.trim() || null;
  const datetime = timeEl?.getAttribute('datetime') || null;
  const isSponsored = !!Array.from(el.querySelectorAll('span')).find(s => s.textContent?.trim() === 'Patrocinado' || s.textContent?.trim() === 'Sponsored');
  const hasFollow = !!Array.from(el.querySelectorAll('*')).find(e => (e.textContent?.trim() === 'Seguir' || e.textContent?.trim() === 'Follow') && e.children.length === 0);
  return { username, profileUrl, postUrl, caption, likes, comments, time, datetime, isSponsored, hasFollow };
}).filter(p => p.username || p.caption)
`;
export const browserExtractIgFeedSchema = {
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};
export const browserExtractIgFeedDescription = 'Extract all currently visible Instagram feed posts as structured JSON ' +
    '(username, profileUrl, postUrl, caption, likes, comments, time, datetime, isSponsored, hasFollow). ' +
    'Navigate to instagram.com/ first. Scroll down with browser_scroll to load more posts.';
export async function handleBrowserExtractIgFeed(args) {
    const resolved = await ni.resolveSession(args.sessionId);
    if ('error' in resolved)
        return text(resolved.error);
    const result = await ni.evaluate(resolved.sessionId, IG_FEED_EXTRACTOR_SCRIPT);
    if (result.error)
        return text(`Extract failed: ${result.error}`);
    const posts = result.result;
    if (!Array.isArray(posts) || posts.length === 0) {
        return text('No feed posts found. Navigate to instagram.com/ and scroll down, then retry.');
    }
    return text(`${posts.length} post(s):\n\n${JSON.stringify(posts, null, 2)}`);
}
// ── browser_extract_ig_profile ──
const IG_PROFILE_EXTRACTOR_SCRIPT = `
(() => {
  const header = document.querySelector('header');
  if (!header) return null;
  const username = header.querySelector('h2')?.textContent?.trim() || header.querySelector('h1')?.textContent?.trim() || null;
  const nameSpan = header.querySelector('span[dir="auto"]');
  const displayName = nameSpan?.textContent?.trim() || null;
  const statTexts = Array.from(header.querySelectorAll('span')).filter(s => {
    const t = s.textContent?.trim() || '';
    return t.includes('post') || t.includes('seguidore') || t.includes('seguind') || t.includes('follower') || t.includes('following');
  });
  const posts = statTexts.find(s => /post/i.test(s.textContent))?.textContent?.trim() || null;
  const followers = statTexts.find(s => /seguidore|follower/i.test(s.textContent))?.textContent?.trim() || null;
  const following = statTexts.find(s => /seguind|following/i.test(s.textContent))?.textContent?.trim() || null;
  const followerExact = header.querySelector('span[title]')?.getAttribute('title') || null;
  const bioSpans = Array.from(header.querySelectorAll('span[dir="auto"]')).filter(s => {
    const t = s.textContent?.trim();
    return t && t !== username && t !== displayName && t.length > 2 && !/(post|seguidore|seguind|follower|following)/i.test(t);
  });
  const bio = bioSpans.map(s => s.textContent?.trim()).join('\\n') || null;
  const extLink = header.querySelector('a[href*="l.instagram.com"]');
  const website = extLink?.textContent?.trim() || null;
  const isVerified = !!header.querySelector('svg[aria-label="Verificado"], svg[aria-label="Verified"]');
  const gridPosts = Array.from(document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')).slice(0, 12).map(a => ({
    url: 'https://www.instagram.com' + a.getAttribute('href'),
    alt: a.querySelector('img')?.getAttribute('alt')?.substring(0, 100) || null,
    isReel: a.getAttribute('href').includes('/reel/'),
  }));
  const highlights = Array.from(document.querySelectorAll('a[href*="/stories/highlights/"]')).map(a => ({
    name: a.textContent?.trim() || null,
    url: 'https://www.instagram.com' + a.getAttribute('href'),
  }));
  return { username, displayName, bio, posts, followers, followerExact, following, isVerified, website, gridPosts, highlights };
})()
`;
export const browserExtractIgProfileSchema = {
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};
export const browserExtractIgProfileDescription = 'Extract Instagram profile data as structured JSON ' +
    '(username, displayName, bio, posts, followers, followerExact, following, isVerified, website, gridPosts, highlights). ' +
    'Navigate to instagram.com/username/ first. Returns bio, stats, post grid (up to 12), and story highlights.';
export async function handleBrowserExtractIgProfile(args) {
    const resolved = await ni.resolveSession(args.sessionId);
    if ('error' in resolved)
        return text(resolved.error);
    const result = await ni.evaluate(resolved.sessionId, IG_PROFILE_EXTRACTOR_SCRIPT);
    if (result.error)
        return text(`Extract failed: ${result.error}`);
    const profile = result.result;
    if (!profile || !profile.username) {
        return text('No profile data found. Navigate to instagram.com/username/ first, then retry.');
    }
    return text(`Profile:\n\n${JSON.stringify(profile, null, 2)}`);
}
// ── browser_extract_ig_post ──
const IG_POST_EXTRACTOR_SCRIPT = `
(() => {
  const main = document.querySelector('main');
  if (!main) return null;
  const authorLink = Array.from(main.querySelectorAll('a[role="link"]')).find(a => a.getAttribute('href')?.match(/^\\/[^/]+\\/$/));
  const author = authorLink?.textContent?.trim() || null;
  let caption = null;
  if (authorLink) {
    const container = authorLink.parentElement?.parentElement;
    if (container) {
      const spans = Array.from(container.querySelectorAll('span[dir="auto"]'));
      caption = spans.map(s => s.textContent?.trim()).filter(t => t && t !== author).join(' ')?.substring(0, 500) || null;
    }
  }
  const countSpans = Array.from(main.querySelectorAll('section span')).filter(s => s.children.length === 0 && /^[\\d.,]+\\s*(mil|M|K|B)?$/.test(s.textContent?.trim() || ''));
  const likes = countSpans.length >= 2 ? countSpans[countSpans.length - 2]?.textContent?.trim() : (countSpans[0]?.textContent?.trim() || null);
  const commentCount = countSpans.length >= 2 ? countSpans[countSpans.length - 1]?.textContent?.trim() : null;
  const timeEls = Array.from(main.querySelectorAll('time'));
  const postTime = timeEls.find(t => t.textContent?.trim()?.startsWith('há') || t.textContent?.trim()?.startsWith('ago') || /^\\d/.test(t.textContent?.trim() || ''));
  const time = postTime?.textContent?.trim() || timeEls[0]?.textContent?.trim() || null;
  const datetime = postTime?.getAttribute('datetime') || timeEls[0]?.getAttribute('datetime') || null;
  const commentLinks = Array.from(main.querySelectorAll('a[href*="/c/"]'));
  const comments = [];
  const seen = new Set();
  for (const link of commentLinks) {
    const commentUrl = link.getAttribute('href');
    if (seen.has(commentUrl)) continue;
    seen.add(commentUrl);
    const row = link.parentElement?.parentElement?.parentElement;
    if (!row) continue;
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    const texts = [];
    let node;
    while (node = walker.nextNode()) {
      const t = node.textContent?.trim();
      if (t) texts.push(t);
    }
    const cTime = row.querySelector('time');
    comments.push({
      username: texts[0] || null,
      text: texts.slice(2).join(' ')?.substring(0, 200) || texts[1] || null,
      time: cTime?.textContent?.trim() || null,
      datetime: cTime?.getAttribute('datetime') || null,
    });
  }
  return { author, caption, likes, commentCount, time, datetime, comments };
})()
`;
export const browserExtractIgPostSchema = {
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};
export const browserExtractIgPostDescription = 'Extract a single Instagram post with comments as structured JSON ' +
    '(author, caption, likes, commentCount, time, datetime, comments[{username, text, time, datetime}]). ' +
    'Navigate to instagram.com/p/POST_ID/ or instagram.com/reel/REEL_ID/ first. ' +
    'Scroll the comment area to load more comments before extracting.';
export async function handleBrowserExtractIgPost(args) {
    const resolved = await ni.resolveSession(args.sessionId);
    if ('error' in resolved)
        return text(resolved.error);
    const result = await ni.evaluate(resolved.sessionId, IG_POST_EXTRACTOR_SCRIPT);
    if (result.error)
        return text(`Extract failed: ${result.error}`);
    const post = result.result;
    if (!post || !post.author) {
        return text('No post data found. Navigate to instagram.com/p/POST_ID/ first, then retry.');
    }
    return text(`Post:\n\n${JSON.stringify(post, null, 2)}`);
}
// ── browser_extract_ig_reels ──
const IG_REELS_EXTRACTOR_SCRIPT = `
(() => {
  const main = document.querySelector('main');
  if (!main) return [];
  const likeSvgs = Array.from(main.querySelectorAll('svg[aria-label="Curtir"], svg[aria-label="Like"]'));
  const reels = [];
  const seen = new Set();
  for (const svg of likeSvgs) {
    let container = svg.closest('[role="button"]')?.parentElement;
    for (let i = 0; i < 5; i++) {
      if (!container) break;
      const hasComment = container.querySelector('svg[aria-label="Comentar"], svg[aria-label="Comment"]');
      const hasShare = container.querySelector('svg[aria-label="Compartilhar"], svg[aria-label="Share"]');
      if (hasComment && hasShare) break;
      container = container.parentElement;
    }
    if (!container || seen.has(container)) continue;
    seen.add(container);
    const userLink = container.querySelector('a[href^="/"]');
    const spans = Array.from(container.querySelectorAll('span')).filter(s => s.children.length === 0);
    const counts = spans.filter(s => /^[\\d.,]+\\s*(mil|M|K|B)?$/.test(s.textContent?.trim() || '')).map(s => s.textContent?.trim());
    const audioLink = container.querySelector('a[href*="/audio/"], a[href*="/music/"]');
    const captionSpans = spans.filter(s => s.getAttribute('dir') === 'auto' && (s.textContent?.trim().length || 0) > 10);
    const hasFollow = !!Array.from(container.querySelectorAll('*')).find(e => (e.textContent?.trim() === 'Seguir' || e.textContent?.trim() === 'Follow') && e.children.length === 0);
    reels.push({
      username: userLink?.textContent?.trim() || null,
      profileUrl: userLink ? 'https://www.instagram.com' + userLink.getAttribute('href') : null,
      caption: captionSpans[0]?.textContent?.trim()?.substring(0, 200) || null,
      likes: counts[0] || null,
      comments: counts[1] || null,
      audioName: audioLink?.textContent?.trim()?.substring(0, 80) || null,
      audioUrl: audioLink ? 'https://www.instagram.com' + audioLink.getAttribute('href') : null,
      hasFollow,
    });
  }
  return reels;
})()
`;
export const browserExtractIgReelsSchema = {
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};
export const browserExtractIgReelsDescription = 'Extract visible Instagram Reels with engagement data as structured JSON ' +
    '(username, profileUrl, caption, likes, comments, audioName, audioUrl, hasFollow). ' +
    'Navigate to instagram.com/reels/ first. Scroll down to load more reels.';
export async function handleBrowserExtractIgReels(args) {
    const resolved = await ni.resolveSession(args.sessionId);
    if ('error' in resolved)
        return text(resolved.error);
    const result = await ni.evaluate(resolved.sessionId, IG_REELS_EXTRACTOR_SCRIPT);
    if (result.error)
        return text(`Extract failed: ${result.error}`);
    const reels = result.result;
    if (!Array.isArray(reels) || reels.length === 0) {
        return text('No reels found. Navigate to instagram.com/reels/ and scroll down, then retry.');
    }
    return text(`${reels.length} reel(s):\n\n${JSON.stringify(reels, null, 2)}`);
}
// ── browser_extract_ig_search ──
const IG_SEARCH_EXTRACTOR_SCRIPT = `
Array.from(document.querySelectorAll('main a[href*="/p/"], main a[href*="/reel/"]')).map(a => ({
  url: 'https://www.instagram.com' + a.getAttribute('href'),
  alt: a.querySelector('img')?.getAttribute('alt')?.substring(0, 120) || null,
  isReel: a.getAttribute('href').includes('/reel/'),
})).filter(p => p.url)
`;
export const browserExtractIgSearchSchema = {
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};
export const browserExtractIgSearchDescription = 'Extract posts from the Instagram Explore page as structured JSON (url, alt, isReel). ' +
    'Navigate to instagram.com/explore/ first. Scroll to load more content. ' +
    'For hashtag search, navigate to instagram.com/explore/tags/HASHTAG/.';
export async function handleBrowserExtractIgSearch(args) {
    const resolved = await ni.resolveSession(args.sessionId);
    if ('error' in resolved)
        return text(resolved.error);
    const result = await ni.evaluate(resolved.sessionId, IG_SEARCH_EXTRACTOR_SCRIPT);
    if (result.error)
        return text(`Extract failed: ${result.error}`);
    const posts = result.result;
    if (!Array.isArray(posts) || posts.length === 0) {
        return text('No explore posts found. Navigate to instagram.com/explore/ and scroll down, then retry.');
    }
    return text(`${posts.length} post(s):\n\n${JSON.stringify(posts, null, 2)}`);
}
// ── LinkedIn Extraction Tools ──
// ── browser_extract_li_feed ──
const LI_FEED_EXTRACTOR_SCRIPT = `
Array.from(document.querySelectorAll('.feed-shared-update-v2[data-urn*="urn:li:activity"]')).map(post => {
  const actorLink = post.querySelector('.update-components-actor__meta-link') || post.querySelector('.update-components-actor__name a');
  const actorUrl = actorLink?.href?.split('?')[0] || null;
  const nameSpan = actorLink?.querySelector('.update-components-actor__title span[aria-hidden="true"]') || actorLink?.querySelector('span[aria-hidden="true"]');
  const actorName = nameSpan?.textContent?.trim() || null;
  const descSpan = post.querySelector('.update-components-actor__description span[aria-hidden="true"]');
  const headline = descSpan?.textContent?.trim() || null;
  const subDesc = post.querySelector('.update-components-actor__sub-description span[aria-hidden="true"]')?.textContent?.trim() || null;
  const timeMatch = subDesc?.match(/^(\\d+\\s*\\w+)/) || null;
  const time = timeMatch ? timeMatch[1] : (subDesc || null);
  const isPromoted = /Promovido|Promoted/i.test(subDesc || '');
  const textEl = post.querySelector('.feed-shared-update-v2__description, .update-components-text');
  const text = textEl?.innerText?.trim() || null;
  const reactionsBtn = post.querySelector('.social-details-social-counts__reactions-count');
  const reactions = reactionsBtn?.textContent?.trim() || null;
  const commentsEl = post.querySelector('.social-details-social-counts__comments');
  const commentsCount = commentsEl?.textContent?.trim()?.match(/\\d[\\d.,]*/)?.[0] || null;
  const hasImage = !!post.querySelector('.update-components-image img');
  const hasVideo = !!post.querySelector('video, .update-components-linkedin-video');
  const hasArticle = !!post.querySelector('.update-components-article');
  const hasDocument = !!post.querySelector('.update-components-linkedin-document');
  const mediaType = hasVideo ? 'video' : hasDocument ? 'document' : hasArticle ? 'article' : hasImage ? 'image' : 'text';
  const articleTitle = post.querySelector('.update-components-article__title')?.textContent?.trim() || null;
  const articleLink = post.querySelector('.update-components-article a')?.href?.split('?')[0] || null;
  const reshareActor = post.querySelector('.update-components-mini-update-v2');
  const isRepost = !!reshareActor;
  const postUrn = post.getAttribute('data-urn');
  const postUrl = postUrn ? 'https://www.linkedin.com/feed/update/' + postUrn + '/' : null;
  return { author: actorName, authorUrl: actorUrl, headline, time, text, reactions, commentsCount, mediaType, articleTitle, articleLink, isPromoted, isRepost, postUrl };
}).filter(p => p.author || p.text)
`.trim();
export const browserExtractLiFeedSchema = {
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};
export const browserExtractLiFeedDescription = 'Extract all currently visible LinkedIn feed posts as structured JSON ' +
    '(author, authorUrl, headline, time, text, reactions, commentsCount, mediaType, articleTitle, articleLink, isPromoted, isRepost, postUrl). ' +
    'Navigate to linkedin.com/feed/ first. Scroll down with browser_scroll to load more posts. ' +
    'Much faster than browser_snapshot for data harvesting from the LinkedIn feed.';
export async function handleBrowserExtractLiFeed(args) {
    const resolved = await ni.resolveSession(args.sessionId);
    if ('error' in resolved)
        return text(resolved.error);
    const result = await ni.evaluate(resolved.sessionId, LI_FEED_EXTRACTOR_SCRIPT);
    if (result.error)
        return text(`Extract failed: ${result.error}`);
    const posts = result.result;
    if (!Array.isArray(posts) || posts.length === 0) {
        return text('No LinkedIn feed posts found. Navigate to linkedin.com/feed/ and scroll down, then retry.');
    }
    return text(`${posts.length} post(s):\n\n${JSON.stringify(posts, null, 2)}`);
}
// ── browser_extract_li_profile ──
const LI_PROFILE_EXTRACTOR_SCRIPT = `
(() => {
  const name = document.querySelector('.text-heading-xlarge, h1')?.textContent?.trim() || null;
  const headline = document.querySelector('.text-body-medium.break-words')?.textContent?.trim() || null;
  const location = document.querySelector('.text-body-small.inline.t-black--light.break-words')?.textContent?.trim() || null;
  const profilePic = document.querySelector('.pv-top-card-profile-picture__image, img.profile-photo-edit__preview')?.src || null;
  const connectionsEl = Array.from(document.querySelectorAll('span')).find(s => /conexõ|connection/i.test(s.textContent || ''));
  const connections = connectionsEl?.textContent?.trim() || null;
  const aboutSection = document.querySelector('.pv-about-section .inline-show-more-text, section .pv-shared-text-with-see-more span[aria-hidden="true"]');
  const about = aboutSection?.textContent?.trim() || null;
  const sections = Array.from(document.querySelectorAll('section.artdeco-card')).map(s => {
    const heading = (s.querySelector('.pvs-header__title span[aria-hidden="true"]') || s.querySelector('h2 span[aria-hidden="true"]') || s.querySelector('h2'))?.textContent?.trim()?.replace(/\\s+/g, ' ');
    if (!heading) return null;
    const items = Array.from(s.querySelectorAll('li.artdeco-list__item, li.pvs-list__paged-list-item')).map(li => {
      const title = li.querySelector('.t-bold span[aria-hidden="true"], .mr1.t-bold span')?.textContent?.trim();
      const subtitle = li.querySelector('.t-normal span[aria-hidden="true"], .t-14.t-normal span')?.textContent?.trim();
      const meta = li.querySelector('.pvs-entity__caption-wrapper span[aria-hidden="true"]')?.textContent?.trim();
      return { title: title || null, subtitle: subtitle || null, meta: meta || null };
    }).filter(i => i.title);
    return { heading, items };
  }).filter(Boolean);
  const activityPosts = Array.from(document.querySelectorAll('.pv-recent-activity-section li, section .feed-shared-update-v2')).slice(0, 5).map(p => ({
    text: p.querySelector('.feed-shared-update-v2__description, .update-components-text')?.innerText?.trim()?.substring(0, 200) || p.innerText?.trim()?.substring(0, 200),
  }));
  return { name, headline, location, profilePic, connections, about, sections, recentActivity: activityPosts };
})()
`.trim();
export const browserExtractLiProfileSchema = {
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};
export const browserExtractLiProfileDescription = 'Extract LinkedIn profile data as structured JSON ' +
    '(name, headline, location, profilePic, connections, about, sections[{heading, items[{title, subtitle, meta}]}], recentActivity). ' +
    'Navigate to linkedin.com/in/USERNAME/ first. Sections include Experience, Education, Skills, etc. ' +
    'Use linkedin.com/in/me/ for the logged-in user\'s own profile.';
export async function handleBrowserExtractLiProfile(args) {
    const resolved = await ni.resolveSession(args.sessionId);
    if ('error' in resolved)
        return text(resolved.error);
    const result = await ni.evaluate(resolved.sessionId, LI_PROFILE_EXTRACTOR_SCRIPT);
    if (result.error)
        return text(`Extract failed: ${result.error}`);
    const profile = result.result;
    if (!profile || !profile.name) {
        return text('No profile data found. Navigate to linkedin.com/in/USERNAME/ first, then retry.');
    }
    return text(`Profile:\n\n${JSON.stringify(profile, null, 2)}`);
}
// ── browser_extract_li_post ──
const LI_POST_EXTRACTOR_SCRIPT = `
(() => {
  const post = document.querySelector('.feed-shared-update-v2[data-urn]');
  if (!post) return null;
  const actorLink = post.querySelector('.update-components-actor__meta-link') || post.querySelector('.update-components-actor__name a');
  const nameSpan = actorLink?.querySelector('.update-components-actor__title span[aria-hidden="true"]') || actorLink?.querySelector('span[aria-hidden="true"]');
  const author = nameSpan?.textContent?.trim() || null;
  const authorUrl = actorLink?.href?.split('?')[0] || null;
  const headline = post.querySelector('.update-components-actor__description span[aria-hidden="true"]')?.textContent?.trim() || null;
  const subDesc = post.querySelector('.update-components-actor__sub-description span[aria-hidden="true"]')?.textContent?.trim() || null;
  const text = post.querySelector('.feed-shared-update-v2__description, .update-components-text')?.innerText?.trim() || null;
  const reactions = post.querySelector('.social-details-social-counts__reactions-count')?.textContent?.trim() || null;
  const commentsCountEl = post.querySelector('.social-details-social-counts__comments');
  const commentsCount = commentsCountEl?.textContent?.trim()?.match(/\\d[\\d.,]*/)?.[0] || null;
  const postUrn = post.getAttribute('data-urn');
  const comments = Array.from(document.querySelectorAll('.comments-comment-item, article.comments-comment-entity')).map(c => {
    const cAuthorLink = c.querySelector('a[href*="/in/"]');
    const cName = c.querySelector('.comments-post-meta__name-text span[aria-hidden="true"]')?.textContent?.trim() ||
                  cAuthorLink?.textContent?.trim()?.replace(/\\s+/g, ' ') || null;
    const cUrl = cAuthorLink?.href?.split('?')[0] || null;
    const cText = c.querySelector('.comments-comment-item__main-content, .comments-comment-item-content-body, .feed-shared-inline-show-more-text')?.innerText?.trim() || null;
    const cTime = c.querySelector('time')?.textContent?.trim() || c.querySelector('.comments-comment-item__timestamp')?.textContent?.trim() || null;
    const cLikes = c.querySelector('.comments-comment-social-bar__reactions-count, .social-details-social-counts__reactions-count')?.textContent?.trim() || null;
    return { author: cName, authorUrl: cUrl, text: cText, time: cTime, likes: cLikes };
  }).filter(c => c.text);
  return { author, authorUrl, headline, time: subDesc, text, reactions, commentsCount, postUrn, comments };
})()
`.trim();
export const browserExtractLiPostSchema = {
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};
export const browserExtractLiPostDescription = 'Extract a single LinkedIn post with comments as structured JSON ' +
    '(author, authorUrl, headline, time, text, reactions, commentsCount, postUrn, comments[{author, authorUrl, text, time, likes}]). ' +
    'Navigate to linkedin.com/feed/update/urn:li:activity:ID/ first. ' +
    'Click "Comentar" button to expand comment section, then scroll to load more comments before extracting.';
export async function handleBrowserExtractLiPost(args) {
    const resolved = await ni.resolveSession(args.sessionId);
    if ('error' in resolved)
        return text(resolved.error);
    const result = await ni.evaluate(resolved.sessionId, LI_POST_EXTRACTOR_SCRIPT);
    if (result.error)
        return text(`Extract failed: ${result.error}`);
    const post = result.result;
    if (!post || !post.author) {
        return text('No post data found. Navigate to linkedin.com/feed/update/urn:li:activity:ID/ first, then retry.');
    }
    return text(`Post:\n\n${JSON.stringify(post, null, 2)}`);
}
// ── browser_extract_li_notifications ──
const LI_NOTIFICATIONS_EXTRACTOR_SCRIPT = `
Array.from(document.querySelectorAll('article.nt-card')).map(card => {
  const isUnread = card.classList.contains('nt-card--unread');
  const link = card.querySelector('a[href*="linkedin.com"]');
  const url = link?.href?.split('&or')[0] || link?.href || null;
  const allText = card.innerText?.trim()?.replace(/\\s+/g, ' ') || null;
  const cleanText = allText?.replace(/^(Notificação não lida\\.\\s*|O status está off-line\\s*)/, '')?.replace(/\\s*há\\s*\\d+.*$/, '')?.trim() || allText;
  const timeEl = Array.from(card.querySelectorAll('span, p')).find(s => /^\\d+\\s*(min|h|d|sem|s|m|dia|hour|day|week|month|mo)/i.test(s.textContent?.trim() || ''));
  const time = timeEl?.textContent?.trim() || null;
  const img = card.querySelector('img')?.src || null;
  return { text: cleanText?.substring(0, 300), time, isUnread, url, image: img };
}).filter(n => n.text && !n.text.includes('funciona melhor no novo aplicativo'))
`.trim();
export const browserExtractLiNotificationsSchema = {
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};
export const browserExtractLiNotificationsDescription = 'Extract LinkedIn notifications as structured JSON (text, time, isUnread, url, image). ' +
    'Navigate to linkedin.com/notifications/ first. Scroll down to load older notifications. ' +
    'Useful for monitoring engagement, connection requests, and mentions.';
export async function handleBrowserExtractLiNotifications(args) {
    const resolved = await ni.resolveSession(args.sessionId);
    if ('error' in resolved)
        return text(resolved.error);
    const result = await ni.evaluate(resolved.sessionId, LI_NOTIFICATIONS_EXTRACTOR_SCRIPT);
    if (result.error)
        return text(`Extract failed: ${result.error}`);
    const notifs = result.result;
    if (!Array.isArray(notifs) || notifs.length === 0) {
        return text('No notifications found. Navigate to linkedin.com/notifications/ first, then retry.');
    }
    return text(`${notifs.length} notification(s):\n\n${JSON.stringify(notifs, null, 2)}`);
}
// ── browser_extract_li_messages ──
const LI_MESSAGES_EXTRACTOR_SCRIPT = `
(() => {
  const results = { conversations: [], activeThread: [] };
  results.conversations = Array.from(document.querySelectorAll('.msg-conversation-listitem')).map(c => {
    const name = c.querySelector('.msg-conversation-listitem__participant-names, .msg-conversation-card__participant-names')?.textContent?.trim() || null;
    const snippet = c.querySelector('.msg-conversation-listitem__message-snippet, .msg-conversation-card__message-snippet')?.textContent?.trim()?.substring(0, 150) || null;
    const time = c.querySelector('.msg-conversation-listitem__time-stamp, .msg-conversation-card__time-stamp, time')?.textContent?.trim() || null;
    const isUnread = c.classList.contains('msg-conversation-listitem--unread');
    const link = c.querySelector('a')?.href || null;
    return { name, lastMessage: snippet, time, isUnread, url: link };
  }).filter(c => c.name);
  results.activeThread = Array.from(document.querySelectorAll('.msg-s-message-list__event, .msg-s-event-listitem')).map(m => {
    const sender = m.querySelector('.msg-s-message-group__name, .msg-s-event-listitem__link')?.textContent?.trim() || null;
    const text = m.querySelector('.msg-s-event-listitem__body, .msg-s-event-listitem__message-bubble')?.textContent?.trim()?.substring(0, 500) || null;
    const time = m.querySelector('.msg-s-message-group__timestamp, time')?.textContent?.trim() || null;
    const isIncoming = !m.classList.contains('msg-s-message-list__event--outgoing');
    return { sender, text, time, direction: isIncoming ? 'in' : 'out' };
  }).filter(m => m.text);
  return results;
})()
`.trim();
export const browserExtractLiMessagesSchema = {
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};
export const browserExtractLiMessagesDescription = 'Extract LinkedIn messaging data as structured JSON with two arrays: ' +
    'conversations[{name, lastMessage, time, isUnread, url}] (sidebar list) and ' +
    'activeThread[{sender, text, time, direction}] (open conversation messages). ' +
    'Navigate to linkedin.com/messaging/ first. Click a conversation to load its messages. ' +
    'To send a message: browser_fill on .msg-form__contenteditable then browser_click on .msg-form__send-button.';
export async function handleBrowserExtractLiMessages(args) {
    const resolved = await ni.resolveSession(args.sessionId);
    if ('error' in resolved)
        return text(resolved.error);
    const result = await ni.evaluate(resolved.sessionId, LI_MESSAGES_EXTRACTOR_SCRIPT);
    if (result.error)
        return text(`Extract failed: ${result.error}`);
    const data = result.result;
    const convos = data?.conversations || [];
    const msgs = data?.activeThread || [];
    if (convos.length === 0 && msgs.length === 0) {
        return text('No messages found. Navigate to linkedin.com/messaging/ first, then retry.');
    }
    return text(`${convos.length} conversation(s), ${msgs.length} message(s) in active thread:\n\n${JSON.stringify(data, null, 2)}`);
}
// ── browser_extract_li_search_people ──
const LI_SEARCH_PEOPLE_EXTRACTOR_SCRIPT = `
(() => {
  const main = document.querySelector('main') || document.body;
  const profileLinks = Array.from(main.querySelectorAll('a[href*="/in/"]')).filter(a => {
    const href = a.getAttribute('href') || '';
    return href.match(/\\/in\\/[^/]+\\/?$/) && !href.includes('/search/') && a.textContent?.trim()?.length > 2;
  });
  const seen = new Set();
  return profileLinks.map(a => {
    const href = a.href?.split('?')[0];
    if (seen.has(href)) return null;
    seen.add(href);
    const card = a.parentElement;
    if (!card) return null;
    const pEls = Array.from(card.querySelectorAll('p'));
    const nameText = a.textContent?.trim()?.replace(/\\s+/g, ' ')?.replace(/\\s*•.*/, '') || null;
    const headline = pEls[1]?.textContent?.trim() || null;
    const location = pEls[2]?.textContent?.trim() || null;
    const currentRole = pEls.find(p => /^(Atual|Current)/i.test(p.textContent?.trim() || ''))?.textContent?.trim() || null;
    const followers = pEls.find(p => /seguidores|followers/i.test(p.textContent?.trim() || ''))?.textContent?.trim() || null;
    const mutual = pEls.find(p => /em comum|mutual/i.test(p.textContent?.trim() || ''))?.textContent?.trim() || null;
    const connectBtn = card.querySelector('button');
    const btnText = connectBtn?.textContent?.trim();
    const img = card.querySelector('img')?.src || null;
    return {
      name: nameText?.substring(0, 80),
      profileUrl: href,
      headline: headline?.substring(0, 200) || null,
      location: location?.substring(0, 80) || null,
      currentRole: currentRole?.substring(0, 150) || null,
      followers: followers?.substring(0, 40) || null,
      mutual: mutual?.substring(0, 80) || null,
      actionButton: (btnText && btnText.length < 30) ? btnText : null,
      image: img,
    };
  }).filter(Boolean);
})()
`.trim();
export const browserExtractLiSearchPeopleSchema = {
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};
export const browserExtractLiSearchPeopleDescription = 'Extract LinkedIn people search results as structured JSON ' +
    '(name, profileUrl, headline, location, mutual, actionButton, image). ' +
    'Navigate to linkedin.com/search/results/people/?keywords=QUERY first. ' +
    'Scroll down to load more results. Also works on linkedin.com/search/results/all/.';
export async function handleBrowserExtractLiSearchPeople(args) {
    const resolved = await ni.resolveSession(args.sessionId);
    if ('error' in resolved)
        return text(resolved.error);
    const result = await ni.evaluate(resolved.sessionId, LI_SEARCH_PEOPLE_EXTRACTOR_SCRIPT);
    if (result.error)
        return text(`Extract failed: ${result.error}`);
    const people = result.result;
    if (!Array.isArray(people) || people.length === 0) {
        return text('No search results found. Navigate to linkedin.com/search/results/people/?keywords=QUERY first, then retry.');
    }
    return text(`${people.length} result(s):\n\n${JSON.stringify(people, null, 2)}`);
}
// ── browser_extract_li_network ──
const LI_NETWORK_EXTRACTOR_SCRIPT = `
(() => {
  const results = { invitations: [], suggestions: [] };
  const invCards = document.querySelectorAll('.invitation-card, [data-view-name="invitation-card"]');
  results.invitations = Array.from(invCards).map(inv => {
    const name = inv.querySelector('.invitation-card__name, span[aria-hidden="true"]')?.textContent?.trim() || null;
    const subtitle = inv.querySelector('.invitation-card__subtitle, .invitation-card__occupation')?.textContent?.trim() || null;
    const acceptBtn = inv.querySelector('button[aria-label*="Aceitar"], button[aria-label*="Accept"]');
    const ignoreBtn = inv.querySelector('button[aria-label*="Ignorar"], button[aria-label*="Ignore"]');
    const profileLink = inv.querySelector('a[href*="/in/"]')?.href?.split('?')[0] || null;
    return { name, subtitle, profileUrl: profileLink, acceptLabel: acceptBtn?.getAttribute('aria-label') || null, ignoreLabel: ignoreBtn?.getAttribute('aria-label') || null };
  }).filter(i => i.name);
  const followBtns = Array.from(document.querySelectorAll('main button')).filter(b => {
    const t = b.textContent?.trim();
    return t === 'Seguir' || t === '+ Seguir' || t === 'Follow' || t === '+ Follow' || t === 'Conectar' || t === 'Connect';
  });
  const seen = new Set();
  results.suggestions = followBtns.map(btn => {
    let card = btn.parentElement;
    for (let i = 0; i < 8; i++) {
      if (!card) break;
      if (card.querySelector('img') && card.querySelector('a[href*="/in/"]')) break;
      card = card.parentElement;
    }
    if (!card) return null;
    const profileLink = card.querySelector('a[href*="/in/"]');
    const url = profileLink?.href?.split('?')[0];
    if (!url || seen.has(url)) return null;
    seen.add(url);
    const allText = card.innerText?.trim()?.split('\\n').filter(t => t.trim().length > 1) || [];
    const name = allText[0]?.trim() || null;
    const nameClean = name?.replace(/[,\\s]*(Top Voice|Premium|Verificado|Verified).*$/i, '')?.trim();
    const subtitle = allText.find(t => {
      const clean = t.trim();
      return clean !== name && clean !== nameClean && !clean.includes('Seguir') && !clean.includes('Follow') && !clean.includes('Conectar') && !clean.includes('Connect') && !/^\\d/.test(clean) && clean.length > 5;
    })?.trim() || null;
    const followersText = allText.find(t => /seguidores|followers/i.test(t))?.trim() || null;
    const img = card.querySelector('img')?.src || null;
    return { name, subtitle, followers: followersText, profileUrl: url, action: btn.textContent?.trim(), image: img };
  }).filter(Boolean);
  return results;
})()
`.trim();
export const browserExtractLiNetworkSchema = {
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};
export const browserExtractLiNetworkDescription = 'Extract LinkedIn My Network data as structured JSON with two arrays: ' +
    'invitations[{name, subtitle, profileUrl, acceptLabel, ignoreLabel}] (pending connection requests) and ' +
    'suggestions[{name, subtitle, followers, profileUrl, action, image}] (people/creators to follow or connect). ' +
    'Navigate to linkedin.com/mynetwork/ first. Scroll down to load more suggestions. ' +
    'To accept an invitation: browser_click on button with the acceptLabel. ' +
    'To connect: browser_click on the respective Conectar/Connect button.';
export async function handleBrowserExtractLiNetwork(args) {
    const resolved = await ni.resolveSession(args.sessionId);
    if ('error' in resolved)
        return text(resolved.error);
    const result = await ni.evaluate(resolved.sessionId, LI_NETWORK_EXTRACTOR_SCRIPT);
    if (result.error)
        return text(`Extract failed: ${result.error}`);
    const data = result.result;
    const invitations = data?.invitations || [];
    const suggestions = data?.suggestions || [];
    if (invitations.length === 0 && suggestions.length === 0) {
        return text('No network data found. Navigate to linkedin.com/mynetwork/ first, then retry.');
    }
    return text(`${invitations.length} invitation(s), ${suggestions.length} suggestion(s):\n\n${JSON.stringify(data, null, 2)}`);
}
//# sourceMappingURL=browser-observe.js.map