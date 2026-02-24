// ═══════════════════════════════════════════
// SynaBun Neural Interface — Detail Cards (Multi-Instance)
// ═══════════════════════════════════════════
//
// Spawns independent memory detail cards. Each card is draggable,
// resizable, compactable, and closeable. Clicking the same memory
// again brings its card to front instead of duplicating.

import { state, emit, on } from './state.js';
import { updateMemory, deleteMemory } from './api.js';
import { KEYS } from './constants.js';
import { storage } from './storage.js';
import { catColor } from './colors.js';
import { truncate, formatMemoryContent, exportMemoryAsMarkdown } from './utils.js';
import { t } from './i18n.js';
import { savePanelLayout, restorePanelLayout } from './ui-panels.js';

// ─── Scoped query helper ────────────────
const q = (card, role) => card.querySelector(`[data-role="${role}"]`);

// ─── Multi-card state ───────────────────
const _openCards = new Map();  // memoryId → { el, node, isCompact, isEditing, savedExpanded }
let _topZ = 220;
const MAX_CARDS = 20;

// ─── Variant callbacks ───────────────────
let _callbacks = {
  applyGraphData: () => {},
  updateStats: () => {},
  buildCategorySidebar: () => {},
  clearMultiSelect: () => {},
  fetchTrashItems: () => {},
  refreshNodeAppearance: () => {},
};

export function setDetailCallbacks(cbs) {
  Object.assign(_callbacks, cbs);
}


// ═══════════════════════════════════════════
// BOOKMARKS (localStorage-backed)
// ═══════════════════════════════════════════

function getBookmarks() {
  try { return JSON.parse(storage.getItem(KEYS.BOOKMARKS) || '[]'); }
  catch { return []; }
}

function saveBookmarks(arr) {
  storage.setItem(KEYS.BOOKMARKS, JSON.stringify(arr));
}

function isBookmarked(nodeId) {
  return getBookmarks().some(b => b.id === nodeId);
}

function toggleBookmark(node) {
  const bookmarks = getBookmarks();
  const idx = bookmarks.findIndex(b => b.id === node.id);
  if (idx !== -1) {
    bookmarks.splice(idx, 1);
  } else {
    const p = node.payload || {};
    const preview = (p.content || '').replace(/\n/g, ' ').slice(0, 80);
    bookmarks.unshift({
      id: node.id,
      title: preview || node.id,
      category: p.category || 'uncategorized',
      added: Date.now(),
    });
  }
  saveBookmarks(bookmarks);
  return isBookmarked(node.id);
}

export function updateDetailBookmarkBtn(nodeId) {
  const card = _openCards.get(nodeId);
  if (!card) return;
  const btn = q(card.el, 'bookmark-btn');
  if (!btn) return;
  const svg = btn.querySelector('svg');
  if (isBookmarked(nodeId)) {
    btn.classList.add('active');
    if (svg) svg.classList.add('filled');
  } else {
    btn.classList.remove('active');
    if (svg) svg.classList.remove('filled');
  }
}

export { getBookmarks, saveBookmarks, isBookmarked, toggleBookmark };


// ═══════════════════════════════════════════
// TAG DELETE MODAL
// ═══════════════════════════════════════════

function showTagDeleteModal(tagName, onConfirm) {
  const overlay = document.createElement('div');
  overlay.className = 'tag-delete-overlay';
  overlay.innerHTML = `
    <div class="tag-delete-modal">
      <div class="tag-delete-modal-title">Remove tag</div>
      <div class="tag-delete-modal-tag">${tagName}</div>
      <div class="tag-delete-modal-actions">
        <button class="action-btn action-btn--ghost tag-modal-cancel">Cancel</button>
        <button class="action-btn action-btn--danger tag-modal-confirm">Delete</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('.tag-modal-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('.tag-modal-confirm').addEventListener('click', () => { overlay.remove(); onConfirm(); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}


// ═══════════════════════════════════════════
// MARKDOWN CONTENT EDITOR (edit mode)
// ═══════════════════════════════════════════

function enterEditMode(card, node) {
  const cardState = _openCards.get(node.id);
  if (!cardState) return;
  cardState.isEditing = true;

  const contentEl = q(card, 'content');
  const wrap = contentEl.parentElement;
  contentEl.style.display = 'none';

  const prev = wrap.querySelector('.md-editor-wrap');
  if (prev) prev.remove();

  const editor = document.createElement('div');
  editor.className = 'md-editor-wrap';

  const toolbar = document.createElement('div');
  toolbar.className = 'md-toolbar';

  const btnBold = document.createElement('button');
  btnBold.textContent = 'B';
  btnBold.title = 'Bold (**text**)';
  btnBold.style.fontWeight = '700';

  const btnList = document.createElement('button');
  btnList.textContent = '\u2022 List';
  btnList.title = 'Toggle list (- item)';

  const btnHeading = document.createElement('button');
  btnHeading.textContent = 'H';
  btnHeading.title = 'Cycle heading (## / ### / none)';

  toolbar.append(btnBold, btnList, btnHeading);

  const textarea = document.createElement('textarea');
  textarea.className = 'md-textarea';
  textarea.value = node.payload.content || '';
  textarea.spellcheck = false;

  function autoResize() {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(360, Math.max(120, textarea.scrollHeight)) + 'px';
  }
  textarea.addEventListener('input', autoResize);

  const actions = document.createElement('div');
  actions.className = 'md-editor-actions';

  const btnCancel = document.createElement('button');
  btnCancel.className = 'md-btn-cancel';
  btnCancel.textContent = 'Cancel';

  const btnSave = document.createElement('button');
  btnSave.className = 'md-btn-save';
  btnSave.textContent = 'Save';

  actions.append(btnCancel, btnSave);
  editor.append(toolbar, textarea, actions);
  wrap.appendChild(editor);

  requestAnimationFrame(() => { textarea.focus(); autoResize(); });

  // Toolbar actions
  btnBold.addEventListener('click', () => {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const val = textarea.value;
    const sel = val.substring(start, end);
    if (sel.startsWith('**') && sel.endsWith('**') && sel.length > 4) {
      textarea.value = val.substring(0, start) + sel.slice(2, -2) + val.substring(end);
      textarea.selectionStart = start; textarea.selectionEnd = end - 4;
    } else if (start >= 2 && val.substring(start - 2, start) === '**' && val.substring(end, end + 2) === '**') {
      textarea.value = val.substring(0, start - 2) + sel + val.substring(end + 2);
      textarea.selectionStart = start - 2; textarea.selectionEnd = end - 2;
    } else {
      textarea.value = val.substring(0, start) + '**' + sel + '**' + val.substring(end);
      textarea.selectionStart = start + 2; textarea.selectionEnd = end + 2;
    }
    textarea.focus();
  });

  btnList.addEventListener('click', () => {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const val = textarea.value;
    const lineStart = val.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = val.indexOf('\n', end);
    const blockEnd = lineEnd === -1 ? val.length : lineEnd;
    const block = val.substring(lineStart, blockEnd);
    const lines = block.split('\n');
    const allList = lines.every(l => /^- /.test(l));
    const newLines = allList ? lines.map(l => l.replace(/^- /, '')) : lines.map(l => '- ' + l);
    const newBlock = newLines.join('\n');
    textarea.value = val.substring(0, lineStart) + newBlock + val.substring(blockEnd);
    const diff = newBlock.length - block.length;
    textarea.selectionStart = lineStart; textarea.selectionEnd = blockEnd + diff;
    textarea.focus();
  });

  btnHeading.addEventListener('click', () => {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const val = textarea.value;
    const lineStart = val.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = val.indexOf('\n', end);
    const blockEnd = lineEnd === -1 ? val.length : lineEnd;
    const block = val.substring(lineStart, blockEnd);
    const lines = block.split('\n');
    const newLines = lines.map(l => {
      if (l.startsWith('### ')) return l.slice(4);
      if (l.startsWith('## ')) return '### ' + l.slice(3);
      return '## ' + l;
    });
    const newBlock = newLines.join('\n');
    textarea.value = val.substring(0, lineStart) + newBlock + val.substring(blockEnd);
    const diff = newBlock.length - block.length;
    textarea.selectionStart = lineStart; textarea.selectionEnd = blockEnd + diff;
    textarea.focus();
  });

  btnCancel.addEventListener('click', () => exitEditMode(card, node, false));
  btnSave.addEventListener('click', () => exitEditMode(card, node, true));
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); exitEditMode(card, node, false); }
  });
}

async function exitEditMode(card, node, save) {
  const contentEl = q(card, 'content');
  const wrap = contentEl.parentElement;
  const editor = wrap.querySelector('.md-editor-wrap');

  if (save && editor) {
    const textarea = editor.querySelector('.md-textarea');
    const newContent = textarea.value;
    try {
      await updateMemory(node.id, { content: newContent });
      node.payload.content = newContent;
    } catch (err) {
      console.error('Content save failed:', err);
    }
  }

  if (editor) editor.remove();
  contentEl.style.display = '';
  contentEl.innerHTML = formatMemoryContent(node.payload.content);

  const cardState = _openCards.get(node.id);
  if (cardState) cardState.isEditing = false;
}


// ═══════════════════════════════════════════
// DELETE MEMORY
// ═══════════════════════════════════════════

async function deleteMemoryFromUI(node) {
  try {
    await deleteMemory(node.id);
    state.allNodes = state.allNodes.filter(n => n.id !== node.id);
    state.allLinks = state.allLinks.filter(l =>
      l.source !== node.id && l.target !== node.id &&
      l.source?.id !== node.id && l.target?.id !== node.id
    );
    closeMemoryCard(node.id);
    const presentCats = new Set(state.allNodes.map(n => n.payload.category));
    _callbacks.buildCategorySidebar(presentCats);
    _callbacks.applyGraphData();
    _callbacks.updateStats();
    try { _callbacks.fetchTrashItems(); } catch {}
  } catch (e) {
    console.error('deleteMemory error:', e);
  }
}


// ═══════════════════════════════════════════
// CATEGORY CHANGE MODAL
// ═══════════════════════════════════════════

function openCategoryChangeModal(card, node) {
  const current = node.payload.category;

  const overlay = document.createElement('div');
  overlay.className = 'tag-delete-overlay';

  const parents = [];
  const childrenOf = {};
  state.allCategoryNames.forEach(cat => {
    const meta = state.categoryMeta?.[cat];
    if (meta?.parent) {
      if (!childrenOf[meta.parent]) childrenOf[meta.parent] = [];
      childrenOf[meta.parent].push(cat);
    } else if (meta?.is_parent) {
      parents.push(cat);
    }
  });

  let listHtml = '';
  state.allCategoryNames.forEach(cat => {
    const desc = state.categoryDescriptions[cat] || '';
    const isActive = cat === current;
    const meta = state.categoryMeta?.[cat];
    const isParent = meta?.is_parent;
    const isChild = !!meta?.parent;

    if (isParent) {
      const children = childrenOf[cat] || [];
      if (children.length > 0) {
        listHtml += `<div class="cat-modal-group-label">${cat}</div>`;
      } else {
        listHtml += `
          <div class="cat-modal-option${isActive ? ' active' : ''}" data-cat="${cat}">
            <div class="cat-opt-dot" style="color:${catColor(cat)}; background:${catColor(cat)}"></div>
            <div class="cat-opt-info">
              <span class="cat-opt-name">${cat}</span>
              ${desc ? `<span class="cat-opt-desc">${desc}</span>` : ''}
            </div>
          </div>`;
      }
      return;
    }

    listHtml += `
      <div class="cat-modal-option${isActive ? ' active' : ''}${isChild ? ' cat-modal-child' : ''}" data-cat="${cat}">
        <div class="cat-opt-dot" style="color:${catColor(cat)}; background:${catColor(cat)}"></div>
        <div class="cat-opt-info">
          <span class="cat-opt-name">${cat}</span>
          ${desc ? `<span class="cat-opt-desc">${desc}</span>` : ''}
        </div>
        ${isActive ? '<svg class="cat-opt-check" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>' : ''}
      </div>`;
  });

  overlay.innerHTML = `
    <div class="tag-delete-modal cat-change-modal">
      <div class="cat-change-modal-header">
        <div class="cat-change-modal-title">Move to category</div>
        <div class="cat-change-modal-from">
          <span class="cat-change-from-label">Currently in</span>
          <div class="cat-change-from-badge">
            <div class="cat-dot" style="color:${catColor(current)}; background:${catColor(current)}"></div>
            ${current}
          </div>
        </div>
      </div>
      <div class="cat-change-modal-list">${listHtml}</div>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.querySelectorAll('.cat-modal-option').forEach(opt => {
    opt.addEventListener('click', () => {
      const cat = opt.dataset.cat;
      overlay.remove();
      if (cat !== current) {
        changeMemoryCategory(card, node, cat);
      }
    });
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

async function changeMemoryCategory(card, node, newCategory) {
  const oldCategory = node.payload.category;
  node.payload.category = newCategory;

  const color = catColor(newCategory);
  const headerDot = q(card, 'header-dot');
  if (headerDot) { headerDot.style.color = color; headerDot.style.background = color; }
  const label = q(card, 'category-label');
  if (label) {
    const txt = newCategory + (node.payload.subcategory ? ' / ' + node.payload.subcategory : '');
    label.textContent = txt;
    label.setAttribute('data-tooltip', txt);
    label.removeAttribute('title');
    label.style.color = color;
  }

  const presentCats = new Set(state.allNodes.map(n => n.payload.category));
  _callbacks.buildCategorySidebar(presentCats);
  _callbacks.refreshNodeAppearance();

  try {
    await updateMemory(node.id, { category: newCategory });
  } catch (e) {
    console.error('changeMemoryCategory error:', e);
    node.payload.category = oldCategory;
    const rColor = catColor(oldCategory);
    if (headerDot) { headerDot.style.color = rColor; headerDot.style.background = rColor; }
    if (label) { label.textContent = oldCategory + (node.payload.subcategory ? ' / ' + node.payload.subcategory : ''); label.style.color = rColor; }
    const rCats = new Set(state.allNodes.map(n => n.payload.category));
    _callbacks.buildCategorySidebar(rCats);
    _callbacks.refreshNodeAppearance();
  }
}


// ═══════════════════════════════════════════
// CREATE DETAIL CARD DOM
// ═══════════════════════════════════════════

function createDetailCard(panelId) {
  const el = document.createElement('div');
  el.id = panelId;
  el.className = 'detail-card glass resizable';

  el.innerHTML = `
    <div class="resize-handle resize-handle-t" data-resize="t"></div>
    <div class="resize-handle resize-handle-b" data-resize="b"></div>
    <div class="resize-handle resize-handle-l" data-resize="l"></div>
    <div class="resize-handle resize-handle-r" data-resize="r"></div>
    <div class="resize-handle resize-handle-tl" data-resize="tl"></div>
    <div class="resize-handle resize-handle-tr" data-resize="tr"></div>
    <div class="resize-handle resize-handle-bl" data-resize="bl"></div>
    <div class="resize-handle resize-handle-br" data-resize="br"></div>
    <div class="detail-header drag-handle" data-drag="${panelId}">
      <div class="detail-header-actions">
        <button class="detail-action-btn" data-role="edit-btn" data-tooltip="${t('detail.edit')}"><svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
        <button class="detail-action-btn detail-action-btn--gold" data-role="bookmark-btn" data-tooltip="${t('detail.bookmark')}"><svg viewBox="0 0 24 24"><path d="M5 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16l-7-4-7 4V5z"/></svg></button>
        <button class="detail-action-btn" data-role="move-cat-btn" data-tooltip="${t('detail.moveCat')}"><svg viewBox="0 0 24 24"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg></button>
        <button class="detail-action-btn" data-role="export-btn" data-tooltip="${t('detail.exportMd')}"><svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>
        <button class="detail-action-btn detail-action-btn--danger" data-role="delete-btn" data-tooltip="${t('common.delete')}"><svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg></button>
        <span class="detail-action-btn detail-drag-to-term" draggable="true" data-role="drag-to-term" data-tooltip="Drag to terminal"><svg viewBox="0 0 24 24"><path d="M4 17l6-6-6-6"/><line x1="12" y1="19" x2="20" y2="19"/></svg></span>
        <button class="detail-action-btn" data-role="compact-btn" data-tooltip="${t('detail.compact')}"><svg viewBox="0 0 24 24"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg></button>
        <div class="detail-action-sep"></div>
        <button class="detail-action-btn pin-btn" data-pin="${panelId}" data-tooltip="${t('common.pin')}"><svg viewBox="0 0 24 24"><path d="M9 4v4.5L7.5 10H6v2h4v7l2 1 2-1v-7h4v-2h-1.5L15 8.5V4H9z" stroke-linejoin="round" stroke-linecap="round"/></svg></button>
        <button class="detail-action-btn detail-action-btn--close" data-role="close-btn" data-tooltip="${t('common.close')}">&times;</button>
      </div>
      <div class="detail-header-category">
        <div class="detail-header-dot" data-role="header-dot"></div>
        <span class="detail-header-name" data-role="category-label"></span>
      </div>
    </div>
    <div class="detail-body">
      <div class="detail-subheader">
        <div data-role="importance"></div>
        <button class="detail-chip" data-role="focus-btn" data-tooltip="${t('detail.focusLinked')}"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4m-7.07-14.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83"/></svg>${t('detail.linked')}</button>
      </div>
      <div class="content-edit-wrap">
        <div data-role="content"></div>
      </div>
      <div data-role="tags-section" class="detail-section">
        <div class="detail-label">${t('detail.tags')}</div>
        <div class="tag-chips" data-role="tag-chips"></div>
      </div>
      <div data-role="meta-section" class="detail-section">
        <div class="detail-label">${t('detail.metadata')}</div>
        <div class="detail-meta" data-role="meta-content"></div>
      </div>
      <div data-role="files-section" class="detail-section" style="display:none">
        <div class="detail-label">${t('detail.relatedFiles')}</div>
        <div class="detail-meta" data-role="files-content"></div>
      </div>
    </div>
  `;

  return el;
}


// ═══════════════════════════════════════════
// Z-INDEX & POSITIONING
// ═══════════════════════════════════════════

function bringToFront(cardEl) {
  _topZ++;
  cardEl.style.zIndex = _topZ;
}

function getNextCardPosition() {
  const count = _openCards.size;
  const offset = count * 30;
  return {
    left: Math.min(window.innerWidth - 540, 200 + (offset % 300)) + 'px',
    top: Math.min(window.innerHeight - 300, 80 + (offset % 200)) + 'px',
  };
}


// ═══════════════════════════════════════════
// PERSISTENCE
// ═══════════════════════════════════════════

function persistOpenCards() {
  const data = [..._openCards.entries()].map(([id, c]) => ({
    memoryId: id,
    panelId: c.el.id,
    left: c.el.style.left,
    top: c.el.style.top,
    width: c.el.style.width,
    height: c.el.style.height,
    isCompact: c.isCompact,
  }));
  storage.setItem(KEYS.OPEN_CARDS, JSON.stringify(data));
}

/** Return a snapshot of all open cards for workspace saving. */
export function getOpenCardsSnapshot() {
  return [..._openCards.entries()].map(([id, c]) => ({
    memoryId: id,
    left: c.el.style.left,
    top: c.el.style.top,
    width: c.el.style.width,
    height: c.el.style.height,
    isCompact: c.isCompact,
  }));
}

/** Return the number of currently open cards. */
export function getOpenCardCount() {
  return _openCards.size;
}

export function restoreOpenCards() {
  const raw = storage.getItem(KEYS.OPEN_CARDS);
  if (!raw) return;
  try {
    const saved = JSON.parse(raw);
    for (const item of saved) {
      const node = state.allNodes.find(n => n.id === item.memoryId);
      if (!node) continue;
      openMemoryCard(node, {
        left: item.left, top: item.top,
        width: item.width, height: item.height,
        isCompact: item.isCompact,
      });
    }
  } catch {}
}


// ═══════════════════════════════════════════
// OPEN MEMORY CARD
// ═══════════════════════════════════════════

export function openMemoryCard(node, savedPosition) {
  // If already open, bring to front
  if (_openCards.has(node.id)) {
    const existing = _openCards.get(node.id);
    bringToFront(existing.el);
    state.selectedNodeId = node.id;
    storage.setItem(KEYS.SELECTED_NODE, node.id);
    return;
  }

  // Soft limit
  if (_openCards.size >= MAX_CARDS) {
    console.warn(`SynaBun: Maximum ${MAX_CARDS} cards open. Close some first.`);
    // Still allow it but warn
  }

  const panelId = 'detail-card-' + node.id.slice(0, 8);
  const card = createDetailCard(panelId);
  const p = node.payload;
  const color = catColor(p.category);

  // ── Position ──
  if (savedPosition) {
    if (savedPosition.left) card.style.left = savedPosition.left;
    if (savedPosition.top) card.style.top = savedPosition.top;
    if (savedPosition.width) card.style.width = savedPosition.width;
    if (savedPosition.height) card.style.height = savedPosition.height;
  } else {
    const pos = getNextCardPosition();
    card.style.left = pos.left;
    card.style.top = pos.top;
  }

  // ── Header ──
  const headerDot = q(card, 'header-dot');
  headerDot.style.color = color;
  headerDot.style.background = color;
  const catLabel = q(card, 'category-label');
  const catText = (p._isOpenClaw ? '[OC] ' : '') + p.category + (p.subcategory ? ' / ' + p.subcategory : '');
  catLabel.textContent = catText;
  catLabel.setAttribute('data-tooltip', catText);
  catLabel.style.color = color;

  // ── OpenClaw ──
  const isOC = !!p._isOpenClaw;
  if (isOC) {
    q(card, 'move-cat-btn').style.display = 'none';
    q(card, 'delete-btn').style.display = 'none';
    q(card, 'edit-btn').style.display = 'none';

    const ocSourceEl = document.createElement('div');
    ocSourceEl.style.cssText = 'font-size:11px;color:#f97316;margin-bottom:8px;font-family:"JetBrains Mono",monospace;';
    const source = p._openClawFile ? p._openClawFile : p.category.includes('longterm') ? 'MEMORY.md' : 'Daily Log';
    ocSourceEl.textContent = 'Source: OpenClaw \u2022 ' + source;
    const contentEl = q(card, 'content');
    contentEl.parentNode.insertBefore(ocSourceEl, contentEl);
  }

  // ── Actions ──
  q(card, 'move-cat-btn').onclick = () => openCategoryChangeModal(card, node);

  q(card, 'delete-btn').onclick = () => {
    const overlay = document.createElement('div');
    overlay.className = 'tag-delete-overlay';
    overlay.innerHTML = `
      <div class="tag-delete-modal" style="max-width:380px">
        <div class="tag-delete-modal-title"><svg viewBox="0 0 24 24" style="width:14px;height:14px;stroke:var(--accent-red);stroke-width:2;fill:none;vertical-align:-2px"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg> Move to Trash</div>
        <p style="font-size:var(--fs-sm);color:var(--t-secondary);margin-bottom:6px">Move this memory to trash?</p>
        <p style="font-size:var(--fs-xs);color:var(--t-muted);margin-bottom:18px">You can restore it from the trash panel.</p>
        <div class="tag-delete-modal-actions">
          <button class="action-btn action-btn--ghost del-cancel">Cancel</button>
          <button class="action-btn action-btn--danger del-confirm">Move to Trash</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('.del-cancel').onclick = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('.del-confirm').onclick = () => {
      overlay.remove();
      deleteMemoryFromUI(node);
    };
  };

  // Bookmark
  const bookmarkBtn = q(card, 'bookmark-btn');
  bookmarkBtn.addEventListener('click', () => {
    toggleBookmark(node);
    updateDetailBookmarkBtn(node.id);
  });
  // Set initial bookmark state
  if (isBookmarked(node.id)) {
    bookmarkBtn.classList.add('active');
    const svg = bookmarkBtn.querySelector('svg');
    if (svg) svg.classList.add('filled');
  }

  // Export
  q(card, 'export-btn').onclick = () => exportMemoryAsMarkdown(node);

  // Drag to terminal
  const dragGrip = q(card, 'drag-to-term');
  if (dragGrip) {
    dragGrip.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      e.dataTransfer.setData('application/x-synabun-memory', node.id);
      e.dataTransfer.effectAllowed = 'copy';
      card.classList.add('detail-dragging-to-term');
    });
    dragGrip.addEventListener('dragend', () => {
      card.classList.remove('detail-dragging-to-term');
    });
  }

  // Focus
  const focusBtn = q(card, 'focus-btn');
  focusBtn.classList.toggle('active', state.focusedNodeId === node.id);
  focusBtn.onclick = () => {
    if (state.focusedNodeId === node.id) {
      state.focusedNodeId = null;
      focusBtn.classList.remove('active');
    } else {
      // Deactivate focus button on all other cards
      _openCards.forEach((c) => {
        const fb = q(c.el, 'focus-btn');
        if (fb) fb.classList.remove('active');
      });
      state.focusedNodeId = node.id;
      focusBtn.classList.add('active');
    }
    _callbacks.applyGraphData();
    _callbacks.updateStats();
  };

  // ── Importance dots ──
  const imp = p.importance || 5;
  const impEl = q(card, 'importance');
  impEl.innerHTML = '';
  for (let i = 1; i <= 10; i++) {
    const dot = document.createElement('span');
    dot.style.cssText = `display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:4px;background:${i <= imp ? '#FFD700' : 'rgba(255,255,255,0.08)'};box-shadow:${i <= imp ? '0 0 4px rgba(255,215,0,0.4)' : 'none'}`;
    impEl.appendChild(dot);
  }

  // ── Content ──
  const contentEl = q(card, 'content');
  contentEl.innerHTML = formatMemoryContent(p.content);

  // Edit button
  q(card, 'edit-btn').onclick = () => enterEditMode(card, node);

  // ── Tags ──
  const tagContainer = q(card, 'tag-chips');
  const currentTags = (p.tags && Array.isArray(p.tags)) ? [...p.tags] : [];

  function renderEditableTags() {
    tagContainer.innerHTML = '';
    currentTags.forEach(tag => {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      const text = document.createElement('span');
      text.className = 'tag-text';
      text.textContent = tag;
      chip.appendChild(text);

      const rm = document.createElement('span');
      rm.className = 'tag-remove';
      rm.textContent = '\u00d7';
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        showTagDeleteModal(tag, async () => {
          const idx = currentTags.indexOf(tag);
          if (idx !== -1) currentTags.splice(idx, 1);
          try {
            await updateMemory(node.id, { tags: currentTags });
            node.payload.tags = [...currentTags];
          } catch (e) { console.error('Tag remove failed:', e); }
          renderEditableTags();
        });
      });
      chip.appendChild(rm);
      tagContainer.appendChild(chip);
    });

    const input = document.createElement('input');
    input.className = 'tag-add-input';
    input.placeholder = '+ add tag';
    input.maxLength = 40;
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        const newTag = input.value.trim().toLowerCase();
        if (currentTags.includes(newTag)) { input.value = ''; return; }
        currentTags.push(newTag);
        try {
          await updateMemory(node.id, { tags: currentTags });
          node.payload.tags = [...currentTags];
        } catch (e) { console.error('Tag add failed:', e); }
        renderEditableTags();
      }
    });
    tagContainer.appendChild(input);
  }

  if (isOC) {
    tagContainer.innerHTML = '';
    currentTags.forEach(tag => {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      const text = document.createElement('span');
      text.className = 'tag-text';
      text.textContent = tag;
      chip.appendChild(text);
      tagContainer.appendChild(chip);
    });
  } else {
    renderEditableTags();
  }

  // ── Metadata ──
  const meta = q(card, 'meta-content');
  meta.innerHTML = '';
  const addMeta = (label, value) => {
    if (!value) return;
    const row = document.createElement('div');
    row.className = 'detail-meta-row';
    row.innerHTML = `<span style="color:rgba(255,255,255,0.3)">${label}</span><span>${value}</span>`;
    meta.appendChild(row);
  };
  addMeta('Project', p.project);
  addMeta('Source', p.source);
  addMeta('Created', p.created_at ? new Date(p.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null);
  addMeta('Updated', p.updated_at ? new Date(p.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null);
  addMeta('Accessed', p.access_count ? `${p.access_count} times` : null);

  // ID row with copy
  {
    const idRow = document.createElement('div');
    idRow.className = 'detail-meta-row';
    idRow.innerHTML = `<span style="color:rgba(255,255,255,0.3)">ID</span><span>${truncate(node.id, 20)}<button class="meta-copy-btn" data-tooltip="Copy full ID">Copy</button></span>`;
    idRow.querySelector('.meta-copy-btn').addEventListener('click', () => {
      navigator.clipboard.writeText(node.id).then(() => {
        const btn = idRow.querySelector('.meta-copy-btn');
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
      });
    });
    meta.appendChild(idRow);
  }

  // ── Related files ──
  const filesDiv = q(card, 'files-section');
  const filesContent = q(card, 'files-content');
  if (p.related_files && p.related_files.length) {
    filesContent.innerHTML = p.related_files.map(f =>
      `<div style="font-family:'JetBrains Mono','SF Mono',Consolas,monospace;font-size:12px;color:rgba(255,255,255,0.45);padding:2px 0">${f}</div>`
    ).join('');
    filesDiv.style.display = '';
  } else {
    filesDiv.style.display = 'none';
  }

  // ── Close button ──
  q(card, 'close-btn').addEventListener('click', () => closeMemoryCard(node.id));

  // ── Compact toggle ──
  const compactBtn = q(card, 'compact-btn');
  const body = card.querySelector('.detail-body');
  const shrinkIcon = '<svg viewBox="0 0 24 24"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
  const expandIcon = '<svg viewBox="0 0 24 24"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';

  const cardState = {
    el: card,
    node,
    isCompact: false,
    isEditing: false,
    savedExpanded: null,
    _animating: false,
  };

  compactBtn.addEventListener('click', () => {
    if (cardState._animating) return;
    cardState._animating = true;

    const goingCompact = !cardState.isCompact;
    compactBtn.innerHTML = goingCompact ? expandIcon : shrinkIcon;
    compactBtn.dataset.tooltip = goingCompact ? 'Expand' : 'Compact';

    if (goingCompact) {
      // ── EXPAND → COMPACT (FLIP) ──
      const startRect = card.getBoundingClientRect();

      // Freeze at current size, disable transitions, apply compact layout
      card.classList.add('no-transition');
      card.classList.add('compact');
      card.style.width = startRect.width + 'px';
      card.style.height = startRect.height + 'px';
      card.style.maxHeight = 'none';
      if (body) { body.classList.add('drag-handle'); body.dataset.drag = panelId; }
      void card.offsetHeight; // force reflow

      // Measure compact target
      card.style.width = '';
      card.style.height = '';
      void card.offsetHeight;
      const endRect = card.getBoundingClientRect();

      // Reset to start dimensions
      card.style.width = startRect.width + 'px';
      card.style.height = startRect.height + 'px';
      void card.offsetHeight;

      // Re-enable transitions and animate to compact
      card.classList.remove('no-transition');
      requestAnimationFrame(() => {
        card.style.width = endRect.width + 'px';
        card.style.height = endRect.height + 'px';
      });

      const onEnd = (e) => {
        if (e.propertyName !== 'width' && e.propertyName !== 'height') return;
        card.removeEventListener('transitionend', onEnd);
        card.style.width = '';
        card.style.height = '';
        card.style.maxHeight = '';
        cardState.isCompact = true;
        cardState._animating = false;
        persistOpenCards();
      };
      card.addEventListener('transitionend', onEnd);

      // Safety timeout in case transitionend doesn't fire
      setTimeout(() => {
        if (cardState._animating) {
          card.style.width = '';
          card.style.height = '';
          card.style.maxHeight = '';
          cardState.isCompact = true;
          cardState._animating = false;
          persistOpenCards();
        }
      }, 300);

    } else {
      // ── COMPACT → EXPAND (FLIP) ──
      const startRect = card.getBoundingClientRect();

      // Disable transitions, remove compact, let CSS default take over
      card.classList.add('no-transition');
      card.classList.remove('compact');
      card.style.width = '';
      card.style.height = '';
      card.style.maxHeight = '';
      if (body) { body.classList.remove('drag-handle'); delete body.dataset.drag; }
      void card.offsetHeight;

      // Measure natural expanded size (CSS default: 520px width, auto height)
      const endRect = card.getBoundingClientRect();

      // Reset to compact starting dimensions
      card.style.width = startRect.width + 'px';
      card.style.height = startRect.height + 'px';
      void card.offsetHeight;

      // Re-enable transitions and animate to expanded
      card.classList.remove('no-transition');
      requestAnimationFrame(() => {
        card.style.width = endRect.width + 'px';
        card.style.height = endRect.height + 'px';
      });

      const onEnd = (e) => {
        if (e.propertyName !== 'width' && e.propertyName !== 'height') return;
        card.removeEventListener('transitionend', onEnd);
        card.style.width = '';
        card.style.height = '';
        card.style.maxHeight = '';
        cardState.isCompact = false;
        cardState._animating = false;
        persistOpenCards();
      };
      card.addEventListener('transitionend', onEnd);

      // Safety timeout
      setTimeout(() => {
        if (cardState._animating) {
          card.style.width = '';
          card.style.height = '';
          card.style.maxHeight = '';
          cardState.isCompact = false;
          cardState._animating = false;
          persistOpenCards();
        }
      }, 300);
    }
  });

  // Apply saved compact state
  if (savedPosition?.isCompact) {
    card.classList.add('compact');
    cardState.isCompact = true;
    compactBtn.innerHTML = expandIcon;
    compactBtn.dataset.tooltip = 'Expand';
    if (body) { body.classList.add('drag-handle'); body.dataset.drag = panelId; }
  }

  // ── Z-index: bring to front on click ──
  card.addEventListener('mousedown', () => bringToFront(card));

  // ── Pin: restore saved pin state ──
  const pinKey = 'neural-pinned-' + panelId;
  if (storage.getItem(pinKey) === 'true') {
    card.classList.add('locked');
    const pinBtn = card.querySelector('.pin-btn');
    if (pinBtn) pinBtn.classList.add('pinned');
  }

  // ── Add to DOM and state ──
  _openCards.set(node.id, cardState);
  document.body.appendChild(card);
  bringToFront(card);

  // Trigger entrance animation on next frame
  requestAnimationFrame(() => card.classList.add('open'));

  state.selectedNodeId = node.id;
  storage.setItem(KEYS.SELECTED_NODE, node.id);
  emit('detail:opened', { nodeId: node.id });
  persistOpenCards();
}


// ═══════════════════════════════════════════
// CLOSE MEMORY CARD
// ═══════════════════════════════════════════

export function closeMemoryCard(memoryId) {
  const cardState = _openCards.get(memoryId);
  if (!cardState) return;

  const card = cardState.el;

  // Exit edit mode if active
  if (cardState.isEditing) {
    exitEditMode(card, cardState.node, false);
  }

  // Fade out
  card.classList.remove('open');

  // Remove after transition
  setTimeout(() => {
    card.remove();
  }, 200);

  _openCards.delete(memoryId);

  // Update selection
  if (state.selectedNodeId === memoryId) {
    if (_openCards.size > 0) {
      const lastKey = [..._openCards.keys()].pop();
      state.selectedNodeId = lastKey;
      storage.setItem(KEYS.SELECTED_NODE, lastKey);
    } else {
      state.selectedNodeId = null;
      storage.removeItem(KEYS.SELECTED_NODE);
    }
  }

  // Clear focus if it was on this card
  if (state.focusedNodeId === memoryId) {
    state.focusedNodeId = null;
    _callbacks.applyGraphData();
    _callbacks.updateStats();
  }

  if (state.multiSelected.size > 0) _callbacks.clearMultiSelect();

  emit('detail:closed');
  persistOpenCards();
}

export function closeAllCards() {
  const ids = [..._openCards.keys()];
  ids.forEach(id => closeMemoryCard(id));
}


// ═══════════════════════════════════════════
// BACKWARD COMPAT + INIT
// ═══════════════════════════════════════════

// Backward compatibility aliases
export const showDetailPanel = openMemoryCard;
export const closeDetailPanel = closeAllCards;

export function initDetailPanel() {
  // Event bus listeners
  on('detail:show', ({ nodeId }) => {
    const node = state.allNodes.find(n => n.id === nodeId);
    if (node) openMemoryCard(node);
  });

  on('detail:close', () => {
    closeAllCards();
  });

  // Persist open card positions after resize/drag
  on('detail:layout-changed', () => {
    persistOpenCards();
  });
}
