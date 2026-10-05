// ═══════════════════════════════════════════
// SynaBun Assistant — composer
// ═══════════════════════════════════════════
// Enter sends, Shift+Enter inserts a newline, Esc aborts the running turn (or
// closes the slash menu). Attachments: images (paste / file picker / drop),
// text files, memory chips (drag from the graph), and any other file — the
// picker and drop upload it to the server and the prompt carries its path
// (routeAttachment). Slash menu on a leading "/".
//
// Layout (inside the bottom card): slash menu (floats above the card) ·
// queue · attachments · textarea · actions row (attach · model/effort slot ·
// send/stop) · file input. The other runtime controls live in the toolbar.

import { matchSlashCommands, SLASH_COMMANDS } from './asst-slash.js';

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'js', 'ts', 'jsx', 'tsx', 'json', 'html', 'css', 'scss', 'less', 'xml', 'svg',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'gitignore', 'dockerignore',
  'sql', 'graphql', 'proto', 'csv', 'tsv', 'log', 'diff', 'patch', 'vue', 'svelte',
  'mjs', 'cjs', 'mts', 'cts', 'astro', 'mdx', 'rst', 'tex', 'lua', 'r', 'swift', 'kt',
  'dockerfile', 'makefile', 'cmake', 'gradle', 'bat', 'ps1', 'fish',
]);
const MAX_TEXT_FILE = 400 * 1024;
const MAX_IMAGE = 8 * 1024 * 1024;
// The server's cap (lib/assistant-attachments.js ATTACHMENT_MAX_BYTES).
const MAX_UPLOAD = 100 * 1024 * 1024;
// Image data every brain's model takes; other image types are uploaded like any file.
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MEMORY_DRAG_TYPE = 'application/x-synabun-memory';
const WB_IMAGE_DRAG_TYPE = 'application/x-synabun-wb-image';

const ICON_SEND = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>';
const NARROW_COMPOSER_PX = 300; // the input's width under which the placeholder is "Ask SynaBun…"
const ICON_STOP = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/></svg>';
const ICON_ATTACH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
const ICON_MEMORY = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="8" y="5.5" width="11" height="5" rx="2.5" transform="rotate(-12 13.5 8)"/><rect x="4.5" y="12.5" width="11" height="5" rx="2.5" transform="rotate(-12 10 15)"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

function isTextFile(name) {
  const ext = String(name || '').split('.').pop()?.toLowerCase() || '';
  return TEXT_EXTENSIONS.has(ext) || !String(name || '').includes('.');
}

/** A NUL byte in the first 8 KB means binary (git's test); binary never goes inline. */
async function looksBinary(file) {
  try { return new Uint8Array(await file.slice(0, 8192).arrayBuffer()).includes(0); } catch { return true; }
}

/**
 * Where a picked or dropped file goes: 'image' (image data the model sees),
 * 'text' (inlined as <file>), 'upload' (saved on the server; the prompt gets
 * its path) or 'tooLarge' (over the upload cap). Raw binary bytes never reach a
 * prompt: in 2026-03 an inlined binary corrupted the Claude NDJSON stream.
 */
export async function routeAttachment(file, { sniff = looksBinary } = {}) {
  const size = Number(file?.size) || 0;
  const type = String(file?.type || '').toLowerCase();
  if (INLINE_IMAGE_TYPES.has(type) && size <= MAX_IMAGE) return 'image';
  if ((isTextFile(file?.name) || type.startsWith('text/')) && size <= MAX_TEXT_FILE && !(await sniff(file))) return 'text';
  return size > MAX_UPLOAD ? 'tooLarge' : 'upload';
}

export function formatBytes(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** The prompt line for an uploaded file: the same for every brain (they read it with their own file tools). */
export function attachmentPromptLine(upload) {
  const mime = upload?.mime || 'application/octet-stream';
  return `The user attached a file: ${upload?.name || 'attachment'} (${mime}, ${formatBytes(upload?.size)}), saved at \`${upload?.path}\`. Read it from that path with your file tools; include the path when a worker needs the file.`;
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * createComposer(hostEl, hooks)
 * hooks: { t, onSubmit({text, images, files, uploads, memories}) → 'sent'|'queued'|false|Promise,
 *          onAbort(), onDraftChange(text), onFocusChange(focused), resolveMemory(id) → node|null,
 *          resolveWhiteboardImage(id) → { dataUrl } | null, describeSlash(cmd) → string,
 *          uploadFile(file, { onProgress, signal }) → Promise<{ path, name, size, mime }>,
 *          onRemoveQueued(index), onToast(text) }
 * Returns { …, fillTemplate(tpl), openFilePicker(), caretPoint() }.
 */
export function createComposer(hostEl, hooks = {}) {
  const t = (key, fallback, params) => {
    const v = typeof hooks.t === 'function' ? hooks.t(key, params) : undefined;
    if (v && v !== key && typeof v === 'string') return v;
    return params ? String(fallback).replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : `{${k}}`)) : fallback;
  };

  const root = el('div', 'asst-composer');
  root.innerHTML = `
    <div class="asst-slash-menu" role="listbox" id="asst-slash-${Math.random().toString(36).slice(2, 8)}" aria-label="${esc(t('assistant.composer.commands', 'Commands'))}" hidden></div>
    <div class="asst-composer-queue" hidden></div>
    <div class="asst-composer-attachments" hidden></div>
    <textarea class="asst-input" rows="1" spellcheck="true" aria-label="${esc(t('assistant.composer.aria', 'Message the assistant'))}" aria-autocomplete="list"></textarea>
    <div class="asst-composer-actions">
      <button type="button" class="asst-tb-btn asst-attach" data-tooltip="${esc(t('assistant.composer.attach', 'Attach files'))}" aria-label="${esc(t('assistant.composer.attach', 'Attach files'))}">${ICON_ATTACH}</button>
      <div class="asst-composer-brain"></div>
      <button type="button" class="asst-send" data-state="empty" aria-label="${esc(t('assistant.composer.send', 'Send'))}">${ICON_SEND}</button>
    </div>
    <input type="file" class="asst-file-input" multiple hidden tabindex="-1">
  `;
  hostEl.appendChild(root);

  const textarea = root.querySelector('.asst-input');
  const sendBtn = root.querySelector('.asst-send');
  const attachBtn = root.querySelector('.asst-attach');
  const fileInput = root.querySelector('.asst-file-input');
  const attachmentsEl = root.querySelector('.asst-composer-attachments');
  const queueEl = root.querySelector('.asst-composer-queue');
  const slashMenu = root.querySelector('.asst-slash-menu');
  textarea.setAttribute('aria-controls', slashMenu.id);

  const state = {
    running: false,
    disabled: false,
    images: [],   // { base64, mediaType, name }
    files: [],    // { name, content }
    uploads: [],  // { name, size, mime, path, status: 'uploading'|'done', progress, controller }
    memories: [], // node objects
    slashOpen: false,
    slashIndex: 0,
    slashItems: [],
    placeholder: t('assistant.composer.placeholderAsk', 'Ask SynaBun anything — / for commands'),
    // A composer under 300px says the short form, so the placeholder never wraps to three lines.
    placeholderShort: t('assistant.composer.placeholderShort', 'Ask SynaBun…'),
    narrow: false,
  };
  const placeholderNow = () => (state.narrow ? state.placeholderShort : state.placeholder);
  textarea.placeholder = placeholderNow();

  function autoResize() {
    // CSS clamps the height (max-height: min(220px, 32cqh)) and scrolls past it.
    textarea.style.height = 'auto';
    let height = textarea.scrollHeight;
    // An empty narrow composer grows to fit a wrapped placeholder instead of clipping it.
    if (!textarea.value && textarea.placeholder) {
      textarea.value = textarea.placeholder;
      height = Math.max(height, textarea.scrollHeight);
      textarea.value = '';
    }
    textarea.style.height = `${height}px`;
  }

  function hasContent() {
    return !!(textarea.value.trim() || state.images.length || state.files.length || state.uploads.length || state.memories.length);
  }

  function uploading() {
    return state.uploads.some((u) => u.status === 'uploading');
  }

  function updateSendButton() {
    // Send waits for every upload: the prompt needs each file's saved path.
    const waiting = uploading();
    const mode = state.running ? 'stop' : (hasContent() && !state.disabled && !waiting ? 'ready' : 'empty');
    if (sendBtn.dataset.state !== mode || !sendBtn.firstChild) {
      sendBtn.innerHTML = mode === 'stop' ? ICON_STOP : ICON_SEND;
    }
    sendBtn.dataset.state = mode;
    const label = mode === 'stop' ? t('assistant.composer.abort', 'Abort (Esc)')
      : waiting ? t('assistant.composer.uploading', 'Uploading… send when it finishes')
        : t('assistant.composer.send', 'Send');
    sendBtn.setAttribute('aria-label', label);
    sendBtn.setAttribute('data-tooltip', label);
    sendBtn.disabled = mode === 'empty';
  }

  function renderAttachments() {
    const chips = [];
    state.images.forEach((img, i) => {
      chips.push(`<span class="asst-chip static" data-kind="image" data-idx="${i}"><img src="data:${esc(img.mediaType)};base64,${img.base64}" alt=""><span class="asst-chip-text">${esc(img.name || 'image')}</span><button type="button" class="asst-chip-x" aria-label="${esc(t('common.remove', 'Remove'))}">${ICON_X}</button></span>`);
    });
    state.files.forEach((f, i) => {
      chips.push(`<span class="asst-chip static" data-kind="file" data-idx="${i}"><span class="asst-chip-text">${esc(f.name)}</span><span class="asst-chip-meta">${esc(Math.ceil(f.content.length / 1024))}k</span><button type="button" class="asst-chip-x" aria-label="${esc(t('common.remove', 'Remove'))}">${ICON_X}</button></span>`);
    });
    state.uploads.forEach((u, i) => {
      const pct = Math.round((u.progress || 0) * 100);
      const meta = u.status === 'uploading' ? `${pct}%` : formatBytes(u.size);
      chips.push(`<span class="asst-chip static" data-kind="upload" data-idx="${i}" data-state="${esc(u.status)}" style="--asst-upload: ${pct}%"><span class="asst-chip-text">${esc(u.name)}</span><span class="asst-chip-meta">${esc(meta)}</span><button type="button" class="asst-chip-x" aria-label="${esc(t('common.remove', 'Remove'))}">${ICON_X}</button></span>`);
    });
    state.memories.forEach((m, i) => {
      const title = memoryTitle(m);
      chips.push(`<span class="asst-chip memory static" data-kind="memory" data-idx="${i}"><span class="asst-icon">${ICON_MEMORY}</span><span class="asst-chip-text">${esc(title)}</span><button type="button" class="asst-chip-x" aria-label="${esc(t('common.remove', 'Remove'))}">${ICON_X}</button></span>`);
    });
    attachmentsEl.innerHTML = chips.join('');
    attachmentsEl.hidden = !chips.length;
    updateSendButton();
  }

  attachmentsEl.addEventListener('click', (e) => {
    const x = e.target.closest('.asst-chip-x');
    if (!x) return;
    const chip = x.closest('.asst-chip');
    const idx = Number(chip?.dataset.idx);
    const kind = chip?.dataset.kind;
    if (kind === 'image') state.images.splice(idx, 1);
    else if (kind === 'file') state.files.splice(idx, 1);
    else if (kind === 'upload') state.uploads.splice(idx, 1)[0]?.controller?.abort();
    else if (kind === 'memory') state.memories.splice(idx, 1);
    renderAttachments();
    textarea.focus();
  });

  /** Progress without a re-render (the image chips keep their thumbnails). */
  function renderUploadProgress(upload) {
    const chip = attachmentsEl.querySelector(`.asst-chip[data-kind="upload"][data-idx="${state.uploads.indexOf(upload)}"]`);
    if (!chip || upload.status !== 'uploading') return;
    const pct = Math.round((upload.progress || 0) * 100);
    chip.style.setProperty('--asst-upload', `${pct}%`);
    const meta = chip.querySelector('.asst-chip-meta');
    if (meta) meta.textContent = `${pct}%`;
  }

  function abortUploads() {
    for (const u of state.uploads) u.controller?.abort();
  }

  function memoryTitle(node) {
    const p = node?.payload || node || {};
    const first = String(p.content || node?.title || '').split('\n')[0].replace(/^#+\s*/, '');
    return first.slice(0, 40) || p.category || node?.id || 'memory';
  }

  // ── Slash menu ──
  function closeSlash() {
    state.slashOpen = false;
    slashMenu.hidden = true;
    slashMenu.innerHTML = '';
    textarea.removeAttribute('aria-activedescendant');
    textarea.setAttribute('aria-expanded', 'false');
  }

  function renderSlash() {
    slashMenu.innerHTML = state.slashItems.map((cmd, i) => `
      <div class="asst-slash-item${i === state.slashIndex ? ' focused' : ''}" role="option" id="${slashMenu.id}-${esc(cmd.name)}" aria-selected="${i === state.slashIndex}" data-name="${esc(cmd.name)}">
        <span class="asst-slash-name">${esc(cmd.usage || `/${cmd.name}`)}</span>
        <span class="asst-slash-desc">${esc(hooks.describeSlash ? hooks.describeSlash(cmd) : cmd.desc)}</span>
      </div>`).join('');
    const focused = slashMenu.querySelector('.asst-slash-item.focused');
    if (focused) {
      textarea.setAttribute('aria-activedescendant', focused.id);
      focused.scrollIntoView({ block: 'nearest' });
    }
  }

  function updateSlash() {
    const value = textarea.value;
    if (!value.startsWith('/') || value.includes('\n') || value.startsWith('//')) { closeSlash(); return; }
    const head = value.slice(1).split(/\s/)[0];
    const afterHead = value.slice(1 + head.length);
    if (afterHead.length > 0 && SLASH_COMMANDS.some(c => c.name === head)) { closeSlash(); return; } // args typed → hide
    const items = matchSlashCommands(value);
    if (!items.length) { closeSlash(); return; }
    state.slashItems = items;
    state.slashIndex = Math.min(state.slashIndex, items.length - 1);
    state.slashOpen = true;
    slashMenu.hidden = false;
    textarea.setAttribute('aria-expanded', 'true');
    renderSlash();
  }

  function pickSlash(cmd) {
    if (!cmd) return;
    const needsArgs = /[<]/.test(cmd.usage || '');
    const optionalArgs = !needsArgs && /\[/.test(cmd.usage || '');
    textarea.value = `/${cmd.name}${needsArgs || optionalArgs ? ' ' : ''}`;
    closeSlash();
    autoResize();
    updateSendButton();
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    if (!needsArgs && !optionalArgs) submit();
  }

  slashMenu.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.asst-slash-item');
    if (!item) return;
    e.preventDefault();
    pickSlash(state.slashItems.find(c => c.name === item.dataset.name));
  });

  // ── Submit ──
  async function submit() {
    if (state.disabled) return;
    if (uploading()) { hooks.onToast?.(t('assistant.composer.waitUploads', 'Wait for the upload to finish, then send')); return; }
    const text = textarea.value.trim();
    if (!text && !state.images.length && !state.files.length && !state.uploads.length && !state.memories.length) return;
    const payload = {
      text,
      images: state.images.slice(),
      files: state.files.slice(),
      uploads: state.uploads.map(({ name, size, mime, path }) => ({ name, size, mime, path })),
      memories: state.memories.slice(),
    };
    let outcome;
    try { outcome = await hooks.onSubmit?.(payload); } catch { outcome = false; }
    if (outcome === false) return;
    textarea.value = '';
    state.images = [];
    state.files = [];
    state.uploads = [];
    state.memories = [];
    renderAttachments();
    closeSlash();
    autoResize();
    updateSendButton();
    hooks.onDraftChange?.('');
    if (outcome === 'queued') hooks.onToast?.(t('assistant.composer.queued', 'Queued — will send when the current turn finishes'));
  }

  sendBtn.addEventListener('click', () => {
    if (state.running) { hooks.onAbort?.(); return; }
    submit();
  });

  textarea.addEventListener('keydown', (e) => {
    if (state.slashOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); state.slashIndex = (state.slashIndex + 1) % state.slashItems.length; renderSlash(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); state.slashIndex = (state.slashIndex - 1 + state.slashItems.length) % state.slashItems.length; renderSlash(); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        const cmd = state.slashItems[state.slashIndex];
        const typed = textarea.value.trim();
        // Enter on an exact, complete command (e.g. "/help") submits instead of re-picking.
        if (e.key === 'Enter' && cmd && typed === `/${cmd.name}` && !/[<]/.test(cmd.usage || '')) { closeSlash(); }
        else { e.preventDefault(); pickSlash(cmd); return; }
      }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSlash(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === 'Escape') {
      if (state.running) { e.preventDefault(); e.stopPropagation(); hooks.onAbort?.(); }
      return;
    }
    e.stopPropagation(); // keep global keybinds (single letters) out of the composer
  });
  textarea.addEventListener('keyup', (e) => e.stopPropagation());
  textarea.addEventListener('input', () => {
    autoResize();
    updateSlash();
    updateSendButton();
    hooks.onDraftChange?.(textarea.value);
  });
  textarea.addEventListener('blur', () => { setTimeout(() => { if (document.activeElement !== textarea) closeSlash(); }, 120); });
  textarea.addEventListener('focus', () => hooks.onFocusChange?.(true));
  textarea.addEventListener('blur', () => hooks.onFocusChange?.(false));

  /**
   * The caret's client position ({ x, y }, the middle of its line) or null: a
   * hidden mirror of the textarea (its box and type) holds the text up to the
   * caret and a marker, read once and removed. The mascot watches it.
   */
  function caretPoint() {
    const box = textarea.getBoundingClientRect();
    if (!box.width || !textarea.isConnected) return null;
    const cs = getComputedStyle(textarea);
    const mirror = document.createElement('div');
    mirror.setAttribute('aria-hidden', 'true');
    const style = mirror.style;
    for (const prop of ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderStyle',
      'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'letterSpacing', 'lineHeight', 'textTransform', 'wordSpacing', 'textIndent', 'tabSize']) style[prop] = cs[prop];
    Object.assign(style, { position: 'fixed', left: '0', top: '0', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', overflow: 'hidden', pointerEvents: 'none' });
    const end = textarea.selectionEnd ?? textarea.value.length;
    mirror.textContent = textarea.value.slice(0, end);
    const mark = document.createElement('span');
    mark.textContent = '\u200b';
    mirror.appendChild(mark);
    document.body.appendChild(mirror);
    const x = box.left + mark.offsetLeft - textarea.scrollLeft;
    const y = box.top + mark.offsetTop - textarea.scrollTop + mark.offsetHeight / 2;
    mirror.remove();
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }

  // ── Paste (images) ──
  textarea.addEventListener('paste', (e) => {
    if (!e.clipboardData) return;
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith('image/')) {
        const blob = item.getAsFile();
        if (!blob) continue;
        e.preventDefault();
        addImageFile(blob).catch(() => {});
      }
    }
  });

  // ── File picker ──
  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    for (const file of Array.from(fileInput.files || [])) await addFile(file);
    fileInput.value = '';
    textarea.focus();
  });

  async function addImageFile(file) {
    if (file.size > MAX_IMAGE) { hooks.onToast?.(t('assistant.composer.imageTooLarge', 'Image too large (max 8 MB)')); return; }
    const dataUrl = await readAsDataUrl(file);
    const match = dataUrl.match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
    if (!match) return;
    addImage({ base64: match[2], mediaType: match[1], name: file.name || 'image' });
  }

  /** Picker and drop: see routeAttachment. Resolves once the file is routed; an upload runs on. */
  async function addFile(file) {
    if (!file) return;
    const route = await routeAttachment(file);
    if (route === 'image') return addImageFile(file);
    if (route === 'text') {
      const content = await readAsText(file);
      state.files.push({ name: file.name, content });
      renderAttachments();
      return;
    }
    if (route === 'tooLarge') { hooks.onToast?.(t('assistant.composer.uploadTooLarge', 'File too large (max {max})', { max: formatBytes(MAX_UPLOAD) })); return; }
    uploadFile(file);
  }

  /** Upload one file; its chip shows progress, then name · size. Returns the settled job. */
  function uploadFile(file) {
    if (typeof hooks.uploadFile !== 'function') { hooks.onToast?.(t('assistant.composer.unsupportedFile', 'Only images and text files can be attached')); return Promise.resolve(); }
    const upload = { name: file.name || 'attachment', size: file.size, mime: file.type || '', path: null, status: 'uploading', progress: 0, controller: new AbortController() };
    state.uploads.push(upload);
    renderAttachments();
    const onProgress = (p) => { upload.progress = Math.min(1, Math.max(0, Number(p) || 0)); renderUploadProgress(upload); };
    return Promise.resolve()
      .then(() => hooks.uploadFile(file, { onProgress, signal: upload.controller.signal }))
      .then((saved) => {
        if (!saved?.path) throw new Error('The server returned no path');
        if (!state.uploads.includes(upload)) return;
        Object.assign(upload, { status: 'done', progress: 1, controller: null, path: saved.path, name: saved.name || upload.name, size: saved.size ?? upload.size, mime: saved.mime || upload.mime });
        renderAttachments();
      })
      .catch((err) => {
        const idx = state.uploads.indexOf(upload);
        if (idx < 0) return; // removed (and aborted) by the user
        state.uploads.splice(idx, 1);
        renderAttachments();
        hooks.onToast?.(err?.code === 'ATTACHMENT_TOO_LARGE'
          ? t('assistant.composer.uploadTooLarge', 'File too large (max {max})', { max: formatBytes(MAX_UPLOAD) })
          : t('assistant.composer.uploadFailed', 'Could not upload {name}: {error}', { name: upload.name, error: err?.message || String(err) }));
      });
  }

  function addImage(image) {
    if (!image?.base64) return;
    state.images.push({ base64: image.base64, mediaType: image.mediaType || 'image/png', name: image.name || 'image' });
    renderAttachments();
  }

  function addImageDataUrl(dataUrl, name = 'image') {
    const match = String(dataUrl || '').match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
    if (!match) return false;
    addImage({ base64: match[2], mediaType: match[1], name });
    return true;
  }

  function addMemory(node) {
    if (!node) return false;
    const id = node.id || node.payload?.id;
    if (id && state.memories.some(m => (m.id || m.payload?.id) === id)) return false;
    state.memories.push(node);
    renderAttachments();
    return true;
  }

  // ── Drag & drop ──
  root.addEventListener('dragover', (e) => {
    const types = Array.from(e.dataTransfer?.types || []);
    if (!types.includes('Files') && !types.includes(MEMORY_DRAG_TYPE) && !types.includes(WB_IMAGE_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    root.classList.add('drag-over');
  });
  root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) root.classList.remove('drag-over'); });
  root.addEventListener('drop', async (e) => {
    root.classList.remove('drag-over');
    const dt = e.dataTransfer;
    if (!dt) return;
    const memoryId = dt.getData(MEMORY_DRAG_TYPE);
    if (memoryId) {
      e.preventDefault();
      const node = hooks.resolveMemory?.(memoryId);
      if (node) addMemory(node);
      textarea.focus();
      return;
    }
    const wbId = dt.getData(WB_IMAGE_DRAG_TYPE);
    if (wbId) {
      e.preventDefault();
      const img = hooks.resolveWhiteboardImage?.(wbId);
      if (img?.dataUrl) addImageDataUrl(img.dataUrl, 'whiteboard');
      textarea.focus();
      return;
    }
    if (dt.files?.length) {
      e.preventDefault();
      for (const file of Array.from(dt.files)) await addFile(file);
      textarea.focus();
    }
  });

  // ── Queue chips ──
  function setQueue(items) {
    const list = Array.isArray(items) ? items : [];
    queueEl.innerHTML = list.map((item, i) => `<span class="asst-chip static" data-idx="${i}"><span class="asst-chip-meta">${esc(t('assistant.composer.queuedShort', 'queued'))}</span><span class="asst-chip-text">${esc(String(item.text || '').slice(0, 60) || t('assistant.composer.attachmentsOnly', '(attachments)'))}</span><button type="button" class="asst-chip-x" aria-label="${esc(t('common.remove', 'Remove'))}">${ICON_X}</button></span>`).join('');
    queueEl.hidden = !list.length;
  }
  queueEl.addEventListener('click', (e) => {
    const x = e.target.closest('.asst-chip-x');
    if (!x) return;
    hooks.onRemoveQueued?.(Number(x.closest('.asst-chip')?.dataset.idx));
  });

  // Width changes (docking, float resize) re-wrap the text. The resize runs on
  // the next frame: changing the observed box inside the callback would loop.
  let lastWidth = 0;
  let resizeFrame = 0;
  const resizeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver((entries) => {
      const width = Math.round(entries[0]?.contentRect?.width || 0);
      if (!width || width === lastWidth) return;
      lastWidth = width;
      const narrow = width < NARROW_COMPOSER_PX;
      if (narrow !== state.narrow) { state.narrow = narrow; if (!state.disabled) textarea.placeholder = placeholderNow(); }
      if (!resizeFrame) resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; autoResize(); });
    })
    : null;
  resizeObserver?.observe(textarea);

  updateSendButton();
  autoResize();

  return {
    el: root,
    textarea,
    focus() { try { textarea.focus({ preventScroll: true }); } catch { textarea.focus(); } },
    blur() { textarea.blur(); },
    isFocused() { return document.activeElement === textarea; },
    setRunning(running) { state.running = !!running; updateSendButton(); },
    setDisabled(disabled, reason) {
      state.disabled = !!disabled;
      textarea.disabled = state.disabled;
      attachBtn.disabled = state.disabled;
      root.classList.toggle('disabled', state.disabled);
      textarea.placeholder = state.disabled && reason ? reason : placeholderNow();
      updateSendButton();
    },
    setHint() { /* engine/version live in the toolbar "⋯" menu */ },
    setPlaceholder(text) { state.placeholder = text || state.placeholder; if (!state.disabled) textarea.placeholder = placeholderNow(); },
    getText() { return textarea.value; },
    setText(text) { textarea.value = String(text ?? ''); autoResize(); updateSlash(); updateSendButton(); },
    /** A sent prompt the server refused comes back: its words first (before anything typed since), its attachments. */
    restore(payload = {}) {
      const words = String(payload.display ?? payload.text ?? '');
      const typed = textarea.value;
      textarea.value = words && typed.trim() ? `${words}\n\n${typed}` : (words || typed);
      state.images.push(...(payload.images || []));
      state.files.push(...(payload.files || []));
      state.uploads.push(...(payload.uploads || []).map((u) => ({ ...u, status: 'done', progress: 1 })));
      state.memories.push(...(payload.memories || []));
      renderAttachments();
      autoResize();
      updateSlash();
      updateSendButton();
      hooks.onDraftChange?.(textarea.value);
    },
    /** Put a template in the composer; `{caret}` marks where the caret lands. Never sends. */
    fillTemplate(tpl) {
      const raw = String(tpl ?? '');
      const at = raw.indexOf('{caret}');
      const text = raw.replace('{caret}', '');
      textarea.value = text;
      autoResize();
      updateSlash();
      updateSendButton();
      hooks.onDraftChange?.(text);
      try { textarea.focus({ preventScroll: true }); } catch { textarea.focus(); }
      const pos = at >= 0 ? at : text.length;
      textarea.setSelectionRange(pos, pos);
    },
    insertText(text) {
      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? textarea.value.length;
      textarea.setRangeText(String(text ?? ''), start, end, 'end');
      autoResize();
      updateSendButton();
      hooks.onDraftChange?.(textarea.value);
    },
    addImage,
    addImageDataUrl,
    addFile,
    addMemory,
    openFilePicker() { fileInput.click(); },
    caretPoint,
    clearAttachments() { abortUploads(); state.images = []; state.files = []; state.uploads = []; state.memories = []; renderAttachments(); },
    setQueue,
    hasContent,
    destroy() { abortUploads(); closeSlash(); resizeObserver?.disconnect(); root.remove(); },
  };
}

/**
 * Build the prompt text sent to the brain from a composer payload. Uploaded
 * files follow the user's words as one line each (path only, never their
 * bytes), so the first line — the session's title — stays the user's own.
 */
export function buildPromptText(payload) {
  const parts = [];
  for (const f of payload.files || []) parts.push(`<file path="${f.name}">\n${f.content}\n</file>`);
  for (const m of payload.memories || []) {
    const p = m?.payload || m || {};
    parts.push(`<memory id="${m?.id || p.id || ''}" category="${p.category || ''}">\n${p.content || m?.text || ''}\n</memory>`);
  }
  if (payload.text) parts.push(payload.text);
  const uploads = (payload.uploads || []).filter((u) => u?.path);
  if (uploads.length) parts.push(uploads.map(attachmentPromptLine).join('\n'));
  return parts.join('\n\n');
}
