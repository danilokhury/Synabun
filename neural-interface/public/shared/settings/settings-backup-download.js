// ═══════════════════════════════════════════
// SETTINGS — Download backup, into a folder
// ═══════════════════════════════════════════
//
// Settings → Memory & backups → Backups → Download full backup. The server builds the archive in a folder of this
// computer and the page only starts it and asks how far it is (lib/backup-download.js; GET / POST
// /api/system/backup/job, POST /api/system/backup/job/cancel, PUT /api/system/backup/destination, POST
// /api/system/backup/reveal). The page never holds
// the archive: reading a multi-GB response into a Blob is what made the old download take forever and never land.
// Pure: no DOM and no import, so node runs it (tests/settings-backup-download-view.test.mjs).
//
//   readBackupDownloadResponse({ status, body, error })   what the server answered → a reading
//   describeBackupDownload(model, { tx })                  the row as ui-settings.js draws it
//   createBackupDownloadController({ fetch, render, … })   load, choose a folder, start, follow, cancel, reveal
//   createBackupEndWatcher()                               (model) → true when a backup ended while the page looked
//
// `tx(key, params)` is the caller's translate function over the settings.redesign.* strings (the kit's `tx`).
// A server started before the job routes existed answers 404: the row then says a restart is missing and the
// button downloads through the browser, which every server can do.

const K = 'settings.redesign.server';

export const BACKUP_JOB_URL = '/api/system/backup/job';
export const BACKUP_CANCEL_URL = '/api/system/backup/job/cancel';
export const BACKUP_DESTINATION_URL = '/api/system/backup/destination';
export const BACKUP_REVEAL_URL = '/api/system/backup/reveal';
export const BACKUP_BROWSER_URL = '/api/system/backup';
export const FOLDER_PICKER_URL = '/api/browse-folder';

const clean = (value, max = 400) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** A size with its unit: MB below a gigabyte, GB from there. '' for what is not a size. */
export function formatBackupSize(bytes) {
  const size = Number(bytes);
  if (bytes == null || !Number.isFinite(size) || size < 0) return '';
  return size >= 1024 ** 3 ? `${(size / 1024 ** 3).toFixed(2)} GB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * What the server answered.
 *
 *   ready        the state: `folderPath`, `isDefault`, `folderError`, `job` (or null), `canReveal`, `busy`
 *   old-server   404: the running server was started before the job routes existed
 *   refused      an answer with an error and no state (`message`, `code`)
 *   unreadable   anything else (no answer, a body that is not the payload); `message`
 *
 * A 409 BACKUP_RUNNING carries the state too: it reads as `ready` with `alreadyRunning`.
 */
export function readBackupDownloadResponse({ status = 0, body = null, error = null } = {}) {
  const code = Number(status) || 0;
  if (code === 404) return { state: 'old-server' };
  const destination = body && typeof body === 'object' ? body.destination : null;
  if (destination && typeof destination.folderPath === 'string' && ((code >= 200 && code < 300) || code === 409)) {
    const job = body.job && typeof body.job === 'object' && typeof body.job.state === 'string' ? body.job : null;
    return {
      state: 'ready', folderPath: destination.folderPath, isDefault: destination.isDefault === true,
      folderError: clean(destination.error) || null, job, canReveal: body.canReveal === true, busy: body.busy === true,
      alreadyRunning: code === 409,
    };
  }
  if (body && typeof body === 'object' && body.error) return { state: 'refused', message: clean(body.error), code: body.code || null };
  return { state: 'unreadable', message: clean(error?.message || error) || (code ? `HTTP ${code}` : '') };
}

function runningText(job, tx) {
  const files = job.files ?? 0;
  switch (job.phase) {
    case 'queued': return tx(`${K}.backupQueued`);
    case 'collect': return tx(`${K}.backupCollecting`);
    case 'copy': return tx(`${K}.backupCopying`, { files, size: formatBackupSize(job.bytes) });
    case 'checksum': return tx(`${K}.backupChecksumming`, { files });
    case 'archive': return job.writtenBytes ? tx(`${K}.backupArchiving`, { size: formatBackupSize(job.writtenBytes) }) : tx(`${K}.backupArchivingStart`);
    case 'verify': return tx(`${K}.backupVerifying`);
    default: return tx(`${K}.creatingBackup`);
  }
}

/**
 * The row. `model`: `{ reading, notice, acting }`, the controller's. →
 *   folder        the folder shown in the field ('' when it is not known)
 *   folderNote    what is wrong with it, or what stands in the way (null: nothing)
 *   status        `{ dot: 'spin' | 'green' | 'red' | '', text }` or null (nothing to say)
 *   running       a backup of this server is being made
 *   waiting       the buttons wait: a backup runs, or a request of this row is on its way
 *   canChoose     the folder can be chosen
 *   canReveal     a finished backup can be shown in the file manager
 *   canCancel     the running backup can be cancelled (a server that has the cancel route says `cancelling` on its job)
 *   viaBrowser    the button downloads through the browser (a server from before)
 */
export function describeBackupDownload({ reading = null, notice = null, acting = false } = {}, { tx }) {
  const ready = reading?.state === 'ready';
  const job = ready ? reading.job : null;
  const running = job?.state === 'running';
  const viaBrowser = reading?.state === 'old-server';

  let folderNote = null;
  if (viaBrowser) folderNote = tx(`${K}.backupNeedsRestart`);
  else if (notice?.kind === 'folder') folderNote = tx(`${K}.backupFolderRefused`, { message: notice.message });
  else if (ready && reading.folderError) folderNote = reading.folderError;
  else if (reading && !ready && reading.state !== 'loading') folderNote = tx(`${K}.backupStateUnreadable`, { message: reading.message || '' });

  let status = null;
  if (running && job.cancelling) status = { dot: 'spin', text: tx(`${K}.backupCancelling`) };
  else if (running) {
    const text = runningText(job, tx);
    status = { dot: 'spin', text: notice?.kind === 'running' ? `${tx(`${K}.backupAlreadyRunning`)} ${text}` : text };
  } else if (notice?.kind === 'cancel') status = { dot: 'red', text: tx(`${K}.backupCancelFailed`, { message: notice.message }) };
  else if (job?.state === 'cancelled') status = { dot: '', text: tx(`${K}.backupCancelled`) };
  else if (notice?.kind === 'start') status = { dot: 'red', text: tx(`${K}.backupFailed`, { message: notice.message }) };
  else if (notice?.kind === 'reveal') status = { dot: 'red', text: tx(`${K}.backupRevealFailed`, { message: notice.message }) };
  else if (notice?.kind === 'browser') status = { dot: '', text: tx(`${K}.backupBrowserStarted`) };
  else if (job?.state === 'done') status = { dot: 'green', text: tx(`${K}.backupSavedTo`, { path: job.path, size: formatBackupSize(job.sizeBytes) }) };
  else if (job?.state === 'failed') status = { dot: 'red', text: tx(`${K}.backupFailed`, { message: job.error || '' }) };

  return {
    folder: ready ? reading.folderPath : '',
    folderNote,
    status,
    running,
    waiting: running || !!acting,
    canChoose: ready,
    canReveal: ready && reading.canReveal && job?.state === 'done' && !notice,
    canCancel: running && job.cancelling === false,
    viaBrowser,
  };
}

/**
 * Says when a backup has ended since the row was first drawn, so the list of recent backups can be read again:
 * call the function it returns with every model the controller renders. True once per backup that ended (saved,
 * failed or cancelled) while this page was looking, never for the state the page found when it opened, and never
 * while a backup runs. A backup that began and ended between two looks counts too: its job is another one. A job is
 * known by its id (by its file for an answer without one), so a later answer about the same ended job, with a time
 * it did not carry before, is not another ending.
 */
export function createBackupEndWatcher() {
  let seen = false;
  let last = '';
  return ({ reading = null } = {}) => {
    if (reading?.state !== 'ready') return false;
    const job = reading.job;
    const mark = !job ? 'none' : job.state === 'running' ? 'running' : `${job.state}:${job.id ?? job.path ?? ''}`;
    const first = !seen;
    const changed = mark !== last;
    seen = true;
    last = mark;
    return !first && changed && mark !== 'running' && mark !== 'none';
  };
}

/**
 * The row's behaviour, without a DOM. `render(model)` is called with `{ reading, notice, acting }` after every change.
 *
 * @param {object} o
 * @param {typeof fetch} o.fetch
 * @param {(model: { reading: object, notice: object | null, acting: boolean }) => void} o.render
 * @param {(ms: number) => Promise<void>} [o.wait]       the pause between two looks at a running backup
 * @param {number} [o.pollMs]
 * @param {() => boolean} [o.alive]                      false once the row is gone: the following stops
 * @param {() => void} [o.browserDownload]               start the download through the browser (GET /api/system/backup)
 */
export function createBackupDownloadController({
  fetch, render, wait = (ms) => new Promise((done) => setTimeout(done, ms)), pollMs = 1000, alive = () => true,
  browserDownload = () => {},
} = {}) {
  let reading = { state: 'loading' };
  let notice = null;
  let following = false;
  let acting = false;

  const show = () => { try { render({ reading, notice, acting }); } catch { /* a row that cannot be drawn changes nothing here */ } };

  async function ask(method, url, body) {
    try {
      const init = { method };
      if (body !== undefined) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body); }
      const res = await fetch(url, init);
      let json = null;
      try { json = await res.json(); } catch { json = null; }
      return readBackupDownloadResponse({ status: res.status, body: json });
    } catch (error) {
      return readBackupDownloadResponse({ error });
    }
  }

  const isRunning = () => reading.state === 'ready' && reading.job?.state === 'running';

  // Ask again while the backup runs. A look that fails keeps what was known; five in a row end the following.
  async function follow() {
    if (following) return;
    following = true;
    let failures = 0;
    try {
      while (isRunning() && alive()) {
        await wait(pollMs);
        const next = await ask('GET', BACKUP_JOB_URL);
        if (next.state === 'ready') { failures = 0; reading = next; }
        else if (++failures >= 5) reading = next;
        if (!isRunning() && notice?.kind === 'running') notice = null;
        show();
      }
    } finally { following = false; }
  }

  /** The state as the server has it now; follows a backup that is already running. */
  async function load() {
    reading = await ask('GET', BACKUP_JOB_URL);
    show();
    if (isRunning()) await follow();
  }

  /** The system's folder dialog, then the choice saved. Returns true when a folder was saved. */
  async function choose(description) {
    if (acting) return false;
    acting = true;
    show();
    try { return await pickAndSave(description); }
    finally { acting = false; show(); }
  }

  async function pickAndSave(description) {
    let picked = null;
    try {
      const res = await fetch(FOLDER_PICKER_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description }) });
      picked = (await res.json())?.path || null;
    } catch { picked = null; }
    if (!picked) return false;
    const next = await ask('PUT', BACKUP_DESTINATION_URL, { folderPath: picked });
    if (next.state === 'ready') { reading = next; notice = null; }
    else notice = { kind: 'folder', message: next.message || '' };
    return next.state === 'ready';
  }

  /** Start the backup (or, on a server from before, the browser's download) and follow it to its end. */
  async function start() {
    if (reading.state === 'old-server') {
      notice = { kind: 'browser' };
      show();
      browserDownload();
      return;
    }
    if (isRunning()) { notice = { kind: 'running' }; show(); return follow(); }
    if (acting) return;
    acting = true;
    notice = null;
    show();
    let next;
    try { next = await ask('POST', BACKUP_JOB_URL); }
    finally { acting = false; }
    if (next.state === 'ready') {
      reading = next;
      if (next.alreadyRunning) notice = { kind: 'running' };
    } else if (next.state === 'old-server') {
      reading = next;
      return start();
    } else notice = { kind: 'start', message: next.message || '' };
    show();
    if (isRunning()) await follow();
  }

  /** Stop the running backup: nothing is saved. The row then follows it to its end. */
  async function cancel() {
    if (!isRunning()) return false;
    const next = await ask('POST', BACKUP_CANCEL_URL, {});
    if (next.state === 'ready') { reading = next; notice = null; }
    else notice = { kind: 'cancel', message: next.state === 'old-server' ? 'HTTP 404' : next.message || '' };
    show();
    if (isRunning()) await follow();
    return next.state === 'ready';
  }

  /** Show the finished backup in the system's file manager. */
  async function reveal() {
    try {
      const res = await fetch(BACKUP_REVEAL_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (res.ok) return true;
      let message = '';
      try { message = clean((await res.json())?.error); } catch { message = ''; }
      notice = { kind: 'reveal', message: message || `HTTP ${res.status}` };
    } catch (error) {
      notice = { kind: 'reveal', message: clean(error?.message || error) };
    }
    show();
    return false;
  }

  /** The browser's own download, for a page on another computer than the server. */
  function downloadInBrowser() {
    notice = { kind: 'browser' };
    show();
    browserDownload();
  }

  return { load, choose, start, cancel, reveal, downloadInBrowser, model: () => ({ reading, notice, acting }) };
}
