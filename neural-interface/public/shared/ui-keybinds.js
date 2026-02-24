// ═══════════════════════════════════════════
// SynaBun Neural Interface — Keybinds System
// Central keyboard shortcut dispatcher + settings modal
// ═══════════════════════════════════════════

import { DEFAULT_KEYBINDS, KEYBIND_META } from './constants.js';
import { fetchKeybinds, saveKeybindsToServer } from './api.js';

// ── CLI icons for Launch group ──

const CLI_ICONS = {
  claude: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></svg>',
  codex: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"/></svg>',
  gemini: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"/></svg>',
};

// ── State ──

const _actions = new Map();       // actionId → handler function
let _bindings = {};               // actionId → combo string (merged defaults + overrides)
let _reverseMap = new Map();      // combo string → actionId (for O(1) dispatch)
let _recording = null;            // { actionId, originalCombo } when recording
let _pendingBindings = null;      // working copy during modal editing
let _modalOpen = false;

// ── Combo building ──

function buildCombo(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');

  let key = e.key;
  // Normalize: don't include bare modifier keys as the key portion
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return null;

  // Only include Shift for non-printable keys (Tab, Enter, arrows, F-keys, etc.)
  // For printable characters, the key value already reflects Shift (e.g. ? vs /, C vs c)
  if (e.shiftKey && key.length > 1) {
    parts.push('Shift');
  }

  parts.push(key);
  return parts.join('+');
}

function comboToDisplay(combo) {
  if (!combo) return '—';
  return combo
    .split('+')
    .map(part => {
      if (part === 'Ctrl') return 'Ctrl';
      if (part === 'Alt') return 'Alt';
      if (part === 'Shift') return 'Shift';
      if (part === 'Meta') return 'Meta';
      if (part === '`') return '`';
      if (part === '/') return '/';
      if (part === '?') return '?';
      if (part === ' ') return 'Space';
      if (part === 'Escape') return 'Esc';
      if (part.length === 1) return part.toUpperCase();
      return part;
    })
    .join(' + ');
}

function buildReverseMap(bindings) {
  const map = new Map();
  for (const [actionId, combo] of Object.entries(bindings)) {
    if (combo) map.set(combo, actionId);
  }
  return map;
}

// ── Public API ──

/** Register an action handler. Called by each module during init. */
export function registerAction(actionId, handler) {
  _actions.set(actionId, handler);
}

/** Get human-readable key label for an action (used by help modal). */
export function getDisplayKey(actionId) {
  return comboToDisplay(_bindings[actionId]);
}

/** Get raw combo string for an action. */
export function getBinding(actionId) {
  return _bindings[actionId] || null;
}

// ── Central dispatcher ──

function centralKeyHandler(e) {
  // Don't dispatch when modal is open (recording uses its own handler)
  if (_modalOpen) return;

  // Skip if in text input
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  // Skip if in xterm.js terminal
  if (document.activeElement?.closest('.term-viewport')) return;
  // Skip if contenteditable
  if (document.activeElement?.isContentEditable) return;

  const combo = buildCombo(e);
  if (!combo) return;

  const actionId = _reverseMap.get(combo);
  if (!actionId) return;

  const handler = _actions.get(actionId);
  if (!handler) return;

  e.preventDefault();
  handler();
}

// ── Modal ──

function renderModal() {
  // Group actions by their group
  const groups = {};
  for (const [actionId, meta] of Object.entries(KEYBIND_META)) {
    const group = meta.group || 'Other';
    if (!groups[group]) groups[group] = [];
    groups[group].push({ actionId, ...meta });
  }

  let html = '';
  for (const [groupName, actions] of Object.entries(groups)) {
    html += `<div class="kb-group">
      <div class="kb-group-title">${groupName}</div>`;
    for (const { actionId, label, icon } of actions) {
      const combo = _pendingBindings[actionId];
      const display = comboToDisplay(combo);
      const unboundClass = combo ? '' : ' kb-unbound';
      const iconHtml = icon && CLI_ICONS[icon]
        ? `<span class="kb-cli-icon kb-cli-${icon}">${CLI_ICONS[icon]}</span>`
        : '';
      html += `<div class="kb-row" data-action="${actionId}">
        <span class="kb-label">${iconHtml}${label}</span>
        <button class="kb-key-btn${unboundClass}" data-action="${actionId}">
          <span class="kb-key">${display}</span>
        </button>
      </div>`;
    }
    html += `</div>`;
  }
  return html;
}

function updateRowDisplay(actionId) {
  const modal = document.getElementById('keybinds-modal');
  if (!modal) return;
  const btn = modal.querySelector(`.kb-key-btn[data-action="${actionId}"]`);
  if (!btn) return;
  const combo = _pendingBindings[actionId];
  const display = comboToDisplay(combo);
  btn.querySelector('.kb-key').textContent = display;
  btn.classList.toggle('kb-unbound', !combo);
  btn.classList.remove('kb-conflict');
}

function startRecording(actionId) {
  // Cancel any previous recording
  stopRecording();

  _recording = { actionId, originalCombo: _pendingBindings[actionId] };

  const modal = document.getElementById('keybinds-modal');
  if (!modal) return;
  const btn = modal.querySelector(`.kb-key-btn[data-action="${actionId}"]`);
  if (btn) {
    btn.classList.add('kb-recording');
    btn.querySelector('.kb-key').textContent = 'Press keys...';
  }

  // Recording keydown listener
  document.addEventListener('keydown', recordKeyHandler, true);
}

function stopRecording() {
  if (!_recording) return;
  const { actionId } = _recording;
  _recording = null;

  document.removeEventListener('keydown', recordKeyHandler, true);

  const modal = document.getElementById('keybinds-modal');
  if (!modal) return;
  const btn = modal.querySelector(`.kb-key-btn[data-action="${actionId}"]`);
  if (btn) btn.classList.remove('kb-recording');

  updateRowDisplay(actionId);
}

function recordKeyHandler(e) {
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();

  if (!_recording) return;

  // Escape cancels recording
  if (e.key === 'Escape') {
    stopRecording();
    return;
  }

  // Ignore bare modifier presses
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;

  const combo = buildCombo(e);
  if (!combo) return;

  const { actionId } = _recording;

  // Check for conflicts
  const conflictAction = Object.entries(_pendingBindings).find(
    ([id, c]) => c === combo && id !== actionId
  );

  if (conflictAction) {
    const [conflictId] = conflictAction;
    const conflictMeta = KEYBIND_META[conflictId];

    // Show conflict — swap the bindings
    const modal = document.getElementById('keybinds-modal');
    if (modal) {
      const conflictBtn = modal.querySelector(`.kb-key-btn[data-action="${conflictId}"]`);
      if (conflictBtn) {
        conflictBtn.classList.add('kb-conflict');
        setTimeout(() => conflictBtn.classList.remove('kb-conflict'), 1500);
      }
    }

    // Swap: give the conflicting action our old binding (or unbind it)
    _pendingBindings[conflictId] = _recording.originalCombo || null;
    updateRowDisplay(conflictId);

    // Show a toast-like notification
    showConflictToast(conflictMeta?.label || conflictId, combo);
  }

  // Apply the new binding
  _pendingBindings[actionId] = combo;

  stopRecording();
}

function showConflictToast(conflictLabel, combo) {
  const existing = document.querySelector('.kb-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'kb-toast';
  toast.textContent = `Swapped "${conflictLabel}" — was also bound to ${comboToDisplay(combo)}`;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('kb-toast-visible'));
  setTimeout(() => {
    toast.classList.remove('kb-toast-visible');
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

export function openKeybindsModal() {
  if (_modalOpen) return;
  _modalOpen = true;
  _pendingBindings = { ..._bindings };

  const overlay = document.createElement('div');
  overlay.id = 'keybinds-overlay';

  const modal = document.createElement('div');
  modal.id = 'keybinds-modal';
  modal.className = 'glass';

  modal.innerHTML = `
    <div class="settings-panel-header drag-handle">
      <h3>Keyboard Shortcuts</h3>
      <button class="settings-panel-close kb-close">&times;</button>
    </div>
    <div class="kb-hint">Click any key badge to rebind it. Press <kbd>Esc</kbd> to cancel recording.</div>
    <div class="kb-body">${renderModal()}</div>
    <div class="kb-footer">
      <button class="action-btn action-btn--ghost kb-reset-btn">Reset to Defaults</button>
      <div class="kb-footer-right">
        <button class="action-btn action-btn--danger kb-unbind-btn">Unbind</button>
        <button class="action-btn action-btn--primary kb-save-btn">Save</button>
      </div>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Animate in
  requestAnimationFrame(() => overlay.classList.add('open'));

  // Wire events
  modal.querySelector('.kb-close').addEventListener('click', closeKeybindsModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeKeybindsModal();
  });

  // Key button clicks → start recording
  modal.querySelectorAll('.kb-key-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const actionId = btn.dataset.action;
      startRecording(actionId);
    });
  });

  // Reset to defaults
  modal.querySelector('.kb-reset-btn').addEventListener('click', () => {
    _pendingBindings = { ...DEFAULT_KEYBINDS };
    modal.querySelector('.kb-body').innerHTML = renderModal();
    // Re-wire key buttons
    modal.querySelectorAll('.kb-key-btn').forEach(btn => {
      btn.addEventListener('click', () => startRecording(btn.dataset.action));
    });
  });

  // Unbind — removes binding for the currently recording action
  modal.querySelector('.kb-unbind-btn').addEventListener('click', () => {
    if (_recording) {
      const { actionId } = _recording;
      _pendingBindings[actionId] = null;
      stopRecording();
    }
  });

  // Save
  modal.querySelector('.kb-save-btn').addEventListener('click', async () => {
    stopRecording();
    _bindings = { ..._pendingBindings };
    _reverseMap = buildReverseMap(_bindings);
    try {
      await saveKeybindsToServer({ _version: 1, bindings: _bindings });
    } catch (err) {
      console.error('Failed to save keybinds:', err);
    }
    syncKeybindLabels();
    closeKeybindsModal();
  });

  // Escape key inside modal (when not recording)
  const modalEscHandler = (e) => {
    if (e.key === 'Escape' && !_recording) {
      closeKeybindsModal();
      document.removeEventListener('keydown', modalEscHandler);
    }
  };
  document.addEventListener('keydown', modalEscHandler);
}

export function closeKeybindsModal() {
  stopRecording();
  _modalOpen = false;
  _pendingBindings = null;

  const overlay = document.getElementById('keybinds-overlay');
  if (overlay) {
    overlay.classList.remove('open');
    setTimeout(() => overlay.remove(), 200);
  }
}

// ── Init ──

export async function initKeybinds() {
  // Load server-side overrides
  try {
    const data = await fetchKeybinds();
    if (data && data.bindings) {
      _bindings = { ...DEFAULT_KEYBINDS, ...data.bindings };
    } else {
      _bindings = { ...DEFAULT_KEYBINDS };
    }
  } catch {
    _bindings = { ...DEFAULT_KEYBINDS };
  }

  _reverseMap = buildReverseMap(_bindings);

  // Register the "open keybinds modal" action
  registerAction('open-keybinds', openKeybindsModal);

  // Install single global keydown listener
  document.addEventListener('keydown', centralKeyHandler);

  // Wire toolbar button
  const btn = document.getElementById('topright-keybinds-btn');
  if (btn) btn.addEventListener('click', openKeybindsModal);

  // Populate [data-keybind-for] shortcut labels in menus/dropdowns
  syncKeybindLabels();
}

/** Update all [data-keybind-for="actionId"] elements with current keybinds. */
function syncKeybindLabels() {
  document.querySelectorAll('[data-keybind-for]').forEach(el => {
    const actionId = el.dataset.keybindFor;
    const combo = _bindings[actionId];
    el.textContent = combo ? comboToDisplay(combo) : '';
  });
}
