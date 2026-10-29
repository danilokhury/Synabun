# Third-Party Software Notices

This inventory covers the direct third-party software used by SynaBun
2.0.0. Dependency ranges come from the package manifests; resolved
versions and declared licenses come from the committed npm lockfiles.

Transitive dependencies are installed by npm and retain the license and
notice files distributed in their own packages. The linked project pages and
the installed package contents are authoritative when a package publishes
additional or package-specific terms.

## MCP Server Runtime Dependencies

| Package | Manifest range | Locked version | Declared license | Project |
| --- | --- | --- | --- | --- |
| `@huggingface/transformers` | `^3.0.0` | 3.8.1 | Apache-2.0 | [npm](https://www.npmjs.com/package/@huggingface/transformers) |
| `@inquirer/prompts` | `^8.2.0` | 8.3.2 | MIT | [npm](https://www.npmjs.com/package/@inquirer/prompts) |
| `@modelcontextprotocol/sdk` | `^1.12.1` | 1.29.0 | MIT | [npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk) |
| `chalk` | `^5.6.2` | 5.6.2 | MIT | [npm](https://www.npmjs.com/package/chalk) |
| `express` | `^4.21.0` | 4.22.2 | MIT | [npm](https://www.npmjs.com/package/express) |
| `uuid` | `^14.0.0` | 14.0.0 | MIT | [npm](https://www.npmjs.com/package/uuid) |
| `zod` | `^3.24.2` | 3.25.76 | MIT | [npm](https://www.npmjs.com/package/zod) |

## MCP Server Development Dependencies

These packages are used to build or test SynaBun and are not installed as
runtime dependencies in the published package.

| Package | Manifest range | Locked version | Declared license | Project |
| --- | --- | --- | --- | --- |
| `@types/express` | `^5.0.0` | 5.0.6 | MIT | [npm](https://www.npmjs.com/package/@types/express) |
| `@types/node` | `^22.12.0` | 22.19.15 | MIT | [npm](https://www.npmjs.com/package/@types/node) |
| `tsx` | `^4.19.0` | 4.21.0 | MIT | [npm](https://www.npmjs.com/package/tsx) |
| `typescript` | `^5.9.3` | 5.9.3 | Apache-2.0 | [npm](https://www.npmjs.com/package/typescript) |
| `vitest` | `^4.1.0` | 4.1.2 | MIT | [npm](https://www.npmjs.com/package/vitest) |

## Neural Interface Runtime Dependencies

| Package | Manifest range | Locked version | Declared license | Project |
| --- | --- | --- | --- | --- |
| `@anthropic-ai/claude-agent-sdk` | `0.3.288` | 0.3.288 | Package-specific; see its README | [npm](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) |
| `@huggingface/transformers` | `^3.0.0` | 3.8.1 | Apache-2.0 | [npm](https://www.npmjs.com/package/@huggingface/transformers) |
| `@openai/codex-sdk` | `^0.160.0` | 0.160.0 | Apache-2.0 | [npm](https://www.npmjs.com/package/@openai/codex-sdk) |
| `@opencode-ai/sdk` | `1.18.34` | 1.18.34 | MIT | [npm](https://www.npmjs.com/package/@opencode-ai/sdk) |
| `@xterm/addon-fit` | `0.11.0` | 0.11.0 | MIT | [npm](https://www.npmjs.com/package/@xterm/addon-fit) |
| `@xterm/addon-search` | `0.16.0` | 0.16.0 | MIT | [npm](https://www.npmjs.com/package/@xterm/addon-search) |
| `@xterm/addon-serialize` | `0.14.0` | 0.14.0 | MIT | [npm](https://www.npmjs.com/package/@xterm/addon-serialize) |
| `@xterm/addon-unicode11` | `0.9.0` | 0.9.0 | MIT | [npm](https://www.npmjs.com/package/@xterm/addon-unicode11) |
| `@xterm/addon-web-links` | `0.12.0` | 0.12.0 | MIT | [npm](https://www.npmjs.com/package/@xterm/addon-web-links) |
| `@xterm/addon-webgl` | `0.19.0` | 0.19.0 | MIT | [npm](https://www.npmjs.com/package/@xterm/addon-webgl) |
| `@xterm/headless` | `6.0.0` | 6.0.0 | MIT | [npm](https://www.npmjs.com/package/@xterm/headless) |
| `@xterm/xterm` | `6.0.0` | 6.0.0 | MIT | [npm](https://www.npmjs.com/package/@xterm/xterm) |
| `adm-zip` | `^0.6.0` | 0.6.0 | MIT | [npm](https://www.npmjs.com/package/adm-zip) |
| `archiver` | `^7.0.1` | 7.0.1 | MIT | [npm](https://www.npmjs.com/package/archiver) |
| `dotenv` | `^16.4.7` | 16.6.1 | BSD-2-Clause | [npm](https://www.npmjs.com/package/dotenv) |
| `express` | `^4.21.2` | 4.22.2 | MIT | [npm](https://www.npmjs.com/package/express) |
| `node-html-markdown` | `^2.0.0` | 2.0.0 | MIT | [npm](https://www.npmjs.com/package/node-html-markdown) |
| `node-pty` | `^1.1.0` | 1.1.0 | MIT | [npm](https://www.npmjs.com/package/node-pty) |
| `playwright` | `^1.59.1` | 1.59.1 | Apache-2.0 | [npm](https://www.npmjs.com/package/playwright) |
| `undici` | `^8.5.0` | 8.8.0 | MIT | [npm](https://www.npmjs.com/package/undici) |
| `ws` | `^8.21.0` | 8.21.1 | MIT | [npm](https://www.npmjs.com/package/ws) |
| `yaml` | `2.9.1` | 2.9.1 | ISC | [npm](https://www.npmjs.com/package/yaml) |
| `zod` | `^4.4.3` | 4.4.3 | MIT | [npm](https://www.npmjs.com/package/zod) |

## Neural Interface Development Dependencies

| Package | Manifest range | Locked version | Declared license | Project |
| --- | --- | --- | --- | --- |
| `@codemirror/autocomplete` | `6.20.3` | 6.20.3 | MIT | [npm](https://www.npmjs.com/package/@codemirror/autocomplete) |
| `@codemirror/commands` | `6.11.1` | 6.11.1 | MIT | [npm](https://www.npmjs.com/package/@codemirror/commands) |
| `@codemirror/language` | `6.13.1` | 6.13.1 | MIT | [npm](https://www.npmjs.com/package/@codemirror/language) |
| `@codemirror/language-data` | `6.5.2` | 6.5.2 | MIT | [npm](https://www.npmjs.com/package/@codemirror/language-data) |
| `@codemirror/legacy-modes` | `6.5.5` | 6.5.5 | MIT | [npm](https://www.npmjs.com/package/@codemirror/legacy-modes) |
| `@codemirror/lint` | `6.9.7` | 6.9.7 | MIT | [npm](https://www.npmjs.com/package/@codemirror/lint) |
| `@codemirror/merge` | `6.12.2` | 6.12.2 | MIT | [npm](https://www.npmjs.com/package/@codemirror/merge) |
| `@codemirror/search` | `6.7.2` | 6.7.2 | MIT | [npm](https://www.npmjs.com/package/@codemirror/search) |
| `@codemirror/state` | `6.7.6` | 6.7.6 | MIT | [npm](https://www.npmjs.com/package/@codemirror/state) |
| `@codemirror/view` | `6.43.14` | 6.43.14 | MIT | [npm](https://www.npmjs.com/package/@codemirror/view) |
| `@highlightjs/cdn-assets` | `11.12.0` | 11.12.0 | BSD-3-Clause | [npm](https://www.npmjs.com/package/@highlightjs/cdn-assets) |
| `@lezer/highlight` | `1.2.5` | 1.2.5 | MIT | [npm](https://www.npmjs.com/package/@lezer/highlight) |
| `@replit/codemirror-indentation-markers` | `6.5.3` | 6.5.3 | MIT | [npm](https://www.npmjs.com/package/@replit/codemirror-indentation-markers) |
| `esbuild` | `^0.28.1` | 0.28.1 | MIT | [npm](https://www.npmjs.com/package/esbuild) |
| `html2canvas` | `1.4.1` | 1.4.1 | MIT | [npm](https://www.npmjs.com/package/html2canvas) |
| `marked` | `14.1.4` | 14.1.4 | MIT | [npm](https://www.npmjs.com/package/marked) |
| `mermaid` | `11.17.2` | 11.17.2 | MIT | [npm](https://www.npmjs.com/package/mermaid) |
| `three` | `0.169.0` | 0.169.0 | MIT | [npm](https://www.npmjs.com/package/three) |

## Browser-Delivered and Bundled Components

| Component | Version | Delivery | License | Project |
| --- | --- | --- | --- | --- |
| xterm.js | 6.0.0 | Bundled browser asset and npm dependency | MIT | [GitHub](https://github.com/xtermjs/xterm.js) |
| three.js | 0.169.0 | Bundled browser asset (`neural-interface/public/vendor/three/`) built from the npm development dependency | MIT | [GitHub](https://github.com/mrdoob/three.js) |
| marked | 14.1.4 | Bundled browser asset (`neural-interface/public/vendor/marked/`) copied from the npm development dependency | MIT | [GitHub](https://github.com/markedjs/marked) |
| highlight.js | 11.12.0 | Bundled browser asset (`neural-interface/public/vendor/highlight/`) copied from the npm development dependency `@highlightjs/cdn-assets` | BSD-3-Clause | [GitHub](https://github.com/highlightjs/highlight.js) |
| Mermaid | 11.17.2 | Bundled browser asset (`neural-interface/public/vendor/mermaid/`) copied from the npm development dependency | MIT | [GitHub](https://github.com/mermaid-js/mermaid) |
| html2canvas | 1.4.1 | Bundled browser asset (`neural-interface/public/vendor/html2canvas/`) copied from the npm development dependency | MIT | [GitHub](https://github.com/niklasvh/html2canvas) |
| yaml | 2.9.1 | Bundled browser asset (`neural-interface/public/vendor/yaml/`) built from the npm dependency | ISC | [GitHub](https://github.com/eemeli/yaml) |
| Caveat (font) | 5.3.0 (`@fontsource/caveat`) | Bundled browser asset (`neural-interface/public/vendor/caveat/`): the Latin 400 and 700 WOFF2 files, copied unmodified with the package's license | OFL-1.1 | [GitHub](https://github.com/googlefonts/caveat) |

### CodeMirror 6

The File Explorer's code editor. Bundled by `neural-interface/scripts/build-vendor.mjs` into `neural-interface/public/vendor/codemirror/`; its `manifest.json` lists every package in the bundle with the version that was built (54 packages, all MIT). The ones SynaBun depends on directly:

- **@codemirror/state** 6.7.6, **@codemirror/view** 6.43.14, **@codemirror/language** 6.13.1, **@codemirror/commands** 6.11.1, **@codemirror/search** 6.7.2, **@codemirror/autocomplete** 6.20.3, **@codemirror/lint** 6.9.7, **@codemirror/merge** 6.12.2, **@codemirror/language-data** 6.5.2, **@codemirror/legacy-modes** 6.5.5
  - **License:** MIT
  - **Copyright:** Copyright (C) 2018-2021 by Marijn Haverbeke and others
  - **URL:** https://codemirror.net/ (source: https://github.com/codemirror)
- **@lezer/highlight** 1.2.5
  - **License:** MIT
  - **Copyright:** Copyright (C) 2018 by Marijn Haverbeke and others
  - **URL:** https://lezer.codemirror.net/ (source: https://github.com/lezer-parser)
- **@replit/codemirror-indentation-markers** 6.5.3
  - **License:** MIT
  - **Copyright:** Copyright (c) 2022 Replit
  - **URL:** https://github.com/replit/codemirror-indentation-markers

Brought in by those, and in the bundle too (MIT, Copyright (C) Marijn Haverbeke and others):

- the languages `@codemirror/language-data` loads on demand: `@codemirror/lang-angular`, `@codemirror/lang-cpp`, `@codemirror/lang-css`, `@codemirror/lang-go`, `@codemirror/lang-html`, `@codemirror/lang-java`, `@codemirror/lang-javascript`, `@codemirror/lang-jinja`, `@codemirror/lang-json`, `@codemirror/lang-less`, `@codemirror/lang-liquid`, `@codemirror/lang-markdown`, `@codemirror/lang-php`, `@codemirror/lang-python`, `@codemirror/lang-rust`, `@codemirror/lang-sass`, `@codemirror/lang-sql`, `@codemirror/lang-vue`, `@codemirror/lang-wast`, `@codemirror/lang-xml`, `@codemirror/lang-yaml`, and `@codemirror/streamparser`
- the Lezer parser runtime and grammars: `@lezer/common`, `@lezer/lr`, `@lezer/cpp`, `@lezer/css`, `@lezer/go`, `@lezer/html`, `@lezer/java`, `@lezer/javascript`, `@lezer/json`, `@lezer/markdown`, `@lezer/php`, `@lezer/python`, `@lezer/rust`, `@lezer/sass`, `@lezer/xml`, `@lezer/yaml`
- `style-mod`, `w3c-keyname`, `crelt` and `@marijn/find-cluster-break`

### marked

The Markdown parser of the Assistant and the Claude, Codex and OpenCode panels. Its own browser build (`lib/marked.esm.js`), copied by `neural-interface/scripts/build-vendor.mjs` into `neural-interface/public/vendor/marked/` with the package's `LICENSE.md`.

- **Version:** 14.1.4
- **License:** MIT (the license file also carries the BSD-style notice of the original Markdown.pl, Copyright © 2004 John Gruber)
- **Copyright:** Copyright (c) 2018+, MarkedJS; Copyright (c) 2011-2018, Christopher Jeffrey
- **URL:** https://github.com/markedjs/marked

### mermaid

The diagrams of the Skills preview. Its own browser build (`dist/mermaid.esm.min.mjs` and the chunks it imports), copied by `neural-interface/scripts/build-vendor.mjs` into `neural-interface/public/vendor/mermaid/` with the package's `LICENSE`.

- **Version:** 11.17.2
- **License:** MIT
- **Copyright:** Copyright (c) 2014 - 2022 Knut Sveidqvist
- **URL:** https://github.com/mermaid-js/mermaid

Mermaid's build bundles its own dependencies, each under its own license: MIT (`@braintree/sanitize-url`, `@iconify/utils`, `@mermaid-js/parser`, `@upsetjs/venn.js`, `cytoscape`, `cytoscape-cose-bilkent`, `cytoscape-fcose`, `cose-base`, `layout-base`, `dagre-d3-es`, `dayjs`, `es-toolkit`, `katex`, `khroma`, `lodash-es`, `marked` 16, `roughjs` and its path helpers, `stylis`, `ts-dedent`, `uuid`), ISC (`d3` 7 and its `d3-*` modules, `internmap`, `delaunator`), BSD-3-Clause (`d3-sankey`, `d3-ease`, `rw` and the older `d3-array`, `d3-shape`, `d3-path` it brings), Apache-2.0 (`@chevrotain/types`), MPL-2.0 or Apache-2.0 (`dompurify`, used here under Apache-2.0) and the Unlicense (`robust-predicates`).

### highlight.js

The Codex panel's code-block highlighting. The official browser build of the version whose stylesheet the panel loaded before (`@highlightjs/cdn-assets`: `highlight.min.js` and `styles/github-dark-dimmed.min.css`; the `highlight.js` package itself ships no browser build), copied by `neural-interface/scripts/build-vendor.mjs` into `neural-interface/public/vendor/highlight/` with the package's `LICENSE`.

- **Version:** 11.12.0
- **License:** BSD-3-Clause
- **Copyright:** Copyright (c) 2006, Ivan Sagalaev; Josh Goebel and other contributors
- **URL:** https://github.com/highlightjs/highlight.js

### html2canvas

The card screenshot tool of the 3D map (`index.html`). Its own browser build (`dist/html2canvas.min.js`, which bundles `base64-arraybuffer`, `css-line-break`, `text-segmentation` and `utrie`, all MIT, by the same author), copied by `neural-interface/scripts/build-vendor.mjs` into `neural-interface/public/vendor/html2canvas/` with the package's `LICENSE`.

- **Version:** 1.4.1
- **License:** MIT
- **Copyright:** Copyright (c) 2012 Niklas von Hertzen
- **URL:** https://github.com/niklasvh/html2canvas

### yaml

The YAML parser behind the Skills Studio: it reads the frontmatter of skills, commands and agents, and changes it one key at a time without touching the rest (`neural-interface/lib/skills/`, `neural-interface/public/shared/skills/ss-frontmatter.js`). No dependencies of its own. The Studio's metadata form uses the same package in the browser: its browser build (`browser/dist/index.js`), bundled by `neural-interface/scripts/build-vendor.mjs` into one file in `neural-interface/public/vendor/yaml/` with the package's `LICENSE` and a `manifest.json`, loaded only when the editor opens.

- **Version:** 2.9.1
- **License:** ISC
- **Copyright:** Copyright Eemeli Aro
- **URL:** https://github.com/eemeli/yaml

### Caveat

The handwriting of the whiteboard and of the Workspace tour, served by SynaBun itself instead of a font CDN. The Latin subset of weights 400 and 700 (`caveat-latin-400-normal.woff2`, `caveat-latin-700-normal.woff2`) from the npm package `@fontsource/caveat` 5.3.0, copied unmodified into `neural-interface/public/vendor/caveat/` with the package's `LICENSE` as `OFL.txt`, a `caveat.css` that declares the two faces and a `manifest.json` with the SHA-256 of each file. The font is not sold on its own and its name is not changed (OFL 1.1, conditions 1 and 3).

- **Version:** 5.3.0 (`@fontsource/caveat`)
- **License:** SIL Open Font License 1.1
- **Copyright:** Copyright 2014 The Caveat Project Authors
- **URL:** https://github.com/googlefonts/caveat

## Vendored Code

| Component | Location | License | Project |
| --- | --- | --- | --- |
| QR Code generator library (Project Nayuki) | `neural-interface/lib/whatsapp/vendor/qrcodegen.js` | MIT | [Project page](https://www.nayuki.io/page/qr-code-generator-library) |

The QR Code generator is transpiled to JavaScript from
`typescript-javascript/qrcodegen.ts` at upstream commit
`8329a7108fc22be3e1eec0a9f9318978579e3621` of
[nayuki/QR-Code-generator](https://github.com/nayuki/QR-Code-generator), with
its license header kept. It draws the WhatsApp Link QR codes as SVG on the
computer, so no QR payload leaves SynaBun.

## Bundled Programs

| Program | Version | Delivery | License | Project |
| --- | --- | --- | --- | --- |
| cloudflared | 2026.10.0 (pinned in `neural-interface/lib/cloudflared/pins.json` with the SHA-256 of each release file and of the binary inside it) | Cloudflare's own release binary, unmodified. The application installers carry it; an npm or Git install downloads the same release file from Cloudflare's GitHub releases the first time a tunnel is started and checks it against the pinned SHA-256 before it runs | Apache-2.0 | [GitHub](https://github.com/cloudflare/cloudflared) |
| Git for Windows | 2.56.0.2 (`v2.56.0.windows.2`, pinned in `neural-interface/lib/git-bash/pins.json` with the SHA-256 of its release file and the digest of the tree it holds) | Git for Windows' own release file `Git-2.56.0.2-64-bit.tar.bz2`, unmodified but for five links into `/proc` it leaves out. Windows only: the Windows x64 installer carries it; an npm install on Windows that finds no Git Bash downloads the same release file from Git for Windows' GitHub releases and checks it against the pinned SHA-256 before it is unpacked. macOS and Linux builds carry none | GPL-2.0-only for Git (some of its parts LGPL-2.1); the MSYS2 and MinGW programs and libraries it is built with carry their own licenses (GPL, LGPL, BSD, MIT, Apache-2.0 and others) | [GitHub](https://github.com/git-for-windows/git) |

cloudflared opens the Cloudflare quick tunnel behind the public address
(invite links and remote MCP). It runs as a separate process, started only
when the user starts a tunnel. Using cloudflared and the tunnel service is
subject to Cloudflare's own terms.

Git for Windows provides the Git Bash and Unix tools Claude Code runs its
Bash tool and hooks with on Windows, used only on a PC that has no Git for
Windows of its own. Claude Code starts it; SynaBun itself uses only its git,
for its own git features on such a PC. Copyright (c) Linus Torvalds and the
Git contributors; the Git for Windows project and its contributors; the
authors of each component. The copy carries `LICENSE.txt` (Git's `COPYING`
and `LGPL-2.1` of the tag) and `SOURCE.txt` (where the source is: Git at the
pinned tag, https://github.com/git-for-windows/git/tree/v2.56.0.windows.2,
and the release's "Source code" archives; the other components at
https://github.com/git-for-windows). The license of each component is in the
copy's `usr/share/licenses`, `ucrt64/share/licenses` and `ucrt64/doc`.

## Installed On Demand (Not Distributed)

The WhatsApp Link's connector is not part of SynaBun and is not in any SynaBun
`package.json` or package. When the user sets up WhatsApp, SynaBun installs
it with `npm ci --omit=dev --omit=optional --ignore-scripts` from the
integrity-pinned lockfile in `neural-interface/lib/whatsapp/connector/` into
the data home, and it runs in a separate process that SynaBun talks to over
IPC.

| Package | Version | License | Role | Project |
| --- | --- | --- | --- | --- |
| `baileys` | 7.0.0-rc14 (pinned) | MIT | The unofficial WhatsApp Web client behind the WhatsApp Link | [GitHub](https://github.com/WhiskeySockets/Baileys) |
| `libsignal` | 6.0.0 (a dependency of `baileys`) | GPL-3.0 | Signal protocol for WhatsApp's end-to-end encryption; loaded only inside the connector process | [npm](https://www.npmjs.com/package/libsignal) |

The pinned tree has 64 packages (46 MIT, 13 BSD-3-Clause, and one each of
GPL-3.0, Apache-2.0, BlueOak-1.0.0, ISC and 0BSD); the lockfile lists each
with its license and integrity hash.

## Runtime-Downloaded Model

SynaBun downloads `Xenova/all-MiniLM-L6-v2` for local embeddings.
The model is distributed under Apache-2.0. See its
[model card](https://huggingface.co/Xenova/all-MiniLM-L6-v2).

## License References

- [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)
- [MIT License](https://opensource.org/license/mit)
- [BSD 2-Clause License](https://opensource.org/license/bsd-2-clause)
- [BSD 3-Clause License](https://opensource.org/license/bsd-3-clause)
- [GNU General Public License v3.0](https://www.gnu.org/licenses/gpl-3.0.html)
- [ISC License](https://opensource.org/license/isc-license-txt)

SynaBun's own Apache-2.0 terms are in [LICENSE](./LICENSE), and attribution
information is in [NOTICE](./NOTICE). The
`@anthropic-ai/claude-agent-sdk` lockfile metadata declares
`SEE LICENSE IN README.md`; review the dependency's distributed README and
license materials for its authoritative package-specific terms.

Claude Code, Codex, OpenCode and Gemini CLI are not dependencies of SynaBun and
are not distributed with it: the user installs them separately, under their
publishers' terms. The agent SDKs listed above are installed without the
executables they would otherwise carry (`lib/external-tools.js`).
