# Embedded Browser & Playwright Integration

**Date:** 2026-02-24
**Component:** Neural Interface
**Type:** Feature

## Summary

Added an embedded browser tab to the terminal panel powered by `playwright-core` and CDP screencast. Users can browse the web inside SynaBun while Claude Code controls the same browser instance via Playwright MCP.

## Added

### Browser Tab (CDP Screencast)

- `browser` profile in terminal panel — opens alongside Claude/Codex/Gemini/Shell tabs via the + button profile flyout
- Live rendering via CDP `Page.startScreencast` streaming JPEG frames over WebSocket to a `<canvas>`
- Address bar with back/forward/reload buttons, URL input with Enter-to-navigate
- Mouse forwarding — click, dblclick, mousemove, wheel translated from canvas coords to browser viewport coords
- Keyboard forwarding — keydown/keyup/keypress routed through WebSocket to `page.keyboard`
- Session reconnection — browser sessions survive page refresh (5-minute server-side grace period)
- Tab label auto-updates with page title

### REST API

- `POST /api/browser/sessions` — create session (url, width, height, fingerprint)
- `GET /api/browser/sessions` — list active sessions
- `DELETE /api/browser/sessions/:id` — destroy session (saves storage state if persistence enabled)
- `POST /api/browser/sessions/:id/navigate` — navigate to URL
- `POST /api/browser/sessions/:id/back|forward|reload` — navigation controls
- `GET /api/browser/sessions/:id/screenshot` — JPEG screenshot
- `GET /api/browser/sessions/:id/cdp` — CDP WebSocket endpoint
- `GET /api/browser/sessions/:id/claude-connect` — MCP config snippet for Claude Code
- `GET /api/browser/config` — load saved browser config + auto-detected Chrome path
- `PUT /api/browser/config` — save full browser config (full replacement)
- `POST /api/browser/sessions/:id/click` — click element by CSS selector
- `POST /api/browser/sessions/:id/fill` — clear + fill input by selector
- `POST /api/browser/sessions/:id/type` — type text character-by-character into element
- `POST /api/browser/sessions/:id/hover` — hover element by selector
- `POST /api/browser/sessions/:id/select` — select dropdown option by selector + value
- `POST /api/browser/sessions/:id/press` — press key or key combo (e.g. "Control+Enter")
- `POST /api/browser/sessions/:id/evaluate` — execute JavaScript in page context
- `GET /api/browser/sessions/:id/snapshot` — accessibility tree snapshot (ARIA roles, names, values)
- `POST /api/browser/sessions/:id/wait` — wait for element state or timeout
- `GET /api/browser/sessions/:id/content` — page text content + URL + title (body innerText, truncated 50K)
- `GET /api/browser/sessions/:id/screenshot-base64` — JPEG screenshot as base64 JSON response

### WebSocket

- `/ws/browser/:id` — screencast frame streaming + input forwarding (click, dblclick, wheel, keydown, keyup, keypress, navigate, resize)

### Claude Code Bridge (MCP Browser Tools)

- 15 new MCP tools registered on the SynaBun MCP server — Claude Code controls the browser through the existing SynaBun MCP connection, **no separate Playwright MCP plugin needed**
- MCP server delegates to Neural Interface via HTTP (`localhost:3344`), new pattern: MCP→HTTP→Express→Playwright
- Auto-session resolution — single session auto-selected, zero sessions auto-created (for navigate), multiple sessions require explicit ID
- **Navigation:** `browser_navigate`, `browser_go_back`, `browser_go_forward`
- **Interaction:** `browser_click`, `browser_fill`, `browser_type`, `browser_hover`, `browser_select`, `browser_press` — all selector-based via `page.locator()`
- **Observation:** `browser_snapshot` (accessibility tree, token-efficient), `browser_content` (page text + URL + title), `browser_screenshot` (base64 JPEG)
- **Advanced:** `browser_evaluate` (execute JS), `browser_wait` (element state or timeout), `browser_session` (list/create/close)
- `/api/browser/sessions/:id/claude-connect` also still returns CDP config for legacy Playwright MCP plugin use

### Stealth Fingerprint Cloning

Headers cloned from the real browser's HTTP request:
- User-Agent, Accept-Language, Sec-CH-UA, Sec-CH-UA-Mobile, Sec-CH-UA-Platform

Client-side fingerprint from Neural Interface JS:
- `window.screen.width/height`, `window.devicePixelRatio`, `Intl.DateTimeFormat().resolvedOptions().timeZone`

Chromium stealth launch args:
- `--disable-blink-features=AutomationControlled`, `--use-gl=swiftshader`, `--enable-webgl`, `--disable-infobars`, `--no-sandbox`

CDP stealth injections (`Page.addScriptToEvaluateOnNewDocument`):
- `navigator.webdriver = false`
- Fake `navigator.plugins` (3 Chrome plugins)
- `navigator.languages` cloned from Accept-Language
- `Permissions.prototype.query` patched (notifications -> 'default')
- `window.chrome.runtime` stub
- Cleanup of `__playwright` and `cdc_adoQpoasnfa76pfcZLmcfl_` markers
- Toggleable via Settings > Setup > Browser > Identity & Headers

### Granular Browser Configuration (Settings > Setup > Browser)

11 collapsible sub-sections persisted to `data/browser-config.json`:

1. **Executable** — Chrome path (auto-detect), **User Data Dir** (persistent Chrome profile with extensions/logins/bookmarks), headless mode, channel (Chrome/Edge variants), slowMo, timeout, navigation timeout, extra launch flags
2. **Viewport & Display** — viewport w/h, screen w/h, deviceScaleFactor (0.5-5), isMobile, hasTouch
3. **Identity & Headers** — userAgent, Accept-Language, locale, timezoneId, extra HTTP headers (JSON), stealth toggle
4. **Geolocation** — enable toggle + latitude/longitude/accuracy
5. **Permissions** — 15 checkboxes: geolocation, MIDI, MIDI SysEx, notifications, camera, microphone, background sync, ambient light sensor, accelerometer, gyroscope, magnetometer, clipboard read/write, payment handler, storage access
6. **Network & Proxy** — offline toggle, proxy server/bypass/auth, HTTP credentials
7. **Appearance** — colorScheme, reducedMotion, forcedColors
8. **Scripting & Security** — JS enabled, ignore HTTPS errors, bypass CSP, accept downloads, strict selectors, service workers
9. **Storage & Cookies** — persist toggle, storage file path, clear on startup
10. **Recording** — video (dir, resolution), HAR (path, content policy, mode, URL filter)
11. **Screencast** — format (JPEG/PNG), quality slider, max resolution, every Nth frame

Save/Reset buttons with toast confirmation.

### User Data Dir (Persistent Chrome Profile)

- Optional User Data Dir field in Executable settings — when set, launches with `chromium.launchPersistentContext()` using the user's real Chrome profile
- Extensions, bookmarks, logins, cookies, history all preserved from the user's Chrome installation
- `--disable-extensions` flag automatically skipped when using a user profile
- Chrome must be closed before opening SynaBun browser with the same profile (Chrome locks the profile directory)
- When empty, falls back to clean sandboxed browser (default behavior)

### Cookie & Storage State Persistence

- `context.storageState({ path })` called on session close when persistence enabled (sandboxed mode only)
- `storageState` option passed to `browser.newContext()` on create to restore previous state
- Skipped when using User Data Dir (Chrome handles persistence natively via the profile)
- "Clear on Startup" toggle wipes stored state before each new session
- Storage file path configurable (default `data/browser-storage.json`)

## Fixed

- **Minimize + restore zoom/blur** — ResizeObserver sent 0x0 on minimize, shrinking viewport to 320x200. Fixed with min-size guard (< 100px), dedup check, `visibilitychange` listener to re-send correct dimensions on restore, and canvas buffer stability (only reset dimensions when frame size changes)
- **Profile flyout clipped** — `+` button flyout invisible due to `overflow: hidden` on terminal panel. Changed from `position: absolute` to `position: fixed` with dynamic rect-based positioning
- **Server screencast restart** — resize handler now uses saved config values (format, quality, everyNthFrame) instead of hardcoded defaults

## Files Changed

- `neural-interface/package.json` — added `playwright-core` dependency
- `neural-interface/server.js` — browser manager (~300 lines), CDP screencast, stealth cloning, REST endpoints (original + 11 new selector-based), WebSocket handler, config load/save, storage state persistence, `launchPersistentContext` support for User Data Dir
- `neural-interface/public/shared/api.js` — browser API client functions (create, delete, list, navigate, back, forward, reload, fetchCdp)
- `neural-interface/public/shared/ui-terminal.js` — browser profile, openBrowserSession, reconnectBrowserSession, canvas frame rendering, input forwarding, ResizeObserver guards, visibilitychange handlers, cleanup
- `neural-interface/public/shared/ui-settings.js` — BROWSER_ICON constant, buildSetupTab Browser section (~300 lines HTML), User Data Dir field, event handlers (~350 lines: collapsible groups, toggles, collect/apply config, save/reset, auto-detect)
- `neural-interface/public/shared/styles.css` — browser viewport CSS, browser config form elements (~180 lines: groups, inputs, selects, textareas, checkboxes, range sliders, save button)
- `mcp-server/src/services/neural-interface.ts` — HTTP client for MCP→Neural Interface communication, auto-session resolution
- `mcp-server/src/tools/browser.ts` — registration aggregator for 15 browser MCP tools
- `mcp-server/src/tools/browser-navigate.ts` — browser_navigate, browser_go_back, browser_go_forward
- `mcp-server/src/tools/browser-interact.ts` — browser_click, browser_fill, browser_type, browser_hover, browser_select, browser_press
- `mcp-server/src/tools/browser-observe.ts` — browser_snapshot (accessibility tree formatter), browser_content, browser_screenshot
- `mcp-server/src/tools/browser-advanced.ts` — browser_evaluate, browser_wait, browser_session
- `mcp-server/src/index.ts` — wired `registerBrowserTools(server)` into tool registration
