const DEFAULT_LOCALE = 'en-US';
const DEFAULT_ACCEPT_LANGUAGE = 'en-US,en;q=0.9';
// HTTP language ranges allow '*' and an optional qvalue with at most three decimals.
const LANGUAGE_RANGE = /^(\*|[a-z]{1,8}(?:-[a-z0-9]{1,8})*)(?:[ \t]*;[ \t]*q[ \t]*=[ \t]*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?$/i;

function isAutomatic(value) {
  return value == null || (typeof value === 'string' && !value.trim());
}

function canonicalLocale(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return Intl.getCanonicalLocales(value.trim())[0] || null;
  } catch {
    return null;
  }
}

function parseAcceptLanguage(value) {
  if (typeof value !== 'string' || /[\x00-\x08\x0a-\x1f\x7f]/.test(value)) return null;
  const header = value.trim();
  const entries = header.split(',').map(entry => entry.trim()).filter(Boolean);
  if (!entries.length) return null;

  const languages = new Set();
  for (const entry of entries) {
    const match = LANGUAGE_RANGE.exec(entry);
    if (!match) return null;
    const [, range, quality] = match;
    if (range === '*' || (quality !== undefined && Number(quality) === 0)) continue;
    // A valid HTTP language range need not be a locale supported by Intl (e.g. x-private).
    const locale = canonicalLocale(range);
    if (locale) languages.add(locale);
  }
  return { header, languages: [...languages] };
}

/** Resolve legacy settings and request headers without rewriting the saved config. */
export function resolveBrowserLanguage(savedCfg = {}, requestAcceptLanguage) {
  const savedLocale = canonicalLocale(savedCfg.locale);
  const savedHeader = parseAcceptLanguage(savedCfg.acceptLanguage);
  const requestHeader = savedHeader ? null : parseAcceptLanguage(requestAcceptLanguage);
  const resolvedHeader = savedHeader || requestHeader || parseAcceptLanguage(DEFAULT_ACCEPT_LANGUAGE);
  const locale = savedLocale || resolvedHeader.languages[0] || DEFAULT_LOCALE;
  const warnings = [];
  if (!isAutomatic(savedCfg.locale) && !savedLocale) {
    warnings.push({ field: 'locale', value: locale });
  }
  if (!isAutomatic(savedCfg.acceptLanguage) && !savedHeader) {
    warnings.push({ field: 'acceptLanguage', value: resolvedHeader.header });
  }
  if (!savedHeader && !isAutomatic(requestAcceptLanguage) && !requestHeader) {
    warnings.push({ field: 'request Accept-Language', value: resolvedHeader.header });
  }
  return {
    locale,
    acceptLanguage: resolvedHeader.header,
    languages: resolvedHeader.languages.length ? resolvedHeader.languages : [locale],
    warnings,
  };
}

/** Return a normalized copy; invalid explicit language fields throw with status/field. */
export function validateBrowserLanguageConfig(config) {
  const normalized = { ...config };
  for (const field of ['locale', 'acceptLanguage']) {
    if (!Object.hasOwn(config, field)) continue;
    const value = config[field];
    if (isAutomatic(value)) {
      normalized[field] = null;
      continue;
    }
    const validated = field === 'locale' ? canonicalLocale(value) : parseAcceptLanguage(value)?.header;
    if (!validated) {
      const help = field === 'locale'
        ? 'use a single locale tag such as pt-BR, or leave it blank for automatic detection'
        : 'use comma-separated language ranges (or *) with optional q weights between 0 and 1 (up to three decimal places), or leave it blank';
      throw Object.assign(new Error(`Invalid ${field}: ${help}.`), { status: 400, field });
    }
    normalized[field] = validated;
  }
  return normalized;
}
