// ═══════════════════════════════════════════
// SynaBun Neural Interface — Resume Sessions
// Toolbar dropdown for browsing and resuming
// past Claude Code sessions across projects.
// ═══════════════════════════════════════════

import { emit, on } from './state.js';
import { fetchClaudeSessions, searchMemories, startSessionIndexing, cancelSessionIndexing, fetchIndexingStatus } from './api.js';
import { isGuest, hasPermission } from './ui-sync.js';
import { storage } from './storage.js';

const $ = (id) => document.getElementById(id);

// ── State ──
let _cachedProjects = null;   // null = never loaded
let _searchDebounce = null;
let _currentSearch = '';
let _expandedProject = null;  // path of currently expanded project
let _loading = false;

// ── Indexing state ──
let _indexing = false;
let _indexingProgress = { completed: 0, total: 0, chunks: 0 };
let _indexedSessionIds = new Set();
let _indexingStatusLoaded = false;

// ── Session labels (server-synced via storage.js) ──
const LABEL_PREFIX = 'synabun-session-label:';

function getSessionLabel(sessionId) {
  try { return storage.getItem(LABEL_PREFIX + sessionId) || ''; } catch { return ''; }
}

function setSessionLabel(sessionId, label) {
  try {
    if (label) storage.setItem(LABEL_PREFIX + sessionId, label);
    else storage.removeItem(LABEL_PREFIX + sessionId);
  } catch { /* storage error */ }
}

// ── Public API ──

export function initResume() {
  on('resume:render', renderResume);

  // Subscribe to indexing WebSocket events
  on('ws:message', (msg) => {
    if (!msg || !msg.type || !msg.type.startsWith('indexing:')) return;
    handleIndexingEvent(msg);
  });
}

function handleIndexingEvent(event) {
  switch (event.type) {
    case 'indexing:started':
      _indexing = true;
      _indexingProgress = { completed: 0, total: event.totalSessions, chunks: 0 };
      updateIndexingUI();
      break;
    case 'indexing:session-complete':
      _indexingProgress.completed = (event.sessionIndex ?? _indexingProgress.completed) + 1;
      _indexingProgress.chunks += event.chunkCount || 0;
      updateIndexingUI();
      break;
    case 'indexing:complete':
      _indexing = false;
      _indexingProgress = { completed: event.totalSessions, total: event.totalSessions, chunks: event.totalChunks };
      // Refresh indexed session IDs
      loadIndexingStatus();
      updateIndexingUI();
      break;
    case 'indexing:cancelled':
      _indexing = false;
      loadIndexingStatus();
      updateIndexingUI();
      break;
    case 'indexing:error':
      // Non-fatal — just update UI
      updateIndexingUI();
      break;
  }
}

function updateIndexingUI() {
  const bar = document.querySelector('.resume-indexing-bar');
  if (!bar) return;

  if (_indexing) {
    const pct = _indexingProgress.total > 0 ? Math.round((_indexingProgress.completed / _indexingProgress.total) * 100) : 0;
    bar.style.display = '';
    bar.innerHTML = `
      <div class="resume-indexing-progress">
        <div class="resume-indexing-fill" style="width: ${pct}%"></div>
      </div>
      <div class="resume-indexing-text">
        Indexing ${_indexingProgress.completed}/${_indexingProgress.total} sessions (${_indexingProgress.chunks} chunks)
        <button class="resume-indexing-cancel" title="Cancel indexing">&times;</button>
      </div>
    `;
    const cancelBtn = bar.querySelector('.resume-indexing-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try { await cancelSessionIndexing(); } catch {}
      });
    }
  } else {
    bar.style.display = 'none';
    bar.innerHTML = '';
  }
}

async function loadIndexingStatus() {
  try {
    const status = await fetchIndexingStatus();
    _indexing = !!status.running;
    _indexedSessionIds = new Set(status.indexedSessionIds || []);
    if (status.progress) _indexingProgress = status.progress;
    _indexingStatusLoaded = true;
  } catch { /* ignore */ }
}

// ── Core render ──

async function renderResume() {
  const container = $('resume-list');
  if (!container) return;

  if (isGuest() && !hasPermission('terminal')) {
    container.innerHTML = '<div class="resume-empty">Terminal access required.</div>';
    return;
  }

  // Always reload on menu open to catch new sessions
  container.innerHTML = '<div class="resume-empty resume-loading">Loading sessions...</div>';
  await loadAllProjects(_currentSearch);

  renderProjectList(container);
}

async function loadAllProjects(search = '') {
  _loading = true;
  try {
    const data = await fetchClaudeSessions({ limit: 20, search });
    _cachedProjects = data.projects || [];
  } catch (err) {
    console.error('[resume] Failed to load sessions:', err);
    _cachedProjects = [];
  }
  _loading = false;
}

// ── Render ──

function renderProjectList(container) {
  // Preserve existing search input across re-renders to keep cursor position
  let searchBox = container.querySelector('.resume-search');

  // Remove everything except the search box
  [...container.children].forEach(el => {
    if (!el.classList.contains('resume-search')) el.remove();
  });

  // Load indexing status on first render
  if (!_indexingStatusLoaded) {
    loadIndexingStatus().then(() => {
      updateIndexingUI();
      // Re-render session list to show indexed badges
      const list = container.querySelector('.resume-session-list');
      if (list && _indexedSessionIds.size > 0) renderProjectList(container);
    });
  }

  // Create search box only on first render
  if (!searchBox) {
    searchBox = document.createElement('div');
    searchBox.className = 'resume-search';
    searchBox.innerHTML = `
      <div class="resume-search-wrap">
        <svg class="resume-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="text" class="resume-search-input"
               placeholder="Search past sessions..."
               value="${escHtml(_currentSearch)}"
               autocomplete="off" spellcheck="false">
        <button class="resume-index-btn" title="Index sessions for deep search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
        </button>
      </div>
      <div class="resume-indexing-bar" style="display:none"></div>
    `;
    container.prepend(searchBox);

    const input = searchBox.querySelector('.resume-search-input');
    input.addEventListener('input', (e) => {
      _currentSearch = e.target.value;
      clearTimeout(_searchDebounce);
      _searchDebounce = setTimeout(() => performSearch(_currentSearch, container), 300);
    });
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => e.stopPropagation());

    // Index button handler
    const indexBtn = searchBox.querySelector('.resume-index-btn');
    indexBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (_indexing) return;
      try {
        // Get the currently expanded project, or index all
        const project = _expandedProject || undefined;
        await startSessionIndexing({ project });
        _indexing = true;
        _indexingProgress = { completed: 0, total: 0, chunks: 0 };
        updateIndexingUI();
      } catch (err) {
        console.error('[resume] Failed to start indexing:', err);
      }
    });

    requestAnimationFrame(() => input.focus());
  }

  if (!_cachedProjects || _cachedProjects.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'resume-empty';
    empty.textContent = _loading ? 'Loading...' : 'No projects registered.';
    container.appendChild(empty);
    return;
  }

  // "Continue last session" — most recent across all projects
  const allSessions = _cachedProjects
    .flatMap(p => p.sessions.map(s => ({ ...s, projectPath: p.path, projectLabel: p.label })))
    .sort((a, b) => new Date(b.modified) - new Date(a.modified));

  if (allSessions.length > 0 && !_currentSearch) {
    // Find the most recent session with actual content (skip empty/tag-only/deleted sessions)
    const latest = allSessions.find(s => {
      if (s.deleted) return false;
      const label = getSessionLabel(s.sessionId);
      if (label) return true;
      const cleaned = cleanPrompt(s.firstPrompt);
      return cleaned && cleaned.length > 0;
    }) || allSessions.find(s => !s.deleted) || allSessions[0]; // fallback to newest non-deleted

    const previewText = getSessionLabel(latest.sessionId) || cleanPrompt(latest.firstPrompt) || '';

    const continueEl = document.createElement('div');
    continueEl.className = 'resume-continue';
    continueEl.innerHTML = `
      <div class="resume-continue-row">
        <svg class="resume-continue-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        <div class="resume-continue-text">
          <div class="resume-continue-prompt">${previewText ? escHtml(trunc(previewText, 70)) : '<span class="resume-continue-fallback">Resume most recent</span>'}</div>
          <div class="resume-continue-meta">
            <span class="resume-project-badge">${escHtml(latest.projectLabel)}</span>
            <span class="resume-meta">${relDate(latest.modified)}</span>
          </div>
        </div>
      </div>
    `;
    continueEl.addEventListener('click', () => {
      closeMenu();
      launchResume(latest.sessionId, latest.projectPath);
    });
    container.appendChild(continueEl);
    container.appendChild(sep());
  }

  // Memory search results (only when actively searching)
  if (_currentSearch) {
    const memSlot = document.createElement('div');
    memSlot.id = 'resume-memory-results';
    container.appendChild(memSlot);
    searchMemoryResults(_currentSearch, memSlot);
  }

  // Project groups
  _cachedProjects.forEach(proj => {
    const group = document.createElement('div');
    group.className = 'resume-project-group';

    // Header
    const header = document.createElement('div');
    header.className = 'resume-project-header';
    const isExpanded = _expandedProject === proj.path || !!_currentSearch;
    header.innerHTML = `
      <span class="resume-project-chevron">${isExpanded ? '\u25BC' : '\u25B6'}</span>
      <span class="resume-project-name">${escHtml(proj.label)}</span>
      <span class="resume-project-count">${proj.total}</span>
    `;
    header.addEventListener('click', (e) => {
      e.stopPropagation();
      _expandedProject = _expandedProject === proj.path ? null : proj.path;
      renderProjectList(container);
    });
    group.appendChild(header);

    // Session list (expanded)
    if (isExpanded) {
      const list = document.createElement('div');
      list.className = 'resume-session-list';

      if (proj.sessions.length === 0) {
        list.innerHTML = '<div class="resume-no-sessions">No matching sessions</div>';
      } else {
        // Group sessions by time period
        let lastGroup = '';
        proj.sessions.forEach(s => {
          const group = timeGroup(s.modified);
          if (group !== lastGroup) {
            lastGroup = group;
            const label = document.createElement('div');
            label.className = 'resume-time-group';
            label.textContent = group;
            list.appendChild(label);
          }
          list.appendChild(renderSession(s, proj.path));
        });

        // "Load more" if paginated
        if (proj.sessions.length < proj.total) {
          const more = document.createElement('div');
          more.className = 'resume-load-more';
          more.textContent = `Show more (${proj.total - proj.sessions.length} remaining)`;
          more.addEventListener('click', async (e) => {
            e.stopPropagation();
            more.textContent = 'Loading...';
            try {
              const data = await fetchClaudeSessions({
                project: proj.path,
                limit: 30,
                offset: proj.sessions.length,
                search: _currentSearch,
              });
              const extra = data.projects?.[0]?.sessions || [];
              proj.sessions.push(...extra);
              renderProjectList(container);
            } catch { more.textContent = 'Failed to load'; }
          });
          list.appendChild(more);
        }
      }

      group.appendChild(list);
    }

    container.appendChild(group);
  });
}

function renderSession(s, projectPath) {
  const item = document.createElement('div');
  item.className = 'resume-session-item';

  const branchHtml = s.gitBranch
    ? `<span class="resume-branch">${escHtml(s.gitBranch)}</span>` : '';

  const customLabel = getSessionLabel(s.sessionId);
  const cleaned = cleanPrompt(s.firstPrompt);
  const displayText = customLabel || (cleaned ? trunc(cleaned, 100) : '');
  const isEmpty = !displayText;
  const promptClass = isEmpty ? 'resume-session-prompt resume-session-prompt--empty' : 'resume-session-prompt';
  const promptText = isEmpty ? 'Empty session' : escHtml(displayText);

  // Pencil icon (rename) — appears on hover via CSS
  const renameBtn = `<button class="resume-rename-btn" title="Rename session"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></button>`;

  // Message count visual — icon + count
  const msgLabel = s.messageCount === 0 ? '' :
    `<span class="resume-meta resume-msg-count">${s.messageCount} msg${s.messageCount !== 1 ? 's' : ''}</span>`;

  // Indexed badge
  const indexedBadge = _indexedSessionIds.has(s.sessionId)
    ? '<span class="resume-indexed-badge" title="Indexed for deep search">indexed</span>'
    : '';

  item.innerHTML = `
    <div class="${promptClass}" data-prompt-display>${promptText}</div>
    <div class="resume-session-meta">
      ${branchHtml}
      <span class="resume-meta">${relDate(s.modified)}</span>
      ${msgLabel}
      ${indexedBadge}
    </div>
    ${renameBtn}
  `;

  // Dim empty sessions
  if (s.messageCount === 0 && isEmpty) {
    item.classList.add('resume-session-item--empty');
  }

  // Dim deleted sessions (file removed by Claude Code, cached in SynaBun)
  if (s.deleted) {
    item.classList.add('resume-session-item--deleted');
    item.title = 'Session file was cleaned up by Claude Code — no longer resumable';
  }

  // Rename button handler
  const renBtn = item.querySelector('.resume-rename-btn');
  renBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    startRename(item, s);
  });

  // Launch on click (but not when renaming)
  item.addEventListener('click', (e) => {
    if (item.querySelector('.resume-rename-input')) return; // renaming in progress
    if (s.deleted) return; // can't resume deleted sessions
    closeMenu();
    launchResume(s.sessionId, projectPath);
  });

  return item;
}

function startRename(item, session) {
  // Already renaming?
  if (item.querySelector('.resume-rename-input')) return;

  const promptEl = item.querySelector('[data-prompt-display]');
  const renameBtn = item.querySelector('.resume-rename-btn');
  if (!promptEl) return;

  // Hide rename button while editing
  if (renameBtn) renameBtn.style.display = 'none';

  const currentLabel = getSessionLabel(session.sessionId) || cleanPrompt(session.firstPrompt) || '';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'resume-rename-input';
  input.value = currentLabel;
  input.placeholder = cleanPrompt(session.firstPrompt) ? trunc(cleanPrompt(session.firstPrompt), 60) : 'Session name...';

  // Replace prompt text with input
  promptEl.style.display = 'none';
  promptEl.parentNode.insertBefore(input, promptEl);

  // Prevent menu close and event bubbling
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') commitRename(input, promptEl, session, renameBtn);
    if (e.key === 'Escape') cancelRename(input, promptEl, renameBtn);
  });
  input.addEventListener('blur', () => commitRename(input, promptEl, session, renameBtn));

  requestAnimationFrame(() => { input.focus(); input.select(); });
}

function commitRename(input, promptEl, session, renameBtn) {
  if (!input.parentNode) return; // already committed
  const value = input.value.trim();

  // Save (or clear if matches original or empty)
  const originalClean = cleanPrompt(session.firstPrompt);
  if (value && value !== originalClean) {
    setSessionLabel(session.sessionId, value);
  } else {
    setSessionLabel(session.sessionId, ''); // clear custom label
  }

  // Update display
  const displayText = value || (originalClean ? trunc(originalClean, 100) : '');
  if (displayText) {
    promptEl.className = 'resume-session-prompt';
    promptEl.textContent = displayText;
  } else {
    promptEl.className = 'resume-session-prompt resume-session-prompt--empty';
    promptEl.textContent = 'No prompt';
  }

  promptEl.style.display = '';
  input.remove();
  if (renameBtn) renameBtn.style.display = '';
}

function cancelRename(input, promptEl, renameBtn) {
  if (!input.parentNode) return;
  promptEl.style.display = '';
  input.remove();
  if (renameBtn) renameBtn.style.display = '';
}

// ── Memory search integration ──

async function searchMemoryResults(query, container) {
  try {
    const data = await searchMemories(query, 5);
    if (!data.results || data.results.length === 0) return;

    // Filter to conversation memories
    const convResults = data.results.filter(r =>
      r.payload?.category === 'conversations'
    );
    if (convResults.length === 0) return;

    const header = document.createElement('div');
    header.className = 'resume-group-label';
    header.textContent = 'Related Memories';
    container.appendChild(header);

    convResults.forEach(r => {
      const content = r.payload?.content || '';
      const project = r.payload?.project;

      // Try to extract session ID from memory content
      const sidMatch = content.match(/Session ID:\s*([0-9a-f-]{36})/i)
        || content.match(/\*\*Session ID\*\*:\s*([0-9a-f-]{36})/i);
      const sessionId = sidMatch?.[1] || r.payload?.session_id;

      // Extract first line as title
      const firstLine = content.split('\n').find(l => l.trim()) || content;

      const item = document.createElement('div');
      item.className = 'resume-memory-item';
      item.innerHTML = `
        <div class="resume-session-prompt">${escHtml(trunc(firstLine, 80))}</div>
        <div class="resume-session-meta">
          <span class="resume-meta">${relDate(r.payload?.created_at)}</span>
          ${project ? `<span class="resume-project-badge">${escHtml(project)}</span>` : ''}
        </div>
      `;

      if (sessionId) {
        item.style.cursor = 'pointer';
        item.addEventListener('click', () => {
          closeMenu();
          // Find matching project
          const proj = _cachedProjects?.find(p =>
            p.label?.toLowerCase() === project?.toLowerCase() ||
            p.path?.toLowerCase().endsWith(project?.toLowerCase())
          );
          if (proj) launchResume(sessionId, proj.path);
        });
      }

      container.appendChild(item);
    });
  } catch (err) {
    console.warn('[resume] Memory search failed:', err);
  }
}

// ── Search ──

async function performSearch(query, container) {
  if (query) {
    await loadAllProjects(query);
  } else {
    _cachedProjects = null; // force reload without filter
    await loadAllProjects();
  }
  renderProjectList(container);
}

// ── Terminal launch ──

async function launchResume(claudeSessionId, projectPath) {
  const label = getSessionLabel(claudeSessionId);
  emit('terminal:open-resume', {
    profile: 'claude-code',
    cwd: projectPath,
    resume: claudeSessionId,
    label: label || '',
  });
}

// ── Helpers ──

function closeMenu() {
  emit('panel:close-all-dropdowns');
}

function trunc(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '...' : str;
}

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Strip XML-like tags (ide_opened_file, system-reminder, ide_selection, etc.) and clean up prompt text */
function cleanPrompt(raw) {
  if (!raw) return '';
  let s = raw
    // Remove full XML tags with content on the same line: <tag>...</tag>
    .replace(/<\/?(?:ide_opened_file|ide_selection|system-reminder|antml:[a-z_]+)[^>]*>[^\n]*/gi, '')
    // Remove any remaining self-closing or opening/closing XML-style tags
    .replace(/<\/?[a-z_-]+[^>]*>/gi, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

function relDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = Date.now();
  const diff = now - d.getTime();
  const min = Math.floor(diff / 60000);
  const hr  = Math.floor(diff / 3600000);
  const day = Math.floor(diff / 86400000);

  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  if (hr < 24) return `${hr}h ago`;
  if (day < 7) return `${day}d ago`;
  if (day < 30) return `${Math.floor(day / 7)}w ago`;
  return d.toLocaleDateString();
}

/** Get time-group label for a date */
function timeGroup(dateStr) {
  if (!dateStr) return 'Older';
  const d = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const weekAgo = new Date(today); weekAgo.setDate(today.getDate() - 7);

  if (d >= today) return 'Today';
  if (d >= yesterday) return 'Yesterday';
  if (d >= weekAgo) return 'This Week';
  return 'Older';
}

function sep() {
  const el = document.createElement('div');
  el.className = 'menu-sep';
  return el;
}
