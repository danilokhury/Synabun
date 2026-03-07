import { z } from 'zod';
import * as ni from '../services/neural-interface.js';

function formatClickHints(result: Record<string, unknown>): string {
  const hints = result.hints as Array<{ role: string; text: string; ariaLabel: string; placeholder: string }> | undefined;
  if (!hints?.length) return '';
  let msg = '\n\nVisible interactive elements on page:';
  for (const h of hints) {
    const label = h.ariaLabel || h.text || h.placeholder || '(unnamed)';
    msg += `\n- ${h.role}: "${label.substring(0, 60)}"`;
  }
  msg += '\n\nUse browser_snapshot for full page structure.';
  return msg;
}

// ── browser_click ──

export const browserClickSchema = {
  selector: z.string().describe('Playwright selector for the element to click. Use CSS selectors (e.g. "button.submit", "#login"), text selectors (e.g. \'text="Sign in"\'), or Playwright extensions like \'button:has-text("Retry")\'. NEVER use :contains() — use :has-text() instead.'),
  nthMatch: z.number().int().min(0).optional().describe('If the selector matches multiple elements, click the Nth one (0-indexed). Facebook: composer trigger appears in sidebar + main — use nthMatch: 0 to click the first match.'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};

export const browserClickDescription =
  'Click an element on the page. Accepts Playwright selectors: CSS selectors, text="...", :has-text("..."), role=button[name="..."], or [data-testid="..."]. Use browser_snapshot first to identify interactive elements. ' +
  'Twitter/X stable selectors: [data-testid="tweetButton"] (post), [data-testid="like"], [data-testid="retweet"], [data-testid="reply"], [data-testid="SideNav_NewTweet_Button"] (compose FAB). ' +
  'Facebook: [role="button"][aria-label="Curtir"] (PT like), [role="button"][aria-label="Like"] (EN), [role="button"][aria-label="Beğen"] (TR), [role="button"][aria-label*="Compartilhar"] (PT share), [role="button"][aria-label*="Share"] (EN share). ' +
  'Facebook composer trigger: scope to [role="main"] div[role="button"]:has-text("Escreva algo") (PT) / :has-text("Write something") (EN) / :has-text("Bir şeyler yaz") (TR), or pass nthMatch: 0 on the unscoped selector. ' +
  'Facebook post submit: [role="dialog"] [role="button"]:has-text("Publicar") (PT) / :has-text("Post") (EN) / :has-text("Paylaş") (TR). ' +
  'TikTok main app — Like: button[aria-label*="Curtir vídeo"] (PT) / button[aria-label*="Like video"] (EN). ' +
  'Comments: button[aria-label*="comentário"] (PT) / button[aria-label*="Read or add comments"] (EN) / button[aria-label*="comment"] (EN fallback). NOTE: On For You feed multiple articles are loaded — use nthMatch: 0 to target the first visible video. Prefer navigating directly to tiktok.com/@user/video/ID to avoid CAPTCHA. ' +
  'Share: button[aria-label*="Compartilhar vídeo"] (PT) / button[aria-label*="Share video"] (EN). ' +
  'Upload nav: [data-e2e="nav-upload"]. ' +
  'Follow from For You feed: [data-e2e="feed-follow"] (the + icon on avatar — no nthMatch needed). ' +
  'Follow from profile page: button:has-text("Seguir") nthMatch:0 (matches many sidebar items — always use nthMatch:0). ' +
  'NOTE: button[data-e2e="follow-button"] does NOT work on video pages — use feed-follow or navigate to profile. ' +
  'Like a comment: use browser_evaluate to call row.querySelector("[class*=DivLikeContainer]").click() — standard browser_click on [data-e2e="like-icon"] targets video likes and may navigate away. ' +
  'TikTok Studio — edit post: [data-tt="components_ActionCell_Clickable"] (first in row = edit pencil). ' +
  'Privacy dropdown: [data-tt="components_PrivacyCell_TUXButton"]. ' +
  'Studio upload: button:has-text("Selecionar vídeo") then use browser_upload for file. ' +
  'TikTok open comment panel: click [data-e2e="comment-input"] (outer container — activates the panel). Comment submit: [data-e2e="comment-post"]. Notifications: [data-e2e="nav-activity"]. Profile nav: [data-e2e="nav-profile"]. ' +
  'WhatsApp Web — open chat: click span[title="Chat Name"] in the sidebar. Send message: button[aria-label="Enviar"] (appears after typing). ' +
  'Attach menu: button[aria-label="Anexar"] → then [role="menuitem"][aria-label="Documento"] / [aria-label="Fotos e vídeos"] / [aria-label="Câmera"] / [aria-label="Contato"] / [aria-label="Enquete"]. ' +
  'Emoji: button[aria-label="Emojis, GIFs, figurinhas"]. Voice: button[aria-label="Mensagem de voz"]. Search in chat: button[aria-label="Pesquisar"]. ' +
  'Nav: button[aria-label="Conversas"] / button[aria-label="Atualizações no status"] / button[aria-label="Canais"] / button[aria-label="Configurações"]. ' +
  'New chat: button[aria-label="Nova conversa"]. Header more options: button[aria-label="Mais opções"][data-tab="6"]. ' +
  'Status — add text: button[aria-label="Add Status"] → [role="menuitem"][aria-label="Texto"]. Status send: [aria-label="Enviar"]. Close status: button[aria-label="Fechar janela de post de status"].'

export async function handleBrowserClick(args: { selector: string; nthMatch?: number; sessionId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId);
  if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };

  const result = await ni.click(resolved.sessionId, args.selector, args.nthMatch);
  if (result.error) return { content: [{ type: 'text' as const, text: `Click failed: ${result.error}${formatClickHints(result)}` }] };

  return {
    content: [{ type: 'text' as const, text: `Clicked "${args.selector}" — now at ${result.url} "${result.title}"` }],
  };
}

// ── browser_fill ──

export const browserFillSchema = {
  selector: z.string().describe('Playwright selector for the input/textarea to fill (e.g. "input[name=\'email\']", "#search-box", \'input:has-text("Search")\').'),
  value: z.string().describe('The text value to fill into the element. Clears existing content first.'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};

export const browserFillDescription =
  'Clear an input field and fill it with new text. Accepts Playwright selectors: CSS, text="...", :has-text("..."), [data-testid="..."]. Twitter/X: compose box is [data-testid="tweetTextarea_0"], search is [data-testid="SearchBox_Search_Input"]. TikTok search: [data-e2e="search-user-input"]. WhatsApp search: input[aria-label="Pesquisar ou começar uma nova conversa"].';

export async function handleBrowserFill(args: { selector: string; value: string; sessionId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId);
  if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };

  const result = await ni.fill(resolved.sessionId, args.selector, args.value);
  if (result.error) return { content: [{ type: 'text' as const, text: `Fill failed: ${result.error}` }] };

  const location = result.url ? ` — ${result.url} "${result.title}"` : '';
  return {
    content: [{ type: 'text' as const, text: `Filled "${args.selector}" with "${args.value.slice(0, 100)}"${location}` }],
  };
}

// ── browser_type ──

export const browserTypeSchema = {
  selector: z.string().optional().describe('Playwright selector for the element to type into. If omitted, types into the currently focused element using keyboard events.'),
  text: z.string().describe('The text to type character by character (appends to existing content).'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};

export const browserTypeDescription =
  'Type text character by character (simulates real keystrokes, appends to existing content). Provide a selector to target an element, or omit to type into whatever is currently focused. ' +
  'Prefer browser_type over browser_fill for contenteditable editors — both Twitter/X ([data-testid="tweetTextarea_0"]) and Facebook use them. ' +
  'Facebook post composer (after opening dialog): [role="dialog"] [role="textbox"]. ' +
  'Facebook comment boxes: [contenteditable][aria-label*="Comente como"] (PT), [contenteditable][aria-label*="Comment as"] (EN), [contenteditable][aria-label*="Yorum yap"] (TR). ' +
  'TikTok comment flow: 1) Navigate directly to tiktok.com/@user/video/ID (avoids CAPTCHA from feed). 2) Click [data-e2e="comment-input"] to open/activate the comment panel. 3) Type into [data-e2e="comment-text"] div[contenteditable="true"] (DraftJS editor — NOT [data-e2e="comment-input"] which is a non-editable wrapper; use browser_evaluate with execCommand for longer text). 4) Submit with [data-e2e="comment-post"]. ' +
  'From For You feed: comment button needs nthMatch: 0 (multiple articles loaded). Direct video URL is safer to avoid CAPTCHA. ' +
  'WhatsApp message compose: div[role="textbox"][contenteditable="true"] (aria-label is "Digitar na conversa com [Name]" or "Digitar no grupo [Name]"). ' +
  'WhatsApp status text composer: .lexical-rich-text-input div[contenteditable="true"].';

export async function handleBrowserType(args: { selector?: string; text: string; sessionId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId);
  if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };

  const result = await ni.type(resolved.sessionId, args.selector ?? null, args.text);
  if (result.error) return { content: [{ type: 'text' as const, text: `Type failed: ${result.error}` }] };

  const target = args.selector ? `"${args.selector}"` : 'focused element';
  const location = result.url ? ` — ${result.url} "${result.title}"` : '';
  return {
    content: [{ type: 'text' as const, text: `Typed "${args.text.slice(0, 100)}" into ${target}${location}` }],
  };
}

// ── browser_hover ──

export const browserHoverSchema = {
  selector: z.string().describe('Playwright selector for the element to hover over (CSS, text="...", :has-text("...")).'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};

export const browserHoverDescription =
  'Hover over an element. Useful for revealing dropdowns, tooltips, or hover-triggered content. Accepts Playwright selectors.';

export async function handleBrowserHover(args: { selector: string; sessionId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId);
  if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };

  const result = await ni.hover(resolved.sessionId, args.selector);
  if (result.error) return { content: [{ type: 'text' as const, text: `Hover failed: ${result.error}` }] };

  const location = result.url ? ` — ${result.url} "${result.title}"` : '';
  return {
    content: [{ type: 'text' as const, text: `Hovered over "${args.selector}"${location}` }],
  };
}

// ── browser_select ──

export const browserSelectSchema = {
  selector: z.string().describe('Playwright selector for the <select> element.'),
  value: z.string().describe('The option value to select.'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};

export const browserSelectDescription =
  'Select an option from a <select> dropdown by CSS selector and option value.';

export async function handleBrowserSelect(args: { selector: string; value: string; sessionId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId);
  if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };

  const result = await ni.selectOption(resolved.sessionId, args.selector, args.value);
  if (result.error) return { content: [{ type: 'text' as const, text: `Select failed: ${result.error}` }] };

  const location = result.url ? ` — ${result.url} "${result.title}"` : '';
  return {
    content: [{ type: 'text' as const, text: `Selected "${args.value}" in "${args.selector}"${location}` }],
  };
}

// ── browser_press ──

export const browserPressSchema = {
  key: z.string().describe('Key or key combo to press (e.g. "Enter", "Tab", "Control+A", "Escape", "ArrowDown").'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};

export const browserPressDescription =
  'Press a keyboard key or key combination. Supports modifiers like Control+A, Shift+Enter, etc.';

export async function handleBrowserPress(args: { key: string; sessionId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId);
  if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };

  const result = await ni.pressKey(resolved.sessionId, args.key);
  if (result.error) return { content: [{ type: 'text' as const, text: `Press failed: ${result.error}` }] };

  const location = result.url ? ` — ${result.url} "${result.title}"` : '';
  return {
    content: [{ type: 'text' as const, text: `Pressed "${args.key}"${location}` }],
  };
}

// ── browser_scroll ──

export const browserScrollSchema = {
  direction: z.enum(['up', 'down', 'left', 'right']).describe('Direction to scroll.'),
  distance: z.coerce.number().optional().describe('Pixels to scroll (default: 500).'),
  selector: z.string().optional().describe('Scroll within a specific element instead of the page. Twitter: [data-testid="primaryColumn"] for main feed. Facebook: [role="feed"] for group/page post feed. TikTok: [data-e2e="comment-list"] for comment panel, [data-tt="components_PostTable_Container"] for Studio content table. WhatsApp: [aria-label="Lista de conversas"] for chat list sidebar, [role="application"] or the main chat panel for message history.'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};

export const browserScrollDescription =
  'Scroll the page or a specific element. Essential for infinite scroll feeds. Twitter/X: direction "down" with distance 800–1500 to load more tweets. Facebook: use selector "[role=\\"feed\\"]" to scroll within the post feed. TikTok feed: scroll "down" 800–1000px to advance to the next video. TikTok comment panel: use selector "[data-e2e=\\"comment-list\\"]". TikTok Studio table: use selector "[data-tt=\\"components_PostTable_Container\\"]". WhatsApp chat list: use selector "[aria-label=\\"Lista de conversas\\"]". WhatsApp message history: scroll "up" to load older messages.';

export async function handleBrowserScroll(args: { direction: string; distance?: number; selector?: string; sessionId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId);
  if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };

  const result = await ni.scroll(resolved.sessionId, { direction: args.direction, distance: args.distance, selector: args.selector });
  if (result.error) return { content: [{ type: 'text' as const, text: `Scroll failed: ${result.error}` }] };

  const target = args.selector ? `"${args.selector}"` : 'page';
  return { content: [{ type: 'text' as const, text: `Scrolled ${args.direction} ${args.distance ?? 500}px in ${target} — now at ${result.url} "${result.title}"` }] };
}

// ── browser_upload ──

export const browserUploadSchema = {
  selector: z.string().describe('Playwright selector for the file input element. Twitter: \'input[data-testid="fileInput"]\'.'),
  filePaths: z.array(z.string()).describe('Absolute file paths to upload. Twitter supports up to 4 images or 1 video per tweet.'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};

export const browserUploadDescription =
  'Upload one or more files via a file input element. For Twitter/X: click the media button first to reveal the hidden file input, then use selector \'input[data-testid="fileInput"]\'. ' +
  'TikTok Studio: click button:has-text("Selecionar vídeo") first, then use selector \'input[type="file"]\' — supports a single video file.';

export async function handleBrowserUpload(args: { selector: string; filePaths: string[]; sessionId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId);
  if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };

  const result = await ni.upload(resolved.sessionId, args.selector, args.filePaths);
  if (result.error) return { content: [{ type: 'text' as const, text: `Upload failed: ${result.error}` }] };

  return { content: [{ type: 'text' as const, text: `Uploaded ${args.filePaths.length} file(s) via "${args.selector}" — now at ${result.url} "${result.title}"` }] };
}
