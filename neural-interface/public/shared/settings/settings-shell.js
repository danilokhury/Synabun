// ═══════════════════════════════════════════
// SETTINGS — shell behaviours
// ═══════════════════════════════════════════
//
// What every page gets for free once the markup follows settings-kit.js:
//   - a deep link's target kept in view while the page is still loading (followSettingsTarget);
//   - room under the scroll area for a pane's save bar;
//   - keyboard support and aria-expanded on collapsible cards;
//   - every section an accordion that remembers whether the user left it open (applyStoredSections);
//   - aria-pressed on the custom .cc-toggle switches;
//   - the page picker that replaces the nav rail on a narrow panel;
//   - the search field of the sidebar: results list, keyboard, ARIA (wireSettingsSearch).
// Nothing here knows about a specific page.

import { sectionOpensByDefault } from './settings-ia.js';
import { searchSettings, runtimeSearchEntries, highlightParts, SEARCH_LIMIT, SEARCH_QUERY_MAX } from './settings-search.js';
import { tx, esc } from './settings-kit.js';

const TOGGLE_KEYS = new Set(['Enter', ' ']);
const KEY_ROLES = '[role="button"], [role="radio"], [role="switch"], [role="checkbox"], [role="tab"], [role="option"]';
const NATIVE_CONTROLS = 'button, a[href], input, select, textarea, summary';
const STATE_MIRRORS = '[data-stg-pressed], [data-stg-checked], [data-stg-selected]';

// ── Sections: which ones the user left open ──
// One localStorage entry, { "<section id>": true | false }. A section the user never touched
// opens only if it is the first of its page. A deep link opens its target without writing here.
export const SECTIONS_OPEN_KEY = 'stg-sections-open';

function readOpenSections() {
  try {
    const stored = JSON.parse(localStorage.getItem(SECTIONS_OPEN_KEY) || 'null');
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  } catch { return {}; }
}

/** Open or close every section of the panel the way the user left it (call once, right after the panel is built). */
export function applyStoredSections(overlay) {
  const stored = readOpenSections();
  overlay.querySelectorAll('.stg-acc[data-collapsible]').forEach((section) => {
    const open = typeof stored[section.id] === 'boolean' ? stored[section.id] : sectionOpensByDefault(section.id);
    section.classList.toggle('collapsed', !open);
  });
}

/** The user opened or closed a section: remember it. Cards inside a section are not remembered. */
export function storeSectionState(section) {
  if (!section?.id || !section.matches?.('.stg-acc[data-collapsible]')) return;
  const stored = readOpenSections();
  stored[section.id] = !section.classList.contains('collapsed');
  try { localStorage.setItem(SECTIONS_OPEN_KEY, JSON.stringify(stored)); } catch { /* private mode, quota: the choice lasts this session */ }
}

/**
 * Open every closed ancestor of `el` (collapsible cards, <details>, a project's panel, a block behind its own tab),
 * then `el` itself. Nothing is remembered: the sections the user left open or closed stay as stored.
 */
export function revealSettingsTarget(overlay, el) {
  for (let node = el; node && node !== overlay; node = node.parentElement) {
    if (node.matches?.('[data-collapsible].collapsed')) node.classList.remove('collapsed');
    if (node.tagName === 'DETAILS' && !node.open) node.open = true;
    // A project's panel shows its body only while it is open: the panel itself, or the panel around the target.
    if (node.matches?.('.cc-panel:not(.open)')) node.classList.add('open');
    // A block behind a tab of its own names that tab: press it.
    if (node.dataset?.stgReveal && getComputedStyle(node).display === 'none') overlay.querySelector(node.dataset.stgReveal)?.click();
  }
}

const FOLLOW_MS = 10000;   // how long a deep link keeps its target in place while the page loads
const SMOOTH_MS = 700;     // a smooth scroll is still travelling for about this long
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Call `fn` when the user takes over: scrolls (wheel, touch), presses a pointer or types inside the panel, or
 * presses a key. Whatever was moving the view for them (a deep link kept in place, a result landed on again)
 * must let go. A key still held from the shortcut that opened Settings repeats; that is not the user taking over.
 * @returns {() => void} stop listening
 */
export function onSettingsTakeover(overlay, fn) {
  const onKey = (e) => { if (!e.repeat) fn(e); };
  for (const type of ['wheel', 'touchstart', 'pointerdown', 'input']) overlay.addEventListener(type, fn, { passive: true });
  document.addEventListener('keydown', onKey, true);
  return () => {
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'input']) overlay.removeEventListener(type, fn);
    document.removeEventListener('keydown', onKey, true);
  };
}

/**
 * Scroll `el` into view and keep it there while its page is still loading. Panes fill their lists after
 * the first scroll (sessions, logs, history), which pushes the target away; every time the page changes
 * size the target is put back. It ends when the time is up, when the user scrolls, clicks or types, when
 * another page is shown or when Settings closes. One follow per panel: a new one replaces the last.
 *
 * @param {HTMLElement} overlay   the settings panel
 * @param {HTMLElement} el        the section (or pane) to land on
 * @param {Object} [o]
 * @param {'start'|'center'} [o.block]  where to put it; a target taller than the viewport always goes to the top
 * @param {number} [o.delay]      ms before the first scroll (the page was just switched)
 * @param {number} [o.ms]         how long to keep following
 * @returns {() => void} stop
 */
export function followSettingsTarget(overlay, el, { block = 'start', delay = 80, ms = FOLLOW_MS } = {}) {
  overlay._stgFollowStop?.();
  const content = overlay.querySelector('.settings-content');
  if (!content || !el) return () => {};

  let stopped = false;
  let settleAt = 0;
  let pending = 0;
  const timers = new Set();
  const later = (fn, wait) => { const id = setTimeout(() => { timers.delete(id); fn(); }, wait); timers.add(id); return id; };

  const align = (behavior) => {
    if (stopped || !el.isConnected) return;
    const fits = el.getBoundingClientRect().height <= content.clientHeight;
    el.scrollIntoView({ block: fits ? block : 'start', behavior });
  };
  // The page grew or shrank: while the first scroll is still travelling, wait for it to end, then put the target back at once.
  const realign = () => {
    if (stopped || pending) return;
    const wait = Math.max(0, settleAt - performance.now());
    if (!wait) { align('auto'); return; }
    pending = later(() => { pending = 0; align('auto'); }, wait);
  };

  const page = el.closest('.settings-tab-body') || content;
  const sizes = typeof ResizeObserver === 'function' ? new ResizeObserver(realign) : null;

  let offTakeover = () => {};
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const id of timers) clearTimeout(id);
    timers.clear();
    sizes?.disconnect();
    offTakeover();
    overlay.removeEventListener('stg-page-change', stop);
    overlay.removeEventListener('settings-close', stop);
    if (overlay._stgFollowStop === stop) overlay._stgFollowStop = null;
  };
  overlay._stgFollowStop = stop;

  // The user took over: leave the scroll position alone.
  offTakeover = onSettingsTakeover(overlay, stop);
  overlay.addEventListener('stg-page-change', stop);
  overlay.addEventListener('settings-close', stop);

  later(() => {
    const smooth = !reducedMotion();
    settleAt = performance.now() + (smooth ? SMOOTH_MS : 0);
    align(smooth ? 'smooth' : 'auto');
    // Observe after the first scroll: the observer's initial report must not cut it short.
    sizes?.observe(page);
    if (page !== el) sizes?.observe(el);
    // One check when the smooth scroll has landed, in case the page moved under it without changing size again.
    if (smooth) later(() => align('auto'), SMOOTH_MS + 20);
  }, delay);
  later(stop, delay + ms);
  return stop;
}

/**
 * @param {HTMLElement} overlay   the settings panel
 * @param {Object} o
 * @param {(pageId: string) => void} o.activate   show a page (the shell's activateSettingsTab)
 */
export function wireSettingsShell(overlay, { activate }) {
  const content = overlay.querySelector('.settings-content');

  // ── Collapsible cards: Enter / Space on the header, and aria-expanded kept true to the class ──
  const syncExpanded = (section) => {
    const head = section.querySelector(':scope > [aria-expanded]');
    if (head) head.setAttribute('aria-expanded', section.classList.contains('collapsed') ? 'false' : 'true');
  };
  // Enter / Space on anything that plays a button, a radio or a switch without being one natively.
  overlay.addEventListener('keydown', (e) => {
    const el = e.target;
    if (!TOGGLE_KEYS.has(e.key) || !el.matches?.(KEY_ROLES) || el.matches(NATIVE_CONTROLS)) return;
    e.preventDefault();
    el.click(); // the same path as a mouse click, so every listener on the element runs
  });

  // ── Custom switches say their state ──
  const syncToggle = (btn) => btn.setAttribute('aria-pressed', btn.classList.contains('on') ? 'true' : 'false');

  // A control whose state is a class says it too: data-stg-pressed="active" mirrors that class into
  // aria-pressed, data-stg-checked into aria-checked, data-stg-selected into aria-selected (segmented buttons,
  // choice cards, tabs).
  const syncState = (el) => {
    if (el.dataset.stgPressed) el.setAttribute('aria-pressed', el.classList.contains(el.dataset.stgPressed) ? 'true' : 'false');
    if (el.dataset.stgChecked) el.setAttribute('aria-checked', el.classList.contains(el.dataset.stgChecked) ? 'true' : 'false');
    if (el.dataset.stgSelected) el.setAttribute('aria-selected', el.classList.contains(el.dataset.stgSelected) ? 'true' : 'false');
  };

  const syncAll = (root) => {
    root.querySelectorAll?.('[data-collapsible]').forEach(syncExpanded);
    root.querySelectorAll?.('.cc-toggle').forEach(syncToggle);
    root.querySelectorAll?.(STATE_MIRRORS).forEach(syncState);
    if (root.matches?.(STATE_MIRRORS)) syncState(root);
    if (root.matches?.('.cc-toggle')) syncToggle(root);
  };
  syncAll(overlay);

  // ── Cards and switches added or changed later keep their aria state ──
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      const el = r.target;
      if (r.type === 'attributes') {
        if (el.hasAttribute('data-collapsible')) syncExpanded(el);
        if (el.classList.contains('cc-toggle')) syncToggle(el);
        if (el.matches(STATE_MIRRORS)) syncState(el);
        continue;
      }
      for (const node of r.addedNodes) if (node.nodeType === 1) syncAll(node);
    }
  });
  observer.observe(content, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  overlay.addEventListener('settings-close', () => observer.disconnect());

  // ── A pane's save bar sits over the bottom of the scroll area: the scroller is told how tall it is,
  //    so a control that takes focus (or a deep link) never lands under the bar ──
  const syncBarRoom = () => {
    const bar = content.querySelector(':scope > .settings-tab-body.active .stg-pane-actions');
    const room = bar ? Math.ceil(bar.getBoundingClientRect().height) : 0;
    content.style.scrollPaddingBottom = room ? `${room + 12}px` : '';
  };
  const barSizes = typeof ResizeObserver === 'function' ? new ResizeObserver(syncBarRoom) : null;
  content.querySelectorAll('.stg-pane-actions').forEach((bar) => barSizes?.observe(bar));
  overlay.addEventListener('stg-page-change', syncBarRoom);
  overlay.addEventListener('settings-close', () => barSizes?.disconnect());
  syncBarRoom();

  // ── Page picker (the nav rail's stand-in on a narrow panel) ──
  const picker = overlay.querySelector('#stg-page-select');
  if (picker) picker.addEventListener('change', () => {
    // Click the nav item so listeners bound to it (lazy loads) run exactly as they do from the rail.
    const nav = overlay.querySelector(`.settings-nav-item[data-tab="${CSS.escape(picker.value)}"]`);
    if (nav) nav.click(); else activate(picker.value);
  });
}

// ── Search ─────────────────────────────────────────────────────────────────

const ROW_TITLE_MAX = 80;
const TEXT_SKIP = 'select, textarea, input, button, svg, script, style, code, .stg-sr, .stg-help, .settings-hint, small';

/** The words of a label: its own text, never a value, an option list or the help under it. */
function labelText(el) {
  let text = '';
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) text += child.nodeValue;
      else if (child.nodeType === 1 && !child.matches(TEXT_SKIP)) walk(child);
    }
  };
  walk(el);
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The rows the panel holds right now that the index does not list: named items a pane loaded (a project, a
 * provider, a profile) and the labelled rows of panes that draw themselves. Names and labels only: a source
 * names label elements, their text nodes are read, and a value, a password field or a list of the user's own
 * content (`off`) is never looked at.
 *
 * @param {HTMLElement} overlay
 * @param {Array<{ selector: string, row?: string, help?: string, caption?: boolean }>} sources
 *        `selector` the label elements; `row` the element to land on (closest); `help` its help text inside the row;
 *        `caption` reads a button's words (or its aria-label)
 * @param {string} off   a selector of containers that are never read
 */
export function collectSearchRows(overlay, sources = [], off = '') {
  const content = overlay.querySelector('.settings-content');
  const rows = [];
  if (!content) return rows;
  for (const source of sources) {
    let found;
    try { found = content.querySelectorAll(source.selector); } catch { continue; }
    for (const el of found) {
      if (off && el.closest(off)) continue;
      // An inventory control is in the index already, with its own copy.
      if (!source.named && el.closest('[data-stg-id]')) continue;
      const title = source.caption ? (labelText(el) || el.getAttribute('aria-label') || '').trim() : labelText(el);
      if (!title || title.length > ROW_TITLE_MAX) continue;
      const page = el.closest('.settings-content > .settings-tab-body')?.dataset.tab;
      if (!page) continue;
      const row = (source.row && el.closest(source.row)) || el;
      const helpEl = source.help ? row.querySelector(source.help) : null;
      rows.push({ title, page, section: el.closest('.stg-acc[data-collapsible]')?.id || null, help: helpEl ? helpEl.textContent.replace(/\s+/g, ' ').trim().slice(0, 240) : '', ref: row });
    }
  }
  return rows;
}

const marked = (text, ranges) => highlightParts(text, ranges).map((part) => (part.hit ? `<mark>${esc(part.text)}</mark>` : esc(part.text))).join('');

// What holds a row and has a name of its own: the labelled row a button sits in, a card inside a section (an
// assistant, a greeting), a project, a provider.
const HOLDERS = [
  ['.stg-field, .settings-field', ':scope > label'],
  ['.stg-toggle-field', '.stg-toggle-label'],
  ['.stg-card:not(.stg-acc)', ':scope > .stg-card-head .stg-card-title'],
  ['.cc-panel', '.cc-panel-title'],
  ['.stg-provider-card', '.stg-provider-name'],
];

/** The names of what holds `el`, nearest first, up to its section. */
function holderNames(el) {
  const out = [];
  for (let node = el; node && !node.matches('.stg-acc, .settings-tab-body'); node = node.parentElement) {
    for (const [holder, label] of HOLDERS) {
      const name = node.matches(holder) ? node.querySelector(label) : null;
      const text = name ? labelText(name) : '';
      if (text && text.length <= ROW_TITLE_MAX && !out.includes(text)) out.push(text);
    }
  }
  return out;
}

/**
 * Results that read the same (the same name in the same place): those that land on one row are one result, and
 * each of the others is given what tells it apart (`hit.context`: the assistant its button belongs to, the label
 * of its row). Returns the hits to list.
 */
function tellApart(hits, locate) {
  if (typeof locate !== 'function') return hits;
  const groups = new Map();
  for (const hit of hits) {
    const key = `${hit.entry.title}\n${hit.entry.path}`;
    if (groups.has(key)) groups.get(key).push(hit); else groups.set(key, [hit]);
  }
  const dropped = new Set();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const twins = [];
    const rows = new Set();
    for (const hit of group) {
      let el = null;
      try { el = locate(hit.entry); } catch { /* a row its pane has since removed */ }
      if (el && rows.has(el)) { dropped.add(hit); continue; }
      if (el) rows.add(el);
      twins.push({ hit, names: el ? holderNames(el).filter((name) => name !== hit.entry.title) : [] });
    }
    for (const twin of twins) {
      const own = twin.names.find((name) => twins.every((other) => other === twin || !other.names.includes(name)));
      if (own) twin.hit.context = own;
    }
  }
  return dropped.size ? hits.filter((hit) => !dropped.has(hit)) : hits;
}

/**
 * The search field at the top of the sidebar. While it holds a query the page list gives way to the results;
 * choosing one lands on it through the deep-link machinery (`land`) and the query stays, so the next hit is
 * one arrow key away. A combobox with a listbox: focus stays in the field, the active row is named by
 * aria-activedescendant, the number of results is announced politely.
 *
 * @param {HTMLElement} overlay   the settings panel
 * @param {Object} o
 * @param {Object} o.index        buildSettingsSearchIndex()
 * @param {(entry: Object, o: { focus: boolean }) => void} o.land   show the entry (page, section, row)
 * @param {(entry: Object) => Element|null} [o.locate]   the row an entry lands on, as the panel holds it now
 *        (results that read the same are told apart by it)
 * @param {() => Promise<Object|null>} [o.english]   the index with the English names in it, when they were not at
 *        hand as the panel opened: asked for once, the first time the field takes focus, and searched from then on
 * @param {Array} [o.sources]     collectSearchRows() sources
 * @param {string} [o.off]        containers collectSearchRows() never reads
 */
export function wireSettingsSearch(overlay, { index, land, locate, english, sources = [], off = '' }) {
  const side = overlay.querySelector('.stg-sidebar');
  const input = overlay.querySelector('#stg-search-input');
  const clear = overlay.querySelector('#stg-search-clear');
  const box = overlay.querySelector('#stg-search-results');
  const list = overlay.querySelector('#stg-search-list');
  const note = overlay.querySelector('#stg-search-note');
  const status = overlay.querySelector('#stg-search-status');
  const content = overlay.querySelector('.settings-content');
  if (!side || !input || !list) return;
  input.maxLength = SEARCH_QUERY_MAX;

  let results = [];
  let active = -1;
  let current = null;   // the id of the entry chosen last
  let rows = null;      // runtime entries, collected when a query needs them and dropped when the panel changes
  let announce = 0;

  // The icon tile of each page, as the nav draws it.
  const tiles = new Map();
  overlay.querySelectorAll('.settings-nav-item[data-tab]').forEach((nav) => {
    const icon = nav.querySelector('.stg-nav-icon');
    if (!icon) return;
    const tile = getComputedStyle(nav).getPropertyValue('--stg-tile').trim();
    tiles.set(nav.dataset.tab, `<span class="stg-nav-icon"${tile ? ` style="--stg-tile:${esc(tile)}"` : ''} aria-hidden="true">${icon.innerHTML}</span>`);
  });

  // Panes fill themselves after the panel opens: what they add is picked up by the next query.
  const changes = typeof MutationObserver === 'function' ? new MutationObserver(() => { rows = null; }) : null;
  changes?.observe(content, { subtree: true, childList: true });

  const say = (text) => {
    clearTimeout(announce);
    announce = setTimeout(() => { if (status) status.textContent = text; }, 250); // one announcement per pause in typing
  };

  // The combobox says what is on screen: expanded while the list can be seen, and an active option only then. On a
  // narrow panel the list steps aside once a result is chosen (stg-search-dismissed), so both follow the layout too.
  const syncExpanded = () => {
    const shown = results.length > 0 && list.getClientRects().length > 0;
    const row = shown && active >= 0 ? list.children[active] : null;
    input.setAttribute('aria-expanded', shown ? 'true' : 'false');
    if (row) input.setAttribute('aria-activedescendant', row.id); else input.removeAttribute('aria-activedescendant');
  };

  const setActive = (i, { scroll = true } = {}) => {
    active = results.length ? Math.max(0, Math.min(results.length - 1, i)) : -1;
    list.querySelectorAll('.stg-search-result').forEach((row, n) => {
      row.classList.toggle('active', n === active);
      row.setAttribute('aria-selected', n === active ? 'true' : 'false');
    });
    const row = active >= 0 ? list.children[active] : null;
    syncExpanded();
    if (row && scroll) row.scrollIntoView({ block: 'nearest' });
  };

  const render = () => {
    const query = input.value;
    const searching = query.trim() !== '';
    side.classList.toggle('stg-searching', searching);
    side.classList.remove('stg-search-dismissed');
    clear.hidden = query === '';
    box.hidden = !searching;
    if (!searching) {
      results = [];
      list.innerHTML = '';
      note.hidden = true;
      setActive(-1);
      say('');
      return;
    }
    if (!rows) rows = runtimeSearchEntries(index, collectSearchRows(overlay, sources, off));
    const found = searchSettings(index, query, { limit: SEARCH_LIMIT, extra: rows });
    results = tellApart(found.results, locate);
    const total = found.total - (found.results.length - results.length);
    list.innerHTML = results.map((r, i) => {
      const e = r.entry;
      // Under the name: what tells it apart from a result that reads the same, its English name when that is what
      // the query found, where it is, and the old name that matched. The first two come first: the line is cut
      // short by the sidebar, and they are why the row is here. The tooltip holds both lines whole.
      const was = r.alias ? tx('settings.redesign.search.formerly', { name: r.alias }) : '';
      const second = [ // [text, html]
        [r.context || '', esc(r.context || '')],
        [r.english || '', r.english ? `<span lang="en">${marked(r.english, r.ranges.english)}</span>` : ''],
        [e.path, marked(e.path, r.ranges.path)],
        [was, esc(was)],
      ].filter(([text]) => text);
      const tip = [e.title, second.map(([text]) => text).join(' · ')].filter(Boolean).join('\n');
      return `<div class="stg-search-result${e.id === current ? ' current' : ''}" role="option" id="stg-search-opt-${i}" data-index="${i}" aria-selected="false"${e.id === current ? ' aria-current="true"' : ''} title="${esc(tip)}">
        ${tiles.get(e.page) || ''}
        <span class="stg-search-text"><span class="stg-search-title">${marked(e.title, r.ranges.title)}</span>${second.length ? `<span class="stg-search-path">${second.map(([, html]) => html).join(' · ')}</span>` : ''}</span>
      </div>`;
    }).join('');
    list.hidden = !results.length;
    list.scrollTop = 0;
    const count = tx(total === 1 ? 'settings.redesign.search.count.one' : 'settings.redesign.search.count.other', { count: total });
    const text = !results.length ? tx('settings.redesign.search.none', { query: query.trim().slice(0, SEARCH_QUERY_MAX) })
      : total > results.length ? tx('settings.redesign.search.capped', { shown: results.length, count: total }) : '';
    note.textContent = text;
    note.hidden = !text;
    setActive(results.length ? 0 : -1, { scroll: false });
    say(text || count);
  };

  const choose = (i, { focus }) => {
    const hit = results[i];
    if (!hit) return;
    current = hit.entry.id;
    list.querySelectorAll('.stg-search-result').forEach((row, n) => {
      row.classList.toggle('current', n === i);
      if (n === i) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current');
    });
    setActive(i);
    // On a narrow panel the list sits over the page: it steps aside until the field is used again.
    side.classList.add('stg-search-dismissed');
    syncExpanded();
    land(hit.entry, { focus });
  };

  const reset = () => { input.value = ''; current = null; render(); };
  const reopen = () => { side.classList.remove('stg-search-dismissed'); syncExpanded(); };

  // The layout changed (the panel crossed the narrow breakpoint, or was resized): the list may have come or gone.
  const layout = typeof ResizeObserver === 'function' ? new ResizeObserver(syncExpanded) : null;
  layout?.observe(side);
  if (box) layout?.observe(box);

  // The English names were not at hand when the panel opened: they are asked for once, when the field is first
  // used, and searched as soon as they arrive. Until then the active locale's own words are searched.
  input.addEventListener('focus', () => {
    if (typeof english !== 'function') return;
    const load = english;
    english = null;
    Promise.resolve().then(load).then((next) => {
      if (!next || !overlay.isConnected) return;
      index = next;
      rows = null;
      if (input.value.trim() !== '' && current === null) render(); // nothing chosen yet: the list is brought up to date
    }).catch(() => { /* no English bundle: the active locale is searched alone */ });
  });

  input.addEventListener('input', render);
  input.addEventListener('pointerdown', reopen);
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!results.length) return;
      e.preventDefault();
      reopen();
      setActive(active + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter') {
      if (active < 0) return;
      e.preventDefault();
      choose(active, { focus: true });
    }
  });
  // Escape while the field holds a query empties it and brings the page list back, wherever in the panel the
  // keyboard is (after Enter it is on the setting that was landed on): focus stays where it is and Settings stays
  // open. Only Escape on an empty field closes Settings. An editor inside the panel that takes Escape for itself
  // stops it before it gets here.
  const emptyQuery = () => { if (input.value === '') return false; reset(); return true; };
  overlay.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return;
    if (!emptyQuery()) return; // the field was empty already: this Escape closes Settings
    e.preventDefault();
    e.stopPropagation();
  });
  // The same for an Escape that never passes through the panel (the keyboard is on the page behind it): the handler
  // that closes Settings asks first.
  overlay._stgSearchEscape = emptyQuery;
  clear.addEventListener('click', () => { reset(); input.focus(); });
  // The field keeps the keyboard: a click on a row lands on it without taking focus away.
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.stg-search-result');
    if (row) choose(Number(row.dataset.index), { focus: false });
  });

  // Cmd+F or Ctrl+F while Settings is open, on every platform: focus the field and select what it holds. The
  // platform is not asked: a browser may report another one than the keyboard in front of it (a profile that says
  // Win32 on a Mac), and a find key that does nothing lets the next letters reach the app's one-key shortcuts.
  // Another text field, an editor or a terminal that has the keyboard outside this panel keeps its own find.
  const onFind = (e) => {
    if (e.key !== 'f' && e.key !== 'F') return;
    if (e.altKey || e.shiftKey || e.metaKey === e.ctrlKey) return;
    const at = document.activeElement;
    if (at && !overlay.contains(at) && (at.matches('input, textarea, select') || at.isContentEditable || at.closest('.term-viewport, .xterm'))) return;
    e.preventDefault();
    e.stopPropagation();
    reopen();
    input.focus();
    input.select();
  };
  document.addEventListener('keydown', onFind, true);
  overlay.addEventListener('settings-close', () => {
    document.removeEventListener('keydown', onFind, true);
    changes?.disconnect();
    layout?.disconnect();
    clearTimeout(announce);
    overlay._stgSearchEscape = null;
  });
}
