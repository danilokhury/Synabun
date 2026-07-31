/**
 * Shared Facebook region / currency / language helpers.
 *
 * Single source of truth for region bucketing, URL normalization, and seed-queue
 * parsing — imported by BOTH browser-observe.ts (the live joined-groups extractor)
 * and fb-groups.ts (the structured group directory tool) so the two stay in lockstep.
 * Previously these lived inline in browser-observe.ts; moved here to avoid duplication.
 */

/** Region bucket inferred from a group's posting currency. */
export const REGION_BY_CURRENCY: Record<string, string> = {
  GBP: 'UK', USD: 'US', EUR: 'EU', BRL: 'Brazil', TRY: 'Turkey', AUD: 'Australia', CAD: 'Canada',
};

/** Region bucket inferred from a group's language when currency is unknown. */
export const REGION_BY_LANG: Record<string, string> = {
  en: 'US/UK', pt: 'Brazil', fr: 'EU', de: 'EU', es: 'LatAm', it: 'EU', nl: 'EU', pl: 'EU', tr: 'Turkey',
};

/** Coarse country for single-country currencies (EUR omitted — multi-country). */
export const COUNTRY_BY_CURRENCY: Record<string, string> = {
  GBP: 'United Kingdom', USD: 'United States', BRL: 'Brazil', TRY: 'Turkey', AUD: 'Australia', CAD: 'Canada',
};

// Spain vs LatAm: both Spanish-speaking but different supported deal currency (Spain = EUR/EU,
// LatAm = USD — criticalpixel.gg has no local LatAm currency, so LatAm posts the USD link).
// Used by classifyGroupName/resolveClassification to split the broad 'es' bucket correctly.
export const SPAIN_RE = /\b(espa[ñn]a|madrid|barcelona|valencia|sevilla|zaragoza|bilbao|m[áa]laga|ib[ée]rica?)\b/i;
export const LATAM_RE = /\b(m[ée]xico|mexican[oa]?|argentin[oa]?|chilen[oa]?|chile|peruan[oa]?|per[uú]|colombian[oa]?|colombia|venezolan[oa]?|venezuela|uruguay|paraguay|bolivia|ecuador|guatemala|hondure[ñn]o|nicaragua|panam[áa]|costa rica|rep[uú]blica dominicana|latinoam[ée]rica|latino\s?am[ée]rica|sudam[ée]rica|latin[oa]s?|latam|hispano)\b/i;

// Country/region-name fallback when a group is not in the seed-queue. Order matters: most
// specific first. Matched against the group name (and slug-with-spaces). Country-accurate —
// language-based detection lives in classifyGroupName below. LatAm sits before US so
// "América Latina" is not swallowed by the US "america" alias.
export const NAME_REGION: Array<[RegExp, string]> = [
  [/\b(uk|u\.k\.|britain|british|england|london|scotland|scottish|wales|welsh|ireland|irish)\b/i, 'UK'],
  [LATAM_RE, 'LatAm'],
  [/\b(usa|u\.s\.a|united states|american?)\b/i, 'US'],
  [/\b(brasil|brazil|brasileir[oa]?)\b/i, 'Brazil'],
  [/\b(türkiye|turkiye|turkey|türk|turk)\b/i, 'Turkey'],
  [/\b(australia|australian|aussie|nz|new zealand|kiwi)\b/i, 'Australia'],
  [/\b(canada|canadian)\b/i, 'Canada'],
  [/\b(france|français|francais|paris)\b/i, 'EU'],
  [/\b(deutschland|german|deutsch)\b/i, 'EU'],
  [/\b(españa|espana|spanish|español|espanol)\b/i, 'EU'],
  [/\b(italia|italy|italian)\b/i, 'EU'],
  [/\b(polska|poland|polish)\b/i, 'EU'],
];

// Inverse maps for classification: a region's supported posting currency + default language.
const REGION_TO_CURRENCY: Record<string, string> = {
  UK: 'GBP', US: 'USD', EU: 'EUR', Brazil: 'BRL', Turkey: 'TRY', Australia: 'AUD', Canada: 'CAD', LatAm: 'USD',
};
const REGION_TO_LANG: Record<string, string> = {
  UK: 'en', US: 'en', Brazil: 'pt', Turkey: 'tr', Australia: 'en', Canada: 'en', LatAm: 'es', // EU omitted: ambiguous
};
// Posting currency a language maps to (the SUPPORTED Critical Pixel deal-link currency, not the
// local currency — Polish/Italian post the EUR link). 'es' = USD: Spanish skews LatAm (USD); Spain
// (EUR) is split back out by name in classifyGroupName. 'en' stays null: needs a country/seed signal.
const CURRENCY_BY_LANG: Record<string, string> = {
  pt: 'BRL', tr: 'TRY', de: 'EUR', fr: 'EUR', es: 'USD', it: 'EUR', pl: 'EUR', nl: 'EUR',
};
// Distinctive gaming/deals vocabulary per language, matched as whole words against the lowercased
// name+slug. High-precision to avoid English false positives ("games"/"deals" are NOT tokens).
const LANG_TOKENS: Array<[string, RegExp]> = [
  // PT-distinctive only: "barato(s)"/"gratis" are shared with ES, so excluded here (ES keeps them)
  // to avoid Spanish groups ("Juegos Baratos") being mis-tagged Brazilian. "grátis" stays accented.
  ['pt', /\b(jogos?|vendas?|trocas?|grátis|promoç(ão|ões)|brasil|brasileir[oa]s?|apaixonados|usados?|portugu[êe]s|classificad[oa]s?|pe[çc]as|barganha|desapego|negócios|divulga\w*|clube|conex[ãa]o|colecionador\w*|compras?|contas?)\b/i],
  ['tr', /\b(oyun(lar|cu)?|al[ıi]m|sat[ıi][mş]|takas|ucuz|t[üu]rk(iye)?|indirim|hesap|bilgisayar|ekipman|donan[ıi]m|s[ıi]f[ıi]r)/i],
  ['de', /\b(spiele?|g[üu]nstig|kaufen|verkaufen|verkauf|tauschen|tausch|b[öo]rse|ankauf|gebraucht|deutsch(land)?|schn[äa]ppchen|angebote?)\b/i],
  ['fr', /\b(jeux|pas cher|vente|achat|gratuit|fran[çc]ais)\b/i],
  ['es', /\b(juegos?|barat[oa]s?|ofertas?|venta|compra|gratis|consolas?|espa[ñn]a|espa[ñn]ol)\b/i],
  ['pl', /\b(gry|gier|tanie|sprzedam|kupi[ęe]|polska|okazje)\b/i],
  ['it', /\b(videogioch\w*|giochi|economici|vendita|mercatino|italia(no)?)\b/i],
  ['nl', /\b(spellen|goedkoop|verkopen|nederland)\b/i],
];

/**
 * Conservative name-based classifier → { region, lang, currency } where currency is a SUPPORTED
 * deal-link currency. Language tokens win first (strong signal), then country-name aliases; returns
 * Unknown/null when there is no confident signal (those are left for the LLM curation pass).
 */
export function classifyGroupName(name: string, slug = ''): { region: string; lang: string | null; currency: string | null } {
  const hay = `${name || ''} ${(slug || '').replace(/[-_]+/g, ' ')}`;
  for (const [lang, re] of LANG_TOKENS) {
    if (re.test(hay)) {
      // Spanish splits by country: Spain -> EUR/EU, everywhere else (LatAm) -> USD. USD is shared
      // with the US bucket, so es must resolve its region by name, never via REGION_BY_CURRENCY[USD].
      if (lang === 'es') {
        const isSpain = SPAIN_RE.test(hay) && !LATAM_RE.test(hay);
        return isSpain
          ? { region: 'EU', lang: 'es', currency: 'EUR' }
          : { region: 'LatAm', lang: 'es', currency: 'USD' };
      }
      const currency = CURRENCY_BY_LANG[lang] || null;
      const region = (currency && REGION_BY_CURRENCY[currency]) || REGION_BY_LANG[lang] || 'Unknown';
      return { region, lang, currency };
    }
  }
  const region = inferRegionFromName(hay);
  if (region !== 'Unknown') {
    return { region, lang: REGION_TO_LANG[region] || null, currency: REGION_TO_CURRENCY[region] || null };
  }
  return { region: 'Unknown', lang: null, currency: null };
}

// Normalize a scraped group name: strip leading/trailing separators (incl. the trailing "(" left by
// "Name (12k members)") and reject pure label words ("URL", "Group URL", "Link") that the migration
// captured from "URL: https://..." lines.
const NAME_LABELS = new Set(['url', 'group url', 'link', 'status', 'name', 'group', 'grupo']);
export function cleanName(raw?: string | null): string {
  const n = (raw || '').replace(/[\s(|\-—–:•·]+$/, '').replace(/^[\s)|\-—–:•·]+/, '').trim();
  if (!n || NAME_LABELS.has(n.toLowerCase())) return '';
  return n.slice(0, 120);
}

export function inferRegionFromName(name: string): string {
  for (const [re, region] of NAME_REGION) if (re.test(name)) return region;
  return 'Unknown';
}

/**
 * Region bucket from a seed-queue lang/currency pair. Currency wins, then language. USD is shared
 * by US + LatAm, so a Spanish-language USD seed is LatAm. Falls back to the language's posting
 * currency when no currency is given (so lang=pt with no currency still lands in Brazil, not
 * Unknown). The non-canonical 'US/UK' english placeholder is never surfaced as a real bucket.
 */
export function regionForSeed(lang?: string | null, currency?: string | null): string {
  const ccy = (currency || '').toUpperCase();
  const lg = (lang || '').toLowerCase();
  if (ccy && REGION_BY_CURRENCY[ccy]) {
    return ccy === 'USD' && lg === 'es' ? 'LatAm' : REGION_BY_CURRENCY[ccy];
  }
  if (lg) {
    const byLang = REGION_BY_LANG[lg];
    if (byLang && byLang !== 'US/UK') return byLang;
    const byCur = CURRENCY_BY_LANG[lg];
    if (byCur && REGION_BY_CURRENCY[byCur]) {
      return byCur === 'USD' && lg === 'es' ? 'LatAm' : REGION_BY_CURRENCY[byCur];
    }
  }
  return 'Unknown';
}

/** The canonical region buckets the directory uses (anything else collapses to Unknown). */
export const CANONICAL_REGIONS = new Set(['UK', 'US', 'EU', 'Brazil', 'Turkey', 'Australia', 'Canada', 'LatAm']);

function nonUnknown(r: string): string | null { return r === 'Unknown' ? null : r; }

/**
 * Idempotent, all-signals reclassifier. Given whatever a row already has (name/url + any stored
 * region/lang/currency), return the best { region, lang, currency, country }. The recategorize
 * backfill and the import paths route through this so every entry point agrees.
 *
 * Spanish is resolved first (LatAm=USD default, Spain=EUR) so a stale es->EUR/EU row is corrected
 * rather than preserved. Otherwise a confident name classification wins, then language, then
 * currency, then an already-canonical stored region, else Unknown.
 */
export function resolveClassification(input: {
  name?: string | null; url?: string | null; region?: string | null; lang?: string | null; currency?: string | null;
}): { region: string; lang: string | null; currency: string | null; country: string | null } {
  const slug = (input.url || '').match(/\/groups\/([^/]+)/)?.[1] || '';
  const hay = `${input.name || ''} ${slug.replace(/[-_]+/g, ' ')}`;
  const cls = classifyGroupName(input.name || '', slug);
  const storedLang = (input.lang || '').toLowerCase() || null;

  // Spanish: decide LatAm (USD) vs Spain (EUR) up front, overriding any stale EUR/EU classification.
  if (cls.lang === 'es' || storedLang === 'es') {
    const isSpain = SPAIN_RE.test(hay) && !LATAM_RE.test(hay);
    return isSpain
      ? { region: 'EU', lang: 'es', currency: 'EUR', country: 'Spain' }
      : { region: 'LatAm', lang: 'es', currency: 'USD', country: 'LatAm' };
  }

  const lang = storedLang || cls.lang || null;
  let currency = (input.currency || '').toUpperCase();
  if (currency && !REGION_BY_CURRENCY[currency]) currency = '';            // drop unsupported currency
  currency = currency || cls.currency || (lang ? CURRENCY_BY_LANG[lang] || '' : '');

  const stored = input.region && CANONICAL_REGIONS.has(input.region) ? input.region : null;
  let region =
    nonUnknown(cls.region)
    || (lang ? nonUnknown(regionForSeed(lang, currency || null)) : null)
    || (currency ? nonUnknown(regionForSeed(null, currency)) : null)
    || stored
    || 'Unknown';
  if (!CANONICAL_REGIONS.has(region)) region = 'Unknown';
  if (!currency && region !== 'Unknown') currency = REGION_TO_CURRENCY[region] || '';

  const country = currency ? COUNTRY_BY_CURRENCY[currency] || null : null;
  return { region, lang: lang || null, currency: currency || null, country };
}

/** Canonical Facebook group URL: origin + /groups/<slug>/ (single trailing slash). */
export function normUrl(u: string): string {
  try {
    const x = new URL(u.trim());
    return x.origin + x.pathname.replace(/\/+$/, '') + '/';
  } catch {
    return u.trim();
  }
}

/**
 * Parse a seed-queue memory body. [QUEUE] / ledger lines are pipe-delimited
 * "url | lang | currency | ..." — extra trailing columns are ignored. Returns a
 * map keyed by the normalized URL so callers can reconcile against live extracts.
 */
export function parseSeedQueue(body: string): Map<string, { lang: string; currency: string }> {
  const map = new Map<string, { lang: string; currency: string }>();
  for (const raw of (body || '').split('\n')) {
    const line = raw.trim();
    if (!line || !line.includes('|') || !/\/groups\//.test(line)) continue;
    const parts = line.split('|').map((p) => p.trim());
    if (parts.length < 2) continue;
    const url = normUrl(parts[0].replace(/^[-*\d.\s]+/, ''));
    if (!/^https?:\/\//.test(url)) continue;
    map.set(url, { lang: (parts[1] || '').toLowerCase(), currency: (parts[2] || '').toUpperCase() });
  }
  return map;
}
