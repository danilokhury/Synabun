# SynaBun Manual QA Checklist — Part 2

Covers CHANGELOG entries **March 17-27, 2026**.
Sections 6-10: Terminal, Whiteboard, Settings & UI, Visual/CSS, Leonardo & Integrations.

---

## 6. Terminal (5 tests)

### 6.1 Context Menu Z-Index
**Ref:** 2026-03-25 — Fixed terminal context menu layering

- [ ] **6.1a** Right-click in terminal after 100+ focus interactions — context menu renders ABOVE terminal panel (z-index 100003 vs terminal's ~10100+)

### 6.2 Viewport Clamping
**Ref:** 2026-03-25 — Changed context menu clamping

- [ ] **6.2a** Right-click near bottom-right corner of screen — menu flips above cursor (if too close to bottom) and shifts left (if too close to right edge). Never renders off-screen

### 6.3 Image Paste to PTY
**Ref:** 2026-03-19 — Fixed image paste not inserting

- [ ] **6.3a** Paste an image in terminal — saved image path is BOTH copied to clipboard AND inserted at the PTY cursor (typed into the shell)

### 6.4 Clipboard LAN Fallback
**Ref:** 2026-03-19 — Fixed clipboard in non-secure contexts

- [ ] **6.4a** Access Neural Interface via LAN IP (not localhost) — copy operations still work (falls back to hidden textarea + `execCommand('copy')`)

### 6.5 Resize Debounce
**Ref:** 2026-03-18 — Changed resize debounce

- [ ] **6.5a** Rapidly resize browser window — viewport resize messages debounced at 200ms (no rapid stop/start screencast cycles)

---

## 7. Whiteboard (7 tests)

### 7.1 List Persist on Reload
**Ref:** 2026-03-27 — Fixed list items lost on reload

- [ ] **7.1a** Create list element, add items, reload page — list content preserved (not empty `['']`). Also verify: click canvas, click another element, switch tools — list content still saved

### 7.2 Move Handle
**Ref:** 2026-03-23 — Added floating move handle

- [ ] **7.2a** Select a text or list element — move handle (4-way arrow) appears on the left side. Drag it to move the element. Content is saved before drag starts

### 7.3 Shape Picker
**Ref:** 2026-03-20 — Added shape picker submenu

- [ ] **7.3a** Select shape tool — picker flyout shows Rectangle, Circle, Triangle. Select triangle — draw on canvas creates triangle shape

### 7.4 Circle as Ellipse
**Ref:** 2026-03-20 — Fixed circle rendering

- [ ] **7.4a** Draw a circle shape — renders as smooth ellipse (SVG arc), NOT as visible polygon with straight segments

### 7.5 Context Menu Z-Index
**Ref:** 2026-03-20 — Fixed context menu behind images

- [ ] **7.5a** Create 20+ elements. Select one near the bottom of the stack — context menu and rotate handle render ABOVE all other elements (dynamic z-index)

### 7.6 Send to Terminal Fallback
**Ref:** 2026-03-19 — Fixed session lookup

- [ ] **7.6a** With no explicitly active terminal pane, "Send to Terminal" from whiteboard — falls back to first session with open WebSocket (or shows toast if none available)

### 7.7 Move Handle Positioning
**Ref:** 2026-03-23 — Enhanced positioning for auto-sized elements

- [ ] **7.7a** Select a text element with auto-size (no explicit width) — move handle, rotate handle, and context menu positioned correctly using actual DOM dimensions

---

## 8. Settings & UI (8 tests)

### 8.1 Recall Profile Presets
**Ref:** 2026-03-27 — Changed recall presets modernized

- [ ] **8.1a** Settings > Memory — 4 profile cards (Quick/Balanced/Deep/Custom) with distinct SVG icons. Mouse-tracking radial glow on hover. Active card shows oversized background watermark icon

### 8.2 Recall Settings Redesign
**Ref:** 2026-03-25 — Changed recall settings

- [ ] **8.2a** Settings > Recall tab — 4 profiles auto-configure all params. Manually adjusting any control auto-switches to Custom. Fine-Tune Controls section with 6 parameters (results, importance, similarity, content length, session context, recency boost)
- [ ] **8.2b** Impact indicator shows: estimated tokens per recall, memories reachable, session context status

### 8.3 Notifications Tab
**Ref:** 2026-03-24 — Added notifications settings

- [ ] **8.3a** Settings > Notifications tab exists (bell icon, between Terminal and Browser). Has: master toggle, system permission status with color dot, sound toggle + volume slider + test button, banner toggle, action-only filter, Test Notification button

### 8.4 Safari PWA Notifications
**Ref:** 2026-03-24 — Fixed notifications in Safari PWA

- [ ] **8.4a** In Safari PWA: notifications work via `serviceWorker.postMessage()` → `showNotification()` flow (not `new Notification()`)

### 8.5 Database Tab Polish
**Ref:** 2026-03-19 — Changed database tab visuals

- [ ] **8.5a** Settings > Database — sections wrapped in card containers (`.stg-section`), stats in 2-column grid tiles, reindex progress uses CSS classes (not inline styles), embedding model info in footer

### 8.6 Token Estimation
**Ref:** 2026-03-26 — Changed recall token estimation accuracy

- [ ] **8.6a** Recall impact indicator uses char-to-token ratio of 1:3.7 (not 1:4), actual DB averages for tags/files (not flat +30), session chunks with 0.6x multiplier for auto mode

### 8.7 Window Borders
**Ref:** 2026-03-24 — Changed floating window borders

- [ ] **8.7a** All 8 floating window types (Settings, Skills, AS, Session Monitor, Command Runner, Image Gallery, Detail Card, Whiteboard) have visible `1px solid rgba(255,255,255,0.12)` border. Borders persist when file explorer is open

### 8.8 Window Close Behavior
**Ref:** 2026-03-22 — Changed ESC/close only

- [ ] **8.8a** Click backdrop overlay on any window — window does NOT close. Close only via ESC key or close button
- [ ] **8.8b** ESC works on: Automation Studio, Skills Studio, Settings, Keybinds, Session Monitor, Image Gallery, Help, Terminal dir picker

---

## 9. Visual / CSS (9 tests)

### 9.1 Toolbar Modernization
**Ref:** 2026-03-25 — Changed unified glass bars

- [ ] **9.1a** Top navbar: single continuous frosted glass pill (not separate group containers). Groups separated by thin dividers. Bottom toolbar: same unified pill treatment
- [ ] **9.1b** Hover: subtle `scale(1.08)` + radial glow. Active: 6px glowing blue dot. Press: `scale(0.94)`

### 9.2 Window Header Modernization
**Ref:** 2026-03-27 — Changed 13+ window headers

- [ ] **9.2a** All window headers have: gradient background, softer borders (`rgba(255,255,255,0.04)`), lighter title weight (500), ghost action buttons, red-tint close hover

### 9.3 Focus Buttons Removed
**Ref:** 2026-03-27 — Removed focus buttons + badge

- [ ] **9.3a** No `.as-focus-btn`, `.ss-focus-btn`, `.stg-focus-btn` in any window. No `.as-active-badge` in AS header

### 9.4 Page Margins
**Ref:** 2026-03-27 — Changed unified margins

- [ ] **9.4a** Claude panel and workspace toolbar `top` uses `calc(var(--navbar-height, 48px) + 20px)`. Right/bottom margins are 20px

### 9.5 Backdrop Toggle
**Ref:** 2026-03-22 — Added backdrop toggle button

- [ ] **9.5a** Eye icon button in every window header. Click toggles backdrop in/out with smooth fade. Button highlights when backdrop hidden

### 9.6 Offline Page
**Ref:** 2026-03-24 — Changed offline page to transparent

- [ ] **9.6a** Offline page: no card background or border. Command block transparent. Content floats on `#030305` body

### 9.7 Editor Line Highlight
**Ref:** 2026-03-24 — Fixed line highlight drift

- [ ] **9.7a** Open code editor, scroll past 15+ lines — highlight band stays aligned with text and gutter (no sub-pixel drift). `line-height` is explicit `20px`

### 9.8 Dropdown Z-Index
**Ref:** 2026-03-25 — Fixed dropdowns behind tray

- [ ] **9.8a** With minimized terminal pills in tray: open workspace/bookmarks/invite dropdown — dropdown renders ABOVE the tray pills

### 9.9 Focus Glow
**Ref:** 2026-03-19 — Changed focus mode gradient

- [ ] **9.9a** Focus mode glow: 600x600px multi-layered, `::before` inner core, 6s cycle, `translate(-50%, -50%)` centering. Tracks sidebar/panel width changes

---

## 10. Leonardo & Integrations (5 tests)

### 10.1 Leonardo Browser-Only
**Ref:** 2026-03-22 — Converted to 100% browser-based

- [ ] **10.1a** No `LEONARDO_API_KEY` required. Only 4 browser tools: `leonardo_browser_navigate`, `leonardo_browser_generate`, `leonardo_browser_library`, `leonardo_browser_download`
- [ ] **10.1b** `/leonardo` skill references browser workflow (no API key prerequisite). `browser-guide.md` contains full UI map

### 10.2 LinkedIn Jobs Extractor
**Ref:** 2026-03-22 — Added browser_extract_li_jobs

- [ ] **10.2a** Navigate to LinkedIn Jobs search page. Call `browser_extract_li_jobs` — returns structured data with: jobId, title, company, companyUrl, location, salary, jobUrl, logo, promoted, easyApply, postedDate

### 10.3 browser_content Markdown Format
**Ref:** 2026-03-19 — Changed format parameter

- [ ] **10.3a** Call `browser_content` with `format: "markdown"` — returns structured content with headings, links, lists preserved (not just plain text)

### 10.4 Screenshot Cross-Platform
**Ref:** 2026-03-19 — Fixed macOS-only screenshot watcher

- [ ] **10.4a** On macOS: screenshot watcher checks `com.apple.screencapture location` with Desktop fallback. Code has Windows and Linux path blocks (verify in source: `server.js` screenshot watcher section)

### 10.5 Images in data/images/
**Ref:** 2026-03-19 — Fixed temp file permission errors

- [ ] **10.5a** All image save paths use `data/images/` (not `os.tmpdir()`): Claude skin attachments (`synabun-img-*`), terminal paste (`synabun-paste-*`), whiteboard drag-drop (`synabun-wbimg-*`). 24h cleanup sweep runs on boot

---

## Summary

| Section | Tests | Area |
|---------|-------|------|
| 1. Server API & Backend | 18 | Part 1 |
| 2. Hook System | 12 | Part 1 |
| 3. Claude Panel | 14 | Part 1 |
| 4. Automation Studio | 10 | Part 1 |
| 5. Browser / Screencast | 12 | Part 1 |
| 6. Terminal | 5 | Part 2 |
| 7. Whiteboard | 7 | Part 2 |
| 8. Settings & UI | 8 | Part 2 |
| 9. Visual / CSS | 9 | Part 2 |
| 10. Leonardo & Integrations | 5 | Part 2 |
| **Total** | **100** | |
