# Queue Message System — SynaBun Sidepanel

## Overview

Add a per-tab message queue to the Claude Code sidepanel. Users queue multiple messages; Claude processes them sequentially (FIFO). Queue lives as a collapsible tray above the input area with full management (drag reorder, edit, remove, pause/resume). Persists via localStorage.

---

## File: `neural-interface/public/shared/ui-claude-panel.js`

This is the only file that needs changes. All CSS is inline in this file.

---

## Step 1 — Tab State Extension

In `createTab()` (~line 1919), add three new fields to the tab object:

```javascript
queue: [],            // Array of { id, text, images, files }
queuePaused: false,   // pause/resume toggle
queueExpanded: false,  // tray collapsed/expanded
```

---

## Step 2 — Persistence in saveTabs / restoreTabs

**`saveTabs()` (~line 2167):** Add `queue` and `queuePaused` to the serialized tab state:

```javascript
queue: t.queue || [], queuePaused: t.queuePaused || false
```

**`restoreTabs()` (~line 2212):** Restore queue fields when recreating tabs:

```javascript
if (t && saved.queue) t.queue = saved.queue;
if (t && saved.queuePaused) t.queuePaused = true;
```

---

## Step 3 — Queue Tray DOM

In `buildPanel()` (~line 163), inject the queue tray **inside `.cp-bottom`**, before `.cp-project-bar` (line 214):

```html
<div class="cp-queue-tray" id="cp-queue-tray" hidden>
  <div class="cp-queue-header">
    <button class="cp-queue-expand" title="Expand queue">
      <svg viewBox="0 0 16 16" width="10" height="10"><polyline points="4 6 8 10 12 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
    </button>
    <span class="cp-queue-title">Queue</span>
    <span class="cp-queue-count">0</span>
    <div class="cp-queue-actions">
      <button class="cp-queue-pause" title="Pause queue processing">
        <svg viewBox="0 0 16 16" width="10" height="10"><rect x="3" y="3" width="3" height="10" fill="currentColor"/><rect x="10" y="3" width="3" height="10" fill="currentColor"/></svg>
      </button>
      <button class="cp-queue-clear" title="Clear all queued">
        <svg viewBox="0 0 16 16" width="10" height="10"><line x1="4" y1="4" x2="12" y2="12" stroke="currentColor" stroke-width="2"/><line x1="12" y1="4" x2="4" y2="12" stroke="currentColor" stroke-width="2"/></svg>
      </button>
    </div>
  </div>
  <div class="cp-queue-items"></div>
</div>
```

---

## Step 4 — Queue Tray CSS

Add styles in `injectStyles()` (~line 253). Design language matches the existing panel aesthetic (glass, subtle borders, compact):

```css
/* ── Queue tray ── */
.cp-queue-tray {
  margin: 0 8px;
  border-radius: 10px;
  background: rgba(255,255,255,0.03);
  border: 0.5px solid rgba(255,255,255,0.06);
  overflow: hidden;
  transition: max-height 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}
.cp-queue-tray[hidden] { display: none; }

.cp-queue-header {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 8px;
  cursor: pointer;
  user-select: none;
}
.cp-queue-title {
  font-size: 10px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.5px;
  color: rgba(255,255,255,0.5);
  flex: 1;
}
.cp-queue-count {
  font-size: 10px; font-weight: 700;
  color: rgba(120,180,255,0.9);
  background: rgba(120,180,255,0.12);
  padding: 1px 6px; border-radius: 8px;
  min-width: 16px; text-align: center;
}
.cp-queue-actions { display: flex; gap: 2px; }
.cp-queue-actions button {
  background: none; border: none; color: rgba(255,255,255,0.4);
  cursor: pointer; padding: 2px 4px; border-radius: 4px;
  transition: color 0.15s, background 0.15s;
}
.cp-queue-actions button:hover {
  color: rgba(255,255,255,0.8);
  background: rgba(255,255,255,0.06);
}
.cp-queue-expand {
  background: none; border: none; color: rgba(255,255,255,0.3);
  cursor: pointer; padding: 2px; transition: transform 0.2s;
}
.cp-queue-tray.expanded .cp-queue-expand { transform: rotate(180deg); }

/* Pause active state */
.cp-queue-pause.paused { color: rgba(255,180,60,0.9); }

/* Queue items container */
.cp-queue-items {
  max-height: 0; overflow: hidden;
  transition: max-height 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  padding: 0 6px;
}
.cp-queue-tray.expanded .cp-queue-items {
  max-height: 200px; overflow-y: auto;
  padding-bottom: 6px;
}

/* Individual queue item */
.cp-queue-item {
  display: flex; align-items: center; gap: 4px;
  padding: 4px 6px;
  margin-top: 3px;
  background: rgba(255,255,255,0.03);
  border: 0.5px solid rgba(255,255,255,0.05);
  border-radius: 6px;
  font-size: 11px; color: rgba(255,255,255,0.7);
  cursor: grab;
  transition: background 0.15s, border-color 0.15s;
}
.cp-queue-item:hover {
  background: rgba(255,255,255,0.06);
  border-color: rgba(255,255,255,0.1);
}
.cp-queue-item.dragging { opacity: 0.4; background: rgba(120,180,255,0.08); }
.cp-queue-item.drag-over { border-color: rgba(120,180,255,0.4); border-style: dashed; }

.cp-queue-drag {
  color: rgba(255,255,255,0.2); cursor: grab;
  font-size: 10px; user-select: none; flex-shrink: 0;
}
.cp-queue-text {
  flex: 1; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; min-width: 0;
}
.cp-queue-text input {
  width: 100%; background: rgba(0,0,0,0.3);
  border: 1px solid rgba(120,180,255,0.3);
  border-radius: 4px; color: #fff; font-size: 11px;
  padding: 2px 4px; outline: none;
}
.cp-queue-item button {
  background: none; border: none;
  color: rgba(255,255,255,0.3); cursor: pointer;
  padding: 1px 3px; border-radius: 3px; flex-shrink: 0;
  font-size: 10px; transition: color 0.15s;
}
.cp-queue-item button:hover { color: rgba(255,255,255,0.8); }
.cp-queue-remove:hover { color: rgba(255,100,100,0.9) !important; }

.cp-queue-attach-badge {
  font-size: 9px; color: rgba(120,180,255,0.7); flex-shrink: 0;
}
```

---

## Step 5 — Core Queue Functions

Add new functions after the existing `send()` function (~line 4750):

### `addToQueue(tab, text, images, files)`
- Creates entry: `{ id: crypto.randomUUID(), text, images: images || null, files: files || null }`
- Pushes to `tab.queue`
- Calls `renderQueue(tab)` and `saveTabs()`
- If queue was empty and Claude is idle and not paused: auto-start processing via `advanceQueue(tab)`

### `renderQueue(tab)`
- Only renders for the active tab
- Shows/hides tray based on `tab.queue.length`
- Updates count badge
- Renders each queue item as a card in `.cp-queue-items`
- Attaches drag handlers, edit/remove click handlers
- Preserves expanded/collapsed state

### `advanceQueue(tab)`
- Guard: if `tab.queue.length === 0 || tab.queuePaused || tab.running || tab._activePerm || tab.pendingAsk` — return
- Shift first item from `tab.queue`
- Short delay (300ms) for visual feedback
- Internally send the message using `_sendQueued(tab, item)`
- Re-render queue tray
- Save tabs

### `_sendQueued(tab, item)`
- Internal function that mirrors the `send()` flow (lines 4715-4749) but takes text/images/files from the queue item instead of the input field
- Calls `appendUser()`, `showThinking()`, `setRunning()`, builds prompt, sends via WebSocket
- Does NOT read from `#cp-input` — uses item data directly
- Respects `tab.planMode` (wraps prompt with plan prefix if active)

### `pauseQueue(tab)` / `resumeQueue(tab)`
- Toggles `tab.queuePaused`
- Updates pause button icon (pause bars / play triangle)
- If resuming and Claude is idle: call `advanceQueue(tab)`
- Save tabs

### `removeFromQueue(tab, id)`
- Filters out item by id from `tab.queue`
- Re-renders, saves

### `editQueueItem(tab, id)`
- Replaces `.cp-queue-text` span content with an `<input>` pre-filled with current text
- On Enter or blur: saves edited text back to `tab.queue[idx].text`, re-renders
- On Escape: cancels edit

### `clearQueue(tab)`
- Empties `tab.queue`, re-renders, saves

---

## Step 6 — Drag-to-Reorder

HTML5 drag and drop on `.cp-queue-item` elements:

- `dragstart`: Set `dragging` class, store source index in `dataTransfer`
- `dragover`: preventDefault, add `drag-over` class to target
- `dragleave`: Remove `drag-over` class
- `drop`: Reorder `tab.queue` array (splice source to target position), re-render, save
- `dragend`: Clean up classes

---

## Step 7 — Input Integration

### Keyboard behavior change (while `tab.running`)
In the existing `keydown` handler for `#cp-input` and `send()`:

- **Enter** (while running + has text): **Add to queue** instead of triggering /btw. This is the default action.
- **Shift+Enter** (while running + has text): **Trigger /btw** (abort current + send new). The deliberate interrupt action.
- **Enter** (while NOT running): Send immediately (unchanged existing behavior)
- **Enter** (while running + empty): Abort (unchanged existing behavior)
- Show a brief visual flash on the queue tray to confirm addition

### Send button visual states (while running)
- Default (no modifier): Send icon morphs to a **queue icon** (stacked lines) to signal "queues by default"
- When Shift is held down: Icon morphs to the existing **interrupt/btw arrow** to signal "will abort + send"
- When input is empty: Shows **stop icon** (unchanged)

### Implementation in `send()` (~line 4683)
Replace the current /btw block:
```javascript
// OLD: if (tab.running && txt) → /btw
// NEW: if (tab.running && txt && !shift) → addToQueue(tab, txt, images, files)
//      if (tab.running && txt && shift)  → /btw (existing abort+send)
```

The `send()` function needs a parameter to know if Shift was held. Pass it from the keydown handler: `send(e)` or `send({ shift: true })`.

---

## Step 8 — Auto-Advance on Done/Aborted

### `done` handler (~line 2957):
After `finishTab(tab)`:
```javascript
// Queue: auto-advance to next message
if (tab.queue.length > 0 && !tab.queuePaused) {
  setTimeout(() => advanceQueue(tab), 300);
}
```

### `aborted` handler (~line 2964):
After existing `/btw` logic — only advance queue if there's no `/btw` pending:
```javascript
if (!tab._btwPending && tab.queue.length > 0 && !tab.queuePaused) {
  setTimeout(() => advanceQueue(tab), 300);
}
```

---

## Step 9 — Permission Pause Integration

No special handling needed. The `advanceQueue()` guard checks `tab._activePerm` and `tab.pendingAsk`. Permissions pause the queue naturally. When the turn completes (`done` event), `advanceQueue` is called and proceeds if all blocking conditions are cleared.

---

## Step 10 — Tab Switch Sync

In `switchTab()` (~line 1991): After restoring draft and UI state, call `renderQueue(tab)` to update the queue tray to reflect the new active tab's queue.

---

## Step 11 — Visual Feedback

- Queue item briefly highlights (border flash) before being sent and removed from tray
- Queue count badge pulses animation on item add
- Paused state: count badge turns amber
- When queue empties after processing: append status message "Queue complete" to chat via `appendStatus(tab, 'Queue complete')`

---

## Interaction Summary

| User Action | Context | Result |
|---|---|---|
| Type + Enter | Not running | Send immediately (existing behavior) |
| Type + Enter | Running | **Add to queue** (new default) |
| Type + Shift+Enter | Running | /btw — abort current + send new (interrupt) |
| Enter (empty) | Running | Abort current task (unchanged) |
| Queue tray header click | — | Toggle expand/collapse |
| Drag item | — | Reorder queue |
| Click edit icon | — | Inline edit message text |
| Click remove icon | — | Remove from queue |
| Click pause button | — | Pause/resume auto-processing |
| Click clear button | — | Clear entire queue |
| Claude finishes a turn | Queue not empty | Auto-send next queued item (if not paused) |
| Permission prompt appears | Queue running | Queue waits; resumes after resolution + turn completion |
| Shift+Enter /btw | Queue running | /btw takes priority; queue advances after |

---

## Edge Cases

1. **Tab switch while queue runs**: Queue continues processing — it's per-tab, runs via the tab's WebSocket regardless of which tab is visible
2. **Page refresh**: Queue restores from localStorage; if Claude was mid-message, orphan reattach handles the running message, then queue advances on completion
3. **Empty send (abort) while queue runs**: Aborts current queued message; queue advances to next (unless paused)
4. **AskUserQuestion during queued message**: Queue pauses (pendingAsk blocks advanceQueue), user answers, turn completes, queue advances
5. **All tabs closed**: Queue is lost (tab is destroyed). Same as existing tab behavior
6. **Queue + plan mode**: Queued messages inherit the tab's current planMode state — each queued message sent with plan prefix if planMode is active
