// ═══════════════════════════════════════════
// SynaBun — Git for Windows: which one
// ═══════════════════════════════════════════
//
// Claude Code on Windows runs its Bash tool and every hook through Git Bash;
// without one it falls back to PowerShell, where commands written for bash
// fail (SynaBun's hooks of an installed app among them). SynaBun brings a
// private copy of Git for Windows for a PC that has none (resolver.js decides
// when it is the one in use). pins.json beside this file is the one place that
// knows which: the release, its file for Windows x64, the SHA-256 and size
// GitHub publishes for it, and what the archive holds once it is unpacked (the
// tree's digest, and the files SynaBun starts). The running application reads
// it here (manager.js downloads the file on a Windows npm install), and so does
// an application build (packaging/lib/git-bash.mjs imports this module from the
// application it stages): an installer never carries a Git the application
// would not have fetched itself.
//
// To move to another release: change `version`, `tag`, `baseUrl`, `release`
// and `source`, download the asset from the git-for-windows/git release, put
// GitHub's digest and size in `sha256` / `size` (check them against the
// release notes' table), unpack it with this application's own reader and
// record `tree` and `key` from what install.js treeDigest() reports. Fetch
// COPYING and LGPL-2.1 of that tag into licenses/. tests/git-bash-pins.test.mjs
// checks the shape; only a download checks the values.
//
// Only node:fs, node:path and node:url here: a build imports this on the Node
// of the build machine, before the application has a dependency installed.

import { readFileSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PINS_PATH = fileURLToPath(new URL('./pins.json', import.meta.url));
/** Git's own license texts of the pinned tag (COPYING, LGPL-2.1): what LICENSE.txt in the copy is made of. */
export const LICENSES_DIR = fileURLToPath(new URL('./licenses/', import.meta.url));

/** Where every pinned file is: Git for Windows' releases on GitHub, over HTTPS, and nowhere else. */
export const RELEASE_BASE = 'https://github.com/git-for-windows/git/releases/download/';
const RELEASE_PAGE = 'https://github.com/git-for-windows/git/releases/tag/';
const SOURCE_TREE = 'https://github.com/git-for-windows/git/tree/';

/** The folder of a packaged application that holds its Git for Windows, beside `runtime/` and `app/`. */
export const BUNDLED_FOLDER = 'git';

/** What SynaBun puts at the top of its copy, beside what the release file holds (never part of the tree's digest). */
export const MARKER = 'synabun-git.json';
export const ADDED_FILES = Object.freeze(['LICENSE.txt', 'SOURCE.txt', MARKER]);

const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+\.\d+$/;
const TAG = /^v(\d+\.\d+\.\d+)\.windows\.(\d+)$/;
const KEY = /^win32-(x64|arm64)$/;
const FILE_ARCH = Object.freeze({ x64: '64-bit', arm64: 'arm64' });
const isCount = (value) => Number.isInteger(value) && value > 0 && value < 2 ** 40;

/** A path inside the tree as the archive spells it: relative, forward slashes, no `.` or `..`, nothing Windows reads otherwise. */
export function isTreePath(value) {
  if (typeof value !== 'string' || !value || value.length > 400) return false;
  if (value.startsWith('/') || value.endsWith('/') || /[\\:*?"<>|\0-\x1f]/.test(value)) return false;
  return value.split('/').every((part) => part && part !== '.' && part !== '..' && !/[ .]$/.test(part));
}

/** `rel` (a tree path) inside `root`, in the separators of `platform`. */
export function inTree(root, rel, platform = process.platform) {
  return (platform === 'win32' ? win32 : posix).join(root, ...rel.split('/'));
}

/**
 * The pins as an object every reader can rely on, or an Error that lists what is wrong with them. A pin is
 * `{ key, platform, arch, version, tag, file, url, sha256, size, archive, skip, folders, tree, bash, git, cmd, keyFiles }`:
 * `folders` are the tree's empty folders (a digest of files does not see them; an installer of files carries none).
 * @param {object} raw pins.json, parsed
 */
export function validateGitBashPins(raw) {
  const problems = [];
  const version = String(raw?.version || '');
  const tag = String(raw?.tag || '');
  if (!VERSION.test(version)) problems.push(`version "${version}" is not a Git for Windows file version (2.56.0.2)`);
  const tagged = TAG.exec(tag);
  if (!tagged) problems.push(`tag "${tag}" is not a Git for Windows release tag (v2.56.0.windows.2)`);
  else if (`${tagged[1]}.${tagged[2]}` !== version) problems.push(`tag ${tag} is not the release of version ${version}`);
  const baseUrl = String(raw?.baseUrl || '');
  if (baseUrl !== `${RELEASE_BASE}${tag}/`) problems.push(`baseUrl must be ${RELEASE_BASE}${tag}/`);
  if (raw?.release !== `${RELEASE_PAGE}${tag}`) problems.push(`release must be ${RELEASE_PAGE}${tag}`);
  if (raw?.source !== `${SOURCE_TREE}${tag}`) problems.push(`source must be ${SOURCE_TREE}${tag}`);
  if (typeof raw?.origin !== 'string' || !raw.origin.trim()) problems.push('origin (where the checksums come from) is missing');
  if (typeof raw?.license !== 'string' || !raw.license.trim()) problems.push('license is missing');
  const platforms = {};
  for (const [key, entry] of Object.entries(raw?.platforms || {})) {
    const at = KEY.exec(key);
    if (!at) { problems.push(`"${key}" is not a platform Git for Windows is pinned for (win32-x64, win32-arm64)`); continue; }
    const arch = at[1];
    const wrong = [];
    const file = String(entry?.file || '');
    if (file !== `Git-${version}-${FILE_ARCH[arch]}.tar.bz2`) wrong.push(`file must be Git-${version}-${FILE_ARCH[arch]}.tar.bz2`);
    if (!SHA256.test(String(entry?.sha256 || ''))) wrong.push('sha256 is not 64 hex digits');
    if (!isCount(entry?.size)) wrong.push('size is not a number of bytes');
    if (entry?.archive !== 'tar.bz2') wrong.push(`archive "${entry?.archive}" is not a kind this reads (tar.bz2)`);
    const skip = Array.isArray(entry?.skip) ? entry.skip : null;
    if (!skip || !skip.every(isTreePath)) wrong.push('skip must be a list of paths inside the tree');
    const folders = Array.isArray(entry?.folders) ? entry.folders : null;
    if (!folders || !folders.every(isTreePath)) wrong.push('folders must be a list of paths inside the tree');
    const tree = entry?.tree || {};
    if (!isCount(tree.files) || !isCount(tree.bytes) || !SHA256.test(String(tree.sha256 || ''))) wrong.push('tree must give files, bytes and sha256');
    const keyFiles = entry?.key && typeof entry.key === 'object' ? entry.key : {};
    for (const [path, info] of Object.entries(keyFiles)) {
      if (!isTreePath(path) || !isCount(info?.size) || !SHA256.test(String(info?.sha256 || ''))) wrong.push(`key ${path}: a path inside the tree with its size and sha256`);
      if (ADDED_FILES.includes(path)) wrong.push(`key ${path}: a name SynaBun adds itself`);
    }
    for (const role of ['bash', 'git']) {
      if (!isTreePath(entry?.[role]) || !keyFiles[entry[role]]) wrong.push(`${role} must name one of the key files`);
    }
    if (wrong.length) { problems.push(...wrong.map((each) => `${key}: ${each}`)); continue; }
    platforms[key] = Object.freeze({
      key, platform: 'win32', arch, version, tag, file,
      url: `${baseUrl}${file}`,
      sha256: entry.sha256,
      size: entry.size,
      archive: entry.archive,
      skip: Object.freeze([...skip]),
      folders: Object.freeze([...folders]),
      tree: Object.freeze({ files: tree.files, bytes: tree.bytes, sha256: tree.sha256 }),
      bash: entry.bash,
      git: entry.git,
      cmd: posix.dirname(entry.git),
      keyFiles: Object.freeze(Object.fromEntries(Object.entries(keyFiles).map(([path, info]) => [path, Object.freeze({ size: info.size, sha256: info.sha256 })]))),
    });
  }
  if (!Object.keys(platforms).length && !problems.length) problems.push('no platform is pinned');
  if (problems.length) throw new Error(`The Git for Windows pins are not usable: ${problems.join('; ')}`);
  return Object.freeze({
    name: String(raw.name || 'Git for Windows'),
    version, tag, baseUrl,
    release: raw.release,
    source: raw.source,
    license: raw.license,
    origin: raw.origin,
    platforms: Object.freeze(platforms),
  });
}

/** pins.json, read and checked. Throws when the file is missing or wrong: nothing is downloaded by guesswork. */
export function readGitBashPins(path = PINS_PATH) {
  return validateGitBashPins(JSON.parse(readFileSync(path, 'utf8')));
}

/** The pin of a platform, or null: Git for Windows exists for Windows only (and is pinned here for x64). */
export function gitBashPinFor(pins, platform = process.platform, arch = process.arch) {
  if (platform !== 'win32') return null;
  return pins?.platforms?.[`win32-${arch}`] || null;
}

/** The Git for Windows of a packaged application: `<resources>/git`. */
export function bundledGitRoot(resources, platform = process.platform) {
  return (platform === 'win32' ? win32 : posix).join(resources, BUNDLED_FOLDER);
}

/** LICENSE.txt of SynaBun's copy: Git's own license texts of the pinned tag, after a line that says what they cover. */
export function licenseText(dir = LICENSES_DIR) {
  const copying = readFileSync(join(dir, 'COPYING'), 'utf8');
  const lgpl = readFileSync(join(dir, 'LGPL-2.1'), 'utf8');
  return [
    'Git for Windows is free software. Git itself is distributed under the GNU General Public License,',
    'version 2 (below, as COPYING of the Git source), some of its parts under the GNU Lesser General',
    'Public License, version 2.1 (after it, as LGPL-2.1 of the Git source). The other programs and',
    'libraries of this folder carry their own licenses: usr/share/licenses, ucrt64/share/licenses',
    'and ucrt64/doc. SOURCE.txt says where the source of all of it is.',
    '',
    '='.repeat(78),
    'COPYING',
    '='.repeat(78),
    '',
    copying.replace(/\s+$/, ''),
    '',
    '',
    '='.repeat(78),
    'LGPL-2.1',
    '='.repeat(78),
    '',
    lgpl.replace(/\s+$/, ''),
    '',
  ].join('\n');
}

/** SOURCE.txt of SynaBun's copy: what it is, where it came from, where its source is. */
export function sourceText(pins, pin) {
  return [
    `${pins.name} ${pins.version} (${pins.tag}), for Windows ${pin.arch}, as SynaBun ships it.`,
    '',
    'The files of this folder are those of the release file below, unchanged, except:',
    `  - left out: ${pin.skip.join(', ')}`,
    '    (links into /proc that Windows cannot create without administrator rights)',
    `  - added by SynaBun: ${ADDED_FILES.join(', ')}`,
    '',
    `Release file:  ${pin.url}`,
    `SHA-256:       ${pin.sha256}`,
    `Release:       ${pins.release}`,
    `Source of Git: ${pins.source}`,
    '               (and the "Source code" archives of the release above)',
    'Source of the other programs: the Git for Windows project, https://github.com/git-for-windows',
    '               (the MSYS2 and MINGW package definitions it builds them from)',
    `License:       ${pins.license} for Git (LICENSE.txt); each other program's in usr/share/licenses,`,
    '               ucrt64/share/licenses and ucrt64/doc.',
    '',
  ].join('\n');
}
