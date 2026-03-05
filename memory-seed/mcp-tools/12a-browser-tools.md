---
category: mcp-tools
tags: [browser, playwright, automation, mcp-tool, navigation, interaction, extraction]
importance: 9
project: synabun
source: self-discovered
subcategory: architecture
related_files:
  - mcp-server/src/tools/browser.ts
  - mcp-server/src/tools/browser-navigate.ts
  - mcp-server/src/tools/browser-interact.ts
  - mcp-server/src/tools/browser-observe.ts
  - mcp-server/src/tools/browser-advanced.ts
  - neural-interface/server.js
---

# SynaBun Browser Automation Tools

Full Playwright-based browser automation exposed as MCP tools. The MCP server delegates to the Neural Interface's browser API (`/api/browser/*`), which manages Playwright browser sessions.

## Registration

`browser.ts` exports `registerBrowserTools(server)` which registers 26 tools in 4 groups:

## Navigation Tools (4)

### browser_navigate
Navigate to a URL. Params: `url` (required). Returns page title + snapshot.

### browser_go_back
Go back in browser history. No params.

### browser_go_forward
Go forward in browser history. No params.

### browser_reload
Reload current page. No params.

## Interaction Tools (8)

### browser_click
Click an element. Params: `ref` (element reference from snapshot, required).

### browser_fill
Fill an input field (clears first). Params: `ref` (required), `value` (required).

### browser_type
Type text character by character (doesn't clear). Params: `ref` (required), `text` (required).

### browser_hover
Hover over an element. Params: `ref` (required).

### browser_select
Select option(s) in a `<select>`. Params: `ref` (required), `values` (string array, required).

### browser_press
Press a keyboard key. Params: `key` (required, e.g. "Enter", "Tab", "Escape").

### browser_scroll
Scroll the page. Params: `direction` ("up" | "down"), `amount` (pixels, optional).

### browser_upload
Upload file(s) to a file input. Params: `ref` (required), `paths` (string array of file paths, required).

## Observation Tools (12)

### browser_snapshot
Get accessibility tree snapshot of current page. No params. Returns structured element tree with refs for interaction.

### browser_content
Get full page content as text or HTML. Params: `format` ("text" | "html", optional).

### browser_screenshot
Take screenshot of current page. No params. Returns base64 JPEG image.

### Social Extraction Tools

Specialized extractors for social media content:

- **browser_extract_tweets**: Extract tweets from Twitter/X page
- **browser_extract_fb_posts**: Extract posts from Facebook page
- **browser_extract_tiktok_videos**: Extract videos from TikTok page
- **browser_extract_tiktok_search**: Extract TikTok search results
- **browser_extract_tiktok_studio**: Extract TikTok Studio data
- **browser_extract_tiktok_profile**: Extract TikTok profile info
- **browser_extract_wa_chats**: Extract WhatsApp chat list
- **browser_extract_wa_messages**: Extract WhatsApp messages

Each returns structured data specific to the platform.

## Advanced Tools (3)

### browser_evaluate
Execute JavaScript in the browser context. Params: `expression` (required). Returns evaluation result.

### browser_wait
Wait for a condition. Params: `time` (milliseconds, optional), `selector` (CSS selector to wait for, optional).

### browser_session
Manage browser sessions. Params: `action` ("list" | "create" | "close"), `sessionId` (for close).

## Architecture

- MCP tool handlers call Neural Interface REST endpoints (e.g., `POST /api/browser/sessions/:id/navigate`)
- Neural Interface manages Playwright browser instances
- Browser config (headless/headed, Chrome profile) stored in Neural Interface settings
- Sessions persist across MCP calls until explicitly closed
- `pre-websearch.mjs` hook blocks WebSearch/WebFetch when a browser session is active

## Quirks

- All browser tools require Neural Interface to be running on port 3344
- Browser sessions use Chromium by default
- Chrome profile path can be configured for authenticated browsing
- The snapshot ref system: each element gets a numeric ref used by click/fill/type/etc.
