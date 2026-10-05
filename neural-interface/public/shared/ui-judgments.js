// ═══════════════════════════════════════════
// UI-JUDGMENTS — Settings → Judgments (TypeSafe / Jev)
// ═══════════════════════════════════════════
//
// The settings home for every Jev judgment SynaBun makes: the API key and
// where it comes from, the operational kill switch, one row per judgment
// surface, cost and cache, the corpus backfill, the bench that gates
// "apply judged importance", the judgment log, misfiled memories and trash
// triage. Runtime knobs live server-side in kv_config (PUT /api/typesafe/config)
// so every process obeys them without a restart; only UI preferences (the
// log filters, telemetry window) go to storage.
//
// Contract with ui-settings.js: buildJudgmentsTab() returns a static shell
// (never blocks the panel opening); wireJudgmentsTab(overlay, deps) loads
// live data and binds handlers. The delegated collapsible and eye-toggle
// handlers in ui-settings.js bind to this markup once, so nothing below ever
// replaces an .iface-section wrapper or a static input — only inner
// containers are re-rendered.

import { escapeHtml, debounce } from './utils.js';
import { storage } from './storage.js';
import * as kit from './settings/settings-kit.js';

// Mirrors ui-settings.js (module-local there; duplicated to avoid an import cycle).
const CHEVRON_ICON = '<svg class="cc-section-chevron" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>';
const EYE_CLOSED = '<svg viewBox="0 0 24 24"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

const LOG_FILTER_KEY = 'synabun-judgments-log-filter';
const HOOK_BUDGET_MS = 1400; // judgeText() in the hooks aborts at 1500 ms
const TRIAGE_PAGE = 50; // rows per page; the whole ranking arrives in one answer
const TRIAGE_LIMIT = '2000'; // the service ceiling: every candidate found is judged and returned
// ── Coding sessions, log counters, limits (servers that attribute log rows to sessions) ──
const WINDOW_KEY = 'synabun-judgments-window'; // telemetry window: h24 | d7 | process
const SESSIONS_DAYS = 7;
const TIMELINE_LIMIT = 500;
const LEGACY_HOOK_SURFACES = ['prompt-urgency', 'agent-message', 'turn-worth', 'loop-goal', 'brief-rank']; // budget warning for servers that predate budgetMs
// The extra knobs some surfaces have. Their caption and help are settings.redesign.judgments.limit.<key>.{label,help}.
const LIMIT_FIELDS = [
  { key: 'minScore', min: 0, max: 4, step: 0.1, width: 58 },
  { key: 'maxItems', min: 1, max: 50, step: 1, width: 58 },
  { key: 'debounceMs', min: 0, max: 600000, step: 1000, width: 84 },
  { key: 'bashOnlyMinProbability', min: 0, max: 1, step: 0.05, width: 58 },
];
const RELEVANCE_NAMES = ['irrelevant', 'tangential', 'background', 'direct', 'decisive']; // the rerank / brief-rank rubric, 0–4: settings.redesign.judgments.relevance.<name>
const CHIP = 'display:inline-block;padding:0 6px;border:1px solid var(--s-medium);border-radius:9px;font-size:10.5px;font-family:monospace;color:var(--t-muted);font-weight:400';
const PRE = 'margin:0;white-space:pre-wrap;font-size:11px;max-height:160px;overflow:auto';
const LINK = 'color:var(--accent);text-decoration:underline dotted;text-underline-offset:2px;cursor:pointer';
/** A server new enough to attribute log rows to sessions and count from the log. Older ones get the per-process view. */
const serverV2 = (cfg) => Boolean(cfg && (Array.isArray(cfg.origins) || (cfg.logStats && typeof cfg.logStats === 'object')));
const fin = (v) => v != null && v !== '' && Number.isFinite(Number(v));
const shortId = (id) => String(id ?? '').slice(0, 8);
const memLink = (id) => (id == null || id === '') ? '' : `<a href="#" class="jv-entity" data-entity="${attr(id)}" title="${attr(id)}${kit.te('settings.redesign.judgments.showEveryJudgmentAboutThisMemory')}" style="${LINK};font-family:monospace">${escapeHtml(shortId(id))}</a>`;
const when = (iso) => fin(Date.parse(iso)) ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const day = (iso) => fin(Date.parse(iso)) ? new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
/** A Noul answer as logged ({type:'noul', noul}), or a bare number. */
const prob = (a) => { const v = a && typeof a === 'object' ? (a.noul ?? a.probability) : a; return fin(v) ? Number(v) : null; };

const attr = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const num = (n) => Number(n || 0).toLocaleString('en-US');
const money = (n) => (n == null || !Number.isFinite(Number(n))) ? '—' : `$${Number(n) < 0.01 && Number(n) > 0 ? Number(n).toFixed(4) : Number(n).toFixed(2)}`;
const pct = (n) => (n == null || !Number.isFinite(Number(n))) ? '—' : `${Math.round(Number(n) * 100)}%`;
const clock = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const stamp = (iso) => iso ? new Date(iso).toLocaleString() : kit.tx('settings.redesign.judgments.never');
const relevanceName = (score) => { const name = RELEVANCE_NAMES[Math.round(Number(score))]; return name ? kit.tx(`settings.redesign.judgments.relevance.${name}`) : ''; };
const duration = (ms) => { const s = Math.round(Number(ms || 0) / 1000); if (s < 90) return `${s}s`; const m = Math.round(s / 60); if (m < 120) return `${m} min`; return `${(m / 60).toFixed(1)} h`; };
const btnStyle = 'margin:0;width:auto;flex:0 0 auto;padding:4px 10px';
const inputStyle = 'flex:1;font-family:monospace;font-size:12px';
const smallInput = 'font-family:monospace;font-size:12px;width:72px;padding:3px 6px;background:var(--s-darker);color:var(--t-primary);border:1px solid var(--s-medium);border-radius:6px';
const boxStyle = 'display:none;margin-top:10px;padding:10px 12px;border-radius:8px;font-size:12px;line-height:1.5';
const okBg = 'rgba(76,175,80,0.12)', errBg = 'rgba(244,67,54,0.12)', warnBg = 'rgba(255,193,7,0.12)';

// ── Markup helpers ──


// Section id → its slug under settings.redesign.section.ai_decisions (title and one-line purpose).
const SECTION_SLUG = {
  'jv-sec-connection': 'decision_service', 'jv-sec-master': 'master_switch', 'jv-sec-sessions': 'coding_sessions',
  'jv-sec-surfaces': 'surfaces', 'jv-sec-telemetry': 'cost_telemetry', 'jv-sec-cache': 'answer_cache',
  'jv-sec-backfill': 'backfill', 'jv-sec-bench': 'bench', 'jv-sec-browser': 'browser_assistance',
  'jv-sec-desktop': 'desktop_assistance', 'jv-sec-log': 'judgment_log', 'jv-sec-misfiled': 'misfiled',
  'jv-sec-supersessions': 'superseded_by_jev', 'jv-sec-triage': 'trash_triage',
};
// Everyday sections; the rest carry the "Advanced" tag.
const EVERYDAY = new Set(['jv-sec-connection', 'jv-sec-master']);

/** One section card (settings-kit.js): an accordion; the shell opens the ones the user left open. */
function section({ id, title, badgeId, body }) {
  const slug = SECTION_SLUG[id];
  return kit.card({
    id,
    section: slug ? `ai_decisions.${slug}` : id,
    title: slug ? undefined : kit.esc(title),
    purpose: slug ? undefined : '',
    status: badgeId ? `<span id="${badgeId}"></span>` : '',
    body,
    advanced: !EVERYDAY.has(id),
  });
}
const toggle = (id, cls = '') => `<label class="recall-toggle"><input type="checkbox" id="${id}" class="${cls}"><span class="recall-toggle-track"></span></label>`;
const button = (id, label, extra = '') => `<button class="conn-add-btn" id="${id}" style="${btnStyle}" ${extra}>${label}</button>`;
const tile = (id, label) => `<div class="db-stat"><span class="db-stat-label">${label}</span><span class="db-stat-value" id="${id}">—</span></div>`;

// ── Shell ──

export function buildJudgmentsTab() {
  return `
    <div class="stg-pane" data-stg-pane="judgments">
      <div class="settings-status">
        <span class="settings-status-dot disconnected" id="jv-status-dot"></span>
        <span id="jv-status-line">${kit.te('settings.redesign.judgments.checkingTypesafe')}</span>
      </div>

      ${section({ id: 'jv-sec-connection', title: kit.tx('settings.redesign.judgments.connection'), badgeId: 'jv-key-source-badge', body: `
        <div class="settings-hint" style="margin-bottom:10px">${kit.te('settings.redesign.judgments.jevTypesafeSystemOneReturnsTyped')} <code>~/.synabun/.env</code> ${kit.te('settings.redesign.judgments.andNeverLeavesTheServerOnly')}</div>
        <div class="settings-field">
          <label for="jv-api-key">${kit.te('settings.redesign.judgments.apiKey')}</label>
          <div class="settings-key-row" style="display:flex;gap:6px">
            <input type="password" id="jv-api-key" value="" placeholder="${kit.te('settings.redesign.judgments.pasteATypesafeApiKey')}" autocomplete="off" spellcheck="false" style="${inputStyle}">
            <button class="conn-add-btn settings-toggle-vis" id="jv-key-eye" data-target="jv-api-key" style="margin:0;width:auto;flex:0 0 auto;padding:4px 8px" data-tooltip="${kit.te('settings.redesign.judgments.name.keyEye')}" aria-label="${kit.te('settings.redesign.judgments.name.keyEye')}">${EYE_CLOSED}</button>
            ${button('jv-key-save', kit.tx('settings.redesign.judgments.save'))}${button('jv-key-test', kit.tx('settings.redesign.judgments.test'))}${button('jv-key-clear', kit.tx('settings.redesign.judgments.clear'))}
          </div>
          <div class="settings-hint" id="jv-key-hint">${kit.te('settings.redesign.judgments.noKeyStored')}</div>
        </div>
        <div id="jv-key-warning" style="${boxStyle};background:${warnBg}"></div>
        <div class="settings-field">
          <label for="jv-base-url">${kit.te('settings.redesign.judgments.baseUrl')}</label>
          <div class="settings-key-row" style="display:flex;gap:6px">
            <input type="text" id="jv-base-url" value="" placeholder="https://api.typesafe.ai" autocomplete="off" spellcheck="false" style="${inputStyle}">
            ${button('jv-base-url-save', kit.tx('settings.redesign.judgments.save'))}
          </div>
          <div class="settings-hint" id="jv-base-url-hint">${kit.te('settings.redesign.judgments.blankDefaultAppliesImmediatelyA')} <code>TYPESAFE_BASE_URL</code> ${kit.te('settings.redesign.judgments.exportInTheServerSShell')}</div>
        </div>
        <div class="settings-field">
          <label for="jv-model">${kit.te('settings.redesign.judgments.model')}</label>
          <div class="settings-key-row" style="display:flex;gap:6px;align-items:center">
            <select id="jv-model" style="${smallInput};width:auto;min-width:160px"></select>
            <span class="settings-hint" style="margin:0">${kit.te('settings.redesign.judgments.aliasesMoveWhenTypesafeShipsA')}</span>
          </div>
        </div>
        <div id="jv-test-result" style="${boxStyle}"></div>
      ` })}

      ${kit.card({ id: 'jv-sec-master', section: 'ai_decisions.master_switch', body: `
        <div class="recall-control-header" style="margin-top:6px">
          <span class="recall-control-label">${kit.te('settings.redesign.judgments.jevJudgments')} <span id="jv-master-badge" style="font-size:11px;color:var(--t-muted);margin-left:8px"></span></span>
          ${toggle('jv-master-toggle')}
        </div>
        <div class="settings-hint" id="jv-master-hint">${kit.te('settings.redesign.judgments.operationalKillSwitchWhenOffEvery')} <code>/history|previous|old|antes|anterior/i</code>${kit.te('settings.redesign.judgments.rerankKeepsFusionOrderOnlyThe')} <code>SYNABUN_TYPESAFE=off</code> ${kit.te('settings.redesign.judgments.inTheServerSEnvironmentForces')}</div>` })}

      ${section({ id: 'jv-sec-sessions', title: kit.tx('settings.redesign.judgments.codingSessions'), badgeId: 'jv-sessions-badge', body: `
        <div class="settings-hint" style="margin-bottom:8px">${kit.th('settings.redesign.judgments.whatJevDecidedInsideEachClaude', { SESSIONS_DAYS: SESSIONS_DAYS })} <strong style="color:#ffc107">${kit.te('settings.redesign.judgments.amber')}</strong> ${kit.te('settings.redesign.judgments.marksAnAnswerThatCrossedIts')}</div>
        <div class="settings-key-row" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          ${button('jv-sessions-refresh', kit.tx('settings.redesign.judgments.refresh'))}
          <span class="settings-hint" id="jv-sessions-status" style="margin:0"></span>
        </div>
        <div id="jv-sessions-list" style="display:flex;flex-direction:column;gap:6px;margin-top:8px"></div>
      ` })}

      ${section({ id: 'jv-sec-surfaces', title: kit.tx('settings.redesign.judgments.surfaces'), badgeId: 'jv-surfaces-badge', body: `
        <div class="settings-hint" id="jv-surfaces-hint" style="margin-bottom:8px">${kit.th('settings.redesign.judgments.oneRowPerJudgmentTurningA', { HOOK_BUDGET_MS: HOOK_BUDGET_MS })}</div>
        <div class="stg-mcp-matrix-scroll">
          <table class="cc-cheatsheet-table" id="jv-surfaces-table" style="width:100%">
            <thead><tr><th>${kit.te('settings.redesign.judgments.on')}</th><th>${kit.te('settings.redesign.judgments.surface')}</th><th>${kit.te('settings.redesign.judgments.timeoutMs')}</th><th title="${kit.te('settings.redesign.judgments.minimumChoiceScoreConfidence')}">${kit.te('settings.redesign.judgments.threshold')}</th><th title="${kit.te('settings.redesign.judgments.minimumNoulProbabilityOnSurfacesThat')}">${kit.te('settings.redesign.judgments.probability')}</th><th id="jv-sf-h-calls">${kit.te('settings.redesign.judgments.calls')}</th><th id="jv-sf-h-avg">${kit.te('settings.redesign.judgments.avgMs')}</th><th id="jv-sf-h-fail">${kit.te('settings.redesign.judgments.fail')}</th><th id="jv-sf-h-skipped">${kit.te('settings.redesign.judgments.skipped')}</th></tr></thead>
            <tbody id="jv-surfaces-body"></tbody>
          </table>
        </div>
        <div class="settings-hint" id="jv-surfaces-status" style="margin-top:6px"></div>
      ` })}

      ${section({ id: 'jv-sec-telemetry', title: 'Cost & telemetry', badgeId: 'jv-telemetry-badge', body: `
        <div class="settings-key-row" id="jv-st-window-row" style="display:none;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
          <span class="settings-hint" style="margin:0">${kit.te('settings.redesign.judgments.figuresFor')}</span>
          <select id="jv-st-window" style="${smallInput};width:auto"><option value="h24">${kit.te('settings.redesign.judgments.theLast24HLog')}</option><option value="d7">${kit.te('settings.redesign.judgments.theLast7DLog')}</option><option value="process">${kit.te('settings.redesign.judgments.thisProcess')}</option></select>
          <span class="settings-hint" id="jv-st-window-hint" style="margin:0"></span>
        </div>
        <div class="db-stats-row" style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">
          ${tile('jv-st-calls', kit.tx('settings.redesign.judgments.calls'))}${tile('jv-st-hits', kit.tx('settings.redesign.judgments.answered'))}${tile('jv-st-failures', kit.tx('settings.redesign.judgments.failed2'))}${tile('jv-st-cached', kit.tx('settings.redesign.judgments.fromCache'))}
          ${tile('jv-st-in', kit.tx('settings.redesign.judgments.tokensIn'))}${tile('jv-st-out', kit.tx('settings.redesign.judgments.tokensOut'))}${tile('jv-st-avg', kit.tx('settings.redesign.judgments.avgMs'))}${tile('jv-st-cost', kit.tx('settings.redesign.judgments.estSpend'))}
        </div>
        <div class="settings-hint" id="jv-st-lasterror" style="margin-top:8px"></div>
        <div class="settings-key-row" style="display:flex;gap:6px;align-items:center;margin-top:10px;flex-wrap:wrap">
          <span class="settings-hint" style="margin:0">${kit.te('settings.redesign.judgments.pricePerMillionIn')}</span>
          <input type="number" id="jv-rate-in" min="0" step="0.001" style="${smallInput}">
          <span class="settings-hint" style="margin:0">${kit.te('settings.redesign.judgments.out')}</span>
          <input type="number" id="jv-rate-out" min="0" step="0.001" style="${smallInput}">
          ${button('jv-rates-save', kit.tx('settings.redesign.judgments.saveRates'))}
          ${button('jv-metrics-reset', kit.tx('settings.redesign.judgments.resetCounters'))}
        </div>
        <div class="settings-hint" style="margin-top:6px">${kit.te('settings.redesign.judgments.typesafeListsJev1130')}</div>
      ` })}

      ${kit.card({ id: 'jv-sec-cache', section: 'ai_decisions.answer_cache', body: `
        <div class="settings-key-row" style="display:flex;gap:12px;align-items:center;margin-top:6px">
          <span class="settings-hint" style="margin:0">${kit.te('settings.redesign.judgments.entries')} <strong id="jv-cache-size">—</strong> ${kit.te('settings.redesign.judgments.hitRatio')} <strong id="jv-cache-ratio">—</strong></span>
          ${button('jv-cache-clear', kit.tx('settings.redesign.judgments.clearCache'))}
        </div>
        <div class="settings-hint">${kit.te('settings.redesign.judgments.identicalStateQuestionsModelReuseThe')}</div>` })}

      ${section({ id: 'jv-sec-backfill', title: kit.tx('settings.redesign.judgments.backfill2'), badgeId: 'jv-backfill-badge', body: `
        <div class="settings-hint" id="jv-coverage" style="margin-bottom:6px">${kit.te('settings.redesign.judgments.coverage')}</div>
        <div class="db-reindex-bar-track"><div id="jv-coverage-bar" class="db-reindex-bar" style="width:0%"></div></div>
        <div class="settings-hint" style="margin:10px 0 8px">${kit.te('settings.redesign.judgments.memoriesIndexedBeforeJudgmentsExistedNev')}</div>
        <div class="settings-key-row" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <input type="text" id="jv-bf-project" placeholder="${kit.te('settings.redesign.judgments.allProjects')}" autocomplete="off" spellcheck="false" style="${smallInput};width:150px">
          <input type="number" id="jv-bf-limit" placeholder="${kit.te('settings.redesign.judgments.allRows')}" min="1" style="${smallInput};width:110px">
          ${button('jv-bf-estimate', kit.tx('settings.redesign.judgments.estimate'))}${button('jv-bf-start', kit.tx('settings.redesign.judgments.start'), 'disabled')}${button('jv-bf-pause', kit.tx('settings.redesign.judgments.pause'), 'disabled')}${button('jv-bf-resume', kit.tx('settings.redesign.judgments.resume'), 'disabled')}${button('jv-bf-cancel', kit.tx('settings.redesign.judgments.cancel'), 'disabled')}
        </div>
        <div id="jv-bf-estimate-box" style="${boxStyle};background:var(--s-darker)"></div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:12px">
          <div class="wiz-status-dot" id="jv-bf-dot"></div>
          <span id="jv-bf-text" style="font-size:12px">${kit.te('settings.redesign.judgments.idle')}</span>
        </div>
        <div class="db-reindex-bar-track" style="margin-top:6px"><div id="jv-bf-bar" class="db-reindex-bar" style="width:0%"></div></div>
        <div class="settings-hint" id="jv-bf-summary" style="margin-top:6px"></div>
        <div class="settings-hint" id="jv-bf-error" style="color:#f66"></div>
        <div id="jv-bf-report" style="${boxStyle};background:var(--s-darker)"></div>
      ` })}

      ${section({ id: 'jv-sec-bench', title: kit.tx('settings.redesign.judgments.bench2'), badgeId: 'jv-bench-badge', body: `
        <div class="settings-hint" style="margin-bottom:8px">${kit.te('settings.redesign.judgments.replaysStoredMemoriesThroughBothThe')} <code>benchmarks/typesafe-&lt;surface&gt;-&lt;date&gt;.json</code>${kit.te('settings.redesign.judgments.sameCodeAs')} <code>node mcp-server/scripts/bench-typesafe.mjs</code>.</div>
        <div class="settings-key-row" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <select id="jv-bench-surface" style="${smallInput};width:auto"><option value="importance">${kit.te('settings.redesign.judgments.importance')}</option><option value="kind">${kit.te('settings.redesign.judgments.kind')}</option><option value="relation">${kit.te('settings.redesign.judgments.relation')}</option><option value="historical">${kit.te('settings.redesign.judgments.historical')}</option><option value="browser">${kit.te('settings.redesign.judgments.browserFixtures')}</option><option value="desktop">${kit.te('settings.redesign.judgments.desktopFixtures')}</option></select>
          <input type="number" id="jv-bench-limit" value="50" min="1" max="200" style="${smallInput};width:80px">
          <input type="text" id="jv-bench-project" placeholder="${kit.te('settings.redesign.judgments.allProjects')}" autocomplete="off" spellcheck="false" style="${smallInput};width:150px">
          ${button('jv-bench-run', kit.tx('settings.redesign.judgments.runBench'))}
          <span id="jv-bench-spinner" style="display:none"><div class="wiz-status-dot spin" style="display:inline-block"></div></span>
        </div>
        <div class="settings-hint" id="jv-bench-last" style="margin-top:6px">${kit.te('settings.redesign.judgments.lastBenchNever')}</div>
        <div id="jv-bench-result" style="${boxStyle};background:var(--s-darker)">
          <div id="jv-bench-summary"></div>
          <div class="stg-mcp-matrix-scroll" style="margin-top:8px"><table class="cc-cheatsheet-table" id="jv-bench-table" style="width:100%"></table></div>
        </div>
        <div class="recall-control-header" style="margin-top:14px">
          <span class="recall-control-label">${kit.te('settings.redesign.judgments.applyJudgedImportanceToMemories')}</span>
          ${toggle('jv-apply-importance')}
        </div>
        <div class="settings-hint" id="jv-apply-hint">${kit.te('settings.redesign.judgments.offByDefaultMaintenanceRecordsJev')} <code>memories.importance</code> ${kit.te('settings.redesign.judgments.untilThisIsOnLockedUntil')}</div>
      ` })}

      ${section({ id: 'jv-sec-browser', title: kit.tx('settings.redesign.judgments.browserAssistance'), badgeId: 'jv-browser-badge', body: `
        <div class="settings-hint" style="margin-bottom:8px">${kit.te('settings.redesign.judgments.jevAdvisesTheBrowserToolsIt')} <code>browser_navigate</code> ${kit.te('settings.redesign.judgments.itSaysWhetherThePageIs')} <code>intent</code> ${kit.te('settings.redesign.judgments.orAFailedSelectorS')} <code>textHint</code> ${kit.te('settings.redesign.judgments.itRanksTheVisibleControlsAnd')}</div>
        <div id="jv-ba-mode" style="${boxStyle}"></div>
        <div class="settings-hint" id="jv-ba-bench" style="margin-top:6px"></div>
        <div class="settings-hint" id="jv-ba-reasons" style="margin-top:4px;color:#ffc107"></div>
        <div id="jv-ba-counters" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px"></div>
        <div class="settings-hint" style="margin-top:4px">${kit.te('settings.redesign.judgments.countersBelongToThisServerProcess')}</div>
        <div class="recall-control-header" style="margin-top:14px">
          <span class="recall-control-label">${kit.te('settings.redesign.judgments.enableSafeAutoHeal')}</span>
          ${toggle('jv-ba-autoheal')}
        </div>
        <div class="settings-hint" id="jv-ba-hint">${kit.te('settings.redesign.judgments.offByDefaultWhenOnA')} <code>browser_click</code> ${kit.te('settings.redesign.judgments.whoseSelectorMatchedNothingMayBe')} <strong>${kit.te('settings.redesign.judgments.once')}</strong>${kit.te('settings.redesign.judgments.onAPlainSameOriginNavigation')} <em>${kit.te('settings.redesign.judgments.browser')}</em> ${kit.te('settings.redesign.judgments.benchHasPassedForExactlyThis')} <code>jev-latest</code>${kit.te('settings.redesign.judgments.these')} <code>browser-target</code> ${kit.te('settings.redesign.judgments.thresholdsThisWordingTheseRiskRules')}</div>
        <details style="margin-top:10px">
          <summary style="cursor:pointer;font-size:12px">${kit.te('settings.redesign.judgments.whatMayBeSentToTypesafe')}</summary>
          <div class="settings-hint" style="margin-top:6px"><strong>${kit.te('settings.redesign.judgments.mayBeSent')}</strong>${kit.te('settings.redesign.judgments.fromAnyPageYouBrowseHere')}</div>
          <div class="settings-hint" style="margin-top:6px"><strong>${kit.te('settings.redesign.judgments.neverSent')}</strong>${kit.te('settings.redesign.judgments.anythingTypedIntoAFieldA')} <code>[input]</code>${kit.te('settings.redesign.judgments.hiddenDomQueryStringsAndFragments')}</div>
        </details>
        <div class="settings-hint" style="margin-top:8px;color:#ffc107">${kit.te('settings.redesign.judgments.alwaysAdvisoryWhateverThisSwitchSays')} <code>browser_batch</code>${kit.te('settings.redesign.judgments.andAnyPageWithAControl')}</div>
      ` })}

      ${section({ id: 'jv-sec-desktop', title: kit.tx('settings.redesign.judgments.desktopAssistance'), badgeId: 'jv-desktop-badge', body: `
        <div class="settings-hint" style="margin-bottom:8px">${kit.te('settings.redesign.judgments.jevAdvisesComputerUseItNever')} <code>computer_ax</code> <code>intent</code>${kit.te('settings.redesign.judgments.itRanksTheControlsOfThe')} <code>desktop-target</code> ${kit.te('settings.redesign.judgments.surfaceAboveCanBeSwitchedOff')}</div>
        <div id="jv-da-mode" style="${boxStyle}"></div>
        <div class="settings-hint" id="jv-da-bench" style="margin-top:6px"></div>
        <div class="settings-hint" id="jv-da-reasons" style="margin-top:4px;color:#ffc107"></div>
        <div id="jv-da-counters" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px"></div>
        <div class="settings-hint" style="margin-top:4px">${kit.te('settings.redesign.judgments.countersBelongToThisServerProcess')}</div>
        <div class="recall-control-header" style="margin-top:14px">
          <span class="recall-control-label">${kit.te('settings.redesign.judgments.enablePressByIntent')}</span>
          ${toggle('jv-da-press')}
        </div>
        <div class="settings-hint" id="jv-da-hint">${kit.te('settings.redesign.judgments.offByDefaultWhenOn')} <code>computer_ax</code> ${kit.te('settings.redesign.judgments.action')} <code>press</code> ${kit.te('settings.redesign.judgments.withAn')} <code>intent</code> ${kit.te('settings.redesign.judgments.andNo')} <code>ref</code> ${kit.te('settings.redesign.judgments.mayPress')} <strong>${kit.te('settings.redesign.judgments.once')}</strong>${kit.te('settings.redesign.judgments.aPlainEnabledButtonLinkTab')} <em>${kit.te('settings.redesign.judgments.desktop')}</em> ${kit.te('settings.redesign.judgments.benchHasPassedForExactlyThis')} <code>jev-latest</code>${kit.te('settings.redesign.judgments.these')} <code>desktop-target</code> ${kit.te('settings.redesign.judgments.thresholdsThisWordingTheSharedAnd')}</div>
        <details style="margin-top:10px">
          <summary style="cursor:pointer;font-size:12px">${kit.te('settings.redesign.judgments.whatMayBeSentToTypesafe')}</summary>
          <div class="settings-hint" style="margin-top:6px"><strong>${kit.te('settings.redesign.judgments.mayBeSent')}</strong>${kit.te('settings.redesign.judgments.fromWhicheverAppIsInFront')}</div>
          <div class="settings-hint" style="margin-top:6px"><strong>${kit.te('settings.redesign.judgments.neverSent')}</strong>${kit.te('settings.redesign.judgments.fieldValuesOrAnythingTypedWindow')}</div>
        </details>
        <div class="settings-hint" style="margin-top:8px;color:#ffc107">${kit.te('settings.redesign.judgments.alwaysAdvisoryWhateverThisSwitchSays2')}</div>
      ` })}

      ${section({ id: 'jv-sec-log', title: kit.tx('settings.redesign.judgments.judgmentLog'), badgeId: 'jv-log-badge', body: `
        <div class="settings-key-row" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <select id="jv-log-surface" style="${smallInput};width:auto"><option value="">${kit.te('settings.redesign.judgments.allSurfaces')}</option></select>
          <select id="jv-log-origin" style="${smallInput};width:auto"><option value="">${kit.te('settings.redesign.judgments.allOrigins')}</option><option value="live">${kit.te('settings.redesign.judgments.live')}</option><option value="backfill">${kit.te('settings.redesign.judgments.backfill')}</option><option value="bench">${kit.te('settings.redesign.judgments.bench')}</option></select>
          <input type="text" id="jv-log-session" placeholder="${kit.te('settings.redesign.judgments.sessionId')}" title="${kit.te('settings.redesign.judgments.rowsFromOneClaudeCodeSession')}" autocomplete="off" spellcheck="false" style="${smallInput};width:110px;display:none">
          <input type="text" id="jv-log-entity" placeholder="${kit.te('settings.redesign.judgments.memoryId')}" title="${kit.te('settings.redesign.judgments.rowsAboutOneMemory')}" autocomplete="off" spellcheck="false" style="${smallInput};width:110px">
          <input type="text" id="jv-log-project" placeholder="${kit.te('settings.redesign.judgments.project')}" title="${kit.te('settings.redesign.judgments.rowsFromOneProject')}" autocomplete="off" spellcheck="false" style="${smallInput};width:100px;display:none">
          <select id="jv-log-limit" style="${smallInput};width:auto"><option>25</option><option selected>50</option><option>100</option><option>200</option></select>
          ${button('jv-log-refresh', kit.tx('settings.redesign.judgments.refresh'))}
          <span class="settings-hint" id="jv-log-status" style="margin:0"></span>
        </div>
        <div class="settings-hint" style="margin:6px 0">${kit.te('settings.redesign.judgments.whenSomeoneAsksWhyDidIt')}</div>
        <div id="jv-log-list" style="display:flex;flex-direction:column;gap:4px"></div>
      ` })}

      ${section({ id: 'jv-sec-misfiled', title: kit.tx('settings.redesign.judgments.misfiled'), badgeId: 'jv-misfiled-badge', body: `
        <div class="settings-hint" style="margin-bottom:8px">${kit.te('settings.redesign.judgments.atEvery')} <code>remember</code>${kit.te('settings.redesign.judgments.jevJudgesWhichCategoryFitsThe')}</div>
        <div id="jv-misfiled-list" style="display:flex;flex-direction:column;gap:6px"></div>
      ` })}

      ${section({ id: 'jv-sec-supersessions', title: kit.tx('settings.redesign.judgments.supersededByJev'), badgeId: 'jv-supersessions-badge', body: `
        <div class="settings-hint" style="margin-bottom:8px">${kit.te('settings.redesign.judgments.whenJevJudgesANewMemory')} <code>supersedes</code> ${kit.te('settings.redesign.judgments.relationTheOlderMemoryLeavesCurrent')}</div>
        <div class="settings-hint" id="jv-supersessions-status" style="margin:0 0 6px"></div>
        <div id="jv-supersessions-list" style="display:flex;flex-direction:column;gap:6px"></div>
      ` })}

      ${section({ id: 'jv-sec-triage', title: kit.tx('settings.redesign.judgments.trashTriage'), badgeId: 'jv-triage-badge', body: `
        <div class="settings-hint" style="margin-bottom:8px">${kit.te('settings.redesign.judgments.forgetCandidatesDuplicatesOldLowImportan')}</div>
        <div class="settings-key-row" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <input type="text" id="jv-triage-project" placeholder="${kit.te('settings.redesign.judgments.allProjects')}" autocomplete="off" spellcheck="false" style="${smallInput};width:150px">
          ${button('jv-triage-run', kit.tx('settings.redesign.judgments.findCandidates'))}
          <span id="jv-triage-spinner" style="display:none"><div class="wiz-status-dot spin" style="display:inline-block"></div></span>
          <span class="settings-hint" id="jv-triage-status" style="margin:0"></span>
        </div>
        <div class="settings-key-row" id="jv-triage-bulk" style="display:none;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px">
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer"><input type="checkbox" id="jv-triage-all"> ${kit.te('settings.redesign.judgments.selectAllShown')}</label>
          ${button('jv-triage-trash-selected', kit.tx('settings.redesign.judgments.move0ToTrash'), 'disabled')}
        </div>
        <div id="jv-triage-list" style="display:flex;flex-direction:column;gap:6px;margin-top:8px"></div>
        <div id="jv-triage-more-wrap" style="display:none;margin-top:8px">${button('jv-triage-more', kit.tx('settings.redesign.judgments.showMore'))}</div>
      ` })}
    </div>`;
}

// ── Wiring ──

export function wireJudgmentsTab(overlay, { toast = () => {}, initial = null } = {}) {
  const $ = (id) => overlay.querySelector('#' + id);
  // Names for the controls whose only caption is a placeholder or a neighbouring word (screen readers, voice control).
  const CONTROL_NAMES = {
    'jv-st-window': 'window', 'jv-rate-in': 'rateIn', 'jv-rate-out': 'rateOut', 'jv-bf-project': 'bfProject', 'jv-bf-limit': 'bfLimit',
    'jv-bench-surface': 'benchSurface', 'jv-bench-limit': 'benchLimit', 'jv-bench-project': 'benchProject', 'jv-log-surface': 'logSurface',
    'jv-log-origin': 'logOrigin', 'jv-log-session': 'logSession', 'jv-log-entity': 'logEntity', 'jv-log-project': 'logProject',
    'jv-log-limit': 'logLimit', 'jv-triage-project': 'triageProject',
    'jv-master-toggle': 'masterToggle', 'jv-apply-importance': 'applyImportance', 'jv-ba-autoheal': 'baAutoheal', 'jv-da-press': 'daPress',
  };
  for (const [id, name] of Object.entries(CONTROL_NAMES)) $(id)?.setAttribute('aria-label', kit.tx(`settings.redesign.judgments.name.${name}`));
  if (!$('jv-status-dot')) return;
  const tabBody = kit.paneOf(overlay, 'judgments');
  const alive = () => document.body.contains(overlay);
  const tabActive = () => alive() && kit.paneActive(overlay, 'judgments');

  const readJson = async (res) => {
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { ok: false, error: text.slice(0, 120) || `HTTP ${res.status}` }; }
    if (!res.ok && json.ok !== false) json = { ok: false, error: json.error || `HTTP ${res.status}`, status: res.status };
    if (json.status === undefined) json.status = res.status;
    return json;
  };
  const request = async (method, url, body) => {
    try {
      const res = await fetch(url, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return await readJson(res);
    } catch (error) { return { ok: false, error: error?.message || kit.tx('settings.redesign.judgments.networkError'), status: 0 }; }
  };
  const jget = (url) => request('GET', url);
  const jput = (url, body) => request('PUT', url, body);
  const jpost = (url, body) => request('POST', url, body ?? {});

  const state = { cfg: null, backfill: null, openLogIds: new Set(), lastLogSignature: '', timers: {}, armed: {}, triageAbort: null, triageTrashed: new Set(), triageSelected: new Set(), triageLast: null, triagePage: 1 };
  Object.assign(state, {
    sessions: new Map(), sessionsSignature: '', sessionsBooted: false, sessionsUnsupported: false,
    openSessions: new Set(), openTimelineIds: new Set(), timelineHtml: new Map(), timelineKeys: new Map(), timelineLoading: new Set(),
    supersessionsBooted: false, supersessionsUnsupported: false,
  });
  // Shown once the config says the server has them (an older server has neither endpoint).
  $('jv-sec-sessions').style.display = 'none';
  $('jv-sec-supersessions').style.display = 'none';
  { const saved = storage.getItem(WINDOW_KEY); if (['h24', 'd7', 'process'].includes(saved)) $('jv-st-window').value = saved; }

  // Which sections are open is the shell's (settings-shell.js: applyStoredSections / storeSectionState).
  // Sections that load on demand refresh whenever they get expanded — by a click, a deep link's `expand`, or a restore.
  const onExpand = { 'jv-sec-log': () => refreshLog(true), 'jv-sec-misfiled': () => refreshMisfiled(), 'jv-sec-sessions': () => refreshSessions(true), 'jv-sec-supersessions': () => refreshSupersessions() };
  const expandObserver = new MutationObserver((records) => {
    for (const r of records) {
      const el = r.target;
      if (el.classList.contains('collapsed') || !onExpand[el.id]) continue;
      onExpand[el.id]();
    }
  });
  for (const id of Object.keys(onExpand)) { const el = $(id); if (el) expandObserver.observe(el, { attributes: true, attributeFilter: ['class'] }); }

  // ── Focus-safe input sync ──
  const setValue = (el, value) => { if (!el || document.activeElement === el) return; const v = value == null ? '' : String(value); if (el.value !== v) el.value = v; };
  const setChecked = (el, on) => { if (!el || document.activeElement === el) return; if (el.checked !== Boolean(on)) el.checked = Boolean(on); };
  const setText = (el, text) => { if (el && el.textContent !== String(text)) el.textContent = String(text); };
  const show = (el, html, bg) => { if (!el) return; el.style.display = html ? 'block' : 'none'; el.innerHTML = html || ''; if (bg) el.style.background = bg; };

  // ── Renderers ──
  function setHeader(cfg) {
    const dot = $('jv-status-dot'), line = $('jv-status-line');
    if (!cfg || cfg.ok === false) {
      dot.className = 'settings-status-dot disconnected';
      line.textContent = cfg?.status === 404 ? kit.tx('settings.redesign.judgments.typesafeSettingsUnavailableTheServerIs') : kit.tx('settings.redesign.judgments.typesafeSettingsUnavailable', { error: cfg?.error || kit.tx('settings.redesign.judgments.noResponse') });
      setNavStatus('disconnected');
      return;
    }
    const on = cfg.enabled;
    dot.className = `settings-status-dot ${on ? 'connected' : 'disconnected'}`;
    const s = cfg.stats || {};
    const w = statsWindow(cfg);
    line.textContent = on
      ? w.key !== 'process' ? kit.tx('settings.redesign.judgments.connectedCallsFailedInAvgMs', { model: cfg.model, num: num(w.s.calls), num2: num(w.s.failures), label: w.label, num3: num(w.s.avgMs) })
      : kit.tx('settings.redesign.judgments.connectedAnsweredFailedThisProcessAvg', { model: cfg.model, num: num(s.hits), num2: num(s.failures), num3: num(s.avgMs) })
      : cfg.killSwitch ? kit.tx('settings.redesign.judgments.offSynabunTypesafeOffIsSet')
      : !cfg.masterEnabled ? kit.tx('settings.redesign.judgments.offMasterSwitchIsOff')
      : !cfg.hasKey ? kit.tx('settings.redesign.judgments.noApiKeyPasteOneBelow') : kit.tx('settings.redesign.judgments.off');
    setNavStatus(on ? 'connected' : 'disconnected');
  }
  function setNavStatus(status) {
    kit.setNavStatus(overlay, 'judgments', status);
  }
  function renderConnection(cfg) {
    const badge = $('jv-key-source-badge');
    const sourceLabel = cfg.keySource === 'env' ? kit.tx('settings.redesign.judgments.shellEnv') : cfg.keySource === 'dotenv' ? '.env' : 'none';
    setText(badge, cfg.hasKey ? `${cfg.maskedKey} · ${sourceLabel}` : kit.tx('settings.redesign.judgments.noKey'));
    badge.style.color = cfg.shadowed ? '#ffc107' : cfg.hasKey ? 'var(--accent)' : 'var(--t-muted)';
    const input = $('jv-api-key');
    input.dataset.mask = cfg.maskedKey || '';
    input.placeholder = cfg.hasKey ? kit.tx('settings.redesign.judgments.storedPasteToReplace', { maskedKey: cfg.maskedKey }) : kit.tx('settings.redesign.judgments.pasteATypesafeApiKey');
    setText($('jv-key-hint'), cfg.hasKey ? kit.tx('settings.redesign.judgments.keyStored', { key: cfg.maskedKey, source: sourceLabel, note: cfg.keySource === 'env' && !cfg.shadowed ? (" " + kit.tx('settings.redesign.judgments.theEnvCopyMatches')) : '' }) : kit.tx('settings.redesign.judgments.noKeyStoredTypesafeKeysAre'));
    let warning = '';
    if (cfg.shadowed) warning = `<strong>${kit.te('settings.redesign.judgments.aShellExportIsOverridingThe')}</strong> ${kit.te('settings.redesign.judgments.theServerWasLaunchedFromA')} <code>TYPESAFE_API_KEY</code>${kit.te('settings.redesign.judgments.soTheKeyIn')} <code>~/.synabun/.env</code> ${kit.th('settings.redesign.judgments.onDiskIsIgnoredSavingHere', { maskedKey: escapeHtml(String(cfg.maskedKey || '')) })}`;
    else if (cfg.launchShellExport && cfg.keySource === 'env') warning = `${kit.te('settings.redesign.judgments.thisServerWasLaunchedWith')} <code>TYPESAFE_API_KEY</code> ${kit.te('settings.redesign.judgments.exportedInItsShellAndThere')} <code>~/.synabun/.env</code>${kit.te('settings.redesign.judgments.saveTheKeyHereSoA')}`;
    else if (cfg.launchShellExport && cfg.hasKey) warning = `${kit.te('settings.redesign.judgments.noteThisServerWasLaunchedWith')} <code>TYPESAFE_API_KEY</code> ${kit.te('settings.redesign.judgments.exportedInItsShellAfterA')}`;
    show($('jv-key-warning'), warning, warnBg);
    const baseInput = $('jv-base-url');
    setValue(baseInput, cfg.configuredBaseUrl || '');
    baseInput.placeholder = cfg.baseUrlDefault || 'https://api.typesafe.ai';
    setText($('jv-base-url-hint'), cfg.baseUrlSource === 'env'
      ? kit.tx('settings.redesign.judgments.usingFromTheServerSTypesafe', { baseUrl: cfg.baseUrl, baseUrlShadowed: cfg.baseUrlShadowed ? (" " + kit.tx('settings.redesign.judgments.itOverridesTheValueSavedHere')) : '' })
      : kit.tx('settings.redesign.judgments.usingBlankDefaultAppliesImmediately', { baseUrl: cfg.baseUrl, baseUrlSource: cfg.baseUrlSource }));
    const model = $('jv-model');
    if (document.activeElement !== model) {
      const models = Array.isArray(cfg.models) ? cfg.models : ['jev-latest'];
      const want = models.map(m => `<option value="${attr(m)}"${m === cfg.model ? ' selected' : ''}>${escapeHtml(m)}</option>`).join('');
      if (model.innerHTML !== want) model.innerHTML = want;
      model.value = cfg.model;
    }
  }
  function renderMaster(cfg) {
    const t = $('jv-master-toggle');
    setChecked(t, cfg.masterEnabled);
    t.disabled = Boolean(cfg.killSwitch);
    setText($('jv-master-badge'), cfg.killSwitch ? kit.tx('settings.redesign.judgments.forcedOffBySynabunTypesafeOff') : cfg.masterEnabled ? (cfg.hasKey ? kit.tx('settings.redesign.judgments.stateOn') : kit.tx('settings.redesign.judgments.onButNoKey')) : kit.tx('settings.redesign.judgments.offAllSurfacesUseTheirFallbacks'));
  }
  function surfaceRow(name, s, all = {}) {
    const threshold = s.minConfidence != null
      ? `<input type="number" class="jv-sf-threshold" aria-label="${attr(kit.tx('settings.redesign.judgments.name.sfThreshold', { name: s.label || name }))}" min="0" max="1" step="0.05" value="${attr(s.minConfidence)}" style="${smallInput};width:64px">`
      : '<span style="color:var(--t-muted)">—</span>';
    const probability = s.minProbability != null
      ? `<input type="number" class="jv-sf-probability" aria-label="${attr(kit.tx('settings.redesign.judgments.name.sfProbability', { name: s.label || name }))}" min="0" max="1" step="0.05" value="${attr(s.minProbability)}" style="${smallInput};width:64px">`
      : '<span style="color:var(--t-muted)">—</span>';
    // A rider is asked inside its lead's request, so the lead's timeout is the one that applies.
    const lead = s.ridesWith ? String(all[s.ridesWith]?.label || s.ridesWith) : null;
    const timeout = lead
      ? `<span class="jv-sf-lead-timeout settings-hint" style="margin:0" title="${kit.th('settings.redesign.judgments.askedInsideSRequestSoThat', { attr: attr(lead) })}">${kit.te('settings.redesign.judgments.leadS')}</span>`
      : `<input type="number" class="jv-sf-timeout" aria-label="${attr(kit.tx('settings.redesign.judgments.name.sfTimeout', { name: s.label || name }))}" min="200" max="30000" step="100" value="${attr(s.timeoutMs)}" style="${smallInput};width:78px"><div class="jv-sf-warn settings-hint" style="margin:2px 0 0;color:#ffc107;display:none">${kit.te('settings.redesign.judgments.overTheHookBudget')}</div>`;
    // Limits sit under the description: the table already fills the panel, so a column of their own would squeeze every description.
    const limits = LIMIT_FIELDS.filter(f => s[f.key] != null).map(f => `<label title="${kit.te(`settings.redesign.judgments.limit.${f.key}.help`)}" style="display:inline-flex;flex-wrap:wrap;align-items:center;gap:2px 4px;font-size:11px;color:var(--t-muted)">${kit.te(`settings.redesign.judgments.limit.${f.key}.label`)}<input type="number" class="jv-sf-limit" data-key="${f.key}" min="${f.min}" max="${f.max}" step="${f.step}" value="${attr(s[f.key])}" style="${smallInput};width:${f.width}px"></label>`).join('');
    return `<tr id="jv-sf-${attr(name)}" data-surface="${attr(name)}">
      <td><label class="recall-toggle"><input type="checkbox" class="jv-sf-enabled" aria-label="${attr(kit.tx('settings.redesign.judgments.name.sfEnabled', { name: s.label || name }))}"${s.enabled ? ' checked' : ''}><span class="recall-toggle-track"></span></label></td>
      <td><div style="font-weight:600">${escapeHtml(s.label || name)} <span style="font-weight:400;color:var(--t-muted);font-size:11px">${escapeHtml(name)}</span></div><div class="settings-hint" style="margin:2px 0 0;max-width:420px">${escapeHtml(s.description || '')}<br><span style="opacity:.75">${kit.te('settings.redesign.judgments.fallback')} ${escapeHtml(s.fallback || '')}</span></div>${lead ? `<div class="settings-hint jv-sf-rides" style="margin:2px 0 0;color:var(--accent)">${kit.th('settings.redesign.judgments.ridesWithAskedInTheSame', { lead: escapeHtml(lead) })}</div>` : ''}${limits ? `<div class="jv-sf-limits" style="display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:5px">${limits}</div>` : ''}</td>
      <td>${timeout}</td>
      <td>${threshold}</td>
      <td>${probability}</td>
      <td class="jv-sf-calls">0</td><td class="jv-sf-avg">0</td><td class="jv-sf-fail">0</td><td class="jv-sf-skipped" title="${kit.te('settings.redesign.judgments.thisProcessOnlyCallsSkippedBecause')}">0</td>
    </tr>`;
  }
  function renderSurfaces(cfg) {
    const body = $('jv-surfaces-body');
    const names = Object.keys(cfg.surfaces || {});
    // Rebuilt when the surfaces or a row's shape change (a restarted server can add fields); values sync in place below.
    const shape = names.map(n => { const s = cfg.surfaces[n] || {}; return [n, s.ridesWith || '', s.minConfidence != null, s.minProbability != null, ...LIMIT_FIELDS.map(f => s[f.key] != null)].join(':'); }).join('|');
    if (body.dataset.shape !== shape) { body.innerHTML = names.map(n => surfaceRow(n, cfg.surfaces[n], cfg.surfaces)).join(''); body.dataset.shape = shape; }
    // Counters come from the judgment log when the server keeps them there; otherwise from this process.
    const logStats = cfg.logStats && typeof cfg.logStats === 'object' ? cfg.logStats : null;
    // A server that sends budgetMs names each hook's budget; an older one gets the list this page always used.
    const budgets = names.some(n => fin(cfg.surfaces[n]?.budgetMs));
    let on = 0;
    for (const name of names) {
      const s = cfg.surfaces[name];
      const row = body.querySelector(`tr[data-surface="${name}"]`);
      if (!row) continue;
      if (s.enabled) on++;
      setChecked(row.querySelector('.jv-sf-enabled'), s.enabled);
      setValue(row.querySelector('.jv-sf-timeout'), s.timeoutMs);
      setValue(row.querySelector('.jv-sf-threshold'), s.minConfidence);
      setValue(row.querySelector('.jv-sf-probability'), s.minProbability);
      for (const input of row.querySelectorAll('.jv-sf-limit')) setValue(input, s[input.dataset.key]);
      const lead = s.ridesWith ? cfg.surfaces[s.ridesWith] : null;
      setText(row.querySelector('.jv-sf-lead-timeout'), lead && fin(lead.timeoutMs) ? `lead's · ${num(lead.timeoutMs)}` : "lead's");
      const m = s.metrics || {};
      const calls = row.querySelector('.jv-sf-calls'), avg = row.querySelector('.jv-sf-avg'), fail = row.querySelector('.jv-sf-fail');
      if (logStats) {
        const h = logStats.surfaces?.[name]?.h24 || {}, d = logStats.surfaces?.[name]?.d7 || {};
        setText(calls, `${num(h.calls)} / ${num(d.calls)}`);
        setText(avg, num(Math.round(Number(Number(h.calls) ? h.avgMs : d.avgMs) || 0)));
        avg.title = Number(h.calls) ? kit.tx('settings.redesign.judgments.averageOverTheLast24H') : kit.tx('settings.redesign.judgments.averageOverTheLast7D');
        setText(fail, num(h.failures));
      } else {
        setText(calls, num(m.calls));
        setText(avg, num(m.avgMs));
        avg.title = '';
        setText(fail, num(m.failures));
      }
      setText(row.querySelector('.jv-sf-skipped'), num(m.skipped));
      const warn = row.querySelector('.jv-sf-warn');
      if (warn) {
        const budget = budgets ? (fin(s.budgetMs) ? Number(s.budgetMs) : null) : LEGACY_HOOK_SURFACES.includes(name) ? HOOK_BUDGET_MS : null;
        const over = budget != null && Number(s.timeoutMs) > budget;
        warn.style.display = over ? 'block' : 'none';
        if (over) setText(warn, kit.tx('settings.redesign.judgments.overTheMsHookBudget', { num: num(budget) }));
      }
      row.style.opacity = s.enabled ? '1' : '0.6';
    }
    // Non-breaking spaces: the header may wrap after its first word, never inside "24 h".
    setText($('jv-sf-h-calls'), logStats ? kit.tx('settings.redesign.judgments.callsWindows') : kit.tx('settings.redesign.judgments.calls'));
    setText($('jv-sf-h-fail'), logStats ? kit.tx('settings.redesign.judgments.failWindow') : kit.tx('settings.redesign.judgments.fail'));
    $('jv-sf-h-skipped').title = logStats ? kit.tx('settings.redesign.judgments.thisProcessOnlyASurfaceThat') : '';
    const hint = $('jv-surfaces-hint');
    const oldest = logStats ? Date.parse(logStats.oldest) : NaN;
    const text = logStats
      ? kit.tx('settings.redesign.judgments.oneRowPerJudgmentTurningA2', { fin: fin(oldest) && Date.now() - oldest < SESSIONS_DAYS * 864e5 ? (" " + kit.tx('settings.redesign.judgments.theLogReachesBackOnlyTo', { stamp: stamp(logStats.oldest) })) : '' })
      : kit.tx('settings.redesign.judgments.oneRowPerJudgmentTurningA', { HOOK_BUDGET_MS: HOOK_BUDGET_MS });
    setText(hint, text);
    setText($('jv-surfaces-badge'), kit.tx('settings.redesign.judgments.surfacesOn', { on, total: names.length }));
  }
  function spend(stats, rateIn, rateOut) {
    const cost = Number(stats.inputTokens || 0) / 1e6 * (rateIn || 0) + Number(stats.outputTokens || 0) / 1e6 * (rateOut || 0);
    return money(cost);
  }
  /** The figures the header and the tiles show: the log's 24 h or 7 d totals when the server keeps them, else this process's counters. */
  function statsWindow(cfg) {
    const logStats = cfg?.logStats && typeof cfg.logStats === 'object' ? cfg.logStats : null;
    const wanted = $('jv-st-window').value;
    if (!logStats || wanted === 'process') return { key: 'process', label: kit.tx('settings.redesign.judgments.thisProcess'), s: cfg?.stats || {} };
    const key = wanted === 'd7' ? 'd7' : 'h24';
    const t = logStats.totals?.[key] || {};
    const calls = Number(t.calls || 0), failures = Number(t.failures || 0);
    // The log's totals carry calls, failures, latency and input tokens; anything else shows as a dash.
    return { key, label: key === 'd7' ? kit.tx('settings.redesign.judgments.theLast7D') : kit.tx('settings.redesign.judgments.theLast24H'), s: { calls, failures, hits: fin(t.hits) ? Number(t.hits) : Math.max(0, calls - failures), cached: fin(t.cached) ? Number(t.cached) : null, inputTokens: Number(t.inputTokens || 0), outputTokens: fin(t.outputTokens) ? Number(t.outputTokens) : null, avgMs: fin(t.avgMs) ? Math.round(Number(t.avgMs)) : 0 } };
  }
  function renderStatsWindow(cfg, w) {
    const logStats = cfg.logStats && typeof cfg.logStats === 'object' ? cfg.logStats : null;
    $('jv-st-window-row').style.display = logStats ? 'flex' : 'none';
    $('jv-metrics-reset').title = logStats ? kit.tx('settings.redesign.judgments.resetsThisProcessSCountersThe') : '';
    if (!logStats) return;
    const hint = $('jv-st-window-hint');
    const oldest = Date.parse(logStats.oldest);
    const partial = fin(oldest) && Date.now() - oldest < SESSIONS_DAYS * 864e5;
    setText(hint, !fin(oldest) ? kit.tx('settings.redesign.judgments.theJudgmentLogIsEmpty')
      : partial ? kit.tx('settings.redesign.judgments.theLogReachesBackOnlyTo2', { stamp: stamp(logStats.oldest), duration: duration(Date.now() - oldest) })
      : kit.tx('settings.redesign.judgments.theLogReachesBackTo', { stamp: stamp(logStats.oldest) }));
    hint.style.color = partial && w.key === 'd7' ? '#ffc107' : '';
  }
  function renderTelemetry(cfg) {
    const s = cfg.stats || {};
    const w = statsWindow(cfg), ws = w.s;
    const dash = (n) => (n == null ? '—' : num(n));
    setText($('jv-st-calls'), num(ws.calls)); setText($('jv-st-hits'), num(ws.hits)); setText($('jv-st-failures'), num(ws.failures)); setText($('jv-st-cached'), dash(ws.cached));
    setText($('jv-st-in'), num(ws.inputTokens)); setText($('jv-st-out'), dash(ws.outputTokens)); setText($('jv-st-avg'), num(ws.avgMs));
    renderStatsWindow(cfg, w);
    const rateIn = Number($('jv-rate-in').value || cfg.costPerMillionInput || 0), rateOut = Number($('jv-rate-out').value || cfg.costPerMillionOutput || 0);
    setText($('jv-st-cost'), (rateIn || rateOut) ? spend(ws, rateIn, rateOut) : kit.tx('settings.redesign.judgments.setRates'));
    setValue($('jv-rate-in'), cfg.costPerMillionInput); setValue($('jv-rate-out'), cfg.costPerMillionOutput);
    const err = $('jv-st-lasterror');
    err.textContent = s.lastError ? kit.tx('settings.redesign.judgments.lastError', { lastError: s.lastError, lastErrorAt: s.lastErrorAt ? (" " + kit.tx('settings.redesign.judgments.at', { clock: clock(s.lastErrorAt) })) : '', retryAfterMs: s.retryAfterMs > 0 ? (" " + kit.tx('settings.redesign.judgments.rateLimitedRetryInS', { retryAfterMs: Math.ceil(s.retryAfterMs / 1000) })) : '' }) : kit.tx('settings.redesign.judgments.noErrorsThisProcess');
    err.style.color = s.lastError ? '#f66' : '';
    setText($('jv-telemetry-badge'), kit.tx('settings.redesign.judgments.telemetryBadge', { calls: num(ws.calls), tokens: num(ws.inputTokens), window: w.key === 'd7' ? ' · 7 d' : w.key === 'h24' ? ' · 24 h' : '' }));
    const size = Number(s.cacheSize || 0), cached = Number(s.cached || 0), calls = Number(s.calls || 0);
    setText($('jv-cache-size'), num(size));
    setText($('jv-cache-ratio'), (cached + calls) ? pct(cached / (cached + calls)) : '—');
  }
  function renderCoverage(cfg) {
    const c = cfg.coverage || { judged: 0, total: 0 };
    const ratio = c.total ? c.judged / c.total : 0;
    setText($('jv-coverage'), kit.tx('settings.redesign.judgments.coverageLiveMemoriesJudged', { num: num(c.judged), num2: num(c.total), pct: pct(ratio) }));
    $('jv-coverage-bar').style.width = `${Math.round(ratio * 100)}%`;
  }
  function renderBench(cfg) {
    const last = cfg.benchRunAt;
    const summaries = cfg.bench || {};
    const parts = Object.entries(summaries).map(([s, b]) => `${s} ${pct(b.agreement)} (n=${b.n})`);
    setText($('jv-bench-last'), last ? kit.tx('settings.redesign.judgments.lastImportanceBench', { stamp: stamp(last), count: parts.length ? ` · ${parts.join(' · ')}` : '' }) : kit.tx('settings.redesign.judgments.lastBenchNeverRunOneTo'));
    setText($('jv-bench-badge'), last ? kit.tx('settings.redesign.judgments.benchBadge', { date: new Date(last).toLocaleDateString() }) : kit.tx('settings.redesign.judgments.notRun'));
    const apply = $('jv-apply-importance');
    apply.disabled = !last;
    setChecked(apply, cfg.applyJudgedImportance);
  }
  // ── Browser assistance ──
  const BA_COUNTERS = [['pageAssessments', kit.tx('settings.redesign.judgments.pageAssessments')], ['recommendations', kit.tx('settings.redesign.judgments.recommendations')], ['shadowAutoHealEligible', kit.tx('settings.redesign.judgments.wouldHaveHealedShadow')], ['autoHealAttempted', kit.tx('settings.redesign.judgments.autoHealAttempted')],
    ['autoHealSucceeded', kit.tx('settings.redesign.judgments.autoHealSucceeded')], ['blockedBySafety', kit.tx('settings.redesign.judgments.blockedBySafety')], ['skippedRateLimit', kit.tx('settings.redesign.judgments.skippedRateLimit')], ['fallbackUnavailable', kit.tx('settings.redesign.judgments.fallbackUnavailable')]];
  function renderBrowserAssist(cfg) {
    const ba = cfg.browserAssist;
    const toggleEl = $('jv-ba-autoheal');
    if (!toggleEl) return;
    // This file is served from disk, so it can be newer than the running server: say so rather than render an empty section.
    if (!ba) {
      setText($('jv-browser-badge'), kit.tx('settings.redesign.judgments.restartTheNeuralInterfaceAfterNpm'));
      show($('jv-ba-mode'), kit.tx('settings.redesign.judgments.thisServerWasStartedBeforeBrowser'), warnBg);
      toggleEl.disabled = true;
      return;
    }
    const on = ba.mode === 'auto-heal';
    setText($('jv-browser-badge'), on ? kit.tx('settings.redesign.judgments.autoHealOn') : ba.autoHealEnabled ? kit.tx('settings.redesign.judgments.shadowAutoHealLocked') : kit.tx('settings.redesign.judgments.stateShadow'));
    show($('jv-ba-mode'), `<strong>${on ? kit.te('settings.redesign.judgments.autoHeal') : kit.te('settings.redesign.judgments.shadow')}</strong> — ${on
      ? kit.te('settings.redesign.judgments.adviceOnEverySurfaceAndOne')
      : kit.te('settings.redesign.judgments.adviceOnlyHintsAreReorderedAnd')}<br><span style="font-family:monospace;font-size:11px;opacity:.85">${kit.te('settings.redesign.judgments.basis')} ${escapeHtml(ba.basis || kit.tx('settings.redesign.judgments.unavailable'))}</span>`, on ? okBg : 'var(--s-darker)');
    const b = ba.targetBench;
    setText($('jv-ba-bench'), b
      ? kit.tx('settings.redesign.judgments.lastBrowserBenchmark', { stamp: stamp(b.at), model: b.model, passed: b.passed ? kit.tx('settings.redesign.judgments.passedEveryGate') : kit.tx('settings.redesign.judgments.didNotPass'), reportFile: b.reportFile ? ` · ${String(b.reportFile).split('/').slice(-2).join('/')}` : '' })
      : kit.tx('settings.redesign.judgments.lastBrowserBenchmarkNeverPickBrowser'));
    setText($('jv-ba-reasons'), ba.eligible ? '' : (ba.reasons || []).join(' '));
    $('jv-ba-counters').innerHTML = BA_COUNTERS.map(([key, label]) => `<div class="db-stat"><span class="db-stat-label">${label}</span><span class="db-stat-value">${num((ba.counters || {})[key])}</span></div>`).join('');
    // Turning it off is always possible; turning it on needs a passing benchmark of this exact configuration.
    toggleEl.disabled = !ba.eligible && !ba.autoHealEnabled;
    setChecked(toggleEl, ba.autoHealEnabled);
  }
  // ── Desktop assistance ──
  const DA_COUNTERS = [['intentSnapshots', kit.tx('settings.redesign.judgments.intentSnapshots')], ['recommendations', kit.tx('settings.redesign.judgments.recommendations')], ['pressEligibleAdvisory', kit.tx('settings.redesign.judgments.wouldHavePressedLocked')], ['pressAttempted', kit.tx('settings.redesign.judgments.pressesAttempted')],
    ['pressSucceeded', kit.tx('settings.redesign.judgments.pressesSucceeded')], ['blockedBySafety', kit.tx('settings.redesign.judgments.blockedBySafety')], ['skippedRateLimit', kit.tx('settings.redesign.judgments.skippedRateLimit')], ['fallbackUnavailable', kit.tx('settings.redesign.judgments.fallbackUnavailable')]];
  function renderDesktopAssist(cfg) {
    const da = cfg.desktopAssist;
    const toggleEl = $('jv-da-press');
    if (!toggleEl) return;
    // Served from disk, so possibly newer than the running server: say so rather than render an empty section.
    if (!da) {
      setText($('jv-desktop-badge'), kit.tx('settings.redesign.judgments.restartAfterNpmRunMcpBuild'));
      show($('jv-da-mode'), '' + kit.te('settings.redesign.judgments.thisServerWasStartedBeforeDesktop') + ' <code>npm run mcp:build</code> ' + kit.te('settings.redesign.judgments.toLoadItUntilThenComputer') + '', warnBg);
      setText($('jv-da-bench'), ''); setText($('jv-da-reasons'), ''); $('jv-da-counters').innerHTML = '';
      toggleEl.disabled = true;
      return;
    }
    const on = da.mode === 'press';
    setText($('jv-desktop-badge'), on ? kit.tx('settings.redesign.judgments.pressByIntentOn') : da.pressEnabled ? kit.tx('settings.redesign.judgments.advisoryPressLocked') : 'advisory');
    show($('jv-da-mode'), `<strong>${on ? kit.te('settings.redesign.judgments.pressByIntent') : kit.te('settings.redesign.judgments.advisory')}</strong> — ${on
      ? kit.te('settings.redesign.judgments.aRankedListAndAdviceOn')
      : kit.te('settings.redesign.judgments.aRankedListAndAdviceOn2')}<br><span style="font-family:monospace;font-size:11px;opacity:.85">${kit.te('settings.redesign.judgments.basis')} ${escapeHtml(da.basis || kit.tx('settings.redesign.judgments.unavailable'))}</span>`, on ? okBg : 'var(--s-darker)');
    const b = da.targetBench;
    setText($('jv-da-bench'), b
      ? kit.tx('settings.redesign.judgments.lastDesktopBenchmark', { stamp: stamp(b.at), model: b.model, passed: b.passed ? kit.tx('settings.redesign.judgments.passedEveryGate') : kit.tx('settings.redesign.judgments.didNotPass'), reportFile: b.reportFile ? ` · ${String(b.reportFile).split('/').slice(-2).join('/')}` : '' })
      : kit.tx('settings.redesign.judgments.lastDesktopBenchmarkNeverPickDesktop'));
    setText($('jv-da-reasons'), da.eligible ? '' : (da.reasons || []).join(' '));
    $('jv-da-counters').innerHTML = DA_COUNTERS.map(([key, label]) => `<div class="db-stat"><span class="db-stat-label">${label}</span><span class="db-stat-value">${num((da.counters || {})[key])}</span></div>`).join('');
    // Off is always reachable; on needs a passing desktop benchmark of this exact configuration.
    toggleEl.disabled = !da.eligible && !da.pressEnabled;
    setChecked(toggleEl, da.pressEnabled);
  }
  function applyConfig(cfg) {
    if (!cfg || cfg.ok === false) { setHeader(cfg); return; }
    state.cfg = cfg;
    setHeader(cfg); renderConnection(cfg); renderMaster(cfg); renderSurfaces(cfg); renderTelemetry(cfg); renderCoverage(cfg); renderBench(cfg); renderBrowserAssist(cfg);
    renderDesktopAssist(cfg);
    renderSessionsMeta(cfg); renderSupersessionsMeta(cfg); syncLogFilters(cfg);
    if (cfg.backfill) applyBackfill(cfg.backfill);
    const logSurface = $('jv-log-surface');
    if (logSurface.options.length <= 1) {
      for (const name of Object.keys(cfg.surfaces || {})) { const o = document.createElement('option'); o.value = name; o.textContent = name; logSurface.appendChild(o); }
      const o = document.createElement('option'); o.value = 'connection-test'; o.textContent = kit.tx('settings.redesign.judgments.connectionTest'); logSurface.appendChild(o);
      // Filters saved before session / memory / project existed parse the same; the new fields just stay blank.
      try { const f = JSON.parse(storage.getItem(LOG_FILTER_KEY) || 'null'); if (f) { logSurface.value = f.surface || ''; $('jv-log-origin').value = f.origin || ''; $('jv-log-limit').value = f.limit || '50'; for (const key of ['session', 'entity', 'project']) if (typeof f[key] === 'string') $(`jv-log-${key}`).value = f[key]; } } catch { /* defaults */ }
      if ($('jv-log-origin').selectedIndex < 0) $('jv-log-origin').value = ''; // an origin this server does not list
    }
  }
  async function loadConfig() { applyConfig(await jget('/api/typesafe/config')); }
  async function putConfig(patch, okMessage) {
    const res = await jput('/api/typesafe/config', patch);
    if (res.ok === false) { toast(kit.tx('settings.redesign.judgments.errJudgments', { error: res.error || kit.tx('settings.redesign.judgments.saveFailed') })); await loadConfig(); return null; }
    applyConfig(res);
    if (okMessage) toast(okMessage);
    return res;
  }

  // ── Connection handlers ──
  $('jv-key-save').addEventListener('click', async () => {
    const value = $('jv-api-key').value.trim();
    if (!value) { toast(kit.tx('settings.redesign.judgments.pasteAKeyFirst')); return; }
    const res = await putConfig({ apiKey: value }, kit.tx('settings.redesign.judgments.typesafeKeySaved'));
    if (res) { $('jv-api-key').value = ''; }
  });
  $('jv-key-clear').addEventListener('click', async () => {
    const btn = $('jv-key-clear');
    if (!state.armed.clear) { state.armed.clear = true; btn.textContent = kit.tx('settings.redesign.judgments.confirmClear'); setTimeout(() => { state.armed.clear = false; btn.textContent = kit.tx('settings.redesign.judgments.clear'); }, 5000); return; }
    state.armed.clear = false; btn.textContent = kit.tx('settings.redesign.judgments.clear');
    await putConfig({ apiKey: '' }, kit.tx('settings.redesign.judgments.typesafeKeyRemoved'));
    show($('jv-test-result'), '');
  });
  $('jv-key-test').addEventListener('click', async () => {
    const pending = $('jv-api-key').value.trim();
    if (pending) { const saved = await putConfig({ apiKey: pending }); if (!saved) return; $('jv-api-key').value = ''; }
    const box = $('jv-test-result');
    show(box, kit.tx('settings.redesign.judgments.testing'), 'var(--s-darker)');
    const res = await jpost('/api/typesafe/test');
    if (res.ok) {
      show(box, `<strong>${kit.te('settings.redesign.judgments.ok')}</strong> ${kit.th('settings.redesign.judgments.msInOutAt', { num: num(res.latencyMs), num2: num(res.inputTokens), num3: num(res.outputTokens), model: escapeHtml(res.model || '') })} ${escapeHtml(res.baseUrl || '')}<pre style="margin:6px 0 0;white-space:pre-wrap;font-size:11px">${escapeHtml(JSON.stringify(res.answer, null, 2))}</pre>`, okBg);
    } else show(box, `<strong>${kit.te('settings.redesign.judgments.notWorking')}</strong> · ${escapeHtml(res.reason || res.error || kit.tx('settings.redesign.judgments.unknown'))}${res.latencyMs ? (" " + kit.th('settings.redesign.judgments.ms', { num: num(res.latencyMs) })) : ''}`, errBg);
    loadConfig();
  });
  $('jv-base-url-save').addEventListener('click', () => putConfig({ baseUrl: $('jv-base-url').value.trim() }, kit.tx('settings.redesign.judgments.baseUrlSaved')));
  $('jv-model').addEventListener('change', () => putConfig({ model: $('jv-model').value }, kit.tx('settings.redesign.judgments.modelSetTo', { value: $('jv-model').value })));

  // ── Master switch ──
  $('jv-master-toggle').addEventListener('change', () => putConfig({ enabled: $('jv-master-toggle').checked }, $('jv-master-toggle').checked ? kit.tx('settings.redesign.judgments.judgmentsOn') : kit.tx('settings.redesign.judgments.judgmentsOffEverySurfaceNowUses')));

  // ── Surfaces ──
  const surfaceDebounce = new Map();
  const readRow = (row) => {
    const patch = { enabled: row.querySelector('.jv-sf-enabled').checked };
    // A rider has no timeout of its own to send: it rides on its lead's.
    const to = row.querySelector('.jv-sf-timeout');
    if (to) patch.timeoutMs = Number(to.value);
    const th = row.querySelector('.jv-sf-threshold');
    if (th) patch.minConfidence = Number(th.value);
    const pr = row.querySelector('.jv-sf-probability');
    if (pr) patch.minProbability = Number(pr.value);
    // Limits: only the fields this surface carries; a half-typed (empty) value is left for the server to keep.
    for (const input of row.querySelectorAll('.jv-sf-limit')) if (fin(input.value)) patch[input.dataset.key] = Number(input.value);
    return patch;
  };
  async function putSurface(row) {
    const name = row.dataset.surface;
    const res = await putConfig({ surfaces: { [name]: readRow(row) } });
    setText($('jv-surfaces-status'), res ? kit.tx('settings.redesign.judgments.savedAt', { name, time: clock(new Date().toISOString()) }) : kit.tx('settings.redesign.judgments.couldNotSave', { name: name }));
  }
  $('jv-surfaces-body').addEventListener('change', (e) => {
    const row = e.target.closest('tr[data-surface]');
    if (!row) return;
    surfaceDebounce.get(row.dataset.surface)?.cancel?.();
    putSurface(row);
  });
  $('jv-surfaces-body').addEventListener('input', (e) => {
    const row = e.target.closest('tr[data-surface]');
    if (!row || !e.target.matches('.jv-sf-timeout, .jv-sf-threshold, .jv-sf-probability, .jv-sf-limit')) return;
    let fn = surfaceDebounce.get(row.dataset.surface);
    if (!fn) { fn = debounce(() => putSurface(row), 600); surfaceDebounce.set(row.dataset.surface, fn); }
    fn();
  });

  // ── Telemetry / cache ──
  const liveSpend = () => { if (state.cfg) setText($('jv-st-cost'), spend(statsWindow(state.cfg).s, Number($('jv-rate-in').value || 0), Number($('jv-rate-out').value || 0))); };
  $('jv-st-window').addEventListener('change', () => { storage.setItem(WINDOW_KEY, $('jv-st-window').value); if (state.cfg) { setHeader(state.cfg); renderTelemetry(state.cfg); } });
  $('jv-rate-in').addEventListener('input', liveSpend); $('jv-rate-out').addEventListener('input', liveSpend);
  $('jv-rates-save').addEventListener('click', () => putConfig({ costPerMillionInput: Number($('jv-rate-in').value || 0), costPerMillionOutput: Number($('jv-rate-out').value || 0) }, kit.tx('settings.redesign.judgments.ratesSaved')));
  $('jv-metrics-reset').addEventListener('click', async () => { const r = await jpost('/api/typesafe/metrics/reset'); if (r.ok) { toast(kit.tx('settings.redesign.judgments.countersReset')); loadConfig(); } else toast(kit.tx('settings.redesign.judgments.errJudgments', { error: r.error })); });
  $('jv-cache-clear').addEventListener('click', async () => { const r = await jpost('/api/typesafe/cache/clear'); if (r.ok) { toast(kit.tx('settings.redesign.judgments.answerCacheCleared')); loadConfig(); } else toast(kit.tx('settings.redesign.judgments.errJudgments', { error: r.error })); });

  // ── Backfill ──
  function applyBackfill(b) {
    if (!b) return;
    state.backfill = b;
    const status = b.status || 'idle';
    setText($('jv-backfill-badge'), status);
    const est = b.estimate;
    const inputs = { project: $('jv-bf-project').value.trim() || null, limit: $('jv-bf-limit').value ? Number($('jv-bf-limit').value) : null };
    const estMatches = est && (est.rows != null) && state.estimateFor && state.estimateFor.project === inputs.project && state.estimateFor.limit === inputs.limit;
    if (est) show($('jv-bf-estimate-box'), `<strong>${kit.te('settings.redesign.judgments.estimate')}</strong> ${kit.th('settings.redesign.judgments.memoriesImportanceKindRequestsRelationRe', { basis: escapeHtml(est.basis), stamp: stamp(est.at), num: num(est.rows), num2: num(est.calls.importanceKind), num3: num(est.calls.relations), num4: num(est.tokens.input), num5: num(est.tokens.output) })} <strong>${money(est.costUsd)}</strong> ${kit.th('settings.redesign.judgments.atMInAboutAtConcurrent', { input: est.rates.input, duration: duration(est.wallClockMs), concurrency: est.concurrency })}${est.sample ? (" " + kit.th('settings.redesign.judgments.neighbourSampleHadCandidates', { withCandidates: est.sample.withCandidates, size: est.sample.size })) : ''}`, 'var(--s-darker)');
    const running = status === 'running', paused = status === 'paused';
    $('jv-bf-estimate').disabled = running;
    $('jv-bf-start').disabled = running || paused || !estMatches;
    $('jv-bf-start').textContent = state.armed.start ? kit.tx('settings.redesign.judgments.confirmStart', { money: money(est?.costUsd) }) : kit.tx('settings.redesign.judgments.start');
    $('jv-bf-pause').disabled = !running;
    $('jv-bf-resume').disabled = !paused;
    $('jv-bf-cancel').disabled = !(running || paused);
    const dot = $('jv-bf-dot');
    dot.className = `wiz-status-dot${running ? ' spin' : status === 'done' ? ' green' : (paused && b.pausedReason === 'failures') || status === 'cancelled' ? ' red' : ''}`;
    const total = Number(b.total || 0), judged = Number(b.judged || 0), remaining = Number(b.jobs?.pending || 0) + Number(b.jobs?.running || 0);
    setText($('jv-bf-text'), status === 'idle' ? kit.tx('settings.redesign.judgments.idle')
      : running ? kit.tx('settings.redesign.judgments.bfRunning', { judged: num(judged), remaining: num(remaining), retry: b.retryAfterMs > 0 ? (" " + kit.tx('settings.redesign.judgments.rateLimitedRetryingInS', { retryAfterMs: Math.ceil(b.retryAfterMs / 1000) })) : '' })
      : paused ? kit.tx('settings.redesign.judgments.bfPaused', { reason: b.pausedReason === 'failures' ? (" " + kit.tx('settings.redesign.judgments.afterRepeatedFailures')) : '', judged: num(judged), remaining: num(remaining) })
      : status === 'done' ? kit.tx('settings.redesign.judgments.doneJudgedIn', { num: num(judged), duration: duration(b.report?.wallClockMs) })
      : kit.tx('settings.redesign.judgments.bfCancelled', { judged: num(judged) }));
    $('jv-bf-bar').style.width = total ? `${Math.min(100, Math.round(judged / total * 100))}%` : '0%';
    setText($('jv-bf-summary'), (judged || b.failures) ? kit.tx('settings.redesign.judgments.relationsSimilarPossibleConflictDuplicat', { num: num(b.relationsCreated?.similar), num2: num(b.relationsCreated?.possible_conflict), num3: num(b.relationsCreated?.duplicate_of), num4: num(b.disagreements?.kind), num5: num(b.disagreements?.importance), num6: num(b.tokensIn), num7: num(b.tokensOut), num8: num(b.failures), startedAt: b.startedAt ? (" " + kit.tx('settings.redesign.judgments.started', { stamp: stamp(b.startedAt) })) : '' }) : '');
    setText($('jv-bf-error'), b.lastError ? kit.tx('settings.redesign.judgments.lastError2', { lastError: b.lastError, lastErrorAt: b.lastErrorAt ? (" " + kit.tx('settings.redesign.judgments.at', { clock: clock(b.lastErrorAt) })) : '' }) : '');
    const r = b.report;
    show($('jv-bf-report'), r ? `<strong>${kit.te('settings.redesign.judgments.report')}</strong> ${kit.th('settings.redesign.judgments.ofJudgedSkippedFailuresWallClock', { num: num(r.judged), num2: num(r.total), num3: num(r.skipped), num4: num(r.failures), duration: duration(r.wallClockMs), num5: num(r.avgLatencyMs), num6: num(r.relationsCreated.similar), num7: num(r.relationsCreated.possible_conflict), num8: num(r.relationsCreated.duplicate_of), pct: pct(r.disagreements.kindRate), pct2: pct(r.disagreements.importanceRate), num9: num(r.tokensIn), money: money(r.costUsd), num10: num(r.coverageAfter.judged) })} ${num(r.coverageAfter.total)}` : '', 'var(--s-darker)');
    if (running || paused) startTimer('backfill', 2000, pollBackfill); else stopTimer('backfill');
  }
  async function pollBackfill() {
    if (!tabActive()) return;
    const r = await jget('/api/typesafe/backfill/status');
    if (r.ok) { applyBackfill(r.backfill); if (['done', 'cancelled'].includes(r.backfill.status)) loadConfig(); }
  }
  const bfInputs = () => ({ project: $('jv-bf-project').value.trim() || null, limit: $('jv-bf-limit').value ? Number($('jv-bf-limit').value) : null });
  async function bfAction(action, extra = {}) {
    const r = await jpost('/api/typesafe/backfill', { action, ...bfInputs(), ...extra });
    if (r.ok === false) { toast(kit.tx('settings.redesign.judgments.errBackfill', { error: r.error })); return null; }
    applyBackfill(r.backfill);
    return r.backfill;
  }
  $('jv-bf-estimate').addEventListener('click', async () => { $('jv-bf-estimate').disabled = true; const b = await bfAction('estimate'); state.estimateFor = b ? bfInputs() : null; $('jv-bf-estimate').disabled = false; if (b) applyBackfill(b); });
  for (const id of ['jv-bf-project', 'jv-bf-limit']) $(id).addEventListener('input', () => { state.armed.start = false; if (state.backfill) applyBackfill(state.backfill); });
  $('jv-bf-start').addEventListener('click', async () => {
    if (!state.armed.start) { state.armed.start = true; applyBackfill(state.backfill); setTimeout(() => { state.armed.start = false; if (state.backfill) applyBackfill(state.backfill); }, 8000); return; }
    state.armed.start = false;
    const b = await bfAction('start', { confirm: true });
    if (b) toast(kit.tx('settings.redesign.judgments.backfillStarted'));
  });
  $('jv-bf-pause').addEventListener('click', () => bfAction('pause'));
  $('jv-bf-resume').addEventListener('click', () => bfAction('resume'));
  $('jv-bf-cancel').addEventListener('click', async () => {
    const btn = $('jv-bf-cancel');
    if (!state.armed.cancel) { state.armed.cancel = true; btn.textContent = kit.tx('settings.redesign.judgments.confirmCancel'); setTimeout(() => { state.armed.cancel = false; btn.textContent = kit.tx('settings.redesign.judgments.cancel'); }, 5000); return; }
    state.armed.cancel = false; btn.textContent = kit.tx('settings.redesign.judgments.cancel');
    await bfAction('cancel');
  });

  // ── Bench ──
  function benchTable(report) {
    const rows = report.disagreements || [];
    const table = $('jv-bench-table');
    if (!rows.length) { table.innerHTML = '<tr><td class="settings-hint">' + kit.te('settings.redesign.judgments.noDisagreementsInThisSample') + '</td></tr>'; return; }
    const cols = ['id', 'stored', 'judged', 'confidence', 'category', 'note'].filter(c => rows.some(r => r[c] != null));
    table.innerHTML = `<thead><tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${cols.map(c => `<td style="font-family:monospace;font-size:11px">${escapeHtml(c === 'confidence' ? pct(r[c]) : String(r[c] ?? '').slice(0, 80))}</td>`).join('')}</tr>`).join('')}</tbody>`;
  }
  $('jv-bench-run').addEventListener('click', async () => {
    const btn = $('jv-bench-run'); btn.disabled = true; $('jv-bench-spinner').style.display = 'inline';
    const surface = $('jv-bench-surface').value;
    const r = await jpost('/api/typesafe/bench', { surface, limit: Number($('jv-bench-limit').value) || 50, project: $('jv-bench-project').value.trim() || undefined });
    btn.disabled = false; $('jv-bench-spinner').style.display = 'none';
    if (r.ok === false) { toast(kit.tx('settings.redesign.judgments.errBench', { error: r.error })); return; }
    const rep = r.report;
    const a = rep.agreement || {};
    const lines = [];
    if (surface === 'browser') {
      const rate = (x) => (x && x.value != null ? `${(x.value * 100).toFixed(1)}% (${x.numerator}/${x.of})` : 'n/a');
      const t = rep.target, p = rep.pageState, so = rep.social, g = rep.gates || {};
      if (t) lines.push(kit.tx('settings.redesign.judgments.targetTop1PrecisionAbstentionAuto', { rate: rate(t.top1), rate2: rate(t.precision), rate3: rate(t.abstention), rate4: rate(t.eligiblePrecision), rate5: rate(t.coverage), num: num(t.unsafeSelections), num2: num(t.forbiddenAutoExecutable) }));
      if (p) lines.push(kit.tx('settings.redesign.judgments.pageStateMacroF1BlockerRecall', { macroF1: p.macroF1 == null ? 'n/a' : (p.macroF1 * 100).toFixed(1) + '%', rate: rate(p.blockerRecall), num: num(p.authAsUsable) }));
      if (so) lines.push(kit.tx('settings.redesign.judgments.socialStateControlUnsafe', { rate: rate(so.stateAccuracy), rate2: rate(so.candidateAccuracy), num: num(so.unsafeSelections) }));
      lines.push(kit.tx('settings.redesign.judgments.autoHealGatePageStateAdvice', { passed: g.autoHeal?.passed ? kit.tx('settings.redesign.judgments.passed') : kit.tx('settings.redesign.judgments.notPassed', { failed: (g.autoHeal?.failed || []).join(', ') }), passed2: g.pageStateAdvisory?.passed ? kit.tx('settings.redesign.judgments.passed') : kit.tx('settings.redesign.judgments.notPassed', { failed: (g.pageStateAdvisory?.failed || []).join(', ') }) }));
      lines.push(kit.tx('settings.redesign.judgments.benchLatency', { median: num(rep.latency?.medianMs), p95: num(rep.latency?.p95Ms), recorded: r.recorded?.recorded ? kit.tx('settings.redesign.judgments.recordedAsThisConfigurationSBenchmark') : kit.tx('settings.redesign.judgments.notRecorded', { reason: r.recorded?.reason || kit.tx('settings.redesign.judgments.unknown') }) }));
    }
    if (surface === 'desktop') {
      const rate = (x) => (x && x.value != null ? `${(x.value * 100).toFixed(1)}% (${x.numerator}/${x.of})` : 'n/a');
      const t = rep.target, g = rep.gates || {};
      if (t) lines.push(kit.tx('settings.redesign.judgments.desktopTop1AdvisedPrecisionAbstention', { rate: rate(t.top1), rate2: rate(t.precision), rate3: rate(t.abstention), rate4: rate(t.eligiblePrecision), rate5: rate(t.coverage), num: num(t.unsafePresses), num2: num(t.forbiddenPresses) }));
      lines.push(kit.tx('settings.redesign.judgments.pressByIntentGate', { passed: g.press?.passed ? kit.tx('settings.redesign.judgments.passed') : kit.tx('settings.redesign.judgments.notPassed', { failed: (g.press?.failed || []).join(', ') }) }));
      lines.push(kit.tx('settings.redesign.judgments.benchLatency', { median: num(rep.latency?.medianMs), p95: num(rep.latency?.p95Ms), recorded: r.recorded?.recorded ? kit.tx('settings.redesign.judgments.recordedAsThisConfigurationSBenchmark') : kit.tx('settings.redesign.judgments.notRecorded', { reason: r.recorded?.reason || kit.tx('settings.redesign.judgments.unknown') }) }));
    }
    if (a.importance) lines.push(kit.tx('settings.redesign.judgments.importanceMeanWithin1PointWithin', { meanAbsDelta: a.importance.meanAbsDelta, within1: a.importance.within1, of: a.importance.of, within2: a.importance.within2, of2: a.importance.of }));
    if (a.kind) lines.push(kit.tx('settings.redesign.judgments.kindAgree', { agree: a.kind.agree, of: a.kind.of, pct: pct(a.kind.rate) }));
    if (a.relation) lines.push(kit.tx('settings.redesign.judgments.relationsAgree', { agree: a.relation.agree, of: a.relation.of, pct: pct(a.relation.rate) }));
    if (a.historical) lines.push(kit.tx('settings.redesign.judgments.historicalAgree', { agree: a.historical.agree, of: a.historical.of, pct: pct(a.historical.rate) }));
    $('jv-bench-summary').innerHTML = `<strong>${escapeHtml(surface)}</strong> ${kit.th('settings.redesign.judgments.itemsJudged', { num: num(rep.n), num2: num(rep.judged), unavailable: rep.unavailable ? (" " + kit.th('settings.redesign.judgments.unavailable2', { num: num(rep.unavailable) })) : '' })} ${lines.map(escapeHtml).join(' · ')}<br>${num(rep.tokens.input)} ${kit.th('settings.redesign.judgments.tokensInAvgPerItemAvg', { num: num(rep.tokens.avgInputPerItem), num2: num(rep.latency.avgMs) })} ${money(rep.cost)}${r.file ? ` · <code>${escapeHtml(r.file.split('/').slice(-2).join('/'))}</code>` : ''}`;
    benchTable(rep);
    show($('jv-bench-result'), $('jv-bench-result').innerHTML, 'var(--s-darker)');
    toast(kit.tx('settings.redesign.judgments.benchDone', { surface, judged: num(rep.judged) }));
    loadConfig();
  });
  $('jv-ba-autoheal').addEventListener('change', () => putConfig({ browserAssist: { autoHealEnabled: $('jv-ba-autoheal').checked } },
    $('jv-ba-autoheal').checked ? kit.tx('settings.redesign.judgments.safeAutoHealIsOnOne') : kit.tx('settings.redesign.judgments.safeAutoHealIsOffAdvice')));
  $('jv-da-press').addEventListener('change', () => putConfig({ desktopAssist: { pressEnabled: $('jv-da-press').checked } },
    $('jv-da-press').checked ? kit.tx('settings.redesign.judgments.pressByIntentIsOnOne') : kit.tx('settings.redesign.judgments.pressByIntentIsOffAdvice')));
  $('jv-apply-importance').addEventListener('change', () => putConfig({ applyJudgedImportance: $('jv-apply-importance').checked }, $('jv-apply-importance').checked ? kit.tx('settings.redesign.judgments.judgedImportanceWillBeAppliedBy') : kit.tx('settings.redesign.judgments.judgedImportanceStaysRecordedOnly')));

  // ── Judgment log ──
  function logRow(row) {
    const answers = typeof row.answers === 'string' ? row.answers : JSON.stringify(row.answers, null, 2);
    const riders = Array.isArray(row.surfaces) ? row.surfaces.filter(x => x && x !== row.surface) : [];
    const outcome = row.outcome && typeof row.outcome === 'object' ? row.outcome : null;
    const summary = `${clock(row.created_at)} · <code>${escapeHtml(row.surface)}</code>${riders.map(x => ` <span style="${CHIP}">+${escapeHtml(x)}</span>`).join('')} ${kit.th('settings.redesign.judgments.qMs', { origin: escapeHtml(row.origin), model: escapeHtml(row.model || ''), num: num(row.question_count), num2: num(row.latency_ms), num3: num(row.input_tokens) })}${num(row.output_tokens)}${row.cached ? ' · <span style="color:var(--accent)">' + kit.te('settings.redesign.judgments.cached') + '</span>' : ''}${row.error ? ` · <span style="color:#f66">${escapeHtml(row.error)}</span>` : ''}${row.entity_id ? ` · ${memLink(row.entity_id)}` : ''}${row.session_id ? ` · <a href="#" class="jv-session-link" data-session="${attr(row.session_id)}" title="${attr(row.session_id)}${kit.te('settings.redesign.judgments.thisSessionSJudgments')}" style="${LINK};font-family:monospace">${kit.te('settings.redesign.judgments.session')} ${escapeHtml(shortId(row.session_id))}</a>` : ''}${row.project ? ` · ${escapeHtml(row.project)}` : ''}`;
    return `<details class="jv-log-row" data-id="${attr(row.id)}"${state.openLogIds.has(String(row.id)) ? ' open' : ''} style="font-size:12px;border:1px solid var(--s-medium);border-radius:6px;padding:4px 8px;background:var(--s-darker)">
      <summary style="cursor:pointer;list-style:none" title="${attr(row.created_at)}">${summary}</summary>
      <div class="settings-hint" style="margin:6px 0 2px">${kit.te('settings.redesign.judgments.state')}</div><pre style="margin:0;white-space:pre-wrap;font-size:11px;max-height:160px;overflow:auto">${escapeHtml(row.state_preview || '')}</pre>
      <div class="settings-hint" style="margin:6px 0 2px">${kit.te('settings.redesign.judgments.answers')}</div><pre style="margin:0;white-space:pre-wrap;font-size:11px;max-height:200px;overflow:auto">${escapeHtml(answers || '—')}</pre>
      ${outcome ? `<div class="settings-hint" style="margin:6px 0 2px">${kit.te('settings.redesign.judgments.outcome')}</div><pre style="${PRE}">${escapeHtml(JSON.stringify(outcome, null, 2))}</pre>` : ''}
    </details>`;
  }
  async function refreshLog(force = false) {
    if (!alive()) return;
    const filter = { surface: $('jv-log-surface').value, origin: $('jv-log-origin').value, limit: $('jv-log-limit').value,
      session: $('jv-log-session').value.trim(), entity: $('jv-log-entity').value.trim(), project: $('jv-log-project').value.trim() };
    storage.setItem(LOG_FILTER_KEY, JSON.stringify(filter));
    const qs = new URLSearchParams({ limit: filter.limit }); if (filter.surface) qs.set('surface', filter.surface); if (filter.origin) qs.set('origin', filter.origin);
    if (filter.entity) qs.set('entity', filter.entity);
    // An older server ignores session and project, so they are neither shown nor sent to it.
    if (serverV2(state.cfg)) { if (filter.session) qs.set('session', filter.session); if (filter.project) qs.set('project', filter.project); }
    const r = await jget(`/api/typesafe/log?${qs}`);
    if (r.ok === false) { setText($('jv-log-status'), r.error || 'unavailable'); return; }
    const signature = `${JSON.stringify(filter)}:${r.rows.length}:${r.rows[0]?.id ?? ''}`;
    setText($('jv-log-status'), kit.tx('settings.redesign.judgments.logRowsOf', { shown: num(r.rows.length), total: num(r.total) }));
    setText($('jv-log-badge'), kit.tx('settings.redesign.judgments.logRows', { total: num(r.total) }));
    if (!force && signature === state.lastLogSignature) return;
    state.lastLogSignature = signature;
    const list = $('jv-log-list');
    list.innerHTML = r.rows.length ? r.rows.map(logRow).join('') : '<div class="settings-hint">' + kit.te('settings.redesign.judgments.noJudgmentsLoggedYet') + '</div>';
  }
  $('jv-log-list').addEventListener('toggle', (e) => { const d = e.target; if (d?.classList?.contains('jv-log-row')) { if (d.open) state.openLogIds.add(d.dataset.id); else state.openLogIds.delete(d.dataset.id); } }, true);
  $('jv-log-refresh').addEventListener('click', () => refreshLog(true));
  for (const id of ['jv-log-surface', 'jv-log-origin', 'jv-log-limit']) $(id).addEventListener('change', () => refreshLog(true));
  const typedLogFilter = debounce(() => refreshLog(true), 500);
  for (const id of ['jv-log-session', 'jv-log-entity', 'jv-log-project']) {
    $(id).addEventListener('input', typedLogFilter);
    $(id).addEventListener('change', () => { typedLogFilter.cancel(); refreshLog(true); });
  }
  overlay.addEventListener('settings-close', () => typedLogFilter.cancel());
  /** Session and project filters exist only where the server can apply them; origins come from the server's list. */
  function syncLogFilters(cfg) {
    const v2 = serverV2(cfg);
    for (const id of ['jv-log-session', 'jv-log-project']) $(id).style.display = v2 ? '' : 'none';
    const origin = $('jv-log-origin');
    const want = Array.isArray(cfg.origins) ? cfg.origins.filter(o => typeof o === 'string' && o) : [];
    if (!want.length || document.activeElement === origin) return;
    if (Array.from(origin.options, o => o.value).filter(Boolean).join('|') === want.join('|')) return;
    const value = origin.value;
    // A select is as wide as its longest option, so the note on "live" goes in its tooltip.
    origin.innerHTML = '<option value="">' + kit.te('settings.redesign.judgments.allOrigins') + '</option>' + want.map(o => o === 'live'
      ? '<option value="live" title="' + kit.te('settings.redesign.judgments.everyOriginExceptBackfillAndBench') + '">' + kit.te('settings.redesign.judgments.liveRealTime') + '</option>'
      : `<option value="${attr(o)}">${escapeHtml(o)}</option>`).join('');
    origin.value = want.includes(value) ? value : '';
  }
  /** Point the log at one memory or one session, clearing the other filters, and bring it into view. */
  function filterLogBy({ entity = '', session = '' }) {
    for (const [id, value] of [['jv-log-surface', ''], ['jv-log-origin', ''], ['jv-log-project', ''], ['jv-log-entity', entity], ['jv-log-session', session]]) $(id).value = value;
    const sec = $('jv-sec-log');
    if (sec.classList.contains('collapsed')) sec.classList.remove('collapsed'); // the expand observer refreshes it
    else refreshLog(true);
    sec.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }
  // Memory ids and session ids anywhere in the tab (timeline, log, supersessions) filter the log.
  tabBody.addEventListener('click', (e) => {
    const link = e.target.closest?.('a.jv-entity, a.jv-session-link');
    if (!link) return;
    e.preventDefault();
    if (link.classList.contains('jv-entity')) filterLogBy({ entity: link.dataset.entity || '' });
    else filterLogBy({ session: link.dataset.session || '' });
  });

  // ── Misfiled ──
  async function refreshMisfiled() {
    if (!alive()) return;
    const r = await jget('/api/typesafe/category-checks?limit=50');
    const list = $('jv-misfiled-list');
    if (r.ok === false) { list.innerHTML = `<div class="settings-hint">${escapeHtml(r.error || kit.tx('settings.redesign.judgments.unavailable'))}</div>`; return; }
    setText($('jv-misfiled-badge'), `${num(r.total)}`);
    list.innerHTML = r.rows.length ? r.rows.map(row => `<div style="display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border:1px solid var(--s-medium);border-radius:8px;background:var(--s-darker);font-size:12px">
        <div style="flex:1;min-width:0"><div><code>${escapeHtml(row.category)}</code> → <code>${escapeHtml(row.category_judged)}</code> <span style="color:var(--t-muted)">(${pct(row.category_confidence)} · ${escapeHtml(row.project)} · ${escapeHtml(String(row.id).slice(0, 8))})</span></div><div class="settings-hint" style="margin:4px 0 0;white-space:pre-wrap">${escapeHtml(row.preview || '')}</div></div>
        <button class="conn-add-btn jv-mf-apply" data-id="${attr(row.id)}" style="${btnStyle}">${kit.te('settings.redesign.judgments.apply')}</button><button class="conn-add-btn jv-mf-dismiss" data-id="${attr(row.id)}" style="${btnStyle}">${kit.te('settings.redesign.judgments.dismiss')}</button>
      </div>`).join('') : '<div class="settings-hint">' + kit.te('settings.redesign.judgments.noDisagreementsRecordedNewWritesWill') + '</div>';
  }
  $('jv-misfiled-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-id]'); if (!btn) return;
    const action = btn.classList.contains('jv-mf-apply') ? 'apply' : 'dismiss';
    btn.disabled = true;
    const r = await jpost(`/api/typesafe/category-checks/${encodeURIComponent(btn.dataset.id)}`, { action });
    if (r.ok === false) { toast(kit.tx('settings.redesign.judgments.categoryCheck', { error: r.error })); btn.disabled = false; return; }
    toast(action === 'apply' ? kit.tx('settings.redesign.judgments.memoryMoved') : kit.tx('settings.redesign.judgments.dismissed'));
    refreshMisfiled();
  });

  // An endpoint this server does not have: a 404, or a 2xx that is not the JSON asked for (an SPA fallback, an empty object).
  const missingEndpoint = (r) => r.status === 404 || (r.status >= 200 && r.status < 300);

  // ── Coding sessions ──
  // One card per Claude Code session (GET /api/typesafe/sessions). Opening a card reads that
  // session's rows oldest first (GET /api/typesafe/log?session=…&order=asc) and gives each
  // surface its own line. Hidden on servers that predate session attribution.
  const knob = (surface, key, fallback) => { const v = state.cfg?.surfaces?.[surface]?.[key]; return fin(v) ? Number(v) : fallback; };
  const flagged = (html, on) => (on ? `<strong style="color:#ffc107">${html}</strong>` : html);
  const idList = (list) => (Array.isArray(list) ? list : []).map(x => (x && typeof x === 'object' ? x.id : x)).filter(x => x != null && x !== '').map(String);
  // Rider answers on the prompt turn: [answer key, label, the rider's surface, its default bar].
  const PROMPT_RIDERS = [['new_task', kit.tx('settings.redesign.judgments.newTask'), 'task-boundary', 0.6], ['past_session', kit.tx('settings.redesign.judgments.pastSession'), 'session-lookup', 0.7], ['reveals_preference', 'preference', 'user-learning', 0.7]];
  const STOP_ANSWERS = [
    ['human_blocker', kit.tx('settings.redesign.judgments.blockedOnAHuman'), () => 0.5], ['waiting_for_user', kit.tx('settings.redesign.judgments.waitingForTheUser'), () => 0.5],
    ['worth_remembering', kit.tx('settings.redesign.judgments.worthRemembering'), () => knob('turn-worth', 'minConfidence', 0.35)], ['unsupported_claim', kit.tx('settings.redesign.judgments.unsupportedClaim'), () => knob('claim-check', 'minProbability', 0.9)],
  ];
  const levelName = (c) => (typeof c.level === 'string' && c.level ? c.level.split(':')[0] : relevanceName(c.relevance)) || '—';
  function urgencyLine(row, a, o) {
    const parts = [];
    const u = a.urgency;
    if (u && typeof u === 'object' && typeof u.choice === 'string') parts.push(`${kit.te('settings.redesign.judgments.urgency')} <strong>${escapeHtml(u.choice)}</strong> ${pct(u.confidence)}`);
    for (const [key, label, surface, bar] of PROMPT_RIDERS) { const p = prob(a[key]); if (p != null) parts.push(flagged(`${label} ${pct(p)}`, p >= knob(surface, 'minProbability', bar))); }
    // The Assistant's recall gate records what it did with the answer.
    if (o && typeof o.decision === 'string' && o.decision) parts.push(`→ ${escapeHtml(o.decision)}${o.fallback === true ? (" " + kit.tx('settings.redesign.judgments.regexFallback')) : ''}`);
    return { line: parts.join(' · ') };
  }
  function rankLine(row, a, o) {
    if (!o || !Array.isArray(o.candidates)) return { line: '' };
    const injected = new Set(idList(o.injected)), dropped = new Set(idList(o.dropped));
    const rel = (c) => (fin(c.relevance) ? Number(c.relevance) : -1);
    const candidates = o.candidates.filter(c => c && typeof c === 'object').sort((x, y) => rel(y) - rel(x));
    const fate = (id) => injected.has(id) ? '<span style="color:var(--accent)">' + kit.te('settings.redesign.judgments.injected') + '</span>' : dropped.has(id) ? '<span style="color:#ffc107">' + kit.te('settings.redesign.judgments.dropped') + '</span>' : '<span style="color:var(--t-muted)">' + kit.te('settings.redesign.judgments.notInjected') + '</span>';
    const detail = candidates.length ? `<div class="settings-hint" style="margin:6px 0 2px">${num(candidates.length)} ${kit.te('settings.redesign.judgments.judgedMostRelevantFirst')}</div><div class="jv-tl-candidates" style="display:flex;flex-direction:column;gap:2px;font-size:11px">${candidates.map(c => `<div>${memLink(c.id)} · ${escapeHtml(levelName(c))}${fin(c.relevance) ? ` ${Number(c.relevance).toFixed(1)}` : ''} · ${fate(String(c.id ?? ''))}</div>`).join('')}</div>` : '';
    // Withheld: the Assistant's urgency judgment declined the turn, so nothing was injected or committed.
    const withheld = typeof o.withheld === 'string' && o.withheld ? (" " + kit.th('settings.redesign.judgments.logWithheld', { reason: escapeHtml(o.withheld) })) : '';
    return { line: kit.th('settings.redesign.judgments.logInjected', { injected: num(injected.size), dropped: num(dropped.size), floor: fin(o.floor) ? kit.te('settings.redesign.judgments.logFloor', { floor: Number(o.floor).toFixed(1) }) : kit.te('settings.redesign.judgments.noFloor'), withheld }), detail };
  }
  // Assistant workers (worker-outcome, rider worker-claim): what Jev read, and what the dispatcher did with it.
  function workerLine(row, a, o) {
    const parts = [];
    const s = a.status, c = a.cause;
    // A judgment under minConfidence was logged but not applied: say so, so it doesn't read as missing.
    const bar = knob('worker-outcome', 'minConfidence', 0.7);
    const below = (answer, applied) => (applied === false || (applied == null && Number(answer.confidence) < bar)) ? ` (below ${pct(bar)})` : '';
    if (s && typeof s === 'object' && typeof s.choice === 'string') parts.push(`${kit.te('settings.redesign.judgments.status')} <strong>${escapeHtml(s.choice)}</strong> ${pct(s.confidence)}${s.choice === 'unclear' ? '' : below(s, o?.applied?.status)}`);
    if (c && typeof c === 'object' && typeof c.choice === 'string') parts.push(kit.th('settings.redesign.judgments.logCause', { cause: `${escapeHtml(c.choice)} ${pct(c.confidence)}${below(c, o?.applied?.cause)}` }));
    const p = prob(a.unsupported_claim);
    if (p != null) parts.push(flagged(kit.tx('settings.redesign.judgments.unsupportedClaim2', { pct: pct(p) }), p >= knob('worker-claim', 'minProbability', 0.9)));
    if (o?.retried === true) parts.push(kit.tx('settings.redesign.judgments.retryTurn'));
    if (o && typeof o.escalation === 'string' && o.escalation) parts.push(`→ ${escapeHtml(o.escalation)}`);
    return { line: parts.join(' · ') };
  }
  function stopLine(row, a) {
    const parts = [];
    for (const [key, label, bar] of STOP_ANSWERS) { const p = prob(a[key]); if (p != null) parts.push(flagged(`${label} ${pct(p)}`, p >= bar())); }
    return { line: parts.join(' · ') };
  }
  function staleLine(row, a, o) {
    const out = o || {};
    const p = fin(out.probability) ? Number(out.probability) : prob(a.accurate);
    const stale = typeof out.stale === 'boolean' ? out.stale : (row.surface === 'edit-stale' && p != null ? p < knob('edit-stale', 'minProbability', 0.4) : null);
    const file = out.file ? `<span title="${attr(out.file)}" style="font-family:monospace">${escapeHtml(String(out.file).split(/[\\/]/).slice(-3).join('/'))}</span>` : '';
    return { line: [file, row.entity_id ? kit.th('settings.redesign.judgments.logMemory', { memory: memLink(row.entity_id) }) : '', p != null ? kit.tx('settings.redesign.judgments.pStillAccurate', { pct: pct(p) }) : '', stale == null ? '' : stale ? flagged('stale', true) : kit.tx('settings.redesign.judgments.notStale')].filter(Boolean).join(' · ') };
  }
  function planLine(row, a, o) {
    if (!o) return { line: '' };
    const conflicts = idList(o.conflicts);
    const checked = fin(o.checked) ? (" " + kit.tx('settings.redesign.judgments.logOfChecked', { checked: num(o.checked) })) : '';
    return { line: conflicts.length ? `${flagged(kit.tx(conflicts.length === 1 ? 'settings.redesign.judgments.logConflicts.one' : 'settings.redesign.judgments.logConflicts.other', { count: num(conflicts.length) }), true)}${checked}: ${conflicts.map(memLink).join(', ')}` : kit.tx('settings.redesign.judgments.noConflicts', { checked: checked }) };
  }
  function digestLine(row, a, o) {
    if (!o) return { line: '' };
    const picked = Array.isArray(o.picked) ? o.picked.length : o.picked;
    return { line: kit.tx('settings.redesign.judgments.logPicked', { picked: fin(picked) ? num(picked) : '—', of: fin(o.of) ? num(o.of) : '—' }) };
  }
  function loopLine(row, a) {
    const p = prob(a.goal_met);
    return { line: p == null ? '' : flagged(kit.tx('settings.redesign.judgments.pGoalMet', { pct: pct(p) }), p >= knob('loop-goal', 'minConfidence', 0.8)) };
  }
  const TIMELINE = {
    'prompt-urgency': urgencyLine, 'rerank': rankLine, 'brief-rank': rankLine,
    'agent-message': stopLine, 'turn-worth': stopLine, 'claim-check': stopLine,
    'edit-stale': staleLine, 'stale-check': staleLine, 'plan-conflict': planLine, 'compact-digest': digestLine, 'loop-goal': loopLine,
    'worker-outcome': workerLine, 'worker-claim': workerLine,
  };
  const SHOWS_ENTITY = new Set(['edit-stale', 'stale-check']);
  // Rows whose entity is an Assistant run id, not a memory.
  const RUN_ENTITY = new Set(['worker-outcome', 'worker-claim']);
  function timelineRow(row) {
    const a = row.answers && typeof row.answers === 'object' ? row.answers : {};
    const o = row.outcome && typeof row.outcome === 'object' ? row.outcome : null;
    let view = { line: '' };
    const format = Object.prototype.hasOwnProperty.call(TIMELINE, row.surface) ? TIMELINE[row.surface] : null;
    try { view = format?.(row, a, o) || view; } catch { view = { line: '' }; }
    // Anything without a formatter, or with nothing to show, gets the compact line.
    const line = view.line || (row.error ? kit.tx('settings.redesign.judgments.noAnswer') : `q×${num(row.question_count)}`);
    const riders = Array.isArray(row.surfaces) ? row.surfaces.filter(x => x && x !== row.surface) : [];
    const meta = [`${num(row.latency_ms)} ms`, row.cached ? '<span style="color:var(--accent)">' + kit.te('settings.redesign.judgments.cached') + '</span>' : '', row.error ? `<span style="color:#f66">${escapeHtml(row.error)}</span>` : '',
      row.entity_id && !SHOWS_ENTITY.has(row.surface) ? (RUN_ENTITY.has(row.surface) ? `${kit.te('settings.redesign.judgments.run')} <code title="${attr(row.entity_id)}">${escapeHtml(shortId(row.entity_id))}</code>` : kit.th('settings.redesign.judgments.logMemory', { memory: memLink(row.entity_id) })) : '', row.origin ? escapeHtml(row.origin) : ''].filter(Boolean).join(' · ');
    const answers = typeof row.answers === 'string' ? row.answers : JSON.stringify(row.answers ?? null, null, 2);
    return `<details class="jv-tl-row" data-id="${attr(row.id)}" data-surface="${attr(row.surface)}"${state.openTimelineIds.has(String(row.id)) ? ' open' : ''} style="font-size:12px;border:1px solid var(--s-medium);border-radius:6px;padding:3px 8px;background:var(--s-darker)">
      <summary style="cursor:pointer;list-style:none" title="${attr(row.created_at)}">${clock(row.created_at)} · <code>${escapeHtml(row.surface)}</code>${riders.map(x => ` <span style="${CHIP}">+${escapeHtml(x)}</span>`).join('')} · <span class="jv-tl-line">${line}</span> <span style="color:var(--t-muted)">· ${meta}</span></summary>
      ${view.detail || ''}
      <div class="settings-hint" style="margin:6px 0 2px">${kit.te('settings.redesign.judgments.state')}</div><pre style="${PRE}">${escapeHtml(row.state_preview || '')}</pre>
      <div class="settings-hint" style="margin:6px 0 2px">${kit.te('settings.redesign.judgments.answers')}</div><pre style="${PRE}">${escapeHtml(answers || '—')}</pre>
      ${o ? `<div class="settings-hint" style="margin:6px 0 2px">${kit.te('settings.redesign.judgments.outcome')}</div><pre style="${PRE}">${escapeHtml(JSON.stringify(o, null, 2))}</pre>` : ''}
    </details>`;
  }
  function timelineHtml(sessionId, rows) {
    if (!rows.length) return '<div class="settings-hint">' + kit.te('settings.redesign.judgments.noJudgmentsLoggedForThisSession') + '</div>';
    return `<div class="settings-hint" style="margin:0 0 6px">${num(rows.length)} ${kit.th('settings.redesign.judgments.judgmentOldestFirst', { count: rows.length === 1 ? '' : 's', count2: rows.length >= TIMELINE_LIMIT ? (" " + kit.th('settings.redesign.judgments.theFirst', { num: num(TIMELINE_LIMIT) })) : '' })} <a href="#" class="jv-session-link" data-session="${attr(sessionId)}" style="${LINK}">${kit.te('settings.redesign.judgments.openInTheJudgmentLog')}</a></div>
      <div style="display:flex;flex-direction:column;gap:3px">${rows.map(timelineRow).join('')}</div>`;
  }
  const sessionKey = (s) => (s ? `${s.calls}:${s.last_at}` : '');
  // Assistant sessions log as assistant-<uuid>: show the part that tells them apart.
  const sessionLabel = (id) => (/^assistant-/.test(String(id ?? '')) ? kit.tx('settings.redesign.judgments.assistantSession', { id: String(id).slice(10, 18) }) : shortId(id));
  const sessionCardEl = (id) => Array.from($('jv-sessions-list').querySelectorAll('details.jv-sess')).find(d => d.dataset.session === id) || null;
  function sessionCard(s) {
    const id = String(s.session_id ?? '');
    const first = Date.parse(s.first_at), last = Date.parse(s.last_at);
    const sameDay = fin(first) && fin(last) && new Date(first).toDateString() === new Date(last).toDateString();
    const lastText = sameDay ? new Date(last).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : when(s.last_at);
    const span = fin(first) && fin(last) && last - first >= 1000 ? ` (${duration(last - first)})` : '';
    const counts = s.surfaces && typeof s.surfaces === 'object' ? Object.entries(s.surfaces).filter(([, n]) => Number(n) > 0).sort((x, y) => Number(y[1]) - Number(x[1])) : [];
    return `<details class="jv-sess" data-session="${attr(id)}"${state.openSessions.has(id) ? ' open' : ''} style="font-size:12px;border:1px solid var(--s-medium);border-radius:8px;padding:6px 10px;background:var(--s-darker)">
      <summary style="cursor:pointer" title="${attr(id)}"><code>${escapeHtml(sessionLabel(id) || '—')}</code> ${kit.th('settings.redesign.judgments.judgment', { project: escapeHtml(s.project || kit.tx('settings.redesign.judgments.noProject')), when: escapeHtml(when(s.first_at)), lastText: escapeHtml(lastText), span: escapeHtml(span), num: num(s.calls) })}${Number(s.calls) === 1 ? '' : 's'}${Number(s.failures) ? ` · <span style="color:#f66">${num(s.failures)} ${kit.te('settings.redesign.judgments.failed')}</span>` : ''}
        <span class="jv-sess-chips" style="display:flex;flex-wrap:wrap;gap:4px;margin:4px 0 0 14px">${counts.map(([name, n]) => `<span style="${CHIP}">${escapeHtml(name)} ${num(n)}</span>`).join('')}</span>
      </summary>
      <div class="jv-sess-timeline" style="margin-top:8px">${state.timelineHtml.get(id) || '<div class="settings-hint">' + kit.te('settings.redesign.judgments.loading') + '</div>'}</div>
    </details>`;
  }
  function renderSessionsMeta(cfg) {
    const sec = $('jv-sec-sessions');
    const available = serverV2(cfg) && !state.sessionsUnsupported;
    sec.style.display = available ? '' : 'none';
    if (available && !state.sessionsBooted && !sec.classList.contains('collapsed')) { state.sessionsBooted = true; refreshSessions(true); }
  }
  async function refreshSessions(force = false) {
    if (!alive()) return;
    const sec = $('jv-sec-sessions');
    if (!serverV2(state.cfg) || state.sessionsUnsupported) { sec.style.display = 'none'; return; }
    state.sessionsBooted = true;
    const qs = new URLSearchParams({ since: new Date(Date.now() - SESSIONS_DAYS * 864e5).toISOString(), limit: '30' });
    const r = await jget(`/api/typesafe/sessions?${qs}`);
    if (!alive()) return;
    if (!Array.isArray(r.rows)) {
      if (missingEndpoint(r)) { state.sessionsUnsupported = true; sec.style.display = 'none'; return; }
      setText($('jv-sessions-status'), r.error || 'unavailable');
      return;
    }
    const rows = r.rows.filter(s => s && typeof s === 'object' && s.session_id != null && s.session_id !== '');
    state.sessions = new Map(rows.map(s => [String(s.session_id), s]));
    setText($('jv-sessions-badge'), kit.tx(rows.length === 1 ? 'settings.redesign.judgments.sessionsBadge.one' : 'settings.redesign.judgments.sessionsBadge.other', { count: num(rows.length), days: SESSIONS_DAYS }));
    setText($('jv-sessions-status'), rows.length ? kit.tx('settings.redesign.judgments.theMostRecentNewestActivityFirst', { num: num(rows.length) }) : '');
    const signature = rows.map(s => `${s.session_id}:${sessionKey(s)}`).join('|');
    if (force || signature !== state.sessionsSignature) {
      state.sessionsSignature = signature;
      $('jv-sessions-list').innerHTML = rows.length ? rows.map(sessionCard).join('')
        : `<div class="settings-hint">${kit.th('settings.redesign.judgments.noJudgmentsCarryASessionId', { SESSIONS_DAYS: SESSIONS_DAYS })}</div>`;
    }
    // Open timelines follow their session: reload when it gained judgments (or on an explicit refresh).
    for (const id of state.openSessions) if (state.sessions.has(id) && (force || state.timelineKeys.get(id) !== sessionKey(state.sessions.get(id)))) loadTimeline(id);
  }
  async function loadTimeline(id) {
    if (state.timelineLoading.has(id)) return;
    state.timelineLoading.add(id);
    state.timelineKeys.set(id, sessionKey(state.sessions.get(id)));
    try {
      const r = await jget(`/api/typesafe/log?${new URLSearchParams({ session: id, order: 'asc', limit: String(TIMELINE_LIMIT) })}`);
      if (!alive()) return;
      let html;
      if (Array.isArray(r.rows)) {
        // Only this session's rows, oldest first, even from a server that ignores `session` or `order`.
        const rows = r.rows.filter(row => row && typeof row === 'object' && String(row.session_id ?? '') === id);
        if (rows.every(row => fin(row.id))) rows.sort((x, y) => Number(x.id) - Number(y.id));
        html = timelineHtml(id, rows); state.timelineHtml.set(id, html);
      } else {
        html = `<div class="settings-hint" style="color:#f66">${escapeHtml(r.error || kit.tx('settings.redesign.judgments.theTimelineIsUnavailable'))}</div>`;
        state.timelineKeys.delete(id);
      }
      const box = sessionCardEl(id)?.querySelector('.jv-sess-timeline');
      if (box) box.innerHTML = html;
    } catch (error) {
      // Called without await (a toggle, a poll): render the failure rather than reject.
      state.timelineKeys.delete(id);
      const box = sessionCardEl(id)?.querySelector('.jv-sess-timeline');
      if (box) box.innerHTML = `<div class="settings-hint" style="color:#f66">${escapeHtml(error?.message || kit.tx('settings.redesign.judgments.theTimelineCouldNotBeDrawn'))}</div>`;
    } finally { state.timelineLoading.delete(id); }
  }
  // <details> toggles do not bubble; capture them. Re-rendered open cards fire one too, which is harmless.
  $('jv-sessions-list').addEventListener('toggle', (e) => {
    const d = e.target;
    if (d?.classList?.contains('jv-tl-row')) { if (d.open) state.openTimelineIds.add(d.dataset.id); else state.openTimelineIds.delete(d.dataset.id); return; }
    if (!d?.classList?.contains('jv-sess')) return;
    const id = d.dataset.session;
    if (!d.open) { state.openSessions.delete(id); return; }
    state.openSessions.add(id);
    if (!state.timelineHtml.has(id)) loadTimeline(id);
  }, true);
  $('jv-sessions-refresh').addEventListener('click', () => refreshSessions(true));

  // ── Superseded by Jev ──
  function renderSupersessionsMeta(cfg) {
    const sec = $('jv-sec-supersessions');
    const info = cfg.supersessions && typeof cfg.supersessions === 'object' ? cfg.supersessions : null;
    if (!info || state.supersessionsUnsupported) { sec.style.display = 'none'; return; }
    sec.style.display = '';
    setText($('jv-supersessions-badge'), kit.tx('settings.redesign.judgments.supersessionsActive', { count: num(info.active) }));
    if (!state.supersessionsBooted && !sec.classList.contains('collapsed')) { state.supersessionsBooted = true; refreshSupersessions(); }
  }
  function supersessionRow(row) {
    const side = (label, id, created, preview, dim) => `<div style="min-width:0"><div class="settings-hint" style="margin:0 0 2px">${label} · ${memLink(id)} · ${escapeHtml(day(created))}</div><div style="white-space:pre-wrap;overflow-wrap:anywhere${dim ? ';opacity:.75' : ''}">${escapeHtml(preview || '')}</div></div>`;
    return `<div class="jv-ss-row" data-id="${attr(row.id)}" style="padding:8px 10px;border:1px solid var(--s-medium);border-radius:8px;background:var(--s-darker);font-size:12px">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <span style="flex:1;min-width:0"><code>${escapeHtml(row.category || '—')}</code> ${kit.th('settings.redesign.judgments.recorded', { project: escapeHtml(row.project || kit.tx('settings.redesign.judgments.noProject')) })} ${escapeHtml(when(row.created_at))}${row.automatic ? (" " + kit.te('settings.redesign.judgments.byJev')) : ' · <span style="color:var(--accent)">' + kit.te('settings.redesign.judgments.kept') + '</span>'}</span>
        ${row.automatic ? `<button class="conn-add-btn jv-ss-keep" data-id="${attr(row.id)}" style="${btnStyle}">${kit.te('settings.redesign.judgments.keep')}</button>` : ''}<button class="conn-add-btn jv-ss-undo" data-id="${attr(row.id)}" style="${btnStyle}">${kit.te('settings.redesign.judgments.undo')}</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:6px">${side(kit.tx('settings.redesign.judgments.newerCurrent'), row.from_id, row.from_created_at, row.from_preview, false)}${side(kit.tx('settings.redesign.judgments.olderOutOfCurrentRecall'), row.to_id, row.to_created_at, row.to_preview, true)}</div>
    </div>`;
  }
  async function refreshSupersessions() {
    if (!alive()) return;
    const sec = $('jv-sec-supersessions'), list = $('jv-supersessions-list');
    if (!state.cfg?.supersessions || state.supersessionsUnsupported) { sec.style.display = 'none'; return; }
    state.supersessionsBooted = true;
    const r = await jget('/api/typesafe/supersessions?limit=50');
    if (!alive()) return;
    if (!Array.isArray(r.rows)) {
      if (missingEndpoint(r)) { state.supersessionsUnsupported = true; sec.style.display = 'none'; return; }
      list.innerHTML = `<div class="settings-hint">${escapeHtml(r.error || kit.tx('settings.redesign.judgments.unavailable'))}</div>`;
      return;
    }
    const rows = r.rows.filter(row => row && typeof row === 'object');
    setText($('jv-supersessions-status'), rows.length ? kit.tx('settings.redesign.judgments.showingOfNewestFirst', { num: num(rows.length), num2: num(fin(r.total) ? r.total : rows.length) }) : '');
    list.innerHTML = rows.length ? rows.map(supersessionRow).join('')
      : '<div class="settings-hint">' + kit.te('settings.redesign.judgments.nothingSupersededWhenMaintenanceRelatesA') + '</div>';
  }
  $('jv-supersessions-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button.jv-ss-undo, button.jv-ss-keep'); if (!btn) return;
    const action = btn.classList.contains('jv-ss-undo') ? 'undo' : 'keep';
    btn.disabled = true;
    const r = await jpost(`/api/typesafe/supersessions/${encodeURIComponent(btn.dataset.id)}`, { action });
    if (r.ok === false) { toast(kit.tx('settings.redesign.judgments.errSupersession', { error: r.error || kit.tx('settings.redesign.judgments.failed') })); btn.disabled = false; return; }
    toast(action === 'undo' ? kit.tx('settings.redesign.judgments.undoneTheOlderMemoryIsBack') : kit.tx('settings.redesign.judgments.keptTheRelationIsConfirmed'));
    await refreshSupersessions();
    loadConfig();
  });

  // ── Trash triage ──
  // The server streams NDJSON snapshots (?stream=1) so rows show while batches
  // are still being judged; a plain JSON answer renders the same way.
  async function streamTriage(url, onSnapshot) {
    state.triageAbort?.abort();
    const controller = new AbortController();
    state.triageAbort = controller;
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok || !(res.headers.get('content-type') || '').includes('ndjson') || !res.body?.getReader) return await readJson(res);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          let payload;
          try { payload = JSON.parse(line); } catch { continue; }
          if (payload.done || payload.ok === false) return payload;
          onSnapshot(payload);
        }
      }
      return { ok: false, error: kit.tx('settings.redesign.judgments.theTriageStreamEndedEarly') };
    } catch (error) {
      return { ok: false, error: error?.name === 'AbortError' ? kit.tx('settings.redesign.judgments.cancelled') : (error?.message || kit.tx('settings.redesign.judgments.networkError')), status: 0 };
    } finally {
      if (state.triageAbort === controller) state.triageAbort = null;
    }
  }
  function triageRow(row, pending) {
    const scoreText = row.expendability == null ? (pending ? '…' : '—') : Number(row.expendability).toFixed(1);
    return `<div data-row="${attr(row.id)}" style="display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border:1px solid var(--s-medium);border-radius:8px;background:var(--s-darker);font-size:12px">
        <input type="checkbox" class="jv-tr-pick" aria-label="${kit.te('settings.redesign.judgments.name.triagePick')}" data-id="${attr(row.id)}"${state.triageSelected.has(row.id) ? ' checked' : ''} style="margin-top:3px;flex:0 0 auto">
        <div style="min-width:60px;text-align:center"><div style="font-size:16px;font-weight:700">${escapeHtml(scoreText)}</div><div class="settings-hint" style="margin:0">${escapeHtml(row.level || '')}</div></div>
        <div style="flex:1;min-width:0"><div><code>${escapeHtml(row.category)}</code> ${kit.th('settings.redesign.judgments.importance2', { project: escapeHtml(row.project), importance: escapeHtml(String(row.importance)) })} ${escapeHtml(row.reasons?.join(', ') || '')}</div><div class="settings-hint" style="margin:4px 0 0;white-space:pre-wrap">${escapeHtml(row.preview || '')}</div></div>
        <button class="conn-add-btn jv-tr-trash" data-id="${attr(row.id)}" style="${btnStyle}">${kit.te('settings.redesign.judgments.moveToTrash')}</button>
      </div>`;
  }
  /** Renders the last answer: the page of rows, the status line and the selection controls. */
  function renderTriage(r) {
    if (r) state.triageLast = r;
    const answer = state.triageLast;
    if (!answer) return;
    const rows = (answer.rows || []).filter(row => !state.triageTrashed.has(row.id));
    const pending = Number(answer.pending || 0);
    const shown = pending ? rows.length : Math.min(state.triagePage * TRIAGE_PAGE, rows.length);
    const unjudged = answer.judged ? rows.filter(row => row.expendability == null).length : 0;
    setText($('jv-triage-status'), pending
      ? kit.tx('settings.redesign.judgments.judgingOfCandidatesLeft', { num: num(pending), num2: num(answer.candidates) })
      : kit.tx('settings.redesign.judgments.triageShowing', { shown: num(shown), total: num(rows.length), detail: " " + (answer.judged ? kit.tx('settings.redesign.judgments.triageJudged', { saved: answer.saved ? (" " + kit.tx('settings.redesign.judgments.fromSavedScores', { num: num(answer.saved) })) : '', unjudged: unjudged ? (" " + kit.tx('settings.redesign.judgments.notJudgedThisTime', { num: num(unjudged) })) : '' }) : kit.tx('settings.redesign.judgments.fallbackOrdering')) }));
    setText($('jv-triage-badge'), `${num(rows.length)}`);
    $('jv-triage-list').innerHTML = rows.length ? rows.slice(0, shown).map(row => triageRow(row, pending)).join('') : '<div class="settings-hint">' + kit.te('settings.redesign.judgments.noCandidatesFound') + '</div>';
    const remaining = rows.length - shown;
    $('jv-triage-more-wrap').style.display = remaining > 0 ? 'block' : 'none';
    setText($('jv-triage-more'), kit.tx('settings.redesign.judgments.showMoreLeft', { num: num(remaining) }));
    $('jv-triage-bulk').style.display = rows.length ? 'flex' : 'none';
    for (const id of [...state.triageSelected]) if (!rows.some(row => row.id === id)) state.triageSelected.delete(id);
    const picks = Array.from($('jv-triage-list').querySelectorAll('input.jv-tr-pick'));
    $('jv-triage-all').checked = picks.length > 0 && picks.every(pick => pick.checked);
    renderTriageSelection();
  }
  function renderTriageSelection() {
    const btn = $('jv-triage-trash-selected');
    const count = state.triageSelected.size;
    btn.disabled = count === 0;
    setText(btn, state.armed.triage && count ? kit.tx('settings.redesign.judgments.triageConfirm', { count: num(count) }) : kit.tx('settings.redesign.judgments.moveToTrash2', { num: num(count) }));
  }
  $('jv-triage-run').addEventListener('click', async () => {
    const btn = $('jv-triage-run'); btn.disabled = true; $('jv-triage-spinner').style.display = 'inline';
    state.triageTrashed = new Set(); state.triageSelected = new Set(); state.triageLast = null; state.triagePage = 1; state.armed.triage = false;
    const qs = new URLSearchParams({ limit: TRIAGE_LIMIT, stream: '1' }); const project = $('jv-triage-project').value.trim(); if (project) qs.set('project', project);
    setText($('jv-triage-status'), kit.tx('settings.redesign.judgments.findingCandidates'));
    const r = await streamTriage(`/api/trash/candidates?${qs}`, renderTriage);
    btn.disabled = false; $('jv-triage-spinner').style.display = 'none';
    if (r.ok === false) { setText($('jv-triage-status'), r.status === 404 ? kit.tx('settings.redesign.judgments.notAvailableOnThisServerYet') : (r.error || 'unavailable')); return; }
    renderTriage(r);
  });
  $('jv-triage-more').addEventListener('click', () => { state.triagePage++; renderTriage(); });
  $('jv-triage-all').addEventListener('change', () => {
    for (const pick of $('jv-triage-list').querySelectorAll('input.jv-tr-pick')) {
      pick.checked = $('jv-triage-all').checked;
      if (pick.checked) state.triageSelected.add(pick.dataset.id); else state.triageSelected.delete(pick.dataset.id);
    }
    state.armed.triage = false;
    renderTriageSelection();
  });
  $('jv-triage-list').addEventListener('change', (e) => {
    const pick = e.target.closest('input.jv-tr-pick'); if (!pick) return;
    if (pick.checked) state.triageSelected.add(pick.dataset.id); else state.triageSelected.delete(pick.dataset.id);
    state.armed.triage = false;
    const picks = Array.from($('jv-triage-list').querySelectorAll('input.jv-tr-pick'));
    $('jv-triage-all').checked = picks.length > 0 && picks.every(box => box.checked);
    renderTriageSelection();
  });
  $('jv-triage-trash-selected').addEventListener('click', async () => {
    const ids = [...state.triageSelected];
    if (!ids.length) return;
    if (!state.armed.triage) {
      state.armed.triage = true; renderTriageSelection();
      setTimeout(() => { if (state.armed.triage) { state.armed.triage = false; renderTriageSelection(); } }, 5000);
      return;
    }
    state.armed.triage = false;
    const btn = $('jv-triage-trash-selected'); btn.disabled = true;
    const r = await jpost('/api/trash/candidates/trash-selected', { ids });
    if (r.ok === false) { toast(kit.tx('settings.redesign.judgments.errTrash', { error: r.error })); renderTriageSelection(); return; }
    for (const id of ids) state.triageTrashed.add(id);
    state.triageSelected.clear();
    renderTriage();
    toast(kit.tx('settings.redesign.judgments.movedToTrashRestorableFromThe2', { num: num(r.trashed), count: r.skipped?.length ? (" " + kit.tx('settings.redesign.judgments.skipped2', { num: num(r.skipped.length) })) : '' }));
  });
  $('jv-triage-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button.jv-tr-trash'); if (!btn) return;
    btn.disabled = true;
    const r = await jpost(`/api/trash/candidates/${encodeURIComponent(btn.dataset.id)}/trash`);
    if (r.ok === false) { toast(kit.tx('settings.redesign.judgments.errTrash', { error: r.error })); btn.disabled = false; return; }
    state.triageTrashed.add(btn.dataset.id);
    state.triageSelected.delete(btn.dataset.id);
    renderTriage();
    toast(kit.tx('settings.redesign.judgments.movedToTrashRestorableFromThe'));
  });

  // ── Timers ──
  function startTimer(name, ms, fn) {
    if (state.timers[name]) return;
    state.timers[name] = setInterval(() => { if (!alive()) return stopAll(); fn().catch?.(() => {}); }, ms);
  }
  function stopTimer(name) { if (state.timers[name]) clearInterval(state.timers[name]); delete state.timers[name]; }
  function stopAll() { for (const name of Object.keys(state.timers)) stopTimer(name); for (const fn of surfaceDebounce.values()) fn.cancel?.(); expandObserver.disconnect(); state.triageAbort?.abort(); }
  overlay.addEventListener('settings-close', stopAll);
  startTimer('config', 5000, async () => { if (tabActive()) await loadConfig(); });
  startTimer('log', 5000, async () => { if (tabActive() && !$('jv-sec-log').classList.contains('collapsed')) await refreshLog(); });
  startTimer('sessions', 10000, async () => { const sec = $('jv-sec-sessions'); if (tabActive() && sec.style.display !== 'none' && !sec.classList.contains('collapsed')) await refreshSessions(); });

  // ── Boot ──
  if (initial && initial.ok !== false) applyConfig(initial); else loadConfig();
  jget('/api/typesafe/backfill/status').then(r => { if (r.ok) applyBackfill(r.backfill); });
  if (!$('jv-sec-log').classList.contains('collapsed')) refreshLog(true);
  if (!$('jv-sec-misfiled').classList.contains('collapsed')) refreshMisfiled();
}
