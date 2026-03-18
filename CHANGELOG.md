# SynaBun Changelog

## 2026-03-18

### Added — Shared Frame Renderer Factory
- **`createFrameRenderer(canvas, ctx)`** — New utility in `utils.js` that creates a serialized latest-frame-wins renderer for browser screencast streams. Only one `Image` decode runs at a time; incoming frames during decode replace the pending frame (stale frames discarded). Includes `onerror` recovery so corrupted base64 data doesn't permanently stall the pipeline. Returns `{ render(base64), destroy() }` interface.

### Fixed — Browser Screencast Stream Freezing
- **Canvas freeze across all rendering surfaces** — Browser screencast streams in the terminal, floating terminal, and Claude panel side panel would freeze while the actual Playwright browser continued working. Root cause: every incoming CDP frame created a new `Image()` for async base64 decode with no backpressure — when frames arrived faster than the browser could decode, Image objects piled up and `onload` callbacks stopped firing permanently. Fixed by replacing the naive per-frame `new Image()` pattern with `createFrameRenderer()` in all three locations: `ui-claude-panel.js:showBrowserEmbed()`, `ui-terminal.js:openBrowserSession()`, and `ui-terminal.js:reconnectBrowserSession()`. Frame renderers are properly destroyed on session close/hide.

### Changed — Server-Side Screencast Backpressure
- **WebSocket write buffer check** — Frame broadcast in `server.js:startScreencast()` now checks `ws.bufferedAmount < 512KB` before sending to each client. Clients with congested write buffers are skipped, preventing server-side frame backlog that contributed to client freezes.
- **Default `everyNthFrame` bumped from 1 to 2** — Both `startScreencast()` and the resize-triggered screencast restart now default to sending every 2nd CDP frame instead of every frame. Halves throughput with minimal visual impact. Config file value (`browser-config.json`) still overrides.

### Changed — Resize Debounce for Browser Sessions
- **200ms debounce on `ResizeObserver`** — Both `openBrowserSession()` and `reconnectBrowserSession()` in `ui-terminal.js` now debounce resize events before sending viewport resize messages to the server, preventing rapid screencast stop/start cycles during window drag-resizing.

## 2026-03-17

### Fixed — Loop Pending-Claim Failure
- **Server-side pending claim** — `attachLoopDriver` now scans for `pending-*.json` files matching its terminal session and writes the `[SynaBun Loop] Begin task.` message directly via `session.pty.write()` when the `>` prompt is detected, bypassing the unreliable client-side `_sendOnceReady` which silently fails when the WebSocket is closed
- **Stale pending cleanup** — `cleanupStaleLoops` in `shared.mjs` now deletes `pending-*.json` files older than `maxMinutes + 5` minutes instead of ignoring them

### Fixed — Loop History Accumulation Breaking State
- **Delete on end/stop** — Loop JSON files are now deleted immediately when a loop finishes (iteration cap, time cap), is force-stopped (API or duplicate launch), or fails (consecutive prompt detection failures) — previously they were marked inactive and lingered in `data/loop/`
- **Stale loops deleted immediately** — `cleanupStaleLoops` now deletes stale and inactive loop files on sight instead of deactivating them or waiting 24 hours
- **History endpoints gutted** — `GET /api/loop/history` returns `[]`, `DELETE /api/loop/history/:id` is a no-op — no loop logging, only actively running loops exist as files
