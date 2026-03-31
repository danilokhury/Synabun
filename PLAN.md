# Plan: NPM Open-Source Standards Audit

Make Synabun's NPM package, GitHub repo, and documentation match the transparency standards of any established open-source project.

---

## What SHA / Provenance Actually Is (plain English)

When you run `npm publish`, npm generates a **SHA-512 hash** (a fingerprint) of the tarball automatically — this is already happening. Users can verify the package they downloaded matches what was uploaded. That part is free.

**npm Provenance** goes further: it cryptographically proves *where* the package was built. When enabled, npmjs.com shows a green checkmark linking to the exact GitHub commit and workflow that built the package. This is what major packages like Express, Next.js, etc. have. It requires publishing via **GitHub Actions** (not your local machine) so there's an auditable chain: GitHub commit → GitHub Actions build → npm publish → signed attestation.

Right now Synabun publishes manually from your machine — there's no provenance chain. After this plan, it'll publish automatically from GitHub with full provenance, matching any top-tier npm package.

---

## Phase 1: package.json — Missing Standard Fields

**File:** `package.json`

Add:
```json
"bugs": {
  "url": "https://github.com/danilokhury/Synabun/issues"
}
```

This makes the "Report a bug" link show up on the npmjs.com sidebar. npm infers it from `repository` but explicit is standard practice.

Skip `funding` for now (user chose "maybe later").

---

## Phase 2: README Badges — npm Trust Signals

**File:** `README.md` (badge section, lines 11-17)

Add three standard npm badges alongside the existing ones:

1. **npm version** — `https://img.shields.io/npm/v/synabun` (auto-updates, links to npm page)
2. **npm downloads** — `https://img.shields.io/npm/dm/synabun` (monthly downloads, social proof)
3. **license** — `https://img.shields.io/npm/l/synabun` (shows Apache-2.0 from package.json)

These are the three badges every serious npm package has. They link to the npm page and signal "this is a maintained, published package."

---

## Phase 3: Fix Broken GitHub URLs

**Problem:** `CONTRIBUTING.md` and `.github/PULL_REQUEST_TEMPLATE.md` reference `ZaphreBR/synabun` but the actual repo is `danilokhury/Synabun`.

**Files to fix:**
1. `CONTRIBUTING.md` line 5 — `ZaphreBR/synabun` → `danilokhury/Synabun`
2. `.github/PULL_REQUEST_TEMPLATE.md` lines 13-14 — `ZaphreBR/synabun` → `danilokhury/Synabun`

---

## Phase 4: CODE_OF_CONDUCT.md

**New file:** `CODE_OF_CONDUCT.md`

Standard **Contributor Covenant v2.1** — the de facto standard used by most open-source projects. Short, professional, covers expected behavior and enforcement. Contact email: `chat@synabun.ai` (matches npm maintainer).

This file shows up automatically on GitHub's "Community" tab and signals a mature project.

---

## Phase 5: GitHub Actions — CI + Provenance Publishing

### 5A: CI Workflow (`.github/workflows/ci.yml`)

Runs on every push to `main` and on PRs:
- Checkout code
- Setup Node.js 22
- Install root deps
- Install subdeps (mcp-server, neural-interface)
- Build MCP server (`npm run build` in mcp-server/)
- Run tests if present (`.tests/` vitest suite)

This gives you a **CI status badge** for the README and catches build failures before publish.

### 5B: Publish Workflow (`.github/workflows/publish.yml`)

Runs when you create a **GitHub Release** (manual trigger via the Releases page):
- Checkout code
- Setup Node.js 22 with npm registry auth
- Run the CI steps (install, build, test)
- Publish to npm with `--provenance` flag
- Requires `NPM_TOKEN` secret in GitHub repo settings

**How it changes your workflow:**
1. Push your code as usual
2. When ready to publish: go to GitHub → Releases → "Create a new release"
3. Tag it with the version (e.g., `v2026.3.31004`)
4. GitHub Actions builds, tests, and publishes to npm with provenance
5. npmjs.com shows the green checkmark linking to that exact commit

**One-time setup required:**
- Create an npm access token (Automation type) at npmjs.com → Access Tokens
- Add it as `NPM_TOKEN` secret in GitHub → Settings → Secrets → Actions
- Enable "id-token: write" permission (already in the workflow)

---

## Phase 6: README CI Badge

After Phase 5A is merged, add a CI status badge to README:

```
https://github.com/danilokhury/Synabun/actions/workflows/ci.yml/badge.svg
```

This shows build status (passing/failing) directly on the README.

---

## Summary of Changes

| # | File | Action |
|---|------|--------|
| 1 | `package.json` | Add `bugs` field |
| 2 | `README.md` | Add npm version, downloads, license, CI badges |
| 3 | `CONTRIBUTING.md` | Fix `ZaphreBR` → `danilokhury` URL |
| 4 | `.github/PULL_REQUEST_TEMPLATE.md` | Fix `ZaphreBR` → `danilokhury` URLs |
| 5 | `CODE_OF_CONDUCT.md` | New file — Contributor Covenant v2.1 |
| 6 | `.github/workflows/ci.yml` | New file — CI on push/PR |
| 7 | `.github/workflows/publish.yml` | New file — npm publish with provenance on release |

**Files modified:** 4
**Files created:** 3
**Post-implementation:** User needs to add `NPM_TOKEN` secret to GitHub repo settings
