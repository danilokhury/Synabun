---
category: neural-interface
tags: [sync, ui, settings, stale-detection, model-selector, clipboard]
importance: 7
project: synabun
source: self-discovered
subcategory: architecture
related_files:
  - neural-interface/server.js
  - neural-interface/public/index.html
---

# SynaBun Memory Sync UI

The Memory Sync UI is a section in the Neural Interface's Settings > Memory tab that detects stale memories and generates prompts for Claude Code to update them.

## Location

Settings modal > Memory tab, below the "Recall verbosity" section. Consists of:
1. **Model selector** — Three preset cards (Haiku, Sonnet, Opus) for choosing which Claude model the sync prompt will instruct Claude Code to use as a Task subagent
2. **Check button** — "Check for stale memories" triggers `GET /api/sync/check`
3. **Results area** — Shows count summary and individual stale memory cards
4. **Copy prompt button** — Generates and copies a ready-to-paste prompt for Claude Code

## Model Selector

Three `gfx-preset-card` elements with `data-sync-model` attributes. Selection persisted in `localStorage` as `neural-sync-model`. Default: Haiku. Functions: `getSyncModel()`, `setSyncModel()`, `initSyncModelSelector()`.

## Check Flow

`checkSyncStatus()`:
1. Calls `GET /api/sync/check` on the Neural Interface server
2. Server scrolls all memories, compares SHA-256 file hashes against stored `file_checksums`
3. Returns stale memories with full details
4. UI renders summary ("3 of 15 memories are stale") and individual cards showing content preview, category badge, importance, and changed file paths

## Copy Prompt

`copySyncPrompt()` generates a structured prompt that:
- Lists all stale memories with full UUIDs, categories, importance, related files, and current content
- Instructs Claude Code to use a Task subagent with the selected model (e.g., "You MUST use a Task subagent with model 'haiku'")
- Tells the subagent to read current file content, compare with memory, and use `reflect` to update

## Design Philosophy

The Neural Interface is the detection + UI layer only. Actual memory rewriting happens in Claude Code via Task subagents, using the user's Max subscription (no separate API key needed). The user stays in control — they check, review the stale list, and paste the prompt.

## JavaScript Exposure

Functions are exposed via `window.checkSyncStatus` and `window.copySyncPrompt` because the script runs as `type="module"` which doesn't make top-level functions globally accessible for `onclick` handlers.
