# SynaBun Changelog

## 2026-03-17

### Fixed — Loop Pending-Claim Failure
- **Server-side pending claim** — `attachLoopDriver` now scans for `pending-*.json` files matching its terminal session and writes the `[SynaBun Loop] Begin task.` message directly via `session.pty.write()` when the `>` prompt is detected, bypassing the unreliable client-side `_sendOnceReady` which silently fails when the WebSocket is closed
- **Stale pending cleanup** — `cleanupStaleLoops` in `shared.mjs` now deletes `pending-*.json` files older than `maxMinutes + 5` minutes instead of ignoring them

### Fixed — Loop History Accumulation Breaking State
- **Delete on end/stop** — Loop JSON files are now deleted immediately when a loop finishes (iteration cap, time cap), is force-stopped (API or duplicate launch), or fails (consecutive prompt detection failures) — previously they were marked inactive and lingered in `data/loop/`
- **Stale loops deleted immediately** — `cleanupStaleLoops` now deletes stale and inactive loop files on sight instead of deactivating them or waiting 24 hours
- **History endpoints gutted** — `GET /api/loop/history` returns `[]`, `DELETE /api/loop/history/:id` is a no-op — no loop logging, only actively running loops exist as files
