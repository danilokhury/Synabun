// The offline page is the one page that must work with the server down: the
// service worker serves the copy it cached while the server was still up. So
// everything it needs is put into that copy here: where SynaBun is installed,
// how it was installed, whether the Start Server launcher is registered, and
// the bridge code itself (public/shared/start-bridge.js, shared with the
// in-app loading overlay).

const BRIDGE_SLOT = '/*__SYNABUN_START_BRIDGE__*/';
const FACTS_SLOT = '/*__SYNABUN_OFFLINE_FACTS__*/';

/** An ES module with only top-level `export function` / `export const` → a classic script. */
export function moduleToClassicScript(source) {
  const text = String(source || '');
  if (/^\s*import\s/m.test(text) || /^\s*export\s+(?!function\b|const\b|async\s+function\b)/m.test(text)) {
    throw new Error('start-bridge.js must only use `export function` / `export const` and no imports');
  }
  return text.replace(/^export\s+/gm, '');
}

/** JSON that is safe inside a <script> element. */
export function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * facts: { projectDir, install: 'npm' | 'git', launcher: 'registered' | 'stale' | 'missing' | 'skipped' }
 * A template without the slots (an older cached copy, a hand-edited file) is
 * returned as it is: the page then shows the commands and no button.
 */
export function renderOfflinePage(template, { bridgeSource = '', facts = {} } = {}) {
  let html = String(template || '');
  if (html.includes(BRIDGE_SLOT)) {
    let script = '';
    try { script = moduleToClassicScript(bridgeSource).replace(/<\/script/gi, '<\\/script'); } catch {}
    html = html.replace(BRIDGE_SLOT, () => script);
  }
  if (html.includes(FACTS_SLOT)) {
    html = html.replace(FACTS_SLOT, () => `window.__SYNABUN_OFFLINE__ = ${scriptJson({
      projectDir: facts.projectDir || '',
      install: facts.install === 'npm' ? 'npm' : 'git',
      launcher: String(facts.launcher || ''),
    })};`);
  }
  return html;
}

export const OFFLINE_SLOTS = Object.freeze({ bridge: BRIDGE_SLOT, facts: FACTS_SLOT });
