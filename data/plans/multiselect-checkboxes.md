# Plan: Multi-Select Checkbox Visual Distinction for AskUserQuestion

## Problem
When Claude asks questions with `multiSelect: true`, the UI renders identical radio-circle indicators as single-select questions. Users have no visual cue that multiple selections are allowed, so they treat every question as single-select.

## Scope
- **CSS**: Visual checkbox indicator for multi-select questions (both UIs)
- **JS**: Apply distinguishing class + "Select all that apply" hint (both UIs)
- **Rulesets**: General multiSelect rule in CLAUDE-template.md + CLAUDE.md + all 4 condensed rulesets
- **Propagation**: Settings "Copy Ruleset" button + Onboarding Step 6 auto-inherit via `/api/claude-code/ruleset`

No skill-specific annotations — Claude decides autonomously per question.

---

## Changes

### 1. Sidepanel CSS (`ui-claude-panel.js` inline styles, ~line 608-637)

The existing `.ask-option::before` renders a circle (radio button) with `border-radius: 50%`. Add overrides when parent `.ask-options` has class `multi`:

```css
/* Multi-select: square checkbox instead of circle radio */
.ask-options.multi .ask-option::before {
  border-radius: 3px;
}
.ask-options.multi .ask-option.selected::before {
  border-radius: 3px;
}
/* "Select all that apply" hint */
.ask-multi-hint {
  font-size: 9px; color: rgba(100,160,255,0.4);
  font-family: 'JetBrains Mono', monospace;
  font-style: italic; margin-bottom: 4px;
}
```

### 2. Standalone CSS (`claude-chat.css` ~line 672-690)

The standalone `.ask-option` has NO `::before` pseudo-element — no radio/checkbox indicator at all. Add both:

```css
/* Base radio indicator (parity with sidepanel) */
.ask-option {
  /* add to existing: */ flex-direction: row; align-items: flex-start; gap: 10px;
}
.ask-option::before {
  content: '';
  width: 14px; height: 14px; flex-shrink: 0; margin-top: 2px;
  border: 1.5px solid rgba(255,255,255,0.15); border-radius: 50%;
  transition: all 0.15s;
}
.ask-option:hover:not(:disabled)::before {
  border-color: rgba(100,160,255,0.4);
}
.ask-option.selected::before {
  border-color: rgba(100,160,255,0.8);
  background: rgba(100,160,255,0.8);
  box-shadow: inset 0 0 0 2px rgba(14,14,18,0.85);
}
/* Multi-select: square checkbox */
.ask-options.multi .ask-option::before { border-radius: 3px; }
.ask-options.multi .ask-option.selected::before { border-radius: 3px; }
/* Hint */
.ask-multi-hint {
  font-size: 10px; color: rgba(100,160,255,0.45);
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-style: italic; margin-bottom: 4px;
}
```

Also update `.ask-option` from `flex-direction: column` to `row` + wrap label+desc in a column div (matching sidepanel structure).

### 3. Sidepanel JS — `renderAskUserQuestion()` (`ui-claude-panel.js` ~line 4291)

After `opts.className = 'ask-options';` add:
```js
if (isMultiSelect) opts.classList.add('multi');
```

Before appending opts to card, insert hint:
```js
if (isMultiSelect) {
  const hint = document.createElement('div');
  hint.className = 'ask-multi-hint';
  hint.textContent = 'Select all that apply';
  card.appendChild(hint);
}
```

### 4. Sidepanel JS — `buildAskFromToolUse()` (`ui-claude-panel.js` ~line 3612)

Same treatment as #3 — add `multi` class to `opts` + hint element when `isMultiSelect`.

### 5. Standalone JS — `renderAskUserQuestion()` (`claude-chat.js` ~line 774)

Same treatment — add `multi` class to `opts` + hint element when `isMultiSelect`.

### 6. Rulesets — CLAUDE-template.md + CLAUDE.md + Condensed

**Source of truth** (`neural-interface/templates/CLAUDE-template.md`):

Add new sub-section after `### Plan Mode (MANDATORY)` (line 74), before the `---` separator:

```markdown
### Multi-Select Questions

When using `AskUserQuestion`, set `multiSelect: true` when options are NOT mutually exclusive — i.e., the user could reasonably want more than one. Examples: selecting multiple features, tags, effects, or follow-up actions. Keep single-select (default) for inherently exclusive choices (one model, one style, one dimension).
```

**Project root** (`CLAUDE.md`):

Same addition — after `### Plan Mode (MANDATORY)` section. This file takes priority in the ruleset API, so it must match.

**All 4 condensed rulesets** (Cursor, Generic, Gemini, Codex in both files):

Add one-liner to each:
```
- AskUserQuestion: use multiSelect: true when options aren't mutually exclusive (multiple tags, features, effects, actions).
```

This one-liner goes after the existing plan mode line in each condensed ruleset.

### Propagation

No changes to onboarding or Settings code — both call `GET /api/claude-code/ruleset` which reads the updated files:
- Settings "Copy Ruleset" → serves updated text
- Onboarding Step 6 → serves updated text
- All formats (claude, cursor, generic, gemini, codex) → automatically include the new line

---

## Files Modified (5 total)

| File | What Changes |
|------|-------------|
| `neural-interface/public/shared/ui-claude-panel.js` | CSS: checkbox `.multi` overrides + hint. JS: `multi` class + hint in 2 render paths |
| `neural-interface/public/claude-chat.css` | CSS: add `::before` radio indicator + `.multi` checkbox override + hint |
| `neural-interface/public/claude-chat.js` | JS: `multi` class + hint in 1 render path |
| `neural-interface/templates/CLAUDE-template.md` | multiSelect section + one-liner in all 4 condensed rulesets |
| `CLAUDE.md` | Same multiSelect section + one-liner in all 4 condensed rulesets (must match template) |

## What This Does NOT Change
- No skill file modifications (user chose "general rule only")
- No changes to AskUserQuestion tool schema (already supports `multiSelect`)
- No backend/server changes (purely frontend + instruction)
- No onboarding/settings UI code changes (auto-inherits from updated rulesets)
