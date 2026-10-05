// ═══════════════════════════════════════════
// SETTINGS — information architecture
// ═══════════════════════════════════════════
//
// The one description of how Settings is organised: groups → pages → panes →
// sections. Pure data and pure functions, no DOM and no imports, so the shell
// (ui-settings.js), the tests and the docs all read the same list.
//
//   group    a nav heading
//   page     one nav destination (`data-tab` on the nav item and on its body)
//   pane     the markup one builder owns (`.stg-pane[data-pane]`); the old tab ids
//   section  one card on a page (`[data-stg-section]`). Every section is an accordion
//            the user opens and closes; on first use only the first section of a
//            page is open (sectionOpensByDefault), and the choices are remembered.
//            `state` says what kind of section it is:
//              'open'      an everyday section
//              'advanced'  wears the "Advanced" tag
//   control  one row of a section, named by its inventory id (GEN001 …): SETTINGS_CONTROLS.
//            Search (settings-search.js) lists them, and a deep link may name one.
//
// Every old `{ tab, expand, highlight, scrollTo }` deep link still resolves:
// see resolveSettingsTarget().

const k = (path) => `settings.redesign.${path}`;

export const SETTINGS_GROUPS = [
  { id: 'get_started', labelKey: k('group.get_started') },
  { id: 'memory_data', labelKey: k('group.memory_data') },
  { id: 'tools',       labelKey: k('group.tools') },
  { id: 'automations', labelKey: k('group.automations') },
  { id: 'personalize', labelKey: k('group.personalize') },
];

/** `key` is the i18n slug under settings.redesign.{nav,page,section}; `icon` names a TAB_ICONS entry. */
export const SETTINGS_PAGES = [
  {
    id: 'ai-connections', key: 'ai_connections', group: 'get_started', icon: 'setup',
    panes: [{ id: 'setup' }, { id: 'terminal' }, { id: 'opencode', titleKey: k('pane.opencode') }],
    sections: [
      { id: 'stg-sec-assistants',       key: 'your_assistants',            state: 'open' },
      { id: 'setup-rules',              key: 'synabun_rules',              state: 'open' },
      { id: 'stg-sec-manual-setup',     key: 'manual_setup',               state: 'open' },
      { id: 'cc-cli-paths',             key: 'executable_paths',           state: 'open' },
      { id: 'stg-sec-opencode-service', key: 'opencode_service_providers', state: 'open' },
      { id: 'stg-sec-opencode-behavior', key: 'opencode_behavior',         state: 'advanced' },
      { id: 'stg-sec-opencode-tools',   key: 'opencode_tool_access',       state: 'advanced' },
      { id: 'stg-sec-opencode-history', key: 'opencode_history',           state: 'advanced' },
    ],
  },
  {
    id: 'memory-backups', key: 'memory_backups', group: 'memory_data', icon: 'collections',
    panes: [{ id: 'server' }, { id: 'collections' }, { id: 'memory' }],
    sections: [
      { id: 'stg-sec-database',      key: 'database',      state: 'open' },
      { id: 'stg-sec-backups',       key: 'backups',       state: 'open' },
      { id: 'stg-sec-search-index',  key: 'search_index',  state: 'open' },
      { id: 'stg-sec-find-memories', key: 'find_memories', state: 'open' },
      // open: its rows are disclosures already, and a card may not hide a disclosure (one click to anything)
      { id: 'stg-sec-maintenance',   key: 'maintenance',   state: 'open' },
    ],
  },
  {
    id: 'ai-decisions', key: 'ai_decisions', group: 'memory_data', icon: 'judgments',
    panes: [{ id: 'judgments' }],
    sections: [
      { id: 'jv-sec-connection',    key: 'decision_service',    state: 'open' },
      { id: 'jv-sec-master',        key: 'master_switch',       state: 'open' },
      { id: 'jv-sec-sessions',      key: 'coding_sessions',     state: 'advanced' },
      { id: 'jv-sec-surfaces',      key: 'surfaces',            state: 'advanced' },
      { id: 'jv-sec-telemetry',     key: 'cost_telemetry',      state: 'advanced' },
      { id: 'jv-sec-cache',         key: 'answer_cache',        state: 'advanced' },
      { id: 'jv-sec-backfill',      key: 'backfill',            state: 'advanced' },
      { id: 'jv-sec-bench',         key: 'bench',               state: 'advanced' },
      { id: 'jv-sec-browser',       key: 'browser_assistance',  state: 'advanced' },
      { id: 'jv-sec-desktop',       key: 'desktop_assistance',  state: 'advanced' },
      { id: 'jv-sec-log',           key: 'judgment_log',        state: 'advanced' },
      { id: 'jv-sec-misfiled',      key: 'misfiled',            state: 'advanced' },
      { id: 'jv-sec-supersessions', key: 'superseded_by_jev',   state: 'advanced' },
      { id: 'jv-sec-triage',        key: 'trash_triage',        state: 'advanced' },
    ],
  },
  {
    id: 'projects', key: 'projects', group: 'memory_data', icon: 'projects',
    panes: [{ id: 'projects' }],
    sections: [
      { id: 'stg-sec-workspaces',      key: 'workspaces',      state: 'open' },
      { id: 'project-storage-manager', key: 'project_storage', state: 'advanced' },
    ],
  },
  {
    id: 'browser', key: 'browser', group: 'tools', icon: 'browser',
    panes: [{ id: 'browser' }],
    sections: [
      { id: 'setup-browser',  key: 'browser_choice',            state: 'open' },
      { id: 'bcg-profiles',   key: 'browser_profiles',          state: 'open' },
      { id: 'bcg-identity',   key: 'identity_privacy',          state: 'advanced' },
      { id: 'bcg-viewport',   key: 'display',                   state: 'advanced' },
      { id: 'bcg-advanced',   key: 'advanced_browser_behavior', state: 'advanced' },
    ],
  },
  {
    id: 'connected-tools', key: 'connected_tools', group: 'tools', icon: 'mcp',
    panes: [{ id: 'mcp' }, { id: 'morelogin', titleKey: k('pane.morelogin') }],
    sections: [
      { id: 'stg-sec-tool-profiles',  key: 'tool_profiles',         state: 'open' },
      { id: 'stg-sec-added-servers',  key: 'added_servers',         state: 'open' },
      { id: 'stg-sec-ml-connection',  key: 'morelogin_connection',  state: 'open' },
      { id: 'stg-sec-ml-profiles',    key: 'morelogin_profiles',    state: 'open' },
      { id: 'stg-sec-ml-credentials', key: 'morelogin_credentials', state: 'advanced' },
      { id: 'stg-sec-ml-server',      key: 'morelogin_tool_server', state: 'advanced' },
    ],
  },
  {
    id: 'tool-access', key: 'tool_access', group: 'tools', icon: 'permissions',
    panes: [{ id: 'skills' }, { id: 'permissions' }],
    sections: [
      { id: 'stg-sec-skills',           key: 'skills',           state: 'open' },
      { id: 'stg-sec-tool-permissions', key: 'tool_permissions', state: 'open' },
    ],
  },
  {
    id: 'automations', key: 'automations', group: 'automations', icon: 'hooks',
    panes: [{ id: 'hooks' }, { id: 'social' }, { id: 'youtube', titleKey: k('pane.youtube') }],
    sections: [
      { id: 'stg-sec-greetings',           key: 'greetings',              state: 'open' },
      { id: 'stg-sec-automation-behavior', key: 'automation_behavior',    state: 'open' },
      { id: 'stg-sec-online-access',       key: 'online_access',          state: 'advanced' },
      { id: 'stg-sec-social',              key: 'social_platform_access', state: 'open' },
      { id: 'stg-sec-youtube',             key: 'youtube_pipeline',       state: 'open' },
    ],
  },
  {
    id: 'messages', key: 'messages', group: 'automations', icon: 'whatsapp',
    panes: [{ id: 'whatsapp', titleKey: k('pane.whatsapp') }, { id: 'discord', titleKey: k('pane.discord') }],
    sections: [
      { id: 'wa-sec-setup',        key: 'setup_link',        state: 'open' },
      { id: 'wa-sec-conversation', key: 'conversation',      state: 'open' },
      { id: 'wa-sec-safety',       key: 'safety',            state: 'open' },
      { id: 'wa-sec-data',         key: 'data_privacy',      state: 'advanced' },
      { id: 'wa-sec-activity',     key: 'activity',          state: 'advanced' },
      { id: 'wa-sec-help',         key: 'help_disclosure',   state: 'advanced' },
      { id: 'wa-sec-phone',        key: 'simulated_phone',   state: 'advanced' },
      { id: 'stg-sec-discord-connection',  key: 'bot_connection',       state: 'open' },
      { id: 'stg-sec-discord-server',      key: 'server_defaults',      state: 'open' },
      { id: 'stg-sec-discord-moderation',  key: 'moderation_defaults',  state: 'open' },
      { id: 'stg-sec-discord-permissions', key: 'required_permissions', state: 'advanced' },
      { id: 'stg-sec-discord-tools',       key: 'mcp_tools_reference',  state: 'advanced' },
    ],
  },
  {
    id: 'notifications', key: 'notifications', group: 'personalize', icon: 'notifications',
    panes: [{ id: 'notifications' }],
    sections: [
      { id: 'stg-sec-alerts',   key: 'alerts',           state: 'open' },
      { id: 'stg-sec-when',     key: 'when_to_alert',    state: 'open' },
      { id: 'stg-sec-sounds',   key: 'sounds',           state: 'open' },
      { id: 'stg-sec-onscreen', key: 'on_screen_alerts', state: 'open' },
      { id: 'stg-sec-test',     key: 'test_alerts',      state: 'open' },
    ],
  },
  {
    id: 'appearance', key: 'appearance', group: 'personalize', icon: 'interface',
    // Variant tabs (the 2D Graphics tab) are appended to this page as extra panes.
    panes: [{ id: 'language' }, { id: 'skins' }, { id: 'interface' }, { id: 'icons' }],
    variantPanes: true,
    sections: [
      { id: 'stg-sec-language',      key: 'language',               state: 'open' },
      { id: 'stg-sec-themes',        key: 'themes',                 state: 'open' },
      { id: 'stg-sec-presets',       key: 'appearance_presets',     state: 'open' },
      { id: 'stg-sec-size',          key: 'size_style',             state: 'open' },
      { id: 'stg-sec-accent',        key: 'accent_color',           state: 'open' },
      { id: 'stg-sec-visualization', key: 'visualization',          state: 'open' },
      { id: 'stg-sec-visual-tuning', key: 'advanced_visual_tuning', state: 'advanced' },
      { id: 'stg-sec-file-icons',    key: 'file_icons',             state: 'open' },
      { id: 'stg-sec-2d-graph',      key: 'd2_graph',               state: 'advanced', variant: 'graphics' },
    ],
  },
];

export const DEFAULT_SETTINGS_PAGE = 'ai-connections';

export const pageKeys = (page) => ({
  navLabel: k(`nav.${page.key}.label`),
  navHelp: k(`nav.${page.key}.help`),
  title: k(`page.${page.key}.title`),
  purpose: k(`page.${page.key}.purpose`),
});
export const sectionKeys = (page, section) => ({
  title: k(`section.${page.key}.${section.key}.title`),
  purpose: k(`section.${page.key}.${section.key}.purpose`),
});

const PAGE_BY_ID = new Map(SETTINGS_PAGES.map((p) => [p.id, p]));
export const getSettingsPage = (id) => PAGE_BY_ID.get(id) || null;

/** The page that hosts a pane (an old tab id, or a variant tab id). */
export function pageOfPane(paneId) {
  for (const page of SETTINGS_PAGES) if (page.panes.some((p) => p.id === paneId)) return page;
  return SETTINGS_PAGES.find((p) => p.variantPanes) || null;
}
/** The page that lists a section id. */
export function pageOfSection(sectionId) {
  for (const page of SETTINGS_PAGES) if (page.sections.some((s) => s.id === sectionId)) return page;
  return null;
}
/** Is this section open before the user has opened or closed it? Only the first section of each page is. */
export function sectionOpensByDefault(sectionId) {
  return pageOfSection(sectionId)?.sections[0]?.id === sectionId;
}

// ── Controls ───────────────────────────────────────────────────────────────
// Where every control lives: the inventory ids whose copy is settings.redesign.control.<id>.{label,help},
// in reading order, under the section that holds them. In the markup a control is [data-stg-id="<ID>"].
// A control that only exists after a click (the Add project form, a theme's buttons) is listed too: a link
// to it lands on its section. Add a control here when you add its copy; settings-search.test.mjs checks both ways.

export const SETTINGS_CONTROLS = {
  'stg-sec-assistants': 'SET034 SET004 SET005 SET006 SET007 SET008 SET009 SET035 SET010 SET011 SET012 SET013 SET014 SET015 SET016 SET017 SET018 SET019 SET020 SET021 SET022 SET023 SET024 SET025 SET026 SET027 SET028',
  'setup-rules': 'SET001 SET002 SET033',
  'stg-sec-manual-setup': 'SET029 SET030 SET031 SET032',
  'cc-cli-paths': 'CLI001 CLI002 CLI007 CLI003 CLI004 CLI005 CLI006',
  'stg-sec-opencode-service': 'OCP001 OCP002 OCP003 OCP004 OCP005 OCP021 OCP022 OCP019',
  'stg-sec-opencode-behavior': 'OCP013 OCP014 OCP015 OCP016',
  'stg-sec-opencode-tools': 'OCP017',
  'stg-sec-opencode-history': 'OCP023 OCP018',
  'stg-sec-database': 'GEN015 GEN001 GEN002 GEN003 GEN016 GEN004 GEN005 GEN006 GEN017 DB003',
  'stg-sec-backups': 'GEN007 GEN008 GEN009 GEN010 GEN011 GEN012 GEN013 GEN014 GEN018',
  'stg-sec-search-index': 'DB004 DB001 DB002',
  'stg-sec-find-memories': 'MEM009 MEM010 MEM011 MEM002 MEM003 MEM004 MEM005 MEM006 MEM007',
  'stg-sec-maintenance': 'MEM008 MEM012 MEM013 MEM014 MEM001 MEM015 MEM016',
  'stg-sec-workspaces': 'PRJ013 PRJ007 PRJ008 PRJ009 PRJ010 PRJ011 PRJ014 PRJ015 PRJ016 PRJ017 PRJ018',
  'project-storage-manager': 'PRJ001 PRJ012 PRJ002 PRJ003 PRJ004 PRJ005 PRJ006',
  'setup-browser': 'BRW003 BRW001 BRW002 BRW084 BRW004 BRW005 BRW006 BRW007 BRW008 BRW009',
  'bcg-profiles': 'BRW011 BRW012 BRW013 BRW014 BRW083 BRW010 BRW015 BRW016 BRW017 BRW018 BRW019 BRW020',
  'bcg-identity': 'BRW021 BRW022 BRW023 BRW024 BRW025',
  'bcg-viewport': 'BRW026 BRW027 BRW028 BRW029 BRW030 BRW031 BRW032',
  'bcg-advanced': 'BRW033 BRW034 BRW035 BRW036 BRW037 BRW038 BRW039 BRW040 BRW041 BRW042 BRW043 BRW044 BRW045 BRW046 BRW047 BRW048 BRW049 BRW050 BRW051 BRW052 BRW053 BRW054 BRW055 BRW056 BRW057 BRW058 BRW059 BRW060 BRW061 BRW062 BRW063 BRW064 BRW065 BRW066 BRW067 BRW068 BRW069 BRW070 BRW071 BRW072 BRW073 BRW074 BRW075 BRW076 BRW077 BRW078 BRW079 BRW080',
  'stg-sec-tool-profiles': 'MCP022 MCP024',
  'stg-sec-added-servers': 'MCP026 MCP006 MCP007 MCP008 MCP009 MCP010 MCP011 MCP012 MCP013 MCP014 MCP015 MCP027 MCP016 MCP017 MCP018 MCP019 MCP020 MCP021',
  'stg-sec-ml-connection': 'ML015 ML001 ML002 ML003',
  'stg-sec-ml-profiles': 'ML004 ML005 ML006 ML016 ML017 ML018 ML019',
  'stg-sec-ml-credentials': 'ML007 ML008 ML009 ML010 ML011',
  'stg-sec-ml-server': 'ML012 ML013 ML014',
  'stg-sec-skills': 'SKL004 SKL001',
  'stg-sec-tool-permissions': 'PER012 PER001 PER002 PER003 PER004 PER005 PER006 PER007 PER008 PER009 PER010 PER011',
  'stg-sec-greetings': 'AUT001 AUT002 AUT003 AUT047 AUT004 AUT005 AUT009 AUT010 AUT011 AUT012 AUT013 AUT014 AUT015 AUT016 AUT017 AUT018 AUT019 AUT020 AUT021 AUT022 AUT026 AUT027',
  'stg-sec-automation-behavior': 'AUT046 AUT036 AUT037 AUT038 AUT039 AUT040 AUT041 AUT028 AUT029 AUT030 AUT031 AUT032 AUT033 AUT034 AUT035',
  'stg-sec-online-access': 'AUT048 AUT042 AUT043 AUT044 AUT045 AUT049 AUT050 AUT051 AUT052',
  'stg-sec-social': 'SOC003 SOC001 SOC002',
  'stg-sec-youtube': 'YT017 YT001 YT002 YT003 YT004 YT005 YT006 YT007 YT008 YT009 YT010 YT011 YT012 YT013 YT014 YT015 YT016 YT018',
  'wa-sec-conversation': 'WA045 WA046 WA047',
  'stg-sec-discord-connection': 'DIS016 DIS001 DIS002 DIS003 DIS004 DIS005 DIS006',
  'stg-sec-discord-server': 'DIS009 DIS010 DIS011 DIS012 DIS013',
  'stg-sec-discord-moderation': 'DIS014 DIS015',
  'stg-sec-discord-permissions': 'DIS017 DIS007 DIS008',
  'stg-sec-discord-tools': 'DIS018',
  'stg-sec-alerts': 'NOT001 NOT002 NOT003',
  'stg-sec-when': 'NOT004 NOT005 NOT006 NOT007 NOT008 NOT009',
  'stg-sec-sounds': 'NOT010 NOT011 NOT012 NOT013 NOT014 NOT015 NOT016',
  'stg-sec-onscreen': 'NOT017 NOT018 NOT019 NOT020 NOT021',
  'stg-sec-test': 'NOT022',
  'stg-sec-language': 'APP001',
  'stg-sec-themes': 'SKN003 SKN001 SKN002 SKN004 SKN005',
  'stg-sec-presets': 'UI016',
  'stg-sec-size': 'UI001 UI002 UI015',
  'stg-sec-accent': 'UI017 UI011 UI012 UI013',
  'stg-sec-visualization': 'UI014',
  'stg-sec-visual-tuning': 'UI003 UI004 UI005 UI006 UI007 UI008 UI009 UI010',
  'stg-sec-file-icons': 'ICO001 ICO003 ICO002 ICO004 ICO005',
  'stg-sec-2d-graph': 'GFX001 GFX002 GFX003 GFX004 GFX005 GFX006 GFX007 GFX008',
};
/** Controls of a page that sit outside its sections (a pane's save bar, the tabs of a pane). */
export const SETTINGS_PAGE_CONTROLS = {
  browser: 'BRW081 BRW082 BRW085',
  'connected-tools': 'MCP001',
};
/** The window's own controls (dim the background, close, the page list): not settings, so never search results. */
export const SETTINGS_SHELL_CONTROLS = 'SH002 SH003 SH005';

const idList = (ids) => (ids ? ids.split(' ') : []);
export const controlsOfSection = (sectionId) => idList(SETTINGS_CONTROLS[sectionId]);
export const controlsOfPage = (pageId) => idList(SETTINGS_PAGE_CONTROLS[pageId]);
export const controlKeys = (controlId) => ({
  label: k(`control.${String(controlId).toLowerCase()}.label`),
  help: k(`control.${String(controlId).toLowerCase()}.help`),
});

const CONTROL_HOME = new Map();
for (const page of SETTINGS_PAGES) {
  for (const id of controlsOfPage(page.id)) CONTROL_HOME.set(id, { page: page.id, section: null });
  for (const section of page.sections) for (const id of controlsOfSection(section.id)) CONTROL_HOME.set(id, { page: page.id, section: section.id });
}
/** Where a control lives: `{ page, section }` (`section` is null for a page-level control), or null for an id that is not a control. */
export const homeOfControl = (controlId) => CONTROL_HOME.get(controlId) || null;

// ── Deep-link aliases ──────────────────────────────────────────────────────
// Old tab id → the page that took it over, and the section a link to that tab
// should land on. Old callers keep working; new code uses the page ids.

export const SETTINGS_TAB_ALIASES = {
  server:        { page: 'memory-backups',  section: 'stg-sec-database' },
  collections:   { page: 'memory-backups',  section: 'stg-sec-database' },
  memory:        { page: 'memory-backups',  section: 'stg-sec-find-memories' },
  setup:         { page: 'ai-connections',  section: 'stg-sec-assistants' },
  terminal:      { page: 'ai-connections',  section: 'cc-cli-paths' },
  opencode:      { page: 'ai-connections',  section: 'stg-sec-opencode-service' },
  judgments:     { page: 'ai-decisions',    section: 'jv-sec-connection' },
  projects:      { page: 'projects',        section: 'stg-sec-workspaces' },
  browser:       { page: 'browser',         section: 'setup-browser' },
  mcp:           { page: 'connected-tools', section: 'stg-sec-tool-profiles' },
  morelogin:     { page: 'connected-tools', section: 'stg-sec-ml-connection' },
  skills:        { page: 'tool-access',     section: 'stg-sec-skills' },
  permissions:   { page: 'tool-access',     section: 'stg-sec-tool-permissions' },
  hooks:         { page: 'automations',     section: 'stg-sec-automation-behavior' },
  social:        { page: 'automations',     section: 'stg-sec-social' },
  youtube:       { page: 'automations',     section: 'stg-sec-youtube' },
  whatsapp:      { page: 'messages',        section: 'wa-sec-setup' },
  discord:       { page: 'messages',        section: 'stg-sec-discord-connection' },
  notifications: { page: 'notifications',   section: 'stg-sec-alerts' },
  language:      { page: 'appearance',      section: 'stg-sec-language' },
  skins:         { page: 'appearance',      section: 'stg-sec-themes' },
  interface:     { page: 'appearance',      section: 'stg-sec-presets' },
  icons:         { page: 'appearance',      section: 'stg-sec-file-icons' },
  graphics:      { page: 'appearance',      section: 'stg-sec-2d-graph' },
};

// Old `expand` / `highlight` / `scrollTo` ids whose element was merged into another
// section. Ids that still exist in the markup (setup-claude, jv-sec-log, wa-sec-setup,
// recall-controls, cc-greeting-config, bridge-openclaw, project-storage-manager,
// cc-cli-paths …) need no entry: they resolve to themselves.
export const SETTINGS_SECTION_ALIASES = {
  'notif-sources-section':  'stg-sec-when',
  'notif-triggers-section': 'stg-sec-when',
  'notif-sound-section':    'stg-sec-sounds',
  'notif-toast-section':    'stg-sec-onscreen',
  'notif-banner-section':   'stg-sec-onscreen',
};

const list = (v) => (Array.isArray(v) ? v : (v ? [v] : []));
export const resolveSectionId = (id) => SETTINGS_SECTION_ALIASES[id] || id;

/**
 * Old or new open options → the page to show and the section ids to expand,
 * highlight and scroll to. A link to an old tab also expands and scrolls to
 * the section that tab became, unless the caller asked for something specific.
 * Aliased ids are added, never swapped out: an id that still exists in the
 * markup keeps working, and the section it now lives in opens with it.
 * `highlight` and `scrollTo` also take a control's inventory id (GEN001 …):
 * its section opens with it, and it names the page when no tab is given.
 */
export function resolveSettingsTarget(options = {}) {
  const out = { tab: null, expand: [], highlight: [], scrollTo: null, fromAlias: false };
  if (!options || typeof options !== 'object') return out;

  const both = (id) => (resolveSectionId(id) === id ? [id] : [resolveSectionId(id), id]);
  out.expand = [...new Set(list(options.expand).flatMap(both))];
  out.highlight = [...new Set(list(options.highlight).flatMap(both))];
  out.scrollTo = options.scrollTo || null;

  const tab = options.tab || null;
  if (tab && PAGE_BY_ID.has(tab)) {
    out.tab = tab;
  } else if (tab && SETTINGS_TAB_ALIASES[tab]) {
    const alias = SETTINGS_TAB_ALIASES[tab];
    out.tab = alias.page;
    out.fromAlias = true;
    out.pane = tab; // the pane this old tab became: where to land when its section is not a card yet
    if (!out.expand.includes(alias.section)) out.expand.unshift(alias.section);
    if (!out.scrollTo) out.scrollTo = alias.section;
  } else if (tab) {
    // A variant tab id (registered at runtime) lives on the page that hosts variant panes.
    out.tab = (SETTINGS_PAGES.find((p) => p.variantPanes) || SETTINGS_PAGES[0]).id;
    out.pane = tab;
  }

  // A control: the section that holds it opens with it.
  const homes = [out.scrollTo, ...out.highlight].map((id) => id && homeOfControl(id)).filter(Boolean);
  for (const home of homes) if (home.section && !out.expand.includes(home.section)) out.expand.push(home.section);

  // No page named: the first section (or control) asked for decides it.
  if (!out.tab) {
    for (const id of [out.scrollTo, ...out.expand, ...out.highlight]) {
      const page = id && pageOfSection(resolveSectionId(id));
      if (page) { out.tab = page.id; break; }
    }
  }
  if (!out.tab && homes.length) out.tab = homes[0].page;
  return out;
}
