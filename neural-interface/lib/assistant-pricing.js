// ═══════════════════════════════════════════
// SynaBun — Assistant list prices (one table)
// ═══════════════════════════════════════════
//
// The only place a model's list price is written. The model catalog (routing
// sheet, agent_catalog, the pickers), the usage ledger (Codex tokens, Claude
// estimates), the budget caps and the side panel's cost scanner all read it.
//
// Sources, read 2026-10-01:
//   Anthropic  https://platform.claude.com/docs/en/about-claude/pricing
//   OpenAI     https://developers.openai.com/api/docs/pricing
//              (gpt-6-sol: https://developers.openai.com/api/docs/models/gpt-6-sol)
//
// $ per million tokens, one rate per token class:
//   input         uncached input
//   cacheRead     a cache hit ("cached input")
//   cacheWrite    a cache write (Anthropic: the 5-minute cache, 1.25x input)
//   cacheWrite1h  Anthropic's 1-hour cache write (2x input). The Claude CLI writes most of
//                 its cache at this rate, so an estimate of its usage prices writes with it.
//   output        output, reasoning / thinking included
//   long          OpenAI only: a request whose prompt is over `size` input tokens is priced at
//                 these rates for the whole request (2x input and cache, 1.5x output).
//                 Anthropic prices the full 1M window at the standard rate (Claude 4.6 and later).
//
// What is billed is the provider's business: Claude Code and Codex usually run on a plan, where
// these dollars are the list-price equivalent of the tokens, not a charge.
//
// Pure: no I/O, no dependencies.

export const PRICING_VERIFIED = '2026-10-01';
export const PRICING_SOURCES = Object.freeze({
  anthropic: 'https://platform.claude.com/docs/en/about-claude/pricing',
  openai: 'https://developers.openai.com/api/docs/pricing',
});
/** OpenAI's long-context boundary: a prompt over this many input tokens is priced at the long rates. */
export const LONG_PROMPT_TOKENS = 272_000;

const round = (value) => Number(Number(value).toFixed(6));

/** Anthropic: cache writes are 1.25x (5 minutes) and 2x (1 hour) the input rate; cache reads are per model. */
function claude(input, output, cacheRead) {
  return Object.freeze({ input, output, cacheRead, cacheWrite: round(input * 1.25), cacheWrite1h: round(input * 2), long: null });
}
/** OpenAI: cache writes are 1.25x input; over 272K prompt tokens input and cache rates double and output is 1.5x. */
function openai(input, output, cacheRead) {
  const cacheWrite = round(input * 1.25);
  return Object.freeze({
    input, output, cacheRead, cacheWrite, cacheWrite1h: null,
    long: Object.freeze({ size: LONG_PROMPT_TOKENS, input: round(input * 2), output: round(output * 1.5), cacheRead: round(cacheRead * 2), cacheWrite: round(cacheWrite * 2) }),
  });
}

const ANTHROPIC = Object.freeze({
  'claude-fable-5-1': claude(10, 50, 0.25), // cache reads 0.025x
  'claude-fable-5': claude(10, 50, 1),
  'claude-opus-5-5': claude(4, 20, 0.2), // cache reads 0.05x
  'claude-opus-5': claude(5, 25, 0.5),
  'claude-opus-4-8': claude(5, 25, 0.5),
  'claude-opus-4-7': claude(5, 25, 0.5),
  'claude-opus-4-6': claude(5, 25, 0.5),
  'claude-opus-4-5': claude(5, 25, 0.5),
  'claude-sonnet-5-5': claude(2, 10, 0.2),
  // $2 / $10 was introductory until 2026-08-31 and is the standard price now (the $3 / $15 increase was cancelled).
  'claude-sonnet-5': claude(2, 10, 0.2),
  'claude-sonnet-4-6': claude(3, 15, 0.3),
  'claude-sonnet-4-5': claude(3, 15, 0.3),
  'claude-haiku-4-5': claude(1, 5, 0.1),
  // Retired models, at their last published price (old sessions are still priced).
  'claude-3-5-sonnet': claude(3, 15, 0.3),
  'claude-3-5-haiku': claude(0.8, 4, 0.08),
});

const OPENAI = Object.freeze({
  'gpt-6-astra': openai(10, 50, 1),
  'gpt-6.1-sol': openai(2, 10, 0.1),
  'gpt-6-sol': openai(2, 10, 0.2),
  'gpt-6-luna': openai(0.1, 0.5, 0.01),
});

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
