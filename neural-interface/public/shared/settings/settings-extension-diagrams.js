// The guide's close-ups of a browser's Extensions page (Settings → Browser → the extension's setup guide): original
// vector drawings of the one control each step asks for, with a ring and a leader to it and its name beside it. They are
// a picture of where to look, never the instruction itself: every step says the same in HTML outside the drawing, and
// each figure carries its own caption. No imports, no DOM: node --test reads the markup.
//
// Placement is drawn only where it is known: Developer mode sits at the top right of the Extensions header in Chrome,
// Brave, Arc, Vivaldi and Chromium, and in the left sidebar in Edge. Any other browser gets the switch by its label,
// with a caption that says the picture is a Chrome-style example (developerLayout, settings-extension-guide.js).
// Colours are classes (styles.css → "browser-extension-guide"), so the drawing follows Settings' tokens.
import { developerLayout } from './settings-extension-guide.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rect = (x, y, w, h, cls, r = 6) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" class="${cls}"/>`;
const text = (x, y, value, size, cls = 'bg-t', anchor = 'start') => `<text x="${x}" y="${y}" font-size="${size}" class="${cls}"${anchor !== 'start' ? ` text-anchor="${anchor}"` : ''}>${esc(value)}</text>`;
const line = (d, cls = 'bg-ln') => `<path d="${d}" class="${cls}"/>`;
const toggle = (x, y) => `${rect(x, y, 40, 22, 'bg-track', 11)}<circle cx="${x + 29}" cy="${y + 11}" r="8" class="bg-knob"/>`;
const ring = (x, y, w, h) => `${rect(x, y, w, h, 'bg-halo', 8)}${rect(x, y, w, h, 'bg-ring', 8)}`;
// A label's width in the drawing, from its length (a little wider than the panel's fonts set it): translations run
// longer than English, and the boxes grow with them.
const textWidth = (value, size) => Math.round(String(value).length * size * 0.56);
const width = (value, size, pad = 24, max = 220) => Math.min(max, textWidth(value, size) + pad);
const button = (x, y, value, size = 12) => { const w = width(value, size); return { w, svg: `${rect(x, y, w, 27, 'bg-panel', 6)}${text(x + 12, y + 18, value, size)}` }; };
// The largest size, from `size` down to 10, at which `value` fits in `room`; past that it is squeezed into `room`
// (SVG textLength), never drawn wider.
const fitText = (value, size, room) => {
  let s = size; while (s > 10 && textWidth(value, s) > room) s -= 0.5;
  const w = textWidth(value, s);
  return w > room ? { size: s, w: room, squeeze: true } : { size: s, w, squeeze: false };
};

// The Developer mode label where developerGeometry put it (squeezed to its width when even 10 px is too wide).
const devText = (at, value) => `<text x="${at.x}" y="${at.y}" font-size="${at.size}" class="bg-t"${at.squeeze ? ` textLength="${at.w}" lengthAdjust="spacingAndGlyphs"` : ''}>${esc(value)}</text>`;

/** The switch's track: TOGGLE_W wide. */
export const TOGGLE_W = 40;
/**
 * Where the Developer mode label, its switch and the ring around both go (Step 2's drawing), from the label's own
 * width: the switch always after the label with a gap, the ring around both with the same margin on each side. In
 * Edge's sidebar the sidebar grows with the label (to SIDEBAR_MAX), and the divider and the installed-extensions panel
 * move right with it; in the Chrome-style header the label grows to the left of the switch. All in viewBox units
 * (520 × 166). Pure: the tests check that nothing overlaps in any locale.
 */
export const SIDEBAR_MAX = 262;
export function developerGeometry(layout, label) {
  const gap = 16;
  if (layout === 'sidebar') {
    const textX = 28, toggleY = 90, toggleMax = SIDEBAR_MAX - 14 - TOGGLE_W;
    const fit = fitText(label, 13, toggleMax - gap - textX), textW = fit.w;
    const toggleX = Math.max(146, textX + textW + gap), toggleEnd = toggleX + TOGGLE_W;
    const ring = { x: textX - 8, y: 82, w: toggleEnd + 8 - (textX - 8), h: 39 };
    const sideEnd = Math.max(208, toggleEnd + 14);
    const panelX = sideEnd + 18;
    return { layout, text: { x: textX, y: 106, w: textW, size: fit.size, squeeze: fit.squeeze }, toggle: { x: toggleX, y: toggleY, w: TOGGLE_W }, ring, sideEnd, panel: { x: panelX, w: 479 - panelX } };
  }
  const toggleX = 444, toggleEnd = toggleX + TOGGLE_W, pad = 10;
  // The label may grow left up to the page title's end ("Extensions", 18px, at x 32) with room to spare.
  const fit = fitText(label, 13, toggleX - gap - 160), textW = fit.w, textX = toggleX - gap - textW;
  return { layout, text: { x: textX, y: 49, w: textW, size: fit.size, squeeze: fit.squeeze }, toggle: { x: toggleX, y: 33, w: TOGGLE_W }, ring: { x: textX - pad, y: 25, w: toggleEnd + pad - (textX - pad), h: 38 }, header: { x: 15, w: 490 } };
}

/**
 * The figure for a guide step (2 Developer mode, 3 Load unpacked, 5 Details, 6 Allow user scripts), or null for a step
 * without one. `t(key)` gives the translated string of browserExtension.guide.<key> (unescaped); `browser`: { id, name }.
 * Returns { html, layout }: the <figure> with its header, drawing and caption.
 */
export function guideFigure(step, { browser, address = '', t }) {
  const id = browser?.id || '', name = browser?.name || '';
  const ui = key => t(`ui.${key}`);
  let art = '', caption = '', label = '', layout = '';
  if (step === 2) {
    layout = developerLayout(id);
    const dev = ui('developerMode');
    const geo = developerGeometry(layout === 'sidebar' ? 'sidebar' : 'header', dev), r = geo.ring;
    if (layout === 'sidebar') {
      const side = geo.sideEnd, panel = geo.panel;
      art = rect(14, 12, 492, 128, 'bg-frame', 8) + rect(15, 13, side - 15, 126, 'bg-surface', 7) + line(`M${side} 13v126`) + text(28, 38, ui('extensions'), 16, 'bg-t bg-strong')
        + text(28, 63, ui('manage'), 12, 'bg-t bg-muted') + line(`M28 77h${side - 46}`) + devText(geo.text, dev) + toggle(geo.toggle.x, geo.toggle.y) + ring(r.x, r.y, r.w, r.h)
        + text(panel.x, 40, ui('installed'), 15) + rect(panel.x, 54, panel.w, 56, 'bg-surface', 6) + text(panel.x + 14, 86, ui('bridgeName'), 13, 'bg-t bg-muted')
        + line('M108 123v28h60', 'bg-lead') + text(176, 156, t('figDeveloperCall'), 13, 'bg-t bg-call');
      caption = t('figDeveloperEdge'); label = t('figDeveloperEdgeName');
    } else {
      art = rect(14, 17, 492, 109, 'bg-frame', 8) + rect(15, 18, 490, 50, 'bg-surface', 7) + line('M15 68h490') + text(32, 49, ui('extensions'), 18, 'bg-t bg-strong')
        + devText(geo.text, dev) + toggle(geo.toggle.x, geo.toggle.y) + ring(r.x, r.y, r.w, r.h) + text(32, 100, ui('mine'), 14, 'bg-t bg-muted')
        + line('M414 65v64l-11 12h-52', 'bg-lead') + text(345, 146, t('figDeveloperCall'), 14, 'bg-t bg-call', 'end');
      caption = layout === 'header' ? t('figDeveloperHeader', { browser: name }) : t('figDeveloperUnverified', { browser: name });
      label = t('figDeveloperName');
    }
  } else if (step === 3) {
    const load = button(33, 74, ui('loadUnpacked')), pack = button(33 + load.w + 12, 74, ui('pack')), update = button(33 + load.w + pack.w + 24, 74, ui('update'));
    art = rect(14, 15, 492, 113, 'bg-frame', 8) + text(32, 47, ui('extensions'), 18, 'bg-t bg-strong') + text(445, 45, ui('developerMode'), 12, 'bg-t bg-muted', 'end')
      + rect(457, 32, 29, 16, 'bg-on', 8) + '<circle cx="478" cy="40" r="6" class="bg-knob-off"/>' + line('M15 58h490')
      + load.svg + (33 + load.w + pack.w + 24 + update.w < 500 ? pack.svg + update.svg : '') + ring(28, 68, load.w + 10, 39)
      + line(`M${33 + Math.round(load.w / 2)} 109v32h${Math.max(20, 122 - Math.round(load.w / 2))}`, 'bg-lead') + text(160, 146, t('figLoadCall'), 14, 'bg-t bg-call');
    caption = t('figLoad'); label = t('figLoadName');
  } else if (step === 5) {
    const details = button(44, 85, ui('details')), remove = button(44 + details.w + 14, 85, ui('remove'));
    art = rect(25, 12, 471, 119, 'bg-surface', 9) + rect(42, 28, 42, 42, 'bg-frame', 8) + '<path d="M52 44h22M52 54h22" class="bg-mark"/>'
      + text(99, 45, ui('bridgeName'), 17, 'bg-t bg-strong') + text(99, 64, ui('bridgeMeta'), 12, 'bg-t bg-muted') + details.svg + remove.svg
      + rect(444, 91, 32, 18, 'bg-on', 9) + '<circle cx="467" cy="100" r="6.5" class="bg-knob-off"/>' + ring(39, 79, details.w + 10, 39)
      + line(`M${44 + Math.round(details.w / 2)} 120v25h${Math.max(20, 114 - Math.round(details.w / 2))}`, 'bg-lead') + text(165, 150, t('figDetailsCall'), 14, 'bg-t bg-call');
    caption = t('figDetails'); label = t('figDetailsName');
  } else if (step === 6) {
    art = rect(14, 15, 492, 112, 'bg-frame', 8) + text(32, 43, ui('bridgeName'), 16, 'bg-t bg-strong') + text(32, 64, ui('extensionDetails'), 12, 'bg-t bg-muted')
      + line('M15 75h490') + text(32, 106, ui('allowUserScripts'), 15) + toggle(444, 86) + ring(437, 81, 54, 32)
      + line('M464 115v28h-74', 'bg-lead') + text(384, 148, t('figScriptsCall'), 14, 'bg-t bg-call', 'end');
    caption = t('figScripts'); label = t('figScriptsName');
  } else return null;
  const titleId = `bc-guide-fig-${step}`;
  const tour = { 2: layout === 'sidebar' ? t('tourSidebar') : layout === 'header' ? t('tourHeader') : t('tourExample'), 3: t('tourToolbar'), 5: t('tourCard'), 6: t('tourDetails') }[step];
  const html = `<figure class="bc-guide-figure" data-figure-step="${step}" data-layout="${layout || 'fixed'}">
    <div class="bc-guide-figure-head"><strong>${esc(name)}</strong><span>${esc(tour)}</span>${address ? `<code dir="ltr">${esc(address)}</code>` : ''}</div>
    <svg class="bc-guide-art" viewBox="0 0 520 166" role="img" aria-labelledby="${titleId}" focusable="false"><title id="${titleId}">${esc(label)}</title>${art}</svg>
    <figcaption>${esc(caption)}</figcaption>
  </figure>`;
  return { html, layout: layout || 'fixed' };
}
