/**
 * BlueSky (AT Protocol) tool group — native SynaBun tools to control bsky.app.
 *
 * Unlike the DOM-scraping social extractors in browser-observe.ts, these tools
 * call BlueSky's XRPC JSON API directly from inside the logged-in bsky.app page
 * via ni.evaluate(). The page already holds a valid access token (read from
 * localStorage['BSKY_STORAGE']); every script reuses it to fetch the account's
 * PDS host (pdsUrl), which is NOT bsky.social — Bluesky shards users across
 * *.host.bsky.network PDS hosts, and the token's audience is pinned to that PDS.
 * App View reads (app.bsky.*) and the chat service (chat.bsky.*) are reached by
 * the PDS's built-in proxy (chat needs an explicit atproto-proxy header).
 *
 * Requirement: a browser context logged in to bsky.app — localStorage is
 * per-origin, so a blank assigned tab is initialized at bsky.app before the
 * session token is read. Nonblank tabs are never navigated implicitly.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as ni from '../services/neural-interface.js';
import { text } from './response.js';

// ─────────────────────────────────────────────────────────────────────────
// In-page JS helpers — prepended to every tool script. Plain ES5-ish JS with
// single quotes + string concat ONLY (these live inside TS template literals,
// so no backticks/template-literals are allowed in this block).
// ─────────────────────────────────────────────────────────────────────────

const BSKY_SESSION_JS = `
function __bskySession(){
  function tryParse(s){ try { return JSON.parse(s); } catch(e){ return null; } }
  var keys = ['BSKY_STORAGE','root','persisted-root','persisted:root','agent'];
  var acct = null;
  for (var i=0;i<keys.length;i++){
    var raw;
    try { raw = localStorage.getItem(keys[i]); }
    catch(e){
      return { __bskyError: 'BlueSky session storage is inaccessible on this page: ' + (e && e.message || e) + '. Use a top-level https://bsky.app tab in the same browser context.' };
    }
    if(!raw) continue;
    var j = tryParse(raw);
    if(!j) continue;
    var sess = j.session || j;
    var cand = sess.currentAccount
      || (Array.isArray(sess.accounts) && (sess.accounts.filter(function(a){return a && a.active && a.accessJwt;})[0] || sess.accounts.filter(function(a){return a && a.accessJwt;})[0]))
      || sess.currentSession
      || (sess.accessJwt ? sess : null);
    if (cand && cand.accessJwt && cand.did){ acct = cand; break; }
  }
  if(!acct) return { __bskyError: 'Not logged in to BlueSky (no session token found on this page). Open a bsky.app tab, sign in, then retry.' };
  var pdsUrl = String(acct.pdsUrl || acct.service || 'https://bsky.social').replace(/[/]+$/, '');
  return { accessJwt: acct.accessJwt, did: acct.did, handle: acct.handle || null, pdsUrl: pdsUrl };
}
`;

const BSKY_XRPC_JS = `
async function __bskyXrpc(method, opts){
  opts = opts || {};
  var verb = opts.verb || 'GET';
  var s = __bskySession();
  if (s.__bskyError) return s;
  var url = s.pdsUrl + '/xrpc/' + method;
  var headers = { 'Authorization': 'Bearer ' + s.accessJwt };
  if (opts.proxy) headers['atproto-proxy'] = opts.proxy;
  if (verb === 'GET' && opts.params){
    var qs = new URLSearchParams();
    var p = opts.params;
    for (var k in p){
      if (!Object.prototype.hasOwnProperty.call(p,k)) continue;
      var v = p[k];
      if (v === null || v === undefined || v === '') continue;
      if (Array.isArray(v)){ for (var n=0;n<v.length;n++) qs.append(k, String(v[n])); }
      else qs.append(k, String(v));
    }
    var qstr = qs.toString();
    if (qstr) url += '?' + qstr;
  }
  var init = { method: verb, headers: headers };
  if (verb === 'POST'){
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body || {});
  }
  var res;
  try { res = await fetch(url, init); }
  catch(e){ return { __bskyError: 'Network error calling ' + method + ': ' + (e && e.message || e) }; }
  var data = null;
  try { data = await res.json(); } catch(e){}
  if (!res.ok){
    var errName = data && data.error;
    if (res.status === 401 || errName === 'ExpiredToken')
      return { __bskyExpired: true, __bskyError: 'BlueSky token expired. Reload the bsky.app tab (browser_reload) to refresh the session, then retry.' };
    if (res.status === 429){
      var reset = null; try { reset = res.headers.get('ratelimit-reset'); } catch(e){}
      return { __bskyError: 'BlueSky rate limit hit on ' + method + (reset ? ' (resets at epoch ' + reset + ')' : '') + '. Back off and retry later.' };
    }
    return { __bskyError: 'XRPC ' + method + ' failed (' + res.status + '): ' + (errName || '') + ' ' + ((data && data.message) || '') };
  }
  return data == null ? {} : data;
}
`;

const BSKY_NORMURI_JS = `
async function __bskyNormUri(input){
  if (!input) return input;
  if (String(input).indexOf('at://') === 0) return input;
  var m = String(input).match(/[/]profile[/]([^/]+)[/]post[/]([^/?#]+)/);
  if (!m) return input;
  var actor = decodeURIComponent(m[1]); var rkey = m[2]; var did = actor;
  if (actor.indexOf('did:') !== 0){
    var r = await __bskyXrpc('com.atproto.identity.resolveHandle', { params:{ handle: actor } });
    if (r.__bskyError || !r.did) return null;
    did = r.did;
  }
  return 'at://' + did + '/app.bsky.feed.post/' + rkey;
}
async function __bskyResolveActor(input){
  if (!input) return null;
  if (String(input).indexOf('did:') === 0) return input;
  var r = await __bskyXrpc('com.atproto.identity.resolveHandle', { params:{ handle: input } });
  if (r.__bskyError || !r.did) return null;
  return r.did;
}
`;

const BSKY_UPLOAD_JS = `
async function __bskyUploadBlobFromUrl(imgUrl){
  var s = __bskySession();
  if (s.__bskyError) return s;
  var imgRes;
  try { imgRes = await fetch(imgUrl); } catch(e){ return { __bskyError: 'Failed to fetch image URL: ' + (e && e.message || e) }; }
  if (!imgRes.ok) return { __bskyError: 'Image URL returned ' + imgRes.status };
  var ct = imgRes.headers.get('content-type') || 'image/jpeg';
  var buf = await imgRes.arrayBuffer();
  var up;
  try { up = await fetch(s.pdsUrl + '/xrpc/com.atproto.repo.uploadBlob', { method:'POST', headers:{ 'Authorization':'Bearer '+s.accessJwt, 'Content-Type': ct }, body: buf }); }
  catch(e){ return { __bskyError: 'uploadBlob network error: ' + (e && e.message || e) }; }
  var d = null; try { d = await up.json(); } catch(e){}
  if (!up.ok) return { __bskyError: 'uploadBlob failed (' + up.status + '): ' + (d && d.error || '') };
  return (d && d.blob) ? { blob: d.blob } : { __bskyError: 'uploadBlob returned no blob' };
}
`;

const BSKY_PAGINATE_JS = `
async function __bskyPaginate(method, params, itemsKey, maxItems, proxy){
  var out = [];
  var cursor = (params && params.cursor) || undefined;
  var cap = maxItems || (params && params.limit) || 50;
  var t0 = Date.now();
  while (true){
    var pp = Object.assign({}, params, { cursor: cursor });
    var r = await __bskyXrpc(method, { params: pp, proxy: proxy });
    if (r.__bskyError){ if (!out.length) return r; var o = {}; o[itemsKey] = out; o.cursor = cursor; o.partial = r.__bskyError; return o; }
    var batch = r[itemsKey] || [];
    for (var i=0;i<batch.length;i++) out.push(batch[i]);
    cursor = r.cursor;
    if (!maxItems) break;
    if (out.length >= cap) break;
    if (!cursor || batch.length === 0) break;
    if (Date.now() - t0 > 25000) break;
  }
  var res = {}; res[itemsKey] = out.slice(0, cap); res.cursor = cursor; return res;
}
`;

const HELPERS = [BSKY_SESSION_JS, BSKY_XRPC_JS, BSKY_NORMURI_JS, BSKY_UPLOAD_JS, BSKY_PAGINATE_JS].join('\n');

// ─────────────────────────────────────────────────────────────────────────
// TS-side helpers
// ─────────────────────────────────────────────────────────────────────────

interface SessionArgs { sessionId?: string; tabId?: string }
interface CursorArgs extends SessionArgs { limit?: number; cursor?: string; maxItems?: number }
type BskyResult = { data: any } | { error: string };

const BSKY_APP_URL = 'https://bsky.app/';
const BSKY_TARGET_PROBE_JS = `(() => {
  var href = ''; var origin = ''; var title = ''; var topLevel = false;
  try { href = String(window.location.href || ''); } catch(e){}
  try { origin = String(window.location.origin || ''); } catch(e){}
  try { title = String(document.title || ''); } catch(e){}
  try { topLevel = window.top === window.self; } catch(e){}
  return { href: href, origin: origin, title: title, topLevel: topLevel };
})()`;

interface BskyPageTarget {
  href: string;
  origin: string;
  title: string;
  topLevel: boolean;
}

function isBlueskyTarget(target: BskyPageTarget): boolean {
  if (!target.topLevel) return false;
  try {
    const url = new URL(target.href);
    return url.protocol === 'https:' && url.hostname === 'bsky.app';
  } catch {
    return false;
  }
}

function isSafeBlankTarget(target: BskyPageTarget): boolean {
  const href = String(target.href || '').trim().toLowerCase();
  return href === '' || /^about:blank(?:[?#].*)?$/.test(href);
}

async function inspectBlueskyTarget(sessionId: string, tabId?: string): Promise<BskyPageTarget | { error: string }> {
  const inspected = await ni.evaluate(sessionId, BSKY_TARGET_PROBE_JS, tabId);
  if (inspected.error) return { error: `Could not inspect the assigned BlueSky tab: ${inspected.error}` };
  const target = inspected.result as Partial<BskyPageTarget> | null;
  if (!target || typeof target.href !== 'string') {
    return { error: 'Could not inspect the assigned BlueSky tab: invalid page context response.' };
  }
  return {
    href: target.href,
    origin: typeof target.origin === 'string' ? target.origin : '',
    title: typeof target.title === 'string' ? target.title : '',
    topLevel: target.topLevel === true,
  };
}

/**
 * BlueSky tools require origin-scoped localStorage from a top-level bsky.app
 * document. Scheduled/owned tabs intentionally start at about:blank; it is safe
 * to initialize only that blank tab. Never navigate a nonblank page implicitly,
 * because it may be a user or another automation's tab selected by a stale ID.
 */
export async function ensureBlueskyPageTarget(
  sessionId: string,
  tabId?: string,
): Promise<{ ok: true; target: BskyPageTarget } | { error: string }> {
  const inspected = await inspectBlueskyTarget(sessionId, tabId);
  if ('error' in inspected) return inspected;
  if (isBlueskyTarget(inspected)) return { ok: true, target: inspected };

  const pageLabel = inspected.href || '(empty URL)';
  if (!inspected.topLevel) {
    return { error: `BlueSky requires a top-level https://bsky.app tab; the assigned target is an iframe (${pageLabel}).` };
  }
  if (!isSafeBlankTarget(inspected)) {
    return {
      error: `The assigned browser tab is ${pageLabel}, not https://bsky.app. Refusing to navigate a nonblank tab automatically; pass the correct tabId or navigate the schedule-owned tab first.`,
    };
  }

  const navigated = await ni.navigate(sessionId, BSKY_APP_URL, tabId, undefined, 'none');
  if (navigated.error) {
    return { error: `Could not initialize the blank BlueSky tab at ${BSKY_APP_URL}: ${navigated.error}` };
  }

  const verified = await inspectBlueskyTarget(sessionId, tabId);
  if ('error' in verified) return verified;
  if (!isBlueskyTarget(verified)) {
    return { error: `BlueSky tab initialization ended at ${verified.href || '(empty URL)'} instead of ${BSKY_APP_URL}.` };
  }
  return { ok: true, target: verified };
}

// JSON literal safe to embed inside JS source (escape the two line separators
// that are valid in JSON strings but terminate a JS line).
function jsLit(v: unknown): string {
  return JSON.stringify(v === undefined ? null : v)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function clampLimit(n?: number, def = 50, max = 100): number {
  if (!n || n < 1) return def;
  return Math.min(n, max);
}

async function evalBsky(sessionId: string, tabId: string | undefined, body: string): Promise<BskyResult> {
  // The Neural Interface runs this via page.evaluate(string), which compiles the
  // whole string as ONE expression — so the helper function declarations must
  // live INSIDE the IIFE, not before it (a leading `function ...` is not an
  // expression and throws "Unexpected token").
  const script = `(async () => {\n${HELPERS}\n${body}\n})()`;
  const res = await ni.evaluate(sessionId, script, tabId);
  if (res.error) return { error: `BlueSky call failed: ${res.error}` };
  const r = res.result as any;
  if (r && r.__bskyError) return { error: r.__bskyError };
  return { data: r };
}

async function runBsky(args: SessionArgs, body: string): Promise<BskyResult> {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return { error: resolved.error };
  const ready = await ensureBlueskyPageTarget(resolved.sessionId, resolved.tabId);
  if ('error' in ready) return ready;
  return evalBsky(resolved.sessionId, resolved.tabId, body);
}

// ── Trimmers: shrink verbose AT Proto views to the useful, token-cheap fields ──

function trimActor(a: any): any {
  if (!a) return a;
  const out: any = { did: a.did, handle: a.handle };
  if (a.displayName) out.name = a.displayName;
  if (a.description) out.bio = a.description;
  if (a.followersCount != null) { out.followers = a.followersCount; out.follows = a.followsCount; out.posts = a.postsCount; }
  if (a.viewer) out.viewer = { following: !!a.viewer.following, followedBy: !!a.viewer.followedBy, muted: !!a.viewer.muted, blocking: !!a.viewer.blocking };
  return out;
}

function trimPost(v: any): any {
  if (!v) return v;
  const p = v.post || v;
  const tp = p && p.$type;
  if (tp && String(tp).indexOf('blocked') >= 0) return { uri: p.uri, blocked: true };
  if (tp && String(tp).indexOf('notFound') >= 0) return { uri: p.uri, notFound: true };
  const rec = p.record || {};
  const out: any = {
    uri: p.uri,
    cid: p.cid,
    text: rec.text != null ? rec.text : null,
    counts: { replies: p.replyCount || 0, reposts: p.repostCount || 0, likes: p.likeCount || 0, quotes: p.quoteCount || 0 },
  };
  if (p.author) out.author = { handle: p.author.handle, name: p.author.displayName || undefined, did: p.author.did };
  if (rec.createdAt) out.createdAt = rec.createdAt;
  if (rec.reply) out.isReply = true;
  if (p.embed && p.embed.$type) out.embed = String(p.embed.$type).split('#')[0].replace('app.bsky.embed.', '');
  if (p.viewer) out.viewer = { liked: !!p.viewer.like, reposted: !!p.viewer.repost };
  if (v.reason && v.reason.$type && String(v.reason.$type).indexOf('Repost') >= 0) out.repostedBy = (v.reason.by && v.reason.by.handle) || true;
  return out;
}

function trimThread(thread: any, maxReplies = 50): any {
  if (!thread) return null;
  const tp = thread.$type ? String(thread.$type) : '';
  if (tp.indexOf('notFound') >= 0) return { uri: thread.uri, notFound: true };
  if (tp.indexOf('blocked') >= 0) return { uri: thread.uri, blocked: true };
  const node: any = { post: trimPost(thread.post) };
  if (thread.parent) node.parent = trimPost(thread.parent.post || thread.parent);
  if (Array.isArray(thread.replies)) node.replies = thread.replies.slice(0, maxReplies).map((r: any) => trimPost(r.post || r));
  return node;
}

function trimNotif(n: any): any {
  const out: any = { reason: n.reason, uri: n.uri, cid: n.cid, isRead: !!n.isRead, indexedAt: n.indexedAt };
  if (n.author) out.author = { handle: n.author.handle, name: n.author.displayName || undefined, did: n.author.did };
  if (n.reasonSubject) out.reasonSubject = n.reasonSubject;
  if (n.record && n.record.text) out.text = n.record.text;
  return out;
}

function trimConvo(c: any): any {
  return {
    id: c.id,
    members: (c.members || []).map((m: any) => ({ did: m.did, handle: m.handle, name: m.displayName || undefined })),
    unread: c.unreadCount || 0,
    lastMessage: c.lastMessage ? { text: c.lastMessage.text, sentAt: c.lastMessage.sentAt, sender: c.lastMessage.sender && c.lastMessage.sender.did } : undefined,
  };
}

function trimMessage(m: any): any {
  return { id: m.id, sender: m.sender && m.sender.did, text: m.text, sentAt: m.sentAt };
}

// ── Formatters: compact single-line JSON, always echoing the next cursor ──

function fmtList(noun: string, items: any[], cursor?: string, partial?: string): ReturnType<typeof text> {
  let msg = `${items.length} ${noun}(s) (cursor: ${cursor || 'end'}):\n\n${JSON.stringify(items)}`;
  if (partial) msg += `\n\n(partial — stopped early: ${partial})`;
  return text(msg);
}

// ─────────────────────────────────────────────────────────────────────────
// Shared schema fragments
// ─────────────────────────────────────────────────────────────────────────

const sessionFields = {
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: z.string().optional().describe('Target a specific tab within the session (the bsky.app tab). Auto-resolved if omitted.'),
};

const cursorFields = {
  limit: z.coerce.number().int().min(1).max(100).optional().describe('Items per page (default 50, max 100).'),
  cursor: z.string().optional().describe('Pagination cursor from a prior call. Omit for the first page.'),
  maxItems: z.coerce.number().int().min(1).max(500).optional().describe('Auto-paginate (follow cursors) until this many items are gathered in ONE call. Default = one page.'),
};

// ═════════════════════════════════════════════════════════════════════════
// 1. bluesky_session — whoami / login check
// ═════════════════════════════════════════════════════════════════════════

const blueskySessionSchema = {
  validate: z.coerce.boolean().optional().describe('Also call com.atproto.server.getSession to verify the token server-side.'),
  ...sessionFields,
};
const blueskySessionDescription =
  'BlueSky: who am I? Returns the logged-in account (did, handle, pdsUrl). Use first to confirm you are signed in. A blank assigned tab is safely initialized at bsky.app; nonblank tabs are never navigated implicitly. Pass validate:true to check the token against the server.';
async function handleBlueskySession(args: { validate?: boolean } & SessionArgs) {
  const body = `
    var s = __bskySession();
    if (s.__bskyError) return s;
    var out = { did: s.did, handle: s.handle, pdsUrl: s.pdsUrl };
    if (${args.validate ? 'true' : 'false'}){
      var v = await __bskyXrpc('com.atproto.server.getSession');
      if (v.__bskyError) return v;
      out.active = v.active; out.handle = v.handle || out.handle; out.email = v.email;
    }
    return out;`;
  const r = await runBsky(args, body);
  if ('error' in r) return text(r.error);
  return text(`BlueSky session: ${JSON.stringify(r.data)}`);
}

// ═════════════════════════════════════════════════════════════════════════
// 2. bluesky_timeline — home (following) feed
// ═════════════════════════════════════════════════════════════════════════

const blueskyTimelineSchema = { ...cursorFields, ...sessionFields };
const blueskyTimelineDescription =
  'BlueSky: read your home timeline (following feed) as compact JSON posts (uri, cid, author, text, counts, viewer). Pass maxItems to auto-paginate. Returns the next cursor.';
async function handleBlueskyTimeline(args: CursorArgs) {
  const params = { limit: clampLimit(args.limit), cursor: args.cursor };
  const body = `
    var r = await __bskyPaginate('app.bsky.feed.getTimeline', ${jsLit(params)}, 'feed', ${args.maxItems || 0});
    if (r.__bskyError) return r;
    return { items: r.feed, cursor: r.cursor, partial: r.partial };`;
  const r = await runBsky(args, body);
  if ('error' in r) return text(r.error);
  return fmtList('post', (r.data.items || []).map(trimPost), r.data.cursor, r.data.partial);
}

// ═════════════════════════════════════════════════════════════════════════
// 3. bluesky_author_feed — a user's posts
// ═════════════════════════════════════════════════════════════════════════

const blueskyAuthorFeedSchema = {
  actor: z.string().describe('Handle (e.g. alice.bsky.social) or DID of the author.'),
  filter: z.enum(['posts_with_replies', 'posts_no_replies', 'posts_with_media', 'posts_and_author_threads']).optional()
    .describe('Server-side filter. Default posts_with_replies.'),
  ...cursorFields, ...sessionFields,
};
const blueskyAuthorFeedDescription =
  "BlueSky: read a user's posts (author feed) as compact JSON. Pass actor (handle or DID), optional filter, and maxItems to auto-paginate.";
async function handleBlueskyAuthorFeed(args: { actor: string; filter?: string } & CursorArgs) {
  const params = { actor: args.actor, filter: args.filter, limit: clampLimit(args.limit), cursor: args.cursor };
  const body = `
    var r = await __bskyPaginate('app.bsky.feed.getAuthorFeed', ${jsLit(params)}, 'feed', ${args.maxItems || 0});
    if (r.__bskyError) return r;
    return { items: r.feed, cursor: r.cursor, partial: r.partial };`;
  const r = await runBsky(args, body);
  if ('error' in r) return text(r.error);
  return fmtList('post', (r.data.items || []).map(trimPost), r.data.cursor, r.data.partial);
}

// ═════════════════════════════════════════════════════════════════════════
// 4. bluesky_thread — a post + its replies (returns uri+cid for replying)
// ═════════════════════════════════════════════════════════════════════════

const blueskyThreadSchema = {
  uri: z.string().describe('Post AT-URI (at://...) OR a bsky.app post URL (https://bsky.app/profile/<handle>/post/<rkey>).'),
  depth: z.coerce.number().int().min(0).max(20).optional().describe('Reply levels to fetch (default 6).'),
  parentHeight: z.coerce.number().int().min(0).max(20).optional().describe('Parent levels to fetch (default 5).'),
  ...sessionFields,
};
const blueskyThreadDescription =
  'BlueSky: read a post and its thread (parents + replies) as compact JSON. Accepts an AT-URI or a bsky.app post URL. Each post includes uri+cid (needed to reply/like/repost).';
async function handleBlueskyThread(args: { uri: string; depth?: number; parentHeight?: number } & SessionArgs) {
  const depth = args.depth != null ? args.depth : 6;
  const ph = args.parentHeight != null ? args.parentHeight : 5;
  const body = `
    var uri = await __bskyNormUri(${jsLit(args.uri)});
    if (!uri) return { __bskyError: 'Could not resolve that post URL to an at-uri.' };
    var r = await __bskyXrpc('app.bsky.feed.getPostThread', { params:{ uri: uri, depth: ${depth}, parentHeight: ${ph} } });
    if (r.__bskyError) return r;
    return r.thread;`;
  const r = await runBsky(args, body);
  if ('error' in r) return text(r.error);
  return text(`Thread:\n\n${JSON.stringify(trimThread(r.data))}`);
}

// ═════════════════════════════════════════════════════════════════════════
// 5. bluesky_profile — actor profile
// ═════════════════════════════════════════════════════════════════════════

const blueskyProfileSchema = {
  actor: z.string().describe('Handle or DID to look up.'),
  ...sessionFields,
};
const blueskyProfileDescription =
  'BlueSky: get an actor profile (did, handle, name, bio, follower/following/post counts, and your viewer relationship: following/followedBy/muted/blocking).';
async function handleBlueskyProfile(args: { actor: string } & SessionArgs) {
  const body = `
    var r = await __bskyXrpc('app.bsky.actor.getProfile', { params:{ actor: ${jsLit(args.actor)} } });
    if (r.__bskyError) return r;
    return r;`;
  const r = await runBsky(args, body);
  if ('error' in r) return text(r.error);
  return text(`Profile:\n\n${JSON.stringify(trimActor(r.data))}`);
}

// ═════════════════════════════════════════════════════════════════════════
// 6. bluesky_search_posts
// ═════════════════════════════════════════════════════════════════════════

const blueskySearchPostsSchema = {
  q: z.string().describe('Search query.'),
  sort: z.enum(['top', 'latest']).optional().describe('Ranking. Default top.'),
  since: z.string().optional().describe('Lower bound, ISO datetime or YYYY-MM-DD.'),
  until: z.string().optional().describe('Upper bound, ISO datetime or YYYY-MM-DD.'),
  author: z.string().optional().describe('Limit to posts by this handle/DID.'),
  lang: z.string().optional().describe('BCP-47 language filter, e.g. en.'),
  ...cursorFields, ...sessionFields,
};
const blueskySearchPostsDescription =
  'BlueSky: full-text search posts. Supports sort (top/latest), since/until, author, lang. Pass maxItems to auto-paginate. Returns compact posts + next cursor.';
async function handleBlueskySearchPosts(args: { q: string; sort?: string; since?: string; until?: string; author?: string; lang?: string } & CursorArgs) {
  const params = { q: args.q, sort: args.sort, since: args.since, until: args.until, author: args.author, lang: args.lang, limit: clampLimit(args.limit), cursor: args.cursor };
  const body = `
    var r = await __bskyPaginate('app.bsky.feed.searchPosts', ${jsLit(params)}, 'posts', ${args.maxItems || 0});
    if (r.__bskyError) return r;
    return { items: r.posts, cursor: r.cursor, partial: r.partial };`;
  const r = await runBsky(args, body);
  if ('error' in r) return text(r.error);
  return fmtList('post', (r.data.items || []).map(trimPost), r.data.cursor, r.data.partial);
}

// ═════════════════════════════════════════════════════════════════════════
// 7. bluesky_search_actors
// ═════════════════════════════════════════════════════════════════════════

const blueskySearchActorsSchema = {
  q: z.string().describe('Search query (name / handle).'),
  ...cursorFields, ...sessionFields,
};
const blueskySearchActorsDescription =
  'BlueSky: search for users (actors). Returns compact actor cards (did, handle, name, bio, viewer relationship) + next cursor. Pass maxItems to auto-paginate.';
async function handleBlueskySearchActors(args: { q: string } & CursorArgs) {
  const params = { q: args.q, limit: clampLimit(args.limit), cursor: args.cursor };
  const body = `
    var r = await __bskyPaginate('app.bsky.actor.searchActors', ${jsLit(params)}, 'actors', ${args.maxItems || 0});
    if (r.__bskyError) return r;
    return { items: r.actors, cursor: r.cursor, partial: r.partial };`;
  const r = await runBsky(args, body);
  if ('error' in r) return text(r.error);
  return fmtList('actor', (r.data.items || []).map(trimActor), r.data.cursor, r.data.partial);
}

// ═════════════════════════════════════════════════════════════════════════
// 8. bluesky_notifications
// ═════════════════════════════════════════════════════════════════════════

const blueskyNotificationsSchema = {
  priority: z.coerce.boolean().optional().describe('Only priority notifications.'),
  markSeen: z.coerce.boolean().optional().describe('Mark notifications seen (updates the seen timestamp) after fetching.'),
  ...cursorFields, ...sessionFields,
};
const blueskyNotificationsDescription =
  'BlueSky: list your notifications (likes, reposts, replies, mentions, follows) as compact JSON. Pass markSeen:true to clear the unread badge, maxItems to auto-paginate.';
async function handleBlueskyNotifications(args: { priority?: boolean; markSeen?: boolean } & CursorArgs) {
  const params = { limit: clampLimit(args.limit), cursor: args.cursor, priority: args.priority };
  const body = `
    var r = await __bskyPaginate('app.bsky.notification.listNotifications', ${jsLit(params)}, 'notifications', ${args.maxItems || 0});
    if (r.__bskyError) return r;
    if (${args.markSeen ? 'true' : 'false'}){
      await __bskyXrpc('app.bsky.notification.updateSeen', { verb:'POST', body:{ seenAt: new Date().toISOString() } });
    }
    return { items: r.notifications, cursor: r.cursor, partial: r.partial };`;
  const r = await runBsky(args, body);
  if ('error' in r) return text(r.error);
  return fmtList('notification', (r.data.items || []).map(trimNotif), r.data.cursor, r.data.partial);
}

// ═════════════════════════════════════════════════════════════════════════
// 9. bluesky_graph — followers / follows
// ═════════════════════════════════════════════════════════════════════════

const blueskyGraphSchema = {
  actor: z.string().describe('Handle or DID whose graph to read.'),
  which: z.enum(['followers', 'follows']).describe('followers = who follows them; follows = who they follow.'),
  ...cursorFields, ...sessionFields,
};
const blueskyGraphDescription =
  "BlueSky: list an actor's followers or follows as compact actor cards + next cursor. Pass maxItems to auto-paginate.";
async function handleBlueskyGraph(args: { actor: string; which: 'followers' | 'follows' } & CursorArgs) {
  const method = args.which === 'followers' ? 'app.bsky.graph.getFollowers' : 'app.bsky.graph.getFollows';
  const key = args.which;
  const params = { actor: args.actor, limit: clampLimit(args.limit), cursor: args.cursor };
  const body = `
    var r = await __bskyPaginate(${jsLit(method)}, ${jsLit(params)}, ${jsLit(key)}, ${args.maxItems || 0});
    if (r.__bskyError) return r;
    return { items: r[${jsLit(key)}], cursor: r.cursor, partial: r.partial };`;
  const r = await runBsky(args, body);
  if ('error' in r) return text(r.error);
  return fmtList('actor', (r.data.items || []).map(trimActor), r.data.cursor, r.data.partial);
}

// ═════════════════════════════════════════════════════════════════════════
// 10. bluesky_likes — likes on a post, or posts an actor liked
// ═════════════════════════════════════════════════════════════════════════

const blueskyLikesSchema = {
  mode: z.enum(['post', 'actor']).describe('post = who liked a post (needs uri); actor = posts an actor has liked (needs actor).'),
  uri: z.string().optional().describe('Post AT-URI or bsky.app URL (mode=post).'),
  actor: z.string().optional().describe('Handle or DID (mode=actor).'),
  ...cursorFields, ...sessionFields,
};
const blueskyLikesDescription =
  'BlueSky: list likes. mode=post → the actors who liked a given post; mode=actor → the posts an actor has liked. Pass maxItems to auto-paginate.';
async function handleBlueskyLikes(args: { mode: 'post' | 'actor'; uri?: string; actor?: string } & CursorArgs) {
  if (args.mode === 'post') {
    if (!args.uri) return text('mode=post requires uri (the post to inspect).');
    const params = { limit: clampLimit(args.limit), cursor: args.cursor };
    const body = `
      var uri = await __bskyNormUri(${jsLit(args.uri)});
      if (!uri) return { __bskyError: 'Could not resolve that post URL to an at-uri.' };
      var p = Object.assign({ uri: uri }, ${jsLit(params)});
      var r = await __bskyPaginate('app.bsky.feed.getLikes', p, 'likes', ${args.maxItems || 0});
      if (r.__bskyError) return r;
      return { items: r.likes, cursor: r.cursor, partial: r.partial };`;
    const r = await runBsky(args, body);
    if ('error' in r) return text(r.error);
    const items = (r.data.items || []).map((l: any) => ({ actor: trimActor(l.actor), createdAt: l.createdAt }));
    return fmtList('like', items, r.data.cursor, r.data.partial);
  }
  if (!args.actor) return text('mode=actor requires actor (handle or DID).');
  const params = { actor: args.actor, limit: clampLimit(args.limit), cursor: args.cursor };
  const body = `
    var r = await __bskyPaginate('app.bsky.feed.getActorLikes', ${jsLit(params)}, 'feed', ${args.maxItems || 0});
    if (r.__bskyError) return r;
    return { items: r.feed, cursor: r.cursor, partial: r.partial };`;
  const r = await runBsky(args, body);
  if ('error' in r) return text(r.error);
  return fmtList('post', (r.data.items || []).map(trimPost), r.data.cursor, r.data.partial);
}

// ═════════════════════════════════════════════════════════════════════════
// 11. bluesky_feed — custom feed generators & lists
// ═════════════════════════════════════════════════════════════════════════

const blueskyFeedSchema = {
  mode: z.enum(['feed', 'list']).describe('feed = a custom feed generator; list = a user list timeline.'),
  uri: z.string().describe('AT-URI of the feed generator (mode=feed) or the list (mode=list).'),
  ...cursorFields, ...sessionFields,
};
const blueskyFeedDescription =
  'BlueSky: read a custom feed generator (mode=feed) or a list timeline (mode=list) by its AT-URI. Returns compact posts + next cursor. Pass maxItems to auto-paginate.';
async function handleBlueskyFeed(args: { mode: 'feed' | 'list'; uri: string } & CursorArgs) {
  const method = args.mode === 'feed' ? 'app.bsky.feed.getFeed' : 'app.bsky.feed.getListFeed';
  const param = args.mode === 'feed' ? { feed: args.uri } : { list: args.uri };
  const params = { ...param, limit: clampLimit(args.limit), cursor: args.cursor };
  const body = `
    var r = await __bskyPaginate(${jsLit(method)}, ${jsLit(params)}, 'feed', ${args.maxItems || 0});
    if (r.__bskyError) return r;
    return { items: r.feed, cursor: r.cursor, partial: r.partial };`;
  const r = await runBsky(args, body);
  if ('error' in r) return text(r.error);
  return fmtList('post', (r.data.items || []).map(trimPost), r.data.cursor, r.data.partial);
}

// ═════════════════════════════════════════════════════════════════════════
// 12. bluesky_post — create a post / reply / quote, with images
// ═════════════════════════════════════════════════════════════════════════

const blueskyPostSchema = {
  text: z.string().describe('Post text (max 300 graphemes). @mentions, URLs and #hashtags are auto-detected into rich-text facets.'),
  replyTo: z.string().optional().describe('Reply to this post (AT-URI or bsky.app URL). Root/parent refs are derived automatically.'),
  quote: z.string().optional().describe('Quote-post this post (AT-URI or bsky.app URL).'),
  images: z.array(z.object({
    url: z.string().optional().describe('Image URL the browser can fetch.'),
    path: z.string().optional().describe('Local file path on this machine (uploaded via the Neural Interface).'),
    alt: z.string().optional().describe('Alt text (accessibility — recommended).'),
  })).max(4).optional().describe('Up to 4 images; give url OR path for each. Images take precedence over a quote embed.'),
  langs: z.array(z.string()).optional().describe('BCP-47 language tags. Default ["en"].'),
  ...sessionFields,
};
const blueskyPostDescription =
  'BlueSky: publish a post. Supports plain text with auto-facets (@mentions, links, #hashtags), replies (replyTo), quote-posts (quote), and up to 4 images (by url or local path, each with alt text). A link card (OG preview with thumbnail) is auto-generated for the first URL when the post has no images and no quote. Returns the new post uri+cid.';
async function handleBlueskyPost(args: {
  text: string; replyTo?: string; quote?: string;
  images?: Array<{ url?: string; path?: string; alt?: string }>; langs?: string[];
} & SessionArgs) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);
  const ready = await ensureBlueskyPageTarget(resolved.sessionId, resolved.tabId);
  if ('error' in ready) return text(ready.error);

  const images = args.images || [];
  if (images.length > 4) return text('BlueSky allows at most 4 images per post.');

  // Local-file images: upload via the Neural Interface (page context can't read disk).
  const urlImages: Array<{ url: string; alt: string }> = [];
  const preImages: Array<{ blob: unknown; alt: string }> = [];
  for (const img of images) {
    if (img.path) {
      const up = await ni.uploadBlueskyBlob(resolved.sessionId, img.path, resolved.tabId);
      if (up.error) return text(`Image upload failed for ${img.path}: ${up.error}`);
      const blob = (up as any).blob;
      if (!blob) return text(`Image upload returned no blob for ${img.path}.`);
      preImages.push({ blob, alt: img.alt || '' });
    } else if (img.url) {
      urlImages.push({ url: img.url, alt: img.alt || '' });
    }
  }
  const langs = args.langs && args.langs.length ? args.langs : ['en'];

  const body = `
    var TEXT = ${jsLit(args.text)};
    var LANGS = ${jsLit(langs)};
    var REPLY_TO = ${jsLit(args.replyTo || null)};
    var QUOTE = ${jsLit(args.quote || null)};
    var URL_IMAGES = ${jsLit(urlImages)};
    var PRE_IMAGES = ${jsLit(preImages)};

    var s = __bskySession();
    if (s.__bskyError) return s;

    function byteIdx(str, jsIdx){ return new TextEncoder().encode(str.slice(0, jsIdx)).length; }
    var facets = [];
    var firstUrl = null;
    var re, m;
    re = /https?:[/][/][^\\s)]+/g;
    while ((m = re.exec(TEXT))){
      if (!firstUrl) firstUrl = m[0];
      facets.push({ index:{ byteStart: byteIdx(TEXT, m.index), byteEnd: byteIdx(TEXT, m.index + m[0].length) }, features:[{ '$type':'app.bsky.richtext.facet#link', uri: m[0] }] });
    }
    re = /(^|\\s)(#[^\\s#]+)/g;
    while ((m = re.exec(TEXT))){
      var tag = m[2]; var at = m.index + m[1].length;
      facets.push({ index:{ byteStart: byteIdx(TEXT, at), byteEnd: byteIdx(TEXT, at + tag.length) }, features:[{ '$type':'app.bsky.richtext.facet#tag', tag: tag.slice(1) }] });
    }
    re = /(^|\\s)(@[a-zA-Z0-9.-]+)/g;
    var pend = [];
    while ((m = re.exec(TEXT))){
      var mh = m[2].slice(1).replace(/[.]+$/, ''); var mat = m.index + m[1].length;
      pend.push({ handle: mh, bs: byteIdx(TEXT, mat), be: byteIdx(TEXT, mat + 1 + mh.length) });
    }
    for (var i=0;i<pend.length;i++){
      var rr = await __bskyXrpc('com.atproto.identity.resolveHandle', { params:{ handle: pend[i].handle } });
      if (rr && rr.did) facets.push({ index:{ byteStart: pend[i].bs, byteEnd: pend[i].be }, features:[{ '$type':'app.bsky.richtext.facet#mention', did: rr.did }] });
    }

    var record = { '$type':'app.bsky.feed.post', text: TEXT, createdAt: new Date().toISOString() };
    if (LANGS && LANGS.length) record.langs = LANGS;
    if (facets.length) record.facets = facets;

    if (REPLY_TO){
      var ru = await __bskyNormUri(REPLY_TO);
      if (!ru) return { __bskyError: 'Could not resolve replyTo to an at-uri.' };
      var th = await __bskyXrpc('app.bsky.feed.getPostThread', { params:{ uri: ru, depth: 0, parentHeight: 0 } });
      if (th.__bskyError) return th;
      var pp = th.thread && th.thread.post;
      if (!pp) return { __bskyError: 'replyTo post not found.' };
      var parentRef = { uri: pp.uri, cid: pp.cid };
      var rootRef = (pp.record && pp.record.reply && pp.record.reply.root) ? pp.record.reply.root : parentRef;
      record.reply = { root: rootRef, parent: parentRef };
    }

    var imgs = [];
    for (var i=0;i<PRE_IMAGES.length;i++) imgs.push({ alt: PRE_IMAGES[i].alt || '', image: PRE_IMAGES[i].blob });
    for (var i=0;i<URL_IMAGES.length;i++){
      var ub = await __bskyUploadBlobFromUrl(URL_IMAGES[i].url);
      if (ub.__bskyError) return ub;
      imgs.push({ alt: URL_IMAGES[i].alt || '', image: ub.blob });
    }
    var embed = null;
    if (imgs.length){
      embed = { '$type':'app.bsky.embed.images', images: imgs };
    } else if (QUOTE){
      var qu = await __bskyNormUri(QUOTE);
      if (!qu) return { __bskyError: 'Could not resolve quote to an at-uri.' };
      var qth = await __bskyXrpc('app.bsky.feed.getPostThread', { params:{ uri: qu, depth: 0, parentHeight: 0 } });
      if (qth.__bskyError) return qth;
      var qp = qth.thread && qth.thread.post;
      if (!qp) return { __bskyError: 'quote post not found.' };
      embed = { '$type':'app.bsky.embed.record', record: { uri: qp.uri, cid: qp.cid } };
    } else if (firstUrl){
      // OG link card (app.bsky.embed.external), built the way the official client does via
      // CardyB (server-side OG fetch, avoids CORS on the target site). Best-effort: on ANY
      // failure fall back to the bare faceted link so the post still publishes.
      try {
        var cardRes = await fetch('https://cardyb.bsky.app/v1/extract?url=' + encodeURIComponent(firstUrl));
        if (cardRes.ok){
          var card = await cardRes.json();
          if (card && !card.error && (card.title || card.description)){
            var ext = { uri: firstUrl, title: String(card.title || ''), description: String(card.description || '') };
            if (card.image){
              var tb = await __bskyUploadBlobFromUrl(card.image);
              if (!tb.__bskyError && tb.blob) ext.thumb = tb.blob;
            }
            embed = { '$type':'app.bsky.embed.external', external: ext };
          }
        }
      } catch(e){}
    }
    if (embed) record.embed = embed;

    var cr = await __bskyXrpc('com.atproto.repo.createRecord', { verb:'POST', body:{ repo: s.did, collection:'app.bsky.feed.post', record: record } });
    if (cr.__bskyError) return cr;
    return { uri: cr.uri, cid: cr.cid };`;

  const r = await evalBsky(resolved.sessionId, resolved.tabId, body);
  if ('error' in r) return text(r.error);
  return text(`Posted to BlueSky: ${JSON.stringify({ uri: r.data.uri, cid: r.data.cid })}`);
}

// ═════════════════════════════════════════════════════════════════════════
// 13. bluesky_action — like/repost/follow/mute/block/delete (+ undos)
// ═════════════════════════════════════════════════════════════════════════

const blueskyActionSchema = {
  action: z.enum(['like', 'unlike', 'repost', 'unrepost', 'follow', 'unfollow', 'mute', 'unmute', 'block', 'unblock', 'delete'])
    .describe('The action to perform.'),
  target: z.string().describe('Post actions (like/unlike/repost/unrepost/delete): post AT-URI or bsky.app URL. Actor actions (follow/unfollow/mute/unmute/block/unblock): handle or DID.'),
  ...sessionFields,
};
const blueskyActionDescription =
  'BlueSky: act on a post or actor. Post: like/unlike, repost/unrepost, delete (your own). Actor: follow/unfollow, mute/unmute, block/unblock. Undo actions resolve the record key automatically — never pass rkeys.';
async function handleBlueskyAction(args: { action: string; target: string } & SessionArgs) {
  const body = `
    var ACTION = ${jsLit(args.action)};
    var TARGET = ${jsLit(args.target)};
    var s = __bskySession();
    if (s.__bskyError) return s;
    var did = s.did;
    function rkeyFromUri(uri){ var parts = String(uri).split('/'); return parts[parts.length-1]; }
    async function getPostRef(input){
      var uri = await __bskyNormUri(input);
      if (!uri) return { __bskyError: 'Could not resolve target to an at-uri.' };
      var r = await __bskyXrpc('app.bsky.feed.getPosts', { params:{ uris: [uri] } });
      if (r.__bskyError) return r;
      var p = r.posts && r.posts[0];
      if (!p) return { __bskyError: 'Target post not found.' };
      return { uri: p.uri, cid: p.cid, viewer: p.viewer || {} };
    }

    if (ACTION === 'like' || ACTION === 'repost'){
      var ref = await getPostRef(TARGET);
      if (ref.__bskyError) return ref;
      var col = ACTION === 'like' ? 'app.bsky.feed.like' : 'app.bsky.feed.repost';
      var cr = await __bskyXrpc('com.atproto.repo.createRecord', { verb:'POST', body:{ repo: did, collection: col, record:{ '$type': col, subject:{ uri: ref.uri, cid: ref.cid }, createdAt: new Date().toISOString() } } });
      if (cr.__bskyError) return cr;
      return { ok:true, action: ACTION, uri: cr.uri };
    }
    if (ACTION === 'unlike' || ACTION === 'unrepost'){
      var ref = await getPostRef(TARGET);
      if (ref.__bskyError) return ref;
      var existing = ACTION === 'unlike' ? ref.viewer.like : ref.viewer.repost;
      if (!existing) return { ok:true, action: ACTION, note: 'was not ' + (ACTION === 'unlike' ? 'liked' : 'reposted') };
      var col = ACTION === 'unlike' ? 'app.bsky.feed.like' : 'app.bsky.feed.repost';
      var dr = await __bskyXrpc('com.atproto.repo.deleteRecord', { verb:'POST', body:{ repo: did, collection: col, rkey: rkeyFromUri(existing) } });
      if (dr.__bskyError) return dr;
      return { ok:true, action: ACTION };
    }
    if (ACTION === 'follow' || ACTION === 'block'){
      var adid = await __bskyResolveActor(TARGET);
      if (!adid) return { __bskyError: 'Could not resolve actor: ' + TARGET };
      var col = ACTION === 'follow' ? 'app.bsky.graph.follow' : 'app.bsky.graph.block';
      var cr = await __bskyXrpc('com.atproto.repo.createRecord', { verb:'POST', body:{ repo: did, collection: col, record:{ '$type': col, subject: adid, createdAt: new Date().toISOString() } } });
      if (cr.__bskyError) return cr;
      return { ok:true, action: ACTION, uri: cr.uri };
    }
    if (ACTION === 'unfollow' || ACTION === 'unblock'){
      var adid = await __bskyResolveActor(TARGET);
      if (!adid) return { __bskyError: 'Could not resolve actor: ' + TARGET };
      var pr = await __bskyXrpc('app.bsky.actor.getProfile', { params:{ actor: adid } });
      if (pr.__bskyError) return pr;
      var v = pr.viewer || {};
      var existing = ACTION === 'unfollow' ? v.following : v.blocking;
      if (!existing) return { ok:true, action: ACTION, note: 'was not ' + (ACTION === 'unfollow' ? 'following' : 'blocking') };
      var col = ACTION === 'unfollow' ? 'app.bsky.graph.follow' : 'app.bsky.graph.block';
      var dr = await __bskyXrpc('com.atproto.repo.deleteRecord', { verb:'POST', body:{ repo: did, collection: col, rkey: rkeyFromUri(existing) } });
      if (dr.__bskyError) return dr;
      return { ok:true, action: ACTION };
    }
    if (ACTION === 'mute' || ACTION === 'unmute'){
      var adid = await __bskyResolveActor(TARGET);
      if (!adid) return { __bskyError: 'Could not resolve actor: ' + TARGET };
      var method = ACTION === 'mute' ? 'app.bsky.graph.muteActor' : 'app.bsky.graph.unmuteActor';
      var mr = await __bskyXrpc(method, { verb:'POST', body:{ actor: adid } });
      if (mr.__bskyError) return mr;
      return { ok:true, action: ACTION };
    }
    if (ACTION === 'delete'){
      var uri = await __bskyNormUri(TARGET);
      if (!uri) return { __bskyError: 'Could not resolve target to an at-uri.' };
      var parts = String(uri).replace('at://','').split('/');
      var repo = parts[0]; var col = parts[1] || 'app.bsky.feed.post'; var rkey = parts[2];
      if (repo !== did) return { __bskyError: 'Can only delete your own records (target belongs to ' + repo + ').' };
      var dr = await __bskyXrpc('com.atproto.repo.deleteRecord', { verb:'POST', body:{ repo: did, collection: col, rkey: rkey } });
      if (dr.__bskyError) return dr;
      return { ok:true, action:'delete', uri: uri };
    }
    return { __bskyError: 'Unknown action: ' + ACTION };`;
  const r = await runBsky(args, body);
  if ('error' in r) return text(r.error);
  return text(`BlueSky action: ${JSON.stringify(r.data)}`);
}

// ═════════════════════════════════════════════════════════════════════════
// 14. bluesky_resolve — handle → DID
// ═════════════════════════════════════════════════════════════════════════

const blueskyResolveSchema = {
  handle: z.string().describe('Handle to resolve, e.g. alice.bsky.social.'),
  ...sessionFields,
};
const blueskyResolveDescription =
  'BlueSky: resolve a handle to its DID (com.atproto.identity.resolveHandle).';
async function handleBlueskyResolve(args: { handle: string } & SessionArgs) {
  const body = `
    var r = await __bskyXrpc('com.atproto.identity.resolveHandle', { params:{ handle: ${jsLit(args.handle)} } });
    if (r.__bskyError) return r;
    return { handle: ${jsLit(args.handle)}, did: r.did };`;
  const r = await runBsky(args, body);
  if ('error' in r) return text(r.error);
  return text(`Resolved: ${JSON.stringify(r.data)}`);
}

// ═════════════════════════════════════════════════════════════════════════
// 15. bluesky_dm — direct messages (chat.bsky.* via the chat service proxy)
// ═════════════════════════════════════════════════════════════════════════

const CHAT_PROXY = 'did:web:api.bsky.chat#bsky_chat';

const blueskyDmSchema = {
  action: z.enum(['list_convos', 'messages', 'send', 'mark_read'])
    .describe('list_convos = your DM conversations; messages = messages in a convo; send = send a message; mark_read = mark a convo read.'),
  convoId: z.string().optional().describe('Conversation ID (messages/mark_read; send if not using members).'),
  members: z.array(z.string()).optional().describe('For send: handles/DIDs to open/find a convo with, instead of convoId.'),
  text: z.string().optional().describe('Message text (required for send).'),
  ...cursorFields, ...sessionFields,
};
const blueskyDmDescription =
  'BlueSky DMs (chat.bsky.*): list_convos, read messages in a convo, send a message (by convoId or members), or mark_read. Returns compact JSON.';
async function handleBlueskyDm(args: { action: string; convoId?: string; members?: string[]; text?: string } & CursorArgs) {
  const proxy = jsLit(CHAT_PROXY);
  if (args.action === 'list_convos') {
    const params = { limit: clampLimit(args.limit), cursor: args.cursor };
    const body = `
      var r = await __bskyPaginate('chat.bsky.convo.listConvos', ${jsLit(params)}, 'convos', ${args.maxItems || 0}, ${proxy});
      if (r.__bskyError) return r;
      return { items: r.convos, cursor: r.cursor, partial: r.partial };`;
    const r = await runBsky(args, body);
    if ('error' in r) return text(r.error);
    return fmtList('convo', (r.data.items || []).map(trimConvo), r.data.cursor, r.data.partial);
  }
  if (args.action === 'messages') {
    if (!args.convoId) return text('action=messages requires convoId.');
    const params = { convoId: args.convoId, limit: clampLimit(args.limit), cursor: args.cursor };
    const body = `
      var r = await __bskyPaginate('chat.bsky.convo.getMessages', ${jsLit(params)}, 'messages', ${args.maxItems || 0}, ${proxy});
      if (r.__bskyError) return r;
      return { items: r.messages, cursor: r.cursor, partial: r.partial };`;
    const r = await runBsky(args, body);
    if ('error' in r) return text(r.error);
    return fmtList('message', (r.data.items || []).map(trimMessage), r.data.cursor, r.data.partial);
  }
  if (args.action === 'send') {
    if (!args.text) return text('action=send requires text.');
    if (!args.convoId && !(args.members && args.members.length)) return text('action=send requires convoId or members.');
    const body = `
      var convoId = ${jsLit(args.convoId || null)};
      var MEMBERS = ${jsLit(args.members || [])};
      if (!convoId){
        var dids = [];
        for (var i=0;i<MEMBERS.length;i++){ var d = await __bskyResolveActor(MEMBERS[i]); if (!d) return { __bskyError: 'Could not resolve member: ' + MEMBERS[i] }; dids.push(d); }
        var cr = await __bskyXrpc('chat.bsky.convo.getConvoForMembers', { params:{ members: dids }, proxy: ${proxy} });
        if (cr.__bskyError) return cr;
        convoId = cr.convo && cr.convo.id;
        if (!convoId) return { __bskyError: 'Could not open a conversation for those members.' };
      }
      var sm = await __bskyXrpc('chat.bsky.convo.sendMessage', { verb:'POST', proxy: ${proxy}, body:{ convoId: convoId, message: { text: ${jsLit(args.text)} } } });
      if (sm.__bskyError) return sm;
      return { ok:true, convoId: convoId, messageId: sm.id, sentAt: sm.sentAt };`;
    const r = await runBsky(args, body);
    if ('error' in r) return text(r.error);
    return text(`DM sent: ${JSON.stringify(r.data)}`);
  }
  // mark_read
  if (!args.convoId) return text('action=mark_read requires convoId.');
  const body = `
    var r = await __bskyXrpc('chat.bsky.convo.updateRead', { verb:'POST', proxy: ${proxy}, body:{ convoId: ${jsLit(args.convoId)} } });
    if (r.__bskyError) return r;
    return { ok:true, convoId: ${jsLit(args.convoId)} };`;
  const r = await runBsky(args, body);
  if ('error' in r) return text(r.error);
  return text(`DM convo marked read: ${JSON.stringify(r.data)}`);
}

// ─────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────

/** Register BlueSky (AT Protocol) tools (15 tools). */
export function registerBlueskyTools(server: McpServer) {
  return [
    server.tool('bluesky_session', blueskySessionDescription, blueskySessionSchema, handleBlueskySession),
    server.tool('bluesky_timeline', blueskyTimelineDescription, blueskyTimelineSchema, handleBlueskyTimeline),
    server.tool('bluesky_author_feed', blueskyAuthorFeedDescription, blueskyAuthorFeedSchema, handleBlueskyAuthorFeed),
    server.tool('bluesky_thread', blueskyThreadDescription, blueskyThreadSchema, handleBlueskyThread),
    server.tool('bluesky_profile', blueskyProfileDescription, blueskyProfileSchema, handleBlueskyProfile),
    server.tool('bluesky_search_posts', blueskySearchPostsDescription, blueskySearchPostsSchema, handleBlueskySearchPosts),
    server.tool('bluesky_search_actors', blueskySearchActorsDescription, blueskySearchActorsSchema, handleBlueskySearchActors),
    server.tool('bluesky_notifications', blueskyNotificationsDescription, blueskyNotificationsSchema, handleBlueskyNotifications),
    server.tool('bluesky_graph', blueskyGraphDescription, blueskyGraphSchema, handleBlueskyGraph),
    server.tool('bluesky_likes', blueskyLikesDescription, blueskyLikesSchema, handleBlueskyLikes),
    server.tool('bluesky_feed', blueskyFeedDescription, blueskyFeedSchema, handleBlueskyFeed),
    server.tool('bluesky_post', blueskyPostDescription, blueskyPostSchema, handleBlueskyPost),
    server.tool('bluesky_action', blueskyActionDescription, blueskyActionSchema, handleBlueskyAction),
    server.tool('bluesky_resolve', blueskyResolveDescription, blueskyResolveSchema, handleBlueskyResolve),
    server.tool('bluesky_dm', blueskyDmDescription, blueskyDmSchema, handleBlueskyDm),
  ];
}
