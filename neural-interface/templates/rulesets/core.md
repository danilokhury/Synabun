## SynaBun

### Memory
- Recall before substantial work: at session start, before decisions or debugging, and when the user refers to earlier work.
- After each substantive task call `remember`: what changed, why and how. Skip plain Q&A, reads with no findings and typos.
- Call `remember` before your final summary; the summary comes last.
- Every `remember` needs `category` and `project`. Add 3-5 tags, `related_files` and a deliberate importance: 5 routine, 6-7 significant, 8+ architecture or hard bugs.
- Use an existing child category; if none fits, create one with `category` (action `create`). Never file under a parent.
- `reflect` updates a memory and needs its full UUID.
- Call SynaBun tools one at a time.
- SynaBun is the only long-term memory; do not use another tool's memory features.

### Tools
- Use the exact tool names in your tool list (the host adds a prefix). Never invent one.
- If a SynaBun tool you need is missing, call `profile` (`get`, then `set` the narrowest profile that has it) and restore the previous one afterwards. <!-- except: codex -->

### Browser
- For every page, public-web and localhost alike (browsing, search, page retrieval, screenshots, visual checks), use only the configured SynaBun browser tools, and open a new tab instead of reusing an existing one.
- Never switch to WebSearch, WebFetch, Playwright MCP, Chrome DevTools MCP, a shell-launched or headless browser, or your own Playwright, Puppeteer or Selenium code without an explicit user request for that alternative. Playwright and Chrome DevTools belong only inside a project's automated test suite.
- If the SynaBun browser is unavailable or cannot do what you need, say so instead of substituting another tool.

### Design
- Before UI, design, marketing, copy or image work in a project, read its `DESIGN.md` (or call `style_guide` with the project path) and use its tokens; never invent colors or fonts the project already defines.
- Suggest changes with `style_guide` (action `propose`); never edit `DESIGN.md` or the generated token files by hand.

<!-- host -->
