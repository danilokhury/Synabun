// ── Context window for the Claude sidepanel ──
// Pure helpers (no DOM, no panel state) so the node suite can import them.
// The window the context reading divides by comes from, in order of authority:
//   1. result.modelUsage — what the CLI reports for the main loop;
//   2. the selected model's catalog entry (/api/claude/models);
//   3. the context in use — a window smaller than it is provably stale.

// Claude Code runs a model at 1M only with the `[1m]` marker on its id
// ("claude-opus-5-5[1m]"); everything else runs at 200K.
export const ONE_M_CONTEXT = 1_000_000;
export const DEFAULT_CONTEXT = 200_000;

// "claude-opus-5-5[1m]" → "claude-opus-5-5"; "claude-haiku-4-5-20251001" → "claude-haiku-4-5".
export function modelBase(id) {
  return String(id || '').trim().replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
}

// The catalog entry a selector id spawns as. Unknown and empty ids fall back to the
// CLI default, exactly as the dropdown resolves them (_resolveModelValue).
export function catalogModel(models, id) {
  const list = Array.isArray(models) ? models : [];
  return list.find(m => m?.id === id) || list.find(m => m?.tier === 'default') || list[0] || null;
}

// Window of a selector id. Before the catalog loads, the id itself still says which
// window was picked: the `[1m]` marker, or a legacy "<id>:<window>" composite.
export function catalogContextWindow(models, id) {
  const known = Number(catalogModel(models, id)?.contextWindow) || 0;
  if (known > 0) return known;
  const raw = String(id || '');
  if (/\[1m\]$/i.test(raw)) return ONE_M_CONTEXT;
  const composite = parseInt(raw.split(':')[1], 10);
  return composite > 0 ? composite : DEFAULT_CONTEXT;
}

// The main loop's window from a result event. modelUsage covers every model the query
// used — Task subagents (Explore runs on Haiku), compaction, helpers — cumulatively,
// and a resumed session restores it from the transcript's cost-state in whatever
// order that was saved (Haiku first is common), so its first key is not the main
// loop. Keys carry the CLI's `[1m]` marker; the main loop's API model does not, so
// match on the base id. One model can appear at two windows (a 1M main loop with
// 200K subagents on the same model, or a variant switch): the selected variant wins
// when it is the model that ran, otherwise the larger one.
// Returns 0 when nothing identifies the main loop — callers keep what they had.
export function mainLoopContextWindow(modelUsage, mainModel, selected = null) {
  const want = modelBase(mainModel);
  if (!want || !modelUsage || typeof modelUsage !== 'object') return 0;
  const windows = [];
  for (const [key, usage] of Object.entries(modelUsage)) {
    const cw = Number(usage?.contextWindow) || 0;
    if (cw > 0 && (modelBase(key) === want || modelBase(usage?.canonicalModel) === want)) windows.push(cw);
  }
  if (!windows.length) return 0;
  const picked = modelBase(selected?.resolvedModel || selected?.id) === want
    ? Number(selected?.contextWindow) || 0
    : 0;
  return windows.includes(picked) ? picked : Math.max(...windows);
}

// What the gauge divides by: the CLI's report for this session, else the selected
// model's window. Context above the window cannot happen — the CLI compacts first —
// so a smaller window is stale: take the smallest known window that holds it.
export function gaugeContextWindow({ reported = 0, selected = 0, used = 0, models = [] } = {}) {
  const window = reported > 0 ? reported : (selected > 0 ? selected : DEFAULT_CONTEXT);
  if (used <= window) return window;
  const known = (Array.isArray(models) ? models : []).map(m => Number(m?.contextWindow) || 0);
  const fits = [...known, ONE_M_CONTEXT].filter(cw => cw >= used).sort((a, b) => a - b);
  return fits[0] || window;
}

// What named a tab's window, so the context settings popover shows one only when
// something did: 'reported' (the CLI, result.modelUsage), 'catalog' (the selected
// model's entry, resolved as the dropdown resolves it), 'id' (the `[1m]` marker
// before the catalog loads), or '' — then the popover says it is not known yet
// rather than showing DEFAULT_CONTEXT.
export function contextWindowSource({ reported = 0, models = [], modelId = '' } = {}) {
  if (Number(reported) > 0) return 'reported';
  if (Number(catalogModel(models, modelId)?.contextWindow) > 0) return 'catalog';
  return /\[1m\]$/i.test(String(modelId || '')) ? 'id' : '';
}
