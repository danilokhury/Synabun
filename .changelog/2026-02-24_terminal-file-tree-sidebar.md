# Terminal File Tree Sidebar

**Date:** 2026-02-24
**Component:** Neural Interface
**Type:** Feature

## Summary

Added an expandable file tree sidebar to both docked and detached terminal variants. Users can browse the working directory's file structure directly alongside the terminal.

## Added

### Neural Interface

- **File tree sidebar** for docked terminal panel — toggled via folder icon button in the terminal header
- **File tree sidebar** for detached floating tabs — same toggle button in the floating tab header actions
- `GET /api/terminal/files?path=...` server endpoint — returns sorted directory listing (directories first, then alphabetical), skips hidden files, `node_modules`, and `__pycache__`
- `fetchTerminalFiles()` client API function in `api.js`
- `cwd` property stored on client-side session objects for both fresh and reconnected sessions
- Recursive directory expansion — click a folder to lazy-load and display its children
- Click a file to type its path into the terminal
- Sidebar auto-closes on tab switch in docked mode
- **Git integration** (optional, gracefully ignored if git is unavailable):
  - Branch name displayed in sidebar header with git-branch icon
  - Per-file/directory git status badges: Modified (M), Staged (S), Added (A), Deleted (D), Renamed (R), Untracked (U), Conflict (!)
  - Color-coded filenames: yellow for modified, green for staged/added, red for deleted, cyan for renamed, dim for untracked
  - Directory status aggregates child statuses (highest priority wins)
  - Deleted files shown with strikethrough
  - **Branch switcher** — click the branch name to open a dropdown of local branches; selecting a branch runs `git checkout` and refreshes the tree
  - `GET /api/terminal/branches?path=...` — lists local branches and current branch
  - `POST /api/terminal/checkout` — switches branch via `git checkout`; returns git's own output
  - **Git output panel** — bottom panel in sidebar shows git operation results (success/error) with color-coded styling; errors persist until dismissed, successes auto-fade after 4s
- **Project switcher** — folder+ icon button in sidebar header reopens the project picker, sends `cd` to the terminal, updates the session label and refreshes the tree
- **Inline path editor** — click the directory name in the sidebar header to type/paste any path; Enter confirms and switches, Escape cancels. Works for any directory, not just registered projects
- **Ctrl+Enter** inserts a newline in both terminal variants (parent and detached) instead of submitting input; regular Enter still submits

## Fixed

- Reconnected sessions (page refresh, workspace restore) now preserve `cwd` by looking it up from the server's live session data

## Files Changed

- `neural-interface/server.js` — new `/api/terminal/files` endpoint
- `neural-interface/public/shared/api.js` — new `fetchTerminalFiles()` export
- `neural-interface/public/shared/ui-terminal.js` — file tree logic, sidebar HTML in both panel types, `cwd` on session objects, Ctrl+Enter key handler, reconnect `cwd` fix
- `neural-interface/public/shared/styles.css` — file tree sidebar styles (220px width, slide transition, directory/file icons, custom scrollbar)
