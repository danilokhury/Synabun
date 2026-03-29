# Fix Edit Plan Re-prompting Flow

## Problem
After user saves an edited plan, the `plan-saved` handler auto-sends "Proceed with implementation" to Claude. User never gets a chance to review the edited plan or choose what to do next.

## Solution
UI-driven iterative editing loop. On save, render the updated plan + 3-button card in chat (no Claude message). Claude only receives the full plan when user clicks "Implement".

## Changes — `ui-claude-panel.js`

### 1. Rewrite `plan-saved` handler (lines 6117-6136)

Current: removes cards, exits plan mode, sends implementation prompt to Claude.

New behavior:
- Remove old post-plan cards
- Store updated content: `tab._editedPlanContent = content`
- Update `tab.planFilePath = filePath`
- Render a synthetic assistant message showing the updated plan as rendered markdown (using `md()`)
- Call `renderPostPlanActions(tab, 'PLAN UPDATED')` to show the 3 buttons again
- Do NOT send anything to Claude
- Do NOT change plan mode toggle state

### 2. Update `renderPostPlanActions` signature (line 3455)

- Add optional `headerText` parameter: `function renderPostPlanActions(tab, headerText)`
- Default to `'PLAN COMPLETE'` when not provided
- Use `headerText` in the header element instead of hardcoded string

### 3. Update "Continue with implementation" action (lines 3538-3549)

Current prompt: `'Continue with the implementation based on the approved plan.'`

New logic:
- If `tab._editedPlanContent` exists, build prompt with full plan text:
  `"The user has reviewed and approved this updated plan:\n\n${tab._editedPlanContent}\n\nProceed with implementation."`
- Then `delete tab._editedPlanContent`
- Otherwise keep current generic prompt as fallback

## Files touched
- `neural-interface/public/shared/ui-claude-panel.js` — 3 edits

## Not changed
- `ui-file-explorer.js` — save/emit flow works correctly
- Server endpoints — no changes needed
- `post-plan.mjs` hook — not involved in edit flow
