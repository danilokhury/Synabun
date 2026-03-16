---
category: mcp-tools
tags: [cards, mcp-tool, memory-display, ui, positioning]
importance: 7
project: synabun
source: self-discovered
related_files:
  - mcp-server/src/tools/card.ts
  - mcp-server/src/tools/card-tools.ts
  - neural-interface/server.js
---

# SynaBun Card Tools

Cards are visual memory viewers in the Neural Interface UI. Each card displays a memory's content and can be positioned, resized, and pinned. 5 tools registered via `registerCardTools(server)`.

## Tools

### card_list
List all open cards. No params. Returns: open card details (UUID, position, size, compact/pin state, content preview) + viewport dimensions.

### card_open
Open a memory as a card in the Neural Interface. Params:
- `memoryId` (required): Full UUID of the memory to display
- `coordMode` (optional): "px" | "pct"
- `left`, `top` (optional): Position. Omit for auto-cascade placement
- `compact` (optional): Boolean — open in compact (minimized) mode

### card_close
Close card(s). Params:
- `memoryId` (optional): UUID of card to close. Omit to close ALL cards.

### card_update
Update card properties. Params:
- `memoryId` (required): UUID of the card
- `coordMode` (optional): "px" | "pct"
- `left`, `top`: Reposition
- `width`, `height`: Resize
- `compact` (boolean): Toggle compact mode
- `pinned` (boolean): Toggle pin state

Only specified fields are changed.

### card_screenshot
Take screenshot of all visible cards. No params. Returns base64 JPEG image.

## Use Cases

- Display related memories side-by-side for comparison
- Pin important reference memories during work sessions
- Visual memory exploration alongside the 3D graph
