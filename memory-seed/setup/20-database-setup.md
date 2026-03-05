---
category: setup
tags: [sqlite, database, storage, setup, file-based]
importance: 7
project: synabun
source: self-discovered
related_files:
  - mcp-server/src/services/sqlite.ts
  - .env.example
---

# SynaBun SQLite Database Setup

## Database Location

- **Default path:** `data/memory.db` (relative to project root)
- **Created automatically** on first run — no manual setup required
- **No external services** — uses Node.js built-in `node:sqlite` module

## Local Embeddings

- **Model:** Transformers.js all-MiniLM-L6-v2 (384 dimensions)
- **Downloaded automatically** on first run (~23 MB)
- **Runs locally** — no API keys, no network calls, no external providers
- **Cached** in the Transformers.js model cache directory

## Database Schema

The `memories` table is created automatically with columns for:
- `id` (UUID primary key)
- `content` (text)
- `category`, `project`, `tags`, `subcategory`, `source` (metadata)
- `importance`, `access_count` (integers)
- `created_at`, `updated_at` (timestamps)
- `embedding` (BLOB — 384-dimensional float vector)

## Backup & Migration

- **Backup:** Simply copy the `data/memory.db` file
- **Move between machines:** Copy the database file to the new machine's `data/` directory
- Data persists automatically — no volume mounts or container management needed

## Troubleshooting

- If the database file is corrupted, delete `data/memory.db` and restart — it will be recreated (memories will be lost)
- Ensure write permissions on the `data/` directory
- Node.js >= 22.5.0 required for built-in `node:sqlite` support
