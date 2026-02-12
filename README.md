<p align="center">
  <img src="public/synabun.png" alt="SynaBun" width="120" />
</p>

<h1 align="center">SynaBun</h1>

<p align="center">
  Persistent vector memory for AI assistants — powered by Qdrant and OpenAI embeddings.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs&logoColor=white" alt="Node.js 18+" />
  <img src="https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Docker-Qdrant-2496ED?logo=docker&logoColor=white" alt="Docker" />
  <img src="https://img.shields.io/badge/MCP-Protocol-8B5CF6" alt="MCP Protocol" />
  <img src="https://img.shields.io/badge/Qdrant-Vector_DB-DC382D?logo=qdrant" alt="Qdrant" />
</p>

---

Any Claude Code instance (or MCP-compatible AI tool) can connect to SynaBun and retain knowledge across sessions through semantic vector search. Memories are stored in a single Qdrant collection with payload-based filtering — no fragmented search across databases.

## Features

- **Semantic Search** — find memories by meaning, not keywords, using cosine similarity
- **Multi-Project** — single collection serves all projects with automatic project detection and cross-project recall
- **Smart Relevance** — time decay (90-day half-life), project boost (1.2x), and access frequency scoring
- **User-Defined Categories** — hierarchical categories with prescriptive routing descriptions; dynamic schema refresh without server restart
- **Neural Interface** — interactive 3D force-directed graph visualization at `localhost:3344`
- **10+ Embedding Providers** — OpenAI, Google Gemini, Ollama, Mistral, Cohere, and more via OpenAI-compatible API
- **Onboarding Wizard** — guided setup through the Neural Interface UI

## Table of Contents

- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [MCP Tools](#mcp-tools)
- [Neural Interface](#neural-interface)
- [Usage](#usage)
- [Memory Categories](#memory-categories)
- [Importance Scale](#importance-scale)
- [How It Works](#how-it-works)
- [Configuration](#configuration)
- [Embedding Providers](#embedding-providers)
- [Embedding Model Migration](#embedding-model-migration)
- [CLAUDE.md Integration](#claudemd-integration)
- [Multi-Project Support](#multi-project-support)
- [Docker Management](#docker-management)
- [Known Limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [Cost](#cost)
- [File Structure](#file-structure)

## Quick Start

### Prerequisites

- Docker (Docker Desktop on Windows/macOS, or Docker Engine on Linux)
- Node.js 18+
- An embedding API key (OpenAI, Google Gemini, or any OpenAI-compatible provider)

### One-Command Setup

```bash
cd /path/to/Synabun
npm start
```

This will:
1. Check prerequisites (Node.js, Docker)
2. Install all dependencies
3. Build the MCP server
4. Launch the Neural Interface
5. Open the onboarding wizard in your browser

The onboarding wizard guides you through:
- Qdrant API key generation
- Embedding provider selection
- Docker/Qdrant startup
- AI tool integration (`.mcp.json`)
- CLAUDE.md memory instructions

<details>
<summary><strong>Manual setup (advanced)</strong></summary>

### 1. Start Qdrant

```bash
cd /path/to/Synabun
docker compose up -d
```

Verify: `curl -H "api-key: claude-memory-local-key" http://localhost:6333/collections`

### 2. Build the MCP server

```bash
cd mcp-server
npm install
npm run build
```

> **Note:** Always use `npm run build` (not `npx tsc`) — npx can install an unrelated `tsc` package instead of using the local TypeScript compiler.

### 3. Register with your AI tool

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "SynaBun": {
      "command": "node",
      "args": ["/path/to/Synabun/mcp-server/run.mjs"],
      "env": {
        "QDRANT_MEMORY_URL": "http://localhost:6333",
        "QDRANT_MEMORY_API_KEY": "claude-memory-local-key",
        "QDRANT_MEMORY_COLLECTION": "claude_memory",
        "OPENAI_EMBEDDING_API_KEY": "<your-openai-key>"
      }
    }
  }
}
```

Or register globally for all projects:

```bash
claude mcp add SynaBun -s user \
  -e QDRANT_MEMORY_URL=http://localhost:6333 \
  -e QDRANT_MEMORY_API_KEY=claude-memory-local-key \
  -e QDRANT_MEMORY_COLLECTION=claude_memory \
  -e OPENAI_EMBEDDING_API_KEY=<your-openai-key> \
  -- node "/path/to/Synabun/mcp-server/run.mjs"
```

### 4. Verify

Restart Claude Code, then run `/mcp`. You should see the `SynaBun` server with 9 tools listed.
<<<<<<< HEAD

</details>
=======
>>>>>>> 680a18cdc06026d9864584a0764f25dc05635e24

<details>
<summary><strong>Platform-specific path notes</strong></summary>

The `.mcp.json` path must match the platform where **Claude Code is running**:

| Platform | Path format | Example |
|----------|-------------|---------|
| **Windows** | Forward slashes | `J:/Sites/Apps/Synabun/mcp-server/run.mjs` |
| **WSL** | Linux mount paths | `/mnt/j/Sites/Apps/Synabun/mcp-server/run.mjs` |
| **Linux/macOS** | Native paths | `/home/user/Apps/Synabun/mcp-server/run.mjs` |

**Common pitfall:** If Claude Code runs on Windows but you use a WSL-style path like `/mnt/j/...`, Node.js will resolve it to `J:\mnt\j\...` (prepending the drive letter), which doesn't exist. Always use Windows-native paths when Claude Code runs on Windows.

**Docker startup (Windows):** If `docker` is not recognized, Docker Desktop may not be in your PATH. Either restart your terminal after installing Docker Desktop, or call it directly:
```powershell
& "C:\Program Files\Docker\Docker\resources\bin\docker.exe" compose up -d
```

**WSL networking:** If the Docker container runs on Windows (Docker Desktop) and WSL can't reach `localhost:6333`, try `host.docker.internal:6333` or check WSL 2 networking settings.

</details>

## Architecture

```
AI Assistant (any project)
    │
    │  MCP Protocol (stdio)
    │
┌───┴──────────────────┐
│   SynaBun MCP Server │  Node.js + TypeScript
│                      │
│  9 tools: remember,  │
│  recall, forget,     │
│  reflect, memories,  │
│  category_*          │
└───┬────────┬─────────┘
    │        │
    │        │  OpenAI-compatible API
    │        │  (text-embedding-3-small, 1536 dims)
    │        ▼
    │   [Embedding Provider]
    │
    │  Qdrant REST API
    ▼
┌──────────────────────┐
│   Docker: Qdrant     │  Vector database
│   localhost:6333     │
│   Collection:        │
│   claude_memory      │
└──────────────────────┘
```

## MCP Tools

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `remember` | Store a new memory | `content`, `category`, `project`, `tags`, `importance`, `subcategory` |
| `recall` | Semantic search across memories | `query`, `category`, `project`, `tags`, `limit`, `min_importance` |
| `reflect` | Update an existing memory | `memory_id` (full UUID), `content`, `importance`, `tags`, `category` |
| `forget` | Delete a memory by ID | `memory_id` |
| `memories` | List recent memories or get stats | `action` (recent, stats, by-category, by-project) |
| `category_create` | Create a new category | `name`, `description`, `parent`, `color` |
| `category_update` | Update a category | `name`, `new_name`, `description`, `parent`, `color` |
| `category_delete` | Delete a category | `name`, `reassign_to`, `reassign_children_to` |
| `category_list` | List all categories | `format` (flat, tree, parents-only) |

## Neural Interface

SynaBun includes a 3D visualization UI for browsing and managing memories.

**Start it:**
```bash
cd neural-interface
npm start
```

Then open **http://localhost:3344**

**What you get:**
- Interactive force-directed graph — memories as nodes, relationships as edges
- Click nodes to inspect, edit, or delete memories
- Semantic search bar (press `/` to focus)
- Category sidebar with filtering
- Drag nodes to pin them in 3D space
- Onboarding wizard for first-time setup

The Neural Interface also serves as the admin panel for category management — create, edit, and delete categories with a visual editor.

## Usage

### Storing memories

Format content in **Markdown** for readability:

```javascript
remember({
  content: `## Redis Price Cache Configuration

**TTL:** 1 hour (3600 seconds)
**Location:** \`orchestratorSingleton.ts\`

**Note:** Increasing TTL improves performance but delays price updates.`,
  category: "project",
  importance: 7,
  tags: ["redis", "cache", "pricing"],
  subcategory: "architecture"
})
```

### Searching memories

```javascript
recall({
  query: "how does the price caching work",
  limit: 5
})
```

Results include similarity score, importance, age, and full content. Filter by category, project, tags, or minimum importance.

### Browsing and stats

```javascript
memories({ action: "stats" })                              // Counts by category and project
memories({ action: "recent", limit: 10 })                  // Most recent
memories({ action: "by-category", category: "learning" })  // Filter by category
memories({ action: "by-project", project: "myapp" })       // Filter by project
```

### Updating memories

```javascript
reflect({
  memory_id: "8f7cab3b-644e-4cea-8662-de0ca695bdf2",  // Full UUID required
  importance: 9,
  add_tags: ["critical"]
})
```

### Deleting memories

```javascript
forget({ memory_id: "8f7cab3b-644e-4cea-8662-de0ca695bdf2" })
```

For detailed usage patterns and best practices, see [USAGE.md](./USAGE.md).

## Memory Categories

Categories are fully user-defined in `mcp-server/data/custom-categories.json`. There are no hardcoded defaults. Manage them via MCP tools or the [Neural Interface](#neural-interface).

### How Claude Decides Where to Store Memories

Category descriptions are **routing instructions** that Claude reads every time it calls `remember`. Claude reads ALL category descriptions from the tool schema and picks the best match.

```
You create categories with descriptions
        ↓
buildCategoryDescription() assembles them into a hierarchical guide
        ↓
The guide is embedded in the MCP tool schema (Zod .describe())
        ↓
Claude reads the guide when calling remember/recall/reflect
        ↓
Claude picks the category whose description best matches the memory
```

Descriptions refresh dynamically — when you change a description via MCP tools (`category_update`), the tool schemas rebuild and Claude sees the update immediately via `notifications/tools/list_changed`. No server restart needed.

### Writing Effective Descriptions

Descriptions should be **prescriptive rules**, not vague labels:

| Quality | Example |
|---------|---------|
| Bad | `"Pricing and stores"` |
| Good | `"ONLY for deal/pricing memories: store imports, price comparisons, Gamivo/YuPlay/Steam pricing. Never put project bugs here."` |
| Bad | `"Bug fixes"` |
| Good | `"Bug fixes, root cause analysis, error resolutions. Must be about actual code bugs — not feature requests or ideas."` |

**Tips:**
- Be explicit about boundaries — say what does NOT belong as much as what does
- Reference other categories by name — "use deals for pricing, use bug-fixes for bugs"
- List concrete examples — "Gamivo, YuPlay, Steam pricing data"
- Keep it under ~200 chars — Claude reads all descriptions at once, brevity helps

### Parent Categories

Parent categories group related children into visual clusters. They affect how Claude sees the hierarchy:

```
[criticalpixel] (parent) — All CriticalPixel memories go here
  bug-fixes = Bug fixes, root cause analysis, error resolutions for CP code
  databases = Database schemas, queries, migrations, Supabase config
deals = ONLY deal/pricing memories: store imports, price comparisons...
memory-system = MCP server architecture, Qdrant config, embedding pipeline...
```

Create parents via MCP tools:
```javascript
category_create({ name: "my-project", description: "All memories for my-project" })
category_update({ name: "bug-fixes", parent: "my-project" })
```

Or via the Neural Interface sidebar — click the **Parent** button, then drag categories onto it.

### Dynamic Schema Refresh

```
category_create / category_update / category_delete
  → refreshCategorySchemas()
    → invalidateCategoryCache()
    → tool.update({ paramsSchema: ... })
    → SDK sends notifications/tools/list_changed
      → Claude re-fetches tool list → sees updated descriptions
```

## Importance Scale

| Score | Meaning | When to use |
|-------|---------|------------|
| 1-2 | Trivial | Temporary workarounds, minor preferences |
| 3-4 | Low | Common patterns, routine configs |
| 5 | Normal | Standard decisions (default) |
| 6-7 | Significant | Important patterns, non-obvious fixes |
| 8-9 | Critical | Hard-won bug fixes, key architecture decisions |
| 10 | Foundational | Core architecture, security rules, owner preferences |

Memories with importance **8+** are immune to time-based relevance decay.

## How It Works

### Embedding and storage

When `remember` is called, the content text is sent to the embedding provider (default: OpenAI `text-embedding-3-small`) which returns a 1536-dimensional vector. This vector, along with the payload (content, category, tags, timestamps, etc.), is stored as a point in the Qdrant `claude_memory` collection.

### Semantic search

When `recall` is called, the query is embedded the same way, then Qdrant performs cosine similarity search. Results are re-ranked with:

- **Time decay** — 90-day half-life (older memories score lower, unless importance >= 8)
- **Project boost** — memories from the current project get a 1.2x score multiplier
- **Access boost** — frequently recalled memories get a small relevance increase

### Payload indexes

The collection has keyword indexes on `category`, `project`, `tags`, `subcategory`, `source`, `created_at`, and integer indexes on `importance` and `access_count`. This makes filtered searches fast even with thousands of memories.

### Access tracking

Every time a memory is returned by `recall`, its `accessed_at` timestamp and `access_count` are updated (fire-and-forget, non-blocking).

## Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `QDRANT_MEMORY_URL` | `http://localhost:6333` | Qdrant REST API URL |
| `QDRANT_MEMORY_API_KEY` | `claude-memory-local-key` | Qdrant API key |
| `QDRANT_MEMORY_COLLECTION` | `claude_memory` | Collection name |
| `OPENAI_EMBEDDING_API_KEY` | — | **Required.** API key for embedding provider |
| `EMBEDDING_BASE_URL` | `https://api.openai.com/v1` | Base URL for OpenAI-compatible embedding API |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model name |
| `EMBEDDING_DIMENSIONS` | `1536` | Vector dimensions |
| `NEURAL_PORT` | `3344` | Neural Interface server port |

Set these in the `.env` file at the project root, or pass them via the `.mcp.json` env block.

### Changing the API key

Edit `.env`, then restart the Docker container and update the Claude MCP registration to match:

```env
QDRANT_MEMORY_API_KEY=your-new-key
```

## Embedding Providers

Any provider with an OpenAI-compatible `/v1/embeddings` endpoint works. Set `EMBEDDING_BASE_URL` and `OPENAI_EMBEDDING_API_KEY` accordingly.

| Provider | Base URL | Models |
|----------|----------|--------|
| **OpenAI** (default) | `https://api.openai.com/v1` | text-embedding-3-small, text-embedding-3-large |
| **Google Gemini** | `https://generativelanguage.googleapis.com/v1beta/openai` | text-embedding-004 |
| **Qwen / DashScope** | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | text-embedding-v4 |
| **Together AI** | `https://api.together.xyz/v1` | Various open-source models |
| **Fireworks AI** | `https://api.fireworks.ai/inference/v1` | nomic-embed, thenlper/gte |
| **Jina AI** | `https://api.jina.ai/v1` | jina-embeddings-v3 |
| **Mistral** | `https://api.mistral.ai/v1` | mistral-embed |
| **Voyage AI** | `https://api.voyageai.com/v1` | voyage-4-large, voyage-3.5-lite |
| **Cohere** | `https://api.cohere.com/compatibility/v1` | embed-v4.0 |
| **Cloudflare Workers AI** | `https://api.cloudflare.com/client/v4/accounts/{id}/ai/v1` | @cf/baai/bge-base-en-v1.5 |
| **Ollama** (local) | `http://localhost:11434/v1` | nomic-embed-text, mxbai-embed-large |
| **LM Studio** (local) | `http://localhost:1234/v1` | Any loaded GGUF embedding model |

> **Note:** xAI (Grok) has an OpenAI-compatible chat API but does not offer an embedding endpoint.

> **Important:** Switching embedding models after storing memories is a breaking change. See [Embedding Model Migration](#embedding-model-migration).

## Embedding Model Migration

Changing your embedding model — even between models from the **same provider** — is a breaking change. Vectors from different models live in incompatible mathematical spaces.

| Change | Same dimensions? | Compatible? |
|--------|:---:|:---:|
| `text-embedding-ada-002` → `text-embedding-3-small` | Yes (both 1536) | **No** |
| `text-embedding-3-small` → `text-embedding-3-large` | No (1536 vs 3072) | **No** |
| OpenAI → Ollama `nomic-embed-text` | No (1536 vs 768) | **No** |

**Rule:** Any model swap makes existing memories unsearchable.

<details>
<summary><strong>Migration procedure</strong></summary>

Since SynaBun stores the original text in every memory payload, you can re-embed everything:

1. **Export all memories** — query Qdrant to get all points with their payloads
2. **Create a new collection** — with the correct vector dimensions for the new model
3. **Re-embed each memory** — send the stored `content` text through the new model
4. **Insert into the new collection** — same payloads, new vectors
5. **Swap collection name** — update `QDRANT_MEMORY_COLLECTION` in your config
6. **Delete the old collection** (optional)

**Cost/time:** Re-embedding 1,000 memories with OpenAI costs ~$0.001 and takes a few seconds. With local models (Ollama), it's free but slower depending on hardware.

</details>

<details>
<summary><strong>Safe changes (no migration needed)</strong></summary>

- Adding new payload fields to memories
- Adding/editing/deleting categories
- Changing importance scores, tags, or other metadata
- Upgrading the MCP server code
- Adding payload indexes to the collection

</details>

**Recommendation:** Choose your embedding model during initial setup and stick with it.

## CLAUDE.md Integration

Add this to any project's `CLAUDE.md` to instruct Claude to use memory automatically:

<details>
<summary><strong>Show CLAUDE.md template</strong></summary>

```markdown
## Persistent Memory

You have persistent vector memory via the `SynaBun` MCP server tools:
remember, recall, forget, reflect, memories.

### Auto-Recall (do this automatically)
- At session start: recall context about the current project
- When user mentions a specific topic: recall what you know
- Before architecture decisions: recall past decisions
- When debugging: recall past similar bugs

### Auto-Remember (do this automatically)
- After fixing a hard bug: remember the solution (importance 7+)
- After architecture decisions: remember the decision and why (importance 8+)
- When user says "remember this": importance 8+
- API quirks or gotchas discovered: remember as learning
- Session-ending context: remember ongoing work as conversation

### Memory Tool Quirks
- When using `remember`, omit `tags` and `importance` params (they cause type errors via XML serialization). Use `reflect` after to set them.
- The `reflect` tool's ID parameter is `memory_id` (not `id`).
- `reflect` requires the FULL UUID, not the shortened ID shown in tool output. Use `recall` first to get the full UUID.
- Make memory MCP calls sequentially, not in parallel — one failure cascades to all sibling calls in the batch.
```

</details>

## Multi-Project Support

The `project` field is auto-detected from the working directory name. Memories from different projects are stored in the same collection but can be filtered independently.

When `recall` is called without a project filter, it searches **all** projects but gives a 1.2x boost to results matching the current project. Cross-project knowledge (like general patterns or tool usage) is still surfaced when relevant.

## Docker Management

```bash
cd /path/to/Synabun

docker compose up -d        # Start Qdrant
docker compose down         # Stop Qdrant
docker compose logs -f      # View logs
docker compose restart      # Restart
```

Data persists in a Docker volume (`qdrant-storage`). This survives container restarts and rebuilds.

The Qdrant dashboard is available at **http://localhost:6333/dashboard**.

### Rebuilding after code changes

```bash
cd mcp-server
npm run build
```

No need to restart Claude Code — the MCP server is spawned fresh on each session.

## Known Limitations

### 1. `reflect` requires full UUID

The `remember` tool returns a shortened ID (e.g., `[8f7cab3b]`), but `reflect` requires the **full UUID**.

```
reflect({ memory_id: "8f7cab3b" })                                    // Bad Request
reflect({ memory_id: "8f7cab3b-644e-4cea-8662-de0ca695bdf2" })        // Works
```

**Fix:** Use `recall` to get the full UUID before calling `reflect`.

### 2. Parameter type limitations (AI-specific)

Some AI assistants using XML-based tool calling may serialize all parameters as strings, causing validation errors for array/number parameters.

**Workaround:** Omit `tags` and `importance` from `remember` calls, then use `reflect` immediately after to set them.

### 3. Parallel tool call failures

When making parallel MCP tool calls, if one fails, all sibling calls in that batch may fail. Make memory calls sequentially.

## Troubleshooting

<details>
<summary><strong>Common issues and fixes</strong></summary>

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Failed to reconnect to memory` | Qdrant container not running | `docker compose up -d` |
| `docker: command not found` (Windows) | Docker Desktop not in PATH | Add Docker to PATH or restart terminal |
| `Cannot find module '.../dist/index.js'` | TypeScript not compiled | `npm run build` inside `mcp-server/` |
| `npx tsc` installs wrong package | npm's `tsc` package shadows TypeScript | Use `npm run build` instead |
| Node resolves path to `J:\mnt\j\...` | WSL path used with Windows Claude Code | Use Windows paths (`J:/...`) |
| `fetch failed` / connection refused | Qdrant not reachable | Check container is running, port 6333 open |
| WSL can't reach `localhost:6333` | Docker container on Windows host | Try `host.docker.internal:6333` |
| `remember` fails with type errors | `tags`/`importance` passed as strings | Omit these params, use `reflect` after |
| `reflect` returns "Bad Request" | Using shortened ID | Use `recall` to get full UUID first |
| "Sibling tool call errored" | Parallel MCP call batch failure | Make memory calls sequentially |

</details>

## Cost

OpenAI `text-embedding-3-small` costs **$0.02 per 1M tokens**. A typical memory is ~50 tokens.

- Storing 1,000 memories: ~$0.001
- Each `recall` query: ~$0.000001

Cost is negligible even with heavy usage. Local providers (Ollama, LM Studio) are free.

## File Structure

```
Synabun/
├── docker-compose.yml              # Qdrant container definition
├── .env                            # API key config (generated by setup wizard)
├── README.md                       # This file
├── USAGE.md                        # Detailed usage patterns & best practices
├── CLAUDE.md                       # Claude Code project instructions
├── public/
│   └── synabun.png                 # Logo
├── neural-interface/               # 3D visualization UI (http://localhost:3344)
│   ├── server.js                   # Express API — memory proxy, category CRUD
│   ├── package.json
│   └── public/
│       ├── index.html              # Three.js force-directed graph
│       ├── onboarding.html         # Setup wizard
│       └── synabun.png             # Logo
└── mcp-server/                     # MCP server (Node.js + TypeScript)
    ├── package.json
    ├── tsconfig.json
    ├── run.mjs                     # Entry wrapper (sets cwd, imports dist/)
    ├── data/
    │   └── custom-categories.json  # Category definitions (single source of truth)
    ├── dist/                       # Compiled JS (generated by npm run build)
    └── src/
        ├── index.ts                # Tool registration + schema refresh
        ├── config.ts               # Environment config, project detection
        ├── types.ts                # MemoryPayload interface
        ├── tui.ts                  # Terminal UI for interactive management
        ├── services/
        │   ├── qdrant.ts           # Qdrant client, collection management
        │   ├── embeddings.ts       # Embedding generation
        │   └── categories.ts       # Category CRUD, hierarchy, descriptions
        └── tools/
            ├── remember.ts         # Store a memory
            ├── recall.ts           # Semantic search with time decay
            ├── forget.ts           # Delete a memory
            ├── reflect.ts          # Update a memory
            ├── memories.ts         # List and stats
            ├── category-create.ts  # Create category (triggers schema refresh)
            ├── category-update.ts  # Edit category (triggers schema refresh)
            ├── category-delete.ts  # Delete category (triggers schema refresh)
            └── category-list.ts    # List categories with hierarchy
```
