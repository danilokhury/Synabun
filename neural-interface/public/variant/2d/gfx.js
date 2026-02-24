// ═══════════════════════════════════════════
// SynaBun Neural Interface — 2D Graphics Config
// Orbital layout & visual defaults, load/save
// ═══════════════════════════════════════════

export const GFX_DEFAULTS_2D = {
  // Layout
  parentOrbitRadius: 600,     // base radius for parent category ring
  childOrbitGap: 200,         // base radius for child category orbits
  cardGap: 15,                // spacing between cards in orbit rings

  // Visual
  cardOpacity: 0.88,          // card background opacity
  regionGlowOpacity: 0.05,   // category region background glow intensity
  linkOpacity: 0.15,          // link line opacity

  // Background
  bgBreathingEnabled: true,   // breathing animation circle
  bgLogoVisible: true,        // SynaBun logo watermark

  // Minimap
  minimapEnabled: true,
};

import { storage } from '../../shared/storage.js';

const STORAGE_KEY = 'neural-gfx-config-2d';

export function loadGfxConfig() {
  try {
    const saved = JSON.parse(storage.getItem(STORAGE_KEY) || '{}');
    return { ...GFX_DEFAULTS_2D, ...saved };
  } catch { return { ...GFX_DEFAULTS_2D }; }
}

export function saveGfxConfig(cfg) {
  const diff = {};
  for (const k in cfg) {
    if (cfg[k] !== GFX_DEFAULTS_2D[k]) diff[k] = cfg[k];
  }
  storage.setItem(STORAGE_KEY, JSON.stringify(diff));
}

// Initialize and export the live config object
export const gfx = loadGfxConfig();
