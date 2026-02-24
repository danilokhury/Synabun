---
category: development
tags: [security, authentication, api-keys, gitignore, localhost, vulnerabilities]
importance: 8
project: synabun
source: self-discovered
subcategory: config
related_files:
  - SECURITY.md
  - .gitignore
  - .env.example
---

# SynaBun Security Model

## Architecture: Local-first

All components designed to run on localhost.

## Component Security

| Component | Binding | Auth | Risk |
|-----------|---------|------|------|
| Qdrant | localhost:6333 | API key (`QDRANT__SERVICE__API_KEY`) | Low (local only) |
| Neural Interface | 0.0.0.0:3344 | **NONE** | **High on shared networks** |
| MCP Server | stdio | N/A (parent process only) | None |

The Neural Interface binding to `0.0.0.0:3344` with no authentication is the main security concern — anyone on the same network can access all memories, settings, and API keys.

## Sensitive Files (both gitignored)

- `.env`: Contains `OPENAI_EMBEDDING_API_KEY`, `QDRANT_MEMORY_API_KEY`, and other secrets
- `connections.json`: Contains Qdrant URLs and API keys for all configured connections

## Safe Files (not gitignored)

- `mcp-server/data/custom-categories.json`: Category definitions only, no secrets

## API Key Handling

- Neural Interface masks keys in `GET /api/settings` response (shows first 4 + last 4 chars only)
- Keys are never logged to console
- Onboarding wizard generates random 32-char hex Qdrant API key during setup

## Recommendations

1. Use a strong, random Qdrant API key (not the default `claude-memory-local-key`)
2. Firewall port 6333 and 3344 on shared/public networks
3. Never expose the Neural Interface to the public internet
4. Consider binding Neural Interface to `127.0.0.1` instead of `0.0.0.0` for production
5. Run `npm audit` periodically to check for dependency vulnerabilities
6. Report vulnerabilities via GitHub private vulnerability reporting (see SECURITY.md)
