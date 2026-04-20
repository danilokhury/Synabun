# Plan — "+ New Session" Modal: Add Project + Branch Selection

## Goal

When the user clicks the **+** button in the OpenCode, Claude Code, or Codex sidepanel, the "Name this session" modal that appears should also let them pick a **project** and **branch** for the new session — not just type a name.

## Current state (verified)

All three panels share the same flow:

1. User clicks `+` → a new tab is created inheriting the active tab's/global project.
2. A small centered modal appears with one text input ("Session name…") + Skip/Save buttons.
3. Save either renames the server session (if one exists) or stashes the name in `pendingLabel`/`pendingTitle`/`pendingSessionLabel` to be applied the moment the server session starts.

Relevant hooks:

| Panel | "+" click handler | Modal function | Existing project dropdown | Existing branch dropdown |
|-------|-------------------|----------------|---------------------------|--------------------------|
| OCP    | `ocp-panel.js:328` → `createTab(); promptNameNewSession();` | `ocp-panel.js:137` `promptNameNewSession()` | `#ocp-project-dd` (populated from `_projects`) | `#ocp-branch` |
| Claude | `ui-claude-panel.js:7637` → `createTab(null,'New chat'); promptNameNewSession();` | `ui-claude-panel.js:3544` `promptNameNewSession()` | `#cp-project` (populated from `_projects`) | `#cp-branch` |
| Codex  | `cdx-panel.js:682` → `createTab({project}); promptNameNewSession();` | `cdx-tabs.js:2546` `promptNameNewSession()` | `#cxp-project` (populated from `_projects`) | `#cxp-branch` |

Existing primitives we reuse:

- **Project list**: each panel already keeps `_projects` in memory (OCP `ocp-panel.js:57`, Claude `ui-claude-panel.js:106`, Codex `cdx-tabs.js:308`).
- **Branch loading**: each panel has a `loadBranches(path)` function that calls `GET /api/terminal/branches?path=...` (OCP `ocp-panel.js:1156`, Claude `ui-claude-panel.js:6773`, Codex `cdx-panel.js:427`).
- **Branch checkout**: `POST /api/terminal/checkout { path, branch }` — already invoked by Claude on branch-dropdown change (`ui-claude-panel.js:7862`). Server impl: `server.js:16992`.
- **Tab's project field**: each `createTab()` stores it in `tab.project` and the panel's project dropdown reflects the value.

## Design decisions

1. **Keep the modal per-panel** (three parallel implementations). They already share shape but diverge in style prefixes and tab internals; unifying is out of scope.
2. **Create tab first, then modal** (matches existing order). The fresh tab has no server session yet, so changing `tab.project` before the first message is safe.
3. **No implicit checkout**. Selecting a branch inside the modal only updates the modal's local state. Checkout is performed on Save — Skip/Escape leaves the repo untouched. This differs from the projectbar branch dropdown (which checks out on change) but matches user expectation that Escape = cancel.
4. **Mirror the selection back to the panel's dropdowns on Save** so the visible project/branch label stays in sync with the new tab's state.
5. **Prefill** the two dropdowns with the tab's current project + current branch (read via `GET /api/terminal/branches` — the response's `current` field).
6. **Modal becomes a form, not a single input**. Layout: title, project row, branch row, name input, actions. Dropdowns are plain `<select>` elements styled to match the existing `.*-name-modal-input` so no new custom-dropdown primitive is needed inside the overlay.

## Implementation plan

### Step 1 — OpenCode (`neural-interface/public/shared/ocp/ocp-panel.js`)

Edit `promptNameNewSession()` (currently lines 137–192):

- Extend the overlay HTML to include:
  - `<label class="ocp-name-modal-label">Project</label>` + a `<select class="ocp-name-modal-select" data-role="project">` populated from `_projects` (preselect `tab.project`).
  - `<label class="ocp-name-modal-label">Branch</label>` + a `<select class="ocp-name-modal-select" data-role="branch">`. Populated on modal open by fetching `/api/terminal/branches?path=<tab.project>` and preselecting the `current` field.
  - Existing `<input class="ocp-name-modal-input">` unchanged.
- Wiring inside the modal:
  - On project `change`: clear branch select, re-fetch branches for the new path, preselect the returned `current`.
  - Local `async fetchBranches(path)` helper that returns `{ branches, current }` (inline — avoids refactoring the module-level `loadBranches`, which writes into `#ocp-branch` directly).
- On Save (`commit(false)`):
  1. If `projectSelect.value !== tab.project`: set `tab.project = projectSelect.value`, `storage.setItem(STOR.project, tab.project)`, update the projectbar: call `populateProjectDropdown(panelEl('#ocp-project-dd'))` or set its label text + `selected` class (mirroring `ocp-panel.js:1139-1148`), then the module-level `loadBranches(tab.project)` so `#ocp-branch` refreshes.
  2. If `branchSelect.value && branchSelect.value !== modalCurrentBranch`: `POST /api/terminal/checkout { path: tab.project, branch: branchSelect.value }`.
  3. Run the existing name-commit logic unchanged (`renameSession` when `tab.sessionId`, else `tab.pendingTitle = nextTitle`; `tab.sessionTitle = nextTitle`; update `#ocp-session-label`).
- On Skip / Escape / outside-click: no project/branch write, no checkout.
- The `+` click handler at `ocp-panel.js:328` stays unchanged; it keeps calling `createTab(); promptNameNewSession();`.

Styles — edit `neural-interface/public/shared/ocp/ocp-styles.js` (`.ocp-name-modal-*` block at lines 137–212):

- Add `.ocp-name-modal-row { display:flex; flex-direction:column; gap:4px; }`.
- Add `.ocp-name-modal-label { font-size: 10px; opacity: 0.55; text-transform: uppercase; letter-spacing: 0.04em; }`.
- Add `.ocp-name-modal-select` mirroring `.ocp-name-modal-input` (same padding/border/bg/font) so the selects visually match the name input.
- Bump `.ocp-name-modal` `max-width` 340 → 380 so the dropdowns breathe. Keep `gap: 12px`.

### Step 2 — Claude Code (`neural-interface/public/shared/ui-claude-panel.js`)

Edit `promptNameNewSession()` (currently lines 3544–3596):

- Same overlay extension as OCP: Project row + Branch row + Name input + actions.
- Populate Project select from the module-level `_projects` array (already hydrated at `ui-claude-panel.js:6736`). Preselect `tab.project`.
- Populate Branch select via inline `fetch('/api/terminal/branches?path=…')` (same endpoint as the existing `loadBranches` at line 6773). Preselect `data.current`.
- On Save:
  1. If the project changed: update `tab.project`, `storage.setItem(STOR.project, …)`, update the projectbar `#cp-project` label by reusing `ddPopulate($project, items, tab.project)` at lines 2753/3155, then call `loadBranches(tab.project)` so `#cp-branch` refreshes. **Do not** call `selectSession(null, 'New chat')` — the tab is already fresh, and calling it would wipe state we want to keep.
  2. If branch differs from `current`: `POST /api/terminal/checkout` (same request as `ui-claude-panel.js:7865-7868`).
  3. Run the existing label-commit logic: `storage.setItem(LABEL_PREFIX + sid, val)` when `sid` exists, else `tab.pendingLabel = val`; set `tab.label`; `updatePillLabel(tab)`; `saveTabs()`; update visible `.cp-session-label`.
- On Skip / Escape / outside-click: no project/branch write.

Styles — the Claude panel injects styles inline (see `.cp-name-modal-*` at lines 1899–1959). Add analogous rules in the same `<style>` block:

- `.cp-name-modal-row { display:flex; flex-direction:column; gap:4px; }`
- `.cp-name-modal-label { font-size: 10px; opacity: 0.55; text-transform: uppercase; letter-spacing: 0.04em; }`
- `.cp-name-modal-select { … }` matching `.cp-name-modal-input`.
- Bump `.cp-name-modal` `max-width` to 380.

### Step 3 — Codex (`neural-interface/public/shared/cdx/cdx-tabs.js`)

Edit `promptNameNewSession()` (currently lines 2546–2607):

- Same overlay extension. `_projects` lives at `cdx-tabs.js:308`; preselect `activeTab()?.project || storage.getItem(STOR.project) || ''`.
- Branch fetch: inline `fetch('/api/terminal/branches?path=…')`. The module-level `loadBranches` lives in `cdx-panel.js:427` and is passed into tabs via `setCallbacks({ loadBranches })` (stored as `_loadBranches`, see `cdx-tabs.js:62-68,1547`). We only use `_loadBranches(path)` after Save to refresh `#cxp-branch` — the modal's own select is populated by the inline fetch.
- On Save:
  1. If project changed: `activeTab().project = projectSelect.value`; `storage.setItem(STOR.project, …)`; call `_loadBranches(newProject)` to refresh `#cxp-branch`. Sync the `#cxp-project` label — reuse whatever helper the existing `cdx-panel.js` project-change handler uses, or dispatch a `change` event on `#cxp-project` after writing the value (whichever matches the rest of `cdx-panel.js`; keep the logic colocated with project selection already in this file/module).
  2. If branch differs from `current`: `POST /api/terminal/checkout`.
  3. Run the existing `thread_rename` / `pendingSessionLabel` logic unchanged (lines 2581–2596).
- On Skip / Escape / outside-click: no project/branch write.

Styles — edit `neural-interface/public/shared/cdx/cdx-styles.js` (`.cxp-name-modal-*` at lines 456–516):

- Add `.cxp-name-modal-row`, `.cxp-name-modal-label`, `.cxp-name-modal-select` mirroring the OCP/Claude additions (using the Codex color palette — `rgba(120,180,150,…)` focus like the input).
- Bump `.cxp-name-modal` `max-width` 340 → 380.

### Step 4 — Small helper (per file)

Inside each modal function, define one local helper `async function fetchBranches(path) { try { return await (await fetch('/api/terminal/branches?path=' + encodeURIComponent(path))).json(); } catch { return { branches: [], current: null }; } }`. Inline and duplicated, to avoid broadening the existing `loadBranches(path)` functions (they already bind to specific DOM targets).

## Files touched

1. `neural-interface/public/shared/ocp/ocp-panel.js` — modal body + Save handler.
2. `neural-interface/public/shared/ocp/ocp-styles.js` — new modal CSS rows.
3. `neural-interface/public/shared/ui-claude-panel.js` — modal body + Save handler + inline CSS.
4. `neural-interface/public/shared/cdx/cdx-tabs.js` — modal body + Save handler.
5. `neural-interface/public/shared/cdx/cdx-styles.js` — new modal CSS rows.

No server-side changes — `GET /api/terminal/branches` and `POST /api/terminal/checkout` already exist and are already called by the projectbar branch dropdowns.

## Test plan

- Click `+` in each of the three sidepanels → modal appears with Project, Branch, and Name rows; Project preselected to the active project; Branch preselected to the project's current git branch; Name empty.
- Change Project in the modal → Branch list refreshes to the new project's branches, preselecting its current branch.
- Save with a different branch → `git branch --show-current` on disk matches the selected branch; the projectbar branch label updates to match.
- Save with a different project but same branch (or branch unchanged) → no checkout POST is fired.
- Skip / Escape / click-outside → no project change, no checkout, no rename; the new tab still exists but keeps its inherited defaults.
- Save with a name → tab pill + session-label reflect it; if the session hasn't started yet, the name is applied once the first prompt spawns the server session (existing `pendingLabel` / `pendingTitle` / `pendingSessionLabel` path — unchanged).
- Save with an empty name → no rename, but project/branch still apply.
- Non-git project selected → Branch row is empty/disabled (mirrors `loadBranches` behavior when `rev-parse` fails and server returns `{branches:[], current:null}`).
