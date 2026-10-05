// ═══════════════════════════════════════════
// SETTINGS — markup kit
// ═══════════════════════════════════════════
//
// The page / section pattern every Settings builder uses:
//
//   page  → title + one-line purpose
//   card  → title, one-line purpose, status, controls (drawn as a grouped list: title above, rows in a box)
//   advanced() → the one "Advanced options" disclosure a card may hold
//   field / toggleField / help → a control with its label and one-line help
//
// Every string comes from i18n. `te()` is the default in a template: it escapes
// the translated text for HTML text and attribute values. Control copy lives at
// settings.redesign.control.<inventory id>.{label,help}; L() and H() read it.
//
// Contract kept from the old markup, because the wiring depends on it:
//   - a collapsible card is `.iface-section[data-collapsible]` and is closed
//     while it has the class `collapsed`; its body is `.cc-section-body`;
//   - a click on the card outside its body toggles it (delegated in ui-settings.js).
// Every top-level card (a section of a page) is an accordion, `.stg-acc`: its header
// is the button and holds the title, the purpose, the status and the chevron. The
// shell decides which ones start open (applyStoredSections in settings-shell.js).

import { t } from '../i18n.js';
import { pageOfPane } from './settings-ia.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escape for HTML text and attribute values. */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Translated, not escaped: for textContent, toasts and other non-HTML text. */
export const tx = (key, params) => t(key, params);
/** Translated, escaped. Use this in templates. */
export const te = (key, params) => esc(t(key, params));
/**
 * Translated and escaped, then `{name}` placeholders replaced with raw HTML
 * (a <code>, a link, a <strong>): th('…key', { cmd: '<code>wsl</code>' }).
 */
export function th(key, html = {}) {
  return esc(t(key)).replace(/\{(\w+)\}/g, (m, name) => (html[name] != null ? html[name] : m));
}

const controlKey = (invId) => `settings.redesign.control.${String(invId).toLowerCase()}`;
/** A control's label / one-line help, by inventory id (GEN001 …), escaped. */
export const L = (invId, params) => te(`${controlKey(invId)}.label`, params);
export const H = (invId, params) => te(`${controlKey(invId)}.help`, params);
/** Marks the element that is (or wraps) an inventory control. Used by the parity audit and by tests. */
export const inv = (invId) => `data-stg-id="${invId}"`;

export const CHEVRON = '<svg class="cc-section-chevron" viewBox="0 0 24 24" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>';

/** Page heading: title and one-line purpose. `key` is the page's slug in settings-ia.js. */
export function pageHead(key) {
  return `
    <header class="stg-page-head">
      <h2 class="stg-page-title" tabindex="-1">${te(`settings.redesign.page.${key}.title`)}</h2>
      <p class="stg-page-purpose">${te(`settings.redesign.page.${key}.purpose`)}</p>
    </header>`;
}

/**
 * A status word with its dot. `state`: ok | warn | err | off | busy.
 * Give it an id when the wiring updates it (set textContent and data-state).
 */
export function pill(text, { state = 'off', id = '', className = '' } = {}) {
  return `<span class="stg-pill${className ? ` ${className}` : ''}"${id ? ` id="${id}"` : ''} data-state="${state}">${text}</span>`;
}

/**
 * A section card.
 *
 * @param {Object} o
 * @param {string} o.id            DOM id (the ids listed in settings-ia.js)
 * @param {string} o.section       i18n slug `<page_key>.<section_key>` → title and purpose
 * @param {string} [o.title]       escaped HTML that replaces the translated title (a product name, an icon + name)
 * @param {string} [o.purpose]     escaped HTML that replaces the translated purpose; '' hides the line
 * @param {string} [o.status]      HTML for the header's status slot (a pill(), a badge the wiring fills)
 * @param {string} o.body          the controls
 * @param {boolean} [o.collapsible]  the card opens and closes (one click); default: a top-level card (h3) does,
 *                                   a card inside a card does not
 * @param {boolean} [o.collapsed]    start closed (a card inside a card; a section's state is the shell's)
 * @param {boolean} [o.advanced]     show the "Advanced" tag in the header
 * @param {string} [o.className]   extra classes on the card
 * @param {string} [o.attrs]       extra attributes on the card
 * @param {string} [o.level]       heading level, 'h3' (default) or 'h4' for a card inside a card
 */
export function card({ id, section, title, purpose, status = '', body = '', collapsible: collapsibleOpt, collapsed = false, advanced = false, className = '', attrs = '', level = 'h3' }) {
  const titleHtml = title != null ? title : te(`settings.redesign.section.${section}.title`);
  const purposeHtml = purpose != null ? purpose : te(`settings.redesign.section.${section}.purpose`);
  const collapsible = collapsibleOpt ?? level === 'h3';
  // A section of a page: a disclosure group whose header holds everything but the body.
  const accordion = collapsible && level === 'h3';
  const classes = ['stg-card', collapsible ? 'iface-section' : 'stg-section', accordion ? 'stg-acc' : '', className, collapsible && collapsed ? 'collapsed' : ''].filter(Boolean).join(' ');
  const tag = advanced ? `<span class="stg-card-tag">${te('settings.redesign.common.advancedTag')}</span>` : '';
  const heading = `<${level} class="stg-card-title" id="${id}-title">${titleHtml}</${level}>`;
  const expanded = `role="button" tabindex="0" aria-expanded="${collapsed ? 'false' : 'true'}" aria-controls="${id}-body"`;
  let head;
  if (accordion) {
    head = `<div class="gfx-group-title stg-card-head" ${expanded} aria-labelledby="${id}-title"${purposeHtml ? ` aria-describedby="${id}-purpose"` : ''}>
        <span class="stg-card-heading">${heading}${purposeHtml ? `<span class="stg-card-purpose" id="${id}-purpose">${purposeHtml}</span>` : ''}</span>
        ${tag}<span class="stg-card-status">${status}</span>${CHEVRON}
      </div>`;
  } else if (collapsible) {
    head = `<div class="gfx-group-title stg-card-head" ${expanded}>
        <span class="stg-card-heading">${CHEVRON}${heading}${tag}</span>
        <span class="stg-card-status">${status}</span>
      </div>`;
  } else {
    head = `<div class="stg-card-head">
        <span class="stg-card-heading">${heading}${tag}</span>
        <span class="stg-card-status">${status}</span>
      </div>`;
  }
  return `
    <section class="${classes}" id="${id}" data-stg-section="${section || id}"${collapsible ? ' data-collapsible' : ''} aria-labelledby="${id}-title"${attrs ? ` ${attrs}` : ''}>
      ${head}
      ${purposeHtml && !accordion ? `<p class="stg-card-purpose">${purposeHtml}</p>` : ''}
      <div class="stg-card-body${collapsible ? ' cc-section-body' : ''}" id="${id}-body">${body}</div>
    </section>`;
}

/** The one "Advanced options" disclosure inside a card. Native <details>: keyboard and screen readers for free. */
export function advanced(body, { id = '', labelKey = 'settings.redesign.common.advanced', open = false, attrs = '' } = {}) {
  return `
    <details class="stg-advanced"${id ? ` id="${id}"` : ''}${open ? ' open' : ''}${attrs ? ` ${attrs}` : ''}>
      <summary>${CHEVRON}<span>${te(labelKey)}</span></summary>
      <div class="stg-advanced-body">${body}</div>
    </details>`;
}

/** One-line help for a control. Pair it with aria-describedby="<forId>-help" on the control. */
export function help(invId, { forId = '', params } = {}) {
  return `<div class="stg-help"${forId ? ` id="${forId}-help"` : ''}>${H(invId, params)}</div>`;
}

/**
 * Label + control + help, stacked. `control` is the control's HTML; give it
 * id="<forId>" and aria-describedby="<forId>-help" so the label and the help are bound to it.
 *
 * @param {string} invId            inventory id → label and help
 * @param {string} control          HTML of the control (and anything beside it)
 * @param {Object} [o]
 * @param {string} [o.forId]        the control's id (<label for>)
 * @param {string} [o.label]        escaped HTML replacing the translated label
 * @param {string} [o.helpHtml]     escaped HTML replacing the translated help; '' hides it
 * @param {string} [o.className]
 * @param {string} [o.attrs]
 */
export function field(invId, control, { forId = '', label, helpHtml, className = '', attrs = '' } = {}) {
  const helpText = helpHtml != null ? helpHtml : H(invId);
  return `
    <div class="stg-field stg-inline-field${className ? ` ${className}` : ''}" ${inv(invId)}${attrs ? ` ${attrs}` : ''}>
      <label${forId ? ` for="${forId}"` : ''}>${label != null ? label : L(invId)}</label>
      ${control}
      ${helpText ? `<div class="stg-help"${forId ? ` id="${forId}-help"` : ''}>${helpText}</div>` : ''}
    </div>`;
}

/**
 * A switch with its label and help on one row: text on the left, control on the right.
 * `control` is the switch itself (a checkbox, a .cc-toggle button, a .recall-toggle label).
 * For a checkbox pass its id as forId so the row's label is bound to it; for a button
 * add aria-labelledby="<forId>-label" on it.
 */
export function toggleField(invId, control, { forId = '', label, helpHtml, className = '', attrs = '' } = {}) {
  const helpText = helpHtml != null ? helpHtml : H(invId);
  return `
    <div class="stg-toggle-field${className ? ` ${className}` : ''}" ${inv(invId)}${attrs ? ` ${attrs}` : ''}>
      <div class="stg-toggle-text">
        <label class="stg-toggle-label"${forId ? ` for="${forId}" id="${forId}-label"` : ''}>${label != null ? label : L(invId)}</label>
        ${helpText ? `<div class="stg-help"${forId ? ` id="${forId}-help"` : ''}>${helpText}</div>` : ''}
      </div>
      <div class="stg-toggle-control">${control}</div>
    </div>`;
}

/**
 * A checkbox drawn as a switch. The id stays on the <input>, so `change` handlers and `.checked` work as before.
 * Inside toggleField(invId, …, { forId: id }) the row's label and help are bound to it.
 */
export function switchInput(id, { checked = false, className = '', attrs = '', described = true } = {}) {
  return `<label class="recall-toggle"><input type="checkbox" id="${id}"${className ? ` class="${className}"` : ''}${checked ? ' checked' : ''}${described ? ` aria-describedby="${id}-help"` : ''}${attrs ? ` ${attrs}` : ''}><span class="recall-toggle-track"></span></label>`;
}

/**
 * The app's custom dropdown: a hidden <input id> that holds the value (and fires `change`) plus the menu.
 * `options` is [{ value, label }] with labels already escaped. The wiring finds it by data-for="<id>".
 * `disabled` starts it switched off the way the wiring does (hidden input, class and trigger).
 */
export function dropdown(id, options, { value = '', classes = 'stg-dropdown', label = '', attrs = '', disabled = false } = {}) {
  const current = options.find((o) => String(o.value) === String(value)) || options[0] || { value: '', label: '' };
  return `<input type="hidden" id="${id}" value="${esc(current.value)}"${disabled ? ' disabled' : ''}>
      <div class="cc-dropdown ${classes}${disabled ? ' disabled' : ''}" data-for="${id}" role="group"${label ? ` aria-label="${label}"` : ''}${attrs ? ` ${attrs}` : ''}>
        <button class="cc-dropdown-trigger" type="button" aria-haspopup="listbox"${disabled ? ' disabled' : ''}>
          <span class="cc-dropdown-value">${current.label}</span>
          <svg class="cc-dropdown-arrow" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <div class="cc-dropdown-menu">${options.map((o) => `<div class="cc-dropdown-item${String(o.value) === String(current.value) ? ' active' : ''}" data-value="${esc(o.value)}">${o.label}</div>`).join('')}</div>
      </div>`;
}

/** A subheading inside a card (a product name, a group of related rows). */
export function subhead(text, { id = '' } = {}) {
  return `<h4 class="stg-subhead"${id ? ` id="${id}"` : ''}>${text}</h4>`;
}

// ── DOM helpers shared by the shell and the panes that wire themselves ──

/** The element one builder owns (what used to be a tab body). */
export const paneOf = (overlay, paneId) => overlay.querySelector(`.stg-pane[data-stg-pane="${paneId}"]`);

/** Is the page that hosts this pane the one on screen? Polling panes ask before they fetch. */
export function paneActive(overlay, paneId) {
  return !!paneOf(overlay, paneId)?.closest('.settings-tab-body')?.classList.contains('active');
}

/**
 * The status dot on a nav item. Several panes can share a page (WhatsApp and
 * Discord on Messages), so each reports its own status and the page shows
 * "connected" when any of them is. The word is also set for screen readers.
 * @param {'connected'|'disconnected'|''} status
 */
export function setNavStatus(overlay, paneId, status) {
  const page = pageOfPane(paneId);
  const nav = page && overlay.querySelector(`.settings-nav-item[data-tab="${page.id}"]`);
  if (!nav) return;
  const sources = nav._stgStatus || (nav._stgStatus = {});
  if (status) sources[paneId] = status; else delete sources[paneId];
  const values = Object.values(sources);
  const next = values.includes('connected') ? 'connected' : values.includes('disconnected') ? 'disconnected' : '';
  if (next) nav.dataset.status = next; else delete nav.dataset.status;
  const word = nav.querySelector('.stg-nav-status-text');
  if (word) word.textContent = next ? ` (${t(next === 'connected' ? 'settings.redesign.common.connected' : 'settings.redesign.common.off')})` : '';
}
