# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in SynaBun, please report it responsibly:

1. **Do NOT open a public GitHub issue** for security vulnerabilities.
2. Use [GitHub's private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) to submit your report.
3. Include: description of the vulnerability, steps to reproduce, and potential impact.

We will acknowledge reports within 72 hours and aim to release a fix within 7 days for critical issues.

## Security Model

SynaBun is designed as a **local-first** tool. All components run on your machine:

| Component | Default Binding | Auth |
|-----------|----------------|------|
| SQLite Database | File-based (`~/.synabun/mcp-data/memory.db`) | N/A (filesystem) |
| Neural Interface | `0.0.0.0:3344` | None |
| MCP Server | stdio (no network) | N/A |

**Important:** The Neural Interface binds to all network interfaces (`0.0.0.0`) by default, which means it is accessible from other devices on your network. If you need to restrict access, set up a firewall rule or reverse proxy.

## Sensitive Files

| File | Contains | Repository status |
|------|----------|-------------------|
| `~/.synabun/.env` | Configuration and integration credentials | Outside the checkout |
| `~/.synabun/data/mcp-api-key.json` | API key for HTTP MCP transport | Outside the checkout |
| `~/.synabun/mcp-data/memory.db` | Memories, metadata, and vectors | Outside the checkout |
| `~/.synabun/mcp-data/custom-categories-*.json` | User-defined category names and descriptions | Outside the checkout |

On Windows, the default data home is `%APPDATA%\synabun`. `SYNABUN_DATA_HOME` can override these locations. Never copy runtime configuration or data into the repository. If credentials are exposed, rotate them immediately.

## API Key Handling

- The Neural Interface's `/api/settings` endpoint **masks API keys** in responses (shows only the last 4 characters).
- API keys are never logged to stdout/stderr.
- Keys are read from the data-home `.env` file at startup and on config reload.

## Tunnel Security

The Neural Interface blocks all Cloudflare tunnel traffic (detected via `cf-connecting-ip` header) except to the `/mcp` endpoint. This prevents accidental exposure of the management UI when using tunnels for remote MCP access.

## Recommendations

1. **Protect the data home.** `~/.synabun` contains memories, configuration, credentials, backups, and runtime metadata. Restrict it with filesystem permissions.
2. **Do not expose the Neural Interface to the public internet.** It has no authentication. Use it only on localhost or behind a VPN/reverse proxy with auth.
3. **Back up regularly.** Use SynaBun's backup controls or copy `~/.synabun/mcp-data/memory.db` while SynaBun is stopped.

## Dependency Security

SynaBun depends on:
- **@huggingface/transformers** — for local embedding generation (ONNX runtime)
- **Express.js** — for the Neural Interface server
- **@modelcontextprotocol/sdk** — for MCP protocol communication

Run `npm audit` periodically in both `mcp-server/` and `neural-interface/` to check for known vulnerabilities.
