# SynaBun Changelog

## 2026-03-08

### Added
- **Git controls in file explorer** — Branch button sits inline next to the project selector. Clicking it opens an animated popover with branch switching (via `git checkout`), a commit input with one-click commit, and a color-coded change summary (modified, added, deleted, untracked). Popover slides in with scale+opacity transition and an arrow pointing back at the button.
- **Auto-generate commit message** — Star button in the commit popover analyzes `git diff --stat`, counts added/removed lines, and generates a commit message from file names and change types.
- **Git API endpoints** — `GET /api/git/status`, `POST /api/git/commit`, `GET /api/git/diff-summary` for the new git UI.
- **Syntax highlighting in code editor** — Monochrome gray-blue palette with dark gold brackets and olive-green italic comments. Regex-based tokenizer with per-language rules for JS, TS, Python, JSON, CSS, HTML, Shell, SQL, YAML, TOML, Rust, Go, Ruby, and ENV. Uses textarea overlay technique (transparent text + colored `<pre>` behind). Viewport-based rendering for large files — only highlights visible lines plus buffer, re-renders on scroll.

### Fixed
- **Focus mode logo centering** — Logo and breathing effect now center horizontally relative to the content area when the memory explorer or file explorer sidebars are open. Uses `--sidebar-total-width` to account for both panels. Whiteboard and toolbar remain unaffected.
