// ═══════════════════════════════════════════
// SynaBun Neural Interface — 2D Graphics Config
// GFX_DEFAULTS_2D, load/save 2D config
// ═══════════════════════════════════════════

export const GFX_DEFAULTS_2D = {
  chargeStrength: -80,
  linkDistanceBase: 50,
  alphaDecay: 0.025,
  velocityDecay: 0.35,
  linkOpacity: 0.15,
  nodeSizeMultiplier: 1.0,
  labelThreshold: 7,
  hullOpacity: 0.10,
  bgDotGrid: true,
};

const STORAGE_KEY = 'neural-gfx-config-2d';

export function loadGfxConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return { ...GFX_DEFAULTS_2D, ...saved };
  } catch { return { ...GFX_DEFAULTS_2D }; }
}

export function saveGfxConfig(cfg) {
  const diff = {};
  for (const k in cfg) {
    if (cfg[k] !== GFX_DEFAULTS_2D[k]) diff[k] = cfg[k];
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(diff));
}

// Initialize and export the live config object
export const gfx = loadGfxConfig();
