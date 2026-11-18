// The extension folder the owner loads in the browser ("Load unpacked"): a copy of the bundled browser-extension/ in
// the owner's data home (DATA_HOME/browser-extension/unpacked), so an npm update or a moved checkout never breaks the
// loaded extension. It is refreshed when the bundled copy changes and is not older than what is there; the browser
// then needs the extension's Reload (the server tells the owner: status `reloadNeeded`).
//
// The copy keeps the manifest's `key`, so the extension's ID is the same from this folder as from the bundled one
// (lib/browser-extension-bridge.js EXTENSION_ID). Only the setup page's content script changes: its matches name this
// server's own app port (127.0.0.1 and localhost), so the script runs on SynaBun's setup page and nowhere else.
//
// What is copied is an allowlist (the manifest, scripts, pages, styles, the icons), read as regular files only (a link
// is never followed). The folder is replaced in one rename where the system allows it; where it does not (Windows,
// a folder the browser holds open), the files are written in place. Nothing here is logged with a path.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The path of the setup page, and the content-script file that reads its one-time pairing token. */
export const SETUP_PAGE_PATH = '/extension-setup';
export const SETUP_SCRIPT = 'setup-content.js';
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(js|json|html|css|png)$/;

/** The setup page's origins for an app port: the content script's matches, and what the service worker accepts. */
export function setupMatches(appPort) {
  const port = Number(appPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Object.assign(new Error('Invalid app port.'), { code: 'INVALID_MESSAGE' });
  return [`http://127.0.0.1:${port}${SETUP_PAGE_PATH}*`, `http://localhost:${port}${SETUP_PAGE_PATH}*`];
}
/** The bundled files, by path relative to the folder: regular files of the allowlist, one level of `icons/`. */
export function bundledFiles(source) {
  const files = [];
  for (const [dir, prefix] of [[source, ''], [join(source, 'icons'), 'icons/']]) {
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names.sort()) {
      if (!FILE.test(name)) continue;
      const path = join(dir, name);
      try { if (!lstatSync(path).isFile()) continue; } catch { continue; }
      files.push({ rel: prefix + name, path });
    }
  }
  return files;
}
/** The manifest the folder gets: the bundled one, with the setup content script set to `appPort`. */
export function folderManifest(manifest, appPort) {
  const copy = structuredClone(manifest);
  copy.content_scripts = [{ matches: setupMatches(appPort), js: [SETUP_SCRIPT], run_at: 'document_idle', all_frames: false }];
  return copy;
}
/** Compares dotted versions (1.10.0 > 1.9.0). */
export function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map(n => Number.parseInt(n, 10) || 0), pb = String(b || '0').split('.').map(n => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return Math.sign(d); }
  return 0;
}
function contents(source, appPort) {
  const files = bundledFiles(source).map(f => ({ ...f, bytes: readFileSync(f.path) }));
  const manifestFile = files.find(f => f.rel === 'manifest.json');
  if (!manifestFile) throw Object.assign(new Error('The bundled extension has no manifest.'), { code: 'EXTENSION_FOLDER_FAILED' });
  const manifest = folderManifest(JSON.parse(manifestFile.bytes.toString('utf8')), appPort);
  manifestFile.bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const digest = createHash('sha256');
  for (const f of files) digest.update(f.rel).update('\0').update(f.bytes).update('\0');
  return { files, version: String(manifest.version || '0'), digest: digest.digest('hex') };
}
function readMarker(path) {
  try { if (!lstatSync(path).isFile()) return null; const v = JSON.parse(readFileSync(path, 'utf8')); return v && typeof v === 'object' ? v : null; } catch { return null; }
}
function writeFiles(folder, files) {
  mkdirSync(join(folder, 'icons'), { recursive: true, mode: 0o700 });
  for (const f of files) writeFileSync(join(folder, f.rel), f.bytes, { mode: 0o600 });
}

/**
 * Prepares or refreshes the owner's extension folder. `force` refreshes even when the bundled version is older than
 * what is there (never used at start). Returns { folder, version, changed, previousVersion, appPort }. Throws
 * EXTENSION_FOLDER_FAILED when the folder cannot be written.
 */
export function prepareExtensionFolder({ source, home, appPort, now = Date.now, force = false }) {
  const root = join(home, 'browser-extension'), folder = join(root, 'unpacked'), markerPath = join(root, 'unpacked.json');
  const { files, version, digest } = contents(source, appPort);
  const marker = readMarker(markerPath);
  const present = (() => { try { return lstatSync(join(folder, 'manifest.json')).isFile(); } catch { return false; } })();
  const same = present && marker?.digest === digest;
  const older = present && marker?.version && compareVersions(version, marker.version) < 0;
  if (same || older && !force) return { folder, version: marker?.version || version, changed: false, previousVersion: marker?.version || null, appPort: marker?.appPort ?? Number(appPort), stale: !same };
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 }); try { chmodSync(root, 0o700); } catch {}
    const staging = join(root, `unpacked.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      writeFiles(staging, files);
      // One rename where the system allows it; else the files are written in place (a folder the browser holds open).
      const retired = `${folder}.${randomBytes(6).toString('hex')}.old`;
      let swapped = false;
      try {
        if (present || (() => { try { lstatSync(folder); return true; } catch { return false; } })()) renameSync(folder, retired);
        renameSync(staging, folder); swapped = true;
      } catch {
        try { lstatSync(folder); } catch { try { renameSync(retired, folder); } catch {} }
      }
      if (!swapped) writeFiles(folder, files);
      rmSync(retired, { recursive: true, force: true });
    } finally { rmSync(staging, { recursive: true, force: true }); }
    const record = { v: 1, version, digest, appPort: Number(appPort), preparedAt: now() };
    const temporary = `${markerPath}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 }); renameSync(temporary, markerPath);
  } catch (error) {
    if (error?.code === 'EXTENSION_FOLDER_FAILED') throw error;
    throw Object.assign(new Error('The extension folder could not be written.'), { code: 'EXTENSION_FOLDER_FAILED' });
  }
  return { folder, version, changed: true, previousVersion: marker?.version || null, appPort: Number(appPort), stale: false };
}
/** What the folder holds now, without writing: { folder, version, prepared }. */
export function extensionFolderState(home) {
  const root = join(home, 'browser-extension'), marker = readMarker(join(root, 'unpacked.json'));
  return { folder: join(root, 'unpacked'), version: marker?.version || null, prepared: !!marker, appPort: marker?.appPort ?? null, preparedAt: marker?.preparedAt ?? null, root: dirname(join(root, 'unpacked')) };
}
