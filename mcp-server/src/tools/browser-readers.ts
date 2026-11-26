/**
 * Every script the MCP tools send the browser that the extension backend (SynaBun Browser Bridge) serves with a fixed,
 * read-only function of its own: one table, by reader id. The ids are the extension protocol's READER_IDS
 * (browser-extension/protocol.js) less the page readers the extension writes by hand (page.text, page.html).
 *
 * The extension's functions are GENERATED from this table (`npm run mcp:build`, then
 * `node scripts/extension/build-browser-readers.mjs`), so the Playwright backend and the extension read a page with the
 * same source; tests/browser-readers-sync.test.ts fails when browser-extension/readers-generated.js is not what this
 * table makes. A tool that sends one of these scripts passes its id (`extractor`), which the Playwright backend ignores.
 */
import { BROWSER_EXTRACTOR_SOURCES } from './browser-observe.js';
import { YOUTUBE_READER_SOURCES } from './youtube/readers.js';

export interface ReaderSource { script: string; scrollTarget?: string }

export const EXTENSION_READER_SOURCES: Readonly<Record<string, ReaderSource>> = Object.freeze({
  ...BROWSER_EXTRACTOR_SOURCES,
  ...YOUTUBE_READER_SOURCES,
});
