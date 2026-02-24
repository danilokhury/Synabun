---
category: architecture
tags: [multi-connection, qdrant, runtime-switching, connections-json]
importance: 8
project: synabun
source: self-discovered
subcategory: architecture
related_files:
  - mcp-server/src/config.ts
  - neural-interface/server.js
---

# SynaBun Multi-Connection Support

SynaBun supports multiple Qdrant instances with runtime switching.

## connections.json Format

```json
{
  "active": "default",
  "connections": {
    "default": {
      "label": "Local Development",
      "url": "http://localhost:6333",
      "apiKey": "your-api-key",
      "collection": "claude_memory"
    },
    "production": {
      "label": "Production Server",
      "url": "https://qdrant.example.com:6333",
      "apiKey": "prod-key",
      "collection": "claude_memory"
    }
  }
}
```

## Runtime Switching

- **MCP server**: `getActiveConnection()` reads `connections.json` on every call — no restart needed
- **Neural Interface**: `PUT /api/connections/active` switches the active connection, updates runtime vars
- **Qdrant client**: Singleton detects URL/key changes and recreates client automatically

## Neural Interface Connection Management

- `GET /api/connections`: Lists all connections with LIVE point counts (pings each Qdrant instance)
- `POST /api/connections`: Add new connection (verifies reachability first)
- `PUT /api/connections/active`: Switch active connection
- `DELETE /api/connections/:id`: Remove connection (prevents deleting the active one)

## Use Cases

- Separate dev/staging/prod Qdrant instances
- Per-team or per-project Qdrant databases
- Qdrant Cloud + local Docker instances side by side
