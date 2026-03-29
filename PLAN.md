# NPM Update Alert — Implementation Plan

## Overview

Add an update notification system that checks the npm registry on server boot, shows a badge in the top-right toolbar when an update exists, and provides a modal wizard flow that gates the update instructions behind a full system backup.

---

## Phase 1: Server — NPM Version Check & API Endpoint

**File: `neural-interface/server.js`**

### 1a. Module-level cache (near top, after imports)

```js
let _npmUpdateCache = { current: null, latest: null, updateAvailable: false, checkedAt: null };
```

### 1b. Helper function `checkNpmUpdate()`

- Read current version from root `package.json` (already resolved via `PROJECT_ROOT`)
- Fetch `https://registry.npmjs.org/synabun/latest` with a 5s timeout
- Extract `version` field from response JSON
- Compare using simple semver: split on `.`, compare major/minor/patch numerically
- Populate `_npmUpdateCache` with `{ current, latest, updateAvailable, checkedAt }`
- Wrap in try/catch — network failures silently leave cache as "no update"
- Log result to boot console: `  Updates:  v1.3.0 → v1.4.0 available` or `  Updates:  up to date (v1.3.0)`

### 1c. Boot integration

In the `app.listen()` async callback (line ~14258), after the loop cleanup block, add:

```js
// Check for npm updates
try { await checkNpmUpdate(); } catch {}
```

### 1d. API endpoint `GET /api/system/version`

Returns:
```json
{
  "current": "1.3.0",
  "latest": "1.4.0",
  "updateAvailable": true,
  "checkedAt": "2026-03-29T18:00:00Z"
}
```

If cache is older than 6 hours, triggers a fresh background check before responding.

---

## Phase 2: Toolbar Button

**File: `neural-interface/public/shared/html-shell.js`**

Add an update button in the **system/settings group** (before the keybinds button), hidden by default:

```html
<button id="topright-update-btn" class="topright-icon-btn" style="display:none" title="Update available">
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 3v12"/>
    <path d="m8 11 4 4 4-4"/>
    <path d="M8 21h8"/>
  </svg>
  <span class="count-badge count-badge--green" id="update-badge"></span>
</button>
```

The button is `display:none` until JS confirms an update is available.

---

## Phase 3: UI Module — `ui-update.js`

**New file: `neural-interface/public/shared/ui-update.js`**

### 3a. `initUpdate()` — called from `ui-navbar.js`

1. Fetch `GET /api/system/version`
2. If `updateAvailable === true`:
   - Show `#topright-update-btn` (`display: ''`)
   - Set badge text (e.g., `!`)
   - Attach click handler → `openUpdateModal(data)`
3. If no update, do nothing (button stays hidden)

### 3b. `openUpdateModal(versionData)` — 3-step wizard

Uses existing `tag-delete-overlay` + `tag-delete-modal` pattern for consistent glassmorphism.

**Step 1 — Version Info:**
- Header: "Update Available"
- Shows: `v{current}` → `v{latest}` with arrow graphic
- Subtext: "A new version of SynaBun is available on npm."
- Button: "Next" → advances to Step 2

**Step 2 — Backup Gate (BLOCKING):**
- Header: "Back Up Your Data"
- Subtext: "Before updating, create a full system backup to protect your memories, settings, and configurations."
- **"Download Full Backup"** button — triggers `GET /api/system/backup` (reuses existing endpoint), shows spinner during download, shows checkmark + filename on success
- **"I already have a backup"** checkbox — alternative path
- **"Next"** button — **disabled** until either the backup download completes OR the checkbox is checked
- "Back" button → Step 1

**Step 3 — Update Instructions:**
- Header: "Run the Update"
- Code block: `npm install -g synabun@latest`
- "Copy" button (copies command to clipboard)
- Subtext: "After the update completes, restart your Neural Interface server."
- Second code block: `node neural-interface/server.js`
- "Copy" button for that too
- **"Done"** button → closes modal

### 3c. Backup download handler

Reuses the exact same fetch logic as `#sys-backup-btn` in `ui-settings.js`:
```js
const res = await fetch('/api/system/backup');
const blob = await res.blob();
// Extract filename from Content-Disposition header
// Create <a> download link, click, revoke
```

### 3d. Export

```js
export function initUpdate() { ... }
```

---

## Phase 4: CSS Additions

**File: `neural-interface/public/shared/styles.css`**

### 4a. Green badge variant

```css
.count-badge--green {
  background: rgba(52, 199, 89, 0.18);
  color: #34c759;
  border: 1px solid rgba(52, 199, 89, 0.25);
}
```

### 4b. Update modal wizard styles

- `.update-version-diff` — flex row: old version → arrow → new version
- `.update-steps` — 3 step indicator dots showing current step
- `.update-code-block` — dark bg, mono font, copy btn positioned right
- `.update-backup-status` — checkmark + filename after successful download
- `.update-next-btn:disabled` — `opacity: 0.4; pointer-events: none;`

All values use existing design tokens (`var(--t-muted)`, `var(--r-card)`, `var(--fs-sm)`, etc.).

---

## Phase 5: Wiring

**File: `neural-interface/public/shared/ui-navbar.js`**

- Import `initUpdate` from `./ui-update.js`
- Call `initUpdate()` at the end of `initNavbar()` alongside the other `init*()` calls

---

## Files Touched

| File | Change |
|------|--------|
| `neural-interface/server.js` | `checkNpmUpdate()` helper, boot call, `GET /api/system/version` endpoint |
| `neural-interface/public/shared/html-shell.js` | Update button HTML in topright toolbar |
| `neural-interface/public/shared/ui-update.js` | **NEW** — update check, badge, modal wizard |
| `neural-interface/public/shared/ui-navbar.js` | Import + call `initUpdate()` |
| `neural-interface/public/shared/styles.css` | Green badge variant, modal wizard styles |

## Not Touched

- No changes to the backup system — reuses `GET /api/system/backup` as-is
- No changes to `package.json` — version is read at runtime
- No new npm dependencies — uses native `fetch` (Node 22+)
