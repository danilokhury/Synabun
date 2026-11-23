// ═══════════════════════════════════════════
// SynaBun — Assistant list prices (one table)
// ═══════════════════════════════════════════
//
// The only place a model's list price is written. The model catalog (routing
// sheet, agent_catalog, the pickers), the usage ledger (Codex tokens, Claude
// estimates), the budget caps and the side panel's cost scanner all read it.
//
// Sources, verified 2026-11-20:
//   Anthropic  https://platform.claude.com/docs/en/about-claude/pricing
//   OpenAI     https://developers.openai.com/api/docs/pricing
//              (long-context boundary: https://developers.openai.com/api/docs/models/gpt-6.2-sol)
//              (gpt-5.3-codex: https://developers.openai.com/api/docs/models/gpt-5.3-codex)
//   Ollama     https://ollama.com/pricing (verified overrides for stale OpenCode catalog rows)
//
// $ per million tokens, one rate per token class:
//   input         uncached input
//   cacheRead     a cache hit ("cached input")
//   cacheWrite    a cache write (Anthropic: the 5-minute cache, 1.25x input; OpenAI GPT-6/5.6: 30-min cache, 1.25x input)
//   cacheWrite1h  Anthropic's 1-hour cache write (2x input). The Claude CLI writes most of
//                 its cache at this rate, so an estimate of its usage prices writes with it.
//   output        output, reasoning / thinking included
//   long          a second rate card: a request whose prompt is over `size` input tokens is
//                 priced at these rates for the whole request. OpenAI: over 272K, 2x input and
//                 cache, 1.5x output. Anthropic prices the full 1M window at the standard rate
//                 (Claude 4.6 and later), except Claude Haiku 5.5: over 100K, $0.50 / $2.50.
//                 The Claude estimates below price every request at the standard card: the
//                 Claude meters report a model's tokens, not each request's prompt size.
//
// What is billed is the provider's business: Claude Code and Codex usually run on a plan, where
// these dollars are the list-price equivalent of the tokens, not a charge.
//
// Pure: no I/O, no dependencies.

export const PRICING_VERIFIED = '2026-11-20';
export const PRICING_SOURCES = Object.freeze({
  anthropic: 'https://platform.claude.com/docs/en/about-claude/pricing',
  openai: 'https://developers.openai.com/api/docs/pricing',
  ollama: 'https://ollama.com/pricing',
});
/** OpenAI's long-context boundary: a prompt over this many input tokens is priced at the long rates. */
export const LONG_PROMPT_TOKENS = 272_000;

const round = (value) => Number(Number(value).toFixed(6));

/**
 * Anthropic: cache writes are 1.25x (5 minutes) and 2x (1 hour) the input rate; cache reads are per model.
 * `over` ({ size, input, output }) is the rate card of a prompt over `size` input tokens, with the
 * same cache ratios as the standard card.
 */
function claude(input, output, cacheRead, over = null) {
  const long = over ? Object.freeze({
    size: over.size, input: over.input, output: over.output, cacheRead: round(over.input * (cacheRead / input)),
    cacheWrite: round(over.input * 1.25), cacheWrite1h: round(over.input * 2),
  }) : null;
  return Object.freeze({ input, output, cacheRead, cacheWrite: round(input * 1.25), cacheWrite1h: round(input * 2), long });
}
/**
 * OpenAI: GPT-6 / GPT-5.6 models price 30-minute cache writes at 1.25x input (12-hour writes at 2.5x);
 * older models with no write fee leave `cacheWrite: null` (priced as input). Over 272K prompt tokens
 * input and cache rates double and output is 1.5x where long-context pricing applies.
 */
function openai(input, output, cacheRead, { cacheWrite: hasCacheWrite = true, long: hasLong = true } = {}) {
  const cacheWrite = hasCacheWrite ? round(input * 1.25) : null;
  const long = hasLong ? Object.freeze({
    size: LONG_PROMPT_TOKENS, input: round(input * 2), output: round(output * 1.5), cacheRead: round(cacheRead * 2),
    cacheWrite: cacheWrite != null ? round(cacheWrite * 2) : null,
  }) : null;
  return Object.freeze({ input, output, cacheRead, cacheWrite, cacheWrite1h: null, long });
}

const ANTHROPIC = Object.freeze({
  'claude-fable-5-2': claude(8, 40, 0.2), // cache reads 0.025x
  'claude-fable-5-1': claude(10, 50, 0.25), // cache reads 0.025x
  'claude-fable-5': claude(10, 50, 1),
  'claude-opus-5-5': claude(4, 20, 0.2), // cache reads 0.05x
  'claude-opus-5': claude(5, 25, 0.5),
  'claude-opus-4-8': claude(5, 25, 0.5),
  'claude-opus-4-7': claude(5, 25, 0.5),
  'claude-opus-4-6': claude(5, 25, 0.5),
  'claude-opus-4-5': claude(5, 25, 0.5),
  'claude-sonnet-5-5': claude(2, 10, 0.1), // cache reads 0.05x
  // $2 / $10 was introductory until 2026-08-31 and is the standard price now (the $3 / $15 increase was cancelled).
  'claude-sonnet-5': claude(2, 10, 0.2),
  'claude-sonnet-4-6': claude(3, 15, 0.3),
  'claude-sonnet-4-5': claude(3, 15, 0.3),
  // Two rate cards, chosen by prompt length: $0.10 / $0.50 up to 100K prompt tokens, $0.50 / $2.50 above. Cache reads 0.1x.
  'claude-haiku-5-5': claude(0.1, 0.5, 0.01, { size: 100_000, input: 0.5, output: 2.5 }),
  'claude-haiku-4-5': claude(1, 5, 0.1),
  // Retired models, at their last published price (old sessions are still priced).
  'claude-3-5-sonnet': claude(3, 15, 0.3),
  'claude-3-5-haiku': claude(0.8, 4, 0.08),
});

const OPENAI = Object.freeze({
  'gpt-6.2-astra': openai(8, 40, 0.4),
  'gpt-6.2-sol': openai(2, 10, 0.1),
  'gpt-6-astra': openai(10, 50, 1),
  'gpt-6.1-sol': openai(2, 10, 0.1),
  'gpt-6.1-terra': openai(1, 5, 0.05),
  'gpt-6-sol': openai(2, 10, 0.2),
  'gpt-6-luna': openai(0.1, 0.5, 0.01),
  // Promotional pricing valid through 2026-11-30 per OpenAI pricing page.
  'gpt-5.6-sol': openai(4, 20, 0.4),
  'gpt-5.6-terra': openai(2, 12, 0.2),
  'gpt-5.6-luna': openai(0.2, 1.2, 0.02),
  'gpt-5.5': openai(5, 30, 0.5, { cacheWrite: false }),
  'gpt-5.4': openai(2.5, 15, 0.25, { cacheWrite: false }),
  'gpt-5.4-mini': openai(0.75, 4.5, 0.075, { cacheWrite: false, long: false }),
  // Deprecated on OpenAI docs; kept for CODEX_FALLBACK_MODELS and historic sessions.
  'gpt-5.3-codex': openai(1.75, 14, 0.175, { cacheWrite: false, long: false }),
  'chat-latest': openai(5, 30, 0.5, { cacheWrite: false, long: false }),
});

/**
 * Verified OpenCode catalog price overrides (`provider/model`, lower-case) where the vendor's official
 * pricing page differs from OpenCode's upstream catalog feed (e.g. a model that ceased to be free).
 * `cacheWrite: 0` is an assumption: https://ollama.com/pricing lists only input, cached input and output
 * (no cache-write rate).
 */
export const OPENCODE_PRICE_OVERRIDES = Object.freeze({
  'ollama-cloud/beam': Object.freeze({ input: 0.125, output: 0.4, cacheRead: 0.015, cacheWrite: 0, source: PRICING_SOURCES.ollama, verified: PRICING_VERIFIED }),
  'ollama-cloud/mistral-large-4': Object.freeze({ input: 0.7, output: 2.1, cacheRead: 0.07, cacheWrite: 0, source: PRICING_SOURCES.ollama, verified: PRICING_VERIFIED }),
});

/** Verified override for an OpenCode `provider/model` entry, or null when the upstream catalog stands as-is. */
export function opencodePriceOverride(providerId, modelId) {
  const pid = String(providerId || '').trim().toLowerCase();
  const mid = String(modelId || '').trim().toLowerCase();
  if (!pid || !mid) return null;
  const key = mid.startsWith(`${pid}/`) ? mid : `${pid}/${mid}`;
  return OPENCODE_PRICE_OVERRIDES[key] || null;
}

/** Return an OpenCode model's cost object with any verified vendor override applied (never mutates `cost`). */
export function applyOpencodeCostOverride(providerId, modelId, cost) {
  const override = opencodePriceOverride(providerId, modelId);
  if (!override) return cost;
  const base = cost && typeof cost === 'object' ? cost : {};
  const cache = base.cache && typeof base.cache === 'object'
    ? { ...base.cache, read: override.cacheRead, write: override.cacheWrite }
    : { read: override.cacheRead, write: override.cacheWrite };
  return { ...base, input: override.input, output: override.output, cache };
}

const TABLES = Object.freeze({ anthropic: ANTHROPIC, openai: OPENAI });
const VENDOR = Object.freeze({ 'claude-code': 'anthropic', claude: 'anthropic', anthropic: 'anthropic', codex: 'openai', openai: 'openai' });

/** The id a price is filed under: lower case, no "[1m]" / "[extended]", no "provider/" prefix, no -YYYYMMDD snapshot date. */
export function priceModelId(model) {
  return String(model || '').trim().toLowerCase().replace(/\[[^\]]*\]$/, '').replace(/^.*\//, '').replace(/-\d{8}$/, '');
}

/**
 * The list price of a model, or null when the table has none.
 * @param {string} provider 'claude-code' | 'codex' (or the vendor: 'anthropic' | 'openai')
 * @param {string} model any spelling the providers use ("claude-opus-5-5[1m]", "gpt-6-sol[extended]", "claude-haiku-4-5-20251001")
 * @returns {{ input:number, output:number, cacheRead:number, cacheWrite:number, cacheWrite1h:number|null,
 *   long:{ size:number, input:number, output:number, cacheRead:number, cacheWrite:number }|null,
 *   unit:'usd_per_mtok', vendor:string, model:string, source:string, verified:string }|null}
 */
export function listPrice(provider, model) {
  const vendor = VENDOR[String(provider || '').toLowerCase()];
  const id = priceModelId(model);
  const row = vendor && id ? TABLES[vendor][id] : null;
  return row ? { ...row, unit: 'usd_per_mtok', vendor, model: id, source: PRICING_SOURCES[vendor], verified: PRICING_VERIFIED } : null;
}

const count = (value) => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : 0; };

/**
 * Five token classes ({ input, cacheWrite, cacheRead, output, reasoning }) at a price, in USD.
 * `cacheWrite` '1h' prices cache writes at the 1-hour rate (falls back to the 5-minute one);
 * `long` uses the long-context rates when the price has them. null without a price.
 */
export function tokensCostUsd(price, tokens, { cacheWrite = '5m', long = false } = {}) {
  if (!price || !tokens || typeof tokens !== 'object') return null;
  const r = long && price.long ? price.long : price;
  const write = cacheWrite === '1h' && r.cacheWrite1h != null ? r.cacheWrite1h : (r.cacheWrite ?? r.input);
  const usd = (count(tokens.input) * r.input + count(tokens.cacheWrite) * write + count(tokens.cacheRead) * (r.cacheRead ?? r.input)
    + (count(tokens.output) + count(tokens.reasoning)) * r.output) / 1e6;
  return Number(usd.toFixed(8));
}

/** Five token classes on a Claude model at list price; cache writes at the 1-hour rate unless told otherwise. null when the model has no price. */
export function claudeTokensCostUsd(model, tokens, { cacheWrite = '1h' } = {}) {
  return tokensCostUsd(listPrice('claude-code', model), tokens, { cacheWrite });
}

/**
 * A raw Anthropic usage object at list price. With usage.cache_creation
 * ({ ephemeral_5m_input_tokens, ephemeral_1h_input_tokens }) each write is priced at its own
 * rate; without it every write is taken as a 5-minute one. null when the model has no price.
 */
export function claudeUsageCostUsd(model, usage) {
  const price = listPrice('claude-code', model);
  if (!price || !usage || typeof usage !== 'object') return null;
  const split = usage.cache_creation && typeof usage.cache_creation === 'object' ? usage.cache_creation : null;
  const written = count(usage.cache_creation_input_tokens);
  const oneHour = split ? Math.min(written || Infinity, count(split.ephemeral_1h_input_tokens)) : 0;
  const fiveMin = split ? Math.max(count(split.ephemeral_5m_input_tokens), written - oneHour) : written;
  const usd = (count(usage.input_tokens) * price.input + fiveMin * price.cacheWrite + oneHour * price.cacheWrite1h
    + count(usage.cache_read_input_tokens) * price.cacheRead + count(usage.output_tokens) * price.output) / 1e6;
  return Number(usd.toFixed(8));
}

/** Claude prices in the older array form { [id]: [input, output, cacheWrite5m, cacheRead] }, dated aliases included. */
export function claudeLegacyPricing() {
  const out = {};
  for (const [id, row] of Object.entries(ANTHROPIC)) out[id] = [row.input, row.output, row.cacheWrite, row.cacheRead];
  // Snapshot ids the CLI and old transcripts name.
  out['claude-haiku-4-5-20251001'] = out['claude-haiku-4-5'];
  out['claude-3-5-sonnet-20241022'] = out['claude-3-5-sonnet'];
  out['claude-3-5-haiku-20241022'] = out['claude-3-5-haiku'];
  return out;
}

/** Every priced model, for the docs, the Budget tab and the tests: [{ vendor, model, input, output, cacheRead, cacheWrite, cacheWrite1h, long, source, verified }]. */
export function pricingRows() {
  const rows = [];
  for (const [vendor, table] of Object.entries(TABLES)) {
    for (const [model, row] of Object.entries(table)) rows.push({ vendor, model, ...row, source: PRICING_SOURCES[vendor], verified: PRICING_VERIFIED });
  }
  return rows;
}
