// ═══════════════════════════════════════════
// SynaBun — WhatsApp Link: a local file the Assistant sends to the owner
// ═══════════════════════════════════════════
//
// whatsapp_send_file (docs/whatsapp.md → Sending files). This runs in the
// WhatsApp host, inside the send queue (host-core.js sendToOwner), right
// before the file goes out: the main process never opens it. A refusal at
// any step sends nothing.
//
//   1. The request (checkRequestPath, planFileSend): an absolute path of at
//      most 2048 characters without control characters; never a URL, a
//      network share or device path, a system path (/dev, /proc, /sys and the
//      macOS /.vol, /.nofollow, /.resolve), or (Windows) an alternate data
//      stream. `as` auto picks the form by extension (FILE_TYPES); a native
//      form that does not match the extension is refused ("use auto or
//      document"); a photo, video or audio file over 16 MiB goes as a
//      document; native audio has no caption.
//   2. The denylist (fileDenial), on the path as written AND on the real file
//      it leads to (symlinks resolved; a share or a system path there is
//      refused too): the protected roots (the WhatsApp session, SynaBun's data
//      home except its generated media in data/media) and explicit families of
//      secrets, by place and by name, for macOS, Linux and Windows (FAMILIES).
//      Matching ignores letter case. The roots and the names right under the
//      home are decided again by device and inode (placeDenial), because the
//      disk takes other spellings of a folder that realpath keeps (macOS:
//      /System/Volumes/Data/Users/… is /Users/…).
//   3. The read (prepareLocalFile): a regular, non-empty file with one hard
//      link, at most 100 MiB (refused before anything is read), opened
//      without following a link (O_NOFOLLOW where the platform has it, and
//      O_NONBLOCK so a FIFO swapped in cannot hang the open), still the file
//      the checks saw (device, inode, size), its real path unchanged and
//      still naming the opened file (a parent folder swapped for a link and
//      back), on Linux the open file's own name (/proc/self/fd) checked too,
//      read to its end and not one byte further, and unchanged when the read
//      ends. A process of the same user that wins a run of precisely timed
//      swaps between these checks is the limit of what a path check can do.
//
// The content is never inspected: a secret inside an ordinary file under an
// ordinary name is sent like any other file. The lists are explicit, a
// speed bump with a long list of known places, not a sandbox (SECURITY.md).

import { constants as fsConstants, promises as fsp, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { ERR, FILE_SEND_AS, LIMITS } from './protocol.js';

/** A refusal: `code` is a protocol.js ERR code (BAD_REQUEST, FILE_FORBIDDEN, FILE_TOO_LARGE, FILE_INVALID). */
export class LocalFileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalFileError';
    this.code = code;
  }
}
const refuse = (code, message) => { throw new LocalFileError(code, message); };

// ── types ────────────────────────────────────────────────────────────────────

const TYPE_ROWS = [
  ['jpg', 'image', 'image/jpeg'], ['jpeg', 'image', 'image/jpeg'], ['png', 'image', 'image/png'], ['webp', 'image', 'image/webp'],
  ['mp4', 'video', 'video/mp4'],
  ['ogg', 'audio', 'audio/ogg'], ['opus', 'audio', 'audio/ogg'], ['mp3', 'audio', 'audio/mpeg'], ['m4a', 'audio', 'audio/mp4'],
  ['pdf', 'document', 'application/pdf'], ['md', 'document', 'text/markdown'], ['patch', 'document', 'text/x-diff'], ['diff', 'document', 'text/x-diff'],
  ['txt', 'document', 'text/plain'], ['csv', 'document', 'text/csv'], ['json', 'document', 'application/json'], ['zip', 'document', 'application/zip'],
  ['doc', 'document', 'application/msword'], ['xls', 'document', 'application/vnd.ms-excel'],
  ['docx', 'document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xlsx', 'document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['pptx', 'document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['gif', 'document', 'image/gif'], ['svg', 'document', 'image/svg+xml'], ['wav', 'document', 'audio/wav'], ['webm', 'document', 'video/webm'],
  ['7z', 'document', 'application/x-7z-compressed'], ['gz', 'document', 'application/gzip'],
];
/** Extension → { type, mimetype }: image, video and audio go in their native form under `as: 'auto'`, the rest as documents. */
export const FILE_TYPES = Object.freeze(Object.fromEntries(TYPE_ROWS.map(([ext, type, mimetype]) => [ext, Object.freeze({ type, mimetype })])));
export const UNKNOWN_MIMETYPE = 'application/octet-stream';

/** The part after the last dot, lower case ('' without one). */
function extOf(name) {
  const text = String(name || '').toLowerCase();
  const dot = text.lastIndexOf('.');
  return dot >= 0 ? text.slice(dot + 1) : '';
}

/** A file name → { ext, detected: image|video|audio|document, mimetype }. */
export function fileTypeOf(name) {
  const ext = extOf(name);
  const known = Object.hasOwn(FILE_TYPES, ext) ? FILE_TYPES[ext] : null;
  return { ext, detected: known ? known.type : 'document', mimetype: known ? known.mimetype : UNKNOWN_MIMETYPE };
}

const A = Object.freeze({ image: 'an image', video: 'a video', audio: 'an audio', document: 'a document' });

/**
 * How a file goes, from its name and size → { type, detected, mimetype, fallback, fileName, caption }.
 *   type      `as: 'document'`, or more than 16 MiB → document; else what the extension says
 *   fallback  a photo, video or audio file that goes as a document only because of its size
 *   caption   null for native audio (refused when one was given) and for a blank one
 * Throws BAD_REQUEST: an unknown `as`, a native form that does not match the extension, a caption on
 * native audio, a caption over 1024 characters.
 */
export function planFileSend({ name, size = 0, as = 'auto', caption = null } = {}) {
  const mode = as === undefined || as === null ? 'auto' : as;
  if (!FILE_SEND_AS.includes(mode)) refuse(ERR.BAD_REQUEST, `as must be one of ${FILE_SEND_AS.join(', ')}`);
  if (caption !== null && caption !== undefined && typeof caption !== 'string') refuse(ERR.BAD_REQUEST, 'caption must be text');
  const text = typeof caption === 'string' ? caption : '';
  if (text.length > LIMITS.MAX_FILE_CAPTION) refuse(ERR.BAD_REQUEST, `caption is longer than ${LIMITS.MAX_FILE_CAPTION} characters`);
  const fileName = String(name || 'file');
  const { detected, mimetype } = fileTypeOf(fileName);
  if (mode !== 'auto' && mode !== 'document' && mode !== detected) {
    refuse(ERR.BAD_REQUEST, `${fileName} is not ${A[mode]} file by its extension (it would go as ${A[detected]}): use as "auto" or "document"`);
  }
  const type = mode === 'document' || Number(size) > LIMITS.MAX_FILE_MEDIA_BYTES ? 'document' : detected;
  const fallback = type === 'document' && detected !== 'document' && mode !== 'document';
  if (type === 'audio' && text.trim()) refuse(ERR.BAD_REQUEST, 'audio goes without a caption: leave the caption out, or send it as "document"');
  return { type, detected, mimetype, fallback, fileName, caption: type !== 'audio' && text.trim() ? text : null };
}

// ── the request ──────────────────────────────────────────────────────────────

const CONTROL = /[\u0000-\u001f\u007f]/;
const URL_LIKE = /^[a-z][a-z0-9+.-]+:/i;      // http:, file:, smb:, data: … (a drive letter is one letter)
const SHARE_OR_DEVICE = /^(?:[\\/]{2}|\\\?\?\\)/; // \\server\share, //server, \\?\, \\.\, \??\
// The system's own namespaces (macOS and Linux), never a file of the user's: devices and the open files of
// a process (/dev/fd/3 is the host's own descriptor 3), process and kernel files, and the macOS kernel
// prefixes that open any file under another spelling (/.vol/<device>/<inode>, /.nofollow/…, /.resolve/…).
const SYSTEM_TOPS = new Set(['dev', 'proc', 'sys', '.vol', '.nofollow', '.resolve']);
const systemPath = (abs) => SYSTEM_TOPS.has(String(abs).split('/')[1]?.toLowerCase());

/**
 * The path a request names, checked for its shape alone (no filesystem access) → the absolute path,
 * normalized (`.` and `..` resolved lexically). BAD_REQUEST: not text, empty, too long, a control
 * character, not absolute (on Windows: no drive letter). FILE_FORBIDDEN: a URL, a network share or a
 * device path, an alternate data stream (Windows), a system path (/dev, /proc, /sys, /.vol, …).
 */
export function checkRequestPath(value, { platform = process.platform } = {}) {
  if (typeof value !== 'string' || !value.trim()) refuse(ERR.BAD_REQUEST, 'path must be the absolute path of a file on this computer');
  if (value.length > LIMITS.MAX_FILE_PATH) refuse(ERR.BAD_REQUEST, `path is longer than ${LIMITS.MAX_FILE_PATH} characters`);
  if (CONTROL.test(value)) refuse(ERR.BAD_REQUEST, 'path holds a control character');
  const win = platform === 'win32';
  if (SHARE_OR_DEVICE.test(value)) refuse(ERR.FILE_FORBIDDEN, `${value} is a network share or a device path: only a file on this computer's own disk is sent`);
  if (URL_LIKE.test(value)) refuse(ERR.FILE_FORBIDDEN, `${value} is a URL: only a file on this computer's own disk is sent`);
  const p = win ? path.win32 : path.posix;
  if (win) {
    if (!/^[a-z]:[\\/]/i.test(value)) refuse(ERR.BAD_REQUEST, 'path must be absolute, starting with a drive letter (C:\\…)');
    // C:\file.txt:stream — any ':' after the drive's own names an alternate data stream.
    if (value.indexOf(':', 2) !== -1) refuse(ERR.FILE_FORBIDDEN, `${value} names an alternate data stream: only a whole file is sent`);
  } else if (!p.isAbsolute(value)) {
    refuse(ERR.BAD_REQUEST, 'path must be absolute (start with /)');
  }
  const resolved = p.resolve(value);
  if (!win && systemPath(resolved)) refuse(ERR.FILE_FORBIDDEN, `${value} is a system path (a device, a process's files): only a file on this computer's own disk is sent`);
  return resolved;
}

// ── the denylist ─────────────────────────────────────────────────────────────

const escapeRe = (text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
/** "library/application support/google/chrome*" → one RegExp per path segment (`*`: any run inside a segment). */
const run = (spec) => spec.split('/').map((segment) => new RegExp(`^${segment.split('*').map(escapeRe).join('[^/]*')}$`));

/**
 * The families of secrets, by place (a run of path segments anywhere in the path), by file name, by
 * name pattern and by extension. Every value is lower case; matching lower-cases the path.
 */
const FAMILY_ROWS = [
  {
    why: 'a browser profile (saved passwords, cookies and sessions)',
    places: [
      // macOS
      'library/application support/google/chrome*', 'library/application support/chromium', 'library/application support/bravesoftware',
      'library/application support/microsoft edge*', 'library/application support/firefox', 'library/application support/arc',
      'library/application support/com.operasoftware.opera*', 'library/application support/vivaldi', 'library/safari',
      'library/containers/com.apple.safari', 'library/cookies', 'library/httpstorages',
      // Linux (native, snap and flatpak)
      '.config/google-chrome*', '.config/chromium', '.config/bravesoftware', '.config/microsoft-edge*', '.mozilla',
      '.config/opera*', '.config/vivaldi*', 'snap/firefox', 'snap/chromium', '.var/app/org.mozilla.firefox', '.var/app/com.google.chrome',
      '.var/app/org.chromium.chromium', '.var/app/com.brave.browser', '.var/app/com.microsoft.edge', '.var/app/com.opera.opera', '.var/app/com.vivaldi.vivaldi',
      // Windows
      'appdata/local/google/chrome*', 'appdata/local/chromium', 'appdata/local/bravesoftware', 'appdata/local/microsoft/edge*',
      'appdata/roaming/mozilla', 'appdata/local/mozilla', 'appdata/roaming/opera software', 'appdata/local/vivaldi', 'appdata/local/packages/thebrowsercompany.arc*',
      // Anti-detect browsers (MoreLogin) and SynaBun's own browser profiles, wherever they are
      '*morelogin*', 'browser-profiles',
    ],
    names: ['logins.json', 'key3.db', 'key4.db', 'cert8.db', 'cert9.db', 'signons.sqlite', 'cookies.sqlite', 'login data', 'login data for account', 'web data', 'cookies', 'cookies.binarycookies', 'local state'],
  },
  {
    why: 'an app\'s sign-in store (Discord, Slack, Telegram, Signal, WhatsApp Desktop)',
    places: [
      'library/application support/discord*', '.config/discord*', 'appdata/roaming/discord*', '.var/app/com.discordapp.discord',
      'library/application support/slack', 'library/containers/com.tinyspeck.slackmacgap', '.config/slack', 'appdata/roaming/slack', 'appdata/local/packages/91750d7e.slack*', '.var/app/com.slack.slack',
      'tdata', 'library/application support/telegram desktop', 'library/group containers/*.ru.keepcoder.telegram', '.local/share/telegramdesktop', 'appdata/roaming/telegram desktop', '.var/app/org.telegram.desktop',
      'library/application support/signal', '.config/signal', 'appdata/roaming/signal', '.var/app/org.signal.signal',
      'library/group containers/group.net.whatsapp*', 'library/containers/net.whatsapp.whatsapp', 'library/containers/desktop.whatsapp', 'library/application support/whatsapp',
      'appdata/local/packages/5319275a.whatsappdesktop*', 'appdata/roaming/whatsapp', '.config/whatsapp*',
    ],
  },
  {
    why: 'a password manager or a keychain',
    places: ['*1password*', '*agilebits*', '*bitwarden*', 'library/keychains', '.password-store', '.config/op', 'keepassxc', '.keepassxc',
      // GNOME Keyring, KWallet; Windows Credential Manager, its DPAPI master keys and the Vault
      '.local/share/keyrings', '.local/share/kwalletd', '.kde/share/apps/kwallet', '.kde4/share/apps/kwallet',
      'appdata/roaming/microsoft/credentials', 'appdata/local/microsoft/credentials', 'appdata/roaming/microsoft/protect',
      'appdata/local/microsoft/vault', 'appdata/roaming/microsoft/vault'],
    exts: ['kdbx', 'kdb', 'keychain', 'keychain-db', 'keyring', 'kwl'],
  },
  {
    why: 'a mail or message store',
    places: [
      'library/mail', 'library/containers/com.apple.mail', 'library/group containers/group.com.apple.mail', 'library/messages',
      'library/containers/com.apple.ichat', 'library/containers/com.apple.messages',
      '.thunderbird', 'library/thunderbird', 'appdata/roaming/thunderbird', '.var/app/org.mozilla.thunderbird', 'snap/thunderbird',
    ],
  },
  {
    why: 'a shell history',
    places: ['.zsh_sessions'],
    names: ['.zsh_history', '.zhistory', '.bash_history', '.sh_history', '.history', 'fish_history', '.python_history', '.node_repl_history',
      '.psql_history', '.mysql_history', '.sqlite_history', '.rediscli_history', '.irb_history', 'consolehost_history.txt'],
  },
  {
    why: 'credentials (SSH, GnuPG, cloud, registry and git logins)',
    places: ['.ssh', '.gnupg', '.aws', '.azure', '.docker', '.kube', '.config/gcloud', '.config/gh', 'appdata/roaming/gcloud', 'appdata/roaming/github cli', 'appdata/roaming/gnupg', '.terraform.d',
      // CLI token stores: git's own (XDG), cargo, gem, Pulumi, Hugging Face, Kaggle, rclone, hub, glab, doctl, Stripe, Fly, cloudflared, OCI
      '.config/git/credentials', '.cargo/credentials', '.cargo/credentials.toml', '.gem/credentials', '.pulumi/credentials.json', '.huggingface/token',
      '.cache/huggingface/token', '.kaggle/kaggle.json', '.config/rclone', '.config/hub', '.config/glab-cli', '.config/doctl', '.config/stripe', '.fly', '.cloudflared', '.oci'],
    names: ['.netrc', '_netrc', '.npmrc', '.pypirc', '.pgpass', 'pgpass.conf', '.git-credentials', '.my.cnf', '.boto', '.s3cfg', '.dockercfg', 'kubeconfig',
      'authorized_keys', 'authorized_keys2', '.terraformrc', 'terraform.rc', 'credentials.tfrc.json', '.vault-token', '.databrickscfg'],
    patterns: [/^id_(?:rsa|dsa|ecdsa|ed25519|xmss)(?:_sk)?(?:-cert)?(?:\.pub)?$/, /\.kubeconfig$/],
  },
  {
    why: 'a key or certificate file',
    exts: ['pem', 'key', 'p12', 'pfx', 'jks', 'keystore', 'ppk', 'p8', 'pkcs12'],
  },
  {
    why: 'an environment file (.env)',
    names: ['.env', '.envrc'],
    patterns: [/^\.env\./, /\.env$/],
  },
  {
    why: 'terraform state',
    places: ['terraform.tfstate.d'],
    patterns: [/\.tfstate(?:\.backup)?$/],
  },
  {
    why: 'an AI tool\'s configuration or credentials',
    places: ['.cursor/mcp.json', '.config/opencode', '.local/share/opencode', '.local/state/opencode', 'library/application support/opencode', 'appdata/roaming/opencode', 'appdata/local/opencode',
      'library/application support/claude', 'appdata/roaming/claude', '.config/claude', '.claude-accounts', '.codex-accounts', '.codex*/auth.json', '.gemini',
      '.config/github-copilot', 'appdata/local/github-copilot',
      // ~/.claude and ~/.codex are protected whole (by identity too); their secret parts also wherever a copy of them is (a backup)
      '.claude/settings*.json', '.claude/projects', '.codex*/config.toml', '.codex*/sessions', '.codex*/history.jsonl'],
    names: ['.claude.json', '.credentials.json', 'claude_desktop_config.json', '.synabun-api-key'],
    patterns: [/^\.claude\.json\./, /mcp-api-key/],
  },
  {
    why: 'SynaBun\'s own data (memory database, WhatsApp session, backups)',
    // The data home is protected whole (protectedPlaces); its secret parts also wherever a copy of them is, and SynaBun's
    // backup archives (they hold .env and the memory database) by their name wherever the backup folder is.
    places: ['.synabun/whatsapp', '.synabun/mcp-data', '.synabun/runtime', '.synabun/backups', 'sidepanel-configs'],
    names: ['memory.db', 'memory.db-wal', 'memory.db-shm', 'memory.db-journal', 'state.db', 'state.db-wal', 'state.db-shm', 'state.db-journal', 'synabun-auto-backup.zip'],
    patterns: [/^synabun-[a-z-]+-\d{4}-\d{2}-\d{2}t\d{2}-\d{2}-\d{2}-\d{3}z\.zip(?:\.\d+\.tmp)?$/],
  },
];
const FAMILIES = FAMILY_ROWS.map((row) => Object.freeze({
  why: row.why,
  places: (row.places || []).map(run),
  names: new Set(row.names || []),
  patterns: row.patterns || [],
  exts: new Set(row.exts || []),
}));
/** What the denylist protects, family by family (docs and tests read it). */
export const DENYLIST = Object.freeze(FAMILY_ROWS.map((row) => Object.freeze({
  why: row.why, places: Object.freeze([...(row.places || [])]), names: Object.freeze([...(row.names || [])]),
  patterns: Object.freeze((row.patterns || []).map(String)), exts: Object.freeze([...(row.exts || [])]),
})));

// Entries right under the user's home: ~/.claude* (settings, credentials, ~/.claude.json) and ~/.codex*.
// (~/.synabun, the default data home, is a protected root of its own: protectedPlaces.)
const HOME_ENTRIES = Object.freeze([
  { re: /^\.claude/, why: 'an AI tool\'s configuration or credentials (~/.claude*)' },
  { re: /^\.codex/, why: 'an AI tool\'s configuration or credentials (~/.codex*)' },
]);
// A data home that holds the user's home (or the disk's root) is protected by these folders only.
const DATA_HOME_CHILDREN = Object.freeze(['data', 'mcp-data', 'runtime', 'whatsapp', 'cache', 'backups', 'bin', '.env']);

/** A path as the denylist compares it: forward slashes, no doubled or trailing slash, lower case. */
export function denylistForm(value) {
  let text = String(value || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
  if (text.length > 1 && text.endsWith('/') && !/^[a-z]:\/$/.test(text)) text = text.slice(0, -1);
  return text;
}
const insideForm = (child, parent) => !!parent && (child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`));

function defaultRealpath(value) {
  return realpathSync.native ? realpathSync.native(value) : realpathSync(value);
}

/**
 * Where the denylist looks: the user's home and the protected roots, each as written and, when it
 * exists, as its real path (so a link to a protected folder is caught both ways).
 *   roots    the WhatsApp session (waHome, authDir) and SynaBun's data homes, whole: DATA_HOME and
 *            ~/.synabun (the default one, protected when DATA_HOME is elsewhere too)
 *   allowed  <data home>/data/media: the images and videos SynaBun collected from worker runs and
 *            the saved browser screenshots, the files the Assistant is asked to send
 *   folders  the same folders as written (home, root, allowed), for the check by device and inode that
 *            prepareLocalFile makes (placeDenial): a spelling the disk accepts for them is caught too
 * `paths`: resolveWhatsAppPaths()-shaped ({ dataHome, waHome, authDir }); `realpath` throws or returns.
 */
export function protectedPlaces({ paths = {}, home = homedir(), platform = process.platform, realpath = defaultRealpath } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const variants = (value) => {
    if (typeof value !== 'string' || !value) return [];
    const abs = p.resolve(value);
    const out = [denylistForm(abs)];
    try {
      const real = realpath(abs);
      if (typeof real === 'string' && real) out.push(denylistForm(real));
    } catch { /* not there (yet): its written form is enough */ }
    return [...new Set(out)];
  };
  const folders = [];
  const folder = (dir, kind, why = null, media = false) => folders.push(Object.freeze({ path: p.resolve(dir), kind, why, media }));
  const homes = variants(home);
  if (typeof home === 'string' && home) folder(home, 'home');
  const roots = [];
  for (const dir of [paths.authDir, paths.waHome]) {
    for (const form of variants(dir)) roots.push(Object.freeze({ path: form, why: 'the WhatsApp session', media: false }));
    if (typeof dir === 'string' && dir) folder(dir, 'root', 'the WhatsApp session', false);
  }
  const allowed = [];
  const dataHomes = [paths.dataHome, typeof home === 'string' && home ? p.join(p.resolve(home), '.synabun') : null].filter((dir) => typeof dir === 'string' && dir);
  for (const dataHome of [...new Set(dataHomes.map((dir) => p.resolve(dir)))]) {
    const holdsHome = variants(dataHome).some((form) => homes.some((h) => insideForm(h, form)));
    const dirs = holdsHome ? DATA_HOME_CHILDREN.map((child) => p.join(dataHome, child)) : [dataHome];
    // `media`: the data home's one open folder (allowed) is open inside this root only.
    for (const dir of dirs) {
      for (const form of variants(dir)) roots.push(Object.freeze({ path: form, why: 'SynaBun\'s own data folder', media: true }));
      folder(dir, 'root', 'SynaBun\'s own data folder', true);
    }
    allowed.push(...variants(p.join(dataHome, 'data', 'media')));
    folder(p.join(dataHome, 'data', 'media'), 'allowed');
  }
  return Object.freeze({ homes: Object.freeze(homes), roots: Object.freeze(roots), allowed: Object.freeze([...new Set(allowed)]), folders: Object.freeze(folders) });
}

/**
 * Why this path is never sent, or null. Checks one path: call it on the path as written and on its
 * real path. Also checks the path with each name's trailing dots and spaces dropped, the spelling
 * Windows opens (`.ssh.\id_rsa` is `.ssh\id_rsa`). `places`: protectedPlaces().
 */
export function fileDenial(candidate, places = { homes: [], roots: [], allowed: [] }) {
  const form = denylistForm(candidate);
  const trimmed = form.split('/').map((segment) => segment.replace(/[. ]+$/, '') || segment).join('/');
  return denialOf(form, places) || (trimmed !== form ? denialOf(trimmed, places) : null);
}

/** Why a name right under the user's home is never sent (~/.claude*, ~/.codex*), or null. */
function homeEntryDenial(first) {
  const trimmed = first.replace(/[. ]+$/, '') || first;
  for (const entry of HOME_ENTRIES) if (entry.re.test(first) || entry.re.test(trimmed)) return entry.why;
  return null;
}

function denialOf(form, places) {
  const segments = form.split('/').filter(Boolean);
  const name = segments.length ? segments[segments.length - 1] : '';
  const media = (places.allowed || []).some((dir) => insideForm(form, dir));
  for (const root of places.roots || []) if (insideForm(form, root.path) && !(media && root.media)) return root.why;
  for (const home of places.homes || []) {
    if (form === home || !insideForm(form, home)) continue;
    const why = homeEntryDenial(form.slice(home.endsWith('/') ? home.length : home.length + 1).split('/')[0]);
    if (why) return why;
  }
  const ext = extOf(name);
  for (const family of FAMILIES) {
    if (family.names.has(name) || family.exts.has(ext) || family.patterns.some((re) => re.test(name))) return family.why;
    for (const place of family.places) {
      for (let i = 0; i + place.length <= segments.length; i += 1) {
        if (place.every((re, j) => re.test(segments[i + j]))) return family.why;
      }
    }
  }
  return null;
}

// ── the read ─────────────────────────────────────────────────────────────────

// O_NOFOLLOW: a link swapped in after the checks is refused at open. O_NONBLOCK: a FIFO swapped in
// cannot hang the open (the fstat that follows refuses it). 0 where the platform lacks them (Windows:
// there the device / inode comparison catches a swap).
const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0) | (fsConstants.O_NONBLOCK || 0);

const sizeText = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KiB` : `${bytes} bytes`);
// A path in a refusal: its end when it is long, so the reason after it fits the reply (500 characters).
const shown = (value) => { const text = String(value ?? ''); return text.length > 220 ? `…${text.slice(-220)}` : text; };

/** A folder as the disk knows it, device and inode (as file-explorer-api.js entryId says them), or null. */
async function folderId(dir, fs) {
  try {
    const st = await fs.stat(dir, { bigint: true });
    return st.isDirectory() && st.ino ? `${st.dev}:${st.ino}` : null;
  } catch { return null; }
}

/**
 * The rules tied to a place (the protected roots, data/media, the names right under the home) decided by
 * what each folder above the file is on disk, never by how the path spells it: macOS reaches every folder
 * of the data volume under a second name that realpath keeps (/System/Volumes/Data/Users/… is /Users/…,
 * and so is /.nofollow/Users/…), a case-insensitive disk takes any letter case, Windows a short 8.3 name.
 * `real`: the file's real path; `places`: protectedPlaces() (its `folders`). Why it is never sent, or null.
 */
async function placeDenial(real, places, platform, fs) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const marks = new Map();
  for (const dir of places.folders || []) {
    const id = await folderId(dir.path, fs);
    if (id) marks.set(id, [...(marks.get(id) || []), dir]);
  }
  if (!marks.size) return null;
  // Every folder above the file, nearest first, with the name the way to the file takes below it.
  const chain = [];
  for (let below = real, at = p.dirname(real); ; below = at, at = p.dirname(at)) {
    chain.push({ marked: marks.get(await folderId(at, fs)) || [], name: denylistForm(p.basename(below)) });
    if (p.dirname(at) === at) break;
  }
  const media = chain.some((step) => step.marked.some((dir) => dir.kind === 'allowed'));
  for (const step of chain) {
    for (const dir of step.marked) {
      if (dir.kind === 'root' && !(media && dir.media)) return dir.why;
      if (dir.kind === 'home') { const why = homeEntryDenial(step.name); if (why) return why; }
    }
  }
  return null;
}

/**
 * The path of an open file as the system names it, where it can (Linux: /proc/self/fd), else null:
 * whatever path led to it, the file itself is checked against the list too.
 */
async function openFilePath(handle, platform, fs) {
  if (platform !== 'linux' || typeof handle?.fd !== 'number' || typeof fs.readlink !== 'function') return null;
  try { return await fs.readlink(`/proc/self/fd/${handle.fd}`); } catch { return null; }
}

/**
 * Check and read one local file for whatsapp_send_file → { path (canonical), size, fileName, type,
 * mimetype, caption, fallback, data }. Throws LocalFileError: BAD_REQUEST (the request),
 * FILE_FORBIDDEN (a protected place, a URL / share / stream, a file with more than one hard link),
 * FILE_TOO_LARGE (over 100 MiB, before reading), FILE_INVALID (missing, unreadable, a folder or
 * anything but a regular file, empty, or changed while it was read).
 * @param {string} requested  the path as the request named it
 * @param {object} [o]
 * @param {string} [o.as]       auto | document | image | video | audio
 * @param {string} [o.caption]
 * @param {object} [o.paths]    resolveWhatsAppPaths()-shaped (the protected roots)
 * @param {string} [o.home]
 * @param {object} [o.fs]       node:fs/promises-shaped (tests)
 */
export async function prepareLocalFile(requested, { as = 'auto', caption = null, paths = {}, home = homedir(), platform = process.platform, fs = fsp, realpath = defaultRealpath } = {}) {
  const written = checkRequestPath(requested, { platform });
  const places = protectedPlaces({ paths, home, platform, realpath });
  const forbidden = (target, why) => refuse(ERR.FILE_FORBIDDEN, `${shown(target)} is protected (${why}): SynaBun never sends it from WhatsApp`);
  const deniedWritten = fileDenial(written, places);
  if (deniedWritten) forbidden(written, deniedWritten);
  let real;
  try { real = await fs.realpath(written); }
  catch (error) { refuse(ERR.FILE_INVALID, error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? `${shown(written)} does not exist` : `${shown(written)} could not be read (${error?.code || 'error'})`); }
  if (typeof real !== 'string' || !real || real.length > LIMITS.MAX_FILE_PATH) refuse(ERR.FILE_INVALID, `${shown(written)} leads to a path longer than ${LIMITS.MAX_FILE_PATH} characters`);
  const target = real === written ? written : `${shown(written)} (a link to ${real})`;
  // Where it leads, by its shape: a mapped drive or a link can lead to a share or into /dev.
  if (SHARE_OR_DEVICE.test(real) || (platform !== 'win32' && systemPath(real))) {
    refuse(ERR.FILE_FORBIDDEN, `${shown(target)} is on a network share or is a system path: only a file on this computer's own disk is sent`);
  }
  const deniedReal = fileDenial(real, places) || await placeDenial(real, places, platform, fs);
  if (deniedReal) forbidden(target, deniedReal);
  let seen;
  try { seen = await fs.lstat(real); }
  catch (error) { refuse(ERR.FILE_INVALID, `${shown(written)} could not be read (${error?.code || 'error'})`); }
  if (seen.isDirectory()) refuse(ERR.FILE_INVALID, `${shown(written)} is a folder: send one file (zip the folder first)`);
  if (!seen.isFile()) refuse(ERR.FILE_INVALID, `${shown(written)} is not a regular file`);
  const linked = () => refuse(ERR.FILE_FORBIDDEN, `${shown(written)} has more than one hard link: its other names cannot be checked against the protected places, so it is not sent`);
  if (seen.nlink > 1) linked();
  if (seen.size > LIMITS.MAX_FILE_BYTES) refuse(ERR.FILE_TOO_LARGE, `${shown(written)} is ${sizeText(seen.size)}: WhatsApp files from SynaBun are limited to ${sizeText(LIMITS.MAX_FILE_BYTES)}`);
  if (seen.size === 0) refuse(ERR.FILE_INVALID, `${shown(written)} is empty`);
  const fileName = (platform === 'win32' ? path.win32 : path.posix).basename(real);
  const plan = planFileSend({ name: fileName, size: seen.size, as, caption });

  let handle;
  try { handle = await fs.open(real, OPEN_FLAGS); }
  catch (error) { refuse(ERR.FILE_INVALID, error?.code === 'ELOOP' ? `${shown(written)} became a link while it was checked: nothing was sent` : `${shown(written)} could not be opened (${error?.code || 'error'})`); }
  const changed = () => refuse(ERR.FILE_INVALID, `${shown(written)} changed while it was read: nothing was sent`);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== seen.dev || opened.ino !== seen.ino || opened.size !== seen.size) changed();
    if (opened.nlink > 1) linked();
    let again = null;
    try { again = await fs.realpath(written); } catch { again = null; }
    if (again !== real) changed();
    // …and that path names the very file that was opened. lstat and open follow every link but the last
    // name's, so a parent folder swapped for a link (to a protected place) and back is caught here.
    let named = null;
    try { named = await fs.stat(real); } catch { named = null; }
    if (!named || named.dev !== opened.dev || named.ino !== opened.ino) changed();
    // Where the system can name the open file itself (Linux), that name is checked against the list too.
    const fdPath = await openFilePath(handle, platform, fs);
    const deniedOpen = fdPath ? fileDenial(fdPath, places) : null;
    if (deniedOpen) forbidden(written, deniedOpen);
    // Read to the end and one byte past what the file should hold: a file that grew (or shrank) is refused.
    const buffer = Buffer.alloc(seen.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total !== seen.size) changed();
    const after = await handle.stat();
    if (after.size !== opened.size || after.ino !== opened.ino || after.mtimeMs !== opened.mtimeMs) changed();
    return {
      path: real, size: seen.size, fileName, type: plan.type, mimetype: plan.mimetype, caption: plan.caption, fallback: plan.fallback,
      data: buffer.subarray(0, seen.size),
    };
  } finally {
    await handle.close().catch(() => {});
  }
}
