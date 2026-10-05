// Settings information architecture: the page list, the old-tab aliases every deep link
// relies on, and the i18n contract (every key the Settings code asks for exists in en.json,
// which stays CRLF). Pure node: settings-ia.js has no DOM and no imports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import {
  SETTINGS_GROUPS, SETTINGS_PAGES, DEFAULT_SETTINGS_PAGE, SETTINGS_TAB_ALIASES, SETTINGS_SECTION_ALIASES,
  pageKeys, sectionKeys, getSettingsPage, pageOfPane, pageOfSection, resolveSettingsTarget, sectionOpensByDefault,
} from '../public/shared/settings/settings-ia.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const settings = read('../public/shared/ui-settings.js');
const enRaw = read('../i18n/en.json');
const en = JSON.parse(enRaw);
const lookup = (key) => key.split('.').reduce((node, part) => node?.[part], en);

// The 22 tabs the modal had before the redesign (plus the 2D variant tab). Each must still open something.
const OLD_TABS = ['server', 'setup', 'terminal', 'opencode', 'notifications', 'browser', 'mcp', 'collections', 'memory', 'judgments', 'projects', 'hooks', 'skills', 'discord', 'whatsapp', 'morelogin', 'youtube', 'permissions', 'social', 'skins', 'interface', 'icons', 'graphics'];

test('eleven pages in five groups; ids, panes and sections are unique; groups stay together in the nav', () => {
  assert.equal(SETTINGS_PAGES.length, 11);
  assert.equal(SETTINGS_GROUPS.length, 5);
  const ids = SETTINGS_PAGES.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(getSettingsPage(DEFAULT_SETTINGS_PAGE));
  const groups = new Set(SETTINGS_GROUPS.map((g) => g.id));
  const seen = new Set();
  let last = null;
  for (const page of SETTINGS_PAGES) {
    assert.ok(groups.has(page.group), `${page.id}: unknown group ${page.group}`);
    if (page.group !== last) { assert.equal(seen.has(page.group), false, `group ${page.group} is split in the nav`); seen.add(page.group); last = page.group; }
    assert.match(settings, new RegExp(`\\n\\s*${page.icon}: '<svg`), `${page.id}: TAB_ICONS.${page.icon}`);
    assert.ok(page.sections.length >= 1, `${page.id} has sections`);
  }
  const panes = SETTINGS_PAGES.flatMap((p) => p.panes.map((x) => x.id));
  assert.equal(new Set(panes).size, panes.length, 'a pane lives on one page');
  const sections = SETTINGS_PAGES.flatMap((p) => p.sections.map((s) => s.id));
  assert.equal(new Set(sections).size, sections.length, 'a section id is used once');
  for (const page of SETTINGS_PAGES) for (const s of page.sections) assert.ok(['open', 'advanced'].includes(s.state), `${s.id}: state`);
});

test('every section is an accordion: on first use only the first section of each page is open', () => {
  for (const page of SETTINGS_PAGES) {
    page.sections.forEach((s, i) => assert.equal(sectionOpensByDefault(s.id), i === 0, `${s.id} opens by default: ${i === 0}`));
    assert.equal(page.sections[0].state, 'open', `${page.id}: the section open on first use is an everyday one`);
  }
  assert.equal(sectionOpensByDefault('no-such-section'), false);
  // The kit makes every top-level card collapsible; the shell applies and stores the open state under one key.
  const kit = read('../public/shared/settings/settings-kit.js');
  const shell = read('../public/shared/settings/settings-shell.js');
  assert.match(kit, /collapsibleOpt \?\? level === 'h3'/, 'card(): top-level cards default to collapsible');
  assert.match(shell, /SECTIONS_OPEN_KEY = 'stg-sections-open'/);
  assert.match(settings, /applyStoredSections\(overlay\);\r?\n\s*document\.body\.appendChild\(overlay\)/, 'the stored state is applied before the panel is shown');
  assert.match(settings, /section\.classList\.toggle\('collapsed'\);\r?\n\s*storeSectionState\(section\);/, 'a head click remembers the choice');
});

test('every old tab id is a pane of a page or an alias, and its alias lands on a section of that page', () => {
  for (const tab of OLD_TABS) {
    const alias = SETTINGS_TAB_ALIASES[tab];
    assert.ok(alias, `${tab} has an alias`);
    const page = getSettingsPage(alias.page);
    assert.ok(page, `${tab} → ${alias.page} exists`);
    assert.ok(page.sections.some((s) => s.id === alias.section), `${tab} → ${alias.section} is a section of ${alias.page}`);
    if (tab !== 'graphics') assert.equal(pageOfPane(tab).id, alias.page, `${tab}: the pane lives on the page its alias opens`);
  }
  for (const [from, to] of Object.entries(SETTINGS_SECTION_ALIASES)) assert.ok(pageOfSection(to), `${from} → ${to} is a section`);
  // The shell builds one pane per builder under exactly these ids.
  for (const pane of SETTINGS_PAGES.flatMap((p) => p.panes.map((x) => x.id))) assert.match(settings, new RegExp(`\\n\\s+${pane}: build\\w+Tab\\(`), `the shell builds the ${pane} pane`);
});

test('resolveSettingsTarget: old deep links, new page ids, merged sections, variant tabs', () => {
  assert.deepEqual(resolveSettingsTarget({}), { tab: null, expand: [], highlight: [], scrollTo: null, fromAlias: false });
  // The callers in the code base (ui-sessions.js, ui-whiteboard.js) and the documented example.
  const setup = resolveSettingsTarget({ tab: 'setup', expand: ['setup-claude', 'setup-codex', 'setup-opencode'] });
  assert.equal(setup.tab, 'ai-connections');
  assert.deepEqual(setup.expand, ['stg-sec-assistants', 'setup-claude', 'setup-codex', 'setup-opencode']);
  assert.equal(setup.scrollTo, 'stg-sec-assistants');
  const rules = resolveSettingsTarget({ tab: 'setup', expand: ['setup-rules', 'setup-gemini'], highlight: ['setup-gemini'], scrollTo: 'setup-gemini' });
  assert.deepEqual([rules.tab, rules.scrollTo, rules.highlight], ['ai-connections', 'setup-gemini', ['setup-gemini']]);
  // A new page id passes through untouched and adds nothing.
  assert.deepEqual(resolveSettingsTarget({ tab: 'ai-connections', expand: 'setup-rules' }), { tab: 'ai-connections', expand: ['setup-rules'], highlight: [], scrollTo: null, fromAlias: false });
  const jv = resolveSettingsTarget({ tab: 'judgments', expand: ['jv-sec-log', 'jv-sec-misfiled'] });
  assert.deepEqual([jv.tab, jv.expand], ['ai-decisions', ['jv-sec-connection', 'jv-sec-log', 'jv-sec-misfiled']]);
  // An id that was merged into another card opens that card, and is still asked for by name.
  assert.deepEqual(resolveSettingsTarget({ expand: ['notif-sound-section'] }).expand, ['stg-sec-sounds', 'notif-sound-section']);
  assert.equal(resolveSettingsTarget({ tab: 'whatsapp', expand: ['wa-sec-setup', 'wa-sec-activity'] }).tab, 'messages');
  assert.equal(resolveSettingsTarget({ tab: 'hooks' }).scrollTo, 'stg-sec-automation-behavior');
  assert.equal(resolveSettingsTarget({ tab: 'terminal' }).scrollTo, 'cc-cli-paths');
  // No page named: the section decides.
  assert.equal(resolveSettingsTarget({ scrollTo: 'wa-sec-safety' }).tab, 'messages');
  assert.equal(resolveSettingsTarget({ expand: ['project-storage-manager'] }).tab, 'projects');
  // A tab registered by a variant at runtime lives on the page that hosts variant panes.
  const variant = resolveSettingsTarget({ tab: 'some-variant-tab' });
  assert.deepEqual([variant.tab, variant.pane], ['appearance', 'some-variant-tab']);
  assert.equal(resolveSettingsTarget({ tab: 'graphics' }).tab, 'appearance');
});

test('i18n: every page, group and section has English copy, and en.json stays CRLF', () => {
  for (const group of SETTINGS_GROUPS) assert.equal(typeof lookup(group.labelKey), 'string', group.labelKey);
  for (const page of SETTINGS_PAGES) {
    for (const key of Object.values(pageKeys(page))) assert.equal(typeof lookup(key), 'string', key);
    for (const pane of page.panes) if (pane.titleKey) assert.equal(typeof lookup(pane.titleKey), 'string', pane.titleKey);
    for (const section of page.sections) for (const key of Object.values(sectionKeys(page, section))) {
      assert.equal(typeof lookup(key), 'string', key);
      assert.doesNotMatch(lookup(key), /with a visible status and help/, `${key} still has placeholder copy`);
    }
  }
  assert.equal((enRaw.match(/\r\n/g) || []).length, (enRaw.match(/\n/g) || []).length, 'en.json keeps CRLF line endings');
});

test('i18n: every settings.redesign key the Settings code asks for exists in en.json', () => {
  const shared = new URL('../public/shared/', import.meta.url);
  const files = ['ui-settings.js', 'ui-judgments.js', 'ui-whatsapp.js', 'ui-memory-maintenance.js']
    .map((name) => new URL(name, shared))
    .concat(readdirSync(new URL('settings/', shared)).filter((n) => n.endsWith('.js')).map((n) => new URL(`settings/${n}`, shared)))
    .concat([new URL('../public/variant/2d/settings-gfx.js', import.meta.url)])
    .filter((url) => existsSync(url));
  const wanted = new Map(); // key → file that asks for it
  const want = (key, file) => { if (!wanted.has(key)) wanted.set(key, file); };
  const prefixes = new Set();
  for (const url of files) {
    const name = url.pathname.split('/').pop();
    const src = readFileSync(url, 'utf8');
    for (const m of src.matchAll(/['"`](settings\.redesign\.[A-Za-z0-9_.-]+)['"`]/g)) want(m[1], name);
    // The kit's and the IA's own generic helpers build keys from their arguments; the rules below cover those.
    if (!['settings-kit.js', 'settings-ia.js'].includes(name)) for (const m of src.matchAll(/`(settings\.redesign\.[A-Za-z0-9_.-]*)\$\{/g)) prefixes.add(m[1]);
    // An inventory id passed around as data ('SET006' in an id map) is read through kit.L / kit.H later.
    for (const m of src.matchAll(/['"]([A-Z]{2,4}\d{3})['"]/g)) { want(`settings.redesign.control.${m[1].toLowerCase()}.label`, name); want(`settings.redesign.control.${m[1].toLowerCase()}.help`, name); }
    for (const m of src.matchAll(/\b(?:kit\.)?(L|H)\(\s*['"]([A-Za-z]+\d+[a-z]?)['"]/g)) want(`settings.redesign.control.${m[2].toLowerCase()}.${m[1] === 'L' ? 'label' : 'help'}`, name);
    for (const m of src.matchAll(/\b(?:kit\.)?(field|toggleField|help)\(\s*['"]([A-Za-z]+\d+[a-z]?)['"]/g)) {
      if (m[1] !== 'help') want(`settings.redesign.control.${m[2].toLowerCase()}.label`, name);
      want(`settings.redesign.control.${m[2].toLowerCase()}.help`, name);
    }
    for (const m of src.matchAll(/\bsection:\s*['"]([a-z0-9_]+\.[a-z0-9_]+)['"]/g)) { want(`settings.redesign.section.${m[1]}.title`, name); want(`settings.redesign.section.${m[1]}.purpose`, name); }
  }
  assert.ok(wanted.size > 40, `found the Settings keys (${wanted.size})`);
  const missing = [];
  for (const [key, file] of wanted) {
    const value = lookup(key);
    if (typeof value === 'string') continue;
    if (value && typeof value === 'object') continue; // a plural base or a group read through a template literal
    missing.push(`${key} (${file})`);
  }
  assert.deepEqual(missing, [], 'keys the code references but en.json does not define');
  // A key assembled at runtime must have at least one leaf under its static prefix.
  for (const prefix of prefixes) {
    const node = lookup(prefix.replace(/\.$/, ''));
    assert.ok(node && typeof node === 'object', `no keys under ${prefix}`);
  }
});

// ── Language ───────────────────────────────────────────────────────────────

/** Every leaf of a locale file as a dot path. */
const keyPaths = (node, path = []) => Object.entries(node).flatMap(([key, value]) => (
  value && typeof value === 'object' && !Array.isArray(value) ? keyPaths(value, [...path, key]) : [[...path, key].join('.')]
));

test('i18n: every other locale file has exactly the keys of en.json', () => {
  const dir = new URL('../i18n/', import.meta.url);
  const english = new Set(keyPaths(en));
  // Passes on its own while en.json is the only locale file.
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json') && n !== 'en.json')) {
    const keys = new Set(keyPaths(JSON.parse(readFileSync(new URL(name, dir), 'utf8'))));
    const missing = [...english].filter((key) => !keys.has(key));
    const extra = [...keys].filter((key) => !english.has(key));
    const show = (list) => `${list.length}${list.length ? `: ${list.slice(0, 40).join(', ')}${list.length > 40 ? ', …' : ''}` : ''}`;
    assert.ok(!missing.length && !extra.length, `${name} — missing ${show(missing)}; extra ${show(extra)}`);
  }
});

test('Language is the first section of Appearance, in its own pane, with its copy', () => {
  const page = getSettingsPage('appearance');
  assert.deepEqual(page.sections.map((s) => s.id), [
    'stg-sec-language', 'stg-sec-themes', 'stg-sec-presets', 'stg-sec-size', 'stg-sec-accent',
    'stg-sec-visualization', 'stg-sec-visual-tuning', 'stg-sec-file-icons', 'stg-sec-2d-graph',
  ]);
  assert.deepEqual(page.panes.map((p) => p.id), ['language', 'skins', 'interface', 'icons']);
  assert.equal(page.sections[0].state, 'open');
  assert.equal(sectionOpensByDefault('stg-sec-language'), true);
  assert.equal(sectionOpensByDefault('stg-sec-themes'), false);
  assert.equal(pageOfSection('stg-sec-language').id, 'appearance');
  const link = resolveSettingsTarget({ tab: 'language' });
  assert.deepEqual([link.tab, link.scrollTo, link.pane], ['appearance', 'stg-sec-language', 'language']);
  for (const key of [
    ...Object.values(sectionKeys(page, page.sections[0])),
    'settings.redesign.control.app001.label', 'settings.redesign.control.app001.help',
    'settings.redesign.language.system', 'settings.redesign.language.systemWith',
  ]) assert.equal(typeof lookup(key), 'string', key);
  assert.match(lookup('settings.redesign.language.systemWith'), /\{name\}/);
  // The popup is the kit's dropdown in an inventory row; a change stores the choice and reloads onto this page.
  assert.match(settings, /id: 'stg-sec-language', section: 'appearance\.language'/);
  assert.match(settings, /kit\.field\('APP001', kit\.dropdown\('stg-language', options,/);
  assert.match(settings, /sessionStorage\.setItem\(SETTINGS_REOPEN_KEY, page\)/);
  assert.match(settings, /const reopenPage = takeSettingsReopen\(\);/);
});

test('i18n.js: region tags, the stored choice, per-key English fallback, a missing locale file', async () => {
  // i18n.js is a browser module (it reads the server-synced store): give it the few globals it touches.
  const pt = { common: { save: 'Salvar' }, search: { resultCount: { one: '1 resultado' } } };
  const served = { '/i18n/en.json': en, '/i18n/pt-BR.json': pt };
  const nav = { language: 'pt-BR', languages: ['pt-BR', 'pt', 'en-US', 'en'] };
  const system = (language, languages = [language]) => Object.assign(nav, { language, languages });
  let reloads = 0;
  const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
  globalThis.window = { addEventListener() {}, location: { reload: () => { reloads += 1; } } };
  globalThis.document = { documentElement: { lang: 'en' } };
  globalThis.localStorage = { length: 0, key: () => null, getItem: () => null };
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
  globalThis.fetch = async (url) => {
    if (url === '/api/ui-state') return json({ 'synabun-test': 1 });
    return url in served && served[url] ? json(served[url]) : json(null, false, 404);
  };
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const { storage } = await import('../public/shared/storage.js');
    const i18n = await import('../public/shared/i18n.js');
    assert.deepEqual(i18n.SUPPORTED_LOCALES, ['en', 'pt-BR']);
    assert.deepEqual(i18n.LOCALE_NAMES, { en: 'English', 'pt-BR': 'Português (Brasil)' });
    assert.equal(i18n.LOCALE_FILES['pt-BR'], '/i18n/pt-BR.json');

    // Nothing stored: the system decides. Exact tag, then the language alone, then English.
    assert.equal(i18n.getLocaleChoice(), 'system');
    for (const [language, languages, expected] of [
      ['pt-BR', undefined, 'pt-BR'], ['pt', undefined, 'pt-BR'], ['pt-PT', undefined, 'pt-BR'], ['PT-br', undefined, 'pt-BR'],
      ['en-US', undefined, 'en'], ['en', undefined, 'en'], ['de-DE', undefined, 'en'], ['fr-FR', ['fr-FR', 'pt', 'en'], 'pt-BR'],
    ]) { system(language, languages); assert.equal(i18n.getSystemLocale(), expected, `${language} → ${expected}`); }

    // Portuguese: its own strings, English key by key for what it lacks, the key only when both miss.
    system('pt-BR');
    await i18n.initI18n();
    assert.equal(i18n.getLocale(), 'pt-BR');
    assert.equal(document.documentElement.lang, 'pt-BR');
    assert.equal(i18n.t('common.save'), 'Salvar');
    assert.equal(i18n.t('settings.redesign.control.app001.label'), 'Language');
    assert.equal(i18n.t('settings.redesign.language.systemWith', { name: 'English' }), 'System (English)');
    assert.equal(i18n.tp('search.resultCount', 1), '1 resultado');
    assert.equal(i18n.tp('search.resultCount', 42), en.search.resultCount.other.replace('{count}', '42'));
    assert.deepEqual(warnings, []);
    assert.equal(i18n.t('no.such.key'), 'no.such.key');
    assert.deepEqual(warnings, ['[i18n] Missing key: no.such.key']);

    // A stored choice wins over the system; 'system' hands the decision back.
    storage.setItem('synabun-locale', 'en');
    assert.equal(i18n.getLocaleChoice(), 'en');
    await i18n.initI18n();
    assert.deepEqual([i18n.getLocale(), document.documentElement.lang, i18n.t('common.save')], ['en', 'en', 'Save']);
    storage.setItem('synabun-locale', 'system');
    assert.equal(i18n.getLocaleChoice(), 'system');
    await i18n.initI18n();
    assert.equal(i18n.getLocale(), 'pt-BR');

    // setLocaleChoice stores and reloads; an unknown choice does neither.
    assert.equal(i18n.setLocaleChoice('klingon'), false);
    assert.equal(storage.getItem('synabun-locale'), 'system');
    assert.equal(i18n.setLocaleChoice('pt-BR'), true);
    assert.equal(storage.getItem('synabun-locale'), 'pt-BR');
    await new Promise((done) => setTimeout(done, 20));
    assert.equal(reloads, 1);
    i18n.setLocale('en');
    await new Promise((done) => setTimeout(done, 20));
    assert.deepEqual([storage.getItem('synabun-locale'), reloads], ['en', 2]);

    // The locale file is not there yet: one warning, and the whole UI stays English with no raw keys.
    storage.setItem('synabun-locale', 'pt-BR');
    served['/i18n/pt-BR.json'] = null;
    warnings.length = 0;
    await i18n.initI18n();
    assert.deepEqual([i18n.getLocale(), document.documentElement.lang, i18n.getLocaleChoice()], ['en', 'en', 'pt-BR']);
    assert.equal(i18n.t('common.save'), 'Save');
    assert.equal(i18n.t('settings.redesign.section.appearance.language.title'), 'Language');
    assert.deepEqual(warnings, ["[i18n] Failed to load 'pt-BR', falling back to 'en'"]);
  } finally {
    console.warn = realWarn;
  }
});
