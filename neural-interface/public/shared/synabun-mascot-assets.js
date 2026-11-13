// Raster artwork shared by live rigs and transcript stills. All names are
// allowlisted; tool data can never become a URL. Timing belongs to the rig.
// v3 (approved 2026-11-11): every file is the whole drawn character (eyes,
// smile and props together); the rig never draws over it.
const ROOT = '/assets/mascot/';
export const MASCOT_ASSET_VERSION = '3';
export const MASCOT_ASSET_POSES = Object.freeze([
  'shell', 'read', 'edit', 'search', 'web', 'subagent', 'plan', 'memory',
  'runs', 'computer', 'think', 'mcp', 'idle', 'sleep', 'watch', 'wait',
  'success', 'error', 'blocked', 'offline', 'project', 'budget', 'skill',
  'present', 'pick', 'ask',
]);
const count = (v, lo, hi, fallback) => v != null && Number.isFinite(Number(v))
  ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : fallback;

export function mascotAssetKey(pose, options = {}, { hero = false } = {}) {
  const name = MASCOT_ASSET_POSES.includes(pose) ? pose : 'idle';
  if (name === 'idle' && hero) return 'idle-hero';
  if (name === 'memory' && options.mode === 'remember') return 'memory-remember';
  if (name === 'budget' && options.unlimited) return 'budget-unlimited';
  if (name === 'subagent') {
    const n = count(options.count, 1, 3, 1);
    return n === 1 ? name : `${name}-${n}`;
  }
  if (name === 'pick' || name === 'plan') {
    const n = count(options.ticks, 0, 3, 1);
    return n === 1 ? name : `${name}-${n}`;
  }
  return name;
}

// Every file shipped (one GIF + one still PNG each); also the asset integrity
// test's source of truth. `hover-attention` is the empty page's one-shot.
export const MASCOT_ASSET_KEYS = Object.freeze([...MASCOT_ASSET_POSES, 'idle-hero', 'hover-attention']);
// Keys the rig still tells apart that v3 draws with the base state's art.
export const MASCOT_ASSET_FALLBACKS = Object.freeze({
  'memory-remember': 'memory', 'budget-unlimited': 'budget',
  'subagent-2': 'subagent', 'subagent-3': 'subagent',
  'plan-0': 'plan', 'plan-2': 'plan', 'plan-3': 'plan',
  'pick-0': 'pick', 'pick-2': 'pick', 'pick-3': 'pick',
});

/** The shipped file a key is drawn from: its own, else its base state's, else idle. */
export function mascotAssetFile(key) {
  if (MASCOT_ASSET_KEYS.includes(key)) return key;
  return Object.hasOwn(MASCOT_ASSET_FALLBACKS, key) ? MASCOT_ASSET_FALLBACKS[key] : 'idle';
}

/** URL of a key's art (allowlisted: an unknown key is idle). */
export function mascotAssetUrl(key, { animated = false } = {}) {
  return `${ROOT}${mascotAssetFile(key)}.${animated ? 'gif' : 'png'}?v=${MASCOT_ASSET_VERSION}`;
}

export function mascotAsset(pose, options, { animated = false, hero = false } = {}) {
  return mascotAssetUrl(mascotAssetKey(pose, options, { hero }), { animated });
}

// Scene names are independent of tool input and always pass through this list.
export const SCENE_ASSET_KEYS = Object.freeze([
  'quick', 'code', 'complex', 'review', 'research', 'browser', 'computer',
  'automation', 'design', 'image_gen', 'video_gen', 'generic',
  'edit', 'shell', 'read', 'search', 'web', 'memory', 'thinking',
]);
export function sceneAsset(scene, { animated = false } = {}) {
  const id = SCENE_ASSET_KEYS.includes(scene) ? scene : 'generic';
  return `${ROOT}scenes/${id}.${animated ? 'gif' : 'png'}?v=${MASCOT_ASSET_VERSION}`;
}
