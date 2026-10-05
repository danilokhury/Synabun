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

## WebSocket Origin Check

Browsers do not apply CORS to WebSockets, so without a check any web page open in the same browser could connect to `ws://localhost:3344/ws/*` — the terminals, the Assistant, sync — and act as the user (cross-site WebSocket hijacking). Every upgrade now passes `isAllowedWebSocketOrigin` (`neural-interface/lib/http-guards.js`) before any handler or the hand-off to the terminal host: a request that carries an `Origin` must come from the server as the request reached it (`http(s)://<Host>`), a loopback origin on the Neural Interface port, the running Cloudflare tunnel's URL, or the invite proxy URL in use; anything else (including `null`, `file:` pages and extensions) gets `403` and the socket closes. Clients that send no `Origin` (CLI tools, the `ws` package) are not browsers and pass.

The request's own host counts only when the Host is one of SynaBun's names (`isAllowedHost`), which stops DNS rebinding (a page at `attacker.example:3344` whose name now points at 127.0.0.1). The allowed names are `localhost`, `*.localhost`, 127.0.0.0/8, `[::1]`, any IP literal (v4 or v6: an IP cannot be rebound), this machine's `os.hostname()` and `<hostname>.local`, and the host names of the tunnel and invite-proxy URLs. Case is ignored and one trailing dot is stripped; userinfo, %-escapes and other junk are refused. `PUT /api/invite/proxy` checks the Host the same way, so a rebound page cannot add its own name to the invite-proxy list the check trusts.

What this means for access paths: a reverse proxy that keeps a custom domain as Host (Caddy, nginx) is refused on `/ws/*` unless it is the configured invite proxy. So are `/etc/hosts` aliases and Tailscale MagicDNS names; use an IP address, `*.localhost` or the machine name instead.

## WhatsApp Link

The WhatsApp Link lets the owner chat with the SynaBun Assistant from WhatsApp as a *linked device* of an account ([docs/whatsapp.md](docs/whatsapp.md)). Summary of its threat model:

- **Local-only control.** `/api/whatsapp` answers only the person at the computer: no invite guests, no tunnel or proxy headers, a loopback socket, a `localhost` / `127.0.0.1` / `[::1]` `Host` on SynaBun's port (DNS rebinding), and for every state-changing route the page's own `Origin`, a JSON body, `X-SynaBun-UI: 1` and no agent header. No CORS headers, ever. It is also on the admin-only list, and its `whatsapp:` sync broadcasts go to owner sockets only. Agents may only `POST /pause` (it lowers privileges).
- **Owner binding.** Only the owner is ever answered. In *Message yourself* mode that is the linked account's own chat, typed on the phone (device 0), after the user confirmed the account on the computer (10 minutes, or it is logged out again); in second-number mode, the account that sent a one-time claim code (`SB-` + 6 digits, 10 minutes, 5 wrong attempts). The host's single send call addresses the bound owner; no operation takes an address; other chats, groups and strangers are dropped and only counted.
- **What a message may do.** A WhatsApp session runs at a level: Read-only, Ask (default: the phone approves each risky action) or Autonomous (8 hours, turned on only by the computer *and* an `ALLOW` code from the phone). Enforcement lives in the Assistant runtime, the Claude brain's hooks, the dispatcher and the permission endpoint (`neural-interface/lib/remote-policy.js`), not in the phone.
  - **Ask and Autonomous hold on a Claude brain only.** Its in-process hook sees every call with its arguments. A Codex brain runs ordinary commands in its sandbox without asking, and an OpenCode brain keeps its own permissions, so a WhatsApp conversation on either is Read-only whatever the configured level: Codex runs in its read-only sandbox with the network off, and OpenCode runs the plan agent with `webfetch`, `websearch` and `codesearch` refused by the gate plugin (no turn runs until that plugin is loaded). The phone and the Settings tab both say so.
  - **What cannot run at any level.** Computer use is off. Forwarded or quoted third-party text, and pictures, are treated as untrusted and cap that turn at Ask. A phone card shows the complete request or stays desktop-only. One route approval starts one agent.
  - **The denylist is a speed bump, not a sandbox.** Commands or paths that reach credentials, the WhatsApp session, SynaBun's own settings, persistence points or browser profiles are refused, and so is a call whose arguments the host did not pass. The list matches text, though, so a shell that builds a path at run time gets past it. **Autonomous can read any file your computer account can, including SynaBun's WhatsApp login. Use it only with a locked phone, ideally on a second number.**
- **Credentials.** The WhatsApp session keys live in `DATA_HOME/whatsapp/auth/` (`%LOCALAPPDATA%\synabun\whatsapp` on Windows), outside every folder a backup copies, so backups never copy a live session. A `SYNABUN_WHATSAPP_HOME` inside `data/`, `mcp-data/` or another backup root is refused. On macOS and Linux the store refuses to open (`AUTH_PERMS`) unless its folder is 0700, its files are 0600 and all of them belong to you. The connector runs as a separate process with an allowlisted environment (no API keys) whose console output is dropped or redacted. **Unlink** logs the device out and wipes the keys; a lost phone can also log SynaBun out under WhatsApp → Linked devices.
- **Redaction.** Events leaving the WhatsApp process carry masked numbers (`••••1234`) at most, never a JID or phone number. The link QR and pairing code travel only down the requesting tab's NDJSON stream, the claim code only down the claim stream, the ALLOW code only in the `PUT /config` answer. An `ALLOW 1234` answer from the phone is consumed before anything is logged. Every log line passes through `redactWa`, which also masks `ALLOW <code>`; message text is kept in the activity log only when the user turns that on.
- **Unofficial client.** SynaBun uses Baileys, an unofficial WhatsApp Web client. WhatsApp's Help Center warns that unofficial apps "may result in a temporary or permanent account ban". SynaBun keeps traffic low (no online presence on connect, no delivery receipts, one reply stream to one person, paced sends capped at 10 a minute / 120 an hour / 500 a day), but the risk is not zero; the second-number mode keeps it off the user's own account. Baileys and its GPL-3.0 dependency libsignal are installed on demand from an integrity-pinned lockfile (`npm ci --ignore-scripts`), never shipped with SynaBun (`SYNABUN_WHATSAPP=off` is the kill switch).

## Known Residual Issues

Found during the WhatsApp Link review and left for follow-up work:

- **The Discord bot token is readable over HTTP.** `GET /api/discord/config` (`neural-interface/server.js`) returns `DISCORD_BOT_TOKEN` unmasked, and `/api/discord` is not on the admin-only list, so any client that reaches the Neural Interface — an invite guest included — can read it. It should be masked like `/api/settings` and made admin-only.
- **No local API token.** Apart from `/api/whatsapp`, the Neural Interface API has no authentication: any local process, any device on the network (it binds to all interfaces), and a web page using DNS rebinding can call it. The WebSocket Origin check stops cross-site and DNS-rebound pages on `/ws/*`, and `PUT /api/invite/proxy` checks the Host, but other HTTP routes have no app-wide Host check yet.
- **The WhatsApp denylist is lexical.** `isDeniedRemoteTool` matches command and path text, so a shell that builds a path at run time (variables, globs, `cd` then a relative path) gets past it. The real limits are the level, the phone's approvals at Ask, and an OS account that holds nothing else of value.
- **Claude worker `workspace` capability.** A Claude Code worker dispatched with capability `workspace` currently gets the same tool access as `full`; only Codex enforces a `workspace-write` sandbox.
- **Plan mode is not a sandbox.** The Assistant's plan mode blocks code changes only: commands, computer use, the browser and every other tool run under the session's approval mode, and a shell command that edits files is held back by the brain's instructions, not enforced. The WhatsApp Read-only level's plan mode stays read-only, but it still allows read tools that make outbound requests, including `WebFetch` and SynaBun's `browser_navigate`, which can carry data out in a URL.

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
