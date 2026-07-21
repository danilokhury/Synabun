import { z } from 'zod';
import { text } from './response.js';

const PLATFORMS = ['twitter', 'facebook', 'tiktok', 'whatsapp', 'instagram', 'linkedin', 'bluesky'] as const;
const ACTIONS = ['click', 'type', 'fill', 'scroll', 'snapshot', 'extract', 'evaluate'] as const;

type Platform = typeof PLATFORMS[number];
type Action = typeof ACTIONS[number];

// Stable selectors and flow notes per platform/action. Loaded lazily on demand
// instead of living inside every tool description (was ~15-20KB of per-session overhead).
const CHEATSHEET: Record<Platform, Partial<Record<Action, string>>> = {
  twitter: {
    click: `Post (compose): [data-testid="tweetButton"]. Reply submit (inline): [data-testid="tweetButtonInline"].
Like / Repost / Reply icon: [data-testid="like"] / [data-testid="retweet"] / [data-testid="reply"]. Bookmark: [data-testid="bookmark"]. Compose FAB: [data-testid="SideNav_NewTweet_Button"].
REPLY FLOW (inline, never the modal): click the reply icon under the post, then call browser_x_compose_state — if isModal close it and retry inline; if composerCount>1 pass nthMatch. Type into [data-testid="tweetTextarea_0"], then post via the returned submitButton.selector (tweetButtonInline for inline replies). After posting, verify via browser_extract_tweets on x.com/<yourHandle>/with_replies.
ORIGINAL POST: navigate x.com/compose/tweet, type into [data-testid="tweetTextarea_0"], click [data-testid="tweetButton"].
QUOTE TWEET (the Repost->Quote menu often misfires into a plain reply, so compose instead): navigate x.com/compose/tweet, browser_type the FULL target status URL (https://x.com/<handle>/status/<id>) into [data-testid="tweetTextarea_0"], type your comment on the line ABOVE the URL, then call browser_x_compose_state. Post via submitButton.selector ONLY if quoteCard.type==="quote" (a real embedded tweet card). If type is "link" or "none", do NOT post (you would publish a bare reply) — fix the URL or skip the target. On loop tabs the server blocks this publish anyway when no quote card rendered (response carries quoteGuard). Never fall back to the reply icon for a quote.`,
    type: `Compose / reply box: [data-testid="tweetTextarea_0"] (contenteditable — prefer browser_type over browser_fill). A reply dialog can have 2 tweetTextarea_0 elements — pass nthMatch to disambiguate.
Type the whole tweet in ONE browser_type call (not truncated); blank lines separate paragraphs; never split a URL across calls.
DRAFT.JS QUIRK: a FAILED post saves a draft that JS/DOM clears do NOT reset, so new typing APPENDS to it (garbled/duplicated text). To reset: close the composer, click Discard on the "Save draft?" prompt, then reopen a FRESH composer. Never retype into a box that still shows old text.
HASHTAGS: each "#tag" opens a typeahead that swallows the word; pressing Escape DISCARDS it (leaving a bare "#"). Type each hashtag as "#tag" plus a trailing SPACE (the space commits it and closes the dropdown) — one browser_type call per tag, hashtags last.
BEFORE POSTING: read the composer text back and confirm it equals your intended tweet (every hashtag present, no duplicated/garbled text); if not, Discard and redo. browser_x_compose_state returns composerText, charCount/overLimit and hasStaleDraft so you can verify this deterministically instead of by eye.`,
    fill: `Search: [data-testid="SearchBox_Search_Input"]`,
    scroll: `Feed: selector "[data-testid=\\"primaryColumn\\"]", direction "down", distance 800–1500. Prefer browser_extract_tweets (scrolls:2 minItems:15) over manual scroll loops.`,
    snapshot: `Main feed: [data-testid="primaryColumn"]
Single tweet card: [data-testid="tweet"]`,
    extract: `browser_extract_tweets — navigate x.com/search?q=%23hashtag&f=live first for latest-first hashtag results. Pass scrolls:2 minItems:15 to scroll+extract+dedupe in one call; each item's url contains the status id needed for quote tweets.
browser_x_compose_state — one-call read-only probe of the compose surface (composerText, quoteCard.type, submitButton, isModal, hasStaleDraft, recommendedAction). Call it before every post/reply/quote, and again after submit to confirm the composer cleared.
VERIFY A POST PUBLISHED (do not trust a bare ok): record the max /status/<id> from browser_extract_tweets on x.com/<yourHandle>/with_replies BEFORE posting; after posting, re-extract — a NEW, higher status id means it published (that url is your tweet). Unchanged = not posted: log post-failed and skip, do not double-post.`,
  },
  facebook: {
    click: `Like: [role="button"][aria-label="Curtir"] (PT) / [aria-label="Like"] (EN) / [aria-label="Beğen"] (TR).
Share: [role="button"][aria-label*="Compartilhar"] (PT) / [aria-label*="Share"] (EN).
Composer trigger: scope to [role="main"] div[role="button"]:has-text("Escreva algo") (PT) / :has-text("Write something") (EN) / :has-text("Bir şeyler yaz") (TR). Or pass nthMatch:0 on the unscoped selector.
MODAL-AWARE: the trigger usually opens a [role="dialog"] Create-post composer — that dialog IS the correct group/page posting surface, do NOT reject it. Scope the Post button to that same dialog. Reject only the WRONG dialogs: a personal-profile composer (placeholder "What's on your mind" / "No que você está pensando") or a Share dialog.
Post submit: [role="dialog"] [role="button"]:has-text("Postar") (PT-BR groups) / :has-text("Publicar") (PT/ES) / :has-text("Post") (EN) / :has-text("Posten") | :has-text("Senden") | :has-text("Veröffentlichen") (DE — approval-required groups say "Senden" / "Zur Genehmigung senden", NOT "Posten") / :has-text("Paylaş") (TR) / :has-text("Publier") (FR). The PT-BR group composer button is "Postar", NOT "Publicar". Wait for it to be enabled (aria-disabled!="true") after typing.
Prefer browser_fb_composer_state: it returns the correctly-scoped submitButton (locale + approval-flow label match across PT/EN/DE/TR/FR/ES, plus a structural footer-button fallback flagged matchType:"heuristic" when the label is untranslated — verify via submission.state after clicking) AND a recommendedAction. When recommendedAction is "submit", click submitButton.selector to FINISH a half-typed post before starting anything new.`,
    type: `Composer editor: [role="dialog"] [role="textbox"] (modal Create-post, the normal case) or [role="main"] [role="textbox"] (rare true inline).
RELIABLE FLOW (verified): click the trigger to OPEN the composer, then call browser_type with NO selector so it types into the auto-focused editor. Targeting the editor by selector ([role="dialog"] [role="textbox"]) is flaky — FB renders several matching/transient editors and the locator often times out, which loses focus and closes the modal.
MULTI-PARAGRAPH POSTS: use mode:"insert" in ONE call — pass the full post with blank lines between paragraphs and the link alone on the final line. insertText keeps the blank-line paragraphs AND the isolated URL intact (the URL unfurls into a link-preview card) without firing Enter, so FB's mention/emoji typeahead cannot hijack it.
DO NOT use mode:"paragraphs" on FB's modal composer — it presses Escape between/after paragraphs, and on FB's Create-post dialog Escape CLOSES the modal and discards the draft.
STALE DRAFT in the box (FB auto-saves and restores partial drafts): select all via the Selection API (range.selectNodeContents(editor)) then browser_type mode:"insert" — the insert replaces the selection. Ctrl+A alone does NOT clear FB's contenteditable.
Comments: [contenteditable][aria-label*="Comente como"] (PT) / [aria-label*="Comment as"] (EN) / [aria-label*="Yorum yap"] (TR).`,
    scroll: `Feed: selector "[role=\\"feed\\"]".`,
    snapshot: `Feed: [role="feed"]. Single post: [role="article"]. Composer dialog: [role="dialog"].`,
    extract: `browser_extract_fb_posts — visible posts as JSON (author, text, time, postUrl, reactions). Use for dedupe before posting and to verify a post rendered after.
browser_extract_fb_groups — navigate to facebook.com/groups/joins/?ordering=viewer_added first, then call this to get your JOINED groups as a region-sorted index ({byRegion:{UK,US,EU,Brazil,Turkey,...}, counts, unmatched}). Region/currency are reconciled against the curated seed-queue memory; pass region to filter to one bucket. Use this to iterate groups by region instead of scrolling the rail.
browser_fb_composer_state — one-call read-only probe of the posting surface: modal state, composer candidates (inline vs dialog, search boxes filtered out, isPersonalProfile flagged), the scoped Post button, and a submission state (visible-post/pending-approval/posting-failed/composer-open). Use instead of ad-hoc browser_evaluate recon.`,
    evaluate: `browser_evaluate runs page.evaluate(script) — the script is evaluated as an EXPRESSION, so a top-level "return" is a SyntaxError. Always wrap logic in an IIFE that returns: (() => { /* ...; */ return value; })(). This rule is universal (all platforms), not just Facebook.`,
  },
  tiktok: {
    click: `Like: button[aria-label*="Curtir vídeo"] (PT) / button[aria-label*="Like video"] (EN). On For You feed use nthMatch:0.
Comments panel open: [data-e2e="comment-input"] (outer activator). Comment submit: [data-e2e="comment-post"].
Share: button[aria-label*="Compartilhar vídeo"] (PT) / button[aria-label*="Share video"] (EN).
Follow (feed): [data-e2e="feed-follow"]. Follow (profile): button:has-text("Seguir") nthMatch:0. NOTE: button[data-e2e="follow-button"] does NOT work on video pages.
Like a comment: call row.querySelector("[class*=DivLikeContainer]").click() via browser_evaluate — standard click on [data-e2e="like-icon"] targets video likes.
Studio — edit post: [data-tt="components_ActionCell_Clickable"]. Privacy dropdown: [data-tt="components_PrivacyCell_TUXButton"]. Upload: button:has-text("Selecionar vídeo") then browser_upload on input[type="file"].
Nav: [data-e2e="nav-upload"] / [data-e2e="nav-activity"] / [data-e2e="nav-profile"].
Prefer navigating directly to tiktok.com/@user/video/ID to avoid CAPTCHA.`,
    type: `Comment flow: 1) Navigate to tiktok.com/@user/video/ID 2) Click [data-e2e="comment-input"] (opens panel) 3) Type into [data-e2e="comment-text"] div[contenteditable="true"] (DraftJS — use browser_evaluate with execCommand for longer text) 4) Submit [data-e2e="comment-post"].`,
    fill: `Search: [data-e2e="search-user-input"].`,
    scroll: `Feed: direction "down" distance 800–1000 to advance. Comment panel: selector "[data-e2e=\\"comment-list\\"]". Studio table: selector "[data-tt=\\"components_PostTable_Container\\"]".`,
    snapshot: `Single video (For You): article. Search results: [data-e2e="search_top-item-list"]. Studio content list: [data-tt="components_PostTable_Container"].`,
  },
  whatsapp: {
    click: `Open chat: click span[title="<Chat Name>"] in sidebar.
Send message: button[aria-label="Enviar"] (appears after typing).
Attach: button[aria-label="Anexar"] → [role="menuitem"][aria-label="Documento" | "Fotos e vídeos" | "Câmera" | "Contato" | "Enquete"].
Emoji: button[aria-label="Emojis, GIFs, figurinhas"]. Voice: button[aria-label="Mensagem de voz"]. Search in chat: button[aria-label="Pesquisar"].
Nav: button[aria-label="Conversas" | "Atualizações no status" | "Canais" | "Configurações"]. New chat: button[aria-label="Nova conversa"]. Header more options: button[aria-label="Mais opções"][data-tab="6"].
Status — add text: button[aria-label="Add Status"] → [role="menuitem"][aria-label="Texto"]. Status send: [aria-label="Enviar"]. Close status: button[aria-label="Fechar janela de post de status"].`,
    type: `Message compose: div[role="textbox"][contenteditable="true"] (aria-label "Digitar na conversa com <Name>" or "Digitar no grupo <Name>").
Status text composer: .lexical-rich-text-input div[contenteditable="true"].`,
    fill: `Search: input[aria-label="Pesquisar ou começar uma nova conversa"].`,
    scroll: `Chat list: selector "[aria-label=\\"Lista de conversas\\"]". Message history: scroll "up" to load older messages.`,
    snapshot: `Chat list: [aria-label="Lista de conversas"]. Open chat view: [role="application"].`,
  },
  instagram: {
    click: `Like: [role="button"]:has(svg[aria-label="Curtir"]) (PT) / :has(svg[aria-label="Like"]) (EN).
Comment: [role="button"]:has(svg[aria-label="Comentar"]) (PT) / :has(svg[aria-label="Comment"]) (EN).
Share: [role="button"]:has(svg[aria-label="Compartilhar"]) (PT) / :has(svg[aria-label="Share"]) (EN).
Save: [role="button"]:has(svg[aria-label="Salvar"]) (PT) / :has(svg[aria-label="Save"]) (EN).
Follow: div:has-text("Seguir") (PT) / div:has-text("Follow") (EN) — nthMatch:0.
More options: [role="button"]:has(svg[aria-label="Mais opções" | "More options"]).
Sidebar nav: svg[aria-label="Pesquisa" | "Novo post" | "Notificações" | "Mensagens"].
On single post pages: comment input is a native textarea — use browser_fill, then press Enter to submit.
Reels: scroll down to advance. Engagement on right sidebar. Emoji: [role="button"]:has(svg[aria-label="Emoji"]).`,
    fill: `Comment box: textarea[aria-label="Adicione um comentário..."] (PT) / textarea[aria-label="Add a comment…"] (EN). Press Enter to submit.`,
    type: `Comment on post pages uses a native textarea (NOT contenteditable) — use browser_fill instead.
For DMs, navigate to instagram.com/direct/inbox/ first.
Search: click svg[aria-label="Pesquisa"] in sidebar to open search panel, then type in the input that appears.`,
    scroll: `Home feed / profile grid / explore: scroll "down" 800–1200. Reels: scroll "down" 800 to advance.`,
    snapshot: `Single feed post: article. Profile header: header. Post with comments: main. Comment input: form.`,
  },
  linkedin: {
    click: `Like: button[aria-label="Reagir com gostei"] (PT) / button[aria-label="React with Like"] (EN).
Reactions menu: button[aria-label="Abrir menu de reações"] (PT) / button[aria-label="Open reactions menu"] (EN).
Comment: button[aria-label="Comentar"] (PT) / button[aria-label="Comment"] (EN).
Send via DM: button[aria-label="Enviar em mensagem privada"] (PT) / button[aria-label="Send in private message"] (EN).
Post composer trigger: button:has-text("Comece uma publicação") (PT) / button:has-text("Start a post") (EN).
Post composer editor: [role="dialog"] .ql-editor[role="textbox"] — use browser_fill.
Post submit: [role="dialog"] .share-actions__primary-action (disabled until text entered).
Schedule: [role="dialog"] button[aria-label="Agendar publicação" | "Schedule post"].
Add media: [role="dialog"] button[aria-label="Adicionar mídia" | "Add media"].
Close dialog: button[aria-label="Fechar"] nthMatch:0.
Comment input on post page: .ql-editor[role="textbox"] — browser_fill then browser_press Enter to submit.
Follow: button:has-text("+ Seguir") (PT) / button:has-text("+ Follow") (EN) nthMatch:0.
Connect: button:has-text("Conectar") (PT) / button:has-text("Connect") (EN).
Messaging compose: .msg-form__contenteditable — fill then click .msg-form__send-button.
Nav: a[href*="/feed/"] / a[href*="/mynetwork/"] / a[href*="/jobs/"] / a[href*="/messaging/"] / a[href*="/notifications/"].`,
    scroll: `Feed / profile / notifications / search: scroll "down" 800–1200. Messaging sidebar: selector ".msg-conversations-container".`,
    snapshot: `Single feed post: .feed-shared-update-v2[data-urn]. Main content: .scaffold-layout__main. Messaging conversation item: .msg-conversation-listitem. Notification card: article.nt-card. Post composer: [role="dialog"].`,
  },
  bluesky: {
    extract: `Do NOT scrape the DOM — bsky.app is an AT Protocol client, so use the native bluesky_* tools which call the XRPC API directly via this logged-in tab (fast, reliable, paginated):
READ: bluesky_timeline (home feed), bluesky_author_feed (a user's posts), bluesky_thread (post + replies; returns uri+cid), bluesky_profile, bluesky_search_posts, bluesky_search_actors, bluesky_notifications, bluesky_graph (followers/follows), bluesky_likes, bluesky_feed (custom feeds/lists). All accept limit/cursor and maxItems (auto-paginate).
WRITE: bluesky_post (text + auto-facets for @mentions/links/#hashtags, replyTo, quote, up to 4 images by url or local path), bluesky_action (like/unlike, repost/unrepost, follow/unfollow, mute/unmute, block/unblock, delete), bluesky_dm (list_convos/messages/send/mark_read), bluesky_resolve (handle→DID).
PRECONDITION: a logged-in bsky.app tab must be the target (the session token is read from page localStorage). If a tool reports "not logged in", browser_navigate to https://bsky.app/ first.`,
    click: `Engagement and posting do NOT need clicks — call bluesky_action (like/repost/follow/...) and bluesky_post instead of driving the UI. URIs accept either an at:// AT-URI or a bsky.app post URL.`,
  },
};

export const browserCheatsheetSchema = {
  platform: z.enum(PLATFORMS).describe('Target platform to fetch selectors for.'),
  action: z.enum(ACTIONS).optional().describe('Optional: filter to a single action (click/type/fill/scroll/snapshot/extract/evaluate). If omitted, returns every action known for the platform.'),
};

export const browserCheatsheetDescription =
  'Look up stable selectors and flow notes for a social platform (twitter, facebook, tiktok, whatsapp, instagram, linkedin). Call this before automating a platform the first time in a session — then reuse the returned selectors for browser_click / browser_type / browser_fill / browser_scroll / browser_snapshot.';

// Universal guidance prepended to every cheatsheet response.
const UNIVERSAL_NOTES =
  'Universal: prefer refs over selectors — browser_snapshot (default mode "ai") labels elements [ref=eN]; pass ref:"eN" to browser_click/fill/type for an exact match. ' +
  'Use the selectors below when you need to act without a fresh snapshot (e.g. scripted loops). ' +
  'For feed harvesting use the browser_extract_* tools with scrolls/minItems instead of snapshots.';

export async function handleBrowserCheatsheet(args: { platform: Platform; action?: Action }) {
  const entry = CHEATSHEET[args.platform];
  if (!entry) return text(`Unknown platform "${args.platform}". Known: ${PLATFORMS.join(', ')}`);

  if (args.action) {
    const body = entry[args.action];
    if (!body) {
      const available = Object.keys(entry).join(', ');
      return text(`No "${args.action}" notes for ${args.platform}. Available actions: ${available}`);
    }
    return text(`${args.platform} — ${args.action}:\n\n${body}\n\n${UNIVERSAL_NOTES}`);
  }

  const sections = Object.entries(entry).map(([action, body]) => `## ${action}\n${body}`).join('\n\n');
  return text(`${args.platform} cheatsheet\n\n${UNIVERSAL_NOTES}\n\n${sections}`);
}
