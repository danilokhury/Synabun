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
| Qdrant (Docker) | `localhost:6333` | API key |
| Neural Interface | `0.0.0.0:3344` | None |
| MCP Server | stdio (no network) | N/A |

**Important:** The Neural Interface binds to all network interfaces (`0.0.0.0`) by default, which means it is accessible from other devices on your network. If you need to restrict access, set up a firewall rule or reverse proxy.

## Sensitive Files

| File | Contains | Gitignored? |
|------|----------|:-----------:|
| `.env` | Embedding API key, Qdrant API key | Yes |
| `connections.json` | Qdrant URLs and API keys per connection | Yes |
| `mcp-server/data/custom-categories.json` | Category names and descriptions only | No (safe) |

**Never commit `.env` or `connections.json` to version control.** Both are listed in `.gitignore` by default. If you accidentally commit them, rotate all API keys immediately.

## API Key Handling

- The Neural Interface's `/api/settings` endpoint **masks API keys** in responses (shows only the last 4 characters).
- API keys are never logged to stdout/stderr.
- Keys are read from `.env` and `connections.json` at startup and on config reload.

## Recommendations

1. **Use a strong Qdrant API key.** The setup wizard generates a random 32-character hex key. Do not use the default placeholder.
2. **Restrict Qdrant port access.** If running on a shared network, use a firewall to block external access to port 6333.
3. **Do not expose the Neural Interface to the public internet.** It has no authentication. Use it only on localhost or behind a VPN/reverse proxy with auth.
4. **Use `.env.example` as a template.** Copy it to `.env` and fill in your values. The example file contains only placeholders.
5. **Review `connections.json` before sharing.** If you export your SynaBun configuration, strip API keys from connection entries first.

## Dependency Security

SynaBun depends on:
- **Qdrant** (Docker image) — check [Qdrant security advisories](https://github.com/qdrant/qdrant/security)
- **OpenAI Node SDK** — for embedding generation
- **Express.js** — for the Neural Interface server
- **@modelcontextprotocol/sdk** — for MCP protocol communication

Run `npm audit` periodically in both `mcp-server/` and `neural-interface/` to check for known vulnerabilities.
