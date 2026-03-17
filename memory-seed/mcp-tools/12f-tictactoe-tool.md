---
category: mcp-tools
tags: [tictactoe, game, mcp-tool, whiteboard, easter-egg]
importance: 5
project: synabun
source: self-discovered
related_files:
  - mcp-server/src/tools/tictactoe.ts
  - mcp-server/src/tools/tictactoe-tools.ts
---

# SynaBun tictactoe Tool — Easter Egg Game

A TicTacToe game rendered on the Neural Interface whiteboard. Registered via `registerTicTacToeTools(server)`.

## Schema

- **action** (required): `"start"` | `"move"` | `"state"` | `"end"`
- **cell** (optional, 1-9): Cell to place piece (required for move). Grid numbered 1-9, left-to-right top-to-bottom.
- **piece** (optional): `"X"` | `"O"` — player piece for start action (default: X)

## Actions

- **start**: Sets up game board on whiteboard using whiteboard elements. X always goes first.
- **move**: Places a piece on the specified cell. Returns ASCII board + game status (in progress, winner, draw).
- **state**: Returns current ASCII board representation + status.
- **end**: Clears game board from whiteboard.

All actions delegate to Neural Interface API (`/api/games/tictactoe/*`).
