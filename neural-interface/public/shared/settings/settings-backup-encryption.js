// ═══════════════════════════════════════════
// SETTINGS — Password protection of backups
// ═══════════════════════════════════════════
//
// Settings → Memory & backups → Backups → Password protection, the list of recent backups, and the password step of a
// restore (Settings and onboarding.html). The server decides (lib/backup-encryption.js, lib/backup-restore-session.js);
// this module says what its answers mean and sends the requests. Pure: no DOM and no import, so node runs it
// (tests/settings-backup-encryption.test.mjs); settings-backup-encryption-pane.js draws.
//
// A password lives in the form's input and in the one request that uses it: never in a model, a URL or a message.
//
//   readEncryptionResponse({ status, body, error })   what the server answered → a reading
//   validatePasswordForm(mode, values, minLength)     what is wrong with a form, before anything is sent
//   describeBackupEncryption(model, { tx })           the row as the pane draws it
//   describeBackupHistory(reading, { tx })            the list of recent backups
//   formatHistorySize(bytes)                          a backup's size in a unit that says something
//   describeRestoreCreated(manifest, { tx })          when and where a backup was made, for the restore's question
//   createBackupEncryptionController({ fetch, … })    load, open a form, submit it
//   unlock / apply / discardEncryptedRestore(fetch, …)  the three steps of an encrypted restore
//   restoreCanUnlock(preview), describeEncryptedRestore(preview)   may the password be sent; when the backup was made
//   restoreErrorMessage(body, { tx })                 a refused restore in the owner's words
//   previewErrorMessage(body, { tx, fallback })       a refused upload (the restore's first step) in the owner's words
//   restoreCatalogueUrl({ search, saved, languages })  which strings onboarding's restore reads, by the app's locale rules
//   restoreNeedsNewFile(code)                         a refusal no other password can cure: the file is chosen again
//   restorePartialCodes(body)                         a 200 that could not do all of it: its problems, worst first (null: none)
//   describeRestoreOutcome(outcome, { tx })           those problems and the way forward, in the owner's words
//   save / read / clearRestoreOutcome(…)              the short-lived page record that outlives a reload or a restart
//   describeWait(seconds, { tx })                     the rate limiter's wait, "30 seconds" / "3 minutes"
//
// Every refusal is told by its `code`, never by the server's English sentence (which can hold a path): a code with
// no text here, or no code at all, is the generic sentence (with the code beside it when it is a plain identifier).
// docs/backup-encryption.md → Refusals lists each code, its status and where it is shown.

const K = 'settings.redesign.server';

export const BACKUP_ENCRYPTION_URL = '/api/system/backup/encryption';
export const BACKUP_HISTORY_URL = '/api/system/backup/history';
const DEFAULT_MIN_LENGTH = 8;
const MAX_LENGTH = 1024;
/**
 * What a server must list (lib/backup-encryption.js BACKUP_ENCRYPTION_CAPABILITIES) before this page turns encryption
 * on or sends it a backup's password. A page is read from disk at any time and the server's code only at a start, so
 * this page can meet a server from before the authentication key: one whose encrypted backups anybody holding one
 * could forge, and whose key file the finished code cannot use. That server answers without the list, and the page
 * then says a restart is missing instead of acting.
 */
export const REQUIRED_CAPABILITY = 'auth-key';
export const serverCanEncrypt = (body) => Array.isArray(body?.capabilities) && body.capabilities.includes(REQUIRED_CAPABILITY);

const clean = (value, max = 400) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** A code as support can read it: an identifier, never a sentence or a path. */
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
export const stableCode = (code) => (typeof code === 'string' && CODE_PATTERN.test(code) ? code : null);

/**
 * Refusals that come from the gates in front of every owner route (lib/http-guards.js, lib/page-session.js,
 * lib/owner-authority.js), not from backup encryption: the page was not accepted as SynaBun's own, or the caller is a guest.
 */
const REFUSED_CODES = new Set(['PAGE_SECRET_REQUIRED', 'BAD_HOST', 'BAD_ORIGIN', 'ORIGIN_REQUIRED', 'CROSS_SITE', 'PEER_REFUSED', 'PEER_UNAVAILABLE', 'WORKER_BROWSER']);
const guardKeyOf = (code) => (REFUSED_CODES.has(code) ? `${K}.backupEncErrRefused` : code === 'GUEST_FORBIDDEN' ? `${K}.backupEncErrOwnerOnly` : null);

/** The limiter's wait as the owner reads it: whole seconds up to two minutes, then minutes (rounded up, as the server's own sentence does). null when there is none. */
export function describeWait(seconds, { tx } = {}) {
  const wait = Math.ceil(Number(seconds));
  if (!Number.isFinite(wait) || wait < 1) return null;
  if (wait >= 120) return tx(`${K}.backupEncWaitMinutes`, { n: Math.ceil(wait / 60) });
  return wait === 1 ? tx(`${K}.backupEncWaitSecond`) : tx(`${K}.backupEncWaitSeconds`, { n: wait });
}
const lockedMessage = (body) => {
  const wait = Number(body?.retryAfterSeconds);
  return Number.isFinite(wait) && wait >= 1 ? { key: `${K}.backupEncErrLocked`, params: { wait: { wait } } } : { key: `${K}.backupEncErrLockedNoWait` };
};
/** A refusal this page has no sentence for: the generic one, with the code when it is a plain identifier. */
const unknownMessage = (key, code) => (stableCode(code) ? { key, code: stableCode(code) } : { key });

/** The length the server counts: characters of the normalized password. */
export const passwordLength = (value) => [...String(value ?? '').normalize('NFKC')].length;

/**
 * What the server answered:
 *   on           { keyId, changedAt, minLength }
 *   off          { minLength }
 *   broken       the key file is there and cannot be used: backups are stopped until it is repaired ({ code }).
 *                The server's own sentence about it is English and names the file by its path: it is for the
 *                server's log and is not kept here, so no page can show it.
 *   unavailable  a server started before these routes (404), or before the authentication key (no `auth-key`
 *                among its capabilities): a restart is missing, and nothing is sent to it
 *   error        { code, status }: what could not be read; the owner is told in words of this page, never the server's
 */
export function readEncryptionResponse({ status, body, error } = {}) {
  if (error) return { state: 'error', code: null, status: null };
  if (status === 404) return { state: 'unavailable' };
  if (!(status >= 200 && status < 300) || !body || body.ok !== true) return { state: 'error', code: stableCode(body?.code), status: Number(status) || null };
  if (!serverCanEncrypt(body)) return { state: 'unavailable' };
  const minLength = Number.isInteger(body.minPasswordLength) && body.minPasswordLength > 0 ? body.minPasswordLength : DEFAULT_MIN_LENGTH;
  if (body.enabled && body.usable === false) return { state: 'broken', code: stableCode(body.code), minLength };
  if (body.enabled) return { state: 'on', keyId: body.keyId || null, changedAt: body.changedAt || null, minLength };
  return { state: 'off', minLength };
}

/**
 * The first thing wrong with a form, or null. `mode`: enable | repair | change | disable (`repair` is `enable` for a
 * key file that cannot be used: the same fields, the same request). `values`: { current, password, confirm,
 * acknowledged }. Returns { field, key, params }: never a value that was typed.
 */
export function validatePasswordForm(mode, values = {}, minLength = DEFAULT_MIN_LENGTH) {
  const { current = '', password = '', confirm = '', acknowledged = false } = values;
  if ((mode === 'change' || mode === 'disable') && !current) return { field: 'current', key: `${K}.backupEncErrRequired` };
  if (mode === 'disable') return null;
  if (!password) return { field: 'password', key: `${K}.backupEncErrRequired` };
  if (passwordLength(password) < minLength) return { field: 'password', key: `${K}.backupEncErrShort`, params: { min: minLength } };
  if (password !== confirm) return { field: 'confirm', key: `${K}.backupEncErrMismatch` };
  if ((mode === 'enable' || mode === 'repair') && acknowledged !== true) return { field: 'acknowledged', key: `${K}.backupEncErrAck` };
  return null;
}

/**
 * A refused password request as { field?, key, params?, code?, reload? }: words of this page, by the refusal's `code`.
 * `field` puts it under that field; without one it is the form's own line. `reload` says the page's reading of the
 * state was out of date (it is read again). `mode` is the form that was sent (a refusal of a password names no field
 * by itself; the form says which one that was) and `minLength` what the server said it asks for.
 */
export function encryptionErrorOf(body, status, { mode = null, minLength = DEFAULT_MIN_LENGTH } = {}) {
  const code = stableCode(body?.code);
  const typed = mode === 'enable' || mode === 'repair' ? 'password' : mode === 'disable' ? 'current' : null;
  switch (code) {
    case 'WRONG_PASSWORD': return { field: 'current', key: `${K}.backupEncErrWrong` };
    case 'TOO_MANY_ATTEMPTS': return lockedMessage(body);
    case 'PASSWORD_TOO_SHORT': return { field: 'password', key: `${K}.backupEncErrShort`, params: { min: minLength } };
    case 'PASSWORD_TOO_LONG': return { ...(typed ? { field: typed } : {}), key: `${K}.backupEncErrTooLong`, params: { max: MAX_LENGTH } };
    case 'PASSWORD_REQUIRED': return { ...(typed ? { field: typed } : {}), key: `${K}.backupEncErrRequired` };
    case 'ACKNOWLEDGE_REQUIRED': return { field: 'acknowledged', key: `${K}.backupEncErrAck` };
    case 'ALREADY_ENABLED': return { key: `${K}.backupEncErrAlreadyOn`, reload: true };
    case 'NOT_ENABLED': return { key: `${K}.backupEncErrNotOn`, reload: true };
    case 'BACKUP_ENC_KEY_UNREADABLE': return { key: `${K}.backupEncErrKeyUnreadable`, reload: true };
    // The server's own "something unexpected": nothing was written, and its sentence is withheld on purpose.
    case 'ENCRYPTION_FAILED': return { key: `${K}.backupEncErrFailed` };
    default: break;
  }
  const guard = guardKeyOf(code);
  if (guard) return { key: guard };
  if (status === 404 && !code) return { key: `${K}.backupEncNeedsRestart` };
  return unknownMessage(`${K}.backupEncErrFailed`, code);
}

const NOTICE = { enable: `${K}.backupEncEnabledDone`, repair: `${K}.backupEncRepairedDone`, change: `${K}.backupEncChangedDone`, disable: `${K}.backupEncDisabledDone` };

/**
 * A form's words, by what it does. Its title and its submit button name the action that opened it: the form of
 * "Set a new password" is not the form of "Turn on", although both send the same request.
 */
export const BACKUP_ENCRYPTION_FORMS = Object.freeze({
  enable: Object.freeze({ title: `${K}.backupEncEnableTitle`, submit: `${K}.backupEncEnable`, note: null, password: `${K}.backupEncPassword`, confirm: `${K}.backupEncPasswordConfirm`, fields: Object.freeze(['password', 'confirm', 'acknowledged']) }),
  repair: Object.freeze({ title: `${K}.backupEncRepair`, submit: `${K}.backupEncRepair`, note: `${K}.backupEncRepairNote`, password: `${K}.backupEncNew`, confirm: `${K}.backupEncNewConfirm`, fields: Object.freeze(['password', 'confirm', 'acknowledged']) }),
  change: Object.freeze({ title: `${K}.backupEncChange`, submit: `${K}.backupEncChange`, note: `${K}.backupEncChangeNote`, password: `${K}.backupEncNew`, confirm: `${K}.backupEncNewConfirm`, fields: Object.freeze(['current', 'password', 'confirm']) }),
  disable: Object.freeze({ title: `${K}.backupEncDisableTitle`, submit: `${K}.backupEncDisable`, note: `${K}.backupEncDisableNote`, password: `${K}.backupEncPassword`, confirm: `${K}.backupEncPasswordConfirm`, fields: Object.freeze(['current']) }),
});

/** A message as text. A parameter that is `{ wait }` (seconds) is the wait as a phrase; `code` is added as the plain identifier. */
const textOf = (message, tx) => {
  if (!message?.key) return '';
  const params = {};
  for (const [name, value] of Object.entries(message.params || {})) {
    params[name] = value && typeof value === 'object' && 'wait' in value ? (describeWait(value.wait, { tx }) ?? '') : value;
  }
  const text = tx(message.key, params);
  return message.code ? `${text} ${tx(`${K}.backupEncCodeNote`, { code: message.code })}` : text;
};

/** The status row's line when the state could not be read: by the refusal's code, never the server's sentence. */
function unreadableMessage(reading) {
  const guard = guardKeyOf(reading?.code);
  if (guard) return { key: guard };
  // ENCRYPTION_FAILED is the server's own catch-all: its code says nothing a person could use.
  return unknownMessage(`${K}.backupEncUnreadable`, reading?.code === 'ENCRYPTION_FAILED' ? null : reading?.code);
}

/**
 * The row: { available, on, canToggle, pill: { text, state }, status, form, error, fieldError, errorField, notice,
 * busy }. A refusal that names a field is `fieldError`, shown next to the field `errorField`; one that names none is
 * `error`, the form's own line.
 */
export function describeBackupEncryption(model, { tx, formatDate = (value) => new Date(value).toLocaleString() } = {}) {
  const reading = model?.reading || { state: 'loading' };
  const state = reading.state;
  const on = state === 'on' || state === 'broken';
  const pill = state === 'on' ? { text: tx(`${K}.backupEncOn`), state: 'ok' }
    : state === 'broken' ? { text: tx(`${K}.backupEncBroken`), state: 'err' }
      : state === 'off' ? { text: tx(`${K}.backupEncOff`), state: 'off' }
        : { text: '', state: 'off' };
  let status = '';
  if (state === 'off') status = tx(`${K}.backupEncStatusOff`);
  else if (state === 'on') status = reading.changedAt ? tx(`${K}.backupEncStatusOn`, { date: formatDate(reading.changedAt) }) : tx(`${K}.backupEncStatusOnNoDate`);
  // In the owner's language, from the state alone: every code the server has for it means the same to the owner.
  else if (state === 'broken') status = tx(`${K}.backupEncStatusBroken`);
  else if (state === 'unavailable') status = tx(`${K}.backupEncNeedsRestart`);
  else if (state === 'error') status = textOf(unreadableMessage(reading), tx);
  return {
    available: state === 'on' || state === 'off' || state === 'broken',
    on,
    canToggle: (state === 'on' || state === 'off') && !model?.busy,
    canChange: state === 'on' && !model?.busy && !model?.form,
    // A key file that cannot be used stops every backup: a new password is the way out.
    canRepair: state === 'broken' && !model?.busy && !model?.form,
    pill,
    status,
    form: model?.form || null,
    busy: !!model?.busy,
    error: model?.error?.field ? '' : textOf(model?.error, tx),
    fieldError: model?.error?.field ? textOf(model.error, tx) : '',
    errorField: model?.error?.field || null,
    notice: textOf(model?.notice, tx),
    minLength: reading.minLength || DEFAULT_MIN_LENGTH,
  };
}

/**
 * A backup's size as the list shows it. From a tenth of a megabyte up it reads as the line under "Download full
 * backup" does (MB with one decimal, GB with two); below that, where that line would say "0.0 MB", in KB or bytes.
 * '' for what is not a size.
 */
export function formatHistorySize(bytes) {
  const size = Number(bytes);
  if (bytes == null || bytes === '' || !Number.isFinite(size) || size < 0) return '';
  const MB = 1024 * 1024;
  if (size >= 1024 * MB) return `${(size / (1024 * MB)).toFixed(2)} GB`;
  if (size >= 0.05 * MB) return `${(size / MB).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${Math.round(size)} B`;
}

/** `body` of GET /api/system/backup/history → { available, rows: [{ name, when, size, encrypted, badge }], note }. */
export function describeBackupHistory({ status, body, error } = {}, { tx, formatDate = (value) => new Date(value).toLocaleString(), formatSize = formatHistorySize } = {}) {
  if (error || status === 404 || !body?.ok || !Array.isArray(body.backups)) return { available: false, rows: [], note: '' };
  const rows = body.backups.map((item) => ({
    name: clean(item.name, 200),
    when: item.createdAt ? formatDate(item.createdAt) : '',
    size: Number.isFinite(item.sizeBytes) ? formatSize(item.sizeBytes) : '',
    encrypted: item.encrypted === true,
    badge: { text: tx(item.encrypted === true ? `${K}.backupHistoryEncrypted` : `${K}.backupHistoryPlain`), state: item.encrypted === true ? 'ok' : 'off' },
  }));
  const total = Number(body.total) || rows.length;
  return {
    available: true,
    rows,
    note: !rows.length ? tx(`${K}.backupHistoryEmpty`) : total > rows.length ? tx(`${K}.backupHistoryMore`, { shown: rows.length, total }) : '',
  };
}

async function postJson(fetchFn, url, body) {
  const res = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SynaBun-UI': '1' }, body: JSON.stringify(body) });
  let answer = null;
  try { answer = await res.json(); } catch { /* a page or an empty answer */ }
  return { status: res.status, ok: res.ok, body: answer };
}

/**
 * The Password protection row's state. `render(model)` is called on every change. The values of a form are passed to
 * `submit` and go no further than its one request.
 */
export function createBackupEncryptionController({ fetch: fetchFn, render, alive = () => true } = {}) {
  let model = { reading: null, form: null, busy: false, error: null, notice: null };
  const draw = () => { if (alive()) render({ ...model }); };
  const set = (patch) => { model = { ...model, ...patch }; draw(); };

  async function load() {
    try {
      const res = await fetchFn(BACKUP_ENCRYPTION_URL);
      let body = null;
      try { body = await res.json(); } catch { /* below */ }
      set({ reading: readEncryptionResponse({ status: res.status, body }) });
    } catch (error) {
      set({ reading: readEncryptionResponse({ error }) });
    }
    return model.reading;
  }

  return {
    load,
    open(mode) { if (!model.busy && Object.hasOwn(BACKUP_ENCRYPTION_FORMS, mode)) set({ form: mode, error: null, notice: null }); },
    close() { if (!model.busy) set({ form: null, error: null }); },
    /** Resolves true when the server did it; the caller clears the inputs either way. */
    async submit(values) {
      const mode = model.form;
      if (!mode || model.busy) return false;
      // Only a server that said it can: the last check before a password leaves the page.
      if (!['on', 'off', 'broken'].includes(model.reading?.state)) { set({ form: null, error: null }); return false; }
      const problem = validatePasswordForm(mode, values, model.reading?.minLength);
      if (problem) { set({ error: problem, notice: null }); return false; }
      const request = mode === 'enable' || mode === 'repair'
        ? { url: `${BACKUP_ENCRYPTION_URL}/enable`, body: { password: values.password, acknowledged: true } }
        : mode === 'change'
          ? { url: `${BACKUP_ENCRYPTION_URL}/change`, body: { currentPassword: values.current, newPassword: values.password } }
          : { url: `${BACKUP_ENCRYPTION_URL}/disable`, body: { currentPassword: values.current } };
      set({ busy: true, error: null, notice: null });
      try {
        const answer = await postJson(fetchFn, request.url, request.body);
        if (answer.ok && answer.body?.ok) {
          set({ busy: false, form: null, reading: readEncryptionResponse({ status: answer.status, body: answer.body }), notice: { key: NOTICE[mode] } });
          return true;
        }
        const error = encryptionErrorOf(answer.body, answer.status, { mode, minLength: model.reading?.minLength });
        set({ busy: false, error });
        // The page's reading was behind the server's (turned on or off elsewhere, a key file that went bad): read it again.
        if (error.reload) await load();
      } catch {
        set({ busy: false, error: { key: `${K}.backupEncErrFailed` } });
      }
      return false;
    },
  };
}

/**
 * True when the preview's answer for an encrypted upload came from a server this page may send the password to
 * (REQUIRED_CAPABILITY). False: the upload is discarded and the owner is told to restart SynaBun.
 */
export const restoreCanUnlock = (preview) => serverCanEncrypt(preview);

/** When an unlocked encrypted backup was made, for the restore's question: the header's authenticated date. */
export function describeEncryptedRestore(preview, { tx, formatDate = (value) => new Date(value).toLocaleString() } = {}) {
  if (!preview?.encrypted) return '';
  const when = typeof preview.created === 'string' && !Number.isNaN(Date.parse(preview.created)) ? preview.created : null;
  return when ? tx(`${K}.restoreEncMade`, { date: formatDate(when) }) : tx(`${K}.restoreEncMadeUnknown`);
}

/**
 * The restore's question: when the backup was made and, when its manifest says so, on which computer. A backup
 * that names no computer gets the date alone, never a word for "unknown". '' when it says neither.
 */
export function describeRestoreCreated(manifest, { tx, formatDate = (value) => new Date(value).toLocaleString() } = {}) {
  const host = clean(manifest?.hostname, 120);
  const when = manifest?.created != null && !Number.isNaN(new Date(manifest.created).getTime()) ? formatDate(manifest.created) : '';
  if (when && host) return tx(`${K}.restoreCreatedOn`, { date: when, host });
  if (when) return tx(`${K}.restoreCreated`, { date: when });
  return host ? tx(`${K}.restoreCreatedHost`, { host }) : '';
}

/** POST unlock: { ok, status, body } with the same preview a plain backup gets when the password opened it. */
export const unlockEncryptedRestore = (fetchFn, uploadId, password) => postJson(fetchFn, '/api/system/restore/unlock', { uploadId, password });
/** POST apply-staged: answers as POST /api/system/restore does. */
export const applyEncryptedRestore = (fetchFn, uploadId, mode = 'full') => postJson(fetchFn, '/api/system/restore/apply-staged', { uploadId, mode });
/** Forget the staged upload. Never throws: the server drops it by itself after 30 minutes. */
export async function discardEncryptedRestore(fetchFn, uploadId) {
  try { await postJson(fetchFn, '/api/system/restore/discard', { uploadId }); } catch { /* it expires */ }
}

/** The refusals of the restore's steps that no other password can cure: the staged file is gone, damaged, not one this SynaBun reads, or not a backup. */
const RESTORE_DEAD_ENDS = new Set(['RESTORE_UPLOAD_GONE', 'BACKUP_ENC_DAMAGED', 'BACKUP_ENC_UNSUPPORTED', 'BACKUP_NOT_ENCRYPTED', 'INVALID_BACKUP']);
export const restoreNeedsNewFile = (code) => RESTORE_DEAD_ENDS.has(code);

const RESTORE_KEYS = {
  WRONG_PASSWORD: 'restoreEncWrong',
  BACKUP_ENC_DAMAGED: 'restoreEncDamaged',
  BACKUP_ENC_UNSUPPORTED: 'restoreEncUnsupported',
  BACKUP_NOT_ENCRYPTED: 'restoreEncNotEncrypted',
  RESTORE_UPLOAD_GONE: 'restoreEncGone',
  RESTORE_RUNNING: 'restoreEncRunning',
  RESTORE_LOCKED: 'restoreEncLocked',
  BACKUP_PASSWORD_REQUIRED: 'restoreEncLocked',
  BACKUP_ENC_READ: 'restoreEncRead',
  INVALID_BACKUP: 'restoreEncInvalid',
  PASSWORD_REQUIRED: 'backupEncErrRequired',
  // The plain refusals of the upload, the preview and the restore (lib/system-restore.js RESTORE_FAILURE_CODES).
  RESTORE_EMPTY_UPLOAD: 'restoreErrEmpty',
  RESTORE_ZIP_INVALID: 'restoreErrZip',
  RESTORE_ZIP_UNSUPPORTED: 'restoreErrZipUnsupported',
  RESTORE_MANIFEST_MISSING: 'restoreErrNoManifest',
  RESTORE_MANIFEST_UNREADABLE: 'restoreErrManifest',
  RESTORE_UNSUPPORTED_VERSION: 'restoreErrVersion',
  RESTORE_UNSAFE_PATH: 'restoreErrUnsafePath',
  BACKUP_GROUPS_MISMATCH: 'restoreEncDamaged',
  RESTORE_CHECKSUM_MISMATCH: 'restoreEncDamaged',
  RESTORE_ENTRY_MISSING: 'restoreEncDamaged',
  RESTORE_ENTRY_UNREADABLE: 'restoreEncDamaged',
  BACKUP_ENCRYPTED: 'restoreErrEncrypted',
  RESTORE_WRITE_FAILED: 'restoreErrPartial',
  RESTORE_FAILED: 'restoreEncFailed',
  RESTORE_DB_FAILED: 'restoreWarnDatabase',
  RESTORE_QDRANT_FORMAT: 'restoreWarnQdrant',
  RESTORE_KEY_NOT_KEPT: 'restoreWarnKey',
  RESTORE_MCP_BUILD_FAILED: 'restoreWarnBuild',
  // A system error keeps its own code in the upload's answer (it always did).
  Z_DATA_ERROR: 'restoreErrZip',
  Z_BUF_ERROR: 'restoreErrZip',
  ENOSPC: 'restoreErrDiskFull',
  EDQUOT: 'restoreErrDiskFull',
  EACCES: 'restoreErrNoAccess',
  EPERM: 'restoreErrNoAccess',
  EROFS: 'restoreErrNoAccess',
};

/**
 * A refused unlock, apply or upload, in the owner's words: by `body.code`, never by the server's sentence. A code with
 * no text here and a body with no code are the generic sentence (with the code beside it when there is a plain one).
 * Without `tx` (a page whose strings did not load) it is an English generic sentence: still not the server's.
 */
export function restoreErrorMessage(body, { tx = null } = {}) {
  // Whatever its code: the restore had begun writing, so no sentence that says nothing was changed may stand.
  if (body?.partial === true) return tx ? tx(`${K}.restoreErrPartial`) : 'The restore stopped while writing files, so some may already have been replaced. Restore a complete backup again.';
  if (!tx) return 'The backup could not be opened.';
  const code = stableCode(body?.code);
  if (code === 'TOO_MANY_ATTEMPTS') return textOf(lockedMessage(body), tx);
  if (code === 'PASSWORD_TOO_LONG') return tx(`${K}.backupEncErrTooLong`, { max: MAX_LENGTH });
  if (code && Object.hasOwn(RESTORE_KEYS, code)) return tx(`${K}.${RESTORE_KEYS[code]}`);
  const guard = guardKeyOf(code);
  if (guard) return tx(guard);
  return textOf(unknownMessage(`${K}.restoreEncFailed`, code), tx);
}

/**
 * A refused upload (POST /api/system/restore/preview), which a plain backup meets too: a code this page knows is told
 * as restoreErrorMessage tells it; anything else is `fallback` (the page's own "Invalid backup"), not the server's text.
 */
export function previewErrorMessage(body, { tx = null, fallback = '' } = {}) {
  const code = stableCode(body?.code);
  const known = code && (Object.hasOwn(RESTORE_KEYS, code) || code === 'TOO_MANY_ATTEMPTS' || guardKeyOf(code));
  return tx && known ? restoreErrorMessage(body, { tx }) : fallback;
}

// ── A restore that answered 200 and could not do all of it ──
// The server keeps its sentences in `results.errors` and, from dd14b42c on, one code per sentence in
// `results.errorCodes` (lib/system-restore.js PARTIAL_FAILURES). A page is read from disk at any time and the server's
// code only at a start, so an answer may have sentences and no codes. A sentence is never shown: it can hold a path.

/** The generic problem: an answer with no code, a code this page has no words for, or a 200 that says nothing readable. */
const RESTORE_PARTIAL_GENERIC = 'RESTORE_FAILED';
/** The codes with their own words, most serious first: the memories did not come back, then what is left to repair. */
export const RESTORE_PARTIAL_CODES = Object.freeze(['RESTORE_DB_FAILED', 'RESTORE_QDRANT_FORMAT', 'RESTORE_KEY_NOT_KEPT', 'RESTORE_MCP_BUILD_FAILED']);
const RESTORE_PARTIAL_ORDER = [...RESTORE_PARTIAL_CODES, RESTORE_PARTIAL_GENERIC];
/** With these, what the owner came for is not there: trying another copy is the first way forward. */
const RESTORE_RETRY_FIRST = new Set(['RESTORE_DB_FAILED', 'RESTORE_QDRANT_FORMAT', RESTORE_PARTIAL_GENERIC]);

const partialList = (codes) => {
  const found = new Set(codes.map((code) => (RESTORE_PARTIAL_CODES.includes(code) ? code : RESTORE_PARTIAL_GENERIC)));
  return RESTORE_PARTIAL_ORDER.filter((code) => found.has(code));
};

/**
 * What a 200 from POST /api/system/restore or /apply-staged could not do: its codes, deduplicated, worst first, with
 * the generic one for anything without words here. null only for a restore that says it did all of it.
 */
export function restorePartialCodes(body) {
  if (body === null || typeof body !== 'object' || body.ok !== true || body.partial === true) return [RESTORE_PARTIAL_GENERIC];
  const listed = (value) => (Array.isArray(value) ? value : value ? [value] : []);
  const sentences = listed(body.results?.errors);
  const codes = listed(body.results?.errorCodes);
  const count = Math.max(sentences.length, codes.length);
  if (!count) return null;
  return partialList(Array.from({ length: count }, (_, index) => codes[index]));
}

/** The English of the outcome's strings, for a page whose catalogue could not be read. Equal to i18n/en.json (tested). */
export const RESTORE_OUTCOME_COPY = Object.freeze({
  restorePartialTitle: 'The restore finished with problems',
  restoreWarnDatabase: 'The files were restored, but your memories were not. Restore the backup again, or try another copy.',
  restoreWarnQdrant: 'This backup holds its memories in an old format, so they were not restored. Convert it with the migration script, then restore it again.',
  restoreWarnKey: 'The files were restored, but password protection was not kept, so new backups may not be encrypted. Turn it on again in Settings → Backups.',
  restoreWarnBuild: 'The files were restored, but the MCP server could not be rebuilt. Restart SynaBun, and reinstall it if the problem stays.',
  restoreWarnGeneric: 'Part of this restore did not work, so some of your data may be missing. Restore the backup again, or try another copy.',
  restorePartialRestarting: 'SynaBun is restarting. This message will still be here when it is back.',
  restorePartialReload: 'Reload SynaBun',
  restorePartialClose: 'Close',
  restorePartialTryAnother: 'Try another backup',
  restorePartialContinue: 'Continue anyway',
  restorePartialContinuing: 'Finishing setup…',
  restorePartialContinueFailed: 'SynaBun could not finish setup yet. Try again in a moment.',
});

/** The outcome as a surface draws it. `restarting`: the server is going away right now and the page will come back. */
export function describeRestoreOutcome(outcome, { tx = null, restarting = false } = {}) {
  const word = (name) => {
    const key = `${K}.${name}`;
    const text = tx ? tx(key) : key;
    return text && text !== key ? text : RESTORE_OUTCOME_COPY[name];
  };
  const codes = partialList(Array.isArray(outcome?.codes) && outcome.codes.length ? outcome.codes : [RESTORE_PARTIAL_GENERIC]);
  return {
    title: word('restorePartialTitle'),
    messages: codes.map((code) => word(code === RESTORE_PARTIAL_GENERIC ? 'restoreWarnGeneric' : RESTORE_KEYS[code])),
    note: restarting ? word('restorePartialRestarting') : '',
    retryFirst: codes.some((code) => RESTORE_RETRY_FIRST.has(code)),
    reload: word('restorePartialReload'),
    close: word('restorePartialClose'),
    tryAnother: word('restorePartialTryAnother'),
    continueAnyway: word('restorePartialContinue'),
    continuing: word('restorePartialContinuing'),
    continueFailed: word('restorePartialContinueFailed'),
  };
}

// The record that keeps the outcome on screen through what follows a restore: the reload a restart forces, a page
// refreshed by hand, onboarding sent to the app because the restored settings say setup is complete. This tab only,
// for an hour, and only codes from the list above: no sentence, path, name or secret of the server's.
/** ui-settings-entry.js holds the same name, so the boot reads it without loading this module. */
export const RESTORE_OUTCOME_KEY = 'synabun-restore-outcome';
export const RESTORE_OUTCOME_TTL_MS = 60 * 60 * 1000;
const tabStorage = () => { try { return globalThis.sessionStorage ?? null; } catch { return null; } };

export function saveRestoreOutcome(outcome, { storage = tabStorage(), now = Date.now() } = {}) {
  try {
    storage?.setItem(RESTORE_OUTCOME_KEY, JSON.stringify({ v: 1, at: now, codes: partialList(outcome?.codes || []), restart: outcome?.restart === true }));
    return !!storage;
  } catch { return false; }
}

export function clearRestoreOutcome({ storage = tabStorage() } = {}) {
  try { storage?.removeItem(RESTORE_OUTCOME_KEY); } catch { /* nothing to keep */ }
}

/** The kept outcome, or null. A record that is old, from a later clock or not one of ours is removed. */
export function readRestoreOutcome({ storage = tabStorage(), now = Date.now() } = {}) {
  let raw = null;
  try { raw = storage?.getItem(RESTORE_OUTCOME_KEY) ?? null; } catch { return null; }
  if (raw === null) return null;
  try {
    const record = JSON.parse(raw);
    const age = now - record?.at;
    if (record?.v === 1 && Number.isFinite(age) && age >= -60_000 && age <= RESTORE_OUTCOME_TTL_MS && Array.isArray(record.codes) && record.codes.length && record.codes.length <= RESTORE_PARTIAL_ORDER.length) {
      return { codes: partialList(record.codes), restart: record.restart === true };
    }
  } catch { /* not ours */ }
  clearRestoreOutcome({ storage });
  return null;
}

/**
 * Which strings onboarding's restore reads: the wizard runs without the app's i18n and storage, so this is i18n.js's
 * order over what the page can see (`?lang=`, the stored choice, the browser's languages), and English otherwise.
 */
export function restoreCatalogueUrl({ search = '', saved = null, languages = [] } = {}) {
  const pick = (tag) => {
    const wanted = String(tag || '').trim().toLowerCase();
    if (wanted === 'en' || wanted.startsWith('en-')) return 'en';
    return wanted === 'pt' || wanted.startsWith('pt-') ? 'pt-BR' : null;
  };
  let address = null;
  try { address = new URLSearchParams(search).get('lang'); } catch { /* no usable address */ }
  const locale = pick(address) || pick(saved) || languages.map(pick).find(Boolean) || 'en';
  return `/i18n/${locale}.json`;
}
