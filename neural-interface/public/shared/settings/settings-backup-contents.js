// ═══════════════════════════════════════════
// SETTINGS — What to back up
// ═══════════════════════════════════════════
//
// Settings → Memory & backups → Backups → What to back up. A backup is made of groups (lib/backup-groups.js) and the
// owner switches each on or off, with its size beside it; the choice is the server's (lib/backup-contents.js, GET and
// PUT /api/system/backup/contents) and applies to every manual and scheduled backup. The sizes are measured on a
// worker thread there: this page reads what is measured and asks again while a measurement runs.
// Pure: no DOM and no import, so node runs it (tests/settings-backup-contents.test.mjs).
//
//   readBackupContentsResponse({ status, body, error })   what the server answered → a reading
//   describeBackupContents(model, { tx })                  the list as ui-settings.js draws it
//   describeRestoreContents(contents, { tx })              what a backup holds, for the restore dialog
//   createBackupContentsController({ fetch, render, … })   load, switch a group, measure again
//
// `tx(key, params)` is the caller's translate function over the settings.redesign.* strings (the kit's `tx`).
// A server started before these routes existed answers 404: the list then says a restart is missing, and until
// then every backup holds everything, as it always did.

const K = 'settings.redesign.server';

export const BACKUP_CONTENTS_URL = '/api/system/backup/contents';

// Every key written out: the settings copy tools find a key by its literal.
const GROUP_COPY = {
  memories: { label: `${K}.backupGroupMemories`, help: `${K}.backupGroupMemoriesHelp` },
  settings: { label: `${K}.backupGroupSettings`, help: `${K}.backupGroupSettingsHelp` },
  conversations: { label: `${K}.backupGroupConversations`, help: `${K}.backupGroupConversationsHelp` },
  media: { label: `${K}.backupGroupMedia`, help: `${K}.backupGroupMediaHelp` },
  caches: { label: `${K}.backupGroupCaches`, help: `${K}.backupGroupCachesHelp` },
  scratch: { label: `${K}.backupGroupScratch`, help: `${K}.backupGroupScratchHelp` },
};
const KIND_COPY = {
  irreplaceable: `${K}.backupKindIrreplaceable`,
  regenerable: `${K}.backupKindRegenerable`,
  temporary: `${K}.backupKindTemporary`,
};

const clean = (value, max = 400) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** A size with its unit: KB below a megabyte, MB below a gigabyte, GB from there. '' for what is not a size. */
export function formatContentsSize(bytes) {
  const size = Number(bytes);
  if (bytes == null || !Number.isFinite(size) || size < 0) return '';
  if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(2)} GB`;
  if (size >= 1024 ** 2) return `${(size / 1024 ** 2).toFixed(size >= 100 * 1024 ** 2 ? 0 : 1)} MB`;
  return `${Math.max(size > 0 ? 1 : 0, Math.round(size / 1024))} KB`;
}

/** The name of a group as the page says it; a group this page does not know keeps its id. */
export function backupGroupLabel(id, tx) {
  return GROUP_COPY[id] ? tx(GROUP_COPY[id].label) : String(id);
}

/**
 * What the server answered.
 *   ready        `groups` [{ id, kind, enabled, files, bytes, archiveBytes }], `totals`, `never`, `irreplaceableOff`,
 *                `estimate` { state: 'none' | 'measuring' | 'ready' | 'failed', error }
 *   old-server   404: the running server was started before these routes existed
 *   refused      an answer with an error and no state (`message`, `code`)
 *   unreadable   anything else; `message`
 */
export function readBackupContentsResponse({ status = 0, body = null, error = null } = {}) {
  const code = Number(status) || 0;
  if (code === 404) return { state: 'old-server' };
  if (body && typeof body === 'object' && Array.isArray(body.groups) && code >= 200 && code < 300) {
    // An id is used in the rows' element ids: only the shape a group id has is let through.
    const groups = body.groups.filter(group => group && typeof group.id === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(group.id)).map(group => ({
      id: group.id,
      kind: typeof group.kind === 'string' ? group.kind : 'irreplaceable',
      enabled: group.enabled === true,
      files: Number.isFinite(group.files) ? group.files : null,
      bytes: Number.isFinite(group.bytes) ? group.bytes : null,
      archiveBytes: Number.isFinite(group.archiveBytes) ? group.archiveBytes : null,
    }));
    const estimate = body.estimate && typeof body.estimate === 'object' ? body.estimate : {};
    return {
      state: 'ready', groups,
      totals: body.totals && typeof body.totals === 'object' ? body.totals : null,
      never: body.never && typeof body.never === 'object' ? body.never : null,
      irreplaceableOff: Array.isArray(body.irreplaceableOff) ? body.irreplaceableOff.filter(id => typeof id === 'string') : [],
      estimate: { state: typeof estimate.state === 'string' ? estimate.state : 'none', error: clean(estimate.error) || null },
    };
  }
  if (body && typeof body === 'object' && body.error) return { state: 'refused', message: clean(body.error), code: body.code || null };
  return { state: 'unreadable', message: clean(error?.message || error) || (code ? `HTTP ${code}` : '') };
}

/**
 * The list. `model`: `{ reading, notice, saving }`, the controller's. →
 *   available   the server has the choice (false: `note` says why not, and no row is drawn)
 *   rows        [{ id, label, help, kind, kindLabel, enabled, size, busy }]   `size` '' while it is not measured
 *   total       the size of a backup made with this choice ('' while it is not measured)
 *   everything  the size with every group on, when that is more ('' otherwise)
 *   warning     which irreplaceable groups are switched off (null: none)
 *   never       what no backup holds, with its size (null while it is not measured)
 *   note        a refusal, a failed save or a failed measurement (null: nothing)
 *   measuring   a measurement runs
 */
export function describeBackupContents({ reading = null, notice = null, saving = null } = {}, { tx }) {
  if (reading?.state === 'old-server') return { available: false, rows: [], total: '', everything: '', warning: null, never: null, measuring: false, note: tx(`${K}.backupContentsNeedsRestart`) };
  if (!reading || reading.state === 'loading') return { available: false, rows: [], total: '', everything: '', warning: null, never: null, measuring: false, note: null };
  if (reading.state !== 'ready') {
    return { available: false, rows: [], total: '', everything: '', warning: null, never: null, measuring: false, note: tx(`${K}.backupContentsUnreadable`, { message: reading.message || '' }) };
  }
  const rows = reading.groups.map((group) => {
    const copy = GROUP_COPY[group.id];
    const measured = group.bytes != null;
    return {
      id: group.id,
      label: copy ? tx(copy.label) : group.id,
      help: copy ? tx(copy.help) : '',
      kind: group.kind,
      kindLabel: KIND_COPY[group.kind] ? tx(KIND_COPY[group.kind]) : '',
      enabled: group.enabled,
      size: !measured ? '' : group.files === 0 ? tx(`${K}.backupGroupEmpty`)
        : tx(`${K}.backupGroupSize`, { size: formatContentsSize(group.bytes), archive: formatContentsSize(group.archiveBytes) }),
      busy: saving === group.id,
    };
  });
  const selected = reading.totals?.selected;
  const everything = reading.totals?.everything;
  const off = reading.irreplaceableOff.map(id => backupGroupLabel(id, tx));
  let note = null;
  if (notice?.kind === 'save') note = tx(`${K}.backupContentsSaveFailed`, { message: notice.message });
  else if (reading.estimate.state === 'failed') note = tx(`${K}.backupContentsMeasureFailed`, { message: reading.estimate.error || '' });
  return {
    available: true,
    rows,
    total: selected ? tx(`${K}.backupContentsTotal`, { archive: formatContentsSize(selected.archiveBytes), size: formatContentsSize(selected.bytes), files: selected.files }) : '',
    everything: selected && everything && everything.bytes > selected.bytes ? tx(`${K}.backupContentsEverything`, { archive: formatContentsSize(everything.archiveBytes) }) : '',
    warning: off.length ? tx(`${K}.backupContentsWarning`, { groups: off.join(', ') }) : null,
    never: reading.never ? tx(`${K}.backupContentsNever`, { size: formatContentsSize(reading.never.bytes) }) : null,
    measuring: reading.estimate.state === 'measuring',
    note,
  };
}

/**
 * What a backup holds, for the restore dialog, from the server's reading of its manifest (`contents` of POST
 * /api/system/restore/preview: { recorded, included, excluded, complete, legacy }). →
 *   contains     the groups in it, by name ('' when none is known)
 *   missing      the groups it does not contain, by name: a restore leaves them as they are ('' when it holds all)
 *   stateOnly    a pre-update snapshot: state without generated media
 * null when the server said nothing about groups (a server from before).
 */
export function describeRestoreContents(contents, { tx }) {
  if (!contents || typeof contents !== 'object' || !Array.isArray(contents.included)) return null;
  const names = (list) => (Array.isArray(list) ? list : []).filter(id => typeof id === 'string').map(id => backupGroupLabel(id, tx)).join(', ');
  const contains = names(contents.included);
  const missing = contents.complete === true ? '' : names(contents.excluded);
  return {
    contains: contains ? tx(`${K}.restoreContains`, { groups: contains }) : '',
    missing: missing ? tx(`${K}.restoreNotContained`, { groups: missing }) : '',
    stateOnly: contents.legacy === 'state-only' ? tx(`${K}.restoreStateOnly`) : '',
  };
}

/**
 * The list's behaviour, without a DOM. `render(model)` is called with `{ reading, notice, saving }` after every change.
 * @param {object} o
 * @param {typeof fetch} o.fetch
 * @param {(model: object) => void} o.render
 * @param {(ms: number) => Promise<void>} [o.wait]   the pause between two looks at a running measurement
 * @param {number} [o.pollMs]
 * @param {number} [o.maxPolls]                      a measurement that long is no longer followed
 * @param {() => boolean} [o.alive]                  false once the list is gone
 */
export function createBackupContentsController({
  fetch, render, wait = (ms) => new Promise((done) => setTimeout(done, ms)), pollMs = 1000, maxPolls = 180, alive = () => true,
} = {}) {
  let reading = { state: 'loading' };
  let notice = null;
  let saving = null;
  let following = false;

  const show = () => { try { render({ reading, notice, saving }); } catch { /* a list that cannot be drawn changes nothing here */ } };

  async function ask(method, url, body) {
    try {
      const init = { method };
      if (body !== undefined) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body); }
      const res = await fetch(url, init);
      let json = null;
      try { json = await res.json(); } catch { json = null; }
      return readBackupContentsResponse({ status: res.status, body: json });
    } catch (error) {
      return readBackupContentsResponse({ error });
    }
  }

  const measuring = () => reading.state === 'ready' && reading.estimate.state === 'measuring';

  // Ask again while the server measures. A look that fails keeps what was known.
  async function follow() {
    if (following) return;
    following = true;
    try {
      for (let polls = 0; measuring() && alive() && polls < maxPolls; polls++) {
        await wait(pollMs);
        if (saving) continue; // the answer to the switch under way is the newer state
        const next = await ask('GET', BACKUP_CONTENTS_URL);
        if (next.state === 'ready' && !saving) reading = next;
        show();
      }
    } finally { following = false; }
  }

  async function load({ refresh = false } = {}) {
    const next = await ask('GET', refresh ? `${BACKUP_CONTENTS_URL}?refresh=1` : BACKUP_CONTENTS_URL);
    // A refresh that fails keeps the list that was there.
    if (next.state === 'ready' || reading.state !== 'ready') reading = next;
    show();
    if (measuring()) await follow();
  }

  /** Switch one group. The switch shows the choice at once; a refusal puts it back and says why. */
  async function toggle(id, enabled) {
    if (reading.state !== 'ready' || saving) { show(); return false; }
    const before = reading;
    saving = id;
    notice = null;
    reading = { ...reading, groups: reading.groups.map(group => (group.id === id ? { ...group, enabled: !!enabled } : group)) };
    show();
    const next = await ask('PUT', BACKUP_CONTENTS_URL, { groups: { [id]: !!enabled } });
    saving = null;
    if (next.state === 'ready') reading = next;
    else {
      reading = before;
      notice = { kind: 'save', message: next.state === 'old-server' ? 'HTTP 404' : next.message || '' };
    }
    show();
    if (measuring()) follow();
    return next.state === 'ready';
  }

  return { load, toggle, refresh: () => load({ refresh: true }), model: () => ({ reading, notice, saving }) };
}
