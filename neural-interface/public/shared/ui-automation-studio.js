// ═══════════════════════════════════════════
// SynaBun Neural Interface — Automation Studio
// Browse, configure, launch, and track loop automations.
// Powered by SynaBun memory + browser integration.
// ═══════════════════════════════════════════

import { emit, on } from './state.js';
import { storage } from './storage.js';
import { isGuest, hasPermission, showGuestToast } from './ui-sync.js';
// sendToPanel removed — all launches use floating browser only
import {
  fetchLoopTemplates,
  createLoopTemplate,
  updateLoopTemplate,
  deleteLoopTemplate,
  importLoopTemplates,
  fetchActiveLoop,
  launchLoop,
  stopLoop,
  launchAgent,
  fetchAgents,
  fetchAgent,
  stopAgent,
  removeAgent,
  fetchSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  testSchedule,
  startScheduleTimer,
  cancelScheduleTimer,
  fetchScheduleTimers,
  createQuickTimer,
  fetchQuickTimers,
  cancelQuickTimer,
  triggerQuickTimerNow,
} from './api.js';

const $ = (id) => document.getElementById(id);

// ── Module-local state ──
let _panel = null;
let _backdrop = null;
let _templates = [];       // user-created templates from API
let _activeLoop = null;    // current active loop status
let _view = 'welcome';    // 'welcome' | 'picker' | 'detail' | 'wizard' | 'running'
let _selected = null;      // currently open template in detail view
let _filterCategory = 'all';
let _searchQuery = '';
let _pollTimer = null;
let _prevLoopActive = false;

// Cleanup: stored references for document-level listeners so closePanel() can remove them
let _docListeners = [];

// Detail/editor state
let _metaDirty = false;
let _detailDirty = false;
let _editorContent = '';
let _originalContent = '';
let _previewMode = false;
let _fetchSeq = 0;

// Wizard state
let _wizardState = null;
let _wizardStep = 0;
let _wizardPreset = null;

// Agent state
let _agents = [];           // live agent list from server
let _agentOutputs = {};     // agentId → accumulated text chunks for live display
let _agentRecentTools = {}; // agentId → last N tool names for live feed
let _agentJournals = {};    // agentId → journal entries from iteration-complete events
let _launchMode = 'loop';   // 'loop' | 'agent' — which mode the launch dialog uses
const _launchDestination = 'cli'; // always floating — side panel launch removed

// Schedule state
let _schedules = [];        // all schedules from API
let _editingSchedule = null; // schedule being edited, or null for new
let _scheduleTimerData = {}; // scheduleId → { firesAt, minutes }
let _quickTimers = [];       // active quick timers from API
let _showAdvancedSchedules = false;
let _selectedQtMinutes = null; // currently selected quick timer preset
let _qtUsesBrowser = null;     // null = use template default, true/false = user override

// ── Constants ──
const PANEL_KEY = 'neural-panel-automation-studio';
const POLL_INTERVAL = 5000;

const CATEGORY_LABELS = {
  social: 'Social',
  productivity: 'Productivity',
  monitoring: 'Monitoring',
  custom: 'Custom',
};

const CATEGORY_COLORS = {
  social: 'hsla(200, 40%, 55%, 0.9)',
  productivity: 'hsla(160, 40%, 55%, 0.9)',
  monitoring: 'hsla(35, 50%, 58%, 0.9)',
  custom: 'hsla(270, 30%, 60%, 0.9)',
};

// ── SVG Icons (stroke-based, 16x16, matches Skills Studio pattern) ──
const _s = (d) => `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

const AS_ICONS = {
  // Social media icons
  twitter:    _s('<path d="M2 13c2.5 0 4.5-1 5.5-3 1 2 3.5 3 6.5 1"/><path d="M14 3c-1 .5-2 .8-3 .8C10 3 8.5 2.5 7 3.5c-1.5 1-1.5 3-.5 4"/>'),
  x:          `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M9.47 6.77L14.18 1.5h-1.11L8.97 6.03 5.82 1.5H1.5l4.95 7.2L1.5 14.5h1.11l4.33-5.03 3.46 5.03h4.32L9.47 6.77zm-1.53 1.78l-.5-.72L3.11 2.36h1.72l3.23 4.62.5.72 4.2 6.01h-1.72L7.94 8.55z"/></svg>`,
  instagram:  `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="12" height="12" rx="3"/><circle cx="8" cy="8" r="3"/><circle cx="11.5" cy="4.5" r="0.5" fill="currentColor" stroke="none"/></svg>`,
  facebook:   `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M14 8a6 6 0 10-6.94 5.93v-4.2H5.63V8h1.43V6.56c0-1.41.84-2.19 2.13-2.19.62 0 1.26.11 1.26.11v1.39h-.71c-.7 0-.92.43-.92.88V8h1.56l-.25 1.73H8.82v4.2A6 6 0 0014 8z"/></svg>`,
  linkedin:   `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M2 3.47c0-.8.66-1.47 1.47-1.47s1.47.66 1.47 1.47S4.28 4.93 3.47 4.93 2 4.28 2 3.47zM2.2 6h2.53v8H2.2V6zm4.27 0h2.43v1.09c.34-.64 1.16-1.3 2.4-1.3 2.56 0 3.03 1.69 3.03 3.88V14h-2.53V10.1c0-.93-.02-2.13-1.3-2.13-1.3 0-1.5 1.01-1.5 2.06V14H6.47V6z"/></svg>`,
  tiktok:     `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M11.73 3.32A3.05 3.05 0 0110.67 1h-2.2v9.48a1.82 1.82 0 01-1.82 1.67 1.82 1.82 0 01-.83-3.44V6.46a4.06 4.06 0 00-.83-.08A4.07 4.07 0 001 10.44 4.07 4.07 0 005 14.5a4.07 4.07 0 004.06-4.06V5.6a5.28 5.28 0 003.08 1v-2.2a3.05 3.05 0 01-.41-1.08z"/></svg>`,
  youtube:    `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M14.06 4.88a1.78 1.78 0 00-1.25-1.26C11.73 3.33 8 3.33 8 3.33s-3.73 0-4.81.29A1.78 1.78 0 001.94 4.88 18.7 18.7 0 001.65 8c-.02 1.06.08 2.12.29 3.12a1.78 1.78 0 001.25 1.26c1.08.29 4.81.29 4.81.29s3.73 0 4.81-.29a1.78 1.78 0 001.25-1.26c.21-1 .31-2.06.29-3.12.02-1.06-.08-2.12-.29-3.12zM6.6 10.15V5.85L10.24 8 6.6 10.15z"/></svg>`,
  whatsapp:   `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8.02 1.5A6.14 6.14 0 001.5 7.5a6.1 6.1 0 00.94 3.26L1.5 14.5l3.88-.94A6.14 6.14 0 0014.5 7.5 6.14 6.14 0 008.02 1.5zm3.57 8.68c-.15.43-.9.82-1.24.87-.34.05-.66.17-2.22-.46s-2.52-2.3-2.6-2.4c-.07-.1-.6-.8-.6-1.53s.38-1.08.52-1.23c.13-.15.3-.18.39-.18h.28c.09 0 .22-.03.34.26s.42 1.02.46 1.1c.04.07.06.15.01.24-.05.1-.07.15-.15.23-.07.08-.15.18-.22.24-.07.07-.15.15-.07.3.09.15.38.63.82 1.02.56.5 1.04.66 1.19.73.15.07.23.06.32-.04.09-.1.38-.43.48-.58.1-.15.2-.13.34-.07.13.05.85.4.99.47.15.07.24.11.28.17.04.07.04.4-.11.82z"/></svg>`,
  discord:    `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M12.36 3.8A11.5 11.5 0 009.5 2.93a.04.04 0 00-.05.02c-.12.22-.26.52-.36.75a10.6 10.6 0 00-3.18 0A7.4 7.4 0 005.55 2.95a.04.04 0 00-.05-.02 11.5 11.5 0 00-2.86.87.04.04 0 00-.02.01A11.7 11.7 0 001 10.98a.05.05 0 00.02.03 11.6 11.6 0 003.5 1.77.05.05 0 00.05-.01c.27-.37.51-.76.72-1.17a.04.04 0 00-.02-.06 7.6 7.6 0 01-1.1-.52.04.04 0 01-.004-.07l.22-.17a.04.04 0 01.05-.01 8.3 8.3 0 007.12 0 .04.04 0 01.05.01l.22.17a.04.04 0 01-.003.07c-.35.2-.72.37-1.1.52a.04.04 0 00-.02.06c.21.41.45.8.72 1.17a.05.05 0 00.05.02 11.56 11.56 0 003.5-1.78.05.05 0 00.02-.03c.29-2.97-.48-5.55-2.04-7.84a.04.04 0 00-.02-.02zM5.68 9.5c-.68 0-1.24-.63-1.24-1.4s.55-1.4 1.24-1.4c.7 0 1.25.63 1.24 1.4 0 .77-.55 1.4-1.24 1.4zm4.58 0c-.68 0-1.24-.63-1.24-1.4s.55-1.4 1.24-1.4c.7 0 1.25.63 1.24 1.4 0 .77-.54 1.4-1.24 1.4z"/></svg>`,

  // General purpose icons
  search:     _s('<circle cx="7" cy="7" r="4"/><path d="M14 14l-3.5-3.5"/>'),
  research:   _s('<path d="M3 2h10M3 6h10M3 10h7"/><circle cx="13" cy="12" r="2"/><path d="M11.5 10.5l-1-1"/>'),
  chart:      _s('<path d="M3 14V8M7 14V4M11 14V9M15 14V6"/><path d="M1 14h14"/>'),
  mail:       _s('<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 5l6 4 6-4"/>'),
  globe:      _s('<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c-2 2-2 10 0 12M8 2c2 2 2 10 0 12"/>'),
  monitor:    _s('<rect x="2" y="2" width="12" height="9" rx="1.5"/><path d="M5 14h6M8 11v3"/>'),
  code:       _s('<polyline points="5 4.5 2 8 5 11.5"/><polyline points="11 4.5 14 8 11 11.5"/>'),
  pencil:     _s('<path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5z"/>'),
  chat:       _s('<path d="M3 3h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 3v-3H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/>'),
  refresh:    _s('<path d="M3 8a5 5 0 0 1 9-3M13 8a5 5 0 0 1-9 3"/><polyline points="3 3 3 6 6 6"/><polyline points="13 13 13 10 10 10"/>'),
  brain:      _s('<path d="M8 2C6 2 4.5 3.5 4.5 5c-1.5.5-2.5 2-2 3.5.5 1.5 2 2.5 3.5 2.5M8 2c2 0 3.5 1.5 3.5 3 1.5.5 2.5 2 2 3.5-.5 1.5-2 2.5-3.5 2.5M8 2v12"/><path d="M5 8h6"/>'),
  plus:       _s('<path d="M8 3v10M3 8h10"/>'),
  bolt:       _s('<path d="M9 2L4 9h4l-1 5 5-7H8l1-5z"/>'),
  blank:      _s('<rect x="3" y="2" width="10" height="12" rx="1.5"/><path d="M6 6h4M6 9h2"/>'),

  clock:      _s('<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 2.5"/>'),

  // External SVG logos (fill-based, from public/ directory)
  claude:     `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" fill-rule="evenodd"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></svg>`,
  openai:     `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" fill-rule="evenodd"><path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"/></svg>`,
  gemini:     `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" fill-rule="evenodd"><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"/></svg>`,
  leonardo:   `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M9.5 2l1.5 3.5L14.5 7l-3.5 1.5L9.5 12l-1.5-3.5L4.5 7l3.5-1.5L9.5 2zM19 10l1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2zM5 17l1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2z"/></svg>`,
  pin:        _s('<path d="M8 14v-3"/><path d="M4 11h8"/><path d="M10.5 2.5l3 3-2 2 .5 2-4.5.5.5-4.5 2-.5z"/>'),

  // UI chrome
  back:       _s('<path d="M10 3L5 8l5 5"/>'),
  forward:    _s('<path d="M6 3l5 5-5 5"/>'),
  down:       _s('<path d="M3 6l5 5 5-5"/>'),
  close:      _s('<path d="M4 4l8 8M12 4l-8 8"/>'),
  export:     _s('<path d="M8 2v8M4 6l4-4 4 4"/><path d="M2 11v2a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-2"/>'),
};

/** Resolve icon key → SVG HTML. Falls back to refresh icon for unknown keys. */
function icon(key) { return AS_ICONS[key] || AS_ICONS.refresh; }

/** Icon keys available for template selection (excludes UI-only icons). */
const ICON_KEYS = Object.keys(AS_ICONS).filter(k => !['back','forward','down','close','export','plus','bolt','blank'].includes(k));

// ── CLI profiles and model options ──
const CLI_PROFILES = [
  { id: 'claude-code', label: 'Claude Code', desc: 'Anthropic' },
  { id: 'codex',       label: 'Codex CLI',   desc: 'OpenAI' },
  { id: 'gemini',      label: 'Gemini CLI',  desc: 'Google' },
];

const CLI_MODELS = {
  'claude-code': [
    { id: 'claude-opus-4-6',   label: 'Opus 4.6',   desc: 'Most capable', tier: 'top' },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6',  desc: 'Balanced', tier: 'default' },
    { id: 'claude-haiku-4-5',  label: 'Haiku 4.5',   desc: 'Fastest' },
  ],
  'codex': [
    { id: 'o3',      label: 'o3',      desc: 'Deep reasoning', tier: 'top' },
    { id: 'o4-mini', label: 'o4-mini', desc: 'Fast reasoning', tier: 'default' },
  ],
  'gemini': [
    { id: 'gemini-2.5-pro',   label: '2.5 Pro',   desc: 'Most capable', tier: 'default' },
    { id: 'gemini-2.5-flash', label: '2.5 Flash', desc: 'Lightweight' },
  ],
};

// Persistent launch preferences (remembered across launches in session)
let _launchProfile = storage.getItem('as-launch-profile') || 'claude-code';
let _launchModel = storage.getItem('as-launch-model') || null;

// ── Preset Templates with Wizard Steps ──

const PRESET_TEMPLATES = [
  {
    id: '__preset_social',
    name: 'Social Engagement',
    description: 'Browse a social platform, find relevant threads, and interact with posts.',
    task: 'Navigate to a social platform and engage with posts about a topic.',
    context: 'Use SynaBun browser tools only.',
    iterations: 50, maxMinutes: 120,
    icon: 'chat', category: 'social', usesBrowser: true,
    steps: [
      {
        title: 'Platform & Topic', subtitle: 'Where and what to engage with',
        buildContent(state) {
          const platform = state.platform || '';
          return `
            <div class="awiz-field">
              <label>Platform</label>
              <div class="awiz-chips" data-key="platform" data-mode="single">
                ${chip('Twitter/X', platform, 'twitter')} ${chip('LinkedIn', platform, 'linkedin')}
                ${chip('Facebook', platform, 'facebook')} ${chip('TikTok', platform, 'tiktok')}
                ${chip('Instagram', platform, 'instagram')} ${chip('Reddit', platform, 'reddit')}
              </div>
            </div>
            <div class="awiz-field">
              <label>Topics / Hashtags</label>
              <textarea data-key="topics" placeholder="e.g. #vibecoding, AI automation, building in public" rows="3">${esc(state.topics || '')}</textarea>
            </div>
            <div class="awiz-field">
              <label>Language</label>
              <input type="text" data-key="language" placeholder="e.g. English, Portuguese, match thread language" value="${esc(state.language || '')}" />
            </div>`;
        },
        validate(state) {
          if (!state.platform?.trim()) return 'Pick a platform';
          if (!state.topics?.trim()) return 'Enter at least one topic or hashtag';
          return null;
        },
      },
      {
        title: 'Persona & Tone', subtitle: 'How should the agent sound?',
        buildContent(state) {
          const tone = state.tone || 'casual';
          return `
            <div class="awiz-field">
              <label>Tone</label>
              <div class="awiz-chips" data-key="tone" data-mode="single">
                ${chip('Casual', tone, 'casual')} ${chip('Professional', tone, 'professional')}
                ${chip('Witty', tone, 'witty')} ${chip('Technical', tone, 'technical')}
              </div>
            </div>
            <div class="awiz-field">
              <label>Reply Length</label>
              <div class="awiz-chips" data-key="replyLength" data-mode="single">
                ${chip('Short (1-2 sentences)', state.replyLength || 'short', 'short')}
                ${chip('Medium (3-4 sentences)', state.replyLength, 'medium')}
              </div>
            </div>
            <div class="awiz-field">
              <label>Voice Notes <span class="awiz-optional">(optional)</span></label>
              <textarea data-key="voiceNotes" placeholder="e.g. Sound like a fellow developer. Be genuine, not salesy." rows="3">${esc(state.voiceNotes || '')}</textarea>
            </div>`;
        },
      },
      {
        title: 'Rules', subtitle: 'Behavioral constraints \u2014 order = priority',
        buildContent(state) {
          if (!Array.isArray(state.rules)) state.rules = [];
          const items = state.rules.map((rule, i) => `
            <div class="awiz-rule-item" draggable="true" data-rule-idx="${i}">
              <span class="awiz-rule-grip" data-tooltip="Drag to reorder">\u2261</span>
              <span class="awiz-rule-num">${i + 1}</span>
              <span class="awiz-rule-text">${esc(rule)}</span>
              <button class="awiz-rule-remove" data-remove-idx="${i}" data-tooltip="Remove">&times;</button>
            </div>`).join('');
          return `
            <div class="awiz-field">
              <div class="awiz-rule-add-row">
                <input type="text" id="awiz-rule-input" placeholder="e.g. Do NOT double post on the same thread" />
                <button class="awiz-rule-add-btn" id="awiz-rule-add">Add</button>
              </div>
              <div class="awiz-rules-list" id="awiz-rules-list">${items || '<div class="awiz-rules-empty">No rules yet.</div>'}</div>
              <span class="awiz-hint">Drag to reorder. Top rules have highest priority.</span>
            </div>`;
        },
        afterRender(container, state) { wireRulesListEvents(container, state); },
      },
    ],
    buildCommand(state) {
      const platformNames = { twitter: 'Twitter/X', linkedin: 'LinkedIn', facebook: 'Facebook', tiktok: 'TikTok', instagram: 'Instagram', reddit: 'Reddit' };
      const toneMap = { casual: 'casual and conversational', professional: 'professional and polished', witty: 'witty and engaging', technical: 'technical and informed' };
      const lengthMap = { short: '1-2 sentences max', medium: '3-4 sentences' };
      const rules = Array.isArray(state.rules) && state.rules.length > 0
        ? state.rules.map((r, i) => `  ${i + 1}. ${r}`).join('\n') : null;
      const lines = [
        `Navigate to ${platformNames[state.platform] || state.platform || '[PLATFORM]'} and find recent posts about:`,
        state.topics || '[TOPICS]', '',
        state.language ? `Language: ${state.language}.` : '',
        `Tone: ${toneMap[state.tone] || 'casual'}.`,
        `Reply length: ${lengthMap[state.replyLength] || '1-2 sentences max'}.`,
        state.voiceNotes ? `Voice: ${state.voiceNotes}` : '', '',
        rules ? `RULES (ordered by priority):\n${rules}` : '',
        '', 'Like posts you interact with.',
        'Be authentic. Add genuine value. Never be spammy.',
      ];
      return lines.filter(Boolean).join('\n');
    },
  },
  {
    id: '__preset_datacollect',
    name: 'Data Collection',
    description: 'Navigate websites and collect structured data into memory.',
    task: 'Visit websites and extract specific data points.',
    context: 'Use SynaBun browser tools to navigate. Store findings in memory.',
    iterations: 20, maxMinutes: 60,
    icon: 'folder', category: 'productivity', usesBrowser: true,
    steps: [
      {
        title: 'Source', subtitle: 'Where to collect data from',
        buildContent(state) {
          return `
            <div class="awiz-field">
              <label>Starting URL</label>
              <input type="text" data-key="startUrl" placeholder="https://example.com/listings" value="${esc(state.startUrl || '')}" />
            </div>
            <div class="awiz-field">
              <label>What to Collect</label>
              <textarea data-key="collectWhat" placeholder="e.g. Product names, prices, and URLs from each listing" rows="3">${esc(state.collectWhat || '')}</textarea>
            </div>`;
        },
        validate(state) {
          if (!state.startUrl?.trim()) return 'Enter a starting URL';
          if (!state.collectWhat?.trim()) return 'Describe what data to collect';
          return null;
        },
      },
      {
        title: 'Memory Storage', subtitle: 'Where to save collected data in SynaBun',
        buildContent(state) {
          return `
            <div class="awiz-field">
              <label>Category</label>
              <input type="text" data-key="storageCategory" placeholder="e.g. price-tracking" value="${esc(state.storageCategory || '')}" />
              <span class="awiz-hint">Child category under <strong>research</strong></span>
            </div>
            <div class="awiz-field">
              <label>Tags</label>
              <input type="text" data-key="storageTags" placeholder="e.g. data-collection, prices" value="${esc(state.storageTags || '')}" />
            </div>`;
        },
        validate(state) {
          if (!state.storageCategory?.trim()) return 'Choose a category for the data';
          return null;
        },
      },
    ],
    buildCommand(state) {
      const cat = (state.storageCategory || 'collected-data').trim().toLowerCase().replace(/\s+/g, '-');
      const tags = state.storageTags ? state.storageTags.split(',').map(t => `"${t.trim()}"`).join(', ') : '"data-collection"';
      const lines = [
        `Navigate to: ${state.startUrl || '[URL]'}`,
        `Collect: ${state.collectWhat || '[DESCRIBE DATA]'}`, '',
        'For each page, extract the requested data points.',
        'Paginate or scroll to load more results as needed.', '',
        'MEMORY STORAGE (MANDATORY):',
        'After each iteration, store collected data using the SynaBun `remember` tool:',
        `- category: "${cat}"`,
        `- tags: [${tags}]`,
        '- importance: 6',
        '- Content: Structured list of collected items with all requested fields.',
        `If category "${cat}" does not exist, first call \`category\` with action "create", name "${cat}", parent "research".`,
        'Do NOT skip the memory storage step.',
      ];
      return lines.filter(Boolean).join('\n');
    },
  },
  {
    id: '__preset_codereview',
    name: 'Code Review',
    description: 'Scan codebase for issues, code smells, and improvement opportunities.',
    task: 'Review code for bugs, security issues, and performance problems.',
    context: 'Prioritize high-impact issues. Be constructive.',
    iterations: 10, maxMinutes: 45,
    icon: 'search', category: 'productivity', usesBrowser: false,
    steps: [
      {
        title: 'Target', subtitle: 'What code should Claude review?',
        buildContent(state) {
          const areas = state.focusAreas || ['bugs', 'security'];
          return `
            <div class="awiz-field">
              <label>Directory or File Path</label>
              <input type="text" data-key="targetPath" placeholder="src/components/ or src/lib/services/auth.ts" value="${esc(state.targetPath || '')}" />
              <span class="awiz-hint">Leave empty to scan the entire project</span>
            </div>
            <div class="awiz-field">
              <label>Language / Framework</label>
              <input type="text" data-key="techStack" placeholder="TypeScript, React, Next.js" value="${esc(state.techStack || '')}" />
            </div>
            <div class="awiz-field">
              <label>Focus Areas</label>
              <div class="awiz-chips" data-key="focusAreas" data-mode="multi">
                ${mchip('Bugs', areas, 'bugs')} ${mchip('Security', areas, 'security')}
                ${mchip('Performance', areas, 'performance')} ${mchip('Readability', areas, 'readability')}
              </div>
            </div>`;
        },
      },
      {
        title: 'Standards', subtitle: 'How thorough should the review be?',
        buildContent(state) {
          const severity = state.severity || 'all';
          return `
            <div class="awiz-field">
              <label>Severity Threshold</label>
              <div class="awiz-chips" data-key="severity" data-mode="single">
                ${chip('Critical Only', severity, 'critical')} ${chip('All Issues', severity, 'all')}
              </div>
            </div>
            <div class="awiz-field">
              <label>Style Guide Notes <span class="awiz-optional">(optional)</span></label>
              <textarea data-key="styleNotes" placeholder="e.g. Follow ESLint config, prefer named exports" rows="3">${esc(state.styleNotes || '')}</textarea>
            </div>
            <div class="awiz-field">
              <label>Skip / Ignore <span class="awiz-optional">(optional)</span></label>
              <input type="text" data-key="skipPatterns" placeholder="test files, generated code" value="${esc(state.skipPatterns || '')}" />
            </div>`;
        },
      },
    ],
    buildCommand(state) {
      const lines = [
        state.targetPath ? `Review code in: ${state.targetPath}.` : 'Scan the codebase for issues.',
        state.techStack ? `Tech stack: ${state.techStack}.` : '',
        `Focus on: ${(state.focusAreas || ['bugs', 'security']).join(', ')}.`,
        `Severity: ${state.severity === 'critical' ? 'critical issues only' : 'all issues'}.`,
        state.styleNotes ? `Style guidelines: ${state.styleNotes}` : '',
        state.skipPatterns ? `Skip: ${state.skipPatterns}.` : '',
        'Document findings with file paths and line numbers. Suggest specific fixes.',
      ];
      return lines.filter(Boolean).join('\n');
    },
  },
  {
    id: '__preset_research',
    name: 'Content Research',
    description: 'Search topics, summarize findings, and collect useful references.',
    task: 'Research topics, summarize findings, collect references.',
    context: 'Focus on authoritative sources. Note conflicting viewpoints.',
    iterations: 8, maxMinutes: 30,
    icon: 'research', category: 'productivity', usesBrowser: true,
    steps: [
      {
        title: 'Topic', subtitle: 'Describe what Claude should research',
        buildContent(state) {
          const sources = state.sources || ['blogs', 'docs'];
          return `
            <div class="awiz-field">
              <label>Research Description</label>
              <textarea data-key="subject" placeholder="e.g. Find the latest WebSocket scaling patterns for Node.js." rows="4">${esc(state.subject || '')}</textarea>
            </div>
            <div class="awiz-field">
              <label>Source Preferences</label>
              <div class="awiz-chips" data-key="sources" data-mode="multi">
                ${mchip('Academic', sources, 'academic')} ${mchip('Blogs', sources, 'blogs')}
                ${mchip('Forums', sources, 'forums')} ${mchip('Docs', sources, 'docs')}
              </div>
            </div>`;
        },
        validate(state) { if (!state.subject?.trim()) return 'Describe what to research'; return null; },
      },
      {
        title: 'Rules', subtitle: 'Define rules for the research \u2014 order = priority',
        buildContent(state) {
          if (!Array.isArray(state.rules)) state.rules = [];
          const items = state.rules.map((rule, i) => `
            <div class="awiz-rule-item" draggable="true" data-rule-idx="${i}">
              <span class="awiz-rule-grip" data-tooltip="Drag to reorder">\u2261</span>
              <span class="awiz-rule-num">${i + 1}</span>
              <span class="awiz-rule-text">${esc(rule)}</span>
              <button class="awiz-rule-remove" data-remove-idx="${i}" data-tooltip="Remove">&times;</button>
            </div>`).join('');
          return `
            <div class="awiz-field">
              <div class="awiz-rule-add-row">
                <input type="text" id="awiz-rule-input" placeholder="e.g. Only use sources from the last 2 years" />
                <button class="awiz-rule-add-btn" id="awiz-rule-add">Add</button>
              </div>
              <div class="awiz-rules-list" id="awiz-rules-list">${items || '<div class="awiz-rules-empty">No rules yet.</div>'}</div>
              <span class="awiz-hint">Drag to reorder. Top rules have highest priority.</span>
            </div>`;
        },
        afterRender(container, state) { wireRulesListEvents(container, state); },
      },
      {
        title: 'Output', subtitle: 'How should findings be formatted?',
        buildContent(state) {
          const format = state.outputFormat || 'bullets';
          const depth = state.depth || 'moderate';
          return `
            <div class="awiz-field">
              <label>Format</label>
              <div class="awiz-chips" data-key="outputFormat" data-mode="single">
                ${chip('Bullet Summary', format, 'bullets')} ${chip('Detailed Notes', format, 'detailed')} ${chip('Annotated Links', format, 'links')}
              </div>
            </div>
            <div class="awiz-field">
              <label>Depth</label>
              <div class="awiz-chips" data-key="depth" data-mode="single">
                ${chip('Quick Scan', depth, 'quick')} ${chip('Moderate', depth, 'moderate')} ${chip('Deep Dive', depth, 'deep')}
              </div>
            </div>`;
        },
      },
      {
        title: 'Memory Storage', subtitle: 'Where should findings be saved in SynaBun?',
        buildContent(state) {
          return `
            <div class="awiz-field">
              <label>Research Name</label>
              <input type="text" data-key="researchName" placeholder="e.g. WebSocket Scaling Patterns" value="${esc(state.researchName || '')}" />
              <span class="awiz-hint">A short name to identify this research batch</span>
            </div>
            <div class="awiz-field">
              <label>Category</label>
              <input type="text" data-key="researchCategory" placeholder="e.g. websocket-scaling" value="${esc(state.researchCategory || '')}" />
              <span class="awiz-hint">Child category under <strong>research</strong></span>
            </div>`;
        },
        validate(state) {
          if (!state.researchName?.trim()) return 'Give this research a name';
          if (!state.researchCategory?.trim()) return 'Choose a category for the findings';
          return null;
        },
      },
    ],
    buildCommand(state) {
      const cat = (state.researchCategory || 'general').trim().toLowerCase().replace(/\s+/g, '-');
      const rules = Array.isArray(state.rules) && state.rules.length > 0
        ? state.rules.map((r, i) => `  ${i + 1}. ${r}`).join('\n') : null;
      const lines = [
        `Research: ${state.subject || 'the assigned topic'}.`,
        rules ? `RULES (ordered by priority \u2014 #1 is most important):\n${rules}` : '',
        `Preferred sources: ${(state.sources || ['blogs', 'docs']).join(', ')}.`,
        `Output format: ${state.outputFormat === 'detailed' ? 'detailed notes' : state.outputFormat === 'links' ? 'annotated links' : 'bullet summaries'}.`,
        `Depth: ${state.depth === 'deep' ? 'deep dive' : state.depth === 'quick' ? 'quick scan' : 'moderate'}.`,
        'Use browser tools to search the web. Prioritize authoritative sources.', '',
        'MEMORY STORAGE (MANDATORY):',
        `After each iteration, store your findings using the SynaBun \`remember\` tool with these EXACT parameters:`,
        `- category: "${cat}"`,
        `- tags: ["research", "${esc(state.researchName || 'unnamed').toLowerCase().replace(/\s+/g, '-')}"]`,
        `- importance: 7`,
        `- Content: Include the research name "${esc(state.researchName || '')}" as a header, then your findings for that iteration.`,
        `If category "${cat}" does not exist, first call the \`category\` tool with action "create", name "${cat}", parent "research".`,
        'Do NOT skip the memory storage step. Every iteration MUST produce at least one memory entry.',
      ];
      return lines.filter(Boolean).join('\n');
    },
  },
  {
    id: '__preset_monitoring',
    name: 'Site Monitoring',
    description: 'Check URLs for changes, errors, and performance issues.',
    task: 'Check sites for uptime, errors, and visual changes.',
    context: 'Record response times. Screenshot regressions.',
    iterations: 5, maxMinutes: 15,
    icon: 'chart', category: 'monitoring', usesBrowser: true,
    steps: [
      {
        title: 'Targets', subtitle: 'What URLs should Claude monitor?',
        buildContent(state) {
          const checks = state.checks || ['uptime', 'performance'];
          return `
            <div class="awiz-field">
              <label>URLs to Monitor</label>
              <textarea data-key="urls" placeholder="https://example.com\nhttps://api.example.com/health" rows="4">${esc(state.urls || '')}</textarea>
              <span class="awiz-hint">One URL per line</span>
            </div>
            <div class="awiz-field">
              <label>What to Check</label>
              <div class="awiz-chips" data-key="checks" data-mode="multi">
                ${mchip('Uptime', checks, 'uptime')} ${mchip('Visual Changes', checks, 'visual')}
                ${mchip('Performance', checks, 'performance')} ${mchip('SSL', checks, 'ssl')}
              </div>
            </div>`;
        },
        validate(state) { if (!state.urls?.trim()) return 'Enter at least one URL'; return null; },
      },
      {
        title: 'Alerts', subtitle: 'What thresholds and behaviors to use?',
        buildContent(state) {
          return `
            <div class="awiz-field">
              <label>Response Time Threshold (ms)</label>
              <input type="number" data-key="threshold" placeholder="3000" value="${state.threshold || ''}" />
              <span class="awiz-hint">Flag pages slower than this (default: 3000ms)</span>
            </div>
            <div class="awiz-field">
              <label>Screenshot on Change</label>
              <div class="awiz-chips" data-key="screenshotOnChange" data-mode="single">
                ${chip('Yes', state.screenshotOnChange ?? 'yes', 'yes')} ${chip('No', state.screenshotOnChange, 'no')}
              </div>
            </div>`;
        },
      },
    ],
    buildCommand(state) {
      const lines = [
        `Monitor these URLs:\n${state.urls || '(none specified)'}`,
        `Check for: ${(state.checks || ['uptime', 'performance']).join(', ')}.`,
        state.threshold ? `Flag responses slower than ${state.threshold}ms.` : '',
        (state.screenshotOnChange ?? 'yes') === 'yes' ? 'Take screenshots on visual changes.' : '',
        'Use browser tools to visit each URL. Report issues with evidence.',
      ];
      return lines.filter(Boolean).join('\n');
    },
  },
  {
    id: '__preset_inbox',
    name: 'Inbox Triage',
    description: 'Process messages, categorize by priority, and draft replies.',
    task: 'Triage inbox: categorize by urgency, draft replies.',
    context: 'Be concise. Prioritize time-sensitive items.',
    iterations: 10, maxMinutes: 30,
    icon: 'mail', category: 'productivity', usesBrowser: false,
    steps: [
      {
        title: 'Source', subtitle: 'Where are the messages coming from?',
        buildContent(state) {
          const platform = state.inboxPlatform || 'email';
          return `
            <div class="awiz-field">
              <label>Platform</label>
              <div class="awiz-chips" data-key="inboxPlatform" data-mode="single">
                ${chip('Email', platform, 'email')} ${chip('Slack', platform, 'slack')}
                ${chip('Discord', platform, 'discord')} ${chip('GitHub', platform, 'github')}
              </div>
            </div>
            <div class="awiz-field">
              <label>Priority Rules <span class="awiz-optional">(optional)</span></label>
              <textarea data-key="priorityRules" placeholder="e.g. Messages from @boss are always urgent" rows="3">${esc(state.priorityRules || '')}</textarea>
            </div>
            <div class="awiz-field">
              <label>Auto-Reply</label>
              <div class="awiz-chips" data-key="autoReply" data-mode="single">
                ${chip('Draft Only', state.autoReply || 'draft', 'draft')}
                ${chip('Auto-Send Low Priority', state.autoReply, 'auto-low')}
              </div>
            </div>`;
        },
      },
      {
        title: 'Actions', subtitle: 'What should Claude do with each message?',
        buildContent(state) {
          const draftStyle = state.draftStyle || 'concise';
          return `
            <div class="awiz-field">
              <label>Draft Style</label>
              <div class="awiz-chips" data-key="draftStyle" data-mode="single">
                ${chip('Concise', draftStyle, 'concise')} ${chip('Detailed', draftStyle, 'detailed')} ${chip('Friendly', draftStyle, 'friendly')}
              </div>
            </div>
            <div class="awiz-field">
              <label>Escalation Rules <span class="awiz-optional">(optional)</span></label>
              <textarea data-key="escalation" placeholder="e.g. Escalate billing issues to finance" rows="3">${esc(state.escalation || '')}</textarea>
            </div>`;
        },
      },
    ],
    buildCommand(state) {
      const lines = [
        `Triage ${state.inboxPlatform || 'email'} inbox.`,
        'Categorize each message: urgent, normal, low.',
        state.priorityRules ? `Priority rules:\n${state.priorityRules}` : '',
        `Reply mode: ${state.autoReply === 'auto-low' ? 'auto-send low-priority, draft rest' : 'draft only'}.`,
        `Draft style: ${state.draftStyle || 'concise'}.`,
        state.escalation ? `Escalation:\n${state.escalation}` : '',
        'Flag items requiring human decision.',
      ];
      return lines.filter(Boolean).join('\n');
    },
  },
];

// ═══════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════

function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function chip(label, currentVal, value) {
  const v = value ?? label;
  const active = (typeof currentVal === 'string' && currentVal.toLowerCase() === v.toLowerCase()) ? 'active' : '';
  return `<button class="awiz-chip ${active}" data-value="${esc(v)}">${esc(label)}</button>`;
}

function mchip(label, currentArr, value) {
  const active = Array.isArray(currentArr) && currentArr.includes(value) ? 'active' : '';
  return `<button class="awiz-chip ${active}" data-value="${esc(value)}">${esc(label)}</button>`;
}

function showToast(msg) {
  const existing = document.querySelector('.as-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'as-toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 3500);
}

function formatLoopCommand(taskText, state) {
  const lines = ['Start a loop with these settings:', `Task: ${taskText}`];
  if (state.usesBrowser) {
    lines.push('', 'BROWSER: This automation REQUIRES the SynaBun internal browser.',
      'Use ONLY SynaBun browser tools (browser_navigate, browser_go_back, browser_go_forward, browser_reload, browser_click, browser_fill, browser_type, browser_hover, browser_select, browser_press, browser_scroll, browser_upload, browser_snapshot, browser_content, browser_screenshot, browser_evaluate, browser_wait, browser_session, browser_extract_tweets, browser_extract_fb_posts, browser_extract_tiktok_videos, browser_extract_tiktok_search, browser_extract_tiktok_studio, browser_extract_tiktok_profile, browser_extract_wa_chats, browser_extract_wa_messages, browser_extract_ig_feed, browser_extract_ig_profile, browser_extract_ig_post, browser_extract_ig_reels, browser_extract_ig_search, browser_extract_li_feed, browser_extract_li_profile, browser_extract_li_post, browser_extract_li_notifications, browser_extract_li_messages, browser_extract_li_search_people, browser_extract_li_network, browser_extract_li_jobs).',
      'Start by calling browser_navigate with your target URL — it auto-creates a session.',
      'NEVER use Playwright plugin tools or WebFetch — they bypass the visible browser.');
  }
  lines.push(`Iterations: ${state.iterations}`);
  lines.push(`Time cap: ${state.maxMinutes} minutes`);
  return lines.join('\n');
}

const BROWSER_CONTEXT = 'BROWSER REQUIRED: Use ONLY SynaBun browser tools: browser_navigate, browser_go_back, browser_go_forward, browser_reload, browser_click, browser_fill, browser_type, browser_hover, browser_select, browser_press, browser_scroll, browser_upload, browser_snapshot, browser_content, browser_screenshot, browser_evaluate, browser_wait, browser_session, browser_extract_tweets, browser_extract_fb_posts, browser_extract_tiktok_videos, browser_extract_tiktok_search, browser_extract_tiktok_studio, browser_extract_tiktok_profile, browser_extract_wa_chats, browser_extract_wa_messages, browser_extract_ig_feed, browser_extract_ig_profile, browser_extract_ig_post, browser_extract_ig_reels, browser_extract_ig_search, browser_extract_li_feed, browser_extract_li_profile, browser_extract_li_post, browser_extract_li_notifications, browser_extract_li_messages, browser_extract_li_search_people, browser_extract_li_network, browser_extract_li_jobs. Start by calling browser_navigate with your target URL — it auto-creates a session. NEVER use Playwright plugin tools or WebFetch.';

// ── Inline launch panel ──
// Instead of an overlay modal, swap the detail content area with launch configuration

let _pendingLaunchParams = null; // stashed params while launch panel is open
let _launchPanelActive = false;  // whether the inline launch panel is showing
// Browser mode removed — automations use saved browser settings directly

function showLaunchInline(params) {
  // Enforce browser context before stashing
  if (params.usesBrowser && (!params.context || !params.context.includes('BROWSER REQUIRED'))) {
    params.context = BROWSER_CONTEXT;
  }
  _pendingLaunchParams = params;
  _launchPanelActive = true;

  // Render into detail content area if available, otherwise take over main area
  let contentEl = _panel?.querySelector('.as-detail-content');
  if (!contentEl) {
    // Non-detail context (wizard, welcome) — switch to a standalone launch view
    _view = 'launch';
    const main = $('as-main');
    if (!main) return;
    main.innerHTML = `<div class="as-detail-content as-launch-standalone"></div>`;
    contentEl = main.querySelector('.as-detail-content');
  }

  const profile = _launchProfile || 'claude-code';
  const models = CLI_MODELS[profile] || [];
  const defaultModel = models.find(m => m.tier === 'default') || models[0];
  const currentModel = _launchModel && models.some(m => m.id === _launchModel) ? _launchModel : defaultModel?.id;

  const iterCount = params.iterations || 10;
  const timeCount = params.maxMinutes || 30;

  contentEl.innerHTML = `
    <div class="as-launch-inline">
      <div class="as-launch-inline-header">
        <button class="as-launch-inline-back" data-action="launch-inline-close">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 2L4 7l5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <span class="as-launch-inline-title">Launch Configuration</span>
      </div>
      <div class="as-launch-inline-body">
        <div class="as-launch-section">
          <label class="as-launch-label">Mode</label>
          <div class="as-launch-mode-toggle">
            <button class="as-launch-mode${_launchMode === 'loop' ? ' active' : ''}" data-mode="loop">
              <span class="as-launch-mode-icon"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 8A6 6 0 1 1 8 2"/><polyline points="14 2 14 8 8 8"/></svg></span>
              Loop
            </button>
            <button class="as-launch-mode${_launchMode === 'agent' ? ' active' : ''}" data-mode="agent">
              <span class="as-launch-mode-icon"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="5" r="3"/><path d="M2 14c0-3.3 2.7-6 6-6s6 2.7 6 6"/></svg></span>
              Agent
            </button>
          </div>
        </div>
        <div class="as-launch-section">
          <label class="as-launch-label">CLI</label>
          <div class="as-launch-profiles" id="as-launch-profiles">
            ${CLI_PROFILES.map(p => `
              <button class="as-launch-profile${p.id === profile ? ' active' : ''}" data-profile="${p.id}">
                <span class="as-launch-profile-name">${p.label}</span>
                <span class="as-launch-profile-org">${p.desc}</span>
              </button>
            `).join('')}
          </div>
        </div>
        <div class="as-launch-section" id="as-launch-model-section">
          <label class="as-launch-label">Model</label>
          <div class="as-launch-models" id="as-launch-models">
            ${renderModelChips(profile, currentModel)}
          </div>
        </div>
        <div class="as-launch-section as-launch-summary">
          <div class="as-launch-summary-row">
            <span class="as-launch-summary-key">Task</span>
            <span class="as-launch-summary-val as-launch-summary-task">${esc((params.task || '').slice(0, 100))}${(params.task || '').length > 100 ? '\u2026' : ''}</span>
          </div>
          <div class="as-launch-loop-fields" ${_launchMode === 'agent' ? 'style="display:none"' : ''}>
            <div class="as-launch-summary-row">
              <span class="as-launch-summary-key">Iterations</span>
              <span class="as-launch-summary-val">${iterCount}</span>
            </div>
            <div class="as-launch-summary-row">
              <span class="as-launch-summary-key">Time cap</span>
              <span class="as-launch-summary-val">${timeCount} min</span>
            </div>
            ${params.usesBrowser ? `<div class="as-launch-summary-row"><span class="as-launch-summary-key">Browser</span><span class="as-launch-summary-val">Yes &mdash; uses your Browser settings</span></div>` : ''}
          </div>
          <div class="as-launch-agent-fields" ${_launchMode === 'loop' ? 'style="display:none"' : ''}>
            <div class="as-launch-summary-row">
              <span class="as-launch-summary-key">SynaBun</span>
              <label class="as-launch-toggle">
                <input type="checkbox" id="as-agent-synabun" checked>
                <span class="as-launch-toggle-label">Memory + Browser tools</span>
              </label>
            </div>
            <div class="as-launch-summary-row">
              <span class="as-launch-summary-key">Mode</span>
              <div class="as-launch-agent-mode-row">
                <button class="as-launch-agent-submode active" data-submode="single">Single</button>
                <button class="as-launch-agent-submode" data-submode="loop">Loop</button>
              </div>
            </div>
            <div class="as-launch-agent-loop-cfg" style="display:none">
              <div class="as-launch-summary-row">
                <span class="as-launch-summary-key">Iterations</span>
                <input type="number" id="as-agent-iterations" value="${iterCount}" min="1" max="50" class="as-launch-inline-input">
              </div>
              <div class="as-launch-summary-row">
                <span class="as-launch-summary-key">Time cap</span>
                <input type="number" id="as-agent-maxminutes" value="${timeCount}" min="1" max="480" class="as-launch-inline-input"> <span class="as-launch-unit">min</span>
              </div>
            </div>
            <div class="as-launch-summary-row">
              <span class="as-launch-summary-key">Isolation</span>
              <span class="as-launch-summary-val as-launch-isolation-badge">Process isolated &mdash; unique session per run</span>
            </div>
          </div>
        </div>
      </div>
      <div class="as-launch-inline-footer">
        <button class="as-launch-cancel" data-action="launch-inline-close">Cancel</button>
        <button class="as-launch-go" data-action="launch-inline-confirm" id="as-launch-confirm-btn">
          ${_launchMode === 'agent' ? 'Launch Agent' : 'Launch'}
        </button>
      </div>
    </div>
  `;

  wireLaunchInline(contentEl);
}

function renderModelChips(profileId, selectedModel) {
  const models = CLI_MODELS[profileId] || [];
  if (!models.length) return '<span class="as-launch-no-models">No model selection available</span>';
  return models.map(m => `
    <button class="as-launch-model${m.id === selectedModel ? ' active' : ''}${m.tier ? ` as-launch-model--${m.tier}` : ''}" data-model="${m.id}">
      <span class="as-launch-model-name">${m.label}</span>
      <span class="as-launch-model-desc">${m.desc}</span>
    </button>
  `).join('');
}

function wireLaunchInline(container) {
  const root = container.querySelector('.as-launch-inline');
  if (!root) return;

  // Mode toggle (Loop vs Agent)
  root.querySelectorAll('.as-launch-mode').forEach(btn => {
    btn.addEventListener('click', () => {
      root.querySelectorAll('.as-launch-mode').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _launchMode = btn.dataset.mode;
      const loopFields = root.querySelector('.as-launch-loop-fields');
      const agentFields = root.querySelector('.as-launch-agent-fields');
      if (loopFields) loopFields.style.display = _launchMode === 'loop' ? '' : 'none';
      if (agentFields) agentFields.style.display = _launchMode === 'agent' ? '' : 'none';
      const confirmBtn = root.querySelector('#as-launch-confirm-btn');
      if (confirmBtn) confirmBtn.textContent = _launchMode === 'agent' ? 'Launch Agent' : 'Launch';
    });
  });

  // Profile selection
  root.querySelectorAll('.as-launch-profile').forEach(btn => {
    btn.addEventListener('click', () => {
      root.querySelectorAll('.as-launch-profile').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const profileId = btn.dataset.profile;
      _launchProfile = profileId;
      storage.setItem('as-launch-profile', profileId);
      const models = CLI_MODELS[profileId] || [];
      const defaultModel = models.find(m => m.tier === 'default') || models[0];
      _launchModel = defaultModel?.id || null;
      storage.setItem('as-launch-model', _launchModel);
      const modelsContainer = root.querySelector('#as-launch-models');
      if (modelsContainer) {
        modelsContainer.innerHTML = renderModelChips(profileId, _launchModel);
        wireModelChips(root);
      }
    });
  });

  wireModelChips(root);

  // Agent submode toggle (Single vs Loop)
  root.querySelectorAll('.as-launch-agent-submode').forEach(btn => {
    btn.addEventListener('click', () => {
      root.querySelectorAll('.as-launch-agent-submode').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const loopCfg = root.querySelector('.as-launch-agent-loop-cfg');
      if (loopCfg) loopCfg.style.display = btn.dataset.submode === 'loop' ? '' : 'none';
    });
  });

  // Escape key to close
  const escHandler = (e) => {
    if (e.key === 'Escape') { closeLaunchInline(); document.removeEventListener('keydown', escHandler); }
  };
  document.addEventListener('keydown', escHandler);
  _docListeners.push(['keydown', escHandler]);
}

function wireModelChips(container) {
  container.querySelectorAll('.as-launch-model').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.as-launch-model').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _launchModel = btn.dataset.model;
      storage.setItem('as-launch-model', _launchModel);
    });
  });
}

function closeLaunchInline() {
  _pendingLaunchParams = null;
  _launchPanelActive = false;
  // Restore previous view
  if (_view === 'launch') {
    _view = 'welcome';
    renderView();
  } else if (_view === 'detail' && _selected) {
    renderDetailMain();
  }
}

async function confirmLaunch() {
  if (!_pendingLaunchParams) return;
  const params = { ..._pendingLaunchParams, profile: _launchProfile, model: _launchModel };

  // Read agent values BEFORE closing (closeLaunchInline re-renders detail view)
  const withSynabun = !!document.getElementById('as-agent-synabun')?.checked;
  const submodeBtn = document.querySelector('.as-launch-agent-submode.active');
  const agentSubmode = submodeBtn?.dataset?.submode || 'single';
  const agentIterations = parseInt(document.getElementById('as-agent-iterations')?.value || '1', 10);
  const agentMaxMinutes = parseInt(document.getElementById('as-agent-maxminutes')?.value || '30', 10);

  // Clear launch state (don't re-render detail — we're about to navigate away)
  _pendingLaunchParams = null;
  _launchPanelActive = false;

  // Agent mode — isolated spawn, optional SynaBun integration
  if (_launchMode === 'agent') {
    try {
      showToast(`Launching ${agentSubmode === 'loop' ? 'loop ' : ''}agent${withSynabun ? ' with SynaBun' : ''}...`);
      const result = await launchAgent({
        task: params.task,
        model: params.model || undefined,
        cwd: params.cwd || undefined,
        maxTurns: params.usesBrowser ? 100 : 75,
        withSynabun,
        browserProfile: (withSynabun && params.usesBrowser) ? true : undefined,
        mode: agentSubmode,
        iterations: agentSubmode === 'loop' ? agentIterations : 1,
        maxMinutes: agentSubmode === 'loop' ? agentMaxMinutes : 30,
        context: params.context || undefined,
      });
      if (!result?.ok) { showToast(result?.error || 'Failed to launch agent'); return; }
      _agentOutputs[result.agentId] = '';
      showToast('Agent launched');
      closePanel();
    } catch (err) { showToast('Agent launch failed: ' + (err.message || 'unknown error')); }
    return;
  }

  // Loop mode — route based on destination
  try {
    // Browser: loops reuse the shared system browser session (CDP).
    // Server opens a new tab per loop. If screencast is enabled, UI pre-creates the session.
    let dedicatedBrowserSessionId = null;
    if (params.usesBrowser) {
      // Check if screencast stream is disabled — if so, skip the client-side floating
      // browser window and let the server create a headful browser via Strategy 3.
      let streamDisabled = true;
      try {
        const cfgRes = await fetch('/api/browser/config');
        const cfgData = await cfgRes.json();
        streamDisabled = cfgData.config?.screencast?.disabled !== false;
      } catch {}

      if (!streamDisabled) {
        showToast('Opening browser...');
        const browserReady = new Promise((resolve) => {
          const unsub = on('sync:browser:created', (data) => { unsub(); resolve(data?.sessionId || null); });
          setTimeout(() => { unsub(); resolve(null); }, 12000);
        });
        emit('browser:open', { url: 'about:blank', force: true });
        dedicatedBrowserSessionId = await browserReady;
        if (dedicatedBrowserSessionId) {
          console.log('[AS] confirmLaunch: created dedicated browser session', dedicatedBrowserSessionId);
        }
      } else {
        console.log('[AS] confirmLaunch: stream disabled — server will create headful browser');
      }
    }

    // Pass the dedicated browser session ID to the server so it pins to this loop
    if (dedicatedBrowserSessionId) {
      params.browserSessionId = dedicatedBrowserSessionId;
    }

    // Launch as floating terminal + floating browser
    showToast('Launching loop...');
    emit('terminal:expect-managed');
    console.log('[AS] confirmLaunch: calling launchLoop, profile =', params.profile, ', usesBrowser =', params.usesBrowser);
    const result = await launchLoop(params);
    console.log('[AS] confirmLaunch: launchLoop result =', JSON.stringify(result));
    if (!result?.ok) {
      emit('terminal:attach-floating', {});
      showToast(result?.error || 'Failed to launch loop');
      return;
    }
    console.log('[AS] confirmLaunch: emitting terminal:attach-floating, terminalSessionId =', result.terminalSessionId);
    emit('terminal:attach-floating', {
      terminalSessionId: result.terminalSessionId,
      profile: params.profile || 'claude-code',
      initialMessage: '[SynaBun Loop] Begin task.',
      autoSubmit: true,
    });
    const profileLabel = CLI_PROFILES.find(p => p.id === params.profile)?.label || params.profile;
    showToast(`Loop started — ${profileLabel} launching...`);
    closePanel();
  } catch (err) {
    // Clear the managed-terminal flag since we won't emit terminal:attach-floating
    emit('terminal:attach-floating', {});
    console.error('[AS] confirmLaunch: caught error:', err);
    showToast('Launch failed: ' + (err.message || 'unknown error'));
  }
}

// Backward-compatible wrapper — all call sites use this, it now shows inline launch panel
async function serverLaunchLoop(params) {
  showLaunchInline(params);
}

function relativeTime(dateStr) {
  const d = new Date(dateStr);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

function buildTemplateCommand(template) {
  const isPreset = template.id?.startsWith('__preset_');
  if (isPreset && template.buildCommand) {
    return template.buildCommand(template._lastState || {});
  }
  let cmd = template.task || '';
  if (template.context) cmd += '\n\n' + template.context;
  return cmd;
}

// ═══════════════════════════════════════════
// PANEL LIFECYCLE
// ═══════════════════════════════════════════

export function initAutomationStudio() {
  on('automations:open', () => openPanel());
  on('automations:open-wizard', () => { openPanel(); });
  on('automations:open-schedules', () => { openPanel().then(() => { _view = 'schedules'; _selected = null; loadScheduleData().then(() => renderView()); }); });
  on('automations:import', () => { openPanel().then(() => triggerImport()); });
  setupAgentWebSocket();
  setupScheduleWebSocket();
}

async function openPanel() {
  if (isGuest() && !hasPermission('automations')) {
    showGuestToast('Automation Studio is disabled by the host');
    return;
  }
  if (_panel) { _panel.focus(); return; }

  // Backdrop
  _backdrop = document.createElement('div');
  _backdrop.className = 'studio-backdrop';
  // Backdrop click disabled — close only via ESC or close button
  document.body.appendChild(_backdrop);

  _panel = document.createElement('div');
  _panel.className = 'automation-studio-panel glass resizable';
  _panel.id = 'automation-studio-panel';
  _panel.innerHTML = buildPanelHTML();
  document.body.appendChild(_panel);

  // Always open centered at default size
  _panel.style.left = Math.max(20, (window.innerWidth - 900) / 2) + 'px';
  _panel.style.top = Math.max(48, (window.innerHeight - 520) / 2) + 'px';

  wirePanel();
  await loadData();
  renderView();
  requestAnimationFrame(() => { _backdrop.classList.add('open'); _panel.classList.add('open'); });
  startPolling();
}

function closePanel() {
  if (!_panel) return;
  stopPolling();
  // Remove all document-level listeners added during this panel's lifetime
  for (const [evt, fn] of _docListeners) document.removeEventListener(evt, fn);
  _docListeners = [];
  if (_backdrop) { _backdrop.remove(); _backdrop = null; }
  _panel.remove(); _panel = null;
  _templates = []; _activeLoop = null;
  _view = 'welcome'; _selected = null;
  resetDirty(); _editorContent = ''; _originalContent = '';
  _previewMode = false;
  _wizardState = null; _wizardStep = 0; _wizardPreset = null;
  _prevLoopActive = false; _fetchSeq = 0;
}

function buildPanelHTML() {
  return `
    <div class="resize-handle resize-handle-t" data-resize="t"></div>
    <div class="resize-handle resize-handle-r" data-resize="r"></div>
    <div class="resize-handle resize-handle-b" data-resize="b"></div>
    <div class="resize-handle resize-handle-l" data-resize="l"></div>
    <div class="resize-handle resize-handle-tl" data-resize="tl"></div>
    <div class="resize-handle resize-handle-tr" data-resize="tr"></div>
    <div class="resize-handle resize-handle-bl" data-resize="bl"></div>
    <div class="resize-handle resize-handle-br" data-resize="br"></div>

    <div class="as-header drag-handle" data-drag="automation-studio-panel">
      <div class="as-header-left">
        <button class="as-sidebar-toggle" id="as-sidebar-toggle" data-tooltip="Toggle sidebar">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 4h12M2 8h12M2 12h12"/></svg>
        </button>
        <h3>Automation Studio</h3>
        <span class="as-count" id="as-total-count"></span>
      </div>
      <div class="as-header-actions">
        <button class="as-header-btn" id="as-new-btn">+ New</button>
        <button class="as-header-btn" id="as-schedules-btn">${AS_ICONS.clock} Schedules</button>
        <button class="as-header-btn" id="as-import-btn">Import</button>
      </div>
      <button class="backdrop-toggle-btn" id="as-backdrop-toggle" data-tooltip="Toggle backdrop">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
      </button>
      <button class="as-close" id="as-close">&times;</button>
    </div>

    <div class="as-body">
      <aside class="as-sidebar" id="as-sidebar">
        <div class="as-search-wrap">
          <input type="text" class="as-search" id="as-search" placeholder="Filter..." autocomplete="off" spellcheck="false">
        </div>
        <div class="as-filters">
          <button class="as-filter active" data-cat="all">All</button>
          <button class="as-filter" data-cat="social">Social</button>
          <button class="as-filter" data-cat="productivity">Productivity</button>
          <button class="as-filter" data-cat="monitoring">Monitoring</button>
          <button class="as-filter" data-cat="custom">Custom</button>
        </div>
        <div class="as-template-list" id="as-template-list"></div>
        <div class="as-sidebar-footer" id="as-sidebar-footer" style="display:none">
          <div class="as-loop-indicator" data-action="view-running">
            <span class="as-running-pulse"></span>
            <div class="as-loop-indicator-info">
              <span class="as-loop-indicator-name" id="as-loop-indicator-name">Loop Active</span>
              <span class="as-loop-indicator-detail" id="as-loop-indicator-detail"></span>
            </div>
            <button class="as-loop-stop-mini" data-action="force-stop" data-tooltip="Stop">\u25A0</button>
          </div>
        </div>
      </aside>
      <main class="as-main" id="as-main"></main>
    </div>
  `;
}

function wirePanel() {
  $('as-close')?.addEventListener('click', closePanel);
  $('as-new-btn')?.addEventListener('click', () => { _view = 'picker'; _selected = null; renderView(); });
  $('as-schedules-btn')?.addEventListener('click', () => { _view = 'schedules'; _selected = null; loadScheduleData().then(() => renderView()); });
  $('as-import-btn')?.addEventListener('click', () => triggerImport());

  $('as-sidebar-toggle')?.addEventListener('click', () => {
    const sidebar = $('as-sidebar');
    if (sidebar) {
      sidebar.classList.toggle('as-sidebar--force-show');
      $('as-sidebar-toggle')?.classList.toggle('active', sidebar.classList.contains('as-sidebar--force-show'));
    }
  });

  $('as-backdrop-toggle')?.addEventListener('click', () => {
    if (_backdrop) {
      _backdrop.classList.toggle('backdrop-hidden');
      $('as-backdrop-toggle')?.classList.toggle('active', _backdrop.classList.contains('backdrop-hidden'));
    }
  });

  $('as-search')?.addEventListener('input', (e) => {
    _searchQuery = e.target.value.toLowerCase();
    renderSidebar();
  });

  _panel.querySelectorAll('.as-filter[data-cat]').forEach(btn => {
    btn.addEventListener('click', () => {
      _filterCategory = btn.dataset.cat;
      _panel.querySelectorAll('.as-filter[data-cat]').forEach(b => b.classList.toggle('active', b === btn));
      renderSidebar();
    });
  });

  // Delegated click handler for all data-action buttons
  _panel.addEventListener('click', (e) => handlePanelClick(e));

  // Escape key
  const onEsc = (e) => {
    if (e.key === 'Escape' && _panel) {
      if (_view === 'launch') { closeLaunchInline(); return; }
      if (_view === 'schedule-editor') { _view = 'schedules'; _editingSchedule = null; renderView(); return; }
      if (_view === 'schedules') { _view = 'welcome'; renderView(); return; }
      if (_view === 'wizard') { _view = _selected ? 'detail' : 'welcome'; renderView(); return; }
      if (_view === 'detail' || _view === 'running' || _view === 'picker') {
        if (_detailDirty && !confirm('Discard unsaved changes?')) return;
        _view = 'welcome'; _selected = null; resetDirty(); renderView(); return;
      }
      closePanel();
      document.removeEventListener('keydown', onEsc);
    }
  };
  document.addEventListener('keydown', onEsc);
  _docListeners.push(['keydown', onEsc]);

  initDrag();
}

// ═══════════════════════════════════════════
// DRAG SUPPORT
// ═══════════════════════════════════════════

function initDrag() {
  const handle = _panel.querySelector('.drag-handle');
  if (!handle) return;
  let dragging = false, startX, startY, startLeft, startTop;
  handle.addEventListener('mousedown', (e) => {
    if (e.target.closest('button') || e.target.closest('input')) return;
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    const rect = _panel.getBoundingClientRect();
    startLeft = rect.left; startTop = rect.top;
    e.preventDefault();
  });
  const onMove = (e) => {
    if (!dragging) return;
    _panel.style.left = (startLeft + e.clientX - startX) + 'px';
    _panel.style.top = (startTop + e.clientY - startY) + 'px';
  };
  const onUp = () => { dragging = false; };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  _docListeners.push(['mousemove', onMove], ['mouseup', onUp]);
}

// ═══════════════════════════════════════════
// DATA LOADING & POLLING
// ═══════════════════════════════════════════

async function loadData() {
  try { _templates = await fetchLoopTemplates(); } catch { _templates = []; }
  try { _activeLoop = await fetchActiveLoop(); } catch { _activeLoop = null; }
  await refreshAgents();
  updateSidebarFooter();
}

function startPolling() {
  stopPolling();
  _pollTimer = setInterval(async () => {
    if (!_panel) { stopPolling(); return; }
    try {
      const prev = _activeLoop?.active;
      _activeLoop = await fetchActiveLoop();
      await refreshAgents();
      updateSidebarFooter();

      if (prev && !_activeLoop?.active) {
        _prevLoopActive = false;
      }
      if (_view === 'running') renderRunningMain();
      // Refresh quick timer countdowns
      if (_view === 'schedules' && _quickTimers.length > 0) {
        document.querySelectorAll('.as-qt-active-countdown').forEach(el => {
          const card = el.closest('.as-qt-active-card');
          const cancelBtn = card?.querySelector('[data-action="qt-cancel"]');
          const timerId = cancelBtn?.dataset?.id;
          const qt = timerId && _quickTimers.find(t => t.id === timerId);
          if (qt) el.textContent = formatTimerCountdown(qt.firesAt);
        });
      }
    } catch {}
  }, POLL_INTERVAL);
}

function stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

function updateSidebarFooter() {
  const footer = $('as-sidebar-footer');
  const active = _activeLoop?.active;
  if (footer) footer.style.display = active ? '' : 'none';
  if (active && _activeLoop) {
    const nameEl = $('as-loop-indicator-name');
    const detailEl = $('as-loop-indicator-detail');
    if (nameEl) nameEl.textContent = (_activeLoop.task || 'Loop Active').slice(0, 40);
    if (detailEl) detailEl.textContent = `${_activeLoop.currentIteration || 0}/${_activeLoop.totalIterations} iterations`;
  }
}

// ═══════════════════════════════════════════
// VIEW MACHINE
// ═══════════════════════════════════════════

function renderView() {
  renderSidebar();
  const count = $('as-total-count');
  if (count) count.textContent = `${PRESET_TEMPLATES.length + _templates.length}`;

  switch (_view) {
    case 'welcome': renderWelcomeMain(); break;
    case 'picker': renderPickerMain(); break;
    case 'detail': renderDetailMain(); break;
    case 'wizard': renderWizardMain(); break;
    case 'running': renderRunningMain(); break;
    case 'schedules': renderSchedulesMain(); break;
    case 'schedule-editor': renderScheduleEditorMain(); break;
    case 'launch': break; // launch panel is rendered by showLaunchInline
  }
}

function filterTemplates(all) {
  return all.filter(t => {
    if (_filterCategory !== 'all' && t.category !== _filterCategory) return false;
    if (_searchQuery && !t.name.toLowerCase().includes(_searchQuery) && !t.description?.toLowerCase().includes(_searchQuery)) return false;
    return true;
  });
}

// ── Sidebar ──

function renderSidebar() {
  const list = $('as-template-list');
  if (!list) return;

  const all = [...PRESET_TEMPLATES, ..._templates];
  const filtered = filterTemplates(all);

  const groups = {};
  for (const t of filtered) {
    const cat = t.category || 'custom';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(t);
  }

  let html = '';
  for (const [cat, items] of Object.entries(groups)) {
    html += `<div class="as-sidebar-group">
      <div class="as-sidebar-group-header">
        ${CATEGORY_LABELS[cat] || cat}
        <span class="as-sidebar-group-count">${items.length}</span>
      </div>`;
    for (const t of items) {
      const active = _selected?.id === t.id ? ' active' : '';
      const isPreset = t.id.startsWith('__preset_');
      const dot = isPreset ? '<span class="as-item-preset-dot"></span>' : '<span class="as-item-custom-dot"></span>';
      html += `<div class="as-sidebar-item${active}" data-action="open-detail" data-id="${t.id}">
        <div class="as-sidebar-icon">${icon(t.icon)}</div>
        <div class="as-sidebar-info">
          <div class="as-sidebar-name">${dot}${esc(t.name)}</div>
          <div class="as-sidebar-desc">${t.iterations}x \u00B7 ${t.maxMinutes}m${t.usesBrowser ? ' \u00B7 <span class="as-browser-dot"></span>' : ''}</div>
        </div>
      </div>`;
    }
    html += '</div>';
  }

  if (!filtered.length) html = '<div class="as-empty">No templates match your filter.</div>';
  const scrollTop = list.scrollTop;
  list.innerHTML = html;
  list.scrollTop = scrollTop;
}

// ── Welcome ──

function renderWelcomeMain() {
  const main = $('as-main');
  if (!main) return;
  const presetCount = PRESET_TEMPLATES.length;
  const customCount = _templates.length;

  main.innerHTML = `
    <div class="as-welcome">
      <div class="as-welcome-hero">
        <img src="synabun.png?v=2" alt="SynaBun" class="as-welcome-logo">
        <h2>Automation Studio</h2>
      </div>
      <p class="as-welcome-sub">Launch, edit, and track loop automations.</p>
      <div class="as-stats-row">
        <div class="as-stat">
          <span class="as-stat-num">${presetCount}</span>
          <span class="as-stat-label">Presets</span>
        </div>
        <div class="as-stat">
          <span class="as-stat-num">${customCount}</span>
          <span class="as-stat-label">Custom</span>
        </div>
      </div>
      <p class="as-welcome-hint">Select a template from the sidebar, or click + New to create one.</p>
    </div>
  `;
}

// ── Preset Picker (+ New) ──

function renderPickerMain() {
  const main = $('as-main');
  if (!main) return;

  const cards = PRESET_TEMPLATES.map(t => `
    <div class="as-picker-card" data-action="pick-preset" data-id="${t.id}">
      <div class="as-picker-icon">${icon(t.icon)}</div>
      <div class="as-picker-name">${esc(t.name)}</div>
      <div class="as-picker-desc">${esc(t.description)}</div>
      <div class="as-picker-meta">
        <span class="as-badge">${t.iterations}x</span>
        <span class="as-badge">${t.maxMinutes}m</span>
        ${t.usesBrowser ? '<span class="as-badge as-badge--browser">Browser</span>' : ''}
      </div>
    </div>
  `).join('');

  main.innerHTML = `
    <div class="as-picker">
      <div class="as-picker-header">
        <button class="as-back-btn" data-action="go-welcome">\u2190 Back</button>
        <h3>Choose a Starting Point</h3>
      </div>
      <p class="as-picker-sub">Pick a preset to configure with a guided wizard, or start from scratch.</p>
      <div class="as-picker-grid">
        ${cards}
        <div class="as-picker-card as-picker-card--blank" data-action="pick-blank">
          <div class="as-picker-icon as-picker-icon--blank">${AS_ICONS.plus}</div>
          <div class="as-picker-name">Blank</div>
          <div class="as-picker-desc">Start from scratch with an empty template.</div>
        </div>
      </div>
    </div>
  `;
}

// ── Detail/Editor View ──

function switchToDetail(template) {
  if (_detailDirty && _selected && _selected.id !== template.id) {
    if (!confirm('Discard unsaved changes?')) return;
  }
  const seq = ++_fetchSeq;
  _selected = template;
  _editorContent = buildTemplateCommand(template);
  _originalContent = _editorContent;
  resetDirty();
  _previewMode = false;
  _view = 'detail';
  if (seq !== _fetchSeq) return;
  renderView();
}

function renderDetailMain() {
  const main = $('as-main');
  if (!main || !_selected) return;
  const t = _selected;
  const isPreset = t.id.startsWith('__preset_');

  main.innerHTML = `
    <div class="as-detail-header">
      <button class="as-back-btn" data-action="go-welcome">\u2190 Templates</button>
      <span class="as-detail-icon">${icon(t.icon)}</span>
      <span class="as-detail-name">${esc(t.name)}</span>
      <span class="as-badge as-badge--cat" style="--cat-color:${CATEGORY_COLORS[t.category] || 'var(--t-muted)'}">${esc(CATEGORY_LABELS[t.category] || t.category)}</span>
      ${isPreset ? '<span class="as-badge as-badge--preset">Preset</span>' : ''}
      <span class="as-detail-spacer"></span>
      ${isPreset ? `<button class="as-header-btn as-customize-btn" data-action="customize">Customize</button>` : ''}
      ${!isPreset ? `
        <button class="as-header-btn" data-action="export-one" data-id="${t.id}">\u2193 Export</button>
        <button class="as-header-btn as-discard-btn" id="as-discard" disabled>Discard</button>
        <button class="as-header-btn as-save-btn" id="as-save" disabled>Save</button>
        <button class="as-header-btn as-delete-btn" data-action="delete-template" data-id="${t.id}">\u2715</button>
      ` : ''}
    </div>

    <div class="as-detail-body">
      <div class="as-detail-meta" id="as-detail-meta">
        ${buildDetailMeta(t, isPreset)}
      </div>
      <div class="as-detail-content">
        <div class="as-md-toolbar" id="as-md-toolbar">
          <button class="ss-md-tool" data-cmd="heading" data-tooltip="Heading"><svg viewBox="0 0 24 24"><path d="M4 4v16M20 4v16M4 12h16"/></svg></button>
          <button class="ss-md-tool" data-cmd="bold" data-tooltip="Bold (Ctrl+B)"><b style="font-size:13px">B</b></button>
          <button class="ss-md-tool" data-cmd="italic" data-tooltip="Italic (Ctrl+I)"><i style="font-size:13px">I</i></button>
          <button class="ss-md-tool" data-cmd="strikethrough" data-tooltip="Strikethrough"><s style="font-size:12px">S</s></button>
          <div class="ss-md-toolbar-sep"></div>
          <button class="ss-md-tool" data-cmd="ul" data-tooltip="Bullet list"><svg viewBox="0 0 24 24"><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="5" cy="6" r="1.5" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="5" cy="18" r="1.5" fill="currentColor" stroke="none"/></svg></button>
          <button class="ss-md-tool" data-cmd="ol" data-tooltip="Numbered list"><svg viewBox="0 0 24 24"><line x1="10" y1="6" x2="20" y2="6"/><line x1="10" y1="12" x2="20" y2="12"/><line x1="10" y1="18" x2="20" y2="18"/><text x="4" y="8" font-size="7" fill="currentColor" stroke="none" font-weight="600">1</text><text x="4" y="14" font-size="7" fill="currentColor" stroke="none" font-weight="600">2</text><text x="4" y="20" font-size="7" fill="currentColor" stroke="none" font-weight="600">3</text></svg></button>
          <button class="ss-md-tool" data-cmd="quote" data-tooltip="Blockquote"><svg viewBox="0 0 24 24"><path d="M3 6h18M3 12h18M3 18h12"/><rect x="1" y="5" width="2" height="14" rx="1" fill="currentColor" stroke="none" opacity="0.4"/></svg></button>
          <div class="ss-md-toolbar-sep"></div>
          <button class="ss-md-tool" data-cmd="code" data-tooltip="Inline code"><svg viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg></button>
          <button class="ss-md-tool" data-cmd="codeblock" data-tooltip="Code block"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><polyline points="9 8 5 12 9 16" stroke-width="1.5"/><polyline points="15 8 19 12 15 16" stroke-width="1.5"/></svg></button>
          <button class="ss-md-tool" data-cmd="link" data-tooltip="Link (Ctrl+K)"><svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></button>
          <button class="ss-md-tool" data-cmd="hr" data-tooltip="Horizontal rule">&mdash;</button>
          <div class="ss-view-toggle">
            <button class="ss-view-toggle-btn${_previewMode ? '' : ' active'}" data-mode="raw">Raw</button>
            <button class="ss-view-toggle-btn${_previewMode ? ' active' : ''}" data-mode="preview">Preview</button>
          </div>
        </div>
        <textarea class="as-cmd-editor${_previewMode ? ' as-hidden' : ''}" id="as-cmd-editor"
          spellcheck="false" autocorrect="off" autocapitalize="off"
          ${isPreset ? 'readonly' : ''}>${esc(_editorContent)}</textarea>
        <div class="as-cmd-preview${_previewMode ? ' visible' : ''}" id="as-cmd-preview"></div>
        <div class="as-detail-actions">
          <button class="as-action-btn" data-action="copy-cmd">
            <svg viewBox="0 0 24 24" width="14" height="14"><rect x="9" y="9" width="13" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" fill="none" stroke="currentColor" stroke-width="2"/></svg>
            Copy
          </button>
          ${isPreset ? `<button class="as-action-btn" data-action="reconfigure">Wizard</button>` : ''}
          <div class="as-action-spacer"></div>
          <button class="as-action-btn as-action-btn--test" data-action="test-run">Test (1 iter)</button>
          <button class="as-action-btn as-action-btn--launch" data-action="launch-loop">
            <svg viewBox="0 0 24 24" width="14" height="14"><polyline points="4 17 10 11 4 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><line x1="12" y1="19" x2="20" y2="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            Launch
          </button>
        </div>
      </div>
    </div>
  `;

  wireDetailView(isPreset);
}

function buildDetailMeta(t, isPreset) {
  const disabled = isPreset ? 'disabled readonly' : '';
  return `
    <div class="as-meta-section">
      <div class="as-field">
        <label>Name</label>
        <input type="text" class="as-input" id="as-f-name" value="${esc(t.name)}" ${disabled} />
      </div>
      <div class="as-field">
        <label>Category</label>
        ${isPreset
          ? `<span class="as-value-text">${esc(CATEGORY_LABELS[t.category] || t.category)}</span>`
          : `<div class="as-cat-picker" id="as-cat-picker">
              <input type="hidden" id="as-f-category" value="${esc(t.category || 'custom')}">
              <button type="button" class="as-cat-picker-trigger" id="as-cat-trigger">
                <span class="as-cat-picker-label">${esc(CATEGORY_LABELS[t.category] || t.category || 'Custom')}</span>
                <span class="as-icon-picker-chevron">${AS_ICONS.down}</span>
              </button>
              <div class="as-cat-picker-menu" id="as-cat-menu">
                ${Object.entries(CATEGORY_LABELS).map(([k, v]) =>
                  `<button type="button" class="as-cat-picker-item${k === (t.category || 'custom') ? ' selected' : ''}" data-cat="${k}">${esc(v)}</button>`
                ).join('')}
              </div>
            </div>`
        }
      </div>
      <div class="as-field">
        <label>Description</label>
        <textarea class="as-textarea" id="as-f-desc" rows="3" ${disabled}>${esc(t.description || '')}</textarea>
      </div>
      <div class="as-field">
        <label>Iterations <span class="as-range-val" id="as-f-iter-val">${t.iterations}</span></label>
        <input type="range" class="as-range" id="as-f-iterations" min="1" max="200" value="${t.iterations}" />
      </div>
      <div class="as-field">
        <label>Time cap <span class="as-range-val" id="as-f-min-val">${t.maxMinutes}m</span></label>
        <input type="range" class="as-range" id="as-f-maxminutes" min="1" max="480" value="${t.maxMinutes}" />
      </div>
      <div class="as-field as-field--toggle">
        <label>Uses Browser</label>
        <label class="as-toggle">
          <input type="checkbox" id="as-f-browser" ${t.usesBrowser ? 'checked' : ''} ${isPreset ? 'disabled' : ''}>
          <span class="as-toggle-track"></span>
        </label>
      </div>
      ${isPreset ? `
        <div class="as-meta-divider"></div>
        <div class="as-preset-hint">
          Built-in preset.
          <button class="as-inline-link" data-action="reconfigure">Re-run Wizard</button> to change parameters, or
          <button class="as-inline-link" data-action="customize">Customize</button> to create an editable copy.
        </div>
      ` : `
        <div class="as-meta-divider"></div>
        <div class="as-field">
          <label>Icon</label>
          <div class="as-icon-picker" id="as-icon-picker">
            <input type="hidden" id="as-f-icon" value="${esc(t.icon || 'refresh')}">
            <button type="button" class="as-icon-picker-trigger" id="as-icon-trigger">
              <span class="as-icon-picker-preview">${icon(t.icon || 'refresh')}</span>
              <span class="as-icon-picker-label">${esc(t.icon || 'refresh')}</span>
              <span class="as-icon-picker-chevron">${AS_ICONS.down}</span>
            </button>
            <div class="as-icon-picker-menu" id="as-icon-menu">
              ${ICON_KEYS.map(k =>
                `<button type="button" class="as-icon-picker-item${k === (t.icon || 'refresh') ? ' selected' : ''}" data-icon="${k}" data-tooltip="${k}">${icon(k)}</button>`
              ).join('')}
            </div>
          </div>
        </div>
      `}
    </div>
  `;
}

function wireDetailView(isPreset) {
  // Sliders
  const iterSlider = $('as-f-iterations');
  const iterVal = $('as-f-iter-val');
  if (iterSlider && iterVal) iterSlider.addEventListener('input', () => { iterVal.textContent = iterSlider.value; if (!isPreset) markDirty(); });
  const minSlider = $('as-f-maxminutes');
  const minVal = $('as-f-min-val');
  if (minSlider && minVal) minSlider.addEventListener('input', () => { minVal.textContent = minSlider.value + 'm'; if (!isPreset) markDirty(); });

  // Browser toggle
  const browserToggle = $('as-f-browser');
  if (browserToggle && !isPreset) browserToggle.addEventListener('change', () => markDirty());

  // Editor textarea
  const editor = $('as-cmd-editor');
  if (editor && !isPreset) {
    editor.addEventListener('input', () => {
      _editorContent = editor.value;
      _detailDirty = _metaDirty || (_editorContent !== _originalContent);
      updateDetailDirtyState();
    });
    editor.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = editor.selectionStart, end = editor.selectionEnd;
        editor.value = editor.value.substring(0, start) + '  ' + editor.value.substring(end);
        editor.selectionStart = editor.selectionEnd = start + 2;
        _editorContent = editor.value;
      }
      // Keyboard shortcuts
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'b') { e.preventDefault(); mdWrap(editor, '**', '**'); }
        else if (e.key === 'i') { e.preventDefault(); mdWrap(editor, '*', '*'); }
        else if (e.key === 'k') { e.preventDefault(); mdLink(editor); }
      }
    });
  }

  // Metadata field dirty tracking
  if (!isPreset) {
    _panel?.querySelectorAll('#as-detail-meta input:not([type="range"]):not([type="checkbox"]), #as-detail-meta textarea, #as-detail-meta select').forEach(el => {
      el.addEventListener('input', () => markDirty());
      el.addEventListener('change', () => markDirty());
    });
  }

  // Icon picker & category picker
  wireIconPicker(isPreset);
  wireCategoryPicker(isPreset);

  // Markdown toolbar
  wireMdToolbar();

  // Preview toggle
  _panel?.querySelectorAll('.ss-view-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      _previewMode = mode === 'preview';
      _panel.querySelectorAll('.ss-view-toggle-btn').forEach(b => b.classList.toggle('active', b === btn));
      const ed = $('as-cmd-editor');
      const prev = $('as-cmd-preview');
      const toolbar = $('as-md-toolbar');
      if (ed) ed.classList.toggle('as-hidden', _previewMode);
      if (prev) {
        prev.classList.toggle('visible', _previewMode);
        if (_previewMode) prev.innerHTML = `<pre style="white-space:pre-wrap;margin:0;font-size:12px;line-height:1.65;color:var(--t-primary)">${esc(ed?.value || '')}</pre>`;
      }
      if (toolbar) toolbar.querySelectorAll('.ss-md-tool').forEach(t => t.style.visibility = _previewMode ? 'hidden' : '');
    });
  });

  // Save/Discard
  $('as-save')?.addEventListener('click', () => saveCurrentTemplate());
  $('as-discard')?.addEventListener('click', () => {
    _editorContent = _originalContent;
    resetDirty();
    switchToDetail(_selected); // re-render with original data
  });
}

function wireIconPicker(isPreset) {
  if (isPreset) return;
  const picker = $('as-icon-picker');
  const trigger = $('as-icon-trigger');
  const menu = $('as-icon-menu');
  const hidden = $('as-f-icon');
  if (!picker || !trigger || !menu || !hidden) return;

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = menu.classList.contains('open');
    menu.classList.toggle('open', !isOpen);
    trigger.classList.toggle('open', !isOpen);
  });

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.as-icon-picker-item');
    if (!item) return;
    const key = item.dataset.icon;
    hidden.value = key;
    trigger.querySelector('.as-icon-picker-preview').innerHTML = icon(key);
    trigger.querySelector('.as-icon-picker-label').textContent = key;
    menu.querySelectorAll('.as-icon-picker-item').forEach(i => i.classList.toggle('selected', i === item));
    menu.classList.remove('open');
    trigger.classList.remove('open');
    // Update detail header icon
    const headerIcon = _panel?.querySelector('.as-detail-icon');
    if (headerIcon) headerIcon.innerHTML = icon(key);
    markDirty();
  });

  // Close on click outside
  const closeIconPicker = (e) => {
    if (!picker.contains(e.target)) {
      menu.classList.remove('open');
      trigger.classList.remove('open');
    }
  };
  document.addEventListener('click', closeIconPicker);
  _docListeners.push(['click', closeIconPicker]);
}

function wireCategoryPicker(isPreset) {
  if (isPreset) return;
  const picker = $('as-cat-picker');
  const trigger = $('as-cat-trigger');
  const menu = $('as-cat-menu');
  const hidden = $('as-f-category');
  if (!picker || !trigger || !menu || !hidden) return;

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = menu.classList.contains('open');
    menu.classList.toggle('open', !isOpen);
    trigger.classList.toggle('open', !isOpen);
  });

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.as-cat-picker-item');
    if (!item) return;
    const key = item.dataset.cat;
    hidden.value = key;
    trigger.querySelector('.as-cat-picker-label').textContent = CATEGORY_LABELS[key] || key;
    menu.querySelectorAll('.as-cat-picker-item').forEach(i => i.classList.toggle('selected', i === item));
    menu.classList.remove('open');
    trigger.classList.remove('open');
    markDirty();
  });

  const closeCatPicker = (e) => {
    if (!picker.contains(e.target)) {
      menu.classList.remove('open');
      trigger.classList.remove('open');
    }
  };
  document.addEventListener('click', closeCatPicker);
  _docListeners.push(['click', closeCatPicker]);
}

function resetDirty() {
  _metaDirty = false;
  _detailDirty = false;
}

function markDirty() {
  _metaDirty = true;
  _detailDirty = true;
  updateDetailDirtyState();
}

function updateDetailDirtyState() {
  const saveBtn = $('as-save');
  const discardBtn = $('as-discard');
  if (saveBtn) { saveBtn.disabled = !_detailDirty; saveBtn.classList.toggle('dirty', _detailDirty); }
  if (discardBtn) discardBtn.disabled = !_detailDirty;
}

async function saveCurrentTemplate() {
  if (!_selected || _selected.id.startsWith('__preset_')) return;
  const name = $('as-f-name')?.value?.trim() || _selected.name;
  const category = $('as-f-category')?.value || _selected.category;
  const description = $('as-f-desc')?.value?.trim() || '';
  const iconKey = $('as-f-icon')?.value || _selected.icon || 'refresh';
  const iterations = parseInt($('as-f-iterations')?.value || '10', 10);
  const maxMinutes = parseInt($('as-f-maxminutes')?.value || '30', 10);
  const usesBrowser = $('as-f-browser')?.checked || false;
  const task = $('as-cmd-editor')?.value?.trim() || '';

  if (!name) { showToast('Name is required'); return; }
  if (!task) { showToast('Task description is required'); return; }

  const payload = { name, icon: iconKey, category, task, context: '', description: description || task.slice(0, 120), iterations, maxMinutes, usesBrowser };

  try {
    if (_selected.id) { await updateLoopTemplate(_selected.id, payload); }
    else { const result = await createLoopTemplate(payload); if (result?.id) _selected.id = result.id; }
    _templates = await fetchLoopTemplates();
    const updated = _templates.find(t => t.id === _selected.id);
    if (updated) _selected = updated;
    _originalContent = task;
    _editorContent = task;
    resetDirty();
    renderView();
    showToast('Saved');
  } catch (err) { showToast('Save failed: ' + err.message); }
}

// ── Markdown toolbar ──

function wireMdToolbar() {
  const toolbar = $('as-md-toolbar');
  if (!toolbar) return;
  toolbar.querySelectorAll('.ss-md-tool[data-cmd]').forEach(btn => {
    btn.addEventListener('click', () => {
      const editor = $('as-cmd-editor');
      if (!editor || editor.readOnly) return;
      const cmd = btn.dataset.cmd;
      switch (cmd) {
        case 'bold': mdWrap(editor, '**', '**'); break;
        case 'italic': mdWrap(editor, '*', '*'); break;
        case 'strikethrough': mdWrap(editor, '~~', '~~'); break;
        case 'code': mdWrap(editor, '`', '`'); break;
        case 'codeblock': mdWrap(editor, '\n```\n', '\n```\n'); break;
        case 'heading': mdPrefix(editor, '## '); break;
        case 'ul': mdPrefix(editor, '- '); break;
        case 'ol': mdPrefix(editor, '1. '); break;
        case 'quote': mdPrefix(editor, '> '); break;
        case 'link': mdLink(editor); break;
        case 'hr': {
          const s = editor.selectionStart;
          editor.value = editor.value.substring(0, s) + '\n---\n' + editor.value.substring(s);
          editor.selectionStart = editor.selectionEnd = s + 5;
          editor.focus();
          break;
        }
      }
      _editorContent = editor.value;
      if (_editorContent !== _originalContent) { _detailDirty = true; updateDetailDirtyState(); }
    });
  });
}

function mdWrap(editor, before, after) {
  const s = editor.selectionStart, e = editor.selectionEnd;
  const sel = editor.value.substring(s, e) || 'text';
  editor.value = editor.value.substring(0, s) + before + sel + after + editor.value.substring(e);
  editor.selectionStart = s + before.length;
  editor.selectionEnd = s + before.length + sel.length;
  editor.focus();
}

function mdPrefix(editor, prefix) {
  const s = editor.selectionStart, e = editor.selectionEnd;
  const val = editor.value;
  const lineStart = val.lastIndexOf('\n', s - 1) + 1;
  const lineEnd = val.indexOf('\n', e);
  const end = lineEnd < 0 ? val.length : lineEnd;
  const lines = val.substring(lineStart, end).split('\n');
  const toggled = lines.map(line => {
    if (line.startsWith(prefix)) return line.substring(prefix.length);
    // Strip other prefixes
    return prefix + line.replace(/^(#{1,6}\s|[-*]\s|\d+\.\s|>\s)/, '');
  });
  editor.value = val.substring(0, lineStart) + toggled.join('\n') + val.substring(end);
  editor.selectionStart = lineStart;
  editor.selectionEnd = lineStart + toggled.join('\n').length;
  editor.focus();
}

function mdLink(editor) {
  const s = editor.selectionStart, e = editor.selectionEnd;
  const sel = editor.value.substring(s, e) || 'text';
  const inserted = `[${sel}](url)`;
  editor.value = editor.value.substring(0, s) + inserted + editor.value.substring(e);
  editor.selectionStart = s + sel.length + 3;
  editor.selectionEnd = s + sel.length + 6;
  editor.focus();
}

// ── Customize (clone preset → custom) ──

async function customizePreset(preset) {
  try {
    const cmd = buildTemplateCommand(preset);
    const payload = {
      name: preset.name + ' (Custom)',
      icon: preset.icon,
      category: preset.category,
      task: cmd,
      context: '',
      iterations: parseInt($('as-f-iterations')?.value || String(preset.iterations), 10),
      maxMinutes: parseInt($('as-f-maxminutes')?.value || String(preset.maxMinutes), 10),
      usesBrowser: preset.usesBrowser || false,
      description: preset.description,
    };
    const result = await createLoopTemplate(payload);
    if (result?.id) {
      _templates = await fetchLoopTemplates();
      const newTpl = _templates.find(t => t.id === result.id);
      if (newTpl) {
        showToast('Customized \u2014 edit and save your copy');
        switchToDetail(newTpl);
      }
    }
  } catch (err) { showToast('Customize failed: ' + err.message); }
}

// ── Test Run ──

function handleTestRun() {
  if (!_selected) return;
  const cmd = $('as-cmd-editor')?.value || _editorContent;
  const iterations = parseInt($('as-f-iterations')?.value || '1', 10);
  const maxMinutes = parseInt($('as-f-maxminutes')?.value || '10', 10);
  const browserEl = $('as-f-browser');
  const usesBrowser = browserEl ? browserEl.checked : (_selected.usesBrowser || false);
  serverLaunchLoop({
    task: cmd,
    context: null,
    iterations: 1, maxMinutes: 10,
    usesBrowser,
  });
}

// ── Launch ──

function handleLaunch() {
  if (!_selected) return;

  // If dirty and saveable (not a preset), show unsaved-changes modal
  const isPreset = _selected.id?.startsWith('__preset_');
  if (_detailDirty && !isPreset) {
    showUnsavedLaunchModal();
    return;
  }

  proceedWithLaunch();
}

function proceedWithLaunch() {
  const cmd = $('as-cmd-editor')?.value || _editorContent;
  const iterations = parseInt($('as-f-iterations')?.value || String(_selected.iterations), 10);
  const maxMinutes = parseInt($('as-f-maxminutes')?.value || String(_selected.maxMinutes), 10);
  const browserEl = $('as-f-browser');
  const usesBrowser = browserEl ? browserEl.checked : (_selected.usesBrowser || false);
  serverLaunchLoop({
    task: cmd,
    context: null,
    iterations, maxMinutes, usesBrowser,
  });
}

function showUnsavedLaunchModal() {
  _panel?.querySelector('.as-unsaved-dialog')?.remove();

  const html = `
    <div class="as-unsaved-dialog">
      <div class="as-unsaved-dialog-inner">
        <div class="as-unsaved-dialog-header">
          <span class="as-unsaved-dialog-title">Unsaved Changes</span>
          <button class="as-launch-dialog-close" data-action="unsaved-dialog-close">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M11 3L3 11M3 3l8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>
        </div>
        <div class="as-unsaved-dialog-body">
          <p class="as-unsaved-dialog-msg">You have unsaved changes to this automation. Save before launching?</p>
        </div>
        <div class="as-unsaved-dialog-footer">
          <button class="as-launch-cancel" data-action="unsaved-dialog-close">Cancel</button>
          <button class="as-launch-go" data-action="unsaved-save-launch">Save &amp; Continue</button>
        </div>
      </div>
    </div>
  `;

  _panel.insertAdjacentHTML('beforeend', html);
}

async function handleSaveAndLaunch() {
  const dialog = _panel?.querySelector('.as-unsaved-dialog');
  const btn = dialog?.querySelector('[data-action="unsaved-save-launch"]');
  if (btn) { btn.textContent = 'Saving…'; btn.disabled = true; }

  await saveCurrentTemplate();

  // saveCurrentTemplate resets _detailDirty on success
  if (!_detailDirty) {
    dialog?.remove();
    proceedWithLaunch();
  } else {
    // Save failed — restore button
    if (btn) { btn.textContent = 'Save & Continue'; btn.disabled = false; }
  }
}

// ═══════════════════════════════════════════
// WIZARD (rendered in main area)
// ═══════════════════════════════════════════

function openWizard(preset) {
  _wizardPreset = preset;
  _wizardStep = 0;
  _wizardState = {
    iterations: preset.iterations,
    maxMinutes: preset.maxMinutes,
    usesBrowser: preset.usesBrowser || false,
  };
  _view = 'wizard';
  renderView();
}

function renderWizardMain() {
  const main = $('as-main');
  if (!main || !_wizardPreset) return;
  const totalSteps = _wizardPreset.steps.length + 1;
  const stepNames = [..._wizardPreset.steps.map(s => s.title), 'Review'];

  main.innerHTML = `
    <div class="as-wizard">
      <div class="as-wizard-header">
        <button class="as-back-btn" data-action="cancel-wizard">\u2190 Cancel</button>
        <span class="as-wizard-icon">${icon(_wizardPreset.icon)}</span>
        <span class="as-wizard-title">${esc(_wizardPreset.name)}</span>
      </div>
      <div class="as-wizard-steps">
        ${stepNames.map((s, i) => `
          <div class="as-wiz-step${i === _wizardStep ? ' active' : ''}${i < _wizardStep ? ' done' : ''}">
            <span class="as-wiz-step-num">${i + 1}</span>
            <span class="as-wiz-step-label">${esc(s)}</span>
          </div>
        `).join('')}
      </div>
      <div class="as-wizard-body" id="as-wizard-body"></div>
      <div class="as-wizard-nav">
        <button class="as-header-btn" data-action="wizard-back" style="visibility:${_wizardStep === 0 ? 'hidden' : 'visible'}">\u2190 Back</button>
        <button class="as-header-btn as-save-btn" data-action="wizard-next">${_wizardStep === totalSteps - 2 ? 'Review' : _wizardStep >= totalSteps - 1 ? '' : 'Next \u2192'}</button>
      </div>
    </div>
  `;

  renderWizardStep();
}

function renderWizardStep() {
  const body = $('as-wizard-body');
  if (!body || !_wizardPreset) return;
  const totalSteps = _wizardPreset.steps.length + 1;
  const isLastStep = _wizardStep === totalSteps - 1;

  // Update step indicators
  _panel?.querySelectorAll('.as-wiz-step').forEach((el, i) => {
    el.classList.toggle('active', i === _wizardStep);
    el.classList.toggle('done', i < _wizardStep);
  });

  const backBtn = _panel?.querySelector('[data-action="wizard-back"]');
  const nextBtn = _panel?.querySelector('[data-action="wizard-next"]');
  if (backBtn) backBtn.style.visibility = _wizardStep === 0 ? 'hidden' : 'visible';

  if (isLastStep) {
    body.innerHTML = buildReviewStep();
    if (nextBtn) nextBtn.style.display = 'none';
    wireReviewEvents();
  } else {
    const step = _wizardPreset.steps[_wizardStep];
    body.innerHTML = `
      <div class="awiz-step-title">${esc(step.title)}</div>
      <div class="awiz-step-subtitle">${esc(step.subtitle)}</div>
      <div class="awiz-step-content">${step.buildContent(_wizardState)}</div>`;
    if (nextBtn) {
      nextBtn.style.display = '';
      nextBtn.textContent = _wizardStep === totalSteps - 2 ? 'Review' : 'Next \u2192';
    }
  }

  wireChipEvents(_panel);
  wireInputSync(_panel);
  if (!isLastStep) {
    const step = _wizardPreset.steps[_wizardStep];
    if (step?.afterRender) step.afterRender(_panel, _wizardState);
  }
}

function buildReviewStep() {
  const state = _wizardState;
  const preset = _wizardPreset;
  const command = preset.buildCommand(state);

  const summaryPairs = [];
  for (const step of preset.steps) {
    const tmp = document.createElement('div');
    tmp.innerHTML = step.buildContent(state);
    tmp.querySelectorAll('.awiz-field').forEach(field => {
      const label = field.querySelector('label')?.textContent?.replace(/\(optional\)/i, '').trim();
      if (!label) return;
      const input = field.querySelector('input, textarea');
      const chips = field.querySelector('.awiz-chips');
      let value = '';
      if (input && input.value) value = input.value;
      else if (chips) {
        value = Array.from(chips.querySelectorAll('.awiz-chip.active')).map(c => c.textContent).join(', ');
      }
      if (value) summaryPairs.push({ label, value });
    });
  }

  const summaryHtml = summaryPairs.map(p =>
    `<div class="awiz-summary-row"><span class="awiz-summary-label">${esc(p.label)}</span><span class="awiz-summary-value">${esc(p.value)}</span></div>`
  ).join('');

  return `
    <div class="awiz-step-title">Review & Launch</div>
    <div class="awiz-step-subtitle">Confirm your settings and go</div>
    <div class="awiz-summary">${summaryHtml}</div>
    <div class="awiz-controls">
      <div class="awiz-control-row">
        <label>Iterations</label>
        <input type="range" id="awiz-iterations" min="1" max="50" value="${state.iterations}" />
        <span class="awiz-range-val" id="awiz-iter-val">${state.iterations}</span>
      </div>
      <div class="awiz-control-row">
        <label>Time cap</label>
        <input type="range" id="awiz-minutes" min="1" max="480" value="${state.maxMinutes}" />
        <span class="awiz-range-val" id="awiz-min-val">${state.maxMinutes}m</span>
      </div>
    </div>
    ${state.usesBrowser ? '<div style="font-size:11px;color:hsla(210,40%,65%,0.9);margin-bottom:12px;display:flex;align-items:center;gap:6px"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> This automation uses browser tools</div>' : ''}
    <div class="awiz-command-preview">
      <div class="awiz-preview-label">Command Preview</div>
      <pre class="awiz-preview-text">${esc(formatLoopCommand(command, state))}</pre>
    </div>
    <div class="awiz-launch-actions">
      <button class="awiz-btn-copy" data-action="wizard-copy">
        <svg viewBox="0 0 24 24" width="16" height="16"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" fill="none" stroke="currentColor" stroke-width="2"/></svg>
        Copy Command
      </button>
      <button class="awiz-btn-launch" data-action="wizard-open-editor">
        <svg viewBox="0 0 24 24" width="16" height="16"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Open in Editor
      </button>
      <button class="awiz-btn-launch" data-action="wizard-launch">
        <svg viewBox="0 0 24 24" width="16" height="16"><polyline points="4 17 10 11 4 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><line x1="12" y1="19" x2="20" y2="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        Launch Terminal
      </button>
    </div>`;
}

function wireReviewEvents() {
  const iterSlider = $('awiz-iterations');
  const iterVal = $('awiz-iter-val');
  const minSlider = $('awiz-minutes');
  const minVal = $('awiz-min-val');

  if (iterSlider && iterVal) {
    iterSlider.addEventListener('input', () => {
      _wizardState.iterations = parseInt(iterSlider.value, 10);
      iterVal.textContent = iterSlider.value;
      updateWizardPreview();
    });
  }
  if (minSlider && minVal) {
    minSlider.addEventListener('input', () => {
      _wizardState.maxMinutes = parseInt(minSlider.value, 10);
      minVal.textContent = minSlider.value + 'm';
      updateWizardPreview();
    });
  }
}

function updateWizardPreview() {
  const pre = _panel?.querySelector('.awiz-preview-text');
  if (pre) pre.textContent = formatLoopCommand(_wizardPreset.buildCommand(_wizardState), _wizardState);
}

function collectInputValues() {
  if (!_panel) return;
  _panel.querySelectorAll('.awiz-step-content input[data-key], .awiz-step-content textarea[data-key]').forEach(input => {
    _wizardState[input.dataset.key] = input.type === 'number' ? Number(input.value) : input.value;
  });
  _panel.querySelectorAll('.awiz-chips').forEach(group => {
    const key = group.dataset.key;
    const mode = group.dataset.mode;
    if (mode === 'single') {
      const active = group.querySelector('.awiz-chip.active');
      if (active) _wizardState[key] = active.dataset.value;
    } else {
      _wizardState[key] = Array.from(group.querySelectorAll('.awiz-chip.active')).map(c => c.dataset.value);
    }
  });
}

// ═══════════════════════════════════════════
// RUNNING VIEW
// ═══════════════════════════════════════════

function renderRunningMain() {
  const main = $('as-main');
  if (!main) return;

  const hasLoop = _activeLoop?.active;
  const hasAgents = _agents.length > 0;

  if (!hasLoop && !hasAgents) {
    main.innerHTML = `
      <div class="as-detail-header">
        <button class="as-back-btn" data-action="go-welcome">\u2190 Back</button>
        <h3 style="font-size:14px;font-weight:600;color:var(--t-bright)">Running</h3>
      </div>
      <div class="as-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        <div>No automations running</div>
        <div style="margin-top:8px;font-size:11px;color:var(--t-faint)">Launch an automation from a template to see it here.</div>
      </div>`;
    return;
  }

  let html = `
    <div class="as-detail-header">
      <button class="as-back-btn" data-action="go-welcome">\u2190 Back</button>
      <h3 style="font-size:14px;font-weight:600;color:var(--t-bright)">Running</h3>
    </div>
    <div style="padding:16px;display:flex;flex-direction:column;gap:12px;overflow-y:auto;max-height:calc(100% - 52px)">`;

  // Active loop card
  if (hasLoop) {
    const loop = _activeLoop;
    const pct = loop.totalIterations > 0 ? Math.round((loop.currentIteration / loop.totalIterations) * 100) : 0;
    html += `
      <div class="as-running-card">
        <div class="as-running-header">
          <div class="as-running-label"><span class="as-running-pulse"></span> Loop Active</div>
          ${loop.usesBrowser ? '<span class="as-browser-indicator"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> Browser Active</span>' : ''}
        </div>
        <div class="as-running-task">${esc(loop.task)}</div>
        <div class="as-running-progress"><div class="as-running-progress-fill" style="width:${pct}%"></div></div>
        <div class="as-running-stats">
          <span>Iteration ${loop.currentIteration}/${loop.totalIterations}</span>
          <span>${loop.remainingMinutes ?? '?'}min remaining</span>
          <span>${loop.elapsedMinutes ?? '?'}min elapsed</span>
        </div>
        <div class="as-running-controls">
          <button class="as-btn-stop" data-action="force-stop">Stop</button>
        </div>
      </div>`;
  }

  // Agent cards
  for (const agent of _agents) {
    const statusClass = `as-agent-status--${agent.status}`;
    const statusLabel = agent.status === 'running' ? 'Running' : agent.status === 'completed' ? 'Completed' : agent.status === 'stopped' ? 'Stopped' : 'Failed';
    const elapsed = agentElapsed(agent);
    const preview = (_agentOutputs[agent.id] || agent.textOutput || '').slice(-300);
    const isLoop = agent.mode === 'loop' && agent.totalIterations > 1;
    const iterPct = isLoop && agent.totalIterations > 0 ? Math.round((agent.currentIteration / agent.totalIterations) * 100) : 0;
    const journal = _agentJournals[agent.id] || agent.journal || [];
    const recentTools = _agentRecentTools[agent.id] || agent.recentTools || [];
    const lastJournal = journal.length > 0 ? journal[journal.length - 1] : null;

    html += `
      <div class="as-agent-card ${statusClass}" data-agent-id="${agent.id}">
        <div class="as-agent-header">
          <div class="as-agent-label">
            ${agent.status === 'running' ? '<span class="as-running-pulse"></span>' : ''}
            <span class="as-agent-status-badge ${statusClass}">${statusLabel}</span>
            ${isLoop ? `<span class="as-agent-iter-badge">${agent.currentIteration}/${agent.totalIterations}</span>` : ''}
            <span class="as-agent-model">${esc(agent.model)}</span>
            ${agent.withSynabun ? '<span class="as-agent-synabun-badge">SB</span>' : ''}
          </div>
          <div class="as-agent-actions">
            ${agent.status === 'running' ? `<button class="as-agent-stop-btn" data-action="agent-stop" data-id="${agent.id}" data-tooltip="Stop">&#9632;</button>` : ''}
            <button class="as-agent-remove-btn" data-action="agent-remove" data-id="${agent.id}" data-tooltip="Remove">&times;</button>
          </div>
        </div>
        <div class="as-agent-task">${esc(agent.task.slice(0, 150))}${agent.task.length > 150 ? '\u2026' : ''}</div>
        ${isLoop ? `<div class="as-running-progress"><div class="as-running-progress-fill" style="width:${iterPct}%"></div></div>` : ''}`;

    // Live tool feed
    if (recentTools.length > 0) {
      html += `<div class="as-agent-tool-feed" id="as-agent-tools-${agent.id}">${recentTools.map(t => t.replace('mcp__SynaBun__', '')).join(' > ')}</div>`;
    }

    // Structured progress from last handoff
    if (lastJournal?.done || lastJournal?.next) {
      html += `<div class="as-agent-handoff">`;
      if (lastJournal.done) html += `<div class="as-handoff-done"><span class="as-handoff-label">Done:</span> ${esc(lastJournal.done.slice(0, 200))}</div>`;
      if (lastJournal.next) html += `<div class="as-handoff-next"><span class="as-handoff-label">Next:</span> ${esc(lastJournal.next.slice(0, 200))}</div>`;
      if (lastJournal.state) html += `<div class="as-handoff-state"><span class="as-handoff-label">State:</span> ${esc(lastJournal.state.slice(0, 150))}</div>`;
      html += `</div>`;
    }

    // Iteration journal timeline (collapsed by default, last 5 entries)
    if (isLoop && journal.length > 0) {
      const shownJournal = journal.slice(-5);
      html += `<div class="as-agent-journal">`;
      for (const entry of shownJournal) {
        const toolBadge = entry.toolCount ? ` <span class="as-journal-tools">${entry.toolCount}t</span>` : '';
        html += `<div class="as-journal-entry"><span class="as-journal-iter">#${entry.iteration}</span>${toolBadge} ${esc((entry.done || entry.summary || '').slice(0, 120))}</div>`;
      }
      html += `</div>`;
    }

    html += `
        <div class="as-agent-output" id="as-agent-output-${agent.id}">${preview ? esc(preview) : '<span class="as-agent-waiting">Waiting for output...</span>'}</div>
        <div class="as-agent-footer">
          <span class="as-agent-elapsed">${elapsed}</span>
          ${isLoop ? `<span class="as-agent-iter">iter ${agent.currentIteration}/${agent.totalIterations}</span>` : ''}
          ${agent.toolUseCount ? `<span class="as-agent-tools">${agent.toolUseCount} tools</span>` : ''}
          ${agent.costUsd != null ? `<span class="as-agent-cost">$${agent.costUsd.toFixed(4)}</span>` : ''}
          ${agent.browserSessionId ? '<span class="as-agent-browser-tag">browser</span>' : ''}
        </div>
      </div>`;
  }

  html += '</div>';
  main.innerHTML = html;

  // Auto-scroll agent output areas to bottom
  for (const agent of _agents) {
    const outputEl = $(`as-agent-output-${agent.id}`);
    if (outputEl) outputEl.scrollTop = outputEl.scrollHeight;
  }
}

// ── Agent helpers ──

function agentElapsed(agent) {
  const start = new Date(agent.startedAt).getTime();
  const end = agent.endedAt ? new Date(agent.endedAt).getTime() : Date.now();
  const secs = Math.floor((end - start) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m ${remainSecs}s`;
}

async function refreshAgents() {
  try {
    const data = await fetchAgents();
    _agents = data?.agents || [];
    // Update local output buffers with any text we haven't captured via WebSocket
    for (const a of _agents) {
      if (!_agentOutputs[a.id] && a.textLength > 0) {
        // Fetch full details to get textOutput
        try {
          const full = await fetchAgent(a.id);
          if (full?.textOutput) _agentOutputs[a.id] = full.textOutput;
        } catch {}
      }
    }
  } catch {}
}

function setupAgentWebSocket() {
  // Listen for agent events on the sync WebSocket
  on('sync:agent:output', (data) => {
    if (!data?.agentId || !data?.event) return;
    const event = data.event;
    // Extract text and tool uses from assistant messages
    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'text') {
          _agentOutputs[data.agentId] = (_agentOutputs[data.agentId] || '') + block.text;
          // Live-update the output element if visible
          const outputEl = $(`as-agent-output-${data.agentId}`);
          if (outputEl) {
            const preview = (_agentOutputs[data.agentId] || '').slice(-300);
            outputEl.textContent = preview;
            outputEl.scrollTop = outputEl.scrollHeight;
          }
        } else if (block.type === 'tool_use') {
          // Track recent tools for live feed
          if (!_agentRecentTools[data.agentId]) _agentRecentTools[data.agentId] = [];
          _agentRecentTools[data.agentId].push(block.name);
          if (_agentRecentTools[data.agentId].length > 8) _agentRecentTools[data.agentId].shift();
          // Increment tool count
          const idx = _agents.findIndex(a => a.id === data.agentId);
          if (idx >= 0) _agents[idx].toolUseCount = (_agents[idx].toolUseCount || 0) + 1;
          // Live-update the tool feed element if visible
          const toolEl = $(`as-agent-tools-${data.agentId}`);
          if (toolEl) {
            const tools = _agentRecentTools[data.agentId] || [];
            toolEl.textContent = tools.map(t => t.replace('mcp__SynaBun__', '')).join(' > ');
          }
        }
      }
    }
  });

  on('sync:agent:launched', async () => {
    await refreshAgents();
    if (_view === 'running') renderRunningMain();
  });

  on('sync:agent:status', async (data) => {
    // Update local agent status
    const idx = _agents.findIndex(a => a.id === data?.agentId);
    if (idx >= 0) _agents[idx].status = data.status;
    if (_view === 'running') renderRunningMain();
  });

  on('sync:agent:removed', (data) => {
    _agents = _agents.filter(a => a.id !== data?.agentId);
    delete _agentOutputs[data?.agentId];
    delete _agentRecentTools[data?.agentId];
    delete _agentJournals[data?.agentId];
    if (_view === 'running') renderRunningMain();
  });

  on('sync:agent:iteration', (data) => {
    const idx = _agents.findIndex(a => a.id === data?.agentId);
    if (idx >= 0) {
      _agents[idx].currentIteration = data.iteration;
      _agents[idx].totalIterations = data.total;
    }
    if (_view === 'running') renderRunningMain();
  });

  on('sync:agent:iteration-complete', (data) => {
    if (!data?.agentId) return;
    if (!_agentJournals[data.agentId]) _agentJournals[data.agentId] = [];
    _agentJournals[data.agentId].push({
      iteration: data.iteration,
      summary: data.summary,
      done: data.done,
      next: data.next,
      state: data.state,
      toolCount: data.toolCount,
    });
    // Keep bounded
    if (_agentJournals[data.agentId].length > 20) _agentJournals[data.agentId] = _agentJournals[data.agentId].slice(-15);
    // Update journal on the local agent object too
    const idx = _agents.findIndex(a => a.id === data.agentId);
    if (idx >= 0) _agents[idx].journal = _agentJournals[data.agentId];
    if (_view === 'running') renderRunningMain();
  });
}

function setupScheduleWebSocket() {
  on('sync:schedule:created', (data) => {
    if (data?.schedule) {
      _schedules.push(data.schedule);
      if (_view === 'schedules') renderSchedulesMain();
    }
  });

  on('sync:schedule:updated', (data) => {
    if (data?.schedule) {
      const idx = _schedules.findIndex(s => s.id === data.schedule.id);
      if (idx >= 0) _schedules[idx] = data.schedule;
      else _schedules.push(data.schedule);
      if (_view === 'schedules') renderSchedulesMain();
    }
  });

  on('sync:schedule:deleted', (data) => {
    if (data?.scheduleId) {
      _schedules = _schedules.filter(s => s.id !== data.scheduleId);
      if (_view === 'schedules') renderSchedulesMain();
    }
  });

  on('sync:schedule:fired', (data) => {
    if (data?.scheduleName) showToast(`Schedule fired: ${data.scheduleName}`);
  });

  on('sync:schedule:completed', (data) => {
    loadScheduleData().then(() => { if (_view === 'schedules') renderSchedulesMain(); });
    // Auto-attach the floating terminal so the user can see the scheduled loop running.
    // The server-side loop driver handles the initial message and auto-confirm —
    // this just provides UI visibility.
    if (data?.terminalSessionId) {
      emit('terminal:attach-floating', {
        terminalSessionId: data.terminalSessionId,
        profile: data.profile || 'claude-code',
        snapToPanel: false,
      });
    }
  });

  on('sync:schedule:failed', (data) => {
    if (data?.reason) showToast(`Schedule failed: ${data.reason}`);
    loadScheduleData().then(() => { if (_view === 'schedules') renderSchedulesMain(); });
  });

  on('sync:schedule:timer-set', (data) => {
    if (data?.scheduleId && data?.firesAt) {
      _scheduleTimerData[data.scheduleId] = { firesAt: data.firesAt, minutes: data.minutes };
      if (_view === 'schedules') renderSchedulesMain();
    }
  });

  on('sync:schedule:timer-fired', (data) => {
    if (data?.scheduleName) showToast(`Timer fired: ${data.scheduleName}`);
    if (data?.scheduleId) delete _scheduleTimerData[data.scheduleId];
    loadScheduleData().then(() => { if (_view === 'schedules') renderSchedulesMain(); });
  });

  on('sync:schedule:timer-cancelled', (data) => {
    if (data?.scheduleId) delete _scheduleTimerData[data.scheduleId];
    if (_view === 'schedules') renderSchedulesMain();
  });

  // Quick timer events
  on('sync:quick-timer:set', (data) => {
    if (data?.timerId && !_quickTimers.some(t => t.id === data.timerId)) {
      _quickTimers.push({ id: data.timerId, templateName: data.templateName, firesAt: data.firesAt, minutes: data.minutes, profile: data.profile, model: data.model, usesBrowser: data.usesBrowser });
      if (_view === 'schedules') renderSchedulesMain();
    }
  });

  on('sync:quick-timer:fired', (data) => {
    if (data?.templateName) showToast(`Timer fired: ${data.templateName}`);
    if (data?.timerId) _quickTimers = _quickTimers.filter(t => t.id !== data.timerId);
    if (_view === 'schedules') renderSchedulesMain();
  });

  on('sync:quick-timer:fired-now', (data) => {
    if (data?.templateName) showToast(`Running now: ${data.templateName}`);
    if (_view === 'schedules') renderSchedulesMain();
  });

  on('sync:quick-timer:cancelled', (data) => {
    if (data?.timerId) _quickTimers = _quickTimers.filter(t => t.id !== data.timerId);
    if (_view === 'schedules') renderSchedulesMain();
  });

  on('sync:quick-timer:failed', (data) => {
    if (data?.reason) showToast(`Timer failed: ${data.reason}`);
  });
}

// ═══════════════════════════════════════════
// ═══════════════════════════════════════════
// EVENT HANDLERS (delegated)
// ═══════════════════════════════════════════

async function handlePanelClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;

  switch (action) {
    case 'go-welcome':
      if (_detailDirty && !confirm('Discard unsaved changes?')) return;
      _view = 'welcome'; _selected = null; resetDirty();
      renderView();
      break;

    case 'go-picker':
      _view = 'picker'; renderView();
      break;

    case 'launch-inline-close':
      closeLaunchInline();
      break;

    case 'launch-inline-confirm':
      confirmLaunch();
      break;

    case 'unsaved-dialog-close':
      _panel?.querySelector('.as-unsaved-dialog')?.remove();
      break;

    case 'unsaved-save-launch':
      handleSaveAndLaunch();
      break;

    case 'open-detail': {
      const all = [...PRESET_TEMPLATES, ..._templates];
      const tpl = all.find(t => t.id === id);
      if (tpl) switchToDetail(tpl);
      break;
    }

    case 'pick-preset': {
      const preset = PRESET_TEMPLATES.find(t => t.id === id);
      if (preset) openWizard(preset);
      break;
    }

    case 'pick-blank': {
      const blank = { id: '', name: '', description: '', task: '', context: '', iterations: 10, maxMinutes: 30, icon: 'refresh', category: 'custom', usesBrowser: false };
      _selected = blank;
      _editorContent = ''; _originalContent = '';
      resetDirty(); _previewMode = false;
      _view = 'detail';
      renderView();
      break;
    }

    case 'configure':
    case 'reconfigure': {
      const all = [...PRESET_TEMPLATES, ..._templates];
      const preset = all.find(t => t.id === (_selected?.id || id));
      if (preset && preset.steps) openWizard(preset);
      break;
    }

    case 'customize': {
      if (_selected) customizePreset(_selected);
      break;
    }

    case 'copy-cmd': {
      const text = $('as-cmd-editor')?.value || _editorContent;
      const full = formatLoopCommand(text, {
        iterations: parseInt($('as-f-iterations')?.value || String(_selected?.iterations || 10), 10),
        maxMinutes: parseInt($('as-f-maxminutes')?.value || String(_selected?.maxMinutes || 30), 10),
        usesBrowser: $('as-f-browser')?.checked || false,
      });
      navigator.clipboard.writeText(full).then(() => showToast('Copied to clipboard')).catch(() => showToast('Copy failed'));
      break;
    }

    case 'test-run':
      handleTestRun();
      break;

    case 'launch-loop':
      handleLaunch();
      break;

    case 'force-stop': {
      try {
        const result = await stopLoop();
        if (result?.ok) {
          showToast(result.stopped > 0 ? 'Loop stopped' : 'No active loops');
          _activeLoop = null;
          updateSidebarFooter();
          if (_view === 'running') renderRunningMain();
        } else { showToast(result?.error || 'Stop failed'); }
      } catch (err) { showToast('Stop failed: ' + err.message); }
      break;
    }

    case 'view-running':
      _view = 'running';
      refreshAgents().then(() => renderView());
      break;

    case 'agent-stop': {
      try {
        const result = await stopAgent(id);
        if (result?.ok) {
          showToast('Agent stopped');
          const idx = _agents.findIndex(a => a.id === id);
          if (idx >= 0) _agents[idx].status = 'stopped';
          if (_view === 'running') renderRunningMain();
        } else { showToast(result?.error || 'Stop failed'); }
      } catch (err) { showToast('Stop failed: ' + err.message); }
      break;
    }

    case 'agent-remove': {
      try {
        const result = await removeAgent(id);
        if (result?.ok) {
          _agents = _agents.filter(a => a.id !== id);
          delete _agentOutputs[id];
          showToast('Agent removed');
          if (_view === 'running') renderRunningMain();
        } else { showToast(result?.error || 'Remove failed'); }
      } catch (err) { showToast('Remove failed: ' + err.message); }
      break;
    }

    case 'delete-template': {
      if (!confirm('Delete this automation?')) break;
      try {
        await deleteLoopTemplate(id);
        _templates = _templates.filter(t => t.id !== id);
        if (_selected?.id === id) { _selected = null; _view = 'welcome'; }
        renderView();
        showToast('Deleted');
      } catch (err) { showToast('Delete failed: ' + err.message); }
      break;
    }

    case 'export-one': {
      const tpl = _templates.find(t => t.id === id);
      if (tpl) downloadJson({ version: 1, type: 'synabun-loop-template', template: tpl }, `loop-${tpl.name.toLowerCase().replace(/\s+/g, '-')}.json`);
      break;
    }

    case 'cancel-wizard':
      _wizardState = null; _wizardStep = 0; _wizardPreset = null;
      _view = _selected ? 'detail' : 'welcome';
      renderView();
      break;

    case 'wizard-back':
      if (_wizardStep > 0) { collectInputValues(); _wizardStep--; renderWizardStep(); }
      break;

    case 'wizard-next': {
      collectInputValues();
      const step = _wizardPreset.steps[_wizardStep];
      if (step?.validate) { const err = step.validate(_wizardState); if (err) { showToast(err); return; } }
      _wizardStep++;
      renderWizardStep();
      break;
    }

    case 'wizard-copy': {
      collectInputValues();
      const cmd = formatLoopCommand(_wizardPreset.buildCommand(_wizardState), _wizardState);
      navigator.clipboard.writeText(cmd).then(() => showToast('Copied to clipboard')).catch(() => showToast('Copy failed'));
      break;
    }

    case 'wizard-open-editor': {
      collectInputValues();
      const cmd = _wizardPreset.buildCommand(_wizardState);
      _wizardPreset._lastState = { ..._wizardState };
      _selected = _wizardPreset;
      _editorContent = cmd;
      _originalContent = cmd;
      resetDirty(); _previewMode = false;
      _wizardState = null; _wizardStep = 0; _wizardPreset = null;
      _view = 'detail';
      renderView();
      break;
    }

    case 'wizard-launch': {
      collectInputValues();
      const taskText = _wizardPreset.buildCommand(_wizardState);
      const wizIterations = _wizardState.iterations;
      const wizMaxMinutes = _wizardState.maxMinutes;
      const wizUsesBrowser = _wizardState.usesBrowser;
      _wizardState = null; _wizardStep = 0; _wizardPreset = null;
      serverLaunchLoop({
        task: taskText,
        context: null,
        iterations: wizIterations,
        maxMinutes: wizMaxMinutes,
        usesBrowser: wizUsesBrowser,
      });
      break;
    }

    // ── Schedule actions ──

    case 'schedule-new':
      _editingSchedule = null;
      _view = 'schedule-editor';
      renderView();
      break;

    case 'schedule-edit': {
      const sched = _schedules.find(s => s.id === id);
      if (sched) { _editingSchedule = sched; _view = 'schedule-editor'; renderView(); }
      break;
    }

    case 'schedule-toggle': {
      const sched = _schedules.find(s => s.id === id);
      if (sched) {
        try {
          const updated = await updateSchedule(id, { enabled: !sched.enabled });
          const idx = _schedules.findIndex(s => s.id === id);
          if (idx >= 0) _schedules[idx] = updated;
          renderSchedulesMain();
          showToast(updated.enabled ? 'Schedule enabled' : 'Schedule paused');
        } catch (err) { showToast('Toggle failed: ' + err.message); }
      }
      break;
    }

    case 'schedule-test': {
      try {
        await testSchedule(id);
        showToast('Schedule queued for immediate fire');
      } catch (err) { showToast('Test failed: ' + err.message); }
      break;
    }

    case 'schedule-delete': {
      if (!confirm('Delete this schedule?')) break;
      try {
        await deleteSchedule(id);
        _schedules = _schedules.filter(s => s.id !== id);
        renderSchedulesMain();
        showToast('Schedule deleted');
      } catch (err) { showToast('Delete failed: ' + err.message); }
      break;
    }

    case 'schedule-timer-toggle': {
      const row = document.getElementById(`as-timer-row-${id}`);
      if (row) row.style.display = row.style.display === 'none' ? 'flex' : 'none';
      break;
    }

    case 'schedule-timer-fire': {
      const mins = Number(el.dataset.minutes);
      if (!mins) break;
      try {
        const result = await startScheduleTimer(id, mins);
        _scheduleTimerData[id] = { firesAt: result.firesAt, minutes: result.minutes };
        renderSchedulesMain();
        showToast(`Timer set: fires in ${mins}m`);
      } catch (err) { showToast('Timer failed: ' + err.message); }
      break;
    }

    case 'schedule-timer-custom': {
      const input = document.querySelector(`.as-sched-timer-input[data-id="${id}"]`);
      const mins = Number(input?.value);
      if (!mins || mins < 1) { showToast('Enter minutes (1+)'); break; }
      try {
        const result = await startScheduleTimer(id, mins);
        _scheduleTimerData[id] = { firesAt: result.firesAt, minutes: result.minutes };
        renderSchedulesMain();
        showToast(`Timer set: fires in ${mins}m`);
      } catch (err) { showToast('Timer failed: ' + err.message); }
      break;
    }

    case 'schedule-timer-cancel': {
      try {
        await cancelScheduleTimer(id);
        delete _scheduleTimerData[id];
        renderSchedulesMain();
        showToast('Timer cancelled');
      } catch (err) { showToast('Cancel failed: ' + err.message); }
      break;
    }

    case 'qt-profile': {
      const profileId = btn.dataset.profile;
      if (!profileId) break;
      _launchProfile = profileId;
      storage.setItem('as-launch-profile', profileId);
      // Update model to default for new profile
      const models = CLI_MODELS[profileId] || [];
      const defaultModel = models.find(m => m.tier === 'default') || models[0];
      _launchModel = defaultModel?.id || null;
      storage.setItem('as-launch-model', _launchModel);
      renderSchedulesMain();
      break;
    }

    case 'qt-model': {
      const modelId = btn.dataset.model;
      if (!modelId) break;
      _launchModel = modelId;
      storage.setItem('as-launch-model', _launchModel);
      // Update visual selection inline (avoid full re-render)
      $('as-qt-models')?.querySelectorAll('.as-launch-model').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      break;
    }

    case 'qt-select': {
      const mins = Number(btn.dataset.minutes);
      if (!mins) break;
      _selectedQtMinutes = mins;
      // Clear custom input when preset selected
      const customInput = $('as-qt-custom-min');
      if (customInput) customInput.value = '';
      // Update visual selection
      btn.closest('.as-qt-presets')?.querySelectorAll('.as-qt-preset[data-action="qt-select"]').forEach(b => b.classList.remove('as-qt-preset--selected'));
      btn.classList.add('as-qt-preset--selected');
      break;
    }

    case 'qt-go': {
      const templateId = $('as-qt-template')?.value;
      if (!templateId) { showToast('Select a template first'); break; }
      // Custom input takes priority if filled, otherwise use selected preset
      const customVal = Number($('as-qt-custom-min')?.value);
      const mins = (customVal && customVal >= 1) ? customVal : _selectedQtMinutes;
      if (!mins) { showToast('Select a time or enter minutes'); break; }
      const qtProfile = _launchProfile || 'claude-code';
      const qtModel = _launchModel || null;
      const qtBrowser = !!$('as-qt-browser')?.checked;
      try {
        const result = await createQuickTimer(templateId, mins, { profile: qtProfile, model: qtModel, usesBrowser: qtBrowser });
        // Guard: WebSocket sync:quick-timer:set may arrive before this HTTP response
        if (!_quickTimers.some(t => t.id === result.timerId)) {
          _quickTimers.push({ id: result.timerId, templateId, templateName: result.templateName, firesAt: result.firesAt, minutes: result.minutes, profile: result.profile, model: result.model, usesBrowser: result.usesBrowser });
        }
        _selectedQtMinutes = null;
        _qtUsesBrowser = null;
        renderSchedulesMain();
        const label = mins >= 60 ? `${mins / 60}h` : `${mins}m`;
        showToast(`Timer set: ${result.templateName} in ${label}`);
      } catch (err) { showToast('Timer failed: ' + err.message); }
      break;
    }

    case 'qt-now': {
      const templateId = $('as-qt-template')?.value;
      if (!templateId) { showToast('Select a template first'); break; }
      const qtProfile = _launchProfile || 'claude-code';
      const qtModel = _launchModel || null;
      const qtBrowser = !!$('as-qt-browser')?.checked;
      try {
        const result = await triggerQuickTimerNow(templateId, { profile: qtProfile, model: qtModel, usesBrowser: qtBrowser });
        showToast(`Firing now: ${result.templateName}`);
      } catch (err) { showToast('Run Now failed: ' + err.message); }
      break;
    }

    case 'qt-cancel': {
      try {
        await cancelQuickTimer(id);
        _quickTimers = _quickTimers.filter(t => t.id !== id);
        renderSchedulesMain();
        showToast('Timer cancelled');
      } catch (err) { showToast('Cancel failed: ' + err.message); }
      break;
    }

    case 'toggle-advanced-schedules':
      _showAdvancedSchedules = !_showAdvancedSchedules;
      renderSchedulesMain();
      break;

    case 'schedule-save':
      await saveScheduleFromEditor();
      break;

    case 'schedule-cancel':
      _editingSchedule = null;
      _view = 'schedules';
      renderView();
      break;

    case 'schedule-back':
      _view = 'schedules';
      _editingSchedule = null;
      renderView();
      break;
  }
}

// ═══════════════════════════════════════════
// WIZARD INFRASTRUCTURE (chip/input/rules)
// ═══════════════════════════════════════════

function wireRulesListEvents(container, state) {
  if (!Array.isArray(state.rules)) state.rules = [];
  const list = container.querySelector('#awiz-rules-list');
  const input = container.querySelector('#awiz-rule-input');
  const addBtn = container.querySelector('#awiz-rule-add');
  if (!list || !input || !addBtn) return;

  function rerender() {
    if (state.rules.length === 0) {
      list.innerHTML = '<div class="awiz-rules-empty">No rules yet.</div>';
    } else {
      list.innerHTML = state.rules.map((rule, i) => `
        <div class="awiz-rule-item" draggable="true" data-rule-idx="${i}">
          <span class="awiz-rule-grip" data-tooltip="Drag to reorder">\u2261</span>
          <span class="awiz-rule-num">${i + 1}</span>
          <span class="awiz-rule-text">${esc(rule)}</span>
          <button class="awiz-rule-remove" data-remove-idx="${i}" data-tooltip="Remove">&times;</button>
        </div>`).join('');
      wireDragDrop();
    }
  }

  function addRule() {
    const val = input.value.trim();
    if (!val) return;
    state.rules.push(val);
    input.value = ''; input.focus();
    rerender();
  }

  addBtn.addEventListener('click', (e) => { e.preventDefault(); addRule(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addRule(); } });

  list.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.awiz-rule-remove');
    if (!removeBtn) return;
    const idx = parseInt(removeBtn.dataset.removeIdx, 10);
    if (!isNaN(idx) && idx >= 0 && idx < state.rules.length) {
      state.rules.splice(idx, 1);
      rerender();
    }
  });

  let _dragIdx = null;
  function wireDragDrop() {
    list.querySelectorAll('.awiz-rule-item').forEach(item => {
      item.addEventListener('dragstart', (e) => {
        _dragIdx = parseInt(item.dataset.ruleIdx, 10);
        item.classList.add('awiz-rule-dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('awiz-rule-dragging'); _dragIdx = null;
        list.querySelectorAll('.awiz-rule-item').forEach(el => el.classList.remove('awiz-rule-over'));
      });
      item.addEventListener('dragover', (e) => {
        e.preventDefault(); e.dataTransfer.dropEffect = 'move';
        list.querySelectorAll('.awiz-rule-item').forEach(el => el.classList.remove('awiz-rule-over'));
        item.classList.add('awiz-rule-over');
      });
      item.addEventListener('dragleave', () => { item.classList.remove('awiz-rule-over'); });
      item.addEventListener('drop', (e) => {
        e.preventDefault();
        const dropIdx = parseInt(item.dataset.ruleIdx, 10);
        if (_dragIdx !== null && _dragIdx !== dropIdx) {
          const [moved] = state.rules.splice(_dragIdx, 1);
          state.rules.splice(dropIdx, 0, moved);
          rerender();
        }
      });
    });
  }
  if (state.rules.length > 0) wireDragDrop();
}

function wireChipEvents(container) {
  container.querySelectorAll('.awiz-chips').forEach(group => {
    group.querySelectorAll('.awiz-chip').forEach(btn => {
      const fresh = btn.cloneNode(true);
      btn.parentNode.replaceChild(fresh, btn);
      fresh.addEventListener('click', (e) => {
        e.preventDefault();
        const c = fresh.closest('.awiz-chips');
        const mode = c.dataset.mode;
        const key = c.dataset.key;
        const value = fresh.dataset.value;
        if (mode === 'single') {
          c.querySelectorAll('.awiz-chip').forEach(ch => ch.classList.remove('active'));
          fresh.classList.add('active');
          _wizardState[key] = value;
        } else {
          fresh.classList.toggle('active');
          _wizardState[key] = Array.from(c.querySelectorAll('.awiz-chip.active')).map(ch => ch.dataset.value);
        }
      });
    });
  });
}

function wireInputSync(container) {
  container.querySelectorAll('.awiz-step-content input[data-key], .awiz-step-content textarea[data-key]').forEach(input => {
    input.addEventListener('input', () => {
      _wizardState[input.dataset.key] = input.type === 'number' ? Number(input.value) : input.value;
    });
  });
}

// ═══════════════════════════════════════════
// SCHEDULES
// ═══════════════════════════════════════════

async function loadScheduleData() {
  try { _schedules = await fetchSchedules(); } catch { _schedules = []; }
  try { _scheduleTimerData = await fetchScheduleTimers(); } catch { _scheduleTimerData = {}; }
  try { _quickTimers = await fetchQuickTimers(); } catch { _quickTimers = []; }
}

const CRON_PRESET_GROUPS = [
  { group: 'Frequency', presets: [
    { label: 'Every 15 Min', cron: '*/15 * * * *', desc: 'Every 15 minutes' },
    { label: 'Every 30 Min', cron: '*/30 * * * *', desc: 'Every 30 minutes' },
    { label: 'Every Hour', cron: '0 * * * *', desc: 'Every hour at :00' },
    { label: 'Every 2 Hours', cron: '0 */2 * * *', desc: 'Every 2 hours at :00' },
    { label: 'Every 3 Hours', cron: '0 */3 * * *', desc: 'Every 3 hours at :00' },
    { label: 'Every 6 Hours', cron: '0 */6 * * *', desc: 'Every 6 hours at :00' },
  ]},
  { group: 'Daily', presets: [
    { label: 'Morning 9am', cron: '0 9 * * *', desc: 'Every day at 9:00' },
    { label: 'Midday 12pm', cron: '0 12 * * *', desc: 'Every day at 12:00' },
    { label: 'Evening 6pm', cron: '0 18 * * *', desc: 'Every day at 18:00' },
    { label: '2x (10am, 6pm)', cron: '0 10,18 * * *', desc: 'Every day at 10:00, 18:00' },
    { label: '3x (9am, 2pm, 7pm)', cron: '0 9,14,19 * * *', desc: 'Every day at 9:00, 14:00, 19:00' },
    { label: '4x (8a, 12p, 4p, 8p)', cron: '0 8,12,16,20 * * *', desc: 'Every day at 8:00, 12:00, 16:00, 20:00' },
  ]},
  { group: 'Weekly', presets: [
    { label: 'Weekdays 9am', cron: '0 9 * * 1-5', desc: 'Mon–Fri at 9:00' },
    { label: 'Weekdays 2x', cron: '0 10,18 * * 1-5', desc: 'Mon–Fri at 10:00, 18:00' },
    { label: 'Weekdays 3x', cron: '0 9,14,19 * * 1-5', desc: 'Mon–Fri at 9:00, 14:00, 19:00' },
    { label: 'Weekends 10am', cron: '0 10 * * 0,6', desc: 'Sat & Sun at 10:00' },
    { label: 'Mon/Wed/Fri', cron: '0 9 * * 1,3,5', desc: 'Mon, Wed, Fri at 9:00' },
    { label: 'Tue/Thu', cron: '0 9 * * 2,4', desc: 'Tue, Thu at 9:00' },
  ]},
];
// Flat list for backward compat
const CRON_PRESETS = CRON_PRESET_GROUPS.flatMap(g => g.presets);

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function describeCronClient(cronStr) {
  const fields = cronStr.trim().split(/\s+/);
  if (fields.length !== 5) return cronStr;
  const [minute, hour, , , dayOfWeek] = fields;
  let dayPart = '';
  if (dayOfWeek === '*') dayPart = 'Every day';
  else if (dayOfWeek === '1-5') dayPart = 'Weekdays';
  else if (dayOfWeek === '0,6') dayPart = 'Weekends';
  else dayPart = dayOfWeek.split(',').map(d => DAY_NAMES[+d] || d).join(', ');
  const pad = (n) => String(n).padStart(2, '0');
  let timePart;
  // Handle */N minute patterns (e.g. */15, */30)
  const minStep = minute.match(/^\*\/(\d+)$/);
  if (minStep && hour === '*') {
    return `${dayPart} — every ${minStep[1]} minutes`;
  }
  // Handle */N hour patterns (e.g. */2, */3, */6)
  const hourStep = hour.match(/^\*\/(\d+)$/);
  if (hourStep) {
    timePart = `every ${hourStep[1]} hours at :${pad(+minute)}`;
  } else if (hour.includes(',')) {
    timePart = hour.split(',').map(h => `${pad(+h)}:${pad(+minute)}`).join(', ');
  } else if (hour === '*') {
    timePart = `every hour at :${pad(+minute)}`;
  } else {
    timePart = `${pad(+hour)}:${pad(+minute)}`;
  }
  return `${dayPart} at ${timePart}`;
}

function formatNextRun(nextRun) {
  if (!nextRun) return 'N/A';
  const d = new Date(nextRun);
  const now = new Date();
  const diffMs = d - now;
  if (diffMs < 0) return 'Overdue';
  if (diffMs < 60_000) return 'Under a minute';
  if (diffMs < 3600_000) return `${Math.round(diffMs / 60_000)}m`;
  if (diffMs < 86400_000) return `${Math.round(diffMs / 3600_000)}h`;
  return `${Math.round(diffMs / 86400_000)}d`;
}

function scheduleStatusBadge(schedule) {
  if (!schedule.enabled) return '<span class="as-sched-badge as-sched-badge--paused">Paused</span>';
  if (schedule.lastRunResult === 'template_missing') return '<span class="as-sched-badge as-sched-badge--error">Missing Template</span>';
  if (schedule.lastRunResult?.startsWith('error:')) return '<span class="as-sched-badge as-sched-badge--error">Error</span>';
  if (schedule.lastRunResult === 'launched') return '<span class="as-sched-badge as-sched-badge--ok">Active</span>';
  return '<span class="as-sched-badge as-sched-badge--ok">Active</span>';
}

function formatTimerCountdown(firesAtISO) {
  const diff = new Date(firesAtISO) - Date.now();
  if (diff <= 0) return 'firing...';
  const mins = Math.ceil(diff / 60_000);
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${mins}m`;
}

function renderSchedulesMain() {
  const main = $('as-main');
  if (!main) return;

  const allTemplates = [...PRESET_TEMPLATES, ..._templates];
  const templateMap = {};
  for (const t of allTemplates) templateMap[t.id] = t;

  // ── Active Quick Timers ──
  let timersHTML = '';
  if (_quickTimers.length > 0) {
    let timerCards = '';
    for (const qt of _quickTimers) {
      const profileLabel = CLI_PROFILES.find(p => p.id === qt.profile)?.label || qt.profile || 'Claude Code';
      const modelObj = qt.model ? (CLI_MODELS[qt.profile || 'claude-code'] || []).find(m => m.id === qt.model) : null;
      const modelLabel = modelObj?.label || '';
      const metaParts = [profileLabel, modelLabel, qt.usesBrowser ? 'Browser' : ''].filter(Boolean);
      timerCards += `
        <div class="as-qt-active-card">
          <div class="as-qt-active-pulse"></div>
          <div class="as-qt-active-info">
            <span class="as-qt-active-name">${esc(qt.templateName)}</span>
            <span class="as-qt-active-meta">${esc(metaParts.join(' \u00b7 '))}</span>
          </div>
          <span class="as-qt-active-countdown">${formatTimerCountdown(qt.firesAt)}</span>
          <button class="as-qt-cancel" data-action="qt-cancel" data-id="${qt.id}" data-tooltip="Cancel timer">${AS_ICONS.close}</button>
        </div>`;
    }
    timersHTML = `<div class="as-qt-active-timers">${timerCards}</div>`;
  }

  // ── Quick Timer Creator ──
  const templateOptions = allTemplates.map(t =>
    `<option value="${t.id}">${esc(t.name)}</option>`
  ).join('');

  const qtPresetButtons = [
    { minutes: 5, label: '5m' }, { minutes: 15, label: '15m' }, { minutes: 30, label: '30m' },
    { minutes: 60, label: '1h' }, { minutes: 120, label: '2h' }, { minutes: 240, label: '4h' },
  ].map(p => `<button class="as-qt-preset${_selectedQtMinutes === p.minutes ? ' as-qt-preset--selected' : ''}" data-action="qt-select" data-minutes="${p.minutes}">${p.label}</button>`).join('');

  // CLI/Model/Browser settings for quick timer
  const qtProfile = _launchProfile || 'claude-code';
  const qtModels = CLI_MODELS[qtProfile] || [];
  const qtDefaultModel = qtModels.find(m => m.tier === 'default') || qtModels[0];
  const qtCurrentModel = _launchModel && qtModels.some(m => m.id === _launchModel) ? _launchModel : qtDefaultModel?.id;

  const qtProfileChips = CLI_PROFILES.map(p => `
    <button class="as-launch-profile${p.id === qtProfile ? ' active' : ''}" data-action="qt-profile" data-profile="${p.id}">
      <span class="as-launch-profile-name">${p.label}</span>
      <span class="as-launch-profile-org">${p.desc}</span>
    </button>
  `).join('');

  const qtModelChips = qtModels.map(m => `
    <button class="as-launch-model${m.id === qtCurrentModel ? ' active' : ''}${m.tier ? ` as-launch-model--${m.tier}` : ''}" data-action="qt-model" data-model="${m.id}">
      <span class="as-launch-model-name">${m.label}</span>
      <span class="as-launch-model-desc">${m.desc}</span>
    </button>
  `).join('');

  // Determine browser toggle default from selected template
  const selectedTpl = $('as-qt-template')?.value;
  const selectedTemplate = selectedTpl ? allTemplates.find(t => t.id === selectedTpl) : null;
  const qtBrowserDefault = _qtUsesBrowser !== null ? _qtUsesBrowser : (selectedTemplate ? !!selectedTemplate.usesBrowser : false);

  const qtCreatorHTML = `
    <div class="as-qt-creator">
      <select class="as-qt-select" id="as-qt-template">
        <option value="">Select template...</option>
        ${templateOptions}
      </select>
      <div class="as-qt-group">
        <span class="as-launch-label">CLI</span>
        <div class="as-launch-profiles" id="as-qt-profiles">${qtProfileChips}</div>
      </div>
      <div class="as-qt-group">
        <span class="as-launch-label">Model</span>
        <div class="as-launch-models" id="as-qt-models">${qtModelChips}</div>
      </div>
      <div class="as-qt-group">
        <span class="as-launch-label">Browser</span>
        <label class="as-qt-browser-toggle">
          <input type="checkbox" id="as-qt-browser" ${qtBrowserDefault ? 'checked' : ''}>
          <span class="as-qt-switch"></span>
          <span class="as-qt-browser-label">Uses browser</span>
        </label>
      </div>
      <div class="as-qt-group">
        <span class="as-launch-label">Timer</span>
        <div class="as-qt-presets">${qtPresetButtons}
          <input class="as-qt-custom-input" id="as-qt-custom-min" type="number" min="1" max="1440" placeholder="min" />
        </div>
      </div>
      <div class="as-qt-actions">
        <button class="as-launch-go" data-action="qt-go">${_s('<path d="M5 3l8 5-8 5V3z"/>')} Go</button>
        <button class="as-launch-cancel" data-action="qt-now" data-tooltip="Fire immediately">Run Now</button>
      </div>
    </div>`;

  // ── Recurring Cron Schedules ──
  let cronHTML = '';
  let cronListHTML = '';
  if (_showAdvancedSchedules) {
    if (_schedules.length === 0) {
      cronListHTML = '<div class="as-qt-empty">No recurring schedules.</div>';
    } else {
      for (const s of _schedules) {
        const tpl = templateMap[s.templateId];
        const tplName = tpl ? esc(tpl.name) : '<em>Missing</em>';
        cronListHTML += `
          <div class="as-sched-card${s.enabled ? '' : ' as-sched-card--disabled'}">
            <div class="as-sched-card-left">
              <div class="as-sched-card-info">
                <div class="as-sched-card-name">${esc(s.name)}</div>
                <div class="as-sched-card-meta">${tplName} &middot; ${esc(describeCronClient(s.cron))}</div>
                <div class="as-sched-card-next">Next: ${formatNextRun(s.nextRun)} &middot; Runs: ${s.runCount || 0}</div>
              </div>
            </div>
            <div class="as-sched-card-right">
              ${scheduleStatusBadge(s)}
              <button class="as-sched-action" data-action="schedule-toggle" data-id="${s.id}" data-tooltip="${s.enabled ? 'Pause' : 'Enable'}">
                ${s.enabled ? _s('<path d="M5 3v10M11 3v10"/>') : _s('<path d="M5 3l8 5-8 5V3z"/>')}
              </button>
              <button class="as-sched-action" data-action="schedule-test" data-id="${s.id}" data-tooltip="Test fire now">${AS_ICONS.bolt}</button>
              <button class="as-sched-action" data-action="schedule-edit" data-id="${s.id}" data-tooltip="Edit">${AS_ICONS.pencil}</button>
              <button class="as-sched-action as-sched-action--danger" data-action="schedule-delete" data-id="${s.id}" data-tooltip="Delete">${AS_ICONS.close}</button>
            </div>
          </div>`;
      }
    }
    cronHTML = `
      <div class="as-qt-cron-section">
        <div class="as-qt-cron-header" data-action="toggle-advanced-schedules">
          <div class="as-qt-cron-header-left">
            <div class="as-qt-cron-icon">${_s('<circle cx="7" cy="7" r="5"/><path d="M7 4v3l2 2"/>')}</div>
            <span>Recurring Schedules</span>
            ${_schedules.length ? `<span class="as-qt-cron-count">${_schedules.length}</span>` : ''}
          </div>
          <span class="as-qt-chevron as-qt-chevron--open">${_s('<path d="M4 6l4 4 4-4"/>')}</span>
        </div>
        <div class="as-qt-cron-body">
          <div class="as-sched-list">${cronListHTML}</div>
          <button class="as-qt-btn as-qt-btn--secondary" data-action="schedule-new">+ New Cron Schedule</button>
        </div>
      </div>`;
  } else {
    cronHTML = `
      <div class="as-qt-cron-section">
        <div class="as-qt-cron-header" data-action="toggle-advanced-schedules">
          <div class="as-qt-cron-header-left">
            <div class="as-qt-cron-icon">${_s('<circle cx="7" cy="7" r="5"/><path d="M7 4v3l2 2"/>')}</div>
            <span>Recurring Schedules</span>
            ${_schedules.length ? `<span class="as-qt-cron-count">${_schedules.length}</span>` : ''}
          </div>
          <span class="as-qt-chevron">${_s('<path d="M4 6l4 4 4-4"/>')}</span>
        </div>
      </div>`;
  }

  main.innerHTML = `
    <div class="as-schedules">
      <div class="as-sched-header">
        <button class="as-back-btn" data-action="go-welcome">${AS_ICONS.back}</button>
        <h3>Schedules</h3>
      </div>
      ${timersHTML}
      ${qtCreatorHTML}
      ${cronHTML}
    </div>
  `;

  // Wire template select → auto-set browser toggle from template's usesBrowser
  const tplSelect = $('as-qt-template');
  if (tplSelect) {
    tplSelect.addEventListener('change', () => {
      const tpl = allTemplates.find(t => t.id === tplSelect.value);
      const browserCheckbox = $('as-qt-browser');
      if (browserCheckbox && tpl) {
        browserCheckbox.checked = !!tpl.usesBrowser;
        _qtUsesBrowser = null; // reset to template default
      }
    });
  }

  // Wire browser toggle → track user override
  const browserCheckbox = $('as-qt-browser');
  if (browserCheckbox) {
    browserCheckbox.addEventListener('change', () => {
      _qtUsesBrowser = browserCheckbox.checked;
    });
  }
}

function renderScheduleEditorMain() {
  const main = $('as-main');
  if (!main) return;

  const s = _editingSchedule;
  const isEdit = !!s;
  const allTemplates = [...PRESET_TEMPLATES, ..._templates];

  const presetsHTML = CRON_PRESET_GROUPS.map(g => `
    <div class="as-sched-preset-group">
      <div class="as-sched-preset-group-label">${esc(g.group)}</div>
      <div class="as-sched-preset-grid">
        ${g.presets.map(p => `<button class="as-sched-preset" data-cron="${esc(p.cron)}" data-tooltip="${esc(p.desc)}">${esc(p.label)}</button>`).join('')}
      </div>
    </div>`).join('');

  const templateOptions = allTemplates.map(t =>
    `<option value="${t.id}"${(s?.templateId === t.id) ? ' selected' : ''}>${esc(t.name)} (${t.category})</option>`
  ).join('');

  // Reorder: Mon(1)–Sat(6) then Sun(0) so 2-column grid pairs weekdays nicely
  const dayOrder = [1, 2, 3, 4, 5, 6, 0];
  const dayThemesHTML = dayOrder.map(idx => {
    const name = DAY_NAMES[idx];
    const val = s?.dayThemes?.[String(idx)]?.contextOverride || '';
    return `
      <div class="as-sched-daytheme">
        <label>${name}</label>
        <input type="text" data-day="${idx}" placeholder="Context override for ${name}..." value="${esc(val)}" />
      </div>`;
  }).join('');

  const tz = s?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  main.innerHTML = `
    <div class="as-sched-editor">
      <div class="as-sched-header">
        <button class="as-back-btn" data-action="schedule-back">${AS_ICONS.back}</button>
        <h3>${isEdit ? 'Edit Schedule' : 'New Schedule'}</h3>
      </div>

      <div class="as-sched-form">
        <div class="as-sched-field-row">
          <div class="as-sched-field as-sched-field--flex">
            <label>Name</label>
            <input type="text" id="as-sched-name" placeholder="e.g. Morning Social Post" value="${esc(s?.name || '')}" />
          </div>
          <div class="as-sched-field as-sched-field--flex">
            <label>Template</label>
            <select id="as-sched-template">${templateOptions}</select>
          </div>
        </div>

        <div class="as-sched-field">
          <label>Schedule (Cron)</label>
          <div class="as-sched-presets-grouped">${presetsHTML}</div>
          <div class="as-sched-cron-row">
            <input type="text" id="as-sched-cron" placeholder="0 9,14,19 * * 1-5" value="${esc(s?.cron || '0 9,14,19 * * 1-5')}" />
            <span class="as-sched-cron-desc" id="as-sched-cron-desc">${esc(describeCronClient(s?.cron || '0 9,14,19 * * 1-5'))}</span>
          </div>
        </div>

        <div class="as-sched-field-row">
          <div class="as-sched-field as-sched-field--flex">
            <label>Timezone</label>
            <input type="text" id="as-sched-tz" value="${esc(tz)}" />
          </div>
          <div class="as-sched-field as-sched-field--flex as-sched-field--toggle-wrap">
            <label>Status</label>
            <label class="as-sched-toggle-label">
              <input type="checkbox" id="as-sched-enabled" ${s?.enabled !== false ? 'checked' : ''} />
              Enabled
            </label>
          </div>
        </div>

        <div class="as-sched-field">
          <label>Day Themes <span class="as-sched-hint">(optional context overrides per day of week)</span></label>
          <div class="as-sched-daythemes-grid" id="as-sched-daythemes">${dayThemesHTML}</div>
        </div>

        <div class="as-sched-actions">
          <button class="as-header-btn" data-action="schedule-save">${isEdit ? 'Save Changes' : 'Create Schedule'}</button>
          <button class="as-header-btn as-header-btn--secondary" data-action="schedule-cancel">Cancel</button>
        </div>
      </div>
    </div>
  `;

  // Wire cron preset clicks
  main.querySelectorAll('.as-sched-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const cronInput = $('as-sched-cron');
      if (cronInput) {
        cronInput.value = btn.dataset.cron;
        updateCronDesc();
      }
    });
  });

  // Wire cron input live description
  $('as-sched-cron')?.addEventListener('input', updateCronDesc);
}

function updateCronDesc() {
  const cronInput = $('as-sched-cron');
  const descEl = $('as-sched-cron-desc');
  if (cronInput && descEl) {
    descEl.textContent = describeCronClient(cronInput.value);
  }
}

async function saveScheduleFromEditor() {
  const name = $('as-sched-name')?.value?.trim();
  const templateId = $('as-sched-template')?.value;
  const cron = $('as-sched-cron')?.value?.trim();
  const timezone = $('as-sched-tz')?.value?.trim();
  const enabled = $('as-sched-enabled')?.checked ?? true;

  if (!name) { showToast('Name is required'); return; }
  if (!templateId) { showToast('Select a template'); return; }
  if (!cron || cron.split(/\s+/).length !== 5) { showToast('Valid 5-field cron expression required'); return; }

  // Collect day themes
  const dayThemes = {};
  const dayInputs = document.querySelectorAll('#as-sched-daythemes input[data-day]');
  dayInputs.forEach(input => {
    const val = input.value.trim();
    if (val) dayThemes[input.dataset.day] = { contextOverride: val };
  });

  const params = { name, templateId, cron, timezone, enabled, dayThemes };

  try {
    if (_editingSchedule) {
      const updated = await updateSchedule(_editingSchedule.id, params);
      const idx = _schedules.findIndex(s => s.id === _editingSchedule.id);
      if (idx >= 0) _schedules[idx] = updated;
      showToast('Schedule updated');
    } else {
      const created = await createSchedule(params);
      _schedules.push(created);
      showToast('Schedule created');
    }
    _editingSchedule = null;
    _view = 'schedules';
    renderView();
  } catch (err) {
    showToast('Save failed: ' + err.message);
  }
}

// ═══════════════════════════════════════════
// IMPORT / EXPORT
// ═══════════════════════════════════════════

function triggerImport() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json'; input.style.display = 'none';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (data.type !== 'synabun-loop-templates' && data.type !== 'synabun-loop-template') {
        showToast('Invalid file format'); return;
      }
      const result = await importLoopTemplates(data);
      _templates = await fetchLoopTemplates();
      renderView();
      showToast(`Imported: ${result.added} added, ${result.updated} updated`);
    } catch (err) { showToast('Import failed: ' + err.message); }
    input.remove();
  });
  document.body.appendChild(input);
  input.click();
}
