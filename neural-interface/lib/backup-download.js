// ═══════════════════════════════════════════
// DOWNLOAD BACKUP — into a folder the owner chose
// ═══════════════════════════════════════════
//
// Settings → Backups → Download full backup. The server builds the verified archive (createVerifiedBackup of
// backup-service.js: staged, checksummed, read back, then renamed into place) directly in a folder of this
// computer, instead of sending a multi-GB response a browser tab had to hold in memory before it could save it.
//
//   defaultBackupDownloadFolder(homeDir)             ~/Downloads, resolved here, never by the page
//   validateBackupDownloadFolder(path, { … })        the folder as it will be used, or a BackupDestinationError
//   createBackupDownloadService({ … })               the remembered folder and the one job
//   backupDownloadHandlers(service, { revealer })    the four route handlers server.js registers
//
// One job at a time, and it runs apart from the request that started it: the page starts it, then asks for its
// state (GET /api/system/backup/job). The job goes through the caller's `serialize` (server.js
// serializeBackupOperation), so it never overlaps a scheduled backup; while it waits for one it says `queued`.
// The folder is remembered in DATA_HOME/data/backup-download.json ({ folderPath }); without one it is ~/Downloads.
// Nothing here takes a path to open or reveal from a request: reveal shows the last finished backup (or the
// folder), both known to the server.

import { accessSync, constants as FS_CONSTANTS, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/** A folder that cannot take the backup. `code` names why; `status` is the HTTP answer (400). */
export class BackupDestinationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BackupDestinationError';
    this.code = code;
    this.status = 400;
  }
}

export function defaultBackupDownloadFolder(homeDir = os.homedir()) {
  return resolve(homeDir, 'Downloads');
}

// The folder a path really is (links followed, the file system's own spelling), or the path when it cannot be asked.
function realFolder(path) {
  try { return realpathSync.native(path); }
  catch { return resolve(path); }
}

function isInside(path, root) {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * The folder a backup can be written into, as an absolute path. Refused (BackupDestinationError): no path, a
 * relative one, a folder that is not there, a file, a folder this process cannot write in, a folder the backup
 * itself copies from (`sourceRoots`: the archive and its working files would be read into this backup and every
 * later one), and anything inside the data home but its `backups` folder (SynaBun's live folders; the two
 * `*-staging` folders there belong to the browser download and to restore).
 * @param {string} folderPath
 * @param {{ sourceRoots?: string[], dataHome?: string | null }} [o]
 */
export function validateBackupDownloadFolder(folderPath, { sourceRoots = [], dataHome = null } = {}) {
  if (typeof folderPath !== 'string' || !folderPath.trim()) throw new BackupDestinationError('FOLDER_REQUIRED', 'Choose a folder for the backup.');
  const asked = folderPath.trim();
  if (asked.includes('\0') || !isAbsolute(asked)) throw new BackupDestinationError('FOLDER_NOT_ABSOLUTE', `The backup folder must be a full path: ${asked.replace(/\0/g, '')}`);
  const target = resolve(asked);
  let stats;
  try { stats = statSync(target); }
  catch { throw new BackupDestinationError('FOLDER_MISSING', `The backup folder does not exist: ${target}`); }
  if (!stats.isDirectory()) throw new BackupDestinationError('FOLDER_NOT_DIRECTORY', `Not a folder: ${target}`);
  try { accessSync(target, FS_CONSTANTS.W_OK | FS_CONSTANTS.X_OK); }
  catch { throw new BackupDestinationError('FOLDER_NOT_WRITABLE', `SynaBun cannot write in ${target}. Choose another folder.`); }
  const actual = realFolder(target);
  for (const root of sourceRoots) {
    if (root && isInside(actual, realFolder(root))) {
      throw new BackupDestinationError('FOLDER_IS_BACKUP_SOURCE', `${target} is inside a folder the backup copies (${resolve(root)}). Choose a folder outside it.`);
    }
  }
  if (dataHome) {
    const home = realFolder(dataHome);
    if (isInside(actual, home)) {
      const [first, second] = relative(home, actual).split(sep);
      if (first !== 'backups' || /-staging$/.test(second || '')) {
        throw new BackupDestinationError('FOLDER_IN_DATA_HOME', `${target} is one of SynaBun's own data folders. Choose a folder outside ${resolve(dataHome)}.`);
      }
    }
  }
  return target;
}

/**
 * The remembered folder and the one download-backup job.
 *
 * @param {object} o
 * @param {string} o.configPath                      where the folder is remembered ({ folderPath })
 * @param {(job: { folderPath: string, onProgress: (event: object) => void, signal: AbortSignal }) => Promise<{ path: string, name: string, sizeBytes: number, manifest?: object }>} o.createBackup
 *        builds the verified archive in `folderPath` (createVerifiedBackup, kind `manual`); `signal` aborts it
 * @param {(operation: () => Promise<any>) => Promise<any>} [o.serialize]  one backup at a time (serializeBackupOperation)
 * @param {() => boolean} [o.isBusy]                 another backup is being made right now
 * @param {() => string[]} [o.sourceRoots]           the folders a backup copies from
 * @param {string | null} [o.dataHome]
 * @param {() => string} [o.homeDir]
 * @param {() => Date} [o.now]
 * @param {(line: string) => void} [o.log]
 */
export function createBackupDownloadService({
  configPath, createBackup, serialize = (operation) => operation(), isBusy = () => false,
  sourceRoots = () => [], dataHome = null, homeDir = () => os.homedir(), now = () => new Date(), log = () => {},
} = {}) {
  if (!configPath || typeof createBackup !== 'function') throw new Error('configPath and createBackup are required');
  let job = null;

  const validate = (folderPath) => validateBackupDownloadFolder(folderPath, { sourceRoots: sourceRoots(), dataHome });

  function savedFolder() {
    try {
      const value = JSON.parse(readFileSync(configPath, 'utf-8'))?.folderPath;
      return typeof value === 'string' && value.trim() ? value.trim() : null;
    } catch { return null; }
  }

  /** Where the next backup goes: the remembered folder, else ~/Downloads (made by the first backup when missing). */
  function destination() {
    const saved = savedFolder();
    const folderPath = saved || defaultBackupDownloadFolder(homeDir());
    let error = null;
    if (saved || existsSync(folderPath)) {
      try { validate(folderPath); } catch (cause) { error = cause.message; }
    }
    return { folderPath, isDefault: !saved, error };
  }

  function setDestination(folderPath) {
    const target = validate(folderPath);
    mkdirSync(dirname(configPath), { recursive: true });
    const temp = `${configPath}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ folderPath: target }, null, 2) + '\n', 'utf-8');
      renameSync(temp, configPath);
    } catch (error) {
      try { if (existsSync(temp)) unlinkSync(temp); } catch { /* nothing to remove */ }
      throw error;
    }
    return destination();
  }

  // createVerifiedBackup reports a phase as it begins, except `collect`, which it reports once the files are known.
  function note(current, event) {
    if (!event || typeof event !== 'object') return;
    if (Number.isFinite(event.files)) current.files = event.files;
    if (Number.isFinite(event.bytes)) current.bytes = event.bytes;
    if (typeof event.tempPath === 'string') current.tempPath = event.tempPath;
    current.phase = event.phase === 'collect' ? 'copy' : event.phase;
  }

  function view(current) {
    let writtenBytes = null;
    if (current.state === 'running' && current.tempPath) {
      try { writtenBytes = statSync(current.tempPath).size; } catch { writtenBytes = null; }
    }
    const { id, state, phase, folderPath, startedAt, finishedAt, files, bytes, path, name, sizeBytes, error, groups, cancelling, encrypted } = current;
    return { id, state, phase, folderPath, startedAt, finishedAt, files, bytes, writtenBytes, path, name, sizeBytes, error, groups, cancelling, encrypted };
  }

  /** Starts the backup and returns at once. A second one while it runs is refused: BACKUP_RUNNING (409). */
  function start() {
    if (job?.state === 'running') throw Object.assign(new Error('A backup is already running.'), { code: 'BACKUP_RUNNING', status: 409 });
    const chosen = destination();
    if (chosen.isDefault && !existsSync(chosen.folderPath)) mkdirSync(chosen.folderPath, { recursive: true });
    const folderPath = validate(chosen.folderPath);
    const current = {
      id: randomUUID(), state: 'running', phase: isBusy() ? 'queued' : 'collect', folderPath,
      startedAt: now().toISOString(), finishedAt: null, files: null, bytes: null, tempPath: null,
      path: null, name: null, sizeBytes: null, error: null, finished: null,
      // The groups the finished archive holds (its manifest's own word), and whether a cancel was asked for.
      // `encrypted`: whether the finished archive is password-protected (null until it is finished).
      groups: null, cancelling: false, encrypted: null, abort: new AbortController(),
    };
    job = current;
    current.finished = Promise.resolve()
      .then(() => serialize(() => {
        // Cancelled while it waited for another backup: it never starts.
        if (current.abort.signal.aborted) throw Object.assign(new Error('The backup was cancelled.'), { code: 'BACKUP_CANCELLED' });
        current.phase = 'collect';
        return createBackup({ folderPath, onProgress: (event) => note(current, event), signal: current.abort.signal });
      }))
      .then((backup) => {
        const groups = backup.manifest?.groups;
        Object.assign(current, {
          state: 'done', path: backup.path, name: backup.name, sizeBytes: backup.sizeBytes, encrypted: backup.encrypted === true,
          groups: groups && Array.isArray(groups.included) ? { included: [...groups.included], excluded: Array.isArray(groups.excluded) ? [...groups.excluded] : [] } : null,
        });
        log(`[backup] Download backup: ${backup.path} (${(backup.sizeBytes / 1024 / 1024).toFixed(1)} MB${backup.encrypted ? ', encrypted' : ''})`);
      }, (error) => {
        if (error?.code === 'BACKUP_CANCELLED' || current.abort.signal.aborted) {
          Object.assign(current, { state: 'cancelled', error: null });
          log('[backup] Download backup cancelled: nothing was saved');
          return;
        }
        Object.assign(current, { state: 'failed', error: error?.message || String(error) });
        log(`[backup] Download backup failed: ${current.error}`);
      })
      .finally(() => { Object.assign(current, { phase: null, tempPath: null, cancelling: false, finishedAt: now().toISOString() }); });
    return view(current);
  }

  /**
   * Stop the running backup. It ends at its next step: nothing is saved, and the archive under way and the staged
   * copies are removed (createVerifiedBackup's own cleanup). NOTHING_RUNNING (409) when there is none.
   */
  function cancel() {
    if (job?.state !== 'running') throw Object.assign(new Error('No backup is running.'), { code: 'NOTHING_RUNNING', status: 409 });
    job.cancelling = true;
    job.abort.abort();
    return view(job);
  }

  /** What reveal shows: the last backup this server finished, while it is still there; else the folder. */
  function revealTarget() {
    if (job?.state === 'done' && job.path && existsSync(job.path)) return job.path;
    const { folderPath } = destination();
    return existsSync(folderPath) ? folderPath : null;
  }

  return {
    destination, setDestination, start, cancel, revealTarget,
    snapshot: () => ({ ok: true, destination: destination(), job: job ? view(job) : null, busy: !!isBusy() }),
    /** Settles when the running job ended (tests, shutdown). */
    idle: () => (job?.finished || Promise.resolve()),
  };
}

/**
 * The route handlers: GET job (the state), PUT destination ({ folderPath }), POST job (start; 202, or 409 with the
 * state while one runs), POST job/cancel (202; 409 when none runs), POST reveal (no path in the request). Every answer but a refusal is the service's snapshot.
 * @param {ReturnType<typeof createBackupDownloadService>} service
 * @param {{ revealer?: { available: () => boolean, reveal: (path: string) => Promise<boolean> } | null }} [o]
 */
export function backupDownloadHandlers(service, { revealer = null } = {}) {
  const canReveal = () => { try { return !!revealer?.available?.(); } catch { return false; } };
  const state = () => ({ ...service.snapshot(), canReveal: canReveal() });
  const refuse = (res, error) => {
    const status = Number(error?.status) || 500;
    let rest = {};
    if (error?.code === 'BACKUP_RUNNING') { try { rest = state(); } catch { rest = {}; } }
    return res.status(status).json({ ...rest, ok: false, error: error?.message || String(error), code: error?.code || null });
  };
  return {
    status(req, res) {
      try { res.json(state()); } catch (error) { refuse(res, error); }
    },
    setDestination(req, res) {
      try { service.setDestination(req.body?.folderPath); res.json(state()); } catch (error) { refuse(res, error); }
    },
    start(req, res) {
      try { service.start(); res.status(202).json(state()); } catch (error) { refuse(res, error); }
    },
    cancel(req, res) {
      try { service.cancel(); res.status(202).json(state()); } catch (error) { refuse(res, error); }
    },
    async reveal(req, res) {
      try {
        const target = service.revealTarget();
        if (!target) return res.status(404).json({ ok: false, code: 'NOTHING_TO_SHOW', error: 'The backup folder is not there any more.' });
        if (!canReveal() || !(await revealer.reveal(target))) return res.status(501).json({ ok: false, code: 'NO_REVEAL', error: 'This system has no file manager to show it in.' });
        res.json({ ok: true, path: target });
      } catch (error) { refuse(res, error); }
    },
  };
}
