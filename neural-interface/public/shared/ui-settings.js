import { mountMemoryMaintenance } from './ui-memory-maintenance.js';
import { buildJudgmentsTab, wireJudgmentsTab } from './ui-judgments.js';
import { buildWhatsAppTab, wireWhatsAppTab } from './ui-whatsapp.js';
import { SETTINGS_GROUPS, SETTINGS_PAGES, DEFAULT_SETTINGS_PAGE, pageKeys, getSettingsPage, resolveSettingsTarget, homeOfControl } from './settings/settings-ia.js';
import * as kit from './settings/settings-kit.js';
import { initI18n, isReady as i18nReady, SUPPORTED_LOCALES, LOCALE_NAMES, SYSTEM_LOCALE, getLocale, getLocaleChoice, setLocaleChoice, getSystemLocale, englishTranslator, loadEnglishTranslator } from './i18n.js';
import { wireSettingsShell, wireSettingsSearch, collectSearchRows, revealSettingsTarget, followSettingsTarget, onSettingsTakeover, applyStoredSections, storeSectionState } from './settings/settings-shell.js';
import { buildSettingsSearchIndex } from './settings/settings-search.js';
// ═══════════════════════════════════════════
// UI-SETTINGS — Settings modal with shared tabs + variant tab injection
// ═══════════════════════════════════════════
//
// The most complex shared UI module. Builds a floating settings panel with
// eleven task pages in five groups (./settings/settings-ia.js). A page is a
// title, a one-line purpose and section cards (./settings/settings-kit.js);
// each builder below owns one pane of a page. Variant-registered tabs (the 2D
// Graphics tab) join the Appearance page. Old tab ids still open the right page.

import { state, emit, on } from './state.js';
import { getSettingsTabs } from './registry.js';
import { escapeHtml } from './utils.js';
import { storage } from './storage.js';
import { KEYS } from './constants.js';
import { registerAction } from './ui-keybinds.js';
import { CLI_PROFILES, ensureModelsForProfile, getModelsForProfile } from './agent-runtime-options.js';
import { getHiddenModels as getOcpHiddenModels, hydrateHiddenModels, saveHiddenModels as saveOcpHiddenModels } from './ocp-hidden-models.js';
import { buildExplorePrompt } from './ui-tutorial-steps.js';
import { FI, FI_MAP, getFileIcon } from './ui-file-explorer.js';
import { getNotifSettings, playTestSound, sendTestBanner, SOUND_PRESETS } from './ui-notifications.js';
import {
  fetchRulesStatus, fetchRulesTextWithFallback, installRules, removeRules, installAllRules, setRulesAutoUpdate, removeLegacyRules,
} from './api.js';

// ── SVG icon constants ──

const eyeOpen = '<svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const eyeClosed = '<svg viewBox="0 0 24 24"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

// Nav button SVGs keyed by tab id
const TAB_ICONS = {
  server: '<svg viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><circle cx="6" cy="6" r="1"/><circle cx="6" cy="18" r="1"/></svg>',
  hooks: '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  terminal: '<svg viewBox="0 0 24 24"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  collections: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4.03 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/></svg>',
  projects: '<svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  memory: '<svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 0-7 7c0 2.38 1.19 4.47 3 5.74V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.26c1.81-1.27 3-3.36 3-5.74a7 7 0 0 0-7-7z"/><line x1="9" y1="21" x2="15" y2="21"/><line x1="10" y1="24" x2="14" y2="24"/></svg>',
  judgments: '<svg viewBox="0 0 24 24"><line x1="12" y1="3" x2="12" y2="21"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="4" y1="7" x2="20" y2="7"/><path d="M4 7l-2.5 7h5z"/><path d="M20 7l-2.5 7h5z"/></svg>',
  interface: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="9" y1="9" x2="21" y2="9"/></svg>',
  graphics: '<svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  icons: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  notifications: '<svg viewBox="0 0 24 24"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
  browser: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.5"/><ellipse cx="12" cy="12" rx="4" ry="10" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="2" y1="12" x2="22" y2="12" stroke="currentColor" stroke-width="1.5"/></svg>',
  mcp: '<svg viewBox="0 0 24 24"><path d="M3.49994 11.7501L11.6717 3.57855C12.7762 2.47398 14.5672 2.47398 15.6717 3.57855C16.7762 4.68312 16.7762 6.47398 15.6717 7.57855M15.6717 7.57855L9.49994 13.7501M15.6717 7.57855C16.7762 6.47398 18.5672 6.47398 19.6717 7.57855C20.7762 8.68312 20.7762 10.474 19.6717 11.5785L12.7072 18.543C12.3167 18.9335 12.3167 19.5667 12.7072 19.9572L13.9999 21.2499" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M17.4999 9.74921L11.3282 15.921C10.2237 17.0255 8.43272 17.0255 7.32823 15.921C6.22373 14.8164 6.22373 13.0255 7.32823 11.921L13.4999 5.74939" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  setup: '<svg viewBox="0 0 24 24"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
  skins: '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-1 0-.83.67-1.5 1.5-1.5H16c3.31 0 6-2.69 6-6 0-4.96-4.49-9-10-9zM6.5 13c-.83 0-1.5-.67-1.5-1.5S5.67 10 6.5 10 8 10.67 8 11.5 7.33 13 6.5 13zm3-4C8.67 9 8 8.33 8 7.5S8.67 6 9.5 6s1.5.67 1.5 1.5S10.33 9 9.5 9zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 6 14.5 6s1.5.67 1.5 1.5S15.33 9 14.5 9zm3 4c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>',
  social: '<svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>',
  skills: '<svg viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>',
  permissions: '<svg viewBox="0 0 24 24"><path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm-3 8V7a3 3 0 1 1 6 0v3z"/></svg>',
  opencode: '<svg viewBox="0 0 24 24"><rect x="3" y="2" width="18" height="20" rx="2"/><rect x="7" y="7" width="10" height="10" rx="1"/></svg>',
  discord: '<svg viewBox="0 0 24 24"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>',
  whatsapp: '<svg viewBox="0 0 24 24"><path d="M3.5 20.5l1.3-3.9A8.5 8.5 0 1 1 8 19.6z"/><path d="M9.5 8.5c.4 2.6 2.9 5.2 5.5 5.6l1-1.2 1.6.8c-.3 1-1.1 1.6-2.1 1.5-2.9-.3-5.8-3.2-6.1-6.1-.1-1 .5-1.8 1.5-2.1l.8 1.6z"/></svg>',
  morelogin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M12 11.5a1 1 0 0 0-1 1c0 1.8-.3 3.6-1.2 5.2"/><path d="M7.8 14.5a8 8 0 0 0-.6 4.3"/><path d="M12 7.5a4.5 4.5 0 0 1 4.5 4.5c0 .6 0 1.2-.1 1.8"/><path d="M5 9.2a7 7 0 0 1 11-1.9"/><path d="M15 13a3 3 0 0 1-3 3"/></svg>',
};

// ── Shared icon constants ──

const COPY_ICON = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHEVRON_ICON = '<svg class="cc-section-chevron" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>';
const ANTHROPIC_ICON = '<svg viewBox="0 0 24 24" class="cc-provider-icon"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" fill="currentColor"/></svg>';
const GEMINI_ICON = '<svg viewBox="0 0 24 24" class="cc-provider-icon"><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" fill="currentColor"/></svg>';
const OPENAI_ICON = '<svg viewBox="0 0 24 24" class="cc-provider-icon"><path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" fill="currentColor"/></svg>';
const OPENCODE_ICON = '<svg viewBox="0 0 24 30" class="cc-provider-icon" fill="currentColor"><path d="M18 6H6V24H18V6ZM24 30H0V0H24V30Z"/></svg>';
const BROWSER_ICON = '<svg viewBox="0 0 24 24" class="cc-provider-icon"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.5"/><ellipse cx="12" cy="12" rx="4" ry="10" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="2" y1="12" x2="22" y2="12" stroke="currentColor" stroke-width="1.5"/><path d="M4.5 7h15M4.5 17h15" fill="none" stroke="currentColor" stroke-width="1"/></svg>';

// ── Toast helper ──

function showCCToast(msg, duration = 3500) {
  let toast = document.querySelector('.cc-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'cc-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), duration);
}

// ═══════════════════════════════════════════
// INTERFACE CUSTOMIZATION — config, presets, apply
// ═══════════════════════════════════════════

const IFACE_DEFAULTS = {
  visualizationEnabled: true,
  scale: 1,
  glassOpacity: 0.72,
  // 16 keeps the glass look at a fraction of the compositing cost — users can
  // still crank the slider to 80 to explicitly opt back into heavier blur
  glassBlur: 16,
  glassSaturate: 1.4,
  glassBorderOpacity: 0.06,
  glassShadowOpacity: 0.4,
  glassShadowSpread: 20,
  glassRadius: 14,
  fontScale: 1,
  accentHue: 0,
  accentSaturation: 0,
  accentLightness: 80,
};

const IFACE_PRESETS = {
  default: { label: 'Default',  desc: 'Standard glass look',      values: { ...IFACE_DEFAULTS } },
  frosted: { label: 'Frosted',  desc: 'High blur, soft edges',    values: { glassOpacity: 0.5, glassBlur: 24, glassSaturate: 1.6, glassBorderOpacity: 0.1, glassShadowOpacity: 0.3, glassShadowSpread: 30, glassRadius: 18 } },
  solid:   { label: 'Solid',    desc: 'Opaque, minimal blur',     values: { glassOpacity: 0.92, glassBlur: 10, glassSaturate: 1.0, glassBorderOpacity: 0.15, glassShadowOpacity: 0.5, glassShadowSpread: 10, glassRadius: 10 } },
  minimal: { label: 'Minimal',  desc: 'Near-invisible panels',    values: { glassOpacity: 0.3, glassBlur: 20, glassSaturate: 1.2, glassBorderOpacity: 0.03, glassShadowOpacity: 0.15, glassShadowSpread: 8, glassRadius: 14 } },
};

// Slider definitions: [configKey, label, min, max, step, decimals]
const IFACE_SLIDERS = {
  'Glass & Transparency': [
    ['glassOpacity',       'Panel Opacity',      0,   1,    0.01, 2],
    ['glassBlur',          'Backdrop Blur',       0,   80,   1,    0],
    ['glassSaturate',      'Backdrop Saturation', 0.5, 2.5,  0.1,  1],
    ['glassBorderOpacity', 'Border Opacity',      0,   0.3,  0.01, 2],
  ],
  'Shadows': [
    ['glassShadowOpacity', 'Shadow Intensity',    0,   1,    0.01, 2],
    ['glassShadowSpread',  'Shadow Spread',        0,   60,   1,    0],
  ],
  'Shape': [
    ['glassRadius',        'Corner Radius',       0,   30,   1,    0],
  ],
  'Typography': [
    ['fontScale',          'Font Scale',           0.7, 1.5,  0.01, 2],
  ],
};

export function loadIfaceConfig() {
  try {
    const raw = storage.getItem('neural-interface-config');
    if (raw) return { ...IFACE_DEFAULTS, ...JSON.parse(raw) };
    // Migrate legacy ui-scale if present
    const legacyScale = storage.getItem('neural-ui-scale');
    if (legacyScale) {
      const cfg = { ...IFACE_DEFAULTS, scale: parseFloat(legacyScale) || 1 };
      saveIfaceConfig(cfg);
      return cfg;
    }
    return { ...IFACE_DEFAULTS };
  } catch { return { ...IFACE_DEFAULTS }; }
}

export function saveIfaceConfig(cfg) {
  storage.setItem('neural-interface-config', JSON.stringify(cfg));
  // Keep legacy key in sync for backwards compat
  storage.setItem('neural-ui-scale', cfg.scale);
}

export function applyIfaceConfig(cfg, { instant = false } = {}) {
  const r = document.documentElement.style;
  r.setProperty('--ui-scale', cfg.scale);
  r.setProperty('--glass-opacity', cfg.glassOpacity);
  r.setProperty('--glass-blur', cfg.glassBlur);
  r.setProperty('--glass-saturate', cfg.glassSaturate);
  r.setProperty('--glass-border-opacity', cfg.glassBorderOpacity);
  r.setProperty('--glass-shadow-opacity', cfg.glassShadowOpacity);
  r.setProperty('--glass-shadow-spread', cfg.glassShadowSpread);
  r.setProperty('--glass-radius', cfg.glassRadius);
  r.setProperty('--font-scale', cfg.fontScale);
  r.setProperty('--accent-hue', cfg.accentHue);
  r.setProperty('--accent-saturation', cfg.accentSaturation + '%');
  r.setProperty('--accent-lightness', cfg.accentLightness + '%');

  // Focus Mode — scale+blur transition with staggered controls
  const vizEnabled = cfg.visualizationEnabled !== false;
  const graphContainer = document.getElementById('graph-container');
  const staticBg = document.getElementById('static-bg');

  if (!vizEnabled) {
    // ENTERING FOCUS MODE

    // ── Clean up all interactive state ──
    // Hide 3D tooltip + detach its mousemove listener
    const $tooltip = document.getElementById('tooltip');
    if ($tooltip) {
      $tooltip.classList.remove('visible');
      if ($tooltip._moveHandler) {
        document.removeEventListener('mousemove', $tooltip._moveHandler);
        $tooltip._moveHandler = null;
      }
    }
    // Hide data-tooltip tooltips
    const uiTip = document.querySelector('.ui-tooltip');
    if (uiTip) {
      uiTip.classList.remove('visible');
      uiTip.style.display = 'none';
    }
    // Clear hover state
    state.hoveredNodeId = null;
    // Clear multi-select
    if (state.multiSelected.size > 0) {
      state.multiSelected.clear();
      const bar = document.getElementById('multi-select-bar');
      if (bar) bar.classList.remove('open');
      emit('multiselect:cleared');
    }
    // Reset cursor
    document.body.style.cursor = 'default';

    // Hide controls, 2D canvases, category sidebar
    for (const id of ['controls-panel', 'stats-bar', 'category-sidebar']) {
      const el = document.getElementById(id);
      if (el) el.classList.add('viz-hidden');
    }
    for (const id of ['bg-canvas', 'hull-canvas', 'lasso-canvas']) {
      const el = document.getElementById(id);
      if (el) el.classList.add('viz-hidden-2d');
    }
    if (instant) {
      // Page load — apply immediately without animation
      if (graphContainer) graphContainer.classList.add('focus-active');
      if (staticBg) staticBg.classList.add('visible');
    } else {
      // User toggle — stagger: controls fade first, then iris closes
      setTimeout(() => {
        if (graphContainer) graphContainer.classList.add('focus-active');
        if (staticBg) staticBg.classList.add('visible');
      }, 100);
    }
    // Notify variant-specific cleanup (lasso, context menu, etc.)
    emit('focus:enter');
  } else {
    // EXITING FOCUS MODE
    // Iris open the graph + close focus bg
    if (graphContainer) graphContainer.classList.remove('focus-active');
    if (staticBg) staticBg.classList.remove('visible');
    // 2D canvases
    for (const id of ['bg-canvas', 'hull-canvas', 'lasso-canvas']) {
      const el = document.getElementById(id);
      if (el) el.classList.remove('viz-hidden-2d');
    }
    if (instant) {
      // Page load — show controls immediately
      for (const id of ['controls-panel', 'stats-bar', 'category-sidebar']) {
        const el = document.getElementById(id);
        if (el) el.classList.remove('viz-hidden');
      }
    } else {
      // User toggle — delay controls until iris starts opening
      setTimeout(() => {
        for (const id of ['controls-panel', 'stats-bar', 'category-sidebar']) {
          const el = document.getElementById(id);
          if (el) el.classList.remove('viz-hidden');
        }
      }, 200);
    }
    emit('focus:exit');
  }
  // Notify variants to pause/resume rendering
  emit('viz:toggle', vizEnabled);
}

/** Call on page load to restore saved interface config */
export function restoreInterfaceConfig() {
  // Suppress transitions during initial load to prevent flash
  document.documentElement.classList.add('no-transition');
  applyIfaceConfig(loadIfaceConfig(), { instant: true });
  // Re-enable transitions after a frame
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.documentElement.classList.remove('no-transition');
    });
  });
}

// ═══════════════════════════════════════════
// SKIN LOADING — stylesheet injection + boot restore
// ═══════════════════════════════════════════

const SKIN_LINK_ID = 'synabun-skin-css';

/** Insert or update the skin stylesheet <link> */
function loadSkinStylesheet(skinId) {
  if (!skinId || skinId === 'default') {
    removeSkinStylesheet();
    return;
  }
  let link = document.getElementById(SKIN_LINK_ID);
  if (!link) {
    link = document.createElement('link');
    link.id = SKIN_LINK_ID;
    link.rel = 'stylesheet';
    // Insert after the main styles.css
    const mainCSS = document.querySelector('link[href*="styles.css"]');
    if (mainCSS && mainCSS.nextSibling) {
      mainCSS.parentNode.insertBefore(link, mainCSS.nextSibling);
    } else {
      document.head.appendChild(link);
    }
  }
  link.href = `/skins/${skinId}/skin.css`;
  storage.setItem(KEYS.ACTIVE_SKIN, skinId);
}

/** Remove the skin stylesheet */
function removeSkinStylesheet() {
  const link = document.getElementById(SKIN_LINK_ID);
  if (link) link.remove();
  storage.setItem(KEYS.ACTIVE_SKIN, 'default');
}

/** Restore active skin on page load. Export for variant main.js to call. */
export function restoreSkin() {
  const skinId = storage.getItem(KEYS.ACTIVE_SKIN) || 'default';
  if (skinId && skinId !== 'default') {
    loadSkinStylesheet(skinId);
  }
}

// Listen for cross-tab skin changes via WebSocket
on('sync:skin:changed', (msg) => {
  const id = msg?.id || 'default';
  if (id === 'default') removeSkinStylesheet();
  else loadSkinStylesheet(id);
  // Update settings panel if open
  const panel = document.getElementById('settings-panel');
  if (panel) refreshSkinsTab(panel);
});

// ═══════════════════════════════════════════
// SKINS TAB — builder + interaction
// ═══════════════════════════════════════════

function buildSkinsTab(skins = [], activeSkin = 'default') {
  const activeMeta = skins.find(s => s.id === activeSkin) || { name: activeSkin };
  const sk = (key, params) => kit.te(`settings.redesign.skins.${key}`, params);

  let cardsHtml = '';
  for (const s of skins) {
    const isActive = s.id === activeSkin;
    const previewHtml = s.preview
      ? `<div class="skin-preview" style="background-image:url(/skins/${escapeHtml(s.id)}/${escapeHtml(s.preview)})"></div>`
      : `<div class="skin-preview-fallback">${escapeHtml(s.name)}</div>`;

    const badgeHtml = isActive ? `<span class="skin-active-badge">${sk('active')}</span>` : '';
    const removeBtn = s.builtin ? '' : `<button type="button" class="skin-remove" data-skin-id="${escapeHtml(s.id)}" ${kit.inv('SKN005')} title="${kit.H('SKN005')}">${kit.L('SKN005')}</button>`;
    const activateBtn = isActive ? '' : `<button type="button" class="skin-activate" data-skin-id="${escapeHtml(s.id)}" ${kit.inv('SKN004')} title="${kit.H('SKN004')}">${kit.L('SKN004')}</button>`;

    cardsHtml += `
      <div class="skin-card${isActive ? ' active' : ''}" data-skin-id="${escapeHtml(s.id)}">
        ${previewHtml}
        ${badgeHtml}
        <div class="skin-info">
          <span class="skin-name">${escapeHtml(s.name)}</span>
          <span class="skin-author">${s.author ? sk('by', { author: s.author }) : ''}</span>
        </div>
        <div class="skin-actions">
          ${activateBtn}
          ${removeBtn}
        </div>
      </div>`;
  }

  return `<div class="stg-pane" data-stg-pane="skins">
    ${kit.card({
      id: 'stg-sec-themes', section: 'appearance.themes',
      status: `<span class="skin-active-strip" ${kit.inv('SKN003')}>
        <span class="skin-active-dot"></span>
        <span class="skin-active-name">${escapeHtml(activeMeta.name)}</span>
        <span>${sk('activeWord')}</span>
      </span>`,
      body: `
    <div class="skin-grid" id="skin-grid" role="group" aria-label="${kit.L('SKN003')}">
      ${cardsHtml}
    </div>
    <div class="skin-upload-area">
      <button type="button" class="skin-upload-btn" id="skin-upload-btn" ${kit.inv('SKN001')} aria-describedby="skin-upload-btn-help">${kit.L('SKN001')}</button>
      <input type="file" id="skin-file-input" ${kit.inv('SKN002')} accept=".zip" style="display:none" aria-label="${kit.L('SKN002')}">
      <span class="skin-upload-msg" id="skin-upload-msg" role="status" aria-live="polite"></span>
    </div>
    ${kit.help('SKN001', { forId: 'skin-upload-btn' })}`,
    })}
  </div>`;
}

/** Refresh the skins tab in an already-open settings panel */
async function refreshSkinsTab(panel) {
  try {
    const resp = await fetch('/api/skins').then(r => r.json());
    if (!resp.ok) return;
    const tabBody = kit.paneOf(panel, 'skins');
    if (!tabBody) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = buildSkinsTab(resp.skins, resp.active);
    const newBody = kit.paneOf(tmp, 'skins');
    tabBody.innerHTML = newBody.innerHTML;
    wireSkinsTab(panel, resp.skins, resp.active);
  } catch {}
}

/** Wire interaction handlers for the skins tab */
function wireSkinsTab(overlay, skins, activeSkin) {
  // Activate buttons
  overlay.querySelectorAll('.skin-activate').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.skinId;
      try {
        const resp = await fetch(`/api/skins/${id}/activate`, { method: 'PUT' }).then(r => r.json());
        if (resp.ok) {
          loadSkinStylesheet(id);
          refreshSkinsTab(overlay);
        }
      } catch {}
    });
  });

  // Remove buttons
  overlay.querySelectorAll('.skin-remove').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.skinId;
      if (!confirm(kit.tx('settings.redesign.skins.removeSkin', { id: id }))) return;
      try {
        const resp = await fetch(`/api/skins/${id}`, { method: 'DELETE' }).then(r => r.json());
        if (resp.ok) {
          // If the deleted skin was active, revert to default
          const currentSkin = storage.getItem(KEYS.ACTIVE_SKIN) || 'default';
          if (currentSkin === id) removeSkinStylesheet();
          refreshSkinsTab(overlay);
        }
      } catch {}
    });
  });

  // Upload button
  const uploadBtn = overlay.querySelector('#skin-upload-btn');
  const fileInput = overlay.querySelector('#skin-file-input');
  const uploadMsg = overlay.querySelector('#skin-upload-msg');
  if (uploadBtn && fileInput) {
    uploadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (!file) return;
      fileInput.value = '';
      uploadMsg.textContent = kit.tx('settings.redesign.skins.installing');
      uploadMsg.className = 'skin-upload-msg';
      try {
        const buf = await file.arrayBuffer();
        const resp = await fetch('/api/skins/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/zip' },
          body: buf,
        }).then(r => r.json());
        if (resp.ok) {
          uploadMsg.textContent = kit.tx('settings.redesign.skins.installed', { name: resp.skin.name });
          uploadMsg.className = 'skin-upload-msg success';
          refreshSkinsTab(overlay);
        } else {
          uploadMsg.textContent = resp.error || kit.tx('settings.redesign.skins.uploadFailed');
          uploadMsg.className = 'skin-upload-msg error';
        }
      } catch (err) {
        uploadMsg.textContent = err.message || kit.tx('settings.redesign.skins.uploadFailed');
        uploadMsg.className = 'skin-upload-msg error';
      }
      setTimeout(() => { if (uploadMsg) uploadMsg.textContent = ''; }, 5000);
    });
  }
}

// ═══════════════════════════════════════════
// TAB HTML BUILDERS
// ═══════════════════════════════════════════

// ── Pages ──
// The page list, their sections and every old-tab alias live in ./settings/settings-ia.js.

function buildNavHTML(activeId) {
  let html = '';
  for (const group of SETTINGS_GROUPS) {
    const pages = SETTINGS_PAGES.filter(p => p.group === group.id);
    if (!pages.length) continue;
    if (html) html += `<div class="settings-nav-sep"></div>\n`;
    html += `<div class="stg-nav-group-label">${kit.te(group.labelKey)}</div>\n`;
    for (const page of pages) {
      const keys = pageKeys(page);
      const active = page.id === activeId;
      html += `<button type="button" class="settings-nav-item${active ? ' active' : ''}" data-tab="${page.id}"${active ? ' aria-current="page"' : ''}>
      <span class="stg-nav-icon">${TAB_ICONS[page.icon] || ''}</span>
      <span class="stg-nav-text">
        <span class="stg-nav-label">${kit.te(keys.navLabel)}<span class="stg-nav-status-text stg-sr"></span></span>
        <span class="stg-nav-desc">${kit.te(keys.navHelp)}</span>
      </span>
    </button>\n`;
    }
  }
  return html;
}

/** The nav rail's stand-in on a narrow panel: one labelled select that lists every page. */
function buildPagePickerHTML(activeId) {
  const groups = SETTINGS_GROUPS.map(group => {
    const options = SETTINGS_PAGES.filter(p => p.group === group.id).map(page => {
      const keys = pageKeys(page);
      return `<option value="${page.id}"${page.id === activeId ? ' selected' : ''}>${kit.te(keys.navLabel)} — ${kit.te(keys.navHelp)}</option>`;
    }).join('');
    return options ? `<optgroup label="${kit.te(group.labelKey)}">${options}</optgroup>` : '';
  }).join('');
  return `<div class="stg-page-picker">
        <label for="stg-page-select">${kit.te('settings.redesign.common.allPages')}</label>
        <select id="stg-page-select">${groups}</select>
      </div>`;
}

/** The search field above the page list, and the results list that takes the list's place while it holds a query. */
function buildSearchHTML() {
  return `<div class="stg-search" role="search">
          <svg class="stg-search-glyph" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.75"/><path d="m10.5 10.5 3.25 3.25"/></svg>
          <input type="text" class="stg-search-input" id="stg-search-input" role="combobox" aria-expanded="false" aria-controls="stg-search-list" aria-autocomplete="list" aria-label="${kit.te('settings.redesign.search.label')}" placeholder="${kit.te('settings.redesign.search.placeholder')}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="search">
          <button type="button" class="stg-search-clear" id="stg-search-clear" aria-label="${kit.te('settings.redesign.search.clear')}" hidden><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5.25 5.25 5.5 5.5m0-5.5-5.5 5.5"/></svg></button>
        </div>
        <div class="stg-search-results" id="stg-search-results" hidden>
          <div class="stg-search-list" id="stg-search-list" role="listbox" aria-label="${kit.te('settings.redesign.search.results')}"></div>
          <div class="stg-search-note" id="stg-search-note" hidden></div>
        </div>
        <div class="stg-sr" id="stg-search-status" role="status" aria-live="polite"></div>`;
}

// What search reads from the panel beside its index (settings-search.js): the labelled rows of the panes that draw
// themselves, and the names of what the panes load (projects, providers, tools, tool profiles and servers, skills,
// browser profiles, themes, the linked WhatsApp account). Labels and names only: a source names label elements and
// the shell reads their text, never a value; `help` is given only where it is the app's own copy. `named` rows may
// sit inside an inventory control (a list it tags).
const SEARCH_ROW_SOURCES = [
  { selector: '.settings-field > label, .stg-field > label, .stg-toggle-label, .recall-control-label, .cc-integration-label, .wa-phone > label', row: '.settings-field, .stg-field, .stg-toggle-field, .recall-control-header, .cc-integration-item, .wa-phone' },
  { selector: '.wa-toggle-row strong, .wa-radio strong, .wa-mode-head strong', row: '.wa-toggle-row, .wa-radio, .wa-mode-card, .wa-level-card', help: 'small, .wa-mode-body' },
  { selector: '.stg-subhead, .ocp-danger-title, .stg-mcp-form-label' },
  { selector: '.stg-card-body .stg-card-title', row: '.stg-card' },
  { selector: '.recall-profile-name, .gfx-preset-name', row: '[role="radio"], button', named: true },
  { selector: '[data-stg-pane="judgments"] button, [data-stg-pane="whatsapp"] button', caption: true },
  { selector: '#jv-surfaces-body td:nth-child(2) > div:first-child', row: 'tr', help: '.settings-hint', named: true },
  { selector: '#cc-project-list .cc-panel-title', row: '.cc-panel', named: true },
  { selector: '.stg-provider-name', row: '.stg-provider-card', named: true },
  { selector: '.stg-tool-name', row: '.stg-tool-row', named: true },
  { selector: '.stg-mx-profile-name, .stg-mx-grp-name, .stg-mx-ext-name', row: '.stg-mx-ext-row, tr', named: true },
  { selector: '.cc-skill-name', row: '.cc-skill-row', help: '.cc-skill-desc', named: true },
  { selector: '.bc-profile-name', row: '.bc-profile-item', named: true },
  { selector: '#ml-profile-list > div > span:first-child', row: '#ml-profile-list > div', named: true },
  { selector: '.skin-name', row: '.skin-card', named: true },
  { selector: '#wa-sub', row: '.wa-header', named: true },
];
// Never read: lists of the user's own content (memories, messages, logs). A pane opts a container out with data-stg-search="off".
const SEARCH_OFF = '[data-stg-search="off"], #jv-sessions-list, #jv-log-list, #jv-misfiled-list, #jv-supersessions-list, #jv-triage-list, #jv-bench-result, #jv-test-result, #wa-activity-list, #memory-maintenance details, #sync-results';

/** A variant-registered tab (the 2D Graphics tab) becomes one collapsed card on the page that hosts variant panes. */
function buildVariantPane(tab) {
  const known = tab.id === 'graphics';
  return `<div class="stg-pane" data-stg-pane="${tab.id}">${kit.card({
    id: known ? 'stg-sec-2d-graph' : `stg-sec-variant-${tab.id}`,
    section: known ? 'appearance.d2_graph' : `variant.${tab.id}`,
    title: known ? undefined : kit.esc(tab.label),
    purpose: known ? undefined : '',
    collapsible: true, collapsed: true, advanced: true,
    body: tab.build(),
  })}</div>`;
}

/** Every page: heading, then the panes its builders own, in the order settings-ia.js lists them. */
function buildPagesHTML(panes, variantTabs, activeId) {
  return SETTINGS_PAGES.map(page => {
    let body = '';
    for (const pane of page.panes) {
      if (panes[pane.id] == null) continue;
      if (pane.titleKey) body += `<h3 class="stg-pane-title" id="stg-pane-title-${pane.id}">${kit.te(pane.titleKey)}</h3>\n`;
      body += panes[pane.id];
    }
    if (page.variantPanes) for (const tab of variantTabs) body += buildVariantPane(tab);
    return `<div class="settings-tab-body stg-page${page.id === activeId ? ' active' : ''}" data-tab="${page.id}">${kit.pageHead(page.key)}${body}</div>`;
  }).join('\n');
}

function buildServerTab(settings, connections = []) {
  const conn = connections[0] || {};
  const dbSizeMB = settings.dbSizeBytes ? (settings.dbSizeBytes / 1024 / 1024).toFixed(1) : '0';
  const sqlite = settings.storage === 'sqlite';
  const memoryCount = conn.points || 0;
  const modelKind = settings.embedding === 'local'
    ? kit.tx('settings.redesign.server.modelLocal')
    : (settings.embedding || kit.tx('settings.redesign.server.modelUnknown'));
  const modelValue = kit.tx('settings.redesign.server.modelValue', {
    kind: modelKind,
    model: settings.embeddingModel || kit.tx('settings.redesign.server.modelNone'),
    dims: settings.embeddingDims || '?',
  });
  const intervalOptions = [30, 60, 180, 360].map(value => ({ value, label: kit.te(`settings.redesign.server.every.${value}`) }));
  const buttonIcon = (shapes) => `<svg viewBox="0 0 24 24" aria-hidden="true">${shapes}</svg>`;

  return `
      <div class="stg-pane" data-stg-pane="server">

        ${kit.card({
          id: 'stg-sec-database', section: 'memory_backups.database',
          status: `<span class="stg-pill" id="stg-db-status" ${kit.inv('GEN015')} data-state="${sqlite ? 'ok' : 'err'}">${kit.te(sqlite ? 'settings.redesign.server.dbReady' : 'settings.redesign.server.dbUnavailable')}</span>`,
          body: `
          <div class="stg-field" ${kit.inv('GEN001')}>
            <label for="stg-db-path">${kit.L('GEN001')}</label>
            <div class="settings-key-row">
              <input type="text" id="stg-db-path" value="${escapeHtml(settings.dbPath || '')}" autocomplete="off" spellcheck="false" aria-describedby="stg-db-path-help stg-db-hint">
              <button type="button" class="stg-action-btn compact" id="stg-db-browse-btn" ${kit.inv('GEN002')} title="${kit.H('GEN002')}">${kit.L('GEN002')}</button>
              <button type="button" class="stg-action-btn compact" id="stg-db-move-btn" ${kit.inv('GEN003')} title="${kit.H('GEN003')}">${kit.L('GEN003')}</button>
            </div>
            ${kit.help('GEN001', { forId: 'stg-db-path' })}
            <div id="stg-db-browser" role="region" aria-label="${kit.L('GEN002')}" style="display:none;margin:4px 0 8px;border:1px solid var(--s-medium);border-radius:6px;background:var(--s-darker);max-height:220px;overflow-y:auto"></div>
            <div class="stg-help" id="stg-db-hint" ${kit.inv('GEN016')} aria-live="polite">${settings.dbExists ? kit.te('settings.redesign.server.fileFound', { size: dbSizeMB }) : kit.te('settings.redesign.server.fileMissing')}</div>
            <div id="stg-db-move-status" class="stg-inline-status" role="status" style="display:none;margin-top:8px;align-items:center;gap:8px"></div>
            <div id="stg-db-move-cleanup" class="stg-callout stg-callout-success" role="status" style="display:none;margin-top:8px;padding:10px 12px;background:rgba(109,213,140,0.08);border:1px solid rgba(109,213,140,0.2);border-radius:8px;">
              <div class="stg-callout-title">${kit.te('settings.redesign.server.moveDoneTitle')}</div>
              <div class="stg-callout-copy">${kit.te('settings.redesign.server.moveDoneCopy')}</div>
              <div class="stg-callout-copy" id="stg-db-old-path"></div>
              <div id="stg-db-mcp-notice" class="stg-callout-note">${kit.te('settings.redesign.server.moveRestartNote')}</div>
              <div class="stg-action-row">
                <button type="button" class="stg-action-btn" id="stg-db-delete-old" ${kit.inv('GEN004')} aria-describedby="stg-db-delete-old-help">${kit.L('GEN004')}</button>
                <button type="button" class="stg-action-btn" id="stg-db-keep-old" ${kit.inv('GEN005')} aria-describedby="stg-db-keep-old-help">${kit.L('GEN005')}</button>
              </div>
              <div class="stg-help" id="stg-db-delete-old-help">${kit.H('GEN004')}</div>
              <div class="stg-help" id="stg-db-keep-old-help">${kit.H('GEN005')}</div>
            </div>
          </div>
          ${kit.field('GEN006', `
            <div class="settings-key-row">
              <input type="text" id="stg-embedding-model" ${kit.inv('GEN017')} value="${kit.esc(modelValue)}" readonly autocomplete="off" spellcheck="false" aria-describedby="stg-embedding-model-help">
            </div>`, { forId: 'stg-embedding-model' })}
          ${kit.subhead(kit.te('settings.redesign.server.summary'))}
          <div class="conn-list" id="conn-list" ${kit.inv('DB003')} role="group" aria-label="${kit.L('DB003')}" aria-describedby="conn-list-help">
            <div class="conn-item active">
              <div class="conn-item-dot"></div>
              <div class="conn-item-info">
                <div class="conn-item-name">${kit.te('settings.redesign.server.localDb')}</div>
                <div class="conn-item-meta">${escapeHtml(settings.dbPath || 'memories.db')}</div>
              </div>
              <span class="conn-item-count">${kit.te(memoryCount === 1 ? 'settings.redesign.server.memories.one' : 'settings.redesign.server.memories.other', { count: memoryCount })}</span>
            </div>
          </div>
          <div class="db-stats-row">
            <div class="db-stat">
              <span class="db-stat-label">${kit.te('settings.redesign.server.statStorage')}</span>
              <span class="db-stat-value">${kit.te('settings.redesign.server.sqlite')}</span>
            </div>
            <div class="db-stat">
              <span class="db-stat-label">${kit.te('settings.redesign.server.statSize')}</span>
              <span class="db-stat-value">${kit.te('settings.redesign.server.sizeMb', { size: dbSizeMB })}</span>
            </div>
          </div>
          ${kit.help('DB003', { forId: 'conn-list' })}`,
        })}

        ${kit.card({
          id: 'stg-sec-backups', section: 'memory_backups.backups',
          status: kit.pill('', { id: 'auto-backup-pill', state: 'off' }),
          body: `
          ${kit.subhead(kit.te('settings.redesign.server.fullBackup'))}
          <div class="stg-field" ${kit.inv('GEN007')}>
            <div class="stg-action-row">
              <button type="button" class="stg-action-btn" id="sys-backup-btn" aria-describedby="sys-backup-btn-help">
                ${buttonIcon('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>')}
                ${kit.L('GEN007')}
              </button>
            </div>
            ${kit.help('GEN007', { forId: 'sys-backup-btn' })}
          </div>
          <div class="stg-field" ${kit.inv('GEN008')}>
            <div class="stg-action-row">
              <button type="button" class="stg-action-btn" id="sys-restore-btn" aria-describedby="sys-restore-btn-help">
                ${buttonIcon('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>')}
                ${kit.L('GEN008')}
              </button>
              <input type="file" id="sys-restore-file" ${kit.inv('GEN009')} accept=".zip" style="display:none" aria-label="${kit.L('GEN009')}" title="${kit.H('GEN009')}">
            </div>
            ${kit.help('GEN008', { forId: 'sys-restore-btn' })}
          </div>
          <div id="sys-backup-status" class="stg-inline-status" role="status" style="display:none;margin-top:10px;align-items:center;gap:8px">
            <div class="wiz-status-dot spin" id="sys-backup-dot"></div>
            <span id="sys-backup-text"></span>
          </div>

          ${kit.subhead(kit.te('settings.redesign.server.autoBackup'))}
          ${kit.toggleField('GEN010', kit.switchInput('auto-backup-toggle'), { forId: 'auto-backup-toggle' })}
          <div id="auto-backup-options" style="display:none">
            ${kit.field('GEN011', kit.dropdown('auto-backup-interval', intervalOptions, { value: 360, label: kit.L('GEN011') }))}
            ${kit.field('GEN012', `
              <div class="stg-input-row">
                <input type="text" id="auto-backup-folder" placeholder="${kit.te('settings.redesign.server.folderPlaceholder')}" readonly autocomplete="off" spellcheck="false" aria-describedby="auto-backup-folder-help">
                <button type="button" class="stg-action-btn compact" id="auto-backup-browse" ${kit.inv('GEN013')} title="${kit.H('GEN013')}">${kit.L('GEN013')}</button>
              </div>`, { forId: 'auto-backup-folder' })}
            <div class="stg-field" ${kit.inv('GEN014')}>
              <div class="stg-action-row">
                <button type="button" class="stg-action-btn" id="auto-backup-now" aria-describedby="auto-backup-now-help">
                  ${buttonIcon('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>')}
                  ${kit.L('GEN014')}
                </button>
              </div>
              ${kit.help('GEN014', { forId: 'auto-backup-now' })}
            </div>
            <div id="auto-backup-info" class="stg-help" ${kit.inv('GEN018')} role="status" aria-live="polite"></div>
            ${kit.help('GEN018', { forId: 'auto-backup-info' })}
          </div>`,
        })}

      </div>`;
}

function buildBrowserTab() {
  const b = (key) => kit.te(`settings.redesign.browser.${key}`);
  const SEARCH = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
  const REFRESH = '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
  const FOLDER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>';

  // The app's custom select, wired by the browser pane itself (.bc-dropdown). `name` picks the option labels.
  const dd = (invId, id, name, values, { disabled = false, style = '', attrs = '' } = {}) => kit.dropdown(id,
    values.map(value => ({ value, label: b(`opt.${name}.${value || 'auto'}`) })),
    { classes: 'bc-dropdown', label: kit.L(invId), disabled, attrs: `${kit.inv(invId)}${style ? ` style="${style}"` : ''}${attrs ? ` ${attrs}` : ''}` });
  const text = (id, { ph = '', type = 'text', attrs = '' } = {}) =>
    `<input type="${type}" class="browser-cfg-input" id="${id}"${ph ? ` placeholder="${ph}"` : ''} spellcheck="false" autocomplete="off" aria-describedby="${id}-help"${attrs ? ` ${attrs}` : ''}>`;
  const field = (invId, id, o = {}) => kit.field(invId, text(id, o), { forId: id, attrs: o.row || '' });
  // A number inside a group of related values: its own name for assistive tech, the group's label and help on screen.
  const num = (invId, id, value, attrs, cls = ' browser-cfg-input-sm') =>
    `<input type="number" class="browser-cfg-input${cls}" id="${id}" value="${value}" ${attrs} ${kit.inv(invId)} aria-label="${kit.L(invId)}" title="${kit.L(invId)}">`;
  const numField = (invId, id, value, attrs) => kit.field(invId,
    `<input type="number" class="browser-cfg-input" id="${id}" value="${value}" ${attrs} aria-describedby="${id}-help">`, { forId: id });
  const tog = (invId, id, on = false) => kit.toggleField(invId,
    `<button type="button" class="cc-toggle${on ? ' on' : ''}" id="${id}" aria-labelledby="${id}-label" aria-describedby="${id}-help"></button>`, { forId: id });
  const group = (key, inner, attrs = '') => `
          <div class="stg-field"${attrs ? ` ${attrs}` : ''}>
            <label id="bc-g-${key}-label">${b(`group.${key}.label`)}</label>
            <div class="bc-inline-group" role="group" aria-labelledby="bc-g-${key}-label" aria-describedby="bc-g-${key}-help">${inner}</div>
            <div class="stg-help" id="bc-g-${key}-help">${b(`group.${key}.help`)}</div>
          </div>`;
  const X = '<span class="bc-x" aria-hidden="true">&times;</span>';
  const unit = (invId) => `<span class="bc-unit">${kit.L(invId)}</span>`;
  const PERMISSIONS = [
    ['BRW050', 'geolocation'], ['BRW051', 'midi'], ['BRW052', 'midi-sysex'], ['BRW053', 'notifications'], ['BRW054', 'camera'],
    ['BRW055', 'microphone'], ['BRW056', 'background-sync'], ['BRW057', 'ambient-light-sensor'], ['BRW058', 'accelerometer'],
    ['BRW059', 'gyroscope'], ['BRW060', 'magnetometer'], ['BRW061', 'clipboard-read'], ['BRW062', 'clipboard-write'],
    ['BRW063', 'payment-handler'], ['BRW064', 'storage-access'],
  ];

  return `
      <div class="stg-pane" data-stg-pane="browser">

        ${kit.card({
          id: 'setup-browser', section: 'browser.browser_choice',
          body: `
          ${kit.field('BRW003', `<div class="bc-inline-group">${dd('BRW003', 'bc-browser', 'browser', ['auto', 'chrome', 'msedge', 'chromium', 'morelogin', 'custom'], { attrs: 'id="bc-browser-dropdown"' })}<input type="hidden" id="bc-channel" value=""></div>`)}
          <div class="stg-field bc-card-row" id="bcg-executable" ${kit.inv('BRW001')}>
            <label for="bc-executablePath">${kit.L('BRW001')}</label>
            <div class="browser-cfg-input-row">
              ${text('bc-executablePath', { ph: b('ph.autoDetect') })}
              <button type="button" class="cli-detect-btn" id="bc-detect-executable" ${kit.inv('BRW002')} title="${kit.H('BRW002')}">${SEARCH}${kit.L('BRW002')}</button>
            </div>
            <div class="stg-help" id="bc-executablePath-help">${kit.H('BRW001')}</div>
            <div class="browser-cfg-hint" id="bc-detected-path" ${kit.inv('BRW084')} role="status" aria-live="polite"></div>
          </div>
          ${group('pageSize', `
              ${num('BRW004', 'bc-viewportWidth', 1280, 'min="320" max="7680" step="1"')}${X}
              ${num('BRW005', 'bc-viewportHeight', 800, 'min="200" max="4320" step="1"')}`)}
          ${numField('BRW006', 'bc-deviceScaleFactor', 1, 'min="0.5" max="5" step="0.25" style="width:80px"')}
          ${tog('BRW007', 'bc-screencastEnabled')}
          ${kit.advanced(`
            ${kit.field('BRW008', dd('BRW008', 'bc-screencastFormat', 'format', ['jpeg', 'png'], { style: 'width:110px;flex:none' }))}
            ${kit.field('BRW009', `
              <div class="bc-inline-group">
                <input type="range" class="browser-cfg-range" id="bc-screencastQuality" value="60" min="10" max="100" step="5" style="flex:1;min-width:60px" aria-describedby="bc-screencastQuality-help">
                <span class="browser-cfg-range-val" id="bc-screencastQuality-val">60%</span>
              </div>`, { forId: 'bc-screencastQuality' })}`, { labelKey: 'settings.redesign.browser.previewOptions' })}`,
        })}

        ${kit.card({
          id: 'bcg-profiles', section: 'browser.browser_profiles',
          body: `
          <input type="hidden" id="bc-userDataDir" value="">
          ${kit.field('BRW011', dd('BRW011', 'bc-connectMode', 'connect', ['mirror', 'attach', 'morelogin']))}
          ${kit.field('BRW012', dd('BRW012', 'bc-attachSeed', 'seed', ['real', 'fresh']), { attrs: 'id="bc-attachSeed-row" style="display:none"' })}
          <div class="stg-field bc-card-row" id="bc-morelogin-row" ${kit.inv('BRW013')} style="display:none">
            <label for="bc-morelogin-env-id">${kit.L('BRW013')}</label>
            <div class="browser-cfg-input-row">
              <select class="browser-cfg-input" id="bc-morelogin-env-id" style="flex:1" aria-describedby="bc-morelogin-env-id-help"></select>
              <button type="button" class="cli-detect-btn" id="bc-morelogin-refresh" ${kit.inv('BRW014')} title="${kit.H('BRW014')}">${REFRESH}${kit.L('BRW014')}</button>
            </div>
            <div class="stg-help" id="bc-morelogin-env-id-help">${kit.H('BRW013')}</div>
          </div>
          <div class="stg-field" id="bc-morelogin-status-row" style="display:none">
            <span class="bc-hint-inline stg-help" id="bc-morelogin-status-text" role="status" aria-live="polite"></span>
          </div>
          <div class="stg-field bc-card-row" ${kit.inv('BRW083')}>
            <label id="bc-profile-list-label">${kit.L('BRW083')}</label>
            <div class="browser-cfg-input-row">
              <button type="button" class="cli-detect-btn" id="bc-detect-profiles" ${kit.inv('BRW010')} title="${kit.H('BRW010')}">${SEARCH}${kit.L('BRW010')}</button>
            </div>
            <div class="stg-help" id="bc-profile-list-help">${kit.H('BRW083')}</div>
          </div>
          <div class="bc-profile-list" id="bc-profile-list" role="group" aria-labelledby="bc-profile-list-label" aria-describedby="bc-profile-list-help">
            <div class="bc-profile-item selected" data-profile-value="">
              <span class="bc-profile-radio"></span>
              <span class="bc-profile-name">${b('cleanSandbox')}</span>
              <span class="bc-profile-hint">${b('noPersistentProfile')}</span>
            </div>
            <div class="bc-profile-item" data-profile-value="__synabun__">
              <span class="bc-profile-radio"></span>
              <span class="bc-profile-name">${b('synabunProfile')}</span>
              <span class="bc-profile-hint">${b('managed')}</span>
            </div>
          </div>
          <div id="bc-chrome-running-warn" class="stg-callout stg-callout-warn" role="status" style="display:none;margin:4px 0 2px;padding:4px 8px;border-radius:4px;background:rgba(255,180,0,0.12);color:#e0a800"></div>
          <div class="stg-field bc-card-row" ${kit.inv('BRW015')} style="margin-top:12px">
            <label for="bc-custom-profile-path">${kit.L('BRW015')}</label>
            <div class="browser-cfg-input-row">
              ${text('bc-custom-profile-path', { ph: b('ph.profileFolder'), attrs: 'style="flex:1"' })}
              <button type="button" class="cli-detect-btn" id="bc-browse-folder" ${kit.inv('BRW016')} title="${kit.H('BRW016')}">${FOLDER}${kit.L('BRW016')}</button>
            </div>
            <div class="stg-help" id="bc-custom-profile-path-help">${kit.H('BRW015')}</div>
            <div id="bc-browse-browser" role="region" aria-label="${kit.L('BRW016')}" style="display:none;margin:4px 0 4px;border:1px solid var(--s-medium);border-radius:6px;background:var(--s-darker);max-height:220px;overflow-y:auto"></div>
          </div>

          ${kit.subhead(b('sub.signins'))}
          ${tog('BRW017', 'bc-persistStorage')}
          ${field('BRW018', 'bc-storageStatePath', { ph: 'data/browser-storage.json', attrs: 'disabled', row: 'id="bc-storagePath-row" style="margin-top:12px"' })}
          ${tog('BRW019', 'bc-clearStorageOnStart')}

          ${kit.subhead(b('sub.privacy'))}
          ${tog('BRW020', 'bc-stealthFingerprint', true)}`,
        })}

        ${kit.card({
          id: 'bcg-identity', section: 'browser.identity_privacy', collapsible: true, collapsed: true, advanced: true,
          body: `
          ${field('BRW021', 'bc-userAgent', { ph: b('ph.userAgent') })}
          ${field('BRW022', 'bc-acceptLanguage', { ph: 'en-US,en;q=0.9' })}
          ${field('BRW023', 'bc-locale', { ph: 'en-US', attrs: 'style="max-width:160px"' })}
          ${field('BRW024', 'bc-timezoneId', { ph: 'America/New_York' })}
          ${kit.field('BRW025', `<textarea class="browser-cfg-textarea" id="bc-extraHTTPHeaders" rows="2" placeholder='{"X-Custom": "value"}' spellcheck="false" aria-describedby="bc-extraHTTPHeaders-help"></textarea>`, { forId: 'bc-extraHTTPHeaders' })}`,
        })}

        ${kit.card({
          id: 'bcg-viewport', section: 'browser.display', collapsible: true, collapsed: true, advanced: true,
          body: `
          ${group('screenSize', `
              ${num('BRW026', 'bc-screenWidth', 1920, 'min="320" max="7680" step="1"')}${X}
              ${num('BRW027', 'bc-screenHeight', 1080, 'min="200" max="4320" step="1"')}`)}
          ${tog('BRW028', 'bc-isMobile')}
          ${tog('BRW029', 'bc-hasTouch')}
          ${kit.field('BRW030', dd('BRW030', 'bc-colorScheme', 'scheme', ['', 'light', 'dark', 'no-preference']), { attrs: 'style="margin-top:12px"' })}
          ${kit.field('BRW031', dd('BRW031', 'bc-reducedMotion', 'motion', ['', 'reduce', 'no-preference']))}
          ${kit.field('BRW032', dd('BRW032', 'bc-forcedColors', 'forced', ['', 'active', 'none']))}`,
        })}

        ${kit.card({
          id: 'bcg-advanced', section: 'browser.advanced_browser_behavior', collapsible: true, collapsed: true, advanced: true,
          body: `
          ${kit.subhead(b('sub.timing'))}
          ${numField('BRW033', 'bc-timeout', 30000, 'min="0" max="300000" step="1000" style="width:120px"')}
          ${numField('BRW034', 'bc-navigationTimeout', 30000, 'min="0" max="300000" step="1000" style="width:120px"')}
          ${numField('BRW035', 'bc-slowMo', 0, 'min="0" max="10000" step="50" style="width:120px"')}
          ${field('BRW036', 'bc-extraArgs', { ph: '--flag1 --flag2=value' })}

          ${kit.subhead(b('sub.preview'))}
          ${group('previewSize', `
              ${num('BRW037', 'bc-screencastMaxWidth', 1280, 'min="320" max="3840" step="1"')}${X}
              ${num('BRW038', 'bc-screencastMaxHeight', 800, 'min="200" max="2160" step="1"')}`)}
          ${numField('BRW039', 'bc-screencastEveryNthFrame', 1, 'min="1" max="30" step="1" style="width:80px"')}

          ${kit.subhead(b('sub.security'))}
          ${tog('BRW040', 'bc-javaScriptEnabled', true)}
          ${tog('BRW041', 'bc-ignoreHTTPSErrors')}
          ${tog('BRW042', 'bc-bypassCSP')}
          ${tog('BRW043', 'bc-acceptDownloads', true)}
          ${tog('BRW044', 'bc-strictSelectors', true)}
          ${kit.field('BRW045', dd('BRW045', 'bc-serviceWorkers', 'workers', ['allow', 'block']), { attrs: 'style="margin-top:12px"' })}

          ${kit.subhead(b('sub.location'))}
          ${tog('BRW046', 'bc-geoEnabled')}
          ${group('coordinates', `
              ${num('BRW047', 'bc-geoLatitude', 0, 'min="-90" max="90" step="0.0001" disabled style="width:96px;max-width:none"', '')}${unit('BRW047')}
              ${num('BRW048', 'bc-geoLongitude', 0, 'min="-180" max="180" step="0.0001" disabled style="width:96px;max-width:none"', '')}${unit('BRW048')}
              ${num('BRW049', 'bc-geoAccuracy', 100, 'min="0" max="100000" step="1" disabled style="width:80px"', '')}${unit('BRW049')}`, 'style="margin-top:12px"')}

          ${kit.subhead(b('sub.permissions'))}
          <div class="stg-help" id="bc-perm-help" style="margin:0 0 8px">${b('permissionsHelp')}</div>
          <div class="browser-cfg-checkbox-grid" role="group" aria-describedby="bc-perm-help">
            ${PERMISSIONS.map(([invId, name]) => `<label class="browser-cfg-checkbox" ${kit.inv(invId)}><input type="checkbox" id="bc-perm-${name}"> ${kit.L(invId)}</label>`).join('\n            ')}
          </div>

          ${kit.subhead(b('sub.network'))}
          ${tog('BRW065', 'bc-offline')}
          ${field('BRW066', 'bc-proxyServer', { ph: 'http://host:port', row: 'style="margin-top:12px"' })}
          ${field('BRW067', 'bc-proxyBypass', { ph: 'localhost, *.internal' })}
          ${field('BRW068', 'bc-proxyUsername')}
          ${field('BRW069', 'bc-proxyPassword', { type: 'password' })}
          ${field('BRW070', 'bc-httpCredUser')}
          ${field('BRW071', 'bc-httpCredPass', { type: 'password' })}

          ${kit.subhead(b('sub.recording'))}
          ${tog('BRW072', 'bc-recordVideo')}
          ${field('BRW073', 'bc-recordVideoDir', { ph: 'data/videos', attrs: 'disabled', row: 'style="margin-top:12px"' })}
          ${group('videoSize', `
              ${num('BRW074', 'bc-recordVideoWidth', 1280, 'min="320" max="3840" step="1" disabled')}${X}
              ${num('BRW075', 'bc-recordVideoHeight', 720, 'min="200" max="2160" step="1" disabled')}`)}
          ${tog('BRW076', 'bc-recordHar')}
          ${field('BRW077', 'bc-recordHarPath', { ph: 'data/network.har', attrs: 'disabled', row: 'style="margin-top:12px"' })}
          <div id="bc-recordHar-fields">
            ${kit.field('BRW078', dd('BRW078', 'bc-recordHarContent', 'harContent', ['embed', 'attach', 'omit'], { disabled: true }))}
            ${kit.field('BRW079', dd('BRW079', 'bc-recordHarMode', 'harMode', ['full', 'minimal'], { disabled: true }))}
            ${field('BRW080', 'bc-recordHarUrlFilter', { ph: '**/api/**', attrs: 'disabled' })}
          </div>`,
        })}

        <div class="stg-pane-actions" role="group" aria-label="${b('saveBar')}">
          <div class="bc-actions">
            <button type="button" class="bc-action-btn bc-action-save" id="bc-save-all" ${kit.inv('BRW081')} aria-describedby="bc-save-all-help">${kit.L('BRW081')}</button>
            <button type="button" class="bc-action-btn bc-action-reset" id="bc-reset-all" ${kit.inv('BRW082')} title="${kit.H('BRW082')}">${kit.L('BRW082')}</button>
          </div>
          <div class="bc-status-row"><span class="browser-cfg-hint" id="bc-save-status" ${kit.inv('BRW085')} role="status" aria-live="polite"></span></div>
          <div class="stg-help" id="bc-save-all-help">${kit.H('BRW081')}</div>
        </div>

      </div>`;
}

function buildSetupTab(setupStatus) {
  // One row per assistant. The wiring finds everything by id: setup-<id>-mcp-{row,status,toggle},
  // setup-<id>-cli-copy, setup-<id>-config-{preview,copy}, setup-<id>-rules-{row,path,badge,message,
  // primary,remove,view,copy,text}, and the header badge (#setup-<id> .gfx-group-title .setup-status-badge).
  const providers = [
    { id: 'claude',   name: 'Claude',   icon: ANTHROPIC_ICON, file: '~/.claude.json',                 ids: { toggle: 'SET004', cli: 'SET005',                      primary: 'SET006', remove: 'SET007', view: 'SET008', copy: 'SET009' } },
    { id: 'gemini',   name: 'Gemini',   icon: GEMINI_ICON,    file: '~/.gemini/settings.json',        ids: { toggle: 'SET010',                    config: 'SET011', primary: 'SET012', remove: 'SET013', view: 'SET014', copy: 'SET015' } },
    { id: 'codex',    name: 'Codex',    icon: OPENAI_ICON,    file: '~/.codex/config.toml',           ids: { toggle: 'SET016', cli: 'SET017', config: 'SET018', primary: 'SET019', remove: 'SET020', view: 'SET021', copy: 'SET022' } },
    { id: 'opencode', name: 'OpenCode', icon: OPENCODE_ICON,  file: '~/.config/opencode/config.json', ids: { toggle: 'SET023',                    config: 'SET024', primary: 'SET025', remove: 'SET026', view: 'SET027', copy: 'SET028' } },
  ].map((p) => ({ ...p, on: setupStatus[p.id]?.connected || false }));

  const copyLabel = (invId) => `${COPY_ICON} ${kit.L(invId)}`;

  // The wiring rewrites this badge's class and text when a tool is connected or disconnected.
  const statusBadge = (on) => `<span class="setup-status-badge ${on ? 'active' : 'inactive'}" ${kit.inv('SET034')}>${kit.te(on ? 'settings.redesign.common.connected' : 'settings.redesign.common.off')}</span>`;

  // A switch row that keeps its own markup: the wiring toggles `.enabled` on the row, `.on` on the
  // button and writes the registered file (or "Not connected") into the status line.
  const mcpRow = (p) => `
            <div class="stg-toggle-field stg-setup-toggle${p.on ? ' enabled' : ''}" id="setup-${p.id}-mcp-row" ${kit.inv(p.ids.toggle)}>
              <div class="stg-toggle-text">
                <div class="stg-toggle-label" id="setup-${p.id}-mcp-toggle-label">${kit.L(p.ids.toggle)}</div>
                <div class="stg-help" id="setup-${p.id}-mcp-toggle-help">${kit.H(p.ids.toggle)}</div>
                <div class="stg-help stg-setup-status" id="setup-${p.id}-mcp-status">${p.on ? kit.te('settings.redesign.setup.registeredIn', { file: p.file }) : kit.te('settings.redesign.setup.notConnected')}</div>
              </div>
              <div class="stg-toggle-control">
                <button type="button" class="cc-toggle${p.on ? ' on' : ''}" id="setup-${p.id}-mcp-toggle" aria-labelledby="setup-${p.id}-mcp-toggle-label" aria-describedby="setup-${p.id}-mcp-toggle-help setup-${p.id}-mcp-status"></button>
              </div>
            </div>`;

  // The manual route: a terminal command and/or the config text, each with its copy button.
  const byHand = (p) => {
    const cli = p.ids.cli ? `
            <div class="stg-setup-actions stg-help-line">
              ${kit.help(p.ids.cli, { forId: `setup-${p.id}-cli-copy` })}
              <button type="button" class="cc-copy-btn stg-text-btn" id="setup-${p.id}-cli-copy" ${kit.inv(p.ids.cli)} aria-describedby="setup-${p.id}-cli-copy-help">${copyLabel(p.ids.cli)}</button>
            </div>` : '';
    const config = p.ids.config ? `
            <div class="stg-help">${kit.th('settings.redesign.setup.byHandFile', { file: `<code class="stg-code">${escapeHtml(p.file)}</code>` })}</div>
            <div class="cc-ruleset-preview" id="setup-${p.id}-config-preview" ${kit.inv('SET035')} role="region" tabindex="0" aria-label="${kit.te('settings.redesign.setup.previewConfig', { name: p.name })}" style="max-height:120px;margin-top:6px">${kit.te('settings.redesign.setup.loading')}</div>
            <div class="stg-setup-actions stg-help-line">
              ${kit.help(p.ids.config, { forId: `setup-${p.id}-config-copy` })}
              <button type="button" class="cc-copy-btn stg-text-btn" id="setup-${p.id}-config-copy" ${kit.inv(p.ids.config)} aria-describedby="setup-${p.id}-config-copy-help">${copyLabel(p.ids.config)}</button>
            </div>` : '';
    return `${kit.subhead(kit.te('settings.redesign.setup.byHand'))}${cli}${config}`;
  };

  // SynaBun's rules for one assistant: state badge, path, the action the state calls for, then
  // Remove / View / Copy. Filled in by wireRulesControls().
  const rulesBlock = (p) => `
            ${kit.subhead(kit.te('settings.redesign.setup.rulesFor', { name: p.name }), { id: `setup-${p.id}-rules-title` })}
            <div id="setup-${p.id}-rules" role="group" aria-labelledby="setup-${p.id}-rules-title">
              <div class="cc-integration-item" id="setup-${p.id}-rules-row" ${kit.inv('SET034')}>
                <div class="cc-integration-info">
                  <div class="cc-integration-label">${kit.te('settings.redesign.setup.rulesFile')}</div>
                  <div class="cc-integration-path" id="setup-${p.id}-rules-path">${kit.te('settings.redesign.common.checking')}</div>
                </div>
                <span class="setup-status-badge inactive" id="setup-${p.id}-rules-badge">…</span>
              </div>
              <div class="stg-help" id="setup-${p.id}-rules-message" style="display:none"></div>
              <div class="stg-setup-actions" role="group" aria-label="${kit.te('settings.redesign.setup.rulesActions', { name: p.name })}">
                <button type="button" class="cc-copy-btn" id="setup-${p.id}-rules-primary" ${kit.inv(p.ids.primary)} title="${kit.H(p.ids.primary)}" style="display:none">${kit.L(p.ids.primary)}</button>
                <button type="button" class="cc-copy-btn stg-text-btn stg-text-btn-danger" id="setup-${p.id}-rules-remove" ${kit.inv(p.ids.remove)} title="${kit.H(p.ids.remove)}" style="display:none">${kit.L(p.ids.remove)}</button>
                <button type="button" class="cc-copy-btn stg-text-btn" id="setup-${p.id}-rules-view" ${kit.inv(p.ids.view)} title="${kit.H(p.ids.view)}" aria-expanded="false" aria-controls="setup-${p.id}-rules-text">${kit.L(p.ids.view)}</button>
                <button type="button" class="cc-copy-btn stg-text-btn" id="setup-${p.id}-rules-copy" ${kit.inv(p.ids.copy)} title="${kit.H(p.ids.copy)}">${copyLabel(p.ids.copy)}</button>
              </div>
              <div class="cc-ruleset-preview" id="setup-${p.id}-rules-text" ${kit.inv('SET035')} role="region" tabindex="0" aria-label="${kit.te('settings.redesign.setup.previewRules', { name: p.name })}" style="display:none;margin-top:6px"></div>
            </div>`;

  // Text you paste yourself (Cursor's User Rules, the coexistence snippet): View and Copy only.
  const copyOnlyBlock = (id, name, ids, previewKey) => `
            <div class="stg-setup-actions" role="group" aria-label="${kit.te('settings.redesign.setup.rulesActions', { name })}">
              <button type="button" class="cc-copy-btn stg-text-btn" id="setup-${id}-rules-view" ${kit.inv(ids.view)} title="${kit.H(ids.view)}" aria-expanded="false" aria-controls="setup-${id}-rules-text">${kit.L(ids.view)}</button>
              <button type="button" class="cc-copy-btn stg-text-btn" id="setup-${id}-rules-copy" ${kit.inv(ids.copy)} title="${kit.H(ids.copy)}">${copyLabel(ids.copy)}</button>
            </div>
            <div class="cc-ruleset-preview" id="setup-${id}-rules-text" ${kit.inv('SET035')} role="region" tabindex="0" aria-label="${kit.te(previewKey, { name })}" style="display:none;margin-top:6px"></div>`;

  const providerCard = (p) => kit.card({
    id: `setup-${p.id}`, level: 'h4', collapsible: true, collapsed: true,
    title: `${p.icon}<span>${p.name}</span>`,
    purpose: '',
    status: statusBadge(p.on),
    body: `${mcpRow(p)}${byHand(p)}${rulesBlock(p)}`,
  });

  const rulesToggle = `
            <div class="stg-toggle-field stg-setup-toggle" id="setup-rules-autoupdate-row" ${kit.inv('SET001')}>
              <div class="stg-toggle-text">
                <div class="stg-toggle-label" id="setup-rules-autoupdate-label">${kit.L('SET001')}</div>
                <div class="stg-help" id="setup-rules-autoupdate-help">${kit.H('SET001')}</div>
              </div>
              <div class="stg-toggle-control">
                <button type="button" class="cc-toggle" id="setup-rules-autoupdate" aria-labelledby="setup-rules-autoupdate-label" aria-describedby="setup-rules-autoupdate-help"></button>
              </div>
            </div>`;

  const cursorIcon = '<svg viewBox="0 0 24 24" aria-hidden="true" style="width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2"><path d="M5 3l14 8-6 2-2 6z"/></svg>';
  const coexistIcon = '<svg viewBox="0 0 24 24" aria-hidden="true" style="width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v-2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>';

  return `
      <div class="stg-pane" data-stg-pane="setup">

        ${kit.card({
          id: 'stg-sec-assistants', section: 'ai_connections.your_assistants',
          body: providers.map(providerCard).join(''),
        })}

        ${kit.card({
          id: 'setup-rules', section: 'ai_connections.synabun_rules',
          status: '<span class="stg-pill" id="setup-rules-version" data-state="off" style="display:none"></span>',
          body: `
            <p class="stg-help">${kit.te('settings.redesign.setup.rulesIntro')}</p>
            ${rulesToggle}
            <div class="stg-setup-actions stg-help-line">
              <div class="stg-help" id="setup-rules-install-all-help">${kit.H('SET002')}</div>
              <button type="button" class="cc-copy-btn stg-push-btn" id="setup-rules-install-all" ${kit.inv('SET002')} aria-describedby="setup-rules-install-all-help">${kit.L('SET002')}</button>
            </div>
            <div class="stg-help" id="setup-rules-message" style="display:none"></div>
            <div id="setup-rules-legacy" ${kit.inv('SET033')} style="display:none;margin-top:12px"></div>`,
        })}

        ${kit.card({
          id: 'stg-sec-manual-setup', section: 'ai_connections.manual_setup',
          body: `${kit.card({
            id: 'setup-cursor', level: 'h4', collapsible: true, collapsed: true,
            title: `${cursorIcon}<span>Cursor</span>`,
            purpose: '',
            status: kit.pill(kit.te('settings.redesign.setup.copyOnly'), { state: 'off' }),
            body: `<p class="stg-help">${kit.te('settings.redesign.setup.cursorHelp')}</p>${copyOnlyBlock('cursor', 'Cursor', { view: 'SET029', copy: 'SET030' }, 'settings.redesign.setup.previewRules')}`,
          })}${kit.card({
            id: 'setup-coexistence', level: 'h4', collapsible: true, collapsed: true,
            title: `${coexistIcon}<span>${kit.te('settings.redesign.setup.coexistTitle')}</span>`,
            purpose: '',
            body: `<p class="stg-help">${kit.te('settings.redesign.setup.coexistHelp')}</p>${copyOnlyBlock('coexistence', kit.tx('settings.redesign.setup.coexistName'), { view: 'SET031', copy: 'SET032' }, 'settings.redesign.setup.previewSnippet')}`,
          })}`,
        })}

      </div>`;
}

function buildTerminalTab(cliConfig) {
  // `inv` is the input's inventory id. The wiring reads #cli-path-<id>, writes #cli-status-<id>,
  // and finds the buttons by .cli-detect-btn[data-cli-detect] and #cli-paths-save.
  const cliProfiles = [
    { id: 'claude-code', name: 'Claude Code', icon: ANTHROPIC_ICON, color: '#D4A27F', default: 'claude',   inv: 'CLI001' },
    { id: 'codex',       name: 'Codex',       icon: OPENAI_ICON,    color: '#74c7a5', default: 'codex',    inv: 'CLI003' },
    { id: 'gemini',      name: 'Gemini',      icon: GEMINI_ICON,    color: '#669DF6', default: 'gemini',   inv: 'CLI004' },
    { id: 'opencode',    name: 'OpenCode',    icon: OPENCODE_ICON,  color: '#E8E0DC', default: 'opencode', inv: 'CLI005' },
  ];

  const pathRow = (p) => {
    const current = (cliConfig && cliConfig[p.id]?.command) || p.default;
    const isDefault = current === p.default;
    return `
            <div class="cli-path-row" data-cli-profile="${p.id}" ${kit.inv(p.inv)}>
              <div class="cli-path-icon" style="color:${p.color}">${p.icon}</div>
              <div class="cli-path-field">
                <label class="cli-path-label" for="cli-path-${p.id}">${kit.L(p.inv)}</label>
                <div class="cli-path-input-row">
                  <input type="text" class="cli-path-input"
                         id="cli-path-${p.id}"
                         value="${escapeHtml(current)}"
                         placeholder="${p.default}"
                         spellcheck="false" autocomplete="off"
                         aria-describedby="cli-path-${p.id}-help">
                  <button type="button" class="cli-detect-btn" data-cli-detect="${p.id}" ${kit.inv('CLI002')} data-tooltip="${kit.te('settings.redesign.terminal.detectTip')}" aria-label="${kit.te('settings.redesign.terminal.detectFor', { name: p.name })}" aria-describedby="cli-paths-detect-help">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    ${kit.L('CLI002')}
                  </button>
                  <span class="cli-path-status${isDefault ? '' : ' custom'}" id="cli-status-${p.id}" ${kit.inv('CLI007')}>${kit.te(isDefault ? 'settings.redesign.terminal.cliStatus.default' : 'settings.redesign.terminal.cliStatus.custom')}</span>
                </div>
                <div class="stg-help" id="cli-path-${p.id}-help">${kit.H(p.inv)}</div>
              </div>
            </div>`;
  };

  const examples = [
    { code: 'claude',                       key: 'exDefault' },
    { code: 'C:\\Users\\me\\.npm\\claude',  key: 'exWindows' },
    { code: '/opt/homebrew/bin/claude',     key: 'exUnix' },
    { code: 'wsl claude',                   key: 'exWsl' },
    { code: 'wsl -d Ubuntu gemini',         key: 'exWslDistro' },
  ];

  return `
      <div class="stg-pane" data-stg-pane="terminal">

        ${kit.card({
          id: 'cc-cli-paths', section: 'ai_connections.executable_paths',
          body: `
          <p class="stg-help">${kit.th('settings.redesign.terminal.pathsIntro', { code: '<code class="stg-code">wsl</code>' })}</p>
          ${kit.help('CLI002', { forId: 'cli-paths-detect' })}
          ${cliProfiles.map(pathRow).join('')}
          <button type="button" class="stg-action-btn stg-save-btn" id="cli-paths-save" ${kit.inv('CLI006')} aria-describedby="cli-paths-save-help">
            ${kit.L('CLI006')}
          </button>
          ${kit.help('CLI006', { forId: 'cli-paths-save' })}

          ${kit.subhead(kit.te('settings.redesign.terminal.examples'))}
          <div class="stg-examples">
            ${examples.map((e) => `
            <div class="stg-example-row">
              <code class="stg-code">${escapeHtml(e.code)}</code>
              <span>${kit.te(`settings.redesign.terminal.${e.key}`)}</span>
            </div>`).join('')}
          </div>`,
        })}

      </div>`;
}

function buildMcpTab() {
  const m = (key) => kit.te(`settings.redesign.mcp.${key}`);
  const product = (key) => kit.te(`settings.redesign.product.${key}`);
  const input = (id, { ph = '', type = 'text', attrs = '' } = {}) =>
    `<input type="${type}" class="stg-input stg-input-sm" id="${id}"${ph ? ` placeholder="${ph}"` : ''} autocomplete="off" spellcheck="false" aria-describedby="${id}-help"${attrs ? ` ${attrs}` : ''}>`;
  const tab = (cls, attr, value, label, active) =>
    `<button type="button" class="${cls}${active ? ' active' : ''}" ${attr}="${value}" role="tab" data-stg-selected="active" aria-selected="${active ? 'true' : 'false'}">${label}</button>`;
  const platform = (key, checked) => `<label class="stg-mcp-platform-check" data-platform="${key}"><input type="checkbox"${checked ? ' checked' : ''}> ${product(key)}</label>`;

  return `
      <div class="stg-pane" data-stg-pane="mcp">
        <div class="stg-mcp-page-tabs" role="tablist" aria-label="${kit.L('MCP001')}" ${kit.inv('MCP001')}>
          ${tab('stg-mcp-page-tab', 'data-pane', 'profiles', m('tab.profiles'), true)}
          ${tab('stg-mcp-page-tab', 'data-pane', 'installed', m('tab.installed'), false)}
        </div>

        <div class="stg-mcp-pane" data-pane="profiles" data-stg-reveal='.stg-mcp-page-tab[data-pane="profiles"]'>
          ${kit.card({
            id: 'stg-sec-tool-profiles', section: 'connected_tools.tool_profiles',
            body: `
            <div class="stg-mcp-intro">
              <div class="stg-help" style="margin-top:0">${m('profilesHelp')}</div>
              <div class="stg-mcp-note">
                <strong>${m('noteTitle')}</strong>
                <span>${m('noteBody')}</span>
              </div>
            </div>
            <div id="stg-mcp-matrix-wrap" class="stg-mcp-matrix-wrap stg-mcp-block" ${kit.inv('MCP022')} role="group" aria-label="${kit.L('MCP022')}">
              <div class="stg-mcp-matrix-empty">${m('loading')}</div>
            </div>
            <div id="stg-mcp-always-on" class="stg-mcp-subsection" ${kit.inv('MCP024')}></div>
            <div class="stg-mcp-subsection stg-mcp-servers-section">
              <div class="stg-mcp-section-head">
                <div class="stg-mcp-section-header">${m('externalServers')}</div>
                <div class="stg-help" style="margin-top:0">${m('externalServersHelp')}</div>
              </div>
              <div id="stg-mcp-ext-servers" class="stg-mcp-servers-list"></div>
            </div>`,
          })}
        </div>

        <div class="stg-mcp-pane" data-pane="installed" data-stg-reveal='.stg-mcp-page-tab[data-pane="installed"]' style="display:none">
          ${kit.card({
            id: 'stg-sec-added-servers', section: 'connected_tools.added_servers',
            body: `
            <div class="stg-help" style="margin-top:0">${m('installedHelp')}</div>
            <div id="stg-mcp-installed-all" class="stg-mcp-servers-list" ${kit.inv('MCP026')}></div>
            ${kit.subhead(m('plugins'))}
            <div class="stg-help" style="margin-top:0">${m('pluginsHelp')}</div>
            <div id="stg-mcp-ext-plugins" class="stg-mcp-servers-list"></div>
            <button type="button" class="stg-action-btn compact stg-mcp-add-server-btn" id="stg-mcp-add-server" ${kit.inv('MCP006')} title="${kit.H('MCP006')}">${kit.L('MCP006')}</button>

            <div class="stg-mcp-add-form" id="stg-mcp-add-form" style="display:none" data-transport="stdio" data-source="paste" data-stg-reveal="#stg-mcp-add-server">
              <div class="stg-mcp-source-tabs" id="stg-mcp-source-tabs" role="tablist" aria-label="${kit.L('MCP007')}" ${kit.inv('MCP007')}>
                ${tab('stg-mcp-source-tab', 'data-source', 'github', m('source.github'), true)}
                ${tab('stg-mcp-source-tab', 'data-source', 'paste', m('source.paste'), false)}
              </div>
              <div class="stg-mcp-source-panel" data-panel="github" data-stg-reveal='.stg-mcp-source-tab[data-source="github"]'>
                <div class="stg-field" ${kit.inv('MCP008')}>
                  <label for="stg-mcp-gh-url">${kit.L('MCP008')}</label>
                  <div class="stg-mcp-gh-row">
                    <input type="text" class="stg-input stg-input-sm stg-mcp-gh-url" id="stg-mcp-gh-url" placeholder="github.com/owner/repo" autocomplete="off" spellcheck="false" aria-describedby="stg-mcp-gh-url-help">
                    <button type="button" class="stg-action-btn compact" id="stg-mcp-gh-install" ${kit.inv('MCP009')} title="${kit.H('MCP009')}">${kit.L('MCP009')}</button>
                  </div>
                  ${kit.help('MCP008', { forId: 'stg-mcp-gh-url' })}
                </div>
                <label class="stg-mcp-gh-optrun" ${kit.inv('MCP010')}><input type="checkbox" id="stg-mcp-gh-runinstall" checked aria-describedby="stg-mcp-gh-runinstall-help"> ${kit.L('MCP010')}</label>
                ${kit.help('MCP010', { forId: 'stg-mcp-gh-runinstall' })}
                <div class="stg-mcp-gh-progress" id="stg-mcp-gh-progress" style="display:none">
                  <div class="stg-mcp-gh-status" id="stg-mcp-gh-status" role="status" aria-live="polite"></div>
                  <pre class="stg-mcp-gh-log" id="stg-mcp-gh-log"></pre>
                </div>
              </div>
              <div class="stg-mcp-source-panel" data-panel="paste" style="display:none" data-stg-reveal='.stg-mcp-source-tab[data-source="paste"]'>
                ${kit.field('MCP011', `<textarea class="stg-mcp-paste-zone" id="stg-mcp-paste" rows="3" placeholder='{ "mcpServers": { "name": { "command": "npx", "args": ["-y", "pkg"] } } }' spellcheck="false" aria-describedby="stg-mcp-paste-help"></textarea>`, { forId: 'stg-mcp-paste' })}
              </div>
              <div class="stg-mcp-form-grid" style="margin-top:10px">
                ${kit.field('MCP012', input('stg-mcp-srv-name', { ph: m('ph.name') }), { forId: 'stg-mcp-srv-name' })}
                ${kit.field('MCP013', `
                  <select class="stg-input stg-input-sm" id="stg-mcp-srv-type" aria-describedby="stg-mcp-srv-type-help">
                    <option value="stdio">${m('type.stdio')}</option>
                    <option value="sse">${m('type.sse')}</option>
                    <option value="http">${m('type.http')}</option>
                  </select>`, { forId: 'stg-mcp-srv-type' })}
                ${kit.field('MCP014', input('stg-mcp-srv-cmd', { ph: 'node' }), { forId: 'stg-mcp-srv-cmd', className: 'stg-mcp-field-wide stg-mcp-field-stdio', attrs: 'data-stg-shown-by="#stg-mcp-srv-type"' })}
                ${kit.field('MCP015', `
                  <div class="stg-mcp-arg-chips" id="stg-mcp-arg-chips" ${kit.inv('MCP027')}>
                    <input type="text" class="stg-mcp-arg-input" id="stg-mcp-arg-input" placeholder="${m('ph.arg')}" autocomplete="off" spellcheck="false" aria-describedby="stg-mcp-arg-input-help">
                  </div>`, { forId: 'stg-mcp-arg-input', className: 'stg-mcp-field-wide stg-mcp-field-stdio', attrs: 'data-stg-shown-by="#stg-mcp-srv-type"' })}
                ${kit.field('MCP016', input('stg-mcp-srv-url', { ph: 'https://…' }), { forId: 'stg-mcp-srv-url', className: 'stg-mcp-field-wide stg-mcp-field-url', attrs: 'data-stg-shown-by="#stg-mcp-srv-type"' })}
              </div>
              <div class="stg-mcp-field-remote" data-stg-shown-by="#stg-mcp-srv-type">
                <div class="stg-mcp-form-label" title="${m('headersHelp')}">${m('headers')}</div>
                <div class="stg-mcp-env-rows" id="stg-mcp-hdr-rows"></div>
                <div class="stg-mcp-env-add" id="stg-mcp-hdr-add" role="button" tabindex="0">${m('addHeader')}</div>
                <div class="stg-mcp-form-label">${m('oauth')}</div>
                <div class="stg-mcp-form-grid">
                  ${kit.field('MCP017', input('stg-mcp-oauth-client-id'), { forId: 'stg-mcp-oauth-client-id' })}
                  ${kit.field('MCP018', input('stg-mcp-oauth-port', { type: 'number', ph: '33418', attrs: 'min="1" max="65535"' }), { forId: 'stg-mcp-oauth-port' })}
                </div>
              </div>
              <div class="stg-mcp-form-label" title="${m('envHelp')}">${m('env')}</div>
              <div class="stg-mcp-env-rows" id="stg-mcp-env-rows"></div>
              <div class="stg-mcp-env-add" id="stg-mcp-env-add" role="button" tabindex="0">${m('addVariable')}</div>
              <div class="stg-mcp-form-label" id="stg-mcp-platforms-label" title="${kit.H('MCP019')}">${kit.L('MCP019')}</div>
              <div class="stg-mcp-platform-checks" id="stg-mcp-platforms" role="group" aria-labelledby="stg-mcp-platforms-label" ${kit.inv('MCP019')}>
                ${platform('claudeCode', true)}
                ${platform('opencode', true)}
                ${platform('codex', true)}
                ${platform('gemini', false)}
              </div>
              <div class="stg-action-row stg-mcp-form-actions" style="margin-top:10px">
                <button type="button" class="stg-action-btn compact" id="stg-mcp-srv-save" ${kit.inv('MCP020')} title="${kit.H('MCP020')}">${kit.L('MCP020')}</button>
                <button type="button" class="stg-action-btn compact" id="stg-mcp-srv-cancel" ${kit.inv('MCP021')} title="${kit.H('MCP021')}">${kit.L('MCP021')}</button>
                <span id="stg-mcp-sync-feedback" role="status" aria-live="polite" style="margin-left:8px"></span>
              </div>
            </div>`,
          })}
        </div>
      </div>`;
}

function buildOpencodeTab() {
  const check = (invId, id) => kit.toggleField(invId, kit.switchInput(id, { checked: true }), { forId: id });
  return `
      <div class="stg-pane" data-stg-pane="opencode">

        ${kit.card({
          id: 'stg-sec-opencode-service', section: 'ai_connections.opencode_service_providers', className: 'ocp-service-card',
          status: `<span id="stg-ocp-dot" class="ocp-status-dot" data-state="dim"></span><span id="stg-ocp-status" class="ocp-server-bar-status"></span>`,
          body: `
          <div class="ocp-group">
            ${kit.field('OCP001', `<span class="ocp-server-bar-right">
              <input type="number" class="ocp-port-input" id="stg-ocp-port" value="4096" min="1024" max="65535" aria-describedby="stg-ocp-port-help">
              <button type="button" class="ocp-srv-btn" id="stg-ocp-start" ${kit.inv('OCP002')} title="${kit.H('OCP002')}">${kit.L('OCP002')}</button>
              <button type="button" class="ocp-srv-btn ocp-srv-btn-stop" id="stg-ocp-stop" ${kit.inv('OCP003')} title="${kit.H('OCP003')}">${kit.L('OCP003')}</button>
              <button type="button" class="ocp-srv-btn ocp-srv-btn-icon" id="stg-ocp-refresh" ${kit.inv('OCP004')} title="${kit.H('OCP004')}" aria-label="${kit.L('OCP004')}">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
              </button>
            </span>`, { forId: 'stg-ocp-port', className: 'ocp-server-bar' })}
          </div>

          <div class="ocp-group-head">
            ${kit.subhead(kit.L('OCP022'))}
            <div class="stg-help">${kit.H('OCP022')}</div>
          </div>
          <div class="ocp-provider-toolbar" ${kit.inv('OCP005')}>
            <input
              type="search"
              class="ocp-filter-input"
              id="stg-ocp-provider-filter"
              placeholder="${kit.te('settings.redesign.opencode.searchPlaceholder')}"
              aria-label="${kit.L('OCP005')}"
              title="${kit.H('OCP005')}"
              autocomplete="off"
              spellcheck="false"
            >
            <div id="stg-ocp-provider-cap-filters" class="ocp-cap-bar" role="group" aria-label="${kit.L('OCP021')}" title="${kit.H('OCP021')}" ${kit.inv('OCP021')}></div>
          </div>
          <div id="stg-ocp-providers" class="stg-list ocp-group" ${kit.inv('OCP022')}>
            <div class="stg-help">${kit.te('settings.redesign.opencode.startHint')}</div>
          </div>
          <div class="ocp-group">
          ${kit.advanced(`
          <div class="ocp-config-footer" ${kit.inv('OCP019')}>
            <span class="ocp-config-path">${kit.th('settings.redesign.opencode.configPath', { path: '<code class="stg-code">~/.config/opencode/config.json</code>' })}</span>
            <button type="button" class="ocp-config-link" id="stg-ocp-open-config" aria-describedby="stg-ocp-open-config-help">${kit.L('OCP019')}</button>
          </div>
          ${kit.help('OCP019', { forId: 'stg-ocp-open-config' })}`)}
          </div>`,
        })}

        ${kit.card({
          id: 'stg-sec-opencode-behavior', section: 'ai_connections.opencode_behavior',
          collapsible: true, collapsed: true, advanced: true, className: 'ocp-footnote-card',
          body: `
          <div class="ocp-compact-group ocp-rows">
            ${check('OCP013', 'stg-ocp-compact-auto')}
            ${check('OCP014', 'stg-ocp-compact-prune')}
            ${kit.field('OCP015', `<input type="number" class="ocp-reserved-input" id="stg-ocp-compact-reserved" value="10000" min="1000" max="50000" step="1000" aria-describedby="stg-ocp-compact-reserved-help">`, { forId: 'stg-ocp-compact-reserved' })}
            ${kit.toggleField('OCP016', `<button type="button" class="cc-toggle on" id="stg-ocp-snapshot-toggle" aria-labelledby="stg-ocp-snapshot-toggle-label" aria-describedby="stg-ocp-snapshot-toggle-help"></button>`, { forId: 'stg-ocp-snapshot-toggle', className: 'ocp-snapshot-row' })}
          </div>
          <p class="ocp-footnote">${kit.te('settings.redesign.opencode.snapshotDetail')}</p>`,
        })}

        ${kit.card({
          id: 'stg-sec-opencode-tools', section: 'ai_connections.opencode_tool_access',
          collapsible: true, collapsed: true, advanced: true,
          body: `
          <div id="stg-ocp-tools" style="min-height:20px" ${kit.inv('OCP017')}>
            <div class="stg-help">${kit.te('settings.redesign.opencode.loadingTools')}</div>
          </div>`,
        })}

        ${kit.card({
          id: 'stg-sec-opencode-history', section: 'ai_connections.opencode_history',
          collapsible: true, collapsed: true, advanced: true, className: 'ocp-danger-section ocp-footnote-card',
          body: `
          <div class="ocp-rows">
            <div class="ocp-danger-row">
              <div class="ocp-danger-copy">
                <div class="ocp-danger-title" id="stg-ocp-history-label">${kit.te('settings.redesign.opencode.storedConversations')}</div>
                <div class="stg-help">${kit.H('OCP023')}</div>
              </div>
              <span class="ocp-danger-meta" id="stg-ocp-history-meta" ${kit.inv('OCP023')}>${kit.te('settings.redesign.opencode.checkingHistory')}</span>
              <button type="button" class="ocp-history-clear-btn" id="stg-ocp-clear-history" ${kit.inv('OCP018')} aria-describedby="stg-ocp-clear-history-help" disabled>${kit.L('OCP018')}</button>
            </div>
          </div>
          <p class="ocp-footnote ocp-danger-description" id="stg-ocp-clear-history-help">${kit.H('OCP018')}</p>`,
        })}

      </div>`;
}

function buildNotificationsTab() {
  const s = getNotifSettings();
  const volume = parseInt(storage.getItem(KEYS.NOTIF_SOUND_VOLUME) || '50', 10);
  const soundType = storage.getItem(KEYS.NOTIF_SOUND_TYPE) || 'beep';
  const toastDur = parseInt(storage.getItem(KEYS.NOTIF_TOAST_DURATION) || '5', 10);
  const toastPos = storage.getItem(KEYS.NOTIF_TOAST_POSITION) || 'bottom-center';
  const permState = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
  const permLabel = kit.te(`settings.redesign.notifications.perm.${['granted', 'denied', 'default'].includes(permState) ? permState : 'unsupported'}`);
  const permColor = { granted: 'var(--accent-green, #4ade80)', denied: 'var(--accent-red, #f87171)', default: 'var(--s-light, #888)' }[permState] || 'var(--s-light)';

  const soundOptions = ['beep', 'chime', 'ping', 'subtle'].map(value => ({ value, label: kit.te(`settings.redesign.notifications.sound.${value}`) }));
  const durationOptions = [3, 5, 10].map(value => ({ value, label: kit.te('settings.redesign.notifications.seconds', { count: value }) }));
  const positionOptions = ['top-right', 'top-left', 'top-center', 'bottom-right', 'bottom-left', 'bottom-center']
    .map(value => ({ value, label: kit.te(`settings.redesign.notifications.position.${value}`) }));

  const check = (invId, id, on) => kit.toggleField(invId, kit.switchInput(id, { checked: !!on }), { forId: id });
  const testButton = (invId, type) => `<button type="button" class="stg-action-btn compact" data-notif-test="${type}" ${kit.inv(invId)} title="${kit.H(invId)}">${kit.L(invId)}</button>`;

  return `
      <div class="stg-pane" data-stg-pane="notifications">

        ${kit.card({
          id: 'stg-sec-alerts', section: 'notifications.alerts',
          status: `<span class="stg-status-dot" id="notif-perm-dot" style="width:8px;height:8px;border-radius:50%;background:${permColor};flex-shrink:0"></span>
            <span id="notif-perm-label">${permLabel}</span>`,
          body: `
          ${check('NOT001', 'notif-master-toggle', s.enabled)}
          <div class="stg-field" style="margin-top:14px">
            <label>${kit.te('settings.redesign.notifications.permTitle')}</label>
            <div class="stg-help" style="margin-top:0">${kit.te('settings.redesign.notifications.permHelp')}</div>
            <div class="stg-action-row" style="margin-top:8px">
              <button type="button" class="stg-action-btn compact" id="notif-request-perm" ${kit.inv('NOT002')} title="${kit.H('NOT002')}" style="${permState === 'default' ? '' : 'display:none'}">${kit.L('NOT002')}</button>
              <button type="button" class="stg-action-btn compact" id="notif-recheck-perm" ${kit.inv('NOT003')} title="${kit.H('NOT003')}" style="${permState === 'denied' ? '' : 'display:none'}">${kit.L('NOT003')}</button>
            </div>
            <div id="notif-perm-hint" class="stg-help" style="${permState === 'denied' ? '' : 'display:none'}">${kit.te('settings.redesign.notifications.permBlocked')}</div>
          </div>`,
        })}

        ${kit.card({
          id: 'stg-sec-when', section: 'notifications.when_to_alert',
          body: `
          <div id="notif-sources-section">
            ${kit.subhead(kit.te('settings.redesign.notifications.sources'))}
            ${check('NOT004', 'notif-source-cli', s.sourceCli)}
            ${check('NOT005', 'notif-source-panel', s.sourcePanel)}
          </div>
          <div id="notif-triggers-section">
            ${kit.subhead(kit.te('settings.redesign.notifications.events'))}
            ${check('NOT006', 'notif-trigger-done', s.triggerDone)}
            ${check('NOT007', 'notif-trigger-action', s.triggerAction)}
            ${check('NOT008', 'notif-trigger-ask', s.triggerAsk)}
            ${check('NOT009', 'notif-trigger-error', s.triggerError)}
          </div>`,
        })}

        ${kit.card({
          id: 'stg-sec-sounds', section: 'notifications.sounds',
          body: `
          <div id="notif-sound-section">
            ${check('NOT010', 'notif-sound-toggle', s.sound)}
            ${kit.field('NOT011', `
              <div class="stg-input-row" style="align-items:center;gap:12px">
                <input type="range" id="notif-volume" min="0" max="100" value="${volume}" style="flex:1" aria-describedby="notif-volume-help">
                <span id="notif-volume-label" style="min-width:36px;text-align:right">${volume}%</span>
              </div>`, { forId: 'notif-volume', attrs: 'style="margin-top:14px"' })}
            ${kit.field('NOT012', kit.dropdown('notif-sound-type', soundOptions, { value: soundType, classes: 'stg-dropdown stg-dropdown-inline', label: kit.L('NOT012') }))}
            <div class="stg-field">
              <label>${kit.te('settings.redesign.notifications.trySounds')}</label>
              <div class="stg-action-row">
                ${testButton('NOT013', 'action')}
                ${testButton('NOT014', 'done')}
                ${testButton('NOT015', 'ask')}
                ${testButton('NOT016', 'error')}
              </div>
              <div class="stg-help">${kit.te('settings.redesign.notifications.trySoundsHelp')}</div>
            </div>
          </div>`,
        })}

        ${kit.card({
          id: 'stg-sec-onscreen', section: 'notifications.on_screen_alerts',
          body: `
          <div id="notif-toast-section">
            ${kit.subhead(kit.te('settings.redesign.notifications.inApp'))}
            ${check('NOT017', 'notif-toast-toggle', s.toast)}
            ${kit.field('NOT018', kit.dropdown('notif-toast-position', positionOptions, { value: toastPos, classes: 'stg-dropdown stg-dropdown-inline', label: kit.L('NOT018') }), { attrs: 'style="margin-top:14px"' })}
            ${kit.field('NOT019', kit.dropdown('notif-toast-duration', durationOptions, { value: toastDur, classes: 'stg-dropdown stg-dropdown-inline', label: kit.L('NOT019') }))}
          </div>
          <div id="notif-banner-section">
            ${kit.subhead(kit.te('settings.redesign.notifications.system'))}
            ${check('NOT020', 'notif-banner-toggle', s.banner)}
            ${check('NOT021', 'notif-banner-focused', s.bannerFocused)}
          </div>`,
        })}

        ${kit.card({
          id: 'stg-sec-test', section: 'notifications.test_alerts',
          body: `
          <div class="stg-action-row">
            <button type="button" class="stg-action-btn" id="notif-test-btn" ${kit.inv('NOT022')} aria-describedby="notif-test-btn-help">${kit.L('NOT022')}</button>
          </div>
          ${kit.help('NOT022', { forId: 'notif-test-btn' })}`,
        })}

      </div>`;
}

function buildCollectionsTab(connections, settings) {
  const mismatch = !!settings.embeddingMismatch;

  return `
      <div class="stg-pane" data-stg-pane="collections">

        ${kit.card({
          id: 'stg-sec-search-index', section: 'memory_backups.search_index',
          status: `<span class="stg-pill" id="reindex-health" ${kit.inv('DB004')} data-state="${mismatch ? 'warn' : 'ok'}">${kit.te(mismatch ? 'settings.redesign.collections.rebuildNeeded' : 'settings.redesign.collections.upToDate')}</span>`,
          body: `
          ${mismatch ? `
          <div class="stg-callout stg-callout-warn" role="alert" style="margin-bottom:12px;padding:10px 12px;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.3);border-radius:8px">
            ${kit.th('settings.redesign.collections.mismatch', { button: `<strong>${kit.L('DB001')}</strong>` })}
          </div>` : ''}
          <div class="stg-field" ${kit.inv('DB001')}>
            <div class="db-reindex-row">
              <button type="button" class="stg-action-btn db-reindex-btn" id="reindex-btn" aria-describedby="reindex-btn-help">${kit.L('DB001')}</button>
              <button type="button" class="stg-action-btn db-reindex-btn" id="reindex-cancel-btn" ${kit.inv('DB002')} title="${kit.H('DB002')}" style="display:none">${kit.L('DB002')}</button>
            </div>
            ${kit.help('DB001', { forId: 'reindex-btn' })}
          </div>
          <div id="reindex-status" class="db-reindex-status" style="display:none">
            <div class="db-reindex-header">
              <div class="wiz-status-dot spin" id="reindex-dot"></div>
              <span id="reindex-text" class="db-reindex-text" role="status" aria-live="polite"></span>
            </div>
            <div class="db-reindex-bar-track">
              <div id="reindex-bar" class="db-reindex-bar"></div>
            </div>
            <div id="reindex-summary" class="db-reindex-summary"></div>
          </div>
          <div class="db-model-footer">${kit.te('settings.redesign.collections.modelFooter', { model: settings.embeddingModel || kit.tx('settings.redesign.collections.modelLocal'), dims: settings.embeddingDims || '?' })}</div>`,
        })}

      </div>`;
}

/** Generate tool toggle rows, marking items that are alone in their grid row with span-full */
function buildToolRows(tools, perms, invId = 'PER002') {
  // Split tools into segments by group header. Names and descriptions come from the server's tool list.
  const segments = [];
  let currentGroup = null;
  let currentItems = [];
  for (const t of tools) {
    if (t.group && t.group !== currentGroup) {
      if (currentItems.length) segments.push({ group: currentGroup, items: currentItems });
      currentGroup = t.group;
      currentItems = [t];
    } else {
      currentItems.push(t);
    }
  }
  if (currentItems.length) segments.push({ group: currentGroup, items: currentItems });

  let html = '';
  for (const seg of segments) {
    if (seg.group) html += `<div class="cc-tool-group-header">${seg.group}</div>`;
    seg.items.forEach((t, i) => {
      const isOn = perms[t.key] !== false;
      const isOddLast = (seg.items.length % 2 === 1) && (i === seg.items.length - 1);
      html += `<div class="cc-integration-item${isOn ? ' enabled' : ''}${isOddLast ? ' span-full' : ''}" data-tool-key="${t.key}">
                <div class="cc-integration-info">
                  <div class="cc-integration-label">${t.label}</div>
                  <div class="cc-integration-path">${t.desc}</div>
                </div>
                <button type="button" class="cc-toggle${isOn ? ' on' : ''}" data-cc-tool="${t.key}" ${kit.inv(invId)} aria-label="${kit.esc(t.label)}" title="${kit.esc(t.desc)}"></button>
              </div>`;
    });
  }
  return html;
}

function buildYoutubeTab(yt) {
  const s = (yt && yt.secrets) || {};
  const c = (yt && yt.configured) || {};
  const p = (yt && yt.pipeline) || {};
  const dl = p.download || {};
  const src = p.sources || {};
  const y = (key) => kit.te(`settings.redesign.youtube.${key}`);
  const esc = (v) => String(v == null ? '' : v).replace(/"/g, '&quot;');
  const badge = (ok) => kit.pill(y(ok ? 'connected' : 'notSet'), { state: ok ? 'ok' : 'off' });
  // A key field: a saved secret arrives masked and stays in data-mask, so an untouched field keeps the stored value.
  const key = (invId, id, placeholder, type = 'text') => kit.field(invId, `
          <div class="settings-key-row">
            <input id="yt-${id}" type="${type}" placeholder="${esc(placeholder)}" value="${esc(s[id] && String(s[id]).includes('*') ? '' : (s[id] || ''))}" data-mask="${esc(s[id] || '')}" autocomplete="off" spellcheck="false" aria-describedby="yt-${id}-help">
          </div>`, { forId: `yt-${id}` });
  const service = (titleKey, ok) => `<h4 class="stg-subhead stg-subhead-status">${y(titleKey)} ${badge(ok)}</h4>`;

  return `
      <div class="stg-pane" data-stg-pane="youtube">
        ${kit.card({
          id: 'stg-sec-youtube', section: 'automations.youtube_pipeline',
          body: `
          <div ${kit.inv('YT017')}>
          ${service('apiTitle', c.youtube)}
          <div class="stg-help" style="margin:0 0 10px">${kit.th('settings.redesign.youtube.apiHelp', { uri: '<code class="stg-code">http://localhost:3344/api/youtube/oauth/callback</code>' })}</div>
          ${key('YT001', 'YT_OAUTH_CLIENT_ID', 'xxxx.apps.googleusercontent.com')}
          ${key('YT002', 'YT_OAUTH_CLIENT_SECRET', 'GOCSPX-…', 'password')}
          ${key('YT003', 'YT_API_KEY', 'AIza…', 'password')}
          ${key('YT004', 'YT_CHANNEL_ID', 'UC…')}
          <div class="stg-field" ${kit.inv('YT005')}>
            <div class="stg-action-row" style="align-items:center">
              <button type="button" class="stg-action-btn" id="yt-authorize" aria-describedby="yt-authorize-help">${kit.L('YT005')}</button>
              <span class="stg-help" style="margin:0">${y('signInSaved')} ${badge(c.youtube)}</span>
            </div>
            ${kit.help('YT005', { forId: 'yt-authorize' })}
          </div>

          ${kit.advanced(`
            ${service('igdbTitle', c.igdb)}
            <div class="stg-help" style="margin:0 0 10px">${y('igdbHelp')}</div>
            ${key('YT006', 'IGDB_CLIENT_ID', 'xxxx')}
            ${key('YT007', 'IGDB_CLIENT_SECRET', 'xxxx', 'password')}

            ${service('steamTitle', c.steam)}
            ${key('YT008', 'STEAM_API_KEY', 'xxxx', 'password')}

            ${kit.subhead(y('pipelineTitle'))}
            ${kit.field('YT009', `
              <select id="yt-upload-transport" class="stg-input" aria-describedby="yt-upload-transport-help">
                <option value="browser"${p.uploadTransport !== 'api' ? ' selected' : ''}>${y('transport.browser')}</option>
                <option value="api"${p.uploadTransport === 'api' ? ' selected' : ''}>${y('transport.api')}</option>
              </select>`, { forId: 'yt-upload-transport' })}
            ${kit.field('YT010', `
              <div class="settings-key-row">
                <input id="yt-quality" type="text" value="${esc(dl.quality || 'bestvideo[height<=1080]+bestaudio/best[height<=1080]')}" autocomplete="off" spellcheck="false" aria-describedby="yt-quality-help">
              </div>`, { forId: 'yt-quality' })}
            ${kit.field('YT011', `
              <div class="settings-key-row">
                <input id="yt-outputDir" type="text" value="${esc(dl.outputDir || '')}" placeholder="data/youtube-downloads" autocomplete="off" spellcheck="false" aria-describedby="yt-outputDir-help">
              </div>`, { forId: 'yt-outputDir' })}
            ${kit.toggleField('YT012', kit.switchInput('yt-useCookies', { checked: !!dl.useCookies }), { forId: 'yt-useCookies' })}
            ${kit.field('YT013', `<input id="yt-lookbackDays" type="number" class="stg-input" value="${esc(src.lookbackDays || 60)}" min="1" style="width:100px" aria-describedby="yt-lookbackDays-help">`, { forId: 'yt-lookbackDays' })}
            ${kit.field('YT014', `<input id="yt-postsPerDay" type="number" class="stg-input" value="${esc((p.cadence && p.cadence.postsPerDay) || 1)}" min="1" style="width:100px" aria-describedby="yt-postsPerDay-help">`, { forId: 'yt-postsPerDay' })}`,
            { labelKey: 'settings.redesign.youtube.advanced' })}
          </div>

          <div class="stg-action-row" style="margin-top:14px;align-items:center">
            <button type="button" class="stg-action-btn" id="yt-save" ${kit.inv('YT015')} title="${kit.H('YT015')}">${kit.L('YT015')}</button>
            <button type="button" class="stg-action-btn" id="yt-test" ${kit.inv('YT016')} title="${kit.H('YT016')}">${kit.L('YT016')}</button>
            <span id="yt-status" ${kit.inv('YT018')} role="status" aria-live="polite"></span>
          </div>
          <div class="stg-help">${y('autopilot')}</div>`,
        })}
      </div>`;
}

function buildSocialTab(toolCategories, toolPermissions) {
  const socialCat = (toolCategories || []).find(c => c.id === 'social');
  const perms = toolPermissions || {};
  const tools = socialCat ? socialCat.tools : [];
  const onCount = tools.filter(t => perms[t.key] !== false).length;
  const allOn = !!tools.length && onCount === tools.length;

  return `
      <div class="stg-pane" data-stg-pane="social">
        ${kit.card({
          id: 'stg-sec-social', section: 'automations.social_platform_access',
          body: !socialCat
            ? `<div class="stg-help" style="margin-top:0">${kit.te('settings.redesign.social.none')}</div>`
            : `
          <div class="cc-tool-category" data-tool-category="social" ${kit.inv('SOC003')} style="margin:0">
            <div class="cc-tool-category-header" style="padding-bottom:8px">
              <span class="cc-tool-category-label">${kit.te('settings.redesign.social.allPlatforms')}</span>
              <span class="cc-tool-category-count">${onCount}/${tools.length}</span>
              <button type="button" class="cc-tool-category-all${allOn ? ' on' : ''}" data-cc-tool-cat="social" ${kit.inv('SOC001')} title="${kit.H('SOC001')}" data-stg-pressed="on" aria-pressed="${allOn ? 'true' : 'false'}" aria-label="${kit.L('SOC001')}">${kit.te('settings.redesign.permissions.all')}</button>
            </div>
            <div class="cc-hook-toggles">${buildToolRows(tools, perms, 'SOC002')}
            </div>
          </div>`,
        })}
      </div>`;
}

function buildSkillsTab(ccSkills) {
  const skills = ccSkills || [];
  const targets = [
    { id: 'claude', label: kit.te('settings.redesign.product.claude') },
    { id: 'codex', label: kit.te('settings.redesign.product.codex') },
    { id: 'opencode', label: kit.te('settings.redesign.product.opencode') },
  ];
  const row = (skill) => {
    const installed = skill.installedTargets || { claude: !!skill.installed, codex: false, opencode: false };
    const anyOn = targets.some(t => installed[t.id]);
    const chips = targets.map(t => `
              <button type="button" class="cc-skill-target${installed[t.id] ? ' on' : ''}"
                      data-cc-skill="${skill.dirName}"
                      data-cc-target="${t.id}"
                      data-state="${installed[t.id] ? 'on' : 'off'}"
                      ${kit.inv('SKL001')} data-stg-pressed="on" aria-pressed="${installed[t.id] ? 'true' : 'false'}"
                      title="${kit.te('settings.redesign.skills.installFor', { skill: skill.name, assistant: t.label })}">${t.label}</button>
          `).join('');
    return `
          <div class="cc-skill-row${anyOn ? ' installed' : ''}" data-skill-name="${skill.dirName}">
            <div class="cc-skill-info">
              <span class="cc-skill-name">/${skill.name}</span>
              <span class="cc-skill-desc">${skill.description || ''}</span>
            </div>
            <div class="cc-skill-targets" role="group" aria-label="${kit.te('settings.redesign.skills.targets', { skill: skill.name })}">${chips}</div>
          </div>`;
  };

  return `
      <div class="stg-pane" data-stg-pane="skills">
        ${kit.card({
          id: 'stg-sec-skills', section: 'tool_access.skills',
          body: skills.length
            ? `<div ${kit.inv('SKL004')} role="group" aria-label="${kit.L('SKL004')}">${skills.map(row).join('')}</div>
          ${kit.help('SKL001')}`
            : `<div class="stg-help" style="margin-top:0">${kit.te('settings.redesign.skills.none')}</div>`,
        })}
      </div>`;
}

function buildPermissionsTab(toolCategories, toolPermissions) {
  const categories = (toolCategories || []).filter(c => c.id !== 'social');
  const perms = toolPermissions || {};
  // The inventory ids of the "all tools of this group" switches, by group.
  const ALL_SWITCH = {
    memory: 'PER001', browser: 'PER003', whiteboard: 'PER004', cards: 'PER005', automation: 'PER006',
    leonardo: 'PER007', images: 'PER008', gsc: 'PER009', youtube: 'PER010', thirdparty: 'PER011',
  };

  let totalOn = 0, totalAll = 0;
  const catData = categories.map(cat => {
    const onCount = cat.tools.filter(t => perms[t.key] !== false).length;
    totalOn += onCount;
    totalAll += cat.tools.length;
    return { ...cat, onCount };
  });
  const allOn = !!totalAll && totalOn === totalAll;

  const categoryHTML = catData.map(cat => {
    const catAllOn = cat.onCount === cat.tools.length;
    const invId = ALL_SWITCH[String(cat.id).toLowerCase().replace(/[^a-z]/g, '')];
    const title = kit.te('settings.redesign.permissions.toggleAll', { name: cat.label });
    return `
            <div class="cc-tool-category" data-tool-category="${cat.id}">
              <div class="cc-tool-category-header">
                <span class="cc-tool-category-label">${cat.label}</span>
                <span class="cc-tool-category-count">${cat.onCount}/${cat.tools.length}</span>
                <button type="button" class="cc-tool-category-all${catAllOn ? ' on' : ''}" data-cc-tool-cat="${cat.id}"${invId ? ` ${kit.inv(invId)}` : ''} title="${title}" aria-label="${title}" data-stg-pressed="on" aria-pressed="${catAllOn ? 'true' : 'false'}">${kit.te('settings.redesign.permissions.all')}</button>
              </div>
              <div class="cc-hook-toggles">${buildToolRows(cat.tools, perms)}
              </div>
            </div>`;
  }).join('');

  return `
      <div class="stg-pane" data-stg-pane="permissions">
        ${kit.card({
          id: 'stg-sec-tool-permissions', section: 'tool_access.tool_permissions',
          status: `<span class="cc-hooks-badge${allOn ? ' all-on' : ''}" id="cc-tools-badge" title="${kit.te('settings.redesign.permissions.badge')}">${totalOn}/${totalAll}</span>`,
          body: categories.length
            ? `<div ${kit.inv('PER012')} role="group" aria-label="${kit.L('PER012')}">${categoryHTML}</div>`
            : `<div class="stg-help" style="margin-top:0">${kit.te('settings.redesign.permissions.none')}</div>`,
        })}
      </div>`;
}

function buildConnectionsTab(ccIntegrations, ccSkills, tunnelStatus, mcpKeyInfo, openclawBridge, greetingConfig, codexGreetingConfig, opencodeGreetingConfig, toolPermissions, toolCategories) {
  const gh = ccIntegrations.global.hooks || {};
  const ssOn = !!gh.SessionStart;
  const psOn = !!gh.UserPromptSubmit;
  const pcOn = !!gh.PreCompact;
  const stOn = !!gh.Stop;
  const prOn = !!gh.PreToolUse && !!gh.PostToolBatch;
  const ptOn = !!gh.PostToolUse;
  const subStartOn = !!gh.SubagentStart;
  const subStopOn = !!gh.SubagentStop;
  const hf = ccIntegrations.hookFeatures || {};
  const cmOn = hf.conversationMemory !== false;
  const grOn = hf.greeting === true;
  const ulOn = hf.userLearning !== false;
  const ulThreshold = hf.userLearningThreshold || 8;
  const ulMaxNudges = hf.userLearningMaxNudges || 3;
  const srOn = hf.subagentRemember === true;
  const taskRecallOn = hf.taskRecallGate !== false;

  const h = (key, params) => kit.te(`settings.redesign.hooks.${key}`, params);
  const hookRows = [
    { key: 'SessionStart', on: ssOn, inv: 'AUT028' }, { key: 'UserPromptSubmit', on: psOn, inv: 'AUT029' },
    { key: 'PreCompact', on: pcOn, inv: 'AUT030' }, { key: 'Stop', on: stOn, inv: 'AUT031' },
    { key: 'PreToolUse', on: prOn, inv: 'AUT032' }, { key: 'PostToolUse', on: ptOn, inv: 'AUT033' },
    { key: 'SubagentStart', on: subStartOn, inv: 'AUT034' }, { key: 'SubagentStop', on: subStopOn, inv: 'AUT035' },
  ];
  const onCount = hookRows.filter(r => r.on).length;
  const allOn = onCount === hookRows.length;

  const copyIcon = COPY_ICON;

  // Which assistants a block works with: one badge per maker, the list in its popup. The names are product names.
  const providerBadge = (compat) => {
    const anthropicItems = [
      { label: 'Claude Code CLI', on: compat.cli !== false },
      { label: 'Claude Code VSCode', on: compat.vscode !== false },
      { label: 'Claude Web', on: !!compat.web, note: compat.webNote },
      { label: 'Claude Cowork', on: !!compat.cowork },
    ];
    const geminiItems = [
      { label: 'Gemini CLI', on: false },
      { label: 'Gemini Code Assist', on: false },
      { label: 'Gemini Web', on: false },
    ];
    const openaiItems = [
      { label: 'Codex CLI', on: true },
      { label: 'Cursor', on: false },
      { label: 'ChatGPT Web', on: false },
    ];
    const badge = (provider, icon, titleKey, items, untested) => {
      const count = items.filter(i => i.on).length;
      return `<div class="cc-provider-badge" data-provider="${provider}" tabindex="0" role="group" aria-label="${h(titleKey)} ${count}/${items.length}">
        ${icon}
        <div class="cc-compat-popup">
          <div class="cc-compat-header">
            ${icon}
            <span>${h(titleKey)}</span>
            <span class="cc-compat-count">${count}/${items.length}</span>
          </div>
          <div class="cc-compat-grid" data-stg-data>
            ${items.map(i => `<div class="cc-compat-row ${i.on ? 'on' : 'off'}">
              <span class="cc-compat-dot${untested ? ' untested' : ''}"></span>
              <span class="cc-compat-name">${i.label}</span>
              ${i.note ? `<span class="cc-compat-note">${i.note}</span>` : ''}
            </div>`).join('')}
          </div>
        </div>
      </div>`;
    };
    return `<div class="cc-provider-badges" data-stg-nostatus onclick="event.stopPropagation()" ${kit.inv('AUT046')}>
      ${badge('anthropic', ANTHROPIC_ICON, 'compat.claude', anthropicItems, false)}
      ${badge('google', GEMINI_ICON, 'compat.gemini', geminiItems, true)}
      ${badge('openai', OPENAI_ICON, 'compat.openai', openaiItems, true)}
    </div>`;
  };

  // One greeting editor. `ids` are the inventory ids of its controls, in the order below.
  function buildGreetingSection({ kind, enabled, config, prefix, bodyId, toggleAttrs, ids }) {
    const [idToggle, idProject, idTemplate, idShowReminders, idLastSession, idAdd, idSave] = ids;
    const gc = config || { defaults: {}, projects: {}, global: {} };
    const greetingProjects = Object.keys(gc.projects || {});
    const firstKey = greetingProjects[0] || 'global';
    const projectKeys = [...greetingProjects, 'global'];
    const firstCfg = firstKey === 'global'
      ? { ...gc.defaults, ...gc.global }
      : { ...gc.defaults, ...(gc.projects[firstKey] || {}) };
    const projectLabel = (key) => (key === 'global' ? h('greeting.global') : escapeHtml((gc.projects[key] || {}).label || key));
    const buildReminderRow = (reminder) => `
      <div class="cc-greeting-reminder-row">
        <span class="cc-greeting-drag-handle" title="${h('dragToReorder')}">&#8942;&#8942;</span>
        <input class="cc-greeting-reminder-input label" placeholder="${h('label')}" aria-label="${h('label')}" value="${escapeHtml(reminder.label || '')}">
        <input class="cc-greeting-reminder-input cmd" placeholder="${h('command')}" aria-label="${h('command')}" value="${escapeHtml(reminder.command || '')}">
        <button type="button" class="cc-greeting-reminder-remove" title="${h('remove')}" aria-label="${h('remove')}">&times;</button>
      </div>`;
    const remindersHTML = (firstCfg.reminders || []).map(buildReminderRow).join('');
    const variable = (name, id) => `<tr><td><code>{${name}}</code></td><td id="${prefix}-cs-${id}"></td></tr>`;

    return kit.card({
      id: `${prefix}-greeting-config`, level: 'h4', collapsible: true, collapsed: true,
      title: h(`greeting.title.${kind}`), purpose: h(`greeting.purpose.${kind}`),
      status: `<button type="button" class="cc-toggle${enabled ? ' on' : ''}" ${toggleAttrs} ${kit.inv(idToggle)} aria-label="${kit.L(idToggle)}" title="${kit.H(idToggle)}"></button>`,
      body: `
          <div id="${bodyId}" style="display:${enabled ? 'block' : 'none'}">
            <div class="stg-field" ${kit.inv(idProject)}>
              <label id="${prefix}-greeting-project-caption">${kit.L(idProject)}</label>
              <div class="cc-dropdown" id="${prefix}-greeting-project-dropdown" role="group" aria-labelledby="${prefix}-greeting-project-caption">
                <button class="cc-dropdown-trigger" type="button" aria-haspopup="listbox" aria-describedby="${prefix}-greeting-project-help">
                  <span class="cc-dropdown-value" id="${prefix}-greeting-project-label">${projectLabel(firstKey)}</span>
                  <svg class="cc-dropdown-arrow" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
                </button>
                <div class="cc-dropdown-menu" id="${prefix}-greeting-project-menu">
                  ${projectKeys.map((key) => `<div class="cc-dropdown-item${key === firstKey ? ' active' : ''}" data-value="${key}">${projectLabel(key)}</div>`).join('')}
                </div>
                <input type="hidden" id="${prefix}-greeting-project" value="${firstKey}">
              </div>
              <div class="stg-help" id="${prefix}-greeting-project-help">${kit.H(idProject)}</div>
            </div>
            <div class="cc-greeting-field stg-field" ${kit.inv(idTemplate)}>
              <label class="cc-greeting-label" for="${prefix}-greeting-template">${kit.L(idTemplate)}</label>
              <textarea class="cc-greeting-textarea" id="${prefix}-greeting-template" placeholder="${h('greeting.templatePlaceholder')}" aria-describedby="${prefix}-greeting-template-help">${escapeHtml(firstCfg.greetingTemplate || '')}</textarea>
              <div class="stg-help" id="${prefix}-greeting-template-help">${kit.H(idTemplate)}</div>
              <div class="cc-greeting-cheatsheet-toggle" id="${prefix}-greeting-cheatsheet-toggle" ${kit.inv('AUT047')} role="button" tabindex="0">
                <svg viewBox="0 0 24 24" aria-hidden="true" style="width:11px;height:11px;fill:none;stroke:currentColor;stroke-width:2;vertical-align:-1px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                ${kit.L('AUT047')}
              </div>
              <div class="cc-greeting-cheatsheet" id="${prefix}-greeting-cheatsheet" style="display:none">
                <table class="cc-cheatsheet-table">
                  <thead><tr><th>${h('greeting.placeholder')}</th><th>${h('greeting.showsAs')}</th></tr></thead>
                  <tbody>
                    ${variable('time_greeting', 'time')}
                    ${variable('project_label', 'label')}
                    ${variable('project_name', 'name')}
                    ${variable('branch', 'branch')}
                    ${variable('date', 'date')}
                  </tbody>
                </table>
                <div class="cc-cheatsheet-example">
                  <div class="cc-greeting-label" style="margin-bottom:3px">${h('greeting.example')}</div>
                  <div class="cc-cheatsheet-preview" id="${prefix}-cs-preview"></div>
                </div>
              </div>
            </div>
            <div class="cc-greeting-checkboxes">
              ${kit.toggleField(idShowReminders, kit.switchInput(`${prefix}-greeting-show-reminders`, { checked: !!firstCfg.showReminders }), { forId: `${prefix}-greeting-show-reminders` })}
              ${kit.toggleField(idLastSession, kit.switchInput(`${prefix}-greeting-show-last-session`, { checked: !!firstCfg.showLastSession }), { forId: `${prefix}-greeting-show-last-session` })}
            </div>
            <div class="cc-greeting-field stg-field" style="margin-top:12px">
              <label class="cc-greeting-label" id="${prefix}-greeting-reminders-label">${h('greeting.reminders')}</label>
              <div class="cc-greeting-reminder-list" id="${prefix}-greeting-reminders" role="group" aria-labelledby="${prefix}-greeting-reminders-label">${remindersHTML}</div>
              <div class="stg-help">${h('greeting.remindersHelp')}</div>
              <button type="button" class="conn-add-btn" id="${prefix}-greeting-add-reminder" ${kit.inv(idAdd)} title="${kit.H(idAdd)}" style="margin-top:6px">
                <svg viewBox="0 0 24 24" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                ${kit.L(idAdd)}
              </button>
            </div>
            <button type="button" class="conn-add-btn stg-save-btn" id="${prefix}-greeting-save" ${kit.inv(idSave)} title="${kit.H(idSave)}" style="width:100%;margin-top:4px;border-style:solid;background:rgba(79,195,247,0.08);border-color:rgba(79,195,247,0.25);color:rgba(79,195,247,0.9)">
              ${kit.L(idSave)}
            </button>
          </div>`,
    });
  }

  const feature = (invId, key, on, extra = '') => `
              <div class="cc-integration-item${on ? ' enabled' : ''}" data-feature="${key}">
                <div class="cc-integration-info">
                  <div class="cc-integration-label" id="cc-feature-${key}-label">${kit.L(invId)}</div>
                  <div class="cc-integration-path" id="cc-feature-${key}-help">${kit.H(invId)}</div>${extra}
                </div>
                <button type="button" class="cc-toggle${on ? ' on' : ''}" data-cc-feature="${key}" ${kit.inv(invId)} aria-labelledby="cc-feature-${key}-label" aria-describedby="cc-feature-${key}-help"></button>
              </div>`;

  return `
      <div class="stg-pane" data-stg-pane="hooks">

        ${kit.card({
          id: 'stg-sec-greetings', section: 'automations.greetings',
          body: `
          ${buildGreetingSection({ kind: 'cc', enabled: grOn, config: greetingConfig, prefix: 'cc', bodyId: 'cc-greeting-body', toggleAttrs: 'data-cc-feature="greeting"',
            ids: ['AUT001', 'AUT002', 'AUT003', 'AUT004', 'AUT005', 'AUT009', 'AUT010'] })}
          ${buildGreetingSection({ kind: 'codex', enabled: codexGreetingConfig?.enabled === true, config: codexGreetingConfig, prefix: 'codex', bodyId: 'codex-greeting-body', toggleAttrs: 'data-codex-greeting-toggle="enabled"',
            ids: ['AUT011', 'AUT012', 'AUT013', 'AUT014', 'AUT015', 'AUT016', 'AUT017'] })}
          ${buildGreetingSection({ kind: 'opencode', enabled: opencodeGreetingConfig?.enabled === true, config: opencodeGreetingConfig, prefix: 'opencode', bodyId: 'opencode-greeting-body', toggleAttrs: 'data-opencode-greeting-toggle="enabled"',
            ids: ['AUT018', 'AUT019', 'AUT020', 'AUT021', 'AUT022', 'AUT026', 'AUT027'] })}`,
        })}

        ${kit.card({
          id: 'stg-sec-automation-behavior', section: 'automations.automation_behavior',
          status: providerBadge({ cli: true, vscode: true, web: false, cowork: false }),
          body: `
          <div class="stg-help" style="margin:0 0 10px">${h('claudeOnly')}</div>
          <div class="cc-hook-toggles">
            ${feature('AUT036', 'conversationMemory', cmOn)}
            ${feature('AUT039', 'userLearning', ulOn, `
                  <div class="cc-ul-threshold" id="cc-ul-threshold" style="display:${ulOn ? 'flex' : 'none'};align-items:center;gap:6px;margin-top:5px;flex-wrap:wrap">
                    <span class="stg-help" style="margin:0;white-space:nowrap">${h('ul.every')}</span>
                    <input type="number" class="stg-mini-number" id="cc-ul-threshold-input" min="3" max="30" value="${ulThreshold}" ${kit.inv('AUT037')} aria-label="${kit.L('AUT037')}" title="${kit.H('AUT037')}">
                    <span class="stg-help" style="margin:0">${h('ul.interactions')}</span>
                    <span class="stg-help" style="margin:0 0 0 8px;white-space:nowrap">${h('ul.max')}</span>
                    <input type="number" class="stg-mini-number" id="cc-ul-max-nudges-input" min="1" max="10" value="${ulMaxNudges}" ${kit.inv('AUT038')} aria-label="${kit.L('AUT038')}" title="${kit.H('AUT038')}">
                    <span class="stg-help" style="margin:0">${h('ul.perSession')}</span>
                  </div>`)}
            ${feature('AUT040', 'taskRecallGate', taskRecallOn)}
            ${feature('AUT041', 'subagentRemember', srOn)}
          </div>

          ${kit.card({
            id: 'stg-sec-hooks', level: 'h4', collapsible: true, collapsed: true, advanced: true, attrs: 'data-cc-target="global"',
            title: h('hooksTitle'), purpose: h('hooksPurpose'),
            status: `<span class="cc-hooks-badge${allOn ? ' all-on' : ''}" id="cc-hooks-badge">${onCount}/${hookRows.length}</span>${providerBadge({ cli: true, vscode: true, web: false, cowork: false })}`,
            body: `
            <div class="cc-hook-toggles">
              ${hookRows.map(r => `
              <div class="cc-integration-item${r.on ? ' enabled' : ''}" data-hook="${r.key}">
                <div class="cc-integration-info">
                  <div class="cc-integration-label" id="cc-hook-${r.key}-label">${kit.L(r.inv)}</div>
                  <div class="cc-integration-path" id="cc-hook-${r.key}-help">${kit.H(r.inv)}</div>
                </div>
                <button type="button" class="cc-toggle${r.on ? ' on' : ''}" data-cc-hook="${r.key}" data-cc-scope="global" ${kit.inv(r.inv)} aria-labelledby="cc-hook-${r.key}-label" aria-describedby="cc-hook-${r.key}-help"></button>
              </div>`).join('')}
            </div>`,
          })}`,
        })}

        ${kit.card({
          id: 'stg-sec-online-access', section: 'automations.online_access', collapsible: true, collapsed: true, advanced: true,
          status: providerBadge({ cli: true, vscode: true, web: true, webNote: h('compat.viaAddress'), cowork: false }),
          body: `
          ${kit.subhead(h('tunnel.title'))}
          <div class="cc-integration-item${tunnelStatus.running ? ' enabled' : ''}" id="cc-tunnel-row" ${kit.inv('AUT048')}>
            <div class="cc-integration-info">
              <div class="cc-integration-label" id="cc-tunnel-label">${tunnelStatus.running ? h('running') : tunnelStatus.available ? h('ready') : h('tunnel.notInstalled')}</div>
              <div class="cc-integration-path" id="cc-tunnel-url">${tunnelStatus.url ? escapeHtml(tunnelStatus.url) : (tunnelStatus.available ? h('exposeMcpToClaudeWebVia') : h('tunnel.install'))}</div>
            </div>
            ${tunnelStatus.available ? `<button type="button" class="cc-toggle${tunnelStatus.running ? ' on' : ''}" id="cc-tunnel-toggle" ${kit.inv('AUT049')} aria-label="${kit.L('AUT049')}" title="${kit.H('AUT049')}"></button>` : ''}
          </div>
          ${tunnelStatus.url ? `<button type="button" class="cc-copy-btn" id="cc-tunnel-copy-url" ${kit.inv('AUT050')} title="${kit.H('AUT050')}" style="margin-top:4px">${copyIcon} ${h('copyMcpUrl')}</button>` : ''}

          <div style="margin-top:10px">
            <div class="cc-integration-item${mcpKeyInfo.hasKey ? ' enabled' : ''}" id="cc-apikey-row">
              <div class="cc-integration-info">
                <div class="cc-integration-label">${h('apikey.title')}</div>
                <div class="cc-integration-path" id="cc-apikey-status">${mcpKeyInfo.hasKey ? escapeHtml(mcpKeyInfo.maskedKey) : h('apikey.none')}</div>
              </div>
              <button type="button" class="conn-add-btn" id="cc-apikey-generate" ${kit.inv('AUT042')} title="${kit.H('AUT042')}" style="margin:0;padding:3px 8px;width:auto;border-style:solid;background:rgba(255,255,255,0.03)">${mcpKeyInfo.hasKey ? h('regenerate') : h('generateKey')}</button>
            </div>
            <div id="cc-apikey-reveal" style="display:none;margin-top:6px">
              <div class="stg-key-reveal" id="cc-apikey-value"></div>
              <div class="stg-help" style="color:var(--stg-warn)">${h('apikey.saveNow')}</div>
              <div style="margin-top:4px;display:flex;gap:4px">
                <button type="button" class="cc-copy-btn" id="cc-apikey-copy" ${kit.inv('AUT043')} title="${kit.H('AUT043')}" style="flex:1">${copyIcon} ${h('copyKey')}</button>
                <button type="button" class="cc-copy-btn" id="cc-apikey-revoke" ${kit.inv('AUT044')} title="${kit.H('AUT044')}" style="width:auto;padding:4px 8px">${kit.L('AUT044')}</button>
              </div>
            </div>
            <div class="stg-help">${kit.th('settings.redesign.hooks.connectorsHint', { link: `<a href="https://claude.ai/settings/connectors" target="_blank" rel="noopener">${h('claudeWeb')}</a>` })}</div>
          </div>

          ${kit.card({
            id: 'bridge-openclaw', level: 'h4', collapsible: true,
            title: h('bridges.title'), purpose: h('bridges.purpose'),
            status: `<span class="cc-panel-status ${openclawBridge.enabled ? 'active' : 'inactive'}" style="${openclawBridge.enabled ? 'background:rgba(249,115,22,0.15);color:#f97316' : ''}">${openclawBridge.enabled ? h('connected') : h('off')}</span>${providerBadge({ cli: true, vscode: true, web: false, cowork: false })}`,
            body: `
            <div class="cc-integration-item${openclawBridge.enabled ? ' enabled' : ''}">
              <div class="cc-integration-info">
                <div class="cc-integration-label" ${openclawBridge.enabled ? 'style="color:#f97316"' : ''}>${kit.te('settings.redesign.product.openclaw')}</div>
                <div class="cc-integration-path" id="bridge-openclaw-meta">${
                  openclawBridge.enabled
                    ? h('nodesSynced2', { nodes: openclawBridge.nodeCount || 0, nodes2: openclawBridge.lastSync ? ' · ' + new Date(openclawBridge.lastSync).toLocaleTimeString() : '' })
                    : h('readOnlyOverlayOfOpenclawMarkdown')
                }</div>
              </div>
            </div>
            <div class="cc-panel-actions" id="bridge-openclaw-actions">${
              openclawBridge.enabled
                ? `<button type="button" class="cc-enable-btn on" id="bridge-openclaw-sync" ${kit.inv('AUT051')} title="${kit.H('AUT051')}" style="flex:1">
                    <svg viewBox="0 0 24 24" aria-hidden="true" style="width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:2;vertical-align:-1px;margin-right:4px"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>${h('sync')}
                  </button>
                  <button type="button" class="cc-disable-btn" id="bridge-openclaw-disconnect" ${kit.inv('AUT052')} title="${kit.H('AUT052')}">${h('disconnect')}</button>`
                : `<button type="button" class="cc-enable-btn" id="bridge-openclaw-connect" ${kit.inv('AUT045')} title="${kit.H('AUT045')}">${h('connect')}</button>`
            }</div>`,
          })}`,
        })}

      </div>`;
}

function buildProjectsTab(ccIntegrations) {
  const p_ = (key) => kit.te(`settings.redesign.projects.${key}`);
  const stat = (key, id, cls = '') => `<div class="project-storage-stat${cls}"><span>${p_(`stat.${key}`)}</span><strong id="${id}">—</strong></div>`;
  const row = (p, i) => {
    const path = escapeHtml(p.path.replace(/\\/g, '/'));
    return `
              <div class="cc-panel${p.installed ? ' enabled' : ''}" data-cc-idx="${i}" data-cc-path="${p.path.replace(/"/g, '&quot;')}">
                <div class="cc-panel-header" data-cc-collapse role="button" tabindex="0">
                  <svg class="cc-panel-chevron" viewBox="0 0 24 24" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
                  <span class="cc-panel-title">${escapeHtml(p.label)}</span>
                  <span class="cc-panel-status ${p.installed ? 'active' : 'inactive'}">${kit.te(p.installed ? 'settings.redesign.hooks.active' : 'settings.redesign.hooks.off')}</span>
                </div>
                <div class="cc-panel-body">
                  <div class="cc-panel-row">
                    <span class="cc-panel-row-label">${p_('row.path')}</span>
                    <span class="cc-panel-row-value" title="${path}">${path}</span>
                  </div>
                  <div class="cc-panel-actions">
                    <button type="button" class="cc-explore-btn" data-cc-explore="${i}" ${kit.inv('PRJ007')} title="${kit.H('PRJ007')}" style="background:var(--accent-blue-bg);border:1px solid var(--accent-blue-border);color:var(--accent-blue);padding:5px 12px;border-radius:4px;cursor:pointer;font-size:12px">${kit.L('PRJ007')}</button>
                    <button type="button" class="cc-trust-btn" data-cc-trust="${i}" ${kit.inv('PRJ008')} title="${kit.H('PRJ008')}" style="background:rgba(255,183,77,0.14);border:1px solid rgba(255,183,77,0.3);color:#ffcc80;padding:5px 12px;border-radius:4px;cursor:pointer;font-size:12px">${kit.L('PRJ008')}</button>
                    <button type="button" class="cc-enable-btn${p.installed ? ' on' : ''}" data-cc-project-toggle="${i}" ${kit.inv('PRJ009')} title="${kit.H('PRJ009')}" data-stg-pressed="on" aria-pressed="${p.installed ? 'true' : 'false'}">${kit.te(p.installed ? 'settings.redesign.hooks.enabled' : 'settings.redesign.hooks.enable')}</button>
                    <button type="button" class="cc-remove-panel-btn" data-cc-remove="${i}" ${kit.inv('PRJ010')} title="${kit.H('PRJ010')}">${kit.L('PRJ010')}</button>
                  </div>
                </div>
              </div>`;
  };

  return `
      <div class="stg-pane" data-stg-pane="projects">

        ${kit.card({
          id: 'stg-sec-workspaces', section: 'projects.workspaces',
          attrs: 'aria-describedby="cc-project-list-help"',
          body: `
          <div class="stg-help" id="cc-project-list-help" style="margin:0 0 10px"><span id="project-registration-title"></span>${kit.th('settings.redesign.projects.listHelp', { file: '<code class="stg-code">.claude/settings.json</code>' })}</div>
          <div id="cc-project-list" ${kit.inv('PRJ013')} role="group" aria-label="${kit.L('PRJ013')}">
            ${ccIntegrations.projects.length === 0
              ? `<div class="cc-hint" style="text-align:center;padding:14px">${p_('noProjectsRegisteredYet')}</div>`
              : ccIntegrations.projects.map(row).join('')}
          </div>
          <div class="stg-field" ${kit.inv('PRJ011')} style="margin-top:12px">
            <button type="button" class="conn-add-btn" id="cc-add-project" aria-describedby="cc-add-project-help">
              <svg viewBox="0 0 24 24" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              ${kit.L('PRJ011')}
            </button>
            ${kit.help('PRJ011', { forId: 'cc-add-project' })}
          </div>`,
        })}

        ${kit.card({
          id: 'project-storage-manager', section: 'projects.project_storage', className: 'project-storage-section',
          collapsible: true, collapsed: true, advanced: true,
          body: `
          <div class="project-storage-heading">
            <p class="project-storage-intro" id="project-storage-title">${p_('storageIntro')}</p>
            <button class="project-storage-icon-btn" id="project-storage-refresh" type="button" ${kit.inv('PRJ001')} title="${kit.H('PRJ001')}" aria-label="${kit.L('PRJ001')}">
              <svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
            </button>
          </div>
          <div class="project-storage-summary" id="project-storage-summary" ${kit.inv('PRJ012')} role="group" aria-label="${kit.L('PRJ012')}" hidden>
            ${stat('found', 'project-storage-found')}
            ${stat('reclaimable', 'project-storage-reclaimable')}
            ${stat('selected', 'project-storage-selected', ' selected')}
          </div>
          <div class="project-storage-toolbar" id="project-storage-toolbar" hidden>
            <button class="project-storage-btn" id="project-storage-select-safe" type="button" ${kit.inv('PRJ002')} title="${kit.H('PRJ002')}">${kit.L('PRJ002')}</button>
            <button class="project-storage-btn" id="project-storage-clear-selection" type="button" ${kit.inv('PRJ003')} title="${kit.H('PRJ003')}">${kit.L('PRJ003')}</button>
            <span class="project-storage-toolbar-spacer"></span>
            <button class="project-storage-btn danger" id="project-storage-clear" type="button" ${kit.inv('PRJ004')} title="${kit.H('PRJ004')}" disabled>${kit.L('PRJ004')}</button>
          </div>
          <div class="project-storage-feedback" id="project-storage-feedback" aria-live="polite"></div>
          <div class="project-storage-results" id="project-storage-results">
            <div class="project-storage-placeholder">${p_('storagePlaceholder')}</div>
          </div>
          <div class="project-storage-safety-note">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>
            ${p_('safetyNote')}
          </div>`,
        })}

      </div>`;
}

/** Translated copy for the maintenance list (ui-memory-maintenance.js keeps English defaults for its own test). */
function memoryMaintenanceStrings() {
  const m = (key) => kit.tx(`settings.redesign.memory.maint.${key}`);
  return {
    requestFailed: m('requestFailed'), loading: m('loading'), running: m('running'), paused: m('paused'), noWork: m('noWork'),
    pause: m('pause'), resume: m('resume'), refresh: m('refresh'), retry: m('retry'), undo: m('undo'), confirm: m('confirm'),
    noReview: m('noReview'), jobCount: m('jobCount'),
    help: {
      pause: kit.tx('settings.redesign.control.mem012.help'), resume: kit.tx('settings.redesign.control.mem012.help'),
      refresh: kit.tx('settings.redesign.control.mem013.help'), retry: kit.tx('settings.redesign.control.mem014.help'),
      undo: kit.tx('settings.redesign.control.mem015.help'), confirm: kit.tx('settings.redesign.control.mem016.help'),
      details: kit.tx('settings.redesign.control.mem001.help'),
    },
    jobStatus: { pending: m('status.pending'), running: m('status.running'), failed: m('status.failed'), complete: m('status.complete') },
    relationKind: { similar: m('kind.similar'), supersedes: m('kind.supersedes'), verify: m('kind.verify'), possible_conflict: m('kind.possible_conflict'), conflicts_with: m('kind.conflicts_with') },
  };
}

function buildMemoryTab() {
  const m = (key) => kit.te(`settings.redesign.memory.${key}`);
  const profile = (id, icon, active = false) => `
              <div class="recall-profile-card${active ? ' active' : ''}" data-recall-profile="${id}" role="radio" tabindex="0" aria-checked="${active ? 'true' : 'false'}" data-stg-checked="active">
                <div class="recall-profile-icon"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg></div>
                <div class="recall-profile-name">${m(`profile.${id}.name`)}</div>
                <div class="recall-profile-desc">${m(`profile.${id}.desc`)}</div>
              </div>`;
  const stat = (id, key) => `
              <div class="recall-impact-stat">
                <span class="recall-impact-val" id="${id}">&mdash;</span>
                <span class="recall-impact-label">${m(`impact.${key}`)}</span>
              </div>`;
  const range = (invId, id, attrs, value, valueText, extra = '') => `
              <div class="recall-control-row" ${kit.inv(invId)}>
                <div class="recall-control-header">
                  <label class="recall-control-label" for="${id}">${kit.L(invId)}</label>
                  <span class="recall-control-val" id="${id}-val">${valueText}</span>
                </div>
                <input type="range" class="recall-range" id="${id}" ${attrs} value="${value}" aria-describedby="${id}-help">${extra}
                <div class="recall-control-hint" id="${id}-help">${kit.H(invId)}</div>
              </div>`;
  const seg = (value, active = false) => `<button type="button" class="recall-seg-btn${active ? ' active' : ''}" data-val="${value}" data-stg-pressed="active" aria-pressed="${active ? 'true' : 'false'}">${m(`seg.${value}`)}</button>`;

  return `
      <div class="stg-pane" data-stg-pane="memory">

        ${kit.card({
          id: 'stg-sec-find-memories', section: 'memory_backups.find_memories',
          body: `
          <div class="stg-field" ${kit.inv('MEM009')}>
            <label id="recall-profiles-label">${kit.L('MEM009')}</label>
            <div class="recall-profiles" id="recall-profiles" role="radiogroup" aria-labelledby="recall-profiles-label" aria-describedby="recall-profiles-help">
              ${profile('quick', '<path d="M5 12h14"/><path d="M12 5l7 7-7 7"/>')}
              ${profile('balanced', '<circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>', true)}
              ${profile('deep', '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/><path d="M12 6c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6z"/><circle cx="12" cy="12" r="2"/>')}
              ${profile('custom', '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>')}
            </div>
            <div class="stg-help" id="recall-profiles-help">${kit.H('MEM009')}</div>
          </div>

          <div class="stg-field" ${kit.inv('MEM010')}>
            <label id="recall-impact-label">${kit.L('MEM010')}</label>
            <div class="recall-impact" id="recall-impact" role="group" aria-labelledby="recall-impact-label" aria-describedby="recall-impact-help">
              ${stat('recall-impact-tokens', 'tokens')}
              ${stat('recall-impact-reachable', 'reachable')}
              ${stat('recall-impact-sessions', 'sessions')}
            </div>
            <div class="stg-help" id="recall-impact-help">${kit.H('MEM010')}</div>
          </div>

          ${kit.card({
            id: 'recall-controls', level: 'h4', collapsible: true, collapsed: true,
            title: kit.L('MEM011'), purpose: kit.H('MEM011'), attrs: kit.inv('MEM011'),
            status: `<span class="recall-controls-badge" id="recall-controls-badge">${m('usingProfileDefaults')}</span>`,
            body: `
            <div class="recall-control-group">
              ${range('MEM002', 'rc-limit', 'min="1" max="20" step="1"', 5, '5')}
              ${range('MEM003', 'rc-importance', 'min="0" max="10" step="1"', 0, m('any'), `
                <div class="recall-control-scale" aria-hidden="true">
                  <span>${m('any')}</span><span>${m('trivial')}</span><span>${m('normal')}</span><span>${m('significant')}</span><span>${m('critical')}</span>
                </div>`)}
              ${range('MEM004', 'rc-score', 'min="10" max="80" step="5"', 30, '0.30')}
              ${range('MEM005', 'rc-maxchars', 'min="100" max="2100" step="50"', 2100, m('noLimit'))}

              <div class="recall-control-row" ${kit.inv('MEM006')}>
                <div class="recall-control-header">
                  <span class="recall-control-label" id="rc-sessions-label">${kit.L('MEM006')}</span>
                </div>
                <div class="recall-segmented" id="rc-sessions" role="group" aria-labelledby="rc-sessions-label" aria-describedby="rc-sessions-help">
                  ${seg('never')}${seg('auto', true)}${seg('always')}
                </div>
                <div class="recall-control-hint" id="rc-sessions-help">${kit.H('MEM006')}</div>
              </div>

              <div class="recall-control-row" ${kit.inv('MEM007')}>
                <div class="recall-control-header">
                  <label class="recall-control-label" for="rc-recency">${kit.L('MEM007')}</label>
                  ${kit.switchInput('rc-recency')}
                </div>
                <div class="recall-control-hint" id="rc-recency-help">${kit.H('MEM007')}</div>
              </div>
            </div>`,
          })}`,
        })}

        ${kit.card({
          id: 'stg-sec-maintenance', section: 'memory_backups.maintenance', advanced: true,
          status: kit.pill('', { id: 'memory-maintenance-pill' }),
          body: `
          <div id="memory-maintenance" ${kit.inv('MEM008')} role="group" aria-label="${kit.L('MEM008')}" aria-describedby="memory-maintenance-help"></div>
          ${kit.help('MEM008', { forId: 'memory-maintenance' })}`,
        })}

      </div>`;
}

function ifaceSliderRow(invId, key, min, max, step, decimals, value) {
  const display = Number(value).toFixed(decimals);
  return `<div class="gfx-row" ${kit.inv(invId)}>
    <label class="gfx-label" for="iface-${key}">${kit.L(invId)}</label>
    <input type="range" id="iface-${key}" data-iface-key="${key}" min="${min}" max="${max}" step="${step}" value="${value}" title="${kit.H(invId)}">
    <span class="gfx-val" data-iface-val="${key}">${display}</span>
  </div>`;
}

function buildMoreLoginTab() {
  // Shell only — live data is loaded async by wireMoreLoginTab() so opening
  // Settings never blocks on the MoreLogin probe.
  const m = (key) => kit.te(`settings.redesign.morelogin.${key}`);
  const text = (id, { ph = '', type = 'text' } = {}) =>
    `<input type="${type}" id="${id}" value=""${ph ? ` placeholder="${ph}"` : ''} autocomplete="off" spellcheck="false" aria-describedby="${id}-help">`;
  const btn = (invId, id) => `<button type="button" class="stg-action-btn compact" id="${id}" ${kit.inv(invId)} title="${kit.H(invId)}">${kit.L(invId)}</button>`;

  return `
    <div class="stg-pane" data-stg-pane="morelogin">

      ${kit.card({
        id: 'stg-sec-ml-connection', section: 'connected_tools.morelogin_connection',
        status: `<span id="ml-conn-status">…</span>`,
        body: `
        <div class="settings-status" ${kit.inv('ML015')} role="status" aria-live="polite">
          <span class="settings-status-dot disconnected" id="ml-status-dot"></span>
          <span id="ml-status-line">${m('checking')}</span>
        </div>
        <div class="stg-help" style="margin:8px 0 12px">${kit.th('settings.redesign.morelogin.intro', {
          link: '<a href="https://www.morelogin.com" target="_blank" rel="noopener">morelogin.com</a>',
          path: `<strong>${m('apiPath')}</strong>`,
        })}</div>
        ${kit.field('ML001', `
          <div class="settings-key-row">
            ${text('ml-port', { ph: '40000' })}
            ${btn('ML002', 'ml-port-save')}
          </div>`, { forId: 'ml-port' })}
        <div class="stg-field" ${kit.inv('ML003')}>
          <div class="stg-action-row">
            <button type="button" class="stg-action-btn" id="ml-test-btn" aria-describedby="ml-test-btn-help">${kit.L('ML003')}</button>
          </div>
          ${kit.help('ML003', { forId: 'ml-test-btn' })}
          <div id="ml-test-result" role="status" style="display:none;margin-top:10px;padding:10px 12px;border-radius:8px;font-size:12px"></div>
        </div>`,
      })}

      ${kit.card({
        id: 'stg-sec-ml-profiles', section: 'connected_tools.morelogin_profiles',
        status: `<span id="ml-default-status"></span>`,
        body: `
        ${kit.field('ML004', `
          <div class="settings-key-row">
            ${text('ml-new-name', { ph: m('ph.newName') })}
            ${btn('ML005', 'ml-create-btn')}
            ${btn('ML006', 'ml-refresh-btn')}
          </div>`, { forId: 'ml-new-name' })}
        <div id="ml-profile-list" ${kit.inv('ML016')} role="group" aria-label="${kit.L('ML016')}" style="display:flex;flex-direction:column;gap:6px"></div>`,
      })}

      ${kit.card({
        id: 'stg-sec-ml-credentials', section: 'connected_tools.morelogin_credentials', collapsible: true, collapsed: true, advanced: true,
        body: `
        <div class="stg-help" style="margin:0 0 12px">${m('credentialsHelp')}</div>
        ${kit.field('ML007', `
          <div class="settings-key-row">
            ${text('ml-api-id')}
            ${btn('ML008', 'ml-apiid-save')}
          </div>`, { forId: 'ml-api-id' })}
        ${kit.field('ML009', `
          <div class="settings-key-row">
            ${text('ml-secret', { type: 'password' })}
            <button type="button" class="stg-action-btn compact" id="ml-secret-eye" ${kit.inv('ML010')} aria-label="${kit.L('ML010')}" title="${kit.L('ML010')}">${eyeClosed}</button>
            ${btn('ML011', 'ml-secret-save')}
          </div>`, { forId: 'ml-secret' })}`,
      })}

      ${kit.card({
        id: 'stg-sec-ml-server', section: 'connected_tools.morelogin_tool_server', collapsible: true, collapsed: true, advanced: true,
        body: `
        <div class="stg-help" style="margin:0 0 12px">${m('serverHelp')}</div>
        ${kit.field('ML012', `<textarea id="ml-mcp-config" class="stg-code-area" placeholder='{ "command": "...", "args": [ ... ] }' spellcheck="false" aria-describedby="ml-mcp-config-help"></textarea>`, { forId: 'ml-mcp-config' })}
        <div class="stg-action-row">
          <button type="button" class="stg-action-btn" id="ml-mcp-register" ${kit.inv('ML013')} title="${kit.H('ML013')}">${kit.L('ML013')}</button>
          <button type="button" class="stg-action-btn" id="ml-mcp-unregister" ${kit.inv('ML014')} title="${kit.H('ML014')}">${kit.L('ML014')}</button>
        </div>
        <div id="ml-mcp-result" role="status" style="display:none;margin-top:10px;padding:10px 12px;border-radius:8px;font-size:12px"></div>`,
      })}

    </div>`;
}

function wireMoreLoginTab(overlay) {
  const $ = (id) => overlay.querySelector('#' + id);
  if (!$('ml-status-dot')) return;
  let _defaultEnvId = null;
  const okBg = 'rgba(76,175,80,0.12)', errBg = 'rgba(244,67,54,0.12)';

  const jget = (u) => fetch(u).then(r => r.json()).catch(() => ({ ok: false, error: kit.tx('settings.redesign.morelogin.networkError') }));
  const jpost = (u, body) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(r => r.json()).catch(() => ({ ok: false, error: kit.tx('settings.redesign.morelogin.networkError') }));

  function setStatus(s) {
    const dot = $('ml-status-dot'), line = $('ml-status-line'), conn = $('ml-conn-status');
    if (!s.installed) { dot.className = 'settings-status-dot disconnected'; line.textContent = kit.tx('settings.redesign.morelogin.moreloginNotInstalled'); if (conn) conn.textContent = kit.tx('settings.redesign.morelogin.notInstalled'); }
    else if (!s.running) { dot.className = 'settings-status-dot disconnected'; line.textContent = kit.tx('settings.redesign.morelogin.installedApiNotRunningPort', { port: s.port }); if (conn) conn.textContent = kit.tx('settings.redesign.morelogin.appClosed'); }
    else { dot.className = 'settings-status-dot connected'; line.textContent = kit.tx('settings.redesign.morelogin.connectedProfileSPort', { profileCount: s.profileCount, port: s.port }); if (conn) conn.textContent = kit.tx('settings.redesign.morelogin.connected'); }
    _defaultEnvId = s.defaultEnvId || null;
    const ds = $('ml-default-status');
    if (ds) ds.textContent = (s.isDefault && s.defaultEnvId) ? kit.tx('settings.redesign.morelogin.defaultAiBrowserSet') : kit.tx('settings.redesign.morelogin.noDefaultSet');
  }

  function renderProfiles(envs) {
    const list = $('ml-profile-list');
    if (!list) return;
    if (!envs || !envs.length) { list.innerHTML = '<div class="settings-hint">' + kit.te('settings.redesign.morelogin.noProfilesCreateOneAboveOr') + '</div>'; return; }
    list.innerHTML = envs.map(e => {
      const id = escapeHtml(String(e.id));
      const isDefault = String(e.id) === String(_defaultEnvId);
      return `<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid ${isDefault ? 'var(--accent)' : 'var(--s-medium)'};border-radius:8px;background:var(--s-darker)">
        <span style="flex:1;font-size:12.5px">${escapeHtml(e.name)}${e.status ? ` <span style="color:var(--t-muted);font-size:11px">(${escapeHtml(String(e.status))})</span>` : ''}</span>
        ${isDefault ? '<span style="font-size:11px;color:var(--accent)">' + kit.te('settings.redesign.morelogin.default') + '</span>' : `<button type="button" class="conn-add-btn ml-use" data-env-id="${id}" ${kit.inv('ML019')} title="${kit.H('ML019')}" style="margin:0;width:auto;padding:3px 8px">${kit.L('ML019')}</button>`}
        <button type="button" class="conn-add-btn ml-start" data-env-id="${id}" ${kit.inv('ML017')} title="${kit.H('ML017')}" style="margin:0;width:auto;padding:3px 8px">${kit.L('ML017')}</button>
        <button type="button" class="conn-add-btn ml-stop" data-env-id="${id}" ${kit.inv('ML018')} title="${kit.H('ML018')}" style="margin:0;width:auto;padding:3px 8px">${kit.L('ML018')}</button>
      </div>`;
    }).join('');
    list.querySelectorAll('.ml-use').forEach(b => b.addEventListener('click', async () => {
      const r = await jpost('/api/morelogin/use-default', { envId: b.dataset.envId });
      showCCToast(r.ok ? kit.tx('settings.redesign.morelogin.moreloginSetAsDefaultAiBrowser') : (r.error || kit.tx('settings.redesign.morelogin.failed')));
      reload();
    }));
    list.querySelectorAll('.ml-start').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true; const t = b.textContent; b.textContent = kit.tx('settings.redesign.morelogin.starting');
      const r = await jpost('/api/morelogin/start', { envId: b.dataset.envId });
      showCCToast(r.ok ? kit.tx('settings.redesign.morelogin.startedDebugPort', { debugPort: r.debugPort }) : (r.error || kit.tx('settings.redesign.morelogin.startFailed')));
      b.disabled = false; b.textContent = t; reload();
    }));
    list.querySelectorAll('.ml-stop').forEach(b => b.addEventListener('click', async () => {
      await jpost('/api/morelogin/stop', { envId: b.dataset.envId });
      reload();
    }));
  }

  async function reload() {
    const s = await jget('/api/morelogin/status');
    if (s.ok) setStatus(s);
    const cfg = await jget('/api/morelogin/config');
    if (cfg.ok) {
      if ($('ml-port') && !$('ml-port').value) $('ml-port').value = cfg.config.port || '';
      if ($('ml-api-id') && !$('ml-api-id').value) $('ml-api-id').value = cfg.config.apiId || '';
    }
    const p = await jget('/api/morelogin/profiles');
    renderProfiles(p.envs || []);
  }

  const saveCfg = (key, value) => fetch('/api/morelogin/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value }) });

  $('ml-port-save')?.addEventListener('click', async () => { await saveCfg('port', ($('ml-port').value || '').trim()); showCCToast(kit.tx('settings.redesign.morelogin.portSaved')); reload(); });
  $('ml-apiid-save')?.addEventListener('click', async () => { await saveCfg('apiId', ($('ml-api-id').value || '').trim()); showCCToast(kit.tx('settings.redesign.morelogin.apiIdSaved')); });
  $('ml-secret-save')?.addEventListener('click', async () => { await saveCfg('secret', $('ml-secret').value || ''); showCCToast(kit.tx('settings.redesign.morelogin.secretSaved')); });
  $('ml-secret-eye')?.addEventListener('click', () => { const i = $('ml-secret'); if (i) i.type = i.type === 'password' ? 'text' : 'password'; });
  $('ml-refresh-btn')?.addEventListener('click', reload);
  $('ml-create-btn')?.addEventListener('click', async () => {
    const name = ($('ml-new-name')?.value || '').trim() || 'SynaBun';
    const r = await jpost('/api/morelogin/profiles', { name });
    showCCToast(r.ok ? kit.tx('settings.redesign.morelogin.profileCreated') : (r.error || kit.tx('settings.redesign.morelogin.createFailed')));
    if ($('ml-new-name')) $('ml-new-name').value = '';
    reload();
  });
  $('ml-test-btn')?.addEventListener('click', async () => {
    const res = $('ml-test-result');
    if (res) { res.style.display = 'block'; res.textContent = kit.tx('settings.redesign.morelogin.testing'); res.style.background = 'var(--s-darker)'; res.style.color = 'var(--t-secondary)'; }
    const r = await jpost('/api/morelogin/test', {});
    if (res) { res.textContent = r.ok ? kit.tx('settings.redesign.morelogin.reachableOnPortProfileS', { port: r.port, profileCount: r.profileCount }) : `✗ ${r.error}`; res.style.background = r.ok ? okBg : errBg; res.style.color = r.ok ? '#4caf50' : '#f44336'; }
    reload();
  });
  $('ml-mcp-register')?.addEventListener('click', async () => {
    const res = $('ml-mcp-result');
    let cfg = null;
    const raw = ($('ml-mcp-config')?.value || '').trim();
    if (raw) { try { cfg = JSON.parse(raw); } catch { if (res) { res.style.display = 'block'; res.textContent = kit.tx('settings.redesign.morelogin.invalidJsonConfig'); res.style.background = errBg; res.style.color = '#f44336'; } return; } }
    const r = await jpost('/api/morelogin/register-mcp', { config: cfg });
    if (res) { res.style.display = 'block'; res.textContent = r.ok ? kit.tx('settings.redesign.morelogin.registeredWithRestartYourAgentTo', { targets: (r.targets || []).join(', ') || kit.tx('settings.redesign.morelogin.noAgentConfigsFound') }) : (r.error || kit.tx('settings.redesign.morelogin.failed')); res.style.background = r.ok ? okBg : errBg; res.style.color = r.ok ? '#4caf50' : '#f44336'; }
  });
  $('ml-mcp-unregister')?.addEventListener('click', async () => {
    const res = $('ml-mcp-result');
    const r = await fetch('/api/morelogin/register-mcp', { method: 'DELETE' }).then(x => x.json()).catch(() => ({ ok: false, error: kit.tx('settings.redesign.morelogin.networkError') }));
    if (res) { res.style.display = 'block'; res.textContent = r.ok ? kit.tx('settings.redesign.morelogin.removedFrom', { targets: (r.targets || []).join(', ') || kit.tx('settings.redesign.morelogin.none') }) : (r.error || kit.tx('settings.redesign.morelogin.failed')); res.style.background = 'var(--s-darker)'; res.style.color = 'var(--t-secondary)'; }
  });

  reload();
}

function buildDiscordTab(discordConfig) {
  const c = discordConfig || {};
  const hasToken = !!c.botToken;
  const d = (key) => kit.te(`settings.redesign.discord.${key}`);
  const save = (invId, id) => `<button type="button" class="stg-action-btn compact" id="${id}" ${kit.inv(invId)} title="${kit.H(invId)}">${kit.L(invId)}</button>`;
  // A default the Discord tools fall back on: saved as soon as the field changes (data-discord-key).
  const text = (invId, id, key, value) => kit.field(invId, `
          <div class="settings-key-row">
            <input type="text" id="${id}" value="${escapeHtml(value || '')}" autocomplete="off" spellcheck="false" data-discord-key="${key}" aria-describedby="${id}-help">
          </div>`, { forId: id });
  const number = (invId, id, key, value, attrs, unit) => kit.field(invId, `
          <div class="settings-key-row" style="display:flex;gap:6px;align-items:center">
            <input type="number" id="${id}" value="${value}" ${attrs} style="width:80px;text-align:center" data-discord-key="${key}" aria-describedby="${id}-help">
            <span class="stg-help" style="margin:0">${d(unit)}</span>
          </div>`, { forId: id });
  const PERMISSIONS = ['administrator', 'manageServer', 'manageChannels', 'manageRoles', 'manageMessages', 'manageWebhooks', 'kickBan', 'moderate', 'send', 'react', 'history', 'view'];
  const TOOLS = ['discord_guild', 'discord_channel', 'discord_role', 'discord_message', 'discord_member', 'discord_onboarding', 'discord_webhook', 'discord_thread'];

  return `
    <div class="stg-pane" data-stg-pane="discord">

      ${kit.card({
        id: 'stg-sec-discord-connection', section: 'messages.bot_connection',
        status: `<span id="discord-conn-status">${d(hasToken ? 'configured' : 'missing')}</span>`,
        body: `
        <div class="settings-status" ${kit.inv('DIS016')} role="status"><span class="settings-status-dot ${hasToken ? 'connected' : 'disconnected'}"></span> ${d(hasToken ? 'tokenConfigured' : 'notConfigured')}</div>
        ${kit.field('DIS001', `
          <div class="settings-key-row">
            <input type="password" id="discord-bot-token" value="${escapeHtml(c.botToken || '')}" autocomplete="off" spellcheck="false" aria-describedby="discord-bot-token-help">
            <button type="button" class="stg-action-btn compact discord-eye-btn" id="discord-token-eye" ${kit.inv('DIS002')} aria-label="${kit.L('DIS002')}" title="${kit.L('DIS002')}">${eyeClosed}</button>
            ${save('DIS003', 'discord-token-save')}
          </div>`, { forId: 'discord-bot-token', attrs: 'style="margin-top:12px"',
          helpHtml: kit.th('settings.redesign.discord.tokenHelp', { link: '<a href="https://discord.com/developers/applications" target="_blank" rel="noopener">discord.com/developers</a>' }) })}
        ${kit.field('DIS004', `
          <div class="settings-key-row">
            <input type="text" id="discord-guild-id" value="${escapeHtml(c.guildId || '')}" autocomplete="off" spellcheck="false" aria-describedby="discord-guild-id-help">
            ${save('DIS005', 'discord-guild-save')}
          </div>`, { forId: 'discord-guild-id' })}
        <div class="stg-field" ${kit.inv('DIS006')}>
          <div class="stg-action-row">
            <button type="button" class="stg-action-btn" id="discord-test-btn" aria-describedby="discord-test-btn-help">${kit.L('DIS006')}</button>
          </div>
          ${kit.help('DIS006', { forId: 'discord-test-btn' })}
          <div id="discord-test-result" role="status" style="display:none;margin-top:10px;padding:10px 12px;border-radius:8px;font-size:12px"></div>
        </div>`,
      })}

      ${kit.card({
        id: 'stg-sec-discord-server', section: 'messages.server_defaults',
        body: `
        ${text('DIS009', 'discord-default-category', 'defaultCategory', c.defaultCategory)}
        ${text('DIS010', 'discord-welcome-channel', 'welcomeChannel', c.welcomeChannel)}
        ${text('DIS011', 'discord-rules-channel', 'rulesChannel', c.rulesChannel)}
        ${text('DIS012', 'discord-log-channel', 'logChannel', c.logChannel)}
        ${text('DIS013', 'discord-mod-role', 'modRole', c.modRole)}`,
      })}

      ${kit.card({
        id: 'stg-sec-discord-moderation', section: 'messages.moderation_defaults',
        body: `
        ${number('DIS014', 'discord-ban-delete-days', 'banDeleteDays', c.banDeleteDays || '0', 'min="0" max="7"', 'days')}
        ${number('DIS015', 'discord-timeout-minutes', 'timeoutMinutes', c.timeoutMinutes || '10', 'min="1" max="40320"', 'minutes')}`,
      })}

      ${kit.card({
        id: 'stg-sec-discord-permissions', section: 'messages.required_permissions', collapsible: true, collapsed: true, advanced: true,
        body: `
        <dl class="discord-permissions stg-pairs" ${kit.inv('DIS017')} aria-label="${kit.L('DIS017')}">
          ${PERMISSIONS.map(p => `<dt>${d(`perm.${p}.name`)}</dt><dd>${d(`perm.${p}.desc`)}</dd>`).join('\n          ')}
        </dl>
        ${kit.field('DIS007', `
          <div class="settings-key-row">
            <input type="text" id="discord-invite-link" value="" readonly autocomplete="off" spellcheck="false" aria-describedby="discord-invite-link-help">
            <button type="button" class="stg-action-btn compact" id="discord-invite-copy" ${kit.inv('DIS008')} aria-label="${kit.L('DIS008')}" title="${kit.L('DIS008')}">${COPY_ICON}</button>
          </div>`, { forId: 'discord-invite-link', attrs: 'style="margin-top:14px"' })}`,
      })}

      ${kit.card({
        id: 'stg-sec-discord-tools', section: 'messages.mcp_tools_reference', collapsible: true, collapsed: true, advanced: true,
        body: `
        <dl class="discord-tool-reference stg-pairs" ${kit.inv('DIS018')} aria-label="${kit.L('DIS018')}">
          ${TOOLS.map(name => `<dt><code class="stg-code">${name}</code></dt><dd>${d(`tool.${name}`)}</dd>`).join('\n          ')}
        </dl>
        <div class="stg-help">${kit.th('settings.redesign.discord.toolsHelp', { action: '<code class="stg-code">action</code>' })}</div>`,
      })}

    </div>`;
}

// ── Language ──
// The choice is 'system' or a locale (i18n.js). Applying it reloads the app, so the page the
// user was on is kept for one reload in sessionStorage and Settings opens there again.
const SETTINGS_REOPEN_KEY = 'synabun-settings-reopen';

function buildLanguageTab() {
  const systemName = LOCALE_NAMES[getSystemLocale()];
  const options = [
    { value: SYSTEM_LOCALE, label: systemName ? kit.te('settings.redesign.language.systemWith', { name: systemName }) : kit.te('settings.redesign.language.system') },
    ...SUPPORTED_LOCALES.map((locale) => ({ value: locale, label: kit.esc(LOCALE_NAMES[locale] || locale) })),
  ];
  return `<div class="stg-pane" data-stg-pane="language">
    ${kit.card({
      id: 'stg-sec-language', section: 'appearance.language',
      body: kit.field('APP001', kit.dropdown('stg-language', options, { value: getLocaleChoice(), classes: 'stg-dropdown stg-dropdown-inline', label: kit.L('APP001'), attrs: 'aria-describedby="stg-language-help"' }), { forId: 'stg-language' }),
    })}
  </div>`;
}

function wireLanguageTab(overlay) {
  const input = overlay.querySelector('#stg-language');
  if (!input) return;
  input.addEventListener('change', () => {
    if (input.value === getLocaleChoice()) return;
    const page = overlay.querySelector('.settings-nav-item.active')?.dataset.tab || 'appearance';
    try { sessionStorage.setItem(SETTINGS_REOPEN_KEY, page); } catch { /* private mode: the reload lands on the map */ }
    if (!setLocaleChoice(input.value)) { try { sessionStorage.removeItem(SETTINGS_REOPEN_KEY); } catch {} }
  });
}

/** The page to open Settings on after a reload the Language popup asked for; read once. */
function takeSettingsReopen() {
  try {
    const page = sessionStorage.getItem(SETTINGS_REOPEN_KEY);
    if (page) sessionStorage.removeItem(SETTINGS_REOPEN_KEY);
    return getSettingsPage(page)?.id || null;
  } catch { return null; }
}

function buildInterfaceTab() {
  const cfg = loadIfaceConfig();
  const u = (key) => kit.te(`settings.redesign.interface.${key}`);
  const activePreset = detectIfacePreset(cfg);

  // ── Ready-made looks (the values live in IFACE_PRESETS) ──
  const presetCards = Object.keys(IFACE_PRESETS).map(key => `
    <div class="gfx-preset-card${activePreset === key ? ' active' : ''}" data-iface-preset="${key}" role="radio" tabindex="0" aria-checked="${activePreset === key ? 'true' : 'false'}" data-stg-checked="active">
      <span class="gfx-preset-name">${u(`preset.${key}.label`)}</span>
      <span class="gfx-preset-desc">${u(`preset.${key}.desc`)}</span>
    </div>
  `).join('');

  const swatchColor = `hsl(${cfg.accentHue}, ${cfg.accentSaturation}%, ${cfg.accentLightness}%)`;

  return `
      <div class="stg-pane" data-stg-pane="interface">

        ${kit.card({
          id: 'stg-sec-presets', section: 'appearance.appearance_presets',
          body: `
          <div class="gfx-presets" id="iface-preset-cards" ${kit.inv('UI016')} role="radiogroup" aria-label="${kit.L('UI016')}" aria-describedby="iface-preset-cards-help">
            ${presetCards}
          </div>
          ${kit.help('UI016', { forId: 'iface-preset-cards' })}`,
        })}

        ${kit.card({
          id: 'stg-sec-size', section: 'appearance.size_style',
          body: `
          <div class="gfx-row" ${kit.inv('UI001')}>
            <label class="gfx-label" for="iface-scale">${kit.L('UI001')}</label>
            <input type="range" id="iface-scale" data-iface-key="scale" min="0.5" max="1.5" step="0.01" value="${cfg.scale}" aria-describedby="iface-scale-help">
            <input type="number" id="ui-scale-val" class="gfx-val gfx-val-input" ${kit.inv('UI002')} min="50" max="150" step="1" value="${Math.round(cfg.scale * 100)}" aria-label="${kit.L('UI002')}" title="${kit.H('UI002')}">
            <span class="gfx-val" style="pointer-events:none;margin-left:-2px;min-width:auto" aria-hidden="true">%</span>
          </div>
          ${kit.help('UI001', { forId: 'iface-scale' })}
          <div class="stg-field iface-reset-wrap" ${kit.inv('UI015')} style="margin-top:14px">
            <button type="button" class="gfx-reset-btn" id="iface-reset" aria-describedby="iface-reset-help">${kit.L('UI015')}</button>
            ${kit.help('UI015', { forId: 'iface-reset' })}
          </div>`,
        })}

        ${kit.card({
          id: 'stg-sec-accent', section: 'appearance.accent_color',
          body: `
          <div class="iface-accent-header" ${kit.inv('UI017')}>
            <div class="iface-accent-swatch" id="iface-accent-swatch" style="background:${swatchColor}" role="img" aria-label="${kit.L('UI017')}"></div>
            <div class="iface-accent-info">
              <span class="label">${u('accent')}</span>
              <span class="value" id="iface-accent-hex">${swatchColor}</span>
            </div>
          </div>
          ${ifaceSliderRow('UI011', 'accentHue', 0, 360, 1, 0, cfg.accentHue)}
          ${ifaceSliderRow('UI012', 'accentSaturation', 0, 100, 1, 0, cfg.accentSaturation)}
          ${ifaceSliderRow('UI013', 'accentLightness', 20, 80, 1, 0, cfg.accentLightness)}`,
        })}

        ${kit.card({
          id: 'stg-sec-visualization', section: 'appearance.visualization',
          body: kit.toggleField('UI014', kit.switchInput('iface-viz-toggle', { checked: cfg.visualizationEnabled !== false }), { forId: 'iface-viz-toggle' }),
        })}

        ${kit.card({
          id: 'stg-sec-visual-tuning', section: 'appearance.advanced_visual_tuning', collapsible: true, collapsed: true, advanced: true,
          body: `
          ${kit.subhead(u('sub.glass'))}
          ${ifaceSliderRow('UI003', 'glassOpacity', 0, 1, 0.01, 2, cfg.glassOpacity)}
          ${ifaceSliderRow('UI004', 'glassBlur', 0, 80, 1, 0, cfg.glassBlur)}
          ${ifaceSliderRow('UI005', 'glassSaturate', 0.5, 2.5, 0.1, 1, cfg.glassSaturate)}
          ${ifaceSliderRow('UI006', 'glassBorderOpacity', 0, 0.3, 0.01, 2, cfg.glassBorderOpacity)}
          ${kit.subhead(u('sub.shadows'))}
          ${ifaceSliderRow('UI007', 'glassShadowOpacity', 0, 1, 0.01, 2, cfg.glassShadowOpacity)}
          ${ifaceSliderRow('UI008', 'glassShadowSpread', 0, 60, 1, 0, cfg.glassShadowSpread)}
          ${kit.subhead(u('sub.shape'))}
          ${ifaceSliderRow('UI009', 'glassRadius', 0, 30, 1, 0, cfg.glassRadius)}
          ${ifaceSliderRow('UI010', 'fontScale', 0.7, 1.5, 0.01, 2, cfg.fontScale)}
          <div class="stg-help">${u('tuningHelp')}</div>`,
        })}

      </div>`;
}

/** Detect which preset matches the current config (or null) */
function detectIfacePreset(cfg) {
  for (const [key, preset] of Object.entries(IFACE_PRESETS)) {
    const vals = preset.values;
    const matches = Object.keys(vals).every(k => {
      const a = cfg[k], b = vals[k];
      return Math.abs(a - b) < 0.001;
    });
    if (matches) return key;
  }
  return null;
}

// ═══════════════════════════════════════════
// ICONS TAB — builder + interaction
// ═══════════════════════════════════════════

// Known special filenames for the icon grid
const SPECIAL_FILENAMES = [
  'dockerfile', 'makefile', '.gitignore', '.env', 'readme', 'changelog', 'license',
];

function buildIconsTab(customIcons = {}) {
  const exts = Object.keys(FI_MAP);
  const hasAny = Object.keys(customIcons.extensions || {}).length > 0 || Object.keys(customIcons.filenames || {}).length > 0;
  const c = (key, params) => kit.te(`settings.redesign.icons.${key}`, params);
  // One file type: click (or Enter) to pick a replacement; × restores the original.
  const card = (type, key, label, preview, hasCustom) => `<div class="icon-card${hasCustom ? ' has-custom' : ''}" data-icon-type="${type}" data-icon-key="${key}" role="button" tabindex="0" aria-label="${c('change', { name: label })}">
      <div class="icon-card-preview">${preview}</div>
      <span class="icon-card-label">${label}</span>
      ${hasCustom ? `<span class="icon-card-badge">${c('custom')}</span><button type="button" class="icon-card-reset" data-reset-type="${type}" data-reset-key="${key}" ${kit.inv('ICO004')} aria-label="${kit.L('ICO004')}" title="${kit.L('ICO004')}">&times;</button>` : ''}
    </div>`;

  let cards = '';

  // Extension cards
  for (const ext of exts) {
    const info = FI_MAP[ext];
    const custom = customIcons.extensions?.[ext];
    const preview = custom
      ? `<img src="/custom-icons/${escapeHtml(custom.path)}?t=${Date.now()}" alt="">`
      : `<span class="fe-icon" style="color:${info.c || 'rgba(255,255,255,0.4)'}"><span style="display:flex;align-items:center;justify-content:center;width:24px;height:24px">${FI[info.i]}</span></span>`;
    cards += card('ext', ext, `.${ext}`, preview, !!custom);
  }

  // Special filename cards
  for (const fname of SPECIAL_FILENAMES) {
    const custom = customIcons.filenames?.[fname];
    const fi = getFileIcon(fname);
    const preview = custom
      ? `<img src="/custom-icons/${escapeHtml(custom.path)}?t=${Date.now()}" alt="">`
      : fi.img
        ? `<img src="${fi.img}" alt="">`
        : `<span class="fe-icon" style="color:${fi.color || 'rgba(255,255,255,0.4)'}"><span style="display:flex;align-items:center;justify-content:center;width:24px;height:24px">${fi.svg}</span></span>`;
    cards += card('name', fname, fname, preview, !!custom);
  }

  return `
    <div class="stg-pane" data-stg-pane="icons">
      ${kit.card({
        id: 'stg-sec-file-icons', section: 'appearance.file_icons',
        body: `
      <div class="stg-field" ${kit.inv('ICO001')}>
        <label for="icon-filter-input">${kit.L('ICO001')}</label>
        <div class="icon-filter-bar">
          <input type="text" id="icon-filter-input" placeholder="${c('filterPlaceholder')}" autocomplete="off" spellcheck="false" aria-describedby="icon-filter-input-help">
          ${hasAny ? `<button type="button" class="stg-action-btn compact" id="icon-reset-all" ${kit.inv('ICO005')} title="${kit.H('ICO005')}" style="flex:0 0 auto;white-space:nowrap">${kit.L('ICO005')}</button>` : ''}
        </div>
        ${kit.help('ICO001', { forId: 'icon-filter-input' })}
      </div>
      <div class="icon-grid" ${kit.inv('ICO003')} role="group" aria-label="${kit.L('ICO003')}" data-stg-data>${cards}</div>
      <input type="file" id="icon-upload-input" ${kit.inv('ICO002')} accept=".png,.svg,.jpg,.jpeg,.webp" style="display:none" aria-label="${kit.L('ICO002')}">`,
      })}
    </div>`;
}

function wireIconsTab(panel, customIcons) {
  let _pendingType = null;
  let _pendingKey = null;

  const fileInput = panel.querySelector('#icon-upload-input');
  const filterInput = panel.querySelector('#icon-filter-input');
  const resetAllBtn = panel.querySelector('#icon-reset-all');

  // Card click → open file picker
  panel.querySelectorAll('.icon-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.icon-card-reset')) return; // let reset handler fire
      _pendingType = card.dataset.iconType;
      _pendingKey = card.dataset.iconKey;
      if (fileInput) { fileInput.value = ''; fileInput.click(); }
    });
  });

  // File selected → upload
  if (fileInput) {
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file || !_pendingType || !_pendingKey) return;

      const ct = file.type || 'application/octet-stream';
      try {
        const buf = await file.arrayBuffer();
        const resp = await fetch(`/api/file-icons/${_pendingType}/${_pendingKey}`, {
          method: 'POST',
          headers: { 'Content-Type': ct, 'X-Original-Name': file.name },
          body: buf,
        });
        const data = await resp.json();
        if (data.ok) {
          emit('sync:icons:changed');
          refreshIconsTab(panel);
        } else {
          showCCToast(data.error || kit.tx('settings.redesign.icons.uploadFailed'));
        }
      } catch (err) {
        showCCToast(kit.tx('settings.redesign.icons.uploadFailed2', { message: err.message }));
      }
    });
  }

  // Reset single icon
  panel.querySelectorAll('.icon-card-reset').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const type = btn.dataset.resetType;
      const key = btn.dataset.resetKey;
      try {
        const resp = await fetch(`/api/file-icons/${type}/${key}`, { method: 'DELETE' });
        const data = await resp.json();
        if (data.ok) {
          emit('sync:icons:changed');
          refreshIconsTab(panel);
        }
      } catch {}
    });
  });

  // Reset all
  if (resetAllBtn) {
    resetAllBtn.addEventListener('click', async () => {
      try {
        const resp = await fetch('/api/file-icons', { method: 'DELETE' });
        const data = await resp.json();
        if (data.ok) {
          emit('sync:icons:changed');
          refreshIconsTab(panel);
          showCCToast(kit.tx('settings.redesign.icons.allCustomIconsReset'));
        }
      } catch {}
    });
  }

  // Filter
  if (filterInput) {
    filterInput.addEventListener('input', () => {
      const q = filterInput.value.toLowerCase().trim();
      panel.querySelectorAll('.icon-card').forEach(card => {
        const key = card.dataset.iconKey || '';
        card.style.display = !q || key.includes(q) ? '' : 'none';
      });
    });
  }
}

async function refreshIconsTab(panel) {
  try {
    const resp = await fetch('/api/file-icons').then(r => r.json());
    if (!resp.ok) return;
    const tabBody = kit.paneOf(panel, 'icons');
    if (!tabBody) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = buildIconsTab(resp.custom);
    const newBody = kit.paneOf(tmp, 'icons');
    if (newBody) {
      tabBody.innerHTML = newBody.innerHTML;
      wireIconsTab(panel, resp.custom);
    }
  } catch {}
}

function activateSettingsTab(overlay, tabId = DEFAULT_SETTINGS_PAGE, { remember = true } = {}) {
  // Old tab ids resolve to the page that took them over.
  const pageId = resolveSettingsTarget({ tab: tabId }).tab;
  const nav = overlay.querySelector(`.settings-nav-item[data-tab="${pageId}"]`);
  const body = overlay.querySelector(`.settings-content > .settings-tab-body[data-tab="${pageId}"]`);
  if (!nav || !body) return false;
  const changed = !body.classList.contains('active');

  overlay.querySelectorAll('.settings-nav-item').forEach(n => { n.classList.remove('active'); n.removeAttribute('aria-current'); });
  overlay.querySelectorAll('.settings-content > .settings-tab-body').forEach(b => b.classList.remove('active'));
  nav.classList.add('active');
  nav.setAttribute('aria-current', 'page');
  body.classList.add('active');
  const picker = overlay.querySelector('#stg-page-select');
  if (picker) picker.value = pageId;
  if (changed) {
    const content = overlay.querySelector('.settings-content');
    if (content) content.scrollTop = 0;
  }
  if (remember) storage.setItem(KEYS.SETTINGS_LAST_PAGE, pageId);
  // Panes that load on demand listen for this instead of a nav click.
  overlay.dispatchEvent(new CustomEvent('stg-page-change', { detail: { page: pageId } }));
  return true;
}

/** The element a deep link names: an id in the markup, or a control's inventory id (GEN001 …) in the section that holds it. */
function findSettingsTarget(overlay, id) {
  if (!id) return null;
  let el = null;
  try { el = overlay.querySelector(`#${CSS.escape(id)}`); } catch {}
  if (el) return el;
  const home = homeOfControl(id);
  if (!home) return null;
  const all = [...overlay.querySelectorAll(`.settings-content [data-stg-id="${id}"]`)];
  const section = home.section ? overlay.querySelector(`#${CSS.escape(home.section)}`) : null;
  // A control that only exists after a click (the Add project form, a theme's buttons) lands on its section.
  return all.find(node => !section || section.contains(node)) || all[0] || section;
}

const SETTINGS_ROW = '.stg-field, .stg-toggle-field, .settings-field, .cc-integration-item, .cc-tool-category-header, .cli-path-field, .cc-skill-row, .ocp-danger-row, .stg-provider-card, .cc-panel, .gfx-row, .recall-control-row, .wa-row, .stg-setup-actions, .stg-action-row, .project-storage-toolbar, .browser-cfg-checkbox, details:not(.stg-advanced)';

/** What a link to `el` scrolls to and lights up: a small control stands for the row it sits in. */
function settingsTargetRow(el) {
  if (!el || !el.matches('button, input, select, textarea, a, span, label')) return el;
  const row = el.closest(SETTINGS_ROW);
  const card = el.closest('[data-stg-section]');
  return row && (!card || (card !== row && card.contains(row))) ? row : el;
}

const SETTINGS_HEADING = '.stg-subhead, .stg-mcp-form-label, .stg-mcp-section-header, summary, legend';

/**
 * `el`, or what stands in for it while its pane keeps it hidden (a field of a mode the form is not in, the options
 * of a switch that is off: only a value the user chooses would show it, and a landing changes no value). In order:
 * the control that switches the mode, when the hidden block names it (data-stg-shown-by); the heading or row just
 * before it in the nearest thing around it that is on screen, else that thing's first one; the thing itself when it
 * is small; the header of the card around it. A row or a heading: never a block taller than the scroll area.
 */
function shownSettingsTarget(overlay, el) {
  const shown = (node) => !!node && node.getClientRects().length > 0 && node.getBoundingClientRect().height > 0;
  if (!el || shown(el)) return el;
  let box = el;
  let switcher = null;
  while (box && box !== overlay && !shown(box) && box.parentElement) {
    if (!switcher && box.dataset?.stgShownBy) { try { switcher = overlay.querySelector(box.dataset.stgShownBy); } catch {} }
    box = box.parentElement;
  }
  if (!box || box === overlay) return el;
  const switchRow = switcher && settingsTargetRow(switcher);
  if (shown(switchRow)) return switchRow;
  const room = overlay.querySelector('.settings-content')?.clientHeight || Infinity;
  const fits = (node) => shown(node) && node.getBoundingClientRect().height <= room;
  const inside = [...box.querySelectorAll(`${SETTINGS_HEADING}, ${SETTINGS_ROW}`)].filter(fits);
  const before = inside.filter(node => node.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
  if (inside.length) return before[before.length - 1] || inside[0];
  for (let node = box; node && node !== overlay; node = node.parentElement) {
    if (fits(node)) return node;
    const head = node.matches('.stg-card') ? node.querySelector(':scope > .stg-card-head') : null;
    if (fits(head)) return head;
  }
  return box;
}

function flashSettingsTarget(el) {
  clearTimeout(el._stgFlash);
  el.classList.remove('settings-focus-target');
  void el.offsetWidth; // restart the highlight when the same target is asked for again
  el.classList.add('settings-focus-target');
  el._stgFlash = setTimeout(() => el.classList.remove('settings-focus-target'), 2600);
}

/**
 * Apply `{ tab, expand, highlight, scrollTo }`. Old tab and section ids are
 * accepted (settings-ia.js resolves them), and `highlight` / `scrollTo` also take
 * a control's inventory id. `quiet` re-applies only `expand`: the shell calls it
 * once more after the wiring, so a deep link wins over anything a pane collapsed
 * while it wired itself. Returns the element the link landed on.
 */
function applySettingsOpenOptions(overlay, options = {}, { quiet = false } = {}) {
  if (!overlay || !options) return null;
  const target = resolveSettingsTarget(options);
  const find = (id) => findSettingsTarget(overlay, id);

  if (target.tab && !quiet) activateSettingsTab(overlay, target.tab);
  // What this link opens, kept for a pane that sets its own disclosure once its data arrives (settingsRevealRequested).
  if (!quiet) overlay._stgRevealRequested = [...new Set([...target.expand, ...target.highlight, target.scrollTo].filter(Boolean))];

  for (const id of target.expand) {
    const section = find(id);
    if (section) revealSettingsTarget(overlay, section);
  }
  if (quiet) return null;

  overlay.querySelectorAll('.settings-focus-target').forEach(el => {
    el.classList.remove('settings-focus-target');
  });

  for (const id of target.highlight) {
    const section = settingsTargetRow(find(id));
    if (!section) continue;
    revealSettingsTarget(overlay, section);
    flashSettingsTarget(shownSettingsTarget(overlay, section));
  }

  let scrollTarget = (target.scrollTo && settingsTargetRow(find(target.scrollTo))) || (target.pane ? kit.paneOf(overlay, target.pane) : null);
  if (scrollTarget) {
    revealSettingsTarget(overlay, scrollTarget);
    scrollTarget = shownSettingsTarget(overlay, scrollTarget);
    // A link to an old tab lands on the section (or pane) that tab became; whatever opens the page needs no scroll.
    const page = scrollTarget.closest('.settings-tab-body');
    const firstPane = page?.querySelector('.stg-pane');
    const firstCard = page?.querySelector('[data-stg-section]');
    const atTop = scrollTarget === firstPane || (scrollTarget === firstCard && firstPane?.contains(firstCard) && !firstCard.previousElementSibling);
    // Lists further up the page load after this scroll and push the target away, so the shell keeps it in place for a while.
    if (options.scrollTo || !atTop) followSettingsTarget(overlay, scrollTarget, { block: options.scrollTo ? 'center' : 'start' });
  }
  return scrollTarget;
}

/** Did the deep link that opened this page ask for `section` (or something inside it) to be open? */
function settingsRevealRequested(overlay, section) {
  if (!section) return false;
  for (const id of overlay._stgRevealRequested || []) {
    const el = findSettingsTarget(overlay, id);
    if (el && section.contains(el)) return true;
  }
  return false;
}

let searchHitSeq = 0;
const RELAND_MS = 5000;

/**
 * The row a result found in the panel names, as the panel holds it now: the element it was read from, or, once its
 * pane has redrawn the list, the row with the same name in the same place. The result is updated to it, so a result
 * the list still shows lands on its row again and not on the section around it.
 */
function currentSearchRow(overlay, entry) {
  if (entry.ref && entry.ref.isConnected) return entry.ref;
  const again = collectSearchRows(overlay, SEARCH_ROW_SOURCES, SEARCH_OFF)
    .find(row => row.page === entry.page && row.title === entry.title && (!entry.section || row.section === entry.section));
  if (!again) return null;
  entry.ref = again.ref;
  return again.ref;
}

/** The row a search result lands on, as the panel holds it now (nothing is opened or scrolled). */
function locateSearchEntry(overlay, entry) {
  if (entry.kind === 'row') return currentSearchRow(overlay, entry);
  return settingsTargetRow(findSettingsTarget(overlay, entry.control || entry.section));
}

/**
 * A pane may redraw its list when its page is shown (providers, added servers, profiles), which replaces the
 * row a result just landed on. For a few seconds the row is looked for again by its name and landed on once more.
 * It lets go for good as soon as the user scrolls, clicks or types: a redraw after that must not pull the view back.
 */
function relandRedrawnRow(overlay, entry, el, focus) {
  const content = overlay.querySelector('.settings-content');
  if (!content || !el || typeof MutationObserver !== 'function') return;
  let offTakeover = () => {};
  const stop = () => {
    watcher.disconnect();
    clearTimeout(timer);
    offTakeover();
    overlay.removeEventListener('stg-page-change', stop);
    overlay.removeEventListener('settings-close', stop);
    if (overlay._stgRelandStop === stop) overlay._stgRelandStop = null;
  };
  const watcher = new MutationObserver(() => {
    if (el.isConnected) return;
    if (!currentSearchRow(overlay, entry)) return; // not drawn again yet: the next change is looked at
    stop();
    const lostFocus = !document.activeElement || document.activeElement === document.body;
    landOnSearchEntry(overlay, entry, { focus: focus && lostFocus, watch: false });
  });
  const timer = setTimeout(stop, RELAND_MS);
  watcher.observe(content, { subtree: true, childList: true });
  offTakeover = onSettingsTakeover(overlay, stop);
  overlay.addEventListener('stg-page-change', stop);
  overlay.addEventListener('settings-close', stop);
  overlay._stgRelandStop = stop;
}

/**
 * Show a search result through the deep-link machinery: its page, its section opened without remembering it,
 * the row in view and lit. `focus` hands the keyboard to what was landed on (a row, a section's header, the
 * page title), so the setting is one Tab away.
 */
function landOnSearchEntry(overlay, entry, { focus = false, watch = true } = {}) {
  overlay._stgRelandStop?.();
  const options = { ...entry.target };
  let rowEl = null;
  if (entry.kind === 'row') {
    // A row found in the panel has no id of its own: it gets one when it is chosen. A row its pane has since
    // redrawn is looked for by its name; only one that is gone lands on its section.
    rowEl = currentSearchRow(overlay, entry);
    if (rowEl && !rowEl.id) rowEl.id = `stg-hit-${++searchHitSeq}`;
    const id = rowEl ? rowEl.id : entry.section;
    if (id) { options.highlight = [id]; options.scrollTo = id; }
  }
  let landed = applySettingsOpenOptions(overlay, options);
  if (rowEl && watch) relandRedrawnRow(overlay, entry, rowEl, focus);
  if (entry.kind === 'page') {
    overlay._stgFollowStop?.();
    const content = overlay.querySelector('.settings-content');
    if (content) content.scrollTop = 0;
    landed = overlay.querySelector('.settings-content > .settings-tab-body.active .stg-page-title');
  }
  if (!focus || !landed) return landed;
  const to = (landed.matches('.stg-acc[data-collapsible]') && landed.querySelector(':scope > .stg-card-head')) || landed;
  if (!to.matches('a[href], button, input, select, textarea, summary, [tabindex]')) to.setAttribute('tabindex', '-1');
  try { to.focus({ preventScroll: true }); } catch {}
  return landed;
}

// ═══════════════════════════════════════════
// MAIN ENTRY — openSettingsModal
// ═══════════════════════════════════════════

export async function openSettingsModal(options = {}) {
  // If already open, just bring it to front
  const existing = document.getElementById('settings-panel');
  if (existing) {
    existing.style.zIndex = '300001';
    applySettingsOpenOptions(existing, options);
    return;
  }

  // Every label below comes from i18n. The app loads it at boot; a page that did not (a test harness, an embed) gets it here.
  if (!i18nReady()) await initI18n();

  // ── Fetch all data in parallel ──
  let settings = {};
  let connections = [];
  let ccIntegrations = { global: { installed: false }, projects: [] };
  let ccSkills = [];
  let tunnelStatus = { available: false, running: false, url: null };
  let mcpKeyInfo = { hasKey: false };
  let _bridgeResult = null;
  let greetingConfig = { defaults: {}, projects: {}, global: {} };
  let codexGreetingConfig = { enabled: true, defaults: {}, projects: {}, global: {} };
  let opencodeGreetingConfig = { enabled: false, defaults: {}, projects: {}, global: {} };
  let setupStatus = { claude: {}, gemini: {}, codex: {}, opencode: {}, paths: {} };
  let cliConfig = {};
  let toolPermissions = {};
  let toolCategories = [];
  let discordConfig = {};
  let skinsData = { skins: [], active: 'default' };
  let customIconsData = { extensions: {}, filenames: {} };
  let youtubeConfig = { secrets: {}, configured: {}, pipeline: {} };
  let typesafeConfig = null;

  try {
    const [settingsRes, connRes, ccRes, skillsRes, tunnelRes, keyRes, bridgeRes, greetRes, codexGreetRes, opencodeGreetRes, setupRes, cliRes, toolPermsRes, toolCatsRes, discordRes, skinsRes, iconsRes, youtubeRes, typesafeRes] = await Promise.allSettled([
      fetch('/api/settings').then(r => r.json()),
      fetch('/api/connections').then(r => r.json()),
      fetch('/api/claude-code/integrations').then(r => r.json()),
      fetch('/api/claude-code/skills').then(r => r.json()),
      fetch('/api/tunnel/status').then(r => r.json()),
      fetch('/api/mcp-key').then(r => r.json()),
      fetch('/api/bridges/openclaw').then(r => r.json()),
      fetch('/api/greeting/config').then(r => r.json()),
      fetch('/api/codex-panel/greeting/config').then(r => r.json()),
      fetch('/api/opencode-panel/greeting/config').then(r => r.json()),
      fetch('/api/setup/status').then(r => r.json()),
      fetch('/api/cli/config').then(r => r.json()),
      fetch('/api/claude-code/tool-permissions').then(r => r.json()),
      fetch('/api/claude-code/tool-categories').then(r => r.json()),
      fetch('/api/discord/config').then(r => r.json()),
      fetch('/api/skins').then(r => r.json()),
      fetch('/api/file-icons').then(r => r.json()),
      fetch('/api/youtube/config').then(r => r.json()),
      fetch('/api/typesafe/config').then(r => r.json()),
    ]);
    if (typesafeRes.status === 'fulfilled' && typesafeRes.value.ok) typesafeConfig = typesafeRes.value;
    if (settingsRes.status === 'fulfilled') settings = settingsRes.value;
    if (connRes.status === 'fulfilled' && connRes.value.connections) connections = connRes.value.connections;
    if (ccRes.status === 'fulfilled' && ccRes.value.ok) ccIntegrations = ccRes.value;
    if (skillsRes.status === 'fulfilled' && skillsRes.value.ok) ccSkills = skillsRes.value.skills || [];
    if (tunnelRes.status === 'fulfilled' && tunnelRes.value.ok) tunnelStatus = tunnelRes.value;
    if (keyRes.status === 'fulfilled' && keyRes.value.ok) mcpKeyInfo = keyRes.value;
    if (bridgeRes.status === 'fulfilled' && bridgeRes.value.ok) _bridgeResult = bridgeRes.value;
    if (greetRes.status === 'fulfilled' && greetRes.value.ok) greetingConfig = greetRes.value.config;
    if (codexGreetRes.status === 'fulfilled' && codexGreetRes.value.ok) codexGreetingConfig = codexGreetRes.value.config;
    if (opencodeGreetRes.status === 'fulfilled' && opencodeGreetRes.value.ok) opencodeGreetingConfig = opencodeGreetRes.value.config;
    if (setupRes.status === 'fulfilled' && setupRes.value.ok) setupStatus = setupRes.value;
    if (cliRes.status === 'fulfilled' && cliRes.value.ok) cliConfig = cliRes.value.config;
    if (toolPermsRes.status === 'fulfilled' && toolPermsRes.value.ok) toolPermissions = toolPermsRes.value.tools;
    if (toolCatsRes.status === 'fulfilled' && toolCatsRes.value.ok) toolCategories = toolCatsRes.value.categories;
    if (discordRes.status === 'fulfilled' && discordRes.value.ok) discordConfig = discordRes.value.config;
    if (skinsRes.status === 'fulfilled' && skinsRes.value.ok) skinsData = skinsRes.value;
    if (iconsRes.status === 'fulfilled' && iconsRes.value.ok) customIconsData = iconsRes.value.custom;
    if (youtubeRes.status === 'fulfilled' && youtubeRes.value.ok) youtubeConfig = youtubeRes.value;
  } catch {}
  let openclawBridge = _bridgeResult || { enabled: false };

  // ── Gather variant-registered settings tabs ──
  const variantTabs = getSettingsTabs();

  // ── Which page opens: the one asked for, else the last one used, else the first ──
  const initialPage = getSettingsPage(resolveSettingsTarget(options).tab)?.id
    || getSettingsPage(storage.getItem(KEYS.SETTINGS_LAST_PAGE))?.id
    || DEFAULT_SETTINGS_PAGE;
  const openerEl = document.activeElement;

  // ── Panel ──
  const overlay = document.createElement('div');
  overlay.className = 'settings-panel glass resizable';
  overlay.id = 'settings-panel';

  // Always open centered at default size
  overlay.style.left = Math.max(20, (window.innerWidth - 900) / 2) + 'px';
  overlay.style.top = Math.max(48, (window.innerHeight - 650) / 2) + 'px';

  // ── Assemble HTML ──
  overlay.innerHTML = `
    <div class="resize-handle resize-handle-t" data-resize="t"></div>
    <div class="resize-handle resize-handle-b" data-resize="b"></div>
    <div class="resize-handle resize-handle-l" data-resize="l"></div>
    <div class="resize-handle resize-handle-r" data-resize="r"></div>
    <div class="resize-handle resize-handle-tl" data-resize="tl"></div>
    <div class="resize-handle resize-handle-tr" data-resize="tr"></div>
    <div class="resize-handle resize-handle-bl" data-resize="bl"></div>
    <div class="resize-handle resize-handle-br" data-resize="br"></div>
    <div class="settings-panel-header drag-handle" data-drag="settings-panel">
      <div class="stg-header-left">
        <h3 id="stg-title">${kit.te('settings.title')}</h3>
      </div>
      <button type="button" class="backdrop-toggle-btn" id="stg-backdrop-toggle" ${kit.inv('SH002')} data-tooltip="${kit.L('SH002')}" aria-label="${kit.L('SH002')}" aria-pressed="false">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
      </button>
      <button type="button" class="settings-panel-close" id="stg-close" ${kit.inv('SH003')} data-tooltip="${kit.L('SH003')}" aria-label="${kit.L('SH003')}">&times;</button>
    </div>
    <div class="settings-panel-body">
      <div class="stg-sidebar">
        ${buildSearchHTML()}
        <nav class="settings-nav" aria-label="${kit.te('settings.redesign.common.navLabel')}" ${kit.inv('SH005')}>
          ${buildNavHTML(initialPage)}
        </nav>
      </div>
      <div class="stg-main">
        ${buildPagePickerHTML(initialPage)}
        <div class="settings-content">
          ${buildPagesHTML({
            server: buildServerTab(settings, connections),
            hooks: buildConnectionsTab(ccIntegrations, ccSkills, tunnelStatus, mcpKeyInfo, openclawBridge, greetingConfig, codexGreetingConfig, opencodeGreetingConfig, toolPermissions, toolCategories),
            terminal: buildTerminalTab(cliConfig),
            opencode: buildOpencodeTab(),
            notifications: buildNotificationsTab(),
            browser: buildBrowserTab(),
            mcp: buildMcpTab(),
            setup: buildSetupTab(setupStatus),
            collections: buildCollectionsTab(connections, settings),
            projects: buildProjectsTab(ccIntegrations),
            memory: buildMemoryTab(),
            judgments: buildJudgmentsTab(),
            skills: buildSkillsTab(ccSkills),
            discord: buildDiscordTab(discordConfig),
            whatsapp: buildWhatsAppTab(),
            morelogin: buildMoreLoginTab(),
            permissions: buildPermissionsTab(toolCategories, toolPermissions),
            social: buildSocialTab(toolCategories, toolPermissions),
            youtube: buildYoutubeTab(youtubeConfig),
            language: buildLanguageTab(),
            skins: buildSkinsTab(skinsData.skins, skinsData.active),
            interface: buildInterfaceTab(),
            icons: buildIconsTab(customIconsData),
          }, variantTabs, initialPage)}
        </div>
      </div>
    </div>
  `;

  // ── Backdrop ──
  const backdrop = document.createElement('div');
  backdrop.className = 'studio-backdrop';
  // Backdrop click disabled — close only via ESC or close button
  document.body.appendChild(backdrop);

  // Every section opens the way the user left it (first use: the first section of each page); a deep link opens its own below.
  applyStoredSections(overlay);
  document.body.appendChild(overlay);
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-labelledby', 'stg-title');

  // ── Nav status dots (Judgments and WhatsApp update theirs as they wire) ──
  kit.setNavStatus(overlay, 'server', settings.storage === 'sqlite' ? 'connected' : 'disconnected');
  kit.setNavStatus(overlay, 'setup', (setupStatus.claude?.connected || setupStatus.gemini?.connected || setupStatus.codex?.connected || setupStatus.opencode?.connected) ? 'connected' : 'disconnected');
  kit.setNavStatus(overlay, 'discord', discordConfig.botToken ? 'connected' : 'disconnected');
  kit.setNavStatus(overlay, 'judgments', (typesafeConfig && typesafeConfig.enabled) ? 'connected' : 'disconnected');

  // ── Open animation (matches Skills/Automation Studio) ──
  requestAnimationFrame(() => { backdrop.classList.add('open'); overlay.classList.add('open'); });

  // ── ESC key to close ──
  // A query in the search field goes first: Escape empties it and brings the page list back (wireSettingsSearch),
  // and closes Settings only once the field is empty.
  const onSettingsEsc = (e) => {
    if (e.key !== 'Escape') return;
    if (overlay._stgSearchEscape?.()) { e.preventDefault(); return; }
    close(); document.removeEventListener('keydown', onSettingsEsc);
  };
  document.addEventListener('keydown', onSettingsEsc);

  // ── Close helper ──
  const close = () => {
    document.removeEventListener('keydown', onSettingsEsc);
    // Tabs that poll (Judgments) clear their timers on this event.
    overlay.dispatchEvent(new CustomEvent('settings-close'));
    backdrop.remove();
    overlay.remove();
    // Give the keyboard back to whatever opened Settings.
    if (openerEl && openerEl !== document.body && document.body.contains(openerEl)) { try { openerEl.focus({ preventScroll: true }); } catch {} }
  };

  // ── Nav switching ──
  overlay.querySelectorAll('.settings-nav-item').forEach(nav => {
    nav.addEventListener('click', () => {
      activateSettingsTab(overlay, nav.dataset.tab);
    });
  });

  applySettingsOpenOptions(overlay, options);

  // ── Interface customization suite ──
  {
    let ifaceCfg = loadIfaceConfig();

    // Helper: update all slider displays + swatch from current config
    function syncIfaceUI() {
      overlay.querySelectorAll('input[data-iface-key]').forEach(slider => {
        const key = slider.dataset.ifaceKey;
        if (ifaceCfg[key] != null) slider.value = ifaceCfg[key];
      });
      // Update value labels
      for (const [, sliders] of Object.entries(IFACE_SLIDERS)) {
        for (const [key, , , , , decimals] of sliders) {
          const valEl = overlay.querySelector(`[data-iface-val="${key}"]`);
          if (valEl) valEl.textContent = Number(ifaceCfg[key]).toFixed(decimals);
        }
      }
      // Accent color labels
      for (const k of ['accentHue', 'accentSaturation', 'accentLightness']) {
        const valEl = overlay.querySelector(`[data-iface-val="${k}"]`);
        if (valEl) valEl.textContent = Math.round(ifaceCfg[k]);
      }
      // Scale number input
      const scaleNumEl = overlay.querySelector('#ui-scale-val');
      if (scaleNumEl) scaleNumEl.value = Math.round(ifaceCfg.scale * 100);
      // Accent swatch
      const swatch = overlay.querySelector('#iface-accent-swatch');
      const hexLabel = overlay.querySelector('#iface-accent-hex');
      const color = `hsl(${ifaceCfg.accentHue}, ${ifaceCfg.accentSaturation}%, ${ifaceCfg.accentLightness}%)`;
      if (swatch) swatch.style.background = color;
      if (hexLabel) hexLabel.textContent = color;
      // Visualization toggle checkbox
      const vizCb = overlay.querySelector('#iface-viz-toggle');
      if (vizCb) vizCb.checked = ifaceCfg.visualizationEnabled !== false;
      // Preset card active state
      const activePreset = detectIfacePreset(ifaceCfg);
      overlay.querySelectorAll('[data-iface-preset]').forEach(card => {
        card.classList.toggle('active', card.dataset.ifacePreset === activePreset);
      });
    }

    // Range sliders
    overlay.querySelectorAll('input[data-iface-key]').forEach(slider => {
      slider.addEventListener('input', () => {
        const key = slider.dataset.ifaceKey;
        ifaceCfg[key] = parseFloat(slider.value);
        applyIfaceConfig(ifaceCfg);
        saveIfaceConfig(ifaceCfg);
        syncIfaceUI();
      });
    });

    // Scale number input (special: percent ↔ decimal)
    const scaleNumInput = overlay.querySelector('#ui-scale-val');
    if (scaleNumInput) {
      scaleNumInput.addEventListener('change', () => {
        const pct = Math.max(50, Math.min(150, parseInt(scaleNumInput.value) || 100));
        scaleNumInput.value = pct;
        ifaceCfg.scale = pct / 100;
        applyIfaceConfig(ifaceCfg);
        saveIfaceConfig(ifaceCfg);
        syncIfaceUI();
      });
    }

    // Theme preset cards
    overlay.querySelectorAll('[data-iface-preset]').forEach(card => {
      card.addEventListener('click', () => {
        const presetKey = card.dataset.ifacePreset;
        const preset = IFACE_PRESETS[presetKey];
        if (!preset) return;
        ifaceCfg = { ...ifaceCfg, ...preset.values };
        applyIfaceConfig(ifaceCfg);
        saveIfaceConfig(ifaceCfg);
        syncIfaceUI();
      });
    });

    // Visualization toggle
    const vizToggle = overlay.querySelector('#iface-viz-toggle');
    if (vizToggle) {
      vizToggle.addEventListener('change', () => {
        ifaceCfg.visualizationEnabled = vizToggle.checked;
        applyIfaceConfig(ifaceCfg);
        saveIfaceConfig(ifaceCfg);
      });
    }

    // Reset button
    const resetBtn = overlay.querySelector('#iface-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        ifaceCfg = { ...IFACE_DEFAULTS };
        applyIfaceConfig(ifaceCfg);
        saveIfaceConfig(ifaceCfg);
        syncIfaceUI();
      });
    }
  }

  // ── Toggle visibility buttons (eye icon) ──
  overlay.querySelectorAll('.settings-toggle-vis').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = overlay.querySelector('#' + btn.dataset.target);
      if (!input) return;
      const isPassword = input.type === 'password';
      input.type = isPassword ? 'text' : 'password';
      btn.innerHTML = isPassword ? eyeOpen : eyeClosed;
    });
  });

  // ── Close handlers ──
  overlay.querySelector('#stg-close').addEventListener('click', close);

  // ── Backdrop toggle ──
  const stgBackdropToggle = overlay.querySelector('#stg-backdrop-toggle');
  if (stgBackdropToggle) {
    stgBackdropToggle.addEventListener('click', () => {
      backdrop.classList.toggle('backdrop-hidden');
      stgBackdropToggle.classList.toggle('active', backdrop.classList.contains('backdrop-hidden'));
      stgBackdropToggle.setAttribute('aria-pressed', backdrop.classList.contains('backdrop-hidden') ? 'true' : 'false');
    });
  }

  // ── Move Database handlers ──
  const moveBrowseBtn = overlay.querySelector('#stg-db-browse-btn');
  const moveBtn = overlay.querySelector('#stg-db-move-btn');

  if (moveBrowseBtn) {
    const dbBrowserEl = overlay.querySelector('#stg-db-browser');
    const dbPathInput = overlay.querySelector('#stg-db-path');

    async function loadDbDir(dirPath) {
      dbBrowserEl.style.display = 'block';
      dbBrowserEl.innerHTML = '<div style="padding:10px;color:var(--t-muted);font-size:12px">' + kit.te('settings.redesign.server.loading') + '</div>';
      try {
        const qs = dirPath ? `?path=${encodeURIComponent(dirPath)}` : '';
        const res = await fetch(`/api/browse-directory${qs}`);
        const data = await res.json();
        if (!data.ok) throw new Error(data.error);

        let html = '<div style="padding:6px 10px;font-size:11px;color:var(--t-muted);border-bottom:1px solid var(--s-medium);display:flex;align-items:center;justify-content:space-between">'
          + `<span style="font-family:'JetBrains Mono',monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(data.current)}</span>`
          + '<button id="stg-db-browse-select" style="flex:0 0 auto;padding:3px 10px;background:var(--accent-blue-bg);border:1px solid var(--accent-blue-border);color:var(--accent-blue);border-radius:4px;cursor:pointer;font-size:11px">' + kit.te('settings.redesign.server.select') + '</button>'
          + '</div>';
        html += '<div style="padding:4px 0">';
        if (data.parent) {
          html += `<div class="cc-browse-item" data-path="${escapeHtml(data.parent)}" style="padding:4px 10px;cursor:pointer;font-size:12px;display:flex;align-items:center;gap:6px;color:var(--t-muted)">`
            + '<svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:2"><polyline points="15 18 9 12 15 6"/></svg>'
            + '' + kit.te('settings.redesign.server.parent') + '</div>';
        }
        for (const d of data.directories) {
          html += `<div class="cc-browse-item" data-path="${escapeHtml(data.current + '/' + d)}" style="padding:4px 10px;cursor:pointer;font-size:12px;display:flex;align-items:center;gap:6px">`
            + '<svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
            + escapeHtml(d) + '</div>';
        }
        if (data.directories.length === 0 && !data.parent) {
          html += '<div style="padding:8px 10px;color:var(--t-muted);font-size:12px">' + kit.te('settings.redesign.server.noSubdirectories') + '</div>';
        }
        html += '</div>';
        dbBrowserEl.innerHTML = html;

        dbBrowserEl.querySelector('#stg-db-browse-select').addEventListener('click', () => {
          dbPathInput.value = data.current.replace(/\\/g, '/') + '/memory.db';
          dbBrowserEl.style.display = 'none';
        });

        dbBrowserEl.querySelectorAll('.cc-browse-item').forEach(item => {
          item.addEventListener('mouseenter', () => item.style.background = 'var(--s-medium)');
          item.addEventListener('mouseleave', () => item.style.background = '');
          item.addEventListener('click', () => loadDbDir(item.dataset.path));
        });
      } catch (err) {
        dbBrowserEl.innerHTML = `<div style="padding:10px;color:var(--accent-dim);font-size:12px">${kit.te('settings.redesign.server.error')} ${escapeHtml(err.message)}</div>`;
      }
    }

    moveBrowseBtn.addEventListener('click', () => {
      if (dbBrowserEl.style.display === 'block') {
        dbBrowserEl.style.display = 'none';
        return;
      }
      // Start browsing from current path's directory, or home
      const currentVal = (dbPathInput.value || '').trim();
      const startDir = currentVal ? currentVal.replace(/[/\\][^/\\]*$/, '') : '';
      loadDbDir(startDir);
    });
  }

  if (moveBtn) {
    moveBtn.addEventListener('click', async () => {
      const pathInput = overlay.querySelector('#stg-db-path');
      const newPath = (pathInput?.value || '').trim();
      const statusEl = overlay.querySelector('#stg-db-move-status');
      const cleanupEl = overlay.querySelector('#stg-db-move-cleanup');
      const hintEl = overlay.querySelector('#stg-db-hint');

      if (!newPath) return;

      // Extract directory from the path (user may type full path with memory.db or just a dir)
      const newDir = newPath.endsWith('memory.db') ? newPath.replace(/[/\\]memory\.db$/, '') : newPath;

      statusEl.style.display = 'flex';
      statusEl.innerHTML = '<div class="wiz-status-dot spin" style="display:inline-block"></div> ' + kit.te('settings.redesign.server.movingDatabase') + '';
      moveBtn.disabled = true;

      try {
        const res = await fetch('/api/settings/move-db', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newPath: newDir }),
        });
        const data = await res.json();

        if (data.ok) {
          statusEl.style.display = 'none';
          if (hintEl) hintEl.textContent = kit.tx('settings.redesign.server.movedSuccessfully');
          if (pathInput) pathInput.value = data.newDbPath;
          cleanupEl.style.display = 'block';
          cleanupEl.dataset.oldPath = data.oldDbPath;
        } else {
          statusEl.innerHTML = `<span style="color:var(--red)">${kit.te('settings.redesign.server.error')} ${data.error}</span>`;
          moveBtn.disabled = false;
        }
      } catch (err) {
        statusEl.innerHTML = `<span style="color:var(--red)">${kit.te('settings.redesign.server.error')} ${err.message}</span>`;
        moveBtn.disabled = false;
      }
    });

    // Delete old files
    const deleteOldBtn = overlay.querySelector('#stg-db-delete-old');
    if (deleteOldBtn) {
      deleteOldBtn.addEventListener('click', async () => {
        const cleanupEl = overlay.querySelector('#stg-db-move-cleanup');
        const oldPath = cleanupEl?.dataset.oldPath;
        if (!oldPath) return;
        deleteOldBtn.disabled = true;
        deleteOldBtn.textContent = kit.tx('settings.redesign.server.deleting');
        try {
          await fetch('/api/settings/move-db/cleanup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldPath }),
          });
        } catch {}
        cleanupEl.style.display = 'none';
      });
    }

    const keepOldBtn = overlay.querySelector('#stg-db-keep-old');
    if (keepOldBtn) {
      keepOldBtn.addEventListener('click', () => {
        const cleanupEl = overlay.querySelector('#stg-db-move-cleanup');
        if (cleanupEl) cleanupEl.style.display = 'none';
      });
    }
  }

  // ── Reindex handlers ──
  const reindexBtn = overlay.querySelector('#reindex-btn');
  const reindexCancelBtn = overlay.querySelector('#reindex-cancel-btn');

  let _reindexPoll = null;

  if (reindexBtn) {
    reindexBtn.addEventListener('click', async () => {
      const statusEl = overlay.querySelector('#reindex-status');
      const textEl = overlay.querySelector('#reindex-text');
      const barEl = overlay.querySelector('#reindex-bar');
      const summaryEl = overlay.querySelector('#reindex-summary');
      const dotEl = overlay.querySelector('#reindex-dot');

      try {
        const res = await fetch('/api/settings/reindex', { method: 'POST' });
        const data = await res.json();
        if (!data.ok) {
          if (textEl) textEl.textContent = kit.tx('settings.redesign.collections.error', { error: data.error });
          if (statusEl) statusEl.style.display = 'block';
          return;
        }

        reindexBtn.disabled = true;
        if (reindexCancelBtn) reindexCancelBtn.style.display = '';
        if (statusEl) statusEl.style.display = 'block';
        if (textEl) textEl.textContent = kit.tx('settings.redesign.collections.startingReindex');
        if (dotEl) dotEl.className = 'wiz-status-dot spin';

        _reindexPoll = setInterval(async () => {
          try {
            const sr = await fetch('/api/settings/reindex/status');
            const sd = await sr.json();

            if (!sd.running) {
              clearInterval(_reindexPoll);
              _reindexPoll = null;
              if (dotEl) dotEl.className = 'wiz-status-dot ' + (sd.cancelled ? 'yellow' : 'green');
              if (textEl) textEl.textContent = sd.cancelled ? kit.tx('settings.redesign.collections.reindexCancelled') : kit.tx('settings.redesign.collections.reindexComplete');
              if (barEl) barEl.style.width = sd.cancelled ? barEl.style.width : '100%';
              if (summaryEl) summaryEl.textContent = kit.tx('settings.redesign.collections.memoriesSessionChunksProcessedError', { completed: sd.completed, chunks: sd.chunks, errors: sd.errors, errors2: sd.errors !== 1 ? 's' : '' });
              reindexBtn.disabled = false;
              if (reindexCancelBtn) reindexCancelBtn.style.display = 'none';
              return;
            }

            const pct = sd.total > 0 ? Math.round((sd.completed / sd.total) * 100) : 0;
            if (textEl) textEl.textContent = kit.tx('settings.redesign.collections.processingMemories', { completed: sd.completed, total: sd.total });
            if (barEl) barEl.style.width = `${pct}%`;
            if (summaryEl) summaryEl.textContent = kit.tx(sd.errors === 1 ? 'settings.redesign.collections.sessionChunksProgress.one' : 'settings.redesign.collections.sessionChunksProgress.other', { chunks: sd.chunks, total: sd.totalChunks, errors: sd.errors });
          } catch {}
        }, 800);
      } catch (err) {
        if (textEl) textEl.textContent = kit.tx('settings.redesign.collections.error2', { message: err.message });
        if (statusEl) statusEl.style.display = 'block';
      }
    });
  }

  if (reindexCancelBtn) {
    reindexCancelBtn.addEventListener('click', async () => {
      reindexCancelBtn.disabled = true;
      const textEl = overlay.querySelector('#reindex-text');
      if (textEl) textEl.textContent = kit.tx('settings.redesign.collections.cancelling');
      try {
        await fetch('/api/settings/reindex/cancel', { method: 'POST' });
      } catch {}
    });
  }

  // ── System Backup & Restore handlers ──

  const backupBtn = overlay.querySelector('#sys-backup-btn');
  const restoreBtn = overlay.querySelector('#sys-restore-btn');
  const restoreFileInput = overlay.querySelector('#sys-restore-file');

  if (backupBtn) {
    backupBtn.addEventListener('click', async () => {
      const statusEl = overlay.querySelector('#sys-backup-status');
      const statusDot = overlay.querySelector('#sys-backup-dot');
      const statusText = overlay.querySelector('#sys-backup-text');

      backupBtn.disabled = true;
      const origHTML = backupBtn.innerHTML;
      backupBtn.textContent = kit.tx('settings.redesign.server.creatingBackup');
      statusEl.style.display = 'flex';
      statusDot.className = 'wiz-status-dot spin';
      statusText.textContent = kit.tx('settings.redesign.server.collectingFilesAndCreatingDatabaseBackup');

      try {
        const res = await fetch('/api/system/backup');
        if (!res.ok) {
          let errMsg = kit.tx('settings.redesign.server.backupFailed2');
          try { const body = await res.json(); errMsg = body.error || errMsg; } catch {}
          throw new Error(errMsg);
        }
        const blob = await res.blob();
        const disposition = res.headers.get('content-disposition') || '';
        const filenameMatch = disposition.match(/filename="?([^"]+)"?/);
        const filename = filenameMatch ? filenameMatch[1] : 'synabun-backup.zip';

        // Trigger download
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);

        statusDot.className = 'wiz-status-dot green';
        statusText.textContent = kit.tx('settings.redesign.server.backupSavedMb', { filename: filename, size: (blob.size / 1024 / 1024).toFixed(1) });
      } catch (err) {
        statusDot.className = 'wiz-status-dot red';
        statusText.textContent = kit.tx('settings.redesign.server.backupFailed', { message: err.message });
      } finally {
        backupBtn.disabled = false;
        backupBtn.innerHTML = origHTML;
      }
    });
  }

  if (restoreBtn && restoreFileInput) {
    restoreBtn.addEventListener('click', () => restoreFileInput.click());

    restoreFileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      e.target.value = '';

      const statusEl = overlay.querySelector('#sys-backup-status');
      const statusDot = overlay.querySelector('#sys-backup-dot');
      const statusText = overlay.querySelector('#sys-backup-text');

      statusEl.style.display = 'flex';
      statusDot.className = 'wiz-status-dot spin';
      statusText.textContent = kit.tx('settings.redesign.server.readingBackupFile');

      try {
        // Post the File itself: the browser streams it from disk. Reading it
        // into an ArrayBuffer first held a multi-GB backup in tab memory.
        statusText.textContent = kit.tx('settings.redesign.server.validatingBackup');
        const previewRes = await fetch('/api/system/restore/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/zip' },
          body: file,
        });
        if (!previewRes.ok) {
          let errMsg = kit.tx('settings.redesign.server.invalidBackup2');
          try { const body = await previewRes.json(); errMsg = body.error || errMsg; } catch {}
          throw new Error(errMsg);
        }
        const { manifest: m } = await previewRes.json();

        statusEl.style.display = 'none';

        const fileCount = (m.files || []).length;
        const hasDb = !!m.database;

        const confirmOverlay = document.createElement('div');
        confirmOverlay.className = 'tag-delete-overlay';
        confirmOverlay.style.zIndex = '300100';
        confirmOverlay.innerHTML = `
          <div class="tag-delete-modal settings-modal" style="max-width:500px;text-align:left">
            <h3 style="margin-bottom:4px">${kit.te('settings.redesign.server.restoreBackup')}</h3>
            <p style="font-size:11px;color:var(--t-muted);margin-bottom:12px">
              ${kit.th('settings.redesign.server.createdOn', { value: new Date(m.created).toLocaleString() })} ${escapeHtml(m.hostname || kit.tx('settings.redesign.server.unknown'))}
            </p>
            <div style="font-size:12px;margin-bottom:8px">
              <strong>${fileCount}</strong> ${kit.te('settings.redesign.server.configFiles')}
              ${hasDb ? `<br><strong>${kit.te('settings.redesign.server.database')}</strong> ${kit.te('settings.redesign.server.memoryDbIncluded')}` : ''}
            </div>
            <p style="font-size:11px;color:var(--accent-dim);margin-bottom:12px">
              ${kit.te('settings.redesign.server.thisWillOverwriteYourCurrentEnv')}
            </p>
            <div class="tag-delete-modal-actions">
              <button class="action-btn action-btn--ghost" id="sys-restore-cancel">${kit.te('settings.redesign.server.cancel')}</button>
              <button class="action-btn action-btn--danger" id="sys-restore-confirm"
                style="background:var(--accent-blue-bg);border-color:var(--accent-blue-border);color:var(--accent-blue)">
                ${kit.te('settings.redesign.server.restore')}
              </button>
            </div>
            <div id="sys-restore-progress" style="display:none;margin-top:10px;font-size:12px;align-items:center;gap:8px">
              <div class="wiz-status-dot spin" id="sys-restore-dot"></div>
              <span id="sys-restore-text"></span>
            </div>
          </div>`;
        document.body.appendChild(confirmOverlay);

        confirmOverlay.querySelector('#sys-restore-cancel').addEventListener('click', () => confirmOverlay.remove());
        confirmOverlay.addEventListener('click', (ev) => {
          if (ev.target === confirmOverlay) confirmOverlay.remove();
        });

        confirmOverlay.querySelector('#sys-restore-confirm').addEventListener('click', async () => {
          const confirmBtn = confirmOverlay.querySelector('#sys-restore-confirm');
          const progressEl = confirmOverlay.querySelector('#sys-restore-progress');
          const progressDot = confirmOverlay.querySelector('#sys-restore-dot');
          const progressText = confirmOverlay.querySelector('#sys-restore-text');

          confirmBtn.textContent = kit.tx('settings.redesign.server.restoring');
          confirmBtn.disabled = true;
          progressEl.style.display = 'flex';
          progressDot.className = 'wiz-status-dot spin';
          progressText.textContent = kit.tx('settings.redesign.server.applyingBackup');

          try {
            const restoreRes = await fetch('/api/system/restore?mode=full', {
              method: 'POST',
              headers: { 'Content-Type': 'application/zip' },
              body: file,
            });
            if (!restoreRes.ok) {
              let errMsg = kit.tx('settings.redesign.server.restoreFailed');
              try { const body = await restoreRes.json(); errMsg = body.error || errMsg; } catch {}
              throw new Error(errMsg);
            }
            const result = await restoreRes.json();
            const restoredFileCount = result.results?.files?.length || 0;

            progressDot.className = 'wiz-status-dot green';
            progressText.textContent = kit.tx('settings.redesign.server.doneFilesRestored', { restoredFileCount: restoredFileCount });
            confirmBtn.textContent = kit.tx('settings.redesign.server.done');

            setTimeout(() => { confirmOverlay.remove(); location.reload(); }, 2500);
          } catch (err) {
            progressDot.className = 'wiz-status-dot red';
            progressText.textContent = err.message;
            confirmBtn.textContent = kit.tx('settings.redesign.server.restore');
            confirmBtn.disabled = false;
          }
        });
      } catch (err) {
        statusDot.className = 'wiz-status-dot red';
        statusText.textContent = kit.tx('settings.redesign.server.invalidBackup', { message: err.message });
      }
    });
  }

  // ══════════════════════════════════════
  // Custom dropdown wiring (stg-dropdown)
  // ══════════════════════════════════════

  function wireStgDropdowns(container) {
    container.querySelectorAll('.stg-dropdown').forEach(dd => {
      const trigger = dd.querySelector('.cc-dropdown-trigger');
      const menu = dd.querySelector('.cc-dropdown-menu');
      const label = dd.querySelector('.cc-dropdown-value');
      const hiddenId = dd.dataset.for;
      const hidden = hiddenId ? container.querySelector(`#${hiddenId}`) : null;
      if (!trigger || !menu) return;

      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        container.querySelectorAll('.stg-dropdown.open').forEach(other => {
          if (other !== dd) other.classList.remove('open');
        });
        dd.classList.toggle('open');
      });

      menu.querySelectorAll('.cc-dropdown-item').forEach(item => {
        item.addEventListener('click', () => {
          const val = item.dataset.value;
          if (hidden) {
            hidden.value = val;
            hidden.dispatchEvent(new Event('change'));
          }
          if (label) label.textContent = item.textContent;
          menu.querySelectorAll('.cc-dropdown-item').forEach(i => i.classList.remove('active'));
          item.classList.add('active');
          dd.classList.remove('open');
        });
      });
    });

    document.addEventListener('click', (e) => {
      container.querySelectorAll('.stg-dropdown.open').forEach(dd => {
        if (!dd.contains(e.target)) dd.classList.remove('open');
      });
    });
  }

  function syncStgDropdown(container, hiddenId) {
    const hidden = container.querySelector(`#${hiddenId}`);
    const dd = container.querySelector(`.stg-dropdown[data-for="${hiddenId}"]`);
    if (!hidden || !dd) return;
    const val = hidden.value;
    const label = dd.querySelector('.cc-dropdown-value');
    const menu = dd.querySelector('.cc-dropdown-menu');
    if (!menu) return;
    menu.querySelectorAll('.cc-dropdown-item').forEach(item => {
      const isMatch = item.dataset.value === val;
      item.classList.toggle('active', isMatch);
      if (isMatch && label) label.textContent = item.textContent;
    });
  }

  wireStgDropdowns(overlay);
  wireLanguageTab(overlay);

  // ══════════════════════════════════════
  // Auto Backup handlers
  // ══════════════════════════════════════

  const abToggle = overlay.querySelector('#auto-backup-toggle');
  const abOptions = overlay.querySelector('#auto-backup-options');
  const abInterval = overlay.querySelector('#auto-backup-interval');
  const abFolder = overlay.querySelector('#auto-backup-folder');
  const abBrowse = overlay.querySelector('#auto-backup-browse');
  const abNow = overlay.querySelector('#auto-backup-now');
  const abInfo = overlay.querySelector('#auto-backup-info');

  function renderAutoBackupInfo(cfg) {
    if (!abInfo) return;
    const parts = [];
    if (cfg.lastBackup) {
      const d = new Date(cfg.lastBackup);
      parts.push(kit.tx('settings.redesign.server.lastBackup', { d: d.toLocaleString() }));
      if (cfg.lastBackupSize) parts[0] += ` (${(cfg.lastBackupSize / 1024 / 1024).toFixed(1)} MB)`;
    }
    if (cfg.lastBackupError) parts.push(`<span style="color:var(--red)">${kit.te('settings.redesign.server.error')} ${cfg.lastBackupError}</span>`);
    const health = cfg.health;
    if (health?.status && health.status !== 'healthy') {
      const color = health.status === 'disabled' ? 'var(--t-faint)' : 'var(--accent-dim)';
      parts.push(`<span style="color:${color}">${kit.te('settings.redesign.server.backupHealth')} ${health.status}${health.reason ? ` — ${health.reason}` : ''}</span>`);
    }
    if (health?.nextDueAt && cfg.enabled) parts.push(kit.tx('settings.redesign.server.nextDue', { value: new Date(health.nextDueAt).toLocaleString() }));
    if (health?.retainedCount != null) parts.push(kit.tx('settings.redesign.server.retainedSnapshots', { retainedCount: health.retainedCount }));
    if (cfg.folderPath) parts.push(`${kit.te('settings.redesign.server.savingVersionedFilesTo')} <span style="opacity:0.7">${cfg.folderPath}/synabun-scheduled-*.zip</span>`);
    abInfo.innerHTML = parts.join('<br>');
  }

  // Load initial state
  if (abToggle) {
    fetch('/api/system/auto-backup').then(r => r.json()).then(cfg => {
      abToggle.checked = cfg.enabled;
      abOptions.style.display = cfg.enabled ? '' : 'none';
      if (cfg.intervalMinutes) {
        abInterval.value = String(cfg.intervalMinutes);
        syncStgDropdown(overlay, 'auto-backup-interval');
      }
      if (cfg.folderPath) abFolder.value = cfg.folderPath;
      renderAutoBackupInfo(cfg);
    }).catch(() => {});

    async function saveAutoBackupConfig() {
      const body = {
        enabled: abToggle.checked,
        intervalMinutes: parseInt(abInterval.value, 10),
        folderPath: abFolder.value,
      };
      try {
        const res = await fetch('/api/system/auto-backup', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (data.config) renderAutoBackupInfo(data.config);
      } catch {}
    }

    abToggle.addEventListener('change', () => {
      abOptions.style.display = abToggle.checked ? '' : 'none';
      saveAutoBackupConfig();
    });

    abInterval.addEventListener('change', () => saveAutoBackupConfig());

    abBrowse.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/browse-folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: kit.tx('settings.redesign.server.selectAutoBackupFolder') }),
        });
        const data = await res.json();
        if (data.path) {
          abFolder.value = data.path.replace(/\/+$/, '');
          saveAutoBackupConfig();
        }
      } catch {}
    });

    abNow.addEventListener('click', async () => {
      if (!abFolder.value) {
        abInfo.innerHTML = '<span style="color:var(--accent-dim)">' + kit.te('settings.redesign.server.selectABackupFolderFirst') + '</span>';
        return;
      }
      abNow.disabled = true;
      const origHTML = abNow.innerHTML;
      abNow.textContent = kit.tx('settings.redesign.server.backingUp');
      abInfo.innerHTML = '<span style="opacity:0.6">' + kit.te('settings.redesign.server.creatingBackup') + '</span>';
      try {
        const res = await fetch('/api/system/auto-backup/trigger', { method: 'POST' });
        const cfg = await res.json();
        if (cfg.error) throw new Error(cfg.error);
        renderAutoBackupInfo(cfg);
      } catch (err) {
        abInfo.innerHTML = `<span style="color:var(--red)">${kit.te('settings.redesign.server.failed')} ${err.message}</span>`;
      } finally {
        abNow.disabled = false;
        abNow.innerHTML = origHTML;
      }
    });
  }

  // ══════════════════════════════════════
  // Memory tab: Recall profiles + controls
  // ══════════════════════════════════════

  mountMemoryMaintenance(overlay.querySelector('#memory-maintenance'), {
    strings: memoryMaintenanceStrings(),
    onStatus: (data) => {
      const pill = overlay.querySelector('#memory-maintenance-pill');
      if (!pill) return;
      const failed = (data.jobs || []).find(j => j.status === 'failed')?.count || 0;
      pill.textContent = data.paused ? kit.tx('settings.redesign.memory.maint.pillPaused')
        : failed ? kit.tx('settings.redesign.memory.maint.pillFailed', { count: failed }) : kit.tx('settings.redesign.memory.maint.pillRunning');
      pill.dataset.state = data.paused ? 'warn' : failed ? 'err' : 'ok';
    },
  });

  const RECALL_PROFILES = {
    quick:    { limit: 3,  minImportance: 5, minScore: 0.45, maxChars: 300,  includeSessions: 'never',  recencyBoost: false },
    balanced: { limit: 5,  minImportance: 0, minScore: 0.30, maxChars: 0,    includeSessions: 'auto',   recencyBoost: false },
    deep:     { limit: 10, minImportance: 0, minScore: 0.20, maxChars: 0,    includeSessions: 'always', recencyBoost: false },
  };

  const IMPORTANCE_LABELS = [kit.tx('settings.redesign.memory.any'),'',kit.tx('settings.redesign.memory.trivial'),'',kit.tx('settings.redesign.memory.low'),kit.tx('settings.redesign.memory.normal'),'',kit.tx('settings.redesign.memory.significant'),'',kit.tx('settings.redesign.memory.critical'),kit.tx('settings.redesign.memory.foundational')];

  // DOM refs
  const rcProfiles = overlay.querySelector('#recall-profiles');
  const rcControlsSection = overlay.querySelector('#recall-controls');
  const rcBadge = overlay.querySelector('#recall-controls-badge');
  const rcLimit = overlay.querySelector('#rc-limit');
  const rcLimitVal = overlay.querySelector('#rc-limit-val');
  const rcImportance = overlay.querySelector('#rc-importance');
  const rcImportanceVal = overlay.querySelector('#rc-importance-val');
  const rcScore = overlay.querySelector('#rc-score');
  const rcScoreVal = overlay.querySelector('#rc-score-val');
  const rcMaxchars = overlay.querySelector('#rc-maxchars');
  const rcMaxcharsVal = overlay.querySelector('#rc-maxchars-val');
  const rcSessions = overlay.querySelector('#rc-sessions');
  const rcRecency = overlay.querySelector('#rc-recency');
  const rcImpactTokens = overlay.querySelector('#recall-impact-tokens');
  const rcImpactReachable = overlay.querySelector('#recall-impact-reachable');
  const rcImpactSessions = overlay.querySelector('#recall-impact-sessions');

  let _recallProfile = 'balanced';
  let _recallImpactData = null; // { rows: [{ importance, cnt, avg_len }] }

  function importanceName(val) {
    if (val === 0) return kit.tx('settings.redesign.memory.any');
    if (val <= 2) return kit.tx('settings.redesign.memory.trivial');
    if (val <= 4) return kit.tx('settings.redesign.memory.low');
    if (val === 5) return kit.tx('settings.redesign.memory.normal');
    if (val <= 7) return kit.tx('settings.redesign.memory.significant');
    if (val <= 9) return kit.tx('settings.redesign.memory.critical');
    return kit.tx('settings.redesign.memory.foundational');
  }

  function updateControlsFromState(d) {
    rcLimit.value = d.limit;
    rcLimitVal.textContent = d.limit;
    rcImportance.value = d.minImportance;
    rcImportanceVal.textContent = importanceName(d.minImportance);
    rcScore.value = Math.round(d.minScore * 100);
    rcScoreVal.textContent = d.minScore.toFixed(2);
    rcMaxchars.value = d.maxChars === 0 ? 2100 : Math.min(d.maxChars, 2100);
    rcMaxcharsVal.textContent = d.maxChars === 0 ? kit.tx('settings.redesign.memory.noLimit') : kit.tx('settings.redesign.memory.chars', { maxChars: d.maxChars });
    rcSessions.querySelectorAll('.recall-seg-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.val === d.includeSessions);
    });
    rcRecency.checked = d.recencyBoost;
  }

  function getControlsState() {
    const rawMaxchars = parseInt(rcMaxchars.value, 10);
    return {
      limit: parseInt(rcLimit.value, 10),
      minImportance: parseInt(rcImportance.value, 10),
      minScore: parseInt(rcScore.value, 10) / 100,
      maxChars: rawMaxchars >= 2100 ? 0 : rawMaxchars,
      includeSessions: rcSessions.querySelector('.recall-seg-btn.active')?.dataset.val || 'auto',
      recencyBoost: rcRecency.checked,
    };
  }

  function setActiveProfile(name, { keepOpen = false } = {}) {
    _recallProfile = name;
    rcProfiles.querySelectorAll('.recall-profile-card').forEach(c => {
      c.classList.toggle('active', c.dataset.recallProfile === name);
    });
    // Auto-open controls for custom, collapse for presets (unless a deep link asked for them open)
    if (name === 'custom') {
      rcControlsSection.classList.remove('collapsed');
      rcBadge.textContent = kit.tx('settings.redesign.memory.customConfiguration');
    } else {
      if (!keepOpen) rcControlsSection.classList.add('collapsed');
      rcBadge.textContent = kit.tx('settings.redesign.memory.usingProfileDefaults');
      updateControlsFromState(RECALL_PROFILES[name]);
    }
    updateImpactIndicator();
  }

  async function saveRecallSettings() {
    const d = getControlsState();
    try {
      await fetch('/api/display-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recallDefaults: d, profile: _recallProfile }),
      });
    } catch (e) {
      console.error('Failed to save recall settings:', e);
    }
  }

  function updateImpactIndicator() {
    const d = getControlsState();
    if (_recallImpactData) {
      let reachable = 0;
      let totalLen = 0;
      let totalTagsLen = 0;
      let totalFilesLen = 0;
      let totalCount = 0;
      for (const row of _recallImpactData.rows) {
        if (d.minImportance === 0 || row.importance >= d.minImportance) {
          reachable += row.cnt;
          totalLen += row.avg_len * row.cnt;
          totalTagsLen += (row.avg_tags_len || 0) * row.cnt;
          totalFilesLen += (row.avg_files_len || 0) * row.cnt;
          totalCount += row.cnt;
        }
      }
      const avgLen = totalCount > 0 ? totalLen / totalCount : 500;
      const avgTagsLen = totalCount > 0 ? totalTagsLen / totalCount : 30;
      const avgFilesLen = totalCount > 0 ? totalFilesLen / totalCount : 40;
      const effectiveLen = d.maxChars > 0 ? Math.min(avgLen, d.maxChars) : avgLen;

      // Token estimate: chars / 3.7 (average ratio for mixed text)
      // Per memory: content + metadata header (~80 chars: UUID, score, importance, age)
      //           + category/project/tags line + files line + newlines
      const metadataCharsPerResult = 80 + avgTagsLen + avgFilesLen + 30;
      const contentTokens = d.limit * (effectiveLen / 3.7);
      const metadataTokens = d.limit * (metadataCharsPerResult / 3.7);
      const headerTokens = 15; // "Found N memories and M session chunks for ..."

      // Session chunks: estimated when sessions are on or auto
      let sessionTokens = 0;
      if (d.includeSessions !== 'never') {
        const ss = _recallImpactData.sessionStats;
        const sessionLimit = Math.max(3, Math.floor(d.limit / 2));
        if (ss && ss.count > 0) {
          // Per chunk: summary + header (~90 chars) + session line (~70 chars) + details
          const charsPerChunk = (ss.avg_summary_len || 150) + 160 + (ss.avg_details_len || 80);
          sessionTokens = sessionLimit * (charsPerChunk / 3.7);
        } else {
          // Fallback estimate when no session data available
          sessionTokens = sessionLimit * 120;
        }
        if (d.includeSessions === 'auto') sessionTokens *= 0.6; // auto doesn't always trigger
      }

      const estTokens = Math.round(contentTokens + metadataTokens + headerTokens + sessionTokens);
      rcImpactTokens.textContent = estTokens > 999 ? (estTokens / 1000).toFixed(1) + 'k' : estTokens;
      rcImpactReachable.textContent = reachable;
    }
    const sessMap = { auto: kit.tx('settings.redesign.memory.auto'), always: kit.tx('settings.redesign.memory.on'), never: kit.tx('settings.redesign.memory.off') };
    rcImpactSessions.textContent = sessMap[d.includeSessions] || kit.tx('settings.redesign.memory.auto');
  }

  // Load impact data + current settings
  fetch('/api/recall-impact').then(r => r.json()).then(data => {
    _recallImpactData = data;
    updateImpactIndicator();
  }).catch(() => {});

  fetch('/api/display-settings').then(r => r.json()).then(data => {
    const profile = data.profile || 'balanced';
    const d = data.recallDefaults;
    if (d) {
      updateControlsFromState(d);
    } else if (data.recallMaxChars !== undefined) {
      // Legacy migration
      const legacy = { ...RECALL_PROFILES.balanced, maxChars: data.recallMaxChars ?? 0 };
      updateControlsFromState(legacy);
    }
    // The saved profile arrives after the deep link was applied: a link that opened the controls keeps them open.
    setActiveProfile(profile, { keepOpen: settingsRevealRequested(overlay, rcControlsSection) });
  }).catch(() => setActiveProfile('balanced', { keepOpen: settingsRevealRequested(overlay, rcControlsSection) }));

  // Profile card clicks + mouse-tracking glow + background icon clone
  rcProfiles.querySelectorAll('.recall-profile-card').forEach(card => {
    card.addEventListener('click', () => {
      setActiveProfile(card.dataset.recallProfile);
      saveRecallSettings();
    });
    card.addEventListener('mousemove', e => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100) + '%');
      card.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100) + '%');
    });
    // Clone icon SVG into oversized background element
    const iconSvg = card.querySelector('.recall-profile-icon svg');
    if (iconSvg) {
      const bg = document.createElement('div');
      bg.className = 'recall-bg-icon';
      bg.appendChild(iconSvg.cloneNode(true));
      card.appendChild(bg);
    }
  });

  // Slider wiring
  function wireSlider(el, valEl, formatter, onChange) {
    el.addEventListener('input', () => {
      valEl.textContent = formatter(el.value);
      if (onChange) onChange();
      updateImpactIndicator();
      if (_recallProfile !== 'custom') setActiveProfile('custom');
      saveRecallSettings();
    });
  }

  wireSlider(rcLimit, rcLimitVal, v => v);
  wireSlider(rcImportance, rcImportanceVal, v => importanceName(parseInt(v, 10)));
  wireSlider(rcScore, rcScoreVal, v => (parseInt(v, 10) / 100).toFixed(2));
  wireSlider(rcMaxchars, rcMaxcharsVal, v => {
    const n = parseInt(v, 10);
    return n >= 2100 ? kit.tx('settings.redesign.memory.noLimit') : kit.tx('settings.redesign.memory.chars', { maxChars: n });
  });

  // Segmented button (sessions)
  rcSessions.querySelectorAll('.recall-seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      rcSessions.querySelectorAll('.recall-seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateImpactIndicator();
      if (_recallProfile !== 'custom') setActiveProfile('custom');
      saveRecallSettings();
    });
  });

  // Toggle (recency boost)
  rcRecency.addEventListener('change', () => {
    if (_recallProfile !== 'custom') setActiveProfile('custom');
    saveRecallSettings();
  });

  // Sync button
  const syncBtn = overlay.querySelector('#sync-check-btn');
  if (syncBtn) {
    syncBtn.addEventListener('click', () => checkSyncStatus());
  }

  // ══════════════════════════════════════
  // OpenClaw Bridge handlers
  // ══════════════════════════════════════

  function attachBridgeSyncHandler(container) {
    const syncBtn = container.querySelector('#bridge-openclaw-sync');
    if (!syncBtn) return;
    syncBtn.addEventListener('click', async () => {
      syncBtn.disabled = true; const origHTML = syncBtn.innerHTML; syncBtn.textContent = kit.tx('settings.redesign.hooks.syncing');
      try {
        const res = await fetch('/api/bridges/openclaw/sync', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          const metaEl = container.querySelector('#bridge-openclaw-meta');
          if (metaEl) metaEl.textContent = kit.tx('settings.redesign.hooks.nodesSynced', { nodes: (data.nodes || 0), value: new Date().toLocaleTimeString() });
          emit('data:reload');
        } else { alert(data.error || kit.tx('settings.redesign.hooks.syncFailed')); }
      } catch (err) { alert(kit.tx('settings.redesign.hooks.syncFailed2', { message: err.message })); }
      finally { syncBtn.disabled = false; syncBtn.innerHTML = origHTML; }
    });
  }

  function attachBridgeDisconnectHandler(container, closeFn) {
    const disconnectBtn = container.querySelector('#bridge-openclaw-disconnect');
    if (!disconnectBtn) return;
    disconnectBtn.addEventListener('click', async () => {
      if (!confirm(kit.tx('settings.redesign.hooks.disconnectOpenclawBridgeMemoriesWillBe'))) return;
      try {
        await fetch('/api/bridges/openclaw', { method: 'DELETE' });
        emit('data:reload');
        const bridgeEl = container.querySelector('#bridge-openclaw');
        if (bridgeEl) bridgeEl.classList.remove('enabled');
        const titleEl = bridgeEl?.querySelector('.cc-panel-title');
        if (titleEl) titleEl.style.color = '';
        const statusEl = bridgeEl?.querySelector('.cc-panel-status');
        if (statusEl) { statusEl.textContent = kit.tx('settings.redesign.hooks.off'); statusEl.className = 'cc-panel-status inactive'; statusEl.style.background = ''; statusEl.style.color = ''; }
        const integItem = bridgeEl?.querySelector('.cc-integration-item');
        if (integItem) integItem.classList.remove('enabled');
        const metaEl = container.querySelector('#bridge-openclaw-meta');
        if (metaEl) metaEl.textContent = kit.tx('settings.redesign.hooks.readOnlyOverlayOfOpenclawMarkdown');
        const actionsEl = container.querySelector('#bridge-openclaw-actions');
        if (actionsEl) {
          actionsEl.innerHTML = `<button type="button" class="cc-enable-btn" id="bridge-openclaw-connect" ${kit.inv('AUT045')}>${kit.te('settings.redesign.hooks.connect')}</button>`;
          const newConnBtn = actionsEl.querySelector('#bridge-openclaw-connect');
          if (newConnBtn) newConnBtn.addEventListener('click', () => { if (closeFn) closeFn(); openSettingsModal(); });
        }
      } catch (err) { alert(kit.tx('settings.redesign.hooks.disconnectFailed', { message: err.message })); }
    });
  }

  const ocConnectBtn = overlay.querySelector('#bridge-openclaw-connect');
  if (ocConnectBtn) {
    ocConnectBtn.addEventListener('click', async () => {
      ocConnectBtn.disabled = true; ocConnectBtn.textContent = kit.tx('settings.redesign.hooks.connecting');
      try {
        const res = await fetch('/api/bridges/openclaw/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
        const data = await res.json();
        if (data.ok) {
          emit('data:reload');
          const bridgeEl = overlay.querySelector('#bridge-openclaw');
          if (bridgeEl) bridgeEl.classList.add('enabled');
          const titleEl = bridgeEl?.querySelector('.cc-panel-title');
          if (titleEl) titleEl.style.color = '#f97316';
          const statusEl = bridgeEl?.querySelector('.cc-panel-status');
          if (statusEl) { statusEl.textContent = kit.tx('settings.redesign.hooks.connected'); statusEl.className = 'cc-panel-status active'; statusEl.style.background = 'rgba(249,115,22,0.15)'; statusEl.style.color = '#f97316'; }
          const integItem = bridgeEl?.querySelector('.cc-integration-item');
          if (integItem) integItem.classList.add('enabled');
          const metaEl = overlay.querySelector('#bridge-openclaw-meta');
          if (metaEl) metaEl.textContent = kit.tx('settings.redesign.hooks.nodesSynced2', { nodes: (data.nodes || 0), nodes2: (data.nodes > 0 ? ' \u00b7 ' + new Date().toLocaleTimeString() : '') });
          const actionsEl = overlay.querySelector('#bridge-openclaw-actions');
          if (actionsEl) {
            actionsEl.innerHTML = `<button type="button" class="cc-enable-btn on" id="bridge-openclaw-sync" ${kit.inv('AUT051')} style="flex:1"><svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:2;vertical-align:-1px;margin-right:4px"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>${kit.te('settings.redesign.hooks.sync')}</button><button class="cc-disable-btn" id="bridge-openclaw-disconnect">${kit.te('settings.redesign.hooks.disconnect')}</button>`;
            attachBridgeSyncHandler(overlay);
            attachBridgeDisconnectHandler(overlay, close);
          }
        } else { alert(data.error || kit.tx('settings.redesign.hooks.failedToConnect')); ocConnectBtn.disabled = false; ocConnectBtn.textContent = kit.tx('settings.redesign.hooks.connect'); }
      } catch (err) { alert(kit.tx('settings.redesign.hooks.failed2', { message: err.message })); ocConnectBtn.disabled = false; ocConnectBtn.textContent = kit.tx('settings.redesign.hooks.connect'); }
    });
  }
  attachBridgeSyncHandler(overlay);
  attachBridgeDisconnectHandler(overlay, close);

  // ══════════════════════════════════════
  // Claude Code tab handlers
  // ══════════════════════════════════════

  // Collapsible panel headers
  overlay.querySelectorAll('[data-cc-collapse]').forEach(header => {
    header.addEventListener('click', (e) => {
      if (e.target.closest('.cc-panel-actions')) return;
      const panel = header.closest('.cc-panel');
      if (panel) panel.classList.toggle('open');
    });
  });

  // Collapsible cards (every section of every page, and the cards inside them that open) — click anywhere outside the body
  overlay.querySelectorAll('.iface-section[data-collapsible]').forEach(section => {
    section.addEventListener('click', (e) => {
      if (e.target.closest('select, input, button, textarea, a')) return;
      // Its own body is not a handle, and a card nested inside it answers for itself.
      if (e.target.closest('.iface-section[data-collapsible]') !== section
        || e.target.closest('.cc-section-body')?.closest('.iface-section[data-collapsible]') === section) return;
      section.classList.toggle('collapsed');
      storeSectionState(section);
    });
  });

  // ── MoreLogin tab handlers (self-loads status/profiles async) ──
  wireMoreLoginTab(overlay);

  // ── Judgments tab (TypeSafe / Jev) — self-loads and polls while active ──
  wireJudgmentsTab(overlay, { toast: showCCToast, initial: typesafeConfig });

  // ── WhatsApp tab — self-loads its status (never part of the blocking fetch above) ──
  wireWhatsAppTab(overlay, { toast: showCCToast });

  // ── Discord tab handlers ──
  {
    // Token save
    const tokenSaveBtn = overlay.querySelector('#discord-token-save');
    if (tokenSaveBtn) {
      tokenSaveBtn.addEventListener('click', async () => {
        const input = overlay.querySelector('#discord-bot-token');
        const val = input.value.trim();
        const res = await fetch('/api/discord/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'botToken', value: val }),
        }).then(r => r.json()).catch(() => ({ error: kit.tx('settings.redesign.discord.networkError') }));
        if (res.ok) {
          showCCToast(kit.tx('settings.redesign.discord.botTokenSaved'));
          const statusEl = overlay.querySelector('#discord-conn-status');
          if (statusEl) statusEl.textContent = val ? kit.tx('settings.redesign.discord.configured') : kit.tx('settings.redesign.discord.missing');
          const dot = overlay.querySelector('.stg-pane[data-stg-pane="discord"] .settings-status-dot');
          if (dot) { dot.classList.toggle('connected', !!val); dot.classList.toggle('disconnected', !val); }
          const statusText = overlay.querySelector('.stg-pane[data-stg-pane="discord"] .settings-status');
          if (statusText) statusText.lastChild.textContent = val ? (" " + kit.tx('settings.redesign.discord.tokenConfigured')) : (" " + kit.tx('settings.redesign.discord.notConfigured'));
          // Update invite link
          updateInviteLink(overlay, val);
        } else {
          showCCToast(res.error || kit.tx('settings.redesign.discord.saveFailed'));
        }
      });
    }

    // Token eye toggle
    const tokenEye = overlay.querySelector('#discord-token-eye');
    if (tokenEye) {
      tokenEye.addEventListener('click', () => {
        const input = overlay.querySelector('#discord-bot-token');
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        tokenEye.innerHTML = isPassword ? eyeOpen : eyeClosed;
      });
    }

    // Guild ID save
    const guildSaveBtn = overlay.querySelector('#discord-guild-save');
    if (guildSaveBtn) {
      guildSaveBtn.addEventListener('click', async () => {
        const input = overlay.querySelector('#discord-guild-id');
        const val = input.value.trim();
        const res = await fetch('/api/discord/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'guildId', value: val }),
        }).then(r => r.json()).catch(() => ({ error: kit.tx('settings.redesign.discord.networkError') }));
        if (res.ok) showCCToast(kit.tx('settings.redesign.discord.guildIdSaved'));
        else showCCToast(res.error || kit.tx('settings.redesign.discord.saveFailed'));
      });
    }

    // Test connection
    const testBtn = overlay.querySelector('#discord-test-btn');
    if (testBtn) {
      testBtn.addEventListener('click', async () => {
        const resultEl = overlay.querySelector('#discord-test-result');
        resultEl.style.display = 'block';
        resultEl.style.background = 'rgba(255,255,255,0.05)';
        resultEl.style.border = '1px solid var(--s-medium)';
        resultEl.textContent = kit.tx('settings.redesign.discord.testingConnection');

        const res = await fetch('/api/discord/test', { method: 'POST' }).then(r => r.json()).catch(() => ({ ok: false, error: kit.tx('settings.redesign.discord.networkError') }));
        if (res.ok) {
          const bot = res.bot;
          const guilds = bot.guilds.map(g => `${g.name} (${g.id})`).join(', ');
          resultEl.style.background = 'rgba(109,213,140,0.08)';
          resultEl.style.border = '1px solid rgba(109,213,140,0.2)';
          resultEl.innerHTML = `<div style="color:var(--green);margin-bottom:4px;font-weight:600">${kit.te('settings.redesign.discord.connected')}</div>` +
            `<div>${kit.te('settings.redesign.discord.bot')} <strong>${escapeHtml(bot.username)}</strong> (${bot.id})</div>` +
            `<div>${kit.te('settings.redesign.discord.guilds')} ${escapeHtml(guilds) || kit.te('settings.redesign.discord.none')}</div>`;
        } else {
          resultEl.style.background = 'rgba(255,99,99,0.08)';
          resultEl.style.border = '1px solid rgba(255,99,99,0.2)';
          resultEl.innerHTML = `<div style="color:var(--red,#ff6b6b)">${kit.te('settings.redesign.discord.failed')} ${escapeHtml(res.error || kit.tx('settings.redesign.discord.unknownError'))}</div>`;
        }
      });
    }

    // Invite link
    function updateInviteLink(container, token) {
      const linkInput = container.querySelector('#discord-invite-link');
      if (!linkInput) return;
      // The field shows a message until there is a link; `data-ready` says which one it holds.
      delete linkInput.dataset.ready;
      if (!token) { linkInput.value = kit.tx('settings.redesign.discord.saveABotTokenFirst'); return; }
      // Extract application ID from token (first segment is base64-encoded app ID)
      try {
        const appId = atob(token.split('.')[0]);
        linkInput.value = `https://discord.com/oauth2/authorize?client_id=${appId}&permissions=8&scope=bot`;
        linkInput.dataset.ready = '1';
      } catch {
        linkInput.value = kit.tx('settings.redesign.discord.couldNotParseBotToken');
      }
    }
    updateInviteLink(overlay, discordConfig.botToken);

    // Copy invite link
    const inviteCopy = overlay.querySelector('#discord-invite-copy');
    if (inviteCopy) {
      inviteCopy.addEventListener('click', () => {
        const linkInput = overlay.querySelector('#discord-invite-link');
        if (linkInput.value && linkInput.dataset.ready) {
          navigator.clipboard.writeText(linkInput.value);
          showCCToast(kit.tx('settings.redesign.discord.inviteLinkCopied'));
        }
      });
    }

    // Auto-save for Server Defaults and Moderation Defaults inputs
    overlay.querySelectorAll('input[data-discord-key]').forEach(input => {
      let debounce;
      input.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(async () => {
          const key = input.dataset.discordKey;
          const val = input.value.trim();
          await fetch('/api/discord/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, value: val }),
          }).catch(() => {});
          showCCToast(kit.tx('settings.redesign.discord.saved'));
        }, 800);
      });
    });
  }

  // ── CLI Paths handlers ──
  {
    const cliSaveBtn = overlay.querySelector('#cli-paths-save');
    // Must stay in sync with CLI_DEFAULTS in server.js and the cliProfiles
    // list that renders the inputs — opencode was previously missing here, so
    // its input rendered but its value was never sent to the server.
    const cliDefaults = { 'claude-code': 'claude', 'codex': 'codex', 'gemini': 'gemini', 'opencode': 'opencode' };
    const cliProfileIds = Object.keys(cliDefaults);

    // Detect buttons
    overlay.querySelectorAll('.cli-detect-btn[data-cli-detect]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const profileId = btn.dataset.cliDetect;
        const input = overlay.querySelector(`#cli-path-${profileId}`);
        btn.style.opacity = '0.5'; btn.style.pointerEvents = 'none';
        try {
          const res = await fetch(`/api/cli/detect/${encodeURIComponent(profileId)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          });
          const data = await res.json();
          if (data.ok && data.found && data.path) {
            input.value = data.path;
            showCCToast(kit.tx('settings.redesign.terminal.found', { path: data.path }));
          } else {
            showCCToast(kit.tx('settings.redesign.terminal.cliNotFoundInPath'));
          }
        } catch (err) {
          showCCToast(kit.tx('settings.redesign.terminal.detectionFailed', { message: err.message }));
        } finally {
          btn.style.opacity = ''; btn.style.pointerEvents = '';
        }
      });
    });

    // Save button
    if (cliSaveBtn) {
      cliSaveBtn.addEventListener('click', async () => {
        const body = {};
        cliProfileIds.forEach(id => {
          const input = overlay.querySelector(`#cli-path-${id}`);
          if (input) body[id] = { command: input.value.trim() };
        });
        cliSaveBtn.style.opacity = '0.5'; cliSaveBtn.style.pointerEvents = 'none';
        try {
          const res = await fetch('/api/cli/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const data = await res.json();
          if (data.ok) {
            cliProfileIds.forEach(id => {
              const input = overlay.querySelector(`#cli-path-${id}`);
              const status = overlay.querySelector(`#cli-status-${id}`);
              const val = input?.value?.trim() || '';
              const isDefault = !val || val === cliDefaults[id];
              if (status) {
                status.textContent = isDefault ? kit.tx('settings.redesign.terminal.default') : kit.tx('settings.redesign.terminal.custom');
                status.className = `cli-path-status${isDefault ? '' : ' custom'}`;
              }
            });
            showCCToast(kit.tx('settings.redesign.terminal.cliPathsSaved'));
          } else {
            alert(data.error || kit.tx('settings.redesign.terminal.failedToSave'));
          }
        } catch (err) {
          alert(kit.tx('settings.redesign.terminal.failed', { message: err.message }));
        } finally {
          cliSaveBtn.style.opacity = ''; cliSaveBtn.style.pointerEvents = '';
        }
      });
    }

  }

  // ── Notifications tab handlers ──
  {
    const masterToggle = overlay.querySelector('#notif-master-toggle');
    const soundToggle = overlay.querySelector('#notif-sound-toggle');
    const volumeSlider = overlay.querySelector('#notif-volume');
    const volumeLabel = overlay.querySelector('#notif-volume-label');
    const soundTypeSelect = overlay.querySelector('#notif-sound-type');
    const bannerToggle = overlay.querySelector('#notif-banner-toggle');
    const bannerFocused = overlay.querySelector('#notif-banner-focused');
    const sourceCli = overlay.querySelector('#notif-source-cli');
    const sourcePanel = overlay.querySelector('#notif-source-panel');
    const triggerDone = overlay.querySelector('#notif-trigger-done');
    const triggerAction = overlay.querySelector('#notif-trigger-action');
    const triggerAsk = overlay.querySelector('#notif-trigger-ask');
    const triggerError = overlay.querySelector('#notif-trigger-error');
    const toastToggle = overlay.querySelector('#notif-toast-toggle');
    const toastPosition = overlay.querySelector('#notif-toast-position');
    const toastDuration = overlay.querySelector('#notif-toast-duration');
    const requestPermBtn = overlay.querySelector('#notif-request-perm');
    const testBtn = overlay.querySelector('#notif-test-btn');

    function updateSubSections() {
      const on = masterToggle?.checked;
      for (const id of ['notif-sources-section', 'notif-triggers-section', 'notif-sound-section', 'notif-toast-section', 'notif-banner-section']) {
        const el = overlay.querySelector(`#${id}`);
        if (el) {
          el.style.opacity = on ? '' : '0.4';
          el.style.pointerEvents = on ? '' : 'none';
        }
      }
    }
    updateSubSections();

    if (masterToggle) {
      masterToggle.addEventListener('change', () => {
        storage.setItem(KEYS.TERMINAL_NOTIFICATIONS, masterToggle.checked ? 'on' : 'off');
        updateSubSections();
        if (masterToggle.checked && typeof Notification !== 'undefined' && Notification.permission === 'default') {
          Notification.requestPermission();
        }
      });
    }

    // Sources
    if (sourceCli) sourceCli.addEventListener('change', () => storage.setItem(KEYS.NOTIF_SOURCE_CLI, sourceCli.checked ? 'on' : 'off'));
    if (sourcePanel) sourcePanel.addEventListener('change', () => storage.setItem(KEYS.NOTIF_SOURCE_PANEL, sourcePanel.checked ? 'on' : 'off'));

    // Triggers
    if (triggerDone) triggerDone.addEventListener('change', () => storage.setItem(KEYS.NOTIF_TRIGGER_DONE, triggerDone.checked ? 'on' : 'off'));
    if (triggerAction) triggerAction.addEventListener('change', () => storage.setItem(KEYS.NOTIF_TRIGGER_ACTION, triggerAction.checked ? 'on' : 'off'));
    if (triggerAsk) triggerAsk.addEventListener('change', () => storage.setItem(KEYS.NOTIF_TRIGGER_ASK, triggerAsk.checked ? 'on' : 'off'));
    if (triggerError) triggerError.addEventListener('change', () => storage.setItem(KEYS.NOTIF_TRIGGER_ERROR, triggerError.checked ? 'on' : 'off'));

    // Sound
    if (soundToggle) soundToggle.addEventListener('change', () => storage.setItem(KEYS.NOTIF_SOUND, soundToggle.checked ? 'on' : 'off'));
    if (volumeSlider) {
      volumeSlider.addEventListener('input', () => {
        const val = volumeSlider.value;
        if (volumeLabel) volumeLabel.textContent = val + '%';
        storage.setItem(KEYS.NOTIF_SOUND_VOLUME, val);
      });
    }
    if (soundTypeSelect) {
      soundTypeSelect.addEventListener('change', () => {
        storage.setItem(KEYS.NOTIF_SOUND_TYPE, soundTypeSelect.value);
      });
    }

    // Per-type sound test buttons
    overlay.querySelectorAll('[data-notif-test]').forEach(btn => {
      btn.addEventListener('click', () => {
        const type = btn.dataset.notifTest;
        const preset = soundTypeSelect?.value || storage.getItem(KEYS.NOTIF_SOUND_TYPE) || 'beep';
        playTestSound(preset, type);
      });
    });

    // Toast
    if (toastToggle) toastToggle.addEventListener('change', () => storage.setItem(KEYS.NOTIF_TOAST, toastToggle.checked ? 'on' : 'off'));
    if (toastPosition) toastPosition.addEventListener('change', () => storage.setItem(KEYS.NOTIF_TOAST_POSITION, toastPosition.value));
    if (toastDuration) toastDuration.addEventListener('change', () => storage.setItem(KEYS.NOTIF_TOAST_DURATION, toastDuration.value));

    // Banners
    if (bannerToggle) bannerToggle.addEventListener('change', () => storage.setItem(KEYS.NOTIF_BANNER, bannerToggle.checked ? 'on' : 'off'));
    if (bannerFocused) bannerFocused.addEventListener('change', () => storage.setItem(KEYS.NOTIF_BANNER_FOCUSED, bannerFocused.checked ? 'on' : 'off'));

    // ── Live permission status refresh ──
    function refreshNotifPermRow() {
      if (typeof Notification === 'undefined') return;
      const state = Notification.permission;
      const labels = { granted: kit.tx('settings.redesign.notifications.perm.granted'), denied: kit.tx('settings.redesign.notifications.perm.denied'), default: kit.tx('settings.redesign.notifications.perm.default') };
      const colors = {
        granted: 'var(--accent-green, #4ade80)',
        denied: 'var(--accent-red, #f87171)',
        default: 'var(--s-light, #888)',
      };
      const dot = overlay.querySelector('#notif-perm-dot');
      const label = overlay.querySelector('#notif-perm-label');
      const hint = overlay.querySelector('#notif-perm-hint');
      const reqBtn = overlay.querySelector('#notif-request-perm');
      const recheckBtn = overlay.querySelector('#notif-recheck-perm');
      if (dot) dot.style.background = colors[state] || colors.default;
      if (label) label.textContent = labels[state] || state;
      if (hint) hint.style.display = state === 'denied' ? '' : 'none';
      if (reqBtn) reqBtn.style.display = state === 'default' ? '' : 'none';
      if (recheckBtn) recheckBtn.style.display = state === 'denied' ? '' : 'none';
    }

    refreshNotifPermRow();

    // Subscribe to permission changes via Permissions API (reflects browser/OS unblocks live).
    if (navigator.permissions?.query) {
      navigator.permissions.query({ name: 'notifications' }).then(status => {
        const handler = () => refreshNotifPermRow();
        status.addEventListener('change', handler);
        // Detach listener when overlay is removed from DOM.
        const observer = new MutationObserver(() => {
          if (!document.body.contains(overlay)) {
            status.removeEventListener('change', handler);
            observer.disconnect();
            document.removeEventListener('visibilitychange', visHandler);
          }
        });
        observer.observe(document.body, { childList: true, subtree: false });
      }).catch(() => {});
    }

    // Re-poll when tab regains visibility (covers Permissions API gaps on Safari).
    const visHandler = () => { if (!document.hidden) refreshNotifPermRow(); };
    document.addEventListener('visibilitychange', visHandler);

    // Request permission
    if (requestPermBtn) {
      requestPermBtn.addEventListener('click', async () => {
        const result = await Notification.requestPermission();
        refreshNotifPermRow();
        showCCToast(kit.tx(result === 'granted'
          ? 'settings.redesign.notifications.permGrantedToast'
          : 'settings.redesign.notifications.permDeniedToast'));
      });
    }

    // Re-check (after user unblocks site permission in browser address bar)
    const recheckBtn = overlay.querySelector('#notif-recheck-perm');
    if (recheckBtn) {
      recheckBtn.addEventListener('click', () => {
        refreshNotifPermRow();
        const state = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
        if (state === 'granted') showCCToast(kit.tx('settings.redesign.notifications.permGrantedToast'));
        else if (state === 'denied') showCCToast(kit.tx('settings.redesign.notifications.permStillBlockedToast'));
        else showCCToast(kit.tx('settings.redesign.notifications.permStatusToast', { state }));
      });
    }

    // Full test notification (fires notify() which triggers sound + toast + banner)
    if (testBtn) {
      testBtn.addEventListener('click', () => {
        // Import notify dynamically to avoid circular dep — use the shared module
        import('./ui-notifications.js').then(({ notify, NOTIF_TYPE }) => {
          notify('panel', NOTIF_TYPE.ACTION, kit.tx('settings.redesign.notifications.testNotificationEverythingIsWorking'));
        });
        showCCToast(kit.tx('settings.redesign.notifications.testNotificationSent'));
      });
    }
  }

  function updateGlobalHookBadge() {
    const hooksSection = overlay.querySelector('.iface-section[data-cc-target="global"]');
    if (!hooksSection) return;
    const toggles = hooksSection.querySelectorAll('.cc-toggle[data-cc-scope="global"]');
    const total = toggles.length;
    const onCount = [...toggles].filter(t => t.classList.contains('on')).length;
    const badge = overlay.querySelector('#cc-hooks-badge');
    if (badge) {
      badge.textContent = `${onCount}/${total}`;
      badge.classList.toggle('all-on', onCount === total);
    }
  }

  function updateProjectCount() {
    const allPanels = overlay.querySelectorAll('.cc-panel[data-cc-idx]');
    const activePanels = overlay.querySelectorAll('.cc-panel[data-cc-idx].enabled');
    const countEl = overlay.querySelector('.cc-project-count');
    if (countEl) countEl.textContent = kit.tx('settings.redesign.hooks.ofActive', { count: activePanels.length, count2: allPanels.length });
  }

  async function ccToggleHook(target, projectPath, toggleBtn, panel, hookEvent) {
    const isOn = toggleBtn.classList.contains('on');
    const method = isOn ? 'DELETE' : 'POST';
    const body = { target };
    if (projectPath) body.projectPath = projectPath;
    if (hookEvent) body.hook = hookEvent;
    try {
      toggleBtn.style.opacity = '0.4'; toggleBtn.style.pointerEvents = 'none';
      const res = await fetch('/api/claude-code/integrations', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (data.ok) {
        const nowOn = !isOn;
        toggleBtn.classList.toggle('on');
        const row = toggleBtn.closest('.cc-integration-item');
        if (row) row.classList.toggle('enabled', nowOn);
        if (target === 'global') { updateGlobalHookBadge(); }
        else { toggleBtn.textContent = nowOn ? kit.tx('settings.redesign.hooks.enabled') : kit.tx('settings.redesign.hooks.enable'); if (panel) panel.classList.toggle('enabled'); const badge = panel?.querySelector('.cc-panel-status'); if (badge) { badge.textContent = nowOn ? kit.tx('settings.redesign.hooks.active') : kit.tx('settings.redesign.hooks.off'); badge.className = 'cc-panel-status ' + (nowOn ? 'active' : 'inactive'); } updateProjectCount(); }
      } else { alert(data.error || kit.tx('settings.redesign.hooks.failedToToggleHook')); }
    } catch (err) { alert(kit.tx('settings.redesign.hooks.failed2', { message: err.message })); }
    finally { toggleBtn.style.opacity = ''; toggleBtn.style.pointerEvents = ''; }
  }

  // Per-hook toggles (global)
  overlay.querySelectorAll('.cc-toggle[data-cc-scope="global"]').forEach(toggle => {
    toggle.addEventListener('click', () => { ccToggleHook('global', null, toggle, overlay.querySelector('.iface-section[data-cc-target="global"]'), toggle.dataset.ccHook); });
  });

  // Feature toggles
  overlay.querySelectorAll('.cc-toggle[data-cc-feature]').forEach(toggle => {
    toggle.addEventListener('click', async () => {
      const feature = toggle.dataset.ccFeature; const isOn = toggle.classList.contains('on');
      try {
        toggle.style.opacity = '0.4'; toggle.style.pointerEvents = 'none';
        const res = await fetch('/api/claude-code/hook-features', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feature, enabled: !isOn }) });
        const data = await res.json();
        if (data.ok) {
          toggle.classList.toggle('on'); const row = toggle.closest('.cc-integration-item'); if (row) row.classList.toggle('enabled', !isOn);
          // Show/hide greeting body when greeting feature is toggled
          if (feature === 'greeting') {
            const gcBody = overlay.querySelector('#cc-greeting-body');
            if (gcBody) gcBody.style.display = !isOn ? 'block' : 'none';
          }
          // Show/hide user learning threshold when feature is toggled
          if (feature === 'userLearning') {
            const ulThreshold = overlay.querySelector('#cc-ul-threshold');
            if (ulThreshold) ulThreshold.style.display = !isOn ? 'flex' : 'none';
          }
        }
        else { alert(data.error || kit.tx('settings.redesign.hooks.failedToToggleFeature')); }
      } catch (err) { alert(kit.tx('settings.redesign.hooks.failed2', { message: err.message })); }
      finally { toggle.style.opacity = ''; toggle.style.pointerEvents = ''; }
    });
  });

  overlay.querySelectorAll('.cc-toggle[data-codex-greeting-toggle]').forEach(toggle => {
    toggle.addEventListener('click', async () => {
      const isOn = toggle.classList.contains('on');
      try {
        toggle.style.opacity = '0.4';
        toggle.style.pointerEvents = 'none';
        const res = await fetch('/api/codex-panel/greeting/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !isOn }),
        });
        const data = await res.json();
        if (!data.ok) {
          alert(data.error || kit.tx('settings.redesign.hooks.failedToToggleCodexGreeting'));
          return;
        }
        codexGreetingConfig.enabled = !isOn;
        toggle.classList.toggle('on', !isOn);
        const body = overlay.querySelector('#codex-greeting-body');
        if (body) body.style.display = !isOn ? 'block' : 'none';
      } catch (err) {
        alert(kit.tx('settings.redesign.hooks.failed2', { message: err.message }));
      } finally {
        toggle.style.opacity = '';
        toggle.style.pointerEvents = '';
      }
    });
  });

  overlay.querySelectorAll('.cc-toggle[data-opencode-greeting-toggle]').forEach(toggle => {
    toggle.addEventListener('click', async () => {
      const isOn = toggle.classList.contains('on');
      try {
        toggle.style.opacity = '0.4';
        toggle.style.pointerEvents = 'none';
        const res = await fetch('/api/opencode-panel/greeting/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !isOn }),
        });
        const data = await res.json();
        if (!data.ok) {
          alert(data.error || kit.tx('settings.redesign.hooks.failedToToggleOpencodeGreeting'));
          return;
        }
        opencodeGreetingConfig.enabled = !isOn;
        toggle.classList.toggle('on', !isOn);
        const body = overlay.querySelector('#opencode-greeting-body');
        if (body) body.style.display = !isOn ? 'block' : 'none';
      } catch (err) {
        alert(kit.tx('settings.redesign.hooks.failed2', { message: err.message }));
      } finally {
        toggle.style.opacity = '';
        toggle.style.pointerEvents = '';
      }
    });
  });

  // ── Tool Permission toggles ──
  function updateToolBadges() {
    // Update per-category counts across all tabs (Automations + Social)
    let totalOn = 0, totalAll = 0;
    overlay.querySelectorAll('.cc-tool-category').forEach(catEl => {
      const toggles = catEl.querySelectorAll('.cc-toggle[data-cc-tool]');
      const on = [...toggles].filter(t => t.classList.contains('on')).length;
      const countEl = catEl.querySelector('.cc-tool-category-count');
      if (countEl) countEl.textContent = `${on}/${toggles.length}`;
      const allBtn = catEl.querySelector('.cc-tool-category-all');
      if (allBtn) allBtn.classList.toggle('on', on === toggles.length);
      // Only count toward the Automations badge for non-social categories
      if (catEl.dataset.toolCategory !== 'social') {
        totalOn += on;
        totalAll += toggles.length;
      }
    });
    const badge = overlay.querySelector('#cc-tools-badge');
    if (badge) {
      badge.textContent = `${totalOn}/${totalAll}`;
      badge.classList.toggle('all-on', totalOn === totalAll);
    }
  }

  function applyToolPermissionResult(tools) {
    // Apply across all tabs (Automations + Social)
    for (const [key, enabled] of Object.entries(tools)) {
      const toggle = overlay.querySelector(`.cc-toggle[data-cc-tool="${key}"]`);
      if (toggle) {
        toggle.classList.toggle('on', enabled);
        const row = toggle.closest('.cc-integration-item');
        if (row) row.classList.toggle('enabled', enabled);
      }
    }
    updateToolBadges();
  }

  // Individual tool toggles
  overlay.querySelectorAll('.cc-toggle[data-cc-tool]').forEach(toggle => {
    toggle.addEventListener('click', async () => {
      const tool = toggle.dataset.ccTool;
      const isOn = toggle.classList.contains('on');
      try {
        toggle.style.opacity = '0.4'; toggle.style.pointerEvents = 'none';
        const res = await fetch('/api/claude-code/tool-permissions', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool, enabled: !isOn }) });
        const data = await res.json();
        if (data.ok) applyToolPermissionResult(data.tools);
        else alert(data.error || kit.tx('settings.redesign.permissions.failedToToggleTool'));
      } catch (err) { alert(kit.tx('settings.redesign.permissions.failed', { message: err.message })); }
      finally { toggle.style.opacity = ''; toggle.style.pointerEvents = ''; }
    });
  });

  // Category "All" toggles
  overlay.querySelectorAll('.cc-tool-category-all[data-cc-tool-cat]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const category = btn.dataset.ccToolCat;
      const isOn = btn.classList.contains('on');
      try {
        btn.style.opacity = '0.4'; btn.style.pointerEvents = 'none';
        const res = await fetch('/api/claude-code/tool-permissions', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category, enabled: !isOn }) });
        const data = await res.json();
        if (data.ok) applyToolPermissionResult(data.tools);
        else alert(data.error || kit.tx('settings.redesign.permissions.failedToToggleCategory'));
      } catch (err) { alert(kit.tx('settings.redesign.permissions.failed', { message: err.message })); }
      finally { btn.style.opacity = ''; btn.style.pointerEvents = ''; }
    });
  });

  // ── User Learning threshold handler ──
  {
    const ulInput = overlay.querySelector('#cc-ul-threshold-input');
    if (ulInput) {
      let ulDebounce;
      ulInput.addEventListener('input', () => {
        clearTimeout(ulDebounce);
        ulDebounce = setTimeout(async () => {
          const val = Math.max(3, Math.min(30, parseInt(ulInput.value) || 8));
          ulInput.value = val;
          try {
            await fetch('/api/claude-code/hook-features/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'userLearningThreshold', value: val }) });
          } catch { /* silent */ }
        }, 600);
      });
    }
  }

  // ── User Learning max nudges handler ──
  {
    const ulMaxInput = overlay.querySelector('#cc-ul-max-nudges-input');
    if (ulMaxInput) {
      let ulMaxDebounce;
      ulMaxInput.addEventListener('input', () => {
        clearTimeout(ulMaxDebounce);
        ulMaxDebounce = setTimeout(async () => {
          const val = Math.max(1, Math.min(10, parseInt(ulMaxInput.value) || 3));
          ulMaxInput.value = val;
          try {
            await fetch('/api/claude-code/hook-features/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'userLearningMaxNudges', value: val }) });
          } catch { /* silent */ }
        }, 600);
      });
    }
  }

  // ── Greeting editor handlers ──
  function wireGreetingEditor({ prefix, configRef, saveBaseUrl, onSave }) {
    const gcSelect = overlay.querySelector(`#${prefix}-greeting-project`);
    const gcTemplate = overlay.querySelector(`#${prefix}-greeting-template`);
    const gcShowReminders = overlay.querySelector(`#${prefix}-greeting-show-reminders`);
    const gcShowLastSession = overlay.querySelector(`#${prefix}-greeting-show-last-session`);
    const gcReminderList = overlay.querySelector(`#${prefix}-greeting-reminders`);
    const gcAddReminder = overlay.querySelector(`#${prefix}-greeting-add-reminder`);
    const gcSave = overlay.querySelector(`#${prefix}-greeting-save`);
    if (!gcSelect || !gcTemplate || !gcReminderList || !gcSave) return;

    function getGreetingCfg(key) {
      const gc = configRef() || { defaults: {}, projects: {}, global: {} };
      if (key === 'global') return { ...gc.defaults, ...gc.global };
      return { ...gc.defaults, ...(gc.projects[key] || {}) };
    }

    function reminderRowHTML(reminder) {
      return `<div class="cc-greeting-reminder-row">
        <span class="cc-greeting-drag-handle" title="${kit.te('settings.redesign.hooks.dragToReorder')}">&#8942;&#8942;</span>
        <input class="cc-greeting-reminder-input label" placeholder="${kit.te('settings.redesign.hooks.label')}" value="${escapeHtml(reminder.label || '')}">
        <input class="cc-greeting-reminder-input cmd" placeholder="${kit.te('settings.redesign.hooks.command')}" value="${escapeHtml(reminder.command || '')}">
        <button class="cc-greeting-reminder-remove" title="${kit.te('settings.redesign.hooks.remove')}">&times;</button>
      </div>`;
    }

    function wireReminderRemoveButtons() {
      gcReminderList.querySelectorAll('.cc-greeting-reminder-remove').forEach((btn) => {
        btn.onclick = () => {
          const row = btn.closest('.cc-greeting-reminder-row');
          if (!row) return;
          row.style.opacity = '0';
          row.style.transition = 'opacity 0.15s';
          setTimeout(() => row.remove(), 150);
        };
      });
    }

    function wireReminderDragHandles() {
      gcReminderList.querySelectorAll('.cc-greeting-drag-handle').forEach((handle) => {
        handle.onmousedown = (event) => {
          event.preventDefault();
          const row = handle.closest('.cc-greeting-reminder-row');
          if (!row) return;
          row.style.opacity = '0.5';
          const rows = [...gcReminderList.querySelectorAll('.cc-greeting-reminder-row')];
          const startY = event.clientY;
          const startIdx = rows.indexOf(row);
          const onMove = (moveEvent) => {
            const dy = moveEvent.clientY - startY;
            const rowH = row.offsetHeight + 4;
            const shift = Math.round(dy / rowH);
            const newIdx = Math.max(0, Math.min(rows.length - 1, startIdx + shift));
            if (newIdx !== rows.indexOf(row)) {
              const ref = gcReminderList.children[newIdx];
              if (newIdx > rows.indexOf(row)) gcReminderList.insertBefore(row, ref?.nextSibling || null);
              else gcReminderList.insertBefore(row, ref);
            }
          };
          const onUp = () => {
            row.style.opacity = '';
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        };
      });
    }

    function populateGreetingFields(key) {
      const cfg = getGreetingCfg(key);
      gcTemplate.value = cfg.greetingTemplate || '';
      if (gcShowReminders) gcShowReminders.checked = !!cfg.showReminders;
      if (gcShowLastSession) gcShowLastSession.checked = !!cfg.showLastSession;
      gcReminderList.innerHTML = (cfg.reminders || []).map((reminder) => reminderRowHTML(reminder)).join('');
      wireReminderRemoveButtons();
      wireReminderDragHandles();
    }

    const gcDropdown = overlay.querySelector(`#${prefix}-greeting-project-dropdown`);
    const gcDropdownLabel = overlay.querySelector(`#${prefix}-greeting-project-label`);
    const gcDropdownMenu = overlay.querySelector(`#${prefix}-greeting-project-menu`);
    if (gcDropdown && gcDropdownMenu) {
      gcDropdown.querySelector('.cc-dropdown-trigger')?.addEventListener('click', () => {
        gcDropdown.classList.toggle('open');
      });
      gcDropdownMenu.querySelectorAll('.cc-dropdown-item').forEach((item) => {
        item.addEventListener('click', () => {
          const val = item.dataset.value;
          gcSelect.value = val;
          gcSelect.dispatchEvent(new Event('change'));
          if (gcDropdownLabel) gcDropdownLabel.textContent = item.textContent;
          gcDropdownMenu.querySelectorAll('.cc-dropdown-item').forEach((entry) => entry.classList.remove('active'));
          item.classList.add('active');
          gcDropdown.classList.remove('open');
          populateGreetingFields(val);
        });
      });
      document.addEventListener('click', (event) => {
        if (!gcDropdown.contains(event.target)) gcDropdown.classList.remove('open');
      });
    }

    gcAddReminder?.addEventListener('click', () => {
      const tmp = document.createElement('div');
      tmp.innerHTML = reminderRowHTML({ label: '', command: '' });
      const newRow = tmp.firstElementChild;
      gcReminderList.appendChild(newRow);
      wireReminderRemoveButtons();
      wireReminderDragHandles();
      newRow.querySelector('.label')?.focus();
    });

    gcSave.addEventListener('click', async () => {
      const project = gcSelect.value || 'global';
      const reminders = [];
      gcReminderList.querySelectorAll('.cc-greeting-reminder-row').forEach((row) => {
        const label = row.querySelector('.label')?.value?.trim() || '';
        const command = row.querySelector('.cmd')?.value?.trim() || '';
        if (label || command) reminders.push({ label, command });
      });
      const body = {
        greetingTemplate: gcTemplate.value || '',
        showReminders: gcShowReminders?.checked ?? false,
        showLastSession: gcShowLastSession?.checked ?? false,
        reminders,
      };
      gcSave.style.opacity = '0.5';
      gcSave.style.pointerEvents = 'none';
      try {
        const res = await fetch(`${saveBaseUrl}/${encodeURIComponent(project)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!data.ok) {
          alert(data.error || kit.tx('settings.redesign.hooks.failedToSave'));
          return;
        }
        onSave(project, body);
        showCCToast(kit.tx('settings.redesign.hooks.greetingConfigSaved'));
      } catch (err) {
        alert(kit.tx('settings.redesign.hooks.failed2', { message: err.message }));
      } finally {
        gcSave.style.opacity = '';
        gcSave.style.pointerEvents = '';
      }
    });

    wireReminderRemoveButtons();
    wireReminderDragHandles();

    const csToggle = overlay.querySelector(`#${prefix}-greeting-cheatsheet-toggle`);
    const csPanel = overlay.querySelector(`#${prefix}-greeting-cheatsheet`);
    if (csToggle && csPanel) {
      const updateCheatsheetPreview = () => {
        const hour = new Date().getHours();
        const timeGreeting = hour >= 5 && hour < 12 ? kit.tx('settings.redesign.hooks.goodMorning') : hour >= 12 && hour < 17 ? kit.tx('settings.redesign.hooks.goodAfternoon') : kit.tx('settings.redesign.hooks.goodEvening');
        const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const key = gcSelect.value || 'global';
        const gc = configRef() || {};
        const projCfg = key === 'global' ? gc.global : gc.projects?.[key];
        const label = projCfg?.label || key;
        const name = key === 'global' ? 'global' : key;

        overlay.querySelector(`#${prefix}-cs-time`).textContent = timeGreeting;
        overlay.querySelector(`#${prefix}-cs-label`).textContent = label;
        overlay.querySelector(`#${prefix}-cs-name`).textContent = name;
        overlay.querySelector(`#${prefix}-cs-branch`).textContent = kit.tx('settings.redesign.hooks.dev');
        overlay.querySelector(`#${prefix}-cs-date`).textContent = dateStr;

        const tpl = gcTemplate.value || '{time_greeting}! Working on **{project_label}** ({branch} branch). {date}.';
        const resolved = tpl
          .replace(/\{time_greeting\}/g, timeGreeting)
          .replace(/\{project_label\}/g, label)
          .replace(/\{project_name\}/g, name)
          .replace(/\{branch\}/g, 'dev')
          .replace(/\{date\}/g, dateStr)
          .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
          .replace(/`(.+?)`/g, '<code>$1</code>');
        overlay.querySelector(`#${prefix}-cs-preview`).innerHTML = resolved;
      };

      csToggle.addEventListener('click', () => {
        const open = csPanel.style.display !== 'none';
        csPanel.style.display = open ? 'none' : 'block';
        csToggle.classList.toggle('open', !open);
        if (!open) updateCheatsheetPreview();
      });
      gcSelect.addEventListener('change', () => {
        if (csPanel.style.display !== 'none') updateCheatsheetPreview();
      });
      gcTemplate.addEventListener('input', () => {
        if (csPanel.style.display !== 'none') updateCheatsheetPreview();
      });
    }
  }

  wireGreetingEditor({
    prefix: 'cc',
    configRef: () => greetingConfig,
    saveBaseUrl: '/api/greeting/config',
    onSave: (project, body) => {
      const target = project === 'global'
        ? (greetingConfig.global || (greetingConfig.global = {}))
        : (greetingConfig.projects[project] || (greetingConfig.projects[project] = {}));
      Object.assign(target, body);
    },
  });

  wireGreetingEditor({
    prefix: 'codex',
    configRef: () => codexGreetingConfig,
    saveBaseUrl: '/api/codex-panel/greeting/config',
    onSave: (project, body) => {
      const target = project === 'global'
        ? (codexGreetingConfig.global || (codexGreetingConfig.global = {}))
        : (codexGreetingConfig.projects[project] || (codexGreetingConfig.projects[project] = {}));
      Object.assign(target, body);
    },
  });

  wireGreetingEditor({
    prefix: 'opencode',
    configRef: () => opencodeGreetingConfig,
    saveBaseUrl: '/api/opencode-panel/greeting/config',
    onSave: (project, body) => {
      const target = project === 'global'
        ? (opencodeGreetingConfig.global || (opencodeGreetingConfig.global = {}))
        : (opencodeGreetingConfig.projects[project] || (opencodeGreetingConfig.projects[project] = {}));
      Object.assign(target, body);
    },
  });

  // Per-project toggles
  overlay.querySelectorAll('.cc-enable-btn[data-cc-project-toggle]').forEach(btn => {
    btn.addEventListener('click', () => { const idx = btn.dataset.ccProjectToggle; const panel = overlay.querySelector(`.cc-panel[data-cc-idx="${idx}"]`); const projectPath = panel?.dataset.ccPath; if (projectPath) ccToggleHook('project', projectPath, btn, panel); });
  });

  // Skill target chips — one skill can be installed independently into Claude / Codex / OpenCode
  const runtimeLabels = { claude: 'Claude Code', codex: 'Codex CLI', opencode: 'OpenCode CLI' };
  overlay.querySelectorAll('.cc-skill-target[data-cc-skill]').forEach(chip => {
    chip.addEventListener('click', async () => {
      const skillName = chip.dataset.ccSkill;
      const target = chip.dataset.ccTarget;
      const isOn = chip.classList.contains('on');
      try {
        chip.style.opacity = '0.4'; chip.style.pointerEvents = 'none';
        const res = await fetch('/api/skills/install', {
          method: isOn ? 'DELETE' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: skillName, target }),
        });
        const data = await res.json();
        if (data.ok) {
          chip.classList.toggle('on');
          chip.dataset.state = isOn ? 'off' : 'on';
          const row = chip.closest('.cc-skill-row');
          if (row) {
            const anyOn = !!row.querySelector('.cc-skill-target.on');
            row.classList.toggle('installed', anyOn);
          }
          const runtime = runtimeLabels[target] || target;
          showCCToast(isOn ? kit.tx('settings.redesign.hooks.skillUninstalledRestartToApply', { runtime: runtime }) : kit.tx('settings.redesign.hooks.skillInstalledRestartToApply', { runtime: runtime }));
        } else { alert(data.error || kit.tx('settings.redesign.hooks.failedToToggleSkill')); }
      } catch (err) { alert(kit.tx('settings.redesign.hooks.failed2', { message: err.message })); }
      finally { chip.style.opacity = ''; chip.style.pointerEvents = ''; }
    });
  });

  // ── Setup tab: per-provider MCP toggles, CLI copy, config copy, SynaBun rules ──
  {
    const checkIcon = '<svg viewBox="0 0 24 24" style="width:12px;height:12px"><polyline points="20 6 9 17 4 12"/></svg>';
    const copyBtnIcon = COPY_ICON;

    // Helper: wire a MCP toggle for any provider
    function wireSetupMcpToggle(provider, apiPath, configLabel) {
      const toggle = overlay.querySelector(`#setup-${provider}-mcp-toggle`);
      if (!toggle) return;
      toggle.addEventListener('click', async () => {
        const isOn = toggle.classList.contains('on');
        try {
          toggle.style.opacity = '0.4'; toggle.style.pointerEvents = 'none';
          const res = await fetch(apiPath, { method: isOn ? 'DELETE' : 'POST' });
          const data = await res.json();
          if (data.ok) {
            const nowOn = !isOn;
            toggle.classList.toggle('on');
            const row = overlay.querySelector(`#setup-${provider}-mcp-row`);
            if (row) row.classList.toggle('enabled', nowOn);
            const status = overlay.querySelector(`#setup-${provider}-mcp-status`);
            if (status) status.textContent = nowOn ? kit.tx('settings.redesign.setup.registeredIn2', { configLabel: configLabel }) : kit.tx('settings.redesign.setup.notConnected');
            const badge = overlay.querySelector(`#setup-${provider} .gfx-group-title .setup-status-badge`);
            if (badge) { badge.className = `setup-status-badge ${nowOn ? 'active' : 'inactive'}`; badge.textContent = nowOn ? kit.tx('settings.redesign.setup.connected') : kit.tx('settings.redesign.setup.off'); }
            // Connecting a tool installs its rules, disconnecting removes them
            // (the `rules` object in the response). Say what happened.
            if (data.rules?.ok === false && data.rules.error) showCCToast(data.rules.error, 6000);
            else if (nowOn && data.rules?.changed && data.rules.path) showCCToast(kit.tx('settings.redesign.setup.rulesInstalled', { path: data.rules.path }));
            else if (!nowOn && data.rules?.kept?.length) showCCToast(kit.tx('settings.redesign.setup.yourRulesWereLeftInPlace', { reason: data.rules.kept[0].reason === 'listed-in-config' ? '' : (kit.tx('settings.redesign.setup.edited') + " "), path: data.rules.kept[0].path }), 6000);
            else if (!nowOn && data.rules?.changed) showCCToast(kit.tx('settings.redesign.setup.rulesRemoved'));
            refreshRules();
          } else { alert(data.error || kit.tx('settings.redesign.setup.failed')); }
        } catch (err) { alert(kit.tx('settings.redesign.setup.failed2', { message: err.message })); }
        finally { toggle.style.opacity = ''; toggle.style.pointerEvents = ''; }
      });
    }

    // Helper: wire a copy button
    function wireCopyBtn(id, getText, originalLabel) {
      const btn = overlay.querySelector(`#${id}`);
      if (!btn) return;
      btn.addEventListener('click', () => {
        const text = getText();
        if (!text) { alert(kit.tx('settings.redesign.setup.contentNotAvailable')); return; }
        navigator.clipboard.writeText(text);
        btn.innerHTML = kit.th('settings.redesign.setup.copied', { checkIcon: checkIcon });
        setTimeout(() => { btn.innerHTML = `${copyBtnIcon} ${originalLabel}`; }, 2000);
      });
    }

    // ── SynaBun rules ──
    // One status for the whole tab (GET /api/setup/rules), read again after
    // every action. `null` means the route is missing or failed, which is what
    // a server that was not restarted after the update answers: the tab keeps
    // View and Copy and says what to do, and offers no control that cannot work.
    const RESTART_HINT = kit.tx('settings.redesign.setup.restartSynabunToFinishThisUpdate');
    const RULES_HOST_LABELS = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', gemini: 'Gemini', cursor: 'Cursor', coexistence: 'coexistence' };
    const RULES_BADGES = {
      installed: [kit.tx('settings.redesign.setup.installed'), true], newer: [kit.tx('settings.redesign.setup.newer'), true], outdated: [kit.tx('settings.redesign.setup.updateAvailable'), false], modified: [kit.tx('settings.redesign.setup.edited2'), false],
      conflict: [kit.tx('settings.redesign.setup.conflict'), false], error: [kit.tx('settings.redesign.setup.error'), false], shadowed: [kit.tx('settings.redesign.setup.shadowed'), false],
      'not-installed': [kit.tx('settings.redesign.setup.notInstalled'), false], manual: [kit.tx('settings.redesign.setup.copyOnly'), false],
    };
    let rulesStatus = setupStatus.rules?.ok ? setupStatus.rules : null;
    // What the last "install for all" wrote and where, shown under that button until the next rules action.
    let installNote = '';
    const rulesRenderers = [];
    const setShown = (el, shown) => { if (el) el.style.display = shown ? '' : 'none'; };
    const renderRules = () => {
      for (const render of rulesRenderers) {
        try { render(); } catch (err) { console.warn('[setup] rules render failed:', err); }
      }
    };
    async function refreshRules() {
      rulesStatus = await fetchRulesStatus();
      renderRules();
      emit('rules:changed', rulesStatus);
    }
    // Run one rules action from a button, report it, then re-read the status.
    async function runRulesAction(btn, action, describe) {
      installNote = '';
      btn.style.opacity = '0.4'; btn.style.pointerEvents = 'none';
      try { showCCToast(describe(await action())); }
      catch (err) { showCCToast(err?.message || kit.tx('settings.redesign.setup.rulesActionFailed'), 6000); }
      finally { btn.style.opacity = ''; btn.style.pointerEvents = ''; }
      await refreshRules();
    }

    // Helper: the rules controls of one provider section. `host` is the name
    // the rules API uses (lib/rulesets). Sections without a primary button
    // (Cursor, the coexistence snippet) are copy-only.
    function wireRulesControls(provider, host) {
      const el = (suffix) => overlay.querySelector(`#setup-${provider}-rules-${suffix}`);
      const viewBtn = el('view');
      const copyBtn = el('copy');
      const textBox = el('text');
      if (!viewBtn || !copyBtn || !textBox) return;
      const label = RULES_HOST_LABELS[host] || host;

      let cachedText = '';
      const loadText = async () => {
        if (!cachedText) cachedText = await fetchRulesTextWithFallback(host);
        return cachedText;
      };
      viewBtn.addEventListener('click', async () => {
        if (textBox.style.display !== 'none') { setShown(textBox, false); viewBtn.textContent = kit.tx('settings.redesign.setup.view'); return; }
        try { textBox.textContent = await loadText(); }
        catch { textBox.textContent = RESTART_HINT; }
        setShown(textBox, true);
        viewBtn.textContent = kit.tx('settings.redesign.setup.hide');
      });
      copyBtn.addEventListener('click', async () => {
        let text;
        try { text = await loadText(); }
        catch { showCCToast(kit.tx('settings.redesign.setup.couldNotLoadTheRules', { label: label, RESTART_HINT: RESTART_HINT }), 6000); return; }
        try {
          await navigator.clipboard.writeText(text);
          copyBtn.innerHTML = kit.th('settings.redesign.setup.copied', { checkIcon: checkIcon });
          setTimeout(() => { copyBtn.innerHTML = kit.th('settings.redesign.setup.copy', { copyBtnIcon: copyBtnIcon }); }, 2000);
        } catch {
          // A refused clipboard is the browser's doing; restarting SynaBun would not help.
          showCCToast(kit.tx('settings.redesign.setup.couldNotCopyTheRulesThe', { label: label }), 6000);
        }
      });

      const primary = el('primary');
      const removeBtn = el('remove');
      if (!primary || !removeBtn) return;
      const badge = el('badge');
      const pathEl = el('path');
      const message = el('message');
      const row = el('row');

      rulesRenderers.push(() => {
        const info = rulesStatus?.hosts?.[host];
        if (!info) {
          badge.className = 'setup-status-badge inactive';
          badge.textContent = kit.tx('settings.redesign.setup.unavailable');
          pathEl.textContent = RESTART_HINT;
          row.classList.remove('enabled');
          setShown(message, false); setShown(primary, false); setShown(removeBtn, false);
          return;
        }
        const [text, good] = RULES_BADGES[info.state] || [info.state || kit.tx('settings.redesign.setup.unknown'), false];
        badge.className = `setup-status-badge ${good ? 'active' : 'inactive'}`;
        badge.textContent = text;
        row.classList.toggle('enabled', good);
        pathEl.textContent = info.installedVersion ? `${info.path} (v${info.installedVersion})` : (info.path || '');
        pathEl.title = info.path || '';
        // The action the state calls for; conflict, error and shadowed only explain themselves.
        const action = info.detected === false ? '' : ({ 'not-installed': kit.tx('settings.redesign.setup.install'), outdated: kit.tx('settings.redesign.setup.update'), modified: kit.tx('settings.redesign.setup.replace') }[info.state] || '');
        // A file without SynaBun's markers is the user's own: the server refuses to replace it, so no button.
        const canAct = !!action && info.replaceable !== false;
        primary.textContent = canAct ? action : '';
        setShown(primary, canAct);
        setShown(removeBtn, ['installed', 'newer', 'outdated', 'modified', 'shadowed'].includes(info.state));
        // An edited copy is the user's: nothing replaces or removes it without the confirm behind each button.
        const editedNote = kit.tx('settings.redesign.setup.thisCopyWasEditedSoSynabun');
        const stateNote = info.detected === false ? kit.tx('settings.redesign.setup.wasNotFoundOnThisMachine', { label: label })
          : info.state === 'modified' ? (info.replaceable === false ? (info.detail || '') : editedNote)
          : info.state === 'outdated' ? (rulesStatus.version ? kit.tx('settings.redesign.setup.versionOfTheRulesIsAvailable', { version: rulesStatus.version }) : kit.tx('settings.redesign.setup.aNewerVersionOfTheRules'))
          : ['conflict', 'error', 'shadowed', 'newer'].includes(info.state) ? (info.error || info.detail || '')
          : '';
        // A removal that could not finish left rules behind: say which, until a remove or an install completes.
        const partial = info.partialRemoval?.error ? kit.tx('settings.redesign.setup.theLastRemovalDidNotFinish', { error: info.partialRemoval.error }) : '';
        const note = partial && stateNote && !partial.includes(stateNote) ? `${partial} ${stateNote}` : (partial || stateNote);
        message.textContent = note;
        setShown(message, !!note);
      });

      primary.addEventListener('click', () => {
        const state = rulesStatus?.hosts?.[host]?.state;
        const force = state === 'modified';
        if (force && !confirm(kit.tx('settings.redesign.setup.replaceYourEditedRulesWithSynabun', { label: label }))) return;
        cachedText = '';
        runRulesAction(primary, () => installRules(host, { force }), (result) => (result.changed
          ? kit.tx(state === 'not-installed' ? 'settings.redesign.setup.rulesInstalled2' : 'settings.redesign.setup.rulesUpdated2', { label })
          : kit.tx('settings.redesign.setup.rulesAreAlreadyCurrent', { label: label })));
      });
      removeBtn.addEventListener('click', () => {
        const info = rulesStatus?.hosts?.[host];
        // An edited copy is removed only on an explicit yes (force). A file without SynaBun's markers is the
        // user's own and stays whatever is sent, so there is nothing to confirm for it.
        const edited = info?.state === 'modified' && info.replaceable !== false;
        // OpenCode: a line in config.json that SynaBun did not add keeps the file on a plain remove (the answer
        // says so, and the host is then no longer managed). Asked again, the confirm sends force, which takes that line too.
        const listed = info?.entry === 'user';
        const force = edited || (listed && info.managed === false);
        const lineToo = listed ? (" " + kit.tx('settings.redesign.setup.theLineInConfigJsonThat')) : '';
        if (force && !confirm(kit.tx('settings.redesign.setup.aBackupIsKept', { edited: edited ? kit.tx('settings.redesign.setup.youEditedTheseRulesRemoveThem', { label: label }) : kit.tx('settings.redesign.setup.removeTheseRules', { label: label }), lineToo: lineToo }))) return;
        runRulesAction(removeBtn, () => removeRules(host, { force }), (result) => (result.kept?.length
          ? (result.kept[0].reason === 'listed-in-config'
            ? kit.tx('settings.redesign.setup.rulesWereLeftInPlaceConfig', { label: label })
            : kit.tx('settings.redesign.setup.yourEditedRulesWereLeftIn', { label: label, path: result.kept[0].path }))
          : kit.tx('settings.redesign.setup.rulesRemoved2', { label: label })));
      });
    }

    // ── Rules: automatic updates, install for all, pasted copies ──
    {
      const autoToggle = overlay.querySelector('#setup-rules-autoupdate');
      const autoRow = overlay.querySelector('#setup-rules-autoupdate-row');
      const installAllBtn = overlay.querySelector('#setup-rules-install-all');
      const message = overlay.querySelector('#setup-rules-message');
      const legacyBox = overlay.querySelector('#setup-rules-legacy');
      const versionBadge = overlay.querySelector('#setup-rules-version');
      const hostOf = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', gemini: 'Gemini' };

      if (autoToggle && installAllBtn && legacyBox) {
        rulesRenderers.push(() => {
          const ready = !!rulesStatus;
          const autoOn = ready && rulesStatus.autoUpdate !== false;
          autoToggle.classList.toggle('on', autoOn);
          autoRow?.classList.toggle('enabled', autoOn);
          autoToggle.style.opacity = ready ? '' : '0.4';
          autoToggle.style.pointerEvents = ready ? '' : 'none';
          setShown(installAllBtn.closest('.stg-help-line') || installAllBtn, ready);
          if (versionBadge) { versionBadge.textContent = ready && rulesStatus.version ? `v${rulesStatus.version}` : ''; setShown(versionBadge, ready && !!rulesStatus.version); }
          if (message) {
            const note = ready ? installNote : kit.tx('settings.redesign.setup.untilThenTheRulesCanOnly', { RESTART_HINT: RESTART_HINT });
            message.textContent = note;
            setShown(message, !!note);
          }

          // Copies of an older ruleset someone pasted into an instruction file.
          const legacy = ready && Array.isArray(rulesStatus.legacy) ? rulesStatus.legacy : [];
          setShown(legacyBox, legacy.length > 0);
          legacyBox.innerHTML = legacy.length ? `
            <div class="cc-greeting-label stg-row-label" style="margin-bottom:4px">${kit.te('settings.redesign.setup.pastedCopies')}</div>
            <div class="setup-hint" style="margin-bottom:6px">${kit.te('settings.redesign.setup.theseFilesStillHoldAnOlder')}</div>
            ${legacy.map((entry, index) => `
            <div class="cc-integration-item">
              <div class="cc-integration-info">
                <div class="cc-integration-label">${escapeHtml(String(entry.path || '').split(/[\\/]/).pop() || kit.tx('settings.redesign.setup.file'))} &middot; ${escapeHtml(hostOf[entry.host] || entry.host || '')}</div>
                <div class="cc-integration-path" title="${escapeHtml(entry.path || '')}">${escapeHtml(entry.path || '')}</div>
              </div>
              ${entry.kind === 'exact'
                ? `<button class="cc-copy-btn stg-text-btn stg-text-btn-danger" data-rules-legacy="${index}" style="width:auto;flex-shrink:0">${kit.te('settings.redesign.setup.removePastedCopy')}</button>`
                : '<span class="setup-status-badge inactive" title="' + kit.te('settings.redesign.setup.theTextWasChangedAfterIt') + '">' + kit.te('settings.redesign.setup.possibleDuplicate') + '</span>'}
            </div>`).join('')}` : '';
          legacyBox.querySelectorAll('[data-rules-legacy]').forEach((btn) => {
            btn.addEventListener('click', () => {
              const entry = legacy[Number(btn.dataset.rulesLegacy)];
              if (!entry) return;
              if (!confirm(kit.tx('settings.redesign.setup.removeThePastedSynabunRulesFrom', { path: entry.path }))) return;
              runRulesAction(btn, () => removeLegacyRules(entry.path), (result) => (result.changed ? kit.tx('settings.redesign.setup.pastedCopyRemoved') : kit.tx('settings.redesign.setup.nothingToRemove')));
            });
          });
        });

        autoToggle.addEventListener('click', () => {
          const next = !autoToggle.classList.contains('on');
          runRulesAction(autoToggle, () => setRulesAutoUpdate(next), () => (next ? kit.tx('settings.redesign.setup.rulesWillBeKeptUpTo') : kit.tx('settings.redesign.setup.automaticRuleUpdatesAreOff')));
        });
        installAllBtn.addEventListener('click', () => {
          runRulesAction(installAllBtn, () => installAllRules(), (result) => {
            const rows = Object.entries(result.results || {});
            if (!rows.length) return kit.tx('settings.redesign.setup.noConnectedToolNeedsRules');
            // The file each tool reads. The rules are global, so a project's own CLAUDE.md and AGENTS.md stay as they are.
            const where = rows.filter(([, row]) => row.ok !== false && row.path).map(([host, row]) => `${hostOf[host] || host}: ${row.path}`).join(' · ');
            if (where) installNote = kit.tx('settings.redesign.setup.rulesInstalledAt', { where: where });
            const failed = rows.filter(([, row]) => row.ok === false);
            if (failed.length) return kit.tx('settings.redesign.setup.installedWithFailure', { count: rows.length - failed.length, host: hostOf[failed[0][0]] || failed[0][0], error: failed[0][1].error || failed[0][1].state });
            const map = rows.map(([host]) => hostOf[host] || host).join(', ');
            return kit.tx(rows.some(([, row]) => row.changed) ? 'settings.redesign.setup.rulesInstalledFor' : 'settings.redesign.setup.rulesAlreadyCurrentFor', { map: map });
          });
        });
      }
    }

    // ── Claude ──
    wireSetupMcpToggle('claude', '/api/claude-code/mcp', '~/.claude.json');
    wireCopyBtn('setup-claude-cli-copy', () => setupStatus.claude?.cliCommand || ccIntegrations.mcp?.cliCommand || '', kit.tx('settings.redesign.setup.copyCliCommand'));
    wireRulesControls('claude', 'claude');

    // ── Gemini ──
    wireSetupMcpToggle('gemini', '/api/setup/gemini/mcp', '~/.gemini/settings.json');
    // Config preview
    {
      const preview = overlay.querySelector('#setup-gemini-config-preview');
      let cachedConfig = '';
      if (preview) {
        fetch('/api/setup/gemini/mcp').then(r => r.json()).then(data => {
          if (data.ok && data.config) {
            cachedConfig = JSON.stringify(data.config, null, 2);
            preview.textContent = cachedConfig;
          } else if (data.ok) {
            cachedConfig = JSON.stringify({ mcpServers: { SynaBun: { command: 'node', args: [setupStatus.paths?.mcpIndexPath || '<path-to>/mcp-server/run.mjs'], env: { DOTENV_PATH: setupStatus.paths?.envPath || '<path-to>/synabun/.env' } } } }, null, 2);
            preview.textContent = cachedConfig;
          } else { preview.textContent = kit.tx('settings.redesign.setup.couldNotLoadConfig'); }
        }).catch(() => { preview.textContent = kit.tx('settings.redesign.setup.failedToLoad'); });
      }
      wireCopyBtn('setup-gemini-config-copy', () => cachedConfig, kit.tx('settings.redesign.setup.copyJsonConfig'));
    }
    wireRulesControls('gemini', 'gemini');

    // ── Codex ──
    wireSetupMcpToggle('codex', '/api/setup/codex/mcp', '~/.codex/config.toml');
    wireCopyBtn('setup-codex-cli-copy', () => setupStatus.codex?.cliCommand || '', kit.tx('settings.redesign.setup.copyCliCommand'));
    // Config preview
    {
      const preview = overlay.querySelector('#setup-codex-config-preview');
      let cachedConfig = '';
      if (preview) {
        fetch('/api/setup/codex/mcp').then(r => r.json()).then(data => {
          if (data.ok && data.toml) {
            cachedConfig = data.toml;
            preview.textContent = cachedConfig;
          } else if (data.ok) {
            const mp = setupStatus.paths?.mcpIndexPath || '<path-to>/mcp-server/run.mjs';
            const ep = setupStatus.paths?.envPath || '<path-to>/synabun/.env';
            const dataHome = setupStatus.paths?.dataHome || '<path-to>/synabun';
            cachedConfig = `[mcp_servers.SynaBun]\ncommand = "node"\nargs = ["${mp}"]\nenv = { DOTENV_PATH = "${ep}", SYNABUN_DATA_HOME = "${dataHome}", MEMORY_DATA_DIR = "${dataHome}/mcp-data", SYNABUN_PROFILE = "full", SYNABUN_BROWSER_FAST = "1", SYNABUN_BROWSER_COMPACT = "1", SYNABUN_TOOL_CATALOG_MODE = "deferred" }`;
            preview.textContent = cachedConfig;
          } else { preview.textContent = kit.tx('settings.redesign.setup.couldNotLoadConfig'); }
        }).catch(() => { preview.textContent = kit.tx('settings.redesign.setup.failedToLoad'); });
      }
      wireCopyBtn('setup-codex-config-copy', () => cachedConfig, kit.tx('settings.redesign.setup.copyTomlConfig'));
    }
    wireRulesControls('codex', 'codex');

    // ── OpenCode ──
    wireSetupMcpToggle('opencode', '/api/opencode/mcp', '~/.config/opencode/config.json');
    // Config preview — OpenCode stores MCP servers under the "mcp" key of config.json
    {
      const preview = overlay.querySelector('#setup-opencode-config-preview');
      let cachedConfig = '';
      if (preview) {
        const mp = setupStatus.paths?.mcpIndexPath || '<path-to>/mcp-server/run.mjs';
        const ep = setupStatus.paths?.envPath || '<path-to>/synabun/.env';
        fetch('/api/opencode/mcp').then(r => r.json()).then(data => {
          if (data.ok && data.data && Object.keys(data.data).length) {
            cachedConfig = JSON.stringify({ mcp: data.data }, null, 2);
            preview.textContent = cachedConfig;
          } else if (data.ok) {
            cachedConfig = JSON.stringify({
              mcp: {
                SynaBun: {
                  type: 'stdio',
                  command: 'node',
                  args: [mp],
                  env: { DOTENV_PATH: ep },
                },
              },
            }, null, 2);
            preview.textContent = cachedConfig;
          } else { preview.textContent = kit.tx('settings.redesign.setup.couldNotLoadConfig'); }
        }).catch(() => { preview.textContent = kit.tx('settings.redesign.setup.failedToLoad'); });
      }
      wireCopyBtn('setup-opencode-config-copy', () => cachedConfig, kit.tx('settings.redesign.setup.copyJsonConfig'));
    }
    wireRulesControls('opencode', 'opencode');

    // ── Copy-only: Cursor's User Rules and the coexistence snippet ──
    wireRulesControls('cursor', 'cursor');
    wireRulesControls('coexistence', 'coexistence');

    // The status came with /api/setup/status when the server has it; otherwise ask once.
    if (rulesStatus) renderRules();
    else refreshRules();
  }

  // ── Browser config (Browser tab) ──
  {
    // Sub-group collapsing
    overlay.querySelectorAll('.browser-cfg-group-title[data-collapsible-sub]').forEach(title => {
      title.addEventListener('click', () => {
        title.closest('.browser-cfg-group').classList.toggle('expanded');
      });
    });

    // Helper: get/set toggle state
    const bcToggle = (id) => overlay.querySelector(`#${id}`);
    const isToggleOn = (id) => bcToggle(id)?.classList.contains('on') || false;
    const setToggle = (id, on) => { const t = bcToggle(id); if (t) { t.classList.toggle('on', on); } };

    // Wire toggle clicks
    // Stream toggle — warn on enable
    const streamToggle = bcToggle('bc-screencastEnabled');
    if (streamToggle) {
      streamToggle.addEventListener('click', () => {
        streamToggle.classList.toggle('on');
        if (streamToggle.classList.contains('on')) {
          alert(kit.tx('settings.redesign.browser.browserStreamConsumesSignificantGpuResou'));
        }
      });
    }

    const toggleIds = [
      'bc-isMobile', 'bc-hasTouch', 'bc-stealthFingerprint', 'bc-geoEnabled',
      'bc-offline', 'bc-javaScriptEnabled', 'bc-ignoreHTTPSErrors', 'bc-bypassCSP',
      'bc-acceptDownloads', 'bc-strictSelectors', 'bc-persistStorage',
      'bc-clearStorageOnStart', 'bc-recordVideo', 'bc-recordHar',
    ];
    toggleIds.forEach(id => {
      const el = overlay.querySelector(`#${id}`);
      if (el) el.addEventListener('click', () => el.classList.toggle('on'));
    });

    // Wire all bc-dropdown custom selects
    overlay.querySelectorAll('.bc-dropdown').forEach(dd => {
      const trigger = dd.querySelector('.cc-dropdown-trigger');
      const menu = dd.querySelector('.cc-dropdown-menu');
      const label = dd.querySelector('.cc-dropdown-value');
      const hiddenId = dd.dataset.for;
      const hidden = hiddenId ? overlay.querySelector(`#${hiddenId}`) : null;
      if (!trigger || !menu) return;

      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        if (dd.classList.contains('disabled')) return;
        // Close other open dropdowns first
        overlay.querySelectorAll('.bc-dropdown.open').forEach(other => {
          if (other !== dd) other.classList.remove('open');
        });
        dd.classList.toggle('open');
      });

      menu.querySelectorAll('.cc-dropdown-item').forEach(item => {
        item.addEventListener('click', () => {
          const val = item.dataset.value;
          if (hidden) hidden.value = val;
          if (label) label.textContent = item.textContent;
          menu.querySelectorAll('.cc-dropdown-item').forEach(i => i.classList.remove('active'));
          item.classList.add('active');
          dd.classList.remove('open');
        });
      });
    });

    // Close dropdowns on outside click
    document.addEventListener('click', (e) => {
      overlay.querySelectorAll('.bc-dropdown.open').forEach(dd => {
        if (!dd.contains(e.target)) dd.classList.remove('open');
      });
    });

    // Sync dropdown display from hidden input value (for applyBrowserConfig)
    function syncBcDropdowns() {
      overlay.querySelectorAll('.bc-dropdown').forEach(dd => {
        const hiddenId = dd.dataset.for;
        const hidden = hiddenId ? overlay.querySelector(`#${hiddenId}`) : null;
        if (!hidden) return;
        const val = hidden.value;
        const label = dd.querySelector('.cc-dropdown-value');
        const menu = dd.querySelector('.cc-dropdown-menu');
        if (!menu) return;
        menu.querySelectorAll('.cc-dropdown-item').forEach(item => {
          const isMatch = item.dataset.value === val;
          item.classList.toggle('active', isMatch);
          if (isMatch && label) label.textContent = item.textContent;
        });
        // Sync disabled state
        dd.classList.toggle('disabled', !!hidden.disabled);
        const trigger = dd.querySelector('.cc-dropdown-trigger');
        if (trigger) trigger.disabled = !!hidden.disabled;
      });
    }

    // Geo toggle → enable/disable geo fields
    const geoToggle = bcToggle('bc-geoEnabled');
    if (geoToggle) {
      geoToggle.addEventListener('click', () => {
        const on = isToggleOn('bc-geoEnabled');
        ['bc-geoLatitude', 'bc-geoLongitude', 'bc-geoAccuracy'].forEach(id => {
          const inp = overlay.querySelector(`#${id}`);
          if (inp) inp.disabled = !on;
        });
      });
    }

    // Persist storage toggle → enable/disable storage path
    const persistToggle = bcToggle('bc-persistStorage');
    if (persistToggle) {
      persistToggle.addEventListener('click', () => {
        const on = isToggleOn('bc-persistStorage');
        const inp = overlay.querySelector('#bc-storageStatePath');
        if (inp) inp.disabled = !on;
      });
    }

    // Record video toggle → enable/disable video fields
    const vidToggle = bcToggle('bc-recordVideo');
    if (vidToggle) {
      vidToggle.addEventListener('click', () => {
        const on = isToggleOn('bc-recordVideo');
        ['bc-recordVideoDir', 'bc-recordVideoWidth', 'bc-recordVideoHeight'].forEach(id => {
          const inp = overlay.querySelector(`#${id}`);
          if (inp) inp.disabled = !on;
        });
      });
    }

    // Record HAR toggle → enable/disable HAR fields + dropdowns
    const harToggle = bcToggle('bc-recordHar');
    if (harToggle) {
      harToggle.addEventListener('click', () => {
        const on = isToggleOn('bc-recordHar');
        ['bc-recordHarPath', 'bc-recordHarContent', 'bc-recordHarMode', 'bc-recordHarUrlFilter'].forEach(id => {
          const inp = overlay.querySelector(`#${id}`);
          if (inp) inp.disabled = !on;
          // Also toggle dropdown container
          const dd = overlay.querySelector(`.bc-dropdown[data-for="${id}"]`);
          if (dd) {
            dd.classList.toggle('disabled', !on);
            const trigger = dd.querySelector('.cc-dropdown-trigger');
            if (trigger) trigger.disabled = !on;
          }
        });
      });
    }

    // Screencast quality range → value display
    const scRange = overlay.querySelector('#bc-screencastQuality');
    const scVal = overlay.querySelector('#bc-screencastQuality-val');
    if (scRange && scVal) {
      scRange.addEventListener('input', () => { scVal.textContent = scRange.value; });
    }

    // Auto-detect executable
    const detectBtn = overlay.querySelector('#bc-detect-executable');
    if (detectBtn) {
      detectBtn.addEventListener('click', async () => {
        detectBtn.style.opacity = '0.4'; detectBtn.style.pointerEvents = 'none';
        try {
          const res = await fetch('/api/browser/config');
          const data = await res.json();
          const hint = overlay.querySelector('#bc-detected-path');
          if (data.detectedPath) {
            if (hint) hint.textContent = kit.tx('settings.redesign.browser.detected', { detectedPath: data.detectedPath });
            const inp = overlay.querySelector('#bc-executablePath');
            if (inp && !inp.value.trim()) inp.value = data.detectedPath;
          } else {
            if (hint) hint.textContent = kit.tx('settings.redesign.browser.noChromeChromiumFoundPlaywrightWill');
          }
        } catch (err) {
          const hint = overlay.querySelector('#bc-detected-path');
          if (hint) hint.textContent = kit.tx('settings.redesign.browser.detectionFailed', { message: err.message });
        } finally { detectBtn.style.opacity = ''; detectBtn.style.pointerEvents = ''; }
      });
    }

    // ── Browser selector → executablePath/channel sync ──
    const browserDropdown = overlay.querySelector('#bc-browser-dropdown');
    if (browserDropdown) {
      const bcMenu = browserDropdown.querySelector('.cc-dropdown-menu');
      if (bcMenu) {
        bcMenu.querySelectorAll('.cc-dropdown-item').forEach(item => {
          item.addEventListener('click', () => {
            const val = item.dataset.value;
            const execInput = overlay.querySelector('#bc-executablePath');
            const channelInput = overlay.querySelector('#bc-channel');
            const pathRow = overlay.querySelector('#bc-executablePath')?.closest('.bc-card-row');
            const connectHidden = overlay.querySelector('#bc-connectMode');
            const wasMoreLogin = connectHidden?.value === 'morelogin';

            if (val === 'morelogin') {
              // MoreLogin is a browser backend — mirror it into the Connection dropdown.
              if (channelInput) channelInput.value = '';
              if (execInput) execInput.value = '';
              if (pathRow) pathRow.style.display = '';
              if (connectHidden) connectHidden.value = 'morelogin';
              syncBcDropdowns();
              applyMoreLoginMode(true);
              return;
            }
            // Leaving MoreLogin → revert the Connection dropdown to Mirror.
            if (wasMoreLogin) {
              if (connectHidden) connectHidden.value = 'mirror';
              syncBcDropdowns();
              applyMoreLoginMode(false);
            }
            if (val === 'auto') {
              if (execInput) execInput.value = '';
              if (channelInput) channelInput.value = '';
              if (pathRow) pathRow.style.display = '';
            } else if (val === 'custom') {
              if (channelInput) channelInput.value = '';
              if (pathRow) pathRow.style.display = '';
              if (execInput) execInput.focus();
            } else {
              // chrome, msedge, chromium — set as channel, clear executablePath
              if (channelInput) channelInput.value = val;
              if (execInput) execInput.value = '';
              if (pathRow) pathRow.style.display = '';
            }
          });
        });
      }
      // Populate installed browsers on open
      (async () => {
        try {
          const res = await fetch('/api/browser/detect-browsers');
          const data = await res.json();
          if (data.browsers?.length) {
            const menu = browserDropdown.querySelector('.cc-dropdown-menu');
            if (menu) {
              data.browsers.forEach(b => {
                const existing = menu.querySelector(`[data-value="${b.channel}"]`);
                if (existing && b.path) {
                  existing.setAttribute('data-tooltip', b.path);
                }
              });
            }
          }
        } catch {}
      })();
    }

    // ── Connection mode (mirror / attach / MoreLogin) ──
    let _moreloginDesiredEnvId = '';
    async function loadMoreLoginEnvs() {
      const sel = overlay.querySelector('#bc-morelogin-env-id');
      const statusEl = overlay.querySelector('#bc-morelogin-status-text');
      if (!sel) return;
      try {
        const r = await fetch('/api/browser/morelogin-envs');
        const d = await r.json();
        if (!d || d.ok === false) { sel.innerHTML = '<option value="">' + kit.te('settings.redesign.browser.error') + '</option>'; if (statusEl) statusEl.textContent = (d && d.error) || kit.tx('settings.redesign.browser.failedToLoadMoreloginProfiles'); return; }
        if (!d.installed) { sel.innerHTML = '<option value="">' + kit.te('settings.redesign.browser.moreloginNotInstalled') + '</option>'; if (statusEl) statusEl.textContent = kit.tx('settings.redesign.browser.moreloginDesktopAppIsNotInstalled'); return; }
        if (!d.running) { sel.innerHTML = '<option value="">' + kit.te('settings.redesign.browser.startMorelogin') + '</option>'; if (statusEl) statusEl.textContent = kit.tx('settings.redesign.browser.moreloginNotRunningOpenTheApp', { port: d.port }); return; }
        const envs = d.envs || [];
        if (!envs.length) { sel.innerHTML = '<option value="">' + kit.te('settings.redesign.browser.noProfiles') + '</option>'; if (statusEl) statusEl.textContent = kit.tx('settings.redesign.browser.noMoreloginProfilesYetOneIs'); return; }
        const want = _moreloginDesiredEnvId || sel.value || '';
        // Show each env's proxy — without it there is no way to tell from SynaBun
        // whether a profile's traffic leaves the machine.
        const proxyLabel = (p) => {
          if (!p) return '';
          const where = [p.host, p.port].filter(Boolean).join(':');
          return ` · ${[p.type, where, p.country].filter(Boolean).join(' ')}`;
        };
        sel.innerHTML = envs.map(e => `<option value="${escapeHtml(String(e.id))}">${escapeHtml(e.name)}${e.status ? ` (${escapeHtml(String(e.status))})` : ''}${escapeHtml(proxyLabel(e.proxy))}</option>`).join('');
        if (want && envs.some(e => String(e.id) === String(want))) sel.value = String(want);
        if (statusEl) {
          let msg = kit.tx('settings.redesign.browser.profileSApiPort', { count: envs.length, port: d.port });
          // MoreLogin silently redirects a navigation it refuses to its stop page: a
          // localhost port missing from the profile's Port scan protection list, or a
          // host its website blacklist/whitelist refuses. Surface it; nothing else in
          // the UI can explain it.
          if (d.blockedNavigations > 0) {
            msg += (" " + kit.tx('settings.redesign.browser.moreloginBlockedNavigationS', { blockedNavigations: d.blockedNavigations }));
            if (d.lastBlockedUrl) msg += kit.tx('settings.redesign.browser.mostRecently', { lastBlockedUrl: String(d.lastBlockedUrl).slice(0, 80) });
            msg += kit.tx('settings.redesign.browser.aLocalhostPortMustBeIn');
          }
          statusEl.textContent = msg;
        }
      } catch {
        sel.innerHTML = '<option value="">' + kit.te('settings.redesign.browser.error') + '</option>';
        if (statusEl) statusEl.textContent = kit.tx('settings.redesign.browser.failedToReachMorelogin');
      }
    }
    // Toggle MoreLogin-backend UI: show the MoreLogin profile picker, hide the
    // Chrome-only controls (Chrome Profile row + list, profile Path, attach Seed).
    function applyMoreLoginMode(on) {
      const mlRow = overlay.querySelector('#bc-morelogin-row');
      const mlStatusRow = overlay.querySelector('#bc-morelogin-status-row');
      if (mlRow) mlRow.style.display = on ? '' : 'none';
      if (mlStatusRow) mlStatusRow.style.display = on ? '' : 'none';
      const chromeProfRow = overlay.querySelector('#bc-detect-profiles')?.closest('.bc-card-row');
      const profileList = overlay.querySelector('#bc-profile-list');
      const profPathRow = overlay.querySelector('#bc-custom-profile-path')?.closest('.bc-card-row');
      if (chromeProfRow) chromeProfRow.style.display = on ? 'none' : '';
      if (profileList) profileList.style.display = on ? 'none' : '';
      if (profPathRow) profPathRow.style.display = on ? 'none' : '';
      if (on) {
        const seedRow = overlay.querySelector('#bc-attachSeed-row');
        if (seedRow) seedRow.style.display = 'none';
        loadMoreLoginEnvs();
      }
    }
    function refreshAttachSeedRow() {
      const mode = overlay.querySelector('#bc-connectMode')?.value || 'mirror';
      const seedRow = overlay.querySelector('#bc-attachSeed-row');
      if (seedRow) seedRow.style.display = mode === 'attach' ? '' : 'none';
      const showMl = mode === 'morelogin';
      // Keep the Browser dropdown in sync — MoreLogin appears in BOTH dropdowns.
      const browserHidden = overlay.querySelector('#bc-browser');
      if (showMl && browserHidden && browserHidden.value !== 'morelogin') {
        browserHidden.value = 'morelogin';
        syncBcDropdowns();
      } else if (!showMl && browserHidden && browserHidden.value === 'morelogin') {
        browserHidden.value = 'auto';
        const chan = overlay.querySelector('#bc-channel'); if (chan) chan.value = '';
        syncBcDropdowns();
      }
      applyMoreLoginMode(showMl);
      updateChromeRunningWarning();
    }
    const connectModeDd = overlay.querySelector('.bc-dropdown[data-for="bc-connectMode"]');
    if (connectModeDd) {
      // Runs after the generic dropdown handler (registered earlier) sets the hidden value.
      connectModeDd.querySelectorAll('.cc-dropdown-item').forEach(item => {
        item.addEventListener('click', refreshAttachSeedRow);
      });
    }
    overlay.querySelector('#bc-morelogin-refresh')?.addEventListener('click', (e) => { e.preventDefault(); loadMoreLoginEnvs(); });
    const attachSeedDd = overlay.querySelector('.bc-dropdown[data-for="bc-attachSeed"]');
    if (attachSeedDd) {
      attachSeedDd.querySelectorAll('.cc-dropdown-item').forEach(item => {
        item.addEventListener('click', () => updateChromeRunningWarning());
      });
    }

    // ── Chrome profile picker ──
    let _detectedProfiles = [];
    let _synabunProfile = '';

    /** Select a profile from the list. Updates hidden field + path input. */
    function selectProfileItem(value) {
      const list = overlay.querySelector('#bc-profile-list');
      if (!list) return;
      list.querySelectorAll('.bc-profile-item').forEach(el => el.classList.remove('selected'));
      const hidden = overlay.querySelector('#bc-userDataDir');
      const pathInput = overlay.querySelector('#bc-custom-profile-path');

      let resolvedPath = '';
      if (value === '') {
        resolvedPath = '';
      } else if (value === '__synabun__') {
        resolvedPath = _synabunProfile || 'data/chrome-profile';
      } else {
        resolvedPath = value;
      }

      if (hidden) hidden.value = resolvedPath;
      if (pathInput) pathInput.value = resolvedPath;

      const match = list.querySelector(`[data-profile-value="${CSS.escape(value)}"]`);
      if (match) match.classList.add('selected');
      updateChromeRunningWarning();
    }

    /** Mode-aware Chrome-running / connection notice. Reads connectMode + attachSeed
     *  from the DOM; uses the last known chromeRunning (call with no args to refresh). */
    let _lastChromeRunning = false;
    function updateChromeRunningWarning(chromeRunning, userDataDir) {
      if (chromeRunning !== undefined) _lastChromeRunning = chromeRunning;
      const running = _lastChromeRunning;
      const warn = overlay.querySelector('#bc-chrome-running-warn');
      if (!warn) return;
      const udd = userDataDir !== undefined ? userDataDir : (overlay.querySelector('#bc-userDataDir')?.value || '');
      // Only relevant for a real Chrome profile (not sandbox / SynaBun / mirror / attach dirs)
      const isChrome = !!udd && !udd.includes('data/chrome-profile') && !udd.includes('data/browser-profiles') && !udd.includes('data/chrome-attach');
      const connectMode = overlay.querySelector('#bc-connectMode')?.value || 'mirror';
      const attachSeed = overlay.querySelector('#bc-attachSeed')?.value || 'real';
      let msg = '';
      if (isChrome && connectMode === 'attach') {
        if (attachSeed === 'real') {
          msg = running
            ? kit.tx('settings.redesign.browser.attachSeedSynabunWillCopyThis')
            : kit.tx('settings.redesign.browser.attachSeedSynabunOpensADedicated');
        } else {
          msg = kit.tx('settings.redesign.browser.attachFreshSynabunOpensADedicated');
        }
      } else if (isChrome && running) {
        msg = kit.tx('settings.redesign.browser.chromeIsRunningSynabunOpensAn');
      }
      if (msg) { warn.textContent = msg; warn.style.display = ''; }
      else { warn.style.display = 'none'; }
    }

    /** Set the path directly (from typing or browse). Highlights matching profile or deselects all. */
    function setProfilePath(path) {
      const hidden = overlay.querySelector('#bc-userDataDir');
      if (hidden) hidden.value = path;

      const list = overlay.querySelector('#bc-profile-list');
      if (!list) return;
      list.querySelectorAll('.bc-profile-item').forEach(el => el.classList.remove('selected'));

      if (!path) {
        const sandbox = list.querySelector('[data-profile-value=""]');
        if (sandbox) sandbox.classList.add('selected');
        return;
      }

      const norm = path.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
      const synNorm = (_synabunProfile || '').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');

      if (synNorm && norm === synNorm) {
        const el = list.querySelector('[data-profile-value="__synabun__"]');
        if (el) el.classList.add('selected');
        return;
      }

      for (const p of _detectedProfiles) {
        if (p.path.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '') === norm) {
          const el = list.querySelector(`[data-profile-value="${CSS.escape(p.path)}"]`);
          if (el) el.classList.add('selected');
          return;
        }
      }
      // No match — nothing highlighted, path input is the source of truth
    }

    function buildProfileList(profiles, synabunProfile) {
      const list = overlay.querySelector('#bc-profile-list');
      if (!list) return;

      const currentVal = overlay.querySelector('#bc-userDataDir')?.value || '';

      list.innerHTML = '';

      // Built-in: Clean Sandbox
      list.insertAdjacentHTML('beforeend', `
        <div class="bc-profile-item" data-profile-value="">
          <span class="bc-profile-radio"></span>
          <span class="bc-profile-name">${kit.te('settings.redesign.browser.cleanSandbox')}</span>
          <span class="bc-profile-hint">${kit.te('settings.redesign.browser.noPersistentProfile')}</span>
        </div>
      `);

      // Built-in: SynaBun Profile
      list.insertAdjacentHTML('beforeend', `
        <div class="bc-profile-item" data-profile-value="__synabun__">
          <span class="bc-profile-radio"></span>
          <span class="bc-profile-name">${kit.te('settings.redesign.browser.synabunProfile')}</span>
          <span class="bc-profile-hint">${kit.te('settings.redesign.browser.managed')}</span>
        </div>
      `);

      // Group detected profiles by browser
      const byBrowser = {};
      for (const p of profiles) {
        if (!byBrowser[p.browser]) byBrowser[p.browser] = [];
        byBrowser[p.browser].push(p);
      }

      for (const [browser, items] of Object.entries(byBrowser)) {
        list.insertAdjacentHTML('beforeend', `<div class="bc-profile-divider">${browser}</div>`);
        for (const p of items) {
          const label = p.name === p.folder ? p.name : `${p.name} (${p.folder})`;
          list.insertAdjacentHTML('beforeend', `
            <div class="bc-profile-item" data-profile-value="${p.path.replace(/"/g, '&quot;')}">
              <span class="bc-profile-radio"></span>
              <span class="bc-profile-name">${label}</span>
              <span class="bc-profile-hint">${p.isDefault ? kit.te('settings.redesign.browser.default') : ''}</span>
            </div>
          `);
        }
      }

      // Attach click handlers
      list.querySelectorAll('.bc-profile-item').forEach(el => {
        el.addEventListener('click', () => selectProfileItem(el.dataset.profileValue));
      });

      // Restore selection
      matchProfileSelection(currentVal, synabunProfile);
    }

    function matchProfileSelection(userDataDir, synabunProfile) {
      const pathInput = overlay.querySelector('#bc-custom-profile-path');
      if (!userDataDir) {
        if (pathInput) pathInput.value = '';
        selectProfileItem('');
        return;
      }

      if (pathInput) pathInput.value = userDataDir;

      const norm = (userDataDir || '').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
      const synNorm = (synabunProfile || '').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');

      if (synNorm && norm === synNorm) {
        selectProfileItem('__synabun__');
        return;
      }

      for (const p of _detectedProfiles) {
        if (p.path.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '') === norm) {
          selectProfileItem(p.path);
          return;
        }
      }

      // Custom path — just set the hidden field, no list item to highlight
      const hidden = overlay.querySelector('#bc-userDataDir');
      if (hidden) hidden.value = userDataDir;
    }

    async function detectAndBuildProfiles() {
      const btn = overlay.querySelector('#bc-detect-profiles');
      if (btn) { btn.style.opacity = '0.4'; btn.style.pointerEvents = 'none'; }
      try {
        const res = await fetch('/api/browser/detect-profiles');
        const data = await res.json();
        _detectedProfiles = data.profiles || [];
        _synabunProfile = data.synabunProfile || '';
        buildProfileList(_detectedProfiles, _synabunProfile);
      } catch {
        // Keep existing list if detection fails
      } finally {
        if (btn) { btn.style.opacity = ''; btn.style.pointerEvents = ''; }
      }
    }

    // Attach click handlers to initial static profile items
    overlay.querySelectorAll('#bc-profile-list .bc-profile-item').forEach(el => {
      el.addEventListener('click', () => selectProfileItem(el.dataset.profileValue));
    });

    // Detect button click
    const profileDetectBtn = overlay.querySelector('#bc-detect-profiles');
    if (profileDetectBtn) {
      profileDetectBtn.addEventListener('click', detectAndBuildProfiles);
    }

    // Path input → sync to hidden field + highlight matching profile
    const customPathInput = overlay.querySelector('#bc-custom-profile-path');
    if (customPathInput) {
      customPathInput.addEventListener('input', () => {
        setProfilePath(customPathInput.value.trim());
      });
    }

    // Browse folder button → in-app folder picker
    const browseBtn = overlay.querySelector('#bc-browse-folder');
    const bcBrowserEl = overlay.querySelector('#bc-browse-browser');
    if (browseBtn && bcBrowserEl) {
      async function loadBcDir(dirPath) {
        bcBrowserEl.style.display = 'block';
        bcBrowserEl.innerHTML = '<div style="padding:10px;color:var(--t-muted);font-size:12px">' + kit.te('settings.redesign.browser.loading') + '</div>';
        try {
          const qs = dirPath ? `?path=${encodeURIComponent(dirPath)}` : '';
          const res = await fetch(`/api/browse-directory${qs}`);
          const data = await res.json();
          if (!data.ok) throw new Error(data.error);

          let html = '<div style="padding:6px 10px;font-size:11px;color:var(--t-muted);border-bottom:1px solid var(--s-medium);display:flex;align-items:center;justify-content:space-between">'
            + `<span style="font-family:'JetBrains Mono',monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(data.current)}</span>`
            + '<button id="bc-browse-select" style="flex:0 0 auto;padding:3px 10px;background:var(--accent-blue-bg);border:1px solid var(--accent-blue-border);color:var(--accent-blue);border-radius:4px;cursor:pointer;font-size:11px">' + kit.te('settings.redesign.browser.select') + '</button>'
            + '</div>';
          html += '<div style="padding:4px 0">';
          if (data.parent) {
            html += `<div class="cc-browse-item" data-path="${escapeHtml(data.parent)}" style="padding:4px 10px;cursor:pointer;font-size:12px;display:flex;align-items:center;gap:6px;color:var(--t-muted)">`
              + '<svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:2"><polyline points="15 18 9 12 15 6"/></svg>'
              + '' + kit.te('settings.redesign.browser.parent') + '</div>';
          }
          for (const d of data.directories) {
            html += `<div class="cc-browse-item" data-path="${escapeHtml(data.current + '/' + d)}" style="padding:4px 10px;cursor:pointer;font-size:12px;display:flex;align-items:center;gap:6px">`
              + '<svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
              + escapeHtml(d) + '</div>';
          }
          if (data.directories.length === 0 && !data.parent) {
            html += '<div style="padding:8px 10px;color:var(--t-muted);font-size:12px">' + kit.te('settings.redesign.browser.noSubdirectories') + '</div>';
          }
          html += '</div>';
          bcBrowserEl.innerHTML = html;

          bcBrowserEl.querySelector('#bc-browse-select').addEventListener('click', () => {
            const input = overlay.querySelector('#bc-custom-profile-path');
            const selected = data.current.replace(/\\/g, '/');
            if (input) input.value = selected;
            setProfilePath(selected);
            bcBrowserEl.style.display = 'none';
          });

          bcBrowserEl.querySelectorAll('.cc-browse-item').forEach(item => {
            item.addEventListener('mouseenter', () => item.style.background = 'var(--s-medium)');
            item.addEventListener('mouseleave', () => item.style.background = '');
            item.addEventListener('click', () => loadBcDir(item.dataset.path));
          });
        } catch (err) {
          bcBrowserEl.innerHTML = `<div style="padding:10px;color:var(--accent-dim);font-size:12px">${kit.te('settings.redesign.browser.error2')} ${escapeHtml(err.message)}</div>`;
        }
      }

      browseBtn.addEventListener('click', () => {
        if (bcBrowserEl.style.display === 'block') {
          bcBrowserEl.style.display = 'none';
          return;
        }
        const current = overlay.querySelector('#bc-custom-profile-path')?.value?.trim() || '';
        loadBcDir(current);
      });
    }

    // Collect all config from the form
    function collectBrowserConfig() {
      const val = (id) => (overlay.querySelector(`#${id}`)?.value || '').trim();
      const num = (id, def) => { const v = parseInt(val(id), 10); return isNaN(v) ? def : v; };
      const numF = (id, def) => { const v = parseFloat(val(id)); return isNaN(v) ? def : v; };

      // Permissions
      const permissions = [];
      overlay.querySelectorAll('.browser-cfg-checkbox-grid input[type="checkbox"]').forEach(cb => {
        if (cb.checked) permissions.push(cb.id.replace('bc-perm-', ''));
      });

      const config = {
        // Executable
        executablePath: val('bc-executablePath') || null,
        userDataDir: val('bc-userDataDir') || null,
        browser: (val('bc-browser') === 'morelogin' ? 'auto' : (val('bc-browser') || 'auto')),
        channel: val('bc-channel') || null,
        connectMode: ['attach', 'morelogin'].includes(val('bc-connectMode')) ? val('bc-connectMode') : 'mirror',
        attachSeed: val('bc-attachSeed') === 'fresh' ? 'fresh' : 'real',
        moreloginEnvId: val('bc-morelogin-env-id') || null,
        slowMo: num('bc-slowMo', 0),
        timeout: num('bc-timeout', 30000),
        navigationTimeout: num('bc-navigationTimeout', 30000),
        extraArgs: val('bc-extraArgs') || null,

        // Viewport & Display
        viewport: {
          width: num('bc-viewportWidth', 1280),
          height: num('bc-viewportHeight', 800),
        },
        screen: {
          width: num('bc-screenWidth', 1920),
          height: num('bc-screenHeight', 1080),
        },
        deviceScaleFactor: numF('bc-deviceScaleFactor', 1),
        isMobile: isToggleOn('bc-isMobile'),
        hasTouch: isToggleOn('bc-hasTouch'),

        // Identity & Headers
        userAgent: val('bc-userAgent') || null,
        acceptLanguage: val('bc-acceptLanguage') || null,
        locale: val('bc-locale') || null,
        timezoneId: val('bc-timezoneId') || null,
        extraHTTPHeaders: (() => {
          try { const v = val('bc-extraHTTPHeaders'); return v ? JSON.parse(v) : null; }
          catch { return null; }
        })(),
        stealthFingerprint: isToggleOn('bc-stealthFingerprint'),

        // Geolocation
        geolocation: isToggleOn('bc-geoEnabled') ? {
          latitude: numF('bc-geoLatitude', 0),
          longitude: numF('bc-geoLongitude', 0),
          accuracy: numF('bc-geoAccuracy', 100),
        } : null,

        // Permissions
        permissions: permissions.length ? permissions : null,

        // Network & Proxy
        offline: isToggleOn('bc-offline'),
        proxy: val('bc-proxyServer') ? {
          server: val('bc-proxyServer'),
          bypass: val('bc-proxyBypass') || undefined,
          username: val('bc-proxyUsername') || undefined,
          password: val('bc-proxyPassword') || undefined,
        } : null,
        httpCredentials: val('bc-httpCredUser') ? {
          username: val('bc-httpCredUser'),
          password: val('bc-httpCredPass'),
        } : null,

        // Appearance
        colorScheme: val('bc-colorScheme') || null,
        reducedMotion: val('bc-reducedMotion') || null,
        forcedColors: val('bc-forcedColors') || null,

        // Scripting & Security
        javaScriptEnabled: isToggleOn('bc-javaScriptEnabled'),
        ignoreHTTPSErrors: isToggleOn('bc-ignoreHTTPSErrors'),
        bypassCSP: isToggleOn('bc-bypassCSP'),
        acceptDownloads: isToggleOn('bc-acceptDownloads'),
        strictSelectors: isToggleOn('bc-strictSelectors'),
        serviceWorkers: val('bc-serviceWorkers') || 'allow',

        // Storage / Cookies
        persistStorage: isToggleOn('bc-persistStorage'),
        storageStatePath: val('bc-storageStatePath') || 'data/browser-storage.json',
        clearStorageOnStart: isToggleOn('bc-clearStorageOnStart'),

        // Recording
        recordVideo: isToggleOn('bc-recordVideo') ? {
          dir: val('bc-recordVideoDir') || 'data/videos',
          size: {
            width: num('bc-recordVideoWidth', 1280),
            height: num('bc-recordVideoHeight', 720),
          },
        } : null,
        recordHar: isToggleOn('bc-recordHar') ? {
          path: val('bc-recordHarPath') || 'data/network.har',
          content: val('bc-recordHarContent') || 'embed',
          mode: val('bc-recordHarMode') || 'full',
          urlFilter: val('bc-recordHarUrlFilter') || undefined,
        } : null,

        // Screencast
        screencast: {
          disabled: !isToggleOn('bc-screencastEnabled'),
          format: val('bc-screencastFormat') || 'jpeg',
          quality: num('bc-screencastQuality', 60),
          maxWidth: num('bc-screencastMaxWidth', 1280),
          maxHeight: num('bc-screencastMaxHeight', 800),
          everyNthFrame: num('bc-screencastEveryNthFrame', 1),
        },
      };

      return config;
    }

    // Apply config values to form controls
    function applyBrowserConfig(cfg) {
      if (!cfg || typeof cfg !== 'object') return;
      const setVal = (id, v) => { const el = overlay.querySelector(`#${id}`); if (el && v != null) el.value = v; };

      // Executable
      setVal('bc-executablePath', cfg.executablePath);
      setVal('bc-userDataDir', cfg.userDataDir || '');
      matchProfileSelection(cfg.userDataDir || '', _synabunProfile);
      const _showMl = cfg.connectMode === 'morelogin';
      // MoreLogin shows in BOTH dropdowns — label the Browser dropdown 'morelogin' too.
      setVal('bc-browser', _showMl ? 'morelogin' : (cfg.browser || 'auto'));
      setVal('bc-channel', cfg.channel || '');
      setVal('bc-connectMode', cfg.connectMode || 'mirror');
      setVal('bc-attachSeed', cfg.attachSeed || 'real');
      const _seedRow = overlay.querySelector('#bc-attachSeed-row');
      if (_seedRow) _seedRow.style.display = (cfg.connectMode === 'attach') ? '' : 'none';
      _moreloginDesiredEnvId = cfg.moreloginEnvId || '';
      applyMoreLoginMode(_showMl);
      setVal('bc-slowMo', cfg.slowMo ?? 0);
      setVal('bc-timeout', cfg.timeout ?? 30000);
      setVal('bc-navigationTimeout', cfg.navigationTimeout ?? 30000);
      setVal('bc-extraArgs', cfg.extraArgs || '');

      // Viewport & Display
      if (cfg.viewport) {
        setVal('bc-viewportWidth', cfg.viewport.width);
        setVal('bc-viewportHeight', cfg.viewport.height);
      }
      if (cfg.screen) {
        setVal('bc-screenWidth', cfg.screen.width);
        setVal('bc-screenHeight', cfg.screen.height);
      }
      setVal('bc-deviceScaleFactor', cfg.deviceScaleFactor ?? 1);
      setToggle('bc-isMobile', !!cfg.isMobile);
      setToggle('bc-hasTouch', !!cfg.hasTouch);

      // Identity
      setVal('bc-userAgent', cfg.userAgent || '');
      setVal('bc-acceptLanguage', cfg.acceptLanguage || '');
      setVal('bc-locale', cfg.locale || '');
      setVal('bc-timezoneId', cfg.timezoneId || '');
      if (cfg.extraHTTPHeaders) {
        setVal('bc-extraHTTPHeaders', JSON.stringify(cfg.extraHTTPHeaders, null, 2));
      }
      setToggle('bc-stealthFingerprint', cfg.stealthFingerprint !== false);

      // Geolocation
      setToggle('bc-geoEnabled', !!cfg.geolocation);
      if (cfg.geolocation) {
        setVal('bc-geoLatitude', cfg.geolocation.latitude);
        setVal('bc-geoLongitude', cfg.geolocation.longitude);
        setVal('bc-geoAccuracy', cfg.geolocation.accuracy);
        ['bc-geoLatitude', 'bc-geoLongitude', 'bc-geoAccuracy'].forEach(id => {
          const inp = overlay.querySelector(`#${id}`);
          if (inp) inp.disabled = false;
        });
      }

      // Permissions
      if (cfg.permissions) {
        cfg.permissions.forEach(p => {
          const cb = overlay.querySelector(`#bc-perm-${p}`);
          if (cb) cb.checked = true;
        });
      }

      // Network
      setToggle('bc-offline', !!cfg.offline);
      if (cfg.proxy) {
        setVal('bc-proxyServer', cfg.proxy.server);
        setVal('bc-proxyBypass', cfg.proxy.bypass);
        setVal('bc-proxyUsername', cfg.proxy.username);
        setVal('bc-proxyPassword', cfg.proxy.password);
      }
      if (cfg.httpCredentials) {
        setVal('bc-httpCredUser', cfg.httpCredentials.username);
        setVal('bc-httpCredPass', cfg.httpCredentials.password);
      }

      // Appearance
      setVal('bc-colorScheme', cfg.colorScheme || '');
      setVal('bc-reducedMotion', cfg.reducedMotion || '');
      setVal('bc-forcedColors', cfg.forcedColors || '');

      // Scripting & Security
      setToggle('bc-javaScriptEnabled', cfg.javaScriptEnabled !== false);
      setToggle('bc-ignoreHTTPSErrors', !!cfg.ignoreHTTPSErrors);
      setToggle('bc-bypassCSP', !!cfg.bypassCSP);
      setToggle('bc-acceptDownloads', cfg.acceptDownloads !== false);
      setToggle('bc-strictSelectors', cfg.strictSelectors !== false);
      setVal('bc-serviceWorkers', cfg.serviceWorkers || 'allow');

      // Storage
      setToggle('bc-persistStorage', !!cfg.persistStorage);
      setVal('bc-storageStatePath', cfg.storageStatePath || 'data/browser-storage.json');
      if (cfg.persistStorage) {
        const inp = overlay.querySelector('#bc-storageStatePath');
        if (inp) inp.disabled = false;
      }
      setToggle('bc-clearStorageOnStart', !!cfg.clearStorageOnStart);

      // Recording — video
      const hasVideo = !!cfg.recordVideo;
      setToggle('bc-recordVideo', hasVideo);
      if (hasVideo) {
        setVal('bc-recordVideoDir', cfg.recordVideo.dir);
        if (cfg.recordVideo.size) {
          setVal('bc-recordVideoWidth', cfg.recordVideo.size.width);
          setVal('bc-recordVideoHeight', cfg.recordVideo.size.height);
        }
        ['bc-recordVideoDir', 'bc-recordVideoWidth', 'bc-recordVideoHeight'].forEach(id => {
          const inp = overlay.querySelector(`#${id}`);
          if (inp) inp.disabled = false;
        });
      }
      // Recording — HAR
      const hasHar = !!cfg.recordHar;
      setToggle('bc-recordHar', hasHar);
      if (hasHar) {
        setVal('bc-recordHarPath', cfg.recordHar.path);
        setVal('bc-recordHarContent', cfg.recordHar.content || 'embed');
        setVal('bc-recordHarMode', cfg.recordHar.mode || 'full');
        setVal('bc-recordHarUrlFilter', cfg.recordHar.urlFilter || '');
        ['bc-recordHarPath', 'bc-recordHarContent', 'bc-recordHarMode', 'bc-recordHarUrlFilter'].forEach(id => {
          const inp = overlay.querySelector(`#${id}`);
          if (inp) inp.disabled = false;
        });
      }

      // Screencast
      setToggle('bc-screencastEnabled', cfg.screencast?.disabled === false);
      if (cfg.screencast) {
        setVal('bc-screencastFormat', cfg.screencast.format || 'jpeg');
        setVal('bc-screencastQuality', cfg.screencast.quality ?? 60);
        if (scVal) scVal.textContent = cfg.screencast.quality ?? 60;
        setVal('bc-screencastMaxWidth', cfg.screencast.maxWidth ?? 1280);
        setVal('bc-screencastMaxHeight', cfg.screencast.maxHeight ?? 800);
        setVal('bc-screencastEveryNthFrame', cfg.screencast.everyNthFrame ?? 1);
      }
    }

    // Load config on open, then auto-detect profiles
    fetch('/api/browser/config').then(r => r.json()).then(async (data) => {
      if (data.config) { applyBrowserConfig(data.config); syncBcDropdowns(); }
      // Show detected path
      const hint = overlay.querySelector('#bc-detected-path');
      if (hint && data.detectedPath) hint.textContent = kit.tx('settings.redesign.browser.detected', { detectedPath: data.detectedPath });
      // Auto-detect Chrome profiles and select current
      await detectAndBuildProfiles();
      if (data.config) matchProfileSelection(data.config.userDataDir || '', _synabunProfile);
      // Show Chrome running warning if a Chrome profile is selected
      updateChromeRunningWarning(data.chromeRunning, data.config?.userDataDir);
    }).catch(() => {});

    // Save button
    const saveBtn = overlay.querySelector('#bc-save-all');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const config = collectBrowserConfig();
        saveBtn.style.opacity = '0.5'; saveBtn.style.pointerEvents = 'none';
        const status = overlay.querySelector('#bc-save-status');
        try {
          const res = await fetch('/api/browser/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config),
          });
          const data = await res.json();
          if (data.ok) {
            if (status) { status.textContent = kit.tx('settings.redesign.browser.configurationSaved'); status.style.color = '#4ade80'; }
            showCCToast(kit.tx('settings.redesign.browser.browserConfigurationSaved'));
          } else {
            if (status) { status.textContent = kit.tx('settings.redesign.browser.saveFailed', { error: (data.error || kit.tx('settings.redesign.browser.unknownError')) }); status.style.color = '#f87171'; }
          }
        } catch (err) {
          if (status) { status.textContent = kit.tx('settings.redesign.browser.saveFailed2', { message: err.message }); status.style.color = '#f87171'; }
        } finally {
          saveBtn.style.opacity = ''; saveBtn.style.pointerEvents = '';
          setTimeout(() => { if (status) { status.textContent = ''; } }, 4000);
        }
      });
    }

    // Reset button
    const resetBtn = overlay.querySelector('#bc-reset-all');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        const defaults = {
          executablePath: null, browser: 'auto', channel: null, slowMo: 0,
          connectMode: 'mirror', attachSeed: 'real',
          timeout: 30000, navigationTimeout: 30000, extraArgs: null,
          viewport: { width: 1280, height: 800 }, screen: { width: 1920, height: 1080 },
          deviceScaleFactor: 1, isMobile: false, hasTouch: false,
          userAgent: null, acceptLanguage: null, locale: null, timezoneId: null,
          extraHTTPHeaders: null, stealthFingerprint: true,
          geolocation: null, permissions: null,
          offline: false, proxy: null, httpCredentials: null,
          colorScheme: null, reducedMotion: null, forcedColors: null,
          javaScriptEnabled: true, ignoreHTTPSErrors: false, bypassCSP: false,
          acceptDownloads: true, strictSelectors: true, serviceWorkers: 'allow',
          persistStorage: false, storageStatePath: 'data/browser-storage.json', clearStorageOnStart: false,
          recordVideo: null, recordHar: null,
          screencast: { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 },
        };
        applyBrowserConfig(defaults);
        // Reset disabled states
        ['bc-geoLatitude', 'bc-geoLongitude', 'bc-geoAccuracy', 'bc-storageStatePath',
         'bc-recordVideoDir', 'bc-recordVideoWidth', 'bc-recordVideoHeight',
         'bc-recordHarPath', 'bc-recordHarContent', 'bc-recordHarMode', 'bc-recordHarUrlFilter'].forEach(id => {
          const inp = overlay.querySelector(`#${id}`);
          if (inp) inp.disabled = true;
        });
        syncBcDropdowns();
        // Uncheck all permission checkboxes
        overlay.querySelectorAll('.browser-cfg-checkbox-grid input[type="checkbox"]').forEach(cb => { cb.checked = false; });
        const status = overlay.querySelector('#bc-save-status');
        if (status) { status.textContent = kit.tx('settings.redesign.browser.resetToDefaultsNotSavedYet'); status.style.color = 'var(--t-faint)'; }
        setTimeout(() => { if (status) status.textContent = ''; }, 3000);
      });
    }

  }

  // ── Tunnel toggle ──
  const tunnelToggle = overlay.querySelector('#cc-tunnel-toggle');
  if (tunnelToggle) {
    tunnelToggle.addEventListener('click', async () => {
      const isOn = tunnelToggle.classList.contains('on');
      const endpoint = isOn ? '/api/tunnel/stop' : '/api/tunnel/start';
      try {
        tunnelToggle.style.opacity = '0.4'; tunnelToggle.style.pointerEvents = 'none';
        const res = await fetch(endpoint, { method: 'POST' }); const data = await res.json();
        if (data.ok) {
          if (isOn) {
            tunnelToggle.classList.remove('on');
            const row = overlay.querySelector('#cc-tunnel-row'); if (row) row.classList.remove('enabled');
            const label = overlay.querySelector('#cc-tunnel-label'); if (label) label.textContent = kit.tx('settings.redesign.hooks.ready');
            const urlEl = overlay.querySelector('#cc-tunnel-url'); if (urlEl) urlEl.textContent = kit.tx('settings.redesign.hooks.exposeMcpToClaudeWebVia');
          } else {
            tunnelToggle.classList.add('on');
            const row = overlay.querySelector('#cc-tunnel-row'); if (row) row.classList.add('enabled');
            const label = overlay.querySelector('#cc-tunnel-label'); if (label) label.textContent = kit.tx('settings.redesign.hooks.starting');
            const urlEl = overlay.querySelector('#cc-tunnel-url'); if (urlEl) urlEl.textContent = kit.tx('settings.redesign.hooks.waitingForTunnelUrl');
            let attempts = 0;
            const poll = setInterval(async () => {
              attempts++;
              try {
                const sr = await fetch('/api/tunnel/status'); const sd = await sr.json();
                if (sd.url) {
                  clearInterval(poll);
                  if (label) label.textContent = kit.tx('settings.redesign.hooks.running');
                  if (urlEl) urlEl.textContent = sd.url;
                  let copyBtn = overlay.querySelector('#cc-tunnel-copy-url');
                  if (!copyBtn) {
                    const wrapper = document.createElement('div'); wrapper.style.cssText = 'margin-top:6px;display:flex;gap:6px;align-items:center';
                    wrapper.innerHTML = `<button type="button" class="conn-add-btn" id="cc-tunnel-copy-url" ${kit.inv('AUT050')} style="margin:0;flex:1;font-size:12px;padding:6px 10px"><svg viewBox="0 0 24 24" style="width:12px;height:12px"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> ${kit.te('settings.redesign.hooks.copyMcpUrl')}</button>`;
                    row.parentNode.insertBefore(wrapper, row.nextSibling);
                    copyBtn = wrapper.querySelector('#cc-tunnel-copy-url');
                    copyBtn.addEventListener('click', () => {
                      const tunnelMcpUrl = (urlEl?.textContent || '') + '/mcp';
                      navigator.clipboard.writeText(tunnelMcpUrl);
                      copyBtn.innerHTML = '<svg viewBox="0 0 24 24" style="width:12px;height:12px"><polyline points="20 6 9 17 4 12"/></svg> ' + kit.te('settings.redesign.hooks.copied') + '';
                      setTimeout(() => { copyBtn.innerHTML = '<svg viewBox="0 0 24 24" style="width:12px;height:12px"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> ' + kit.te('settings.redesign.hooks.copyMcpUrl') + ''; }, 2000);
                    });
                  }
                } else if (attempts >= 30) { clearInterval(poll); if (label) label.textContent = kit.tx('settings.redesign.hooks.timeout'); if (urlEl) urlEl.textContent = kit.tx('settings.redesign.hooks.failedToGetTunnelUrlCheck'); }
              } catch {}
            }, 1000);
          }
        } else { alert(data.error || kit.tx('settings.redesign.hooks.failed')); }
      } catch (err) { alert(kit.tx('settings.redesign.hooks.failed2', { message: err.message })); }
      finally { tunnelToggle.style.opacity = ''; tunnelToggle.style.pointerEvents = ''; }
    });
  }

  // Copy tunnel MCP URL
  const tunnelCopy = overlay.querySelector('#cc-tunnel-copy-url');
  if (tunnelCopy) {
    tunnelCopy.addEventListener('click', () => {
      const urlEl = overlay.querySelector('#cc-tunnel-url'); const baseUrl = urlEl?.textContent || '';
      if (!baseUrl) { alert(kit.tx('settings.redesign.hooks.tunnelUrlNotAvailable')); return; }
      const tunnelMcpUrl = mcpKeyInfo.key ? baseUrl + '/mcp/' + mcpKeyInfo.key : baseUrl + '/mcp';
      navigator.clipboard.writeText(tunnelMcpUrl);
      tunnelCopy.innerHTML = '<svg viewBox="0 0 24 24" style="width:12px;height:12px"><polyline points="20 6 9 17 4 12"/></svg> ' + kit.te('settings.redesign.hooks.copied') + '';
      setTimeout(() => { tunnelCopy.innerHTML = '<svg viewBox="0 0 24 24" style="width:12px;height:12px"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> ' + kit.te('settings.redesign.hooks.copyMcpUrl') + ''; }, 2000);
    });
  }

  // ── API key generate / copy / revoke ──
  // ── YouTube trailer automation tab ──
  const ytStatus = (msg, ok) => {
    const el = overlay.querySelector('#yt-status');
    if (!el) return;
    el.textContent = msg;
    el.style.color = ok === false ? '#d66' : (ok ? '#6c9' : 'var(--t-dim)');
  };
  const ytGather = () => {
    const SECRET_IDS = ['YT_OAUTH_CLIENT_ID', 'YT_OAUTH_CLIENT_SECRET', 'YT_API_KEY', 'YT_CHANNEL_ID', 'IGDB_CLIENT_ID', 'IGDB_CLIENT_SECRET', 'STEAM_API_KEY'];
    const secrets = {};
    for (const id of SECRET_IDS) {
      const el = overlay.querySelector('#yt-' + id);
      if (!el) continue;
      const v = (el.value || '').trim();
      // Empty input but a stored (masked) value => leave unchanged: send the
      // mask back so the server's PUT handler skips it.
      if (!v && el.dataset.mask) { secrets[id] = el.dataset.mask; continue; }
      secrets[id] = v;
    }
    const pipeline = {
      uploadTransport: overlay.querySelector('#yt-upload-transport')?.value || 'browser',
      sources: { lookbackDays: parseInt(overlay.querySelector('#yt-lookbackDays')?.value, 10) || 60 },
      download: {
        quality: overlay.querySelector('#yt-quality')?.value || undefined,
        outputDir: (overlay.querySelector('#yt-outputDir')?.value || '').trim() || undefined,
        useCookies: !!overlay.querySelector('#yt-useCookies')?.checked,
        preferSteam: true,
      },
      cadence: { postsPerDay: parseInt(overlay.querySelector('#yt-postsPerDay')?.value, 10) || 1 },
    };
    return { secrets, pipeline };
  };
  const ytSave = () => fetch('/api/youtube/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ytGather()) });
  const ytSaveBtn = overlay.querySelector('#yt-save');
  if (ytSaveBtn) ytSaveBtn.addEventListener('click', async () => {
    ytStatus(kit.tx('settings.redesign.youtube.saving'));
    try { const j = await (await ytSave()).json(); ytStatus(j.ok ? kit.tx('settings.redesign.youtube.saved') : kit.tx('settings.redesign.youtube.error', { message: j.error || kit.tx('settings.redesign.youtube.failed') }), !!j.ok); }
    catch (e) { ytStatus(kit.tx('settings.redesign.youtube.error', { message: e.message }), false); }
  });
  const ytTestBtn = overlay.querySelector('#yt-test');
  if (ytTestBtn) ytTestBtn.addEventListener('click', async () => {
    ytStatus(kit.tx('settings.redesign.youtube.testing'));
    try {
      await ytSave(); // test freshly-typed creds
      const j = await (await fetch('/api/youtube/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: 'all' }) })).json();
      const res = j.results || {};
      const fmt = (k) => (res[k] ? (res[k].ok ? k + ' ✓' : k + ' ✗') : '');
      const line = ['igdb', 'steam', 'youtube'].map(fmt).filter(Boolean).join('  ·  ') || kit.tx('settings.redesign.youtube.noResult');
      ytStatus(line, Object.values(res).every((x) => x && x.ok));
    } catch (e) { ytStatus(kit.tx('settings.redesign.youtube.error', { message: e.message }), false); }
  });
  const ytAuthBtn = overlay.querySelector('#yt-authorize');
  if (ytAuthBtn) ytAuthBtn.addEventListener('click', async () => {
    ytStatus(kit.tx('settings.redesign.youtube.savingCredentials'));
    try {
      await ytSave();
      const j = await (await fetch('/api/youtube/oauth/start')).json();
      if (j.url) { window.open(j.url, '_blank', 'noopener'); ytStatus(kit.tx('settings.redesign.youtube.finishGoogleSignInInThe')); }
      else ytStatus(kit.tx('settings.redesign.youtube.error', { message: j.error || kit.tx('settings.redesign.youtube.setTheOauthClientIdFirst') }), false);
    } catch (e) { ytStatus(kit.tx('settings.redesign.youtube.error', { message: e.message }), false); }
  });

  const apikeyGenBtn = overlay.querySelector('#cc-apikey-generate');
  if (apikeyGenBtn) {
    apikeyGenBtn.addEventListener('click', async () => {
      const existing = overlay.querySelector('#cc-apikey-row')?.classList.contains('enabled');
      if (existing && !confirm(kit.tx('settings.redesign.hooks.thisWillRevokeTheCurrentKey'))) return;
      apikeyGenBtn.style.opacity = '0.4'; apikeyGenBtn.style.pointerEvents = 'none';
      try {
        const res = await fetch('/api/mcp-key', { method: 'POST' }); const data = await res.json();
        if (data.ok && data.key) {
          mcpKeyInfo = { hasKey: true, key: data.key, maskedKey: '***' + data.key.slice(-8) };
          const reveal = overlay.querySelector('#cc-apikey-reveal');
          const valueEl = overlay.querySelector('#cc-apikey-value');
          const statusEl = overlay.querySelector('#cc-apikey-status');
          const row = overlay.querySelector('#cc-apikey-row');
          if (valueEl) valueEl.textContent = data.key;
          if (reveal) reveal.style.display = '';
          if (statusEl) statusEl.textContent = '***' + data.key.slice(-8);
          if (row) row.classList.add('enabled');
          apikeyGenBtn.textContent = kit.tx('settings.redesign.hooks.regenerate');
        } else { alert(data.error || kit.tx('settings.redesign.hooks.failedToGenerateKey')); }
      } catch (err) { alert(kit.tx('settings.redesign.hooks.failed2', { message: err.message })); }
      finally { apikeyGenBtn.style.opacity = ''; apikeyGenBtn.style.pointerEvents = ''; }
    });
  }
  const apikeyCopyBtn = overlay.querySelector('#cc-apikey-copy');
  if (apikeyCopyBtn) {
    apikeyCopyBtn.addEventListener('click', () => {
      const key = overlay.querySelector('#cc-apikey-value')?.textContent || ''; if (!key) return;
      navigator.clipboard.writeText(key);
      apikeyCopyBtn.innerHTML = '<svg viewBox="0 0 24 24" style="width:12px;height:12px"><polyline points="20 6 9 17 4 12"/></svg> ' + kit.te('settings.redesign.hooks.copied') + '';
      setTimeout(() => { apikeyCopyBtn.innerHTML = '<svg viewBox="0 0 24 24" style="width:12px;height:12px"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> ' + kit.te('settings.redesign.hooks.copyKey') + ''; }, 2000);
    });
  }
  const apikeyRevokeBtn = overlay.querySelector('#cc-apikey-revoke');
  if (apikeyRevokeBtn) {
    apikeyRevokeBtn.addEventListener('click', async () => {
      if (!confirm(kit.tx('settings.redesign.hooks.revokeThisApiKeyTheMcp'))) return;
      try {
        const res = await fetch('/api/mcp-key', { method: 'DELETE' }); const data = await res.json();
        if (data.ok) {
          mcpKeyInfo = { hasKey: false };
          const reveal = overlay.querySelector('#cc-apikey-reveal'); if (reveal) reveal.style.display = 'none';
          const statusEl = overlay.querySelector('#cc-apikey-status'); if (statusEl) statusEl.textContent = kit.tx('settings.redesign.hooks.noKeyConfiguredTunnelIsOpen');
          const row = overlay.querySelector('#cc-apikey-row'); if (row) row.classList.remove('enabled');
          const genBtn = overlay.querySelector('#cc-apikey-generate'); if (genBtn) genBtn.textContent = kit.tx('settings.redesign.hooks.generateKey');
        }
      } catch (err) { alert(kit.tx('settings.redesign.hooks.failed2', { message: err.message })); }
    });
  }

  // ══════════════════════════════════════
  // Projects tab handlers
  // ══════════════════════════════════════

  // Combined storage scanner — loaded lazily when the Projects tab is opened.
  {
    const storageRoot = overlay.querySelector('#project-storage-manager');
    const storageResults = overlay.querySelector('#project-storage-results');
    const storageSummary = overlay.querySelector('#project-storage-summary');
    const storageToolbar = overlay.querySelector('#project-storage-toolbar');
    const storageFeedback = overlay.querySelector('#project-storage-feedback');
    const refreshButton = overlay.querySelector('#project-storage-refresh');
    const selectSafeButton = overlay.querySelector('#project-storage-select-safe');
    const clearSelectionButton = overlay.querySelector('#project-storage-clear-selection');
    const clearButton = overlay.querySelector('#project-storage-clear');
    let storageScan = null;
    let storageLoading = false;
    let selectedStorageItems = new Set();

    const storageEsc = (value) => escapeHtml(String(value ?? ''));
    const storageFormatBytes = (bytes) => {
      const value = Math.max(0, Number(bytes) || 0);
      if (value < 1024) return `${Math.round(value)} B`;
      const units = ['KB', 'MB', 'GB', 'TB'];
      let scaled = value / 1024;
      let index = 0;
      while (scaled >= 1024 && index < units.length - 1) { scaled /= 1024; index += 1; }
      return `${scaled.toFixed(scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2)} ${units[index]}`;
    };
    const storageFormatCount = (value, singular, plural = `${singular}s`) => {
      const count = Math.max(0, Number(value) || 0);
      return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
    };
    const allStorageItems = () => storageScan
      ? [...storageScan.projects.flatMap(group => group.items), ...(storageScan.shared?.items || [])]
      : [];
    const selectedItems = () => {
      const selected = selectedStorageItems;
      return allStorageItems().filter(item => selected.has(item.id) && !item.protected && !item.blocked);
    };

    function storageRiskMeta(item) {
      if (item.blocked) return { cls: 'blocked', label: kit.tx('settings.redesign.projects.inUse'), title: item.blockerReason };
      if (item.protected) return { cls: 'protected', label: kit.tx('settings.redesign.projects.protected'), title: item.protectionReason };
      if (item.originalRisk === 'dependency') return { cls: 'dependency', label: kit.tx('settings.redesign.projects.optionalDependency'), title: kit.tx('settings.redesign.projects.deletingThisMayRequireALater') };
      if (item.originalRisk === 'review') return { cls: 'review', label: kit.tx('settings.redesign.projects.review'), title: kit.tx('settings.redesign.projects.inspectAndSelectThisItemManually') };
      return { cls: 'safe', label: kit.tx('settings.redesign.projects.safe'), title: kit.tx('settings.redesign.projects.generatedOutputThatCanBeRebuilt') };
    }

    function syncStorageSelection() {
      const items = selectedItems();
      const bytes = items.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
      const selectedEl = overlay.querySelector('#project-storage-selected');
      if (selectedEl) selectedEl.textContent = `${storageFormatBytes(bytes)} · ${items.length}`;
      if (clearButton) {
        clearButton.disabled = storageLoading || items.length === 0;
        clearButton.textContent = items.length ? kit.tx('settings.redesign.projects.clearSelected', { count: items.length }) : kit.tx('settings.redesign.projects.clearSelected2');
      }
      if (clearSelectionButton) clearSelectionButton.disabled = storageLoading || items.length === 0;
    }

    function renderStorageItem(item) {
      const disabled = item.protected || item.blocked;
      const checked = selectedStorageItems.has(item.id) && !disabled;
      const risk = storageRiskMeta(item);
      const reason = risk.title ? ` title="${storageEsc(risk.title)}"` : '';
      return `
        <label class="project-storage-item${disabled ? ' disabled' : ''}" data-risk="${risk.cls}">
          <input class="project-storage-checkbox" type="checkbox" data-project-storage-item="${item.id}" ${kit.inv('PRJ006')} ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} aria-label="${kit.th('settings.redesign.projects.selectAt', { storageEsc: storageEsc(item.name) })} ${storageEsc(item.displayPath)}">
          <span class="project-storage-checkmark" aria-hidden="true"></span>
          <span class="project-storage-item-main">
            <span class="project-storage-item-title-row">
              <strong>${storageEsc(item.name)}</strong>
              <span class="project-storage-risk ${risk.cls}"${reason}>${risk.label}</span>
            </span>
            <span class="project-storage-path" title="${storageEsc(item.displayPath)}">${storageEsc(item.displayPath)}</span>
            <span class="project-storage-item-meta">${storageFormatCount(item.fileCount, 'file')} · ${storageEsc(item.category)}</span>
            ${disabled && (item.blockerReason || item.protectionReason) ? `<span class="project-storage-protection">${storageEsc(item.blockerReason || item.protectionReason)}</span>` : ''}
          </span>
          <strong class="project-storage-item-size">${storageFormatBytes(item.bytes)}</strong>
        </label>`;
    }

    function renderStorageGroup(group, { shared = false } = {}) {
      const items = group.items || [];
      const totalBytes = items.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
      const pathText = shared ? kit.tx('settings.redesign.projects.cachesSharedByProjectsAndDeveloper') : group.path;
      return `
        <details class="project-storage-group" open>
          <summary ${kit.inv('PRJ005')}>
            <svg class="project-storage-chevron" viewBox="0 0 24 24" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
            <span class="project-storage-group-main">
              <span class="project-storage-group-title">${storageEsc(group.label)}${group.active ? '<span class="project-storage-active-badge">' + kit.te('settings.redesign.projects.inUse') + '</span>' : ''}</span>
              <span class="project-storage-group-path" title="${storageEsc(pathText)}">${storageEsc(pathText)}</span>
            </span>
            <span class="project-storage-group-total">${storageFormatBytes(totalBytes)} · ${items.length}</span>
          </summary>
          <div class="project-storage-group-items">
            ${items.length ? items.map(renderStorageItem).join('') : '<div class="project-storage-group-empty">' + kit.te('settings.redesign.projects.noRecognizedRebuildableFilesFound') + '</div>'}
          </div>
        </details>`;
    }

    function renderProjectStorage() {
      if (!storageScan || !storageResults) return;
      const totals = storageScan.totals || {};
      const foundEl = overlay.querySelector('#project-storage-found');
      const reclaimableEl = overlay.querySelector('#project-storage-reclaimable');
      if (foundEl) foundEl.textContent = `${storageFormatBytes(totals.bytes)} · ${totals.itemCount || 0}`;
      if (reclaimableEl) reclaimableEl.textContent = `${storageFormatBytes(totals.reclaimableBytes)} · ${totals.reclaimableItemCount || 0}`;
      if (storageSummary) storageSummary.hidden = false;
      if (storageToolbar) storageToolbar.hidden = false;

      const hasAnyItems = (totals.itemCount || 0) > 0;
      const warnings = Array.isArray(storageScan.warnings) ? storageScan.warnings.filter(Boolean) : [];
      storageResults.innerHTML = hasAnyItems ? `
        ${warnings.length ? `<div class="project-storage-warning"><strong>${kit.te('settings.redesign.projects.scanNotes')}</strong>${warnings.slice(0, 3).map(warning => `<span>${storageEsc(warning)}</span>`).join('')}</div>` : ''}
        <div class="project-storage-groups">
          ${storageScan.projects.map(group => renderStorageGroup(group)).join('')}
          ${renderStorageGroup(storageScan.shared || { label: kit.tx('settings.redesign.projects.sharedDeveloperCaches'), items: [] }, { shared: true })}
        </div>` : `
        <div class="project-storage-empty">
          <svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
          <strong>${kit.te('settings.redesign.projects.noCleanupCandidatesFound')}</strong>
          <span>${kit.te('settings.redesign.projects.registeredProjectsAndKnownSharedDevelope')}</span>
        </div>`;
      syncStorageSelection();
    }

    function setStorageFeedback(message = '', state = '') {
      if (!storageFeedback) return;
      storageFeedback.textContent = message;
      if (state) storageFeedback.dataset.state = state;
      else delete storageFeedback.dataset.state;
    }

    async function loadProjectStorage(refresh = false) {
      if (!storageRoot || storageLoading) return;
      storageLoading = true;
      refreshButton?.classList.add('loading');
      if (refreshButton) refreshButton.disabled = true;
      if (!storageScan && storageResults) {
        storageResults.innerHTML = `
          <div class="project-storage-loading" role="status">
            <span class="project-storage-spinner" aria-hidden="true"></span>
            <span><strong>${kit.te('settings.redesign.projects.scanningProjectStorage')}</strong><small>${kit.te('settings.redesign.projects.measuringGeneratedFilesAndCheckingGit')}</small></span>
          </div>`;
      }
      setStorageFeedback('');
      syncStorageSelection();
      try {
        const response = await fetch(`/api/settings/project-storage${refresh ? '?refresh=1' : ''}`);
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) throw new Error(data.error || kit.tx('settings.redesign.projects.storageScanFailedHttp', { status: response.status }));
        storageScan = data;
        selectedStorageItems = new Set(allStorageItems().filter(item => item.defaultSelected).map(item => item.id));
        renderProjectStorage();
      } catch (error) {
        if (!storageScan && storageResults) {
          storageResults.innerHTML = `
            <div class="project-storage-error" role="alert">
              <strong>${kit.te('settings.redesign.projects.storageScanUnavailable')}</strong>
              <span>${storageEsc(error?.message || kit.tx('settings.redesign.projects.couldNotScanProjectStorage'))}</span>
              <button class="project-storage-btn" type="button" data-project-storage-retry>${kit.te('settings.redesign.projects.tryAgain')}</button>
            </div>`;
        }
        setStorageFeedback(error?.message || kit.tx('settings.redesign.projects.couldNotScanProjectStorage'), 'error');
      } finally {
        storageLoading = false;
        refreshButton?.classList.remove('loading');
        if (refreshButton) refreshButton.disabled = false;
        syncStorageSelection();
      }
    }

    function openProjectStorageClearModal() {
      if (!storageScan || document.querySelector('.project-storage-clear-overlay')) return;
      const items = selectedItems();
      if (!items.length) return;
      const dependencies = items.filter(item => item.originalRisk === 'dependency');
      const reviewItems = items.filter(item => item.originalRisk === 'review');
      const requiresTyping = dependencies.length > 0;
      const confirmation = requiresTyping
        ? (storageScan.confirmations?.dependency || 'DELETE DEPENDENCIES')
        : (storageScan.confirmations?.safe || 'CLEAR SELECTED CACHES');
      const totalBytes = items.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
      const modal = document.createElement('div');
      modal.className = 'tag-delete-overlay project-storage-clear-overlay';
      modal.innerHTML = `
        <div class="tag-delete-modal settings-modal project-storage-modal" role="dialog" aria-modal="true" aria-labelledby="project-storage-modal-title" aria-describedby="project-storage-modal-description">
          <div class="project-storage-modal-head">
            <span class="project-storage-modal-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/></svg>
            </span>
            <div>
              <h2 id="project-storage-modal-title">${kit.te('settings.redesign.projects.clearSelectedProjectStorage')}</h2>
              <p>${storageFormatCount(items.length, 'item')} · ${storageFormatBytes(totalBytes)}</p>
            </div>
          </div>
          <div class="project-storage-modal-warning" id="project-storage-modal-description">
            ${requiresTyping
              ? `<strong>${storageFormatCount(dependencies.length, kit.tx('settings.redesign.projects.dependencyCache'))} ${kit.te('settings.redesign.projects.selected')}</strong> ${kit.te('settings.redesign.projects.theseFilesCanBeRestoredBut')}`
              : reviewItems.length
                ? `<strong>${storageFormatCount(reviewItems.length, kit.tx('settings.redesign.projects.manuallyReviewedItem'))} ${kit.te('settings.redesign.projects.selected')}</strong> ${kit.te('settings.redesign.projects.theseWereNotSelectedAutomaticallyConfirm')}`
                : '<strong>' + kit.te('settings.redesign.projects.generatedFilesWillBeRemoved') + '</strong> ' + kit.te('settings.redesign.projects.buildsAndCachesCanBeRecreated') + ''}
          </div>
          <div class="project-storage-modal-list">
            ${items.slice(0, 6).map(item => `<div><span>${storageEsc(item.name)}<small>${storageEsc(item.displayPath)}</small></span><strong>${storageFormatBytes(item.bytes)}</strong></div>`).join('')}
            ${items.length > 6 ? `<div class="more"><span>${kit.th('settings.redesign.projects.andMoreSelectedItems', { count: items.length - 6 })}</span></div>` : ''}
          </div>
          ${requiresTyping ? `
            <label class="project-storage-confirm-label" for="project-storage-confirm-input">${kit.te('settings.redesign.projects.type')} <code>${storageEsc(confirmation)}</code> ${kit.te('settings.redesign.projects.toContinue')}</label>
            <input class="project-storage-confirm-input" id="project-storage-confirm-input" type="text" autocomplete="off" spellcheck="false">` : ''}
          <div class="project-storage-modal-feedback" id="project-storage-modal-feedback" aria-live="polite"></div>
          <div class="tag-delete-modal-actions">
            <button class="action-btn action-btn--ghost" id="project-storage-modal-cancel" type="button">${kit.te('settings.redesign.projects.cancel')}</button>
            <button class="action-btn action-btn--danger" id="project-storage-modal-confirm" type="button" ${requiresTyping ? 'disabled' : ''}>${kit.th('settings.redesign.projects.clearSelected3', { count: items.length })}</button>
          </div>
        </div>`;
      document.body.appendChild(modal);

      const dialog = modal.querySelector('.project-storage-modal');
      const input = modal.querySelector('#project-storage-confirm-input');
      const cancel = modal.querySelector('#project-storage-modal-cancel');
      const confirm = modal.querySelector('#project-storage-modal-confirm');
      const feedback = modal.querySelector('#project-storage-modal-feedback');
      let working = false;
      const closeModal = (force = false) => {
        if (working && !force) return;
        document.removeEventListener('keydown', onKeydown, true);
        modal.remove();
      };
      const onKeydown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopImmediatePropagation();
          closeModal();
          return;
        }
        if (event.key !== 'Tab') return;
        const focusable = [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled])')];
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      };
      document.addEventListener('keydown', onKeydown, true);
      cancel.addEventListener('click', () => closeModal());
      input?.addEventListener('input', () => {
        confirm.disabled = input.value !== confirmation;
        feedback.textContent = '';
        delete feedback.dataset.state;
      });
      requestAnimationFrame(() => (input || cancel).focus());

      confirm.addEventListener('click', async () => {
        if (working || (requiresTyping && input.value !== confirmation)) return;
        working = true;
        cancel.disabled = true;
        confirm.disabled = true;
        if (input) input.disabled = true;
        confirm.textContent = kit.tx('settings.redesign.projects.clearing');
        feedback.dataset.state = 'working';
        feedback.textContent = kit.tx('settings.redesign.projects.revalidatingTheSelectionAndClearingFiles');
        try {
          const response = await fetch('/api/settings/project-storage/clear', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              scanId: storageScan.scanId,
              itemIds: items.map(item => item.id),
              confirmation: requiresTyping ? input.value : confirmation,
            }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) {
            const detail = Array.isArray(data.details) && data.details[0]?.error ? ` ${data.details[0].error}` : '';
            const error = new Error(`${data.error || kit.tx('settings.redesign.projects.cleanupFailedHttp', { status: response.status })}${detail}`);
            error.requiresRescan = !!data.requiresRescan || ['SCAN_EXPIRED', 'SCAN_MISMATCH', 'PROJECT_ACTIVE'].includes(data.code);
            throw error;
          }
          const failedNames = (data.results || [])
            .filter(result => result.status === 'failed')
            .map(result => items.find(item => item.id === result.id)?.name || kit.tx('settings.redesign.projects.unknownItem'));
          const message = data.failedItemCount
            ? kit.tx('settings.redesign.projects.clearedCouldNotClear', { storageFormatCount: storageFormatCount(data.clearedItemCount, 'item'), storageFormatBytes: storageFormatBytes(data.bytesCleared), failedNames: failedNames.join(', ') })
            : kit.tx('settings.redesign.projects.clearedAndReclaimedAbout', { storageFormatCount: storageFormatCount(data.clearedItemCount, 'item'), storageFormatBytes: storageFormatBytes(data.bytesCleared) });
          working = false;
          closeModal(true);
          storageScan = null;
          selectedStorageItems.clear();
          await loadProjectStorage(true);
          setStorageFeedback(message, data.failedItemCount ? 'warning' : 'success');
          showCCToast(data.failedItemCount ? kit.tx('settings.redesign.projects.projectStoragePartiallyCleared') : kit.tx('settings.redesign.projects.projectStorageCleared'));
        } catch (error) {
          working = false;
          cancel.disabled = false;
          cancel.textContent = kit.tx('settings.redesign.projects.close');
          confirm.textContent = kit.tx('settings.redesign.projects.clearSelected2');
          confirm.disabled = true;
          if (input) input.disabled = true;
          feedback.dataset.state = 'error';
          feedback.textContent = error?.message || kit.tx('settings.redesign.projects.couldNotClearSelectedStorage');
          if (error?.requiresRescan) {
            storageScan = null;
            selectedStorageItems.clear();
            loadProjectStorage(true);
          }
          cancel.focus();
        }
      });
    }

    storageResults?.addEventListener('change', (event) => {
      const checkbox = event.target.closest('[data-project-storage-item]');
      if (!checkbox) return;
      if (checkbox.checked) selectedStorageItems.add(checkbox.dataset.projectStorageItem);
      else selectedStorageItems.delete(checkbox.dataset.projectStorageItem);
      syncStorageSelection();
    });
    storageResults?.addEventListener('click', (event) => {
      if (event.target.closest('[data-project-storage-retry]')) loadProjectStorage(true);
    });
    refreshButton?.addEventListener('click', () => loadProjectStorage(true));
    selectSafeButton?.addEventListener('click', () => {
      selectedStorageItems = new Set(allStorageItems()
        .filter(item => item.originalRisk === 'safe' && !item.protected && !item.blocked)
        .map(item => item.id));
      renderProjectStorage();
    });
    clearSelectionButton?.addEventListener('click', () => {
      selectedStorageItems.clear();
      renderProjectStorage();
    });
    clearButton?.addEventListener('click', openProjectStorageClearModal);

    const projectsNav = overlay.querySelector('.settings-nav-item[data-tab="projects"]');
    projectsNav?.addEventListener('click', () => {
      if (!storageScan && !storageLoading) loadProjectStorage();
    });
    // A deep link or the page picker shows the page without a nav click.
    overlay.addEventListener('stg-page-change', (e) => {
      if (e.detail?.page === 'projects' && !storageScan && !storageLoading) loadProjectStorage();
    });
    if (overlay.querySelector('.settings-tab-body[data-tab="projects"]')?.classList.contains('active')) {
      loadProjectStorage();
    }
  }

  // Explore project
  function openExploreModal(projectPath, projectLabel) {
    const EXPLORE_CLI_IDS = ['claude-code', 'codex', 'gemini'];
    const CLI_OPTIONS = CLI_PROFILES
      .filter(p => EXPLORE_CLI_IDS.includes(p.id))
      .map(p => ({ id: p.id, label: p.label }));
    const getExploreModels = (cli) => getModelsForProfile(cli);

    let selectedCli = 'claude-code';
    let selectedModel = getExploreModels('claude-code')[0]?.id || '';

    const exploreOverlay = document.createElement('div');
    exploreOverlay.className = 'tag-delete-overlay';
    exploreOverlay.style.zIndex = '300100';

    function tierColor(tier) {
      return tier === 'top' ? 'rgba(255, 180, 80, 0.7)'
        : tier === 'light' ? 'rgba(130, 200, 255, 0.7)'
        : 'rgba(255, 255, 255, 0.6)';
    }

    function renderCliCards() {
      return CLI_OPTIONS.map(c => `
        <div class="explore-cli-card" data-cli="${c.id}" style="
          flex:1;padding:14px 12px;text-align:center;border-radius:8px;cursor:pointer;
          background:${c.id === selectedCli ? 'var(--accent-blue-bg)' : 'var(--s-medium)'};
          border:1px solid ${c.id === selectedCli ? 'var(--accent-blue-border)' : 'var(--s-light)'};
          color:${c.id === selectedCli ? 'var(--accent-blue)' : 'var(--t-primary)'};
          transition:border-color 0.15s,background 0.15s;
        ">
          <div style="font-size:13px;font-weight:600">${c.label}</div>
        </div>
      `).join('');
    }

    function renderModelCards() {
      const models = getExploreModels(selectedCli);
      if (!models.length) return '<div style="font-size:12px;color:var(--t-muted)">' + kit.te('settings.redesign.projects.noModelSelectionAvailable') + '</div>';
      if (!models.find(m => m.id === selectedModel)) selectedModel = models[0].id;
      return models.map(m => `
        <div class="explore-model-card" data-model="${m.id}" style="
          flex:1;padding:14px 12px;text-align:center;border-radius:8px;cursor:pointer;
          background:${m.id === selectedModel ? 'var(--accent-blue-bg)' : 'var(--s-medium)'};
          border:1px solid ${m.id === selectedModel ? 'var(--accent-blue-border)' : 'var(--s-light)'};
          transition:border-color 0.15s,background 0.15s;
        ">
          <div style="font-size:13px;font-weight:600;color:${tierColor(m.tier)}">${m.label}</div>
          <div style="font-size:11px;color:var(--t-muted);margin-top:4px">${m.desc}</div>
        </div>
      `).join('');
    }

    function renderModal() {
      exploreOverlay.innerHTML = `
        <div class="tag-delete-modal settings-modal" style="max-width:520px;padding:24px 28px">
          <h3 style="margin:0 0 20px;font-size:16px;font-weight:600;color:var(--t-primary)">
            <svg viewBox="0 0 24 24" style="width:16px;height:16px;stroke:var(--accent-blue);stroke-width:2;fill:none;vertical-align:-2px;margin-right:6px"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            ${kit.te('settings.redesign.projects.explore')} ${escapeHtml(projectLabel)}
          </h3>
          <div style="margin-bottom:18px">
            <div style="font-size:12px;color:var(--t-muted);margin-bottom:8px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">${kit.te('settings.redesign.projects.cli')}</div>
            <div id="explore-cli-cards" style="display:flex;gap:8px">${renderCliCards()}</div>
          </div>
          <div style="margin-bottom:22px">
            <div style="font-size:12px;color:var(--t-muted);margin-bottom:8px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">${kit.te('settings.redesign.projects.model')}</div>
            <div id="explore-model-cards" style="display:flex;gap:8px">${renderModelCards()}</div>
          </div>
          <div class="settings-actions" style="margin-top:0;display:flex;justify-content:flex-end;gap:8px">
            <button class="settings-btn-cancel" id="explore-cancel">${kit.te('settings.redesign.projects.cancel')}</button>
            <button class="settings-btn-save" id="explore-begin">${kit.te('settings.redesign.projects.beginExploration')}</button>
          </div>
        </div>`;
      wireModalEvents();
    }

    function wireModalEvents() {
      exploreOverlay.querySelectorAll('.explore-cli-card').forEach(card => {
        card.addEventListener('click', () => {
          const cli = card.dataset.cli;
          selectedCli = cli;
          selectedModel = getExploreModels(cli)[0]?.id || '';
          renderModal();
          if (cli === 'codex') {
            ensureModelsForProfile(cli).then(() => {
              if (exploreOverlay.isConnected && selectedCli === cli) renderModal();
            });
          }
        });
      });
      exploreOverlay.querySelectorAll('.explore-model-card').forEach(card => {
        card.addEventListener('click', () => {
          selectedModel = card.dataset.model;
          renderModal();
        });
      });
      exploreOverlay.querySelector('#explore-cancel').addEventListener('click', closeExplore);
      // Overlay click disabled — close only via ESC or cancel button
      exploreOverlay.querySelector('#explore-begin').addEventListener('click', () => {
        const beginBtn = exploreOverlay.querySelector('#explore-begin');
        beginBtn.textContent = kit.tx('settings.redesign.projects.launching');
        beginBtn.disabled = true;
        const fail = (err) => {
          alert(kit.tx('settings.redesign.projects.explorationLaunchFailed', { message: (err?.message || err) }));
          beginBtn.textContent = kit.tx('settings.redesign.projects.beginExploration');
          beginBtn.disabled = false;
        };
        try {
          const slug = projectLabel.toLowerCase().replace(/[^a-z0-9]+/g, '');
          const prompt = buildExplorePrompt(slug);
          // The terminal spawns the CLI at its floating window's real grid
          // (not a hardcoded 120×30 it would then have to resize away from)
          emit('terminal:launch-floating', {
            profile: selectedCli,
            cwd: projectPath,
            createOpts: selectedModel ? { model: selectedModel } : {},
            initialMessage: prompt,
            autoSubmit: true,
            onDone: (err) => { if (err) fail(err); else closeExplore(); },
          });
        } catch (err) {
          fail(err);
        }
      });
    }

    function closeExplore() { exploreOverlay.remove(); }

    renderModal();
    document.body.appendChild(exploreOverlay);
  }

  overlay.querySelectorAll('.cc-explore-btn[data-cc-explore]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = btn.dataset.ccExplore;
      const panel = overlay.querySelector(`.cc-panel[data-cc-idx="${idx}"]`);
      const projectPath = panel?.dataset.ccPath;
      const projectLabel = panel?.querySelector('.cc-panel-title')?.textContent || kit.tx('settings.redesign.projects.project');
      if (projectPath) openExploreModal(projectPath, projectLabel);
    });
  });

  // Trust workspace (adds to git safe.directory global config)
  overlay.querySelectorAll('.cc-trust-btn[data-cc-trust]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = btn.dataset.ccTrust;
      const panel = overlay.querySelector(`.cc-panel[data-cc-idx="${idx}"]`);
      const projectPath = panel?.dataset.ccPath;
      if (!projectPath) return;
      const origText = btn.textContent;
      btn.disabled = true;
      btn.textContent = kit.tx('settings.redesign.projects.trusting');
      try {
        const res = await fetch('/api/terminal/trust-workspace', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: projectPath }),
        });
        const data = await res.json();
        if (data.ok) {
          btn.textContent = kit.tx('settings.redesign.projects.trusted');
          btn.style.background = 'rgba(109,213,140,0.14)';
          btn.style.borderColor = 'rgba(109,213,140,0.3)';
          btn.style.color = '#a5d6a7';
          setTimeout(() => { btn.disabled = false; btn.textContent = kit.tx('settings.redesign.projects.trustWorkspace'); btn.style.background = 'rgba(255,183,77,0.14)'; btn.style.borderColor = 'rgba(255,183,77,0.3)'; btn.style.color = '#ffcc80'; }, 2500);
        } else {
          btn.disabled = false;
          btn.textContent = origText;
          alert(kit.tx('settings.redesign.projects.trustFailed', { error: (data.error || kit.tx('settings.redesign.projects.unknownError')) }));
        }
      } catch (err) {
        btn.disabled = false;
        btn.textContent = origText;
        alert(kit.tx('settings.redesign.projects.trustFailed2', { message: err.message }));
      }
    });
  });

  // Remove project
  overlay.querySelectorAll('.cc-remove-panel-btn[data-cc-remove]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = btn.dataset.ccRemove;
      const panel = overlay.querySelector(`.cc-panel[data-cc-idx="${idx}"]`);
      const label = panel?.querySelector('.cc-panel-title')?.textContent || kit.tx('settings.redesign.projects.thisProject');
      if (!confirm(kit.tx('settings.redesign.projects.removeFromTrackedProjectsThisAlso', { label: label }))) return;
      try {
        const projectPath = panel?.dataset.ccPath;
        if (projectPath && panel.classList.contains('enabled')) {
          await fetch('/api/claude-code/integrations', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: 'project', projectPath }) });
        }
        const res = await fetch(`/api/claude-code/projects/${idx}`, { method: 'DELETE' }); const data = await res.json();
        if (data.ok) {
          panel.style.transition = 'opacity 0.2s, transform 0.2s'; panel.style.opacity = '0'; panel.style.transform = 'translateX(10px)';
          setTimeout(() => { panel.remove(); updateProjectCount(); if (!overlay.querySelector('.cc-panel[data-cc-idx]')) overlay.querySelector('#cc-project-list').innerHTML = '<div class="cc-hint" style="text-align:center;padding:14px">' + kit.te('settings.redesign.projects.noProjectsRegisteredYet') + '</div>'; }, 200);
        } else { alert(data.error || kit.tx('settings.redesign.projects.failedToRemoveProject')); }
      } catch (err) { alert(kit.tx('settings.redesign.projects.failed', { message: err.message })); }
    });
  });

  // Add project
  overlay.querySelector('#cc-add-project').addEventListener('click', () => {
    const addOverlay = document.createElement('div');
    addOverlay.className = 'tag-delete-overlay'; addOverlay.style.zIndex = '300100';
    addOverlay.innerHTML = `
      <div class="tag-delete-modal settings-modal" style="max-width:480px">
        <h3><svg viewBox="0 0 24 24" style="width:16px;height:16px;stroke:var(--accent-blue);stroke-width:2;fill:none"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>${kit.te('settings.redesign.projects.addProject')}</h3>
        <div class="settings-field" ${kit.inv('PRJ014')}><label for="cc-proj-path">${kit.L('PRJ014')}</label>
          <div style="display:flex;gap:6px;align-items:center">
            <input type="text" id="cc-proj-path" placeholder="/home/user/myproject" autocomplete="off" spellcheck="false" style="font-family:'JetBrains Mono',monospace;font-size:12px;flex:1">
            <button type="button" id="cc-proj-browse" ${kit.inv('PRJ015')} style="flex:0 0 auto;padding:5px 10px;background:var(--s-medium);border:1px solid var(--s-light);border-radius:4px;color:var(--t-primary);cursor:pointer;font-size:12px;display:flex;align-items:center;gap:4px" title="${kit.te('settings.redesign.projects.browseFolders')}">
              <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
              ${kit.te('settings.redesign.projects.browse')}
            </button>
          </div>
        </div>
        <div class="settings-field" ${kit.inv('PRJ016')}><label for="cc-proj-label">${kit.L('PRJ016')} <span style="color:var(--t-muted);font-weight:normal">${kit.te('settings.redesign.projects.optional')}</span></label><input type="text" id="cc-proj-label" placeholder="${kit.te('settings.redesign.projects.myProject')}" autocomplete="off" spellcheck="false"></div>
        <div class="cc-hint">${kit.te('settings.redesign.projects.theHookWillBeAddedTo')} <code style="font-size:12px;background:var(--s-medium);padding:2px 5px;border-radius:4px">.claude/settings.json</code> ${kit.te('settings.redesign.projects.insideThisDirectory')}</div>
        <div class="settings-actions" style="margin-top:12px"><button type="button" class="settings-btn-cancel" id="cc-proj-cancel" ${kit.inv('PRJ018')}>${kit.te('settings.redesign.projects.cancel')}</button><button type="button" class="settings-btn-save" id="cc-proj-save" ${kit.inv('PRJ017')}>${kit.te('settings.redesign.projects.addEnable')}</button></div>
      </div>`;
    document.body.appendChild(addOverlay);
    const closeAdd = () => addOverlay.remove();

    // Native OS folder picker
    const browseBtn = addOverlay.querySelector('#cc-proj-browse');
    const pathInput = addOverlay.querySelector('#cc-proj-path');
    const labelInput = addOverlay.querySelector('#cc-proj-label');

    browseBtn.addEventListener('click', async () => {
      const origHTML = browseBtn.innerHTML;
      browseBtn.innerHTML = '<div class="spinner" style="width:12px;height:12px"></div> ' + kit.te('settings.redesign.projects.opening') + '';
      browseBtn.disabled = true;
      try {
        const res = await fetch('/api/browse-folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: kit.tx('settings.redesign.projects.selectProjectFolder') }),
        });
        const data = await res.json();
        if (data.path) {
          pathInput.value = data.path.replace(/\\/g, '/');
          if (!labelInput.value.trim()) {
            labelInput.value = data.path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
          }
        }
      } catch {}
      browseBtn.innerHTML = origHTML;
      browseBtn.disabled = false;
    });

    addOverlay.querySelector('#cc-proj-cancel').addEventListener('click', closeAdd);
    // Overlay click disabled — close only via ESC or cancel button
    addOverlay.querySelector('#cc-proj-save').addEventListener('click', async () => {
      const projPath = addOverlay.querySelector('#cc-proj-path').value.trim();
      const label = addOverlay.querySelector('#cc-proj-label').value.trim();
      if (!projPath) { alert(kit.tx('settings.redesign.projects.projectPathIsRequired')); return; }
      try {
        const saveBtn = addOverlay.querySelector('#cc-proj-save'); saveBtn.textContent = kit.tx('settings.redesign.projects.adding'); saveBtn.disabled = true;
        const res = await fetch('/api/claude-code/integrations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: 'project', projectPath: projPath, label }) });
        const data = await res.json();
        if (data.ok) {
          closeAdd(); close();
          openSettingsModal().then(() => {
            const panel = document.getElementById('settings-panel');
            panel?.querySelector('.settings-nav-item[data-tab="projects"]')?.click();
          });
        } else { alert(data.error || kit.tx('settings.redesign.projects.failedToAddProject')); saveBtn.textContent = kit.tx('settings.redesign.projects.addEnable'); saveBtn.disabled = false; }
      } catch (err) { alert(kit.tx('settings.redesign.projects.failed', { message: err.message })); const saveBtn = addOverlay.querySelector('#cc-proj-save'); saveBtn.textContent = kit.tx('settings.redesign.projects.addEnable'); saveBtn.disabled = false; }
    });
  });

  // ── OpenCode tab: wire interaction ──
  {
    const ocpStatusEl = overlay.querySelector('#stg-ocp-status');
    const ocpDotEl = overlay.querySelector('#stg-ocp-dot');
    function setOcpStatus(text, state) {
      if (ocpStatusEl) ocpStatusEl.textContent = text;
      if (ocpDotEl) ocpDotEl.dataset.state = state || 'dim';
    }
    const ocpProvidersEl = overlay.querySelector('#stg-ocp-providers');
    const ocpProviderFilterInput = overlay.querySelector('#stg-ocp-provider-filter');
    const ocpToolsEl = overlay.querySelector('#stg-ocp-tools');
    const ocpHistoryMetaEl = overlay.querySelector('#stg-ocp-history-meta');
    const ocpHistoryClearBtn = overlay.querySelector('#stg-ocp-clear-history');
    const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // ── Helpers ──
    let _ocpConnected = new Set();
    let _ocpStoredKeys = new Set();
    let _ocpProviders = [];
    let _ocpAuthMethods = {};
    let _ocpShowAll = false;
    let _ocpConfig = {};
    let _ocpProviderFilter = '';
    let _ocpProviderCapFilters = new Set();

    // ── Ollama state ──
    let _ollamaRunning = false;
    let _ollamaVersion = null;
    let _ollamaModels = [];
    let _ollamaConfigured = false;
    let _ollamaConfiguredCount = 0;
    let _ollamaUserRemoved = false;
    let _ollamaConfiguring = false;
    let _ollamaPollTimer = null;
    let _ollamaLastModelNames = '';
    let _ocpHistoryStats = null;

    function formatBytes(bytes) {
      const value = Number(bytes) || 0;
      if (value <= 0) return '0 B';
      const gb = value / (1024 ** 3);
      if (gb >= 1) return `${gb.toFixed(1)} GB`;
      const mb = value / (1024 ** 2);
      if (mb >= 1) return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
      const kb = value / 1024;
      return kb >= 1 ? `${kb.toFixed(kb >= 10 ? 0 : 1)} KB` : `${value} B`;
    }

    function formatCount(value, singular, plural = `${singular}s`) {
      const count = Number(value) || 0;
      return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
    }

    async function loadOcpHistoryStats() {
      if (!ocpHistoryMetaEl || !ocpHistoryClearBtn) return;
      ocpHistoryClearBtn.disabled = true;
      try {
        const response = await fetch('/api/opencode/history');
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || kit.tx('settings.redesign.opencode.historyStatusUnavailable'));
        _ocpHistoryStats = data;
        if (data.clearing) {
          ocpHistoryMetaEl.textContent = kit.tx('settings.redesign.opencode.historyWipeInProgress');
          return;
        }
        const totalBytes = (Number(data.databaseBytes) || 0) + (Number(data.artifactBytes) || 0);
        ocpHistoryMetaEl.textContent = kit.tx('settings.redesign.opencode.stored', { formatCount: formatCount(data.sessions, 'session'), formatBytes: formatBytes(totalBytes) });
        ocpHistoryClearBtn.disabled = false;
      } catch (error) {
        ocpHistoryMetaEl.textContent = error?.message || kit.tx('settings.redesign.opencode.historyStatusUnavailable');
      }
    }

    function openOcpHistoryClearModal() {
      if (document.querySelector('.ocp-history-clear-overlay')) return;
      const confirmation = _ocpHistoryStats?.confirmationPhrase || 'DELETE OPENCODE HISTORY';
      const sessionCount = Number(_ocpHistoryStats?.sessions) || 0;
      const totalBytes = (Number(_ocpHistoryStats?.databaseBytes) || 0)
        + (Number(_ocpHistoryStats?.artifactBytes) || 0);
      const modal = document.createElement('div');
      modal.className = 'tag-delete-overlay ocp-history-clear-overlay';
      modal.innerHTML = `
        <div class="tag-delete-modal settings-modal ocp-history-modal" role="dialog" aria-modal="true" aria-labelledby="ocp-history-modal-title">
          <div class="ocp-history-modal-head">
            <span class="ocp-history-warning-icon" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
            </span>
            <div>
              <h2 class="ocp-history-modal-title" id="ocp-history-modal-title">${kit.te('settings.redesign.opencode.permanentlyClearOpencodeHistory')}</h2>
              <p class="ocp-history-modal-subtitle">${formatCount(sessionCount, 'session')} ${kit.th('settings.redesign.opencode.currentlyStored', { formatBytes: formatBytes(totalBytes) })}</p>
            </div>
          </div>
          <div class="ocp-history-warning"><strong>${kit.te('settings.redesign.opencode.thisCannotBeUndone')}</strong> ${kit.te('settings.redesign.opencode.activeConversationsOrAutomationsMustBe')}</div>
          <ul class="ocp-history-scope">
            <li>${kit.te('settings.redesign.opencode.deletesConversationsMessagesToolOutputTo')}</li>
            <li>${kit.te('settings.redesign.opencode.deletesSynabunSDerivedOpencodeResume')}</li>
            <li>${kit.te('settings.redesign.opencode.keepsProviderCredentialsAccountConfigSet')}</li>
          </ul>
          <label class="ocp-history-confirm-label" for="ocp-history-confirm-input">${kit.te('settings.redesign.opencode.type')} <code>${confirmation}</code> ${kit.te('settings.redesign.opencode.toEnableTheWipe')}</label>
          <input class="ocp-history-confirm-input" id="ocp-history-confirm-input" type="text" autocomplete="off" spellcheck="false" aria-describedby="ocp-history-feedback">
          <div class="ocp-history-feedback" id="ocp-history-feedback" aria-live="polite"></div>
          <div class="tag-delete-modal-actions">
            <button class="action-btn action-btn--ghost" id="ocp-history-cancel">${kit.te('settings.redesign.opencode.cancel')}</button>
            <button class="action-btn action-btn--danger" id="ocp-history-confirm" disabled>${kit.te('settings.redesign.opencode.clearHistoryPermanently')}</button>
          </div>
        </div>`;
      document.body.appendChild(modal);

      const input = modal.querySelector('#ocp-history-confirm-input');
      const cancelButton = modal.querySelector('#ocp-history-cancel');
      const confirmButton = modal.querySelector('#ocp-history-confirm');
      const feedback = modal.querySelector('#ocp-history-feedback');
      let working = false;

      const closeModal = () => {
        if (working) return;
        document.removeEventListener('keydown', onModalKeydown, true);
        modal.remove();
      };
      const onModalKeydown = (event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopImmediatePropagation();
        closeModal();
      };
      document.addEventListener('keydown', onModalKeydown, true);
      cancelButton.addEventListener('click', closeModal);
      input.addEventListener('input', () => {
        confirmButton.disabled = input.value !== confirmation;
        feedback.textContent = '';
        delete feedback.dataset.state;
      });
      requestAnimationFrame(() => input.focus());

      confirmButton.addEventListener('click', async () => {
        if (working || input.value !== confirmation) return;
        working = true;
        input.disabled = true;
        cancelButton.disabled = true;
        confirmButton.disabled = true;
        confirmButton.textContent = kit.tx('settings.redesign.opencode.clearing');
        feedback.dataset.state = 'working';
        feedback.textContent = kit.tx('settings.redesign.opencode.stoppingOpencodeAndClearingItsHistory');
        const requestId = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
        sessionStorage.setItem('synabun-opencode-history-clear-request', requestId);
        try {
          const response = await fetch('/api/opencode/history', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirmation, requestId }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || !data.ok) throw new Error(data.error || kit.tx('settings.redesign.opencode.historyWipeFailedHttp', { status: response.status }));

          const result = data.result || {};
          const reclaimed = Math.max(0,
            (Number(result.databaseBytesBefore) || 0) - (Number(result.databaseBytesAfter) || 0)
              + (Number(result.artifactBytesDeleted) || 0));
          const warnings = Array.isArray(result.warnings) ? result.warnings.filter(Boolean) : [];
          feedback.dataset.state = warnings.length ? 'warning' : 'working';
          feedback.textContent = warnings.length
            ? kit.tx('settings.redesign.opencode.historyWasClearedWarningReloadingSynabun', { value: warnings[0] })
            : kit.tx('settings.redesign.opencode.clearedReloadingSynabun', { formatCount: formatCount(result.sessionsDeleted, 'session'), reclaimed: reclaimed ? (" " + kit.tx('settings.redesign.opencode.andReclaimed', { formatBytes: formatBytes(reclaimed) })) : '' });
          confirmButton.textContent = kit.tx('settings.redesign.opencode.historyCleared');
          showCCToast(warnings.length ? kit.tx('settings.redesign.opencode.opencodeHistoryClearedWithAWarning') : kit.tx('settings.redesign.opencode.opencodeHistoryCleared'));
          setTimeout(() => location.reload(), warnings.length ? 3500 : 1200);
        } catch (error) {
          sessionStorage.removeItem('synabun-opencode-history-clear-request');
          working = false;
          input.disabled = false;
          cancelButton.disabled = false;
          confirmButton.textContent = kit.tx('settings.redesign.opencode.clearHistoryPermanently');
          confirmButton.disabled = input.value !== confirmation;
          feedback.dataset.state = 'error';
          feedback.textContent = error?.message || kit.tx('settings.redesign.opencode.couldNotClearOpencodeHistory');
          input.focus();
          loadOcpHistoryStats();
        }
      });
    }

    ocpHistoryClearBtn?.addEventListener('click', openOcpHistoryClearModal);

    function renderOllamaCard() {
      if (!ocpProvidersEl) return;
      let existing = ocpProvidersEl.querySelector('.stg-ollama-card');
      if (!existing) {
        existing = document.createElement('div');
        existing.className = 'stg-ollama-card';
        ocpProvidersEl.prepend(existing);
      }

      let dotColor, statusText, statusCls, bodyHtml, removeHtml = '';

      if (_ollamaConfiguring) {
        dotColor = '#facc15';
        statusText = kit.tx('settings.redesign.opencode.configuring');
        statusCls = 'stg-provider-status-key';
        bodyHtml = '<div class="stg-provider-note">' + kit.te('settings.redesign.opencode.writingProviderConfigAndRestartingOpenco') + '</div>';
      } else if (!_ollamaRunning) {
        dotColor = 'rgba(248,113,113,0.7)';
        statusText = kit.tx('settings.redesign.opencode.notDetected');
        statusCls = 'stg-provider-status-disconnected';
        bodyHtml = '<div class="stg-provider-note">' + kit.te('settings.redesign.opencode.installFrom') + ' <code class="stg-code">ollama.com</code> ' + kit.te('settings.redesign.opencode.orRun') + ' <code class="stg-code">ollama serve</code></div>';
      } else if (_ollamaModels.length === 0) {
        dotColor = '#facc15';
        statusText = kit.tx('settings.redesign.opencode.runningVersion', { version: _ollamaVersion ? ' v' + _ollamaVersion : '' });
        statusCls = 'stg-provider-status-key';
        bodyHtml = '<div class="stg-provider-note">' + kit.te('settings.redesign.opencode.noModelsRun') + ' <code class="stg-code">ollama pull &lt;model&gt;</code></div>';
      } else if (_ollamaConfigured) {
        dotColor = '#4ade80';
        statusText = kit.tx('settings.redesign.opencode.runningVersion', { version: _ollamaVersion ? ' v' + _ollamaVersion : '' });
        statusCls = 'stg-provider-status-connected';
        bodyHtml = `<div class="stg-provider-toolbar">`
          + `<span class="stg-provider-tag">${kit.te('settings.redesign.opencode.autoConfigured')}</span>`
          + `<span class="stg-provider-sep">·</span>`
          + `<span class="stg-provider-submeta">${_ollamaModels.length} ${kit.te('settings.redesign.opencode.model')}${_ollamaModels.length !== 1 ? 's' : ''}</span>`
          + `</div>`;
        removeHtml = `<button type="button" class="stg-action-btn compact stg-text-btn stg-text-btn-danger stg-ollama-remove stg-ocp-remove-btn">${kit.te('settings.redesign.opencode.remove')}</button>`;
      } else {
        dotColor = '#facc15';
        statusText = kit.tx('settings.redesign.opencode.runningVersion', { version: _ollamaVersion ? ' v' + _ollamaVersion : '' });
        statusCls = 'stg-provider-status-key';
        bodyHtml = `<div class="stg-provider-note">${_ollamaModels.length} ${kit.th('settings.redesign.opencode.modelReadyToConfigure', { count: _ollamaModels.length !== 1 ? 's' : '' })}</div>`;
      }

      existing.innerHTML = `<div class="stg-provider-card" style="--prov-accent:${dotColor}">
          <div class="stg-provider-head">
            <div class="stg-provider-ident">
              <span class="stg-provider-name">Ollama <span class="stg-provider-subname">${kit.te('settings.redesign.opencode.local')}</span></span>
              ${bodyHtml}
            </div>
            <div class="stg-provider-side">
              <span class="stg-provider-status ${statusCls}">${statusText}</span>
              ${removeHtml}
            </div>
          </div>
      </div>`;

      // Wire remove button
      existing.querySelector('.stg-ollama-remove')?.addEventListener('click', async () => {
        const btn = existing.querySelector('.stg-ollama-remove');
        if (btn) { btn.disabled = true; btn.textContent = kit.tx('settings.redesign.opencode.removing'); }
        try {
          await fetch('/api/ollama/configure', { method: 'DELETE' });
          _ollamaConfigured = false;
          _ollamaConfiguredCount = 0;
          _ollamaUserRemoved = true;
          renderOllamaCard();
          showCCToast(kit.tx('settings.redesign.opencode.ollamaProviderRemovedServerRestarting'));
          // Poll for server restart then refresh providers
          let polls = 0;
          const pollId = setInterval(async () => {
            polls++;
            if (polls > 8) { clearInterval(pollId); return; }
            try {
              const sr = await fetch('/api/opencode/status');
              const sd = await sr.json();
              if (sd.running) {
                clearInterval(pollId);
                await refreshOcpProviders();
                document.dispatchEvent(new CustomEvent('ocp-providers-changed'));
              }
            } catch {}
          }, 2000);
        } catch (e) {
          showCCToast(kit.tx('settings.redesign.opencode.error2', { message: e.message }));
        }
        if (btn) { btn.disabled = false; btn.textContent = kit.tx('settings.redesign.opencode.remove'); }
      });
    }

    async function ollamaDetectAndConfigure() {
      try {
        // Fetch status, models, and config state in parallel
        const [statusResp, modelsResp, configResp] = await Promise.all([
          fetch('/api/ollama/status'),
          fetch('/api/ollama/models'),
          fetch('/api/ollama/configured'),
        ]);
        const statusData = await statusResp.json();
        const modelsData = await modelsResp.json();
        const configData = await configResp.json();

        _ollamaRunning = statusData.running;
        _ollamaVersion = statusData.version;
        _ollamaModels = modelsData.models || [];
        _ollamaConfigured = configData.configured;
        _ollamaConfiguredCount = configData.modelCount;
        if (configData.userRemoved) _ollamaUserRemoved = true;

        // Check if model list changed since last poll
        const currentModelNames = _ollamaModels.map(m => m.name).sort().join(',');
        const modelsChanged = _ollamaLastModelNames && _ollamaLastModelNames !== currentModelNames;
        _ollamaLastModelNames = currentModelNames;

        // Auto-configure if: running + has models + not configured + not user-removed
        // Also re-configure if models changed while already configured
        const shouldConfigure = _ollamaRunning && _ollamaModels.length > 0 && !_ollamaUserRemoved
          && (!_ollamaConfigured || modelsChanged);

        if (shouldConfigure && !_ollamaConfiguring) {
          _ollamaConfiguring = true;
          renderOllamaCard();
          try {
            const cfgResp = await fetch('/api/ollama/configure', { method: 'POST' });
            const cfgData = await cfgResp.json();
            if (cfgData.ok) {
              _ollamaConfigured = true;
              _ollamaConfiguredCount = cfgData.modelsConfigured;
              // Wait for OpenCode server restart then refresh providers
              setTimeout(async () => {
                let polls = 0;
                const pollId = setInterval(async () => {
                  polls++;
                  if (polls > 8) { clearInterval(pollId); _ollamaConfiguring = false; renderOllamaCard(); return; }
                  try {
                    const sr = await fetch('/api/opencode/status');
                    const sd = await sr.json();
                    if (sd.running) {
                      clearInterval(pollId);
                      _ollamaConfiguring = false;
                      await refreshOcpProviders();
                      renderOllamaCard();
                      document.dispatchEvent(new CustomEvent('ocp-providers-changed'));
                    }
                  } catch {}
                }, 2000);
              }, 1000);
            } else {
              _ollamaConfiguring = false;
            }
          } catch {
            _ollamaConfiguring = false;
          }
        }

        renderOllamaCard();
      } catch {
        renderOllamaCard();
      }
    }

    function startOllamaPoll() {
      stopOllamaPoll();
      ollamaDetectAndConfigure();
      _ollamaPollTimer = setInterval(ollamaDetectAndConfigure, 10000);
    }

    function stopOllamaPoll() {
      if (_ollamaPollTimer) { clearInterval(_ollamaPollTimer); _ollamaPollTimer = null; }
    }

    function modelDisplayName(fullId) {
      if (!fullId) return '';
      return fullId.includes('/') ? fullId.split('/').slice(1).join('/') : fullId;
    }

    function extractModels(p) {
      const modelObj = p.models || {};
      const arr = Array.isArray(modelObj) ? modelObj : Object.values(modelObj);
      return arr.map(m => typeof m === 'string' ? m : (m.id || m.name || '')).filter(Boolean);
    }

    function extractModelObjects(p) {
      const modelObj = p.models || {};
      const arr = Array.isArray(modelObj) ? modelObj : Object.values(modelObj);
      return arr.filter(m => m && typeof m === 'object' && (m.id || m.name));
    }

    // ── Hidden models (per-provider model visibility) ──
    // Saved on the server (the Assistant routes by it) and mirrored into
    // localStorage 'ocp-hidden-models' — see ocp-hidden-models.js.
    const getHiddenModels = getOcpHiddenModels;
    const saveHiddenModels = saveOcpHiddenModels;

    const STG_CAP_BADGES = [
      { test: c => c?.reasoning,     label: kit.tx('settings.redesign.opencode.reason'), abbr: 'R',  color: '#c084fc', bg: 'rgba(192,132,252,0.10)' },
      { test: c => c?.toolcall,      label: kit.tx('settings.redesign.opencode.tools'),  abbr: 'T',  color: '#60a5fa', bg: 'rgba(96,165,250,0.10)' },
      { test: c => c?.input?.image,  label: kit.tx('settings.redesign.opencode.vision'), abbr: 'V',  color: '#4ade80', bg: 'rgba(74,222,128,0.10)' },
      { test: c => c?.input?.audio,  label: kit.tx('settings.redesign.opencode.audio'),  abbr: 'A',  color: '#fb923c', bg: 'rgba(251,146,60,0.10)' },
      { test: c => c?.input?.video,  label: kit.tx('settings.redesign.opencode.video'),  abbr: 'Vi', color: '#f87171', bg: 'rgba(248,113,113,0.10)' },
      { test: c => c?.input?.pdf,    label: 'PDF',    abbr: 'P',  color: '#fbbf24', bg: 'rgba(251,191,36,0.10)' },
      { test: c => c?.output?.image, label: kit.tx('settings.redesign.opencode.imggen'), abbr: 'I',  color: '#f472b6', bg: 'rgba(244,114,182,0.10)' },
      { test: c => c?.output?.audio, label: 'TTS',    abbr: 'S',  color: '#2dd4bf', bg: 'rgba(45,212,191,0.10)' },
      { test: c => c?.attachment,    label: kit.tx('settings.redesign.opencode.files'),  abbr: 'F',  color: '#94a3b8', bg: 'rgba(148,163,184,0.10)' },
    ];

    /** "3 of 7 models shown": how many of a provider's models SynaBun offers. */
    function modelsShownLabel(enabled, count) {
      return kit.tx(count === 1 ? 'settings.redesign.opencode.modelsShown.one' : 'settings.redesign.opencode.modelsShown.other', { enabled, count });
    }

    function stgCapBadgesHtml(modelObj) {
      const caps = modelObj?.capabilities;
      if (!caps) return '';
      return STG_CAP_BADGES
        .filter(b => b.test(caps))
        .map(b => `<span class="stg-cap">${esc(b.label)}</span>`)
        .join('');
    }

    function stgCapBadgesText(modelObj) {
      const caps = modelObj?.capabilities;
      if (!caps) return '';
      const labels = STG_CAP_BADGES.filter(b => b.test(caps)).map(b => b.label);
      return labels.length ? '  ' + labels.join(' ') : '';
    }

    const OCP_PROVIDER_NAME_OVERRIDES = {
      anthropic: 'Anthropic',
      copilot: 'GitHub Copilot',
      'github-copilot': 'GitHub Copilot',
      gitlab: 'GitLab',
      google: 'Google',
      openai: 'OpenAI',
      openrouter: 'OpenRouter',
      poe: 'Poe',
      xai: 'xAI',
      zai: 'Z.ai',
      deepseek: 'DeepSeek',
      'cloudflare-ai-gateway': 'Cloudflare AI Gateway',
      'cloudflare-workers': 'Cloudflare Workers',
      'cloudflare-workers-ai': 'Cloudflare Workers AI',
    };

    function authMethodsForProvider(id) {
      const methods = _ocpAuthMethods[id];
      return Array.isArray(methods) ? methods : [];
    }

    function hasOauthAuth(id) {
      return authMethodsForProvider(id).some(m => m.type === 'oauth');
    }

    function hasApiAuth(id) {
      return authMethodsForProvider(id).some(m => m.type === 'api' || m.type === 'key');
    }

    function humanizeProviderId(id) {
      if (!id) return kit.tx('settings.redesign.opencode.unknown');
      if (OCP_PROVIDER_NAME_OVERRIDES[id]) return OCP_PROVIDER_NAME_OVERRIDES[id];
      return String(id)
        .split(/[-_/]+/)
        .filter(Boolean)
        .map(part => {
          const lower = part.toLowerCase();
          if (lower === 'ai') return 'AI';
          if (lower === 'api') return 'API';
          if (lower === 'sdk') return 'SDK';
          return part.charAt(0).toUpperCase() + part.slice(1);
        })
        .join(' ');
    }

    function buildProviderCardsCatalog() {
      const catalog = new Map();
      for (const provider of _ocpProviders) {
        if (!provider?.id) continue;
        catalog.set(provider.id, { ...provider });
      }
      for (const [id] of Object.entries(_ocpAuthMethods)) {
        const existing = catalog.get(id);
        if (existing) {
          if (!existing.name) existing.name = humanizeProviderId(id);
          continue;
        }
        catalog.set(id, {
          id,
          name: humanizeProviderId(id),
          env: [],
          models: [],
        });
      }
      return Array.from(catalog.values());
    }

    function shouldShowProviderByDefault(id) {
      return _ocpConnected.has(id) || _ocpStoredKeys.has(id) || hasOauthAuth(id);
    }

    // ── Provider card rendering ──
    function renderProviderCards() {
      if (!ocpProvidersEl) return;
      const providerCatalog = buildProviderCardsCatalog();
      if (!providerCatalog.length) {
        ocpProvidersEl.innerHTML = '<div class="settings-hint" style="opacity:0.4">' + kit.te('settings.redesign.opencode.noProvidersFound') + '</div>';
        return;
      }

      // Exclude Ollama — it has its own dedicated card via renderOllamaCard()
      const filtered = providerCatalog.filter(p => p.id !== 'ollama');

      // Sort: connected first, then stored-key, then alphabetical
      const sorted = [...filtered].sort((a, b) => {
        const ac = _ocpConnected.has(a.id) ? 0 : _ocpStoredKeys.has(a.id) ? 1 : 2;
        const bc = _ocpConnected.has(b.id) ? 0 : _ocpStoredKeys.has(b.id) ? 1 : 2;
        if (ac !== bc) return ac - bc;
        return (a.name || a.id || '').localeCompare(b.name || b.id || '');
      });

      // Filter: only show connected, stored, or OAuth-ready providers unless "show all" is toggled
      const configured = sorted.filter(p => shouldShowProviderByDefault(p.id));
      const unconfigured = sorted.filter(p => !shouldShowProviderByDefault(p.id));
      const baseVisible = _ocpShowAll ? sorted : configured;
      const providerTerm = _ocpProviderFilter.trim().toLowerCase();
      const hasCapFilter = _ocpProviderCapFilters.size > 0;
      // When searching or filtering by caps, search ALL providers (not just configured)
      const searchPool = (providerTerm || hasCapFilter) ? sorted : baseVisible;
      const visible = (!providerTerm && !hasCapFilter) ? baseVisible : searchPool.filter(p => {
        // Text filter
        if (providerTerm) {
          const id = p.id || 'unknown';
          const name = p.name || id;
          const envVars = Array.isArray(p.env) ? p.env : [];
          const models = extractModels(p);
          const authMethods = authMethodsForProvider(id);
          const authLabels = authMethods.map(m => [m.type, m.label, m.name].filter(Boolean).join(' '));
          const haystack = [id, name, ...envVars, ...models, ...authLabels].join(' ').toLowerCase();
          if (!haystack.includes(providerTerm)) return false;
        }
        // Capability filter (AND logic — provider must have at least one model with ALL selected caps)
        if (hasCapFilter) {
          const modelObjs = extractModelObjects(p);
          const match = modelObjs.some(mo => {
            const caps = mo.capabilities;
            if (!caps) return false;
            for (const key of _ocpProviderCapFilters) {
              const badge = STG_CAP_BADGES.find(b => b.label === key);
              if (badge && !badge.test(caps)) return false;
            }
            return true;
          });
          if (!match) return false;
        }
        return true;
      });

      const cardsHtml = visible.map(p => {
        const id = p.id || 'unknown';
        const name = p.name || id;
        const connected = _ocpConnected.has(id);
        const hasStoredKey = _ocpStoredKeys.has(id);
        const allModels = extractModels(p);
        const modelObjs = extractModelObjects(p);
        const modelObjMap = {};
        for (const mo of modelObjs) modelObjMap[mo.id || mo.name] = mo;
        // When cap filter active, only show models matching ALL selected caps
        const models = hasCapFilter ? allModels.filter(mId => {
          const mo = modelObjMap[mId];
          const caps = mo?.capabilities;
          if (!caps) return false;
          for (const key of _ocpProviderCapFilters) {
            const badge = STG_CAP_BADGES.find(b => b.label === key);
            if (badge && !badge.test(caps)) return false;
          }
          return true;
        }) : allModels;
        const authMethods = authMethodsForProvider(id);
        const supportsApiAuth = hasApiAuth(id);
        // Track original index so OAuth authorize gets the correct method number
        const oauthMethods = authMethods.map((m, i) => ({ ...m, _idx: i })).filter(m => m.type === 'oauth');
        const storedStatusText = oauthMethods.length && !supportsApiAuth ? kit.tx('settings.redesign.opencode.authSaved') : kit.tx('settings.redesign.opencode.keySaved');

        const dotColor = connected ? '#4ade80' : hasStoredKey ? '#facc15' : 'rgba(255,255,255,0.18)';
        const statusCls = connected ? 'stg-provider-status-connected' : hasStoredKey ? 'stg-provider-status-key' : 'stg-provider-status-disconnected';
        const statusText = connected ? kit.tx('settings.redesign.opencode.connected2') : hasStoredKey ? storedStatusText : kit.tx('settings.redesign.opencode.notConnected');
        const nameCls = connected ? '' : hasStoredKey ? '' : 'style="opacity:0.55"';

        // Auth actions
        const envVars = p.env || [];
        const primaryEnv = envVars.length ? envVars[0] : '';
        let authHtml = '';
        let removeHtml = '';
        if (connected || hasStoredKey) {
          // Connected/stored — show the actions that match the available auth methods
          const btns = [];
          if (supportsApiAuth) {
            btns.push(`<button type="button" class="stg-action-btn compact stg-text-btn stg-ocp-apikey-btn" data-provider="${esc(id)}">${kit.te('settings.redesign.opencode.changeKey')}</button>`);
          }
          for (const om of oauthMethods) {
            const label = om.label || om.name || kit.tx('settings.redesign.opencode.reconnectProvider', { name });
            btns.push(`<button type="button" class="stg-action-btn compact stg-text-btn stg-ocp-oauth-btn" data-provider="${esc(id)}" data-method="${om._idx}">${esc(label)}</button>`);
          }
          authHtml = btns.join('');
          removeHtml = `<button type="button" class="stg-action-btn compact stg-text-btn stg-text-btn-danger stg-ocp-remove-btn" data-provider="${esc(id)}" data-env="${esc(primaryEnv)}">${kit.te('settings.redesign.opencode.removeConfirm')}</button>`;
        } else {
          // Not configured — show only the auth methods this provider actually supports
          const btns = [];
          // the variable OpenCode reads the key from goes in the tooltip, not on the button
          const envTitle = envVars.length ? ` title="${kit.te('settings.redesign.opencode.envVarTitle', { env: envVars[0] })}"` : '';
          if (supportsApiAuth || !authMethods.length) {
            btns.push(`<button type="button" class="stg-action-btn compact stg-ocp-apikey-btn" data-provider="${esc(id)}"${envTitle}>${kit.te('settings.redesign.opencode.enterApiKey')}</button>`);
          }
          for (const om of oauthMethods) {
            const label = om.label || om.name || kit.tx('settings.redesign.opencode.loginWith', { name: name });
            btns.push(`<button type="button" class="stg-action-btn compact stg-ocp-oauth-btn" data-provider="${esc(id)}" data-method="${om._idx}">${esc(label)}</button>`);
          }
          authHtml = btns.join('');
        }

        // API key inline form (hidden via inline style — JS removes it to show)
        const keyFormHtml = `<div class="stg-ocp-key-form" data-provider="${esc(id)}" data-env="${esc(primaryEnv)}" style="display:none">
          <div class="stg-ocp-key-row">
            <input type="password" class="stg-input stg-input-sm stg-ocp-key-input" placeholder="${kit.te('settings.redesign.opencode.pasteApiKey')}" aria-label="${kit.te('settings.redesign.opencode.apiKeyFor', { name: id })}" autocomplete="off" style="flex:1">
            <button class="stg-action-btn compact stg-ocp-key-save">${kit.te('settings.redesign.opencode.save')}</button>
            <button type="button" class="stg-action-btn compact stg-ocp-key-cancel" aria-label="${kit.te('settings.redesign.opencode.cancel')}" title="${kit.te('settings.redesign.opencode.cancel')}">✕</button>
          </div>
          <div class="stg-ocp-key-error"></div>
        </div>`;

        // OAuth wait indicator (hidden via inline style — JS removes it to show)
        const oauthWaitHtml = `<div class="stg-ocp-oauth-wait" data-provider="${esc(id)}" style="display:none">
          ${kit.te('settings.redesign.opencode.waitingForAuthorization')}
          <span class="stg-ocp-oauth-code" style="display:none"></span>
        </div>`;

        const hiddenSet = getHiddenModels();
        const enabledCount = models.filter(mId => !hiddenSet.has(`${id}/${mId}`)).length;
        const modelCountLabel = models.length ? modelsShownLabel(enabledCount, models.length) : '';

        // Build expandable model list with toggles
        const modelListHtml = models.length ? models.map(mId => {
          const fullId = `${id}/${mId}`;
          const isHidden = hiddenSet.has(fullId);
          const badges = stgCapBadgesHtml(modelObjMap[mId]);
          return `<label class="stg-model-toggle${isHidden ? ' disabled' : ''}" data-full-id="${esc(fullId)}">
            <input type="checkbox" ${isHidden ? '' : 'checked'} data-model-full-id="${esc(fullId)}">
            <span class="stg-model-toggle-name">${esc(mId)}</span>
            ${badges ? `<span class="stg-model-toggle-caps">${badges}</span>` : ''}
          </label>`;
        }).join('') : '';

        const accentColor = connected ? '#4ade80' : hasStoredKey ? '#facc15' : 'rgba(255,255,255,0.06)';
        const modelCountText = kit.tx(models.length === 1 ? 'settings.redesign.opencode.modelCount.one' : 'settings.redesign.opencode.modelCount.other', { count: models.length });

        return `<div class="stg-provider-card${connected || hasStoredKey ? '' : ' stg-provider-card-off'}" style="--prov-accent:${accentColor}">
          <div class="stg-provider-head">
            <div class="stg-provider-ident">
              <span class="stg-provider-name" ${nameCls}>${esc(name)}</span>
              ${models.length ? `<button type="button" class="stg-model-expand-btn" data-provider="${esc(id)}" aria-expanded="false">
                <svg class="stg-model-expand-icon" viewBox="0 0 24 24" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
                <span class="stg-model-count-badge">${esc(modelCountLabel)}</span>
              </button>` : ''}
            </div>
            <div class="stg-provider-side">
              <span class="stg-provider-status ${statusCls}">${statusText}</span>
              ${removeHtml}
            </div>
          </div>
          ${authHtml ? `<div class="stg-provider-toolbar">${authHtml}</div>` : ''}
          ${models.length ? `<div class="stg-model-list" data-provider="${esc(id)}" style="display:none">
            <div class="stg-model-list-actions">
              <span class="stg-model-list-count">${esc(modelCountText)}</span>
              <button type="button" class="stg-action-btn compact stg-text-btn stg-model-all-btn" data-provider="${esc(id)}">${kit.te('settings.redesign.opencode.enableAll')}</button>
              <button type="button" class="stg-action-btn compact stg-text-btn stg-model-none-btn" data-provider="${esc(id)}">${kit.te('settings.redesign.opencode.disableAll')}</button>
            </div>
            ${modelListHtml}
          </div>` : ''}
          ${keyFormHtml}${oauthWaitHtml}
        </div>`;
      }).join('');

      const emptyHtml = (providerTerm || hasCapFilter)
        ? '<div class="settings-hint" style="opacity:0.4">' + kit.te('settings.redesign.opencode.noProvidersMatchThisFilter') + '</div>'
        : '<div class="settings-hint" style="opacity:0.4">' + kit.te('settings.redesign.opencode.noProvidersFound') + '</div>';

      // "Show all / Show configured" toggle
      if (unconfigured.length) {
        const toggleLabel = _ocpShowAll
          ? kit.tx('settings.redesign.opencode.showConfiguredOnly', { count: configured.length })
          : kit.tx('settings.redesign.opencode.showAllProvidersMore', { count: unconfigured.length });
        ocpProvidersEl.innerHTML = (cardsHtml || emptyHtml) + `<button class="stg-ocp-toggle-all">${toggleLabel}</button>`;
      } else {
        ocpProvidersEl.innerHTML = cardsHtml || emptyHtml;
      }

      // Wire model capability tooltips
      ocpProvidersEl.querySelectorAll('.stg-model-hover[data-model-id]').forEach(span => {
        span.addEventListener('mouseenter', (e) => {
          const mId = span.dataset.modelId;
          // Find the model object across all visible providers
          let mo = null;
          for (const p of visible) {
            const objs = extractModelObjects(p);
            mo = objs.find(o => (o.id || o.name) === mId);
            if (mo) break;
          }
          if (!mo) return;
          const html = stgCapBadgesHtml(mo);
          if (!html) return;
          let tip = document.getElementById('stg-cap-tooltip');
          if (!tip) {
            tip = document.createElement('div');
            tip.id = 'stg-cap-tooltip';
            tip.style.cssText = 'position:fixed;z-index:999999;background:rgba(20,20,28,0.95);border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:4px 6px;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,0.4);pointer-events:none;display:flex;gap:3px;';
            document.body.appendChild(tip);
          }
          tip.innerHTML = html;
          tip.style.display = 'flex';
          const rect = span.getBoundingClientRect();
          tip.style.left = rect.left + 'px';
          tip.style.top = (rect.top - tip.offsetHeight - 6) + 'px';
        });
        span.addEventListener('mouseleave', () => {
          const tip = document.getElementById('stg-cap-tooltip');
          if (tip) tip.style.display = 'none';
        });
      });

      // Wire toggle
      ocpProvidersEl.querySelector('.stg-ocp-toggle-all')?.addEventListener('click', () => {
        _ocpShowAll = !_ocpShowAll;
        renderProviderCards();
      });

      // Card click-to-expand — set cursor on cards that have models
      ocpProvidersEl.querySelectorAll('.stg-provider-card').forEach(card => {
        if (card.querySelector('.stg-model-list')) card.style.cursor = 'pointer';
      });

      // Wire individual model toggles
      ocpProvidersEl.querySelectorAll('.stg-model-toggle input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => {
          const fullId = cb.dataset.modelFullId;
          if (!fullId) return;
          const hidden = getHiddenModels();
          if (cb.checked) hidden.delete(fullId); else hidden.add(fullId);
          saveHiddenModels(hidden);
          cb.closest('.stg-model-toggle')?.classList.toggle('disabled', !cb.checked);
          // Update the enabled count in the header
          const card = cb.closest('.stg-provider-card') || cb.closest('.stg-provider-row');
          if (card) {
            const allCbs = card.querySelectorAll('.stg-model-toggle input[type="checkbox"]');
            const total = allCbs.length;
            const enabled = [...allCbs].filter(c => c.checked).length;
            const badge = card.querySelector('.stg-model-count-badge');
            if (badge) badge.textContent = modelsShownLabel(enabled, total);
          }
          document.dispatchEvent(new CustomEvent('ocp-hidden-models-changed'));
        });
      });

      // Wire enable all / disable all buttons
      ocpProvidersEl.querySelectorAll('.stg-model-all-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const provId = btn.dataset.provider;
          const list = btn.closest('.stg-model-list');
          if (!list) return;
          const hidden = getHiddenModels();
          list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            const fullId = cb.dataset.modelFullId;
            if (fullId) hidden.delete(fullId);
            cb.checked = true;
            cb.closest('.stg-model-toggle')?.classList.remove('disabled');
          });
          saveHiddenModels(hidden);
          renderProviderCards();
          // Re-open this provider's list after re-render
          const newList = ocpProvidersEl.querySelector(`.stg-model-list[data-provider="${provId}"]`);
          const newExpandBtn = ocpProvidersEl.querySelector(`.stg-model-expand-btn[data-provider="${provId}"]`);
          if (newList) newList.style.display = '';
          if (newExpandBtn) newExpandBtn.setAttribute('aria-expanded', 'true');
          document.dispatchEvent(new CustomEvent('ocp-hidden-models-changed'));
        });
      });
      ocpProvidersEl.querySelectorAll('.stg-model-none-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const provId = btn.dataset.provider;
          const list = btn.closest('.stg-model-list');
          if (!list) return;
          const hidden = getHiddenModels();
          list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            const fullId = cb.dataset.modelFullId;
            if (fullId) hidden.add(fullId);
            cb.checked = false;
            cb.closest('.stg-model-toggle')?.classList.add('disabled');
          });
          saveHiddenModels(hidden);
          renderProviderCards();
          const newList = ocpProvidersEl.querySelector(`.stg-model-list[data-provider="${provId}"]`);
          const newExpandBtn = ocpProvidersEl.querySelector(`.stg-model-expand-btn[data-provider="${provId}"]`);
          if (newList) newList.style.display = '';
          if (newExpandBtn) newExpandBtn.setAttribute('aria-expanded', 'true');
          document.dispatchEvent(new CustomEvent('ocp-hidden-models-changed'));
        });
      });

      // Wire API key buttons
      ocpProvidersEl.querySelectorAll('.stg-ocp-apikey-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const provId = btn.dataset.provider;
          const form = ocpProvidersEl.querySelector(`.stg-ocp-key-form[data-provider="${provId}"]`);
          if (form) { form.style.display = ''; form.querySelector('input')?.focus(); }
        });
      });

      // Wire API key save
      ocpProvidersEl.querySelectorAll('.stg-ocp-key-save').forEach(btn => {
        btn.addEventListener('click', async () => {
          const form = btn.closest('.stg-ocp-key-form');
          const provId = form?.dataset.provider;
          const input = form?.querySelector('.stg-ocp-key-input');
          const errEl = form?.querySelector('.stg-ocp-key-error');
          const key = input?.value?.trim();
          if (!key || !provId) return;
          btn.disabled = true; btn.textContent = kit.tx('settings.redesign.opencode.saving');
          try {
            const resp = await fetch(`/api/opencode/auth/${encodeURIComponent(provId)}`, {
              method: 'PUT', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ type: 'api', key }),
            });
            const data = await resp.json();
            if (resp.ok && data.ok !== false) {
              form.style.display = 'none';
              input.value = '';
              showCCToast(kit.tx('settings.redesign.opencode.apiKeySavedForServerRestarting', { provId: provId }));
              // Poll until server is back (takeover kills + respawns, ~5-6s)
              let polls = 0;
              const pollId = setInterval(async () => {
                polls++;
                if (polls > 8) { clearInterval(pollId); return; }
                try {
                  const sr = await fetch('/api/opencode/status');
                  const sd = await sr.json();
                  if (sd.running) {
                    clearInterval(pollId);
                    await refreshOcpProviders();
                    document.dispatchEvent(new CustomEvent('ocp-providers-changed'));
                  }
                } catch {}
              }, 2000);
            } else {
              const msg = data.error || kit.tx('settings.redesign.opencode.failedToSaveKey');
              if (errEl) { errEl.textContent = msg; errEl.style.display = ''; }
              showCCToast(msg);
            }
          } catch (e) {
            if (errEl) { errEl.textContent = e.message; errEl.style.display = ''; }
            showCCToast(kit.tx('settings.redesign.opencode.error2', { message: e.message }));
          }
          btn.disabled = false; btn.textContent = kit.tx('settings.redesign.opencode.save');
        });
      });

      // Wire API key cancel
      ocpProvidersEl.querySelectorAll('.stg-ocp-key-cancel').forEach(btn => {
        btn.addEventListener('click', () => {
          const form = btn.closest('.stg-ocp-key-form');
          if (form) { form.style.display = 'none'; form.querySelector('input').value = ''; }
        });
      });

      // Wire Remove buttons
      ocpProvidersEl.querySelectorAll('.stg-ocp-remove-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const provId = btn.dataset.provider;
          if (!confirm(kit.tx('settings.redesign.opencode.removeApiKeyFor', { provId: provId }))) return;
          btn.disabled = true; btn.textContent = kit.tx('settings.redesign.opencode.removing');
          try {
            const resp = await fetch(`/api/opencode/auth/${encodeURIComponent(provId)}`, {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
            });
            const data = await resp.json();
            if (resp.ok && data.ok !== false) {
              showCCToast(kit.tx('settings.redesign.opencode.apiKeyRemovedForServerRestarting', { provId: provId }));
              // Poll until server is back (takeover kills + respawns, ~5-6s)
              let polls = 0;
              const pollId = setInterval(async () => {
                polls++;
                if (polls > 8) { clearInterval(pollId); return; }
                try {
                  const sr = await fetch('/api/opencode/status');
                  const sd = await sr.json();
                  if (sd.running) {
                    clearInterval(pollId);
                    await refreshOcpProviders();
                    document.dispatchEvent(new CustomEvent('ocp-providers-changed'));
                  }
                } catch {}
              }, 2000);
            } else {
              showCCToast(data.error || kit.tx('settings.redesign.opencode.failedToRemoveKey'));
            }
          } catch (e) {
            showCCToast(kit.tx('settings.redesign.opencode.error2', { message: e.message }));
          }
          btn.disabled = false; btn.textContent = kit.tx('settings.redesign.opencode.removeConfirm');
        });
      });

      // Wire OAuth buttons
      ocpProvidersEl.querySelectorAll('.stg-ocp-oauth-btn').forEach(btn => {
        const origLabel = btn.textContent;
        btn.addEventListener('click', async () => {
          const provId = btn.dataset.provider;
          const methodIdx = parseInt(btn.dataset.method, 10);
          btn.disabled = true; btn.textContent = kit.tx('settings.redesign.opencode.connecting');
          const waitEl = ocpProvidersEl.querySelector(`.stg-ocp-oauth-wait[data-provider="${provId}"]`);
          const codeEl = waitEl?.querySelector('.stg-ocp-oauth-code');
          try {
            const resp = await fetch(`/api/opencode/oauth/${encodeURIComponent(provId)}/authorize`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ method: isNaN(methodIdx) ? 0 : methodIdx }),
            });
            const data = await resp.json();
            const authData = data.data || data;
            if (authData.url) {
              window.open(authData.url, '_blank');
              if (waitEl) waitEl.style.display = '';
              if (authData.code && codeEl) { codeEl.textContent = authData.code; codeEl.style.display = ''; }
              if (authData.instructions) showCCToast(authData.instructions);
              // Poll for completion
              let attempts = 0;
              const poll = setInterval(async () => {
                attempts++;
                if (attempts > 60) { clearInterval(poll); if (waitEl) waitEl.style.display = 'none'; return; }
                try {
                  const pr = await fetch('/api/opencode/providers/full');
                  const pd = await pr.json();
                  const connected = pd.data?.connected || [];
                  if (connected.includes(provId)) {
                    clearInterval(poll);
                    if (waitEl) waitEl.style.display = 'none';
                    showCCToast(kit.tx('settings.redesign.opencode.connected', { provId: provId }));
                    await refreshOcpProviders();
                    document.dispatchEvent(new CustomEvent('ocp-providers-changed'));
                  }
                } catch {}
              }, 2000);
            } else {
              showCCToast(authData.error || data.error || kit.tx('settings.redesign.opencode.oauthFailedNoAuthorizationUrlReturned'));
            }
          } catch (e) {
            showCCToast(kit.tx('settings.redesign.opencode.oauthError', { message: e.message }));
          }
          btn.disabled = false; btn.textContent = origLabel;
        });
      });
    }

    // ── Delegated card click-to-expand (survives re-renders) ──
    if (ocpProvidersEl) {
      ocpProvidersEl.addEventListener('click', (e) => {
        // Skip clicks on action buttons, inputs, expanded content
        if (e.target.closest('.stg-ocp-remove-btn, .stg-ocp-apikey-btn, .stg-ocp-oauth-btn, .stg-model-all-btn, .stg-model-none-btn, input, label, .stg-model-list, .stg-ocp-key-form, .stg-ocp-oauth-wait, .stg-ocp-toggle-all')) return;
        const card = e.target.closest('.stg-provider-card');
        if (!card) return;
        const list = card.querySelector('.stg-model-list');
        if (!list) return;
        const isOpen = list.style.display !== 'none';
        list.style.display = isOpen ? 'none' : '';
        const expandBtn = card.querySelector('.stg-model-expand-btn');
        if (expandBtn) expandBtn.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
      });
    }

    // ── Tools/Permissions rendering ──
    async function renderToolPermissions() {
      if (!ocpToolsEl) return;
      try {
        const [toolsResp, configResp] = await Promise.all([
          fetch('/api/opencode/tools'),
          fetch('/api/opencode/config'),
        ]);
        const toolsData = await toolsResp.json();
        const configData = await configResp.json();
        _ocpConfig = configData.data || {};
        const toolIds = Array.isArray(toolsData.data) ? toolsData.data : (toolsData.data?.ids || []);
        const permissions = _ocpConfig.permission || {};
        const tools = _ocpConfig.tools || {};

        if (!toolIds.length) {
          ocpToolsEl.innerHTML = '<div class="settings-hint" style="opacity:0.4">' + kit.te('settings.redesign.opencode.noToolsAvailable') + '</div>';
          return;
        }

        ocpToolsEl.innerHTML = `<div class="stg-tool-grid">${toolIds.map(t => {
          const tid = typeof t === 'string' ? t : (t.id || t.name || '');
          if (!tid) return '';
          let currentVal = 'allow';
          if (tools[tid] === false) currentVal = 'deny';
          else if (permissions[tid] === 'ask') currentVal = 'ask';
          return `<div class="stg-tool-row">
            <span class="stg-tool-name">${esc(tid)}</span>
            <select class="stg-tool-select stg-ocp-tool-perm" data-tool="${esc(tid)}" aria-label="${kit.te('settings.redesign.opencode.permissionFor', { tool: tid })}">
              <option value="allow"${currentVal === 'allow' ? ' selected' : ''}>${kit.te('settings.redesign.opencode.allow')}</option>
              <option value="ask"${currentVal === 'ask' ? ' selected' : ''}>${kit.te('settings.redesign.opencode.ask')}</option>
              <option value="deny"${currentVal === 'deny' ? ' selected' : ''}>${kit.te('settings.redesign.opencode.deny')}</option>
            </select>
          </div>`;
        }).join('')}</div>`;

        // Wire change events
        ocpToolsEl.querySelectorAll('.stg-ocp-tool-perm').forEach(sel => {
          sel.addEventListener('change', async () => {
            const tid = sel.dataset.tool;
            const val = sel.value;
            const patchBody = {};
            const newPerms = { ...(_ocpConfig.permission || {}) };
            const newTools = { ...(_ocpConfig.tools || {}) };
            if (val === 'deny') { newTools[tid] = false; delete newPerms[tid]; }
            else if (val === 'ask') { delete newTools[tid]; newPerms[tid] = 'ask'; }
            else { delete newTools[tid]; delete newPerms[tid]; }
            patchBody.permission = newPerms;
            patchBody.tools = newTools;
            try {
              await fetch('/api/opencode/config', {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(patchBody),
              });
              _ocpConfig.permission = newPerms;
              _ocpConfig.tools = newTools;
            } catch {}
          });
        });
      } catch {
        ocpToolsEl.innerHTML = '<div class="settings-hint" style="opacity:0.4">' + kit.te('settings.redesign.opencode.failedToLoadTools') + '</div>';
      }
    }

    // ── MCP Tab: Registry rendering & drag-and-drop ──
    let _mcpRegistry = null;

    async function fetchMcpRegistry() {
      try {
        const resp = await fetch('/api/mcp/registry');
        const data = await resp.json();
        if (data.ok) { _mcpRegistry = data; return data; }
      } catch {}
      return null;
    }

    function renderMcpMatrix() {
      const wrap = overlay.querySelector('#stg-mcp-matrix-wrap');
      if (!wrap || !_mcpRegistry) return;
      const tg = _mcpRegistry.toolGroups || {};
      const profiles = _mcpRegistry.profiles || {};
      const active = _mcpRegistry.activeProfile || '';
      const profEntries = Object.entries(profiles);
      const switchable = Object.entries(tg).filter(([, info]) => !info.alwaysOn);

      if (!profEntries.length) {
        wrap.innerHTML = '<div class="stg-mcp-matrix-empty">' + kit.te('settings.redesign.mcp.noProfiles') + '</div>';
        return;
      }

      // Build table header
      let thead = '<tr><th class="stg-mx-label-th"><div class="stg-mx-corner-head">' + kit.te('settings.redesign.mcp.toolGroups') + '</div></th>';
      for (const [name, prof] of profEntries) {
        const isActive = name === active;
        thead += `<th class="stg-mx-profile-th${isActive ? ' active' : ''}" data-profile="${esc(name)}">
          <div class="stg-mx-profile-head" data-profile="${esc(name)}">
            <span class="stg-mx-profile-dot${isActive ? ' on' : ''}"></span>
            <span class="stg-mx-profile-name">${esc(prof.label || name)}</span>
            ${isActive ? '' : `<button class="stg-mx-profile-del" data-profile="${esc(name)}" title="${kit.te('settings.redesign.mcp.deleteProfile')}">\u00d7</button>`}
          </div>
        </th>`;
      }
      thead += '<th class="stg-mx-add-th"><button class="stg-mx-add-btn" title="' + kit.te('settings.redesign.mcp.newProfile') + '">+</button></th></tr>';

      // Build table body — switchable groups
      let tbody = '';
      for (const [key, info] of switchable) {
        tbody += `<tr>`;
        tbody += `<td class="stg-mx-label-td"><div class="stg-mx-label-inner">
          <span class="stg-mx-grp-name">${esc(info.label)}</span>
          <span class="stg-mx-grp-count">${info.tools}</span>
        </div></td>`;
        for (const [profName, prof] of profEntries) {
          const isOn = (prof.groups || []).includes(key);
          tbody += `<td class="stg-mx-cell" data-profile="${esc(profName)}" data-group="${esc(key)}" data-kind="group">
            <span class="stg-mx-toggle${isOn ? ' on' : ''}"></span>
          </td>`;
        }
        tbody += '<td class="stg-mx-add-spacer"></td></tr>';
      }

      wrap.innerHTML = `<div class="stg-mcp-matrix-scroll"><table id="stg-mcp-matrix"><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`;

      // --- Event handlers ---

      // Toggle cells
      wrap.querySelectorAll('.stg-mx-cell').forEach(cell => {
        cell.addEventListener('click', async () => {
          const profName = cell.dataset.profile;
          const prof = _mcpRegistry.profiles[profName];
          if (!prof) return;
          const kind = cell.dataset.kind;
          if (kind === 'group') {
            const g = cell.dataset.group;
            if ((prof.groups || []).includes(g)) {
              prof.groups = prof.groups.filter(x => x !== g);
            } else {
              prof.groups = [...(prof.groups || []), g];
            }
          } else {
            const s = cell.dataset.server;
            if ((prof.servers || []).includes(s)) {
              prof.servers = prof.servers.filter(x => x !== s);
            } else {
              prof.servers = [...(prof.servers || []), s];
            }
          }
          await fetch(`/api/mcp/registry/profiles/${encodeURIComponent(profName)}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(prof),
          });
          await refreshMcpTab();
        });
      });

      // Activate profile on name click
      wrap.querySelectorAll('.stg-mx-profile-head').forEach(head => {
        head.addEventListener('click', async (e) => {
          if (e.target.closest('.stg-mx-profile-del')) return;
          const name = head.dataset.profile;
          if (name === _mcpRegistry.activeProfile) return;
          await fetch('/api/mcp/registry/activate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ profile: name }),
          });
          showCCToast(kit.tx('settings.redesign.mcp.profileSwitchedTo', { name: name }));
          await refreshMcpTab();
        });
      });

      // Delete profile
      wrap.querySelectorAll('.stg-mx-profile-del').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await fetch(`/api/mcp/registry/profiles/${encodeURIComponent(btn.dataset.profile)}`, { method: 'DELETE' });
          await refreshMcpTab();
        });
      });

      // Inline add profile
      const addBtn = wrap.querySelector('.stg-mx-add-btn');
      if (addBtn) {
        addBtn.addEventListener('click', () => {
          const th = addBtn.closest('th');
          th.innerHTML = `<input class="stg-mx-inline-input" type="text" placeholder="${kit.te('settings.redesign.mcp.name')}" autofocus>`;
          const input = th.querySelector('input');
          input.focus();
          const create = async () => {
            const name = input.value.trim();
            if (!name) { await refreshMcpTab(); return; }
            await fetch(`/api/mcp/registry/profiles/${encodeURIComponent(name)}`, {
              method: 'PUT', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ label: name, groups: [], servers: [] }),
            });
            await refreshMcpTab();
          };
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); create(); }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); refreshMcpTab(); }
          });
          input.addEventListener('blur', create);
        });
      }
    }

    function renderAlwaysOn() {
      const el = overlay.querySelector('#stg-mcp-always-on');
      if (!el || !_mcpRegistry) return;
      const tg = _mcpRegistry.toolGroups || {};
      const alwaysOn = Object.entries(tg).filter(([, info]) => info.alwaysOn);
      if (!alwaysOn.length) { el.innerHTML = ''; return; }
      el.innerHTML = `
        <div class="stg-mcp-section-header">${kit.te('settings.redesign.mcp.alwaysOn')}</div>
        <div class="stg-mx-always-on-row">
          ${alwaysOn.map(([, info]) =>
            `<span class="stg-mx-always-chip">${esc(info.label)}<span class="stg-mx-grp-count">${info.tools}</span></span>`
          ).join('')}
        </div>`;
    }

    function renderExtServerList() {
      const el = overlay.querySelector('#stg-mcp-ext-servers');
      if (!el || !_mcpRegistry) return;
      const servers = _mcpRegistry.servers || {};
      const profiles = Object.entries(_mcpRegistry.profiles || {});
      const entries = Object.entries(servers).filter(([, info]) => !info.builtin);
      if (!entries.length) {
        el.innerHTML = '<div class="stg-mcp-empty-note">' + kit.te('settings.redesign.mcp.noExternalServersConfigured') + '</div>';
        return;
      }
      el.innerHTML = entries.map(([name, info]) =>
        `<div class="stg-mx-ext-row">
          <div class="stg-mx-ext-main">
            <span class="stg-mx-ext-dot"></span>
            <div class="stg-mx-ext-copy">
              <div class="stg-mx-ext-head">
                <span class="stg-mx-ext-name">${esc(name)}</span>
                <span class="stg-mx-ext-type">${esc(info.type || '?')}</span>
              </div>
              <div class="stg-mx-ext-sub">${kit.te('settings.redesign.mcp.availableToAnyProfileYouEnable')}</div>
            </div>
            <button class="stg-mx-srv-del stg-mx-ext-remove" data-server="${esc(name)}" title="${kit.te('settings.redesign.mcp.removeServer')}">\u00d7</button>
          </div>
          <div class="stg-mx-ext-profiles">
            ${profiles.map(([profName, prof]) => {
              const isOn = (prof.servers || []).includes(name);
              return `<button class="stg-mx-ext-toggle${isOn ? ' on' : ''}" data-profile="${esc(profName)}" data-server="${esc(name)}" title="${isOn ? kit.te('settings.redesign.mcp.disable') : kit.te('settings.redesign.mcp.enable')} ${esc(name)} ${kit.te('settings.redesign.mcp.for')} ${esc(prof.label || profName)}">
                <span class="stg-mx-ext-toggle-name">${esc(prof.label || profName)}</span>
              </button>`;
            }).join('')}
          </div>
        </div>`
      ).join('');

      el.querySelectorAll('.stg-mx-ext-toggle').forEach(btn => {
        btn.addEventListener('click', async () => {
          const profName = btn.dataset.profile;
          const srvName = btn.dataset.server;
          const prof = _mcpRegistry.profiles[profName];
          if (!prof || !srvName) return;
          if ((prof.servers || []).includes(srvName)) {
            prof.servers = prof.servers.filter(x => x !== srvName);
          } else {
            prof.servers = [...(prof.servers || []), srvName];
          }
          await fetch(`/api/mcp/registry/profiles/${encodeURIComponent(profName)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(prof),
          });
          await refreshMcpTab();
        });
      });

      el.querySelectorAll('.stg-mx-srv-del').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const srvName = btn.dataset.server;
          await fetch(`/api/mcp/registry/servers/${encodeURIComponent(srvName)}`, { method: 'DELETE' });
          // Also remove from all detected platforms
          try {
            const pl = await fetch('/api/mcp/platforms').then(r => r.json());
            const platforms = Object.entries(pl).filter(([k, v]) => k !== 'ok' && v).map(([k]) => k);
            if (platforms.length) {
              await fetch('/api/mcp/sync', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: srvName, platforms }),
              });
            }
          } catch {}
          await refreshMcpTab();
        });
      });
    }

    // ── Top-level page tabs (Profiles / Installed) ──
    const mcpPageTabs = overlay.querySelectorAll('.stg-mcp-page-tab');
    const mcpPanes = overlay.querySelectorAll('.stg-mcp-pane');
    mcpPageTabs.forEach(tabBtn => {
      tabBtn.addEventListener('click', () => {
        const targetPane = tabBtn.dataset.pane;
        mcpPageTabs.forEach(t => t.classList.toggle('active', t === tabBtn));
        mcpPanes.forEach(p => { p.style.display = (p.dataset.pane === targetPane) ? '' : 'none'; });
        if (targetPane === 'installed') renderInstalledAll();
      });
    });

    const CLI_BADGES = {
      synabun:    { label: 'SB', title: kit.tx('settings.redesign.mcp.synabunRegistry') },
      claudeCode: { label: 'CC', title: 'Claude Code (~/.claude.json)' },
      opencode:   { label: 'OC', title: 'OpenCode' },
      codex:      { label: 'CX', title: 'Codex (~/.codex/config.toml)' },
      gemini:     { label: 'GE', title: 'Gemini (~/.gemini/settings.json)' },
    };

    async function renderInstalledAll() {
      const el = overlay.querySelector('#stg-mcp-installed-all');
      if (!el) return;
      el.innerHTML = '<div class="stg-mcp-empty-note">' + kit.te('settings.redesign.mcp.loading') + '</div>';
      let servers = [];
      try {
        const r = await fetch('/api/mcp/installed-all').then(r => r.json());
        if (r?.ok) servers = r.servers || [];
      } catch {}
      if (!servers.length) {
        el.innerHTML = '<div class="stg-mcp-empty-note">' + kit.te('settings.redesign.mcp.noExternalMcpServersInstalled') + '</div>';
        return;
      }
      el.innerHTML = servers.map(s => {
        const badges = (s.registeredWith || []).map(k => {
          const b = CLI_BADGES[k];
          if (!b) return '';
          return `<span class="stg-mx-ext-cli-badge" title="${esc(b.title)}">${esc(b.label)}</span>`;
        }).join('');
        const cmd = s.command ? `${esc(s.command)}${Array.isArray(s.args) && s.args.length ? ' ' + esc(s.args.join(' ')) : ''}` : (s.url ? esc(s.url) : '');
        const regAttr = esc((s.registeredWith || []).join(','));
        return `<div class="stg-mx-ext-row">
          <div class="stg-mx-ext-main">
            <span class="stg-mx-ext-dot"></span>
            <div class="stg-mx-ext-copy">
              <div class="stg-mx-ext-head">
                <span class="stg-mx-ext-name">${esc(s.name)}</span>
                <span class="stg-mx-ext-type">${esc(s.transport || '?')}</span>
                <span class="stg-mx-ext-clis">${badges}</span>
              </div>
              <div class="stg-mx-ext-sub">${cmd || '—'}</div>
            </div>
            <button class="stg-mx-srv-del stg-mx-installed-del" data-server="${esc(s.name)}" data-registered="${regAttr}" title="${kit.te('settings.redesign.mcp.uninstallFromAllClis')}">×</button>
          </div>
        </div>`;
      }).join('');

      el.querySelectorAll('.stg-mx-installed-del').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const name = btn.dataset.server;
          const registered = (btn.dataset.registered || '').split(',').filter(Boolean);
          if (!name) return;
          const cliList = registered.filter(k => k !== 'synabun');
          const summary = registered.map(k => CLI_BADGES[k]?.label || k).join(', ');
          if (!confirm(kit.tx('settings.redesign.mcp.removeFromThisUnregistersItFrom', { name: name, summary: summary }))) return;
          btn.disabled = true;
          try {
            if (registered.includes('synabun')) {
              await fetch(`/api/mcp/registry/servers/${encodeURIComponent(name)}`, { method: 'DELETE' });
            }
            if (cliList.length) {
              await fetch('/api/mcp/sync', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, platforms: cliList }),
              });
            }
          } catch {}
          await refreshMcpTab();
          await renderInstalledAll();
        });
      });
    }

    async function renderPluginsList() {
      const el = overlay.querySelector('#stg-mcp-ext-plugins');
      if (!el) return;
      let plugins = [];
      try {
        const r = await fetch('/api/plugins/list').then(r => r.json());
        if (r?.ok) plugins = r.plugins || [];
      } catch {}
      if (!plugins.length) {
        el.innerHTML = '<div class="stg-mcp-empty-note">' + kit.te('settings.redesign.mcp.noPluginsInstalled') + '</div>';
        return;
      }
      el.innerHTML = plugins.map(p => {
        const brokenBadge = p.broken ? '<span class="stg-mx-ext-type" style="color:var(--t-err,#f55)">' + kit.te('settings.redesign.mcp.broken') + '</span>' : '';
        const sha = p.gitCommitSha && p.gitCommitSha !== 'unknown' ? p.gitCommitSha.slice(0, 7) : '';
        return `<div class="stg-mx-ext-row">
          <div class="stg-mx-ext-main">
            <span class="stg-mx-ext-dot"></span>
            <div class="stg-mx-ext-copy">
              <div class="stg-mx-ext-head">
                <span class="stg-mx-ext-name">${esc(p.pluginName)}</span>
                <span class="stg-mx-ext-type">claude-plugin</span>
                ${brokenBadge}
              </div>
              <div class="stg-mx-ext-sub">${esc(p.marketplaceName)}${sha ? ' · ' + sha : ''} · ${esc(p.repoPath || '')}</div>
            </div>
            <button class="stg-mx-srv-del stg-mx-ext-plugin-del" data-marketplace="${esc(p.marketplaceName)}" data-plugin="${esc(p.pluginName)}" title="${kit.te('settings.redesign.mcp.uninstallPlugin')}">×</button>
          </div>
        </div>`;
      }).join('');
      el.querySelectorAll('.stg-mx-ext-plugin-del').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const mk = btn.dataset.marketplace;
          const pn = btn.dataset.plugin;
          if (!mk) return;
          await fetch(`/api/plugins/${encodeURIComponent(mk)}?pluginName=${encodeURIComponent(pn || '')}&purgeFiles=1`, { method: 'DELETE' });
          await refreshMcpTab();
        });
      });
    }

    async function refreshMcpTab() {
      await fetchMcpRegistry();
      renderMcpMatrix();
      renderAlwaysOn();
      renderExtServerList();
      renderPluginsList();
    }

    // Initial load
    refreshMcpTab();

    // ── Paste parser ──
    function tokenizeShell(text) {
      const out = [];
      const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
      let m;
      while ((m = re.exec(text)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
      return out;
    }

    // Format 6: a documented `claude mcp add …` command, including the remote/OAuth
    // flags (--transport, --client-id, --callback-port, --header) that providers publish.
    function parseClaudeMcpAdd(text) {
      const t = text.replace(/\\\s*\n/g, ' ').trim();
      if (!/^claude\s+mcp\s+add\b/.test(t)) return null;
      const tokens = tokenizeShell(t).slice(3);
      const headers = {};
      const env = {};
      const positional = [];
      let type = null, clientId = null, callbackPort = null, passthrough = false;
      for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        if (passthrough) { positional.push(tok); continue; }
        if (tok === '--') { passthrough = true; continue; }
        if (tok === '-t' || tok === '--transport') { type = tokens[++i]; continue; }
        if (tok === '--client-id') { clientId = tokens[++i]; continue; }
        if (tok === '--callback-port') { callbackPort = tokens[++i]; continue; }
        if (tok === '-s' || tok === '--scope') { i++; continue; }
        if (tok === '-H' || tok === '--header') {
          const raw = tokens[++i] || '';
          const idx = raw.indexOf(':');
          if (idx > 0) headers[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
          continue;
        }
        if (tok === '-e' || tok === '--env') {
          const raw = tokens[++i] || '';
          const idx = raw.indexOf('=');
          if (idx > 0) env[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
          continue;
        }
        if (tok.startsWith('-')) continue;
        positional.push(tok);
      }
      const name = positional.shift() || null;
      const target = positional.shift() || '';
      if (!target) return null;
      const resolvedType = type || (/^https?:\/\//.test(target) ? 'http' : 'stdio');
      const remote = resolvedType === 'http' || resolvedType === 'sse';
      const port = parseInt(callbackPort ?? '', 10);
      const oauth = {};
      if (clientId) oauth.clientId = clientId;
      if (Number.isInteger(port) && port > 0 && port <= 65535) oauth.callbackPort = port;
      return {
        name,
        type: resolvedType,
        command: remote ? undefined : target,
        args: remote || !positional.length ? undefined : positional,
        env: Object.keys(env).length ? env : undefined,
        url: remote ? target : undefined,
        headers: remote && Object.keys(headers).length ? headers : undefined,
        oauth: remote && Object.keys(oauth).length ? oauth : undefined,
      };
    }

    function parseMcpPaste(text) {
      const t = text.trim();
      if (!t) return null;
      const claudeCmd = parseClaudeMcpAdd(t);
      if (claudeCmd) return claudeCmd;
      // Try JSON
      let obj;
      try { obj = JSON.parse(t); } catch {}
      if (obj && typeof obj === 'object') {
        // Format 1: { mcpServers: { name: { command, ... } } }
        if (obj.mcpServers && typeof obj.mcpServers === 'object') {
          const entries = Object.entries(obj.mcpServers);
          if (entries.length) {
            const [name, cfg] = entries[0];
            return normalizeParsed(name, cfg);
          }
        }
        // Format 3: bare { command, args, ... }
        if (obj.command || obj.url) {
          return normalizeParsed(null, obj);
        }
        // Format 4: OpenCode { type: "local", command: [...], environment: {} }
        if (obj.type === 'local' && Array.isArray(obj.command)) {
          const cmd = obj.command[0] || '';
          const args = obj.command.slice(1);
          const env = obj.environment || obj.env || undefined;
          return { name: null, type: 'stdio', command: cmd, args, env, url: undefined };
        }
        // Format 2: { name: { command, ... } }
        const keys = Object.keys(obj);
        if (keys.length === 1 && typeof obj[keys[0]] === 'object' && (obj[keys[0]].command || obj[keys[0]].url)) {
          return normalizeParsed(keys[0], obj[keys[0]]);
        }
      }
      // Format 5: plain command string
      const parts = t.split(/\s+/).filter(Boolean);
      if (parts.length) {
        const cmd = parts[0];
        const args = parts.slice(1);
        let name = null;
        // Derive name from npm scope package
        const pkgMatch = t.match(/@[\w-]+\/([\w-]+)/);
        if (pkgMatch) {
          name = pkgMatch[1].replace(/^server-/, '');
        }
        return { name, type: 'stdio', command: cmd, args, env: undefined, url: undefined };
      }
      return null;
    }
    function normalizeParsed(name, cfg) {
      const type = (cfg.type === 'local' ? 'stdio' : cfg.type) || 'stdio';
      let command = cfg.command, args = cfg.args, env = cfg.env || cfg.environment;
      if (Array.isArray(command)) {
        args = command.slice(1);
        command = command[0] || '';
      }
      return {
        name: name || null,
        type,
        command: command || undefined,
        args: args || undefined,
        env: env || undefined,
        url: cfg.url || undefined,
        headers: cfg.headers || undefined,
        oauth: cfg.oauth || undefined,
      };
    }

    // ── Form helpers ──
    const addForm = overlay.querySelector('#stg-mcp-add-form');
    const pasteZone = overlay.querySelector('#stg-mcp-paste');
    const nameEl = overlay.querySelector('#stg-mcp-srv-name');
    const typeEl = overlay.querySelector('#stg-mcp-srv-type');
    const cmdEl = overlay.querySelector('#stg-mcp-srv-cmd');
    const urlEl = overlay.querySelector('#stg-mcp-srv-url');
    const argChips = overlay.querySelector('#stg-mcp-arg-chips');
    const argInput = overlay.querySelector('#stg-mcp-arg-input');
    const envRows = overlay.querySelector('#stg-mcp-env-rows');
    const envAdd = overlay.querySelector('#stg-mcp-env-add');
    const hdrRows = overlay.querySelector('#stg-mcp-hdr-rows');
    const hdrAdd = overlay.querySelector('#stg-mcp-hdr-add');
    const oauthClientIdEl = overlay.querySelector('#stg-mcp-oauth-client-id');
    const oauthPortEl = overlay.querySelector('#stg-mcp-oauth-port');
    const platformsEl = overlay.querySelector('#stg-mcp-platforms');
    const feedbackEl = overlay.querySelector('#stg-mcp-sync-feedback');

    function resetAddForm() {
      if (pasteZone) pasteZone.value = '';
      if (nameEl) nameEl.value = '';
      if (cmdEl) cmdEl.value = '';
      if (urlEl) urlEl.value = '';
      if (typeEl) typeEl.value = 'stdio';
      if (addForm) addForm.dataset.transport = 'stdio';
      // Clear arg chips
      if (argChips) argChips.querySelectorAll('.stg-mcp-arg-chip').forEach(c => c.remove());
      // Clear env + header rows
      if (envRows) envRows.innerHTML = '';
      if (hdrRows) hdrRows.innerHTML = '';
      if (oauthClientIdEl) oauthClientIdEl.value = '';
      if (oauthPortEl) oauthPortEl.value = '';
      if (feedbackEl) feedbackEl.innerHTML = '';
    }

    function addArgChip(val) {
      if (!argChips || !val) return;
      const chip = document.createElement('span');
      chip.className = 'stg-mcp-arg-chip';
      chip.innerHTML = `<span class="stg-mcp-chip-text">${esc(val)}</span><span class="stg-mcp-chip-x">\u00d7</span>`;
      chip.querySelector('.stg-mcp-chip-x').addEventListener('click', () => chip.remove());
      argChips.insertBefore(chip, argInput);
    }

    const SENSITIVE_KEY_RE = /token|secret|key|password|api_key|authorization|bearer/i;

    function addKvRow(container, key, val, opts = {}) {
      if (!container) return;
      const row = document.createElement('div');
      row.className = 'stg-mcp-env-row';
      const sensitive = !!opts.sensitive || (typeof key === 'string' && SENSITIVE_KEY_RE.test(key));
      const valType = sensitive ? 'password' : 'text';
      const keyPlaceholder = opts.keyPlaceholder || 'KEY';
      row.innerHTML = `<input type="text" class="stg-input stg-input-sm stg-mcp-env-key" placeholder="${esc(keyPlaceholder)}" value="${esc(key || '')}"><input type="${valType}" class="stg-input stg-input-sm stg-mcp-env-val" placeholder="${kit.te('settings.redesign.mcp.value')}" value="${esc(val || '')}"><button type="button" class="stg-mcp-env-eye" title="${kit.te('settings.redesign.mcp.toggleReveal')}">\u{1F441}</button><span class="stg-mcp-env-remove">\u00d7</span>`;
      const valInput = row.querySelector('.stg-mcp-env-val');
      row.querySelector('.stg-mcp-env-eye')?.addEventListener('click', () => {
        valInput.type = valInput.type === 'password' ? 'text' : 'password';
      });
      row.querySelector('.stg-mcp-env-remove').addEventListener('click', () => row.remove());
      container.appendChild(row);
    }

    function addEnvRow(key, val, opts = {}) {
      addKvRow(envRows, key, val, opts);
    }

    function addHeaderRow(key, val, opts = {}) {
      addKvRow(hdrRows, key, val, { keyPlaceholder: 'Authorization', ...opts });
    }

    function collectArgs() {
      if (!argChips) return [];
      return Array.from(argChips.querySelectorAll('.stg-mcp-chip-text')).map(el => el.textContent);
    }

    function collectKv(container) {
      if (!container) return {};
      const out = {};
      container.querySelectorAll('.stg-mcp-env-row').forEach(row => {
        const k = row.querySelector('.stg-mcp-env-key')?.value?.trim();
        const v = row.querySelector('.stg-mcp-env-val')?.value?.trim();
        if (k) out[k] = v || '';
      });
      return out;
    }

    function collectEnv() {
      return collectKv(envRows);
    }

    function collectHeaders() {
      return collectKv(hdrRows);
    }

    // OAuth params only apply to URL-addressed servers; Claude Code stores them
    // as { clientId, callbackPort } and pins the redirect to localhost:<port>/callback.
    function collectOauth() {
      const clientId = oauthClientIdEl?.value?.trim();
      const port = parseInt(oauthPortEl?.value ?? '', 10);
      const oauth = {};
      if (clientId) oauth.clientId = clientId;
      if (Number.isInteger(port) && port > 0 && port <= 65535) oauth.callbackPort = port;
      return Object.keys(oauth).length ? oauth : null;
    }

    function populateAddForm(parsed) {
      if (!parsed) return;
      if (parsed.name && nameEl) nameEl.value = parsed.name;
      if (parsed.type && typeEl) {
        typeEl.value = parsed.type;
        if (addForm) addForm.dataset.transport = parsed.type;
      }
      if (parsed.command && cmdEl) cmdEl.value = parsed.command;
      if (parsed.url && urlEl) urlEl.value = parsed.url;
      if (parsed.args && parsed.args.length) {
        parsed.args.forEach(a => addArgChip(a));
      }
      if (parsed.env && typeof parsed.env === 'object') {
        Object.entries(parsed.env).forEach(([k, v]) => addEnvRow(k, v));
      }
      if (parsed.headers && typeof parsed.headers === 'object') {
        Object.entries(parsed.headers).forEach(([k, v]) => addHeaderRow(k, v));
      }
      if (parsed.oauth && typeof parsed.oauth === 'object') {
        if (parsed.oauth.clientId && oauthClientIdEl) oauthClientIdEl.value = parsed.oauth.clientId;
        if (parsed.oauth.callbackPort && oauthPortEl) oauthPortEl.value = parsed.oauth.callbackPort;
      }
    }

    // ── Paste zone handler ──
    pasteZone?.addEventListener('input', () => {
      const val = pasteZone.value;
      if (!val || val.length < 3) return;
      const parsed = parseMcpPaste(val);
      if (parsed) {
        // Clear existing chips/env/headers before populating
        argChips?.querySelectorAll('.stg-mcp-arg-chip').forEach(c => c.remove());
        envRows && (envRows.innerHTML = '');
        hdrRows && (hdrRows.innerHTML = '');
        if (oauthClientIdEl) oauthClientIdEl.value = '';
        if (oauthPortEl) oauthPortEl.value = '';
        populateAddForm(parsed);
      }
    });

    // ── Type toggle ──
    typeEl?.addEventListener('change', () => {
      if (addForm) addForm.dataset.transport = typeEl.value;
    });

    // ── Arg chip input ──
    argInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const v = argInput.value.trim();
        if (v) { addArgChip(v); argInput.value = ''; }
      }
    });

    // ── Env add button ──
    envAdd?.addEventListener('click', () => addEnvRow('', ''));
    hdrAdd?.addEventListener('click', () => addHeaderRow('', ''));

    // ── Platform detection ──
    (async () => {
      try {
        const pl = await fetch('/api/mcp/platforms').then(r => r.json());
        if (platformsEl) {
          platformsEl.querySelectorAll('.stg-mcp-platform-check').forEach(label => {
            const key = label.dataset.platform;
            const cb = label.querySelector('input[type="checkbox"]');
            if (!cb) return;
            if (pl[key]) {
              cb.checked = true;
              label.classList.remove('stg-mcp-platform-dim');
            } else {
              cb.checked = false;
              label.classList.add('stg-mcp-platform-dim');
            }
          });
        }
      } catch {}
    })();

    // ── Show/hide form ──
    overlay.querySelector('#stg-mcp-add-server')?.addEventListener('click', () => {
      if (addForm) addForm.style.display = addForm.style.display === 'none' ? '' : 'none';
    });
    overlay.querySelector('#stg-mcp-srv-cancel')?.addEventListener('click', () => {
      if (addForm) { addForm.style.display = 'none'; resetAddForm(); }
      setFormMode('mcp');
      if (ghProgress) ghProgress.style.display = 'none';
      if (ghStatus) ghStatus.textContent = '';
    });

    // ── Source-tab switcher (GitHub / JSON) ──
    const sourceTabs = overlay.querySelectorAll('.stg-mcp-source-tab');
    const sourcePanels = overlay.querySelectorAll('.stg-mcp-source-panel');
    sourceTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const src = tab.dataset.source;
        sourceTabs.forEach(t => t.classList.toggle('active', t === tab));
        sourcePanels.forEach(p => { p.style.display = (p.dataset.panel === src) ? '' : 'none'; });
        if (addForm) addForm.dataset.source = src;
      });
    });

    // ── GitHub Install handler ──
    const ghUrlEl = overlay.querySelector('#stg-mcp-gh-url');
    const ghInstallBtn = overlay.querySelector('#stg-mcp-gh-install');
    const ghRunInstallEl = overlay.querySelector('#stg-mcp-gh-runinstall');
    const ghProgress = overlay.querySelector('#stg-mcp-gh-progress');
    const ghStatus = overlay.querySelector('#stg-mcp-gh-status');
    const ghLog = overlay.querySelector('#stg-mcp-gh-log');

    function applyDetected(name, detected) {
      if (!detected) return;
      if (nameEl && name) nameEl.value = name;
      if (typeEl) typeEl.value = detected.type || 'stdio';
      if (cmdEl) cmdEl.value = detected.command || '';
      // Rebuild arg chips
      if (argChips && argInput) {
        argChips.querySelectorAll('.stg-mcp-arg-chip').forEach(el => el.remove());
        (detected.args || []).forEach(a => {
          const chip = document.createElement('span');
          chip.className = 'stg-mcp-arg-chip';
          chip.textContent = a;
          const x = document.createElement('button');
          x.type = 'button'; x.className = 'stg-mcp-arg-chip-x'; x.textContent = '×';
          x.addEventListener('click', () => chip.remove());
          chip.appendChild(x);
          argChips.insertBefore(chip, argInput);
        });
      }
      // Rebuild env rows
      if (envRows) {
        envRows.innerHTML = '';
        for (const [k, v] of Object.entries(detected.env || {})) {
          const row = document.createElement('div');
          row.className = 'stg-mcp-env-row';
          row.innerHTML = `<input type="text" class="stg-input stg-input-sm stg-mcp-env-key" value="${esc(k)}"><input type="text" class="stg-input stg-input-sm stg-mcp-env-val" value="${esc(String(v))}"><button class="stg-mcp-env-del" type="button">×</button>`;
          row.querySelector('.stg-mcp-env-del')?.addEventListener('click', () => row.remove());
          envRows.appendChild(row);
        }
      }
      // Rebuild remote fields
      if (urlEl) urlEl.value = detected.url || '';
      if (hdrRows) {
        hdrRows.innerHTML = '';
        for (const [k, v] of Object.entries(detected.headers || {})) addHeaderRow(k, String(v));
      }
      if (oauthClientIdEl) oauthClientIdEl.value = detected.oauth?.clientId || '';
      if (oauthPortEl) oauthPortEl.value = detected.oauth?.callbackPort || '';
      // Toggle stdio/url fields
      if (addForm) addForm.dataset.transport = detected.type || 'stdio';
    }

    // Toggle form between 'mcp' and 'plugin' modes.
    // In plugin mode we hide MCP-specific fields (Type/Command/Args/URL/env/platforms/Save)
    // and show a single Done button because the plugin is already activated server-side.
    function setFormMode(mode) {
      if (addForm) addForm.dataset.kind = mode;
      const isPlugin = mode === 'plugin';
      const mcpOnly = addForm?.querySelectorAll('.stg-mcp-form-grid, .stg-mcp-field-remote, #stg-mcp-env-rows, #stg-mcp-env-add, #stg-mcp-platforms') || [];
      mcpOnly.forEach(el => { el.style.display = isPlugin ? 'none' : ''; });
      const envLabels = addForm?.querySelectorAll('.stg-mcp-form-label') || [];
      envLabels.forEach(el => { el.style.display = isPlugin ? 'none' : ''; });
      const saveBtn = overlay.querySelector('#stg-mcp-srv-save');
      if (saveBtn) saveBtn.style.display = isPlugin ? 'none' : '';
    }

    ghInstallBtn?.addEventListener('click', async () => {
      const url = ghUrlEl?.value?.trim();
      if (!url) return;
      setFormMode('mcp'); // reset so form is in a clean state before classification
      if (ghProgress) ghProgress.style.display = '';
      if (ghStatus) ghStatus.textContent = kit.tx('settings.redesign.mcp.cloningRepository');
      if (ghLog) ghLog.textContent = '';
      ghInstallBtn.disabled = true;
      try {
        const res = await fetch('/api/mcp/install/github', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, runInstall: !!ghRunInstallEl?.checked }),
        }).then(r => r.json());
        if (ghLog && Array.isArray(res.log)) ghLog.textContent = res.log.join('\n');
        if (!res.ok) {
          const hintStr = Array.isArray(res.hints) && res.hints.length ? ` (hints: ${res.hints.join(', ')})` : '';
          if (ghStatus) ghStatus.textContent = `${res.error || kit.tx('settings.redesign.mcp.installFailed')}${hintStr}`;
          return;
        }
        if (res.kind === 'claude-plugin') {
          setFormMode('plugin');
          const p = res.plugin || {};
          const hooks = (p.hooks || []).join(', ') || 'none';
          if (ghStatus) {
            ghStatus.innerHTML = `${kit.te('settings.redesign.mcp.installedClaudeCodePlugin')} <b>${esc(p.pluginName || res.name)}</b> @ <b>${esc(p.marketplaceName || '')}</b>${kit.th('settings.redesign.mcp.hooksSymlinkedTo', { hooks: esc(hooks) })} <code>${esc(p.installPath || '')}</code>.`;
          }
          await refreshMcpTab();
          return;
        }
        // MCP (existing behavior)
        setFormMode('mcp');
        const sourceHint = res.alsoClaudePlugin ? (" " + kit.tx('settings.redesign.mcp.repoAlsoShipsAClaudeCode')) : '';
        const warnLine = res.installWarning ? `\n⚠ ${res.installWarning}` : (res.install?.skipped && res.install?.reason ? ("\n" + kit.tx('settings.redesign.mcp.skippedLocalDeps', { reason: res.install.reason })) : '');
        if (ghStatus) ghStatus.textContent = kit.tx('settings.redesign.mcp.detectedViaReviewBelowAndClick', { source: res.detected?.source || res.detectSource || kit.tx('settings.redesign.mcp.heuristic'), sourceHint: sourceHint, warnLine: warnLine });
        applyDetected(res.name, res.detected);
      } catch (err) {
        if (ghStatus) ghStatus.textContent = kit.tx('settings.redesign.mcp.error', { message: err.message || err });
      } finally {
        ghInstallBtn.disabled = false;
      }
    });

    // ── Save handler ──
    overlay.querySelector('#stg-mcp-srv-save')?.addEventListener('click', async () => {
      const name = nameEl?.value?.trim();
      const type = typeEl?.value || 'stdio';
      if (!name) return;
      const config = { type };
      if (type === 'stdio') {
        config.command = cmdEl?.value?.trim() || '';
        const args = collectArgs();
        if (args.length) config.args = args;
      } else {
        config.url = urlEl?.value?.trim() || '';
        const headers = collectHeaders();
        if (Object.keys(headers).length) config.headers = headers;
        const oauth = collectOauth();
        if (oauth) config.oauth = oauth;
      }
      const env = collectEnv();
      if (Object.keys(env).length) config.env = env;
      if (!config.command && !config.url) return;

      // Save to registry
      await fetch(`/api/mcp/registry/servers/${encodeURIComponent(name)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });

      // Sync to checked platforms
      const platforms = [];
      platformsEl?.querySelectorAll('.stg-mcp-platform-check').forEach(label => {
        const cb = label.querySelector('input[type="checkbox"]');
        if (cb?.checked) platforms.push(label.dataset.platform);
      });
      if (platforms.length && feedbackEl) {
        feedbackEl.innerHTML = kit.te('settings.redesign.mcp.syncing');
        try {
          const res = await fetch('/api/mcp/sync', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, config, platforms }),
          }).then(r => r.json());
          if (res.results) {
            feedbackEl.innerHTML = Object.entries(res.results).map(([p, s]) => {
              const cls = s === 'ok' ? 'ok' : s === 'skipped' ? 'skip' : 'err';
              const icon = s === 'ok' ? '\u2713' : s === 'skipped' ? '\u2014' : '\u2717';
              return `<span class="stg-mcp-sync-result ${cls}">${icon} ${esc(p)}</span>`;
            }).join(' ');
          }
        } catch { feedbackEl.innerHTML = '<span class="stg-mcp-sync-result err">' + kit.te('settings.redesign.mcp.syncFailed') + '</span>'; }
      }

      // Hide form after brief delay so user sees feedback
      setTimeout(() => {
        if (addForm) addForm.style.display = 'none';
        resetAddForm();
      }, platforms.length ? 1500 : 0);
      await refreshMcpTab();
    });

    // ── Config save helpers ──
    async function saveOcpConfig(patch) {
      try {
        await fetch('/api/opencode/config', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
      } catch {}
    }

    // ── Compaction handlers ──
    const compactAutoEl = overlay.querySelector('#stg-ocp-compact-auto');
    const compactPruneEl = overlay.querySelector('#stg-ocp-compact-prune');
    const compactReservedEl = overlay.querySelector('#stg-ocp-compact-reserved');

    function saveCompaction() {
      saveOcpConfig({
        compaction: {
          auto: compactAutoEl?.checked ?? true,
          prune: compactPruneEl?.checked ?? true,
          reserved: Number(compactReservedEl?.value) || 10000,
        },
      });
    }
    compactAutoEl?.addEventListener('change', saveCompaction);
    compactPruneEl?.addEventListener('change', saveCompaction);
    compactReservedEl?.addEventListener('change', saveCompaction);

    // ── Snapshot toggle (persists to config.json; read by OpenCode at startup) ──
    const snapshotToggle = overlay.querySelector('#stg-ocp-snapshot-toggle');
    if (snapshotToggle) {
      // Reflect the persisted state on load (defaults on).
      fetch('/api/opencode/snapshot')
        .then(r => r.json())
        .then(d => { if (d && d.ok) snapshotToggle.classList.toggle('on', d.snapshot !== false); })
        .catch(() => {});
      snapshotToggle.addEventListener('click', async () => {
        const next = !snapshotToggle.classList.contains('on');
        snapshotToggle.classList.toggle('on', next); // optimistic
        try {
          const r = await fetch('/api/opencode/snapshot', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: next }),
          });
          const d = await r.json();
          if (!d || !d.ok) throw new Error(d?.error || 'failed');
        } catch {
          snapshotToggle.classList.toggle('on', !next); // revert on failure
        }
      });
    }

    // Capability filter pills — use CSS vars, not inline color
    function buildCapPills(container, filterSet, onChange) {
      if (!container) return;
      for (const b of STG_CAP_BADGES) {
        // a multi-select segmented control: each segment is a toggle button
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'stg-cap-filter';
        pill.textContent = b.label;
        pill.setAttribute('aria-pressed', 'false');
        pill.addEventListener('click', () => {
          if (filterSet.has(b.label)) {
            filterSet.delete(b.label);
            pill.classList.remove('active');
          } else {
            filterSet.add(b.label);
            pill.classList.add('active');
          }
          pill.setAttribute('aria-pressed', String(filterSet.has(b.label)));
          onChange();
        });
        container.appendChild(pill);
      }
    }

    ocpProviderFilterInput?.addEventListener('input', () => {
      _ocpProviderFilter = ocpProviderFilterInput.value || '';
      renderProviderCards();
    });

    buildCapPills(overlay.querySelector('#stg-ocp-provider-cap-filters'), _ocpProviderCapFilters, () => {
      renderProviderCards();
    });

    // ── Open config file in Synabun's editor ──
    overlay.querySelector('#stg-ocp-open-config')?.addEventListener('click', async () => {
      try {
        let filePath = '';

        const revealResp = await fetch('/api/opencode/config/reveal', { method: 'POST' });
        let revealData = null;
        try { revealData = await revealResp.json(); } catch {}

        if (revealResp.ok && revealData?.path) {
          const basePath = String(revealData.path).replace(/\\/g, '/').replace(/\/+$/, '');
          filePath = basePath.endsWith('/config.json') ? basePath : `${basePath}/config.json`;
        } else {
          const fileResp = await fetch('/api/opencode/config/file');
          const fileData = await fileResp.json();
          if (!fileResp.ok || !fileData?.path) {
            showCCToast(fileData?.error || revealData?.error || kit.tx('settings.redesign.opencode.failedToOpenOpencodeConfig'));
            return;
          }
          filePath = fileData.path;
        }

        emit('open-file-editor', { filePath });
      } catch (err) {
        console.error('[settings] Failed to open OpenCode config:', err);
        showCCToast(kit.tx('settings.redesign.opencode.failedToOpenOpencodeConfig'));
      }
    });

    // ── Provider refresh (full data) ──
    async function refreshOcpProviders() {
      try {
        const [provResp, authResp, storedResp] = await Promise.all([
          fetch('/api/opencode/providers/full'),
          fetch('/api/opencode/providers/auth'),
          fetch('/api/opencode/auth/stored'),
          hydrateHiddenModels(),
        ]);
        const provData = await provResp.json();
        const authData = await authResp.json();
        const storedData = await storedResp.json();
        const raw = provData.data || {};
        _ocpProviders = raw.all || (Array.isArray(raw) ? raw : []);
        _ocpConnected = new Set(raw.connected || []);
        _ocpStoredKeys = new Set(storedData.data || []);
        _ocpAuthMethods = authData.data || {};
        renderProviderCards();
      } catch {}
    }

    // ── Load config values into UI ──
    async function loadOcpConfig() {
      try {
        const resp = await fetch('/api/opencode/config');
        const data = await resp.json();
        _ocpConfig = data.data || {};
        const comp = _ocpConfig.compaction || {};
        if (compactAutoEl) compactAutoEl.checked = comp.auto !== false;
        if (compactPruneEl) compactPruneEl.checked = comp.prune !== false;
        if (compactReservedEl) compactReservedEl.value = comp.reserved || 10000;
      } catch {}
    }

    // ── Master refresh ──
    async function refreshOcpStatus() {
      setOcpStatus(kit.tx('settings.redesign.opencode.checking'), 'dim');
      try {
        const resp = await fetch('/api/opencode/status');
        const data = await resp.json();
        if (data.clearingHistory) {
          setOcpStatus(kit.tx('settings.redesign.opencode.clearingHistory'), 'warn');
        } else if (data.running) {
          setOcpStatus(kit.tx('settings.redesign.opencode.runningVersion', { version: data.version ? ' v' + data.version : '' }), 'ok');
          await Promise.all([
            refreshOcpProviders(),
            loadOcpConfig(),
            renderToolPermissions(),
          ]);
        } else {
          setOcpStatus(kit.tx('settings.redesign.opencode.offline'), 'dim');
          if (ocpProvidersEl) ocpProvidersEl.innerHTML = '<div class="settings-hint" style="opacity:0.4">' + kit.te('settings.redesign.opencode.startTheServerToSeeProviders') + '</div>';
          if (ocpToolsEl) ocpToolsEl.innerHTML = '<div class="settings-hint" style="opacity:0.4">' + kit.te('settings.redesign.opencode.startTheServerToLoadTools') + '</div>';
        }
      } catch (err) {
        setOcpStatus(kit.tx('settings.redesign.opencode.error'), 'err');
      }
    }

    // ── Server start/stop/refresh ──
    overlay.querySelector('#stg-ocp-start')?.addEventListener('click', async () => {
      const port = overlay.querySelector('#stg-ocp-port')?.value || 4096;
      setOcpStatus(kit.tx('settings.redesign.opencode.starting'), 'warn');
      try {
        await fetch('/api/opencode/serve/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port: Number(port) }) });
      } catch {}
      setTimeout(refreshOcpStatus, 1500);
    });

    overlay.querySelector('#stg-ocp-stop')?.addEventListener('click', async () => {
      try { await fetch('/api/opencode/serve/stop', { method: 'POST' }); } catch {}
      setTimeout(refreshOcpStatus, 500);
    });

    overlay.querySelector('#stg-ocp-refresh')?.addEventListener('click', refreshOcpStatus);

    // Auto-refresh on tab open + start Ollama detection
    refreshOcpStatus();
    loadOcpHistoryStats();
    startOllamaPoll();

    // Clean up Ollama polling when settings overlay closes
    const settingsOverlay = overlay.closest('.settings-overlay') || overlay;
    const ollamaCleanupObserver = new MutationObserver(() => {
      if (!document.body.contains(settingsOverlay)) {
        stopOllamaPoll();
        ollamaCleanupObserver.disconnect();
      }
    });
    ollamaCleanupObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ── Skins tab: wire interaction ──
  wireSkinsTab(overlay, skinsData.skins, skinsData.active);

  // ── Icons tab: wire interaction ──
  wireIconsTab(overlay, customIconsData);

  // ── Variant tabs: call afterRender ──
  for (const vTab of variantTabs) {
    if (typeof vTab.afterRender === 'function') {
      const tabBody = kit.paneOf(overlay, vTab.id);
      if (tabBody) vTab.afterRender(tabBody);
    }
  }

  // ── Shell behaviours: jump lists, keyboard disclosure, page picker ──
  wireSettingsShell(overlay, { activate: (pageId) => activateSettingsTab(overlay, pageId) });
  // ── Search: the index is built from the strings of the active locale; what the panes load is read at query time ──
  // In another locale the English names are searched too (someone who learned the settings in English still finds
  // them): from the bundle i18n already holds as its fallback, or, when it has none, loaded once as the field is first used.
  const searchIndex = (en) => buildSettingsSearchIndex({ t: kit.tx, en, variants: variantTabs.map(tab => ({ id: tab.id, label: tab.label })) });
  const english = getLocale() === 'en' ? null : englishTranslator();
  wireSettingsSearch(overlay, {
    index: searchIndex(english),
    english: getLocale() === 'en' || english ? null : () => loadEnglishTranslator().then(en => (en ? searchIndex(en) : null)),
    land: (entry, o) => landOnSearchEntry(overlay, entry, o),
    locate: (entry) => locateSearchEntry(overlay, entry),
    sources: SEARCH_ROW_SOURCES,
    off: SEARCH_OFF,
  });
  // A deep link's `expand` wins over anything a pane collapsed while it wired itself.
  applySettingsOpenOptions(overlay, options, { quiet: true });
}


// ═══════════════════════════════════════════
// MEMORY SYNC
// ═══════════════════════════════════════════

export async function checkSyncStatus() {
  const btn = document.getElementById('sync-check-btn');
  const results = document.getElementById('sync-results');
  if (!btn || !results) return;

  btn.classList.add('loading');
  btn.disabled = true;
  results.innerHTML = '';

  try {
    const res = await fetch('/api/sync/check');
    const data = await res.json();

    if (data.total_stale === 0) {
      results.innerHTML = `
        <div class="sync-summary clean">
          ${kit.th('settings.redesign.sync.allClear', { strong: `<strong>${kit.te('settings.redesign.sync.allClearWord')}</strong>`, count: data.total_with_files })}
        </div>`;
      return;
    }

    let html = `
      <div class="sync-summary">
        ${kit.th('settings.redesign.sync.staleCount', { stale: `<strong>${data.total_stale}</strong>`, count: data.total_with_files })}
        <button class="sync-select-all" id="sync-select-all">${kit.te('settings.redesign.sync.deselectAll')}</button>
      </div>`;

    for (const mem of data.stale) {
      const preview = mem.content.length > 120
        ? mem.content.slice(0, 120) + '...'
        : mem.content;
      const files = mem.stale_files.map(f => `<span>${f.path}</span>`).join(', ');

      html += `
        <div class="sync-card selected" data-sync-id="${mem.id}">
          <div class="sync-card-header">
            <div class="sync-card-check"></div>
            <span class="sync-card-category">${mem.category}</span>
            <span class="sync-card-importance">${kit.te('settings.redesign.sync.importanceShort', { importance: mem.importance })}</span>
          </div>
          <div class="sync-card-content">${escapeHtml(preview)}</div>
          <div class="sync-card-files">${kit.th('settings.redesign.sync.changedFiles', { files })}</div>
        </div>`;
    }

    html += `<button class="sync-copy-btn" id="sync-copy-all">${kit.te('settings.redesign.sync.copyPromptCount', { count: data.total_stale })}</button>`;
    results.innerHTML = html;

    results._syncData = data;

    // Card selection toggle
    results.querySelectorAll('.sync-card').forEach(card => {
      card.addEventListener('click', () => {
        card.classList.toggle('selected');
        updateSyncCopyBtn();
      });
    });

    // Copy button
    const copyBtn = document.getElementById('sync-copy-all');
    if (copyBtn) copyBtn.addEventListener('click', () => copySyncPrompt());

    // Select all / Deselect all
    document.getElementById('sync-select-all').addEventListener('click', () => {
      const cards = results.querySelectorAll('.sync-card');
      const allSelected = [...cards].every(c => c.classList.contains('selected'));
      cards.forEach(c => c.classList.toggle('selected', !allSelected));
      updateSyncCopyBtn();
    });
  } catch (err) {
    results.innerHTML = `<div class="sync-summary" style="color:var(--accent-red)">${kit.te('settings.redesign.sync.error', { message: err.message })}</div>`;
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}

function updateSyncCopyBtn() {
  const results = document.getElementById('sync-results');
  const btn = document.getElementById('sync-copy-all');
  const selectAllBtn = document.getElementById('sync-select-all');
  if (!results || !btn) return;

  const cards = results.querySelectorAll('.sync-card');
  const selected = results.querySelectorAll('.sync-card.selected');
  const count = selected.length;

  btn.textContent = count ? kit.tx('settings.redesign.sync.copyPromptCount', { count }) : kit.tx('settings.redesign.sync.copyPrompt');
  btn.disabled = count === 0;

  if (selectAllBtn) {
    const allSelected = selected.length === cards.length;
    selectAllBtn.textContent = allSelected ? kit.tx('settings.redesign.sync.deselectAll') : kit.tx('settings.redesign.sync.selectAll');
  }
}

export function copySyncPrompt() {
  const results = document.getElementById('sync-results');
  const data = results?._syncData;
  if (!data || !data.stale.length) return;

  const selectedIds = new Set(
    [...results.querySelectorAll('.sync-card.selected')].map(c => c.dataset.syncId)
  );
  const selected = data.stale.filter(m => selectedIds.has(m.id));
  if (!selected.length) return;

  let prompt = `The following ${selected.length} memories have stale related files and need updating. For each memory, read the current file content, compare it with the memory, and use the reflect tool to update the memory content to match the current code.\n\n`;

  for (const mem of selected) {
    prompt += `Memory ${mem.id}:\n`;
    prompt += `- Category: ${mem.category}\n`;
    prompt += `- Importance: ${mem.importance}\n`;
    prompt += `- Related files: ${mem.related_files.join(', ')}\n`;
    prompt += `- Changed files: ${mem.stale_files.map(f => f.path).join(', ')}\n`;
    prompt += `- Current content:\n${mem.content}\n\n`;
  }

  navigator.clipboard.writeText(prompt).then(() => {
    showSyncCopiedModal(selected.length);
  });
}

function showSyncCopiedModal(count) {
  const modal = document.createElement('div');
  modal.className = 'tag-delete-overlay';
  modal.style.background = 'rgba(0,0,0,0.6)';
  modal.innerHTML = `
    <div class="tag-delete-modal" style="max-width:380px">
      <div class="tag-delete-modal-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
        ${kit.te('settings.redesign.sync.promptCopied')}
      </div>
      <p style="font-size:var(--fs-sm);color:var(--t-secondary);margin-bottom:6px">
        ${kit.te(count === 1 ? 'settings.redesign.sync.readyToSync.one' : 'settings.redesign.sync.readyToSync.other', { count })}
      </p>
      <p style="font-size:var(--fs-sm);color:var(--t-secondary);margin-bottom:6px">
        ${kit.te('settings.redesign.sync.pasteThisPrompt')}
      </p>
      <p style="font-size:var(--fs-xs);color:var(--t-muted);margin-bottom:18px">
        ${kit.te('settings.redesign.sync.modelAffectsAccuracy')}
      </p>
      <div class="tag-delete-modal-actions">
        <button class="action-btn action-btn--ghost" id="sync-modal-close">${kit.te('settings.redesign.sync.gotIt')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('visible'));

  const closeModal = () => {
    modal.classList.remove('visible');
    setTimeout(() => modal.remove(), 200);
  };
  modal.querySelector('#sync-modal-close').addEventListener('click', closeModal);
  // Overlay click disabled — close only via ESC or close button
}


// ═══════════════════════════════════════════
// INIT — wire settings button clicks
// ═══════════════════════════════════════════

export function initSettings() {
  const settingsBtn = document.getElementById('settings-btn');
  if (settingsBtn) settingsBtn.addEventListener('click', () => openSettingsModal());

  const titlebarBtn = document.getElementById('titlebar-settings-btn');
  if (titlebarBtn) titlebarBtn.addEventListener('click', () => openSettingsModal());

  const menubarBtn = document.getElementById('menubar-settings-btn');
  if (menubarBtn) menubarBtn.addEventListener('click', () => openSettingsModal());

  registerAction('open-settings', openSettingsModal);

  // A language change reloaded the app: open Settings again where the user was, once the rest of the app has started.
  const reopenPage = takeSettingsReopen();
  if (reopenPage) setTimeout(() => openSettingsModal({ tab: reopenPage, expand: ['stg-sec-language'] }), 0);

  // Expose sync functions for inline onclick attributes (if any remain)
  window.checkSyncStatus = checkSyncStatus;
  window.copySyncPrompt = copySyncPrompt;
}
