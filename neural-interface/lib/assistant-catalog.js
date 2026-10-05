// ═══════════════════════════════════════════
// SynaBun — Assistant model catalog (providers · models · tier · price · vision)
// ═══════════════════════════════════════════
//
// One normalized view of every model the assistant can route to: Claude Code
// (CLI model list), Codex (app-server model/list) and OpenCode (the shared
// serve's /provider, connected providers only). Claude and Codex rows are
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

import { sortEfforts, variantNames } from './effort-levels.js';
import { listPrice } from './assistant-pricing.js';

export const CATALOG_PROVIDERS = ['claude-code', 'codex', 'opencode'];
export const TIERS = ['small', 'medium', 'large'];

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
  const name = `${row.id || ''} ${row.label || ''} ${row.upstream || ''}`;
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
  return hidden.find((h) => String(h).toLowerCase() === resolved) || null;
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
  const parts = [row.id, row.tier || '?', priceText(row.price, row.listPrice)];
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
    } else if (provider === 'codex') {
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
 */
export function createAssistantCatalog({
  fetchJson,
  claudePricing = null,
  codexPrice = (model) => listPrice('codex', model),
  listAccounts = () => ({}),
  readFilter = () => ({}),
  readHidden = () => [],
  ttlMs = 30_000,
  now = Date.now,
  log = () => {},
} = {}) {
  if (typeof fetchJson !== 'function') throw new Error('createAssistantCatalog requires fetchJson');
  let cache = null;
  let inflight = null;

  async function build() {
    const [claudeModels, codexModels, opencodeProviders, projects, mcpProfile] = await Promise.all([
      fetchJson('/api/claude/models'), fetchJson('/api/codex/models'), fetchJson('/api/opencode/providers/full'),
      fetchJson('/api/projects'), fetchJson('/api/mcp/profile'),
    ]);
    const pickArray = (value, keys = []) => {
      if (Array.isArray(value)) return value;
      for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
      return [];
    };
    const filter = (() => { try { return readFilter() || {}; } catch { return {}; } })();
    const presets = mcpProfile?.presets && typeof mcpProfile.presets === 'object'
      ? Object.entries(mcpProfile.presets).map(([name, preset]) => ({ name, label: preset?.label || name, groups: preset?.groups || [], tools: preset?.tools || null }))
      : [];
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
    const all = {
      'claude-code': withClaudeContextVariants(normalizeClaudeRows(pickArray(claudeModels, ['models']), { pricing: claudePricing })),
      codex: normalizeCodexRows(pickArray(codexModels, ['models']), { priceOf: codexPrice }),
      opencode: parseOpenCodeProviders(opencodeProviders, { filter: filter.opencode || null }),
    };
    const lookup = { hidden };
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
    return {
      generatedAt: new Date(now()).toISOString(),
      models,
      hidden,
      hiddenRows,
      listed: listedCounts,
      // The provider answered with an authoritative list, even an empty one (OpenCode's `connected`).
      known: { opencode: openCodeConnectedKnown(opencodeProviders) },
      opencodeTotal: opencode.length,
      opencodeListed: listedCounts.opencode,
      opencodeHidden: hidden.opencode,
      projects: pickArray(projects, ['projects']),
      profiles: presets,
      mcpProfiles: { presets, default: mcpProfile?.defaultProfile || mcpProfile?.profile || 'full' },
      accounts,
      // Efforts are per model (row.efforts); a provider's list is the union of its rows'.
      providers: [
        { id: 'claude-code', brain: true, efforts: providerEfforts(models['claude-code']), permissionPolicies: ['auto', 'ask'] },
        { id: 'codex', brain: true, efforts: providerEfforts(models.codex), permissionPolicies: ['auto', 'restricted'] },
        { id: 'opencode', brain: true, efforts: providerEfforts(models.opencode), permissionPolicies: ['auto', 'ask'] },
      ],
    };
  }

  async function full({ force = false } = {}) {
    if (!force && cache && now() - cache.at < ttlMs) return cache.value;
    if (inflight) return inflight;
    inflight = build().then((value) => { cache = { at: now(), value }; return value; }).finally(() => { inflight = null; });
    return inflight;
  }

  /** Every row, hidden ones included, per provider (the Models manager, id resolution). */
  async function manageRows({ force = false } = {}) {
    const value = await full({ force });
    return Object.fromEntries(CATALOG_PROVIDERS.map((p) => [p, [...arr(value.models?.[p]), ...arr(value.hiddenRows?.[p])]]));
  }

  /**
   * view 'full' (default): every visible row. view 'brain': compact rows,
   * OpenCode capped; `provider` + `q` narrow the list (agent_catalog search).
   * view 'manage': every row with hidden: true|false and hiddenBy (the list
   * entry that hides it), plus `archived`: every hidden id per provider with
   * the rows it covers; listed:false = no current row (still restorable).
   */
  async function get({ force = false, view = 'full', provider = null, q = null, brain = null, preferences = {} } = {}) {
    const value = await full({ force });
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
          return { id, listed: covered.length > 0, group: p === 'opencode' ? String(id).split('/')[0] : null, rows: covered };
        });
      }
      return { view: 'manage', generatedAt: value.generatedAt, models, archived, hidden: value.hidden, listed: value.listed };
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
    const { opencodeHidden, hidden, hiddenRows, ...rest } = value;
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

  function invalidate() { cache = null; }

  return { get, full, peek, find, hiddenId, manageRows, brainInfo, invalidate };
}
