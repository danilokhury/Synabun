# Third-Party Software Notices

This inventory covers the direct third-party software used by SynaBun
2026.7.20. Dependency ranges come from the package manifests; resolved
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
| `@anthropic-ai/claude-agent-sdk` | `0.3.174` | 0.3.174 | Package-specific; see its README | [npm](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) |
| `@huggingface/transformers` | `^3.0.0` | 3.8.1 | Apache-2.0 | [npm](https://www.npmjs.com/package/@huggingface/transformers) |
| `@openai/codex-sdk` | `^0.121.0` | 0.121.0 | Apache-2.0 | [npm](https://www.npmjs.com/package/@openai/codex-sdk) |
| `@opencode-ai/sdk` | `^1.14.39` | 1.14.39 | MIT | [npm](https://www.npmjs.com/package/@opencode-ai/sdk) |
| `@xterm/addon-fit` | `0.11.0` | 0.11.0 | MIT | [npm](https://www.npmjs.com/package/@xterm/addon-fit) |
| `@xterm/addon-search` | `0.16.0` | 0.16.0 | MIT | [npm](https://www.npmjs.com/package/@xterm/addon-search) |
| `@xterm/addon-unicode11` | `0.9.0` | 0.9.0 | MIT | [npm](https://www.npmjs.com/package/@xterm/addon-unicode11) |
| `@xterm/addon-web-links` | `0.12.0` | 0.12.0 | MIT | [npm](https://www.npmjs.com/package/@xterm/addon-web-links) |
| `@xterm/addon-webgl` | `0.19.0` | 0.19.0 | MIT | [npm](https://www.npmjs.com/package/@xterm/addon-webgl) |
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

## Browser-Delivered and Bundled Components

| Component | Version | Delivery | License | Project |
| --- | --- | --- | --- | --- |
| xterm.js | 6.0.0 | Bundled browser asset and npm dependency | MIT | [GitHub](https://github.com/xtermjs/xterm.js) |
| three.js | 0.169.0 | Browser ESM import | MIT | [GitHub](https://github.com/mrdoob/three.js) |
| 3d-force-graph | 1.73.4 | Browser ESM import | MIT | [GitHub](https://github.com/vasturiano/3d-force-graph) |
| Tween.js | 23.1.3 | Browser ESM import | MIT | [GitHub](https://github.com/tweenjs/tween.js) |

## Runtime-Downloaded Model

SynaBun downloads `Xenova/all-MiniLM-L6-v2` for local embeddings.
The model is distributed under Apache-2.0. See its
[model card](https://huggingface.co/Xenova/all-MiniLM-L6-v2).

## License References

- [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)
- [MIT License](https://opensource.org/license/mit)
- [BSD 2-Clause License](https://opensource.org/license/bsd-2-clause)

SynaBun's own Apache-2.0 terms are in [LICENSE](./LICENSE), and attribution
information is in [NOTICE](./NOTICE). The
`@anthropic-ai/claude-agent-sdk` lockfile metadata declares
`SEE LICENSE IN README.md`; review the dependency's distributed README and
license materials for its authoritative package-specific terms.
