# Fix: Plan System Broken in Sidepanel Claude Skin

## Root Cause Analysis

The "PLAN COMPLETE" action card (Accept / Compact / Edit buttons) never renders because `buildTool()` doesn't set `dataset.toolName` on regular tool cards. When `updateToolResult()` fires for ExitPlanMode, it reads `card.dataset.toolName` which is always empty — the `=== 'ExitPlanMode'` check silently fails every time.

## Bugs to Fix

### Bug 1 — `dataset.toolName` missing in `buildTool()` (CRITICAL)
**File**: `neural-interface/public/shared/ui-claude-panel.js`
**Line**: ~4031

`buildTool()` sets `card.dataset.toolId` but never `card.dataset.toolName`. Meanwhile `updateToolResult()` (line 4076) depends on `card.dataset.toolName` to detect ExitPlanMode and trigger `renderPostPlanActions()`.

**Fix**: Add `card.dataset.toolName = block.name;` after line 4031 (`card.dataset.toolId = block.id || ''`).

This one-line fix restores:
- "PLAN COMPLETE" card rendering after ExitPlanMode succeeds
- Accept/Continue with implementation button
- Compact context button
- Edit plan button

### Bug 2 — Server hook matcher is stale
**File**: `neural-interface/server.js`
**Line**: ~7358

The hook config in server.js has `matcher: '^ExitPlanMode$'` but the actual `~/.claude/settings.json` uses `'^(Enter|Exit)PlanMode$'`. If the server ever re-registers hooks, it would drop the EnterPlanMode context injection.

**Fix**: Update the matcher in server.js to `'^(Enter|Exit)PlanMode$'` to match settings.json.

### Bug 3 — No `toolName` on ANY regular tool card
Same fix as Bug 1 — adding `card.dataset.toolName = block.name` in `buildTool()` sets it for all regular tools (Edit, Read, Bash, Glob, Grep, etc.), not just ExitPlanMode. Future logic that needs to identify tool cards by name will work correctly.

## Implementation

Two edits total:
1. `ui-claude-panel.js` line ~4031: add `card.dataset.toolName = block.name;`
2. `server.js` line ~7358: change matcher from `'^ExitPlanMode$'` to `'^(Enter|Exit)PlanMode$'`
