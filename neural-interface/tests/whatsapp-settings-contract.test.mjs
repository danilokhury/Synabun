import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const settings = read('../public/shared/ui-settings.js');
const sync = read('../public/shared/ui-sync.js');
const tab = read('../public/shared/ui-whatsapp.js');
import { SETTINGS_PAGES, SETTINGS_TAB_ALIASES, pageOfPane, resolveSettingsTarget } from '../public/shared/settings/settings-ia.js';
import { menuOpensAbove } from '../public/shared/assistant/asst-menu.js';

test('WhatsApp is a pane of the Messages page, ahead of Discord, in the Automations group', () => {
  const page = pageOfPane('whatsapp');
  assert.equal(page.id, 'messages');
  assert.equal(page.group, 'automations');
  assert.deepEqual(page.panes.map((p) => p.id), ['whatsapp', 'discord']);
  assert.equal(page.icon, 'whatsapp');
  // The old tab id still opens it (deep links, the browser suite).
  assert.deepEqual(SETTINGS_TAB_ALIASES.whatsapp, { page: 'messages', section: 'wa-sec-setup' });
  assert.equal(resolveSettingsTarget({ tab: 'whatsapp', expand: ['wa-sec-safety'] }).tab, 'messages');
});

test('every pane has a page (MoreLogin was once missing from the nav)', () => {
  const panes = SETTINGS_PAGES.flatMap((p) => p.panes.map((x) => x.id));
  assert.ok(panes.length >= 22, 'every former tab is a pane');
  assert.equal(pageOfPane('morelogin').id, 'connected-tools');
  // A page keeps its group together in the nav (group headers are emitted when the group changes).
  const groups = SETTINGS_PAGES.map((p) => p.group);
  const seen = new Set();
  for (let i = 0; i < groups.length; i++) {
    if (i && groups[i] !== groups[i - 1]) { assert.equal(seen.has(groups[i]), false, `group ${groups[i]} is split in the nav`); }
    seen.add(groups[i]);
  }
});

test('the nav icon is stroke-only (the nav CSS forces fill:none; stroke:currentColor)', () => {
  const icon = /\n\s*whatsapp: '(<svg[^']*<\/svg>)',/.exec(settings)?.[1];
  assert.ok(icon, 'TAB_ICONS.whatsapp');
  assert.match(icon, /^<svg viewBox="0 0 24 24">/);
  assert.doesNotMatch(icon, /fill="(?!none)/, 'no filled shapes');
  assert.doesNotMatch(icon, /<(?:text|image|use|style|script)\b/);
  assert.ok((icon.match(/<path\b/g) || []).length >= 1);
});

test('the shell is built with the other tabs and wired after them; nothing blocks the panel opening', () => {
  assert.match(settings, /import \{ buildWhatsAppTab, wireWhatsAppTab \} from '\.\/ui-whatsapp\.js';/);
  assert.match(settings, /discord: buildDiscordTab\(discordConfig\),\s*\n\s*whatsapp: buildWhatsAppTab\(\),/);
  assert.match(settings, /wireWhatsAppTab\(overlay, \{ toast: showCCToast \}\);/);
  const allSettled = /await Promise\.allSettled\(\[([\s\S]*?)\]\);/.exec(settings)[1];
  assert.ok(allSettled.includes("fetch('/api/settings')"), 'found the blocking fetch block');
  assert.equal(allSettled.includes('/api/whatsapp'), false, 'no WhatsApp request in the blocking Promise.allSettled');
  // The nav dot is set by the tab when its status arrives, never by the shell while it builds.
  assert.doesNotMatch(settings, /kit\.setNavStatus\(overlay, 'whatsapp'/);
  assert.match(tab, /kit\.setNavStatus\(overlay, 'whatsapp', view\.nav\)/);
});

test('ui-sync relays whatsapp:status to the bus; the tab listens and re-reads masked status', () => {
  assert.match(sync, /'whatsapp:status':\s*\(msg\) => emit\('sync:whatsapp:status', msg\)/);
  assert.match(tab, /on\('sync:whatsapp:status'/);
  assert.match(tab, /overlay\.addEventListener\('settings-close', teardown\)/);
  assert.match(tab, /'X-SynaBun-UI': '1'/);
  assert.match(tab, /export function buildWhatsAppTab\(\)/);
  assert.match(tab, /export function wireWhatsAppTab\(overlay, \{ toast = \(\) => \{\} \} = \{\}\)/);
  // The QR is shown as an image from a data: URI, never as inline markup from the network.
  assert.match(tab, /data:image\/svg\+xml;base64,/);
  assert.doesNotMatch(tab, /innerHTML\s*=\s*event\.svg|innerHTML\s*=\s*svg/);
});

test('Safety shows why a WhatsApp conversation is read-only because of its brain (brainLimitText)', () => {
  assert.match(tab, /id="wa-brain-warning"/);
  assert.match(tab, /brainLimitText\(s\)/);
});

test('the model selector is the Assistant\'s own picker: its catalog, its model menu, its effort list; saved through PUT /config', () => {
  // No second catalog: the tab imports the picker's loader, menu and row lookup, and the shared effort table.
  assert.match(tab, /import \{ catalogModelRow, loadModelCatalog, openModelMenu \} from '\.\/assistant\/asst-brain-picker\.js';/);
  assert.match(tab, /import \{ getEffortLevelsForModel \} from '\.\/agent-runtime-options\.js';/);
  assert.doesNotMatch(tab, /fetch\(['"`]\/api\/(?:assistant\/catalog|claude\/models|codex\/models|opencode)/, 'the tab fetches no model list of its own');
  // The control, in the Conversation card, with its hint and the note box in the tab's own callout style.
  const conversation = tab.slice(tab.indexOf("id: 'wa-sec-conversation'"), tab.indexOf("id: 'wa-sec-safety'"));
  assert.match(conversation, /id="wa-brain-model" aria-haspopup="menu"/);
  assert.match(conversation, /id="wa-brain-effort" aria-haspopup="menu" aria-expanded="false" hidden/);
  assert.match(conversation, /class="wa-callout wa-callout-warn" id="wa-brain-note" role="status" hidden/);
  assert.match(conversation, /\$\{esc\(BRAIN_COPY\.same\)\}/, 'the shell starts on the default, before any status arrives');
  // "Same as the Assistant" is the menu's first entry; no free-typed model ids (the server would refuse them anyway).
  assert.match(tab, /includeHere: true, hereLabel: BRAIN_COPY\.same/);
  assert.match(tab, /allowCustom: false/);
  assert.match(tab, /saveBrain\(null\)/);
  assert.match(tab, /putConfig\(\{ brain \}\)/, 'the versioned settings write');
  // Rendered from the status through wa-view (a status without the field is the default).
  assert.match(tab, /brainChoiceLabel\(s, \{ modelLabel: row\?\.label \|\| '' \}\)/);
  assert.match(tab, /brainChoiceNotes\(s\)/);
  // The Assistant's menu opens above the Settings panel.
  assert.match(tab, /zIndex: MENU_Z/);
  const menu = read('../public/shared/assistant/asst-menu.js');
  assert.match(menu, /menu\.style\.zIndex = String\(Number\(zIndex\)\)/);
  assert.match(read('../public/shared/assistant/asst-brain-picker.js'), /zIndex: opts\.zIndex \?\? null/);
  // …and under its button when a usable list fits there (opening upward covered the Settings header).
  assert.match(tab, /placement: 'prefer-below'/);
  assert.match(read('../public/shared/assistant/asst-brain-picker.js'), /^\s+placement,$/m, 'the picker hands the placement to the menu');
  // No new colors or fonts: the selector adds no styles of its own.
  assert.doesNotMatch(tab, /style="[^"]*(?:color|font)/);
});

test('the Settings model menu opens under its button when a usable list fits there; the panel\'s own placements are unchanged', () => {
  // The reported case: an 835 px viewport, the button at y 420, a 380 px menu. More room above (406) than below (371).
  const reported = { anchorTop: 420, anchorHeight: 30, menuHeight: 380, above: 420 - 14, below: 835 - 450 - 14, viewportHeight: 835 };
  assert.equal(menuOpensAbove('auto', reported), true, 'the panel\'s rule opened it upward, over the Settings header');
  assert.equal(menuOpensAbove('prefer-below', reported), false, 'Settings opens it downward: the list scrolls inside the room below');
  // Too little room under the button for a usable list, and more above: upward after all.
  const low = { anchorTop: 700, anchorHeight: 30, menuHeight: 380, above: 700 - 14, below: 835 - 730 - 14, viewportHeight: 835 };
  assert.equal(menuOpensAbove('prefer-below', low), true);
  // A short menu that fits under a low button stays under it.
  assert.equal(menuOpensAbove('prefer-below', { ...low, menuHeight: 80 }), false);
  // The existing placements decide exactly as before.
  const table = [
    ['auto', reported, true], ['below', reported, true], ['above', reported, true],
    ['auto', { ...reported, menuHeight: 200 }, false], ['below', { ...reported, menuHeight: 200 }, false], ['above', { ...reported, menuHeight: 200 }, true],
    ['auto', low, true], ['below', low, true], ['above', low, true],
    ['auto', { anchorTop: 60, anchorHeight: 30, menuHeight: 380, above: 46, below: 731, viewportHeight: 835 }, false],
    ['above', { anchorTop: 60, anchorHeight: 30, menuHeight: 380, above: 46, below: 731, viewportHeight: 835 }, false],
  ];
  for (const [placement, box, up] of table) assert.equal(menuOpensAbove(placement, box), up, `${placement} ${JSON.stringify(box)}`);
  const menu = read('../public/shared/assistant/asst-menu.js');
  assert.match(menu, /const up = menuOpensAbove\(placement, \{ anchorTop: r\.top, anchorHeight: r\.height, menuHeight: mh, above, below, viewportHeight: vh \}\);/, 'positionMenu uses it');
  // Only the WhatsApp tab asks for it: the Assistant panel, its picker and the route chip keep their placements.
  for (const file of ['asst-panel.js', 'asst-brain-picker.js', 'asst-route.js']) assert.doesNotMatch(read(`../public/shared/assistant/${file}`), /prefer-below/, file);
});

test('every sentence of the selector has its English copy in en.json (settings.redesign.wa.*), and en.json is still CRLF', () => {
  const raw = read('../i18n/en.json');
  assert.equal(raw.split('\r\n').length - 1, raw.split('\n').length - 1, 'CRLF throughout');
  const wa = JSON.parse(raw).settings.redesign.wa;
  assert.deepEqual(Object.keys(wa.brainCopy).sort(), ['effort', 'effortDefault', 'hint', 'label', 'menuTitle', 'same', 'saved']);
  assert.deepEqual(Object.keys(wa.brain).sort(), ['fallbackDisabled', 'fallbackUnknown', 'readOnly', 'same', 'sameNow']);
  assert.equal(wa.brainCopy.same, 'Same as the Assistant');
  assert.match(wa.level.ask.body, /acts only on your yes/);
  assert.doesNotMatch(JSON.parse(raw).settings.redesign.whatsapp.answerAQuestionOrAnApproval, /number/);
});

test('Safety has a switch for computer use from WhatsApp: a toggle row like "ask again for every agent task", saved through PUT /config, off for a status without the field', () => {
  // The row: the section's own toggle-row style, named and described for assistive tech.
  const row = /<div class="settings-field wa-toggle-row"><span><strong id="wa-computer-label">\$\{kit\.te\('settings\.redesign\.whatsapp\.computerUse'\)\}<\/strong><small id="wa-computer-help">\$\{kit\.te\('settings\.redesign\.whatsapp\.letTheAssistantControlThisMac'\)\}<\/small><\/span>\$\{toggle\('wa-computer', true\)\}<\/div>/;
  assert.match(tab, row);
  const safety = /section\(\{ id: 'wa-sec-safety'[\s\S]*?\n      ` \}\)\}/.exec(tab)[0];
  assert.match(safety, row, 'inside the Safety section');
  assert.ok(safety.indexOf("toggle('wa-strict', true)") < safety.indexOf("toggle('wa-computer', true)"), 'right after the strict-approvals row');
  // The fact row that said it was off in this version is gone.
  assert.doesNotMatch(tab, /offFromWhatsappInThisVersion/);
  assert.doesNotMatch(tab, /<div><strong>\$\{kit\.te\('settings\.redesign\.whatsapp\.computerUse'\)\}<\/strong>/);
  // Reads: only `true` checks it, so an older status payload (no field) shows off.
  assert.match(tab, /setChecked\(\$\('wa-computer'\), s\?\.config\?\.computerUse === true\);/);
  // Persists: the same guarded, versioned PUT every setting of the tab uses (a failed save reloads the status, which resets the switch).
  assert.match(tab, /\$\('wa-computer'\)\.addEventListener\('change', \(\) => putConfig\(\{ computerUse: \$\('wa-computer'\)\.checked \}\)\);/);
  assert.match(tab, /async function putConfig\(patch, extra = \{\}\) \{\s*const r = await jsend\('PUT', '\/config', \{ config: patch, expectedVersion: state\.version, \.\.\.extra \}\);/);
  // Its copy, in both locales: what each level does with it, and that the phone never changes it.
  const en = JSON.parse(read('../i18n/en.json')).settings.redesign;
  const pt = JSON.parse(read('../i18n/pt-BR.json')).settings.redesign;
  assert.equal(en.whatsapp.computerUse, 'Computer use');
  assert.equal(en.whatsapp.letTheAssistantControlThisMac, 'Lets the Assistant control this Mac (mouse, keyboard, apps) from a WhatsApp conversation. Read-only: never. Ask on my phone: one yes from your phone turns it on for that task only. Autonomous: it works without asking while Autonomous is active. Off while WhatsApp is paused. Changed only here, never from the phone.');
  assert.match(pt.whatsapp.letTheAssistantControlThisMac, /Somente leitura: nunca\. Perguntar no meu celular: um sim do seu celular ativa só para aquela tarefa\. Autônomo: funciona sem perguntar/);
  for (const locale of [en, pt]) assert.equal('offFromWhatsappInThisVersion' in locale.whatsapp, false);
  // The fixed-limits entry says what is true now.
  assert.equal(en.wa.limits['4'], 'Computer use from WhatsApp is off until you turn it on above. Then: never at Read-only or while paused, after one yes per task at Ask on my phone, and without asking while Autonomous is active. Agents started from WhatsApp never get it.');
  assert.doesNotMatch(JSON.stringify([en.wa.limits, pt.wa.limits]), /in this version|nesta versão/);
  const view = read('../public/shared/whatsapp/wa-view.js');
  assert.ok(view.includes(`'${en.wa.limits['4']}',`), 'wa-view.js is the English source of the limit');
  // pt-BR stays CRLF too.
  const ptRaw = read('../i18n/pt-BR.json');
  assert.equal(ptRaw.split('\r\n').length - 1, ptRaw.split('\n').length - 1, 'pt-BR.json: CRLF throughout');
});
