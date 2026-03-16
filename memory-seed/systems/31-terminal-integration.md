---
category: neural-interface
tags: [terminal, pty, profiles, file-browser, branches]
importance: 6
project: synabun
source: self-discovered
related_files:
  - neural-interface/server.js
---

# SynaBun Terminal Integration

The Neural Interface includes a built-in terminal system using node-pty and WebSocket connections.

## Features

- **PTY Terminal Sessions**: Full terminal emulator with node-pty backend
- **Multiple Profiles**: Save and switch between terminal profiles (shell, working directory, environment)
- **File Browser**: Browse project files via `/api/terminal/files`
- **Git Integration**: View branches (`/api/terminal/branches`), checkout branches (`/api/terminal/checkout`)
- **Terminal Links**: Clickable links in terminal output (`/api/terminal/links`)

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/terminal/sessions` | List active terminal sessions |
| `POST /api/terminal/sessions` | Create new terminal session |
| `DELETE /api/terminal/sessions/:id` | Close terminal session |
| `GET /api/terminal/profiles` | List terminal profiles |
| `POST /api/terminal/profiles` | Save terminal profile |
| `GET /api/terminal/files` | Browse files in directory |
| `GET /api/terminal/branches` | List git branches |
| `POST /api/terminal/checkout` | Checkout git branch |
| `GET /api/terminal/links` | Get terminal link data |

## Architecture

- WebSocket connection for real-time terminal I/O
- node-pty spawns actual shell processes
- Terminal state persists within Neural Interface session (resets on server restart)
