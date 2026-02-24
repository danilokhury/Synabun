// ═══════════════════════════════════════════
// SynaBun Neural Interface — 3D Graphics Config
// GFX_DEFAULTS, GFX_PRESETS, load/save 3D config
// ═══════════════════════════════════════════

export const GFX_DEFAULTS = {
  // Links
  linkOpacity: 0.08,
  // Camera
  clickZoom: 120,
  gentleZoom: 180,
  // Background
  bgIntensity: 0.5,
  bgParticleCount: 2000,
  bgTheme: 'deep-grid',
  floorStyle: 'grid',
};

export const GFX_PRESETS = {
  low: {
    label: 'Low', desc: 'Battery saver',
    values: {
      linkOpacity: 0.05, clickZoom: 120, gentleZoom: 180,
      bgIntensity: 0.2, bgParticleCount: 800, bgTheme: 'deep-grid', floorStyle: 'grid',
    },
  },
  medium: {
    label: 'Medium', desc: 'Balanced',
    values: {
      linkOpacity: 0.08, clickZoom: 120, gentleZoom: 180,
      bgIntensity: 0.5, bgParticleCount: 2000, bgTheme: 'deep-grid', floorStyle: 'grid',
    },
  },
  high: {
    label: 'High', desc: 'Rich visuals',
    values: {
      linkOpacity: 0.12, clickZoom: 140, gentleZoom: 200,
      bgIntensity: 0.7, bgParticleCount: 3000, bgTheme: 'deep-grid', floorStyle: 'grid',
    },
  },
  insane: {
    label: 'Insane', desc: 'Max everything',
    values: {
      linkOpacity: 0.2, clickZoom: 160, gentleZoom: 230,
      bgIntensity: 1.0, bgParticleCount: 4000, bgTheme: 'deep-grid', floorStyle: 'grid',
    },
  },
};

import { storage } from '../../shared/storage.js';

const STORAGE_KEY = 'neural-gfx-config';
const PRESET_KEY = 'neural-gfx-preset';

export function loadGfxConfig() {
  try {
    const saved = JSON.parse(storage.getItem(STORAGE_KEY) || '{}');
    return { ...GFX_DEFAULTS, ...saved };
  } catch { return { ...GFX_DEFAULTS }; }
}

export function saveGfxConfig(cfg) {
  const diff = {};
  for (const k in cfg) {
    if (cfg[k] !== GFX_DEFAULTS[k]) diff[k] = cfg[k];
  }
  storage.setItem(STORAGE_KEY, JSON.stringify(diff));
}

export function getActivePreset() {
  return storage.getItem(PRESET_KEY) || null;
}

export function setActivePreset(key) {
  storage.setItem(PRESET_KEY, key);
}

export function applyGfxPreset(presetKey, gfx, graph, applyBgTheme) {
  const preset = GFX_PRESETS[presetKey];
  if (!preset) return;
  Object.assign(gfx, preset.values);
  saveGfxConfig(gfx);
  setActivePreset(presetKey);

  if (graph) {
    const scene = graph.scene();
    scene.traverse(obj => {
      if (!obj.userData || !obj.userData.nodeId) return;
      const r = obj.userData.baseRadius;
      if (!r) return;
      const dot = obj.userData.dot;
      if (dot && dot.material) {
        dot.material.opacity = obj.userData.baseOpacity || 0.1;
      }
    });
  }

  // Update slider UI if settings panel is open
  const panel = document.getElementById('settings-panel');
  if (panel) {
    panel.querySelectorAll('input[type="range"][data-key]').forEach(input => {
      const key = input.dataset.key;
      if (gfx[key] !== undefined) {
        input.value = gfx[key];
        const step = parseFloat(input.step);
        const valSpan = panel.querySelector(`[data-val="${key}"]`);
        if (valSpan) valSpan.textContent = Number(gfx[key]).toFixed(step < 1 ? 2 : 0);
      }
    });
    panel.querySelectorAll('.gfx-preset-card[data-preset]').forEach(c => {
      c.classList.toggle('active', c.dataset.preset === presetKey);
    });
    panel.querySelectorAll('.floor-card').forEach(c => {
      c.classList.toggle('active', c.dataset.floorStyle === gfx.floorStyle);
    });
  }

  if (applyBgTheme) applyBgTheme(gfx.bgTheme || 'deep-grid');
}

// Initialize and export the live config object
export const gfx = loadGfxConfig();
