---
category: neural-interface
tags: [api, endpoints, categories, connections, settings, rest]
importance: 7
project: synabun
source: self-discovered
related_files:
  - neural-interface/server.js
---

# SynaBun Neural Interface — Category, Connection & Settings API Endpoints

## Category Endpoints (5)

- **GET /api/categories**: All categories with tree structure from `custom-categories.json`
- **POST /api/categories**: Create category (validates name pattern, color format, parent existence)
- **PUT /api/categories/:name**: Update category. Special behavior: auto-creates category if it exists in database memories but not in JSON file. On rename, batch-updates all SQLite memories in that category.
- **PATCH /api/categories/:name**: Update description only (lightweight update)
- **DELETE /api/categories/:name**: Delete with reassignment. Checks for child categories and existing memories. Requires reassign targets if either exist.

## Connection Endpoints (4)

- **GET /api/connections**: Lists all connections from `connections.json` with LIVE memory counts. Checks each SQLite database to get current memory count and availability status.
- **POST /api/connections**: Add new database connection. Verifies path accessibility before saving. Body: `{ id, label, dbPath }`.
- **PUT /api/connections/active**: Switch active connection. Body: `{ id }`. Updates runtime variables immediately.
- **DELETE /api/connections/:id**: Remove a connection. Prevents deleting the currently active connection.

## Settings Endpoints (2)

- **GET /api/settings**: Current configuration. Returns database path, embedding model, dimensions, Neural Interface port.
- **PUT /api/settings**: Save configuration. Writes database settings to `connections.json`, embedding settings to `.env` file. Reloads runtime config.

## Sync Endpoints (1)

- **GET /api/sync/check**: Detects stale memories by comparing SHA-256 file content hashes against stored `file_checksums`. See `13-memory-search-api.md` for full details.
