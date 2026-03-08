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
      <span id="loading-action-label">${t('loading.startServer')}</span>
    </button>
    <div id="loading-action-status"></div>
  </div>
  <div id="loading-server-cmd">
    <div id="loading-server-cmd-hint">${t('loading.runCommand')}</div>
    <div id="loading-server-cmd-box">
      <code id="loading-cmd-text">node path/to/synabun/neural-interface/server.js</code>
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
      <a class="view-toggle-btn" href="/claude-chat.html" id="nav-chat-link" style="border-left:1px solid var(--b-subtle);padding-left:8px;margin-left:4px;" title="SynaBun Chat — rich Claude Code UI">Chat</a>
    </div>
    <div class="bar-sep"></div>

    <!-- OS-style menubar -->
    <div class="menubar">

      <!-- Apps menu -->
      <div class="menubar-item" data-menu="apps">
        <button class="menubar-label">${t('nav.apps')}</button>
        <div class="menubar-dropdown glass">
          <div class="menu-item" id="menu-terminal-claude">
            <span class="menu-check"></span>
            <span class="menu-text"><span class="menu-icon"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></svg></span> ${t('menu.apps.claudeCode')}</span>
            <span class="menu-shortcut" data-keybind-for="launch-claude"></span>
          </div>
          <div class="menu-item" id="menu-terminal-codex">
            <span class="menu-check"></span>
            <span class="menu-text"><span class="menu-icon"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"/></svg></span> ${t('menu.apps.codexCli')}</span>
            <span class="menu-shortcut" data-keybind-for="launch-codex"></span>
          </div>
          <div class="menu-item" id="menu-terminal-gemini">
            <span class="menu-check"></span>
            <span class="menu-text"><span class="menu-icon"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"/></svg></span> ${t('menu.apps.geminiCli')}</span>
            <span class="menu-shortcut" data-keybind-for="launch-gemini"></span>
          </div>
          <div class="menu-sep"></div>
          <div class="menu-item" id="menu-terminal-shell">
            <span class="menu-check"></span>
            <span class="menu-text"><span class="menu-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg></span> ${t('menu.apps.shell')}</span>
          </div>
          <div class="menu-item" id="menu-terminal-browser">
            <span class="menu-check"></span>
            <span class="menu-text"><span class="menu-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><ellipse cx="12" cy="12" rx="4" ry="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M4.5 7h15M4.5 17h15" stroke-width="1"/></svg></span> ${t('menu.apps.browser')}</span>
            <span class="menu-shortcut" data-keybind-for="launch-browser"></span>
          </div>
          <div class="menu-item" id="menu-terminal-youtube">
            <span class="menu-check"></span>
            <span class="menu-text"><span class="menu-icon"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg></span> ${t('menu.apps.youtube')}</span>
            <span class="menu-shortcut" data-keybind-for="launch-youtube"></span>
          </div>
          <div class="menu-item" id="menu-terminal-discord">
            <span class="menu-check"></span>
            <span class="menu-text"><span class="menu-icon"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg></span> Discord</span>
          </div>
          <div class="menu-item" id="menu-terminal-x">
            <span class="menu-check"></span>
            <span class="menu-text"><span class="menu-icon"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg></span> X</span>
          </div>
          <div class="menu-item" id="menu-terminal-whatsapp">
            <span class="menu-check"></span>
            <span class="menu-text"><span class="menu-icon"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg></span> WhatsApp</span>
          </div>
          <div class="menu-sep"></div>
          <div class="menu-item" id="menu-command-runner">
            <span class="menu-check"></span>
            <span class="menu-text"><span class="menu-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg></span> Command Runner</span>
          </div>
          <div class="menu-item" id="menu-terminal-link">
            <span class="menu-check"></span>
            <span class="menu-text"><span class="menu-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></span> Link Terminals</span>
          </div>
          <div class="menu-item menu-toggle" id="menu-terminal-toggle">
            <span class="menu-check">&#10003;</span>
            <span class="menu-text">${t('menu.apps.showTerminal')}</span>
            <span class="menu-shortcut">T</span>
          </div>
        </div>
      </div>

      <!-- Resume menu -->
      <div class="menubar-item" data-menu="resume">
        <button class="menubar-label">Resume</button>
        <div class="menubar-dropdown glass menubar-dropdown--resume">
          <div id="resume-list"></div>
        </div>
      </div>

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
          <div class="menu-item menu-toggle" id="menu-toggle-file-explorer">
            <span class="menu-check">&#10003;</span>
            <span class="menu-text">File Explorer</span>
            <span class="menu-shortcut" data-keybind-for="toggle-file-explorer"></span>
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
          <div class="menu-group-label">${t('menu.graph.nodeLimitGroup')}</div>
          <div class="menu-item menu-radio" data-group="node-limit" data-value="500">
            <span class="menu-check">&#10003;</span>
            <span class="menu-text">500</span>
          </div>
          <div class="menu-item menu-radio" data-group="node-limit" data-value="1000">
            <span class="menu-check">&#10003;</span>
            <span class="menu-text">1,000</span>
          </div>
          <div class="menu-item menu-radio" data-group="node-limit" data-value="2000">
            <span class="menu-check">&#10003;</span>
            <span class="menu-text">2,000</span>
          </div>
          <div class="menu-item menu-radio" data-group="node-limit" data-value="4000">
            <span class="menu-check">&#10003;</span>
            <span class="menu-text">4,000</span>
          </div>
          <div class="menu-item menu-radio active" data-group="node-limit" data-value="0">
            <span class="menu-check">&#10003;</span>
            <span class="menu-text">All</span>
          </div>
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

      <!-- Automations menu -->
      <div class="menubar-item" data-menu="automations">
        <button class="menubar-label">${t('nav.automations')}</button>
        <div class="menubar-dropdown glass">
          <div class="menu-item" id="menu-open-automation-studio">
            <span class="menu-check"></span>
            <span class="menu-text">${t('menu.automations.studio')}</span>
            <span class="menu-shortcut">A</span>
          </div>
          <div class="menu-sep"></div>
          <div class="menu-item" id="menu-automations-new">
            <span class="menu-check"></span>
            <span class="menu-text">${t('menu.automations.newAutomation')}</span>
          </div>
          <div class="menu-item" id="menu-automations-import">
            <span class="menu-check"></span>
            <span class="menu-text">${t('menu.automations.import')}</span>
          </div>
        </div>
      </div>

      <!-- Games menu -->
      <div class="menubar-item" data-menu="games">
        <button class="menubar-label">${t('nav.games')}</button>
        <div class="menubar-dropdown glass">
          <div class="menu-item" id="menu-game-tictactoe">
            <span class="menu-check"></span>
            <span class="menu-text"><span class="menu-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="2" x2="8" y2="22"/><line x1="16" y1="2" x2="16" y2="22"/><line x1="2" y1="8" x2="22" y2="8"/><line x1="2" y1="16" x2="22" y2="16"/></svg></span> ${t('menu.games.ticTacToe')}</span>
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
    <button id="titlebar-tutorial-btn" class="bar-icon" data-tooltip="Toggle Tutorial"><svg viewBox="0 0 24 24"><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><circle cx="12" cy="17" r=".5" fill="currentColor"/></svg></button>
    <button id="titlebar-viz-toggle" class="bar-icon active" data-tooltip="${t('tooltip.toggleViz')}"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/></svg></button>
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

  <button id="topright-keybinds-btn" class="topright-icon-btn" data-tooltip="Keybinds">
    <svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2" fill="none"/><line x1="6" y1="8" x2="6.01" y2="8"/><line x1="10" y1="8" x2="10.01" y2="8"/><line x1="14" y1="8" x2="14.01" y2="8"/><line x1="18" y1="8" x2="18.01" y2="8"/><line x1="6" y1="12" x2="6.01" y2="12"/><line x1="10" y1="12" x2="10.01" y2="12"/><line x1="14" y1="12" x2="14.01" y2="12"/><line x1="18" y1="12" x2="18.01" y2="12"/><line x1="8" y1="16" x2="16" y2="16"/></svg>
  </button>

  <div id="workspace-overlay">
    <div id="ws-indicator">
      <svg class="ws-icon" viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
      <span id="ws-active-name">No workspace</span>
      <button id="ws-quick-save" class="ws-quick-save" data-tooltip="Quick save"><svg viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg></button>
      <svg class="ws-chevron" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
    </div>
    <div id="ws-dropdown" style="display:none;">
      <div class="ws-save-bar">
        <input type="text" id="ws-name-input" placeholder="Save workspace..." autocomplete="off" spellcheck="false">
        <button id="ws-save-btn" data-tooltip="Save"><svg viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg></button>
      </div>
      <button id="ws-clear-btn" class="ws-new-btn"><svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>Clear workspace</button>
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
  <div id="invite-overlay">
    <button id="invite-btn" class="topright-icon-btn" data-tooltip="Share / Invite">
      <svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
      <span class="count-badge count-badge--blue" id="invite-session-count" style="display:none"></span>
    </button>
    <div id="invite-dropdown" style="display:none;"></div>
  </div>
  <div id="term-minimized-tray"></div>
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

<!-- File Explorer (docked sidebar) -->
<div id="file-explorer-panel">
  <div class="fe-project-row">
    <div class="fe-project-selector" id="fe-project-selector">
      <button class="fe-project-btn" id="fe-project-btn">
        <svg class="fe-project-icon" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        <span class="fe-project-label" id="fe-project-label">Project</span>
        <svg class="fe-project-chevron" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <div class="fe-project-dropdown" id="fe-project-dropdown"></div>
    </div>
    <button class="fe-branch-btn" id="fe-branch-btn" style="display:none">
      <svg viewBox="0 0 24 24"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
      <span class="fe-branch-btn-name" id="fe-branch-btn-name"></span>
      <span class="fe-branch-btn-badge" id="fe-branch-btn-badge"></span>
    </button>
  </div>
  <div class="fe-filter">
    <svg class="fe-filter-icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>
    <input type="text" id="fe-filter-input" placeholder="Search files..." autocomplete="off" spellcheck="false">
    <button id="fe-filter-clear">&times;</button>
  </div>
  <div class="fe-toolbar">
    <button class="detail-action-btn" id="fe-collapse-all" data-tooltip="Collapse all"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button>
    <button class="detail-action-btn" id="fe-expand-all" data-tooltip="Expand all"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h16M18 9v6"/></svg></button>
    <div class="detail-action-sep"></div>
    <button class="detail-action-btn" id="fe-sort-btn" data-tooltip="Sort: name"><svg viewBox="0 0 24 24"><path d="M3 6h7M3 12h5M3 18h3M16 4v16M12 16l4 4 4-4"/></svg></button>
    <div class="detail-action-sep"></div>
    <button class="detail-action-btn" id="fe-refresh" data-tooltip="Refresh"><svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>
  </div>
  <div id="fe-tree" class="fe-tree"></div>
  <div class="fe-footer">
    <span id="fe-count">0 items</span>
  </div>
  <div class="fe-resize-handle" id="fe-resize-handle"></div>
</div>

<!-- File Editor (separate panel, slides from file explorer's right edge) -->
<div id="fe-editor-panel" class="fe-editor-panel">
  <div class="fe-editor-header">
    <button class="fe-editor-back" id="fe-editor-back" data-tooltip="Close editor">
      <svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
    </button>
    <span class="fe-editor-dot" id="fe-editor-dot"></span>
    <span class="fe-editor-filepath" id="fe-editor-filepath"></span>
    <div style="flex:1"></div>
    <button class="fe-editor-action" id="fe-editor-find-btn" data-tooltip="Find (Ctrl+F)">
      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    </button>
    <button class="fe-editor-action" id="fe-editor-word-wrap" data-tooltip="Toggle word wrap">
      <svg viewBox="0 0 24 24"><path d="M3 6h18M3 12h15a3 3 0 1 1 0 6h-4"/><polyline points="16 16 14 18 16 20"/><path d="M3 18h7"/></svg>
    </button>
    <div class="fe-editor-help-wrap">
      <button class="fe-editor-action fe-editor-help-btn" id="fe-editor-help-btn" data-tooltip="Keyboard shortcuts">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      </button>
      <div class="fe-editor-keybinds" id="fe-editor-keybinds">
        <div class="fe-editor-keybinds-title">Keyboard Shortcuts</div>
        <div class="fe-editor-kb"><kbd>Ctrl+S</kbd> <span>Save</span></div>
        <div class="fe-editor-kb"><kbd>Ctrl+F</kbd> <span>Find</span></div>
        <div class="fe-editor-kb"><kbd>Ctrl+H</kbd> <span>Replace</span></div>
        <div class="fe-editor-kb"><kbd>Ctrl+G</kbd> <span>Go to Line</span></div>
        <div class="fe-editor-kb"><kbd>Ctrl+D</kbd> <span>Duplicate Line</span></div>
        <div class="fe-editor-kb"><kbd>Ctrl+/</kbd> <span>Toggle Comment</span></div>
        <div class="fe-editor-kb"><kbd>Tab</kbd> <span>Indent</span></div>
        <div class="fe-editor-kb"><kbd>Shift+Tab</kbd> <span>Unindent</span></div>
        <div class="fe-editor-kb"><kbd>Enter</kbd> <span>Auto-indent</span></div>
        <div class="fe-editor-kb"><kbd>Esc</kbd> <span>Close panel</span></div>
      </div>
    </div>
    <div class="fe-editor-sep"></div>
    <div class="fe-editor-view-toggle" id="fe-editor-view-toggle" style="display:none">
      <button class="fe-editor-toggle-btn active" data-mode="raw">Raw</button>
      <button class="fe-editor-toggle-btn" data-mode="preview">Preview</button>
    </div>
    <div class="fe-editor-sep" id="fe-editor-sep-preview" style="display:none"></div>
    <button class="fe-editor-btn" id="fe-editor-discard" disabled>Discard</button>
    <button class="fe-editor-btn fe-editor-save" id="fe-editor-save" disabled>Save</button>
    <button class="fe-editor-btn" id="fe-editor-close">Close</button>
  </div>
  <div class="fe-editor-find" id="fe-editor-find">
    <div class="fe-editor-find-row">
      <input type="text" class="fe-editor-find-input" id="fe-editor-find-input" placeholder="Find..." spellcheck="false" autocomplete="off" />
      <span class="fe-editor-find-count" id="fe-editor-find-count"></span>
      <button class="fe-editor-find-nav" id="fe-editor-find-prev" data-tooltip="Previous">
        <svg viewBox="0 0 24 24"><polyline points="18 15 12 9 6 15"/></svg>
      </button>
      <button class="fe-editor-find-nav" id="fe-editor-find-next" data-tooltip="Next">
        <svg viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <button class="fe-editor-find-nav" id="fe-editor-find-close" data-tooltip="Close">
        <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div class="fe-editor-replace-row">
      <input type="text" class="fe-editor-replace-input" id="fe-editor-replace-input" placeholder="Replace..." spellcheck="false" autocomplete="off" />
      <button class="fe-editor-replace-btn" id="fe-editor-replace">Replace</button>
      <button class="fe-editor-replace-btn" id="fe-editor-replace-all">All</button>
    </div>
  </div>
  <div class="fe-editor-goto" id="fe-editor-goto">
    <span class="fe-editor-goto-label">Go to Line</span>
    <input type="number" class="fe-editor-goto-input" id="fe-editor-goto-input" min="1" placeholder="Line..." />
  </div>
  <div class="fe-editor-body">
    <div class="fe-editor-gutter" id="fe-editor-gutter"></div>
    <div class="fe-editor-line-highlight" id="fe-editor-line-highlight"></div>
    <pre class="fe-editor-highlight" id="fe-editor-highlight" aria-hidden="true"><code id="fe-editor-highlight-code"></code></pre>
    <textarea class="fe-editor-textarea" id="fe-editor-textarea"
      spellcheck="false" autocorrect="off" autocapitalize="off"></textarea>
    <div class="fe-editor-preview" id="fe-editor-preview"></div>
    <div class="fe-editor-scrollmap" id="fe-editor-scrollmap">
      <div class="fe-editor-scrollmap-thumb" id="fe-editor-scrollmap-thumb"></div>
    </div>
  </div>
  <div class="fe-editor-statusbar">
    <span id="fe-editor-lang"></span>
    <div style="flex:1"></div>
    <span id="fe-editor-cursor">Ln 1, Col 1</span>
    <span class="fe-editor-sep"></span>
    <span id="fe-editor-size"></span>
    <span class="fe-editor-sep"></span>
    <span>UTF-8</span>
  </div>
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

<!-- Static background (shown in Focus Mode) -->
<div id="static-bg">
  <div class="focus-breathe"></div>
  <img src="synabun.png?v=2" alt="SynaBun" class="static-bg-logo">

  <!-- Whiteboard (Focus Mode canvas) -->
  <div id="wb-root">
    <div id="wb-toolbar" class="glass">
      <button class="wb-tool active" data-tool="select" data-tooltip="Select">
        <svg viewBox="0 0 24 24"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/></svg>
      </button>
      <button class="wb-tool" id="wb-multiselect" data-tooltip="Multi-select (drag to select)">
        <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="1" fill="none" stroke-dasharray="3 2"/><path d="M8 2v2M14 2v2M20 8h2M20 14h2M8 20v2M14 20v2M2 8h2M2 14h2"/></svg>
      </button>
      <button class="wb-tool" data-tool="text" data-tooltip="Text · hold Ctrl = multi">
        <svg viewBox="0 0 24 24"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>
      </button>
      <button class="wb-tool" data-tool="list" data-tooltip="List · hold Ctrl = multi">
        <svg viewBox="0 0 24 24"><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4" cy="6" r="1.5" fill="currentColor"/><circle cx="4" cy="12" r="1.5" fill="currentColor"/><circle cx="4" cy="18" r="1.5" fill="currentColor"/></svg>
      </button>
      <button class="wb-tool" data-tool="arrow" data-tooltip="Arrow · hold Ctrl = multi">
        <svg viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
      </button>
      <button class="wb-tool" data-tool="shape" data-tooltip="Shape · hold Ctrl = multi">
        <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" fill="none"/><circle cx="12" cy="12" r="4" fill="none"/></svg>
      </button>
      <button class="wb-tool" data-tool="pen" data-tooltip="Pencil · hold Ctrl = multi">
        <svg viewBox="0 0 24 24"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
      </button>
      <div class="wb-tool-sep"></div>
      <button class="wb-tool" id="wb-color-btn" data-tooltip="Color">
        <span id="wb-color-dot"></span>
      </button>
      <div id="wb-color-picker" class="glass" style="display:none;"></div>
      <div class="wb-tool-sep"></div>
      <button class="wb-tool" id="wb-undo" data-tooltip="Undo (Ctrl+Z)">
        <svg viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
      </button>
      <button class="wb-tool" id="wb-redo" data-tooltip="Redo (Ctrl+Shift+Z)">
        <svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
      </button>
      <div class="wb-tool-sep"></div>
      <button class="wb-tool" id="wb-delete" data-tooltip="Delete (Del)">
        <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
      <div class="wb-tool-sep"></div>
      <button class="wb-tool wb-tool-sm" id="wb-toggle-logo" data-tooltip="Toggle logo">
        <img src="logo-synabun.png" alt="" style="width:18px;height:auto;opacity:0.6;">
      </button>
    </div>

    <div id="wb-canvas">
      <svg id="wb-arrows" class="wb-arrow-layer">
        <defs>
          <marker id="wb-arrowhead" markerWidth="42" markerHeight="44" refX="4" refY="22" orient="auto" markerUnits="userSpaceOnUse" overflow="visible">
            <path d="M 4 4 L 40 22 L 4 40 Z" fill="rgba(255,255,255,0.9)" stroke="none"/>
          </marker>
          <marker id="wb-arrowhead-sel" markerWidth="42" markerHeight="44" refX="4" refY="22" orient="auto" markerUnits="userSpaceOnUse" overflow="visible">
            <path d="M 4 4 L 40 22 L 4 40 Z" fill="var(--accent-blue, #60a5fa)" stroke="none"/>
          </marker>
        </defs>
      </svg>
      <div id="wb-elements"></div>
    </div>

    <svg id="wb-arrow-preview" class="wb-arrow-preview">
      <defs>
        <marker id="wb-arrowhead-preview" markerWidth="42" markerHeight="44" refX="4" refY="22" orient="auto" markerUnits="userSpaceOnUse" overflow="visible">
          <path d="M 4 4 L 40 22 L 4 40 Z" fill="rgba(255,255,255,0.3)" stroke="none"/>
        </marker>
      </defs>
    </svg>
  </div>
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
