# SynaBun Neural Interface - API Reference

REST API served by the Neural Interface at `http://localhost:3344`.

The Neural Interface is the HTTP server that bridges the SynaBun web UI, MCP server, and Qdrant vector database. It manages memories, categories, connections to Qdrant instances, settings, setup/onboarding, Claude Code integrations (hooks, MCP registration, skills), OpenClaw bridge, trash management, backup/restore, and more. 55+ endpoints across 12 groups.

## Table of Contents

- [Memory Endpoints](#memory-endpoints)
  - [GET /api/memories](#get-apimemories)
  - [POST /api/search](#post-apisearch)
  - [GET /api/stats](#get-apistats)
  - [GET /api/memory/:id](#get-apimemoryid)
  - [PATCH /api/memory/:id](#patch-apimemoryid)
  - [DELETE /api/memory/:id](#delete-apimemoryid)
- [Category Endpoints](#category-endpoints)
  - [GET /api/categories](#get-apicategories)
  - [POST /api/categories](#post-apicategories)
  - [PUT /api/categories/:name](#put-apicategoriesname)
  - [PATCH /api/categories/:name](#patch-apicategoriesname)
  - [DELETE /api/categories/:name](#delete-apicategoriesname)
- [Connection Endpoints](#connection-endpoints)
  - [GET /api/connections](#get-apiconnections)
  - [POST /api/connections](#post-apiconnections)
  - [PUT /api/connections/active](#put-apiconnectionsactive)
  - [DELETE /api/connections/:id](#delete-apiconnectionsid)
- [Settings Endpoints](#settings-endpoints)
  - [GET /api/settings](#get-apisettings)
  - [PUT /api/settings](#put-apisettings)
- [Setup Endpoints](#setup-endpoints)
  - [GET /api/setup/check-deps](#get-apisetupcheck-deps)
  - [GET /api/setup/status](#get-apisetupstatus)
  - [POST /api/setup/save-config](#post-apisetupsave-config)
  - [POST /api/setup/docker](#post-apisetupdocker)
  - [POST /api/setup/create-collection](#post-apisetupcreate-collection)
  - [POST /api/setup/build](#post-apisetupbuild)
  - [GET /api/setup/test-qdrant](#get-apisetuptest-qdrant)
  - [POST /api/setup/test-qdrant-cloud](#post-apisetuptest-qdrant-cloud)
  - [POST /api/setup/write-mcp-json](#post-apisetupwrite-mcp-json)
  - [POST /api/setup/write-instructions](#post-apisetupwrite-instructions)
  - [POST /api/setup/complete](#post-apisetupcomplete)
- [Hook Integration Endpoints](#hook-integration-endpoints)
  - [GET /api/claude-code/integrations](#get-apiclaude-codeintegrations)
  - [POST /api/claude-code/integrations](#post-apiclaude-codeintegrations)
  - [DELETE /api/claude-code/integrations](#delete-apiclaude-codeintegrations)
  - [DELETE /api/claude-code/projects/:index](#delete-apiclaude-codeprojectsindex)
- [Trash Endpoints](#trash-endpoints)
  - [GET /api/trash](#get-apitrash)
  - [POST /api/trash/:id/restore](#post-apitrashidrestore)
  - [DELETE /api/trash/purge](#delete-apitrashpurge)
- [Sync Endpoints](#sync-endpoints)
  - [GET /api/sync/check](#get-apisynccheck)
- [Display Settings Endpoints](#display-settings-endpoints)
  - [GET /api/display-settings](#get-apidisplay-settings)
  - [PUT /api/display-settings](#put-apidisplay-settings)
- [Category Logo Endpoints](#category-logo-endpoints)
  - [POST /api/categories/:name/logo](#post-apicategoriesname-logo)
  - [DELETE /api/categories/:name/logo](#delete-apicategoriesname-logo)
- [Category Export Endpoints](#category-export-endpoints)
  - [GET /api/categories/:name/export](#get-apicategoriesname-export)
- [Connection Management (Extended)](#connection-management-extended)
  - [GET /api/connections/suggest-port](#get-apiconnectionssuggest-port)
  - [POST /api/connections/start-container](#post-apiconnectionsstart-container)
  - [POST /api/connections/:id/backup](#post-apiconnectionsidbackup)
  - [POST /api/connections/:id/restore](#post-apiconnectionsidrestore)
  - [POST /api/connections/restore-standalone](#post-apiconnectionsrestore-standalone)
  - [POST /api/connections/docker-new](#post-apiconnectionsdocker-new)
  - [POST /api/connections/create-collection](#post-apiconnectionscreate-collection)
- [OpenClaw Bridge Endpoints](#openclaw-bridge-endpoints)
  - [GET /api/bridges/openclaw](#get-apibridgesopenclaw)
  - [POST /api/bridges/openclaw/connect](#post-apibridgesopenclawconnect)
  - [POST /api/bridges/openclaw/sync](#post-apibridgesopenclawsync)
  - [DELETE /api/bridges/openclaw](#delete-apibridgesopenclaw)
- [Claude Code MCP Management Endpoints](#claude-code-mcp-management-endpoints)
  - [GET /api/claude-code/mcp](#get-apiclaude-codemcp)
  - [POST /api/claude-code/mcp](#post-apiclaude-codemcp)
  - [DELETE /api/claude-code/mcp](#delete-apiclaude-codemcp)
  - [GET /api/claude-code/hook-features](#get-apiclaude-codehook-features)
  - [PUT /api/claude-code/hook-features](#put-apiclaude-codehook-features)
  - [GET /api/claude-code/ruleset](#get-apiclaude-coderuleset)
- [Setup Endpoints (Extended)](#setup-endpoints-extended)
  - [POST /api/setup/start-docker-desktop](#post-apisetupstart-docker-desktop)

---

## Memory Endpoints

### GET /api/memories

Retrieves all memories from the active Qdrant collection, along with pre-computed graph edges (links) between memories based on cosine similarity, shared tags, shared categories, and explicit `related_memory_ids`.

**Request**

No parameters.

**Response**

```json
{
  "nodes": [
    {
      "id": "8f7cab3b-644e-4cea-8662-de0ca695bdf2",
      "payload": {
        "content": "string",
        "category": "string",
        "tags": ["string"],
        "importance": 5,
        "created_at": "ISO 8601 string",
        "updated_at": "ISO 8601 string",
        "related_memory_ids": ["uuid"]
      }
    }
  ],
  "links": [
    {
      "source": "uuid",
      "target": "uuid",
      "strength": 0.75
    }
  ],
  "totalVectors": 42
}
```

**Link computation rules:**
- **Cosine similarity:** If similarity > 0.65, strength = `(sim - 0.65) / (1 - 0.65)`
- **Shared tags:** If any tags overlap, strength = `0.3 + sharedCount * 0.15`
- **Same category:** Minimum strength of `0.2`
- **Explicit relations:** `related_memory_ids` create links with strength `0.9`
- Links below strength `0.1` are discarded. Strength is capped at `1.0`.

Vectors are stripped from the response to reduce payload size.

**Error Response**

| Status | Body |
|--------|------|
| 500 | `{ "error": "string" }` |

**Example**

```bash
curl http://localhost:3344/api/memories
```

---

### POST /api/search

Performs semantic vector search across all memories. The query text is embedded via the configured OpenAI-compatible embedding API and searched against Qdrant with a minimum score threshold of `0.3`.

**Request**

```json
{
  "query": "string (required)",
  "limit": 10
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | string | Yes | - | Natural language search query |
| `limit` | number | No | 10 | Maximum number of results to return |

**Response**

```json
{
  "results": [
    {
      "id": "uuid",
      "score": 0.87,
      "payload": {
        "content": "string",
        "category": "string",
        "tags": ["string"],
        "importance": 5,
        "created_at": "ISO 8601 string"
      }
    }
  ],
  "query": "the original query"
}
```

**Error Responses**

| Status | Body |
|--------|------|
| 400 | `{ "error": "query required" }` |
| 500 | `{ "error": "string" }` |

**Example**

```bash
curl -X POST http://localhost:3344/api/search \
  -H "Content-Type: application/json" \
  -d '{"query": "Redis caching strategy", "limit": 5}'
```

---

### GET /api/stats

Returns the point count, vector count, and status of the active Qdrant collection.

**Request**

No parameters.

**Response**

```json
{
  "count": 42,
  "vectors": 42,
  "status": "green"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `count` | number | Total number of points (memories) in the collection |
| `vectors` | number | Total number of vectors stored |
| `status` | string | Qdrant collection status (e.g. `"green"`) |

**Error Response**

| Status | Body |
|--------|------|
| 500 | `{ "error": "string" }` |

**Example**

```bash
curl http://localhost:3344/api/stats
```

---

### GET /api/memory/:id

Retrieves a single memory by its UUID.

**Request**

| Parameter | Location | Type | Required | Description |
|-----------|----------|------|----------|-------------|
| `id` | Path | string (UUID) | Yes | The memory point ID |

**Response**

```json
{
  "id": "8f7cab3b-644e-4cea-8662-de0ca695bdf2",
  "payload": {
    "content": "string",
    "category": "string",
    "tags": ["string"],
    "importance": 5,
    "created_at": "ISO 8601 string",
    "updated_at": "ISO 8601 string"
  }
}
```

**Error Responses**

| Status | Body |
|--------|------|
| 404 | `{ "error": "Memory not found" }` |
| 500 | `{ "error": "string" }` |

**Example**

```bash
curl http://localhost:3344/api/memory/8f7cab3b-644e-4cea-8662-de0ca695bdf2
```

---

### PATCH /api/memory/:id

Updates a memory's payload fields. Validates that the category exists in the custom categories file. Sanitizes tags by lowercasing, trimming, deduplicating, and removing empties. Sets `updated_at` automatically.

**Request**

| Parameter | Location | Type | Required | Description |
|-----------|----------|------|----------|-------------|
| `id` | Path | string (UUID) | Yes | The memory point ID |

```json
{
  "category": "string (optional)",
  "tags": ["string"] ,
  "content": "string (optional)"
}
```

At least one of `category`, `tags`, or `content` must be provided.

| Field | Type | Validation |
|-------|------|------------|
| `category` | string | Must exist in custom-categories.json |
| `tags` | string[] | Sanitized: lowercased, trimmed, deduplicated, empties removed |
| `content` | string | Must be a non-empty string |

**Response**

```json
{
  "ok": true,
  "id": "uuid",
  "category": "updated-category",
  "tags": ["cleaned", "tags"],
  "content": "updated content",
  "updated_at": "ISO 8601 string"
}
```

**Error Responses**

| Status | Body |
|--------|------|
| 400 | `{ "error": "category, tags, or content is required" }` |
| 400 | `{ "error": "Unknown category \"xyz\"." }` |
| 400 | `{ "error": "tags must be an array of strings" }` |
| 400 | `{ "error": "content must be a non-empty string" }` |
| 500 | `{ "error": "string" }` |

**Example**

```bash
curl -X PATCH http://localhost:3344/api/memory/8f7cab3b-644e-4cea-8662-de0ca695bdf2 \
  -H "Content-Type: application/json" \
  -d '{"category": "learning", "tags": ["Redis", "cache"]}'
```

---

### DELETE /api/memory/:id

Permanently deletes a memory point from the active Qdrant collection.

**Request**

| Parameter | Location | Type | Required | Description |
|-----------|----------|------|----------|-------------|
| `id` | Path | string (UUID) | Yes | The memory point ID to delete |

**Response**

```json
{
  "ok": true,
  "id": "uuid"
}
```

**Error Response**

| Status | Body |
|--------|------|
| 500 | `{ "error": "Qdrant error: <status>" }` |

**Example**

```bash
curl -X DELETE http://localhost:3344/api/memory/8f7cab3b-644e-4cea-8662-de0ca695bdf2
```

---

## Category Endpoints

Categories are stored in `mcp-server/data/custom-categories.json` as a versioned flat array. Each category has a `name`, `description`, optional `parent` (for tree hierarchy), optional `color` (hex), and optional `is_parent` flag.

Category names must match the pattern `/^[a-z][a-z0-9-]*$/` (lowercase, starts with a letter, only letters/digits/hyphens) and be 2-30 characters long.

### GET /api/categories

Returns all categories as a flat list and as a tree structure (parents with nested children).

**Request**

No parameters.

**Response**

```json
{
  "categories": [
    {
      "name": "learning",
      "description": "Lessons learned and gotchas",
      "parent": "criticalpixel",
      "color": "#4a9eff",
      "is_parent": false,
      "created_at": "ISO 8601 string"
    }
  ],
  "tree": {
    "criticalpixel": {
      "name": "criticalpixel",
      "description": "Parent category for CriticalPixel",
      "is_parent": true,
      "children": [
        {
          "name": "learning",
          "description": "Lessons learned",
          "parent": "criticalpixel"
        }
      ]
    }
  },
  "flat": [
    {
      "name": "learning",
      "description": "Lessons learned",
      "parent": "criticalpixel",
      "color": "#4a9eff"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `categories` | array | Full category objects with all fields |
| `tree` | object | Parent categories as keys, each with a `children` array |
| `flat` | array | Simplified objects with `name`, `description`, `parent`, `color` only |

**Example**

```bash
curl http://localhost:3344/api/categories
```

---

### POST /api/categories

Creates a new category. Optionally nests it under a parent and assigns a color.

**Request**

```json
{
  "name": "string (required)",
  "description": "string (required)",
  "parent": "string (optional)",
  "color": "#rrggbb (optional)",
  "is_parent": false
}
```

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `name` | string | Yes | 2-30 chars, matches `/^[a-z][a-z0-9-]*$/`, must be unique |
| `description` | string | Yes | Non-empty |
| `parent` | string | No | Name of an existing category |
| `color` | string | No | Hex format `#rrggbb` |
| `is_parent` | boolean | No | Mark as a parent/grouping category |

**Response**

```json
{
  "categories": [ /* full updated category list */ ],
  "message": "Created \"learning\" under \"criticalpixel\" with color #4a9eff"
}
```

**Error Responses**

| Status | Body |
|--------|------|
| 400 | `{ "error": "name and description are required" }` |
| 400 | `{ "error": "Name must be 2-30 characters. Got N." }` |
| 400 | `{ "error": "Name must be lowercase, start with a letter, only letters/digits/hyphens." }` |
| 400 | `{ "error": "Invalid color format. Use hex: #rrggbb" }` |
| 400 | `{ "error": "Category \"xyz\" already exists." }` |
| 500 | `{ "error": "string" }` |

**Example**

```bash
curl -X POST http://localhost:3344/api/categories \
  -H "Content-Type: application/json" \
  -d '{"name": "bug-fixes", "description": "Hard-won bug fixes", "parent": "learning", "color": "#ff4444"}'
```

---

### PUT /api/categories/:name

Updates an existing category. Supports renaming, changing description, parent, color, and `is_parent` flag. On rename, all child categories that reference this category as their parent are cascaded to the new name, and all Qdrant memories using the old category name are updated in bulk.

If the category does not exist in the JSON file but exists in memories, it is auto-created first.

**Request**

| Parameter | Location | Type | Required | Description |
|-----------|----------|------|----------|-------------|
| `name` | Path | string | Yes | Current category name |

```json
{
  "new_name": "string (optional)",
  "description": "string (optional)",
  "parent": "string (optional, empty string to remove parent)",
  "color": "string (optional, empty string to remove color)",
  "is_parent": false
}
```

| Field | Type | Validation |
|-------|------|------------|
| `new_name` | string | 2-30 chars, matches name pattern, must be unique |
| `description` | string | Any string |
| `parent` | string | Must exist, cannot create circular dependency. Empty string removes parent. |
| `color` | string | Hex `#rrggbb` format. Empty string removes color. |
| `is_parent` | boolean | `true` to set, `false` to remove |

**Rename cascade behavior:**
1. All child categories with `parent === oldName` are updated to `parent = newName`
2. All Qdrant memory points with `category === oldName` are bulk-updated to the new name (up to 100 points per scroll page)
3. If the Qdrant update fails, the category file is still saved (non-blocking error)

**Circular dependency check:** Setting a parent is rejected if it would create a cycle (e.g., A -> B -> A).

**Response**

```json
{
  "categories": [ /* full updated category list */ ],
  "message": "Updated \"old-name\" -> \"new-name\": description updated, parent: criticalpixel, color: #4a9eff"
}
```

**Error Responses**

| Status | Body |
|--------|------|
| 400 | `{ "error": "Name must be 2-30 characters. Got N." }` |
| 400 | `{ "error": "Name must be lowercase, start with a letter, only letters/digits/hyphens." }` |
| 400 | `{ "error": "Category \"xyz\" already exists." }` |
| 400 | `{ "error": "Parent category \"xyz\" does not exist." }` |
| 400 | `{ "error": "Cannot set parent to \"xyz\": would create circular dependency." }` |
| 400 | `{ "error": "Invalid color format. Use hex: #rrggbb" }` |
| 500 | `{ "error": "string" }` |

**Example**

```bash
curl -X PUT http://localhost:3344/api/categories/old-name \
  -H "Content-Type: application/json" \
  -d '{"new_name": "new-name", "description": "Updated description", "color": "#00ff00"}'
```

---

### PATCH /api/categories/:name

Updates only the description of an existing category. A simpler alternative to PUT when only the description needs changing.

**Request**

| Parameter | Location | Type | Required | Description |
|-----------|----------|------|----------|-------------|
| `name` | Path | string | Yes | Category name |

```json
{
  "description": "string (required)"
}
```

**Response**

```json
{
  "categories": [
    { "name": "string", "description": "string" }
  ]
}
```

Note: The response `categories` array contains simplified objects with only `name` and `description`.

**Error Responses**

| Status | Body |
|--------|------|
| 400 | `{ "error": "description is required" }` |
| 404 | `{ "error": "Category \"xyz\" not found." }` |
| 500 | `{ "error": "string" }` |

**Example**

```bash
curl -X PATCH http://localhost:3344/api/categories/learning \
  -H "Content-Type: application/json" \
  -d '{"description": "Lessons learned during development"}'
```

---

### DELETE /api/categories/:name

Deletes a category. Handles two kinds of dependents: child categories (via `reassign_children_to` in the request body) and Qdrant memories (via `reassign_to` query parameter).

**Request**

| Parameter | Location | Type | Required | Description |
|-----------|----------|------|----------|-------------|
| `name` | Path | string | Yes | Category name to delete |
| `reassign_to` | Query | string | Conditional | Target category for orphaned memories. Required if memories exist using this category. |

```json
{
  "reassign_children_to": "string (conditional)"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `reassign_children_to` | string | If category has children | Name of category to re-parent children under, or `""` to make them top-level |

**Deletion logic:**
1. If the category has child categories and `reassign_children_to` is not provided, the request is rejected with a 400 listing the children.
2. If `reassign_children_to` is provided, children are re-parented (or made top-level if empty string).
3. Qdrant is queried for memories using this category. If any exist and `reassign_to` is not provided, the request is rejected with a 409.
4. If `reassign_to` is provided and valid, all matching memories are bulk-updated in Qdrant.
5. The category is removed from the JSON file.

**Response**

```json
{
  "categories": [ /* updated category list */ ],
  "message": "Deleted \"old-cat\". 2 child categories reassigned to \"parent-cat\". 5 memories reassigned to \"general\".",
  "reassigned": 5
}
```

**Error Responses**

| Status | Body |
|--------|------|
| 400 | `{ "error": "Cannot delete parent category...", "children": ["child1", "child2"] }` |
| 400 | `{ "error": "Invalid reassign_children_to: category \"xyz\" does not exist." }` |
| 400 | `{ "error": "Reassign target \"xyz\" is not a valid category." }` |
| 404 | `{ "error": "Category \"xyz\" not found." }` |
| 409 | `{ "error": "N memories use this category. Provide reassign_to to move them.", "count": N }` |
| 500 | `{ "error": "string" }` |

**Example**

```bash
curl -X DELETE "http://localhost:3344/api/categories/old-cat?reassign_to=general" \
  -H "Content-Type: application/json" \
  -d '{"reassign_children_to": ""}'
```

---

## Connection Endpoints

Connections represent configured Qdrant instances. They are stored in `connections.json` at the project root. Each connection has an `id`, `label`, `url`, `apiKey`, and `collection`. One connection is marked as `active` and is used by all memory operations.

### GET /api/connections

Lists all configured Qdrant connections with live health checks. For each connection, the server attempts to reach the Qdrant instance (with a 3-second timeout) and reports whether it is reachable and how many points are in its collection.

**Request**

No parameters.

**Response**

```json
{
  "connections": [
    {
      "id": "default",
      "label": "Default",
      "url": "http://localhost:6333",
      "collection": "claude_memory",
      "points": 42,
      "reachable": true,
      "active": true
    },
    {
      "id": "cloud",
      "label": "Qdrant Cloud",
      "url": "https://xyz.qdrant.io",
      "collection": "claude_memory",
      "points": 0,
      "reachable": false,
      "active": false
    }
  ],
  "active": "default"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `connections[].id` | string | Unique connection identifier |
| `connections[].label` | string | Human-readable name |
| `connections[].url` | string | Qdrant REST API URL |
| `connections[].collection` | string | Qdrant collection name |
| `connections[].points` | number | Number of points in the collection (0 if unreachable) |
| `connections[].reachable` | boolean | Whether the Qdrant instance responded within 3 seconds |
| `connections[].active` | boolean | Whether this is the currently active connection |
| `active` | string | ID of the active connection |

**Example**

```bash
curl http://localhost:3344/api/connections
```

---

### POST /api/connections

Adds a new Qdrant connection. The server verifies reachability by pinging the Qdrant `/collections` endpoint (5-second timeout) before saving.

**Request**

```json
{
  "id": "string (required)",
  "label": "string (optional)",
  "url": "string (required)",
  "apiKey": "string (required)",
  "collection": "string (required)"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique identifier for this connection |
| `label` | string | No | Display name (defaults to `id`) |
| `url` | string | Yes | Qdrant REST API URL |
| `apiKey` | string | Yes | Qdrant API key |
| `collection` | string | Yes | Collection name to use |

**Response**

```json
{
  "ok": true,
  "message": "Connection \"My Cloud\" added"
}
```

**Error Responses**

| Status | Body |
|--------|------|
| 400 | `{ "error": "id, url, apiKey, and collection are required" }` |
| 400 | `{ "error": "Cannot reach Qdrant at <url> (HTTP <status>)" }` |
| 400 | `{ "error": "Cannot reach Qdrant at <url>: <message>" }` |
| 409 | `{ "error": "Connection \"xyz\" already exists" }` |
| 500 | `{ "error": "string" }` |

**Example**

```bash
curl -X POST http://localhost:3344/api/connections \
  -H "Content-Type: application/json" \
  -d '{
    "id": "cloud",
    "label": "Qdrant Cloud",
    "url": "https://xyz-abc.eu-west-1-0.aws.cloud.qdrant.io:6333",
    "apiKey": "your-api-key",
    "collection": "claude_memory"
  }'
```

---

### PUT /api/connections/active

Switches the active Qdrant connection. The server verifies the target connection is reachable by pinging its collection endpoint (5-second timeout) before switching. On success, the runtime variables (`QDRANT_URL`, `QDRANT_KEY`, `COLLECTION`) are updated immediately without requiring a server restart.

**Request**

```json
{
  "id": "string (required)"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | ID of the connection to activate |

**Response**

```json
{
  "ok": true,
  "message": "Switched to \"Qdrant Cloud\"",
  "active": "cloud"
}
```

**Error Responses**

| Status | Body |
|--------|------|
| 400 | `{ "error": "Connection id is required" }` |
| 400 | `{ "error": "Cannot reach collection \"xyz\" at <url>" }` |
| 400 | `{ "error": "Cannot reach Qdrant at <url>: <message>" }` |
| 404 | `{ "error": "Connection \"xyz\" not found" }` |
| 500 | `{ "error": "string" }` |

**Example**

```bash
curl -X PUT http://localhost:3344/api/connections/active \
  -H "Content-Type: application/json" \
  -d '{"id": "cloud"}'
```

---

### DELETE /api/connections/:id

Removes a Qdrant connection from the configuration. The currently active connection cannot be deleted -- you must switch to another connection first.

**Request**

| Parameter | Location | Type | Required | Description |
|-----------|----------|------|----------|-------------|
| `id` | Path | string | Yes | Connection ID to delete |

**Response**

```json
{
  "ok": true,
  "message": "Connection \"cloud\" removed"
}
```

**Error Responses**

| Status | Body |
|--------|------|
| 400 | `{ "error": "Cannot delete the active connection. Switch to another first." }` |
| 404 | `{ "error": "Connection \"xyz\" not found" }` |
| 500 | `{ "error": "string" }` |

**Example**

```bash
curl -X DELETE http://localhost:3344/api/connections/cloud
```

---

## Settings Endpoints

### GET /api/settings

Returns current configuration with sensitive keys masked (all but last 4 characters replaced with `*`). Qdrant config is sourced from `connections.json` (primary) with `.env` fallback. Embedding config comes from `.env`.

**Request**

No parameters.

**Response**

```json
{
  "qdrantUrl": "http://localhost:6333",
  "qdrantApiKey": "****key1",
  "qdrantApiKeySet": true,
  "collection": "claude_memory",
  "openaiApiKey": "****ab12",
  "openaiApiKeySet": true,
  "qdrantPort": "6333",
  "qdrantGrpcPort": "6334"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `qdrantUrl` | string | Active Qdrant REST URL |
| `qdrantApiKey` | string | Masked API key (last 4 chars visible) |
| `qdrantApiKeySet` | boolean | Whether a Qdrant API key is configured |
| `collection` | string | Active collection name |
| `openaiApiKey` | string | Masked OpenAI/embedding API key |
| `openaiApiKeySet` | boolean | Whether an embedding API key is configured |
| `qdrantPort` | string | Configured Qdrant REST port |
| `qdrantGrpcPort` | string | Configured Qdrant gRPC port |

**Example**

```bash
curl http://localhost:3344/api/settings
```

---

### PUT /api/settings

Saves settings. Embedding config and port config are written to `.env`. Qdrant connection config (url, apiKey, collection) is written to the active connection in `connections.json`. The server runtime is reloaded after saving.

**Request**

```json
{
  "qdrantUrl": "string (optional)",
  "qdrantApiKey": "string (optional)",
  "collection": "string (optional)",
  "openaiApiKey": "string (optional)",
  "qdrantPort": "string (optional)",
  "qdrantGrpcPort": "string (optional)"
}
```

All fields are optional; only provided fields are updated.

**Response**

```json
{
  "ok": true,
  "message": "Settings saved. Neural Interface reloaded — restart your AI tool for MCP changes."
}
```

**Error Response**

| Status | Body |
|--------|------|
| 500 | `{ "error": "string" }` |

**Example**

```bash
curl -X PUT http://localhost:3344/api/settings \
  -H "Content-Type: application/json" \
  -d '{"openaiApiKey": "sk-new-key-here", "qdrantPort": "6333"}'
```

---

## Setup Endpoints

These endpoints power the onboarding wizard. The root `/` route redirects to `/onboarding.html` when `SETUP_COMPLETE` is not `true` in `.env` (unless a valid active connection and embedding key already exist).

### GET /api/setup/check-deps

Checks system dependencies required for SynaBun. Reports version and availability of Node.js, npm, Docker (including daemon status), and Git.

**Request**

No parameters.

**Response**

```json
{
  "deps": [
    {
      "id": "node",
      "name": "Node.js",
      "ok": true,
      "version": "v20.11.0",
      "detail": "v20.11.0",
      "url": "https://nodejs.org/"
    },
    {
      "id": "npm",
      "name": "npm",
      "ok": true,
      "version": "v10.2.4",
      "detail": "v10.2.4",
      "url": "https://nodejs.org/"
    },
    {
      "id": "docker",
      "name": "Docker",
      "ok": true,
      "version": "24.0.7",
      "detail": "v24.0.7 (running)",
      "url": "https://docs.docker.com/get-docker/"
    },
    {
      "id": "git",
      "name": "Git",
      "ok": true,
      "version": "2.43.0",
      "detail": "v2.43.0",
      "url": "https://git-scm.com/downloads"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `deps[].id` | string | Dependency identifier (`node`, `npm`, `docker`, `git`) |
| `deps[].name` | string | Display name |
| `deps[].ok` | boolean | Whether the dependency meets requirements |
| `deps[].warn` | boolean | Present on optional deps (Docker, Git) when missing |
| `deps[].version` | string or null | Detected version, or null if not found |
| `deps[].detail` | string | Human-readable status string |
| `deps[].url` | string | Installation URL |

**Notes:**
- Node.js requires version 18+
- Docker checks both CLI presence and daemon status separately
- Docker and Git are marked as optional (warn instead of hard fail)

**Example**

```bash
curl http://localhost:3344/api/setup/check-deps
```

---

### GET /api/setup/status

Returns current setup progress: which components are configured and operational.

**Request**

No parameters.

**Response**

```json
{
  "setupComplete": true,
  "hasQdrantKey": true,
  "hasEmbeddingKey": true,
  "dockerRunning": true,
  "mcpBuilt": true,
  "projectDir": "/path/to/Synabun",
  "platform": "win32"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `setupComplete` | boolean | Whether `SETUP_COMPLETE=true` is in `.env` |
| `hasQdrantKey` | boolean | Whether a Qdrant API key is configured (from connection or `.env`) |
| `hasEmbeddingKey` | boolean | Whether `OPENAI_EMBEDDING_API_KEY` is set in `.env` |
| `dockerRunning` | boolean | Whether Qdrant is reachable at the configured URL (3-second timeout) |
| `mcpBuilt` | boolean | Whether `mcp-server/dist/index.js` exists |
| `projectDir` | string | Absolute path to the SynaBun project root |
| `platform` | string | Node.js platform identifier (e.g. `win32`, `linux`, `darwin`) |

**Example**

```bash
curl http://localhost:3344/api/setup/status
```

---

### POST /api/setup/save-config

Writes configuration during onboarding. Embedding and Docker port config is saved to `.env`. Qdrant connection details are saved to `connections.json` as the `"default"` connection (auto-set as active if no active connection exists). Creates `.env` if it does not exist. Reloads runtime config after saving.

**Request**

```json
{
  "qdrantApiKey": "string (optional)",
  "qdrantUrl": "string (optional)",
  "collectionName": "string (optional)",
  "embeddingApiKey": "string (optional)",
  "embeddingBaseUrl": "string (optional, default: https://api.openai.com/v1)",
  "embeddingModel": "string (optional, default: text-embedding-3-small)",
  "embeddingDimensions": "number (optional, default: 1536)",
  "qdrantPort": "string (optional)",
  "qdrantGrpcPort": "string (optional)"
}
```

**Notes:**
- `embeddingBaseUrl`, `embeddingModel`, and `embeddingDimensions` are only written to `.env` if they differ from defaults (to keep the file clean).
- `qdrantApiKey` is written to both `.env` (for `docker-compose.yml`) and `connections.json`.

**Response**

```json
{
  "ok": true
}
```

**Error Response**

| Status | Body |
|--------|------|
| 500 | `{ "error": "string" }` |

**Example**

```bash
curl -X POST http://localhost:3344/api/setup/save-config \
  -H "Content-Type: application/json" \
  -d '{
    "qdrantApiKey": "my-qdrant-key",
    "qdrantUrl": "http://localhost:6333",
    "collectionName": "claude_memory",
    "embeddingApiKey": "sk-openai-key"
  }'
```

---

### POST /api/setup/docker

Starts Docker containers via `docker compose up -d` from the project root. After starting, it polls Qdrant's `/collections` endpoint every second for up to 30 seconds, waiting for readiness. Detects port-in-use conflicts and returns a specific error.

**Request**

No parameters (body is ignored). Environment variables from `.env` are passed to the Docker Compose process.

**Response (success)**

```json
{
  "ok": true,
  "output": "docker compose stdout + stderr",
  "ready": true
}
```

| Field | Type | Description |
|-------|------|-------------|
| `ok` | boolean | Always `true` on success |
| `output` | string | Combined stdout and stderr from `docker compose up -d` |
| `ready` | boolean | Whether Qdrant became reachable within 30 seconds |

**Error Responses**

| Status | Body |
|--------|------|
| 409 | `{ "error": "Port NNNN is already in use...", "portConflict": true, "port": "NNNN", "output": "string" }` |
| 500 | `{ "error": "string", "output": "string" }` |

**Example**

```bash
curl -X POST http://localhost:3344/api/setup/docker
```

---

### POST /api/setup/create-collection

Creates the Qdrant collection using the configured runtime variables (URL, API key, collection name, embedding dimensions). If the collection already exists, returns success with `existed: true`.

**Request**

No parameters (body is ignored). Uses runtime config set by `reloadConfig()`.

**Response**

```json
{
  "ok": true,
  "message": "Collection \"claude_memory\" created (1536d vectors)",
  "existed": false
}
```

| Field | Type | Description |
|-------|------|-------------|
| `ok` | boolean | Always `true` on success |
| `message` | string | Human-readable result |
| `existed` | boolean | `true` if the collection already existed, `false` if newly created |

**Error Response**

| Status | Body |
|--------|------|
| 500 | `{ "error": "Qdrant <status>: <body>" }` |

**Example**

```bash
curl -X POST http://localhost:3344/api/setup/create-collection
```

---

### POST /api/setup/build

Builds the MCP server by running `npm install && npm run build` in the `mcp-server/` directory. Has a 120-second timeout.

**Request**

No parameters.

**Response**

```json
{
  "ok": true,
  "output": "npm install + build stdout/stderr"
}
```

**Error Response**

| Status | Body |
|--------|------|
| 500 | `{ "error": "string", "output": "string" }` |

**Example**

```bash
curl -X POST http://localhost:3344/api/setup/build
```

---

### GET /api/setup/test-qdrant

Pings the Qdrant `/collections` endpoint to verify connectivity. Optionally accepts a `port` query parameter to test a specific local port instead of the configured URL.

**Request**

| Parameter | Location | Type | Required | Description |
|-----------|----------|------|----------|-------------|
| `port` | Query | number | No | Local port to test (overrides configured URL with `http://localhost:<port>`) |

**Response**

```json
{
  "ok": true
}
```

Always returns 200. The `ok` field indicates whether Qdrant responded successfully within 3 seconds.

**Example**

```bash
# Test configured Qdrant
curl http://localhost:3344/api/setup/test-qdrant

# Test specific port
curl "http://localhost:3344/api/setup/test-qdrant?port=6333"
```

---

### POST /api/setup/test-qdrant-cloud

Tests connectivity to a remote Qdrant instance (e.g., Qdrant Cloud) with provided URL and API key. Strips trailing slashes from the URL before pinging.

**Request**

```json
{
  "url": "string (required)",
  "apiKey": "string (required)"
}
```

**Response (reachable)**

```json
{
  "ok": true
}
```

**Response (unreachable)**

```json
{
  "ok": false,
  "error": "Qdrant responded 401: Unauthorized"
}
```

Always returns HTTP 200 (unless body is missing). Use the `ok` field to determine success.

**Error Response**

| Status | Body |
|--------|------|
| 400 | `{ "error": "url and apiKey required" }` |

**Example**

```bash
curl -X POST http://localhost:3344/api/setup/test-qdrant-cloud \
  -H "Content-Type: application/json" \
  -d '{"url": "https://xyz.eu-west-1-0.aws.cloud.qdrant.io:6333", "apiKey": "your-key"}'
```

---

### POST /api/setup/write-mcp-json

Generates or updates a `.mcp.json` file in the specified directory, adding a `SynaBun` entry under `mcpServers`. The entry points to the built MCP server's `preload.js` with a `DOTENV_PATH` environment variable. If the file already exists, the existing content is preserved and only the `SynaBun` key is added/updated.

**Request**

```json
{
  "targetDir": "string (required)"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `targetDir` | string | Yes | Absolute path to the directory where `.mcp.json` should be created/updated |

**Response**

```json
{
  "ok": true,
  "path": "/absolute/path/to/targetDir/.mcp.json"
}
```

**Error Responses**

| Status | Body |
|--------|------|
| 400 | `{ "error": "targetDir required" }` |
| 500 | `{ "error": "string" }` |

**Generated `.mcp.json` entry:**

```json
{
  "mcpServers": {
    "SynaBun": {
      "command": "node",
      "args": ["<project-root>/mcp-server/dist/preload.js"],
      "env": {
        "DOTENV_PATH": "<project-root>/.env"
      }
    }
  }
}
```

**Example**

```bash
curl -X POST http://localhost:3344/api/setup/write-mcp-json \
  -H "Content-Type: application/json" \
  -d '{"targetDir": "/home/user/my-project"}'
```

---

### POST /api/setup/write-instructions

Appends memory usage instructions to a markdown file in the specified directory. If the file already contains a `## Persistent Memory System` or `## Memory MCP` section, the write is skipped to avoid duplication.

**Request**

```json
{
  "targetDir": "string (required)",
  "fileName": "string (required)",
  "content": "string (required)"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `targetDir` | string | Yes | Directory containing the target file |
| `fileName` | string | Yes | File name (e.g. `CLAUDE.md`) |
| `content` | string | Yes | Markdown content to append |

**Response**

```json
{
  "ok": true,
  "path": "/absolute/path/to/file",
  "skipped": false
}
```

| Field | Type | Description |
|-------|------|-------------|
| `ok` | boolean | Always `true` on success |
| `path` | string | Absolute path to the written file |
| `skipped` | boolean | `true` if instructions were already present |
| `message` | string | Present only when `skipped: true` - explains why |

**Error Responses**

| Status | Body |
|--------|------|
| 400 | `{ "error": "targetDir, fileName, and content required" }` |
| 500 | `{ "error": "string" }` |

**Example**

```bash
curl -X POST http://localhost:3344/api/setup/write-instructions \
  -H "Content-Type: application/json" \
  -d '{
    "targetDir": "/home/user/my-project",
    "fileName": "CLAUDE.md",
    "content": "## Persistent Memory System\n\nInstructions here..."
  }'
```

---

### POST /api/setup/complete

Marks setup as complete by writing `SETUP_COMPLETE=true` to `.env` and reloading the runtime config. After this, the root `/` route will serve the main UI instead of redirecting to onboarding.

**Request**

No parameters (body is ignored).

**Response**

```json
{
  "ok": true
}
```

**Error Response**

| Status | Body |
|--------|------|
| 500 | `{ "error": "string" }` |

**Example**

```bash
curl -X POST http://localhost:3344/api/setup/complete
```

---

## Hook Integration Endpoints

These endpoints manage Claude Code hook integrations. SynaBun installs two hooks into Claude Code's `settings.json`:

- **SessionStart** (`session-start.mjs`) - Runs when a Claude Code session starts (5s timeout)
- **UserPromptSubmit** (`prompt-submit.mjs`) - Runs when the user submits a prompt (3s timeout)

Hooks can be installed globally (for all Claude Code projects) or per-project. The server tracks registered project paths in `data/claude-code-projects.json`.

### GET /api/claude-code/integrations

Lists all hook integration targets (global + per-project) with their current installation status.

**Request**

No parameters.

**Response**

```json
{
  "ok": true,
  "hookScriptExists": true,
  "global": {
    "installed": true,
    "path": "C:\\Users\\user\\.claude\\settings.json"
  },
  "projects": [
    {
      "path": "J:\\Sites\\CriticalPixel",
      "label": "CriticalPixel",
      "installed": true,
      "settingsExists": true
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `hookScriptExists` | boolean | Whether all hook script files exist on disk |
| `global.installed` | boolean | Whether hooks are in the global Claude settings |
| `global.path` | string | Absolute path to the global `settings.json` |
| `projects` | array | Registered project targets with status |
| `projects[].path` | string | Absolute path to the project directory |
| `projects[].label` | string | Display name (defaults to directory basename) |
| `projects[].installed` | boolean | Whether hooks are in this project's settings |
| `projects[].settingsExists` | boolean | Whether the project's `.claude/settings.json` exists |

**Example**

```bash
curl http://localhost:3344/api/claude-code/integrations
```

---

### POST /api/claude-code/integrations

Enables SynaBun hooks for a target. Writes hook entries into the appropriate `settings.json`. For project targets, also registers the project path in `data/claude-code-projects.json` if not already tracked.

**Request**

```json
{
  "target": "global | project (required)",
  "projectPath": "string (required if target is project)",
  "label": "string (optional, for project target)"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `target` | string | Yes | Either `"global"` or `"project"` |
| `projectPath` | string | If `target === "project"` | Absolute path to the project directory |
| `label` | string | No | Display name for the project (defaults to directory basename) |

**Response**

```json
{
  "ok": true,
  "message": "Hook enabled globally for all Claude Code projects."
}
```

or

```json
{
  "ok": true,
  "message": "Hook enabled for CriticalPixel."
}
```

**Error Responses**

| Status | Body |
|--------|------|
| 400 | `{ "error": "projectPath is required." }` |
| 400 | `{ "error": "Directory not found: <path>" }` |
| 400 | `{ "error": "Invalid target. Use \"global\" or \"project\"." }` |
| 500 | `{ "error": "string" }` |

**Example (global)**

```bash
curl -X POST http://localhost:3344/api/claude-code/integrations \
  -H "Content-Type: application/json" \
  -d '{"target": "global"}'
```

**Example (project)**

```bash
curl -X POST http://localhost:3344/api/claude-code/integrations \
  -H "Content-Type: application/json" \
  -d '{"target": "project", "projectPath": "J:\\Sites\\CriticalPixel", "label": "CriticalPixel"}'
```

---

### DELETE /api/claude-code/integrations

Disables SynaBun hooks for a target by removing hook entries from the appropriate `settings.json`. Cleans up empty `hooks` objects from the settings file.

**Request**

```json
{
  "target": "global | project (required)",
  "projectPath": "string (required if target is project)"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `target` | string | Yes | Either `"global"` or `"project"` |
| `projectPath` | string | If `target === "project"` | Absolute path to the project directory |

**Response**

```json
{
  "ok": true,
  "message": "Hook removed from global settings."
}
```

or

```json
{
  "ok": true,
  "message": "Hook removed from CriticalPixel."
}
```

**Error Responses**

| Status | Body |
|--------|------|
| 400 | `{ "error": "projectPath is required." }` |
| 400 | `{ "error": "Invalid target. Use \"global\" or \"project\"." }` |
| 500 | `{ "error": "string" }` |

**Example**

```bash
curl -X DELETE http://localhost:3344/api/claude-code/integrations \
  -H "Content-Type: application/json" \
  -d '{"target": "global"}'
```

---

### DELETE /api/claude-code/projects/:index

Removes a project from the tracked projects list (`data/claude-code-projects.json`) by its array index. This does not remove the hooks from the project's settings -- use `DELETE /api/claude-code/integrations` for that.

**Request**

| Parameter | Location | Type | Required | Description |
|-----------|----------|------|----------|-------------|
| `index` | Path | number | Yes | Zero-based index of the project to remove |

**Response**

```json
{
  "ok": true
}
```

**Error Responses**

| Status | Body |
|--------|------|
| 400 | `{ "error": "Invalid index." }` |
| 500 | `{ "error": "string" }` |

**Example**

```bash
curl -X DELETE http://localhost:3344/api/claude-code/projects/0
```

---

## Trash Endpoints

### GET /api/trash

Lists all trashed (soft-deleted) memories. Memories end up here when `forget` is called via the MCP tool.

**Response**

```json
{
  "nodes": [
    {
      "id": "uuid",
      "payload": {
        "content": "string",
        "category": "string",
        "trashed_at": "ISO 8601 string",
        "...": "other payload fields"
      }
    }
  ]
}
```

### POST /api/trash/:id/restore

Restores a trashed memory by clearing its `trashed_at` field.

| Parameter | Location | Type | Required | Description |
|-----------|----------|------|----------|-------------|
| `id` | Path | string (UUID) | Yes | Memory ID to restore |

**Response**

```json
{ "ok": true }
```

### DELETE /api/trash/purge

Permanently deletes ALL trashed memories. This is irreversible.

**Response**

```json
{ "ok": true, "purged": 5 }
```

---

## Sync Endpoints

### GET /api/sync/check

Detects stale memories by comparing SHA-256 file hashes against stored checksums.

**Response**

```json
{
  "stale": [
    {
      "id": "uuid",
      "content": "string",
      "related_files": ["path"],
      "changed_files": ["path"]
    }
  ],
  "total_checked": 42,
  "total_with_files": 30,
  "total_stale": 5
}
```

---

## Display Settings Endpoints

### GET /api/display-settings

Returns the current display settings.

**Response**

```json
{
  "recallMaxChars": 0
}
```

### PUT /api/display-settings

Updates display settings. Currently controls MCP response truncation behavior.

**Request Body**

```json
{
  "recallMaxChars": 2000
}
```

| Field | Type | Description |
|-------|------|-------------|
| `recallMaxChars` | number | Maximum characters in MCP recall responses. `0` = unlimited. |

---

## Category Logo Endpoints

### POST /api/categories/:name/logo

Uploads a logo image for a parent category. The logo is rendered on the category's sun node in the 3D visualization.

| Parameter | Location | Type | Required | Description |
|-----------|----------|------|----------|-------------|
| `name` | Path | string | Yes | Category name |
| `logo` | Body (multipart) | File | Yes | PNG, JPEG, WEBP, or GIF (max 5MB) |

Saved as `neural-interface/public/logo-{name}.{ext}`.

**Response**

```json
{ "ok": true, "path": "logo-my-category.png" }
```

### DELETE /api/categories/:name/logo

Removes a category's logo file.

**Response**

```json
{ "ok": true }
```

---

## Category Export Endpoints

### GET /api/categories/:name/export

Downloads all memories in a category as a Markdown file.

**Response:** `Content-Disposition: attachment; filename="category-{name}.md"`

---

## Connection Management (Extended)

### GET /api/connections/suggest-port

Suggests the next available port for a new Qdrant instance.

**Response**

```json
{ "port": 6340, "grpcPort": 6341 }
```

### POST /api/connections/start-container

Starts a stopped Docker container for a connection, with Qdrant readiness polling.

**Request Body**

```json
{ "id": "connection-id" }
```

### POST /api/connections/:id/backup

Creates a Qdrant snapshot and streams it as a downloadable `.snapshot` binary.

| Parameter | Location | Type | Required | Description |
|-----------|----------|------|----------|-------------|
| `id` | Path | string | Yes | Connection ID |

**Response:** Binary stream (`application/octet-stream`). Timeout: 120s creation + 5min download.

### POST /api/connections/:id/restore

Restores a `.snapshot` binary to a connection's Qdrant collection.

| Parameter | Location | Type | Required | Description |
|-----------|----------|------|----------|-------------|
| `id` | Path | string | Yes | Connection ID |
| `snapshot` | Body (multipart) | File | Yes | `.snapshot` binary (max 500MB) |

### POST /api/connections/restore-standalone

Restores a snapshot to any Qdrant instance by URL, then auto-adds it as a connection.

**Query Parameters:** `url`, `apiKey`, `collection`

### POST /api/connections/docker-new

Spins up a new Qdrant Docker container on a specified port.

**Request Body**

```json
{
  "port": 6340,
  "grpcPort": 6341,
  "apiKey": "generated-key",
  "label": "My Second Instance"
}
```

### POST /api/connections/create-collection

Creates a Qdrant collection on any arbitrary instance.

**Request Body**

```json
{
  "url": "http://localhost:6340",
  "apiKey": "key",
  "collection": "claude_memory",
  "dimensions": 1536
}
```

---

## OpenClaw Bridge Endpoints

### GET /api/bridges/openclaw

Returns the status of the OpenClaw bridge integration.

**Response**

```json
{
  "enabled": true,
  "workspacePath": "~/.openclaw/workspace",
  "lastSync": "ISO 8601 string",
  "nodeCount": 45,
  "categoryCount": 3
}
```

### POST /api/bridges/openclaw/connect

Connects the bridge to an OpenClaw workspace. Auto-detects `~/.openclaw/workspace` if no path provided. Validates by checking for `AGENTS.md` presence.

**Request Body**

```json
{
  "workspacePath": "/path/to/openclaw/workspace"
}
```

### POST /api/bridges/openclaw/sync

Re-reads and parses all OpenClaw workspace files. Three parsers run:
- `parseMemoryMd` — `MEMORY.md` (long-term curated memories)
- `parseDailyLogs` — `memory/*.md` (daily session logs)
- `parseWorkspaceConfigs` — 7 config files (AGENTS.md, SOUL.md, etc.)

All nodes are in-memory only (not stored in Qdrant).

### DELETE /api/bridges/openclaw

Disconnects the OpenClaw bridge and clears ephemeral nodes.

---

## Claude Code MCP Management Endpoints

### GET /api/claude-code/mcp

Checks if SynaBun is registered in `~/.claude.json`.

**Response**

```json
{ "installed": true }
```

### POST /api/claude-code/mcp

Registers the SynaBun MCP server in `~/.claude.json`.

### DELETE /api/claude-code/mcp

Removes SynaBun from `~/.claude.json`.

### GET /api/claude-code/hook-features

Returns hook feature flags from `data/hook-features.json`.

**Response**

```json
{ "conversationMemory": true }
```

### PUT /api/claude-code/hook-features

Toggles a single feature flag.

**Request Body**

```json
{ "feature": "conversationMemory", "enabled": false }
```

### GET /api/claude-code/ruleset

Returns the CLAUDE.md memory ruleset section for copy-paste into any project.

| Parameter | Location | Type | Required | Description |
|-----------|----------|------|----------|-------------|
| `format` | Query | string | No | `claude` (default), `cursor`, or `generic` |

---

## Setup Endpoints (Extended)

### POST /api/setup/start-docker-desktop

Launches Docker Desktop on Windows and polls until the Docker daemon is ready (45s timeout).

**Response**

```json
{ "ok": true, "message": "Docker Desktop started" }
```
