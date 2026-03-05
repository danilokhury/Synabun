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
| SQLite | data/memory.db (file) | N/A (file system permissions) | Low (local only) |
| Neural Interface | 0.0.0.0:3344 | **NONE** | **High on shared networks** |
| MCP Server | stdio | N/A (parent process only) | None |

The Neural Interface binding to `0.0.0.0:3344` with no authentication is the main security concern — anyone on the same network can access all memories, settings, and API keys.

## Sensitive Files (both gitignored)

- `.env`: Contains configuration settings
- `connections.json`: Contains database paths and settings for all configured connections

## Safe Files (not gitignored)

- `mcp-server/data/custom-categories.json`: Category definitions only, no secrets

## API Key Handling

- Neural Interface masks keys in `GET /api/settings` response (shows first 4 + last 4 chars only)
- Keys are never logged to console
- Onboarding wizard configures the SQLite database path during setup

## Recommendations

1. Protect the `data/memory.db` file with appropriate file system permissions
2. Firewall port 3344 on shared/public networks
3. Never expose the Neural Interface to the public internet
4. Consider binding Neural Interface to `127.0.0.1` instead of `0.0.0.0` for production
5. Run `npm audit` periodically to check for dependency vulnerabilities
6. Report vulnerabilities via GitHub private vulnerability reporting (see SECURITY.md)
