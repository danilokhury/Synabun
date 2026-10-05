<p align="center">
  <img src="https://raw.githubusercontent.com/danilokhury/Synabun/main/public/synabun.png" alt="SynaBun" width="120" />
</p>

<h1 align="center">SynaBun</h1>

<p align="center">
  Long-term memory for your AI coding tools, stored on your own computer.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/synabun"><img src="https://img.shields.io/npm/v/synabun?color=cb3837&logo=npm&logoColor=white" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/synabun"><img src="https://img.shields.io/npm/dm/synabun?color=cb3837&logo=npm&logoColor=white" alt="npm downloads" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/synabun?color=blue" alt="license" /></a>
  <a href="https://github.com/danilokhury/Synabun/actions/workflows/ci.yml"><img src="https://github.com/danilokhury/Synabun/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://discord.gg/x6yWqE9GZP"><img src="https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white" alt="Discord" /></a>
  <a href="https://x.com/SynabunAI"><img src="https://img.shields.io/badge/Follow-%40SynabunAI-000000?logo=x&logoColor=white" alt="X / Twitter" /></a>
</p>

<p align="center">
  <a href="https://synabun.ai">synabun.ai</a> · <a href="https://synabun.ai/docs">Docs</a> · <a href="https://synabun.ai/blog">Blog</a> · <a href="https://synabun.ai/compare">Compare</a> · <a href="https://synabun.ai/changelog">Changelog</a>
</p>

---

SynaBun gives your AI coding tools a memory that lasts. What you decided, fixed and explained in one session is there in the next one, in every project and every tool you connect, so you stop repeating yourself. It all lives in one file on your computer: no account, no cloud service, no API key.

It connects to Claude Code, Codex CLI, Gemini CLI and OpenCode with one switch each, and to Cursor, Windsurf or any other tool that supports MCP (the Model Context Protocol) with a config snippet you copy. It comes with the Neural Interface, a local web app where you see what your tools remember and run your coding agents.

## What you can do with it

- **Keep context between sessions.** Your assistant saves what it learned as it works and looks it up before the next task. Search matches meaning as well as keywords.
- **See what it knows.** Browse, search, edit and delete memories in the Neural Interface, on a 3D map where related memories sit together.
- **Run Claude Code, Codex and OpenCode side by side.** Each has a side panel in the Neural Interface, next to terminals, a file explorer and a whiteboard, all sharing the same memory.
- **Delegate.** The SynaBun Assistant plans a task, proposes a model for it, hands it to a worker in Claude Code, Codex or OpenCode and reports the result. You can also message it from WhatsApp.
- **Automate.** Save a task as a template, then run it as a loop or on a schedule.
- **Give agents a browser.** Browser tools let an agent open pages, click, type and read in a browser you can watch.

## Quick start

You need [Node.js](https://nodejs.org) 22.19 or newer.

```bash
npm install -g synabun
npm --prefix "$(npm root -g)/synabun/mcp-server" run setup:embeddings
synabun
```

1. **Install.** The first command installs SynaBun. The second downloads the model that powers search by meaning; without it SynaBun still works, with keyword search only. In Windows Command Prompt, replace `$(npm root -g)` with the path that `npm root -g` prints.
2. **Start.** `synabun` starts the Neural Interface at `http://localhost:3344` and opens the setup wizard in your browser. The first start also installs a Chromium build for the browser tools.
3. **Connect your AI tool.** In the wizard, add your projects and switch on the tools you use. SynaBun registers itself with Claude Code, Codex CLI, Gemini CLI and OpenCode, and installs a short set of rules that tell each tool when to recall and when to remember. For Cursor, Windsurf or another MCP tool, copy the config snippet shown in the same step. You can change the connections later in **Settings → AI connections**.
4. **Try it.** Start a new session in your AI tool and say:

   > Remember that we deploy from the `release` branch, never from `main`.

   Start another session and ask:

   > What do you remember about how we deploy?

   Then open `http://localhost:3344` to see the memory on the map. Press `/` to search, `a` to open the Assistant, and the **?** button in the title bar for a tour.

Leave `synabun` running while you work: Claude Code reaches its memory through it. Stop it with `Ctrl+C`. If something looks wrong, `synabun doctor` reports the state of your data and your tool connections.

To run from source instead:

```bash
git clone --depth=1 https://github.com/danilokhury/Synabun.git
cd Synabun
npm start
```

`npm start` installs dependencies, builds the MCP server and starts the app. Once it is up, run `npm --prefix mcp-server run setup:embeddings` in a second terminal to turn on search by meaning.

## How it works

```
Your AI tool ── MCP ──▶ SynaBun MCP server ──▶ memory.db (SQLite) ◀── Neural Interface (localhost:3344)
```

- **A local database.** Memories live in one SQLite file on your disk. Each one is indexed for keyword search and for search by meaning, using a model that runs on your machine.
- **An MCP server.** It gives your AI tool the memory tools: `remember`, `recall`, `reflect`, `forget`, `restore` and a few more. Any MCP client can use it.
- **The Neural Interface.** A local web app on port 3344 that reads the same database. It holds the memory map, settings, the side panels, the Assistant and your automations.
- **Rules and hooks.** The installed rules tell each tool to recall before substantial work and to remember after it. In Claude Code, hooks add to that: they bring relevant memories into the session and remind the assistant to save its work.

## Features

### Memory

- **Keyword and meaning search.** `recall` combines both and can return compact results sized to a token budget.
- **Categories you define.** Each category's description tells the assistant what belongs there.
- **One memory for every project.** Recall favours the project you are in and still finds what you learned elsewhere.
- **Hard to lose.** Edits keep a revision history you can undo, deleted memories go to a trash you can restore from, and `sync` flags memories whose source files have changed.
- **Backups.** Scheduled, checksum-verified backups in **Settings → Memory & backups**. `synabun restore-backup --from <backup.zip>` checks a backup, and adding `--apply` restores it.

### Neural Interface

- **Memory map.** A 3D map of everything stored: top-level categories are continents, categories are islands, and similar memories sit side by side.
- **Workspace.** Terminals, a file explorer and a whiteboard next to your memories.
- **Settings you can search**, in English and Brazilian Portuguese.
- **A workspace tour** behind the **?** button.

### Coding agents

- **Side panels for Claude Code, Codex and OpenCode.** Streaming answers, tool calls, approvals, plans and resumable sessions, on your own accounts. Gemini CLI and plain shells open as terminal tabs.
- **SynaBun Assistant.** One assistant that recalls memory on every turn, proposes where a task should run, dispatches it to a worker and reads back a structured result. Budget caps and a token gauge keep spending visible.
- **WhatsApp Link.** Message the Assistant from your phone as a linked device, with three permission levels. See [docs/whatsapp.md](./docs/whatsapp.md).
- **Computer use on macOS.** The Assistant can see and operate desktop apps, behind guards and stop controls.
- **Style Guide.** A brand and design system per project, saved as `DESIGN.md` and design tokens. Agents read it and can only propose changes. See [docs/style-guide.md](./docs/style-guide.md).

### Automations and tools

- **Automation Studio and schedules.** Task templates you run as loops or on a schedule.
- **Browser tools.** Navigate, click, type, read and take screenshots, or batch several actions into one call. See [docs/browser-v2.md](./docs/browser-v2.md).
- **Integrations.** Tool groups for Discord, Google Search Console, YouTube Studio, Leonardo.ai and Bluesky, and readers for X, Facebook, Instagram, LinkedIn, TikTok and WhatsApp Web. Tool profiles limit a session to the groups it needs.
- **Skills.** [`/synabun`](./skills/synabun/SKILL.md) brainstorms from memory, audits memories against your code, saves a conversation and creates schedules. [`/leonardo`](./skills/leonardo/SKILL.md) guides image and video prompts.
- **Claude Code hooks.** How they are installed, isolated and measured: [docs/hook-integrity.md](./docs/hook-integrity.md).
- **AI decisions (optional).** With your own TypeSafe API key, SynaBun asks for a judgment where a fixed rule would guess: is this memory a duplicate, does it hold a secret, is it stale. Every judgment has a local fallback, and nothing is sent without a key. See [docs/judgments.md](./docs/judgments.md).

## Requirements

- **Node.js 22.19 or newer.**
- **macOS, Windows or Linux.** Computer use is macOS only.
- **The coding tools you want to use**, installed and signed in with your own accounts. SynaBun does not include model access.
- **Optional: C/C++ build tools.** Terminals use a native module. If it has no prebuilt binary for your system, it is compiled during install; if that fails, everything except terminals still works.
- **Optional: credentials for integrations** such as Discord, YouTube or AI decisions. You enter them in Settings when you turn the feature on.

## Updating

```bash
npm install -g synabun@latest
npm --prefix "$(npm root -g)/synabun/mcp-server" run setup:embeddings
```

SynaBun also offers new versions inside the app. Either way, run the second command after each update: the search model is kept inside the installed package, which the update replaces. If recall reports `Local embeddings unavailable; keyword retrieval used.`, this is the fix.

**Coming from 2026.x?** Run `npm i -g synabun@latest` once by hand. Versions used to be dates (`2026.9.5`) and are now plain semver (`2.0.0`), so the in-app update check of an older install does not offer 2.0.0. From 2.0.0 on, the in-app updater works as before.

**Running from source?** `git pull --ff-only`, then `npm run mcp:build` and `npm start`.

Before a new version starts for the first time, SynaBun takes a verified snapshot of your data and keeps it in `backups/updates` in your data folder. If it cannot take the snapshot, it stops instead of starting.

## Your data and privacy

Everything SynaBun stores is in one folder outside the app: `~/.synabun` on macOS and Linux, `%APPDATA%\synabun` on Windows. Set `SYNABUN_DATA_HOME` to use another place.

```
~/.synabun/
├── .env                 # settings and credentials for integrations
├── data/                # interface state, schedules, logs
├── backups/             # backups and pre-update snapshots
└── mcp-data/memory.db   # your memories
```

- **Your memories stay on your machine.** The database is a local file and the search model runs locally.
- **What does leave it.** Your AI tools send your prompts, and the memories they recall, to their own providers. Optional features (AI decisions, WhatsApp, Discord, the browser) talk to their services once you set them up. SynaBun checks npm and GitHub for new versions, and the interface loads web fonts and one script from public CDNs.
- **Keep it on a network you trust.** The Neural Interface has no login and listens on all network interfaces. Do not expose port 3344 to the internet. The full security model is in [SECURITY.md](./SECURITY.md).
- **Back up from the app.** Copying `memory.db` by hand while SynaBun is running can miss recent writes.

## Links

- [Changelog](./CHANGELOG.md): what is new in 2.0.0 and before
- [Security](./SECURITY.md): security model and how to report a vulnerability
- [Contributing](./CONTRIBUTING.md): bug reports and feature requests are welcome as [issues](https://github.com/danilokhury/Synabun/issues); pull requests are not accepted
- [Website](https://synabun.ai), [docs](https://synabun.ai/docs) and [blog](https://synabun.ai/blog)
- Community: [Discord](https://discord.gg/x6yWqE9GZP) and [X](https://x.com/SynabunAI)

## License

Licensed under the [Apache License, Version 2.0](./LICENSE).

You are free to use, modify, and distribute SynaBun under Apache 2.0. Premium features and enterprise extensions may be offered under a separate commercial license. See [LICENSE-COMMERCIAL.md](./LICENSE-COMMERCIAL.md) for details. Third-party notices are in [NOTICE](./NOTICE) and [THIRD-PARTY-LICENSES.md](./THIRD-PARTY-LICENSES.md).

## Trademark Notice

"SynaBun" is a trademark of its authors. The license does not grant permission to use the SynaBun name, trademarks, service marks, or branding. If you fork this project, you must use a different name for your derivative work.
