import { z } from 'zod';
import { text } from './response.js';
const PLATFORMS = ['twitter', 'facebook', 'tiktok', 'whatsapp', 'instagram', 'linkedin'];
const ACTIONS = ['click', 'type', 'fill', 'scroll', 'snapshot', 'extract'];
// Stable selectors and flow notes per platform/action. Loaded lazily on demand
// instead of living inside every tool description (was ~15-20KB of per-session overhead).
const CHEATSHEET = {
    twitter: {
        click: `Post: [data-testid="tweetButton"]
Like / Retweet / Reply: [data-testid="like"] / [data-testid="retweet"] / [data-testid="reply"]
Compose FAB: [data-testid="SideNav_NewTweet_Button"]`,
        type: `Compose / reply box: [data-testid="tweetTextarea_0"] (contenteditable — prefer browser_type over fill).
Reply dialog has 2 tweetTextarea_0 elements — pass nthMatch to disambiguate.`,
        fill: `Search: [data-testid="SearchBox_Search_Input"]`,
        scroll: `Feed: selector "[data-testid=\\"primaryColumn\\"]", direction "down", distance 800–1500.`,
        snapshot: `Main feed: [data-testid="primaryColumn"]
Single tweet card: [data-testid="tweet"]`,
        extract: `browser_extract_tweets — use after navigating x.com/search?q=%23hashtag&f=live for latest-first hashtag results.`,
    },
    facebook: {
        click: `Like: [role="button"][aria-label="Curtir"] (PT) / [aria-label="Like"] (EN) / [aria-label="Beğen"] (TR).
Share: [role="button"][aria-label*="Compartilhar"] (PT) / [aria-label*="Share"] (EN).
Composer trigger: scope to [role="main"] div[role="button"]:has-text("Escreva algo") (PT) / :has-text("Write something") (EN) / :has-text("Bir şeyler yaz") (TR). Or pass nthMatch:0 on the unscoped selector.
Post submit: [role="dialog"] [role="button"]:has-text("Publicar") (PT) / :has-text("Post") (EN) / :has-text("Paylaş") (TR).`,
        type: `Composer (after opening dialog): [role="dialog"] [role="textbox"].
Comments: [contenteditable][aria-label*="Comente como"] (PT) / [aria-label*="Comment as"] (EN) / [aria-label*="Yorum yap"] (TR).`,
        scroll: `Feed: selector "[role=\\"feed\\"]".`,
        snapshot: `Feed: [role="feed"]. Single post: [role="article"]. Composer dialog: [role="dialog"].`,
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
};
export const browserCheatsheetSchema = {
    platform: z.enum(PLATFORMS).describe('Target platform to fetch selectors for.'),
    action: z.enum(ACTIONS).optional().describe('Optional: filter to a single action (click/type/fill/scroll/snapshot/extract). If omitted, returns every action known for the platform.'),
};
export const browserCheatsheetDescription = 'Look up stable selectors and flow notes for a social platform (twitter, facebook, tiktok, whatsapp, instagram, linkedin). Call this before automating a platform the first time in a session — then reuse the returned selectors for browser_click / browser_type / browser_fill / browser_scroll / browser_snapshot.';
export async function handleBrowserCheatsheet(args) {
    const entry = CHEATSHEET[args.platform];
    if (!entry)
        return text(`Unknown platform "${args.platform}". Known: ${PLATFORMS.join(', ')}`);
    if (args.action) {
        const body = entry[args.action];
        if (!body) {
            const available = Object.keys(entry).join(', ');
            return text(`No "${args.action}" notes for ${args.platform}. Available actions: ${available}`);
        }
        return text(`${args.platform} — ${args.action}:\n\n${body}`);
    }
    const sections = Object.entries(entry).map(([action, body]) => `## ${action}\n${body}`).join('\n\n');
    return text(`${args.platform} cheatsheet\n\n${sections}`);
}
//# sourceMappingURL=browser-cheatsheet.js.map