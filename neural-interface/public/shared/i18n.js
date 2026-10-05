// ═══════════════════════════════════════════
// SynaBun Neural Interface — Internationalization
// Lightweight runtime i18n: loads JSON translations at boot,
// exposes t() / tp() for all modules.
// ═══════════════════════════════════════════

import { storage } from './storage.js';
// Read as a namespace: a page that serves its own storage module (a test harness) may have no flushStorage.
import * as storageModule from './storage.js';

let _messages = {};
let _fallback = {};   // English: what a key the active locale lacks resolves to
let _locale = 'en';
let _ready = false;

// ── Supported locales (grows as translations are added) ──
export const SUPPORTED_LOCALES = ['en', 'pt-BR'];

// ── Locale metadata (for language switcher UI) ──
export const LOCALE_NAMES = {
  en: 'English',
  'pt-BR': 'Português (Brasil)',
};

// ── Where each locale's strings are served from ──
export const LOCALE_FILES = {
  en: '/i18n/en.json',
  'pt-BR': '/i18n/pt-BR.json',
};

const FALLBACK_LOCALE = 'en';
const LOCALE_STORAGE_KEY = 'synabun-locale';
/** The stored choice that means "follow the system language". No stored value means the same. */
export const SYSTEM_LOCALE = 'system';

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
 * @returns {string} Translated string, the English one if the active locale lacks it, or the key itself if both do
 *
 * @example
 *   t('common.save')                          // "Save"
 *   t('explorer.importanceTooltip', { n: 8 }) // "Importance: 8/10"
 */
export function t(key, params) {
  let val = resolve(_messages, key);
  if (val === undefined && _fallback !== _messages) val = resolve(_fallback, key);
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
 * Get the current locale code (e.g. 'en', 'pt-BR').
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

/**
 * English as a translate function of its own, for a locale that is not English: the bundle t() falls back to.
 * A key English lacks comes back as ''. Null when English is the active locale, and while the bundle is not
 * loaded (its request failed at boot; see loadEnglishTranslator).
 * Settings search uses it to find a setting by its English name in another language.
 */
export function englishTranslator() {
  if (_locale === FALLBACK_LOCALE || !_fallback || !Object.keys(_fallback).length) return null;
  const messages = _fallback;
  return (key, params) => {
    const val = resolve(messages, key);
    if (typeof val !== 'string') return '';
    return params ? val.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : `{${k}}`)) : val;
  };
}

let _englishLoad = null;
/**
 * englishTranslator(), loading the English bundle first when i18n does not hold it. One request however often
 * it is asked; a failed one may be tried again. Resolves to null when there is no English to give.
 */
export function loadEnglishTranslator() {
  const ready = englishTranslator();
  if (ready || _locale === FALLBACK_LOCALE) return Promise.resolve(ready);
  if (!_englishLoad) {
    _englishLoad = loadMessages(FALLBACK_LOCALE)
      .then((messages) => { if (messages && typeof messages === 'object') _fallback = messages; return englishTranslator(); })
      .catch(() => { _englishLoad = null; return null; });
  }
  return _englishLoad;
}

// ═══════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════

/**
 * The supported locale a language tag stands for, or null.
 * Exact match first ('pt-BR', any case), then the language alone ('pt', 'pt-PT' → 'pt-BR').
 */
function matchLocale(tag) {
  const wanted = String(tag || '').trim().toLowerCase();
  if (!wanted) return null;
  const exact = SUPPORTED_LOCALES.find((l) => l.toLowerCase() === wanted);
  if (exact) return exact;
  const language = wanted.split('-')[0];
  return SUPPORTED_LOCALES.find((l) => l.toLowerCase().split('-')[0] === language) || null;
}

/**
 * The locale the system (the browser) asks for: its languages in order of
 * preference, each matched exactly and then by language; 'en' when none is supported.
 */
export function getSystemLocale() {
  const tags = [navigator.language, ...(Array.isArray(navigator.languages) ? navigator.languages : [])];
  for (const tag of tags) {
    const match = matchLocale(tag);
    if (match) return match;
  }
  return FALLBACK_LOCALE;
}

/**
 * What the user chose: 'system' (follow the system language; also when nothing
 * is stored) or one of SUPPORTED_LOCALES.
 */
export function getLocaleChoice() {
  const saved = storage.getItem(LOCALE_STORAGE_KEY);
  if (!saved || saved === SYSTEM_LOCALE) return SYSTEM_LOCALE;
  return matchLocale(saved) || SYSTEM_LOCALE;
}

/**
 * Detect the user's preferred locale.
 * Priority: stored explicit choice → system language → 'en'
 */
function detectLocale() {
  const choice = getLocaleChoice();
  return choice === SYSTEM_LOCALE ? getSystemLocale() : choice;
}

async function loadMessages(locale) {
  const resp = await fetch(LOCALE_FILES[locale] || `/i18n/${locale}.json`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

/**
 * Load translations. Call this ONCE at app boot, BEFORE any UI modules init.
 * Typically the first thing in the entry point's top-level await.
 * English is always loaded: t() falls back to it key by key.
 *
 * @param {string} [locale] Force a specific locale (skips detection)
 */
export async function initI18n(locale) {
  _locale = matchLocale(locale) || detectLocale();
  const [english, active] = await Promise.allSettled([
    loadMessages(FALLBACK_LOCALE),
    _locale === FALLBACK_LOCALE ? null : loadMessages(_locale),
  ]);
  if (english.status === 'fulfilled') _fallback = english.value;
  else console.error('[i18n] Failed to load English translations:', english.reason);

  if (_locale === FALLBACK_LOCALE) {
    _messages = _fallback;
  } else if (active.status === 'fulfilled' && active.value && typeof active.value === 'object') {
    _messages = active.value;
  } else {
    // The requested locale's file is missing or broken: the whole UI stays English
    console.warn(`[i18n] Failed to load '${_locale}', falling back to '${FALLBACK_LOCALE}'`);
    _locale = FALLBACK_LOCALE;
    _messages = _fallback;
  }
  _ready = true;
  document.documentElement.lang = _locale;
}

/**
 * Store the language choice and reload to apply it.
 * @param {string} choice 'system' or one of SUPPORTED_LOCALES
 * @returns {boolean} false when the choice is not one of those (nothing stored, no reload)
 */
export function setLocaleChoice(choice) {
  const value = choice === SYSTEM_LOCALE ? SYSTEM_LOCALE : (SUPPORTED_LOCALES.includes(choice) ? choice : null);
  if (!value) return false;
  storage.setItem(LOCALE_STORAGE_KEY, value);
  // The store writes to the server after a pause; the reload must read the new choice.
  // (A write still pending when the page unloads goes out as a beacon, so a slow server only delays the reload.)
  const written = Promise.resolve().then(() => storageModule.flushStorage?.()).catch(() => {});
  Promise.race([written, new Promise((done) => setTimeout(done, 1500))]).then(() => window.location.reload());
  return true;
}

/**
 * Switch to a different locale. Persists the choice and reloads.
 * @param {string} locale
 */
export function setLocale(locale) {
  if (!SUPPORTED_LOCALES.includes(locale)) return;
  setLocaleChoice(locale);
}
