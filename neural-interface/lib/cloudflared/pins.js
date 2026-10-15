// ═══════════════════════════════════════════
// SynaBun — cloudflared: which one
// ═══════════════════════════════════════════
//
// The one place that knows cloudflared, the program behind the public address
// (invite links, remote MCP): pins.json beside this file holds the version,
// Cloudflare's own release file for each platform, the SHA-256 of that file
// and of the binary inside it, and where each checksum comes from. The running
// application reads it here (manager.js downloads what it names on first use)
// and so does an application build (packaging/lib/stage.mjs and verify.mjs
// import this module from the application they stage), so an installer never
// carries a cloudflared the application would not have fetched itself.
//
// To move to another release: change `version`, `baseUrl` and `release`,
// download each file, and replace `sha256` / `size` with what GitHub publishes
// for the asset and `binary` with the checksum in the release's notes (for an
// archive: of the cloudflared inside it). tests/cloudflared-pins.test.mjs
// checks the shape; nothing checks the values but a download.
//
// Only node:fs, node:path and node:url here: a build imports this on the Node
// of the build machine, before the application has a dependency installed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PINS_PATH = fileURLToPath(new URL('./pins.json', import.meta.url));

/** Where every pinned file is: Cloudflare's releases on GitHub, over HTTPS, and nowhere else. */
export const RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/download/';

/** The folder of a packaged application that holds its cloudflared, beside `runtime/` and `app/`. */
export const BUNDLED_FOLDER = 'cloudflared';

/** Which native format each operating system runs (the names packaging/lib/util.mjs gives them). */
export const PLATFORM_FORMAT = Object.freeze({ darwin: 'macho', linux: 'elf', win32: 'pe' });

const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^\d{4}\.\d{1,2}\.\d{1,3}$/;
const FILE = /^cloudflared-[a-z0-9]+-[a-z0-9]+(?:\.[a-z0-9]+)?$/;
const KEY = /^(darwin|linux|win32)-(arm64|x64)$/;
const isSize = (value) => Number.isInteger(value) && value > 0 && value < 512 * 1024 * 1024;

/** The file name cloudflared has once it is in place. */
export function binaryName(platform = process.platform) {
  return platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

/** The cloudflared of a packaged application: `<resources>/cloudflared/cloudflared[.exe]`. */
export function bundledCloudflaredPath(resources, platform = process.platform) {
  return join(resources, BUNDLED_FOLDER, binaryName(platform));
}

/**
 * The pins as an object every reader can rely on, or an Error that lists what is wrong with them. A pin is
 * `{ key, platform, arch, version, file, url, sha256, size, archive, member, binary: { name, sha256, size, format } }`:
 * `archive` is null for a release file that is the binary itself, and then `binary` repeats the file's checksum.
 * @param {object} raw pins.json, parsed
 */
export function validateCloudflaredPins(raw) {
  const problems = [];
  const version = String(raw?.version || '');
  if (!VERSION.test(version)) problems.push(`version "${version}" is not a cloudflared release (YYYY.M.N)`);
  const baseUrl = String(raw?.baseUrl || '');
  if (baseUrl !== `${RELEASE_BASE}${version}/`) problems.push(`baseUrl must be ${RELEASE_BASE}${version}/`);
  if (typeof raw?.origin !== 'string' || !raw.origin.trim()) problems.push('origin (where the checksums come from) is missing');
  const platforms = {};
  for (const [key, entry] of Object.entries(raw?.platforms || {})) {
    const at = KEY.exec(key);
    if (!at) { problems.push(`"${key}" is not a platform (darwin|linux|win32)-(arm64|x64)`); continue; }
    const [, platform, arch] = at;
    const file = String(entry?.file || '');
    const archive = entry?.archive ?? null;
    const binary = entry?.binary || {};
    const wrong = [];
    if (!FILE.test(file)) wrong.push(`file "${file}" is not a cloudflared release file`);
    if (!SHA256.test(String(entry?.sha256 || ''))) wrong.push('sha256 is not 64 hex digits');
    if (!isSize(entry?.size)) wrong.push('size is not a number of bytes');
    if (archive !== null && archive !== 'tgz') wrong.push(`archive "${archive}" is not a kind this reads (tgz)`);
    if (archive && entry?.member !== 'cloudflared') wrong.push('member (the file inside the archive) must be "cloudflared"');
    if (!SHA256.test(String(binary.sha256 || ''))) wrong.push('binary.sha256 is not 64 hex digits');
    if (!isSize(binary.size)) wrong.push('binary.size is not a number of bytes');
    if (binary.format !== PLATFORM_FORMAT[platform]) wrong.push(`binary.format must be "${PLATFORM_FORMAT[platform]}" for ${platform}`);
    if (!archive && (binary.sha256 !== entry?.sha256 || binary.size !== entry?.size)) wrong.push('the file is the binary: binary must repeat its sha256 and size');
    if (wrong.length) { problems.push(...wrong.map((each) => `${key}: ${each}`)); continue; }
    platforms[key] = Object.freeze({
      key, platform, arch, version, file,
      url: `${baseUrl}${file}`,
      sha256: entry.sha256,
      size: entry.size,
      archive,
      member: archive ? entry.member : null,
      binary: Object.freeze({ name: binaryName(platform), sha256: binary.sha256, size: binary.size, format: binary.format }),
    });
  }
  if (!Object.keys(platforms).length && !problems.length) problems.push('no platform is pinned');
  if (problems.length) throw new Error(`The cloudflared pins are not usable: ${problems.join('; ')}`);
  return Object.freeze({
    version, baseUrl,
    release: String(raw.release || ''),
    license: String(raw.license || ''),
    origin: raw.origin,
    platforms: Object.freeze(platforms),
  });
}

/** pins.json, read and checked. Throws when the file is missing or wrong: nothing is downloaded by guesswork. */
export function readCloudflaredPins(path = PINS_PATH) {
  return validateCloudflaredPins(JSON.parse(readFileSync(path, 'utf8')));
}

/** The pin of a platform, or null when Cloudflare publishes no file for it (or none is pinned here). */
export function cloudflaredPinFor(pins, platform = process.platform, arch = process.arch) {
  return pins?.platforms?.[`${platform}-${arch}`] || null;
}
