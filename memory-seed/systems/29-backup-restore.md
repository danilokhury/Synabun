---
category: setup
tags: [backup, restore, archive, migration, onboarding]
importance: 7
project: synabun
source: self-discovered
related_files:
  - neural-interface/server.js
---

# SynaBun Backup & Restore System

Full system backup and restore via the Neural Interface, designed for migration between machines.

## Backup

**Endpoint:** `POST /api/system/backup`

Creates a ZIP archive containing:
- `data/memory.db` — SQLite database with all memories and vectors
- `data/custom-categories.json` — Category definitions
- `data/greeting-config.json` — Greeting templates
- `data/hook-features.json` — Feature toggles
- `data/claude-code-projects.json` — Registered projects
- `data/loop-templates.json` — Loop task templates
- `skills/` — All skill files (recursively via `addDirRecursive`)
- `.env` — Environment configuration

## Restore

**Endpoint:** `POST /api/system/restore`

3-phase restore pattern:

1. **Phase 1 — Extract**: Extracts archive, writes files to disk
2. **Phase 2 — Database**: Replaces `data/memory.db` with backup copy
3. **Phase 3 — Reload**: Reloads configuration, reinitializes SQLite connection, refreshes category cache

Uses `addDirRecursive()` helper that recursively walks directories for backup inclusion.

## Onboarding Integration

The onboarding wizard (`public/onboarding.html`) offers two choices on the welcome screen:
- **Fresh Install** — proceeds to step 1 (dependency check)
- **Restore from Backup** — drag-and-drop ZIP upload, then skips setup

## Key Design Decisions

- Backup includes skills and agents directories (added after initial implementation)
- 3-phase restore ensures database is ready before config reload
- `.env` is included in backup (contains non-secret config like NEURAL_PORT, SETUP_COMPLETE)
