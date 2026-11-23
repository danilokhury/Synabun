// Settings → Backups → Password protection and Recent backups, and the password dialog of a restore: the DOM over
// settings-backup-encryption.js, which decides. `kit` is settings-kit.js, handed in by ui-settings.js. A typed password
// stays in its input until the one request that uses it, and the inputs are emptied whatever the answer.
//
// What it looks like is in styles.css, the block marked `backup-encryption-ui`: the form's spacing, the error under
// its field, and the text roles of the restore's dialogs (RESTORE_DIALOG_CLASS), which are attached to body, outside
// .settings-panel.

import {
  BACKUP_ENCRYPTION_FORMS, BACKUP_HISTORY_URL, clearRestoreOutcome, createBackupEncryptionController, describeBackupEncryption, describeBackupHistory,
  describeRestoreOutcome, discardEncryptedRestore, readRestoreOutcome, restoreCanUnlock, restoreErrorMessage, restoreNeedsNewFile, unlockEncryptedRestore,
} from './settings-backup-encryption.js';

const K = 'settings.redesign.server';

/** On the modal of the restore's two dialogs (the backup's password here, the confirmation in ui-settings.js). */
export const RESTORE_DIALOG_CLASS = 'stg-restore-dialog';
/** The fields a form can show, in the order they stand in it. */
const FIELDS = ['current', 'password', 'confirm', 'acknowledged'];
const errorId = (field) => `sys-backup-enc-${field}-error`;

const fieldError = (field) => `<div class="stg-field-error" id="${errorId(field)}" data-enc-error="${field}" role="alert" style="display:none"></div>`;

const passwordField = (kit, id, labelKey, autocomplete) => `
  <div class="stg-field stg-inline-field" data-enc-field="${id}" style="display:none">
    <label for="sys-backup-enc-${id}" id="sys-backup-enc-${id}-label">${kit.te(labelKey)}</label>
    <div class="stg-input-row">
      <input type="password" id="sys-backup-enc-${id}" autocomplete="${autocomplete}" spellcheck="false" autocapitalize="off" maxlength="1024">
    </div>
    ${fieldError(id)}
  </div>`;

export function backupEncryptionHTML(kit) {
  return `
    ${kit.subhead(kit.te(`${K}.backupEncTitle`), { id: 'sys-backup-enc-title' })}
    ${kit.toggleField('GEN019', kit.switchInput('sys-backup-enc-toggle'), { forId: 'sys-backup-enc-toggle' })}
    <div class="stg-action-row" style="align-items:center;gap:8px">
      ${kit.pill('', { id: 'sys-backup-enc-pill', state: 'off' })}
      <button type="button" class="stg-action-btn compact" id="sys-backup-enc-change" style="display:none">${kit.te(`${K}.backupEncChange`)}</button>
      <button type="button" class="stg-action-btn compact" id="sys-backup-enc-repair" style="display:none">${kit.te(`${K}.backupEncRepair`)}</button>
    </div>
    <div class="stg-help" id="sys-backup-enc-status" role="status" aria-live="polite"></div>
    <form class="stg-enc-form" id="sys-backup-enc-form" aria-labelledby="sys-backup-enc-form-title" autocomplete="off" novalidate style="display:none">
      <div class="stg-enc-form-title" id="sys-backup-enc-form-title"></div>
      ${passwordField(kit, 'current', `${K}.backupEncCurrent`, 'current-password')}
      ${passwordField(kit, 'password', `${K}.backupEncPassword`, 'new-password')}
      ${passwordField(kit, 'confirm', `${K}.backupEncPasswordConfirm`, 'new-password')}
      <div data-enc-field="acknowledged" style="display:none">
        ${kit.toggleField('GEN019', kit.switchInput('sys-backup-enc-ack'), { forId: 'sys-backup-enc-ack', label: kit.te(`${K}.backupEncAckLabel`), helpHtml: kit.te(`${K}.backupEncAckHelp`), attrs: 'data-enc-ack' })}
        ${fieldError('acknowledged')}
      </div>
      <div class="stg-help" id="sys-backup-enc-note"></div>
      <div class="stg-field-error" id="sys-backup-enc-error" role="alert" style="display:none"></div>
      <div class="stg-action-row">
        <button type="submit" class="stg-action-btn" id="sys-backup-enc-submit"></button>
        <button type="button" class="stg-action-btn compact" id="sys-backup-enc-cancel">${kit.te(`${K}.backupEncCancel`)}</button>
      </div>
    </form>`;
}

export function backupHistoryHTML(kit) {
  return `
    <div id="sys-backup-history-block" style="display:none">
      ${kit.subhead(kit.te(`${K}.backupHistoryTitle`), { id: 'sys-backup-history-title' })}
      <div id="sys-backup-history" role="list" aria-labelledby="sys-backup-history-title"></div>
      <div class="stg-help" id="sys-backup-history-note"></div>
    </div>`;
}

/** Wires the row. Returns { refreshHistory } for the code that finishes a backup. */
export function wireBackupEncryption(overlay, kit, { fetch: fetchFn = (...args) => fetch(...args) } = {}) {
  const $ = (id) => overlay.querySelector(`#${id}`);
  const toggle = $('sys-backup-enc-toggle');
  if (!toggle) return { refreshHistory: async () => {} };
  const pill = $('sys-backup-enc-pill');
  const changeBtn = $('sys-backup-enc-change');
  const repairBtn = $('sys-backup-enc-repair');
  const statusEl = $('sys-backup-enc-status');
  const form = $('sys-backup-enc-form');
  const titleEl = $('sys-backup-enc-form-title');
  const noteEl = $('sys-backup-enc-note');
  const errorEl = $('sys-backup-enc-error');
  const submitBtn = $('sys-backup-enc-submit');
  const cancelBtn = $('sys-backup-enc-cancel');
  const inputs = { current: $('sys-backup-enc-current'), password: $('sys-backup-enc-password'), confirm: $('sys-backup-enc-confirm'), acknowledged: $('sys-backup-enc-ack') };
  const fieldErrors = Object.fromEntries(FIELDS.map((field) => [field, $(errorId(field))]));
  // What already describes each input (the switch's help line): an error is added to it, never put in its place.
  const describedBy = Object.fromEntries(FIELDS.map((field) => [field, inputs[field].getAttribute('aria-describedby') || '']));
  const clearInputs = () => {
    for (const name of ['current', 'password', 'confirm']) inputs[name].value = '';
    inputs.acknowledged.checked = false;
  };
  let shownForm = null;
  let invalidField = null;

  const controller = createBackupEncryptionController({
    fetch: fetchFn,
    alive: () => overlay.isConnected !== false,
    render: (model) => {
      const row = describeBackupEncryption(model, { tx: kit.tx });
      toggle.checked = row.on;
      toggle.disabled = !row.canToggle;
      pill.textContent = row.pill.text;
      pill.dataset.state = row.pill.state;
      pill.style.display = row.pill.text ? '' : 'none';
      changeBtn.style.display = row.canChange ? '' : 'none';
      if (repairBtn) repairBtn.style.display = row.canRepair ? '' : 'none';
      statusEl.textContent = row.notice || row.status;
      form.style.display = row.form ? '' : 'none';
      if (row.form) {
        const copy = BACKUP_ENCRYPTION_FORMS[row.form];
        for (const el of form.querySelectorAll('[data-enc-field]')) el.style.display = copy.fields.includes(el.dataset.encField) ? '' : 'none';
        if (titleEl) titleEl.textContent = kit.tx(copy.title);
        $('sys-backup-enc-password-label').textContent = kit.tx(copy.password);
        $('sys-backup-enc-confirm-label').textContent = kit.tx(copy.confirm);
        noteEl.textContent = copy.note ? kit.tx(copy.note) : '';
        noteEl.style.display = copy.note ? '' : 'none';
        submitBtn.textContent = row.busy ? kit.tx(`${K}.backupEncWorking`) : kit.tx(copy.submit);
        submitBtn.disabled = row.busy;
        cancelBtn.disabled = row.busy;
        if (shownForm !== row.form) {
          clearInputs();
          inputs[copy.fields[0]]?.focus?.();
        }
      } else if (shownForm) clearInputs();
      shownForm = row.form;
      // A refusal that names no field is the form's own line, above its buttons.
      errorEl.textContent = row.error;
      errorEl.style.display = row.error ? '' : 'none';
      // One that names a field stands under that field, and the field says so to a screen reader.
      invalidField = row.fieldError ? row.errorField : null;
      for (const field of FIELDS) {
        const input = inputs[field];
        const errorNode = fieldErrors[field];
        const wrong = invalidField === field && !!errorNode;
        if (errorNode) {
          errorNode.textContent = wrong ? row.fieldError : '';
          errorNode.style.display = wrong ? '' : 'none';
        }
        if (wrong) {
          input.setAttribute('aria-invalid', 'true');
          input.setAttribute('aria-describedby', [describedBy[field], errorNode.id].filter(Boolean).join(' '));
        } else {
          input.removeAttribute('aria-invalid');
          if (describedBy[field]) input.setAttribute('aria-describedby', describedBy[field]);
          else input.removeAttribute('aria-describedby');
        }
      }
    },
  });

  toggle.addEventListener('change', () => {
    const wantOn = toggle.checked;
    // The switch shows what is true: it moves when the server has done it.
    toggle.checked = !wantOn;
    controller.open(wantOn ? 'enable' : 'disable');
  });
  changeBtn.addEventListener('click', () => controller.open('change'));
  repairBtn?.addEventListener('click', () => controller.open('repair'));
  cancelBtn.addEventListener('click', () => controller.close());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = { current: inputs.current.value, password: inputs.password.value, confirm: inputs.confirm.value, acknowledged: inputs.acknowledged.checked };
    const done = await controller.submit(values);
    // A wrong current password is typed again; the new one stays out of the page's memory either way.
    inputs.current.value = '';
    if (done) { clearInputs(); refreshHistory(); }
    // The field that was refused takes the keyboard, so its error is what is read and what is fixed next.
    else if (invalidField) inputs[invalidField]?.focus?.();
  });

  const historyBlock = $('sys-backup-history-block');
  const historyList = $('sys-backup-history');
  const historyNote = $('sys-backup-history-note');
  // Two reads can be under way (a backup that ended while the first was out): only the last one asked is drawn.
  let historyAsk = 0;
  async function refreshHistory() {
    if (!historyList) return;
    const ask = ++historyAsk;
    let reading;
    try {
      const res = await fetchFn(BACKUP_HISTORY_URL);
      let body = null;
      try { body = await res.json(); } catch { /* below */ }
      reading = { status: res.status, body };
    } catch (error) { reading = { error }; }
    if (overlay.isConnected === false || ask !== historyAsk) return;
    const list = describeBackupHistory(reading, { tx: kit.tx });
    historyBlock.style.display = list.available ? '' : 'none';
    historyList.innerHTML = list.rows.map(row => `
      <div role="listitem" class="stg-help" style="display:flex;flex-wrap:wrap;align-items:center;gap:8px">
        ${kit.pill(kit.esc(row.badge.text), { state: row.badge.state })}
        <span style="overflow-wrap:anywhere">${kit.esc(row.name)}</span>
        <span>${kit.esc([row.when, row.size].filter(Boolean).join(' · '))}</span>
      </div>`).join('');
    historyNote.textContent = list.note;
    historyNote.style.display = list.note ? '' : 'none';
  }

  controller.load();
  refreshHistory();
  return { refreshHistory };
}

/**
 * The password step of a restore. `locked` is the preview's answer ({ uploadId, capabilities, … }). Resolves the
 * unlocked preview, or null when the owner cancels (the staged upload is then discarded). Rejects, with the upload
 * discarded and no password asked for, when the server is one from before the authentication key.
 */
/**
 * A restore that finished with problems, as a dialog of its own: right after it, and again after the reload or restart
 * that followed (showWaitingRestoreOutcome). Only a button of the owner's ends it and forgets the record: a click
 * beside it or Escape must not lose the one message that says the memories did not come back.
 */
export function openRestoreOutcomeDialog(outcome, { tx, restarting = false, offerReload = false, doc = document, storage, reload = () => globalThis.location.reload() } = {}) {
  doc.getElementById('sys-restore-outcome')?.parentNode?.remove();
  const words = describeRestoreOutcome(outcome, { tx, restarting });
  const forget = () => clearRestoreOutcome(storage === undefined ? {} : { storage });
  const filled = 'background:var(--accent-blue-bg);border-color:var(--accent-blue-border);color:var(--accent-blue)';
  const dialog = doc.createElement('div');
  dialog.className = 'tag-delete-overlay';
  dialog.style.zIndex = '300100';
  dialog.innerHTML = `
    <div class="tag-delete-modal settings-modal ${RESTORE_DIALOG_CLASS}" id="sys-restore-outcome" role="alertdialog" aria-modal="true" aria-labelledby="sys-restore-outcome-title" aria-describedby="sys-restore-outcome-list" style="max-width:500px;text-align:left">
      <h3 id="sys-restore-outcome-title" style="margin-bottom:10px;color:var(--stg-warn)"></h3>
      <ul id="sys-restore-outcome-list" style="margin:0 0 12px;padding-left:18px;font-size:12px;line-height:1.45"></ul>
      <p id="sys-restore-outcome-note" style="display:none;font-size:11px;color:var(--t-muted);margin-bottom:12px"></p>
      <div class="tag-delete-modal-actions">
        <button type="button" class="action-btn action-btn--ghost" id="sys-restore-outcome-close"></button>
        <button type="button" class="action-btn action-btn--danger" id="sys-restore-outcome-reload" style="display:none;${filled}"></button>
      </div>
    </div>`;
  doc.body.appendChild(dialog);
  dialog.querySelector('#sys-restore-outcome-title').textContent = words.title;
  const list = dialog.querySelector('#sys-restore-outcome-list');
  for (const message of words.messages) {
    const item = doc.createElement('li');
    item.style.marginBottom = '6px';
    item.textContent = message;
    list.appendChild(item);
  }
  const note = dialog.querySelector('#sys-restore-outcome-note');
  if (words.note) { note.textContent = words.note; note.style.display = ''; }
  const close = dialog.querySelector('#sys-restore-outcome-close');
  const again = dialog.querySelector('#sys-restore-outcome-reload');
  close.textContent = words.close;
  close.addEventListener('click', () => { forget(); dialog.remove(); });
  if (offerReload) {
    again.textContent = words.reload;
    again.style.display = '';
    again.addEventListener('click', () => { forget(); dialog.remove(); reload(); });
    again.focus?.();
  } else close.focus?.();
  return dialog;
}

/** After a reload or a restart: the outcome this tab still has to show, if any. */
export function showWaitingRestoreOutcome({ tx, doc = document, storage } = {}) {
  const outcome = readRestoreOutcome(storage === undefined ? {} : { storage });
  return outcome ? openRestoreOutcomeDialog(outcome, { tx, doc, storage }) : null;
}

export function askRestorePassword(locked, { kit, fetch: fetchFn = (...args) => fetch(...args), doc = document } = {}) {
  if (!restoreCanUnlock(locked)) {
    discardEncryptedRestore(fetchFn, locked?.uploadId);
    return Promise.reject(Object.assign(new Error(kit.tx(`${K}.restoreEncNeedsRestart`)), { needsRestart: true }));
  }
  return new Promise((resolvePreview) => {
    const dialog = doc.createElement('div');
    dialog.className = 'tag-delete-overlay';
    dialog.style.zIndex = '300100';
    dialog.innerHTML = `
      <form class="tag-delete-modal settings-modal ${RESTORE_DIALOG_CLASS}" id="sys-restore-unlock-form" role="dialog" aria-modal="true" aria-labelledby="sys-restore-unlock-title" aria-describedby="sys-restore-unlock-help" autocomplete="off" novalidate style="max-width:440px;text-align:left">
        <h3 id="sys-restore-unlock-title" style="margin-bottom:4px">${kit.te(`${K}.restoreEncTitle`)}</h3>
        <p id="sys-restore-unlock-help" style="font-size:11px;color:var(--t-muted);margin-bottom:12px">${kit.te(`${K}.restoreEncHelp`)}</p>
        <div class="stg-field stg-inline-field">
          <label for="sys-restore-password">${kit.te(`${K}.restoreEncPassword`)}</label>
          <div class="stg-input-row"><input type="password" id="sys-restore-password" autocomplete="current-password" spellcheck="false" autocapitalize="off" maxlength="1024"></div>
          <div class="stg-field-error" id="sys-restore-unlock-error" role="alert" style="display:none"></div>
        </div>
        <div class="tag-delete-modal-actions">
          <button type="button" class="action-btn action-btn--ghost" id="sys-restore-unlock-cancel">${kit.te(`${K}.backupEncCancel`)}</button>
          <button type="submit" class="action-btn action-btn--danger" id="sys-restore-unlock-submit" style="background:var(--accent-blue-bg);border-color:var(--accent-blue-border);color:var(--accent-blue)">${kit.te(`${K}.restoreEncUnlock`)}</button>
        </div>
      </form>`;
    doc.body.appendChild(dialog);
    const input = dialog.querySelector('#sys-restore-password');
    const errorEl = dialog.querySelector('#sys-restore-unlock-error');
    const submit = dialog.querySelector('#sys-restore-unlock-submit');
    const cancel = dialog.querySelector('#sys-restore-unlock-cancel');
    let busy = false;
    const end = (value) => { input.value = ''; dialog.remove(); resolvePreview(value); };
    const giveUp = () => { if (busy) return; discardEncryptedRestore(fetchFn, locked.uploadId); end(null); };
    const showError = (message) => {
      errorEl.textContent = message;
      errorEl.style.display = '';
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', 'sys-restore-unlock-error');
    };
    const clearError = () => {
      errorEl.style.display = 'none';
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
    };
    cancel.addEventListener('click', giveUp);
    dialog.addEventListener('keydown', (event) => { if (event.key === 'Escape') giveUp(); });
    dialog.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (busy) return;
      if (!input.value) { showError(kit.tx(`${K}.backupEncErrRequired`)); return; }
      busy = true;
      submit.disabled = true;
      cancel.disabled = true;
      submit.textContent = kit.tx(`${K}.restoreEncUnlocking`);
      clearError();
      let answer = null;
      try { answer = await unlockEncryptedRestore(fetchFn, locked.uploadId, input.value); }
      catch { answer = { ok: false, body: null, failed: true }; }
      input.value = '';
      busy = false;
      if (answer.ok && answer.body?.ok) { end({ ...answer.body, uploadId: locked.uploadId }); return; }
      submit.disabled = false;
      cancel.disabled = false;
      submit.textContent = kit.tx(`${K}.restoreEncUnlock`);
      // A request that got no answer says so; a refusal is told by its code, never by the server's sentence.
      showError(answer.failed ? kit.tx(`${K}.backupEncErrFailed`) : restoreErrorMessage(answer.body, { tx: kit.tx }));
      // The upload is gone, damaged or not one this SynaBun reads: another password cannot help.
      if (restoreNeedsNewFile(answer.body?.code)) {
        submit.disabled = true;
        input.disabled = true;
      } else input.focus?.();
    });
    input.focus?.();
  });
}
