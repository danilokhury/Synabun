# Plan: OpenCode Full Frontend Sidepanel

## Overview

Build a full frontend sidepanel for OpenCode (`anomalyco/opencode`) — matching the depth of the Claude Code and Codex panels, but leveraging OpenCode's superior HTTP server API instead of CLI subprocess spawning.

**Approved decisions:**
- Integration: **HTTP API** (`opencode serve --port 4096`) — not CLI subprocess
- Settings: **Full settings window** — provider keys, models, agents, MCP, compaction
- Isolation: **Hard isolation** — zero imports from ui-claude-panel.js or ui-codex-panel.js

---

## Architecture

### Integration Flow

```
SynaBun NI (browser)
      │
      │  WebSocket (ws://localhost:3344/ws/opencode-skin)
      ▼
server.js [opencode-skin handler]
      │
      │  HTTP REST + SSE
      ▼
opencode serve --port 4096
      │
      │  Vercel AI SDK / provider APIs
      ▼
LLM (Anthropic / OpenAI / Gemini / Groq / Local / ...)
```

The server.js acts as a proxy/bridge — it manages the `opencode serve` process, forwards REST calls, and relays the SSE event stream to the browser panel via WebSocket.

### File Map

| File | Status | Changes |
|------|--------|---------|
| `neural-interface/public/shared/ui-opencode-panel.js` | **NEW** | ~5000 lines — full panel |
| `neural-interface/server.js` | Modify | `opencode-skin` WS handler + serve management |
| `neural-interface/public/shared/html-shell.js` | Modify | Add `topright-opencode-panel-btn` |
| `neural-interface/public/shared/ui-navbar.js` | Modify | Import + register toggle |
| `neural-interface/public/shared/ui-settings.js` | Modify | OpenCode settings section |

---

## Step 1 — server.js: OpenCode Serve Management

Add a new self-contained block in server.js (~line 12000, after the opencode CLI profile entry).

### 1a. Process Management

```js
// ── OpenCode Server Manager ──
let _ocpProc = null;          // child_process for opencode serve
let _ocpPort = 4096;
let _ocpBaseUrl = () => `http://127.0.0.1:${_ocpPort}`;
let _ocpStarting = false;
let _ocpReady = false;

async function ensureOpencodeServer() { ... }
// 1. Check GET /global/health — if 200, already running → return true
// 2. Spawn: opencode serve --port 4096
// 3. Poll /global/health every 500ms, max 10s
// 4. On ready: set _ocpReady = true, broadcast status to WS clients

function stopOpencodeServer() { ... }
// Kill _ocpProc if we own it, reset _ocpReady
```

### 1b. WebSocket Handler (/ws/opencode-skin)

Register alongside existing WS routes. `handleOpencodeWs(ws)` handles:

| Client → Server msg.type | Action |
|--------------------------|--------|
| `init` | ensureOpencodeServer(), send status |
| `session:list` | GET /session → forward |
| `session:create` | POST /session → forward |
| `session:get` | GET /session/:id → forward |
| `session:delete` | DELETE /session/:id |
| `message:send` | POST /session/:id/message |
| `message:abort` | POST /session/:id/abort |
| `session:revert` | POST /session/:id/revert |
| `session:unrevert` | POST /session/:id/unrevert |
| `session:summarize` | POST /session/:id/summarize |
| `session:share` | POST /session/:id/share |
| `messages:list` | GET /session/:id/message |
| `config:read` | GET /config → forward |
| `config:write` | PATCH /config → forward |
| `providers:list` | GET /provider → forward |

### 1c. SSE Relay

Server holds ONE persistent EventSource to `GET /global/event` and fans all events to connected `/ws/opencode-skin` clients:

```js
const ocpEventSource = new EventSource(`${_ocpBaseUrl()}/global/event`);
ocpEventSource.onmessage = (e) => {
  broadcastToOpencodeClients({ type: 'event', event: JSON.parse(e.data) });
};
```

### 1d. REST Endpoints (for settings page)

```
GET  /api/opencode/status       → { running, port, version }
GET  /api/opencode/config       → proxy GET /config
PATCH /api/opencode/config      → proxy PATCH /config
GET  /api/opencode/providers    → proxy GET /provider
POST /api/opencode/serve/start  → ensureOpencodeServer()
POST /api/opencode/serve/stop   → stopOpencodeServer()
```

---

## Step 2 — html-shell.js: Add Navbar Button

After `topright-codex-panel-btn` (~line 438), insert:

```html
<button id="topright-opencode-panel-btn" class="topright-icon-btn" data-tooltip="OpenCode side panel">
  <svg viewBox="0 0 240 300" fill="currentColor" width="16" height="16">
    <path fill-rule="evenodd" d="M0 0h240v300H0V0zm60 60v180h120V60H60z"/>
    <rect x="60" y="120" width="120" height="120" opacity=".45"/>
  </svg>
</button>
```

---

## Step 3 — ui-navbar.js: Register Panel Toggle

```js
// Top of file — add import
import { toggleOpencodePanel, isOpencodePanelOpen } from './ui-opencode-panel.js';

// In initNavbar(), after codexPanelBtn block:
const opencodePanelBtn = $('topright-opencode-panel-btn');
if (opencodePanelBtn) {
  opencodePanelBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (isClaudePanelOpen()) { toggleClaudePanel(); claudePanelBtn?.classList.remove('active'); }
    if (isCodexPanelOpen()) { await toggleCodexPanel(); codexPanelBtn?.classList.remove('active'); }
    await toggleOpencodePanel();
  });
  on('opencode-panel:visibility', (visible) => {
    opencodePanelBtn.classList.toggle('active', !!visible);
  });
}
```

---

## Step 4 — ui-opencode-panel.js (New File)

### 4a. Module Identity

```js
// ═══════════════════════════════════════════
// SynaBun — OpenCode Panel
// HTTP API bridge to opencode serve (port 4096)
// Zero imports from ui-claude-panel.js or ui-codex-panel.js
// ═══════════════════════════════════════════

import { storage } from './storage.js';
import { state, emit, on } from './state.js';
import { fetchProjects } from './api.js';
import { reserveRightPanelLayout, clearRightPanelLayout } from './ui-sidepanel-layout.js';

const PANEL_OWNER = 'opencode-sidepanel';
const MAX_TABS = 10;
const OCP_ACCENT = '#E8E0DC';

const _windowId = sessionStorage.getItem('ocp-window-id') || (() => {
  const id = crypto.randomUUID();
  sessionStorage.setItem('ocp-window-id', id);
  return id;
})();

const STOR = {
  tabs:     `synabun-ocp-tabs-${_windowId}`,
  model:    'synabun-ocp-model',
  agent:    'synabun-ocp-agent',
  project:  'synabun-ocp-project',
};
```

### 4b. State Variables

```js
let _panel = null;
let _visible = false;
let _ws = null;
let _connected = false;
let _serverReady = false;
let _running = false;
let _tabs = [];
let _activeTabIdx = -1;
let _projects = [];
let _providers = [];       // from GET /provider
let _sessions = [];        // from GET /session
let _reconnectTimer = null;
let _trayPill = null;
```

### 4c. Panel HTML Layout

```
┌────────────────────────────────────────────┐
│ [OC] OpenCode              [─][+][×]  [≡] │  header (draggable)
├────────────────────────────────────────────┤
│ [● Tab 1 ×] [Tab 2 ×]  [+]                │  tab pills
├────────────────────────────────────────────┤
│ [Model ▼]  [Agent ▼]  [Project ▼]         │  toolbar
├────────────────────────────────────────────┤
│                                            │
│          messages / transcript             │  scrollable
│                                            │
├────────────────────────────────────────────┤
│ [⟲ Revert]  [⇥ Compact]    [🔗 Share]    │  action bar
├────────────────────────────────────────────┤
│  ┌──────────────────────────────────────┐  │
│  │  Message OpenCode...                 │  │  textarea
│  └──────────────────────────────────────┘  │
│  [↩ Send]  [⏹ Stop]    0↑ 0↓  / 200k    │  send row
└────────────────────────────────────────────┘
```

### 4d. WebSocket Connection

```js
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  _ws = new WebSocket(`${proto}://${location.hostname}:3344/ws/opencode-skin`);
  _ws.onopen  = () => { _connected = true; sendWs({ type: 'init' }); };
  _ws.onmessage = (e) => handleWsMsg(JSON.parse(e.data));
  _ws.onclose = () => { _connected = false; _serverReady = false; scheduleReconnect(); };
}
```

### 4e. Event Handler (SSE events relayed from server)

```js
function handleOpencodeEvent(event) {
  switch (event.type) {
    case 'message.part.updated':   appendStreamChunk(event); break;
    case 'message.part.completed': finalizeMessagePart(event); break;
    case 'message.completed':      onTurnComplete(event); break;
    case 'tool.start':             renderToolCard(event); break;
    case 'tool.result':            updateToolCard(event); break;
    case 'session.updated':        refreshSessionMeta(event.session); break;
    case 'error':                  renderError(event); break;
  }
}
```

### 4f. Tool Icons

Custom SVG icons for each OpenCode tool (bash, write, edit, view, glob, grep, ls, fetch, agent, patch, diagnostics, sourcegraph). Rendered as collapsible tool cards identical in style to Claude panel tool cards but with `ocp-` CSS prefix.

### 4g. Multi-Tab System

TabState shape:
```js
{
  id: string,            // uuid
  sessionId: string | null,
  sessionTitle: string,
  model: string,         // e.g. "anthropic/claude-sonnet-4-5"
  agent: string,         // "build" | "plan" | custom
  project: string,       // working directory
  running: boolean,
}
```

- Tab pills rendered in header
- `createTab()` — new tab with fresh or existing session
- `switchTab(idx)` — saves/restores per-tab state
- `closeTab(idx)` — removes tab + cleans up
- State persisted to `localStorage[STOR.tabs]`

### 4h. Model/Provider Dropdown

Populated from `providers:list` WS response. Groups by provider:

```
── Anthropic (●) ──────────────
  claude-sonnet-4-5  ← default
  claude-haiku-4-5
  claude-opus-4
── OpenAI (●) ─────────────────
  gpt-4o
── Groq (●) ───────────────────
  llama-3.3-70b-versatile
── Local (●) ──────────────────
  llama3:latest
── OpenAI (✗ not configured) ──
  [Configure in Settings]
```

### 4i. Session Management

- Session picker dropdown in toolbar (shows recent sessions from `session:list`)
- New session: `session:create` → assign to active tab
- Delete session: confirm dialog → `session:delete`
- Revert button: `session:revert` (removes last assistant turn)
- Compact button: `session:summarize` (manual context compaction)
- Share button: `session:share` → copies URL to clipboard
- Session title inline editable (optimistic UI, synced via `config:write`)

### 4j. Connection Status Bar

Displayed below toolbar, above messages:
- `● Connecting to OpenCode...` (yellow dot, pulsing)
- `● Ready` (green dot)
- `● Working` (blue dot, animated)
- `● Server offline` (red dot) + [Start Server] button
- `● Error: <message>` (red dot)

### 4k. Token Counter

Displayed in send row footer: `{inputTokens}↑ {outputTokens}↓ / {contextLimit}` — updated on `message.completed` events.

### 4l. Public API

```js
export async function toggleOpencodePanel() { ... }
export function isOpencodePanelOpen() { return _visible; }
export async function openOpencodeWithPrompt(text, opts = {}) { ... }
```

---

## Step 5 — ui-settings.js: OpenCode Settings Section

New settings tab "OpenCode" added to the modal. Sections:

### Server
```
Port:         [4096        ] [Auto-start ☑]
Status:       ● Running  v1.3.17
              [Stop Server]  [Restart]
```

### Model & Agent
```
Default model:        [anthropic/claude-sonnet-4-5 ▼]
Default small model:  [anthropic/claude-haiku-4-5  ▼]
Default agent:        [build ▼]  (build / plan / custom...)
```

### Providers
One row per provider with status badge + API key input:
```
Anthropic   ● Connected   [sk-ant-••••••••]  [Test]
OpenAI      ✗ Not set     [________________] [Test]
Google      ✗ Not set     [________________] [Test]
Groq        ● Connected   [gsk_••••••••••••] [Test]
Local       ● Reachable   [http://localhost:11434]
```

### Tools & Permissions
```
bash    [allow ▼]   write  [ask ▼]   edit  [ask ▼]
glob    [allow ▼]   grep   [allow ▼] fetch [allow ▼]
```

### Compaction
```
Auto-compact:  [☑ Enabled]
Reserved:      [10000    ] tokens
```

### Sharing
```
Share mode:  [manual ▼]  (manual / auto / disabled)
```

### Config File
```
Active config: ~/.config/opencode/opencode.json  [Open]
               [Raw JSON editor — schema validated]
               [Save Config]
```

---

## Implementation Order

1. **server.js** — opencode serve manager + `/ws/opencode-skin` handler + REST endpoints
2. **html-shell.js** — add `topright-opencode-panel-btn`
3. **ui-navbar.js** — import `toggleOpencodePanel` + button wiring
4. **ui-opencode-panel.js** — full panel (~5000 lines)
5. **ui-settings.js** — OpenCode settings section

---

## Key Notes

### OpenCode Server Detection
`GET http://127.0.0.1:4096/global/health` — if it responds, use it (don't spawn). If not, spawn and track PID. Only kill the process if we spawned it.

### SSE Pattern
Server holds ONE persistent SSE connection to `/global/event`. All `/ws/opencode-skin` clients receive the same fan-out. No per-client SSE connections.

### CSS Namespace
All CSS classes use `ocp-` prefix. Accent: `#E8E0DC`. Panel sizing and resize handle: same mechanics as Claude panel (right-edge drag).

### Hard Isolation Enforcement
- No `import ... from './ui-claude-panel.js'`
- No `import ... from './ui-codex-panel.js'`
- Own storage key prefix: `synabun-ocp-`
- Own sessionStorage key: `ocp-window-id`
- Own PANEL_OWNER string: `'opencode-sidepanel'`
- `reserveRightPanelLayout` / `clearRightPanelLayout` are neutral (from ui-sidepanel-layout.js) — OK to import

### Orphan Reattach (WebSocket reconnect)
Apply same composite key fix as Claude panel: store orphaned WS processes under `windowId:sessionId` key, not just `windowId`. Reference: memory `1cef08cd-9aca-4284-8862-115973d65f3d`.
