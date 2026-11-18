// ═══════════════════════════════════════════
// SynaBun Neural Interface — Agents Studio: icons and colour tokens
// ═══════════════════════════════════════════
//
// An agent's `icon` is a name (lib/agents/schema.js: lower-case letters, digits, hyphens: never markup, a path or a
// URL) and its `color` a style-guide token ("status.info": never a raw colour). This module is what turns both
// into something drawn: the icons the editor offers, as inline SVG in the app's convention (24 px box, stroke 1.5,
// round caps, the Studio's `.sx-i`), and the tokens it offers, each with the class that gives it its colour
// (`.ax-tone--…` in the Agents Studio section of styles.css, whose values are the style guide's own). A name or a
// token this page does not know (an imported agent's) falls back to the default icon and the neutral tone; it is
// kept as written and shown as text. The window's own extra icons are here too.
// No DOM: `raw` only marks a constant of this file as markup.

import { raw } from '../../skills/studio/sx-dom.js';

const svg = (body, size = 16) => raw(`<svg class="sx-i" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`);

/** The paths of the icons an agent can have, by name. */
const AGENT_ICON_PATHS = Object.freeze({
  bot: '<rect x="5" y="8" width="14" height="11" rx="2.5"/><path d="M12 8V4M9.5 13v1.5M14.5 13v1.5M2.5 13v3M21.5 13v3"/><circle cx="12" cy="3.5" r="1"/>',
  code: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 6l-3 12"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  pen: '<path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/>',
  shield: '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
  bug: '<rect x="8" y="8" width="8" height="11" rx="4"/><path d="M9.5 8a2.5 2.5 0 0 1 5 0M4 13h4M16 13h4M5 7l3.2 2.6M19 7l-3.2 2.6M5 20l3.2-2.6M19 20l-3.2-2.6M12 12v7"/>',
  rocket: '<path d="M12 3c3 2 5 5.5 5 9.5L15 16H9l-2-3.5C7 8.5 9 5 12 3z"/><circle cx="12" cy="10" r="1.8"/><path d="M9 16l-1 4 4-2 4 2-1-4"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.8 2.3 4 5.2 4 8.5s-1.2 6.2-4 8.5c-2.8-2.3-4-5.2-4-8.5s1.2-6.2 4-8.5z"/>',
  book: '<path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H19v15H7.5A2.5 2.5 0 0 0 5 20.5z"/><path d="M5 20.5A2.5 2.5 0 0 0 7.5 21H19M9 8h6"/>',
  chart: '<path d="M4 4v16h16"/><path d="M8 15l3.5-4 3 2.5L19 8"/>',
  wrench: '<path d="M14.5 5.5a4 4 0 0 0-5.3 5.3L4 16l4 4 5.2-5.2a4 4 0 0 0 5.3-5.3L16 12l-3-1-1-3z"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 2-1 2-2 0-1.5-1-1.8-1-3 0-1 .8-1.5 2-1.5h2a3.5 3.5 0 0 0 3.5-3.5C20.5 6.6 16.7 3.5 12 3.5z"/><circle cx="8" cy="11" r="1"/><circle cx="11" cy="7.5" r="1"/><circle cx="15.5" cy="8" r="1"/>',
  megaphone: '<path d="M4 10v4h3l8 4V6l-8 4zM18 9.5a3.5 3.5 0 0 1 0 5M8 14v4.5h3V16"/>',
  flask: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3M7.5 15h9"/>',
  terminal: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10l3 2.5-3 2.5M12.5 15h4.5"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
});

/** The icon names the editor offers, in its order. */
export const AGENT_ICONS = Object.freeze(Object.keys(AGENT_ICON_PATHS));
export const DEFAULT_AGENT_ICON = 'bot';

/** Is this an icon the page can draw? */
export const knownIcon = (name) => typeof name === 'string' && Object.prototype.hasOwnProperty.call(AGENT_ICON_PATHS, name);

/** An agent's icon as markup (the default one for a name the page does not draw). */
export function agentIcon(name, size = 16) {
  return svg(AGENT_ICON_PATHS[knownIcon(name) ? name : DEFAULT_AGENT_ICON], size);
}

/**
 * The colour tokens the editor offers: style-guide tokens of this project (DESIGN.md → Colors: the brand roles and
 * the status roles), each with the class that carries its value.
 */
export const COLOR_TOKENS = Object.freeze([
  { token: 'primary.500', tone: 'primary' },
  { token: 'secondary.500', tone: 'secondary' },
  { token: 'accent.500', tone: 'accent' },
  { token: 'status.success', tone: 'success' },
  { token: 'status.warning', tone: 'warning' },
  { token: 'status.danger', tone: 'danger' },
  { token: 'status.running', tone: 'running' },
  { token: 'status.working', tone: 'working' },
]);

/** The tone class suffix of a colour token ('neutral' for none, or for one the page has no colour for). */
export function toneOf(token) {
  return COLOR_TOKENS.find((entry) => entry.token === token)?.tone || 'neutral';
}

/** The window's own icons that the Skills Studio set does not have. */
export const AX_ICONS = Object.freeze({
  mark: svg(AGENT_ICON_PATHS.bot),
  teams: svg('<circle cx="9" cy="9" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="17" cy="10" r="2.3"/><path d="M16 14.6a4.5 4.5 0 0 1 4.5 4.4"/>'),
  runs: svg('<circle cx="12" cy="12" r="8.5"/><path d="M10 8.5l5.5 3.5-5.5 3.5z"/>', 14),
  play: svg('<path d="M8 5.5l10 6.5-10 6.5z"/>', 14),
  copy: svg('<rect x="8" y="8" width="11" height="12" rx="2"/><path d="M5 16V6a2 2 0 0 1 2-2h8"/>', 14),
  global: svg(AGENT_ICON_PATHS.globe, 14),
  pin: svg('<path d="M12 21s6-5.6 6-10.5a6 6 0 0 0-12 0C6 15.4 12 21 12 21z"/><circle cx="12" cy="10.5" r="2"/>', 14),
  cards: svg('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>', 14),
  list: svg('<path d="M8 6h12M8 12h12M8 18h12M4 6h.5M4 12h.5M4 18h.5"/>', 14),
  browser: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M6.5 7h.5M9 7h.5"/>', 14),
  computer: svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>', 14),
  server: svg('<rect x="4" y="4" width="16" height="6" rx="1.5"/><rect x="4" y="14" width="16" height="6" rx="1.5"/><path d="M8 7h.5M8 17h.5"/>', 14),
  branch: svg('<circle cx="7" cy="6" r="2"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="9" r="2"/><path d="M7 8v8M17 11c0 3-4 3-8 4"/>', 14),
  send: svg('<path d="M4 12l16-7-6 16-3-6.5z"/>', 14),
  wider: svg('<path d="M12 19V5M6 11l6-6 6 6"/>', 14),
});
