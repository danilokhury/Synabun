# Style Guide

A project's brand and design system, kept in one place and handed to every agent that works on the project: colors in light and dark, type, spacing, shape, motion, icons, logo files, imagery direction, component specs and rules.

A saved guide writes the files agents and build tools already read:

| File | What it is |
|---|---|
| `<project>/DESIGN.md` | The guide as prose and tokens, in the shape Google Stitch and the community collection use (YAML frontmatter + sections) |
| `<project>/.synabun/style-guide/tokens.json` | W3C design tokens (DTCG 2025.10) |
| `<project>/.synabun/style-guide/tokens.css` | CSS custom properties, light and dark |
| `<project>/.synabun/style-guide/tailwind.css` | Tailwind v4 `@theme` (or `tailwind.tokens.cjs` for v3) |

This page covers the editor, backend, MCP tool and agent integration.

## Contents

- [Panel](#panel)
- [Where it lives](#where-it-lives)
- [The guide (schema v2)](#the-guide-schema-v2)
- [Aliases](#aliases)
- [What a save writes](#what-a-save-writes)
- [Imports](#imports)
- [Presets](#presets)
- [History and proposals](#history-and-proposals)
- [What agents receive](#what-agents-receive)
- [The `style_guide` tool](#the-style_guide-tool)
- [REST API](#rest-api)
- [Rules](#rules)
- [Code map](#code-map)
- [Testing the panel](#testing-the-panel)

## Panel

Open **Style Guide** from the Neural Interface Skills menu and select a registered project. The floating 1180 × 720 panel keeps the shared drag and resize handles and moves back inside the window when the window shrinks. Its rail collapses to named icons below 900 px of panel width; the content scrolls inside the panel, never the page. Native controls (checkboxes, selects, sliders, file pickers) use the dark color scheme.

The fourteen sections are Brand, Colors, Typography, Layout, Shape & effects, Motion, Icons & logo, Imagery, Components, Rules & accessibility, Agents, Preview, Import & export, and History & proposals. Every section uses labelled controls and cards with a purpose line. Colors includes eleven-step palettes (EyeDropper on the base and status colors, where the browser has one), per-theme semantic aliases with a swatch of what each alias resolves to, light/dark theme switches and a WCAG/APCA contrast matrix. Tables (semantic roles, text styles) name each column once; the per-cell labels stay for screen readers. Lists are compact: chips for short values (personality, weights, icon sizes, aspect ratios), rows with Move up / Move down / Remove for the rest. Typography includes the bundled font search, eight pairings, a scale generator and live specimens. Google Fonts stylesheets load only for fonts whose source is `google`.

Changes autosave after **800 ms**. Every PUT sends the complete schema-v2 config: a partial PUT would reset omitted fields to defaults. Edits made while a request is in flight are retained and saved afterwards. **Cmd/Ctrl+S** flushes immediately; **Esc** saves and closes. Both are caught at window capture, so a feature listening underneath (the map, the whiteboard, the tutorial) cannot swallow them. A button that is busy, or a section that re-renders after restore, accept or import, keeps focus inside the dialog. A failed save keeps the panel and draft open with Retry. The header reports the revision, written-file count and pending proposals.

**Preview** renders a component sheet in a script-free `sandbox="allow-same-origin"` iframe: logo/navigation, hero, button states, form, elevations, alerts, badges, table, pagination and footer. Choose light/dark and 375/768/1440 px widths. The canonical stylesheet comes from GET `/export?format=css`; complete local token overrides update the preview while edits await autosave. The DESIGN.md subview fetches `/preview-md`; Copy fetches it first when that view has not been opened.

**Import & export** accepts a file or paste (DESIGN.md, W3C tokens, CSS or Tailwind JSON), a project scan or a community slug. Choose Merge or Replace, press Preview diff, inspect the API's leaf differences and warnings, then Apply. Apply sends the full previewed config through PUT with its import source. Editing the import inputs or export settings invalidates that preview. Community imports show the independent-analysis attribution. Eight presets show swatches and font families and use the selected merge strategy. Export settings control the generated files, output directory, Tailwind target and dark selector. Write now lists the paths actually written; per-format Copy reads the export endpoint.

**History & proposals** shows saved revisions, restore with confirmation, a status filter and each proposal's exact diff. Accept saves through the proposal route; Reject leaves the guide unchanged. Actions flush pending edits first. **Agents** shows the compact summary and token estimate, per-task injection switches and instructions, and the managed project-pointers block. Its pointers toggle uses the dedicated API.

Automation Studio's Code Review wizard keeps Style Guide Notes and adds **Use this project's Style Guide** with a registered-project selector. When enabled, Review, Copy, Open in Editor and Launch append the selected project's fetched summary; Launch also passes that project as its working directory.

Client color math in `sg-color-client.js` is the server's pure mathematical core copied verbatim, with browser-only CSS-color and canvas-image adapters appended. The UI contract suite checks byte parity and representative scale/contrast results, so instantaneous badges use the same WCAG and APCA calculation as the API.

## Where it lives

One folder in the data home, keyed by `sha1(projectPath)` (first 16 hex characters):

```
~/.synabun/data/style-guides/
  <hash>.json             the guide
  <hash>.history.json     the last 30 saved revisions, newest first
  <hash>.proposals.json   changes agents proposed
  assets/<hash>/          uploaded logo files
```

A project is one of the registered projects (`claude-code-projects.json`). Every API call and tool call takes a `projectPath` that may be the project root **or any path inside it**; it resolves to the registered root, and a path in no registered project is refused (403). Resolution checks physical containment, including existing symlink ancestors of a missing path. Artifact and logo writes refuse symlinks below their root before committing a revision.

## The guide (schema v2)

`schemaVersion: 2`. `normalizeStyleGuide()` fills every missing field with its default, so a partial save, an old file and a hand-edited file always load. Sections:

| Section | Holds |
|---|---|
| `brand` | name, tagline, description, audience, personality, vibe, key characteristics, voice (tone, dos, don'ts) |
| `colors.palettes` | ordered palettes; `primary`, `secondary`, `accent` and `neutral` always exist, more can be added (kebab-case keys). Each has a `base` and 11 `steps` (50…950) |
| `colors.semantic` | per theme (`light`, `dark`): `background`, `surface`, `surfaceRaised`, `text`, `textMuted`, `border`, `primary`, `onPrimary`, `secondary`, `onSecondary`, `accent`, `onAccent`, `link`, `focus`. A value is a hex or an alias |
| `colors.status` | `success`, `warning`, `danger`, `info` |
| `colors.gradients`, `colors.themes` | named CSS gradients; the default theme and the themes the product ships |
| `typography` | `fonts` (`heading`, `body`, `mono`, optional `display`: family, fallback, source, weights, features), `scale` (base, ratio), `styles` (id → font, size, mobile size, weight, line height, letter spacing in em, transform, usage), principles |
| `layout` | spacing base and scale, breakpoints, container, grid, z-index, principles |
| `shape` | radius scale, radius roles (button, card, input, badge, modal → a step of the scale), border widths, elevation (shadow + usage) |
| `motion` | durations (ms), easings, reduced-motion policy, principles |
| `iconography`, `logo`, `imagery` | icon library and style; logo variants (kind, background, file), clear space, minimum size, don'ts; imagery style, mood, dos and don'ts, and the image-generation prefix, negative prompt, aspect ratios and style references |
| `components` | ordered specs: id, name, category, tokens (aliases or literal CSS), states, notes |
| `accessibility`, `rules`, `responsive` | WCAG level and thresholds, focus ring; dos, don'ts and a free Markdown section; responsive notes |
| `agents` | which classes of dispatched run get the guide (`inject`), free instructions for agents, and whether agents may propose changes |
| `exports` | which files a save writes, the Tailwind target, the output folder, the CSS selector, how the dark theme is selected (`attribute`, `media`, `class`), and the project pointers switch |

The 11-step scales are generated in OKLCH (`scaleFromBase`): evenly spaced to the eye, with the base kept at step 500 byte for byte.

### The v1 shape

The first Style Guide stored `colors.{primary,…}` with five shades, `typography.{heading,body,mono}`, `shape.{radius,spacing[],shadows}` and `logo.{iconLibrary,imageryNotes}`. A v1 file loads as v2: its values are kept (the five shades stay as they were, the six steps v1 never had are generated from the base) and everything else takes its default.

The v2 panel reads and writes the full v2 shape without `compat=v1`. The backend still accepts the compatibility parameter for older clients and migrates saved v1 files.

## Aliases

One resolver (`resolveAlias`) is used by the renderer, the exporters and the components:

| Alias | Resolves to |
|---|---|
| `{primary.500}` | a palette step |
| `{status.danger}` | a status color |
| `{semantic.text}` | a semantic role, for the theme asked |
| `{typography.h1}` | a text style |
| `{spacing.md}`, `{radius.md}` | a length |
| `{radiusRoles.button}` | the radius step a role points at |
| `{elevation.md}` | a shadow |
| `{duration.fast}`, `{easing.standard}` | motion tokens |

An alias that names nothing is left as text and reported.

## What a save writes

A save normalizes the guide, adds 1 to the revision, records history and writes the project's files, each one only when its `exports` flag is on. A save that changes nothing keeps the revision. An explicit export `formats` list selects a subset of enabled exports; it cannot bypass the switches or write the other Tailwind target.

- **`DESIGN.md`**: frontmatter (`version: 2`, `name`, `description`, `colors` with every palette step as `primary-500`, every semantic role per theme as `light-background` / `dark-background` and every status; `typography` with every text style; `rounded`; `spacing`; `components` with `{colors.x}` aliases), then the sections Overview, Colors, Typography, Layout, Elevation & Depth, Shapes, Motion, Iconography, Logo & Imagery, Components, Accessibility, Do's and Don'ts, Responsive Behavior, Iteration Guide, Project Rules (when there are any) and Agent Instructions. All eight frontmatter keys are always present; an empty component map is `{}`. The same guide always gives the same bytes: there is no timestamp in the file, so it only changes in git when the guide does. The default guide is about 14 KB.
- **`tokens.json`**: groups `color` (palettes, `semantic.light` / `semantic.dark`, `status`), `fontFamily`, `typography`, `lineHeight`, `spacing`, `radius`, `radiusRole`, `breakpoint`, `border`, `shadow`, `duration`, `cubicBezier`, `zIndex`. Aliases stay aliases. `$extensions["dev.synabun"]` carries the revision, the time and the project path; a shadow or an easing that DTCG cannot express is left out and listed under `skipped`.
- **`tokens.css`**: every token under the configured selector (`:root`), with semantic colors pointing at palette steps through `var()`; the other theme's semantic colors under `[data-theme="dark"]`, `.dark` or `@media (prefers-color-scheme: dark)`; a `prefers-reduced-motion` block that zeroes the durations. With a custom root selector, attribute/class theme blocks cover both the root itself and an ancestor and outrank the base declarations.
- **Tailwind**: v4 is a CSS file with one `@theme` block and the other theme in a base layer; v3 is a CommonJS module whose `theme.extend` you spread into `tailwind.config`.
- **Logo files** are mirrored into `<project>/.synabun/style-guide/`.

Three things a save is careful about:

- A `DESIGN.md` somebody wrote by hand is copied once to `.synabun/style-guide/DESIGN.before-synabun.md` before the first save replaces it.
- A generated token file that the current settings no longer produce is removed, but only when the file says it is SynaBun's. A file the project put there is never touched. `DESIGN.md` stays where it is when its export is turned off. Cleanup considers only the current output directory; changing `outDir` leaves files in the old directory for the user to review. An explicit subset export does not perform stale-file cleanup.
- Files are written through a temp file and only when their content changed.

### Project pointers

Off by default. When on, `<project>/CLAUDE.md` and `<project>/AGENTS.md` get a short block that says the project has a `DESIGN.md` and how to use it, for agents that only read a project's instruction files. A file that did not exist is created with only the block. Turning the option off removes the block, and the file when it held nothing else. The block has its own markers (`synabun:styleguide:begin` / `end`), so it sits beside SynaBun's rules block without either one disturbing the other. Updating or removing a block preserves the surrounding bytes, including blank lines; removing an appended block can leave its separator blank line. Duplicate or damaged markers are refused. Token paths in the block include the configured output directory.

## Imports

`POST /api/style-guide/import` reads a guide from somewhere else. `mode: "preview"` returns the resulting guide and a leaf diff without saving; `mode: "apply"` saves it. `merge: "merge"` lays the import over the current guide; `merge: "replace"` lays it over the defaults and keeps what is not a design decision (the logo files, the agent and export settings).

| `kind` | Reads |
|---|---|
| `design-md` | A `DESIGN.md`: ours, Stitch's or a community one. The frontmatter is read by a small YAML-subset parser (maps, nested maps, lists, quoted and plain scalars, block text, comments); the prose gives the vibe, key characteristics, principles, dos and don'ts; nesting is limited to 64 levels |
| `dtcg` | A W3C design-tokens file |
| `css` | CSS custom properties: SynaBun's own, a Tailwind v4 `@theme`, or shadcn-style variables (`--background`, `--primary`, bare HSL triples), with a `.dark` block read as the dark theme |
| `tailwind-json` | A Tailwind theme as JSON |
| `codebase` | The project itself: `*.css`, `*.scss`, `tailwind.config.*` (read as text, never executed) and a hand-written root `DESIGN.md`. Skips `node_modules`, `dist`, `build`, `.git` and SynaBun's own output; stops after 400 files |
| `community` | `design-md/<slug>/DESIGN.md` from github.com/VoltAgent/awesome-design-md. The slug must match `^[a-z0-9.-]{1,40}$` before any request is made; the request stops after 10 s, refuses redirects, and limits the response to 2 MB while streaming it. These files describe public designs and are not official brand assets: the response says so |

Color names are sorted the same way for every kind: `<palette>-<step>`, `<theme>-<role>`, a status name, `primary` / `secondary` / `accent` / `neutral` as a palette base, the usual role names (`background`, `surface`, `foreground`, `on-primary`, `border`, …), and anything else as a new palette (at most eight). Importing a guide's own export over itself changes nothing.

## Presets

Eight complete starting points, each with SynaBun's own values: SynaBun Default, Minimal SaaS, Dark Developer, Editorial, Playful, Enterprise, Fintech Precision, Warm Organic. A preset replaces the design by default (`merge: "replace"`) and keeps the project's logo files and settings.

## History and proposals

Every saved revision is kept, newest first, 30 at most, with its source: `ui`, `import:<kind>`, `preset:<id>`, `proposal:<id>` or `restore:<rev>`. Unlabeled editor saves less than five minutes apart share one entry, so autosave does not use up the 30. Restoring a revision brings back its design as a new revision; the agent and export settings stay as they are now.

At most 200 proposals may be pending; additional submissions return 429 until some are reviewed. Rejected proposals retain their decision-time diff. Disabling proposals also prevents accepting a previously pending proposal.

**Agents never write the guide.** Their only write is a proposal: a JSON merge patch (RFC 7396; `null` deletes a key) and a reason. Nothing changes until the user accepts it. A proposal cannot touch `agents`, `exports` or the bookkeeping fields, and is refused when it would change nothing or when the user turned proposals off (`agents.allowProposals`). A pending proposal is always shown against the guide as it is now.

## What agents receive

1. **A block in the dispatch prompt.** When the Assistant dispatches a worker whose project has a saved guide, the prompt carries a `STYLE GUIDE` block before `PROJECT`: a summary of 300 to 500 tokens (never more than 600), the paths of `DESIGN.md` and the token files, and three instructions (use the tokens, call `style_guide` for more, propose instead of editing). Coding, Complex engineering, Design, Image creation and Video creation runs get it; the other classes do not (`agents.inject`, per class). A run without a class counts as coding. Image and video runs read the imagery direction and the image-generation prefix first. A project without a saved guide gets nothing.
2. **The design rules** tell a design run to call `style_guide`, to build on the token files and to propose changes.
3. **SynaBun's rules for every tool** (Claude Code, Codex, OpenCode, Gemini, Cursor) have a Design section: read the project's `DESIGN.md` (or call `style_guide`) before UI, design, marketing, copy or image work, and propose changes instead of editing the files.
4. **The Claude Code session-start hook** adds one line when the working directory has a `DESIGN.md`.
5. **The Assistant** knows that style guides exist and calls `style_guide` (action `summary`) before design work of its own.
6. **Project pointers** (opt-in, above).

## The `style_guide` tool

In every MCP profile. Pass `projectPath`: the project root or any path inside it. The default is the server's working directory, which is usually not the caller's project.

| Action | Does |
|---|---|
| `summary` | The compact block (`taskClass` `image_gen` or `video_gen` puts imagery first) |
| `get` | The summary, the written files, pending proposals and the full `DESIGN.md`, or one `section` of it |
| `tokens` | The tokens in a `format`: `json` (resolved values, the default), `dtcg`, `css`, `tailwind-v4`, `tailwind-v3`; optionally one `theme` |
| `contrast` | WCAG 2.x ratio with the AA / AAA verdicts, and APCA Lc as advice, for `fg` on `bg` (colors or aliases; `size: "large"` for large text and UI) |
| `propose` | Record a proposal: `changes` (a merge patch) and `reason`; optional `runId`, `provider`, `model` identify its author (the client also forwards a known caller run id) |
| `proposals` | List them, optionally by `status` |
| `export` | Write the saved guide's files into the project now (`formats` optional, selecting enabled exports) |
| `list` | Registered projects and whether each has a guide |

## REST API

All under `/api/style-guide`, permission key `styleGuide`. Routes that list answer a bare array; the others answer an object with `ok`. An error is `{ ok: false, error, code }`.

| Method & path | Body / query | Returns |
|---|---|---|
| GET `/` | `projectPath` | `{ ok, projectPath, config, designMd, hasDesignFile, assetsHash, revision, saved, summary, tokensEstimate, written: [{ format, path, exists }], proposalsPending }` (`saved: false` = the defaults) |
| PUT `/` | `{ projectPath, config, source?, label? }` | the GET shape after saving, plus `designPath`, `changed`, `writtenNow`, `pointers` |
| GET `/summary` | `projectPath`, `taskClass?` | `{ ok, summary, tokensEstimate, saved, revision, projectPath }` |
| GET `/preview-md` | `projectPath` | `text/markdown`, not written |
| GET `/export` | `projectPath`, `format` = `design-md` \| `dtcg` \| `css` \| `tailwind-v4` \| `tailwind-v3` \| `summary` \| `json`, `theme?`, `as=json?` | the text with its content type, or `{ ok, format, contentType, filename, text, revision }` with `as=json` |
| POST `/export` | `{ projectPath, formats? }` | `{ ok, written: [{ format, path, changed }] }` (409 without a saved guide) |
| POST `/import` | `{ projectPath, kind, text?, slug?, mode: preview \| apply, merge: merge \| replace }` | `{ ok, mode, config, diff: [{ path, from, to }], warnings, files?, source? }`; `apply` adds the PUT shape |
| GET `/presets` | — | `[{ id, name, description, swatches, fonts: { heading, body }, theme }]` |
| POST `/presets/apply` | `{ projectPath, presetId, merge? }` | like PUT, plus `diff` |
| GET `/history` | `projectPath` | `[{ revision, at, source, label }]` |
| POST `/history/restore` | `{ projectPath, revision }` | like PUT |
| GET `/proposals` | `projectPath`, `status?` | `[{ id, at, status, decidedAt, runId, provider, model, reason, changes, diff }]` |
| POST `/proposals` | `{ projectPath, changes, reason, runId?, provider?, model? }` | `{ ok, id, pending, ignored, diff }` (422 when proposals are off, 409 without a saved guide) |
| POST `/proposals/:id/accept` · `/reject` | `{ projectPath }` | accept: like PUT; reject: `{ ok, proposalsPending }` |
| POST `/contrast` | `{ fg, bg, size?, projectPath?, theme? }` | `{ ok, ratio, aa, aaa, aaLarge, aaaLarge, apca, fg, bg, size }` |
| POST `/scale` | `{ base, hueShift?, chroma? }` | `{ ok, base, steps: { 50…950 }, harmony: { complementary, analogous, triadic, splitComplementary }, oklch: { l, c, h } }` |
| POST `/dark-semantic` | `{ light: { role: color or alias }, neutral? }` | `{ ok, dark }` |
| GET `/defaults` | `projectPath` | `{ ok, config }`: the default guide |
| GET `/fonts` | `q?` | `[{ family, category, weights }]`: 225 popular Google Fonts, bundled |
| POST `/pointers` | `{ projectPath, enabled }` | `{ ok, enabled, files: [{ path, state }], revision }` |
| GET `/projects` | — | `[{ path, label, saved, revision, updatedAt, hasDesignFile, proposalsPending }]` |
| POST `/logo` | image body; query `projectPath`, `variantId?`, `name?`, `kind?`, `bg?` | `{ ok, variant, config, revision, assetsHash }` |
| DELETE `/logo/:variantId` | `projectPath` | `{ ok, config, revision }` |
| GET `/assets/:hash/:file` | — | the file |

`compat=v1` remains a backend compatibility option; the current editor never sends it.

## Rules

- No store write for agents: proposals only.
- The pure modules (schema, color, render, exports, summary, the importers' parsers) do no I/O. The codebase scan and the community fetch take the file system and `fetch` injected.
- Contrast: WCAG 2.2 AA by default (4.5:1 for text, 3:1 for large text and UI). APCA is shown as advice.
- Import text is limited to 2 MB, YAML/JSON nesting to 64 levels, and JSON imports to 100,000 nodes. Unsafe prototype/coercion keys are rejected in JSON imports and omitted during normalization/YAML parsing. Schema color fields must be strings; malformed object colors fall back or return 400.
- Assets require a registered project hash, an image extension (SVG, PNG, JPEG, WebP), and a regular contained path; logo uploads are limited to 4 MB. Uploaded SVGs keep the sandbox CSP and `nosniff`.
- Tests never use the live data home: every suite works in a temp data home and a temp project.

## Code map

| Part | Where |
|---|---|
| Schema, defaults, migration, aliases, merge patch, diff | `neural-interface/lib/style-guide/schema.js` |
| Color math (parsing, OKLCH, scales, WCAG, APCA, harmony, dark derivation) | `color.js` |
| Token helpers shared by the renderer and the exporters | `tokens.js` |
| `DESIGN.md` renderer | `render-design-md.js` |
| Exporters | `export-dtcg.js`, `export-css.js`, `export-tailwind.js` |
| Importers | `import.js` |
| Presets, summary, fonts | `presets.js`, `summary.js`, `fonts.json` |
| Project pointers | `pointers.js` |
| Store (paths, save, history, proposals, artifacts, `loadStyleGuideForRun`) | `store.js` |
| Routes | `api.js`, registered from `server.js` |
| Old import path | `neural-interface/lib/design-md.js` (re-exports) |
| MCP tool | `mcp-server/src/tools/style-guide-tools.ts`, client in `services/neural-interface.ts` |
| Prompt block and dispatcher wiring | `styleGuideBlock` in `lib/assistant-task-prompt.js`, `styleGuideFor` in `lib/assistant-dispatch.js` |
| Design rules, persona, rules for every tool, hook | `lib/assistant-playbooks/design.md`, `lib/assistant-persona.js`, `templates/rulesets/core.md`, `hooks/claude-code/session-start.mjs` |
| Tests | `neural-interface/tests/style-guide-{schema,color,render,export,import,summary,store,api-contract,ui-contract}.test.mjs`, `assistant-task-prompt.test.mjs`, `assistant-design.test.mjs`, `mcp-server/tests/style-guide-tools.test.ts` (see [Testing the panel](#testing-the-panel)) |

## Testing the panel

- `node --test neural-interface/tests/style-guide-ui-contract.test.mjs` (part of `npm test`): i18n keys and CRLF, label keys that are not message templates, client routes, color parity with the server, autosave and in-flight edits, and a round trip through the real store and routes (one edit in every section survives save → reload, and an unchanged re-save keeps the revision).
