// ═══════════════════════════════════════════
// UI-WHATSAPP — Settings → Connections → WhatsApp
// ═══════════════════════════════════════════
//
// Set up, link and run the WhatsApp Link: chat with the SynaBun Assistant
// from a phone. Everything the service knows comes from GET
// /api/whatsapp/status (masked: no numbers, codes or message text); the
// link QR, the pairing code and the claim code arrive only on the NDJSON
// response of the request this tab made, and closing the tab (or Settings)
// aborts it, which cancels the linking on the server.
//
// Contract with ui-settings.js (same as ui-judgments.js): buildWhatsAppTab()
// returns a static shell that never blocks the panel opening;
// wireWhatsAppTab(overlay, deps) loads live data and binds handlers. The
// delegated collapsible handler in ui-settings.js binds to this markup once,
// so state changes only swap inner containers. Words live in
// ./whatsapp/wa-view.js; this file places them (escaped).

import { escapeHtml } from './utils.js';
import * as kit from './settings/settings-kit.js';
import { emit, on } from './state.js';
import {
  waView, confirmLine, formatCountdown, clockTime, levelLabel, modeLabel, chooseNote, connectorSize, brainLimitText,
  brainChoiceInUse, brainChoiceLabel, brainChoiceNotes,
  localizedCopy, localize, setTranslator,
} from './whatsapp/wa-view.js';
import { normalizePhone, PHONE_ERRORS as PHONE_ERROR_SOURCE } from './whatsapp/wa-phone.js';
// The model selector is the Assistant's own picker: its catalog (enabled models only), its model menu, its effort lists.
import { catalogModelRow, loadModelCatalog, openModelMenu } from './assistant/asst-brain-picker.js';
import { closeMenu, isMenuOpen, openMenu } from './assistant/asst-menu.js';
import { injectAssistantStyles } from './assistant/asst-styles.js';
import { getEffortLevelsForModel } from './agent-runtime-options.js';

// The tab's sentences in the reader's language. English is the source text in wa-view.js / wa-phone.js;
// loadCopy() reads it through i18n each time the tab is built (keys: settings.redesign.wa.*).
let STEPS, MODE_CARDS, LEVEL_CARDS, PROGRESS_OPTIONS, MAX_MESSAGE_OPTIONS, ROTATION_OPTIONS, TRIGGER_OPTIONS, COMMANDS, LIMITS,
  PRIVACY_STAYS, PRIVACY_NEVER, HELP, STAGE_TEXT, ACTIVITY_KINDS, PHONE_HINT, TEST_HINT, PHONE_ERRORS, BRAIN_COPY;
function loadCopy() {
  setTranslator((key, english, params) => {
    const text = kit.tx(key, params);
    return text === key ? String(english).replace(/\{(\w+)\}/g, (m, k) => (params && params[k] != null ? params[k] : m)) : text;
  });
  ({ STEPS, MODE_CARDS, LEVEL_CARDS, PROGRESS_OPTIONS, MAX_MESSAGE_OPTIONS, ROTATION_OPTIONS, TRIGGER_OPTIONS, COMMANDS, LIMITS,
    PRIVACY_STAYS, PRIVACY_NEVER, HELP, STAGE_TEXT, ACTIVITY_KINDS, PHONE_HINT, TEST_HINT, BRAIN_COPY } = localizedCopy());
  PHONE_ERRORS = localize('phoneError', PHONE_ERROR_SOURCE);
}

// Mirrors ui-settings.js (module-local there; duplicated to avoid an import cycle).
const CHEVRON_ICON = '<svg class="cc-section-chevron" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>';

const API = '/api/whatsapp';
// The Assistant's menus sit above its own modals; Settings is a layer above those.
const MENU_Z = 300050;
const ARM_MS = 5000;
const STATUS_EVERY_MS = 4000;
const ACTIVITY_EVERY_MS = 5000;

const attr = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const esc = (s) => escapeHtml(String(s ?? ''));
const num = (n) => Number(n || 0).toLocaleString('en-US');
const btn = (id, label, cls = '', extra = '') => `<button class="wa-btn${cls ? ` ${cls}` : ''}" id="${id}" type="button" ${extra}>${esc(label)}</button>`;
// `named`: the row's <strong id="<id>-label"> and <small id="<id>-help"> name and describe the switch.
const toggle = (id, named = false) => `<label class="recall-toggle"><input type="checkbox" id="${id}"${named ? ` aria-labelledby="${id}-label" aria-describedby="${id}-help"` : ''}><span class="recall-toggle-track"></span></label>`;
const tile = (id, label) => `<div class="db-stat"><span class="db-stat-label">${esc(label)}</span><span class="db-stat-value" id="${id}">—</span></div>`;
const radios = (name, options, invId = '') => `<div class="wa-radios" role="radiogroup"${invId ? ` ${kit.inv(invId)}` : ''}>${options.map((o) => `
  <label class="wa-radio"><input type="radio" name="${name}" value="${attr(o.value)}"><span><strong>${esc(o.label)}</strong>${o.hint ? `<small>${esc(o.hint)}</small>` : ''}</span></label>`).join('')}</div>`;
/** An SVG string → a data: URI for an <img> (never inline markup from the network). */
const svgUri = (svg) => `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(String(svg))))}`;

// A section card. Its title and purpose come from the page list (settings-ia.js: the Messages page).
const SECTION_SLUG = {
  'wa-sec-setup': 'setup_link', 'wa-sec-conversation': 'conversation', 'wa-sec-safety': 'safety', 'wa-sec-data': 'data_privacy',
  'wa-sec-activity': 'activity', 'wa-sec-help': 'help_disclosure', 'wa-sec-phone': 'simulated_phone',
};
function section({ id, badgeId, body, hidden = false }) {
  return kit.card({
    id, section: `messages.${SECTION_SLUG[id]}`, className: 'wa-section',
    status: badgeId ? `<span id="${badgeId}" class="wa-badge"></span>` : '', attrs: hidden ? 'hidden' : '', body,
  });
}

// ── Shell ──

export function buildWhatsAppTab() {
  loadCopy();
  const modeCards = MODE_CARDS.map((card) => `
    <button type="button" class="wa-mode-card" data-mode="${card.id}" aria-pressed="false">
      <span class="wa-mode-head"><strong>${esc(card.title)}</strong><span class="wa-chip">${esc(card.badge)}</span></span>
      <span class="wa-mode-body">${esc(card.body)}</span>
      <ul class="wa-mode-notes">${card.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
    </button>`).join('');
  const levelCards = LEVEL_CARDS.map((card) => `
    <button type="button" class="wa-level-card" data-level="${card.id}" aria-pressed="false">
      <span class="wa-mode-head"><strong>${esc(card.title)}</strong>${card.badge ? `<span class="wa-chip">${esc(card.badge)}</span>` : ''}</span>
      <span class="wa-mode-body">${esc(card.body)}</span>
      <span class="wa-armed-hint" hidden>${kit.te('settings.redesign.whatsapp.clickAgainToAskYourPhone')}</span>
    </button>`).join('');
  const steps = STEPS.map((s, i) => `<li data-step="${s.id}"><span>${i + 1}</span>${esc(s.label)}</li>`).join('');
  const compare = HELP.compare.map((row, i) => `<tr>${row.map((cell) => (i === 0 ? `<th>${esc(cell)}</th>` : `<td>${esc(cell)}</td>`)).join('')}</tr>`).join('');
  return `
    <div class="stg-pane" data-stg-pane="whatsapp">
      <div class="ocp-server-bar wa-header">
        <span class="ocp-server-bar-left wa-header-left">
          <span id="wa-dot" class="ocp-status-dot" data-state="dim"></span>
          <span class="wa-head-text">
            <span class="wa-title" id="wa-title">${kit.te('settings.redesign.whatsapp.checkingWhatsapp')}</span>
            <span class="ocp-server-bar-status" id="wa-sub"></span>
          </span>
        </span>
        <span class="ocp-server-bar-right">
          <button type="button" class="wa-primary" id="wa-primary" hidden></button>
        </span>
      </div>
      <ol class="wa-steps" id="wa-steps" hidden>${steps}</ol>

      ${section({ id: 'wa-sec-setup', badgeId: 'wa-setup-badge', body: `
        <div class="wa-pane" data-pane="loading"><div class="settings-hint">${kit.te('settings.redesign.whatsapp.askingSynabunForTheWhatsappStatus')}</div></div>
        <div class="wa-pane" data-pane="unavailable" hidden><div class="settings-hint" id="wa-unavailable-text"></div></div>

        <div class="wa-pane" data-pane="choose" hidden>
          <div class="wa-mode-cards">${modeCards}</div>
          <div class="wa-method">
            <label class="wa-radio"><input type="radio" name="wa-method" value="qr" checked><span><strong>${kit.te('settings.redesign.whatsapp.linkWithAQrCode')}</strong><small>${kit.te('settings.redesign.whatsapp.scanItWithThePhoneS')}</small></span></label>
            <label class="wa-radio"><input type="radio" name="wa-method" value="code"><span><strong>${kit.te('settings.redesign.whatsapp.linkWithAPhoneNumberInstead')}</strong><small>${kit.te('settings.redesign.whatsapp.whatsappShowsACodeToType')}</small></span></label>
          </div>
          <div class="wa-phone" id="wa-phone-row" hidden>
            <label for="wa-phone">${kit.te('settings.redesign.whatsapp.phoneNumberOfTheAccountTo')}</label>
            <input type="tel" id="wa-phone" autocomplete="off" spellcheck="false" placeholder="+44 7911 123456" inputmode="tel">
            <div class="settings-hint" id="wa-phone-preview">${esc(PHONE_HINT)}</div>
          </div>
          <div class="settings-hint" id="wa-choose-note">${esc(chooseNote(null))}</div>
        </div>

        <div class="wa-pane" data-pane="installing" hidden>
          <ol class="wa-stages" id="wa-stages">${Object.entries(STAGE_TEXT).map(([id, text]) => `<li data-stage="${id}">${esc(text)}</li>`).join('')}</ol>
          <div class="wa-row">${btn('wa-install-cancel', kit.tx('settings.redesign.whatsapp.cancel'))}</div>
        </div>

        <div class="wa-pane" data-pane="install_failed" hidden>
          <div class="wa-callout wa-callout-err" id="wa-install-error"></div>
          <div class="settings-hint">${kit.te('settings.redesign.whatsapp.whatRuns')} <code id="wa-manual-command"></code> ${kit.te('settings.redesign.whatsapp.inItsOwnFolderWithInstall')}</div>
        </div>

        <div class="wa-pane" data-pane="qr" hidden>
          <div class="wa-qr-wrap">
            <div class="wa-qr-card" id="wa-qr-card"><img id="wa-qr-img" alt="${kit.te('settings.redesign.whatsapp.whatsappLinkQrCode')}" width="264" height="264" hidden><div class="wa-qr-wait" id="wa-qr-wait">${kit.te('settings.redesign.whatsapp.preparingTheCode')}</div></div>
            <div class="wa-qr-side">
              <ol class="wa-howto"><li>${kit.te('settings.redesign.whatsapp.openWhatsappOnThePhone')}</li><li>${kit.te('settings.redesign.whatsapp.settingsLinkedDevicesLinkADevice')}</li><li>${kit.te('settings.redesign.whatsapp.pointTheCameraAtThisCode')}</li></ol>
              <div class="wa-countdown" id="wa-qr-countdown"></div>
              <button type="button" class="wa-link-btn" id="wa-use-code">${kit.te('settings.redesign.whatsapp.linkWithAPhoneNumberInstead')}</button>
            </div>
          </div>
        </div>

        <div class="wa-pane" data-pane="code" hidden>
          <div class="wa-code-box">
            <div class="wa-pairing" id="wa-pairing-code" aria-live="polite">········</div>
            <div class="wa-countdown" id="wa-code-countdown"></div>
          </div>
          <ol class="wa-howto"><li>${kit.te('settings.redesign.whatsapp.openWhatsappOnThePhoneOf')}</li><li>${kit.te('settings.redesign.whatsapp.settingsLinkedDevicesLinkADevice')}</li><li>${kit.te('settings.redesign.whatsapp.tapLinkWithPhoneNumberInstead')}</li></ol>
          <button type="button" class="wa-link-btn" id="wa-use-qr">${kit.te('settings.redesign.whatsapp.useTheQrCodeInstead')}</button>
        </div>

        <div class="wa-pane" data-pane="expired" hidden><div class="settings-hint">${kit.te('settings.redesign.whatsapp.aNewCodeIsOneClick')}</div></div>

        <div class="wa-pane" data-pane="confirm_self" hidden>
          <div class="wa-confirm-card">
            <div class="wa-confirm-who" id="wa-confirm-who">${kit.te('settings.redesign.whatsapp.linked')}</div>
            <div class="settings-hint">${kit.te('settings.redesign.whatsapp.onlyThisAccountSMessageYourself')}</div>
            <div class="wa-row">${btn('wa-confirm-yes', kit.tx('settings.redesign.whatsapp.thisIsMeStart'), 'wa-btn-accent')}${btn('wa-confirm-no', kit.tx('settings.redesign.whatsapp.notMeUnlink'), 'wa-btn-danger')}</div>
            <div class="wa-countdown" id="wa-confirm-countdown"></div>
          </div>
        </div>

        <div class="wa-pane" data-pane="claim" hidden>
          <div class="wa-claim-card" id="wa-claim-card">
            <div class="settings-hint" id="wa-claim-intro">${kit.te('settings.redesign.whatsapp.showTheClaimCodeThenSend')}</div>
            <div class="wa-claim-body" id="wa-claim-body" hidden>
              <div class="wa-qr-card wa-qr-small"><img id="wa-claim-qr" alt="${kit.te('settings.redesign.whatsapp.qrCodeThatOpensTheChat')}" width="180" height="180"></div>
              <div class="wa-claim-side">
                <div class="wa-pairing" id="wa-claim-code"></div>
                <div class="settings-hint" id="wa-claim-to"></div>
                <a class="wa-link-btn" id="wa-claim-open" href="#" target="_blank" rel="noopener noreferrer">${kit.te('settings.redesign.whatsapp.openTheChatWithTheCode')}</a>
                <div class="wa-countdown" id="wa-claim-countdown"></div>
                <div class="settings-hint" id="wa-claim-tries"></div>
              </div>
            </div>
            <div class="wa-row">${btn('wa-claim-start', kit.tx('settings.redesign.whatsapp.showTheClaimCode'), 'wa-btn-accent')}</div>
          </div>
        </div>

        <div class="wa-pane" data-pane="connected" hidden>
          <div class="wa-facts" id="wa-connected-facts"></div>
          <div class="wa-row">${btn('wa-test', kit.tx('settings.redesign.whatsapp.sendATestMessage'))}<span class="settings-hint" style="margin:0">${esc(TEST_HINT)}</span></div>
        </div>
        <div class="wa-pane" data-pane="reconnecting" hidden><div class="wa-facts" id="wa-reconnect-facts"></div></div>
        <div class="wa-pane" data-pane="paused" hidden><div class="settings-hint">${kit.te('settings.redesign.whatsapp.whilePausedMessagesFromWhatsappAre')}</div></div>
        <div class="wa-pane" data-pane="logged_out" hidden><div class="settings-hint">${esc(HELP.troubleshooting[1])}</div></div>
        <div class="wa-pane" data-pane="error" hidden><div class="settings-hint" id="wa-error-detail"></div></div>

        <div class="wa-inline-error" id="wa-setup-error" role="alert" hidden></div>
        <div class="wa-actions-row" id="wa-pane-actions"></div>
        <pre class="wa-log" id="wa-install-log" hidden></pre>

        <div class="wa-connector" id="wa-connector" hidden>
          <span class="wa-connector-text" id="wa-connector-text"></span>
          <span class="wa-row">${btn('wa-connector-update', kit.tx('settings.redesign.whatsapp.update'), '', 'hidden')}${btn('wa-connector-log', kit.tx('settings.redesign.whatsapp.installLog'))}${btn('wa-connector-remove', kit.tx('settings.redesign.whatsapp.removeConnector'), 'wa-btn-danger')}</span>
        </div>
      ` })}

      ${section({ id: 'wa-sec-conversation', badgeId: 'wa-conv-badge', body: `
        <div class="wa-row wa-conv-top">
          ${btn('wa-open-conversation', kit.tx('settings.redesign.whatsapp.openConversation'), 'wa-btn-accent')}
          ${btn('wa-new-session', kit.tx('settings.redesign.whatsapp.startAFreshConversation'))}
          <span class="settings-hint" id="wa-session-line" style="margin:0"></span>
        </div>
        <div class="settings-field" id="wa-brain-field">
          <label id="wa-brain-label">${esc(BRAIN_COPY.label)}</label>
          <div class="wa-row">
            <button type="button" class="wa-btn" id="wa-brain-model" aria-haspopup="menu" aria-expanded="false" aria-describedby="wa-brain-hint">${esc(BRAIN_COPY.same)}</button>
            <button type="button" class="wa-btn" id="wa-brain-effort" aria-haspopup="menu" aria-expanded="false" hidden></button>
          </div>
          <div class="settings-hint" id="wa-brain-hint">${esc(BRAIN_COPY.hint)}</div>
          <div class="wa-callout wa-callout-warn" id="wa-brain-note" role="status" hidden></div>
        </div>
        <div class="settings-field"><label>${kit.te('settings.redesign.whatsapp.progressUpdates')}</label>${radios('wa-progress', PROGRESS_OPTIONS)}</div>
        <div class="settings-field wa-toggle-row"><span><strong id="wa-forward-label">${kit.te('settings.redesign.whatsapp.forwardBackgroundResults')}</strong><small id="wa-forward-help">${kit.te('settings.redesign.whatsapp.whenAnAgentStartedFromWhatsapp')}</small></span>${toggle('wa-forward', true)}</div>
        <div class="settings-field">
          <label for="wa-label">${kit.te('settings.redesign.whatsapp.replyLabel')}</label>
          <div class="wa-row"><input type="text" id="wa-label" maxlength="24" autocomplete="off" spellcheck="false" placeholder="${kit.te('settings.redesign.whatsapp.synabun')}">${btn('wa-label-save', kit.tx('settings.redesign.whatsapp.save'))}</div>
          <div class="settings-hint">${kit.te('settings.redesign.whatsapp.preview')} <span class="wa-preview" id="wa-label-preview"></span></div>
        </div>
        <div class="settings-field"><label>${kit.te('settings.redesign.whatsapp.longAnswers')}</label>${radios('wa-max', MAX_MESSAGE_OPTIONS, 'WA045')}<div class="settings-hint">${kit.te('settings.redesign.whatsapp.longerAnswersAreCutThereWith')}</div></div>
        <div class="settings-field"><label>${kit.te('settings.redesign.whatsapp.freshConversation')}</label>${radios('wa-rotation', ROTATION_OPTIONS, 'WA046')}</div>
        <div class="settings-field" id="wa-trigger-field"><label>${kit.te('settings.redesign.whatsapp.inMessageYourself')}</label>${radios('wa-trigger', TRIGGER_OPTIONS, 'WA047')}</div>
        <div class="settings-field"><label>${kit.te('settings.redesign.whatsapp.commandsYouCanSend')}</label>
          <ul class="wa-commands">${COMMANDS.map((c) => `<li><code>${esc(c.name)}</code> ${esc(c.text)}</li>`).join('')}</ul>
          <div class="settings-hint">${kit.te('settings.redesign.whatsapp.answerAQuestionOrAnApproval')}</div>
        </div>
      ` })}

      ${section({ id: 'wa-sec-safety', badgeId: 'wa-level-badge', body: `
        <div class="settings-field"><label>${kit.te('settings.redesign.whatsapp.whatSynabunMayDoFromWhatsapp')}</label><div class="wa-level-cards">${levelCards}</div></div>
        <div class="wa-callout wa-callout-warn" id="wa-brain-warning" hidden></div>
        <div class="wa-callout" id="wa-allow-box" hidden></div>
        <div class="settings-field wa-toggle-row"><span><strong id="wa-strict-label">${kit.te('settings.redesign.whatsapp.askAgainForEveryAgentTask')}</strong><small id="wa-strict-help">${kit.te('settings.redesign.whatsapp.evenAnApprovedPlanAsksOn')}</small></span>${toggle('wa-strict', true)}</div>
        <div class="settings-field wa-toggle-row"><span><strong id="wa-computer-label">${kit.te('settings.redesign.whatsapp.computerUse')}</strong><small id="wa-computer-help">${kit.te('settings.redesign.whatsapp.letTheAssistantControlThisMac')}</small></span>${toggle('wa-computer', true)}</div>
        <div class="wa-facts">
          <div><strong>${kit.te('settings.redesign.whatsapp.whoCanTalkToSynabun')}</strong> <span id="wa-who"></span></div>
        </div>
        <div class="wa-row">${btn('wa-pause', kit.tx('settings.redesign.whatsapp.pauseNow'), 'wa-btn-danger')}${btn('wa-reset-owner', kit.tx('settings.redesign.whatsapp.resetTheOwner'), '', 'hidden')}<span class="settings-hint" style="margin:0" id="wa-pause-hint">${kit.te('settings.redesign.whatsapp.stopsSynabunActingOnWhatsappMessages')}</span></div>
        <div class="settings-field"><label>${kit.te('settings.redesign.whatsapp.fixedLimits')}</label><ul class="wa-list">${LIMITS.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>
      ` })}

      ${section({ id: 'wa-sec-data', body: `
        <div class="settings-field"><label>${kit.te('settings.redesign.whatsapp.whatStaysOnThisComputer')}</label>
          <ul class="wa-list" id="wa-stays">${PRIVACY_STAYS.map((p) => `<li><strong>${esc(p.label)}</strong> <code data-path="${p.key}">…</code><br><small>${esc(p.hint)}</small></li>`).join('')}</ul>
        </div>
        <div class="settings-field"><label>${kit.te('settings.redesign.whatsapp.whatSynabunNeverDoes')}</label><ul class="wa-list">${PRIVACY_NEVER.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>
        <div class="settings-field wa-toggle-row"><span><strong id="wa-activity-text-label">${kit.te('settings.redesign.whatsapp.keepMessageTextInTheActivity')}</strong><small id="wa-activity-text-help">${kit.te('settings.redesign.whatsapp.offTheLogRecordsThatA')}</small></span>${toggle('wa-activity-text', true)}</div>
        <div class="wa-row">${btn('wa-clear-log', kit.tx('settings.redesign.whatsapp.clearLog'))}${btn('wa-unlink', kit.tx('settings.redesign.whatsapp.unlink'), 'wa-btn-danger')}</div>
        <div class="wa-remove">
          <label class="wa-check"><input type="checkbox" id="wa-remove-conversation"> ${kit.te('settings.redesign.whatsapp.alsoDeleteTheWhatsappConversationFrom')}</label>
          ${btn('wa-remove', kit.tx('settings.redesign.whatsapp.removeWhatsappFromSynabun'), 'wa-btn-danger')}
          <div class="settings-hint">${kit.te('settings.redesign.whatsapp.removeUnlinksTheAccountDeletesThe')} ${esc(HELP.uninstall)}</div>
        </div>
      ` })}

      ${section({ id: 'wa-sec-activity', badgeId: 'wa-activity-badge', body: `
        <div class="db-stats wa-tiles">${tile('wa-t-in', kit.tx('settings.redesign.whatsapp.messagesIn'))}${tile('wa-t-out', kit.tx('settings.redesign.whatsapp.sent'))}${tile('wa-t-ignored', kit.tx('settings.redesign.whatsapp.ignored'))}${tile('wa-t-reconnects', kit.tx('settings.redesign.whatsapp.reconnects'))}</div>
        <div class="wa-activity" id="wa-activity-list"><div class="settings-hint">${kit.te('settings.redesign.whatsapp.noActivityYet')}</div></div>
      ` })}

      ${section({ id: 'wa-sec-help', body: `
        <div class="settings-field"><label>${kit.te('settings.redesign.whatsapp.howItWorks')}</label><div class="settings-hint">${esc(HELP.how)}</div></div>
        <table class="wa-compare">${compare}</table>
        <div class="wa-callout wa-callout-warn"><strong>${kit.te('settings.redesign.whatsapp.unofficialConnection')}</strong> ${esc(HELP.unofficial)}</div>
        <div class="settings-hint">${esc(HELP.linkedDevice)}</div>
        <div class="settings-hint"><strong>${kit.te('settings.redesign.whatsapp.lostYourPhone')}</strong> ${esc(HELP.lostPhone)}</div>
        <div class="settings-field"><label>${kit.te('settings.redesign.whatsapp.whatGetsDownloaded')}</label><div class="settings-hint">${esc(HELP.downloads)} <span id="wa-pin-line"></span></div></div>
        <div class="settings-field"><label>${kit.te('settings.redesign.whatsapp.troubleshooting')}</label><ul class="wa-list">${HELP.troubleshooting.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>
        <div class="settings-hint">${esc(HELP.browserTools)}</div>
      ` })}

      ${section({ id: 'wa-sec-phone', hidden: true, body: `
        <div class="settings-hint">${kit.te('settings.redesign.whatsapp.synabunWhatsappFake1NoReal')}</div>
        <div class="wa-row">${btn('wa-fake-scan', kit.tx('settings.redesign.whatsapp.scanTheQr'))}${btn('wa-fake-drop', kit.tx('settings.redesign.whatsapp.dropConnection'))}${btn('wa-fake-logout', kit.tx('settings.redesign.whatsapp.logOutFromPhone'))}${btn('wa-fake-ban', kit.tx('settings.redesign.whatsapp.ban'))}${btn('wa-fake-crash', kit.tx('settings.redesign.whatsapp.crashConnector'))}</div>
        <div class="wa-row"><input type="text" id="wa-fake-text" placeholder="${kit.te('settings.redesign.whatsapp.aMessageFromThePhone')}" aria-label="${kit.te('settings.redesign.whatsapp.aMessageFromThePhone')}" autocomplete="off">${btn('wa-fake-owner', kit.tx('settings.redesign.whatsapp.sendAsMe'))}${btn('wa-fake-stranger', kit.tx('settings.redesign.whatsapp.sendAsAStranger'))}</div>
        <div class="wa-activity" id="wa-fake-sent"></div>
      ` })}
    </div>`;
}

// ── Wiring ──

export function wireWhatsAppTab(overlay, { toast = () => {} } = {}) {
  const $ = (id) => overlay.querySelector(`#${id}`);
  if (!$('wa-dot')) return;
  const tabBody = kit.paneOf(overlay, 'whatsapp');
  const alive = () => document.body.contains(overlay);
  const tabActive = () => alive() && kit.paneActive(overlay, 'whatsapp');

  const readJson = async (res) => {
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { ok: false, error: text.slice(0, 120) || `HTTP ${res.status}` }; }
    if (!res.ok && json.ok !== false) json = { ok: false, error: json.error || `HTTP ${res.status}` };
    json.status = res.status;
    return json;
  };
  const state = {
    status: null, version: 0, closed: false, timers: {}, armed: {}, controllers: new Set(),
    mode: 'self', method: 'qr', link: null, claim: null, qrExpiresAt: null, codeExpiresAt: null, claimExpiresAt: null,
    escalation: null, autoLink: null, showChoose: false, syncTimer: null, activitySig: '',
  };
  const request = async (method, url, body) => {
    if (state.closed) return { ok: false, error: 'closed', status: 0 };
    const controller = new AbortController();
    state.controllers.add(controller);
    try {
      const init = { method, signal: controller.signal, headers: {} };
      if (method !== 'GET') {
        init.headers = { 'Content-Type': 'application/json', 'X-SynaBun-UI': '1' };
        init.body = JSON.stringify(body ?? {});
      }
      return await readJson(await fetch(url, init));
    } catch (error) {
      return { ok: false, error: error?.name === 'AbortError' ? 'cancelled' : error?.message || kit.tx('settings.redesign.whatsapp.networkError'), status: 0 };
    } finally { state.controllers.delete(controller); }
  };
  const jget = (path) => request('GET', `${API}${path}`);
  const jsend = (method, path, body) => request(method, `${API}${path}`, body);

  const setText = (el, text) => { if (el && el.textContent !== String(text ?? '')) el.textContent = String(text ?? ''); };
  const show = (el, on) => { if (el) el.hidden = !on; };
  const setValue = (el, value) => { if (!el || document.activeElement === el) return; const v = value == null ? '' : String(value); if (el.value !== v) el.value = v; };
  const setChecked = (el, onOff) => { if (el && document.activeElement !== el && el.checked !== !!onOff) el.checked = !!onOff; };
  const setRadio = (name, value) => { for (const r of tabBody.querySelectorAll(`input[name="${name}"]`)) { if (document.activeElement !== r) r.checked = r.value === String(value); } };
  const errorLine = (message) => { const el = $('wa-setup-error'); setText(el, message || ''); show(el, !!message); };

  // ── Sections (the shell remembers which are open; the delegated toggler in ui-settings.js runs first) ──
  $('wa-sec-activity')?.addEventListener('click', (e) => {
    if (e.target.closest('select, input, button, textarea, a, .cc-section-body')) return;
    if (!$('wa-sec-activity').classList.contains('collapsed')) refreshActivity();
  });

  // ── Armed (two-click) buttons ──
  function armed(key, el, label, confirmLabel) {
    if (state.armed[key]) { state.armed[key] = false; clearTimeout(state.timers[`arm-${key}`]); setText(el, label); return true; }
    state.armed[key] = true;
    setText(el, confirmLabel);
    clearTimeout(state.timers[`arm-${key}`]);
    state.timers[`arm-${key}`] = setTimeout(() => { state.armed[key] = false; setText(el, label); }, ARM_MS);
    return false;
  }

  // ── Render ──
  function apply(status) {
    if (state.closed) return;
    state.status = status;
    if (status?.ok !== false) state.version = Number(status?.version) || state.version;
    const view = waView(status);
    const dot = $('wa-dot');
    dot.dataset.state = view.dot;
    setText($('wa-title'), view.title);
    setText($('wa-sub'), view.sub);
    kit.setNavStatus(overlay, 'whatsapp', view.nav);
    const primary = $('wa-primary');
    const primaryAction = state.showChoose && ['link_expired', 'logged_out'].includes(status?.state) ? { id: 'setup', label: kit.tx('settings.redesign.whatsapp.linkWhatsapp') } : view.primary;
    if (primaryAction) { primary.dataset.action = primaryAction.id; setText(primary, primaryAction.label); show(primary, true); } else show(primary, false);
    // Steps (only while setting up).
    const steps = $('wa-steps');
    show(steps, !!view.step && view.step !== 'done');
    const order = STEPS.map((s) => s.id);
    for (const li of steps.querySelectorAll('li')) {
      const i = order.indexOf(li.dataset.step);
      const at = order.indexOf(view.step);
      li.className = i < at ? 'done' : i === at ? 'current' : '';
    }
    // Pane.
    const pane = state.showChoose && ['link_expired', 'logged_out'].includes(status?.state) ? 'choose' : view.pane;
    for (const el of tabBody.querySelectorAll('.wa-pane')) show(el, el.dataset.pane === pane);
    renderPaneActions(view);
    renderSetupDetails(status, view, pane);
    renderConnector(status);
    renderConversation(status);
    renderSafety(status);
    renderPrivacy(status);
    renderTiles(status);
    show($('wa-sec-phone'), !!status?.fake);
    setText($('wa-setup-badge'), status?.state ? view.title : '');
    tickCountdowns();
    // An install this tab started, done: go straight on to the QR.
    if (state.autoLink && status?.state === 'ready' && !state.link) { const next = state.autoLink; state.autoLink = null; startLink(next.method, next.phone); }
    if (state.autoLink && status?.state === 'install_failed') state.autoLink = null;
  }
  function renderPaneActions(view) {
    const box = $('wa-pane-actions');
    const b = view.secondary;
    const html = b ? `<button type="button" class="wa-btn" data-action="${attr(b.id)}">${esc(b.label)}</button>` : '';
    if (box.dataset.sig !== html) { box.innerHTML = html; box.dataset.sig = html; }
  }
  function renderSetupDetails(s, view, pane) {
    if (!s) return;
    if (pane === 'unavailable') setText($('wa-unavailable-text'), view.sub);
    for (const card of tabBody.querySelectorAll('.wa-mode-card')) card.setAttribute('aria-pressed', String(card.dataset.mode === state.mode));
    show($('wa-phone-row'), state.method === 'code');
    if (s.state === 'installing') {
      const order = Object.keys(STAGE_TEXT);
      const at = order.indexOf(s.stage || 'checking');
      for (const li of $('wa-stages').querySelectorAll('li')) { const i = order.indexOf(li.dataset.stage); li.className = i < at ? 'done' : i === at ? 'current' : ''; }
    }
    if (s.state === 'install_failed') {
      setText($('wa-install-error'), view.sub + (s.connector?.errorMessage ? ` (${s.connector.errorMessage})` : ''));
      setText($('wa-manual-command'), s.manualCommand || '');
    }
    if (pane === 'confirm_self') {
      setText($('wa-confirm-who'), confirmLine(s));
    }
    if (pane === 'connected') {
      const lines = [
        [kit.tx('settings.redesign.whatsapp.mode'), modeLabel(s.mode)],
        [kit.tx('settings.redesign.whatsapp.account'), [s.account?.name && s.account.name !== '~' ? s.account.name : null, s.account?.masked].filter(Boolean).join(' · ') || '—'],
        [kit.tx('settings.redesign.whatsapp.owner'), s.owner?.masked ? `${s.owner.masked}${s.owner.boundAt ? (" " + kit.tx('settings.redesign.whatsapp.ownerSince', { date: new Date(s.owner.boundAt).toLocaleDateString() })) : ''}` : '—'],
        [kit.tx('settings.redesign.whatsapp.level'), `${levelLabel(s.level)}${s.level === 'autonomous' && s.levelExpiresAt ? (" " + kit.tx('settings.redesign.whatsapp.levelUntil', { time: clockTime(s.levelExpiresAt) })) : ''}`],
      ];
      const html = lines.map(([k, v]) => `<div><strong>${esc(k)}</strong> ${esc(v)}</div>`).join('');
      if ($('wa-connected-facts').innerHTML !== html) $('wa-connected-facts').innerHTML = html;
    }
    if (pane === 'reconnecting') setText($('wa-reconnect-facts'), view.sub);
    if (pane === 'error') setText($('wa-error-detail'), s.code ? kit.tx('settings.redesign.whatsapp.errorCode', { code: s.code }) : '');
  }
  function renderConnector(s) {
    const c = s?.connector;
    const box = $('wa-connector');
    show(box, !!c?.installed || !!c?.pinned);
    if (!c) return;
    const text = c.installed
      ? kit.tx('settings.redesign.whatsapp.connectorBaileys', { version: c.version || '', installedAt: c.installedAt ? (" " + kit.tx('settings.redesign.whatsapp.installed', { value: new Date(c.installedAt).toLocaleDateString() })) : '', outdated: c.outdated ? (" " + kit.tx('settings.redesign.whatsapp.updateToAvailable', { pinned: c.pinned })) : '' })
      : kit.tx('settings.redesign.whatsapp.connectorNotInstalled', { pinned: c.pinned ? (" " + kit.tx('settings.redesign.whatsapp.pinnedBaileys', { pinned: c.pinned, approxSizeMB: c.approxSizeMB ? kit.tx('settings.redesign.whatsapp.aboutMb', { approxSizeMB: c.approxSizeMB }) : '' })) : '' });
    setText($('wa-connector-text'), text);
    show($('wa-connector-update'), !!c.installed && !!c.outdated);
    show($('wa-connector-remove'), !!c.installed);
    const size = connectorSize(s);
    setText($('wa-pin-line'), c.pinned ? kit.tx('settings.redesign.whatsapp.pinnedBaileys2', { pinned: c.pinned, size: size ? `, ${size}` : '' }) : '');
    setText($('wa-choose-note'), chooseNote(s));
  }
  function renderConversation(s) {
    const cfg = s?.config;
    if (!cfg) return;
    setRadio('wa-progress', cfg.progress);
    setChecked($('wa-forward'), cfg.forwardBackground);
    setValue($('wa-label'), cfg.replyLabel || '');
    $('wa-label').placeholder = s.mode === 'dedicated' ? kit.tx('settings.redesign.whatsapp.noLabel') : kit.tx('settings.redesign.whatsapp.synabun');
    renderLabelPreview();
    setRadio('wa-max', cfg.maxMessages);
    setRadio('wa-rotation', cfg.rotation);
    setRadio('wa-trigger', cfg.selfTrigger);
    show($('wa-trigger-field'), s.mode !== 'dedicated');
    const session = s.session;
    setText($('wa-session-line'), session?.id ? kit.tx('settings.redesign.whatsapp.sessionCurrent', { title: session.title || kit.tx('settings.redesign.whatsapp.whatsappConversation') }) : kit.tx('settings.redesign.whatsapp.noConversationYetYourFirstMessage'));
    $('wa-open-conversation').disabled = !session?.id;
    $('wa-new-session').disabled = !['connected', 'paused', 'reconnecting'].includes(s.state);
    setText($('wa-conv-badge'), session?.title || '');
    renderBrain(s);
  }
  // ── Which model runs WhatsApp (the Assistant's own picker and catalog) ──
  /** The effort levels of the chosen model as the Assistant's picker lists them (its "off" is the model's default). */
  function brainEfforts(choice) {
    if (!choice) return [];
    try { return getEffortLevelsForModel(choice.provider, catalogModelRow(choice.provider, choice.model)) || []; } catch { return []; }
  }
  function renderBrain(s) {
    const modelBtn = $('wa-brain-model');
    if (!modelBtn) return;
    // No brainChoice in the status (an older server): the default, and nothing to warn about.
    const choice = brainChoiceInUse(s);
    const row = choice ? catalogModelRow(choice.provider, choice.model) : null;
    setText(modelBtn, brainChoiceLabel(s, { modelLabel: row?.label || '' }));
    const efforts = brainEfforts(choice).filter((e) => e.id !== 'off');
    const effortBtn = $('wa-brain-effort');
    show(effortBtn, !!choice && efforts.length > 0);
    if (choice && efforts.length) {
      const level = efforts.find((e) => e.id === choice.effort);
      setText(effortBtn, `${BRAIN_COPY.effort}: ${level ? level.label : (choice.effort || BRAIN_COPY.effortDefault)}`);
    }
    const notes = brainChoiceNotes(s);
    const box = $('wa-brain-note');
    const html = notes.map((note) => `<div>${esc(note)}</div>`).join('');
    if (box.dataset.sig !== html) { box.innerHTML = html; box.dataset.sig = html; }
    show(box, notes.length > 0);
  }
  async function saveBrain(brain) {
    const r = await putConfig({ brain });
    if (r.ok !== false) toast(BRAIN_COPY.saved);
  }
  async function openBrainMenu() {
    const btn = $('wa-brain-model');
    if (isMenuOpen(btn)) { closeMenu(); return; }
    injectAssistantStyles();
    const current = brainChoiceInUse(state.status);
    await openModelMenu(btn, {
      includeHere: true, hereLabel: BRAIN_COPY.same, title: BRAIN_COPY.menuTitle, allowCustom: false, t: kit.tx, zIndex: MENU_Z,
      // Under the button when a usable list fits there: opening upward covered the Settings header.
      placement: 'prefer-below',
      current: current ? { provider: current.provider, model: current.model } : null,
      onSelect: (target) => {
        if (target?.here) { saveBrain(null); return; }
        if (!target?.provider || !target?.model) return;
        // The effort stays when the new model runs it too; otherwise the model's default.
        const keeps = current?.effort && Array.isArray(target.efforts) && target.efforts.includes(current.effort);
        saveBrain({ provider: target.provider, model: target.model, effort: keeps ? current.effort : null });
      },
    });
  }
  async function openEffortMenu() {
    const btn = $('wa-brain-effort');
    if (isMenuOpen(btn)) { closeMenu(); return; }
    const choice = brainChoiceInUse(state.status);
    if (!choice) return;
    injectAssistantStyles();
    openMenu(btn, {
      title: BRAIN_COPY.effort, role: 'menu', zIndex: MENU_Z,
      items: brainEfforts(choice).map((e) => ({
        kind: 'radio', id: e.id, label: e.id === 'off' ? BRAIN_COPY.effortDefault : e.label, desc: e.desc || '',
        selected: e.id === 'off' ? !choice.effort : e.id === choice.effort,
        onSelect: () => saveBrain({ provider: choice.provider, model: choice.model, effort: e.id === 'off' ? null : e.id }),
      })),
    });
  }
  function renderLabelPreview() {
    const s = state.status;
    const raw = $('wa-label').value.trim();
    const label = raw || (s?.mode === 'dedicated' ? '' : 'SynaBun:');
    setText($('wa-label-preview'), kit.tx('settings.redesign.whatsapp.previewSample', { label: label ? `${label} ` : '' }));
  }
  function renderSafety(s) {
    const level = s?.level || s?.config?.level || 'ask';
    for (const card of tabBody.querySelectorAll('.wa-level-card')) {
      card.setAttribute('aria-pressed', String(card.dataset.level === level));
      show(card.querySelector('.wa-armed-hint'), card.dataset.level === 'autonomous' && !!state.armed.autonomous);
    }
    setText($('wa-level-badge'), s?.state ? `${levelLabel(level)}${s.paused ? (" " + kit.tx('settings.redesign.whatsapp.levelPaused')) : ''}` : '');
    // Ask and Autonomous hold on a Claude brain only: say so when the conversation runs on another one.
    const brainWarning = brainLimitText(s);
    setText($('wa-brain-warning'), brainWarning);
    show($('wa-brain-warning'), !!brainWarning);
    setChecked($('wa-strict'), s?.config?.strictWorkerApprovals);
    // Computer use from WhatsApp: off unless this computer turned it on (a status without the field reads as off).
    setChecked($('wa-computer'), s?.config?.computerUse === true);
    const who = s?.mode === 'dedicated'
      ? (s?.owner?.masked ? kit.tx('settings.redesign.whatsapp.theOwnerBoundWithTheClaim', { masked: s.owner.masked }) : kit.tx('settings.redesign.whatsapp.theOwnerIsNotBoundYet'))
      : kit.tx('settings.redesign.whatsapp.onlyYouInYourOwnMessage');
    setText($('wa-who'), who);
    show($('wa-reset-owner'), s?.mode === 'dedicated' && !!s?.owner?.masked);
    $('wa-pause').disabled = !!s?.paused || !['connected', 'reconnecting', 'confirm_owner'].includes(s?.state);
    // The code lives only in this tab (the PUT answer); the status says when the phone answered or it expired.
    if (!s?.escalation && state.escalation && Date.now() - state.escalation.at > 2000) state.escalation = null;
    renderAllowBox();
  }
  function renderAllowBox() {
    const box = $('wa-allow-box');
    const e = state.escalation;
    if (!e || Date.now() > e.expiresAt) { show(box, false); return; }
    const html = `<strong>${kit.te('settings.redesign.whatsapp.nowOnYourPhone')}</strong> ${kit.te('settings.redesign.whatsapp.send')} <code class="wa-allow-code">ALLOW ${esc(e.code)}</code> ${kit.te('settings.redesign.whatsapp.inTheWhatsappChatWithSynabun')} <span id="wa-allow-countdown">${esc(formatCountdown(e.expiresAt - Date.now()))}</span>${kit.te('settings.redesign.whatsapp.autonomousThenRunsFor8Hours')}`;
    if (box.dataset.sig !== e.code) { box.innerHTML = html; box.dataset.sig = e.code; }
    show(box, true);
  }
  function renderPrivacy(s) {
    const paths = s?.paths || {};
    for (const code of tabBody.querySelectorAll('#wa-stays code[data-path]')) setText(code, paths[code.dataset.path] || '—');
    setChecked($('wa-activity-text'), s?.config?.activityText);
    const linked = ['connected', 'paused', 'reconnecting', 'confirm_owner', 'error'].includes(s?.state);
    $('wa-unlink').disabled = !linked;
  }
  function renderTiles(s) {
    const c = s?.counters || {};
    setText($('wa-t-in'), num(c.accepted ?? c.inbound));
    setText($('wa-t-out'), num(c.sent));
    setText($('wa-t-ignored'), num(c.ignored));
    setText($('wa-t-reconnects'), num(c.reconnects));
  }

  // ── Countdowns (one ticker while anything counts down) ──
  function tickCountdowns() {
    const now = Date.now();
    const set = (id, until, key) => setText($(id), until ? (until > now ? kit.tx(key, { time: formatCountdown(until - now) }) : kit.tx('settings.redesign.whatsapp.expired')) : '');
    set('wa-qr-countdown', state.qrExpiresAt, 'settings.redesign.whatsapp.countdownQr');
    set('wa-code-countdown', state.codeExpiresAt, 'settings.redesign.whatsapp.countdownExpires');
    set('wa-claim-countdown', state.claimExpiresAt, 'settings.redesign.whatsapp.countdownExpires');
    const confirmUntil = state.status?.confirm?.kind === 'self' ? state.status.confirm.expiresAt : null;
    set('wa-confirm-countdown', confirmUntil, 'settings.redesign.whatsapp.countdownLogout');
    if (state.escalation) {
      const el = $('wa-allow-countdown');
      if (el) setText(el, formatCountdown(state.escalation.expiresAt - now));
      if (now > state.escalation.expiresAt) { state.escalation = null; renderAllowBox(); }
    }
  }

  // ── Loading ──
  async function loadStatus() {
    if (state.closed) return;
    const s = await jget('/status');
    if (state.closed) return;
    apply(s.ok === false ? { ok: false, status: s.status, error: s.error } : s);
  }
  async function refreshActivity() {
    if (state.closed || $('wa-sec-activity').classList.contains('collapsed')) return;
    const r = await jget('/activity?limit=50');
    if (state.closed || r.ok === false) return;
    const rows = Array.isArray(r.entries) ? r.entries : [];
    const sig = JSON.stringify(rows.map((e) => [e.at, e.kind, e.detail, e.text]));
    if (sig === state.activitySig) return;
    state.activitySig = sig;
    setText($('wa-activity-badge'), rows.length ? kit.tx('settings.redesign.whatsapp.activityRecent', { count: rows.length }) : '');
    $('wa-activity-list').innerHTML = rows.length ? rows.map((e) => `
      <div class="wa-act-row" data-kind="${attr(e.kind)}">
        <span class="wa-act-time">${esc(new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }))}</span>
        <span class="wa-act-kind">${esc(ACTIVITY_KINDS[e.kind] || e.kind)}</span>
        <span class="wa-act-detail">${esc(e.detail)}${e.text ? `<span class="wa-act-text">${esc(e.text)}</span>` : ''}</span>
      </div>`).join('') : '<div class="settings-hint">' + kit.te('settings.redesign.whatsapp.noActivityYet') + '</div>';
  }

  // ── Streams: link and claim (NDJSON on this tab's own request) ──
  async function readStream(path, body, onEvent) {
    const controller = new AbortController();
    state.controllers.add(controller);
    try {
      const res = await fetch(`${API}${path}`, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json', 'X-SynaBun-UI': '1' }, body: JSON.stringify(body || {}) });
      if (!res.ok || !/ndjson/.test(res.headers.get('content-type') || '')) return { controller, error: await readJson(res) };
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const pump = async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let i;
          while ((i = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, i).trim();
            buffer = buffer.slice(i + 1);
            if (!line) continue;
            let event;
            try { event = JSON.parse(line); } catch { continue; }
            if (!state.closed) onEvent(event);
          }
        }
      };
      return { controller, done: pump().catch(() => {}).finally(() => state.controllers.delete(controller)) };
    } catch (error) {
      state.controllers.delete(controller);
      return { controller, error: { ok: false, error: error?.name === 'AbortError' ? 'cancelled' : error?.message || kit.tx('settings.redesign.whatsapp.networkError') } };
    }
  }
  async function startLink(method, phone) {
    if (state.link) return;
    errorLine('');
    state.method = method;
    state.qrExpiresAt = null;
    state.codeExpiresAt = null;
    state.showChoose = false;
    $('wa-qr-img').hidden = true;
    show($('wa-qr-wait'), true);
    setText($('wa-pairing-code'), '········');
    const link = { method };
    state.link = link;
    apply({ ...(state.status || {}), state: 'linking', method, phase: 'starting' });
    const r = await readStream('/link', { method, ...(method === 'code' ? { phone } : {}) }, (event) => {
      if (event.type === 'qr' && event.svg) {
        const img = $('wa-qr-img');
        img.src = svgUri(event.svg);
        img.hidden = false;
        show($('wa-qr-wait'), false);
        state.qrExpiresAt = Number(event.expiresAt) || null;
      } else if (event.type === 'pairing_code' && event.code) {
        setText($('wa-pairing-code'), event.code);
        state.codeExpiresAt = Number(event.expiresAt) || null;
      } else if (event.type === 'error') {
        errorLine(event.message || kit.tx('settings.redesign.whatsapp.linkingFailed', { code: event.code || kit.tx('settings.redesign.whatsapp.error') }));
      }
      if (event.type !== 'qr' && event.type !== 'pairing_code') loadStatus();
      tickCountdowns();
    });
    if (r.error) {
      state.link = null;
      errorLine(r.error.error === 'cancelled' ? '' : r.error.error || kit.tx('settings.redesign.whatsapp.linkingFailed2'));
      loadStatus();
      return;
    }
    link.controller = r.controller;
    await r.done;
    if (state.link === link) state.link = null;
    state.qrExpiresAt = null;
    state.codeExpiresAt = null;
    loadStatus();
  }
  function cancelLink() {
    const link = state.link;
    state.link = null;
    try { link?.controller?.abort(); } catch {}
    setTimeout(loadStatus, 300);
  }
  async function startClaim() {
    if (state.claim) return;
    const claim = {};
    state.claim = claim;
    $('wa-claim-start').disabled = true;
    const r = await readStream('/owner/claim', {}, (event) => {
      if (event.type === 'claim') {
        if (event.code) setText($('wa-claim-code'), event.code);
        if (event.sendTo !== undefined) setText($('wa-claim-to'), event.sendTo ? kit.tx('settings.redesign.whatsapp.sendItFromYourOwnWhatsapp', { sendTo: event.sendTo }) : kit.tx('settings.redesign.whatsapp.sendItFromYourOwnWhatsapp2'));
        if (event.qrSvg) $('wa-claim-qr').src = svgUri(event.qrSvg);
        if (event.waMeUrl) $('wa-claim-open').href = event.waMeUrl;
        if (event.expiresAt) state.claimExpiresAt = Number(event.expiresAt);
        if (Number.isFinite(event.attemptsLeft)) setText($('wa-claim-tries'), kit.tx('settings.redesign.whatsapp.leftForAWrongCode', { attemptsLeft: event.attemptsLeft, attemptsLeft2: event.attemptsLeft === 1 ? kit.tx('settings.redesign.whatsapp.try') : kit.tx('settings.redesign.whatsapp.tries') }));
        show($('wa-claim-body'), true);
        show($('wa-claim-intro'), false);
      } else if (event.type === 'bound') {
        toast(kit.tx('settings.redesign.whatsapp.ownerConfirmedWhatsappIsReady', { masked: event.masked || '' }));
      } else if (event.type === 'expired') {
        errorLine(kit.tx('settings.redesign.whatsapp.theClaimCodeExpiredShowA'));
      }
      tickCountdowns();
    });
    if (r.error) { state.claim = null; $('wa-claim-start').disabled = false; errorLine(r.error.error || kit.tx('settings.redesign.whatsapp.couldNotStartTheClaim')); return; }
    claim.controller = r.controller;
    await r.done;
    if (state.claim === claim) state.claim = null;
    $('wa-claim-start').disabled = false;
    show($('wa-claim-body'), false);
    show($('wa-claim-intro'), true);
    state.claimExpiresAt = null;
    loadStatus();
  }

  // ── Actions ──
  async function doSetup() {
    errorLine('');
    const method = state.method;
    let phone;
    if (method === 'code') {
      const n = normalizePhone($('wa-phone').value);
      if (!n.ok) { errorLine(PHONE_ERRORS[n.code]); $('wa-phone').focus(); return; }
      phone = n.e164;
    }
    const r = await jsend('POST', '/setup', { mode: state.mode, method, ...(phone ? { phone } : {}) });
    if (r.ok === false) { errorLine(r.error); return; }
    if (r.next === 'install') { state.autoLink = { method, phone }; apply(r.status || state.status); return; }
    if (r.next === 'link') { startLink(method, phone); return; }
    apply(r.status || state.status);
  }
  async function post(path, body, success) {
    const r = await jsend('POST', path, body);
    if (r.ok === false) {
      if (r.status === 429) toast(kit.tx('settings.redesign.whatsapp.waitSBeforeSendingAnotherTest', { retryAfterMs: Math.ceil((r.retryAfterMs || 0) / 1000) }));
      else toast(r.error || kit.tx('settings.redesign.whatsapp.somethingWentWrong'));
      return r;
    }
    if (success) toast(success);
    if (r.status && typeof r.status === 'object') apply(r.status); else loadStatus();
    return r;
  }
  async function putConfig(patch, extra = {}) {
    const r = await jsend('PUT', '/config', { config: patch, expectedVersion: state.version, ...extra });
    if (r.ok === false) {
      if (r.code === 'VERSION_CONFLICT') { toast(kit.tx('settings.redesign.whatsapp.whatsappSettingsChangedElsewhereReloaded')); await loadStatus(); }
      else toast(r.error || kit.tx('settings.redesign.whatsapp.couldNotSave'));
      return r;
    }
    state.version = r.version ?? state.version;
    if (r.pending?.code) { state.escalation = { code: r.pending.code, expiresAt: r.pending.expiresAt, at: Date.now() }; renderAllowBox(); }
    loadStatus();
    return r;
  }
  const actions = {
    setup: doSetup,
    // A QR can be shown again at once; a phone-number code needs the number, so it goes back to the choice.
    relink: () => {
      if (state.method !== 'code') { startLink('qr'); return; }
      state.showChoose = true;
      apply(state.status);
    },
    'change-setup': () => { state.showChoose = true; apply(state.status); },
    'cancel-link': cancelLink,
    'cancel-install': () => jsend('DELETE', '/connector/install', {}).then(loadStatus),
    'retry-install': () => post('/connector/install', { reinstall: state.status?.connector?.installed === true }),
    'show-log': showLog,
    confirm: () => post('/owner/confirm', { accept: true }, kit.tx('settings.redesign.whatsapp.whatsappIsReadySayHelloFrom')),
    reject: () => { const b = $('wa-confirm-no'); if (!armed('reject', b, kit.tx('settings.redesign.whatsapp.notMeUnlink'), kit.tx('settings.redesign.whatsapp.clickAgainToUnlinkIt'))) return; post('/owner/confirm', { accept: false }, kit.tx('settings.redesign.whatsapp.unlinked')); },
    claim: startClaim,
    unlink: () => $('wa-unlink').click(),
    'open-conversation': openConversation,
    test: () => post('/test', {}, kit.tx('settings.redesign.whatsapp.testMessageSent')),
    resume: () => post('/resume', {}, kit.tx('settings.redesign.whatsapp.resumed')),
    reconnect: () => post('/reconnect', {}, kit.tx('settings.redesign.whatsapp.reconnecting')),
    'reset-owner': () => $('wa-reset-owner').click(),
  };
  async function showLog() {
    const r = await jget('/connector/log?limit=200');
    const pre = $('wa-install-log');
    pre.textContent = r.ok === false ? (r.error || kit.tx('settings.redesign.whatsapp.noLog')) : (r.lines || []).join('\n') || kit.tx('settings.redesign.whatsapp.theInstallLogIsEmpty');
    show(pre, true);
  }
  function openConversation() {
    const id = state.status?.session?.id;
    if (!id) { toast(kit.tx('settings.redesign.whatsapp.noWhatsappConversationYetSendA')); return; }
    overlay.querySelector('#stg-close')?.click();
    emit('assistant:resume', { sessionId: id });
  }
  $('wa-primary').addEventListener('click', () => { const fn = actions[$('wa-primary').dataset.action]; if (fn) fn(); });
  $('wa-pane-actions').addEventListener('click', (e) => { const b = e.target.closest('button[data-action]'); if (b && actions[b.dataset.action]) actions[b.dataset.action](); });

  // Setup inputs.
  for (const card of tabBody.querySelectorAll('.wa-mode-card')) card.addEventListener('click', () => { state.mode = card.dataset.mode; apply(state.status); });
  for (const radio of tabBody.querySelectorAll('input[name="wa-method"]')) radio.addEventListener('change', () => { if (radio.checked) { state.method = radio.value; errorLine(''); apply(state.status); } });
  $('wa-phone').addEventListener('input', () => {
    const value = $('wa-phone').value;
    const n = normalizePhone(value);
    setText($('wa-phone-preview'), !value.trim() ? PHONE_HINT : n.ok ? kit.tx('settings.redesign.whatsapp.willLink', { e164: n.e164 }) : PHONE_ERRORS[n.code]);
    $('wa-phone-preview').dataset.valid = String(n.ok);
  });
  $('wa-use-code').addEventListener('click', () => { cancelLink(); state.method = 'code'; for (const r of tabBody.querySelectorAll('input[name="wa-method"]')) r.checked = r.value === 'code'; state.showChoose = true; setTimeout(() => { state.showChoose = false; apply({ ...(state.status || {}), state: 'ready' }); $('wa-phone').focus(); }, 350); });
  $('wa-use-qr').addEventListener('click', () => { cancelLink(); state.method = 'qr'; for (const r of tabBody.querySelectorAll('input[name="wa-method"]')) r.checked = r.value === 'qr'; setTimeout(() => startLink('qr'), 350); });
  $('wa-install-cancel').addEventListener('click', () => actions['cancel-install']());
  $('wa-confirm-yes').addEventListener('click', actions.confirm);
  $('wa-confirm-no').addEventListener('click', actions.reject);
  $('wa-claim-start').addEventListener('click', startClaim);
  $('wa-test').addEventListener('click', actions.test);
  $('wa-connector-update').addEventListener('click', () => post('/connector/install', { update: true }, kit.tx('settings.redesign.whatsapp.updatingTheConnector')));
  $('wa-connector-log').addEventListener('click', showLog);
  $('wa-connector-remove').addEventListener('click', () => {
    if (!armed('connector', $('wa-connector-remove'), kit.tx('settings.redesign.whatsapp.removeConnector'), kit.tx('settings.redesign.whatsapp.clickAgainToRemove'))) return;
    jsend('DELETE', '/connector', {}).then((r) => { if (r.ok === false) toast(r.error); else toast(kit.tx('settings.redesign.whatsapp.connectorRemoved')); loadStatus(); });
  });

  // Conversation.
  $('wa-brain-model').addEventListener('click', (e) => { e.stopPropagation(); openBrainMenu(); });
  $('wa-brain-effort').addEventListener('click', (e) => { e.stopPropagation(); openEffortMenu(); });
  // The picker's names for the models (the status carries ids): render again once the catalog is in.
  loadModelCatalog().then(() => { if (!state.closed && state.status) renderBrain(state.status); }).catch(() => {});
  $('wa-open-conversation').addEventListener('click', openConversation);
  $('wa-new-session').addEventListener('click', async () => { const r = await jsend('POST', '/session/new', {}); if (r.ok === false) toast(r.error); else { toast(kit.tx('settings.redesign.whatsapp.freshConversationStarted')); loadStatus(); } });
  const radioSave = (name, field, cast = (v) => v) => { for (const r of tabBody.querySelectorAll(`input[name="${name}"]`)) r.addEventListener('change', () => { if (r.checked) putConfig({ [field]: cast(r.value) }); }); };
  radioSave('wa-progress', 'progress');
  radioSave('wa-max', 'maxMessages', Number);
  radioSave('wa-rotation', 'rotation');
  radioSave('wa-trigger', 'selfTrigger');
  $('wa-forward').addEventListener('change', () => putConfig({ forwardBackground: $('wa-forward').checked }));
  $('wa-label').addEventListener('input', renderLabelPreview);
  $('wa-label-save').addEventListener('click', () => putConfig({ replyLabel: $('wa-label').value.trim() || null }).then((r) => { if (r.ok !== false) toast(kit.tx('settings.redesign.whatsapp.replyLabelSaved')); }));

  // Safety.
  for (const card of tabBody.querySelectorAll('.wa-level-card')) card.addEventListener('click', () => {
    const level = card.dataset.level;
    const current = state.status?.level || 'ask';
    if (level === current && level !== 'autonomous') return;
    if (level === 'autonomous') {
      if (current === 'autonomous') return;
      if (!state.armed.autonomous) {
        state.armed.autonomous = true;
        clearTimeout(state.timers['arm-autonomous']);
        state.timers['arm-autonomous'] = setTimeout(() => { state.armed.autonomous = false; renderSafety(state.status); }, ARM_MS);
        renderSafety(state.status);
        return;
      }
      state.armed.autonomous = false;
      renderSafety(state.status);
      putConfig({ level: 'autonomous' }, { confirmEscalation: true });
      return;
    }
    putConfig({ level });
  });
  $('wa-strict').addEventListener('change', () => putConfig({ strictWorkerApprovals: $('wa-strict').checked }));
  $('wa-computer').addEventListener('change', () => putConfig({ computerUse: $('wa-computer').checked }));
  $('wa-pause').addEventListener('click', () => post('/pause', {}, kit.tx('settings.redesign.whatsapp.pausedSynabunIgnoresWhatsappUntilYou')));
  $('wa-reset-owner').addEventListener('click', () => {
    if (!armed('reset-owner', $('wa-reset-owner'), kit.tx('settings.redesign.whatsapp.resetTheOwner'), kit.tx('settings.redesign.whatsapp.clickAgainToReset'))) return;
    jsend('DELETE', '/owner', {}).then((r) => { if (r.ok === false) toast(r.error); else toast(kit.tx('settings.redesign.whatsapp.ownerResetConfirmTheOwnerAgain')); loadStatus(); });
  });

  // Data & privacy.
  $('wa-activity-text').addEventListener('change', () => putConfig({ activityText: $('wa-activity-text').checked }));
  $('wa-clear-log').addEventListener('click', () => {
    if (!armed('clear-log', $('wa-clear-log'), kit.tx('settings.redesign.whatsapp.clearLog'), kit.tx('settings.redesign.whatsapp.clickAgainToClear'))) return;
    jsend('DELETE', '/activity', {}).then((r) => { if (r.ok === false) toast(r.error); else { toast(kit.tx('settings.redesign.whatsapp.activityLogCleared')); state.activitySig = ''; refreshActivity(); } });
  });
  $('wa-unlink').addEventListener('click', () => {
    if (!armed('unlink', $('wa-unlink'), kit.tx('settings.redesign.whatsapp.unlink'), kit.tx('settings.redesign.whatsapp.clickAgainToUnlink'))) return;
    post('/unlink', {}).then((r) => { if (r.ok !== false) toast(r.loggedOut ? kit.tx('settings.redesign.whatsapp.unlinkedSynabunLoggedOutOfWhatsapp') : kit.tx('settings.redesign.whatsapp.unlinkedHereAlsoRemoveSynabunUnder')); });
  });
  $('wa-remove').addEventListener('click', () => {
    if (!armed('remove', $('wa-remove'), kit.tx('settings.redesign.whatsapp.removeWhatsappFromSynabun'), kit.tx('settings.redesign.whatsapp.clickAgainToRemoveEverything'))) return;
    post('/remove', { deleteConversation: $('wa-remove-conversation').checked }, kit.tx('settings.redesign.whatsapp.whatsappRemovedFromSynabun'));
  });

  // Simulated phone (fake transport only).
  const fake = async (action, extra = {}) => {
    const r = await jsend('POST', '/__fake', { action, ...extra });
    if (r.ok === false) { toast(r.error); return; }
    const sent = Array.isArray(r.sent) ? r.sent.slice(-10).reverse() : [];
    $('wa-fake-sent').innerHTML = sent.map((m) => `<div class="wa-act-row"><span class="wa-act-kind">${esc(m.kind)}</span><span class="wa-act-detail">${esc(m.text ?? m.react ?? '')}</span></div>`).join('');
    setTimeout(loadStatus, 300);
  };
  $('wa-fake-scan').addEventListener('click', () => fake('scan'));
  $('wa-fake-drop').addEventListener('click', () => fake('drop'));
  $('wa-fake-logout').addEventListener('click', () => fake('logout'));
  $('wa-fake-ban').addEventListener('click', () => fake('ban'));
  $('wa-fake-crash').addEventListener('click', () => fake('crash'));
  $('wa-fake-owner').addEventListener('click', () => fake('inbound', { from: 'owner', text: $('wa-fake-text').value }));
  $('wa-fake-stranger').addEventListener('click', () => fake('inbound', { from: 'stranger', text: $('wa-fake-text').value }));

  // ── Live updates: the sync broadcast (states only) triggers a masked re-read ──
  const offSync = on('sync:whatsapp:status', () => {
    if (state.closed || state.syncTimer) return;
    state.syncTimer = setTimeout(() => { state.syncTimer = null; if (alive()) loadStatus(); }, 200);
  });

  // ── Timers and teardown ──
  const every = (name, ms, fn) => { state.timers[name] = setInterval(() => { if (!alive()) return teardown(); fn(); }, ms); };
  function teardown() {
    if (state.closed) return;
    state.closed = true;
    for (const [name, id] of Object.entries(state.timers)) { clearInterval(id); clearTimeout(id); delete state.timers[name]; }
    clearTimeout(state.syncTimer);
    offSync();
    if (isMenuOpen($('wa-brain-model')) || isMenuOpen($('wa-brain-effort'))) closeMenu();
    for (const controller of state.controllers) { try { controller.abort(); } catch {} }
    state.controllers.clear();
    state.link = null;
    state.claim = null;
  }
  overlay.addEventListener('settings-close', teardown);
  every('status', STATUS_EVERY_MS, () => { if (tabActive() && !state.link) loadStatus(); });
  every('activity', ACTIVITY_EVERY_MS, () => { if (tabActive()) refreshActivity(); });
  every('tick', 500, () => { if (tabActive()) tickCountdowns(); });

  // ── Boot ──
  loadStatus();
  refreshActivity();
}
