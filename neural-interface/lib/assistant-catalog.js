import { EXTERNAL_SERVER_LIMITATIONS, externalDiscoveryError } from './mcp-external-servers.js';
import { toolCatalogView } from '../../mcp-server/dist/services/tool-catalog.js';
// ═══════════════════════════════════════════
// SynaBun — Assistant model catalog (providers · models · tier · price · vision)
// ═══════════════════════════════════════════
//
// One normalized view of every model the assistant can route to: Claude Code
// (CLI model list), Codex (app-server model/list), OpenCode (the shared
// serve's /provider, connected providers only) and Antigravity (what an ACP
// session of its own CLI offers; a brain and a worker, unpriced). Claude and Codex rows are
// priced from the one list-price table (assistant-pricing.js), the same one
// the usage ledger prices tokens with; OpenCode rows carry the price the serve
// reports. A Codex row keeps `price: null` (plan billing: routing treats it as
// having no price of its own) and shows the list-price equivalent in
// `listPrice`. Each row carries a
// tier guess, list price, vision capability, what it generates besides text
// (`outputs`: image / video) and context window so the brain (the dsh-style
// planner) and the router can pick cheap-first, send image work to a model that
// can see, and image / video creation to a model that makes them. Everything
// I/O is injected; parsers are pure.
//
// Which models exist is never decided here. Each provider's rows are the list
// its own model selector reads (/api/claude/models, /api/codex/models,
// /api/opencode/providers/full, /api/antigravity/models); the static tables (prices, tier hints, the 1M
// rule) only describe a row. A model the provider lists and no table knows is
// offered with what is unknown left unknown; a model only a table knows is
// never offered. `sources` says how each provider's list was obtained.

import { sortEfforts, variantNames } from './effort-levels.js';
import { listPrice } from './assistant-pricing.js';

export const CATALOG_PROVIDERS = ['claude-code', 'codex', 'opencode', 'antigravity'];
/**
 * Chat-only providers: a side panel of their own and a `chat` section of the catalog, never a worker or a brain
 * (nothing dispatches to them, the router never picks them). Maritaca AI (lib/maritaca/*) is a plain chat API:
 * its rows carry prices in BRL (`price.unit` 'brl_per_mtok') and are listed for the record, `chat: true`.
 */
export const CHAT_PROVIDERS = Object.freeze(['maritaca']);
/** The providers an Assistant brain can run on (every provider of the catalog: each is a worker too). */
export const BRAIN_PROVIDERS = Object.freeze(['claude-code', 'codex', 'opencode', 'antigravity']);
export const TIERS = ['small', 'medium', 'large'];
/** The thinking levels Antigravity accepts, for a model whose row names none of its own. */
export const ANTIGRAVITY_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

const SMALL_HINTS = /(haiku|mini|nano|flash|lite|luna|small|tiny|\bair\b|[:\-_ ](1|2|3|4|7|8|9|12|14|20|24|27|30|32)b\b)/i;
const LARGE_HINTS = /(opus|fable|astra|ultra|\bpro\b|-pro\b|large|[:\-_ ](1\d\d|[2-9]\d\d)b\b|-sol\b)/i;
const MEDIUM_HINTS = /(sonnet|terra|medium|balanced)/i;
const CODEX_HIDDEN = /computer[-_ ]?use/i;
// Codex's built-in image_generation tool (`codex exec` saves each image under
// <CODEX_HOME>/generated_images/<thread>/): every GPT agent model can call it.
const CODEX_IMAGE_TOOL = /^gpt-/i;
export const MEDIA_KINDS = Object.freeze(['image', 'video']);

function num(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function arr(value) { return Array.isArray(value) ? value : []; }
function stripOneM(id) { return String(id || '').replace(/\[1m\]$/i, ''); }

// ── context-window variants ──────────────────────────────────────────────────
// A model offered at two context windows is two rows, and each hides on its
// own: Claude Code marks the 1M window with the CLI's "[1m]" suffix
// ("opus[1m]"), Codex's opt-in extended window is "<id>[extended]" (the Codex
// brain sends it as contextMode "extended", a dispatched worker as
// model_context_window).
const CONTEXT_SUFFIX = /\[(1m|extended)\]$/i;
export const ONE_M_CONTEXT = 1_000_000;

/** '1m' | 'extended' | null. */
export function contextVariantOf(id) {
  const m = String(id || '').match(CONTEXT_SUFFIX);
  return m ? m[1].toLowerCase() : null;
}
/** "[1m]" / "[extended]" / "". */
export function contextSuffix(id) { const v = contextVariantOf(id); return v ? `[${v}]` : ''; }
/** The id without its context suffix. */
export function baseModelId(id) { return String(id || '').replace(CONTEXT_SUFFIX, ''); }

/** Claude's legacy "<id>:<window>" selector → "<id>[1m]" / "<id>" (server.js toCliModelName). */
export function canonicalModelId(provider, id) {
  const raw = String(id || '').trim();
  const m = provider === 'claude-code' ? raw.match(/^([^:]+):(\d+)$/) : null;
  if (!m) return raw;
  return Number(m[2]) > 200000 ? `${m[1]}[1m]` : m[1];
}

/** Does this Claude model run at 1M? Opus 4.6+, Sonnet 4+, Fable; not Haiku or older Opus. */
export function claudeSupportsOneMillion(model) {
  const m = String(model || '').toLowerCase();
  if (!/(opus|sonnet|fable)/.test(m)) return false;
  return !/(haiku|claude-3|opus-4-[0-5](?:-|$)|opus-4-\d{8}|opus-4$)/.test(m);
}

/** "200k", "1M", "extended 872k": the window a row runs at ('' when unknown). */
export function contextLabel(row) {
  const ctx = num(row?.contextWindow);
  const size = !ctx ? '' : ctx >= 1_000_000 ? `${Math.round(ctx / 100_000) / 10}M`.replace('.0M', 'M') : `${Math.round(ctx / 1000)}k`;
  return contextVariantOf(row?.id) === 'extended' ? `extended${size ? ` ${size}` : ''}` : size;
}

/** The id an alias row runs as, context included ("opus[1m]" → "claude-opus-5-5[1m]"), lower-case. */
function resolvedKey(row) {
  if (!row?.upstream) return null;
  return `${baseModelId(row.upstream)}${contextSuffix(row.id)}`.toLowerCase();
}

// ── moving aliases ───────────────────────────────────────────────────────────
// "opus", "haiku", "default" name whatever model Claude Code points them at, and
// that changes with a CLI update. A hidden alias is pinned to the model it named
// when it was hidden (lib/assistant-hidden-models.js); these say what a row names.

/** A model id without its snapshot date ("claude-haiku-4-5-20251001", "…@20251001"), lower-case: what makes two ids one model. */
export function modelIdentity(id) {
  return baseModelId(id).trim().toLowerCase().replace(/[-@]\d{8}$/, '');
}

/**
 * What a moving alias row names right now: { model, variant } ("opus[1m]" →
 * { model: 'claude-opus-5-5', variant: '1m' }), lower-case. null for a row that
 * is its own model (a concrete id, every Codex row), for OpenCode (its
 * `upstream` is the provider, not a model) and whenever the provider did not
 * name a versioned model behind the alias (the static stand-in list, an alias
 * resolving to another alias): nothing is guessed.
 */
export function aliasTargetOf(row) {
  if (!row?.id || row.provider === 'opencode' || String(row.id).includes('/')) return null;
  const model = baseModelId(row.upstream || '').trim().toLowerCase();
  if (!model || !/\d/.test(model) || modelIdentity(model) === modelIdentity(row.id)) return null;
  return { model, variant: contextVariantOf(row.id) };
}

/** The id of the model a pin or an alias target names, context included ("claude-opus-5-5[1m]"), lower-case. */
export function pinnedModelId(pin) {
  const model = baseModelId(pin?.model || '').trim().toLowerCase();
  return model ? `${model}${pin.variant ? `[${String(pin.variant).toLowerCase()}]` : ''}` : '';
}

/** Do a pin and an alias target name the same model at the same context window? (A new snapshot date is the same model.) */
export function sameModelPin(a, b) {
  return !!a && !!b && !!modelIdentity(a.model) && modelIdentity(a.model) === modelIdentity(b.model)
    && String(a.variant || '').toLowerCase() === String(b.variant || '').toLowerCase();
}

/**
 * Every Claude row that can run at 1M gets a "[1m]" sibling right after it,
 * unless the CLI already lists one: the CLI accepts "<id>[1m]" for those
 * models even when its list leaves it out. `default` has no 1M form.
 */
export function withClaudeContextVariants(rows) {
  const list = arr(rows);
  const ids = new Set(list.map((row) => String(row.id).toLowerCase()));
  const out = [];
  for (const row of list) {
    out.push(row);
    if (row.id === 'default' || contextVariantOf(row.id) || !claudeSupportsOneMillion(row.upstream || row.id)) continue;
    const id = `${row.id}[1m]`;
    if (ids.has(id.toLowerCase())) continue;
    ids.add(id.toLowerCase());
    const label = /1m context/i.test(row.label) ? row.label : `${row.label} (1M context)`;
    out.push({ ...row, id, label, contextWindow: ONE_M_CONTEXT, isDefault: false, derived: true });
  }
  return out;
}

/** Tier guess: name hints first, then output-price bands. */
export function guessTier(row = {}) {
  // "Gemini" holds the small hint "mini": the family's name says nothing of its size (gemini-2.5-pro is not small).
  const name = `${row.id || ''} ${row.label || ''} ${row.upstream || ''}`.replace(/gemini/gi, ' ');
  if (SMALL_HINTS.test(name)) return 'small';
  if (LARGE_HINTS.test(name)) return 'large';
  if (MEDIUM_HINTS.test(name)) return 'medium';
  const out = num(row.price?.output);
  if (out === null || out <= 0) return 'medium';
  if (out <= 1.5) return 'small';
  if (out <= 8) return 'medium';
  return 'large';
}

function priceFrom(cost) {
  if (!cost || typeof cost !== 'object') return null;
  const input = num(cost.input);
  const output = num(cost.output);
  if (input === null && output === null) return null;
  const cacheRead = num(cost.cache?.read ?? cost.cache_read ?? cost.cacheRead);
  const basis = (input || 0) > 0 || (output || 0) > 0 ? 'list' : 'free';
  return { input: input ?? 0, output: output ?? 0, cacheRead, unit: 'usd_per_mtok', basis };
}

function unwrapOpenCode(data) {
  if (!data || typeof data !== 'object') return { all: [], connected: null, defaults: {} };
  const body = data.data && typeof data.data === 'object' && !Array.isArray(data.data) && (data.data.all || data.data.connected) ? data.data : data;
  const all = Array.isArray(body.all) ? body.all : (body.all && typeof body.all === 'object' ? Object.values(body.all) : []);
  // An explicit `connected` list (even an empty one) decides; null = none given, every listed provider counts.
  const connected = Array.isArray(body.connected) ? body.connected.map(String) : null;
  return { all, connected, defaults: body.default && typeof body.default === 'object' ? body.default : {} };
}

/**
 * What an OpenCode model generates: v2 capabilities.output.{image,video}, else
 * v1 models.dev modalities.output, else unknown (null). Only `true` qualifies a
 * model for image / video creation.
 */
function openCodeOutputs(model = {}) {
  const output = model.capabilities?.output;
  if (output && typeof output === 'object') {
    const flag = (value) => (typeof value === 'boolean' ? value : null);
    return { outputs: { image: flag(output.image), video: flag(output.video) }, outputsSource: 'catalog' };
  }
  if (Array.isArray(model.modalities?.output)) {
    const list = model.modalities.output.map((m) => String(m).toLowerCase());
    return { outputs: { image: list.includes('image'), video: list.includes('video') }, outputsSource: 'catalog' };
  }
  return { outputs: { image: null, video: null }, outputsSource: 'unknown' };
}

/** Does this catalog row generate `medium` ('image' | 'video')? Only a confirmed `true` counts. */
export function rowMakes(row, medium) {
  return !!row && MEDIA_KINDS.includes(medium) && row.outputs?.[medium] === true;
}

function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * OpenCode /provider → rows for connected providers only (223 known providers,
 * a handful connected). Accepts the v2 shape (capabilities.input.image,
 * cost, limit.context, variants) and the v1 models.dev shape (modalities).
 * `filter` = optional list of globs over "providerID/modelID".
 */
export function parseOpenCodeProviders(data, { filter = null } = {}) {
  const { all, connected, defaults } = unwrapOpenCode(data);
  const connectedSet = connected ? new Set(connected) : null;
  const globs = Array.isArray(filter) && filter.length ? filter.map(globToRegExp) : null;
  const rows = [];
  for (const provider of all) {
    const pid = provider?.id || provider?.providerID;
    if (!pid || (connectedSet && !connectedSet.has(pid))) continue;
    const models = Array.isArray(provider.models)
      ? provider.models
      : Object.entries(provider.models || {}).map(([id, value]) => ({ id, ...(value && typeof value === 'object' ? value : {}) }));
    for (const model of models) {
      const mid = model?.id || model?.modelID;
      if (!mid) continue;
      const id = `${pid}/${mid}`;
      if (globs && !globs.some((re) => re.test(id))) continue;
      const caps = model.capabilities || {};
      let vision = null;
      let visionSource = 'catalog';
      if (caps.input && typeof caps.input === 'object' && typeof caps.input.image === 'boolean') vision = caps.input.image;
      else if (Array.isArray(model.modalities?.input)) vision = model.modalities.input.includes('image');
      else if (typeof model.attachment === 'boolean' || typeof caps.attachment === 'boolean') { vision = !!(model.attachment ?? caps.attachment); visionSource = 'guess'; }
      const price = priceFrom(model.cost);
      const row = {
        provider: 'opencode', id, upstream: pid, label: model.name || mid, family: model.family || null,
        vision, visionSource,
        ...openCodeOutputs(model),
        reasoning: typeof caps.reasoning === 'boolean' ? caps.reasoning : (typeof model.reasoning === 'boolean' ? model.reasoning : null),
        toolcall: typeof caps.toolcall === 'boolean' ? caps.toolcall : (typeof model.tool_call === 'boolean' ? model.tool_call : null),
        contextWindow: num(model.limit?.context),
        price,
        efforts: sortEfforts(variantNames(model.variants)),
        defaultEffort: null,
        isDefault: defaults[pid] === mid,
        status: model.status || null,
      };
      row.tier = guessTier(row);
      rows.push(row);
    }
  }
  return rows;
}

/** The catalog's price object for a list-price table row. */
function tablePrice(row, basis) {
  return row ? { input: row.input, output: row.output, cacheRead: row.cacheRead ?? null, unit: 'usd_per_mtok', basis } : null;
}

/**
 * Claude CLI model list → rows priced from the list-price table (assistant-pricing.js).
 * `pricing` (tests, older callers) replaces the table: { [id]: [in, out, cacheWrite, cacheRead] } in $/MTok.
 */
export function normalizeClaudeRows(rows, { pricing = null } = {}) {
  return arr(rows).map((m) => (typeof m === 'string' ? { id: m, label: m } : m)).filter((m) => m?.id).map((m) => {
    const resolved = stripOneM(m.resolvedModel || m.id);
    const p = pricing ? (pricing[resolved] || pricing[stripOneM(m.id)] || null) : null;
    const listed = pricing ? null : tablePrice(listPrice('claude-code', resolved) || listPrice('claude-code', m.id), 'list');
    const row = {
      provider: 'claude-code', id: String(m.id), upstream: resolved, label: m.label || m.id, family: resolved.replace(/-\d.*$/, '') || null,
      vision: true, visionSource: 'provider', reasoning: true, toolcall: true,
      // Claude reads images but generates neither images nor video.
      outputs: { image: false, video: false }, outputsSource: 'provider',
      contextWindow: num(m.contextWindow),
      price: Array.isArray(p) ? { input: p[0], output: p[1], cacheRead: p[3] ?? null, unit: 'usd_per_mtok', basis: 'list' } : listed,
      efforts: sortEfforts(arr(m.effortLevels)), defaultEffort: null,
      isDefault: m.id === 'default' || m.tier === 'default',
      status: m.cliReady === false ? 'unavailable' : 'active',
    };
    row.tier = guessTier({ ...row, label: `${row.label} ${resolved}` });
    return row;
  });
}

/**
 * Codex app-server model/list → rows. Codex bills the ChatGPT plan, so `price`
 * stays null (routing ranks a row by its own price and a plan row has none).
 * With `priceOf` (model id → a list price, the ledger's own lookup) a row also
 * carries `listPrice`: what its tokens cost at OpenAI's list price, the figure
 * the usage ledger books for it. A
 * model whose maxContextWindow beats its contextWindow also gets an
 * "<id>[extended]" row at the larger window (the Codex sidepanel's extended mode).
 */
export function normalizeCodexRows(rows, { priceOf = null } = {}) {
  return arr(rows).map((m) => (typeof m === 'string' ? { id: m, model: m } : m)).filter((m) => (m?.id || m?.model) && !m.hidden).filter((m) => !CODEX_HIDDEN.test(`${m.id || ''} ${m.model || ''}`)).flatMap((m) => {
    const id = String(m.model || m.id);
    const modalities = arr(m.inputModalities);
    const row = {
      provider: 'codex', id, upstream: id, label: m.displayName || id, family: id.replace(/-\w+$/, ''),
      vision: modalities.length ? modalities.includes('image') : (/^gpt-[5-9]/i.test(id) ? true : null),
      visionSource: modalities.length ? 'catalog' : 'guess',
      // Images through Codex's built-in image_generation tool; Codex makes no video.
      outputs: { image: CODEX_IMAGE_TOOL.test(id) ? true : null, video: false }, outputsSource: 'tool',
      reasoning: true, toolcall: true,
      contextWindow: num(m.contextWindow),
      price: null,
      ...(() => { let listed = null; try { listed = tablePrice(priceOf?.(id) || null, 'plan'); } catch { listed = null; } return listed ? { listPrice: listed } : {}; })(),
      efforts: sortEfforts(arr(m.supportedReasoningEfforts ?? m.supported_reasoning_efforts)),
      defaultEffort: m.defaultReasoningEffort || null,
      isDefault: !!m.isDefault,
      status: m.upgradeInfo?.retirementAt ? 'retiring' : 'active',
      description: m.description || null,
    };
    row.tier = guessTier(row);
    const max = num(m.maxContextWindow ?? m.max_context_window);
    if (!max || !row.contextWindow || max <= row.contextWindow) return [row];
    return [row, { ...row, id: `${id}[extended]`, label: `${row.label} (extended)`, contextWindow: max, isDefault: false }];
  });
}

/**
 * Antigravity's own model list (GET /api/antigravity/models: { id, label, description?, default?, efforts? }) →
 * rows. Antigravity is billed by its Google sign-in and reports tokens, not prices: `price` stays null and its
 * runs are unpriced. A row without levels of its own takes the five Antigravity accepts. The tier is guessed from
 * the name like every provider's (guessTier). `via: 'acp'` (the list an ACP session offered, lib/antigravity/
 * catalog.js): SynaBun hands such a model images as ACP image blocks, which agy passes on (measured on agy 1.4.12
 * with Gemini 3.8 Flash and 4 Argon), so it can see; a list `agy models` gave says nothing about that. Outputs and the
 * context window stay unknown.
 */
export function normalizeAntigravityRows(rows, { via = null } = {}) {
  const sees = via === 'acp';
  const seen = new Set();
  const out = [];
  for (const raw of arr(rows)) {
    const m = typeof raw === 'string' ? { id: raw } : raw;
    const id = typeof m?.id === 'string' ? m.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const own = sortEfforts(arr(m.efforts));
    const row = {
      provider: 'antigravity', id, upstream: id, label: String(m.label || m.name || id), family: null,
      tier: null, vision: sees ? true : null, visionSource: sees ? 'acp' : 'unknown',
      outputs: { image: null, video: null }, outputsSource: 'unknown',
      reasoning: null, toolcall: null, contextWindow: null,
      price: null,
      efforts: own.length ? own : [...ANTIGRAVITY_EFFORTS], defaultEffort: null,
      isDefault: m.default === true || m.isDefault === true,
      status: 'active',
      description: m.description ? String(m.description) : null,
    };
    row.tier = guessTier(row);
    row.tierSource = 'guess';
    out.push(row);
  }
  return out;
}

/**
 * Maritaca's model list (GET /api/maritaca/models: lib/maritaca/models.js rows, the API's list merged over the table)
 * → catalog rows of the `chat` section. Prices stay in BRL (never converted into the USD sheet); `vision` is false
 * (text only), `outputs` none, `toolcall` what the table says. A row the API lists and the table does not know keeps
 * what the API said and `tier` null.
 */
export function normalizeMaritacaRows(rows) {
  const seen = new Set();
  const out = [];
  for (const raw of arr(rows)) {
    const m = typeof raw === 'string' ? { id: raw } : raw;
    const id = typeof m?.id === 'string' ? m.id.trim() : '';
    if (!id || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    const price = m.price && typeof m.price === 'object' && (num(m.price.input) !== null || num(m.price.output) !== null)
      ? { input: num(m.price.input) ?? 0, output: num(m.price.output) ?? 0, cacheRead: num(m.price.cacheRead), unit: 'brl_per_mtok', basis: m.free === true ? 'free' : 'list' }
      : null;
    out.push({
      provider: 'maritaca', id, upstream: id, label: String(m.label || id), family: m.family || null,
      tier: ['small', 'medium', 'large'].includes(m.tier) ? m.tier : null, tierSource: m.tier ? 'table' : 'unknown',
      vision: false, visionSource: 'table', outputs: { image: false, video: false }, outputsSource: 'table',
      reasoning: typeof m.reasoning === 'boolean' ? m.reasoning : null, toolcall: typeof m.toolcall === 'boolean' ? m.toolcall : null,
      contextWindow: num(m.contextWindow), maxOutput: num(m.maxOutput), price,
      efforts: arr(m.efforts).map(String), defaultEffort: m.defaultEffort || null,
      isDefault: m.isDefault === true, status: m.listed === false ? 'unlisted' : 'active', chat: true, region: m.region || null,
      description: m.description ? String(m.description) : null,
    });
  }
  return out;
}

/** The OpenCode provider id Maritaca is registered under (lib/maritaca/opencode.js): its rows are `maritaca/<id>`. */
export const MARITACA_OPENCODE_PREFIX = 'maritaca/';
export const MARITACA_UNAVAILABLE_HINT = 'Register Maritaca under Settings → OpenCode → Providers';

/** True for an OpenCode row (or id) that is one of Maritaca's models run through OpenCode. */
export function isMaritacaOpenCodeId(id) { return String(id || '').toLowerCase().startsWith(MARITACA_OPENCODE_PREFIX); }

/**
 * The Maritaca group of every Assistant model picker. Maritaca is chat-only by itself (CHAT_PROVIDERS); what runs is
 * the OpenCode rows `maritaca/<id>`. The group shows those rows under their own heading: each one names the runnable
 * spec it stands for (`target: { provider: 'opencode', model: 'maritaca/<id>' }`, `via: 'opencode'`), so a pick, a
 * saved route and a dispatch keep the OpenCode spec unchanged. Order and labels / tier / BRL price are the Maritaca
 * panel's (`chatRows`); efforts and context are OpenCode's (what a run can use). Rows the user hid in OpenCode stay
 * out (`hiddenRows`: counted). While OpenCode lists no Maritaca model at all, the group keeps Maritaca's models
 * marked `status: 'unavailable'` with a hint, never an empty or missing group.
 */
export function maritacaRouteGroup({ chatRows = [], opencodeRows = [], hiddenRows = [] } = {}) {
  const visible = arr(opencodeRows).filter((row) => isMaritacaOpenCodeId(row?.id));
  const hidden = arr(hiddenRows).filter((row) => isMaritacaOpenCodeId(row?.id));
  const available = visible.length + hidden.length > 0;
  const bare = (id) => String(id).slice(MARITACA_OPENCODE_PREFIX.length);
  const byBare = new Map(visible.map((row) => [bare(row.id).toLowerCase(), row]));
  const hiddenBare = new Set(hidden.map((row) => bare(row.id).toLowerCase()));
  const models = [];
  const taken = new Set();
  const make = (chat, oc) => {
    const model = chat?.id || bare(oc.id);
    const id = `${MARITACA_OPENCODE_PREFIX}${oc ? bare(oc.id) : model}`;
    return {
      provider: 'maritaca', via: 'opencode', id, model, target: { provider: 'opencode', model: id },
      label: chat?.label || oc?.label || model, family: chat?.family || oc?.family || null,
      tier: chat?.tier || oc?.tier || null, vision: false, outputs: { image: false, video: false },
      contextWindow: oc?.contextWindow ?? chat?.contextWindow ?? null,
      // BRL, the Maritaca panel's price (never converted into the USD sheet).
      price: chat?.price || null,
      efforts: oc ? arr(oc.efforts) : arr(chat?.efforts), defaultEffort: oc ? oc.defaultEffort || null : chat?.defaultEffort || null,
      isDefault: chat?.isDefault === true,
      status: oc ? (oc.status || 'active') : 'unavailable',
      ...(oc ? {} : { hint: MARITACA_UNAVAILABLE_HINT }),
    };
  };
  for (const chat of arr(chatRows)) {
    const key = String(chat?.id || '').toLowerCase();
    if (!key || taken.has(key)) continue;
    taken.add(key);
    if (hiddenBare.has(key)) continue;
    const oc = byBare.get(key) || null;
    // OpenCode lists Maritaca but not this model: it cannot run, so it is not offered.
    if (available && !oc) continue;
    models.push(make(chat, oc));
  }
  // OpenCode rows the Maritaca table does not know (a model added upstream) are listed after, as OpenCode names them.
  for (const oc of visible) if (!taken.has(bare(oc.id).toLowerCase())) { taken.add(bare(oc.id).toLowerCase()); models.push(make(null, oc)); }
  return { id: 'maritaca', label: 'Maritaca', via: 'opencode', available, hint: available ? null : MARITACA_UNAVAILABLE_HINT, hiddenCount: hidden.length, currency: 'BRL', models };
}

/** The ids the user hid for `provider` (catalog.hidden, else the older opencodeHidden). */
function hiddenList(catalog, provider) {
  const map = catalog?.hidden;
  if (map && typeof map === 'object' && Array.isArray(map[provider])) return map[provider];
  return provider === 'opencode' ? arr(catalog?.opencodeHidden) : [];
}

/** How many models the provider listed before hiding (0 = list unavailable). */
export function listedCount(catalog, provider) {
  const listed = Number(catalog?.listed?.[provider]);
  if (Number.isFinite(listed)) return listed;
  return provider === 'opencode' ? Number(catalog?.opencodeListed) || 0 : 0;
}

/** Is this catalog row one the user hid? (id, id without [1m], or its resolved model). */
export function rowIsHidden(catalog, row) {
  return !!(row?.id && hiddenModelId(catalog, row.provider, row.id, { row }));
}

/**
 * The hidden id (Assistant → Models, or Settings → OpenCode) that `id` names,
 * else null. Case-insensitive. Claude Code / Codex: the id itself, or the
 * model its catalog row resolves to at the same context window (hiding
 * "claude-opus-5-5" hides "opus", hiding "claude-opus-5-5[1m]" hides
 * "opus[1m]"). Context variants hide independently: hiding "opus" leaves
 * "opus[1m]" alone and the other way round; same for "gpt-x" / "gpt-x[extended]".
 * OpenCode: the full "provider/model" id, or a bare model id.
 * An entry with a pin record (catalog.hiddenPins: an alias hidden as the model
 * it named, or that model's own id once the alias moved on) hides its own row
 * only: it never reaches another alias through the resolved model.
 */
export function hiddenModelId(catalog, provider, id, { row = null } = {}) {
  if (!provider || !id) return null;
  const hidden = hiddenList(catalog, provider);
  if (!hidden.length) return null;
  const want = canonicalModelId(provider, String(id).trim()).toLowerCase();
  if (provider === 'opencode') {
    const full = hidden.find((h) => String(h).toLowerCase() === want);
    if (full || want.includes('/')) return full || null;
    return hidden.find((h) => String(h).split('/').slice(1).join('/').toLowerCase() === want) || null;
  }
  const direct = hidden.find((h) => String(h).toLowerCase() === want);
  if (direct) return direct;
  const own = row || [...arr(catalog?.hiddenRows?.[provider]), ...arr(catalog?.models?.[provider])]
    .find((r) => String(r?.id || '').toLowerCase() === want);
  const resolved = resolvedKey(own);
  if (!resolved || resolved === want) return null;
  const pins = catalog?.hiddenPins?.[provider] || null;
  return hidden.find((h) => String(h).toLowerCase() === resolved && !pins?.[resolved]) || null;
}

/**
 * Resolve a model id against the catalog. Returns { row, match } or null when
 * the provider list is known and the id is not in it. match: exact | alias |
 * resolved | unlisted (a claude-* id the CLI accepts but does not list) |
 * unverified (the provider list is empty/unavailable — accept, can't check).
 * A model the user hid (Assistant → Models, Settings → OpenCode) is never
 * found (null) — checked before the unlisted and unverified paths, so a hidden
 * claude-* id or a provider that is down cannot slip through — and neither is
 * anything when the user hid every model of a provider that listed some.
 */
export function findModel(catalog, provider, id) {
  // A chat-only provider is never a dispatch target: nothing resolves there (the router never asks, the brain cannot route to it).
  if (CHAT_PROVIDERS.includes(provider)) return null;
  if (!id) return null;
  if (hiddenModelId(catalog, provider, id)) return null;
  const rows = arr(catalog?.models?.[provider]);
  if (!rows.length) {
    // An authoritative empty list (OpenCode with nothing connected) is not an unavailable one.
    if (listedCount(catalog, provider) > 0 || catalog?.known?.[provider] === true) return null;
    return { row: null, match: 'unverified' };
  }
  // Context-aware: "opus[1m]" never falls back to the 200k "opus" row, nor
  // "gpt-x[extended]" to "gpt-x" (each is its own row).
  const want = canonicalModelId(provider, String(id).trim());
  const exact = rows.find((row) => row.id === want);
  if (exact) return { row: exact, match: 'exact' };
  const bare = want.toLowerCase();
  const alias = rows.find((row) => row.id.toLowerCase() === bare);
  if (alias) return { row: alias, match: 'alias' };
  if (provider === 'claude-code') {
    const resolved = rows.find((row) => resolvedKey(row) === bare);
    if (resolved) return { row: resolved, match: 'resolved' };
    if (/^claude-/i.test(want)) return { row: null, match: 'unlisted' };
  }
  if (provider === 'opencode' && !want.includes('/')) {
    const byModel = rows.filter((row) => row.id.split('/').slice(1).join('/').toLowerCase() === bare);
    if (byModel.length === 1) return { row: byModel[0], match: 'alias' };
  }
  return null;
}

/**
 * The provider's default row (null model → what the provider would use).
 * OpenCode's `default` map is per upstream provider; the model a null request
 * really gets comes from OpenCode's own config, so it is unknown here.
 */
export function defaultModelRow(catalog, provider) {
  if (provider === 'opencode') return null;
  const rows = arr(catalog?.models?.[provider]).filter((row) => !rowIsHidden(catalog, row));
  const own = rows.find((row) => row.isDefault);
  if (own) return own;
  // The provider's own default is hidden: the first visible model stands in
  // (the dispatcher pins it, so a null model never falls back to a hidden one).
  if (defaultIsHidden(catalog, provider)) return rows.find((row) => row.status !== 'unavailable') || rows[0] || null;
  return provider === 'claude-code' ? rows[0] || null : null;
}

/** The user hid the row a null model would run on (Claude Code / Codex only). */
export function defaultIsHidden(catalog, provider) {
  if (provider === 'opencode') return false;
  if (arr(catalog?.hiddenRows?.[provider]).some((row) => row.isDefault)) return true;
  return arr(catalog?.models?.[provider]).some((row) => row.isDefault && rowIsHidden(catalog, row));
}

/** The provider listed models but the user hid every one of them. */
export function openCodeConnectedKnown(data) {
  return Array.isArray(unwrapOpenCode(data).connected);
}

/** The provider answered authoritatively and has no model at all (OpenCode with nothing connected). */
export function providerEmpty(catalog, provider) {
  return catalog?.known?.[provider] === true && !arr(catalog?.models?.[provider]).length && !arr(catalog?.hiddenRows?.[provider]).length;
}

export function providerAllHidden(catalog, provider) {
  if (listedCount(catalog, provider) <= 0) return false;
  return !arr(catalog?.models?.[provider]).some((row) => !rowIsHidden(catalog, row));
}

/**
 * The enabled row to run instead of a hidden model `id` (or of a null model
 * whose default is hidden): the same model at another context window ("gpt-x"
 * → "gpt-x[extended]", "opus" → "default"), else the provider's enabled
 * default, else its first enabled row. null when the user hid every model of
 * the provider, and for OpenCode (a null OpenCode model runs OpenCode's own
 * configured default, which the catalog cannot name).
 */
export function enabledStandIn(catalog, provider, id = null) {
  if (!provider || provider === 'opencode') return null;
  const rows = arr(catalog?.models?.[provider]).filter((row) => !rowIsHidden(catalog, row) && row.status !== 'unavailable');
  if (!rows.length) return null;
  if (id) {
    const want = canonicalModelId(provider, String(id).trim()).toLowerCase();
    const own = [...arr(catalog?.hiddenRows?.[provider]), ...arr(catalog?.models?.[provider])]
      .find((row) => String(row?.id || '').toLowerCase() === want);
    const family = baseModelId(own?.upstream || want).toLowerCase();
    const sibling = rows.find((row) => baseModelId(row.upstream || row.id).toLowerCase() === family);
    if (sibling) return sibling;
  }
  const own = defaultModelRow(catalog, provider);
  return own && rows.includes(own) ? own : rows[0];
}

/** "$4/$20", "free", or for a plan-billed row "plan" (with `listPrice`: "plan (list $2/$10)", the list-price equivalent). */
export function priceText(price, listPrice = null) {
  const fmt = (n) => `$${Number(n).toFixed(n >= 10 ? 0 : 2).replace(/\.00$/, '')}`;
  if (!price) return listPrice ? `plan (list ${fmt(listPrice.input)}/${fmt(listPrice.output)})` : 'plan';
  if (price.basis === 'free') return 'free';
  return `${fmt(price.input)}/${fmt(price.output)}`;
}

function ctxText(ctx) {
  if (!ctx) return '';
  if (ctx >= 1_000_000) return `${Math.round(ctx / 100_000) / 10}M ctx`.replace('.0M', 'M');
  return `${Math.round(ctx / 1000)}k ctx`;
}

/** One routing-sheet line: `id · tier · $in/$out · vision · image-out · video-out · ctx · efforts`. */
export function formatModelLine(row) {
  // Only Codex bills a plan; Antigravity reports tokens, never prices; any other row without a price is a
  // model no table prices yet.
  const planBilled = row.provider === 'codex' || !!row.listPrice;
  const parts = [row.id, row.tier || '?', row.price || planBilled ? priceText(row.price, row.listPrice) : row.provider === 'antigravity' ? 'unpriced' : 'price unknown'];
  if (row.vision) parts.push('vision');
  if (rowMakes(row, 'image')) parts.push('image-out');
  if (rowMakes(row, 'video')) parts.push('video-out');
  const ctx = ctxText(row.contextWindow);
  if (ctx) parts.push(ctx);
  if (row.efforts?.length) parts.push(`effort ${row.efforts.join('|')}`);
  return parts.join(' · ');
}

/** Every effort any of `rows` supports, in canonical order. */
export function providerEfforts(rows) { return sortEfforts(arr(rows).flatMap((row) => arr(row?.efforts))); }

function outputPrice(row) { const out = num(row?.price?.output); return out === null ? Number.POSITIVE_INFINITY : out; }

/**
 * Pick a compact, representative slice per provider for the brain's routing
 * sheet: the brain's own model, remembered preferences, the cheapest model that
 * makes images and the cheapest that makes video, provider defaults, the
 * cheapest capable model per tier and the cheapest vision model. Claude and
 * Codex lists are short; OpenCode can list hundreds, so it is sampled.
 */
export function selectSheetModels(catalog, { brain = {}, preferences = {}, max = 8 } = {}) {
  const out = {};
  const pinned = new Map(); // provider → Set(ids)
  const pin = (provider, id) => { if (!provider || !id) return; if (!pinned.has(provider)) pinned.set(provider, new Set()); pinned.get(provider).add(String(id)); };
  if (brain?.provider && brain?.model) pin(brain.provider, brain.model);
  for (const pref of Object.values(preferences || {})) if (pref?.provider && pref?.model) pin(pref.provider, pref.model);
  for (const provider of CATALOG_PROVIDERS) {
    const rows = arr(catalog?.models?.[provider]).filter((row) => row.status !== 'unavailable');
    if (!rows.length) { out[provider] = []; continue; }
    const picked = [];
    const seen = new Set();
    const keyOf = (row) => (provider === 'claude-code' ? `${row.upstream}${contextSuffix(row.id)}` : row.id);
    const add = (row) => {
      if (!row || picked.length >= max) return;
      const key = keyOf(row);
      if (seen.has(key)) return;
      seen.add(key);
      picked.push(row);
    };
    // Image / video creation only runs on a model that makes them: the cheapest
    // maker of each medium keeps a slot, even when pinned routes fill the rest.
    const makers = [];
    for (const medium of MEDIA_KINDS) {
      const row = [...rows].filter((r) => rowMakes(r, medium)).sort((a, b) => outputPrice(a) - outputPrice(b))[0];
      if (row && !makers.includes(row)) makers.push(row);
    }
    const reserved = () => makers.filter((row) => !seen.has(keyOf(row))).length;
    for (const id of pinned.get(provider) || []) {
      const row = findModel(catalog, provider, id)?.row || null;
      if (row && (makers.includes(row) || picked.length < max - reserved())) add(row);
    }
    for (const row of makers) add(row);
    if (provider === 'claude-code') {
      // Newest first per family; alias ids (opus, sonnet, haiku) read better.
      const families = new Map();
      for (const row of rows) {
        const family = /fable/i.test(row.upstream) ? 'fable' : /opus/i.test(row.upstream) ? 'opus' : /sonnet/i.test(row.upstream) ? 'sonnet' : /haiku/i.test(row.upstream) ? 'haiku' : row.upstream;
        const current = families.get(family);
        if (!current) families.set(family, row);
        else if (current.id === 'default' && row.upstream === current.upstream) families.set(family, row);
      }
      for (const row of families.values()) add(row);
    } else if (provider === 'codex' || provider === 'antigravity') {
      // Short lists, and Antigravity's rows carry no tier or price to sample by.
      for (const row of rows) add(row);
    } else {
      const upstream = brain?.provider === 'opencode' && brain?.model ? String(brain.model).split('/')[0] : null;
      const capable = rows.filter((row) => row.toolcall !== false && row.status !== 'deprecated');
      const byPrice = [...capable].sort((a, b) => outputPrice(a) - outputPrice(b));
      const local = upstream ? byPrice.filter((row) => row.upstream === upstream) : [];
      for (const tier of TIERS) add(local.find((row) => row.tier === tier) || null);
      add(byPrice.find((row) => row.vision) || null);
      for (const tier of TIERS) add(byPrice.find((row) => row.tier === tier) || null);
      for (const row of capable.filter((r) => r.isDefault)) add(row);
    }
    out[provider] = picked;
  }
  return out;
}

/** Compact brain-facing rows: { id, tier, vision, outputs (makers only), price:[in,out]|null, efforts, defaultEffort, ctx }. */
export function compactRow(row) {
  return {
    id: row.id, label: row.label, tier: row.tier || null, vision: row.vision ?? null,
    // Only a model that makes images or video carries it (true = qualifies for image / video creation).
    outputs: rowMakes(row, 'image') || rowMakes(row, 'video') ? { image: row.outputs.image ?? null, video: row.outputs.video ?? null } : undefined,
    price: row.price ? [row.price.input, row.price.output] : null,
    // A plan-billed row: what its tokens cost at list price (the ledger's figure), not a charge.
    ...(row.listPrice ? { listPrice: [row.listPrice.input, row.listPrice.output] } : {}),
    efforts: row.efforts?.length ? row.efforts : undefined,
    defaultEffort: row.defaultEffort || undefined,
    ctx: row.contextWindow || undefined,
    ctxLabel: contextLabel(row) || undefined,
    default: row.isDefault || undefined,
  };
}

/**
 * @param {object} deps
 * @param {(path:string)=>Promise<object|null>} deps.fetchJson  self-fetch of the Neural Interface REST API
 * @param {object} [deps.claudePricing]   replaces the list-price table for Claude rows (tests)
 * @param {(model:string)=>object|null} [deps.codexPrice] list price of a Codex model (the ledger's lookup); default: the table
 * @param {()=>object} [deps.listAccounts] → { codex:[...], 'claude-code':[...] }
 * @param {()=>object} [deps.readFilter]   → { opencode:[globs] } (routing.catalogFilter)
 * @param {()=>object} [deps.readHidden] → { 'claude-code': [], codex: [], opencode: [] } ids the user
 *   hid (Assistant → Models; OpenCode's list is Settings → OpenCode's). A bare array = OpenCode ids.
 * @param {(args:{provider:string, rows:object[], source:string})=>{ids:string[], pins:object}|null} [deps.reconcileHidden]
 *   settles a provider's hidden list against the rows just listed (hidden aliases are pinned to a model:
 *   lib/assistant-hidden-models.js `reconcile`); its ids and pins replace readHidden's for that build
 * @param {(change:{providers:string[], generatedAt:string})=>void} [deps.onChange] a build listed other
 *   models than the build before it (hiding has its own event and does not count)
 * @param {number} [deps.retryMs] how soon a build is redone while Claude Code or Codex gave no verified list
 * @param {boolean} [deps.staleWhileRevalidate] an old build (past its lifetime) is given at once and built
 *   again in the background, one build at a time; only a first build, invalidate() and force wait for one
 */
export function createAssistantCatalog({
  fetchJson,
  getExternalServers = () => [],
  claudePricing = null,
  codexPrice = (model) => listPrice('codex', model),
  listAccounts = () => ({}),
  readFilter = () => ({}),
  readHidden = () => [],
  reconcileHidden = null,
  onChange = null,
  ttlMs = 30_000,
  retryMs = 5_000,
  staleWhileRevalidate = false,
  now = Date.now,
  log = () => {},
} = {}) {
  if (typeof fetchJson !== 'function') throw new Error('createAssistantCatalog requires fetchJson');
  let cache = null;
  let inflight = null;
  // The last verified list Claude Code and Codex gave: what their rows are built
  // from while the provider does not answer, or answers with its static stand-in.
  const lastLive = {};
  let degradedBuilds = 0;
  let epoch = 0; // bumped by invalidate(): a build that began before it is not kept
  let lastListed = null; // provider → signature of the rows the last build listed

  // External servers are read degraded here (the catalog only lists): a provider whose MCP configuration
  // cannot be read is reported in `errors`, its rows say `unknown`, and every other provider's servers and
  // every model stay listed. Dispatch and worker launch read their own strict inventories and refuse.
  // getExternalServers answers { servers, errors } or plain rows (older form).
  function externalServersReport(projectRows) {
    try {
      const answer = getExternalServers(projectRows);
      if (Array.isArray(answer)) return { servers: answer, errors: [] };
      return { servers: Array.isArray(answer?.servers) ? answer.servers : [], errors: Array.isArray(answer?.errors) ? answer.errors : [] };
    } catch (error) {
      log('catalog:external-servers-error', error?.code || error?.message || String(error));
      return { servers: [], errors: [externalDiscoveryError(error?.provider || null, error)] };
    }
  }

  const pickArray = (value, keys = []) => {
    if (Array.isArray(value)) return value;
    for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
    return [];
  };

  /**
   * One provider's answer → the list to build rows from and how it was obtained:
   * 'live' (the provider answered), 'stale' (it did not: its last verified list),
   * 'fallback' (never verified: the endpoint's static stand-in), 'unavailable'.
   */
  function settle(provider, payload) {
    const list = pickArray(payload, ['models']);
    const verified = !!payload && payload.ok !== false && payload.source !== 'fallback' && list.length > 0;
    if (verified) { lastLive[provider] = list; return { list, state: 'live' }; }
    if (lastLive[provider]) return { list: lastLive[provider], state: 'stale' };
    return list.length ? { list, state: 'fallback' } : { list: [], state: 'unavailable' };
  }

  function listedSignature(rows) {
    return JSON.stringify(arr(rows).map((row) => [row.id, row.label, row.upstream || '', row.status || '', row.contextWindow || 0, arr(row.efforts).join(',')]));
  }

  /**
   * Antigravity's answer: its endpoint says itself how the list was obtained ('live', 'stale': its own last
   * list while the CLI does not answer, 'unavailable'). No answer, a refusal or an unavailable list: no rows.
   */
  function antigravityList(payload) {
    if (!payload || typeof payload !== 'object' || payload.ok === false) return { list: [], state: 'unavailable' };
    const said = String(payload.source || '').toLowerCase();
    // Whether Antigravity is signed in, and on which plan, as its last listing said (null: not known).
    const signIn = { signedIn: payload.signedIn === true ? true : payload.signedIn === false || payload.authRequired === true ? false : null, tier: typeof payload.tier === 'string' ? payload.tier : null };
    if (said === 'unavailable') return { list: [], state: 'unavailable', via: null, ...signIn };
    const list = pickArray(payload, ['models']);
    return { list, state: said === 'stale' ? 'stale' : list.length || said === 'live' ? 'live' : 'unavailable', via: typeof payload.via === 'string' ? payload.via : null, ...signIn };
  }

  async function build({ deep = false } = {}) {
    // `deep` also drops the providers' own discovery caches (a CLI or app-server round trip).
    const fresh = deep ? '?refresh=1' : '';
    const [claudeModels, codexModels, opencodeProviders, antigravityModels, projects, maritacaModels] = await Promise.all([
      fetchJson(`/api/claude/models${fresh}`), fetchJson(`/api/codex/models${fresh}`), fetchJson('/api/opencode/providers/full'),
      // A provider that does not answer is unavailable for this build, never a failed build.
      Promise.resolve().then(() => fetchJson(`/api/antigravity/models${fresh}`)).catch(() => null),
      fetchJson('/api/projects'),
      // The chat-only provider (its own section): a server from before it answers nothing, and the section is empty.
      Promise.resolve().then(() => fetchJson('/api/maritaca/models')).catch(() => null),
    ]);
    const filter = (() => { try { return readFilter() || {}; } catch { return {}; } })();
    let accounts = {};
    try { accounts = listAccounts() || {}; } catch (error) { log('catalog:accounts-error', error?.message || String(error)); }
    // Models the user hid (Assistant → Models, Settings → OpenCode) never reach
    // the sheet, agent_catalog, route options or validation; `listed` tells
    // findModel a provider's list was available even when every row is hidden.
    const hidden = (() => {
      let raw = {};
      try { raw = readHidden() || {}; } catch {}
      if (Array.isArray(raw)) raw = { opencode: raw };
      return Object.fromEntries(CATALOG_PROVIDERS.map((p) => [p, arr(raw[p]).map(String)]));
    })();
    const claude = settle('claude-code', claudeModels);
    const codex = settle('codex', codexModels);
    const antigravity = antigravityList(antigravityModels);
    // OpenCode is read from its serve on every build; while it is down its models are unknown, not remembered.
    const sources = {
      'claude-code': claude.state,
      codex: codex.state,
      opencode: opencodeProviders && opencodeProviders.ok !== false ? 'live' : 'unavailable',
      antigravity: antigravity.state,
      // Maritaca: 'live' when its API listed the models, 'table' when the shipped table answered, else unavailable.
      maritaca: maritacaModels && maritacaModels.ok !== false ? (maritacaModels.source === 'live' ? 'live' : 'fallback') : 'unavailable',
    };
    const chat = { maritaca: maritacaModels && maritacaModels.ok !== false ? normalizeMaritacaRows(pickArray(maritacaModels, ['models'])) : [] };
    for (const p of ['claude-code', 'codex']) if (sources[p] !== 'live') log('catalog:source', `${p}: ${sources[p]}`);
    const all = {
      'claude-code': withClaudeContextVariants(normalizeClaudeRows(claude.list, { pricing: claudePricing })),
      codex: normalizeCodexRows(codex.list, { priceOf: codexPrice }),
      opencode: parseOpenCodeProviders(opencodeProviders, { filter: filter.opencode || null }),
      antigravity: normalizeAntigravityRows(antigravity.list, { via: antigravity.via }),
    };
    // A hidden alias hides the model it named when it was hidden. With the rows at hand the
    // store settles that: an alias that moved on is shown again and its old model stays hidden.
    const hiddenPins = Object.fromEntries(CATALOG_PROVIDERS.map((p) => [p, {}]));
    if (typeof reconcileHidden === 'function') {
      for (const p of CATALOG_PROVIDERS) {
        try {
          const settled = reconcileHidden({ provider: p, rows: all[p], source: sources[p] });
          if (!settled || !Array.isArray(settled.ids)) continue;
          hidden[p] = settled.ids.map(String);
          hiddenPins[p] = settled.pins && typeof settled.pins === 'object' ? settled.pins : {};
        } catch (error) { log('catalog:hidden-pins-error', `${p}: ${error?.message || String(error)}`); }
      }
    }
    const lookup = { hidden, hiddenPins };
    const models = {};
    const hiddenRows = {};
    const listedCounts = {};
    for (const p of CATALOG_PROVIDERS) {
      models[p] = [];
      hiddenRows[p] = [];
      listedCounts[p] = all[p].length;
      for (const row of all[p]) (hidden[p].length && hiddenModelId(lookup, p, row.id, { row }) ? hiddenRows[p] : models[p]).push(row);
    }
    const opencode = models.opencode;
    const listedNow = Object.fromEntries(CATALOG_PROVIDERS.map((p) => [p, listedSignature(all[p])]));
    const changed = lastListed ? CATALOG_PROVIDERS.filter((p) => listedNow[p] !== lastListed[p]) : [];
    lastListed = listedNow;
    const external = externalServersReport(pickArray(projects, ['projects']));
    // Maritaca's models run through OpenCode: its rows are marked with their picker group, and the group itself is
    // built for the pickers and the routing sheet (routeGroups.maritaca).
    for (const row of [...models.opencode, ...hiddenRows.opencode]) if (isMaritacaOpenCodeId(row.id)) row.group = 'maritaca';
    const maritacaGroup = maritacaRouteGroup({ chatRows: chat.maritaca, opencodeRows: models.opencode, hiddenRows: hiddenRows.opencode });
    return {
      generatedAt: new Date(now()).toISOString(),
      // Providers whose MCP server list could not be checked: { provider, code, reason, errno? }, no paths.
      externalServerErrors: external.errors,
      // Providers whose listed models differ from the build before (not part of the value's meaning: full() reports it).
      changedProviders: changed,
      models,
      // Chat-only providers (CHAT_PROVIDERS): listed, never routed to. `chat.maritaca` rows carry BRL prices.
      chat,
      // Picker groups that run through another provider: { maritaca: maritacaRouteGroup(...) }.
      routeGroups: { maritaca: maritacaGroup },
      hidden,
      // provider → { hidden id (lower-case) → { model, variant, label, at, … } }: the entries that hide one row only.
      hiddenPins,
      hiddenRows,
      // How each provider's list was obtained: live | stale | fallback | unavailable.
      sources,
      listed: listedCounts,
      // The provider answered with an authoritative list, even an empty one (OpenCode's `connected`).
      known: { opencode: openCodeConnectedKnown(opencodeProviders) },
      opencodeTotal: opencode.length,
      opencodeListed: listedCounts.opencode,
      opencodeHidden: hidden.opencode,
      projects: pickArray(projects, ['projects']),
      tools: { ...toolCatalogView(), servers: external.servers, externalServerErrors: external.errors, externalServerLimitations: EXTERNAL_SERVER_LIMITATIONS },
      accounts,
      // Efforts are per model (row.efforts); a provider's list is the union of its rows'.
      providers: [
        { id: 'claude-code', brain: true, efforts: providerEfforts(models['claude-code']), permissionPolicies: ['auto', 'ask'] },
        { id: 'codex', brain: true, efforts: providerEfforts(models.codex), permissionPolicies: ['auto', 'restricted'] },
        { id: 'opencode', brain: true, efforts: providerEfforts(models.opencode), permissionPolicies: ['auto', 'ask'] },
        // A brain and a worker. No accounts (Antigravity signs in with Google in its own CLI: `signedIn` and `tier`
        // say what its last model listing found) and unpriced (tokens, not prices).
        { id: 'antigravity', brain: true, efforts: providerEfforts(models.antigravity), permissionPolicies: ['auto', 'ask'], accounts: false, priced: false, signedIn: antigravity.signedIn, tier: antigravity.tier },
        // Chat only: a side panel, no worker, no brain, no dispatch. Prices in BRL on its rows; the key is one per SynaBun
        // (`configured` says whether it is saved).
        { id: 'maritaca', brain: false, worker: false, chat: true, efforts: providerEfforts(chat.maritaca), permissionPolicies: [], accounts: false, priced: true, currency: 'BRL', configured: maritacaModels?.configured === true,
          // Its OpenCode-backed rows run (provider opencode, model maritaca/<id>); a direct chat pick never does.
          via: 'opencode', runnable: maritacaGroup.available },
      ],
    };
  }

  /**
   * `force` rebuilds now from the providers' endpoints (each answers from its own
   * discovery cache, exactly as it does for its panel's selector); `deep` makes
   * those endpoints ask the CLI / app-server again as well.
   */
  async function full({ force = false, deep = false } = {}) {
    if (!force && !deep && cache && now() - cache.at < cache.ttl) return cache.value;
    // Past its lifetime: with staleWhileRevalidate the old build is the answer while the next one is made
    // (never a build that began before an invalidate(): `current` says it was made for the lists as they are).
    if (staleWhileRevalidate && !force && !deep && cache?.current) {
      if (!inflight) startBuild({ deep: false }).catch((error) => log('catalog:background-error', error?.message || String(error)));
      return cache.value;
    }
    if (inflight) return inflight;
    return startBuild({ deep });
  }

  function startBuild({ deep = false } = {}) {
    const started = epoch;
    inflight = build({ deep }).then((built) => {
      const { changedProviders, ...value } = built;
      // No verified list from Claude Code or Codex: ask again soon, backing off to the
      // normal lifetime (a provider that is not installed must not be spawned every few seconds).
      const degraded = ['claude-code', 'codex'].some((p) => value.sources[p] !== 'live');
      degradedBuilds = degraded ? degradedBuilds + 1 : 0;
      const ttl = degraded ? Math.min(ttlMs, retryMs * 2 ** (degradedBuilds - 1)) : ttlMs;
      cache = { at: now(), value, ttl: started === epoch ? ttl : 0, current: started === epoch };
      if (changedProviders.length && typeof onChange === 'function') {
        try { onChange({ providers: changedProviders, generatedAt: value.generatedAt }); } catch (error) { log('catalog:onchange-error', error?.message || String(error)); }
      }
      return value;
    }).finally(() => { inflight = null; });
    return inflight;
  }

  /**
   * Every row, hidden ones included, per provider, and how each provider's list was obtained:
   * { rows, sources, generatedAt } of one build, so what a row says is never read against another build's source.
   */
  async function manageSnapshot({ force = false, deep = false } = {}) {
    const value = await full({ force, deep });
    return {
      rows: Object.fromEntries(CATALOG_PROVIDERS.map((p) => [p, [...arr(value.models?.[p]), ...arr(value.hiddenRows?.[p])]])),
      sources: { ...value.sources },
      generatedAt: value.generatedAt,
    };
  }

  /** Every row, hidden ones included, per provider (the Models manager, id resolution). */
  async function manageRows(options = {}) { return (await manageSnapshot(options)).rows; }

  /**
   * view 'full' (default): every visible row. view 'brain': compact rows,
   * OpenCode capped; `provider` + `q` narrow the list (agent_catalog search).
   * view 'manage': every row with hidden: true|false and hiddenBy (the list
   * entry that hides it), plus `archived`: every hidden id per provider with
   * the rows it covers; listed:false = no current row (still restorable); `pin`
   * = the model an alias entry was hidden as (see hiddenPins).
   */
  async function get({ force = false, deep = false, view = 'full', provider = null, q = null, brain = null, preferences = {} } = {}) {
    const value = await full({ force, deep });
    if (view === 'manage') {
      const models = {};
      const archived = {};
      for (const p of CATALOG_PROVIDERS) {
        if (provider && p !== provider) continue;
        const hiddenIds = new Set(arr(value.hiddenRows?.[p]).map((row) => row.id));
        const rows = [...arr(value.models?.[p]), ...arr(value.hiddenRows?.[p])];
        const covers = new Map(); // hidden id (lower-case) → rows it hides
        models[p] = rows.map((row) => {
          const hidden = hiddenIds.has(row.id);
          const hiddenBy = hidden ? hiddenModelId(value, p, row.id, { row }) || row.id : null;
          if (hiddenBy) {
            const key = String(hiddenBy).toLowerCase();
            if (!covers.has(key)) covers.set(key, []);
            covers.get(key).push({ id: row.id, label: row.label || row.id, context: contextLabel(row) || null });
          }
          return { ...compactRow(row), provider: p, upstream: row.upstream || null, status: row.status || null, context: contextLabel(row) || null, hidden, hiddenBy };
        });
        archived[p] = arr(value.hidden?.[p]).map((id) => {
          const covered = covers.get(String(id).toLowerCase()) || [];
          const pin = value.hiddenPins?.[p]?.[String(id).toLowerCase()] || null;
          return { id, listed: covered.length > 0, group: p === 'opencode' ? String(id).split('/')[0] : null, rows: covered, ...(pin ? { pin } : {}) };
        });
      }
      return { view: 'manage', generatedAt: value.generatedAt, models, archived, hidden: value.hidden, hiddenPins: value.hiddenPins, listed: value.listed, sources: value.sources };
    }
    if (view !== 'brain' && !provider && !q) return value;
    const needle = q ? String(q).toLowerCase() : null;
    const matches = (row) => !needle || `${row.id} ${row.label} ${row.family || ''}`.toLowerCase().includes(needle);
    const models = {};
    if (provider || needle) {
      for (const p of CATALOG_PROVIDERS) {
        if (provider && p !== provider) continue;
        models[p] = value.models[p].filter(matches).slice(0, 60).map(compactRow);
      }
    } else {
      const sheet = selectSheetModels(value, { brain, preferences, max: 40 });
      for (const p of CATALOG_PROVIDERS) models[p] = (p === 'opencode' ? sheet[p] : value.models[p]).map(compactRow);
    }
    const { opencodeHidden, hidden, hiddenPins, hiddenRows, ...rest } = value;
    const hiddenCount = Object.fromEntries(CATALOG_PROVIDERS.map((p) => [p, arr(hiddenRows?.[p]).length]));
    return { ...rest, view: 'brain', models, opencodeTotal: value.opencodeTotal, hiddenCount, opencodeHiddenCount: arr(opencodeHidden).length };
  }

  function peek() { return cache?.value || null; }
  function find(provider, id) { return findModel(peek(), provider, id); }
  /**
   * The hidden id `id` names for `provider`, else null. Works before the first
   * build (the lists are read directly; alias → resolved matching needs rows).
   */
  function hiddenId(provider, id) {
    const value = peek();
    if (value?.hidden) return hiddenModelId(value, provider, id);
    let raw = {};
    try { raw = readHidden() || {}; } catch {}
    if (Array.isArray(raw)) raw = { opencode: raw };
    return hiddenModelId({ hidden: raw }, provider, id);
  }

  /** Capabilities of a brain/target model: { vision, tier, price, label, contextWindow, source }. */
  function brainInfo(brain = {}) {
    const catalog = peek();
    const provider = brain?.provider;
    if (!catalog || !provider) return { vision: null, tier: null, price: null, label: brain?.model || null, contextWindow: null, source: 'unknown' };
    const hit = brain.model ? findModel(catalog, provider, brain.model) : null;
    const row = hit?.row || (!brain.model ? defaultModelRow(catalog, provider) : null);
    if (!row) {
      const claudeUnlisted = provider === 'claude-code' && hit?.match === 'unlisted';
      const source = hit?.match || (hiddenModelId(catalog, provider, brain.model) ? 'disabled' : 'unknown');
      return { vision: claudeUnlisted ? true : null, tier: null, price: null, label: brain.model || null, contextWindow: null, source };
    }
    return { vision: row.vision ?? null, tier: row.tier || null, price: row.price || null, label: row.label || row.id, contextWindow: row.contextWindow || null, source: hit?.match || 'default', id: row.id };
  }

  function invalidate() { cache = null; epoch += 1; }
  /** The lists may have changed (a serve restarted, a CLI updated): the next read still answers with this build and makes the next one. */
  function markStale() { if (cache) cache = { ...cache, at: -Infinity }; }
  /** A provider's own list changed: drop the copy and build the next one now (onChange reports the difference). */
  function refresh() {
    invalidate();
    const pending = inflight; // began before the change: let it end, then build again
    return pending ? pending.catch(() => null).then(() => full()) : full();
  }

  return { get, full, peek, find, hiddenId, manageRows, manageSnapshot, brainInfo, invalidate, markStale, refresh };
}
