// ═══════════════════════════════════════════
// SETTINGS — About (the pane)
// ═══════════════════════════════════════════
//
// The last page of Settings: who SynaBun is and what it runs on. A header that is always shown (the app's icon,
// name, version and channel, how it was installed, the package's one-line description, "Check for updates" and
// "Copy info"), then three sections: Links, System, Dependencies, and the license line at the foot.
//
// It asks GET /api/system/about once, when the page is first shown. A server from before that route (404, or not
// JSON) gets the header and the version from /api/health and /api/system/version, and a note that the rest comes
// with a restart. settings-about.js decides what is said; this draws it.
//
// "Check for updates" is the Apps menu's own item (#menu-check-cli-updates, ui-menubar.js): the same check, the
// same toast. Links open in a new window, which the desktop app hands to the default browser.

import * as kit from './settings-kit.js';
import { revealSettingsTarget } from './settings-shell.js';
import { desktopBridge } from '../desktop-bridge.js';
import {
  ABOUT_URL, ABOUT_FILTER_MIN, buildLabel, diagnosticsText, filterDependencies, installLine, isExternalUrl, linkHost, linkLabel,
  npmUrl, osLine, packageLabel, readAboutAnswer, readClientRuntime, versionLine,
} from './settings-about.js';

const UPDATE_MENU_ITEM = 'menu-check-cli-updates';
const EXTERNAL = 'target="_blank" rel="noopener noreferrer"';
const ARROW = '<svg class="stg-about-arrow" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 4.5h6v6M11.5 4.5l-7 7"/></svg>';

export function buildAboutTab() {
  return `
      <div class="stg-pane stg-about" data-stg-pane="about">
        <div class="stg-about-hero" id="stg-about-hero">
          <img class="stg-about-logo" src="/icon-192.png" alt="" width="64" height="64" decoding="async">
          <h3 class="stg-about-name">SynaBun</h3>
          <p class="stg-about-version" id="stg-about-version" aria-live="polite">${kit.te('settings.redesign.about.loading')}</p>
          <p class="stg-about-line" id="stg-about-install" hidden></p>
          <p class="stg-about-line stg-about-desc" id="stg-about-desc" hidden></p>
          <div class="stg-action-row stg-about-actions">
            <button type="button" class="stg-action-btn" id="stg-about-update" ${kit.inv('ABT001')} title="${kit.H('ABT001')}">${kit.L('ABT001')}</button>
            <button type="button" class="stg-action-btn" id="stg-about-copy" ${kit.inv('ABT002')} title="${kit.H('ABT002')}">${kit.L('ABT002')}</button>
          </div>
          <p class="stg-help stg-about-note" id="stg-about-note" role="status" hidden></p>
        </div>
        ${kit.card({
          id: 'stg-sec-about-links', section: 'about.links',
          body: `<ul class="stg-about-links" id="stg-about-links" data-stg-search="off"></ul>`,
        })}
        ${kit.card({
          id: 'stg-sec-about-system', section: 'about.system',
          body: `<dl class="stg-about-facts" id="stg-about-facts" data-stg-search="off"></dl>`,
        })}
        ${kit.card({
          id: 'stg-sec-about-dependencies', section: 'about.dependencies',
          // how many dependencies the lists hold; empty until the server has answered
          status: '<span class="stg-about-count" id="stg-about-deps-count"></span>',
          body: `
          <div class="stg-about-filter" ${kit.inv('ABT003')} hidden>
            <input type="search" class="stg-input stg-about-filter-input" id="stg-about-filter" placeholder="${kit.te('settings.redesign.about.deps.filterPlaceholder')}" aria-label="${kit.L('ABT003')}" aria-describedby="stg-about-filter-help" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search">
            <span class="stg-sr" id="stg-about-filter-help">${kit.H('ABT003')}</span>
          </div>
          <div class="stg-about-deps" id="stg-about-deps" data-stg-search="off"></div>`,
        })}
        <footer class="stg-about-footer" id="stg-about-footer" hidden></footer>
      </div>`;
}

// ── Drawing ──

function linkRow(link) {
  return `<li><a class="stg-about-link" href="${kit.esc(link.url)}" ${EXTERNAL}>
      <span class="stg-about-link-label">${kit.esc(linkLabel(link, kit.tx))}</span>
      <span class="stg-about-link-url">${kit.esc(linkHost(link.url))}</span>${ARROW}</a></li>`;
}

function fact(label, value, { mono = false } = {}) {
  if (value == null || value === '') return '';
  return `<div class="stg-about-fact"><dt>${label}</dt><dd${mono ? ' class="stg-about-mono"' : ''}>${kit.esc(String(value))}</dd></div>`;
}

function depRow(dep) {
  const url = npmUrl(dep.name);
  const name = url ? `<a class="stg-about-dep-name" href="${kit.esc(url)}" ${EXTERNAL}>${kit.esc(dep.name)}</a>` : `<span class="stg-about-dep-name">${kit.esc(dep.name)}</span>`;
  const version = dep.installed
    ? `<span class="stg-about-dep-version">${kit.esc(dep.version)}</span>`
    : `<span class="stg-about-dep-version" data-state="missing">${kit.esc(dep.declared)} · ${kit.te('settings.redesign.about.deps.notInstalled')}</span>`;
  const meta = [
    dep.installed && dep.declared && dep.declared !== dep.version ? kit.te('settings.redesign.about.deps.declared', { range: dep.declared }) : '',
    dep.optional ? kit.te('settings.redesign.about.deps.optional') : '',
    dep.license ? kit.esc(dep.license) : '',
  ].filter(Boolean).join(' · ');
  return `<li class="stg-about-dep">${name}${version}${meta ? `<span class="stg-about-dep-meta">${meta}</span>` : ''}</li>`;
}

function depGroup(title, sub, deps, { note = '' } = {}) {
  if (!deps.length) return '';
  return `<div class="stg-about-group">
      <h4 class="stg-subhead stg-about-group-head"><span>${title}</span>${sub ? `<span class="stg-about-group-sub">${sub}</span>` : ''}<span class="stg-about-count">${deps.length}</span></h4>
      ${note ? `<p class="stg-help stg-about-group-note">${note}</p>` : ''}
      <ul class="stg-about-dep-list">${deps.map(depRow).join('')}</ul>
    </div>`;
}

function drawDependencies(host, shown) {
  const { packages, vendored, counts } = shown;
  const runtime = packages.map((p) => depGroup(kit.esc(packageLabel(p, kit.tx)), kit.esc(p.name), p.runtime, { note: p.onDemand ? kit.te('settings.redesign.about.deps.onDemand') : '' })).join('');
  const singles = vendored.filter((b) => b.packages.length === 1).flatMap((b) => b.packages);
  const bundles = vendored.filter((b) => b.packages.length > 1)
    .map((b) => depGroup(kit.esc(b.label), kit.esc(b.version || ''), b.packages)).join('');
  const bundled = singles.length || bundles
    ? `<div class="stg-about-bundled">${depGroup(kit.te('settings.redesign.about.deps.vendored'), '', singles)}${bundles}</div>`
    : '';
  // A filter opens the group to show its matches; one the user opened stays open while they type.
  const devOpen = !!shown.query || !!host.querySelector('.stg-about-dev')?.open;
  const dev = counts.dev
    ? `<details class="stg-advanced stg-about-dev"${devOpen ? ' open' : ''}>
        <summary>${kit.CHEVRON}<span>${kit.te('settings.redesign.about.deps.dev', { count: counts.dev })}</span></summary>
        <div class="stg-advanced-body">${packages.map((p) => depGroup(kit.esc(packageLabel(p, kit.tx)), kit.esc(p.name), p.dev)).join('')}</div>
      </details>`
    : '';
  const empty = counts.total ? '' : `<p class="stg-help">${shown.query ? kit.te('settings.redesign.about.deps.noMatch', { query: shown.query }) : kit.te('settings.redesign.about.deps.none')}</p>`;
  host.innerHTML = `${runtime}${bundled}${dev}${empty}`;
}

/**
 * Load and draw the page the first time it is shown, and wire its buttons.
 * @param {HTMLElement} overlay   the Settings panel
 * @param {Object} [o]
 * @param {Function} [o.fetchImpl]  fetch (tests)
 * @param {(msg: string) => void} [o.toast]  the panel's toast
 * @param {Window} [o.win]          where the user agent and the desktop app's bridge are read
 */
export function wireAboutTab(overlay, { fetchImpl = (...args) => fetch(...args), toast = () => {}, win = window } = {}) {
  const pane = kit.paneOf(overlay, 'about');
  if (!pane) return;
  const $ = (id) => pane.querySelector(`#${id}`);
  const client = readClientRuntime({ userAgent: win.navigator?.userAgent, desktop: desktopBridge(win) });
  let model = null;
  let loading = null;

  const getJson = async (url) => {
    try {
      const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      return await res.json().catch(() => null);
    } catch {
      return null;
    }
  };

  const show = (node, text) => {
    if (!node) return;
    node.textContent = text || '';
    node.hidden = !text;
  };

  function drawHeader() {
    const { app } = model;
    show($('stg-about-version'), versionLine(app, kit.tx));
    show($('stg-about-install'), installLine(app, kit.tx));
    show($('stg-about-desc'), app.description);
    show($('stg-about-note'), model.full ? '' : kit.tx('settings.redesign.about.restartNote'));
  }

  function drawLinks() {
    const host = $('stg-about-links');
    if (!host) return;
    host.innerHTML = model.links.length
      ? model.links.filter((l) => isExternalUrl(l.url)).map(linkRow).join('')
      : `<li class="stg-help stg-about-empty">${model.full ? kit.te('settings.redesign.about.links.none') : kit.te('settings.redesign.about.afterRestart')}</li>`;
  }

  function drawFacts() {
    const host = $('stg-about-facts');
    if (!host) return;
    const { app, runtime } = model;
    host.innerHTML = [
      fact(kit.te('settings.redesign.about.row.version'), app.version ? `${app.version} (${buildLabel(app, kit.tx)})` : ''),
      fact(kit.te('settings.redesign.about.row.install'), installLine(app, kit.tx)),
      fact('Node.js', runtime.node),
      fact('SQLite', runtime.sqlite),
      fact('Electron', client.electron),
      fact('Chromium', client.chromium),
      fact(kit.te('settings.redesign.about.row.os'), osLine(runtime, client)),
      fact(kit.te('settings.redesign.about.row.dataFolder'), runtime.dataHome, { mono: true }),
      fact(kit.te('settings.redesign.about.row.port'), runtime.port),
    ].join('');
  }

  function drawDeps() {
    const host = $('stg-about-deps');
    const count = $('stg-about-deps-count');
    const filter = pane.querySelector('.stg-about-filter');
    const deps = model.dependencies;
    if (!host) return;
    if (!deps) {
      host.innerHTML = `<p class="stg-help stg-about-empty">${kit.te('settings.redesign.about.afterRestart')}</p>`;
      if (filter) filter.hidden = true;
      return;
    }
    if (count) count.textContent = deps.counts.total ? String(deps.counts.total) : '';
    if (filter) filter.hidden = deps.counts.total <= ABOUT_FILTER_MIN;
    drawDependencies(host, filterDependencies(deps, $('stg-about-filter')?.value || ''));
  }

  function drawFooter() {
    const host = $('stg-about-footer');
    if (!host) return;
    const { app } = model;
    const lines = [];
    if (app.license) lines.push(`<p>${kit.te('settings.redesign.about.footer.license', { license: app.license })}</p>`);
    if (app.copyright) lines.push(`<p>${kit.te('settings.redesign.about.footer.copyright', { years: app.copyright.years, holder: app.copyright.holder })}</p>`);
    if (model.dependencies?.counts.total) lines.push(`<p><button type="button" class="stg-about-builtwith" id="stg-about-builtwith">${kit.te('settings.redesign.about.footer.builtWith')}</button></p>`);
    host.innerHTML = lines.join('');
    host.hidden = !lines.length;
  }

  function draw() {
    drawHeader();
    drawLinks();
    drawFacts();
    drawDeps();
    drawFooter();
  }

  async function load() {
    const about = await getJson(ABOUT_URL);
    let answer = readAboutAnswer({ about });
    if (!answer.full) {
      // An older server: what it has always said.
      const [health, version] = await Promise.all([getJson('/api/health'), getJson('/api/system/version')]);
      answer = readAboutAnswer({ health, version });
    }
    if (!document.body.contains(overlay)) return;
    model = answer;
    draw();
  }

  const ensure = () => { if (!loading) loading = load(); return loading; };
  if (kit.paneActive(overlay, 'about')) ensure();
  overlay.addEventListener('stg-page-change', (e) => { if (e.detail?.page === 'about') ensure(); });

  // ── Buttons ──

  const updateBtn = $('stg-about-update');
  // The Apps menu's own item: no menu (an embed, a test page), no button.
  if (updateBtn && !document.getElementById(UPDATE_MENU_ITEM)) updateBtn.hidden = true;
  updateBtn?.addEventListener('click', () => document.getElementById(UPDATE_MENU_ITEM)?.click());

  $('stg-about-copy')?.addEventListener('click', async () => {
    if (!model) await ensure();
    const body = diagnosticsText(model, client, { tx: kit.tx });
    try {
      await win.navigator.clipboard.writeText(body);
      toast(kit.tx('settings.redesign.about.copied'));
    } catch {
      toast(kit.tx('settings.redesign.about.copyFailed'));
    }
  });

  $('stg-about-filter')?.addEventListener('input', () => { if (model) drawDeps(); });

  pane.addEventListener('click', (e) => {
    if (!e.target.closest?.('#stg-about-builtwith')) return;
    const section = $('stg-sec-about-dependencies');
    const content = overlay.querySelector('.settings-content');
    if (!section || !content) return;
    revealSettingsTarget(overlay, section);
    // Only the page scrolls, never the panel around it.
    const top = section.getBoundingClientRect().top - content.getBoundingClientRect().top + content.scrollTop - 8;
    content.scrollTo({ top: Math.max(0, top), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  });
}
