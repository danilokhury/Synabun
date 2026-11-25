#!/usr/bin/env node
/**
 * The extension-live check of a release: the browser extension package a tree pins is published on synabun.ai, as
 * pinned. SynaBun ships no extension: the app downloads the zip its pin names (neural-interface/lib/browser-extension-pin.json)
 * and verifies size, SHA-256 and every file, so a release whose pinned zip is not live leaves every new user without
 * an extension.
 *
 * The check is the app's own download (fetchExtensionPackage of the same tree): HTTPS to synabun.ai only (a redirect
 * elsewhere is not followed), identity encoding only, the pinned size and SHA-256, the pinned file inventory, a time
 * limit. Every failure, the network's included, is a problem: there is no flag that skips it.
 *
 * Two callers: the release machine's commands (with the pin of the commit they release), and publish.yml, which runs
 * this file as a program before anything is built or published:
 *
 *   node lib/release-extension-live.mjs
 *
 * As a program it checks the tree this file is in (the pin and the download code both come from that checkout) and
 * exits 1 on any problem, a tree without a pin or without the download code included.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const EXTENSION_PIN_PATH = 'neural-interface/lib/browser-extension-pin.json';
export const EXTENSION_PACKAGE_PATH = 'neural-interface/lib/browser-extension-package.js';
// Well under the app's own two minutes: a release machine or a runner has a good line, and a hung server must not hold a release.
export const EXTENSION_LIVE_TOTAL_MS = 90_000;
export const EXTENSION_LIVE_STALL_MS = 20_000;
const THIS_TREE = resolve(fileURLToPath(new URL('..', import.meta.url)));

const ORDER = 'Publish the pinned zip on synabun.ai first (the website), check it with `node scripts/extension/check-browser-extension-pin.mjs --live`, then run the release again.';

/**
 * Problems (an empty list: the pinned package is live and is the pinned one). `pinText`: the pin file's text from the
 * released tree, or null when that tree has none. `where`: names that tree in the message. `codeRoot`: the tree whose
 * download code runs (this file's own by default).
 */
export async function extensionLiveProblems({ pinText, where, fetchImpl = fetch, totalMs = EXTENSION_LIVE_TOTAL_MS, stallMs = EXTENSION_LIVE_STALL_MS, codeRoot = THIS_TREE }) {
  if (typeof pinText !== 'string' || !pinText.trim()) return [`browser extension: ${where} has no ${EXTENSION_PIN_PATH}, so the extension it needs cannot be checked. ${ORDER}`];
  let pin;
  try { pin = JSON.parse(pinText); } catch { return [`browser extension: ${EXTENSION_PIN_PATH} in ${where} is not JSON. ${ORDER}`]; }
  const url = typeof pin?.url === 'string' ? pin.url : '(no url)';
  let fetchExtensionPackage;
  try {
    // Loaded here, not at the top: the module reads its tree's pin when it loads, and a tree without one must still
    // be answered with a problem, never with an exception.
    ({ fetchExtensionPackage } = await import(pathToFileURL(join(codeRoot, EXTENSION_PACKAGE_PATH)).href));
    if (typeof fetchExtensionPackage !== 'function') throw new Error('fetchExtensionPackage is not exported');
  } catch (error) {
    return [`browser extension: the download code of ${where} (${EXTENSION_PACKAGE_PATH}) cannot be loaded (${error?.code || 'error'}: ${error?.message || error}). ${ORDER}`];
  }
  const work = mkdtempSync(join(tmpdir(), 'synabun-release-extension-'));
  try {
    await fetchExtensionPackage({ pin, workDir: work, fetchImpl, totalMs, stallMs });
    return [];
  } catch (error) {
    return [`browser extension: the package pinned in ${where} (${pin?.version || '?'}, ${url}) is not published as pinned (${error?.code || 'error'}: ${error?.message || error}). The pinned URL must be published on the website before the release. ${ORDER}`];
  } finally { rmSync(work, { recursive: true, force: true }); }
}

/** The pin file of a checked-out tree, or null when it has none. */
export function readTreePin(root) {
  try { return readFileSync(join(root, EXTENSION_PIN_PATH), 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

/** publish.yml's check: the tree `root` (this file's own) with its own pin and its own download code. */
export async function checkTree({ root = THIS_TREE, where = describeTree(), ...options } = {}) {
  let pinText;
  try { pinText = readTreePin(root); } catch (error) { return [`browser extension: ${EXTENSION_PIN_PATH} in ${where} cannot be read (${error?.code || 'error'}: ${error?.message || error}). ${ORDER}`]; }
  return extensionLiveProblems({ pinText, where, codeRoot: root, ...options });
}

const describeTree = (env = process.env) => /^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '') ? `the checked-out commit ${env.GITHUB_SHA.slice(0, 9)}` : 'the checked-out tree';
const oneLine = text => String(text).replace(/[\r\n]+/g, ' ');

export async function main({ root = THIS_TREE, log = console.log, error = console.error, ...options } = {}) {
  let problems;
  try { problems = await checkTree({ root, ...options }); } catch (cause) { problems = [`browser extension: the check failed (${cause?.message || cause}). ${ORDER}`]; }
  if (problems.length) {
    for (const problem of problems) error(`::error title=Browser extension not live::${oneLine(problem)}`);
    return 1;
  }
  const pin = JSON.parse(readTreePin(root));
  log(`browser extension: ${pin.version} (${pin.url}) is live on synabun.ai and is the pinned package.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
