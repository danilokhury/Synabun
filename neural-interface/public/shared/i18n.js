// ═══════════════════════════════════════════
// SynaBun Neural Interface — Internationalization
// Lightweight runtime i18n: loads JSON translations at boot,
// exposes t() / tp() for all modules.
// ═══════════════════════════════════════════

let _messages = {};
let _locale = 'en';
let _ready = false;

// ── Supported locales (grows as translations are added) ──
export const SUPPORTED_LOCALES = ['en'];

// ── Locale metadata (for language switcher UI) ──
export const LOCALE_NAMES = {
  en: 'English',
};

// ═══════════════════════════════════════════
// CORE API
// ═══════════════════════════════════════════

/**
 * Resolve a dot-separated key path against a nested object.
 * t('settings.server.status') → messages.settings.server.status
 */
function resolve(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

/**
 * Translate a key, with optional parameter interpolation.
 *
 * @param {string} key  Dot-separated key path (e.g. 'nav.view')
 * @param {Object} [params]  Interpolation values: "Hello {name}" + { name: 'Dan' }
 * @returns {string} Translated string, or the key itself if missing
 *
 * @example
 *   t('common.save')                          // "Save"
 *   t('explorer.importanceTooltip', { n: 8 }) // "Importance: 8/10"
 */
export function t(key, params) {
  let val = resolve(_messages, key);
  if (val === undefined) {
    if (_ready) console.warn(`[i18n] Missing key: ${key}`);
    return key;
  }
  if (params && typeof val === 'string') {
    val = val.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : `{${k}}`));
  }
  return val;
}

/**
 * Pluralization helper. Resolves to key.one or key.other based on count.
 *
 * @param {string} key   Base key path (e.g. 'search.resultCount')
 * @param {number} count The number to pluralize on
 * @param {Object} [params] Extra interpolation values (count is auto-included)
 * @returns {string}
 *
 * @example
 *   // en.json: { "search": { "resultCount": { "one": "1 result", "other": "{count} results" } } }
 *   tp('search.resultCount', 1)   // "1 result"
 *   tp('search.resultCount', 42)  // "42 results"
 */
export function tp(key, count, params) {
  const plural = count === 1 ? 'one' : 'other';
  return t(`${key}.${plural}`, { count, ...params });
}

/**
 * Get the current locale code (e.g. 'en', 'es').
 * Use this for Intl APIs: date.toLocaleDateString(getLocale(), ...)
 */
export function getLocale() {
  return _locale;
}

/**
 * Check if translations have been loaded.
 */
export function isReady() {
  return _ready;
}

// ═══════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════

/**
 * Detect the user's preferred locale.
 * Priority: localStorage explicit choice → browser language → 'en'
 */
function detectLocale() {
  // 1. Explicit user preference
  const saved = localStorage.getItem('synabun-locale');
  if (saved && SUPPORTED_LOCALES.includes(saved)) return saved;
  // 2. Browser language
  const browser = (navigator.language || 'en').slice(0, 2).toLowerCase();
  if (SUPPORTED_LOCALES.includes(browser)) return browser;
  // 3. Default
  return 'en';
}

/**
 * Load translations. Call this ONCE at app boot, BEFORE any UI modules init.
 * Typically the first thing in the entry point's top-level await.
 *
 * @param {string} [locale] Force a specific locale (skips detection)
 */
export async function initI18n(locale) {
  _locale = locale || detectLocale();
  try {
    const resp = await fetch(`/i18n/${_locale}.json`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    _messages = await resp.json();
  } catch (err) {
    // Fallback to English if the requested locale file fails
    if (_locale !== 'en') {
      console.warn(`[i18n] Failed to load '${_locale}', falling back to 'en'`);
      _locale = 'en';
      try {
        const resp = await fetch('/i18n/en.json');
        if (resp.ok) _messages = await resp.json();
      } catch {
        console.error('[i18n] Failed to load English fallback');
      }
    } else {
      console.error('[i18n] Failed to load English translations:', err);
    }
  }
  _ready = true;
  document.documentElement.lang = _locale;
}

/**
 * Switch to a different locale. Persists to localStorage and reloads.
 * @param {string} locale
 */
export function setLocale(locale) {
  if (!SUPPORTED_LOCALES.includes(locale)) return;
  localStorage.setItem('synabun-locale', locale);
  window.location.reload();
}
