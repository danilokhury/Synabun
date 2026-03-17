# SynaBun Changelog

## v2026.03.16

### New Features

- **Live text streaming** — Claude responses now stream word-by-word in real time, including thinking blocks when effort toggle is on
- **Live browser embed** — When Claude uses browser tools, a live screencast appears in the panel with full interaction forwarding, navigation controls, and a detach button to pop it out as a floating window
- **Branded tool cards** — SynaBun tool interactions render with a gold/amber visual identity, friendly names, custom icons, and rich result cards with score badges and tag pills
- **Plan rendering** — Plans render as formatted markdown in a collapsible card with quick-action buttons: Continue, Compact, and Edit
- **Tool permission prompts** — Edit, Write, and Bash now prompt for approval in the UI with Allow, Deny, and Always Allow options
- **Stall auto-kill** — If the Claude CLI produces no output for 120 seconds, the process is automatically killed with a retry prompt
- **Changelog button** — One-click changelog generation from the floating terminal header
- **Git commit output** — File explorer now shows full git operation output after committing
- **Wireframe tool** — 12 preset wireframe blocks for the whiteboard with click-to-place, drag-to-create, double-click label editing, and MCP integration
- **Grid snapping** — Whiteboard elements snap to a configurable grid during drag, resize, and placement
- **Floating terminal colors** — 16 accent color presets per terminal with a color strip indicator and picker popup
- **Snap-to-neighbor drag** — Floating terminals snap edges flush to each other and to viewport edges with magnetic animation
- **Tile all terminals** — Navbar button that arranges all floating terminals in an optimal grid layout
- **Loop memory integration** — Autonomous loops now maintain a rolling journal, inject recent context into each iteration, and enforce periodic memory saves
- **Auto changelog skill** — `/synabun changelog` analyzes conversation history and git diff to generate categorized changelog entries
- **Instagram tools** — 5 browser extractor tools for feed, profile, post, reels, and search
- **LinkedIn tools** — 7 browser extractor tools for feed, profile, post, notifications, messages, people search, and network
- **Discord tools** — 8 tools covering guild, channel, role, message, member, onboarding, webhook, and thread management. Includes a settings tab for bot configuration
- **File explorer context menu** — Right-click menu, 9-color folder accents, hover actions, "Send to AI", and file type icons for ~50 extensions
- **Claude Code skin** — Full-featured Claude Code client with multi-session tabs (up to 5), session history browser, cost tracking, file attachments, slash command autocomplete, image paste/preview, and keyboard shortcuts
- **Workspace toolbar** — Memory Explorer and File Explorer toggle buttons in the top-right toolbar
- **Git controls** — Branch switching, one-click commit with auto-generated messages, and color-coded change summary
- **Syntax highlighting** — Monochrome gray-blue palette with per-language rules for 14 languages

### Bug Fixes

- Concurrent Claude sessions no longer steal each other's active loops
- Resume dropdown no longer shows 0 sessions on macOS
- Claude skin no longer crashes from cached Windows-style paths on macOS/Linux
- Keyboard focus and terminal connections now auto-restore after screen sleep/wake
- Switching sessions while one is running no longer leaks output into the new session
- Find & replace input no longer loses focus on every keystroke
- "Continue with implementation" no longer causes an infinite loop after planning
- Compaction now shows a single status line instead of duplicates
- Browser embed no longer shrinks the actual browser viewport
- Changelog skill no longer shows duplicate confirmation panels
- Claude skin can now access files in sibling project directories
- Tool permission prompts now appear correctly instead of being silently auto-approved
- Thinking indicator now persists throughout the response with an elapsed timer
- Large text paste no longer overflows the textarea horizontally
- Context gauge now calculates usage from input tokens only
- Compact button now works correctly
- Floating terminal rendering no longer glitches during full-screen redraws
- Loops no longer end abruptly after 3–4 iterations
- Loop time cap raised from 60 minutes to 8 hours for long-running automations
- Loop context no longer lost after `/clear`
- Wireframe sections now show resize handles when selected
- Whiteboard viewport no longer clips behind navbar and terminal panels
- Hook toggles no longer stuck at 0/6 for projects without settings files
- File explorer left-click now opens the editor directly
- Resume prompt no longer disappears after server restart
- Resume session list now shows correct message counts and supports up to 50 sessions
- Paste events from other panels no longer leak to the whiteboard
- Restored floating terminals now appear above all other windows
- Greetings now work correctly after finished loops and for unconfigured projects
- MCP tools now work correctly in Claude skin
- Binary file attachments are now properly rejected with a clear error
- Hook edit counter now resets correctly after memory saves
- Spawn helper now works on Linux
- Focus mode logo centers correctly when sidebars are open

### Improved

- Consistent 16px edge margins across all floating panels
- Terminal file sidebar now matches the terminal viewport's border and shadow styling
- Server starts gracefully without node-pty — only the terminal feature is disabled
- Better Claude CLI detection with bundled-first fallback and clear error messages
- Node 22+ now required
- Updated Windows build instructions to Visual Studio Build Tools 2022
- Whiteboard image button changed to click-to-copy-path
- Post-plan actions restyled as a card panel with green accent
- Context gauge bar redesigned — thinner with glow on urgency states, sweep animation on compact button
- Greeting settings now show "per-project or global" hint
- Smoother terminal resizing during drag
- Loop state now records why a loop ended
- Thinner whiteboard arrows for proportional appearance
- Hooks auto-sync to all registered projects when enabled globally
- Floating terminal header restyled with steel-blue gradient, accent-colored borders, and cleaner buttons
