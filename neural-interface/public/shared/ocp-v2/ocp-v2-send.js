// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — Compose box (textarea + Send/Abort) — multi-instance
// Each mountCompose(rootEl, store) creates an independent compose instance
// bound to its own DOM and store. Returns { unmount, focus, appendPath,
// sendTextMessage }. Legacy named exports route to the primary (first-mounted)
// instance for back-compat with shared bindings.
// ─────────────────────────────────────────────────────────────────────────────

import { api, supports, capabilities, onEvent } from './ocp-v2-ws.js';
import { getDefaultStore, agentForMode } from './ocp-v2-state.js';
import { mountModelPicker } from './ocp-v2-modelpicker.js';
import { mountVariantPicker } from './ocp-v2-variantpicker.js';
import { mountSlashHints, getSlashCatalog, loadSlashCatalog } from './ocp-v2-slash-hints.js';
import { mountMentionHints } from './ocp-v2-mention-hints.js';
import { replyFailed, replyError } from './ocp-v2-caps.js';
import { fetchProvidersFull } from './ocp-v2-providers.js';
import {
  resolveSlash, shellKey, shellAfterProgrammaticInput, shellRunAllowed,
  createPromptQueue, queueCanDrain, createPromptHistory, historyKeyApplies, escapeStop,
  createAgentCatalog, createAgentChoice, resolveAgent, nextAgent, modeForAgent, agentLabel,
  pathFileParts, attachmentVerdict, modelCapabilitiesOf, mentionFileParts, commandFileParts,
  mentionGroups, createKeyedCache, createParkedPrompts, parkedPromptsNotice, parkingFullNotice,
  keptPromptNotice, keptPromptDraft, helpCardView,
} from './ocp-v2-composer-logic.js';
import { storage } from '../storage.js';
import { emit } from '../state.js';
import {
  configurePlanLifecycle, beginPlanTurnForSend, maybeFinalizePlanTurn,
  isPostPlanBlocked,
} from './ocp-v2-plan.js';
import {
  trackOptimisticMessage, beginTurn, currentTurn, endTurn, settleFailedSend, TRANSCRIPT_SAFETY_POLL_MS,
} from './ocp-v2-send-logic.js';
import { hydrateTranscript } from './ocp-v2-rehydrate.js';
import { captureBinding, trackBinding, isBindingToken, searchOnBinding } from './ocp-v2-binding.js';

const STOR_MODE = 'opencode-v2-mode';   // the last agent picked (build / plan / a custom one)
const STOR_HISTORY = 'ocp-v2-prompt-history';

let _primaryInstance = null;            // first compose mounted; legacy targets

// ── Shared lookups (one fetch for every compose on the page) ────────────────
// Agents per project directory. The composer mounts before OpenCode is up, so
// an empty answer is not kept: it is asked again once the server is ready.
const _agentCatalog = createAgentCatalog(async (cwd) => {
  if (supports('agent:list')) {
    const res = await api.agentList({ cwd: cwd || undefined });
    return replyFailed(res) ? [] : res.data;
  }
  // A server that predates agent:list answers for its own directory only.
  const res = await fetch('/api/opencode/agents').then((r) => r.json());
  return res?.data;
});

// What the @ picker lists besides files and symbols. Both are whole lists that
// change rarely, so they are read once per session + directory and filtered
// in the picker while the user types.
const dataOrEmpty = (res) => (replyFailed(res) || !Array.isArray(res.data) ? [] : res.data);
const splitKey = (key) => { const at = key.indexOf('|'); return { sessionId: key.slice(0, at) || undefined, cwd: key.slice(at + 1) || undefined }; };
const _mcpResources = createKeyedCache(async (key) => dataOrEmpty(await api.resourceList(splitKey(key))));
const _references = createKeyedCache(async (key) => dataOrEmpty(await api.referenceList(splitKey(key))));
// A server was added, connected or dropped, or the references changed: ask again.
onEvent((eventType) => {
  if (eventType === 'mcp.tools.changed') _mcpResources.clear();
  else if (eventType === 'reference.updated') _references.clear();
});

let _providersPromise = null;
function loadProviders() {
  if (!_providersPromise) {
    _providersPromise = fetchProvidersFull()
      .then((res) => { const data = res?.data || {}; return data.all || data.providers || []; })
      .catch(() => { _providersPromise = null; return []; });
  }
  return _providersPromise;
}
if (typeof document !== 'undefined') {
  document.addEventListener('ocp-providers-changed', () => { _providersPromise = null; });
}

function loadStoredHistory() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(STOR_HISTORY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

// A File as a data URL announced with `mime` (a text file must say text/plain
// for OpenCode to read it as text, whatever the browser guessed).
function readFileAsDataUrl(file, mime) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Could not read the file'));
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma < 0 ? result : `data:${mime};base64,${result.slice(comma + 1)}`);
    };
    reader.readAsDataURL(file);
  });
}

export function mountCompose(rootEl, store = getDefaultStore(), opts = {}) {
  // The model/variant pickers are module-level singletons (see ocp-v2-modelpicker
  // / ocp-v2-variantpicker): each mount removes the previously-mounted dropdown
  // from the DOM. The main panel mounts first; if a child/sub-agent panel then
  // mounts its own compose it would steal those dropdowns and leave the main
  // footer empty. Child composes therefore opt out of pickers — sub-agents
  // inherit the parent session's model, so they don't need their own selectors.
  const mountPickers = opts.pickers !== false;
  const storedAgent = storage.getItem(STOR_MODE);
  if (storedAgent) store.setAgent(storedAgent);
  // What this composer registers, it removes when it is unmounted (a sub-agent
  // panel that is closed): the plan lifecycle would go on visiting its store
  // and calling its sender.
  const releasePlanLifecycle = configurePlanLifecycle({
    sendTextMessage: (text, opts) => sendTextMessage(text, opts),
    store,
  });

  let _root = rootEl;
  let _input = null;
  let _btn = null;
  let _imageStrip = null;
  let _pathStrip = null;
  let _modeButtons = [];
  let _modeToggle = null;
  let _modelPicker = null;
  let _variantPicker = null;
  let _slashHints = null;
  let _mentionHints = null;
  let _queueTray = null;
  let _wrap = null;
  let _fileInput = null;
  // The agents on offer and whether the selected one may stay. The list
  // belongs to a project directory: see createAgentChoice.
  const _agentChoice = createAgentChoice();
  let _lastServerStatus = store.getState().serverStatus;
  // The directory this composer's session runs in (a sub-agent panel has no
  // cwd of its own; its session knows the directory).
  const composerCwd = () => { const s = store.getState(); return s.cwd || s.sessionInfo?.directory || ''; };
  let _composerCwd = composerCwd();
  let _shell = false;                    // shell mode: see shellKey() for the only way in
  let _shellTypedValue = '';             // what the user's own input events put in the box while in shell mode
  let _escArmedAt = 0;
  let _draining = false;
  const _queue = createPromptQueue();
  // Prompts and commands that left the queue or the box and that OpenCode has
  // not accepted yet. Until it has, each is still this composer's: a sub-agent
  // panel counts them as unsent before it closes (`sending()`), and when the
  // composer is unmounted while one is out and its send then fails, the
  // prompt goes to `opts.onUndelivered`, whole, instead of into a box, a strip
  // or a queue nobody will see again.
  const _outgoing = new Set();
  let _unmounted = false;
  const undeliverable = () => _unmounted && typeof opts.onUndelivered === 'function';
  const handUndelivered = (item, error = '') => {
    try { opts.onUndelivered(item, { error }); } catch (err) { console.warn('[ocp-v2-send] handing over an undelivered prompt failed', err); }
  };
  // What a turn of this composer keeps running (its transcript poll, the wait
  // for its end): stopped when the composer is unmounted.
  const _turnWatches = new Set();
  // Nothing the user queued or sent is lost when the panel moves. What a
  // session's composer still owes it waits here for that session: its queue
  // as it was when the panel left, and prompts or commands that failed to go
  // out after it had left. `_queueNote` says why they are back in the tray;
  // `_queueBack` is what the note counts.
  // Nothing is evicted from the parking: every entry is unsent prompts. Its
  // bound is kept at the one place where refusing loses nothing (onEnter).
  // Nothing is parked for a session that has no tab (opts.hasTab, from the
  // panel): what fails for one is kept for the user instead (keepPrompts).
  const _parked = createParkedPrompts({ hasTab: opts.hasTab });
  let _queueNote = '';
  let _queueBack = null;
  // The session this composer's queue belongs to (the store's, as of the last
  // rebinding this composer handled).
  let _queueSessionId = store.getState().sessionId || null;
  // Everything below that outlives an await captures the store's binding
  // first and checks it afterwards: see ocp-v2-binding.js.
  const _rebind = trackBinding(store);
  const _history = createPromptHistory(loadStoredHistory());
  const _pickedMentions = new Map();     // token → item chosen from the @ picker (see mentionGroups)
  let _suppressAbortErrorUntil = 0;
  let _suppressAbortErrorCount = 0;

  _root.innerHTML = '';
  _root.className = 'ocpv2-compose';

  // Prompts typed while a turn runs wait here (client-side queue).
  _queueTray = document.createElement('div');
  _queueTray.className = 'ocpv2-queue-tray';
  _queueTray.hidden = true;
  _root.appendChild(_queueTray);

  // Attachment strip — images, PDFs and text files (rendered above input)
  _imageStrip = document.createElement('div');
  _imageStrip.className = 'ocpv2-image-strip';
  _imageStrip.hidden = true;
  _root.appendChild(_imageStrip);

  _pathStrip = document.createElement('div');
  _pathStrip.className = 'ocpv2-path-strip';
  _pathStrip.hidden = true;
  _root.appendChild(_pathStrip);

  const area = document.createElement('div');
  area.className = 'ocpv2-input-area';

  const wrap = document.createElement('div');
  wrap.className = 'ocpv2-input-wrap';
  _wrap = wrap;

  const inner = document.createElement('div');
  inner.className = 'ocpv2-input-inner';

  _input = document.createElement('textarea');
  _input.className = 'ocpv2-compose-input';
  _input.placeholder = 'Send a message…';
  _input.rows = 1;
  _input.setAttribute('autocomplete', 'off');
  _input.setAttribute('spellcheck', 'false');
  _input.addEventListener('keydown', onKeyDown);
  _input.addEventListener('input', onInput);
  _input.addEventListener('paste', onPaste);
  inner.appendChild(_input);
  _root.addEventListener('dragover', onDragOver);
  _root.addEventListener('drop', onDrop);

  _btn = document.createElement('button');
  _btn.className = 'ocpv2-compose-btn';
  _btn.type = 'button';
  _btn.setAttribute('data-tooltip', 'Send');
  _btn.innerHTML =
    '<span class="ocpv2-send-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg></span>'
    + '<span class="ocpv2-stop-icon"><svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg></span>';
  _btn.addEventListener('click', onSendOrAbort);
  inner.appendChild(_btn);

  wrap.appendChild(inner);
  area.appendChild(wrap);
  _root.appendChild(area);

  // Slash-command picker. Anchored to .ocpv2-input-area (which is set to
  // position:relative in CSS) so it floats above the textarea via
  // bottom:100%. Mounting on .ocpv2-input-wrap won't work — that element has
  // overflow:hidden for the rotating border mask and would clip the picker.
  _slashHints = mountSlashHints(area, _input, {
    onTuiSelect: (cmd) => openInTui(cmd.name),
    // A panel action picked from the menu runs at once.
    onLocalSelect: (cmd) => { runLocalSlash({ action: cmd.action, name: cmd.name, args: '' }); },
    isAvailable: () => !_shell,
    getCwd: composerCwd,
  });
  _mentionHints = mountMentionHints(area, _input, {
    search: searchMentions,
    isAvailable: () => mentionSourcesAvailable() && !_shell,
    onPick: (item) => { _pickedMentions.set(item.token, item); },
  });
  loadSlashCatalog(_composerCwd);

  const toolbar = document.createElement('div');
  toolbar.className = 'ocpv2-footer-toolbar';
  toolbar.innerHTML =
    '<div class="ocpv2-footer-left">'
    + '<a class="ocpv2-brand-link" href="https://opencode.ai" target="_blank" rel="noopener noreferrer" data-tooltip="OpenCode">'
    + '<svg class="ocpv2-brand" viewBox="0 0 240 300" fill="currentColor" width="14" height="14"><path fill-rule="evenodd" d="M0 0h240v300H0V0zm30 30v240h180V30H30z"/><rect x="30" y="150" width="180" height="120" opacity=".45"/></svg>'
    + '</a>'
    + '<button class="ocpv2-attach-btn" type="button" data-tooltip="Attach images, PDFs or text files" aria-label="Attach files">'
    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>'
    + '</button>'
    + '<div class="ocpv2-mode-toggle" role="group" aria-label="OpenCode agent"></div>'
    + '</div>'
    + '<div class="ocpv2-footer-right"></div>';
  _root.appendChild(toolbar);

  _modeToggle = toolbar.querySelector('.ocpv2-mode-toggle');
  renderAgentButtons();
  refreshAgents();

  _fileInput = document.createElement('input');
  _fileInput.type = 'file';
  _fileInput.multiple = true;
  _fileInput.hidden = true;
  _fileInput.addEventListener('change', () => {
    addFiles(_fileInput.files);
    _fileInput.value = '';
  });
  _root.appendChild(_fileInput);
  toolbar.querySelector('.ocpv2-attach-btn')?.addEventListener('click', () => _fileInput?.click());

  const footerRight = toolbar.querySelector('.ocpv2-footer-right');
  if (footerRight && mountPickers) {
    _variantPicker = mountVariantPicker(footerRight, store);
    _modelPicker = mountModelPicker(footerRight, store);
  }

  const unsubscribe = store.subscribe((event, state) => {
    // First of all: the panel was bound to another session. What belonged to
    // the binding it left goes before anything below looks at the new one.
    if (_rebind.changed()) onRebound(state);
    if (event?.type === 'attachments:set') renderImageStrip();
    if (event?.type === 'paths:set') renderPathStrip();
    if (event?.type === 'config:mode' || event?.type === 'config:agent' || event?.type === 'running:set') syncModeToggle();
    // An agent set from outside (a session's last agent) must be one the toggle offers.
    if (event?.type === 'config:agent') validateAgent();
    // The project directory decides the commands and the agents on offer.
    if (event?.type === 'config:cwd' || event?.type === 'session:set' || event?.type === 'session:info') {
      const cwd = composerCwd();
      if (cwd !== _composerCwd) {
        _composerCwd = cwd;
        loadSlashCatalog(cwd);
        // The agent list on hand is the previous project's. Nothing is checked
        // against it: the toggle takes this directory's list when it is
        // already known, else the built-ins until it arrives.
        _agentChoice.enter(cwd, _agentCatalog.get(cwd));
        renderAgentButtons();
        validateAgent();
        refreshAgents();
        // What the @ picker shows, or is still searching, is the old directory's.
        _mentionHints?.hide();
      }
    }
    // OpenCode came up (cold start) or came back: the list asked for at mount
    // was empty or may be stale.
    if (event?.type === 'server:status') {
      const became = state.serverStatus === 'ready' && _lastServerStatus !== 'ready';
      _lastServerStatus = state.serverStatus;
      if (became) refreshAgents({ force: true });
    }
    // A turn that ended in an error is not a clean finish: hold the queue.
    // (A notice is not an error of the turn.)
    if (event?.type === 'error:push' && !state.errors[state.errors.length - 1]?.notice) _queue.pause();
    syncButton();
    scheduleDrain();
  });
  const unsubscribeQueue = _queue.subscribe(() => {
    if (!_queue.isPaused() || !_queue.size()) { _queueNote = ''; _queueBack = null; }
    renderQueueTray();
    scheduleDrain();
  });

  // The store moved to another session (a new one, a switch, a project change,
  // or back to one it was on before). Shell mode, the agent the fallback
  // replaced and whatever the @ picker shows or is still searching belong to
  // the binding that was left. So does the queue: it is parked for the session
  // it was typed in, and what is parked for the session the panel is on now
  // comes back, paused. (The draft itself, text, attachments and the mentions
  // already picked in it, is the panel's and stays, as it always did.)
  function onRebound(state) {
    const left = _queueSessionId;
    _queueSessionId = state.sessionId || null;
    _agentChoice.forget();
    // (A queue typed into a session after it was lost has nobody to wait
    // for: `leave` keeps nothing for it, and its prompts are kept on notices.)
    if (left) tellIfLost(left, _queue.list());
    if (left) _parked.leave(left, _queue.list());
    // The session the panel is on exists, whatever was forgotten about it
    // before (a tab that was archived and opened again).
    if (_queueSessionId) _parked.reopen(_queueSessionId);
    _queue.clear();
    // A queued prompt of the session that was left may still be on its way
    // (a turn can take minutes). That is not this binding's drain: its queue
    // must not wait for it.
    _draining = false;
    setShellMode(false);
    _mentionHints?.hide();
    restoreParkedHere();
  }

  // What is parked for the session on screen goes into its queue, at the
  // front and paused. Called on every rebinding, and after every failure that
  // was parked: the panel may already be back on that session (A → B → A),
  // and then the prompt must not wait, unseen, for the next rebinding.
  function restoreParkedHere() {
    const sessionId = store.getState().sessionId;
    if (!sessionId || !_parked.has(sessionId)) return false;
    const parked = _parked.take(sessionId);
    if (!parked || !_queue.restore(parked.items)) return false;
    _queueBack = {
      items: [...(_queueBack?.items || []), ...parked.items],
      failed: (_queueBack?.failed || 0) + parked.failed,
      queued: (_queueBack?.queued || 0) + parked.queued,
      errors: [...new Set([...(_queueBack?.errors || []), ...parked.errors])],
    };
    _queueNote = parkedPromptsNotice(_queueBack);
    renderQueueTray();
    return true;
  }

  // A prompt or a command of `sessionId` that could not go out after the
  // panel had left that session.
  function parkFailed(sessionId, item, error = '') {
    if (!sessionId) return false;
    if (!_parked.park(sessionId, { item, error })) { tellIfLost(sessionId, item); return false; }
    restoreParkedHere();
    return true;
  }

  // A prompt that failed for a session that is gone has nobody to go back
  // to. When the user closed that tab, that was their decision (they were
  // asked about what was waiting). When the session was lost (deleted
  // elsewhere, dropped by OpenCode, or without a tab and nothing remembers
  // why), the prompt is kept for the user.
  function tellIfLost(sessionId, item) {
    const items = (Array.isArray(item) ? item : [item]).filter(Boolean);
    if (!items.length || _parked.goneAs(sessionId) !== 'lost') return;
    keepPrompts(items, sessionLabel(sessionId));
  }

  function sessionLabel(sessionId) {
    const title = store.getState().knownSessions?.get?.(sessionId)?.title;
    return (typeof title === 'string' && title.trim()) || String(sessionId || '').slice(0, 8);
  }

  // Prompts that have no session to go to any more and that nobody was asked
  // about. Each is kept whole on a notice of its own (a notice stays until
  // the user deals with it: no switch, recovery or other error removes it),
  // with the two things that can be done with it.
  function keepPrompts(items, label) {
    for (const item of items) {
      const kept = keptOf(item);
      store.pushError({
        message: keptPromptNotice({ item: kept, label }),
        notice: true,
        kept,
        actions: [
          { label: 'Put back', run: (err) => { if (putBackKept(kept)) store.dismissError(err.id); } },
          { label: 'Discard', run: (err) => store.dismissError(err.id) },
        ],
      });
    }
  }

  // A prompt as it is kept: whole, and nothing but the prompt.
  function keptOf(item) {
    const kept = {
      text: String(item.text || ''),
      images: Array.isArray(item.images) ? [...item.images] : [],
      paths: Array.isArray(item.paths) ? [...item.paths] : [],
      mentions: Array.isArray(item.mentions) ? [...item.mentions] : [],
    };
    if (item.command?.command) kept.command = { command: String(item.command.command), args: String(item.command.args || '') };
    return kept;
  }

  // A kept prompt goes into the draft of the session on screen, for the user
  // to send: its text under what is being typed, its attachments and paths
  // in the strips, its mentions picked again (keptPromptDraft). A command
  // comes back as the line that was typed. False when there is no box to put
  // it in: the notice then keeps it.
  function putBackKept(kept) {
    if (!_input) return false;
    const back = keptPromptDraft(kept, _input.value);
    // Text placed by code is a prompt, never a shell command.
    setShellMode(shellAfterProgrammaticInput());
    _input.value = back.text;
    for (const img of back.images) store.addAttachedImage(img, { restore: true });
    for (const path of back.paths) store.addPendingPath(path);
    // (A mention picked meanwhile under the same token stays.)
    for (const mention of back.mentions) { if (!_pickedMentions.has(mention.token)) _pickedMentions.set(mention.token, mention); }
    if (back.lost.length) {
      store.pushError({ message: `Put back without ${back.lost.join(', ')}: pick ${back.lost.length === 1 ? 'it' : 'them'} again with @.`, notice: true });
    }
    autosize();
    syncButton();
    _input.focus();
    return true;
  }
  const unsubscribeCaps = capabilities.subscribe(() => {
    syncModeToggle();
    // agent:list (per directory) may have become available, or gone.
    refreshAgents({ force: true });
  });
  renderImageStrip();
  renderPathStrip();
  renderQueueTray();
  syncModeToggle();
  syncButton();

  function renderImageStrip() {
    if (!_imageStrip) return;
    const { attachedImages = [] } = store.getState();
    _imageStrip.innerHTML = '';
    _imageStrip.hidden = attachedImages.length === 0;
    attachedImages.forEach((img, idx) => {
      const isImage = String(img.mime || '').startsWith('image/');
      const chip = document.createElement('div');
      chip.className = isImage ? 'ocpv2-image-chip' : 'ocpv2-path-chip';
      const removeBtn = document.createElement('button');
      removeBtn.className = isImage ? 'ocpv2-image-chip-remove' : 'ocpv2-path-chip-remove';
      removeBtn.type = 'button';
      removeBtn.textContent = '×';
      removeBtn.setAttribute('data-tooltip', 'Remove');
      removeBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        store.removeAttachedImage(idx);
      });
      if (isImage) {
        const imgEl = document.createElement('img');
        imgEl.src = img.dataUrl || '';
        imgEl.alt = img.name || `Image ${idx + 1}`;
        chip.appendChild(imgEl);
      } else {
        // A PDF or a text file: a name chip.
        chip.title = img.name || 'file';
        const label = document.createElement('span');
        label.className = 'ocpv2-path-chip-name';
        label.textContent = img.name || 'file';
        chip.appendChild(label);
      }
      chip.appendChild(removeBtn);
      _imageStrip.appendChild(chip);
    });
  }

  // ── @ mentions ────────────────────────────────────────────────────────────
  // Each source is asked only when the server answers its request type.
  const MENTION_SOURCES = ['find:files', 'find:symbols', 'resource:list', 'reference:list'];
  function mentionSourcesAvailable() { return MENTION_SOURCES.some((type) => supports(type)); }

  // Resolves the groups for `query`, or null when the panel moved to another
  // session or directory while the search was out: those rows are another
  // project's and are never offered (the picker ignores a null answer).
  const searchMentionSources = searchOnBinding(store, composerCwd, async (query, { sessionId, cwd }) => {
    const key = `${sessionId || ''}|${cwd}`;
    const [files, symbols, resources, references] = await Promise.all([
      supports('find:files') ? api.findFiles({ query, cwd: cwd || undefined }).then(dataOrEmpty, () => []) : [],
      // The language servers want something to search for.
      supports('find:symbols') && query.trim().length >= 2
        ? api.findSymbols({ sessionId, query, cwd: cwd || undefined }).then(dataOrEmpty, () => [])
        : [],
      supports('resource:list') ? _mcpResources.get(key) : [],
      supports('reference:list') ? _references.get(key) : [],
    ]);
    return mentionGroups({ query, cwd, files, symbols, resources, references });
  });
  function searchMentions(query) { return searchMentionSources(query); }

  // ── Attachments: paste, drop, picker ──────────────────────────────────────
  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    // Attachments are the draft's, and the draft is the panel's, not a
    // session's: a file is checked against the model that is selected when it
    // is actually added, so the state is read after the wait on purpose.
    const providers = await loadProviders();
    const capabilities = modelCapabilitiesOf(providers, store.getState().model);
    for (const file of files) {
      const verdict = attachmentVerdict(file, capabilities, { count: store.getState().attachedImages.length });
      if (!verdict.ok) { store.pushError({ message: verdict.reason }); continue; }
      const mime = verdict.kind === 'image' ? (file.type || 'image/png')
        : verdict.kind === 'pdf' ? 'application/pdf'
        : 'text/plain';
      try {
        const dataUrl = await readFileAsDataUrl(file, mime);
        store.addAttachedImage({ name: file.name || `attachment-${Date.now()}`, mime, dataUrl });
      } catch (err) {
        store.pushError({ message: err?.message || `Could not read ${file.name || 'the file'}` });
      }
    }
    _input?.focus();
  }

  function onPaste(event) {
    const files = Array.from(event.clipboardData?.files || []);
    if (!files.length) return;          // plain text: the browser pastes it
    event.preventDefault();
    addFiles(files);
  }

  function onDragOver(event) {
    if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault();
  }

  function onDrop(event) {
    const files = Array.from(event.dataTransfer?.files || []);
    if (!files.length) return;
    event.preventDefault();
    addFiles(files);
  }

  // ── Queue tray ────────────────────────────────────────────────────────────
  function renderQueueTray() {
    if (!_queueTray) return;
    const items = _queue.list();
    _queueTray.innerHTML = '';
    _queueTray.hidden = items.length === 0;
    if (!items.length) return;
    const head = document.createElement('div');
    head.className = 'ocpv2-queue-head';
    const title = document.createElement('span');
    title.textContent = _queue.isPaused()
      ? `Queue paused · ${items.length} waiting`
      : `Queued · ${items.length} ${items.length === 1 ? 'prompt goes' : 'prompts go'} out when this turn ends`;
    // Prompts that came back because they could not be delivered say so.
    if (_queueNote && _queue.isPaused()) title.title = _queueNote;
    head.appendChild(title);
    if (_queue.isPaused()) {
      const resume = document.createElement('button');
      resume.type = 'button';
      resume.className = 'ocpv2-queue-action';
      resume.textContent = 'Resume';
      resume.addEventListener('click', () => _queue.resume());
      head.appendChild(resume);
    }
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'ocpv2-queue-action';
    clear.textContent = 'Clear';
    clear.addEventListener('click', () => _queue.clear());
    head.appendChild(clear);
    _queueTray.appendChild(head);
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'ocpv2-queue-item';
      const text = document.createElement('span');
      text.className = 'ocpv2-queue-text';
      const extras = item.images.length + item.paths.length;
      text.textContent = (item.text || '(attachments)') + (extras ? `  +${extras}` : '');
      text.title = item.text;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'ocpv2-queue-action';
      remove.textContent = '×';
      remove.setAttribute('data-tooltip', 'Remove');
      remove.addEventListener('click', () => _queue.remove(item.id));
      row.append(text, remove);
      _queueTray.appendChild(row);
    }
  }

  let _drainTimer = null;
  function scheduleDrain() {
    if (_drainTimer || _draining) return;
    if (!queueCanDrain(_queue, store.getState())) return;
    // A beat after the turn ends, so its last events (plan card, question) land first.
    _drainTimer = setTimeout(() => { _drainTimer = null; drainQueue(); }, 300);
  }

  async function drainQueue() {
    if (_draining || !queueCanDrain(_queue, store.getState())) return;
    const item = _queue.shift();
    if (!item) return;
    _draining = true;
    // The queue this prompt came out of is this binding's. A failure that
    // comes back after the panel moved must not put it into the next
    // session's queue: sendTextMessage parks it for its own session instead.
    const at = captureBinding(store);
    try {
      // A command that came back from the parking runs as that command again;
      // everything else in the queue is a prompt.
      const sent = item.command
        ? (await runCommandFor(item)).ran
        : await sendTextMessage(item.text, {
          images: item.images, paths: item.paths, mentions: item.mentions, allowEmptyText: true, binding: at,
        });
      // (Not into the queue of a composer that is gone: sendTextMessage and
      // runCommandFor handed the prompt over.)
      if (!sent && at.isCurrent() && !undeliverable()) { _queue.unshift(item); _queue.pause(); }
    } finally {
      // The flag (and the next drain) are this binding's only while the panel
      // is still on it: onRebound already released it otherwise.
      if (at.isCurrent()) {
        _draining = false;
        scheduleDrain();
      }
    }
  }

  // ── Shell mode ────────────────────────────────────────────────────────────
  function setShellMode(on) {
    const next = !!on;
    if (_shell === next) return;
    _shell = next;
    _shellTypedValue = '';
    _wrap?.classList.toggle('ocpv2-shell-mode', _shell);
    if (_shell) { _slashHints?.hide(); _mentionHints?.hide(); }
    syncModeToggle();
    syncButton();
  }

  function basenamePath(path) {
    const text = String(path || '');
    return text.split(/[\\/]/).filter(Boolean).pop() || text;
  }

  function renderPathStrip() {
    if (!_pathStrip) return;
    const { pendingPaths = [] } = store.getState();
    _pathStrip.innerHTML = '';
    _pathStrip.hidden = pendingPaths.length === 0;
    pendingPaths.forEach((path, idx) => {
      const chip = document.createElement('div');
      chip.className = 'ocpv2-path-chip';
      chip.title = path;

      const icon = document.createElement('span');
      icon.className = 'ocpv2-path-chip-icon';
      icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';

      const label = document.createElement('span');
      label.className = 'ocpv2-path-chip-name';
      label.textContent = basenamePath(path);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'ocpv2-path-chip-remove';
      removeBtn.type = 'button';
      removeBtn.textContent = 'x';
      removeBtn.setAttribute('data-tooltip', 'Remove');
      removeBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        store.removePendingPath(idx);
      });

      chip.append(icon, label, removeBtn);
      _pathStrip.appendChild(chip);
    });
  }

  function focus() { _input?.focus(); }

  // Put a draft into the box (undo hands the reverted prompt back). A draft
  // the user is already typing is never overwritten.
  function setText(text, { replace = false } = {}) {
    if (!_input) return false;
    // Text placed by code is a prompt, never a shell command.
    setShellMode(shellAfterProgrammaticInput());
    if (_input.value.trim() && !replace) return false;
    _input.value = String(text || '');
    autosize();
    syncButton();
    _input.focus();
    return true;
  }

  function appendPath(path) {
    setShellMode(shellAfterProgrammaticInput());
    const added = store.addPendingPath(path);
    _input?.focus();
    syncButton();
    return added;
  }

  function onInput(event) {
    // An input event nobody typed (openOpencodeWithPrompt, a handoff) carries
    // text written by code: it must not sit in a composer armed for the shell.
    if (!event?.isTrusted) setShellMode(shellAfterProgrammaticInput());
    else {
      _history.reset();
      if (_shell) _shellTypedValue = _input.value;
    }
    autosize();
  }

  function onKeyDown(e) {
    if (_mentionHints?.isOpen()) {
      if (e.key === 'ArrowDown') { e.preventDefault(); _mentionHints.navigate(1); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); _mentionHints.navigate(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (e.key === 'Enter' && e.shiftKey) return;
        e.preventDefault();
        _mentionHints.applySelected();
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); _mentionHints.hide(); return; }
    }
    if (_slashHints?.isOpen()) {
      if (e.key === 'ArrowDown') { e.preventDefault(); _slashHints.navigate(1); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); _slashHints.navigate(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (e.key === 'Enter' && e.shiftKey) return; // shift+enter = newline
        e.preventDefault();
        _slashHints.applySelected();
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); _slashHints.hide(); return; }
    }

    // Shell mode: "!" typed on an empty composer, and nothing else, enters it.
    const shell = shellKey({
      shell: _shell, value: _input.value, key: e.key, trusted: e.isTrusted,
      composing: e.isComposing, supported: supports('session:shell'),
    });
    if (shell.shell !== _shell) setShellMode(shell.shell);
    if (shell.preventDefault) { e.preventDefault(); return; }

    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && !_shell
      && historyKeyApplies({
        key: e.key, value: _input.value, selectionStart: _input.selectionStart, selectionEnd: _input.selectionEnd,
        browsing: _history.browsing(),
      })) {
      const recalled = e.key === 'ArrowUp' ? _history.prev(_input.value) : _history.next();
      if (recalled != null) {
        e.preventDefault();
        _input.value = recalled;
        autosize();
        syncButton();
        try { _input.setSelectionRange(recalled.length, recalled.length); } catch {}
      }
      return;
    }

    if (e.key === 'Escape') {
      // Two presses stop a running turn; one is too easy to hit by accident.
      const result = escapeStop(_escArmedAt, Date.now(), !!store.getState().running);
      _escArmedAt = result.armedAt;
      if (result.stop) { e.preventDefault(); doAbort(); }
      else if (result.armedAt) {
        e.preventDefault();
        _btn?.setAttribute('data-tooltip', 'Press Esc again to stop');
      }
      return;
    }

    // Shift+Tab steps through the agents (the TUI's Tab).
    if (e.key === 'Tab' && e.shiftKey && !store.getState().running && !_shell) {
      e.preventDefault();
      setComposeAgent(nextAgent(store.getState().agent, _agentChoice.agents()));
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      onEnter();
    }
  }

  function autosize() {
    if (!_input) return;
    _input.style.height = 'auto';
    _input.style.height = `${Math.min(_input.scrollHeight, 160)}px`;
  }

  function syncButton() {
    if (!_btn) return;
    const s = store.getState();
    if (s.running) {
      _btn.classList.add('ocpv2-compose-abort');
      _btn.setAttribute('data-tooltip', 'Stop');
      _btn.disabled = false;
    } else {
      _escArmedAt = 0;
      _btn.classList.remove('ocpv2-compose-abort');
      const hasText = !!_input?.value?.trim();
      const hasImages = (s.attachedImages?.length || 0) > 0;
      const hasPaths = (s.pendingPaths?.length || 0) > 0;
      if (_shell) {
        _btn.setAttribute('data-tooltip', 'Run shell command');
        _btn.disabled = !hasText;
      } else {
        _btn.setAttribute('data-tooltip', s.showPostPlanActions ? 'Choose a plan action' : 'Send');
        _btn.disabled = !!s.showPostPlanActions || (!hasText && !hasImages && !hasPaths);
      }
    }
  }

  // An agent that was stored, or that the session last ran with, but that
  // OpenCode does not offer here falls back to build. Only the server's list
  // for the directory this composer is in decides: never the built-in
  // fallback, never the previous project's list. An agent the fallback
  // replaced comes back when this directory's list offers it after all.
  function validateAgent() {
    const current = store.getState().agent;
    const next = _agentChoice.settle(current, composerCwd());
    if (next && next !== current) store.setAgent(next);
  }

  async function refreshAgents({ force = false } = {}) {
    const cwd = composerCwd();
    const agents = await _agentCatalog.load(cwd, { force });
    // Unmounted, nothing to show yet, or the composer moved to another project.
    if (!_root || !_agentChoice.accept(cwd, agents, composerCwd())) return;
    validateAgent();
    renderAgentButtons();
  }

  function renderAgentButtons() {
    if (!_modeToggle) return;
    _modeToggle.innerHTML = '';
    _modeButtons = _agentChoice.agents().map((agent) => {
      const btn = document.createElement('button');
      btn.className = 'ocpv2-mode-btn';
      btn.type = 'button';
      btn.dataset.agent = agent.name;
      btn.textContent = agentLabel(agent.name);
      if (agent.description) btn.setAttribute('data-tooltip', agent.description.slice(0, 160));
      btn.addEventListener('click', () => setComposeAgent(agent.name));
      _modeToggle.appendChild(btn);
      return btn;
    });
    syncModeToggle();
  }

  function syncModeToggle() {
    const s = store.getState();
    for (const btn of _modeButtons) {
      const active = btn.dataset.agent === s.agent;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.disabled = !!s.running;
    }
    if (_input) {
      _input.placeholder = _shell
        ? 'Shell command…  (Esc to leave shell mode)'
        : s.mode === 'plan' ? 'Ask OpenCode to plan…'
        : supports('session:shell') ? 'Send a message…  ( / commands · @ files · ! shell )'
        : 'Send a message…';
    }
  }

  function setComposeAgent(agent) {
    const s = store.getState();
    if (s.running) return;
    const next = resolveAgent(agent, _agentChoice.agents());
    // The user's own pick: nothing replaced earlier is put back over it.
    _agentChoice.forget();
    store.setAgent(next);
    storage.setItem(STOR_MODE, next);
  }

  // Enter: send; while a turn runs, queue what was typed (the button stops).
  async function onEnter() {
    const s = store.getState();
    if (!s.running) return doSend();
    if (_shell) {
      store.pushError({ message: 'Wait for the current turn to finish before running a shell command.' });
      return false;
    }
    const text = _input.value.trim();
    const images = Array.isArray(s.attachedImages) ? [...s.attachedImages] : [];
    const paths = Array.isArray(s.pendingPaths) ? [...s.pendingPaths].filter(Boolean) : [];
    if (!text && !images.length && !paths.length) return false;
    const slash = resolveSlash(text, getSlashCatalog(composerCwd()));
    if (slash?.kind === 'local' || slash?.kind === 'tui') return doSend();
    if (slash?.kind === 'command') {
      store.pushError({ message: 'Wait for the current turn to finish before running a command.' });
      return false;
    }
    const mentions = mentionFileParts(text, _pickedMentions, s.cwd || s.sessionInfo?.directory || '');
    // One more session with prompts waiting than the parking takes: this
    // queue is not started. Nothing is taken from the box or the strips, and
    // nothing that is already waiting somewhere is dropped to make room.
    if (!_queue.size() && _parked.isFull()) {
      store.pushError({ message: parkingFullNotice() });
      return false;
    }
    if (!_queue.add({ text, images, paths, mentions })) {
      store.pushError({ message: 'The queue is full. Wait for a turn to finish or clear it.' });
      return false;
    }
    rememberPrompt(text);
    _pickedMentions.clear();
    if (images.length) store.clearAttachedImages();
    if (paths.length) store.clearPendingPaths();
    clearInput();
    return true;
  }

  function clearInput() {
    if (!_input) return;
    _input.value = '';
    autosize();
    syncButton();
  }

  function rememberPrompt(text) {
    if (!text) return;
    _history.push(text);
    try { sessionStorage.setItem(STOR_HISTORY, JSON.stringify(_history.entries())); } catch {}
  }

  function openInTui(name) {
    // TUI-only OpenCode builtins (/themes, /login, …) have no server API.
    // Launch the OpenCode CLI in the Terminal panel and type the slash there.
    emit('terminal:open-with-command', {
      profile: 'opencode',
      cwd: store.getState().cwd || undefined,
      command: '/' + name,
    });
  }

  // A panel action behind a slash command. Session-level ones come from the
  // panel (opts.slashActions); a sub-agent panel has none of those.
  async function runLocalSlash(slash) {
    const s = store.getState();
    // A failure is reported in the session the command was typed in.
    const typedAt = captureBinding(store);
    try {
      switch (slash.action) {
        case 'compact': {
          if (!s.sessionId) return;
          if (s.running) { store.pushError({ message: 'Wait for the current turn to finish before compacting.' }); return; }
          const at = captureBinding(store);
          const res = await api.compact({
            sessionId: at.sessionId, cwd: at.cwd || undefined, mcpProfile: at.mcpProfile || undefined, model: at.model || undefined,
          });
          // A failure of the session the panel has left is not this one's banner.
          if (at.isCurrent() && (res?.error || res?.ok === false)) store.pushError({ message: res?.error || 'Compact failed' });
          return;
        }
        case 'models':
          document.getElementById('ocpv2-model-dd')?.click();
          return;
        case 'agents':
          setComposeAgent(nextAgent(s.agent, _agentChoice.agents()));
          return;
        case 'help':
          // A card at the end of the transcript, from the catalog the slash
          // menu lists. Nothing is sent, and the box is left as it is.
          store.setHelpCard?.(helpCardView({
            catalog: getSlashCatalog(composerCwd()), supports, canAct: !s.parentSessionId,
          }));
          return;
        default: {
          const action = opts.slashActions?.[slash.action];
          if (typeof action !== 'function') {
            store.pushError({ message: `/${slash.name} is not available in this panel.` });
            return;
          }
          await action(slash.args);
        }
      }
    } catch (err) {
      if (typedAt.isCurrent()) store.pushError({ message: err?.message || `/${slash.name} failed` });
    }
  }

  // session.command / session.shell: both occupy the session like a prompt.
  // `outcome` (optional) is filled with `error`: what went wrong, also when no
  // banner is shown for it because the panel has moved.
  async function runServerTurn(label, request, outcome = {}) {
    // getState() hands out the live state, so `s.sessionId` read after an
    // await is wherever the panel is by then. The turn belongs to the binding
    // captured here: the request, the callbacks and the end of the turn all
    // read this snapshot.
    const turn = captureBinding(store);
    if (!turn.sessionId) { store.pushError({ message: 'No session. Reopen the panel to retry.' }); return false; }
    if (opts.canSend && opts.canSend(turn) === false) {
      store.pushError({ message: 'Stop the running automation before sending a manual turn.' });
      return false;
    }
    try { opts.onBeforeSend?.(turn); } catch {}
    // The turn this command is: what ends `running` afterwards ends it only
    // while no newer turn began on this binding (ocp-v2-send-logic.js).
    const run = beginTurn(store, turn);
    try {
      const res = await request(turn);
      if (replyFailed(res)) {
        outcome.error = replyError(res, `${label} failed`);
        if (!shouldSuppressAbortError(res.error || '') && turn.isCurrent()) store.pushError({ message: outcome.error });
        return false;
      }
      // The session's transcript, for the session it was run in: nothing is
      // applied when the panel moved to another one meanwhile.
      const refreshed = await hydrateTranscript(store, api, { sessionId: turn.sessionId, isCurrent: turn.isCurrent, syncRunning: false });
      if (refreshed.error) console.warn('[ocp-v2-send] transcript refresh failed', refreshed.error);
      return true;
    } catch (err) {
      outcome.error = err?.message || `${label} failed`;
      if (!shouldSuppressAbortError(err) && turn.isCurrent()) store.pushError({ message: outcome.error });
      return false;
    } finally {
      endTurn(store, run);
    }
  }

  // A command turn carries the same file parts a prompt does: what is
  // attached, the referenced paths and the @ mentions.
  function runCommand(slash, attached, outcome) {
    const parts = commandFileParts(attached);
    return runServerTurn(`/${slash.command}`, (turn) => api.commandRun({
      sessionId: turn.sessionId,
      command: slash.command,
      arguments: slash.args,
      agent: turn.agent || undefined,
      model: turn.model || undefined,
      variant: turn.variant || undefined,
      parts: parts.length ? parts : undefined,
      cwd: turn.cwd || undefined,
      mcpProfile: turn.mcpProfile || undefined,
    }), outcome);
  }

  // A slash command with what it took from the draft: `item` is `{ text,
  // images, paths, mentions, command: { command, args } }`. Resolves `{ ran,
  // here }`. A command that failed while the panel was still on its session
  // is the caller's to put back (`here`). One that failed after the panel had
  // moved is parked for its session, whole: it comes back in that session's
  // queue, paused, and runs as the same command when the user resumes.
  async function runCommandFor(item) {
    // On its way until OpenCode answers, which for a command is when its turn is over.
    _outgoing.add(item);
    let out;
    try { out = await runCommandOn(item); } finally { _outgoing.delete(item); }
    // The composer is gone (its sub-agent panel went while the command was
    // out): there is no box and no queue to put it back into.
    if (!out.ran && out.here && undeliverable()) { handUndelivered(item, out.error); return { ran: false, here: false }; }
    return { ran: out.ran, here: out.here };
  }

  async function runCommandOn(item) {
    const at = captureBinding(store);
    const outcome = {};
    const ran = await runCommand(item.command, item, outcome);
    const here = at.isCurrent();
    if (!ran && !here) parkFailed(at.sessionId, item, outcome.error);
    return { ran, here, error: outcome.error };
  }

  // Reached only from doSend() while the composer is in shell mode.
  function runShell(command) {
    return runServerTurn('Shell command', (turn) => api.sessionShell({
      sessionId: turn.sessionId,
      command,
      agent: turn.agent || undefined,
      model: turn.model || undefined,
      cwd: turn.cwd || undefined,
      mcpProfile: turn.mcpProfile || undefined,
    }));
  }

  // The button: Stop while a turn runs, Send otherwise.
  async function onSendOrAbort() {
    const s = store.getState();
    if (s.running) return doAbort();
    return doSend();
  }

  // What the user typed and sent. This is the only path that interprets the
  // text (shell mode, slash commands, @ mentions); sendTextMessage(), which
  // handoffs, automations and the plan lifecycle call, always sends a prompt.
  async function doSend() {
    const text = _input.value.trim();
    const s = store.getState();
    const images = Array.isArray(s.attachedImages) ? [...s.attachedImages] : [];
    const hasImages = images.length > 0;
    const hasPaths = (s.pendingPaths?.length || 0) > 0;

    if (_shell) {
      // Only what the user typed (or pasted) into the shell-mode composer runs.
      // Anything that got into the box another way drops back to a prompt.
      const allowed = shellRunAllowed({ shell: _shell, value: _input.value, typedValue: _shellTypedValue });
      setShellMode(false);
      if (allowed) {
        rememberPrompt(text);
        clearInput();
        return runShell(text);
      }
    }
    if (!text && !hasImages && !hasPaths) return;

    const slash = resolveSlash(text, getSlashCatalog(composerCwd()));
    if (slash) {
      rememberPrompt(text);
      clearInput();
      if (slash.kind === 'local') return runLocalSlash(slash);
      if (slash.kind === 'tui') return openInTui(slash.command);
      // The draft's attachments go with the command; they come back if it fails.
      const paths = Array.isArray(s.pendingPaths) ? [...s.pendingPaths].filter(Boolean) : [];
      const picked = new Map(_pickedMentions);
      const mentions = mentionFileParts(text, _pickedMentions, s.cwd || s.sessionInfo?.directory || '');
      if (hasImages) store.clearAttachedImages();
      if (paths.length) store.clearPendingPaths();
      _pickedMentions.clear();
      // What the command took from the draft comes back into the draft it was
      // taken from. After a move the composer is another session's: the
      // command is parked, with everything it took, for its own (runCommandFor).
      const { ran, here } = await runCommandFor({
        text, images, paths, mentions, command: { command: slash.command, args: slash.args },
      });
      if (!ran && here) {
        for (const img of images) store.addAttachedImage(img, { restore: true });
        for (const path of paths) store.addPendingPath(path);
        for (const [token, item] of picked) { if (!_pickedMentions.has(token)) _pickedMentions.set(token, item); }
        if (_input && !_input.value) { _input.value = text; autosize(); syncButton(); }
      }
      return ran;
    }

    const mentions = mentionFileParts(text, _pickedMentions, s.cwd || s.sessionInfo?.directory || '');
    if (!s.sessionId || isPostPlanBlocked(store)) {
      return sendTextMessage(text, { allowEmptyText: hasImages || hasPaths, mentions });
    }

    rememberPrompt(text);
    // Sending by hand takes a held queue up again, as it always did. Not one
    // that came back from the parking: those prompts (or that command) wait
    // for the user's own Resume, whatever else is sent in the meantime.
    if (!_queueBack) _queue.resume();
    clearInput();
    // The mentions picked for this prompt (a symbol's range, an MCP resource)
    // leave the draft with it, and come back with it if it fails.
    const picked = new Map(_pickedMentions);
    _pickedMentions.clear();
    // A send that fails after the panel moved does not put its text into the
    // box of the session on screen: sendTextMessage parks the prompt for the
    // session it was written for.
    const at = captureBinding(store);
    const sent = await sendTextMessage(text, { allowEmptyText: hasImages || hasPaths, mentions, binding: at });
    if (!sent && at.isCurrent() && !undeliverable()) {
      // Without them the restored text would go out again with its @ tokens
      // as plain text. (A mention picked meanwhile under the same token stays.)
      for (const [token, item] of picked) { if (!_pickedMentions.has(token)) _pickedMentions.set(token, item); }
      if (text && _input && !_input.value) {
        _input.value = text;
        autosize();
        syncButton();
      }
    }
    return sent;
  }

  async function sendTextMessage(text, options = {}) {
    text = String(text || '').trim();
    // The action this send is the last step of (Retry, a queued prompt) was
    // started on a binding the panel has left: its prompt is not sent into the
    // session on screen.
    if (isBindingToken(options.binding) && !options.binding.isCurrent()) return false;
    // The binding this prompt belongs to, with the model, agent and directory
    // it goes out with. `s` is the live state and is only read before the
    // first await; everything after it reads `turn`.
    const turn = captureBinding(store);
    const s = store.getState();
    if (opts.canSend && opts.canSend(turn) === false) {
      store.pushError({ message: 'Stop the running automation before sending a manual turn.' });
      return false;
    }
    if (!options.ignorePostPlanBlock && isPostPlanBlocked(store)) {
      store.pushError({ message: 'Choose Continue, Continue planning, Compact, or Edit before sending another prompt.' });
      return false;
    }
    // A queued prompt carries the attachments it was typed with; anything
    // else takes what is in the strips now.
    const ownAttachments = Array.isArray(options.images) || Array.isArray(options.paths);
    const images = ownAttachments ? [...(options.images || [])] : (Array.isArray(s.attachedImages) ? [...s.attachedImages] : []);
    const paths = ownAttachments ? [...(options.paths || [])].filter(Boolean) : (Array.isArray(s.pendingPaths) ? [...s.pendingPaths].filter(Boolean) : []);
    if (!text && !images.length && !paths.length && !options.allowEmptyText) return false;
    if (!ownAttachments) {
      if (images.length) store.clearAttachedImages();
      if (paths.length) store.clearPendingPaths();
    }
    // A send that fails puts its attachments back in the strips; a queued
    // prompt keeps its own (it goes back to the front of the queue).
    const restoreAttachments = () => {
      if (ownAttachments) return;
      for (const img of images) store.addAttachedImage(img, { restore: true });
      for (const path of paths) store.addPendingPath(path);
    };
    if (!s.sessionId) {
      store.pushError({ message: 'No session. Reopen the panel to retry.' });
      restoreAttachments();
      return false;
    }
    // The session this prompt goes to. `s` is the live state: after an await
    // `s.sessionId` is wherever the panel is by then, which may be another tab.
    const turnSessionId = turn.sessionId;
    try { opts.onBeforeSend?.(turn); } catch {}

    // Referenced paths and @ mentions go out as file parts: OpenCode reads
    // them itself (a file, a directory listing, an image).
    const finalText = text;
    const pathParts = [...pathFileParts(paths), ...(Array.isArray(options.mentions) ? options.mentions : [])];
    // An explicit mode (the plan lifecycle) means build or plan; otherwise the
    // agent picked in the toggle, which may be a custom one.
    const outgoingAgent = options.mode ? agentForMode(options.mode) : (s.agent || agentForMode(s.mode));
    const mode = modeForAgent(outgoingAgent);
    const isPlanTurn = mode === 'plan';
    const sendMeta = {
      prompt: text,
      paths,
      hasImages: images.length > 0,
      mode,
      agent: outgoingAgent,
    };
    // The callbacks get the snapshot of the session the prompt went to, in
    // every phase: its bookkeeping is that session's, wherever the panel is.
    const notifyManualSend = (phase) => {
      try { opts.onManualSend?.(turn, phase, sendMeta); } catch (err) {
        console.warn('[ocp-v2-send] onManualSend callback failed', err);
      }
    };
    // This prompt as a queue item, for the parking (see settleFailedSend).
    const promptItem = { text, images, paths, mentions: Array.isArray(options.mentions) ? options.mentions : [] };
    // On its way from here on, and this composer's until OpenCode has it: the
    // reply to the send, or OpenCode's own copy of the prompt in the transcript.
    _outgoing.add(promptItem);
    const leaveOutgoing = () => _outgoing.delete(promptItem);

    if (options.abortFirst) {
      _suppressAbortErrorUntil = Date.now() + 15000;
      _suppressAbortErrorCount += 1;
      try {
        await api.abort(turnSessionId);
      } catch (err) {
        console.warn('[ocp-v2-send] abort before send failed', err);
      }
      // The panel moved while the old turn was being stopped: nothing has been
      // sent yet, and nothing is drawn in the session on screen. The prompt
      // waits for its own session.
      if (!turn.isCurrent()) {
        leaveOutgoing();
        if (settleFailedSend(turn, _parked, { item: promptItem }).parked) restoreParkedHere();
        else tellIfLost(turn.sessionId, promptItem);
        return false;
      }
    }

    // The plan turn this prompt starts (0 for any other turn): its finalizer
    // and its failure act on that plan turn and on no later one.
    const planTurn = isPlanTurn ? beginPlanTurnForSend(store) : 0;

    const optimisticId = `local-user-${Date.now()}`;
    store.upsertMessage({ id: optimisticId, role: 'user' });
    let partIdx = 0;
    if (finalText) {
      store.upsertPart({
        id: `${optimisticId}-text`,
        messageID: optimisticId,
        type: 'text',
        text: finalText,
        index: partIdx++,
      });
    }
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      store.upsertPart({
        id: `${optimisticId}-file-${i}`,
        messageID: optimisticId,
        type: 'file',
        mime: img.mime,
        filename: img.name,
        url: img.dataUrl,
        index: partIdx++,
      });
    }
    pathParts.forEach((part, i) => {
      store.upsertPart({ ...part, id: `${optimisticId}-path-${i}`, messageID: optimisticId, index: partIdx++ });
    });

    // `turn` is the binding: the transcript, a banner and the strips are the
    // session's. `run` is this turn on that binding: `running` and the plan
    // turn are cleared through it, and only while no newer turn began.
    const run = beginTurn(store, turn);

    let optimisticDropped = false;
    const existingMessageIds = new Set(s.messageOrder || []);
    const sendStartedAt = Date.now();
    const removeOptimistic = () => {
      if (optimisticDropped) return;
      optimisticDropped = true;
      // (OpenCode's own copy of the prompt is in the transcript, or the send failed.)
      leaveOutgoing();
      // After a move the bubble went with the transcript it was in.
      if (turn.isCurrent()) store.removeMessage(optimisticId);
    };
    // The server's copy of this prompt arrives over the socket; the local
    // bubble goes the moment that copy has something to show.
    trackOptimisticMessage(store, { optimisticId, existingMessageIds, onDrop: removeOptimistic, isCurrent: turn.isCurrent });
    const replaceOptimisticIfServerHasOutgoing = (items) => {
      if (!optimisticDropped && transcriptHasOutgoing(items, {
        finalText,
        images,
        existingMessageIds,
        sendStartedAt,
      })) {
        removeOptimistic();
      }
    };
    let polling = false;
    const drainOnce = async (force = false) => {
      if (polling && !force) return;
      while (polling && force) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      polling = true;
      try {
        // A snapshot of the session the prompt went to. Once the panel is on
        // another session it is not applied (the turn goes on without this panel).
        await hydrateTranscript(store, api, {
          sessionId: turnSessionId, isCurrent: turn.isCurrent, syncRunning: false, beforeApply: replaceOptimisticIfServerHasOutgoing,
        });
      } catch {} finally {
        polling = false;
      }
    };
    // Bus events (message.updated / message.part.updated / message.part.delta)
    // drive the transcript live. This poller only repairs an event the socket
    // dropped, so it re-reads the transcript rarely; hydrateMessages never lets
    // a snapshot roll back text that is still streaming.
    const pollHandle = setInterval(drainOnce, TRANSCRIPT_SAFETY_POLL_MS);
    const stopPolling = () => { clearInterval(pollHandle); _turnWatches.delete(stopPolling); };
    _turnWatches.add(stopPolling);

    const sendParts = [];
    if (finalText) sendParts.push({ type: 'text', text: finalText });
    for (const img of images) {
      sendParts.push({
        type: 'file',
        mime: img.mime || 'image/png',
        filename: img.name || 'attachment',
        url: img.dataUrl,
      });
    }
    sendParts.push(...pathParts);

    // The send failed. `message` is what to tell the user; none for a stop
    // they asked for. On the binding the prompt was sent from this is what it
    // always was: the bubble goes, the banner shows, the attachments return to
    // the strips. Once the panel is elsewhere none of it touches the session on
    // screen: the prompt is parked for its own session.
    const failSend = (message) => {
      notifyManualSend('failed');
      stopPolling();
      leaveOutgoing();
      // The composer is gone (its sub-agent panel went while the prompt was
      // out): there is no box, strip or queue to put it back into. It is handed
      // over whole, to be kept for the session it was written for.
      if (undeliverable()) { handUndelivered(promptItem, message); return false; }
      const settled = settleFailedSend(turn, _parked, { item: promptItem, error: message });
      if (!settled.here) {
        // Parked for its session; when the panel is already back on that
        // session it goes into the queue on screen now.
        if (settled.parked) restoreParkedHere();
        else tellIfLost(turn.sessionId, promptItem);
        return false;
      }
      removeOptimistic();
      if (message) store.pushError({ message });
      restoreAttachments();
      if (message) {
        // Only this prompt's own plan turn and run state: a newer turn of the
        // same session keeps its own.
        if (isPlanTurn && store.getState().planTurnId === planTurn) store.clearPlanState({ preserveMode: true });
        endTurn(store, run);
      }
      return false;
    };

    notifyManualSend('started');
    try {
      const res = await api.send({
        sessionId: turnSessionId,
        parts: sendParts,
        model: turn.model || undefined,
        agent: outgoingAgent,
        mode,
        variant: turn.variant || undefined,
        cwd: options.cwd || turn.cwd || undefined,
        mcpProfile: turn.mcpProfile || undefined,
      });
      if (res?.error) return failSend(shouldSuppressAbortError(res.error) ? '' : res.error);
      // Delivered: that stands, whatever the panel shows by now.
      leaveOutgoing();
      notifyManualSend('succeeded');
      if (res?.async) {
        // (A composer that was unmounted meanwhile watches no turn.)
        if (_unmounted) { stopPolling(); return true; }
        waitForAsyncTurn({ stopPolling, drainOnce, isPlanTurn, planTurn, turn, run }).catch((err) => {
          stopPolling();
          if (run.isCurrent()) store.pushError({ message: err?.message || 'Async turn tracking failed' });
          endTurn(store, run);
        });
        return true;
      }
      stopPolling();
      // The reply is this turn's: it enters the store only while the store is
      // still on the binding the prompt was sent from.
      if (res?.data?.info && turn.isCurrent()) {
        store.upsertMessage(res.data.info);
        for (const part of (res.data.parts || [])) store.upsertPart(part);
      }
      const refreshed = await hydrateTranscript(store, api, {
        sessionId: turnSessionId, isCurrent: turn.isCurrent, syncRunning: false, beforeApply: replaceOptimisticIfServerHasOutgoing,
      });
      if (refreshed.error) console.warn('[ocp-v2-send] sessionMessages refresh failed', refreshed.error);
      if (isPlanTurn && turn.isCurrent()) {
        await maybeFinalizePlanTurn('send:complete', store, { lenient: true, planTurn });
      }
      // An idle event may have let the next prompt out while the transcript
      // was read: that turn's `running` is not this one's to clear.
      endTurn(store, run);
      return true;
    } catch (err) {
      return failSend(shouldSuppressAbortError(err) ? '' : (err?.message || 'Send failed'));
    }
  }

  async function waitForAsyncTurn({ stopPolling, drainOnce, isPlanTurn, planTurn, turn, run }) {
    let done = false;
    let cleanup = null;
    let timer = null;

    await new Promise((resolve) => {
      // The composer was unmounted: nobody waits for the end of this turn any
      // more. Its poll, its timer and its subscription end here.
      const abandon = () => {
        if (done) return;
        done = true;
        _turnWatches.delete(abandon);
        if (timer) clearTimeout(timer);
        stopPolling();
        if (unsubInner) unsubInner();
        resolve();
      };
      cleanup = async () => {
        if (done) return;
        done = true;
        _turnWatches.delete(abandon);
        if (timer) clearTimeout(timer);
        stopPolling();
        if (unsubInner) unsubInner();
        await drainOnce(true);
        // The plan of this turn, on the binding it ran on; never the plan
        // turn of the session the panel moved to.
        if (isPlanTurn && turn.isCurrent()) await maybeFinalizePlanTurn('async:idle', store, { lenient: true, planTurn });
        resolve();
      };
      // The turn is over for this panel when it stops running, or when the
      // panel is bound to another session (the turn itself goes on there).
      const unsubInner = store.subscribe((event, state) => {
        if ((event?.type === 'running:set' && !state.running) || !turn.isCurrent()) cleanup();
      });
      timer = setTimeout(() => {
        if (run.isCurrent()) store.pushError({ message: 'OpenCode turn timed out waiting for session.idle.' });
        endTurn(store, run);
        cleanup();
      }, 30 * 60 * 1000);
      _turnWatches.add(abandon);
      if (!store.getState().running) cleanup();
    });
  }

  async function doAbort() {
    // `turn` is the session Stop was pressed in, and the turn that was running
    // there. The loop-stop request and the abort are for that session; what is
    // cleared afterwards is cleared only while the panel is still on that
    // binding and no newer turn began (a Stop that comes back late does not
    // end the next prompt).
    const turn = currentTurn(store, captureBinding(store));
    if (!turn.sessionId) return;
    // Stop means stop: what is queued waits for the user to resume it.
    _queue.pause();
    const clearStoppedTurn = () => {
      if (turn.isCurrent() && store.getState().planTurnActive) store.clearPlanState({ preserveMode: true });
      endTurn(store, turn);
    };
    if (opts.onAbort && await opts.onAbort(turn)) {
      clearStoppedTurn();
      return;
    }
    _suppressAbortErrorUntil = Date.now() + 15000;
    _suppressAbortErrorCount += 1;
    try {
      await api.abort(turn.sessionId);
    } catch (err) {
      console.warn('[ocp-v2-send] abort failed', err);
    } finally {
      clearStoppedTurn();
    }
  }

  function shouldSuppressAbortError(err) {
    if (_suppressAbortErrorCount <= 0) return false;
    if (Date.now() > _suppressAbortErrorUntil) return false;
    const msg = typeof err === 'string' ? err : (err?.message || err?.error || String(err || ''));
    if (!/aborted|aborterror/i.test(msg)) return false;
    _suppressAbortErrorCount -= 1;
    return true;
  }

  function transcriptHasOutgoing(items, { finalText, images, existingMessageIds, sendStartedAt }) {
    if (!Array.isArray(items) || !items.length) return false;
    for (const item of items) {
      const info = item?.info || {};
      const id = info.id || info.messageID || info.messageId;
      if (!id || existingMessageIds.has(id)) continue;
      if ((info.role || '').toLowerCase() !== 'user') continue;
      const createdMs = messageCreatedMs(info);
      if (createdMs && createdMs < sendStartedAt - 5000) continue;
      if (outgoingPartsMatch(item?.parts || [], finalText, images)) return true;
    }
    return false;
  }

  function outgoingPartsMatch(parts, finalText, images) {
    const text = String(finalText || '').trim();
    const textMatches = !text || parts.some((part) => (
      (part?.type === 'text' || part?.text != null)
      && String(part.text || '').trim() === text
    ));
    if (!textMatches) return false;
    if (!images?.length) return true;
    const fileParts = parts.filter((part) => part?.type === 'file');
    return images.every((img) => fileParts.some((part) => {
      const filename = part.filename || part.name || '';
      const mime = part.mime || part.mediaType || '';
      return (img.name && filename === img.name)
        || (img.mime && mime === img.mime)
        || (img.dataUrl && part.url === img.dataUrl);
    }));
  }

  function messageCreatedMs(info) {
    const raw = info?.time?.created ?? info?.time?.start ?? info?.createdAt ?? info?.created;
    if (raw == null) return 0;
    if (typeof raw === 'number') return raw < 1000000000000 ? raw * 1000 : raw;
    const parsed = Date.parse(String(raw));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  const instance = {
    unmount() {
      // From here on a send that fails has no box to go back to: it is handed
      // to opts.onUndelivered (the manager of a sub-agent's panel keeps it).
      _unmounted = true;
      try { unsubscribe(); } catch {}
      try { unsubscribeQueue(); } catch {}
      try { unsubscribeCaps(); } catch {}
      try { releasePlanLifecycle(); } catch {}
      for (const stop of [..._turnWatches]) { try { stop(); } catch {} }
      if (_drainTimer) { clearTimeout(_drainTimer); _drainTimer = null; }
      if (_mentionHints) { try { _mentionHints.destroy(); } catch {} }
      if (_modelPicker) { try { _modelPicker.destroy(); } catch {} }
      if (_variantPicker) { try { _variantPicker.destroy(); } catch {} }
      if (_slashHints) { try { _slashHints.destroy(); } catch {} }
      _root = null; _input = null; _btn = null;
      _imageStrip = null; _pathStrip = null;
      _modeButtons = []; _modelPicker = null; _variantPicker = null; _slashHints = null; _mentionHints = null;
      _queueTray = null; _wrap = null; _fileInput = null; _modeToggle = null;
      if (_primaryInstance === instance) _primaryInstance = null;
    },
    focus,
    appendPath,
    setText,
    // Undo hands a prompt's @ mentions back (ocp-v2-composer-logic.js,
    // draftRestorePlan): while a token stays in the text, the next send
    // rebuilds its file part, range and source included.
    restoreMentions(items) {
      for (const item of Array.isArray(items) ? items : []) {
        if (item?.token) _pickedMentions.set(item.token, item);
      }
    },
    // What is still waiting to be sent in `sessionId`: what is parked for it
    // and, when it is the session on screen, its queue. Nothing is removed:
    // the panel asks the user with this before it closes the session's tab.
    waitingFor(sessionId) {
      const waiting = _parked.peek(sessionId);
      if (sessionId && sessionId === store.getState().sessionId) waiting.push(..._queue.list());
      return waiting;
    },
    // The session's tab was closed (the user was asked first when prompts
    // were waiting), or the session is gone (deleted elsewhere, lost by
    // OpenCode): what was waiting for it cannot be delivered there. Returns
    // the prompts that left the parking and the queue.
    // `lost`: nobody closed it by hand, so nobody was asked: those prompts,
    // and one of its sends that fails later, are kept for the user on
    // notices (`label` names the session in them). A tab the user closed
    // takes them with it.
    forgetSession(sessionId, { lost = false, label = '' } = {}) {
      const dropped = _parked.forget(sessionId, { lost });
      // Still the session on screen (it was lost, not left): its queue goes
      // with it too.
      if (sessionId && sessionId === store.getState().sessionId && _queue.size()) {
        dropped.push(..._queue.list());
        _queue.clear();
      }
      if (lost) keepPrompts(dropped, label || sessionLabel(sessionId));
      return dropped;
    },
    // What the box and its strips hold and have not sent, as the prompt it
    // would be (null when there is nothing). Nothing is taken: a sub-agent
    // panel asks with it before it closes, because its box goes with it.
    draft() {
      if (!_input) return null;
      const text = _input.value.trim();
      const s = store.getState();
      const images = Array.isArray(s.attachedImages) ? [...s.attachedImages] : [];
      const paths = Array.isArray(s.pendingPaths) ? [...s.pendingPaths].filter(Boolean) : [];
      if (!text && !images.length && !paths.length) return null;
      return { text, images, paths, mentions: mentionFileParts(text, _pickedMentions, composerCwd()) };
    },
    // Prompts and commands that are on their way and that OpenCode has not
    // accepted yet: still this composer's, so a sub-agent panel lists them
    // before it closes. Nothing is taken.
    sending() {
      return [..._outgoing].map((item) => ({ ...item, sending: true }));
    },
    // A prompt that was kept for this composer's session while it had no
    // panel (its send failed after the panel had gone) is back in the box,
    // with its attachments, paths and mentions. False when there is no box.
    putBack(item) {
      return item ? putBackKept(keptOf(item)) : false;
    },
    // Prompts another panel could not keep (a sub-agent panel that went away
    // with its session, without anybody being asked): one notice each, here.
    keep(items, label = '') {
      keepPrompts((Array.isArray(items) ? items : []).filter(Boolean), label);
    },
    sendTextMessage,
  };
  if (!_primaryInstance) _primaryInstance = instance;
  return instance;
}

// ── Legacy named exports — route to primary (first-mounted) compose ───────
export function unmountCompose() { _primaryInstance?.unmount?.(); }
export function focusCompose()    { _primaryInstance?.focus?.(); }
export function appendPathToCompose(path) { return _primaryInstance?.appendPath?.(path) ?? false; }
export async function sendTextMessage(text, options = {}) {
  if (!_primaryInstance) return false;
  return _primaryInstance.sendTextMessage(text, options);
}
