# Voice Input for Claude Code Sidepanel

## Overview
Add a push-to-talk mic button to the Claude Code sidepanel that uses the browser-native **Web Speech API** (`SpeechRecognition`) to transcribe speech directly into the textarea. No backend changes needed.

## Architecture

**Single-file change:** `neural-interface/public/shared/ui-claude-panel.js` (HTML, CSS, and JS are all co-located in this file).

**How it works:**
1. Mic button sits between the textarea and the send button inside `.cp-input-inner`
2. User holds the mic button → `SpeechRecognition` starts, interim results stream into the textarea in real-time
3. User releases → recognition stops, final transcript stays in textarea for review/edit before sending
4. Existing send flow (Enter key or send button) works unchanged — voice just fills the textarea

## Implementation Steps

### Step 1 — HTML: Add mic button to input area
**Location:** Line 227, inside `.cp-input-inner`, between `#cp-slash-hints` and `#cp-send`

Add a `<button class="cp-mic" id="cp-mic" title="Hold to speak">` with a microphone SVG icon. Hidden by default if browser doesn't support `SpeechRecognition`.

```html
<button class="cp-mic" id="cp-mic" title="Hold to speak">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
    <line x1="12" y1="19" x2="12" y2="23"/>
    <line x1="8" y1="23" x2="16" y2="23"/>
  </svg>
</button>
```

### Step 2 — CSS: Style the mic button + recording state
**Location:** After `.cp-send` styles (~line 1130), add `.cp-mic` styles.

- Default state: same dimensions/style as `.cp-send` (28x28, transparent bg, subtle border)
- `.cp-mic.recording`: red/orange pulsing glow (similar to `.cp-send.abort` style but with a warm amber color)
- `.cp-mic.unsupported`: hidden via `display: none`
- Smooth transitions matching existing button feel

### Step 3 — JS: Web Speech API integration
**Location:** After the existing event listeners section (~line 5313), add voice input logic.

**Initialization:**
```js
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const $mic = _panel?.querySelector('#cp-mic');
if (!SpeechRecognition || !$mic) {
  if ($mic) $mic.classList.add('unsupported');
} else {
  // Set up recognition + push-to-talk handlers
}
```

**Recognition config:**
- `continuous = true` (keep listening while held)
- `interimResults = true` (stream partial results into textarea)
- `lang = 'en-US'` (default, could be made configurable later)

**Push-to-talk events on `$mic`:**
- `mousedown` / `touchstart` → start recognition, add `.recording` class
- `mouseup` / `touchend` / `mouseleave` → stop recognition, remove `.recording` class
- Prevent default on touch events to avoid mobile quirks

**Recognition event handlers:**
- `onresult`: Build transcript from results array. Replace textarea value with: `(pre-existing text before recording) + (current transcript)`. This preserves any text the user typed before holding the mic.
- `onerror`: Remove `.recording` class, log error. If `error === 'not-allowed'`, show brief status message about microphone permission.
- `onend`: Remove `.recording` class. (Safety cleanup in case of unexpected stop.)

**Key details:**
- Store the textarea's value at `mousedown` time as `_voicePrefix` so we can append to existing text
- On each `onresult`, set `$input.value = _voicePrefix + transcript` and call `autoResize()`
- Dispatch `input` event on textarea after setting value so send button enables properly
- On `mouseup`, the final transcript stays — user can edit or just hit Enter/send

### Step 4 — Send button state awareness
Dispatch an `input` event on the textarea after voice sets its value, so the existing input listener that enables/disables `#cp-send` fires correctly.

### Step 5 — Cleanup on tab deactivate
Add a `visibilitychange` listener to stop any active recognition when the user switches tabs, preventing orphaned sessions.

## File Changes Summary

| File | Changes |
|------|---------|
| `neural-interface/public/shared/ui-claude-panel.js` | HTML: mic button in `.cp-input-inner` |
| | CSS: `.cp-mic` default + `.recording` + `.unsupported` styles |
| | JS: SpeechRecognition init, push-to-talk handlers, result streaming |

## Edge Cases
- **Unsupported browser:** Mic button hidden entirely (`.unsupported { display: none }`)
- **Microphone denied:** `onerror` with `not-allowed` → brief status toast, button stays visible for retry
- **Double-tap/rapid toggle:** Guard with `_voiceActive` flag to prevent overlapping recognition sessions
- **Tab switching:** Stop recognition on `visibilitychange` to avoid orphaned sessions
- **Existing text in textarea:** Preserved — voice appends after it with a space separator
