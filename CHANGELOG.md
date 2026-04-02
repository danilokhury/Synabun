# SynaBun Changelog

Raw internal changelogs are archived in [changelog/](changelog/).

## 2026-04-01

### Added — Copy Button on Code Blocks in Claude Sidepanel
- **`addCopyButtons(el)` function** — Every `<pre>` block in assistant messages now has a "Copy" button in the top-right corner. Clicking copies the block's text content to clipboard via `navigator.clipboard.writeText()`, shows "Copied!" feedback for 1.5s with green accent
- **CSS: `.cp-copy-btn`** — Absolute-positioned button, JetBrains Mono 9px uppercase, always visible at 0.6 opacity, brighter on hover with subtle background. Added `position: relative` to `.cp-messages .msg-body pre`
- **Wired at 7 final render points** — `loadSessionHistory()`, `message_stop`, `content_block_stop`, `renderAssistant` (3 paths), and plan card body. Excluded from throttled 32ms streaming render to avoid flicker

### Fixed — Edit Plan Shows Wrong Content (Streaming Dedup Path)
- **Eager capture in wrong code path** — `extractPlanText(tab)` eager capture was placed in the new-message branch of `renderAssistant()`, but streaming always routes through the dedup branch via `handleStreamDelta()` — the capture was dead code. Added eager capture to the dedup path (line ~3723) where `tab._exitPlanPending` is set and the plan `.msg-body` already exists in the DOM. Third fix attempt over 6 days — all prior attempts targeted the correct function but the wrong branch
