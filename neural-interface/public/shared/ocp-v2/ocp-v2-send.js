// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — Compose box (textarea + Send/Abort) — multi-instance
// Each mountCompose(rootEl, store) creates an independent compose instance
// bound to its own DOM and store. Returns { unmount, focus, appendPath,
// sendTextMessage }. Legacy named exports route to the primary (first-mounted)
// instance for back-compat with shared bindings.
// ─────────────────────────────────────────────────────────────────────────────

import { api } from './ocp-v2-ws.js';
import { getDefaultStore, agentForMode } from './ocp-v2-state.js';
import { mountModelPicker } from './ocp-v2-modelpicker.js';
import { mountVariantPicker } from './ocp-v2-variantpicker.js';
import { mountSlashHints } from './ocp-v2-slash-hints.js';
import { storage } from '../storage.js';
import { emit } from '../state.js';
import {
  configurePlanLifecycle, beginPlanTurnForSend, maybeFinalizePlanTurn,
  isPostPlanBlocked,
} from './ocp-v2-plan.js';

const STOR_MODE = 'opencode-v2-mode';

let _primaryInstance = null;            // first compose mounted; legacy targets

export function mountCompose(rootEl, store = getDefaultStore()) {
  const storedMode = storage.getItem(STOR_MODE);
  if (storedMode) store.setMode(storedMode);
  configurePlanLifecycle({
    sendTextMessage: (text, opts) => sendTextMessage(text, opts),
    store,
  });

  let _root = rootEl;
  let _input = null;
  let _btn = null;
  let _imageStrip = null;
  let _pathStrip = null;
  let _modeButtons = [];
  let _modelPicker = null;
  let _variantPicker = null;
  let _slashHints = null;
  let _suppressAbortErrorUntil = 0;
  let _suppressAbortErrorCount = 0;

  _root.innerHTML = '';
  _root.className = 'ocpv2-compose';

  // Image strip — chips for whiteboard-attached images (rendered above input)
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

  const inner = document.createElement('div');
  inner.className = 'ocpv2-input-inner';

  _input = document.createElement('textarea');
  _input.className = 'ocpv2-compose-input';
  _input.placeholder = 'Send a message…';
  _input.rows = 1;
  _input.setAttribute('autocomplete', 'off');
  _input.setAttribute('spellcheck', 'false');
  _input.addEventListener('keydown', onKeyDown);
  _input.addEventListener('input', autosize);
  inner.appendChild(_input);

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
    onTuiSelect: (cmd) => {
      // TUI-only OpenCode builtins (/sessions, /models, /themes, …) don't
      // exist on the v2 server's prompt API. Launch the OpenCode CLI in the
      // Terminal panel and auto-type the slash so the TUI handles it.
      const cwd = store.getState().cwd || undefined;
      emit('terminal:open-with-command', {
        profile: 'opencode',
        cwd,
        command: '/' + cmd.name,
      });
    },
  });

  const toolbar = document.createElement('div');
  toolbar.className = 'ocpv2-footer-toolbar';
  toolbar.innerHTML =
    '<div class="ocpv2-footer-left">'
    + '<a class="ocpv2-brand-link" href="https://opencode.ai" target="_blank" rel="noopener noreferrer" data-tooltip="OpenCode">'
    + '<svg class="ocpv2-brand" viewBox="0 0 240 300" fill="currentColor" width="14" height="14"><path fill-rule="evenodd" d="M0 0h240v300H0V0zm30 30v240h180V30H30z"/><rect x="30" y="150" width="180" height="120" opacity=".45"/></svg>'
    + '</a>'
    + '<div class="ocpv2-mode-toggle" role="group" aria-label="OpenCode mode">'
    + '<button class="ocpv2-mode-btn" type="button" data-mode="build">Build</button>'
    + '<button class="ocpv2-mode-btn" type="button" data-mode="plan">Plan</button>'
    + '</div>'
    + '</div>'
    + '<div class="ocpv2-footer-right"></div>';
  _root.appendChild(toolbar);

  _modeButtons = Array.from(toolbar.querySelectorAll('.ocpv2-mode-btn'));
  for (const btn of _modeButtons) {
    btn.addEventListener('click', () => setComposeMode(btn.dataset.mode));
  }

  const footerRight = toolbar.querySelector('.ocpv2-footer-right');
  if (footerRight) {
    _variantPicker = mountVariantPicker(footerRight, store);
    _modelPicker = mountModelPicker(footerRight, store);
  }

  const unsubscribe = store.subscribe((event) => {
    if (event?.type === 'attachments:set') renderImageStrip();
    if (event?.type === 'paths:set') renderPathStrip();
    if (event?.type === 'config:mode' || event?.type === 'running:set') syncModeToggle();
    syncButton();
  });
  renderImageStrip();
  renderPathStrip();
  syncModeToggle();
  syncButton();

  function renderImageStrip() {
    if (!_imageStrip) return;
    const { attachedImages = [] } = store.getState();
    _imageStrip.innerHTML = '';
    _imageStrip.hidden = attachedImages.length === 0;
    attachedImages.forEach((img, idx) => {
      const chip = document.createElement('div');
      chip.className = 'ocpv2-image-chip';
      const imgEl = document.createElement('img');
      imgEl.src = img.dataUrl || '';
      imgEl.alt = img.name || `Image ${idx + 1}`;
      const removeBtn = document.createElement('button');
      removeBtn.className = 'ocpv2-image-chip-remove';
      removeBtn.type = 'button';
      removeBtn.textContent = '×';
      removeBtn.setAttribute('data-tooltip', 'Remove');
      removeBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        store.removeAttachedImage(idx);
      });
      chip.appendChild(imgEl);
      chip.appendChild(removeBtn);
      _imageStrip.appendChild(chip);
    });
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

  function appendPath(path) {
    const added = store.addPendingPath(path);
    _input?.focus();
    syncButton();
    return added;
  }

  function onKeyDown(e) {
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSendOrAbort();
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
      _btn.classList.remove('ocpv2-compose-abort');
      _btn.setAttribute('data-tooltip', s.showPostPlanActions ? 'Choose a plan action' : 'Send');
      const hasText = !!_input?.value?.trim();
      const hasImages = (s.attachedImages?.length || 0) > 0;
      const hasPaths = (s.pendingPaths?.length || 0) > 0;
      _btn.disabled = !!s.showPostPlanActions || (!hasText && !hasImages && !hasPaths);
    }
  }

  function syncModeToggle() {
    const s = store.getState();
    for (const btn of _modeButtons) {
      const active = btn.dataset.mode === s.mode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.disabled = !!s.running;
    }
    if (_input) {
      _input.placeholder = s.mode === 'plan' ? 'Ask OpenCode to plan…' : 'Send a message…';
    }
  }

  function setComposeMode(mode) {
    const s = store.getState();
    if (s.running) return;
    const next = mode === 'plan' ? 'plan' : 'build';
    store.setMode(next);
    storage.setItem(STOR_MODE, next);
  }

  async function onSendOrAbort() {
    const s = store.getState();
    if (s.running) return doAbort();
    return doSend();
  }

  async function doSend() {
    const text = _input.value.trim();
    const s = store.getState();
    const hasImages = (s.attachedImages?.length || 0) > 0;
    const hasPaths = (s.pendingPaths?.length || 0) > 0;
    if (!text && !hasImages && !hasPaths) return;

    if (!s.sessionId || isPostPlanBlocked(store)) {
      return sendTextMessage(text, { allowEmptyText: hasImages || hasPaths });
    }

    _input.value = '';
    autosize();
    const sent = await sendTextMessage(text, { allowEmptyText: hasImages || hasPaths });
    if (!sent && text && _input && !_input.value) {
      _input.value = text;
      autosize();
      syncButton();
    }
    return sent;
  }

  async function sendTextMessage(text, options = {}) {
    text = String(text || '').trim();
    const s = store.getState();
    if (!options.ignorePostPlanBlock && isPostPlanBlocked(store)) {
      store.pushError({ message: 'Choose Continue, Continue planning, Compact, or Edit before sending another prompt.' });
      return false;
    }
    const images = Array.isArray(s.attachedImages) ? [...s.attachedImages] : [];
    const paths = Array.isArray(s.pendingPaths) ? [...s.pendingPaths].filter(Boolean) : [];
    if (!text && !images.length && !paths.length && !options.allowEmptyText) return false;
    if (images.length) store.clearAttachedImages();
    if (paths.length) store.clearPendingPaths();
    if (!s.sessionId) {
      store.pushError({ message: 'No session. Reopen the panel to retry.' });
      if (images.length) for (const img of images) store.addAttachedImage(img);
      if (paths.length) for (const path of paths) store.addPendingPath(path);
      return false;
    }

    const finalText = paths.length
      ? `${text}${text ? '\n\n' : ''}Referenced files:\n${paths.map((path) => `- ${path}`).join('\n')}`
      : text;
    const mode = options.mode || s.mode || 'build';
    const isPlanTurn = mode === 'plan';
    const outgoingAgent = agentForMode(mode);

    if (options.abortFirst) {
      _suppressAbortErrorUntil = Date.now() + 15000;
      _suppressAbortErrorCount += 1;
      try {
        await api.abort(s.sessionId);
      } catch (err) {
        console.warn('[ocp-v2-send] abort before send failed', err);
      }
    }

    if (isPlanTurn) beginPlanTurnForSend(store);

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

    store.setRunning(true);

    let optimisticDropped = false;
    const existingMessageIds = new Set(s.messageOrder || []);
    const sendStartedAt = Date.now();
    const removeOptimistic = () => {
      if (optimisticDropped) return;
      store.removeMessage(optimisticId);
      optimisticDropped = true;
    };
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
        const list = await api.sessionMessages(s.sessionId);
        const items = list?.data || [];
        replaceOptimisticIfServerHasOutgoing(items);
        for (const { info, parts } of items) {
          if (!info?.id) continue;
          store.upsertMessage(info);
          for (const part of (parts || [])) store.upsertPart(part);
        }
      } catch {} finally {
        polling = false;
      }
    };
    // SSE events (message.updated / message.part.updated) drive the UI live —
    // this poller is purely a safety net for events the WS stream dropped.
    // The previous 250ms warm-up drain ran BEFORE the server could have any
    // new state to return, so it just spent a roundtrip hitting an empty
    // delta. Let the interval below pick it up on its first tick instead.
    const pollHandle = setInterval(drainOnce, 1000);

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

    try {
      const res = await api.send({
        sessionId: s.sessionId,
        parts: sendParts,
        model: s.model || undefined,
        agent: outgoingAgent,
        mode,
        variant: s.variant || undefined,
        cwd: options.cwd || s.cwd || undefined,
      });
      if (res?.error) {
        clearInterval(pollHandle);
        if (shouldSuppressAbortError(res.error)) {
          removeOptimistic();
          if (images.length) for (const img of images) store.addAttachedImage(img);
          if (paths.length) for (const path of paths) store.addPendingPath(path);
          return false;
        }
        removeOptimistic();
        store.pushError({ message: res.error });
        if (images.length) for (const img of images) store.addAttachedImage(img);
        if (paths.length) for (const path of paths) store.addPendingPath(path);
        if (isPlanTurn) store.clearPlanState({ preserveMode: true });
        store.setRunning(false);
        return false;
      }
      if (res?.async) {
        waitForAsyncTurn({ pollHandle, drainOnce, isPlanTurn }).catch((err) => {
          clearInterval(pollHandle);
          store.pushError({ message: err?.message || 'Async turn tracking failed' });
          store.setRunning(false);
        });
        return true;
      }
      clearInterval(pollHandle);
      if (res?.data?.info) {
        store.upsertMessage(res.data.info);
        for (const part of (res.data.parts || [])) store.upsertPart(part);
      }
      try {
        const list = await api.sessionMessages(s.sessionId);
        const items = list?.data || [];
        if (items.length) {
          replaceOptimisticIfServerHasOutgoing(items);
          for (const { info, parts } of items) {
            if (!info?.id) continue;
            store.upsertMessage(info);
            for (const part of (parts || [])) store.upsertPart(part);
          }
        }
      } catch (err) {
        console.warn('[ocp-v2-send] sessionMessages refresh failed', err);
      }
      if (isPlanTurn) {
        await maybeFinalizePlanTurn('send:complete', store);
      }
      store.setRunning(false);
      return true;
    } catch (err) {
      clearInterval(pollHandle);
      if (shouldSuppressAbortError(err)) {
        removeOptimistic();
        if (images.length) for (const img of images) store.addAttachedImage(img);
        if (paths.length) for (const path of paths) store.addPendingPath(path);
        return false;
      }
      removeOptimistic();
      store.pushError({ message: err?.message || 'Send failed' });
      if (images.length) for (const img of images) store.addAttachedImage(img);
      if (paths.length) for (const path of paths) store.addPendingPath(path);
      if (isPlanTurn) store.clearPlanState({ preserveMode: true });
      store.setRunning(false);
      return false;
    }
  }

  async function waitForAsyncTurn({ pollHandle, drainOnce, isPlanTurn }) {
    let done = false;
    let cleanup = null;
    let timer = null;

    await new Promise((resolve) => {
      cleanup = async () => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        clearInterval(pollHandle);
        if (unsubInner) unsubInner();
        await drainOnce(true);
        if (isPlanTurn) await maybeFinalizePlanTurn('async:idle', store);
        resolve();
      };
      const unsubInner = store.subscribe((event, state) => {
        if (event?.type === 'running:set' && !state.running) cleanup();
      });
      timer = setTimeout(() => {
        store.pushError({ message: 'OpenCode turn timed out waiting for session.idle.' });
        store.setRunning(false);
        cleanup();
      }, 30 * 60 * 1000);
      if (!store.getState().running) cleanup();
    });
  }

  async function doAbort() {
    const s = store.getState();
    if (!s.sessionId) return;
    _suppressAbortErrorUntil = Date.now() + 15000;
    _suppressAbortErrorCount += 1;
    try {
      await api.abort(s.sessionId);
    } catch (err) {
      console.warn('[ocp-v2-send] abort failed', err);
    } finally {
      if (s.planTurnActive) store.clearPlanState({ preserveMode: true });
      store.setRunning(false);
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
      try { unsubscribe(); } catch {}
      if (_modelPicker) { try { _modelPicker.destroy(); } catch {} }
      if (_variantPicker) { try { _variantPicker.destroy(); } catch {} }
      if (_slashHints) { try { _slashHints.destroy(); } catch {} }
      _root = null; _input = null; _btn = null;
      _imageStrip = null; _pathStrip = null;
      _modeButtons = []; _modelPicker = null; _variantPicker = null; _slashHints = null;
      if (_primaryInstance === instance) _primaryInstance = null;
    },
    focus,
    appendPath,
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
