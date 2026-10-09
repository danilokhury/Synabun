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
| `zod` | `^4.4.3` | 4.4.3 | MIT | [npm](https://www.npmjs.com/package/zod) |

## Neural Interface Development Dependencies

| Package | Manifest range | Locked version | Declared license | Project |
| --- | --- | --- | --- | --- |
| `esbuild` | `^0.28.1` | 0.28.1 | MIT | [npm](https://www.npmjs.com/package/esbuild) |
| `three` | `0.169.0` | 0.169.0 | MIT | [npm](https://www.npmjs.com/package/three) |

## Browser-Delivered and Bundled Components

| Component | Version | Delivery | License | Project |
| --- | --- | --- | --- | --- |
| xterm.js | 6.0.0 | Bundled browser asset and npm dependency | MIT | [GitHub](https://github.com/xtermjs/xterm.js) |
| three.js | 0.169.0 | Bundled browser asset (`neural-interface/public/vendor/three/`) built from the npm development dependency | MIT | [GitHub](https://github.com/mrdoob/three.js) |
| marked | 14.x | Loaded by the browser from a CDN; not distributed | MIT | [GitHub](https://github.com/markedjs/marked) |
| highlight.js | 11.x | Loaded by the browser from a CDN; not distributed | BSD-3-Clause | [GitHub](https://github.com/highlightjs/highlight.js) |
| Mermaid | 11.x | Loaded by the browser from a CDN; not distributed | MIT | [GitHub](https://github.com/mermaid-js/mermaid) |
| html2canvas | 1.4.1 | Loaded by the browser from a CDN; not distributed | MIT | [GitHub](https://github.com/niklasvh/html2canvas) |

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

SynaBun's own Apache-2.0 terms are in [LICENSE](./LICENSE), and attribution
information is in [NOTICE](./NOTICE). The
`@anthropic-ai/claude-agent-sdk` lockfile metadata declares
`SEE LICENSE IN README.md`; review the dependency's distributed README and
license materials for its authoritative package-specific terms.

Claude Code, Codex, OpenCode and Gemini CLI are not dependencies of SynaBun and
are not distributed with it: the user installs them separately, under their
publishers' terms. The agent SDKs listed above are installed without the
executables they would otherwise carry (`lib/external-tools.js`).
