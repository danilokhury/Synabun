---
category: mcp-tools
tags: [whiteboard, canvas, mcp-tool, visualization, elements]
importance: 7
project: synabun
source: self-discovered
related_files:
  - mcp-server/src/tools/whiteboard.ts
  - mcp-server/src/tools/whiteboard-tools.ts
  - neural-interface/server.js
---

# SynaBun Whiteboard Tools

A persistent 2D whiteboard canvas accessible via MCP tools. Elements are rendered in the Neural Interface UI. 5 tools registered via `registerWhiteboardTools(server)`.

## Tools

### whiteboard_read
Read current whiteboard state. No params. Returns: element descriptions with spatial bounds, viewport dimensions. Elements: text, shape, arrow, pen, list, image.

### whiteboard_add
Add elements to the whiteboard. Params:
- `elements` (required): Array of element objects:
  - `type`: "text" | "shape" | "arrow" | "pen" | "list" | "image"
  - `x`, `y`: Position coordinates
  - `width`, `height`: Dimensions
  - `content`: Text content (for text/shape)
  - `items`: Array of strings (for list type)
  - `ordered`: Boolean (for list type)
  - `fontSize`, `color`, `bold`, `italic`: Styling
  - `shape`: "rectangle" | "circle" | "diamond" | etc. (for shape type)
  - `points`: Array of {x, y} (for pen/arrow)
  - `startAnchor`, `endAnchor`: Element IDs (for arrow connections)
  - `strokeWidth`, `rotation`: Numeric properties
  - `url`: Image URL (for image type)
- `coordMode` (optional): "px" | "pct" — pixel or percentage-based coordinates
- `layout` (optional): "row" | "column" | "grid" | "center" — auto-layout elements

Returns: Assigned element IDs.

### whiteboard_update
Update an existing element. Params:
- `id` (required): Element ID
- `updates`: Partial element fields (only specified fields change)
- `coordMode` (optional): "px" | "pct"

### whiteboard_remove
Remove element(s). Params:
- `id` (optional): Element ID to remove. Omit to clear entire whiteboard.

### whiteboard_screenshot
Take a screenshot of the whiteboard. No params. Returns base64 JPEG image.

## Architecture

- MCP tools delegate to Neural Interface REST endpoints (`/api/whiteboard/*`)
- Whiteboard state persists in Neural Interface memory (resets on server restart)
- Used by TicTacToe tool for game board rendering
- Supports coordinate modes: absolute pixels or percentage of viewport
