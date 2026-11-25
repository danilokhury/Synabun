// Which SynaBun Browser Bridge this app release works with, and who the extension is.
//
// The extension is not inside the app (no npm file, no installer payload). The app knows it by two things kept here,
// in app-owned code, so the server starts and pairs with no extension folder and no network:
//
//   identity   the extension's public key (the manifest's `key`). The extension ID is derived from it (EXTENSION_ID)
//              and is what the bridge accepts as an Origin. It never changes, so a paired browser stays paired.
//   release    one exact package per app release: its version, its address on synabun.ai, its size and SHA-256
//              (browser-extension-pin.json). The wire contract rejects unknown fields, so app and extension move in
//              lock-step: a download is installed only when it is exactly that file (lib/browser-extension-package.js).
//   files      the SHA-256 of every file of that package (the manifest's with its setup content script set to one
//              fixed port, TEMPLATE_PORT of lib/browser-extension-folder.js). The folder the browser loads is current
//              only when it holds exactly these files, byte for byte, and nothing else (inspectExtensionFolder).
//
// The pin file is written by scripts/extension/check-browser-extension-pin.mjs (Dev only) and checked by it before a
// release. Nothing here reads the network or the data home.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { EXTENSION_MAX_FILES, extensionFileAllowed } from './browser-extension-archive.js';

/**
 * The one host an extension package may come from, and the folder its versioned, immutable files live in. The website
 * serves its `Public/` tree under that same name (its build copies a .zip there byte for byte, and its image copies
 * no other top-level folder), so the file `Public/downloads/browser-extension/<name>` of the website is this address.
 */
export const EXTENSION_PACKAGE_HOST = 'synabun.ai';
export const EXTENSION_PACKAGE_PATH = '/Public/downloads/browser-extension/';
/** No package is ever larger than this, whatever a pin says (the real one is about 0.2 MB). */
export const EXTENSION_PACKAGE_MAX_BYTES = 8 * 1024 * 1024;

/** The file name of a version's package. */
export function extensionPackageName(version) { return `synabun-browser-bridge-${version}.zip`; }
/** The address of a version's package: https, the one host, a versioned path that is never reused. */
export function extensionPackageUrl(version) { return `https://${EXTENSION_PACKAGE_HOST}${EXTENSION_PACKAGE_PATH}${extensionPackageName(version)}`; }
/** The extension ID a browser gives the extension with this public key (base64 DER): SHA-256, 16 bytes, as a-p. */
export function extensionIdOf(key) {
  return createHash('sha256').update(Buffer.from(String(key), 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
}
/**
 * The extension's ID since it was first published. It is derived from the key, and a browser keeps an extension's
 * pairing under its ID: a pin whose key gives another ID would be another extension, and every owner would pair again.
 * scripts/extension/check-browser-extension-pin.mjs refuses to write or pass such a pin.
 */
export const HISTORICAL_EXTENSION_ID = 'hnoncohimcacnnlngchbkgpflpoefnil';
/** What is wrong with a pin's file list (an empty list: nothing). */
export function inventoryProblems(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) return ['files is not an object'];
  const names = Object.keys(files), problems = [], seen = new Set();
  if (!names.length || names.length > EXTENSION_MAX_FILES) problems.push(`files lists no file, or more than ${EXTENSION_MAX_FILES}`);
  if (!names.includes('manifest.json')) problems.push('files has no manifest.json');
  for (const name of names) {
    if (!extensionFileAllowed(name)) problems.push(`files names ${JSON.stringify(name.slice(0, 80))}, which no extension folder may hold`);
    else if (seen.has(name.toLowerCase())) problems.push(`files names ${name} twice`);
    seen.add(name.toLowerCase());
    if (typeof files[name] !== 'string' || !/^[a-f0-9]{64}$/.test(files[name])) problems.push(`files.${name} is not 64 lowercase hex characters`);
  }
  return problems;
}
/** What is wrong with a pin (an empty list: nothing). */
export function pinProblems(pin) {
  const problems = [];
  if (!pin || typeof pin !== 'object') return ['the pin is not an object'];
  if (typeof pin.name !== 'string' || !pin.name) problems.push('name is missing');
  if (typeof pin.key !== 'string' || !/^[A-Za-z0-9+/]{300,}={0,2}$/.test(pin.key)) problems.push('key is not a base64 public key');
  if (typeof pin.version !== 'string' || !/^\d+(\.\d+){1,3}$/.test(pin.version)) problems.push('version is not a dotted version');
  if (typeof pin.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(pin.sha256)) problems.push('sha256 is not 64 lowercase hex characters');
  if (!Number.isInteger(pin.size) || pin.size < 1 || pin.size > EXTENSION_PACKAGE_MAX_BYTES) problems.push(`size is not a whole number of bytes up to ${EXTENSION_PACKAGE_MAX_BYTES}`);
  if (typeof pin.version === 'string' && pin.url !== extensionPackageUrl(pin.version)) problems.push(`url is not ${extensionPackageUrl(pin.version)}`);
  problems.push(...inventoryProblems(pin.files));
  return problems;
}
/** Reads and checks a pin file. Throws with every problem named. */
export function readExtensionPin(path) {
  const { $comment: _comment, ...pin } = JSON.parse(readFileSync(path, 'utf8'));
  const problems = pinProblems(pin);
  if (problems.length) throw Object.assign(new Error(`The browser extension pin is not valid: ${problems.join('; ')}.`), { code: 'EXTENSION_PIN_INVALID' });
  return Object.freeze({ ...pin, files: Object.freeze({ ...pin.files }) });
}

export const EXTENSION_PIN_PATH = new URL('./browser-extension-pin.json', import.meta.url);
/** This release's pin: { name, key, version, url, sha256, size, files }. */
export const EXTENSION_PIN = readExtensionPin(EXTENSION_PIN_PATH);
/** The extension's ID in every Chromium browser, from every folder it is loaded from. */
export const EXTENSION_ID = extensionIdOf(EXTENSION_PIN.key);
