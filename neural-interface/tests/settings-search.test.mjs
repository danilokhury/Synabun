// Settings search: the pure core (public/shared/settings/settings-search.js). Normalisation, AND matching,
// the ranking order and how ties are settled, the limits of typo tolerance, match ranges, the old tab names, the
// English names of another locale, hostile queries, and COVERAGE: every page, section and control the IA knows is
// an entry whose own title finds it and whose target is a deep link that resolveSettingsTarget resolves.
// Pure node: no DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import {
  SETTINGS_PAGES, SETTINGS_TAB_ALIASES, SETTINGS_CONTROLS, SETTINGS_PAGE_CONTROLS, SETTINGS_SHELL_CONTROLS,
  controlsOfSection, controlsOfPage, homeOfControl, controlKeys, pageOfSection, resolveSettingsTarget,
} from '../public/shared/settings/settings-ia.js';
import {
  buildSettingsSearchIndex, searchSettings, runtimeSearchEntries, normalizeSearchText, searchTokens,
  withinOneEdit, highlightParts, SEARCH_LIMIT, SEARCH_QUERY_MAX,
} from '../public/shared/settings/settings-search.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const locale = (name) => JSON.parse(read(`../i18n/${name}.json`));
const en = locale('en');
/** The translate function of a locale file: like i18n.js t(), but a missing key is an error. */
const translator = (messages) => (key, params) => {
  const value = key.split('.').reduce((node, part) => node?.[part], messages);
  assert.equal(typeof value, 'string', `missing i18n key ${key}`);
  return params ? value.replace(/\{(\w+)\}/g, (m, name) => (params[name] != null ? params[name] : m)) : value;
};
const t = translator(en);
const index = buildSettingsSearchIndex({ t, variants: ['graphics'] });
const titles = (query, o) => searchSettings(index, query, o).results.map((r) => r.entry.title);
const ids = (query, o) => searchSettings(index, query, o).results.map((r) => r.entry.id);
const first = (query) => searchSettings(index, query).results[0];

// Rows with known strings, searched on their own, for the ranking rules.
const synthetic = (rows) => runtimeSearchEntries({ ...index, taken: new Set(), size: 0 }, rows);
const rankRows = (rows, query) => searchSettings({ entries: [] }, query, { extra: synthetic(rows) }).results;
const rank = (rows, query) => rankRows(rows, query).map((r) => r.entry.title);
const row = (title, extra = {}) => ({ title, page: 'appearance', ...extra });

test('normalisation: case, accents and punctuation do not matter', () => {
  assert.equal(normalizeSearchText('  API-Key  '), 'api key');
  assert.equal(normalizeSearchText('Memória & Backups…'), 'memoria backups');
  assert.equal(normalizeSearchText('Notificações'), 'notificacoes');
  assert.equal(normalizeSearchText('été'), 'ete', 'an accent typed as a combining mark');
  assert.equal(normalizeSearchText('“Save”/(cancel)'), 'save cancel');
  assert.equal(normalizeSearchText('ﬁle'), 'file', 'a ligature is its letters');
  assert.equal(normalizeSearchText('—'), '');
  assert.deepEqual(searchTokens('API key, api'), ['api', 'key'], 'each word once');
  assert.deepEqual(searchTokens('   '), []);
  // The same results however the query is typed.
  assert.deepEqual(ids('api-key'), ids('api key'));
  assert.deepEqual(ids('API KEY'), ids('api key'));
  assert.deepEqual(ids('“api” key!'), ids('api key'));
  const pt = buildSettingsSearchIndex({ t: translator(locale('pt-BR')) });
  const plain = searchSettings(pt, 'notificacoes').results.map((r) => r.entry.id);
  assert.ok(plain.length > 3);
  assert.deepEqual(searchSettings(pt, 'Notificações').results.map((r) => r.entry.id), plain, 'accents in the query or in the copy');
});

test('an empty query finds nothing; a query with no match finds nothing', () => {
  for (const query of ['', '   ', '…', null, undefined]) assert.deepEqual(searchSettings(index, query).results, []);
  const none = searchSettings(index, 'zzzzqqqq');
  assert.deepEqual([none.total, none.results.length], [0, 0]);
});

test('several words are AND: every word must match somewhere in the entry', () => {
  const both = searchSettings(index, 'proxy password');
  assert.ok(both.total >= 1);
  assert.equal(both.results[0].entry.title, 'Proxy password');
  const proxy = new Set(ids('proxy', { limit: 500 }));
  const password = new Set(ids('password', { limit: 500 }));
  for (const id of ids('proxy password', { limit: 500 })) assert.ok(proxy.has(id) && password.has(id), `${id} matches both words`);
  assert.ok(searchSettings(index, 'proxy', { limit: 500 }).total > both.total, 'a second word narrows the list');
  assert.equal(searchSettings(index, 'proxy zzzzqqqq').total, 0);
  // Words may be found in different fields: the label, and the product the section belongs to.
  assert.equal(first('discord token').entry.id, 'control:DIS001');
  assert.equal(first('token discord').entry.id, 'control:DIS001', 'word order does not matter');
});

test('per word: whole word > start of a word > inside a word > one typo', () => {
  assert.deepEqual(rank([row('Transport'), row('Portable'), row('Port')], 'port'), ['Port', 'Portable', 'Transport']);
  assert.deepEqual(rank([row('Import files'), row('Port range'), row('Portrait mode')], 'port'), ['Port range', 'Portrait mode', 'Import files']);
  // A near miss comes after every exact hit, whatever field the exact hit is in.
  assert.deepEqual(rank([row('Pork'), row('Other', { help: 'the port to listen on' })], 'port'), ['Other', 'Pork']);
  const mixed = rankRows([row('Pork'), row('Other', { help: 'the port to listen on' })], 'port');
  assert.deepEqual(mixed.map((r) => r.typo), [false, true]);
  assert.ok(mixed[0].score < 0.5 && mixed[0].score > mixed[1].score, 'a help-text hit still outranks a typo in a title');
});

test('field weight: title > old names and keywords > page and section names > help', () => {
  // The same word as a whole word in each field of the real index.
  const theme = searchSettings(index, 'theme', { limit: 500 }).results;
  const where = (id) => theme.findIndex((r) => r.entry.id === id);
  assert.ok(where('control:SKN004') >= 0 && where('page:appearance') >= 0);
  assert.ok(where('control:SKN004') < where('page:appearance'), 'a label ("Use this theme") before a keyword (Appearance)');
  const byField = (query, id) => searchSettings(index, query, { limit: 500 }).results.find((r) => r.entry.id === id).score;
  assert.ok(byField('sqlite', 'section:stg-sec-database') > byField('backups', 'control:GEN007'), 'a keyword outranks the name of the page the entry sits on');
  // Synthetic: one entry per field.
  const order = rank([
    row('Other one', { help: 'changes the gamma of the map' }),
    row('Gamma'),
  ], 'gamma');
  assert.deepEqual(order, ['Gamma', 'Other one']);
  const hits = searchSettings(index, 'general').results;
  assert.equal(hits[0].entry.id, 'section:stg-sec-database', 'an old tab name outranks the same word in help text');
  assert.ok(hits.slice(1).every((r) => r.score < hits[0].score));
});

test('ties keep IA order, and runtime rows come after index entries of equal quality', () => {
  const save = searchSettings(index, 'save', { limit: 500 }).results.filter((r) => r.entry.title === 'Save');
  assert.ok(save.length >= 5);
  assert.deepEqual(save.map((r) => r.entry.order), save.map((r) => r.entry.order).slice().sort((a, b) => a - b));
  assert.equal(new Set(save.map((r) => r.score)).size, 1, 'the same title scores the same');
  // IA order is page order: a page, its sections, each section's controls.
  const orderOf = (id) => index.byId.get(id).order;
  assert.ok(orderOf('page:ai-connections') < orderOf('section:stg-sec-assistants'));
  assert.ok(orderOf('section:stg-sec-assistants') < orderOf('control:SET034'));
  assert.ok(orderOf('control:SET028') < orderOf('section:setup-rules'));
  assert.ok(orderOf('section:stg-sec-file-icons') < orderOf('section:stg-sec-2d-graph'));
  // A project named like a setting.
  const extra = runtimeSearchEntries(index, [{ title: 'Proxy address', page: 'projects', section: 'stg-sec-workspaces', ref: 1 }, { title: 'AcmeShop', page: 'projects', section: 'stg-sec-workspaces', ref: 2 }]);
  const found = searchSettings(index, 'proxy address', { extra }).results;
  assert.deepEqual(found.slice(0, 2).map((r) => [r.entry.id, r.entry.runtime]), [['control:BRW066', false], ['row:0', true]]);
  assert.equal(found[0].score, found[1].score);
  assert.equal(searchSettings(index, 'acmeshop', { extra }).results[0].entry.ref, 2);
  assert.equal(searchSettings(index, 'acmeshop', { extra }).results[0].entry.path, 'Projects › Workspaces');
});

test('a title that starts with the query is preferred among equals only: it never lifts the start of a word over a whole word', () => {
  // The case from the live app (pt-BR, "som"): two titles that start with the letters, two that hold the word.
  assert.deepEqual(rank([row('Somente leitura'), row('Sombras'), row('Reproduzir som'), row('Testar cada som')], 'som'),
    ['Reproduzir som', 'Testar cada som', 'Somente leitura', 'Sombras']);
  // Among hits of the same tier it decides: the whole word first in the title, then the whole word later in it.
  assert.deepEqual(rank([row('Import port'), row('Port range')], 'port'), ['Port range', 'Import port']);
  assert.deepEqual(rank([row('Transportable'), row('Sportable'), row('Portable')], 'port'), ['Portable', 'Transportable', 'Sportable']);
  // …and it is not part of the score: a title that starts with the query scores what its tier scores.
  const [whole, start] = rankRows([row('Play port'), row('Portable')], 'port');
  assert.deepEqual([whole.entry.title, whole.score, whole.lead, start.entry.title, start.score, start.lead], ['Play port', 1, 0, 'Portable', 0.8, 3]);
  // The whole title still comes first of all.
  assert.deepEqual(rank([row('Play port'), row('Port range'), row('Port')], 'port'), ['Port', 'Port range', 'Play port']);
  // On the real index, in both locales: every title that holds the word comes before every title that only starts one with it.
  const pt = buildSettingsSearchIndex({ t: translator(locale('pt-BR')), variants: ['graphics'] });
  const extra = runtimeSearchEntries(pt, [
    { title: 'Somente leitura', page: 'messages', section: 'wa-sec-safety', ref: 1 }, { title: 'Sombras', page: 'appearance', section: 'stg-sec-visual-tuning', ref: 2 },
    { title: 'Testar cada som', page: 'notifications', section: 'stg-sec-test', ref: 3 },
  ]);
  const som = searchSettings(pt, 'som', { extra, limit: 500 }).results;
  const at = (title) => som.findIndex((r) => r.entry.title === title);
  for (const whole of ['Reproduzir som', 'Testar cada som', 'Som de alerta']) for (const start of ['Somente leitura', 'Sombras']) {
    assert.ok(at(whole) >= 0 && at(start) >= 0 && at(whole) < at(start), `"${whole}" before "${start}"`);
  }
  assert.equal(som[0].entry.title, 'Som de alerta', 'the word, at the start of the title');
  // "Whole" as the matcher means it: the word itself, or, from four typed letters on, the word with a short ending.
  const isWhole = (w, query) => w === query || (query.length >= 4 && w.startsWith(query) && w.length - query.length <= 2);
  const both = [];
  for (const [built, query] of [[index, 'theme'], [index, 'sound'], [index, 'back'], [pt, 'som'], [pt, 'tema']]) {
    const found = searchSettings(built, query, { limit: 500 }).results;
    const words = (r) => normalizeSearchText(r.entry.title).split(' ');
    const whole = (r) => words(r).some((w) => isWhole(w, query));
    const lastWhole = found.map(whole).lastIndexOf(true);
    const firstStart = found.findIndex((r) => !whole(r) && words(r).some((w) => w.startsWith(query)));
    assert.ok(lastWhole >= 0 && (firstStart === -1 || firstStart > lastWhole), `${query}: whole words (to ${lastWhole}) before starts of words (from ${firstStart})`);
    if (firstStart > lastWhole) both.push(query);
    for (let i = 1; i < found.length; i++) assert.ok(found[i - 1].typo < found[i].typo || found[i - 1].score >= found[i].score, `${query}: scores never rise down the list`);
  }
  assert.ok(both.includes('som') && both.includes('back'), `queries with titles of both kinds: ${both}`);
});

test('a short ending is the same word: from four typed letters on, one or two letters more still count as the whole word', () => {
  // A plural does not lose to a longer title that happens to hold the singular: equal scores, and the title that starts with the query leads.
  assert.deepEqual(rank([row('Install a theme'), row('Use this theme'), row('Themes')], 'theme'), ['Themes', 'Install a theme', 'Use this theme']);
  const score = (title, query) => rankRows([row(title)], query)[0].score;
  assert.deepEqual([score('Themes', 'theme'), score('Sounds', 'sound'), score('Ports', 'port'), score('Ported', 'port'), score('Temas', 'tema')], [1, 1, 1, 1, 1]);
  // Longer tails are another word that starts the same way.
  assert.deepEqual([score('Porting', 'port'), score('Portable', 'port'), score('Portrait', 'port'), score('Notifications', 'notif')], [0.8, 0.8, 0.8, 0.8]);
  // Three typed letters are not enough to tell: "som" is not "Soma", "hue" is not "Hues".
  assert.deepEqual([score('Hues', 'hue'), score('Soma', 'som'), score('Sombras', 'som'), score('Somente leitura', 'som')], [0.8, 0.8, 0.8, 0.8]);
  // Only the typed letters are marked, and the word itself is marked in preference to one with an ending.
  const cut = (title, query) => { const hit = rankRows([row(title)], query)[0]; return hit.ranges.title.map(([a, b]) => hit.entry.title.slice(a, b)); };
  assert.deepEqual([cut('Themes', 'theme'), cut('Notificações', 'notificaco'), cut('Themes of a theme', 'theme')], [['Theme'], ['Notificaçõ'], ['theme']]);
  // In every field: a keyword, an old name, the path, the help.
  assert.equal(rankRows([row('Other', { help: 'plays sounds when a task ends' })], 'sound')[0].score, 0.3);
  // On the real index. pt-BR "tema": the section first (its title starts with the query, a section before a control),
  // then the control whose title starts with it, then the controls that hold the word.
  const pt = buildSettingsSearchIndex({ t: translator(locale('pt-BR')), en: t, variants: ['graphics'] });
  const top = (built, query, n) => searchSettings(built, query, { limit: 500 }).results.slice(0, n).map((r) => r.entry.id);
  assert.deepEqual(top(pt, 'tema', 5), ['section:stg-sec-themes', 'control:SKN003', 'control:SKN001', 'control:SKN002', 'control:SKN004']);
  assert.deepEqual(searchSettings(pt, 'tema', { limit: 500 }).results.slice(0, 5).map((r) => r.score), [1, 1, 1, 1, 1]);
  // Through the English names too: "theme" lists the section "Temas" before "Arquivo ZIP do tema", "sound" lists "Sons" first.
  assert.deepEqual(top(pt, 'theme', 2), ['section:stg-sec-themes', 'control:SKN002']);
  assert.deepEqual(top(pt, 'sound', 1), ['section:stg-sec-sounds']);
  assert.deepEqual([top(index, 'theme', 1), top(index, 'sound', 1)], [['section:stg-sec-themes'], ['section:stg-sec-sounds']]);
  // Unchanged: a three-letter query, and the whole title before everything.
  assert.equal(searchSettings(pt, 'som').results[0].entry.title, 'Som de alerta');
  assert.deepEqual(top(pt, 'notificações', 2), ['page:notifications', 'control:BRW053']);
  // It changes how good a match is, never whether there is one: the same entries are found as when every start of a word was one tier.
  for (const query of ['theme', 'sound', 'back', 'proxy', 'notif']) assert.ok(searchSettings(index, query, { limit: 500 }).total >= 1);
});

test('equal scores: a page, then a section, then a control, then a row found in the panel; IA order last', () => {
  // The case from the live app: the page "Notificações" and a browser permission checkbox of the same name.
  const pt = buildSettingsSearchIndex({ t: translator(locale('pt-BR')), variants: ['graphics'] });
  const found = searchSettings(pt, 'notificações').results;
  assert.deepEqual(found.slice(0, 2).map((r) => [r.entry.id, r.entry.title, r.score]), [['page:notifications', 'Notificações', 2], ['control:BRW053', 'Notificações', 2]]);
  assert.deepEqual(searchSettings(index, 'notifications').results.slice(0, 2).map((r) => r.entry.id), ['page:notifications', 'control:BRW053']);
  // One name on a page, a section, two controls and a row, placed so that IA order would list them the other way round.
  const same = { 'settings.redesign.page.appearance.title': 'Zebra', 'settings.redesign.section.browser.display.title': 'Zebra',
    'settings.redesign.control.set004.label': 'Zebra', 'settings.redesign.control.gen001.label': 'Zebra' };
  const zebra = buildSettingsSearchIndex({ t: (key, params) => same[key] || t(key, params), variants: ['graphics'] });
  const rows = runtimeSearchEntries(zebra, [{ title: 'Zebra', page: 'ai-connections', section: 'setup-rules', ref: 1 }]);
  const hits = searchSettings(zebra, 'zebra', { extra: rows }).results.filter((r) => r.entry.title === 'Zebra');
  assert.deepEqual(hits.map((r) => r.entry.id), ['page:appearance', 'section:bcg-viewport', 'control:SET004', 'control:GEN001', 'row:0']);
  assert.equal(new Set(hits.map((r) => r.score)).size, 1, 'all five score the same');
  const order = hits.map((r) => r.entry.order);
  assert.ok(order[0] > order[1] && order[1] > order[2] && order[2] < order[3], 'the kind decides before IA order; IA order only between two of a kind');
  // A better score still wins over a better kind.
  assert.equal(searchSettings(index, 'proxy password').results[0].entry.kind, 'control');
});

test('English names in another locale: found, ranked under the locale\'s own words, shown under the localized title', () => {
  const ptT = translator(locale('pt-BR'));
  const alone = buildSettingsSearchIndex({ t: ptT, variants: ['graphics'] });
  const both = buildSettingsSearchIndex({ t: ptT, en: t, variants: ['graphics'] });
  assert.deepEqual([index.english, alone.english, both.english], [false, false, true]);
  assert.ok(index.entries.every((e) => e.english === '' && e.fields.en === null), 'English itself has no second language');
  assert.equal(both.entries.length, alone.entries.length);
  // Until the English strings are there, only the locale's own words are searched.
  for (const query of ['theme', 'sound', 'password']) assert.equal(searchSettings(alone, query).total, 0, `pt-BR alone: "${query}"`);
  // With them, the words the owner knew the settings by find the settings.
  const find = (query) => searchSettings(both, query, { limit: 500 }).results;
  const password = find('password');
  assert.deepEqual(password.slice(0, 2).map((r) => [r.entry.id, r.entry.title, r.english]), [['control:BRW069', 'Senha do proxy', 'Proxy password'], ['control:BRW071', 'Senha de login do site', 'Website sign-in password']]);
  assert.deepEqual(highlightParts(password[0].english, password[0].ranges.english), [{ text: 'Proxy ', hit: false }, { text: 'password', hit: true }]);
  assert.deepEqual(password[0].ranges.title, [], 'nothing of the Portuguese title is marked');
  const theme = find('theme');
  assert.ok(theme.some((r) => r.entry.id === 'control:SKN004' && r.entry.title === 'Usar este tema' && r.english === 'Use this theme'));
  assert.ok(theme.some((r) => r.entry.id === 'section:stg-sec-themes') && theme.some((r) => r.entry.id === 'page:appearance'), 'through the English keywords too');
  assert.equal(theme.find((r) => r.entry.id === 'page:appearance').english, null, 'a keyword hit shows no English name: the name is not what matched');
  // An English title is matched word by word: "theme" does not run across "Show the memory map" (a curated keyword still may: "darkmode").
  assert.deepEqual(theme.filter((r) => r.english).map((r) => [r.entry.title, r.english]), [['Temas', 'Themes'], ['Arquivo ZIP do tema', 'Theme ZIP file'], ['Temas instalados', 'Installed themes'], ['Instalar tema de um arquivo ZIP', 'Install a theme from a ZIP file'], ['Usar este tema', 'Use this theme']]);
  assert.equal(theme.some((r) => r.entry.id === 'control:UI014'), false);
  assert.ok(find('darkmode').some((r) => r.entry.id === 'section:stg-sec-themes'));
  const sound = find('sound');
  assert.deepEqual(sound.slice(0, 3).map((r) => [r.entry.title, r.english]), [['Sons', 'Sounds'], ['Reproduzir som', 'Play a sound'], ['Som de alerta', 'Alert sound']]);
  assert.ok(sound.some((r) => r.entry.id === 'section:stg-sec-sounds'));
  // Under the active locale's keywords: an English hit never outscores a word of the locale, title or keyword.
  const tema = find('tema');
  const keyword = tema.find((r) => r.entry.id === 'page:appearance');
  assert.equal(keyword.score, 0.7, 'a keyword of the locale');
  for (const query of ['theme', 'sound', 'password', 'download']) {
    for (const r of find(query)) if (r.english) assert.ok(r.score <= 0.6 && r.score < keyword.score, `${query}: ${r.entry.id} scores ${r.score}`);
  }
  assert.ok(Math.max(...theme.map((r) => r.score)) < keyword.score);
  // Word by word: in "proxy password" the locale gives "proxy" (a whole word of the title) and English gives "password".
  assert.deepEqual(find('proxy password').slice(0, 1).map((r) => [r.entry.title, r.english, r.score]), [['Senha do proxy', 'Proxy password', 0.8]]);
  // A word the two languages share is found through the locale and says nothing about English.
  const proxy = find('proxy')[0];
  assert.deepEqual([proxy.entry.title.toLowerCase().includes('proxy'), proxy.english, proxy.score >= 0.8], [true, null, true]);
  // The whole English title, and a title that starts with the query, lead among English hits of the same score.
  assert.deepEqual(find('proxy password').slice(0, 1).map((r) => [r.entry.id, r.lead]), [['control:BRW069', 2]]);
  assert.deepEqual(find('theme').slice(0, 3).map((r) => [r.entry.id, r.lead]), [['section:stg-sec-themes', 1], ['control:SKN002', 1], ['control:SKN003', 0]], '"Themes" and "Theme ZIP file" start with the word');
  // A name that reads the same in both languages is not repeated.
  for (const e of both.entries) if (e.english) assert.notEqual(normalizeSearchText(e.english), normalizeSearchText(e.title), e.id);
  assert.ok(both.entries.some((e) => e.kind === 'control' && e.english === '' && e.fields.en === null), 'e.g. a product name');
  assert.ok(both.entries.filter((e) => e.english).length > 350);
  // English old tab names: the ones the locale does not list itself.
  const plain = buildSettingsSearchIndex({ t: (key, params) => (key.includes('.search.legacy.') ? 'Antigo' : ptT(key, params)), en: t });
  const old = searchSettings(plain, 'general').results.find((r) => r.entry.id === 'section:stg-sec-database');
  assert.deepEqual([old.alias, old.score], ['General', 0.55]);
  assert.deepEqual(both.byId.get('section:cc-cli-paths').fields.en.aliases, [], 'pt-BR already lists Terminal: not twice');
  // An English bundle that lacks a key (it answers with the key, or with nothing) adds nothing and breaks nothing.
  for (const en of [(key) => key, () => '', () => undefined]) {
    const bare = buildSettingsSearchIndex({ t: ptT, en, variants: ['graphics'] });
    assert.ok(bare.entries.every((e) => e.english === '' && e.fields.en === null));
    assert.deepEqual(searchSettings(bare, 'tema').results.map((r) => r.entry.id), searchSettings(alone, 'tema').results.map((r) => r.entry.id));
  }
  // The locale's own results are the same with or without English, wherever no English word matched.
  for (const query of ['tema', 'notificações', 'senha do proxy', 'chave de api']) {
    assert.deepEqual(find(query).filter((r) => r.score >= 0.7).map((r) => r.entry.id), searchSettings(alone, query, { limit: 500 }).results.filter((r) => r.score >= 0.7).map((r) => r.entry.id), query);
  }
  // Rows found in the panel have no English: they are whatever the user named them.
  assert.ok(runtimeSearchEntries(both, [{ title: 'Atlas', page: 'projects', ref: 1 }]).every((e) => e.english === '' && e.fields.en === null));
});

test('hostile queries: very long ones are cut, regex and markup characters are only text', () => {
  assert.equal(SEARCH_QUERY_MAX, 120);
  const timed = (query) => { const start = performance.now(); const found = searchSettings(index, query, { limit: 500 }); return [found, performance.now() - start]; };
  for (const query of ['a'.repeat(200000), 'proxy '.repeat(40000), 'ab cd ef gh ij kl mn op qr st uv wx yz '.repeat(5000), 'é'.repeat(50000), '\u0301'.repeat(50000)]) {
    const [found, ms] = timed(query);
    assert.ok(ms < 250, `${query.length} characters took ${ms.toFixed(0)} ms`);
    assert.ok(found.tokens.join(' ').length <= SEARCH_QUERY_MAX, 'only the first 120 characters are read');
  }
  assert.deepEqual(searchSettings(index, 'proxy '.repeat(40000)).results.map((r) => r.entry.id).sort(), ids('proxy').sort(), 'a word said many times is one word');
  assert.equal(searchSettings(index, `${'x'.repeat(SEARCH_QUERY_MAX)} proxy`).total, 0, 'what lies past the cut is not searched');
  assert.equal(searchSettings(index, `proxy ${'pass'.padStart(SEARCH_QUERY_MAX - 10)}`).results[0].entry.title, 'Proxy password', 'up to the cut it is');
  // Characters a regular expression would read: no word in them, no result, no error.
  for (const query of ['.*', '.*+?^${}()|[]\\', '(', ')', '[a-z]+', '\\', '$&', '$1', '{count}', '{query}', '^', '\\d+', '(?=x)', 'a{2,}', '*', '%', '\u0000', '<>', '&amp;']) {
    assert.doesNotThrow(() => searchSettings(index, query), query);
  }
  for (const query of ['.*+?^${}()|[]\\', '(', '***', '<>']) assert.deepEqual(searchSettings(index, query).tokens, [], `${query} holds no word`);
  // Around a word they change nothing.
  for (const query of ['(proxy)', 'proxy.*', '^proxy$', '[proxy]', 'proxy\\', '<b>proxy</b>'.replace(/b>/g, '>')]) assert.deepEqual(ids(query), ids('proxy'), query);
  assert.deepEqual(ids('proxy|password'), ids('proxy password'), '| is a space, not an "or"');
  // A name full of markup is a name: kept as written, found by its words, cut into plain parts for the renderer to escape.
  const evil = '<img src=x onerror=alert(1)>';
  const [entry] = runtimeSearchEntries(index, [{ title: evil, page: 'projects', section: 'stg-sec-workspaces', ref: 1 }]);
  assert.equal(entry.title, evil);
  const hit = searchSettings(index, 'onerror', { extra: [entry] }).results.find((r) => r.entry === entry);
  assert.ok(hit, 'found by a word of it');
  const parts = highlightParts(hit.entry.title, hit.ranges.title);
  assert.equal(parts.map((part) => part.text).join(''), evil, 'the parts are the name, nothing added or dropped');
  assert.deepEqual(parts.filter((part) => part.hit).map((part) => part.text), ['onerror']);
  assert.equal(searchSettings(index, evil, { extra: [entry] }).results[0].entry, entry, 'and by all of it');
  // The renderer escapes every part it writes, the tooltip and what tells two results apart.
  const shell = read('../public/shared/settings/settings-shell.js');
  assert.match(shell, /part\.hit \? `<mark>\$\{esc\(part\.text\)\}<\/mark>` : esc\(part\.text\)/);
  assert.match(shell, /title="\$\{esc\(tip\)\}"/);
  assert.match(shell, /\[r\.context \|\| '', esc\(r\.context \|\| ''\)\]/);
  assert.match(shell, /note\.textContent = text;/, 'the query is echoed as text');
});

test('runtime rows: names only, no duplicate of an index entry, unknown pages dropped', () => {
  const extra = runtimeSearchEntries(index, [
    { title: 'Database location', page: 'memory-backups', section: 'stg-sec-database', ref: 'dup of GEN001' },
    { title: 'My server', page: 'connected-tools', section: 'stg-sec-added-servers', ref: 'a' },
    { title: 'my  SERVER', page: 'connected-tools', section: 'stg-sec-added-servers', ref: 'same row twice' },
    { title: 'Orphan', page: 'no-such-page', ref: 'x' },
    { title: '   ', page: 'projects', ref: 'y' },
    { title: 'Loose row', page: 'projects', section: 'not-a-section', ref: 'z' },
  ]);
  assert.deepEqual(extra.map((e) => e.title), ['My server', 'Loose row']);
  assert.ok(extra.every((e) => e.runtime && e.kind === 'row'));
  assert.deepEqual(extra[0].target, { tab: 'connected-tools', expand: ['stg-sec-added-servers'] });
  assert.deepEqual([extra[1].section, extra[1].path, extra[1].target.expand], [null, 'Projects', []]);
  assert.ok(extra[0].order >= index.entries.length, 'after the index in tie order');
});

test('typos: one edit, a swap included, in words of four letters or more', () => {
  assert.equal(withinOneEdit('backup', 'backup'), true);
  assert.equal(withinOneEdit('bakcup', 'backup'), true, 'two neighbours swapped');
  assert.equal(withinOneEdit('bckup', 'backup'), true, 'a letter dropped');
  assert.equal(withinOneEdit('backupp', 'backup'), true, 'a letter added');
  assert.equal(withinOneEdit('bockup', 'backup'), true, 'a letter changed');
  assert.equal(withinOneEdit('bokcup', 'backup'), false, 'two edits');
  assert.equal(withinOneEdit('bakcpu', 'backup'), false, 'two swaps');
  assert.equal(withinOneEdit('back', 'backup'), false);
  // Found through the typo…
  for (const [query, title] of [['notifcations', 'Notifications'], ['bakcup', 'Backups'], ['databse', 'Database'], ['apperance', 'Appearance'], ['langauge', 'Language'], ['proyx', 'Proxy address']]) {
    const found = searchSettings(index, query);
    assert.ok(found.results.some((r) => r.entry.title === title), `${query} finds ${title}`);
    assert.ok(found.results.every((r) => r.typo), `${query}: every hit is a near miss`);
  }
  // …in a query of several words too.
  assert.equal(first('proxy pasword').entry.title, 'Proxy password');
  assert.equal(first('discrod token').entry.id, 'control:DIS001');
  // Limits: two typos, and short words, find nothing.
  assert.equal(searchSettings(index, 'ntoifcations').total, 0, 'two edits');
  assert.equal(searchSettings(index, 'databsse zzqq').total, 0, 'the other word still has to match');
  assert.deepEqual(rank([row('Port'), row('Sort')], 'prt'), [], 'three letters are matched exactly or not at all');
  assert.deepEqual(rank([row('Hue'), row('Size')], 'huee'), [], 'a three-letter word is not a near miss of a longer one');
  assert.deepEqual(rank([row('Sound')], 'sond'), ['Sound']);
  // The start of a longer word, one edit away.
  assert.deepEqual(rank([row('Notifications')], 'notifcat'), ['Notifications']);
  // A near miss never outranks an exact hit, and is dropped when exact matching found enough.
  const theme = searchSettings(index, 'them', { limit: 500 });
  assert.ok(theme.total >= 3 && theme.results.every((r) => !r.typo), 'plenty of exact hits: no guesses');
  const sparse = rankRows([row('Pert'), row('Port'), row('Pork')], 'port');
  assert.deepEqual(sparse.map((r) => [r.entry.title, r.typo]), [['Port', false], ['Pert', true], ['Pork', true]]);
  assert.deepEqual(rank([row('Pert'), row('Port'), row('Port two'), row('Port three')], 'port'), ['Port', 'Port two', 'Port three'], 'three exact hits: the near miss is dropped');
  // Help text is never matched by a near miss: a sentence has too many words that are one letter away.
  assert.deepEqual(rank([row('Other', { help: 'the port to listen on' })], 'porr'), []);
});

test('a word of the query may run across a space: from the start of a word, in a title, a name or a keyword', () => {
  assert.deepEqual(rank([row('API key')], 'apikey'), ['API key']);
  assert.deepEqual(rank([row('Dark mode')], 'darkmode'), ['Dark mode']);
  assert.deepEqual(rank([row('Rapid major change')], 'idma'), [], 'not from the middle of a word');
  // …and it must end on a whole word or on three letters of one, not on a stub of the next word.
  assert.deepEqual(rank([row('Show the memory map')], 'theme'), [], '"the" + "me" is not "theme"');
  assert.deepEqual(rank([row('API key')], 'apik'), [], 'one letter of the next word');
  assert.deepEqual(rank([row('Dark mode')], 'darkmo'), [], 'two letters of the next word');
  assert.deepEqual([rank([row('Dark mode')], 'darkmod'), rank([row('Dark mode')], 'darkmode'), rank([row('How to link')], 'howto'), rank([row('Do it now')], 'doitnow')],
    [['Dark mode'], ['Dark mode'], ['How to link'], ['Do it now']], 'three letters of it, all of it, a short word that is whole');
  assert.equal(ids('theme', { limit: 500 }).includes('control:UI014'), false, '"theme" no longer finds "Show the memory map"');
  assert.ok(ids('darkmode').includes('section:stg-sec-themes') && ids('apikey', { limit: 500 }).includes('section:jv-sec-connection'));
  assert.deepEqual(rank([row('Other', { help: 'an api key you paste' })], 'apikey'), [], 'not in help text');
  assert.ok(titles('whats app').some((x) => /WhatsApp|Set up & link/.test(x)), 'two words find one written as one');
});

test('match ranges mark the matched letters of the title and of the path, on the original text', () => {
  const cut = (text, ranges) => ranges.map(([s, e]) => text.slice(s, e));
  const hit = first('proxy pass');
  assert.equal(hit.entry.title, 'Proxy password');
  assert.deepEqual(cut(hit.entry.title, hit.ranges.title), ['Proxy', 'pass']);
  assert.deepEqual(highlightParts(hit.entry.title, hit.ranges.title), [{ text: 'Proxy', hit: true }, { text: ' ', hit: false }, { text: 'pass', hit: true }, { text: 'word', hit: false }]);
  const inPath = searchSettings(index, 'browser', { limit: 500 }).results.find((r) => r.entry.id === 'control:BRW073');
  assert.deepEqual(cut(inPath.entry.path, inPath.ranges.path), ['Browser'], 'the first place the word is found in the path');
  assert.deepEqual(inPath.ranges.title, []);
  // Accents and punctuation: the range covers the letters as written.
  const accents = rankRows([row('Notificações — sons')], 'notificacoes sons')[0];
  assert.deepEqual(cut(accents.entry.title, accents.ranges.title), ['Notificações', 'sons']);
  const combining = rankRows([row('Café menu')], 'cafe')[0];
  assert.deepEqual(cut(combining.entry.title, combining.ranges.title), ['Café'], 'a combining accent stays with its letter');
  const joined = rankRows([row('API-key store')], 'apikey')[0];
  assert.deepEqual(cut(joined.entry.title, joined.ranges.title), ['API-key']);
  // Overlapping words merge into one range; ranges are sorted and never overlap.
  const merged = rankRows([row('Backup backups')], 'backup back')[0];
  assert.deepEqual(merged.ranges.title, [[0, 6]]);
  for (const query of ['a', 'port', 'api key', 'the', 'memory backups']) {
    for (const r of searchSettings(index, query, { limit: 500 }).results) {
      for (const [name, text] of [['title', r.entry.title], ['path', r.entry.path]]) {
        let at = 0;
        for (const [s, e] of r.ranges[name]) { assert.ok(s >= at && e > s && e <= text.length, `${query}: ${name} range of ${r.entry.id}`); at = e; }
      }
    }
  }
  assert.deepEqual(highlightParts('plain', []), [{ text: 'plain', hit: false }]);
});

test('old names: every old tab name lands where its alias lands', () => {
  for (const [tab, alias] of Object.entries(SETTINGS_TAB_ALIASES)) {
    const names = t(`settings.redesign.search.legacy.${tab}`).split(',').map((s) => s.trim());
    assert.ok(names.length >= 1 && names.every(Boolean), `${tab} has a name`);
    const entry = index.byId.get(`section:${alias.section}`);
    assert.ok(entry, `${tab} → ${alias.section} is in the index`);
    for (const name of names) {
      assert.ok(entry.aliases.includes(name), `${alias.section} is also known as ${name}`);
      const found = searchSettings(index, name, { limit: 500 }).results;
      assert.ok(found.some((r) => r.entry.id === entry.id), `"${name}" finds ${alias.section}`);
      // The deep link of the entry opens what the old tab id opens.
      const viaSearch = resolveSettingsTarget(entry.target);
      const viaTab = resolveSettingsTarget({ tab });
      assert.equal(viaSearch.tab, viaTab.tab, `${name}: same page`);
      assert.ok(viaSearch.expand.includes(alias.section), `${name}: opens ${alias.section}`);
      // An old tab that kept its name as a page (Projects, Browser, Notifications) opens at the top of that page.
      if (viaTab.scrollTo) assert.equal(viaSearch.scrollTo, viaTab.scrollTo, `${name}: same section`);
    }
  }
  // The names the brief lists, and where people land.
  for (const [query, id] of [['General', 'section:stg-sec-database'], ['Setup', 'section:stg-sec-assistants'], ['Terminal', 'section:cc-cli-paths'], ['OpenCode', 'section:stg-sec-opencode-service'],
    ['Recall', 'section:stg-sec-find-memories'], ['Judgments', 'section:jv-sec-connection'], ['MCP', 'section:stg-sec-tool-profiles'], ['Database', 'section:stg-sec-database'], ['Hooks', 'section:stg-sec-automation-behavior']]) {
    const found = searchSettings(index, query).results;
    const at = found.findIndex((r) => r.entry.id === id);
    assert.ok(at >= 0 && at < 5, `${query} → ${id} near the top (${at})`);
  }
  // The name that matched is reported, so the list can say "Formerly …"; a hit on the title reports none.
  assert.equal(searchSettings(index, 'general').results[0].alias, 'General');
  assert.equal(searchSettings(index, 'terminal').results.find((r) => r.entry.id === 'section:cc-cli-paths').alias, 'Terminal');
  assert.equal(searchSettings(index, 'database').results.find((r) => r.entry.id === 'section:stg-sec-database').alias, null);
});

test('keywords: common words that are in no label find their setting', () => {
  for (const [query, id] of [
    ['api key', 'section:jv-sec-connection'], ['token', 'section:jv-sec-connection'], ['dark mode', 'section:stg-sec-themes'], ['theme', 'section:stg-sec-themes'],
    ['font', 'section:stg-sec-size'], ['port', 'section:stg-sec-opencode-service'], ['proxy', 'section:bcg-advanced'], ['restore', 'section:stg-sec-backups'],
    ['sound', 'section:stg-sec-sounds'], ['sqlite', 'section:stg-sec-database'], ['tunnel', 'section:stg-sec-online-access'], ['user agent', 'control:BRW021'],
    ['zoom', 'control:UI001'], ['qr code', 'section:wa-sec-setup'], ['cloudflare', 'control:AUT049'],
  ]) assert.ok(ids(query, { limit: 500 }).includes(id), `"${query}" finds ${id}`);
  // Every page and section has a curated keyword string in every locale, and the per-control ones name real controls.
  for (const name of readdirSync(new URL('../i18n/', import.meta.url)).filter((n) => n.endsWith('.json'))) {
    const words = JSON.parse(read(`../i18n/${name}`)).settings.redesign.search.keywords;
    for (const page of SETTINGS_PAGES) {
      assert.ok(words.page[page.key]?.trim(), `${name}: keywords.page.${page.key}`);
      for (const section of page.sections) assert.ok(words.section[page.key]?.[section.key]?.trim(), `${name}: keywords.section.${page.key}.${section.key}`);
    }
    for (const id of Object.keys(words.control)) {
      assert.ok(homeOfControl(id.toUpperCase()), `${name}: keywords.control.${id} names a control`);
      assert.ok(index.byId.get(`control:${id.toUpperCase()}`).keywords, `keywords.control.${id} is read by the index`);
    }
  }
});

test('the index is built from the active locale, through the translate function it is given', () => {
  const asked = [];
  const upper = buildSettingsSearchIndex({ t: (key, params) => { asked.push(key); return t(key, params).toUpperCase(); } });
  assert.ok(asked.length > 1000 && asked.every((key) => key.startsWith('settings.redesign.')));
  assert.ok(upper.entries.every((e) => e.title === e.title.toUpperCase()), 'no string comes from anywhere else');
  const pt = buildSettingsSearchIndex({ t: translator(locale('pt-BR')), variants: ['graphics'] });
  assert.equal(pt.entries.length, index.entries.length);
  assert.equal(pt.byId.get('page:appearance').title, 'Aparência');
  assert.equal(searchSettings(pt, 'aparencia').results[0].entry.id, 'page:appearance');
  assert.equal(searchSettings(pt, 'modo escuro').results.some((r) => r.entry.id === 'section:stg-sec-themes'), true);
  assert.equal(searchSettings(pt, 'chave de api', { limit: 500 }).results.some((r) => r.entry.id === 'section:jv-sec-connection'), true);
  assert.throws(() => buildSettingsSearchIndex({}), /t\(key, params\) is required/);
  // The source holds no English copy of its own: every string it shows is a key.
  const src = read('../public/shared/settings/settings-search.js');
  assert.doesNotMatch(src.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, ''), /title: '[A-Z]|keywords: '[a-z]/);
});

test('COVERAGE: the control table lists every control with copy, each once, in a section of the IA', () => {
  const control = en.settings.redesign.control;
  const listed = [];
  for (const [sectionId, list] of Object.entries(SETTINGS_CONTROLS)) {
    assert.ok(pageOfSection(sectionId), `${sectionId} is a section of the IA`);
    for (const id of list.split(' ')) listed.push(id);
  }
  for (const [pageId, list] of Object.entries(SETTINGS_PAGE_CONTROLS)) {
    assert.ok(SETTINGS_PAGES.some((p) => p.id === pageId), `${pageId} is a page`);
    for (const id of list.split(' ')) listed.push(id);
  }
  const shell = SETTINGS_SHELL_CONTROLS.split(' ');
  assert.equal(new Set(listed).size, listed.length, 'a control is listed once');
  assert.deepEqual(listed.filter((id) => shell.includes(id)), [], 'the window chrome is not a setting');
  const withCopy = Object.keys(control).map((id) => id.toUpperCase());
  assert.deepEqual(withCopy.filter((id) => !listed.includes(id) && !shell.includes(id)), [], 'controls with copy that the table does not list');
  assert.deepEqual([...listed, ...shell].filter((id) => !control[id.toLowerCase()]), [], 'listed controls without copy');
  for (const id of listed) for (const key of Object.values(controlKeys(id))) assert.ok(t(key).trim(), key);
  // Every inventory id the Settings code tags a control with is in the table (or is window chrome).
  const shared = new URL('../public/shared/', import.meta.url);
  const sources = ['ui-settings.js', 'ui-judgments.js', 'ui-whatsapp.js', 'ui-memory-maintenance.js', 'whatsapp/wa-view.js', '../variant/2d/settings-gfx.js']
    .map((name) => new URL(name, shared)).filter((url) => existsSync(url));
  const tagged = new Set();
  // The same rule as settings-ia.test.mjs: an inventory id in quotes is a control, however the code passes it around.
  for (const url of sources) for (const m of readFileSync(url, 'utf8').matchAll(/['"]([A-Z]{2,4}\d{3})['"]/g)) tagged.add(m[1]);
  assert.ok(tagged.size > 350, `found the tagged controls (${tagged.size})`);
  assert.deepEqual([...tagged].filter((id) => !listed.includes(id) && !shell.includes(id)), [], 'tagged in the code but not in the table');
  // The design inventory, when it is in the tree, agrees on where each control lives.
  const inventory = new URL('../../docs/design/settings-redesign/inventory-final.json', import.meta.url);
  if (existsSync(inventory)) {
    const rows = JSON.parse(readFileSync(inventory, 'utf8'));
    for (const item of rows) {
      const home = homeOfControl(item.id);
      if (!home) continue;
      assert.equal(home.page, item.page_id, `${item.id}: page`);
      if (pageOfSection(item.section_id)) assert.equal(home.section, item.section_id, `${item.id}: section`);
    }
  }
});

test('COVERAGE: every page, section and control of the IA is an entry with a title and a target that resolves', () => {
  const expect = [];
  for (const page of SETTINGS_PAGES) {
    expect.push({ id: `page:${page.id}`, kind: 'page', page: page.id, section: null });
    for (const id of controlsOfPage(page.id)) expect.push({ id: `control:${id}`, kind: 'control', page: page.id, section: null, control: id });
    for (const section of page.sections) {
      expect.push({ id: `section:${section.id}`, kind: 'section', page: page.id, section: section.id });
      for (const id of controlsOfSection(section.id)) expect.push({ id: `control:${id}`, kind: 'control', page: page.id, section: section.id, control: id });
    }
  }
  assert.equal(expect.filter((e) => e.kind === 'page').length, 11);
  assert.equal(expect.filter((e) => e.kind === 'section').length, SETTINGS_PAGES.reduce((n, p) => n + p.sections.length, 0));
  assert.ok(expect.filter((e) => e.kind === 'control').length >= 397);
  assert.deepEqual(index.entries.map((e) => e.id), expect.map((e) => e.id), 'exactly the IA, in IA order');
  assert.equal(new Set(index.entries.map((e) => e.id)).size, index.entries.length);

  for (const want of expect) {
    const entry = index.byId.get(want.id);
    assert.ok(entry, want.id);
    assert.deepEqual([entry.kind, entry.page, entry.section], [want.kind, want.page, want.section], want.id);
    assert.ok(entry.title && normalizeSearchText(entry.title), `${want.id}: a title with letters in it`);
    assert.ok(entry.path, `${want.id}: a path`);
    assert.doesNotMatch(`${entry.title} ${entry.path} ${entry.help} ${entry.keywords}`, /settings\.redesign\./, `${want.id}: no untranslated key`);
    assert.equal(entry.runtime, false);

    // The target is a deep link: resolveSettingsTarget names the page, opens the section and lands on the entry.
    const target = resolveSettingsTarget(entry.target);
    assert.equal(target.tab, want.page, `${want.id}: page`);
    if (want.kind === 'page') { assert.deepEqual([target.expand, target.scrollTo], [[], null], want.id); continue; }
    if (want.section) assert.ok(target.expand.includes(want.section), `${want.id}: opens ${want.section}`);
    const lands = want.kind === 'control' ? want.control : want.section;
    assert.deepEqual([target.scrollTo, target.highlight], [lands, [lands]], `${want.id}: lands on ${lands}`);
    if (want.kind === 'control') {
      assert.deepEqual(homeOfControl(want.control), { page: want.page, section: want.section }, `${want.id}: home`);
      // The same link with nothing but the control's id still finds its page and section.
      const bare = resolveSettingsTarget({ scrollTo: want.control });
      assert.deepEqual([bare.tab, bare.expand], [want.page, want.section ? [want.section] : []], `${want.id}: a bare control link`);
    }
  }
});

test('COVERAGE: searching an entry by its own full title returns it first or tied first', () => {
  for (const entry of index.entries) {
    const found = searchSettings(index, entry.title, { limit: index.entries.length });
    const mine = found.results.find((r) => r.entry.id === entry.id);
    assert.ok(mine, `"${entry.title}" finds ${entry.id}`);
    assert.equal(mine.typo, false);
    assert.equal(mine.score, found.results[0].score, `"${entry.title}": ${entry.id} is first or tied first (first is ${found.results[0].entry.id})`);
    assert.ok(mine.ranges.title.length >= 1, `${entry.id}: its title is marked`);
  }
  // In Portuguese too.
  const pt = buildSettingsSearchIndex({ t: translator(locale('pt-BR')), variants: ['graphics'] });
  for (const entry of pt.entries) {
    const found = searchSettings(pt, entry.title, { limit: pt.entries.length });
    assert.equal(found.results.find((r) => r.entry.id === entry.id)?.score, found.results[0].score, `pt-BR "${entry.title}": ${entry.id}`);
  }
});

test('variants: the 2D map is searchable only while its tab is loaded; an unknown variant tab is a section of its own', () => {
  const plain = buildSettingsSearchIndex({ t });
  assert.equal(plain.byId.has('section:stg-sec-2d-graph'), false);
  assert.equal(plain.byId.has('control:GFX001'), false);
  assert.equal(searchSettings(plain, 'card spacing').results.some((r) => r.entry.id === 'control:GFX003'), false);
  assert.equal(first('card spacing').entry.id, 'control:GFX003');
  assert.equal(first('graphics').entry.id, 'section:stg-sec-2d-graph', 'the old Graphics tab');
  assert.equal(index.entries.length - plain.entries.length, 9);
  for (const variants of [['graphics'], [{ id: 'graphics', label: 'Graphics' }]]) assert.equal(buildSettingsSearchIndex({ t, variants }).entries.length, index.entries.length);
  const other = buildSettingsSearchIndex({ t, variants: [{ id: 'lab', label: 'Lab tools' }] });
  const lab = other.byId.get('section:stg-sec-variant-lab');
  assert.deepEqual([lab.title, lab.page, lab.target.scrollTo], ['Lab tools', 'appearance', 'stg-sec-variant-lab']);
  assert.equal(searchSettings(other, 'lab tools').results[0].entry.id, lab.id);
});

test('the list is capped, and says how many there are', () => {
  assert.equal(SEARCH_LIMIT, 50);
  const many = searchSettings(index, 'a');
  assert.ok(many.total > SEARCH_LIMIT);
  assert.equal(many.results.length, SEARCH_LIMIT);
  assert.equal(searchSettings(index, 'a', { limit: 5 }).results.length, 5);
  assert.deepEqual(searchSettings(index, 'a', { limit: 5 }).results.map((r) => r.entry.id), many.results.slice(0, 5).map((r) => r.entry.id));
});

test('it is fast enough to run on every keystroke', () => {
  const queries = ['a', 'ap', 'api', 'api k', 'api key', 'notifcations', 'proxy password', 'memory', 's', 'the browser profile'];
  const start = performance.now();
  for (let i = 0; i < 20; i++) for (const query of queries) searchSettings(index, query);
  const each = (performance.now() - start) / (20 * queries.length);
  assert.ok(each < 8, `${each.toFixed(2)} ms per query`);
});

test('the shell wires it: one search field, a combobox with a listbox, the deep-link machinery, CRLF kept', () => {
  const settings = read('../public/shared/ui-settings.js');
  const shell = read('../public/shared/settings/settings-shell.js');
  const css = read('../public/shared/styles.css');
  assert.equal((settings.match(/id="stg-search-input"/g) || []).length, 1, 'one search field for the whole modal');
  assert.match(settings, /role="combobox" aria-expanded="false" aria-controls="stg-search-list" aria-autocomplete="list" aria-label="\$\{kit\.te\('settings\.redesign\.search\.label'\)\}" placeholder="\$\{kit\.te\('settings\.redesign\.search\.placeholder'\)\}"/);
  assert.match(settings, /id="stg-search-list" role="listbox" aria-label="\$\{kit\.te\('settings\.redesign\.search\.results'\)\}"/);
  assert.match(settings, /id="stg-search-clear" aria-label="\$\{kit\.te\('settings\.redesign\.search\.clear'\)\}"/);
  assert.match(settings, /id="stg-search-status" role="status" aria-live="polite"/);
  assert.match(settings, /<div class="stg-sidebar">\r?\n\s*\$\{buildSearchHTML\(\)\}\r?\n\s*<nav class="settings-nav"/, 'the field sits above the page list');
  assert.match(settings, /buildSettingsSearchIndex\(\{ t: kit\.tx, en, variants: variantTabs\.map\(/, 'built with the kit\'s translate function, and the English one when there is one');
  assert.match(settings, /const english = getLocale\(\) === 'en' \? null : englishTranslator\(\);/, 'English comes from the bundle i18n already holds');
  assert.match(settings, /english: getLocale\(\) === 'en' \|\| english \? null : \(\) => loadEnglishTranslator\(\)/, 'and is loaded lazily only when i18n has none');
  // A result lands through the deep-link machinery, and nothing in the search path stores a section.
  assert.match(settings, /let landed = applySettingsOpenOptions\(overlay, options\);/);
  const landing = settings.slice(settings.indexOf('function landOnSearchEntry'), settings.indexOf('// MAIN ENTRY'));
  const search = shell.slice(shell.indexOf('// ── Search'));
  for (const [name, code] of [['landOnSearchEntry', landing], ['wireSettingsSearch', search]]) {
    assert.doesNotMatch(code, /storeSectionState|localStorage|SECTIONS_OPEN_KEY/, `${name} never stores a section's state`);
    assert.doesNotMatch(code, /fetch\(|XMLHttpRequest|WebSocket/, `${name} makes no network call`);
    assert.deepEqual((code.match(/[\w.]+\.value\b/g) || []).filter((ref) => ref !== 'input.value'), [], `${name} reads no value but the search field's own`);
  }
  assert.match(search, /aria-activedescendant/);
  // Escape empties a query from anywhere in the panel (an editor that prevented it keeps it); the handler that closes Settings asks first.
  assert.match(search, /overlay\.addEventListener\('keydown', \(e\) => \{\n\s*if \(e\.key !== 'Escape' \|\| e\.isComposing \|\| e\.defaultPrevented\) return;\n\s*if \(!emptyQuery\(\)\) return;/);
  assert.match(search, /const emptyQuery = \(\) => \{ if \(input\.value === ''\) return false; reset\(\); return true; \};/);
  assert.match(settings, /if \(overlay\._stgSearchEscape\?\.\(\)\) \{ e\.preventDefault\(\); return; \}\r?\n\s*close\(\);/, 'Escape closes Settings only on an empty field');
  // The board behind Settings takes keys at the document, before anything in the panel: it backs off while the keyboard
  // is inside the panel, or Escape on a landed row would reach neither the search nor the handler that closes Settings.
  const board = read('../public/shared/ui-whiteboard.js');
  const boardKeys = board.slice(board.indexOf('function onKeyDown(e) {'), board.indexOf('// List Enter'));
  assert.match(boardKeys, /if \(ae\?\.closest\?\.\('#settings-panel'\)\) return;/);
  assert.doesNotMatch(boardKeys.slice(0, boardKeys.indexOf("closest?.('#settings-panel')")), /e\.key\b/, 'before the board looks at any key');
  // Cmd+F and Ctrl+F on every platform: the platform a browser reports is not asked.
  assert.match(search, /if \(e\.altKey \|\| e\.shiftKey \|\| e\.metaKey === e\.ctrlKey\) return;/);
  assert.doesNotMatch(shell, /navigator\.(platform|userAgent)/);
  assert.match(search, /document\.removeEventListener\('keydown', onFind, true\)/, 'the shortcut is given back when Settings closes');
  // The English index is asked for once, on the first focus, and the search path itself still makes no request.
  assert.match(search, /input\.addEventListener\('focus', \(\) => \{\n\s*if \(typeof english !== 'function'\) return;\n\s*const load = english;\n\s*english = null;/);
  // Whatever moves the view for the user lets go on the same signals: a deep link kept in place, and a row landed on again.
  assert.match(shell, /for \(const type of \['wheel', 'touchstart', 'pointerdown', 'input'\]\) overlay\.addEventListener\(type, fn, \{ passive: true \}\);\n\s*document\.addEventListener\('keydown', onKey, true\);/);
  assert.match(shell, /const onKey = \(e\) => \{ if \(!e\.repeat\) fn\(e\); \};/);
  const reland = settings.slice(settings.indexOf('function relandRedrawnRow'), settings.indexOf('function landOnSearchEntry'));
  assert.match(reland, /offTakeover = onSettingsTakeover\(overlay, stop\);/);
  assert.match(reland, /landOnSearchEntry\(overlay, entry, \{ focus: focus && lostFocus, watch: false \}\);/, 'the kept result itself is landed on, not a copy');
  assert.match(landing, /rowEl = currentSearchRow\(overlay, entry\);/, 'a kept result finds its redrawn row before it falls back to the section');
  // A project's panel opens whether the target is the panel or sits inside it; nothing is stored.
  const reveal = shell.slice(shell.indexOf('export function revealSettingsTarget'), shell.indexOf('const FOLLOW_MS'));
  assert.match(reveal, /if \(node\.matches\?\.\('\.cc-panel:not\(\.open\)'\)\) node\.classList\.add\('open'\);/);
  assert.doesNotMatch(reveal, /localStorage|storeSectionState/);
  // Secrets and the user's own content are never read: labels only, and the lists of memories, messages and logs are off limits.
  assert.match(search, /const TEXT_SKIP = 'select, textarea, input, button,/);
  for (const off of ['#jv-log-list', '#jv-sessions-list', '#jv-triage-list', '#wa-activity-list', '#memory-maintenance details']) assert.ok(settings.includes(off), `${off} is never read`);
  // The search block, then the nav-polish block (sidebar tiles and the field's look), after every other settings block; the files that are CRLF stay CRLF.
  const blocks = [...css.matchAll(/\/\* (>>>|<<<) settings-redesign:([\w-]+) \*\//g)].map((m) => `${m[1]}${m[2]}`);
  assert.deepEqual(blocks.slice(-4), ['>>>search', '<<<search', '>>>nav-polish', '<<<nav-polish']);
  assert.equal(blocks.filter((b) => b === '>>>search').length, 1);
  const block = css.slice(css.indexOf('/* >>> settings-redesign:search */'), css.indexOf('/* <<< settings-redesign:search */'));
  assert.match(block, /prefers-reduced-motion: reduce/);
  assert.match(block, /@container stg \(max-width: 560px\)/);
  assert.match(block, /\.stg-search-input \{[^}]*height: 34px/);
  // The block's colours are the panel's --stg-* roles: no app accent, no white fills, no colour baked into an image,
  // no coloured border. The literals left are the page list's own (its fill, white on the accent fill, the white tile glyph).
  const rules = block.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(rules, /--accent-blue|rgba\(255|%23|url\(|border-color/);
  assert.deepEqual(rules.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi), ['rgba(0,0,0,0.14)', '#fff', '#fff']);
  assert.match(rules, /\.stg-search-result\.active:hover \{ color: #fff; background: color-mix\(in srgb, var\(--stg-accent-fill\) 85%, transparent\); \}/);
  assert.match(rules, /\.stg-search-result \.stg-nav-icon svg \{[^}]*stroke: #fff;/);
  assert.match(css, /\.settings-panel \.settings-nav-item\.active:hover \{ color: #fff; background: var\(--stg-accent-fill\); \}/, 'the literal it matches');
  assert.match(css, /\.settings-panel \.settings-nav \{[^}]*background: rgba\(0,0,0,0\.14\);/, 'the literal it matches');
  assert.match(rules, /\.stg-search-glyph \{[^}]*color: var\(--stg-help\);[^}]*stroke: currentColor;/, 'the magnifier is drawn in currentColor');
  assert.match(settings, /<svg class="stg-search-glyph" viewBox="0 0 16 16" aria-hidden="true">/);
  // A field of a mode the form is not in names the control that would show it; the Add-a-server form's popup and number
  // fields stack under their label (their cell is half the form wide), so the row a landing lights is a row.
  assert.equal((settings.match(/data-stg-shown-by="#stg-mcp-srv-type"/g) || []).length, 4);
  assert.match(settings, /if \(!switcher && box\.dataset\?\.stgShownBy\)/);
  assert.match(css, /\.settings-panel \.stg-card \.stg-mcp-form-grid \.stg-field:has\(> :is\(select, input\[type="number"\]\)\) \{ display: block; \}/);
  for (const [name, text] of [['ui-settings.js', settings], ['styles.css', css], ['ui-whiteboard.js', board], ['i18n.js', read('../public/shared/i18n.js')], ['en.json', read('../i18n/en.json')], ['pt-BR.json', read('../i18n/pt-BR.json')]]) {
    assert.equal((text.match(/\r\n/g) || []).length, (text.match(/\n/g) || []).length, `${name} keeps CRLF line endings`);
  }
});
