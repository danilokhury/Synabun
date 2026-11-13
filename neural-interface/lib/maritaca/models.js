// ═══════════════════════════════════════════
// SynaBun — Maritaca AI: the Sabiá model table (pure)
// ═══════════════════════════════════════════
//
// What Maritaca's documentation says about each model, read 2026-11-06 and again 2026-11-08:
//   https://docs.maritaca.ai/pt/modelos    (ids, aliases, context, max output, capabilities)
//   https://docs.maritaca.ai/pt/precos     (BRL per million tokens: input, output, cached input)
//   https://docs.maritaca.ai/pt/raciocinio (reasoning_effort: none · minimal = low · medium · high = xhigh = max; default xhigh)
// 2026-11-08: the S5 family's output went to 64K, S5 Nano (open weights, 256K context) joined the list, and the
// reasoning levels are offered as Off / Low / Medium / High (`high` is the API's `xhigh`, its default). The S5 rows'
// reasoning is encrypted (never streamed as text); only S5 Nano's arrives as text (`reasoningVisible`).
// Prices are in Brazilian reais (unit 'brl_per_mtok'), never converted: the Assistant's USD
// price table (lib/assistant-pricing.js) is for the dispatch providers and stays untouched.
// Maritaca is a chat API, not a coding agent: it is a sidepanel provider and a chat-only
// entry of the catalog, never a worker or a brain (docs/maritaca-sidepanel.md).
//
// Sampling (`fixedSampling`, read by client.js `maritacaFixedSampling`): the docs give one default for every model
// (https://docs.maritaca.ai/api/pt/completion: temperature 0.7, top_p 0.95) and no per-model rule, so it was probed
// live on 2026-11-06 with max_tokens 5: S5-free refused temperature 0.3 ("Only the default (1)"), top_p 0.5 ("Only the
// default (0.95)") and temperature with reasoning_effort none; sabia-4-thinking, sabia-4-thinking-br-sp and sabiazinho-4
// answered 200 to both. So the S5 family takes only its defaults and Sabiá 4 Thinking samples freely, though it reasons.
//
// The API's own model list (GET /models, when it answers) is merged over this table by
// client.js `listModels`: a model the API lists and this table does not know is offered with
// what the API said and `known: false`; a model here the API no longer lists is kept, marked
// `listed: false`, so a saved default still resolves.

export const MARITACA_PRICING_VERIFIED = '2026-11-08';
export const MARITACA_PRICING_SOURCE = 'https://docs.maritaca.ai/pt/precos';
export const MARITACA_MODELS_SOURCE = 'https://docs.maritaca.ai/pt/modelos';
export const MARITACA_DEFAULT_MODEL = 'sabiazinho-4';
/** The reasoning levels SynaBun offers, in order (docs → Raciocínio): `none` turns reasoning off; `high` is the API's default. */
export const MARITACA_REASONING_EFFORTS = Object.freeze(['none', 'low', 'medium', 'high']);
/** The other spellings the API takes for the same levels: `minimal` is `low`; `xhigh` and `max` are `high`. */
export const MARITACA_EFFORT_ALIASES = Object.freeze({ minimal: 'low', xhigh: 'high', max: 'high' });

/** A level as written (a saved setting, an older page, an alias) → the level SynaBun sends, or null for "the model's default". */
export function normalizeMaritacaEffort(value) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!v) return null;
  if (MARITACA_REASONING_EFFORTS.includes(v)) return v;
  return MARITACA_EFFORT_ALIASES[v] || null;
}

const price = (input, output, cacheRead) => Object.freeze({ input, output, cacheRead, unit: 'brl_per_mtok', basis: 'list' });
const FREE = Object.freeze({ input: 0, output: 0, cacheRead: 0, unit: 'brl_per_mtok', basis: 'free' });
const ONE_M = 1_000_000;
const K128 = 128_000;
const K256 = 256_000;
const K64 = 64_000;

/** Every model in the order the pickers show them. `aliases` are the other spellings the API accepts. */
export const MARITACA_MODELS = Object.freeze([
  {
    id: 'S5', label: 'Sabiá 5 (S5)', family: 's5', aliases: ['s5'],
    tier: 'large', contextWindow: ONE_M, maxOutput: K64, reasoning: true, fixedSampling: true, efforts: MARITACA_REASONING_EFFORTS, defaultEffort: 'high',
    toolcall: true, vision: false, price: price(0.5, 2.5, 0.05), region: 'global',
    description: 'Native reasoning with adjustable intensity, 1M context, the cheapest of the family.',
  },
  {
    id: 'S5-br-sp', label: 'Sabiá 5 BR-SP', family: 's5', aliases: ['s5-br-sp'],
    tier: 'large', contextWindow: ONE_M, maxOutput: K64, reasoning: true, fixedSampling: true, efforts: MARITACA_REASONING_EFFORTS, defaultEffort: 'high',
    toolcall: true, vision: false, price: price(0.65, 3.25, 0.065), region: 'br-sp',
    description: 'S5 with inference 100% in Brazil (data residency), 30% over S5.',
  },
  {
    id: 'S5-free', label: 'S5 (free)', family: 's5', aliases: ['s5-free'],
    tier: 'large', contextWindow: ONE_M, maxOutput: K64, reasoning: true, fixedSampling: true, efforts: MARITACA_REASONING_EFFORTS, defaultEffort: 'high',
    toolcall: false, vision: false, batch: false, flex: false, price: FREE, region: 'global', free: true,
    // docs → Rate Limits: the free model has fixed limits whatever the plan (no batch / flex rates either).
    rateLimit: Object.freeze({ requestsPerMinute: 60, tokensPerMinuteIn: 256_000, tokensPerMinuteOut: 256_000 }),
    description: 'S5 free for a limited time (launch offer): text only, no tool calling, no batch or flex; fixed 60 requests and 256k tokens per minute in and out.',
  },
  {
    id: 'S5-nano', label: 'Sabiá 5 Nano (S5 Nano)', family: 's5', aliases: ['s5-nano'],
    tier: 'small', contextWindow: K256, maxOutput: 32_000, reasoning: true, fixedSampling: true, efforts: MARITACA_REASONING_EFFORTS, defaultEffort: 'high',
    toolcall: true, vision: false, price: price(0.1, 0.6, 0.01), region: 'global',
    // Open weights: its reasoning comes back as text (`reasoning_content`); the other S5 rows' is encrypted and never shown.
    reasoningVisible: true,
    description: 'Compact S5 with open weights: the same native reasoning (returned as text), 256K context, the cheapest of the family.',
  },
  {
    id: 'sabia-4-thinking', label: 'Sabiá 4 Thinking', family: 'sabia-4', aliases: [],
    tier: 'large', contextWindow: ONE_M, maxOutput: 32_000, reasoning: true, fixedSampling: false, efforts: [], defaultEffort: null,
    toolcall: true, vision: false, price: price(5, 40, 1.25), region: 'global',
    description: 'Reasoning model: explicit thinking before the answer, 1M context.',
  },
  {
    id: 'sabia-4-thinking-br-sp', label: 'Sabiá 4 Thinking BR-SP', family: 'sabia-4', aliases: [],
    tier: 'large', contextWindow: ONE_M, maxOutput: 32_000, reasoning: true, fixedSampling: false, efforts: [], defaultEffort: null,
    toolcall: true, vision: false, price: price(6.5, 52, 1.63), region: 'br-sp',
    description: 'Sabiá 4 Thinking with inference 100% in Brazil, 30% over the global model.',
  },
  {
    id: 'sabia-4', label: 'Sabiá 4', family: 'sabia-4', aliases: ['sabia-4-2026-01-06'],
    tier: 'medium', contextWindow: K128, maxOutput: 32_000, reasoning: false, efforts: [], defaultEffort: null,
    toolcall: true, vision: false, price: price(5, 20, 1.25), region: 'global',
    description: 'General model with agentic capability and Brazilian context.',
  },
  {
    id: 'sabia-4-br-sp', label: 'Sabiá 4 BR-SP', family: 'sabia-4', aliases: [],
    tier: 'medium', contextWindow: K128, maxOutput: 32_000, reasoning: false, efforts: [], defaultEffort: null,
    toolcall: true, vision: false, price: price(6.5, 26, 1.63), region: 'br-sp',
    description: 'Sabiá 4 with inference 100% in Brazil, 30% over the global model.',
  },
  {
    id: 'sabiazinho-4', label: 'Sabiazinho 4', family: 'sabiazinho-4', aliases: ['sabiazinho-4-2026-01-06', 'sabia-4-small', 'sabiazim-4'],
    tier: 'small', contextWindow: K128, maxOutput: 32_000, reasoning: false, efforts: [], defaultEffort: null,
    toolcall: true, vision: false, price: price(1, 4, 0.25), region: 'global',
    description: 'Fast and cheap, for large-scale applications and quick agentic flows.',
  },
  {
    id: 'sabiazinho-4-br-sp', label: 'Sabiazinho 4 BR-SP', family: 'sabiazinho-4', aliases: [],
    tier: 'small', contextWindow: K128, maxOutput: 32_000, reasoning: false, efforts: [], defaultEffort: null,
    toolcall: true, vision: false, price: price(1.3, 5.2, 0.33), region: 'br-sp',
    description: 'Sabiazinho 4 with inference 100% in Brazil, 30% over the global model.',
  },
]);

/**
 * Models Maritaca retired (docs → Modelos descontinuados, 2026-11-06: sabia-3 and sabiazinho-3 are gone from the
 * catalog). They are not in the table; a saved default or a stored conversation that still names one resolves to
 * the nearest current model (sabia-3 → sabia-4, sabiazinho-3 → sabiazinho-4, Sabiá 2 → sabiazinho-4) and never fails.
 */
export const MARITACA_RETIRED = Object.freeze({
  'sabia-2-medium': 'sabiazinho-4',
  'sabia-2-small': 'sabiazinho-4',
  'sabia-3': 'sabia-4',
  'sabia-3-2024-07-15': 'sabia-4',
  'sabia-3-2024-09-09': 'sabia-4',
  'sabiazinho-3': 'sabiazinho-4',
  'sabiazinho-3-2024-11-13': 'sabiazinho-4',
});

const byKey = new Map();
for (const model of MARITACA_MODELS) {
  byKey.set(model.id.toLowerCase(), model);
  for (const alias of model.aliases) byKey.set(alias.toLowerCase(), model);
}

/** The table row an id or alias names (case-insensitive), a retired id's replacement, else null. */
export function findMaritacaModel(id) {
  const key = String(id || '').trim().toLowerCase();
  if (!key) return null;
  const direct = byKey.get(key);
  if (direct) return direct;
  const replacement = MARITACA_RETIRED[key];
  return replacement ? byKey.get(replacement) || null : null;
}

/** The canonical id of a model spelling (its table id), or the spelling itself trimmed when unknown. */
export function canonicalMaritacaModelId(id) {
  const row = findMaritacaModel(id);
  return row ? row.id : String(id || '').trim();
}

/** BRL cost of a usage object ({ prompt_tokens, completion_tokens, prompt_tokens_details?.cached_tokens }) at list price; null without a price. */
export function maritacaUsageCostBrl(model, usage) {
  const row = findMaritacaModel(model);
  if (!row?.price || !usage || typeof usage !== 'object') return null;
  const n = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : 0; };
  const cached = n(usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens);
  const input = Math.max(0, n(usage.prompt_tokens) - cached);
  const output = n(usage.completion_tokens);
  const brl = (input * row.price.input + cached * (row.price.cacheRead ?? row.price.input) + output * row.price.output) / 1e6;
  return Number(brl.toFixed(8));
}

/** The shape a picker or the catalog reads: a plain object per model (no frozen nested arrays leak). */
export function maritacaModelRows() {
  return MARITACA_MODELS.map((m) => ({
    id: m.id, label: m.label, family: m.family, aliases: [...m.aliases], tier: m.tier,
    contextWindow: m.contextWindow, maxOutput: m.maxOutput, reasoning: m.reasoning, fixedSampling: m.fixedSampling === true,
    efforts: [...m.efforts], defaultEffort: m.defaultEffort, toolcall: m.toolcall, vision: m.vision,
    price: { ...m.price }, region: m.region, free: m.free === true, description: m.description,
    // Whether the reasoning arrives as text: S5 Nano and Sabiá 4 Thinking yes; S5, S5 BR-SP and S5 Free keep it encrypted.
    reasoningVisible: m.reasoningVisible === true || (m.reasoning === true && m.family !== 's5'),
    batch: m.batch !== false, flex: m.flex !== false, rateLimit: m.rateLimit ? { ...m.rateLimit } : null,
    isDefault: m.id === MARITACA_DEFAULT_MODEL, known: true, listed: true,
  }));
}
