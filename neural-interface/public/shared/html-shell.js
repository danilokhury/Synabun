// ═══════════════════════════════════════════
// SynaBun Neural Interface — Shared HTML Shell
// Source of truth for all DOM elements shared across 2D/3D variants
// ═══════════════════════════════════════════

import { getVariant } from './registry.js';
import { t } from './i18n.js';

/**
 * Returns the full shared HTML string for injection into <body>.
 * Variant-specific elements (camera HUD, controls panel, minimap, etc.)
 * are NOT included — those live in each variant's HTML file.
 */
export function getSharedHTML() {
  const variant = getVariant() || '3d';
  const is3D = variant === '3d';

  return `
<!-- Loading Overlay -->
<div id="loading-overlay">
  <div id="loading-mascot">
    <svg viewBox="0 0 280 140" width="160" height="80" style="overflow:visible">
      <g class="syna-eye">
        <g class="syna-lid" transform="translate(0,60) scale(1,0.08) translate(0,-60)">
          <rect x="80" y="24" width="38" height="72" rx="19" fill="#ffffff"/>
        </g>
      </g>
      <g class="syna-eye">
        <g class="syna-lid" transform="translate(0,60) scale(1,0.08) translate(0,-60)">
          <rect x="162" y="24" width="38" height="72" rx="19" fill="#ffffff"/>
        </g>
      </g>
      <path d="M125,112 Q140,118 155,112" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="2.5" stroke-linecap="round"/>
    </svg>
    <span id="loading-zzz">z</span>
  </div>
  <img src="synabun.png?v=2" alt="SynaBun" class="loading-logo">
  <div id="loading-text">${t('loading.connecting')}</div>
  <div id="loading-sub">${t('loading.initializingNeural')}</div>
  <div id="loading-action">
    <button id="loading-action-btn" type="button">
      <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      <span id="loading-action-label">${t('loading.startDocker')}</span>
    </button>
    <div id="loading-action-status"></div>
  </div>
  <div id="loading-server-cmd">
    <div id="loading-server-cmd-hint">${t('loading.runCommand')}</div>
    <div id="loading-server-cmd-box">
      <code id="loading-cmd-text">node J:\\Sites\\Apps\\Synabun\\neural-interface\\server.js</code>
      <button id="loading-cmd-copy" title="${t('loading.copyToClipboard')}">
        <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      </button>
    </div>
    <br>
    <button id="loading-retry-btn" type="button">
      <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
      ${t('loading.retryConnection')}
    </button>
    <div id="loading-retry-status"></div>
    <img src="synabun.png?v=2" alt="SynaBun" style="margin-top:6px;height:32px;width:auto;filter:grayscale(0.5);opacity:0.18;">
  </div>
</div>

<!-- Node Hover Tooltip -->
<div id="tooltip" class="glass">
  <div id="tooltip-category"></div>
  <div id="tooltip-preview"></div>
  <div id="tooltip-importance"></div>
</div>

<!-- Top Menu Bar -->
<div id="title-bar">
  <div class="bar-left">
    <img src="synabun.png?v=2" alt="SynaBun" id="titlebar-logo" style="height:24px;width:auto;opacity:0.7;cursor:pointer;" data-tooltip="${t('tooltip.toggleExplorer')}">
    <div class="bar-sep"></div>
    <div class="view-toggle">
      <a class="view-toggle-btn${is3D ? '' : ' active'}" href="${is3D ? '/index2d.html' : '#'}" id="nav-2d-link">${t('nav.toggle2d')}</a>
      <a class="view-toggle-btn${is3D ? ' active' : ''}" href="${is3D ? '#' : '/'}" id="nav-3d-link">${t('nav.toggle3d')}</a>
    </div>
    <div class="bar-sep"></div>

    <!-- OS-style menubar -->
    <div class="menubar">

      <!-- View menu -->
      <div class="menubar-item" data-menu="view">
        <button class="menubar-label">${t('nav.view')}</button>
        <div class="menubar-dropdown glass">
          <div class="menu-item menu-toggle active" id="menu-toggle-categories">
            <span class="menu-check">&#10003;</span>
            <span class="menu-text">${t('menu.view.categories')}</span>
            <span class="menu-shortcut">C</span>
          </div>
          <div class="menu-item menu-toggle" id="menu-toggle-explorer">
            <span class="menu-check">&#10003;</span>
            <span class="menu-text">${t('menu.view.explorer')}</span>
            <span class="menu-shortcut">F</span>
          </div>
          <div class="menu-sep"></div>
          <div id="menu-variant-slot"></div>
          <div class="menu-sep" id="menu-variant-sep" style="display:none"></div>
          <div class="menu-item" id="menu-help">
            <span class="menu-check"></span>
            <span class="menu-text">${t('menu.view.help')}</span>
            <span class="menu-shortcut">?</span>
          </div>
        </div>
      </div>

      <!-- Graph menu -->
      <div class="menubar-item" data-menu="graph">
        <button class="menubar-label">${t('nav.graph')}</button>
        <div class="menubar-dropdown glass">
          <div class="menu-group-label">${t('menu.graph.linksGroup')}</div>
          <div class="menu-item menu-radio active" data-group="link-mode" data-value="off">
            <span class="menu-check">&#10003;</span>
            <span class="menu-text">${t('menu.graph.linksOff')}</span>
          </div>
          <div class="menu-item menu-radio" data-group="link-mode" data-value="intra">
            <span class="menu-check">&#10003;</span>
            <span class="menu-text">${t('menu.graph.linksIntra')}</span>
          </div>
          <div class="menu-item menu-radio" data-group="link-mode" data-value="all">
            <span class="menu-check">&#10003;</span>
            <span class="menu-text">${t('menu.graph.linksAll')}</span>
          </div>
          <div class="menu-sep"></div>
          <div class="menu-group-label">${t('menu.graph.linkTypeGroup')}</div>
          <div class="menu-item menu-radio active" data-group="link-type" data-value="all">
            <span class="menu-check">&#10003;</span>
            <span class="menu-text">${t('menu.graph.allTypes')}</span>
          </div>
          <div id="menu-link-types-slot"></div>
          <div class="menu-sep"></div>
          <div class="menu-item" id="menu-reset-layout">
            <span class="menu-check"></span>
            <span class="menu-text">${t('menu.graph.resetLayout')}</span>
          </div>
        </div>
      </div>

      <!-- Skills menu -->
      <div class="menubar-item" data-menu="skills">
        <button class="menubar-label">${t('nav.skills')}</button>
        <div class="menubar-dropdown glass">
          <div class="menu-item" id="menu-open-skills-studio">
            <span class="menu-check"></span>
            <span class="menu-text">${t('menu.skills.skillsStudio')}</span>
            <span class="menu-shortcut">K</span>
          </div>
          <div class="menu-sep"></div>
          <div class="menu-item" id="menu-skills-new">
            <span class="menu-check"></span>
            <span class="menu-text">${t('menu.skills.newSkill')}</span>
          </div>
          <div class="menu-item" id="menu-skills-import">
            <span class="menu-check"></span>
            <span class="menu-text">${t('menu.skills.import')}</span>
          </div>
        </div>
      </div>

      <!-- Terminal menu -->
      <div class="menubar-item" data-menu="terminal">
        <button class="menubar-label">${t('nav.terminal')}</button>
        <div class="menubar-dropdown glass">
          <div class="menu-item" id="menu-terminal-claude">
            <span class="menu-check"></span>
            <span class="menu-text"><span class="menu-icon"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></svg></span> ${t('menu.terminal.claudeCode')}</span>
          </div>
          <div class="menu-item" id="menu-terminal-codex">
            <span class="menu-check"></span>
            <span class="menu-text"><span class="menu-icon"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"/></svg></span> ${t('menu.terminal.codexCli')}</span>
          </div>
          <div class="menu-item" id="menu-terminal-gemini">
            <span class="menu-check"></span>
            <span class="menu-text"><span class="menu-icon"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"/></svg></span> ${t('menu.terminal.geminiCli')}</span>
          </div>
          <div class="menu-sep"></div>
          <div class="menu-item" id="menu-terminal-shell">
            <span class="menu-check"></span>
            <span class="menu-text"><span class="menu-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg></span> ${t('menu.terminal.shell')}</span>
          </div>
          <div class="menu-sep"></div>
          <div class="menu-item menu-toggle" id="menu-terminal-toggle">
            <span class="menu-check">&#10003;</span>
            <span class="menu-text">${t('menu.terminal.showTerminal')}</span>
            <span class="menu-shortcut">T</span>
          </div>
        </div>
      </div>

      <!-- Bookmarks menu -->
      <div class="menubar-item" data-menu="bookmarks">
        <button class="menubar-label">${t('nav.bookmarks')}<span class="count-badge count-badge--gold" id="bookmark-count"></span></button>
        <div class="menubar-dropdown glass menubar-dropdown--wide">
          <div id="bookmarks-list"></div>
        </div>
      </div>

      <!-- Layouts menu -->
      <div class="menubar-item" data-menu="layouts">
        <button class="menubar-label">${t('nav.layouts')}</button>
        <div class="menubar-dropdown glass menubar-dropdown--wide">
          <div class="preset-save-bar">
            <input type="text" id="preset-name-input" placeholder="${t('layouts.placeholder')}" autocomplete="off" spellcheck="false" maxlength="40">
            <button id="preset-save-btn">${t('layouts.save')}</button>
          </div>
          <div class="preset-warning" id="preset-warning">${t('layouts.noPinnedNodes')}</div>
          <div class="preset-list" id="preset-list"></div>
        </div>
      </div>

      <!-- Settings (text button) -->
      <button class="menubar-label menubar-action" id="menubar-settings-btn">${t('nav.settings')}</button>

    </div>
  </div>

  <div class="bar-center" id="search-container">
    <div id="search-wrapper">
      <input type="text" id="search-input" placeholder="${t('search.placeholder')}" autocomplete="off" spellcheck="false">
      <span id="search-badge"></span>
      <button id="search-clear">&times;</button>
    </div>
  </div>

  <div class="bar-right">
    <button id="titlebar-viz-toggle" class="bar-icon active" data-tooltip="${t('tooltip.toggleViz')}"><svg viewBox="0 0 24 24"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg></button>
    <button id="titlebar-fullscreen-btn" class="bar-icon" data-tooltip="${t('tooltip.fullscreen')}"><svg viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg></button>
    <div class="bar-sep"></div>
    <span id="titlebar-clock" class="titlebar-clock"></span>
  </div>
</div>

<!-- Top-Right Controls (Trash + Grid + Workspace) -->
<div id="topright-controls">
  <button id="topright-trash-btn" class="topright-icon-btn" data-tooltip="${t('nav.trash')}">
    <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
    <span class="count-badge count-badge--red" id="titlebar-trash-count"></span>
  </button>

  <button id="ws-grid-toggle" class="topright-icon-btn" data-tooltip="Snap to Grid">
    <svg viewBox="0 0 24 24"><path d="M3 3h18v18H3z" fill="none"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
  </button>

  <div id="workspace-overlay">
    <div id="ws-indicator">
      <svg class="ws-icon" viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
      <span id="ws-active-name">No workspace</span>
      <button id="ws-quick-save" class="ws-quick-save" title="Quick save"><svg viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg></button>
      <svg class="ws-chevron" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
    </div>
    <div id="ws-dropdown" class="glass" style="display:none;">
      <div class="ws-save-bar">
        <input type="text" id="ws-name-input" placeholder="Save workspace..." autocomplete="off" spellcheck="false">
        <button id="ws-save-btn" title="Save"><svg viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg></button>
      </div>
      <div class="ws-divider"></div>
      <div id="ws-list" class="ws-list"></div>
      <div class="ws-divider"></div>
      <div class="ws-footer">
        <button id="ws-export-btn" class="ws-footer-btn" title="Export all workspaces"><svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Export</button>
        <button id="ws-import-btn" class="ws-footer-btn" title="Import workspaces"><svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>Import</button>
      </div>
      <input type="file" id="ws-import-file" accept=".json" style="display:none;">
    </div>
  </div>
</div>

<!-- Help Modal -->
<div id="help-overlay">
  <div id="help-modal" class="glass" style="position:relative;">
    <button id="help-close">&times;</button>
    <h2>${t('help.title')}</h2>
    <div id="help-content"></div>
  </div>
</div>

<!-- Category Sidebar -->
<div id="category-sidebar" class="glass resizable">
  <div class="resize-handle resize-handle-t" data-resize="t"></div>
  <div class="resize-handle resize-handle-b" data-resize="b"></div>
  <div class="resize-handle resize-handle-l" data-resize="l"></div>
  <div class="resize-handle resize-handle-r" data-resize="r"></div>
  <div class="resize-handle resize-handle-tl" data-resize="tl"></div>
  <div class="resize-handle resize-handle-tr" data-resize="tr"></div>
  <div class="resize-handle resize-handle-bl" data-resize="bl"></div>
  <div class="resize-handle resize-handle-br" data-resize="br"></div>
  <div class="sidebar-header drag-handle" data-drag="category-sidebar">
    <div class="sidebar-header-actions">
      <button class="detail-action-btn" id="category-select-all-btn" data-tooltip="${t('sidebar.selectAll')}"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"/><polyline points="9 12 11 14 16 9"/></svg></button>
      <button class="detail-action-btn" id="category-clear-btn" data-tooltip="${t('sidebar.deselectAll')}"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg></button>
      <div class="detail-action-sep"></div>
      <button class="detail-action-btn" id="label-toggle-btn" data-tooltip="${t('sidebar.toggleLabels')}"><svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
      <button class="detail-action-btn" id="label-size-btn" data-tooltip="${t('sidebar.labelSize')}"><svg viewBox="0 0 24 24"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg></button>
      <div class="detail-action-sep"></div>
      <button class="detail-action-btn pin-btn" data-pin="category-sidebar" data-tooltip="${t('common.pin')}"><svg viewBox="0 0 24 24"><path d="M9 4v4.5L7.5 10H6v2h4v7l2 1 2-1v-7h4v-2h-1.5L15 8.5V4H9z" stroke-linejoin="round" stroke-linecap="round"/></svg></button>
      <button class="detail-action-btn detail-action-btn--close" id="sidebar-close" data-tooltip="${t('common.close')}">&times;</button>
    </div>
    <div class="sidebar-header-title">${t('sidebar.title')}</div>
  </div>
  <div id="category-sidebar-body">
    <div id="sidebar-label-controls">
      <input type="range" id="label-size-slider" min="0.3" max="2.5" step="0.1" value="1.0" style="flex:1;height:3px;accent-color:var(--t-muted);cursor:pointer;opacity:0;transition:opacity 0.2s;pointer-events:none;" data-tooltip="${t('sidebar.labelSize')}">
    </div>
    <div id="category-list"></div>
    <div style="display:flex;gap:8px;padding:0 12px;margin-bottom:8px;">
      <button id="category-add-btn" style="flex:1;" data-tooltip="${t('sidebar.addCategory')}"><svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>${t('sidebar.category')}</button>
      <button id="category-add-parent-btn" style="flex:1;" data-tooltip="${t('sidebar.addParent')}"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>${t('sidebar.parent')}</button>
    </div>
    <div style="display:flex;gap:8px;padding:0 12px;margin-bottom:8px;">
      <button id="settings-btn" style="flex:1;" data-tooltip="${t('common.settings')}"><svg viewBox="0 0 24 24"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>${t('common.settings')}</button>
    </div>
    <div id="category-create-form" data-mode="child">
      <div id="cat-form-title" style="font-weight:600;padding:8px 12px 4px;color:#aaa;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">${t('sidebar.createCategory')}</div>
      <input class="category-create-input" id="cat-name-input" placeholder="${t('sidebar.categoryName')}" maxlength="30" spellcheck="false">
      <input class="category-create-input" id="cat-desc-input" placeholder="${t('sidebar.shortDescription')}">
      <select class="modal-select" id="cat-parent-select">
        <option value="">${t('sidebar.noneStandalone')}</option>
      </select>
      <div class="color-swatch-row" id="color-swatch-row"></div>
      <div class="category-form-error" id="cat-form-error"></div>
      <div class="category-form-actions">
        <button class="category-form-btn-cancel" id="cat-form-cancel">${t('common.cancel')}</button>
        <button class="category-form-btn-create" id="cat-form-create" disabled>${t('common.create')}</button>
      </div>
    </div>
  </div>
</div>

<!-- Memory Explorer (docked sidebar) -->
<div id="explorer-panel">
  <div class="explorer-filter">
    <svg class="explorer-filter-icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>
    <input type="text" id="explorer-filter-input" placeholder="${t('explorer.filterPlaceholder')}" autocomplete="off" spellcheck="false">
    <button id="explorer-filter-clear">&times;</button>
  </div>
  <div class="explorer-toolbar">
    <button class="detail-action-btn" id="explorer-collapse-all" data-tooltip="${t('explorer.collapseAll')}"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button>
    <button class="detail-action-btn" id="explorer-expand-all" data-tooltip="${t('explorer.expandAll')}"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h16M18 9v6"/></svg></button>
    <div class="detail-action-sep"></div>
    <button class="detail-action-btn" id="explorer-sort-btn" data-tooltip="${t('explorer.sortNewest')}"><svg viewBox="0 0 24 24"><path d="M3 6h7M3 12h5M3 18h3M16 4v16M12 16l4 4 4-4"/></svg></button>
    <div class="detail-action-sep"></div>
    <button class="detail-action-btn" id="explorer-label-toggle" data-tooltip="${t('explorer.toggleLabels')}"><svg viewBox="0 0 24 24"><path d="M2.06 12c.86-2.15 3.64-7 9.94-7s9.08 4.85 9.94 7c-.86 2.15-3.64 7-9.94 7s-9.08-4.85-9.94-7z"/><circle cx="12" cy="12" r="3"/></svg></button>
    <button class="detail-action-btn" id="explorer-label-size" data-tooltip="${t('explorer.labelSize')}"><svg viewBox="0 0 24 24"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg></button>
    <div class="detail-action-sep"></div>
    <button class="detail-action-btn" id="explorer-select-all" data-tooltip="${t('explorer.showAllCategories')}"><svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
    <button class="detail-action-btn" id="explorer-deselect-all" data-tooltip="${t('explorer.hideAllCategories')}"><svg viewBox="0 0 24 24"><path d="M2 2l20 20"/><path d="M6.71 6.71C3.94 8.7 2.5 11.27 2.06 12c.86 2.15 3.64 7 9.94 7 2.08 0 3.82-.6 5.23-1.49"/><path d="M10 5.07A9.77 9.77 0 0 1 12 5c6.3 0 9.08 4.85 9.94 7-.35.87-.85 1.86-1.65 2.82"/></svg></button>
  </div>
  <div id="explorer-label-slider-row" class="explorer-slider-row" style="display:none">
    <input type="range" id="explorer-label-slider" min="0.3" max="2.5" step="0.1" value="1.0">
  </div>
  <div id="explorer-tree" class="explorer-tree"></div>
  <div class="explorer-footer">
    <span id="explorer-count">0 ${t('explorer.memoryCount.other', { count: '' }).trim()}</span>
  </div>
  <div class="explorer-resize-handle" id="explorer-resize-handle"></div>
</div>

<!-- Detail cards are spawned dynamically by ui-detail.js -->

<!-- Multi-select Action Bar -->
<div id="multi-select-bar" class="glass">
  <span id="multi-select-count">0 ${t('multiselect.selected.other', { count: '' }).trim()}</span>
  <button id="multi-select-move-cat">${t('multiselect.move')}</button>
  <button id="multi-select-export">${t('multiselect.export')}</button>
  <button id="multi-select-trash">${t('multiselect.trash')}</button>
  <button id="multi-select-clear">${t('multiselect.clear')}</button>
</div>

<!-- Stats Bar -->
<div id="stats-bar" class="glass">
  <div>${t('stats.memories')} <span class="stat-value" id="stat-total">0</span></div>
  <div class="stat-divider"></div>
  <div>${t('stats.visible')} <span class="stat-value" id="stat-visible">0</span></div>
  <div class="stat-divider"></div>
  <div>${t('stats.links')} <span class="stat-value" id="stat-links">0</span></div>
  <div class="stat-divider"></div>
  <div id="stat-search-status"></div>
</div>

<!-- Static background (shown when visualization is disabled) -->
<div id="static-bg">
  <img src="synabun.png?v=2" alt="SynaBun" class="static-bg-logo">
</div>

<!-- Graph Container -->
<div id="graph-container"></div>
`;
}

/**
 * Inject the shared HTML shell into the document body.
 * Call this once at the start of variant main.js, BEFORE any DOM queries.
 */
export function injectSharedHTML() {
  document.body.insertAdjacentHTML('afterbegin', getSharedHTML());
}
