---
category: architecture
tags: [multi-connection, sqlite, runtime-switching, connections-json]
importance: 8
project: synabun
source: self-discovered
subcategory: architecture
related_files:
  - mcp-server/src/config.ts
  - neural-interface/server.js
---

# SynaBun Multi-Connection Support

SynaBun supports multiple SQLite database files with runtime switching.

## connections.json Format

```json
{
  "active": "default",
  "connections": {
    "default": {
      "label": "Local Development",
      "path": "data/memory.db"
    },
    "production": {
      "label": "Production",
      "path": "data/production.db"
    }
  }
}
```

## Runtime Switching

- **MCP server**: `getActiveConnection()` reads `connections.json` on every call — no restart needed
- **Neural Interface**: `PUT /api/connections/active` switches the active connection, updates runtime vars
- **SQLite client**: Detects database path changes and reconnects automatically

## Neural Interface Connection Management

- `GET /api/connections`: Lists all connections with LIVE memory counts (queries each SQLite database)
- `POST /api/connections`: Add new connection (verifies database is accessible first)
- `PUT /api/connections/active`: Switch active connection
- `DELETE /api/connections/:id`: Remove connection (prevents deleting the active one)

## Use Cases

- Separate dev/staging/prod database files
- Per-team or per-project databases
- Multiple database files side by side
